// Spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 10 (criteria 46, 47, 50, 52).
import type { ScanProblem, TraceEntry } from './scanPipeline/types';
import {
  CHOICE_COPY,
  choiceHints,
  cvRan,
  FAILURE_COPY,
  failureHints,
  failureReason,
  PROGRESS_COPY,
  progressCopy,
  scanLoadsCv,
  scanOutcome,
  showsProgressBar,
} from './scanScreen';

const ok = { ok: true, problems: [] as ScanProblem[] };
const notOk = (...problems: ScanProblem[]) => ({ ok: false, problems });

describe('progressCopy (criterion 46)', () => {
  it('has fixed copy for every stage', () => {
    expect(progressCopy('preparing')).toBe('Preparing photo…');
    expect(progressCopy('loading_engine')).toBe('Getting the text reader ready…');
    expect(progressCopy('recognizing')).toBe('Reading receipt…');
    expect(progressCopy('retrying')).toBe('Taking a closer look…');
  });

  it('uses the longer preparing line only on the first cv load', () => {
    expect(progressCopy('preparing', { firstCvLoad: true })).toBe('Preparing photo… The first time takes a little longer.');
    expect(progressCopy('preparing', { firstCvLoad: false })).toBe(PROGRESS_COPY.preparing);
    // Other stages ignore it.
    expect(progressCopy('recognizing', { firstCvLoad: true })).toBe(PROGRESS_COPY.recognizing);
  });

  it('shows a progress bar only while the reader reads', () => {
    expect(showsProgressBar('recognizing')).toBe(true);
    expect(showsProgressBar('retrying')).toBe(true);
    expect(showsProgressBar('preparing')).toBe(false);
    expect(showsProgressBar('loading_engine')).toBe(false);
  });
});

describe('failureReason (criterion 47)', () => {
  it.each<[ScanProblem, string]>([
    ['no_items', 'We found no items.'],
    ['too_few_lines', 'We found no items.'],
    ['no_total', "We couldn't find the total."],
    ['items_vs_subtotal', "The items don't add up to the total."],
    ['subtotal_vs_total', "The items don't add up to the total."],
  ])('%s → %s', (problem, line) => {
    expect(failureReason([problem])).toBe(line);
  });

  it('is chosen by the first problem', () => {
    expect(failureReason(['no_total', 'items_vs_subtotal'])).toBe(FAILURE_COPY.reason.no_total);
    expect(failureReason(['subtotal_vs_total', 'no_total'])).toBe(FAILURE_COPY.reason.gap);
    expect(failureReason(['no_items', 'too_few_lines', 'no_total'])).toBe(FAILURE_COPY.reason.no_items);
  });

  it('a short read that found items skips too_few_lines and never says "no items"', () => {
    expect(failureReason(['too_few_lines', 'no_total'], 2)).toBe(FAILURE_COPY.reason.no_total);
    expect(failureReason(['too_few_lines'], 2)).toBeNull();
    expect(failureReason(['too_few_lines'], 0)).toBe(FAILURE_COPY.reason.no_items);
    expect(failureReason(['no_items', 'too_few_lines'], 0)).toBe(FAILURE_COPY.reason.no_items);
  });

  it('is null with no problems', () => {
    expect(failureReason([])).toBeNull();
  });
});

describe('scanOutcome (criteria 47, 52)', () => {
  it('an ok read goes to the form, with the screen on or off', () => {
    expect(scanOutcome({ lineCount: 12, itemCount: 3, verdict: ok }, true)).toEqual({ kind: 'form' });
    expect(scanOutcome({ lineCount: 12, itemCount: 3, verdict: ok }, false)).toEqual({ kind: 'form' });
  });

  it('a read that is not ok shows the failure screen when it is on', () => {
    expect(scanOutcome({ lineCount: 9, itemCount: 3, verdict: notOk('items_vs_subtotal') }, true)).toEqual({
      kind: 'failure',
      reason: FAILURE_COPY.reason.gap,
    });
    expect(scanOutcome({ lineCount: 0, itemCount: 0, verdict: notOk('no_items', 'too_few_lines', 'no_total') }, true)).toEqual({
      kind: 'failure',
      reason: FAILURE_COPY.reason.no_items,
    });
    expect(scanOutcome({ lineCount: 4, itemCount: 2, verdict: notOk('too_few_lines', 'no_total') }, true)).toEqual({
      kind: 'failure',
      reason: FAILURE_COPY.reason.no_total,
    });
  });

  it('with the screen off it behaves as before: no lines → read_failed, anything else → the form', () => {
    expect(scanOutcome({ lineCount: 0, itemCount: 0, verdict: notOk('no_items', 'too_few_lines', 'no_total') }, false)).toEqual({
      kind: 'read_failed',
    });
    expect(scanOutcome({ lineCount: 1, itemCount: 0, verdict: notOk('no_items', 'too_few_lines', 'no_total') }, false)).toEqual({
      kind: 'form',
    });
  });
});

describe('failureHints (criterion 50)', () => {
  it('describes what each button does, per platform and whether anything was read', () => {
    expect(failureHints('native', true).retake).toMatch(/camera/);
    expect(failureHints('web', true).retake).toMatch(/photo picker/);
    expect(failureHints('native', true).typeIn).toMatch(/filled in/);
    expect(failureHints('native', false).typeIn).toMatch(/empty/);
  });
});

describe('scanLoadsCv', () => {
  it('is true only on web, with the master switch on and a cv primary', () => {
    expect(scanLoadsCv('web', true, { primary: 'web-crop', retry: null })).toBe(true);
    expect(scanLoadsCv('web', false, { primary: 'web-crop', retry: null })).toBe(false);
    expect(scanLoadsCv('native', true, { primary: 'web-crop', retry: null })).toBe(false);
    expect(scanLoadsCv('web', true, { primary: 'web-current', retry: 'web-crop' })).toBe(false);
    expect(scanLoadsCv('web', true, { primary: 'no-such-variant', retry: null })).toBe(false);
  });
});

describe('cvRan (review R4: when the "first time" line can stop showing)', () => {
  const skipped: TraceEntry = { variant: 'web-crop', stage: 'crop', event: 'skipped', reason: 'low_confidence' };
  it('a trace with no `unavailable` or `fallback` means OpenCV ran', () => {
    expect(cvRan([])).toBe(true);
    expect(cvRan([skipped, { variant: 'web-crop', stage: 'normalize', event: 'skipped', reason: 'in_band' }])).toBe(true);
  });
  it.each<TraceEntry>([
    { variant: 'web-crop', stage: 'locate', event: 'unavailable' },
    { variant: 'web-crop', stage: 'crop', event: 'unavailable' },
    { variant: 'web-crop', stage: 'enhance', event: 'unavailable' },
    { variant: 'web-crop', stage: 'normalize', event: 'fallback' },
    { variant: 'web-crop', stage: 'recognize', event: 'fallback' },
  ])('any %p entry means it may not have (the key is not set)', (entry) => {
    expect(cvRan([skipped, entry])).toBe(false);
  });
});

// Spec: docs/specs/2026-11-25-scan-screen-redesign.md (Copy, criterion 1).
describe('choiceHints (scan screen redesign)', () => {
  it('has a fixed intro line', () => {
    expect(CHOICE_COPY.intro).toBe('Start a bill from your receipt.');
  });

  it('describes the camera on native and a photo on web', () => {
    expect(choiceHints('native').scan).toBe("Point the camera at the receipt and we'll fill in the items.");
    expect(choiceHints('web').scan).toBe("Use a photo of the receipt and we'll fill in the items.");
  });

  it('uses the same manual hint on both platforms', () => {
    expect(choiceHints('native').manual).toBe('Type each item and its price yourself.');
    expect(choiceHints('web').manual).toBe(choiceHints('native').manual);
  });
});
