// Delete group (docs/specs/2026-11-28-delete-group.md): the contract W bills (W1–W7 plus A2.10's
// even-split cases) and the contract S nets (S1–S8), as lib inputs. One table for both modes, with
// the answers A2.10 recorded from groupBalances on 2026-11-28; pgTAP (delete_group.test.sql)
// asserts the same rows against private.group_bill_waiting. Keep the two in step.
//
// Every bill is between Ana (payer) and Ben, the only two members, so a snapshot built from them
// passes the parser's "participants are the members" rule.

import type { GroupBalanceInput, GroupBill, GroupExpense } from '@/lib/groupBalance';
import type { ExtrasMode, SplitClaim, SplitItem } from '@/lib/split';

import { ANA, BEN, CY } from './groupFixtures';

export const WAIT_BILL_ID = 'b9000000-0000-4000-8000-000000000001';
const row = (n: number) => `19000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const WAIT_ROWS = { a: row(1), b: row(2), c: row(3) } as const;

type RowSpec = { id: string; cents: number; kind?: 'item' | 'discount'; claims: Readonly<Record<string, number>> };

function bill(totalCents: number, rows: readonly RowSpec[], extrasMode: ExtrasMode): GroupBill {
  const items: SplitItem[] = rows.map((r) => ({ id: r.id, totalCents: r.cents, kind: r.kind ?? 'item' }));
  const claims: SplitClaim[] = rows.flatMap((r) => Object.entries(r.claims).map(([userId, parts]) => ({ itemId: r.id, userId, parts })));
  return {
    id: WAIT_BILL_ID,
    payerId: ANA,
    totalCents,
    split: { totalCents, items, claims, participantIds: [ANA, BEN], extrasMode },
  };
}

export type WaitCase = {
  id: string;
  label: string;
  make: (mode: ExtrasMode) => GroupBill;
  /** A2.10: whether the bill waits, per extras mode. */
  waiting: Readonly<Record<ExtrasMode, boolean>>;
};

const both = (w: boolean) => ({ proportional: w, equal: w });

// The same bills as delete_group.test.sql's `pg_temp.wcase` rows (amounts, rows, claims), user 01 =
// Ana and 02 = Ben, so both sides run exactly the same boundary cases (CLAUDE.md money rules).
export const WAIT_CASES: readonly WaitCase[] = [
  {
    id: 'W1',
    label: 'every priced row claimed',
    make: (m) =>
      bill(1100, [
        { id: WAIT_ROWS.a, cents: 400, claims: { [ANA]: 1 } },
        { id: WAIT_ROWS.b, cents: 600, claims: { [BEN]: 1 } },
      ], m),
    waiting: both(false),
  },
  {
    id: 'W2',
    label: 'one item row unclaimed',
    make: (m) =>
      bill(1100, [
        { id: WAIT_ROWS.a, cents: 400, claims: { [ANA]: 1 } },
        { id: WAIT_ROWS.b, cents: 600, claims: {} },
      ], m),
    waiting: both(true),
  },
  {
    id: 'W3',
    label: 'one discount row unclaimed, items claimed',
    make: (m) =>
      bill(900, [
        { id: WAIT_ROWS.a, cents: 400, claims: { [ANA]: 1 } },
        { id: WAIT_ROWS.b, cents: 600, claims: { [BEN]: 1 } },
        { id: WAIT_ROWS.c, cents: -200, kind: 'discount', claims: {} },
      ], m),
    waiting: both(true),
  },
  {
    id: 'W4',
    label: 'every row $0 and claimed, total > $0',
    make: (m) =>
      bill(500, [
        { id: WAIT_ROWS.a, cents: 0, claims: { [ANA]: 1 } },
        { id: WAIT_ROWS.b, cents: 0, claims: { [BEN]: 1 } },
      ], m),
    // A2.10: the claimers carry the extras in even mode; proportional has no weights.
    waiting: { proportional: true, equal: false },
  },
  {
    id: 'W4-zero',
    label: 'every row $0 and claimed, total $0',
    make: (m) => bill(0, [{ id: WAIT_ROWS.a, cents: 0, claims: { [ANA]: 1 } }], m),
    waiting: both(false),
  },
  {
    id: 'W5',
    label: 'priced rows claimed, one $0 row unclaimed (S9)',
    make: (m) =>
      bill(1100, [
        { id: WAIT_ROWS.a, cents: 1000, claims: { [ANA]: 1 } },
        { id: WAIT_ROWS.c, cents: 0, claims: {} },
      ], m),
    waiting: both(true),
  },
  {
    id: 'W6',
    label: 'one split row with two claimers (parts 1 + 2)',
    make: (m) => bill(1100, [{ id: WAIT_ROWS.a, cents: 1000, claims: { [ANA]: 1, [BEN]: 2 } }], m),
    waiting: both(false),
  },
  { id: 'W7', label: 'no rows, total > $0', make: (m) => bill(500, [], m), waiting: both(true) },
  { id: 'W7-zero', label: 'no rows, total $0', make: (m) => bill(0, [], m), waiting: both(false) },
  {
    id: 'discount-only',
    label: 'discount rows only, claimed, total − rows ≠ 0',
    make: (m) => bill(300, [{ id: WAIT_ROWS.a, cents: -200, kind: 'discount', claims: { [ANA]: 1 } }], m),
    waiting: both(true),
  },
  {
    id: 'discount-only-zero',
    label: 'discount rows only, claimed, $0 total',
    make: (m) => bill(0, [{ id: WAIT_ROWS.a, cents: -200, kind: 'discount', claims: { [ANA]: 1 } }], m),
    waiting: both(true),
  },
];

/** One case's bill, by id. Throws on an unknown id (a fixture typo). */
export function waitBill(id: string, mode: ExtrasMode): GroupBill {
  const c = WAIT_CASES.find((w) => w.id === id);
  if (!c) throw new Error(`no wait case ${id}`);
  return c.make(mode);
}

export const S_EXPENSE_ID = (n: number) => `e9000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const expense = (n: number, payerId: string, shares: Readonly<Record<string, number>>): GroupExpense => {
  const list = Object.entries(shares).map(([userId, cents]) => ({ userId, cents }));
  return { id: S_EXPENSE_ID(n), payerId, amountCents: list.reduce((s, x) => s + x.cents, 0), shares: list };
};

export type SettleCase = {
  id: string;
  label: string;
  input: GroupBalanceInput;
  /** S8: the viewer has hidden the group. */
  hidden?: boolean;
  expected: { ok: true } | { ok: false; reason: 'receipts_waiting' | 'not_settled' };
  /** The nets the spec's table gives, checked so the fixture can't drift from it. */
  nets: Readonly<Record<string, number>>;
};

const OK = { ok: true } as const;

export const SETTLE_CASES: readonly SettleCase[] = [
  { id: 'S1', label: 'no costs at all, 1 member', input: { members: [ANA], bills: [], expenses: [], payments: [] }, expected: OK, nets: { [ANA]: 0 } },
  {
    id: 'S2',
    label: 'all 0 (an expense paid back)',
    input: { members: [ANA, BEN], bills: [], expenses: [expense(1, ANA, { [ANA]: 500, [BEN]: 500 })], payments: [{ from: BEN, to: ANA, cents: 500 }] },
    expected: OK,
    nets: { [ANA]: 0, [BEN]: 0 },
  },
  {
    id: 'S3',
    label: '+1, −1 (exactly at tolerance)',
    input: { members: [ANA, BEN], bills: [], expenses: [expense(1, ANA, { [ANA]: 1, [BEN]: 1 })], payments: [] },
    expected: OK,
    nets: { [ANA]: 1, [BEN]: -1 },
  },
  {
    id: 'S4',
    label: '+2, −2 (1¢ over)',
    input: { members: [ANA, BEN], bills: [], expenses: [expense(1, ANA, { [ANA]: 2, [BEN]: 2 })], payments: [] },
    expected: { ok: false, reason: 'not_settled' },
    nets: { [ANA]: 2, [BEN]: -2 },
  },
  {
    id: 'S5',
    label: '+1, +1, −2 (two at tolerance, one 1¢ over)',
    input: {
      members: [ANA, BEN, CY],
      bills: [],
      expenses: [expense(1, ANA, { [CY]: 1 }), expense(2, BEN, { [CY]: 1 })],
      payments: [],
    },
    expected: { ok: false, reason: 'not_settled' },
    nets: { [ANA]: 1, [BEN]: 1, [CY]: -2 },
  },
  {
    id: 'S6',
    label: 'all 0, one W2 bill',
    input: { members: [ANA, BEN], bills: [waitBill('W2', 'proportional')], expenses: [], payments: [] },
    expected: { ok: false, reason: 'receipts_waiting' },
    nets: { [ANA]: 0, [BEN]: 0 },
  },
  {
    id: 'S7',
    label: '+500, −500, one W4 bill (waiting wins)',
    input: {
      members: [ANA, BEN],
      bills: [waitBill('W4', 'proportional')],
      expenses: [expense(1, ANA, { [ANA]: 500, [BEN]: 500 })],
      payments: [],
    },
    expected: { ok: false, reason: 'receipts_waiting' },
    nets: { [ANA]: 500, [BEN]: -500 },
  },
  {
    id: 'S8',
    label: 'all 0, a hidden group',
    input: { members: [ANA, BEN], bills: [], expenses: [expense(1, ANA, { [ANA]: 500, [BEN]: 500 })], payments: [{ from: BEN, to: ANA, cents: 500 }] },
    hidden: true,
    expected: OK,
    nets: { [ANA]: 0, [BEN]: 0 },
  },
];
