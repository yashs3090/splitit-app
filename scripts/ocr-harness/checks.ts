// Checks the harness applies to each run's result before writing it (spec Task 9 harness fix).
// Pure, so Jest covers every branch.
//
// Why: a cv variant whose OpenCV didn't load still "succeeds" — the pipeline makes the cv stages the
// identity (`StageUnavailable`) or falls back to today's resize, by design, so the app never fails a
// scan over OpenCV. For the harness that is a silent lie: the file would be labelled with the cv
// variant but hold `web-current`'s read (seen in Task 8, when `npm run web` deleted public/opencv/
// mid-run). So a cv run must show OpenCV really ran, or the harness fails and writes nothing.
import type { OcrHarnessFile } from './protocol';

/**
 * Why: the first `load` includes starting the worker and compiling OpenCV's ~11 MB of wasm, which
 * took 225–315 ms per fresh browser context on this Mac (Task 8 runs). A missing script fails in a
 * few ms (404 → worker error). 50 ms is far below any real compile and far above a failed fetch.
 * Tuned: not tuned (from the Task 8 timings, 2026-11-23).
 */
export const MIN_CV_LOAD_MS = 50;

/** Why a cv variant's run can't be trusted, or null when it can (or the variant uses no cv). */
export function cvRunProblem(usesCv: boolean, file: OcrHarnessFile): string | null {
  if (!usesCv) return null;
  const bad = file.trace.find((t) => t.event === 'unavailable' || t.event === 'fallback');
  if (bad) return `the ${bad.stage} step ran without OpenCV (${bad.event})`;
  const calls = file.meta.cvCalls ?? 0;
  if (calls < 1) return 'OpenCV was never used (no successful cv call)';
  const load = file.meta.timingsMs.cvLoad;
  if (!(load >= MIN_CV_LOAD_MS)) return `cvLoad ${load} ms is too short for OpenCV to have loaded (minimum ${MIN_CV_LOAD_MS} ms)`;
  return null;
}
