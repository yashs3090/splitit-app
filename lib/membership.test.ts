// Rule L3 (who can be removed, who can leave): docs/specs/2026-11-24-people-and-invites.md § D2.
// The same M1–M8 cases are tested in supabase/tests/database/membership.test.sql.
import type { BillClaim, BillData, BillMember, BillRow } from './bills';
import { canLeave, canRemove } from './membership';

const BILL = '11111111-2222-4333-8444-555555555555';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const PAYER = 'bbbbbbbb-0000-4000-8000-00000000000b'; // not the host, 0 claims
const ADDED = 'bbbbbbbb-0000-4000-8000-00000000000c'; // added, 0 claims, no mark
const JOINED = 'bbbbbbbb-0000-4000-8000-00000000000d'; // joined by link, 0 claims, no mark
const CLAIMER = 'bbbbbbbb-0000-4000-8000-00000000000e'; // 1 claim on a one-unit item
const BEER_CLAIMER = 'bbbbbbbb-0000-4000-8000-00000000000f'; // 1 claim on unit 2 of "Beer ×2"
const MARKED = 'bbbbbbbb-0000-4000-8000-000000000010'; // 0 claims but an "I paid" mark
const STRANGER = 'bbbbbbbb-0000-4000-8000-000000000011'; // not a participant

const ROW_BURGER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROW_BEER0 = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROW_BEER1 = 'aaaaaaaa-0000-4000-8000-000000000003';

function member(userId: string, mark: BillMember['mark'] = null): BillMember {
  return { userId, displayName: null, venmoUsername: null, mark };
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

/** One bill holding every M case at once, so each case is checked with the others present. */
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
  participants: [
    member(HOST),
    member(PAYER),
    member(ADDED),
    member(JOINED),
    member(CLAIMER),
    member(BEER_CLAIMER),
    member(MARKED, { cents: 1000, at: '2026-11-24T11:00:00Z' }),
  ],
  claims: [claim(ROW_BURGER, CLAIMER), claim(ROW_BEER1, BEER_CLAIMER), claim(ROW_BEER0, HOST)],
};

// [case, target, removable] per the L3 table. The lib answers `false` for every refused case.
const M_CASES: [string, string, boolean][] = [
  ['M1 the host', HOST, false],
  ['M2 the payer (not the host), 0 claims', PAYER, false],
  ['M3 added, 0 claims, no mark, not payer', ADDED, true],
  ['M4 joined by link, 0 claims, no mark, not payer', JOINED, true],
  ['M5 1 claim (a one-unit item)', CLAIMER, false],
  ['M6 1 claim on unit 2 of "Beer ×2"', BEER_CLAIMER, false],
  ['M7 0 claims but a mark', MARKED, false],
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
    const hostPays: BillData = { ...DATA, bill: { ...DATA.bill, payer_id: HOST } };
    expect(canRemove(hostPays, HOST, HOST)).toBe(false);
    // The old payer is now an ordinary participant with no claims.
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

  it('an undone mark makes M7 able to leave', () => {
    const unmarked: BillData = {
      ...DATA,
      participants: DATA.participants.map((p) => (p.userId === MARKED ? { ...p, mark: null } : p)),
    };
    expect(canLeave(unmarked, MARKED)).toBe(true);
  });
});
