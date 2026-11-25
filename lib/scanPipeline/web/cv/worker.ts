// The OpenCV Web Worker (spec C4, Task 6). Built by `scripts/build-cv-worker.mjs` (esbuild, IIFE)
// into `public/opencv/receipt-cv-worker.js`, a classic worker: `importScripts` loads OpenCV from
// the same origin. Metro never bundles this file: nothing in the app imports it.
//
// Start-up, checked on the installed 4.12.0-release.1 (task report):
// - The UMD wrapper sets `self.cv` to an Emscripten Module that has a `then` method; it is not a
//   Promise. A global `self.Module` set before `importScripts` is ignored: the package's patch
//   declares `var Module` inside the factory, which shadows it. So we wait on the Module itself.
// - Never `await cv` or resolve a Promise with it: the Module is a thenable that passes itself to
//   its callback, so resolving with it recurses. `whenReady` only calls our callback.
// - A real Promise (a possible future build) is handled the same way.
//
// Privacy: no console calls; errors leave as a code only, never library text.
import type { CvApi } from './cvApi';
import { createCvOps, type CvOps, type Surface } from './ops';
import { OPENCV_SCRIPT, type CvRequest, type CvResponse } from './protocol';

export type WorkerScope = {
  importScripts(...urls: string[]): void;
  postMessage(message: CvResponse): void;
  onmessage: ((event: { data: CvRequest }) => void) | null;
  cv?: unknown;
};

type Loadable = { Mat?: unknown; then?: unknown; onRuntimeInitialized?: () => void };

/** Calls `ready(cv)` once OpenCV's runtime is initialised (now, if it already is). */
export function whenReady(cv: unknown, ready: (api: CvApi) => void): void {
  if (cv === null || (typeof cv !== 'object' && typeof cv !== 'function')) throw new TypeError('no cv');
  let called = false;
  const once = (m: unknown) => {
    if (called) return;
    called = true;
    // A Promise build resolves to the module; the 4.12 thenable passes itself.
    ready((m && typeof (m as Loadable).Mat === 'function' ? m : cv) as CvApi);
  };
  const mod = cv as Loadable;
  if (typeof mod.Mat === 'function') return once(cv);
  if (typeof mod.then === 'function') {
    (mod.then as (f: (m: unknown) => void) => unknown).call(cv, (m) => once(m));
    return;
  }
  const prev = mod.onRuntimeInitialized;
  mod.onRuntimeInitialized = () => {
    prev?.();
    once(cv);
  };
}

/** The browser drawing surface: `OffscreenCanvas` (Chromium, Firefox, Safari 16.4+). */
export function browserSurface(): Surface {
  return {
    rasterize(bitmap, width, height) {
      const canvas = new OffscreenCanvas(width, height);
      const g = canvas.getContext('2d', { willReadFrequently: true });
      if (!g) throw new Error('no 2d context');
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap as unknown as ImageBitmap, 0, 0, width, height);
      return g.getImageData(0, 0, width, height);
    },
    encode(rgba, type, quality) {
      const canvas = new OffscreenCanvas(rgba.width, rgba.height);
      const g = canvas.getContext('2d');
      if (!g) return Promise.reject(new Error('no 2d context'));
      // `ImageData` wants an ArrayBuffer-backed array; ours always is.
      g.putImageData(new ImageData(rgba.data as Uint8ClampedArray<ArrayBuffer>, rgba.width, rgba.height), 0, 0);
      return canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
    },
  };
}

async function run(ops: CvOps, req: CvRequest): Promise<CvResponse> {
  switch (req.op) {
    case 'load':
      return { type: 'result', seq: req.seq, value: ops.load(req.bitmap, req.maxDecodeEdge) };
    case 'resize':
      return { type: 'result', seq: req.seq, value: ops.resize(req.id, req.width, req.height) };
    case 'locate':
      return { type: 'result', seq: req.seq, value: ops.locate(req.id) };
    case 'warp':
      return { type: 'result', seq: req.seq, value: ops.warp(req.id, req.quad, req.marginFraction) };
    case 'enhance':
      return { type: 'result', seq: req.seq, value: ops.enhance(req.id, req.steps) };
    case 'encode':
      return { type: 'result', seq: req.seq, value: await ops.encode(req.id, req.format) };
    case 'rowInk':
      return { type: 'result', seq: req.seq, value: ops.rowInk(req.id) };
    case 'free':
      ops.free(req.ids);
      return { type: 'result', seq: req.seq, value: null };
  }
}

/** Loads OpenCV into `scope`, then answers requests. Posts `ready`, or `error { seq: null }`. */
export function bootWorker(scope: WorkerScope, surface: Surface = browserSurface()): void {
  let ops: CvOps | null = null;

  scope.onmessage = (event) => {
    const req = event.data;
    const seq = typeof req?.seq === 'number' ? req.seq : -1;
    if (!ops) {
      // The client waits for `ready` before sending, so this is a protocol slip; answer anyway.
      if (req?.op === 'load') safeClose(req.bitmap);
      scope.postMessage({ type: 'error', seq, code: 'process_failed' });
      return;
    }
    run(ops, req).then(
      (res) => scope.postMessage(res),
      () => scope.postMessage({ type: 'error', seq, code: 'process_failed' }),
    );
  };

  try {
    scope.importScripts(OPENCV_SCRIPT);
    whenReady(scope.cv, (cv) => {
      ops = createCvOps(cv, surface);
      scope.postMessage({ type: 'ready' });
    });
  } catch {
    scope.postMessage({ type: 'error', seq: null, code: 'load_failed' });
  }
}

function safeClose(bitmap: { close?: () => void } | undefined): void {
  try {
    bitmap?.close?.();
  } catch {
    // Best effort.
  }
}

// Boot only inside a real worker (Jest and the app never have `importScripts` + no `document`).
const g = globalThis as unknown as Partial<WorkerScope> & { document?: unknown };
if (typeof g.importScripts === 'function' && g.document === undefined) bootWorker(g as WorkerScope);
