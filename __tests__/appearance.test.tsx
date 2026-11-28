// Appearance (Auto / Light / Dark): chosen on the "Add your Venmo" card on Home (first run) and on
// Profile; applied at once, saved on this device (no database), and the same choice everywhere.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactElement } from 'react';
import { Platform, StyleSheet } from 'react-native';

import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import {
  APPEARANCE_COPY,
  getThemePreference,
  resetThemePreferenceForTests,
  THEME_PREFERENCE_KEY,
  THEME_PREFERENCE_OPTIONS,
  type ThemePreference,
} from '@/lib/themePreference';
import { fakeSession, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
// The device is in light mode throughout, so a dark screen can only come from the choice.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => 'light' }));

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const PROMPT = 'Add your Venmo so friends can pay you';
const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);
const server = { pending: true };

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  resetThemePreferenceForTests();
  supabase.__queries.length = 0;
  supabase.__setInitialSession(fakeSession());
  server.pending = true;
  supabase.__setRpc((fn) => {
    if (fn === 'venmo_prompt_pending') return { data: server.pending, error: null };
    if (fn === 'dismiss_venmo_prompt') {
      server.pending = false;
      return { data: null, error: null };
    }
    if (fn === 'people_i_split_with') return { data: [], error: null };
    return { data: null, error: null };
  });
  supabase.__setTable('profiles', () => ({ data: { display_name: 'Ada L.', venmo_username: null }, error: null }));
});

type Node = { props: { style?: unknown }; parent: Node | null };
/** The nearest ancestor that paints a background: the screen behind this element. */
function paintedBackground(node: unknown): unknown {
  for (let n: Node | null = (node as Node).parent; n; n = n.parent) {
    const bg = (StyleSheet.flatten(n.props.style as never) as { backgroundColor?: unknown } | undefined)?.backgroundColor;
    if (bg !== undefined) return bg;
  }
  return undefined;
}

const radio = (name: string) => screen.getByRole('radio', { name });
// A radiogroup View isn't itself focusable, so role queries skip it; find it by its props.
const group = () => screen.UNSAFE_queryByProps({ accessibilityRole: 'radiogroup', accessibilityLabel: 'Appearance' });
const isChecked = (name: string) => radio(name).props.accessibilityState?.checked === true;
async function choose(name: string) {
  await act(async () => {
    fireEvent.press(radio(name));
  });
}
async function openProfile() {
  const router = renderRouter('./app', { initialUrl: '/profile' });
  await screen.findByLabelText('Venmo username');
  return router;
}
async function openHomeWithCard() {
  const router = renderRouter('./app', { initialUrl: '/' });
  await screen.findByText(PROMPT);
  return router;
}

describe('Profile: the Appearance row', () => {
  it('is a labelled radio group, Auto / Light / Dark, with Auto chosen by default', async () => {
    await openProfile();
    expect(group()).toBeTruthy();
    expect(['Auto', 'Light', 'Dark'].map(isChecked)).toEqual([true, false, false]);
    expect(screen.getByText("Auto follows your phone's setting.")).toBeTruthy();
  });

  it('Dark applies at once (the device is light) and is saved on the device; Light and Auto go back', async () => {
    await openProfile();
    const title = () => screen.getByRole('header', { name: 'Profile' });
    expect(paintedBackground(title())).toBe(colors.light.background);

    await choose('Dark');
    expect(isChecked('Dark')).toBe(true);
    expect(paintedBackground(title())).toBe(colors.dark.background);
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('dark');

    await choose('Light');
    expect(paintedBackground(title())).toBe(colors.light.background);
    await choose('Auto');
    expect(paintedBackground(title())).toBe(colors.light.background);
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('system');
  });

  it('writes nothing to the database', async () => {
    await openProfile();
    await choose('Dark');
    expect(supabase.__queries.filter((q) => q.calls.some((c) => c.method === 'update' || c.method === 'insert' || c.method === 'upsert'))).toHaveLength(0);
    expect(rpcCalls('dismiss_venmo_prompt')).toHaveLength(0);
  });

  it('persists across a remount and a relaunch (the stored value is read again)', async () => {
    const first = await openProfile();
    await choose('Dark');
    first.unmount();

    // A relaunch: the in-memory choice is gone; only the device storage remembers it.
    resetThemePreferenceForTests();
    await openProfile();
    await waitFor(() => expect(isChecked('Dark')).toBe(true));
    expect(paintedBackground(screen.getByRole('header', { name: 'Profile' }))).toBe(colors.dark.background);
  });

  it('stays after sign-out (it belongs to the device, not the person)', async () => {
    const router = await openProfile();
    await choose('Dark');
    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(getThemePreference()).toBe('dark');
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('dark');
  });

  it('shows while the profile is still loading or failed to load', async () => {
    supabase.__setTable('profiles', () => ({ data: null, error: { code: '08006', message: 'connection' } }));
    renderRouter('./app', { initialUrl: '/profile' });
    await screen.findByText("Couldn't load your profile.");
    expect(group()).toBeTruthy();
  });
});

describe('Home: the Appearance choice on the "Add your Venmo" card', () => {
  it('shows the same choice inside the card', async () => {
    await openHomeWithCard();
    expect(group()).toBeTruthy();
    expect(isChecked('Auto')).toBe(true);
  });

  it('applies and saves at once, separately from Venmo: the card stays, nothing is dismissed', async () => {
    await openHomeWithCard();
    const prompt = () => screen.getByText(PROMPT);
    expect(paintedBackground(prompt())).toBe(colors.light.surfaceMuted); // the muted card
    await choose('Dark');
    expect(paintedBackground(prompt())).toBe(colors.dark.surfaceMuted);
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('dark');
    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(rpcCalls('dismiss_venmo_prompt')).toHaveLength(0);
  });

  it('does not keep the card alive: "Not now" hides it with the choice kept', async () => {
    await openHomeWithCard();
    await choose('Dark');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Not now'));
    });
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(group()).toBeNull();
    expect(getThemePreference()).toBe('dark');
  });

  it('once Venmo is set (not pending), there is no card and no choice on Home', async () => {
    server.pending = false;
    renderRouter('./app', { initialUrl: '/' });
    await screen.findByRole('header', { name: 'SplitIt' });
    await waitFor(() => expect(rpcCalls('venmo_prompt_pending')).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(group()).toBeNull();
  });

  it('one choice: picked on the card, Profile shows it', async () => {
    await openHomeWithCard();
    await choose('Light');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Profile'));
    });
    await screen.findByLabelText('Venmo username');
    expect(isChecked('Light')).toBe(true);
  });
});

describe.each(['ios', 'web'] as const)('on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('the choice applies and is saved', async () => {
    await openProfile();
    await choose('Dark');
    expect(isChecked('Dark')).toBe(true);
    expect(paintedBackground(screen.getByRole('header', { name: 'Profile' }))).toBe(colors.dark.background);
    expect(storage.data.get(THEME_PREFERENCE_KEY)).toBe('dark');
  });
});

// The browser reads aria-*, not accessibilityState (lesson 2026-11-27): the chooser both screens draw
// (the same options and group label) renders as a labelled radiogroup with aria-checked.
it('on web the DOM is a labelled radiogroup with aria-checked and one tab stop', () => {
  let html = '';
  jest.isolateModules(() => {
    jest.doMock('react-native', () => jest.requireActual('react-native-web'));
    jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
    const React = jest.requireActual<typeof import('react')>('react');
    // @types/react-dom isn't installed; this is the one function used.
    const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
    const { SegmentedControl } = jest.requireActual<typeof import('@/components/ui/SegmentedControl')>('@/components/ui/SegmentedControl');
    html = renderToStaticMarkup(
      React.createElement(SegmentedControl<ThemePreference>, {
        options: THEME_PREFERENCE_OPTIONS,
        value: 'dark',
        onChange: () => {},
        semantics: 'radio',
        groupLabel: APPEARANCE_COPY.label,
      }),
    );
  });
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('aria-label="Appearance"');
  expect(html.match(/role="radio"/g)).toHaveLength(3);
  // The radios in order (Auto, Light, Dark): only the third, Dark, is checked.
  const radios = (html.match(/<[a-z]+ [^>]*role="radio"[^>]*>/g) ?? []).map((t) => t.includes('aria-checked="true"'));
  expect(radios).toEqual([false, false, true]);
  expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
  expect(html.match(/tabindex="0"/g)).toHaveLength(1);
});
