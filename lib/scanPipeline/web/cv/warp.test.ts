// cropAndFlatten's warp on the REAL OpenCV.js 4.12 (spec Task 7, criterion 38). Synthetic scenes only.
import { grey, keystone, loadOpenCv, renderScene, rotatedRect, toMat, type Scene } from '../../../../test-utils/opencv';
import type { Quad } from '../../types';
import type { CvApi, CvMat } from './cvApi';
import { MIN_MARGIN_PX, warpGeometry } from './geometry';
import { medianBorderColour, warpQuad } from './warp';

let cv: CvApi;
beforeAll(async () => {
  cv = (await loadOpenCv()).cv;
}, 60000);

const px = (m: CvMat, x: number, y: number) => {
  const i = (y * m.cols + x) * 4;
  return [m.data[i], m.data[i + 1], m.data[i + 2], m.data[i + 3]];
};

function warpScene(scene: Scene, quad: Quad, marginFraction = 0.025) {
  const src = toMat(cv, renderScene(scene));
  try {
    return warpQuad(cv, src, quad, marginFraction);
  } finally {
    src.delete();
  }
}

describe('warpQuad', () => {
  const paperQuad = keystone(rotatedRect(600, 800, 700, 1100, 12), 0.15);
  const scene: Scene = { width: 1200, height: 1600, background: grey(70), paper: { quad: paperQuad, colour: [235, 230, 220], text: false } };

  it('criterion 38: margin ≥ max(10, 0.025 × short side) on every side, padded with the paper\'s colour', () => {
    const out = warpScene(scene, paperQuad);
    try {
      const g = warpGeometry(paperQuad, 0.025);
      expect(g.margin).toBeGreaterThanOrEqual(Math.max(MIN_MARGIN_PX, 0.025 * Math.min(g.width, g.height)));
      expect([out.cols, out.rows]).toEqual([g.width + 2 * g.margin, g.height + 2 * g.margin]);
      // Every margin pixel on all four sides is one padding colour: the paper's (edge pixels blend a
      // little with the table, so within 10 levels), never the table's (70).
      const pad = px(out, 0, 0);
      for (const [c, want] of [235, 230, 220].entries()) expect(Math.abs((pad[c] ?? 0) - want)).toBeLessThanOrEqual(10);
      for (let k = 0; k < g.margin; k++) {
        for (const [x, y] of [
          [k, Math.floor(out.rows / 2)],
          [out.cols - 1 - k, Math.floor(out.rows / 2)],
          [Math.floor(out.cols / 2), k],
          [Math.floor(out.cols / 2), out.rows - 1 - k],
        ] as [number, number][]) {
          expect(px(out, x, y)).toEqual(pad);
        }
      }
      // The flattened content is paper: no table (V 70) inside the crop away from its very edge.
      const inner = px(out, g.margin + 5, g.margin + 5);
      expect(inner[0]).toBeGreaterThan(200);
    } finally {
      out.delete();
    }
  });

  it('undoes rotation and perspective: a dark mark at the paper\'s top-left ends up at the crop\'s top-left', () => {
    // Paper with text rows; text starts at u = 0.1 and v = 0.08 in paper space.
    const s: Scene = { ...scene, paper: { quad: paperQuad, colour: grey(235) } };
    const out = warpScene(s, paperQuad, 0);
    try {
      const g = warpGeometry(paperQuad, 0);
      const m = g.margin;
      // First text row: v from 0.08 to 0.08 + 0.35 × pitch; the name starts at u 0.1.
      const x = m + Math.round(0.15 * g.width);
      const y = m + Math.round((0.08 + 0.01) * g.height);
      expect(px(out, x, y)[0]).toBeLessThan(100); // ink
      // The same row's gap between name and price (u 0.65) is paper: rows came out horizontal.
      expect(px(out, m + Math.round(0.65 * g.width), y)[0]).toBeGreaterThan(200);
      // Mirror image check: the top-right corner area above the first row is paper.
      expect(px(out, m + Math.round(0.85 * g.width), m + Math.round(0.03 * g.height))[0]).toBeGreaterThan(200);
    } finally {
      out.delete();
    }
  });

  it('a quad touching the photo border warps without pulling in black (edge replicated)', () => {
    const edgeQuad: Quad = [
      [0, 0],
      [599, 0],
      [599, 799],
      [0, 799],
    ];
    const s: Scene = { width: 600, height: 800, background: grey(200) };
    const out = warpScene(s, edgeQuad);
    try {
      expect(px(out, out.cols - 1, out.rows - 1)[0]).toBe(200);
      const g = warpGeometry(edgeQuad, 0.025);
      expect(px(out, g.margin, g.margin)[0]).toBe(200);
    } finally {
      out.delete();
    }
  });

  it('a degenerate quad or a grey image is refused (RangeError), allocating nothing', () => {
    const src = toMat(cv, renderScene({ width: 100, height: 100, background: grey(50) }));
    const g = new cv.Mat(10, 10, cv.CV_8UC1);
    try {
      const tiny: Quad = [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
      ];
      expect(() => warpQuad(cv, src, tiny, 0.025)).toThrow(RangeError);
      expect(() => warpQuad(cv, g, tiny, 0.025)).toThrow(RangeError);
    } finally {
      src.delete();
      g.delete();
    }
  });
});

describe('medianBorderColour', () => {
  it('takes the per-channel median of the outer ring, ignoring a minority of ink on it', () => {
    const m = toMat(cv, renderScene({ width: 40, height: 30, background: [240, 235, 225] }));
    try {
      // Ink on part of the top row.
      for (let x = 0; x < 10; x++) m.data.set([20, 20, 20, 255], x * 4);
      expect(medianBorderColour(m)).toEqual([240, 235, 225]);
    } finally {
      m.delete();
    }
  });
});
