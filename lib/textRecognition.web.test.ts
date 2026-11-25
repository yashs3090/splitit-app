// The web (Tesseract.js) implementation, imported by path (Jest's default platform here is native).
// Criteria 50–52 in docs/specs/2026-11-20-m1a-scan-receipt.md (A3 / Task 9).
import type { LoggerMessage, Page, WorkerOptions } from 'tesseract.js';


type FakeWorker = { setParameters: jest.Mock; recognize: jest.Mock; terminate: jest.Mock };

let mockWorker: FakeWorker;
const mockCreateWorker = jest.fn();
// A getter, so a test can make the loaded module look broken (no createWorker).
let mockExportCreateWorker = true;
const mockTesseractFactory = jest.fn(() => ({
  get createWorker() {
    return mockExportCreateWorker ? mockCreateWorker : undefined;
  },
}));
jest.mock('tesseract.js', () => mockTesseractFactory());

const mockMlkitFactory = jest.fn(() => ({}));
jest.mock('expo-mlkit-ocr', () => mockMlkitFactory());

// Imported after the mocks so the lazy-load assertion below sees the module's import time.
import { engineLoader, RecognitionError, textRecognizer } from './textRecognition.web';

// Jest can't run `import()` here (no VM modules); load the engine lazily with require instead.
// The production `import('./webOcrEngine')` is checked by the web export (criterion 53).
engineLoader.load = () => Promise.resolve(require('./webOcrEngine') as typeof import('./webOcrEngine'));

const SECRET = 'boom at https://example.test/private/receipt.jpg';

function line(text: string, x0: number, y0: number, x1: number, y1: number) {
  return { text, bbox: { x0, y0, x1, y1 } };
}

function pageOf(lines: ReturnType<typeof line>[]): Partial<Page> {
  return { blocks: [{ paragraphs: [{ lines }] }] } as unknown as Partial<Page>;
}

function workerOptions(): Partial<WorkerOptions> {
  const call = mockCreateWorker.mock.calls[0] as [string, number, Partial<WorkerOptions>] | undefined;
  if (!call) throw new Error('createWorker not called');
  return call[2];
}

function freshWorker(page: Partial<Page> = pageOf([line('Total 1.00', 0, 0, 100, 20)])): FakeWorker {
  return {
    setParameters: jest.fn(async () => ({ jobId: 'p', data: {} })),
    recognize: jest.fn(async () => ({ jobId: 'r', data: page })),
    terminate: jest.fn(async () => ({ jobId: 't', data: {} })),
  };
}

describe('lazy loading (52)', () => {
  it('does not load tesseract.js at import time; loads it on the first recognize', async () => {
    expect(mockTesseractFactory).not.toHaveBeenCalled();
    mockWorker = freshWorker();
    mockCreateWorker.mockResolvedValue(mockWorker);
    await textRecognizer.recognize('blob:x');
    expect(mockTesseractFactory).toHaveBeenCalledTimes(1);
  });

  it('never loads expo-mlkit-ocr', () => {
    expect(mockMlkitFactory).not.toHaveBeenCalled();
  });
});

describe('textRecognizer (web) (51)', () => {
  beforeEach(() => {
    mockCreateWorker.mockReset();
    mockWorker = freshWorker();
    mockCreateWorker.mockResolvedValue(mockWorker);
  });

  it('uses self-hosted same-origin assets, LSTM only, with the receipt parameters', async () => {
    const result = await textRecognizer.recognize('blob:x');
    expect(result.lines).toEqual([{ text: 'Total 1.00', box: { x: 0, y: 0, width: 100, height: 20 } }]);
    const [lang, oem, opts] = mockCreateWorker.mock.calls[0] as [string, number, Partial<WorkerOptions>];
    expect(lang).toBe('eng');
    expect(oem).toBe(1);
    expect(opts).toMatchObject({
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/core',
      langPath: '/tesseract/lang',
      workerBlobURL: false,
    });
    expect(JSON.stringify(opts)).not.toMatch(/jsdelivr/);
    expect(mockWorker.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    expect(mockWorker.recognize).toHaveBeenCalledWith('blob:x', {}, { blocks: true });
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('forwards only recognizing-text progress, as a number, and reports stages', async () => {
    const onProgress = jest.fn();
    const onStage = jest.fn();
    mockWorker.recognize.mockImplementation(async () => {
      const { logger } = workerOptions();
      const send = (status: string, progress: number) =>
        logger?.({ status, progress, jobId: 'j', userJobId: 'u', workerId: 'w' } as LoggerMessage);
      send('loading language traineddata', 0.5);
      send('recognizing text', 0.5);
      send('initializing api', 1);
      send('recognizing text', 1);
      return { jobId: 'r', data: pageOf([line('A 1.00', 0, 0, 1, 1)]) };
    });
    await textRecognizer.recognize('blob:x', { onProgress, onStage });
    expect(onProgress.mock.calls).toEqual([[0.5], [1]]);
    expect(onStage.mock.calls).toEqual([['loading_engine'], ['recognizing']]);
  });

  it('terminates once and rejects with failed (fixed message) when recognize fails', async () => {
    mockWorker.recognize.mockRejectedValue(new Error(SECRET));
    const err = await textRecognizer.recognize('blob:x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecognitionError);
    expect(err).toMatchObject({ code: 'failed' });
    expect((err as Error).message).not.toContain('boom');
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('maps an image read failure to image_load_failed', async () => {
    mockWorker.recognize.mockRejectedValue('Error attempting to read image.');
    await expect(textRecognizer.recognize('blob:x')).rejects.toMatchObject({ code: 'image_load_failed' });
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('rejects with engine_load_failed when createWorker rejects (worker/core 404, offline)', async () => {
    mockCreateWorker.mockRejectedValue(new Error(SECRET));
    const err = await textRecognizer.recognize('blob:x').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'RecognitionError', code: 'engine_load_failed' });
    expect((err as Error).message).not.toContain('boom');
  });

  it('rejects with engine_load_failed when start-up reports an error but createWorker never settles (traineddata 404)', async () => {
    mockCreateWorker.mockImplementation((_l: string, _o: number, opts: Partial<WorkerOptions>) => {
      setTimeout(() => opts.errorHandler?.('Network error while fetching /tesseract/lang/eng.traineddata.gz'), 0);
      return new Promise(() => {});
    });
    await expect(textRecognizer.recognize('blob:x')).rejects.toMatchObject({ code: 'engine_load_failed' });
  });

  it('rejects with engine_load_failed when the library in the chunk has no createWorker', async () => {
    mockExportCreateWorker = false;
    try {
      await expect(textRecognizer.recognize('blob:x')).rejects.toMatchObject({ code: 'engine_load_failed' });
      expect(mockCreateWorker).not.toHaveBeenCalled();
    } finally {
      mockExportCreateWorker = true;
    }
  });

  it('aborting rejects with cancelled and terminates the worker (during recognize)', async () => {
    const controller = new AbortController();
    mockWorker.recognize.mockImplementation(() => {
      controller.abort();
      return new Promise(() => {}); // the engine never answers; the abort must win
    });
    await expect(textRecognizer.recognize('blob:x', { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('aborting while the worker starts terminates it once it arrives', async () => {
    const controller = new AbortController();
    let arrive: (w: FakeWorker) => void = () => {};
    mockCreateWorker.mockImplementation(() => new Promise((resolve) => (arrive = resolve)));
    const p = textRecognizer.recognize('blob:x', { signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(mockWorker.terminate).not.toHaveBeenCalled();
    arrive(mockWorker);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockWorker.terminate).toHaveBeenCalledTimes(1);
    expect(mockWorker.recognize).not.toHaveBeenCalled();
  });

  it('an already-aborted signal rejects with cancelled without loading anything', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(textRecognizer.recognize('blob:x', { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });
});

describe('isAvailable', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, Worker: g.Worker, WebAssembly: g.WebAssembly };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });

  it('is true with window, Worker and WebAssembly', () => {
    g.window = g.window ?? {};
    g.Worker = function Worker() {};
    g.WebAssembly = g.WebAssembly ?? {};
    expect(textRecognizer.isAvailable()).toBe(true);
  });

  it('is false without Worker (old browser)', () => {
    g.window = g.window ?? {};
    delete g.Worker;
    expect(textRecognizer.isAvailable()).toBe(false);
  });

  it('is false without WebAssembly', () => {
    g.window = g.window ?? {};
    g.Worker = function Worker() {};
    const wasm = g.WebAssembly;
    delete g.WebAssembly;
    try {
      expect(textRecognizer.isAvailable()).toBe(false);
    } finally {
      g.WebAssembly = wasm;
    }
  });
});
