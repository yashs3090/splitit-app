// Type-only entry for `./scanReceipt` (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3).
// Metro and Jest resolve `scanReceipt.native.ts` (identity stubs + today's prepare and on-device
// recognizer) or `scanReceipt.web.ts` (the lazily imported web stage set) by platform; TypeScript
// resolves this file. Same pattern as `lib/prepareImage.ts`.
import type { PipelinePlan } from './scanPipeline/config';
import type { PipelineResult } from './scanPipeline/types';
import type { RecognitionStage } from './textRecognition';

export type { PipelineResult } from './scanPipeline/types';

export type ScanReceiptOptions = {
  /** Aborting rejects with `RecognitionError('cancelled')` and frees everything the scan created. */
  signal?: AbortSignal;
  onStage?: (stage: RecognitionStage) => void;
  onProgress?: (fraction: number) => void;
};

/**
 * Runs the platform's scan pipeline on a captured photo. The photo's URI is handed over: it is
 * deleted (native cache file) or revoked (web blob: URL) with every intermediate image when the
 * scan ends, however it ends. Rejects only with `RecognitionError`.
 * `plan` is for tests and tools; the app passes nothing and gets `PIPELINE[platform]`.
 */
export declare function scanReceipt(
  photoUri: string,
  opts?: ScanReceiptOptions,
  plan?: PipelinePlan,
): Promise<PipelineResult>;
