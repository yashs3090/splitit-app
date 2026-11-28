/**
 * @jest-environment jsdom
 */
// QA criterion 50 (docs/specs/2026-11-28-tab-bar-and-activity.md): the Activity chips keep keyboard
// focus on web. The screen is rendered with react-native-web into jsdom (react-dom), so this is the
// DOM a browser gets. A chip change resets the feed to "loading"; before the fix that took the
// pull-to-refresh wrapper away, react-native-web's ScrollView rebuilt its tree, the chips remounted
// and focus fell to <body>, so a second arrow did nothing.
//
// Mocked at the edges: fetchFeedPage (every page empty and the end), the seen-state reads, the
// session, and expo-router's hooks (no navigator here; nothing is tapped).
import type { ReactElement } from 'react';

const mockFetchPage = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// lib/theme.ts reads the Appearance choice, which loads lib/storage; keep it in memory.
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/auth', () => ({
  useSession: () => ({ session: { user: { id: '0e000000-0000-4000-8000-000000000001' } }, loading: false, oauthError: null }),
}));
jest.mock('@/lib/activityFeed', () => {
  const actual = jest.requireActual<typeof import('@/lib/activityFeed')>('@/lib/activityFeed');
  return { ...actual, fetchFeedPage: (...args: unknown[]) => mockFetchPage(...args) };
});
jest.mock('@/lib/feedSeen', () => {
  const actual = jest.requireActual<typeof import('@/lib/feedSeen')>('@/lib/feedSeen');
  return { ...actual, readFeedSeen: jest.fn(async () => actual.EMPTY_FEED_SEEN), markFeedSeen: jest.fn(async () => true) };
});
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    // Runs once on mount, like a screen that gains focus once.
    useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

let rnw: { React: typeof import('react'); container: HTMLElement; unmount: () => void };

/** An empty last page for whatever chip asked. */
function emptyPage(myId: string) {
  const { initialFeedState } = jest.requireActual<typeof import('@/lib/activityFeed')>('@/lib/activityFeed');
  return {
    ok: true,
    page: {
      state: initialFeedState(myId),
      rows: [],
      items: [],
      candidates: [],
      viewFacts: { myId, names: new Map(), bills: new Map(), groupNames: new Map(), billData: new Map(), snapshots: new Map() },
      end: true,
      ctx: {},
      places: { bills: new Map(), groups: new Map(), groupNames: new Map() },
      facts: { bills: new Map(), payments: new Map(), names: new Map(), snapshots: new Map() },
    },
  };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let React!: typeof import('react');
let render!: () => { container: HTMLElement; unmount: () => void };
beforeAll(() => {
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; these are the two functions used.
    const { createRoot } = jest.requireActual<{
      createRoot: (el: HTMLElement) => { render: (n: ReactElement) => void; unmount: () => void };
    }>('react-dom/client');
    const ActivityRoute = jest.requireActual<typeof import('@/app/(app)/(tabs)/activity')>('@/app/(app)/(tabs)/activity').default;
    render = () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      React.act(() => root.render(React.createElement(ActivityRoute)));
      return {
        container,
        unmount: () => {
          React.act(() => root.unmount());
          container.remove();
        },
      };
    };
  });
});

beforeEach(async () => {
  mockFetchPage.mockReset();
  mockFetchPage.mockImplementation(async (myId: string) => emptyPage(myId));
  rnw = { React, ...render() };
  await settle();
});

afterEach(() => rnw.unmount());

/** Let the page answers land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await rnw.React.act(async () => {
      await Promise.resolve();
    });
  }
}

const radio = (label: string): HTMLElement => {
  const found = Array.from(rnw.container.querySelectorAll<HTMLElement>('[role="radio"]')).find((e) => e.textContent === label);
  if (found === undefined) throw new Error(`no radio ${label} in ${rnw.container.innerHTML}`);
  return found;
};
const press = async (el: HTMLElement, key: string) => {
  await rnw.React.act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
  await settle();
};

describe('Activity chips on web: arrow keys keep focus (criterion 50)', () => {
  it('positive control: three chips, All checked, and the empty copy shows', () => {
    expect(Array.from(rnw.container.querySelectorAll('[role="radio"]')).map((e) => e.textContent)).toEqual(['All', 'Money', 'Groups']);
    expect(radio('All').getAttribute('aria-checked')).toBe('true');
    expect(rnw.container.textContent).toContain('Nothing new.');
  });

  it('ArrowRight twice from All checks Groups with focus on it', async () => {
    const all = radio('All');
    all.focus();
    expect(document.activeElement).toBe(all);
    await press(all, 'ArrowRight');
    expect(radio('Money').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('Money'));
    await press(document.activeElement as HTMLElement, 'ArrowRight');
    expect(radio('Groups').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('Groups'));
    expect(mockFetchPage).toHaveBeenCalledTimes(3); // All, Money, Groups
  });

  it('focus stays on the chip while the new chip is still loading', async () => {
    let resolve!: (v: unknown) => void;
    mockFetchPage.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const all = radio('All');
    all.focus();
    await press(all, 'ArrowRight');
    // Mid-load: the spinner is up and focus is still on Money.
    expect(rnw.container.querySelector('[aria-label="Loading activity"]')).not.toBeNull();
    expect(document.activeElement).toBe(radio('Money'));
    await rnw.React.act(async () => resolve(emptyPage('0e000000-0000-4000-8000-000000000001')));
    await settle();
    expect(document.activeElement).toBe(radio('Money'));
  });
});
