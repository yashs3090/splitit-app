// Who paid: the rules and copy for one payer or several (spec docs/specs/2026-11-26-who-paid.md,
// Task 1; Amendment A1 wins over the body).
// - Contract W: payersState, validateSplit (table W, the same cases set_payers' pgTAP uses).
// - Contract A: the "Who paid?" sheet's amounts (splitDraftStatus, toPayersPayload, addTheRest).
// - Contract M: paymentsMovedBy (the payments a payer change moves; nothing is ever cleared), and
//   pairNetsTo, its input from the ledger (contract P), so screens never import lib/transfers (A-28b).
// - paidByLine: the "Paid by you · Change" line (A1.5). The old payerLine in settleView is separate.
// Pure and integer cents only. Takes plain arrays: no import from bills/settle (other sessions' files).
import { formatCents, formatCentsInput } from './money';
// Contract P's pair net, used only inside pairNetsTo. transfers.ts imports settle.ts, which imports
// this file: the cycle is safe because each side calls the other only inside functions, never at load.
import { pairState, type Payment } from './transfers';

/** One person who paid part (or all) of the bill. Same shape as transfers.ts's PlanPayer. */
export type Payer = { userId: string; paidCents: number };
/** 'one' = no bill_payers rows; 'split' = 2+ rows. Same as transfers.ts's PlanMode. */
export type PayersMode = 'one' | 'split';

/** A split needs two people at 1¢ or more (WP-24). */
export const SPLIT_MIN_TOTAL_CENTS = 2;
/** bill_payers.paid_cents range: 1..99,999,999 (D1). */
export const MAX_PAID_CENTS = 99_999_999;
/** set_payers refuses more entries than this (D1 step 2). */
export const MAX_PAYERS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPaidCents(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PAID_CENTS && !Object.is(n, -0);
}

function isTotalCents(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_PAID_CENTS;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lead-first order (D1): largest amount, a tie to the lower id. Ids compare with JS `<` on the
 * lowercase uuids, which matches Postgres uuid byte order. This is display/event order only: lib
 * never picks the lead (WP-21); leadId always comes from the stored payer_id.
 */
function leadOrder(a: Payer, b: Payer): number {
  return b.paidCents - a.paidCents || codeUnitCompare(a.userId, b.userId);
}

// ---------------------------------------------------------------------------------------------
// Contract W
// ---------------------------------------------------------------------------------------------

export type PayersState = {
  mode: PayersMode;
  /** bills.payer_id as stored: the one payer, or the split's lead (computed by the DB). */
  leadId: string;
  /** One person: [(payerId, current total)]. Split: the rows in lead-first order. */
  payers: Payer[];
  /** Split only: Σ paid ≠ the current total. Never true in one-person mode (WP-10). */
  stale: boolean;
  /** total − Σ paid: > 0 left to assign, < 0 more than the total. 0 in one-person mode. */
  gapCents: number;
  /** Σ paid (= the total in one-person mode). */
  assignedCents: number;
};

/**
 * The bill's who-paid state from bills.payer_id, its bill_payers rows and the current total.
 * Throws RangeError on stored rows the DB never leaves (exactly one row, a duplicate, an amount
 * out of range, a payer_id that isn't one of the rows): the data layer treats that as malformed.
 */
export function payersState(input: { payerId: string; rows: readonly Payer[]; totalCents: number }): PayersState {
  const { payerId, rows, totalCents } = input;
  if (!isTotalCents(totalCents)) throw new RangeError('payersState: bad total');
  if (rows.length === 0) {
    return {
      mode: 'one',
      leadId: payerId,
      payers: [{ userId: payerId, paidCents: totalCents }],
      stale: false,
      gapCents: 0,
      assignedCents: totalCents,
    };
  }
  if (rows.length < 2) throw new RangeError('payersState: a split has at least 2 rows');
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isPaidCents(r.paidCents)) throw new RangeError('payersState: bad paid_cents');
    if (seen.has(r.userId)) throw new RangeError('payersState: duplicate payer');
    seen.add(r.userId);
  }
  if (!seen.has(payerId)) throw new RangeError('payersState: payer_id is not one of the split rows');
  const payers = rows.map((r) => ({ userId: r.userId, paidCents: r.paidCents })).sort(leadOrder);
  const assignedCents = payers.reduce((sum, p) => sum + p.paidCents, 0);
  const gapCents = totalCents - assignedCents;
  return { mode: 'split', leadId: payerId, payers, stale: gapCents !== 0, gapCents, assignedCents };
}

/** Why validateSplit refused, in set_payers' check order. */
export type SplitInvalidReason = 'count' | 'duplicate' | 'id' | 'amount' | 'participant' | 'total';
export type SplitValidation =
  | { ok: true; payers: Payer[] }
  | { ok: false; reason: Exclude<SplitInvalidReason, 'total'> }
  | { ok: false; reason: 'total'; gapCents: number };

/** The set_payers error each lib reason corresponds to (table W). */
export function splitDbCode(reason: SplitInvalidReason): 'invalid_payers' | 'invalid_amount' | 'not_participant' | 'payers_total' {
  switch (reason) {
    case 'count':
    case 'duplicate':
    case 'id':
      return 'invalid_payers';
    case 'amount':
      return 'invalid_amount';
    case 'participant':
      return 'not_participant';
    case 'total':
      return 'payers_total';
  }
}

/**
 * Table W, checked in set_payers' order: count (2..50) / id / duplicate (step 2), amount (step 3),
 * participant (step 4), Σ = total exactly with tolerance 0 (step 5). `paidCents` is `unknown` so a
 * string or a fraction (W11) is refused here, before any rpc.
 */
export function validateSplit(
  entries: ReadonlyArray<{ userId: string; paidCents: unknown }>,
  ctx: { totalCents: number; participantIds: readonly string[] },
): SplitValidation {
  if (entries.length < 2 || entries.length > MAX_PAYERS) return { ok: false, reason: 'count' };
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e.userId !== 'string' || !UUID_RE.test(e.userId)) return { ok: false, reason: 'id' };
    if (seen.has(e.userId)) return { ok: false, reason: 'duplicate' };
    seen.add(e.userId);
  }
  const payers: Payer[] = [];
  for (const e of entries) {
    if (!isPaidCents(e.paidCents)) return { ok: false, reason: 'amount' };
    payers.push({ userId: e.userId, paidCents: e.paidCents });
  }
  const participants = new Set(ctx.participantIds);
  if (payers.some((p) => !participants.has(p.userId))) return { ok: false, reason: 'participant' };
  const sum = payers.reduce((s, p) => s + p.paidCents, 0); // ≤ 50 × 99,999,999: a safe integer
  if (sum !== ctx.totalCents) return { ok: false, reason: 'total', gapCents: ctx.totalCents - sum };
  return { ok: true, payers };
}

export type PayersChange = { mode: 'one'; payerId: string } | { mode: 'split'; payers: readonly Payer[] };

/**
 * True when saving `next` would change nothing (set_payers step 6 / set_payer's no-op, M5): the
 * same one payer in one-person mode, or the same users with the same amounts in split mode. From a
 * split, one person is never a no-op, even the lead (A-11).
 */
export function payersChangeIsNoop(current: PayersState, next: PayersChange): boolean {
  if (next.mode === 'one') return current.mode === 'one' && current.leadId === next.payerId;
  if (current.mode !== 'split' || current.payers.length !== next.payers.length) return false;
  const stored = new Map(current.payers.map((p) => [p.userId, p.paidCents]));
  return next.payers.every((p) => stored.get(p.userId) === p.paidCents);
}

// ---------------------------------------------------------------------------------------------
// Contract A: the sheet's amounts
// ---------------------------------------------------------------------------------------------

/** One row of the Several people form, in participant order. */
export type SplitField = { userId: string; text: string };

export const FIELD_ERROR_FORMAT = 'Enter an amount like 12.50';
export const FIELD_ERROR_TOO_LARGE = 'That amount is too large';

export type SplitFieldState =
  | { userId: string; kind: 'blank' }
  | { userId: string; kind: 'amount'; cents: number }
  | { userId: string; kind: 'invalid'; error: typeof FIELD_ERROR_FORMAT | typeof FIELD_ERROR_TOO_LARGE };

// The bill form's grammar (lib/money.ts INPUT_RE): optional `$`, plain or comma-grouped dollars,
// an optional `.` with 0–2 decimals. Restated here because parseMoneyInput caps at $99,999.99
// (MAX_INPUT_CENTS) and a paid amount may go to MAX_PAID_CENTS ($999,999.99). See the report.
const PAID_INPUT_RE = /^\$?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/;
const MAX_PAID_DOLLAR_DIGITS = String(MAX_PAID_CENTS).length - 2;

/** One amount field, read with the sheet's grammar (also used by lib/payersForm.ts). */
export function readField(field: SplitField): SplitFieldState {
  const { userId } = field;
  const s = field.text.trim();
  if (s === '') return { userId, kind: 'blank' };
  const m = PAID_INPUT_RE.exec(s);
  const dollars = (m?.[1] ?? '').replace(/,/g, '');
  const fraction = m?.[2] ?? '';
  if (!m || (dollars === '' && fraction === '')) return { userId, kind: 'invalid', error: FIELD_ERROR_FORMAT };
  if (dollars.replace(/^0+/, '').length > MAX_PAID_DOLLAR_DIGITS) return { userId, kind: 'invalid', error: FIELD_ERROR_TOO_LARGE };
  // Digit strings only, never a float × 100 (lib/money.ts).
  const cents = parseInt(`${dollars || '0'}${fraction.padEnd(2, '0')}`, 10);
  if (cents === 0) return { userId, kind: 'blank' }; // `0` means "didn't pay" (WP-12)
  if (cents > MAX_PAID_CENTS) return { userId, kind: 'invalid', error: FIELD_ERROR_TOO_LARGE };
  return { userId, kind: 'amount', cents };
}

export type SplitStatusKind = 'unavailable' | 'invalid' | 'too_many' | 'short' | 'over' | 'one_payer' | 'adds_up';
export type SplitStatusTone = 'muted' | 'warning' | 'success' | 'error';

export type SplitDraftStatus = {
  kind: SplitStatusKind;
  /** 'unavailable' only: fewer than 2 people on the bill, or a total under 2¢. */
  reason: 'people' | 'total' | null;
  /** The one status line (S7: never two). */
  text: string;
  tone: SplitStatusTone;
  canSave: boolean;
  /** The disabled Save button's hint (M4); null when Save is enabled. */
  saveHint: string | null;
  /** total − Σ valid amounts. Invalid fields never count (lesson 2026-11-21). */
  gapCents: number;
  assignedCents: number;
  /** People with an amount (blank and 0 don't count). */
  payingCount: number;
  /** 'one_payer' only: the person whose amount is the whole total (WP-50). */
  onePayerId: string | null;
  fields: SplitFieldState[];
  /** Changes only when the kind or the amount changes, so the announcer speaks once (M4). */
  announceKey: string;
};

/**
 * Contract A. Status, first match wins: unavailable (< 2 rows or total < 2¢) → invalid (any field)
 * → too_many (> 50 with an amount) → short (gap > 0) → over (gap < 0) → one_payer (gap 0, one
 * person) → adds_up (gap 0, 2+ people; the only state that can save).
 */
export function splitDraftStatus(fields: readonly SplitField[], totalCents: number): SplitDraftStatus {
  if (!isTotalCents(totalCents)) throw new RangeError('splitDraftStatus: bad total');
  const states = fields.map(readField);
  const amounts = states.flatMap((s) => (s.kind === 'amount' ? [s] : []));
  const assignedCents = amounts.reduce((sum, s) => sum + s.cents, 0);
  const gapCents = totalCents - assignedCents;
  const base = {
    reason: null,
    canSave: false,
    saveHint: `Amounts must add up to ${formatCents(totalCents)} first`,
    gapCents,
    assignedCents,
    payingCount: amounts.length,
    onePayerId: null,
    fields: states,
  };
  const make = (kind: SplitStatusKind, text: string, tone: SplitStatusTone, extra: Partial<SplitDraftStatus> = {}): SplitDraftStatus => ({
    ...base,
    kind,
    text,
    tone,
    announceKey: `${kind}:${kind === 'invalid' ? '' : gapCents}`,
    ...extra,
  });

  if (fields.length < 2) {
    return make('unavailable', 'This needs at least 2 people on the bill.', 'muted', { reason: 'people' });
  }
  if (totalCents < SPLIT_MIN_TOTAL_CENTS) {
    return make('unavailable', `This needs a bill total of at least ${formatCents(SPLIT_MIN_TOTAL_CENTS)}.`, 'muted', { reason: 'total' });
  }
  const invalid = states.filter((s) => s.kind === 'invalid').length;
  if (invalid > 0) {
    return make('invalid', invalid === 1 ? 'Fix the amount marked above' : 'Fix the amounts marked above', 'error');
  }
  if (amounts.length > MAX_PAYERS) {
    return make('too_many', `Up to ${MAX_PAYERS} people can share the paying.`, 'error');
  }
  if (gapCents > 0) return make('short', `${formatCents(gapCents)} left to assign`, 'muted');
  if (gapCents < 0) return make('over', `${formatCents(-gapCents)} more than the total`, 'warning');
  if (amounts.length < 2) {
    return make('one_payer', "That's one person paying the whole bill.", 'muted', { onePayerId: amounts[0]?.userId ?? null });
  }
  return make('adds_up', `Adds up to ${formatCents(totalCents)}`, 'success', { canSave: true, saveHint: null });
}

/** What set_payers stores: people with an amount only, in field (participant) order. Throws on an invalid field. */
export function toPayersPayload(fields: readonly SplitField[]): { user_id: string; paid_cents: number }[] {
  return fields.flatMap((field) => {
    const s = readField(field);
    if (s.kind === 'invalid') throw new RangeError('toPayersPayload: invalid field');
    return s.kind === 'amount' ? [{ user_id: s.userId, paid_cents: s.cents }] : [];
  });
}

/** The form's starting values (WP-14): the stored amounts exactly in split mode, all blank from one person. */
export function prefillSplitFields(state: PayersState, participantIds: readonly string[]): SplitField[] {
  const stored = new Map(state.mode === 'split' ? state.payers.map((p) => [p.userId, p.paidCents]) : []);
  return participantIds.map((userId) => {
    const cents = stored.get(userId);
    return { userId, text: cents === undefined ? '' : formatCentsInput(cents) };
  });
}

/**
 * S9: Save also needs a change from what's stored. Compared by amounts, so `60` and `60.00` are the
 * same. An invalid draft counts as changed (it can't save anyway, and it's not what's stored).
 */
export function splitDraftChanged(fields: readonly SplitField[], state: PayersState): boolean {
  if (fields.some((field) => readField(field).kind === 'invalid')) return true;
  const payers = toPayersPayload(fields).map((p) => ({ userId: p.user_id, paidCents: p.paid_cents }));
  return !payersChangeIsNoop(state, { mode: 'split', payers });
}

type NameOf = (userId: string | null) => string;

const A_FRIEND = 'a friend';

/** A name mid-sentence: "you" for the viewer, "a friend" for a blank or failing nameOf. */
function midName(userId: string, viewerId: string, nameOf: NameOf): string {
  if (userId === viewerId) return 'you';
  try {
    const n = nameOf(userId);
    return typeof n === 'string' && n.trim() !== '' ? n.trim() : A_FRIEND;
  } catch {
    return A_FRIEND;
  }
}

/** "Sam's" / "your" / "a friend's". */
function possessive(userId: string, viewerId: string, nameOf: NameOf): string {
  return userId === viewerId ? 'your' : `${midName(userId, viewerId, nameOf)}'s`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type AddTheRest = {
  userId: string;
  /** The target's new amount, and the text to put in its field. */
  cents: number;
  text: string;
  label: string;
  a11yLabel: string;
  a11yHint: string;
};

/**
 * M2's "Add the rest ($40.21) to Sam". Target: the last focused row; before any focus, the one
 * blank row when exactly one is blank and another has an amount. Shown only when the gap is > 0
 * and no field is invalid (an invalid field's value isn't known, so the gap isn't either).
 */
export function addTheRest(args: {
  fields: readonly SplitField[];
  totalCents: number;
  targetUserId: string | null;
  viewerId: string;
  nameOf: NameOf;
}): AddTheRest | null {
  const status = splitDraftStatus(args.fields, args.totalCents);
  if (status.kind !== 'short') return null;
  let target: SplitFieldState | undefined;
  if (args.targetUserId !== null) {
    target = status.fields.find((s) => s.userId === args.targetUserId);
  } else {
    const blanks = status.fields.filter((s) => s.kind === 'blank');
    target = blanks.length === 1 && status.payingCount > 0 ? blanks[0] : undefined;
  }
  if (target === undefined || target.kind === 'invalid') return null;
  const cents = (target.kind === 'amount' ? target.cents : 0) + status.gapCents;
  if (cents > MAX_PAID_CENTS) return null;
  const gap = formatCents(status.gapCents);
  const who = midName(target.userId, args.viewerId, args.nameOf);
  return {
    userId: target.userId,
    cents,
    text: formatCentsInput(cents),
    label: `Add the rest (${gap}) to ${who}`,
    a11yLabel: `Add the rest, ${gap}, to ${who}`,
    a11yHint: `Sets ${possessive(target.userId, args.viewerId, args.nameOf)} amount to ${formatCents(cents)}`,
  };
}

/** S7's link under "That's one person paying the whole bill.": "Sam paid it all" / "You paid it all". */
export function paidItAllLink(userId: string, viewerId: string, nameOf: NameOf): { label: string; a11yLabel: string; a11yHint: string } {
  const who = midName(userId, viewerId, nameOf);
  const label = `${capitalise(who)} paid it all`;
  return { label, a11yLabel: label, a11yHint: `Saves ${who} as the one person who paid` };
}

/** What the debounced announcer says for a status (M4). */
export function splitStatusSpoken(status: SplitDraftStatus, viewerId: string, nameOf: NameOf): string {
  if (status.kind === 'adds_up') return `${status.text}. You can save now.`;
  if (status.kind === 'invalid') {
    const bad = status.fields.find((s) => s.kind === 'invalid');
    if (bad?.kind === 'invalid') {
      const whose = capitalise(possessive(bad.userId, viewerId, nameOf));
      return bad.error === FIELD_ERROR_TOO_LARGE ? `${whose} amount is too large.` : `${whose} amount isn't valid. ${FIELD_ERROR_FORMAT}.`;
    }
  }
  return status.text;
}

// ---------------------------------------------------------------------------------------------
// Contract M: payments a payer change moves
// ---------------------------------------------------------------------------------------------

/** An ordered pair's net (contract P, from transfers.ts's pairState): from → to, in cents. */
export type PairNet = { fromId: string; toId: string; netCents: number };
export type MovedPayment = { fromId: string; toId: string; cents: number };

/**
 * Contract M: pairs with net > 0 whose `to` is an old payer and isn't a new one, ordered by
 * (from, to). Nothing is cleared: these payments still count, and the holder passes them on.
 */
export function paymentsMovedBy(pairs: readonly PairNet[], oldPayerIds: readonly string[], newPayerIds: readonly string[]): MovedPayment[] {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!Number.isSafeInteger(p.netCents)) throw new RangeError('paymentsMovedBy: non-integer cents');
    const key = `${p.fromId}\u0000${p.toId}`;
    if (seen.has(key)) throw new RangeError('paymentsMovedBy: duplicate pair');
    seen.add(key);
  }
  const before = new Set(oldPayerIds);
  const after = new Set(newPayerIds);
  return pairs
    .filter((p) => p.netCents > 0 && before.has(p.toId) && !after.has(p.toId))
    .map((p) => ({ fromId: p.fromId, toId: p.toId, cents: p.netCents }))
    .sort((a, b) => codeUnitCompare(a.fromId, b.fromId) || codeUnitCompare(a.toId, b.toId));
}

/**
 * Contract P's net on every ordered pair (from → to), for each `to` in `toIds` and each other id in
 * `fromIds`, in that order: the `pairs` paymentsMovedBy takes. Repeated ids are read once and nobody
 * is paired with themself. Throws RangeError on a bad ledger row (as pairState does), so a bad row
 * never reads as "no payments".
 */
export function pairNetsTo(payments: readonly Payment[], toIds: readonly string[], fromIds: readonly string[]): PairNet[] {
  const froms = [...new Set(fromIds)];
  return [...new Set(toIds)].flatMap((toId) =>
    froms.filter((fromId) => fromId !== toId).map((fromId) => ({ fromId, toId, netCents: pairState(payments, fromId, toId).net })),
  );
}

/** The not-received flags a change deletes: those whose `to` isn't in the new payer set (M7). */
export function flagsDroppedBy<T extends { fromId: string; toId: string }>(flags: readonly T[], newPayerIds: readonly string[]): T[] {
  const after = new Set(newPayerIds);
  return flags.filter((f) => !after.has(f.toId));
}

// ---------------------------------------------------------------------------------------------
// paidByLine (D6 as amended by A1.5)
// ---------------------------------------------------------------------------------------------

export type PaidByLine = {
  /** The visible text, without the "· Change" action. */
  text: string;
  action: 'change' | 'fix' | null;
  actionLabel: 'Change' | 'Fix' | null;
  tone: 'muted' | 'warning';
  /** 'warning' = the TriangleAlert icon (stale, host). */
  icon: 'warning' | null;
  /** Host: the whole line is one button with this label. Others: plain text. */
  a11yLabel: string;
  a11yHint: string | null;
};

const OPENS_WHO_PAID = 'Opens who paid';

/**
 * The quiet "Paid by …" line. Order: the viewer first, then amount descending, then join order.
 * "you" is lowercase mid-sentence (S13). 4+ payers: host `Paid by 4 people`, others
 * `Paid by Hana, Sam and 2 others` (C2). Stale: host warning + Fix; others wait for the host.
 */
export function paidByLine(input: {
  state: PayersState;
  viewerId: string;
  hostId: string;
  /** Participant ids in join order (the tie-break after amount). */
  joinOrder: readonly string[];
  nameOf: NameOf;
}): PaidByLine {
  const { state, viewerId, hostId, nameOf } = input;
  const isHost = viewerId === hostId;

  if (state.mode === 'split' && state.stale) {
    if (isHost) {
      const text = "Who paid doesn't match the new total";
      return { text, action: 'fix', actionLabel: 'Fix', tone: 'warning', icon: 'warning', a11yLabel: `${text}. Fix who paid`, a11yHint: OPENS_WHO_PAID };
    }
    const host = midName(hostId, viewerId, nameOf);
    const text = `Waiting for ${host === A_FRIEND ? 'the host' : host} to update who paid`;
    return { text, action: null, actionLabel: null, tone: 'muted', icon: null, a11yLabel: text, a11yHint: null };
  }

  const joinIndex = new Map(input.joinOrder.map((id, i) => [id, i]));
  const joinRank = (id: string) => joinIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...state.payers].sort(
    (a, b) =>
      Number(b.userId === viewerId) - Number(a.userId === viewerId) ||
      b.paidCents - a.paidCents ||
      joinRank(a.userId) - joinRank(b.userId) ||
      codeUnitCompare(a.userId, b.userId),
  );
  const name = (p: Payer) => midName(p.userId, viewerId, nameOf);

  let text: string;
  if (state.mode === 'one' || ordered.length === 1) {
    text = `Paid by ${ordered[0] ? name(ordered[0]) : A_FRIEND}`;
  } else if (ordered.length <= 3) {
    text = `Paid by ${joinNames(ordered.map((p) => `${name(p)} ${formatCents(p.paidCents)}`))}`;
  } else if (isHost) {
    text = `Paid by ${ordered.length} people`;
  } else {
    text = `Paid by ${ordered.slice(0, 2).map(name).join(', ')} and ${ordered.length - 2} others`;
  }

  if (isHost) {
    return { text, action: 'change', actionLabel: 'Change', tone: 'muted', icon: null, a11yLabel: `${text}. Change who paid`, a11yHint: OPENS_WHO_PAID };
  }
  return { text, action: null, actionLabel: null, tone: 'muted', icon: null, a11yLabel: text, a11yHint: null };
}

/** "a", "a and b", "a, b and c". */
function joinNames(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
