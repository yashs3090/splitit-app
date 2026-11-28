// Who pays whom, on the payments ledger. docs/specs/2026-11-26-who-paid.md, Amendment A1.2 (A1 wins
// over the body). Pure, integer cents only.
//
// Task 2a:
//   - contract P, `pairState`: the state of one ordered pair (u, v) from its ledger entries;
//   - `planKey`: the fingerprint of the money state a plan was made under (WP-27, WP-40).
// Task 2b: contract T (`settleTransfers`, with `planRoutes` for steps 0–5): positions, pins,
// refunds, fewest transfers, the pairs shown on screen, and provenance. lib only: the DB can't
// compute shares. Task 6: `transfersFromReadyPlan` (today's single-payer plan as pairs) and
// `method` narrowed to PaymentMethod.
//
// Both pieces have a database twin, so each one's exact algorithm is written out below:
//   - contract P ↔ `private.pair_state(bill, u, v)` (Task 4a-2), boundary table P (P1–P6) shared by
//     Jest (lib/transfers.test.ts) and pgTAP (criteria A-14, A-22);
//   - planKey: the DB only checks the format today (`plan_key ~ '^[0-9a-f]{16}$'` or null, A1.3). If
//     a twin ever computes or compares it, it must follow the algorithm on `planKey` byte for byte and
//     reuse the known-answer keys pinned in the test.
import type { PaymentMethod } from './paymentMethods';
// settle.ts imports this module too. The cycle is safe: neither module uses the other at load
// time, only inside functions.
import { differenceFor, type SettleDifference, type SettleEarly, type SettleReady } from './settle';

// ---------------------------------------------------------------------------------------------------
// Types (shared with Task 2b)
// ---------------------------------------------------------------------------------------------------

/**
 * One recorded money movement (a `bill_payments` row, A1.3 / A1.4). Rows are never updated.
 * - `id`: the row's uuid, lowercase canonical as the API returns it (the tie-break after `at`).
 * - `cents`: an integer 1..99,999,999 (the table's check).
 * - `method`: how it was paid (the table's check is the same PaymentMethod list).
 * - `planKey`: the key of the plan the payer's screen showed, or null (made under an earlier state).
 * - `at`: `recorded_at`, exactly as the API sent it (a timestamptz string, microsecond precision).
 */
export type Payment = {
  id: string;
  fromId: string;
  toId: string;
  cents: number;
  method: PaymentMethod;
  planKey: string | null;
  at: string;
};

/** A pair's 92-style mark: what the screens show and what the tokens carry (A1.2 contract P). */
export type PairMark = { cents: number; at: string; method: PaymentMethod };

/** Contract P for the ordered pair (u, v): the running net u→v and, when it's > 0, its mark. */
export type PairState = { net: number; mark: PairMark | null };

/** Contract W's mode. The same union as Task 1's `PayersMode` (lib/payers.ts), kept local so the two
 * parallel tasks don't import each other; they are structurally identical. */
export type PlanMode = 'one' | 'split';

/** Who paid the restaurant and how much (contract W). One person = `[{ payerId, total }]`. */
export type PlanPayer = { userId: string; paidCents: number };

/** A participant's share from `computeShares` (its `totalCents`; may be 0 or negative). */
export type PlanShare = { userId: string; shareCents: number };

/** Everything that decides the routes, and nothing else (no names, items or claims). */
export type PlanKeyInput = {
  mode: PlanMode;
  leadId: string;
  payers: readonly PlanPayer[];
  shares: readonly PlanShare[];
};

// ---------------------------------------------------------------------------------------------------
// Ordering: (recorded_at, id)
// ---------------------------------------------------------------------------------------------------

const MAX_ENTRY_CENTS = 99_999_999;

// YYYY-MM-DD, 'T' or ' ', HH:MM:SS, optional .1–6 digits, then Z or ±HH[[:]MM].
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * A timestamptz string → microseconds since the epoch, exactly (A1.2: "compare timestamps as the
 * microsecond strings the API returns, not with Date.parse", nit N7). Date.parse would drop the last
 * three digits, so two entries 1µs apart could tie. Plain text comparison would break across offsets
 * or `Z` vs `+00:00`. Throws RangeError for anything that isn't a full timestamp with an offset.
 */
export function timestampMicros(at: string): number {
  const m = typeof at === 'string' ? TIMESTAMP.exec(at) : null;
  if (!m) throw new RangeError(`transfers: not a timestamp: ${String(at)}`);
  const [, y, mo, d, h, mi, s, frac = '', zone = 'Z'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`transfers: not a timestamp: ${at}`);
  }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(ms).getUTCDate() !== day) throw new RangeError(`transfers: not a timestamp: ${at}`); // e.g. Feb 30
  let offsetSeconds = 0;
  if (zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (om > 59) throw new RangeError(`transfers: not a timestamp: ${at}`);
    offsetSeconds = sign * (oh * 3600 + om * 60);
  }
  const micros = (ms / 1000 - offsetSeconds) * 1_000_000 + Number(frac.padEnd(6, '0'));
  if (!Number.isSafeInteger(micros)) throw new RangeError(`transfers: timestamp out of range: ${at}`);
  return micros;
}

/** The ledger order: `recorded_at`, then `id` (JS `<` on lowercase uuids = Postgres uuid order). */
export function comparePayments(a: Payment, b: Payment): number {
  const ta = timestampMicros(a.at);
  const tb = timestampMicros(b.at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// ---------------------------------------------------------------------------------------------------
// Contract P: the state of a pair
// ---------------------------------------------------------------------------------------------------

/**
 * Contract P (A1.2) for the ordered pair (u, v).
 *
 * Algorithm (the SQL twin `private.pair_state` must do exactly this):
 *   1. Take the entries between u and v (u→v or v→u; every other entry is ignored), ordered by
 *      (`recorded_at`, `id`).
 *   2. Running net r, starting at r(0) = 0: an entry u→v adds its cents, v→u subtracts them.
 *      net = r after the last entry.
 *   3. net ≤ 0 → no mark for u→v (v→u may have one: call with (v, u)).
 *   4. net > 0 → k = the last entry where r(k−1) ≤ 0 and r(k) > 0 (the start of the latest positive
 *      run). markAt = entry k's `recorded_at`, as given. method = the method shared by every u→v
 *      entry from k on (v→u entries in the run don't count), or 'other' if they differ (SV-4).
 *      mark = { cents: net, at: markAt, method }.
 *
 * SQL shape: `sum(case when from_user = u then cents else -cents end) over (order by recorded_at, id
 * rows between unbounded preceding and current row)` over the pair's rows, then the last row where
 * the previous running sum (r − signed cents) ≤ 0 and r > 0.
 *
 * Throws RangeError for u = v, an entry's cents outside 1..99,999,999 or not an integer, a bad
 * timestamp, or two entries of the pair with the same id: a bad row never reads as "no mark".
 */
export function pairState(entries: readonly Payment[], u: string, v: string): PairState {
  if (u === v) throw new RangeError('pairState: u and v must differ');
  const pair = entries.filter((e) => (e.fromId === u && e.toId === v) || (e.fromId === v && e.toId === u));
  const ids = new Set<string>();
  for (const e of pair) {
    if (!Number.isSafeInteger(e.cents) || e.cents < 1 || e.cents > MAX_ENTRY_CENTS) {
      throw new RangeError(`pairState: cents must be an integer 1..${MAX_ENTRY_CENTS}`);
    }
    if (ids.has(e.id)) throw new RangeError(`pairState: duplicate entry id ${e.id}`);
    ids.add(e.id);
    timestampMicros(e.at); // validates
  }
  const ordered = pair.slice().sort(comparePayments);

  let r = 0;
  let runStart = -1;
  ordered.forEach((e, k) => {
    const before = r;
    r += e.fromId === u ? e.cents : -e.cents;
    if (before <= 0 && r > 0) runStart = k;
  });
  if (r <= 0) return { net: r, mark: null };

  const start = ordered[runStart];
  if (!start) throw new RangeError('pairState: positive net without a run start'); // unreachable
  let method: PaymentMethod | null = null;
  for (const e of ordered.slice(runStart)) {
    if (e.fromId !== u) continue;
    if (method === null) method = e.method;
    else if (method !== e.method) {
      method = 'other';
      break;
    }
  }
  return { net: r, mark: { cents: r, at: start.at, method: method ?? 'other' } };
}

// ---------------------------------------------------------------------------------------------------
// planKey
// ---------------------------------------------------------------------------------------------------

export const PLAN_KEY_VERSION = 'v1';
/** The DB's format check for `bill_payments.plan_key` (A1.3). */
export const PLAN_KEY_PATTERN = /^[0-9a-f]{16}$/;

const FNV_PRIME = 0x01000193;
const FNV_BASIS_1 = 0x811c9dc5; // the standard FNV-1a 32-bit offset basis
const FNV_BASIS_2 = (0x01000193 ^ 0x9e3779b9) >>> 0; // 0x9f37782a (A1.2)

// Printable ASCII without the canonical string's delimiters ('|', ',', ':'). Real ids are uuid::text.
const KEY_ID = /^[\x21-\x7e]+$/;
const DELIMITERS = /[|,:]/;

/**
 * FNV-1a, 32 bits, over the string's UTF-16 code units, as 8 lowercase hex digits. Exported for the
 * published test vectors. planKey only feeds it ASCII, where code units = bytes.
 */
export function fnv1a32(s: string, basis: number): string {
  return hex8(fnvFrom(basis, s));
}

/** FNV-1a 32 continued from state `h` over `s` (h = the offset basis starts a fresh hash). */
function fnvFrom(h: number, s: string): number {
  let x = h >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, FNV_PRIME) >>> 0;
  }
  return x;
}

function hex8(h: number): string {
  return (h >>> 0).toString(16).padStart(8, '0');
}

function checkId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !KEY_ID.test(id) || DELIMITERS.test(id)) {
    throw new RangeError(`planKey: ${what} must be a non-empty ASCII id without | , or :`);
  }
  return id;
}

function byUserId<T extends { userId: string }>(a: T, b: T): number {
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * The canonical string planKey hashes. Validates the input against contract W first (RangeError):
 * - mode 'one' → exactly one payer, and it is the lead; mode 'split' → 2+ payers, the lead among them;
 * - ids distinct within payers and within shares; every payer has a share (is a participant);
 * - paidCents a safe integer ≥ 0 (a one-person $0 bill pays 0); shareCents any safe integer.
 * It doesn't check Σ paid = Σ shares: early single-payer plans use "so far" shares (A1.2).
 */
export function planKeyCanonical(input: PlanKeyInput): string {
  const { mode, leadId, payers, shares } = input;
  if (mode !== 'one' && mode !== 'split') throw new RangeError('planKey: mode must be one or split');
  checkId(leadId, 'leadId');
  if (mode === 'one' && payers.length !== 1) throw new RangeError('planKey: one person needs exactly 1 payer');
  if (mode === 'split' && payers.length < 2) throw new RangeError('planKey: split needs at least 2 payers');

  const shareIds = new Set<string>();
  for (const s of shares) {
    checkId(s.userId, 'share userId');
    if (shareIds.has(s.userId)) throw new RangeError(`planKey: duplicate share for ${s.userId}`);
    shareIds.add(s.userId);
    if (!Number.isSafeInteger(s.shareCents)) throw new RangeError('planKey: shareCents must be a safe integer');
  }
  const payerIds = new Set<string>();
  for (const p of payers) {
    checkId(p.userId, 'payer userId');
    if (payerIds.has(p.userId)) throw new RangeError(`planKey: duplicate payer ${p.userId}`);
    payerIds.add(p.userId);
    if (!Number.isSafeInteger(p.paidCents) || p.paidCents < 0) {
      throw new RangeError('planKey: paidCents must be a safe integer ≥ 0');
    }
    if (!shareIds.has(p.userId)) throw new RangeError(`planKey: payer ${p.userId} has no share`);
  }
  if (!payerIds.has(leadId)) throw new RangeError('planKey: the lead must be a payer');

  // String(n) of a safe integer is plain decimal ('-' for negatives, never an exponent; -0 → "0"),
  // the same text as Postgres's integer::text.
  const payerPart = payers
    .slice()
    .sort(byUserId)
    .map((p) => `${p.userId}:${String(p.paidCents)}`)
    .join(',');
  const sharePart = shares
    .slice()
    .sort(byUserId)
    .map((s) => `${s.userId}:${String(s.shareCents)}`)
    .join(',');
  return `${PLAN_KEY_VERSION}|${mode}|${leadId}|${payerPart}|${sharePart}`;
}

/**
 * The plan key (A1.2, WP-27, WP-40): 16 lowercase hex characters fingerprinting the money state the
 * routes were planned from. Deterministic, and the same for any order of `payers` and `shares`.
 *
 * Covers exactly: the mode, the lead, each payer's id and paid cents, and each participant's id and
 * share cents. Nothing else: names, items, claims, the extras mode and the bill total only matter
 * through the shares they produce (an item rename keeps the key; a change that moves 1¢ between
 * people changes it). Participants are the ids in `shares`.
 *
 * Algorithm (a DB twin must match it exactly):
 *   1. Validate (see planKeyCanonical).
 *   2. canonical = "v1|" + mode + "|" + leadId + "|"
 *                  + payers sorted by userId, each "userId:paidCents", joined by ","
 *                  + "|" + shares sorted by userId, each "userId:shareCents", joined by ",".
 *      Sorting is by code unit (JS `<`). In SQL: `order by user_id::text collate "C"`, which for
 *      lowercase uuid text is also uuid order. Numbers are `integer::text`. The string is ASCII.
 *   3. h1 = FNV-1a 32 with offset basis 0x811c9dc5; h2 = FNV-1a 32 with basis 0x9f37782a
 *      (= 0x01000193 XOR 0x9e3779b9). FNV-1a 32: h = basis; for each character c (ASCII code):
 *      h = ((h XOR c) × 16777619) mod 2^32. In SQL with bigint: h := ((h # ascii(c)) * 16777619)
 *      % 4294967296 (h < 2^32 and the prime < 2^25, so the product fits).
 *   4. key = lpad(hex(h1), 8, '0') || lpad(hex(h2), 8, '0'), lowercase.
 *
 * Evidence (criterion A-22, spec "any pure deterministic 64-bit hash with evidence"): the published
 * FNV-1a vectors, two known-answer keys from an independent BigInt implementation, and no collision
 * across a 20,000-state sweep of neighbouring amounts (lib/transfers.test.ts). It isn't
 * cryptographic and needn't be: the key is client-stamped, and a collision or a forged key can only
 * re-plan routes, never change money (A1.2).
 */
export function planKey(input: PlanKeyInput): string {
  const canonical = planKeyCanonical(input);
  return fnv1a32(canonical, FNV_BASIS_1) + fnv1a32(canonical, FNV_BASIS_2);
}

// ---------------------------------------------------------------------------------------------------
// Contract T (ledger): who pays whom (Task 2b, A1.2)
// ---------------------------------------------------------------------------------------------------

/** A planned money movement (a route): `fromId` sends `toId` `cents` (> 0). */
export type Route = { fromId: string; toId: string; cents: number };

/** A negative-share non-payer's "settle that outside the app" route, lead → them (WP-30). */
export type Outside = Route;

/**
 * One pair as the screens show it (A1.2 step 6), oriented so `targetCents ≥ 0` (and, at target 0, so
 * that `paidCents > 0`).
 * - `targetCents`: what `fromId` should have sent `toId` net, in total: earlier-key money on the pair
 *   plus today's routes.
 * - `paidCents`: what `fromId` has sent `toId` net, over every entry (may be negative: `toId` sent
 *   `fromId` more, T13).
 * - `remainingCents = targetCents − paidCents`: > 0 means `fromId` still pays `toId` that much; < 0
 *   means `toId` pays `fromId` back.
 * - `mark`: contract P's mark for (fromId, toId) when `paidCents > 0`, else null.
 * - `difference`: contract D (`differenceFor(targetCents, paidCents)`) when `paidCents > 0`, else null.
 */
export type Pair = {
  fromId: string;
  toId: string;
  targetCents: number;
  paidCents: number;
  remainingCents: number;
  mark: PairMark | null;
  difference: SettleDifference | null;
};

/**
 * Money someone holds that wasn't theirs to keep (A1.2 step 7; the copy is A1.5 "Telling the people
 * affected"). Derived from the pairs, never stored.
 * - 'passed_on': `senderId` paid `holderId` earlier, `holderId` isn't a current payer, and the money
 *   still counts (the pair's target > 0). `cents = min(paid, target)` on the pair senderId → holderId.
 *   `onwardIds` = who the holder pays on (their pairs with target > 0), sorted. T0: Priya → Sam, on to
 *   You.
 * - 'returned': the pair holderId → senderId has `paidCents < 0`: the sender sent the holder money
 *   and the plan now has it go back, inside the holder's remaining. `cents = −paidCents`,
 *   `onwardIds = [senderId]`. T13: A holds B's $3.00. The holder may be a current payer here.
 */
export type HeldMoney = {
  kind: 'passed_on' | 'returned';
  senderId: string;
  holderId: string;
  cents: number;
  onwardIds: string[];
};

/** The same HeldMoney items, grouped by holder and by sender (only people with at least one). */
export type Provenance = {
  heldFor: Record<string, HeldMoney[]>;
  passedOnBy: Record<string, HeldMoney[]>;
};

export type SettleTransfersInput = {
  /** Contract W, as for planKey. One person = `[{ userId: leadId, paidCents: total }]`. */
  mode: PlanMode;
  leadId: string;
  payers: readonly PlanPayer[];
  /** computeShares totals, one per participant (the participants are exactly these ids). */
  shares: readonly PlanShare[];
  /** Every `bill_payments` entry of the bill. */
  entries: readonly Payment[];
  /**
   * Step 0: an early single-payer plan, whose "so far" shares don't add up to the total. The
   * unclaimed amount (Σ paid − Σ shares, either sign) counts as the lead's share for routing only;
   * the key is still over the shares as given. Mode 'one' only.
   */
  early?: boolean;
};

export type SettleTransfers = {
  /** The current plan key K (`currentPlanKey`; = planKey(...) when there is no earlier-key history).
   * A payment made from this plan is stamped with it. */
  key: string;
  /** Ordered by fromId, then toId. */
  pairs: Pair[];
  /** Ordered by fromId, then toId. Never reduced by entries (settled outside the app, as today). */
  outside: Outside[];
  provenance: Provenance;
};

/** The steps of contract T up to step 5, for tests and the route-bound property. */
export type RoutePlan = {
  key: string;
  /** Step 2: positions from paid, routing shares and earlier-key entries. Σ = 0. */
  positions: Record<string, number>;
  /** After step 3 (pins). */
  afterPins: Record<string, number>;
  /** After step 4 (refunds): what step 5 starts from. Every non-payer is ≤ 0 here. */
  beforeGreedy: Record<string, number>;
  outside: Outside[];
  /** Step 4, in the order planned (one per planned movement; a pair may appear twice, see step 4). */
  refunds: Route[];
  /** Step 5, in the order planned. */
  greedy: Route[];
};

/**
 * Test seam (the must-fail run of criterion A-23, like `differenceFor`'s `ignoreCents`). Never pass
 * it from app code.
 */
export type TransfersTestSeam = { skipRefunds?: boolean };

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byRoute(a: { fromId: string; toId: string }, b: { fromId: string; toId: string }): number {
  return byCodeUnit(a.fromId, b.fromId) || byCodeUnit(a.toId, b.toId);
}

function sortedRecord(ids: readonly string[], value: (id: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = value(id);
  return out;
}

/** Net cents per unordered pair in one pass: key "lo|hi" (lo < hi) → net lo→hi (contract P's net). */
function netsOf(entries: readonly Payment[]): Map<string, number> {
  const nets = new Map<string, number>();
  for (const e of entries) {
    const lo = e.fromId < e.toId ? e.fromId : e.toId;
    const hi = lo === e.fromId ? e.toId : e.fromId;
    const k = `${lo}|${hi}`;
    nets.set(k, (nets.get(k) ?? 0) + (e.fromId === lo ? e.cents : -e.cents));
  }
  return nets;
}

/** Net u→v from netsOf's map (= pairState(entries, u, v).net for validated entries). */
function netOf(nets: ReadonlyMap<string, number>, u: string, v: string): number {
  return u < v ? (nets.get(`${u}|${v}`) ?? 0) : 0 - (nets.get(`${v}|${u}`) ?? 0); // 0 − x: never −0
}

function checkEntries(entries: readonly Payment[], participants: ReadonlySet<string>): void {
  const ids = new Set<string>();
  for (const e of entries) {
    if (typeof e.id !== 'string' || !KEY_ID.test(e.id) || DELIMITERS.test(e.id)) {
      throw new RangeError('settleTransfers: entry id must be a non-empty ASCII id without | , or :');
    }
    if (ids.has(e.id)) throw new RangeError(`settleTransfers: duplicate entry id ${e.id}`);
    ids.add(e.id);
    if (!participants.has(e.fromId) || !participants.has(e.toId)) {
      throw new RangeError(`settleTransfers: entry ${e.id} involves someone not on the bill`);
    }
    if (e.fromId === e.toId) throw new RangeError(`settleTransfers: entry ${e.id} is to its sender`);
    if (!Number.isSafeInteger(e.cents) || e.cents < 1 || e.cents > MAX_ENTRY_CENTS) {
      throw new RangeError(`settleTransfers: entry cents must be an integer 1..${MAX_ENTRY_CENTS}`);
    }
    if (e.planKey !== null && (typeof e.planKey !== 'string' || !PLAN_KEY_PATTERN.test(e.planKey))) {
      throw new RangeError(`settleTransfers: entry ${e.id} has a malformed plan key`);
    }
    timestampMicros(e.at); // validates
  }
}

/**
 * The current plan key K that contract T partitions entries by, and that a payment made from this
 * plan is stamped with (`settleTransfers(...).key`). **A deviation from A1.2, flagged in the Task 2b
 * report**: A1 sets K = planKey(mode, lead, payers, shares). That K stays the same when the
 * earlier-key entries change (a payment from a stale screen, or an undo or not-received that deletes
 * an earlier-key entry). Those changes re-plan the routes, but the payments already stamped K were
 * made on the old routes, which no longer exist. The simulation found states where that leaves a
 * remaining > 0 owed to someone who isn't a payer (a route mark_paid refuses).
 *
 * So K also covers which entries are earlier-key:
 *   keyFor(pre) = planKey(...) when pre is empty. Otherwise the same two FNV-1a passes (bases 1 and 2)
 *                 over planKeyCanonical(...) + "|pre:" + D, where D is an order-free digest of the
 *                 set of pre entry ids: 8 hex of (Σ fnv1a32(id, basis 1) mod 2^32), then 8 hex of
 *                 (Σ fnv1a32(id, basis 2) mod 2^32). Entry ids are unique, so a set is enough.
 *   K = the smallest key k stamped on some entry with keyFor(entries not stamped k) = k (the entries
 *       stamped k were made on exactly this plan); if there's none, K = keyFor(every entry).
 * With no earlier-key history, K = planKey(...) exactly, as in A1. A payment stamped K keeps K (the
 * pre set is unchanged), so recording it changes nothing else. A stale-key payment or the deletion of
 * an earlier-key entry gives a new K, so everything is re-planned from all the money, including the
 * payments stamped with the old K. An item rename still keeps K. As in A1, a collision or a forged key
 * can only re-plan routes, never change money. Cost: one pass over the entries, then a 16-character
 * hash per distinct stamped key.
 */
export function currentPlanKey(input: Pick<SettleTransfersInput, 'mode' | 'leadId' | 'payers' | 'shares' | 'entries'>): string {
  const { mode, leadId, payers, shares, entries } = input;
  const canonical = planKeyCanonical({ mode, leadId, payers, shares });
  const base1 = fnvFrom(FNV_BASIS_1, canonical);
  const base2 = fnvFrom(FNV_BASIS_2, canonical);
  const pre1 = fnvFrom(base1, '|pre:');
  const pre2 = fnvFrom(base2, '|pre:');
  const keyFor = (count: number, sum1: number, sum2: number): string => {
    if (count === 0) return hex8(base1) + hex8(base2); // = planKey(...)
    const digest = hex8(sum1) + hex8(sum2);
    return hex8(fnvFrom(pre1, digest)) + hex8(fnvFrom(pre2, digest));
  };
  type Sums = { count: number; sum1: number; sum2: number };
  const all: Sums = { count: 0, sum1: 0, sum2: 0 };
  const byKey = new Map<string, Sums>();
  for (const e of entries) {
    const h1 = fnvFrom(FNV_BASIS_1, e.id);
    const h2 = fnvFrom(FNV_BASIS_2, e.id);
    all.count += 1;
    all.sum1 = (all.sum1 + h1) >>> 0;
    all.sum2 = (all.sum2 + h2) >>> 0;
    if (e.planKey === null) continue;
    const g = byKey.get(e.planKey) ?? { count: 0, sum1: 0, sum2: 0 };
    g.count += 1;
    g.sum1 = (g.sum1 + h1) >>> 0;
    g.sum2 = (g.sum2 + h2) >>> 0;
    byKey.set(e.planKey, g);
  }
  for (const k of [...byKey.keys()].sort(byCodeUnit)) {
    const g = byKey.get(k);
    if (g && keyFor(all.count - g.count, (all.sum1 - g.sum1) >>> 0, (all.sum2 - g.sum2) >>> 0) === k) return k;
  }
  return keyFor(all.count, all.sum1, all.sum2);
}

/**
 * Contract T, steps 0–5 (A1.2). Exact integer cents; ids compared with JS `<`.
 *
 *   0. early (mode 'one' only): the lead's routing share += Σ paid − Σ shares.
 *   1. pre = entries whose planKey ≠ K (or null); post = planKey = K. K = currentPlanKey (see there:
 *      a flagged refinement of A1's K).
 *   2. p_u = paid_u − share_u + Σ pre sent by u − Σ pre received by u. Σ p ≠ 0 → RangeError (the
 *      shares don't add up to what was paid). Planning u→v of x: p_u += x, p_v −= x.
 *   3. Pins (WP-30): each non-payer with share < 0 (by id) gets `outside` lead → them |share|.
 *   4. Refunds (WP-29): repeat passes until a pass plans nothing; each pass takes every non-payer u
 *      with p_u > 0 by id, and for each v by id with refundable(u→v) > 0 plans v → u
 *      y = min(p_u, refundable), until p_u = 0. refundable(u→v) starts at net_pre(u→v) and drops by
 *      each refund planned on it. A1's text is one pass; see below for why it repeats.
 *   5. Fewest transfers (WP-28, Groups GR-3): while some p ≠ 0, the smallest p (ties lower id) pays
 *      the largest p (ties lower id) min(−p_d, p_c).
 *
 * Why step 4 repeats: refunding u raises the refunder's position. If the refunder v is a non-payer
 * already processed (lower id), v ends the pass owed money, and step 5 would route some debtor to
 * v, a non-payer (a remaining > 0 to someone who isn't a payer). A1 says one pass "always brings u to
 * 0", which is true for u, but misses v. A second pass refunds v from the people v paid. With no such
 * chain the first pass is A1's loop exactly and the second plans nothing. It terminates: every
 * refund uses up refundable cents. And it always zeroes u: for a non-payer,
 * p_u ≤ Σ_v refundable(u→v), because every refund u made went back along an edge u received on.
 */
export function planRoutes(input: SettleTransfersInput, seam: TransfersTestSeam = {}): RoutePlan {
  const { mode, leadId, payers, shares, entries, early = false } = input;
  planKeyCanonical({ mode, leadId, payers, shares }); // contract W, before anything else
  if (early && mode !== 'one') throw new RangeError('settleTransfers: only a one-person plan can be early');

  const ids = shares.map((s) => s.userId).sort(byCodeUnit);
  const participants = new Set(ids);
  checkEntries(entries, participants);
  const key = currentPlanKey(input);
  const payerIds = new Set(payers.map((p) => p.userId));
  const nonPayers = ids.filter((id) => !payerIds.has(id));

  // Step 0.
  const share = new Map(shares.map((s) => [s.userId, s.shareCents]));
  const paid = new Map(payers.map((p) => [p.userId, p.paidCents]));
  const paidSum = payers.reduce((sum, p) => sum + p.paidCents, 0);
  const shareSum = shares.reduce((sum, s) => sum + s.shareCents, 0);
  if (!Number.isSafeInteger(paidSum) || !Number.isSafeInteger(shareSum)) {
    throw new RangeError('settleTransfers: sums out of range');
  }
  if (early) share.set(leadId, (share.get(leadId) ?? 0) + paidSum - shareSum);

  // Steps 1–2.
  const pre = entries.filter((e) => e.planKey !== key);
  const p = new Map<string, number>(ids.map((id) => [id, (paid.get(id) ?? 0) - (share.get(id) ?? 0)]));
  for (const e of pre) {
    p.set(e.fromId, (p.get(e.fromId) ?? 0) + e.cents);
    p.set(e.toId, (p.get(e.toId) ?? 0) - e.cents);
  }
  const total = ids.reduce((sum, id) => sum + (p.get(id) ?? 0), 0);
  if (total !== 0) throw new RangeError(`settleTransfers: positions sum to ${total}, not 0`);
  for (const id of ids) {
    if (!Number.isSafeInteger(p.get(id))) throw new RangeError('settleTransfers: position out of range');
  }
  const positions = sortedRecord(ids, (id) => p.get(id) ?? 0);
  const move = (fromId: string, toId: string, cents: number): void => {
    p.set(fromId, (p.get(fromId) ?? 0) + cents);
    p.set(toId, (p.get(toId) ?? 0) - cents);
  };

  // Step 3.
  const outside: Outside[] = [];
  for (const id of nonPayers) {
    const s = share.get(id) ?? 0;
    if (s < 0) {
      outside.push({ fromId: leadId, toId: id, cents: -s });
      move(leadId, id, -s);
    }
  }
  const afterPins = sortedRecord(ids, (id) => p.get(id) ?? 0);

  // Step 4.
  const refunds: Route[] = [];
  if (!seam.skipRefunds) {
    const refundable = new Map<string, number>(); // `${u}|${v}` → cents u sent v (pre, net) not yet refunded
    const preNets = netsOf(pre);
    for (const u of nonPayers) {
      for (const v of ids) {
        if (v === u) continue;
        const net = netOf(preNets, u, v);
        if (net > 0) refundable.set(`${u}|${v}`, net);
      }
    }
    let planned = true;
    while (planned) {
      planned = false;
      for (const u of nonPayers) {
        for (const v of ids) {
          const pu = p.get(u) ?? 0;
          if (pu <= 0) break;
          const cap = refundable.get(`${u}|${v}`) ?? 0;
          if (cap <= 0) continue;
          const y = Math.min(pu, cap);
          refunds.push({ fromId: v, toId: u, cents: y });
          move(v, u, y);
          refundable.set(`${u}|${v}`, cap - y);
          planned = true;
        }
        if ((p.get(u) ?? 0) > 0) throw new RangeError('settleTransfers: a refund left someone owed'); // unreachable
      }
    }
  }
  const beforeGreedy = sortedRecord(ids, (id) => p.get(id) ?? 0);

  // Step 5.
  const greedy: Route[] = [];
  for (;;) {
    let d = ids[0];
    let c = ids[0];
    for (const id of ids) {
      if ((p.get(id) ?? 0) < (p.get(d ?? '') ?? 0)) d = id;
      if ((p.get(id) ?? 0) > (p.get(c ?? '') ?? 0)) c = id;
    }
    if (d === undefined || c === undefined) break;
    const pd = p.get(d) ?? 0;
    const pc = p.get(c) ?? 0;
    if (pd === 0 && pc === 0) break;
    const x = Math.min(-pd, pc);
    if (!(x > 0)) throw new RangeError('settleTransfers: positions stopped adding up'); // unreachable
    greedy.push({ fromId: d, toId: c, cents: x });
    move(d, c, x);
  }

  return { key, positions, afterPins, beforeGreedy, outside: outside.sort(byRoute), refunds, greedy };
}

/**
 * Contract T (ledger), A1.2: who pays whom on the payments ledger. Steps 0–5 are `planRoutes`; this
 * adds step 6 (the pairs shown on screen) and step 7 (provenance).
 *
 *   6. For each unordered pair {u, v} with a step 4–5 route or any entry:
 *      target(u→v) = net_pre(u→v) + R(u→v) − R(v→u) and paid(u→v) = net_all(u→v) (contract P nets).
 *      Orient it so target ≥ 0 (at target 0, so paid > 0); drop it when both are 0;
 *      remaining = target − paid. paid > 0 → mark = contract P's mark for (from, to) and
 *      difference = differenceFor(target, paid); else both null. Pins are listed in `outside` only.
 *   7. Provenance from the pairs (see HeldMoney).
 *
 * Properties (lib/transfers.test.ts, the seeded simulation): positions are brought to 0 exactly by
 * the remaining amounts and the outside routes; a payment under the current key changes only its
 * own pair; with one payer and every entry involving them, the pairs are today's settlePlan; the
 * output doesn't depend on input order; a remaining > 0 always goes to a current payer.
 *
 * Throws RangeError for input that breaks contract W (via planKey), shares that don't add up to what
 * was paid (not early), and any malformed entry (unknown person, to self, cents not an integer
 * 1..99,999,999, a bad timestamp or plan key, a duplicate id).
 */
export function settleTransfers(input: SettleTransfersInput, seam: TransfersTestSeam = {}): SettleTransfers {
  const plan = planRoutes(input, seam);
  const { key } = plan;
  const { entries, payers } = input;
  const pre = entries.filter((e) => e.planKey !== key);
  const payerIds = new Set(payers.map((p) => p.userId));

  // R(u→v): steps 4–5 summed per ordered pair.
  const routed = new Map<string, number>();
  for (const r of [...plan.refunds, ...plan.greedy]) {
    const k = `${r.fromId}|${r.toId}`;
    routed.set(k, (routed.get(k) ?? 0) + r.cents);
  }
  const unordered = new Set<string>();
  const addPair = (a: string, b: string): void => {
    unordered.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  };
  for (const r of [...plan.refunds, ...plan.greedy]) addPair(r.fromId, r.toId);
  for (const e of entries) addPair(e.fromId, e.toId);

  const preNets = netsOf(pre);
  const allNets = netsOf(entries);
  const pairs: Pair[] = [];
  for (const k of unordered) {
    const [u = '', v = ''] = k.split('|');
    let target = netOf(preNets, u, v) + (routed.get(`${u}|${v}`) ?? 0) - (routed.get(`${v}|${u}`) ?? 0);
    let paidNet = netOf(allNets, u, v);
    let fromId = u;
    let toId = v;
    if (target < 0 || (target === 0 && paidNet < 0)) {
      fromId = v;
      toId = u;
      target = 0 - target; // 0 − x, so a 0 never becomes −0 (toEqual tells them apart)
      paidNet = 0 - paidNet;
    }
    if (target === 0 && paidNet === 0) continue;
    let mark: PairMark | null = null;
    let difference: SettleDifference | null = null;
    if (paidNet > 0) {
      mark = pairState(entries, fromId, toId).mark;
      if (!mark || mark.cents !== paidNet) throw new RangeError('settleTransfers: mark disagrees with the pair'); // unreachable
      difference = differenceFor(target, paidNet);
    }
    pairs.push({ fromId, toId, targetCents: target, paidCents: paidNet, remainingCents: target - paidNet, mark, difference });
  }
  pairs.sort(byRoute);

  return { key, pairs, outside: plan.outside, provenance: provenanceOf(pairs, payerIds) };
}

/** Step 7 (A1.2, A1.5): HeldMoney from the shown pairs. */
function provenanceOf(pairs: readonly Pair[], payerIds: ReadonlySet<string>): Provenance {
  const onwardOf = (holderId: string): string[] =>
    pairs.filter((q) => q.fromId === holderId && q.targetCents > 0).map((q) => q.toId).sort(byCodeUnit);
  const held: HeldMoney[] = [];
  for (const q of pairs) {
    if (q.paidCents > 0 && q.targetCents > 0 && !payerIds.has(q.toId)) {
      held.push({
        kind: 'passed_on',
        senderId: q.fromId,
        holderId: q.toId,
        cents: Math.min(q.paidCents, q.targetCents),
        onwardIds: onwardOf(q.toId),
      });
    } else if (q.paidCents < 0) {
      held.push({ kind: 'returned', senderId: q.toId, holderId: q.fromId, cents: -q.paidCents, onwardIds: [q.toId] });
    }
  }
  held.sort((a, b) => byCodeUnit(a.holderId, b.holderId) || byCodeUnit(a.senderId, b.senderId));
  const heldFor: Record<string, HeldMoney[]> = {};
  const passedOnBy: Record<string, HeldMoney[]> = {};
  for (const h of held) {
    (heldFor[h.holderId] ??= []).push(h);
  }
  for (const h of [...held].sort((a, b) => byCodeUnit(a.senderId, b.senderId) || byCodeUnit(a.holderId, b.holderId))) {
    (passedOnBy[h.senderId] ??= []).push(h);
  }
  return { heldFor, passedOnBy };
}

/**
 * Today's single-payer plan as contract T's output (A1.2 step 6; the S1 adapter
 * `legacyMarksToPairs` in test-utils/legacyMarks.ts is its test twin). One pair per marked or owing
 * non-payer, `fromId` → payer: target = max(owed, 0), paid = the mark's cents, the mark and contract
 * D's difference. Each negative share is an outside route payer → them. Pairs with target 0 and
 * nothing paid are dropped. Ordered by fromId, then toId. Provenance is empty: with one payer and every
 * entry to them, nobody holds anyone else's money. Used by `balanceFor` on 'ready' and 'early' plans.
 */
export function transfersFromReadyPlan(plan: SettleReady | SettleEarly): { pairs: Pair[]; outside: Outside[]; provenance: Provenance } {
  const payerId = plan.payerId;
  const pairs: Pair[] = [];
  const outside: Outside[] = [];
  for (const p of plan.people) {
    if (p.role === 'payer') continue;
    const target = Math.max(p.owedCents, 0);
    const paid = p.mark?.cents ?? 0;
    if (p.role === 'payer_owes_them') outside.push({ fromId: payerId, toId: p.userId, cents: -p.owedCents });
    if (target === 0 && paid === 0) continue;
    pairs.push({
      fromId: p.userId,
      toId: payerId,
      targetCents: target,
      paidCents: paid,
      remainingCents: target - paid,
      mark: p.mark ? { cents: p.mark.cents, at: p.mark.at, method: p.mark.method } : null,
      difference: p.mark ? (p.difference ?? null) : null,
    });
  }
  return { pairs: pairs.sort(byRoute), outside: outside.sort(byRoute), provenance: { heldFor: {}, passedOnBy: {} } };
}
