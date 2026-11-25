// Web: prepares a picked photo for in-browser recognition, and frees the temporary blob: URLs.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md, A3 / Task 9.
//
// expo-image-manipulator draws the photo on a canvas and re-encodes it as JPEG. Browsers apply the
// EXIF orientation when drawing, and a canvas re-encode carries no EXIF (so no location) forward.
// Nothing is uploaded: the result is a blob: URL that only this tab can read.
// This file must never import the native file-system package (criterion 55 greps for it).
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

import {
  clampRect,
  RECOGNITION_JPEG_COMPRESS,
  RECOGNITION_MAX_EDGE,
  RECOGNITION_UPSCALE,
  scaledCropSize,
  targetSize,
  type PreparedImage,
  type Rect,
  type Size,
} from './imageSize';
import { RecognitionError } from './recognitionError';

export {
  RECOGNITION_JPEG_COMPRESS,
  RECOGNITION_MAX_EDGE,
  RECOGNITION_UPSCALE,
  targetSize,
  type PreparedImage,
  type Size,
  type Upscale,
} from './imageSize';

function revoke(uri: unknown): void {
  if (typeof uri !== 'string' || !uri.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(uri);
  } catch {
    // Best effort.
  }
}

// On web each rendered ImageRef holds a full-size PNG blob: URL that nobody else frees.
function release(ref: ImageRef | null): void {
  if (!ref) return;
  revoke((ref as { uri?: unknown }).uri);
  try {
    ref.release();
  } catch {
    // Best effort.
  }
}

/** The decoded size of an image URL (EXIF orientation applied, as the canvas will draw it). */
export function naturalSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('decode'));
    img.src = uri;
  });
}

/** What to render from the decoded image: an optional crop (decoded pixels), then the output size. */
type RenderPlan = { crop?: Rect; size: Size };

/**
 * Decodes `uri`, crops it if the plan says so, resizes it to the plan's size if that differs, and
 * saves a JPEG. One render. `planFor` may throw (an impossible crop): that is `image_load_failed`.
 */
async function renderJpeg(uri: string, planFor: (decoded: Size) => RenderPlan): Promise<PreparedImage> {
  let rendered: ImageRef | null = null;
  try {
    const decoded = await naturalSize(uri);
    const { crop, size } = planFor(decoded);
    const from = crop ?? decoded;
    let ctx = ImageManipulator.manipulate(uri);
    if (crop) ctx = ctx.crop({ originX: crop.x, originY: crop.y, width: crop.width, height: crop.height });
    rendered = await (size.width !== from.width || size.height !== from.height ? ctx.resize(size) : ctx).renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: RECOGNITION_JPEG_COMPRESS });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } catch {
    throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  } finally {
    release(rendered);
  }
}

/**
 * Same sizing as native: long edge ≤ RECOGNITION_MAX_EDGE, a low-resolution photo scaled up to
 * RECOGNITION_UPSCALE.toEdge (at most ~1600×1600 px, a few MB of canvas), saved as JPEG.
 * Unlike native, it measures first and renders once: on web, rendering the full-size photo would
 * encode a multi-megapixel PNG just to read its size.
 */
export async function prepareForRecognition(uri: string): Promise<PreparedImage> {
  return renderJpeg(uri, (d) => ({ size: targetSize(d.width, d.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE) }));
}

/**
 * Web only: as `prepareForRecognition` (same canvas resize, same JPEG encode), but to exactly `size`,
 * for the scan pipeline's text-height second pass (lib/scanPipeline/textHeight.ts), which picks the
 * size from the first read and caps it at RECOGNITION_MAX_EDGE itself. `size` must be positive integers.
 */
export async function prepareAtSize(uri: string, size: Size): Promise<PreparedImage> {
  if (![size.width, size.height].every((v) => Number.isInteger(v) && v > 0)) {
    throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  }
  return renderJpeg(uri, () => ({ size }));
}

/**
 * Web only: zoom on doubt (lib/scanPipeline/zoomOnDoubt.ts). The same canvas path and JPEG encode as
 * `prepareAtSize`, but first cropped to `rect` (pixels of `uri`, clamped to the image and rounded
 * outwards), then scaled by `scale`, long edge capped at RECOGNITION_MAX_EDGE. Crop and resize happen
 * in one render. A rect outside the image or a bad scale → `image_load_failed`.
 */
export async function prepareCropAtScale(uri: string, rect: Rect, scale: number): Promise<PreparedImage> {
  if (!(Number.isFinite(scale) && scale > 0)) throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  return renderJpeg(uri, (d) => {
    const crop = clampRect(rect, d);
    if (!crop) throw new Error('crop');
    return { crop, size: scaledCropSize(crop, scale, RECOGNITION_MAX_EDGE) };
  });
}

/** Revokes `blob:` URLs (the picked photo and the resized copy); ignores everything else. Never throws. */
export async function deleteTempImages(uris: readonly (string | null | undefined)[]): Promise<void> {
  for (const uri of new Set(uris)) revoke(uri);
}
