// Settle plan: who owes the payer how much, and who has marked "I paid".
// Spec docs/specs/2026-11-24-m3-settle-venmo.md § D3 (Task 4). Pure and integer-cents only.
//
// Built on computeShares, run once. Each non-payer owes exactly their computeShares total, so
// Σ owed (non-payers) + the payer's own share === bill total on every 'ready' plan. The one complete
// bill where that can't hold (every row $0.00 in proportional mode) is 'blocked_all_zero' (Q10).
// Screens do no money arithmetic: every amount on the Settle screen comes from this result.
//
// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md, Task 3, A1):
// rules E and Z (`maySettle`, `allZero`, the same rule as SQL's private.settle_state), the 'early'
// plan behind `settlePlan(..., { allowEarly: true })`, and a `difference` on every marked non-payer.
//
// Sent via Venmo (docs/specs/2026-11-26-sent-via-venmo.md D4, D7, §11, Task 3): a mark also says how
// it was paid and who it was to, and every entry carries the payer's "Not received" flag. Neither
// changes any amount or count here: a flag is not a mark.
//
// Who paid (docs/specs/2026-11-26-who-paid.md, Amendment A1, Task 6): `ledgerSettlePlan` reads the
// bill's payers, payments ledger and flags (BillData). A single payer whose payments all involve
// them gets exactly today's settlePlan; several payers, or money that moved between other people,
// get a 'routes' plan from contract T (lib/transfers.ts). A split whose amounts no longer add up to
// the total is 'blocked_payers', checked before incomplete and all-$0 (S8). Rule E′: no settling
// early while the paying is split. `balanceFor` is Home's per-viewer balance in cents (S2).
import type { Payer, PayersMode } from './payers';
import { payersState } from './payers';
import type { PaymentMethod } from './paymentMethods';
import { computeShares, sharesComplete, type SplitInput, type SplitResult } from './split';
// transfers.ts imports differenceFor from here; the cycle is safe because neither module uses the
// other at load time, only inside functions.
import {
  currentPlanKey,
  pairState,
  settleTransfers,
  transfersFromReadyPlan,
  type Outside,
  type Pair,
  type Payment,
  type Provenance,
} from './transfers';

/**
 * One person's "I paid": the amount the screen showed, when they tapped it (as the database sent
 * it), how they paid, and who it was to (`toUserId`: the bill's payer when fetched; marks store no
 * payer, §11). Read as one transfer from the entry's person to `toUserId`.
 */
export type SettleMark = { cents: number; at: string; method: PaymentMethod; toUserId: string };
/** userId → mark (missing or null = not marked). */
export type SettleMarks = Readonly<Record<string, SettleMark | null | undefined>>;

/**
 * Contract N (D4): the payer said this person's mark never arrived. `cents` and `method` are the
 * cleared mark's; `toUserId` is who the money was owed to (not_received_by). Kept as fetched: the
 * views decide whether it still applies (`toUserId === plan.payerId`, and no new mark).
 */
export type SettleNotReceived = { cents: number; method: PaymentMethod; toUserId: string };
/** userId → flag (missing or null = none). */
export type SettleNotReceivedMap = Readonly<Record<string, SettleNotReceived | null | undefined>>;

export type SettleRole = 'payer' | 'owes' | 'nothing' | 'payer_owes_them';

/**
 * Set only on a marked non-payer (Task 8, Q3 A): how the current share compares with the amount the
 * person marked. `markDiffCents = owedCents − mark.cents` (signed integer cents): positive means they
 * still owe the difference, negative means the payer owes them some back.
 */
export type SettleMarkDiff = { markDiffCents: number; markDiffers: boolean };

/**
 * Contract D (spec D4): how far a marked person's current share is from their mark, outside the
 * tolerance. 'more': they owe the payer `cents` more. 'back': the payer owes them `cents` back
 * (never more than the mark; `toCents` 0 means recording it clears the mark). Recording it means
 * settle_difference(…, fromCents, toCents).
 */
export type SettleDifference = { kind: 'more' | 'back'; cents: number; fromCents: number; toCents: number };

/**
 * Set on every marked non-payer, in 'ready' and 'early' plans: the difference, or null when the
 * share is within SETTLE_DIFF_IGNORE_CENTS of the mark. Absent on unmarked people and the payer
 * (like markDiffCents), so read it through differenceOf().
 */
export type SettleDifferenceField = { difference?: SettleDifference | null };

/** On every entry, the payer's included (null there in practice: nobody owes the payer to themself). */
type FlagField = { notReceived: SettleNotReceived | null };
type PayerEntry = { userId: string; role: 'payer'; mark: SettleMark | null } & FlagField; // the payer's share is never collected
type OwerFields = { userId: string; role: Exclude<SettleRole, 'payer'>; owedCents: number; mark: SettleMark | null } & FlagField;

export type SettleEntry = PayerEntry | (OwerFields & Partial<SettleMarkDiff> & SettleDifferenceField);

/** An entry of an 'early' plan: as in 'ready' (without markDiffCents), plus rule E per person. */
export type SettleEarlyEntry = PayerEntry | (OwerFields & { canSettle: boolean } & SettleDifferenceField);

export type SettleReady = {
  status: 'ready';
  payerId: string;
  people: SettleEntry[]; // one per participant (payer included), in computeShares order (by userId)
  collectCents: number; // Σ positive owedCents
  owingCount: number; // people with role 'owes', marked or not
  paidCount: number; // people with role 'owes' who are marked
  allPaid: boolean; // every 'owes' person is marked (true when nobody owes anything)
};

export type SettlePlan =
  | { status: 'blocked'; unclaimedRows: number; unclaimedDiscountRows: number } // C1 false: no amounts at all
  | { status: 'blocked_bad_payer' } // payer isn't a participant (can't happen under invariant P)
  /**
   * Q10: every row is claimed, but computeShares leaves cents with nobody (unclaimedCents ≠ 0).
   * That happens only in proportional mode when every row is $0.00 and the total isn't: there are
   * no item weights to split the extras by. No amounts. Copy: SETTLE_ALL_ZERO_COPY.
   */
  | { status: 'blocked_all_zero' }
  | SettleReady;

/**
 * Proportional mode, bill not complete and not all-$0 (D2): amounts so far, and who may settle now.
 * Only `settlePlan(..., { allowEarly: true })` returns it, so callers without the option keep
 * today's exhaustive SettlePlan union (A1.24).
 */
export type SettleEarly = {
  status: 'early';
  payerId: string;
  unclaimedRows: number;
  unclaimedDiscountRows: number;
  people: SettleEarlyEntry[]; // one per participant (payer included), in computeShares order
};

export type SettlePlanWithEarly = SettlePlan | SettleEarly;

/** Rule E (spec D2): the same four answers as SQL's private.settle_state. */
export type SettleState = 'final' | 'early' | 'not_complete' | 'all_zero';

/**
 * SE-11: differences of up to this many cents either way are not shown (W7 rounding moves a share by
 * at most 1¢). Starting value 1; 0 shows every cent. The DB has no tolerance.
 */
export const SETTLE_DIFF_IGNORE_CENTS = 1;

/** Q10 copy for 'blocked_all_zero'. */
export const SETTLE_ALL_ZERO_COPY = 'Every item is $0. Fix the prices, or switch to Split evenly.';

/**
 * Open question Q6 (a negative share: even mode with a big bill-level discount, or, since ADR 0017, a claimed
 * discount bigger than the person's items, in either mode).
 * Recommended option A: 'payer_owes_them' ("Sam owes you $1.00. Settle that outside the app.").
 * Option B would be 'nothing'. Either way it is never counted in collectCents or owingCount.
 */
export const NEGATIVE_SHARE_ROLE: 'payer_owes_them' | 'nothing' = 'payer_owes_them';

function roleFor(owedCents: number): Exclude<SettleRole, 'payer'> {
  if (owedCents > 0) return 'owes';
  if (owedCents < 0) return NEGATIVE_SHARE_ROLE;
  return 'nothing';
}

/** Σ cents of item rows (discounts excluded), from a computeShares result: claimed + unclaimed. */
function itemSum(shares: SplitResult): number {
  return shares.people.reduce((sum, p) => sum + p.itemsCents, shares.unclaimedItemsCents);
}

/**
 * The participants with a counted claim on a row of kind 'item' ($0 items included; a discount
 * claim alone doesn't count). computeShares lists every counted claimer in `byUser`, so this reads
 * the same normalized claims the split math uses (parts ≥ 1, known row, known participant).
 */
function itemClaimers(input: SplitInput, shares: SplitResult): Set<string> {
  const discounts = new Set(input.items.filter((i) => i.kind === 'discount').map((i) => i.id));
  const out = new Set<string>();
  for (const [id, split] of Object.entries(shares.items)) {
    if (discounts.has(id)) continue;
    for (const userId of Object.keys(split.byUser)) out.add(userId);
  }
  return out;
}

function allZeroFrom(input: SplitInput, shares: SplitResult): boolean {
  return input.extrasMode === 'proportional' && itemSum(shares) === 0 && shares.extrasCents !== 0;
}

/**
 * Rule Z (spec D2): proportional mode, every item row sums to $0, and the bill total isn't the rows'
 * sum (extras ≠ 0, discount rows included in that sum): there's nothing to spread the extras over.
 * On a complete bill it's exactly computeShares(...).unclaimedCents ≠ 0 (criterion 17a).
 */
export function allZero(input: SplitInput): boolean {
  return allZeroFrom(input, computeShares(input));
}

/**
 * Rule E (spec D2) with who-paid's E′: may `userId` mark paid on this bill? 'all_zero' (rule Z) wins,
 * then 'final' (complete, rule C1), then 'early' (one payer, proportional, and the user has a claim
 * on an item row), else 'not_complete'. A split payment (`mode` 'split') is never early. Being the
 * payer is checked elsewhere (the DB's is_payer, the view's payer card).
 */
export function maySettle(input: SplitInput, userId: string, mode: PayersMode = 'one'): SettleState {
  const shares = computeShares(input);
  if (allZeroFrom(input, shares)) return 'all_zero';
  if (sharesComplete(input).complete) return 'final';
  if (mode === 'one' && input.extrasMode === 'proportional' && itemClaimers(input, shares).has(userId)) return 'early';
  return 'not_complete';
}

/**
 * Contract D (spec D4) for one marked person: target = max(owed, 0), delta = target − mark.
 * |delta| ≤ ignoreCents → null. Throws RangeError for non-integer cents or a bad tolerance, so a bad
 * value never reads as "no difference". `ignoreCents` is a test seam (criterion 20).
 */
export function differenceFor(
  owedCents: number,
  markCents: number,
  ignoreCents: number = SETTLE_DIFF_IGNORE_CENTS,
): SettleDifference | null {
  if (!Number.isSafeInteger(owedCents) || !Number.isSafeInteger(markCents)) {
    throw new RangeError('differenceFor: cents must be integers');
  }
  if (!Number.isSafeInteger(ignoreCents) || ignoreCents < 0) {
    throw new RangeError('differenceFor: ignoreCents must be an integer ≥ 0');
  }
  const target = Math.max(owedCents, 0);
  const delta = target - markCents;
  if (Math.abs(delta) <= ignoreCents) return null;
  if (delta > 0) return { kind: 'more', cents: delta, fromCents: markCents, toCents: target };
  return { kind: 'back', cents: -delta, fromCents: markCents, toCents: target };
}

/** An entry's difference: null for the payer, unmarked people, and shares within tolerance. */
export function differenceOf(entry: SettleEntry | SettleEarlyEntry): SettleDifference | null {
  if (entry.role === 'payer') return null;
  return entry.difference ?? null;
}

type SettleOptions = { allowEarly?: boolean; notReceived?: SettleNotReceivedMap };

/** The two maps settlePlan takes, from fetched participants (BillMember has these fields). */
export function settleFactsOf(
  participants: readonly { userId: string; mark: SettleMark | null; notReceived: SettleNotReceived | null }[],
): { marks: SettleMarks; notReceived: SettleNotReceivedMap } {
  return {
    marks: Object.fromEntries(participants.map((p) => [p.userId, p.mark])),
    notReceived: Object.fromEntries(participants.map((p) => [p.userId, p.notReceived])),
  };
}

/**
 * Without options (or `allowEarly: false`) the result is today's SettlePlan: an incomplete bill is
 * 'blocked', even when all-$0. With `{ allowEarly: true }` (D2 table, A1.7): an incomplete all-$0
 * bill is 'blocked_all_zero', an incomplete proportional bill is 'early' (each non-payer carries
 * canSettle), and even mode stays 'blocked'. Complete bills give the same plan either way.
 * `notReceived` puts each person's flag on their entry (absent = null for everyone).
 */
export function settlePlan(
  input: SplitInput,
  payerId: string,
  marks: SettleMarks,
  opts?: { allowEarly?: false; notReceived?: SettleNotReceivedMap },
): SettlePlan;
export function settlePlan(
  input: SplitInput,
  payerId: string,
  marks: SettleMarks,
  opts: { allowEarly: true; notReceived?: SettleNotReceivedMap },
): SettlePlanWithEarly;
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts?: SettleOptions): SettlePlanWithEarly;
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts: SettleOptions = {}): SettlePlanWithEarly {
  if (!input.participantIds.includes(payerId)) return { status: 'blocked_bad_payer' };
  const flags = opts.notReceived ?? {};

  // Rule C1: the same rule as private.bill_is_complete (every row has at least one claim).
  const { complete, unclaimedRows, unclaimedDiscountRows } = sharesComplete(input);
  if (!complete) {
    if (opts.allowEarly !== true) return { status: 'blocked', unclaimedRows, unclaimedDiscountRows };
    return earlyPlan(input, payerId, marks, flags, unclaimedRows, unclaimedDiscountRows);
  }

  const shares = computeShares(input);
  // Q10. Checked as ≠ 0 rather than > 0 so a plan whose shares don't add up is never 'ready'.
  // On a complete bill this is exactly rule Z (criterion 17a).
  if (shares.unclaimedCents !== 0) return { status: 'blocked_all_zero' };

  let collectCents = 0;
  let owingCount = 0;
  let paidCount = 0;

  const people: SettleEntry[] = shares.people.map(({ userId, totalCents }) => {
    const mark = marks[userId] ?? null;
    const notReceived = flags[userId] ?? null;
    if (userId === payerId) return { userId, role: 'payer', mark, notReceived };
    const role = roleFor(totalCents);
    if (role === 'owes') {
      collectCents += totalCents;
      owingCount++;
      if (mark) paidCount++;
    }
    if (!mark) return { userId, role, owedCents: totalCents, mark, notReceived };
    const markDiffCents = totalCents - mark.cents;
    return {
      userId,
      role,
      owedCents: totalCents,
      mark,
      notReceived,
      markDiffCents,
      markDiffers: markDiffCents !== 0,
      difference: differenceFor(totalCents, mark.cents),
    };
  });

  return {
    status: 'ready',
    payerId,
    people,
    collectCents,
    owingCount,
    paidCount,
    allPaid: paidCount === owingCount,
  };
}

/** The incomplete branch with allowEarly (D2 table). Amounts are computeShares' "so far" totals. */
function earlyPlan(
  input: SplitInput,
  payerId: string,
  marks: SettleMarks,
  flags: SettleNotReceivedMap,
  unclaimedRows: number,
  unclaimedDiscountRows: number,
): SettlePlanWithEarly {
  const shares = computeShares(input);
  if (allZeroFrom(input, shares)) return { status: 'blocked_all_zero' };
  if (input.extrasMode !== 'proportional') return { status: 'blocked', unclaimedRows, unclaimedDiscountRows };

  // Incomplete, proportional, not all-$0: maySettle is 'early' exactly for item claimers.
  const claimers = itemClaimers(input, shares);
  const people: SettleEarlyEntry[] = shares.people.map(({ userId, totalCents }) => {
    const mark = marks[userId] ?? null;
    const notReceived = flags[userId] ?? null;
    if (userId === payerId) return { userId, role: 'payer', mark, notReceived };
    const entry = { userId, role: roleFor(totalCents), owedCents: totalCents, mark, notReceived, canSettle: claimers.has(userId) };
    return mark ? { ...entry, difference: differenceFor(totalCents, mark.cents) } : entry;
  });
  return { status: 'early', payerId, unclaimedRows, unclaimedDiscountRows, people };
}

// ---------------------------------------------------------------------------------------------------
// Who paid (Task 6): the plan from the payments ledger
// ---------------------------------------------------------------------------------------------------

/** A ledger entry or flag with a known method (BillPayment / BillPaymentFlag in lib/bills.ts). */
export type SettleLedgerFlag = { fromId: string; toId: string; cents: number; method: PaymentMethod };

/**
 * What ledgerSettlePlan reads from BillData: bills.payer_id (the one payer, or the split's lead),
 * the bill_payers rows (empty = one person), every bill_payments entry and every flag. fetchBill has
 * already checked that every id is a participant and the rows pass payersState.
 */
export type SettleLedger = {
  payerId: string;
  payers: readonly Payer[];
  payments: readonly Payment[];
  flags: readonly SettleLedgerFlag[];
};

/** One participant on a 'routes' plan. `canSettle`: rule E/E′ (always true on a complete bill). */
export type SettleRoutesPerson = { userId: string; paidCents: number; shareCents: number; canSettle: boolean };

/**
 * Several payers, or a single payer with money that moved between other people (A1.2): contract T's
 * pairs. `key` is the plan key a payment made from this plan is stamped with (Task 10's mark_paid).
 * `early` is set on an early single-payer plan (proportional, incomplete; never split, rule E′).
 * `allPaid`: every pair is paid within tolerance (outside routes never count, as today).
 */
export type SettleRoutes = {
  status: 'routes';
  key: string;
  mode: PayersMode;
  leadId: string;
  /** Lead first (payersState). One person = [{ leadId, total }]. */
  payers: Payer[];
  /** One per participant, by userId. */
  people: SettleRoutesPerson[];
  /** Ordered by fromId, then toId. */
  pairs: Pair[];
  outside: Outside[];
  provenance: Provenance;
  /** Every flag, as fetched (the views decide which still apply). */
  flags: SettleLedgerFlag[];
  allPaid: boolean;
  early: null | { unclaimedRows: number; unclaimedDiscountRows: number };
};

/**
 * A split whose amounts don't add up to the current total (contract W `stale`): no amounts until
 * the payer fixes it. Wins over 'blocked' and 'blocked_all_zero' (S8), as payers_stale does in the DB.
 * `gapCents` = total − assigned: > 0 left to assign, < 0 more than the total.
 */
export type SettleBlockedPayers = {
  status: 'blocked_payers';
  leadId: string;
  payers: Payer[];
  gapCents: number;
  assignedCents: number;
  totalCents: number;
};

export type BillSettlePlan = SettlePlanWithEarly | SettleRoutes | SettleBlockedPayers;

/**
 * The bill's settle plan from its ledger, and the current plan key (null when the plan shows no
 * amounts). First match wins:
 *   1. a payer (or payer_id) who isn't a participant → 'blocked_bad_payer';
 *   2. a stale split → 'blocked_payers' (S8: before incomplete and all-$0);
 *   3. one payer, every payment to or from them, and nobody's net to the payer below 0 → exactly
 *      today's settlePlan, with contract P's mark per person and each person's flag as notReceived
 *      (the one to the payer first; A1.7: single-payer bills unchanged);
 *   4. otherwise 'routes': incomplete → 'blocked' (no allowEarly), 'blocked_all_zero' (rule Z),
 *      'blocked' (split, rule E′, or even mode), else early routes; complete with cents left over →
 *      'blocked_all_zero'; else contract T.
 * Steps 1–2 and the completeness checks run before settleTransfers, so its RangeErrors (W, Σ ≠ 0)
 * can't be reached from valid BillData (N8).
 */
export function ledgerSettlePlan(
  input: SplitInput,
  ledger: SettleLedger,
  opts: { allowEarly?: boolean } = {},
): { plan: BillSettlePlan; planKey: string | null } {
  const none = (plan: BillSettlePlan) => ({ plan, planKey: null });
  const ids = new Set(input.participantIds);
  if (!ids.has(ledger.payerId) || !ledger.payers.every((p) => ids.has(p.userId))) return none({ status: 'blocked_bad_payer' });

  const w = payersState({ payerId: ledger.payerId, rows: ledger.payers, totalCents: input.totalCents });
  if (w.stale) {
    return none({
      status: 'blocked_payers',
      leadId: w.leadId,
      payers: w.payers,
      gapCents: w.gapCents,
      assignedCents: w.assignedCents,
      totalCents: input.totalCents,
    });
  }

  const payerId = w.leadId;
  const payments = ledger.payments;
  if (w.mode === 'one' && isLegacyLedger(input.participantIds, payerId, payments)) {
    const marks: Record<string, SettleMark | null> = {};
    const notReceived: Record<string, SettleNotReceived | null> = {};
    for (const userId of input.participantIds) {
      if (userId === payerId) continue;
      const mark = pairState(payments, userId, payerId).mark;
      marks[userId] = mark ? { cents: mark.cents, at: mark.at, method: mark.method, toUserId: payerId } : null;
    }
    // One flag per person, as today's entries carry: the one to the payer, else (a flag to an earlier
    // payer, which the views already ignore) the one to the lowest id, so the plan is deterministic.
    const flags = [...ledger.flags].sort((x, y) => Number(y.toId === payerId) - Number(x.toId === payerId) || (x.toId < y.toId ? -1 : x.toId > y.toId ? 1 : 0));
    for (const f of flags) {
      if (notReceived[f.fromId] === undefined) notReceived[f.fromId] = { cents: f.cents, method: f.method, toUserId: f.toId };
    }
    const plan = settlePlan(input, payerId, marks, { allowEarly: opts.allowEarly === true, notReceived });
    if (plan.status !== 'ready' && plan.status !== 'early') return none(plan);
    const shares = computeShares(input).people.map((p) => ({ userId: p.userId, shareCents: p.totalCents }));
    return { plan, planKey: currentPlanKey({ mode: 'one', leadId: payerId, payers: w.payers, shares, entries: payments }) };
  }

  const { complete, unclaimedRows, unclaimedDiscountRows } = sharesComplete(input);
  const shares = computeShares(input);
  let early: SettleRoutes['early'] = null;
  if (!complete) {
    if (opts.allowEarly !== true) return none({ status: 'blocked', unclaimedRows, unclaimedDiscountRows });
    if (allZeroFrom(input, shares)) return none({ status: 'blocked_all_zero' });
    if (w.mode === 'split' || input.extrasMode !== 'proportional') return none({ status: 'blocked', unclaimedRows, unclaimedDiscountRows });
    early = { unclaimedRows, unclaimedDiscountRows };
  } else if (shares.unclaimedCents !== 0) {
    return none({ status: 'blocked_all_zero' });
  }

  const t = settleTransfers({
    mode: w.mode,
    leadId: payerId,
    payers: w.payers,
    shares: shares.people.map((p) => ({ userId: p.userId, shareCents: p.totalCents })),
    entries: payments,
    early: early !== null,
  });
  const claimers = early === null ? null : itemClaimers(input, shares);
  const paidOf = new Map(w.payers.map((p) => [p.userId, p.paidCents]));
  const plan: SettleRoutes = {
    status: 'routes',
    key: t.key,
    mode: w.mode,
    leadId: payerId,
    payers: w.payers,
    people: shares.people.map((p) => ({
      userId: p.userId,
      paidCents: paidOf.get(p.userId) ?? 0,
      shareCents: p.totalCents,
      canSettle: claimers === null || claimers.has(p.userId),
    })),
    pairs: t.pairs,
    outside: t.outside,
    provenance: t.provenance,
    flags: ledger.flags.map((f) => ({ ...f })),
    allPaid: t.pairs.every((q) => (q.paidCents > 0 ? q.difference === null : q.remainingCents <= 0)),
    early,
  };
  return { plan, planKey: t.key };
}

/**
 * Today's single-payer shape: every entry is to or from the payer, and nobody has been paid back
 * more than they sent (a net < 0 to the payer has no mark, so today's plan couldn't show it).
 */
function isLegacyLedger(participantIds: readonly string[], payerId: string, payments: readonly Payment[]): boolean {
  if (!payments.every((e) => e.fromId === payerId || e.toId === payerId)) return false;
  return participantIds.every((u) => u === payerId || pairState(payments, u, payerId).net >= 0);
}

/**
 * S2: the viewer's balance on a plan, in cents (contract O). Per pair the viewer is on:
 * paid > 0 → the difference ('more' +cents, 'back' −cents, none 0), else the remaining. As `from`, a
 * positive amount is owed by the viewer and a negative one owed to them; as `to`, the mirror.
 * Outside routes never count. `final` = the plan is complete (not early). Unknown on a plan with no
 * amounts, or for someone not in it. On a single-payer plan, the payer's owedCents is Home's
 * stillToCollectCents and owes/owed > 0 are viewerBalance's booleans.
 */
export type SettleBalance = { known: false } | { known: true; final: boolean; owesCents: number; owedCents: number };

export function balanceFor(plan: BillSettlePlan, userId: string): SettleBalance {
  let pairs: readonly Pair[];
  let final: boolean;
  if (plan.status === 'ready' || plan.status === 'early') {
    if (!(plan.people as readonly { userId: string }[]).some((p) => p.userId === userId)) return { known: false };
    pairs = transfersFromReadyPlan(plan).pairs;
    final = plan.status === 'ready';
  } else if (plan.status === 'routes') {
    if (!plan.people.some((p) => p.userId === userId)) return { known: false };
    pairs = plan.pairs;
    final = plan.early === null;
  } else {
    return { known: false };
  }
  let owesCents = 0;
  let owedCents = 0;
  for (const q of pairs) {
    if (q.fromId !== userId && q.toId !== userId) continue;
    const d = q.difference;
    const amt = q.paidCents > 0 ? (d === null ? 0 : d.kind === 'more' ? d.cents : -d.cents) : q.remainingCents;
    const forViewer = q.fromId === userId ? amt : -amt;
    if (forViewer > 0) owesCents += forViewer;
    else if (forViewer < 0) owedCents -= forViewer;
  }
  return { known: true, final, owesCents, owedCents };
}
