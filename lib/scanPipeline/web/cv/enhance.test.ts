// enhance on web (spec Task 9, criteria 42, 43 and 70) on the REAL OpenCV.js 4.12.
// Every input is synthetic (criterion 70): rows of dark "glyph" strokes on paper, under a lighting
// gradient, a shadow band, or faded to low contrast. Nothing here comes from a receipt photo.
import { loadOpenCv, prng } from '../../../../test-utils/opencv';
import { ENHANCE_CLAHE, FLATTEN_KERNEL_LINE_HEIGHTS, VARIANTS } from '../../config';
import type { CvApi, CvMat } from './cvApi';
import {
  BACKGROUND_PX_PER_LINE,
  DEFAULT_KERNEL_LINE_HEIGHTS,
  enhanceMat,
  estimateLineHeight,
  flattenBackground,
  greyLevels,
  MIN_TEXT_RUNS,
  PROFILE_STRIPS,
  PROFILE_TEXT_LEVEL,
  type EnhanceSteps,
} from './enhance';

let cv: CvApi;
beforeAll(async () => {
  cv = (await loadOpenCv()).cv;
}, 60000);

type Page = {
  w: number;
  h: number;
  /** Paper brightness at (x, y), before ink. */
  paper: (x: number, y: number) => number;
  /** Ink brightness at (x, y) (absolute), or a fraction of the paper with `inkRatio`. */
  ink?: number;
  inkRatio?: number;
  lineH?: number;
  pitch?: number;
  noise?: number;
  lines?: number;
};

/**
 * A grey "page": `lines` text rows of height `lineH` every `pitch` px. Each row holds 3-px vertical
 * strokes with gaps (glyph-like), from 10% to 90% of the width. Returns pixels and an ink mask.
 */
function page(p: Page): { data: Uint8Array; ink: Uint8Array; w: number; h: number } {
  const { w, h, lineH = 12, pitch = 30, noise = 0 } = p;
  const lines = p.lines ?? Math.floor((h - 20) / pitch);
  const rand = prng(3);
  const data = new Uint8Array(w * h);
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.floor((y - 10) / pitch);
    const inRow = y >= 10 && row < lines && (y - 10) % pitch < lineH;
    for (let x = 0; x < w; x++) {
      const bg = p.paper(x, y);
      const stroke = inRow && x > w * 0.1 && x < w * 0.9 && x % 7 < 3;
      let v = stroke ? (p.inkRatio !== undefined ? bg * p.inkRatio : (p.ink ?? 30)) : bg;
      if (noise) v += (rand() * 2 - 1) * noise;
      data[y * w + x] = Math.max(0, Math.min(255, Math.round(v)));
      ink[y * w + x] = stroke ? 1 : 0;
    }
  }
  return { data, ink, w, h };
}

function grayMat(pg: { data: Uint8Array; w: number; h: number }): CvMat {
  const m = new cv.Mat(pg.h, pg.w, cv.CV_8UC1);
  m.data.set(pg.data);
  return m;
}

/** Mean and standard deviation of `data` where `pick` is true. */
function stats(data: ArrayLike<number>, pick: (i: number) => boolean) {
  let n = 0;
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    if (!pick(i)) continue;
    const v = data[i]!;
    n += 1;
    s += v;
    s2 += v * v;
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), n };
}

/** Background pixels: not ink and not next to ink (so stroke edges don't count). */
const background = (pg: { ink: Uint8Array; w: number }) => (i: number) =>
  !pg.ink[i] && !pg.ink[i - 1] && !pg.ink[i + 1] && !pg.ink[i - pg.w] && !pg.ink[i + pg.w];

const gradient = (x: number, w: number) => 120 + (120 * x) / (w - 1);

describe('estimateLineHeight (projection profile; feeds the flatten kernel)', () => {
  it('finds the text-row height on even paper, and under a strong left-to-right lighting gradient', () => {
    const flat = page({ w: 600, h: 400, paper: () => 230, lineH: 12 });
    expect(estimateLineHeight(flat.data, flat.w, flat.h)).toBe(12);
    const lit = page({ w: 600, h: 400, paper: (x) => gradient(x, 600), lineH: 12, noise: 3 });
    expect(estimateLineHeight(lit.data, lit.w, lit.h)).toBeGreaterThanOrEqual(11);
    expect(estimateLineHeight(lit.data, lit.w, lit.h)).toBeLessThanOrEqual(13);
  });

  it('scales with the text, never a fixed size: rows twice as tall → twice the estimate', () => {
    const a = page({ w: 600, h: 600, paper: () => 230, lineH: 10, pitch: 24 });
    const b = page({ w: 600, h: 600, paper: () => 230, lineH: 20, pitch: 48 });
    expect(estimateLineHeight(b.data, b.w, b.h)).toBe(2 * estimateLineHeight(a.data, a.w, a.h)!);
  });

  it('faded low-contrast text (ink 200 on paper 230, noise ±3) is still measured', () => {
    const pg = page({ w: 600, h: 400, paper: () => 230, ink: 200, noise: 3 });
    const lh = estimateLineHeight(pg.data, pg.w, pg.h);
    expect(lh).toBeGreaterThanOrEqual(11);
    expect(lh).toBeLessThanOrEqual(13);
  });

  it(`null for blank paper, and for fewer than MIN_TEXT_RUNS (${MIN_TEXT_RUNS}) text rows in all strips together`, () => {
    const blank = page({ w: 600, h: 400, paper: () => 230, lines: 0, noise: 3 });
    expect(estimateLineHeight(blank.data, blank.w, blank.h)).toBeNull();
    // One text row: one run per strip, but the strips are pooled; a single row in 1 strip only.
    const one = page({ w: 600, h: 400, paper: (x) => 230 + (x > 150 ? 0 : 0), lines: 1 });
    // Keep the row's ink to the first strip only: (MIN_TEXT_RUNS − 1) runs at most.
    const narrow = new Uint8Array(one.data);
    for (let y = 0; y < one.h; y++) for (let x = Math.floor(one.w / PROFILE_STRIPS); x < one.w; x++) narrow[y * one.w + x] = 230;
    expect(estimateLineHeight(narrow, one.w, one.h)).toBeNull();
    expect(estimateLineHeight(new Uint8Array(4), 2, 2)).toBeNull();
  });

  it(`rows whose top band is only sparse ascenders: PROFILE_TEXT_LEVEL (${PROFILE_TEXT_LEVEL}) keeps whole rows`, () => {
    // 20-px rows every 36 px: the top 8 px hold a stroke every 35 px (ascenders), the bottom 12 px a
    // stroke every 7 px (x-height). A midpoint threshold would measure only the 12-px x-height band.
    const w = 700;
    const h = 600;
    const data = new Uint8Array(w * h).fill(230);
    for (let y = 0; y < h; y++) {
      const row = Math.floor((y - 10) / 36);
      const k = (y - 10) % 36;
      if (y < 10 || k >= 20) continue;
      const ink = row >= 0 ? 30 : 230;
      for (let x = 50; x < 650; x++) {
        const on = k < 8 ? x % 35 < 3 : x % 7 < 3;
        if (on) data[y * w + x] = ink;
      }
    }
    expect(estimateLineHeight(data, w, h)).toBeGreaterThanOrEqual(18);
    expect(estimateLineHeight(data, w, h)).toBeLessThanOrEqual(21);
  });

  it('a small skew does not merge rows: the strips keep each row separate', () => {
    // Rows tilted by 3° (shift of ~31 px over 600 px, more than one gap of 18 px).
    const w = 600;
    const h = 500;
    const data = new Uint8Array(w * h).fill(230);
    const tilt = Math.tan((3 * Math.PI) / 180);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const yy = y - x * tilt;
        const inRow = yy >= 10 && (yy - 10) % 30 < 12;
        if (inRow && x % 7 < 3 && x > 60 && x < 540) data[y * w + x] = 30;
      }
    const lh = estimateLineHeight(data, w, h)!;
    expect(lh).toBeGreaterThanOrEqual(11);
    expect(lh).toBeLessThanOrEqual(16);
  });
});

describe('flattenBackground', () => {
  it('criterion 42: left-to-right gradient 120→240 with dark 3-px strokes: background std falls ≥ 50%, strokes stay darker than the background everywhere', () => {
    const pg = page({ w: 800, h: 500, paper: (x) => gradient(x, 800), ink: 30 });
    const src = grayMat(pg);
    const out = flattenBackground(cv, src, 12, DEFAULT_KERNEL_LINE_HEIGHTS);
    try {
      const bgPick = background(pg);
      const before = stats(pg.data, bgPick);
      const after = stats(out.mat.data, bgPick);
      expect(after.std).toBeLessThanOrEqual(0.5 * before.std);
      // "Everywhere": in every 40-px column band, the lightest stroke pixel is darker than the darkest background pixel.
      for (let x0 = 0; x0 < pg.w; x0 += 40) {
        let maxInk = -1;
        let minBg = 256;
        for (let y = 0; y < pg.h; y++)
          for (let x = x0; x < Math.min(pg.w, x0 + 40); x++) {
            const i = y * pg.w + x;
            if (pg.ink[i]) maxInk = Math.max(maxInk, out.mat.data[i]!);
            else if (bgPick(i)) minBg = Math.min(minBg, out.mat.data[i]!);
          }
        if (maxInk >= 0) expect([x0, maxInk < minBg]).toEqual([x0, true]);
      }
      expect([out.mat.cols, out.mat.rows]).toEqual([pg.w, pg.h]);
    } finally {
      src.delete();
      out.mat.delete();
    }
  });

  it('a shadow band across the page (rows 40–65% at 55% light) is evened out; the strokes inside it stay dark', () => {
    const shade = (y: number) => (y > 200 && y < 325 ? 0.55 : 1);
    const pg = page({ w: 600, h: 500, paper: (_x, y) => 225 * shade(y), inkRatio: 0.2, noise: 2 });
    const src = grayMat(pg);
    const out = flattenBackground(cv, src, 12, DEFAULT_KERNEL_LINE_HEIGHTS);
    try {
      const bgPick = background(pg);
      const inBand = (i: number) => {
        const y = Math.floor(i / pg.w);
        return y > 215 && y < 310;
      };
      const outBand = (i: number) => {
        const y = Math.floor(i / pg.w);
        return y < 185 || y > 340;
      };
      const bandBefore = stats(pg.data, (i) => bgPick(i) && inBand(i)).mean;
      const restBefore = stats(pg.data, (i) => bgPick(i) && outBand(i)).mean;
      const bandAfter = stats(out.mat.data, (i) => bgPick(i) && inBand(i)).mean;
      const restAfter = stats(out.mat.data, (i) => bgPick(i) && outBand(i)).mean;
      expect(restBefore - bandBefore).toBeGreaterThan(90);
      expect(Math.abs(restAfter - bandAfter)).toBeLessThan(10);
      const inkBand = stats(out.mat.data, (i) => pg.ink[i] === 1 && inBand(i)).mean;
      expect(bandAfter - inkBand).toBeGreaterThan(150);
    } finally {
      src.delete();
      out.mat.delete();
    }
  });

  it('the kernel is DEFAULT_KERNEL_LINE_HEIGHTS × the line height (odd), not a fixed pixel size', () => {
    const pg = page({ w: 300, h: 300, paper: () => 220 });
    const src = grayMat(pg);
    try {
      const a = flattenBackground(cv, src, 10, DEFAULT_KERNEL_LINE_HEIGHTS);
      const b = flattenBackground(cv, src, 20, DEFAULT_KERNEL_LINE_HEIGHTS);
      expect(a.kernelPx).toBe(41);
      expect(b.kernelPx).toBe(81);
      a.mat.delete();
      b.mat.delete();
    } finally {
      src.delete();
    }
  });

  it(`why ${DEFAULT_KERNEL_LINE_HEIGHTS} line heights: a kernel under one line height takes the ink for background and washes the strokes out`, () => {
    // Solid ink rows (no gaps): only a kernel taller than the row can see past them.
    const w = 400;
    const h = 300;
    const pg = page({ w, h, paper: () => 220, ink: 40 });
    for (let i = 0; i < pg.data.length; i++) {
      const y = Math.floor(i / w);
      const x = i % w;
      const inRow = y >= 10 && (y - 10) % 30 < 12 && x > 40 && x < 360;
      pg.data[i] = inRow ? 40 : 220;
      pg.ink[i] = inRow ? 1 : 0;
    }
    const src = grayMat(pg);
    try {
      const good = flattenBackground(cv, src, 12, DEFAULT_KERNEL_LINE_HEIGHTS);
      const bad = flattenBackground(cv, src, 12, 0.5);
      const inkGood = stats(good.mat.data, (i) => pg.ink[i] === 1).mean;
      const inkBad = stats(bad.mat.data, (i) => pg.ink[i] === 1).mean;
      expect(inkGood).toBeLessThan(80);
      // Ink drawn at 40 comes out above 120: most of its contrast went into the "background".
      expect(inkBad).toBeGreaterThan(120);
      good.mat.delete();
      bad.mat.delete();
    } finally {
      src.delete();
    }
  });

  it(`works at reduced resolution (BACKGROUND_PX_PER_LINE = ${BACKGROUND_PX_PER_LINE}) without moving the shadow edge by more than a line`, () => {
    // A hard vertical shadow edge at x = 300: left half at 50% light.
    const pg = page({ w: 600, h: 400, paper: (x) => (x < 300 ? 110 : 220), ink: 20, lineH: 16, pitch: 40 });
    const src = grayMat(pg);
    const out = flattenBackground(cv, src, 16, DEFAULT_KERNEL_LINE_HEIGHTS);
    try {
      const bgPick = background(pg);
      const away = (i: number) => Math.abs((i % pg.w) - 300) > 16;
      const left = stats(out.mat.data, (i) => bgPick(i) && away(i) && i % pg.w < 300).mean;
      const right = stats(out.mat.data, (i) => bgPick(i) && away(i) && i % pg.w > 300).mean;
      expect(Math.abs(left - right)).toBeLessThan(12);
    } finally {
      src.delete();
      out.mat.delete();
    }
  });
});

describe('enhanceMat', () => {
  function rgbaOf(pg: { data: Uint8Array; w: number; h: number }): CvMat {
    const m = new cv.Mat(pg.h, pg.w, cv.CV_8UC4);
    for (let i = 0; i < pg.data.length; i++) {
      const v = pg.data[i]!;
      m.data.set([v, v, v, 255], i * 4);
    }
    return m;
  }
  const all: [string, EnhanceSteps][] = [
    ['gray', { gray: true, flatten: false, clahe: false }],
    ['flatten', { gray: true, flatten: { kernelLineHeights: 4 }, clahe: false }],
    ['flatten+clahe', { gray: true, flatten: { kernelLineHeights: 4 }, clahe: { clipLimit: 2, tile: 8 } }],
    ['clahe', { gray: true, flatten: false, clahe: { clipLimit: 2, tile: 8 } }],
  ];

  it('gray is luma (BT.601): an RGB pixel (200, 100, 50) → 124', () => {
    const m = new cv.Mat(4, 4, cv.CV_8UC4);
    for (let i = 0; i < 16; i++) m.data.set([200, 100, 50, 255], i * 4);
    const r = enhanceMat(cv, m, all[0]![1]);
    try {
      expect(r.mat.channels()).toBe(1);
      expect(r.mat.data[0]).toBe(124);
    } finally {
      m.delete();
      r.mat.delete();
    }
  });

  it.each(all)('%s: never changes geometry, 8-bit grey, never binary (> 16 grey levels; criterion 43)', (_n, steps) => {
    const pg = page({ w: 500, h: 400, paper: (x) => gradient(x, 500), ink: 40, noise: 2 });
    const src = rgbaOf(pg);
    const r = enhanceMat(cv, src, steps);
    try {
      expect([r.mat.cols, r.mat.rows, r.mat.channels()]).toEqual([500, 400, 1]);
      expect(r.greyLevels).toBeGreaterThan(16);
      expect(r.greyLevels).toBe(greyLevels(r.mat));
      if (steps.flatten) {
        expect(r.lineHeightPx).toBe(12);
        expect(r.kernelPx).toBe(49);
      } else expect(r.kernelPx).toBeNull();
    } finally {
      src.delete();
      r.mat.delete();
    }
  });

  it('criterion 43: every enhance setting in VARIANTS keeps > 16 grey levels on the synthetic page', () => {
    const settings = Object.values(VARIANTS).flatMap((v) => (v.config.enhance === false ? [] : [v.config.enhance]));
    expect(settings.length).toBeGreaterThan(0);
    const pg = page({ w: 500, h: 400, paper: (x) => gradient(x, 500), ink: 40, noise: 2 });
    const src = rgbaOf(pg);
    try {
      for (const s of settings) {
        const r = enhanceMat(cv, src, s);
        expect(r.greyLevels).toBeGreaterThan(16);
        r.mat.delete();
      }
    } finally {
      src.delete();
    }
  });

  it('faded low-contrast text (ink 200 on paper 230): flatten keeps the contrast, gentle CLAHE (clip 2) raises it without turning the paper into texture', () => {
    const pg = page({ w: 600, h: 480, paper: () => 230, ink: 200, noise: 2 });
    const src = grayMat(pg);
    const flat = enhanceMat(cv, src, all[1]![1]);
    const both = enhanceMat(cv, src, all[2]![1]);
    try {
      const bgPick = background(pg);
      const contrast = (d: ArrayLike<number>) => stats(d, bgPick).mean - stats(d, (i) => pg.ink[i] === 1).mean;
      const c0 = contrast(pg.data);
      const c1 = contrast(flat.mat.data);
      const c2 = contrast(both.mat.data);
      expect(c1).toBeGreaterThanOrEqual(c0);
      // Clip 2 is gentle: a measurable rise (≥ 10%), not a stretch to black and white.
      expect(c2).toBeGreaterThan(c1 * 1.1);
      // Gentle: the paper stays light and even.
      expect(stats(both.mat.data, bgPick).mean).toBeGreaterThan(200);
      expect(stats(both.mat.data, bgPick).std).toBeLessThan(15);
    } finally {
      src.delete();
      flat.mat.delete();
      both.mat.delete();
    }
  });

  it('no measurable text (blank paper): flatten is skipped, the image is still grey', () => {
    const pg = page({ w: 200, h: 200, paper: () => 230, lines: 0 });
    const src = grayMat(pg);
    const r = enhanceMat(cv, src, all[1]![1]);
    try {
      expect(r.lineHeightPx).toBeNull();
      expect(r.kernelPx).toBeNull();
      expect(r.mat.data[0]).toBe(230);
    } finally {
      src.delete();
      r.mat.delete();
    }
  });
});

describe('config agrees with this module', () => {
  it('the variants\' flatten kernel is the documented starting value, CLAHE is clip 2 / 8 tiles, and every enhance setting is grey', () => {
    expect(FLATTEN_KERNEL_LINE_HEIGHTS).toBe(DEFAULT_KERNEL_LINE_HEIGHTS);
    expect(ENHANCE_CLAHE).toEqual({ clipLimit: 2, tile: 8 });
    for (const v of Object.values(VARIANTS)) {
      const e = v.config.enhance;
      if (e === false) continue;
      expect(e.gray).toBe(true);
      if (e.flatten) expect(e.flatten.kernelLineHeights).toBe(DEFAULT_KERNEL_LINE_HEIGHTS);
    }
  });
});
