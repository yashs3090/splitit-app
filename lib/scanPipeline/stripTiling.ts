// Strip tiling for tall receipts (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 12).
// Pure; RN-free. The platform part (the row-ink profile in the OpenCV worker, cutting each strip with
// today's canvas resize, reading it on the scan's one Tesseract session) is in `web/stages.ts`.
//
// Why: a long receipt (1:4, 1:6) is shrunk as a whole until its long edge fits RECOGNITION_MAX_EDGE
// (2048 px), and its width, and with it every glyph, shrinks by the same factor: a 700 × 4000 crop is
// read at 358 × 2048, so its text loses half its pixels. Reading it as a few horizontal strips, each
// at the crop's own resolution, keeps the text at the size the camera captured. It adds no pixel
// information (spec Risks); it only avoids throwing pixels away.
//
// Rules:
// - Cuts land only on blank rows (rows with almost no ink in the row-ink profile), at the centre of the
//   longest blank run in each window. If any window has no blank row, there is no tiling at all: a cut
//   through text is never allowed.
// - Each strip reaches one text line into its neighbour on each side (the overlap), and that edge is
//   also on a blank row, so no strip edge cuts a line either.
// - Merging maps every box back to the untiled image's pixels and drops the second copy of a line read
//   twice in an overlap (same text, about the same height), keeping the more confident copy.
import { nameSimilarity } from '../receiptEval';
import type { Size } from '../imageSize';
import type { RecognizedLine } from '../receiptTypes';
import type { TilingOptions } from './types';

// The trigger and cut constants (STRIP_MIN_ASPECT, STRIP_MIN_OVERSCALE, STRIP_BLANK_INK_FRACTION,
// STRIP_CUT_WINDOW_FRACTION, MAX_STRIPS) live in `stripTilingOptions.ts`, so `config.ts` (in the entry
// bundle) can carry them without pulling in this module and the eval's name similarity.
export * from './stripTilingOptions';

// ---------- constants (criterion 71) ----------

/**
 * The overlap reaches one line into the neighbouring strip; if that line's ink run is taller than
 * this many line pitches, there is no overlap on that side.
 * Why: a run that tall isn't a text line (a logo, a barcode, a photo of the table): reading it twice
 * adds nothing to dedupe, and stopping inside it would end the strip in the middle of it.
 * Tuned: not tuned (new in Task 12).
 */
export const OVERLAP_MAX_PITCHES = 2;

/**
 * Two lines from neighbouring strips are one line read twice when their texts are at least this
 * similar (C1's `nameSimilarity`: 1 − Levenshtein / max length, over lowercased alphanumerics)...
 * Why: the same pixels read in two strips differ only where the strip edge changed Tesseract's
 * context: a character or two on a 20–40 character line, so ≥ 0.8. Two different item lines that
 * similar would differ in about one character in five, and then the height check below still tells
 * them apart.
 * Tuned: not tuned (spec starting value).
 */
export const STRIP_DEDUPE_SIMILARITY = 0.8;

/**
 * ...and their box centres are within this many line pitches of each other (in the untiled image).
 * Why: the same line maps back to the same height to within its box jitter (a few px); the next line
 * is a whole pitch away, so half a pitch separates "the same line" from "a neighbour" with room on
 * both sides, and equal text far apart (two "Soda 2.00" lines) is kept twice.
 * Tuned: not tuned (spec starting value).
 */
export const STRIP_DEDUPE_PITCHES = 0.5;

/**
 * A plan's strips must be at least this many line pitches tall.
 * Why: a strip of a few lines gives Tesseract's page layout (PSM 6) almost nothing to find columns and
 * line spacing from, and the overlaps would be most of the strip; the cap would have to be tiny (a
 * very wide image) for this to happen, and then the whole-image read is the safer choice.
 * Tuned: not tuned (new in Task 12).
 */
export const MIN_STRIP_PITCHES = 6;

/** At least this many ink runs (text rows) before a line pitch is estimated. Why: a median of fewer than 2 gaps is one gap. */
export const MIN_PITCH_ROWS = 3;

// ---------- trigger and scale ----------

/**
 * Whether an image of `size` should be read in strips: height / width ≥ `minAspect` and the long edge
 * (the height, then) > `minOverscale` × `maxEdge`. Wide and normal-aspect images never are.
 */
export function shouldTile(size: Size, opts: Pick<TilingOptions, 'minAspect' | 'minOverscale'>, maxEdge: number): boolean {
  const { width, height } = size;
  if (![width, height, maxEdge].every((v) => Number.isFinite(v) && v > 0)) return false;
  return height / width >= opts.minAspect && height > opts.minOverscale * maxEdge;
}

/** Strips are read at the image's own resolution; only an image wider than `maxEdge` is scaled down to fit. */
export function stripScale(width: number, maxEdge: number): number {
  return width > maxEdge ? maxEdge / width : 1;
}

// ---------- profile analysis ----------

/** Rows `[start, end)` where the profile is blank (`blank: true`) or inked, in order, covering the whole profile. */
type Run = { start: number; end: number; blank: boolean };

function runs(rowInk: ArrayLike<number>, limit: number): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < rowInk.length; y++) {
    const blank = (rowInk[y] ?? 0) <= limit;
    const last = out[out.length - 1];
    if (last && last.blank === blank) last.end = y + 1;
    else out.push({ start: y, end: y + 1, blank });
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The ink count at or below which a row of `width` pixels is blank. */
export function blankLimit(width: number, blankInkFraction: number): number {
  return blankInkFraction * width;
}

/**
 * The median distance between the tops of consecutive text rows (ink runs), in profile rows.
 * Null with fewer than MIN_PITCH_ROWS rows: no text structure to tile by.
 */
export function estimateLinePitch(rowInk: ArrayLike<number>, width: number, blankInkFraction: number): number | null {
  const starts = runs(rowInk, blankLimit(width, blankInkFraction))
    .filter((r) => !r.blank)
    .map((r) => r.start);
  if (starts.length < MIN_PITCH_ROWS) return null;
  const gaps = starts.slice(1).map((s, i) => s - (starts[i] as number));
  return median(gaps);
}

export type CutOptions = Pick<TilingOptions, 'blankInkFraction' | 'cutWindowFraction' | 'maxStrips'> & {
  /** The strip height to aim for, in profile rows. */
  targetStripPx: number;
};

/**
 * Where to cut a profile into strips: rows at the centre of the longest blank run inside each window
 * `[previous cut + target × (1 − window), previous cut + target × (1 + window)]`.
 * - `[]`: the profile fits in one strip (no cuts needed).
 * - `null`: some window has no blank row (a cut would go through text), or more than `maxStrips`
 *   strips would be needed. Either way: don't tile.
 * Every returned cut is on a row whose ink is ≤ `blankInkFraction` × width.
 */
export function findCuts(rowInk: ArrayLike<number>, width: number, opts: CutOptions): number[] | null {
  const { targetStripPx: target, cutWindowFraction: w, maxStrips } = opts;
  if (!(target > 0) || !(w >= 0 && w < 1) || !(maxStrips >= 1)) throw new RangeError('findCuts needs a positive target, a window in [0, 1) and maxStrips ≥ 1');
  const height = rowInk.length;
  const limit = blankLimit(width, opts.blankInkFraction);
  const blankRuns = runs(rowInk, limit).filter((r) => r.blank);
  const cuts: number[] = [];
  let pos = 0;
  while (height - pos > target * (1 + w)) {
    if (cuts.length + 1 >= maxStrips) return null; // one more cut would make more than maxStrips strips
    const lo = Math.ceil(pos + target * (1 - w));
    const hi = Math.floor(pos + target * (1 + w)); // inclusive
    let best: { start: number; end: number } | null = null;
    for (const r of blankRuns) {
      const start = Math.max(r.start, lo);
      const end = Math.min(r.end, hi + 1);
      if (end <= start) continue;
      // Longest first; on a tie the one nearest the target keeps strips even.
      const better =
        !best ||
        end - start > best.end - best.start ||
        (end - start === best.end - best.start && Math.abs((start + end) / 2 - (pos + target)) < Math.abs((best.start + best.end) / 2 - (pos + target)));
      if (better) best = { start, end };
    }
    if (!best) return null;
    const cut = Math.floor((best.start + best.end - 1) / 2); // a row inside the run
    cuts.push(cut);
    pos = cut;
  }
  return cuts;
}

/** A strip `[top, bottom)` in profile rows. */
export type StripSpan = { top: number; bottom: number };

export type StripPlan = {
  strips: StripSpan[];
  /** The cuts the strips meet at (one fewer than strips). */
  cuts: number[];
  /** Median text-row pitch, in profile rows (for the overlap and the dedupe distance). */
  pitch: number;
};

/**
 * Cuts a profile into strips that each reach one text line past the cut on both sides, both edges
 * on blank rows. Null when the profile shouldn't be tiled (see `findCuts`, plus: no measurable text
 * rows, or strips shorter than MIN_STRIP_PITCHES pitches). `maxStripPx` is the tallest a strip may
 * be, overlaps included, in profile rows.
 */
export function planStrips(rowInk: ArrayLike<number>, width: number, opts: Omit<CutOptions, 'targetStripPx'> & { maxStripPx: number }): StripPlan | null {
  const height = rowInk.length;
  const pitch = estimateLinePitch(rowInk, width, opts.blankInkFraction);
  if (pitch === null || !(pitch > 0)) return null;
  // Room for the overlap (about one pitch, at most OVERLAP_MAX_PITCHES) on both sides, then the window.
  const target = Math.floor((opts.maxStripPx - 2 * OVERLAP_MAX_PITCHES * pitch) / (1 + opts.cutWindowFraction));
  if (target < MIN_STRIP_PITCHES * pitch) return null;
  const cuts = findCuts(rowInk, width, { ...opts, targetStripPx: target });
  if (cuts === null || cuts.length === 0) return null;
  const all = runs(rowInk, blankLimit(width, opts.blankInkFraction));
  const runAt = (y: number) => all.findIndex((r) => r.start <= y && y < r.end);
  const maxRun = OVERLAP_MAX_PITCHES * pitch;

  /**
   * From a cut on a blank row: past the next text row below, into the gap after it (its middle, or
   * half a pitch in, whichever is nearer). No overlap when that row is far from the cut or isn't a
   * text row (taller than OVERLAP_MAX_PITCHES pitches).
   */
  const extendDown = (cut: number): number => {
    const i = runAt(cut);
    const line = all[i + 1];
    const gap = all[i + 2];
    if (!line || line.blank || line.end - line.start > maxRun || line.start - cut > maxRun) return cut + 1;
    if (!gap) return height;
    return Math.min(Math.floor((gap.start + gap.end - 1) / 2), gap.start + Math.floor(pitch / 2)) + 1;
  };
  /** The same upwards: past the text row above the cut, into the gap before it. */
  const extendUp = (cut: number): number => {
    const i = runAt(cut);
    const line = all[i - 1];
    const gap = all[i - 2];
    if (!line || line.blank || line.end - line.start > maxRun || cut - line.end > maxRun) return cut;
    if (!gap) return 0;
    return Math.max(Math.floor((gap.start + gap.end - 1) / 2), gap.end - 1 - Math.floor(pitch / 2));
  };

  const strips: StripSpan[] = [];
  for (let k = 0; k <= cuts.length; k++) {
    const top = k === 0 ? 0 : extendUp(cuts[k - 1] as number);
    const bottom = k === cuts.length ? height : extendDown(cuts[k] as number);
    strips.push({ top, bottom });
  }
  return { strips, cuts, pitch };
}

// ---------- merge ----------

/** One strip's read: where its image sat in the untiled image, how it was scaled, and its lines (strip-image pixels). */
export type StripRead = {
  /** The strip's top-left in untiled-image pixels. */
  left: number;
  top: number;
  /** Strip-image pixels per untiled-image pixel. */
  scaleX: number;
  scaleY: number;
  lines: RecognizedLine[];
};

/** The strip's lines with boxes mapped back to the untiled image's pixels. */
function toUntiled(s: StripRead): RecognizedLine[] {
  return s.lines.map((l) => {
    if (!l.box) return { ...l };
    const box = { x: l.box.x / s.scaleX + s.left, y: l.box.y / s.scaleY + s.top, width: l.box.width / s.scaleX, height: l.box.height / s.scaleY };
    return { ...l, box };
  });
}

const centreY = (l: RecognizedLine): number | null => (l.box ? l.box.y + l.box.height / 2 : null);

/**
 * Merges strip reads (in top-to-bottom strip order) into one read of the untiled image.
 * - Boxes come back in the untiled image's pixels.
 * - A line of strip k+1 whose centre lies in the overlap with strip k (`[top of k+1, bottom of k]`)
 *   and that matches a line of strip k (similarity ≥ STRIP_DEDUPE_SIMILARITY, centres within
 *   STRIP_DEDUPE_PITCHES × `pitch`) is one line read twice: only the more confident copy is kept (on
 *   a tie, or with no confidences, strip k's).
 * - Lines are ordered top to bottom (by box centre; a line with no box stays after its strip's
 *   previous line).
 * `stripBottoms[k]` is strip k's bottom edge in untiled-image pixels; `pitch` is in the same pixels.
 */
export function mergeStripLines(strips: readonly StripRead[], stripBottoms: readonly number[], pitch: number): RecognizedLine[] {
  type Placed = { line: RecognizedLine; y: number; strip: number; seq: number };
  let seq = 0;
  const kept: Placed[] = [];
  const maxDy = STRIP_DEDUPE_PITCHES * pitch;
  strips.forEach((s, k) => {
    let lastY = s.top;
    for (const line of toUntiled(s)) {
      const c = centreY(line);
      const y = c ?? lastY;
      lastY = y;
      const placed: Placed = { line, y, strip: k, seq: seq++ };
      const prevBottom = k > 0 ? stripBottoms[k - 1] : undefined;
      if (c !== null && prevBottom !== undefined && c >= s.top && c <= prevBottom) {
        const twin = kept.find(
          (p) =>
            p.strip === k - 1 &&
            p.line.box !== undefined &&
            Math.abs(p.y - c) <= maxDy &&
            nameSimilarity(p.line.text, line.text) >= STRIP_DEDUPE_SIMILARITY,
        );
        if (twin) {
          if ((line.confidence ?? -Infinity) > (twin.line.confidence ?? -Infinity)) twin.line = line;
          continue;
        }
      }
      kept.push(placed);
    }
  });
  return kept.sort((a, b) => a.y - b.y || a.seq - b.seq).map((p) => p.line);
}
