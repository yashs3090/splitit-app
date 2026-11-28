import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { PENDING_INVITE_KEY, savePendingInvite } from '@/lib/pendingInvite';
import { storage as realStorage } from '@/lib/storage';
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
// Each auth session returns a fresh code: codes are single-use and exchangeCodeOnce dedupes them.
let mockCodeCounter = 0;
jest.mock('expo-web-browser', () => ({
  ...jest.requireActual<typeof import('expo-web-browser')>('expo-web-browser'),
  openAuthSessionAsync: jest.fn(async (_url: string, redirectUrl: string) => ({
    type: 'success',
    url: `${redirectUrl}?code=fake-pkce-code-${++mockCodeCounter}`,
  })),
}));

// The mocks above replace these modules; cast to the fakes' types to drive them.
const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;

// A real join code (20 lowercase hex), so join_bill is called; the M0 stub accepted any code.
const CODE = '0123456789abcdef0123';
const BILL = '11111111-1111-4111-8111-111111111111';

/** join_bill was called exactly once, with this code. */
function expectJoinedOnce() {
  const joins = supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_bill');
  expect(joins).toEqual([['join_bill', { p_code: CODE }]]);
}
const APP_DIR = './app';

function pendingInvite(): { code: string; savedAt: number } | null {
  const raw = storage.data.get(PENDING_INVITE_KEY);
  return raw ? (JSON.parse(raw) as { code: string; savedAt: number }) : null;
}

async function pressContinueWithGoogle() {
  const button = await screen.findByText('Continue with Google');
  await act(async () => {
    fireEvent.press(button);
  });
}

beforeEach(() => {
  storage.data.clear();
  supabase.__setInitialSession(null);
  jest.clearAllMocks();
  supabase.__setRpc((fn) => (fn === 'join_bill' ? { data: BILL, error: null } : { data: null, error: null }));
});

describe('invite flow', () => {
  it('22: signed out, /b/<code> saves the invite and ends on /sign-in', async () => {
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(pendingInvite()).toMatchObject({ code: CODE });
    expect(screen.getByText('Continue with Google')).toBeTruthy();
  });

  it('23: signing in with a pending invite joins the bill, lands on it, and clears the invite', async () => {
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(pendingInvite()).not.toBeNull();

    await pressContinueWithGoogle();

    expect(supabase.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: expect.stringContaining('auth/callback'), skipBrowserRedirect: true },
    });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled();
    expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith(expect.stringMatching(/^fake-pkce-code-\d+$/));

    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expectJoinedOnce();
    expect(pendingInvite()).toBeNull();
  });

  it('24: signed out, /b/bad shows the invalid message, stores nothing, and stays put', async () => {
    const router = renderRouter(APP_DIR, { initialUrl: '/b/bad' });
    expect(await screen.findByText(/This invite link isn.t valid/)).toBeTruthy();
    // Styled like a button, but still a link (visual pass V3).
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    // Let any pending effects settle before asserting nothing happened.
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.getPathname()).toBe('/b/bad');
    expect(storage.data.size).toBe(0);
  });

  it('25: signed out, / redirects to /sign-in; signing in with no invite lands on home (its "SplitIt" heading, after the path is /; "Signed in as" was dropped by P4)', async () => {
    const router = renderRouter(APP_DIR, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(screen.queryByPlaceholderText(/email/i)).toBeNull();

    await pressContinueWithGoogle();

    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
  });

  it('26: sign-out (on Profile, opened from home) clears the session and any pending invite', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: '/' });
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
    // Sign out lives on Profile only (docs/specs/2026-11-24-profile-venmo.md, Q1).
    expect(screen.queryByText('Sign out')).toBeNull();
    const profile = screen.getByLabelText('Profile');
    await act(async () => {
      fireEvent.press(profile);
    });
    expect(await screen.findByText('Sign out')).toBeTruthy();

    // An invite saved by some other path must not survive sign-out.
    await savePendingInvite(storage, CODE, Date.now());
    expect(pendingInvite()).not.toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });

    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(pendingInvite()).toBeNull();
    const { data } = await supabase.auth.getSession();
    expect(data.session).toBeNull();
  });

  it('a signed-in user opening /b/<code> joins and lands on the bill', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expectJoinedOnce();
  });

  it('cold start: a stored invite resumes when the app loads already signed in (web OAuth landing on /)', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expectJoinedOnce();
    expect(pendingInvite()).toBeNull();
  });

  it('a signed-in user visiting /sign-in is sent home', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
  });

  it('a cancelled Google sign-in shows an error and stays on /sign-in', async () => {
    jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({ type: WebBrowser.WebBrowserResultType.CANCEL });
    const router = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    await pressContinueWithGoogle();
    expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy();
    expect(router.getPathname()).toBe('/sign-in');
    expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('unsubscribes from auth changes on unmount', async () => {
    const view = renderRouter(APP_DIR, { initialUrl: '/sign-in' });
    await screen.findByText('Continue with Google');
    expect(supabase.__listenerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(supabase.__listenerCount()).toBe(0);
  });

  describe('native OAuth callback route (/auth/callback)', () => {
    it('signed out with a pending invite: exchanges the code once and resumes to the invite', async () => {
      await savePendingInvite(storage, CODE, Date.now());
      const router = renderRouter(APP_DIR, { initialUrl: '/auth/callback?code=callback-code-1' });

      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
      expectJoinedOnce();
      expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
      expect(supabase.auth.exchangeCodeForSession).toHaveBeenCalledWith('callback-code-1');
      expect(pendingInvite()).toBeNull();
    });

    it('signed out with no pending invite: lands on home after the exchange', async () => {
      const router = renderRouter(APP_DIR, { initialUrl: '/auth/callback?code=callback-code-2' });
      await waitFor(() => expect(router.getPathname()).toBe('/'));
      expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
    });

    it('does not exchange again when already signed in, and goes home', async () => {
      supabase.__setInitialSession(fakeSession());
      const router = renderRouter(APP_DIR, { initialUrl: '/auth/callback?code=callback-code-3' });
      await waitFor(() => expect(router.getPathname()).toBe('/'));
      expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    });

    it('signed out with no code goes to sign-in', async () => {
      const router = renderRouter(APP_DIR, { initialUrl: '/auth/callback' });
      await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
      expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    });

    it('shows an error from the callback without exchanging', async () => {
      renderRouter(APP_DIR, { initialUrl: '/auth/callback?error=server_error' });
      expect(await screen.findByText('Google sign-in failed (server_error). Please try again.')).toBeTruthy();
      expect(supabase.auth.exchangeCodeForSession).not.toHaveBeenCalled();
      expect(screen.getByRole('link', { name: 'Back to sign-in' })).toBeTruthy();
    });
  });

  describe('web OAuth error on the landing URL', () => {
    const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

    afterEach(() => {
      if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
      else Reflect.deleteProperty(window, 'location');
    });

    it('shows the error on /sign-in after Google redirects back with ?error=server_error', async () => {
      jest.replaceProperty(Platform, 'OS', 'web');
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { href: 'http://localhost:8081/?error=server_error', origin: 'http://localhost:8081' },
      });

      const router = renderRouter(APP_DIR, { initialUrl: '/?error=server_error' });
      await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
      expect(await screen.findByText('Google sign-in failed (server_error). Please try again.')).toBeTruthy();
    });
  });
});
