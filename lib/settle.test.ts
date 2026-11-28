import {
  allZero,
  balanceFor,
  differenceFor,
  differenceOf,
  ledgerSettlePlan,
  maySettle,
  NEGATIVE_SHARE_ROLE,
  SETTLE_ALL_ZERO_COPY,
  SETTLE_DIFF_IGNORE_CENTS,
  settleFactsOf,
  settlePlan,
  type BillSettlePlan,
  type SettleBalance,
  type SettleEarly,
  type SettleEarlyEntry,
  type SettleEntry,
  type SettleLedger,
  type SettleMark,
  type SettleMarks,
  type SettleNotReceived,
  type SettleNotReceivedMap,
  type SettlePlan,
  type SettlePlanWithEarly,
  type SettleReady,
  type SettleRoutes,
} from './settle';
import { currentPlanKey, planKey, settleTransfers, transfersFromReadyPlan, type Payment } from './transfers';
import type { PaymentMethod } from './paymentMethods';
import { computeShares, sharesComplete, type ExtrasMode, type SplitClaim, type SplitInput, type SplitItem } from './split';

// Seeded integer-only PRNG (mulberry32), so failures are reproducible.
function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n; // integer in [0, n)
  };
}

const c = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });
const NO_MARKS: SettleMarks = {};
/** A mark as fetchBill parses it (sent-via-Venmo D7): to the plan's payer, method 'other' unless said. */
const mk = (cents: number, at: string, toUserId = 'A', method: PaymentMethod = 'other'): SettleMark => ({ cents, at, method, toUserId });

function ready(plan: SettlePlan): SettleReady {
  if (plan.status !== 'ready') throw new Error(`expected ready, got ${plan.status}`);
  return plan;
}

function entry(plan: SettleReady, userId: string) {
  const e = plan.people.find((p) => p.userId === userId);
  if (!e) throw new Error(`no entry for ${userId}`);
  return e;
}

// D3 worked example: Hana (A) hosts, Sam (B) joined. Burger 1500 (A), Salad 1000 (B), Fries 600 (A+B).
const WORKED_ITEMS: SplitItem[] = [
  { id: 'burger', totalCents: 1500 },
  { id: 'salad', totalCents: 1000 },
  { id: 'fries', totalCents: 600 },
];
const WORKED_CLAIMS: SplitClaim[] = [c('burger', 'A'), c('salad', 'B'), c('fries', 'A'), c('fries', 'B')];
function worked(extrasMode: ExtrasMode = 'proportional'): SplitInput {
  return { totalCents: 3600, items: WORKED_ITEMS, claims: WORKED_CLAIMS, participantIds: ['A', 'B'], extrasMode };
}

// Boundary cases K1–K5 (spec C1), shared with supabase/tests/database/settle_marks.test.sql.
const K_ITEMS: SplitItem[] = [
  { id: 'burger', totalCents: 1500 },
  { id: 'beer-0', totalCents: 700 }, // "Beer ×2" as two unit rows
  { id: 'beer-1', totalCents: 700 },
  { id: 'water', totalCents: 0 },
];
const K_ALL_CLAIMED: SplitClaim[] = [c('burger', 'A'), c('beer-0', 'A'), c('beer-1', 'B'), c('water', 'B')];
function kBill(items: SplitItem[], claims: SplitClaim[]): SplitInput {
  return { totalCents: 3400, items, claims, participantIds: ['A', 'B'], extrasMode: 'proportional' };
}
const K_CASES: { name: string; input: SplitInput; blocked: boolean }[] = [
  { name: 'K1 every row claimed', input: kBill(K_ITEMS, K_ALL_CLAIMED), blocked: false },
  {
    name: 'K2 beer unit 1 unclaimed',
    input: kBill(K_ITEMS, K_ALL_CLAIMED.filter((x) => x.itemId !== 'beer-1')),
    blocked: true,
  },
  {
    name: 'K3 only the $0.00 row unclaimed',
    input: kBill(K_ITEMS, K_ALL_CLAIMED.filter((x) => x.itemId !== 'water')),
    blocked: true,
  },
  { name: 'K4 one row shared by two', input: kBill(K_ITEMS, [...K_ALL_CLAIMED, c('burger', 'B')]), blocked: false },
  {
    name: 'K5 K1 plus a new host-added row',
    input: { ...kBill([...K_ITEMS, { id: 'dessert', totalCents: 0 }], K_ALL_CLAIMED), totalCents: 3400 },
    blocked: true,
  },
];

describe('settlePlan: blocked until complete (criterion 31, C1)', () => {
  it.each(K_CASES)('$name', ({ input, blocked }) => {
    const plan = settlePlan(input, 'A', NO_MARKS);
    const complete = sharesComplete(input);
    expect(complete.complete).toBe(!blocked);
    if (blocked) {
      expect(plan).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
      expect(complete.unclaimedRows).toBe(1);
    } else {
      expect(plan.status).toBe('ready');
    }
  });

  it('blocked results carry no amounts (even mode keeps totals hidden)', () => {
    const input = { ...worked('equal'), claims: WORKED_CLAIMS.filter((x) => x.itemId !== 'salad') };
    const plan = settlePlan(input, 'A', NO_MARKS);
    expect(plan).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
  });
});

describe('settlePlan: worked example (criterion 32, D3)', () => {
  it('proportional, payer A: Sam owes 1510', () => {
    const plan = ready(settlePlan(worked(), 'A', NO_MARKS));
    expect(plan.payerId).toBe('A');
    expect(entry(plan, 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: 1510, mark: null, notReceived: null });
    expect(entry(plan, 'A')).toEqual({ userId: 'A', role: 'payer', mark: null, notReceived: null });
    expect('owedCents' in entry(plan, 'A')).toBe(false);
    expect(plan.collectCents).toBe(1510);
  });

  it('proportional, payer B: Hana owes 2090', () => {
    const plan = ready(settlePlan(worked(), 'B', NO_MARKS));
    expect(entry(plan, 'A')).toEqual({ userId: 'A', role: 'owes', owedCents: 2090, mark: null, notReceived: null });
    expect(entry(plan, 'B').role).toBe('payer');
    expect(plan.collectCents).toBe(2090);
  });

  it('even, payer A: Sam owes 1550', () => {
    const plan = ready(settlePlan(worked('equal'), 'A', NO_MARKS));
    expect(entry(plan, 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: 1550, mark: null, notReceived: null });
  });

  it('three-way tie: the lowest user id gets the spare cent and owes it', () => {
    // Items $5/$3/$2, $10 tip split evenly → tips 334/333/333; 'a' is lowest by code unit.
    const input: SplitInput = {
      totalCents: 2000,
      items: [
        { id: 'x', totalCents: 500 },
        { id: 'y', totalCents: 300 },
        { id: 'z', totalCents: 200 },
      ],
      claims: [c('x', 'a'), c('y', 'b'), c('z', 'c')],
      participantIds: ['c', 'b', 'a'],
      extrasMode: 'equal',
    };
    const plan = ready(settlePlan(input, 'c', NO_MARKS));
    expect(entry(plan, 'a')).toMatchObject({ role: 'owes', owedCents: 834 });
    expect(entry(plan, 'b')).toMatchObject({ role: 'owes', owedCents: 633 });
    expect(plan.collectCents).toBe(1467);
    expect(plan.people.map((p) => p.userId)).toEqual(['a', 'b', 'c']); // computeShares order
  });
});

describe('settlePlan: roles (criterion 34)', () => {
  it('a participant with no claims owes nothing', () => {
    const input = { ...worked(), participantIds: ['A', 'B', 'D'] };
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'D')).toEqual({ userId: 'D', role: 'nothing', owedCents: 0, mark: null, notReceived: null });
    expect(plan.owingCount).toBe(1);
  });

  it('a participant with only $0.00 rows in proportional mode owes nothing', () => {
    const input: SplitInput = {
      totalCents: 1100,
      items: [
        { id: 'meal', totalCents: 1000 },
        { id: 'water', totalCents: 0 },
      ],
      claims: [c('meal', 'A'), c('water', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    };
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'B')).toMatchObject({ role: 'nothing', owedCents: 0 });
    expect(plan.collectCents).toBe(0);
  });

  it('a negative share (even mode, items 1000/0, total 800) is payer_owes_them with -100', () => {
    const input: SplitInput = {
      totalCents: 800,
      items: [
        { id: 'meal', totalCents: 1000 },
        { id: 'water', totalCents: 0 },
      ],
      claims: [c('meal', 'A'), c('water', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: 'equal',
    };
    expect(NEGATIVE_SHARE_ROLE).toBe('payer_owes_them'); // Q6 option A
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'B')).toEqual({ userId: 'B', role: 'payer_owes_them', owedCents: -100, mark: null, notReceived: null });
    expect(plan.collectCents).toBe(0); // only positive amounts are collected
    expect(plan.owingCount).toBe(0);

    // With the other person as payer, A owes 900 (more than the bill total; C2 allows it).
    const flipped = ready(settlePlan(input, 'B', NO_MARKS));
    expect(entry(flipped, 'A')).toMatchObject({ role: 'owes', owedCents: 900 });
  });
});

describe('settlePlan: marks (criterion 35)', () => {
  // Payer A; B owes 500 and D owes 300; E owes nothing (no claims).
  const input: SplitInput = {
    totalCents: 1800,
    items: [
      { id: 'a', totalCents: 1000 },
      { id: 'b', totalCents: 500 },
      { id: 'd', totalCents: 300 },
    ],
    claims: [c('a', 'A'), c('b', 'B'), c('d', 'D')],
    participantIds: ['A', 'B', 'D', 'E'],
    extrasMode: 'proportional',
  };
  const markB = mk(500, '2026-11-24T10:00:00Z');
  const markD = mk(300, '2026-11-24T10:05:00Z');

  it('no marks', () => {
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(plan).toMatchObject({ collectCents: 800, paidCount: 0, owingCount: 2, allPaid: false });
  });

  it('some marked', () => {
    const plan = ready(settlePlan(input, 'A', { B: markB, D: null }));
    expect(plan).toMatchObject({ collectCents: 800, paidCount: 1, owingCount: 2, allPaid: false });
    expect(entry(plan, 'B').mark).toEqual(markB);
    expect(entry(plan, 'D').mark).toBeNull();
  });

  it('all marked', () => {
    const plan = ready(settlePlan(input, 'A', { B: markB, D: markD }));
    expect(plan).toMatchObject({ collectCents: 800, paidCount: 2, owingCount: 2, allPaid: true });
  });

  it("a mark on someone whose role is 'nothing' doesn't count", () => {
    const plan = ready(settlePlan(input, 'A', { B: markB, E: mk(100, '2026-11-24T10:06:00Z') }));
    expect(entry(plan, 'E')).toMatchObject({ role: 'nothing', mark: { cents: 100 } });
    expect(plan).toMatchObject({ paidCount: 1, owingCount: 2, allPaid: false });
  });

  it('a mark keeps its own cents even when the share has changed since', () => {
    const plan = ready(settlePlan(input, 'A', { B: mk(450, '2026-11-24T10:00:00Z') }));
    expect(entry(plan, 'B')).toMatchObject({ owedCents: 500, mark: { cents: 450 } });
    expect(plan.paidCount).toBe(1);
  });

  it('nobody owes anything: allPaid is true (nothing to collect)', () => {
    const solo: SplitInput = { ...input, claims: [c('a', 'A'), c('b', 'A'), c('d', 'A')] };
    const plan = ready(settlePlan(solo, 'A', NO_MARKS));
    expect(plan).toMatchObject({ collectCents: 0, paidCount: 0, owingCount: 0, allPaid: true });
  });
});

describe('settlePlan: every item $0 in proportional mode (Q10)', () => {
  // Every row claimed and $0.00, total above zero: proportional mode has no weights, so
  // computeShares leaves the extras with nobody. Settling is blocked instead of showing $0 shares.
  const allZero: SplitInput = {
    totalCents: 500,
    items: [{ id: 'free', totalCents: 0 }],
    claims: [c('free', 'A'), c('free', 'B')],
    participantIds: ['A', 'B'],
    extrasMode: 'proportional',
  };

  it('is blocked_all_zero, with no amounts', () => {
    expect(computeShares(allZero).unclaimedCents).toBe(500); // the cause
    expect(settlePlan(allZero, 'A', NO_MARKS)).toEqual({ status: 'blocked_all_zero' });
    expect(settlePlan(allZero, 'B', { A: mk(100, '2026-11-24T10:00:00Z', 'B') })).toEqual({
      status: 'blocked_all_zero',
    });
  });

  it('several $0.00 rows, each claimed, are blocked too', () => {
    const input: SplitInput = {
      ...allZero,
      items: [
        { id: 'free', totalCents: 0 },
        { id: 'water', totalCents: 0 },
      ],
      claims: [c('free', 'A'), c('water', 'B')],
      totalCents: 1,
    };
    expect(settlePlan(input, 'A', NO_MARKS)).toEqual({ status: 'blocked_all_zero' });
  });

  it('has fixed copy', () => {
    expect(SETTLE_ALL_ZERO_COPY).toBe('Every item is $0. Fix the prices, or switch to Split evenly.');
  });

  it('even mode splits the same bill among the claimers, so it is ready', () => {
    const even = ready(settlePlan({ ...allZero, extrasMode: 'equal' }, 'A', NO_MARKS));
    expect(entry(even, 'B')).toMatchObject({ role: 'owes', owedCents: 250 });
  });

  it('all $0.00 rows with a $0.00 total is ready (nothing to collect)', () => {
    const plan = ready(settlePlan({ ...allZero, totalCents: 0 }, 'A', NO_MARKS));
    expect(plan).toMatchObject({ collectCents: 0, owingCount: 0, allPaid: true });
  });

  it('one non-zero row is enough for proportional mode to be ready', () => {
    const input: SplitInput = {
      ...allZero,
      items: [
        { id: 'free', totalCents: 0 },
        { id: 'meal', totalCents: 1 },
      ],
      claims: [c('free', 'A'), c('meal', 'B')],
    };
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'B')).toMatchObject({ role: 'owes', owedCents: 500 });
  });

  it('incomplete wins over all-zero (the unclaimed count is the more useful message)', () => {
    const input: SplitInput = { ...allZero, claims: [] };
    expect(settlePlan(input, 'A', NO_MARKS)).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
  });

  it('a bad payer wins over all-zero', () => {
    expect(settlePlan(allZero, 'C', NO_MARKS)).toEqual({ status: 'blocked_bad_payer' });
  });
});

describe('settlePlan: bad payer (criterion 36)', () => {
  it('a payer who is not a participant gives blocked_bad_payer', () => {
    expect(settlePlan(worked(), 'C', NO_MARKS)).toEqual({ status: 'blocked_bad_payer' });
    expect(settlePlan(worked(), '', NO_MARKS)).toEqual({ status: 'blocked_bad_payer' });
  });

  it('a bad payer wins over blocked, so no result is ever silently wrong', () => {
    const incomplete = { ...worked(), claims: [] };
    expect(settlePlan(incomplete, 'C', NO_MARKS)).toEqual({ status: 'blocked_bad_payer' });
  });

  it('duplicate participant ids still give one entry each', () => {
    const plan = ready(settlePlan({ ...worked(), participantIds: ['A', 'B', 'A'] }, 'A', NO_MARKS));
    expect(plan.people.map((p) => p.userId)).toEqual(['A', 'B']);
  });
});

/** Random complete bill: every row has at least one claim. Includes $0 rows, shared rows, odd parts. */
function randomCompleteBill(r: (n: number) => number, extrasMode: ExtrasMode): SplitInput {
  const nPeople = 1 + r(5); // 1..5
  const participantIds = Array.from({ length: nPeople }, (_, i) => `user-${i}-${r(1000)}`);
  const nItems = 1 + r(12);
  const items: SplitItem[] = Array.from({ length: nItems }, (_, i) => ({
    id: `item-${i}`,
    totalCents: r(5) === 0 ? 0 : r(100_000),
  }));
  const claims: SplitClaim[] = [];
  for (const it of items) {
    const first = r(nPeople);
    participantIds.forEach((u, i) => {
      if (i === first || r(3) === 0) claims.push({ itemId: it.id, userId: u, parts: 1 + r(25) });
    });
  }
  const itemsSum = items.reduce((s, i) => s + i.totalCents, 0);
  const extras = r(4) === 0 ? -r(Math.floor(itemsSum / 2) + 1) : r(50_000);
  return { totalCents: itemsSum + extras, items, claims, participantIds, extrasMode };
}

describe('settlePlan: property test (criterion 33)', () => {
  it('500 seeded complete bills in both modes: non-payer owed + payer share === total', () => {
    const r = rng(33);
    let allZeroBills = 0;
    for (let n = 0; n < 500; n++) {
      const mode: ExtrasMode = n % 2 === 0 ? 'proportional' : 'equal';
      const input = randomCompleteBill(r, mode);
      const payerId = input.participantIds[r(input.participantIds.length)] as string;
      const shares = computeShares(input);
      const plan = settlePlan(input, payerId, NO_MARKS);

      // Q10: the only complete bills that aren't ready are proportional ones whose rows are all
      // $0.00 with a non-zero total, exactly when computeShares leaves cents with nobody.
      const allZeroRows = input.items.every((i) => i.totalCents === 0);
      if (shares.unclaimedCents !== 0) {
        expect(mode === 'proportional' && allZeroRows && input.totalCents !== 0).toBe(true);
        expect(plan).toEqual({ status: 'blocked_all_zero' });
        allZeroBills++;
        continue;
      }
      const readyPlan = ready(plan);

      let owedSum = 0;
      let collect = 0;
      for (const e of readyPlan.people) {
        const share = shares.people.find((p) => p.userId === e.userId);
        if (!share) throw new Error('missing share');
        if (e.role === 'payer') {
          expect(e.userId).toBe(payerId);
          continue;
        }
        expect(Number.isSafeInteger(e.owedCents)).toBe(true);
        expect(e.owedCents).toBe(share.totalCents);
        owedSum += e.owedCents;
        if (e.owedCents > 0) collect += e.owedCents;
      }
      const payerShare = shares.people.find((p) => p.userId === payerId)?.totalCents ?? Number.NaN;
      expect(owedSum + payerShare).toBe(input.totalCents); // the D3 invariant, exactly
      expect(readyPlan.collectCents).toBe(collect);
      expect(readyPlan.people.filter((e) => e.role === 'payer')).toHaveLength(1);
    }
    expect(allZeroBills).toBeLessThan(25); // the edge case stays an edge case in the sample
  });
});

describe('settlePlan: share changed since the mark (criterion 41a, Q3 A)', () => {
  const MARK = mk(1510, '2026-11-24T10:00:00Z');
  /** Payer A; B's current share is exactly `bCents` (no extras), or one of the special shapes. */
  function planWithB(bCents: number | 'none' | 'negative'): SettleReady {
    if (bCents === 'negative') {
      // Even mode, items 1000 (A) and 0 (B), total 800: extras -200 split evenly, so B = -100.
      const input: SplitInput = {
        totalCents: 800,
        items: [
          { id: 'a', totalCents: 1000 },
          { id: 'b', totalCents: 0 },
        ],
        claims: [c('a', 'A'), c('b', 'B')],
        participantIds: ['A', 'B'],
        extrasMode: 'equal',
      };
      return ready(settlePlan(input, 'A', { B: MARK }));
    }
    const bRow = bCents === 'none' ? [] : [{ id: 'b', totalCents: bCents }];
    const input: SplitInput = {
      totalCents: 1000 + (bCents === 'none' ? 0 : bCents),
      items: [{ id: 'a', totalCents: 1000 }, ...bRow],
      claims: [c('a', 'A'), ...(bCents === 'none' ? [] : [c('b', 'B')])],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    };
    return ready(settlePlan(input, 'A', { B: MARK }));
  }

  it.each([
    [1620, 1620, 110],
    [1400, 1400, -110],
    ['none', 0, -1510],
    ['negative', -100, -1610],
  ] as const)('share %s → owed %i, diff %i', (shape, owed, diff) => {
    const b = entry(planWithB(shape), 'B');
    expect(b).toMatchObject({ owedCents: owed, markDiffCents: diff, markDiffers: true });
  });

  it('an unchanged share has diff 0 and markDiffers false', () => {
    expect(entry(planWithB(1510), 'B')).toMatchObject({ owedCents: 1510, markDiffCents: 0, markDiffers: false });
  });

  it('unmarked people have neither field', () => {
    const plan = ready(settlePlan(worked(), 'A', NO_MARKS));
    const b = entry(plan, 'B');
    expect('markDiffCents' in b).toBe(false);
    expect('markDiffers' in b).toBe(false);
  });
});

describe('C1 K6: the Q10 gap, recorded on purpose (review R2)', () => {
  // Same bill as supabase/tests/database/settle_marks.test.sql K6: Bread 0 (A), Water 0 (B), total 500.
  const k6: SplitInput = {
    totalCents: 500,
    items: [
      { id: 'bread', totalCents: 0 },
      { id: 'water', totalCents: 0 },
    ],
    claims: [c('bread', 'A'), c('water', 'B')],
    participantIds: ['A', 'B'],
    extrasMode: 'proportional',
  };
  it('lib: complete by C1, but blocked_all_zero (the DB calls it complete and accepts a mark)', () => {
    expect(sharesComplete(k6).complete).toBe(true);
    expect(settlePlan(k6, 'A', NO_MARKS)).toEqual({ status: 'blocked_all_zero' });
  });
});

// docs/specs/2026-11-24-people-and-invites.md § D5 (criterion 27): the M3 worked example plus Cy
// (C), whom the host added and who claims nothing. Nothing in settlePlan changes for them.
describe('settlePlan: an added person who claims nothing (SP1–SP3)', () => {
  function withCy(extrasMode: ExtrasMode, claims: SplitClaim[] = WORKED_CLAIMS): SplitInput {
    return { ...worked(extrasMode), claims, participantIds: ['A', 'B', 'C'] };
  }

  /** Σ owed by non-payers + the payer's own share = the bill total, exactly (the D3 invariant). */
  function expectInvariant(input: SplitInput, plan: SettleReady) {
    let owedSum = 0;
    for (const e of plan.people) if (e.role !== 'payer') owedSum += e.owedCents;
    const payerShare = computeShares(input).people.find((p) => p.userId === plan.payerId)?.totalCents ?? Number.NaN;
    expect(owedSum + payerShare).toBe(input.totalCents);
  }

  it("SP1 proportional: Cy is 'nothing' with 0, Sam still owes 1510 to Hana", () => {
    const input = withCy('proportional');
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'C')).toEqual({ userId: 'C', role: 'nothing', owedCents: 0, mark: null, notReceived: null });
    expect(entry(plan, 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: 1510, mark: null, notReceived: null });
    expect(plan.collectCents).toBe(1510);
    expect(plan.owingCount).toBe(1);
    expectInvariant(input, plan);
  });

  it("SP2 even: Cy is 'nothing'; Sam owes 1550 (extras split between the 2 claimers only)", () => {
    const input = withCy('equal');
    const plan = ready(settlePlan(input, 'A', NO_MARKS));
    expect(entry(plan, 'C')).toEqual({ userId: 'C', role: 'nothing', owedCents: 0, mark: null, notReceived: null });
    expect(entry(plan, 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: 1550, mark: null, notReceived: null });
    expect(plan.owingCount).toBe(1);
    expectInvariant(input, plan);
  });

  it('SP1/SP2: Cy never blocks "all paid" once Sam has marked', () => {
    const plan = ready(settlePlan(withCy('proportional'), 'A', { B: mk(1510, '2026-11-24T10:00:00Z') }));
    expect(plan.allPaid).toBe(true);
  });

  it.each<[string, SplitClaim[]]>([
    ['Cy claims nothing', WORKED_CLAIMS.filter((x) => x.itemId !== 'salad')],
    ['Cy claims a share of the fries', [...WORKED_CLAIMS.filter((x) => x.itemId !== 'salad'), c('fries', 'C')]],
  ])("SP3 the Salad row unclaimed is 'blocked' with 1 row, whatever Cy does (%s)", (_label, claims) => {
    for (const mode of ['proportional', 'equal'] as const) {
      expect(settlePlan(withCy(mode, claims), 'A', NO_MARKS)).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md, Task 3).
// Test titles for the shared boundary rows start with their tag ([E#] / [D#]): the same tags as
// supabase/tests/database/settle_early.test.sql and settle_difference.test.sql (criterion 62).
// ---------------------------------------------------------------------------

/** Unwraps an early plan, or fails the test. */
function early(plan: SettlePlanWithEarly): SettleEarly {
  if (plan.status !== 'early') throw new Error(`expected early, got ${plan.status}`);
  return plan;
}

function anyEntry(plan: SettleReady | SettleEarly, userId: string) {
  const e = (plan.people as readonly (SettleEntry | SettleEarlyEntry)[]).find((p) => p.userId === userId);
  if (!e) throw new Error(`no entry for ${userId}`);
  return e;
}

/** Sam (B) is U, Hana (A) hosts and pays, Dee (D) is a third participant where a row needs one. */
const PROP = 'proportional' as const;
const EVEN = 'equal' as const;
function bill(
  items: SplitItem[],
  claims: SplitClaim[],
  totalCents: number,
  extrasMode: ExtrasMode = PROP,
  participantIds: string[] = ['A', 'B', 'D'],
): SplitInput {
  return { totalCents, items, claims, participantIds, extrasMode };
}
const E1_ITEMS: SplitItem[] = [
  { id: 'burger', totalCents: 1500 },
  { id: 'salad', totalCents: 1000 },
  { id: 'fries', totalCents: 600 },
];
const e1 = (extrasMode: ExtrasMode = PROP) => bill(E1_ITEMS, [c('burger', 'A'), c('salad', 'B')], 3600, extrasMode);

type SettleState = ReturnType<typeof maySettle>;
const E_CASES: { tag: string; name: string; input: SplitInput; user: string; expected: SettleState }[] = [
  { tag: '[E1]', name: 'proportional, 3 rows, Sam claimed 1, 1 row unclaimed', input: e1(), user: 'B', expected: 'early' },
  {
    tag: '[E2]',
    name: 'proportional, incomplete, Sam claimed nothing',
    input: bill(E1_ITEMS, [c('burger', 'A')], 3600),
    user: 'B',
    expected: 'not_complete',
  },
  {
    tag: '[E3]',
    name: 'proportional, incomplete, Sam claimed only a discount row',
    input: bill(
      [{ id: 'burger', totalCents: 1500 }, { id: 'salad', totalCents: 1000 }, { id: 'promo', totalCents: -200, kind: 'discount' }],
      [c('burger', 'A'), c('promo', 'B')],
      2800,
    ),
    user: 'B',
    expected: 'not_complete',
  },
  {
    tag: '[E4]',
    name: 'proportional, incomplete, Sam claimed only a $0.00 item (other items > 0)',
    input: bill(
      [{ id: 'burger', totalCents: 1500 }, { id: 'water', totalCents: 0 }, { id: 'fries', totalCents: 600 }],
      [c('burger', 'A'), c('water', 'B')],
      2400,
    ),
    user: 'B',
    expected: 'early',
  },
  { tag: '[E5]', name: 'even, incomplete, Sam claimed 1 item', input: e1(EVEN), user: 'B', expected: 'not_complete' },
  {
    tag: '[E6]',
    name: 'proportional, complete, Sam claimed nothing (Hana claimed all)',
    input: bill(E1_ITEMS, [c('burger', 'A'), c('salad', 'A'), c('fries', 'A')], 3600),
    user: 'B',
    expected: 'final',
  },
  {
    tag: '[E7]',
    name: "proportional, incomplete, Sam's only claim is 1 part of a shared row",
    input: bill(E1_ITEMS, [c('burger', 'A'), c('fries', 'A'), c('fries', 'B')], 3600),
    user: 'B',
    expected: 'early',
  },
  {
    tag: '[E8]',
    name: 'proportional, every row $0.00 and claimed, total 500 (K6)',
    input: bill([{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }], [c('bread', 'A'), c('water', 'B')], 500),
    user: 'B',
    expected: 'all_zero',
  },
  {
    tag: '[E9]',
    name: 'proportional, every item $0.00, incomplete, Sam claimed one, total 500',
    input: bill([{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }], [c('water', 'B')], 500),
    user: 'B',
    expected: 'all_zero',
  },
  {
    tag: '[E10]',
    name: 'proportional, every item $0.00, total 0, no discounts, incomplete, Sam claimed one',
    input: bill([{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }], [c('water', 'B')], 0),
    user: 'B',
    expected: 'early',
  },
  { tag: '[E11]', name: 'even, complete (K1)', input: worked('equal'), user: 'B', expected: 'final' },
  {
    tag: '[E12]',
    name: 'even, every item $0.00, complete, total 500',
    input: bill([{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }], [c('bread', 'A'), c('water', 'B')], 500, EVEN),
    user: 'B',
    expected: 'final',
  },
  { tag: '[E13]', name: 'E1, then Hana switches to even', input: e1(EVEN), user: 'B', expected: 'not_complete' },
  { tag: '[E14]', name: 'E1 as Hana, the payer (is_payer is the view and DB concern)', input: e1(), user: 'A', expected: 'early' },
  {
    tag: '[E15]',
    name: 'proportional, item 1000 + unclaimed discount -1000, total 0, Sam claimed the item',
    input: bill([{ id: 'meal', totalCents: 1000 }, { id: 'promo', totalCents: -1000, kind: 'discount' }], [c('meal', 'B')], 0),
    user: 'B',
    expected: 'early',
  },
  {
    tag: '[E16]',
    name: 'proportional, every item claimed, only a claimable discount row unclaimed',
    input: bill(
      [...E1_ITEMS, { id: 'promo', totalCents: -300, kind: 'discount' }],
      [c('burger', 'A'), c('salad', 'B'), c('fries', 'A')],
      3300,
    ),
    user: 'B',
    expected: 'early',
  },
  {
    tag: '[E17]',
    name: 'proportional, complete, every item $0.00, total 0, no discounts',
    input: bill([{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }], [c('bread', 'A'), c('water', 'B')], 0),
    user: 'B',
    expected: 'final',
  },
  {
    tag: '[E18]',
    name: 'proportional, every item $0.00, an unclaimed discount of -1, total 0 (extras +1 from the discount)',
    input: bill(
      [{ id: 'bread', totalCents: 0 }, { id: 'water', totalCents: 0 }, { id: 'promo', totalCents: -1, kind: 'discount' }],
      [c('bread', 'A'), c('water', 'B')],
      0,
    ),
    user: 'B',
    expected: 'all_zero',
  },
  {
    tag: '[E19]',
    name: 'proportional, items 600 + 400, total 999 (extras -1), 400 unclaimed, Sam claimed 600',
    input: bill([{ id: 'six', totalCents: 600 }, { id: 'four', totalCents: 400 }], [c('six', 'B')], 999),
    user: 'B',
    expected: 'early',
  },
  {
    tag: '[E20]',
    name: "E1, then the host deletes Sam's only item row",
    input: bill(E1_ITEMS.filter((i) => i.id !== 'salad'), [c('burger', 'A')], 3600),
    user: 'B',
    expected: 'not_complete',
  },
];

describe('maySettle: rule E boundary table (criterion 16)', () => {
  it.each(E_CASES.map((x) => [`${x.tag} ${x.name} → ${x.expected}`, x] as const))('%s', (_title, x) => {
    expect(maySettle(x.input, x.user)).toBe(x.expected);
  });

  it('lists E1–E20 exactly once each', () => {
    expect(E_CASES.map((x) => x.tag)).toEqual(Array.from({ length: 20 }, (_, i) => `[E${i + 1}]`));
  });

  it("[E20] a claim left pointing at the deleted row doesn't count (normalize drops it)", () => {
    const stale = { ...e1(), items: E1_ITEMS.filter((i) => i.id !== 'salad') };
    expect(stale.claims).toContainEqual(c('salad', 'B'));
    expect(maySettle(stale, 'B')).toBe('not_complete');
  });

  it('[E4] Sam may settle, but his role is nothing (the UI hides the button)', () => {
    const x = E_CASES.find((e) => e.tag === '[E4]')!;
    const b = anyEntry(early(settlePlan(x.input, 'A', NO_MARKS, { allowEarly: true })), 'B');
    expect(b).toMatchObject({ role: 'nothing', owedCents: 0, canSettle: true });
  });

  it('[E16] the plan is early because of the discount alone ("1 discount left")', () => {
    const x = E_CASES.find((e) => e.tag === '[E16]')!;
    const plan = early(settlePlan(x.input, 'A', NO_MARKS, { allowEarly: true }));
    expect(plan).toMatchObject({ unclaimedRows: 1, unclaimedDiscountRows: 1 });
  });

  it('[E17] the complete twin of E10 is ready, with nothing to collect', () => {
    const x = E_CASES.find((e) => e.tag === '[E17]')!;
    expect(ready(settlePlan(x.input, 'A', NO_MARKS))).toMatchObject({ collectCents: 0, owingCount: 0, allPaid: true });
  });

  it('[E13] the even switch blocks the plan, mark or not', () => {
    const mark = { B: mk(1000, '2026-11-25T10:00:00Z') };
    expect(settlePlan(e1(EVEN), 'A', mark, { allowEarly: true })).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
  });

  it('every E row: an early plan says canSettle exactly when maySettle is early', () => {
    for (const x of E_CASES) {
      const plan = settlePlan(x.input, 'A', NO_MARKS, { allowEarly: true });
      const state = maySettle(x.input, x.user);
      if (state === 'all_zero') expect(plan.status).toBe('blocked_all_zero');
      if (state === 'final') expect(['ready', 'blocked_all_zero']).toContain(plan.status);
      if (plan.status === 'early' && x.user !== 'A') {
        expect(anyEntry(plan, x.user)).toMatchObject({ canSettle: state === 'early' });
      }
    }
  });
});

describe('allZero: rule Z', () => {
  it.each([
    ['proportional, items 0, total 500', bill([{ id: 'x', totalCents: 0 }], [], 500), true],
    ['proportional, items 0, total 0', bill([{ id: 'x', totalCents: 0 }], [], 0), false],
    ['even, items 0, total 500 (Z is proportional only)', bill([{ id: 'x', totalCents: 0 }], [], 500, EVEN), false],
    ['proportional, items 1, total 500', bill([{ id: 'x', totalCents: 1 }], [], 500), false],
    ['proportional, no rows, total 500', bill([], [], 500), true],
    ['proportional, no rows, total 0', bill([], [], 0), false],
    [
      'proportional, items 0, discount -1, total -1 (extras 0)',
      bill([{ id: 'x', totalCents: 0 }, { id: 'd', totalCents: -1, kind: 'discount' }], [], -1),
      false,
    ],
  ] as const)('%s → %s', (_name, input, expected) => {
    expect(allZero(input)).toBe(expected);
  });
});

describe('settlePlan with and without allowEarly (criterion 18, D2 table)', () => {
  const kInput = (mode: ExtrasMode) => ({ ...kBill(K_ITEMS, K_ALL_CLAIMED.filter((x) => x.itemId !== 'beer-1')), extrasMode: mode });

  it('proportional K2, the viewer holding a claim → early with unclaimedRows 1', () => {
    const plan = early(settlePlan(kInput('proportional'), 'A', NO_MARKS, { allowEarly: true }));
    expect(plan).toMatchObject({ status: 'early', payerId: 'A', unclaimedRows: 1, unclaimedDiscountRows: 0 });
    expect(anyEntry(plan, 'B')).toMatchObject({ canSettle: true });
    expect(anyEntry(plan, 'A')).toEqual({ userId: 'A', role: 'payer', mark: null, notReceived: null });
  });

  it('even K2 → blocked', () => {
    expect(settlePlan(kInput('equal'), 'A', NO_MARKS, { allowEarly: true })).toEqual({
      status: 'blocked',
      unclaimedRows: 1,
      unclaimedDiscountRows: 0,
    });
  });

  it('[E8] complete all-zero → blocked_all_zero with and without options', () => {
    const x = E_CASES.find((e) => e.tag === '[E8]')!.input;
    expect(settlePlan(x, 'A', NO_MARKS)).toEqual({ status: 'blocked_all_zero' });
    expect(settlePlan(x, 'A', NO_MARKS, { allowEarly: true })).toEqual({ status: 'blocked_all_zero' });
  });

  it('[E9] incomplete all-zero → blocked_all_zero with allowEarly, blocked without', () => {
    const x = E_CASES.find((e) => e.tag === '[E9]')!.input;
    expect(settlePlan(x, 'A', NO_MARKS, { allowEarly: true })).toEqual({ status: 'blocked_all_zero' });
    expect(settlePlan(x, 'A', NO_MARKS)).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
    expect(settlePlan(x, 'A', NO_MARKS, { allowEarly: false })).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
  });

  it('K1 → ready, identical to the plan without options', () => {
    const input = kBill(K_ITEMS, K_ALL_CLAIMED);
    const marks = { B: mk(1, '2026-11-25T10:00:00Z') };
    expect(settlePlan(input, 'A', marks, { allowEarly: true })).toEqual(settlePlan(input, 'A', marks));
    expect(settlePlan(input, 'A', marks).status).toBe('ready');
  });

  it('a bad payer wins with allowEarly too', () => {
    expect(settlePlan(e1(), 'C', NO_MARKS, { allowEarly: true })).toEqual({ status: 'blocked_bad_payer' });
  });

  it('an early plan has the ready entry shape plus canSettle on non-payers', () => {
    const input = bill(E1_ITEMS, [c('burger', 'A'), c('salad', 'B')], 3600);
    const plan = early(settlePlan(input, 'A', NO_MARKS, { allowEarly: true }));
    const shares = computeShares(input);
    const owedB = shares.people.find((p) => p.userId === 'B')!.totalCents;
    expect(plan.people.map((p) => p.userId)).toEqual(['A', 'B', 'D']);
    expect(anyEntry(plan, 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: owedB, mark: null, notReceived: null, canSettle: true });
    expect(anyEntry(plan, 'D')).toEqual({ userId: 'D', role: 'nothing', owedCents: 0, mark: null, notReceived: null, canSettle: false });
    // Extras 500 over weights A 1500, B 1000, unclaimed 600 (Σ 3100): floors 241/161/96, the 2 spare cents
    // go to the larger remainders (A .93, unclaimed .77), so B keeps 161.
    expect(owedB).toBe(1161);
  });
});

describe('difference (criterion 19, D4 rows D1–D7)', () => {
  const MARK = mk(1510, '2026-11-25T10:00:00Z');
  /** Payer A; B's current share is exactly `share` (no extras), 0 with no claims, or -100 in even mode. */
  function planWithShare(share: number | 'none' | 'negative', marks: SettleMarks = { B: MARK }): SettleReady {
    if (share === 'negative') {
      const input = bill([{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], [c('a', 'A'), c('b', 'B')], 800, EVEN, ['A', 'B']);
      return ready(settlePlan(input, 'A', marks));
    }
    const rows = share === 'none' ? [] : [{ id: 'b', totalCents: share }];
    const input = bill(
      [{ id: 'a', totalCents: 1000 }, ...rows],
      [c('a', 'A'), ...(share === 'none' ? [] : [c('b', 'B')])],
      1000 + (share === 'none' ? 0 : share),
      PROP,
      ['A', 'B'],
    );
    return ready(settlePlan(input, 'A', marks));
  }
  const diffOf = (plan: SettleReady | SettleEarly, userId: string) => differenceOf(anyEntry(plan, userId));

  it.each([
    ['[D1]', 1620, { kind: 'more', cents: 110, fromCents: 1510, toCents: 1620 }],
    ['[D2]', 1400, { kind: 'back', cents: 110, fromCents: 1510, toCents: 1400 }],
    ['[D3]', 'none', { kind: 'back', cents: 1510, fromCents: 1510, toCents: 0 }],
    ['[D4]', 'negative', { kind: 'back', cents: 1510, fromCents: 1510, toCents: 0 }],
    ['[D5]', 1511, null],
    ['[D6]', 1512, { kind: 'more', cents: 2, fromCents: 1510, toCents: 1512 }],
  ] as const)('%s mark 1510, share %s', (_tag, share, expected) => {
    const plan = planWithShare(share);
    expect(diffOf(plan, 'B')).toEqual(expected);
    // markDiffCents / markDiffers keep their M3 meaning alongside (41a).
    expect(anyEntry(plan, 'B')).toMatchObject({ markDiffers: true });
  });

  it('[D4] the share is -100: the pay-back stops at $0 (1510, not 1610)', () => {
    const b = anyEntry(planWithShare('negative'), 'B');
    expect(b).toMatchObject({ owedCents: -100, markDiffCents: -1610 });
    expect(differenceOf(b)).toMatchObject({ cents: 1510, toCents: 0 });
  });

  it('[D7] unmarked, share 500 → null (Sam uses Pay / "I paid")', () => {
    const plan = planWithShare(500, NO_MARKS);
    expect(diffOf(plan, 'B')).toBeNull();
    expect('difference' in anyEntry(plan, 'B')).toBe(false); // absent, like markDiffCents
  });

  it('a difference 1¢ the other way is ignored too', () => {
    expect(diffOf(planWithShare(1509), 'B')).toBeNull();
    expect(diffOf(planWithShare(1508), 'B')).toEqual({ kind: 'back', cents: 2, fromCents: 1510, toCents: 1508 });
  });

  it('an unchanged share has no difference, and the field is present as null', () => {
    const b = anyEntry(planWithShare(1510), 'B');
    expect(b).toMatchObject({ difference: null, markDiffers: false });
  });

  it("the payer never has a difference, even when marked (the DB doesn't store one, but lib is defensive)", () => {
    const plan = planWithShare(1620, { B: MARK, A: MARK });
    expect(anyEntry(plan, 'A')).toEqual({ userId: 'A', role: 'payer', mark: MARK, notReceived: null });
    expect(diffOf(plan, 'A')).toBeNull();
  });

  it('a marked person who owes nothing (share 0) gets a back difference, toCents 0', () => {
    expect(diffOf(planWithShare(0), 'B')).toEqual({ kind: 'back', cents: 1510, fromCents: 1510, toCents: 0 });
  });

  it('[D1] the same marks give the same difference in an early plan', () => {
    // A 1000, B 1620, C 500 unclaimed, no extras: B's share is exactly 1620 while the bill is incomplete.
    const input = bill(
      [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 1620 }, { id: 'c', totalCents: 500 }],
      [c('a', 'A'), c('b', 'B')],
      3120,
    );
    const plan = early(settlePlan(input, 'A', { B: MARK }, { allowEarly: true }));
    expect(anyEntry(plan, 'B')).toMatchObject({ owedCents: 1620, mark: MARK, canSettle: true });
    expect(diffOf(plan, 'B')).toEqual({ kind: 'more', cents: 110, fromCents: 1510, toCents: 1620 });
    expect('pending' in anyEntry(plan, 'B')).toBe(false); // A1.5: no pending field
  });

  it('[D2] a back difference in an early plan', () => {
    const input = bill(
      [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 1400 }, { id: 'c', totalCents: 500 }],
      [c('a', 'A'), c('b', 'B')],
      2900,
    );
    const plan = early(settlePlan(input, 'A', { B: MARK }, { allowEarly: true }));
    expect(diffOf(plan, 'B')).toEqual({ kind: 'back', cents: 110, fromCents: 1510, toCents: 1400 });
  });
});

describe('differenceFor and SETTLE_DIFF_IGNORE_CENTS (criterion 20)', () => {
  it('starts at 1', () => {
    expect(SETTLE_DIFF_IGNORE_CENTS).toBe(1);
  });

  it('[D5] with the tolerance treated as 0, 1510 vs 1511 gives more 1', () => {
    expect(differenceFor(1511, 1510)).toBeNull();
    expect(differenceFor(1511, 1510, 0)).toEqual({ kind: 'more', cents: 1, fromCents: 1510, toCents: 1511 });
    expect(differenceFor(1509, 1510, 0)).toEqual({ kind: 'back', cents: 1, fromCents: 1510, toCents: 1509 });
    expect(differenceFor(1510, 1510, 0)).toBeNull();
  });

  it('pay-back cents are never more than the mark', () => {
    expect(differenceFor(-99_999_999, 1)).toBeNull(); // back 1 is within tolerance
    expect(differenceFor(-99_999_999, 1, 0)).toEqual({ kind: 'back', cents: 1, fromCents: 1, toCents: 0 });
    expect(differenceFor(-5, 99_999_999)).toEqual({ kind: 'back', cents: 99_999_999, fromCents: 99_999_999, toCents: 0 });
  });

  it.each([
    [1.5, 1510, 1],
    [1510, 1.5, 1],
    [Number.NaN, 1510, 1],
    [1510, 1510, -1],
    [1510, 1510, 0.5],
  ])('refuses non-integer money or a bad tolerance: (%p, %p, %p)', (owed, mark, ignore) => {
    expect(() => differenceFor(owed, mark, ignore)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Property tests (criterion 17)
// ---------------------------------------------------------------------------

/**
 * Random bill, complete or not, both modes, with discount rows and $0 items; sometimes every item $0.
 * Always at least one item row, as the DB requires (validate_bill_rows, 20261124094657_claimable_discounts.sql);
 * see 'a bill with no item rows' below for why that matters.
 */
function randomBill(r: (n: number) => number, extrasMode: ExtrasMode): SplitInput {
  const nPeople = 1 + r(5);
  const participantIds = Array.from({ length: nPeople }, (_, i) => `u${i}-${r(1000)}`);
  const allZeroItems = r(12) === 0;
  const nItems = 1 + r(9);
  const items: SplitItem[] = Array.from({ length: nItems }, (_, i) => ({
    id: `i${i}`,
    totalCents: allZeroItems || r(5) === 0 ? 0 : r(100_000),
  }));
  const nDiscounts = r(3);
  for (let i = 0; i < nDiscounts; i++) items.push({ id: `d${i}`, totalCents: -(1 + r(3000)), kind: 'discount' });
  const skipRate = r(3); // 0: complete; otherwise each row may be left unclaimed
  const claims: SplitClaim[] = [];
  for (const it of items) {
    if (skipRate > 0 && r(skipRate + 2) === 0) continue;
    const first = r(nPeople);
    participantIds.forEach((u, i) => {
      if (i === first || r(3) === 0) claims.push({ itemId: it.id, userId: u, parts: 1 + r(4) });
    });
  }
  const rowSum = items.reduce((s, i) => s + i.totalCents, 0);
  const extras = r(6) === 0 ? 0 : r(4) === 0 ? -r(2000) : r(50_000);
  return { totalCents: rowSum + extras, items, claims, participantIds, extrasMode };
}

describe('a bill with no item rows (not storable: the DB requires an item row)', () => {
  // Found by the property test: in even mode, a complete bill with only discount rows has no item
  // claimer, so computeShares leaves the extras with nobody and settlePlan says blocked_all_zero,
  // while rule Z (proportional only, same as SQL) says it isn't all-zero and rule E says 'final'.
  // validate_bill_rows refuses a bill with no item row, so neither side can meet it. Pinned here so a
  // change to that DB rule shows up as a failing test.
  const onlyDiscount = bill([{ id: 'd', totalCents: -500, kind: 'discount' }], [c('d', 'B')], 100, EVEN, ['A', 'B']);
  it('lib answers differ on purpose, because the bill is unreachable', () => {
    expect(sharesComplete(onlyDiscount).complete).toBe(true);
    expect(computeShares(onlyDiscount).unclaimedCents).toBe(600);
    expect(allZero(onlyDiscount)).toBe(false);
    expect(maySettle(onlyDiscount, 'B')).toBe('final');
    expect(settlePlan(onlyDiscount, 'A', NO_MARKS)).toEqual({ status: 'blocked_all_zero' });
  });
});

describe('settle early: property tests (criterion 17)', () => {
  it('(a) complete bills: allZero === (unclaimedCents ≠ 0); (b) without options never early', () => {
    const r = rng(1725);
    let complete = 0;
    let incomplete = 0;
    let zeroes = 0;
    for (let n = 0; n < 500; n++) {
      const mode: ExtrasMode = n % 2 === 0 ? 'proportional' : 'equal';
      const input = randomBill(r, mode);
      const payerId = input.participantIds[r(input.participantIds.length)] as string;
      const done = sharesComplete(input);
      const z = allZero(input);
      const plain = settlePlan(input, payerId, NO_MARKS);
      const withEarly = settlePlan(input, payerId, NO_MARKS, { allowEarly: true });
      expect(plain.status).not.toBe('early');
      expect(plain.status === 'blocked').toBe(!done.complete);
      if (done.complete) {
        complete++;
        expect(z).toBe(computeShares(input).unclaimedCents !== 0); // (a)
        expect(plain.status === 'blocked_all_zero').toBe(z); // (b)
        expect(withEarly).toEqual(plain);
      } else {
        incomplete++;
        // D2 table, "with allowEarly" column.
        const expected = z ? 'blocked_all_zero' : mode === 'equal' ? 'blocked' : 'early';
        expect(withEarly.status).toBe(expected);
      }
      if (z) zeroes++;
      // maySettle agrees with the plan for every participant.
      for (const u of input.participantIds) {
        const state = maySettle(input, u);
        if (z) expect(state).toBe('all_zero');
        else if (done.complete) expect(state).toBe('final');
        if (withEarly.status === 'early' && u !== payerId) {
          expect(anyEntry(withEarly, u)).toMatchObject({ canSettle: state === 'early' });
        }
      }
    }
    // The sample covers every branch.
    expect(complete).toBeGreaterThan(50);
    expect(incomplete).toBeGreaterThan(50);
    expect(zeroes).toBeGreaterThan(5);
  });

  it("(c) other people's actions, run to completion, move an early share by at most 1¢ in total (0 at weight 0)", () => {
    const r = rng(17);
    let sequences = 0;
    let moved = 0;
    let zeroWeight = 0;
    let joins = 0;
    let splits = 0;
    for (let n = 0; n < 500; n++) {
      const input = randomBill(r, 'proportional');
      const payerId = input.participantIds[r(input.participantIds.length)] as string;
      const plan = settlePlan(input, payerId, NO_MARKS, { allowEarly: true });
      if (plan.status !== 'early') continue;
      for (const start of plan.people) {
        if (start.role === 'payer' || !start.canSettle) continue;
        const p = start.userId;
        const pRows = new Set(input.claims.filter((x) => x.userId === p).map((x) => x.itemId));
        const otherRows = input.items.map((i) => i.id).filter((id) => !pRows.has(id));
        let claims = [...input.claims];
        const participantIds = [...input.participantIds];
        let joined = 0;
        const others = () => participantIds.filter((u) => u !== p);
        const join = () => {
          const u = `new-${joined++}`;
          participantIds.push(u);
          joins++;
          return u;
        };
        const pick = <T,>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[r(xs.length)]);
        const steps = r(13); // 0..12
        for (let s = 0; s < steps; s++) {
          const row = pick(otherRows);
          if (row === undefined) break;
          const action = r(4);
          if (action === 0) {
            // claim
            const u = pick(others()) ?? join();
            if (!claims.some((x) => x.itemId === row && x.userId === u)) claims.push(c(row, u, 1 + r(3)));
          } else if (action === 1) {
            // unclaim someone else's claim on a row P didn't claim
            const mine = claims.filter((x) => x.userId !== p && !pRows.has(x.itemId));
            const gone = pick(mine);
            if (gone) claims = claims.filter((x) => x !== gone);
          } else if (action === 2) {
            // set_item_split on a shared row P didn't claim
            const shared = otherRows.filter((id) => claims.filter((x) => x.itemId === id).length >= 2);
            const target = pick(shared);
            if (target) {
              claims = claims.map((x) => (x.itemId === target ? { ...x, parts: 1 + r(5) } : x));
              splits++;
            }
          } else {
            // a new participant joins and claims
            claims.push(c(row, join(), 1 + r(3)));
          }
        }
        // Run to completion: someone other than P claims every row still unclaimed.
        for (const id of input.items.map((i) => i.id)) {
          if (claims.some((x) => x.itemId === id)) continue;
          claims.push(c(id, pick(others()) ?? join()));
        }
        const end = { ...input, claims, participantIds };
        const endPlan = ready(settlePlan(end, payerId, NO_MARKS));
        const endEntry = anyEntry(endPlan, p);
        if (endEntry.role === 'payer') throw new Error('P became the payer');
        const drift = Math.abs(endEntry.owedCents - start.owedCents);
        expect(drift).toBeLessThanOrEqual(1);
        const weight = computeShares(input).people.find((x) => x.userId === p)!.itemsCents;
        if (weight === 0) {
          zeroWeight++;
          expect(drift).toBe(0);
        }
        if (drift === 1) moved++;
        sequences++;
      }
    }
    // Positive controls: the sequences ran, exercised joins and splits, and the 1¢ move does occur.
    expect(sequences).toBeGreaterThan(200);
    expect(joins).toBeGreaterThan(50);
    expect(splits).toBeGreaterThan(20);
    expect(zeroWeight).toBeGreaterThan(5);
    expect(moved).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sent via Venmo, Task 3 (docs/specs/2026-11-26-sent-via-venmo.md D4, D7, §11): marks carry their
// method and who they're to; every entry carries the viewer-independent "Not received" flag.
// ---------------------------------------------------------------------------

describe('sent via Venmo: method, toUserId and notReceived on plan entries', () => {
  const AT = '2026-11-26T08:15:42.987654+00:00';
  const FLAG: SettleNotReceived = { cents: 1510, method: 'venmo', toUserId: 'A' };
  // A pays; B owes 1000 (salad 1000 + half of nothing), complete and proportional.
  const input: SplitInput = {
    totalCents: 2500,
    items: [
      { id: 'a', totalCents: 1500 },
      { id: 'b', totalCents: 1000 },
    ],
    claims: [c('a', 'A'), c('b', 'B')],
    participantIds: ['A', 'B', 'D'],
    extrasMode: 'proportional',
  };
  const incomplete: SplitInput = { ...input, items: [...input.items, { id: 'd', totalCents: 500 }], totalCents: 3000 };

  it('passes each mark through with its method and toUserId (ready and early)', () => {
    const venmo = mk(1000, AT, 'A', 'venmo');
    const plan = ready(settlePlan(input, 'A', { B: venmo }));
    expect(entry(plan, 'B').mark).toEqual({ cents: 1000, at: AT, method: 'venmo', toUserId: 'A' });
    const e = early(settlePlan(incomplete, 'A', { B: mk(1000, AT, 'A', 'cash') }, { allowEarly: true }));
    expect(anyEntry(e, 'B').mark).toEqual({ cents: 1000, at: AT, method: 'cash', toUserId: 'A' });
  });

  it('every entry, the payer included, has notReceived null when no flags are given', () => {
    for (const plan of [ready(settlePlan(input, 'A', NO_MARKS)), early(settlePlan(incomplete, 'A', NO_MARKS, { allowEarly: true }))]) {
      expect(plan.people.map((p) => [p.userId, p.notReceived])).toEqual([
        ['A', null],
        ['B', null],
        ['D', null],
      ]);
    }
  });

  it('puts each person’s flag on their own entry, ready and early', () => {
    const notReceived = { B: FLAG, D: null };
    const plan = ready(settlePlan(input, 'A', NO_MARKS, { notReceived }));
    expect(entry(plan, 'B').notReceived).toEqual(FLAG);
    expect(entry(plan, 'D').notReceived).toBeNull();
    expect(entry(plan, 'A').notReceived).toBeNull();
    const e = early(settlePlan(incomplete, 'A', NO_MARKS, { allowEarly: true, notReceived }));
    expect(anyEntry(e, 'B').notReceived).toEqual(FLAG);
  });

  it('a flag is not a mark: amounts and counts are the same with or without it', () => {
    const without = ready(settlePlan(input, 'A', NO_MARKS));
    const withFlag = ready(settlePlan(input, 'A', NO_MARKS, { notReceived: { B: FLAG } }));
    expect(withFlag).toMatchObject({ collectCents: without.collectCents, paidCount: 0, owingCount: 1, allPaid: false });
    expect(entry(withFlag, 'B')).toMatchObject({ role: 'owes', owedCents: 1000, mark: null });
  });

  it('a flag naming a former payer is kept as given (the view compares toUserId with payerId)', () => {
    const old: SettleNotReceived = { cents: 900, method: 'cash', toUserId: 'D' };
    const plan = ready(settlePlan(input, 'A', NO_MARKS, { notReceived: { B: old } }));
    expect(entry(plan, 'B').notReceived).toEqual(old);
  });

  it('blocked plans have no entries, whatever the flags', () => {
    expect(settlePlan(incomplete, 'A', NO_MARKS, { notReceived: { B: FLAG } })).toEqual({
      status: 'blocked',
      unclaimedRows: 1,
      unclaimedDiscountRows: 0,
    });
  });

  it('settleFactsOf builds the marks and flags maps from fetched participants', () => {
    const venmo = mk(1000, AT, 'A', 'venmo');
    expect(
      settleFactsOf([
        { userId: 'A', mark: null, notReceived: null },
        { userId: 'B', mark: venmo, notReceived: null },
        { userId: 'D', mark: null, notReceived: FLAG },
      ]),
    ).toEqual({ marks: { A: null, B: venmo, D: null }, notReceived: { A: null, B: null, D: FLAG } });
  });
});

// ---------------------------------------------------------------------------
// Who paid, Task 6 (docs/specs/2026-11-26-who-paid.md, Amendment A1; eng review S2, S8, N8):
// ledgerSettlePlan over BillData's payers / payments / flags, rule E′, and balanceFor.
// ---------------------------------------------------------------------------

const WT0 = '2026-11-26T10:00:00.000001+00:00';
const WT1 = '2026-11-26T10:00:01.000001+00:00';
const WT2 = '2026-11-26T10:00:02.000001+00:00';

let wpSeq = 0;
/** A bill_payments entry. planKey null = made under an earlier state. */
function wpay(fromId: string, toId: string, cents: number, opts: { at?: string; key?: string | null; method?: PaymentMethod } = {}): Payment {
  wpSeq += 1;
  return {
    id: `20000000-0000-4000-8000-${String(wpSeq).padStart(12, '0')}`,
    fromId,
    toId,
    cents,
    method: opts.method ?? 'venmo',
    planKey: opts.key ?? null,
    at: opts.at ?? WT0,
  };
}

/**
 * A bill where each person's share is exactly one row they claim (negative = a claimed discount),
 * plus an optional unclaimed item and extra participants with no claims. No extras, so the shares
 * are the rows as given.
 */
function sharesBill(
  shares: Record<string, number>,
  opts: { unclaimed?: number; extra?: string[]; extrasMode?: ExtrasMode } = {},
): SplitInput {
  const items: SplitItem[] = [];
  const claims: SplitClaim[] = [];
  for (const [userId, cents] of Object.entries(shares)) {
    items.push({ id: `row-${userId}`, totalCents: cents, kind: cents < 0 ? 'discount' : 'item' });
    claims.push(c(`row-${userId}`, userId));
  }
  if (opts.unclaimed) items.push({ id: 'unclaimed', totalCents: opts.unclaimed, kind: 'item' });
  const totalCents = items.reduce((sum, i) => sum + i.totalCents, 0);
  const participantIds = [...Object.keys(shares), ...(opts.extra ?? [])].sort();
  return { totalCents, items, claims, participantIds, extrasMode: opts.extrasMode ?? PROP };
}

function ledger(payerId: string, rest: Partial<Omit<SettleLedger, 'payerId'>> = {}): SettleLedger {
  return { payerId, payers: rest.payers ?? [], payments: rest.payments ?? [], flags: rest.flags ?? [] };
}

function routes(plan: BillSettlePlan): SettleRoutes {
  if (plan.status !== 'routes') throw new Error(`expected routes, got ${plan.status}`);
  return plan;
}

const pairsOf = (plan: SettleRoutes) =>
  plan.pairs.map((p) => ({ fromId: p.fromId, toId: p.toId, targetCents: p.targetCents, paidCents: p.paidCents, remainingCents: p.remainingCents }));

function known(b: SettleBalance): { owesCents: number; owedCents: number; final: boolean } {
  if (!b.known) throw new Error('expected a known balance');
  return { owesCents: b.owesCents, owedCents: b.owedCents, final: b.final };
}

/** Σ owes = Σ owed over every participant (a balance is always between two people in the plan). */
function expectBalancesAddUp(plan: BillSettlePlan, ids: readonly string[]): void {
  let owes = 0;
  let owed = 0;
  for (const id of ids) {
    const b = balanceFor(plan, id);
    if (!b.known) continue;
    owes += b.owesCents;
    owed += b.owedCents;
  }
  expect(owes).toBe(owed);
}

describe('ledgerSettlePlan: several payers (routes)', () => {
  it('T1: two payers, one ower: the ower pays each payer what they are short', () => {
    const split = sharesBill({ A: 3341, B: 3340, C: 3340 });
    const payers = [
      { userId: 'A', paidCents: 6000 },
      { userId: 'B', paidCents: 4021 },
    ];
    const { plan, planKey: key } = ledgerSettlePlan(split, ledger('A', { payers }));
    const r = routes(plan);
    expect(r.mode).toBe('split');
    expect(r.leadId).toBe('A');
    expect(r.payers).toEqual(payers);
    expect(r.early).toBeNull();
    expect(pairsOf(r)).toEqual([
      { fromId: 'C', toId: 'A', targetCents: 2659, paidCents: 0, remainingCents: 2659 },
      { fromId: 'C', toId: 'B', targetCents: 681, paidCents: 0, remainingCents: 681 },
    ]);
    expect(r.outside).toEqual([]);
    expect(r.allPaid).toBe(false);
    expect(r.people).toEqual([
      { userId: 'A', paidCents: 6000, shareCents: 3341, canSettle: true },
      { userId: 'B', paidCents: 4021, shareCents: 3340, canSettle: true },
      { userId: 'C', paidCents: 0, shareCents: 3340, canSettle: true },
    ]);
    // The key is contract T's, and the one Task 10's mark_paid stamps.
    const want = settleTransfers({
      mode: 'split',
      leadId: 'A',
      payers,
      shares: [
        { userId: 'A', shareCents: 3341 },
        { userId: 'B', shareCents: 3340 },
        { userId: 'C', shareCents: 3340 },
      ],
      entries: [],
    });
    expect(key).toBe(want.key);
    expect(r.key).toBe(want.key);
    expect(known(balanceFor(plan, 'C'))).toEqual({ owesCents: 3340, owedCents: 0, final: true });
    expect(known(balanceFor(plan, 'A'))).toEqual({ owesCents: 0, owedCents: 2659, final: true });
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 0, owedCents: 681, final: true });
    expectBalancesAddUp(plan, split.participantIds);
  });

  it('T5: a payer whose share is more than they paid pays the other payers', () => {
    const split = sharesBill({ A: 8000, B: 1000, E: 1000 });
    const payers = [
      { userId: 'A', paidCents: 5000 },
      { userId: 'B', paidCents: 3000 },
      { userId: 'E', paidCents: 2000 },
    ];
    const { plan } = ledgerSettlePlan(split, ledger('A', { payers }));
    expect(pairsOf(routes(plan))).toEqual([
      { fromId: 'A', toId: 'B', targetCents: 2000, paidCents: 0, remainingCents: 2000 },
      { fromId: 'A', toId: 'E', targetCents: 1000, paidCents: 0, remainingCents: 1000 },
    ]);
    expect(known(balanceFor(plan, 'A'))).toEqual({ owesCents: 3000, owedCents: 0, final: true });
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 0, owedCents: 2000, final: true });
    expectBalancesAddUp(plan, split.participantIds);
  });

  it('T2/T9: a payment on the current key changes only its pair; a stale-key payment re-plans', () => {
    const split = sharesBill({ A: 2500, B: 2500, C: 2500, D: 2500 });
    const payers = [
      { userId: 'A', paidCents: 5000 },
      { userId: 'B', paidCents: 5000 },
    ];
    const first = ledgerSettlePlan(split, ledger('A', { payers }));
    expect(pairsOf(routes(first.plan))).toEqual([
      { fromId: 'C', toId: 'A', targetCents: 2500, paidCents: 0, remainingCents: 2500 },
      { fromId: 'D', toId: 'B', targetCents: 2500, paidCents: 0, remainingCents: 2500 },
    ]);
    const k0 = first.planKey;
    if (k0 === null) throw new Error('expected a key');

    // C pays B (the wrong payer) under K0: the key stays, B now owes C it back.
    const wrong = wpay('C', 'B', 2500, { key: k0, at: WT1 });
    const second = ledgerSettlePlan(split, ledger('A', { payers, payments: [wrong] }));
    expect(second.planKey).toBe(k0);
    const cb = routes(second.plan).pairs.find((p) => p.fromId === 'C' && p.toId === 'B');
    expect(cb).toMatchObject({ targetCents: 0, paidCents: 2500, remainingCents: -2500, difference: { kind: 'back', cents: 2500 } });
    expect(cb?.mark).toEqual({ cents: 2500, at: WT1, method: 'venmo' });

    // Then C pays A part of what they owe, still under K0.
    const part = wpay('C', 'A', 1000, { key: k0, at: WT2 });
    const third = ledgerSettlePlan(split, ledger('A', { payers, payments: [wrong, part] }));
    expect(third.planKey).toBe(k0);
    const ca = routes(third.plan).pairs.find((p) => p.fromId === 'C' && p.toId === 'A');
    expect(ca).toMatchObject({ targetCents: 2500, paidCents: 1000, remainingCents: 1500, difference: { kind: 'more', cents: 1500 } });
    expectBalancesAddUp(third.plan, split.participantIds);

    // The same payment made under an earlier state gives a new key.
    const stale = ledgerSettlePlan(split, ledger('A', { payers, payments: [wpay('C', 'B', 2500, { at: WT1 })] }));
    expect(stale.planKey).not.toBe(k0);
  });

  it('T4: a negative share is an outside route from the lead and never counts in a balance', () => {
    const split = sharesBill({ A: 3000, B: 3000, C: 4100, D: -100 });
    const payers = [
      { userId: 'A', paidCents: 6000 },
      { userId: 'B', paidCents: 4000 },
    ];
    const { plan } = ledgerSettlePlan(split, ledger('A', { payers }));
    const r = routes(plan);
    expect(pairsOf(r)).toEqual([
      { fromId: 'C', toId: 'A', targetCents: 3100, paidCents: 0, remainingCents: 3100 },
      { fromId: 'C', toId: 'B', targetCents: 1000, paidCents: 0, remainingCents: 1000 },
    ]);
    expect(r.outside).toEqual([{ fromId: 'A', toId: 'D', cents: 100 }]);
    expect(known(balanceFor(plan, 'D'))).toEqual({ owesCents: 0, owedCents: 0, final: true });
    expect(known(balanceFor(plan, 'A'))).toEqual({ owesCents: 0, owedCents: 3100, final: true });
    expectBalancesAddUp(plan, split.participantIds);
  });

  it('allPaid once every pair is paid within tolerance', () => {
    const split = sharesBill({ A: 3341, B: 3340, C: 3340 });
    const payers = [
      { userId: 'A', paidCents: 6000 },
      { userId: 'B', paidCents: 4021 },
    ];
    const k = ledgerSettlePlan(split, ledger('A', { payers })).planKey ?? '';
    const payments = [wpay('C', 'A', 2659, { key: k }), wpay('C', 'B', 680, { key: k, at: WT1 })];
    const { plan } = ledgerSettlePlan(split, ledger('A', { payers, payments }));
    expect(routes(plan).allPaid).toBe(true);
    expect(known(balanceFor(plan, 'C'))).toEqual({ owesCents: 0, owedCents: 0, final: true });
    const short = ledgerSettlePlan(split, ledger('A', { payers, payments: payments.slice(0, 1) }));
    expect(routes(short.plan).allPaid).toBe(false);
  });

  it('carries the flags as fetched', () => {
    const split = sharesBill({ A: 3341, B: 3340, C: 3340 });
    const payers = [
      { userId: 'A', paidCents: 6000 },
      { userId: 'B', paidCents: 4021 },
    ];
    const flags = [{ fromId: 'C', toId: 'B', cents: 681, method: 'cash' as const }];
    expect(routes(ledgerSettlePlan(split, ledger('A', { payers, flags })).plan).flags).toEqual(flags);
  });
});

describe('ledgerSettlePlan: one payer with history (routes)', () => {
  // T0: Priya (P) paid Sam (S) when Sam was the payer; the payer is now You (Y).
  const t0 = () => sharesBill({ P: 1200, S: 1400, Y: 1400 });

  it('T0: money paid to an earlier payer passes on to the current one', () => {
    const { plan, planKey: key } = ledgerSettlePlan(t0(), ledger('Y', { payments: [wpay('P', 'S', 1200)] }));
    const r = routes(plan);
    expect(r.mode).toBe('one');
    expect(r.payers).toEqual([{ userId: 'Y', paidCents: 4000 }]);
    expect(r.pairs).toEqual([
      {
        fromId: 'P',
        toId: 'S',
        targetCents: 1200,
        paidCents: 1200,
        remainingCents: 0,
        mark: { cents: 1200, at: WT0, method: 'venmo' },
        difference: null,
      },
      { fromId: 'S', toId: 'Y', targetCents: 2600, paidCents: 0, remainingCents: 2600, mark: null, difference: null },
    ]);
    const held = { kind: 'passed_on', senderId: 'P', holderId: 'S', cents: 1200, onwardIds: ['Y'] };
    expect(r.provenance).toEqual({ heldFor: { S: [held] }, passedOnBy: { P: [held] } });
    expect(key).toBe(r.key);
    expect(known(balanceFor(plan, 'S'))).toEqual({ owesCents: 2600, owedCents: 0, final: true });
    expect(known(balanceFor(plan, 'Y'))).toEqual({ owesCents: 0, owedCents: 2600, final: true });
    expect(known(balanceFor(plan, 'P'))).toEqual({ owesCents: 0, owedCents: 0, final: true });
  });

  it('T0 early: proportional and incomplete → early routes; even mode or no allowEarly → blocked', () => {
    const shares = { P: 1200, S: 1400, Y: 1400 };
    const l = ledger('Y', { payments: [wpay('P', 'S', 1200)] });
    const split = sharesBill(shares, { unclaimed: 1000, extra: ['Q'] });
    const r = routes(ledgerSettlePlan(split, l, { allowEarly: true }).plan);
    expect(r.early).toEqual({ unclaimedRows: 1, unclaimedDiscountRows: 0 });
    expect(r.people.find((p) => p.userId === 'Q')).toEqual({ userId: 'Q', paidCents: 0, shareCents: 0, canSettle: false });
    expect(r.people.find((p) => p.userId === 'S')?.canSettle).toBe(true);
    // The unclaimed 1000 counts as the payer's for routing: S still owes Y 2600.
    expect(pairsOf(r).find((p) => p.fromId === 'S')).toEqual({ fromId: 'S', toId: 'Y', targetCents: 2600, paidCents: 0, remainingCents: 2600 });
    expect(known(balanceFor(r, 'S'))).toEqual({ owesCents: 2600, owedCents: 0, final: false });

    const even = sharesBill(shares, { unclaimed: 1000, extrasMode: 'equal' });
    expect(ledgerSettlePlan(even, l, { allowEarly: true })).toEqual({
      plan: { status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 },
      planKey: null,
    });
    expect(ledgerSettlePlan(split, l).plan).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 });
  });

  it('a payer who paid someone back more than they sent (net < 0 to the payer) gets routes', () => {
    const split = sharesBill({ A: 1000, B: 1000 });
    const { plan } = ledgerSettlePlan(split, ledger('A', { payments: [wpay('A', 'B', 500)] }));
    const r = routes(plan);
    // Positions: A 2000 − 1000 + 500 = 1500, B −1000 − 500 = −1500, so B → A 1500 on top of the −500.
    expect(r.pairs).toEqual([{ fromId: 'B', toId: 'A', targetCents: 1000, paidCents: -500, remainingCents: 1500, mark: null, difference: null }]);
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 1500, owedCents: 0, final: true });
    expect(known(balanceFor(plan, 'A'))).toEqual({ owesCents: 0, owedCents: 1500, final: true });
    expectBalancesAddUp(plan, split.participantIds);
  });
});

describe('ledgerSettlePlan: stale payers (S8)', () => {
  const payersOf = (b: number) => [
    { userId: 'A', paidCents: 5000 },
    { userId: 'B', paidCents: b },
  ];
  const split = () => sharesBill({ A: 2500, B: 2500, C: 5000 });

  it.each([
    [5001, -1],
    [4999, 1],
  ])('B paid %i of 10000 → blocked_payers with gap %i, and no key', (b, gap) => {
    expect(ledgerSettlePlan(split(), ledger('A', { payers: payersOf(b) }))).toEqual({
      // payers lead first (payersState): the larger amount, then by id.
      plan: { status: 'blocked_payers', leadId: 'A', payers: [...payersOf(b)].sort((x, y) => y.paidCents - x.paidCents), gapCents: gap, assignedCents: 5000 + b, totalCents: 10000 },
      planKey: null,
    });
    expect(balanceFor(ledgerSettlePlan(split(), ledger('A', { payers: payersOf(b) })).plan, 'C')).toEqual({ known: false });
  });

  it('the exact sum → routes', () => {
    expect(ledgerSettlePlan(split(), ledger('A', { payers: payersOf(5000) })).plan.status).toBe('routes');
  });

  it('stale wins over all-$0 and over an incomplete bill', () => {
    const zero: SplitInput = {
      totalCents: 1000,
      items: [{ id: 'x', totalCents: 0 }],
      claims: [c('x', 'A'), c('x', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: PROP,
    };
    const stale = [
      { userId: 'A', paidCents: 500 },
      { userId: 'B', paidCents: 501 },
    ];
    const exact = [
      { userId: 'A', paidCents: 500 },
      { userId: 'B', paidCents: 500 },
    ];
    expect(ledgerSettlePlan(zero, ledger('A', { payers: stale }), { allowEarly: true }).plan.status).toBe('blocked_payers');
    expect(ledgerSettlePlan(zero, ledger('A', { payers: exact }), { allowEarly: true }).plan).toEqual({ status: 'blocked_all_zero' });
    const incomplete = sharesBill({ A: 2500, B: 2500 }, { unclaimed: 5000 });
    expect(ledgerSettlePlan(incomplete, ledger('A', { payers: payersOf(5001) }), { allowEarly: true }).plan.status).toBe('blocked_payers');
  });
});

describe("rule E′: no settling early when the paying is split", () => {
  const split = () => sharesBill({ A: 2500, B: 2500 }, { unclaimed: 5000 });
  const payers = [
    { userId: 'A', paidCents: 5000 },
    { userId: 'B', paidCents: 5000 },
  ];

  it('split + incomplete → blocked even with allowEarly; the same bill with one payer is early', () => {
    expect(ledgerSettlePlan(split(), ledger('A', { payers }), { allowEarly: true })).toEqual({
      plan: { status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 },
      planKey: null,
    });
    expect(ledgerSettlePlan(split(), ledger('A'), { allowEarly: true }).plan.status).toBe('early');
  });

  it('maySettle: split → not_complete, one → early; all_zero wins in both', () => {
    expect(maySettle(split(), 'B', 'split')).toBe('not_complete');
    expect(maySettle(split(), 'B', 'one')).toBe('early');
    expect(maySettle(split(), 'B')).toBe('early');
    const zero: SplitInput = { totalCents: 1000, items: [{ id: 'x', totalCents: 0 }, { id: 'y', totalCents: 0 }], claims: [c('x', 'A')], participantIds: ['A', 'B'], extrasMode: PROP };
    expect(maySettle(zero, 'A', 'split')).toBe('all_zero');
    expect(maySettle(zero, 'A', 'one')).toBe('all_zero');
    expect(maySettle(sharesBill({ A: 2500, B: 2500 }), 'B', 'split')).toBe('final');
  });
});

describe('ledgerSettlePlan: one payer, every payment to or from them (today\'s plan)', () => {
  it('a payment to the payer is today\'s mark', () => {
    const split = worked();
    const payments = [wpay('B', 'A', 1000, { at: WT1 })];
    const got = ledgerSettlePlan(split, ledger('A', { payments }), { allowEarly: true });
    expect(got.plan).toStrictEqual(settlePlan(split, 'A', { B: mk(1000, WT1, 'A', 'venmo') }, { allowEarly: true, notReceived: {} }));
    const shares = computeShares(split).people.map((p) => ({ userId: p.userId, shareCents: p.totalCents }));
    const w = { mode: 'one' as const, leadId: 'A', payers: [{ userId: 'A', paidCents: 3600 }], shares };
    // The key a payment from this screen is stamped with: contract T's, over the entries.
    expect(got.planKey).toBe(currentPlanKey({ ...w, entries: [...payments] }));
    // With no payments at all it is planKey exactly.
    expect(ledgerSettlePlan(split, ledger('A'), { allowEarly: true }).planKey).toBe(planKey(w));
  });

  it('each flag is its sender\'s notReceived, the one to the payer first (as fetched today)', () => {
    const split = sharesBill({ A: 1000, B: 1000, C: 1000 });
    const flags = [
      { fromId: 'B', toId: 'C', cents: 700, method: 'venmo' as const },
      { fromId: 'B', toId: 'A', cents: 900, method: 'cash' as const },
      { fromId: 'A', toId: 'B', cents: 100, method: 'other' as const },
    ];
    const got = ledgerSettlePlan(split, ledger('A', { flags }), { allowEarly: true });
    const notReceived: SettleNotReceivedMap = {
      A: { cents: 100, method: 'other', toUserId: 'B' }, // to an earlier payer: kept, the views ignore it
      B: { cents: 900, method: 'cash', toUserId: 'A' },
    };
    expect(got.plan).toStrictEqual(settlePlan(split, 'A', {}, { allowEarly: true, notReceived }));
  });

  it('a payment back from the payer lowers the mark (contract P)', () => {
    const split = worked();
    const payments = [wpay('B', 'A', 1500, { at: WT1, method: 'venmo' }), wpay('A', 'B', 500, { at: WT2, method: 'cash' })];
    const got = ledgerSettlePlan(split, ledger('A', { payments }), { allowEarly: true });
    expect(got.plan).toStrictEqual(settlePlan(split, 'A', { B: mk(1000, WT1, 'A', 'venmo') }, { allowEarly: true, notReceived: {} }));
  });

  it('without allowEarly an incomplete bill is blocked, as settlePlan', () => {
    const split = sharesBill({ A: 2500, B: 2500 }, { unclaimed: 5000 });
    expect(ledgerSettlePlan(split, ledger('A'))).toEqual({ plan: settlePlan(split, 'A', {}), planKey: null });
  });

  it('blocked plans have no key', () => {
    const zero: SplitInput = { totalCents: 1000, items: [{ id: 'x', totalCents: 0 }], claims: [c('x', 'A')], participantIds: ['A', 'B'], extrasMode: PROP };
    expect(ledgerSettlePlan(zero, ledger('A'))).toEqual({ plan: { status: 'blocked_all_zero' }, planKey: null });
  });

  it('a payer who is not a participant → blocked_bad_payer, no key', () => {
    const split = sharesBill({ A: 2500, B: 2500 });
    expect(ledgerSettlePlan(split, ledger('Z'))).toEqual({ plan: { status: 'blocked_bad_payer' }, planKey: null });
    const payers = [
      { userId: 'A', paidCents: 2500 },
      { userId: 'Z', paidCents: 2500 },
    ];
    expect(ledgerSettlePlan(split, ledger('A', { payers }))).toEqual({ plan: { status: 'blocked_bad_payer' }, planKey: null });
  });
});

describe('balanceFor (S2)', () => {
  it('on a one-payer ready plan: the payer is owed every unmarked share and every "more"; an ower owes theirs', () => {
    // Worked example: B's share is 1510. B marked 1000 → B owes 510 more.
    const plan = settlePlan(worked(), 'A', { B: mk(1000, WT1) });
    expect(known(balanceFor(plan, 'A'))).toEqual({ owesCents: 0, owedCents: 510, final: true });
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 510, owedCents: 0, final: true });
    const over = settlePlan(worked(), 'A', { B: mk(2000, WT1) });
    expect(known(balanceFor(over, 'A'))).toEqual({ owesCents: 490, owedCents: 0, final: true });
    expect(known(balanceFor(over, 'B'))).toEqual({ owesCents: 0, owedCents: 490, final: true });
    const none = settlePlan(worked(), 'A', {});
    expect(known(balanceFor(none, 'A'))).toEqual({ owesCents: 0, owedCents: 1510, final: true });
    expect(known(balanceFor(none, 'B'))).toEqual({ owesCents: 1510, owedCents: 0, final: true });
  });

  it('within tolerance counts as settled', () => {
    const plan = settlePlan(worked(), 'A', { B: mk(1509, WT1) });
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 0, owedCents: 0, final: true });
  });

  it('an early plan is not final', () => {
    const split = sharesBill({ A: 2500, B: 2500 }, { unclaimed: 5000 });
    const plan = settlePlan(split, 'A', {}, { allowEarly: true });
    expect(known(balanceFor(plan, 'B'))).toEqual({ owesCents: 2500, owedCents: 0, final: false });
  });

  it('unknown on a blocked plan, or for someone not in the plan', () => {
    expect(balanceFor({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, 'A')).toEqual({ known: false });
    expect(balanceFor({ status: 'blocked_all_zero' }, 'A')).toEqual({ known: false });
    expect(balanceFor({ status: 'blocked_bad_payer' }, 'A')).toEqual({ known: false });
    expect(balanceFor(settlePlan(worked(), 'A', {}), 'Z')).toEqual({ known: false });
    const r = ledgerSettlePlan(sharesBill({ A: 1, B: 1 }), ledger('A', { payments: [wpay('A', 'B', 5)] })).plan;
    expect(balanceFor(r, 'Z')).toEqual({ known: false });
  });

  it('agrees with transfersFromReadyPlan, and Σ owes = Σ owed, on random one-payer plans', () => {
    const next = rng(606);
    const ids = ['A', 'B', 'C', 'D'];
    for (let n = 0; n < 200; n++) {
      const shares: Record<string, number> = {};
      for (const id of ids) shares[id] = next(5) === 0 ? -(1 + next(300)) : next(5000);
      const split = sharesBill(shares, { unclaimed: next(3) === 0 ? 1 + next(2000) : 0 });
      if (split.totalCents < 0) continue;
      const marks: Record<string, SettleMark | null> = {};
      for (const id of ids.slice(1)) marks[id] = next(2) === 0 ? mk(1 + next(5000), WT1) : null;
      const plan = settlePlan(split, 'A', marks, { allowEarly: true });
      if (plan.status !== 'ready' && plan.status !== 'early') continue;
      expectBalancesAddUp(plan, ids);
      const { pairs } = transfersFromReadyPlan(plan);
      for (const id of ids) {
        const b = known(balanceFor(plan, id));
        expect(b.final).toBe(plan.status === 'ready');
        const mine = pairs.filter((p) => p.fromId === id || p.toId === id);
        if (mine.length === 0) expect(b).toEqual({ owesCents: 0, owedCents: 0, final: b.final });
      }
    }
  });
});

describe('transfersFromReadyPlan', () => {
  it('is today\'s plan as pairs, with empty provenance', () => {
    const plan = settlePlan(sharesBill({ A: 1000, B: 600, C: -100, D: 0 }), 'A', { B: mk(700, WT1, 'A', 'cash'), D: mk(50, WT2) });
    if (plan.status !== 'ready') throw new Error('ready');
    expect(transfersFromReadyPlan(plan)).toEqual({
      pairs: [
        { fromId: 'B', toId: 'A', targetCents: 600, paidCents: 700, remainingCents: -100, mark: { cents: 700, at: WT1, method: 'cash' }, difference: { kind: 'back', cents: 100, fromCents: 700, toCents: 600 } },
        { fromId: 'D', toId: 'A', targetCents: 0, paidCents: 50, remainingCents: -50, mark: { cents: 50, at: WT2, method: 'other' }, difference: { kind: 'back', cents: 50, fromCents: 50, toCents: 0 } },
      ],
      outside: [{ fromId: 'A', toId: 'C', cents: 100 }],
      provenance: { heldFor: {}, passedOnBy: {} },
    });
  });
});
