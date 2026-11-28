// Task 2a of docs/specs/2026-11-26-who-paid.md (Amendment A1.2, criterion A-22): contract P (the
// state of one ordered pair in the payments ledger) and planKey (the fingerprint of the money state).
// Table P (P1–P6) is shared with pgTAP's private.pair_state (criterion A-14): the same entries, the
// same timestamps, the same answers.
import {
  comparePayments,
  currentPlanKey,
  fnv1a32,
  pairState,
  planKey,
  planKeyCanonical,
  planRoutes,
  PLAN_KEY_PATTERN,
  PLAN_KEY_VERSION,
  settleTransfers,
  timestampMicros,
  type HeldMoney,
  type Outside,
  type Pair,
  type Payment,
  type PlanKeyInput,
  type PlanPayer,
  type PlanShare,
  type SettleTransfers,
  type SettleTransfersInput,
} from './transfers';
import { computeShares, type SplitInput } from './split';
import { differenceFor, settlePlan, type SettleMarks } from './settle';
import type { PaymentMethod } from './paymentMethods';

// Lowercase canonical uuids, so JS `<` equals Postgres uuid order (spec D1 "Lead").
const U = '00000000-0000-4000-8000-0000000000a1';
const V = '00000000-0000-4000-8000-0000000000b2';
const W = '00000000-0000-4000-8000-0000000000c3';

// Timestamps as PostgREST returns timestamptz (microseconds, trailing zeros trimmed, +00:00).
const T0 = '2026-11-26T10:00:00+00:00';
const T1 = '2026-11-26T10:00:01.000001+00:00';
const T2 = '2026-11-26T10:00:02.5+00:00';
const T3 = '2026-11-26T10:00:03.123456+00:00';

let seq = 0;
function pay(fromId: string, toId: string, cents: number, method: PaymentMethod, at: string, id?: string): Payment {
  seq += 1;
  return { id: id ?? `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, fromId, toId, cents, method, planKey: null, at };
}

// Every permutation of a short array (for "input order doesn't matter").
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

describe('contract P: pairState (table P)', () => {
  it('P1: one u→v entry is a mark of its amount, at its time, with its method', () => {
    const e = [pay(U, V, 1510, 'venmo', T1)];
    expect(pairState(e, U, V)).toEqual({ net: 1510, mark: { cents: 1510, at: T1, method: 'venmo' } });
    expect(pairState(e, V, U)).toEqual({ net: -1510, mark: null });
  });

  it('P2: a second u→v entry with the same method adds up and keeps the first time', () => {
    const e = [pay(U, V, 1510, 'venmo', T1), pay(U, V, 110, 'venmo', T2)];
    expect(pairState(e, U, V)).toEqual({ net: 1620, mark: { cents: 1620, at: T1, method: 'venmo' } });
  });

  it('P3: paid back to 0, then a new send starts a new run (its time, its method)', () => {
    const e = [pay(U, V, 1510, 'venmo', T1), pay(V, U, 1510, 'venmo', T2), pay(U, V, 1400, 'cash', T3)];
    expect(pairState(e, U, V)).toEqual({ net: 1400, mark: { cents: 1400, at: T3, method: 'cash' } });
    expect(pairState(e, V, U)).toEqual({ net: -1400, mark: null });
  });

  it('P4: two u→v entries with different methods give method other', () => {
    const e = [pay(U, V, 1000, 'cash', T1), pay(U, V, 500, 'venmo', T2)];
    expect(pairState(e, U, V)).toEqual({ net: 1500, mark: { cents: 1500, at: T1, method: 'other' } });
  });

  it('P5: entries with equal recorded_at are ordered by id (lower first), whatever the input order', () => {
    // At T1 two entries share a timestamp. By id: v→u 300 ('…0a') then u→v 300 ('…0b'), so the run
    // returns to 0 and restarts at T1 with venmo only. The other order (u→v first) would never touch 0,
    // giving markAt T0 and method other: that's what this row tells apart.
    const first = pay(U, V, 300, 'cash', T0, '20000000-0000-4000-8000-000000000001');
    const back = pay(V, U, 300, 'venmo', T1, '20000000-0000-4000-8000-00000000000a');
    const again = pay(U, V, 300, 'venmo', T1, '20000000-0000-4000-8000-00000000000b');
    const want = { net: 300, mark: { cents: 300, at: T1, method: 'venmo' } };
    for (const order of permutations([first, back, again])) {
      expect(pairState(order, U, V)).toEqual(want);
    }
    // Positive control: with the ids swapped, the same amounts give the other answer.
    const backHi = { ...back, id: '20000000-0000-4000-8000-00000000000b' };
    const againLo = { ...again, id: '20000000-0000-4000-8000-00000000000a' };
    expect(pairState([first, backHi, againLo], U, V)).toEqual({ net: 300, mark: { cents: 300, at: T0, method: 'other' } });
  });

  it('P6: a reversed pair: u→v has no mark; v→u has net 300 marked at t2', () => {
    const e = [pay(U, V, 500, 'cash', T1), pay(V, U, 800, 'venmo', T2)];
    expect(pairState(e, U, V)).toEqual({ net: -300, mark: null });
    expect(pairState(e, V, U)).toEqual({ net: 300, mark: { cents: 300, at: T2, method: 'venmo' } });
  });

  it('a partial pay-back inside a run keeps the run start, and its method does not count', () => {
    const e = [pay(U, V, 1000, 'venmo', T1), pay(V, U, 200, 'cash', T2)];
    expect(pairState(e, U, V)).toEqual({ net: 800, mark: { cents: 800, at: T1, method: 'venmo' } });
  });

  it('ignores entries of other pairs, and has no mark with no entries', () => {
    const e = [pay(U, W, 700, 'cash', T1), pay(W, V, 900, 'venmo', T2)];
    expect(pairState(e, U, V)).toEqual({ net: 0, mark: null });
    expect(pairState([], U, V)).toEqual({ net: 0, mark: null });
    expect(pairState([...e, pay(U, V, 100, 'cash', T3)], U, V)).toEqual({ net: 100, mark: { cents: 100, at: T3, method: 'cash' } });
  });

  it('a net of exactly 0 is no mark either way', () => {
    const e = [pay(U, V, 500, 'cash', T1), pay(V, U, 500, 'cash', T2)];
    expect(pairState(e, U, V)).toEqual({ net: 0, mark: null });
    expect(pairState(e, V, U)).toEqual({ net: 0, mark: null });
  });

  it('orders by the instant, not the text: fraction lengths and offsets', () => {
    // 10:00:00.5 is after 10:00:00.123456 and after 10:00:00 (no fraction); 15:30+05:30 is 10:00Z.
    const e = [
      pay(U, V, 100, 'cash', '2026-11-26T10:00:00.5+00:00'),
      pay(V, U, 100, 'cash', '2026-11-26T10:00:00.123456+00:00'),
      pay(U, V, 100, 'venmo', '2026-11-26T15:30:00+05:30'),
    ];
    // Instant order: venmo 100 (10:00:00), back 100 (…0.123456) → 0, cash 100 (…0.5) starts the run.
    expect(pairState(e, U, V)).toEqual({ net: 100, mark: { cents: 100, at: '2026-11-26T10:00:00.5+00:00', method: 'cash' } });
  });

  it('returns markAt exactly as given (the token goes back to the database unchanged)', () => {
    const at = '2026-11-26 10:00:00.120000Z';
    expect(pairState([pay(U, V, 1, 'cash', at)], U, V).mark?.at).toBe(at);
  });

  it('refuses bad input with RangeError instead of guessing', () => {
    expect(() => pairState([], U, U)).toThrow(RangeError);
    for (const cents of [0, -1, 1.5, 100_000_000, Number.NaN]) {
      expect(() => pairState([pay(U, V, cents, 'cash', T1)], U, V)).toThrow(RangeError);
    }
    expect(() => pairState([pay(U, V, 1, 'cash', 'yesterday')], U, V)).toThrow(RangeError);
    expect(() => pairState([pay(U, V, 1, 'cash', '2026-13-01T00:00:00+00:00')], U, V)).toThrow(RangeError);
    const dup = pay(U, V, 1, 'cash', T1);
    expect(() => pairState([dup, { ...dup, toId: U, fromId: V }], U, V)).toThrow(RangeError);
  });

  it('accepts the largest single entry (99,999,999¢) and sums past it exactly', () => {
    const e = [pay(U, V, 99_999_999, 'cash', T1), pay(U, V, 99_999_999, 'cash', T2)];
    expect(pairState(e, U, V).net).toBe(199_999_998);
  });
});

describe('timestampMicros and comparePayments', () => {
  it('reads microseconds exactly, with any offset', () => {
    expect(timestampMicros('1970-01-01T00:00:00+00:00')).toBe(0);
    expect(timestampMicros('1970-01-01T00:00:00.000001Z')).toBe(1);
    expect(timestampMicros('1970-01-01 01:00:00.5+01:00')).toBe(500_000);
    expect(timestampMicros('1970-01-01T00:00:00-0030')).toBe(1_800_000_000);
    expect(timestampMicros('2026-11-26T10:00:00.123456+00:00') - timestampMicros('2026-11-26T10:00:00.123455+00:00')).toBe(1);
  });

  it('orders by (instant, id)', () => {
    const a = pay(U, V, 1, 'cash', T1, 'a');
    const b = pay(U, V, 1, 'cash', T1, 'b');
    const c = pay(U, V, 1, 'cash', T0, 'z');
    expect([b, a, c].sort(comparePayments).map((p) => p.id)).toEqual(['z', 'a', 'b']);
  });
});

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit vectors on the standard offset basis', () => {
    expect(fnv1a32('', 0x811c9dc5)).toBe('811c9dc5');
    expect(fnv1a32('a', 0x811c9dc5)).toBe('e40c292c');
    expect(fnv1a32('foobar', 0x811c9dc5)).toBe('bf9cf968');
  });
});

describe('planKey', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  // T1 of the spec: paid A 6000, B 4021; shares A 3341, B 3340, C 3340.
  const split: PlanKeyInput = {
    mode: 'split',
    leadId: A,
    payers: [
      { userId: A, paidCents: 6000 },
      { userId: B, paidCents: 4021 },
    ],
    shares: [
      { userId: A, shareCents: 3341 },
      { userId: B, shareCents: 3340 },
      { userId: C, shareCents: 3340 },
    ],
  };

  it('builds the documented canonical string', () => {
    expect(PLAN_KEY_VERSION).toBe('v1');
    expect(planKeyCanonical(split)).toBe(`v1|split|${A}|${A}:6000,${B}:4021|${A}:3341,${B}:3340,${C}:3340`);
  });

  it('is 16 lowercase hex characters: FNV-1a pass 1 then pass 2 of the canonical string', () => {
    const canon = planKeyCanonical(split);
    const key = planKey(split);
    expect(key).toMatch(PLAN_KEY_PATTERN);
    expect(PLAN_KEY_PATTERN.source).toBe('^[0-9a-f]{16}$'); // the DB's check (A1.3)
    expect(key).toBe(fnv1a32(canon, 0x811c9dc5) + fnv1a32(canon, 0x01000193 ^ 0x9e3779b9));
  });

  it('pins a known answer, for the database twin to reuse', () => {
    // Computed by an independent BigInt FNV-1a in a scratch script (see the report), not by this code.
    expect(planKey(split)).toBe(KNOWN_SPLIT_KEY);
    expect(planKey(oneA)).toBe(KNOWN_ONE_KEY);
  });

  const oneA: PlanKeyInput = {
    mode: 'one',
    leadId: A,
    payers: [{ userId: A, paidCents: 10021 }],
    shares: [
      { userId: C, shareCents: 3340 },
      { userId: A, shareCents: 3341 },
      { userId: B, shareCents: -100 },
    ],
  };

  it('negative and zero shares appear as plain decimal integers', () => {
    expect(planKeyCanonical({ ...oneA, shares: [...oneA.shares, { userId: 'd', shareCents: -0 }] })).toBe(
      `v1|one|${A}|${A}:10021|${A}:3341,${B}:-100,${C}:3340,d:0`,
    );
  });

  it('is stable across the order of payers and shares', () => {
    const want = planKey(split);
    for (const payers of permutations(split.payers)) {
      for (const shares of permutations(split.shares)) {
        expect(planKey({ ...split, payers, shares })).toBe(want);
      }
    }
  });

  it('changes when any share or any paid amount changes by 1¢ (up or down)', () => {
    const base = planKey(split);
    const seen = new Set([base]);
    split.shares.forEach((_, i) => {
      for (const d of [1, -1]) {
        const shares = split.shares.map((s, j) => (j === i ? { ...s, shareCents: s.shareCents + d } : s));
        const k = planKey({ ...split, shares });
        expect(k).not.toBe(base);
        seen.add(k);
      }
    });
    split.payers.forEach((_, i) => {
      for (const d of [1, -1]) {
        const payers = split.payers.map((p, j) => (j === i ? { ...p, paidCents: p.paidCents + d } : p));
        const k = planKey({ ...split, payers });
        expect(k).not.toBe(base);
        seen.add(k);
      }
    });
    expect(seen.size).toBe(1 + 2 * split.shares.length + 2 * split.payers.length);
  });

  it('changes with the mode, the lead, who paid, or who is on the bill', () => {
    const base = planKey(split);
    expect(planKey({ ...split, leadId: B })).not.toBe(base);
    expect(planKey({ mode: 'one', leadId: A, payers: [{ userId: A, paidCents: 10021 }], shares: split.shares })).not.toBe(base);
    expect(
      planKey({
        ...split,
        payers: [
          { userId: A, paidCents: 6000 },
          { userId: C, paidCents: 4021 },
        ],
      }),
    ).not.toBe(base);
    expect(planKey({ ...split, shares: [...split.shares, { userId: 'd', shareCents: 0 }] })).not.toBe(base);
  });

  it('does not change for an item rename or reorder: only the shares reach it', () => {
    const bill: SplitInput = {
      totalCents: 3000,
      items: [
        { id: 'pasta', totalCents: 1200 },
        { id: 'salad', totalCents: 800 },
      ],
      claims: [
        { itemId: 'pasta', userId: A, parts: 1 },
        { itemId: 'salad', userId: B, parts: 1 },
      ],
      participantIds: [A, B],
      extrasMode: 'proportional',
    };
    const renamed: SplitInput = {
      ...bill,
      items: [
        { id: 'green salad', totalCents: 800 },
        { id: 'penne', totalCents: 1200 },
      ],
      claims: [
        { itemId: 'penne', userId: A, parts: 1 },
        { itemId: 'green salad', userId: B, parts: 1 },
      ],
      participantIds: [B, A],
    };
    const keyOf = (input: SplitInput) =>
      planKey({
        mode: 'one',
        leadId: A,
        payers: [{ userId: A, paidCents: input.totalCents }],
        shares: computeShares(input).people.map((p) => ({ userId: p.userId, shareCents: p.totalCents })),
      });
    expect(keyOf(renamed)).toBe(keyOf(bill));
    // Positive control: a 1¢ price change (same total) moves money between people, so the key moves.
    const repriced: SplitInput = { ...bill, items: [{ id: 'pasta', totalCents: 1201 }, { id: 'salad', totalCents: 799 }] };
    expect(keyOf(repriced)).not.toBe(keyOf(bill));
  });

  it('gives no collisions over a seeded sweep of 20,000 nearby states', () => {
    const keys = new Set<string>();
    let n = 0;
    for (let a = 0; a < 100; a += 1) {
      for (let b = 0; b < 200; b += 1) {
        keys.add(
          planKey({
            mode: 'split',
            leadId: A,
            payers: [
              { userId: A, paidCents: 5000 + a },
              { userId: B, paidCents: 5000 - a },
            ],
            shares: [
              { userId: A, shareCents: 3000 + b },
              { userId: B, shareCents: 3000 - b + a },
              { userId: C, shareCents: 4000 - a },
            ],
          }),
        );
        n += 1;
      }
    }
    expect(keys.size).toBe(n);
  });

  it('refuses input that breaks contract W, with RangeError', () => {
    const bad: PlanKeyInput[] = [
      { ...split, mode: 'both' as unknown as 'one' }, // not a mode
      { ...split, mode: 'one' }, // one person with two payers
      { ...oneA, mode: 'split' }, // split with one payer
      { ...split, leadId: C }, // lead isn't a payer
      { ...oneA, leadId: B }, // one person: the lead is the payer
      { ...split, payers: [split.payers[0]!, { userId: A, paidCents: 4021 }] }, // duplicate payer
      { ...split, shares: [...split.shares, { userId: A, shareCents: 0 }] }, // duplicate share
      { ...split, payers: [split.payers[0]!, { userId: 'zz', paidCents: 4021 }] }, // payer not on the bill
      { ...split, payers: [split.payers[0]!, { userId: B, paidCents: 40.21 }] }, // non-integer cents
      { ...split, payers: [split.payers[0]!, { userId: B, paidCents: -1 }] }, // negative paid
      { ...split, shares: [...split.shares.slice(0, 2), { userId: C, shareCents: 0.5 }] },
      { ...split, shares: [...split.shares.slice(0, 2), { userId: C, shareCents: 2 ** 53 }] },
      { ...split, leadId: '', payers: [{ userId: '', paidCents: 1 }, split.payers[1]!] }, // empty id
      { ...oneA, leadId: 'a|b', payers: [{ userId: 'a|b', paidCents: 1 }], shares: [{ userId: 'a|b', shareCents: 1 }] }, // delimiter
      { ...oneA, leadId: 'a:b', payers: [{ userId: 'a:b', paidCents: 1 }], shares: [{ userId: 'a:b', shareCents: 1 }] },
      { ...oneA, leadId: 'a,b', payers: [{ userId: 'a,b', paidCents: 1 }], shares: [{ userId: 'a,b', shareCents: 1 }] },
      { ...oneA, leadId: 'é', payers: [{ userId: 'é', paidCents: 1 }], shares: [{ userId: 'é', shareCents: 1 }] }, // non-ASCII
    ];
    for (const input of bad) expect(() => planKey(input)).toThrow(RangeError);
    // Sanity: the valid inputs these were built from don't throw.
    expect(() => planKey(split)).not.toThrow();
    expect(() => planKey(oneA)).not.toThrow();
  });

  it('accepts a one-person bill whose total is $0 (paid 0)', () => {
    expect(planKey({ mode: 'one', leadId: A, payers: [{ userId: A, paidCents: 0 }], shares: [{ userId: A, shareCents: 0 }] })).toMatch(
      PLAN_KEY_PATTERN,
    );
  });
});

// Filled in from the scratch reference script's output (independent of lib/transfers.ts).
const KNOWN_SPLIT_KEY = '82e9ff1c16285bbd';
const KNOWN_ONE_KEY = 'e1d3b175abd4e7d2';

// ===================================================================================================
// Task 2b: contract T (ledger), A1.2. Worked examples T0–T13 (criterion A-23), recomputed by hand from
// the algorithm before they were written here (see the task report). Ids: a < b < c < d < e.
// ===================================================================================================

const OLD_KEY = '0123456789abcdef'; // any key that isn't the current one: "made under an earlier state"
let entrySeq = 0;
function entry(fromId: string, toId: string, cents: number, planKeyOf: string | null, method: PaymentMethod = 'venmo'): Payment {
  entrySeq += 1;
  const n = String(entrySeq).padStart(6, '0');
  return { id: `e${n}`, fromId, toId, cents, method, planKey: planKeyOf, at: `2026-11-26T11:00:00.${n}+00:00` };
}

/** Contract W input: one payer = mode 'one'; the lead is the largest payer, ties to the lower id (WP-21). */
function bill(paid: Record<string, number>, shares: Record<string, number>, entries: Payment[] = []): SettleTransfersInput {
  const payers: PlanPayer[] = Object.entries(paid).map(([userId, paidCents]) => ({ userId, paidCents }));
  const lead = payers.slice().sort((x, y) => y.paidCents - x.paidCents || (x.userId < y.userId ? -1 : 1))[0]!;
  return {
    mode: payers.length === 1 ? 'one' : 'split',
    leadId: lead.userId,
    payers,
    shares: Object.entries(shares).map(([userId, shareCents]) => ({ userId, shareCents })),
    entries,
  };
}
const keyOf = (input: SettleTransfersInput): string =>
  planKey({ mode: input.mode, leadId: input.leadId, payers: input.payers, shares: input.shares });

/** A pair nobody has paid on yet. */
const route = (fromId: string, toId: string, cents: number): Pair => ({
  fromId,
  toId,
  targetCents: cents,
  paidCents: 0,
  remainingCents: cents,
  mark: null,
  difference: null,
});
/** A pair with payments on it; mark and difference follow contract P and contract D. */
function paidPair(fromId: string, toId: string, target: number, paid: number, entries: readonly Payment[]): Pair {
  return {
    fromId,
    toId,
    targetCents: target,
    paidCents: paid,
    remainingCents: target - paid,
    mark: paid > 0 ? pairState(entries, fromId, toId).mark : null,
    difference: paid > 0 ? differenceFor(target, paid) : null,
  };
}
const noProvenance = { heldFor: {}, passedOnBy: {} };

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs the input as given and in 20 shuffled orders: the output must not change. */
function transfersOf(input: SettleTransfersInput): SettleTransfers {
  const out = settleTransfers(input);
  const rand = mulberry32(7);
  for (let i = 0; i < 20; i += 1) {
    const again = settleTransfers({
      ...input,
      payers: shuffled(input.payers, rand),
      shares: shuffled(input.shares, rand),
      entries: shuffled(input.entries, rand),
    });
    expect(again).toEqual(out);
  }
  expect(out.key).toBe(currentPlanKey(input));
  // With no earlier-key history (every entry stamped with planKey(...)), K is A1's planKey exactly.
  if (input.entries.every((e) => e.planKey === keyOf(input))) expect(out.key).toBe(keyOf(input));
  return out;
}

describe('contract T: worked examples (A1.2)', () => {
  it("T0 (the user's): the payer moves from Sam to You after Priya paid Sam; Sam passes Priya's $12 on", () => {
    // $40.00. Shares You 1400, Sam 1400, Priya 1200. Sam was the payer; Priya paid Sam 1200 then.
    const shares = { priya: 1200, sam: 1400, you: 1400 };
    const before = bill({ sam: 4000 }, shares);
    const p2s = entry('priya', 'sam', 1200, keyOf(before));
    const input = bill({ you: 4000 }, shares, [p2s]);
    // p: you 4000 − 1400 = 2600; sam −1400 − 1200 = −2600; priya −1200 + 1200 = 0. Greedy sam→you 2600.
    expect(planRoutes(input).positions).toEqual({ priya: 0, sam: -2600, you: 2600 });
    const held: HeldMoney = { kind: 'passed_on', senderId: 'priya', holderId: 'sam', cents: 1200, onwardIds: ['you'] };
    expect(transfersOf(input)).toEqual({
      key: currentPlanKey(input), // Priya's entry is earlier-key, so K covers it (see currentPlanKey)
      pairs: [paidPair('priya', 'sam', 1200, 1200, [p2s]), route('sam', 'you', 2600)],
      outside: [],
      provenance: { heldFor: { sam: [held] }, passedOnBy: { priya: [held] } },
    });
    // Priya's pair is settled: no difference, nothing remaining.
    expect(transfersOf(input).pairs[0]).toMatchObject({ remainingCents: 0, difference: null, mark: { cents: 1200 } });
  });

  it('T1: C pays two people (A 2659, B 681)', () => {
    // p: A 6000 − 3341 = 2659, B 4021 − 3340 = 681, C −3340. C→A 2659, then C→B 681.
    const input = bill({ a: 6000, b: 4021 }, { a: 3341, b: 3340, c: 3340 });
    expect(transfersOf(input)).toEqual({ key: keyOf(input), pairs: [route('c', 'a', 2659), route('c', 'b', 681)], outside: [], provenance: noProvenance });
  });

  it('T2: 50/50 between two payers', () => {
    // p: A 2500, B 2500, C −2500, D −2500. C (lower id) → A (lower id), then D → B.
    const input = bill({ a: 5000, b: 5000 }, { a: 2500, b: 2500, c: 2500, d: 2500 });
    expect(transfersOf(input).pairs).toEqual([route('c', 'a', 2500), route('d', 'b', 2500)]);
  });

  it("T3: one payer, a negative share and a $0 share: today's plan", () => {
    // Total 3410. p: A 1410, B −1510, C 100, D 0. Pin C: outside A→C 100 (A 1510, C 0). B→A 1510.
    const input = bill({ a: 3410 }, { a: 2000, b: 1510, c: -100, d: 0 });
    const out = transfersOf(input);
    expect(out.pairs).toEqual([route('b', 'a', 1510)]);
    expect(out.outside).toEqual<Outside[]>([{ fromId: 'a', toId: 'c', cents: 100 }]);
  });

  it('T4: a negative-share non-payer is pinned to the lead; C pays both payers', () => {
    // p: A 3000, B 1000, C −4100, D 100. Pin D: A 3100. C→A 3100, C→B 1000.
    const input = bill({ a: 6000, b: 4000 }, { a: 3000, b: 3000, c: 4100, d: -100 });
    const out = transfersOf(input);
    expect(out.pairs).toEqual([route('c', 'a', 3100), route('c', 'b', 1000)]);
    expect(out.outside).toEqual([{ fromId: 'a', toId: 'd', cents: 100 }]);
  });

  it('T5: a payer owes two people', () => {
    // p: A −3000, B 2000, E 1000. A→B 2000, A→E 1000.
    const input = bill({ a: 5000, b: 3000, e: 2000 }, { a: 8000, b: 1000, e: 1000 });
    expect(transfersOf(input).pairs).toEqual([route('a', 'b', 2000), route('a', 'e', 1000)]);
  });

  describe('T6: stability', () => {
    const base = bill({ a: 6000, b: 4000 }, { a: 0, b: 0, c: 5000, d: 5000 });

    it('plans C→A 5000, D→A 1000, D→B 4000', () => {
      // p: A 6000, B 4000, C −5000, D −5000. C→A 5000 (A 1000); D→B 4000 (B is now largest); D→A 1000.
      expect(transfersOf(base).pairs).toEqual([route('c', 'a', 5000), route('d', 'a', 1000), route('d', 'b', 4000)]);
      expect(planRoutes(base).greedy).toEqual([
        { fromId: 'c', toId: 'a', cents: 5000 },
        { fromId: 'd', toId: 'b', cents: 4000 },
        { fromId: 'd', toId: 'a', cents: 1000 },
      ]);
    });

    it('C pays A 2000 with the current key: only that pair changes', () => {
      const pay2000 = entry('c', 'a', 2000, keyOf(base));
      const out = transfersOf({ ...base, entries: [pay2000] });
      expect(out.pairs).toEqual([paidPair('c', 'a', 5000, 2000, [pay2000]), route('d', 'a', 1000), route('d', 'b', 4000)]);
      expect(out.pairs[0]).toMatchObject({ remainingCents: 3000, difference: { kind: 'more', cents: 3000 } });
    });

    it('contrast: the same 2000 under a stale key re-plans around it', () => {
      // p: A 4000, B 4000, C −3000, D −5000. D→A 4000 (tie → A); C→B 3000; D→B 1000.
      const stale = entry('c', 'a', 2000, OLD_KEY);
      const out = transfersOf({ ...base, entries: [stale] });
      expect(out.pairs).toEqual([
        paidPair('c', 'a', 2000, 2000, [stale]),
        route('c', 'b', 3000),
        route('d', 'a', 4000),
        route('d', 'b', 1000),
      ]);
      expect(out.pairs[0]).toMatchObject({ remainingCents: 0, difference: null });
    });
  });

  it('T7: a bill change after D paid B: D→B stays settled, nobody is refunded', () => {
    const t2 = bill({ a: 5000, b: 5000 }, { a: 2500, b: 2500, c: 2500, d: 2500 });
    const d2b = entry('d', 'b', 2500, keyOf(t2));
    const input = bill({ a: 5000, b: 5000 }, { a: 2500, b: 2500, c: 2400, d: 2600 }, [d2b]);
    expect(keyOf(input)).not.toBe(keyOf(t2));
    // p: A 2500, B 0, C −2400, D −100. C→A 2400, D→A 100.
    const out = transfersOf(input);
    expect(out.pairs).toEqual([route('c', 'a', 2400), route('d', 'a', 100), paidPair('d', 'b', 2500, 2500, [d2b])]);
    expect(planRoutes(input).refunds).toEqual([]);
  });

  it("T8: a payer whose share is $0 is the lead on a tie and collects C's share", () => {
    const input = bill({ a: 5000, b: 5000 }, { a: 0, b: 5000, c: 5000 });
    expect(input.leadId).toBe('a');
    expect(transfersOf(input).pairs).toEqual([route('c', 'a', 5000)]);
  });

  it('T9: an off-route payment with the current key: B pays it back, the routes stay', () => {
    const t2 = bill({ a: 5000, b: 5000 }, { a: 2500, b: 2500, c: 2500, d: 2500 });
    const c2b = entry('c', 'b', 2500, keyOf(t2));
    const out = transfersOf({ ...t2, entries: [c2b] });
    expect(out.pairs).toEqual([route('c', 'a', 2500), paidPair('c', 'b', 0, 2500, [c2b]), route('d', 'b', 2500)]);
    expect(out.pairs[1]).toMatchObject({ remainingCents: -2500, difference: { kind: 'back', cents: 2500, toCents: 0 } });
  });

  it('T10: 1¢', () => {
    const input = bill({ a: 2, b: 1 }, { a: 1, b: 1, c: 1 });
    expect(transfersOf(input).pairs).toEqual([route('c', 'a', 1)]);
  });

  it("T11: a payer's negative share isn't pinned", () => {
    // p: A 600 − 1100 = −500, B 400 + 100 = 500. A→B 500, nothing outside.
    const input = bill({ a: 600, b: 400 }, { a: 1100, b: -100 });
    const out = transfersOf(input);
    expect(out.pairs).toEqual([route('a', 'b', 500)]);
    expect(out.outside).toEqual([]);
  });

  it('T12: single payer; B paid, then their share went negative: back 1510 and outside 100 (= today)', () => {
    // Total 3010. p: A −1610, B 1610. Pin: outside A→B 100 (A −1510, B 1510). Refund A→B 1510.
    const b2a = entry('b', 'a', 1510, null);
    const input = bill({ a: 3010 }, { a: 3110, b: -100 }, [b2a]);
    const out = transfersOf(input);
    expect(out.pairs).toEqual([paidPair('b', 'a', 0, 1510, [b2a])]);
    expect(out.pairs[0]).toMatchObject({ remainingCents: -1510, difference: { kind: 'back', cents: 1510 } });
    expect(out.outside).toEqual([{ fromId: 'a', toId: 'b', cents: 100 }]);
    expect(planRoutes(input).refunds).toEqual([{ fromId: 'a', toId: 'b', cents: 1510 }]);
  });

  it('T13: a payer pair reverses; A returns the $3.00 B sent inside the 500 remaining', () => {
    const first = bill({ a: 600, b: 400 }, { a: 300, b: 700 }); // B→A 300
    expect(settleTransfers(first).pairs).toEqual([route('b', 'a', 300)]);
    const b2a = entry('b', 'a', 300, keyOf(first));
    const input = bill({ a: 600, b: 400 }, { a: 800, b: 200 }, [b2a]);
    // p: A 600 − 800 − 300 = −500, B 400 − 200 + 300 = 500. A→B 500. Pair A→B: target −300 + 500 = 200.
    const held: HeldMoney = { kind: 'returned', senderId: 'b', holderId: 'a', cents: 300, onwardIds: ['b'] };
    expect(transfersOf(input)).toEqual({
      key: currentPlanKey(input),
      pairs: [{ fromId: 'a', toId: 'b', targetCents: 200, paidCents: -300, remainingCents: 500, mark: null, difference: null }],
      outside: [],
      provenance: { heldFor: { a: [held] }, passedOnBy: { b: [held] } },
    });
  });
});

describe('contract T: the rest of the contract', () => {
  it('step 4 repeats: a refund that leaves an earlier non-payer owed is refunded in turn (A1 refinement)', () => {
    // Payers w 1000 (lead on the tie), x 1000. b paid w 1000 earlier; c paid b 500 earlier. Shares now
    // w 500, x 1500, b 0, c 0. p: w −500, x −500, b 500, c 500.
    // Pass 1: b ← w 500 (w 0); c ← b 500 (b back to 500). Pass 2: b ← w 500 (w 500). Greedy x→w 500.
    // A1's single pass would leave b owed 500 and route x → b: money to someone who isn't a payer.
    const input = bill({ w: 1000, x: 1000 }, { b: 0, c: 0, w: 500, x: 1500 }, [entry('b', 'w', 1000, null), entry('c', 'b', 500, null)]);
    const plan = planRoutes(input);
    expect(plan.positions).toEqual({ b: 500, c: 500, w: -500, x: -500 });
    expect(plan.refunds).toEqual([
      { fromId: 'w', toId: 'b', cents: 500 },
      { fromId: 'b', toId: 'c', cents: 500 },
      { fromId: 'w', toId: 'b', cents: 500 },
    ]);
    expect(plan.greedy).toEqual([{ fromId: 'x', toId: 'w', cents: 500 }]);
    const out = transfersOf(input);
    expect(out.pairs.map((q) => [q.fromId, q.toId, q.targetCents, q.paidCents, q.remainingCents])).toEqual([
      ['b', 'w', 0, 1000, -1000],
      ['c', 'b', 0, 500, -500],
      ['x', 'w', 500, 0, 500],
    ]);
    // Positive control: without step 4 at all, money goes to b, a non-payer.
    const noRefunds = settleTransfers(input, { skipRefunds: true });
    expect(noRefunds.pairs.some((q) => q.remainingCents > 0 && (q.toId === 'b' || q.toId === 'c'))).toBe(true);
  });

  it("A1's route bound counts refunds on top: 2 routes from 2 nonzero positions (spec property is off by the refunds)", () => {
    // One payer a. b's share went to 0 after b paid a 500 earlier; c owes 500. p: a 0, b 500, c −500.
    // Refund a→b 500, then c→a 500: two routes, where "nonzero positions − 1" is 1. It's today's plan
    // (b gets 500 back, c owes 500), so the bound, not the plan, is what's wrong.
    const input = bill({ a: 1000 }, { a: 500, b: 0, c: 500 }, [entry('b', 'a', 500, null)]);
    const plan = planRoutes(input);
    expect(Object.values(plan.afterPins).filter((x) => x !== 0)).toHaveLength(2);
    expect(plan.refunds.length + plan.greedy.length).toBe(2);
    // What does hold: step 5 alone stays within the nonzero positions it starts from, minus 1.
    expect(plan.greedy.length).toBeLessThanOrEqual(Object.values(plan.beforeGreedy).filter((x) => x !== 0).length - 1);
  });

  it('early single-payer plan: the unclaimed amount counts as the lead’s share for routing only', () => {
    // Total 3000, so far a 500, b 1000, c 0 → unclaimed 1500 → a routes as 2000. p: a 1000, b −1000.
    const input: SettleTransfersInput = { ...bill({ a: 3000 }, { a: 500, b: 1000, c: 0 }), early: true };
    const out = transfersOf(input);
    expect(out.pairs).toEqual([route('b', 'a', 1000)]);
    expect(out.key).toBe(keyOf(input)); // over the shares as given
    expect(planRoutes(input).positions).toEqual({ a: 1000, b: -1000, c: 0 });
    // Negative unclaimed (an unclaimed discount) works the same way.
    const neg: SettleTransfersInput = { ...bill({ a: 900 }, { a: 500, b: 1000 }), early: true };
    expect(transfersOf(neg).pairs).toEqual([route('b', 'a', 1000)]);
  });

  it('a $0 one-person bill and a bill where everyone paid their share plan nothing', () => {
    expect(transfersOf(bill({ a: 0 }, { a: 0, b: 0 }))).toEqual({ key: keyOf(bill({ a: 0 }, { a: 0, b: 0 })), pairs: [], outside: [], provenance: noProvenance });
    expect(transfersOf(bill({ a: 500, b: 500 }, { a: 500, b: 500 })).pairs).toEqual([]);
  });

  it('a pair whose payments were undone to net 0 (entries kept) and no route is dropped', () => {
    const t = bill({ a: 1000 }, { a: 1000, b: 0 });
    const out = transfersOf({ ...t, entries: [entry('b', 'a', 500, keyOf(t)), entry('a', 'b', 500, keyOf(t))] });
    expect(out.pairs).toEqual([]);
  });

  it('largest amounts stay exact', () => {
    const big = 99_999_999;
    const input = bill({ a: big, b: big }, { a: 1, b: 1, c: 2 * big - 2 }, [entry('c', 'a', big, OLD_KEY)]);
    // p: a big − 1 − big = −1, b big − 1, c −(2big − 2) + big = −big + 2. Greedy c→b big−2, a→b 1.
    expect(transfersOf(input).pairs).toEqual([
      route('a', 'b', 1),
      paidPair('c', 'a', big, big, input.entries),
      route('c', 'b', big - 2),
    ]);
  });

  it('refuses input it cannot plan, with RangeError', () => {
    const ok = bill({ a: 1000, b: 1000 }, { a: 500, b: 500, c: 1000 });
    const bad: SettleTransfersInput[] = [
      { ...ok, shares: ok.shares.map((x) => (x.userId === 'c' ? { ...x, shareCents: 1001 } : x)) }, // Σ p = −1
      { ...ok, shares: ok.shares.map((x) => (x.userId === 'c' ? { ...x, shareCents: 999 } : x)) }, // Σ p = +1
      { ...ok, early: true }, // early is single-payer only
      { ...ok, entries: [{ ...entry('c', 'a', 1, null), cents: 10.5 }] }, // non-integer cents
      { ...ok, entries: [{ ...entry('c', 'a', 1, null), cents: 0 }] },
      { ...ok, entries: [{ ...entry('c', 'a', 1, null), cents: 100_000_000 }] },
      { ...ok, entries: [entry('c', 'zz', 1, null)] }, // not on the bill
      { ...ok, entries: [entry('c', 'c', 1, null)] }, // to self
      { ...ok, entries: [{ ...entry('c', 'a', 1, null), planKey: 'ABCDEF0123456789' }] }, // malformed key
      { ...ok, entries: [{ ...entry('c', 'a', 1, null), at: 'yesterday' }] },
      { ...ok, mode: 'one' }, // contract W (via planKey)
    ];
    const dup = entry('c', 'a', 1, null);
    bad.push({ ...ok, entries: [dup, { ...dup, fromId: 'b' }] }); // duplicate id
    for (const input of bad) expect(() => settleTransfers(input)).toThrow(RangeError);
    expect(() => settleTransfers({ ...ok, entries: [entry('c', 'a', 1, null)] })).not.toThrow(); // the control
  });
});

// ===================================================================================================
// The simulation property suite (A1.2 "Properties", criterion A-23). Each seeded run starts from a
// random bill (2–8 people, 1–4 payers, shares including 0 and negative, early single-payer plans
// too), then applies 1–12 random steps:
//   change   – a bill change: new shares, new payers, a whole new bill, someone joins, early ↔ complete;
//   pay      – a payment the UI allows: a pair with remaining > 0, paid in full or in part, current key;
//   payback  – a pay-back of a `back` difference (remaining < 0), in full or in part, current key;
//   undo     – undo or not-received of a mark: deletes the entries of the mark's current run (A1.3);
//   raw      – a raw earlier-key (or null-key) payment to a current payer.
// After every step every property is checked; a failure records seed, step and property.
// ===================================================================================================

const SIM_RUNS = 2000;
const MAX_CENTS = 99_999_999;
const METHODS: readonly PaymentMethod[] = ['venmo', 'cash', 'other'];

type SimState = {
  ids: string[];
  mode: 'one' | 'split';
  leadId: string;
  payers: PlanPayer[];
  shares: PlanShare[];
  early: boolean;
  entries: Payment[];
};
type StepKind = 'start' | 'change' | 'pay' | 'payback' | 'undo' | 'raw';
type Impl = (input: SettleTransfersInput) => SettleTransfers;
export type SimFailure = { seed: number; step: number; kind: StepKind; property: string; message: string };

class Sim {
  readonly rand: () => number;
  private clock = 0;
  private seq = 0;
  readonly scale: number;
  constructor(readonly seed: number) {
    this.rand = mulberry32(seed * 7919 + 13);
    this.scale = this.pick([5, 50, 2_000, 100_000, MAX_CENTS]);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)]!;
  }
  hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i += 1) s += '0123456789abcdef'[this.int(0, 15)];
    return s;
  }
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-8${this.hex(3)}-${this.hex(12)}`;
  }
  entryId(): string {
    this.seq += 1;
    return `${this.hex(8)}-0000-4000-8000-${String(this.seq).padStart(12, '0')}`; // random order, never repeats
  }
  /** recorded_at: mostly increasing, sometimes equal (then ordered by id). */
  at(): string {
    this.clock += this.int(0, 3);
    const c = this.clock;
    const mm = String(Math.floor(c / 60_000_000)).padStart(2, '0');
    const ss = String(Math.floor(c / 1_000_000) % 60).padStart(2, '0');
    return `2026-11-26T10:${mm}:${ss}.${String(c % 1_000_000).padStart(6, '0')}+00:00`;
  }
  /** n integers ≥ 0 summing to total ≥ 0 (random cuts, so zeros happen). */
  cuts(total: number, n: number): number[] {
    const points = Array.from({ length: n - 1 }, () => this.int(0, total)).sort((x, y) => x - y);
    const out: number[] = [];
    let prev = 0;
    for (const pt of [...points, total]) {
      out.push(pt - prev);
      prev = pt;
    }
    return out;
  }
  shares(ids: readonly string[], sum: number): PlanShare[] {
    const value = new Map<string, number>(ids.map((id) => [id, 0]));
    const rest: string[] = [];
    let negs = 0;
    for (const id of ids) {
      const r = this.rand();
      if (r < 0.12) {
        const neg = -this.int(1, Math.max(1, Math.floor(this.scale / 20)));
        value.set(id, neg);
        negs += neg;
      } else if (r < 0.3) {
        // a $0 share
      } else rest.push(id);
    }
    if (rest.length === 0) rest.push(this.pick(ids));
    let left = sum - negs;
    if (left < 0) {
      // Only when sum itself is negative (early with a big unclaimed discount): put it on one person.
      const id = this.pick(rest);
      value.set(id, (value.get(id) ?? 0) + left);
      left = 0;
    }
    this.cuts(left, rest.length).forEach((c, i) => {
      const id = rest[i]!;
      value.set(id, (value.get(id) ?? 0) + c);
    });
    return this.shuffle(ids.map((userId) => ({ userId, shareCents: value.get(userId) ?? 0 })));
  }
  shuffle<T>(xs: readonly T[]): T[] {
    return shuffled(xs, this.rand);
  }
  /** Contract W: new payers for `total`. */
  payersFor(ids: readonly string[], total: number): Pick<SimState, 'mode' | 'leadId' | 'payers'> {
    const n = Math.min(this.int(1, 4), ids.length, Math.max(1, total));
    const who = this.shuffle(ids).slice(0, n);
    if (n === 1) return { mode: 'one', leadId: who[0]!, payers: [{ userId: who[0]!, paidCents: total }] };
    const amounts = this.cuts(total - n, n).map((x) => x + 1);
    const payers = who.map((userId, i) => ({ userId, paidCents: amounts[i]! }));
    const lead = payers.slice().sort((x, y) => y.paidCents - x.paidCents || (x.userId < y.userId ? -1 : 1))[0]!;
    return { mode: 'split', leadId: lead.userId, payers };
  }
  total(): number {
    return this.int(this.rand() < 0.05 ? 0 : 4, Math.min(MAX_CENTS, this.scale * 4));
  }
  /** Shares for the state's payers: Σ = total, or "so far" shares on an early one-person plan. */
  sharesFor(state: Pick<SimState, 'ids' | 'payers' | 'early'>): PlanShare[] {
    const total = state.payers.reduce((s, p) => s + p.paidCents, 0);
    if (!state.early) return this.shares(state.ids, total);
    const unclaimed = this.rand() < 0.85 ? this.int(0, total) : -this.int(1, Math.max(1, Math.floor(this.scale / 20)));
    return this.shares(state.ids, total - unclaimed);
  }
  start(): SimState {
    const n = this.int(2, 8);
    const ids = new Set<string>();
    while (ids.size < n) ids.add(this.uuid());
    const state: SimState = { ids: [...ids], mode: 'one', leadId: '', payers: [], shares: [], early: false, entries: [] };
    Object.assign(state, this.payersFor(state.ids, this.total()));
    state.early = state.mode === 'one' && this.rand() < 0.15;
    state.shares = this.sharesFor(state);
    // Some runs start with history from an earlier state (null keys: the data copy of A1.3).
    const history = this.int(0, 2);
    for (let i = 0; i < history; i += 1) this.raw(state, true);
    return state;
  }
  entry(fromId: string, toId: string, cents: number, key: string | null): Payment {
    return { id: this.entryId(), fromId, toId, cents, method: this.pick(METHODS), planKey: key, at: this.at() };
  }
  amount(remaining: number): number {
    const full = Math.min(remaining, MAX_CENTS);
    return this.rand() < 0.6 ? full : this.int(1, full);
  }
  raw(state: SimState, forceNull = false): void {
    const to = this.pick(state.payers).userId;
    const from = this.pick(state.ids.filter((id) => id !== to));
    const key = forceNull || this.rand() < 0.5 ? null : this.hex(16);
    state.entries.push(this.entry(from, to, this.int(1, Math.min(MAX_CENTS, Math.max(1, this.scale))), key));
  }
  change(state: SimState): void {
    const r = this.rand();
    const total = state.payers.reduce((s, p) => s + p.paidCents, 0);
    if (r < 0.35) {
      state.shares = this.sharesFor(state); // claims or prices moved, same total
    } else if (r < 0.6) {
      Object.assign(state, this.payersFor(state.ids, total)); // who paid changed
      if (state.mode === 'split' && state.early) {
        state.early = false;
        state.shares = this.sharesFor(state);
      }
    } else if (r < 0.8) {
      Object.assign(state, this.payersFor(state.ids, this.total())); // a new total
      state.early = state.mode === 'one' && this.rand() < 0.2;
      state.shares = this.sharesFor(state);
    } else if (r < 0.9 && state.ids.length < 8) {
      const id = this.uuid(); // someone joins with nothing claimed
      state.ids.push(id);
      state.shares = [...state.shares, { userId: id, shareCents: 0 }];
    } else if (state.mode === 'one') {
      state.early = !state.early; // the last item gets claimed, or an item is added
      state.shares = this.sharesFor(state);
    } else {
      state.shares = this.sharesFor(state);
    }
  }
}

function inputOf(state: SimState): SettleTransfersInput {
  return { mode: state.mode, leadId: state.leadId, payers: state.payers, shares: state.shares, entries: state.entries, early: state.early };
}

/** The entries of (u→v)'s current mark run (contract P: from markAt on, both directions). */
function runOf(entries: readonly Payment[], u: string, v: string): Payment[] {
  const pair = entries.filter((e) => (e.fromId === u && e.toId === v) || (e.fromId === v && e.toId === u)).sort(comparePayments);
  let r = 0;
  let start = -1;
  pair.forEach((e, k) => {
    const before = r;
    r += e.fromId === u ? e.cents : -e.cents;
    if (before <= 0 && r > 0) start = k;
  });
  return r > 0 ? pair.slice(start) : [];
}

/** Today's settlePlan (lib/settle.ts) on the same shares, as pairs and outside routes (S1 shape). */
function todayOf(state: SimState): { pairs: Pair[]; outside: Outside[] } | string {
  const payerId = state.leadId;
  const total = state.payers[0]!.paidCents;
  const items: SplitInput['items'] = [];
  const claims: SplitInput['claims'] = [];
  for (const s of state.shares) {
    if (s.shareCents === 0) continue;
    items.push({ id: `row-${s.userId}`, totalCents: s.shareCents, kind: s.shareCents < 0 ? 'discount' : 'item' });
    claims.push({ itemId: `row-${s.userId}`, userId: s.userId, parts: 1 });
  }
  if (state.early) {
    const unclaimed = total - state.shares.reduce((sum, s) => sum + s.shareCents, 0);
    items.push({ id: 'unclaimed', totalCents: unclaimed, kind: unclaimed < 0 ? 'discount' : 'item' });
  }
  const input: SplitInput = { totalCents: total, items, claims, participantIds: state.ids, extrasMode: 'proportional' };
  const marks: Record<string, SettleMarks[string]> = {};
  for (const id of state.ids) {
    if (id === payerId) continue;
    const mark = pairState(state.entries, id, payerId).mark;
    marks[id] = mark ? { cents: mark.cents, at: mark.at, method: mark.method as PaymentMethod, toUserId: payerId } : null;
  }
  const plan = settlePlan(input, payerId, marks, { allowEarly: true });
  const want = state.early ? 'early' : 'ready';
  if (plan.status !== want) return `settlePlan gave ${plan.status}, not ${want}`;
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
  const order = (x: { fromId: string; toId: string }, y: { fromId: string; toId: string }) =>
    x.fromId < y.fromId ? -1 : x.fromId > y.fromId ? 1 : x.toId < y.toId ? -1 : x.toId > y.toId ? 1 : 0;
  return { pairs: pairs.sort(order), outside: outside.sort(order) };
}

const pairKey = (x: { fromId: string; toId: string }): string => (x.fromId < x.toId ? `${x.fromId}|${x.toId}` : `${x.toId}|${x.fromId}`);
const nonzero = (r: Record<string, number>): number => Object.values(r).filter((x) => x !== 0).length;

type Stats = { steps: number; byKind: Record<StepKind, number>; singlePayerChecks: number; refundsPlanned: number; a1BoundMisses: number };

/** Deep equality with Object.is on leaves (so 0 and −0 differ, as in toEqual), for plain data. */
function eq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
/** Like expect(a).toEqual(b), but only pays for expect (a stack capture per call) when it fails. */
function same(a: unknown, b: unknown): void {
  if (!eq(a, b)) expect(a).toEqual(b);
}
function must(cond: boolean, what: () => string): void {
  if (!cond) throw new Error(what());
}

/** Checks every property of one state; pushes a failure per property that doesn't hold. */
function checkState(
  sim: Sim,
  state: SimState,
  out: SettleTransfers,
  impl: Impl,
  fail: (property: string, message: string) => void,
  stats: Stats,
): void {
  const input = inputOf(state);
  const payerIds = new Set(state.payers.map((p) => p.userId));
  const check = (property: string, body: () => void) => {
    try {
      body();
    } catch (e) {
      fail(property, e instanceof Error ? e.message.slice(0, 600) : String(e));
    }
  };
  const stateOf = new Map<string, ReturnType<typeof pairState>>();
  const pairOf = (u: string, v: string) => {
    const k = `${u}>${v}`;
    let r = stateOf.get(k);
    if (!r) stateOf.set(k, (r = pairState(state.entries, u, v)));
    return r;
  };

  check('zeroing', () => {
    // p_all_u (routing shares, every entry) + Σ remaining out − Σ remaining in + outside = 0, exactly.
    const paidSum = state.payers.reduce((s, p) => s + p.paidCents, 0);
    const shareSum = state.shares.reduce((s, x) => s + x.shareCents, 0);
    const p = new Map<string, number>(state.ids.map((id) => [id, 0]));
    const add = (id: string, x: number) => p.set(id, (p.get(id) ?? 0) + x);
    for (const x of state.payers) add(x.userId, x.paidCents);
    for (const x of state.shares) add(x.userId, -x.shareCents);
    if (state.early) add(state.leadId, -(paidSum - shareSum));
    for (const e of state.entries) {
      add(e.fromId, e.cents);
      add(e.toId, -e.cents);
    }
    for (const q of out.pairs) {
      add(q.fromId, q.remainingCents);
      add(q.toId, -q.remainingCents);
    }
    for (const q of out.outside) {
      add(q.fromId, q.cents);
      add(q.toId, -q.cents);
    }
    if ([...p.values()].some((x) => x !== 0)) expect(Object.fromEntries(p)).toEqual(Object.fromEntries(state.ids.map((id) => [id, 0])));
  });

  check('shape', () => {
    must(out.key === currentPlanKey(input) && PLAN_KEY_PATTERN.test(out.key), () => `key ${out.key}`);
    const seen = new Set<string>();
    out.pairs.forEach((q, i) => {
      const prev = out.pairs[i - 1];
      must(!prev || prev.fromId < q.fromId || (prev.fromId === q.fromId && prev.toId < q.toId), () => `order at ${i}`);
      must(!seen.has(pairKey(q)), () => `pair twice ${pairKey(q)}`);
      seen.add(pairKey(q));
      must(q.targetCents >= 0 && (q.targetCents > 0 || q.paidCents > 0), () => `orientation ${JSON.stringify(q)}`);
      must(q.remainingCents === q.targetCents - q.paidCents, () => `remaining ${JSON.stringify(q)}`);
      const ps = pairOf(q.fromId, q.toId);
      must(q.paidCents === ps.net, () => `paid ${JSON.stringify(q)} vs net ${ps.net}`);
      same(q.mark, q.paidCents > 0 ? ps.mark : null);
      same(q.difference, q.paidCents > 0 ? differenceFor(q.targetCents, q.paidCents) : null);
    });
    // Every pair with an entry is shown unless both its target and paid are 0.
    for (const e of state.entries) must(seen.has(pairKey(e)) || pairOf(e.fromId, e.toId).net === 0, () => `missing pair ${pairKey(e)}`);
    const pins = state.shares
      .filter((x) => !payerIds.has(x.userId) && x.shareCents < 0)
      .map((x) => ({ fromId: state.leadId, toId: x.userId, cents: -x.shareCents }))
      .sort((x, y) => (x.toId < y.toId ? -1 : 1));
    same(out.outside, pins);
  });

  check('to-payer', () => {
    // Every pair still to pay goes to a current payer.
    for (const q of out.pairs) must(q.remainingCents <= 0 || payerIds.has(q.toId), () => `owed to a non-payer: ${JSON.stringify(q)}`);
  });

  check('deterministic', () => {
    same(impl({ ...input, payers: sim.shuffle(state.payers), shares: sim.shuffle(state.shares), entries: sim.shuffle(state.entries) }), out);
  });

  check('route-bound', () => {
    const plan = planRoutes(input);
    // Step 5 (GR-3): at most (nonzero positions it starts from) − 1 transfers.
    must(plan.greedy.length <= Math.max(0, nonzero(plan.beforeGreedy) - 1), () => `greedy ${plan.greedy.length}`);
    // Steps 4–5 together: A1's bound, which holds whenever step 4 planned nothing.
    must(plan.refunds.length > 0 || plan.greedy.length <= Math.max(0, nonzero(plan.afterPins) - 1), () => 'A1 bound without refunds');
    // Refunds only go to non-payers, and after them no non-payer is owed anything.
    for (const r of plan.refunds) must(!payerIds.has(r.toId), () => `refund to payer ${r.toId}`);
    for (const id of state.ids) must(payerIds.has(id) || (plan.beforeGreedy[id] ?? 0) <= 0, () => `non-payer owed ${id}`);
    stats.refundsPlanned += plan.refunds.length;
    if (plan.refunds.length + plan.greedy.length > Math.max(0, nonzero(plan.afterPins) - 1)) stats.a1BoundMisses += 1;
  });

  check('provenance', () => {
    const order = (x: HeldMoney, y: HeldMoney) => (`${x.holderId}|${x.senderId}` < `${y.holderId}|${y.senderId}` ? -1 : 1);
    const all = Object.values(out.provenance.heldFor).flat();
    same(Object.values(out.provenance.passedOnBy).flat().sort(order), [...all].sort(order));
    const heldBy = new Map<string, number>();
    for (const h of all) {
      must(h.cents > 0, () => 'held 0');
      if (h.kind === 'passed_on') {
        must(!payerIds.has(h.holderId) && h.onwardIds.length > 0, () => `passed_on ${JSON.stringify(h)}`);
        heldBy.set(h.holderId, (heldBy.get(h.holderId) ?? 0) + h.cents);
      } else {
        const q = out.pairs.find((x) => x.fromId === h.holderId && x.toId === h.senderId);
        must(eq(h.onwardIds, [h.senderId]) && q?.paidCents === -h.cents, () => `returned ${JSON.stringify(h)}`);
      }
    }
    // What a non-payer holds never exceeds what they send on.
    for (const [holder, cents] of heldBy) {
      const onward = out.pairs.filter((x) => x.fromId === holder).reduce((s, x) => s + x.targetCents, 0);
      must(cents <= onward, () => `holds ${cents} > onward ${onward}`);
    }
  });

  const single =
    state.payers.length === 1 &&
    state.entries.every((e) => e.fromId === state.leadId || e.toId === state.leadId) &&
    state.ids.every((id) => id === state.leadId || pairOf(id, state.leadId).net >= 0);
  if (single) {
    stats.singlePayerChecks += 1;
    check('single-payer', () => {
      const today = todayOf(state);
      if (typeof today === 'string') throw new Error(today);
      same({ pairs: out.pairs, outside: out.outside }, today);
      same(out.provenance, { heldFor: {}, passedOnBy: {} });
    });
    check('partition', () => {
      // The same answer whether this state's entries are earlier-key or current-key (the key itself
      // differs: it covers which entries are earlier-key).
      const pairsOf = ({ pairs, outside, provenance }: SettleTransfers) => ({ pairs, outside, provenance });
      const asPost = state.entries.map((e) => ({ ...e, planKey: keyOf(input) }));
      must(currentPlanKey({ ...input, entries: asPost }) === keyOf(input), () => 'not all post'); // really all post
      same(pairsOf(impl({ ...input, entries: state.entries.map((e) => ({ ...e, planKey: null })) })), pairsOf(out));
      same(pairsOf(impl({ ...input, entries: asPost })), pairsOf(out));
    });
  }
}

/** Every pair other than `paid` (and the outside routes and key) is exactly as before. */
function checkStable(before: SettleTransfers, after: SettleTransfers, paid: string): void {
  must(after.key === before.key, () => `key moved ${before.key} → ${after.key}`);
  same(after.outside, before.outside);
  same(after.pairs.filter((q) => pairKey(q) !== paid), before.pairs.filter((q) => pairKey(q) !== paid));
}

function simulate(seed: number, impl: Impl, stats: Stats, stopAt?: string): SimFailure[] {
  const sim = new Sim(seed);
  const failures: SimFailure[] = [];
  const state = sim.start();
  let step = 0;
  let kind: StepKind = 'start';
  const fail = (property: string, message: string) => {
    failures.push({ seed, step, kind, property, message });
  };
  const run = (): SettleTransfers | null => {
    try {
      return impl(inputOf(state));
    } catch (e) {
      fail('throws', e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  let out = run();
  if (!out) return failures;
  checkState(sim, state, out, impl, fail, stats);
  const steps = sim.int(1, 12);
  for (step = 1; step <= steps; step += 1) {
    if (stopAt && failures.some((f) => f.property === stopAt)) break;
    const before = out;
    const r = sim.rand();
    let paidPairKey: string | null = null;
    let undoneAllPost = false;
    kind = r < 0.2 ? 'change' : r < 0.5 ? 'pay' : r < 0.65 ? 'payback' : r < 0.8 ? 'undo' : 'raw';
    if (kind === 'pay') {
      const open = before.pairs.filter((q) => q.remainingCents > 0);
      if (open.length === 0) kind = 'raw';
      else {
        const q = sim.pick(open);
        state.entries.push(sim.entry(q.fromId, q.toId, sim.amount(q.remainingCents), before.key));
        paidPairKey = pairKey(q);
      }
    } else if (kind === 'payback') {
      const back = before.pairs.filter((q) => q.remainingCents < 0);
      if (back.length === 0) kind = 'raw';
      else {
        const q = sim.pick(back);
        state.entries.push(sim.entry(q.toId, q.fromId, sim.amount(-q.remainingCents), before.key));
        paidPairKey = pairKey(q);
      }
    } else if (kind === 'undo') {
      const marked = before.pairs.flatMap((q) => [
        [q.fromId, q.toId],
        [q.toId, q.fromId],
      ]).filter(([u, v]) => pairState(state.entries, u!, v!).mark !== null);
      if (marked.length === 0) kind = 'raw';
      else {
        const [u, v] = sim.pick(marked) as [string, string];
        const gone = new Set(runOf(state.entries, u, v).map((e) => e.id));
        undoneAllPost = state.entries.every((e) => !gone.has(e.id) || e.planKey === before.key);
        state.entries = state.entries.filter((e) => !gone.has(e.id));
        paidPairKey = pairKey({ fromId: u, toId: v });
      }
    }
    if (kind === 'change') sim.change(state);
    if (kind === 'raw') sim.raw(state);
    stats.byKind[kind] += 1;
    stats.steps += 1;

    const next = run();
    if (!next) break;
    checkState(sim, state, next, impl, fail, stats);
    if ((kind === 'pay' || kind === 'payback') && paidPairKey) {
      try {
        checkStable(before, next, paidPairKey);
      } catch (e) {
        fail('stability', e instanceof Error ? e.message.slice(0, 600) : String(e));
      }
    }
    if (kind === 'undo' && undoneAllPost && paidPairKey) {
      try {
        checkStable(before, next, paidPairKey);
      } catch (e) {
        fail('undo-stability', e instanceof Error ? e.message.slice(0, 600) : String(e));
      }
    }
    out = next;
  }
  return failures;
}

function newStats(): Stats {
  return { steps: 0, byKind: { start: 0, change: 0, pay: 0, payback: 0, undo: 0, raw: 0 }, singlePayerChecks: 0, refundsPlanned: 0, a1BoundMisses: 0 };
}

/** Runs seeds until `property` fails (or all ran); returns the first such failure. */
function firstFailure(impl: Impl, property: string): SimFailure | null {
  const stats = newStats();
  for (let seed = 1; seed <= SIM_RUNS; seed += 1) {
    const hit = simulate(seed, impl, stats, property).find((f) => f.property === property);
    if (hit) return hit;
  }
  return null;
}

describe('contract T: the seeded simulation (A1.2 properties)', () => {
  const real: Impl = (input) => settleTransfers(input);

  it(`holds every property after every step of ${SIM_RUNS} runs`, () => {
    const stats = newStats();
    const failures: SimFailure[] = [];
    for (let seed = 1; seed <= SIM_RUNS; seed += 1) failures.push(...simulate(seed, real, stats));
    expect(failures.slice(0, 5)).toEqual([]);
    // The runs reach every kind of step and the interesting branches (no vacuous pass).
    for (const k of ['change', 'pay', 'payback', 'undo', 'raw'] as const) expect(stats.byKind[k]).toBeGreaterThan(300);
    expect(stats.singlePayerChecks).toBeGreaterThan(1000);
    expect(stats.refundsPlanned).toBeGreaterThan(100);
    expect(stats.a1BoundMisses).toBeGreaterThan(0); // A1's literal bound fails only with refunds (reported)
  });

  // The suite must fail with each deliberately broken version (A1.2, lesson 2026-11-26).
  it('fails when step 1 treats every entry as earlier-key (stability breaks)', () => {
    const allPre: Impl = (input) => settleTransfers({ ...input, entries: input.entries.map((e) => ({ ...e, planKey: null })) });
    expect(firstFailure(allPre, 'stability')).not.toBeNull();
  });

  it('fails when step 4 (refunds) is removed (single-payer back cases break)', () => {
    const noRefunds: Impl = (input) => settleTransfers(input, { skipRefunds: true });
    expect(firstFailure(noRefunds, 'single-payer')).not.toBeNull();
  });

  it('fails when step 6 is off by 1¢ (zeroing breaks)', () => {
    const offByOne: Impl = (input) => {
      const out = settleTransfers(input);
      const [first, ...rest] = out.pairs;
      if (!first) return out;
      return { ...out, pairs: [{ ...first, targetCents: first.targetCents + 1, remainingCents: first.remainingCents + 1 }, ...rest] };
    };
    expect(firstFailure(offByOne, 'zeroing')).not.toBeNull();
  });
});

describe('currentPlanKey: the key covers which entries are earlier-key (flagged refinement of A1)', () => {
  const t2 = bill({ a: 5000, b: 5000 }, { a: 2500, b: 2500, c: 2500, d: 2500 });

  it('is planKey(...) with no history, and stays put when a payment is stamped with it', () => {
    expect(currentPlanKey(t2)).toBe(keyOf(t2));
    const paid = [entry('c', 'a', 2500, keyOf(t2)), entry('d', 'b', 1000, keyOf(t2))];
    expect(currentPlanKey({ ...t2, entries: paid })).toBe(keyOf(t2));
  });

  it('with earlier-key history, a payment stamped with the current key keeps it', () => {
    const history = [entry('c', 'b', 700, null), entry('d', 'a', 300, OLD_KEY)];
    const k = currentPlanKey({ ...t2, entries: history });
    expect(k).not.toBe(keyOf(t2));
    expect(k).toMatch(PLAN_KEY_PATTERN);
    expect(currentPlanKey({ ...t2, entries: [...history, entry('c', 'a', 1800, k)] })).toBe(k);
    // ...and is the same for any order of the entries.
    expect(currentPlanKey({ ...t2, entries: [...history].reverse() })).toBe(k);
  });

  it('a stale-screen payment re-plans everything, the current-key payments included', () => {
    // C paid A 2500 on T2's plan; then D, on a stale screen, also paid A 2500. Folding both: A holds
    // 2500 too much and passes it on to B (1 payment). Under A1's K, C's payment would stay "on its
    // route", leaving A to return 2500 to C and C to pay B 2500 (2 payments).
    const c2a = entry('c', 'a', 2500, keyOf(t2));
    const d2a = entry('d', 'a', 2500, OLD_KEY);
    const input = { ...t2, entries: [c2a, d2a] };
    expect(currentPlanKey(input)).not.toBe(keyOf(t2));
    expect(transfersOf(input).pairs).toEqual([
      route('a', 'b', 2500),
      paidPair('c', 'a', 2500, 2500, [c2a]),
      paidPair('d', 'a', 2500, 2500, [d2a]),
    ]);
  });

  it('undoing the stale payment brings the earlier key and its routes back', () => {
    const c2a = entry('c', 'a', 2500, keyOf(t2));
    const out = transfersOf({ ...t2, entries: [c2a] }); // the d→a entry was deleted
    expect(out.key).toBe(keyOf(t2));
    expect(out.pairs).toEqual([paidPair('c', 'a', 2500, 2500, [c2a]), route('d', 'b', 2500)]);
  });

  it('regression (simulation seeds 286, 1182): a stale payment never leaves money owed to a non-payer', () => {
    // Payers p 600 (lead), r 400; shares p 500, r 500, n 0. Earlier: p→n 15, n→p 12.
    // Plan: r→p 100 and n pays p back 3. n pays back 1 on that plan; then n, on a stale screen, pays r 3.
    // Under A1's K the 1 stays "current" while the routes change: p would owe n (not a payer) 1.
    const start = bill({ p: 600, r: 400 }, { n: 0, p: 500, r: 500 }, [entry('p', 'n', 15, null), entry('n', 'p', 12, null)]);
    const first = transfersOf(start);
    expect(first.pairs.map((q) => [q.fromId, q.toId, q.remainingCents])).toEqual([
      ['p', 'n', -3],
      ['r', 'p', 100],
    ]);
    const back1 = entry('n', 'p', 1, first.key);
    const second = transfersOf({ ...start, entries: [...start.entries, back1] });
    expect(second.key).toBe(first.key);
    const stale = entry('n', 'r', 3, OLD_KEY);
    const input = { ...start, entries: [...start.entries, back1, stale] };
    const out = transfersOf(input);
    expect(out.key).not.toBe(first.key);
    // All folded: n is out 1 overall (got 15 from p, sent 13 back and 3 to r), so r returns 1.
    expect(out.pairs.map((q) => [q.fromId, q.toId, q.targetCents, q.paidCents, q.remainingCents])).toEqual([
      ['n', 'r', 2, 3, -1],
      ['p', 'n', 2, 2, 0],
      ['r', 'p', 102, 0, 102],
    ]);
    expect(out.pairs.filter((q) => q.remainingCents > 0).every((q) => q.toId === 'p' || q.toId === 'r')).toBe(true);
    // n keeps 2 of p's money and passes it on to r.
    expect(out.provenance.heldFor).toEqual({
      n: [{ kind: 'passed_on', senderId: 'p', holderId: 'n', cents: 2, onwardIds: ['r'] }],
    });
  });

  it('refuses entry ids that could collide inside the key', () => {
    expect(() => settleTransfers({ ...t2, entries: [{ ...entry('c', 'a', 1, null), id: 'x,y' }] })).toThrow(RangeError);
  });
});
