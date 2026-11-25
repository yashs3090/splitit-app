// Row-ink profile (spec Task 12) on synthetic pages, and on the REAL OpenCV.js 4.12 for the worker op
// (grey conversion, Mat accounting: criterion 34). Every input is synthetic (criterion 70).
import { countingCv, loadOpenCv } from '../../../../test-utils/opencv';
import { renderTallPage } from '../../../../test-utils/tallReceipt';
import type { CvApi, CvMat } from './cvApi';
import { createCvOps, type Surface } from './ops';
import { ROW_INK_SIDE_MARGIN, ROW_BAND_MIN_PX, ROW_INK_DARKNESS, ROW_INK_MAX_SHADOW, rowInkFromGray, rowInkMat } from './rowInk';

describe('rowInkFromGray', () => {
  it('counts, per row, the pixels more than 40 levels darker than the band\'s paper', () => {
    // 100 × 40 paper at 200; row 10 has 30 pixels at 159 (41 darker: ink) and 20 at 160 (exactly 40: not ink).
    const w = 100;
    const h = 40;
    const g = new Uint8Array(w * h).fill(200);
    for (let x = 10; x < 40; x++) g[10 * w + x] = 159;
    for (let x = 40; x < 60; x++) g[10 * w + x] = 160;
    const ink = rowInkFromGray(g, w, h);
    expect(ROW_INK_DARKNESS).toBe(40);
    expect(ROW_INK_SIDE_MARGIN).toBe(0.05);
    expect(ink[10]).toBe(30);
    expect([...ink].filter((n, y) => y !== 10 && n !== 0)).toEqual([]);
  });

  it('follows paper that darkens down the page (a shadow), so shadowed gaps stay blank and shadowed text stays ink', () => {
    const page = renderTallPage({ paper: 235, paperGradient: -ROW_INK_MAX_SHADOW, noise: 4 });
    const ink = rowInkFromGray(page.gray, page.width, page.height);
    const last = page.rows[page.rows.length - 1]!;
    // The last gap and the last text row are in the darkest band.
    expect(ink[last.top - 3]).toBe(0);
    expect(ink[last.top + 10]!).toBeGreaterThan(page.width * 0.02);
  });

  it('a sliver of table down the sides of a crop (outer 5%) does not count, so the gaps between rows stay blank', () => {
    const page = renderTallPage({ width: 600, height: 3000 });
    for (let y = 0; y < page.height; y++) for (let x = 0; x < 4; x++) {
      page.gray[y * page.width + x] = 50;
      page.gray[y * page.width + page.width - 1 - x] = 50;
    }
    const ink = rowInkFromGray(page.gray, page.width, page.height);
    expect(ink[page.rows[3]!.top - 3]).toBe(0);
    expect(ink[page.rows[3]!.top + 10]!).toBeGreaterThan(0);
  });

  it('a band that is mostly ink (a solid block) counts as ink, never as blank', () => {
    const page = renderTallPage({ solidBlock: [1000, 1400] });
    const ink = rowInkFromGray(page.gray, page.width, page.height);
    for (let y = 1000; y < 1400; y++) expect(ink[y]!).toBeGreaterThan(page.width * 0.5);
  });

  it('works on bands shorter than the minimum at the bottom edge, and rejects a too-short buffer', () => {
    const w = 10;
    const h = ROW_BAND_MIN_PX + 3;
    expect(rowInkFromGray(new Uint8Array(w * h).fill(220), w, h)).toHaveLength(h);
    expect(() => rowInkFromGray(new Uint8Array(5), 10, 10)).toThrow(RangeError);
  });
});

describe('rowInkMat / the rowInk op on the real OpenCV', () => {
  let cv: CvApi;
  beforeAll(async () => {
    cv = (await loadOpenCv()).cv;
  }, 60000);

  /** The page as an RGBA Mat (grey in R, G and B). */
  function rgbaMat(api: CvApi, gray: Uint8Array, w: number, h: number): CvMat {
    const m = new api.Mat(h, w, api.CV_8UC4);
    const d = m.data;
    for (let i = 0; i < w * h; i++) {
      const v = gray[i] as number;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    return m;
  }

  it('an RGBA image gives the same profile as its grey pixels, and a grey Mat is read as-is', () => {
    const page = renderTallPage({ width: 200, height: 1200, lineH: 14, pitch: 22 });
    const m = rgbaMat(cv, page.gray, page.width, page.height);
    try {
      expect([...rowInkMat(cv, m)]).toEqual([...rowInkFromGray(page.gray, page.width, page.height)]);
    } finally {
      m.delete();
    }
    const g = new cv.Mat(page.height, page.width, cv.CV_8UC1);
    try {
      g.data.set(page.gray);
      expect([...rowInkMat(cv, g)]).toEqual([...rowInkFromGray(page.gray, page.width, page.height)]);
    } finally {
      g.delete();
    }
  });

  it('frees every Mat it makes, on success and when the grey conversion throws (criterion 34)', () => {
    const page = renderTallPage({ width: 120, height: 600, lineH: 10, pitch: 16 });
    const counting = countingCv(cv);
    const src = rgbaMat(cv, page.gray, page.width, page.height);
    try {
      const before = counting.live();
      rowInkMat(counting.cv, src);
      expect(counting.live()).toBe(before);
      counting.failAt(counting.calls() + 2); // the cvtColor after `new Mat()`
      expect(() => rowInkMat(counting.cv, src)).toThrow('injected');
      expect(counting.live()).toBe(before);
    } finally {
      src.delete();
    }
  });

  it('the worker op answers a held image\'s profile and keeps the store unchanged', () => {
    const surface: Surface = {
      rasterize: (_b, width, height) => {
        const page = renderTallPage({ width, height, lineH: 10, pitch: 16 });
        const data = new Uint8ClampedArray(width * height * 4);
        page.gray.forEach((v, i) => data.set([v, v, v, 255], i * 4));
        return { data, width, height };
      },
      encode: async () => new Blob([]),
    };
    const ops = createCvOps(cv, surface);
    const img = ops.load({ width: 120, height: 600, close: () => {} }, 4096);
    const ink = ops.rowInk(img.id);
    expect(ink).toHaveLength(600);
    expect(ink.some((n) => n > 0)).toBe(true);
    expect(ops.size()).toBe(1);
    ops.free([img.id]);
    expect(ops.size()).toBe(0);
    expect(() => ops.rowInk(img.id)).toThrow(RangeError);
  });
});
