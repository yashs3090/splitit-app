import { GROUP_IGNORE_CENTS, isSettledUp, simplify, type Transfer } from './simplify';
import { ANA, BEN, CY, DEE, randomUuid, seededRng, shuffled } from '@/test-utils/groupFixtures';

/** Applies payments to a copy of the nets (from pays → their net rises; to is paid → falls). */
function apply(nets: Record<string, number>, payments: readonly Transfer[]): Record<string, number> {
  const out = { ...nets };
  for (const p of payments) {
    out[p.from] = (out[p.from] ?? 0) + p.cents;
    out[p.to] = (out[p.to] ?? 0) - p.cents;
  }
  return out;
}

function fromEntries(entries: readonly (readonly [string, number])[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of entries) out[k] = v;
  return out;
}

describe('GROUP_IGNORE_CENTS', () => {
  it('starts at 1 (GR-3)', () => {
    expect(GROUP_IGNORE_CENTS).toBe(1);
  });
});

describe('isSettledUp (C-G3 step 5)', () => {
  it('criterion 6 (A1): true for −1, 0, +1 and false for ±2', () => {
    expect([-1, 0, 1].map(isSettledUp)).toEqual([true, true, true]);
    expect([-2, 2].map(isSettledUp)).toEqual([false, false]);
  });

  it('is false for a value that is not a safe integer', () => {
    expect(isSettledUp(0.5)).toBe(false);
    expect(isSettledUp(Number.NaN)).toBe(false);
  });
});

describe('simplify (C-G3)', () => {
  it('pairs the largest creditor with the largest debtor (W1 nets)', () => {
    const res = simplify({ [ANA]: 13002, [BEN]: -13669, [CY]: -17497, [DEE]: 18164 });
    expect(res.full).toEqual([
      { from: CY, to: DEE, cents: 17497 },
      { from: BEN, to: ANA, cents: 13002 },
      { from: BEN, to: DEE, cents: 667 },
    ]);
    expect(res.shown).toEqual(res.full);
  });

  it('criterion 6: {Ana +1, Ben −1} shows nothing; the full list has one 1¢ payment', () => {
    const res = simplify({ [ANA]: 1, [BEN]: -1 });
    expect(res.full).toEqual([{ from: BEN, to: ANA, cents: 1 }]);
    expect(res.shown).toEqual([]);
  });

  it('criterion 6: {Ana +2, Ben −2} shows one 2¢ payment', () => {
    const res = simplify({ [ANA]: 2, [BEN]: -2 });
    expect(res.shown).toEqual([{ from: BEN, to: ANA, cents: 2 }]);
  });

  it('criterion 6 (A1): {Ana +1, Ben +1, Cy −2} shows both 1¢ payments, because Cy\'s |net| is 2', () => {
    const nets = { [ANA]: 1, [BEN]: 1, [CY]: -2 };
    const res = simplify(nets);
    // Creditor tie at +1 goes to the lower id (Ana) first.
    expect(res.full).toEqual([
      { from: CY, to: ANA, cents: 1 },
      { from: CY, to: BEN, cents: 1 },
    ]);
    expect(res.shown).toEqual(res.full);
    expect(Object.values(apply(nets, res.shown)).every((v) => v === 0)).toBe(true);
  });

  it('criterion 6 (A1): {Ana +1, Ben +1, Cy +1, Dee −3} shows all three', () => {
    const res = simplify({ [ANA]: 1, [BEN]: 1, [CY]: 1, [DEE]: -3 });
    expect(res.shown).toEqual([
      { from: DEE, to: ANA, cents: 1 },
      { from: DEE, to: BEN, cents: 1 },
      { from: DEE, to: CY, cents: 1 },
    ]);
  });

  it('S2: a 1¢ payment to or from someone whose |net| is above the threshold is shown', () => {
    // Ana is owed 1001; after Cy's 1000 she is still owed 1¢ by Ben, whose own net is −1.
    const res = simplify({ [ANA]: 1001, [BEN]: -1, [CY]: -1000 });
    expect(res.full).toEqual([
      { from: CY, to: ANA, cents: 1000 },
      { from: BEN, to: ANA, cents: 1 },
    ]);
    expect(res.shown).toEqual(res.full);
  });

  it('three-way ties of creditors and of debtors go by user id', () => {
    const res = simplify({ [DEE]: -300, [ANA]: 300, [CY]: 300, [BEN]: -300, e: 300, f: -300 });
    // Creditors Ana, Cy, e (all +300); debtors Ben, Dee, f (all −300); lower id first on each side.
    expect(res.full).toEqual([
      { from: BEN, to: ANA, cents: 300 },
      { from: DEE, to: CY, cents: 300 },
      { from: 'f', to: 'e', cents: 300 },
    ]);
  });

  it('ties use code-unit order, not locale order', () => {
    // 'B' (0x42) < 'a' (0x61) in code units; a locale compare would put 'a' first.
    const res = simplify({ a: 5, B: 5, z: -10 });
    expect(res.full).toEqual([
      { from: 'z', to: 'B', cents: 5 },
      { from: 'z', to: 'a', cents: 5 },
    ]);
  });

  it('no non-zero nets → no payments; zero entries are ignored', () => {
    expect(simplify({})).toEqual({ full: [], shown: [] });
    expect(simplify({ [ANA]: 0 })).toEqual({ full: [], shown: [] });
    expect(simplify({ [ANA]: 0, [BEN]: 0, [CY]: 0 })).toEqual({ full: [], shown: [] });
    expect(simplify({ [ANA]: 500, [BEN]: 0, [CY]: -500 }).full).toEqual([{ from: CY, to: ANA, cents: 500 }]);
  });

  it('does not change its input', () => {
    const nets = { [ANA]: 10, [BEN]: -10 };
    simplify(nets);
    expect(nets).toEqual({ [ANA]: 10, [BEN]: -10 });
  });

  it('throws RangeError when the nets do not sum to 0', () => {
    expect(() => simplify({ [ANA]: 1 })).toThrow(RangeError);
    expect(() => simplify({ [ANA]: 2, [BEN]: -1 })).toThrow(RangeError);
  });

  it.each([
    ['a fraction', 0.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('throws RangeError for %s', (_label, bad) => {
    expect(() => simplify({ [ANA]: bad, [BEN]: -1 })).toThrow(RangeError);
  });

  it('handles the largest safe amounts without losing a cent', () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(simplify({ [ANA]: big, [BEN]: -big }).full).toEqual([{ from: BEN, to: ANA, cents: big }]);
  });

  it('property: 1,000 seeded net maps — preserved, ≤ n−1, order-free, leftover ≤ threshold, two-sided hide rule', () => {
    const failures: string[] = [];
    for (let k = 0; k < 1000; k++) {
      const seed = 6_000 + k;
      const r = seededRng(seed);
      const n = 1 + r(12);
      const ids = Array.from({ length: n }, () => randomUuid(r));
      // Small values half the time, so ties and 1¢/2¢ payments are common.
      const values = ids.map(() => (r(2) === 0 ? r(7) - 3 : r(40001) - 20000));
      const drift = values.reduce((a, b) => a + b, 0);
      values[0] = (values[0] ?? 0) - drift; // Σ = 0
      const nets = fromEntries(ids.map((id, i) => [id, values[i] ?? 0]));
      const res = simplify(nets);
      const problems: string[] = [];

      const nonZero = Object.values(nets).filter((v) => v !== 0).length;
      if (res.full.length > Math.max(0, nonZero - 1)) problems.push(`full has ${res.full.length} > ${nonZero} − 1`);
      if (Object.values(apply(nets, res.full)).some((v) => v !== 0)) problems.push('full list does not settle to 0');
      for (const p of res.full) {
        if (!Number.isSafeInteger(p.cents) || p.cents <= 0) problems.push(`bad cents ${p.cents}`);
        if (p.from === p.to) problems.push('self payment');
        if (!((nets[p.from] ?? 0) < 0 && (nets[p.to] ?? 0) > 0)) problems.push('payment not from a debtor to a creditor');
      }
      // S2: hidden iff ≤ threshold and both people's |net| ≤ threshold; order kept.
      const within = (id: string) => Math.abs(nets[id] ?? 0) <= GROUP_IGNORE_CENTS;
      const isHidden = (p: Transfer) => p.cents <= GROUP_IGNORE_CENTS && within(p.from) && within(p.to);
      if (res.shown.some(isHidden)) problems.push('a shown payment meets the hide rule');
      if (JSON.stringify(res.shown) !== JSON.stringify(res.full.filter((p) => !isHidden(p)))) problems.push('shown ≠ full minus hidden, in order');
      const left = apply(nets, res.shown);
      for (const id of ids) {
        if (Math.abs(left[id] ?? 0) > GROUP_IGNORE_CENTS) problems.push(`leftover of ${id} > threshold`);
        if (!within(id) && (left[id] ?? 0) !== 0) problems.push(`${id} is not settled up but keeps a leftover`);
      }

      const reordered = simplify(fromEntries(shuffled(Object.entries(nets), r)));
      if (JSON.stringify(reordered) !== JSON.stringify(res)) problems.push('input order changed the output');

      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });
});
