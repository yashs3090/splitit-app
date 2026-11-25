// cv resize (spec Task 6). Takes `cv` as a parameter so it runs the same in the worker and in Jest.
//
// The target size is chosen on the main thread by the same rule as today's web path
// (`targetSize(w, h, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE)` in `lib/imageSize.ts`); this file
// only resamples. The interpolation follows OpenCV's own advice for each direction:
// - going down, INTER_AREA averages the source pixels each output pixel covers, so thin strokes
//   don't alias away (the canvas path's Hermite filter is a similar idea);
// - going up, INTER_CUBIC interpolates smoothly instead of making blocky pixels.
import type { CvApi, CvMat } from './cvApi';

export type Interpolation = 'area' | 'cubic' | 'none';

/** Which resampler a `from → to` resize uses. By pixel count, since the aspect ratio is kept. */
export function interpolationFor(from: { width: number; height: number }, to: { width: number; height: number }): Interpolation {
  const a = from.width * from.height;
  const b = to.width * to.height;
  if (b < a) return 'area';
  if (b > a) return 'cubic';
  return 'none';
}

/**
 * A new Mat of `width × height` (the caller owns it and must `delete()` it). Same size = a copy.
 * Throws RangeError for a non-positive or non-integer size. Frees its own Mat if OpenCV throws.
 */
export function resizeMat(cv: CvApi, src: CvMat, width: number, height: number): CvMat {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('resizeMat needs positive integer sizes');
  }
  const how = interpolationFor({ width: src.cols, height: src.rows }, { width, height });
  if (how === 'none' && src.cols === width && src.rows === height) return src.clone();
  const dst = new cv.Mat();
  try {
    // 'none' with a different shape can't happen with the aspect kept; treat it as going down.
    cv.resize(src, dst, new cv.Size(width, height), 0, 0, how === 'cubic' ? cv.INTER_CUBIC : cv.INTER_AREA);
    return dst;
  } catch (e) {
    dst.delete();
    throw e;
  }
}
