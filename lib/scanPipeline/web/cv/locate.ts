// locateDocument on web (spec Task 7, the core stage): find the receipt's 4 corners in the photo.
// Takes `cv` as a parameter, so the worker, Jest (real OpenCV) and the Mat-counting test run it alike.
//
// 1. Quad path, on a copy at most LOCATE_MAX_EDGE px: grey → Gaussian blur → Canny → the image's
//    own border drawn in as an edge → dilate → all contours (outer and inner) → the largest few →
//    approxPolyDP at 2% of the perimeter → a convex 4-gon that is big enough, roughly rectangular,
//    and not lying along more than 2 image borders. The drawn border closes the outline of a receipt
//    that runs off the frame (common for long receipts); inner contours are needed because the
//    border makes one outer contour around everything.
//    Confidence = clamp((edge-gradient ratio − 1) / 2, 0, 1): how much stronger the gradient is on the
//    quad's sides than anywhere in the image.
// 2. Mask fallback, when no quad is accepted (or the quad's edges are weak): receipts are bright,
//    low-saturation paper on a darker or more colourful background. First the light's colour cast is
//    removed (white patch: the brightest pixels are taken to be white paper, if their colour is one a
//    real light source could give it), because under warm or bluish light white paper is itself
//    "saturated". Then V ≥ Otsu(V) and S ≤ 60 →
//    close/open → the largest component (holes filled) → its minAreaRect. Confidence = the V
//    contrast between the paper and a band just outside it, ÷ 60, × how well it fills its rectangle.
//    The contrast compares medians, not means: ink covers 5–20% of a receipt and would pull a mean
//    down by however much is printed, while the median reads the paper itself.
//    The threshold makes a geometry mask only; the image that is read is never thresholded.
// 3. Neither accepted → `{ method: 'none', confidence: 0 }`, and the crop keeps the whole photo.
//
// Every constant is general (a property of photos of paper, or of the algorithm), has a `Why:`, and
// is exercised by a synthetic test in `locate.test.ts` (criteria 35–37, 70–71). No photo tuned them.
import { targetSize } from '../../../imageSize';
import type { Pt, Quad } from '../../types';
import { withMats, type CvApi, type CvDeletable, type CvMat, type CvMatVector } from './cvApi';
import { bordersTouched, clampQuad, interiorAngles, orderCorners, polygonArea, scaleQuad } from './geometry';
import type { CvLocation } from './protocol';
import { resizeMat } from './resize';

export const NOT_FOUND: CvLocation = { method: 'none', quad: null, confidence: 0 };

/**
 * Why: finding the paper's outline needs only its coarse shape; 800 px keeps a receipt's border tens of
 * pixels long even when it is small in the frame, while making Canny/contours ~20× cheaper than on a
 * 4000 px photo, and shrinking (INTER_AREA) averages away sensor noise and paper texture.
 * Tuned: not tuned (starting value from the spec, Task 7).
 */
export const LOCATE_MAX_EDGE = 800;

/**
 * Why: a receipt smaller than this share of the frame is too small to be the subject (the photo is
 * of something else, or the "paper" found is a label or a reflection); cropping to it would risk
 * cutting the real receipt away. Used by both paths. Tuned: not tuned (spec starting value).
 */
export const MIN_AREA_FRACTION = 0.15;

/**
 * Why: a rectangle seen in perspective keeps its corners near 90°; beyond ±35° the "quad" is not a
 * sheet of paper (a triangle-ish contour, a fold, a table edge). Tuned: not tuned (spec starting value).
 */
export const ANGLE_TOLERANCE_DEG = 35;

/**
 * Why: a shape lying along 3 or 4 image borders is the table or the whole frame, not a receipt on it;
 * a receipt cut off by the frame lies along at most 2 (one end, or a corner). Tuned: not tuned (spec).
 */
export const MAX_BORDERS_TOUCHED = 2;

/**
 * Why: a side lies along a border when both its ends are this close to it: the photo's own edge
 * pixels are often blurred or vignetted, so the paper's outline stops a pixel or two short of it.
 * As a fraction of the short side of the 800 px copy (≈ 6 px), at least 2 px.
 * Tuned: not tuned (implementation choice, Task 7).
 */
export const BORDER_TOLERANCE_FRACTION = 0.01;

/**
 * Why: OpenCV's usual ε for approxPolyDP. Bumps from text, folds or a curled corner are a small share
 * of the perimeter and vanish, while a real corner deviates far more than 2%. Tuned: not tuned (spec).
 */
export const APPROX_EPSILON_FRACTION = 0.02;

/**
 * Why: Canny's hysteresis thresholds on the Sobel response of the 5×5-blurred grey image. A step of
 * Δ grey levels gives a response of about 3Δ there, so 150 / 50 (Canny's own 1:3 ratio) start an
 * edge at a step of ~50 levels and continue it down to ~17. Paper against a table is far above
 * that; paper texture, JPEG noise and a white-on-white scene are below it.
 * Tuned: not tuned (implementation choice, Task 7; the spec leaves Canny's thresholds open).
 */
export const CANNY_LOW = 50;
export const CANNY_HIGH = 150;

/**
 * Why: the receipt is almost always one of the few largest closed outlines; looking further only
 * finds text blocks and table texture. Tuned: not tuned (implementation choice, Task 7).
 */
export const QUAD_CANDIDATES = 5;

/**
 * Why: the gradient is sampled as the local maximum within ±3 px of the quad's sides (the detected
 * outline sits a pixel or two off the true edge after dilation), and the image mean uses the same
 * local maximum, so a random line through texture scores a ratio of about 1, not more.
 * Tuned: not tuned (implementation choice, Task 7).
 */
export const EDGE_SAMPLE_REACH_PX = 3;

/**
 * Why: a quad whose edges are no stronger than this gets a second opinion from the mask path, and
 * the more confident answer wins. Equal to the crop's starting `minConfidence`, so a quad the crop
 * would ignore never blocks a mask the crop would use. Tuned: not tuned (implementation choice).
 */
export const QUAD_SECOND_OPINION_BELOW = 0.5;

/**
 * Why: printing paper is near-neutral; tables, hands and food are usually more saturated. On
 * OpenCV's 8-bit scale (0–255) 60 still admits warm indoor light on white paper.
 * Tuned: not tuned (spec starting value).
 */
export const MASK_MAX_SATURATION = 60;

/**
 * Why: a sheet of paper fills its own bounding rectangle; a blob that fills less than 85% of it is a
 * hand, a plate, or paper merged with something else. Tuned: not tuned (spec starting value).
 */
export const MASK_MIN_FILL = 0.85;

/**
 * Why: paper-vs-background contrast (mean V) that counts as fully confident. 60 of 255 levels is a
 * clear step even on a mid-grey table; a white receipt on a white table differs by ~10–20 and
 * should stay below the crop threshold. Tuned: not tuned (spec starting value).
 */
export const MASK_CONTRAST_FULL = 60;

/**
 * Why: the close/open kernel for the paper mask, as a share of the short side of the 800 px copy
 * (≈ 12 px): bigger than a text stroke, so printed text doesn't break the paper apart, and big
 * enough that the open step cuts thin bridges to other bright things. Holes left inside don't matter
 * (the component's outline is used). The band outside the paper for the contrast has the same width.
 * Tuned: not tuned (implementation choice, Task 7).
 */
export const MASK_KERNEL_FRACTION = 0.02;

/**
 * Why: the share of brightest pixels used to estimate the light's colour (white patch). Smaller than
 * the smallest receipt accepted (MIN_AREA_FRACTION), so when a receipt is in the photo these pixels
 * are on it, or on something else white, which is neutral anyway. The median of their colour ignores
 * specular glints. Tuned: not tuned (implementation choice, 2026-11-23).
 */
export const WHITE_PATCH_FRACTION = 0.05;

/**
 * Why: the most saturated colour a common light source gives white paper, on the warm side: a
 * 2700 K incandescent bulb is about sRGB (255, 169, 87), saturation 1 − 87/255 ≈ 0.66, and phone
 * auto white balance removes part of even that. A warmer-looking bright patch is an orange object,
 * not white paper under warm light, so no correction is made. Tuned: not tuned (blackbody physics).
 */
export const MAX_WARM_CAST_SATURATION = 0.66;

/**
 * Why: the same on the cool side: open shade under a clear sky (~20 000 K) is about sRGB
 * (168, 197, 255), saturation ≈ 0.34. Daylight never gets bluer, so a bluer bright patch is a blue
 * object. Tuned: not tuned (blackbody physics).
 */
export const MAX_COOL_CAST_SATURATION = 0.34;

/**
 * Per-channel gains (R, G, B) that make the brightest pixels neutral, for the paper mask only (the
 * image that is read is never changed). [1, 1, 1] when the bright colour isn't one a light source can
 * give: more saturated than the blackbody limits above, or with green outside the red–blue range
 * (real light runs from orange to blue through white, never green or magenta).
 */
export function whiteBalanceGains(rgba: Uint8Array | Uint8ClampedArray): [number, number, number] {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return [1, 1, 1];
  const vHist = new Uint32Array(256);
  for (let i = 0; i < n; i++) vHist[Math.max(rgba[4 * i] ?? 0, rgba[4 * i + 1] ?? 0, rgba[4 * i + 2] ?? 0)]! += 1;
  // The V at which the brightest WHITE_PATCH_FRACTION of pixels starts.
  let cut = 255;
  for (let seen = 0; cut > 0; cut--) {
    seen += vHist[cut] ?? 0;
    if (seen >= WHITE_PATCH_FRACTION * n) break;
  }
  const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let m = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[4 * i] ?? 0;
    const g = rgba[4 * i + 1] ?? 0;
    const b = rgba[4 * i + 2] ?? 0;
    if (Math.max(r, g, b) < cut) continue;
    hists[0]![r]! += 1;
    hists[1]![g]! += 1;
    hists[2]![b]! += 1;
    m += 1;
  }
  const median = (h: Uint32Array) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += h[v] ?? 0;
      if (seen >= m / 2) return v;
    }
    return 255;
  };
  const [r, g, b] = hists.map(median) as [number, number, number];
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  if (hi === 0 || lo === 0) return [1, 1, 1];
  const sat = 1 - lo / hi;
  const onLocus = g <= Math.max(r, b) && g >= Math.min(r, b);
  const limit = r >= b ? MAX_WARM_CAST_SATURATION : MAX_COOL_CAST_SATURATION;
  if (!onLocus || sat > limit) return [1, 1, 1];
  return [hi / r, hi / g, hi / b];
}

/** Sobel 3×3 responses reach 4 × 255 per axis; 1/8 maps |gx| + |gy| into 8 bits without clipping. */
const GRADIENT_SCALE = 0.125;

type Keep = <M extends CvDeletable>(m: M) => M;
type Candidate = { method: 'quad' | 'mask'; quad: Quad; confidence: number };

const oddAtLeast3 = (v: number) => {
  const n = Math.max(3, Math.round(v));
  return n % 2 === 1 ? n : n + 1;
};
const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** The shape rules both paths share: area, (quad only) angles, borders. */
export function shapeAcceptable(q: Quad, w: number, h: number, checkAngles: boolean): boolean {
  if (polygonArea(q) < MIN_AREA_FRACTION * w * h) return false;
  if (checkAngles && interiorAngles(q).some((a) => Math.abs(a - 90) > ANGLE_TOLERANCE_DEG)) return false;
  const tol = Math.max(2, BORDER_TOLERANCE_FRACTION * Math.min(w, h));
  return bordersTouched(q, w, h, tol) <= MAX_BORDERS_TOUCHED;
}

/** Areas of every contour, largest first. Each handle `get` makes is freed straight away. */
function contourAreas(cv: CvApi, contours: CvMatVector): { i: number; area: number }[] {
  const out: { i: number; area: number }[] = [];
  for (let i = 0; i < contours.size(); i++) {
    out.push({ i, area: withMats((keep) => cv.contourArea(keep(contours.get(i)))) });
  }
  return out.sort((a, b) => b.area - a.area);
}

/**
 * Mean of the local-max gradient sampled along the quad's sides ÷ its mean over the whole image.
 * `localMax` is 8-bit, one channel, the size of the 800 px copy.
 */
export function edgeGradientRatio(localMax: CvMat, imageMean: number, q: Quad): number {
  const w = localMax.cols;
  const h = localMax.rows;
  const px = localMax.data;
  let sum = 0;
  let n = 0;
  for (let s = 0; s < 4; s++) {
    const a = q[s]!;
    const b = q[(s + 1) % 4]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const x = Math.max(0, Math.min(w - 1, Math.round(a[0] + (b[0] - a[0]) * t)));
      const y = Math.max(0, Math.min(h - 1, Math.round(a[1] + (b[1] - a[1]) * t)));
      sum += px[y * w + x] ?? 0;
      n += 1;
    }
  }
  const edgeMean = n > 0 ? sum / n : 0;
  if (imageMean <= 1e-6) return edgeMean > 0 ? Number.POSITIVE_INFINITY : 1;
  return edgeMean / imageMean;
}

/** Median of the 8-bit one-channel `src` over the pixels where `mask` is non-zero (0 if none). */
export function maskedMedian(src: CvMat, mask: CvMat): number {
  const hist = new Uint32Array(256);
  const d = src.data;
  const m = mask.data;
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] === 0) continue;
    hist[d[i] ?? 0]! += 1;
    n += 1;
  }
  if (n === 0) return 0;
  const half = n / 2;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v] ?? 0;
    if (seen >= half) return v;
  }
  return 255;
}

export const quadConfidence = (ratio: number) => clamp01((ratio - 1) / 2);
export const maskConfidence = (contrast: number, fill: number) => clamp01(contrast / MASK_CONTRAST_FULL) * clamp01(fill);

function findQuad(cv: CvApi, keep: Keep, blur: CvMat): Candidate | null {
  const w = blur.cols;
  const h = blur.rows;
  const edges = keep(new cv.Mat());
  cv.Canny(blur, edges, CANNY_LOW, CANNY_HIGH);
  // The frame's own border counts as an edge, so a receipt running off one or two sides still has a
  // closed outline; the "at most 2 borders" rule then judges it like any other quad.
  cv.rectangle(edges, new cv.Point(0, 0), new cv.Point(w - 1, h - 1), new cv.Scalar(255), 1);
  // Close 1-px gaps in the outline (a faint stretch of edge, a pen mark crossing it).
  const k3 = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  const joined = keep(new cv.Mat());
  cv.dilate(edges, joined, k3);
  const contours = keep(new cv.MatVector());
  const hierarchy = keep(new cv.Mat());
  // Every contour, inner ones included: with the border drawn, the only outer contour is the frame.
  cv.findContours(joined, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const minArea = MIN_AREA_FRACTION * w * h;
  let quad: Quad | null = null;
  for (const { i, area } of contourAreas(cv, contours).slice(0, QUAD_CANDIDATES)) {
    if (area < minArea) break;
    quad = withMats((k) => {
      const c = k(contours.get(i));
      const approx = k(new cv.Mat());
      cv.approxPolyDP(c, approx, APPROX_EPSILON_FRACTION * cv.arcLength(c, true), true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) return null;
      const d = approx.data32S;
      const q = orderCorners([0, 1, 2, 3].map((j) => [d[2 * j] ?? 0, d[2 * j + 1] ?? 0] as Pt));
      return shapeAcceptable(q, w, h, true) ? q : null;
    });
    if (quad) break;
  }
  if (!quad) return null;

  // Gradient magnitude (L1, 8-bit), then its local max, for the edge-strength confidence.
  const gx = keep(new cv.Mat());
  const gy = keep(new cv.Mat());
  cv.Sobel(blur, gx, cv.CV_16S, 1, 0);
  cv.Sobel(blur, gy, cv.CV_16S, 0, 1);
  const ax = keep(new cv.Mat());
  const ay = keep(new cv.Mat());
  cv.convertScaleAbs(gx, ax, GRADIENT_SCALE, 0);
  cv.convertScaleAbs(gy, ay, GRADIENT_SCALE, 0);
  const mag = keep(new cv.Mat());
  cv.add(ax, ay, mag);
  const reach = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2 * EDGE_SAMPLE_REACH_PX + 1, 2 * EDGE_SAMPLE_REACH_PX + 1)));
  const localMax = keep(new cv.Mat());
  cv.dilate(mag, localMax, reach);
  const imageMean = cv.mean(localMax)[0] ?? 0;
  return { method: 'quad', quad, confidence: quadConfidence(edgeGradientRatio(localMax, imageMean, quad)) };
}

function findMask(cv: CvApi, keep: Keep, small: CvMat): Candidate | null {
  const w = small.cols;
  const h = small.rows;
  const rgb = keep(new cv.Mat());
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  // Remove the light's colour cast (mask only; `small` and the photo are untouched).
  const gains = whiteBalanceGains(small.data);
  if (gains.some((x) => x !== 1)) {
    const d = rgb.data;
    for (let i = 0; i < d.length; i += 3) {
      d[i] = Math.min(255, Math.round((d[i] ?? 0) * gains[0]));
      d[i + 1] = Math.min(255, Math.round((d[i + 1] ?? 0) * gains[1]));
      d[i + 2] = Math.min(255, Math.round((d[i + 2] ?? 0) * gains[2]));
    }
  }
  const hsv = keep(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const channels = keep(new cv.MatVector());
  cv.split(hsv, channels);
  const s = keep(channels.get(1));
  const v = keep(channels.get(2));

  // Geometry mask only (never the OCR image): bright (Otsu on V) and near-neutral.
  const bright = keep(new cv.Mat());
  cv.threshold(v, bright, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const neutral = keep(new cv.Mat());
  cv.threshold(s, neutral, MASK_MAX_SATURATION, 255, cv.THRESH_BINARY_INV);
  const mask = keep(new cv.Mat());
  cv.bitwise_and(bright, neutral, mask);
  const size = oddAtLeast3(MASK_KERNEL_FRACTION * Math.min(w, h));
  const kernel = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size)));
  const closed = keep(new cv.Mat());
  cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel);
  const opened = keep(new cv.Mat());
  cv.morphologyEx(closed, opened, cv.MORPH_OPEN, kernel);

  const contours = keep(new cv.MatVector());
  const hierarchy = keep(new cv.Mat());
  cv.findContours(opened, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const largest = contourAreas(cv, contours)[0];
  // The outline's area = the component with its holes (text, stains) filled.
  if (!largest || largest.area < MIN_AREA_FRACTION * w * h) return null;
  const c = keep(contours.get(largest.i));
  const rect = cv.minAreaRect(c);
  const rectArea = rect.size.width * rect.size.height;
  const fill = rectArea > 0 ? largest.area / rectArea : 0;
  if (fill < MASK_MIN_FILL) return null;
  const quad = clampQuad(orderCorners(cv.RotatedRect.points(rect).map((p) => [p.x, p.y] as Pt)), w, h);
  if (!shapeAcceptable(quad, w, h, false)) return null;

  // Contrast: mean V inside the paper vs a band just outside it.
  const filled = keep(cv.Mat.zeros(h, w, cv.CV_8UC1));
  const one = keep(new cv.MatVector());
  one.push_back(c);
  cv.drawContours(filled, one, 0, new cv.Scalar(255), -1);
  const grown = keep(new cv.Mat());
  cv.dilate(filled, grown, kernel);
  const band = keep(new cv.Mat());
  cv.subtract(grown, filled, band);
  const contrast = cv.countNonZero(band) > 0 ? maskedMedian(v, filled) - maskedMedian(v, band) : 0;
  return { method: 'mask', quad, confidence: maskConfidence(contrast, fill) };
}

/**
 * Finds the receipt in an RGBA image. The quad is in `src`'s pixels (top-left, top-right,
 * bottom-right, bottom-left). Allocates and frees its own Mats; `src` is untouched.
 */
export function locateDocumentMat(cv: CvApi, src: CvMat): CvLocation {
  if (src.channels() !== 4) throw new RangeError('locate needs an RGBA image');
  return withMats((keep) => {
    const size = targetSize(src.cols, src.rows, LOCATE_MAX_EDGE);
    const small = keep(resizeMat(cv, src, size.width, size.height));
    const gray = keep(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    const blur = keep(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    let best = findQuad(cv, keep, blur);
    if (!best || best.confidence < QUAD_SECOND_OPINION_BELOW) {
      const mask = findMask(cv, keep, small);
      if (mask && (!best || mask.confidence > best.confidence)) best = mask;
    }
    if (!best) return NOT_FOUND;
    const quad = clampQuad(scaleQuad(best.quad, src.cols / small.cols, src.rows / small.rows), src.cols, src.rows);
    return { method: best.method, quad, confidence: best.confidence };
  });
}
