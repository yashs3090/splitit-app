// Extras split control and the "equal" pending state: criteria 152–155 and 161–162 in
// docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 19). Criterion 163 (the summary follows
// displayShares, not its own logic) is in billScreen.test.tsx.
// The bill is criterion 57's: Burger 15.00, Fries 6.00, Beer ×2 (7.00 each), total 44.80.
// A (Hana Lee) is the host; B is Bo.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeChannel, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
/** Every rpc call except the bill screen's fire-and-forget mark_bill_seen (bill markers D6), which runs once per open. */
// Also not the host's one my_groups read (groups GR-T17-12: "Move to a group"), which writes nothing.
const rpcCallsExceptSeen = () => supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen' && fn !== 'my_groups');
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';
const BEER1 = '22222222-0000-4000-8000-000000000003';
const BEER2 = '22222222-0000-4000-8000-000000000004';

const CONTROL = 'How tax and tip are split';
const PROPORTIONAL_TEXT = 'Tax & tip: split proportionally';
const EQUAL_TEXT = 'Tax & tip: split evenly';
const EQUAL_HELP = 'Split evenly between everyone who has claimed something.';
const ERROR_TEXT = "Couldn't change how tax and tip are split.";

type Claim = { line_item_id: string; user_id: string; parts: number };

const db: {
  bill: Record<string, unknown>;
  rows: Record<string, unknown>[];
  claims: Claim[];
  events: Record<string, unknown>[];
} = { bill: {}, rows: [], claims: [], events: [] };

function row(id: string, name: string, cents: number, g: number, u = 0, size = 1) {
  return { id, name, note: null, group_position: g, unit_index: u, group_size: size, total_cents: cents, split_set_by: null, split_set_at: null };
}

const claim = (rowId: string, userId: string): Claim => ({ line_item_id: rowId, user_id: userId, parts: 1 });
/** 57(b): everything claimed. B: Fries, Beer 1. A: Burger, Fries, Beer 2. */
const ALL_CLAIMED = () => [claim(FRIES, B), claim(BEER1, B), claim(BURGER, A), claim(FRIES, A), claim(BEER2, A)];
/** Criterion 158: Burger unclaimed (1 row left). */
const BURGER_LEFT = () => ALL_CLAIMED().filter((c) => c.line_item_id !== BURGER);

function reset(mode: 'proportional' | 'equal' = 'proportional') {
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
    group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
    created_at: '2026-11-20T19:00:00Z',
    edited_at: null,
    extras_split: mode,
  };
  db.rows = [row(BURGER, 'Burger', 1500, 0), row(FRIES, 'Fries', 600, 1), row(BEER1, 'Beer', 700, 2, 0, 2), row(BEER2, 'Beer', 700, 2, 1, 2)];
  db.claims = ALL_CLAIMED();
  db.events = [];
}

function installTables() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () => ok({ ...db.bill }));
  supabase.__setTable('line_items', () => ok(db.rows.map((r) => ({ ...r }))));
  supabase.__setTable('bill_participants', () =>
    ok([
      { user_id: A, joined_at: '2026-11-20T19:00:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Hana Lee', venmo_username: null } },
      { user_id: B, joined_at: '2026-11-20T19:05:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Bo', venmo_username: null } },
    ]),
  );
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  supabase.__setTable('bill_events', () => ok(db.events));
}

function signInAs(userId: string) {
  const session = fakeSession('Someone');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};

async function openBill() {
  renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
  await screen.findByText('Total $44.80');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
}

function expand() {
  fireEvent.press(screen.getByLabelText(/^Your (share|items) /));
}

async function choose(option: 'Split evenly' | 'Split proportionally') {
  fireEvent.press(screen.getByLabelText(CONTROL));
  await act(async () => fireEvent.press(screen.getByLabelText(option)));
}

beforeEach(() => {
  jest.clearAllMocks();
  reset();
  installTables();
  supabase.__queries.length = 0;
  supabase.__setRpc(() => ({ data: null, error: null }));
  signInAs(B);
});

describe('extras split control', () => {
  it('152: everyone sees the mode as text; a non-host gets no control', async () => {
    await openBill();
    expand();
    expect(screen.getByText(PROPORTIONAL_TEXT)).toBeTruthy();
    expect(screen.queryByLabelText(CONTROL)).toBeNull();
    expect(screen.queryByText(EQUAL_HELP)).toBeNull();
  });

  it('152: the host sees the same line as a selector with exactly two options', async () => {
    signInAs(A);
    await openBill();
    expand();
    expect(screen.getByText(PROPORTIONAL_TEXT)).toBeTruthy();
    fireEvent.press(screen.getByLabelText(CONTROL));
    const radios = screen.getAllByRole('radio').map((r) => String(r.props.accessibilityLabel));
    expect(radios).toEqual(['Split proportionally', 'Split evenly']);
    expect(screen.getByLabelText('Split proportionally').props.accessibilityState).toMatchObject({ checked: true });
  });

  it('153: choosing "split evenly" calls set_extras_split and updates shares before it resolves', async () => {
    signInAs(A);
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    await openBill();
    expect(screen.getByLabelText('Your share $32.00')).toBeTruthy();
    expand();
    await choose('Split evenly');
    expect(supabase.rpc).toHaveBeenCalledWith('set_extras_split', { p_bill_id: BILL, p_mode: 'equal' });
    // Criterion 149(b), before the call resolves.
    expect(screen.getByLabelText('Your share $29.90')).toBeTruthy();
    expect(screen.getByLabelText('Bo $14.90')).toBeTruthy();
    expect(screen.getByText(EQUAL_TEXT)).toBeTruthy();
    expect(screen.getByText(EQUAL_HELP)).toBeTruthy();
    // While saving, the selector is disabled: a second change can't be sent.
    expect(screen.getByLabelText(CONTROL).props.accessibilityState).toMatchObject({ disabled: true });

    db.bill = { ...db.bill, extras_split: 'equal' };
    await act(async () => resolve({ data: null, error: null }));
    await waitFor(() => expect(screen.getByLabelText(CONTROL).props.accessibilityState).toMatchObject({ disabled: false }));
    expect(screen.getByLabelText('Your share $29.90')).toBeTruthy();
    expect(rpcCallsExceptSeen()).toHaveLength(1);
  });

  it('153: a failed change rolls back with fixed copy, never the server text', async () => {
    signInAs(A);
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    await openBill();
    expand();
    await choose('Split evenly');
    expect(screen.getByLabelText('Your share $29.90')).toBeTruthy();
    await act(async () => resolve({ data: null, error: { code: '08006', message: 'server text: boom' } }));
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy();
    expect(screen.getByLabelText('Your share $32.00')).toBeTruthy();
    expect(screen.getByLabelText('Bo $12.80')).toBeTruthy();
    expect(screen.getByText(PROPORTIONAL_TEXT)).toBeTruthy();
    expect(screen.queryByText(EQUAL_HELP)).toBeNull();
    expect(screen.queryByText(/server text/)).toBeNull();
  });

  it('R8: a failed change goes back to a saved change still waiting for its refetch, not to the old server mode', async () => {
    signInAs(A);
    await openBill();
    expand();
    // Hold every bills read from now on, so the first change's confirming refetch hasn't landed.
    const held: (() => void)[] = [];
    supabase.__setTable('bills', () => new Promise<FakeResult>((r) => held.push(() => r({ data: { ...db.bill }, error: null }))));
    await choose('Split evenly'); // succeeds (default rpc), waits for its refetch
    expect(screen.getByText(EQUAL_TEXT)).toBeTruthy();

    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'server text: boom' } }));
    await choose('Split proportionally');
    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy();
    // Back to "evenly" (the saved change), not the stale server value.
    expect(screen.getByText(EQUAL_TEXT)).toBeTruthy();
    expect(screen.queryByText(PROPORTIONAL_TEXT)).toBeNull();

    // Let the held refetches land with the server now on 'equal'.
    db.bill = { ...db.bill, extras_split: 'equal' };
    await act(async () => held.splice(0).forEach((go) => go()));
    expect(await screen.findByText(EQUAL_TEXT)).toBeTruthy();
  });

  it('153: choosing the current mode sends nothing', async () => {
    signInAs(A);
    await openBill();
    expand();
    await choose('Split proportionally');
    expect(rpcCallsExceptSeen()).toHaveLength(0);
  });

  it('154: a live refetch that brings extras_split = equal updates a participant with no action', async () => {
    await openBill();
    expand();
    expect(screen.getByLabelText('Your share $12.80')).toBeTruthy();
    db.bill = { ...db.bill, extras_split: 'equal' };
    await act(async () => liveChannel().__broadcast('changed', { t: 'bills' }));
    expect(await screen.findByLabelText('Your share $14.90')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $29.90')).toBeTruthy();
    expect(screen.getByText(EQUAL_TEXT)).toBeTruthy();
    expect(screen.getByText(EQUAL_HELP)).toBeTruthy();
    // No "updated the bill" notice: edited_at didn't change.
    expect(screen.queryByText(/updated the bill/)).toBeNull();
  });
});

describe('pending totals under "equal" (A2.2)', () => {
  it('161: with 1 unclaimed row, items only and the pending line per person', async () => {
    reset('equal');
    db.claims = BURGER_LEFT();
    await openBill();
    expect(screen.getByLabelText('Your items $10.00')).toBeTruthy();
    expect(screen.queryByLabelText(/^Your share/)).toBeNull();
    expand();
    expect(screen.getAllByText('Total shows once all items are claimed (1 item left)')).toHaveLength(2);
    expect(screen.queryByText(/tax, tip and fees/)).toBeNull();
    expect(screen.queryByText(/\$29\.90|\$14\.90/)).toBeNull();
  });

  it('161: with 3 unclaimed rows, "(3 items left)"', async () => {
    reset('equal');
    db.claims = [claim(FRIES, B)];
    await openBill();
    expand();
    expect(screen.getAllByText('Total shows once all items are claimed (3 items left)')).toHaveLength(2);
  });

  it('162: when the last row is claimed live, totals replace the pending lines', async () => {
    reset('equal');
    db.claims = BURGER_LEFT();
    await openBill();
    expand();
    db.claims = ALL_CLAIMED();
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    expect(await screen.findByLabelText('Your share $14.90')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $29.90')).toBeTruthy();
    expect(screen.queryByText(/Total shows once/)).toBeNull();
  });

  it('162: the host switching to proportional while incomplete shows totals at once', async () => {
    reset('equal');
    db.claims = BURGER_LEFT();
    signInAs(A);
    supabase.__setRpc(() => new Promise<FakeResult>(() => {}));
    await openBill();
    expect(screen.getByLabelText('Your items $10.00')).toBeTruthy();
    expand();
    await choose('Split proportionally');
    expect(supabase.rpc).toHaveBeenCalledWith('set_extras_split', { p_bill_id: BILL, p_mode: 'proportional' });
    // Proportional over [A 1000, B 1000, unclaimed 1500]: 980 × 1000/3500 = 280 each.
    expect(screen.getByLabelText('Your share $12.80')).toBeTruthy();
    expect(screen.getByLabelText('Bo $12.80')).toBeTruthy();
    expect(screen.queryByText(/Total shows once/)).toBeNull();
  });
});

describe('activity', () => {
  const extrasEvent = {
    id: 'eeeeeeee-0000-4000-8000-000000000001',
    actor_id: A,
    kind: 'extras_split_changed',
    item_name: null,
    details: { before: 'proportional', after: 'equal' },
    created_at: new Date(Date.now() - 30_000).toISOString(),
  };

  it('155: renders extras_split_changed as a plain sentence', async () => {
    db.events = [extrasEvent];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/activity` });
    expect(await screen.findByText('Hana Lee changed tax & tip to split evenly')).toBeTruthy();
  });

  it('155: the host reads it as "You changed …"', async () => {
    signInAs(A);
    db.events = [extrasEvent];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/activity` });
    expect(await screen.findByText('You changed tax & tip to split evenly')).toBeTruthy();
  });
});
