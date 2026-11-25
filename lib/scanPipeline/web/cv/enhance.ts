// enhance on web (spec Task 9): grey → illumination flattening → optional gentle CLAHE.
// Takes `cv` as a parameter, so it runs the same in the worker and in Jest.
//
// Rules (spec C3 / "Out of scope"):
// - The output is 8-bit grey with intermediate levels. It is NEVER binarized: Tesseract's LSTM reads
//   grey pixels, and its own thresholding only drives layout. No `cv.threshold` here (criterion 43).
// - Geometry never changes: the output has the input's size, pixel for pixel.
// - The flattening kernel is a multiple of the text's line height, measured from the image's own
//   projection profile, never a fixed pixel size (the same receipt can be 15 or 60 px per line).
//
// Why flatten: a phone photo's paper is lit unevenly (a gradient from a window, a hand's or phone's
// shadow). Dividing by an estimate of the paper's own brightness makes the paper uniformly white and
// keeps each stroke's contrast relative to the paper right under it, so one global threshold inside
// Tesseract no longer cuts through the shadow. The background estimate is a morphological closing:
// it removes every dark feature the kernel can't fit inside (glyphs), and keeps everything larger
// (shadows, gradients).
import type { EnhanceOptions } from '../../types';
import { withMats, type CvApi, type CvMat } from './cvApi';

/** The enhance options when enhance is on. */
export type EnhanceSteps = Exclude<EnhanceOptions, false>;

export type Enhanced = {
  /** 8-bit, 1 channel, the input's size. The caller owns it. */
  mat: CvMat;
  /** Text-row height from the projection profile; null when no text structure was found (or not measured). */
  lineHeightPx: number | null;
  /** The closing kernel at full resolution, or null when flatten didn't run. */
  kernelPx: number | null;
  /** Distinct grey values in the output (criterion 43: > 16 means not binarized). */
  greyLevels: number;
};

/**
 * Starting value for `flatten.kernelLineHeights` (spec Task 9).
 * Why: the closing must be larger than any glyph (bold or tall characters reach ~2 line heights
 * with the run measured below, which covers the x-height-to-cap band) so text never leaks into the
 * background estimate, and small next to lighting features (a shadow or gradient spans many lines),
 * so they are kept and divided out. 4 sits between the two with room on both sides.
 * Tuned: E3, 2026-11-23 (spec Results log): not adopted (1 checked tuning receipt).
 */
export const DEFAULT_KERNEL_LINE_HEIGHTS = 4;

/**
 * The profile is measured in this many vertical strips, and their runs pooled.
 * Why: a hand-held photo is rarely level; over the full width a 2–3° tilt shifts a row by more than
 * the gap between rows and the rows merge in the profile. Over a quarter of the width the shift is a
 * quarter of that. Tuned: not tuned (implementation choice).
 */
export const PROFILE_STRIPS = 4;

/**
 * Percentiles of a strip's row profile taken as "blank row" and "text row" levels.
 * Why: receipts are about a third to a half text rows, so the 10th percentile is a gap between rows
 * and the 95th is inside a row even when text is sparse; percentiles ignore the odd logo or crease.
 * Tuned: not tuned (implementation choice).
 */
export const PROFILE_PERCENTILES: readonly [number, number] = [0.1, 0.95];

/**
 * A row counts as text when its profile is above blank + this fraction of (text − blank).
 * Why: rows differ a lot in how much ink they carry (a bold total vs a short, faint item line), and
 * a midpoint between blank and the busiest rows cuts faint rows into fragments; blank gaps sit at
 * the bottom of the range, so a low fraction keeps every text row whole and still rejects noise.
 * Ascender and descender bands carry far less ink than the x-height band, so a midpoint also
 * shortens every run to the x-height. Tested on synthetic rows with sparse ascender bands.
 * Tuned: not tuned. A diagnostic on 2026-11-23 (no scores involved) showed a midpoint (0.5) giving
 * runs 2–7× shorter than Tesseract's line boxes on real photos; at 0.1 they were 0.45–0.9×.
 */
export const PROFILE_TEXT_LEVEL = 0.1;

/**
 * A strip whose text and blank levels differ by less than this (mean grey-level step per pixel) has
 * no text structure, only paper grain or noise. Why: half a grey level per pixel is below sensor
 * noise on a blank photo yet well under even faded thermal print (ink 30 levels lighter than paper).
 * Tuned: not tuned (implementation choice).
 */
export const MIN_PROFILE_CONTRAST = 0.5;

/**
 * Fewer text rows than this (all strips together) → no line height.
 * Why: as `MIN_BOXED_LINES` in textHeight.ts: a median of 1–2 values is noise.
 * Tuned: not tuned (same value as textHeight.ts).
 */
export const MIN_TEXT_RUNS = 3;

/**
 * The background is estimated on a copy shrunk so a text row is about this many pixels tall.
 * Why: lighting varies over many lines, so the background needs no finer detail than a fraction of
 * a line; shrinking first makes the large closing cheap (it would otherwise cost kernel² per pixel
 * class work on a 2048 px image) while a shadow edge still moves by less than a line.
 * Tuned: not tuned (implementation choice).
 */
export const BACKGROUND_PX_PER_LINE = 4;

const odd = (n: number) => (n % 2 === 0 ? n + 1 : n);

/**
 * Median height of text rows, from the horizontal-gradient projection profile of a grey image
 * (row-major, `width × height`). Rows that cross text have many dark/light steps along x; gaps,
 * plain paper and smooth lighting (gradients, shadows) have few. Pure; reads only.
 */
export function estimateLineHeight(px: ArrayLike<number>, width: number, height: number): number | null {
  if (width < 2 * PROFILE_STRIPS || height < 3) return null;
  const runs: number[] = [];
  const prof = new Float64Array(height);
  for (let s = 0; s < PROFILE_STRIPS; s++) {
    const x0 = Math.floor((s * width) / PROFILE_STRIPS);
    const x1 = Math.floor(((s + 1) * width) / PROFILE_STRIPS);
    const n = x1 - x0 - 1;
    if (n < 1) continue;
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const row = y * width;
      for (let x = x0; x < x1 - 1; x++) sum += Math.abs((px[row + x + 1] ?? 0) - (px[row + x] ?? 0));
      prof[y] = sum / n;
    }
    const sorted = Array.from(prof).sort((a, b) => a - b);
    const lo = sorted[Math.floor(PROFILE_PERCENTILES[0] * (height - 1))] ?? 0;
    const hi = sorted[Math.floor(PROFILE_PERCENTILES[1] * (height - 1))] ?? 0;
    if (hi - lo < MIN_PROFILE_CONTRAST) continue;
    const thr = lo + PROFILE_TEXT_LEVEL * (hi - lo);
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const on = y < height && (prof[y] ?? 0) > thr;
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        // A one-row blip is a speck or a crease, not a text row.
        if (y - start >= 2) runs.push(y - start);
        start = -1;
      }
    }
  }
  if (runs.length < MIN_TEXT_RUNS) return null;
  runs.sort((a, b) => a - b);
  const mid = runs.length >> 1;
  return runs.length % 2 ? runs[mid]! : (runs[mid - 1]! + runs[mid]!) / 2;
}

/**
 * grey ÷ background × 255 (saturating), where background = closing of grey with a square kernel of
 * `kernelLineHeights × lineHeightPx` (odd), smoothed and computed on a shrunk copy. Returns a new
 * 8-bit grey Mat (the caller owns it) of the input's size. Frees everything else on any path.
 */
export function flattenBackground(
  cv: CvApi,
  gray: CvMat,
  lineHeightPx: number,
  kernelLineHeights: number,
): { mat: CvMat; kernelPx: number } {
  if (gray.channels() !== 1) throw new RangeError('flatten needs a grey image');
  if (!(lineHeightPx > 0) || !(kernelLineHeights > 0)) throw new RangeError('flatten needs a positive line height and kernel');
  const w = gray.cols;
  const h = gray.rows;
  const kernelPx = odd(Math.max(3, Math.round(kernelLineHeights * lineHeightPx)));
  const f = Math.max(1, Math.floor(lineHeightPx / BACKGROUND_PX_PER_LINE));
  const sw = Math.max(1, Math.round(w / f));
  const sh = Math.max(1, Math.round(h / f));
  const ks = odd(Math.max(3, Math.round(kernelPx / f)));
  const mat = withMats((keep, release) => {
    let small = gray;
    if (f > 1) {
      small = keep(new cv.Mat());
      cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
    }
    const se = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ks, ks)));
    const closed = keep(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, se);
    // The closing is blocky (flat plateaus); a box blur of the same size makes it a smooth surface.
    const smooth = keep(new cv.Mat());
    cv.blur(closed, smooth, new cv.Size(ks, ks));
    let bg = smooth;
    if (f > 1) {
      bg = keep(new cv.Mat());
      cv.resize(smooth, bg, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
    }
    const out = keep(new cv.Mat());
    cv.divide(gray, bg, out, 255, -1);
    release(out);
    return out;
  });
  return { mat, kernelPx };
}

/** Distinct values in an 8-bit single-channel Mat. */
export function greyLevels(mat: CvMat): number {
  const seen = new Uint8Array(256);
  let n = 0;
  const d = mat.data;
  for (let i = 0; i < d.length; i++) {
    const v = d[i]!;
    if (!seen[v]) {
      seen[v] = 1;
      n += 1;
    }
  }
  return n;
}

/**
 * The enhance stage on one image (RGBA or grey). Flatten and CLAHE work on luma, so any step turns
 * the image grey. A new Mat (the caller owns it); nothing else outlives the call, on any path.
 */
export function enhanceMat(cv: CvApi, src: CvMat, steps: EnhanceSteps): Enhanced {
  let lineHeightPx: number | null = null;
  let kernelPx: number | null = null;
  const mat = withMats((keep, release) => {
    let cur: CvMat;
    if (src.channels() === 4) {
      cur = keep(new cv.Mat());
      cv.cvtColor(src, cur, cv.COLOR_RGBA2GRAY);
    } else if (src.channels() === 1) cur = keep(src.clone());
    else throw new RangeError('unsupported channels');
    if (steps.flatten) {
      lineHeightPx = estimateLineHeight(cur.data, cur.cols, cur.rows);
      if (lineHeightPx !== null) {
        const flat = flattenBackground(cv, cur, lineHeightPx, steps.flatten.kernelLineHeights);
        keep(flat.mat);
        kernelPx = flat.kernelPx;
        cur = flat.mat;
      }
    }
    if (steps.clahe) {
      const clahe = keep(new cv.CLAHE(steps.clahe.clipLimit, new cv.Size(steps.clahe.tile, steps.clahe.tile)));
      const out = keep(new cv.Mat());
      clahe.apply(cur, out);
      cur = out;
    }
    release(cur);
    return cur;
  });
  return { mat, lineHeightPx, kernelPx, greyLevels: greyLevels(mat) };
}
