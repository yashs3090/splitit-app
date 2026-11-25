// The OpenCV worker's operations and its image store (spec C4, Task 6). Takes `cv` and the drawing
// surface as parameters, so Jest runs it against the real OpenCV and against a counting fake.
//
// Memory rules:
// - Every Mat an op allocates and doesn't hand to the store is deleted in a `finally`, on success
//   and when a step throws (criterion 34).
// - `free(ids)` deletes stored Mats; unknown ids are ignored (freeing twice is harmless).
// - `load` closes the transferred bitmap whatever happens.
import { RECOGNITION_JPEG_COMPRESS, targetSize } from '../../../imageSize';
import type { CvApi, CvMat } from './cvApi';
import type { Quad } from '../../types';
import { enhanceMat } from './enhance';
import { locateDocumentMat } from './locate';
import type { CvBitmap, CvEncoding, CvEnhanced, CvEnhanceSteps, CvImage, CvLoaded, CvLocation } from './protocol';
import { resizeMat } from './resize';
import { rowInkMat } from './rowInk';
import { warpQuad } from './warp';

/** RGBA pixels, row-major, 4 bytes per pixel (the shape of `ImageData`). */
export type Rgba = { data: Uint8ClampedArray; width: number; height: number };

/** The canvas side of the worker (an `OffscreenCanvas` in the browser). Injected for tests. */
export type Surface = {
  /** Draws `bitmap` scaled to `width × height` and returns its RGBA pixels. */
  rasterize(bitmap: CvBitmap, width: number, height: number): Rgba;
  /** Encodes RGBA pixels. `jpeg90` uses `quality`. */
  encode(rgba: Rgba, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob>;
};

export type CvOps = {
  load(bitmap: CvBitmap, maxDecodeEdge: number): CvLoaded;
  resize(id: number, width: number, height: number): CvImage;
  /** Finds the receipt in a held RGBA image (spec Task 7); allocates nothing that outlives the call. */
  locate(id: number): CvLocation;
  /** Flattens `quad` of a held image into a new held image, with the margin (spec Task 7). */
  warp(id: number, quad: Quad, marginFraction: number): CvImage;
  /** Grey → flatten → CLAHE into a new held grey image of the same size (spec Task 9). */
  enhance(id: number, steps: CvEnhanceSteps): CvEnhanced;
  encode(id: number, format: CvEncoding): Promise<Blob>;
  /** Per row of a held image, how many pixels are ink (strip tiling, Task 12). Allocates nothing that outlives the call. */
  rowInk(id: number): Uint32Array;
  free(ids: readonly number[]): void;
  /** How many images the store holds (for tests and leak checks). */
  size(): number;
};

export function createCvOps(cv: CvApi, surface: Surface): CvOps {
  const images = new Map<number, CvMat>();
  let nextId = 1;

  const put = (mat: CvMat): CvImage => {
    const id = nextId++;
    images.set(id, mat);
    return { id, width: mat.cols, height: mat.rows };
  };
  const get = (id: number): CvMat => {
    const mat = images.get(id);
    if (!mat) throw new RangeError('unknown image');
    return mat;
  };

  return {
    load(bitmap, maxDecodeEdge) {
      try {
        const sourceWidth = bitmap.width;
        const sourceHeight = bitmap.height;
        // Cap only (no upscale): the recognition size is chosen later, from the source size.
        const size = targetSize(sourceWidth, sourceHeight, maxDecodeEdge);
        const rgba = surface.rasterize(bitmap, size.width, size.height);
        const mat = new cv.Mat(size.height, size.width, cv.CV_8UC4);
        try {
          mat.data.set(rgba.data);
        } catch (e) {
          mat.delete();
          throw e;
        }
        return { ...put(mat), sourceWidth, sourceHeight };
      } finally {
        try {
          bitmap.close();
        } catch {
          // Best effort.
        }
      }
    },

    resize(id, width, height) {
      return put(resizeMat(cv, get(id), width, height));
    },

    locate(id) {
      return locateDocumentMat(cv, get(id));
    },

    warp(id, quad, marginFraction) {
      return put(warpQuad(cv, get(id), quad, marginFraction));
    },

    enhance(id, steps) {
      const r = enhanceMat(cv, get(id), steps);
      return { ...put(r.mat), lineHeightPx: r.lineHeightPx, kernelPx: r.kernelPx, greyLevels: r.greyLevels };
    },

    async encode(id, format) {
      const src = get(id);
      let rgbaMat: CvMat | null = null;
      let pixels: Rgba;
      try {
        const channels = src.channels();
        if (channels === 4) rgbaMat = src;
        else if (channels === 1) {
          rgbaMat = new cv.Mat();
          cv.cvtColor(src, rgbaMat, cv.COLOR_GRAY2RGBA);
        } else throw new RangeError('unsupported channels');
        // Copy out of wasm memory before any Mat is freed.
        pixels = { data: new Uint8ClampedArray(rgbaMat.data), width: rgbaMat.cols, height: rgbaMat.rows };
      } finally {
        if (rgbaMat && rgbaMat !== src) rgbaMat.delete();
      }
      return format === 'png'
        ? surface.encode(pixels, 'image/png')
        : surface.encode(pixels, 'image/jpeg', RECOGNITION_JPEG_COMPRESS);
    },

    rowInk(id) {
      return rowInkMat(cv, get(id));
    },

    free(ids) {
      for (const id of ids) {
        const mat = images.get(id);
        if (!mat) continue;
        images.delete(id);
        try {
          mat.delete();
        } catch {
          // Already gone.
        }
      }
    },

    size: () => images.size,
  };
}
