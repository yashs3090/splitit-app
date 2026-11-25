// Browser side of the OCR harness: today's web `prepareForRecognition`, rebuilt from
// expo-image-manipulator's own web source (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 4).
//
// `lib/prepareImage.web.ts` can't be bundled as-is: it imports the package's index, which needs
// `expo` / React Native's module registry. The app's call chain on web is:
//   naturalSize(uri)                                   (Image decode, EXIF orientation applied)
//   targetSize(w, h, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE)
//   ImageManipulator.manipulate(uri)    -> loadImageAsync(uri)               (src/web/utils.web.ts)
//     .resize(size)  (only if the size changes) -> ResizeAction (Hermite)   (src/web/actions/ResizeAction.web.ts)
//     .renderAsync()  -> copies the canvas with drawImage (plus a full-size PNG blob URL nobody reads)
//   ref.saveAsync({ format: JPEG, compress: RECOGNITION_JPEG_COMPRESS }) -> canvas.toBlob('image/jpeg', q)
// This file calls the same two library functions, imported from the installed package's source, and
// repeats the two small steps around them (the canvas copy and the JPEG `toBlob`). The unread PNG
// blob from `renderAsync` is skipped: it doesn't change the pixels, only the time.
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
} from '../../lib/imageSize';
import { RecognitionError } from '../../lib/recognitionError';
import crop from 'expo-image-manipulator/src/web/actions/CropAction.web';
import resize from 'expo-image-manipulator/src/web/actions/ResizeAction.web';
import { loadImageAsync } from 'expo-image-manipulator/src/web/utils.web';

/** Same as `naturalSize` in lib/prepareImage.web.ts. */
export function naturalSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('decode'));
    img.src = uri;
  });
}

/** What `renderAsync` does to the canvas before `saveAsync` encodes it. */
function copyCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  return copy;
}

/** What `ImageManipulatorImageRef.saveAsync` does for `{ format: JPEG, compress }`. */
function saveJpeg(canvas: HTMLCanvasElement, compress: number): Promise<PreparedImage> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== 'image/jpeg') return reject(new Error('encode'));
        resolve({ uri: URL.createObjectURL(blob), width: canvas.width, height: canvas.height });
      },
      'image/jpeg',
      compress,
    );
  });
}

/** As in lib/prepareImage.web.ts: an optional crop (decoded pixels), then the output size. */
type RenderPlan = { crop?: Rect; size: Size };

async function renderJpeg(uri: string, planFor: (decoded: Size) => RenderPlan): Promise<PreparedImage> {
  try {
    const decoded = await naturalSize(uri);
    const plan = planFor(decoded);
    const { size } = plan;
    let canvas = await loadImageAsync(uri);
    // The manipulator runs its tasks in order: `.crop(rect)` (CropAction), then `.resize(size)`.
    if (plan.crop) canvas = crop(canvas, { originX: plan.crop.x, originY: plan.crop.y, width: plan.crop.width, height: plan.crop.height });
    const from = plan.crop ?? decoded;
    if (size.width !== from.width || size.height !== from.height) canvas = resize(canvas, size);
    return await saveJpeg(copyCanvas(canvas), RECOGNITION_JPEG_COMPRESS);
  } catch {
    throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  }
}

/** Today's web prepare step, with the same sizing, resampler and JPEG encode. */
export async function prepareCurrent(uri: string): Promise<PreparedImage> {
  return renderJpeg(uri, (d) => ({ size: targetSize(d.width, d.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE) }));
}

/** Same as `prepareAtSize` in lib/prepareImage.web.ts: today's resize and encode, to exactly `size`. */
export async function prepareCurrentAtSize(uri: string, size: Size): Promise<PreparedImage> {
  if (![size.width, size.height].every((v) => Number.isInteger(v) && v > 0)) {
    throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  }
  return renderJpeg(uri, () => ({ size }));
}

/** Same as `prepareCropAtScale` in lib/prepareImage.web.ts: crop, then today's resize and encode (zoom on doubt). */
export async function prepareCurrentCropAtScale(uri: string, rect: Rect, scale: number): Promise<PreparedImage> {
  if (!(Number.isFinite(scale) && scale > 0)) throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  return renderJpeg(uri, (d) => {
    const c = clampRect(rect, d);
    if (!c) throw new Error('crop');
    return { crop: c, size: scaledCropSize(c, scale, RECOGNITION_MAX_EDGE) };
  });
}

/** Same as `deleteTempImages` in lib/prepareImage.web.ts: revokes blob: URLs, never throws. */
export async function revokeTempImages(uris: readonly (string | null | undefined)[]): Promise<void> {
  for (const uri of new Set(uris)) {
    if (typeof uri !== 'string' || !uri.startsWith('blob:')) continue;
    try {
      URL.revokeObjectURL(uri);
    } catch {
      // Best effort.
    }
  }
}
