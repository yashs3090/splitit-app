// Pure quad geometry for locate and warp (spec Task 7). No OpenCV here, so every rule is unit-tested
// on hand-made points (criterion 70).
import type { Pt, Quad } from '../../types';

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Orders 4 points as top-left, top-right, bottom-right, bottom-left (clockwise on screen, y down).
 * Sorted by angle around the centroid, then rotated so the point nearest the image's top-left
 * (smallest x + y) comes first. Works for any rotation, unlike sum/difference rules, which break
 * near 45°.
 */
export function orderCorners(points: readonly Pt[]): Quad {
  if (points.length !== 4) throw new RangeError('orderCorners needs 4 points');
  const cx = points.reduce((s, p) => s + p[0], 0) / 4;
  const cy = points.reduce((s, p) => s + p[1], 0) / 4;
  // atan2 with y down: increasing angle = clockwise on screen.
  const byAngle = [...points].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    const p = byAngle[i]!;
    const s = byAngle[start]!;
    if (p[0] + p[1] < s[0] + s[1]) start = i;
  }
  const q = [0, 1, 2, 3].map((k) => byAngle[(start + k) % 4]!);
  return [q[0]!, q[1]!, q[2]!, q[3]!];
}

/** Shoelace area (absolute). */
export function polygonArea(q: readonly Pt[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Interior angle at each corner, in degrees. */
export function interiorAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const prev = q[(i + 3) % 4]!;
    const next = q[(i + 1) % 4]!;
    const v1: Pt = [prev[0] - p[0], prev[1] - p[1]];
    const v2: Pt = [next[0] - p[0], next[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/**
 * How many image borders (left, top, right, bottom) a quad side lies along: both ends of the side
 * within `tolerancePx` of the same border. A corner merely touching a border doesn't count.
 */
export function bordersTouched(q: Quad, width: number, height: number, tolerancePx: number): number {
  const near = [
    (p: Pt) => p[0] <= tolerancePx,
    (p: Pt) => p[1] <= tolerancePx,
    (p: Pt) => p[0] >= width - 1 - tolerancePx,
    (p: Pt) => p[1] >= height - 1 - tolerancePx,
  ];
  let n = 0;
  for (const onBorder of near) {
    if (q.some((p, i) => onBorder(p) && onBorder(q[(i + 1) % 4]!))) n += 1;
  }
  return n;
}

/** Multiplies every coordinate (x by `sx`, y by `sy`). */
export function scaleQuad(q: Quad, sx: number, sy: number): Quad {
  return q.map(([x, y]) => [x * sx, y * sy] as Pt) as Quad;
}

/** Keeps every corner inside a `width × height` image. */
export function clampQuad(q: Quad, width: number, height: number): Quad {
  const c = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  return q.map(([x, y]) => [c(x, width - 1), c(y, height - 1)] as Pt) as Quad;
}

/**
 * Why: a warp smaller than this on either side can't hold a line of text, so a quad that small is a
 * detection error, not a receipt. Tuned: not tuned (a guard, not a quality threshold).
 */
export const MIN_WARP_SIDE_PX = 16;

/**
 * Why: tessdoc ("Improve quality: Borders") asks for about a 10 px border of background around the
 * text; with no border Tesseract misses characters touching the edge. Tuned: not tuned (from tessdoc).
 */
export const MIN_MARGIN_PX = 10;

/**
 * The flattened size of a quad (each side as long as the longer of its two opposite edges, so no
 * part of the receipt is shrunk) and the margin added on every side:
 * `max(MIN_MARGIN_PX, marginFraction × the crop's short side)`. Throws RangeError for a degenerate quad.
 */
export function warpGeometry(q: Quad, marginFraction: number): { width: number; height: number; margin: number } {
  const [tl, tr, br, bl] = q;
  const width = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  const height = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  if (!(width >= MIN_WARP_SIDE_PX && height >= MIN_WARP_SIDE_PX)) throw new RangeError('quad too small to warp');
  if (!(marginFraction >= 0 && Number.isFinite(marginFraction))) throw new RangeError('bad marginFraction');
  const margin = Math.max(MIN_MARGIN_PX, Math.ceil(marginFraction * Math.min(width, height) - 1e-9));
  return { width, height, margin };
}
