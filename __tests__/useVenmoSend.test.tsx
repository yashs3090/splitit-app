// The Venmo send and the inline check, through the Settle screen (docs/specs/2026-11-26-sent-via-venmo.md
// Task 9a; criteria 37–40, 42, 44): lib/useVenmoSend.ts's native order and every outcome, the web
// branch, cash and "Paid another way", the inline "Did it go through?", cancel-on-return, and the
// entry paths. Router tests on native and with Platform.OS = 'web'.
//
// The bill is settle.test.tsx's worked example: Hana (A) hosts and paid (@hana-1); Sam (B) owes $15.10.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, AppState, Platform, type AppStateStatus } from 'react-native';

import { BILL_ERROR_COPY, fetchBill } from '@/lib/bills';
import { settleViewInputFor } from '@/lib/settleView';
import * as notifications from '@/lib/checkInNotifications';
import { openPaymentLink, openPaymentLinkWeb } from '@/lib/paylinks';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { SEEN_DEBOUNCE_MS } from '@/lib/useMarkSeen';
import { SCHEDULE_TIMEOUT_MS } from '@/lib/checkInNotifications.types';
import { SENT_CHECK_INLINE_MAX_MINUTES } from '@/lib/sentCheck';
import { MARK_BEFORE_OPEN_TIMEOUT_MS, PAY_REPEAT_MS, UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS } from '@/lib/useVenmoSend';
import { fakeSession, type FakeChannel, type FakeDbError, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/paylinks', () => {
  const actual = jest.requireActual<typeof import('@/lib/paylinks')>('@/lib/paylinks');
  return {
    ...actual,
    openPaymentLink: jest.fn(async () => ({ ok: true })),
    openPaymentLinkWeb: jest.fn(() => ({ closed: false, opener: null })),
  };
});
jest.mock('@/lib/checkInNotifications', () => ({
  supported: true,
  notificationPermission: jest.fn(async () => 'granted'),
  askNotificationPermissionOnce: jest.fn(async () => 'granted'),
  ensureSentCheckCategory: jest.fn(async () => true),
  ensureAndroidChannel: jest.fn(async () => true),
  scheduleSentCheck: jest.fn(async () => true),
  cancelSentCheck: jest.fn(async () => {}),
  cancelSentChecks: jest.fn(async () => {}),
  cancelAllSentChecks: jest.fn(async () => {}),
  subscribeSentCheckResponses: jest.fn(() => () => {}),
  lastSentCheckResponse: jest.fn(() => null),
  clearLastSentCheckResponse: jest.fn(),
  useSentCheckResponses: jest.fn(),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const openLink = openPaymentLink as jest.MockedFunction<typeof openPaymentLink>;
const openWeb = openPaymentLinkWeb as unknown as jest.Mock;
const notif = notifications as unknown as {
  notificationPermission: jest.Mock;
  askNotificationPermissionOnce: jest.Mock;
  scheduleSentCheck: jest.Mock;
  cancelSentCheck: jest.Mock;
  cancelSentChecks: jest.Mock;
};
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const SALAD = '22222222-0000-4000-8000-000000000002';
const FRIES = '22222222-0000-4000-8000-000000000003';
const OLD = '2026-11-24T19:30:00Z';
const PAY = 'Pay Hana $15.10 on Venmo, to @hana-1';
const URL = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries';
const OPEN_FAILED = "Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.";
const BLOB_KEY = `splitit.sentcheck.v1.${B}`;
const METHOD_KEY = `splitit.payMethod.v1.${B}`;

type Person = { id: string; name: string; venmo: string | null; mark: number | null; method?: PaymentMethod; at?: string };
const db: { people: Person[] } = { people: [] };
const next: {
  mark: FakeDbError | null;
  unmark: FakeDbError | null;
  hold: Promise<void> | null;
  failReads: boolean;
  /** Holds mark_paid only (one request at a time, review R3). */
  markHold: Promise<void> | null;
  /** Holds unmark_paid only. */
  unmarkHold: Promise<void> | null;
  /** mark_paid lands on the server, but the answer is lost (a network error after the write; R4). */
  markLandsThenFails: boolean;
} = {
  mark: null,
  unmark: null,
  hold: null,
  failReads: false,
  markHold: null,
  unmarkHold: null,
  markLandsThenFails: false,
};
const me = (id: string) => {
  const p = db.people.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
};
const row = (id: string, name: string, cents: number, g: number) => ({
  id,
  name,
  note: null,
  group_position: g,
  unit_index: 0,
  group_size: 1,
  total_cents: cents,
  split_set_by: null,
  split_set_at: null,
});

function installServer() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () =>
    next.failReads
      ? { data: null, error: { code: '08006', message: 'down' } }
      : ok({
          id: BILL,
          host_id: A,
          payer_id: A,
          subtotal_cents: null,
          tax_cents: 500,
          fees_cents: 0,
          tip_cents: 0,
          subtotal_discount_cents: 0,
          total_discount_cents: 0,
          total_cents: 3600,
          join_code: '0123456789abcdef0123',
          group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
          created_at: '2026-11-24T19:00:00Z',
          edited_at: null,
          extras_split: 'proportional',
        }),
  );
  supabase.__setTable('line_items', () => ok([row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)]));
  supabase.__setTable('bill_participants', () =>
    ok(
      db.people.map((p, i) => ({
        user_id: p.id,
        joined_at: `2026-11-24T19:0${i}:00Z`,
        settled_at: p.mark === null ? null : (p.at ?? OLD),
        settled_cents: p.mark,
        settled_method: p.mark === null ? null : (p.method ?? 'other'),
        not_received_cents: null,
        not_received_method: null,
        not_received_by: null,
        profile: { display_name: p.name, venmo_username: p.venmo },
      })),
    ),
  );
  supabase.__setTable('claims', () =>
    ok([
      { line_item_id: BURGER, user_id: A, parts: 1 },
      { line_item_id: SALAD, user_id: B, parts: 1 },
      { line_item_id: FRIES, user_id: A, parts: 1 },
      { line_item_id: FRIES, user_id: B, parts: 1 },
    ]),
  );
  supabase.__setTable('profiles', () => ok({ display_name: 'Sam', venmo_username: null }));
  supabase.__setRpc(async (fn, args) => {
    if (next.hold) await next.hold;
    const a = args ?? {};
    if (fn === 'mark_paid') {
      if (next.markHold) await next.markHold;
      if (next.mark) return { data: null, error: next.mark };
      const p = me(B);
      if (p.mark !== null) return ok([{ settled_at: p.at ?? OLD, created: false }]);
      p.mark = a.p_cents as number;
      p.method = a.p_method as PaymentMethod;
      p.at = new Date().toISOString();
      if (next.markLandsThenFails) return { data: null, error: { code: '08006', message: 'down' } };
      return ok([{ settled_at: p.at, created: true }]);
    }
    if (fn === 'unmark_paid') {
      if (next.unmarkHold) await next.unmarkHold;
      if (next.unmark) return { data: null, error: next.unmark };
      const p = me(a.p_user_id as string);
      p.mark = null;
      p.at = undefined;
      p.method = undefined;
      return ok(null);
    }
    if (fn === 'venmo_prompt_pending') return ok(false);
    return ok(null);
  });
}

function signInAs(id: string) {
  const s = fakeSession('Test User');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
}
const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

/**
 * The plan key the screen's actions carry right now (who paid A1.2): the same fetchBill +
 * settleViewInputFor the screen runs, on the server data as it stands. Read before the tap, so the
 * write that follows can't change it. Its own reads are taken back out of the query log, so the
 * tests' fetch counts are unchanged.
 */
async function shownPlanKey(viewerId: string = B): Promise<string> {
  const logged = supabase.__queries.length;
  const res = await fetchBill(BILL);
  supabase.__queries.splice(logged);
  if (!res.ok) throw new Error('shownPlanKey: fetchBill failed');
  const key = settleViewInputFor(res, viewerId, Platform.OS, null).planKey;
  if (typeof key !== 'string') throw new Error('shownPlanKey: this plan has no key');
  return key;
}
const orderOf = (fn: string) => supabase.rpc.mock.invocationCallOrder[supabase.rpc.mock.calls.findIndex(([n]) => n === fn)] ?? -1;
const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};
const firstText = (text: string) => {
  const el = screen.getAllByText(text)[0];
  if (!el) throw new Error(`no ${text}`);
  return el;
};
/** A request held until the test lets it go (review R3: hold each request with a deferred promise). */
function deferred<T = void>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
/** A tab as window.open returns it, with close() to see whether the hook closed it (R1). */
const tab = (closed = false) => ({ closed, opener: null, close: jest.fn() });
const storedBlob = () => String(storage.data.get(BLOB_KEY) ?? '');

async function openSettle() {
  signInAs(B);
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
  await screen.findByText('You owe Hana');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  return router;
}

/** AppState as the screen sees it: returns the transitions to send. */
function captureAppState() {
  const handlers: ((s: AppStateStatus) => void)[] = [];
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    handlers.push(handler as (s: AppStateStatus) => void);
    return { remove: () => {} };
  });
  const send = async (s: AppStateStatus) => {
    await act(async () => handlers.forEach((h) => h(s)));
  };
  return { send, restore: () => spy.mockRestore() };
}

/** The browser, for the web branch: a phone user agent makes it mobile web (detectMobileWeb). */
const g = globalThis as { navigator?: unknown };
const originalNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
function setBrowser(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent, maxTouchPoints } });
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  db.people = [{ id: A, name: 'Hana', venmo: 'hana-1', mark: null }, { id: B, name: 'Sam', venmo: null, mark: null }];
  next.mark = null;
  next.unmark = null;
  next.hold = null;
  next.failReads = false;
  next.markHold = null;
  next.unmarkHold = null;
  next.markLandsThenFails = false;
  notif.notificationPermission.mockResolvedValue('granted');
  notif.askNotificationPermissionOnce.mockResolvedValue('granted');
  notif.scheduleSentCheck.mockResolvedValue(true);
  openLink.mockResolvedValue({ ok: true });
  openWeb.mockReturnValue(tab());
  installServer();
});

afterEach(() => {
  if (originalNavigator) Object.defineProperty(g, 'navigator', originalNavigator);
  else delete g.navigator;
});

// ---------------------------------------------------------------------------
// Native (criteria 37, 44)
// ---------------------------------------------------------------------------

describe('native send', () => {
  it('37: permission → markPaid("venmo") → scheduleSentCheck (60 s, D3 content) → openPaymentLink, in that order', async () => {
    await openSettle();
    const key = await shownPlanKey(); // the plan key the shown actions carry (A1.2)
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledWith(URL));
    const asked = notif.askNotificationPermissionOnce.mock.invocationCallOrder[0] ?? -1;
    const marked = orderOf('mark_paid');
    const scheduled = notif.scheduleSentCheck.mock.invocationCallOrder[0] ?? -1;
    const opened = openLink.mock.invocationCallOrder[0] ?? -1;
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(marked);
    expect(marked).toBeLessThan(scheduled);
    expect(scheduled).toBeLessThan(opened);
    expect(rpcCalls('mark_paid')[0]?.[1]).toEqual({ p_bill_id: BILL, p_payer_id: A, p_cents: 1510, p_method: 'venmo', p_plan_key: key });
    const markAtMs = Date.parse(me(B).at ?? '');
    const n = notif.scheduleSentCheck.mock.calls[0]?.[0] as { identifier: string; content: Record<string, unknown>; trigger: unknown };
    expect(n.identifier).toBe(`sentcheck.${B}.${BILL}.${A}.${markAtMs}`);
    expect(n.content).toMatchObject({ title: 'SplitIt', body: 'Did your $15.10 to Hana go through?', sound: false });
    expect(n.content.data).toEqual({ billId: BILL, userId: B, payerId: A, cents: 1510, markAtMs });
    expect(n.trigger).toEqual({ seconds: 60, repeats: false });
    // Back in SplitIt: the sent card with the inline check.
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.getByText('Did it go through?')).toBeTruthy();
    expect(screen.queryByLabelText("Didn't go through? Undo")).toBeNull(); // hidden while the check shows
  });

  it('44: undetermined → the note shows and the first Pay asks; denied → no schedule, but the inline check still shows', async () => {
    notif.notificationPermission.mockResolvedValue('undetermined');
    notif.askNotificationPermissionOnce.mockResolvedValue('denied');
    await openSettle();
    expect(await screen.findByText("We'll check back in a minute to make sure it went through.")).toBeTruthy();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(notif.askNotificationPermissionOnce).toHaveBeenCalledTimes(1);
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
    expect(await screen.findByText('Did it go through?')).toBeTruthy();
    expect(screen.queryByText("We'll check back in a minute to make sure it went through.")).toBeNull();
  });

  it('44: the note never shows on web, even while undetermined', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    notif.notificationPermission.mockResolvedValue('undetermined');
    await openSettle();
    expect(screen.getByText('Pay Hana $15.10 on Venmo')).toBeTruthy(); // positive marker: the Venmo notes are there
    expect(screen.getByText('@hana-1 · $15.10')).toBeTruthy();
    expect(screen.queryByText("We'll check back in a minute to make sure it went through.")).toBeNull();
  });

  it('37: created = false (already marked elsewhere) → no schedule, no open, the Banner, and a refetch', async () => {
    await openSettle();
    // Another device marked it after this screen loaded.
    me(B).mark = 1510;
    me(B).method = 'venmo';
    const before = billFetches();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText("You've already marked this. Check below.")).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(openLink).not.toHaveBeenCalled();
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
  });

  it('37: payer_changed → no open, the error shows, and a refetch', async () => {
    next.mark = { code: '22023', message: 'payer_changed' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(BILL_ERROR_COPY.payer_changed)).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(PAY).props.accessibilityState?.disabled).toBe(false));
  });

  it('37: the write takes longer than 4 s → Venmo opens anyway, nothing is scheduled, and the card asks', async () => {
    let release: () => void = () => {};
    await openSettle();
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText(PAY));
    await act(async () => {});
    expect(openLink).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(MARK_BEFORE_OPEN_TIMEOUT_MS));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
    // The late result lands: it only refetches, and the screen shows what the server has.
    const before = billFetches();
    next.hold = null;
    await act(async () => release());
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(openLink).toHaveBeenCalledTimes(1);
  });

  it('37: a network error → Venmo opens anyway and the card asks (contract O)', async () => {
    next.mark = { code: '08006', message: 'down' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
  });

  it('37: Venmo fails to open after the mark → unmarkPaid, the check-in cancelled, and the open-failed line', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: A }]]);
    const id = (notif.scheduleSentCheck.mock.calls[0]?.[0] as { identifier: string }).identifier;
    expect(notif.cancelSentCheck).toHaveBeenCalledWith(id);
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
  });

  it('a double tap on Pay sends one mark and opens Venmo once', async () => {
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  });

  it('iOS announces "Sent to Hana, $15.10" once the sent card has landed', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await screen.findByText('You sent Hana');
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Sent to Hana, $15.10'));
    announce.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Web (criterion 38)
// ---------------------------------------------------------------------------

describe('web send', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'web');
  });

  it('38: openPaymentLinkWeb runs inside the tap, before any write or microtask', async () => {
    setBrowser(IPHONE, 5);
    await openSettle();
    let calledInTap = false;
    fireEvent.press(screen.getByLabelText(PAY));
    calledInTap = openWeb.mock.calls.length === 1; // fireEvent.press has returned; nothing awaited yet
    expect(calledInTap).toBe(true);
    expect(openWeb).toHaveBeenCalledWith(URL);
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    expect(openLink).not.toHaveBeenCalled(); // never RN Linking on web (noopener → always null)
  });

  it('38: mobile web, tab still open after the wait → records "venmo"; no notification on web', async () => {
    setBrowser(IPHONE, 5);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(rpcCalls('mark_paid')[0]?.[1]).toMatchObject({ p_method: 'venmo' });
    expect(orderOf('mark_paid')).toBeGreaterThan(openWeb.mock.invocationCallOrder[0] ?? Infinity);
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.getByText('Did it go through?')).toBeTruthy(); // the inline check works on web too
    expect(notif.askNotificationPermissionOnce).not.toHaveBeenCalled();
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
  });

  it('38: mobile web, the tab closed during the wait (Venmo took over) → asks on return, writes nothing', async () => {
    setBrowser(IPHONE, 5);
    openWeb.mockReturnValueOnce({ closed: true, opener: null });
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    expect(rpcCalls('mark_paid')).toHaveLength(0);
  });

  it('38: desktop web → asks, writes nothing until "Yes, I sent it", which records "venmo" and answers the check', async () => {
    setBrowser(MAC, 0);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    act(() => jest.advanceTimersByTime(5000));
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Yes, I sent it'));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(rpcCalls('mark_paid')[0]?.[1]).toMatchObject({ p_method: 'venmo' });
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.queryByText('Did it go through?')).toBeNull();
    expect(storedBlob()).toContain('"a":"yes"');
  });

  it('38: a blocked popup → nothing written, and the open-failed line', async () => {
    setBrowser(IPHONE, 5);
    openWeb.mockReturnValueOnce(null);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    act(() => jest.advanceTimersByTime(5000));
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Cash and "Paid another way" (criterion 39), native and web
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('cash and another way on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('39: Cash → "I paid Hana $15.10 in cash" → markPaid("cash"); nothing opens or is scheduled; Undo, no confirm', async () => {
    await openSettle();
    const key = await shownPlanKey(); // the plan key the shown actions carry (A1.2)
    fireEvent.press(screen.getByLabelText("Cash, how you're paying"));
    expect(screen.getByLabelText("Cash, how you're paying").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.queryByText('@hana-1 · $15.10')).toBeNull(); // the Venmo notes go with Venmo
    await waitFor(() => expect(storage.data.get(METHOD_KEY)).toBe('cash'));
    fireEvent.press(screen.getByLabelText('I paid Hana $15.10 in cash'));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510, p_method: 'cash', p_plan_key: key }]]);
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(firstText('Paid in cash').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText("You're all set. Hana can see it.")).toBeTruthy();
    expect(screen.getByLabelText('Undo')).toBeTruthy();
    expect(screen.queryByText('Did it go through?')).toBeNull(); // never for cash
    expect(openLink).not.toHaveBeenCalled();
    expect(openWeb).not.toHaveBeenCalled();
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
    expect(notif.askNotificationPermissionOnce).not.toHaveBeenCalled();
  });

  it('39: the remembered Cash is the default on the next visit; "Paid another way" (method other) is never remembered', async () => {
    storage.data.set(METHOD_KEY, 'cash');
    await openSettle();
    expect(screen.getByLabelText("Cash, how you're paying").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByText('I paid Hana $15.10 in cash')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Paid another way'));
    expect(rpcCalls('mark_paid')[0]?.[1]).toMatchObject({ p_method: 'other' });
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(firstText('Marked paid')).toBeTruthy();
    expect(storage.data.get(METHOD_KEY)).toBe('cash');
  });

  it('the chooser is disabled while a write from the card is in flight', async () => {
    let release: () => void = () => {};
    await openSettle();
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText('Paid another way'));
    expect(screen.getByLabelText("Cash, how you're paying").props.accessibilityState).toMatchObject({ disabled: true });
    next.hold = null;
    await act(async () => release());
    await screen.findByText('You paid Hana');
  });
});

// ---------------------------------------------------------------------------
// The inline check (criterion 40), native and web
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('inline check on %s', (os) => {
  /** Sam has just sent via Venmo (a fresh mark), so the card asks. */
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    Object.assign(me(B), { mark: 1510, method: 'venmo', at: new Date().toISOString() });
  });

  async function openSent() {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    await screen.findByText('Did it go through?');
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
    return router;
  }

  it('40: Yes hides it, writes nothing, stores "yes", cancels the check-in and shows the completion line', async () => {
    await openSent();
    expect(screen.getByText('You sent Hana')).toBeTruthy();
    const writesBefore = supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen').length;
    fireEvent.press(screen.getByLabelText('Yes, it went through'));
    expect(screen.queryByText('Did it go through?')).toBeNull();
    expect(screen.getByText("You're all set. Hana can see it.")).toBeTruthy();
    expect(screen.getByLabelText("Didn't go through? Undo")).toBeTruthy();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen')).toHaveLength(writesBefore);
    await waitFor(() => expect(storedBlob()).toContain('"a":"yes"'));
    expect(notif.cancelSentCheck).toHaveBeenCalledWith(`sentcheck.${B}.${BILL}.${A}.${Date.parse(me(B).at ?? '')}`);
  });

  it('40: No, undo re-reads and calls unmarkPaid once (two taps), then "Undone. Not marked as sent."', async () => {
    const before = billFetches();
    await openSent();
    const fetchesAtOpen = billFetches();
    expect(fetchesAtOpen).toBeGreaterThan(before);
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    expect(billFetches()).toBeGreaterThan(fetchesAtOpen); // the re-read before deciding
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    const said = screen.getByText('Undone. Not marked as sent.');
    expect(said.props.accessibilityLiveRegion).toBe('polite');
    expect(storedBlob()).toContain('"a":"undo"');
    expect(notif.cancelSentCheck).toHaveBeenCalled();
    expect(screen.queryByText('Your "I paid" was undone. Check Activity to see who.')).toBeNull();
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
  });

  it('40: the mark changed since (re-sent at another amount) → nothing undone, the "changed" Banner', async () => {
    await openSent();
    me(B).mark = 1400; // a different mark now, as the re-read will show
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    expect(await screen.findByText('Your payment to Hana changed since then, so nothing was undone. Check below.')).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(storedBlob()).toContain('"a":"undo"');
  });

  it('40: the mark is already gone → stored "undo", nothing undone, nothing shown', async () => {
    await openSent();
    me(B).mark = null;
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(storedBlob()).toContain('"a":"undo"');
  });

  it('40: unmarkPaid fails → "Couldn\'t undo. Try again.", nothing stored, the question stays and can be tapped again', async () => {
    await openSent();
    next.unmark = { code: '08006', message: 'down' };
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    expect(screen.getByText('Did it go through?')).toBeTruthy();
    expect(storedBlob()).not.toContain('"a":"undo"');
    next.unmark = null;
    await waitFor(() => expect(screen.getByLabelText("No, undo. It didn't go through").props.accessibilityState?.disabled).toBe(false));
    fireEvent.press(screen.getByLabelText("No, undo. It didn't go through"));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(2);
  });

  it('40: navigating away stores "shown"; coming back doesn\'t show it again', async () => {
    const router = await openSent();
    act(() => globalRouter.push(`/bills/${BILL}`));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await waitFor(() => expect(storedBlob()).toContain('"a":"shown"'));
    await screen.findByText(/^Total \$/); // let the bill screen's load land
    act(() => globalRouter.push(`/bills/${BILL}/settle`));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.getByText("You're all set. Hana can see it.")).toBeTruthy(); // positive marker: the card is the sent card
    expect(screen.queryByText('Did it go through?')).toBeNull();
  });

  it('40: the answer outlives a remount: a stored "yes" keeps it away (the key is the mark, not the bill)', async () => {
    const r = await openSent();
    fireEvent.press(screen.getByLabelText('Yes, it went through'));
    await waitFor(() => expect(storedBlob()).toContain('"a":"yes"'));
    r.unmount();
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText("You're all set. Hana can see it.")).toBeTruthy();
    expect(screen.queryByText('Did it go through?')).toBeNull();
  });

  it('a new send (a new settled_at) asks again', async () => {
    storage.data.set(BLOB_KEY, JSON.stringify({ [`${BILL}.${A}.${Date.parse(OLD)}`]: { a: 'yes', t: Date.now() } }));
    await openSent(); // the fresh mark's key has no answer
    expect(screen.getByText('Did it go through?')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Coming back to the app (D3): background → active cancels; inactive → active doesn't
// ---------------------------------------------------------------------------

describe('cancel on return', () => {
  it('background → active cancels and dismisses this user\'s check-ins and keeps the question', async () => {
    const app = captureAppState();
    Object.assign(me(B), { mark: 1510, method: 'venmo', at: new Date().toISOString() });
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    await screen.findByText('Did it go through?');
    await app.send('background');
    expect(notif.cancelSentChecks).not.toHaveBeenCalled();
    await app.send('active');
    await waitFor(() => expect(notif.cancelSentChecks).toHaveBeenCalledWith(B));
    expect(screen.getByText('Did it go through?')).toBeTruthy();
    app.restore();
  });

  it('inactive → active (Control Centre, a system sheet) cancels nothing', async () => {
    const app = captureAppState();
    await openSettle();
    await app.send('inactive');
    await app.send('active');
    await act(async () => {});
    expect(screen.getByText('You owe Hana')).toBeTruthy(); // positive marker: the screen is up and listening
    expect(notif.cancelSentChecks).not.toHaveBeenCalled();
    app.restore();
  });
});

// ---------------------------------------------------------------------------
// Entry paths: pushed, cold deep link, after the sign-in landing (native callback and web OAuth on /)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('entry paths on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    setBrowser(IPHONE, 5); // web: mobile, so the send records
  });

  async function payAndExpectSent() {
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  }

  it('pushed from the bill screen', async () => {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText(/^Total \$/);
    act(() => globalRouter.push(`/bills/${BILL}/settle`));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await screen.findByText('You owe Hana');
    await payAndExpectSent();
  });

  it('a cold deep link writes nothing on its own, and Pay works', async () => {
    await openSettle();
    act(() => jest.advanceTimersByTime(5000));
    expect(supabase.rpc.mock.calls.filter(([fn]) => !['mark_bill_seen', 'venmo_prompt_pending'].includes(fn))).toHaveLength(0);
    await payAndExpectSent();
  });

  it('after the sign-in landing (/auth/callback native, / on web): the screen opens only when navigated to', async () => {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: os === 'web' ? '/' : '/auth/callback' });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    act(() => globalRouter.push(`/bills/${BILL}/settle`));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await screen.findByText('You owe Hana');
    await payAndExpectSent();
    expect(router.getPathname()).toBe(`/bills/${BILL}/settle`); // the send never navigates
  });

  it('criterion 43: the Settle screen marks the bill seen after the data lands, and once on blur', async () => {
    const router = await openSettle();
    expect(rpcCalls('mark_bill_seen')).toHaveLength(0); // debounced, not at once
    act(() => jest.advanceTimersByTime(SEEN_DEBOUNCE_MS));
    await waitFor(() => expect(rpcCalls('mark_bill_seen')).toHaveLength(1));
    expect(rpcCalls('mark_bill_seen')[0]?.[1]).toEqual({ p_bill_id: BILL });
    const seen = rpcCalls('mark_bill_seen').length;
    // Profile marks nothing itself, so a new call is the Settle screen's blur.
    act(() => globalRouter.push('/profile'));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    await waitFor(() => expect(rpcCalls('mark_bill_seen').length).toBe(seen + 1));
  });
});

// ---------------------------------------------------------------------------
// Review fixes (R1, R3, R4, R10): Venmo already open when the write is refused, and the async edges
// ---------------------------------------------------------------------------

const ALREADY_AFTER_OPEN = "Venmo opened, but this was already marked. Don't send it. Check Venmo before you pay again.";
const PAYER_CHANGED_AFTER_OPEN = "Venmo opened, but who gets paid just changed. Don't send it. Check below before you pay.";

describe('R1: web, Venmo is already open when the write is refused', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'web');
    setBrowser(IPHONE, 5);
  });

  it('created = false → the tab we opened is closed, the post-open line says to check Venmo, and a refetch', async () => {
    const w = tab();
    openWeb.mockReturnValueOnce(w);
    await openSettle();
    // Another device marked it after this screen loaded.
    Object.assign(me(B), { mark: 1510, method: 'venmo' });
    const before = billFetches();
    fireEvent.press(screen.getByLabelText(PAY));
    const line = await screen.findByText(ALREADY_AFTER_OPEN);
    expect(line).toBeTruthy();
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You've already marked this. Check below.")).toBeNull();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(0); // the existing mark is never touched
  });

  it('payer_changed → the tab is closed, the post-open line, and a refetch', async () => {
    const w = tab();
    openWeb.mockReturnValueOnce(w);
    next.mark = { code: '22023', message: 'payer_changed' };
    await openSettle();
    const before = billFetches();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(PAYER_CHANGED_AFTER_OPEN)).toBeTruthy();
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(BILL_ERROR_COPY.payer_changed)).toBeNull();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByLabelText(PAY).props.accessibilityState?.disabled).toBe(false));
  });

  it('a network error leaves the tab open and asks (contract O): the outcome is unknown', async () => {
    const w = tab();
    openWeb.mockReturnValueOnce(w);
    next.mark = { code: '08006', message: 'down' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    expect(w.close).not.toHaveBeenCalled();
  });

  it('a close() that throws (the browser refuses) still shows the line', async () => {
    const w = { closed: false, opener: null, close: jest.fn(() => { throw new Error('nope'); }) };
    openWeb.mockReturnValueOnce(w);
    next.mark = { code: '22023', message: 'payer_changed' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(PAYER_CHANGED_AFTER_OPEN)).toBeTruthy();
  });
});

describe('R3 (a): the check-in schedule fails or hangs', () => {
  it('scheduleSentCheck resolves false → Venmo still opens, nothing to cancel', async () => {
    notif.scheduleSentCheck.mockResolvedValueOnce(false);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledWith(URL));
    expect(notif.scheduleSentCheck).toHaveBeenCalledTimes(1);
    expect(notif.cancelSentCheck).not.toHaveBeenCalled();
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
  });

  it('scheduleSentCheck never resolves → Venmo opens within SCHEDULE_TIMEOUT_MS, and the late schedule is cancelled', async () => {
    const never = deferred<boolean>();
    notif.scheduleSentCheck.mockReturnValueOnce(never.promise);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(notif.scheduleSentCheck).toHaveBeenCalledTimes(1));
    expect(openLink).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(SCHEDULE_TIMEOUT_MS));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    const id = (notif.scheduleSentCheck.mock.calls[0]?.[0] as { identifier: string }).identifier;
    expect(notif.cancelSentCheck).toHaveBeenCalledWith(id);
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
  });
});

describe('R3 (b) and R4: Venmo never opened, but the mark may have landed', () => {
  it('(b) a 4 s timeout, then the open fails, then the late markPaid lands created → exactly one unmark_paid', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    const mark = deferred();
    next.markHold = mark.promise;
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(MARK_BEFORE_OPEN_TIMEOUT_MS));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(0); // nothing to undo yet
    next.markHold = null;
    await act(async () => mark.resolve());
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    act(() => jest.advanceTimersByTime(10_000));
    await act(async () => {});
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: A }]]);
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
  });

  it('R4: a network error that hid a landed mark, then the open fails → re-read, and the mark is cleared', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.markLandsThenFails = true;
    await openSettle();
    const before = billFetches();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    expect(billFetches()).toBeGreaterThan(before); // the re-read that found it
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.queryByText('You sent Hana')).toBeNull();
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
  });

  it('R4 control: a network error where nothing landed → re-read, nothing to clear', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.mark = { code: '08006', message: 'down' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    act(() => jest.advanceTimersByTime(10_000));
    await act(async () => {});
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });

  it('R4 control: an older mark (another device, long ago) is never cleared', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.mark = { code: '08006', message: 'down' };
    await openSettle();
    Object.assign(me(B), { mark: 1510, method: 'venmo', at: OLD });
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    // The re-read shows the old mark, so the card is the sent card again (the open-failed line went with Pay).
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    act(() => jest.advanceTimersByTime(10_000));
    await act(async () => {});
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
  });

  it('review round 2 R2: the late-send clear has a time limit too: a hung unmark_paid gives the undo line and Pay back', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.markLandsThenFails = true;
    const unmark = deferred();
    next.unmarkHold = unmark.promise;
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1)); // the re-read found this send
    expect(screen.queryByText("Couldn't undo. Try again.")).toBeNull();
    await act(async () => jest.advanceTimersByTime(UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(PAY)?.props.accessibilityState?.disabled ?? false).toBe(false));
    // The late unmark lands: the screen re-reads and shows what the server has.
    const before = billFetches();
    next.unmarkHold = null;
    await act(async () => unmark.resolve());
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
  });

  it('review round 2 R2: the late-send clear is refused → the undo line, and the screen shows the mark that stayed', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.markLandsThenFails = true;
    next.unmark = { code: '42501', message: 'permission denied' };
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    expect(await screen.findByText('You sent Hana')).toBeTruthy(); // never back to Pay while a mark stands
  });

  it('review round 2 R3: a ledger that does not read during the late-send clear → the undo line, nothing cleared', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    next.markLandsThenFails = true;
    await openSettle();
    // The re-read after the failed open brings entries the pair rule refuses (pairState's RangeError).
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const undoModule = jest.requireActual<typeof import('@/lib/sentCheckUndo')>('@/lib/sentCheckUndo');
    const pairMark = jest.spyOn(undoModule, 'pairMarkOf').mockImplementation(() => {
      throw new RangeError('pairState: bad entry');
    });
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    expect(pairMark).toHaveBeenCalled();
    pairMark.mockRestore();
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('R10: the undo after a failed open has a time limit: the button comes back, with the undo line', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    const unmark = deferred();
    next.unmarkHold = unmark.promise;
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
    act(() => jest.advanceTimersByTime(UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText(PAY)?.props.accessibilityState?.disabled ?? false).toBe(false));
    // The late unmark lands: the screen re-reads and shows what the server has.
    next.unmarkHold = null;
    await act(async () => unmark.resolve());
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
  });
});

describe('R3 (c) and R10: sign-out during a send', () => {
  it('signed out while the mark is in flight → nothing is scheduled for the signed-out user', async () => {
    const mark = deferred();
    next.markHold = mark.promise;
    const r = await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    await act(async () => {
      await supabase.auth.signOut();
    });
    await waitFor(() => expect(r.getPathname()).toBe('/sign-in'));
    next.markHold = null;
    await act(async () => mark.resolve());
    // The mark was made: Venmo still opens, so "Sent" stays true. No check-in, though.
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(notif.scheduleSentCheck).not.toHaveBeenCalled();
  });

  it('signed out while the check-in is being scheduled → that check-in is cancelled once it lands', async () => {
    const scheduling = deferred<boolean>();
    notif.scheduleSentCheck.mockReturnValueOnce(scheduling.promise);
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(notif.scheduleSentCheck).toHaveBeenCalledTimes(1));
    await act(async () => {
      await supabase.auth.signOut();
    });
    await act(async () => scheduling.resolve(true));
    const id = (notif.scheduleSentCheck.mock.calls[0]?.[0] as { identifier: string }).identifier;
    await waitFor(() => expect(notif.cancelSentCheck).toHaveBeenCalledWith(id));
  });

  it('control: still signed in → the check-in stays', async () => {
    await openSettle();
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(notif.scheduleSentCheck).toHaveBeenCalledTimes(1);
    expect(notif.cancelSentCheck).not.toHaveBeenCalled();
  });
});

describe.each(['ios', 'web'] as const)('R10: the 30-minute inline window is re-checked on %s', (os) => {
  const WINDOW = SENT_CHECK_INLINE_MAX_MINUTES * 60_000;

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Settle up: the question goes once the mark passes 30 minutes, with nothing else re-rendering', async () => {
    Object.assign(me(B), { mark: 1510, method: 'venmo', at: new Date(Date.now() - WINDOW + 2000).toISOString() });
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText('Did it go through?')).toBeTruthy();
    act(() => jest.advanceTimersByTime(3000));
    await waitFor(() => expect(screen.queryByText('Did it go through?')).toBeNull());
    expect(screen.getByText('You sent Hana')).toBeTruthy(); // positive marker: the sent card is still there
  });

  it('the bill screen footer: the same', async () => {
    Object.assign(me(B), { mark: 1510, method: 'venmo', at: new Date(Date.now() - WINDOW + 2000).toISOString() });
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText('Did your $15.10 to Hana go through?')).toBeTruthy();
    act(() => jest.advanceTimersByTime(3000));
    await waitFor(() => expect(screen.queryByText('Did your $15.10 to Hana go through?')).toBeNull());
    expect(screen.getByText(/^Total \$/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// QA N3: the write landed, but every refetch after it failed. Nothing optimistic: the card keeps
// what the server last confirmed ("You owe Hana"), so the screen must say the payment was saved and
// hold Pay until a refetch lands, or the person could pay twice.
// ---------------------------------------------------------------------------

const SAVED_NOT_REFRESHED = "Your payment was saved, but we couldn't refresh. Try again before you pay again.";
const CASH = 'I paid Hana $15.10 in cash';
/** Whether `node` sits inside an element with role "alert" (the Banner's or the footer line's). */
function inAlert(node: unknown): boolean {
  for (let n = node as { props: { accessibilityRole?: string }; parent: unknown } | null; n; n = n.parent as typeof n) {
    if (n.props.accessibilityRole === 'alert') return true;
  }
  return false;
}
const isDisabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled === true;
const isBusy = (label: string) => screen.getByLabelText(label).props.accessibilityState?.busy === true;

describe.each(['ios', 'web'] as const)('N3: saved, but the screen couldn\'t refresh, on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    setBrowser(IPHONE, 5); // web: mobile, so the send records
  });
  const opens = () => (os === 'web' ? openWeb : openLink).mock.calls.length;

  it('Settle up, Pay: the message (an alert), Pay held, no "Sent"; a failed retry stays held; a landed retry recovers', async () => {
    await openSettle();
    next.failReads = true;
    fireEvent.press(screen.getByLabelText(PAY));
    const msg = await screen.findByText(SAVED_NOT_REFRESHED);
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    expect(me(B).mark).toBe(1510); // positive control: the write landed on the server
    // Only what the server confirmed: still "You owe Hana", never an optimistic "Sent".
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.queryByText('You sent Hana')).toBeNull();
    expect(inAlert(msg)).toBe(true); // announced
    // Pay is held (disabled, not spinning), and a tap does nothing.
    expect(isDisabled(PAY)).toBe(true);
    expect(isBusy(PAY)).toBe(false);
    expect(isDisabled('Paid another way')).toBe(true);
    const opened = opens();
    act(() => jest.advanceTimersByTime(PAY_REPEAT_MS + 1));
    fireEvent.press(screen.getByLabelText(PAY));
    expect(opens()).toBe(opened);
    expect(rpcCalls('mark_paid')).toHaveLength(1);

    // Try again while reads still fail: it spins, then the message stays and Pay stays held.
    const fetchesBefore = billFetches();
    fireEvent.press(screen.getByLabelText('Try again'));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(fetchesBefore));
    await waitFor(() => expect(isBusy('Try again')).toBe(false));
    expect(screen.getByText(SAVED_NOT_REFRESHED)).toBeTruthy();
    expect(isDisabled(PAY)).toBe(true);

    // Try again once reads work: the sent card, the message gone.
    next.failReads = false;
    fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.queryByText(SAVED_NOT_REFRESHED)).toBeNull();
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  });

  it('Settle up, Cash: the same message and hold; any later refetch that lands releases it', async () => {
    storage.data.set(METHOD_KEY, 'cash');
    await openSettle();
    next.failReads = true;
    fireEvent.press(screen.getByLabelText(CASH));
    expect(await screen.findByText(SAVED_NOT_REFRESHED)).toBeTruthy();
    expect(isDisabled(CASH)).toBe(true);
    expect(screen.queryByText('You paid Hana')).toBeNull();
    // A realtime hint (not Try again) that lands is just as good.
    next.failReads = false;
    await act(async () => liveChannel().__broadcast('changed'));
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(screen.queryByText(SAVED_NOT_REFRESHED)).toBeNull();
  });

  it('control: a write that was refused shows its own error, not "saved"', async () => {
    await openSettle();
    next.failReads = true;
    next.mark = { code: 'P0001', message: 'payer_changed' };
    fireEvent.press(screen.getByLabelText('Paid another way'));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    await waitFor(() => expect(isBusy('Paid another way')).toBe(false));
    expect(screen.queryByText(SAVED_NOT_REFRESHED)).toBeNull();
  });

  it('the bill screen footer: the message, Pay held; Try again recovers to the inline check', async () => {
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText(/^Total \$/);
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
    next.failReads = true;
    fireEvent.press(screen.getByLabelText(PAY));
    expect(inAlert(await screen.findByText(SAVED_NOT_REFRESHED))).toBe(true);
    expect(me(B).mark).toBe(1510);
    expect(isDisabled(PAY)).toBe(true);
    expect(isBusy(PAY)).toBe(false);
    next.failReads = false;
    fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('Did your $15.10 to Hana go through?')).toBeTruthy();
    expect(screen.queryByText(SAVED_NOT_REFRESHED)).toBeNull();
  });
});

describe.each(['ios', 'web'] as const)('only the pressed button is busy, on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Cash: its button spins; "Paid another way" is disabled but not busy', async () => {
    storage.data.set(METHOD_KEY, 'cash');
    let release: () => void = () => {};
    await openSettle();
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText(CASH));
    expect(isBusy(CASH)).toBe(true);
    expect(isBusy('Paid another way')).toBe(false);
    expect(isDisabled('Paid another way')).toBe(true);
    next.hold = null;
    await act(async () => release());
    await screen.findByText('You paid Hana');
  });

  it('"Paid another way": it spins; the Pay button is disabled but not busy', async () => {
    let release: () => void = () => {};
    await openSettle();
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText('Paid another way'));
    expect(isBusy('Paid another way')).toBe(true);
    expect(isBusy(PAY)).toBe(false);
    expect(isDisabled(PAY)).toBe(true);
    next.hold = null;
    await act(async () => release());
    await screen.findByText('You paid Hana');
  });
});
