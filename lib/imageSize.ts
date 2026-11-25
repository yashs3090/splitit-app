// Size math shared by the native and web image preparation (spec: Task 2, split in A3/Task 9). Pure.

/** Long-edge cap for the image we recognize. Tune from the D3/D4 device results. */
export const RECOGNITION_MAX_EDGE = 2048;
export const RECOGNITION_JPEG_COMPRESS = 0.9;

export type Size = { width: number; height: number };
export type PreparedImage = { uri: string } & Size;
/** A rectangle in image pixels, top-left origin (the same shape as `Box` in receiptTypes.ts). */
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Upscaling for low-resolution photos (screenshots, downloaded thumbnails). Below `belowEdge` on the
 * long edge, text is too few pixels tall for the recognizer; scaling up to `toEdge` first fixed it.
 * Measured with the web pipeline (expo-image-manipulator's canvas resize + Tesseract) on three real
 * receipts, 2026-11-22: a 263×450 receipt read 0 of 9 items as-is and 9 of 9 at 1200, 1600, 1700,
 * 1800, 2000 and 2048 (1350 and 1500 each misread one figure). A sharp 866×1390 receipt read best
 * as-is and got worse at 1600–2048, so `belowEdge` stays well under 1390. Applied on native too;
 * Apple Vision with this setting is not yet checked on a device.
 */
export const RECOGNITION_UPSCALE: Upscale = { belowEdge: 1000, toEdge: 1600 };

/** When the long edge is below `belowEdge`, scale it up to `toEdge` (capped at the max edge). */
export type Upscale = { belowEdge: number; toEdge: number };

function assertPositive(values: readonly number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) throw new RangeError('targetSize needs positive, finite numbers');
  }
}

/** Scales so the long edge is exactly `edge` (an integer), keeping the aspect ratio. */
function scaleLongEdgeTo(width: number, height: number, edge: number): Size {
  const long = Math.max(width, height);
  const scaleShort = (short: number) => Math.max(1, Math.round((short * edge) / long));
  return width >= height ? { width: edge, height: scaleShort(height) } : { width: scaleShort(width), height: edge };
}

/**
 * Size for `width × height`, keeping the aspect ratio. Always returns positive integers.
 * - Long edge above `maxEdge`: scaled down to `maxEdge`.
 * - With `upscale` and a long edge below `upscale.belowEdge`: scaled up to
 *   `min(upscale.toEdge, maxEdge)` (never down: a target at or below the current size is ignored).
 * - Otherwise: the size, rounded. Without `upscale` it never upscales.
 * Throws RangeError for non-positive or non-finite input.
 */
export function targetSize(width: number, height: number, maxEdge: number, upscale?: Upscale): Size {
  assertPositive([width, height, maxEdge]);
  if (upscale) assertPositive([upscale.belowEdge, upscale.toEdge]);
  const long = Math.max(width, height);
  if (long > maxEdge) return scaleLongEdgeTo(width, height, Math.floor(maxEdge));
  if (upscale && long < upscale.belowEdge) {
    const edge = Math.floor(Math.min(upscale.toEdge, maxEdge));
    if (edge > long) return scaleLongEdgeTo(width, height, edge);
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** `rect` cut to the image and rounded outwards to whole pixels; null when nothing is left. */
export function clampRect(rect: Rect, size: Size): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(size.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(size.height, Math.ceil(rect.y + rect.height));
  if (!(x1 > x0 && y1 > y0) || !(rect.width > 0 && rect.height > 0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The crop's size after scaling by `scale`, long edge capped at `maxEdge`; positive integers. */
export function scaledCropSize(crop: Size, scale: number, maxEdge: number = RECOGNITION_MAX_EDGE): Size {
  let w = crop.width * scale;
  let h = crop.height * scale;
  const long = Math.max(w, h);
  if (long > maxEdge) {
    w = (w * maxEdge) / long;
    h = (h * maxEdge) / long;
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}
