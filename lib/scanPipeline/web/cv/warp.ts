// cropAndFlatten on web (spec Task 7): a perspective warp of the located quad at full decoded
// resolution, then a margin padded with the crop's median border colour. Takes `cv` as a parameter.
//
// - Output size: each side as long as the longer of its two opposite edges (`warpGeometry`), so the
//   far, foreshortened end of the receipt is stretched to the near end's pixel density instead of
//   the near end being shrunk.
// - Margin: `max(MIN_MARGIN_PX, marginFraction × short side)` on every side (tessdoc wants ~10 px of
//   background around text; a tight crop clips glyphs, a big background wastes the size budget).
// - The margin is padding, not the photo around the quad: that would bring the table back in.
//   Its colour is the median of the warped crop's outer ring, i.e. the paper's own colour.
import type { Quad } from '../../types';
import { withMats, type CvApi, type CvMat } from './cvApi';
import { warpGeometry } from './geometry';

/**
 * Why: the ring sampled for the padding colour. Two pixels sit inside a correctly located paper edge
 * but outside most text (tessdoc's 10 px margin means text rarely reaches the very edge), and the
 * median ignores the few that are background or ink. Tuned: not tuned (implementation choice, Task 7).
 */
export const BORDER_RING_PX = 2;

/** Per-channel median of the outer `ring` pixels of an RGBA Mat. */
export function medianBorderColour(rgba: CvMat, ring = BORDER_RING_PX): [number, number, number] {
  const w = rgba.cols;
  const h = rgba.rows;
  const r = Math.max(1, Math.min(ring, Math.floor(Math.min(w, h) / 2)));
  const ch: number[][] = [[], [], []];
  const d = rgba.data;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < r || y >= h - r;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= r && x < w - r) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) ch[c]!.push(d[i + c] ?? 0);
    }
  }
  const med = (a: number[]) => {
    a.sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)] ?? 255;
  };
  return [med(ch[0]!), med(ch[1]!), med(ch[2]!)];
}

/**
 * A new RGBA Mat (the caller owns it): `src` inside `quad` flattened to a rectangle, plus the margin.
 * `quad` is in `src`'s pixels, ordered top-left, top-right, bottom-right, bottom-left.
 * Throws RangeError for a degenerate quad; frees everything it allocated on any failure.
 */
export function warpQuad(cv: CvApi, src: CvMat, quad: Quad, marginFraction: number): CvMat {
  if (src.channels() !== 4) throw new RangeError('warp needs an RGBA image');
  const { width, height, margin } = warpGeometry(quad, marginFraction);
  const out = new cv.Mat();
  try {
    withMats((keep) => {
      const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat()));
      const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]));
      const m = keep(cv.getPerspectiveTransform(from, to));
      const flat = keep(new cv.Mat());
      // Cubic, like the cv resize going up: the warp is roughly 1:1 and stretches the far end a little.
      // Replicate the edge: corners exactly on the photo border must not pull in black.
      cv.warpPerspective(src, flat, m, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
      const [r, g, b] = medianBorderColour(flat);
      cv.copyMakeBorder(flat, out, margin, margin, margin, margin, cv.BORDER_CONSTANT, new cv.Scalar(r, g, b, 255));
    });
    return out;
  } catch (e) {
    out.delete();
    throw e;
  }
}
