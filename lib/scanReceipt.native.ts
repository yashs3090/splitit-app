// Native scan entry (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 / Task 3).
// Builds the native stage set from today's pieces and runs the shared pipeline.
import { deleteTempImages, prepareForRecognition } from './prepareImage';
import { RecognitionError } from './recognitionError';
import { recognizer } from './recognizer';
import type { ScanReceiptOptions } from './scanReceipt';
import { PIPELINE, resolvePlan, type PipelinePlan } from './scanPipeline/config';
import { createNativeStages } from './scanPipeline/native/stages';
import { runScanPipeline } from './scanPipeline/run';
import { asImg, type PipelineResult } from './scanPipeline/types';

export type { PipelineResult } from './scanPipeline/types';
export type { ScanReceiptOptions } from './scanReceipt';

export async function scanReceipt(
  photoUri: string,
  opts: ScanReceiptOptions = {},
  plan: PipelinePlan = PIPELINE.native,
): Promise<PipelineResult> {
  let resolved: ReturnType<typeof resolvePlan>;
  try {
    resolved = resolvePlan(plan, 'native');
  } catch {
    // The pipeline never started, so the photo is still ours to free.
    await deleteTempImages([photoUri]);
    throw new RecognitionError('failed');
  }
  // Built per scan, so the recognizer is read at scan time.
  const stages = createNativeStages({ prepareForRecognition, deleteTempImages, recognizer });
  return runScanPipeline(asImg(photoUri), stages, resolved, opts);
}
