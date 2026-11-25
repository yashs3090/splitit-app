// Web scan entry, imported by path (Jest's default platform is native). Spec:
// docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 3, criteria 20–23.
// Tesseract is faked at `./webOcrEngine`; the photo steps at `./prepareImage`.
import type { RecognizedText } from './receiptTypes';

const mockPrepare = jest.fn();
const mockDelete = jest.fn();
jest.mock('./prepareImage', () => ({
  prepareForRecognition: (uri: string) => mockPrepare(uri),
  deleteTempImages: (uris: unknown) => mockDelete(uris),
}));
// The web-only second-pass resize; the shipped plan has no second pass, so it is never called here.
const mockPrepareAtSize = jest.fn();
jest.mock('./prepareImage.web', () => ({
  prepareAtSize: (uri: string, size: unknown) => mockPrepareAtSize(uri, size),
}));

type FakeWorker = { terminate: jest.Mock };
const mockStartWorker = jest.fn();
const mockReadLines = jest.fn();
jest.mock('./webOcrEngine', () => ({
  startWorker: (...a: unknown[]) => mockStartWorker(...a),
  readLines: (...a: unknown[]) => mockReadLines(...a),
}));

import { scanReceipt, webStagesLoader } from './scanReceipt.web';
import { engineLoader } from './webOcrSession';
import type { RecognitionStage } from './textRecognition';

// Jest can't run `import()`; the production `import()`s are checked by the web export (criterion 28).
webStagesLoader.load = () => Promise.resolve(require('./scanPipeline/web/stages') as typeof import('./scanPipeline/web/stages'));
engineLoader.load = () => Promise.resolve(require('./webOcrEngine') as typeof import('./webOcrEngine'));

const PHOTO = 'blob:photo';
const RESIZED = 'blob:resized';

function lines(...texts: string[]): RecognizedText {
  return { lines: texts.map((text, i) => ({ text, box: { x: 0, y: i * 30, width: 300, height: 20 } })) };
}
const GOOD = lines('Corner Cafe', 'Soup 4.00', 'Bread 6.00', 'Subtotal 10.00', 'Tax 1.00', 'Total 11.00');
const NO_TOTAL = lines('Corner Cafe', 'Soup 4.00', 'Bread 6.00', 'Thank you', 'Come again');
const RETRY_PLAN = { primary: 'web-current', retry: 'web-current' };

let worker: FakeWorker;
const g = globalThis as Record<string, unknown>;
const savedWorker = g.Worker;
let WorkerSpy: jest.Mock;

/** A promise the test settles later. */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  worker = { terminate: jest.fn(async () => undefined) };
  mockStartWorker.mockResolvedValue(worker);
  mockReadLines.mockResolvedValue(GOOD);
  mockPrepare.mockResolvedValue({ uri: RESIZED, width: 1200, height: 1600 });
  mockDelete.mockResolvedValue(undefined);
  WorkerSpy = jest.fn();
  g.Worker = WorkerSpy;
});
afterAll(() => {
  if (savedWorker === undefined) delete g.Worker;
  else g.Worker = savedWorker;
});

describe('web scanReceipt at the starting config (criterion 21: no behaviour change)', () => {
  it('makes today\'s calls: prepare(photo) → readLines(worker, resized), one worker, both blob URLs revoked once', async () => {
    const r = await scanReceipt(PHOTO);
    expect(mockPrepare.mock.calls).toEqual([[PHOTO]]);
    expect(mockPrepareAtSize).not.toHaveBeenCalled();
    expect(mockReadLines.mock.calls).toEqual([[worker, RESIZED]]);
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockDelete.mock.calls).toEqual([[[PHOTO, RESIZED]]]);
    expect(r.attempts).toHaveLength(1);
    expect(r.best.text).toEqual(GOOD);
    expect(r.best.verdict.ok).toBe(true);

  });

  it('reports preparing → loading_engine → recognizing', async () => {
    const stages: RecognitionStage[] = [];
    await scanReceipt(PHOTO, { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['preparing', 'recognizing', 'loading_engine', 'recognizing']);
  });

  it('criterion 20: never creates a Worker for OpenCV (the cv client is never reached)', async () => {
    await scanReceipt(PHOTO, {}, RETRY_PLAN);
    expect(WorkerSpy).not.toHaveBeenCalled();
  });
});

describe('one Tesseract worker per scan (criterion 22)', () => {
  it('a scan with a retry starts one worker, reads twice, terminates once', async () => {
    mockReadLines.mockResolvedValueOnce(NO_TOTAL).mockResolvedValueOnce(GOOD);
    const stages: RecognitionStage[] = [];
    const r = await scanReceipt(PHOTO, { onStage: (s) => stages.push(s) }, RETRY_PLAN);
    expect(r.attempts).toHaveLength(2);
    expect(r.best.text).toEqual(GOOD);
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    expect(mockReadLines).toHaveBeenCalledTimes(2);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(stages.slice(-2)).toEqual(['retrying', 'retrying']);
    // Each attempt prepared its own copy; all are revoked in one call at the end.
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});

describe('endings (criterion 23): every one terminates the worker and revokes every blob URL', () => {
  it('success', async () => {
    await scanReceipt(PHOTO);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith([PHOTO, RESIZED]);
  });

  it('error in prepare → image_load_failed, no worker started, photo revoked', async () => {
    const { RecognitionError } = require('./recognitionError') as typeof import('./recognitionError');
    mockPrepare.mockRejectedValue(new RecognitionError('image_load_failed', 'PREPARE_FAILED'));
    await expect(scanReceipt(PHOTO)).rejects.toMatchObject({ code: 'image_load_failed' });
    expect(mockStartWorker).not.toHaveBeenCalled();
    expect(mockDelete.mock.calls).toEqual([[[PHOTO]]]);
  });

  it('error in recognize → failed with a fixed message, worker terminated, blobs revoked', async () => {
    mockReadLines.mockRejectedValue(new Error('SECRET-LIB-TEXT'));
    const e = await scanReceipt(PHOTO).catch((x: unknown) => x);
    expect(e).toMatchObject({ name: 'RecognitionError', code: 'failed' });
    expect((e as Error).message).not.toMatch(/SECRET/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith([PHOTO, RESIZED]);
  });

  it('the web stage chunk fails to load → engine_load_failed, photo revoked', async () => {
    const saved = webStagesLoader.load;
    webStagesLoader.load = () => Promise.reject(new Error('ChunkLoadError'));
    try {
      await expect(scanReceipt(PHOTO)).rejects.toMatchObject({ code: 'engine_load_failed' });
      expect(mockDelete.mock.calls).toEqual([[[PHOTO]]]);
    } finally {
      webStagesLoader.load = saved;
    }
  });

  it('cancel during preparing → cancelled, no worker, both blobs revoked', async () => {
    const prep = deferred<{ uri: string; width: number; height: number }>();
    mockPrepare.mockReturnValue(prep.promise);
    const c = new AbortController();
    const p = scanReceipt(PHOTO, { signal: c.signal });
    await tick();
    c.abort();
    prep.resolve({ uri: RESIZED, width: 1, height: 1 });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockStartWorker).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith([PHOTO, RESIZED]);
  });

  it('cancel during loading_engine → cancelled at once; the worker is terminated when it arrives', async () => {
    const start = deferred<FakeWorker>();
    mockStartWorker.mockReturnValue(start.promise);
    const c = new AbortController();
    const p = scanReceipt(PHOTO, {
      signal: c.signal,
      onStage: (s) => {
        if (s === 'loading_engine') setTimeout(() => c.abort(), 0);
      },
    });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockDelete).toHaveBeenCalledWith([PHOTO, RESIZED]);
    expect(worker.terminate).not.toHaveBeenCalled();
    start.resolve(worker);
    await tick();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockReadLines).not.toHaveBeenCalled();
  });

  it('cancel during recognizing (engine never answers) → cancelled, terminated, revoked', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const c = new AbortController();
    const p = scanReceipt(PHOTO, { signal: c.signal });
    await tick();
    await tick();
    expect(mockReadLines).toHaveBeenCalledTimes(1);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith([PHOTO, RESIZED]);
  });

  it('recognize never returns → timeout after RECOGNIZE_TIMEOUT_MS, worker terminated, blobs revoked, late result ignored', async () => {
    const { RECOGNIZE_TIMEOUT_MS } = require('./webOcrSession') as typeof import('./webOcrSession');
    jest.useFakeTimers();
    try {
      const late = deferred<RecognizedText>();
      mockReadLines.mockReturnValue(late.promise);
      const progress: number[] = [];
      const p = scanReceipt(PHOTO, { onProgress: (f) => progress.push(f) }, RETRY_PLAN);
      const result = p.catch((x: unknown) => x);
      for (let i = 0; i < 20 && mockReadLines.mock.calls.length < 1; i++) await jest.advanceTimersByTimeAsync(0);
      expect(mockReadLines).toHaveBeenCalledTimes(1);
      expect(worker.terminate).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
      const e = await result;
      expect(e).toMatchObject({ name: 'RecognitionError', code: 'timeout', message: 'Text recognition took too long.' });
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(mockDelete.mock.calls).toEqual([[[PHOTO, RESIZED]]]);
      // No automatic retry on a timeout, even with a retry in the plan: the scan fails once.
      expect(mockReadLines).toHaveBeenCalledTimes(1);
      expect(mockStartWorker).toHaveBeenCalledTimes(1);

      late.resolve(GOOD);
      await jest.advanceTimersByTimeAsync(0);
      expect(progress).toEqual([]);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel during retrying → cancelled, terminated once, every prepared copy revoked', async () => {
    mockPrepare
      .mockResolvedValueOnce({ uri: RESIZED, width: 1, height: 1 })
      .mockResolvedValueOnce({ uri: 'blob:resized-2', width: 1, height: 1 });
    mockReadLines.mockResolvedValueOnce(NO_TOTAL).mockReturnValueOnce(new Promise(() => {}));
    const c = new AbortController();
    let retrying = false;
    const p = scanReceipt(
      PHOTO,
      {
        signal: c.signal,
        onStage: (s) => {
          if (s === 'retrying') retrying = true;
        },
      },
      RETRY_PLAN,
    );
    for (let i = 0; i < 10 && mockReadLines.mock.calls.length < 2; i++) await tick();
    expect(retrying).toBe(true);
    c.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mockDelete.mock.calls).toEqual([[[PHOTO, RESIZED, 'blob:resized-2']]]);
  });

  it('an already-aborted signal loads nothing and revokes the photo', async () => {
    const c = new AbortController();
    c.abort();
    await expect(scanReceipt(PHOTO, { signal: c.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDelete.mock.calls).toEqual([[[PHOTO]]]);
  });

  it('an unknown or native variant name is refused before anything runs, and the photo is revoked', async () => {
    await expect(scanReceipt(PHOTO, {}, { primary: 'native-current', retry: null })).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'failed',
    });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockDelete.mock.calls).toEqual([[[PHOTO]]]);
  });
});
