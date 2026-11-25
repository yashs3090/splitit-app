// cv resize and the worker ops on the REAL OpenCV.js (@techstark/opencv-js 4.12, the same file
// the worker loads), under the jest-expo preset (spec Task 6: "Jest loads the real OpenCV").
// Inputs are synthetic (criterion 70).
import { loadOpenCv } from '../../../../test-utils/opencv';
import type { CvApi } from './cvApi';
import { createCvOps, type Rgba, type Surface } from './ops';
import { interpolationFor, resizeMat } from './resize';

let cv: CvApi;

// Loader shared with locate/warp tests (window + TextDecoder workaround documented there).
beforeAll(async () => {
  cv = (await loadOpenCv()).cv;
}, 60000);

/** A w×h RGBA image: left half black, right half white. */
function halves(w: number, h: number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < w / 2 ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

function fakeSurface(pixels: Rgba): Surface & { rasterized: [number, number][]; encoded: Rgba[] } {
  const s = {
    rasterized: [] as [number, number][],
    encoded: [] as Rgba[],
    rasterize(_b: unknown, w: number, h: number) {
      s.rasterized.push([w, h]);
      if (w !== pixels.width || h !== pixels.height) return halves(w, h);
      return pixels;
    },
    async encode(rgba: Rgba, type: string) {
      s.encoded.push(rgba);
      return new Blob([], { type });
    },
  };
  return s;
}

const bitmap = (width: number, height: number) => ({ width, height, close: jest.fn() });

describe('interpolationFor', () => {
  it('area going down, cubic going up, none at the same size', () => {
    expect(interpolationFor({ width: 400, height: 800 }, { width: 200, height: 400 })).toBe('area');
    expect(interpolationFor({ width: 400, height: 800 }, { width: 800, height: 1600 })).toBe('cubic');
    expect(interpolationFor({ width: 400, height: 800 }, { width: 400, height: 800 })).toBe('none');
  });
});

describe('resizeMat on real OpenCV 4.12', () => {
  it('exposes the names the worker uses, and getBuildInformation reports 4.12', () => {
    expect(typeof cv.resize).toBe('function');
    expect(cv.INTER_AREA).toBe(3);
    expect(cv.INTER_CUBIC).toBe(2);
    const info = (cv as unknown as { getBuildInformation(): string }).getBuildInformation();
    expect(info).toMatch(/General configuration for OpenCV 4\.12\.0/);
  });

  it('downscales with area averaging (a 2×2 block → its mean) and upscales to the exact size', () => {
    const src = new cv.Mat(2, 2, cv.CV_8UC1);
    src.data.set([0, 100, 200, 100]);
    const down = resizeMat(cv, src, 1, 1);
    expect([down.cols, down.rows]).toEqual([1, 1]);
    expect(down.data[0]).toBe(100); // INTER_AREA = the mean; nearest/linear would differ here
    const up = resizeMat(cv, src, 6, 6);
    expect([up.cols, up.rows]).toEqual([6, 6]);
    for (const m of [src, down, up]) m.delete();
  });

  it('same size → a copy that is a separate Mat', () => {
    const src = new cv.Mat(3, 4, cv.CV_8UC4);
    const out = resizeMat(cv, src, 4, 3);
    expect(out).not.toBe(src);
    expect([out.cols, out.rows]).toEqual([4, 3]);
    src.delete();
    out.delete();
  });

  it('rejects non-positive or fractional sizes', () => {
    const src = new cv.Mat(3, 4, cv.CV_8UC4);
    expect(() => resizeMat(cv, src, 0, 3)).toThrow(RangeError);
    expect(() => resizeMat(cv, src, 2.5, 3)).toThrow(RangeError);
    src.delete();
  });
});

describe('createCvOps on real OpenCV 4.12', () => {
  it('load → resize → encode → free, with sizes and pixels carried through', async () => {
    const surface = fakeSurface(halves(40, 80));
    const ops = createCvOps(cv, surface);
    const b = bitmap(40, 80);
    const loaded = ops.load(b, 4096);
    expect(loaded).toEqual({ id: 1, width: 40, height: 80, sourceWidth: 40, sourceHeight: 80 });
    expect(b.close).toHaveBeenCalledTimes(1);
    const small = ops.resize(loaded.id, 20, 40);
    expect(small).toEqual({ id: 2, width: 20, height: 40 });
    await ops.encode(small.id, 'png');
    const px = surface.encoded[0]!;
    expect([px.width, px.height, px.data.length]).toEqual([20, 40, 20 * 40 * 4]);
    // Left edge stays black, right edge white (area averaging keeps the halves apart).
    expect(px.data[0]).toBe(0);
    expect(px.data[(20 - 1) * 4]).toBe(255);
    ops.free([loaded.id, small.id, 999]);
    expect(ops.size()).toBe(0);
  });

  it('load caps the decode at maxDecodeEdge, keeping the aspect ratio and reporting the source size', () => {
    const surface = fakeSurface(halves(10, 10));
    const ops = createCvOps(cv, surface);
    const loaded = ops.load(bitmap(6000, 3000), 4096);
    expect(surface.rasterized).toEqual([[4096, 2048]]);
    expect(loaded).toMatchObject({ width: 4096, height: 2048, sourceWidth: 6000, sourceHeight: 3000 });
    ops.free([loaded.id]);
  });

  it('jpeg90 encodes with quality 0.9 (RECOGNITION_JPEG_COMPRESS); png with none', async () => {
    const encode = jest.fn(async () => new Blob());
    const ops = createCvOps(cv, { rasterize: (_b, w, h) => halves(w, h), encode });
    const { id } = ops.load(bitmap(8, 8), 4096);
    await ops.encode(id, 'jpeg90');
    await ops.encode(id, 'png');
    expect(encode.mock.calls.map((c: unknown[]) => c.slice(1))).toEqual([['image/jpeg', 0.9], ['image/png']]);
    ops.free([id]);
  });

  it('an unknown id fails the op', async () => {
    const ops = createCvOps(cv, fakeSurface(halves(2, 2)));
    expect(() => ops.resize(42, 2, 2)).toThrow(RangeError);
    await expect(ops.encode(42, 'png')).rejects.toThrow(RangeError);
  });
});
