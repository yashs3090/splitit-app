// The groups worked example (spec docs/specs/2026-11-26-groups-mvp.md § "Worked example", W1–W6)
// as typed inputs for lib/groupBalance.ts, plus a seeded PRNG for the property tests.
// Reused by T10 (view models) and T12 (live reconciliation): keep the numbers in step with the spec.
//
// People in user-id order Ana < Ben < Cy < Dee (code-unit order of the lowercase uuid strings).

import type { GroupBalanceInput, GroupBill, GroupExpense, GroupPayment } from '@/lib/groupBalance';
import type { SplitClaim, SplitItem } from '@/lib/split';
import type { Transfer } from '@/lib/simplify';

export const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
export const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
export const CY = 'cccccccc-0000-4000-8000-000000000003';
export const DEE = 'dddddddd-0000-4000-8000-000000000004';
export const MEMBERS: readonly string[] = [ANA, BEN, CY, DEE];
export const NAMES: Readonly<Record<string, string>> = { [ANA]: 'Ana', [BEN]: 'Ben', [CY]: 'Cy', [DEE]: 'Dee' };

export const DINNER_ID = 'b1000000-0000-4000-8000-000000000001';
export const BRUNCH_ID = 'b2000000-0000-4000-8000-000000000002';
export const AIRBNB_ID = 'e1000000-0000-4000-8000-000000000001';
export const RENTAL_CAR_ID = 'e2000000-0000-4000-8000-000000000002';

const row = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const DINNER_ROWS = { ana: row(1), ben: row(2), cy: row(3), nachos: row(4), water: row(5), happyHour: row(6) } as const;
export const BRUNCH_ROWS = { ana: row(11), ben: row(12), cy: row(13), dee: row(14) } as const;

/**
 * Dinner: proportional, payer Ana; items Ana 2000, Ben 1800, Cy 1200, nachos 1000; tax 533 + tip.
 * Dee is a participant (every member is) and claims nothing. Default: nachos shared by Ana/Ben/Cy,
 * tip 1200 → total 7733, shares Ana 3008, Ben 2749, Cy 1976, Dee 0.
 */
export function dinnerBill(
  opts: {
    nachosClaimers?: readonly string[];
    tipCents?: number;
    /** S9: an unclaimed "Water" $0.00 row. */
    unclaimedWater?: boolean;
    /** S9: an unclaimed claimable "Happy hour" discount row of −500 (total drops by 500). */
    unclaimedHappyHour?: boolean;
  } = {},
): GroupBill {
  const nachosClaimers = opts.nachosClaimers ?? [ANA, BEN, CY];
  const tip = opts.tipCents ?? 1200;
  const discount = opts.unclaimedHappyHour ? -500 : 0;
  const items: SplitItem[] = [
    { id: DINNER_ROWS.ana, totalCents: 2000 },
    { id: DINNER_ROWS.ben, totalCents: 1800 },
    { id: DINNER_ROWS.cy, totalCents: 1200 },
    { id: DINNER_ROWS.nachos, totalCents: 1000 },
    ...(opts.unclaimedWater ? [{ id: DINNER_ROWS.water, totalCents: 0 }] : []),
    ...(opts.unclaimedHappyHour ? [{ id: DINNER_ROWS.happyHour, totalCents: discount, kind: 'discount' as const }] : []),
  ];
  const claims: SplitClaim[] = [
    { itemId: DINNER_ROWS.ana, userId: ANA, parts: 1 },
    { itemId: DINNER_ROWS.ben, userId: BEN, parts: 1 },
    { itemId: DINNER_ROWS.cy, userId: CY, parts: 1 },
    ...nachosClaimers.map((userId) => ({ itemId: DINNER_ROWS.nachos, userId, parts: 1 })),
  ];
  const totalCents = 6000 + discount + 533 + tip;
  return {
    id: DINNER_ID,
    payerId: ANA,
    totalCents,
    split: { totalCents, items, claims, participantIds: [...MEMBERS], extrasMode: 'proportional' },
  };
}

/** Brunch: even extras, payer Ben, all claimed; items 900/1100/700/1300, extras 1001; total 5001. */
export function brunchBill(): GroupBill {
  const items: SplitItem[] = [
    { id: BRUNCH_ROWS.ana, totalCents: 900 },
    { id: BRUNCH_ROWS.ben, totalCents: 1100 },
    { id: BRUNCH_ROWS.cy, totalCents: 700 },
    { id: BRUNCH_ROWS.dee, totalCents: 1300 },
  ];
  const claims: SplitClaim[] = [
    { itemId: BRUNCH_ROWS.ana, userId: ANA, parts: 1 },
    { itemId: BRUNCH_ROWS.ben, userId: BEN, parts: 1 },
    { itemId: BRUNCH_ROWS.cy, userId: CY, parts: 1 },
    { itemId: BRUNCH_ROWS.dee, userId: DEE, parts: 1 },
  ];
  return {
    id: BRUNCH_ID,
    payerId: BEN,
    totalCents: 5001,
    split: { totalCents: 5001, items, claims, participantIds: [...MEMBERS], extrasMode: 'equal' },
  };
}

/** Airbnb: Ana paid 24000, Equally among the four (C-G4 A4: 6000 each). */
export const AIRBNB: GroupExpense = {
  id: AIRBNB_ID,
  payerId: ANA,
  amountCents: 24000,
  shares: MEMBERS.map((userId) => ({ userId, cents: 6000 })),
};

/** Rental car: Dee paid 30000, Exact amounts (C-G5 X1). */
export const RENTAL_CAR: GroupExpense = {
  id: RENTAL_CAR_ID,
  payerId: DEE,
  amountCents: 30000,
  shares: [
    { userId: ANA, cents: 8572 },
    { userId: BEN, cents: 8571 },
    { userId: CY, cents: 8571 },
    { userId: DEE, cents: 4286 },
  ],
};

export type ExpectedColumns = { paid: number; share: number; sent: number; received: number; net: number };

export type WorkedCase = {
  name: string;
  input: GroupBalanceInput;
  /** Per member; undefined for W6, which the spec defines only by its properties. */
  expected?: Readonly<Record<string, ExpectedColumns>>;
  /** Shown suggestions in C-G3 order; undefined for W6. */
  shown?: readonly Transfer[];
};

function input(bills: GroupBill[], payments: GroupPayment[] = []): GroupBalanceInput {
  return { members: [...MEMBERS], bills, expenses: [AIRBNB, RENTAL_CAR], payments };
}

const cols = (paid: number, share: number, sent: number, received: number, net: number): ExpectedColumns => ({
  paid,
  share,
  sent,
  received,
  net,
});

export const W1: WorkedCase = {
  name: 'W1 all four count',
  input: input([dinnerBill(), brunchBill()]),
  expected: {
    [ANA]: cols(31733, 18731, 0, 0, 13002),
    [BEN]: cols(5001, 18670, 0, 0, -13669),
    [CY]: cols(0, 17497, 0, 0, -17497),
    [DEE]: cols(30000, 11836, 0, 0, 18164),
  },
  shown: [
    { from: CY, to: DEE, cents: 17497 },
    { from: BEN, to: ANA, cents: 13002 },
    { from: BEN, to: DEE, cents: 667 },
  ],
};

export const W2: WorkedCase = {
  name: "W2 Dinner's nachos unclaimed",
  input: input([dinnerBill({ nachosClaimers: [] }), brunchBill()]),
  expected: {
    [ANA]: cols(24000, 15723, 0, 0, 8277),
    [BEN]: cols(5001, 15921, 0, 0, -10920),
    [CY]: cols(0, 15521, 0, 0, -15521),
    [DEE]: cols(30000, 11836, 0, 0, 18164),
  },
  shown: [
    { from: CY, to: DEE, cents: 15521 },
    { from: BEN, to: ANA, cents: 8277 },
    { from: BEN, to: DEE, cents: 2643 },
  ],
};

export const W3: WorkedCase = {
  name: 'W3 W1, then Cy records 10000 to Dee',
  input: input([dinnerBill(), brunchBill()], [{ from: CY, to: DEE, cents: 10000 }]),
  expected: {
    [ANA]: cols(31733, 18731, 0, 0, 13002),
    [BEN]: cols(5001, 18670, 0, 0, -13669),
    [CY]: cols(0, 17497, 10000, 0, -7497),
    [DEE]: cols(30000, 11836, 0, 10000, 8164),
  },
  shown: [
    { from: BEN, to: ANA, cents: 13002 },
    { from: CY, to: DEE, cents: 7497 },
    { from: BEN, to: DEE, cents: 667 },
  ],
};

export const W4: WorkedCase = {
  name: "W4 W1 paid off, then Dinner's tip 1200 → 1500",
  input: input(
    [dinnerBill({ tipCents: 1500 }), brunchBill()],
    [
      { from: CY, to: DEE, cents: 17497 },
      { from: BEN, to: ANA, cents: 13002 },
      { from: BEN, to: DEE, cents: 667 },
    ],
  ),
  expected: {
    [ANA]: cols(32033, 18848, 0, 13002, 183),
    [BEN]: cols(5001, 18777, 13669, 0, -107),
    [CY]: cols(0, 17573, 17497, 0, -76),
    [DEE]: cols(30000, 11836, 0, 18164, 0),
  },
  shown: [
    { from: BEN, to: ANA, cents: 107 },
    { from: CY, to: ANA, cents: 76 },
  ],
};

export const W5: WorkedCase = {
  name: 'W5 Brunch moved in with Cy\'s "I paid" 950 to Ben',
  input: input([dinnerBill(), brunchBill()], [{ from: CY, to: BEN, cents: 950 }]),
  expected: {
    [ANA]: cols(31733, 18731, 0, 0, 13002),
    [BEN]: cols(5001, 18670, 0, 950, -14619),
    [CY]: cols(0, 17497, 950, 0, -16547),
    [DEE]: cols(30000, 11836, 0, 0, 18164),
  },
  shown: [
    { from: CY, to: DEE, cents: 16547 },
    { from: BEN, to: ANA, cents: 13002 },
    { from: BEN, to: DEE, cents: 1617 },
  ],
};

/** W6: W1, then Ben assigns the nachos to Ana alone (an assignment is a claim change). */
export const W6: WorkedCase = {
  name: 'W6 W1, nachos assigned to Ana alone',
  input: input([dinnerBill({ nachosClaimers: [ANA] }), brunchBill()]),
};

/**
 * W7 (Amendment A1, S1c): W1 with all three suggestions recorded, then Cy unclaims the nachos, so
 * Dinner stops counting and the balances swing.
 */
export const W7: WorkedCase = {
  name: 'W7 W1 paid off, then Cy unclaims the nachos',
  input: input(
    [dinnerBill({ nachosClaimers: [] }), brunchBill()],
    [
      { from: CY, to: DEE, cents: 17497 },
      { from: BEN, to: ANA, cents: 13002 },
      { from: BEN, to: DEE, cents: 667 },
    ],
  ),
  expected: {
    [ANA]: cols(24000, 15723, 0, 13002, -4725),
    [BEN]: cols(5001, 15921, 13669, 0, 2749),
    [CY]: cols(0, 15521, 17497, 0, 1976),
    [DEE]: cols(30000, 11836, 0, 18164, 0),
  },
  shown: [
    { from: ANA, to: BEN, cents: 2749 },
    { from: ANA, to: CY, cents: 1976 },
  ],
};

export const WORKED_CASES: readonly WorkedCase[] = [W1, W2, W3, W4, W5, W6, W7];

// Seeded integer-only PRNG (mulberry32, same as lib/split.test.ts), so failures are reproducible.
export function seededRng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n; // integer in [0, n)
  };
}

export function shuffled<T>(xs: readonly T[], r: (n: number) => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r(i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** A random lowercase v4-shaped uuid from the seeded PRNG. */
export function randomUuid(r: (n: number) => number): string {
  const hex = (len: number) => Array.from({ length: len }, () => r(16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
}
