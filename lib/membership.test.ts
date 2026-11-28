// Rule L3 (who can be removed, who can leave): docs/specs/2026-11-24-people-and-invites.md § D2,
// as extended for several payers and the payments ledger by docs/specs/2026-11-26-who-paid.md
// (A1.3 `private.is_removable`, A1.4 table L; eng review B7).
// The same M1–M8 cases are tested in supabase/tests/database/membership.test.sql, and table L
// (L1–L7) in Task 4b's who_paid.test.sql (criterion A-17).
import { fakePayment, fakePaymentFlag } from '@/test-utils/fakes';

import type { BillClaim, BillData, BillMember, BillRow } from './bills';
import { canLeave, canRemove, isRemovable, type RemovableFacts } from './membership';

const BILL = '11111111-2222-4333-8444-555555555555';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const PAYER = 'bbbbbbbb-0000-4000-8000-00000000000b'; // not the host, 0 claims
const ADDED = 'bbbbbbbb-0000-4000-8000-00000000000c'; // added, 0 claims, no payments
const JOINED = 'bbbbbbbb-0000-4000-8000-00000000000d'; // joined by link, 0 claims, no payments
const CLAIMER = 'bbbbbbbb-0000-4000-8000-00000000000e'; // 1 claim on a one-unit item
const BEER_CLAIMER = 'bbbbbbbb-0000-4000-8000-00000000000f'; // 1 claim on unit 2 of "Beer ×2"
const MARKED = 'bbbbbbbb-0000-4000-8000-000000000010'; // 0 claims but paid the payer
const STRANGER = 'bbbbbbbb-0000-4000-8000-000000000011'; // not a participant

const ROW_BURGER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROW_BEER0 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROW_BEER1 = 'aaaaaaaa-0000-4000-8000-000000000003';

const T1 = '2026-11-27T10:00:00.000001+00:00';
const T2 = '2026-11-27T10:05:00.000002+00:00';

function member(userId: string): BillMember {
  return { userId, displayName: null, venmoUsername: null, mark: null, notReceived: null };
}

function row(id: string, name: string, unitIndex: number, groupSize: number, cents: number): BillRow {
  return {
    id,
    name,
    note: null,
    group_position: name === 'Burger' ? 0 : 1,
    unit_index: unitIndex,
    group_size: groupSize,
    total_cents: cents,
    split_set_by: null,
    split_set_at: null,
  };
}

const claim = (rowId: string, userId: string): BillClaim => ({ line_item_id: rowId, user_id: userId, parts: 1 });

/** One one-person bill holding every M case at once, so each case is checked with the others present. */
const DATA: BillData = {
  bill: {
    id: BILL,
    host_id: HOST,
    subtotal_cents: null,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 2900,
    join_code: '0123456789abcdef0123',
    created_at: '2026-11-24T10:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
    payer_id: PAYER,
  },
  rows: [row(ROW_BURGER, 'Burger', 0, 1, 1500), row(ROW_BEER0, 'Beer', 0, 2, 700), row(ROW_BEER1, 'Beer', 1, 2, 700)],
  participants: [member(HOST), member(PAYER), member(ADDED), member(JOINED), member(CLAIMER), member(BEER_CLAIMER), member(MARKED)],
  claims: [claim(ROW_BURGER, CLAIMER), claim(ROW_BEER1, BEER_CLAIMER), claim(ROW_BEER0, HOST)],
  payers: [],
  payments: [fakePayment('p1', MARKED, PAYER, 1000, T1)],
  flags: [],
};

// [case, target, removable] per the L3 table. The lib answers `false` for every refused case.
const M_CASES: [string, string, boolean][] = [
  ['M1 the host', HOST, false],
  ['M2 the payer (not the host), 0 claims', PAYER, false],
  ['M3 added, 0 claims, no payments, not payer', ADDED, true],
  ['M4 joined by link, 0 claims, no payments, not payer', JOINED, true],
  ['M5 1 claim (a one-unit item)', CLAIMER, false],
  ['M6 1 claim on unit 2 of "Beer ×2"', BEER_CLAIMER, false],
  ['M7 0 claims but a payment to the payer (pair net > 0)', MARKED, false],
  ['M8 not a participant', STRANGER, false],
];

describe('canRemove: the host removing someone (criterion 26, L3)', () => {
  it.each(M_CASES)('%s', (_label, target, expected) => {
    expect(canRemove(DATA, HOST, target)).toBe(expected);
  });

  it('is false for every target when the viewer is not the host', () => {
    const viewers = [PAYER, ADDED, JOINED, CLAIMER, BEER_CLAIMER, MARKED, STRANGER];
    for (const viewer of viewers) {
      for (const [, target] of M_CASES) expect(canRemove(DATA, viewer, target)).toBe(false);
    }
  });

  it('a payer who is also the host is refused as both (M1 and M2 together)', () => {
    // The old payer received MARKED's payment, so drop it to isolate "no longer the payer".
    const hostPays: BillData = { ...DATA, bill: { ...DATA.bill, payer_id: HOST }, payments: [] };
    expect(canRemove(hostPays, HOST, HOST)).toBe(false);
    // The old payer is now an ordinary participant with no claims and no payments.
    expect(canRemove(hostPays, HOST, PAYER)).toBe(true);
  });

  it('follows the current data: unclaiming everything makes M5 removable', () => {
    const unclaimed: BillData = { ...DATA, claims: DATA.claims.filter((x) => x.user_id !== CLAIMER) };
    expect(canRemove(unclaimed, HOST, CLAIMER)).toBe(true);
  });
});

describe('canLeave: the target leaving themself (criterion 26, L3)', () => {
  it.each(M_CASES)('%s', (_label, viewer, expected) => {
    expect(canLeave(DATA, viewer)).toBe(expected);
  });

  it('an undone payment (the entries deleted) makes M7 able to leave', () => {
    expect(canLeave({ ...DATA, payments: [] }, MARKED)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Table L (who-paid A1.4): several payers and the ledger. Shared with pgTAP (criterion A-17).
// ---------------------------------------------------------------------------------------------------

describe('table L: several payers and the payments ledger (A1.4, B7)', () => {
  const A = HOST; // the host
  const B = PAYER;
  const C = ADDED;
  const D = JOINED;
  const E = MARKED;

  /** A split bill: A (host) 1700 and B 1200 paid; nobody has claims except as listed. */
  const SPLIT: BillData = {
    ...DATA,
    bill: { ...DATA.bill, payer_id: A },
    participants: [member(A), member(B), member(C), member(D), member(E)],
    claims: [],
    payers: [
      { userId: A, paidCents: 1700 },
      { userId: B, paidCents: 1200 },
    ],
    payments: [],
    flags: [],
  };

  it('L1 a co-payer (not the lead, no claims, no payments) can neither leave nor be removed', () => {
    expect(SPLIT.bill.payer_id).not.toBe(B);
    expect(canLeave(SPLIT, B)).toBe(false);
    expect(canRemove(SPLIT, A, B)).toBe(false);
  });

  it('L1 positive control: the same person on a one-person bill (not the payer) is removable', () => {
    const onePerson: BillData = { ...SPLIT, payers: [] };
    expect(canLeave(onePerson, B)).toBe(true);
    expect(canRemove(onePerson, A, B)).toBe(true);
  });

  it('L2 a non-payer with an outgoing pair net > 0 (to a co-payer) is refused', () => {
    const data: BillData = { ...SPLIT, payments: [fakePayment('p1', C, B, 681, T1)] };
    expect(canLeave(data, C)).toBe(false);
    expect(canRemove(data, A, C)).toBe(false);
  });

  it('L3 a non-payer with only a not-received flag may leave (flags never block)', () => {
    const data: BillData = { ...SPLIT, flags: [fakePaymentFlag(C, B, 681)] };
    expect(canLeave(data, C)).toBe(true);
    expect(canRemove(data, A, C)).toBe(true);
  });

  it('L4 the old lead, after set_payer to someone else, with no claims and every pair net 0, may leave', () => {
    // One person now: D pays. B was the lead of a split before; nothing is left on B's pairs.
    const data: BillData = {
      ...SPLIT,
      bill: { ...SPLIT.bill, payer_id: D },
      payers: [],
      payments: [fakePayment('p1', C, B, 500, T1), fakePayment('p2', B, C, 500, T2)],
    };
    expect(canLeave(data, B)).toBe(true);
    expect(canRemove(data, A, B)).toBe(true);
  });

  it('L5 the host is refused, also when not a payer', () => {
    const data: BillData = { ...SPLIT, bill: { ...SPLIT.bill, payer_id: B }, payers: [] };
    expect(canLeave(data, A)).toBe(false);
    expect(canRemove(data, A, A)).toBe(false);
  });

  it('L6 a non-payer fully paid back (pair net 0) may leave', () => {
    const data: BillData = { ...SPLIT, payments: [fakePayment('p1', C, A, 1510, T1), fakePayment('p2', A, C, 1510, T2)] };
    expect(canLeave(data, C)).toBe(true);
  });

  it('L6 contrast: paid back only in part (pair net 10) is refused', () => {
    const data: BillData = { ...SPLIT, payments: [fakePayment('p1', C, A, 1510, T1), fakePayment('p2', A, C, 1500, T2)] };
    expect(canLeave(data, C)).toBe(false);
  });

  it('L7 an ex-payer holding someone else’s payment (incoming net > 0) is refused', () => {
    // T0's shape: D was the payer, E paid D, then the host made A the one payer.
    const data: BillData = {
      ...SPLIT,
      payers: [],
      payments: [fakePayment('p1', E, D, 1200, T1)],
    };
    expect(canLeave(data, D)).toBe(false);
    expect(canRemove(data, A, D)).toBe(false);
    // …and the sender, E, is refused too (their outgoing pair is net > 0).
    expect(canLeave(data, E)).toBe(false);
  });

  it('a pair with the other side owing (net < 0 from the target’s side) also blocks', () => {
    // C received more from B than C sent: C holds B's money.
    const data: BillData = { ...SPLIT, payments: [fakePayment('p1', C, B, 100, T1), fakePayment('p2', B, C, 300, T2)] };
    expect(canLeave(data, C)).toBe(false);
  });

  it('payments between two other people never block the target', () => {
    const data: BillData = { ...SPLIT, payments: [fakePayment('p1', E, B, 900, T1)] };
    expect(canLeave(data, C)).toBe(true);
  });
});

describe('isRemovable: the pure rule (the facts canLeave and canRemove read)', () => {
  const base: RemovableFacts = {
    hostId: HOST,
    payerId: PAYER,
    payerIds: [],
    participantIds: [HOST, PAYER, ADDED],
    claimUserIds: [],
    payments: [],
  };

  it('true only when every condition holds', () => {
    expect(isRemovable(base, ADDED)).toBe(true);
  });

  it.each<[string, Partial<RemovableFacts>]>([
    ['not a participant', { participantIds: [HOST, PAYER] }],
    ['the host', { hostId: ADDED }],
    ['payer_id', { payerId: ADDED }],
    ['in bill_payers', { payerIds: [PAYER, ADDED] }],
    ['a claim', { claimUserIds: [ADDED] }],
    ['an outgoing net > 0', { payments: [{ fromId: ADDED, toId: PAYER, cents: 1 }] }],
    ['an incoming net > 0', { payments: [{ fromId: HOST, toId: ADDED, cents: 1 }] }],
  ])('false for %s', (_label, over) => {
    expect(isRemovable({ ...base, ...over }, ADDED)).toBe(false);
  });

  it('sums every entry per pair: 3 entries netting 0 do not block', () => {
    const payments = [
      { fromId: ADDED, toId: PAYER, cents: 700 },
      { fromId: ADDED, toId: PAYER, cents: 300 },
      { fromId: PAYER, toId: ADDED, cents: 1000 },
    ];
    expect(isRemovable({ ...base, payments }, ADDED)).toBe(true);
    expect(isRemovable({ ...base, payments: payments.slice(1) }, ADDED)).toBe(false);
  });
});
