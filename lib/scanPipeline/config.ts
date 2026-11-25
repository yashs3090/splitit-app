// Scan pipeline configuration (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 "Config").
// Pure data. The only place the app, the browser harness and the eval read variants from.
//
// The starting values keep today's behaviour: no locate, crop, enhance or text-height pass, no
// retry, and on web the photo is resized by today's `prepareForRecognition` and read with today's
// Tesseract settings. Only Task 14 changes `PIPELINE` and `WEB_CV_PREPROCESS`, and only from results.
// Every numeric constant added here carries a `Why:` and a `Tuned:` comment (criterion 71).
import { DEFAULT_TILING } from './stripTilingOptions';
import { TEXT_HEIGHT_BAND } from './textHeight';
import type { CropOptions, PipelineConfig, ZoomOptions } from './types';
import { MAX_ZOOM_ROWS, ZOOM_DEFAULT_TARGET_PX, ZOOM_LOW_CONFIDENCE, ZOOM_MIN_CONFIDENCE_GAIN } from './zoomOnDoubt';

export type Platform = 'web' | 'native';

export type Variant = { platform: Platform; config: PipelineConfig };

/** A primary variant and an optional automatic retry, by `VARIANTS` key. */
export type PipelinePlan = { primary: string; retry: string | null };

/** A plan with its configs looked up, as `runScanPipeline` takes it. */
export type ResolvedPlan = {
  primary: { variant: string; config: PipelineConfig };
  retry: { variant: string; config: PipelineConfig } | null;
};

/** Today's path: every new stage off. */
const CURRENT: PipelineConfig = {
  locate: false,
  crop: false,
  enhance: false,
  textHeightRescale: false,
  // `tesseract` unset = the engine's own settings (`TESSERACT_PARAMS` in lib/webOcrEngine.ts: PSM 6,
  // preserve_interword_spaces). Not imported here: that module pulls in tesseract.js, and this file
  // is in the entry bundle. Task 5 adds per-variant parameters.
  recognize: { tiling: false, zoomOnDoubt: false },
};

/**
 * The core crop (spec Task 7, D4). Starting values from the spec; `locate.ts` / `geometry.ts` hold the
 * detection constants and the 10 px margin floor.
 */
export const WEB_CROP: CropOptions = {
  /**
   * Why: about 2–3% of background around the text on every side (at least 10 px, tessdoc): a tight
   * crop clips glyphs at the paper's edge, a big one spends the size budget on background.
   * Tuned: not tuned (spec starting value; E5 pending checked ground truth).
   */
  marginFraction: 0.025,
  /**
   * Why: halfway on locate's 0–1 scale: a quad's edges at least twice as strong as the image's
   * average texture, or a paper mask with at least 30 levels of contrast. Below that the detection
   * is as likely wrong as right, and the whole photo (today's input) is the safer choice.
   * Tuned: not tuned (spec starting value; E5 pending checked ground truth).
   */
  minConfidence: 0.5,
};

// ---------- Tesseract settings (spec Task 5: E1 and E4) ----------
// Each variant is `web-current` plus one Tesseract setting (two for the E1 crossing, which is one
// factor against `web-tess-dpi300`). `params` apply to that read only, on top of the engine's
// `TESSERACT_PARAMS` (PSM 6, preserve_interword_spaces 1); `init` is applied when the worker starts.
// Checked against tesseract.js 7.0.0 / its Tesseract fork (2026-11-23): `thresholding_method`,
// `user_defined_dpi` and `preserve_interword_spaces` are ordinary variables; the dictionaries are
// init-only.

/**
 * Parameters tesseract.js 7.0.0 accepts only at init (`initParamNames` in
 * `node_modules/tesseract.js/src/worker-script/index.js#setParameters`). Set per read they do
 * nothing, so a variant must put them in `init`, never in `params` (checked by config.test.ts).
 */
export const TESSERACT_INIT_ONLY_PARAMS: readonly string[] = [
  'ambigs_debug_level', 'user_words_suffix', 'user_patterns_suffix', 'load_system_dawg', 'load_freq_dawg',
  'load_unambig_dawg', 'load_punc_dawg', 'load_number_dawg', 'load_bigram_dawg', 'tessedit_ocr_engine_mode',
  'tessedit_init_config_only', 'language_model_ngram_on', 'language_model_use_sigmoidal_certainty',
];

/**
 * Ordinary Tesseract variables that are only read while the worker initializes, so they too must go
 * in `init`. `lstm_use_matrix`: the wasm build contains Tesseract's own line
 * `lstm_recognizer_->Load(this->params(), lstm_use_matrix ? language : "", mgr)`, i.e. the LSTM
 * loads its dictionaries (lstm-word-dawg etc.) at init only when it is on.
 */
export const TESSERACT_READ_AT_INIT_PARAMS: readonly string[] = ['lstm_use_matrix'];

/**
 * DPI to tell Tesseract the image has.
 * Why: canvas-made JPEG/PNG images carry no usable resolution, so Tesseract estimates one (or falls
 * back to 70 dpi), and every DPI-relative size scales with it: the LeptonicaOtsu tile and Sauvola
 * window (`*_size × dpi`) and the noise limits in layout analysis. At 70 dpi those windows are about
 * 23 px, small next to text in a 2048 px photo. 300 dpi is tessdoc's reference scan resolution, and a
 * receipt (about 3 in wide) filling a 2048 px photo is in the 200–400 px-per-inch range.
 * Tuned: E1, 2026-11-23: no change with Otsu, and it didn't rescue methods 1/2 (spec Results log). Only 1
 * checked tuning receipt, no held-out run; not adopted.
 */
export const TESSERACT_DPI = '300';

/** Tesseract's `thresholding_method` values ("0 = Otsu, 1 = LeptonicaOtsu, 2 = Sauvola", from the wasm's own help text). */
export const THRESHOLDING = { otsu: '0', adaptiveOtsu: '1', sauvola: '2' } as const;

/**
 * Word dictionaries off: the system word list and the frequent-words list.
 * Why: receipt item names are abbreviations, brand and dish names ("CHKN SAND", "Lomo Saltado") that
 * aren't English dictionary words, and the dictionary pulls the decoder toward real words; tessdoc
 * recommends turning off `load_system_dawg` and `load_freq_dawg` when most text isn't dictionary words.
 * The number and punctuation patterns stay on: prices and totals are what they describe.
 * Tuned: E4, 2026-11-23: no effect at all in OEM 1 (byte-identical reads); not adopted. See `web-tess-nolstmdict`.
 */
export const NO_WORD_DICTIONARIES: Readonly<Record<string, string>> = { load_system_dawg: '0', load_freq_dawg: '0' };

function withTesseract(t: NonNullable<PipelineConfig['recognize']['tesseract']>): PipelineConfig {
  return { ...CURRENT, recognize: { ...CURRENT.recognize, tesseract: t } };
}

const TESSERACT_VARIANTS: Record<string, Variant> = {
  /** E1: tell Tesseract the image is 300 dpi (`TESSERACT_DPI`). One factor vs `web-current`. */
  'web-tess-dpi300': { platform: 'web', config: withTesseract({ params: { user_defined_dpi: TESSERACT_DPI } }) },
  /**
   * E1: global Otsu set explicitly. Tesseract's default, so it should read exactly as `web-current`;
   * it checks that the per-read parameter path itself changes nothing.
   */
  'web-tess-thresh0': { platform: 'web', config: withTesseract({ params: { thresholding_method: THRESHOLDING.otsu } }) },
  /**
   * E1: Leptonica adaptive Otsu (tile-wise thresholds). Why: one global threshold fails under uneven
   * light (a hand's shadow, a gradient across the photo); a per-tile threshold follows it. The
   * binarized image only drives layout and line finding: the LSTM still reads the grey pixels.
   */
  'web-tess-thresh1': { platform: 'web', config: withTesseract({ params: { thresholding_method: THRESHOLDING.adaptiveOtsu } }) },
  /** E1: Sauvola (local mean and deviation). Why: as adaptive Otsu, and it keeps faint thermal strokes better on uneven paper. */
  'web-tess-thresh2': { platform: 'web', config: withTesseract({ params: { thresholding_method: THRESHOLDING.sauvola } }) },
  /** E1 crossing: adaptive Otsu at 300 dpi, so its tile spans several text lines. One factor vs `web-tess-dpi300`. */
  'web-tess-thresh1-dpi300': {
    platform: 'web',
    config: withTesseract({ params: { thresholding_method: THRESHOLDING.adaptiveOtsu, user_defined_dpi: TESSERACT_DPI } }),
  },
  /** E1 crossing: Sauvola at 300 dpi, so its window covers several character heights. One factor vs `web-tess-dpi300`. */
  'web-tess-thresh2-dpi300': {
    platform: 'web',
    config: withTesseract({ params: { thresholding_method: THRESHOLDING.sauvola, user_defined_dpi: TESSERACT_DPI } }),
  },
  /**
   * E4: tesseract.js measures the text's skew and reads the image straightened. Why: a hand-held
   * photo is rarely level, and a few degrees of tilt make PSM 6's line finding merge or split rows.
   * Small skew only; perspective is the crop's job (Task 7).
   */
  'web-tess-rotate': { platform: 'web', config: withTesseract({ params: {}, rotateAuto: true }) },
  /** E4: word dictionaries off (`NO_WORD_DICTIONARIES`, init-only). One factor vs `web-current`. */
  'web-tess-nodict': { platform: 'web', config: withTesseract({ params: {}, init: NO_WORD_DICTIONARIES }) },
  /**
   * E4, second form: the LSTM's own dictionaries off (`lstm_use_matrix 0` at init, so the LSTM loads
   * no lstm-word/punc/number dawg). Why: `web-tess-nodict` read byte-identically to `web-current` on
   * every photo (2026-11-23), which suggests the `load_*_dawg` flags don't reach the LSTM's
   * dictionary in OEM 1; this is the switch the LSTM itself reads. Same reason as `NO_WORD_DICTIONARIES`.
   */
  'web-tess-nolstmdict': { platform: 'web', config: withTesseract({ params: {}, init: { lstm_use_matrix: '0' } }) },
  /**
   * Today's `preserve_interword_spaces=1` turned off. Why measure it: lines are rebuilt from words
   * joined by one space, so it should only matter where a line has no word list; this checks that.
   */
  'web-tess-no-interword': { platform: 'web', config: withTesseract({ params: { preserve_interword_spaces: '0' } }) },
};

// ---------- Text-height second pass (spec Task 8: E2) ----------
// Each is `web-crop-canvas` (OpenCV locate + flatten, today's canvas resize on the crop) plus the
// second pass, so against `web-crop-canvas` the second pass is the only factor. The first pass is the
// image-size rule on the crop; a second read happens only when its median line-box height is outside
// target × TEXT_HEIGHT_BAND, and it resizes the crop (not the first-pass JPEG), with the same resampler.

/**
 * Line-box heights (px) to aim for. A Tesseract line box spans ascenders to descenders, roughly 1.4×
 * the capital height (an assumption, not yet checked against `--dump-binary`), so these are capitals
 * of about 20, 25, 30 and 35 px.
 * Why: Tesseract's error tracks glyph height in pixels, with its best range around 20–35 px capitals
 * (report § "Character height"; tessdoc's "x-height of at least 20 px"); below that strokes fuse,
 * above it the LSTM sees glyphs larger than it was trained on. Sizing by text height instead of by
 * image size is general: a small receipt in a big frame and a sharp close-up need opposite resizes.
 * Tuned: E2, 2026-11-23 (spec Results log), 8 photos, only 1 checked tuning receipt, no held-out run:
 * no target changed that receipt's score, so none is adopted. On the unchecked photos 34 and 40 undid
 * the one read the crop broke (its lines fell to 24 px) and broke none; 40 needed the fewest second reads.
 */
export const TEXT_HEIGHT_TARGETS_PX = [28, 34, 40, 46] as const;

function withTextHeight(base: PipelineConfig, targetLineHeightPx: number): PipelineConfig {
  return { ...base, textHeightRescale: { targetLineHeightPx, band: TEXT_HEIGHT_BAND } };
}

const CROP_CANVAS: PipelineConfig = { ...CURRENT, locate: true, crop: WEB_CROP };

/**
 * Tesseract page segmentation mode 4: "a single column of text of variable sizes".
 * Why: a receipt is one column, and the engine's PSM 6 (one uniform block) was chosen over 4 on a
 * whole rendered page where 4 dropped the right-aligned price column (`TESSERACT_PARAMS` in
 * lib/webOcrEngine.ts). Once the photo is cropped to the paper, the table and background that could
 * split the layout into columns are gone, so 4 is worth re-checking after the crop (spec Task 7, A4).
 * Tuned: 2026-11-25, 8 photos, 3 checked tuning receipts, no held-out run (spec Results log, "PSM 4
 * after crop"): +1 item (below the guard) but a checked total lost and OK 2/8 → 0/8. Not adopted; PSM 6 stays.
 */
export const PSM_SINGLE_COLUMN = '4';

const CROP_VARIANTS: Record<string, Variant> = {
  /**
   * PSM 4 re-check after the crop: `web-crop-canvas` with page segmentation 4 for the read, set through
   * `recognize`'s options (A4), so against `web-crop-canvas` the PSM is the only factor.
   */
  'web-crop-canvas-psm4': {
    platform: 'web',
    config: { ...CROP_CANVAS, recognize: { ...CROP_CANVAS.recognize, tesseract: { params: { tessedit_pageseg_mode: PSM_SINGLE_COLUMN } } } },
  },
};

const TEXT_HEIGHT_VARIANTS: Record<string, Variant> = Object.fromEntries(
  TEXT_HEIGHT_TARGETS_PX.map((t) => [`web-crop-th${t}`, { platform: 'web', config: withTextHeight(CROP_CANVAS, t) } satisfies Variant]),
);

// ---------- Enhance (spec Task 9: E3) ----------
// One factor at a time, each on top of the previous: `+gray`, then `+flatten`, then `+clahe`, on top
// of `web-crop-canvas` and of `web-crop-th40` (the cheapest text-height pass, E2). Enhance runs in the
// OpenCV worker on the image the size step made, and hands it to Tesseract as lossless PNG (a second
// JPEG generation would add ringing around strokes, the opposite of the point). Never binarized.

/**
 * CLAHE (contrast-limited adaptive histogram equalization), spec starting values.
 * Why: on faded thermal print the ink is only 20–40 levels darker than the paper; equalizing per
 * tile stretches that locally. `clipLimit` 2 caps how far one tile's histogram is stretched, so paper
 * grain and JPEG noise aren't amplified into texture ("gentle"); `tile` 8 = an 8 × 8 grid of tiles,
 * each several text lines tall on a receipt crop, so a tile always holds both ink and paper.
 * Tuned: E3, 2026-11-23 (spec Results log): not adopted (1 checked tuning receipt).
 */
export const ENHANCE_CLAHE = { clipLimit: 2, tile: 8 } as const;

/** Flatten kernel in line heights (`DEFAULT_KERNEL_LINE_HEIGHTS` in web/cv/enhance.ts holds the Why/Tuned). */
export const FLATTEN_KERNEL_LINE_HEIGHTS = 4;

type EnhanceStep = 'gray' | 'flatten' | 'clahe';
const ENHANCE_STEPS: Record<EnhanceStep, Exclude<PipelineConfig['enhance'], false>> = {
  gray: { gray: true, flatten: false, clahe: false },
  flatten: { gray: true, flatten: { kernelLineHeights: FLATTEN_KERNEL_LINE_HEIGHTS }, clahe: false },
  clahe: { gray: true, flatten: { kernelLineHeights: FLATTEN_KERNEL_LINE_HEIGHTS }, clahe: { ...ENHANCE_CLAHE } },
};

function withEnhance(base: PipelineConfig, step: EnhanceStep): PipelineConfig {
  return { ...base, enhance: ENHANCE_STEPS[step], recognize: { ...base.recognize, output: 'png' } };
}

const TH40 = withTextHeight(CROP_CANVAS, 40);
const ENHANCE_VARIANTS: Record<string, Variant> = {
  /** E3 step 1: `web-crop-canvas` + grey (luma), PNG handoff. */
  'web-crop-gray': { platform: 'web', config: withEnhance(CROP_CANVAS, 'gray') },
  /** E3 step 2: + background flattening (kernel 4 line heights). One factor vs `web-crop-gray`. */
  'web-crop-flatten': { platform: 'web', config: withEnhance(CROP_CANVAS, 'flatten') },
  /** E3 step 3: + CLAHE (clip 2, 8 × 8 tiles). One factor vs `web-crop-flatten`. */
  'web-crop-flatten-clahe': { platform: 'web', config: withEnhance(CROP_CANVAS, 'clahe') },
  /** The same three steps on top of `web-crop-th40` (enhance runs on each pass's image). */
  'web-crop-th40-gray': { platform: 'web', config: withEnhance(TH40, 'gray') },
  'web-crop-th40-flatten': { platform: 'web', config: withEnhance(TH40, 'flatten') },
  'web-crop-th40-flatten-clahe': { platform: 'web', config: withEnhance(TH40, 'clahe') },
};

// ---------- Zoom on doubt (spec Task 13: E9) ----------
// After each read, the doubtful rows (broken or missing prices, rows the parser or the totals check
// implicate, low confidence) are re-read one at a time, cut from that read's image, scaled to the
// text-height target and read as single lines (PSM 7). Constants with their Why/Tuned notes are in
// zoomOnDoubt.ts. Each variant is its base plus zoom, so against the base zoom is the only factor.

/** The zoom options for a variant whose text-height target is `targetLineHeightPx`. */
function zoomOptions(targetLineHeightPx: number): ZoomOptions {
  return {
    minLineConfidence: ZOOM_LOW_CONFIDENCE,
    maxRows: MAX_ZOOM_ROWS,
    minConfidenceGain: ZOOM_MIN_CONFIDENCE_GAIN,
    targetLineHeightPx,
  };
}

function withZoom(base: PipelineConfig): PipelineConfig {
  const target = base.textHeightRescale === false ? ZOOM_DEFAULT_TARGET_PX : base.textHeightRescale.targetLineHeightPx;
  return { ...base, recognize: { ...base.recognize, zoomOnDoubt: zoomOptions(target) } };
}

const ZOOM_VARIANTS: Record<string, Variant> = {
  /** E9: `web-current` + zoom on doubt (rows scaled to `ZOOM_DEFAULT_TARGET_PX`). No OpenCV. */
  'web-current-zoom': { platform: 'web', config: withZoom(CURRENT) },
  /** E9: `web-crop-th40` + zoom on doubt (rows scaled to the same 40 px target), after each pass. */
  'web-crop-th40-zoom': { platform: 'web', config: withZoom(TH40) },
};

// ---------- Strip tiling (spec Task 12: E8) ----------
// A tall crop (height / width ≥ 2.5 and height > 1.25 × RECOGNITION_MAX_EDGE) is read in strips at its
// own resolution, cut only on blank rows, instead of being shrunk whole to the 2048 px cap. Anything
// shorter or wider is read exactly as its base. Constants with their Why/Tuned notes are in
// stripTilingOptions.ts / stripTiling.ts. Each variant is its base plus tiling, so against the base
// tiling is the only factor. No variant tiles and enhances: strips are read unenhanced.

function withTiling(base: PipelineConfig): PipelineConfig {
  return { ...base, recognize: { ...base.recognize, tiling: { ...DEFAULT_TILING } } };
}

const STRIP_VARIANTS: Record<string, Variant> = {
  /** E8: `web-crop-canvas` + strip tiling. */
  'web-crop-strips': { platform: 'web', config: withTiling(CROP_CANVAS) },
  /** E8: `web-crop-th40` + strip tiling (the second pass re-plans the strips at the new scale). */
  'web-crop-th40-strips': { platform: 'web', config: withTiling(TH40) },
};

export const VARIANTS: Record<string, Variant> = {
  /** No locate or crop; normalize via today's `prepareForRecognition`; no enhance; today's Tesseract settings. */
  'web-current': { platform: 'web', config: CURRENT },
  /**
   * E-cv0, one factor: today's path, but resized in OpenCV (INTER_AREA down / INTER_CUBIC up)
   * instead of the canvas, encoded as JPEG 0.9 like today. Isolates the resampler vs `web-current`.
   * Runs only with `WEB_CV_PREPROCESS` (or the harness's `cvPreprocess`); otherwise it is `web-current`.
   */
  'cv-resize-jpeg': { platform: 'web', config: { ...CURRENT, normalize: 'cv', recognize: { ...CURRENT.recognize, output: 'jpeg90' } } },
  /** E-cv0, one factor: as `cv-resize-jpeg` but lossless PNG. Isolates JPEG ringing vs the winner. */
  'cv-resize-png': { platform: 'web', config: { ...CURRENT, normalize: 'cv', recognize: { ...CURRENT.recognize, output: 'png' } } },
  /**
   * E5 (Task 7, core, judged by `decideCore`): `cv-resize-jpeg` + locate + crop, so against
   * `cv-resize-jpeg` the crop is the only factor. The size rule is applied to the crop (D4).
   */
  'web-crop': {
    platform: 'web',
    config: { ...CURRENT, locate: true, crop: WEB_CROP, normalize: 'cv', recognize: { ...CURRENT.recognize, output: 'jpeg90' } },
  },
  /**
   * E5 follow-up (Task 7): OpenCV only locates and flattens; the size step is today's
   * `prepareForRecognition` (canvas, Hermite, JPEG) on the crop, handed over from the worker as a
   * lossless PNG. Against `web-current` the crop is the only factor (the harness showed the cv
   * resampler in `web-crop` reading worse than the canvas). Without a crop it is `web-current`.
   */
  'web-crop-canvas': { platform: 'web', config: CROP_CANVAS },
  /** PSM 4 after the crop (spec Task 7 / criterion 41): `web-crop-canvas` read with PSM 4. */
  ...CROP_VARIANTS,
  ...TESSERACT_VARIANTS,
  /** E2 (Task 8): `web-crop-canvas` + the text-height second pass, one target each (`TEXT_HEIGHT_TARGETS_PX`). */
  ...TEXT_HEIGHT_VARIANTS,
  /** E3 (Task 9): enhance on top of `web-crop-canvas` / `web-crop-th40`, one step at a time. */
  ...ENHANCE_VARIANTS,
  /** E9 (Task 13): zoom on doubt on top of `web-current` / `web-crop-th40`. */
  ...ZOOM_VARIANTS,
  /** E8 (Task 12): strip tiling for tall receipts on top of `web-crop-canvas` / `web-crop-th40`. */
  ...STRIP_VARIANTS,
  /** Identity stubs + today's prepare and on-device recognizer (Vision / ML Kit). */
  'native-current': { platform: 'native', config: CURRENT },
};

/**
 * Web plans that can ship (spec Task 11): a primary read and the one automatic retry that runs when
 * the primary isn't ok (C2), keeping the better of the two by `pickBetter`. Measured with
 * `npm run eval -- --flow <primary>,<retry>` (spec Results log); Task 14 picks one. To switch, point
 * `PIPELINE.web` at another entry, and set `WEB_CV_PREPROCESS = true` if either variant uses OpenCV
 * (`checkPlan`, enforced by config.test.ts). The pairs are the only variants that ever helped
 * (the crop, and the crop + text-height pass at 40 px), each tried as primary and as retry.
 */
export const WEB_PLANS = {
  /** Today: one read, no retry. */
  current: { primary: 'web-current', retry: null },
  /**
   * Task 14's proposed shipping plan (spec "Decision (proposed)", 2026-11-24; not shipped until the
   * user approves): locate + crop to the receipt, today's size rule on the crop, one read, no retry.
   * Needs `WEB_CV_PREPROCESS = true`. decideCore ADOPT (provisional: 3 tuning / 2 held-out receipts).
   */
  'crop-canvas': { primary: 'web-crop-canvas', retry: null },
  /** Today's read first; if it isn't ok, crop to the receipt and size its text. Costs OpenCV only on a failed read. */
  'current-then-crop-th40': { primary: 'web-current', retry: 'web-crop-th40' },
  /** Crop + text-height pass first; if that isn't ok, today's whole-photo read (for a crop that cut or mis-sized the receipt). */
  'crop-th40-then-current': { primary: 'web-crop-th40', retry: 'web-current' },
  /** As above with the crop alone (no text-height pass). */
  'current-then-crop-canvas': { primary: 'web-current', retry: 'web-crop-canvas' },
  'crop-canvas-then-current': { primary: 'web-crop-canvas', retry: 'web-current' },
} as const satisfies Record<string, PipelinePlan>;

export const PIPELINE: Record<Platform, PipelinePlan> = {
  web: WEB_PLANS.current,
  native: { primary: 'native-current', retry: null },
};

/**
 * Master switch for OpenCV on web: false means the web locate / crop / cv-normalize / enhance are
 * the identity and OpenCV is never fetched. Wired by Task 6: `web/stages.ts` reads it, and
 * `scripts/opencv-assets.mjs` reads this exact line to decide whether `public/opencv/` is built
 * (spec A1 Q2: no OpenCV in the build until a cv step wins). Keep it a literal `true` / `false`.
 */
export const WEB_CV_PREPROCESS = false;

/**
 * Whether a read that isn't ok shows "Retake photo / Type it in" (the screen itself is Task 10).
 * Native is on per the user's decision (spec Amendment A1, Q6).
 */
export const SHOW_FAILURE_SCREEN: Record<Platform, boolean> = { web: true, native: true };

/** Whether a variant needs OpenCV (any cv step on). The harness builds the cv assets and turns cv on for these. */
export function usesCv(config: PipelineConfig): boolean {
  return config.locate || config.crop !== false || config.normalize === 'cv' || config.enhance !== false;
}

function lookup(name: string, platform: Platform): { variant: string; config: PipelineConfig } {
  const v = VARIANTS[name];
  if (!v) throw new RangeError(`Unknown scan variant: ${name}`);
  if (v.platform !== platform) throw new RangeError(`Scan variant ${name} is for ${v.platform}, not ${platform}`);
  return { variant: name, config: v.config };
}

/** Looks up a plan's variants for `platform`. Throws RangeError for an unknown or other-platform name. */
export function resolvePlan(plan: PipelinePlan, platform: Platform): ResolvedPlan {
  return {
    primary: lookup(plan.primary, platform),
    retry: plan.retry === null ? null : lookup(plan.retry, platform),
  };
}

/**
 * Why a plan can't ship as configured:
 * - `unknown_variant`: a name isn't in `VARIANTS` for this platform (`resolvePlan` would throw);
 * - `primary_needs_cv` / `retry_needs_cv`: the variant uses OpenCV but the web master switch is off,
 *   so it would silently run without its cv steps (no crop) and not be the variant that was measured;
 * - `retry_same`: the retry is the primary, so it reads the same photo the same way twice.
 */
export type PlanProblem = 'unknown_variant' | 'primary_needs_cv' | 'retry_needs_cv' | 'retry_same';

/** Checks a plan against the variants and the web master switch (`cvPreprocess`, normally `WEB_CV_PREPROCESS`). */
export function checkPlan(plan: PipelinePlan, platform: Platform, cvPreprocess: boolean): PlanProblem[] {
  let resolved: ResolvedPlan;
  try {
    resolved = resolvePlan(plan, platform);
  } catch {
    return ['unknown_variant'];
  }
  const problems: PlanProblem[] = [];
  const cvOff = platform === 'web' && !cvPreprocess;
  if (cvOff && usesCv(resolved.primary.config)) problems.push('primary_needs_cv');
  if (cvOff && resolved.retry && usesCv(resolved.retry.config)) problems.push('retry_needs_cv');
  if (resolved.retry && resolved.retry.variant === resolved.primary.variant) problems.push('retry_same');
  return problems;
}
