// The "Your groups" screen, app/(app)/groups/index.tsx (route /groups): title, one "New group"
// button, every group (GroupsSection variant="page"), hidden groups with Unhide, and every state.
// The data layer (lib/groups.ts) is mocked at its exported functions; auth is the real provider on
// the fake Supabase. Home and the screens this one opens are stand-ins. Decisions GR-GL-*.
import { router as appRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Platform, StyleSheet, Text } from 'react-native';

import * as groups from '@/lib/groups';
import type { GroupSnapshot, GroupSummary } from '@/lib/groups';
import { GROUPS_HOME_DETAIL_LIMIT } from '@/lib/groupHomeView';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, DEE, W1, W2 } from '@/test-utils/groupFixtures';
import { GROUP_ID, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return { ...actual, listMyGroups: jest.fn(), fetchGroupSnapshot: jest.fn(), setGroupHidden: jest.fn() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const listGroups = groups.listMyGroups as jest.MockedFunction<typeof groups.listMyGroups>;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const setHidden = groups.setGroupHidden as jest.MockedFunction<typeof groups.setGroupHidden>;

type ListResult = Awaited<ReturnType<typeof groups.listMyGroups>>;

const TS = '2026-11-26T10:00:00.000Z';
const HIDDEN_ID = '9a000000-0000-4000-8000-000000000002';
const gid = (n: number) => `9a000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
const summary = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  id: GROUP_ID,
  name: 'Tahoe trip',
  memberCount: 4,
  joinedAt: TS,
  hidden: false,
  ...over,
});
const TAHOE = summary();
const OLD_FLAT = summary({ id: HIDDEN_ID, name: 'Old flat', memberCount: 2, hidden: true });
const listed = (gs: GroupSummary[]): ListResult => ({ ok: true, groups: gs });
const listFailed: ListResult = { ok: false, error: 'network' };

/** Snapshots carry no Venmo usernames (the fixture's short ones fail the strict parser). */
const snap = (input: Parameters<typeof snapshotOf>[0]): GroupSnapshot => snapshotOf(input, { venmo: {} });

function signInAs(userId: string) {
  const s = fakeSession('Ana');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id: userId } });
}

const ROUTES = {
  appDir: './app',
  overrides: {
    '(app)/(tabs)/index': () => <Text>Home stand-in</Text>,
    '(app)/groups/new': () => <Text>New group stand-in</Text>,
    '(app)/groups/[id]/index': () => <Text>Group stand-in</Text>,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  signInAs(ANA);
  listGroups.mockImplementation(async () => listed([TAHOE, OLD_FLAT]));
  fetchSnapshot.mockImplementation(async () => ({ ok: true, snapshot: snap(W2.input) }));
  setHidden.mockResolvedValue({ ok: true });
});

const openList = () => renderRouter(ROUTES, { initialUrl: '/groups' });

describe.each(['ios', 'web'] as const)('Your groups on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('a cold deep link: title, one "New group" button, the rows, hidden groups; it stays on /groups', async () => {
    const router = openList();
    expect(await screen.findByRole('link', { name: "Tahoe trip, 4 people, You're owed $82.77" })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Groups' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New group' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Hidden groups, 1 group' })).toBeTruthy();
    // The page variant has no Home heading row or "Start a group" link of its own. The only other
    // "Groups" on screen is the tab bar's label (tab-bar spec Task 5).
    expect(screen.getAllByText('Groups')).toHaveLength(2);
    expect(screen.getAllByRole('header', { name: 'Groups' })).toHaveLength(1);
    expect(within(screen.getByLabelText('Groups')).getByText('Groups')).toBeTruthy();
    expect(screen.queryByText('Start a group')).toBeNull();
    expect(screen.queryByText('Old flat')).toBeNull();
    // The root layout's resume (first load, no invite) leaves the opened URL alone.
    await act(async () => {});
    expect(router.getPathname()).toBe('/groups');
  });

  it('tab-bar 30: the Groups tab has no back control; the Tabs tab goes to Home, even with no history', async () => {
    const router = openList();
    await screen.findByText('Tahoe trip');
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    fireEvent.press(screen.getByLabelText('Tabs'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByText('Home stand-in')).toBeTruthy();
  });

  it('24: the same states as Home: Dee sees "Claim your items on 1 bill" in the warning color', async () => {
    signInAs(DEE);
    openList();
    const caption = await screen.findByText('Claim your items on 1 bill');
    expect(StyleSheet.flatten(caption.props.style)).toMatchObject({ color: colors.light.warning });
    expect(screen.getByRole('link', { name: 'Tahoe trip, 4 people, Claim your items on 1 bill' })).toBeTruthy();
  });

  it('signed out: /groups goes to sign-in and reads nothing', async () => {
    supabase.__setInitialSession(null);
    const router = openList();
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(listGroups).not.toHaveBeenCalled();
    expect(screen.queryByText('Tahoe trip')).toBeNull();
  });
});

describe('Your groups: states', () => {
  it('loading: a labelled spinner and the button; no empty message, no rows', async () => {
    let resolve: (r: ListResult) => void = () => {};
    listGroups.mockImplementation(() => new Promise<ListResult>((r) => (resolve = r)));
    openList();
    expect(await screen.findByLabelText('Loading your groups')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy();
    expect(screen.queryByText(/No groups yet/)).toBeNull();
    await act(async () => resolve(listed([TAHOE])));
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    expect(screen.queryByLabelText('Loading your groups')).toBeNull();
  });

  it('no groups: the empty message and the one "New group" button', async () => {
    listGroups.mockImplementation(async () => listed([]));
    openList();
    expect(await screen.findByText('No groups yet. Start one for a trip or a shared house.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New group' })).toHaveLength(1);
    expect(screen.queryByText('Start a group')).toBeNull();
    expect(screen.queryByText(/Hidden groups/)).toBeNull();
  });

  it('only hidden groups: the empty message and the hidden toggle, which lists them with Unhide', async () => {
    listGroups.mockImplementation(async () => listed([OLD_FLAT]));
    openList();
    expect(await screen.findByText('No groups yet. Start one for a trip or a shared house.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Hidden groups, 1 group' }));
    expect(await screen.findByText('Old flat')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unhide Old flat' })).toBeTruthy();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('Unhide moves the group into the list, with one write', async () => {
    let hidden = true;
    listGroups.mockImplementation(async () => listed([TAHOE, { ...OLD_FLAT, hidden }]));
    setHidden.mockImplementation(async () => {
      hidden = false;
      return { ok: true };
    });
    openList();
    fireEvent.press(await screen.findByRole('button', { name: 'Hidden groups, 1 group' }));
    fireEvent.press(await screen.findByRole('button', { name: 'Unhide Old flat' }));
    expect(await screen.findByRole('link', { name: /^Old flat/ })).toBeTruthy();
    expect(setHidden).toHaveBeenCalledTimes(1);
    expect(setHidden).toHaveBeenCalledWith(HIDDEN_ID, false);
    await waitFor(() => expect(screen.queryByText(/Hidden groups/)).toBeNull());
  });

  it('a failed first load: an alert with Try again, which loads the list', async () => {
    listGroups.mockImplementationOnce(async () => listFailed);
    openList();
    const alert = await screen.findByText("Couldn't load your groups.");
    expect(alert.props.accessibilityRole).toBe('alert');
    // "New group" still works while the list is down.
    expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Try loading groups again' }));
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your groups.")).toBeNull();
  });

  it('refetches on focus; a failed refetch keeps the list on screen', async () => {
    const router = openList();
    fireEvent.press(await screen.findByRole('link', { name: /^Tahoe trip/ }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    listGroups.mockImplementation(async () => listFailed);
    await act(async () => appRouter.back());
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Tahoe trip')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your groups.")).toBeNull();
  });

  it('"New group" opens the form', async () => {
    const router = openList();
    await screen.findByText('Tahoe trip');
    fireEvent.press(screen.getByRole('button', { name: 'New group' }));
    await waitFor(() => expect(router.getPathname()).toBe('/groups/new'));
    expect(await screen.findByText('New group stand-in')).toBeTruthy();
  });

  it('every group is listed; status is read for the first 10 only, the rest show the people count', async () => {
    const many = Array.from({ length: GROUPS_HOME_DETAIL_LIMIT + 2 }, (_, i) => summary({ id: gid(i), name: `Trip ${i + 1}` }));
    listGroups.mockImplementation(async () => listed(many));
    // Every read answers with the same group's snapshot, renamed to the group asked for.
    fetchSnapshot.mockImplementation(async (id) => {
      const s = snap(W1.input);
      const name = many.find((g) => g.id === id)?.name ?? '';
      return { ok: true, snapshot: { ...s, group: { ...s.group, id, name } } };
    });
    openList();
    expect(await screen.findByText(`Trip ${GROUPS_HOME_DETAIL_LIMIT + 2}`)).toBeTruthy();
    // Group rows only: on web the tab bar's tabs are links too (tab-bar spec Task 5).
    expect(screen.getAllByRole('link', { name: /^Trip \d+,/ })).toHaveLength(GROUPS_HOME_DETAIL_LIMIT + 2);
    await waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(GROUPS_HOME_DETAIL_LIMIT));
    expect(fetchSnapshot.mock.calls.map(([id]) => id)).toEqual(many.slice(0, GROUPS_HOME_DETAIL_LIMIT).map((g) => g.id));
    // The 11th row has no snapshot: name and people count only.
    expect(screen.getByRole('link', { name: `Trip ${GROUPS_HOME_DETAIL_LIMIT + 1}, 4 people` })).toBeTruthy();
  });

  it('signing out clears the list (per-user state) and leaves for sign-in', async () => {
    const router = openList();
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    await act(async () => {
      await supabase.auth.signOut();
    });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(screen.queryByText('Tahoe trip')).toBeNull();
  });
});
