// "Choose your username" gate (docs/specs/2026-11-28-usernames.md A3.6–A3.10): router tests through the
// whole app (root layout and its resume effect, the (app) layout's gate, the tabs), on native and with
// Platform.OS = 'web'. The real lib/useUsernameStatus and lib/profile run against the fake Supabase
// (test-utils/jestSetup.ts mocks the hook as "locked" for every other suite).
//
// Stand-ins: the bill screen (its own tests cover it; here only that it shows, and where Back goes).
import { router as globalRouter, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { BackHandler, Platform, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { savePendingInvite } from '@/lib/pendingInvite';
import { resetResumeGateForTests } from '@/lib/resumeGate';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { resetUsernameStatusForTests } from '@/lib/useUsernameStatus';
import { USERNAME_ERROR_COPY, USERNAME_GATE_COPY as COPY } from '@/lib/username';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';
import { TAB_BAR_TEST_ID, tabNamed } from '@/test-utils/tabBar';

jest.unmock('@/lib/useUsernameStatus');
jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
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
    url: `${redirectUrl}?code=username-pkce-${++mockCodeCounter}`,
  })),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;

const BILL = '11111111-1111-4111-8111-111111111111';
const CODE = '0123456789abcdef0123';
const PROVISIONAL = 'ana';

function BillStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill stand-in ${id}`}</Text>;
}
const ROUTES = { appDir: './app', overrides: { '(app)/bills/[id]/index': BillStandIn } };

/** The server's side of the username: what my_username_status says, and how set_username answers. */
type Server = {
  username: string;
  locked: boolean;
  /** Fail the status read this many more times. */
  statusFailures: number;
  /** How set_username answers; null = success (stores and locks). */
  setError: { code: string; message: string } | null;
  /** Of the candidates sent, the ones usernames_available reports free. */
  free: (candidate: string) => boolean;
  venmoPending: boolean;
};
let server: Server;

const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

beforeEach(() => {
  jest.clearAllMocks();
  resetResumeGateForTests();
  resetUsernameStatusForTests();
  storage.data.clear();
  supabase.__setInitialSession(fakeSession('Ana'));
  server = { username: PROVISIONAL, locked: false, statusFailures: 0, setError: null, free: () => true, venmoPending: false };
  supabase.__setRpc((fn, args) => {
    if (fn === 'my_username_status') {
      if (server.statusFailures > 0) {
        server.statusFailures -= 1;
        return { data: null, error: { code: '08006', message: 'network' } };
      }
      return { data: [{ username: server.username, locked: server.locked }], error: null };
    }
    if (fn === 'set_username') {
      if (server.setError) return { data: null, error: server.setError };
      server.username = String(args?.p_username);
      server.locked = true;
      return { data: server.username, error: null };
    }
    if (fn === 'usernames_available') {
      const sent = (args?.p_candidates ?? []) as string[];
      return { data: sent.filter((c) => server.free(c)), error: null };
    }
    if (fn === 'my_bills') return { data: [], error: null };
    if (fn === 'join_bill') return { data: BILL, error: null };
    if (fn === 'venmo_prompt_pending') return { data: server.venmoPending, error: null };
    return { data: null, error: null } satisfies FakeResult;
  });
  supabase.__setTable('profiles', () => ({ data: { display_name: 'Ana', venmo_username: null }, error: null }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ----- helpers -----

const press = async (el: ReactTestInstance) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const gateShown = () => screen.queryByRole('header', { name: COPY.title }) !== null;
const findGate = () => screen.findByRole('header', { name: COPY.title });
const field = () => screen.getByLabelText(COPY.fieldLabel);
const keepButton = () => screen.getByRole('button', { name: COPY.keep(PROVISIONAL) });
async function typeName(text: string) {
  await act(async () => {
    fireEvent.changeText(field(), text);
  });
}
async function homeReady() {
  await screen.findByRole('header', { name: 'SplitIt' });
  expect(screen.getByTestId(TAB_BAR_TEST_ID)).toBeTruthy();
}

describe.each(['ios', 'web'] as const)('Choose your username (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('signed in and locked: no gate; Home shows, after one status read', async () => {
    server.locked = true;
    renderRouter(ROUTES, { initialUrl: '/' });
    await homeReady();
    expect(gateShown()).toBe(false);
    expect(rpcCalls('my_username_status')).toHaveLength(1);
    expect(rpcCalls('set_username')).toHaveLength(0);
  });

  it('provisional: the step shows in place of Home, prefilled, with no Skip, Later or close; the URL stays', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await findGate()).toBeTruthy();
    expect(field().props.value).toBe(PROVISIONAL);
    expect(keepButton()).toBeTruthy();
    expect(screen.getByRole('button', { name: COPY.signOut })).toBeTruthy();
    // Positive control above: the step's buttons are there. None of them lets the person past.
    for (const name of [/skip/i, /later/i, /close/i, /not now/i]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByTestId(TAB_BAR_TEST_ID)).toBeNull();
    expect(screen.queryByRole('header', { name: 'SplitIt' })).toBeNull();
    expect(router.getPathname()).toBe('/');
  });

  it('"Keep @ana" locks the provisional name in one tap, then Home shows', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await press(keepButton());
    await homeReady();
    expect(rpcCalls('set_username')).toEqual([['set_username', { p_username: PROVISIONAL }]]);
    expect(gateShown()).toBe(false);
    expect(router.getPathname()).toBe('/');
    // Locked locally: no second status read.
    expect(rpcCalls('my_username_status')).toHaveLength(1);
  });

  it('cold start on /b/<code>: joins, then the step; after the pick it lands on the invited bill', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await findGate()).toBeTruthy();
    expect(screen.queryByText(`Bill stand-in ${BILL}`)).toBeNull();
    await press(keepButton());
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    expect(rpcCalls('join_bill')).toHaveLength(1);
  });

  it('a pending invite resumed on first load (the web OAuth landing on /): step, then the bill; Back → Tabs', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await findGate()).toBeTruthy();
    await press(keepButton());
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
  });

  if (os !== 'web') {
    it('signed out on /b/<code>: sign in, the resume reopens the invite, the step, then the bill', async () => {
      supabase.__setInitialSession(null);
      const router = renderRouter(ROUTES, { initialUrl: `/b/${CODE}` });
      await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
      expect(rpcCalls('my_username_status')).toHaveLength(0); // signed out: no read
      await press(await screen.findByText('Continue with Google'));
      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
      expect(await findGate()).toBeTruthy();
      await press(keepButton());
      expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    });
  }

  it('/bills/<id>: the step, a typed name, then the bill; Back lands on Tabs', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await findGate()).toBeTruthy();
    expect(screen.queryByText(`Bill stand-in ${BILL}`)).toBeNull();
    await typeName(' @Ana_S ');
    const use = screen.getByRole('button', { name: COPY.use('ana_s') });
    // The other way through stays one tap away.
    expect(screen.getByRole('button', { name: COPY.keep(PROVISIONAL) })).toBeTruthy();
    await press(use);
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(rpcCalls('set_username')).toEqual([['set_username', { p_username: 'ana_s' }]]);
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await homeReady();
  });

  it('validates as you type: an invalid name shows why and disables the save, with no request', async () => {
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await typeName('a');
    expect(screen.getByText(USERNAME_ERROR_COPY.too_short)).toBeTruthy();
    const save = screen.getByRole('button', { name: COPY.useInvalid });
    expect(save.props.accessibilityState).toMatchObject({ disabled: true });
    await press(save);
    await typeName('a..b');
    expect(screen.getByText(USERNAME_ERROR_COPY.bad_dots)).toBeTruthy();
    await typeName('admin');
    expect(screen.getByText(USERNAME_ERROR_COPY.reserved)).toBeTruthy();
    await act(async () => {
      fireEvent(field(), 'submitEditing');
    });
    expect(rpcCalls('set_username')).toHaveLength(0);
    await typeName('ana.s');
    expect(screen.queryByText(USERNAME_ERROR_COPY.reserved)).toBeNull();
    expect(screen.getByRole('button', { name: COPY.use('ana.s') }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('taken: the error, then only the free suggestions; tapping one fills the field and saving it locks', async () => {
    server.setError = { code: '23505', message: 'username_taken' };
    // Every other suggestion is free.
    let n = 0;
    server.free = () => n++ % 2 === 0;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await findGate();
    await typeName('hana');
    await press(screen.getByRole('button', { name: COPY.use('hana') }));
    expect(await screen.findByText(USERNAME_ERROR_COPY.taken)).toBeTruthy();
    expect(await screen.findByText(COPY.suggestionsTitle)).toBeTruthy();
    const [call] = rpcCalls('usernames_available');
    const sent = (call?.[1] as { p_candidates: string[] }).p_candidates;
    const free = sent.filter((_, i) => i % 2 === 0);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const c of sent) expect(c).toMatch(/^hana\d{3,4}$/);
    const shown = screen.getAllByRole('button', { name: /^Fill in @/ }).map((b) => b.props.accessibilityLabel as string);
    expect(shown).toEqual(free.map((c) => COPY.suggestionLabel(c)));
    // The form kept what was typed and the save is usable again.
    expect(field().props.value).toBe('hana');

    const pick = free[0] ?? '';
    await press(screen.getByRole('button', { name: COPY.suggestionLabel(pick) }));
    expect(field().props.value).toBe(pick);
    expect(screen.queryByText(USERNAME_ERROR_COPY.taken)).toBeNull();
    server.setError = null;
    await press(screen.getByRole('button', { name: COPY.use(pick) }));
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(rpcCalls('set_username').map(([, a]) => a)).toEqual([{ p_username: 'hana' }, { p_username: pick }]);
  });

  it('taken with no free suggestions: only the error, no suggestion list', async () => {
    server.setError = { code: '23505', message: 'username_taken' };
    server.free = () => false;
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await press(keepButton());
    expect(await screen.findByText(USERNAME_ERROR_COPY.taken)).toBeTruthy();
    await waitFor(() => expect(rpcCalls('usernames_available')).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByText(COPY.suggestionsTitle)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Fill in @/ })).toHaveLength(0);
  });

  it('a suggestions answer that lands after the person typed again is dropped', async () => {
    server.setError = { code: '23505', message: 'username_taken' };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = supabase.rpc.getMockImplementation();
    supabase.rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'usernames_available') await gate;
      return base ? base(fn, args) : { data: null, error: null };
    });
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await press(keepButton());
    expect(await screen.findByText(USERNAME_ERROR_COPY.taken)).toBeTruthy();
    await waitFor(() => expect(rpcCalls('usernames_available')).toHaveLength(1));
    await typeName('ana_new');
    await act(async () => release());
    await act(async () => {});
    // Positive control: the form is there, holding the new name, and nothing else changed it.
    expect(field().props.value).toBe('ana_new');
    expect(screen.queryByText(COPY.suggestionsTitle)).toBeNull();
  });

  it('a failed save (offline) keeps what was typed, re-enables the button and says why', async () => {
    server.setError = { code: 'PGRST000', message: 'fetch failed' };
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await typeName('ana_s');
    await press(screen.getByRole('button', { name: COPY.use('ana_s') }));
    expect(await screen.findByText(USERNAME_ERROR_COPY.error)).toBeTruthy();
    expect(field().props.value).toBe('ana_s');
    expect(screen.getByRole('button', { name: COPY.use('ana_s') }).props.accessibilityState).toMatchObject({
      disabled: false,
      busy: false,
    });
    expect(gateShown()).toBe(true);
    server.setError = null;
    await press(screen.getByRole('button', { name: COPY.use('ana_s') }));
    await homeReady();
  });

  it('a double tap sends one save', async () => {
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await act(async () => {
      fireEvent.press(keepButton());
      fireEvent.press(keepButton());
    });
    await homeReady();
    expect(rpcCalls('set_username')).toHaveLength(1);
  });

  it('"locked" (picked on another device) counts as done: it reads again and lets the person through', async () => {
    server.setError = { code: '42501', message: 'username_locked' };
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await findGate();
    // The other device picked and locked it.
    server.username = 'ana_other';
    server.locked = true;
    await press(keepButton());
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(rpcCalls('my_username_status')).toHaveLength(2);
    expect(screen.queryByText(USERNAME_ERROR_COPY.locked)).toBeNull();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
  });

  it('a failed status read: the error with Try again (never an endless spinner); Try again shows the step', async () => {
    server.statusFailures = 1;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText(COPY.loadError)).toBeTruthy();
    expect(screen.queryByLabelText('Loading')).toBeNull();
    expect(screen.queryByText(`Bill stand-in ${BILL}`)).toBeNull();
    await press(screen.getByRole('button', { name: COPY.tryAgain }));
    expect(await findGate()).toBeTruthy();
    expect(rpcCalls('my_username_status')).toHaveLength(2);
  });

  it('Sign out from the failed read goes to sign-in', async () => {
    server.statusFailures = 1;
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText(COPY.loadError)).toBeTruthy();
    await press(screen.getByRole('button', { name: COPY.signOut }));
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('Sign out from the step goes to sign-in; the next user gets their own read', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    await press(screen.getByRole('button', { name: COPY.signOut }));
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(gateShown()).toBe(false);
    expect(rpcCalls('my_username_status')).toHaveLength(1);
  });

  // No navigator is mounted under the step, so router.back() has nothing to pop (a no-op in production;
  // in development expo-router raises "GO_BACK was not handled", which tears the test renderer down, so
  // it isn't driven here). The web back button moves to an earlier URL, and every app URL is gated.
  it('back stays on the step: an earlier URL in the app (the web back button) shows the step too', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await findGate();
    act(() => globalRouter.navigate('/'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await act(async () => {});
    expect(gateShown()).toBe(true);
    expect(screen.queryByText(`Bill stand-in ${BILL}`)).toBeNull();
    expect(screen.queryByTestId(TAB_BAR_TEST_ID)).toBeNull();
    expect(screen.queryByRole('header', { name: 'SplitIt' })).toBeNull();
  });

  it('the step comes before the Venmo prompt: after the pick, Home shows the prompt, never both at once', async () => {
    server.venmoPending = true;
    renderRouter(ROUTES, { initialUrl: '/' });
    await findGate();
    expect(screen.queryByText('Add your Venmo so friends can pay you')).toBeNull();
    expect(rpcCalls('venmo_prompt_pending')).toHaveLength(0);
    await press(keepButton());
    await homeReady();
    expect(await screen.findByText('Add your Venmo so friends can pay you')).toBeTruthy();
  });

  it('Profile shows @name on the identity line once locked', async () => {
    server.locked = true;
    renderRouter(ROUTES, { initialUrl: '/profile' });
    expect(await screen.findByLabelText(COPY.profileRow(PROVISIONAL))).toBeTruthy();
    expect(screen.getByText(`@${PROVISIONAL}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: COPY.chooseLabel })).toBeNull();
    // Shared with the gate: still one status read.
    expect(rpcCalls('my_username_status')).toHaveLength(1);
    expect(screen.getByLabelText(tabNamed('Profile'))).toBeTruthy();
  });
});

describe('Choose your username (android)', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  it('the hardware back button stays on the step, and stops being swallowed once the name is picked', async () => {
    type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: BackListener[] = [];
    const add = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: () => void handlers.splice(handlers.indexOf(handler), 1) };
    });
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await findGate();
    const ours = add.mock.calls.filter(([event]) => event === 'hardwareBackPress').map(([, h]) => h);
    expect(ours.length).toBeGreaterThan(0);
    // The newest listener runs first, as BackHandler does: the step's own.
    const newest = handlers[handlers.length - 1];
    let handled: boolean | null | undefined = false;
    await act(async () => {
      handled = newest?.({} as Parameters<BackListener>[0]);
    });
    expect(handled).toBe(true);
    expect(gateShown()).toBe(true);
    expect(screen.queryByText(`Bill stand-in ${BILL}`)).toBeNull();

    await press(keepButton());
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
    expect(handlers.includes(newest as BackListener)).toBe(false);
  });
});
