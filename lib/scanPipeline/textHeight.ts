// Text height: the median line height of a read, and the rescale it asks for
// (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 8). Pure, shared by every platform.
//
// Why a second pass at all: Tesseract's error tracks how many pixels tall the glyphs are, not how big
// the image is (report § "Character height"). The first pass sizes the image by its edge length,
// which can't see the text: a sharp 866×1390 receipt with ~35 px lines read best as-is and got worse
// when upscaled to 1600–2048 px, while a 263×450 thumbnail needed upscaling. The first read measures
// the text height; when it's outside the target band, the crop is resized once more to bring it in.
import type { RecognizedText } from '../receiptTypes';
import type { Size } from '../imageSize';

/**
 * Why: a median needs a few values before one odd box (a logo, two lines merged into one box) stops
 * deciding it; with 1–2 lines the "text height" is mostly noise and the read is junk anyway.
 * Tuned: not tuned (spec value).
 */
export const MIN_BOXED_LINES = 3;

/**
 * The factor range of a second pass.
 * Why: below 0.5× the text of a big first pass would lose half its pixels in one step (glyph strokes
 * start merging), and above 3× a small one is mostly interpolation (no new detail, ~9× the pixels to
 * read). Outside that range the first-pass median itself is more likely a misread (a box spanning
 * several lines, specks read as text) than a real size, so the pass goes only part of the way.
 * Tuned: not tuned (spec value).
 */
export const MIN_RESCALE = 0.5;
export const MAX_RESCALE = 3;

/**
 * The text-height band, relative to the target: inside it there is no second pass.
 * Why: ±15% is about the spread of line-box heights on one receipt (descenders, bold totals, small
 * print), so a median inside it is as close to the target as one resize can reliably get; a resize
 * that small also costs a whole extra read for a change Tesseract barely sees.
 * Tuned: not tuned (spec starting value; E2 on 2026-11-23 varied only the target, see config.ts).
 */
export const TEXT_HEIGHT_BAND: [number, number] = [0.85, 1.15];

export type TextHeightOptions = {
  /** The line-box height (px) to aim for. Line boxes include ascenders and descenders. */
  targetLineHeightPx: number;
  /** `[low, high]` multiples of the target: a median in `[target × low, target × high]` is in band. */
  band: [number, number];
};

/**
 * The median `box.height` over lines that have a usable box (finite, > 0), in pixels of the image
 * that was read. Null with fewer than `MIN_BOXED_LINES` such lines.
 */
export function medianLineHeight(text: RecognizedText): number | null {
  const heights = text.lines
    .flatMap((l) => (l.box && Number.isFinite(l.box.height) && l.box.height > 0 ? [l.box.height] : []))
    .sort((a, b) => a - b);
  if (heights.length < MIN_BOXED_LINES) return null;
  const mid = Math.floor(heights.length / 2);
  const upper = heights[mid] as number;
  return heights.length % 2 === 1 ? upper : ((heights[mid - 1] as number) + upper) / 2;
}

/** Floating-point slack for the band edges (a ratio, far below any real pixel difference). */
const EDGE_EPSILON = 1e-9;

function checkOptions({ targetLineHeightPx, band }: TextHeightOptions): void {
  const [low, high] = band;
  const ok = [targetLineHeightPx, low, high].every((v) => Number.isFinite(v) && v > 0) && low <= 1 && high >= 1;
  if (!ok) throw new RangeError('textHeightRescale needs a positive target and a band around 1');
}

/**
 * The factor a second pass should resize by: `target / median`, clamped to [MIN_RESCALE, MAX_RESCALE].
 * Null when no second pass is wanted: the median is in band (edges included), or it is null, ≤ 0 or
 * not finite (nothing measured). Throws RangeError for a bad config.
 */
export function rescaleFactor(median: number | null, opts: TextHeightOptions): number | null {
  checkOptions(opts);
  if (median === null || !Number.isFinite(median) || median <= 0) return null;
  const { targetLineHeightPx: target, band } = opts;
  // Compared as a ratio with a tiny tolerance, so a median exactly at an edge counts as in band
  // whatever floating-point rounding `target × edge` would do.
  const ratio = median / target;
  if (ratio >= band[0] - EDGE_EPSILON && ratio <= band[1] + EDGE_EPSILON) return null;
  return Math.min(MAX_RESCALE, Math.max(MIN_RESCALE, target / median));
}

/**
 * The second pass's image size: the first-pass size × `factor`, aspect kept, long edge capped at
 * `maxEdge` (RECOGNITION_MAX_EDGE). Null when that rounds to the first-pass size again (for example
 * the first pass was already at the cap), so no identical read is repeated.
 */
export function secondPassSize(first: Size, factor: number, maxEdge: number): Size | null {
  if (![first.width, first.height, factor, maxEdge].every((v) => Number.isFinite(v) && v > 0)) {
    throw new RangeError('secondPassSize needs positive, finite numbers');
  }
  let w = first.width * factor;
  let h = first.height * factor;
  const long = Math.max(w, h);
  if (long > maxEdge) {
    w = (w * maxEdge) / long;
    h = (h * maxEdge) / long;
  }
  const size = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  return size.width === Math.round(first.width) && size.height === Math.round(first.height) ? null : size;
}
