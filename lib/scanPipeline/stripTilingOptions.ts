// Strip tiling's per-variant options (spec Task 12), with their reasons. Data only: imported by
// `config.ts`, which is in the web entry bundle; the tiling logic is in `stripTiling.ts` (lazy chunk).
import type { TilingOptions } from './types';

/**
 * Tile only when the image's height is at least this many times its width.
 * Why: the 2048 px cap shrinks by the long edge, so it costs text pixels in proportion to how much
 * longer than wide the image is. An ordinary receipt photo (about 1:1.3 to 1:2) keeps a usable width at
 * the cap; from about 1:2.5 on, the width left at 2048 px tall is ≤ 820 px, where a 40-character
 * receipt line has ≤ 20 px per character. A wide photo is never tiled: rows run across the long edge.
 * Tuned: not tuned (spec starting value; none of the 8 photos qualifies, E8 2026-11-24).
 */
export const STRIP_MIN_ASPECT = 2.5;

/**
 * ...and only when the long edge is more than this multiple of RECOGNITION_MAX_EDGE.
 * Why: below it the cap shrinks the text by at most 20% (1 / 1.25), which Tesseract barely notices
 * (the text-height band itself is ±15%), and tiling would add Tesseract calls for nothing.
 * Tuned: not tuned (spec starting value).
 */
export const STRIP_MIN_OVERSCALE = 1.25;

/**
 * A row is blank when its ink count is at most this fraction of the width.
 * Why: a text row has ink in a good share of its width (even a short "Tax 1.00" line is ~10% of the
 * row's pixels at the x-height), while paper grain, JPEG noise and a stray speck mark a few pixels
 * at most: 0.2% of a 700 px row is 1 pixel. Higher would call the faint top of a row blank and could
 * cut through ascenders; lower would find no blank row on a slightly noisy photo (then: no tiling).
 * Tuned: not tuned (spec starting value).
 */
export const STRIP_BLANK_INK_FRACTION = 0.002;

/**
 * Each cut is searched within ± this fraction of the target strip height.
 * Why: receipts have a blank gap between every pair of lines, so a window a few lines tall always
 * holds one on a normal receipt; ±25% of a ~1500 px strip is hundreds of px (tens of lines), wide
 * enough to step around a logo, a barcode or a block of dense print.
 * Tuned: not tuned (spec starting value).
 */
export const STRIP_CUT_WINDOW_FRACTION = 0.25;

/**
 * Most strips per read.
 * Why: each strip is one more Tesseract page read (about 1 s each on this Mac, more on a phone), so 6
 * keeps a tiled read inside the criterion-62 budget (25 s median). Six strips at ~1500 px cover a
 * ~9000 px tall image at full resolution, more than any crop of a 4096 px decode (CV_MAX_DECODE_EDGE).
 * A plan needing more strips means the profile is odd (noise read as rows): then no tiling.
 * Tuned: not tuned (spec starting value).
 */
export const MAX_STRIPS = 6;

/** The spec's starting values, as the `TilingOptions` a variant carries. */
export const DEFAULT_TILING: TilingOptions = {
  minAspect: STRIP_MIN_ASPECT,
  minOverscale: STRIP_MIN_OVERSCALE,
  blankInkFraction: STRIP_BLANK_INK_FRACTION,
  cutWindowFraction: STRIP_CUT_WINDOW_FRACTION,
  maxStrips: MAX_STRIPS,
};
