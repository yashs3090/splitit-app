// The scan pipeline's "did it work?" rule (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C2).
// Pure. Used by the pipeline on every platform to decide whether to retry, and by the eval's `--flow`.
//
// The totals checks are the parser's own: the gap problems are exactly what `checkTotals` reports,
// with its ±1¢ per check, and the gap size comes from `totalsGaps`. Nothing here redefines that
// tolerance, so the scan's verdict can never disagree with the form's "adds up".
import type { ParsedReceipt, RecognizedText } from '../receiptTypes';
import { checkTotals, totalsGaps } from '../receiptText';
import type { QualityVerdict, ScanProblem, Scored } from './types';

export type { QualityVerdict, ScanProblem, Scored } from './types';

/**
 * Fewest recognised lines a usable read can have.
 * Why: any itemised receipt prints at least a header, one item and a total, and almost always a
 * subtotal or tax line too; fewer than 5 lines means the reader saw a fragment or noise, not a
 * receipt. A general property of receipts, not a value fitted to any photo.
 * Tuned: starting value (2026-11-22), not yet tuned.
 */
export const MIN_LINES = 5;

/** Gap problems, in the order `checkTotals` reports them. */
const GAP_PROBLEMS = ['items_vs_subtotal', 'subtotal_vs_total'] as const;

export function assessQuality(text: RecognizedText, parsed: ParsedReceipt): QualityVerdict {
  const problems: ScanProblem[] = [];
  if (parsed.items.length === 0) problems.push('no_items');
  if (text.lines.length < MIN_LINES) problems.push('too_few_lines');
  if (parsed.totalCents === null) problems.push('no_total');

  const reasons = checkTotals(parsed);
  for (const p of GAP_PROBLEMS) if (reasons.includes(p)) problems.push(p);

  const gaps = totalsGaps(parsed);
  const gapCents = GAP_PROBLEMS.reduce((acc, p) => acc + Math.abs(gaps[p] ?? 0), 0);

  return { ok: problems.length === 0, problems, gapCents };
}

/**
 * The better of two reads, by the first of these that differs:
 * 1. ok beats not ok;
 * 2. found items beats `no_items`;
 * 3. enough lines beats `too_few_lines` (a fragment);
 * 4. found a total beats `no_total`;
 * 5. smaller `gapCents`;
 * 6. fewer failed totals checks;
 * 7. more items;
 * 8. more lines;
 * 9. a full tie keeps `a`.
 *
 * Why this order (amends C2's "fewer problems, then smaller gap", Task 11): a missing piece is worse
 * than a wrong number. A read without a total (or without items, or a fragment) has nothing to
 * compare, so its gap is 0 and its problem count is low, and the old order ranked it above a read
 * that found the total but is a few dollars off. That read is the more useful one: the form shows
 * what it found, and the totals banner shows by how much it's off. So the structural problems are
 * compared first, worst first, and only then the size of the gap; the gap size comes before the
 * count of failed checks, because two checks off by 2¢ are closer than one off by $50.
 */
export function pickBetter<T extends Scored>(a: T, b: T): T {
  const has = (s: Scored, p: ScanProblem) => (s.verdict.problems.includes(p) ? 1 : 0);
  const keys: ((s: Scored) => number)[] = [
    (s) => (s.verdict.ok ? 0 : 1),
    (s) => has(s, 'no_items'),
    (s) => has(s, 'too_few_lines'),
    (s) => has(s, 'no_total'),
    (s) => s.verdict.gapCents,
    (s) => GAP_PROBLEMS.reduce((n, p) => n + has(s, p), 0),
    (s) => -s.parsed.items.length,
    (s) => -s.text.lines.length,
  ];
  for (const key of keys) {
    const d = key(a) - key(b);
    if (d !== 0) return d < 0 ? a : b;
  }
  return a;
}
