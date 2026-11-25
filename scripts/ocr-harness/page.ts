// Browser side of the OCR harness (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 4 and C1).
// Bundled by esbuild (in memory, see run.ts) and served by server.ts on 127.0.0.1 only.
//
// It runs the app's own pipeline modules, unchanged:
// - `runScanPipeline` (lib/scanPipeline/run.ts), with the plan from `resolvePlan` (lib/scanPipeline/config.ts);
// - the web stage set `createWebStages` (lib/scanPipeline/web/stages.ts), which reads with Tesseract.js
//   through lib/webOcrSession.ts and lib/webOcrEngine.ts and the self-hosted assets in public/tesseract/;
// - today's prepare step, rebuilt from expo-image-manipulator's web source (prepare-current.ts), in the
//   place the app injects lib/prepareImage.web.ts.
// The photo is fetched from the local server and turned into a blob: URL, as the web picker does.
// Nothing here starts a Tesseract worker itself, and nothing leaves the page except the result object.
import { resolvePlan, usesCv, VARIANTS } from '../../lib/scanPipeline/config';
import { createCvClient, type CvClient } from '../../lib/scanPipeline/web/cvClient';
import { runScanPipeline } from '../../lib/scanPipeline/run';
import { meanLineConfidence } from '../../lib/scanPipeline/lineConfidence';
import { medianLineHeight } from '../../lib/scanPipeline/textHeight';
import { asImg, type StageName } from '../../lib/scanPipeline/types';
import { createWebStages, type TileReport } from '../../lib/scanPipeline/web/stages';
import { RecognitionError } from '../../lib/recognitionError';
import type { ZoomReport } from '../../lib/scanPipeline/zoomOnDoubt';
import { naturalSize, prepareCurrent, prepareCurrentAtSize, prepareCurrentCropAtScale, revokeTempImages } from './prepare-current';
import type { HarnessRequest, HarnessResponse, Timings } from './protocol';

function now(): number {
  return performance.now();
}

const STEP_TIMING: Partial<Record<StageName, keyof Timings>> = {
  locate: 'locate',
  crop: 'crop',
  normalize: 'normalize',
  enhance: 'enhance',
  recognize: 'ocr',
};

async function run(req: HarnessRequest): Promise<HarnessResponse> {
  const timings: Timings = { decode: 0, cvLoad: 0, locate: 0, crop: 0, normalize: 0, enhance: 0, ocr: 0, total: 0 };
  const t0 = now();

  let photoUri: string;
  let source: { width: number; height: number };
  try {
    const res = await fetch(req.photoUrl);
    if (!res.ok) return { ok: false, code: 'photo_fetch_failed' };
    photoUri = URL.createObjectURL(await res.blob());
    source = await naturalSize(photoUri);
  } catch {
    return { ok: false, code: 'photo_decode_failed' };
  }
  timings.decode = now() - t0;

  // Every prepared image, in pass order (one per normalize call that produced an image).
  const prepared: { width: number; height: number }[] = [];
  const config = VARIANTS[req.variant]?.config;
  const cvOn = config ? usesCv(config) : false;
  /** Successful OpenCV worker calls (run.ts refuses a cv run with none) and what each enhance measured. */
  let cvCalls = 0;
  const enhanceInfo: { lineHeightPx: number | null; kernelPx: number | null; greyLevels: number }[] = [];
  const counted = async <T>(p: Promise<T>): Promise<T> => {
    const v = await p;
    cvCalls += 1;
    return v;
  };
  /**
   * The app's own cv client, wrapped only to measure: `resize` is the cv normalize step, so its output
   * size is the prepared size; the first `load` (worker start-up + OpenCV compile, overlapping the
   * photo decode) is reported as `cvLoad`; every successful call is counted; enhance's measurements
   * are kept for `meta.enhance`.
   */
  const openCvClient = (): CvClient => {
    const c = createCvClient();
    let first = true;
    return {
      ...c,
      get started() {
        return c.started;
      },
      async load(uri, signal) {
        const t = now();
        try {
          return await counted(c.load(uri, signal));
        } finally {
          if (first) timings.cvLoad = now() - t;
          first = false;
        }
      },
      async resize(id, width, height, signal) {
        const out = await counted(c.resize(id, width, height, signal));
        prepared.push({ width: out.width, height: out.height });
        return out;
      },
      locate: (id, signal) => counted(c.locate(id, signal)),
      warp: (id, quad, margin, signal) => counted(c.warp(id, quad, margin, signal)),
      encode: (id, format, signal) => counted(c.encode(id, format, signal)),
      async enhance(id, steps, signal) {
        const out = await counted(c.enhance(id, steps, signal));
        enhanceInfo.push({ lineHeightPx: out.lineHeightPx, kernelPx: out.kernelPx, greyLevels: out.greyLevels });
        return out;
      },
    };
  };
  // Tesseract's binarized image per read (`--dump-binary`), in read order.
  const binaries: string[] = [];
  // What zoom on doubt did on each read that ran it (Task 13), in read order.
  const zooms: ZoomReport[] = [];
  // Each tiled read's strips (Task 12); each strip is a recognition image, so it is listed in `prepared`.
  const tilings: TileReport[] = [];
  const stages = createWebStages({
    onZoom: (report) => zooms.push(report),
    onTiles: (report) => {
      tilings.push(report);
      prepared.push(...report.strips);
    },
    // Zoom's row crops: not a recognition pass, so not listed in `prepared`.
    cropAtScale: prepareCurrentCropAtScale,
    ...(req.dumpBinary ? { onImageBinary: (png: string) => binaries.push(png) } : {}),
    cvPreprocess: cvOn,
    openCvClient,
    async prepareForRecognition(uri) {
      const p = await prepareCurrent(uri);
      prepared.push({ width: p.width, height: p.height });
      return p;
    },
    async prepareAtSize(uri, size) {
      const p = await prepareCurrentAtSize(uri, size);
      prepared.push({ width: p.width, height: p.height });
      return p;
    },
    deleteTempImages: revokeTempImages,
  });

  // Each step's time runs from its start to the next step's start (or the end of the run).
  let open: { key: keyof Timings | null; at: number } | null = null;
  const closeOpen = (at: number) => {
    if (open?.key) timings[open.key] += at - open.at;
    open = null;
  };

  try {
    const plan = resolvePlan({ primary: req.variant, retry: null }, 'web');
    const result = await runScanPipeline(asImg(photoUri), stages, plan, {
      onStage(stage) {
        window.__ocrHarnessStep = stage;
      },
      onStep(stage) {
        window.__ocrHarnessStep = stage;
        const at = now();
        closeOpen(at);
        open = { key: STEP_TIMING[stage] ?? null, at };
      },
    });
    closeOpen(now());
    timings.total = now() - t0;

    const attempt = result.attempts[0];
    if (!attempt) return { ok: false, code: 'no_attempt' };
    const lines = result.best.text.lines;
    // Today's prepare step doesn't report its factor; without a crop it is prepared / source.
    const scale = attempt.scale.map((s, i) => {
      if (s !== null) return s;
      const p = prepared[i];
      return !attempt.cropApplied && p ? p.width / source.width : null;
    });
    return {
      ok: true,
      file: {
        version: 1,
        variant: req.variant,
        photo: req.photo,
        source,
        prepared,
        lines,
        stages: {
          locate: { method: attempt.locate.method, confidence: attempt.locate.confidence, quad: attempt.locate.quad },
          cropApplied: attempt.cropApplied,
          scale,
          enhance: enhanceSteps(plan.primary.config.enhance),
          passes: attempt.passes,
          tiles: tilings.reduce((n, t) => n + t.strips.length, 0),
          zoomRereads: zooms.reduce((n, z) => n + z.rows.length, 0),
          retried: result.attempts.length > 1,
        },
        meta: {
          medianLineHeight: medianLineHeight(result.best.text),
          meanLineConfidence: meanLineConfidence(lines),
          timingsMs: roundTimings(timings),
          ...(cvOn ? { cvCalls } : {}),
          ...(enhanceInfo.length > 0 ? { enhance: enhanceInfo } : {}),
          ...(zooms.length > 0 ? { zoom: zooms } : {}),
          ...(tilings.length > 0 ? { tiling: tilings } : {}),
        },
        trace: result.trace,
      },
      ...(req.dumpBinary ? { binaries } : {}),
    };
  } catch (e) {
    return { ok: false, code: e instanceof RecognitionError ? e.code : 'failed' };
  } finally {
    stages.close();
  }
}

function enhanceSteps(opts: ReturnType<typeof resolvePlan>['primary']['config']['enhance']): string[] {
  if (opts === false) return [];
  const steps: string[] = [];
  if (opts.gray) steps.push('gray');
  if (opts.flatten) steps.push(`flatten:${opts.flatten.kernelLineHeights}`);
  if (opts.clahe) steps.push(`clahe:${opts.clahe.clipLimit}/${opts.clahe.tile}`);
  return steps;
}

function roundTimings(t: Timings): Timings {
  const r = (v: number) => Math.round(v);
  return {
    decode: r(t.decode),
    cvLoad: r(t.cvLoad),
    locate: r(t.locate),
    crop: r(t.crop),
    normalize: r(t.normalize),
    enhance: r(t.enhance),
    ocr: r(t.ocr),
    total: r(t.total),
  };
}

declare global {
  interface Window {
    __ocrHarness?: { run(req: HarnessRequest): Promise<HarnessResponse> };
    /** The last pipeline step or status, read by run.ts when a run times out. */
    __ocrHarnessStep?: string;
  }
}

window.__ocrHarness = { run };
