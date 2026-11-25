// Types for the staged scan pipeline (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C2 and C3).
//
// Types only, apart from the `StageUnavailable` error class. No `react-native` or `expo-*` imports:
// the pipeline is shared by the app, the browser harness and the eval (criterion 15).
import type { ParsedReceipt, RecognizedText } from '../receiptTypes';
import type { RecognitionStage } from '../textRecognition';

// ---------- images and geometry ----------

/**
 * An opaque, platform-owned image handle. On web it is an image id held inside the OpenCV worker,
 * or a blob URL; on native it is a `file://` URI. Only the platform's own stages look inside it;
 * the orchestration only passes it along and hands it to `dispose`.
 */
export type Img = string & { readonly __scanImg: unique symbol };

/** Marks a platform string (worker id, blob URL, file URI) as an `Img`. For stage implementations. */
export function asImg(handle: string): Img {
  return handle as Img;
}

/** A point in image pixels, top-left origin: `[x, y]`. */
export type Pt = [number, number];
/** Corners of the receipt, in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

// ---------- stage names and context ----------

export type StageName = 'locate' | 'crop' | 'normalize' | 'enhance' | 'recognize' | 'assess';

/** Passed to every stage. */
export type StageContext = {
  /** Aborting makes the stage reject with `RecognitionError('cancelled')`. */
  signal?: AbortSignal;
  /**
   * For the scan screen's status text. The orchestration reports `preparing` / `recognizing`
   * (`retrying` during the second try); a recognize stage may report `loading_engine` and
   * `recognizing` itself.
   */
  onStage?: (stage: RecognitionStage) => void;
  /** Fraction 0–1 of the current stage, for stages that can report it. */
  onProgress?: (fraction: number) => void;
  /**
   * A stage that couldn't use its preferred tool (OpenCV) and fell back to today's way of doing the
   * step reports it here, so the trace shows the variant didn't run as configured. The stage
   * still produced a result; this is not `StageUnavailable` (which makes the stage the identity).
   */
  onFallback?: (stage: StageName) => void;
};

/**
 * Thrown by a stage that can't run on this device or right now (for example OpenCV failing to
 * load). The orchestration treats that stage as the identity for the rest of the scan and records
 * it in the trace; it never fails the scan (C3). Fixed message only, like `RecognitionError`.
 */
export class StageUnavailable extends Error {
  readonly stage: StageName;

  constructor(stage: StageName) {
    super(`The ${stage} step is not available.`);
    this.name = 'StageUnavailable';
    this.stage = stage;
  }
}

// ---------- stage inputs and outputs ----------

export type LocateMethod = 'quad' | 'mask' | 'os-scanner' | 'none';

export type LocateResult = {
  method: LocateMethod;
  quad: Quad | null;
  /** 0–1. Below `CropOptions.minConfidence` the crop is the identity. */
  confidence: number;
};

export type CropOptions = {
  /** Margin added on every side of the quad, as a fraction of the crop's short side. */
  marginFraction: number;
  /** The crop applies at `confidence >= minConfidence` and is the identity below it. */
  minConfidence: number;
};

/**
 * The text-height second pass (Task 8): what the first read measured, and the factor the
 * orchestration chose from it (`rescaleFactor` in `textHeight.ts`: target / median, clamped).
 * The stage resizes the crop to the first-pass image's size × `factor`, capped at
 * `RECOGNITION_MAX_EDGE`. It is only called when the median was outside the band.
 */
export type FirstPass = { medianLineHeight: number; factor: number };

/**
 * How `normalizeScale` resizes on web: `prepare` = today's `prepareForRecognition`
 * (expo-image-manipulator's canvas resize, JPEG); `cv` = OpenCV in the worker (INTER_AREA down,
 * INTER_CUBIC up), encoded by `recognize` as `RecognizeConfig.output`. Native ignores it.
 */
export type NormalizeMethod = 'prepare' | 'cv';

/** `scale` is the factor applied, or null when the stage doesn't measure it (today's prepare step). */
export type NormalizeResult = { img: Img; scale: number | null };

export type EnhanceOptions =
  | false
  | {
      gray: boolean;
      /** Background flattening; the kernel is this many median line heights. */
      flatten: false | { kernelLineHeights: number };
      clahe: false | { clipLimit: number; tile: number };
    };

/** Strip tiling for tall receipts (Task 12 defines the starting values). */
export type TilingOptions = {
  /** Tile only when crop height / width is at least this. */
  minAspect: number;
  /** ...and the long edge exceeds this multiple of `RECOGNITION_MAX_EDGE`. */
  minOverscale: number;
  /** A row is blank when its ink is at most this fraction of the width. */
  blankInkFraction: number;
  /** Each cut is searched within ± this fraction of the target strip height. */
  cutWindowFraction: number;
  maxStrips: number;
};

/** Zoom on doubt: re-read doubtful rows larger (Task 13 defines the starting values). */
export type ZoomOptions = {
  /** A line below this confidence (0–100) is a candidate. */
  minLineConfidence: number;
  maxRows: number;
  /** A re-read is accepted only if its confidence rises by at least this much (0–100 scale). */
  minConfidenceGain: number;
  /**
   * The line-box height (px) each re-read row is scaled to: the variant's text-height target
   * (Task 8), or `ZOOM_DEFAULT_TARGET_PX` without one. Same unit as `textHeightRescale`.
   */
  targetLineHeightPx: number;
};

export type RecognizeConfig = {
  tesseract?: { params: Record<string, string>; init?: Record<string, string>; rotateAuto?: boolean };
  output?: 'png' | 'jpeg90';
  tiling: false | TilingOptions;
  zoomOnDoubt: false | ZoomOptions;
};

export type RecognizeResult = {
  text: RecognizedText;
  /** Median line-box height in pixels of the image read; null when no line had a box. */
  medianLineHeight: number | null;
  /** Mean line confidence 0–100; null when the engine gives none. */
  meanLineConfidence: number | null;
};

/** One platform's implementation of the stages. `assessQuality` is pure and shared, so it isn't here. */
export type StageSet = {
  locateDocument(img: Img, ctx: StageContext): Promise<LocateResult>;
  /** The identity (returns `img`) when `loc.quad` is null or `loc.confidence < opts.minConfidence`. */
  cropAndFlatten(img: Img, loc: LocateResult, opts: CropOptions, ctx: StageContext): Promise<Img>;
  /**
   * `firstPass: null` applies the image-size rule to this image (the crop). With a first pass it
   * resizes this image (the crop again, never the first-pass image) to the first-pass size ×
   * `firstPass.factor`, and returns null when that changes nothing (already at the size cap) or the
   * platform has no second pass.
   */
  normalizeScale(
    img: Img,
    opts: {
      firstPass: FirstPass | null;
      method?: NormalizeMethod;
      /**
       * Strip tiling (Task 12; set only when the variant tiles). A platform that tiles may return a
       * handle that stands for "this image, read in strips at `scale`" instead of a resized image,
       * when the image is tall enough (`stripTiling.ts`); otherwise it applies the size rule as usual.
       */
      tiling?: TilingOptions;
    },
    ctx: StageContext,
  ): Promise<NormalizeResult | null>;
  /** The identity when `opts` is false. Never binarizes the image that is read. */
  enhance(img: Img, opts: EnhanceOptions, ctx: StageContext): Promise<Img>;
  recognize(img: Img, config: RecognizeConfig, ctx: StageContext): Promise<RecognizeResult>;
  /** Frees handles. Never throws. */
  dispose(imgs: Img[]): Promise<void>;
};

// ---------- config ----------

export type PipelineConfig = {
  locate: boolean;
  crop: CropOptions | false;
  /** Unset = `prepare` (today's path). */
  normalize?: NormalizeMethod;
  enhance: EnhanceOptions;
  textHeightRescale: false | { targetLineHeightPx: number; band: [number, number] };
  recognize: RecognizeConfig;
};

// ---------- quality verdict (C2) ----------

export type ScanProblem = 'no_items' | 'too_few_lines' | 'no_total' | 'items_vs_subtotal' | 'subtotal_vs_total';

export type QualityVerdict = {
  /** true iff `problems` is empty. */
  ok: boolean;
  problems: ScanProblem[];
  /** Σ|gap| over the parser's totals checks, in cents, whether or not a gap is within tolerance. */
  gapCents: number;
};

/** What `pickBetter` compares: one finished read. */
export type Scored = { text: RecognizedText; parsed: ParsedReceipt; verdict: QualityVerdict };

// ---------- pipeline result ----------

/** `variant` is the `VARIANTS` key of the attempt the entry belongs to. */
export type TraceEntry =
  | { variant: string; stage: StageName; event: 'unavailable' }
  /** The stage ran, but with today's method instead of the configured one (see `onFallback`). */
  | { variant: string; stage: StageName; event: 'fallback' }
  /**
   * A step timed out (`RecognitionError('timeout')`) after the scan already had a scored read: the
   * best read so far is kept and nothing more is tried (review R1, criterion 23). A timeout before
   * any read still rejects the scan.
   */
  | { variant: string; stage: StageName; event: 'timeout' }
  /**
   * `in_band`: the first read's text height needs no second pass (or none was measured);
   * `no_change`: a second pass was wanted, but the stage couldn't change the size (at the cap).
   */
  | { variant: string; stage: StageName; event: 'skipped'; reason: 'disabled' | 'low_confidence' | 'in_band' | 'no_change' };

export type ScanAttempt = Scored & {
  /** The `VARIANTS` key this attempt ran. */
  variant: string;
  locate: LocateResult;
  cropApplied: boolean;
  /** One scale per recognition pass (null where the stage doesn't measure it). */
  scale: (number | null)[];
  passes: number;
};

export type PipelineResult = {
  best: Scored;
  attempts: ScanAttempt[];
  trace: TraceEntry[];
};
