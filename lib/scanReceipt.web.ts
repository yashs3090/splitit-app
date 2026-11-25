// Web scan entry (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 / Task 3).
// The web stage set (and with it Tesseract.js, later OpenCV's client) is reached only through
// `import()`, so none of it is in the initial web bundle; the same discipline as `engineLoader`.
// Injects today's `prepareForRecognition` (expo-image-manipulator), which the RN-free stages can't import,
// and `prepareAtSize`, the same canvas resize at an exact size, for the text-height second pass (Task 8),
// and `prepareCropAtScale` (crop + the same resize) for zoom on doubt (Task 13; off in today's config).
import { deleteTempImages, prepareForRecognition } from './prepareImage';
// Web-only (the text-height second pass), so it isn't in the cross-platform `./prepareImage` entry.
import { prepareAtSize, prepareCropAtScale } from './prepareImage.web';
import { RecognitionError } from './recognitionError';
import type { ScanReceiptOptions } from './scanReceipt';
import { PIPELINE, resolvePlan, type PipelinePlan } from './scanPipeline/config';
import { runScanPipeline } from './scanPipeline/run';
import { asImg, type PipelineResult } from './scanPipeline/types';

export type { PipelineResult } from './scanPipeline/types';
export type { ScanReceiptOptions } from './scanReceipt';

type WebStagesModule = typeof import('./scanPipeline/web/stages');

/**
 * How the web stage set is loaded: a dynamic `import()` (a separate lazy chunk). Test seam: Jest
 * can't run `import()`, so tests replace `load` with a lazy `require`. Nothing else should touch it.
 */
export const webStagesLoader: { load: () => Promise<WebStagesModule> } = {
  load: () => import('./scanPipeline/web/stages'),
};

async function loadStages(): Promise<WebStagesModule> {
  try {
    const mod = await webStagesLoader.load();
    if (typeof mod.createWebStages !== 'function') throw new Error('stages missing');
    return mod;
  } catch {
    throw new RecognitionError('engine_load_failed', 'CHUNK_LOAD_FAILED');
  }
}

export async function scanReceipt(
  photoUri: string,
  opts: ScanReceiptOptions = {},
  plan: PipelinePlan = PIPELINE.web,
): Promise<PipelineResult> {
  let resolved: ReturnType<typeof resolvePlan>;
  let mod: WebStagesModule;
  try {
    resolved = resolvePlan(plan, 'web');
    if (opts.signal?.aborted) throw new RecognitionError('cancelled');
    mod = await loadStages();
    if (opts.signal?.aborted) throw new RecognitionError('cancelled');
  } catch (e) {
    // The pipeline never started, so the photo is still ours to free.
    await deleteTempImages([photoUri]);
    throw e instanceof RecognitionError ? e : new RecognitionError('failed');
  }
  const stages = mod.createWebStages({ prepareForRecognition, prepareAtSize, cropAtScale: prepareCropAtScale, deleteTempImages });
  try {
    return await runScanPipeline(asImg(photoUri), stages, resolved, opts);
  } finally {
    stages.close();
  }
}
