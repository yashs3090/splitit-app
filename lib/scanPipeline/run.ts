// Scan pipeline orchestration (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 "Orchestration").
// Pure: every platform-specific step comes in through the injected `StageSet`, so this file runs the
// same in the app (web and native), the browser harness and Jest. No `react-native` / `expo-*` imports.
//
// attempt(variant):
//   locate → crop (identity below minConfidence) → normalizeScale(crop) → enhance → recognize → assess
//   optional text-height second pass on the crop, only when the first read's median line height is
//   outside the target band (`textHeight.ts`); keep pickBetter of the two passes
// primary = attempt(plan.primary); if not ok and plan.retry: retry = attempt(plan.retry); best = pickBetter
//
// Endings:
// - Every image handle (the input included: the caller hands it over) is disposed once, in `finally`,
//   on success, error and abort.
// - A stage that throws `StageUnavailable` is the identity for the rest of the scan and is recorded
//   in `trace`; it never fails the scan. (Recognition has no identity: there it is `unavailable`.)
// - Aborting rejects with `RecognitionError('cancelled')` at the next step boundary (stages that
//   support the signal reject sooner). Any other error rejects with a `RecognitionError` code.
// - A `timeout` once the scan has a scored read (during the text-height second pass or the retry)
//   doesn't discard that read: the best read so far is returned, the timeout is recorded in `trace`,
//   and nothing more is tried (the reader just timed out). A timeout before any read rejects.
import { parseReceipt } from '../receiptText';
import type { ParsedReceipt, RecognizedText } from '../receiptTypes';
import { RecognitionError } from '../recognitionError';
import type { RecognitionStage } from '../textRecognition';
import { assessQuality, pickBetter } from './assessQuality';
import type { ResolvedPlan } from './config';
import { rescaleFactor } from './textHeight';
import {
  StageUnavailable,
  type Img,
  type LocateResult,
  type PipelineConfig,
  type PipelineResult,
  type ScanAttempt,
  type Scored,
  type StageContext,
  type StageName,
  type StageSet,
  type TraceEntry,
} from './types';

export type RunOptions = {
  signal?: AbortSignal;
  /** Status for the scan screen: `preparing`, `loading_engine`, `recognizing`, `retrying`. */
  onStage?: (stage: RecognitionStage) => void;
  onProgress?: (fraction: number) => void;
  /** Called as each step starts (assess included), for the harness's timings and for tests. */
  onStep?: (stage: StageName, variant: string) => void;
};

const NOT_LOCATED: LocateResult = { method: 'none', quad: null, confidence: 0 };

type Pass = Scored & { medianLineHeight: number | null };

function asRecognitionError(e: unknown): RecognitionError {
  return e instanceof RecognitionError ? e : new RecognitionError('failed');
}

const isTimeout = (e: unknown) => e instanceof RecognitionError && e.code === 'timeout';

export async function runScanPipeline(
  input: Img,
  stages: StageSet,
  plan: ResolvedPlan,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const { signal, onStage, onProgress, onStep } = opts;
  const handles: Img[] = [input];
  const unavailable = new Set<StageName>();
  const trace: TraceEntry[] = [];
  // The step that ran last, so a timeout is traced against the step it happened in.
  let current: StageName = 'normalize';
  // Set once a timeout was absorbed: no further pass or attempt is started.
  let timedOut = false;

  const track = (img: Img): Img => {
    if (!handles.includes(img)) handles.push(img);
    return img;
  };
  const checkAbort = () => {
    if (signal?.aborted) throw new RecognitionError('cancelled');
  };

  /** Runs one stage, or its identity if the stage was found unavailable earlier in this scan. */
  async function step<T>(stage: StageName, variant: string, run: () => Promise<T>, identity: () => T): Promise<T> {
    checkAbort();
    if (unavailable.has(stage)) return identity();
    current = stage;
    onStep?.(stage, variant);
    try {
      return await run();
    } catch (e) {
      if (e instanceof StageUnavailable) {
        unavailable.add(stage);
        trace.push({ variant, stage, event: 'unavailable' });
        checkAbort();
        return identity();
      }
      throw asRecognitionError(e);
    }
  }

  /** Keeps the read we have when a later step times out; anything else (cancel included) rethrows. */
  function absorbTimeout(variant: string, e: unknown): void {
    if (!isTimeout(e)) throw e;
    checkAbort();
    timedOut = true;
    trace.push({ variant, stage: current, event: 'timeout' });
  }

  function score(variant: string, text: RecognizedText): { text: RecognizedText; parsed: ParsedReceipt; verdict: Scored['verdict'] } {
    checkAbort();
    current = 'assess';
    onStep?.('assess', variant);
    const parsed = parseReceipt(text);
    return { text, parsed, verdict: assessQuality(text, parsed) };
  }

  async function attempt(variant: string, config: PipelineConfig, retrying: boolean): Promise<ScanAttempt> {
    // During the retry the screen shows one "retrying" state instead of preparing/recognizing.
    const report = (s: RecognitionStage) => {
      if (signal?.aborted) return;
      onStage?.(retrying && (s === 'preparing' || s === 'recognizing') ? 'retrying' : s);
    };
    const ctx: StageContext = {
      signal,
      onStage: report,
      onProgress,
      onFallback: (stage) => trace.push({ variant, stage, event: 'fallback' }),
    };
    const skip = (stage: StageName, reason: 'disabled' | 'low_confidence' | 'in_band' | 'no_change') =>
      trace.push({ variant, stage, event: 'skipped', reason });

    report('preparing');

    let loc = NOT_LOCATED;
    if (config.locate) {
      loc = await step('locate', variant, () => stages.locateDocument(input, ctx), () => NOT_LOCATED);
    } else skip('locate', 'disabled');

    let crop = input;
    if (config.crop === false) skip('crop', 'disabled');
    else if (loc.quad === null || !(loc.confidence >= config.crop.minConfidence)) skip('crop', 'low_confidence');
    else {
      const cropOpts = config.crop;
      crop = track(await step('crop', variant, () => stages.cropAndFlatten(input, loc, cropOpts, ctx), () => input));
    }
    const cropApplied = crop !== input;

    /** normalize (already done for pass 1) → enhance → recognize → assess. */
    async function readAt(img: Img): Promise<Pass> {
      let enhanced = img;
      if (config.enhance === false) skip('enhance', 'disabled');
      else {
        const enhanceOpts = config.enhance;
        enhanced = track(await step('enhance', variant, () => stages.enhance(img, enhanceOpts, ctx), () => img));
      }
      report('recognizing');
      const r = await step(
        'recognize',
        variant,
        () => stages.recognize(enhanced, config.recognize, ctx),
        () => {
          throw new RecognitionError('unavailable');
        },
      );
      return { ...score(variant, r.text), medianLineHeight: r.medianLineHeight };
    }

    // Strip tiling (Task 12) is decided by the platform's normalize step, on the crop's own size.
    const tiling = config.recognize.tiling === false ? {} : { tiling: config.recognize.tiling };
    const s1 =
      (await step('normalize', variant, () => stages.normalizeScale(crop, { firstPass: null, method: config.normalize, ...tiling }, ctx), () => null)) ??
      { img: crop, scale: null };
    track(s1.img);
    const scale = [s1.scale];
    let best = await readAt(s1.img);
    let passes = 1;

    if (config.textHeightRescale !== false) {
      // Only when the first read's text height is outside the target band (Task 8).
      const median = best.medianLineHeight;
      const factor = rescaleFactor(median, config.textHeightRescale);
      if (median === null || factor === null) skip('normalize', 'in_band');
      else {
        const firstPass = { medianLineHeight: median, factor };
        // The first read already exists, so a timeout from here on keeps it (R1).
        try {
          // The second pass resizes the crop, not the first-pass image, so quality isn't lost twice.
          const s2 = await step('normalize', variant, () => stages.normalizeScale(crop, { firstPass, method: config.normalize, ...tiling }, ctx), () => null);
          if (s2 === null) skip('normalize', 'no_change');
          else {
            track(s2.img);
            const second = await readAt(s2.img);
            scale.push(s2.scale);
            passes = 2;
            best = pickBetter(best, second);
          }
        } catch (e) {
          absorbTimeout(variant, e);
        }
      }
    }

    return {
      variant,
      text: best.text,
      parsed: best.parsed,
      verdict: best.verdict,
      locate: loc,
      cropApplied,
      scale,
      passes,
    };
  }

  try {
    const primary = await attempt(plan.primary.variant, plan.primary.config, false);
    const attempts = [primary];
    let best = primary;
    if (!primary.verdict.ok && plan.retry && !timedOut) {
      checkAbort();
      try {
        const retry = await attempt(plan.retry.variant, plan.retry.config, true);
        attempts.push(retry);
        best = pickBetter(primary, retry);
      } catch (e) {
        // The primary's read exists: a retry that times out (before its own first read) keeps it (R1).
        absorbTimeout(plan.retry.variant, e);
      }
    }
    checkAbort();
    return { best: { text: best.text, parsed: best.parsed, verdict: best.verdict }, attempts, trace };
  } finally {
    try {
      await stages.dispose(handles);
    } catch {
      // `dispose` must never throw; if one does anyway, it can't mask the scan's own result.
    }
  }
}
