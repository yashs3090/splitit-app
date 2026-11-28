// Settle up screen: criteria 42–53a in docs/specs/2026-11-24-m3-settle-venmo.md (Amendment A1, Task 9),
// copy from docs/specs/2026-11-24-m3-settle-ux.md §10.
//
// The bill is the spec's D3 worked example: Burger 15.00 (Hana), Salad 10.00 (Sam), Fries 6.00
// (both), total 36.00, proportional. Hana (A) hosts and is the payer (handle hana-1); Sam (B) owes
// $15.10. Dee (D) joins in some tests; C is an outsider.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import Check from 'lucide-react-native/icons/check';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { AccessibilityInfo, AppState, Platform, StyleSheet, type AppStateStatus } from 'react-native';

import { BILL_ERROR_COPY, fetchBill } from '@/lib/bills';
import { settleViewInputFor } from '@/lib/settleView';
import { openPaymentLink, openPaymentLinkWeb } from '@/lib/paylinks';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { savePendingInvite } from '@/lib/pendingInvite';
import { SETTLE_ALL_ZERO_COPY } from '@/lib/settle';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors, TOUCH_TARGET } from '@/lib/theme';
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
    // Web: a tab that stays open. Desktop web (no phone user agent here) asks on return either way.
    openPaymentLinkWeb: jest.fn(() => ({ closed: false, opener: null })),
  };
});
// Notifications: denied by default here (no permission note, nothing scheduled); the send tests in
// __tests__/useVenmoSend.test.tsx grant it.
jest.mock('@/lib/checkInNotifications', () => ({
  supported: true,
  notificationPermission: jest.fn(async () => 'denied'),
  askNotificationPermissionOnce: jest.fn(async () => 'denied'),
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
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const BURGER = '22222222-0000-4000-8000-000000000001';
const SALAD = '22222222-0000-4000-8000-000000000002';
const FRIES = '22222222-0000-4000-8000-000000000003';
const CODE = '0123456789abcdef0123';
const MONEY = /\$[\d,]+\.\d\d/;
const AT = '2026-11-24T19:30:00Z';

type Claim = { line_item_id: string; user_id: string; parts: number };
/**
 * A participant. `at` is the mark's settled_at (default AT, long past, so no inline check); a mark
 * made through the fake mark_paid gets the current time. `nr` is the payer's Not received flag.
 */
type Person = {
  id: string;
  name: string;
  venmo: string | null;
  mark: number | null;
  method?: PaymentMethod;
  at?: string;
  nr?: { cents: number; method: PaymentMethod; by: string } | null;
};

const db: {
  bill: Record<string, unknown>;
  rows: Record<string, unknown>[];
  people: Person[];
  claims: Claim[];
  fail: boolean;
} = { bill: {}, rows: [], people: [], claims: [], fail: false };

/** What the next rpc call of each kind returns (default: success, applied to `db`). */
const next: {
  mark: FakeDbError | null;
  /** mark_not_received's answer (default: success, applied to `db`). */
  notReceived: FakeDbError | null;
  unmark: FakeDbError | null;
  /** settle_difference's answer (default: success, applied to `db`; 0 clears the mark). */
  diff: FakeDbError | null;
  setPayer: FakeDbError[];
  hold: Promise<void> | null;
  /** After a successful write, every bills read fails (the screen's own refetch fails). */
  failReadsAfterWrite: boolean;
  /** The next bills read waits for this (one shot). */
  holdNextRead: Promise<void> | null;
} = { mark: null, notReceived: null, unmark: null, diff: null, setPayer: [], hold: null, failReadsAfterWrite: false, holdNextRead: null };

function row(id: string, name: string, cents: number, g: number) {
  return { id, name, note: null, group_position: g, unit_index: 0, group_size: 1, total_cents: cents, split_set_by: null, split_set_at: null };
}
/** The decoded `note` parameter of a Venmo link. */
function noteOf(url: string | undefined): string | null {
  if (url === undefined) throw new Error('no link opened');
  return new URL(url).searchParams.get('note');
}
/** Venmo note spec criterion 8: the note never carries people's names or the amount. */
function expectPrivateNote(url: string | undefined) {
  const note = noteOf(url);
  for (const secret of ['Hana', 'Sam', '15.10']) expect(note).not.toContain(secret);
}
const claim = (rowId: string, userId: string): Claim => ({ line_item_id: rowId, user_id: userId, parts: 1 });
const person = (id: string, name: string, venmo: string | null = null, mark: number | null = null): Person => ({ id, name, venmo, mark });
const me = (id: string) => {
  const p = db.people.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
};

function reset() {
  db.bill = {
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
    join_code: CODE,
    group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
    created_at: '2026-11-24T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
  db.rows = [row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)];
  db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam')];
  db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, A), claim(FRIES, B)];
  db.fail = false;
  next.mark = null;
  next.notReceived = null;
  next.unmark = null;
  next.diff = null;
  next.setPayer = [];
  next.hold = null;
  next.failReadsAfterWrite = false;
  next.holdNextRead = null;
}

function installServer() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', async () => {
    const hold = next.holdNextRead;
    next.holdNextRead = null;
    const failed = db.fail; // decided when the read starts
    const snapshot = { ...db.bill };
    if (hold) await hold;
    return failed ? { data: null, error: { code: '08006', message: 'server text' } } : ok(snapshot);
  });
  supabase.__setTable('line_items', () => ok(db.rows.map((r) => ({ ...r }))));
  supabase.__setTable('bill_participants', () =>
    ok(
      db.people.map((p, i) => ({
        user_id: p.id,
        joined_at: `2026-11-24T19:0${i}:00Z`,
        settled_at: p.mark === null ? null : (p.at ?? AT),
        settled_cents: p.mark,
        settled_method: p.mark === null ? null : (p.method ?? 'other'),
        not_received_cents: p.nr?.cents ?? null,
        not_received_method: p.nr?.method ?? null,
        not_received_by: p.nr?.by ?? null,
        profile: { display_name: p.name, venmo_username: p.venmo },
      })),
    ),
  );
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  // One payer unless a test says otherwise (a stub set by one test must not leak into the next).
  supabase.__setTable('bill_payers', () => ok([]));
  supabase.__setTable('profiles', (q) => {
    const update = q.calls.find((c) => c.method === 'update');
    if (update) {
      const patch = update.args[0] as { venmo_username: string | null };
      me(viewer).venmo = patch.venmo_username;
      return ok([{ venmo_username: patch.venmo_username }]);
    }
    const p = me(viewer);
    return ok({ display_name: p.name, venmo_username: p.venmo });
  });
  supabase.__setRpc(async (fn, args) => {
    if (next.hold) await next.hold;
    const a = args ?? {};
    let data: unknown = null;
    if (fn === 'mark_paid') {
      if (next.mark) return { data: null, error: next.mark };
      const p = me(viewer);
      // returns table (settled_at, created): an existing mark is left alone (F3).
      if (p.mark !== null) {
        data = [{ settled_at: p.at ?? AT, created: false }];
      } else {
        p.mark = a.p_cents as number;
        p.method = a.p_method as PaymentMethod;
        p.at = new Date().toISOString();
        p.nr = null;
        data = [{ settled_at: p.at, created: true }];
      }
    } else if (fn === 'mark_not_received') {
      if (next.notReceived) return { data: null, error: next.notReceived };
      const p = me(a.p_user_id as string);
      if (p.mark !== null) p.nr = { cents: p.mark, method: p.method ?? 'other', by: viewer };
      p.mark = null;
      p.at = undefined;
      p.method = undefined;
    } else if (fn === 'unmark_paid') {
      if (next.unmark) return { data: null, error: next.unmark };
      const p = me(a.p_user_id as string);
      p.mark = null;
      p.at = undefined;
      p.method = undefined;
    } else if (fn === 'settle_difference') {
      if (next.diff) return { data: null, error: next.diff };
      const to = a.p_new_cents as number;
      const p = me(a.p_user_id as string);
      if (to === 0) {
        p.mark = null;
        p.at = undefined;
        p.method = undefined;
      } else {
        // A raise keeps the method when it's the same, else 'other' (SV-4); a pay-back keeps it.
        if (to > (p.mark ?? 0) && p.method !== a.p_method) p.method = 'other';
        p.mark = to;
      }
    } else if (fn === 'set_payer') {
      const err = next.setPayer.shift();
      if (err) return { data: null, error: err };
      if (a.p_payer_id !== db.bill.payer_id) {
        db.bill.payer_id = a.p_payer_id;
        db.people.forEach((p) => (p.mark = null));
      }
    } else if (fn === 'venmo_prompt_pending') {
      return ok(false);
    }
    if (next.failReadsAfterWrite && WRITE_FNS.includes(fn)) db.fail = true;
    return ok(data);
  });
}

let viewer = B;
function signInAs(id: string) {
  viewer = id;
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
const WRITE_FNS = ['mark_paid', 'unmark_paid', 'set_payer', 'set_payers', 'settle_difference', 'mark_not_received'];
const writes = () => supabase.rpc.mock.calls.filter(([name]) => WRITE_FNS.includes(name));
const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;

/** Runs `fn` with a phone browser's navigator (iPhone Safari), then puts the real one back. */
async function onPhoneBrowser(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { navigator?: unknown };
  const original = Object.getOwnPropertyDescriptor(g, 'navigator');
  Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', maxTouchPoints: 5 },
  });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(g, 'navigator', original);
    else delete g.navigator;
  }
}
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};
/** The element sits inside a Banner announced as an alert (accessibilityRole="alert"). */
function inAlert(el: { parent: unknown }): boolean {
  let node = el as { parent: unknown; props?: { accessibilityRole?: string } } | null;
  while (node) {
    if (node.props?.accessibilityRole === 'alert') return true;
    node = node.parent as typeof node;
  }
  return false;
}
/** The card renders before the Everyone list, so its line is the first match (rows repeat the method words). */
const inCard = (text: string) => {
  const first = screen.getAllByText(text)[0];
  if (!first) throw new Error(`no ${text}`);
  return first;
};
/**
 * The "Paid by …" line at the top (contract L, A1.5): plain text for guests, one button for the host
 * (its label adds ". Change who paid"). Throws if neither is on screen.
 */
function paidByLine(text: string) {
  return screen.queryByText(text) ?? screen.getByLabelText(`${text}. Change who paid`);
}
const CHANGE = /\. Change who paid$/;
const disabled = (label: string) => Boolean(screen.getByLabelText(label).props.accessibilityState?.disabled);

async function openSettle(as = B) {
  signInAs(as);
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
  await screen.findByText('Settle up');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  return router;
}

/** A server-side change arrives as a live hint; wait for the debounced refetch to land. */
async function liveChange() {
  const before = billFetches();
  await act(async () => liveChannel().__broadcast('changed'));
  await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
}

beforeEach(() => {
  // Tests replace Platform.OS and nothing restores it: start every test on the preset's 'ios'.
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  reset();
  installServer();
  signInAs(B);
});

// ---------------------------------------------------------------------------
// Entry paths (criterion 42), native and web
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('entry paths on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('pushed from the bill screen, and "Bill" dismisses back to it', async () => {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $36.00');
    // B owes Hana, who has Venmo: the footer offers Pay, and Details opens Settle up (request spec F1, F-c).
    fireEvent.press(screen.getByLabelText('Settle up details'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();

    const dismissTo = jest.spyOn(globalRouter, 'dismissTo');
    fireEvent.press(screen.getByLabelText('Back to the bill'));
    expect(dismissTo).toHaveBeenCalledWith(`/bills/${BILL}`);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
    dismissTo.mockRestore();
  });

  it('a cold deep link or web reload opens the screen directly; Back still lands on the bill', async () => {
    const router = await openSettle(B);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Back to the bill'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
  });

  it('signed out: redirects to sign-in and reads nothing', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(billFetches()).toBe(0);
  });

  it('with a pending invite saved: the resume effect wins, and the settle screen writes nothing', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    signInAs(B);
    supabase.__setRpc(async (fn) => (fn === 'join_bill' ? { data: BILL, error: null } : { data: null, error: null }));
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    // /b/<code> joins and opens the bill: the only navigation is the root layout's.
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
    expect(rpcCalls('join_bill')).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('a non-participant gets the not-found state', async () => {
    signInAs(C);
    supabase.__setTable('bills', () => ({ data: null, error: null }));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText(BILL_ERROR_COPY.not_found)).toBeTruthy();
    expect(screen.getByText('Go home')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('coming back from Profile (/account) after "Add Venmo" refetches and drops the card', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    const router = await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Venmo'));
    // Tab-bar spec criterion 41: Profile above Settle (/account), so one Back returns to this Settle.
    await waitFor(() => expect(router.getPathname()).toBe('/account'));
    me(A).venmo = 'hana-1'; // saved on Profile
    const before = billFetches();
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText('Add your Venmo so people can pay you')).toBeNull());
  });

  it('a failed load shows fixed copy and retries', async () => {
    db.fail = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    db.fail = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Owes (criteria 44–46)
// ---------------------------------------------------------------------------

describe('owes', () => {
  const PAY = 'Pay Hana $15.10 on Venmo, to @hana-1';
  const OPEN_FAILED = "Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.";

  it('44: shows the amount, the chooser (Venmo), Pay, the handle line and "Paid another way"', async () => {
    await openSettle(B);
    expect(paidByLine('Paid by Hana')).toBeTruthy();
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getAllByText('$15.10')).toHaveLength(2); // the card, and Sam's row in Everyone
    expect(screen.getByLabelText("How you're paying").props.accessibilityRole).toBe('radiogroup');
    expect(screen.getByLabelText("Venmo, how you're paying").props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByLabelText("Cash, how you're paying").props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByText('Pay Hana $15.10 on Venmo')).toBeTruthy();
    expect(screen.getByText('@hana-1 · $15.10')).toBeTruthy();
    expect(screen.getByText('Paid another way')).toBeTruthy();
    expect(screen.queryByLabelText(CHANGE)).toBeNull(); // host only
  });

  it('44 (native): Pay records "venmo" first, then opens Venmo with the exact link; the card is already "You sent Hana"', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    fireEvent.press(screen.getByLabelText(PAY));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510, p_method: 'venmo', p_plan_key: key }]]);
    expect(supabase.rpc.mock.invocationCallOrder[supabase.rpc.mock.calls.findIndex(([n]) => n === 'mark_paid')]).toBeLessThan(
      openLink.mock.invocationCallOrder[0] ?? 0,
    );
    // Venmo note spec criteria 7–8: Sam's own items (Salad, shared Fries); no names or amounts.
    expect(openLink).toHaveBeenCalledWith('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(inCard('Sent via Venmo').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText('Did it go through?')).toBeTruthy();
    expect(screen.queryByText('Pay Hana $15.10 on Venmo')).toBeNull(); // decision 5: no Pay once sent
  });

  it('44a (mobile web): a phone\'s browser shows no "On a computer?" line under Pay (SV-WEB-1)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await onPhoneBrowser(async () => {
      await openSettle(B);
      expect(screen.getByText('@hana-1 · $15.10')).toBeTruthy(); // positive control: the notes are there
      expect(screen.queryByText(/^On a computer\?/)).toBeNull();
    });
  });

  it('44a: the "On a computer?" line shows on web and not on iOS; desktop web asks on return and writes nothing', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const r = await openSettle(B);
    expect(screen.queryByText('On a computer? Send it from the Venmo app on your phone.')).toBeNull();
    r.unmount();
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    expect(screen.getByText('On a computer? Send it from the Venmo app on your phone.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText(PAY));
    expect(openWeb).toHaveBeenCalledTimes(1); // synchronously, inside the tap
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
    expect(screen.getByText('Yes, I sent it')).toBeTruthy();
    expect(screen.getByText('Open Venmo again')).toBeTruthy();
    expect(screen.getByText('On a computer? Send it from the Venmo app on your phone.')).toBeTruthy();
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    act(() => jest.advanceTimersByTime(1000)); // R7: taps within ~1 s of the last Pay are ignored
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openWeb).toHaveBeenCalledTimes(2);
    expect(rpcCalls('mark_paid')).toHaveLength(0);
  });

  it.each([
    ['Paid another way', 'other', 'You paid Hana', 'Marked paid'],
    ['Yes, I sent it', 'venmo', 'You sent Hana', 'Sent via Venmo'],
  ] as const)('45: "%s" marks with the shown payer, amount and method; nothing is optimistic', async (label, method, cardLabel, line) => {
    let release: () => void = () => {};
    if (label === 'Yes, I sent it') jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    if (label === 'Yes, I sent it') {
      fireEvent.press(screen.getByLabelText(PAY));
      await screen.findByText('Did you send Hana $15.10?');
    }
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText(label));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510, p_method: method, p_plan_key: key }]]);
    expect(disabled(label)).toBe(true);
    expect(screen.queryByText(line)).toBeNull();
    // A second tap while in flight sends nothing.
    fireEvent.press(screen.getByLabelText(label));
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    next.hold = null;
    await act(async () => release());
    expect(await screen.findByText(cardLabel)).toBeTruthy();
    expect(inCard(line).props.accessibilityLiveRegion).toBe('polite');
    // "Yes, I sent it" has just answered the question: the inline check never follows it (D2).
    expect(screen.queryByText('Did it go through?')).toBeNull();
    expect(screen.getByText("You're all set. Hana can see it.")).toBeTruthy();
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  });

  it('45: "Marked paid" is announced on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Paid another way'));
    await screen.findByText('You paid Hana');
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Marked paid'));
    announce.mockRestore();
  });

  it.each([
    ['network', { code: '08006', message: 'server text' }, "Couldn't save. Try again.", false],
    ['payer_changed', { code: '22023', message: 'payer_changed' }, BILL_ERROR_COPY.payer_changed, true],
    // Settle early (SE-UX-13, Task 6): the Settle screen has its own not_complete copy.
    ['not_complete', { code: '22023', message: 'not_complete' }, 'Something on the bill just changed. Check your share and try again.', true],
    ['not_allowed', { code: '42501', message: 'not_allowed' }, BILL_ERROR_COPY.not_allowed, false],
    ['invalid_bill', { code: '22023', message: 'is_payer' }, "Couldn't save. Refresh and try again.", true],
    // Delete group A3.4: a lock clash aborted the mark (40P01). Definite, so no re-read; retry works.
    ['busy', { code: '40P01', message: 'server text: deadlock detected' }, "That didn't go through. Please try again.", false],
  ] as const)('45: %s shows its copy and re-enables the button', async (_code, error, copy, refetches) => {
    await openSettle(B);
    next.mark = error;
    const before = billFetches();
    fireEvent.press(screen.getByLabelText('Paid another way'));
    const banner = await screen.findByText(copy);
    expect(inAlert(banner)).toBe(true);
    expect(screen.queryByText(/server text/)).toBeNull();
    await waitFor(() => expect(disabled('Paid another way')).toBe(false));
    if (refetches) await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    else expect(billFetches()).toBe(before);
    expect(screen.queryByText('Marked paid')).toBeNull();
  });

  it('45 (native): Venmo failing to open undoes the mark and shows the fallback on the owes card', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: A }]]);
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.queryByText('Sent via Venmo')).toBeNull();
  });

  it('45a: after a desktop-web Pay, the payer changes to Dee: notice, Dee\'s default, and no button marks Hana', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY));
    await screen.findByText('Did you send Hana $15.10?');
    db.bill.payer_id = D;
    await liveChange();
    expect(await screen.findByText('Dee is now collecting for this bill. If you already paid Hana, sort it out with them.')).toBeTruthy();
    expect(screen.getByText('You owe Dee')).toBeTruthy();
    expect(screen.queryByText('Did you send Hana $15.10?')).toBeNull();
    fireEvent.press(screen.getByLabelText('Paid another way'));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(rpcCalls('mark_paid').every(([, args]) => (args as { p_payer_id: string }).p_payer_id !== A)).toBe(true);
    expect(await screen.findByText('You paid Dee')).toBeTruthy();
  });

  it('46: the payer has no Venmo: no chooser, no Pay; the cash primary marks "cash"', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    expect(screen.getByText("Hana hasn't added Venmo yet.")).toBeTruthy();
    expect(screen.queryByLabelText("How you're paying")).toBeNull();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
    fireEvent.press(screen.getByLabelText('I paid Hana $15.10 in cash'));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510, p_method: 'cash', p_plan_key: key }]]);
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(inCard('Paid in cash')).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
  });

  it('46: the payer without a handle sees "Add Venmo", which opens Profile (/account, tab-bar criterion 41)', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    const router = await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Venmo'));
    await waitFor(() => expect(router.getPathname()).toBe('/account'));
    expect(await screen.findByLabelText('Venmo username')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Blocked, nothing, negative, payer (criteria 43, 43a, 43b, 47, 48)
// ---------------------------------------------------------------------------

describe('other roles and states', () => {
  it('R1 (Amendment A1): blocked by an unclaimed discount only names the discount', async () => {
    const comp = { ...row('22222222-0000-4000-8000-000000000004', 'Police comp', -500, 3), kind: 'discount', applies_to: 'subtotal' };
    db.rows = [...db.rows, comp];
    // Task 6: a proportional bill is now an early plan, so the blocked card needs an even split.
    db.bill.extras_split = 'equal';
    await openSettle(B);
    expect(screen.getByText('You can settle up once every discount is claimed (1 discount left).')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('Venmo note criterion 8: a claimed discount ("Police comp") stays out of the note', async () => {
    const COMP = '22222222-0000-4000-8000-000000000004';
    const comp = { ...row(COMP, 'Police comp', -500, 3), kind: 'discount', applies_to: 'subtotal' };
    db.rows = [...db.rows, comp];
    db.claims = [...db.claims, claim(COMP, B)];
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(/^Pay Hana \$[\d.]+ on Venmo, to @hana-1$/));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    const note = noteOf(openLink.mock.calls[0]?.[0]);
    expect(note).toBe('SplitIt: Salad, Fries');
    expect(note).not.toContain('Police comp');
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
  });

  it('43: blocked (1 item left): no amounts, no buttons but Back, no Everyone list', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    db.bill.extras_split = 'equal'; // Task 6: proportional incomplete bills are early plans now
    const router = await openSettle(B);
    expect(screen.getByText('You can settle up once every item is claimed (1 item left).')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
    expect(screen.queryByText('I already paid')).toBeNull();
    expect(screen.queryByText('I paid')).toBeNull();
    expect(screen.queryByText('Everyone')).toBeNull();
    expect(screen.queryByText('Your "I paid" is saved.')).toBeNull();
    // The card's primary (the header's "Bill" back control carries the same label and does the same thing).
    const back = screen.getAllByLabelText('Back to the bill');
    expect(back).toHaveLength(2);
    fireEvent.press(screen.getByText('Back to the bill'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
  });

  it('43: blocked with the viewer marked says the mark is saved, with no amount', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    db.bill.extras_split = 'equal'; // Task 6: proportional incomplete bills are early plans now
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText('Your "I paid" is saved.')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('43a: every item $0: the host gets the fix copy and Edit items; a guest gets the ask copy', async () => {
    db.rows = db.rows.map((r) => ({ ...r, total_cents: 0 }));
    db.bill.tax_cents = 3600;
    const router = await openSettle(A);
    expect(screen.getByText(SETTLE_ALL_ZERO_COPY)).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
    fireEvent.press(screen.getByLabelText('Edit items'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/edit`));
    router.unmount();

    await openSettle(B);
    expect(screen.getByText('Every item is $0. Ask Hana to fix the prices.')).toBeTruthy();
    expect(screen.queryByText('Edit items')).toBeNull();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('43b: a bad payer shows an error and Try again, and never refetches on its own', async () => {
    db.bill.payer_id = C;
    await openSettle(B);
    expect(screen.getByText('Something went wrong loading this bill.')).toBeTruthy();
    const before = billFetches();
    // renderRouter runs on fake timers: let any pending timer (live debounce, retries) fire.
    act(() => jest.advanceTimersByTime(10_000));
    expect(billFetches()).toBe(before);
    db.bill.payer_id = A;
    fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(billFetches()).toBe(before + 1);
  });

  it('47: nothing owed: "You\'re all set", no buttons', async () => {
    db.people = [...db.people, person(D, 'Dee')];
    await openSettle(D);
    expect(screen.getByText("You're all set")).toBeTruthy();
    expect(screen.getByText("You don't owe anything on this bill.")).toBeTruthy();
    expect(screen.queryByText('I already paid')).toBeNull();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
  });

  it('47: negative share (even mode, items 1000/0, total 800): "Hana owes you $1.00"', async () => {
    db.rows = [row(BURGER, 'Steak', 1000, 0), row(SALAD, 'Water', 0, 1)];
    db.claims = [claim(BURGER, A), claim(SALAD, B)];
    db.bill = { ...db.bill, total_cents: 800, tax_cents: 0, total_discount_cents: 200, extras_split: 'equal' };
    await openSettle(B);
    expect(screen.getByText('Hana owes you')).toBeTruthy();
    expect(screen.getByText('$1.00')).toBeTruthy();
    expect(screen.getByText('Settle that outside the app.')).toBeTruthy();
    expect(screen.queryByText('I already paid')).toBeNull();
  });

  it('48: the payer sees who owes and who settled, then "Everyone\'s settled up. Nice."', async () => {
    // No extras (total 3100): Sam owes Salad + half the Fries = 1300; Dee owes half the Fries = 300.
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1300), person(D, 'Dee')];
    db.rows = [row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, B), claim(FRIES, D)];
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    await openSettle(A);
    expect(screen.getByLabelText('Paid by you. Change who paid')).toBeTruthy();
    expect(screen.getByText('2 people owe you')).toBeTruthy();
    expect(screen.getByText('$16.00')).toBeTruthy(); // 1300 + 300
    // R4: only the card says it; the payer's Everyone list has no aside.
    expect(screen.getAllByText('1 of 2 settled up')).toHaveLength(1);
    expect(screen.getByLabelText('Sam, $13.00, marked paid')).toBeTruthy();
    expect(screen.getByLabelText('Dee, $3.00, not paid yet')).toBeTruthy();
    expect(screen.queryByLabelText(/^You, /)).toBeNull(); // the payer has no row

    me(D).mark = 300;
    await liveChange();
    expect(await screen.findByText("Everyone's settled up. Nice.")).toBeTruthy();
    expect(screen.getByText('2 marked paid')).toBeTruthy();
    expect(screen.queryByText('All settled up')).toBeNull(); // R4: the payer's list has no aside
  });
});

// ---------------------------------------------------------------------------
// Payer change (criterion 49)
// ---------------------------------------------------------------------------

describe('changing who paid (host): the Who paid? page', () => {
  beforeEach(() => {
    // No extras (total 3100): Hana 1500, Sam 1000, Dee 600.
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
  });

  const field = (name: string, unit: 'dollars' | 'percent' = 'dollars') =>
    screen.getByLabelText(unit === 'dollars' ? `${name} paid, in dollars` : `${name} paid, percent of the bill`);

  async function openPage(as = A) {
    const router = await openSettle(as);
    fireEvent.press(screen.getByLabelText('Paid by you. Change who paid'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/payers`));
    await screen.findByText('Bill total');
    return router;
  }

  it('the "Paid by" line is a Change button only for the host, and only with 2+ participants', async () => {
    const r = await openSettle(B);
    expect(screen.getByText('Paid by Hana')).toBeTruthy();
    expect(screen.queryByLabelText(CHANGE)).toBeNull();
    r.unmount();
    db.people = [person(A, 'Hana', 'hana-1')];
    db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)];
    const r2 = await openSettle(A);
    expect(screen.getByText('Paid by you')).toBeTruthy(); // alone: nobody to change it to
    expect(screen.queryByLabelText(CHANGE)).toBeNull();
    r2.unmount();
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam')];
    await openSettle(A);
    expect(screen.getByLabelText('Paid by you. Change who paid').props.accessibilityHint).toBe('Opens who paid');
  });

  it('the line opens a separate page: by default the host paid the whole bill, the total is at the bottom', async () => {
    await openPage();
    expect(field('You').props.value).toBe('31.00');
    expect(field('Sam').props.value).toBe('');
    expect(field('Dee').props.value).toBe('');
    expect(screen.getByText('$31.00')).toBeTruthy();
    expect(screen.getByText('Adds up to $31.00')).toBeTruthy();
    expect(disabled('Save')).toBe(true); // nothing changed yet
    expect(writes()).toHaveLength(0);
  });

  it('amounts that do not add up exactly never save', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '20');
    expect(screen.getByText('$11.00 left to assign')).toBeTruthy();
    expect(disabled('Save')).toBe(true);
    fireEvent.changeText(field('Sam'), '11.01');
    expect(screen.getByText('$0.01 more than the total')).toBeTruthy();
    expect(disabled('Save')).toBe(true);
    fireEvent.changeText(field('Sam'), '11');
    expect(screen.getByText('Adds up to $31.00')).toBeTruthy();
    expect(disabled('Save')).toBe(false);
  });

  it('a split with no payments yet saves with set_payers at once, then Settle up shows who paid and the cards', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    expect(screen.queryByText(/already paid/)).toBeNull(); // nobody has paid: no note
    supabase.__setTable('bill_payers', () => ({
      data: [
        { user_id: A, paid_cents: 2000 },
        { user_id: B, paid_cents: 1100 },
      ],
      error: null,
    }));
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    expect(screen.queryByText(/^Change who paid\?/)).toBeNull(); // nothing moves, so nothing to ask (A1.5)
    expect(rpcCalls('set_payers')[0]?.[1]).toEqual({
      p_bill_id: BILL,
      p_payers: [
        { user_id: A, paid_cents: 2000 },
        { user_id: B, paid_cents: 1100 },
      ],
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByLabelText('Paid by you $20.00 and Sam $11.00. Change who paid')).toBeTruthy();
    expect(screen.queryByText(/^Several people paid this bill\./)).toBeNull();
    expect(screen.queryByText(/is now collecting/)).toBeNull();
    // Hana paid 20.00 for a 15.00 share: Dee pays her (the legacy fixture has no Venmo for Sam's pair to Hana).
    expect(screen.getByText('You paid $20.00 · your share is $15.00')).toBeTruthy();
  });

  it('the percent toggle converts the amounts, and percentages save as exact cents', async () => {
    await openPage();
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    expect(field('You', 'percent').props.value).toBe('100');
    fireEvent.changeText(field('You', 'percent'), '33.33');
    fireEvent.changeText(field('Sam', 'percent'), '33.33');
    expect(screen.getByText('33.34% left to assign')).toBeTruthy();
    fireEvent.changeText(field('Dee', 'percent'), '33.34');
    expect(screen.getByText('Adds up to 100% · $31.00')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    const sent = (rpcCalls('set_payers')[0]?.[1] as { p_payers: { paid_cents: number }[] }).p_payers;
    expect(sent.map((p) => p.paid_cents)).toEqual([1033, 1033, 1034]);
    expect(sent.reduce((s, p) => s + p.paid_cents, 0)).toBe(3100);
  });

  it('the whole bill to one other person saves with set_payer, after the existing confirm', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText('Switch to Dee? People may already be paying you.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Switch to Dee'));
    await waitFor(() => expect(rpcCalls('set_payer')).toEqual([['set_payer', { p_bill_id: BILL, p_payer_id: D }]]));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByLabelText('Paid by Dee. Change who paid')).toBeTruthy();
    // The host made the change: no "now collecting" notice for them.
    expect(screen.queryByText(/is now collecting/)).toBeNull();
  });

  it('with 2 payments to the host the confirm names them and says they still count (A1.5, contract M)', async () => {
    me(B).mark = 1000;
    db.people.push(person(C, 'Cy', null, 100));
    db.claims.push(claim(FRIES, C));
    await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText('Sam and Cy already paid you')).toBeTruthy();
    expect(screen.getByText("If you switch to Dee, their payments still count. You'll pass $11.00 on to Dee.")).toBeTruthy();
    expect(screen.queryByText(/clears/)).toBeNull();
    expect(screen.getByLabelText('Switch to Dee')).toBeTruthy();
    expect(screen.getByLabelText('Cancel: keep you as the payer')).toBeTruthy();
    expect(rpcCalls('set_payer')).toHaveLength(0);
  });

  it('a split that keeps the host: the note above Save says the payments still count, and it saves with no confirm', async () => {
    me(B).mark = 1000;
    await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Dee'), '11');
    expect(screen.getByText('Sam already paid. Their payment still counts after this change.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
  });

  it('a split that takes the host off who paid asks first, with the moved payment', async () => {
    me(B).mark = 1000;
    await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Sam'), '20');
    fireEvent.changeText(field('Dee'), '11');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText('Sam already paid you')).toBeTruthy();
    expect(screen.getByText("Saving takes you off who paid. Sam's $10.00 still counts, and you'll pass it on.")).toBeTruthy();
    expect(rpcCalls('set_payers')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Cancel: keep who paid as it is'));
    await waitFor(() => expect(screen.queryByText('Sam already paid you')).toBeNull());
    fireEvent.press(screen.getByLabelText('Save'));
    await screen.findByText('Sam already paid you');
    fireEvent.press(screen.getByLabelText('Save')); // the confirm's Save (the form's is hidden while it shows)
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
  });

  it('nobody can pay yet (even split, incomplete): saves with no confirm', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    db.bill.extras_split = 'equal';
    await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Sam'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payer')).toHaveLength(1));
    expect(screen.queryByText(/^Switch to/)).toBeNull();
    expect(await screen.findByLabelText('Paid by Sam. Change who paid')).toBeTruthy();
  });

  it('Cancel on the confirm makes no call; a double tap on the confirm sends one call', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Sam'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    await screen.findByText(/^Switch to Sam\?/);
    fireEvent.press(screen.getByLabelText('Cancel: keep you as the payer'));
    await waitFor(() => expect(screen.queryByText(/^Switch to Sam\?/)).toBeNull());
    expect(rpcCalls('set_payer')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Save'));
    await screen.findByText(/^Switch to Sam\?/);
    next.hold = new Promise<void>(() => {});
    const confirmButton = screen.getByLabelText('Switch to Sam');
    fireEvent.press(confirmButton);
    fireEvent.press(confirmButton);
    expect(rpcCalls('set_payer')).toHaveLength(1);
  });

  it('a failed save keeps the page open with the error', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    db.bill.extras_split = 'equal';
    const router = await openPage();
    next.setPayer = [{ code: '42501', message: 'permission denied' }];
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Sam'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText(BILL_ERROR_COPY.not_allowed)).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL}/payers`);
  });

  it('someone who is not the host sees why and no fields', async () => {
    signInAs(B);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/payers` });
    expect(await screen.findByText('Only Hana can change who paid.')).toBeTruthy();
    expect(screen.queryByLabelText(/paid, in dollars$/)).toBeNull();
  });

  it('51: a payer change by the host updates Sam\'s screen live, with the notice', async () => {
    me(B).mark = 1000;
    await openSettle(B);
    expect(screen.getByText('You paid Hana')).toBeTruthy();
    db.bill.payer_id = D;
    db.people.forEach((p) => (p.mark = null));
    await liveChange();
    expect(await screen.findByText('Dee is now collecting for this bill. If you already paid Hana, sort it out with them.')).toBeTruthy();
    expect(paidByLine('Paid by Dee')).toBeTruthy();
    expect(screen.getByText('You owe Dee')).toBeTruthy();
    expect(screen.getByText('Pay Dee $10.00 on Venmo')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Dismiss notice'));
    expect(screen.queryByText(/is now collecting/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Undo (criterion 50) and live (51)
// ---------------------------------------------------------------------------

describe('undo and live', () => {
  beforeEach(() => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1510), person(D, 'Dee')];
  });

  it("50: Sam's own Undo (on the card) calls unmarkPaid at once, and his row has no second Undo", async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    // Own row: "You", never "You sent you" (copy with "You").
    expect(screen.getByLabelText('You, $15.10, marked paid')).toBeTruthy();
    expect(screen.getAllByLabelText('Undo')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText('Undo'));
    fireEvent.press(screen.getByLabelText('Undo')); // double tap
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: A }]]);
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('Marked not paid').props.accessibilityLiveRegion).toBe('polite');
    // Own undo: no "was undone" notice.
    expect(screen.queryByText('Your "I paid" was undone. Check Activity to see who.')).toBeNull();
  });

  it("50: the host who isn't the payer: Undo on Sam's row asks first; only confirming calls unmarkPaid", async () => {
    db.bill.payer_id = D;
    await openSettle(A);
    expect(screen.queryByLabelText("Not received, Sam's $15.10")).toBeNull(); // SV-10: not the payer's
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    expect(screen.getByText('Undo Sam\'s "I paid"?')).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Cancel: keep Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B, p_payer_id: D }]]);
    expect(await screen.findByLabelText(/^Sam, \$[\d.]+, not paid yet$/)).toBeTruthy();
  });

  it("50: Dee (neither host nor payer) sees no Undo and no Not received on Sam's row", async () => {
    await openSettle(D);
    expect(screen.getByLabelText(/^Sam, \$[\d.]+, marked paid$/)).toBeTruthy();
    expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull();
    expect(screen.queryByText('Not received')).toBeNull();
  });

  it('50: an undo failure shows the error under the list and re-enables Undo', async () => {
    db.bill.payer_id = D;
    next.unmark = { code: '42501', message: 'not_allowed' };
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(await screen.findByText(BILL_ERROR_COPY.not_allowed)).toBeTruthy();
    await waitFor(() => expect(disabled("Undo Sam's I paid")).toBe(false));
  });

  it('50: when someone else undoes Sam\'s mark, Sam sees the undone notice as an alert', async () => {
    await openSettle(B);
    me(B).mark = null;
    await liveChange();
    const text = await screen.findByText('Your "I paid" was undone. Check Activity to see who.');
    expect(inAlert(text)).toBe(true);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });

  it("51: Dee's mark lands live on Hana's screen without a refresh", async () => {
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee')];
    await openSettle(A);
    expect(screen.getByLabelText(/^Dee, \$[\d.]+, not paid yet$/)).toBeTruthy();
    me(D).mark = 600;
    await liveChange();
    expect(await screen.findByLabelText(/^Dee, \$[\d.]+, marked paid$/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The payer's Not received (criterion 42; D4), web and native
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Not received on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.people = [person(A, 'Hana', 'hana-1'), { ...person(B, 'Sam', 'sam-1', 1510), method: 'venmo' }];
  });

  it("the payer's row: a TextLink, an inline confirm, then markNotReceived with the mark's exact cents and time", async () => {
    await openSettle(A);
    expect(screen.getByLabelText('Sam, $15.10, sent via Venmo')).toBeTruthy();
    expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull(); // SV-10: no Undo on payer rows
    const link = screen.getByLabelText("Not received, Sam's $15.10");
    expect(link.props.accessibilityHint).toBe('Asks first, then clears it and lets Sam know');
    fireEvent.press(link);
    expect(screen.getByText("Didn't get Sam's $15.10? This clears it and lets Sam know.")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Cancel: keep Sam's $15.10"));
    expect(rpcCalls('mark_not_received')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText("Not received, Sam's $15.10"));
    fireEvent.press(screen.getByLabelText("Confirm: Sam's $15.10 not received"));
    expect(rpcCalls('mark_not_received')).toEqual([
      ['mark_not_received', { p_bill_id: BILL, p_user_id: B, p_payer_id: A, p_expected_cents: 1510, p_expected_at: AT }],
    ]);
    expect(await screen.findByLabelText('Sam, $15.10, not paid yet, not received $15.10')).toBeTruthy();
    expect(screen.getByText('Not received · $15.10')).toBeTruthy();
    const said = await screen.findByText('Marked not received. Sam will see it.');
    expect(said.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.queryByLabelText("Not received, Sam's $15.10")).toBeNull();
  });

  // QA F2: at 200% zoom on a 375-pt screen (and large text), "Not received" overflowed the warning
  // Banner and the card. The buttons wrap and shrink to the Banner's width; the label wraps inside.
  it('F2: the confirm\'s buttons wrap and shrink inside the Banner, and keep their 44-pt height', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Not received, Sam's $15.10"));
    const confirm = screen.getByLabelText("Confirm: Sam's $15.10 not received");
    const cancel = screen.getByLabelText("Cancel: keep Sam's $15.10");
    const flat = (n: { props: { style?: unknown } }) => (StyleSheet.flatten(n.props.style as never) ?? {}) as Record<string, unknown>;
    for (const b of [confirm, cancel]) {
      expect(flat(b)).toMatchObject({ flexShrink: 1, maxWidth: '100%', minHeight: TOUCH_TARGET });
    }
    // The label may wrap inside the button.
    expect(flat(within(confirm).getByText('Not received'))).toMatchObject({ flexShrink: 1 });
    // The row they sit in wraps.
    let row = confirm.parent;
    while (row && flat(row).flexWrap !== 'wrap') row = row.parent;
    expect(row).toBeTruthy();
    expect(flat(row as NonNullable<typeof row>)).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' });
    expect(within(row as NonNullable<typeof row>).getByLabelText("Cancel: keep Sam's $15.10")).toBeTruthy();
  });

  it('R2: a live refetch brings a new mark (a re-send) while the confirm is open → the confirm closes', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Not received, Sam's $15.10"));
    const CONFIRM = "Didn't get Sam's $15.10? This clears it and lets Sam know.";
    expect(screen.getByText(CONFIRM)).toBeTruthy();
    // Control: a refetch with the same mark keeps it open.
    await liveChange();
    expect(screen.getByText(CONFIRM)).toBeTruthy();
    // Sam undid and sent again: same amount, a new settled_at.
    me(B).at = '2026-11-24T21:00:00Z';
    await liveChange();
    await waitFor(() => expect(screen.queryByText(CONFIRM)).toBeNull());
    expect(screen.getByLabelText("Not received, Sam's $15.10")).toBeTruthy();
    expect(rpcCalls('mark_not_received')).toHaveLength(0);
  });

  it('R2: a new amount closes it too', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Not received, Sam's $15.10"));
    me(B).mark = 1400;
    await liveChange();
    await waitFor(() => expect(screen.queryByText(/This clears it and lets Sam know/)).toBeNull());
    expect(screen.getByLabelText("Not received, Sam's $14.00")).toBeTruthy();
  });

  it('mark_changed: the row is stale, so its copy shows as an alert and the bill is re-read', async () => {
    next.notReceived = { code: '22023', message: 'mark_changed' };
    await openSettle(A);
    const before = billFetches();
    fireEvent.press(screen.getByLabelText("Not received, Sam's $15.10"));
    fireEvent.press(screen.getByLabelText("Confirm: Sam's $15.10 not received"));
    const banner = await screen.findByText('That payment just changed, so nothing was cleared. Check below.');
    expect(inAlert(banner)).toBe(true);
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(disabled("Not received, Sam's $15.10")).toBe(false));
  });

  it("Sam's side: the warning line arrives live, with the triangle, and no \"undone\" notice (SV-19)", async () => {
    await openSettle(B);
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    me(B).mark = null;
    me(B).nr = { cents: 1510, method: 'venmo', by: A };
    await liveChange();
    const line = await screen.findByText("Hana hasn't received your $15.10. Check Venmo before paying again.");
    expect(line).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(TriangleAlert).length).toBeGreaterThan(0);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('Pay Hana $15.10 on Venmo')).toBeTruthy(); // the retry
    expect(screen.queryByText('Your "I paid" was undone. Check Activity to see who.')).toBeNull();
  });

  it.each([
    ['cash', "Hana hasn't received your $15.10 in cash."],
    ['other', "Hana hasn't received your $15.10."],
  ] as const)('the warning line by the cleared method: %s', async (method, text) => {
    db.people = [person(A, 'Hana', 'hana-1'), { ...person(B, 'Sam'), nr: { cents: 1510, method, by: A } }];
    await openSettle(B);
    expect(screen.getByText(text)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Share changed (criterion 50a)
// ---------------------------------------------------------------------------

describe('share changed since the mark (50a; Task 6 copy: more_due / back_due, D6)', () => {
  // Copy only; the difference handlers (Pay more, I paid the difference, Request, I paid it back)
  // are tested in "more due" and "back due" at the end of this file (Task 8).
  it('higher: Sam sees what he owes more; Hana\'s row shows both amounts and the difference', async () => {
    // Tax 763 makes Sam's share exactly 1620 (largest remainder gives him the spare cent).
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    me(B).mark = 1510;
    const r = await openSettle(B);
    expect(screen.getByText('You owe Hana more')).toBeTruthy();
    expect(screen.getAllByText('$1.10').length).toBeGreaterThan(0);
    expect(screen.getByText("Your share is now $16.20. You've paid $15.10.")).toBeTruthy();
    expect(screen.getByText('Pay Hana $1.10 more on Venmo')).toBeTruthy();
    expect(screen.getByLabelText("How you're paying")).toBeTruthy(); // the same chooser as the owes card
    r.unmount();
    await openSettle(A);
    expect(screen.getByText('Marked $15.10 · share now $16.20')).toBeTruthy();
    expect(screen.getByLabelText('Sam, marked paid $15.10, share is now $16.20, owes $1.10 more')).toBeTruthy();
  });

  it('higher after a Venmo send: "You\'ve sent" (SV-UX-22)', async () => {
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    me(B).mark = 1510;
    me(B).method = 'venmo';
    await openSettle(B);
    expect(screen.getByText("Your share is now $16.20. You've sent $15.10.")).toBeTruthy();
  });

  it('lower', async () => {
    me(B).mark = 1620;
    await openSettle(B);
    expect(screen.getByText('Hana owes you')).toBeTruthy();
    expect(screen.getByText("Your share is now $15.10. You've paid $16.20.")).toBeTruthy();
  });

  it('$0.00', async () => {
    db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)];
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText("Your share is now $0.00. You've paid $15.10.")).toBeTruthy();
  });

  it('negative', async () => {
    db.rows = [row(BURGER, 'Steak', 1000, 0), row(SALAD, 'Water', 0, 1)];
    db.claims = [claim(BURGER, A), claim(SALAD, B)];
    db.bill = { ...db.bill, total_cents: 800, tax_cents: 0, total_discount_cents: 200, extras_split: 'equal' };
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText("Your share is now -$1.00. You've paid $15.10.")).toBeTruthy();
    expect(screen.getByText('Hana also owes you $1.00 for your share. Settle that outside the app.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Accessibility (criterion 52)
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('52: every button has a label; Pay and the mark buttons have hints', async () => {
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', null, 600)];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
    await openSettle(B);
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
    const pay = screen.getByLabelText('Pay Hana $10.00 on Venmo, to @hana-1');
    expect(pay.props.accessibilityHint).toBe('Opens Venmo and records it as sent');
    expect(screen.getByLabelText('Paid another way').props.accessibilityHint).toBe('Records that you paid Hana outside SplitIt');
    fireEvent.press(screen.getByLabelText("Cash, how you're paying"));
    expect(screen.getByLabelText('I paid Hana $10.00 in cash').props.accessibilityHint).toBe('Records that you paid in cash. Nothing opens.');
    fireEvent.press(screen.getByLabelText("Venmo, how you're paying"));
    // Row labels say name, amount and status; status words are text, not colour.
    expect(screen.getByLabelText('You, $10.00, not paid yet')).toBeTruthy();
    expect(screen.getByLabelText('Dee, $6.00, marked paid')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    // P3: "Paid" carries a check icon; "Not yet" (muted) carries none.
    expect(screen.UNSAFE_queryAllByType(Check).length).toBeGreaterThan(0);
  });

  it('53: the worked example as Hana, payer: the amounts come from the plan', async () => {
    await openSettle(A);
    expect(screen.getByText('1 person owes you')).toBeTruthy();
    expect(screen.getAllByText('$15.10')).toHaveLength(2); // the card and Sam's row
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Review fixes R1 (a failed refetch after a write), R7 (Pay throttle), R8 (web, synchronous open)
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  // useBill: a refetch that a newer one has superseded is dropped, and must not count as finished
  // (Sam back from Venmo: the foreground refetch starts while the write's own refetch is in flight).
  it('useBill: the write\'s refetch is superseded by a foreground refetch; the button waits for the newer one, then "Marked paid" is announced', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const app = captureAppState();
    await openSettle(B);
    let releaseOwn: () => void = () => {};
    supabase.__setRpc(async (fn, args) => {
      if (fn === 'mark_paid') {
        me(B).mark = (args as { p_cents: number }).p_cents;
        me(B).at = AT;
        next.holdNextRead = new Promise<void>((r) => (releaseOwn = r));
        return { data: [{ settled_at: AT, created: true }], error: null };
      }
      return { data: null, error: null };
    });
    fireEvent.press(screen.getByLabelText('Paid another way'));
    await waitFor(() => expect(next.holdNextRead).toBeNull()); // the write's own refetch is held
    let releaseNewer: () => void = () => {};
    next.holdNextRead = new Promise<void>((r) => (releaseNewer = r));
    await app.foreground(); // the newer refetch starts, and is held too
    expect(next.holdNextRead).toBeNull();

    await act(async () => releaseOwn()); // lands first, and is dropped as stale
    expect(announce).not.toHaveBeenCalledWith('Marked paid');
    expect(disabled('Paid another way')).toBe(true); // still waiting: nothing has finished for it yet

    await act(async () => releaseNewer());
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Marked paid'));
    announce.mockRestore();
    app.restore();
  });

  // QA N3 replaced "the button is enabled again" for a write that landed: the spinner stops, the card
  // says the payment was saved, and its buttons wait for a refetch that shows it (or Try again).
  it('R1 + N3: the mark succeeds, then the screen\'s own refetch fails: the saved message, and the buttons wait', async () => {
    await openSettle(B);
    next.failReadsAfterWrite = true;
    const before = billFetches();
    fireEvent.press(screen.getByLabelText('Paid another way'));
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText("Your payment was saved, but we couldn't refresh. Try again before you pay again.")).toBeTruthy();
    expect(screen.getByLabelText('Paid another way').props.accessibilityState).toMatchObject({ busy: false, disabled: true });
    // Nothing optimistic: the screen still shows what the server last confirmed.
    expect(screen.queryByText('Marked paid')).toBeNull();
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });

  it('R1: an undo succeeds, then the refetch fails: Undo is enabled again', async () => {
    // The host who isn't the payer keeps Undo (SV-10).
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1510), person(D, 'Dee', 'dee-22')];
    db.bill.payer_id = D;
    await openSettle(A);
    next.failReadsAfterWrite = true;
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
    await waitFor(() => expect(disabled("Undo Sam's I paid")).toBe(false));
  });

  it('R1: a newer live refetch that already shows the mark releases the button while the own refetch hangs', async () => {
    await openSettle(B);
    let release: () => void = () => {};
    // The screen's own refetch (the first read after the write) hangs.
    supabase.__setRpc(async (fn, args) => {
      if (fn === 'mark_paid') {
        me(B).mark = (args as { p_cents: number }).p_cents;
        me(B).at = AT;
        next.holdNextRead = new Promise<void>((r) => (release = r));
        return { data: [{ settled_at: AT, created: true }], error: null };
      }
      return { data: null, error: null };
    });
    fireEvent.press(screen.getByLabelText('Paid another way'));
    await waitFor(() => expect(next.holdNextRead).toBeNull()); // the own refetch has started and is held
    await liveChange();
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(screen.getByLabelText('Undo').props.accessibilityState?.disabled).toBe(false);
    await act(async () => release());
  });

  it('R7 (web): a second Venmo tap within ~1 s is ignored; after that it opens again', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    await screen.findByText('Did you send Hana $15.10?');
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openWeb).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openWeb).toHaveBeenCalledTimes(2);
  });

  it('R8: on web, Pay calls openPaymentLinkWeb before fireEvent.press returns, and not RN Linking', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    expect(openWeb).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(openWeb).toHaveBeenCalledTimes(1); // no awaited tick in between
    expect(openWeb).toHaveBeenCalledWith('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    expectPrivateNote(openWeb.mock.calls[0]?.[0] as string | undefined);
    expect(openLink).not.toHaveBeenCalled();
    expect(await screen.findByText('Did you send Hana $15.10?')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Venmo Request buttons for the payer (docs/specs/2026-11-25-venmo-request-buttons.md, criteria 13–20)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Request buttons on %s', (os) => {
  const REQUEST_SAM = 'Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik';
  const SAM_URL = 'https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries';
  const WEB_LINE = 'On a computer? Send requests from the Venmo app on your phone.';
  /** Every table write the fake client saw (none of the screen's reads use these methods). */
  const tableWrites = () =>
    supabase.__queries.filter((q) => q.calls.some((c) => ['insert', 'update', 'delete', 'upsert'].includes(c.method)));

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik')];
  });

  it('13: the payer sees @handle and Request; a tap opens the row\'s URL synchronously', async () => {
    await openSettle(A);
    expect(screen.getByText('@Tejesh-Bhaumik', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getAllByText('Request')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    // Called before any awaited tick: the browser still sees the payer's gesture.
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(SAM_URL);
    // Criterion 7 on screen: Sam's own items only; no names, no amount.
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    await act(async () => {}); // let the open's result land
  });

  it('14: two taps within 1 s open once; a tap after 1 s opens again', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    expect(openLink).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    expect(openLink).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it('15: Venmo failing to open shows the request fallback under the list, as an alert', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(A);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    const banner = await screen.findByText("Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.");
    expect(inAlert(banner)).toBe(true);
    // The next successful tap clears it.
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    await waitFor(() => expect(screen.queryByText(/^Couldn't open Venmo\. Request/)).toBeNull());
  });

  it('16: requesting writes nothing, and the row still says "Not yet"', async () => {
    await openSettle(A);
    // Any rpc but mark_bill_seen (fire and forget, criterion 43) would be a write.
    const others = () => supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen').length;
    const rpcBefore = others();
    const fetchesBefore = billFetches();
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(5000));
    expect(others()).toBe(rpcBefore);
    expect(tableWrites()).toHaveLength(0);
    expect(billFetches()).toBe(fetchesBefore);
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    expect(screen.getByLabelText(REQUEST_SAM)).toBeTruthy();
  });

  it('17: a share change rebuilds the link; Sam marking removes Request and shows Paid', async () => {
    await openSettle(A);
    // Tax 763 makes Sam's share exactly 1620 (as in 50a).
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    await liveChange();
    const request = await screen.findByLabelText('Request $16.20 from Sam on Venmo, @Tejesh-Bhaumik');
    fireEvent.press(request);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink.mock.calls[0]?.[0]).toContain('amount=16.20');
    expect(openLink.mock.calls[0]?.[0]).toContain('txn=charge');

    me(B).mark = 1620; // at the share (Task 6: a different mark is a difference row with its own Request)
    await liveChange();
    await waitFor(() => expect(screen.queryAllByText('Request')).toHaveLength(0));
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.queryByText('@Tejesh-Bhaumik', { includeHiddenElements: true })).toBeNull();
  });

  it.each([
    ['the host who isn\'t the payer', A],
    ['the person who owes', B],
  ])('18: %s sees no Request button', async (_who, viewerId) => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik'), person(D, 'Dee', 'dee-22')];
    db.bill.payer_id = D;
    await openSettle(viewerId);
    expect(paidByLine('Paid by Dee')).toBeTruthy();
    expect(screen.queryAllByText('Request')).toHaveLength(0);
    expect(screen.queryByLabelText(/^Request /)).toBeNull();
    expect(screen.queryByText(WEB_LINE)).toBeNull();
    expect(screen.queryByText("Hasn't added Venmo")).toBeNull();
  });

  it('19: the button carries the row model\'s label and "Opens Venmo"; the row label is unchanged', async () => {
    await openSettle(A);
    const button = screen.getByLabelText(REQUEST_SAM);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe('Opens Venmo');
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
  });

  it('20: the web line shows once on web, never on native', async () => {
    await openSettle(A);
    if (os === 'web') expect(screen.getAllByText(WEB_LINE)).toHaveLength(1);
    else expect(screen.queryByText(WEB_LINE)).toBeNull();
  });

  it('20 (phone browser): no web line under the list (SV-WEB-1)', async () => {
    await onPhoneBrowser(async () => {
      await openSettle(A);
      expect(screen.getByLabelText(REQUEST_SAM)).toBeTruthy(); // positive control: a Request link is on screen
      expect(screen.queryByText(/^On a computer\?/)).toBeNull();
    });
  });

  it('Q2: an ower without Venmo gets "Hasn\'t added Venmo" and no button; the web line counts only links', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null)];
    await openSettle(A);
    expect(screen.getByText("Hasn't added Venmo")).toBeTruthy();
    expect(screen.queryAllByText('Request')).toHaveLength(0);
    expect(screen.queryByText(WEB_LINE)).toBeNull();
  });

  it('the payer without their own Venmo still gets Request (VR-8), under the "Add your Venmo" card', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam', 'Tejesh-Bhaumik')];
    await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    expect(screen.getByLabelText(REQUEST_SAM)).toBeTruthy();
  });
});

// Review R2 (Amendment A2): an open-failed line shows only while it still describes the bill.
describe.each(['ios', 'web'] as const)('open-failed lines follow the bill on %s (review R2)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Pay: the fallback goes away when the payer changes', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    // Native: Linking fails (and the mark is undone). Web: the popup is blocked (nothing is written).
    // Only the opener this platform uses: a queued once-value would leak into the next test.
    if (os === 'web') openWeb.mockReturnValueOnce(null);
    else openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(await screen.findByText("Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.")).toBeTruthy();
    if (os === 'web') expect(rpcCalls('mark_paid')).toHaveLength(0);
    else expect(rpcCalls('unmark_paid')).toHaveLength(1);
    db.bill.payer_id = D;
    await liveChange();
    expect(await screen.findByText('You owe Dee')).toBeTruthy();
    expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull();
  });

  it('Request: the fallback goes away when that person\'s share changes', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik')];
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik'));
    expect(await screen.findByText("Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.")).toBeTruthy();
    db.claims = db.claims.filter((c) => !(c.line_item_id === FRIES && c.user_id === B));
    await liveChange();
    await waitFor(() => expect(screen.queryByLabelText('Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik')).toBeNull());
    expect(screen.getAllByText('Request')).toHaveLength(1); // a request for the new amount
    expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md, Task 8):
// criteria 38–43, 45 and 61, on native and web. Fixtures: the worked example above.
// ---------------------------------------------------------------------------

const DESSERT = '22222222-0000-4000-8000-000000000004';
const tableWrites = () =>
  supabase.__queries.filter((q) => q.calls.some((c) => ['insert', 'update', 'delete', 'upsert'].includes(c.method)));
const diffCalls = () => rpcCalls('settle_difference');
const background = (label: string) =>
  (StyleSheet.flatten(screen.getByLabelText(label).props.style) as { backgroundColor?: string }).backgroundColor;
/** Lets a held rpc go (one shot). */
function holdRpc(): () => Promise<void> {
  let release: () => void = () => {};
  next.hold = new Promise<void>((r) => (release = r));
  return async () => {
    next.hold = null;
    await act(async () => release());
  };
}
/** The app returns to the foreground (back from Venmo on a phone). */
function captureAppState() {
  const handlers: ((s: AppStateStatus) => void)[] = [];
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    handlers.push(handler as (s: AppStateStatus) => void);
    return { remove: () => {} };
  });
  return {
    /** The app goes to the background (Venmo in front). */
    background: async () => {
      await act(async () => handlers.forEach((h) => h('background')));
    },
    /** An inactive blip (Control Centre, a system sheet), not a trip away. */
    inactive: async () => {
      await act(async () => handlers.forEach((h) => h('inactive')));
    },
    foreground: async () => {
      const before = billFetches();
      await act(async () => handlers.forEach((h) => h('active')));
      await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    },
    restore: () => spy.mockRestore(),
  };
}

describe.each(['ios', 'web'] as const)('settle early (criterion 38, 61) on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    // One Dessert nobody has claimed yet: proportional, so Sam (who has claims) can pay now.
    db.rows = [...db.rows, row(DESSERT, 'Dessert', 400, 3)];
    db.bill = { ...db.bill, total_cents: 4000 };
  });

  it('Sam: the may-change line, then Pay records the shown amount (phone) or asks first (desktop web)', async () => {
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('Your share may change until everything is claimed (1 item left).')).toBeTruthy();
    const pay = screen.getByLabelText(/^Pay Hana \$[\d.]+ on Venmo, to @hana-1$/);
    const amount = /\$([\d.]+)/.exec(String(pay.props.accessibilityLabel))?.[1] ?? '';
    const cents = Math.round(Number(amount) * 100);
    fireEvent.press(pay);
    if (os === 'web') {
      expect(openWeb).toHaveBeenCalledTimes(1); // synchronously, inside the tap
      expect(String(openWeb.mock.calls[0]?.[0])).toContain(`txn=pay&recipients=hana-1&amount=${amount}`);
      expect(await screen.findByText(`Did you send Hana $${amount}?`)).toBeTruthy();
      expect(rpcCalls('mark_paid')).toHaveLength(0);
      fireEvent.press(screen.getByLabelText('Yes, I sent it'));
    } else {
      await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
      expect(openLink.mock.calls[0]?.[0]).toContain(`txn=pay&recipients=hana-1&amount=${amount}`);
    }
    await waitFor(() =>
      expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: cents, p_method: 'venmo', p_plan_key: key }]]),
    );
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.getByText("If your share changes, you'll settle the difference here once everything is claimed.")).toBeTruthy();
    expect(screen.queryByText("You're all set. Hana can see it.")).toBeNull(); // early: not "all set"
  });

  it('returning from Venmo: the "Did you send?" prompt survives the refetch (contract O)', async () => {
    const app = captureAppState();
    // Native asks only when the write's outcome is unknown (network); desktop web always asks.
    if (os === 'ios') next.mark = { code: '08006', message: 'server text' };
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(/^Pay Hana \$[\d.]+ on Venmo, to @hana-1$/));
    const prompt = await screen.findByText(/^Did you send Hana \$[\d.]+\?$/);
    if (os === 'ios') expect(openLink).toHaveBeenCalledTimes(1); // opened anyway
    next.mark = null;
    await app.background();
    await app.foreground();
    expect(screen.getByText(String(prompt.props.children))).toBeTruthy();
    app.restore();
  });

  it('Hana (payer): "Waiting for everyone to claim", no Request buttons; Sam\'s row is listed', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'sam-1')];
    await openSettle(A);
    expect(screen.getByText('Waiting for everyone to claim')).toBeTruthy();
    expect(screen.getByText('1 item left to claim')).toBeTruthy();
    expect(screen.getByLabelText(/^Sam, \$[\d.]+, not paid yet$/)).toBeTruthy(); // the list is there
    expect(screen.queryAllByText(/^Request/)).toHaveLength(0);
    expect(screen.queryByLabelText(/^Request /)).toBeNull();
  });

  it('Hana without Venmo sees the "Add your Venmo" card once Sam can pay', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
  });

});

describe.each(['ios', 'web'] as const)('more due (criteria 39, 41, 42) on %s', (os) => {
  const PAY_MORE = 'Pay Hana $1.10 more on Venmo, to @hana-1';
  const MORE_URL = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=1.10&note=SplitIt%3A%20Salad%2C%20Fries';
  const RECORD = 'I paid the difference';

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    // Tax 763 makes Sam's share exactly 1620; he marked 1510.
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    me(B).mark = 1510;
  });

  const MARK_CHANGED = 'Your payment just changed. Check the amount and try again.';
  /** Native asks only when the write's outcome is unknown; desktop web always asks (contract O). */
  const askOnReturn = () => {
    if (os === 'ios') next.diff = { code: '08006', message: 'server text' };
  };

  it('Pay more: the phone opens Venmo first, then records the difference as "venmo", with no check-in (F4)', async () => {
    const { scheduleSentCheck } = jest.requireMock<{ scheduleSentCheck: jest.Mock }>('@/lib/checkInNotifications');
    // A fresh Venmo mark: the card would ask about it if a "more" send didn't stop it.
    me(B).method = 'venmo';
    me(B).at = new Date().toISOString();
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    expect(screen.getByText('You owe Hana more')).toBeTruthy();
    expect(screen.queryByText('Did it go through?')).toBeNull(); // a difference card never asks
    const pay = screen.getByLabelText(PAY_MORE);
    expect(pay.props.accessibilityHint).toBe('Opens Venmo and records it as sent');
    expect(screen.getByLabelText(RECORD).props.accessibilityHint).toBe('Records the $1.10 difference as paid another way');
    expect(screen.getByLabelText("$15.10 payment didn\'t go through").props.accessibilityHint).toBe('Clears your whole $15.10 payment, not just the difference');
    fireEvent.press(pay);
    if (os === 'web') {
      expect(openWeb).toHaveBeenCalledWith(MORE_URL); // synchronously, inside the tap
      expect(await screen.findByText('Did you send Hana $1.10?')).toBeTruthy();
      expect(diffCalls()).toHaveLength(0);
      expect(screen.getByText('@hana-1 · $1.10')).toBeTruthy();
      // 41: a second tap within 1 s (Open Venmo again) is the same tap.
      fireEvent.press(screen.getByLabelText('Open Venmo again'));
      expect(openWeb).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(1000));
      fireEvent.press(screen.getByLabelText('Open Venmo again'));
      expect(openWeb).toHaveBeenCalledTimes(2);
      expect(diffCalls()).toHaveLength(0);
      return;
    }
    expect(openLink).toHaveBeenCalledWith(MORE_URL); // opened before anything is written (SV-8)
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    await waitFor(() =>
      expect(diffCalls()).toEqual([
        ['settle_difference', { p_bill_id: BILL, p_user_id: B, p_payer_id: A, p_expected_cents: 1510, p_new_cents: 1620, p_method: 'venmo', p_plan_key: key }],
      ]),
    );
    expect(openLink.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      supabase.rpc.mock.invocationCallOrder[supabase.rpc.mock.calls.findIndex(([n]) => n === 'settle_difference')] ?? 0,
    );
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    expect(screen.getAllByText('$16.20')).toHaveLength(2); // the card (the net mark) and Sam's row
    expect(screen.queryByText('Did it go through?')).toBeNull(); // no check-in for "more"
    expect(scheduleSentCheck).not.toHaveBeenCalled();
    // ...and the mark's (first) key is stored 'shown', so a later visit doesn't ask either (SV-T5-5).
    expect(String(storage.data.get(`splitit.sentcheck.v1.${B}`))).toContain('"a":"shown"');
  });

  it('R1: the "more" write is refused after Venmo opened → the post-open line says to check Venmo, and a refetch', async () => {
    const g = globalThis as { navigator?: unknown };
    const original = Object.getOwnPropertyDescriptor(g, 'navigator');
    // Web: a phone, so the difference records after the open (desktop asks instead).
    if (os === 'web') Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', maxTouchPoints: 5 } });
    const close = jest.fn();
    if (os === 'web') openWeb.mockReturnValueOnce({ closed: false, opener: null, close });
    next.diff = { code: '22023', message: 'mark_changed' };
    try {
      await openSettle(B);
      const before = billFetches();
      fireEvent.press(screen.getByLabelText(PAY_MORE));
      const line = await screen.findByText("Venmo opened, but your payment just changed. Don't send it. Check below before you pay.");
      expect(inAlert(line)).toBe(true);
      expect(screen.queryByText(MARK_CHANGED)).toBeNull();
      if (os === 'web') expect(close).toHaveBeenCalledTimes(1);
      else expect(openLink).toHaveBeenCalledTimes(1); // it had opened: that's why the copy says so
      await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
      await waitFor(() => expect(disabled(PAY_MORE)).toBe(false));
    } finally {
      if (original) Object.defineProperty(g, 'navigator', original);
      else delete g.navigator;
    }
  });

  // Web asks first (desktop) and has no announcer, so this runs on iOS only.
  (os === 'ios' ? it : it.skip)('R5: a Venmo "more" landing is announced as "Sent $1.10 more" (iOS)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    me(B).method = 'venmo'; // the first send was via Venmo, so the raised mark stays "Sent via Venmo"
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY_MORE));
    expect(await screen.findByText('You sent Hana')).toBeTruthy();
    await waitFor(() => expect(announce).toHaveBeenCalledWith('Sent $1.10 more'));
    expect(announce).not.toHaveBeenCalledWith('Difference marked paid');
    announce.mockRestore();
  });

  it('payers_stale on "I paid the difference" re-reads exactly once; with no stale card, its line shows', async () => {
    next.diff = { code: '22023', message: 'payers_stale' };
    await openSettle(B);
    const before = billFetches();
    await act(async () => {
      fireEvent.press(screen.getByLabelText(RECORD));
    });
    // Positive control for the Settle-only rule: no stale card here (one payer), so the line stays.
    expect(await screen.findByText(BILL_ERROR_COPY.payers_stale)).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    for (let i = 0; i < 3; i += 1) await act(async () => {});
    expect(billFetches()).toBe(before + 1);
  });

  it('"I paid the difference": one rpc for two taps, loading until the refetch, then "Marked paid" at $16.20', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await openSettle(B);
    const key = await shownPlanKey(B); // the plan key the shown actions carry (A1.2)
    const release = holdRpc();
    fireEvent.press(screen.getByLabelText(RECORD));
    fireEvent.press(screen.getByLabelText(RECORD));
    expect(diffCalls()).toEqual([
      ['settle_difference', { p_bill_id: BILL, p_user_id: B, p_payer_id: A, p_expected_cents: 1510, p_new_cents: 1620, p_method: 'other', p_plan_key: key }],
    ]);
    expect(disabled(RECORD)).toBe(true);
    expect(disabled(PAY_MORE)).toBe(true);
    expect(screen.queryByText('Marked paid')).toBeNull();
    await release();
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(screen.getAllByText('$16.20')).toHaveLength(2);
    expect(inCard('Marked paid').props.accessibilityLiveRegion).toBe('polite');
    expect(diffCalls()).toHaveLength(1);
    if (os === 'ios') await waitFor(() => expect(announce).toHaveBeenCalledWith('Difference marked paid'));
    else expect(announce).not.toHaveBeenCalledWith('Difference marked paid');
    announce.mockRestore();
  });

  it('a host edit while in Venmo moves the share: the prompt stays and "Yes, I sent it" still records 1510 → 1620', async () => {
    const app = captureAppState();
    askOnReturn();
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY_MORE));
    await screen.findByText('Did you send Hana $1.10?');
    next.diff = null;
    db.bill = { ...db.bill, total_cents: 4100, tax_cents: 1000 }; // Sam's share is now more than $16.20
    await app.background();
    await app.foreground(); // back from Venmo
    expect(screen.getByText('Did you send Hana $1.10?')).toBeTruthy();
    const before = diffCalls().length;
    fireEvent.press(screen.getByLabelText('Yes, I sent it'));
    await waitFor(() => expect(diffCalls()).toHaveLength(before + 1));
    expect(diffCalls().at(-1)?.[1]).toMatchObject({ p_expected_cents: 1510, p_new_cents: 1620, p_method: 'venmo' });
    // The rest shows as a new difference once the refetch lands.
    expect(await screen.findByText('You owe Hana more')).toBeTruthy();
    app.restore();
  });

  it('mark_changed: its copy as an alert, a refetch, and the button is enabled again', async () => {
    await openSettle(B);
    next.diff = { code: '22023', message: 'mark_changed' };
    const before = billFetches();
    fireEvent.press(screen.getByLabelText(RECORD));
    const banner = await screen.findByText(MARK_CHANGED);
    expect(inAlert(banner)).toBe(true);
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(disabled(RECORD)).toBe(false));
  });

  it('Hana unmarks Sam while "I paid the difference" is in flight: mark_changed, then the plain owes card', async () => {
    await openSettle(B);
    const release = holdRpc();
    fireEvent.press(screen.getByLabelText(RECORD));
    me(B).mark = null; // Hana's Undo lands first
    next.diff = { code: '22023', message: 'mark_changed' };
    await release();
    expect(await screen.findByText(MARK_CHANGED)).toBeTruthy();
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.getByLabelText('Pay Hana $16.20 on Venmo, to @hana-1')).toBeTruthy();
    expect(screen.queryByLabelText(RECORD)).toBeNull();
  });

  // QA N3: the write landed, so the button waits (with the saved message) rather than coming back.
  it('the write works but the refetch fails: the saved message, the button waits, and nothing shows as settled', async () => {
    await openSettle(B);
    next.failReadsAfterWrite = true;
    fireEvent.press(screen.getByLabelText(RECORD));
    expect(diffCalls()).toHaveLength(1);
    expect(await screen.findByText("Your payment was saved, but we couldn't refresh. Try again before you pay again.")).toBeTruthy();
    expect(screen.getByLabelText(RECORD).props.accessibilityState).toMatchObject({ busy: false, disabled: true });
    expect(screen.queryByText('Marked paid')).toBeNull();
    expect(screen.getByText('You owe Hana more')).toBeTruthy();
  });

  it('42: the payer changes while "Did you send?" is open: notice, prompt gone, nothing records to Hana', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1510), person(D, 'Dee', 'dee-22')];
    askOnReturn();
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY_MORE));
    await screen.findByText('Did you send Hana $1.10?');
    const before = diffCalls().length;
    next.diff = null;
    db.bill.payer_id = D;
    db.people.forEach((p) => (p.mark = null)); // set_payer clears every mark
    await liveChange();
    expect(await screen.findByText('Dee is now collecting for this bill. If you already paid Hana, sort it out with them.')).toBeTruthy();
    expect(screen.queryByText('Did you send Hana $1.10?')).toBeNull();
    expect(screen.queryByLabelText(RECORD)).toBeNull();
    expect(screen.getByText('You owe Dee')).toBeTruthy();
    expect(diffCalls()).toHaveLength(before);
  });

  it('Pay more failing to open shows the fallback, records nothing and keeps the more-due card', async () => {
    // Only the opener this platform uses: a queued once-value would leak into the next test.
    if (os === 'web') openWeb.mockReturnValueOnce(null);
    else openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(PAY_MORE));
    const line = await screen.findByText("Couldn't open Venmo. Send $1.10 to @hana-1 in the Venmo app, then tap Paid another way.");
    expect(inAlert(line)).toBe(true);
    expect(diffCalls()).toHaveLength(0);
    expect(screen.getByText('You owe Hana more')).toBeTruthy();
  });

  it('Hana (payer) sees "Owes $1.10 more" with a Request for the difference and no Undo', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'sam-1', 1510), person(D, 'Dee', 'dee-22')];
    db.bill.host_id = D; // Hana pays but doesn't host: no Undo while the difference is open
    await openSettle(A);
    expect(screen.getByLabelText('Sam, marked paid $15.10, share is now $16.20, owes $1.10 more')).toBeTruthy();
    expect(screen.getByText('Owes $1.10 more')).toBeTruthy();
    const request = screen.getByLabelText('Request $1.10 more from Sam on Venmo, @sam-1');
    expect(request.props.accessibilityHint).toBe('Opens Venmo');
    expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull();
    fireEvent.press(request);
    fireEvent.press(request); // 41
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink.mock.calls[0]?.[0]).toContain('txn=charge&recipients=sam-1&amount=1.10');
    await act(async () => {});
    expect(writes()).toHaveLength(0);
    // The payer's card: everyone marked, one difference (warning, live).
    expect(screen.getByText('1 difference to settle').props.accessibilityLiveRegion).toBe('polite');
  });
});

describe.each(['ios', 'web'] as const)('back due (criteria 40, 41, 45) on %s', (os) => {
  const REQUEST = 'Request $1.10 from Hana on Venmo, @hana-1';
  const PAY_BACK = 'Pay Sam $1.10 back on Venmo, to @sam-1';
  const RECORD = 'Mark that you paid Sam $1.10 back';

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    // Sam marked $16.20; his share is $15.10, so Hana owes him $1.10 back.
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'sam-1', 1620)];
  });

  it('Sam: the Request button (secondary, not primary) opens at once and writes nothing', async () => {
    await openSettle(B);
    expect(screen.getByText('Hana owes you')).toBeTruthy();
    const request = screen.getByLabelText(REQUEST);
    expect(request.props.accessibilityHint).toBe('Opens Venmo');
    expect(background(REQUEST)).toBe(colors.light.primarySurface); // the card has no primary (SE-VIS-3)
    expect(screen.getByLabelText("$16.20 payment didn\'t go through")).toBeTruthy();
    fireEvent.press(request);
    fireEvent.press(request); // 41
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink.mock.calls[0]?.[0]).toContain('txn=charge&recipients=hana-1&amount=1.10');
    await act(async () => {});
    act(() => jest.advanceTimersByTime(5000));
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn !== 'venmo_prompt_pending' && fn !== 'mark_bill_seen')).toHaveLength(0);
    expect(tableWrites()).toHaveLength(0);
    expect(screen.getByText('Hana owes you')).toBeTruthy(); // nothing changes on screen (VR-6)
    // Own row (SE-UX-6): "Hana owes you $1.10 back", and its label says everything.
    expect(screen.getByText('Hana owes you $1.10 back')).toBeTruthy();
    expect(screen.getByLabelText('You, marked paid $16.20, share is now $15.10, Hana owes you $1.10 back')).toBeTruthy();
  });

  it('Sam: Request failing to open shows "Couldn\'t open Venmo. Request …" as an alert', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(REQUEST));
    const line = await screen.findByText("Couldn't open Venmo. Request $1.10 from @hana-1 in the Venmo app.");
    expect(inAlert(line)).toBe(true);
  });

  describe('Hana, payer but not host', () => {
    beforeEach(() => {
      db.people.push(person(D, 'Dee', 'dee-22'));
      db.bill.host_id = D;
    });

    it('the row: warning status, Pay back opens at once with no write, no Undo, wide status column', async () => {
      await openSettle(A);
      expect(screen.getByLabelText('Sam, marked paid $16.20, share is now $15.10, you owe Sam $1.10 back')).toBeTruthy();
      const status = screen.getByText('You owe $1.10 back');
      expect(StyleSheet.flatten(status.props.style).color).toBe(colors.light.warning);
      expect(screen.UNSAFE_queryAllByType(TriangleAlert).length).toBeGreaterThan(0);
      // SE-VIS-6: the status column is the fixed wide one while a difference shows.
      expect(StyleSheet.flatten((status.parent?.parent?.props as { style?: unknown }).style as never)).toMatchObject({ width: 120 });
      expect(screen.getByText('Marked $16.20 · share now $15.10')).toBeTruthy();
      expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull();
      const payBack = screen.getByLabelText(PAY_BACK);
      expect(payBack.props.accessibilityHint).toBe('Opens Venmo');
      expect(screen.getByLabelText(RECORD).props.accessibilityHint).toBe("Changes Sam's I paid to $15.10");
      fireEvent.press(payBack);
      fireEvent.press(payBack); // 41
      expect(openLink).toHaveBeenCalledTimes(1);
      expect(openLink.mock.calls[0]?.[0]).toContain('txn=pay&recipients=sam-1&amount=1.10');
      await act(async () => {});
      expect(writes()).toHaveLength(0);
      if (os === 'web') expect(screen.getByText('On a computer? Open Venmo on your phone to pay or request.')).toBeTruthy();
      else expect(screen.queryByText('On a computer? Open Venmo on your phone to pay or request.')).toBeNull();
    });

    it('"I paid it back": one rpc for two taps; then the row is "Paid" with Not received and "Marked paid back"', async () => {
      const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
      await openSettle(A);
      const key = await shownPlanKey(A); // the plan key the shown actions carry (A1.2)
      const release = holdRpc();
      fireEvent.press(screen.getByLabelText(RECORD));
      fireEvent.press(screen.getByLabelText(RECORD));
      expect(diffCalls()).toEqual([
        ['settle_difference', { p_bill_id: BILL, p_user_id: B, p_payer_id: A, p_expected_cents: 1620, p_new_cents: 1510, p_method: 'other', p_plan_key: key }],
      ]);
      expect(disabled(RECORD)).toBe(true);
      expect(disabled(PAY_BACK)).toBe(false); // opening a link writes nothing, so it stays available
      await release();
      expect(await screen.findByLabelText('Sam, $15.10, marked paid')).toBeTruthy();
      expect(screen.getByText('Paid')).toBeTruthy();
      expect(screen.getByLabelText("Not received, Sam's $15.10")).toBeTruthy(); // SV-10: the payer's control
      expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull();
      expect(screen.queryByLabelText(RECORD)).toBeNull();
      expect(screen.queryByLabelText(PAY_BACK)).toBeNull();
      expect(screen.getByText('Marked paid back').props.accessibilityLiveRegion).toBe('polite');
      if (os === 'ios') expect(announce).toHaveBeenCalledWith('Marked paid back');
      announce.mockRestore();
    });

    it('a share of $0: "I paid it back" clears the mark (p_new_cents 0); Sam then has no row and no controls', async () => {
      db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A), claim(FRIES, D)];
      me(B).mark = 1510;
      await openSettle(A);
      const record = screen.getByLabelText('Mark that you paid Sam $15.10 back');
      expect(record.props.accessibilityHint).toBe("Clears Sam's I paid");
      fireEvent.press(record);
      expect(diffCalls()[0]?.[1]).toMatchObject({ p_user_id: B, p_expected_cents: 1510, p_new_cents: 0 });
      await waitFor(() => expect(screen.queryByLabelText(/^Sam,/)).toBeNull());
      expect(screen.getByLabelText(/^Dee, /)).toBeTruthy(); // the list is still there
      expect(screen.queryByLabelText(/^Mark that you paid Sam/)).toBeNull();
      expect(screen.queryByLabelText(/^Pay Sam /)).toBeNull();
    });

    it('42: after a payer switch the old payer\'s "I paid it back" gets the payer_changed copy and a refetch', async () => {
      await openSettle(A);
      next.diff = { code: '22023', message: 'payer_changed' };
      const before = billFetches();
      fireEvent.press(screen.getByLabelText(RECORD));
      const banner = await screen.findByText(BILL_ERROR_COPY.payer_changed);
      expect(inAlert(banner)).toBe(true);
      await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
      await waitFor(() => expect(disabled(RECORD)).toBe(false));
    });

    it('Pay back failing to open: "Couldn\'t open Venmo. Send $1.10 to @sam-1 …" under the list, as an alert', async () => {
      openLink.mockResolvedValueOnce({ ok: false });
      await openSettle(A);
      fireEvent.press(screen.getByLabelText(PAY_BACK));
      const line = await screen.findByText("Couldn't open Venmo. Send $1.10 to @sam-1 in the Venmo app, then tap I paid it back.");
      expect(inAlert(line)).toBe(true);
    });

    it('two differences: the payer card says "2 differences to settle"', async () => {
      db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, A), claim(FRIES, B), claim(FRIES, D)];
      me(B).mark = 9999;
      me(D).mark = 9999;
      await openSettle(A);
      expect(screen.getByText('2 differences to settle')).toBeTruthy();
      expect(screen.getAllByText(/^You owe \$[\d.]+ back$/)).toHaveLength(2);
    });
  });

  it('Hana as host and payer: the pay-back controls plus Not received on its own line, which still asks first', async () => {
    await openSettle(A);
    expect(screen.getByLabelText(PAY_BACK)).toBeTruthy();
    expect(screen.getByLabelText(RECORD)).toBeTruthy();
    expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull(); // SV-10, difference rows included
    fireEvent.press(screen.getByLabelText("Not received, Sam's $16.20"));
    expect(screen.getByText("Didn't get Sam's $16.20? This clears it and lets Sam know.")).toBeTruthy();
    expect(rpcCalls('mark_not_received')).toHaveLength(0);
  });

  it('Dee (host, not payer) sees the status and Undo, and no difference controls', async () => {
    db.people.push(person(D, 'Dee', 'dee-22')); // no claims, so Sam's share is unchanged
    db.bill.host_id = D;
    await openSettle(D);
    expect(screen.getByText('Hana owes $1.10 back')).toBeTruthy();
    expect(screen.getByLabelText("Undo Sam's I paid")).toBeTruthy();
    expect(screen.queryByLabelText(PAY_BACK)).toBeNull();
    expect(screen.queryByLabelText(RECORD)).toBeNull();
  });

  it('45: every button on the back-due screens has a label and the new ones a hint', async () => {
    const r = await openSettle(B);
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
    r.unmount();
    await openSettle(A);
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
    for (const label of [PAY_BACK, RECORD]) expect(screen.getByLabelText(label).props.accessibilityHint).toBeTruthy();
  });
});

// Review R9 (spec A1.2, option A): Hana paid Sam's whole mark back (I paid it back to $0), so the
// refetch shows Sam with no mark and a share of $0. That isn't an undo, so no "was undone" banner.
describe.each(['ios', 'web'] as const)('option A: paid back to $0 on %s (review R9)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it.each([
    ['from the plain marked card (share and mark both $15.10)', [claim(BURGER, A), claim(SALAD, B), claim(FRIES, A), claim(FRIES, B)], 'You paid Hana'],
    ['from back due (share already $0, mark $15.10)', [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)], 'Hana owes you'],
  ])('%s: the refetch shows "You\'re all set" and no undone banner', async (_name, startClaims, startLabel) => {
    db.claims = startClaims;
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText(startLabel)).toBeTruthy(); // Sam is marked
    // The refetch: Sam's items are all Hana's, and Hana's "I paid it back" cleared his mark.
    db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)];
    me(B).mark = null;
    await liveChange();
    expect(await screen.findByText("You're all set")).toBeTruthy();
    expect(screen.getByText("You don't owe anything on this bill.")).toBeTruthy();
    expect(screen.queryByText('Your "I paid" was undone. Check Activity to see who.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// QA F-1 (SE-QA-1): the Everyone aside never says "All settled up" while a difference is open
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Everyone aside with open differences (QA F-1) on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Sam marked $15.10 and now owes $16.20: the aside says "1 difference to settle", not "All settled up"', async () => {
    // Tax 763 makes Sam's share exactly 1620; he marked 1510, so every ower is marked but 1 difference is open.
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText('Everyone')).toBeTruthy();
    expect(screen.getByText('You owe $1.10 more')).toBeTruthy();
    expect(screen.getByText('1 difference to settle')).toBeTruthy();
    expect(screen.queryByText('All settled up')).toBeNull();

    // The difference settled (mark matches the share): the aside goes back to "All settled up", live.
    me(B).mark = 1620;
    await liveChange();
    expect(await screen.findByText('All settled up')).toBeTruthy();
    expect(screen.queryByText('1 difference to settle')).toBeNull();
  });

  it('two open differences, seen by Dee: "2 differences to settle", not "All settled up"', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee')];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, A), claim(FRIES, B), claim(FRIES, D)];
    me(B).mark = 9999;
    me(D).mark = 9999;
    await openSettle(D);
    expect(screen.getByText('2 differences to settle')).toBeTruthy();
    expect(screen.queryByText('All settled up')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Several payers (who-paid Task 10: D11's Settle column, A1.5, A2). The user's first acceptance
// test: a guest who owes both payers gets two Venmo links, one per payer.
//
// The bill: total 31.00, no extras. Hana (A, host) had the Burger 15.00, Sam (B) the Salad 10.00,
// Dee (D) the Fries 6.00. Hana paid 20.00 and Sam 11.00, so Hana is owed 5.00 and Sam 1.00, and Dee
// pays both: Dee → Hana 5.00 and Dee → Sam 1.00 (larger first).
// ---------------------------------------------------------------------------

type LedgerRow = { id: string; from: string; to: string; cents: number; method: PaymentMethod; key: string | null; at: string };

const ledger: {
  payers: { user_id: string; paid_cents: number }[];
  payments: LedgerRow[];
  seq: number;
  /** mark_paid lands on the server, but the answer is lost (a network error after the write). */
  markLandsThenFails: boolean;
} = { payers: [], payments: [], seq: 0, markLandsThenFails: false };

/** The ledger tables and the mark functions on them (the legacy mark columns stay empty here). */
function installLedger() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bill_payers', () => ok(ledger.payers.map((p) => ({ ...p }))));
  supabase.__setTable('bill_payments', () =>
    ok(
      ledger.payments.map((p) => ({
        id: p.id,
        from_user: p.from,
        to_user: p.to,
        cents: p.cents,
        method: p.method,
        plan_key: p.key,
        recorded_at: p.at,
      })),
    ),
  );
  supabase.__setTable('bill_payment_flags', () => ok([]));
  supabase.__setRpc(async (fn, args) => {
    if (next.hold) await next.hold;
    const a = args ?? {};
    if (fn === 'mark_paid') {
      if (next.mark) return { data: null, error: next.mark };
      const to = a.p_payer_id as string;
      if (ledger.payments.some((p) => p.from === viewer && p.to === to)) {
        return ok([{ settled_at: ledger.payments.find((p) => p.from === viewer && p.to === to)?.at ?? AT, created: false }]);
      }
      ledger.seq += 1;
      const at = new Date(Date.now() + ledger.seq).toISOString();
      ledger.payments.push({
        id: `33333333-0000-4000-8000-${String(ledger.seq).padStart(12, '0')}`,
        from: viewer,
        to,
        cents: a.p_cents as number,
        method: a.p_method as PaymentMethod,
        key: (a.p_plan_key as string | null) ?? null,
        at,
      });
      if (ledger.markLandsThenFails) return { data: null, error: { code: '08006', message: 'down' } };
      return ok([{ settled_at: at, created: true }]);
    }
    if (fn === 'unmark_paid') {
      if (next.unmark) return { data: null, error: next.unmark };
      ledger.payments = ledger.payments.filter((p) => !(p.from === a.p_user_id && p.to === a.p_payer_id));
      return ok(null);
    }
    if (fn === 'venmo_prompt_pending') return ok(false);
    return ok(null);
  });
}

/** A payment already on the ledger (long past, so no inline check). */
function paid(from: string, to: string, cents: number, method: PaymentMethod = 'venmo') {
  ledger.seq += 1;
  ledger.payments.push({ id: `44444444-0000-4000-8000-${String(ledger.seq).padStart(12, '0')}`, from, to, cents, method, key: null, at: AT });
}

describe.each(['ios', 'web'] as const)('several payers on %s', (os) => {
  const PAY_HANA = 'Pay Hana $5.00 on Venmo, to @hana-1';
  const PAY_SAM = 'Pay Sam $1.00 on Venmo, to @sam-2';

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'sam-2'), person(D, 'Dee', 'dee-22')];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
    ledger.payers = [
      { user_id: A, paid_cents: 2000 },
      { user_id: B, paid_cents: 1100 },
    ];
    ledger.payments = [];
    ledger.seq = 0;
    ledger.markLandsThenFails = false;
    installLedger();
  });

  /** The element's `disabled` state, on native (accessibilityState) and web (aria-disabled). */
  const isDisabled = (label: string) => {
    const p = screen.getByLabelText(label).props as { accessibilityState?: { disabled?: boolean }; 'aria-disabled'?: boolean };
    return Boolean(p.accessibilityState?.disabled ?? p['aria-disabled']);
  };
  /** Pressing Pay, as each platform sends it: native records then opens; desktop web opens, then asks. */
  async function payAndConfirm(label: string, payerName: string, amount: string) {
    fireEvent.press(screen.getByLabelText(label));
    if (os === 'web') {
      expect(openWeb).toHaveBeenCalled();
      await screen.findByText(`Did you send ${payerName} ${amount}?`);
      fireEvent.press(screen.getByLabelText('Yes, I sent it'));
    } else {
      await waitFor(() => expect(openLink).toHaveBeenCalled());
    }
  }
  const bg = background;
  const lastOpened = () => (os === 'web' ? (openWeb.mock.calls.at(-1)?.[0] as string | undefined) : openLink.mock.calls.at(-1)?.[0]);

  it("the user's case: a guest who owes both payers gets one card per payer, each with its own Venmo link", async () => {
    await openSettle(D);
    // The temporary banner is gone; who paid is the line at the top.
    expect(screen.queryByText(/^Several people paid this bill\./)).toBeNull();
    expect(screen.getByText('Paid by Hana $20.00 and Sam $11.00')).toBeTruthy();
    expect(screen.getByText('You owe 2 people · $6.00')).toBeTruthy();
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('You owe Sam')).toBeTruthy();
    expect(screen.getByText('Hana and Sam split the paying. Your share is split between them.')).toBeTruthy();
    // Two Pay buttons with distinct labels; only the first is filled (M9), the second still works.
    expect(screen.getByLabelText(PAY_HANA)).toBeTruthy();
    expect(screen.getByLabelText(PAY_SAM)).toBeTruthy();
    expect(isDisabled(PAY_SAM)).toBe(false);
    expect(bg(PAY_HANA)).toBe(colors.light.primary);
    expect(bg(PAY_SAM)).not.toBe(colors.light.primary);

    // Pay Hana: Venmo opens pre-filled with that pair's amount and a note; it records to Hana only.
    await payAndConfirm(PAY_HANA, 'Hana', '$5.00');
    const hanaUrl = lastOpened();
    expect(hanaUrl).toMatch(/^https:\/\/venmo\.com\/\?txn=pay&recipients=hana-1&amount=5\.00&note=/);
    expect(noteOf(hanaUrl)).toBe('SplitIt: Fries');
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(rpcCalls('mark_paid')[0]?.[1]).toMatchObject({ p_bill_id: BILL, p_payer_id: A, p_cents: 500, p_method: 'venmo' });
    expect(await screen.findByText('You sent Hana')).toBeTruthy();

    // Marking one leaves the other open, and its Pay is now the filled one.
    expect(screen.getByText('You owe Sam')).toBeTruthy();
    await waitFor(() => expect(bg(PAY_SAM)).toBe(colors.light.primary));
    act(() => jest.advanceTimersByTime(1000)); // R7: a second Venmo tap within ~1 s is ignored
    await payAndConfirm(PAY_SAM, 'Sam', '$1.00');
    const samUrl = lastOpened();
    expect(samUrl).toMatch(/^https:\/\/venmo\.com\/\?txn=pay&recipients=sam-2&amount=1\.00&note=/);
    expect(samUrl).not.toBe(hanaUrl);
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(2));
    expect(rpcCalls('mark_paid')[1]?.[1]).toMatchObject({ p_payer_id: B, p_cents: 100, p_method: 'venmo' });
    expect(await screen.findByText('You sent Sam')).toBeTruthy();
    expect(screen.getByText('You sent Hana')).toBeTruthy();
  });

  it('the bill screen footer (the guard is gone): primary "Settle up" with "You owe 2 people · $6.00"', async () => {
    signInAs(D);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText('You owe 2 people · $6.00')).toBeTruthy();
    expect(screen.queryByText('Several people paid')).toBeNull();
    const settle = screen.getByLabelText('Settle up');
    expect(bg('Settle up')).toBe(colors.light.primary);
    fireEvent.press(settle);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
  });

  it("one write at a time: while Hana's card records, Sam's card waits; the spinner and message stay on Hana's", async () => {
    await openSettle(D);
    let release: () => void = () => {};
    next.hold = new Promise<void>((r) => (release = r));
    const [hanaOther] = screen.getAllByLabelText('Paid another way');
    if (hanaOther === undefined) throw new Error('no Paid another way');
    fireEvent.press(hanaOther);
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    expect(isDisabled(PAY_SAM)).toBe(true);
    fireEvent.press(screen.getByLabelText(PAY_SAM)); // locked: nothing opens, nothing records
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    next.hold = null;
    await act(async () => release());
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    await waitFor(() => expect(isDisabled(PAY_SAM)).toBe(false));
  });

  it("T0: a payment to an ex-payer still counts: the sender's line, and the holder's owe card says it includes it", async () => {
    // One person paid (Hana, after the host switched from Sam); Dee had already paid Sam her $6.00.
    ledger.payers = [];
    paid(D, B, 600);
    const r = await openSettle(D);
    expect(screen.getByText('Your $6.00 to Sam still counts. Sam passes it on to Hana.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Pay /)).toBeNull();
    r.unmount();
    await openSettle(B);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('Includes $6.00 Dee sent you.')).toBeTruthy();
    expect(screen.getByLabelText('Pay Hana $16.00 on Venmo, to @hana-1')).toBeTruthy();
  });

  it('A-29b (review R1), T13 shape: a pair with paid < 0 shows the remaining on the card, the link, cash and Request', async () => {
    // Hana (A) and Sam (B) only, total 31.00: Hana's share 21.00, Sam's 10.00. Payers Hana 10.00,
    // Sam 21.00. Sam sent Hana 3.00 earlier (an earlier key), which moves the positions to Hana −14.00,
    // Sam +14.00: the pair is Hana → Sam, target 11.00, paid −3.00, remaining 14.00 (balanceFor).
    // Everything on screen says $14.00; before R1 the card showed the target, $11.00.
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'sam-2')];
    db.claims = [claim(BURGER, A), claim(FRIES, A), claim(SALAD, B)];
    ledger.payers = [
      { user_id: A, paid_cents: 1000 },
      { user_id: B, paid_cents: 2100 },
    ];
    paid(B, A, 300);
    const r = await openSettle(A);
    expect(screen.getByText('You owe Sam')).toBeTruthy();
    expect(screen.queryByText('$11.00')).toBeNull();
    const pay = screen.getByLabelText('Pay Sam $14.00 on Venmo, to @sam-2');
    fireEvent.press(pay);
    if (os === 'web') {
      expect(openWeb).toHaveBeenCalled();
      await screen.findByText('Did you send Sam $14.00?');
    } else {
      await waitFor(() => expect(openLink).toHaveBeenCalled());
      await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
      expect(rpcCalls('mark_paid')[0]?.[1]).toMatchObject({ p_payer_id: B, p_cents: 1400 });
    }
    expect(lastOpened()).toMatch(/^https:\/\/venmo\.com\/\?txn=pay&recipients=sam-2&amount=14\.00&note=/);
    r.unmount();

    // The cash button, on a fresh screen.
    ledger.payments = ledger.payments.filter((p) => p.from === B);
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Cash, how you're paying"));
    expect(await screen.findByLabelText('I paid Sam $14.00 in cash')).toBeTruthy();
    screen.unmount();

    // Sam, the pair's recipient: his card and Hana's Request row are $14.00 too.
    await openSettle(B);
    expect(screen.getByLabelText('Request $14.00 from Hana on Venmo, @hana-1')).toBeTruthy();
    expect(screen.getAllByText('$14.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$11.00')).toBeNull();
  });

  describe.each([
    ['no mark to the lead', false],
    ['an earlier mark to the lead (Hana)', true],
  ])('A-43b (review R2): a send to Sam, a co-payer who is not the lead, with %s', (_name, withLeadMark) => {
    beforeEach(() => {
      if (withLeadMark) paid(D, A, 500); // Dee → Hana settled earlier: participants[Dee].mark points at it
    });

    it('"No, undo" on the inline check deletes exactly the Dee → Sam payment', async () => {
      // Dee sent Sam $1.00 via Venmo a moment ago, so the card asks (within 30 minutes).
      ledger.seq += 1;
      ledger.payments.push({ id: '55555555-0000-4000-8000-000000000001', from: D, to: B, cents: 100, method: 'venmo', key: null, at: new Date().toISOString() });
      await openSettle(D);
      expect(screen.getByText('You sent Sam')).toBeTruthy();
      const undo = await screen.findByLabelText("No, undo. It didn't go through");
      fireEvent.press(undo);
      await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
      expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: D, p_payer_id: B }]]);
      expect(await screen.findByText('Undone. Not marked as sent.')).toBeTruthy();
      expect(ledger.payments.some((p) => p.from === D && p.to === B)).toBe(false);
      expect(ledger.payments.some((p) => p.from === D && p.to === A)).toBe(withLeadMark);
    });

    if (os === 'ios') {
      it('a mark that landed behind a network error, then Venmo failed to open: the re-read clears Dee → Sam', async () => {
        openLink.mockResolvedValueOnce({ ok: false });
        ledger.markLandsThenFails = true;
        await openSettle(D);
        fireEvent.press(screen.getByLabelText(PAY_SAM));
        await waitFor(() => expect(rpcCalls('unmark_paid')).toHaveLength(1));
        expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: D, p_payer_id: B }]]);
        expect(ledger.payments.some((p) => p.from === D && p.to === B)).toBe(false);
        expect(ledger.payments.some((p) => p.from === D && p.to === A)).toBe(withLeadMark);
      });
    }
  });

  it('Everyone is grouped by recipient, with a label per group', async () => {
    db.people.push(person(C, 'Cy', 'cy-333'));
    db.claims.push(claim(FRIES, C)); // Cy and Dee share the Fries: 3.00 each
    await openSettle(A);
    expect(screen.getByText('Paying you')).toBeTruthy();
    expect(screen.getByText('Paying Sam')).toBeTruthy();
  });

  it('a payer sees what they paid and their share, and the line says who paid', async () => {
    await openSettle(B);
    expect(screen.getByText('You paid $11.00 · your share is $10.00')).toBeTruthy();
    expect(screen.getByText('Paid by you $11.00 and Hana $20.00')).toBeTruthy();
  });

  it('the host: the line is one button that opens the Who paid? page', async () => {
    const router = await openSettle(A);
    const line = screen.getByLabelText('Paid by you $20.00 and Sam $11.00. Change who paid');
    expect(line.props.accessibilityHint).toBe('Opens who paid');
    fireEvent.press(line);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/payers`));
  });

  it('a split bill with an item left to claim: no amounts, and why', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== FRIES);
    await openSettle(D);
    expect(screen.getByText('Settling starts once every item is claimed, because more than one person paid.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Pay /)).toBeNull();
    expect(screen.queryByText(/^\$\d/)).toBeNull(); // no amount drawn on its own
  });

  it('stale (the total changed): the host gets Fix who paid, which opens the page; others wait for the host', async () => {
    db.bill = { ...db.bill, total_cents: 3400, tax_cents: 300 };
    const router = await openSettle(A);
    expect(screen.getByText("Who paid doesn't match the bill total")).toBeTruthy();
    expect(screen.getByText('$31.00 of $34.00 is assigned.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Pay /)).toBeNull();
    fireEvent.press(screen.getByLabelText('Fix who paid'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/payers`));
    router.unmount();
    await openSettle(D);
    expect(screen.getByText("Who paid doesn't match the bill total")).toBeTruthy();
    expect(screen.getByText('Hana needs to update it before anyone can settle up.')).toBeTruthy();
    expect(screen.getByText('Waiting for Hana to update who paid')).toBeTruthy();
    expect(screen.queryByLabelText('Fix who paid')).toBeNull();
  });

  it("the host's Undo on a row clears that pair only (unmark_paid carries the pair's payer)", async () => {
    paid(D, B, 100);
    await openSettle(A);
    const undo = screen.getByLabelText(/^Undo Dee's/);
    fireEvent.press(undo);
    fireEvent.press(screen.getByLabelText(/^Confirm: Undo Dee's/));
    await waitFor(() => expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: D, p_payer_id: B }]]));
  });

  it('a mark refused with payers_stale (the host just changed the total) re-reads and shows the stale card', async () => {
    next.mark = { code: '22023', message: 'payers_stale' };
    await openSettle(D);
    db.bill = { ...db.bill, total_cents: 3400, tax_cents: 300 }; // on the server, not yet on screen
    const before = billFetches();
    // "Paid another way" on Hana's card (the first): the same write on web and native.
    const other = screen.getAllByLabelText('Paid another way')[0];
    if (other === undefined) throw new Error('no Paid another way');
    fireEvent.press(other);
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText("Who paid doesn't match the bill total")).toBeTruthy();
    expect(screen.getByText('Hana needs to update it before anyone can settle up.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Pay /)).toBeNull();
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  });

  it('payers_stale: the refused mark re-reads exactly once, and the stale card shows without a banner repeating it', async () => {
    next.mark = { code: '22023', message: 'payers_stale' };
    await openSettle(D);
    db.bill = { ...db.bill, total_cents: 3400, tax_cents: 300 };
    const before = billFetches();
    const other = screen.getAllByLabelText('Paid another way')[0];
    if (other === undefined) throw new Error('no Paid another way');
    fireEvent.press(other);
    expect(await screen.findByText("Who paid doesn't match the bill total")).toBeTruthy();
    for (let i = 0; i < 3; i += 1) await act(async () => {}); // let any second re-read start
    expect(billFetches()).toBe(before + 1);
    expect(screen.queryByText(BILL_ERROR_COPY.payers_stale)).toBeNull();
  });
});
