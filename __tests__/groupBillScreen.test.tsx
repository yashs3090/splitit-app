// Bills in groups, part 2 (spec docs/specs/2026-11-26-groups-mvp.md T17 criteria 80, 82, 111 and
// T18 criteria 84–86, as amended by A1 S7): the bill screen, Settle up and Add people on a group
// bill, the failed attach's Try again, and "Who had this?" in the item sheet.
// Everything runs through the real data layer (lib/bills.ts, lib/groups.ts) against the fake
// Supabase, so the group read (bills.group_id, then groups), my_groups, attach_bill_to_group and
// assign_item are the real wrappers. Every entry is a cold deep link; iOS and web both run.
//
// The bill: Burger $15.00 (Ana), Fries $6.00 (Ana and Ben), total $21.00, host and payer Ana.
// People: Ana, Ben, Cy (all members of Tahoe trip on a group bill). The viewer is Ben unless set.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { router as appRouter, useLocalSearchParams } from 'expo-router';
import { Platform, Text } from 'react-native';

import { clearGroupReceipt, getAttachFailure, setAttachFailure } from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase, type RecordedQuery } from '@/test-utils/fakes';

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
const GROUP = '9a000000-0000-4000-8000-000000000001';
const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const CY = 'cccccccc-0000-4000-8000-000000000003';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';

type Claim = { line_item_id: string; user_id: string; parts: number };

/** What the fake server holds. `groupId` is bills.group_id; `groupRead` can hold or fail that read. */
const db: {
  groupId: string | null;
  claims: Claim[];
  groupRead: 'ok' | 'fail' | Promise<void>;
  myGroups: number;
} = { groupId: null, claims: [], groupRead: 'ok', myGroups: 0 };

const ok = (data: unknown): FakeResult => ({ data, error: null });
const failure = (code: string, message: string): FakeResult => ({ data: null, error: { code, message } });

function billRow() {
  return {
    id: BILL,
    host_id: ANA,
    payer_id: ANA,
    subtotal_cents: null,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 2100,
    join_code: '0123456789abcdef0123',
    created_at: '2026-11-20T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
}

function itemRow(id: string, name: string, cents: number, position: number) {
  return {
    id,
    name,
    note: null,
    group_position: position,
    unit_index: 0,
    group_size: 1,
    total_cents: cents,
    split_set_by: null,
    split_set_at: null,
    kind: 'item',
    applies_to: null,
  };
}

function person(userId: string, name: string, minute: number) {
  return {
    user_id: userId,
    joined_at: `2026-11-20T19:0${minute}:00Z`,
    settled_at: null,
    settled_cents: null,
    settled_method: null,
    not_received_cents: null,
    not_received_method: null,
    not_received_by: null,
    profile: { display_name: name, venmo_username: `${name.toLowerCase()}-venmo` },
  };
}

const selects = (q: RecordedQuery, columns: string) => q.calls.some((c) => c.method === 'select' && c.args[0] === columns);
const groupReads = () => supabase.__queries.filter((q) => q.table === 'groups').length;
const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

function installServer() {
  supabase.__setTable('bills', async (q) => {
    // lib/groups.ts fetchBillGroup reads only bills.group_id; fetchBill reads the bill's columns.
    if (selects(q, 'group_id')) {
      const read = db.groupRead;
      if (read === 'fail') return failure('08006', 'server text: connection lost');
      if (read !== 'ok') await read;
      return ok({ group_id: db.groupId });
    }
    return ok(billRow());
  });
  supabase.__setTable('groups', () => ok({ id: GROUP, name: 'Tahoe trip' }));
  supabase.__setTable('line_items', () => ok([itemRow(BURGER, 'Burger', 1500, 0), itemRow(FRIES, 'Fries', 600, 1)]));
  supabase.__setTable('bill_participants', () => ok([person(ANA, 'Ana', 0), person(BEN, 'Ben', 1), person(CY, 'Cy', 2)]));
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  supabase.__setRpc((fn) => {
    if (fn === 'my_groups') {
      return ok(
        Array.from({ length: db.myGroups }, (_, i) => ({
          id: `9b000000-0000-4000-8000-00000000000${i}`,
          name: `Group ${i}`,
          member_count: 3,
          joined_at: '2026-11-20T12:00:00.000Z',
          hidden: false,
        })),
      );
    }
    return ok(null);
  });
}

function signInAs(userId: string) {
  const session = fakeSession('Someone');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function GroupStandIn() {
  const { id, invite } = useLocalSearchParams<{ id: string; invite?: string }>();
  return <Text>{`Group stand-in ${id} ${invite ?? ''}`.trim()}</Text>;
}
function BillGroupStandIn() {
  return <Text>Bill group stand-in</Text>;
}

const ROUTES = {
  appDir: './app',
  overrides: {
    '(app)/groups/[id]/index': GroupStandIn,
    '(app)/bills/[id]/group': BillGroupStandIn,
  },
};

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};

async function openBill() {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
  // Positive control for every absence check below: the items and the shares are on screen.
  await screen.findByText('Total $21.00');
  expect(screen.getByLabelText(/^Burger, \$15\.00, /)).toBeTruthy();
  return router;
}

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  clearGroupReceipt();
  db.groupId = GROUP;
  db.groupRead = 'ok';
  db.myGroups = 1;
  db.claims = [
    { line_item_id: BURGER, user_id: ANA, parts: 1 },
    { line_item_id: FRIES, user_id: ANA, parts: 1 },
    { line_item_id: FRIES, user_id: BEN, parts: 1 },
  ];
  installServer();
  signInAs(BEN);
});

describe.each(['ios', 'web'] as const)('a group bill (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('80/111: "In Tahoe trip" under the title; no invite card, Pay, I paid, Settle up or Leave; the footer says "Settled in Tahoe trip"', async () => {
    await openBill();
    expect(await screen.findByRole('link', { name: 'In Tahoe trip' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invite people to Tahoe trip' })).toBeTruthy();
    // Positive controls next to the absences: the item list (openBill) and the claim controls.
    expect(screen.getByLabelText('Claim Burger')).toBeTruthy();
    expect(screen.queryByText('Copy link')).toBeNull();
    expect(screen.queryByText('Add people')).toBeNull();
    expect(screen.queryByText('Leave this bill')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settle up' })).toBeNull();
    expect(screen.queryByText(/on Venmo/)).toBeNull();
    expect(screen.queryByText(/I paid/)).toBeNull();
    expect(screen.queryByText('Take out')).toBeNull(); // Ben isn't the host
  });

  it('the links open the group, and the invite opens it with its invite panel', async () => {
    const router = await openBill();
    await press(await screen.findByRole('link', { name: 'Settled in Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP}`)).toBeTruthy();
    act(() => appRouter.back());
    await press(await screen.findByRole('button', { name: 'Invite people to Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP} 1`)).toBeTruthy();
    expect(router.getSearchParams()).toEqual({ id: GROUP, invite: '1' });
    act(() => appRouter.back());
    await press(await screen.findByRole('link', { name: 'In Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP}`)).toBeTruthy();
  });

  it('111: the host gets Take out but no Add people (the people come from the group)', async () => {
    signInAs(ANA);
    const router = await openBill();
    expect(await screen.findByRole('button', { name: 'Take out of Tahoe trip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit items' })).toBeTruthy();
    expect(screen.queryByText('Add people')).toBeNull();
    expect(screen.queryByText('Copy link')).toBeNull();
    // A bill already in a group needs no my_groups read.
    expect(rpcCalls('my_groups')).toHaveLength(0);
    await press(screen.getByRole('button', { name: 'Take out of Tahoe trip' }));
    expect(await screen.findByText('Bill group stand-in')).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL}/group`);
  });

  it('waits for the group read before showing anything, so Pay never shows first', async () => {
    let release = () => {};
    db.groupRead = new Promise<void>((r) => (release = r));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await waitFor(() => expect(supabase.__queries.some((q) => q.table === 'line_items')).toBe(true));
    expect(screen.queryByText('Total $21.00')).toBeNull();
    expect(screen.queryByText(/on Venmo|Settle up/)).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole('link', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(screen.queryByText(/on Venmo/)).toBeNull();
  });

  it('GR-T17-17: a failed group read shows no Pay, invite card or Leave; claiming stays; Try again re-reads', async () => {
    db.groupId = null;
    db.groupRead = 'fail';
    signInAs(CY);
    await openBill();
    expect(await screen.findByText("Couldn't check this bill's group. Try again.")).toBeTruthy();
    expect(screen.getByLabelText('Claim Burger')).toBeTruthy();
    expect(screen.queryByText(/on Venmo|I paid/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settle up' })).toBeNull();
    expect(screen.queryByText('Copy link')).toBeNull();
    expect(screen.queryByText('Leave this bill')).toBeNull();
    expect(screen.queryByRole('link', { name: 'In Tahoe trip' })).toBeNull();
    // Claiming is still available (a bill in no group: set_claim).
    await press(screen.getByLabelText('Claim Burger'));
    await waitFor(() => expect(rpcCalls('set_claim')).toHaveLength(1));
    // Try again: the read now says "no group", so the bill's own footer and invite card come back.
    db.groupRead = 'ok';
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Copy link')).toBeTruthy();
    expect(screen.getByText(/on Venmo|Settle up/)).toBeTruthy();
    expect(screen.queryByText("Couldn't check this bill's group. Try again.")).toBeNull();
  });

  it('T18: the row\'s own claim goes through assign_item with the server\'s map (one way to claim)', async () => {
    signInAs(CY);
    await openBill();
    await screen.findByRole('link', { name: 'Settled in Tahoe trip' });
    await press(screen.getByLabelText('Claim Fries'));
    await waitFor(() => expect(rpcCalls('assign_item')).toHaveLength(1));
    expect(rpcCalls('assign_item')[0]).toEqual([
      'assign_item',
      { p_line_item_id: FRIES, p_parts: { [ANA]: 1, [BEN]: 1, [CY]: 1 }, p_expected: { [ANA]: 1, [BEN]: 1 } },
    ]);
    expect(rpcCalls('set_claim')).toHaveLength(0);
  });

  it('T18: a row claim refused with claims_changed says so and re-reads the bill', async () => {
    signInAs(CY);
    supabase.__setRpc((fn) => (fn === 'assign_item' ? failure('22023', 'claims_changed') : ok(null)));
    await openBill();
    await screen.findByRole('link', { name: 'Settled in Tahoe trip' });
    const claimReads = () => supabase.__queries.filter((q) => q.table === 'claims').length;
    const before = claimReads();
    await press(screen.getByLabelText('Claim Fries'));
    expect(await screen.findByText('Someone changed this item. Check and try again.')).toBeTruthy();
    await waitFor(() => expect(claimReads()).toBeGreaterThan(before));
    // Rolled back: still offered.
    expect(screen.getByLabelText('Claim Fries')).toBeTruthy();
  });

  it('T18: while the row\'s own claim is in flight, the sheet still shows the server\'s claimers and chips', async () => {
    signInAs(CY);
    let land = () => {};
    supabase.__setRpc((fn) =>
      fn === 'assign_item' ? new Promise<FakeResult>((r) => (land = () => r(failure('08006', 'server text')))) : ok(null),
    );
    await openBill();
    await screen.findByRole('link', { name: 'Settled in Tahoe trip' });
    await press(screen.getByLabelText('Claim Fries'));
    // The row shows the optimistic claim...
    expect(await screen.findByLabelText('Unclaim Fries')).toBeTruthy();
    fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
    expect(await screen.findByText('Who had this?')).toBeTruthy();
    // ...the sheet doesn't: Ana and Ben at $3.00, and Cy's chip unchecked (the map sent as p_expected).
    expect(screen.getByLabelText('Ana $3.00')).toBeTruthy();
    expect(screen.getByLabelText('Ben $3.00')).toBeTruthy();
    expect(screen.queryByLabelText(/^You \$/)).toBeNull();
    expect(screen.getByRole('checkbox', { name: "You didn't have this" })).toBeTruthy();
    await act(async () => land());
  });

  it('84/86: the sheet shows "Who had this?"; tapping Cy sends assign_item(row, current + Cy, current) once, busy until the refetch lands', async () => {
    await openBill();
    await screen.findByRole('link', { name: 'Settled in Tahoe trip' });
    fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
    expect(await screen.findByText('Who had this?')).toBeTruthy();
    // The claimers list is the server's: Ana and Ben, $3.00 each.
    expect(screen.getByLabelText('You $3.00')).toBeTruthy();
    expect(screen.getByLabelText('Ana $3.00')).toBeTruthy();
    const cy = screen.getByRole('checkbox', { name: "Cy, didn't have this" });
    expect(cy.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByRole('checkbox', { name: 'Ana, had this' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByRole('checkbox', { name: 'You had this' })).toBeTruthy();

    let land = () => {};
    supabase.__setRpc((fn) => {
      if (fn !== 'assign_item') return ok(null);
      return new Promise<FakeResult>((r) => {
        land = () => {
          db.claims = [...db.claims, { line_item_id: FRIES, user_id: CY, parts: 1 }];
          r(ok(null));
        };
      });
    });
    await press(cy);
    expect(rpcCalls('assign_item')).toEqual([
      ['assign_item', { p_line_item_id: FRIES, p_parts: { [ANA]: 1, [BEN]: 1, [CY]: 1 }, p_expected: { [ANA]: 1, [BEN]: 1 } }],
    ]);
    // Busy: a second tap sends nothing.
    await press(screen.getByRole('checkbox', { name: "Cy, didn't have this" }));
    expect(rpcCalls('assign_item')).toHaveLength(1);
    await act(async () => land());
    expect(await screen.findByRole('checkbox', { name: 'Cy, had this' })).toBeTruthy();
    expect(screen.getByLabelText('Cy $2.00')).toBeTruthy();
    expect(rpcCalls('assign_item')).toHaveLength(1);
  });
});

describe.each(['ios', 'web'] as const)('Settle up and Add people on a group bill (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('80: Settle up shows one "Settled in Tahoe trip" card linking to the group, and nothing to pay or request', async () => {
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByRole('header', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Settle up' })).toBeTruthy();
    expect(screen.queryByText(/on Venmo/)).toBeNull();
    expect(screen.queryByText(/I paid/)).toBeNull();
    expect(screen.queryByText(/Request/)).toBeNull();
    expect(screen.queryByText('Ana paid the bill')).toBeNull();
    await press(screen.getByRole('button', { name: 'Open Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP}`)).toBeTruthy();
  });

  it('111: Add people on a group bill says where the people come from, with no Add or Remove', async () => {
    signInAs(ANA);
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText('Everyone in Tahoe trip is on this bill. To add someone, invite them to the group.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
    await press(screen.getByRole('button', { name: 'Open Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP}`)).toBeTruthy();
  });

  it('signed out, a cold link to a group bill goes to sign-in with no group read', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(groupReads()).toBe(0);
    expect(supabase.__queries.some((q) => q.table === 'bills')).toBe(false);
  });
});

describe.each(['ios', 'web'] as const)('a bill in no group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.groupId = null;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('85: renders as before: the invite card, Pay or Settle up, Leave for a guest; the sheet has no chips', async () => {
    signInAs(CY);
    await openBill();
    expect(await screen.findByText('Copy link')).toBeTruthy();
    expect(screen.getByText('Leave this bill')).toBeTruthy();
    expect(screen.getByText(/on Venmo|Settle up/)).toBeTruthy();
    expect(screen.queryByText(/Settled in/)).toBeNull();
    expect(screen.queryByText('Move to a group')).toBeNull(); // Cy isn't the host
    fireEvent.press(screen.getByLabelText(/^Fries, \$6\.00, /));
    expect(await screen.findByLabelText('Ana $3.00')).toBeTruthy();
    expect(screen.queryByText('Who had this?')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(rpcCalls('my_groups')).toHaveLength(0);
  });

  it('GR-T17-12: the host sees "Move to a group" only when in at least one group (one my_groups read)', async () => {
    signInAs(ANA);
    const router = await openBill();
    expect(await screen.findByRole('button', { name: 'Move to a group' })).toBeTruthy();
    expect(rpcCalls('my_groups')).toHaveLength(1);
    await press(screen.getByRole('button', { name: 'Move to a group' }));
    expect(router.getPathname()).toBe(`/bills/${BILL}/group`);
  });

  it('GR-T17-12: a host in no group sees no "Move to a group"', async () => {
    signInAs(ANA);
    db.myGroups = 0;
    await openBill();
    await waitFor(() => expect(rpcCalls('my_groups')).toHaveLength(1));
    await act(async () => {});
    expect(screen.getByText('Copy link')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move to a group' })).toBeNull();
  });
});

describe.each(['ios', 'web'] as const)('82: the bill form\'s attach failed (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.groupId = null;
    signInAs(ANA);
    setAttachFailure({ billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const tryAgain = () => screen.getByRole('button', { name: 'Try again' });

  it('shows the error with Try again, which attaches, stays busy until the re-read, then shows the group', async () => {
    await openBill();
    expect(await screen.findByText("Couldn't add it to Tahoe trip. Try again.")).toBeTruthy();
    let release = () => {};
    supabase.__setRpc((fn) => {
      if (fn === 'attach_bill_to_group') {
        db.groupId = GROUP;
        db.groupRead = new Promise<void>((r) => (release = r));
      }
      return ok(fn === 'my_groups' ? [] : null);
    });
    await press(tryAgain());
    expect(rpcCalls('attach_bill_to_group')).toEqual([['attach_bill_to_group', { p_bill_id: BILL, p_group_id: GROUP }]]);
    await waitFor(() => expect(tryAgain().props.accessibilityState).toMatchObject({ busy: true }));
    // A second tap while busy sends nothing.
    await press(tryAgain());
    expect(rpcCalls('attach_bill_to_group')).toHaveLength(1);
    await act(async () => release());
    expect(await screen.findByRole('link', { name: 'In Tahoe trip' })).toBeTruthy();
    expect(screen.queryByText("Couldn't add it to Tahoe trip. Try again.")).toBeNull();
    expect(screen.getByRole('link', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(getAttachFailure(BILL)).toBeNull();
  });

  it('a failed attach keeps the line and re-enables Try again', async () => {
    supabase.__setRpc((fn) => (fn === 'attach_bill_to_group' ? failure('08006', 'server text') : ok(fn === 'my_groups' ? [] : null)));
    await openBill();
    await screen.findByText("Couldn't add it to Tahoe trip. Try again.");
    await press(tryAgain());
    await waitFor(() => expect(rpcCalls('attach_bill_to_group')).toHaveLength(1));
    await waitFor(() => expect(tryAgain().props.accessibilityState).not.toMatchObject({ busy: true }));
    expect(screen.getByText("Couldn't add it to Tahoe trip. Try again.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    expect(getAttachFailure(BILL)).not.toBeNull();
  });

  it('a refused attach says why, in fixed copy', async () => {
    supabase.__setRpc((fn) =>
      fn === 'attach_bill_to_group' ? failure('22023', 'participants_not_members') : ok(fn === 'my_groups' ? [] : null),
    );
    await openBill();
    await screen.findByText("Couldn't add it to Tahoe trip. Try again.");
    await press(tryAgain());
    expect(await screen.findByText('Everyone on the bill has to be in the group first.')).toBeTruthy();
  });

  it('the attach worked but the re-read failed: Try again is enabled again (a second attach is a no-op success)', async () => {
    let attaches = 0;
    supabase.__setRpc((fn) => {
      // Only the first attach's re-read fails.
      if (fn === 'attach_bill_to_group' && ++attaches === 1) db.groupRead = 'fail';
      return ok(fn === 'my_groups' ? [] : null);
    });
    await openBill();
    await screen.findByText("Couldn't add it to Tahoe trip. Try again.");
    await press(tryAgain());
    await waitFor(() => expect(rpcCalls('attach_bill_to_group')).toHaveLength(1));
    await waitFor(() => expect(tryAgain().props.accessibilityState).not.toMatchObject({ busy: true }));
    db.groupRead = 'ok';
    db.groupId = GROUP;
    await press(tryAgain());
    expect(await screen.findByRole('link', { name: 'In Tahoe trip' })).toBeTruthy();
    expect(rpcCalls('attach_bill_to_group')).toHaveLength(2);
  });

  it('a guest never sees the host\'s failed attach', async () => {
    signInAs(BEN);
    await openBill();
    await act(async () => {});
    expect(screen.queryByText("Couldn't add it to Tahoe trip. Try again.")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('GR-T17-17: a write refused with in_group (the bill moved into a group under the screen)', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    db.groupId = null;
    // Ben owes Ana $3.00 for his half of the Fries; iOS records the mark before Venmo opens.
    supabase.__setRpc((fn) => {
      if (fn === 'mark_paid') {
        db.groupId = GROUP;
        return failure('22023', 'in_group');
      }
      return ok(null);
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the bill screen re-reads the group and then says "Settled in Tahoe trip", with where to settle', async () => {
    await openBill();
    const pay = await screen.findByRole('button', { name: /Pay Ana \$3\.00 on Venmo/ });
    const before = groupReads();
    await press(pay);
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(await screen.findByRole('link', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(groupReads()).toBeGreaterThan(before);
    expect(screen.getByText('This bill is now in Tahoe trip. Settle up in the group.')).toBeTruthy();
    expect(screen.queryByText(/on Venmo/)).toBeNull();
  });

  it('Settle up does the same: the card, with "This bill is now in Tahoe trip. Settle up in the group."', async () => {
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    const pay = await screen.findByRole('button', { name: /Pay Ana \$3\.00 on Venmo/ });
    await press(pay);
    expect(await screen.findByRole('header', { name: 'Settled in Tahoe trip' })).toBeTruthy();
    expect(screen.getByText('This bill is now in Tahoe trip. Settle up in the group.')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Open Tahoe trip' }));
    expect(await screen.findByText(`Group stand-in ${GROUP}`)).toBeTruthy();
  });

  it('if the re-read fails, Pay stays away and the line says to check again', async () => {
    supabase.__setRpc((fn) => {
      if (fn === 'mark_paid') {
        db.groupRead = 'fail';
        return failure('22023', 'in_group');
      }
      return ok(null);
    });
    await openBill();
    await press(await screen.findByRole('button', { name: /Pay Ana \$3\.00 on Venmo/ }));
    expect(await screen.findByText("Couldn't check this bill's group. Try again.")).toBeTruthy();
    expect(screen.getByText('This bill is now in a group. Settle up in the group.')).toBeTruthy();
    expect(screen.queryByText(/on Venmo/)).toBeNull();
  });
});
