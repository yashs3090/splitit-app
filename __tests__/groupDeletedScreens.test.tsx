// Delete group T6 (docs/specs/2026-11-28-delete-group.md, criteria 46 and 48, A1.1, A2.9): the
// deleted state (C8) on Settle up, Who paid what, an expense and group Activity, and Home's one-shot
// notice after your own delete. Native and web (lesson 2026-11-19). lib/groups.ts is mocked at its
// exported functions; Home runs for real, with lib/bills.ts's reads mocked to an empty list.
import { router as appRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, AppState, Modal, Platform, Text, type AppStateStatus } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { clearGroupDeletedNotice, setGroupDeletedNotice } from '@/lib/groupDeletedNotice';
import type { GroupError, GroupSnapshot } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { DELETE_GROUP_COPY, GROUP_ACTIVITY_COPY, GROUP_SCREEN_COPY } from '@/lib/groupScreenText';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, BEN } from '@/test-utils/groupFixtures';
import { GROUP_ID, GROUP_NAME, snapshotOf } from '@/test-utils/groupSnapshotFixtures';
import { tabNamed } from '@/test-utils/tabBar';

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
  return {
    ...actual,
    fetchGroupSnapshot: jest.fn(),
    fetchGroupEvents: jest.fn(),
    listMyGroups: jest.fn(),
    deleteGroup: jest.fn(),
  };
});
jest.mock('@/lib/bills', () => {
  const actual = jest.requireActual<typeof import('@/lib/bills')>('@/lib/bills');
  return {
    ...actual,
    listMyBills: jest.fn(async () => ({ ok: true, bills: [] })),
    fetchSettleData: jest.fn(async () => ({ ok: true, bills: new Map() })),
    fetchPeopleCounts: jest.fn(async () => ({ ok: true, counts: new Map() })),
  };
});

const supabase = realSupabase as unknown as FakeSupabase;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const fetchEvents = groups.fetchGroupEvents as jest.MockedFunction<typeof groups.fetchGroupEvents>;
const listGroups = groups.listMyGroups as jest.MockedFunction<typeof groups.listMyGroups>;
const del = groups.deleteGroup as jest.MockedFunction<typeof groups.deleteGroup>;

type SnapResult = Awaited<ReturnType<typeof groups.fetchGroupSnapshot>>;
const fail = (error: GroupError): { ok: false; error: GroupError } => ({ ok: false, error });

/** Ana and Ben, nothing owed. */
const settled = (): GroupSnapshot => snapshotOf({ members: [ANA, BEN], bills: [], expenses: [], payments: [] }, { members: [ANA, BEN] });
const NOTICE = `"${GROUP_NAME}" was deleted.`;

let snapshotReply: () => Promise<SnapResult>;

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function StandIn() {
  return <Text>Bill stand-in</Text>;
}
const ROUTES = { appDir: './app', overrides: { '(app)/bills/[id]/index': StandIn } };

let appStateListeners: ((s: AppStateStatus) => void)[] = [];
const comeBack = async () => {
  await act(async () => {
    for (const l of appStateListeners) l('active');
  });
};
const press = async (el: ReactTestInstance) => {
  await act(async () => {
    fireEvent.press(el);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  clearGroupDeletedNotice();
  signInAs(ANA);
  snapshotReply = async () => ({ ok: true, snapshot: settled() });
  fetchSnapshot.mockImplementation(() => snapshotReply());
  fetchEvents.mockResolvedValue({ ok: true, events: [] });
  listGroups.mockResolvedValue({ ok: true, groups: [] });
  del.mockResolvedValue({ ok: true });
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListeners.push(listener as (s: AppStateStatus) => void);
    return { remove: () => {} };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

/** Each sub-screen, its URL, and what shows once it has loaded the group. */
const SCREENS = [
  ['Settle up', `/groups/${GROUP_ID}/settle`, () => screen.findByRole('button', { name: 'Record a payment' })],
  ['Who paid what', `/groups/${GROUP_ID}/balances`, () => screen.findAllByText('Ben')],
  ['an expense', `/groups/${GROUP_ID}/expense`, () => screen.findByLabelText('What for')],
] as const;

describe.each(['ios', 'web'] as const)('the deleted state on the sub-screens (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it.each(SCREENS)(
    '%s: a refetch that finds the group gone shows C8 and nothing about the group; Go home goes Home',
    async (_name, url, loaded) => {
      const router = renderRouter(ROUTES, { initialUrl: url });
      await loaded();
      snapshotReply = async () => fail('not_allowed');
      await comeBack();
      expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
      expect(screen.queryByText(GROUP_NAME)).toBeNull();
      expect(screen.queryByText('Ben')).toBeNull();
      expect(screen.queryByText(/\$/)).toBeNull();
      await press(screen.getByRole('button', { name: DELETE_GROUP_COPY.goHome }));
      await waitFor(() => expect(router.getPathname()).toBe('/'));
    },
  );

  it.each(SCREENS)('%s: a first load refused keeps the not-a-member words', async (_name, url) => {
    snapshotReply = async () => fail('not_allowed');
    renderRouter(ROUTES, { initialUrl: url });
    expect(await screen.findByText(GROUP_SCREEN_COPY.notMember)).toBeTruthy();
    expect(screen.queryByText(DELETE_GROUP_COPY.deletedHeading)).toBeNull();
  });

  it('group Activity: shown, then refused on the next focus, it shows C8 (A1.1)', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/activity` });
    expect(await screen.findByText(GROUP_ACTIVITY_COPY.empty)).toBeTruthy();
    // Leave and come back: the focus refetch finds the group gone.
    act(() => appRouter.push('/bills/b1000000-0000-4000-8000-000000000001'));
    await screen.findByText('Bill stand-in');
    snapshotReply = async () => fail('not_allowed');
    fetchEvents.mockResolvedValue(fail('not_allowed'));
    act(() => appRouter.back());
    expect(await screen.findByRole('header', { name: DELETE_GROUP_COPY.deletedHeading })).toBeTruthy();
    expect(screen.queryByText(GROUP_ACTIVITY_COPY.empty)).toBeNull();
    await press(screen.getByRole('button', { name: DELETE_GROUP_COPY.goHome }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('group Activity: a first load refused keeps the not-a-member words', async () => {
    fetchEvents.mockResolvedValue(fail('not_allowed'));
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/activity` });
    expect(await screen.findByText(GROUP_SCREEN_COPY.notMember)).toBeTruthy();
  });
});

describe.each(['ios', 'web'] as const)("Home's notice after your own delete (criterion 48, %s)", (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  async function deleteFromGroup() {
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    await screen.findByRole('button', { name: 'Settle up' });
    await press(screen.getByRole('button', { name: 'Group options' }));
    await press(screen.getByRole('button', { name: DELETE_GROUP_COPY.row }));
    const modal = screen.UNSAFE_getByType(Modal);
    const confirm = screen.getAllByRole('button', { name: DELETE_GROUP_COPY.confirm }).find((b) => {
      for (let n: ReactTestInstance | null = b; n; n = n.parent) if (n === modal) return true;
      return false;
    });
    await press(confirm!);
    await screen.findByRole('header', { name: 'SplitIt' });
    return router;
  }

  it('after deleting, Home shows the notice once; Dismiss hides it', async () => {
    const router = await deleteFromGroup();
    expect(router.getPathname()).toBe('/');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    expect(screen.getAllByText(NOTICE)).toHaveLength(1);
    if (os === 'ios') expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(NOTICE);
    const dismiss = screen.getByRole('button', { name: DELETE_GROUP_COPY.dismiss });
    expect(dismiss.props.accessibilityHint).toBe(DELETE_GROUP_COPY.dismissHint);
    await press(dismiss);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(screen.getByRole('header', { name: 'SplitIt' })).toBeTruthy();
  });

  it("is gone once Home loses focus, and doesn't come back when Home is shown again", async () => {
    const router = await deleteFromGroup();
    expect(await screen.findByText(NOTICE)).toBeTruthy();
    await press(screen.getByLabelText(tabNamed('Groups')));
    await waitFor(() => expect(router.getPathname()).toBe('/groups'));
    await press(screen.getByLabelText(tabNamed('Tabs')));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('a different signed-in account never sees it', async () => {
    setGroupDeletedNotice({ name: GROUP_NAME, userId: BEN });
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
    await screen.findByText('No bills yet.');
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('a notice for this account shows on a cold Home too', async () => {
    setGroupDeletedNotice({ name: GROUP_NAME, userId: ANA });
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });
});
