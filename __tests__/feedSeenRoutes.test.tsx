// The bill and group "opened" times for the Activity badge and dots (spec
// docs/specs/2026-11-28-tab-bar-and-activity.md, Task 9, Contract S, criterion 53).
// - The bill screen records markFeedSeen(me, 'bill', id) while it shows the bill (each focus and
//   each new version), next to useMarkSeen's markBillSeen.
// - The group screen records markFeedSeen(me, 'group', id) once per focus, after a snapshot that
//   focus asked for loads `ready`; never after a failed load. Tested per entry route (Groups tab,
//   an Activity line, a /g/<code> join, a bill's group link, a cold /groups/<id>), iOS and web.
// lib/feedSeen is real (spied on), over memory storage, so the stored time is checked too. The tab
// screens are stand-ins that push the group or the bill (the real screens have their own tests).
// The tab bar renders nothing (its badge reads would add calls), except in the "Activity badge"
// test, which turns on the real LiveTabBar with fetchBadgeInputs answering fixed events, so the
// real feedBadges, seen rule and seen-change refresh decide the count.
import { router as appRouter } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AppState, Platform, Pressable, Text, type AppStateStatus } from 'react-native';

import * as activityFeed from '@/lib/activityFeed';
import type { FeedBillEventRow, FeedContext } from '@/lib/feedRules';
import * as feedSeen from '@/lib/feedSeen';
import type { GroupError, GroupSnapshot } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { GROUP_SCREEN_COPY } from '@/lib/groupScreenText';
import * as activityTabBadges from '@/lib/tabBadges';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';
import { billEvent } from '@/test-utils/feedFixtures';
import { ANA, BEN, W1 } from '@/test-utils/groupFixtures';
import { GROUP_ID, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/feedSeen', () => {
  const actual = jest.requireActual<typeof import('@/lib/feedSeen')>('@/lib/feedSeen');
  return { ...actual, markFeedSeen: jest.fn(actual.markFeedSeen) };
});
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return { ...actual, fetchGroupSnapshot: jest.fn(), fetchGroupEvents: jest.fn() };
});
/** Turns on the real LiveTabBar (the "Activity badge" test); otherwise the bar renders nothing. */
let mockLiveBar = false;
jest.mock('@/components/TabBar', () => {
  const actual = jest.requireActual<typeof import('@/components/TabBar')>('@/components/TabBar');
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  return {
    TabBar: () => null,
    LiveTabBar: (props: BottomTabBarProps) => (mockLiveBar ? createElement(actual.LiveTabBar, props) : null),
  };
});
jest.mock('@/lib/activityFeed', () => {
  const actual = jest.requireActual<typeof import('@/lib/activityFeed')>('@/lib/activityFeed');
  return { ...actual, fetchBadgeInputs: jest.fn() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const mark = feedSeen.markFeedSeen as jest.MockedFunction<typeof feedSeen.markFeedSeen>;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const fetchEvents = groups.fetchGroupEvents as jest.MockedFunction<typeof groups.fetchGroupEvents>;
const fetchBadgeInputs = activityFeed.fetchBadgeInputs as jest.MockedFunction<typeof activityFeed.fetchBadgeInputs>;

const BILL = '11111111-1111-4111-8111-111111111111';
const OTHER_BILL = '33333333-3333-4333-8333-333333333333';
const BURGER = '22222222-0000-4000-8000-000000000001';
const JOIN_CODE = '0123456789abcdef0123';

type SnapResult = Awaited<ReturnType<typeof groups.fetchGroupSnapshot>>;
const ok = (data: unknown): FakeResult => ({ data, error: null });
const snapOk = (s: GroupSnapshot): SnapResult => ({ ok: true, snapshot: s });
const snapFail = (error: GroupError): SnapResult => ({ ok: false, error });

/** What every snapshot fetch returns; a test swaps it (a value, a failure, or a pending promise). */
let snapshotReply: () => Promise<SnapResult>;
/** The bill's own read (bills columns); a test can hold it. */
let billRead: () => Promise<FakeResult>;

const groupMarks = () => mark.mock.calls.filter(([, kind]) => kind === 'group');
const billMarks = () => mark.mock.calls.filter(([, kind]) => kind === 'bill');
const stored = async (userId: string) => feedSeen.readFeedSeen(userId);

function installServer() {
  supabase.__setTable('bills', async (q) => {
    if (q.calls.some((c) => c.method === 'select' && c.args[0] === 'group_id')) return ok({ group_id: GROUP_ID });
    return billRead();
  });
  supabase.__setTable('groups', () => ok({ id: GROUP_ID, name: 'Tahoe trip' }));
  supabase.__setTable('line_items', () =>
    ok([
      {
        id: BURGER,
        name: 'Burger',
        note: null,
        group_position: 0,
        unit_index: 0,
        group_size: 1,
        total_cents: 1500,
        split_set_by: null,
        split_set_at: null,
        kind: 'item',
        applies_to: null,
      },
    ]),
  );
  supabase.__setTable('bill_participants', () =>
    ok(
      [ANA, BEN].map((userId, i) => ({
        user_id: userId,
        joined_at: `2026-11-20T19:0${i}:00Z`,
        settled_at: null,
        settled_cents: null,
        settled_method: null,
        not_received_cents: null,
        not_received_method: null,
        not_received_by: null,
        profile: { display_name: i === 0 ? 'Ana' : 'Ben', venmo_username: null },
      })),
    ),
  );
  supabase.__setTable('claims', () => ok([{ line_item_id: BURGER, user_id: ANA, parts: 1 }]));
  supabase.__setRpc((fn) => {
    if (fn === 'join_group') return ok(GROUP_ID);
    if (fn === 'join_bill') return ok(BILL);
    if (fn === 'my_groups') {
      return ok([{ id: GROUP_ID, name: 'Tahoe trip', member_count: 4, joined_at: '2026-11-20T12:00:00.000Z', hidden: false }]);
    }
    return ok(null);
  });
}

function billRow() {
  return {
    id: BILL,
    host_id: ANA,
    payer_id: ANA,
    subtotal_cents: null,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 1500,
    join_code: JOIN_CODE,
    created_at: '2026-11-20T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
}

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function OpenGroupStandIn({ label }: { label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => appRouter.push(`/groups/${GROUP_ID}`)}>
      <Text>{label}</Text>
    </Pressable>
  );
}
const GroupsTabStandIn = () => <OpenGroupStandIn label="Groups tab: Tahoe trip" />;
const ActivityTabStandIn = () => (
  <>
    <OpenGroupStandIn label="Activity line: Tahoe trip" />
    <Pressable accessibilityRole="button" accessibilityLabel="Activity line: Dinner" onPress={() => appRouter.push(`/bills/${BILL}`)}>
      <Text>Activity line: Dinner</Text>
    </Pressable>
  </>
);
const HomeStandIn = () => (
  <>
    <Text>Home stand-in</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Tabs row: Dinner" onPress={() => appRouter.push(`/bills/${BILL}`)}>
      <Text>Tabs row: Dinner</Text>
    </Pressable>
  </>
);
const SettleStandIn = () => <Text>Settle stand-in</Text>;

const ROUTES = {
  appDir: './app',
  overrides: {
    '(app)/(tabs)/index': HomeStandIn,
    '(app)/(tabs)/groups': GroupsTabStandIn,
    '(app)/(tabs)/activity': ActivityTabStandIn,
    '(app)/groups/[id]/settle': SettleStandIn,
  },
};

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
/** The group screen's positive control: its one Settle up. */
const groupShown = () => screen.findByRole('button', { name: 'Settle up' });

/**
 * Lets queued writes and stray answers land, so "exactly once" is checked after any late call.
 * renderRouter turns on fake timers, so this flushes promises and advances a little time.
 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      jest.advanceTimersByTime(50);
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLiveBar = false;
  storage.data.clear();
  signInAs(ANA);
  snapshotReply = async () => snapOk(snapshotOf(W1.input));
  fetchSnapshot.mockImplementation(() => snapshotReply());
  fetchEvents.mockResolvedValue({ ok: true, events: [] });
  billRead = async () => ok(billRow());
  installServer();
});

describe.each(['ios', 'web'] as const)('group opened (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('53: a cold /groups/<id> records the group once, after ready, and stores the time', async () => {
    let release: (r: SnapResult) => void = () => {};
    snapshotReply = () => new Promise<SnapResult>((r) => (release = r));
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalled());
    await settle();
    // Still loading: nothing recorded yet.
    expect(groupMarks()).toHaveLength(0);
    await act(async () => release(snapOk(snapshotOf(W1.input))));
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));
    expect(groupMarks()[0]?.slice(0, 3)).toEqual([ANA, 'group', GROUP_ID]);
    await waitFor(async () => expect((await stored(ANA))?.groups[GROUP_ID]).toEqual(expect.any(String)));
    await settle();
    expect(groupMarks()).toHaveLength(1);
    expect(billMarks()).toHaveLength(0);
  });

  it('53: refreshes the Groups dot afterwards (the seen-change listeners hear it)', async () => {
    const heard: string[] = [];
    const off = feedSeen.onFeedSeenChange((userId) => heard.push(userId));
    try {
      renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
      await groupShown();
      await waitFor(() => expect(heard).toEqual([ANA]));
    } finally {
      off();
    }
  });

  it('53: a failed load records nothing; Try again that loads records once', async () => {
    snapshotReply = async () => snapFail('network');
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    const retry = await screen.findByRole('button', { name: GROUP_SCREEN_COPY.tryAgain });
    expect(screen.getByText(GROUP_SCREEN_COPY.loadError)).toBeTruthy();
    await settle();
    expect(groupMarks()).toHaveLength(0);
    snapshotReply = async () => snapOk(snapshotOf(W1.input));
    await press(retry);
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));
  });

  it('53: not a member records nothing', async () => {
    snapshotReply = async () => snapFail('not_allowed');
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    expect(await screen.findByText(GROUP_SCREEN_COPY.notMember)).toBeTruthy();
    await settle();
    expect(groupMarks()).toHaveLength(0);
  });

  it('53: once per focus: a foreground refetch adds nothing; coming back adds one; a failed refetch on the way back adds none', async () => {
    const handlers: ((s: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (s: AppStateStatus) => void);
      return { remove: () => {} };
    });
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));

    // Back to the foreground while the group is in front: a refetch, but the same focus, so none.
    const before0 = fetchSnapshot.mock.calls.length;
    await act(async () => handlers.forEach((h) => h('active')));
    await waitFor(() => expect(fetchSnapshot.mock.calls.length).toBeGreaterThan(before0));
    await settle();
    expect(groupMarks()).toHaveLength(1);

    // Settle up and back: the refocus refetch loads ready, so one more.
    await press(screen.getByRole('button', { name: 'Settle up' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/settle`));
    const before = fetchSnapshot.mock.calls.length;
    await act(async () => appRouter.back());
    await waitFor(() => expect(fetchSnapshot.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(groupMarks()).toHaveLength(2));

    // Away and back again, but this refetch fails: the old snapshot stays and nothing is recorded.
    await press(screen.getByRole('button', { name: 'Settle up' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/settle`));
    snapshotReply = async () => snapFail('network');
    const before2 = fetchSnapshot.mock.calls.length;
    await act(async () => appRouter.back());
    await waitFor(() => expect(fetchSnapshot.mock.calls.length).toBeGreaterThan(before2));
    await groupShown();
    await settle();
    expect(groupMarks()).toHaveLength(2);
  });

  it.each([
    ['the Groups tab', '/groups', 'Groups tab: Tahoe trip'],
    ['an Activity line', '/activity', 'Activity line: Tahoe trip'],
  ])('53: reached from %s, records once', async (_name, start, label) => {
    const router = renderRouter(ROUTES, { initialUrl: start });
    await press(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));
    await settle();
    expect(groupMarks()).toHaveLength(1);
    expect(groupMarks()[0]?.slice(0, 3)).toEqual([ANA, 'group', GROUP_ID]);
  });

  it('53: reached from a /g/<code> join, records once', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/g/${JOIN_CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));
    await settle();
    expect(groupMarks()).toHaveLength(1);
  });

  it("53: reached from a bill's group link, records the bill and then the group once", async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    const link = await screen.findByRole('link', { name: 'In Tahoe trip' });
    await waitFor(() => expect(billMarks()).toHaveLength(1));
    expect(groupMarks()).toHaveLength(0);
    await press(link);
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    await groupShown();
    await waitFor(() => expect(groupMarks()).toHaveLength(1));
    await settle();
    expect(groupMarks()).toHaveLength(1);
    const seen = await stored(ANA);
    expect(seen?.bills[BILL]).toEqual(expect.any(String));
    expect(seen?.groups[GROUP_ID]).toEqual(expect.any(String));
  });
});

describe.each(['ios', 'web'] as const)('bill opened (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a cold /bills/<id> records the bill once it shows, under my id, and stores the time', async () => {
    let release: (r: FakeResult) => void = () => {};
    billRead = () => new Promise<FakeResult>((r) => (release = r));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await waitFor(() => expect(supabase.__queries.some((q) => q.table === 'bills')).toBe(true));
    await settle();
    // Not shown yet: nothing recorded.
    expect(billMarks()).toHaveLength(0);
    await act(async () => release(ok(billRow())));
    await screen.findByText('Total $15.00');
    await waitFor(() => expect(billMarks()).toHaveLength(1));
    expect(billMarks()[0]?.slice(0, 3)).toEqual([ANA, 'bill', BILL]);
    await waitFor(async () => expect((await stored(ANA))?.bills[BILL]).toEqual(expect.any(String)));
    await settle();
    expect(billMarks()).toHaveLength(1);
    expect(groupMarks()).toHaveLength(0);
  });

  it.each([
    ['a Tabs row', '/', 'Tabs row: Dinner'],
    ['an Activity line', '/activity', 'Activity line: Dinner'],
  ])('R5: reached from %s, records the bill once, under my id', async (_name, start, label) => {
    const router = renderRouter(ROUTES, { initialUrl: start });
    await press(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText('Total $15.00');
    await waitFor(() => expect(billMarks()).toHaveLength(1));
    await settle();
    expect(billMarks()).toHaveLength(1);
    expect(billMarks()[0]?.slice(0, 3)).toEqual([ANA, 'bill', BILL]);
    expect((await stored(ANA))?.bills[BILL]).toEqual(expect.any(String));
    expect(groupMarks()).toHaveLength(0);
  });

  it('R5: reached from a /b/<code> join, records the bill once, after the join', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/b/${JOIN_CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_bill')).toHaveLength(1);
    await screen.findByText('Total $15.00');
    await waitFor(() => expect(billMarks()).toHaveLength(1));
    await settle();
    expect(billMarks()).toHaveLength(1);
    expect(billMarks()[0]?.slice(0, 3)).toEqual([ANA, 'bill', BILL]);
    expect((await stored(ANA))?.bills[BILL]).toEqual(expect.any(String));
  });

  it('another person on this device gets their own key; the first person stores nothing for them', async () => {
    signInAs(BEN);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $15.00');
    await waitFor(async () => expect((await stored(BEN))?.bills[BILL]).toEqual(expect.any(String)));
    for (const call of billMarks()) expect(call[0]).toBe(BEN);
    expect(storage.data.has(feedSeen.feedSeenKey(ANA))).toBe(false);
  });
});

// Criterion 33 (Task 5's rule, on the bill screen): Home returns to the tab the bill was opened
// from, not always to Tabs.
describe.each(['ios', 'web'] as const)('bill screen Home (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('33: a bill opened from the Activity tab goes Home to Activity', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/activity' });
    await press(await screen.findByRole('button', { name: 'Activity line: Dinner' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText('Total $15.00');
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    expect(screen.getByRole('button', { name: 'Activity line: Dinner' })).toBeTruthy();
  });

  it('33: a cold /bills/<id> (nothing below) goes Home to Tabs', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $15.00');
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByText('Home stand-in')).toBeTruthy();
  });
});

// R5: the whole loop through the live tab bar: Activity's badge counts two bills with unread lines;
// opening one from an Activity line records it, and the badge drops that bill's line (the seen-change
// refresh runs FEED_SEEN_REFRESH_DELAY_MS after the write), keeping the other bill's.
describe.each(['ios', 'web'] as const)('Activity badge after opening a bill (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    mockLiveBar = true;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("R5: the Activity badge drops the opened bill's lines and keeps the other bill's", async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const place = { joinedAt: '2026-11-20T12:00:00.000Z', groupId: null, hostId: BEN };
    const ctx: FeedContext = {
      myId: ANA,
      bills: new Map([
        [BILL, place],
        [OTHER_BILL, place],
      ]),
      groups: new Map(),
      myClaims: new Map(),
      payments: new Map(),
    };
    // "Ben added you" on each bill (F-a: counts).
    const added = (billId: string): FeedBillEventRow =>
      billEvent('participant_added', { bill_id: billId, actor_id: BEN, details: { user_id: ANA }, created_at: at });
    fetchBadgeInputs.mockResolvedValue({
      ok: true,
      inputs: { ctx, billEvents: [added(BILL), added(OTHER_BILL)], groupEvents: [], truncated: { bill: false, group: false } },
    });
    const router = renderRouter(ROUTES, { initialUrl: '/activity' });
    expect(await screen.findByLabelText('Activity, 2 new')).toBeTruthy();

    await press(screen.getByRole('button', { name: 'Activity line: Dinner' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText('Total $15.00');
    await waitFor(() => expect(billMarks()).toHaveLength(1));
    await act(async () => appRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    await act(async () => {
      jest.advanceTimersByTime(activityTabBadges.FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(await screen.findByLabelText('Activity, 1 new')).toBeTruthy();
    expect(screen.queryByLabelText('Activity, 2 new')).toBeNull();
  });
});
