// The simple-expense form model for groups: title, amount, who paid, split Equally among chosen
// members or by Exact amounts. Spec docs/specs/2026-11-26-groups-mvp.md, C-G4, C-G5, C-G6 (T8).
//
// These rules also run in the database (T3: `add_expense` / `edit_expense` / `private.allocate`).
// Both sides test the same boundary tables (A1–A10, X1–X8, the C-G6 field cases). Change a rule
// here only together with the SQL and both tests.
//
// All money is integer cents. Nothing here coerces a bad or missing value to $0: an invalid field
// never reads "adds up" (lessons 2026-11-21).

import { formatCents } from '@/lib/money';
import { allocate } from '@/lib/split';

export type SplitMethod = 'equal' | 'exact';

/** C-G6: an expense amount is an integer from 1 to 99,999,999 cents (same bounds as rule C2). */
export const EXPENSE_MIN_CENTS = 1;
export const EXPENSE_MAX_CENTS = 99_999_999;
/** C-G6: a title is 1..100 code points after `normalizeTitle`. */
export const EXPENSE_TITLE_MAX = 100;
/** C-G4: an equal split is among 1..50 distinct members. */
export const EXPENSE_MAX_EQUAL_USERS = 50;

export type ExpenseShare = { userId: string; cents: number };

/** One Exact-amounts field. `cents: null` = left blank (that person is left out). */
export type ExactEntry = { userId: string; cents: number | null };

/** What the expense screen holds. `amountCents: null` = blank or not parseable (the screen's parse). */
export type ExpenseDraft = {
  title: string;
  amountCents: number | null;
  payerId: string | null;
  method: SplitMethod;
  /** Equally: the chosen people (any order). Ignored for Exact. */
  equalUserIds: readonly string[];
  /** Exact amounts: one field per person. Ignored for Equally. */
  exactEntries: readonly ExactEntry[];
  /** The group's current members (from the snapshot). */
  memberIds: readonly string[];
};

export type ShareProblem = 'zero' | 'not_integer' | 'out_of_range' | 'duplicate';

export type ExactCheck =
  | { status: 'adds_up' }
  /** Σ entered − amount; positive = entered too much. Never 0. */
  | { status: 'off_by'; cents: number }
  | { status: 'invalid'; field: 'amount' }
  | { status: 'invalid'; field: 'share'; userId: string; reason: ShareProblem };

export type ExpenseError =
  | { field: 'title'; code: 'empty' | 'too_long' }
  | { field: 'amount'; code: 'missing' | 'out_of_range' }
  | { field: 'payer'; code: 'missing' | 'not_member' }
  | { field: 'split'; code: 'no_people' | 'too_many_people' | 'duplicate' | 'not_member' }
  | { field: 'split'; code: 'off_by'; cents: number }
  | { field: 'share'; userId: string; code: ShareProblem | 'not_member' };

/** The arguments `add_expense` / `edit_expense` take besides the ids and version (T3). */
export type ExpensePayload = {
  /** `normalizeTitle` of what was typed. */
  p_title: string;
  p_payer_id: string;
  p_amount_cents: number;
  p_method: SplitMethod;
  /** Equal: `{ uid: 1 }` per chosen user. Exact: `{ uid: cents }`, every value 1..99,999,999. */
  p_shares: Record<string, number>;
};

export type ExpenseValidation = { ok: true; payload: ExpensePayload } | { ok: false; errors: ExpenseError[] };

function isExpenseCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= EXPENSE_MIN_CENTS && v <= EXPENSE_MAX_CENTS;
}

/**
 * Trims only space, tab, newline, CR, VT and FF from both ends: the same six characters the DB
 * trims (POSIX `[[:space:]]`, Amendment A1.12 / GR-T8-6). Unlike JS `trim()`, Unicode spaces such
 * as U+00A0 and U+3000 are kept, so the lib and the DB count and store the same title. Used for
 * expense titles (C-G6) and group names (C-G8).
 */
export function normalizeTitle(s: string): string {
  return s.replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, '');
}

/** Code points, as SQL `char_length` counts them. */
function codePoints(s: string): number {
  return Array.from(s).length;
}

/**
 * C-G4 order: code-unit order of the lowercase id, the same order as SQL
 * `order by user_id::text collate "C"` (uuid::text is lowercase). Returns a new array.
 */
export function sortUserIds(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function hasDuplicates(ids: readonly string[]): boolean {
  return new Set(ids.map((id) => id.toLowerCase())).size !== ids.length;
}

/**
 * C-G4: `amountCents` split equally among `userIds`, in user-id order, leftover cents to the lowest
 * ids (`allocate` with weights 1). Every user gets a row, $0 included. Throws RangeError for a
 * non-integer or negative amount, no users, more than 50, or a repeated user (A10).
 */
export function equalPreview(amountCents: number, userIds: readonly string[]): ExpenseShare[] {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError('equalPreview: amount must be an integer ≥ 0');
  }
  if (userIds.length === 0) throw new RangeError('equalPreview: choose at least one person');
  if (userIds.length > EXPENSE_MAX_EQUAL_USERS) throw new RangeError('equalPreview: at most 50 people');
  if (hasDuplicates(userIds)) throw new RangeError('equalPreview: each person once');
  const sorted = sortUserIds(userIds);
  const cents = allocate(amountCents, sorted.map(() => 1));
  return sorted.map((userId, i) => ({ userId, cents: cents[i] ?? 0 }));
}

function shareProblem(cents: unknown): ShareProblem | null {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return 'not_integer';
  if (cents === 0) return 'zero';
  if (cents < EXPENSE_MIN_CENTS || cents > EXPENSE_MAX_CENTS) return 'out_of_range';
  return null;
}

/**
 * C-G5: do the Exact amounts add up to the amount, to the cent (no tolerance)? Blank entries are
 * left out. An invalid amount, a $0 / fractional / non-number / out-of-range entry, or a person
 * entered twice is `invalid`, never `adds_up` and never counted as $0. Nobody filled in reads as
 * off by the whole amount.
 */
export function exactCheck(amountCents: number | null, entries: readonly ExactEntry[]): ExactCheck {
  if (!isExpenseCents(amountCents)) return { status: 'invalid', field: 'amount' };
  const seen = new Set<string>();
  let sum = 0;
  for (const e of entries) {
    // A person listed twice (even once blank) is a broken form state, not something to add up.
    const key = e.userId.toLowerCase();
    if (seen.has(key)) return { status: 'invalid', field: 'share', userId: e.userId, reason: 'duplicate' };
    seen.add(key);
    if (e.cents === null) continue;
    const problem = shareProblem(e.cents);
    if (problem) return { status: 'invalid', field: 'share', userId: e.userId, reason: problem };
    sum += e.cents; // ≤ entries × 99,999,999: safe for any real group size
  }
  if (!Number.isSafeInteger(sum)) throw new RangeError('exactCheck: sum out of the safe-integer range');
  return sum === amountCents ? { status: 'adds_up' } : { status: 'off_by', cents: sum - amountCents };
}

function validateSplit(d: ExpenseDraft, members: Set<string>): { errors: ExpenseError[]; shares: Record<string, number> } {
  const shares: Record<string, number> = {};
  if (d.method === 'equal') {
    const ids = d.equalUserIds;
    if (ids.length === 0) return { errors: [{ field: 'split', code: 'no_people' }], shares };
    if (hasDuplicates(ids)) return { errors: [{ field: 'split', code: 'duplicate' }], shares };
    if (ids.some((id) => !members.has(id.toLowerCase()))) return { errors: [{ field: 'split', code: 'not_member' }], shares };
    if (ids.length > EXPENSE_MAX_EQUAL_USERS) return { errors: [{ field: 'split', code: 'too_many_people' }], shares };
    for (const id of sortUserIds(ids)) shares[id] = 1;
    return { errors: [], shares };
  }
  const stranger = d.exactEntries.find((e) => e.cents !== null && !members.has(e.userId.toLowerCase()));
  if (stranger) return { errors: [{ field: 'share', userId: stranger.userId, code: 'not_member' }], shares };
  const check = exactCheck(d.amountCents, d.exactEntries);
  if (check.status === 'invalid') {
    // An invalid amount is reported on the amount field; the split waits for it.
    if (check.field === 'amount') return { errors: [], shares };
    return { errors: [{ field: 'share', userId: check.userId, code: check.reason }], shares };
  }
  const filled = d.exactEntries.filter((e): e is { userId: string; cents: number } => e.cents !== null);
  if (filled.length === 0) return { errors: [{ field: 'split', code: 'no_people' }], shares };
  if (check.status === 'off_by') return { errors: [{ field: 'split', code: 'off_by', cents: check.cents }], shares };
  const byId = new Map(filled.map((e) => [e.userId, e.cents]));
  for (const id of sortUserIds([...byId.keys()])) shares[id] = byId.get(id) ?? 0;
  return { errors: [], shares };
}

/**
 * C-G5 + C-G6. Returns every field error at once (title, amount, payer, then the split), or the
 * exact payload T3 accepts. An off_by split is reported only when the amount itself is valid.
 */
export function validateExpense(d: ExpenseDraft): ExpenseValidation {
  const errors: ExpenseError[] = [];
  const title = normalizeTitle(d.title);
  const len = codePoints(title);
  if (len === 0) errors.push({ field: 'title', code: 'empty' });
  else if (len > EXPENSE_TITLE_MAX) errors.push({ field: 'title', code: 'too_long' });

  if (d.amountCents === null) errors.push({ field: 'amount', code: 'missing' });
  else if (!isExpenseCents(d.amountCents)) errors.push({ field: 'amount', code: 'out_of_range' });

  const members = new Set(d.memberIds.map((id) => id.toLowerCase()));
  if (d.payerId === null) errors.push({ field: 'payer', code: 'missing' });
  else if (!members.has(d.payerId.toLowerCase())) errors.push({ field: 'payer', code: 'not_member' });

  const split = validateSplit(d, members);
  errors.push(...split.errors);

  if (errors.length > 0 || d.payerId === null || !isExpenseCents(d.amountCents)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    payload: { p_title: title, p_payer_id: d.payerId, p_amount_cents: d.amountCents, p_method: d.method, p_shares: split.shares },
  };
}

/** The payload for `add_expense` / `edit_expense`, or null when the draft isn't valid. */
export function expensePayload(d: ExpenseDraft): ExpensePayload | null {
  const v = validateExpense(d);
  return v.ok ? v.payload : null;
}

/** The `expense_shares` rows the DB stores for a payload, in user-id order (for previews and checks). */
export function sharesFor(p: ExpensePayload): ExpenseShare[] {
  const ids = Object.keys(p.p_shares);
  if (p.p_method === 'equal') return equalPreview(p.p_amount_cents, ids);
  return sortUserIds(ids).map((userId) => ({ userId, cents: p.p_shares[userId] ?? 0 }));
}

/** A stored expense, for editing. */
export type StoredExpense = {
  title: string;
  payerId: string;
  amountCents: number;
  splitMethod: SplitMethod;
  shares: readonly ExpenseShare[];
};

/**
 * The form state for editing a stored expense. Equally: everyone with a share row is chosen ($0
 * rows included, which is why the DB stores them). Exact: one field per member, blank for members
 * without a row.
 */
export function draftFromExpense(e: StoredExpense, memberIds: readonly string[]): ExpenseDraft {
  const byId = new Map(e.shares.map((s) => [s.userId, s.cents]));
  return {
    title: e.title,
    amountCents: e.amountCents,
    payerId: e.payerId,
    method: e.splitMethod,
    equalUserIds: e.splitMethod === 'equal' ? sortUserIds(e.shares.map((s) => s.userId)) : [],
    exactEntries: e.splitMethod === 'exact' ? memberIds.map((userId) => ({ userId, cents: byId.get(userId) ?? null })) : [],
    memberIds,
  };
}

// ---------- copy ----------

const AMOUNT_RANGE = `Enter an amount from ${formatCents(EXPENSE_MIN_CENTS)} to ${formatCents(EXPENSE_MAX_CENTS)}.`;
const PEOPLE_FROM_GROUP = 'Choose people from the group.';

/** The line under the Exact amounts fields. */
export function exactCheckText(c: ExactCheck): string {
  switch (c.status) {
    case 'adds_up':
      return 'Adds up';
    case 'off_by':
      return `Off by ${formatCents(Math.abs(c.cents))}`;
    case 'invalid':
      return c.field === 'amount' ? 'Fix the amount first.' : 'Fix the highlighted amount.';
  }
}

/** The message shown next to the field an error belongs to. */
export function expenseErrorText(e: ExpenseError): string {
  switch (e.field) {
    case 'title':
      return e.code === 'empty' ? 'Add what it was for.' : `Keep it to ${EXPENSE_TITLE_MAX} characters.`;
    case 'amount':
      return e.code === 'missing' ? 'Enter the amount.' : AMOUNT_RANGE;
    case 'payer':
      return e.code === 'missing' ? 'Choose who paid.' : 'Choose who paid from the group.';
    case 'split':
      switch (e.code) {
        case 'no_people':
          return 'Choose at least one person.';
        case 'too_many_people':
          return `Choose up to ${EXPENSE_MAX_EQUAL_USERS} people.`;
        case 'duplicate':
          return 'Choose each person once.';
        case 'not_member':
          return PEOPLE_FROM_GROUP;
        case 'off_by':
          return `Off by ${formatCents(Math.abs(e.cents))}`;
      }
    case 'share':
      switch (e.code) {
        case 'zero':
          return 'Leave it blank if they don’t owe anything.';
        case 'not_integer':
          return 'Enter dollars and cents, like 12.50.';
        case 'out_of_range':
          return AMOUNT_RANGE;
        case 'duplicate':
          return 'Enter each person once.';
        case 'not_member':
          return PEOPLE_FROM_GROUP;
      }
  }
}
