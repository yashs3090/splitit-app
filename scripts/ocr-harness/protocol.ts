// Types shared by the harness's Node side (run.ts) and its browser page (page.ts). Types only.
// `OcrHarnessFile` is the C1 `<name>.<variant>.ocr.json` shape
// (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C1), plus the pipeline's `trace`.
import type { RecognizedLine } from '../../lib/receiptTypes';
import type { LocateMethod, Quad, TraceEntry } from '../../lib/scanPipeline/types';
import type { TileReport } from '../../lib/scanPipeline/web/stages';
import type { ZoomReport } from '../../lib/scanPipeline/zoomOnDoubt';

export type Timings = {
  decode: number;
  cvLoad: number;
  locate: number;
  crop: number;
  normalize: number;
  enhance: number;
  ocr: number;
  total: number;
};

export type Size = { width: number; height: number };

export type OcrHarnessFile = {
  version: 1;
  variant: string;
  /** `receipts/<file>`, the photo's path from the repo root. The photo itself is never copied. */
  photo: string;
  source: Size;
  /** One entry per recognition pass / strip. */
  prepared: Size[];
  /** The final lines the parser sees. */
  lines: RecognizedLine[];
  stages: {
    locate: { method: LocateMethod; confidence: number; quad: Quad | null };
    cropApplied: boolean;
    /** Per pass. null where neither the stage nor the harness can tell (a crop with today's prepare). */
    scale: (number | null)[];
    enhance: string[];
    passes: number;
    tiles: number;
    zoomRereads: number;
    retried: boolean;
  };
  meta: {
    medianLineHeight: number | null;
    meanLineConfidence: number | null;
    approximate?: true;
    /** Browser and version that produced the file (set by run.ts), e.g. "chromium 159.0.8154.6". */
    browser?: string;
    timingsMs: Timings;
    /**
     * cv variants: how many OpenCV worker calls succeeded. run.ts refuses a cv run with none
     * (`checks.ts`), so a file never claims a cv variant that silently ran without OpenCV.
     */
    cvCalls?: number;
    /** Enhance variants: what each enhance call measured, per pass (criterion 43: greyLevels > 16). */
    enhance?: { lineHeightPx: number | null; kernelPx: number | null; greyLevels: number }[];
    /**
     * Zoom variants (Task 13): one report per read that ran zoom on doubt (per pass), in order: each
     * re-read row with its text before and after, both confidences and the outcome. `zoomRereads`
     * counts the rows re-read over all of them.
     */
    zoom?: ZoomReport[];
    /**
     * Strip variants (Task 12): one report per tiled read (per pass), with each strip's image size.
     * `stages.tiles` counts the strips over all of them, and each strip is also listed in `prepared`.
     */
    tiling?: TileReport[];
  };
  trace: TraceEntry[];
};

export type HarnessRequest = {
  /** Same-origin URL of the photo on the harness server. */
  photoUrl: string;
  /** Recorded as `photo` in the output. */
  photo: string;
  variant: string;
  /** `--dump-binary`: also return Tesseract's binarized image for each read. */
  dumpBinary?: boolean;
};

export type HarnessResponse =
  /** `binaries`: PNG data URLs, one per Tesseract read in order (only with `dumpBinary`). Not part of the ocr.json. */
  | { ok: true; file: OcrHarnessFile; binaries?: string[] }
  | { ok: false; code: string };
