// Worker start-up and message dispatch, with a fake worker scope and a fake `cv` (spec Task 6, C4).
// The real OpenCV start-up in a real worker was checked in Chromium (task report); the real
// OpenCV ops run in resize.test.ts.
import type { Surface } from './ops';
import type { CvRequest, CvResponse } from './protocol';
import { bootWorker, whenReady, type WorkerScope } from './worker';

function fakeCv() {
  class Mat {
    rows: number;
    cols: number;
    data: Uint8Array;
    constructor(rows = 0, cols = 0) {
      this.rows = rows;
      this.cols = cols;
      this.data = new Uint8Array(rows * cols * 4);
    }
    channels() {
      return 4;
    }
    clone() {
      return new Mat(this.rows, this.cols);
    }
    delete() {}
  }
  const api = {
    Size: class {
      constructor(
        public width: number,
        public height: number,
      ) {}
    },
    CV_8UC1: 0,
    CV_8UC4: 24,
    INTER_AREA: 3,
    INTER_CUBIC: 2,
    COLOR_GRAY2RGBA: 9,
    resize(_s: Mat, d: Mat, size: { width: number; height: number }) {
      d.rows = size.height;
      d.cols = size.width;
    },
    cvtColor() {},
  };
  return { ...api, Mat };
}

const surface: Surface = {
  rasterize: (_b, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  encode: async () => new Blob(['x']),
};

function scope(onImport: (s: WorkerScope) => void = (s) => (s.cv = fakeCv())) {
  const posted: CvResponse[] = [];
  const s: WorkerScope = {
    importScripts: jest.fn(() => onImport(s)),
    postMessage: (m) => posted.push(m),
    onmessage: null,
  };
  const send = (data: CvRequest) => s.onmessage?.({ data });
  return { s, posted, send };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('whenReady', () => {
  it('already initialised (Mat present) → now', () => {
    const ready = jest.fn();
    const cv = fakeCv();
    whenReady(cv, ready);
    expect(ready).toHaveBeenCalledWith(cv);
  });

  it('the 4.12 thenable Module: waits on `then`, calls back once, and never resolves a Promise with it', () => {
    const ready = jest.fn();
    let later: ((m: unknown) => void) | null = null;
    const mod: Record<string, unknown> = {
      then(f: (m: unknown) => void) {
        later = f;
        return mod;
      },
    };
    whenReady(mod, ready);
    expect(ready).not.toHaveBeenCalled();
    mod.Mat = function Mat() {};
    later!(mod);
    later!(mod);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(mod);
  });

  it('a real Promise build resolving to the module', async () => {
    const ready = jest.fn();
    const m = fakeCv();
    whenReady(Promise.resolve(m), ready);
    await flush();
    expect(ready).toHaveBeenCalledWith(m);
  });

  it('neither: chains onRuntimeInitialized, keeping an existing handler', () => {
    const ready = jest.fn();
    const prev = jest.fn();
    const mod: { onRuntimeInitialized?: () => void } = { onRuntimeInitialized: prev };
    whenReady(mod, ready);
    mod.onRuntimeInitialized!();
    expect(prev).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('no cv at all → throws (the boot reports load_failed)', () => {
    expect(() => whenReady(undefined, jest.fn())).toThrow();
  });
});

describe('bootWorker', () => {
  it('loads opencv.js relative to the worker, posts ready, then answers ops by seq', async () => {
    const { s, posted, send } = scope();
    bootWorker(s, surface);
    expect(s.importScripts).toHaveBeenCalledWith('opencv.js');
    expect(posted).toEqual([{ type: 'ready' }]);
    const close = jest.fn();
    send({ seq: 1, op: 'load', bitmap: { width: 40, height: 20, close }, maxDecodeEdge: 4096 });
    send({ seq: 2, op: 'resize', id: 1, width: 20, height: 10 });
    send({ seq: 3, op: 'encode', id: 2, format: 'png' });
    send({ seq: 4, op: 'free', ids: [1, 2] });
    await flush();
    // Answers may arrive out of order (encode is async); the client matches them by seq.
    const bySeq = (posted.slice(1) as { seq: number }[]).sort((a, b) => a.seq - b.seq);
    expect(bySeq).toEqual([
      { type: 'result', seq: 1, value: { id: 1, width: 40, height: 20, sourceWidth: 40, sourceHeight: 20 } },
      { type: 'result', seq: 2, value: { id: 2, width: 20, height: 10 } },
      { type: 'result', seq: 3, value: expect.any(Blob) },
      { type: 'result', seq: 4, value: null },
    ]);
    expect(close).toHaveBeenCalled();
  });

  it('a failing op answers `process_failed` with its seq and no library text', async () => {
    const { s, posted, send } = scope();
    bootWorker(s, surface);
    send({ seq: 7, op: 'resize', id: 999, width: 1, height: 1 });
    await flush();
    expect(posted[1]).toEqual({ type: 'error', seq: 7, code: 'process_failed' });
  });

  it('importScripts failing (404, CSP) → error { seq: null, load_failed }', () => {
    const { s, posted } = scope(() => {
      throw new Error('NetworkError: secret path');
    });
    bootWorker(s, surface);
    expect(posted).toEqual([{ type: 'error', seq: null, code: 'load_failed' }]);
  });

  it('before ready, an op is refused and a sent bitmap is closed', () => {
    let finish: () => void = () => {};
    const { s, posted, send } = scope((sc) => {
      const mod: Record<string, unknown> = {
        then(f: (m: unknown) => void) {
          finish = () => {
            mod.Mat = fakeCv().Mat;
            f(mod);
          };
          return mod;
        },
      };
      sc.cv = mod;
    });
    bootWorker(s, surface);
    const close = jest.fn();
    send({ seq: 1, op: 'load', bitmap: { width: 1, height: 1, close }, maxDecodeEdge: 4096 });
    expect(posted).toEqual([{ type: 'error', seq: 1, code: 'process_failed' }]);
    expect(close).toHaveBeenCalled();
    finish();
    expect(posted[1]).toEqual({ type: 'ready' });
  });
});
