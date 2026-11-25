// The shared Tesseract.js worker session: the recognize timeout (OCR harness finding, 2026-11-23:
// 3 of 16 Chromium runs on one receipt never returned from recognize). Tesseract is faked at
// `./webOcrEngine`; fake timers drive the timeout.
import type { RecognizedText } from './receiptTypes';
import { RecognitionError } from './recognitionError';

type FakeWorker = { terminate: jest.Mock };
const mockStartWorker = jest.fn();
const mockReadLines = jest.fn();
const mockReinitWorker = jest.fn();
jest.mock('./webOcrEngine', () => ({
  startWorker: (...a: unknown[]) => mockStartWorker(...a),
  readLines: (...a: unknown[]) => mockReadLines(...a),
  reinitWorker: (...a: unknown[]) => mockReinitWorker(...a),
}));

import { createOcrSession, engineLoader, initKey, RECOGNIZE_TIMEOUT_MS } from './webOcrSession';

// Jest can't run `import()`; load the engine lazily with require instead.
engineLoader.load = () => Promise.resolve(require('./webOcrEngine') as typeof import('./webOcrEngine'));

const TEXT: RecognizedText = { lines: [{ text: 'Total 11.00', box: { x: 0, y: 0, width: 100, height: 20 } }] };

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets pending promise callbacks run without moving the fake clock. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let worker: FakeWorker;
let onLog: ((m: { status: string; progress: number }) => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  worker = { terminate: jest.fn(async () => undefined) };
  mockStartWorker.mockImplementation(async (log: typeof onLog) => {
    onLog = log;
    return worker;
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('RECOGNIZE_TIMEOUT_MS', () => {
  it('is a generous fixed ceiling (a slow phone must not be cut off), but finite', () => {
    expect(Number.isInteger(RECOGNIZE_TIMEOUT_MS)).toBe(true);
    expect(RECOGNIZE_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(RECOGNIZE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('a recognize that never returns', () => {
  it('rejects with RecognitionError("timeout") once the ceiling passes, not before', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const session = createOcrSession();
    const p = session.read('blob:img');
    const settled = jest.fn();
    p.then(settled, settled);
    await flush();
    expect(mockReadLines).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecognitionError);
    expect(e).toMatchObject({ code: 'timeout', nativeCode: 'RECOGNIZE_TIMEOUT' });
    // Fixed app copy, never library text.
    expect((e as Error).message).toBe('Text recognition took too long.');
    session.close();
  });

  it('terminates the stuck worker at the timeout, once (close() afterwards does not terminate again)', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const session = createOcrSession();
    const p = session.read('blob:img').catch((x: unknown) => x);
    await flush();
    expect(worker.terminate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
    await p;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    session.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('ignores a late result and late progress from the timed-out read', async () => {
    const late = deferred<RecognizedText>();
    mockReadLines.mockReturnValue(late.promise);
    const progress = jest.fn();
    const session = createOcrSession();
    const p = session.read('blob:img', { onProgress: progress });
    const result = p.catch((x: unknown) => x);
    await flush();
    onLog?.({ status: 'recognizing text', progress: 0.4 });
    expect(progress).toHaveBeenCalledWith(0.4);

    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: 'timeout' });

    // The engine answers after all: nothing reaches the caller.
    onLog?.({ status: 'recognizing text', progress: 0.9 });
    late.resolve(TEXT);
    await flush();
    expect(progress).toHaveBeenCalledTimes(1);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a later read on the same session fails with timeout at once, without reading again', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const session = createOcrSession();
    const first = session.read('blob:a').catch((x: unknown) => x);
    await flush();
    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
    await first;
    await expect(session.read('blob:b')).rejects.toMatchObject({ code: 'timeout' });
    expect(mockReadLines).toHaveBeenCalledTimes(1);
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
  });

  it('times each read separately: two reads just under the ceiling both succeed', async () => {
    const session = createOcrSession();
    for (const uri of ['blob:a', 'blob:b']) {
      const answer = deferred<RecognizedText>();
      mockReadLines.mockReturnValueOnce(answer.promise);
      const p = session.read(uri);
      await flush();
      await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS - 1);
      answer.resolve(TEXT);
      await expect(p).resolves.toEqual(TEXT);
    }
    expect(worker.terminate).not.toHaveBeenCalled();
    session.close();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('the timer never outlives its read', () => {
  it('a read that succeeds leaves no timer behind', async () => {
    mockReadLines.mockResolvedValue(TEXT);
    const session = createOcrSession();
    await expect(session.read('blob:img')).resolves.toEqual(TEXT);
    expect(jest.getTimerCount()).toBe(0);
    session.close();
  });

  it('a read that is cancelled leaves no timer behind and reports cancelled, not timeout', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const c = new AbortController();
    const session = createOcrSession();
    const p = session.read('blob:img', { signal: c.signal }).catch((x: unknown) => x);
    await flush();
    c.abort();
    expect(await p).toMatchObject({ code: 'cancelled' });
    expect(jest.getTimerCount()).toBe(0);
    session.close();
  });

  it('the recognize timer starts when reading starts (engine start-up is not part of it)', async () => {
    const start = deferred<FakeWorker>();
    mockStartWorker.mockReturnValue(start.promise);
    mockReadLines.mockResolvedValue(TEXT);
    const session = createOcrSession();
    const p = session.read('blob:img');
    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS + 1000);
    start.resolve(worker);
    await expect(p).resolves.toEqual(TEXT);
    session.close();
  });
});

describe('Tesseract settings per read (spec Task 5)', () => {
  const NO_DICT = { load_system_dawg: '0', load_freq_dawg: '0' };

  beforeEach(() => {
    mockReadLines.mockResolvedValue(TEXT);
    mockReinitWorker.mockResolvedValue(undefined);
  });

  it('no settings: today\'s calls, startWorker(log, error) and readLines(worker, uri)', async () => {
    const session = createOcrSession();
    await session.read('blob:a', {});
    await session.read('blob:b', { tesseract: { params: {}, init: {}, rotateAuto: false } });
    expect(mockStartWorker.mock.calls[0]).toHaveLength(2);
    expect(mockReadLines.mock.calls).toEqual([[worker, 'blob:a'], [worker, 'blob:b']]);
    expect(mockReinitWorker).not.toHaveBeenCalled();
    session.close();
  });

  it('params and rotateAuto go to readLines for that read; init goes to startWorker', async () => {
    const session = createOcrSession();
    const params = { thresholding_method: '1' };
    await session.read('blob:a', { tesseract: { params, init: NO_DICT, rotateAuto: true } });
    expect(mockStartWorker.mock.calls[0]?.[2]).toEqual(NO_DICT);
    expect(mockReadLines.mock.calls).toEqual([[worker, 'blob:a', { params, rotateAuto: true }]]);
    expect(mockReinitWorker).not.toHaveBeenCalled();
    session.close();
  });

  it('a later read with another init re-initializes the worker first; the same init does not', async () => {
    const session = createOcrSession();
    await session.read('blob:a', { tesseract: { init: NO_DICT } });
    await session.read('blob:b', { tesseract: { init: { load_freq_dawg: '0', load_system_dawg: '0' } } }); // same, reordered
    expect(mockReinitWorker).not.toHaveBeenCalled();
    await session.read('blob:c');
    expect(mockReinitWorker.mock.calls).toEqual([[worker, undefined]]);
    expect(mockReinitWorker.mock.invocationCallOrder[0]!).toBeLessThan(mockReadLines.mock.invocationCallOrder[2]!);
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('a failed re-init fails that read and is tried again on the next one', async () => {
    mockReinitWorker.mockRejectedValueOnce(new Error('init failed'));
    const session = createOcrSession();
    await session.read('blob:a');
    await expect(session.read('blob:b', { tesseract: { init: NO_DICT } })).rejects.toBeInstanceOf(RecognitionError);
    await session.read('blob:c', { tesseract: { init: NO_DICT } });
    expect(mockReinitWorker).toHaveBeenCalledTimes(2);
    expect(mockReadLines).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('a re-init that never returns is cut off by the recognize ceiling', async () => {
    mockReinitWorker.mockReturnValue(new Promise(() => {}));
    const session = createOcrSession();
    await session.read('blob:a');
    const p = session.read('blob:b', { tesseract: { init: NO_DICT } }).catch((x: unknown) => x);
    await flush();
    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
    expect(await p).toMatchObject({ code: 'timeout' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('variant settings still get the timeout: a read with params that never returns times out', async () => {
    mockReadLines.mockReturnValue(new Promise(() => {}));
    const session = createOcrSession();
    const p = session.read('blob:a', { tesseract: { params: { user_defined_dpi: '300' } } }).catch((x: unknown) => x);
    await flush();
    await jest.advanceTimersByTimeAsync(RECOGNIZE_TIMEOUT_MS);
    expect(await p).toMatchObject({ code: 'timeout' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('onImageBinary is passed through to readLines', async () => {
    const session = createOcrSession();
    const onImageBinary = jest.fn();
    await session.read('blob:a', { onImageBinary });
    expect(mockReadLines.mock.calls).toEqual([[worker, 'blob:a', { onImageBinary }]]);
    session.close();
  });

  it('initKey: unset and {} match; key order does not matter; values do', () => {
    expect(initKey(undefined)).toBe(initKey({}));
    expect(initKey({ a: '0', b: '1' })).toBe(initKey({ b: '1', a: '0' }));
    expect(initKey({ a: '0' })).not.toBe(initKey({ a: '1' }));
  });
});
