// The "Who paid?" page (app/(app)/bills/[id]/payers.tsx): one row per person, typed either as an
// amount or as a percentage of the bill, with the total at the bottom. Pure, so the money rules are
// unit-tested here (lib/payersForm.test.ts) and the screen only draws them.
//
// Rules:
// - Money is integer cents. Percentages are integer hundredths of a percent (lib/money.ts): 25.5% → 2550.
// - Percentages become cents with largest-remainder rounding, so when they add up to exactly 100% the
//   cents add up to exactly the bill total (the same promise as the split math, CLAUDE.md).
// - The amounts must add up to the total exactly (tolerance 0, the same rule as set_payers, D1).
// - One person with the whole bill saves as one payer (set_payer); two or more as a split (set_payers).
// - Amount fields keep the sheet's grammar and errors (lib/payers.ts readField).
// - Switching units never changes money (QA A-50(c)): amounts carry their exact cents into percent
//   mode (`keptCents`), the percentage shown there is display only, and switching back shows the same
//   cents. Only a row the host types a percentage into gets cents from a percentage. With any kept
//   row, percent mode checks the cents (Σ = total, tolerance 0) and says the gap in dollars.
//
// This page replaces the spec's sheet (docs/specs/2026-11-26-who-paid.md A1.5) at the user's request
// (2026-11-27): see docs/decisions-to-review.md, WP-PAGE-*.
import { formatCents, formatCentsInput, formatPercent, MAX_PERCENT_HUNDREDTHS, parsePercentInput } from './money';
import {
  FIELD_ERROR_FORMAT,
  FIELD_ERROR_TOO_LARGE,
  MAX_PAYERS,
  payersChangeIsNoop,
  readField,
  type Payer,
  type PayersChange,
  type PayersState,
  type SplitField,
} from './payers';

export type PaidUnit = 'amount' | 'percent';

/**
 * One row of the page. `keptCents` (QA A-50(c)): the row's exact cents, carried from amount mode
 * into percent mode, where `text` is then only a display percentage. A row the host edits loses it
 * (the screen's edit writes `{ userId, text }`) and becomes a typed percentage. Amount mode ignores
 * it: there the text is exact.
 */
export type PaidField = SplitField & { keptCents?: number };

/** The row's kept cents in percent mode, or null when the text decides. */
function keptOf(field: PaidField): number | null {
  const c = field.keptCents;
  return typeof c === 'number' && Number.isSafeInteger(c) && c > 0 ? c : null;
}

/**
 * A-50(h), review R5: the page's own requests (the re-read before saving, set_payer, set_payers)
 * give up after this long and read as a network error, so Save and Back come back. The same 15 s
 * as the Groups screens' GROUP_REQUEST_TIMEOUT_MS (lib/groups.ts).
 */
export const PAYERS_REQUEST_TIMEOUT_MS = 15_000;

export const PERCENT_ERROR_FORMAT = 'Enter a percentage like 25';
export const PERCENT_ERROR_TOO_LARGE = 'A percentage can be at most 100';
/** A-50(d), product default WP-R10: a typed percentage whose share is 0 cents once they add up. */
export const PERCENT_ERROR_ROUNDS_TO_ZERO = 'Rounds to $0.00. Enter a larger share or clear it.';

export const PAYERS_FORM_COPY = {
  title: 'Who paid?',
  subtitle: 'Enter how much each person paid. The amounts must add up to the bill total.',
  unitGroup: 'Enter who paid as',
  unitAmount: 'Amount ($)',
  unitPercent: 'Percent (%)',
  total: 'Bill total',
  save: 'Save',
  saveHint: 'Saves who paid the bill',
  cancel: 'Cancel',
  /** A-50(i), product default WP-R9: the page opens from the bill screen as well as from Settle up. */
  back: 'Back',
  onlyHost: (host: string) => `Only ${host} can change who paid.`,
  alone: 'Others show up here once they join.',
  saveFailed: "Couldn't save who paid. Try again.",
  /** An unknown save (timed out, or a lost answer) turned out to have saved (round 2 R1, R6). */
  savedEarlier: 'Your earlier save went through.',
} as const;

/**
 * `hundredths[i]` percent of `totalCents`, in cents, by largest remainder: each share is
 * floor(total × h / 10000), then the cents left over go one each to the largest fractional parts
 * (ties to the earlier row). When Σ hundredths = 10000 the result sums to `totalCents` exactly.
 * Throws on non-integer or negative input, or a sum over 100%.
 */
export function percentsToCents(hundredths: readonly number[], totalCents: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('percentsToCents: bad total');
  let sum = 0;
  for (const h of hundredths) {
    if (!Number.isSafeInteger(h) || h < 0) throw new RangeError('percentsToCents: bad percentage');
    sum += h;
  }
  if (sum > MAX_PERCENT_HUNDREDTHS) throw new RangeError('percentsToCents: over 100%');
  if (!Number.isSafeInteger(totalCents * MAX_PERCENT_HUNDREDTHS)) throw new RangeError('percentsToCents: total too large');
  const exact = hundredths.map((h) => totalCents * h); // in 1/10000 of a cent, still integers
  const floors = exact.map((e) => Math.floor(e / MAX_PERCENT_HUNDREDTHS));
  // What the shares should add up to: the same percentage of the total, as a whole number of cents.
  const target = Math.floor((totalCents * sum) / MAX_PERCENT_HUNDREDTHS);
  let left = target - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e % MAX_PERCENT_HUNDREDTHS }))
    .filter((r) => r.rem > 0)
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  const out = [...floors];
  for (const r of order) {
    if (left <= 0) break;
    out[r.i] = (out[r.i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

/**
 * The percentages (hundredths) that `cents` are of `totalCents`, by largest remainder, so that
 * amounts adding up to the total give percentages adding up to exactly 100%. Used when switching the
 * page from amounts to percentages. A total of 0 gives all zeros.
 */
export function centsToPercents(cents: readonly number[], totalCents: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new RangeError('centsToPercents: bad total');
  if (totalCents === 0) return cents.map(() => 0);
  const sum = cents.reduce((a, b) => a + b, 0);
  const exact = cents.map((c) => {
    if (!Number.isSafeInteger(c) || c < 0) throw new RangeError('centsToPercents: bad amount');
    return c * MAX_PERCENT_HUNDREDTHS;
  });
  const floors = exact.map((e) => Math.floor(e / totalCents));
  const target = Math.floor((sum * MAX_PERCENT_HUNDREDTHS) / totalCents);
  let left = target - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e % totalCents }))
    .filter((r) => r.rem > 0)
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  const out = [...floors];
  for (const r of order) {
    if (left <= 0) break;
    out[r.i] = (out[r.i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

/** A percentage as the field shows it: 2550 → `25.5` (no `%` sign; the field has its own). */
export function percentInputText(hundredths: number): string {
  return formatPercent(hundredths).replace(/%$/, '');
}

/**
 * The page's opening fields, in participant order, as amounts. One person: the payer (the host,
 * unless someone changed it) has the whole total, everyone else is blank. Split: the stored amounts.
 */
export function initialPaidFields(state: PayersState, participantIds: readonly string[]): SplitField[] {
  const stored = new Map(state.payers.map((p) => [p.userId, p.paidCents]));
  return participantIds.map((userId) => {
    const cents = stored.get(userId);
    return { userId, text: cents === undefined ? '' : formatCentsInput(cents) };
  });
}

export type PaidRowState =
  | { userId: string; kind: 'blank' }
  /** `cents`: what this row pays. In percent mode, `hundredths` is what was typed. */
  | { userId: string; kind: 'value'; cents: number; hundredths: number | null }
  | { userId: string; kind: 'invalid'; error: string };

export type PayersFormStatus = {
  rows: PaidRowState[];
  /** The one status line under the rows. */
  text: string;
  tone: 'muted' | 'warning' | 'success' | 'error';
  /** Σ of the valid rows, in cents (in percent mode: only meaningful once the percentages add up). */
  assignedCents: number;
  /**
   * Percent mode: Σ of the valid percentages, in hundredths (with kept cents: 10000 once the cents
   * add up, else null, since kept cents aren't whole hundredths). Null in amount mode.
   */
  assignedHundredths: number | null;
  /** What saving would store, when the amounts add up; null otherwise. */
  change: PayersChange | null;
  /** The disabled Save button's hint; null when the draft adds up. */
  saveHint: string | null;
};

/** Reads one percentage field: blank (or 0) means "didn't pay". */
function readPercent(field: SplitField): { kind: 'blank' } | { kind: 'value'; hundredths: number } | { kind: 'invalid'; error: string } {
  const s = field.text.trim();
  if (s === '') return { kind: 'blank' };
  const h = parsePercentInput(s);
  if (h === null) {
    // Well formed but over 100 reads as "too large", anything else as a format error.
    return /^\d+(\.\d{0,2})?%?$/.test(s)
      ? { kind: 'invalid', error: PERCENT_ERROR_TOO_LARGE }
      : { kind: 'invalid', error: PERCENT_ERROR_FORMAT };
  }
  if (h === 0) return { kind: 'blank' };
  return { kind: 'value', hundredths: h };
}

function changeOf(payers: Payer[]): PayersChange | null {
  const paying = payers.filter((p) => p.paidCents > 0);
  if (paying.length === 1 && paying[0]) return { mode: 'one', payerId: paying[0].userId };
  if (paying.length >= 2) return { mode: 'split', payers: paying };
  return null;
}

/**
 * The status of the page's draft: per-row values and errors, the one status line, and what saving
 * would store. First match wins: a field error → too many people → short → over → adds up.
 */
export function payersFormStatus(unit: PaidUnit, fields: readonly PaidField[], totalCents: number): PayersFormStatus {
  const mustAddUp = `Amounts must add up to ${formatCents(totalCents)} first`;
  if (unit === 'amount') {
    const rows: PaidRowState[] = fields.map((field) => {
      const f = readField(field);
      if (f.kind === 'amount')
        return {
          userId: f.userId,
          kind: 'value',
          cents: f.cents,
          hundredths: null,
        };
      if (f.kind === 'invalid') return { userId: f.userId, kind: 'invalid', error: f.error };
      return { userId: f.userId, kind: 'blank' };
    });
    const payers = rows.flatMap((r) => (r.kind === 'value' ? [{ userId: r.userId, paidCents: r.cents }] : []));
    const assignedCents = payers.reduce((sum, p) => sum + p.paidCents, 0);
    const base = { rows, assignedCents, assignedHundredths: null };
    const invalid = rows.filter((r) => r.kind === 'invalid').length;
    if (invalid > 0) {
      return {
        ...base,
        text: invalid === 1 ? 'Fix the amount marked above' : 'Fix the amounts marked above',
        tone: 'error',
        change: null,
        saveHint: mustAddUp,
      };
    }
    if (payers.length > MAX_PAYERS)
      return {
        ...base,
        text: `Up to ${MAX_PAYERS} people can share the paying.`,
        tone: 'error',
        change: null,
        saveHint: mustAddUp,
      };
    const gap = totalCents - assignedCents;
    if (gap > 0)
      return {
        ...base,
        text: `${formatCents(gap)} left to assign`,
        tone: 'muted',
        change: null,
        saveHint: mustAddUp,
      };
    if (gap < 0)
      return {
        ...base,
        text: `${formatCents(-gap)} more than the total`,
        tone: 'warning',
        change: null,
        saveHint: mustAddUp,
      };
    const change = changeOf(payers);
    if (change === null)
      return {
        ...base,
        text: 'Enter who paid',
        tone: 'muted',
        change: null,
        saveHint: mustAddUp,
      };
    return {
      ...base,
      text: `Adds up to ${formatCents(totalCents)}`,
      tone: 'success',
      change,
      saveHint: null,
    };
  }

  const mustAddUpPercent = 'Percentages must add up to 100% first';
  if (fields.some((f) => keptOf(f) !== null)) return keptPercentStatus(fields, totalCents, mustAddUpPercent);
  const read = fields.map((f) => ({ userId: f.userId, r: readPercent(f) }));
  const invalid = read.filter((x) => x.r.kind === 'invalid').length;
  const hundredths = read.map((x) => (x.r.kind === 'value' ? x.r.hundredths : 0));
  const assignedHundredths = hundredths.reduce((a, b) => a + b, 0);
  // Cents only once the percentages are valid and not over 100%; until then, each row's own share.
  const cents = assignedHundredths <= MAX_PERCENT_HUNDREDTHS ? percentsToCents(hundredths, totalCents) : hundredths.map(() => 0);
  const rows: PaidRowState[] = read.map((x, i) =>
    x.r.kind === 'invalid'
      ? { userId: x.userId, kind: 'invalid', error: x.r.error }
      : x.r.kind === 'blank'
        ? { userId: x.userId, kind: 'blank' }
        : {
            userId: x.userId,
            kind: 'value',
            cents: cents[i] ?? 0,
            hundredths: x.r.hundredths,
          },
  );
  const assignedCents = cents.reduce((a, b) => a + b, 0);
  const base = { rows, assignedCents, assignedHundredths };
  if (invalid > 0) {
    return {
      ...base,
      text: invalid === 1 ? 'Fix the percentage marked above' : 'Fix the percentages marked above',
      tone: 'error',
      change: null,
      saveHint: mustAddUpPercent,
    };
  }
  if (read.filter((x) => x.r.kind === 'value').length > MAX_PAYERS) {
    return {
      ...base,
      text: `Up to ${MAX_PAYERS} people can share the paying.`,
      tone: 'error',
      change: null,
      saveHint: mustAddUpPercent,
    };
  }
  const gap = MAX_PERCENT_HUNDREDTHS - assignedHundredths;
  if (gap > 0)
    return {
      ...base,
      text: `${formatPercent(gap)} left to assign`,
      tone: 'muted',
      change: null,
      saveHint: mustAddUpPercent,
    };
  if (gap < 0)
    return {
      ...base,
      text: `${formatPercent(-gap)} more than 100%`,
      tone: 'warning',
      change: null,
      saveHint: mustAddUpPercent,
    };
  // At 100% the cents are final: a typed share that rounds to 0 cents would silently drop that
  // person from who paid, so it's refused on its row instead (A-50(d), WP-R10). A $0.00 bill has no
  // cents to give anyone, so it keeps "Enter who paid" below.
  const zeroRows = totalCents > 0 ? rows.filter((r) => r.kind === 'value' && r.cents === 0).length : 0;
  if (zeroRows > 0) {
    const marked: PaidRowState[] = rows.map((r) =>
      r.kind === 'value' && r.cents === 0 ? { userId: r.userId, kind: 'invalid', error: PERCENT_ERROR_ROUNDS_TO_ZERO } : r,
    );
    return {
      ...base,
      rows: marked,
      text: zeroRows === 1 ? 'Fix the percentage marked above' : 'Fix the percentages marked above',
      tone: 'error',
      change: null,
      // They do add up to 100%, so the disabled Save points at the row instead.
      saveHint: zeroRows === 1 ? 'Fix the percentage marked above' : 'Fix the percentages marked above',
    };
  }
  const payers = rows.flatMap((r) => (r.kind === 'value' && r.cents > 0 ? [{ userId: r.userId, paidCents: r.cents }] : []));
  const change = changeOf(payers);
  // 100% that rounds to nobody (a $0.00 bill): nothing to store.
  if (change === null)
    return {
      ...base,
      text: 'Enter who paid',
      tone: 'muted',
      change: null,
      saveHint: mustAddUpPercent,
    };
  if (change.mode === 'split' && totalCents < 2) {
    return {
      ...base,
      text: 'Only one person can pay a bill this small.',
      tone: 'muted',
      change: null,
      saveHint: mustAddUpPercent,
    };
  }
  return {
    ...base,
    text: `Adds up to 100% · ${formatCents(totalCents)}`,
    tone: 'success',
    change,
    saveHint: null,
  };
}

/**
 * Percent mode with at least one kept row (QA A-50(c)). Kept rows count their exact cents; typed
 * percentages become cents by largest remainder (percentsToCents over the typed rows). The check is
 * on cents, as in amount mode: Σ = total, tolerance 0. Gaps read in dollars, because kept cents
 * aren't whole hundredths of a percent.
 */
function keptPercentStatus(fields: readonly PaidField[], totalCents: number, mustAddUp: string): PayersFormStatus {
  const read = fields.map((f) => {
    const kept = keptOf(f);
    return kept !== null ? ({ kind: 'kept', cents: kept } as const) : readPercent(f);
  });
  const typed = read.map((r) => (r.kind === 'value' ? r.hundredths : 0));
  const typedSum = typed.reduce((a, b) => a + b, 0);
  const typedCents = typedSum <= MAX_PERCENT_HUNDREDTHS ? percentsToCents(typed, totalCents) : typed.map(() => 0);
  const rows: PaidRowState[] = read.map((r, i) => {
    const userId = fields[i]?.userId ?? '';
    if (r.kind === 'kept') return { userId, kind: 'value', cents: r.cents, hundredths: null };
    if (r.kind === 'invalid') return { userId, kind: 'invalid', error: r.error };
    if (r.kind === 'blank') return { userId, kind: 'blank' };
    return { userId, kind: 'value', cents: typedCents[i] ?? 0, hundredths: r.hundredths };
  });
  const assignedCents = rows.reduce((sum, r) => sum + (r.kind === 'value' ? r.cents : 0), 0);
  const base = { rows, assignedCents, assignedHundredths: assignedCents === totalCents ? MAX_PERCENT_HUNDREDTHS : null };
  const blocked = (text: string, tone: PayersFormStatus['tone']): PayersFormStatus => ({ ...base, text, tone, change: null, saveHint: mustAddUp });
  const invalid = rows.filter((r) => r.kind === 'invalid').length;
  if (invalid > 0) return blocked(invalid === 1 ? 'Fix the percentage marked above' : 'Fix the percentages marked above', 'error');
  if (rows.filter((r) => r.kind === 'value').length > MAX_PAYERS) return blocked(`Up to ${MAX_PAYERS} people can share the paying.`, 'error');
  if (typedSum > MAX_PERCENT_HUNDREDTHS) return blocked(`${formatPercent(typedSum - MAX_PERCENT_HUNDREDTHS)} more than 100%`, 'warning');
  const gap = totalCents - assignedCents;
  if (gap > 0) return blocked(`${formatCents(gap)} left to assign`, 'muted');
  if (gap < 0) return blocked(`${formatCents(-gap)} more than the total`, 'warning');
  const zeroRows = rows.filter((r) => r.kind === 'value' && r.cents === 0).length;
  if (zeroRows > 0) {
    const text = zeroRows === 1 ? 'Fix the percentage marked above' : 'Fix the percentages marked above';
    return {
      ...base,
      rows: rows.map((r) => (r.kind === 'value' && r.cents === 0 ? { userId: r.userId, kind: 'invalid', error: PERCENT_ERROR_ROUNDS_TO_ZERO } : r)),
      text,
      tone: 'error',
      change: null,
      saveHint: text,
    };
  }
  const change = changeOf(rows.flatMap((r) => (r.kind === 'value' && r.cents > 0 ? [{ userId: r.userId, paidCents: r.cents }] : [])));
  if (change === null) return blocked('Enter who paid', 'muted');
  return { ...base, text: `Adds up to 100% · ${formatCents(totalCents)}`, tone: 'success', change, saveHint: null };
}

/**
 * The fields after switching units. Money never changes (QA A-50(c)):
 * - amount → percent: each valid amount keeps its exact cents (`keptCents`) and shows its percentage
 *   (largest remainder, so a total that adds up shows exactly 100%), for display only;
 * - percent → amount: a kept row shows its exact cents again; a typed percentage shows the cents it
 *   gives now; one that rounds to $0.00 becomes blank.
 * An invalid field keeps its raw text both ways.
 */
export function switchUnit(from: PaidUnit, to: PaidUnit, fields: readonly PaidField[], totalCents: number): PaidField[] {
  if (from === to) return [...fields];
  const status = payersFormStatus(from, fields, totalCents);
  if (to === 'percent') {
    const cents = status.rows.map((r) => (r.kind === 'value' ? r.cents : 0));
    const sum = cents.reduce((x, y) => x + y, 0);
    const pct = totalCents === 0 ? cents.map(() => 0) : centsToPercents(cents, Math.max(totalCents, sum));
    return status.rows.map((r, i): PaidField => {
      if (r.kind === 'value' && r.cents > 0) return { userId: r.userId, text: percentInputText(pct[i] ?? 0), keptCents: r.cents };
      return { userId: r.userId, text: r.kind === 'invalid' ? (fields[i]?.text ?? '') : '' };
    });
  }
  return status.rows.map((r, i): PaidField => {
    const field = fields[i];
    const kept = field === undefined ? null : keptOf(field);
    if (kept !== null) return { userId: r.userId, text: formatCentsInput(kept) };
    if (r.kind === 'value' && r.cents > 0) return { userId: r.userId, text: formatCentsInput(r.cents) };
    // A typed percentage that rounds to $0.00 carries no money; a field that doesn't read keeps its text.
    const raw = field === undefined ? '' : field.text;
    return { userId: r.userId, text: field !== undefined && readPercent(field).kind === 'invalid' ? raw : '' };
  });
}

/** Save needs a draft that adds up and differs from what's stored (S9). */
export function canSavePayers(status: PayersFormStatus, state: PayersState): boolean {
  return status.change !== null && !payersChangeIsNoop(state, status.change);
}

/**
 * Each row's caption: the other unit's value, so people see both. Amounts show their share of the
 * bill ("70.91% of the bill", by largest remainder across the rows, the same numbers switching to
 * percent gives); percentages show their cents once the percentages add up to 100%.
 */
export function rowCaptions(unit: PaidUnit, status: PayersFormStatus, totalCents: number): (string | null)[] {
  if (unit === 'percent') {
    const addsUp = status.assignedHundredths === MAX_PERCENT_HUNDREDTHS;
    return status.rows.map((r) => (r.kind === 'value' && addsUp ? formatCents(r.cents) : null));
  }
  if (totalCents === 0) return status.rows.map(() => null);
  const pct = centsToPercents(
    status.rows.map((r) => (r.kind === 'value' ? Math.min(r.cents, totalCents) : 0)),
    Math.max(totalCents, status.assignedCents),
  );
  return status.rows.map((r, i) => (r.kind === 'value' ? `${formatPercent(pct[i] ?? 0)} of the bill` : null));
}

/** The field errors re-exported so screen tests can name them without reaching into lib/payers. */
export const AMOUNT_FIELD_ERRORS = [FIELD_ERROR_FORMAT, FIELD_ERROR_TOO_LARGE] as const;
