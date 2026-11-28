// Home's Profile entry point and the "Add your Venmo" card: criteria 35–38 in
// docs/specs/2026-11-24-profile-venmo.md (Task 5; Q1 = Profile only, Q2 = option A).
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { savePendingInvite } from '@/lib/pendingInvite';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
let mockCodeCounter = 0;
jest.mock('expo-web-browser', () => ({
  ...jest.requireActual<typeof import('expo-web-browser')>('expo-web-browser'),
  openAuthSessionAsync: jest.fn(async (_url: string, redirectUrl: string) => ({
    type: 'success',
    url: `${redirectUrl}?code=fake-pkce-code-${++mockCodeCounter}`,
  })),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const ROUTES = './app';
const PROMPT = 'Add your Venmo so friends can pay you';
const CODE = '0123456789abcdef0123';
const BILL = '11111111-1111-4111-8111-111111111111';

/** Server-side state the fake RPCs and the profiles table share. */
const server: {
  pending: FakeResult | (() => Promise<FakeResult>);
  dismiss: FakeResult;
  venmo: string | null;
} = { pending: { data: true, error: null }, dismiss: { data: null, error: null }, venmo: null };

const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  supabase.__setInitialSession(fakeSession());
  server.pending = { data: true, error: null };
  server.dismiss = { data: null, error: null };
  server.venmo = null;
  supabase.__setRpc((fn) => {
    if (fn === 'venmo_prompt_pending') return typeof server.pending === 'function' ? server.pending() : server.pending;
    if (fn === 'dismiss_venmo_prompt') {
      if (!server.dismiss.error) server.pending = { data: false, error: null };
      return server.dismiss;
    }
    if (fn === 'join_bill') return { data: BILL, error: null };
    return { data: null, error: null };
  });
  // Profile reads and saves; a save answers the prompt (the DB trigger), so pending turns false.
  supabase.__setTable('profiles', (q) => {
    if (q.calls[0]?.method === 'update') {
      server.venmo = (q.calls[0].args[0] as { venmo_username: string | null }).venmo_username;
      if (server.venmo !== null) server.pending = { data: false, error: null };
      return { data: [{ venmo_username: server.venmo }], error: null };
    }
    return { data: { display_name: 'Ada L.', venmo_username: server.venmo }, error: null };
  });
});

async function openHome() {
  const router = renderRouter(ROUTES, { initialUrl: '/' });
  await screen.findByRole('header', { name: 'SplitIt' });
  return router;
}
async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

describe('home: Profile entry point (Q1: sign out on Profile only)', () => {
  it('35: a labelled "Profile" control (the Profile tab) opens /profile; home has no "Sign out"', async () => {
    const router = await openHome();
    expect(screen.queryByText('Sign out')).toBeNull();
    // Tab-bar spec Contract C: a tab's label is all it says (react-native-web drops hints); it's a tab.
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeTruthy();
    await press('Profile');
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    expect(await screen.findByText('Sign out')).toBeTruthy();
  });
});

describe('home: the Venmo card (Q2 option A)', () => {
  it('36: pending → the card shows with "Add Venmo" and "Not now"', async () => {
    await openHome();
    expect(await screen.findByText(PROMPT)).toBeTruthy();
    expect(screen.getByLabelText('Add Venmo').props.accessibilityHint).toBe('Opens your profile');
    expect(screen.getByLabelText('Not now').props.accessibilityHint).toBeTruthy();
    expect(rpcCalls('venmo_prompt_pending')).toHaveLength(1);
  });

  it('36: "Not now" calls dismiss_venmo_prompt and hides the card', async () => {
    await openHome();
    await screen.findByText(PROMPT);
    await press('Not now');
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(rpcCalls('dismiss_venmo_prompt')).toEqual([['dismiss_venmo_prompt']]);
  });

  it('36: "Not now" hides the card even when the call fails, and it stays hidden on return to home', async () => {
    server.dismiss = { data: null, error: { code: '08006', message: 'connection' } };
    await openHome();
    await screen.findByText(PROMPT);
    await press('Not now');
    expect(screen.queryByText(PROMPT)).toBeNull();

    // Leave and come back: the server still says pending, but the user already said "Not now" here.
    // Tab-bar spec Task 5: Profile is a tab; Home stays mounted and is focused again from the Tabs tab.
    await press('Profile');
    await screen.findByLabelText('Venmo username');
    await press('Tabs');
    await screen.findByRole('header', { name: 'SplitIt' });
    await waitFor(() => expect(rpcCalls('venmo_prompt_pending').length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it.each<[string, FakeResult | (() => Promise<FakeResult>)]>([
    ['false', { data: false, error: null }],
    ['an error', { data: null, error: { code: '42501', message: 'denied' } }],
    ['a thrown request', () => Promise.reject(new Error('network'))],
  ])('36: %s → no card', async (_name, result) => {
    server.pending = result;
    await openHome();
    await waitFor(() => expect(rpcCalls('venmo_prompt_pending')).toHaveLength(1));
    // Let the check settle before asserting nothing appeared.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('"Add Venmo" opens Profile (/account, above the tabs); after a save, back on home the card is gone (re-checked on focus)', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openHome();
    await screen.findByText(PROMPT);
    await press('Add Venmo');
    // Tab-bar spec criterion 41: Profile with a Back, so one Back returns to Home.
    await waitFor(() => expect(router.getPathname()).toBe('/account'));
    expect(push).toHaveBeenCalledWith('/account'); // the spy sees the card's navigation (used by R1 below)
    expect(rpcCalls('dismiss_venmo_prompt')).toHaveLength(0); // opening Profile isn't an answer

    fireEvent.changeText(await screen.findByLabelText('Venmo username'), '@ada-pays');
    await press('Save Venmo username');
    await screen.findByText('Saved');
    await press('Back');

    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await waitFor(() => expect(rpcCalls('venmo_prompt_pending')).toHaveLength(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('a re-check that lands after "Not now" does not bring the card back', async () => {
    await openHome();
    await screen.findByText(PROMPT);

    // Go to Profile and back; hold the focus re-check so "Not now" lands before its answer.
    let release: () => void = () => {};
    server.pending = () =>
      new Promise<FakeResult>((resolve) => {
        release = () => resolve({ data: true, error: null });
      });
    // Tab-bar spec Task 5: Profile is a tab; Home stays mounted and is focused again from the Tabs tab.
    await press('Profile');
    await screen.findByLabelText('Venmo username');
    await press('Tabs');
    await screen.findByRole('header', { name: 'SplitIt' });
    await waitFor(() => expect(rpcCalls('venmo_prompt_pending')).toHaveLength(2));

    expect(screen.getByText(PROMPT)).toBeTruthy(); // still shown from before
    await press('Not now');
    await act(async () => {
      release();
    });
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('37: with the prompt pending and an invite saved, signing in still lands on the bill', async () => {
    supabase.__setInitialSession(null);
    await savePendingInvite(storage, CODE, Date.now());
    const router = renderRouter(ROUTES, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));

    await act(async () => {
      fireEvent.press(await screen.findByText('Continue with Google'));
    });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled();

    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(rpcCalls('venmo_prompt_pending')).toHaveLength(0); // home never mounted on the way
    expect(rpcCalls('dismiss_venmo_prompt')).toHaveLength(0);
  });

  // R1: home *does* mount here (the app opens on /), so the card's check can run before the
  // resume effect replaces the route with the invite. It must not interrupt or answer anything.
  describe.each(['native', 'web'] as const)('37 (%s): prompt pending + pending invite, app opened on /', (platform) => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('resumes to the bill; the card is gone, nothing dismissed, nothing pushed /profile or /account', async () => {
      if (platform === 'web') jest.replaceProperty(Platform, 'OS', 'web');
      const push = jest.spyOn(globalRouter, 'push');
      supabase.__setInitialSession(fakeSession());
      await savePendingInvite(storage, CODE, Date.now());
      server.pending = { data: true, error: null };

      const router = renderRouter(ROUTES, { initialUrl: '/' });

      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
      // Let any check started by a brief home mount settle before asserting it changed nothing.
      await act(async () => {
        await Promise.resolve();
      });
      expect(router.getPathname()).toBe(`/bills/${BILL}`);
      expect(screen.queryByText(PROMPT)).toBeNull();
      expect(rpcCalls('dismiss_venmo_prompt')).toHaveLength(0);
      expect(push).not.toHaveBeenCalledWith('/profile');
      expect(push).not.toHaveBeenCalledWith('/account');
      expect(push.mock.calls.some(([href]) => /profile|account/.test(String(href)))).toBe(false);
    });
  });
});
