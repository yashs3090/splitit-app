// Data layer for groups: one wrapper per database function of T2–T7, the strict group_snapshot
// parser, and the two table reads (group Activity, a bill's group).
// Spec: docs/specs/2026-11-26-groups-mvp.md (T9, C-G4..C-G12) as amended by Amendment A1 (A1.6,
// A1.7, A1.11). Written against the spec's function contracts before the migrations were applied;
// T12 reconciles this file against the live database.
//
// Same rules as lib/bills.ts:
// - Every call returns { ok: true, ... } or { ok: false, error: GroupError }. Never throws.
// - Errors are mapped from the SQLSTATE, and for 22023 from the function's fixed message, against an
//   allow-list per function. Server text (message, details, hint) never leaves this file. Anything
//   unexpected (no SQLSTATE, an unknown one, an unlisted message, a throw, a malformed response) is
//   'network'. `invalid_code` is P0002 (join_group); every other refusal is 22023 or 42501.
// - Every read names its columns (profiles has column-level grants; lessons 2026-11-24).
// - Arguments a screen could get wrong are checked here first and refused with no request.
//
// The snapshot parser fails closed: any value out of range, any id that isn't a lowercase uuid, any
// reference to someone who isn't a member, any expense whose shares don't add up, and any input
// groupBalances refuses makes the whole read 'network'. A partial balance is never shown.
import { TIMED_OUT, within } from './asyncTimeout';
// Delete group A3: the lock-clash codes and copy are defined once, in lib/bills.ts (import only).
import { BUSY_COPY, BUSY_SQLSTATES, isBusyError } from './bills';
import { GROUP_CLAIM_COPY } from './groupClaimStatus';
import { groupBalances, type GroupBalanceInput } from './groupBalance';
import {
  EXPENSE_MAX_CENTS,
  EXPENSE_MIN_CENTS,
  EXPENSE_TITLE_MAX,
  normalizeTitle,
  type ExpensePayload,
  type ExpenseShare,
  type SplitMethod,
} from './groupExpense';
import { isSettleCents } from './paylinks';
import { isPaymentMethod, type PaymentMethod } from './paymentMethods';
import { normalizeGroupCode } from './pendingInvite';
import type { ExtrasMode, RowKind, SplitClaim, SplitItem } from './split';
import { supabase } from './supabase';
import { VENMO_USERNAME_PATTERN } from './venmo';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type GroupError =
  | 'not_allowed' // 42501: signed out, not a member, not the creator/payer/host, or anon
  | 'invalid_code' // P0002 join_group: no group has this code (or it was rotated)
  | 'invalid_name' // C-G8
  | 'invalid_expense' // C-G6
  | 'invalid_shares' // C-G4 / C-G5
  | 'not_member' // a payer, share user or payment party who isn't a current member
  | 'id_conflict' // a client id reused with other content (A1.6)
  | 'version_changed' // edit/delete_expense: stale expected version
  | 'cannot_leave' // C-G10
  | 'already_in_group' // attach: the bill is in another group
  | 'participants_not_members' // attach: someone on the bill isn't in the group
  | 'has_bill_payments' // detach: payments made from its old marks are still live (GR-9)
  | 'in_group' // T5 triggers on bill_participants
  | 'claims_changed' // assign_item: stale p_expected, or a target left meanwhile (A1.6)
  | 'invalid_parts' // assign_item: badly shaped p_parts
  | 'invalid_amount' // record_payment: cents outside 1..99,999,999 (C-G7)
  | 'invalid_payment' // record_payment: from = to, an unknown method, or a method/source pair A2.1 doesn't allow
  | 'not_complete' // attach: a bill with marks that isn't fully claimed, or all-$0 (A1, S1b)
  | 'group_full' // join_group: 50 members (A1, S5)
  | 'split_paying' // attach: the bill has more than one payer (who-paid B5f, 20261127140002_who_paid.sql)
  | 'has_claims' // set_not_part: the caller has a claim on the bill (group claim status C3)
  | 'not_in_group' // set_not_part(true): the bill isn't in a group (C3)
  // Delete group (docs/specs/2026-11-28-delete-group.md, A2). A deleted group has no rows left, so
  // it reads as not_allowed like "not a member" (A2.9); there is no group_deleted.
  | 'group_changed' // delete_group: the money fingerprint is stale (contract F), or a 23503 in its deletes (A2.12)
  | 'receipts_waiting' // delete_group: a receipt of the group is waiting (contract W)
  // A3.1: Postgres aborted the call in a lock clash (BUSY_SQLSTATES). Nothing was written; a manual
  // retry is safe. For every group function, reads included.
  | 'busy'
  | 'network';

export type GroupResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: GroupError };

/** Generic fixed copy. Screens may use more specific copy for their context (see the spec). */
export const GROUP_ERROR_COPY: Record<GroupError, string> = {
  not_allowed: "You can't make that change.",
  invalid_code: "This link doesn't work anymore. Ask for a new one.",
  invalid_name: 'Give the group a name of up to 60 characters.',
  invalid_expense: 'Check the title and amount and try again.',
  invalid_shares: "The amounts don't add up. Check them and try again.",
  not_member: 'Someone in this expense or payment is no longer in the group. Check and try again.',
  id_conflict: 'That was already saved differently. Refresh and check before trying again.',
  version_changed: 'Someone just changed this expense. Check it and try again.',
  cannot_leave: "You can't leave this group because you're part of its costs. You can hide it instead.",
  already_in_group: 'This bill is already in another group.',
  participants_not_members: 'Everyone on the bill has to be in the group first.',
  has_bill_payments: 'Undo the payments that came from this bill\'s "I paid" marks first.',
  in_group: "This bill is in a group. Ask for the group's link.",
  claims_changed: 'Someone changed this item. Check and try again.',
  invalid_parts: "Couldn't save that split. Check it and try again.",
  invalid_amount: 'Enter an amount from $0.01 to $999,999.99.',
  invalid_payment: "Couldn't record that payment. Check who paid whom.",
  not_complete: 'Finish claiming before moving it into the group.',
  group_full: 'This group is full (50 people).',
  split_paying: 'This bill has more than one payer. Groups need one payer per bill.',
  // Group claim status C6: one definition, in lib/groupClaimStatus.ts.
  has_claims: GROUP_CLAIM_COPY.hasClaims,
  not_in_group: GROUP_CLAIM_COPY.notInGroup,
  // Delete group C11 (= C6) and C12 (= C2a). lib/groupScreenText.ts reads these; one definition each.
  group_changed: 'Something in this group just changed. Check it and try again.',
  receipts_waiting: 'Every receipt has to be fully claimed before you can delete this group.',
  busy: BUSY_COPY,
  network: 'Something went wrong. Check your connection and try again.',
};

type DbFunction =
  | 'create_group'
  | 'join_group'
  | 'rename_group'
  | 'rotate_group_code'
  | 'set_group_hidden'
  | 'my_groups'
  | 'add_expense'
  | 'edit_expense'
  | 'delete_expense'
  | 'record_payment'
  | 'undo_payment'
  | 'attach_bill_to_group'
  | 'detach_bill_from_group'
  | 'leave_group'
  | 'assign_item'
  | 'group_snapshot'
  | 'set_not_part'
  | 'delete_group';

/**
 * 22023 messages each function raises (the message is the code, as in the existing functions; an
 * exact match, anything else is 'network'). 42501 is common to all and matched on the SQLSTATE.
 */
const MESSAGES_22023: Record<DbFunction, readonly GroupError[]> = {
  create_group: ['invalid_name', 'id_conflict'],
  join_group: ['group_full'],
  rename_group: ['invalid_name'],
  rotate_group_code: [],
  set_group_hidden: [],
  my_groups: [],
  add_expense: ['invalid_expense', 'invalid_shares', 'not_member', 'id_conflict'],
  edit_expense: ['invalid_expense', 'invalid_shares', 'not_member', 'version_changed'],
  delete_expense: ['version_changed'],
  record_payment: ['invalid_amount', 'invalid_payment', 'not_member', 'id_conflict'],
  undo_payment: [],
  // in_group: the T5 BEFORE INSERT trigger on bill_participants, if a member insert ever reaches it.
  attach_bill_to_group: ['already_in_group', 'participants_not_members', 'not_complete', 'in_group', 'split_paying'],
  detach_bill_from_group: ['has_bill_payments'],
  leave_group: ['cannot_leave'],
  assign_item: ['invalid_parts', 'claims_changed'],
  group_snapshot: [],
  set_not_part: ['has_claims', 'not_in_group'],
  delete_group: ['group_changed', 'receipts_waiting'],
};

/**
 * Other SQLSTATEs, by code only. P0002 is join_group's invalid_code. 23503 (a foreign key check
 * failed because someone left meanwhile) is mapped by the database (A1.2, A1.6); it is also mapped
 * here so the screen refetches if one ever reaches the client unmapped.
 */
const OTHER_CODES: Partial<Record<DbFunction, Readonly<Record<string, GroupError>>>> = {
  join_group: { P0002: 'invalid_code' },
  leave_group: { '23503': 'cannot_leave' },
  assign_item: { '23503': 'claims_changed' },
  // A2.12: the DB maps a 23503 in its deletes to 22023 group_changed; an unmapped one reads the same.
  delete_group: { '23503': 'group_changed' },
};

function mapError(fn: DbFunction | 'read', error: unknown): GroupError {
  const fields = isObject(error) ? error : {};
  const code = fields.code;
  if (typeof code !== 'string') return 'network';
  // A3.1: before every per-function map, reads included.
  if (isBusyError(error)) return 'busy';
  if (code === '42501') return 'not_allowed';
  if (fn === 'read') return 'network';
  if (code === '22023') {
    const message = fields.message;
    const allowed = MESSAGES_22023[fn];
    return typeof message === 'string' && (allowed as readonly string[]).includes(message) ? (message as GroupError) : 'network';
  }
  return OTHER_CODES[fn]?.[code] ?? 'network';
}

function fail(error: GroupError): { ok: false; error: GroupError } {
  return { ok: false, error };
}

/**
 * How long a group rpc (every write, and the group_snapshot read) may take before it counts as
 * 'network' (review R2, GR-RV-2). Safe for writes because each one carries its client id, so the
 * retry after a lost answer is a no-op on the server. Starting guess; see docs/before-production.md.
 * The native Pay record keeps its own, shorter limit (GROUP_SEND_RECORD_TIMEOUT_MS, 4 s).
 */
export const GROUP_REQUEST_TIMEOUT_MS = 15_000;

/** Runs an rpc; returns its data, or a mapped error. Never throws; gives up after GROUP_REQUEST_TIMEOUT_MS. */
async function callRpc(fn: DbFunction, args: Record<string, unknown>): Promise<{ data: unknown } | { error: GroupError }> {
  try {
    // supabase.rpc returns a thenable builder; Promise.resolve makes it a Promise for `within`.
    const res = await within(Promise.resolve(supabase.rpc(fn, args)), GROUP_REQUEST_TIMEOUT_MS);
    if (res === TIMED_OUT) return { error: 'network' };
    const { data, error } = res;
    if (error) return { error: mapError(fn, error) };
    return { data: data as unknown };
  } catch (thrown) {
    return { error: thrownError(thrown) };
  }
}

/** A thrown or rejected call: busy for a lock-clash code (A3.3), else network. Never the server's text. */
function thrownError(thrown: unknown): GroupError {
  return isBusyError(thrown) ? 'busy' : 'network';
}

async function callVoid(fn: DbFunction, args: Record<string, unknown>): Promise<GroupResult> {
  const res = await callRpc(fn, args);
  return 'error' in res ? fail(res.error) : { ok: true };
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

/**
 * Lowercase canonical uuids only (A1.7): the database's uuid::text is lowercase, and the C-G4 sort
 * (user id in code-unit order) assumes it. Used for arguments too, since they come from the snapshot.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Contract F: md5 hex, as delete_group checks it (`^[0-9a-f]{32}$`). */
const MONEY_FINGERPRINT_RE = /^[0-9a-f]{32}$/;
const JOIN_CODE_RE = /^[0-9a-f]{20}$/;
/** C-G8: a group name is 1..60 code points after normalizeTitle (A1.12, GR-T8-6). */
export const GROUP_NAME_MAX = 60;
/** assign_item parts, as set_item_split's (C-G12). */
const MIN_PARTS = 1;
const MAX_PARTS = 20;
/** C-G4: equal splits are among at most 50 members; joins are capped at 50 (A1, S5). */
const MAX_EQUAL_USERS = 50;
/** fetchGroupEvents reads the newest 100 (T9). */
export const GROUP_EVENTS_LIMIT = 100;
/**
 * PostgREST cuts set-returning results at max_rows without an error (1000 locally; lessons
 * 2026-11-25). my_groups() returns one row per group the caller is in, so 1,000 rows or more could
 * be a cut list: fail closed.
 */
const MY_GROUPS_ROW_CAP = 1000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isIntIn = (v: unknown, min: number, max: number): v is number => isInt(v) && v >= min && v <= max;
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isExtrasMode = (v: unknown): v is ExtrasMode => v === 'proportional' || v === 'equal';
const isSplitMethod = (v: unknown): v is SplitMethod => v === 'equal' || v === 'exact';
const isExpenseCents = (v: unknown): v is number => isIntIn(v, EXPENSE_MIN_CENTS, EXPENSE_MAX_CENTS);
const codePoints = (s: string): number => Array.from(s).length;
const isTextOf = (v: unknown, max: number): v is string => isString(v) && codePoints(v) >= 1 && codePoints(v) <= max;
const isVenmoUsernameOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && VENMO_USERNAME_PATTERN.test(v));

class Malformed extends Error {}

function check<T>(ok: boolean, value: T): T {
  if (!ok) throw new Malformed();
  return value;
}

/** Each element parsed; a duplicate `key` anywhere in the list is malformed. */
function parseUniqueList<T>(v: unknown, parse: (x: unknown) => T, key: (t: T) => string | number): T[] {
  if (!Array.isArray(v)) throw new Malformed();
  const out = v.map(parse);
  if (new Set(out.map(key)).size !== out.length) throw new Malformed();
  return out;
}

/** A map uuid → parts 1..20 (assign_item's p_parts / p_expected, and snapshot row claims). */
function isPartsMap(v: unknown): v is Record<string, number> {
  return isObject(v) && Object.entries(v).every(([k, p]) => isUuid(k) && isIntIn(p, MIN_PARTS, MAX_PARTS));
}

// ---------------------------------------------------------------------------
// Client ids (A1.6): a retry reuses its id; a new intent gets a new one.
// ---------------------------------------------------------------------------

type CryptoLike = { randomUUID?: () => string; getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T };

/**
 * A new lowercase v4 uuid for create_group, add_expense and record_payment. Uses
 * `crypto.randomUUID`, else `crypto.getRandomValues`, else Math.random (verify on Hermes which one
 * the native build has). The id is an idempotency key, not a secret: a guessed id can only make the
 * guesser's own write fail with id_conflict, or make ours fail the same way (decisions GR-T9-3).
 */
export function newClientId(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type IntentId = {
  /**
   * The client id for this intent. The same `key` (e.g. the trimmed group name, or
   * "to|cents|method|source"; one per Pay tap, reused by its retries and the "Did you send…?" Yes)
   * gets the same id until `done()`, so a retry after a lost response is a no-op on the server
   * instead of a second row. A different key gets a new id.
   */
  idFor(key: string): string;
  /** Call after a success: the next save is a new intent with a new id (A1.6, C-G7). */
  done(): void;
};

/** One per form (keep it in a ref). `makeId` is for tests. */
export function createIntentId(makeId: () => string = newClientId): IntentId {
  let current: { key: string; id: string } | null = null;
  return {
    idFor(key) {
      if (current === null || current.key !== key) current = { key, id: makeId() };
      return current.id;
    },
    done() {
      current = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Groups core (T2)
// ---------------------------------------------------------------------------

/** C-G8, for the name field: null when valid. Trims like the DB (normalizeTitle, A1.12). */
export function groupNameProblem(name: string): 'empty' | 'too_long' | null {
  const n = codePoints(normalizeTitle(name));
  if (n === 0) return 'empty';
  return n > GROUP_NAME_MAX ? 'too_long' : null;
}

/**
 * create_group(p_id, p_name): the caller becomes the only member. `clientId` comes from an
 * IntentId keyed on the trimmed name, so a retry after a lost response returns the same group
 * (A1.6). The database returns the id; anything but `clientId` is 'network'.
 */
export async function createGroup(name: string, clientId: string): Promise<GroupResult<{ groupId: string }>> {
  if (groupNameProblem(name) !== null) return fail('invalid_name');
  if (!isUuid(clientId)) return fail('network'); // a programming error: never sent
  const res = await callRpc('create_group', { p_id: clientId, p_name: normalizeTitle(name) });
  if ('error' in res) return fail(res.error);
  return res.data === clientId ? { ok: true, groupId: clientId } : fail('network');
}

/** join_group(p_code): idempotent. A malformed code fails locally with the same error as an unknown one. */
export async function joinGroup(code: string): Promise<GroupResult<{ groupId: string }>> {
  const valid = normalizeGroupCode(code);
  if (valid === null) return fail('invalid_code');
  const res = await callRpc('join_group', { p_code: valid });
  if ('error' in res) return fail(res.error);
  return isUuid(res.data) ? { ok: true, groupId: res.data } : fail('network');
}

/** rename_group: any member. The same trimmed name is a no-op in the database (A1, N4). */
export async function renameGroup(groupId: string, name: string): Promise<GroupResult> {
  if (!isUuid(groupId)) return fail('not_allowed');
  if (groupNameProblem(name) !== null) return fail('invalid_name');
  return callVoid('rename_group', { p_group_id: groupId, p_name: normalizeTitle(name) });
}

/** rotate_group_code: any member. The old link stops working; members stay in. */
export async function rotateGroupCode(groupId: string): Promise<GroupResult<{ joinCode: string }>> {
  if (!isUuid(groupId)) return fail('not_allowed');
  const res = await callRpc('rotate_group_code', { p_group_id: groupId });
  if ('error' in res) return fail(res.error);
  return typeof res.data === 'string' && JOIN_CODE_RE.test(res.data) ? { ok: true, joinCode: res.data } : fail('network');
}

/** set_group_hidden: the caller's own "Hide for me". Changes no shared row, logs no event. */
export async function setGroupHidden(groupId: string, hidden: boolean): Promise<GroupResult> {
  if (!isUuid(groupId) || !isBoolean(hidden)) return fail('not_allowed');
  return callVoid('set_group_hidden', { p_group_id: groupId, p_hidden: hidden });
}

/** One row of my_groups(), for Home's Groups section. */
export type GroupSummary = { id: string; name: string; memberCount: number; joinedAt: string; hidden: boolean };

function parseSummary(v: unknown): GroupSummary {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    name: check(isTextOf(v.name, GROUP_NAME_MAX), v.name as string),
    memberCount: check(isInt(v.member_count) && v.member_count >= 1, v.member_count as number),
    joinedAt: check(isTimestamp(v.joined_at), v.joined_at as string),
    hidden: check(isBoolean(v.hidden), v.hidden as boolean),
  };
}

/**
 * my_groups(): the caller's groups, hidden ones included (flagged), in the database's order
 * (joined_at desc, id). A repeated id, a malformed row or a possibly cut list is 'network'.
 */
export async function listMyGroups(): Promise<GroupResult<{ groups: GroupSummary[] }>> {
  const res = await callRpc('my_groups', {});
  if ('error' in res) return fail(res.error);
  try {
    const groups = parseUniqueList(res.data, parseSummary, (g) => g.id);
    if (groups.length >= MY_GROUPS_ROW_CAP) return fail('network');
    return { ok: true, groups };
  } catch {
    return fail('network');
  }
}

// ---------------------------------------------------------------------------
// Expenses (T3). The payload is lib/groupExpense.ts's expensePayload (T8).
// ---------------------------------------------------------------------------

/**
 * Only the five payload keys T3 takes, after shape checks the screen's validator already makes
 * (C-G4..C-G6). The database decides membership and Σ = amount; this refuses only values it would
 * refuse anyway, so a bad payload never makes a round trip.
 */
function payloadArgs(p: ExpensePayload): Record<string, unknown> | GroupError {
  const titleLength = isString(p.p_title) ? codePoints(normalizeTitle(p.p_title)) : 0;
  if (titleLength < 1 || titleLength > EXPENSE_TITLE_MAX) return 'invalid_expense';
  if (!isExpenseCents(p.p_amount_cents) || !isSplitMethod(p.p_method) || !isUuid(p.p_payer_id)) return 'invalid_expense';
  if (!isObject(p.p_shares)) return 'invalid_shares';
  const entries = Object.entries(p.p_shares);
  if (entries.length === 0 || !entries.every(([k]) => isUuid(k))) return 'invalid_shares';
  const valueOk =
    p.p_method === 'equal'
      ? (v: unknown) => v === 1
      : (v: unknown) => isIntIn(v, EXPENSE_MIN_CENTS, EXPENSE_MAX_CENTS);
  if (!entries.every(([, v]) => valueOk(v))) return 'invalid_shares';
  if (p.p_method === 'equal' && entries.length > MAX_EQUAL_USERS) return 'invalid_shares';
  return {
    p_title: normalizeTitle(p.p_title),
    p_payer_id: p.p_payer_id,
    p_amount_cents: p.p_amount_cents,
    p_method: p.p_method,
    p_shares: p.p_shares,
  };
}

/**
 * add_expense: any member. `id` comes from an IntentId (a retry with the same content is a no-op;
 * the same id with other content is id_conflict; a deleted expense's id stays deleted, A1.6).
 */
export async function addExpense(a: { id: string; groupId: string; payload: ExpensePayload }): Promise<GroupResult> {
  if (!isUuid(a.groupId)) return fail('not_allowed');
  if (!isUuid(a.id)) return fail('network');
  const args = payloadArgs(a.payload);
  if (typeof args === 'string') return fail(args);
  return callVoid('add_expense', { p_id: a.id, p_group_id: a.groupId, ...args });
}

/**
 * edit_expense: the creator or the current payer (C-G9). `expectedVersion` is the version the screen
 * loaded; a stale one is version_changed, unless the stored fields already equal these (a retry, A1.6).
 */
export async function editExpense(a: { id: string; expectedVersion: number; payload: ExpensePayload }): Promise<GroupResult> {
  if (!isUuid(a.id)) return fail('not_allowed');
  if (!isInt(a.expectedVersion) || a.expectedVersion < 1) return fail('version_changed');
  const args = payloadArgs(a.payload);
  if (typeof args === 'string') return fail(args);
  return callVoid('edit_expense', { p_id: a.id, p_expected_version: a.expectedVersion, ...args });
}

/** delete_expense: soft delete by the creator or the current payer. A repeat is a no-op. */
export async function deleteExpense(id: string, expectedVersion: number): Promise<GroupResult> {
  if (!isUuid(id)) return fail('not_allowed');
  if (!isInt(expectedVersion) || expectedVersion < 1) return fail('version_changed');
  return callVoid('delete_expense', { p_id: id, p_expected_version: expectedVersion });
}

// ---------------------------------------------------------------------------
// Payments (T4)
// ---------------------------------------------------------------------------

/**
 * How the record was made (Amendment A2.1; `method` is how the money was sent, lib/paymentMethods.ts):
 * `venmo_link` = the app opened a Venmo Pay link and recorded it (automatically or through "Did you
 * send…?" Yes); `manual` = Record a payment / "Got paid another way"; `bill_mark` = converted from a
 * bill's "I paid" mark at move-in (DB only). Clients send only `venmo_link` or `manual`.
 */
export type PaymentSource = 'venmo_link' | 'manual' | 'bill_mark';
export type ClientPaymentSource = Exclude<PaymentSource, 'bill_mark'>;

const isPaymentSource = (v: unknown): v is PaymentSource => v === 'venmo_link' || v === 'manual' || v === 'bill_mark';

/**
 * A2.1's allowed pairs: `venmo_link` → method `venmo` only; `manual` → any method; `bill_mark` → any
 * method (the mark's `settled_method`, or `other` for a pre-SV mark). The DB applies the same rule.
 */
export function isAllowedPaymentPair(method: unknown, source: unknown): boolean {
  if (!isPaymentMethod(method) || !isPaymentSource(source)) return false;
  return source === 'venmo_link' ? method === 'venmo' : true;
}

/**
 * record_payment (C-G7 as amended by A2.1): the caller is `from` or `to`; `method` and `source` must be
 * an allowed pair (isAllowedPaymentPair), and a client never sends `bill_mark`. The recipient's "Not
 * received" and the sender's "Didn't go through? Undo" are both undoPayment (A2.2): no other wrapper. `id` comes from an IntentId keyed on the
 * payment's content, so a retry is a no-op and an undone payment's id stays undone (A1.6).
 */
export async function recordPayment(a: {
  id: string;
  groupId: string;
  from: string;
  to: string;
  cents: number;
  method: PaymentMethod;
  source: ClientPaymentSource;
}): Promise<GroupResult> {
  if (!isUuid(a.groupId)) return fail('not_allowed');
  if (!isUuid(a.id)) return fail('network');
  if (!isSettleCents(a.cents)) return fail('invalid_amount');
  if (!isUuid(a.from) || !isUuid(a.to) || a.from === a.to) return fail('invalid_payment');
  // The type rules out 'bill_mark', but a caller's value isn't trusted at run time.
  const clientSources: readonly unknown[] = ['venmo_link', 'manual'];
  if (!clientSources.includes(a.source) || !isAllowedPaymentPair(a.method, a.source)) return fail('invalid_payment');
  return callVoid('record_payment', {
    p_id: a.id,
    p_group_id: a.groupId,
    p_from: a.from,
    p_to: a.to,
    p_cents: a.cents,
    p_method: a.method,
    p_source: a.source,
  });
}

/** undo_payment: `from` or `to` only (soft). A repeat is a no-op. */
export async function undoPayment(id: string): Promise<GroupResult> {
  if (!isUuid(id)) return fail('not_allowed');
  return callVoid('undo_payment', { p_id: id });
}

// ---------------------------------------------------------------------------
// Bills in groups and membership (T5)
// ---------------------------------------------------------------------------

/**
 * attach_bill_to_group: the bill's host, a member of the group. Marks become group payments (U-G1).
 * The same group again is a no-op success; another group is already_in_group (A1.6).
 */
export async function attachBillToGroup(billId: string, groupId: string): Promise<GroupResult> {
  if (!isUuid(billId) || !isUuid(groupId)) return fail('not_allowed');
  return callVoid('attach_bill_to_group', { p_bill_id: billId, p_group_id: groupId });
}

/** detach_bill_from_group: the host; refused while payments from its old marks are live (GR-9). */
export async function detachBillFromGroup(billId: string): Promise<GroupResult> {
  if (!isUuid(billId)) return fail('not_allowed');
  return callVoid('detach_bill_from_group', { p_bill_id: billId });
}

/** leave_group (C-G10): only with no history and not the last member; else cannot_leave. */
export async function leaveGroup(groupId: string): Promise<GroupResult> {
  if (!isUuid(groupId)) return fail('not_allowed');
  return callVoid('leave_group', { p_group_id: groupId });
}

/**
 * delete_group(p_group_id, p_fingerprint): any member, hard delete for everyone (delete group A2).
 * `fingerprint` is the `moneyFingerprint` of the snapshot on screen at the tap. The DB checks, in
 * order: member (42501) → locks → fingerprint (group_changed) → no waiting receipt
 * (receipts_waiting). A retry after a delete that went through finds no group: not_allowed, which
 * the screen reads as "the group is gone" (A2.11). A time-out is network (outcome unknown; a retry
 * is safe because the DB re-checks everything).
 */
export async function deleteGroup(groupId: string, fingerprint: string): Promise<GroupResult> {
  if (!isUuid(groupId)) return fail('not_allowed');
  if (!isString(fingerprint) || !MONEY_FINGERPRINT_RE.test(fingerprint)) return fail('group_changed');
  return callVoid('delete_group', { p_group_id: groupId, p_fingerprint: fingerprint });
}

// ---------------------------------------------------------------------------
// Assigning items (T7, C-G12)
// ---------------------------------------------------------------------------

/**
 * assign_item: any member sets the whole claimer set of one row of a group bill. `parts` is the new
 * map (member id → parts 1..20, `{}` = nobody); `expected` is the map the sheet showed. A stale
 * `expected` is claims_changed (refetch), unless the row already matches `parts` (a retry, A1.6).
 */
export async function assignItem(
  lineItemId: string,
  parts: Readonly<Record<string, number>>,
  expected: Readonly<Record<string, number>>,
): Promise<GroupResult> {
  if (!isUuid(lineItemId)) return fail('not_allowed');
  if (!isPartsMap(parts) || !isPartsMap(expected)) return fail('invalid_parts');
  return callVoid('assign_item', { p_line_item_id: lineItemId, p_parts: { ...parts }, p_expected: { ...expected } });
}

// ---------------------------------------------------------------------------
// group_snapshot (C-G11 as amended by A1.7)
// ---------------------------------------------------------------------------

export type SnapshotGroup = { id: string; name: string; joinCode: string; createdBy: string | null; createdAt: string };
export type SnapshotMember = { userId: string; displayName: string | null; venmoUsername: string | null; joinedAt: string };
/** `name` is null unless nobody has claimed the row (A1.7; for naming waiting rows, S9). */
export type SnapshotRow = { id: string; totalCents: number; kind: RowKind; name: string | null; claims: Record<string, number> };
export type SnapshotBill = {
  id: string;
  hostId: string;
  payerId: string;
  totalCents: number;
  extrasSplit: ExtrasMode;
  createdAt: string;
  /** In group_position, unit_index order. */
  rows: SnapshotRow[];
  /** Equals the member set (every member is on every group bill). */
  participantIds: string[];
};
export type SnapshotExpense = {
  id: string;
  title: string;
  payerId: string;
  amountCents: number;
  splitMethod: SplitMethod;
  createdBy: string;
  createdAt: string;
  editedAt: string | null;
  version: number;
  shares: ExpenseShare[];
};
export type SnapshotPayment = {
  id: string;
  from: string;
  to: string;
  cents: number;
  method: PaymentMethod;
  source: PaymentSource;
  recordedBy: string;
  billId: string | null;
  createdAt: string;
};
/**
 * GR-M6: a payment its recipient undid as "Not received" (recent, involving the viewer; T6 decides
 * which rows). The one definition: lib/groupSettleView.ts uses this type for the sender's "Dee
 * hasn't received your $X" notice.
 */
export type SnapshotNotReceived = { id: string; from: string; to: string; cents: number; method: PaymentMethod; undoneAt: string };

/**
 * Live rows only: deleted expenses and undone payments aren't in it, except the recipient-undone
 * payments in `notReceived` (GR-M6). Arrays keep the DB's order.
 */
export type GroupSnapshot = {
  group: SnapshotGroup;
  /**
   * The caller's own state. `notPartBillIds` are the bills of this snapshot the caller said "I
   * wasn't part of this" for (bill_not_part, group claim status C4), in bill_id order. Only ever the
   * caller's own; it changes no balance. A stale one (the caller has since claimed) is ignored by
   * billNeedsViewer, since claims win (C1).
   */
  me: { hidden: boolean; notPartBillIds: string[] };
  /** Ordered by joined_at, user_id. */
  members: SnapshotMember[];
  /** Ordered by created_at, id. */
  bills: SnapshotBill[];
  expenses: SnapshotExpense[];
  payments: SnapshotPayment[];
  /** From the snapshot's `not_received` array (required key; `[]` when there are none). */
  notReceived: SnapshotNotReceived[];
  /**
   * Delete group contract F: the snapshot's `money_fingerprint` (required; 32 lowercase hex). The
   * app never computes it; deleteGroup sends back exactly this string, and the DB refuses with
   * group_changed if the money state moved since this snapshot was read.
   */
  moneyFingerprint: string;
};

function parseGroup(v: unknown, groupId: string): SnapshotGroup {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(v.id === groupId, groupId),
    name: check(isTextOf(v.name, GROUP_NAME_MAX), v.name as string),
    joinCode: check(isString(v.join_code) && JOIN_CODE_RE.test(v.join_code), v.join_code as string),
    // The creator may have left since (only the shape is checked), and is null once their account
    // is deleted (groups.created_by is on delete set null, decisions GR-T2-5).
    createdBy: check(v.created_by === null || isUuid(v.created_by), v.created_by as string | null),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
  };
}

function parseMember(v: unknown): SnapshotMember {
  if (!isObject(v)) throw new Malformed();
  return {
    userId: check(isUuid(v.user_id), v.user_id as string),
    displayName: check(isStringOrNull(v.display_name), v.display_name as string | null),
    venmoUsername: check(isVenmoUsernameOrNull(v.venmo_username), v.venmo_username as string | null),
    joinedAt: check(isTimestamp(v.joined_at), v.joined_at as string),
  };
}

function parseRow(v: unknown, participants: ReadonlySet<string>): SnapshotRow {
  if (!isObject(v)) throw new Malformed();
  const cents = v.total_cents;
  // Claimable discounts (C1): an item is ≥ 0, a discount ≤ −1, as lib/bills.ts parseKind.
  const kindOk = (v.kind === 'item' && isInt(cents) && cents >= 0) || (v.kind === 'discount' && isInt(cents) && cents <= -1);
  const claims = check(isPartsMap(v.claims), v.claims as Record<string, number>);
  // S6: every claimer is on the bill.
  if (!Object.keys(claims).every((u) => participants.has(u))) throw new Malformed();
  const claimed = Object.keys(claims).length > 0;
  return {
    id: check(isUuid(v.id), v.id as string),
    totalCents: check(kindOk, cents as number),
    kind: v.kind as RowKind,
    name: check(claimed ? v.name === null : isString(v.name), v.name as string | null),
    claims: { ...claims },
  };
}

function parseBill(v: unknown, members: ReadonlySet<string>): SnapshotBill {
  if (!isObject(v)) throw new Malformed();
  // S6: participant_ids is exactly the member set (no repeats, nobody missing, nobody extra).
  const participantIds = parseUniqueList(v.participant_ids, (u) => check(isUuid(u), u as string), (u) => u);
  if (participantIds.length !== members.size || !participantIds.every((u) => members.has(u))) throw new Malformed();
  const participants = new Set(participantIds);
  return {
    id: check(isUuid(v.id), v.id as string),
    hostId: check(isUuid(v.host_id) && participants.has(v.host_id), v.host_id as string),
    payerId: check(isUuid(v.payer_id) && participants.has(v.payer_id), v.payer_id as string),
    totalCents: check(isInt(v.total_cents) && v.total_cents >= 0, v.total_cents as number),
    extrasSplit: check(isExtrasMode(v.extras_split), v.extras_split as ExtrasMode),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
    rows: parseUniqueList(v.rows, (r) => parseRow(r, participants), (r) => r.id),
    participantIds,
  };
}

function parseExpense(v: unknown, members: ReadonlySet<string>): SnapshotExpense {
  if (!isObject(v)) throw new Malformed();
  const method = check(isSplitMethod(v.split_method), v.split_method as SplitMethod);
  const amount = check(isExpenseCents(v.amount_cents), v.amount_cents as number);
  // Equal shares may be $0 (A3); exact shares are 1..99,999,999 (C-G5).
  const minShare = method === 'equal' ? 0 : EXPENSE_MIN_CENTS;
  const shares = parseUniqueList(
    v.shares,
    (s): ExpenseShare => {
      if (!isObject(s)) throw new Malformed();
      return {
        userId: check(isUuid(s.user_id) && members.has(s.user_id), s.user_id as string),
        cents: check(isIntIn(s.cents, minShare, EXPENSE_MAX_CENTS), s.cents as number),
      };
    },
    (s) => s.userId,
  );
  // S6: Σ shares = amount, exactly. Every share is ≤ 99,999,999 and there are ≤ 50, so no overflow.
  if (shares.length === 0 || shares.reduce((sum, s) => sum + s.cents, 0) !== amount) throw new Malformed();
  if (method === 'equal' && shares.length > MAX_EQUAL_USERS) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    title: check(isTextOf(v.title, EXPENSE_TITLE_MAX), v.title as string),
    payerId: check(isUuid(v.payer_id) && members.has(v.payer_id), v.payer_id as string),
    amountCents: amount,
    splitMethod: method,
    // (group_id, created_by) references group_members on delete restrict (T3), so the creator is a member.
    createdBy: check(isUuid(v.created_by) && members.has(v.created_by), v.created_by as string),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
    editedAt: check(v.edited_at === null || isTimestamp(v.edited_at), v.edited_at as string | null),
    version: check(isInt(v.version) && v.version >= 1, v.version as number),
    shares,
  };
}

function parsePayment(v: unknown, members: ReadonlySet<string>): SnapshotPayment {
  if (!isObject(v)) throw new Malformed();
  const member = (u: unknown): u is string => isUuid(u) && members.has(u);
  // A2.1: both axes are checked together; a pair the DB wouldn't store means the read is broken.
  if (!isAllowedPaymentPair(v.method, v.source)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    from: check(member(v.from_user), v.from_user as string),
    to: check(member(v.to_user) && v.to_user !== v.from_user, v.to_user as string),
    cents: check(isSettleCents(v.cents), v.cents as number),
    method: v.method as PaymentMethod,
    source: v.source as PaymentSource,
    recordedBy: check(member(v.recorded_by), v.recorded_by as string),
    // May name a bill that has since left the group or been deleted (on delete set null).
    billId: check(v.bill_id === null || isUuid(v.bill_id), v.bill_id as string | null),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
  };
}

/** An ISO 8601 date-time as Postgres renders timestamptz in JSON (e.g. 2026-11-26T10:00:00.123+00:00). */
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const isIsoTimestamp = (v: unknown): v is string => typeof v === 'string' && ISO_TIME_RE.test(v) && isTimestamp(v);

function parseNotReceived(v: unknown, members: ReadonlySet<string>): SnapshotNotReceived {
  if (!isObject(v)) throw new Malformed();
  const member = (u: unknown): u is string => isUuid(u) && members.has(u);
  return {
    id: check(isUuid(v.id), v.id as string),
    from: check(member(v.from), v.from as string),
    to: check(member(v.to) && v.to !== v.from, v.to as string),
    cents: check(isSettleCents(v.cents), v.cents as number),
    method: check(isPaymentMethod(v.method), v.method as PaymentMethod),
    undoneAt: check(isIsoTimestamp(v.undone_at), v.undone_at as string),
  };
}

function parseSnapshot(v: unknown, groupId: string): GroupSnapshot {
  if (!isObject(v) || !isObject(v.me)) throw new Malformed();
  const members = parseUniqueList(v.members, parseMember, (m) => m.userId);
  if (members.length === 0) throw new Malformed(); // the caller is always a member
  const memberIds = new Set(members.map((m) => m.userId));
  const bills = parseUniqueList(v.bills, (b) => parseBill(b, memberIds), (b) => b.id);
  // A row id belongs to one bill: a repeat across bills means the snapshot is broken.
  const rowIds = bills.flatMap((b) => b.rows.map((r) => r.id));
  if (new Set(rowIds).size !== rowIds.length) throw new Malformed();
  // C4: required; each id a lowercase uuid naming one of this snapshot's bills, no repeats.
  const billIds = new Set(bills.map((b) => b.id));
  const notPartBillIds = parseUniqueList(v.me.not_part_bill_ids, (id) => check(isUuid(id) && billIds.has(id), id as string), (id) => id);
  return {
    group: parseGroup(v.group, groupId),
    me: { hidden: check(isBoolean(v.me.hidden), v.me.hidden as boolean), notPartBillIds },
    members,
    bills,
    expenses: parseUniqueList(v.expenses, (e) => parseExpense(e, memberIds), (e) => e.id),
    payments: parseUniqueList(v.payments, (p) => parsePayment(p, memberIds), (p) => p.id),
    notReceived: parseUniqueList(v.not_received, (r) => parseNotReceived(r, memberIds), (r) => r.id),
    moneyFingerprint: check(isString(v.money_fingerprint) && MONEY_FINGERPRINT_RE.test(v.money_fingerprint), v.money_fingerprint as string),
  };
}

/** The snapshot as lib/groupBalance.ts's input (C-G1, C-G2). Rows keep their order; claims are per row. */
export function balanceInputOf(s: GroupSnapshot): GroupBalanceInput {
  return {
    members: s.members.map((m) => m.userId),
    bills: s.bills.map((b) => {
      const items: SplitItem[] = b.rows.map((r) => ({ id: r.id, totalCents: r.totalCents, kind: r.kind }));
      const claims: SplitClaim[] = b.rows.flatMap((r) =>
        Object.entries(r.claims).map(([userId, parts]) => ({ itemId: r.id, userId, parts })),
      );
      return {
        id: b.id,
        payerId: b.payerId,
        totalCents: b.totalCents,
        split: { totalCents: b.totalCents, items, claims, participantIds: [...b.participantIds], extrasMode: b.extrasSplit },
      };
    }),
    expenses: s.expenses.map((e) => ({ id: e.id, payerId: e.payerId, amountCents: e.amountCents, shares: e.shares.map((x) => ({ ...x })) })),
    payments: s.payments.map((p) => ({ from: p.from, to: p.to, cents: p.cents })),
  };
}

/**
 * group_snapshot(p_group_id): the one read for the group screens. Members only (42501 →
 * not_allowed). Parsed strictly (C-G11 + A1.7 + S6), then run once through groupBalances: if the
 * balances can't be computed (RangeError), the snapshot is broken and the result is 'network'.
 */
export async function fetchGroupSnapshot(groupId: string): Promise<GroupResult<{ snapshot: GroupSnapshot }>> {
  if (!isUuid(groupId)) return fail('not_allowed');
  const res = await callRpc('group_snapshot', { p_group_id: groupId });
  if ('error' in res) return fail(res.error);
  try {
    const snapshot = parseSnapshot(res.data, groupId);
    groupBalances(balanceInputOf(snapshot)); // throws RangeError on anything it can't add up
    return { ok: true, snapshot };
  } catch {
    return fail('network');
  }
}

// ---------------------------------------------------------------------------
// Table reads (RLS: members only)
// ---------------------------------------------------------------------------

type Raw = { data: unknown; error: unknown };

/** One group_events row. `kind` and `details` are data: lib/groupActivityText.ts (T10) decides what shows. */
export type GroupEvent = { id: string; seq: number; actorId: string | null; kind: string; details: unknown; createdAt: string };

function parseEvent(v: unknown): GroupEvent {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    seq: check(isInt(v.seq) && v.seq >= 1, v.seq as number),
    actorId: check(v.actor_id === null || isUuid(v.actor_id), v.actor_id as string | null),
    kind: check(isString(v.kind) && v.kind !== '', v.kind as string),
    details: check(v.details !== undefined, v.details),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
  };
}

/**
 * The newest GROUP_EVENTS_LIMIT group events, ordered by `seq` desc only (A1, N2: created_at is the
 * transaction start, so it can't order events from one call). A non-member gets no rows (RLS), which
 * reads as an empty list. Rows out of seq order, or more than the limit, are 'network'.
 */
export async function fetchGroupEvents(groupId: string): Promise<GroupResult<{ events: GroupEvent[] }>> {
  if (!isUuid(groupId)) return fail('not_allowed');
  let res: Raw;
  try {
    res = await supabase
      .from('group_events')
      .select('id, seq, actor_id, kind, details, created_at')
      .eq('group_id', groupId)
      .order('seq', { ascending: false })
      .limit(GROUP_EVENTS_LIMIT);
  } catch (thrown) {
    return fail(thrownError(thrown));
  }
  if (res.error) return fail(mapError('read', res.error));
  try {
    const events = parseUniqueList(res.data, parseEvent, (e) => e.id);
    if (events.length > GROUP_EVENTS_LIMIT) return fail('network');
    for (let i = 1; i < events.length; i++) {
      if ((events[i]?.seq ?? 0) >= (events[i - 1]?.seq ?? 0)) return fail('network');
    }
    return { ok: true, events };
  } catch {
    return fail('network');
  }
}

/**
 * The group a bill belongs to, for the bill screen's "In Tahoe trip" line: `bills.group_id`, then
 * the group's id and name. `null` for a bill in no group. A bill or group RLS doesn't return is
 * not_allowed (a group bill's participants are its group's members, so this means no access).
 */
export async function fetchBillGroup(billId: string): Promise<GroupResult<{ group: { groupId: string; name: string } | null }>> {
  if (!isUuid(billId)) return fail('not_allowed');
  try {
    const billRes: Raw = await supabase.from('bills').select('group_id').eq('id', billId).maybeSingle();
    if (billRes.error) return fail(mapError('read', billRes.error));
    if (billRes.data === null || billRes.data === undefined) return fail('not_allowed');
    if (!isObject(billRes.data)) return fail('network');
    const groupId = billRes.data.group_id;
    if (groupId === null) return { ok: true, group: null };
    if (!isUuid(groupId)) return fail('network');

    const groupRes: Raw = await supabase.from('groups').select('id, name').eq('id', groupId).maybeSingle();
    if (groupRes.error) return fail(mapError('read', groupRes.error));
    if (groupRes.data === null || groupRes.data === undefined) return fail('not_allowed');
    const g = groupRes.data;
    if (!isObject(g) || g.id !== groupId || !isTextOf(g.name, GROUP_NAME_MAX)) return fail('network');
    return { ok: true, group: { groupId, name: g.name } };
  } catch (thrown) {
    // The only throws in this block are the two reads' (the checks above return, never throw).
    return fail(thrownError(thrown));
  }
}

// ---------------------------------------------------------------------------
// "I wasn't part of this" (docs/specs/2026-11-27-group-claim-status.md C3, T2)
// ---------------------------------------------------------------------------

/**
 * set_not_part(p_bill_id, p_not_part): the caller's own opt-out from a group bill's "claim your
 * items" reminder. `true` is refused with has_claims when the caller has a claim on the bill and
 * not_in_group when the bill has no group; a repeat is a no-op. `false` always succeeds for a
 * participant (a stale opt-out can always be cleared). Changes no money, logs no event.
 */
export async function setNotPart(billId: string, notPart: boolean): Promise<GroupResult> {
  if (!isUuid(billId) || !isBoolean(notPart)) return fail('not_allowed');
  return callVoid('set_not_part', { p_bill_id: billId, p_not_part: notPart });
}

/**
 * Whether the caller has opted out of this bill: their own bill_not_part row (RLS returns only the
 * caller's rows; the one column the grant allows is named). 0 rows is false, 1 row naming this bill
 * is true, anything else is 'network'. Gives up after GROUP_REQUEST_TIMEOUT_MS.
 */
export async function fetchNotPart(billId: string): Promise<GroupResult<{ notPart: boolean }>> {
  if (!isUuid(billId)) return fail('not_allowed');
  let res: Raw;
  try {
    const read = await within(
      Promise.resolve(supabase.from('bill_not_part').select('bill_id').eq('bill_id', billId)),
      GROUP_REQUEST_TIMEOUT_MS,
    );
    if (read === TIMED_OUT) return fail('network');
    res = read;
  } catch (thrown) {
    return fail(thrownError(thrown));
  }
  if (res.error) return fail(mapError('read', res.error));
  const rows = res.data;
  if (!Array.isArray(rows)) return fail('network');
  if (rows.length === 0) return { ok: true, notPart: false };
  const only: unknown = rows[0];
  if (rows.length === 1 && isObject(only) && only.bill_id === billId) return { ok: true, notPart: true };
  return fail('network');
}
