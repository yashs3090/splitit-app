// Home's "added you to a bill" card, the row markers and the foreground refresh: criteria 31–39 in
// docs/specs/2026-11-24-bill-markers-and-notices.md (Task 5). The settle pills (criteria 44, 63 of
// docs/specs/2026-11-25-settle-early-and-differences.md, Task 9) are at the end. Every flow runs on native and on web
// (lessons log 2026-11-19 and 2026-11-24: entry paths on both platforms).
// The viewer is B. Hana (A) hosts and pays unless a fixture says otherwise.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform, StyleSheet, type AppStateStatus, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import type { BillSummary } from '@/lib/bills';
import { homeRowView, homeSections } from '@/lib/homeSections';
import { savePendingInvite } from '@/lib/pendingInvite';
import { storage as realStorage } from '@/lib/storage';
import { SEEN_DEBOUNCE_MS } from '@/lib/useMarkSeen';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';
import { outsideTabBar } from '@/test-utils/tabBar';

// The live tab bar also reads the Activity and Groups badges; quiet those reads so this file's
// supabase call logs hold only Home's own. The Tabs count stays real.
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
    url: `${redirectUrl}?code=fake-pkce-code-${++mockCodeCounter}`,
  })),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const ROUTES = './app';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const X = '11111111-1111-4111-8111-111111111111';
const Y = '11111111-1111-4111-8111-222222222222';
const Z = '11111111-1111-4111-8111-333333333333';
const CODE = '0123456789abcdef0123';

// Midday UTC, so the short date is "Nov 20" in any test-machine time zone from UTC-11 to UTC+11.
const CREATED = '2026-11-20T12:00:00Z';
const ONE_TITLE = 'Hana added you to a bill';
// Home row labels are docs/specs/2026-11-26-home-mobile-refresh.md D5. The bill_participants fixture
// here has no bill_id (it answers fetchBill), so Home's people-counts read finds no counts: no "N people".
const X_NEW_LABEL = "Hana's bill, Nov 20, total $44.80. New, you haven't opened it yet";

type Row = {
  bill_id: string;
  host_id: string;
  host_name: string | null;
  payer_id: string;
  total_cents: number;
  created_at: string;
  joined_at: string;
  added: boolean;
  seen: boolean;
  claimed_any: boolean;
  complete: boolean;
};

/** A my_bills() row; by default H2 (added by Hana, not opened, nothing claimed). */
function mine(bill_id: string, over: Partial<Row> = {}): Row {
  return {
    bill_id,
    host_id: A,
    host_name: 'Hana',
    payer_id: A,
    total_cents: 4480,
    created_at: CREATED,
    joined_at: '2026-11-20T12:05:00Z',
    added: true,
    seen: false,
    claimed_any: false,
    complete: false,
    ...over,
  };
}

/** The BillSummary lib/bills parses from a row, to compute expected labels through lib. */
const summaryOf = (r: Row): BillSummary => ({
  id: r.bill_id,
  hostId: r.host_id,
  hostName: r.host_name,
  payerId: r.payer_id,
  totalCents: r.total_cents,
  createdAt: r.created_at,
  joinedAt: r.joined_at,
  added: r.added,
  seen: r.seen,
  claimedAny: r.claimed_any,
  complete: r.complete,
  seenAt: null,
});

/** Server state the fake rpc answers from. mark_bill_seen marks the row seen unless `mark` says otherwise. */
const server: {
  rows: Row[];
  myBills: (() => FakeResult | Promise<FakeResult>) | null;
  mark: ((billId: string) => FakeResult | Promise<FakeResult>) | null;
} = { rows: [], myBills: null, mark: null };

const markSeen = (billId: string) => {
  server.rows = server.rows.map((r) => (r.bill_id === billId ? { ...r, seen: true } : r));
};

const calls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

function signInAs(userId: string) {
  const session = fakeSession('Bo Bo');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

/** A promise the test resolves by hand. */
function deferred() {
  let resolve: (r: FakeResult) => void = () => {};
  const promise = new Promise<FakeResult>((r) => (resolve = r));
  return { promise, resolve };
}

/** AppState listeners Home (and any other screen) registers, with their removal. */
function spyAppState() {
  const subs: { handler: (s: AppStateStatus) => void; removed: boolean }[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    const sub = { handler: handler as (s: AppStateStatus) => void, removed: false };
    subs.push(sub);
    return { remove: () => (sub.removed = true) };
  });
  const emit = async (state: AppStateStatus) => {
    await act(async () => subs.filter((s) => !s.removed).forEach((s) => s.handler(state)));
  };
  return { subs, emit };
}

/** The screen's text in render order, to check the card sits above the bill rows. */
const screenText = () => JSON.stringify(screen.toJSON());

async function openHome() {
  const router = renderRouter(ROUTES, { initialUrl: '/' });
  await screen.findByRole('header', { name: 'SplitIt' });
  await waitFor(() => expect(screen.queryByLabelText('Loading your bills')).toBeNull());
  return router;
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  signInAs(B);
  server.rows = [mine(X)];
  server.myBills = null;
  server.mark = null;
  supabase.__setRpc((fn, args) => {
    if (fn === 'my_bills') return server.myBills ? server.myBills() : { data: server.rows.map((r) => ({ ...r })), error: null };
    if (fn === 'mark_bill_seen') {
      const id = String(args?.p_bill_id);
      if (server.mark) return server.mark(id);
      markSeen(id);
      return { data: null, error: null };
    }
    if (fn === 'venmo_prompt_pending') return { data: false, error: null };
    if (fn === 'join_bill') return { data: X, error: null };
    // GroupsSection on Home reads this; these tests have no groups.
    if (fn === 'my_groups') return { data: [], error: null };
    return { data: null, error: null };
  });
  // The bill screen (after "Open" or the invite resume) loads ready from these: one item, A and B.
  supabase.__setTable('line_items', {
    data: [{ id: '22222222-0000-4000-8000-000000000001', name: 'Dinner', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 4480, split_set_by: null, split_set_at: null }],
    error: null,
  });
  supabase.__setTable('bill_participants', {
    data: [
      { user_id: A, joined_at: CREATED, settled_at: null, settled_cents: null, profile: { display_name: 'Hana', venmo_username: null } },
      { user_id: B, joined_at: CREATED, settled_at: null, settled_cents: null, profile: { display_name: 'Bo', venmo_username: null } },
    ],
    error: null,
  });
  supabase.__setTable('claims', { data: [], error: null });
  supabase.__setTable('bills', (q) => ({
    data: {
      id: String(q.calls.find((c) => c.method === 'eq')?.args[1] ?? X),
      host_id: A,
      payer_id: A,
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 4480,
      join_code: CODE,
      created_at: CREATED,
      edited_at: null,
      extras_split: 'proportional',
    },
    error: null,
  }));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(['ios', 'web'] as const)('Home notice and markers (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  describe('cold start', () => {
    it('31: one new bill shows the card first, under the SplitIt heading and above the bill rows, and the row says New', async () => {
      const router = await openHome();
      expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
      expect(screen.getByText('Nov 20 · $44.80')).toBeTruthy();
      expect(screen.getByText('Open')).toBeTruthy();
      expect(screen.getByText('Dismiss')).toBeTruthy();
      const text = screenText();
      expect(text.indexOf(ONE_TITLE)).toBeGreaterThan(-1);
      // Tab-bar spec Task 5: the "Split a bill" bar is gone (the tab bar's (+) replaces it), so the
      // card is placed against what's still on Home: after the heading, before the first row.
      expect(text.indexOf('SplitIt')).toBeGreaterThan(-1);
      expect(text.indexOf('SplitIt')).toBeLessThan(text.indexOf(ONE_TITLE));
      expect(text.indexOf(ONE_TITLE)).toBeLessThan(text.indexOf(X_NEW_LABEL));
      // The row: its pill is visible text, and its label is criterion 18's string.
      expect(screen.getByText('New')).toBeTruthy();
      expect(screen.getByLabelText(X_NEW_LABEL).props.accessibilityRole).toBe('link');
      // The card never navigates on its own.
      expect(router.getPathname()).toBe('/');
      expect(calls('mark_bill_seen')).toHaveLength(0);
    });

    it('visual-pass R2 (tab-bar spec Task 5): Home\'s one heading is "SplitIt"; "Split a bill" is gone with its bar', async () => {
      await openHome();
      expect(screen.getByRole('header', { name: 'SplitIt' })).toBeTruthy();
      expect(screen.queryByRole('header', { name: 'Split a bill' })).toBeNull();
      expect(screen.queryByText('Split a bill')).toBeNull();
    });

    it('39: the buttons have the K2 labels and hints', async () => {
      await openHome();
      const open = await screen.findByLabelText("Open Hana's bill");
      expect(open.props.accessibilityRole).toBe('button');
      expect(open.props.accessibilityHint).toBe('Opens the bill so you can claim what you had');
      const dismiss = screen.getByLabelText('Dismiss');
      expect(dismiss.props.accessibilityRole).toBe('button');
      expect(dismiss.props.accessibilityHint).toBe('Hides this and removes New from the bill');
    });

    it('a blank host name reads "A friend" in the title and the Open label', async () => {
      server.rows = [mine(X, { host_name: '  ' })];
      await openHome();
      expect(await screen.findByText('A friend added you to a bill')).toBeTruthy();
      expect(screen.getByLabelText("Open A friend's bill")).toBeTruthy();
    });

    it('32: two new bills say "You were added to 2 bills", with no Open', async () => {
      server.rows = [mine(X), mine(Y, { host_name: 'Sam' })];
      await openHome();
      expect(await screen.findByText('You were added to 2 bills')).toBeTruthy();
      expect(screen.getByText("They're marked New below.")).toBeTruthy();
      expect(screen.queryByText('Open')).toBeNull();
      expect(screen.getByLabelText('Dismiss').props.accessibilityHint).toBe('Hides this and removes New from these bills');
      expect(screen.getAllByText('New')).toHaveLength(2);
    });

    it('"You": a bill the viewer hosts never shows the card or a pill, even marked added', async () => {
      server.rows = [mine(X, { host_id: B, host_name: 'Bo', payer_id: B, added: true })];
      await openHome();
      expect(await screen.findByText('Your bill')).toBeTruthy();
      expect(screen.getByText('$44.80')).toBeTruthy();
      expect(screen.queryByText(/added you/)).toBeNull();
      expect(screen.queryByText(/You were added/)).toBeNull();
      expect(screen.queryByText('New')).toBeNull();
      expect(screen.queryByText('Claim your items')).toBeNull();
    });

    it('34: rows show their pill as text, and every row label is homeRowView\'s, in section order', async () => {
      server.rows = [
        mine(X, { seen: true }), // H3
        mine(Y, { host_id: B, host_name: 'Bo', payer_id: B, added: false }), // H1
        mine(Z, { seen: true, claimed_any: true }), // H4
        mine('11111111-1111-4111-8111-444444444444', { seen: true, complete: true }), // H6
        mine('11111111-1111-4111-8111-555555555555', { added: false, seen: true, payer_id: B }), // H8
      ];
      await openHome();
      expect(await screen.findAllByText('Claim your items')).toHaveLength(1);
      expect(screen.queryByText('New')).toBeNull();
      expect(screen.queryByText(/added you/)).toBeNull();
      const rowLabels = outsideTabBar(screen.getAllByRole('link')).map((el) => el.props.accessibilityLabel as string);
      // No settle data (the bills fixture isn't a list) and no counts: each row's view from its summary alone.
      // Rendered order (HOME-SEC-1): Items to claim, Still needs to be paid, then Owed to you (Settled
      // is collapsed and has no rows here).
      const { claim, pay, owed } = homeSections(server.rows.map((r) => homeRowView(summaryOf(r), B, undefined, undefined)));
      expect(rowLabels).toEqual([...claim, ...pay, ...owed].map((v) => v.a11yLabel));
      expect(screen.getByLabelText("Hana's bill, Nov 20, total $44.80. Claim your items")).toBeTruthy();
      expect(screen.getByLabelText('Your bill, Nov 20, total $44.80')).toBeTruthy();
    });

    it('37: my_bills failing on first load shows the error with Try again, and no card', async () => {
      server.myBills = () => ({ data: null, error: { code: '08006', message: 'server text' } });
      renderRouter(ROUTES, { initialUrl: '/' });
      expect(await screen.findByText("Couldn't load your bills.")).toBeTruthy();
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      expect(screen.queryByText(/server text/)).toBeNull();
      server.myBills = null;
      fireEvent.press(screen.getByText('Try again'));
      expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
    });
  });

  describe('Open, and returning to Home', () => {
    it('32: Open pushes /bills/<id> once; back on Home the card and New are gone', async () => {
      const push = jest.spyOn(globalRouter, 'push');
      const router = await openHome();
      await press("Open Hana's bill");
      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${X}`));
      expect(push.mock.calls.filter(([href]) => String(href).startsWith('/bills/'))).toEqual([[`/bills/${X}`]]);
      // The bill screen marks it seen (D6), after its debounce (useMarkSeen, sent-via-Venmo F7);
      // Home's focus refetch shows that on return.
      expect(await screen.findByText('Total $44.80')).toBeTruthy();
      expect(calls('mark_bill_seen')).toHaveLength(0);
      act(() => {
        jest.advanceTimersByTime(SEEN_DEBOUNCE_MS);
      });
      await waitFor(() => expect(calls('mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: X }]]));
      const before = calls('my_bills').length;
      await act(async () => globalRouter.back());
      await waitFor(() => expect(router.getPathname()).toBe('/'));
      await waitFor(() => expect(calls('my_bills').length).toBeGreaterThan(before));
      expect(await screen.findByText('Claim your items')).toBeTruthy();
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      expect(screen.queryByText('New')).toBeNull();
    });
  });

  describe('Dismiss', () => {
    it('33: one bill: hides at once, marks it seen, then reloads once after the call settles', async () => {
      const hold = deferred();
      server.mark = (id) =>
        hold.promise.then((r) => {
          markSeen(id);
          return r;
        });
      await openHome();
      await screen.findByText(ONE_TITLE);
      const loads = calls('my_bills').length;
      await press('Dismiss');
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      expect(calls('mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: X }]]);
      // The row keeps New until the server says otherwise; no reload before the write settles.
      expect(screen.getByText('New')).toBeTruthy();
      expect(calls('my_bills')).toHaveLength(loads);
      await act(async () => hold.resolve({ data: null, error: null }));
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      expect(await screen.findByText('Claim your items')).toBeTruthy();
      expect(screen.queryByText('New')).toBeNull();
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
    });

    it('33: many bills: marks each once with exactly { p_bill_id }, then reloads once', async () => {
      server.rows = [mine(X), mine(Y), mine(Z, { seen: true })];
      await openHome();
      await screen.findByText('You were added to 2 bills');
      const loads = calls('my_bills').length;
      await press('Dismiss');
      expect(screen.queryByText(/You were added/)).toBeNull();
      expect(calls('mark_bill_seen')).toEqual([
        ['mark_bill_seen', { p_bill_id: X }],
        ['mark_bill_seen', { p_bill_id: Y }],
      ]);
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      expect(await screen.findAllByText('Claim your items')).toHaveLength(3);
      expect(screen.queryByText('New')).toBeNull();
    });

    it('a double tap sends one mark per bill and one reload', async () => {
      server.rows = [mine(X), mine(Y)];
      await openHome();
      await screen.findByText('You were added to 2 bills');
      const loads = calls('my_bills').length;
      const dismiss = screen.getByLabelText('Dismiss');
      await act(async () => {
        fireEvent.press(dismiss);
        fireEvent.press(dismiss);
      });
      expect(calls('mark_bill_seen')).toHaveLength(2);
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      await act(async () => {});
      expect(calls('my_bills')).toHaveLength(loads + 1);
    });

    it('33: a refetch answered before the write commits does not bring the card back', async () => {
      const app = spyAppState();
      const hold = deferred();
      server.mark = (id) =>
        hold.promise.then((r) => {
          markSeen(id);
          return r;
        });
      await openHome();
      await screen.findByText(ONE_TITLE);
      await press('Dismiss');
      // A foreground refetch lands while the write is in flight: the server still says not seen.
      const loads = calls('my_bills').length;
      await app.emit('active');
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      await act(async () => {});
      expect(screen.getByText('New')).toBeTruthy();
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      await act(async () => hold.resolve({ data: null, error: null }));
      expect(await screen.findByText('Claim your items')).toBeTruthy();
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
    });

    it.each<[string, () => FakeResult | Promise<FakeResult>]>([
      ['42501', () => ({ data: null, error: { code: '42501', message: 'not_allowed' } })],
      ['a network error', () => ({ data: null, error: { code: '08006', message: 'server text' } })],
      ['a thrown request', () => Promise.reject(new Error('offline'))],
    ])('33: a failed mark (%s) shows nothing; the card stays hidden and the row keeps New', async (_name, fail) => {
      server.mark = fail;
      await openHome();
      await screen.findByText(ONE_TITLE);
      const loads = calls('my_bills').length;
      await press('Dismiss');
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      await act(async () => {});
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      expect(screen.getByText('New')).toBeTruthy();
      expect(screen.queryByText(/server text|offline|not_allowed|Couldn't|wrong/)).toBeNull();
    });

    it('33: a bill that turns up as new later still shows a card', async () => {
      const app = spyAppState();
      await openHome();
      await screen.findByText(ONE_TITLE);
      await press('Dismiss');
      expect(await screen.findByText('Claim your items')).toBeTruthy();
      server.rows = [mine(Y, { host_name: 'Sam', joined_at: '2026-11-21T12:00:00Z' }), ...server.rows];
      await app.emit('active');
      expect(await screen.findByText('Sam added you to a bill')).toBeTruthy();
      expect(screen.getByLabelText("Open Sam's bill")).toBeTruthy();
    });

    it('R2: a failed dismiss, then removed and re-added between refreshes, gets its card back', async () => {
      const app = spyAppState();
      server.mark = () => ({ data: null, error: { code: '08006', message: 'server text' } });
      await openHome();
      await screen.findByText(ONE_TITLE);
      await press('Dismiss');
      await waitFor(() => expect(calls('my_bills').length).toBeGreaterThanOrEqual(2));
      await act(async () => {});
      expect(screen.queryByText(ONE_TITLE)).toBeNull();
      // Hana removed B and added B again before Home refreshed: same bill, a new joined_at.
      server.rows = [mine(X, { joined_at: '2026-11-21T09:00:00Z' })];
      await app.emit('active');
      expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
    });

    it('a bill dismissed, then left and added again, gets its card back', async () => {
      const app = spyAppState();
      await openHome();
      await screen.findByText(ONE_TITLE);
      await press('Dismiss');
      expect(await screen.findByText('Claim your items')).toBeTruthy();
      // B leaves X (it drops off the list), then Hana adds B again: X is new once more.
      server.rows = [];
      await app.emit('active');
      expect(await screen.findByText('No bills yet.')).toBeTruthy();
      server.rows = [mine(X)];
      await app.emit('active');
      expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
    });
  });

  describe('35: foreground refresh', () => {
    it('refetches on "active" while Home is focused, not on "background"', async () => {
      const app = spyAppState();
      await openHome();
      const loads = calls('my_bills').length;
      await app.emit('background');
      expect(calls('my_bills')).toHaveLength(loads);
      server.rows = [mine(X), mine(Y, { host_name: 'Sam' })];
      await app.emit('active');
      await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
      expect(await screen.findByText('You were added to 2 bills')).toBeTruthy();
    });

    it('after navigating away (blurred), "active" does not refetch Home', async () => {
      const app = spyAppState();
      const router = await openHome();
      await press('Profile');
      await waitFor(() => expect(router.getPathname()).toBe('/profile'));
      await screen.findByText('Sign out');
      const loads = calls('my_bills').length;
      await app.emit('active');
      await act(async () => {});
      expect(calls('my_bills')).toHaveLength(loads);
    });

    it('unmounting Home removes its listener and sets no state', async () => {
      const app = spyAppState();
      const errors = jest.spyOn(console, 'error');
      const hold = deferred();
      const router = await openHome();
      server.myBills = () => hold.promise;
      await app.emit('active'); // a refresh is in flight
      router.unmount();
      expect(app.subs.length).toBeGreaterThan(0);
      expect(app.subs.every((s) => s.removed)).toBe(true);
      await act(async () => hold.resolve({ data: [mine(X)], error: null }));
      expect(errors.mock.calls.some((c) => String(c[0]).includes('act('))).toBe(false);
    });
  });

  it('37: a failed refresh keeps the list and the card', async () => {
    const app = spyAppState();
    await openHome();
    await screen.findByText(ONE_TITLE);
    server.myBills = () => ({ data: null, error: { code: '08006', message: 'server text' } });
    const loads = calls('my_bills').length;
    await app.emit('active');
    await waitFor(() => expect(calls('my_bills')).toHaveLength(loads + 1));
    await act(async () => {});
    expect(screen.getByText(ONE_TITLE)).toBeTruthy();
    expect(screen.getByLabelText(X_NEW_LABEL)).toBeTruthy();
    expect(screen.queryByText("Couldn't load your bills.")).toBeNull();
  });

  it('36: a pending invite with the app opened on / resumes to the bill; Home never navigates', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const replace = jest.spyOn(globalRouter, 'replace');
    await savePendingInvite(storage, CODE, Date.now());
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${X}`));
    // Let any fetch started by a brief Home mount settle before asserting it changed nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.getPathname()).toBe(`/bills/${X}`);
    // R1: the bill loaded ready on this route, so it was marked seen, once, for X only.
    expect(await screen.findByText('Total $44.80')).toBeTruthy();
    act(() => {
      jest.advanceTimersByTime(SEEN_DEBOUNCE_MS);
    });
    await waitFor(() => expect(calls('mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: X }]]));
    expect(push).not.toHaveBeenCalled();
    // The resume effect's replace, then the join screen's; nothing from Home.
    expect(replace.mock.calls.map(([href]) => href)).toEqual([`/b/${CODE}`, `/bills/${X}`]);
    expect(screen.queryByText(ONE_TITLE)).toBeNull();
  });
});

// Native only: on web, Google sign-in leaves the page and the app starts again (a cold start, above).
it('sign-out clears what was dismissed: signing back in shows the card again', async () => {
  // The mark keeps failing, so the server still says New for X.
  server.mark = () => ({ data: null, error: { code: '08006', message: 'server text' } });
  const router = await openHome();
  await screen.findByText(ONE_TITLE);
  await press('Dismiss');
  expect(screen.queryByText(ONE_TITLE)).toBeNull();
  await press('Profile');
  await act(async () => {
    fireEvent.press(await screen.findByText('Sign out'));
  });
  await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
  await act(async () => {
    fireEvent.press(await screen.findByText('Continue with Google'));
  });
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalled();
  await waitFor(() => expect(router.getPathname()).toBe('/'));
  expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Settle pills: docs/specs/2026-11-25-settle-early-and-differences.md D7, Task 9, criteria 44 and
// 63 (A1.9, A1.19 / SE-UX-14, SE-VIS-1, Q-GLYPH). The viewer is B.
// ---------------------------------------------------------------------------

const C = '00000000-0000-4000-8000-00000000000c';
const S1 = '33333333-3333-4333-8333-000000000001'; // Hana's bill, B owes $14.80 (H1)
const S2 = '33333333-3333-4333-8333-000000000002'; // Hana's bill, B marked $14.80 (H2)
const S3 = '33333333-3333-4333-8333-000000000003'; // B hosts and pays; Hana hasn't paid (H5)
const S4 = '33333333-3333-4333-8333-000000000004'; // B pays, not complete: read (sent can show), no pill without sends
const SETTLE_TABLES = ['bills', 'line_items', 'bill_participants', 'claims'] as const;
type SettleTable = (typeof SETTLE_TABLES)[number];
type RawRow = Record<string, unknown>;
type Person = { user: string; name: string; cents: number; marked?: number };

const NAMES: Record<string, string> = { [A]: 'Hana', [B]: 'Bo', [C]: 'Cy' };

/** One complete bill: each person claims one item of `cents`; the total is their sum. */
function settleBill(id: string, payer: string, people: Person[], host = payer): Record<SettleTable, RawRow[]> {
  const total = people.reduce((sum, p) => sum + p.cents, 0);
  const itemId = (i: number) => `${id.slice(0, -2)}${String(10 + i)}`;
  return {
    bills: [
      {
        id,
        host_id: host,
        payer_id: payer,
        subtotal_cents: null,
        tax_cents: 0,
        fees_cents: 0,
        tip_cents: 0,
        subtotal_discount_cents: 0,
        total_discount_cents: 0,
        total_cents: total,
        join_code: CODE,
        created_at: CREATED,
        edited_at: null,
        extras_split: 'proportional',
      },
    ],
    line_items: people.map((p, i) => ({
      bill_id: id,
      id: itemId(i),
      name: `Item ${i + 1}`,
      note: null,
      group_position: i,
      unit_index: 0,
      group_size: 1,
      total_cents: p.cents,
      split_set_by: null,
      split_set_at: null,
    })),
    bill_participants: people.map((p) => ({
      bill_id: id,
      user_id: p.user,
      joined_at: CREATED,
      settled_at: p.marked === undefined ? null : '2026-11-21T12:00:00Z',
      settled_cents: p.marked ?? null,
      profile: { display_name: NAMES[p.user] ?? null, venmo_username: null },
    })),
    claims: people.map((p, i) => ({ bill_id: id, line_item_id: itemId(i), user_id: p.user, parts: 1 })),
  };
}

/** The my_bills row for a complete settle bill: seen, claimed, complete. */
function settleRow(id: string, over: Partial<Row> = {}): Row {
  return mine(id, { added: false, seen: true, claimed_any: true, complete: true, ...over });
}

const owesBill = (id: string, marked?: number) =>
  settleBill(id, A, [
    { user: A, name: 'Hana', cents: 3000 },
    { user: B, name: 'Bo', cents: 1480, marked },
  ]);

/** The settle tables, the gates that hold the next batched reads, and a switch that fails them. */
const settleDb: { data: Record<SettleTable, RawRow[]>; gates: Promise<void>[]; fail: boolean } = {
  data: { bills: [], line_items: [], bill_participants: [], claims: [] },
  gates: [],
  fail: false,
};

function useSettleBills(...bills: Record<SettleTable, RawRow[]>[]) {
  settleDb.data = {
    bills: bills.flatMap((b) => b.bills),
    line_items: bills.flatMap((b) => b.line_items),
    bill_participants: bills.flatMap((b) => b.bill_participants),
    claims: bills.flatMap((b) => b.claims),
  };
}

/** Answers fetchBill (eq) and fetchSettleData (in) from settleDb, the way PostgREST filters. */
function seedSettleTables() {
  for (const table of SETTLE_TABLES) {
    supabase.__setTable(table, async (q) => {
      const key = table === 'bills' ? 'id' : 'bill_id';
      const eq = q.calls.find((c) => c.method === 'eq');
      const inn = q.calls.find((c) => c.method === 'in');
      // The data as it was when the request was sent (a held request answers with old data).
      let rows = settleDb.data[table];
      if (inn && table === 'bills') {
        const gate = settleDb.gates.shift();
        const fail = settleDb.fail;
        if (gate) await gate;
        if (fail) return { data: null, error: { code: '08006', message: 'server text' } };
      }
      if (eq) rows = rows.filter((r) => r[key] === eq.args[1]);
      if (inn) rows = rows.filter((r) => (inn.args[1] as unknown[]).includes(r[key]));
      if (q.calls.some((c) => c.method === 'maybeSingle')) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    });
  }
}

/** A gate the next batched read waits on, and its release. */
function holdNextSettleRead() {
  let release: () => void = () => {};
  settleDb.gates.push(new Promise<void>((r) => (release = r)));
  return async () => {
    await act(async () => release());
  };
}

/** The ids each fetchSettleData call asked for, in order. */
const settleReads = () =>
  supabase.__queries
    .filter((q) => q.table === 'bills' && q.calls.some((c) => c.method === 'in'))
    .map((q) => q.calls.find((c) => c.method === 'in')?.args[1] as string[]);

/** The View holding a status line and the caption under it. */
function statusBlock(text: string) {
  let block = screen.getByText(text).parent;
  while (block && String(block.type) !== 'View') block = block.parent;
  if (!block) throw new Error(`no status block around ${text}`);
  return block;
}

/** Background colours on the host Views between a text and the row link around it (positive: the link is found). */
function tintsUpToRow(text: string): string[] {
  const tints: string[] = [];
  let node = screen.getByText(text).parent;
  while (node && node.props.accessibilityRole !== 'link') {
    const bg = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>)?.backgroundColor;
    if (String(node.type) === 'View' && bg) tints.push(String(bg));
    node = node.parent;
  }
  if (!node) throw new Error(`no row link around ${text}`);
  return tints;
}

/** Host elements that aren't plain views or text (an icon's svg, an image). */
const iconsIn = (node: ReturnType<typeof screen.getByText>) =>
  node.findAll((n) => typeof n.type === 'string' && !['View', 'Text'].includes(String(n.type)));

// D5 labels. S1–S3 have two people in the settle tables, which also answer Home's people-counts read;
// on a ready plan the amount is B's share (D3), and without one it's the total.
const S1_OWES = "Hana's bill, Nov 20, 2 people, your share $14.80. You owe $14.80";
const S1_PAID = "Hana's bill, Nov 20, 2 people, your share $14.80. Paid $14.80";
const S1_PLAIN = "Hana's bill, Nov 20, 2 people, total $44.80";
// Groups v2 (A1.M2): S3 is B's own bill under "Owed to you", so its figure is what's still to
// collect (Hana's unmarked $30.00), not the total.
const S3_COLLECT = 'Your bill, Nov 20, 2 people, to collect $30.00. 1 person still has to pay you';
const Y_UNCLAIMED = "Hana's bill, Nov 20, total $44.80. Claim your items";
const LINKS_ON_OPEN = [X_NEW_LABEL, Y_UNCLAIMED, S1_OWES, S3_COLLECT, 'Your bill, Nov 20, total $44.80'];
const links = () => outsideTabBar(screen.getAllByRole('link')).map((el) => el.props.accessibilityLabel as string);
/**
 * Groups v2 (rule 4): S2 (B marked his whole share on a ready plan) is hidden from Home. Review R5:
 * the whole row list is checked, so S2 can't be back in another form (e.g. as S1_PLAIN, its no-plan label).
 */
const S2_HIDDEN = (expected: readonly string[]) => {
  expect(links()).toEqual(expected);
  expect(expected).not.toContain(S1_PAID);
  expect(screen.queryByText('Paid $14.80')).toBeNull();
};

describe.each(['ios', 'web'] as const)('Home settle pills (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    settleDb.gates = [];
    settleDb.fail = false;
    useSettleBills(
      owesBill(S1),
      owesBill(S2, 1480),
      settleBill(S3, B, [
        { user: A, name: 'Hana', cents: 3000 },
        { user: B, name: 'Bo', cents: 1480 },
      ]),
    );
    seedSettleTables();
    server.rows = [
      mine(X), // New
      mine(Y, { seen: true }), // Claim your items
      settleRow(S1),
      settleRow(S2),
      settleRow(S3, { host_id: B, host_name: 'Bo', payer_id: B }),
      settleRow(S4, { host_id: B, host_name: 'Bo', payer_id: B, complete: false }),
    ];
  });

  async function openWithPills(initialUrl = '/') {
    const router = renderRouter(ROUTES, { initialUrl });
    await screen.findByRole('header', { name: 'SplitIt' });
    expect(await screen.findByText('You owe $14.80')).toBeTruthy();
    // The people counts have landed too (S1 and S3 have two people each; S2 is hidden, groups v2).
    expect(await screen.findAllByText('Nov 20 · 2 people')).toHaveLength(2);
    return router;
  }

  it('44: cold start: each row shows its D7 pill in its tone, and its label carries the words', async () => {
    await openWithPills();
    // The list's markers that need no settle data are still there, first in priority.
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('Claim your items')).toBeTruthy();
    expect(screen.getByText('1 person left to pay')).toBeTruthy();
    S2_HIDDEN(LINKS_ON_OPEN); // after the plans have landed ("You owe" above)
    // HOME-POLISH-1: each marker is a status line, words in its tone's colour with no pill shape:
    // accent (the viewer's next step) = primary at 600, muted = textMuted at the regular weight.
    const { light } = colors;
    for (const [status, fg, weight] of [
      ['New', light.primary, '600'],
      ['You owe $14.80', light.primary, '600'],
      ['Claim your items', light.primary, '600'],
      ['1 person left to pay', light.textMuted, undefined],
    ] as const) {
      const style = StyleSheet.flatten(screen.getByText(status).props.style as StyleProp<TextStyle>);
      expect([status, style.color, style.fontWeight]).toEqual([status, fg, weight]);
      // No tinted box between the words and their row (the old pill), and no role of its own.
      expect([status, tintsUpToRow(status)]).toEqual([status, []]);
      expect(screen.getByText(status).props.accessibilityRole).toBeUndefined();
    }
    // One accessible element per row: the link's label includes the marker's words.
    expect(outsideTabBar(screen.getAllByRole('link')).map((el) => el.props.accessibilityLabel as string)).toEqual([
      X_NEW_LABEL,
      "Hana's bill, Nov 20, total $44.80. Claim your items",
      S1_OWES,
      S3_COLLECT,
      'Your bill, Nov 20, total $44.80',
    ]);
  });

  it('44 + 63: one batched read, for the candidates only (no New, no unclaimed; an incomplete bill B pays is read, sent-via-Venmo D7)', async () => {
    await openWithPills();
    expect(settleReads()).toEqual([[S1, S2, S3, S4]]);
  });

  it('Q-GLYPH: a "done" pill (H2) draws no icon; the row around it does have one (the chevron)', async () => {
    // Groups v2: a ready "Paid" bill is hidden, so the visible "done" pill is an early plan whose
    // share moved after B paid (B's item is $16.20, he marked $14.80, Cy's $5 item is unclaimed):
    // marker 'paid' (icon 'check'), under Waiting on you (D3, D-2).
    const early = settleBill(S2, A, [
      { user: A, name: 'Hana', cents: 3000 },
      { user: B, name: 'Bo', cents: 1620, marked: 1480 },
      { user: C, name: 'Cy', cents: 500 },
    ]);
    early.claims = early.claims.filter((c) => c.user_id !== C);
    early.bill_participants = early.bill_participants.filter((p) => p.user_id !== C);
    useSettleBills(owesBill(S1), early);
    server.rows = [settleRow(S1), settleRow(S2, { complete: false })];
    renderRouter(ROUTES, { initialUrl: '/' });
    const row = await screen.findByLabelText("Hana's bill, Nov 20, 2 people, total $44.80. Paid $14.80"); // early: the total
    expect(iconsIn(row).length).toBeGreaterThan(0); // positive control: the detector sees the chevron
    // HOME-POLISH-1: the status line's block (the words and the date caption) holds no icon.
    expect(iconsIn(statusBlock('Paid $14.80'))).toEqual([]);
    expect(screen.queryByText(/✓|⚠/)).toBeNull();
  });

  it('copy at 2: "2 people left to pay" and "2 people still have to pay you"', async () => {
    useSettleBills(
      settleBill(S3, B, [
        { user: A, name: 'Hana', cents: 3000 },
        { user: B, name: 'Bo', cents: 1000 },
        { user: C, name: 'Cy', cents: 480 },
      ]),
    );
    server.rows = [settleRow(S3, { host_id: B, host_name: 'Bo', payer_id: B })];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText('2 people left to pay')).toBeTruthy();
    // A1.M2: B pays, so the figure is what's still to collect (Hana's $30.00 + Cy's $4.80), not the total.
    expect(await screen.findByLabelText('Your bill, Nov 20, 3 people, to collect $34.80. 2 people still have to pay you')).toBeTruthy();
  });

  it('after the web OAuth redirect lands on / (session picked up from the URL), pills load once and Home stays put', async () => {
    const replace = jest.spyOn(globalRouter, 'replace');
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openWithPills('/?code=fake-pkce-code');
    expect(screen.getByLabelText(S3_COLLECT)).toBeTruthy(); // a settle pill from the plans
    S2_HIDDEN(LINKS_ON_OPEN);
    expect(router.getPathname()).toBe('/');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(settleReads()).toHaveLength(calls('my_bills').length);
  });

  it('44: a failed settle read on first load shows today\'s markers and no error', async () => {
    settleDb.fail = true;
    renderRouter(ROUTES, { initialUrl: '/' });
    await screen.findByText('Claim your items');
    await waitFor(() => expect(settleReads()).toHaveLength(1));
    await act(async () => {});
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.queryByText('You owe $14.80')).toBeNull();
    expect(screen.queryByText('Paid $14.80')).toBeNull();
    expect(await screen.findAllByLabelText(S1_PLAIN)).toHaveLength(2); // S1 and S2, with no settle words
    expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();
  });

  it('44 / SE-UX-14: back from a bill, rows keep their pills until the new read lands, then update', async () => {
    const router = await openWithPills();
    await press(S1_OWES);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${S1}`));
    // B paid Hana while away; the next settle read is held.
    useSettleBills(owesBill(S1, 1480), owesBill(S2, 1480));
    const release = holdNextSettleRead();
    const reads = settleReads().length;
    const loads = calls('my_bills').length;
    await act(async () => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await waitFor(() => expect(settleReads()).toHaveLength(reads + 1));
    expect(calls('my_bills').length).toBeGreaterThan(loads);
    // my_bills has landed; the settle read hasn't: the old pills stay (no blink).
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    expect(screen.getByLabelText(S1_OWES)).toBeTruthy();
    expect(screen.getByText('1 person left to pay')).toBeTruthy();
    await release();
    // S3 isn't in the new data, so it loses its pill, its "To collect" and its count (the counts read
    // answers from the same tables) rather than keep guessed ones: the new read has landed (S3 and S4
    // now read the same). Groups v2: S1 is now paid up, so it's hidden like S2.
    await waitFor(() => expect(screen.getAllByLabelText('Your bill, Nov 20, total $44.80')).toHaveLength(2));
    expect(screen.queryByText('1 person left to pay')).toBeNull();
    expect(screen.queryByText('You owe $14.80')).toBeNull();
    expect(screen.queryByLabelText(S1_OWES)).toBeNull();
    S2_HIDDEN([X_NEW_LABEL, Y_UNCLAIMED, 'Your bill, Nov 20, total $44.80', 'Your bill, Nov 20, total $44.80']);
  });

  it('35 / SE-UX-14: a foreground refresh keeps pills while reading; New and unclaimed follow my_bills at once', async () => {
    const app = spyAppState();
    await openWithPills();
    const release = holdNextSettleRead();
    // X was opened elsewhere (no longer New), S1 left the list, and the rest are unchanged.
    server.rows = [mine(X, { seen: true }), mine(Y, { seen: true }), settleRow(S2), settleRow(S3, { host_id: B, host_name: 'Bo', payer_id: B })];
    await app.emit('active');
    await waitFor(() => expect(screen.queryByText('New')).toBeNull());
    expect(screen.getAllByText('Claim your items')).toHaveLength(2);
    expect(screen.getByText('1 person left to pay')).toBeTruthy(); // S3 keeps its pill while reading
    // S1 left the list, and its pill with it; S2 keeps its facts, so it stays hidden.
    expect(screen.queryByText('You owe $14.80')).toBeNull();
    S2_HIDDEN([Y_UNCLAIMED, Y_UNCLAIMED, S3_COLLECT]);
    expect(settleReads().at(-1)).toEqual([S2, S3]);

    // Review R5: S1 comes back while that read is still held (no read has replaced the facts since it
    // left), and the next one is held too. Its facts were dropped when it left (keepCandidates), so
    // it shows with no pill until a read lands: no stale "You owe".
    const releaseBack = holdNextSettleRead();
    const reads = settleReads().length;
    server.rows = [mine(X, { seen: true }), mine(Y, { seen: true }), settleRow(S1), settleRow(S2), settleRow(S3, { host_id: B, host_name: 'Bo', payer_id: B })];
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toHaveLength(reads + 1));
    await waitFor(() => expect(links()).toEqual([Y_UNCLAIMED, Y_UNCLAIMED, S1_PLAIN, S3_COLLECT]));
    expect(screen.queryByText('You owe $14.80')).toBeNull();
    await release(); // the older read lands and is ignored (latest token)
    expect(links()).toEqual([Y_UNCLAIMED, Y_UNCLAIMED, S1_PLAIN, S3_COLLECT]);
    await releaseBack();
    expect(await screen.findByText('You owe $14.80')).toBeTruthy(); // positive control: the read applies
    S2_HIDDEN([Y_UNCLAIMED, Y_UNCLAIMED, S1_OWES, S3_COLLECT]);
  });

  it('review R4: a bill that drops out of the settle candidates loses its pill before the new read lands', async () => {
    const app = spyAppState();
    await openWithPills();
    expect(screen.getByText('1 person left to pay')).toBeTruthy(); // positive control: S3 had a pill
    const release = holdNextSettleRead();
    const reads = settleReads().length;
    // S3 is now Hana's bill with nothing claimed by B: 'unclaimed' wins, so it isn't a candidate.
    server.rows = [
      mine(X),
      mine(Y, { seen: true }),
      settleRow(S1),
      settleRow(S2),
      settleRow(S3, { claimed_any: false, complete: false }),
      settleRow(S4, { host_id: B, host_name: 'Bo', payer_id: B, complete: false }),
    ];
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toHaveLength(reads + 1));
    expect(settleReads().at(-1)).toEqual([S1, S2, S4]);
    // my_bills has landed and the settle read is held: S3's settle pill is gone at once; the candidates keep theirs.
    expect(screen.queryByText('1 person left to pay')).toBeNull();
    // S3 shows only its list marker (it keeps its people count); S4 has no settle words.
    expect(screen.getByLabelText("Hana's bill, Nov 20, 2 people, total $44.80. Claim your items")).toBeTruthy();
    expect(screen.getByLabelText('Your bill, Nov 20, total $44.80')).toBeTruthy();
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    // groups v2: S2 keeps its "paid" plan, so it stays hidden (not back under Waiting)
    // HOME-SEC-1: the nothing-claimed rows (Items to claim) come before S1's (Still needs to be paid).
    S2_HIDDEN([X_NEW_LABEL, Y_UNCLAIMED, "Hana's bill, Nov 20, 2 people, total $44.80. Claim your items", S1_OWES, 'Your bill, Nov 20, total $44.80']);
    await release();
    expect(screen.queryByText('1 person left to pay')).toBeNull();
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
  });

  // Groups v2 A1.S5 (rewrites HM-5 on Home): a failed refresh keeps the previous plans, so no pill
  // goes and no row moves; only a failed first read leaves no plans (the "first load" test above).
  it('44 / A1.S5: a failed settle read on refresh keeps every settle pill and group, with no error banner', async () => {
    const app = spyAppState();
    await openWithPills();
    const before = links();
    expect(before).toEqual(LINKS_ON_OPEN); // positive control: the plans are on screen
    settleDb.fail = true;
    const release = holdNextSettleRead();
    const reads = settleReads().length;
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toHaveLength(reads + 1)); // the failing read was made
    await release();
    await act(async () => {});
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    expect(screen.getByText('1 person left to pay')).toBeTruthy();
    S2_HIDDEN(before); // still hidden: it didn't come back under Waiting on you
    expect(screen.queryAllByLabelText(S1_PLAIN)).toEqual([]);
    expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();
  });

  it('44: a response from an older load is ignored once a newer one has started', async () => {
    const app = spyAppState();
    await openWithPills();
    // Load 2's read is held and answers with old data (B owes); load 3's answers at once (B paid).
    const releaseOld = holdNextSettleRead();
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toHaveLength(2));
    useSettleBills(owesBill(S1, 1480));
    await app.emit('active');
    // Load 3's data has only S1, where B has now paid. Groups v2: S1 is hidden; S2 and S3, missing
    // from it, have no plan (and no count), so S2 shows under Waiting on you with no pill (GV-5).
    const load3 = [
      X_NEW_LABEL,
      "Hana's bill, Nov 20, total $44.80. Claim your items",
      "Hana's bill, Nov 20, total $44.80",
      'Your bill, Nov 20, total $44.80',
      'Your bill, Nov 20, total $44.80',
    ];
    await waitFor(() => expect(links()).toEqual(load3));
    await releaseOld();
    await act(async () => {});
    // The old answer (B owes on S1, B marked S2, Hana owes on S3) was dropped: still load 3's rows.
    expect(links()).toEqual(load3);
    expect(screen.queryByText('You owe $14.80')).toBeNull();
  });
});
