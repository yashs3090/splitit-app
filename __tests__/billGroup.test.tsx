// Bills and groups, part 1: spec docs/specs/2026-11-26-groups-mvp.md T17 (criteria 81, 82, 111, 112)
// as amended by A1 (S1b, S7, S15, A1.6).
// - /bills/<id>/group: moving a bill into a group and taking it out.
// - /bill from a group's "Add, then Receipt": create_bill, then attach_bill_to_group.
// - /b/<code> of a group bill opened by a non-member.
// The data layers are mocked at their exported functions (lib/groups.test.ts and lib/bills.test.ts
// cover their parsing and error mapping); the bill read goes through the real useBill.
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { router as appRouter, useLocalSearchParams } from 'expo-router';
import { Platform, Text } from 'react-native';

import type { BillData, BillMember } from '@/lib/bills';
import * as bills from '@/lib/bills';
import type { GroupError, GroupResult, GroupSummary } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { clearGroupReceipt, getAttachFailure, getScanGroup, setScanGroup } from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeMark, fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, BEN, W1 } from '@/test-utils/groupFixtures';
import { GROUP_ID, GROUP_NAME, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return {
    ...actual,
    listMyGroups: jest.fn(),
    fetchBillGroup: jest.fn(),
    fetchGroupSnapshot: jest.fn(),
    attachBillToGroup: jest.fn(),
    detachBillFromGroup: jest.fn(),
  };
});
jest.mock('@/lib/bills', () => {
  const actual = jest.requireActual<typeof import('@/lib/bills')>('@/lib/bills');
  return { ...actual, fetchBill: jest.fn(), createBill: jest.fn(), joinBill: jest.fn() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const listMyGroups = groups.listMyGroups as jest.MockedFunction<typeof groups.listMyGroups>;
const fetchBillGroup = groups.fetchBillGroup as jest.MockedFunction<typeof groups.fetchBillGroup>;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const attach = groups.attachBillToGroup as jest.MockedFunction<typeof groups.attachBillToGroup>;
const detach = groups.detachBillFromGroup as jest.MockedFunction<typeof groups.detachBillFromGroup>;
const fetchBill = bills.fetchBill as jest.MockedFunction<typeof bills.fetchBill>;
const createBill = bills.createBill as jest.MockedFunction<typeof bills.createBill>;
const joinBill = bills.joinBill as jest.MockedFunction<typeof bills.joinBill>;

const BILL = '11111111-2222-4333-8444-555555555555';
const CODE = '0123456789abcdef0123';
const SAM = 'eeeeeeee-0000-4000-8000-000000000005';
const SKI_ID = '9a000000-0000-4000-8000-000000000002';
const NAMES: Record<string, string> = { [ANA]: 'Ana', [BEN]: 'Ben', [SAM]: 'Sam' };

const done: GroupResult = { ok: true };
const fail = (error: GroupError): { ok: false; error: GroupError } => ({ ok: false, error });
const tahoe: GroupSummary = { id: GROUP_ID, name: GROUP_NAME, memberCount: 4, joinedAt: '2026-11-20T12:00:00.000Z', hidden: false };
const ski: GroupSummary = { id: SKI_ID, name: 'Ski weekend', memberCount: 2, joinedAt: '2026-11-19T12:00:00.000Z', hidden: false };

function member(userId: string, marked = false): BillMember {
  return {
    userId,
    displayName: NAMES[userId] ?? null,
    venmoUsername: null,
    mark: marked ? fakeMark(1200, '2026-11-20T20:00:00.000Z', ANA) : null,
    notReceived: null,
  };
}

const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';

/**
 * Burger $15.00 and Fries $6.00 (total $21.00). By default both are claimed (complete);
 * `claimed: 'burger'` leaves Fries unclaimed; `zero` makes both rows $0.00 (all-$0 with $21.00 extras).
 */
function billData(participants: BillMember[], hostId = ANA, opts: { claimed?: 'all' | 'burger'; zero?: boolean } = {}): BillData {
  const row = (id: string, name: string, position: number, cents: number) => ({
    id,
    name,
    note: null,
    group_position: position,
    unit_index: 0,
    group_size: 1,
    total_cents: opts.zero ? 0 : cents,
    kind: 'item' as const,
    applies_to: null,
    split_set_by: null,
    split_set_at: null,
  });
  const claims = [{ line_item_id: BURGER, user_id: ANA, parts: 1 }];
  if ((opts.claimed ?? 'all') === 'all') claims.push({ line_item_id: FRIES, user_id: BEN, parts: 1 });
  return {
    bill: {
      id: BILL,
      host_id: hostId,
      payer_id: hostId,
      join_code: CODE,
      created_at: '2026-11-20T19:00:00.000Z',
      edited_at: null,
      extras_split: 'proportional',
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 2100,
    },
    rows: [row(BURGER, 'Burger', 0, 1500), row(FRIES, 'Fries', 1, 600)],
    participants,
    claims,
    payers: [],
    payments: [],
    flags: [],
  };
}

/** The members of Tahoe trip (W1: Ana, Ben, Cy, Dee), optionally with more. */
function tahoeSnapshot(extra: string[] = []) {
  const s = snapshotOf(W1.input);
  return {
    ...s,
    members: [...s.members, ...extra.map((userId) => ({ userId, displayName: NAMES[userId] ?? null, venmoUsername: null, joinedAt: '2026-11-21T12:00:00.000Z' }))],
  };
}

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function BillStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill stand-in ${id}`}</Text>;
}
function GroupStandIn() {
  const { id, invite } = useLocalSearchParams<{ id: string; invite?: string }>();
  return <Text>{`Group stand-in ${id} ${invite ?? ''}`}</Text>;
}
function NewGroupStandIn() {
  return <Text>New group stand-in</Text>;
}
function ScanStandIn() {
  return <Text>Scan stand-in</Text>;
}
function HomeStandIn() {
  return <Text>Home stand-in</Text>;
}

const ROUTES = {
  appDir: './app',
  overrides: {
    '(app)/bills/[id]/index': BillStandIn,
    '(app)/groups/[id]/index': GroupStandIn,
    '(app)/groups/new': NewGroupStandIn,
    '(app)/scan': ScanStandIn,
    '(app)/(tabs)/index': HomeStandIn,
  },
};

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};

async function openScreen() {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/group` });
  await screen.findByRole('header', { name: /Add to a group|This bill is in/ });
  return router;
}

const addButton = (name = GROUP_NAME) => screen.queryByRole('button', { name: `Add to ${name}` });

beforeEach(() => {
  jest.clearAllMocks();
  clearGroupReceipt();
  signInAs(ANA);
  fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN)]) });
  listMyGroups.mockResolvedValue({ ok: true, groups: [tahoe] });
  fetchBillGroup.mockResolvedValue({ ok: true, group: null });
  fetchSnapshot.mockResolvedValue({ ok: true, snapshot: tahoeSnapshot() });
  attach.mockResolvedValue(done);
  detach.mockResolvedValue(done);
});

describe.each(['ios', 'web'] as const)('Add to a group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('81: a bill with a non-member shows "Invite Sam to Tahoe trip first" and no button; Invite people opens the group with its invite', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(SAM, true), member(BEN)]) });
    const router = await openScreen();
    // Positive control: the only group is chosen and its members were read.
    expect(await screen.findByText('Invite Sam to Tahoe trip first.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(fetchSnapshot).toHaveBeenCalledWith(GROUP_ID);
    expect(addButton()).toBeNull();
    // The conversion line waits until the attach is possible.
    expect(screen.queryByText(/will become/)).toBeNull();
    await press(screen.getByRole('button', { name: 'Invite people' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    expect(await screen.findByText(`Group stand-in ${GROUP_ID} 1`)).toBeTruthy();
  });

  it('81: back from inviting, the members are read again and the button appears once Sam is in', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(SAM)]) });
    await openScreen();
    await screen.findByText('Invite Sam to Tahoe trip first.');
    await press(screen.getByRole('button', { name: 'Invite people' }));
    await screen.findByText(`Group stand-in ${GROUP_ID} 1`);
    fetchSnapshot.mockResolvedValue({ ok: true, snapshot: tahoeSnapshot([SAM]) });
    await act(async () => appRouter.back());
    expect(await screen.findByRole('button', { name: 'Add to Tahoe trip' })).toBeTruthy();
    expect(screen.queryByText('Invite Sam to Tahoe trip first.')).toBeNull();
  });

  it('81: with marks, the confirm names each marked person; Add attaches once (double tap) and lands on the bill', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN, true)]) });
    let release: (r: GroupResult) => void = () => undefined;
    attach.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const router = await openScreen();
    expect(await screen.findByText('Ben\'s "I paid" will become a Tahoe trip payment.')).toBeTruthy();
    const button = await screen.findByRole('button', { name: 'Add to Tahoe trip' });
    // Both taps land before React re-renders the button as busy: only the ref guard stops the second.
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(BILL, GROUP_ID);
    // Saving: the choice and Back are locked.
    expect(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole('button', { name: 'Back' }).props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => release(done));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await screen.findByText(`Bill stand-in ${BILL}`)).toBeTruthy();
  });

  it('R2-N1 (A1 S1b): marks on a bill that isn\'t fully claimed say "Finish claiming…" up front, with no button', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN, true)], ANA, { claimed: 'burger' }) });
    await openScreen();
    // Positive control: the members were read and the group is chosen.
    expect(await screen.findByText('Finish claiming before moving it into the group.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(addButton()).toBeNull();
    expect(screen.queryByText(/will become/)).toBeNull();
    expect(attach).not.toHaveBeenCalled();
  });

  it('R2-N1 (A1 S1b): marks on an all-$0 bill are warned too; the same bill without marks can move in', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN, true)], ANA, { zero: true }) });
    await openScreen();
    expect(await screen.findByText('Finish claiming before moving it into the group.')).toBeTruthy();
    expect(addButton()).toBeNull();
  });

  it('R2-N1: no marks on an incomplete bill: the button shows (the DB allows it)', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN)], ANA, { claimed: 'burger' }) });
    await openScreen();
    expect(await screen.findByRole('button', { name: 'Add to Tahoe trip' })).toBeTruthy();
    expect(screen.queryByText('Finish claiming before moving it into the group.')).toBeNull();
  });

  it('with no marks there is no conversion line', async () => {
    await openScreen();
    expect(await screen.findByRole('button', { name: 'Add to Tahoe trip' })).toBeTruthy();
    expect(screen.queryByText(/will become/)).toBeNull();
  });

  it('two groups: nothing is chosen until the host picks one; then that group is checked', async () => {
    listMyGroups.mockResolvedValue({ ok: true, groups: [tahoe, ski] });
    fetchSnapshot.mockImplementation(async (gid) => ({ ok: true, snapshot: { ...tahoeSnapshot(), group: { ...tahoeSnapshot().group, id: gid } } }));
    await openScreen();
    const skiRow = screen.getByRole('radio', { name: 'Ski weekend, 2 people' });
    expect(skiRow.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }).props.accessibilityState).toMatchObject({ checked: false });
    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(addButton()).toBeNull();
    await press(skiRow);
    expect(await screen.findByRole('button', { name: 'Add to Ski weekend' })).toBeTruthy();
    expect(fetchSnapshot).toHaveBeenCalledWith(SKI_ID);
    await press(screen.getByRole('button', { name: 'Add to Ski weekend' }));
    expect(attach).toHaveBeenCalledWith(BILL, SKI_ID);
  });

  it('S1b: not_complete shows its copy, keeps the choice and re-enables; Try again (same group) succeeds', async () => {
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN, true)]) });
    attach.mockResolvedValueOnce(fail('not_complete'));
    const router = await openScreen();
    const button = await screen.findByRole('button', { name: 'Add to Tahoe trip' });
    await press(button);
    expect(await screen.findByText('Finish claiming before moving it into the group.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }).props.accessibilityState).toMatchObject({ checked: true, disabled: false });
    expect(screen.getByRole('button', { name: 'Add to Tahoe trip' }).props.accessibilityState?.disabled).not.toBe(true);
    await press(screen.getByRole('button', { name: 'Add to Tahoe trip' }));
    expect(attach).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('A1.6: a lost reply says "Couldn\'t add it to Tahoe trip. Try again."; the retry to the same group is a success', async () => {
    attach.mockResolvedValueOnce(fail('network'));
    const router = await openScreen();
    await press(await screen.findByRole('button', { name: 'Add to Tahoe trip' }));
    expect(await screen.findByText("Couldn't add it to Tahoe trip. Try again.")).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Add to Tahoe trip' }));
    expect(attach.mock.calls).toEqual([
      [BILL, GROUP_ID],
      [BILL, GROUP_ID],
    ]);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('participants_not_members: says so, and reads the bill and members again (now showing who to invite)', async () => {
    attach.mockResolvedValueOnce(fail('participants_not_members'));
    await openScreen();
    const button = await screen.findByRole('button', { name: 'Add to Tahoe trip' });
    // Sam joined the bill meanwhile.
    fetchBill.mockResolvedValue({ ok: true, ...billData([member(ANA), member(BEN), member(SAM)]) });
    await press(button);
    expect(await screen.findByText('Invite Sam to Tahoe trip first.')).toBeTruthy();
    expect(screen.getByText('Everyone on the bill has to be in the group first.')).toBeTruthy();
    expect(fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(addButton()).toBeNull();
  });

  it('already_in_group: reloads, and the screen then says which group it is in', async () => {
    attach.mockResolvedValueOnce(fail('already_in_group'));
    await openScreen();
    fetchBillGroup.mockResolvedValue({ ok: true, group: { groupId: SKI_ID, name: 'Ski weekend' } });
    await press(await screen.findByRole('button', { name: 'Add to Tahoe trip' }));
    expect(await screen.findByRole('header', { name: 'This bill is in Ski weekend.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take out of Ski weekend' })).toBeTruthy();
  });

  it('split_paying (who-paid B5f): says the bill has more than one payer, in fixed copy, and keeps the choice', async () => {
    attach.mockResolvedValueOnce(fail('split_paying'));
    await openScreen();
    await press(await screen.findByRole('button', { name: 'Add to Tahoe trip' }));
    expect(await screen.findByText('This bill has more than one payer. Groups need one payer per bill.')).toBeTruthy();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(addButton()).toBeTruthy();
  });

  it('a failed member check says so with a retry', async () => {
    fetchSnapshot.mockResolvedValueOnce(fail('network'));
    await openScreen();
    expect(await screen.findByText("Couldn't check who's in Tahoe trip.")).toBeTruthy();
    expect(addButton()).toBeNull();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add to Tahoe trip' })).toBeTruthy();
  });

  it('no groups: says so and offers Start a group', async () => {
    listMyGroups.mockResolvedValue({ ok: true, groups: [] });
    const router = await openScreen();
    expect(screen.getByText("You're not in any groups yet.")).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    await press(screen.getByRole('button', { name: 'Start a group' }));
    await waitFor(() => expect(router.getPathname()).toBe('/groups/new'));
  });

  it('a failed load says so; Try again loads', async () => {
    listMyGroups.mockResolvedValueOnce(fail('network'));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/group` });
    expect(await screen.findByText("Couldn't load your groups.")).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add to Tahoe trip' })).toBeTruthy();
  });

  it('a bill the viewer can\'t see: the fixed not-found copy and Go home', async () => {
    fetchBillGroup.mockResolvedValue(fail('not_allowed'));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/group` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go home' })).toBeTruthy();
  });

  it('not the host: says who can, and offers no choices', async () => {
    signInAs(BEN);
    await openScreen();
    expect(screen.getByText('Only Ana can move this bill into a group.')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('every control has a role and a name; Back from a cold link opens the bill', async () => {
    listMyGroups.mockResolvedValue({ ok: true, groups: [tahoe, ski] });
    const router = await openScreen();
    await press(screen.getByRole('radio', { name: 'Tahoe trip, 4 people' }));
    await screen.findByRole('button', { name: 'Add to Tahoe trip' });
    const controls = screen.UNSAFE_root.findAll(
      (n) => typeof n.type === 'string' && ['button', 'link', 'radio'].includes(n.props.accessibilityRole as string),
    );
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const c of controls) {
      const label = c.props.accessibilityLabel;
      const text = within(c).queryAllByText(/\S/);
      expect(typeof label === 'string' ? label.trim().length > 0 : text.length > 0).toBe(true);
    }
    await press(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });
});

describe.each(['ios', 'web'] as const)('Take out of a group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    fetchBillGroup.mockResolvedValue({ ok: true, group: { groupId: GROUP_ID, name: GROUP_NAME } });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the host sees why and one Take out; has_bill_payments says what to undo; then it works', async () => {
    detach.mockResolvedValueOnce(fail('has_bill_payments'));
    const router = await openScreen();
    expect(screen.getByRole('header', { name: 'This bill is in Tahoe trip.' })).toBeTruthy();
    expect(screen.getByText("It will stop counting in the group's balances. Everyone stays on the bill.")).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    await press(screen.getByRole('button', { name: 'Take out of Tahoe trip' }));
    expect(await screen.findByText('Undo the payments that came from this bill\'s "I paid" marks first.')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Take out of Tahoe trip' }));
    expect(detach).toHaveBeenCalledTimes(2);
    expect(detach).toHaveBeenCalledWith(BILL);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('a lost reply names the group and keeps the button', async () => {
    detach.mockResolvedValueOnce(fail('network'));
    await openScreen();
    await press(screen.getByRole('button', { name: 'Take out of Tahoe trip' }));
    expect(await screen.findByText("Couldn't take it out of Tahoe trip. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take out of Tahoe trip' }).props.accessibilityState?.disabled).not.toBe(true);
  });

  it('not the host: says who can, no button', async () => {
    signInAs(BEN);
    await openScreen();
    expect(screen.getByText('Only Ana can take it out of Tahoe trip.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take out/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The bill form from a group (criterion 82)
// ---------------------------------------------------------------------------

function enterOneItem() {
  fireEvent.press(screen.getByText('Add item'));
  fireEvent.changeText(screen.getByLabelText('Item 1 name'), 'Burger');
  fireEvent.changeText(screen.getByLabelText('Item 1 price'), '15.00');
  fireEvent.changeText(screen.getByLabelText('Total'), '15.00');
}

describe.each(['ios', 'web'] as const)('a receipt from a group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    createBill.mockResolvedValue({ ok: true, billId: BILL, joinCode: CODE });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The way the app gets there: the group screen (a stand-in here), Scan, then Enter items. */
  async function openForm(from = `/groups/${GROUP_ID}`) {
    const router = renderRouter(ROUTES, { initialUrl: from });
    await screen.findByText(/stand-in/);
    await act(async () => appRouter.push('/scan'));
    await screen.findByText('Scan stand-in');
    await act(async () => appRouter.push('/bill'));
    await screen.findByRole('header', { name: 'Enter the items' });
    return router;
  }

  it('82: says which group, then saves with two calls (create, then attach) and lands on the bill', async () => {
    setScanGroup({ groupId: GROUP_ID, name: GROUP_NAME });
    const router = await openForm();
    expect(screen.getByText('Goes in Tahoe trip')).toBeTruthy();
    enterOneItem();
    const save = screen.getByRole('button', { name: 'Save and share' });
    expect(save.props.accessibilityHint).toBe('Saves the bill and adds it to Tahoe trip.');
    await press(save);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(createBill).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(BILL, GROUP_ID);
    expect(createBill.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0] ?? 0);
    expect(getScanGroup()).toBeNull();
    expect(getAttachFailure(BILL)).toBeNull();
  });

  it('82: a failed attach still opens the bill, and leaves the failure for the bill screen\'s retry', async () => {
    setScanGroup({ groupId: GROUP_ID, name: GROUP_NAME });
    attach.mockResolvedValueOnce(fail('network'));
    const router = await openForm();
    enterOneItem();
    await press(screen.getByRole('button', { name: 'Save and share' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(getAttachFailure(BILL)).toEqual({ billId: BILL, groupId: GROUP_ID, groupName: GROUP_NAME });
    expect(getScanGroup()).toBeNull();
  });

  it('a failed create attaches nothing and keeps the group for the retry', async () => {
    setScanGroup({ groupId: GROUP_ID, name: GROUP_NAME });
    createBill.mockResolvedValueOnce({ ok: false, error: 'network' });
    await openForm();
    enterOneItem();
    await press(screen.getByRole('button', { name: 'Save and share' }));
    expect(await screen.findByText("Couldn't save the bill. Check your connection and try again.")).toBeTruthy();
    expect(attach).not.toHaveBeenCalled();
    expect(getScanGroup()).toEqual({ groupId: GROUP_ID, name: GROUP_NAME });
  });

  it('GR-6: a stored group doesn\'t apply when the form wasn\'t opened from that group (Home below), and is dropped', async () => {
    setScanGroup({ groupId: GROUP_ID, name: GROUP_NAME });
    const router = await openForm('/');
    expect(screen.getByText('Type each line from the receipt. We check the totals as you go.')).toBeTruthy();
    expect(screen.queryByText(/^Goes in/)).toBeNull();
    expect(getScanGroup()).toBeNull();
    enterOneItem();
    expect(screen.getByRole('button', { name: 'Save and share' }).props.accessibilityHint).toBe('Saves the bill and gets a link to send to your friends.');
    await press(screen.getByRole('button', { name: 'Save and share' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(attach).not.toHaveBeenCalled();
  });

  it('without a group: no line and no attach (the bill form as before)', async () => {
    const router = await openForm();
    // Positive control: the header text is there.
    expect(screen.getByText('Type each line from the receipt. We check the totals as you go.')).toBeTruthy();
    expect(screen.queryByText(/^Goes in/)).toBeNull();
    enterOneItem();
    await press(screen.getByRole('button', { name: 'Save and share' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(attach).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// /b/<code> of a group bill (criterion 111, A1 S7)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('a group bill\'s link opened by a non-member (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('111: shows "This bill is in a group. Ask for the group\'s link." with Go home and no retry', async () => {
    // The real join_bill wrapper maps the T5 trigger's 22023 in_group (lib/bills.ts, part 2).
    const actual = jest.requireActual<typeof import('@/lib/bills')>('@/lib/bills');
    joinBill.mockImplementation(actual.joinBill);
    supabase.__setRpc((fn) =>
      fn === 'join_bill' ? { data: null, error: { code: '22023', message: 'in_group' } } : { data: null, error: null },
    );
    renderRouter(ROUTES, { initialUrl: `/b/${CODE}` });
    expect(await screen.findByText("This bill is in a group. Ask for the group's link.")).toBeTruthy();
    expect(joinBill).toHaveBeenCalledWith(CODE);
    expect(supabase.rpc).toHaveBeenCalledWith('join_bill', { p_code: CODE });
    expect(screen.getByRole('button', { name: 'Go home' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('any other failure still offers Try again', async () => {
    joinBill.mockResolvedValue({ ok: false, error: 'network' });
    renderRouter(ROUTES, { initialUrl: `/b/${CODE}` });
    expect(await screen.findByText("Couldn't join. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

// Review R2-N1: what the browser gets. react-native-web 0.21 drops accessibilityState, so the radio
// rows also pass aria-* (lib/ariaProps.ts). Rendered through react-native-web to static HTML, as in
// __tests__/uiPrimitives.test.tsx.
describe('group choice rows on web (react-native-web markup)', () => {
  function webTag(props: { checked: boolean; disabled: boolean }): string {
    let html = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => jest.requireActual('react-native-web'));
      // lucide's native SVG doesn't render under react-dom; icons aren't what's checked here.
      jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
      const React = jest.requireActual<typeof import('react')>('react');
      // @types/react-dom isn't installed; this is the one function used.
      const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: React.ReactElement) => string }>('react-dom/server');
      const { GroupChoiceRow } = jest.requireActual<typeof import('@/components/GroupChoiceRow')>('@/components/GroupChoiceRow');
      html = renderToStaticMarkup(
        React.createElement(GroupChoiceRow, { name: GROUP_NAME, caption: '4 people', divider: false, onPick: () => {}, ...props }),
      );
    });
    const found = html.match(/<[a-z]+ [^>]*aria-label="Tahoe trip, 4 people"[^>]*>/g) ?? [];
    expect(found).toHaveLength(1);
    return found[0] ?? '';
  }

  it.each([
    { checked: true, disabled: false },
    { checked: false, disabled: false },
    { checked: false, disabled: true },
  ])('a radio with aria-checked and aria-disabled (%o)', ({ checked, disabled }) => {
    const tag = webTag({ checked, disabled });
    expect(tag).toContain('role="radio"');
    expect(tag).toContain(`aria-checked="${String(checked)}"`);
    // react-native-web leaves out aria-disabled="false"; the tag itself (with aria-checked) is the positive control.
    if (disabled) expect(tag).toContain('aria-disabled="true"');
    else expect(tag).not.toContain('aria-disabled="true"');
  });
});
