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
import type { ExtrasMode } from './split';
import { supabase } from './supabase';
import { VENMO_USERNAME_PATTERN } from './venmo';

export type BillError =
  | 'invalid_code'
  | 'not_found'
  | 'not_allowed'
  | 'invalid_bill'
  | 'claimers_changed'
  | 'marks_changed' // set_payer: the number of "I paid" marks changed since the confirm was shown
  | 'payer_changed' // mark_paid: the person getting paid changed since the screen loaded
  | 'not_complete' // mark_paid: an item is unclaimed again (rule C1)
  | 'not_linked' // add_participant: you haven't split a bill with them (rule L1)
  | 'cannot_remove' // remove_participant: they have a claim or a mark, or are the host or payer (rule L3)
  | 'cannot_leave' // leave_bill: you have a claim or a mark, or are the host or payer (rule L3)
  | 'mark_changed' // settle_difference: the "I paid" mark isn't the one the screen showed (stale token)
  | 'network';

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
/** One person's "I paid" (M3 D1): the amount the screen showed (rule C2) and when they tapped it. */
export type BillMark = { cents: number; at: string };
/**
 * A participant as fetchBill returns them: the name plus what settling needs. `venmoUsername` is
 * null or matches VENMO_USERNAME_PATTERN; `mark` is null (not marked) or both fields set.
 */
export type BillMember = BillParticipant & { venmoUsername: string | null; mark: BillMark | null };

export type BillData = {
  bill: BillRecord;
  /** Ordered by group_position, then unit_index. */
  rows: BillRow[];
  /** Ordered by joined_at. */
  participants: BillMember[];
  claims: BillClaim[];
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
const PARTICIPANT_COLUMNS =
  'user_id, joined_at, settled_at, settled_cents, profile:profiles!bill_participants_user_id_fkey(display_name, venmo_username)';
const CLAIM_COLUMNS = 'line_item_id, user_id, parts';

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
  | 'mark_paid'
  | 'settle_difference'
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
  mark_paid: {},
  settle_difference: {}, // 22023 has several meanings: see ERRORS_BY_MESSAGE
  unmark_paid: {}, // 42501 only
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
  set_item_split: {
    // The claimer set changed since the screen loaded: the client refetches.
    '22023': { claimers_changed: 'claimers_changed', invalid_parts: 'invalid_bill' },
  },
  // M3 C3. Only the messages each function raises are allowed; anything else is 'network'.
  set_payer: {
    '22023': { marks_changed: 'marks_changed', not_participant: 'invalid_bill' },
  },
  mark_paid: {
    '22023': {
      invalid_amount: 'invalid_bill',
      payer_changed: 'payer_changed',
      is_payer: 'invalid_bill',
      not_complete: 'not_complete',
      // Settle early, rule Z (D3 step 6): the app never offers "I paid" there, so it's a stale screen.
      all_zero: 'invalid_bill',
    },
  },
  // Settle early and differences D4. mark_changed is the stale-token answer (refetch and look again).
  settle_difference: {
    '22023': {
      invalid_amount: 'invalid_bill',
      payer_changed: 'payer_changed',
      all_zero: 'invalid_bill',
      not_complete: 'not_complete',
      mark_changed: 'mark_changed',
    },
  },
  // People and invites D7: one message each.
  add_participant: { '22023': { not_linked: 'not_linked' } },
  remove_participant: { '22023': { cannot_remove: 'cannot_remove' } },
  leave_bill: { '22023': { cannot_leave: 'cannot_leave' } },
};

function mapError(op: DbFunction | 'read', error: unknown): BillError {
  const fields = typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown }) : {};
  const code = fields.code;
  if (typeof code !== 'string') return 'network';
  if (code === '42501') return 'not_allowed';
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
  } catch {
    return { error: 'network' };
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

/** D1: both mark columns null (not marked), or a timestamp plus cents per rule C2. Anything else is malformed. */
function parseMark(settledAt: unknown, settledCents: unknown): BillMark | null {
  if (settledAt === null && settledCents === null) return null;
  if (!isTimestamp(settledAt) || !isSettleCents(settledCents)) throw new Malformed();
  return { cents: settledCents, at: settledAt };
}

function parseParticipant(v: unknown): BillMember {
  if (!isObject(v)) throw new Malformed();
  return {
    userId: check(isUuid(v.user_id), v.user_id as string),
    displayName: parseDisplayName(v.profile),
    venmoUsername: parseVenmoUsername(v.profile),
    mark: parseMark(v.settled_at, v.settled_cents),
  };
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

/**
 * set_payer: host only. Changes who gets paid and clears every "I paid" mark on the bill.
 * `expectedCleared` is the number of marks the confirm showed; if the bill has a different number
 * now, nothing changes and the result is marks_changed (refetch and ask again). Setting the current
 * payer is a no-op in the database (marks kept, no event).
 */
export async function setPayer(billId: string, payerId: string, expectedCleared: number): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(payerId) || !isInt(expectedCleared) || expectedCleared < 0) return fail('invalid_bill');
  const res = await callRpc('set_payer', {
    p_bill_id: billId,
    p_payer_id: payerId,
    p_expected_cleared: expectedCleared,
  });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * mark_paid: "I paid" for yourself. `payerId` and `cents` are what the screen showed. Cents outside
 * rule C2 (an integer 1–99,999,999) are refused here with no network call. The database refuses a
 * changed payer (payer_changed) or an incomplete bill (not_complete); marking again is a no-op that
 * keeps the first amount.
 */
export async function markPaid(billId: string, payerId: string, cents: number): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(payerId) || !isSettleCents(cents)) return fail('invalid_bill');
  const res = await callRpc('mark_paid', { p_bill_id: billId, p_payer_id: payerId, p_cents: cents });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * settle_difference (D4): records a paid difference on `userId`'s "I paid" mark. `payerId` is the
 * payer the screen showed; `expectedCents` is the mark the screen showed (the stale-state token,
 * 1–99,999,999); `newCents` is the new net amount (0–99,999,999, never equal to the token).
 * Raising (newCents > expectedCents) is for the person themself; lowering is for the payer, and 0
 * clears the mark (A1.1). Bad amounts are refused here with invalid_bill and no network call. The
 * database refuses a changed mark (mark_changed), payer (payer_changed) or an incomplete bill
 * (not_complete); a retry whose result is already stored succeeds with no second event (A1.3).
 */
export async function settleDifference(
  billId: string,
  userId: string,
  payerId: string,
  expectedCents: number,
  newCents: number,
): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId) || !isUuid(payerId)) return fail('invalid_bill');
  // The new amount may be 0 (paid back in full, which clears the mark), up to the C2 maximum.
  const newOk = isInt(newCents) && newCents >= 0 && newCents <= SETTLE_MAX_CENTS;
  if (!isSettleCents(expectedCents) || !newOk || newCents === expectedCents) return fail('invalid_bill');
  const res = await callRpc('settle_difference', {
    p_bill_id: billId,
    p_user_id: userId,
    p_payer_id: payerId,
    p_expected_cents: expectedCents,
    p_new_cents: newCents,
  });
  return 'error' in res ? fail(res.error) : { ok: true };
}

/**
 * unmark_paid: clears `userId`'s mark. Allowed for the host, the person themself and the payer (Q4);
 * anyone else gets not_allowed. An unmarked or non-participant target is a no-op.
 */
export async function unmarkPaid(billId: string, userId: string): Promise<BillResult> {
  if (!isUuid(billId)) return fail('not_found');
  if (!isUuid(userId)) return fail('invalid_bill');
  const res = await callRpc('unmark_paid', { p_bill_id: billId, p_user_id: userId });
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
 * The bill (with its payer), its unit rows (ordered by group_position, unit_index), participants
 * with display names and Venmo usernames (null when unset or hidden) and their "I paid" marks, and
 * all claims. A non-UUID id, or a bill RLS doesn't return, is
 * not_found; a non-UUID id makes no query.
 */
export async function fetchBill(id: string): Promise<BillResult<BillData>> {
  if (!isUuid(id)) return fail('not_found');
  let results: [Raw, Raw, Raw, Raw];
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
    ]);
  } catch {
    return fail('network');
  }
  const failed = results.find((r) => r.error);
  if (failed) return fail(mapError('read', failed.error));

  const [billRes, rowsRes, participantsRes, claimsRes] = results;
  if (billRes.data === null || billRes.data === undefined) return fail('not_found');
  try {
    const bill = parseBill(billRes.data);
    const rows = parseList(rowsRes.data, parseRow).sort(
      (a, b) => a.group_position - b.group_position || a.unit_index - b.unit_index,
    );
    return {
      ok: true,
      bill,
      rows,
      participants: parseList(participantsRes.data, parseParticipant),
      claims: parseList(claimsRes.data, parseClaim),
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
 * The same BillData fetchBill returns, for up to 20 bills in four requests (bills, line_items,
 * bill_participants, claims), for Home's settle markers. Each request names the fetchBill columns
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
 * The four requests are four transactions, so a host edit between them can mislabel a bill until
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
  let results: [CountedRaw, CountedRaw, CountedRaw, CountedRaw];
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
    ]);
  } catch {
    return fail('network');
  }
  const failed = results.find((r) => r.error);
  if (failed) return fail(mapError('read', failed.error));
  const cutOff = (r: CountedRaw) =>
    !Array.isArray(r.data) ||
    typeof r.count !== 'number' ||
    r.data.length < r.count ||
    r.data.length >= SETTLE_DATA_ROW_CAP;
  if (results.some(cutOff)) return fail('network');

  const [billsRes, rowsRes, participantsRes, claimsRes] = results;
  const wanted = new Set(ids);
  let rowsByBill: Map<string, unknown[]>;
  let participantsByBill: Map<string, unknown[]>;
  let claimsByBill: Map<string, unknown[]>;
  try {
    rowsByBill = groupByBill(rowsRes.data, wanted);
    participantsByBill = groupByBill(participantsRes.data, wanted);
    claimsByBill = groupByBill(claimsRes.data, wanted);
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
        participants: parseList(participantsByBill.get(id) ?? [], parseParticipant),
        claims: parseList(claimsByBill.get(id) ?? [], parseClaim),
      });
    } catch {
      // This bill alone is left out (Home shows no settle marker for it).
    }
  }
  return { ok: true, bills };
}
