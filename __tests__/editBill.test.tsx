// Host edit screen: criteria 99–104 (and A3.4) in docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 13).
// The bill is criterion 57's: Burger 15.00, Fries 6.00, Beer ×2 (7.00 each), tax 2.80, tip 7.00,
// total 44.80. A (Hana Lee) is the host; B (Bo) is a participant. Fries is claimed by A and B, and
// each Beer unit is claimed (unit 0 by B, unit 1 by A).
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useLocalSearchParams } from 'expo-router';
import { Platform, Text } from 'react-native';

import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const BILL = '11111111-1111-4111-8111-111111111111';
const OTHER_BILL = '11111111-1111-4111-8111-999999999999';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';
const BEER1 = '22222222-0000-4000-8000-000000000003';
const BEER2 = '22222222-0000-4000-8000-000000000004';
const SERVER_TEXT = 'invalid_bill: row 22222222 is not in this bill (ada@example.com)';

const HOST_ONLY = 'Only the person who created this bill can edit it.';
const SAVE = 'Save changes';

function row(id: string, name: string, cents: number, g: number, u = 0, size = 1) {
  return { id, name, note: null, group_position: g, unit_index: u, group_size: size, total_cents: cents, split_set_by: null, split_set_at: null };
}
const claim = (line_item_id: string, user_id: string) => ({ line_item_id, user_id, parts: 1 });

const BILL_ROW = {
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
  extras_split: 'proportional',
};

function installTables() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', (q) => ok(q.calls.some((c) => c.method === 'eq' && c.args[1] === BILL) ? BILL_ROW : null));
  supabase.__setTable('line_items', () =>
    ok([row(BURGER, 'Burger', 1500, 0), row(FRIES, 'Fries', 600, 1), row(BEER1, 'Beer', 700, 2, 0, 2), row(BEER2, 'Beer', 700, 2, 1, 2)]),
  );
  supabase.__setTable('bill_participants', () =>
    ok([
      { user_id: A, joined_at: '2026-11-20T19:00:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Hana Lee', venmo_username: null } },
      { user_id: B, joined_at: '2026-11-20T19:05:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Bo', venmo_username: null } },
    ]),
  );
  supabase.__setTable('claims', () => ok([claim(FRIES, A), claim(FRIES, B), claim(BEER1, B), claim(BEER2, A)]));
}

function signInAs(userId: string) {
  const session = fakeSession('Hana Lee');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

/** Where saving lands; the real bill screen is covered by billScreen.test.tsx. */
function BillScreenStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill screen ${id}`}</Text>;
}

async function openEdit(id = BILL) {
  const router = renderRouter(
    { appDir: './app', overrides: { '(app)/bills/[id]/index': BillScreenStandIn } },
    { initialUrl: `/bills/${id}/edit` },
  );
  await screen.findByText(/Edit items|Only the person|access to this bill/);
  return router;
}

const type = (label: string, value: string) => fireEvent.changeText(screen.getByLabelText(label), value);
const valueOf = (label: string): unknown => screen.getByLabelText(label).props.value;
const saveButton = () => screen.getByRole('button', { name: SAVE });
const updateCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'update_bill');
const sentRows = (): { id?: string; name: string; unit_index: number; total_cents: number }[] =>
  (updateCalls()[0]?.[1] as { p_rows: { id?: string; name: string; unit_index: number; total_cents: number }[] }).p_rows;

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  installTables();
  supabase.__setRpc(() => ({ data: null, error: null }));
  signInAs(A);
});

describe('edit bill', () => {
  it('99: "Edit items" on the bill opens the edit form with the groups regrouped', async () => {
    const router = renderRouter('./app', { initialUrl: `/bills/${BILL}` });
    fireEvent.press(await screen.findByRole('button', { name: 'Edit items' }));
    await screen.findByText("Changing a price updates everyone's share. Deleting an item removes anyone's claim on it.");
    expect(router.getPathname()).toBe(`/bills/${BILL}/edit`);
    expect(valueOf('Item 1 name')).toBe('Burger');
    expect(valueOf('Item 2 name')).toBe('Fries');
    expect(valueOf('Item 3 name')).toBe('Beer');
    expect(valueOf('Item 3 qty')).toBe('2');
    expect(valueOf('Item 3 price')).toBe('14.00');
    expect(screen.queryByLabelText('Item 4 name')).toBeNull();
    expect(valueOf('Total')).toBe('44.80');

    // Saving pops back to the bill screen underneath.
    fireEvent.press(saveButton());
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(updateCalls()).toHaveLength(1);
  });

  it('100: a repriced Burger saves with its id, the Beer ids unchanged and the new total, then returns to the bill', async () => {
    const router = await openEdit();
    type('Item 1 price', '18.00');
    type('Total', '47.80');
    const button = saveButton();
    fireEvent.press(button);
    fireEvent.press(button); // a double press, before React re-renders, still saves once
    await screen.findByText(`Bill screen ${BILL}`);
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    expect(updateCalls()).toHaveLength(1);
    expect(updateCalls()[0]?.[1]).toEqual({
      p_bill_id: BILL,
      p_rows: [
        { id: BURGER, name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1800 },
        { id: FRIES, name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600 },
        { id: BEER1, name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 2, total_cents: 700 },
        { id: BEER2, name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 2, total_cents: 700 },
      ],
      p_subtotal_cents: null,
      p_tax_cents: 280,
      p_fees_cents: 0,
      p_tip_cents: 700,
      p_subtotal_discount_cents: 0,
      p_total_discount_cents: 0,
      p_total_cents: 4780,
    });
  });

  it('101: deleting Fries (2 claimers) asks first; cancel keeps it, confirming and saving omits its id', async () => {
    await openEdit();
    fireEvent.press(screen.getByLabelText('Delete item 2'));
    expect(screen.getByText('2 people claimed this. Delete it anyway?')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('2 people claimed this. Delete it anyway?')).toBeNull();
    expect(valueOf('Item 2 name')).toBe('Fries');

    fireEvent.press(screen.getByLabelText('Delete item 2'));
    fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    expect(valueOf('Item 2 name')).toBe('Beer');
    expect(screen.queryByLabelText('Item 3 name')).toBeNull();

    type('Total', '38.80');
    fireEvent.press(saveButton());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, BEER1, BEER2]);
  });

  it('deleting an unclaimed row does not ask', async () => {
    await openEdit();
    fireEvent.press(screen.getByLabelText('Delete item 1'));
    expect(valueOf('Item 1 name')).toBe('Fries');
    expect(screen.queryByText(/claimed this/)).toBeNull();
  });

  it('102: lowering Beer from 2 to 1 with both units claimed asks; cancel makes no rpc', async () => {
    await openEdit();
    type('Item 3 qty', '1');
    type('Item 3 price', '7.00');
    type('Total', '37.80');
    fireEvent.press(saveButton());
    expect(await screen.findByText('Lowering the quantity removes 1 claimed Beer. Continue?')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(supabase.rpc).not.toHaveBeenCalled();

    fireEvent.press(saveButton());
    fireEvent.press(await screen.findByRole('button', { name: 'Save anyway' }));
    await screen.findByText(`Bill screen ${BILL}`);
    // Both units are claimed, so the highest index goes.
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1]);
  });

  it('R1: Pat claims Beer 2 after Edit opened; lowering Beer to 1 asks, and the save uses the fresh claims', async () => {
    // At open, only Beer 1 is claimed (by B), so the snapshot alone would drop Beer 2 silently.
    supabase.__setTable('claims', () => ({ data: [claim(FRIES, A), claim(FRIES, B), claim(BEER1, B)], error: null }));
    await openEdit();
    type('Item 3 qty', '1');
    type('Item 3 price', '7.00');
    type('Total', '37.80');
    // Pat (A here) claims Beer 2 while the host edits.
    supabase.__setTable('claims', () => ({ data: [claim(FRIES, A), claim(FRIES, B), claim(BEER1, B), claim(BEER2, A)], error: null }));
    fireEvent.press(saveButton());
    expect(await screen.findByText('Lowering the quantity removes 1 claimed Beer. Continue?')).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Save anyway' }));
    await screen.findByText(`Bill screen ${BILL}`);
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1]);
  });

  it('R1: a unit claimed after Edit opened is kept; the still-unclaimed one is dropped, with no question', async () => {
    supabase.__setTable('claims', () => ({ data: [claim(FRIES, A)], error: null }));
    await openEdit();
    type('Item 3 qty', '1');
    type('Item 3 price', '7.00');
    type('Total', '37.80');
    supabase.__setTable('claims', () => ({ data: [claim(FRIES, A), claim(BEER2, B)], error: null }));
    fireEvent.press(saveButton());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(screen.queryByText(/Continue\?/)).toBeNull();
    // The snapshot would have dropped Beer 2 (highest unit); the fresh claims keep it.
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER2]);
  });

  it('R1: if the bill was edited since Edit opened, saving shows the "changed" copy and does not save', async () => {
    await openEdit();
    type('Item 1 price', '18.00');
    type('Total', '47.80');
    supabase.__setTable('bills', () => ({ data: { ...BILL_ROW, edited_at: '2026-11-20T20:00:00Z' }, error: null }));
    fireEvent.press(saveButton());
    expect(await screen.findByText('The bill changed while you were editing. Go back and try again.')).toBeTruthy();
    expect(updateCalls()).toHaveLength(0);
    expect(valueOf('Item 1 price')).toBe('18.00');
  });

  it('R1: if a row was added or removed since Edit opened, saving shows the "changed" copy', async () => {
    await openEdit();
    supabase.__setTable('line_items', () =>
      ({ data: [row(BURGER, 'Burger', 1500, 0), row(FRIES, 'Fries', 600, 1), row(BEER1, 'Beer', 700, 2, 0, 1)], error: null }),
    );
    fireEvent.press(saveButton());
    expect(await screen.findByText('The bill changed while you were editing. Go back and try again.')).toBeTruthy();
    expect(updateCalls()).toHaveLength(0);
  });

  it('R1: a failed re-read at save shows the generic save copy', async () => {
    await openEdit();
    supabase.__setTable('bills', () => ({ data: null, error: { code: '08006', message: SERVER_TEXT } }));
    fireEvent.press(saveButton());
    expect(await screen.findByText("Couldn't save your changes.")).toBeTruthy();
    expect(updateCalls()).toHaveLength(0);
    expect(screen.queryByText(/22222222/)).toBeNull();
  });

  it('A3.4: saving a claimed row whose fields were all cleared asks first', async () => {
    await openEdit();
    type('Item 2 name', '');
    type('Item 2 price', '');
    type('Total', '38.80');
    fireEvent.press(saveButton());
    expect(await screen.findByText('Saving deletes Fries, which 2 people claimed. Continue?')).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Save anyway' }));
    await screen.findByText(`Bill screen ${BILL}`);
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, BEER1, BEER2]);
  });

  it('an edit while a question is open closes it', async () => {
    await openEdit();
    fireEvent.press(screen.getByLabelText('Delete item 2'));
    type('Item 1 name', 'Cheeseburger');
    expect(screen.queryByText('2 people claimed this. Delete it anyway?')).toBeNull();
    expect(saveButton()).toBeTruthy();
  });

  it('103: a non-host sees the host-only copy and no form', async () => {
    signInAs(B);
    const router = await openEdit();
    expect(screen.getByText(HOST_ONLY)).toBeTruthy();
    expect(screen.queryByLabelText('Item 1 name')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText(`Bill screen ${BILL}`);
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('103: invalid_bill shows the "changed while you were editing" copy, never the server text, and keeps the draft', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '22023', message: SERVER_TEXT } }));
    await openEdit();
    type('Item 1 price', '18.00');
    type('Total', '47.80');
    fireEvent.press(saveButton());
    expect(await screen.findByText('The bill changed while you were editing. Go back and try again.')).toBeTruthy();
    expect(screen.queryByText(new RegExp('row 22222222'))).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(valueOf('Item 1 price')).toBe('18.00');

    // Editing clears the old error.
    type('Item 1 name', 'Cheeseburger');
    expect(screen.queryByText(/changed while you were editing/)).toBeNull();
  });

  it('not_allowed shows the host-only copy; other failures show the generic copy', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '42501', message: SERVER_TEXT } }));
    await openEdit();
    fireEvent.press(saveButton());
    expect(await screen.findByText(HOST_ONLY)).toBeTruthy();

    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: SERVER_TEXT } }));
    fireEvent.press(saveButton());
    expect(await screen.findByText("Couldn't save your changes.")).toBeTruthy();
    expect(updateCalls()).toHaveLength(2);
  });

  it('104: save is blocked with the SAVE_BLOCK_COPY reason while the numbers do not add up', async () => {
    await openEdit();
    type('Total', '40.00');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText('The numbers need to add up before you can save.')).toBeTruthy();
    fireEvent.press(saveButton());
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('an unknown bill shows the no-access copy and no form', async () => {
    await openEdit(OTHER_BILL);
    expect(screen.getByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.queryByLabelText('Item 1 name')).toBeNull();
  });

  it('R10: a read RLS refuses (not_allowed) shows the no-access copy, not the load error', async () => {
    supabase.__setTable('bills', () => ({ data: null, error: { code: '42501', message: SERVER_TEXT } }));
    renderRouter({ appDir: './app', overrides: { '(app)/bills/[id]/index': BillScreenStandIn } }, { initialUrl: `/bills/${BILL}/edit` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the bill.")).toBeNull();
    expect(screen.getByText('Go home')).toBeTruthy();
  });

  it('a failed load shows "Couldn\'t load the bill." and Try again reloads', async () => {
    let fail = true;
    supabase.__setTable('bills', () => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: BILL_ROW, error: null }));
    renderRouter({ appDir: './app', overrides: { '(app)/bills/[id]/index': BillScreenStandIn } }, { initialUrl: `/bills/${BILL}/edit` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(await screen.findByText('Edit items')).toBeTruthy();
    expect(valueOf('Item 1 name')).toBe('Burger');
  });
});

// Claimable discounts, criteria 45–47 in docs/specs/2026-11-24-claimable-discounts.md (Task 6).
// The same bill plus two claimable discounts: Comp −5.00 before the subtotal (claimed by B) and
// Coupon −1.00 after it (unclaimed). Total 35.00 − 6.00 + 2.80 + 7.00 = 38.80.
describe('edit bill: claimable discounts', () => {
  const COMP = '22222222-0000-4000-8000-000000000005';
  const COUPON = '22222222-0000-4000-8000-000000000006';
  const discountRow = (id: string, name: string, cents: number, g: number, appliesTo: 'subtotal' | 'total') => ({
    ...row(id, name, cents, g),
    kind: 'discount',
    applies_to: appliesTo,
  });
  const claimSwitch = (n: number) => screen.getByRole('switch', { name: `Discount ${n}: claim like an item` });
  const SPLIT_QUESTION = "Sharing Comp with everyone removes 1 person's claim. Continue?";

  beforeEach(() => {
    supabase.__setTable('bills', (q) =>
      ({ data: q.calls.some((c) => c.method === 'eq' && c.args[1] === BILL) ? { ...BILL_ROW, total_cents: 3880 } : null, error: null }),
    );
    supabase.__setTable('line_items', () => ({
      data: [
        row(BURGER, 'Burger', 1500, 0),
        row(FRIES, 'Fries', 600, 1),
        row(BEER1, 'Beer', 700, 2, 0, 2),
        row(BEER2, 'Beer', 700, 2, 1, 2),
        discountRow(COMP, 'Comp', -500, 3, 'subtotal'),
        discountRow(COUPON, 'Coupon', -100, 4, 'total'),
      ],
      error: null,
    }));
    supabase.__setTable('claims', () => ({ data: [claim(FRIES, A), claim(FRIES, B), claim(BEER1, B), claim(BEER2, A), claim(COMP, B)], error: null }));
  });

  it('47: the form reloads claimable discounts with their switches on, as saved, and "Adds up"', async () => {
    await openEdit();
    expect(valueOf('Discount 1 label')).toBe('Comp');
    expect(valueOf('Discount 1 amount')).toBe('5.00');
    expect(screen.getByLabelText('Discount 1 before subtotal').props.accessibilityState).toMatchObject({ selected: true });
    expect(claimSwitch(1).props.accessibilityState).toMatchObject({ checked: true });
    expect(valueOf('Discount 2 label')).toBe('Coupon');
    expect(valueOf('Discount 2 amount')).toBe('1.00');
    expect(screen.getByLabelText('Discount 2 after subtotal').props.accessibilityState).toMatchObject({ selected: true });
    expect(claimSwitch(2).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getAllByText('People claim this like an item and can share it.')).toHaveLength(2);
    expect(screen.getByLabelText('Totals check: Adds up')).toBeTruthy();

    // Saving untouched sends both discount rows back with their ids.
    fireEvent.press(saveButton());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1, BEER2, COMP, COUPON]);
  });

  it('45: deleting a claimed claimable discount asks first; cancel keeps it, Delete removes it', async () => {
    await openEdit();
    fireEvent.press(screen.getByLabelText('Delete discount 1'));
    expect(screen.getByText('1 person claimed this. Delete it anyway?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' }).props.accessibilityHint).toBe('Removes this discount and its claims');
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(valueOf('Discount 1 label')).toBe('Comp');

    fireEvent.press(screen.getByLabelText('Delete discount 1'));
    fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    expect(valueOf('Discount 1 label')).toBe('Coupon');
    expect(screen.queryByLabelText('Discount 2 label')).toBeNull();

    type('Total', '43.80');
    fireEvent.press(saveButton());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(screen.queryByText(/Continue\?/)).toBeNull();
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1, BEER2, COUPON]);
  });

  it('45: deleting an unclaimed claimable discount, or a split one, removes it at once', async () => {
    await openEdit();
    fireEvent.press(screen.getByLabelText('Delete discount 2'));
    expect(screen.queryByText(/claimed this/)).toBeNull();
    expect(screen.queryByLabelText('Discount 2 label')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Add discount' }));
    expect(claimSwitch(2).props.accessibilityState).toMatchObject({ checked: false });
    fireEvent.press(screen.getByLabelText('Delete discount 2'));
    expect(screen.queryByText(/claimed this/)).toBeNull();
    expect(screen.queryByLabelText('Discount 2 label')).toBeNull();
  });

  it('46: switching a claimed discount to Split asks at save; cancel calls nothing, Save anyway saves once', async () => {
    await openEdit();
    fireEvent(claimSwitch(1), 'valueChange', false);
    expect(screen.getByLabelText('Totals check: Adds up')).toBeTruthy();
    fireEvent.press(saveButton());
    expect(await screen.findByText(SPLIT_QUESTION)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(SPLIT_QUESTION)).toBeNull();
    expect(updateCalls()).toHaveLength(0);
    // The switch stays where the host left it.
    expect(claimSwitch(1).props.accessibilityState).toMatchObject({ checked: false });

    fireEvent.press(saveButton());
    fireEvent.press(await screen.findByRole('button', { name: 'Save anyway' }));
    await screen.findByText(`Bill screen ${BILL}`);
    expect(updateCalls()).toHaveLength(1);
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1, BEER2, COUPON]);
    expect(updateCalls()[0]?.[1]).toMatchObject({ p_subtotal_discount_cents: 500, p_total_discount_cents: 0, p_total_cents: 3880 });
  });

  it('46: flipping Claim → Split → Claim keeps the row and its claim, with no question', async () => {
    await openEdit();
    fireEvent(claimSwitch(1), 'valueChange', false);
    fireEvent(claimSwitch(1), 'valueChange', true);
    fireEvent.press(saveButton());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(screen.queryByText(/Continue\?/)).toBeNull();
    expect(sentRows().map((r) => r.id)).toEqual([BURGER, FRIES, BEER1, BEER2, COMP, COUPON]);
  });
});

// Visual pass V8 / review R4: Edit's header Back (native bar) on iOS and web.
describe.each(['ios', 'web'] as const)('edit bill header Back on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));
  const back = () => screen.getByRole('button', { name: 'Back' });

  it('a cold /bills/<id>/edit: Back lands on the bill', async () => {
    const router = await openEdit();
    fireEvent.press(back());
    await screen.findByText(`Bill screen ${BILL}`);
    expect(router.getPathname()).toBe(`/bills/${BILL}`);
  });

  it('while a save is pending, Back is disabled and pressing it goes nowhere', async () => {
    const router = await openEdit();
    type('Item 1 price', '18.00');
    type('Total', '47.80');
    supabase.__setRpc(() => new Promise(() => {})); // update_bill never settles
    fireEvent.press(saveButton());
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(back().props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(back());
    expect(router.getPathname()).toBe(`/bills/${BILL}/edit`);
    expect(screen.queryByText(`Bill screen ${BILL}`)).toBeNull();
  });
});
