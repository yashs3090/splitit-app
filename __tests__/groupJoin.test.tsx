// /g/<code>: joining a group by link or QR. docs/specs/2026-11-26-groups-mvp.md T13, criterion 64
// (every entry route, native and web, including the web OAuth landing on `/`), GR-29.
// The group screen (/groups/<id>) is T14's; these tests stop at its pathname.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { PENDING_INVITE_KEY, savePendingGroupInvite, savePendingInvite } from '@/lib/pendingInvite';
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

const CODE = '0123456789abcdef0123';
const GROUP = '9a000000-0000-4000-8000-000000000001';
const BILL_CODE = 'fedcba9876543210fedc';
const SERVER_TEXT = 'secret_internal_name for ada@example.com';

const joins = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_group');
const pending = () => storage.data.get(PENDING_INVITE_KEY) ?? null;

function joinReturns(result: () => FakeResult | Promise<FakeResult>) {
  supabase.__setRpc((fn) => (fn === 'join_group' ? result() : { data: null, error: null }));
}

async function pressContinueWithGoogle() {
  const button = await screen.findByText('Continue with Google');
  await act(async () => {
    fireEvent.press(button);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__setInitialSession(null);
  joinReturns(() => ({ data: GROUP, error: null }));
});

describe.each(['ios', 'web'] as const)('/g/<code> on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('signed out: saves g-<code>, goes to sign-in, and joins nothing', async () => {
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(JSON.parse(pending() ?? '{}')).toMatchObject({ code: `g-${CODE}` });
    expect(joins()).toHaveLength(0);
  });

  it('signed in: joins once and replaces itself with the group', async () => {
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
    expect(pending()).toBeNull();
  });

  it('cold start already signed in with a stored group invite, landing on / (the web OAuth redirect): resumes, joins once', async () => {
    await savePendingGroupInvite(storage, CODE, Date.now());
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter('./app', { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
    expect(pending()).toBeNull();
  });

  it('a stored invite past its 24 hours is dropped: / stays home and nothing is joined', async () => {
    await savePendingGroupInvite(storage, CODE, Date.now() - 25 * 60 * 60 * 1000);
    supabase.__setInitialSession(fakeSession());
    const router = renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.getPathname()).toBe('/');
    expect(joins()).toHaveLength(0);
  });

  it('a newer group invite replaces an older bill invite (one pending invite, the newest wins)', async () => {
    await savePendingInvite(storage, BILL_CODE, Date.now());
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(JSON.parse(pending() ?? '{}')).toMatchObject({ code: `g-${CODE}` });
  });
});

describe('/g/<code>: signing in on the way', () => {
  it('native: signed out → sign-in → Google → the resume effect lands on /g/<code>, which joins and lands on the group', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    await pressContinueWithGoogle();
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
    expect(pending()).toBeNull();
  });

  it('web: signed out → sign-in; Google redirects back to / signed in → resume → join → group; Home on the way never navigates', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const first = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    await waitFor(() => expect(first.getPathname()).toBe('/sign-in'));
    expect(pending()).toContain(`g-${CODE}`);
    first.unmount();

    supabase.__setInitialSession(fakeSession());
    const router = renderRouter('./app', { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
    expect(pending()).toBeNull();
  });

  it('the native OAuth callback with a stored group invite resumes to the group', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await savePendingGroupInvite(storage, CODE, Date.now());
    const router = renderRouter('./app', { initialUrl: '/auth/callback?code=callback-code-1' });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
  });
});

describe('/g/<code>: states', () => {
  beforeEach(() => supabase.__setInitialSession(fakeSession()));

  it('someone already in the group just lands on it (join_group is idempotent)', async () => {
    // The database returns the same id for a member; there is no separate "already a member" screen.
    const router = renderRouter('./app', { initialUrl: `/g/${CODE.toUpperCase()}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toEqual([['join_group', { p_code: CODE }]]);
  });

  it('shows a spinner while joining, then lands', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    joinReturns(() => new Promise<FakeResult>((r) => (resolve = r)));
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    expect(await screen.findByLabelText('Joining the group')).toBeTruthy();
    await act(async () => resolve({ data: GROUP, error: null }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toHaveLength(1);
  });

  it('a rotated or unknown code (P0002): fixed copy, "Go home", no retry, code never shown', async () => {
    joinReturns(() => ({ data: null, error: { code: 'P0002', message: 'invalid_code' } }));
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    expect(await screen.findByText("This link doesn't work anymore. Ask for a new one.")).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.queryByText(new RegExp(CODE))).toBeNull();
    fireEvent.press(screen.getByText('Go home'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('a full group (22023 group_full): fixed copy and "Go home"', async () => {
    joinReturns(() => ({ data: null, error: { code: '22023', message: 'group_full' } }));
    renderRouter('./app', { initialUrl: `/g/${CODE}` });
    expect(await screen.findByText('This group is full (50 people).')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
    expect(screen.getByText('Go home')).toBeTruthy();
  });

  it('a failed join shows "Try again" (no server text); retrying joins again and lands', async () => {
    let fail = true;
    joinReturns(() => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: GROUP, error: null }));
    const router = renderRouter('./app', { initialUrl: `/g/${CODE}` });
    expect(await screen.findByText("Couldn't join the group. Try again.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    fail = false;
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP}`));
    expect(joins()).toHaveLength(2);
  });

  it('a malformed code: "isn\'t valid", no call, nothing stored (signed in)', async () => {
    renderRouter('./app', { initialUrl: '/g/not-a-code' });
    expect(await screen.findByText("This invite link isn't valid.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go home' })).toBeTruthy();
    expect(screen.queryByText(/not-a-code/)).toBeNull();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_group')).toHaveLength(0);
  });

  it('a malformed code signed out: stays put, stores nothing', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter('./app', { initialUrl: '/g/not-a-code' });
    expect(await screen.findByText("This invite link isn't valid.")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.getPathname()).toBe('/g/not-a-code');
    expect(storage.data.size).toBe(0);
  });
});
