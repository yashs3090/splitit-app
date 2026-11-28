// Group balances (spec docs/specs/2026-11-26-groups-mvp.md § C-G1, C-G2). Pure, integer cents.
//
// lib only, on purpose: the database computes no balances (GR-1, GR-2). A receipt counts only once
// it is fully claimed and not all-$0 (U-G3); until then it adds nothing to anyone. Every member's
//   net = paid − share + sent − received
// and the nets sum to exactly 0. Any bad value throws RangeError: never a wrong number.

import { computeShares, sharesComplete, type SplitInput } from './split';

export type GroupBill = { id: string; payerId: string; totalCents: number; split: SplitInput };
export type GroupExpenseShare = { userId: string; cents: number };
export type GroupExpense = { id: string; payerId: string; amountCents: number; shares: GroupExpenseShare[] };
export type GroupPayment = { from: string; to: string; cents: number };
/** Live rows only (deleted expenses and undone payments are left out by the caller). */
export type GroupBalanceInput = {
  members: string[];
  bills: GroupBill[];
  expenses: GroupExpense[];
  payments: GroupPayment[];
};

export type MemberBalance = {
  userId: string;
  paidCents: number;
  shareCents: number;
  sentCents: number;
  receivedCents: number;
  /** Positive = owed money; negative = owes. */
  netCents: number;
};
export type WaitingReason = 'incomplete' | 'all_zero';
export type WaitingBill = {
  billId: string;
  reason: WaitingReason;
  unclaimedRows: number;
  unclaimedDiscountRows: number;
  /** Rows with no counted claim, in input row order, each once (S1/S9: T10 names 1–2 of them). */
  unclaimedRowIds: string[];
};
export type GroupBalances = {
  /** One per member, in input order. */
  members: MemberBalance[];
  /** Bills that count, in input order. */
  counting: string[];
  /** Bills that don't count yet, in input order. */
  waiting: WaitingBill[];
};

type Totals = { paid: number; share: number; sent: number; received: number };

function add(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new RangeError('groupBalances: sum out of the safe-integer range');
  return s;
}

function int(v: number, min: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`groupBalances: ${what} must be an integer ≥ ${min}`);
  return v;
}

export function groupBalances(input: GroupBalanceInput): GroupBalances {
  const totals = new Map<string, Totals>();
  for (const id of input.members) {
    if (totals.has(id)) throw new RangeError('groupBalances: duplicate member');
    totals.set(id, { paid: 0, share: 0, sent: 0, received: 0 });
  }
  const of = (userId: string, what: string): Totals => {
    const t = totals.get(userId);
    if (!t) throw new RangeError(`groupBalances: ${what} is not a member`);
    return t;
  };

  const counting: string[] = [];
  const waiting: WaitingBill[] = [];
  const billIds = new Set<string>();
  for (const bill of input.bills) {
    if (billIds.has(bill.id)) throw new RangeError('groupBalances: duplicate bill');
    billIds.add(bill.id);
    int(bill.totalCents, 0, 'a bill total');
    if (bill.split.totalCents !== bill.totalCents) throw new RangeError("groupBalances: bill total differs from its split's");
    const payer = of(bill.payerId, 'a bill payer');
    for (const u of bill.split.participantIds) of(u, 'a bill participant');

    // C-G1: fully claimed (rule C1) and nothing left unassigned (excludes all-$0, rule Z).
    // Both throw RangeError on bad rows, so a bad bill never counts silently.
    const done = sharesComplete(bill.split);
    const res = computeShares(bill.split);
    if (!done.complete || res.unclaimedCents !== 0) {
      const unclaimedRowIds = [...new Set(bill.split.items.map((i) => i.id))].filter((id) => res.items[id]?.status === 'unclaimed');
      waiting.push({
        billId: bill.id,
        reason: done.complete ? 'all_zero' : 'incomplete',
        unclaimedRows: done.unclaimedRows,
        unclaimedDiscountRows: done.unclaimedDiscountRows,
        unclaimedRowIds,
      });
      continue;
    }
    counting.push(bill.id);
    payer.paid = add(payer.paid, bill.totalCents);
    for (const p of res.people) {
      const t = of(p.userId, 'a bill participant');
      t.share = add(t.share, p.totalCents); // may be 0 or negative (claimed discounts, CD-6)
    }
  }

  for (const e of input.expenses) {
    int(e.amountCents, 1, 'an expense amount');
    const payer = of(e.payerId, 'an expense payer');
    const seen = new Set<string>();
    let sharesSum = 0;
    for (const s of e.shares) {
      int(s.cents, 0, "an expense share's cents");
      if (seen.has(s.userId)) throw new RangeError('groupBalances: duplicate expense share');
      seen.add(s.userId);
      of(s.userId, 'an expense share user');
      sharesSum = add(sharesSum, s.cents);
    }
    if (sharesSum !== e.amountCents) throw new RangeError('groupBalances: expense shares must add up to the amount');
    payer.paid = add(payer.paid, e.amountCents);
    for (const s of e.shares) {
      const t = of(s.userId, 'an expense share user');
      t.share = add(t.share, s.cents);
    }
  }

  for (const p of input.payments) {
    int(p.cents, 1, 'a payment');
    if (p.from === p.to) throw new RangeError('groupBalances: a payment needs two people');
    const from = of(p.from, 'a payment sender');
    const to = of(p.to, 'a payment receiver');
    from.sent = add(from.sent, p.cents);
    to.received = add(to.received, p.cents);
  }

  const members = input.members.map((userId): MemberBalance => {
    const t = of(userId, 'a member');
    const netCents = add(add(t.paid, -t.share), add(t.sent, -t.received));
    return { userId, paidCents: t.paid, shareCents: t.share, sentCents: t.sent, receivedCents: t.received, netCents };
  });
  // S6: the backstop. The checks above should make this unreachable; if anything slips through,
  // fail rather than show balances that don't add up.
  if (members.reduce((s, m) => add(s, m.netCents), 0) !== 0) throw new RangeError('groupBalances: nets do not sum to 0');
  return { members, counting, waiting };
}

/** user id → net cents, for `simplify`. */
export function netsOf(balances: GroupBalances): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of balances.members) out[m.userId] = m.netCents;
  return out;
}
