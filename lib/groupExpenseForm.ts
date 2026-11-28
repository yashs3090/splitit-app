// The expense screen's form: what the person typed, turned into lib/groupExpense.ts's draft, plus
// the screen's copy. Spec docs/specs/2026-11-26-groups-mvp.md T15 (criteria 70–73, 114), as
// amended by A1 (GR-T8-1: a typed $0 is refused, a blank person is left out; GR-T8-2: typed amounts
// stop at $99,999.99) and A3.
//
// The money rules (equal allocation, the exact check, field limits, the payload) are
// lib/groupExpense.ts's and are only called here. Typed text is read with lib/money.ts's
// parseMoneyInput. Text that isn't money is never treated as blank or as $0: it reaches the exact
// check as a non-integer, so it reads "Fix the highlighted amount." (lessons 2026-11-21).
// The screen does no arithmetic and writes no strings of its own.

import {
  equalPreview,
  exactCheck,
  exactCheckText,
  expenseErrorText,
  expensePayload,
  draftFromExpense,
  EXPENSE_MAX_EQUAL_USERS,
  EXPENSE_MIN_CENTS,
  EXPENSE_MAX_CENTS,
  normalizeTitle,
  validateExpense,
  type ExpenseDraft,
  type ExpensePayload,
  type SplitMethod,
  type StoredExpense,
} from './groupExpense';
import { formatCents, formatCentsInput, isTooLarge, MAX_INPUT_CENTS, parseMoneyInput } from './money';

/** What the screen holds: the text as typed. */
export type ExpenseForm = {
  title: string;
  amountText: string;
  payerId: string | null;
  method: SplitMethod;
  /** Equally: who's in. Kept while Exact is shown, so switching back loses nothing. */
  equalChosen: readonly string[];
  /** Exact amounts: the text per member id; a missing key is a blank field. */
  exactText: Readonly<Record<string, string>>;
};

export const EXPENSE_SCREEN_COPY = {
  newTitle: 'New expense',
  editTitle: 'Edit expense',
  viewTitle: 'Expense',
  back: 'Group',
  backA11y: 'Back to group',
  backHint: 'Returns to the group',
  loadError: "Couldn't load the group.",
  notMember: "You're not in this group. Ask someone in it for the group's link.",
  goHome: 'Go home',
  tryAgain: 'Try again',
  notFound: "This expense isn't in the group anymore.",
  backToGroup: 'Go to the group',
  titleLabel: 'What for',
  titlePlaceholder: 'Airbnb, gas, tickets',
  amountLabel: 'Amount',
  amountPlaceholder: '0.00',
  paidBy: 'Paid by',
  change: 'Change',
  changeA11y: 'Change who paid',
  choosePayer: 'Choose who paid.',
  changeHint: 'Shows everyone in the group to choose who paid',
  split: 'Split',
  equally: 'Equally',
  exact: 'Exact amounts',
  equalHint: 'Adds or leaves out this person',
  exactHint: 'Leave it blank if they don’t owe anything.',
  save: 'Save',
  saving: 'Saving…',
  saveHintAdd: 'Adds the expense to the group',
  saveHintEdit: 'Saves your changes',
  saveFailed: "Couldn't save the expense. Check your connection and try again.",
  deleteFailed: "Couldn't delete the expense. Check your connection and try again.",
  refreshFailed: "Couldn't refresh. Try again.",
  showTheirs: 'Show their changes',
  showTheirsHint: 'Replaces what you typed with the saved expense',
  delete: 'Delete expense',
  deleteHint: 'Asks first',
  deleteConfirmButton: 'Delete',
  deleteConfirmA11y: 'Delete expense',
  deleteConfirmHint: 'Removes it from everyone’s balances',
  keep: 'Keep it',
  discardAdd: 'Discard this expense?',
  discardEdit: 'Discard your changes?',
  discard: 'Discard',
  discardHint: 'Throws away what you typed and goes back',
  keepEditing: 'Keep editing',
  readOnlyNote: 'Only the person who paid or who added it can change this expense.',
} as const;

/** "Delete Airbnb? It comes out of everyone’s balances." */
export function deleteConfirmText(title: string): string {
  return `Delete ${title}? It comes out of everyone’s balances.`;
}

/** The read-only view's line under the amount: "Paid by Ana · Split equally". */
export function readOnlySummary(payerName: string, m: SplitMethod): string {
  return `Paid by ${payerName} · ${m === 'equal' ? 'Split equally' : 'Split by exact amounts'}`;
}

const NOT_MONEY = 'Enter dollars and cents, like 12.50.';
const TOO_LARGE = `Enter an amount up to ${formatCents(MAX_INPUT_CENTS)}.`;
const NOT_ABOVE_ZERO = `Enter an amount above ${formatCents(0)}.`;

export function emptyForm(memberIds: readonly string[], viewerId: string): ExpenseForm {
  return {
    title: '',
    amountText: '',
    payerId: memberIds.includes(viewerId) ? viewerId : null,
    method: 'equal',
    equalChosen: [...memberIds],
    exactText: {},
  };
}

/** A stored expense as the text the form shows (through draftFromExpense). */
export function formFromExpense(e: StoredExpense, memberIds: readonly string[]): ExpenseForm {
  const d = draftFromExpense(e, memberIds);
  const exactText: Record<string, string> = {};
  for (const entry of d.exactEntries) exactText[entry.userId] = entry.cents === null ? '' : formatCentsInput(entry.cents);
  return {
    title: d.title,
    amountText: formatCentsInput(e.amountCents),
    payerId: d.payerId,
    method: d.method,
    // Switching an exact expense to Equally starts with the people it already has.
    equalChosen: d.method === 'equal' ? d.equalUserIds : memberIds.filter((id) => e.shares.some((s) => s.userId === id)),
    exactText,
  };
}

/** Blank → null; money → cents; anything else (malformed, too large) → NaN, which the exact check refuses. */
function shareCents(text: string | undefined): number | null {
  if (text === undefined || text.trim() === '') return null;
  return parseMoneyInput(text) ?? Number.NaN;
}

/** The lib draft for this form, among the group's current members only. */
export function draftOf(form: ExpenseForm, memberIds: readonly string[]): ExpenseDraft {
  const members = new Set(memberIds);
  return {
    title: form.title,
    amountCents: parseMoneyInput(form.amountText),
    payerId: form.payerId !== null && members.has(form.payerId) ? form.payerId : null,
    method: form.method,
    equalUserIds: form.equalChosen.filter((id) => members.has(id)),
    exactEntries: memberIds.map((userId) => ({ userId, cents: shareCents(form.exactText[userId]) })),
    memberIds,
  };
}

export type EqualRow = { userId: string; chosen: boolean; cents: number | null };

/** Equally: one row per member, in member order; chosen people carry their preview ($0 included). */
export function equalRows(form: ExpenseForm, memberIds: readonly string[]): EqualRow[] {
  const d = draftOf(form, memberIds);
  const amount = d.amountCents;
  const canPreview =
    amount !== null && amount >= EXPENSE_MIN_CENTS && amount <= EXPENSE_MAX_CENTS && d.equalUserIds.length > 0 && d.equalUserIds.length <= EXPENSE_MAX_EQUAL_USERS;
  const preview = new Map(canPreview ? equalPreview(amount, d.equalUserIds).map((s) => [s.userId, s.cents]) : []);
  const chosen = new Set(d.equalUserIds);
  return memberIds.map((userId) => ({ userId, chosen: chosen.has(userId), cents: preview.get(userId) ?? null }));
}

export type LineTone = 'success' | 'error' | 'muted';

/** The line under the Exact amounts fields ("Adds up" / "Off by $0.01"), with how it reads. */
export function exactLine(form: ExpenseForm, memberIds: readonly string[]): { text: string; tone: LineTone } {
  const d = draftOf(form, memberIds);
  const c = exactCheck(d.amountCents, d.exactEntries);
  const tone: LineTone = c.status === 'adds_up' ? 'success' : c.status === 'invalid' && c.field === 'amount' ? 'muted' : 'error';
  return { text: exactCheckText(c), tone };
}

/** The message under the Amount field, or null. Blank is left to the footer. */
export function amountFieldError(text: string): string | null {
  if (text.trim() === '') return null;
  if (isTooLarge(text)) return TOO_LARGE;
  const cents = parseMoneyInput(text);
  if (cents === null) return NOT_MONEY;
  return cents < EXPENSE_MIN_CENTS ? NOT_ABOVE_ZERO : null;
}

/** The message under one Exact amounts field, or null (blank is fine: that person is left out). */
export function shareFieldError(text: string): string | null {
  if (text.trim() === '') return null;
  if (isTooLarge(text)) return TOO_LARGE;
  const cents = parseMoneyInput(text);
  if (cents === null) return NOT_MONEY;
  return cents === 0 ? expenseErrorText({ field: 'share', userId: '', code: 'zero' }) : null;
}

/** Why Save is disabled (the first thing to fix, in field order), or null when it can save. */
export function saveBlockText(form: ExpenseForm, memberIds: readonly string[]): string | null {
  const v = validateExpense(draftOf(form, memberIds));
  if (v.ok) return null;
  const amountError = amountFieldError(form.amountText);
  for (const e of v.errors) {
    if (e.field === 'amount' && amountError !== null) return amountError;
    // The field itself says what's wrong; the footer points at it.
    if (e.field === 'share') return exactCheckText({ status: 'invalid', field: 'share', userId: e.userId, reason: 'zero' });
    return expenseErrorText(e);
  }
  // validateExpense waits for a valid amount before checking the split; nothing else to report.
  return amountError;
}

/**
 * The small print under a disabled Save: saveBlockText, unless the same words already show next to
 * the field they're about (the Amount error, the "Off by" line), so nothing is said twice.
 */
export function footerNote(form: ExpenseForm, memberIds: readonly string[]): string | null {
  const text = saveBlockText(form, memberIds);
  if (text === null) return null;
  if (text === amountFieldError(form.amountText)) return null;
  if (form.method === 'exact' && text === exactLine(form, memberIds).text) return null;
  return text;
}

function sameShares(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

function samePayload(a: ExpensePayload, b: ExpensePayload): boolean {
  return (
    a.p_title === b.p_title &&
    a.p_payer_id === b.p_payer_id &&
    a.p_amount_cents === b.p_amount_cents &&
    a.p_method === b.p_method &&
    sameShares(a.p_shares, b.p_shares)
  );
}

/** True when saving `payload` would store what's already stored: the screen sends nothing. */
export function isNoopSave(payload: ExpensePayload, stored: StoredExpense, memberIds: readonly string[]): boolean {
  const current = expensePayload(draftFromExpense(stored, memberIds));
  return current !== null && samePayload(payload, current);
}

function filledText(t: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (v !== '') out[k] = v;
  return out;
}

/** Whether two forms hold the same input (for "Discard your changes?"). Exact characters count. */
export function formsEqual(a: ExpenseForm, b: ExpenseForm): boolean {
  const ca = new Set(a.equalChosen);
  const fa = filledText(a.exactText);
  const fb = filledText(b.exactText);
  return (
    a.title === b.title &&
    a.amountText === b.amountText &&
    a.payerId === b.payerId &&
    a.method === b.method &&
    ca.size === new Set(b.equalChosen).size &&
    b.equalChosen.every((id) => ca.has(id)) &&
    Object.keys(fa).length === Object.keys(fb).length &&
    Object.keys(fa).every((k) => fb[k] === fa[k])
  );
}

/** C-G9 / GR-M2: only the expense's creator or its payer may edit or delete it. */
export function canEditExpense(e: { createdBy: string; payerId: string }, viewerId: string): boolean {
  return viewerId !== '' && (e.createdBy === viewerId || e.payerId === viewerId);
}

/** The key for addExpense's client id: the same content reuses the id (a retry is a no-op). */
export function intentKey(p: ExpensePayload): string {
  const shares = Object.keys(p.p_shares)
    .sort()
    .map((k) => `${k}=${p.p_shares[k] ?? ''}`)
    .join(',');
  return [normalizeTitle(p.p_title), p.p_payer_id, p.p_amount_cents, p.p_method, shares].join('|');
}

/** The screen-reader label of one Exact amounts field: "Your amount", "Ben's amount". */
export function exactFieldLabel(name: string): string {
  return name === 'You' ? 'Your amount' : `${name}'s amount`;
}

/** The label of one Equally row; the checkbox state says whether they're in. "Ben, $60.00". */
export function equalRowA11yLabel(name: string, cents: number | null): string {
  return cents === null ? name : `${name}, ${formatCents(cents)}`;
}
