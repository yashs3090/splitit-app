// What the scan screen shows for each pipeline stage and each finished read.
// Spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 10 (criteria 46–52) and Amendment A1 (Q5, Q6).
//
// Pure. Every string here is fixed app copy: nothing from a library, the engine or the photo is
// ever shown. The screen (`app/(app)/scan.tsx`) only picks which of these to render.
import { usesCv, VARIANTS, type PipelinePlan } from './scanPipeline/config';
import type { ScanProblem, TraceEntry } from './scanPipeline/types';
import type { RecognitionStage } from './textRecognition';

export const PROGRESS_COPY = {
  preparing: 'Preparing photo…',
  /** `preparing` on a device's first scan that downloads the image tools (OpenCV, web only). */
  preparingFirstLoad: 'Preparing photo… The first time takes a little longer.',
  loading_engine: 'Getting the text reader ready…',
  recognizing: 'Reading receipt…',
  retrying: 'Taking a closer look…',
} as const;

/** The status line for the stage the scan is in. */
export function progressCopy(stage: RecognitionStage, opts: { firstCvLoad?: boolean } = {}): string {
  if (stage === 'preparing') return opts.firstCvLoad ? PROGRESS_COPY.preparingFirstLoad : PROGRESS_COPY.preparing;
  return PROGRESS_COPY[stage];
}

/** Whether the stage's work can be shown as a progress bar (the reader reports a fraction). */
export function showsProgressBar(stage: RecognitionStage): boolean {
  return stage === 'recognizing' || stage === 'retrying';
}

export const FAILURE_COPY = {
  title: "We couldn't read this receipt clearly.",
  timedOutTitle: 'Reading took too long.',
  tip: 'Lay it flat in good light and fill the frame.',
  retake: 'Retake photo',
  typeIn: 'Type it in',
  reason: {
    no_items: 'We found no items.',
    no_total: "We couldn't find the total.",
    gap: "The items don't add up to the total.",
  },
} as const;

const REASON_BY_PROBLEM: Record<ScanProblem, string> = {
  no_items: FAILURE_COPY.reason.no_items,
  too_few_lines: FAILURE_COPY.reason.no_items,
  no_total: FAILURE_COPY.reason.no_total,
  items_vs_subtotal: FAILURE_COPY.reason.gap,
  subtotal_vs_total: FAILURE_COPY.reason.gap,
};

/**
 * The one allow-listed line for a failed read, chosen by its first problem; null when there is none.
 * `too_few_lines` reads as "We found no items." only when no items were found: a short read that
 * did find items moves on to its next problem, so the screen never says "no items" over items.
 */
export function failureReason(problems: readonly ScanProblem[], itemCount = 0): string | null {
  const first = problems.find((p) => !(p === 'too_few_lines' && itemCount > 0));
  return first === undefined ? null : REASON_BY_PROBLEM[first];
}

/**
 * Where a finished read goes:
 * - `form`: the bill form, pre-filled (the read is ok, or the failure screen is off and lines were found);
 * - `failure`: "Retake photo / Type it in" (not ok and the failure screen is on for this platform);
 * - `read_failed`: today's "Couldn't read that photo" (failure screen off and nothing was read).
 */
export type ScanOutcome = { kind: 'form' } | { kind: 'failure'; reason: string | null } | { kind: 'read_failed' };

export function scanOutcome(
  read: { lineCount: number; itemCount: number; verdict: { ok: boolean; problems: readonly ScanProblem[] } },
  showFailureScreen: boolean,
): ScanOutcome {
  if (read.verdict.ok) return { kind: 'form' };
  if (showFailureScreen) return { kind: 'failure', reason: failureReason(read.verdict.problems, read.itemCount) };
  return read.lineCount === 0 ? { kind: 'read_failed' } : { kind: 'form' };
}

/** Screen-reader hints for the failure screen's buttons. */
export function failureHints(platform: 'web' | 'native', hasRead: boolean): { retake: string; typeIn: string } {
  return {
    retake: platform === 'web' ? 'Opens the photo picker so you can choose a new photo.' : 'Opens the camera so you can take a new photo.',
    typeIn: hasRead
      ? 'Opens the bill form with what was read filled in, so you can fix it.'
      : 'Opens an empty bill form so you can type the items.',
  };
}

/**
 * The idle screen's copy around the two centered choices (spec 2026-11-25 scan screen redesign).
 * The choices' titles are `CAPTURE_LABEL` / `MANUAL_ENTRY_LABEL` from `lib/capturePhoto`.
 */
export const CHOICE_COPY = {
  intro: 'Start a bill from your receipt.',
  scan: {
    native: "Point the camera at the receipt and we'll fill in the items.",
    web: "Use a photo of the receipt and we'll fill in the items.",
  },
  manual: 'Type each item and its price yourself.',
} as const;

/** Each choice's one-line hint, shown under its title and used as its screen-reader hint. */
export function choiceHints(platform: 'web' | 'native'): { scan: string; manual: string } {
  return { scan: CHOICE_COPY.scan[platform], manual: CHOICE_COPY.manual };
}

/** Storage key recording that this device has already downloaded the image tools once. Holds no receipt data. */
export const CV_LOADED_KEY = 'splitit.scan.cvLoaded';

/**
 * Whether a finished scan's OpenCV steps actually ran (review R4): its trace has no `unavailable`
 * and no `fallback` entry. Only then is `CV_LOADED_KEY` set, so a device whose OpenCV download
 * failed keeps the longer "first time" line. Deliberately conservative: a fallback with another
 * cause (e.g. zoom on doubt without its crop function) also counts as "not loaded", which only
 * means the longer line shows once more.
 */
export function cvRan(trace: readonly TraceEntry[]): boolean {
  return !trace.some((t) => t.event === 'unavailable' || t.event === 'fallback');
}

/**
 * Whether a scan's `preparing` step downloads OpenCV: web only, with the master switch on and a
 * primary variant that uses a cv step. (A cv step only in the retry loads during `retrying`, whose
 * copy doesn't change.)
 */
export function scanLoadsCv(platform: 'web' | 'native', cvPreprocess: boolean, plan: PipelinePlan): boolean {
  if (platform !== 'web' || !cvPreprocess) return false;
  const v = VARIANTS[plan.primary];
  return v !== undefined && usesCv(v.config);
}
