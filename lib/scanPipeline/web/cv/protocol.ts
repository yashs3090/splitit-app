// OpenCV worker protocol (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C4). Types and
// constants only: imported by the main-thread client (`../cvClient.ts`) and by the worker itself.
//
// The worker holds images by id so stages don't re-encode between steps. Ids are assigned by the
// worker (each op that makes an image returns the new id), so main and worker can never disagree.
// Task 6 implements load / resize / encode / free; Task 7 locate and warp; Task 9 enhance; Task 12
// rowInk (zoom on doubt crops on the canvas path, so there is no cropRow).
//
// Rules (C4):
// - No message carries recognised text or a filename. Errors carry only a code, never library text.
// - The worker frees every `Mat` it allocates for an op in a `finally` (see `ops.ts`).

import type { EnhanceOptions, LocateMethod, Quad } from '../../types';

/** Output encodings for the image handed to Tesseract. `jpeg90` = JPEG at `RECOGNITION_JPEG_COMPRESS`. */
export type CvEncoding = 'png' | 'jpeg90';

/** An image held in the worker. `width`/`height` are the pixels the worker holds. */
export type CvImage = { id: number; width: number; height: number };

/** `load` also reports the decoded photo's size before the `maxDecodeEdge` cap. */
export type CvLoaded = CvImage & { sourceWidth: number; sourceHeight: number };

/** What `locate` finds, in the held image's pixels (`os-scanner` is native only). */
export type CvLocation = { method: Exclude<LocateMethod, 'os-scanner'>; quad: Quad | null; confidence: number };

/** Enhance steps (spec Task 9): the config's `EnhanceOptions` when enhance is on. */
export type CvEnhanceSteps = Exclude<EnhanceOptions, false>;

/** An enhanced (grey) image, with what the step measured (for the harness's `meta`). */
export type CvEnhanced = CvImage & { lineHeightPx: number | null; kernelPx: number | null; greyLevels: number };

/** A decoded photo. On web an `ImageBitmap` (transferred); typed structurally so tests can fake it. */
export type CvBitmap = { readonly width: number; readonly height: number; close(): void };

export type CvRequest =
  | { seq: number; op: 'load'; bitmap: CvBitmap; maxDecodeEdge: number }
  | { seq: number; op: 'resize'; id: number; width: number; height: number }
  /** Finds the receipt; the quad is in the held image's pixels. */
  | { seq: number; op: 'locate'; id: number }
  /** Flattens `quad` (in the held image's pixels) into a new image with the margin added. */
  | { seq: number; op: 'warp'; id: number; quad: Quad; marginFraction: number }
  /** Grey → flatten → CLAHE (spec Task 9) into a new grey image; never binarized, same size. */
  | { seq: number; op: 'enhance'; id: number; steps: CvEnhanceSteps }
  | { seq: number; op: 'encode'; id: number; format: CvEncoding }
  /** Strip tiling (Task 12): per row of a held image, how many pixels are ink (`cv/rowInk.ts`). */
  | { seq: number; op: 'rowInk'; id: number }
  | { seq: number; op: 'free'; ids: number[] };

export type CvOp = CvRequest['op'];

/** What each op resolves to. */
export type CvResultOf = {
  load: CvLoaded;
  resize: CvImage;
  locate: CvLocation;
  warp: CvImage;
  enhance: CvEnhanced;
  encode: Blob;
  rowInk: Uint32Array;
  free: null;
};

export type CvErrorCode = 'load_failed' | 'process_failed';

export type CvResponse =
  | { type: 'ready' }
  | { type: 'result'; seq: number; value: CvResultOf[CvOp] }
  /** `seq: null` = start-up failed (OpenCV didn't load). Otherwise the op `seq` failed. */
  | { type: 'error'; seq: number | null; code: CvErrorCode };

/**
 * The worker script's served path. `public/opencv/` is copied by `scripts/copy-opencv-assets.mjs`
 * and the worker is built by `scripts/build-cv-worker.mjs` (both gitignored output).
 * Root-absolute on purpose: `new Worker(url)` resolves a relative URL against the page's URL, and in
 * this single-page app that is the current route (`/bill/<id>/…`), so a relative path would break
 * on nested routes. Serving the app under a sub-path would mean changing this one constant.
 */
export const CV_WORKER_PATH = '/opencv/receipt-cv-worker.js';

/**
 * OpenCV's script, relative to the worker's own URL (so `/opencv/opencv.js`): `importScripts`
 * resolves against the worker script, not the page, so this follows `CV_WORKER_PATH` wherever it
 * points and needs no change of its own.
 */
export const OPENCV_SCRIPT = 'opencv.js';

/**
 * Why: a memory guard. One 4096² RGBA image is about 64 MB, and the worker may hold the decoded
 * photo, a resized copy and (later tasks) a warp at once. Every recognition size is ≤
 * `RECOGNITION_MAX_EDGE` (2048), so decoding above 4096 adds memory but no text pixels.
 * Tuned: not tuned (starting value from the spec, Task 6).
 */
export const CV_MAX_DECODE_EDGE = 4096;
