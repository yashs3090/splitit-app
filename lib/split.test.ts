import {
  allocate,
  computeShares,
  displayShares,
  sharesComplete,
  type ExtrasMode,
  type SplitClaim,
  type SplitInput,
  type SplitItem,
  type SplitResult,
} from './split';
import { settlePlan } from './settle';

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

function shuffle<T>(xs: readonly T[], r: (n: number) => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function invariantSum(res: SplitResult): number {
  return sum(res.people.map((p) => p.totalCents)) + res.unclaimedCents;
}

function allValuesIntegers(res: SplitResult): boolean {
  const nums: number[] = [res.unclaimedItemsCents, res.unclaimedDiscountCents, res.unclaimedExtrasCents, res.unclaimedCents, res.extrasCents];
  for (const p of res.people) nums.push(p.itemsCents, p.discountCents, p.extrasCents, p.totalCents);
  for (const it of Object.values(res.items)) nums.push(...Object.values(it.byUser));
  return nums.every((n) => Number.isSafeInteger(n));
}

function person(res: SplitResult, userId: string) {
  const p = res.people.find((x) => x.userId === userId);
  if (!p) throw new Error(`no person ${userId}`);
  return p;
}

// Worked bill (criterion 57): Burger 1500, Fries 600, Beer#1 700, Beer#2 700, total 4480.
const WORKED_ITEMS: SplitItem[] = [
  { id: 'burger', totalCents: 1500 },
  { id: 'fries', totalCents: 600 },
  { id: 'beer1', totalCents: 700 },
  { id: 'beer2', totalCents: 700 },
];
const c = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });
const CLAIMS_A: SplitClaim[] = [c('fries', 'B'), c('beer1', 'B')];
const CLAIMS_B: SplitClaim[] = [...CLAIMS_A, c('burger', 'A'), c('fries', 'A'), c('beer2', 'A')];
const CLAIMS_C: SplitClaim[] = [c('fries', 'B', 1), c('beer1', 'B'), c('burger', 'A'), c('fries', 'A', 2), c('beer2', 'A')];

function worked(claims: SplitClaim[], extrasMode: ExtrasMode = 'proportional', extra: Partial<SplitInput> = {}): SplitInput {
  return { totalCents: 4480, items: WORKED_ITEMS, claims, participantIds: ['A', 'B'], extrasMode, ...extra };
}

/** Random bill for property tests. Includes $0 rows, unclaimed rows, shared rows and odd parts. */
function randomBill(r: (n: number) => number, extrasMode: ExtrasMode): SplitInput {
  const nPeople = r(6); // 0..5
  const participantIds = Array.from({ length: nPeople }, (_, i) => `user-${i}-${r(1000)}`);
  const nItems = 1 + r(12);
  const items: SplitItem[] = Array.from({ length: nItems }, (_, i) => ({
    id: `item-${i}`,
    totalCents: r(5) === 0 ? 0 : r(100_000),
  }));
  const claims: SplitClaim[] = [];
  for (const it of items) {
    for (const u of participantIds) {
      if (r(3) === 0) claims.push({ itemId: it.id, userId: u, parts: 1 + r(25) });
    }
  }
  const itemsSum = sum(items.map((i) => i.totalCents));
  // Extras between −itemsSum/2-ish and +50,000 (can be negative: big discounts).
  const extras = r(4) === 0 ? -r((itemsSum - (itemsSum % 2)) / 2 + 1) : r(50_000);
  return { totalCents: itemsSum + extras, items, claims, participantIds, extrasMode };
}

function shuffled(input: SplitInput, r: (n: number) => number): SplitInput {
  return {
    ...input,
    items: shuffle(input.items, r),
    claims: shuffle(input.claims, r),
    participantIds: shuffle(input.participantIds, r),
  };
}

describe('allocate', () => {
  it('criterion 53: worked examples', () => {
    expect(allocate(100, [1000, 1000, 1000])).toEqual([34, 33, 33]);
    expect(allocate(1000, [2000, 1000, 1000])).toEqual([500, 250, 250]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(5, [0, 3])).toEqual([0, 5]);
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
  });

  it('criterion 54: throws RangeError on bad input', () => {
    expect(() => allocate(10, [-1, 2])).toThrow(RangeError);
    expect(() => allocate(10, [1.5])).toThrow(RangeError);
    expect(() => allocate(10.5, [1, 1])).toThrow(RangeError);
    expect(() => allocate(10, [0, 0])).toThrow(RangeError);
    expect(() => allocate(10, [])).toThrow(RangeError);
    expect(() => allocate(Number.NaN, [1])).toThrow(RangeError);
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
    expect(allocate(0, [])).toEqual([]);
  });

  it('never returns -0', () => {
    expect(Object.is(allocate(-1, [1, 1])[1], 0)).toBe(true);
  });

  it('criterion 55: large amounts and weights stay exact', () => {
    const parts = allocate(99_999_999, [1_999_999_800, 1, 7]);
    expect(sum(parts)).toBe(99_999_999);
    expect(parts.every((p) => Number.isSafeInteger(p))).toBe(true);
  });

  it('criterion 56: seeded property test, 1,000 cases', () => {
    const r = rng(56);
    for (let k = 0; k < 1000; k++) {
      const n = 1 + r(8);
      const weights: number[] = Array.from({ length: n }, () => (r(4) === 0 ? 0 : r(2_000_000_000)));
      if (!weights.some((w) => w > 0)) weights[0] = 1;
      const amount = (r(2) === 0 ? -1 : 1) * r(100_000_000);
      const parts = allocate(amount, weights);
      expect(parts).toHaveLength(n);
      expect(sum(parts)).toBe(amount);
      expect(parts.every((p) => Number.isSafeInteger(p))).toBe(true);
      // |part − amount·w/W| < 1  ⇔  |part·W − amount·w| < W (exact, in BigInt).
      const W = BigInt(sum(weights));
      parts.forEach((p, i) => {
        const diff = BigInt(p) * W - BigInt(amount) * BigInt(weights[i] ?? 0);
        expect(diff < 0n ? -diff : diff).toBeLessThan(W);
      });
    }
  });
});

describe('computeShares, proportional', () => {
  it('criterion 57(a): only B claimed', () => {
    const res = computeShares(worked(CLAIMS_A));
    expect(res.extrasCents).toBe(980);
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1300, discountCents: 0, extrasCents: 364, totalCents: 1664 });
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 0, discountCents: 0, extrasCents: 0, totalCents: 0 });
    expect(res.unclaimedItemsCents).toBe(2200);
    expect(res.unclaimedExtrasCents).toBe(616);
    expect(res.unclaimedCents).toBe(2816);
    expect(invariantSum(res)).toBe(4480);
  });

  it('criterion 57(b): A and B claimed', () => {
    const res = computeShares(worked(CLAIMS_B));
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 2500, discountCents: 0, extrasCents: 700, totalCents: 3200 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1000, discountCents: 0, extrasCents: 280, totalCents: 1280 });
    expect(res.unclaimedCents).toBe(0);
    expect(res.items.fries).toEqual({ status: 'shared', custom: false, byUser: { A: 300, B: 300 } });
    expect(res.items.beer1).toEqual({ status: 'claimed', custom: false, byUser: { B: 700 } });
    expect(res.items.beer2).toEqual({ status: 'claimed', custom: false, byUser: { A: 700 } });
    expect(res.items.burger?.status).toBe('claimed');
  });

  it('criterion 57(c): custom Fries split A 2, B 1', () => {
    const res = computeShares(worked(CLAIMS_C));
    expect(res.items.fries).toEqual({ status: 'shared', custom: true, byUser: { A: 400, B: 200 } });
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 2600, discountCents: 0, extrasCents: 728, totalCents: 3328 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 900, discountCents: 0, extrasCents: 252, totalCents: 1152 });
  });

  it('people are sorted by userId in code-unit order', () => {
    const res = computeShares(worked(CLAIMS_B, 'proportional', { participantIds: ['b', 'B', 'A'] }));
    expect(res.people.map((p) => p.userId)).toEqual(['A', 'B', 'b']);
  });

  it('criterion 58: even split 334/333/333 in userId order', () => {
    const res = computeShares({
      totalCents: 1000,
      items: [{ id: 'x', totalCents: 1000 }],
      claims: [c('x', 'u3'), c('x', 'u1'), c('x', 'u2')],
      participantIds: ['u2', 'u3', 'u1'],
      extrasMode: 'proportional',
    });
    expect(res.items.x?.byUser).toEqual({ u1: 334, u2: 333, u3: 333 });
    expect(res.items.x?.status).toBe('shared');
    expect(res.items.x?.custom).toBe(false);
  });

  it('criterion 59: nothing claimed, zero participants, claimed $0 row', () => {
    const none = computeShares(worked([]));
    expect(none.people.every((p) => p.totalCents === 0 && p.itemsCents === 0 && p.extrasCents === 0)).toBe(true);
    expect(none.unclaimedCents).toBe(4480);
    expect(none.items.burger).toEqual({ status: 'unclaimed', custom: false, byUser: {} });

    const nobody = computeShares(worked([], 'proportional', { participantIds: [] }));
    expect(nobody.people).toEqual([]);
    expect(nobody.unclaimedCents).toBe(4480);

    const zeroRow = computeShares({
      totalCents: 300,
      items: [{ id: 'free', totalCents: 0 }],
      claims: [c('free', 'A')],
      participantIds: ['A'],
      extrasMode: 'proportional',
    });
    expect(person(zeroRow, 'A').totalCents).toBe(0);
    expect(zeroRow.unclaimedCents).toBe(300); // every weight is 0 → extras go to unclaimed
    expect(invariantSum(zeroRow)).toBe(300);
  });

  it('criterion 60: bill-level discount (negative extras)', () => {
    const res = computeShares({
      totalCents: 1500,
      items: [
        { id: 'a', totalCents: 1500 },
        { id: 'b', totalCents: 500 },
      ],
      claims: [c('a', 'A'), c('b', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    });
    expect(res.extrasCents).toBe(-500);
    expect(person(res, 'A').totalCents).toBe(1125);
    expect(person(res, 'B').totalCents).toBe(375);
  });

  it('criterion 61: parts clamp to 20; unknown rows, non-participants and parts ≤ 0 are ignored', () => {
    const clamped = computeShares({
      totalCents: 2100,
      items: [{ id: 'x', totalCents: 2100 }],
      claims: [c('x', 'A', 50), c('x', 'B', 1)],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    });
    expect(clamped.items.x?.byUser).toEqual({ A: 2000, B: 100 });
    expect(clamped.items.x?.custom).toBe(true);

    const noisy = computeShares(
      worked([...CLAIMS_B, c('ghost-row', 'A'), c('burger', 'stranger'), c('beer1', 'A', 0), c('beer1', 'A', -3)]),
    );
    expect(noisy).toEqual(computeShares(worked(CLAIMS_B)));
    expect(invariantSum(noisy)).toBe(4480);
    expect(noisy.people.map((p) => p.userId)).toEqual(['A', 'B']);
  });

  it('ignores non-integer parts and dedupes repeated participants', () => {
    const res = computeShares(worked([...CLAIMS_B, c('beer1', 'A', 1.5), c('beer1', 'A', Number.NaN)], 'proportional', {
      participantIds: ['A', 'B', 'A'],
    }));
    expect(res).toEqual(computeShares(worked(CLAIMS_B)));
  });

  it('duplicate claims for the same row and user resolve the same way in any order', () => {
    const a = computeShares(worked([...CLAIMS_B, c('fries', 'A', 3)]));
    const b = computeShares(worked([c('fries', 'A', 3), ...CLAIMS_B]));
    expect(a).toEqual(b);
    expect(a.items.fries?.byUser).toEqual({ A: 450, B: 150 }); // the larger parts value wins
  });

  it('throws RangeError for non-integer money input', () => {
    expect(() => computeShares(worked([], 'proportional', { totalCents: 44.8 }))).toThrow(RangeError);
    expect(() =>
      computeShares(worked([], 'proportional', { items: [{ id: 'x', totalCents: 1.5 }] })),
    ).toThrow(RangeError);
    expect(() =>
      computeShares(worked([], 'proportional', { items: [{ id: 'x', totalCents: -1 }] })),
    ).toThrow(RangeError);
  });

  it('criterion 61: 10 seeded shuffles give deep-equal results', () => {
    const r = rng(61);
    const base = computeShares(worked(CLAIMS_C));
    for (let k = 0; k < 10; k++) {
      expect(computeShares(shuffled(worked(CLAIMS_C), r))).toEqual(base);
    }
  });

  it('criterion 62: invariant property test, 500 seeded bills', () => {
    const r = rng(62);
    for (let k = 0; k < 500; k++) {
      const input = randomBill(r, 'proportional');
      const res = computeShares(input);
      expect(invariantSum(res)).toBe(input.totalCents);
      expect(allValuesIntegers(res)).toBe(true);
      expect(res.extrasCents).toBe(input.totalCents - sum(input.items.map((i) => i.totalCents)));
      for (const p of res.people) expect(p.totalCents).toBe(p.itemsCents + p.extrasCents);
      expect(res.unclaimedCents).toBe(res.unclaimedItemsCents + res.unclaimedExtrasCents);
    }
  });

  it('criterion 63: an edit recomputes with claims unchanged', () => {
    const items = WORKED_ITEMS.map((i) => (i.id === 'burger' ? { ...i, totalCents: 1800 } : i));
    const res = computeShares(worked(CLAIMS_B, 'proportional', { items, totalCents: 4780 }));
    expect(invariantSum(res)).toBe(4780);
    expect(person(res, 'A').itemsCents).toBe(2800);
    expect(res.items.fries?.byUser).toEqual({ A: 300, B: 300 });
  });
});

describe('computeShares, equal', () => {
  const three: SplitInput = {
    totalCents: 2000,
    items: [
      { id: 'i1', totalCents: 500 },
      { id: 'i2', totalCents: 300 },
      { id: 'i3', totalCents: 200 },
    ],
    claims: [c('i1', 'u1'), c('i2', 'u2'), c('i3', 'u3')],
    participantIds: ['u3', 'u1', 'u2'],
    extrasMode: 'equal',
  };

  it('criterion 148: three people, $10.00 tip → 334/333/333', () => {
    const res = computeShares(three);
    expect(res.people.map((p) => p.extrasCents)).toEqual([334, 333, 333]);
    expect(res.people.map((p) => p.totalCents)).toEqual([834, 633, 533]);
    expect(invariantSum(res)).toBe(2000);

    const prop = computeShares({ ...three, extrasMode: 'proportional' });
    expect(prop.people.map((p) => p.extrasCents)).toEqual([500, 300, 200]);
  });

  it('criterion 149: worked bill in equal mode', () => {
    const a = computeShares(worked(CLAIMS_A, 'equal'));
    expect(person(a, 'B')).toEqual({ userId: 'B', itemsCents: 1300, discountCents: 0, extrasCents: 980, totalCents: 2280 });
    expect(person(a, 'A').totalCents).toBe(0);
    expect(a.unclaimedItemsCents).toBe(2200);
    expect(a.unclaimedExtrasCents).toBe(0);
    expect(a.unclaimedCents).toBe(2200);
    expect(invariantSum(a)).toBe(4480);

    const b = computeShares(worked(CLAIMS_B, 'equal'));
    expect(person(b, 'A')).toEqual({ userId: 'A', itemsCents: 2500, discountCents: 0, extrasCents: 490, totalCents: 2990 });
    expect(person(b, 'B')).toEqual({ userId: 'B', itemsCents: 1000, discountCents: 0, extrasCents: 490, totalCents: 1490 });
    expect(invariantSum(b)).toBe(4480);
  });

  it('criterion 150: edge cases', () => {
    const none = computeShares(worked([], 'equal'));
    expect(none.unclaimedExtrasCents).toBe(none.extrasCents);
    expect(none.unclaimedCents).toBe(4480);

    const withIdle = computeShares(worked(CLAIMS_B, 'equal', { participantIds: ['A', 'B', 'R'] }));
    expect(person(withIdle, 'R')).toEqual({ userId: 'R', itemsCents: 0, discountCents: 0, extrasCents: 0, totalCents: 0 });
    expect(person(withIdle, 'A').extrasCents).toBe(490);

    const zeroOnly = computeShares({
      totalCents: 1300,
      items: [
        { id: 'free', totalCents: 0 },
        { id: 'paid', totalCents: 1000 },
      ],
      claims: [c('free', 'Z'), c('paid', 'A')],
      participantIds: ['A', 'Z'],
      extrasMode: 'equal',
    });
    expect(person(zeroOnly, 'Z')).toEqual({ userId: 'Z', itemsCents: 0, discountCents: 0, extrasCents: 150, totalCents: 150 });
    expect(person(zeroOnly, 'A').extrasCents).toBe(150);

    const twoRows = (total: number): SplitInput => ({
      totalCents: total,
      items: [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 1000 },
      ],
      claims: [c('a', 'A'), c('b', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: 'equal',
    });
    expect(computeShares(twoRows(1500)).people.map((p) => p.extrasCents)).toEqual([-250, -250]);
    expect(computeShares(twoRows(1899)).people.map((p) => p.extrasCents)).toEqual([-51, -50]);
  });

  it('criterion 151: property test, 500 seeded bills in equal mode', () => {
    const r = rng(151);
    for (let k = 0; k < 500; k++) {
      const input = randomBill(r, 'equal');
      const res = computeShares(input);
      expect(invariantSum(res)).toBe(input.totalCents);
      expect(allValuesIntegers(res)).toBe(true);

      const claimers = new Set(
        Object.values(res.items).flatMap((it) => Object.keys(it.byUser)),
      );
      const claimerExtras = res.people.filter((p) => claimers.has(p.userId)).map((p) => p.extrasCents);
      if (claimerExtras.length > 0) {
        expect(Math.max(...claimerExtras) - Math.min(...claimerExtras)).toBeLessThanOrEqual(1);
        expect(res.unclaimedExtrasCents).toBe(0);
      } else {
        expect(res.unclaimedExtrasCents).toBe(res.extrasCents);
      }
      for (const p of res.people) if (!claimers.has(p.userId)) expect(p.extrasCents).toBe(0);

      expect(computeShares(shuffled(input, r))).toEqual(res);
    }
  });
});

describe('sharesComplete', () => {
  it('criterion 157', () => {
    expect(sharesComplete(worked([]))).toEqual({ complete: false, unclaimedRows: 4, unclaimedDiscountRows: 0 });
    expect(sharesComplete(worked(CLAIMS_A))).toEqual({ complete: false, unclaimedRows: 2, unclaimedDiscountRows: 0 });
    expect(sharesComplete(worked(CLAIMS_B))).toEqual({ complete: true, unclaimedRows: 0, unclaimedDiscountRows: 0 });

    const onlyBadClaims = worked([
      c('fries', 'B'),
      c('beer1', 'B'),
      c('burger', 'A', 0),
      c('beer2', 'stranger'),
    ]);
    expect(sharesComplete(onlyBadClaims)).toEqual({ complete: false, unclaimedRows: 2, unclaimedDiscountRows: 0 });

    const zeroRow: SplitInput = {
      totalCents: 0,
      items: [{ id: 'free', totalCents: 0 }],
      claims: [c('free', 'A')],
      participantIds: ['A'],
      extrasMode: 'equal',
    };
    expect(sharesComplete(zeroRow)).toEqual({ complete: true, unclaimedRows: 0, unclaimedDiscountRows: 0 });
  });
});

describe('displayShares', () => {
  // Burger unclaimed; A: Fries + Beer#2; B: Fries + Beer#1.
  const incomplete = [c('fries', 'A'), c('beer2', 'A'), c('fries', 'B'), c('beer1', 'B')];

  it('criterion 158: equal mode hides extras and totals until every row is claimed', () => {
    const d = displayShares(worked(incomplete, 'equal'));
    expect(d.mode).toBe('equal');
    expect(d.totalsVisible).toBe(false);
    expect(d.complete).toBe(false);
    expect(d.unclaimedRows).toBe(1);
    expect(d.people).toEqual([
      { userId: 'A', itemsCents: 1000, discountCents: null, extrasCents: null, totalCents: null },
      { userId: 'B', itemsCents: 1000, discountCents: null, extrasCents: null, totalCents: null },
    ]);
    expect(d.unclaimedItemsCents).toBe(1500);
    expect(d.unclaimedExtrasCents).toBe(0);

    const done = displayShares(worked([...incomplete, c('burger', 'A')], 'equal'));
    expect(done.totalsVisible).toBe(true);
    expect(done.people).toEqual([
      { userId: 'A', itemsCents: 2500, discountCents: 0, extrasCents: 490, totalCents: 2990 },
      { userId: 'B', itemsCents: 1000, discountCents: 0, extrasCents: 490, totalCents: 1490 },
    ]);
  });

  it('criterion 159: proportional mode shows totals live, matching computeShares', () => {
    const input = worked(incomplete, 'proportional');
    const d = displayShares(input);
    const res = computeShares(input);
    expect(d.totalsVisible).toBe(true);
    expect(d.complete).toBe(false);
    expect(d.people).toEqual(res.people);
    expect(d.unclaimedItemsCents).toBe(res.unclaimedItemsCents);
    expect(d.unclaimedExtrasCents).toBe(res.unclaimedExtrasCents);
    // R11: the per-row splits come back too, so the screen runs the math once.
    expect(d.items).toEqual(res.items);
  });

  it('criterion 160: property test, 300 seeded bills in both modes', () => {
    const r = rng(160);
    for (let k = 0; k < 300; k++) {
      const mode: ExtrasMode = k % 2 === 0 ? 'proportional' : 'equal';
      const input = randomBill(r, mode);
      // Make roughly half the bills complete so both branches get exercised.
      if (r(2) === 0 && input.participantIds.length > 0) {
        const someone = input.participantIds[0] as string;
        input.claims = [...input.claims, ...input.items.map((it) => c(it.id, someone))];
      }
      const d = displayShares(input);
      const res = computeShares(input);
      const { complete, unclaimedRows, unclaimedDiscountRows } = sharesComplete(input);
      expect(d.complete).toBe(complete);
      expect(d.unclaimedRows).toBe(unclaimedRows);
      expect(d.unclaimedDiscountRows).toBe(unclaimedDiscountRows);
      expect(d.totalsVisible).toBe(mode === 'proportional' || complete);
      expect(d.people.map((p) => p.userId)).toEqual(res.people.map((p) => p.userId));
      expect(d.people.map((p) => p.itemsCents)).toEqual(res.people.map((p) => p.itemsCents));
      expect(d.items).toEqual(res.items);
      if (d.totalsVisible) {
        expect(d.people).toEqual(res.people);
      } else {
        expect(d.people.every((p) => p.extrasCents === null && p.totalCents === null)).toBe(true);
      }
    }
  });
});

// Spec 2026-11-24-claimable-discounts § C4 (Task 3). Discount rows are negative rows people claim.
describe('claimable discounts (C4)', () => {
  const STEAK: SplitItem = { id: 'steak', totalCents: 1603 };
  const SALAD: SplitItem = { id: 'salad', totalCents: 1400 };
  const COMP: SplitItem = { id: 'comp', totalCents: -1603, kind: 'discount' };

  /** E1 bill: A Steak, B Salad, comp (claims given), tax 240, total 1640. */
  function e1(compClaims: SplitClaim[], extrasMode: ExtrasMode = 'proportional', participantIds = ['A', 'B']): SplitInput {
    return {
      totalCents: 1640,
      items: [STEAK, SALAD, COMP],
      claims: [c('steak', 'A'), c('salad', 'B'), ...compClaims],
      participantIds,
      extrasMode,
    };
  }

  it('criterion 18 / E1: proportional, comp claimed by A', () => {
    const res = computeShares(e1([c('comp', 'A')]));
    expect(res.extrasCents).toBe(240);
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 1603, discountCents: -1603, extrasCents: 128, totalCents: 128 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1400, discountCents: 0, extrasCents: 112, totalCents: 1512 });
    expect(res.items.comp).toEqual({ status: 'claimed', custom: false, byUser: { A: -1603 } });
    expect(res.unclaimedDiscountCents).toBe(0);
    expect(res.unclaimedCents).toBe(0);
    expect(invariantSum(res)).toBe(1640);
  });

  it('criterion 18 / E1-split: the same comp as a split discount (today, for contrast)', () => {
    const res = computeShares({ ...e1([]), items: [STEAK, SALAD] });
    expect(res.extrasCents).toBe(-1363);
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 1603, discountCents: 0, extrasCents: -728, totalCents: 875 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1400, discountCents: 0, extrasCents: -635, totalCents: 765 });
    expect(invariantSum(res)).toBe(1640);
  });

  it('criterion 18 / E1-even: equal mode', () => {
    const res = computeShares(e1([c('comp', 'A')], 'equal'));
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 1603, discountCents: -1603, extrasCents: 120, totalCents: 120 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1400, discountCents: 0, extrasCents: 120, totalCents: 1520 });
    expect(res.unclaimedCents).toBe(0);
    expect(invariantSum(res)).toBe(1640);
  });

  const E2: SplitInput = {
    totalCents: 1000,
    items: [
      { id: 'fries', totalCents: 500 },
      { id: 'burger', totalCents: 1500 },
      { id: 'coupon', totalCents: -1000, kind: 'discount' },
    ],
    claims: [c('fries', 'A'), c('burger', 'B'), c('coupon', 'A')],
    participantIds: ['A', 'B'],
    extrasMode: 'proportional',
  };

  it('criterion 18 / E2: a claimed discount bigger than the items gives a negative share', () => {
    const res = computeShares(E2);
    expect(res.extrasCents).toBe(0);
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 500, discountCents: -1000, extrasCents: 0, totalCents: -500 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1500, discountCents: 0, extrasCents: 0, totalCents: 1500 });
    expect(invariantSum(res)).toBe(1000);
  });

  it('criterion 24: settlePlan on E2 and K-D1', () => {
    const payerB = settlePlan(E2, 'B', {});
    expect(payerB.status).toBe('ready');
    if (payerB.status !== 'ready') return;
    expect(payerB.people.find((p) => p.userId === 'A')).toEqual({ userId: 'A', role: 'payer_owes_them', owedCents: -500, mark: null });
    expect(payerB.collectCents).toBe(0);

    const payerA = settlePlan(E2, 'A', {});
    expect(payerA.status).toBe('ready');
    if (payerA.status !== 'ready') return;
    expect(payerA.people.find((p) => p.userId === 'B')).toEqual({ userId: 'B', role: 'owes', owedCents: 1500, mark: null });
    expect(payerA.collectCents).toBe(1500);

    expect(settlePlan(e1([]), 'A', {})).toEqual({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 1 });
  });

  it('criterion 18 / E3: a coupon shared by parts, A 2 and B 1', () => {
    const res = computeShares({
      totalCents: 0,
      items: [
        { id: 'meal', totalCents: 1000 },
        { id: 'coupon', totalCents: -1000, kind: 'discount' },
      ],
      claims: [c('meal', 'A'), c('coupon', 'A', 2), c('coupon', 'B', 1)],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    });
    expect(res.items.coupon).toEqual({ status: 'shared', custom: true, byUser: { A: -667, B: -333 } });
    expect(person(res, 'A').discountCents).toBe(-667);
    expect(person(res, 'B').discountCents).toBe(-333);
    expect(invariantSum(res)).toBe(0);
    for (const mode of ['proportional', 'equal'] as const) {
      const r2 = computeShares({ ...e1([c('comp', 'A', 2), c('comp', 'B', 1)], mode) });
      expect(r2.items.comp?.byUser).toEqual({ A: -1069, B: -534 });
      expect(invariantSum(r2)).toBe(1640);
    }
  });

  it('criterion 18 / E4 and 22 (K-D1): the comp unclaimed', () => {
    const res = computeShares(e1([]));
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 1603, discountCents: 0, extrasCents: 128, totalCents: 1731 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1400, discountCents: 0, extrasCents: 112, totalCents: 1512 });
    expect(res.unclaimedItemsCents).toBe(0);
    expect(res.unclaimedDiscountCents).toBe(-1603);
    expect(res.unclaimedExtrasCents).toBe(0);
    expect(res.unclaimedCents).toBe(-1603);
    expect(res.items.comp).toEqual({ status: 'unclaimed', custom: false, byUser: {} });
    expect(invariantSum(res)).toBe(1640);

    expect(sharesComplete(e1([]))).toEqual({ complete: false, unclaimedRows: 1, unclaimedDiscountRows: 1 });
    const d = displayShares(e1([]));
    expect(d.complete).toBe(false);
    expect(d.unclaimedRows).toBe(1);
    expect(d.unclaimedDiscountRows).toBe(1);
    expect(d.unclaimedDiscountCents).toBe(-1603);
    expect(d.people.find((p) => p.userId === 'A')?.discountCents).toBe(0);
  });

  it('criterion 22: K-D2 and K-D3 completeness; hidden totals hide discountCents', () => {
    expect(sharesComplete(e1([c('comp', 'A')]))).toEqual({ complete: true, unclaimedRows: 0, unclaimedDiscountRows: 0 });
    const kd3: SplitInput = { ...e1([c('comp', 'A')]), claims: [c('steak', 'A'), c('comp', 'A')] };
    expect(sharesComplete(kd3)).toEqual({ complete: false, unclaimedRows: 1, unclaimedDiscountRows: 0 });

    const hidden = displayShares(e1([], 'equal'));
    expect(hidden.totalsVisible).toBe(false);
    expect(hidden.people).toEqual([
      { userId: 'A', itemsCents: 1603, discountCents: null, extrasCents: null, totalCents: null },
      { userId: 'B', itemsCents: 1400, discountCents: null, extrasCents: null, totalCents: null },
    ]);
    expect(hidden.unclaimedDiscountCents).toBe(-1603);

    const shown = displayShares(e1([c('comp', 'A')], 'equal'));
    expect(shown.totalsVisible).toBe(true);
    expect(shown.people[0]).toEqual({ userId: 'A', itemsCents: 1603, discountCents: -1603, extrasCents: 120, totalCents: 120 });
    expect(shown.unclaimedDiscountCents).toBe(0);
  });

  it('criterion 18 / E5 and 21: equal mode ignores a discount-only claimer', () => {
    const res = computeShares(e1([c('comp', 'C')], 'equal', ['A', 'B', 'C']));
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 1603, discountCents: 0, extrasCents: 120, totalCents: 1723 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 1400, discountCents: 0, extrasCents: 120, totalCents: 1520 });
    expect(person(res, 'C')).toEqual({ userId: 'C', itemsCents: 0, discountCents: -1603, extrasCents: 0, totalCents: -1603 });
    expect(invariantSum(res)).toBe(1640);
  });

  it('criterion 21: only discount rows claimed in equal mode → every extra stays unclaimed', () => {
    const input: SplitInput = { ...e1([], 'equal', ['A', 'B', 'C']), claims: [c('comp', 'C')] };
    const res = computeShares(input);
    expect(res.people.every((p) => p.extrasCents === 0)).toBe(true);
    expect(res.unclaimedExtrasCents).toBe(240);
    expect(res.unclaimedItemsCents).toBe(3003);
    expect(res.unclaimedDiscountCents).toBe(0);
    expect(person(res, 'C').totalCents).toBe(-1603);
    expect(invariantSum(res)).toBe(1640);
  });

  it('criterion 20: proportional weights ignore discount rows', () => {
    const res = computeShares({
      totalCents: 350,
      items: [
        { id: 'friesA', totalCents: 100 },
        { id: 'friesB', totalCents: 100 },
        { id: 'off', totalCents: -50, kind: 'discount' },
      ],
      claims: [c('friesA', 'A'), c('off', 'A'), c('friesB', 'B')],
      participantIds: ['A', 'B'],
      extrasMode: 'proportional',
    });
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 100, discountCents: -50, extrasCents: 100, totalCents: 150 });
    expect(person(res, 'B')).toEqual({ userId: 'B', itemsCents: 100, discountCents: 0, extrasCents: 100, totalCents: 200 });
  });

  it('proportional: only a discount claimed and every item $0 → extras go to Unclaimed (Q10)', () => {
    const res = computeShares({
      totalCents: 200,
      items: [
        { id: 'free', totalCents: 0 },
        { id: 'off', totalCents: -100, kind: 'discount' },
      ],
      claims: [c('free', 'A'), c('off', 'A')],
      participantIds: ['A'],
      extrasMode: 'proportional',
    });
    expect(res.extrasCents).toBe(300);
    expect(person(res, 'A')).toEqual({ userId: 'A', itemsCents: 0, discountCents: -100, extrasCents: 0, totalCents: -100 });
    expect(res.unclaimedExtrasCents).toBe(300);
    expect(invariantSum(res)).toBe(200);
  });

  it('criterion 19: throws RangeError for bad discount and item rows', () => {
    const withRow = (row: SplitItem): SplitInput => ({ ...e1([]), items: [STEAK, row] });
    expect(() => computeShares(withRow({ id: 'd', totalCents: 0, kind: 'discount' }))).toThrow(RangeError);
    expect(() => computeShares(withRow({ id: 'd', totalCents: 5, kind: 'discount' }))).toThrow(RangeError);
    expect(() => computeShares(withRow({ id: 'd', totalCents: 1.5, kind: 'discount' }))).toThrow(RangeError);
    expect(() => computeShares(withRow({ id: 'd', totalCents: -1.5, kind: 'discount' }))).toThrow(RangeError);
    expect(() => computeShares(withRow({ id: 'i', totalCents: -1 }))).toThrow(RangeError);
    expect(() => computeShares(withRow({ id: 'i', totalCents: -1, kind: 'item' }))).toThrow(RangeError);
    // A kind outside the union (e.g. from untyped data) is refused, not treated as an item.
    const coupon = { id: 'x', totalCents: -1, kind: 'coupon' } as unknown as SplitItem; // deliberately invalid
    expect(() => computeShares(withRow(coupon))).toThrow(RangeError);
    expect(() => sharesComplete(withRow({ id: 'd', totalCents: 0, kind: 'discount' }))).toThrow(RangeError);
    // The smallest valid discount and an explicit 'item' kind are fine.
    expect(() => computeShares(withRow({ id: 'd', totalCents: -1, kind: 'discount' }))).not.toThrow();
    expect(computeShares({ ...e1([]), items: [{ ...STEAK, kind: 'item' }, SALAD, COMP] })).toEqual(computeShares(e1([])));
  });

  it('a repeated id with two different kinds is refused in any order', () => {
    const a: SplitInput = { ...e1([]), items: [STEAK, { id: 'steak', totalCents: -5, kind: 'discount' }] };
    const b: SplitInput = { ...a, items: [...a.items].reverse() };
    expect(() => computeShares(a)).toThrow(RangeError);
    expect(() => computeShares(b)).toThrow(RangeError);
  });

  it('results do not depend on input order with discount rows', () => {
    const r = rng(1124);
    const input = e1([c('comp', 'A', 3), c('comp', 'B', 2)], 'proportional', ['B', 'A', 'C']);
    const base = computeShares(input);
    for (let k = 0; k < 10; k++) expect(computeShares(shuffled(input, r))).toEqual(base);
  });

  /** Random bill with 0–6 items and 0–3 discount rows (−1…−5000), each claimed by 0–3 people, parts 1–20. */
  function randomDiscountBill(r: (n: number) => number, extrasMode: ExtrasMode): SplitInput {
    const nPeople = r(6); // 0..5
    const participantIds = Array.from({ length: nPeople }, (_, i) => `user-${i}-${r(1000)}`);
    const items: SplitItem[] = Array.from({ length: r(7) }, (_, i) => ({
      id: `item-${i}`,
      totalCents: r(5) === 0 ? 0 : r(100_000),
    }));
    const discounts: SplitItem[] = Array.from({ length: r(4) }, (_, i) => ({
      id: `disc-${i}`,
      totalCents: -(1 + r(5000)),
      kind: 'discount',
    }));
    const claims: SplitClaim[] = [];
    for (const it of items) {
      for (const u of participantIds) if (r(3) === 0) claims.push({ itemId: it.id, userId: u, parts: 1 + r(20) });
    }
    for (const d of discounts) {
      const who = shuffle(participantIds, r).slice(0, r(4));
      for (const u of who) claims.push({ itemId: d.id, userId: u, parts: 1 + r(20) });
    }
    const rowsSum = sum([...items, ...discounts].map((i) => i.totalCents));
    const extras = r(4) === 0 ? -r(5000) : r(50_000);
    return { totalCents: rowsSum + extras, items: [...items, ...discounts], claims, participantIds, extrasMode };
  }

  it('criterion 23: seeded property test, 500 bills with discount rows in both modes', () => {
    const failures: string[] = [];
    for (let k = 0; k < 500; k++) {
      const seed = 23_000 + k;
      const r = rng(seed);
      const mode: ExtrasMode = k % 2 === 0 ? 'proportional' : 'equal';
      const input = randomDiscountBill(r, mode);
      const res = computeShares(input);
      const problems: string[] = [];
      if (invariantSum(res) !== input.totalCents) problems.push(`Σ ${invariantSum(res)} ≠ total ${input.totalCents}`);
      if (!allValuesIntegers(res)) problems.push('non-integer value');
      if (res.unclaimedCents !== res.unclaimedItemsCents + res.unclaimedDiscountCents + res.unclaimedExtrasCents) {
        problems.push('unclaimedCents parts');
      }
      if (res.unclaimedDiscountCents > 0) problems.push('unclaimedDiscountCents > 0');
      for (const p of res.people) {
        if (p.totalCents !== p.itemsCents + p.discountCents + p.extrasCents) problems.push(`person ${p.userId} parts`);
        if (p.discountCents > 0 || p.itemsCents < 0) problems.push(`person ${p.userId} signs`);
      }
      for (const row of input.items) {
        const split = res.items[row.id];
        if (!split) {
          problems.push(`row ${row.id} missing`);
        } else if (split.status !== 'unclaimed' && sum(Object.values(split.byUser)) !== row.totalCents) {
          problems.push(`row ${row.id} Σ byUser ≠ ${row.totalCents}`);
        }
      }
      if (problems.length > 0) failures.push(`seed ${seed} (${mode}): ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });
});
