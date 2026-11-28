// "Get the app" banner on the web app (components/AppBanner.tsx, mounted in app/_layout.tsx; logic in
// lib/appBanner.ts; decisions AB-1 … AB-11 in docs/decisions-to-review.md).
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useEffect } from 'react';
import { Linking, Platform, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import RootLayout from '@/app/_layout';

import { APP_BANNER_DISMISS_MS, APP_BANNER_DISMISSED_KEY } from '@/lib/appBanner';
import { PENDING_INVITE_KEY, savePendingInvite } from '@/lib/pendingInvite';
import { storage as realStorage } from '@/lib/storage';
import { space } from '@/lib/theme';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

// A phone with a notch: the top-level SafeAreaProvider (Expo Router's, which passes zero metrics in
// tests) reports a 47-pt top inset. Nested providers inherit their parent's insets as usual, so the
// banner's override below it is what screens read.
let mockTopInset = 47;
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual<typeof import('react-native-safe-area-context')>('react-native-safe-area-context');
  const { createElement, useContext } = jest.requireActual<typeof import('react')>('react');
  function SafeAreaProvider({ initialMetrics, ...props }: import('react-native-safe-area-context').SafeAreaProviderProps) {
    const parent = useContext(actual.SafeAreaInsetsContext);
    const metrics =
      parent === null
        ? { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: mockTopInset, right: 0, bottom: 34, left: 0 } }
        : initialMetrics;
    return createElement(actual.SafeAreaProvider, { ...props, initialMetrics: metrics });
  }
  return { ...actual, SafeAreaProvider };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;

const APP_DIR = './app';
const CODE = '0123456789abcdef0123';
const BILL = '11111111-1111-4111-8111-111111111111';
const IOS_URL = 'https://apps.apple.com/us/app/splitit/id1234567890';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.yashs3090.splitit';

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  desktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const LINE = 'SplitIt works best in the app';

// The test environment has no navigator or localStorage; each test installs the browser it needs.
const g = globalThis as { navigator?: unknown; localStorage?: unknown };
const originals = {
  navigator: Object.getOwnPropertyDescriptor(g, 'navigator'),
  localStorage: Object.getOwnPropertyDescriptor(g, 'localStorage'),
};
const local = new Map<string, string>();

function browser(userAgent: string, maxTouchPoints = 5) {
  jest.replaceProperty(Platform, 'OS', 'web');
  Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent, maxTouchPoints } });
}

function storeUrls(ios: string | undefined, android: string | undefined) {
  if (ios === undefined) delete process.env.EXPO_PUBLIC_IOS_APP_STORE_URL;
  else process.env.EXPO_PUBLIC_IOS_APP_STORE_URL = ios;
  if (android === undefined) delete process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL;
  else process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL = android;
}

const ORIGINAL_ENV = {
  ios: process.env.EXPO_PUBLIC_IOS_APP_STORE_URL,
  android: process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL,
};

let openURL: jest.SpiedFunction<typeof Linking.openURL>;

beforeEach(() => {
  mockTopInset = 47;
  storage.data.clear();
  local.clear();
  supabase.__setInitialSession(null);
  jest.clearAllMocks();
  supabase.__setRpc((fn) => (fn === 'join_bill' ? { data: BILL, error: null } : { data: null, error: null }));
  storeUrls(IOS_URL, PLAY_URL);
  Object.defineProperty(g, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
    },
  });
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  openURL.mockRestore();
  storeUrls(ORIGINAL_ENV.ios, ORIGINAL_ENV.android);
  for (const key of ['navigator', 'localStorage'] as const) {
    const original = originals[key];
    if (original) Object.defineProperty(g, key, original);
    else Reflect.deleteProperty(g, key);
  }
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('who sees it', () => {
  it('iPhone browser: shows the line, "Get the app" opens the App Store listing', async () => {
    browser(UA.iphone);
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText(LINE)).toBeTruthy();
    const get = screen.getByRole('button', { name: 'Get the app' });
    expect(get.props.accessibilityHint).toBe('Opens SplitIt in the App Store');
    expect(screen.getByLabelText('Get the SplitIt app')).toBeTruthy();
    await act(async () => fireEvent.press(get));
    expect(openURL).toHaveBeenCalledWith(IOS_URL);
  });

  it('Android browser: "Get the app" opens Google Play', async () => {
    browser(UA.android);
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    const get = await screen.findByRole('button', { name: 'Get the app' });
    expect(get.props.accessibilityHint).toBe('Opens SplitIt on Google Play');
    await act(async () => fireEvent.press(get));
    expect(openURL).toHaveBeenCalledWith(PLAY_URL);
  });

  it('a double tap opens the store once', async () => {
    browser(UA.iphone);
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    const get = await screen.findByRole('button', { name: 'Get the app' });
    await act(async () => {
      fireEvent.press(get);
      fireEvent.press(get);
    });
    expect(openURL).toHaveBeenCalledTimes(1);
  });

  it('desktop browser: no banner', async () => {
    browser(UA.desktop, 0);
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it.each(['ios', 'android'] as const)('native %s app: no banner, even with a phone user agent and store URLs', async (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent: UA.iphone, maxTouchPoints: 5 } });
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('native app: a bad store URL is ignored (only the web build validates it)', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    storeUrls('http://not-a-store.example', 'nope');
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
  });

  it('no store URLs configured (today): no banner on an iPhone or Android browser', async () => {
    storeUrls(undefined, undefined);
    for (const ua of [UA.iphone, UA.android]) {
      browser(ua);
      const { unmount } = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
      expect(await screen.findByText('Continue with Google')).toBeTruthy();
      expect(screen.queryByText(LINE)).toBeNull();
      unmount();
    }
  });

  it("only Google Play configured: an iPhone gets no banner (never the other platform's store)", async () => {
    storeUrls(undefined, PLAY_URL);
    browser(UA.iphone);
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe('dismissing', () => {
  it('"Continue on website" hides it, stores only a timestamp, and it stays hidden on the next visit', async () => {
    browser(UA.iphone);
    const first = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    const dismiss = await screen.findByRole('button', { name: 'Continue on website' });
    expect(dismiss.props.accessibilityHint).toBe('Hides this for 14 days');
    await act(async () => fireEvent.press(dismiss));
    expect(screen.queryByText(LINE)).toBeNull();
    expect([...local.keys()]).toEqual([APP_BANNER_DISMISSED_KEY]);
    expect(local.get(APP_BANNER_DISMISSED_KEY)).toMatch(/^\d+$/);
    // Dismissing doesn't navigate.
    expect(first.getPathname()).toBe('/sign-in');
    expect(openURL).not.toHaveBeenCalled();
    first.unmount();

    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('comes back once 14 days have passed', async () => {
    browser(UA.iphone);
    local.set(APP_BANNER_DISMISSED_KEY, String(Date.now() - APP_BANNER_DISMISS_MS));
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it('storage that throws (blocked): still hides for this visit', async () => {
    browser(UA.iphone);
    Object.defineProperty(g, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    const dismiss = await screen.findByRole('button', { name: 'Continue on website' });
    await act(async () => fireEvent.press(dismiss));
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe('the invite flow on a phone browser with the banner showing (never blocks joining, never navigates)', () => {
  beforeEach(() => browser(UA.iphone));

  it('signed out, /b/<code>: saves the invite and lands on sign-in with the banner above it', async () => {
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(storage.data.get(PENDING_INVITE_KEY)).toContain(CODE);
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
  });

  it('cold start after the web OAuth redirect (signed in, on /, invite saved): resumes to the bill', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await settle();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_bill')).toEqual([['join_bill', { p_code: CODE }]]);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('signed in, deep link /b/<code>: joins and opens the bill', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(screen.getByText(LINE)).toBeTruthy();
  });

  it('dismissing on the bill keeps the person on the bill', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Continue on website' })));
    await settle();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe('safe area (AB-11): the banner takes the top inset, the screens below do not add it again', () => {
  // A stand-in screen under the real root layout that reports what it reads. (The web SafeAreaView
  // pads from useSafeAreaInsets() too, so it follows the same value; Jest resolves the native one,
  // which measures natively, so it isn't checked here.)
  let probeMounts = 0;
  function Probe() {
    const insets = useSafeAreaInsets();
    useEffect(() => {
      probeMounts += 1;
    }, []);
    return <Text>{`top ${insets.top} bottom ${insets.bottom}`}</Text>;
  }
  const routes = { _layout: RootLayout, index: Probe };

  function barPaddingTop(): unknown {
    return StyleSheet.flatten(screen.getByLabelText('Get the SplitIt app').props.style).paddingTop;
  }

  it('banner shown: the bar pads for the 47-pt inset and the screen below reads top 0 (bottom kept)', async () => {
    browser(UA.iphone);
    renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('top 0 bottom 34')).toBeTruthy();
    // The bar's content starts below the status bar.
    expect(barPaddingTop()).toBe(47 + space.sm);
  });

  it('dismissing gives the top inset back to the screen, without remounting it or navigating', async () => {
    browser(UA.iphone);
    probeMounts = 0;
    const router = renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('top 0 bottom 34')).toBeTruthy();
    expect(probeMounts).toBe(1);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Continue on website' })));
    expect(screen.getByText('top 47 bottom 34')).toBeTruthy();
    expect(probeMounts).toBe(1);
    expect(router.getPathname()).toBe('/');
  });

  it.each([
    ['no store URLs (today)', () => storeUrls(undefined, undefined), UA.iphone],
    ['desktop browser', () => undefined, UA.desktop],
  ])('banner hidden (%s): the screen reads the full 47-pt inset', async (_name, setup, ua) => {
    setup();
    browser(ua, ua === UA.desktop ? 0 : 5);
    renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('top 47 bottom 34')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull();
  });

  it('no top inset: the bar keeps its own padding and the screen reads 0', async () => {
    mockTopInset = 0;
    browser(UA.iphone);
    renderRouter(routes, { initialUrl: '/' });
    expect(await screen.findByText('top 0 bottom 34')).toBeTruthy();
    expect(barPaddingTop()).toBe(space.sm);
  });
});
