// One Tesseract.js worker for the length of a scan (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md,
// Task 3: "one Tesseract worker per scan, reused across all passes and terminated in finally").
//
// Moved out of `textRecognition.web.ts` so the single-read recognizer and the web scan pipeline
// (`lib/scanPipeline/web/stages.ts`) share the same start-up, progress, cancel and error handling.
// - The engine (`lib/webOcrEngine.ts` + the library) is loaded only on the first `read`, via
//   `import()`, so it stays a separate lazy chunk and is never in the initial web bundle.
// - `close()` terminates the worker, now or as soon as it arrives. Callers call it in `finally`.
// - Each recognize call has a ceiling (`RECOGNIZE_TIMEOUT_MS`). Past it, the read rejects with
//   `RecognitionError('timeout')`, the worker is terminated and the session is finished: a late
//   result or progress number is dropped, and later reads fail with `timeout` at once.
// - Only `RecognitionError` leaves this module, with fixed messages. No console calls; only a
//   progress number leaves the engine's logger.
// - Task 5: a read may carry a variant's Tesseract settings. `params` and `rotateAuto` apply to that
//   read only; `init` (init-only parameters such as the dictionaries) is applied when the worker
//   starts, and a later read asking for a different `init` re-initializes the worker first (inside
//   the same recognize ceiling).
// RN-free: no `react-native` or `expo-*` imports (the browser harness bundles this file).
import type { RecognizedText } from './receiptTypes';
import { RecognitionError } from './recognitionError';
import type { RecognizeOptions } from './textRecognition';
import type { EngineWorker, ReadLinesOptions } from './webOcrEngine';

type Engine = typeof import('./webOcrEngine');

/**
 * How the engine is loaded: a dynamic `import()`, which Metro turns into a separate lazy chunk.
 * Test seam: Jest (without VM modules) can't run `import()`, so tests replace `load` with a lazy
 * `require`. Nothing else should touch it.
 */
export const engineLoader: { load: () => Promise<Engine> } = {
  load: () => import('./webOcrEngine'),
};

async function loadEngine(): Promise<Engine> {
  try {
    const engine = await engineLoader.load();
    if (typeof engine.startWorker !== 'function') throw new Error('engine missing');
    return engine;
  } catch {
    // The lazy chunk itself failed to load (offline, deploy mismatch).
    throw new RecognitionError('engine_load_failed', 'CHUNK_LOAD_FAILED');
  }
}

/**
 * Longest one Tesseract recognize call may take before the session gives up on it.
 * Why: the OCR harness (2026-11-23) saw 3 of 16 Chromium runs on one receipt stall in recognize
 * and never return, while every run that did return gave the same text. A stalled worker never
 * recovers, so without a ceiling the screen says "Reading receipt…" until the user cancels. The
 * value is a fixed ceiling, not scaled by photo size, because every image reaching recognize is
 * already capped at `RECOGNITION_MAX_EDGE` (2048 px long edge), so the work per read is bounded.
 * 30 s (user decision, 2026-11-23): normal reads took about 1–7 s in the harness, even with the
 * machine under heavy load, so 30 s leaves several times that for a slow phone's WebAssembly while
 * keeping a stalled read from leaving the user on a spinner for long. Cancel stays available the
 * whole time. Engine start-up is not timed here.
 * Tuned: not yet on real phones. Re-check once slow-phone recognize times are measured.
 */
export const RECOGNIZE_TIMEOUT_MS = 30_000;

function cancelled(): RecognitionError {
  return new RecognitionError('cancelled');
}

/** Rejects as soon as `signal` aborts. The returned `dispose` removes the listener. */
export function abortPromise(signal: AbortSignal | undefined): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => {}), dispose: () => {} };
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {}); // handled by the race; avoid an unhandled rejection if nobody races it
  return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}

/** Rejects with `RecognitionError('timeout')` after `ms`. The returned `dispose` clears the timer. */
function timeoutPromise(ms: number): { promise: Promise<never>; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT')), ms);
  });
  promise.catch(() => {});
  return { promise, dispose: () => clearTimeout(timer) };
}

function looksLikeImageError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /image|file could not be read|failed to fetch/i.test(msg);
}

/** A variant's Tesseract settings (`RecognizeConfig.tesseract`). */
export type TesseractSettings = {
  /** For this read only, on top of the engine's `TESSERACT_PARAMS`. */
  params?: Readonly<Record<string, string>>;
  /** Init-only parameters (e.g. `load_system_dawg`); unset or `{}` = Tesseract's defaults. */
  init?: Readonly<Record<string, string>>;
  rotateAuto?: boolean;
};

export type SessionReadOptions = RecognizeOptions & {
  tesseract?: TesseractSettings;
  /** Harness only (`--dump-binary`): receives Tesseract's binarized image as a PNG data URL. */
  onImageBinary?: (pngDataUrl: string) => void;
};

/** Order-independent key for an `init`; unset and `{}` are the same (no config). */
export function initKey(init: Readonly<Record<string, string>> | undefined): string {
  if (!init || Object.keys(init).length === 0) return '';
  return JSON.stringify(Object.keys(init).sort().map((k) => [k, init[k]]));
}

function readLinesOptions(opts: SessionReadOptions): ReadLinesOptions | null {
  const out: ReadLinesOptions = {};
  const params = opts.tesseract?.params;
  if (params && Object.keys(params).length > 0) out.params = params;
  if (opts.tesseract?.rotateAuto) out.rotateAuto = true;
  if (opts.onImageBinary) out.onImageBinary = opts.onImageBinary;
  return Object.keys(out).length > 0 ? out : null;
}

export type OcrSession = {
  /**
   * Reads one image. The first call starts the worker (reporting `loading_engine`); every call
   * reports `recognizing`. Rejects only with `RecognitionError`.
   */
  read(imageUri: string, opts?: SessionReadOptions): Promise<RecognizedText>;
  /** Terminates the worker (now, or when it finishes starting). Idempotent; never throws. */
  close(): void;
};

export function createOcrSession(): OcrSession {
  let closed = false;
  // Set when a read timed out: the worker is gone, so every later read fails the same way.
  let timedOut = false;
  let stopped = false;
  let worker: EngineWorker | null = null;
  let starting: Promise<{ engine: Engine; worker: EngineWorker }> | null = null;
  // The `initKey` the worker runs with; null after a failed re-init (state unknown: re-init next time).
  let workerInit: string | null = '';
  // The progress callback of the read in flight; the logger is shared by the whole session.
  let progressSink: ((fraction: number) => void) | undefined;

  const stop = (w: EngineWorker) => {
    if (stopped) return;
    stopped = true;
    w.terminate().catch(() => {});
  };

  async function start(init: Readonly<Record<string, string>> | undefined): Promise<{ engine: Engine; worker: EngineWorker }> {
    const engine = await loadEngine();

    // Turns any error reported during start-up into a rejection (see `startWorker`).
    let started = false;
    let failStartup: () => void = () => {};
    const startupFailed = new Promise<never>((_, reject) => {
      failStartup = () => reject(new Error('startup'));
    });
    startupFailed.catch(() => {});

    // Only a number leaves the logger, and only while reading; never the message itself.
    const onLog = (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number' && Number.isFinite(m.progress)) {
        progressSink?.(Math.min(1, Math.max(0, m.progress)));
      }
    };
    const onError = () => {
      if (!started) failStartup();
    };
    workerInit = initKey(init);
    // Without an init this is today's two-argument call.
    const workerPromise = workerInit === '' ? engine.startWorker(onLog, onError) : engine.startWorker(onLog, onError, init);
    // Whenever the worker arrives: keep it, or stop it if the session already ended.
    workerPromise.then(
      (w) => {
        worker = w;
        if (closed) stop(w);
      },
      () => {},
    );

    try {
      const w = await Promise.race([workerPromise, startupFailed]);
      started = true;
      return { engine, worker: w };
    } catch {
      throw new RecognitionError('engine_load_failed', 'WORKER_START_FAILED');
    }
  }

  return {
    async read(imageUri, opts = {}) {
      const { onProgress, onStage, signal } = opts;
      if (timedOut) throw new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT');
      if (signal?.aborted || closed) throw cancelled();
      const abort = abortPromise(signal);
      try {
        if (!starting) {
          onStage?.('loading_engine');
          starting = start(opts.tesseract?.init);
          starting.catch(() => {});
        }
        const { engine, worker: w } = await Promise.race([starting, abort.promise]);

        onStage?.('recognizing');
        progressSink = onProgress;
        const timeout = timeoutPromise(RECOGNIZE_TIMEOUT_MS);
        try {
          const wantInit = opts.tesseract?.init;
          const readOpts = readLinesOptions(opts);
          const work = (async () => {
            if (initKey(wantInit) !== workerInit) {
              workerInit = null;
              await engine.reinitWorker(w, wantInit);
              workerInit = initKey(wantInit);
            }
            return readOpts ? engine.readLines(w, imageUri, readOpts) : engine.readLines(w, imageUri);
          })();
          work.catch(() => {}); // a late failure after cancel or timeout goes nowhere
          return await Promise.race([work, abort.promise, timeout.promise]);
        } catch (e) {
          if (e instanceof RecognitionError && e.code === 'timeout') {
            // A stuck worker never recovers: end the session so its late answer goes nowhere.
            timedOut = true;
            closed = true;
            stop(w);
          }
          if (e instanceof RecognitionError) throw e;
          throw new RecognitionError(looksLikeImageError(e) ? 'image_load_failed' : 'failed', 'RECOGNIZE_FAILED');
        } finally {
          timeout.dispose();
        }
      } catch (e) {
        if (e instanceof RecognitionError) throw e;
        throw new RecognitionError('failed');
      } finally {
        progressSink = undefined;
        abort.dispose();
      }
    },

    close() {
      closed = true;
      if (worker) stop(worker);
    },
  };
}
