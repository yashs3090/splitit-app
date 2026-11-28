// Data layer for bills: thin wrappers around the database functions and RLS-protected selects.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Functions and Realtime", Task 8).
// Settling (payer, "I paid" marks, set_payer / mark_paid / unmark_paid): docs/specs/2026-11-24-m3-settle-venmo.md
// (D1, C2, C3; Task 5).
// Membership (add_participant / remove_participant / leave_bill): docs/specs/2026-11-24-people-and-invites.md
// (D3, D7; Task 4).
// Home's list and seen state (my_bills / mark_bill_seen): docs/specs/2026-11-24-bill-markers-and-notices.md
// (D2, D3; Task 3).
// Settle early and differences (settle_difference, Home's batched read fetchSettleData):
// docs/specs/2026-11-25-settle-early-and-differences.md (D4, D7; Task 4, Amendment A1).
// Sent via Venmo (payment methods, mark_paid's (settled_at, created), mark_not_received, seen_at):
// docs/specs/2026-11-26-sent-via-venmo.md (D1, D2, D4, D7, D8; Task 3, Amendment A1).
// Who paid (the payments ledger: bill_payments, bill_payment_flags, bill_payers; set_payers, the
// re-created mark functions with p_plan_key, unmark_paid's p_payer_id): docs/specs/2026-11-26-who-paid.md
// (A1.3, A1.4; Task 5). The per-participant `mark` / `notReceived` are now derived from the ledger
// (see BillMember) so today's screens keep working until Tasks 6–10 read the ledger directly.
//
// Every wrapper returns { ok: true, ... } or { ok: false, error: BillError }. Errors are mapped
// from the SQLSTATE only, per function, to a fixed code; server text (message, details, hint) is
// never returned, so it can't reach the screen. Anything unexpected (no SQLSTATE, an unknown one,
// a thrown error, a response of the wrong shape) is 'network'.
//
// Reads validate every value: cents and parts must pass Number.isInteger, ids must be UUIDs.
// Malformed data is 'network', never coerced.
import type { BillMoneyArgs, BillRowArg, DiscountAppliesTo, RowKind, SavedBill, SavedClaim, SavedRow } from './billPayload';
import { isSettleCents, SETTLE_MAX_CENTS } from './paylinks';
import { payersState, validateSplit, type Payer } from './payers';
import { isPaymentMethod, type PaymentMethod } from './paymentMethods';
import type { SettleMark, SettleNotReceived } from './settle';
import type { ExtrasMode } from './split';
import { supabase } from './supabase';
import { pairState, PLAN_KEY_PATTERN, timestampMicros, type Payment } from './transfers';
import { VENMO_USERNAME_PATTERN } from './venmo';

export type BillError =
  | 'invalid_code'
  | 'not_found'
  | 'not_allowed'
  | 'invalid_bill'
  | 'claimers_changed'
  | 'marks_changed' // set_payer before who-paid 4b (p_expected_cleared). No function raises it after 4b; kept for today's screens
  | 'payer_changed' // mark_paid: the person getting paid changed since the screen loaded
  | 'not_complete' // mark_paid: an item is unclaimed again (rule C1)
  | 'not_linked' // add_participant: you haven't split a bill with them (rule L1)
  | 'cannot_remove' // remove_participant: they have a claim or a mark, or are the host or payer (rule L3)
  | 'cannot_leave' // leave_bill: you have a claim or a mark, or are the host or payer (rule L3)
  | 'mark_changed' // settle_difference / mark_not_received: the mark isn't the one the screen showed (stale token)
  | 'invalid_method' // mark_paid / settle_difference: not one of PAYMENT_METHODS (refused locally, or by the database)
  // Groups (docs/specs/2026-11-26-groups-mvp.md A1.8, S7): the bill is in a group. Raised by the T5
  // triggers on bill_participants (a non-member joining; removing or leaving a member; a mark) and by
  // add_participant on any group bill.
  | 'in_group'
  // Who paid (A1.3, A1.4; D7's error copy):
  | 'invalid_payers' // set_payers: a malformed list (count, id, duplicate) or amount. lib refuses first, with no rpc
  | 'not_participant' // set_payers: someone on the list isn't on the bill (they left while the sheet was open)
  | 'payers_total' // set_payers: the amounts don't add up to the bill total (it changed while the sheet was open)
  | 'payers_stale' // mark_paid / settle_difference: a split bill's amounts no longer add up to its total
  // Delete group A3.4: Postgres aborted the write in a lock clash (BUSY_SQLSTATES). A definite
  // failure (nothing was written), safe to retry by hand. Not an unknown outcome, unlike 'network'.
  | 'busy'
  | 'network';

/**
 * SQLSTATEs for a write Postgres aborted in a lock clash: 40P01 deadlock detected, 40001
 * serialization failure, 55P03 lock not available (docs/specs/2026-11-28-delete-group.md A3.1, A3.4).
 * The transaction rolled back, so the write definitely did not happen. Exported for lib/groups.ts.
 */
export const BUSY_SQLSTATES: readonly string[] = ['40P01', '40001', '55P03'];
/** The copy for a lock-clash abort, the same for bills and groups (A3.2). */
export const BUSY_COPY = "That didn't go through. Please try again.";

/** True for an error object (returned or thrown) whose SQLSTATE is one of BUSY_SQLSTATES. */
export function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && BUSY_SQLSTATES.includes(code);
}

export type BillResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: BillError };

/** Generic fixed copy. Screens may use more specific copy for their context (see the spec). */
export const BILL_ERROR_COPY: Record<BillError, string> = {
  invalid_code: "This link doesn't work anymore. Ask for a new one.",
  not_found: "You don't have access to this bill, or it doesn't exist.",
  not_allowed: "You can't make that change.",
  invalid_bill: "The bill changed while you were editing. Go back and try again.",
  claimers_changed: 'Someone joined or left this item. Check the split and try again.',
  marks_changed: "Someone marked that they paid just now. Check who'll be affected and try again.",
  payer_changed: 'Who gets paid just changed. Check the amount and try again.',
  not_complete: "Some items aren't claimed anymore. You can settle up once every item is claimed.",
  not_linked: "You can only add people you've split a bill with.",
  cannot_remove: "Couldn't remove them. They may have just claimed an item.",
  cannot_leave: "You can't leave right now. Unclaim your items first.",
  mark_changed: 'Your "I paid" just changed. Check the amount and try again.',
  invalid_method: "That way of paying isn't available. Choose another and try again.",
  // The spec's words (A1.8), the same as lib/groups.ts's GROUP_ERROR_COPY.in_group.
  in_group: "This bill is in a group. Ask for the group's link.",
  // Who paid D7 / A1.5. Screens that know the names and amounts use more specific copy.
  invalid_payers: "Those amounts didn't save. Check them and try again.",
  not_participant: 'Someone on the list left the bill. Check the amounts.',
  payers_total: "The amounts don't add up to the bill total anymore. Check them and try again.",
  payers_stale: "Who paid doesn't match the bill total. The host needs to update it before anyone can settle up.",
  busy: BUSY_COPY,
  network: 'Something went wrong. Check your connection and try again.',
};

export type BillRecord = SavedBill & {
  id: string;
  host_id: string;
  join_code: string;
  created_at: string;
  edited_at: string | null;
  /** How tax, tip, fees and bill-level discounts are allocated (A1.7). Validated on read. */
  extras_split: ExtrasMode;
  /** Who gets paid (M3 D1). Always a current participant (invariant P); changes only through set_payer. */
  payer_id: string;
};

/**
 * A fetched row. parseRow always sets kind and applies_to (claimable discounts, C1); they stay
 * optional in the type (via SavedRow, absent = item) so hand-built rows elsewhere still type-check.
 */
export type BillRow = SavedRow & { split_set_by: string | null; split_set_at: string | null };
export type BillClaim = SavedClaim;
/** A participant's name, as Activity and makeNameOf need it. */
export type BillParticipant = { userId: string; displayName: string | null };
/**
 * One person's "I paid" (M3 D1): the amount the screen showed (rule C2), when they tapped it (as the
 * database sent it, so it can go back as mark_not_received's p_expected_at), how they paid, and who
 * it was to (the bill's payer_id when parsed; sent-via-Venmo §11). The same shape as SettleMark.
 */
export type BillMark = SettleMark;
/**
 * A participant as fetchBill returns them: the name plus what settling needs. `venmoUsername` is
 * null or matches VENMO_USERNAME_PATTERN.
 *
 * `mark` and `notReceived` are **derived from the ledger** (who-paid A1.2/A1.3), toward the bill's
 * current `payer_id` only, so the single-payer screens keep their 92 contract:
 * - `mark` = contract P's mark of the pair (this person → payer_id): `cents` = the pair's net, `at`
 *   = the `recorded_at` that started the latest positive run (stable across top-ups, so the
 *   check-in key `<billId>.<payerId>.<markAtMs>` and mark_not_received's tokens stay valid),
 *   `method` = the run's method or 'other'. null when the net is ≤ 0, and always null on the payer.
 * - `notReceived` = the bill_payment_flags row (this person → payer_id), or null.
 * Payments and flags toward anyone else (a co-payer, an ex-payer) are only in `BillData.payments` /
 * `BillData.flags`. Tasks 6–10 move the screens onto those and then delete these two fields.
 */
export type BillMember = BillParticipant & {
  venmoUsername: string | null;
  mark: BillMark | null;
  notReceived: SettleNotReceived | null;
};

/** A bill_payers row (contract W): split mode only; one-person bills have none. */
export type BillPayerRow = Payer;
/**
 * A bill_payments entry (A1.3): one recorded money movement, never updated. `at` is `recorded_at`
 * exactly as the API sent it (microseconds kept; compare with transfers' `comparePayments`).
 */
export type BillPayment = Payment & { method: PaymentMethod };
/** A bill_payment_flags row: `toId` said `fromId`'s payment of `cents` never arrived. */
export type BillPaymentFlag = { fromId: string; toId: string; cents: number; method: PaymentMethod };

export type BillData = {
  bill: BillRecord;
  /** Ordered by group_position, then unit_index. */
  rows: BillRow[];
  /** Ordered by joined_at. */
  participants: BillMember[];
  claims: BillClaim[];
  /** bill_payers rows, as stored (lead first is payersState's job). Empty = one person (payer_id). */
  payers: BillPayerRow[];
  /** Every bill_payments entry, ordered by (recorded_at, id). */
  payments: BillPayment[];
  /** Every bill_payment_flags row. */
  flags: BillPaymentFlag[];
};

/**
 * One row of Home's "Your bills", from my_bills() (docs/specs/2026-11-24-bill-markers-and-notices.md D2).
 * Every field is about the caller only: `joinedAt`, `added`, `seen` and `claimedAny` describe the
 * caller's own participant row, and `complete` is the database's private.bill_is_complete.
 */
export type BillSummary = {
  id: string;
  hostId: string;
  hostName: string | null;
  payerId: string;
  totalCents: number;
  createdAt: string;
  /** When the caller joined or was added. The list is ordered by this, newest first. */
  joinedAt: string;
  /** The host added the caller (people-and-invites D3), and they haven't opened the link since. */
  added: boolean;
  /** The caller has opened this bill or dismissed its notice (bill_seen). */
  seen: boolean;
  /** The caller has at least one claim on any row (items or claimable discounts). */
  claimedAny: boolean;
  /** Every row, discounts included, has at least one claim (private.bill_is_complete). */
  complete: boolean;
  /**
   * When the caller last opened this bill (their own bill_seen.seen_at, as sent), or null with no
   * bill_seen row (sent-via-Venmo D7). Home's `sent` marker compares marks against it.
   */
  seenAt: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOIN_CODE_RE = /^[0-9a-f]{20}$/;
const MAX_PARTS = 20;
const MY_BILLS_LIMIT = 20;
/** fetchSettleData reads at most this many bills (Home lists at most MY_BILLS_LIMIT). */
const SETTLE_DATA_MAX_BILLS = MY_BILLS_LIMIT;
/**
 * PostgREST cuts every response at `max_rows` without an error (1000 locally, supabase/config.toml;
 * verify the hosted project's setting). fetchSettleData asks for rows 0..999 with an exact count and
 * treats a response with fewer rows than its count (any lower max_rows; review R7), a missing count,
 * or a full page as a cut-off list (A1, SE-ENG-9).
 */
const SETTLE_DATA_ROW_CAP = 1000;

// Explicit relationship hints: bills ↔ profiles is ambiguous to PostgREST (host_id, and many-to-many
// through bill_participants; PGRST201 verified against the local stack), so name the foreign key.
// Every read names its columns (never `*`): profiles has column-level SELECT grants, so `*` fails
// with 42501 (lessons log 2026-11-24).
const BILL_COLUMNS =
  'id, host_id, subtotal_cents, tax_cents, fees_cents, tip_cents, subtotal_discount_cents, total_discount_cents, total_cents, join_code, created_at, edited_at, extras_split, payer_id';
const ROW_COLUMNS =
  'id, name, note, group_position, unit_index, group_size, total_cents, split_set_by, split_set_at, kind, applies_to';
// The mark columns left bill_participants in who-paid 4a (A1.3): marks are bill_payments entries now.
const PARTICIPANT_COLUMNS = 'user_id, joined_at, profile:profiles!bill_participants_user_id_fkey(display_name, venmo_username)';
const CLAIM_COLUMNS = 'line_item_id, user_id, parts';
/** Who paid (A1.4). Each read names its columns and asks for an exact count (fails closed when cut). */
export const BILL_PAYER_COLUMNS = 'user_id, paid_cents';
export const PAYMENT_COLUMNS = 'id, from_user, to_user, cents, method, plan_key, recorded_at';
export const FLAG_COLUMNS = 'from_user, to_user, cents, method';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type DbFunction =
  | 'create_bill'
  | 'update_bill'
  | 'join_bill'
  | 'rotate_join_code'
  | 'set_claim'
  | 'set_item_split'
  | 'set_extras_split'
  | 'set_payer'
  | 'set_payers'
  | 'mark_paid'
  | 'settle_difference'
  | 'mark_not_received'
  | 'unmark_paid'
  | 'add_participant'
  | 'remove_participant'
  | 'leave_bill'
  | 'my_bills'
  | 'mark_bill_seen';

/**
 * SQLSTATE → code, per function. 42501 is common to all: the functions' own not_allowed (signed
 * out, not the host, not a claimer) and Postgres's "permission denied for function" for anon both
 * use it, so it is matched on the SQLSTATE, never the message.
 */
const ERRORS_BY_FUNCTION: Record<DbFunction | 'read', Readonly<Record<string, BillError>>> = {
  create_bill: { '22023': 'invalid_bill' },
  update_bill: { '22023': 'invalid_bill' },
  join_bill: { P0002: 'invalid_code' },
  rotate_join_code: {},
  // 23503: the row was deleted between the visibility check and the insert. Its 22023
  // (invalid_claim) needs a null p_claimed, which the boolean parameter rules out: 'network'.
  set_claim: { P0002: 'not_found', '23503': 'not_found' },
  // set_item_split's 22023 is either claimers_changed or invalid_parts: see ERRORS_BY_MESSAGE.
  set_item_split: { P0002: 'not_found' },
  // 22023 invalid_mode: unreachable through setExtrasSplit's own check, but mapped, not 'network'.
  set_extras_split: { '22023': 'invalid_bill' },
  // C3: these three raise 22023 with several meanings: see ERRORS_BY_MESSAGE.
  set_payer: {},
  set_payers: {}, // 22023 has several meanings: see ERRORS_BY_MESSAGE
  mark_paid: {},
  settle_difference: {}, // 22023 has several meanings: see ERRORS_BY_MESSAGE
  mark_not_received: {}, // same
  unmark_paid: {}, // 42501 only (the in_group port is a BEFORE INSERT trigger; unmark only deletes)
  // Each raises one 22023 meaning, still matched by message (ERRORS_BY_MESSAGE) so any other text is 'network'.
  add_participant: {},
  remove_participant: {},
  leave_bill: {},
  // Bill markers D2/D3: only 42501 (signed out; not on the bill or no such bill) is mapped.
  my_bills: {},
  mark_bill_seen: {},
  read: {},
};

/**
 * SQLSTATEs one function raises with more than one meaning, told apart by the function's fixed
 * `message` (an exact match against the allow-list; any other text is 'network'). Only the
 * matched code is returned, never the text.
 */
const ERRORS_BY_MESSAGE: Partial<Record<DbFunction, Readonly<Record<string, Readonly<Record<string, BillError>>>>>> = {
  // Groups A1.8 (S7): a non-member opening a group bill's link. P0002 stays in ERRORS_BY_FUNCTION.
  join_bill: { '22023': { in_group: 'in_group' } },
  set_item_split: {
    // The claimer set changed since the screen loaded: the client refetches.
    '22023': { claimers_changed: 'claimers_changed', invalid_parts: 'invalid_bill' },
  },
  // M3 C3. Only the messages each function raises are allowed; anything else is 'network'.
  // Who paid 4b: set_payer(p_bill_id, p_payer_id) has no token any more, so marks_changed is gone
  // from its allow-list (it would be 'network' now). not_participant stays invalid_bill (the picker
  // only lists participants, so it's a stale screen).
  set_payer: {
    '22023': { not_participant: 'invalid_bill' },
  },
  // Who paid 4b, D1's check order (plus 1b in_group). invalid_amount can only come from a direct
  // caller (lib refuses first), so it shares invalid_payers' copy.
  set_payers: {
    '22023': {
      in_group: 'in_group',
      invalid_payers: 'invalid_payers',
      invalid_amount: 'invalid_payers',
      not_participant: 'not_participant',
      payers_total: 'payers_total',
    },
  },
  mark_paid: {
    '22023': {
      invalid_amount: 'invalid_bill',
      invalid_method: 'invalid_method',
      // Who paid A1.3: lib never sends a malformed key, so it's a bug or a direct caller.
      invalid_plan_key: 'invalid_bill',
      payer_changed: 'payer_changed',
      is_payer: 'invalid_bill',
      // Who paid 4b (S8): checked before all_zero; the host must fix the amounts first.
      payers_stale: 'payers_stale',
      not_complete: 'not_complete',
      // Settle early, rule Z (D3 step 6): the app never offers "I paid" there, so it's a stale screen.
      all_zero: 'invalid_bill',
      // Groups (T5 trigger): no marks on a group bill; a bill moved into a group under the screen.
      in_group: 'in_group',
    },
  },
  // Settle early and differences D4. mark_changed is the stale-token answer (refetch and look again).
  settle_difference: {
    '22023': {
      invalid_amount: 'invalid_bill',
      invalid_method: 'invalid_method',
      invalid_plan_key: 'invalid_bill',
      payer_changed: 'payer_changed',
      payers_stale: 'payers_stale',
      all_zero: 'invalid_bill',
      not_complete: 'not_complete',
      mark_changed: 'mark_changed',
      in_group: 'in_group',
    },
  },
  // Sent via Venmo D4: a former payer (payer_changed) or a stale cents/time token (mark_changed).
  mark_not_received: {
    '22023': { payer_changed: 'payer_changed', mark_changed: 'mark_changed', invalid_amount: 'invalid_bill', in_group: 'in_group' },
  },
  // People and invites D7: one message each, plus groups' in_group (A1.8: a group bill's people
  // come from the group).
  add_participant: { '22023': { not_linked: 'not_linked', in_group: 'in_group' } },
  remove_participant: { '22023': { cannot_remove: 'cannot_remove', in_group: 'in_group' } },
  leave_bill: { '22023': { cannot_leave: 'cannot_leave', in_group: 'in_group' } },
};

function mapError(op: DbFunction | 'read', error: unknown): BillError {
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : {};
  const code = fields.code;
  if (typeof code !== 'string') return 'network';
  if (code === '42501') return 'not_allowed';
  // A3.4: bill writes only. Reads (fetchBill's selects, Home's my_bills) keep 'network'.
  if (op !== 'read' && op !== 'my_bills' && BUSY_SQLSTATES.includes(code)) return 'busy';
  const byMessage = op === 'read' ? undefined : ERRORS_BY_MESSAGE[op]?.[code];
  if (byMessage) {
    const message = fields.message;
    return (typeof message === 'string' && Object.hasOwn(byMessage, message) ? byMessage[message] : undefined) ?? 'network';
  }
  return ERRORS_BY_FUNCTION[op][code] ?? 'network';
}

function fail(error: BillError): { ok: false; error: BillError } {
  return { ok: false, error };
}

/** Runs an rpc; returns its data, or a mapped error. Never throws. */
async function callRpc(fn: DbFunction, args: Record<string, unknown>): Promise<{ data: unknown } | { error: BillError }> {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return { error: mapError(fn, error) };
    return { data: data as unknown };
  } catch (thrown) {
    // A thrown error object carrying a lock-clash SQLSTATE is still a definite abort (A3.3).
    return { error: isBusyError(thrown) ? mapError(fn, thrown) : 'network' };
  }
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isExtrasMode = (v: unknown): v is ExtrasMode => v === 'proportional' || v === 'equal';
const isJoinCode = (v: unknown): v is string => typeof v === 'string' && JOIN_CODE_RE.test(v);
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isVenmoUsernameOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && VENMO_USERNAME_PATTERN.test(v));

class Malformed extends Error {}

function check<T>(ok: boolean, value: T): T {
  if (!ok) throw new Malformed();
  return value;
}

function parseBill(v: unknown): BillRecord {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    host_id: check(isUuid(v.host_id), v.host_id as string),
    subtotal_cents: check(v.subtotal_cents === null || isInt(v.subtotal_cents), v.subtotal_cents as number | null),
    tax_cents: check(isInt(v.tax_cents), v.tax_cents as number),
    fees_cents: check(isInt(v.fees_cents), v.fees_cents as number),
    tip_cents: check(isInt(v.tip_cents), v.tip_cents as number),
    subtotal_discount_cents: check(isInt(v.subtotal_discount_cents), v.subtotal_discount_cents as number),
    total_discount_cents: check(isInt(v.total_discount_cents), v.total_discount_cents as number),
    total_cents: check(isInt(v.total_cents), v.total_cents as number),
    join_code: check(isJoinCode(v.join_code), v.join_code as string),
    created_at: check(isString(v.created_at), v.created_at as string),
    edited_at: check(isStringOrNull(v.edited_at), v.edited_at as string | null),
    extras_split: check(isExtrasMode(v.extras_split), v.extras_split as ExtrasMode),
    payer_id: check(isUuid(v.payer_id), v.payer_id as string),
  };
}

/**
 * Claimable discounts (C1): kind and applies_to must agree with the sign. An item has applies_to
 * null and total_cents ≥ 0; a discount has applies_to 'subtotal' | 'total' and total_cents ≤ −1.
 * A row without the keys at all reads as an item: the select always names them, so only hand-built
 * test fixtures lack them, and the item rules (non-negative cents) still apply.
 */
function parseKind(v: Record<string, unknown>): { kind: RowKind; applies_to: DiscountAppliesTo | null } {
  const kind = v.kind === undefined ? 'item' : v.kind;
  const appliesTo = v.applies_to === undefined ? null : v.applies_to;
  const cents = v.total_cents;
  if (kind === 'item' && appliesTo === null && isInt(cents) && cents >= 0) return { kind, applies_to: null };
  if (kind === 'discount' && (appliesTo === 'subtotal' || appliesTo === 'total') && isInt(cents) && cents <= -1) {
    return { kind, applies_to: appliesTo };
  }
  throw new Malformed();
}

function parseRow(v: unknown): BillRow {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    name: check(isString(v.name), v.name as string),
    note: check(isStringOrNull(v.note), v.note as string | null),
    group_position: check(isInt(v.group_position), v.group_position as number),
    unit_index: check(isInt(v.unit_index), v.unit_index as number),
    group_size: check(isInt(v.group_size), v.group_size as number),
    total_cents: check(isInt(v.total_cents), v.total_cents as number),
    split_set_by: check(v.split_set_by === null || isUuid(v.split_set_by), v.split_set_by as string | null),
    split_set_at: check(isStringOrNull(v.split_set_at), v.split_set_at as string | null),
    ...parseKind(v),
  };
}

/** An embedded to-one profile: null when RLS hides it. */
function parseDisplayName(profile: unknown): string | null {
  if (profile === null || profile === undefined) return null;
  if (!isObject(profile)) throw new Malformed();
  return check(isStringOrNull(profile.display_name), profile.display_name as string | null);
}

/** The embedded profile's Venmo username: null when unset or when RLS hides the profile. */
function parseVenmoUsername(profile: unknown): string | null {
  if (profile === null || profile === undefined) return null;
  if (!isObject(profile)) throw new Malformed();
  return check(isVenmoUsernameOrNull(profile.venmo_username), profile.venmo_username as string | null);
}

/** A participant row: the user and their profile. Marks are read from the ledger (parseLedger). */
function parseParticipant(v: unknown): { userId: string; displayName: string | null; venmoUsername: string | null } {
  if (!isObject(v)) throw new Malformed();
  return {
    userId: check(isUuid(v.user_id), v.user_id as string),
    displayName: parseDisplayName(v.profile),
    venmoUsername: parseVenmoUsername(v.profile),
  };
}

/** A bill_payers row (contract W): a uuid and an integer 1..99,999,999 (payersState checks the set). */
function parsePayer(v: unknown): BillPayerRow {
  if (!isObject(v)) throw new Malformed();
  return {
    userId: check(isUuid(v.user_id), v.user_id as string),
    paidCents: check(isSettleCents(v.paid_cents), v.paid_cents as number),
  };
}

/** A full timestamp with an offset, as contract P orders it (microseconds kept; never Date.parse). */
function isLedgerTimestamp(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    timestampMicros(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bill_payments entry (A1.3): uuids, from ≠ to, cents per the table's check (1..99,999,999, the
 * same range as rule C2), a known method, plan_key null or 16 lowercase hex, and recorded_at kept as
 * sent.
 */
function parsePayment(v: unknown): BillPayment {
  if (!isObject(v)) throw new Malformed();
  const fromId = check(isUuid(v.from_user), v.from_user as string);
  const toId = check(isUuid(v.to_user) && v.to_user !== fromId, v.to_user as string);
  return {
    id: check(isUuid(v.id), v.id as string),
    fromId,
    toId,
    cents: check(isSettleCents(v.cents), v.cents as number),
    method: check(isPaymentMethod(v.method), v.method as PaymentMethod),
    planKey: check(v.plan_key === null || (typeof v.plan_key === 'string' && PLAN_KEY_PATTERN.test(v.plan_key)), v.plan_key as string | null),
    at: check(isLedgerTimestamp(v.recorded_at), v.recorded_at as string),
  };
}

/** A bill_payment_flags row: uuids, from ≠ to, cents 1..99,999,999 and a known method. */
function parseFlag(v: unknown): BillPaymentFlag {
  if (!isObject(v)) throw new Malformed();
  const fromId = check(isUuid(v.from_user), v.from_user as string);
  return {
    fromId,
    toId: check(isUuid(v.to_user) && v.to_user !== fromId, v.to_user as string),
    cents: check(isSettleCents(v.cents), v.cents as number),
    method: check(isPaymentMethod(v.method), v.method as PaymentMethod),
  };
}

/** Raw rows of one bill, as the reads return them. */
type RawBill = { participants: unknown; payers: unknown; payments: unknown; flags: unknown };

/**
 * One bill's people and ledger, strictly: any malformed row makes the whole bill malformed.
 * - payers: payersState's rules (none, or 2+ distinct rows including payer_id);
 * - every payer, payment end and flag end is a participant (the foreign keys; a read that disagrees
 *   is a torn read and fails closed, so the screen retries);
 * - payment ids are unique; flags are unique per (from, to);
 * - the derived `mark` / `notReceived` per participant (see BillMember).
 */
function parsePeople(
  bill: BillRecord,
  raw: RawBill,
): Pick<BillData, 'participants' | 'payers' | 'payments' | 'flags'> {
  const people = parseList(raw.participants, parseParticipant);
  const ids = new Set(people.map((p) => p.userId));
  if (ids.size !== people.length) throw new Malformed();
  const payers = parseList(raw.payers, parsePayer);
  if (payers.length > 0) {
    try {
      payersState({ payerId: bill.payer_id, rows: payers, totalCents: bill.total_cents });
    } catch {
      throw new Malformed();
    }
  }
  const payments = parseList(raw.payments, parsePayment);
  const flags = parseList(raw.flags, parseFlag);
  const known = (id: string) => ids.has(id);
  if (!payers.every((p) => known(p.userId))) throw new Malformed();
  if (!payments.every((p) => known(p.fromId) && known(p.toId))) throw new Malformed();
  if (!flags.every((f) => known(f.fromId) && known(f.toId))) throw new Malformed();
  if (new Set(payments.map((p) => p.id)).size !== payments.length) throw new Malformed();
  if (new Set(flags.map((f) => `${f.fromId}|${f.toId}`)).size !== flags.length) throw new Malformed();
  payments.sort((a, b) => {
    const ta = timestampMicros(a.at);
    const tb = timestampMicros(b.at);
    return ta !== tb ? ta - tb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const payerId = bill.payer_id;
  const participants: BillMember[] = people.map((p) => ({
    ...p,
    mark: p.userId === payerId ? null : derivedMark(payments, p.userId, payerId),
    notReceived: derivedFlag(flags, p.userId, payerId),
  }));
  return { participants, payers, payments, flags };
}

/** Contract P's mark of (userId → payerId), in the 92 SettleMark shape. */
function derivedMark(payments: readonly BillPayment[], userId: string, payerId: string): BillMark | null {
  const mark = pairState(payments, userId, payerId).mark;
  if (mark === null) return null;
  // The run's shared method, or 'other' when they differ: always a PaymentMethod, checked anyway.
  if (!isPaymentMethod(mark.method)) throw new Malformed();
  return { cents: mark.cents, at: mark.at, method: mark.method, toUserId: payerId };
}

/** The flag (userId → payerId) in the 92 SettleNotReceived shape. */
function derivedFlag(flags: readonly BillPaymentFlag[], userId: string, payerId: string): SettleNotReceived | null {
  const flag = flags.find((f) => f.fromId === userId && f.toId === payerId);
  return flag ? { cents: flag.cents, method: flag.method, toUserId: payerId } : null;
}

function parseClaim(v: unknown): BillClaim {
  if (!isObject(v)) throw new Malformed();
  return {
    line_item_id: check(isUuid(v.line_item_id), v.line_item_id as string),
    user_id: check(isUuid(v.user_id), v.user_id as string),
    parts: check(isInt(v.parts), v.parts as number),
  };
}

/** One my_bills() row (D2). Only the D2 columns are read; anything else in the row is dropped. */
function parseSummary(v: unknown): BillSummary {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.bill_id), v.bill_id as string),
    hostId: check(isUuid(v.host_id), v.host_id as string),
    hostName: check(isStringOrNull(v.host_name), v.host_name as string | null),
    payerId: check(isUuid(v.payer_id), v.payer_id as string),
    totalCents: check(isInt(v.total_cents), v.total_cents as number),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
    joinedAt: check(isTimestamp(v.joined_at), v.joined_at as string),
    added: check(isBoolean(v.added), v.added as boolean),
    seen: check(isBoolean(v.seen), v.seen as boolean),
    claimedAny: check(isBoolean(v.claimed_any), v.claimed_any as boolean),
    complete: check(isBoolean(v.complete), v.complete as boolean),
    // Absent (a database without the sent-via-Venmo migration) reads as null: an older my_bills()
    // has no seen_at, and null means "compare by `seen` alone" (D7). Present must be null or a timestamp.
    seenAt: v.seen_at === undefined ? null : check(v.seen_at === null || isTimestamp(v.seen_at), v.seen_at as string | null),
  };
}

function parseList<T>(v: unknown, parse: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Malformed();
  return v.map(parse);
}

// ---------------------------------------------------------------------------
// Writes (database functions)
// ---------------------------------------------------------------------------

/**
 * Only the keys validate_bill_rows accepts (id, name, note, group_position, unit_index,
 * group_size, total_cents, and kind / applies_to on discount rows), so an extra property on a
 * caller's object never reaches the database. Item rows are sent without kind or applies_to,
 * exactly as before claimable discounts (C1).
 */
function rowArg(r: BillRowArg): BillRowArg {
  const base: BillRowArg = {
    name: r.name,
    note: r.note,
    group_position: r.group_position,
    unit_index: r.unit_index,
    group_size: r.group_size,
    total_cents: r.total_cents,
  };
  const out: BillRowArg = r.kind === 'discount' ? { ...base, kind: 'discount', applies_to: r.applies_to } : base;
  return r.id === undefined ? out : { id: r.id, ...out };
}

/** create_bill: the bill, its unit rows, the host as participant, and a join code, in one call. */
export async function createBill(
  rows: BillRowArg[],
  money: BillMoneyArgs,
): Promise<BillResult<{ billId: string; joinCode: string }>> {
  // create_bill rejects any row carrying an id (22023); fail the same way without a round trip.
  if (rows.some((r) => r.id !== undefined)) return fail('invalid_bill');
  const res = await callRpc('create_bill', { p_rows: rows.map(rowArg), ...money });
  if ('error' in res) return fail(res.error);
  // `returns table (bill_id, join_code)` arrives as a one-element array.
  const first: unknown = Array.isArray(res.data) && res.data.length === 1 ? res.data[0] : null;
  if (!isObject(first) || !isUuid(first.bill_id) || !isJoinCode(first.join_code)) return fail('network');
  return { ok: true, billId: first.bill_id, joinCode: first.join_code };
}

/** update_bill: host only. Rows with an id are kept (their claims stay); omitted rows are deleted. */
export async function updateBill(billId: string, rows: BillRowArg[], money: BillMoneyArgs): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  const res = await callRpc('update_bill', { p_bill_id: billId, p_rows: rows.map(rowArg), ...money });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/** join_bill: the only way into a bill. Malformed codes fail locally with the same error as unknown ones. */
export async function joinBill(code: string): Promise<BillResult<{ billId: string }>> {
  if (!isJoinCode(code)) return fail('invalid_code');
  const res = await callRpc('join_bill', { p_code: code });
  if ('error' in res) return fail(res.error);
  return isUuid(res.data) ? { ok: true, billId: res.data } : fail('network');
}

/** rotate_join_code: host only. The old link stops working; participants stay in. */
export async function rotateJoinCode(billId: string): Promise<BillResult<{ joinCode: string }>> {
  if (!isUuid(billId)) return fail('not_found');
  const res = await callRpc('rotate_join_code', { p_bill_id: billId });
  if ('error' in res) return fail(res.error);
  return isJoinCode(res.data) ? { ok: true, joinCode: res.data } : fail('network');
}

/** set_claim: claim (parts 1) or unclaim one unit row for yourself. Both are idempotent. */
export async function setClaim(rowId: string, claimed: boolean): Promise<BillResult> {
  if (!isUuid(rowId)) return fail('not_found');
  const res = await callRpc('set_claim', { p_line_item_id: rowId, p_claimed: claimed });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * set_item_split: a current claimer sets every claimer's parts on one row. `parts` must hold
 * exactly the row's current claimers (1–20 each); a changed claimer set returns claimers_changed.
 */
export async function setItemSplit(rowId: string, parts: Record<string, number>): Promise<BillResult> {
  if (!isUuid(rowId)) return fail('not_found');
  const entries = Object.entries(parts);
  const valid =
    entries.length > 0 && entries.every(([userId, p]) => isUuid(userId) && isInt(p) && p >= 1 && p <= MAX_PARTS);
  if (!valid) return fail('invalid_bill');
  const res = await callRpc('set_item_split', { p_line_item_id: rowId, p_parts: parts });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * set_extras_split: host only. How tax, tip, fees and bill-level discounts are split (A1.7).
 * Setting the current mode again is a no-op in the database (no event, no broadcast).
 */
export async function setExtrasSplit(billId: string, mode: ExtrasMode): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isExtrasMode(mode)) return fail('invalid_bill');
  const res = await callRpc('set_extras_split', { p_bill_id: billId, p_mode: mode });
  return 'error' in res ? fail(res.error) : { ok: true };
}

// ---------------------------------------------------------------------------
// Settling (M3 C3). The screen passes what it showed (payer, amount, mark count), so the database
// can refuse a decision made on out-of-date data.
// ---------------------------------------------------------------------------

/** null, or the 16-lowercase-hex format bill_payments.plan_key accepts (A1.3). */
const isPlanKeyOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && PLAN_KEY_PATTERN.test(v));

/**
 * set_payer (who-paid 4b): host only. One person paid the whole bill. **Clears no payment** (the
 * ledger, A1.0 item 3): earlier payments to someone who stops being a payer are passed on by the
 * plan. From split mode it deletes the bill_payers rows (never a no-op, even for the lead); setting
 * the current one payer again is a no-op in the database (no event).
 *
 * `_expectedCleared` is ignored and never sent: 4b dropped p_expected_cleared. It stays optional only
 * so today's Settle call site compiles until Task 10 removes the argument (A-26).
 */
export async function setPayer(billId: string, payerId: string, _expectedCleared?: number): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(payerId)) return fail('invalid_bill');
  const res = await callRpc('set_payer', { p_bill_id: billId, p_payer_id: payerId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * set_payers (who-paid 4b, contract W): host only. Several people paid, with these amounts. Checked
 * first with `validateSplit` (table W) against what the screen showed, with no rpc when it fails:
 * a bad count, id, duplicate or amount → invalid_payers; someone not on the bill → not_participant;
 * a sum ≠ `totalCents` (tolerance 0) → payers_total. The database checks the same rules in D1's
 * order (plus in_group for a group bill, A1.3 step 1b) against the bill as it is now. Saving the
 * identical split again is a no-op in the database.
 *
 * Sends `p_payers` as `[{ user_id, paid_cents }]`, in the order given (the database picks the lead).
 */
export async function setPayers(
  billId: string,
  payers: ReadonlyArray<{ userId: string; paidCents: unknown }>,
  shown: { totalCents: number; participantIds: readonly string[] },
): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  const valid = validateSplit(payers, shown);
  if (!valid.ok) {
    if (valid.reason === 'total') return fail('payers_total');
    if (valid.reason === 'participant') return fail('not_participant');
    return fail('invalid_payers');
  }
  const res = await callRpc('set_payers', {
    p_bill_id: billId,
    p_payers: valid.payers.map((p) => ({ user_id: p.userId, paid_cents: p.paidCents })),
  });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * mark_paid: "I paid" for yourself, and how (sent-via-Venmo D2, D8 item 3). `payerId` and `cents`
 * are what the screen showed. Cents outside rule C2 (an integer 1–99,999,999) are refused here with
 * invalid_bill, and a method outside PAYMENT_METHODS with invalid_method, both with no network call.
 * The database refuses a changed payer (payer_changed) or an incomplete bill (not_complete).
 *
 * The result says whether this call made the mark (F3):
 * - `created: true`, `markAt` = the new settled_at (as sent, the key for the check-in);
 * - `created: false`: a mark already existed and nothing changed (stale screen, second device,
 *   double tap), `markAt` = the stored settled_at, or null if a racing unmark won. Venmo must not
 *   open then.
 * Any other response shape is 'network' (the outcome is unknown, as with a lost response).
 *
 * `method` defaults to 'other' so today's screens keep compiling until Task 9a passes one.
 *
 * Who paid A1.3: `planKey` is the plan key of the plan the screen showed (`settleTransfers`' key,
 * Task 6), stamped on the entry so routes stay put; null = no key (the entry counts as made under an
 * earlier state, which only re-plans). A key that isn't 16 lowercase hex is refused here with
 * invalid_bill. It defaults to null until Task 10 passes the plan's key. In split mode `payerId` may
 * be any current payer; the database also refuses payers_stale (the amounts no longer add up).
 */
export async function markPaid(
  billId: string,
  payerId: string,
  cents: number,
  method: PaymentMethod = 'other',
  planKey: string | null = null,
): Promise<BillResult<{ markAt: string | null; created: boolean }>> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(payerId) || !isSettleCents(cents) || !isPlanKeyOrNull(planKey)) return fail('invalid_bill');
  if (!isPaymentMethod(method)) return fail('invalid_method');
  const res = await callRpc('mark_paid', {
    p_bill_id: billId,
    p_payer_id: payerId,
    p_cents: cents,
    p_method: method,
    p_plan_key: planKey,
  });
  if ('error' in res) return fail(res.error);
  // `returns table (settled_at, created)` arrives as a one-element array.
  const row: unknown = Array.isArray(res.data) && res.data.length === 1 ? res.data[0] : null;
  if (!isObject(row) || !isBoolean(row.created)) return fail('network');
  const at = row.settled_at;
  if (row.created ? !isTimestamp(at) : at !== null && !isTimestamp(at)) return fail('network');
  return { ok: true, markAt: at as string | null, created: row.created };
}

/**
 * settle_difference (D4): records a paid difference on `userId`'s "I paid" mark. `payerId` is the
 * payer the screen showed; `expectedCents` is the mark the screen showed (the stale-state token,
 * 1–99,999,999); `newCents` is the new net amount (0–99,999,999, never equal to the token);
 * `method` is how this difference was paid (sent-via-Venmo D1: on a raise the mark keeps its method
 * when equal, else becomes 'other'; a pay-back ignores it). A method outside PAYMENT_METHODS is
 * refused here with invalid_method. Defaults to 'other' (pay-backs, and today's screens).
 * Raising (newCents > expectedCents) is for the person themself; lowering is for the payer, and 0
 * clears the mark (A1.1). Bad amounts are refused here with invalid_bill and no network call. The
 * database refuses a changed mark (mark_changed), payer (payer_changed) or an incomplete bill
 * (not_complete); a retry whose result is already stored succeeds with no second event (A1.3).
 *
 * Who paid A1.3: the pair is `userId` → `payerId`, and the token is contract P's net on it. A raise
 * needs `payerId` to be a current payer; a pay-back is by `payerId`, who may be an ex-payer returning
 * money (WP-35). `planKey` as in markPaid (null by default until Task 10); payers_stale as there.
 */
export async function settleDifference(
  billId: string,
  userId: string,
  payerId: string,
  expectedCents: number,
  newCents: number,
  method: PaymentMethod = 'other',
  planKey: string | null = null,
): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId) || !isUuid(payerId) || !isPlanKeyOrNull(planKey)) return fail('invalid_bill');
  // The new amount may be 0 (paid back in full, which clears the mark), up to the C2 maximum.
  const newOk = isInt(newCents) && newCents >= 0 && newCents <= SETTLE_MAX_CENTS;
  if (!isSettleCents(expectedCents) || !newOk || newCents === expectedCents) return fail('invalid_bill');
  if (!isPaymentMethod(method)) return fail('invalid_method');
  const res = await callRpc('settle_difference', {
    p_bill_id: billId,
    p_user_id: userId,
    p_payer_id: payerId,
    p_expected_cents: expectedCents,
    p_new_cents: newCents,
    p_method: method,
    p_plan_key: planKey,
  });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * mark_not_received (sent-via-Venmo D4, §11): the payer says `userId`'s mark never arrived. It
 * clears the mark and stores the flag Sam sees. `payerId` is the payer the screen showed (the
 * caller); `expectedCents` and `expectedAt` are the mark's cents and settled_at exactly as fetched
 * (BillMark.cents / .at, the stale-state tokens; the time is sent as received, never re-formatted,
 * because a Date would drop the microseconds and never match).
 *
 * Refused here with no network call: a non-UUID bill (not_found); a non-UUID user or payer, cents
 * outside rule C2, or a time that doesn't parse (invalid_bill). The database answers not_allowed
 * (not the payer, an outsider, the payer themself), payer_changed (a former payer) or mark_changed
 * (the mark changed or is gone); a retry of a call that already landed succeeds with no second event.
 */
export async function markNotReceived(
  billId: string,
  userId: string,
  payerId: string,
  expectedCents: number,
  expectedAt: string,
): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId) || !isUuid(payerId)) return fail('invalid_bill');
  if (!isSettleCents(expectedCents) || !isTimestamp(expectedAt)) return fail('invalid_bill');
  const res = await callRpc('mark_not_received', {
    p_bill_id: billId,
    p_user_id: userId,
    p_payer_id: payerId,
    p_expected_cents: expectedCents,
    p_expected_at: expectedAt,
  });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * unmark_paid (who-paid A1.3, S16): clears the mark on the pair `userId` → `payerId` (the ledger
 * entries of the mark's current run, contract P). Allowed for the host, `userId` and `payerId` (Q4);
 * anyone else gets not_allowed. No mark on that pair is a no-op. The 2-argument version is gone.
 */
export async function unmarkPaid(billId: string, userId: string, payerId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId) || !isUuid(payerId) || userId === payerId) return fail('invalid_bill');
  const res = await callRpc('unmark_paid', { p_bill_id: billId, p_user_id: userId, p_payer_id: payerId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

// ---------------------------------------------------------------------------
// Membership (people and invites D3). None of these changes anyone's money: the database refuses
// to remove someone with a claim, a mark or the payer role (rule L3).
// ---------------------------------------------------------------------------

/**
 * add_participant: host only. Puts `userId` on the bill without a link. They must be linked with the
 * host (rule L1), else not_linked (also for an id that isn't a user). Someone already on the bill is a
 * no-op.
 */
export async function addParticipant(billId: string, userId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId)) return fail('invalid_bill');
  const res = await callRpc('add_participant', { p_bill_id: billId, p_user_id: userId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * remove_participant: host only. Refused with cannot_remove unless rule L3 holds for `userId`.
 * A target who isn't on the bill is a no-op.
 */
export async function removeParticipant(billId: string, userId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId)) return fail('invalid_bill');
  const res = await callRpc('remove_participant', { p_bill_id: billId, p_user_id: userId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/** leave_bill: take yourself off the bill. Refused with cannot_leave unless rule L3 holds (never the host). */
export async function leaveBill(billId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  const res = await callRpc('leave_bill', { p_bill_id: billId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

// ---------------------------------------------------------------------------
// Reads (RLS: participants only)
// ---------------------------------------------------------------------------

type Raw = { data: unknown; error: unknown };
/** A read made with `{ count: 'exact' }`: supabase-js adds the total number of matching rows. */
type CountedRaw = Raw & { count?: number | null };

/**
 * The ledger reads of one or more bills (who paid A1.4): bill_payers, bill_payments (ordered by
 * recorded_at, id) and bill_payment_flags, each with named columns, `count: 'exact'` and rows
 * 0..999, so a cut-off response fails closed (isCutOff). `withBillId` adds `bill_id` to group rows.
 */
function ledgerReads(filter: { eq: string } | { in: readonly string[] }, withBillId: boolean): [PromiseLike<CountedRaw>, PromiseLike<CountedRaw>, PromiseLike<CountedRaw>] {
  const exact = { count: 'exact' } as const;
  const cols = (c: string) => (withBillId ? `${c}, bill_id` : c);
  const scoped = (table: string, columns: string) => {
    const q = supabase.from(table).select(cols(columns), exact);
    return 'eq' in filter ? q.eq('bill_id', filter.eq) : q.in('bill_id', [...filter.in]);
  };
  const last = SETTLE_DATA_ROW_CAP - 1;
  return [
    scoped('bill_payers', BILL_PAYER_COLUMNS).range(0, last),
    scoped('bill_payments', PAYMENT_COLUMNS)
      .order('recorded_at', { ascending: true })
      .order('id', { ascending: true })
      .range(0, last),
    scoped('bill_payment_flags', FLAG_COLUMNS).range(0, last),
  ];
}

/**
 * The bill (with its payer), its unit rows (ordered by group_position, unit_index), participants
 * with display names and Venmo usernames (null when unset or hidden), all claims, and who paid: the
 * bill_payers rows, every bill_payments entry and every not-received flag (who-paid A1.4). Each
 * participant's `mark` / `notReceived` is derived from the ledger (BillMember). A non-UUID id, or a
 * bill RLS doesn't return, is not_found; a non-UUID id makes no query. A ledger read that comes back
 * cut off (fewer rows than its exact count, no count, or 1,000 rows) is network: a partial ledger
 * would show wrong amounts. Any malformed row makes the whole bill network.
 */
export async function fetchBill(id: string): Promise<BillResult<BillData>> {
  if (!isUuid(id)) return fail('not_found');
  let results: [Raw, Raw, Raw, Raw, CountedRaw, CountedRaw, CountedRaw];
  try {
    results = await Promise.all([
      supabase.from('bills').select(BILL_COLUMNS).eq('id', id).maybeSingle(),
      supabase
        .from('line_items')
        .select(ROW_COLUMNS)
        .eq('bill_id', id)
        .order('group_position', { ascending: true })
        .order('unit_index', { ascending: true }),
      supabase.from('bill_participants').select(PARTICIPANT_COLUMNS).eq('bill_id', id).order('joined_at', { ascending: true }),
      supabase.from('claims').select(CLAIM_COLUMNS).eq('bill_id', id),
      ...ledgerReads({ eq: id }, false),
    ]);
  } catch {
    return fail('network');
  }
  const failed = results.find((r) => r.error);
  if (failed) return fail(mapError('read', failed.error));

  const [billRes, rowsRes, participantsRes, claimsRes, payersRes, paymentsRes, flagsRes] = results;
  if (billRes.data === null || billRes.data === undefined) return fail('not_found');
  if ([payersRes, paymentsRes, flagsRes].some(isCutOff)) return fail('network');
  try {
    const bill = parseBill(billRes.data);
    const rows = parseList(rowsRes.data, parseRow).sort(
      (a, b) => a.group_position - b.group_position || a.unit_index - b.unit_index,
    );
    return {
      ok: true,
      bill,
      rows,
      claims: parseList(claimsRes.data, parseClaim),
      ...parsePeople(bill, {
        participants: participantsRes.data,
        payers: payersRes.data,
        payments: paymentsRes.data,
        flags: flagsRes.data,
      }),
    };
  } catch {
    return fail('network');
  }
}

/**
 * Home's "Your bills": my_bills() returns the caller's bills (at most 20, newest joined first; the
 * limit and order live only in the database, D2) with the facts Home's markers need. Rows come back
 * in the order received. Any malformed value, a repeated bill id or more than 20 rows makes the whole
 * result 'network': a partly valid list is never shown. The function's result columns are fixed by
 * its definition, so there is no table select (and no `*`) here.
 */
export async function listMyBills(): Promise<BillResult<{ bills: BillSummary[] }>> {
  const res = await callRpc('my_bills', {});
  if ('error' in res) return fail(res.error);
  try {
    const bills = parseList(res.data, parseSummary);
    if (bills.length > MY_BILLS_LIMIT) return fail('network');
    if (new Set(bills.map((b) => b.id)).size !== bills.length) return fail('network');
    return { ok: true, bills };
  } catch {
    return fail('network');
  }
}

/**
 * mark_bill_seen (D3): records that the caller opened this bill (or dismissed its notice), which
 * clears its "New" marker. Not on the bill, no such bill, or signed out → not_allowed. Logs no event
 * and sends no broadcast, so nobody else learns of it.
 */
export async function markBillSeen(billId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  const res = await callRpc('mark_bill_seen', { p_bill_id: billId });
  return 'error' in res ? fail(res.error) : { ok: true };
}

// ---------------------------------------------------------------------------
// Home's settle markers (settle early and differences D7, Task 4; A1, SE-ENG-9)
// ---------------------------------------------------------------------------

/**
 * A batched read asked for rows 0..999 with an exact count looks cut off (fetchSettleData,
 * fetchPeopleCounts): data not an array, no numeric count, fewer rows than the count (a lower
 * max_rows; review R7), or a full page of 1,000 rows (second guard).
 */
function isCutOff(r: CountedRaw): boolean {
  return (
    !Array.isArray(r.data) ||
    typeof r.count !== 'number' ||
    r.data.length < r.count ||
    r.data.length >= SETTLE_DATA_ROW_CAP
  );
}

/** One response's rows, grouped by their bill_id. Any row that can't be attributed to a requested bill is malformed. */
function groupByBill(data: unknown, ids: ReadonlySet<string>): Map<string, unknown[]> {
  if (!Array.isArray(data)) throw new Malformed();
  const groups = new Map<string, unknown[]>();
  for (const row of data as unknown[]) {
    if (!isObject(row) || !isUuid(row.bill_id) || !ids.has(row.bill_id)) throw new Malformed();
    const group = groups.get(row.bill_id);
    if (group) group.push(row);
    else groups.set(row.bill_id, [row]);
  }
  return groups;
}

/**
 * The same BillData fetchBill returns, for up to 20 bills in seven requests (bills, line_items,
 * bill_participants, claims, and who paid's bill_payers, bill_payments, bill_payment_flags), for
 * Home's settle markers. Each request names the fetchBill columns
 * (the child reads add `bill_id`, to group rows by bill), filters with `.in()` and asks for rows
 * 0..999.
 *
 * - `[]` makes no request. More than 20 ids, or an id that isn't a UUID: invalid_bill, no request.
 * - Any request failing, returning fewer rows than its exact count or no count (PostgREST's max_rows
 *   cut it off without an error, whatever max_rows is; review R7), or returning 1,000 rows or more
 *   (second guard), fails the whole call: a cut-off list would give a wrong "You owe $X".
 * - A row with no bill_id, or one for a bill that wasn't asked for, fails the whole call (it could
 *   belong to any bill).
 * - Each bill is parsed on its own: a bill whose rows don't parse, that RLS didn't return, or whose
 *   bill row came back twice is left out of the map, and the others keep theirs.
 * - Claims come back in no particular order (as in fetchBill). Never throws.
 *
 * The seven requests are seven transactions, so a host edit between them can mislabel a bill until
 * the next refresh (accepted; docs/before-production.md).
 */
export async function fetchSettleData(billIds: readonly string[]): Promise<BillResult<{ bills: Map<string, BillData> }>> {
  if (billIds.length > SETTLE_DATA_MAX_BILLS || !billIds.every(isUuid)) return fail('invalid_bill');
  const ids = [...new Set(billIds)];
  if (ids.length === 0) return { ok: true, bills: new Map() };
  const last = SETTLE_DATA_ROW_CAP - 1;
  // An exact count with each read: Postgres counts every matching row, so a response cut by a
  // max_rows below 1,000 has fewer rows than its count (R7).
  const exact = { count: 'exact' } as const;
  let results: [CountedRaw, CountedRaw, CountedRaw, CountedRaw, CountedRaw, CountedRaw, CountedRaw];
  try {
    results = await Promise.all([
      supabase.from('bills').select(BILL_COLUMNS, exact).in('id', ids).range(0, last),
      supabase
        .from('line_items')
        .select(`${ROW_COLUMNS}, bill_id`, exact)
        .in('bill_id', ids)
        .order('bill_id', { ascending: true })
        .order('group_position', { ascending: true })
        .order('unit_index', { ascending: true })
        .range(0, last),
      supabase
        .from('bill_participants')
        .select(`${PARTICIPANT_COLUMNS}, bill_id`, exact)
        .in('bill_id', ids)
        .order('joined_at', { ascending: true })
        .range(0, last),
      supabase.from('claims').select(`${CLAIM_COLUMNS}, bill_id`, exact).in('bill_id', ids).range(0, last),
      ...ledgerReads({ in: ids }, true),
    ]);
  } catch {
    return fail('network');
  }
  const failed = results.find((r) => r.error);
  if (failed) return fail(mapError('read', failed.error));
  if (results.some(isCutOff)) return fail('network');

  const [billsRes, rowsRes, participantsRes, claimsRes, payersRes, paymentsRes, flagsRes] = results;
  const wanted = new Set(ids);
  let rowsByBill: Map<string, unknown[]>;
  let participantsByBill: Map<string, unknown[]>;
  let claimsByBill: Map<string, unknown[]>;
  let payersByBill: Map<string, unknown[]>;
  let paymentsByBill: Map<string, unknown[]>;
  let flagsByBill: Map<string, unknown[]>;
  try {
    rowsByBill = groupByBill(rowsRes.data, wanted);
    participantsByBill = groupByBill(participantsRes.data, wanted);
    claimsByBill = groupByBill(claimsRes.data, wanted);
    payersByBill = groupByBill(payersRes.data, wanted);
    paymentsByBill = groupByBill(paymentsRes.data, wanted);
    flagsByBill = groupByBill(flagsRes.data, wanted);
  } catch {
    return fail('network');
  }

  // Bill rows, by id. An id seen twice is dropped (never guess which row is right).
  const billRows = new Map<string, unknown>();
  const repeated = new Set<string>();
  for (const raw of billsRes.data as unknown[]) {
    const id = isObject(raw) && isUuid(raw.id) && wanted.has(raw.id) ? raw.id : null;
    if (id === null) continue; // can't be attributed; its bill (if any) simply has no bill row
    if (billRows.has(id)) repeated.add(id);
    billRows.set(id, raw);
  }

  const bills = new Map<string, BillData>();
  for (const [id, raw] of billRows) {
    if (repeated.has(id)) continue;
    try {
      const bill = parseBill(raw);
      const rows = parseList(rowsByBill.get(id) ?? [], parseRow).sort(
        (a, b) => a.group_position - b.group_position || a.unit_index - b.unit_index,
      );
      bills.set(id, {
        bill,
        rows,
        claims: parseList(claimsByBill.get(id) ?? [], parseClaim),
        ...parsePeople(bill, {
          participants: participantsByBill.get(id) ?? [],
          payers: payersByBill.get(id) ?? [],
          payments: paymentsByBill.get(id) ?? [],
          flags: flagsByBill.get(id) ?? [],
        }),
      });
    } catch {
      // This bill alone is left out (Home shows no settle marker for it).
    }
  }
  return { ok: true, bills };
}

/**
 * How many people are on each bill, for Home's rows ("4 people"): one read of bill_participants'
 * `bill_id` column only, under its existing RLS (participants see every row of their own bills).
 * Spec: docs/specs/2026-11-26-home-mobile-refresh.md (D6; Task 1).
 *
 * - `[]` makes no request. More than 20 ids, or an id that isn't a UUID: invalid_bill, no request
 *   (the fetchSettleData guard). Repeated ids are sent once.
 * - The same cut-off rule as fetchSettleData (isCutOff): network, so a cut list never undercounts.
 * - Any row that isn't an object with a requested UUID bill_id fails the whole call (network).
 * - A requested bill with no rows (RLS hid it, or it has none) is absent from `counts`, never 0.
 * - Errors go through mapError('read', ...); a thrown call is network. Never throws.
 */
export async function fetchPeopleCounts(
  billIds: readonly string[],
): Promise<BillResult<{ counts: Map<string, number> }>> {
  if (billIds.length > SETTLE_DATA_MAX_BILLS || !billIds.every(isUuid)) return fail('invalid_bill');
  const ids = [...new Set(billIds)];
  if (ids.length === 0) return { ok: true, counts: new Map() };
  let result: CountedRaw;
  try {
    result = await supabase
      .from('bill_participants')
      .select('bill_id', { count: 'exact' })
      .in('bill_id', ids)
      .range(0, SETTLE_DATA_ROW_CAP - 1);
  } catch {
    return fail('network');
  }
  if (result.error) return fail(mapError('read', result.error));
  if (isCutOff(result)) return fail('network');
  const wanted = new Set(ids);
  const counts = new Map<string, number>();
  for (const row of result.data as unknown[]) {
    if (!isObject(row) || !isUuid(row.bill_id) || !wanted.has(row.bill_id)) return fail('network');
    counts.set(row.bill_id, (counts.get(row.bill_id) ?? 0) + 1);
  }
  return { ok: true, counts };
}
