/**
 * @jest-environment jsdom
 */
// The tab bar on web, rendered with react-native-web into jsdom (react-dom): the DOM a browser gets.
// - WCAG 2.1.1 (QA): each tab is a <div role="link" tabindex="0"> with no href. react-native-web
//   leaves Enter on a link to the browser, which follows only an href, so Enter did nothing. Enter
//   and Space now activate the tab. The (+) is a real <button>, which the browser activates itself.
// - Criterion 52 (QA): at 188 CSS px the labels cut off and the (+) overlapped its neighbours. Below
//   300 px the bar is compact: icons only, screen-reader labels unchanged, a 44-pt (+).
//
// The bar is given a navigator's props by hand (state, descriptors, navigation): a tab press emits
// `tabPress` and then calls navigation.navigate(name). That a navigate to 'groups' lands on /groups
// is covered through the real router in __tests__/tabBar.test.tsx (criteria 27–34, web and native).
import type { ReactElement } from 'react';

const mockPush = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: {} }));
// lib/theme.ts reads the Appearance choice, which loads lib/storage; keep it in memory.
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: () => void | (() => void)) => React.useEffect(cb, [cb]),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

type Nav = { emit: jest.Mock; navigate: jest.Mock };
type Mounted = { container: HTMLElement; nav: Nav; unmount: () => void };

const ROUTES = ['index', 'groups', 'activity', 'profile'].map((name) => ({ key: `${name}-key`, name, params: undefined }));

let React!: typeof import('react');
let mount!: (focused?: number) => Mounted;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; these are the two functions used.
    const { createRoot } = jest.requireActual<{
      createRoot: (el: HTMLElement) => { render: (n: ReactElement) => void; unmount: () => void };
    }>('react-dom/client');
    const { TabBar } = jest.requireActual<typeof import('@/components/TabBar')>('@/components/TabBar');
    mount = (focused = 0) => {
      const nav: Nav = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() };
      const props = {
        state: { index: focused, routes: ROUTES, key: 'tabs', routeNames: ROUTES.map((r) => r.name), type: 'tab', stale: false, history: [] },
        descriptors: Object.fromEntries(ROUTES.map((r) => [r.key, { options: {} }])),
        navigation: nav,
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      // A navigator's props by hand (see the header); the bar reads only these fields.
      React.act(() => root.render(React.createElement(TabBar, props as unknown as Parameters<typeof TabBar>[0])));
      return {
        container,
        nav,
        unmount: () => {
          React.act(() => root.unmount());
          container.remove();
        },
      };
    };
  });
});

/** Sets the width react-native-web reads (jsdom has no visualViewport; it falls back to clientWidth). */
function setWindowWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  React.act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

const tab = (c: HTMLElement, label: string): HTMLElement => {
  const found = c.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no ${label} in ${c.innerHTML}`);
  return found;
};
const ADD = 'Add receipt, opens a photo or typing the items';
const press = (el: HTMLElement, key: string, repeat = false) => {
  React.act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  });
};

let m: Mounted;
beforeEach(() => {
  mockPush.mockReset();
  setWindowWidth(375);
});
afterEach(() => m.unmount());

describe('tab bar on web: the keyboard activates tabs (WCAG 2.1.1)', () => {
  it('positive control: the tabs are focusable links with no href, the selected one aria-current', () => {
    m = mount(0);
    const groups = tab(m.container, 'Groups');
    expect(groups.getAttribute('role')).toBe('link');
    expect(groups.getAttribute('tabindex')).toBe('0');
    expect(groups.hasAttribute('href')).toBe(false);
    expect(tab(m.container, 'Tabs').getAttribute('aria-current')).toBe('page');
    expect(groups.hasAttribute('aria-current')).toBe(false);
  });

  it.each([['Enter'], [' ']])('%p on the focused Groups tab goes to Groups, once', (key) => {
    m = mount(0);
    const groups = tab(m.container, 'Groups');
    React.act(() => groups.focus());
    expect(document.activeElement).toBe(groups);
    press(groups, key);
    expect(m.nav.emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'groups-key', canPreventDefault: true });
    expect(m.nav.navigate).toHaveBeenCalledTimes(1);
    expect(m.nav.navigate).toHaveBeenCalledWith('groups', undefined);
  });

  it('Space does not scroll the page; a held key (repeat) does not fire again; other keys do nothing', () => {
    m = mount(0);
    const groups = tab(m.container, 'Groups');
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    React.act(() => {
      groups.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(true);
    m.nav.navigate.mockClear();
    press(groups, 'Enter', true);
    press(groups, 'a');
    press(groups, 'Tab');
    expect(m.nav.navigate).not.toHaveBeenCalled();
  });

  it('Enter on the already-selected tab emits tabPress but does not navigate', () => {
    m = mount(1);
    press(tab(m.container, 'Groups'), 'Enter');
    expect(m.nav.emit).toHaveBeenCalledTimes(1);
    expect(m.nav.navigate).not.toHaveBeenCalled();
  });

  it('the (+) is a native <button>, so the browser turns Enter and Space into its click, which opens /scan', () => {
    m = mount(0);
    const add = tab(m.container, ADD);
    // jsdom doesn't turn Enter / Space on a <button> into a click (a browser does), so the click is
    // dispatched here. The tag is what makes the browser do it.
    expect(add.tagName).toBe('BUTTON');
    React.act(() => add.focus());
    React.act(() => {
      add.click();
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/scan');
  });

  it("the tabs aren't <button>s or <a>s, which is why they need their own key handling", () => {
    m = mount(0);
    expect(tab(m.container, 'Groups').tagName).toBe('DIV');
  });
});

describe('tab bar on web: narrow widths (criterion 52)', () => {
  const visibleText = (c: HTMLElement) => c.textContent ?? '';
  const addSize = (c: HTMLElement) => tab(c, ADD).style.width;

  it('at 375 px: the labels show and the (+) is 56', () => {
    m = mount(0);
    expect(visibleText(m.container)).toBe('TabsGroupsActivityProfile');
    expect(addSize(m.container)).toBe('56px');
  });

  it.each([188, 160])('at %i px: no visible labels, the same screen-reader labels, a 44 (+), and Enter still works', (w) => {
    setWindowWidth(w);
    m = mount(0);
    expect(visibleText(m.container)).toBe('');
    for (const label of ['Tabs', 'Groups', 'Activity', 'Profile', ADD]) expect(tab(m.container, label)).toBeTruthy();
    expect(addSize(m.container)).toBe('44px');
    press(tab(m.container, 'Groups'), 'Enter');
    expect(m.nav.navigate).toHaveBeenCalledWith('groups', undefined);
  });
});
