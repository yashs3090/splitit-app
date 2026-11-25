// Main-thread client for the OpenCV worker (spec C4, Task 6). Reached only from `web/stages.ts`,
// which is itself loaded with `import()` during a web scan, so neither this file nor the worker URL
// is in the entry bundle (criterion 28). The worker (and with it ~11 MB of OpenCV) is started on
// the first call, never before a scan.
//
// Endings, each tested in `cvClient.test.ts`:
// - success: results resolve; `close()` at the end of the scan terminates the worker and revokes
//   every blob URL this client made;
// - start-up fails (`error { seq: null }`, a worker `error` event) or no `ready` within
//   `CV_LOAD_TIMEOUT_MS`: terminate, reject with `CvUnavailable` (now and for every later call);
// - an op fails: reject with `CvOpFailed` carrying the worker's code; the worker stays up;
// - an op never answers within `CV_OP_TIMEOUT_MS`, or the worker crashes: terminate, `CvUnavailable`;
// - abort: terminate, reject with `RecognitionError('cancelled')`.
// RN-free: no `react-native` / `expo-*` imports.
import { RecognitionError } from '../../recognitionError';
import {
  CV_MAX_DECODE_EDGE,
  CV_WORKER_PATH,
  type CvBitmap,
  type CvEncoding,
  type CvEnhanced,
  type CvEnhanceSteps,
  type CvErrorCode,
  type CvImage,
  type CvLoaded,
  type CvLocation,
  type CvOp,
  type CvRequest,
  type CvResponse,
  type CvResultOf,
} from './cv/protocol';
import type { Quad } from '../types';

/**
 * Why: the worker must download ~11 MB and compile OpenCV's wasm before `ready`. 30 s covers a slow
 * mobile connection; past that the scan continues without OpenCV (today's path) instead of hanging.
 * Tuned: not tuned (starting value from the spec, C4).
 */
export const CV_LOAD_TIMEOUT_MS = 30000;

/**
 * Why: a single op on a ≤ 4096 px image takes well under a second; one that hasn't answered in 60 s
 * means the worker is stuck (out of memory), so the scan stops waiting on it.
 * Tuned: not tuned (starting value, Task 6; not in the spec, added for the "never settles" ending).
 */
export const CV_OP_TIMEOUT_MS = 60000;

/** OpenCV can't be used for the rest of this scan (didn't load, timed out, crashed). Fixed message. */
export class CvUnavailable extends Error {
  constructor() {
    super('The image tools are not available.');
    this.name = 'CvUnavailable';
  }
}

/** One op failed; the worker is still usable. Only the worker's code, never library text. */
export class CvOpFailed extends Error {
  readonly code: CvErrorCode | 'decode_failed';

  constructor(code: CvErrorCode | 'decode_failed') {
    super('An image step failed.');
    this.name = 'CvOpFailed';
    this.code = code;
  }
}

/** The bits of `Worker` the client uses; a fake in tests. */
export type WorkerLike = {
  postMessage(message: CvRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: CvResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
};

export type CvClientOptions = {
  workerUrl?: string;
  createWorker?: (url: string) => WorkerLike;
  /** Decodes a photo URL with EXIF orientation applied. Default: fetch + `createImageBitmap`. */
  decode?: (uri: string) => Promise<CvBitmap>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  loadTimeoutMs?: number;
  opTimeoutMs?: number;
  maxDecodeEdge?: number;
};

export type CvClient = {
  /** Decodes `uri` (EXIF orientation applied) into the worker, capped at `maxDecodeEdge`. */
  load(uri: string, signal?: AbortSignal): Promise<CvLoaded>;
  resize(id: number, width: number, height: number, signal?: AbortSignal): Promise<CvImage>;
  /** Finds the receipt in a held image; the quad is in that image's pixels. */
  locate(id: number, signal?: AbortSignal): Promise<CvLocation>;
  /** Flattens `quad` of a held image into a new held image, margin added. */
  warp(id: number, quad: Quad, marginFraction: number, signal?: AbortSignal): Promise<CvImage>;
  /** Grey → flatten → CLAHE of a held image into a new held grey image (spec Task 9). */
  enhance(id: number, steps: CvEnhanceSteps, signal?: AbortSignal): Promise<CvEnhanced>;
  /** Encodes an image and returns a blob: URL this client owns (see `revoke` / `close`). */
  encode(id: number, format: CvEncoding, signal?: AbortSignal): Promise<string>;
  /** Per row of a held image, how many pixels are ink (strip tiling, Task 12). */
  rowInk(id: number, signal?: AbortSignal): Promise<Uint32Array>;
  /** Revokes a URL from `encode` now. Never throws. */
  revoke(url: string): void;
  /** Frees worker images. Fire-and-forget; never throws. */
  free(ids: readonly number[]): void;
  /** Whether the worker was ever started (for criterion 20 checks and the harness). */
  readonly started: boolean;
  /** Terminates the worker and revokes every URL. Idempotent; never throws. */
  close(): void;
};

/** EXIF orientation is applied (`from-image`), as `<img>` and the canvas path do today. */
async function defaultDecode(uri: string): Promise<CvBitmap> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'from-image' });
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> };

export function createCvClient(options: CvClientOptions = {}): CvClient {
  const {
    workerUrl = CV_WORKER_PATH,
    createWorker = (url: string) => new Worker(url) as unknown as WorkerLike,
    decode = defaultDecode,
    createObjectURL = (b: Blob) => URL.createObjectURL(b),
    revokeObjectURL = (u: string) => URL.revokeObjectURL(u),
    loadTimeoutMs = CV_LOAD_TIMEOUT_MS,
    opTimeoutMs = CV_OP_TIMEOUT_MS,
    maxDecodeEdge = CV_MAX_DECODE_EDGE,
  } = options;

  let worker: WorkerLike | null = null;
  let started = false;
  /** Set once the worker is gone for good; every later call rejects with it. */
  let dead: (() => Error) | null = null;
  let ready: Promise<void> | null = null;
  let failStart: (e: Error) => void = () => {};
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const pending = new Map<number, Pending>();
  const urls = new Set<string>();

  function kill(reason: () => Error): void {
    if (!dead) dead = reason;
    clearTimeout(startTimer);
    failStart(reason());
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // Best effort.
      }
      worker.onmessage = null;
      worker.onerror = null;
      worker = null;
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(reason());
    }
    pending.clear();
  }
  const unavailable = () => new CvUnavailable();
  const cancelled = () => new RecognitionError('cancelled');

  function onMessage(msg: CvResponse): void {
    if (msg.type === 'ready') return; // handled by the start-up listener
    // Only a start-up error has no `seq`.
    if (msg.seq === null) return kill(unavailable);
    const p = pending.get(msg.seq);
    if (!p) return;
    pending.delete(msg.seq);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(new CvOpFailed(msg.code));
    else p.resolve(msg.value);
  }

  function start(): Promise<void> {
    if (ready) return ready;
    started = true;
    ready = new Promise<void>((resolve, reject) => {
      failStart = reject;
      const timer = setTimeout(() => kill(unavailable), loadTimeoutMs);
      startTimer = timer;
      let w: WorkerLike;
      try {
        w = createWorker(workerUrl);
      } catch {
        clearTimeout(timer);
        kill(unavailable);
        return;
      }
      worker = w;
      w.onmessage = (event) => {
        const msg = event.data;
        if (msg && msg.type === 'ready') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (msg && msg.type === 'error' && msg.seq === null) clearTimeout(timer);
        onMessage(msg);
      };
      // Script 404, syntax error, or a crash later: the worker can't be trusted any more.
      w.onerror = () => {
        clearTimeout(timer);
        kill(unavailable);
      };
      w.onmessageerror = () => kill(unavailable);
    });
    ready.catch(() => {});
    return ready;
  }

  /** Races `work` with `signal`: abort terminates the worker and rejects `cancelled`. */
  async function guarded<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal?.aborted) {
      kill(cancelled);
      throw cancelled();
    }
    if (dead) throw dead();
    if (!signal) return work();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        kill(cancelled);
        reject(cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
      return await Promise.race([work(), aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function call<O extends CvOp>(req: Extract<CvRequest, { op: O }>, transfer: Transferable[] = []): Promise<CvResultOf[O]> {
    await start();
    const w = worker;
    if (dead || !w) throw (dead ?? unavailable)();
    return new Promise<CvResultOf[O]>((resolve, reject) => {
      const timer = setTimeout(() => kill(unavailable), opTimeoutMs);
      pending.set(req.seq, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        w.postMessage(req, transfer);
      } catch {
        pending.delete(req.seq);
        clearTimeout(timer);
        reject(new CvOpFailed('process_failed'));
      }
    });
  }

  return {
    load(uri, signal) {
      return guarded(signal, async () => {
        // Start the worker while the photo decodes.
        const startup = start();
        let bitmap: CvBitmap;
        try {
          bitmap = await new Promise<CvBitmap>((resolve, reject) => {
            const timer = setTimeout(() => reject(new CvOpFailed('decode_failed')), opTimeoutMs);
            decode(uri).then(
              (b) => {
                clearTimeout(timer);
                resolve(b);
              },
              () => {
                clearTimeout(timer);
                reject(new CvOpFailed('decode_failed'));
              },
            );
          });
        } catch (e) {
          await startup.catch(() => {});
          throw e;
        }
        try {
          await startup;
          if (dead) throw dead();
        } catch (e) {
          safeClose(bitmap);
          throw e;
        }
        // The bitmap is transferred: the worker owns (and closes) it from here.
        return call({ seq: ++seq, op: 'load', bitmap, maxDecodeEdge }, [bitmap as unknown as Transferable]);
      });
    },

    resize(id, width, height, signal) {
      return guarded(signal, () => call({ seq: ++seq, op: 'resize', id, width, height }));
    },

    locate(id, signal) {
      return guarded(signal, () => call({ seq: ++seq, op: 'locate', id }));
    },

    warp(id, quad, marginFraction, signal) {
      return guarded(signal, () => call({ seq: ++seq, op: 'warp', id, quad, marginFraction }));
    },

    enhance(id, steps, signal) {
      return guarded(signal, () => call({ seq: ++seq, op: 'enhance', id, steps }));
    },

    encode(id, format, signal) {
      return guarded(signal, async () => {
        const blob = await call({ seq: ++seq, op: 'encode', id, format });
        if (dead) throw dead();
        const url = createObjectURL(blob);
        urls.add(url);
        return url;
      });
    },

    rowInk(id, signal) {
      return guarded(signal, () => call({ seq: ++seq, op: 'rowInk', id }));
    },

    revoke(url) {
      if (!urls.delete(url)) return;
      try {
        revokeObjectURL(url);
      } catch {
        // Best effort.
      }
    },

    free(ids) {
      if (!worker || dead || ids.length === 0) return;
      // No reply is awaited; a late or missing one is harmless.
      call({ seq: ++seq, op: 'free', ids: [...ids] }).catch(() => {});
    },

    get started() {
      return started;
    },

    close() {
      kill(unavailable);
      for (const url of urls) {
        try {
          revokeObjectURL(url);
        } catch {
          // Best effort.
        }
      }
      urls.clear();
    },
  };
}

function safeClose(bitmap: CvBitmap): void {
  try {
    bitmap.close();
  } catch {
    // Best effort.
  }
}
