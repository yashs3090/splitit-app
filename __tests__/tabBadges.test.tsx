// The tab bar's visible badges (docs/specs/2026-11-28-tab-bar-and-activity.md Task 7, criteria 35–36):
// a count on Tabs and Activity (badgeText, "9+" past 9), a dot on Groups, hidden from screen readers
// because each tab's label already says it. LiveTabBar wires the Tabs count Home publishes and
// useFeedBadges. On native and with Platform.OS = 'web'.
//
// The bar renders here without a navigator: expo-router's focus/router hooks are stubbed, and the feed
// reads are mocked at lib/activityFeed's exports (their own tests cover them).
import { act, render, screen, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { LiveTabBar, TabBar } from '@/components/TabBar';
import * as activityFeed from '@/lib/activityFeed';
import { NO_TAB_BADGES, type TabBadges } from '@/lib/tabBar';
import { publishTabsBadge, resetTabsBadge } from '@/lib/tabBadges';
import { colors } from '@/lib/theme';
import { tabNamed } from '@/test-utils/tabBar';

jest.mock('expo-router', () => ({
  ...jest.requireActual<typeof import('expo-router')>('expo-router'),
  useFocusEffect: jest.fn(),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual<typeof import('react-native-safe-area-context')>('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const ME = 'bbbbbbbb-0000-4000-8000-00000000000b';
jest.mock('@/lib/auth', () => ({
  ...jest.requireActual<typeof import('@/lib/auth')>('@/lib/auth'),
  useSession: () => ({ session: { user: { id: 'bbbbbbbb-0000-4000-8000-00000000000b' } }, loading: false }),
}));
jest.mock('@/lib/activityFeed', () => {
  const actual = jest.requireActual<typeof import('@/lib/activityFeed')>('@/lib/activityFeed');
  return { ...actual, fetchBadgeInputs: jest.fn(), feedBadges: jest.fn() };
});

const fetchInputs = activityFeed.fetchBadgeInputs as jest.MockedFunction<typeof activityFeed.fetchBadgeInputs>;
const badgesOf = activityFeed.feedBadges as jest.MockedFunction<typeof activityFeed.feedBadges>;

const ROUTES = ['index', 'groups', 'activity', 'profile'] as const;
function barProps(focused = 0) {
  const routes = ROUTES.map((name) => ({ key: `${name}-key`, name, params: undefined }));
  return {
    state: { index: focused, routes, key: 'tabs', routeNames: [...ROUTES], type: 'tab', stale: false, history: [] },
    descriptors: Object.fromEntries(routes.map((r) => [r.key, { options: {} }])),
    navigation: { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() },
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as unknown as Parameters<typeof TabBar>[0]; // a minimal stand-in for the navigator's props
}

const tab = (name: string) => screen.getByLabelText(tabNamed(name));
const renderBar = (badges: TabBadges) => render(<TabBar {...barProps()} badges={badges} />);
const flush = () => act(async () => {});
/** The marks are hidden from screen readers on purpose, so queries must include hidden elements. */
const HIDDEN = { includeHiddenElements: true } as const;

beforeEach(() => {
  fetchInputs.mockReset();
  badgesOf.mockReset();
  fetchInputs.mockResolvedValue({ ok: true, inputs: {} as activityFeed.FeedBadgeInputs }); // feedBadges is mocked
  badgesOf.mockReturnValue({ activity: 0, groupsDot: false });
});
afterEach(() => {
  act(() => resetTabsBadge());
  jest.restoreAllMocks();
});

describe.each(['ios', 'web'] as const)('tab badges (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('no badges: no marks, plain labels', () => {
    renderBar(NO_TAB_BADGES);
    expect(screen.queryByTestId('tab-badge', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('tab-dot', HIDDEN)).toBeNull();
    expect(tab('Tabs').props.accessibilityLabel).toBe('Tabs');
  });

  it('a count on Tabs and Activity, a dot on Groups, each on its own tab', () => {
    renderBar({ tabs: 3, groups: true, activity: 2 });
    expect(within(tab('Tabs')).getByTestId('tab-badge', HIDDEN)).toBeTruthy();
    expect(within(tab('Tabs')).getByText('3', HIDDEN)).toBeTruthy();
    expect(within(tab('Activity')).getByText('2', HIDDEN)).toBeTruthy();
    expect(within(tab('Groups')).getByTestId('tab-dot', HIDDEN)).toBeTruthy();
    expect(within(tab('Groups')).queryByTestId('tab-badge', HIDDEN)).toBeNull();
    expect(within(tab('Profile')).queryByTestId('tab-badge', HIDDEN)).toBeNull();
    expect(within(tab('Profile')).queryByTestId('tab-dot', HIDDEN)).toBeNull();
    // The labels say the same thing for screen readers.
    expect(tab('Tabs').props.accessibilityLabel).toBe('Tabs, 3 open bills');
    expect(tab('Groups').props.accessibilityLabel).toBe('Groups, new activity');
    expect(tab('Activity').props.accessibilityLabel).toBe('Activity, 2 new');
  });

  it('criterion 35: "9" for 9 and "9+" for 10', () => {
    const { rerender } = renderBar({ tabs: 9, groups: false, activity: 9 });
    expect(within(tab('Tabs')).getByText('9', HIDDEN)).toBeTruthy();
    rerender(<TabBar {...barProps()} badges={{ tabs: 10, groups: false, activity: 12 }} />);
    expect(within(tab('Tabs')).getByText('9+', HIDDEN)).toBeTruthy();
    expect(within(tab('Activity')).getByText('9+', HIDDEN)).toBeTruthy();
    expect(tab('Activity').props.accessibilityLabel).toBe('Activity, more than 9 new');
  });

  it('the marks are hidden from screen readers (the label already says it) and use theme tokens', () => {
    renderBar({ tabs: 1, groups: true, activity: 0 });
    for (const id of ['tab-badge', 'tab-dot']) {
      const mark = screen.getByTestId(id, HIDDEN);
      expect(mark.props.accessibilityElementsHidden).toBe(true);
      expect(mark.props.importantForAccessibility).toBe('no-hide-descendants');
      expect(mark.props['aria-hidden']).toBe(true);
      const style = Object.assign({}, ...[mark.props.style].flat(3).filter(Boolean)) as { backgroundColor?: string };
      expect(style.backgroundColor).toBe(colors.light.primary);
    }
    const digits = within(screen.getByTestId('tab-badge', HIDDEN)).getByText('1', HIDDEN);
    const textStyle = Object.assign({}, ...[digits.props.style].flat(3).filter(Boolean)) as { color?: string };
    expect(textStyle.color).toBe(colors.light.onPrimary);
  });

  it('LiveTabBar: the Tabs count Home publishes, and the Activity count and Groups dot from the feed', async () => {
    badgesOf.mockReturnValue({ activity: 4, groupsDot: true });
    render(<LiveTabBar {...barProps()} />);
    await flush();
    expect(within(tab('Activity')).getByText('4', HIDDEN)).toBeTruthy();
    expect(within(tab('Groups')).getByTestId('tab-dot', HIDDEN)).toBeTruthy();
    expect(within(tab('Tabs')).queryByTestId('tab-badge', HIDDEN)).toBeNull(); // nothing published yet
    act(() => publishTabsBadge(ME, 2));
    expect(within(tab('Tabs')).getByText('2', HIDDEN)).toBeTruthy();
    expect(tab('Tabs').props.accessibilityLabel).toBe('Tabs, 2 open bills');
  });

  it('LiveTabBar: a tab change refreshes; a failed refresh keeps the badges and shows no error', async () => {
    badgesOf.mockReturnValue({ activity: 4, groupsDot: true });
    const { rerender } = render(<LiveTabBar {...barProps(0)} />);
    await flush();
    fetchInputs.mockResolvedValue({ ok: false, error: 'network' });
    rerender(<LiveTabBar {...barProps(2)} />);
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(2);
    expect(within(tab('Activity')).getByText('4', HIDDEN)).toBeTruthy();
    expect(within(tab('Groups')).getByTestId('tab-dot', HIDDEN)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
