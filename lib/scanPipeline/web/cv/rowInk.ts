// Row-ink profile for strip tiling (spec Task 12): how many pixels of each row are ink. Runs in the
// OpenCV worker on plain grey (the strip variants don't enhance); takes `cv` as a parameter so Jest
// runs it on the real OpenCV and on a counting fake.
//
// A pixel is ink when it is more than ROW_INK_DARKNESS levels darker than the paper of its row band
// (a block of rows around it). The paper of a band is its median, because a receipt is mostly paper
// even in its densest rows, so the rule follows paper that gets darker or lighter down a long receipt
// (a shadow at one end, a fold) without one global threshold. But a band can be darker than the
// page's paper only by a shadow: a band whose median is darker still is mostly ink (a logo, a black
// bar, a dark table beside an uncropped receipt), and taking that median as "paper" would call the
// whole block blank and let a cut go through it. So the band's paper is never taken below the page's
// median minus ROW_INK_MAX_SHADOW (spec Task 12 says "the median of the row band − 40"; this floor is
// added for that case, found by the synthetic solid-block test). This only measures; the image
// that is read is never thresholded (criterion 43 is about the OCR image: the profile is a count).
import { withMats, type CvApi, type CvMat } from './cvApi';

/**
 * A pixel counts as ink when it is more than this many grey levels darker than its band's median.
 * Why: printed text, even faded thermal print, is at least 30–60 levels darker than its paper, while
 * paper grain and JPEG noise stay within ~10–20 levels. 40 sits between them; a faint row that falls
 * below it can only make that row look blank inside a text block, and a text block's other rows are
 * inked, so the cut search still lands in a real gap between rows.
 * Tuned: not tuned (spec starting value).
 */
export const ROW_INK_DARKNESS = 40;

/**
 * Band height, as a fraction of the image's width (at least ROW_BAND_MIN_PX rows).
 * Why: the band must span several text rows and their gaps, so its median is paper rather than ink;
 * receipt lines are about width / 20 to width / 30 apart (32–48 characters per line), so a quarter of
 * the width holds 5–8 rows. Small enough to follow light changing along a long receipt.
 * Tuned: not tuned (new in Task 12).
 */
export const ROW_BAND_WIDTHS = 0.25;
export const ROW_BAND_MIN_PX = 16;

/**
 * A band's paper is taken as at least the page's median minus this many grey levels.
 * Why: a shadow from a hand or a phone, or a fold, dims paper by roughly 20–60 levels and is followed
 * band by band; a band whose median is darker than that is not shadowed paper but mostly ink (a logo,
 * an inverted header bar, the table), and must count as ink, never as blank.
 * Tuned: not tuned (new in Task 12).
 */
export const ROW_INK_MAX_SHADOW = 60;

/**
 * Columns this close to the left or right edge (as a fraction of the width) are not counted.
 * Why: a crop's quad is rarely exact, so a sliver of the table often runs down one or both sides of
 * the crop, inked on every row; counted, it would leave no blank row and stop tiling (seen on a
 * synthetic 1:6 receipt on a dark table, Task 12). Printing never reaches the paper's edge (thermal
 * receipts have ~3–5 mm margins on 58–80 mm paper) and the warp adds a 2.5% margin, so the outer 5%
 * holds no text a cut could go through.
 * Tuned: not tuned (new in Task 12).
 */
export const ROW_INK_SIDE_MARGIN = 0.05;

/** The median of a 256-bin histogram holding `count` values. */
function histMedian(hist: Uint32Array, count: number): number {
  const half = count / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc >= half) return v;
  }
  return 255;
}

/** The profile from 8-bit grey pixels (row-major, `width × height`), over the inner columns only. Pure. */
export function rowInkFromGray(gray: ArrayLike<number>, width: number, height: number, darkness = ROW_INK_DARKNESS): Uint32Array {
  if (!(width > 0 && height > 0) || gray.length < width * height) throw new RangeError('rowInkFromGray needs width × height grey pixels');
  const band = Math.max(ROW_BAND_MIN_PX, Math.round(width * ROW_BAND_WIDTHS));
  const out = new Uint32Array(height);
  const x0 = Math.floor(width * ROW_INK_SIDE_MARGIN);
  const x1 = width - x0;
  const inner = x1 - x0;
  const page = new Uint32Array(256);
  for (let y = 0; y < height; y++) {
    for (let x = x0; x < x1; x++) {
      const v = (gray[y * width + x] as number) & 255;
      page[v] = (page[v] as number) + 1;
    }
  }
  const paperFloor = histMedian(page, inner * height) - ROW_INK_MAX_SHADOW;
  const hist = new Uint32Array(256);
  for (let y0 = 0; y0 < height; y0 += band) {
    const y1 = Math.min(height, y0 + band);
    hist.fill(0);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = (gray[y * width + x] as number) & 255;
        hist[v] = (hist[v] as number) + 1;
      }
    }
    const paper = Math.max(histMedian(hist, (y1 - y0) * inner), paperFloor);
    const limit = paper - darkness;
    for (let y = y0; y < y1; y++) {
      let n = 0;
      const row = y * width;
      for (let x = x0; x < x1; x++) if ((gray[row + x] as number) < limit) n++;
      out[y] = n;
    }
  }
  return out;
}

/** The profile of a held image (RGBA or grey). Allocates nothing that outlives the call. */
export function rowInkMat(cv: CvApi, src: CvMat): Uint32Array {
  return withMats((keep) => {
    const channels = src.channels();
    let gray: CvMat;
    if (channels === 1) gray = src;
    else if (channels === 4) {
      gray = keep(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    } else throw new RangeError('unsupported channels');
    // Read straight from wasm memory; the result is a plain JS array, so nothing points into it later.
    return rowInkFromGray(gray.data, gray.cols, gray.rows);
  });
}
