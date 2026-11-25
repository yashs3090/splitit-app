// Criterion 34: with a fake `cv` that counts Mat create and delete, every worker op frees exactly
// what it allocates (apart from the image it hands to the store), on success and when a step throws.
import { countingCv as countingRealCv, grey, keystone, loadOpenCv, renderScene, rotatedRect, type Scene } from '../../../../test-utils/opencv';
import type { CvApi, CvMat } from './cvApi';
import { createCvOps, type Rgba, type Surface } from './ops';

type Counting = CvApi & { created: number; deleted: number; live(): number; failResize: boolean; failCvt: boolean };

function countingCv(): Counting {
  const cv = {
    created: 0,
    deleted: 0,
    failResize: false,
    failCvt: false,
    live: () => cv.created - cv.deleted,
  } as Counting;
  class Mat implements CvMat {
    rows: number;
    cols: number;
    type: number;
    data: Uint8Array;
    data32S = new Int32Array(0);
    private gone = false;
    constructor(rows = 0, cols = 0, type = 24) {
      this.rows = rows;
      this.cols = cols;
      this.type = type;
      this.data = new Uint8Array(rows * cols * (type === 0 ? 1 : 4));
      cv.created += 1;
    }
    channels() {
      return this.type === 0 ? 1 : 4;
    }
    clone() {
      const m = new Mat(this.rows, this.cols, this.type);
      m.data.set(this.data);
      return m;
    }
    delete() {
      if (this.gone) throw new Error('double delete');
      this.gone = true;
      cv.deleted += 1;
    }
  }
  (Mat as unknown as { zeros: (r: number, c: number, t: number) => Mat }).zeros = (r, c, t) => new Mat(r, c, t);
  Object.assign(cv, {
    Mat,
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
    resize(_s: CvMat, d: Mat, size: { width: number; height: number }) {
      if (cv.failResize) throw new Error('boom');
      d.rows = size.height;
      d.cols = size.width;
      d.data = new Uint8Array(size.width * size.height * 4);
    },
    cvtColor(s: CvMat, d: Mat) {
      if (cv.failCvt) throw new Error('boom');
      d.rows = s.rows;
      d.cols = s.cols;
      d.data = new Uint8Array(s.rows * s.cols * 4);
    },
  });
  return cv;
}

const surface = (over: Partial<Surface> = {}): Surface => ({
  rasterize: (_b, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  encode: async () => new Blob(),
  ...over,
});
const bitmap = (w = 8, h = 4) => ({ width: w, height: h, close: jest.fn() });

describe('worker ops free what they allocate (criterion 34)', () => {
  it('success: load + resize keep one Mat each in the store; free deletes them; nothing else is live', async () => {
    const cv = countingCv();
    const ops = createCvOps(cv, surface());
    const a = ops.load(bitmap(), 4096);
    const b = ops.resize(a.id, 4, 2);
    const c = ops.resize(a.id, 8, 4); // same size → a copy
    expect(cv.live()).toBe(3);
    await ops.encode(b.id, 'png');
    expect(cv.live()).toBe(3); // encoding an RGBA image allocates nothing
    ops.free([a.id, b.id, c.id]);
    expect(cv.live()).toBe(0);
    ops.free([a.id]); // twice: harmless
    expect(cv.deleted).toBe(3);
  });

  it('encoding a grey image frees its temporary RGBA Mat, on success and when cvtColor throws', async () => {
    const cv = countingCv();
    const ops = createCvOps(cv, surface());
    // A grey image in the store, as later tasks (enhance) will make.
    const { id } = ops.load(bitmap(), 4096);
    // Make the store's next image grey: a resize (to a new size, so cv.resize runs) whose output is 1-channel.
    const realResize = cv.resize;
    cv.resize = (_s, d, size) => {
      Object.assign(d, { rows: size.height, cols: size.width, type: 0, data: new Uint8Array(size.width * size.height) });
    };
    const g = ops.resize(id, 4, 2);
    cv.resize = realResize;
    const encoded: number[] = [];
    const before = cv.live();
    const created = cv.created;
    await ops.encode(g.id, 'jpeg90');
    encoded.push(cv.created - created);
    expect(encoded).toEqual([1]); // the grey path did allocate a temporary RGBA Mat...
    expect(cv.live()).toBe(before); // ...and freed it
    cv.failCvt = true;
    await expect(ops.encode(g.id, 'png')).rejects.toThrow('boom');
    expect(cv.live()).toBe(before);
    ops.free([id, g.id]);
    expect(cv.live()).toBe(0);
  });

  it('resize that throws frees its output Mat and stores nothing', () => {
    const cv = countingCv();
    const ops = createCvOps(cv, surface());
    const { id } = ops.load(bitmap(), 4096);
    cv.failResize = true;
    expect(() => ops.resize(id, 4, 2)).toThrow('boom');
    expect(cv.live()).toBe(1);
    expect(ops.size()).toBe(1);
    ops.free([id]);
    expect(cv.live()).toBe(0);
  });

  it('load that fails (drawing or copying) allocates nothing and still closes the bitmap', () => {
    const cv = countingCv();
    const b1 = bitmap();
    const ops = createCvOps(cv, surface({ rasterize: () => { throw new Error('draw'); } }));
    expect(() => ops.load(b1, 4096)).toThrow('draw');
    expect(b1.close).toHaveBeenCalledTimes(1);
    expect(cv.live()).toBe(0);

    const b2 = bitmap(8, 4);
    // Wrong pixel count: `data.set` throws after the Mat exists. (Matched by message: Jest's VM realm
    // gives typed-array errors a different `RangeError` constructor.)
    const ops2 = createCvOps(cv, surface({ rasterize: () => ({ data: new Uint8ClampedArray(9999), width: 8, height: 4 }) }));
    expect(() => ops2.load(b2, 4096)).toThrow(/out of bounds|offset/i);
    expect(b2.close).toHaveBeenCalledTimes(1);
    expect(cv.live()).toBe(0);
    expect(ops2.size()).toBe(0);
  });

  it('encode where the surface rejects leaves the store unchanged', async () => {
    const cv = countingCv();
    const ops = createCvOps(cv, surface({ encode: () => Promise.reject(new Error('enc')) }));
    const { id } = ops.load(bitmap(), 4096);
    await expect(ops.encode(id, 'png')).rejects.toThrow('enc');
    expect(cv.live()).toBe(1);
    ops.free([id]);
    expect(cv.live()).toBe(0);
  });
});

// ---------- locate and warp on the real OpenCV, counted (criterion 34, spec Task 7) ----------

describe('locate and warp free what they allocate, on the real OpenCV', () => {
  let real: CvApi;
  beforeAll(async () => {
    real = (await loadOpenCv()).cv;
  }, 60000);

  // Small scenes keep the every-call injection loop fast; one quad case and one mask case.
  const quadScene: Scene = {
    width: 300,
    height: 400,
    background: grey(70),
    paper: { quad: keystone(rotatedRect(150, 200, 180, 270, 10), 0.1), colour: grey(230) },
    noise: 4,
  };
  const maskScene: Scene = {
    width: 300,
    height: 400,
    background: [150, 60, 40],
    paper: { quad: rotatedRect(150, 200, 180, 270, 5), colour: grey(235), cornerRadius: 0.3 },
    noise: 4,
  };
  const surfaceFor = (rgba: Rgba): Surface => ({ rasterize: () => rgba, encode: async () => new Blob() });

  it.each([
    ['quad', quadScene],
    ['mask', maskScene],
  ] as const)('%s scene: locate allocates nothing that outlives it; warp stores exactly one Mat', (method, scene) => {
    const counting = countingRealCv(real);
    const ops = createCvOps(counting.cv, surfaceFor(renderScene(scene)));
    const { id } = ops.load({ width: scene.width, height: scene.height, close: () => {} }, 4096);
    expect(counting.live()).toBe(1);
    const loc = ops.locate(id);
    expect(loc.method).toBe(method);
    expect(counting.live()).toBe(1);
    const crop = ops.warp(id, loc.quad!, 0.025);
    expect(counting.live()).toBe(2);
    ops.free([id, crop.id]);
    expect(counting.live()).toBe(0);
  });

  it.each([
    ['quad', quadScene],
    ['mask', maskScene],
  ] as const)('%s scene: whichever OpenCV call throws, locate and warp leak nothing and store nothing', (_m, scene) => {
    const counting = countingRealCv(real);
    const ops = createCvOps(counting.cv, surfaceFor(renderScene(scene)));
    const { id } = ops.load({ width: scene.width, height: scene.height, close: () => {} }, 4096);
    const quad = ops.locate(id).quad!;
    for (const op of ['locate', 'warp'] as const) {
      const run = () => (op === 'locate' ? ops.locate(id) : ops.warp(id, quad, 0.025));
      // Count this op's calls once, then fail each one in turn.
      const start = counting.calls();
      const ok = run();
      if (op === 'warp') ops.free([(ok as { id: number }).id]);
      const n = counting.calls() - start;
      expect(n).toBeGreaterThan(5);
      for (let k = 1; k <= n; k++) {
        counting.failAt(counting.calls() + k);
        expect(run).toThrow('injected');
        counting.failAt(0);
        expect([op, k, counting.live()]).toEqual([op, k, 1]);
        expect(ops.size()).toBe(1);
      }
    }
    ops.free([id]);
    expect(counting.live()).toBe(0);
  });
});

// ---------- enhance on the real OpenCV, counted (criterion 34, spec Task 9) ----------

describe('enhance frees what it allocates, on the real OpenCV', () => {
  let real: CvApi;
  beforeAll(async () => {
    real = (await loadOpenCv()).cv;
  }, 60000);

  // A small paper with text rows under a lighting gradient, so every step (flatten included) runs.
  const scene: Scene = {
    width: 240,
    height: 320,
    background: (x) => grey(110 + (120 * x) / 239),
    paper: { quad: [[0, 0], [239, 0], [239, 319], [0, 319]], colour: grey(235) },
  };
  const steps = [
    { gray: true, flatten: false, clahe: false },
    { gray: true, flatten: { kernelLineHeights: 4 }, clahe: false },
    { gray: true, flatten: { kernelLineHeights: 4 }, clahe: { clipLimit: 2, tile: 8 } },
  ] as const;
  const surfaceFor = (rgba: Rgba): Surface => ({ rasterize: () => rgba, encode: async () => new Blob() });

  it.each(steps.map((s) => [JSON.stringify(s), s] as const))('%s: stores exactly one grey Mat of the same size; free leaves nothing', (_n, s) => {
    const counting = countingRealCv(real);
    const ops = createCvOps(counting.cv, surfaceFor(renderScene(scene)));
    const { id } = ops.load({ width: scene.width, height: scene.height, close: () => {} }, 4096);
    const out = ops.enhance(id, s);
    expect([out.width, out.height]).toEqual([scene.width, scene.height]);
    expect(out.greyLevels).toBeGreaterThan(16);
    if (s.flatten) expect(out.kernelPx).not.toBeNull();
    expect(counting.live()).toBe(2);
    ops.free([id, out.id]);
    expect(counting.live()).toBe(0);
  });

  it('whichever OpenCV call throws (flatten + CLAHE), enhance leaks nothing and stores nothing', () => {
    const counting = countingRealCv(real);
    const ops = createCvOps(counting.cv, surfaceFor(renderScene(scene)));
    const { id } = ops.load({ width: scene.width, height: scene.height, close: () => {} }, 4096);
    const s = steps[2];
    const start = counting.calls();
    const ok = ops.enhance(id, s);
    ops.free([ok.id]);
    const n = counting.calls() - start;
    expect(n).toBeGreaterThan(8);
    for (let k = 1; k <= n; k++) {
      counting.failAt(counting.calls() + k);
      expect(() => ops.enhance(id, s)).toThrow('injected');
      counting.failAt(0);
      expect([k, counting.live()]).toEqual([k, 1]);
      expect(ops.size()).toBe(1);
    }
    ops.free([id]);
    expect(counting.live()).toBe(0);
  });
});
