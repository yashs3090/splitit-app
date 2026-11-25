// Pure quad geometry (spec Task 7). Hand-made points only (criterion 70).
import type { Pt, Quad } from '../../types';
import {
  bordersTouched,
  clampQuad,
  interiorAngles,
  MIN_MARGIN_PX,
  MIN_WARP_SIDE_PX,
  orderCorners,
  polygonArea,
  scaleQuad,
  warpGeometry,
} from './geometry';

const square: Quad = [
  [10, 10],
  [110, 10],
  [110, 210],
  [10, 210],
];

describe('orderCorners', () => {
  it('orders any permutation as TL, TR, BR, BL', () => {
    const perms: Pt[][] = [
      [square[2], square[0], square[3], square[1]],
      [square[3], square[2], square[1], square[0]],
      [square[1], square[3], square[0], square[2]],
    ];
    for (const p of perms) expect(orderCorners(p)).toEqual(square);
  });

  it('works for a quad rotated near 45° (where sum/difference rules break)', () => {
    // A diamond: top, right, bottom, left. TL is the one with the smallest x + y (the left or top point).
    const diamond: Pt[] = [
      [100, 0],
      [200, 101],
      [100, 200],
      [0, 99],
    ];
    const q = orderCorners([diamond[2]!, diamond[0]!, diamond[3]!, diamond[1]!]);
    expect(q).toEqual([diamond[3], diamond[0], diamond[1], diamond[2]]);
  });

  it('rejects anything but 4 points', () => {
    expect(() => orderCorners([[0, 0]])).toThrow(RangeError);
  });
});

describe('area, angles, borders, scale, clamp', () => {
  it('shoelace area and right angles', () => {
    expect(polygonArea(square)).toBe(100 * 200);
    for (const a of interiorAngles(square)) expect(a).toBeCloseTo(90, 6);
  });

  it('a kite has angles away from 90', () => {
    const kite: Quad = [
      [0, 0],
      [100, 20],
      [100, 80],
      [0, 100],
    ];
    const a = interiorAngles(kite);
    expect(a.reduce((s, v) => s + v, 0)).toBeCloseTo(360, 6);
    expect(Math.max(...a.map((v) => Math.abs(v - 90)))).toBeGreaterThan(10);
  });

  it('counts a border only when a whole side lies along it, within the tolerance', () => {
    const w = 200;
    const h = 300;
    expect(bordersTouched(square, w, h, 2)).toBe(0);
    // Bottom side along the bottom border (y = h - 1), a pixel short of it.
    const offBottom: Quad = [
      [20, 20],
      [180, 20],
      [180, h - 2],
      [20, h - 2],
    ];
    expect(bordersTouched(offBottom, w, h, 2)).toBe(1);
    expect(bordersTouched(offBottom, w, h, 0)).toBe(0);
    // One corner in the top-left corner of the image touches no side.
    const corner: Quad = [
      [0, 0],
      [150, 30],
      [150, 250],
      [30, 150],
    ];
    expect(bordersTouched(corner, w, h, 2)).toBe(0);
    const full: Quad = [
      [0, 0],
      [w - 1, 0],
      [w - 1, h - 1],
      [0, h - 1],
    ];
    expect(bordersTouched(full, w, h, 2)).toBe(4);
  });

  it('scales and clamps', () => {
    expect(scaleQuad(square, 2, 0.5)[2]).toEqual([220, 105]);
    expect(
      clampQuad(
        [
          [-5, -5],
          [300, 0],
          [300, 300],
          [0, 300],
        ],
        200,
        100,
      ),
    ).toEqual([
      [0, 0],
      [199, 0],
      [199, 99],
      [0, 99],
    ]);
  });
});

describe('warpGeometry', () => {
  it('each side as long as the longer of its opposite edges', () => {
    // A trapezoid: top 60 wide, bottom 100 wide, 200 tall (straight sides on the left).
    const trap: Quad = [
      [0, 0],
      [60, 0],
      [100, 200],
      [0, 200],
    ];
    const g = warpGeometry(trap, 0.025);
    expect(g.width).toBe(100);
    expect(g.height).toBe(Math.round(Math.hypot(40, 200)));
  });

  it(`margin = max(${MIN_MARGIN_PX} px, marginFraction × short side), never below either (criterion 38)`, () => {
    // Short side 200: 2.5% = 5 → the 10 px floor.
    expect(warpGeometry(square, 0.025).margin).toBe(10);
    // Short side 1000: 2.5% = 25.
    const big: Quad = [
      [0, 0],
      [1000, 0],
      [1000, 3000],
      [0, 3000],
    ];
    expect(warpGeometry(big, 0.025).margin).toBe(25);
    // Fractions round up, so the margin is never under the rule: 0.025 × 1010 = 25.25 → 26.
    const odd: Quad = [
      [0, 0],
      [1010, 0],
      [1010, 3000],
      [0, 3000],
    ];
    expect(warpGeometry(odd, 0.025).margin).toBe(26);
    // Exactly 10 at 400 (no float overshoot to 11).
    const at400: Quad = [
      [0, 0],
      [400, 0],
      [400, 900],
      [0, 900],
    ];
    expect(warpGeometry(at400, 0.025).margin).toBe(10);
  });

  it(`a quad under ${MIN_WARP_SIDE_PX} px on a side, or a bad fraction, is refused`, () => {
    const thin: Quad = [
      [0, 0],
      [MIN_WARP_SIDE_PX - 1, 0],
      [MIN_WARP_SIDE_PX - 1, 100],
      [0, 100],
    ];
    expect(() => warpGeometry(thin, 0.025)).toThrow(RangeError);
    const ok: Quad = [
      [0, 0],
      [MIN_WARP_SIDE_PX, 0],
      [MIN_WARP_SIDE_PX, 100],
      [0, 100],
    ];
    expect(warpGeometry(ok, 0.025).width).toBe(MIN_WARP_SIDE_PX);
    expect(() => warpGeometry(square, -0.1)).toThrow(RangeError);
    expect(() => warpGeometry(square, Number.NaN)).toThrow(RangeError);
  });
});
