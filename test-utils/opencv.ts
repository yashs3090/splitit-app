// Test helpers for the OpenCV worker code (spec Task 6/7). Test-only: imported by `*.test.ts`.
//
// - `loadOpenCv()` loads the real OpenCV.js (@techstark/opencv-js 4.12, the file the worker loads)
//   under the jest-expo preset.
// - `renderScene()` draws synthetic photos: paper quads (rotated, in perspective, rounded corners,
//   with fake text lines) on solid, textured or coloured backgrounds. Every locate/warp test input is
//   generated here, never taken from a receipt photo (criterion 70).
// - `countingCv()` wraps the real OpenCV so a test can count live Mats and make the k-th call throw
//   (criterion 34).
import type { CvApi, CvMat } from '../lib/scanPipeline/web/cv/cvApi';
import type { Rgba } from '../lib/scanPipeline/web/cv/ops';
import type { Pt, Quad } from '../lib/scanPipeline/types';

/**
 * Loads OpenCV.js under the jest-expo preset. Two preset globals break it (checked 2026-11-23):
 * - jest-expo's setup sets `globalThis.window = global`, so OpenCV takes its browser path and
 *   throws "document is not defined" (also with `@jest-environment node`: the setup still runs);
 * - Expo's winter runtime installs a UTF-8-only `TextDecoder`, and OpenCV creates a UTF-16LE one
 *   at load ("Unknown encoding: utf-16le").
 * So `window` is hidden and Node's own `TextDecoder` used while OpenCV loads; both are put back.
 */
export async function loadOpenCv(): Promise<{ cv: CvApi }> {
  const g = globalThis as { window?: unknown; TextDecoder?: unknown };
  const savedWindow = g.window;
  const savedDecoder = g.TextDecoder;
  delete g.window;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Node built-in, test only
  g.TextDecoder = (require('util') as { TextDecoder: unknown }).TextDecoder;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the UMD build is CommonJS
    const mod = require('@techstark/opencv-js') as { Mat?: unknown; then?: (f: (m: unknown) => void) => unknown };
    // The Module is a thenable that passes itself: never resolve a Promise with it (see worker.ts).
    await new Promise<void>((resolve) => {
      if (typeof mod.Mat === 'function') resolve();
      else mod.then?.(() => resolve());
    });
    // Wrapped in an object: an async function returning the thenable Module itself would adopt it
    // and loop forever (the same trap `whenReady` in worker.ts avoids).
    return { cv: mod as unknown as CvApi };
  } finally {
    g.window = savedWindow;
    g.TextDecoder = savedDecoder;
  }
}

// ---------- synthetic scenes ----------

export type Rgb = [number, number, number];

/** Deterministic PRNG (mulberry32), so every synthetic image is the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const grey = (v: number): Rgb => [v, v, v];

/** A rectangle `w × h` centred at `(cx, cy)`, rotated `deg` clockwise; TL, TR, BR, BL. */
export function rotatedRect(cx: number, cy: number, w: number, h: number, deg: number): Quad {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pt = (dx: number, dy: number): Pt => [cx + dx * c - dy * s, cy + dx * s + dy * c];
  return [pt(-w / 2, -h / 2), pt(w / 2, -h / 2), pt(w / 2, h / 2), pt(-w / 2, h / 2)];
}

/** Perspective-like skew: the top edge shrinks toward its middle by `topShrink` of its length. */
export function keystone(q: Quad, topShrink: number): Quad {
  const [tl, tr, br, bl] = q;
  const k = topShrink / 2;
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return [lerp(tl, tr, k), lerp(tr, tl, k), br, bl];
}

type Mat3 = [number, number, number, number, number, number, number, number, number];

/** The homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto `q`. */
function squareToQuad(q: Quad): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export type Paper = {
  quad: Quad;
  colour: Rgb;
  /** Corner radius as a fraction of the paper's short side (0 = sharp corners). */
  cornerRadius?: number;
  /** Draw dark "text" rows (item names and prices) on the paper. Default true. */
  text?: boolean;
};

export type Scene = {
  width: number;
  height: number;
  background: Rgb | ((x: number, y: number) => Rgb);
  paper?: Paper;
  /** ± uniform per-pixel noise (grey levels). */
  noise?: number;
  seed?: number;
};

/** Wood-like texture: dark stripes plus grain, around `base`. */
export function woodTexture(base: Rgb, seed = 7): (x: number, y: number) => Rgb {
  const r = prng(seed);
  const phase = Array.from({ length: 8 }, () => r() * Math.PI * 2);
  return (x, y) => {
    const t = Math.sin(y / 9 + Math.sin(x / 140 + phase[0]!) * 3) * 0.5 + Math.sin(y / 3.1 + phase[1]!) * 0.25;
    const k = 1 + t * 0.35;
    return [base[0] * k, base[1] * k, base[2] * k];
  };
}

/** Renders a scene to RGBA. Paper pixels are found by mapping each pixel back into the paper's square. */
export function renderScene(scene: Scene): Rgba {
  const { width: w, height: h, paper, noise = 0 } = scene;
  const rand = prng(scene.seed ?? 1);
  const bg = typeof scene.background === 'function' ? scene.background : () => scene.background as Rgb;
  const data = new Uint8ClampedArray(w * h * 4);
  const inv = paper ? invert3(squareToQuad(paper.quad)) : null;
  // Paper side lengths, for round corners and text rows in physical proportion.
  const side = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pw = paper ? side(paper.quad[0], paper.quad[1]) : 1;
  const ph = paper ? side(paper.quad[0], paper.quad[3]) : 1;
  const r = paper?.cornerRadius ?? 0;
  const ru = (r * Math.min(pw, ph)) / pw;
  const rv = (r * Math.min(pw, ph)) / ph;
  const text = paper?.text ?? true;
  const rowPitch = Math.min(0.05, 40 / ph);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c: Rgb = bg(x, y);
      if (paper && inv) {
        const X = x + 0.5;
        const Y = y + 0.5;
        const z = inv[6] * X + inv[7] * Y + inv[8];
        const u = (inv[0] * X + inv[1] * Y + inv[2]) / z;
        const v = (inv[3] * X + inv[4] * Y + inv[5]) / z;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
          let inside = true;
          if (r > 0) {
            const cu = u < ru ? ru : u > 1 - ru ? 1 - ru : u;
            const cv = v < rv ? rv : v > 1 - rv ? 1 - rv : v;
            const du = (u - cu) / ru;
            const dv = (v - cv) / rv;
            inside = du * du + dv * dv <= 1;
          }
          if (inside) {
            c = paper.colour;
            if (text && v > 0.08 && v < 0.92) {
              const row = (v - 0.08) / rowPitch;
              const inRow = row - Math.floor(row) < 0.35;
              const name = u > 0.1 && u < 0.1 + 0.25 + 0.2 * ((Math.floor(row) * 7) % 5) / 5;
              const price = u > 0.75 && u < 0.9;
              if (inRow && (name || price)) c = grey(40);
            }
          }
        }
      }
      const i = (y * w + x) * 4;
      const n = noise > 0 ? (rand() * 2 - 1) * noise : 0;
      data[i] = c[0] + n;
      data[i + 1] = c[1] + n;
      data[i + 2] = c[2] + n;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** An RGBA Mat holding `rgba` (the caller deletes it). */
export function toMat(cv: CvApi, rgba: Rgba): CvMat {
  const m = new cv.Mat(rgba.height, rgba.width, cv.CV_8UC4);
  m.data.set(rgba.data);
  return m;
}

/** Largest distance between matching corners of two quads. */
export function cornerError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i]![0], p[1] - b[i]![1])));
}

// ---------- Mat accounting on the real OpenCV (criterion 34) ----------

export type CountingCv = {
  cv: CvApi;
  /** OpenCV objects created through the wrapper and not yet deleted. */
  live(): number;
  /** Calls made so far (functions, constructors and handle-returning methods). */
  calls(): number;
  /** Makes the call with this 1-based number throw `injected`; 0 = never. */
  failAt(n: number): void;
};

type Handle = { delete(): void; isDeleted?: () => boolean } & Record<string, unknown>;
const HANDLE_METHODS = ['clone', 'get', 'roi'];

/**
 * Wraps the real OpenCV: every Mat / MatVector / CLAHE made by a constructor, a `cv.*` function, `Mat.zeros`,
 * or `clone` / `get` / `roi` is counted until its `delete()`. Calls are numbered so a test can make
 * any one of them throw and then check nothing leaked.
 */
export function countingCv(real: CvApi): CountingCv {
  let live = 0;
  let calls = 0;
  let failAt = 0;
  const tick = () => {
    calls += 1;
    if (calls === failAt) throw new Error('injected');
  };
  const isHandle = (v: unknown): v is Handle =>
    !!v && typeof v === 'object' && typeof (v as Handle).delete === 'function' && typeof (v as Handle).isDeleted === 'function';
  const track = <T>(v: T): T => {
    if (!isHandle(v)) return v;
    live += 1;
    const h = v as Handle;
    const del = h.delete;
    h.delete = function (this: unknown) {
      live -= 1;
      return del.call(this);
    };
    for (const name of HANDLE_METHODS) {
      const f = h[name];
      if (typeof f !== 'function') continue;
      h[name] = function (this: unknown, ...args: unknown[]) {
        tick();
        return track((f as (...a: unknown[]) => unknown).apply(this, args));
      };
    }
    return v;
  };
  const wrapCtor = (Ctor: object) =>
    new Proxy(Ctor, {
      construct(target, args) {
        tick();
        return track(Reflect.construct(target as new (...a: unknown[]) => object, args)) as object;
      },
      get(target, key) {
        const v = Reflect.get(target, key) as unknown;
        if (key === 'zeros' && typeof v === 'function') {
          return (...args: unknown[]) => {
            tick();
            return track((v as (...a: unknown[]) => unknown).apply(target, args));
          };
        }
        return v;
      },
    });
  const ctors = new Map<PropertyKey, object>();
  const cv = new Proxy(real as unknown as Record<PropertyKey, unknown>, {
    get(target, key) {
      const v = target[key];
      if (key === 'Mat' || key === 'MatVector' || key === 'CLAHE') {
        if (!ctors.has(key)) ctors.set(key, wrapCtor(v as object));
        return ctors.get(key);
      }
      // Plain value classes (Size, Point, Scalar) and namespaces pass through.
      if (typeof v === 'function' && typeof key === 'string' && /^[a-z]/.test(key)) {
        return (...args: unknown[]) => {
          tick();
          return track((v as (...a: unknown[]) => unknown).apply(target, args));
        };
      }
      return v;
    },
  }) as unknown as CvApi;
  return { cv, live: () => live, calls: () => calls, failAt: (n) => (failAt = n) };
}
