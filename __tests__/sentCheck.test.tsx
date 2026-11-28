// The notification responder (components/SentCheckResponder.tsx) and the resume gate
// (docs/specs/2026-11-26-sent-via-venmo.md D3, A1 F10; criterion 41), through the whole app:
// the root layout's ResumeAfterSignIn settles the gate, app/(app)/_layout.tsx mounts the responder,
// and the real lib/checkInNotifications.native.ts turns expo-notifications responses into ours
// (only expo-notifications itself is faked here, so its dedupe and clearing are the real ones).
//
// Hana (A) paid; Sam (B, the viewer) sent $15.10 via Venmo at AT. Router tests on native and with
// Platform.OS = 'web'. (On a real web build lib/checkInNotifications.ts is a no-op and no response
// ever arrives; the web runs here check the responder's own logic doesn't depend on the platform.)
import * as Notifications from 'expo-notifications';
import { router as globalRouter } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Platform } from 'react-native';

import { savePendingInvite } from '@/lib/pendingInvite';
import { SEEN_DEBOUNCE_MS } from '@/lib/useMarkSeen';
import { resetResumeGateForTests } from '@/lib/resumeGate';
import { parseSentCheckBlob, sentCheckBlobKey, sentCheckKey, sentCheckNotificationId, storeSentCheckAnswer } from '@/lib/sentCheck';
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
const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const N = Notifications as unknown as {
  addNotificationResponseReceivedListener: jest.Mock;
  getLastNotificationResponse: jest.Mock;
  clearLastNotificationResponse: jest.Mock;
  cancelScheduledNotificationAsync: jest.Mock;
  dismissNotificationAsync: jest.Mock;
  getAllScheduledNotificationsAsync: jest.Mock;
  getPresentedNotificationsAsync: jest.Mock;
};
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const JOINED = '33333333-3333-4333-8333-333333333333';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const SALAD = '22222222-0000-4000-8000-000000000002';
const CODE = '0123456789abcdef0123';
const AT = '2026-11-26T20:00:00.000Z';
const AT_MS = Date.parse(AT);
const ID = sentCheckNotificationId(B, BILL, A, AT_MS) ?? '';
const KEY = sentCheckKey(BILL, A, AT_MS) ?? '';
const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const SETTLE = `/bills/${BILL}/settle`;

/** B's mark on the server: the Venmo send the notification asks about, unless a test changes it. */
const server: { mark: { cents: number; at: string; method: string } | null } = { mark: null };

function installServer() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () =>
    ok({
      id: BILL,
      host_id: A,
      payer_id: A,
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 3010,
      join_code: CODE,
      group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
      created_at: '2026-11-26T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    }),
  );
  supabase.__setTable('line_items', () =>
    ok([
      { id: BURGER, name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500, split_set_by: null, split_set_at: null },
      { id: SALAD, name: 'Salad', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 1510, split_set_by: null, split_set_at: null },
    ]),
  );
  supabase.__setTable('bill_participants', () =>
    ok([
      { user_id: A, joined_at: '2026-11-26T19:00:00Z', settled_at: null, settled_cents: null, settled_method: null, not_received_cents: null, not_received_method: null, not_received_by: null, profile: { display_name: 'Hana', venmo_username: 'hana-1' } },
      {
        user_id: B,
        joined_at: '2026-11-26T19:01:00Z',
        settled_at: server.mark?.at ?? null,
        settled_cents: server.mark?.cents ?? null,
        settled_method: server.mark?.method ?? null,
        not_received_cents: null,
        not_received_method: null,
        not_received_by: null,
        profile: { display_name: 'Sam', venmo_username: null },
      },
    ]),
  );
  supabase.__setTable('claims', () =>
    ok([
      { line_item_id: BURGER, user_id: A, parts: 1 },
      { line_item_id: SALAD, user_id: B, parts: 1 },
    ]),
  );
  supabase.__setTable('profiles', () => ok({ display_name: 'Sam', venmo_username: null }));
  supabase.__setRpc((fn) => {
    if (fn === 'unmark_paid') server.mark = null;
    if (fn === 'join_bill') return ok(JOINED);
    if (fn === 'venmo_prompt_pending') return ok(false);
    if (fn === 'my_bills') return ok([]);
    return ok(null);
  });
}

// ----- expo-notifications, faked at the package edge -----

type Listener = (raw: unknown) => void;
let listeners: Listener[] = [];
let lastResponse: unknown = null;

/**
 * The module dedupes by identifier|action for the app's lifetime (one module per test file), so each
 * test gets its own identifier suffix; within a test the same response repeats exactly.
 */
let testN = 0;
const VALID = { billId: BILL, userId: B, payerId: A, cents: 1510, markAtMs: AT_MS };
function response(action: 'yes' | 'undo' | 'open', data: unknown = VALID, tag = '') {
  const identifier = `${ID}.t${testN}${tag}`;
  return {
    actionIdentifier: action === 'open' ? DEFAULT : action,
    notification: { request: { identifier, content: { title: 'SplitIt', body: 'Did your $15.10 to Hana go through?', data } } },
  };
}

/** A response while the app runs (the listener). */
async function live(raw: unknown) {
  await act(async () => listeners.forEach((l) => l(raw)));
}

function signInAs(id: string | null) {
  if (id === null) {
    supabase.__setInitialSession(null);
    return;
  }
  const s = fakeSession('Test User');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
}

const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);
const writes = () => supabase.rpc.mock.calls.filter(([name]) => ['unmark_paid', 'mark_paid', 'settle_difference'].includes(name));
const stored = () => parseSentCheckBlob(storage.data.get(sentCheckBlobKey(B) ?? '') ?? null)[KEY]?.a ?? null;
/** Lets pending promises (the gate, storage, the undo) run. */
const flush = () => act(async () => {});

async function openApp(url = '/') {
  const router = renderRouter(ROUTES, { initialUrl: url });
  // Positive marker: the responder has subscribed (it mounts with the signed-in layout).
  await waitFor(() => expect(N.addNotificationResponseReceivedListener).toHaveBeenCalled());
  return router;
}

beforeEach(() => {
  testN += 1;
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.clearAllMocks();
  resetResumeGateForTests();
  storage.data.clear();
  supabase.__queries.length = 0;
  server.mark = { cents: 1510, at: AT, method: 'venmo' };
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
  N.cancelScheduledNotificationAsync.mockResolvedValue(undefined);
  N.dismissNotificationAsync.mockResolvedValue(undefined);
  N.getAllScheduledNotificationsAsync.mockResolvedValue([]);
  N.getPresentedNotificationsAsync.mockResolvedValue([]);
  installServer();
  signInAs(B);
});

describe.each(['ios', 'web'] as const)('the notification responder (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('warm "No, undo": runs the undo rule (unmarkPaid once), stores "undo", cancels, then pushes Settle up', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await live(response('undo'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: A }]]);
    expect(stored()).toBe('undo');
    expect(N.cancelScheduledNotificationAsync).toHaveBeenCalledWith(ID);
    expect(N.dismissNotificationAsync).toHaveBeenCalledWith(ID);
    // Settle up loads after the undo: Sam owes again, and no "was undone… see who" banner.
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.queryByText(/was undone/)).toBeNull();
    if (os === 'web') expect(announce).not.toHaveBeenCalled();
    else expect(announce).toHaveBeenCalledWith('Undone. Not marked as sent.');
    announce.mockRestore();
  });

  it('R8: "No, undo" while Settle up is already open → no second Settle page, and no "was undone… see who" banner', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openApp(SETTLE);
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    await live(response('undo'));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    // The page re-reads after its viewer's own undo: Sam owes again.
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.queryByText(/was undone/)).toBeNull();
    expect(router.getPathname()).toBe(SETTLE);
    expect(push).not.toHaveBeenCalled();
    expect(stored()).toBe('undo');
    push.mockRestore();
  });

  it('R8 control: from another screen, "No, undo" pushes Settle up once', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openApp('/');
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await live(response('undo'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(SETTLE);
    push.mockRestore();
  });

  it('warm "No, undo" when the mark changed since: nothing undone, stores "undo", still opens Settle up', async () => {
    server.mark = { cents: 1620, at: AT, method: 'venmo' };
    const router = await openApp();
    await live(response('undo'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(stored()).toBe('undo');
  });

  it('warm "No, undo" when unmarkPaid fails: nothing stored, Settle up opens with the question still there', async () => {
    supabase.__setRpc((fn) =>
      fn === 'unmark_paid' ? { data: null, error: { code: '08006', message: 'down' } } : { data: fn === 'my_bills' ? [] : null, error: null },
    );
    const router = await openApp();
    await live(response('undo'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
    expect(stored()).toBeNull();
  });

  it('warm "Yes": stores "yes" and cancels; never navigates and writes nothing', async () => {
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await live(response('yes'));
    await waitFor(() => expect(stored()).toBe('yes'));
    await waitFor(() => expect(N.dismissNotificationAsync).toHaveBeenCalledWith(`${ID}.t${testN}`));
    await flush();
    expect(router.getPathname()).toBe('/');
    expect(writes()).toHaveLength(0);
  });

  it('warm body tap: pushes Settle up only (nothing stored, nothing written)', async () => {
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await live(response('open'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it('criterion 43, the notification route: Settle up opened from a body tap marks the bill seen', async () => {
    const router = await openApp();
    await live(response('open'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    act(() => jest.advanceTimersByTime(SEEN_DEBOUNCE_MS));
    await waitFor(() => expect(rpcCalls('mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: BILL }]]));
  });

  it('the same response twice is handled once', async () => {
    await openApp();
    const raw = response('undo');
    await live(raw);
    await live(raw);
    await waitFor(() => expect(stored()).toBe('undo'));
    await flush();
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
  });

  it('a stored "undo" (answered in the app already) makes a later "No, undo" a no-op, though it still opens Settle up', async () => {
    await storeSentCheckAnswer(storage, B, KEY, 'undo', Date.now());
    const router = await openApp();
    await live(response('undo'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
  });

  it.each<[string, unknown]>([
    ['another user', { billId: BILL, userId: A, payerId: A, cents: 1510, markAtMs: AT_MS }],
    ['an extra key', { billId: BILL, userId: B, payerId: A, cents: 1510, markAtMs: AT_MS, name: 'Hana' }],
    ['fractional cents', { billId: BILL, userId: B, payerId: A, cents: 15.1, markAtMs: AT_MS }],
    ['a bill id that is a path', { billId: '../profile', userId: B, payerId: A, cents: 1510, markAtMs: AT_MS }],
    ['no data', null],
  ])('%s: "No, undo" and a body tap do nothing at all', async (_name, data) => {
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await live(response('undo', data));
    await live(response('open', data));
    await live(response('yes', data));
    await flush();
    expect(router.getPathname()).toBe('/');
    // Positive control: a valid response after them is handled, so the listener was live.
    await live(response('open', VALID, '.ok'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(writes()).toHaveLength(0);
    expect(stored()).toBeNull();
  });

  it('signed out: the responder isn\'t mounted, nothing listens, and nothing is read or cleared', async () => {
    signInAs(null);
    lastResponse = response('undo');
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    await flush();
    expect(N.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
    expect(N.getLastNotificationResponse).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  // ----- Cold start (the response that launched the app) -----

  it('cold start on a restored session with nothing to resume (gate "none"): handled once, then cleared', async () => {
    lastResponse = response('undo');
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
    expect(N.clearLastNotificationResponse).toHaveBeenCalled();
    expect(lastResponse).toBeNull();
    // The listener delivering the same response later (iOS can do both) is deduped.
    await live(response('undo'));
    await flush();
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
  });

  it('cold start with a pending invite: the invite route wins and the response is dropped (gate "signed_in")', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    lastResponse = response('undo');
    const router = await openApp();
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${JOINED}`));
    await flush();
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(stored()).toBeNull();
    expect(router.getPathname()).toBe(`/bills/${JOINED}`);
    // Positive control: a live response afterwards is still handled.
    await live(response('open', VALID, '.ok'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
  });

  it('cold start, signed out at launch, then a sign-in: the sign-in resume owns navigation and the response is dropped', async () => {
    signInAs(null);
    lastResponse = response('undo');
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    await screen.findByText('Continue with Google');
    // Sam signs in while the app runs (what the native OAuth exchange does): every auth listener hears it.
    const s = fakeSession('Test User');
    const session = { ...s, user: { ...s.user, id: B } };
    await act(async () => {
      for (const [listener] of supabase.auth.onAuthStateChange.mock.calls) listener('SIGNED_IN', session);
    });
    await waitFor(() => expect(N.addNotificationResponseReceivedListener).toHaveBeenCalled());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await flush();
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(router.getPathname()).toBe('/');
    // Positive control: Sam is signed in and a live response is handled.
    await live(response('open', VALID, '.ok'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
  });

  it('cold "Yes" on a restored session stores it and stays put', async () => {
    lastResponse = response('yes');
    const router = await openApp();
    await waitFor(() => expect(stored()).toBe('yes'));
    await flush();
    expect(router.getPathname()).toBe('/');
    expect(writes()).toHaveLength(0);
  });
});
