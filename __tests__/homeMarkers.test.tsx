// Home's "added you to a bill" card, the row markers and the foreground refresh: criteria 31–39 in
// docs/specs/2026-11-24-bill-markers-and-notices.md (Task 5). Every flow runs on native and on web
// (lessons log 2026-11-19 and 2026-11-24: entry paths on both platforms).
// The viewer is B. Hana (A) hosts and pays unless a fixture says otherwise.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import * as WebBrowser from 'expo-web-browser';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import type { BillSummary } from '@/lib/bills';
import { billRowA11yLabel } from '@/lib/homeMarkers';
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

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const X = '11111111-1111-4111-8111-111111111111';
const Y = '11111111-1111-4111-8111-222222222222';
const Z = '11111111-1111-4111-8111-333333333333';
const CODE = '0123456789abcdef0123';

// Midday UTC, so the short date is "Nov 20" in any test-machine time zone from UTC-11 to UTC+11.
const CREATED = '2026-11-20T12:00:00Z';
const ONE_TITLE = 'Hana added you to a bill';
const X_NEW_LABEL = "Hana's bill · Nov 20 · $44.80. New, you haven't opened it yet";

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

/** The screen's text in render order, to check the card sits above "Split a bill". */
const screenText = () => JSON.stringify(screen.toJSON());

async function openHome() {
  const router = renderRouter(ROUTES, { initialUrl: '/' });
  await screen.findByText('Your bills');
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
    it('31: one new bill shows the card first, above "Split a bill", and the row says New', async () => {
      const router = await openHome();
      expect(await screen.findByText(ONE_TITLE)).toBeTruthy();
      expect(screen.getByText('Nov 20 · $44.80')).toBeTruthy();
      expect(screen.getByText('Open')).toBeTruthy();
      expect(screen.getByText('Dismiss')).toBeTruthy();
      const text = screenText();
      expect(text.indexOf(ONE_TITLE)).toBeGreaterThan(-1);
      expect(text.indexOf(ONE_TITLE)).toBeLessThan(text.indexOf('Split a bill'));
      // The row: its pill is visible text, and its label is criterion 18's string.
      expect(screen.getByText('New')).toBeTruthy();
      expect(screen.getByLabelText(X_NEW_LABEL).props.accessibilityRole).toBe('link');
      // The card never navigates on its own.
      expect(router.getPathname()).toBe('/');
      expect(calls('mark_bill_seen')).toHaveLength(0);
    });

    it('visual-pass R2: "Split a bill" is a heading for screen readers', async () => {
      await openHome();
      expect(screen.getByRole('header', { name: 'Split a bill' })).toBeTruthy();
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
      expect(await screen.findByText(/^Your bill · Nov 20 · \$44\.80$/)).toBeTruthy();
      expect(screen.queryByText(/added you/)).toBeNull();
      expect(screen.queryByText(/You were added/)).toBeNull();
      expect(screen.queryByText('New')).toBeNull();
      expect(screen.queryByText('Nothing claimed yet')).toBeNull();
    });

    it('34: rows show their pill as text, and every row label is billRowA11yLabel', async () => {
      server.rows = [
        mine(X, { seen: true }), // H3
        mine(Y, { host_id: B, host_name: 'Bo', payer_id: B, added: false }), // H1
        mine(Z, { seen: true, claimed_any: true }), // H4
        mine('11111111-1111-4111-8111-444444444444', { seen: true, complete: true }), // H6
        mine('11111111-1111-4111-8111-555555555555', { added: false, seen: true, payer_id: B }), // H8
      ];
      await openHome();
      expect(await screen.findAllByText('Nothing claimed yet')).toHaveLength(1);
      expect(screen.queryByText('New')).toBeNull();
      expect(screen.queryByText(/added you/)).toBeNull();
      const rowLabels = screen.getAllByRole('link').map((el) => el.props.accessibilityLabel as string);
      expect(rowLabels).toEqual(server.rows.map((r) => billRowA11yLabel(summaryOf(r), B)));
      expect(screen.getByLabelText("Hana's bill · Nov 20 · $44.80. You haven't claimed anything yet")).toBeTruthy();
      expect(screen.getByLabelText('Your bill · Nov 20 · $44.80')).toBeTruthy();
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
      // The bill screen marks it seen (D6); Home's focus refetch shows that on return.
      await waitFor(() => expect(calls('mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: X }]]));
      const before = calls('my_bills').length;
      await act(async () => globalRouter.back());
      await waitFor(() => expect(router.getPathname()).toBe('/'));
      await waitFor(() => expect(calls('my_bills').length).toBeGreaterThan(before));
      expect(await screen.findByText('Nothing claimed yet')).toBeTruthy();
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
      expect(await screen.findByText('Nothing claimed yet')).toBeTruthy();
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
      expect(await screen.findAllByText('Nothing claimed yet')).toHaveLength(3);
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
      expect(await screen.findByText('Nothing claimed yet')).toBeTruthy();
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
      expect(await screen.findByText('Nothing claimed yet')).toBeTruthy();
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
      expect(await screen.findByText('Nothing claimed yet')).toBeTruthy();
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
