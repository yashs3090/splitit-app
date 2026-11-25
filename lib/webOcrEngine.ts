// The Tesseract.js side of web text recognition (spec: docs/specs/2026-11-20-m1a-scan-receipt.md,
// A3 / Task 9). Only `lib/textRecognition.web.ts` loads this file, and only via `import()`, so this
// module and `tesseract.js` form one lazy chunk that is never in the initial web bundle
// (criteria 52–53). Everything that names the library lives here, so the entry bundle stays free of
// it; the recognizer only calls `startWorker` and `readLines`.
// Privacy: no console calls. Must never be imported by native code (criterion 54).
import {
  createWorker,
  type Bbox,
  type InitOptions,
  type LoggerMessage,
  type Page,
  type PSM,
  type RecognizeOptions,
  type Worker,
  type WorkerOptions,
} from 'tesseract.js';

import type { Box, RecognizedLine, RecognizedText } from './receiptTypes';

export type EngineWorker = Pick<Worker, 'recognize' | 'setParameters' | 'terminate' | 'reinitialize'>;

/**
 * Per-read Tesseract settings from a scan variant (`RecognizeConfig.tesseract`, spec Task 5).
 * - `params`: Tesseract parameters for this read only, on top of `TESSERACT_PARAMS`. They go in
 *   recognize's options, which tesseract.js 7.0.0 passes through to Tesseract and restores after the
 *   read (`SaveParameters` / `RestoreParameters` in `worker-script/index.js#recognize`), so a
 *   variant's settings never leak into the next read on the same worker.
 * - `rotateAuto`: tesseract.js measures the page's skew and re-reads it straightened.
 * Init-only parameters (the dictionaries) can't be set per read; they go to `startWorker` /
 * `reinitWorker` as `init`.
 */
export type ReadLinesOptions = {
  params?: Readonly<Record<string, string>>;
  rotateAuto?: boolean;
  /** Harness only: receives Tesseract's own binarized image (a PNG data URL) after the read. */
  onImageBinary?: (pngDataUrl: string) => void;
};

/**
 * Where the Tesseract assets are served from. `'/tesseract'` = our own origin (`public/tesseract/`,
 * the user's choice in A3). Set it to `null` to use Tesseract.js's default jsDelivr CDN URLs instead
 * (then drop the copy script and add the ADR 0012 "Before production" item).
 */
export const TESSERACT_ASSET_BASE: string | null = '/tesseract';

/** Engine settings (A3 decision 2). Tune from the receipt eval. */
export const TESSERACT_LANG = 'eng';
export const TESSERACT_OEM_LSTM_ONLY = 1;
export const TESSERACT_PARAMS = {
  /**
   * 6 = one uniform block of text. The spec suggested 4 (single column), but on a rendered test
   * receipt (Task 9) PSM 3 and 4 dropped the whole right-aligned price column and the
   * Tax/Tip/Total rows, while 6 read every line with its price. Re-check with real photos in the eval.
   * The value is Tesseract's PSM string; `PSM` is a type-only import (a runtime import would be fine
   * here, but the string keeps this file free of enum interop questions).
   */
  tessedit_pageseg_mode: '6' as PSM,
  preserve_interword_spaces: '1',
};

/** Worker options for the asset base. Paths match the layout the copy script writes. */
export function tesseractPaths(base: string | null): Partial<WorkerOptions> {
  if (base === null) return {};
  const root = base.replace(/\/+$/, '');
  return {
    workerPath: `${root}/worker.min.js`,
    corePath: `${root}/core`, // a directory: Tesseract picks the plain / SIMD / relaxed-SIMD LSTM build
    langPath: `${root}/lang`, // holds eng.traineddata.gz (4.0.0_best_int, matches OEM 1)
    workerBlobURL: false,
  };
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function toBox(bbox: Partial<Bbox> | null | undefined): Box | undefined {
  if (!bbox) return undefined;
  const { x0, y0, x1, y1 } = bbox;
  if (!isFiniteNonNegative(x0) || !isFiniteNonNegative(y0) || !isFiniteNonNegative(x1) || !isFiniteNonNegative(y1)) {
    return undefined;
  }
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 0 || height < 0) return undefined;
  return { x: x0, y: y0, width, height };
}

/**
 * Symbol-only words the parser can use: `+`/`-` modifier marks, negatives, `$`, `%`, `@` (qty @ unit),
 * `#` and `:` (header labels like "Check #:"), `&`, `*`, parentheses. Kept when Tesseract is at least
 * this confident; any other symbol-only word ("?", "©", "|", "‘", "~~", …) is always dropped.
 *
 * Measured on the three real receipts through the web pipeline (2026-11-22): real item words,
 * quantities and prices go as low as confidence 0–32 on the low-resolution receipt ("BIsOuE" 0,
 * "S08" 4, "$8.95" 32), so words with any letter or digit are never dropped by confidence. Confident
 * "-" read 85–92; junk "-" read 0–46.
 */
export const MIN_SYMBOL_WORD_CONFIDENCE = 50;
const PARSER_SYMBOLS_RE = /^[-+$%@&#*():]+$/;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

type WordLike = { text?: unknown; confidence?: unknown };

function keepWord(text: string, confidence: unknown): boolean {
  if (LETTER_OR_DIGIT_RE.test(text)) return true;
  if (!PARSER_SYMBOLS_RE.test(text)) return false;
  return typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= MIN_SYMBOL_WORD_CONFIDENCE;
}

/**
 * A line's text rebuilt from Tesseract's words, without symbol-only noise (see
 * MIN_SYMBOL_WORD_CONFIDENCE). Words are joined with one space; the parser collapses spacing anyway.
 * Returns null when there is no usable word list, so the caller keeps the line's own text. Pure.
 */
export function lineTextFromWords(words: readonly WordLike[] | null | undefined): string | null {
  if (!Array.isArray(words) || words.length === 0) return null;
  const kept: string[] = [];
  for (const word of words) {
    if (typeof word?.text !== 'string') continue;
    const text = word.text.trim();
    if (text.length > 0 && keepWord(text, word.confidence)) kept.push(text);
  }
  return kept.join(' ');
}

/** Tesseract's line confidence when it is a finite number in 0–100; otherwise none. */
function lineConfidence(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
}

type LineLike = { text?: unknown; bbox?: Partial<Bbox> | null; words?: WordLike[] | null; confidence?: unknown };
type PageLike = {
  blocks?: { paragraphs?: { lines?: LineLike[] | null }[] | null }[] | null;
};

/**
 * Flattens `blocks → paragraphs → lines` in returned order. Pure.
 * Each line's text comes from its words with noise dropped (`lineTextFromWords`), or from the line's
 * own text when it has no words; the line's box is kept as is.
 * Drops empty lines and lines without a valid box (non-finite, negative or inverted).
 * Adds the line's `confidence` (0–100) only when Tesseract gives a finite number in that range.
 */
export function mapTesseractResult(data: PageLike | Page | null | undefined): RecognizedText {
  const lines: RecognizedLine[] = [];
  for (const block of (data as PageLike | null | undefined)?.blocks ?? []) {
    for (const paragraph of block?.paragraphs ?? []) {
      for (const line of paragraph?.lines ?? []) {
        if (typeof line?.text !== 'string') continue;
        const text = (lineTextFromWords(line.words) ?? line.text).trim();
        if (text.length === 0) continue;
        const box = toBox(line.bbox);
        if (!box) continue;
        const confidence = lineConfidence(line.confidence);
        lines.push(confidence === undefined ? { text, box } : { text, box, confidence });
      }
    }
  }
  return { lines };
}

/**
 * Starts a worker with our self-hosted assets and settings. `onLog` gets Tesseract's progress
 * messages; `onError` gets start-up/job errors (without it Tesseract.js throws from its message
 * handler, and a failed language download leaves this promise pending forever).
 * `init`: init-only Tesseract parameters (e.g. `load_system_dawg`), passed as `createWorker`'s
 * `config` argument. tesseract.js 7.0.0 writes them to a config file read by `api.Init`; through
 * `setParameters` they would do nothing (its `initParamNames` list). Empty or unset = today's call.
 */
export async function startWorker(
  onLog: (m: LoggerMessage) => void,
  onError: (e: unknown) => void,
  init?: Readonly<Record<string, string>>,
): Promise<EngineWorker> {
  const options: Partial<WorkerOptions> = {
    ...tesseractPaths(TESSERACT_ASSET_BASE),
    logger: onLog,
    errorHandler: onError,
  };
  const worker = hasKeys(init)
    ? await createWorker(TESSERACT_LANG, TESSERACT_OEM_LSTM_ONLY, options, { ...init } as Partial<InitOptions>)
    : await createWorker(TESSERACT_LANG, TESSERACT_OEM_LSTM_ONLY, options);
  try {
    await worker.setParameters({ ...TESSERACT_PARAMS });
  } catch (e) {
    // The worker started, so it can be stopped: don't leave it idling in the tab (review R4a).
    worker.terminate().catch(() => {});
    throw e;
  }
  return worker;
}

/**
 * Re-initializes a running worker with other init-only parameters (`{}` = Tesseract's defaults),
 * for a later read in the same scan whose variant asks for a different `init`. Re-init builds a new
 * Tesseract API inside the worker, which drops every parameter set before, so `TESSERACT_PARAMS`
 * is applied again. The language data is already loaded, so nothing is fetched.
 */
export async function reinitWorker(worker: EngineWorker, init: Readonly<Record<string, string>> | undefined): Promise<void> {
  await worker.reinitialize(TESSERACT_LANG, TESSERACT_OEM_LSTM_ONLY, { ...(init ?? {}) } as Partial<InitOptions>);
  await worker.setParameters({ ...TESSERACT_PARAMS });
}

function hasKeys(o: Readonly<Record<string, string>> | undefined): o is Readonly<Record<string, string>> {
  return o !== undefined && Object.keys(o).length > 0;
}

/**
 * Recognizes with line boxes on (off by default since Tesseract.js v6) and maps the page.
 * Without `opts` (or with nothing in it) this is today's call: `recognize(uri, {}, { blocks: true })`.
 */
export async function readLines(worker: EngineWorker, imageUri: string, opts: ReadLinesOptions = {}): Promise<RecognizedText> {
  // Tesseract parameters ride in recognize's options: tesseract.js passes every key that isn't one of
  // its own (rectangle, rotateAuto, …) to Tesseract for this read only. Its `RecognizeOptions` type
  // lists only its own keys, hence the cast.
  const options = { ...(opts.params ?? {}), ...(opts.rotateAuto ? { rotateAuto: true } : {}) } as Partial<RecognizeOptions>;
  const output = opts.onImageBinary ? { blocks: true, imageBinary: true } : { blocks: true };
  const result = await worker.recognize(imageUri, options, output);
  const binary: unknown = (result.data as { imageBinary?: unknown }).imageBinary;
  if (opts.onImageBinary && typeof binary === 'string') opts.onImageBinary(binary);
  return mapTesseractResult(result.data);
}

export { mapTesseractResult as toRecognizedText };
