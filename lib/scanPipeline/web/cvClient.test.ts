// cvClient with a fake Worker (spec C4, criterion 33). Every ending: ready → results; op error →
// its code; no ready in time → terminate + CvUnavailable; abort → terminate + cancelled; a crash;
// an op that never answers; every created blob URL revoked.
import { RecognitionError } from '../../recognitionError';
import type { Quad } from '../types';
import type { CvBitmap, CvRequest, CvResponse } from './cv/protocol';
import { CV_LOAD_TIMEOUT_MS, CV_OP_TIMEOUT_MS, createCvClient, CvOpFailed, CvUnavailable, type WorkerLike } from './cvClient';

class FakeWorker implements WorkerLike {
  onmessage: ((event: { data: CvResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  sent: CvRequest[] = [];
  transfers: unknown[][] = [];
  terminate = jest.fn();
  /** Answer each request automatically. */
  auto: ((req: CvRequest) => CvResponse | null) | null = null;

  postMessage(message: CvRequest, transfer: unknown[] = []) {
    this.sent.push(message);
    this.transfers.push(transfer);
    const res = this.auto?.(message);
    if (res) queueMicrotask(() => this.emit(res));
  }
  emit(data: CvResponse) {
    this.onmessage?.({ data });
  }
}

const okAnswer = (req: CvRequest): CvResponse => {
  switch (req.op) {
    case 'load':
      return { type: 'result', seq: req.seq, value: { id: 1, width: 100, height: 50, sourceWidth: 100, sourceHeight: 50 } };
    case 'resize':
      return { type: 'result', seq: req.seq, value: { id: 2, width: req.width, height: req.height } };
    case 'locate':
      return { type: 'result', seq: req.seq, value: { method: 'quad', quad: QUAD, confidence: 0.9 } };
    case 'warp':
      return { type: 'result', seq: req.seq, value: { id: 3, width: 80, height: 40 } };
    case 'enhance':
      return { type: 'result', seq: req.seq, value: { id: 4, width: 80, height: 40, lineHeightPx: 12, kernelPx: 49, greyLevels: 200 } };
    case 'encode':
      return { type: 'result', seq: req.seq, value: new Blob(['x']) };
    case 'rowInk':
      return { type: 'result', seq: req.seq, value: new Uint32Array([0, 3, 0]) };
    case 'free':
      return { type: 'result', seq: req.seq, value: null };
  }
};

const QUAD: Quad = [
  [1, 2],
  [90, 3],
  [91, 45],
  [2, 44],
];

let workers: FakeWorker[];
let created: string[];
let revoked: string[];
let bitmaps: (CvBitmap & { close: jest.Mock })[];

type Answer = (req: CvRequest) => CvResponse | null;

function setup(opts: { decode?: () => Promise<CvBitmap>; autoReady?: boolean; answer?: Answer | null } = {}) {
  const { autoReady = true, answer = okAnswer } = opts;
  let n = 0;
  return createCvClient({
    createWorker: (url) => {
      const w = new FakeWorker();
      w.auto = answer;
      workers.push(w);
      expect(url).toBe('/opencv/receipt-cv-worker.js');
      if (autoReady) queueMicrotask(() => w.emit({ type: 'ready' }));
      return w;
    },
    decode:
      opts.decode ??
      (async () => {
        const b = { width: 100, height: 50, close: jest.fn() };
        bitmaps.push(b);
        return b;
      }),
    createObjectURL: () => {
      const u = `blob:cv-${++n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u) => revoked.push(u),
  });
}

beforeEach(() => {
  workers = [];
  created = [];
  revoked = [];
  bitmaps = [];
});
afterEach(() => {
  jest.useRealTimers();
});

describe('cvClient', () => {
  it('starts no worker until the first call (nothing before a scan)', () => {
    const c = setup();
    expect(workers).toHaveLength(0);
    expect(c.started).toBe(false);
    c.close();
    expect(workers).toHaveLength(0);
  });

  it('rowInk (Task 12) sends the held id and resolves the profile; abort cancels it like any op', async () => {
    const c = setup();
    await c.load('blob:photo');
    expect([...(await c.rowInk(1))]).toEqual([0, 3, 0]);
    expect(workers[0]!.sent.at(-1)).toMatchObject({ op: 'rowInk', id: 1 });
    const ac = new AbortController();
    ac.abort();
    await expect(c.rowInk(1, ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0]!.terminate).toHaveBeenCalled();
    c.close();
  });

  it('ready → load (bitmap transferred), resize, encode resolve; close terminates and revokes every URL', async () => {
    const c = setup();
    const loaded = await c.load('blob:photo');
    expect(loaded).toEqual({ id: 1, width: 100, height: 50, sourceWidth: 100, sourceHeight: 50 });
    const w = workers[0]!;
    expect(w.sent[0]).toMatchObject({ op: 'load', maxDecodeEdge: 4096 });
    expect(w.transfers[0]).toEqual([bitmaps[0]]);
    expect(await c.resize(1, 50, 25)).toEqual({ id: 2, width: 50, height: 25 });
    const u1 = await c.encode(2, 'png');
    const u2 = await c.encode(2, 'jpeg90');
    expect(w.sent.map((r) => r.op)).toEqual(['load', 'resize', 'encode', 'encode']);
    c.revoke(u1);
    expect(revoked).toEqual([u1]);
    c.free([1, 2]);
    await new Promise((r) => setTimeout(r, 0));
    expect(w.sent.at(-1)).toMatchObject({ op: 'free', ids: [1, 2] });
    c.close();
    c.close();
    expect(w.terminate).toHaveBeenCalledTimes(1);
    expect(revoked.sort()).toEqual([...created].sort());
    expect(revoked).toContain(u2);
    await expect(c.resize(2, 1, 1)).rejects.toBeInstanceOf(CvUnavailable);
  });

  it('locate and warp (Task 7): the request carries the id, quad and margin; results resolve', async () => {
    const c = setup();
    await c.load('blob:photo');
    expect(await c.locate(1)).toEqual({ method: 'quad', quad: QUAD, confidence: 0.9 });
    expect(await c.warp(1, QUAD, 0.025)).toEqual({ id: 3, width: 80, height: 40 });
    const w = workers[0]!;
    expect(w.sent[1]).toMatchObject({ op: 'locate', id: 1 });
    expect(w.sent[2]).toMatchObject({ op: 'warp', id: 1, quad: QUAD, marginFraction: 0.025 });
    c.close();
  });

  it('enhance (Task 9): the request carries the id and steps; the result resolves; an op error rejects with its code', async () => {
    const steps = { gray: true, flatten: { kernelLineHeights: 4 }, clahe: false as const };
    const c = setup();
    await c.load('blob:photo');
    expect(await c.enhance(1, steps)).toEqual({ id: 4, width: 80, height: 40, lineHeightPx: 12, kernelPx: 49, greyLevels: 200 });
    expect(workers[0]!.sent[1]).toMatchObject({ op: 'enhance', id: 1, steps });
    c.close();
    const bad = setup({ answer: (req) => (req.op === 'enhance' ? { type: 'error', seq: req.seq, code: 'process_failed' } : okAnswer(req)) });
    await bad.load('blob:photo');
    await expect(bad.enhance(1, steps)).rejects.toMatchObject({ name: 'CvOpFailed', code: 'process_failed' });
    bad.close();
  });

  it('abort during enhance → terminate and cancelled', async () => {
    const c = setup({ answer: (req) => (req.op === 'enhance' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    const ac = new AbortController();
    const p = c.enhance(1, { gray: true, flatten: false, clahe: false }, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0]!.terminate).toHaveBeenCalled();
    c.close();
  });

  it('abort during locate → terminate and cancelled', async () => {
    const c = setup({ answer: (req) => (req.op === 'locate' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    const ac = new AbortController();
    const p = c.locate(1, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    c.close();
  });

  it('an op error rejects with the worker code; the worker stays up', async () => {
    const c = setup({ answer: (req) => (req.op === 'resize' ? { type: 'error', seq: req.seq, code: 'process_failed' } : okAnswer(req)) });
    await c.load('blob:photo');
    const e = await c.resize(1, 2, 2).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CvOpFailed);
    expect((e as CvOpFailed).code).toBe('process_failed');
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await expect(c.encode(1, 'png')).resolves.toMatch(/^blob:cv-/);
    c.close();
  });

  it('start-up error (opencv.js failed to load) → terminate and CvUnavailable, now and later', async () => {
    const c = createCvClient({
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        queueMicrotask(() => w.emit({ type: 'error', seq: null, code: 'load_failed' }));
        return w;
      },
      decode: async () => ({ width: 1, height: 1, close: jest.fn() }),
    });
    await expect(c.load('blob:photo')).rejects.toBeInstanceOf(CvUnavailable);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    await expect(c.resize(1, 1, 1)).rejects.toBeInstanceOf(CvUnavailable);
  });

  it('a worker error event (script 404) before ready → terminate and CvUnavailable', async () => {
    const c = setup({ autoReady: false });
    const p = c.load('blob:photo');
    await Promise.resolve();
    workers[0]!.onerror?.({});
    await expect(p).rejects.toBeInstanceOf(CvUnavailable);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it(`no ready within CV_LOAD_TIMEOUT_MS (${CV_LOAD_TIMEOUT_MS} ms) → terminate and CvUnavailable; the decoded bitmap is closed`, async () => {
    jest.useFakeTimers();
    const c = setup({ autoReady: false });
    const p = c.load('blob:photo');
    p.catch(() => {});
    await jest.advanceTimersByTimeAsync(CV_LOAD_TIMEOUT_MS - 1);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toBeInstanceOf(CvUnavailable);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(bitmaps[0]!.close).toHaveBeenCalled();
  });

  it(`an op that never answers within CV_OP_TIMEOUT_MS → terminate and CvUnavailable`, async () => {
    const c = setup({ answer: (req) => (req.op === 'resize' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    jest.useFakeTimers();
    const p = c.resize(1, 2, 2);
    p.catch(() => {});
    await jest.advanceTimersByTimeAsync(CV_OP_TIMEOUT_MS - 1);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toBeInstanceOf(CvUnavailable);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('a crash after ready rejects the pending op with CvUnavailable', async () => {
    const c = setup({ answer: (req) => (req.op === 'encode' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    const p = c.encode(1, 'png');
    await Promise.resolve();
    workers[0]!.onerror?.({});
    await expect(p).rejects.toBeInstanceOf(CvUnavailable);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('abort before ready → terminate and cancelled', async () => {
    const c = setup({ autoReady: false });
    const ac = new AbortController();
    const p = c.load('blob:photo', ac.signal);
    await Promise.resolve();
    ac.abort();
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecognitionError);
    expect((e as RecognitionError).code).toBe('cancelled');
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('abort during an op → terminate and cancelled; an already-aborted signal never starts a worker', async () => {
    const c = setup({ answer: (req) => (req.op === 'resize' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    const ac = new AbortController();
    const p = c.resize(1, 2, 2, ac.signal);
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);

    const c2 = setup();
    const done = new AbortController();
    done.abort();
    await expect(c2.load('blob:photo', done.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(workers).toHaveLength(1);
  });

  it('a photo that fails to decode → CvOpFailed(decode_failed), worker left usable', async () => {
    const c = setup({ decode: () => Promise.reject(new Error('bad /private/path.jpg')) });
    const e = await c.load('blob:photo').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CvOpFailed);
    expect((e as CvOpFailed).code).toBe('decode_failed');
    expect((e as Error).message).not.toMatch(/path/);
    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    c.close();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('an encode that finishes after close revokes nothing new and rejects', async () => {
    const c = setup({ answer: (req) => (req.op === 'encode' ? null : okAnswer(req)) });
    await c.load('blob:photo');
    const p = c.encode(1, 'png');
    await Promise.resolve();
    c.close();
    await expect(p).rejects.toBeInstanceOf(CvUnavailable);
    expect(created).toEqual([]);
  });
});
