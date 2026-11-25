// Bill screen: criteria 75–84 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 10).
// The bill is criterion 57's: Burger 15.00, Fries 6.00, Beer ×2 (7.00 each), total 44.80.
// A is the host (Hana Lee); the viewer is B (Bo).
import { render } from '@testing-library/react-native';
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { AppState, Platform, StyleSheet, type AppStateStatus } from 'react-native';

import { SharesSummary } from '@/components/SharesSummary';
import { makeNameOf } from '@/lib/billView';
import { LIVE_DEBOUNCE_MS } from '@/lib/billLive';
import { displayShares, type DisplayShares } from '@/lib/split';
import { openPaymentLink } from '@/lib/paylinks';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { LIVE_PAUSED_AFTER_MS } from '@/lib/useBill';
import { fakeSession, type FakeChannel, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

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
  return { ...actual, openPaymentLink: jest.fn(async () => ({ ok: true })) };
});

const supabase = realSupabase as unknown as FakeSupabase;
/** Every rpc call except the bill screen's fire-and-forget mark_bill_seen (bill markers D6), which runs once per open. */
const rpcCallsExceptSeen = () => supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen');
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';
const BEER1 = '22222222-0000-4000-8000-000000000003';
const BEER2 = '22222222-0000-4000-8000-000000000004';

type Claim = { line_item_id: string; user_id: string; parts: number };

const db: {
  bill: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
  participants: Record<string, unknown>[];
  claims: Claim[];
  failBills: boolean;
} = { bill: null, rows: [], participants: [], claims: [], failBills: false };

function row(id: string, name: string, cents: number, g: number, u = 0, size = 1) {
  return { id, name, note: null, group_position: g, unit_index: u, group_size: size, total_cents: cents, split_set_by: null, split_set_at: null };
}

function reset() {
  db.bill = {
    id: BILL,
    host_id: A,
    payer_id: A,
    subtotal_cents: null,
    tax_cents: 280,
    fees_cents: 0,
    tip_cents: 700,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 4480,
    join_code: '0123456789abcdef0123',
    created_at: '2026-11-20T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
  db.rows = [row(BURGER, 'Burger', 1500, 0), row(FRIES, 'Fries', 600, 1), row(BEER1, 'Beer', 700, 2, 0, 2), row(BEER2, 'Beer', 700, 2, 1, 2)];
  db.participants = [
    { user_id: A, joined_at: '2026-11-20T19:00:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Hana Lee', venmo_username: null } },
    { user_id: B, joined_at: '2026-11-20T19:05:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Bo', venmo_username: null } },
  ];
  db.claims = [];
  db.failBills = false;
}

const claim = (rowId: string, userId: string, parts = 1): Claim => ({ line_item_id: rowId, user_id: userId, parts });
/** Criterion 57(a): only B, on Fries and Beer 1. */
const STATE_A = () => [claim(FRIES, B), claim(BEER1, B)];
/** 57(b): then A claims Burger, Fries and Beer 2. */
const STATE_B = () => [...STATE_A(), claim(BURGER, A), claim(FRIES, A), claim(BEER2, A)];

function installTables() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () =>
    db.failBills ? { data: null, error: { code: '08006', message: 'server text: connection lost' } } : ok(db.bill),
  );
  supabase.__setTable('line_items', () => ok(db.rows.map((r) => ({ ...r }))));
  supabase.__setTable('bill_participants', () => ok(db.participants));
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
}

const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};

async function openBill(id = BILL) {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${id}` });
  await screen.findByText('Total $44.80');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  return router;
}

async function expand() {
  fireEvent.press(screen.getByLabelText(/^Your (share|items) /));
}

beforeEach(() => {
  jest.clearAllMocks();
  reset();
  installTables();
  supabase.__queries.length = 0;
  supabase.__setRpc(() => ({ data: null, error: null }));
  const session = fakeSession('Bo Bo');
  // The session carries an email on purpose: it must never be shown (criterion 84).
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: B } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('bill screen', () => {
  it('75: shows one row per unit, the total, the host, and the viewer as "You"', async () => {
    db.claims = STATE_A();
    await openBill();
    expect(screen.getByText('Burger')).toBeTruthy();
    expect(screen.getByText('Fries')).toBeTruthy();
    expect(screen.getByText('Beer · 1 of 2')).toBeTruthy();
    expect(screen.getByText('Beer · 2 of 2')).toBeTruthy();
    expect(screen.getByText("Hana Lee's bill")).toBeTruthy();
    await expand();
    expect(screen.getByLabelText('You $16.64')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $0.00')).toBeTruthy();
    // The viewer's own row status reads "You", with their amount.
    expect(screen.getByText('You · $6.00')).toBeTruthy();
  });

  it('76: each row has exactly one button (the toggle) plus the details target; no steppers or percentages on the list', async () => {
    await openBill();
    const buttons = screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));
    for (const name of ['Burger', 'Fries', 'Beer 1 of 2', 'Beer 2 of 2']) {
      expect(buttons.filter((l) => l === `Claim ${name}` || l === `Unclaim ${name}`)).toHaveLength(1);
      // Task 11 wired the row's single secondary target (criterion 76: "plus the details target").
      expect(buttons.filter((l) => l.startsWith(`${name}, `))).toHaveLength(1);
    }
    expect(buttons.filter((l) => /Burger|Fries|Beer/.test(l))).toHaveLength(8);
  });

  it('R2: the details target reads the price, status and claimers to screen readers', async () => {
    db.claims = STATE_B();
    await openBill();
    const details = screen.getByLabelText('Fries, $6.00, Split 2 ways · $3.00 each, claimed by You and Hana Lee');
    expect(details.props.accessibilityHint).toBe('Shows who pays what');
    expect(screen.getByLabelText('Burger, $15.00, Hana Lee')).toBeTruthy();
    expect(screen.getByLabelText('Beer 1 of 2, $7.00, You · $7.00')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/^[+−-]$/)).toBeNull();
  });

  it('77: claiming is optimistic and claims only that unit row', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    await openBill();
    fireEvent.press(screen.getByLabelText('Claim Fries'));
    expect(supabase.rpc).toHaveBeenCalledWith('set_claim', { p_line_item_id: FRIES, p_claimed: true });
    // Before the call resolves: B's avatar, the toggle's new state, and B's share.
    expect(screen.getByLabelText('Claimed by You')).toBeTruthy();
    expect(screen.getByLabelText('Unclaim Fries')).toBeTruthy();
    expect(screen.getByText('You · $6.00')).toBeTruthy();
    db.claims = [claim(FRIES, B)];
    await act(async () => resolve({ data: null, error: null }));

    supabase.__setRpc(() => ({ data: null, error: null }));
    const fetchesBefore = billFetches();
    db.claims = [claim(FRIES, B), claim(BEER1, B)];
    await act(async () => fireEvent.press(screen.getByLabelText('Claim Beer 1 of 2')));
    expect(supabase.rpc).toHaveBeenLastCalledWith('set_claim', { p_line_item_id: BEER1, p_claimed: true });
    expect(screen.getByLabelText('Claim Beer 2 of 2')).toBeTruthy();
    expect(rpcCallsExceptSeen()).toHaveLength(2);
    // Let the confirming refetch land inside act, so nothing updates after the test ends.
    await waitFor(() => expect(billFetches()).toBeGreaterThan(fetchesBefore));
    expect(await screen.findByLabelText('Unclaim Beer 1 of 2')).toBeTruthy();
  });

  it('77: a double press sends one claim', async () => {
    supabase.__setRpc(() => new Promise<FakeResult>(() => {}));
    await openBill();
    fireEvent.press(screen.getByLabelText('Claim Fries'));
    fireEvent.press(screen.getByLabelText('Unclaim Fries'));
    expect(rpcCallsExceptSeen()).toHaveLength(1);
  });

  it('78: shares for states 57(a), 57(b) and 57(c)', async () => {
    db.claims = STATE_A();
    await openBill();
    expect(screen.getByLabelText('Your share $16.64')).toBeTruthy();
    await expand();
    expect(screen.getByLabelText('Unclaimed $28.16')).toBeTruthy();
    expect(screen.getByText('Items $13.00 + tax, tip and fees $3.64')).toBeTruthy();

    db.claims = STATE_B();
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    expect(await screen.findByLabelText('Your share $12.80')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $32.00')).toBeTruthy();
    expect(screen.getByText("Everything's claimed.")).toBeTruthy();
    expect(screen.queryByLabelText(/^Unclaimed/)).toBeNull();
    expect(screen.getByText('Split 2 ways · $3.00 each')).toBeTruthy();
    expect(screen.getByLabelText('Claimed by You and Hana Lee')).toBeTruthy();

    db.claims = STATE_B().map((c) => (c.line_item_id === FRIES && c.user_id === A ? { ...c, parts: 2 } : c));
    db.rows = db.rows.map((r) => (r.id === FRIES ? { ...r, split_set_by: A, split_set_at: '2026-11-20T19:30:00Z' } : r));
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    expect(await screen.findByText('Custom split · set by Hana Lee')).toBeTruthy();
    expect(screen.getByLabelText('Your share $11.52')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $33.28')).toBeTruthy();
  });

  it('79: a failed claim rolls back and shows fixed copy, never the server message', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'server text: boom' } }));
    await openBill();
    fireEvent.press(screen.getByLabelText('Claim Fries'));
    expect(await screen.findByText("Couldn't save your claim. Try again.")).toBeTruthy();
    expect(screen.getByLabelText('Claim Fries')).toBeTruthy();
    expect(screen.queryByLabelText('Claimed by You')).toBeNull();
    expect(screen.queryByText(/server text/)).toBeNull();
  });

  it('R9: a claim on a row the host just deleted (not_found) re-reads the bill, so the row goes away', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: 'P0002', message: 'not_found' } }));
    await openBill();
    const base = billFetches();
    db.rows = db.rows.filter((r) => r.id !== FRIES);
    await act(async () => fireEvent.press(screen.getByLabelText('Claim Fries')));
    expect(await screen.findByText("Couldn't save your claim. Try again.")).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBe(base + 1));
    await waitFor(() => expect(screen.queryByLabelText('Claim Fries')).toBeNull());
  });

  it('R9: other claim failures do not re-read', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'boom' } }));
    await openBill();
    const base = billFetches();
    await act(async () => fireEvent.press(screen.getByLabelText('Claim Fries')));
    expect(await screen.findByText("Couldn't save your claim. Try again.")).toBeTruthy();
    expect(billFetches()).toBe(base);
  });

  it('80: live hints refetch once after the debounce; SUBSCRIBED refetches; unmount removes the channel', async () => {
    const router = await openBill();
    const ch = liveChannel();
    const base = billFetches();

    jest.useFakeTimers();
    act(() => ch.__broadcast('changed', { t: 'claims' }));
    act(() => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS - 1));
    expect(billFetches()).toBe(base);
    db.claims = [claim(BURGER, A)];
    await act(async () => jest.advanceTimersByTime(1));
    expect(billFetches()).toBe(base + 1);

    act(() => {
      ch.__broadcast('changed', { t: 'claims' });
      ch.__broadcast('changed', { t: 'bills' });
      ch.__broadcast('changed', { t: 'bill_participants' });
    });
    await act(async () => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    expect(billFetches()).toBe(base + 2);

    act(() => ch.__status('SUBSCRIBED'));
    await act(async () => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    expect(billFetches()).toBe(base + 3);
    jest.useRealTimers();

    // The new claim appeared with no user action.
    expect(await screen.findByLabelText('Claimed by Hana Lee')).toBeTruthy();

    router.unmount();
    await waitFor(() => expect(supabase.removeChannel).toHaveBeenCalledWith(ch));
  });

  it('80: refetches on app foreground', async () => {
    const handlers: ((s: AppStateStatus) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (s: AppStateStatus) => void);
      return { remove: () => {} };
    });
    await openBill();
    const base = billFetches();
    act(() => handlers.forEach((h) => h('background')));
    expect(billFetches()).toBe(base);
    await act(async () => handlers.forEach((h) => h('active')));
    await waitFor(() => expect(billFetches()).toBe(base + 1));
    spy.mockRestore();
  });

  it('81: joins the private bill:<id> channel and never reads the payload', async () => {
    db.claims = STATE_A();
    await openBill();
    const ch = liveChannel();
    expect(ch.topic).toBe(`bill:${BILL}`);
    expect(ch.params).toEqual({ config: { private: true } });
    // A payload naming a user and an item changes nothing; only the refetched data shows.
    await act(async () => ch.__broadcast('changed', { t: 'claims', user_id: A, line_item_id: BURGER }));
    await waitFor(() => expect(billFetches()).toBeGreaterThanOrEqual(2));
    expect(screen.getByLabelText('Your share $16.64')).toBeTruthy();
    expect(screen.queryByLabelText('Claimed by Hana Lee')).toBeNull();
  });

  it('82: a newer edited_at shows the "updated the bill" line, which can be dismissed', async () => {
    await openBill();
    expect(screen.queryByText(/updated the bill/)).toBeNull();
    db.bill = { ...db.bill, edited_at: '2026-11-20T20:00:00Z' };
    db.rows = db.rows.filter((r) => r.id !== BEER2).map((r) => (r.id === BEER1 ? { ...r, group_size: 1 } : r));
    await act(async () => liveChannel().__broadcast('changed', { t: 'bills' }));
    expect(await screen.findByText('Hana Lee updated the bill. Shares were recalculated.')).toBeTruthy();
    expect(screen.getByText('Beer')).toBeTruthy();
    expect(screen.queryByText('Beer · 2 of 2')).toBeNull();
    fireEvent.press(screen.getByText('Dismiss'));
    expect(screen.queryByText(/updated the bill/)).toBeNull();
  });

  it('82: the host does not get a notice about their own edit, and sees "Edit items"', async () => {
    db.bill = { ...db.bill, host_id: B };
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText('Your bill')).toBeTruthy();
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
    expect(screen.getByText('Edit items')).toBeTruthy();
    db.bill = { ...db.bill, edited_at: '2026-11-20T20:00:00Z' };
    await act(async () => liveChannel().__broadcast('changed', { t: 'bills' }));
    await waitFor(() => expect(billFetches()).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/updated the bill/)).toBeNull();
    router.unmount();
  });

  it('137: exactly one "Activity" link, no activity content on the rows; it opens /bills/<id>/activity', async () => {
    db.claims = STATE_A();
    const router = await openBill();
    const links = screen.getAllByRole('button').filter((b) => b.props.accessibilityLabel === 'Activity');
    expect(links).toHaveLength(1);
    expect(screen.getAllByText('Activity')).toHaveLength(1);
    expect(screen.queryByText(/joined|claimed Fries|changed/)).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Activity')));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/activity`));
  });

  it('non-hosts do not see "Edit items"', async () => {
    await openBill();
    expect(screen.queryByText('Edit items')).toBeNull();
  });

  it('83: a channel error for more than 5 s shows "Live updates paused"; Refresh refetches', async () => {
    await openBill();
    const ch = liveChannel();
    jest.useFakeTimers();
    act(() => ch.__status('CHANNEL_ERROR'));
    act(() => jest.advanceTimersByTime(LIVE_PAUSED_AFTER_MS - 1));
    expect(screen.queryByText('Live updates paused')).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByText('Live updates paused')).toBeTruthy();
    jest.useRealTimers();

    const base = billFetches();
    await act(async () => fireEvent.press(screen.getByText('Refresh')));
    await waitFor(() => expect(billFetches()).toBe(base + 1));

    act(() => ch.__status('SUBSCRIBED'));
    expect(screen.queryByText('Live updates paused')).toBeNull();
  });

  it('83: a short blip does not show the paused line', async () => {
    await openBill();
    const ch = liveChannel();
    jest.useFakeTimers();
    act(() => ch.__status('TIMED_OUT'));
    act(() => jest.advanceTimersByTime(2000));
    const base = billFetches();
    act(() => ch.__status('SUBSCRIBED'));
    // SUBSCRIBED schedules a debounced refetch: run it inside act, then let it land.
    await act(async () => jest.advanceTimersByTime(LIVE_DEBOUNCE_MS));
    act(() => jest.advanceTimersByTime(LIVE_PAUSED_AFTER_MS));
    expect(screen.queryByText('Live updates paused')).toBeNull();
    jest.useRealTimers();
    await waitFor(() => expect(billFetches()).toBe(base + 1));
    await act(async () => {});
  });

  it('84: an unknown bill (0 rows) shows the no-access copy, with no rpc', async () => {
    db.bill = null;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.getByText('Go home')).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('84: a non-UUID id shows the no-access copy with no query and no channel', async () => {
    renderRouter(ROUTES, { initialUrl: '/bills/not-a-uuid' });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.channel).not.toHaveBeenCalled();
  });

  it('84: a null name shows "A friend", and no email is ever shown', async () => {
    db.participants = [{ ...db.participants[0], profile: { display_name: null, venmo_username: null } }, db.participants[1]!];
    db.claims = [claim(BURGER, A)];
    await openBill();
    expect(screen.getByText("A friend's bill")).toBeTruthy();
    expect(screen.getByText('A friend')).toBeTruthy();
    expect(screen.getByLabelText('Claimed by A friend')).toBeTruthy();
    expect(within(screen.getByLabelText('Claimed by A friend')).getByText('?')).toBeTruthy();
    await expand();
    expect(screen.getByLabelText('A friend $19.20')).toBeTruthy();
    expect(screen.queryByText(/@/)).toBeNull();
  });

  it('a load error shows "Couldn\'t load the bill." and Try again refetches', async () => {
    db.failBills = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    db.failBills = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Total $44.80')).toBeTruthy();
  });

  it('a failed background refetch keeps the bill on screen', async () => {
    db.claims = STATE_A();
    await openBill();
    db.failBills = true;
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    await waitFor(() => expect(billFetches()).toBeGreaterThanOrEqual(2));
    expect(screen.getByLabelText('Your share $16.64')).toBeTruthy();
    expect(screen.queryByText("Couldn't load the bill.")).toBeNull();
  });
});

describe('shares summary (A2.2 pending state, rendered from displayShares only)', () => {
  const nameOf = makeNameOf(
    [
      { userId: A, displayName: 'Hana Lee' },
      { userId: B, displayName: 'Bo' },
    ],
    B,
  );
  // Every row is claimed in the props' terms, but displayShares says totals are hidden: the
  // component must follow displayShares, not decide for itself.
  const pending: DisplayShares = {
    mode: 'equal',
    complete: false,
    unclaimedRows: 1,
    unclaimedDiscountRows: 0,
    totalsVisible: false,
    people: [
      { userId: A, itemsCents: 1000, discountCents: null, extrasCents: null, totalCents: null },
      { userId: B, itemsCents: 1000, discountCents: null, extrasCents: null, totalCents: null },
    ],
    unclaimedItemsCents: 1500,
    unclaimedDiscountCents: 0,
    unclaimedExtrasCents: 0,
    items: {},
  };

  it('shows "Your items" and the pending line per person, with no totals or breakdown', () => {
    render(<SharesSummary shares={pending} myId={B} nameOf={nameOf} />);
    expect(screen.getByLabelText('Your items $10.00')).toBeTruthy();
    expect(screen.queryByLabelText(/^Your share/)).toBeNull();
    fireEvent.press(screen.getByLabelText('Your items $10.00'));
    expect(screen.getAllByText('Total shows once all items are claimed (1 item left)')).toHaveLength(2);
    // R4: screen readers hear that these are items only, and why there's no total.
    expect(screen.getByLabelText('You, items $10.00, total shows once all items are claimed')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee, items $10.00, total shows once all items are claimed')).toBeTruthy();
    expect(screen.queryByText(/tax, tip and fees/)).toBeNull();
    expect(screen.queryByText(/\$29\.90|\$14\.90/)).toBeNull();
  });

  it('pluralizes the count', () => {
    render(<SharesSummary shares={{ ...pending, unclaimedRows: 3 }} myId={B} nameOf={nameOf} />);
    fireEvent.press(screen.getByLabelText('Your items $10.00'));
    expect(screen.getAllByText('Total shows once all items are claimed (3 items left)')).toHaveLength(2);
  });

  it('R5: every row claimed at $0.00 with $2.00 tax shows "Unclaimed $2.00", not "Everything\'s claimed."', () => {
    const zero = displayShares({
      totalCents: 200,
      items: [
        { id: 'water', totalCents: 0 },
        { id: 'bread', totalCents: 0 },
      ],
      claims: [
        { itemId: 'water', userId: A, parts: 1 },
        { itemId: 'bread', userId: B, parts: 1 },
      ],
      participantIds: [A, B],
      extrasMode: 'proportional',
    });
    render(<SharesSummary shares={zero} myId={B} nameOf={nameOf} />);
    fireEvent.press(screen.getByLabelText('Your share $0.00'));
    expect(screen.getByLabelText('You $0.00')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $0.00')).toBeTruthy();
    expect(screen.getByLabelText('Unclaimed $2.00')).toBeTruthy();
    expect(screen.queryByText("Everything's claimed.")).toBeNull();
  });

  it('shows totals once displayShares makes them visible, and labels negative extras as discounts', () => {
    const visible: DisplayShares = {
      ...pending,
      complete: true,
      unclaimedRows: 0,
      totalsVisible: true,
      people: [
        { userId: A, itemsCents: 2500, discountCents: 0, extrasCents: 490, totalCents: 2990 },
        { userId: B, itemsCents: 2000, discountCents: 0, extrasCents: -500, totalCents: 1500 },
      ],
      unclaimedItemsCents: 0,
    };
    render(<SharesSummary shares={visible} myId={B} nameOf={nameOf} />);
    fireEvent.press(screen.getByLabelText('Your share $15.00'));
    expect(screen.getByLabelText('Hana Lee $29.90')).toBeTruthy();
    expect(screen.getByText('Items $20.00 − discounts $5.00')).toBeTruthy();
    expect(screen.getByText("Everything's claimed.")).toBeTruthy();
    expect(screen.queryByText(/Total shows once/)).toBeNull();
  });
});

// Claimable discounts (docs/specs/2026-11-24-claimable-discounts.md, Task 7): criteria 48–53.
// E1: A (Hana Lee, host) has Steak 16.03 and the Police comp; B (Bo, the viewer) has Salad 14.00.
describe('claimable discounts on the bill screen (criteria 48–53)', () => {
  const STEAK = '33333333-0000-4000-8000-000000000001';
  const SALAD = '33333333-0000-4000-8000-000000000002';
  const COMP = '33333333-0000-4000-8000-000000000003';
  const COMP_LABEL = 'Police comp, discount';

  const discountRow = (id: string, name: string, cents: number, g: number) => ({
    ...row(id, name, cents, g),
    kind: 'discount',
    applies_to: 'subtotal',
  });

  /** The E1 bill: subtotal 14.00, tax 2.40, total 16.40. */
  function useE1(compCents = -1603) {
    db.bill = { ...db.bill, subtotal_cents: 1400, tax_cents: 240, tip_cents: 0, total_cents: 1640 };
    db.rows = [row(STEAK, 'Steak', 1603, 0), row(SALAD, 'Salad', 1400, 1), discountRow(COMP, 'Police comp', compCents, 2)];
  }

  async function openAt(totalText: string) {
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText(totalText);
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  }

  const buttonLabels = () => screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));

  it('48: discount rows come after every item, under one "Discounts" header, with a negative price', async () => {
    useE1();
    // The DB doesn't require discounts last: the screen puts them there anyway.
    db.rows = [discountRow(COMP, 'Police comp', -1603, 0), row(STEAK, 'Steak', 1603, 1), row(SALAD, 'Salad', 1400, 2)];
    await openAt('Total $16.40');
    expect(screen.getAllByRole('header', { name: 'Discounts' })).toHaveLength(1);
    expect(screen.getByText('-$16.03')).toBeTruthy();
    const labels = buttonLabels();
    const comp = labels.indexOf(`Claim ${COMP_LABEL}`);
    expect(comp).toBeGreaterThan(labels.indexOf('Claim Steak'));
    expect(comp).toBeGreaterThan(labels.indexOf('Claim Salad'));
  });

  it('48: a bill without claimable discounts has no "Discounts" header', async () => {
    await openBill();
    expect(screen.queryByText('Discounts')).toBeNull();
  });

  it('48: claiming and unclaiming go through set_claim, like an item, with discount wording in the hints', async () => {
    useE1();
    db.claims = [claim(STEAK, A), claim(SALAD, B)];
    await openAt('Total $16.40');
    const toggle = screen.getByLabelText(`Claim ${COMP_LABEL}`);
    expect(toggle.props.accessibilityHint).toBe('Takes this discount off your share');

    db.claims = [...db.claims, claim(COMP, B)];
    await act(async () => fireEvent.press(toggle));
    expect(supabase.rpc).toHaveBeenCalledWith('set_claim', { p_line_item_id: COMP, p_claimed: true });
    const unclaim = await screen.findByLabelText(`Unclaim ${COMP_LABEL}`);
    expect(unclaim.props.accessibilityHint).toBe('Puts this discount back for someone to claim');
    expect(screen.getByText('You · -$16.03')).toBeTruthy();

    db.claims = db.claims.filter((c) => c.line_item_id !== COMP);
    await act(async () => fireEvent.press(unclaim));
    expect(supabase.rpc).toHaveBeenLastCalledWith('set_claim', { p_line_item_id: COMP, p_claimed: false });
    expect(await screen.findByLabelText(`Claim ${COMP_LABEL}`)).toBeTruthy();
  });

  it('48: a shared discount shows avatars and the negative "Split 2 ways" status', async () => {
    useE1();
    db.claims = [claim(STEAK, A), claim(SALAD, B), claim(COMP, A), claim(COMP, B)];
    await openAt('Total $16.40');
    expect(screen.getByText('Split 2 ways · -$8.02–-$8.01 each')).toBeTruthy();
    expect(
      screen.getByLabelText(`${COMP_LABEL}, -$16.03, Split 2 ways · -$8.02–-$8.01 each, claimed by You and Hana Lee`),
    ).toBeTruthy();
  });

  it('49: the details label reads the name, "discount", the price and the status', async () => {
    useE1();
    await openAt('Total $16.40');
    const details = screen.getByLabelText(`${COMP_LABEL}, -$16.03, Unclaimed`);
    expect(details.props.accessibilityHint).toBe('Shows who pays what');
  });

  it('50: the sheet opens for a discount, previews negative pieces (E3) and saves through set_item_split', async () => {
    useE1(-1000);
    db.bill = { ...db.bill, total_cents: 2243 };
    db.claims = [claim(STEAK, A), claim(SALAD, B), claim(COMP, A), claim(COMP, B)];
    await openAt('Total $22.43');
    fireEvent.press(screen.getByLabelText(/^Police comp, discount, -\$10\.00, /));
    expect(screen.getByLabelText('You -$5.00')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee -$5.00')).toBeTruthy();
    fireEvent.press(screen.getByText('Split differently'));
    fireEvent.press(screen.getByLabelText('More parts for Hana Lee'));
    expect(screen.getByLabelText('Hana Lee -$6.67')).toBeTruthy();
    expect(screen.getByLabelText('You -$3.33')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Save split')));
    expect(supabase.rpc).toHaveBeenCalledWith('set_item_split', { p_line_item_id: COMP, p_parts: { [A]: 2, [B]: 1 } });
  });

  it('50: a non-claimer sees the discount wording in the sheet', async () => {
    useE1();
    db.claims = [claim(STEAK, A), claim(SALAD, B), claim(COMP, A)];
    await openAt('Total $16.40');
    fireEvent.press(screen.getByLabelText(`${COMP_LABEL}, -$16.03, Hana Lee`));
    expect(screen.getByText("Claim this discount to change how it's split.")).toBeTruthy();
    expect(screen.queryByText('Split differently')).toBeNull();
  });

  it('51: E1 shows A $1.28 with the claimed-discount breakdown, and B $15.12', async () => {
    useE1();
    db.claims = [claim(STEAK, A), claim(SALAD, B), claim(COMP, A)];
    await openAt('Total $16.40');
    expect(screen.getByLabelText('Your share $15.12')).toBeTruthy();
    await expand();
    expect(screen.getByLabelText('Hana Lee $1.28')).toBeTruthy();
    expect(screen.getByText('Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28')).toBeTruthy();
    expect(screen.getByText('Items $14.00 + tax, tip and fees $1.12')).toBeTruthy();
    expect(screen.getByText("Everything's claimed.")).toBeTruthy();
  });

  it('51: E4, an unclaimed discount shows in the Unclaimed line and blocks settling', async () => {
    useE1();
    db.claims = [claim(STEAK, A), claim(SALAD, B)];
    await openAt('Total $16.40');
    // R1 (Amendment A1): only the discount is left, so the copy says "discount". Settle early (Task 6,
    // E16): the viewer has an item claim on a proportional bill, so the footer says they can pay now.
    expect(screen.getByText('You can pay now · 1 discount left to claim')).toBeTruthy();
    expect(screen.queryByText(/item left to claim/)).toBeNull();
    await expand();
    expect(screen.getByLabelText('Hana Lee $17.31')).toBeTruthy();
    expect(screen.getByLabelText('Unclaimed -$16.03')).toBeTruthy();
    expect(screen.queryByText("Everything's claimed.")).toBeNull();
  });

  it('52: in even mode an unclaimed discount keeps totals hidden', async () => {
    useE1();
    db.bill = { ...db.bill, extras_split: 'equal' };
    db.claims = [claim(STEAK, A), claim(SALAD, B)];
    await openAt('Total $16.40');
    expect(screen.getByLabelText('Your items $14.00')).toBeTruthy();
    await expand();
    expect(screen.getAllByText('Total shows once all discounts are claimed (1 discount left)')).toHaveLength(2);
    expect(screen.getByLabelText('You, items $14.00, total shows once all discounts are claimed')).toBeTruthy();
    expect(screen.queryByText(/claimed discounts/)).toBeNull();
  });

  it('R1 (Amendment A1): an item and a discount left reads "1 item and 1 discount left to claim"', async () => {
    useE1();
    db.claims = [claim(STEAK, A)];
    await openAt('Total $16.40');
    expect(screen.getByText('1 item and 1 discount left to claim')).toBeTruthy();
  });

  it('53: E2, a discount bigger than the items gives a negative share', async () => {
    const FRIES2 = '33333333-0000-4000-8000-000000000004';
    const BURGER2 = '33333333-0000-4000-8000-000000000005';
    db.bill = { ...db.bill, subtotal_cents: null, tax_cents: 0, tip_cents: 0, total_cents: 1000 };
    db.rows = [row(FRIES2, 'Fries', 500, 0), row(BURGER2, 'Burger', 1500, 1), discountRow(COMP, 'Coupon', -1000, 2)];
    db.claims = [claim(FRIES2, A), claim(BURGER2, B), claim(COMP, A)];
    await openAt('Total $10.00');
    expect(screen.getByLabelText('Your share $15.00')).toBeTruthy();
    await expand();
    expect(screen.getByLabelText('Hana Lee -$5.00')).toBeTruthy();
    expect(screen.getByText('Items $5.00 − claimed discounts $10.00')).toBeTruthy();
  });
});

describe('Settle up entry in the footer (M3 criterion 54, brief §7)', () => {
  const background = (label: string) =>
    (StyleSheet.flatten(screen.getByLabelText(label).props.style) as { backgroundColor?: string }).backgroundColor;

  it('hidden with 1 participant', async () => {
    db.participants = db.participants.slice(0, 1);
    db.claims = [claim(FRIES, A)];
    await openBill();
    expect(screen.queryByLabelText('Settle up')).toBeNull();
    expect(screen.queryByText(/left to claim/)).toBeNull();
  });

  it('incomplete: secondary "Settle up" with the exact count, and it still opens Settle up', async () => {
    db.claims = STATE_A(); // Fries and Beer 1 claimed: 2 rows left
    // Task 6: a proportional bill would be an early plan (the viewer can pay now); even mode stays blocked.
    db.bill = { ...db.bill, extras_split: 'equal' };
    const router = await openBill();
    const settle = screen.getByLabelText('Settle up');
    expect(screen.getByText('2 items left to claim')).toBeTruthy();
    expect(settle.props.accessibilityHint).toBe('2 items left to claim first');
    // Secondary buttons are tonal since visual pass V6 (was `surface` with an outline).
    expect(background('Settle up')).toBe(colors.light.primarySurface);
    fireEvent.press(settle);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await screen.findByText('Not ready yet');
  });

  it('incomplete with one row left: singular', async () => {
    db.claims = [claim(BURGER, A), claim(FRIES, B), claim(BEER1, B)];
    db.bill = { ...db.bill, extras_split: 'equal' }; // Task 6: see above
    await openBill();
    expect(screen.getByText('1 item left to claim')).toBeTruthy();
  });

  it.each([
    ['guest', B],
    ['host', A],
  ])('complete: primary "Settle up" for the %s, opening /bills/<id>/settle', async (_who, id) => {
    const session = fakeSession('Test');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id } });
    db.claims = STATE_B();
    const router = await openBill();
    expect(screen.queryByText(/left to claim/)).toBeNull();
    expect(screen.getByLabelText('Settle up').props.accessibilityHint).toBe('See what you owe and pay');
    expect(background('Settle up')).toBe(colors.light.primary);
    fireEvent.press(screen.getByLabelText('Settle up'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await screen.findByText('Settle up', { exact: true });
    await screen.findByText(/paid the bill$/);
  });
});

// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md), criterion 43:
// the footer's captions on an early (proportional, incomplete) bill and with a difference.
describe.each(['ios', 'web'] as const)('Settle up footer, early and differences (%s; criterion 43)', (os) => {
  const background = (label: string) =>
    (StyleSheet.flatten(screen.getByLabelText(label).props.style) as { backgroundColor?: string }).backgroundColor;
  const markB = (cents: number) => {
    db.participants = db.participants.map((p) =>
      p.user_id === B ? { ...p, settled_at: '2026-11-20T21:00:00Z', settled_cents: cents } : p,
    );
  };

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.participants = db.participants.map((p) =>
      p.user_id === A ? { ...p, profile: { display_name: 'Hana Lee', venmo_username: 'hana-1' } } : p,
    );
    // Proportional; Beer 2 is the only row left, and Bo (the viewer) has claimed items: an early plan.
    db.claims = [claim(BURGER, A), claim(FRIES, B), claim(BEER1, B)];
  });

  it('early, Bo owes: primary "Settle up" with "You can pay now · 1 item left to claim", opening Settle up', async () => {
    const router = await openBill();
    expect(screen.getByText('You can pay now · 1 item left to claim')).toBeTruthy();
    const settle = screen.getByLabelText('Settle up');
    expect(settle.props.accessibilityHint).toBe('You can pay your share now. 1 item left to claim');
    expect(background('Settle up')).toBe(colors.light.primary);
    // Still no Pay in the footer before the bill is complete (SE-9).
    expect(screen.queryByLabelText(/^Pay /)).toBeNull();
    // Not a live region: it would speak on every claim tap.
    expect(screen.getByText('You can pay now · 1 item left to claim').props.accessibilityLiveRegion).toBe('none');
    fireEvent.press(settle);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByText('Your share may change until everything is claimed (1 item left).')).toBeTruthy();
  });

  it('early, two rows left: the count follows the plural', async () => {
    db.claims = [claim(FRIES, B), claim(BEER1, B)];
    await openBill();
    expect(screen.getByText('You can pay now · 2 items left to claim')).toBeTruthy();
  });

  it('early, Bo marked: secondary "Settle up" with "Marked paid · 1 item left to claim"', async () => {
    markB(1000);
    await openBill();
    expect(screen.getByText('Marked paid · 1 item left to claim')).toBeTruthy();
    expect(background('Settle up')).toBe(colors.light.primarySurface);
    expect(screen.getByText('Marked paid · 1 item left to claim').props.accessibilityLiveRegion).toBe('none');
  });

  it('ready, more due: primary "Settle up" with "You owe Hana Lee $1.10 more"', async () => {
    db.claims = STATE_B(); // complete; Bo's share is $12.80
    markB(1170);
    await openBill();
    expect(screen.getByText('You owe Hana Lee $1.10 more')).toBeTruthy();
    expect(screen.getByLabelText('Settle up').props.accessibilityHint).toBe('See the difference and settle it');
    expect(background('Settle up')).toBe(colors.light.primary);
  });

  it('ready, back due: primary "Settle up" with "Hana Lee owes you $1.10 back"', async () => {
    db.claims = STATE_B();
    markB(1390);
    await openBill();
    expect(screen.getByText('Hana Lee owes you $1.10 back')).toBeTruthy();
    expect(background('Settle up')).toBe(colors.light.primary);
  });

  it('ready, the payer with one difference: "1 difference to settle"', async () => {
    const session = fakeSession('Hana');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id: A } });
    db.claims = STATE_B();
    markB(1390);
    await openBill();
    expect(screen.getByText('1 difference to settle')).toBeTruthy();
    expect(background('Settle up')).toBe(colors.light.primary);
  });
});

// People and invites (docs/specs/2026-11-24-people-and-invites.md, Task 7): criteria 42, 48 and 49.
describe.each(['ios', 'web'] as const)('Add people entry and Leave this bill (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const viewAs = (id: string) => {
    const session = fakeSession('Test');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id } });
  };
  const leaveCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'leave_bill');

  it('42: the host sees "Add people" in the Invite card, with its hint, and it opens /bills/<id>/people', async () => {
    viewAs(A);
    supabase.__setRpc((fn) => (fn === 'people_i_split_with' ? { data: [], error: null } : { data: null, error: null }));
    const router = await openBill();
    const add = screen.getByLabelText('Add people');
    expect(add.props.accessibilityHint).toBe("Add someone you've split a bill with");
    await act(async () => {
      fireEvent.press(add);
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/people`));
    expect(await screen.findByRole('header', { name: 'Add people' })).toBeTruthy();
  });

  it('42: a guest does not see "Add people"', async () => {
    await openBill();
    expect(screen.getByText('Invite friends')).toBeTruthy();
    expect(screen.queryByLabelText('Add people')).toBeNull();
  });

  it('48: a guest with no claims, no mark and not the payer sees "Leave this bill", with a hint', async () => {
    await openBill();
    const leave = screen.getByLabelText('Leave this bill');
    expect(leave.props.accessibilityRole).toBe('button');
    expect(leave.props.accessibilityHint).toBe('Asks before taking you off this bill');
  });

  it.each([
    ['a guest with a claim', () => (db.claims = [claim(FRIES, B)])],
    ['the payer', () => db.bill && (db.bill.payer_id = B)],
    ['a guest with an "I paid" mark', () => {
      const p = db.participants[1];
      if (p) Object.assign(p, { settled_at: '2026-11-20T21:00:00Z', settled_cents: 600 });
    }],
    ['the host', () => viewAs(A)],
  ])('48: %s does not see "Leave this bill"', async (_who, setup) => {
    setup();
    await openBill();
    expect(screen.queryByLabelText('Leave this bill')).toBeNull();
  });

  it('48: Leave shows the inline confirm; Cancel hides it with no call', async () => {
    await openBill();
    fireEvent.press(screen.getByLabelText('Leave this bill'));
    expect(screen.getByText("Leave this bill? You'll stop seeing it. You can rejoin with the link.")).toBeTruthy();
    expect(screen.queryByLabelText('Leave this bill')).toBeNull();
    fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.queryByText(/You'll stop seeing it/)).toBeNull();
    expect(screen.getByLabelText('Leave this bill')).toBeTruthy();
    expect(leaveCalls()).toEqual([]);
  });

  it('48: "Leave" calls leaveBill once (double tap) and lands home, where the bill is gone', async () => {
    let release: (r: FakeResult) => void = () => {};
    supabase.__setRpc((fn) => {
      if (fn === 'leave_bill') return new Promise<FakeResult>((r) => (release = r));
      // Home's list (rpc my_bills, bill markers D2) no longer has the bill once B has left.
      if (fn === 'my_bills') return { data: [], error: null };
      return { data: null, error: null };
    });
    const router = await openBill();
    fireEvent.press(screen.getByLabelText('Leave this bill'));
    fireEvent.press(screen.getByLabelText('Leave'));
    fireEvent.press(screen.getByLabelText('Leave'));
    expect(leaveCalls()).toEqual([['leave_bill', { p_bill_id: BILL }]]);
    expect(screen.getByLabelText('Leave').props.accessibilityState?.busy).toBe(true);
    // RLS hides the bill from now on: the bills select returns nothing (home's list is my_bills, above).
    supabase.__setTable('bills', () => ({ data: [], error: null }));
    await act(async () => release({ data: null, error: null }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByText('No bills yet.')).toBeTruthy();
    expect(screen.queryByText("Hana Lee's bill")).toBeNull();
    expect(leaveCalls()).toHaveLength(1);
  });

  it('48: cannot_leave shows its copy and refetches (the new claim hides the button)', async () => {
    supabase.__setRpc((fn) =>
      fn === 'leave_bill' ? { data: null, error: { code: '22023', message: 'cannot_leave' } } : { data: null, error: null },
    );
    const router = await openBill();
    fireEvent.press(screen.getByLabelText('Leave this bill'));
    db.claims = [claim(FRIES, B)]; // claimed on another device just now
    const before = billFetches();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Leave'));
    });
    expect(await screen.findByText("You can't leave right now. Unclaim your items first.")).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByLabelText('Leave this bill')).toBeNull());
    expect(screen.getByText("You can't leave right now. Unclaim your items first.")).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
  });

  it('48: a network error keeps the confirm open with "Leave" enabled again', async () => {
    supabase.__setRpc((fn) =>
      fn === 'leave_bill' ? { data: null, error: { code: '08006', message: 'server text' } } : { data: null, error: null },
    );
    const router = await openBill();
    fireEvent.press(screen.getByLabelText('Leave this bill'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Leave'));
    });
    expect(await screen.findByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    expect(screen.getByLabelText('Leave').props.accessibilityState?.disabled).toBe(false);
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
  });
});

// Bill markers (docs/specs/2026-11-24-bill-markers-and-notices.md, Task 6, D6): criteria 41–43.
describe.each(['ios', 'web'] as const)('the bill screen marks the bill seen (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const seenCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'mark_bill_seen');

  /** Lets pending promises and effects run, so a call that would happen has happened. */
  const settle = () => act(async () => {});

  it('41: a ready load calls mark_bill_seen once; live, focus and foreground refetches do not repeat it', async () => {
    const handlers: ((s: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (s: AppStateStatus) => void);
      return { remove: () => {} };
    });
    await openBill();
    await waitFor(() => expect(seenCalls()).toEqual([['mark_bill_seen', { p_bill_id: BILL }]]));

    // A live hint.
    let base = billFetches();
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(base));
    // The app returning to the foreground.
    base = billFetches();
    await act(async () => handlers.forEach((h) => h('active')));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(base));
    // Leaving for another screen and coming back (focus).
    await act(async () => globalRouter.push(`/bills/${BILL}/activity`));
    base = billFetches();
    await act(async () => globalRouter.back());
    await waitFor(() => expect(billFetches()).toBeGreaterThan(base));
    await settle();
    expect(seenCalls()).toHaveLength(1);
  });

  it('41: opening the screen again (a new mount) marks it once more', async () => {
    const first = await openBill();
    await waitFor(() => expect(seenCalls()).toHaveLength(1));
    first.unmount();
    await openBill();
    await waitFor(() => expect(seenCalls()).toHaveLength(2));
    await settle();
    expect(seenCalls()).toEqual([
      ['mark_bill_seen', { p_bill_id: BILL }],
      ['mark_bill_seen', { p_bill_id: BILL }],
    ]);
  });

  it('42: a not_found load never marks it', async () => {
    db.bill = null;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    await settle();
    expect(seenCalls()).toHaveLength(0);
  });

  it('42: an error load never marks it; the first ready load after Try again does, once', async () => {
    db.failBills = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    await settle();
    expect(seenCalls()).toHaveLength(0);
    db.failBills = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Total $44.80')).toBeTruthy();
    await waitFor(() => expect(seenCalls()).toEqual([['mark_bill_seen', { p_bill_id: BILL }]]));
  });

  it.each<[string, () => FakeResult | Promise<FakeResult>]>([
    ['42501', () => ({ data: null, error: { code: '42501', message: 'not_allowed' } })],
    ['a network error', () => ({ data: null, error: { code: '08006', message: 'server text' } })],
    ['a thrown request', () => Promise.reject(new Error('offline'))],
    ['a call that never answers', () => new Promise<FakeResult>(() => {})],
  ])('43: mark_bill_seen failing (%s) changes nothing on screen, and claims still work', async (_name, answer) => {
    supabase.__setRpc((fn) => (fn === 'mark_bill_seen' ? answer() : { data: null, error: null }));
    await openBill();
    await waitFor(() => expect(seenCalls()).toHaveLength(1));
    await settle();
    expect(screen.queryByText(/server text|offline|not_allowed|Couldn't|wrong|Try again/)).toBeNull();
    expect(screen.queryByLabelText('Loading')).toBeNull();
    db.claims = [claim(FRIES, B)];
    await act(async () => fireEvent.press(screen.getByLabelText('Claim Fries')));
    expect(supabase.rpc).toHaveBeenCalledWith('set_claim', { p_line_item_id: FRIES, p_claimed: true });
    expect(await screen.findByLabelText('Unclaim Fries')).toBeTruthy();
    expect(screen.queryByText("Couldn't save your claim. Try again.")).toBeNull();
  });

  it('43: an answer after unmount sets no state', async () => {
    const errors = jest.spyOn(console, 'error');
    let answer: (r: FakeResult) => void = () => {};
    supabase.__setRpc((fn) =>
      fn === 'mark_bill_seen' ? new Promise<FakeResult>((r) => (answer = r)) : { data: null, error: null },
    );
    const router = await openBill();
    await waitFor(() => expect(seenCalls()).toHaveLength(1));
    router.unmount();
    await act(async () => answer({ data: null, error: { code: '08006', message: 'late' } }));
    expect(errors.mock.calls.some((c) => String(c[0]).includes('act('))).toBe(false);
  });
});

// Pay from the footer (docs/specs/2026-11-25-venmo-request-buttons.md, Task 5): criteria 29–35.
// STATE_B is complete; A (Hana Lee) paid and has Venmo `hana-1`; B (the viewer) owes $12.80.
describe.each(['ios', 'web'] as const)('pay from the footer (%s)', (os) => {
  const openLink = openPaymentLink as jest.MockedFunction<typeof openPaymentLink>;
  const PAY = 'Pay Hana Lee $12.80 on Venmo';
  const PAY_A11Y = `${PAY}, to @hana-1`;
  const PAY_URL = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=12.80&note=SplitIt%3A%20Fries%2C%20Beer';
  const WEB_LINE = 'On a computer? Send it from the Venmo app on your phone.';
  const markCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'mark_paid');
  const tableWrites = () =>
    supabase.__queries.filter((q) => q.calls.some((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method)));
  const disabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled;
  const viewAs = (id: string) => {
    const session = fakeSession('Test');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id } });
  };
  /** mark_paid stores B's mark the way the server does; `fail` answers with that error instead. */
  const markRpc = (fail?: { code: string; message: string }) =>
    supabase.__setRpc((fn, args) => {
      if (fn === 'mark_paid') {
        if (fail) return { data: null, error: fail };
        const p = db.participants.find((x) => x.user_id === B);
        if (p) Object.assign(p, { settled_at: '2026-11-20T21:00:00Z', settled_cents: (args as { p_cents: number }).p_cents });
      }
      return { data: null, error: null };
    });

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    openLink.mockClear();
    openLink.mockImplementation(async () => ({ ok: true }));
    db.participants = db.participants.map((p) =>
      p.user_id === A ? { ...p, profile: { display_name: 'Hana Lee', venmo_username: 'hana-1' } } : p,
    );
    db.claims = STATE_B();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('29: the ower sees Pay, the handle line and Details; Pay opens Venmo at once and stays on the bill', async () => {
    const router = await openBill();
    const pay = screen.getByLabelText(PAY_A11Y);
    expect(within(pay).getByText(PAY)).toBeTruthy();
    expect(pay.props.accessibilityHint).toBe('Opens Venmo');
    expect(screen.getByText('@hana-1 · $12.80')).toBeTruthy();
    if (os === 'web') expect(screen.getByText(WEB_LINE)).toBeTruthy();
    else expect(screen.queryByText(WEB_LINE)).toBeNull();
    const details = screen.getByLabelText('Settle up details');
    expect(details.props.accessibilityHint).toBe("Shows who's paid and other ways to pay");
    expect(within(details).getByText('Details')).toBeTruthy();
    expect(screen.queryByLabelText('Settle up')).toBeNull();

    fireEvent.press(pay);
    expect(openLink).toHaveBeenCalledTimes(1); // synchronously, before any awaited work
    expect(openLink).toHaveBeenCalledWith(PAY_URL);
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
  });

  it('30: taps within 1 s open Venmo once; after that it opens again', async () => {
    await openBill();
    jest.useFakeTimers({ now: Date.now() });
    const press = (label: string) => act(async () => fireEvent.press(screen.getByLabelText(label)));
    await press(PAY_A11Y);
    await press('Not yet');
    await press(PAY_A11Y); // within 1 s: ignored, the footer stays on Pay
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Did you pay Hana Lee?')).toBeNull();
    act(() => jest.advanceTimersByTime(1000));
    await press(PAY_A11Y);
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('30: a link that fails to open shows the handle fallback', async () => {
    openLink.mockImplementation(async () => ({ ok: false }));
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText("Couldn't open Venmo. Send $12.80 to @hana-1 in the Venmo app.")).toBeTruthy();
  });

  it('31, 32: Pay writes nothing; Not yet goes back to Pay with no rpc', async () => {
    await openBill();
    const writesBefore = tableWrites().length;
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    expect(screen.getByLabelText('I paid').props.accessibilityHint).toBe('Marks your share as paid');
    expect(screen.getByLabelText('Settle up details')).toBeTruthy();
    expect(rpcCallsExceptSeen()).toHaveLength(0);
    expect(tableWrites()).toHaveLength(writesBefore);
    fireEvent.press(screen.getByLabelText('Not yet'));
    expect(await screen.findByLabelText(PAY_A11Y)).toBeTruthy();
    expect(screen.queryByText('Did you pay Hana Lee?')).toBeNull();
    expect(rpcCallsExceptSeen()).toHaveLength(0);
  });

  it('31: I paid marks once, then the footer is "Settle up" with "Marked paid"', async () => {
    markRpc();
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    fireEvent.press(await screen.findByLabelText('I paid'));
    fireEvent.press(screen.getByLabelText('I paid')); // a double tap sends one call
    expect(await screen.findByText('Marked paid')).toBeTruthy();
    expect(markCalls()).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1280 }]]);
    expect(screen.getByLabelText('Settle up').props.accessibilityHint).toBe('See what you owe and pay');
    expect(screen.queryByLabelText(PAY_A11Y)).toBeNull();
    expect(screen.queryByText('Did you pay Hana Lee?')).toBeNull();
  });

  it('31: a failed mark (payer_changed) shows its copy and re-enables the buttons', async () => {
    markRpc({ code: '22023', message: 'payer_changed' });
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    fireEvent.press(await screen.findByLabelText('I paid'));
    expect(await screen.findByText('Who gets paid just changed. Check the amount and try again.')).toBeTruthy();
    await waitFor(() => expect(disabled('I paid')).toBe(false));
    expect(disabled('Not yet')).toBe(false);
  });

  it('31: a failed refetch after the mark re-enables I paid', async () => {
    supabase.__setRpc((fn) => {
      if (fn === 'mark_paid') db.failBills = true;
      return { data: null, error: null };
    });
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    fireEvent.press(await screen.findByLabelText('I paid'));
    expect(markCalls()).toHaveLength(1);
    await waitFor(() => expect(disabled('I paid')).toBe(false));
    expect(screen.getByText('Did you pay Hana Lee?')).toBeTruthy();
  });

  it('33: Details opens Settle up, where B still has Pay and "I already paid"', async () => {
    const router = await openBill();
    fireEvent.press(screen.getByLabelText('Settle up details'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByLabelText(PAY_A11Y)).toBeTruthy();
    expect(screen.getByLabelText('I already paid')).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
  });

  it('34: the payer (A) gets "Settle up", which opens Settle, not Venmo', async () => {
    viewAs(A);
    const router = await openBill();
    expect(screen.queryByLabelText(/on Venmo/)).toBeNull();
    fireEvent.press(screen.getByLabelText('Settle up'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(openLink).not.toHaveBeenCalled();
  });

  it('34: B already marked gets "Settle up" + "Marked paid", which opens Settle', async () => {
    db.participants = db.participants.map((p) =>
      p.user_id === B ? { ...p, settled_at: '2026-11-20T21:00:00Z', settled_cents: 1280 } : p,
    );
    const router = await openBill();
    expect(screen.getByText('Marked paid')).toBeTruthy();
    expect(screen.queryByLabelText(PAY_A11Y)).toBeNull();
    fireEvent.press(screen.getByLabelText('Settle up'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(openLink).not.toHaveBeenCalled();
  });

  it('35: Pay waits while B\'s claim is saving; then the amount is the refetched one', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc((fn) => (fn === 'set_claim' ? new Promise<FakeResult>((r) => (resolve = r)) : { data: null, error: null }));
    await openBill();
    fireEvent.press(screen.getByLabelText('Claim Burger')); // shared with A: the bill stays complete
    expect(disabled(PAY_A11Y)).toBe(true);
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(openLink).not.toHaveBeenCalled();
    db.claims = [...STATE_B(), claim(BURGER, B)];
    await act(async () => resolve({ data: null, error: null }));
    const pay = await screen.findByLabelText(/^Pay Hana Lee \$\d+\.\d\d on Venmo, to @hana-1$/);
    await waitFor(() => expect(screen.getByLabelText(/^Pay Hana Lee/).props.accessibilityState?.disabled).toBe(false));
    expect(pay.props.accessibilityLabel).not.toBe(PAY_A11Y);
    // The footer's amount is the server's: the same number Settle up shows for this data.
    expect(screen.getByLabelText(/^Pay Hana Lee/).props.accessibilityLabel).toBe(`Pay Hana Lee ${await yourShare()} on Venmo, to @hana-1`);
  });

  it('VR-I6: unclaiming on a complete bill shows "1 item left to claim" at once (optimistic), with no Pay', async () => {
    supabase.__setRpc((fn) => (fn === 'set_claim' ? new Promise<FakeResult>(() => {}) : { data: null, error: null }));
    await openBill();
    fireEvent.press(screen.getByLabelText('Unclaim Beer 1 of 2'));
    expect(screen.getByText('1 item left to claim')).toBeTruthy();
    expect(screen.queryByLabelText(PAY_A11Y)).toBeNull();
  });

  const live = async () => {
    const before = billFetches();
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
  };

  it('R1: a saved claim whose refetch fails says so; Refresh brings Pay back with the new amount', async () => {
    supabase.__setRpc((fn) => {
      if (fn === 'set_claim') db.failBills = true; // the write lands; the refetch after it fails
      return { data: null, error: null };
    });
    await openBill();
    expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Claim Burger')));
    const line = await screen.findByText("Couldn't refresh. Try again.");
    expect(line.props.accessibilityRole).toBe('alert');
    expect(disabled(PAY_A11Y)).toBe(true);
    const refresh = screen.getByLabelText('Refresh');
    expect(refresh.props.accessibilityHint).toBe('Loads the latest bill');

    db.failBills = false;
    db.claims = [...STATE_B(), claim(BURGER, B)];
    fireEvent.press(refresh);
    await waitFor(() => expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull());
    const pay = await screen.findByLabelText(/^Pay Hana Lee \$\d+\.\d\d on Venmo, to @hana-1$/);
    expect(pay.props.accessibilityLabel).not.toBe(PAY_A11Y);
    expect(pay.props.accessibilityState?.disabled).toBe(false);
    expect(pay.props.accessibilityLabel).toBe(`Pay Hana Lee ${await yourShare()} on Venmo, to @hana-1`);
  });

  it('R2: a "Couldn\'t open Venmo" line goes away when the payer changes', async () => {
    openLink.mockImplementation(async () => ({ ok: false }));
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText("Couldn't open Venmo. Send $12.80 to @hana-1 in the Venmo app.")).toBeTruthy();
    db.bill = { ...db.bill, payer_id: B };
    await live();
    await waitFor(() => expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull());
    expect(screen.getByLabelText('Settle up')).toBeTruthy();
  });

  it('R2: … and when the share changes (the old "Send $12.80" line goes; the prompt stays, contract O)', async () => {
    openLink.mockImplementation(async () => ({ ok: false }));
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText(/^Couldn't open Venmo\. Send \$12\.80/)).toBeTruthy();
    db.claims = [...STATE_B(), claim(BURGER, B)];
    await live();
    await waitFor(() => expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull());
    // Task 6 (contract O, A1.6): the person may have sent $12.80 another way, so "Did you pay?" stays.
    expect(screen.getByText('Did you pay Hana Lee?')).toBeTruthy();
  });

  it('R3 (contract O, A1.6): while "Did you pay?" shows, a live share change keeps the prompt', async () => {
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    const before = billFetches();
    db.claims = [...STATE_B(), claim(BURGER, B)];
    await live();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(screen.getByText('Did you pay Hana Lee?')).toBeTruthy();
    expect(screen.queryByLabelText(/^Pay Hana Lee/)).toBeNull();
  });

  it('R3: while "Did you pay?" shows, a live payer change (to B) gives "Settle up" and no prompt', async () => {
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    db.bill = { ...db.bill, payer_id: B };
    await live();
    await waitFor(() => expect(screen.queryByText('Did you pay Hana Lee?')).toBeNull());
    expect(screen.getByLabelText('Settle up').props.accessibilityHint).toBe('See what you owe and pay');
    expect(screen.queryByLabelText('I paid')).toBeNull();
  });

  it('review R5 (criterion 59): the host adds a row while B is in Venmo; on return the footer still asks and records $12.80', async () => {
    markRpc();
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    // The host adds Dessert: the bill is no longer complete, but B has claims, so it's early, not blocked.
    db.rows = [...db.rows, row('22222222-0000-4000-8000-000000000005', 'Dessert', 500, 3)];
    db.bill = { ...db.bill, total_cents: 4980 };
    await live();
    expect(await screen.findByLabelText('Claim Dessert')).toBeTruthy(); // the refetch with the new row has landed
    // Contract O: the prompt stays, not "You can pay now · 1 item left to claim".
    expect(screen.getByText('Did you pay Hana Lee?')).toBeTruthy();
    expect(screen.queryByText('You can pay now · 1 item left to claim')).toBeNull();
    fireEvent.press(screen.getByLabelText('I paid'));
    expect(await screen.findByText('Marked paid · 1 item left to claim')).toBeTruthy();
    expect(markCalls()).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1280 }]]);
    expect(screen.queryByText('Did you pay Hana Lee?')).toBeNull();
  });

  it('R3: I paid waits while B\'s claim is saving in the "Did you pay?" state', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc((fn) => (fn === 'set_claim' ? new Promise<FakeResult>((r) => (resolve = r)) : { data: null, error: null }));
    await openBill();
    fireEvent.press(screen.getByLabelText(PAY_A11Y));
    expect(await screen.findByText('Did you pay Hana Lee?')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Claim Burger'));
    expect(disabled('I paid')).toBe(true);
    fireEvent.press(screen.getByLabelText('I paid'));
    expect(markCalls()).toHaveLength(0);
    expect(disabled('Not yet')).toBe(false);
    // The claim lands: the share changed, but the prompt stays (contract O, Task 6) and I paid comes back.
    db.claims = [...STATE_B(), claim(BURGER, B)];
    await act(async () => resolve({ data: null, error: null }));
    await waitFor(() => expect(disabled('I paid')).toBe(false));
    expect(screen.getByText('Did you pay Hana Lee?')).toBeTruthy();
  });

  async function yourShare(): Promise<string> {
    const label = String((await screen.findByLabelText(/^Your share \$/)).props.accessibilityLabel);
    return label.replace('Your share ', '');
  }
});

describe('visual pass V12/V13', () => {
  /** Each button's accessible name: its label, else its text. */
  const labels = () =>
    screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? within(b).queryByText(/./)?.props.children ?? ''));
  const signIn = (id: string) => {
    const session = fakeSession('Viewer');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id } });
  };

  it('P8: while the host is alone, the invite block comes before the items', async () => {
    signIn(A);
    db.participants = db.participants.slice(0, 1);
    await openBill();
    const l = labels();
    expect(l.indexOf('Copy link')).toBeGreaterThan(-1);
    expect(l.indexOf('Copy link')).toBeLessThan(l.indexOf('Claim Burger'));
  });

  it('P8: once someone has joined, the invite block sits after the items', async () => {
    signIn(A);
    await openBill();
    const l = labels();
    expect(l.indexOf('Copy link')).toBeGreaterThan(l.indexOf('Claim Burger'));
  });

  it('header: Home and Activity are in the native bar; no "‹" glyph', async () => {
    await openBill();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeTruthy();
    expect(screen.queryByText(/‹/)).toBeNull();
  });

  it('claim toggle: "Mine" carries a check icon, not a glyph', async () => {
    db.claims = STATE_A();
    await openBill();
    expect(screen.getAllByText('Mine').length).toBeGreaterThan(0);
    expect(screen.queryByText(/✓/)).toBeNull();
    expect(screen.UNSAFE_queryAllByType(Check).length).toBeGreaterThan(0);
  });

  it('footer: the expand toggle uses a chevron icon; a claim error is one compact alert line', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'x' } }));
    await openBill();
    expect(screen.UNSAFE_queryAllByType(ChevronUp)).toHaveLength(1);
    expect(screen.queryByText(/[▴▾]/)).toBeNull();
    fireEvent.press(screen.getByLabelText('Claim Fries'));
    expect(await screen.findByRole('alert', { name: "Couldn't save your claim. Try again." })).toBeTruthy();
  });

  // Review R3: the "no glyph" check must run where the toggles are rendered. Expanded, as the host,
  // the extras control ("Change" / "Done") is on screen, so the absence assertions can fail.
  it('expanded as the host: the extras toggle shows chevrons, never ▴/▾, closed and open', async () => {
    signIn(A);
    await openBill();
    await expand();
    const extras = screen.getByLabelText('How tax and tip are split'); // positive control: the region is there
    expect(within(extras).getByText('Change', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(ChevronDown).length).toBeGreaterThan(0);
    expect(screen.queryByText(/[▴▾]/, { includeHiddenElements: true })).toBeNull();
    fireEvent.press(extras);
    expect(within(screen.getByRole('button', { name: 'How tax and tip are split' })).getByText('Done', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText('Split evenly')).toBeTruthy(); // the options are open
    expect(screen.queryByText(/[▴▾]/, { includeHiddenElements: true })).toBeNull();
  });
});
