// Mean line confidence of a read (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C1 `meta`
// and C3 `RecognizeResult`). Pure; RN-free. Measurement only: the quality rule (C2) doesn't use it.
import type { RecognizedLine } from '../receiptTypes';

/**
 * The mean of the lines' `confidence` (0–100) over lines that have one; null when none do.
 * Values outside 0–100 or not finite are ignored (the engine mapping already drops them).
 */
export function meanLineConfidence(lines: readonly RecognizedLine[]): number | null {
  let sum = 0;
  let n = 0;
  for (const { confidence: c } of lines) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 100) {
      sum += c;
      n += 1;
    }
  }
  return n === 0 ? null : sum / n;
}
