// The tab bar and the route moves (docs/specs/2026-11-28-tab-bar-and-activity.md Tasks 5–6,
// criteria 27–34; A1.2, A1.6). Router tests through the whole app (root layout, the (app) stack with
// its (tabs) anchor, the tab navigator, components/TabBar.tsx), on native and with Platform.OS = 'web'.
//
// Stand-ins: the bill screen and Settle (their own tests cover them; here only where Back goes
// matters). The group screen, Groups list, Profile, Activity, /scan and /g/<code> are the real ones,
// with lib/groups mocked at its exported functions (as __tests__/groupScreen.test.tsx).
import * as Notifications from 'expo-notifications';
import { router as globalRouter, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import Bell from 'lucide-react-native/icons/bell';
import CircleUserRound from 'lucide-react-native/icons/circle-user-round';
import Plus from 'lucide-react-native/icons/plus';
import Receipt from 'lucide-react-native/icons/receipt';
import UsersRound from 'lucide-react-native/icons/users-round';
import type { ReactElement } from 'react';
import { Keyboard, Platform, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { Icon } from '@/components/ui/Icon';
import * as groups from '@/lib/groups';
import { savePendingInvite } from '@/lib/pendingInvite';
import { resetResumeGateForTests } from '@/lib/resumeGate';
import { sentCheckNotificationId } from '@/lib/sentCheck';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';
import { ANA, W1 } from '@/test-utils/groupFixtures';
import { GROUP_ID, GROUP_NAME, snapshotOf } from '@/test-utils/groupSnapshotFixtures';
import { TAB_BAR_TEST_ID, tabNamed } from '@/test-utils/tabBar';

// A1.2: Home's bill sections start collapsed; these tests read Home rows, so they start open.
// Task 7: the bar's Activity/Groups badge reads stay quiet here (test-utils/tabBar quietFeedBadges).
jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/homeSections', () => {
  const actual = jest.requireActual<typeof import('@/lib/homeSections')>('@/lib/homeSections');
  return { __esModule: true, ...actual, HOME_SECTIONS_START_CLOSED: [] };
});
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
// Each auth session returns a fresh single-use code (as __tests__/inviteFlow.test.tsx).
let mockCodeCounter = 0;
jest.mock('expo-web-browser', () => ({
  ...jest.requireActual<typeof import('expo-web-browser')>('expo-web-browser'),
  openAuthSessionAsync: jest.fn(async (_url: string, redirectUrl: string) => ({
    type: 'success',
    url: `${redirectUrl}?code=tab-bar-pkce-${++mockCodeCounter}`,
  })),
}));
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return { ...actual, listMyGroups: jest.fn(), fetchGroupSnapshot: jest.fn(), fetchGroupEvents: jest.fn(), joinGroup: jest.fn() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const listGroups = groups.listMyGroups as jest.MockedFunction<typeof groups.listMyGroups>;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const fetchEvents = groups.fetchGroupEvents as jest.MockedFunction<typeof groups.fetchGroupEvents>;
const joinGroup = groups.joinGroup as jest.MockedFunction<typeof groups.joinGroup>;
const N = Notifications as unknown as {
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponse: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
};

const HANA = '00000000-0000-4000-8000-00000000000a';
const BILL = '11111111-1111-4111-8111-111111111111';
const CODE = '0123456789abcdef0123';
const GROUP_CODE = 'abcdef0123456789abcd';
const SETTLE = `/bills/${BILL}/settle`;
const ADD_LABEL = 'Add receipt, opens a photo or typing the items';
const GROUP_ROW = /^Tahoe trip/;

function BillStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill stand-in ${id}`}</Text>;
}
function SettleStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Settle stand-in ${id}`}</Text>;
}
const ROUTES = {
  appDir: './app',
  overrides: { '(app)/bills/[id]/index': BillStandIn, '(app)/bills/[id]/settle': SettleStandIn },
};

/** One my_bills() row: Hana's bill, which the viewer (Ana) has opened and claimed nothing on. */
const BILL_ROW = {
  bill_id: BILL,
  host_id: HANA,
  host_name: 'Hana',
  payer_id: HANA,
  total_cents: 4480,
  created_at: '2026-11-20T12:00:00Z',
  joined_at: '2026-11-20T12:05:00Z',
  added: false,
  seen: true,
  claimed_any: false,
  complete: false,
};

function signIn() {
  const s = fakeSession('Ana');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id: ANA } });
}

// ----- the notification responder's input (expo-notifications faked at the package edge) -----
type Listener = (raw: unknown) => void;
let listeners: Listener[] = [];
let lastResponse: unknown = null;
const AT_MS = Date.parse('2026-11-26T20:00:00.000Z');
let responseN = 0;
function openResponse() {
  responseN += 1;
  const data = { billId: BILL, userId: ANA, payerId: HANA, cents: 1510, markAtMs: AT_MS };
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        identifier: `${sentCheckNotificationId(ANA, BILL, HANA, AT_MS) ?? ''}.tab${responseN}`,
        content: { title: 'SplitIt', body: 'Did your $15.10 to Hana go through?', data },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetResumeGateForTests();
  storage.data.clear();
  signIn();
  listGroups.mockResolvedValue({ ok: true, groups: [{ id: GROUP_ID, name: GROUP_NAME, memberCount: 4, joinedAt: '2026-11-20T12:00:00.000Z', hidden: false }] });
  fetchSnapshot.mockResolvedValue({ ok: true, snapshot: snapshotOf(W1.input) });
  fetchEvents.mockResolvedValue({ ok: true, events: [] });
  joinGroup.mockResolvedValue({ ok: true, groupId: GROUP_ID });
  supabase.__setRpc((fn) => {
    if (fn === 'my_bills') return { data: [{ ...BILL_ROW }], error: null };
    if (fn === 'join_bill') return { data: BILL, error: null };
    if (fn === 'venmo_prompt_pending') return { data: false, error: null };
    return { data: null, error: null } satisfies FakeResult;
  });
  supabase.__setTable('profiles', () => ({ data: { display_name: 'Ana', venmo_username: null }, error: null }));
  listeners = [];
  lastResponse = null;
  N.addNotificationResponseReceivedListener.mockImplementation((l: Listener) => {
    listeners.push(l);
    return { remove: () => (listeners = listeners.filter((x) => x !== l)) };
  });
  N.getLastNotificationResponse.mockImplementation(() => lastResponse);
  N.clearLastNotificationResponse.mockImplementation(() => {
    lastResponse = null;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ----- helpers -----

const bar = () => screen.getByTestId(TAB_BAR_TEST_ID);
/** The bar's controls, in order: every element in it with an accessibility label. */
const barControls = () =>
  bar().findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityRole !== undefined);
/** A tab by its name; its label may carry a badge ("Tabs, 1 open bill", Task 7). */
const tab = (label: string) => within(bar()).getByLabelText(tabNamed(label));
const addButton = () => within(bar()).getByRole('button', { name: ADD_LABEL });
/** Native exposes the selection as accessibilityState.selected, web as aria-current="page". */
function isSelected(el: ReactTestInstance, os: 'ios' | 'web'): boolean {
  return os === 'web' ? el.props['aria-current'] === 'page' : el.props.accessibilityState?.selected === true;
}
const selectedTabs = (os: 'ios' | 'web') =>
  barControls()
    .filter((n) => isSelected(n, os))
    .map((n) => (n.props.accessibilityLabel as string).split(',')[0]);
const press = async (el: ReactTestInstance) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
/** Home is ready: its heading, plus the tab bar (the sign-in screen also has a "SplitIt" heading). */
async function homeReady() {
  await screen.findByRole('header', { name: 'SplitIt' });
  expect(bar()).toBeTruthy();
}
/** A screen above the tabs is in front: the tab bar under it is hidden from screen readers. */
const tabBarShown = () => screen.queryByTestId(TAB_BAR_TEST_ID) !== null;

describe.each(['ios', 'web'] as const)('tab bar (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('27: signed in, the app opens on the Tabs tab: SplitIt, the bill rows, no Groups/Profile icons, no bar, no Groups block', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    expect(router.getPathname()).toBe('/');
    expect(await screen.findByText("Hana's bill")).toBeTruthy(); // positive control: the rows landed
    expect(selectedTabs(os)).toEqual(['Tabs']);
    expect(screen.queryByRole('button', { name: 'Groups' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Profile' })).toBeNull();
    expect(screen.queryByText('Split a bill')).toBeNull();
    // The Groups block is gone from Home: the group is listed only on the Groups tab.
    expect(screen.queryByText(GROUP_NAME)).toBeNull();
    expect(listGroups).not.toHaveBeenCalled();
    await press(tab('Groups'));
    expect(await screen.findByRole('link', { name: GROUP_ROW })).toBeTruthy(); // positive control: the seed is there
  });

  it('28: Tabs · Groups · (+) · Activity · Profile, each with its icon; the labels show', async () => {
    renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    expect(barControls().map((n) => n.props.accessibilityLabel)).toEqual([
      'Tabs, 1 open bill', // Task 7: Hana's bill is open (criterion 35)
      'Groups',
      ADD_LABEL,
      'Activity',
      'Profile',
    ]);
    expect(bar().findAll((n) => n.type === Icon).map((n) => n.props.icon as unknown)).toEqual([Receipt, UsersRound, Plus, Bell, CircleUserRound]);
    for (const label of ['Tabs', 'Groups', 'Activity', 'Profile']) {
      expect(within(tab(label)).getByText(label)).toBeTruthy();
      expect(tab(label).props.accessibilityRole).toBe(os === 'web' ? 'link' : 'tab');
    }
    // (+) is an icon button: its label is for screen readers only.
    expect(within(bar()).queryByText('Add receipt')).toBeNull();
    if (os !== 'web') expect(bar().findAll((n) => n.props.accessibilityRole === 'tablist' && typeof n.type === 'string')).toHaveLength(1);
  });

  it('28: the selected tab moves with each press, and the URL follows (31: /, /groups, /activity, /profile)', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
    for (const [label, path] of [
      ['Groups', '/groups'],
      ['Activity', '/activity'],
      ['Profile', '/profile'],
      ['Tabs', '/'],
    ] as const) {
      await press(tab(label));
      await waitFor(() => expect(router.getPathname()).toBe(path));
      expect(selectedTabs(os)).toEqual([label]);
    }
  });

  it('29: (+) pushes /scan exactly once on a double tap; Home there goes back to the tab it came from; (+) works again', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = renderRouter(ROUTES, { initialUrl: '/groups' });
    expect(await screen.findByRole('header', { name: 'Groups' })).toBeTruthy();
    await act(async () => {
      fireEvent.press(addButton());
      fireEvent.press(addButton());
    });
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(push.mock.calls).toEqual([['/scan']]);
    // The scan screen offers typing the items as today.
    expect(await screen.findByText(/Enter items|Type items instead/)).toBeTruthy();
    expect(tabBarShown()).toBe(false);
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/groups'));
    expect(selectedTabs(os)).toEqual(['Groups']);
    // The guard opened again when the tabs came back.
    await press(addButton());
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(push.mock.calls).toEqual([['/scan'], ['/scan']]);
  });

  it('30: Groups is the groups list, Profile has no back control, Activity shows the Activity screen', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    await press(tab('Groups'));
    expect(await screen.findByRole('link', { name: GROUP_ROW })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Groups' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    await press(tab('Profile'));
    expect(await screen.findByLabelText('Venmo username')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    await press(tab('Activity'));
    expect(await screen.findByRole('header', { name: 'Activity' })).toBeTruthy();
    expect(router.getPathname()).toBe('/activity');
  });

  it.each([
    ['/groups', 'Groups'],
    ['/activity', 'Activity'],
    ['/profile', 'Profile'],
  ] as const)('31: a cold %s opens that tab, with the bar', async (path, label) => {
    const router = renderRouter(ROUTES, { initialUrl: path });
    await waitFor(() => expect(screen.queryByTestId(TAB_BAR_TEST_ID)).not.toBeNull());
    expect(selectedTabs(os)).toEqual([label]);
    await act(async () => {});
    expect(router.getPathname()).toBe(path);
  });

  it.each([
    [`/groups/${GROUP_ID}`, () => screen.findByRole('button', { name: 'Settle up' })],
    ['/groups/new', () => screen.findByRole('header', { name: 'New group' })],
    [`/bills/${BILL}`, () => screen.findByText(`Bill stand-in ${BILL}`)],
    [SETTLE, () => screen.findByText(`Settle stand-in ${BILL}`)],
    ['/scan', () => screen.findByText(/Enter items|Type items instead/)],
  ] as const)('31: a cold %s opens above the tabs, with no tab bar; Back goes to Tabs (32e)', async (path, shown) => {
    const router = renderRouter(ROUTES, { initialUrl: path });
    expect(await shown()).toBeTruthy();
    expect(router.getPathname()).toBe(path);
    expect(tabBarShown()).toBe(false);
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });

  it('32a: signing in with no invite lands on Tabs', async () => {
    let router: ReturnType<typeof renderRouter>;
    if (os === 'web') {
      // Web sign-in is a full-page redirect: the app starts again on / with the session in the URL.
      router = renderRouter(ROUTES, { initialUrl: '/' });
    } else {
      supabase.__setInitialSession(null);
      router = renderRouter(ROUTES, { initialUrl: '/' });
      await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
      await press(await screen.findByText('Continue with Google'));
    }
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });

  it('32b: a pending bill invite resumes to the bill on first load (the web OAuth landing on /); Back → Tabs', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_bill')).toEqual([['join_bill', { p_code: CODE }]]);
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });

  it('32c: /auth/callback while signed in goes to Tabs (only the resume effect navigates)', async () => {
    const replace = jest.spyOn(globalRouter, 'replace');
    const router = renderRouter(ROUTES, { initialUrl: '/auth/callback?code=tab-bar-code' });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
    expect(replace.mock.calls).toEqual([['/']]);
  });

  it('32d: a cold-start notification tap opens Settle once; Back → Tabs', async () => {
    lastResponse = openResponse();
    const push = jest.spyOn(globalRouter, 'push');
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(await screen.findByText(`Settle stand-in ${BILL}`)).toBeTruthy();
    await act(async () => {});
    expect(push.mock.calls.filter(([href]) => href === SETTLE)).toHaveLength(1);
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });

  it('32d / A1.6: a notification tap while the app is open on Activity opens Settle once; Back → Activity', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    await press(tab('Activity'));
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    await act(async () => listeners.forEach((l) => l(openResponse())));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(push.mock.calls.filter(([href]) => href === SETTLE)).toHaveLength(1);
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    expect(selectedTabs(os)).toEqual(['Activity']);
    expect(screen.getByRole('header', { name: 'Activity' })).toBeTruthy();
  });

  it('32f: /g/<code> joins and opens the group; its Home goes to Tabs', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/g/${GROUP_CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeTruthy();
    expect(joinGroup).toHaveBeenCalledTimes(1);
    // The join replaces with the tabs anchored under the group, so there is somewhere to go back to.
    expect(globalRouter.canDismiss()).toBe(true);
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });

  it('33: a group opened from the Groups tab: its Home returns to Groups', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/groups' });
    await press(await screen.findByRole('link', { name: GROUP_ROW }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/groups'));
    expect(selectedTabs(os)).toEqual(['Groups']);
  });

  it('33: a group opened from Activity: its Home returns to Activity; a bill opened from Activity: Back returns to Activity', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/activity' });
    expect(await screen.findByRole('header', { name: 'Activity' })).toBeTruthy();
    // Activity's lines arrive in Task 8; a line's tap is router.push to its place.
    act(() => globalRouter.push(`/groups/${GROUP_ID}`));
    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    expect(selectedTabs(os)).toEqual(['Activity']);

    act(() => globalRouter.push(`/bills/${BILL}`));
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/activity'));
    expect(selectedTabs(os)).toEqual(['Activity']);
  });

  it('34: "Go home" (router.replace("/")) lands on Tabs', async () => {
    fetchSnapshot.mockResolvedValue({ ok: false, error: 'not_allowed' });
    const router = renderRouter(ROUTES, { initialUrl: '/activity' });
    expect(await screen.findByRole('header', { name: 'Activity' })).toBeTruthy();
    act(() => globalRouter.push(`/groups/${GROUP_ID}`));
    await press(await screen.findByRole('button', { name: 'Go home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
    expect(selectedTabs(os)).toEqual(['Tabs']);
  });
});

describe('tab bar and the Android keyboard', () => {
  it('hides while the keyboard is up on Android (the window resizes there), and comes back after', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const handlers = new Map<string, () => void>();
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return { remove: () => handlers.delete(event) };
    }) as unknown as typeof Keyboard.addListener);
    renderRouter(ROUTES, { initialUrl: '/profile' });
    expect(await screen.findByLabelText('Venmo username')).toBeTruthy();
    expect(tabBarShown()).toBe(true);
    await act(async () => handlers.get('keyboardDidShow')?.());
    expect(tabBarShown()).toBe(false);
    await act(async () => handlers.get('keyboardDidHide')?.());
    expect(tabBarShown()).toBe(true);
  });

  it('stays put on iOS when the keyboard shows (it overlays the bar there)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const spy = jest.spyOn(Keyboard, 'addListener');
    renderRouter(ROUTES, { initialUrl: '/profile' });
    expect(await screen.findByLabelText('Venmo username')).toBeTruthy();
    expect(spy.mock.calls.filter(([e]) => e === 'keyboardDidShow' || e === 'keyboardDidHide')).toEqual([]);
    expect(tabBarShown()).toBe(true);
  });
});

// The selected state as react-native-web writes it to the DOM (lesson 2026-11-27: Jest's renderer
// reads accessibilityState, the browser doesn't). Rendered to static markup, as __tests__/groupAriaWeb.
describe('tab bar on web: the DOM carries the selection', () => {
  function webMarkup(selected: boolean): string {
    let html = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => jest.requireActual('react-native-web'));
      jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
      const React = jest.requireActual<typeof import('react')>('react');
      // @types/react-dom isn't installed; this is the one function used.
      const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
      const { TabButton } = jest.requireActual<typeof import('@/components/TabBarButtons')>('@/components/TabBarButtons');
      html = renderToStaticMarkup(React.createElement(TabButton, { icon: Bell, label: 'Activity', a11yLabel: 'Activity', selected, onPress: () => {} }));
    });
    return html;
  }

  it('the selected tab is a link with aria-current="page"; the others have no aria-current', () => {
    const on = webMarkup(true);
    expect(on).toContain('aria-label="Activity"'); // positive control: the tab rendered
    expect(on).toContain('role="link"');
    expect(on).toContain('aria-current="page"');
    const off = webMarkup(false);
    expect(off).toContain('aria-label="Activity"');
    expect(off).not.toContain('aria-current');
  });
});
