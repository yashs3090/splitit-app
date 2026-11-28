import { groupBalances, netsOf, type GroupBalanceInput, type GroupBalances, type GroupBill, type GroupExpense } from './groupBalance';
import { GROUP_IGNORE_CENTS, isSettledUp, simplify, type Transfer } from './simplify';
import * as split from './split';
import { allocate, computeShares, type ExtrasMode, type SplitClaim, type SplitItem } from './split';
import {
  AIRBNB,
  ANA,
  BEN,
  BRUNCH_ID,
  BRUNCH_ROWS,
  CY,
  DEE,
  DINNER_ID,
  DINNER_ROWS,
  MEMBERS,
  RENTAL_CAR,
  W1,
  W2,
  W6,
  W7,
  WORKED_CASES,
  brunchBill,
  dinnerBill,
  randomUuid,
  seededRng,
  shuffled,
} from '@/test-utils/groupFixtures';

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const netSum = (b: GroupBalances) => sum(b.members.map((m) => m.netCents));

function bill(
  id: string,
  payerId: string,
  totalCents: number,
  items: SplitItem[],
  claims: SplitClaim[],
  extrasMode: ExtrasMode,
  participantIds: string[] = [...MEMBERS],
): GroupBill {
  return { id, payerId, totalCents, split: { totalCents, items, claims, participantIds, extrasMode } };
}

const only = (over: Partial<GroupBalanceInput>): GroupBalanceInput => ({
  members: [...MEMBERS],
  bills: [],
  expenses: [],
  payments: [],
  ...over,
});

describe('groupBalances: worked example (criterion 1)', () => {
  it.each(WORKED_CASES.filter((c) => c.expected).map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const res = groupBalances(c.input);
    const got: Record<string, unknown> = {};
    for (const m of res.members) {
      got[m.userId] = { paid: m.paidCents, share: m.shareCents, sent: m.sentCents, received: m.receivedCents, net: m.netCents };
    }
    expect(got).toEqual(c.expected);
    expect(netSum(res)).toBe(0);
    expect(simplify(netsOf(res)).shown).toEqual(c.shown);
  });

  it("Dee's Dinner share is exactly 0 in W1–W5", () => {
    for (const c of WORKED_CASES.slice(0, 5)) {
      const dinner = c.input.bills.find((b) => b.id === DINNER_ID);
      expect(dinner).toBeDefined();
      if (!dinner) continue;
      const dee = computeShares(dinner.split).people.find((p) => p.userId === DEE);
      expect(dee?.totalCents).toBe(0);
    }
  });

  it('members come back in input order, one per member', () => {
    const res = groupBalances({ ...W1.input, members: [DEE, ANA, CY, BEN] });
    expect(res.members.map((m) => m.userId)).toEqual([DEE, ANA, CY, BEN]);
  });

  it('W6: an assignment is a claim change; Dinner still counts, Σ net = 0, suggestions = simplify(nets)', () => {
    const res = groupBalances(W6.input);
    expect(res.counting).toEqual([DINNER_ID, BRUNCH_ID]);
    expect(netSum(res)).toBe(0);
    const dinner = computeShares(dinnerBill({ nachosClaimers: [ANA] }).split);
    const anaDinner = dinner.people.find((p) => p.userId === ANA)?.totalCents ?? NaN;
    const ana = res.members.find((m) => m.userId === ANA);
    expect(ana?.shareCents).toBe(anaDinner + 1151 + 6000 + 8572);
    // Hand-checked: Dinner becomes Ana 3866, Ben 2320, Cy 1547, Dee 0.
    const newNets = { [ANA]: 12144, [BEN]: -13240, [CY]: -17068, [DEE]: 18164 };
    expect(netsOf(res)).toEqual(newNets);
    expect(simplify(netsOf(res)).shown).toEqual(simplify(newNets).shown);
    // Different from W1, because Ben and Cy no longer share the nachos.
    expect(netsOf(res)).not.toEqual(netsOf(groupBalances(W1.input)));
  });
});

describe('groupBalances: W7 (criterion 108)', () => {
  it('Dinner stops counting after payments; nets swing and Dinner waits with the nachos row named', () => {
    const res = groupBalances(W7.input);
    expect(res.counting).toEqual([BRUNCH_ID]);
    expect(res.waiting).toEqual([
      { billId: DINNER_ID, reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 0, unclaimedRowIds: [DINNER_ROWS.nachos] },
    ]);
    expect(netsOf(res)).toEqual({ [ANA]: -4725, [BEN]: 2749, [CY]: 1976, [DEE]: 0 });
    expect(simplify(netsOf(res)).shown).toEqual([
      { from: ANA, to: BEN, cents: 2749 },
      { from: ANA, to: CY, cents: 1976 },
    ]);
  });
});

describe('groupBalances: which bills count (C-G1)', () => {
  it('criterion 2: W2 lists Dinner as waiting (incomplete, 1 row) and adds no Dinner cents', () => {
    const res = groupBalances(W2.input);
    expect(res.counting).toEqual([BRUNCH_ID]);
    expect(res.waiting).toEqual([
      { billId: DINNER_ID, reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 0, unclaimedRowIds: [DINNER_ROWS.nachos] },
    ]);
    const ana = res.members.find((m) => m.userId === ANA);
    expect(ana?.paidCents).toBe(24000); // not 31733
    for (const id of MEMBERS) {
      const m = res.members.find((x) => x.userId === id);
      const withoutDinner = groupBalances({ ...W2.input, bills: [brunchBill()] }).members.find((x) => x.userId === id);
      expect(m).toEqual(withoutDinner);
    }
  });

  it('W1 counts both bills, in input order', () => {
    expect(groupBalances(W1.input).counting).toEqual([DINNER_ID, BRUNCH_ID]);
    expect(groupBalances(W1.input).waiting).toEqual([]);
  });

  it('criterion 3: a proportional bill with every row $0.00 and total 500, all claimed, waits as all_zero', () => {
    const b = bill(
      'z',
      ANA,
      500,
      [
        { id: 'r1', totalCents: 0 },
        { id: 'r2', totalCents: 0 },
      ],
      [
        { itemId: 'r1', userId: ANA, parts: 1 },
        { itemId: 'r2', userId: BEN, parts: 1 },
      ],
      'proportional',
    );
    const res = groupBalances(only({ bills: [b] }));
    expect(res.counting).toEqual([]);
    expect(res.waiting).toEqual([{ billId: 'z', reason: 'all_zero', unclaimedRows: 0, unclaimedDiscountRows: 0, unclaimedRowIds: [] }]);
    for (const m of res.members) expect(m).toEqual({ userId: m.userId, paidCents: 0, shareCents: 0, sentCents: 0, receivedCents: 0, netCents: 0 });
  });

  it('criterion 3: a complete even-split bill counts', () => {
    const res = groupBalances(only({ bills: [brunchBill()] }));
    expect(res.counting).toEqual([BRUNCH_ID]);
    expect(res.members.find((m) => m.userId === BEN)?.paidCents).toBe(5001);
  });

  it('criterion 3: an even-split bill with one row unclaimed does not count', () => {
    const b = brunchBill();
    const partial: GroupBill = { ...b, split: { ...b.split, claims: b.split.claims.slice(0, 3) } };
    const res = groupBalances(only({ bills: [partial] }));
    expect(res.counting).toEqual([]);
    expect(res.waiting).toEqual([
      { billId: BRUNCH_ID, reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 0, unclaimedRowIds: [BRUNCH_ROWS.dee] },
    ]);
    expect(res.members.every((m) => m.netCents === 0 && m.paidCents === 0 && m.shareCents === 0)).toBe(true);
  });

  it('an unclaimed discount row keeps the bill waiting and is counted as a discount row', () => {
    const b = bill(
      'd',
      ANA,
      1500,
      [
        { id: 'i', totalCents: 2000 },
        { id: 'off', totalCents: -500, kind: 'discount' },
      ],
      [{ itemId: 'i', userId: BEN, parts: 1 }],
      'proportional',
    );
    expect(groupBalances(only({ bills: [b] })).waiting).toEqual([
      { billId: 'd', reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 1, unclaimedRowIds: ['off'] },
    ]);
  });

  it('a bill with no rows and a total above 0 waits as all_zero in both modes', () => {
    for (const mode of ['proportional', 'equal'] as const) {
      const res = groupBalances(only({ bills: [bill('n', ANA, 300, [], [], mode)] }));
      expect(res.waiting).toEqual([{ billId: 'n', reason: 'all_zero', unclaimedRows: 0, unclaimedDiscountRows: 0, unclaimedRowIds: [] }]);
    }
  });

  it('a $0 bill with no rows counts and adds nothing', () => {
    const res = groupBalances(only({ bills: [bill('n', ANA, 0, [], [], 'proportional')] }));
    expect(res.counting).toEqual(['n']);
    expect(res.members.every((m) => m.netCents === 0)).toBe(true);
  });
});

describe('groupBalances: degenerate cases (criterion 4)', () => {
  it('S9 / criterion 109: an unclaimed "Water" $0.00 row keeps an otherwise complete Dinner waiting', () => {
    const res = groupBalances(only({ bills: [dinnerBill({ unclaimedWater: true })] }));
    expect(res.counting).toEqual([]);
    expect(res.waiting).toEqual([
      { billId: DINNER_ID, reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 0, unclaimedRowIds: [DINNER_ROWS.water] },
    ]);
    expect(res.members.every((m) => m.paidCents === 0 && m.shareCents === 0 && m.netCents === 0)).toBe(true);
  });

  it('S9 / criterion 109: an unclaimed claimable discount row keeps an otherwise complete Dinner waiting', () => {
    const res = groupBalances(only({ bills: [dinnerBill({ unclaimedHappyHour: true })] }));
    expect(res.counting).toEqual([]);
    expect(res.waiting).toEqual([
      { billId: DINNER_ID, reason: 'incomplete', unclaimedRows: 1, unclaimedDiscountRows: 1, unclaimedRowIds: [DINNER_ROWS.happyHour] },
    ]);
    expect(res.members.every((m) => m.netCents === 0)).toBe(true);
  });

  it('S1: unclaimedRowIds are in row order, without repeats', () => {
    const b = dinnerBill({ nachosClaimers: [], unclaimedWater: true, unclaimedHappyHour: true });
    const res = groupBalances(only({ bills: [b] }));
    expect(res.waiting[0]?.unclaimedRowIds).toEqual([DINNER_ROWS.nachos, DINNER_ROWS.water, DINNER_ROWS.happyHour]);
    expect(res.waiting[0]?.unclaimedRows).toBe(3);
    // A repeated id (can't come from the DB) is listed once, at its first place.
    const items = [...b.split.items, { id: DINNER_ROWS.water, totalCents: 0 }];
    const again = groupBalances(only({ bills: [{ ...b, split: { ...b.split, items } }] }));
    expect(again.waiting[0]?.unclaimedRowIds).toEqual([DINNER_ROWS.nachos, DINNER_ROWS.water, DINNER_ROWS.happyHour]);
  });

  it('one member and no costs: net 0, no suggestions', () => {
    const res = groupBalances({ members: [ANA], bills: [], expenses: [], payments: [] });
    expect(res.members).toEqual([{ userId: ANA, paidCents: 0, shareCents: 0, sentCents: 0, receivedCents: 0, netCents: 0 }]);
    expect(simplify(netsOf(res))).toEqual({ full: [], shown: [] });
  });

  it('every member at $0 (costs that cancel out): no suggestions', () => {
    // Ana and Ben each pay 1000 split equally between them; their nets cancel to 0.
    const e = (id: string, payerId: string): GroupExpense => ({
      id,
      payerId,
      amountCents: 1000,
      shares: [
        { userId: ANA, cents: 500 },
        { userId: BEN, cents: 500 },
      ],
    });
    const res = groupBalances({ members: [ANA, BEN], bills: [], expenses: [e('1', ANA), e('2', BEN)], payments: [] });
    expect(res.members.map((m) => m.netCents)).toEqual([0, 0]);
    expect(simplify(netsOf(res))).toEqual({ full: [], shown: [] });
  });

  it('a negative share (claimed discount bigger than items) still sums to 0', () => {
    // Ben claims a $1 item and a $5 discount; Ana claims a $10 item. Total 600 (no extras).
    const b = bill(
      'neg',
      ANA,
      600,
      [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 100 },
        { id: 'off', totalCents: -500, kind: 'discount' },
      ],
      [
        { itemId: 'a', userId: ANA, parts: 1 },
        { itemId: 'b', userId: BEN, parts: 1 },
        { itemId: 'off', userId: BEN, parts: 1 },
      ],
      'proportional',
      [ANA, BEN],
    );
    const res = groupBalances({ members: [ANA, BEN], bills: [b], expenses: [], payments: [] });
    const ben = res.members.find((m) => m.userId === BEN);
    expect(ben?.shareCents).toBe(-400);
    expect(ben?.netCents).toBe(400); // owed money: the discount is bigger than what Ben had
    expect(res.members.find((m) => m.userId === ANA)?.netCents).toBe(-400);
    expect(netSum(res)).toBe(0);
    expect(simplify(netsOf(res)).shown).toEqual([{ from: ANA, to: BEN, cents: 400 }]);
  });

  it('a negative share in an even-split bill', () => {
    const b = bill(
      'neg-even',
      ANA,
      700,
      [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 100 },
        { id: 'off', totalCents: -500, kind: 'discount' },
      ],
      [
        { itemId: 'a', userId: ANA, parts: 1 },
        { itemId: 'b', userId: BEN, parts: 1 },
        { itemId: 'off', userId: BEN, parts: 1 },
      ],
      'equal',
      [ANA, BEN],
    );
    const res = groupBalances({ members: [ANA, BEN], bills: [b], expenses: [], payments: [] });
    // Extras 100 → 50/50. Ben 100 − 500 + 50 = −350.
    expect(res.members.find((m) => m.userId === BEN)?.shareCents).toBe(-350);
    expect(netSum(res)).toBe(0);
  });

  it('a member in no cost at all has net 0', () => {
    const res = groupBalances({ ...W1.input, members: [...MEMBERS, 'eeeeeeee-0000-4000-8000-000000000005'] });
    const eve = res.members.find((m) => m.userId === 'eeeeeeee-0000-4000-8000-000000000005');
    expect(eve).toEqual({ userId: eve?.userId, paidCents: 0, shareCents: 0, sentCents: 0, receivedCents: 0, netCents: 0 });
    expect(netSum(res)).toBe(0);
  });

  it('a three-way tie of creditors and of debtors is ordered by user id', () => {
    // Ana, Cy, Eve each pay 600 for a 6-way equal expense; Ben, Dee, Fay owe 300 each... to whom by id.
    const EVE = 'eeeeeeee-0000-4000-8000-000000000005';
    const FAY = 'ffffffff-0000-4000-8000-000000000006';
    const all = [ANA, BEN, CY, DEE, EVE, FAY];
    const e = (id: string, payerId: string): GroupExpense => ({
      id,
      payerId,
      amountCents: 600,
      shares: all.map((userId) => ({ userId, cents: 100 })),
    });
    const res = groupBalances({ members: shuffled(all, seededRng(4)), bills: [], expenses: [e('1', CY), e('2', EVE), e('3', ANA)], payments: [] });
    expect(netsOf(res)).toEqual({ [ANA]: 300, [BEN]: -300, [CY]: 300, [DEE]: -300, [EVE]: 300, [FAY]: -300 });
    expect(simplify(netsOf(res)).shown).toEqual([
      { from: BEN, to: ANA, cents: 300 },
      { from: DEE, to: CY, cents: 300 },
      { from: FAY, to: EVE, cents: 300 },
    ]);
  });
});

describe('groupBalances: refuses bad input (criterion 7, never a wrong number)', () => {
  const bad = [
    ['a fraction', 10.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ] as const;

  describe.each(bad)('%s', (_label, v) => {
    it('as a bill total', () => {
      const b = dinnerBill();
      expect(() => groupBalances(only({ bills: [{ ...b, totalCents: v, split: { ...b.split, totalCents: v } }] }))).toThrow(RangeError);
    });
    it("as a row's cents", () => {
      const b = dinnerBill();
      const items = b.split.items.map((it, i) => (i === 0 ? { ...it, totalCents: v } : it));
      expect(() => groupBalances(only({ bills: [{ ...b, split: { ...b.split, items } }] }))).toThrow(RangeError);
    });
    it('as an expense amount', () => {
      expect(() => groupBalances(only({ expenses: [{ ...AIRBNB, amountCents: v }] }))).toThrow(RangeError);
    });
    it("as an expense share's cents", () => {
      const shares = AIRBNB.shares.map((s, i) => (i === 0 ? { ...s, cents: v } : s));
      expect(() => groupBalances(only({ expenses: [{ ...AIRBNB, shares }] }))).toThrow(RangeError);
    });
    it('as a payment', () => {
      expect(() => groupBalances(only({ payments: [{ from: ANA, to: BEN, cents: v }] }))).toThrow(RangeError);
    });
  });

  it("refuses a bill whose total differs from its split's total", () => {
    const b = dinnerBill();
    expect(() => groupBalances(only({ bills: [{ ...b, totalCents: b.totalCents + 1 }] }))).toThrow(RangeError);
  });

  it('refuses a sum that leaves the safe-integer range', () => {
    const huge = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    const e = (id: string): GroupExpense => ({ id, payerId: ANA, amountCents: huge, shares: [{ userId: BEN, cents: huge }] });
    expect(() => groupBalances(only({ expenses: [e('1'), e('2')] }))).toThrow(RangeError);
  });

  it('refuses expense shares that do not add up to the amount (either way)', () => {
    const plus = RENTAL_CAR.shares.map((s, i) => (i === 0 ? { ...s, cents: s.cents + 1 } : s));
    const minus = RENTAL_CAR.shares.map((s, i) => (i === 0 ? { ...s, cents: s.cents - 1 } : s));
    expect(() => groupBalances(only({ expenses: [{ ...RENTAL_CAR, shares: plus }] }))).toThrow(RangeError);
    expect(() => groupBalances(only({ expenses: [{ ...RENTAL_CAR, shares: minus }] }))).toThrow(RangeError);
  });

  it('refuses amounts out of range: expense 0, a negative share, payment 0 or negative', () => {
    expect(() => groupBalances(only({ expenses: [{ id: 'x', payerId: ANA, amountCents: 0, shares: [{ userId: ANA, cents: 0 }] }] }))).toThrow(RangeError);
    expect(() =>
      groupBalances(only({ expenses: [{ id: 'x', payerId: ANA, amountCents: 100, shares: [{ userId: ANA, cents: 200 }, { userId: BEN, cents: -100 }] }] })),
    ).toThrow(RangeError);
    expect(() => groupBalances(only({ payments: [{ from: ANA, to: BEN, cents: 0 }] }))).toThrow(RangeError);
    expect(() => groupBalances(only({ payments: [{ from: ANA, to: BEN, cents: -5 }] }))).toThrow(RangeError);
  });

  it('refuses people who are not members (payer, participant, share user, payment party)', () => {
    const stranger = '99999999-0000-4000-8000-000000000009';
    const b = dinnerBill();
    expect(() => groupBalances(only({ bills: [{ ...b, payerId: stranger }] }))).toThrow(RangeError);
    expect(() =>
      groupBalances(only({ bills: [{ ...b, split: { ...b.split, participantIds: [...b.split.participantIds, stranger] } }] })),
    ).toThrow(RangeError);
    expect(() => groupBalances(only({ expenses: [{ ...AIRBNB, payerId: stranger }] }))).toThrow(RangeError);
    expect(() =>
      groupBalances(only({ expenses: [{ id: 'x', payerId: ANA, amountCents: 100, shares: [{ userId: stranger, cents: 100 }] }] })),
    ).toThrow(RangeError);
    expect(() => groupBalances(only({ payments: [{ from: stranger, to: ANA, cents: 100 }] }))).toThrow(RangeError);
    expect(() => groupBalances(only({ payments: [{ from: ANA, to: stranger, cents: 100 }] }))).toThrow(RangeError);
  });

  it('refuses duplicates and self-payments', () => {
    expect(() => groupBalances(only({ members: [ANA, ANA] }))).toThrow(RangeError);
    expect(() => groupBalances(only({ bills: [dinnerBill(), dinnerBill()] }))).toThrow(RangeError);
    expect(() =>
      groupBalances(only({ expenses: [{ id: 'x', payerId: ANA, amountCents: 100, shares: [{ userId: BEN, cents: 50 }, { userId: BEN, cents: 50 }] }] })),
    ).toThrow(RangeError);
    expect(() => groupBalances(only({ payments: [{ from: ANA, to: ANA, cents: 100 }] }))).toThrow(RangeError);
  });

  it('S6 / criterion 107: throws RangeError when the input would make Σ net ≠ 0', () => {
    // Corrupted split result: shares that don't add up to the bill total. The final Σ-net check
    // is the backstop that catches it (no earlier check can, since it comes from computeShares).
    const real = split.computeShares;
    const spy = jest.spyOn(split, 'computeShares').mockImplementation((input) => {
      const res = real(input);
      return { ...res, people: res.people.map((p, i) => (i === 0 ? { ...p, totalCents: p.totalCents + 1 } : p)) };
    });
    try {
      expect(() => groupBalances(W1.input)).toThrow(RangeError);
    } finally {
      spy.mockRestore();
    }
    expect(netSum(groupBalances(W1.input))).toBe(0);
  });

  it('S6: an expense whose shares do not sum to its amount, passed in directly, throws', () => {
    const corrupted: GroupExpense = { ...AIRBNB, shares: AIRBNB.shares.map((s) => ({ ...s, cents: s.cents + 1 })) };
    expect(() => groupBalances({ ...W1.input, expenses: [corrupted, RENTAL_CAR] })).toThrow(RangeError);
  });

  it('does not change its input', () => {
    const before = JSON.stringify(W1.input);
    groupBalances(W1.input);
    expect(JSON.stringify(W1.input)).toBe(before);
  });
});

// ---- Property test (criterion 5) ----

type Coverage = { incomplete: number; allZero: number; negativeShare: number; equalMode: number; discounts: number; ties: number };

function randomGroup(r: (n: number) => number, cov: Coverage): GroupBalanceInput {
  const n = 2 + r(9); // 2–10 members
  const members = Array.from({ length: n }, () => randomUuid(r));
  const pick = () => members[r(n)] as string;
  const subset = (max: number) => shuffled(members, r).slice(0, 1 + r(Math.min(max, n)));

  const bills: GroupBill[] = Array.from({ length: r(9) }, (_, b) => {
    const mode: ExtrasMode = r(2) === 0 ? 'proportional' : 'equal';
    const allZero = r(10) === 0;
    const items: SplitItem[] = [];
    const claims: SplitClaim[] = [];
    const rowCount = r(7);
    for (let i = 0; i < rowCount; i++) {
      const id = `bill${b}-row${i}`;
      const isDiscount = r(5) === 0;
      const cents = isDiscount ? -(1 + r(1500)) : allZero || r(5) === 0 ? 0 : 1 + r(5000);
      items.push(isDiscount ? { id, totalCents: cents, kind: 'discount' } : { id, totalCents: cents });
      if (r(8) === 0) continue; // left unclaimed → the bill waits
      for (const userId of subset(3)) claims.push({ itemId: id, userId, parts: 1 + r(3) });
    }
    const rowsSum = sum(items.map((i) => i.totalCents));
    const total = Math.max(0, rowsSum + r(2201) - 200);
    if (mode === 'equal') cov.equalMode++;
    if (items.some((i) => i.kind === 'discount')) cov.discounts++;
    return bill(`bill-${b}`, pick(), total, items, claims, mode, shuffled(members, r));
  });

  const expenses: GroupExpense[] = Array.from({ length: r(9) }, (_, e) => {
    const amount = 1 + r(50000);
    const chosen = [...subset(n)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // Equal (C-G4 order) or uneven weights standing in for exact amounts.
    const weights = r(2) === 0 ? chosen.map(() => 1) : chosen.map(() => 1 + r(5));
    const cents = allocate(amount, weights);
    return { id: `exp-${e}`, payerId: pick(), amountCents: amount, shares: chosen.map((userId, i) => ({ userId, cents: cents[i] ?? 0 })) };
  });

  const payments = Array.from({ length: r(7) }, () => {
    const from = pick();
    let to = pick();
    while (to === from) to = pick();
    return { from, to, cents: 1 + r(20000) };
  });

  return { members, bills, expenses, payments };
}

function shuffleInput(input: GroupBalanceInput, r: (n: number) => number): GroupBalanceInput {
  return {
    members: shuffled(input.members, r),
    bills: shuffled(input.bills, r).map((b) => ({
      ...b,
      split: {
        ...b.split,
        items: shuffled(b.split.items, r),
        claims: shuffled(b.split.claims, r),
        participantIds: shuffled(b.split.participantIds, r),
      },
    })),
    expenses: shuffled(input.expenses, r).map((e) => ({ ...e, shares: shuffled(e.shares, r) })),
    payments: shuffled(input.payments, r),
  };
}

function applyTransfers(nets: Record<string, number>, ps: readonly Transfer[]): Record<string, number> {
  const out = { ...nets };
  for (const p of ps) {
    out[p.from] = (out[p.from] ?? 0) + p.cents;
    out[p.to] = (out[p.to] ?? 0) - p.cents;
  }
  return out;
}

const byUser = (b: GroupBalances) => [...b.members].sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));

describe('groupBalances + simplify: property test (criterion 5)', () => {
  it('1,000 seeded groups: Σ net = 0, nets preserved, ≤ n−1, order-free, leftover ≤ threshold, two-sided hide rule', () => {
    const cov: Coverage = { incomplete: 0, allZero: 0, negativeShare: 0, equalMode: 0, discounts: 0, ties: 0 };
    const failures: string[] = [];
    for (let k = 0; k < 1000; k++) {
      const seed = 5_000 + k;
      const r = seededRng(seed);
      const input = randomGroup(r, cov);
      const problems: string[] = [];
      let res: GroupBalances;
      try {
        res = groupBalances(input);
      } catch (e) {
        failures.push(`seed ${seed}: threw ${String(e)}`);
        continue;
      }
      if (netSum(res) !== 0) problems.push(`Σ net = ${netSum(res)}`);
      for (const m of res.members) {
        for (const v of [m.paidCents, m.shareCents, m.sentCents, m.receivedCents, m.netCents]) {
          if (!Number.isSafeInteger(v)) problems.push(`non-integer ${v}`);
        }
        if (m.netCents !== m.paidCents - m.shareCents + m.sentCents - m.receivedCents) problems.push('net formula');
      }
      // Paid and share each equal the counted costs; sent and received each equal the payments.
      const countedIds = new Set(res.counting);
      const costs = sum(input.bills.filter((b) => countedIds.has(b.id)).map((b) => b.totalCents)) + sum(input.expenses.map((e) => e.amountCents));
      if (sum(res.members.map((m) => m.paidCents)) !== costs) problems.push('Σ paid ≠ counted costs');
      if (sum(res.members.map((m) => m.shareCents)) !== costs) problems.push('Σ share ≠ counted costs');
      const paidOut = sum(input.payments.map((p) => p.cents));
      if (sum(res.members.map((m) => m.sentCents)) !== paidOut || sum(res.members.map((m) => m.receivedCents)) !== paidOut) {
        problems.push('Σ sent/received ≠ payments');
      }
      if (res.counting.length + res.waiting.length !== input.bills.length) problems.push('a bill is neither counting nor waiting');
      for (const w of res.waiting) {
        if (w.reason === 'incomplete') cov.incomplete++;
        else cov.allZero++;
      }
      for (const b of input.bills) {
        if (countedIds.has(b.id) && computeShares(b.split).people.some((p) => p.totalCents < 0)) cov.negativeShare++;
      }

      const nets = netsOf(res);
      const values = Object.values(nets).filter((v) => v !== 0);
      if (new Set(values).size < values.length) cov.ties++;
      const s = simplify(nets);
      if (s.full.length > Math.max(0, values.length - 1)) problems.push(`full has ${s.full.length} payments for ${values.length} non-zero nets`);
      if (Object.values(applyTransfers(nets, s.full)).some((v) => v !== 0)) problems.push('full list does not settle every net');
      // A1 S2: a hidden payment has both people within the threshold; every leftover ≤ threshold.
      const within = (id: string) => isSettledUp(nets[id] ?? 0);
      const hidden = s.full.filter((p) => !s.shown.includes(p));
      if (hidden.some((p) => p.cents > GROUP_IGNORE_CENTS || !within(p.from) || !within(p.to))) problems.push('hid a payment it should show');
      if (s.shown.some((p) => p.cents <= GROUP_IGNORE_CENTS && within(p.from) && within(p.to))) problems.push('showed a payment it should hide');
      const left = applyTransfers(nets, s.shown);
      for (const id of input.members) {
        if (!isSettledUp(left[id] ?? 0)) problems.push(`leftover of ${id} > threshold`);
      }

      const again = groupBalances(shuffleInput(input, r));
      if (JSON.stringify(byUser(again)) !== JSON.stringify(byUser(res))) problems.push('shuffling changed the balances');
      if (JSON.stringify([...again.counting].sort()) !== JSON.stringify([...res.counting].sort())) problems.push('shuffling changed counting');
      if (JSON.stringify(simplify(netsOf(again))) !== JSON.stringify(s)) problems.push('shuffling changed the suggestions');

      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
    // The generator really reached the cases the spec lists.
    expect(cov.incomplete).toBeGreaterThan(50);
    expect(cov.allZero).toBeGreaterThan(10);
    expect(cov.negativeShare).toBeGreaterThan(10);
    expect(cov.equalMode).toBeGreaterThan(100);
    expect(cov.discounts).toBeGreaterThan(100);
    expect(cov.ties).toBeGreaterThan(10);
  });
});
