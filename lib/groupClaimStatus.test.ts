// C1 ("a group bill needs viewer V") and the C6 copy: docs/specs/2026-11-27-group-claim-status.md (T2).
// Criterion 13: every B1–B8 case of the C1 table goes through BOTH adapters, built from the same rows:
// a SnapshotBill (Home, group screen) and a BillData (bill screen). The expected answers are the
// table's, worked out by hand; nothing here is computed from the function under test.
import type { BillClaim, BillData, BillRow } from './bills';
import {
  billNeedsViewer,
  GROUP_CLAIM_COPY,
  rowsOfBillData,
  rowsOfSnapshotBill,
  snapshotBillNeedsViewer,
  type ClaimRowLike,
} from './groupClaimStatus';
import { GROUP_ERROR_COPY } from './groups';
import type { GroupSnapshot, SnapshotBill, SnapshotRow } from './groups';

// lib/groups.ts (for GROUP_ERROR_COPY) imports the Supabase client; the copy test needs no network.
jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const V = 'aaaaaaaa-0000-4000-8000-000000000001';
const ANA = 'aaaaaaaa-0000-4000-8000-000000000002';
const BEN = 'aaaaaaaa-0000-4000-8000-000000000003';
const BILL = 'b0000000-0000-4000-8000-000000000001';
const rowId = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One row of a case: its claimers, and whether it's a discount row (B6). */
type CaseRow = { claimers: readonly string[]; discount?: boolean };
type Case = { id: string; rows: readonly CaseRow[]; notPart: boolean; needs: boolean };

// The C1 table, verbatim.
const CASES: readonly Case[] = [
  { id: 'B1', rows: [{ claimers: [ANA] }, { claimers: [] }], notPart: false, needs: true },
  { id: 'B2', rows: [{ claimers: [ANA] }, { claimers: [] }], notPart: true, needs: false },
  { id: 'B3', rows: [{ claimers: [V] }, { claimers: [] }], notPart: false, needs: false },
  { id: 'B4', rows: [{ claimers: [V] }, { claimers: [] }], notPart: true, needs: false },
  { id: 'B5', rows: [{ claimers: [ANA] }, { claimers: [BEN] }], notPart: false, needs: false },
  { id: 'B6', rows: [{ claimers: [ANA] }, { claimers: [], discount: true }], notPart: false, needs: true },
  { id: 'B7', rows: [], notPart: false, needs: false },
  { id: 'B8', rows: [{ claimers: [ANA, V] }, { claimers: [] }], notPart: false, needs: false },
];

function snapshotBillOf(rows: readonly CaseRow[]): SnapshotBill {
  const snapshotRows: SnapshotRow[] = rows.map((r, i) => {
    const claims: Record<string, number> = {};
    for (const u of r.claimers) claims[u] = 1;
    return {
      id: rowId(i + 1),
      totalCents: r.discount ? -500 : 1000,
      kind: r.discount ? 'discount' : 'item',
      name: r.claimers.length === 0 ? 'Nachos' : null,
      claims,
    };
  });
  return {
    id: BILL,
    hostId: ANA,
    payerId: ANA,
    totalCents: 1500,
    extrasSplit: 'proportional',
    createdAt: '2026-11-27T10:00:00.000Z',
    rows: snapshotRows,
    participantIds: [V, ANA, BEN],
  };
}

function billDataOf(rows: readonly CaseRow[]): BillData {
  const billRows: BillRow[] = rows.map((r, i) => ({
    id: rowId(i + 1),
    name: 'Nachos',
    note: null,
    group_position: i,
    unit_index: 0,
    group_size: 1,
    total_cents: r.discount ? -500 : 1000,
    kind: r.discount ? 'discount' : 'item',
    applies_to: r.discount ? 'subtotal' : null,
    split_set_by: null,
    split_set_at: null,
  }));
  const claims: BillClaim[] = rows.flatMap((r, i) => r.claimers.map((u) => ({ line_item_id: rowId(i + 1), user_id: u, parts: 1 })));
  return {
    bill: {
      id: BILL,
      host_id: ANA,
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 1500,
      join_code: '0123456789abcdef0123',
      created_at: '2026-11-27T10:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
      payer_id: ANA,
    },
    rows: billRows,
    participants: [V, ANA, BEN].map((userId) => ({ userId, displayName: null, venmoUsername: null, mark: null, notReceived: null })),
    claims,
    payers: [],
    payments: [],
    flags: [],
  };
}

describe('billNeedsViewer (C1), criterion 13', () => {
  describe.each(CASES)('$id', ({ rows, notPart, needs }) => {
    it(`through the snapshot adapter → ${needs}`, () => {
      expect(billNeedsViewer(rowsOfSnapshotBill(snapshotBillOf(rows)), V, notPart)).toBe(needs);
    });

    it(`through the BillData adapter → ${needs}`, () => {
      expect(billNeedsViewer(rowsOfBillData(billDataOf(rows)), V, notPart)).toBe(needs);
    });
  });

  it('both adapters give the same claimer sets, in row order', () => {
    const rows = CASES[7]?.rows ?? [];
    const expected: ClaimRowLike[] = [{ claimerIds: [ANA, V] }, { claimerIds: [] }];
    expect(rowsOfSnapshotBill(snapshotBillOf(rows))).toEqual(expected);
    expect(rowsOfBillData(billDataOf(rows))).toEqual(expected);
  });

  it('the BillData adapter ignores a claim on a row that is not on the bill', () => {
    const data = billDataOf([{ claimers: [ANA] }, { claimers: [] }]);
    data.claims.push({ line_item_id: rowId(99), user_id: V, parts: 1 });
    expect(rowsOfBillData(data)).toEqual([{ claimerIds: [ANA] }, { claimerIds: [] }]);
    expect(billNeedsViewer(rowsOfBillData(data), V, false)).toBe(true);
  });

  it('the BillData adapter takes displayed claims (T6: a tap on Claim clears the reminder before the save lands)', () => {
    const data = billDataOf([{ claimers: [ANA] }, { claimers: [] }]);
    expect(billNeedsViewer(rowsOfBillData(data), V, false)).toBe(true);
    const displayed = { rows: data.rows, claims: [...data.claims, { line_item_id: rowId(2), user_id: V, parts: 1 }] };
    expect(billNeedsViewer(rowsOfBillData(displayed), V, false)).toBe(false);
  });

  it("someone else's claim never counts as mine", () => {
    expect(billNeedsViewer([{ claimerIds: [ANA, BEN] }, { claimerIds: [] }], V, false)).toBe(true);
  });
});

describe('snapshotBillNeedsViewer: C1 with the opt-out read from me.notPartBillIds', () => {
  const OTHER_BILL = 'b0000000-0000-4000-8000-000000000002';
  const snapshotWith = (notPartBillIds: string[]): Pick<GroupSnapshot, 'me'> => ({
    me: { hidden: false, notPartBillIds },
  });

  it('B1 and B2 by whether the bill id is in notPartBillIds', () => {
    const bill = snapshotBillOf(CASES[0]?.rows ?? []);
    expect(snapshotBillNeedsViewer(snapshotWith([]), bill, V)).toBe(true);
    expect(snapshotBillNeedsViewer(snapshotWith([BILL]), bill, V)).toBe(false);
    // Another bill's opt-out doesn't apply to this one.
    expect(snapshotBillNeedsViewer(snapshotWith([OTHER_BILL]), bill, V)).toBe(true);
  });

  it('B4: a claim wins over a stale opt-out', () => {
    const bill = snapshotBillOf(CASES[3]?.rows ?? []);
    expect(snapshotBillNeedsViewer(snapshotWith([BILL]), bill, V)).toBe(false);
  });
});

describe('GROUP_CLAIM_COPY (C6)', () => {
  it('has the exact strings', () => {
    expect(GROUP_CLAIM_COPY.homeClaim(1)).toBe('Claim your items on 1 bill');
    expect(GROUP_CLAIM_COPY.homeClaim(2)).toBe('Claim your items on 2 bills');
    expect(GROUP_CLAIM_COPY.homeClaim(12)).toBe('Claim your items on 12 bills');
    expect(GROUP_CLAIM_COPY).toMatchObject({
      homeSettled: 'Settled up',
      needsYou: "You haven't claimed anything here yet",
      costNeedsYou: 'Claim your items',
      notPart: "I wasn't part of this",
      notPartHint: "Stops reminding you about this receipt. It doesn't change anyone's share.",
      notPartDone: "You weren't part of this",
      notPartDoneBill: "You said you weren't part of this.",
      notPartPrompt: 'Nothing here was yours?',
      undo: 'Undo',
      undoA11y: 'Undo, I was part of this',
      undoHint: 'Reminds you to claim your items on this receipt again',
      hasClaims: "You've claimed something on this receipt, so you're part of it.",
      notInGroup: "This receipt isn't in a group anymore.",
    });
  });

  it('the error copy is defined once: GROUP_ERROR_COPY points at these strings', () => {
    expect(GROUP_ERROR_COPY.has_claims).toBe(GROUP_CLAIM_COPY.hasClaims);
    expect(GROUP_ERROR_COPY.not_in_group).toBe(GROUP_CLAIM_COPY.notInGroup);
  });

  it('no "!" and no "failed" (lesson 2026-11-27)', () => {
    const strings = Object.values(GROUP_CLAIM_COPY).map((v) => (typeof v === 'function' ? v(3) : v));
    for (const s of strings) {
      expect(s).not.toContain('!');
      expect(s.toLowerCase()).not.toContain('failed');
    }
  });
});
