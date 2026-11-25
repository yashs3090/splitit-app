// locateDocument on the REAL OpenCV.js 4.12 (spec Task 7, criteria 35–37 and 70). Every input is a
// synthetic scene drawn by `test-utils/opencv.ts` (paper quads on solid, textured or coloured
// backgrounds), never a receipt photo.
import { cornerError, grey, keystone, loadOpenCv, renderScene, rotatedRect, toMat, woodTexture, type Scene } from '../../../../test-utils/opencv';
import type { Quad } from '../../types';
import type { CvApi } from './cvApi';
import {
  ANGLE_TOLERANCE_DEG,
  edgeGradientRatio,
  locateDocumentMat,
  MASK_CONTRAST_FULL,
  MAX_BORDERS_TOUCHED,
  maskConfidence,
  maskedMedian,
  MAX_COOL_CAST_SATURATION,
  MAX_WARM_CAST_SATURATION,
  MIN_AREA_FRACTION,
  quadConfidence,
  shapeAcceptable,
  whiteBalanceGains,
} from './locate';

let cv: CvApi;
beforeAll(async () => {
  cv = (await loadOpenCv()).cv;
}, 60000);

function locate(scene: Scene) {
  const m = toMat(cv, renderScene(scene));
  try {
    return locateDocumentMat(cv, m);
  } finally {
    m.delete();
  }
}
const diag = (s: Scene) => Math.hypot(s.width, s.height);

describe('quad path', () => {
  it('criterion 35: light paper (V≈230) rotated 12° with perspective on a dark background (V≈70) → quad, conf ≥ 0.8, corners within 2%', () => {
    const scene: Scene = {
      width: 1200,
      height: 1600,
      background: grey(70),
      paper: { quad: keystone(rotatedRect(600, 800, 700, 1100, 12), 0.15), colour: grey(230) },
      noise: 6,
    };
    const r = locate(scene);
    expect(r.method).toBe('quad');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.02 * diag(scene));
  });

  it('on a textured (wood-grain) background, rotated the other way', () => {
    const scene: Scene = {
      width: 1200,
      height: 1600,
      background: woodTexture([120, 80, 50]),
      paper: { quad: keystone(rotatedRect(600, 800, 700, 1100, -8), 0.1), colour: grey(235) },
      noise: 8,
    };
    const r = locate(scene);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.02 * diag(scene));
  });

  it('is scale-free: the same scene at half size gives the same quad at half the coordinates', () => {
    const make = (k: number): Scene => ({
      width: 1200 * k,
      height: 1600 * k,
      background: grey(70),
      paper: { quad: rotatedRect(600 * k, 800 * k, 700 * k, 1100 * k, 6), colour: grey(230) },
      noise: 4,
    });
    const big = locate(make(1));
    const small = locate(make(0.5));
    expect(big.method).toBe('quad');
    expect(small.method).toBe('quad');
    const halved = big.quad!.map(([x, y]) => [x / 2, y / 2]) as Quad;
    expect(cornerError(halved, small.quad!)).toBeLessThanOrEqual(0.01 * diag(make(0.5)));
  });

  it('a landscape photo with the receipt turned sideways', () => {
    const scene: Scene = {
      width: 1600,
      height: 1000,
      background: grey(60),
      paper: { quad: rotatedRect(800, 500, 1100, 600, 3), colour: grey(225) },
      noise: 5,
    };
    const r = locate(scene);
    expect(r.method).toBe('quad');
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.02 * diag(scene));
  });
});

describe('mask fallback', () => {
  it('criterion 36: rounded corners (approxPolyDP gives > 4 points) on a coloured background → mask, conf ≥ 0.5, corners within 3%', () => {
    const scene: Scene = {
      width: 1200,
      height: 1600,
      background: [150, 60, 40],
      paper: { quad: rotatedRect(600, 800, 700, 1100, 5), colour: grey(235), cornerRadius: 0.3 },
      noise: 6,
    };
    const r = locate(scene);
    expect(r.method).toBe('mask');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    // minAreaRect of a rounded rectangle is the rectangle itself.
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.03 * diag(scene));
  });

  it('a dim but distinct paper (V 150 on V 110, too faint for Canny) is still located by the mask, confidence ≥ 0.5', () => {
    const scene: Scene = {
      width: 1200,
      height: 1600,
      background: grey(110),
      paper: { quad: rotatedRect(600, 800, 700, 1100, 5), colour: grey(150) },
      noise: 4,
    };
    const r = locate(scene);
    expect(r.method).toBe('mask');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.03 * diag(scene));
  });

  it('a receipt running off the bottom of the frame (one border) is still found; its quad stays inside the image', () => {
    const scene: Scene = {
      width: 1200,
      height: 1600,
      background: grey(70),
      paper: { quad: rotatedRect(600, 1000, 700, 1400, 0), colour: grey(230) },
      noise: 4,
    };
    const r = locate(scene);
    expect(r.method).not.toBe('none');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    for (const [x, y] of r.quad!) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1599);
    }
    // Top corners where the paper starts (y = 300), bottom at the frame.
    expect(r.quad![0][1]).toBeCloseTo(300, -1.5);
    expect(r.quad![3][1]).toBeGreaterThan(1580);
  });
});

describe('nothing found (criterion 37): confidence < 0.5, so the crop is the identity', () => {
  it.each<[string, Scene]>([
    ['a uniform image', { width: 1200, height: 1600, background: grey(128), noise: 4 }],
    [
      'light on light (V 220 on V 210)',
      { width: 1200, height: 1600, background: grey(210), paper: { quad: rotatedRect(600, 800, 700, 1100, 5), colour: grey(220) }, noise: 3 },
    ],
    [
      'a receipt covering 8% of the frame',
      { width: 1200, height: 1600, background: grey(70), paper: { quad: rotatedRect(600, 800, 340, 450, 5), colour: grey(230) }, noise: 4 },
    ],
    [
      'paper filling the whole frame (all four borders)',
      { width: 1200, height: 1600, background: grey(70), paper: { quad: rotatedRect(600, 800, 1300, 1700, 0), colour: grey(230) }, noise: 4 },
    ],
    [
      'a bright, saturated object on dark (not paper: S > 60)',
      { width: 1200, height: 1600, background: grey(50), paper: { quad: rotatedRect(600, 800, 700, 1100, 0), colour: [230, 120, 40], cornerRadius: 0.3, text: false }, noise: 4 },
    ],
  ])('%s', (_name, scene) => {
    expect(locate(scene).confidence).toBeLessThan(0.5);
  });
});

describe('acceptance rules at their boundaries (criterion 70)', () => {
  const W = 800;
  const H = 1000;
  const rect = (x0: number, y0: number, x1: number, y1: number): Quad => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  it(`area: just under ${MIN_AREA_FRACTION * 100}% of the image is refused, just over is accepted`, () => {
    const side = Math.sqrt(MIN_AREA_FRACTION * W * H);
    expect(shapeAcceptable(rect(100, 100, 100 + side - 2, 100 + side - 2), W, H, true)).toBe(false);
    expect(shapeAcceptable(rect(100, 100, 100 + side + 2, 100 + side + 2), W, H, true)).toBe(true);
  });

  it(`angles: within 90° ± ${ANGLE_TOLERANCE_DEG}° accepted, beyond refused (quad path only)`, () => {
    // A parallelogram whose corner angle is 90 − a.
    const para = (a: number): Quad => {
      const dx = 600 * Math.tan((a * Math.PI) / 180);
      return [
        [100 + dx, 100],
        [100 + dx + 600, 100],
        [100 + 600, 700],
        [100, 700],
      ];
    };
    expect(shapeAcceptable(para(ANGLE_TOLERANCE_DEG - 2), W * 2, H, true)).toBe(true);
    expect(shapeAcceptable(para(ANGLE_TOLERANCE_DEG + 2), W * 2, H, true)).toBe(false);
    expect(shapeAcceptable(para(ANGLE_TOLERANCE_DEG + 2), W * 2, H, false)).toBe(true);
  });

  it(`borders: ${MAX_BORDERS_TOUCHED} touched accepted, ${MAX_BORDERS_TOUCHED + 1} refused`, () => {
    expect(shapeAcceptable(rect(0, 0, 600, 700), W, H, true)).toBe(true); // left + top
    expect(shapeAcceptable(rect(0, 0, W - 1, 700), W, H, true)).toBe(false); // left + top + right
  });

  it('quad confidence: ratio 1 → 0, 2 → 0.5, ≥ 3 → 1; mask confidence: contrast ÷ 60 × fill, clamped', () => {
    expect(quadConfidence(1)).toBe(0);
    expect(quadConfidence(0.4)).toBe(0);
    expect(quadConfidence(2)).toBe(0.5);
    expect(quadConfidence(3)).toBe(1);
    expect(quadConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(maskConfidence(MASK_CONTRAST_FULL, 1)).toBe(1);
    expect(maskConfidence(MASK_CONTRAST_FULL / 2, 0.9)).toBeCloseTo(0.45, 10);
    expect(maskConfidence(-10, 1)).toBe(0);
    expect(maskConfidence(500, 0.9)).toBeCloseTo(0.9, 10);
  });

  it('edgeGradientRatio and maskedMedian on hand-made Mats', () => {
    // A 10×10 gradient image: 200 on column 2, 0 elsewhere; a quad whose left side runs down column 2.
    const g = cv.Mat.zeros(10, 10, cv.CV_8UC1);
    const mask = cv.Mat.zeros(10, 10, cv.CV_8UC1);
    try {
      for (let y = 0; y < 10; y++) g.data[y * 10 + 2] = 200;
      const q: Quad = [
        [2, 0],
        [8, 0],
        [8, 9],
        [2, 9],
      ];
      const r = edgeGradientRatio(g, 20, q);
      // Left side all 200, others mostly 0 (corners on column 2 are 200).
      expect(r).toBeGreaterThan(1);
      expect(edgeGradientRatio(g, 0, q)).toBe(Number.POSITIVE_INFINITY);
      // Median ignores a minority of dark "ink": 7 paper pixels at 230, 3 ink at 40.
      [230, 230, 40, 230, 230, 40, 230, 230, 40, 230].forEach((v, i) => {
        g.data[i] = v;
        mask.data[i] = 255;
      });
      expect(maskedMedian(g, mask)).toBe(230);
      mask.data.fill(0);
      expect(maskedMedian(g, mask)).toBe(0);
    } finally {
      g.delete();
      mask.delete();
    }
  });

  it('refuses a non-RGBA image', () => {
    const g = new cv.Mat(10, 10, cv.CV_8UC1);
    try {
      expect(() => locateDocumentMat(cv, g)).toThrow(RangeError);
    } finally {
      g.delete();
    }
  });
});

// ---------- colour casts (approved 2026-11-23): white-patch correction before the paper mask ----------

describe('paper under a colour cast (mask path: rounded corners so the quad path can\'t find it)', () => {
  const rounded = (colour: [number, number, number], background: Scene['background']): Scene => ({
    width: 1200,
    height: 1600,
    background,
    paper: { quad: rotatedRect(600, 800, 700, 1100, 4), colour, cornerRadius: 0.3 },
    noise: 5,
  });

  it.each<[string, Scene]>([
    // White paper under bluish daylight: S ≈ 0.27 (68 of 255), above the neutral limit of 60.
    ['blue daylight cast on a dark blue-grey table', rounded([180, 205, 245], [55, 70, 95])],
    // White paper under warm indoor light: S ≈ 0.40, on warm wood that is more saturated still.
    ['warm indoor cast on warm wood', rounded([200, 165, 120], woodTexture([120, 70, 35]))],
  ])('%s → found by the mask, confidence ≥ 0.5, corners within 3%', (_n, scene) => {
    const r = locate(scene);
    expect(r.method).toBe('mask');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.03 * diag(scene));
  });

  it('a saturated red tablecloth around neutral paper: the paper is found, not the cloth', () => {
    const scene = rounded([235, 235, 235], [170, 30, 40]);
    const r = locate(scene);
    expect(r.method).toBe('mask');
    expect(cornerError(r.quad!, scene.paper!.quad)).toBeLessThanOrEqual(0.03 * diag(scene));
  });

  it.each<[string, Scene]>([
    ['a bright orange object on dark (more saturated than any light source makes white paper)', rounded([230, 120, 40], grey(50))],
    ['a bright pastel-blue object on a dark table, no paper text', { ...rounded([120, 170, 245], grey(45)), paper: { quad: rotatedRect(600, 800, 700, 1100, 4), colour: [90, 150, 250], cornerRadius: 0.3, text: false } }],
    ['a uniform grey scene', { width: 1200, height: 1600, background: grey(128), noise: 4 }],
    ['a uniform warm-cast scene', { width: 1200, height: 1600, background: [200, 165, 120], noise: 4 }],
  ])('negative: %s → confidence < 0.5', (_n, scene) => {
    expect(locate(scene).confidence).toBeLessThan(0.5);
  });
});

describe('whiteBalanceGains (pure)', () => {
  const img = (px: [number, number, number], n: number, rest: [number, number, number], m: number) => {
    const data = new Uint8Array((n + m) * 4);
    for (let i = 0; i < n + m; i++) data.set([...(i < n ? px : rest), 255], i * 4);
    return data;
  };

  it('neutral bright pixels → gains of 1', () => {
    expect(whiteBalanceGains(img([230, 230, 230], 20, [60, 60, 60], 80))).toEqual([1, 1, 1]);
  });

  it('a mild blue cast on the brightest pixels → gains that make them neutral', () => {
    const g = whiteBalanceGains(img([170, 200, 242], 20, [60, 70, 90], 80));
    expect(g[0] * 170).toBeCloseTo(242, 0);
    expect(g[1] * 200).toBeCloseTo(242, 0);
    expect(g[2]).toBe(1);
  });

  it(`a bright estimate more saturated than ${MAX_WARM_CAST_SATURATION} is a coloured object: no correction`, () => {
    // S = 1 − min/max. Just under and just over the cap.
    const under = Math.round(240 * (1 - MAX_WARM_CAST_SATURATION) + 2);
    const over = Math.round(240 * (1 - MAX_WARM_CAST_SATURATION) - 2);
    expect(whiteBalanceGains(img([240, 200, under], 20, [40, 40, 40], 80))).not.toEqual([1, 1, 1]);
    expect(whiteBalanceGains(img([240, 200, over], 20, [40, 40, 40], 80))).toEqual([1, 1, 1]);
  });

  it(`cool side: bluer than ${MAX_COOL_CAST_SATURATION} (bluer than any daylight) is a blue object: no correction`, () => {
    const under = Math.round(240 * (1 - MAX_COOL_CAST_SATURATION) + 2);
    const over = Math.round(240 * (1 - MAX_COOL_CAST_SATURATION) - 2);
    expect(whiteBalanceGains(img([under, 215, 240], 20, [40, 40, 40], 80))).not.toEqual([1, 1, 1]);
    expect(whiteBalanceGains(img([over, 215, 240], 20, [40, 40, 40], 80))).toEqual([1, 1, 1]);
  });

  it('green or magenta bright patches are never a light source: no correction, even when mild', () => {
    expect(whiteBalanceGains(img([200, 240, 210], 20, [40, 40, 40], 80))).toEqual([1, 1, 1]);
    expect(whiteBalanceGains(img([240, 200, 235], 20, [40, 40, 40], 80))).toEqual([1, 1, 1]);
  });

  it('a black image → gains of 1 (nothing to estimate)', () => {
    expect(whiteBalanceGains(new Uint8Array(4 * 50))).toEqual([1, 1, 1]);
  });
});

// ---------- receipts running off the frame (approved 2026-11-23): borders count as edges ----------

describe('receipt running off the frame (quad path)', () => {
  const sharp = (quad: Quad): Scene => ({ width: 1200, height: 1600, background: grey(70), paper: { quad, colour: grey(230) }, noise: 4 });
  /** The expected outline: the paper clipped to the frame (axis-aligned papers only). */
  const clipped = (x0: number, y0: number, x1: number, y1: number): Quad => [
    [Math.max(0, x0), Math.max(0, y0)],
    [Math.min(1199, x1), Math.max(0, y0)],
    [Math.min(1199, x1), Math.min(1599, y1)],
    [Math.max(0, x0), Math.min(1599, y1)],
  ];
  const box = (x0: number, y0: number, x1: number, y1: number): Quad => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  it.each<[string, [number, number, number, number]]>([
    ['off the bottom', [250, 300, 950, 1800]],
    ['off the top', [250, -200, 950, 1300]],
    ['off the bottom and left (two borders)', [-150, 300, 800, 1800]],
  ])('%s → a closed quad along the frame, conf ≥ 0.5, corners within 2%', (_n, [x0, y0, x1, y1]) => {
    const scene = sharp(box(x0, y0, x1, y1));
    const r = locate(scene);
    expect(r.method).toBe('quad');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(cornerError(r.quad!, clipped(x0, y0, x1, y1))).toBeLessThanOrEqual(0.02 * diag(scene));
  });

  it('a receipt running off three borders is refused (it would be the table, not a receipt on it)', () => {
    expect(locate(sharp(box(-100, -100, 1300, 1300))).confidence).toBeLessThan(0.5);
  });
});
