// The part of OpenCV.js the worker ops use, typed structurally. Types only.
//
// Why not the package's own types (`@techstark/opencv-js`)? Its `index.d.ts` declares a global
// `var cv` for the whole program, which would let any file use an undeclared `cv` and still
// type-check. A small interface also lets the Mat-accounting tests pass a counting fake (criterion 34).
// `resize.test.ts`, `locate.test.ts` and `warp.test.ts` run the ops on the real OpenCV, so a
// mismatch with the library fails a test.

export type CvMat = {
  readonly rows: number;
  readonly cols: number;
  /** Pixel bytes (for CV_8U types). A view into wasm memory: copy before the Mat is deleted. */
  readonly data: Uint8Array;
  /** The same memory as int32 (contour points are CV_32SC2). Only read on CV_32S Mats. */
  readonly data32S: Int32Array;
  channels(): number;
  clone(): CvMat;
  delete(): void;
};

/** A vector of Mats (contours, split channels). `get(i)` returns a new handle the caller deletes. */
export type CvMatVector = {
  size(): number;
  get(i: number): CvMat;
  push_back(m: CvMat): void;
  delete(): void;
};

export type CvSize = { width: number; height: number };
export type CvPoint = { x: number; y: number };
/** `cv.Scalar` is an array of up to 4 channel values. */
export type CvScalar = number[];
export type CvRotatedRect = { center: CvPoint; size: CvSize; angle: number };

export type CvApi = {
  Mat: (new (...args: [] | [rows: number, cols: number, type: number]) => CvMat) & {
    zeros(rows: number, cols: number, type: number): CvMat;
  };
  MatVector: new () => CvMatVector;
  Size: new (width: number, height: number) => CvSize;
  Point: new (x: number, y: number) => CvPoint;
  Scalar: new (...values: number[]) => CvScalar;
  RotatedRect: { points(rect: CvRotatedRect): CvPoint[] };
  /** Contrast-limited adaptive histogram equalization (enhance). `tileGridSize` = tiles per side. */
  CLAHE: new (clipLimit: number, tileGridSize: CvSize) => { apply(src: CvMat, dst: CvMat): void; delete(): void };

  CV_8UC1: number;
  CV_8UC4: number;
  CV_16S: number;
  CV_32FC2: number;
  INTER_AREA: number;
  INTER_CUBIC: number;
  INTER_LINEAR: number;
  COLOR_GRAY2RGBA: number;
  COLOR_RGBA2GRAY: number;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2HSV: number;
  THRESH_BINARY: number;
  THRESH_BINARY_INV: number;
  THRESH_OTSU: number;
  MORPH_RECT: number;
  MORPH_CLOSE: number;
  MORPH_OPEN: number;
  RETR_EXTERNAL: number;
  RETR_LIST: number;
  CHAIN_APPROX_SIMPLE: number;
  BORDER_CONSTANT: number;
  BORDER_REPLICATE: number;

  resize(src: CvMat, dst: CvMat, size: CvSize, fx: number, fy: number, interpolation: number): void;
  cvtColor(src: CvMat, dst: CvMat, code: number, dstCn?: number): void;
  GaussianBlur(src: CvMat, dst: CvMat, ksize: CvSize, sigmaX: number): void;
  Canny(src: CvMat, dst: CvMat, threshold1: number, threshold2: number): void;
  Sobel(src: CvMat, dst: CvMat, ddepth: number, dx: number, dy: number): void;
  convertScaleAbs(src: CvMat, dst: CvMat, alpha: number, beta: number): void;
  add(a: CvMat, b: CvMat, dst: CvMat): void;
  subtract(a: CvMat, b: CvMat, dst: CvMat): void;
  /** dst = a × scale / b (saturating; 0 where b is 0). `dtype` -1 = a's depth. */
  divide(a: CvMat, b: CvMat, dst: CvMat, scale: number, dtype: number): void;
  /** Box filter. */
  blur(src: CvMat, dst: CvMat, ksize: CvSize): void;
  bitwise_and(a: CvMat, b: CvMat, dst: CvMat): void;
  /** Returns the threshold used (Otsu's, with `THRESH_OTSU`). */
  threshold(src: CvMat, dst: CvMat, thresh: number, maxval: number, type: number): number;
  rectangle(img: CvMat, p1: CvPoint, p2: CvPoint, color: CvScalar, thickness: number): void;
  getStructuringElement(shape: number, ksize: CvSize): CvMat;
  dilate(src: CvMat, dst: CvMat, kernel: CvMat): void;
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void;
  split(src: CvMat, channels: CvMatVector): void;
  findContours(image: CvMat, contours: CvMatVector, hierarchy: CvMat, mode: number, method: number): void;
  contourArea(contour: CvMat): number;
  arcLength(curve: CvMat, closed: boolean): number;
  approxPolyDP(curve: CvMat, approx: CvMat, epsilon: number, closed: boolean): void;
  isContourConvex(contour: CvMat): boolean;
  minAreaRect(points: CvMat): CvRotatedRect;
  /** `thickness` -1 fills. */
  drawContours(image: CvMat, contours: CvMatVector, index: number, color: CvScalar, thickness: number): void;
  /** Per-channel mean, over `mask`'s non-zero pixels when given. */
  mean(src: CvMat, mask?: CvMat): CvScalar;
  countNonZero(src: CvMat): number;
  matFromArray(rows: number, cols: number, type: number, values: number[]): CvMat;
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat;
  warpPerspective(src: CvMat, dst: CvMat, m: CvMat, dsize: CvSize, flags: number, borderMode: number, borderValue: CvScalar): void;
  copyMakeBorder(
    src: CvMat,
    dst: CvMat,
    top: number,
    bottom: number,
    left: number,
    right: number,
    borderType: number,
    value: CvScalar,
  ): void;
};

/** Anything OpenCV allocates in wasm memory. */
export type CvDeletable = { delete(): void };

/**
 * Runs `fn` with a `keep` function that registers OpenCV objects for deletion. Everything kept is
 * deleted when `fn` returns or throws, so an op can't leak a Mat on any path (criterion 34). A
 * result that must outlive the op is created outside, or handed over with `release`.
 */
export function withMats<T>(fn: (keep: <M extends CvDeletable>(m: M) => M, release: (m: CvDeletable) => void) => T): T {
  const owned: CvDeletable[] = [];
  const keep = <M extends CvDeletable>(m: M): M => {
    owned.push(m);
    return m;
  };
  const release = (m: CvDeletable) => {
    const i = owned.indexOf(m);
    if (i >= 0) owned.splice(i, 1);
  };
  try {
    return fn(keep, release);
  } finally {
    for (const m of owned.reverse()) {
      try {
        m.delete();
      } catch {
        // Already gone; nothing more to free.
      }
    }
  }
}
