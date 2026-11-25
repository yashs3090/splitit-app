// Zoom on doubt (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 13). Pure; RN-free.
//
// After a read, only the rows that look wrong are read again: each one is cut out of the image that
// pass read (with a margin), scaled so its text is the target height, and read as a single line
// (Tesseract PSM 7). A re-read replaces the row only when it is clearly better (`acceptZoomRead`), and
// the whole zoomed read is kept only when it scores better than the original (`pickBetter`, C2).
//
// Why it can help: on the failing photos the misses are single digits in prices ("$90" read "$30",
// "57.71" read "57.1") and lost total lines, on rows the page-level read (PSM 6, whole receipt at one
// size) got wrong while its neighbours were fine. A single-line read at the preferred text height
// gives Tesseract one row and nothing else to segment. It adds no pixel information (spec Risks), so
// it can also swap a right read for a confident wrong one; the accept rule and pickBetter limit that.
//
// The platform part (cropping, the canvas resize, the PSM 7 read on the scan's one worker) is in
// `web/stages.ts`, through the `ZoomReread` callback.
import { parseReceipt } from '../receiptText';
import type { Box, ParsedReceipt, RecognizedLine, RecognizedText } from '../receiptTypes';
import { RecognitionError } from '../recognitionError';
import { assessQuality, pickBetter } from './assessQuality';
import { MAX_RESCALE, MIN_RESCALE } from './textHeight';
import type { QualityVerdict, ZoomOptions } from './types';

// ---------- constants (criterion 71) ----------

/**
 * Most rows re-read per read (per pass).
 * Why: each re-read is one more Tesseract call on a small image (a row at ~40 px text is a few
 * hundred thousand pixels, a fraction of a page read), so 8 keeps the added time to a few seconds and
 * the scan well inside the criterion-62 budget (25 s median), on a slow phone too. A read with more
 * doubtful rows than that is usually a bad photo, where a retake or typing it in beats row-by-row
 * repair; the cap goes to the rows most likely to matter (see `selectDoubtfulRows`).
 * Tuned: not tuned (spec starting value; E9 2026-11-24, 1 checked tuning receipt, not adopted).
 */
export const MAX_ZOOM_ROWS = 8;

/**
 * A row read below this line confidence (0–100) is a candidate even when it has a price.
 * Why: Tesseract's line confidence is the mean of its word confidences; below ~60 at least some
 * characters were close calls, which is where single-digit misreads come from.
 * Tuned: not tuned (spec starting value; E9 2026-11-24, not adopted).
 */
export const ZOOM_LOW_CONFIDENCE = 60;

/**
 * A re-read replaces the row only if its confidence is at least this much higher.
 * Why: two reads of the same pixels differ by a few points by chance; a gain smaller than that isn't
 * evidence the new read is right, and replacing on noise would swap right reads for wrong ones.
 * Tuned: not tuned (spec starting value; E9 2026-11-24, not adopted).
 */
export const ZOOM_MIN_CONFIDENCE_GAIN = 5;

/**
 * Crop margin around a row's box: max(ZOOM_MARGIN_MIN_PX, ZOOM_MARGIN_LINE_HEIGHTS × box height).
 * Why: tessdoc asks for about a 10 px border; Tesseract's line box hugs the ink, and a tilted row or
 * a descender can poke out of it, so the margin grows with the text (0.3 line heights is under half
 * the gap to the next row on usual line spacing, so the neighbours stay mostly out).
 * Tuned: not tuned (spec starting value).
 */
export const ZOOM_MARGIN_MIN_PX = 10;
export const ZOOM_MARGIN_LINE_HEIGHTS = 0.3;

/**
 * The line-box height (px) a row is scaled to when the variant has no text-height target.
 * Why: the middle of the Task 8 targets (28–46 px, about 20–35 px capitals, Tesseract's best range).
 * Tuned: not tuned (spec starting value; E2 found 40 the cheapest of the targets that helped).
 */
export const ZOOM_DEFAULT_TARGET_PX = 40;

/**
 * With no total line found, how many lines after the last priced row still count as the item region.
 * Why: the total is printed directly under the last amount (the last item, subtotal, tax or tip),
 * usually on the next row or two; a lost total line ("Total 57.1") is right there. Further down are
 * payment, footer and marketing lines, where a re-read can't add a total and only costs time.
 * Tuned: not tuned (new in Task 13).
 */
export const NO_TOTAL_LOOKAHEAD_LINES = 3;

/**
 * Tesseract page segmentation for a re-read: 7 = "treat the image as a single text line".
 * Why: the crop holds one row; letting Tesseract look for a page layout in it (PSM 6) can split the
 * row or read the margin's slivers of the neighbouring rows as lines of their own.
 */
export const ZOOM_PAGESEG_MODE = '7';

// ---------- price tokens and line roles ----------

// The parser's money-token shape (`NUM` / `TOKEN_SOURCE` in lib/receiptText.ts): exactly two
// decimals, not followed by more digits, another decimal part or `%`, not preceded by a digit, `.`
// or `,`. The spec asked for a read-only `hasPriceToken` export from the parser; the parser is outside
// this task's scope, so the shape is repeated here and a test checks it against `parseReceipt`.
const PRICE_TOKEN_RE = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?!\d|\.\d|\s?%)/g;
const DIGIT_OR_CURRENCY_RE = /[\d$]/;

/** How many 2-dp money tokens `text` has. */
export function countPriceTokens(text: string): number {
  return text.match(PRICE_TOKEN_RE)?.length ?? 0;
}

export function hasPriceToken(text: string): boolean {
  return countPriceTokens(text) > 0;
}

/**
 * What a line is on its own, read by the parser itself: an item, one of the totals lines, a
 * discount, a bare price (a price printed on its own row), or nothing the parser can use (null).
 */
export type LineRole = 'item' | 'subtotal' | 'tax' | 'tip' | 'fees' | 'total' | 'discount' | 'price' | null;

export function lineRole(text: string): LineRole {
  const p = parseReceipt({ lines: [{ text }] });
  if (p.items.length > 0) return 'item';
  if (p.totalCents !== null) return 'total';
  if (p.subtotalCents !== null) return 'subtotal';
  if (p.taxCents !== null) return 'tax';
  if (p.tipCents !== null) return 'tip';
  if (p.feesCents !== null) return 'fees';
  if (p.discounts.length > 0) return 'discount';
  // Only a price and punctuation/currency around it.
  if (countPriceTokens(text) === 1 && !/[\p{L}\p{N}]/u.test(text.replace(PRICE_TOKEN_RE, ''))) return 'price';
  return null;
}

// ---------- which rows ----------

export type DoubtReason = 'no_price' | 'implicated' | 'low_confidence';

export type DoubtfulRow = { index: number; reason: DoubtReason; confidence: number | null };

/** A line's confidence, or null when the engine gave none (counted as the least confident). */
function conf(l: RecognizedLine): number | null {
  return typeof l.confidence === 'number' && Number.isFinite(l.confidence) ? l.confidence : null;
}

/**
 * The rows worth re-reading, most useful first, at most `opts.maxRows`.
 *
 * Only the item region counts: from the first line with a price token to the line holding the total
 * (or, with no total line, `NO_TOTAL_LOOKAHEAD_LINES` past the last priced line). Above it is the
 * header, below it payment and footer text. Only lines with a box can be cut out.
 *
 * A line qualifies when it has no 2-dp price, when it belongs to a `qty_price_mismatch` item or the
 * totals don't add up (then every priced row is a suspect), or when its confidence is below
 * `opts.minLineConfidence`. Order: rows with no price but a digit or `$` (a broken price: "57.1",
 * "$E.00") first, then implicated rows, then rows with no price at all, then low-confidence rows;
 * within each kind by ascending confidence, then top to bottom.
 * Why the kinds come before confidence (the spec ordered by confidence alone): on real photos whole
 * receipts read at 20–50 confidence, so confidence alone spends the cap on junk rows and never reaches
 * a confident-looking "Tax $10.4", which is exactly the misread that breaks the sums. A broken price
 * can only be fixed by a re-read; a priced row is only a suspect.
 */
export function selectDoubtfulRows(
  text: RecognizedText,
  parsed: ParsedReceipt,
  verdict: QualityVerdict,
  opts: Pick<ZoomOptions, 'minLineConfidence' | 'maxRows'>,
): DoubtfulRow[] {
  const lines = text.lines;
  const priced = lines.map((l) => hasPriceToken(l.text));
  const start = priced.indexOf(true);
  if (start < 0 || opts.maxRows <= 0) return [];
  const roles = lines.map((l) => lineRole(l.text));
  const lastTotal = roles.lastIndexOf('total');
  const end = lastTotal >= start ? lastTotal : Math.min(lines.length - 1, priced.lastIndexOf(true) + NO_TOTAL_LOOKAHEAD_LINES);

  const gap = verdict.problems.includes('items_vs_subtotal') || verdict.problems.includes('subtotal_vs_total');
  const flagged = parsed.items.filter((i) => i.flags?.includes('qty_price_mismatch'));
  const isFlaggedLine = (t: string) => {
    if (flagged.length === 0) return false;
    const own = parseReceipt({ lines: [{ text: t }] }).items;
    return own.some((o) => o.flags?.includes('qty_price_mismatch') || flagged.some((f) => f.name === o.name && f.totalCents === o.totalCents));
  };

  const found: (DoubtfulRow & { tier: number })[] = [];
  for (let i = start; i <= end; i++) {
    const line = lines[i] as RecognizedLine;
    if (!line.box || !(line.box.width > 0 && line.box.height > 0)) continue;
    const c = conf(line);
    let tier: number;
    let reason: DoubtReason;
    if (!priced[i] && DIGIT_OR_CURRENCY_RE.test(line.text)) [tier, reason] = [0, 'no_price'];
    else if (priced[i] && (gap || isFlaggedLine(line.text))) [tier, reason] = [1, 'implicated'];
    else if (!priced[i]) [tier, reason] = [2, 'no_price'];
    else if (c === null || c < opts.minLineConfidence) [tier, reason] = [3, 'low_confidence'];
    else continue;
    found.push({ index: i, reason, confidence: c, tier });
  }
  found.sort((a, b) => a.tier - b.tier || (a.confidence ?? -Infinity) - (b.confidence ?? -Infinity) || a.index - b.index);
  return found.slice(0, opts.maxRows).map(({ index, reason, confidence }) => ({ index, reason, confidence }));
}

// ---------- the accept rule ----------

export type ZoomRejection = 'no_gain' | 'lost_price' | 'not_one_price' | 'invalid_line' | 'role_changed';

/**
 * Whether a single-line re-read may replace the original row. All of these must hold:
 * - it read something;
 * - its confidence is at least the old one + `minGain` (an old line without a confidence counts as 0;
 *   a re-read without one is never accepted);
 * - a row that had a price still has one, and a row that had none gains exactly one (two new prices
 *   on one row is a misread of the row, not a fix);
 * - the parser can use it on its own: an item, a totals line, a discount or a bare price;
 * - it is still the same kind of line, when the old one was usable (a total stays a total).
 */
export function acceptZoomRead(
  old: RecognizedLine,
  next: Pick<RecognizedLine, 'text' | 'confidence'>,
  minGain: number,
): { ok: true } | { ok: false; reason: ZoomRejection } {
  const text = next.text.trim();
  if (text.length === 0) return { ok: false, reason: 'invalid_line' };
  const newConf = conf({ text, confidence: next.confidence });
  if (newConf === null || newConf < (conf(old) ?? 0) + minGain) return { ok: false, reason: 'no_gain' };
  const hadPrice = hasPriceToken(old.text);
  const tokens = countPriceTokens(text);
  if (hadPrice && tokens === 0) return { ok: false, reason: 'lost_price' };
  if (!hadPrice && tokens !== 1) return { ok: false, reason: 'not_one_price' };
  const role = lineRole(text);
  if (role === null) return { ok: false, reason: 'invalid_line' };
  const oldRole = lineRole(old.text);
  if (oldRole !== null && oldRole !== role) return { ok: false, reason: 'role_changed' };
  return { ok: true };
}

// ---------- crop geometry ----------
// `clampRect` and `scaledCropSize` live in lib/imageSize.ts (shared size math), because both canvas
// implementations (lib/prepareImage.web.ts and the harness's prepare-current.ts) use them too.
export { clampRect, scaledCropSize } from '../imageSize';

/** The row's box grown by the margin on every side (may extend past the image; see `clampRect`). */
export function zoomCropRect(box: Box): Box {
  const m = Math.max(ZOOM_MARGIN_MIN_PX, ZOOM_MARGIN_LINE_HEIGHTS * box.height);
  return { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m };
}

/**
 * The factor that brings a row's box height to `targetPx`, clamped to the text-height pass's range
 * (`MIN_RESCALE`–`MAX_RESCALE`, textHeight.ts): beyond 3× it is interpolation, below 0.5× strokes merge.
 */
export function zoomScale(boxHeight: number, targetPx: number): number {
  if (![boxHeight, targetPx].every((v) => Number.isFinite(v) && v > 0)) throw new RangeError('zoomScale needs positive, finite numbers');
  return Math.min(MAX_RESCALE, Math.max(MIN_RESCALE, targetPx / boxHeight));
}

// ---------- the loop ----------

/**
 * Re-reads one row: crop it from the image the pass read, scale it, read it as a single line.
 * Resolves with the single line read, or null when the read found nothing usable (no line, or more
 * than one). Rejects with `RecognitionError`: `cancelled` and `timeout` end the zoom; anything else
 * only skips the row.
 */
export type ZoomReread = (line: RecognizedLine & { box: Box }, index: number) => Promise<Pick<RecognizedLine, 'text' | 'confidence'> | null>;

export type ZoomRowOutcome = 'replaced' | ZoomRejection | 'no_read' | 'read_failed' | 'timeout';

export type ZoomRowReport = {
  index: number;
  reason: DoubtReason;
  before: string;
  oldConfidence: number | null;
  after: string | null;
  newConfidence: number | null;
  outcome: ZoomRowOutcome;
};

/**
 * What zoom did on one read (harness: `meta.zoom`). `kept`: `unchanged` when no row was replaced,
 * else whether pickBetter kept the zoomed read or the original. `stopped: 'timeout'` when a re-read
 * hit the recognize ceiling (the session is finished then, so no more rows are read).
 */
export type ZoomReport = { rows: ZoomRowReport[]; kept: 'unchanged' | 'zoomed' | 'original'; stopped: 'timeout' | null };

function score(text: RecognizedText) {
  const parsed = parseReceipt(text);
  return { text, parsed, verdict: assessQuality(text, parsed) };
}

/**
 * Zoom on doubt over one read. Resolves with the text to use (the original object when nothing
 * changed or pickBetter kept it) and a report. Rejects only with `RecognitionError('cancelled')`.
 */
export async function zoomOnDoubt(
  text: RecognizedText,
  opts: ZoomOptions,
  reread: ZoomReread,
  signal?: AbortSignal,
): Promise<{ text: RecognizedText; report: ZoomReport }> {
  const before = score(text);
  const rows = selectDoubtfulRows(text, before.parsed, before.verdict, opts);
  const lines = [...text.lines];
  const report: ZoomReport = { rows: [], kept: 'unchanged', stopped: null };
  let replaced = 0;

  for (const row of rows) {
    if (signal?.aborted) throw new RecognitionError('cancelled');
    const old = text.lines[row.index] as RecognizedLine & { box: Box };
    const entry: ZoomRowReport = {
      index: row.index,
      reason: row.reason,
      before: old.text,
      oldConfidence: row.confidence,
      after: null,
      newConfidence: null,
      outcome: 'no_read',
    };
    report.rows.push(entry);
    let next: Pick<RecognizedLine, 'text' | 'confidence'> | null;
    try {
      next = await reread(old, row.index);
    } catch (e) {
      if (e instanceof RecognitionError && e.code === 'cancelled') throw e;
      if (e instanceof RecognitionError && e.code === 'timeout') {
        entry.outcome = 'timeout';
        report.stopped = 'timeout';
        break;
      }
      entry.outcome = 'read_failed';
      continue;
    }
    if (signal?.aborted) throw new RecognitionError('cancelled');
    if (next === null) continue;
    entry.after = next.text;
    entry.newConfidence = conf({ text: next.text, confidence: next.confidence });
    const verdict = acceptZoomRead(old, next, opts.minConfidenceGain);
    if (!verdict.ok) {
      entry.outcome = verdict.reason;
      continue;
    }
    entry.outcome = 'replaced';
    replaced += 1;
    const line: RecognizedLine = { text: next.text.trim(), box: old.box };
    if (entry.newConfidence !== null) line.confidence = entry.newConfidence;
    lines[row.index] = line;
  }

  if (replaced === 0) return { text, report };
  const after = score({ lines });
  const best = pickBetter(before, after);
  report.kept = best === before ? 'original' : 'zoomed';
  return { text: best.text, report };
}
