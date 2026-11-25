// Item detail sheet + custom split: criteria 85–90 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md
// (Task 11; A1.2 any claimer edits everyone's parts; A2.3 parts are kept when claimers change).
// The bill is criterion 57's: Burger 15.00, Fries 6.00, Beer ×2 (7.00 each), total 44.80.
// A is the host (Hana Lee); the viewer is B (Bo); C (Cy) is a third participant.
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
const rpcCallsExceptSeen = () => supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen');

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';
const BEER1 = '22222222-0000-4000-8000-000000000003';
const BEER2 = '22222222-0000-4000-8000-000000000004';

type Claim = { line_item_id: string; user_id: string; parts: number };
type Row = ReturnType<typeof row>;

const db: { bill: Record<string, unknown>; rows: Row[]; participants: Record<string, unknown>[]; claims: Claim[] } = {
  bill: {},
  rows: [],
  participants: [],
  claims: [],
};

function row(id: string, name: string, cents: number, g: number, u = 0, size = 1) {
  return {
    id,
    name,
    note: null,
    group_position: g,
    unit_index: u,
    group_size: size,
    total_cents: cents,
    split_set_by: null as string | null,
    split_set_at: null as string | null,
  };
}

const claim = (rowId: string, userId: string, parts = 1): Claim => ({ line_item_id: rowId, user_id: userId, parts });
/** 57(b): everything claimed; Fries shared by A and B. */
const STATE_B = () => [claim(FRIES, B), claim(BEER1, B), claim(BURGER, A), claim(FRIES, A), claim(BEER2, A)];

function setFriesParts(parts: Record<string, number>, setBy: string) {
  db.claims = db.claims.map((c) => (c.line_item_id === FRIES && parts[c.user_id] !== undefined ? { ...c, parts: parts[c.user_id]! } : c));
  db.rows = db.rows.map((r) => (r.id === FRIES ? { ...r, split_set_by: setBy, split_set_at: '2026-11-20T19:30:00Z' } : r));
}

beforeEach(() => {
  jest.clearAllMocks();
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
    { user_id: C, joined_at: '2026-11-20T19:06:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Cy', venmo_username: null } },
  ];
  db.claims = STATE_B();
  supabase.__setTable('bills', () => ({ data: db.bill, error: null }));
  supabase.__setTable('line_items', () => ({ data: db.rows.map((r) => ({ ...r })), error: null }));
  supabase.__setTable('bill_participants', () => ({ data: db.participants, error: null }));
  supabase.__setTable('claims', () => ({ data: db.claims.map((c) => ({ ...c })), error: null }));
  supabase.__queries.length = 0;
  supabase.__setRpc(() => ({ data: null, error: null }));
  const session = fakeSession('Bo Bo');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: B } });
});

const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};

async function openFries() {
  renderRouter('./app', { initialUrl: `/bills/${BILL}` });
  await screen.findByText('Total $44.80');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
  await screen.findByText('Done');
}

describe('item sheet', () => {
  it('85: lists every claimer with their amount', async () => {
    await openFries();
    expect(screen.getByLabelText('You $3.00')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
    expect(screen.queryByLabelText(/^Cy /)).toBeNull();
    fireEvent.press(screen.getByText('Done'));
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('86: a claimer gets a stepper for every claimer, a live preview, and saves all claimers', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    await openFries();
    expect(screen.queryByLabelText(/More parts for/)).toBeNull();
    fireEvent.press(screen.getByText('Split differently'));
    expect(screen.getByLabelText('More parts for You')).toBeTruthy();
    expect(screen.getByLabelText('More parts for Hana Lee')).toBeTruthy();
    // Parts never go below 1.
    expect(screen.getByLabelText('Fewer parts for Hana Lee').props.accessibilityState).toMatchObject({ disabled: true });

    fireEvent.press(screen.getByLabelText('More parts for Hana Lee'));
    expect(screen.getByText('2 parts')).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $4.00')).toBeTruthy();
    expect(screen.getByLabelText('You $2.00')).toBeTruthy();
    expect(rpcCallsExceptSeen()).toHaveLength(0);

    fireEvent.press(screen.getByText('Save split'));
    expect(rpcCallsExceptSeen()).toHaveLength(1);
    expect(supabase.rpc).toHaveBeenCalledWith('set_item_split', { p_line_item_id: FRIES, p_parts: { [A]: 2, [B]: 1 } });
    // Optimistic: the shares and the row update before the call resolves.
    expect(screen.getByLabelText('Your share $11.52')).toBeTruthy();
    expect(screen.getAllByText('Custom split · set by you').length).toBeGreaterThan(0);

    setFriesParts({ [A]: 2, [B]: 1 }, B);
    await act(async () => resolve({ data: null, error: null }));
    await waitFor(() => expect(billFetches()).toBeGreaterThanOrEqual(2));
    expect(screen.getByLabelText('Hana Lee $4.00')).toBeTruthy();
    expect(screen.getByLabelText('Your share $11.52')).toBeTruthy();
  });

  it('86: Cancel discards the draft without calling anything', async () => {
    await openFries();
    fireEvent.press(screen.getByText('Split differently'));
    fireEvent.press(screen.getByLabelText('More parts for You'));
    expect(screen.getByLabelText('You $4.00')).toBeTruthy();
    fireEvent.press(screen.getByText('Cancel'));
    expect(screen.getByLabelText('You $3.00')).toBeTruthy();
    expect(rpcCallsExceptSeen()).toHaveLength(0);
  });

  it('86/A2.3: someone who joins the item while you edit is included at their current parts', async () => {
    await openFries();
    fireEvent.press(screen.getByText('Split differently'));
    fireEvent.press(screen.getByLabelText('More parts for Hana Lee'));
    db.claims = [...db.claims, claim(FRIES, C)];
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    expect(await screen.findByLabelText('More parts for Cy')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText('Save split')));
    expect(supabase.rpc).toHaveBeenCalledWith('set_item_split', { p_line_item_id: FRIES, p_parts: { [A]: 2, [B]: 1, [C]: 1 } });
  });

  it('87: a non-claimer sees amounts only, with the hint', async () => {
    db.claims = [claim(FRIES, A), claim(FRIES, C)];
    await openFries();
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
    expect(screen.getByLabelText('Cy $3.00')).toBeTruthy();
    expect(screen.getByText("Claim this item to change how it's split.")).toBeTruthy();
    expect(screen.queryByText('Split differently')).toBeNull();
    expect(screen.queryByText('Save split')).toBeNull();
    expect(screen.queryByText('Reset to even')).toBeNull();
    expect(screen.queryByLabelText(/parts for/)).toBeNull();
  });

  it('87: an unclaimed item says nobody has claimed it', async () => {
    db.claims = [];
    await openFries();
    expect(screen.getByText('Nobody has claimed this yet.')).toBeTruthy();
    expect(screen.queryByText('Split differently')).toBeNull();
  });

  it('88: claimers_changed shows the copy and refetches', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '22023', message: 'claimers_changed' } }));
    await openFries();
    const base = billFetches();
    fireEvent.press(screen.getByText('Split differently'));
    fireEvent.press(screen.getByLabelText('More parts for Hana Lee'));
    fireEvent.press(screen.getByText('Save split'));
    expect(await screen.findByText('Someone joined or left this item. Check the split and try again.')).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBe(base + 1));
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
  });

  it('88: any other failure rolls the preview back with fixed copy, never the server message', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'server text: boom' } }));
    await openFries();
    fireEvent.press(screen.getByText('Split differently'));
    fireEvent.press(screen.getByLabelText('More parts for Hana Lee'));
    fireEvent.press(screen.getByText('Save split'));
    expect(await screen.findByText("Couldn't save the split. Try again.")).toBeTruthy();
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
    expect(screen.getByLabelText('Your share $12.80')).toBeTruthy();
    // The row and the sheet's status line both read even again.
    expect(screen.getAllByText('Split 2 ways · $3.00 each')).toHaveLength(2);
    expect(screen.queryByText(/server text/)).toBeNull();
  });

  it('89: "Reset to even" shows only when parts differ, and sends every claimer at 1', async () => {
    await openFries();
    expect(screen.queryByText('Reset to even')).toBeNull();
    fireEvent.press(screen.getByText('Done'));

    setFriesParts({ [A]: 2 }, A);
    await act(async () => liveChannel().__broadcast('changed', { t: 'claims' }));
    expect(await screen.findByText('Custom split · set by Hana Lee')).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
    expect(screen.getByLabelText('Hana Lee $4.00')).toBeTruthy();
    setFriesParts({ [A]: 1 }, B); // what the server holds after the call
    await act(async () => fireEvent.press(screen.getByText('Reset to even')));
    expect(supabase.rpc).toHaveBeenCalledWith('set_item_split', { p_line_item_id: FRIES, p_parts: { [A]: 1, [B]: 1 } });
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
  });

  it('A2.3: kept custom parts show when someone joins the item', async () => {
    setFriesParts({ [A]: 2 }, B);
    db.claims = [...db.claims, claim(FRIES, C)];
    await openFries();
    // 600 split 2:1:1 → A 300, B 150, C 150.
    expect(screen.getByLabelText('Hana Lee $3.00')).toBeTruthy();
    expect(screen.getByLabelText('You $1.50')).toBeTruthy();
    expect(screen.getByLabelText('Cy $1.50')).toBeTruthy();
    expect(screen.getAllByText('Custom split · set by you').length).toBeGreaterThan(0);
  });

  it('R7: "Save split" is disabled until a part changes', async () => {
    await openFries();
    fireEvent.press(screen.getByText('Split differently'));
    const saveSplit = () => screen.getByRole('button', { name: 'Save split' });
    expect(saveSplit().props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(saveSplit());
    expect(rpcCallsExceptSeen()).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('More parts for You'));
    expect(saveSplit().props.accessibilityState?.disabled).toBe(false);
    fireEvent.press(screen.getByLabelText('Fewer parts for You'));
    expect(saveSplit().props.accessibilityState?.disabled).toBe(true);
  });

  it('R6: no "Split differently" while the viewer\'s claim on the row is still in flight', async () => {
    // C (Cy) hasn't claimed Fries; Fries is shared by A and B. View as C.
    const session = fakeSession('Cy');
    supabase.__setInitialSession({ ...session, user: { ...session.user, id: C } });
    let resolve: (r: FakeResult) => void = () => {};
    supabase.__setRpc(() => new Promise<FakeResult>((r) => (resolve = r)));
    renderRouter('./app', { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $44.80');
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());

    fireEvent.press(screen.getByLabelText('Claim Fries'));
    fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
    await screen.findByText('Done');
    // The optimistic claim shows Cy on the row, but the server doesn't know yet.
    expect(screen.getByLabelText('You $2.00')).toBeTruthy();
    expect(screen.queryByText('Split differently')).toBeNull();

    // Once set_claim succeeded, the split may be changed.
    db.claims = [...db.claims, claim(FRIES, C)];
    await act(async () => resolve({ data: null, error: null }));
    expect(await screen.findByText('Split differently')).toBeTruthy();
  });

  it('90: the sheet closes when a live refetch deletes its row', async () => {
    await openFries();
    db.rows = db.rows.filter((r) => r.id !== FRIES);
    db.claims = db.claims.filter((c) => c.line_item_id !== FRIES);
    db.bill = { ...db.bill, edited_at: '2026-11-20T20:00:00Z' };
    await act(async () => liveChannel().__broadcast('changed', { t: 'bills' }));
    await waitFor(() => expect(screen.queryByText('Done')).toBeNull());
    expect(screen.queryByLabelText(/^Fries, \$6\.00, /)).toBeNull();
  });
});
