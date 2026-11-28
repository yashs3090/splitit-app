// groupView imports lib/groups, which loads the Supabase client; no call is made here.
jest.mock('./supabase', () => ({ supabase: {} }));

import { ANA, BEN, brunchBill, CY, DEE, dinnerBill, DINNER_ID, MEMBERS, W1, W2 } from '@/test-utils/groupFixtures';
import { GROUP_ID, snapshotOf, withNotPart } from '@/test-utils/groupSnapshotFixtures';

import type { GroupBill, GroupExpense } from './groupBalance';

import {
  detailIds,
  groupAvatars,
  groupHomeRow,
  groupHomeStatus,
  GROUPS_HOME_COPY,
  GROUPS_HOME_DETAIL_LIMIT,
  GROUPS_PAGE_COPY,
  hiddenGroupRow,
  peopleText,
  splitGroups,
  withUnhidden,
} from './groupHomeView';
import type { GroupSnapshot, GroupSummary } from './groups';
import { groupMath, viewerNet } from './groupView';

const TS = '2026-11-26T10:00:00.000Z';
const summary = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  id: GROUP_ID,
  name: 'Tahoe trip',
  memberCount: 4,
  joinedAt: TS,
  hidden: false,
  ...over,
});
const gid = (n: number) => `9a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** W1 with all three suggested payments recorded: every net is 0. */
const settledSnapshot = (): GroupSnapshot => snapshotOf({ ...W1.input, payments: [...(W1.shown ?? [])] });
/** A group just created: Ana only, no costs. */
function emptySnapshot(): GroupSnapshot {
  const s = snapshotOf({ ...W1.input, bills: [], expenses: [], payments: [] });
  return { ...s, members: s.members.filter((m) => m.userId === ANA) };
}

describe('peopleText', () => {
  it('reads "Just you" for one member and "N people" otherwise', () => {
    expect(peopleText(1)).toBe('Just you');
    expect(peopleText(2)).toBe('2 people');
    expect(peopleText(4)).toBe('4 people');
  });
});

describe('groupHomeStatus (C2, criteria 16-17)', () => {
  // Worked out by hand from C1/C2. Dee claims nothing on Dinner; with the nachos unclaimed, Dinner
  // needs Dee (and nobody else: Ana, Ben and Cy each claimed a dish). Waiting receipts add nothing.
  const dinnerOnly = (bills: GroupBill[], expenses: GroupExpense[] = []): GroupSnapshot =>
    snapshotOf({ members: [...MEMBERS], bills, expenses, payments: [] });
  /** Ana paid `cents`, all of it Ben's share: Ben's net is -cents, Ana's +cents. */
  const anaFronted = (cents: number, from: string = BEN): GroupExpense => ({
    id: 'e9000000-0000-4000-8000-000000000001',
    payerId: ANA,
    amountCents: cents,
    shares: [{ userId: from, cents }],
  });
  /** Brunch with Dee's waffles unclaimed: it needs Dee too. */
  const brunchNoDee = (): GroupBill => {
    const b = brunchBill();
    return { ...b, split: { ...b.split, claims: b.split.claims.filter((c) => c.userId !== DEE) } };
  };
  const nachosOpen = () => dinnerBill({ nachosClaimers: [] });

  it('one bill needing me, net -5000: the claim state wins over "You owe"', () => {
    const s = dinnerOnly([nachosOpen()], [anaFronted(5000, DEE)]);
    expect(viewerNet(s, DEE)).toBe(-5000);
    expect(groupHomeStatus(s, DEE)).toEqual({ kind: 'claim', text: 'Claim your items on 1 bill', tone: 'warning' });
  });

  it('two bills needing me: "Claim your items on 2 bills"', () => {
    const s = dinnerOnly([nachosOpen(), brunchNoDee()], [anaFronted(5000, DEE)]);
    expect(groupHomeStatus(s, DEE)).toEqual({ kind: 'claim', text: 'Claim your items on 2 bills', tone: 'warning' });
  });

  it('net 0 with one bill needing me: the claim text', () => {
    const s = dinnerOnly([nachosOpen()]);
    expect(viewerNet(s, DEE)).toBe(0);
    expect(groupHomeStatus(s, DEE)).toMatchObject({ kind: 'claim', text: 'Claim your items on 1 bill' });
  });

  it('owe and owed come from viewerNet, as integer cents', () => {
    const s = dinnerOnly([], [anaFronted(1250)]);
    expect(groupHomeStatus(s, BEN)).toEqual({ kind: 'owe', text: 'You owe $12.50', tone: 'text' });
    const t = dinnerOnly([], [anaFronted(800)]);
    expect(groupHomeStatus(t, ANA)).toEqual({ kind: 'owed', text: "You're owed $8.00", tone: 'success' });
  });

  it('money boundaries: ±1¢ is settled up, ±2¢ shows the amount', () => {
    const one = dinnerOnly([], [anaFronted(1)]);
    expect(groupHomeStatus(one, BEN)).toEqual({ kind: 'settled', text: 'Settled up', tone: 'muted' });
    expect(groupHomeStatus(one, ANA)).toEqual({ kind: 'settled', text: 'Settled up', tone: 'muted' });
    const two = dinnerOnly([], [anaFronted(2)]);
    expect(groupHomeStatus(two, BEN)).toEqual({ kind: 'owe', text: 'You owe $0.02', tone: 'text' });
    expect(groupHomeStatus(two, ANA)).toEqual({ kind: 'owed', text: "You're owed $0.02", tone: 'success' });
  });

  it("owe still shows while someone else's receipt waits; the amount leaves that receipt out", () => {
    // Ben claimed the steak, so the open nachos don't need him. Dinner adds nothing yet.
    const s = dinnerOnly([nachosOpen()], [anaFronted(1250)]);
    expect(groupHomeStatus(s, BEN)).toEqual({ kind: 'owe', text: 'You owe $12.50', tone: 'text' });
  });

  it("net 0, another person's receipt waiting: the items-left count, muted", () => {
    expect(groupHomeStatus(dinnerOnly([nachosOpen()]), BEN)).toEqual({ kind: 'waiting', text: '1 item left to claim', tone: 'muted' });
  });

  it('sums the unclaimed rows of every waiting receipt', () => {
    // Ben: claims on both, so neither needs him; nets 0 because both wait.
    expect(groupHomeStatus(dinnerOnly([nachosOpen(), brunchNoDee()]), BEN)).toEqual({ kind: 'waiting', text: '2 items left to claim', tone: 'muted' });
  });

  it('W1 with every suggestion paid: "Settled up"', () => {
    expect(groupHomeStatus(settledSnapshot(), ANA)).toEqual({ kind: 'settled', text: 'Settled up', tone: 'muted' });
    expect(GROUPS_HOME_COPY.settled).toBe('Settled up');
  });

  it('"Settled up" is about me: others still owing each other does not change it (GCS-6)', () => {
    const s = dinnerOnly([], [{ id: 'e9000000-0000-4000-8000-000000000002', payerId: DEE, amountCents: 3000, shares: [{ userId: CY, cents: 3000 }] }]);
    expect(groupHomeStatus(s, ANA)).toEqual({ kind: 'settled', text: 'Settled up', tone: 'muted' });
    expect(groupHomeStatus(s, CY)).toMatchObject({ kind: 'owe', text: 'You owe $30.00' });
  });

  it('W1 (people still owe): my own amount', () => {
    expect(groupHomeStatus(snapshotOf(W1.input), ANA)).toEqual({ kind: 'owed', text: "You're owed $130.02", tone: 'success' });
    expect(groupHomeStatus(snapshotOf(W1.input), CY)).toEqual({ kind: 'owe', text: 'You owe $174.97', tone: 'text' });
  });

  it('a group with no costs: null', () => {
    expect(groupHomeStatus(emptySnapshot(), ANA)).toBeNull();
  });

  it('only an all-$0 receipt waiting (every row claimed): null', () => {
    const s = settledSnapshot();
    // Every row claimed at $0 with $5.00 of tax: complete, but nothing to spread the tax over.
    const base = s.bills[0]!;
    const rows = base.rows.map((r, i) => ({ ...r, id: `b9000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, totalCents: 0 }));
    const zero = { ...base, id: 'b9000000-0000-4000-8000-000000000009', totalCents: 500, rows };
    expect(groupMath({ ...s, bills: [zero] }).balances.waiting).toMatchObject([{ reason: 'all_zero' }]);
    expect(groupHomeStatus({ ...s, bills: [...s.bills, zero] }, ANA)).toBeNull();
  });

  it('an opt-out drops that bill from the claim count (criterion 17)', () => {
    const both = dinnerOnly([nachosOpen(), brunchNoDee()]);
    expect(groupHomeStatus(withNotPart(both, [DINNER_ID]), DEE)).toMatchObject({ kind: 'claim', text: 'Claim your items on 1 bill' });
    // Opted out of the only waiting bill, net 0: the receipt still waits on someone.
    const one = dinnerOnly([nachosOpen()]);
    expect(groupHomeStatus(withNotPart(one, [DINNER_ID]), DEE)).toEqual({ kind: 'waiting', text: '1 item left to claim', tone: 'muted' });
  });

  it('a claim of mine plus a stale opt-out (B4) is not counted', () => {
    // Dee holds the nachos; the $0 water is open. Claims win over the stale opt-out.
    const s = dinnerOnly([dinnerBill({ nachosClaimers: [DEE], unclaimedWater: true })]);
    expect(groupHomeStatus(s, DEE)).toMatchObject({ kind: 'waiting' });
    expect(groupHomeStatus(withNotPart(s, [DINNER_ID]), DEE)).toMatchObject({ kind: 'waiting', text: '1 item left to claim' });
  });

  it('a snapshot groupMath refuses: null, never throws', () => {
    const s = snapshotOf(W1.input);
    const broken = { ...s, bills: s.bills.map((b) => ({ ...b, totalCents: -1 })) };
    expect(() => groupMath(broken)).toThrow();
    expect(groupHomeStatus(broken, ANA)).toBeNull();
  });
});

describe('groupAvatars', () => {
  it('lists the other members in snapshot order and leaves the viewer out', () => {
    const avatars = groupAvatars(snapshotOf(W1.input), ANA);
    expect(avatars.map((a) => a.name)).toEqual(['Ben', 'Cy', 'Dee']);
    expect(avatars[0]).toEqual({ userId: BEN, name: 'Ben', initials: 'B', isMe: false });
  });

  it('a member with no name reads "A friend" with "?"', () => {
    const s = snapshotOf(W1.input);
    const members = s.members.map((m) => (m.userId === BEN ? { ...m, displayName: '  ' } : m));
    expect(groupAvatars({ ...s, members }, ANA)[0]).toMatchObject({ name: 'A friend', initials: '?' });
  });

  it('a group of just you has none', () => {
    expect(groupAvatars(emptySnapshot(), ANA)).toEqual([]);
  });
});

describe('groupHomeRow', () => {
  it('before the snapshot lands: name, "4 people", no avatars', () => {
    expect(groupHomeRow(summary(), null, ANA)).toEqual({
      id: GROUP_ID,
      title: 'Tahoe trip',
      caption: '4 people',
      status: null,
      avatars: [],
      a11yLabel: 'Tahoe trip, 4 people',
    });
  });

  it('a receipt needing me: the claim state is the caption and the label says both (criterion 18)', () => {
    // W2: the nachos are open and Dee claimed nothing on Dinner.
    const row = groupHomeRow(summary(), snapshotOf(W2.input), DEE);
    expect(row.caption).toBe('Claim your items on 1 bill');
    expect(row.status).toEqual({ kind: 'claim', text: 'Claim your items on 1 bill', tone: 'warning' });
    expect(row.avatars).toHaveLength(3);
    expect(row.a11yLabel).toBe('Tahoe trip, 4 people, Claim your items on 1 bill');
  });

  it("the same group for a viewer who claimed: that viewer's own amount", () => {
    const row = groupHomeRow(summary(), snapshotOf(W2.input), ANA);
    expect(row.caption).toBe("You're owed $82.77");
    expect(row.a11yLabel).toBe("Tahoe trip, 4 people, You're owed $82.77");
  });

  it('settled up', () => {
    const row = groupHomeRow(summary(), settledSnapshot(), ANA);
    expect(row.caption).toBe(GROUPS_HOME_COPY.settled);
    expect(row.a11yLabel).toBe('Tahoe trip, 4 people, Settled up');
  });

  it('a new group of one: "Just you"', () => {
    const row = groupHomeRow(summary({ memberCount: 1 }), emptySnapshot(), ANA);
    expect(row).toMatchObject({ caption: 'Just you', avatars: [], a11yLabel: 'Tahoe trip, Just you' });
  });

  it('prefers the snapshot name and count (newer), and ignores a snapshot of another group', () => {
    const renamed = snapshotOf(W1.input, { groupName: 'Tahoe 2026' });
    // W1: Ana's own net is the caption (C2 rule 3); the people count comes from the snapshot.
    expect(groupHomeRow(summary({ memberCount: 3 }), renamed, ANA)).toMatchObject({
      title: 'Tahoe 2026',
      caption: "You're owed $130.02",
      a11yLabel: "Tahoe 2026, 4 people, You're owed $130.02",
    });
    expect(groupHomeRow(summary({ id: gid(2) }), renamed, ANA)).toMatchObject({ title: 'Tahoe trip', avatars: [], status: null });
  });
});

describe('lists', () => {
  const groups = [summary({ id: gid(1) }), summary({ id: gid(2), hidden: true, name: 'Old flat', memberCount: 2 }), summary({ id: gid(3) })];

  it('splitGroups keeps the order within each list', () => {
    const { visible, hidden } = splitGroups(groups);
    expect(visible.map((g) => g.id)).toEqual([gid(1), gid(3)]);
    expect(hidden.map((g) => g.id)).toEqual([gid(2)]);
  });

  it('hiddenGroupRow', () => {
    expect(hiddenGroupRow(groups[1]!)).toEqual({ id: gid(2), title: 'Old flat', caption: '2 people' });
  });

  it('detailIds reads visible groups only, at most the limit', () => {
    expect(detailIds(groups)).toEqual([gid(1), gid(3)]);
    const many = Array.from({ length: GROUPS_HOME_DETAIL_LIMIT + 2 }, (_, i) => summary({ id: gid(i + 1) }));
    expect(detailIds(many)).toHaveLength(GROUPS_HOME_DETAIL_LIMIT);
    expect(detailIds(many)[0]).toBe(gid(1));
  });

  it('withUnhidden flips only that group', () => {
    expect(withUnhidden(groups, gid(2)).map((g) => g.hidden)).toEqual([false, false, false]);
    expect(withUnhidden(groups, gid(9))).toEqual(groups);
  });

  it('copy at a count of 1', () => {
    expect(GROUPS_HOME_COPY.hiddenLabel(1)).toBe('Hidden groups (1)');
    expect(GROUPS_HOME_COPY.hiddenA11y(1)).toBe('Hidden groups, 1 group');
    expect(GROUPS_HOME_COPY.hiddenA11y(2)).toBe('Hidden groups, 2 groups');
  });
});

describe('GROUPS_PAGE_COPY (the Your groups screen)', () => {
  it('fixes the screen words: title, back, one primary action, and the empty state', () => {
    expect(GROUPS_PAGE_COPY.title).toBe('Groups');
    expect(GROUPS_PAGE_COPY.back).toBe('Home');
    expect(GROUPS_PAGE_COPY.newGroup).toBe(GROUPS_HOME_COPY.newGroup);
    expect(GROUPS_PAGE_COPY.empty).toBe('No groups yet. Start one for a trip or a shared house.');
  });
});
