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
import { computeShares, sharesComplete, type SplitInput, type SplitResult } from './split';

/** One person's "I paid": the amount the screen showed and when they tapped it. */
export type SettleMark = { cents: number; at: string };
/** userId → mark (missing or null = not marked). */
export type SettleMarks = Readonly<Record<string, SettleMark | null | undefined>>;

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

type PayerEntry = { userId: string; role: 'payer'; mark: SettleMark | null }; // the payer's share is never collected
type OwerFields = { userId: string; role: Exclude<SettleRole, 'payer'>; owedCents: number; mark: SettleMark | null };

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
 * Rule E (spec D2): may `userId` mark paid on this bill? 'all_zero' (rule Z) wins, then 'final'
 * (complete, rule C1), then 'early' (proportional, and the user has a claim on an item row), else
 * 'not_complete'. Being the payer is checked elsewhere (the DB's is_payer, the view's payer card).
 */
export function maySettle(input: SplitInput, userId: string): SettleState {
  const shares = computeShares(input);
  if (allZeroFrom(input, shares)) return 'all_zero';
  if (sharesComplete(input).complete) return 'final';
  if (input.extrasMode === 'proportional' && itemClaimers(input, shares).has(userId)) return 'early';
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

type SettleOptions = { allowEarly?: boolean };

/**
 * Without options (or `allowEarly: false`) the result is today's SettlePlan: an incomplete bill is
 * 'blocked', even when all-$0. With `{ allowEarly: true }` (D2 table, A1.7): an incomplete all-$0
 * bill is 'blocked_all_zero', an incomplete proportional bill is 'early' (each non-payer carries
 * canSettle), and even mode stays 'blocked'. Complete bills give the same plan either way.
 */
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts?: { allowEarly?: false }): SettlePlan;
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts: { allowEarly: true }): SettlePlanWithEarly;
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts?: SettleOptions): SettlePlanWithEarly;
export function settlePlan(input: SplitInput, payerId: string, marks: SettleMarks, opts: SettleOptions = {}): SettlePlanWithEarly {
  if (!input.participantIds.includes(payerId)) return { status: 'blocked_bad_payer' };

  // Rule C1: the same rule as private.bill_is_complete (every row has at least one claim).
  const { complete, unclaimedRows, unclaimedDiscountRows } = sharesComplete(input);
  if (!complete) {
    if (opts.allowEarly !== true) return { status: 'blocked', unclaimedRows, unclaimedDiscountRows };
    return earlyPlan(input, payerId, marks, unclaimedRows, unclaimedDiscountRows);
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
    if (userId === payerId) return { userId, role: 'payer', mark };
    const role = roleFor(totalCents);
    if (role === 'owes') {
      collectCents += totalCents;
      owingCount++;
      if (mark) paidCount++;
    }
    if (!mark) return { userId, role, owedCents: totalCents, mark };
    const markDiffCents = totalCents - mark.cents;
    return {
      userId,
      role,
      owedCents: totalCents,
      mark,
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
    if (userId === payerId) return { userId, role: 'payer', mark };
    const entry = { userId, role: roleFor(totalCents), owedCents: totalCents, mark, canSettle: claimers.has(userId) };
    return mark ? { ...entry, difference: differenceFor(totalCents, mark.cents) } : entry;
  });
  return { status: 'early', payerId, unclaimedRows, unclaimedDiscountRows, people };
}
