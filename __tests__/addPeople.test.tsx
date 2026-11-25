// Add people (/bills/<id>/people): criteria 43–47 and 49 in docs/specs/2026-11-24-people-and-invites.md (Task 7).
// Bill: Burger 15.00, Fries 6.00; total 21.00 (only the people parts matter here).
// A is the host (Hana Lee). B (Bo) joined with the link. People A has split with: Sam Lee, Bo, Ali.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Platform } from 'react-native';

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

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const INVITE_BILL = '11111111-1111-4111-8111-222222222222';
const CODE = '0123456789abcdef0123';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const SAM = '00000000-0000-4000-8000-00000000000c';
const ALI = '00000000-0000-4000-8000-00000000000d';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';

type Participant = Record<string, unknown> & { user_id: string };
type Claim = { line_item_id: string; user_id: string; parts: number };
type PersonRow = { user_id: string; display_name: string | null; venmo_username: string | null; shared_bills: number; last_shared_at: string };

const NAMES: Record<string, string> = { [A]: 'Hana Lee', [B]: 'Bo', [SAM]: 'Sam Lee', [ALI]: 'Ali' };

function participant(userId: string, minute: number, mark = false): Participant {
  return {
    user_id: userId,
    joined_at: `2026-11-20T19:${String(minute).padStart(2, '0')}:00Z`,
    settled_at: mark ? '2026-11-20T21:00:00Z' : null,
    settled_cents: mark ? 600 : null,
    profile: { display_name: NAMES[userId] ?? null, venmo_username: null },
  };
}
const personRow = (userId: string, bills: number): PersonRow => ({
  user_id: userId,
  display_name: NAMES[userId] ?? null,
  venmo_username: null,
  shared_bills: bills,
  last_shared_at: '2026-11-20T19:00:00Z',
});

const db: {
  payer: string;
  participants: Participant[];
  claims: Claim[];
  people: PersonRow[];
  failBills: boolean;
  noBill: boolean;
  /** Per function: a result to return instead of doing the change, or a promise to wait on first. */
  answer: Partial<Record<string, FakeResult>>;
  hold: Partial<Record<string, Promise<void>>>;
} = { payer: A, participants: [], claims: [], people: [], failBills: false, noBill: false, answer: {}, hold: {} };

function reset() {
  db.payer = A;
  db.participants = [participant(A, 0), participant(B, 5)];
  db.claims = [];
  db.people = [personRow(SAM, 4), personRow(B, 2), personRow(ALI, 1)];
  db.failBills = false;
  db.noBill = false;
  db.answer = {};
  db.hold = {};
}

function installFakes() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () => {
    if (db.failBills) return { data: null, error: { code: '08006', message: 'server text: connection lost' } };
    if (db.noBill) return ok(null);
    return ok({
      id: BILL,
      host_id: A,
      payer_id: db.payer,
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 2100,
      join_code: CODE,
      created_at: '2026-11-20T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    });
  });
  supabase.__setTable('line_items', () =>
    ok([
      { id: BURGER, name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500, split_set_by: null, split_set_at: null },
      { id: FRIES, name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600, split_set_by: null, split_set_at: null },
    ]),
  );
  supabase.__setTable('bill_participants', () => ok(db.participants.map((p) => ({ ...p }))));
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  supabase.__setRpc(async (fn, args) => {
    const hold = db.hold[fn];
    if (hold) await hold;
    const answer = db.answer[fn];
    if (answer) return answer;
    const userId = String(args?.p_user_id ?? '');
    switch (fn) {
      case 'people_i_split_with':
        return ok(db.people);
      case 'add_participant':
        if (!db.participants.some((p) => p.user_id === userId)) db.participants.push(participant(userId, 30));
        return ok(null);
      case 'remove_participant':
        db.participants = db.participants.filter((p) => p.user_id !== userId);
        return ok(null);
      case 'join_bill':
        return ok(INVITE_BILL);
      default:
        return ok(null);
    }
  });
}

const signInAs = (id: string) => {
  const s = fakeSession(NAMES[id]);
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
};
const calls = (fn: string) => supabase.rpc.mock.calls.filter(([f]) => f === fn);
const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const held = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const busy = (label: string) => screen.getByLabelText(label).props.accessibilityState?.busy === true;
const disabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled === true;
/** "On this bill" rows and addable rows, as their screen-reader labels, top to bottom. */
const rowLabels = () =>
  screen.UNSAFE_root.findAll((n) => typeof n.type === 'string' && n.props.accessible === true && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityRole === undefined)
    .map((n) => String(n.props.accessibilityLabel));

async function openPeople() {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
  await screen.findByRole('header', { name: 'Add people' });
  await screen.findByLabelText('Add Sam Lee');
  return router;
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  reset();
  installFakes();
  signInAs(A);
});

describe.each(['ios', 'web'] as const)('Add people (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ----- Entry paths -----

  it('entry: pushed from the bill screen, and Back pops to it', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $21.00');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add people'));
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/people`));
    await screen.findByLabelText('Add Sam Lee');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Back'));
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await screen.findByText('Total $21.00')).toBeTruthy();
  });

  it('entry: a cold deep link shows the screen; Back opens the bill', async () => {
    const router = await openPeople();
    expect(router.getPathname()).toBe(`/bills/${BILL}/people`);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Back'));
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await screen.findByText('Total $21.00')).toBeTruthy();
  });

  it('entry: signed out goes to /sign-in with no reads and no writes', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('entry: with a pending invite, the resume effect wins; this screen adds no one and does not navigate', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${INVITE_BILL}`));
    expect(calls('join_bill')).toEqual([['join_bill', { p_code: CODE }]]);
    expect(calls('add_participant')).toEqual([]);
    expect(calls('remove_participant')).toEqual([]);
    expect(await screen.findByText('Total $21.00')).toBeTruthy();
  });

  it('47: a guest sees "Only Hana Lee can add people." and "Back to the bill", with no list call and no buttons', async () => {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText('Only Hana Lee can add people.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Add /)).toBeNull();
    expect(screen.queryByLabelText(/^Remove /)).toBeNull();
    expect(calls('people_i_split_with')).toEqual([]);
    await act(async () => {
      fireEvent.press(screen.getByText('Back to the bill'));
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('a non-participant (RLS returns no bill) sees the no-access copy and no list call', async () => {
    signInAs(SAM);
    db.noBill = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText("You don't have access to this bill, or it doesn't exist.")).toBeTruthy();
    expect(screen.getByText('Go home')).toBeTruthy();
    expect(calls('people_i_split_with')).toEqual([]);
  });

  it('a failed bill load shows "Try again", which loads it', async () => {
    db.failBills = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    db.failBills = false;
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });
    expect(await screen.findByLabelText('Add Sam Lee')).toBeTruthy();
  });

  // ----- Adding -----

  it('43: lists addable people in order (Bo is already on the bill), with "Add <name>" buttons', async () => {
    await openPeople();
    const adds = screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? '')).filter((l) => l.startsWith('Add '));
    expect(adds).toEqual(['Add Sam Lee', 'Add Ali']);
    expect(screen.getByText(/^4 bills · last /)).toBeTruthy();
    expect(screen.getByText(/^1 bill · /)).toBeTruthy();
    expect(calls('people_i_split_with')).toHaveLength(1);
  });

  it('43: one tap (even a double tap) adds once, the button is busy until the refetch lands, then Sam is on the bill', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const gate = held();
    db.hold.add_participant = gate.promise;
    await openPeople();
    fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    expect(calls('add_participant')).toEqual([['add_participant', { p_bill_id: BILL, p_user_id: SAM }]]);
    expect(busy('Add Sam Lee')).toBe(true);
    expect(busy('Add Ali')).toBe(false);

    const before = billFetches();
    await act(async () => gate.release());
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    expect(await screen.findByText('Sam Lee added')).toBeTruthy();
    expect(screen.getByText('Sam Lee added').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.queryByLabelText('Add Sam Lee')).toBeNull();
    expect(rowLabels()).toContain('Sam Lee, no items yet');
    expect(calls('add_participant')).toHaveLength(1);
    if (os === 'ios') expect(announce).toHaveBeenCalledWith('Sam Lee added');
    else expect(announce).not.toHaveBeenCalled();
  });

  it('43: two different people can be added back to back', async () => {
    await openPeople();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add Sam Lee'));
      fireEvent.press(screen.getByLabelText('Add Ali'));
    });
    await screen.findByText(/added$/);
    await waitFor(() => expect(screen.queryByLabelText('Add Ali')).toBeNull());
    expect(calls('add_participant').map(([, a]) => (a as { p_user_id: string }).p_user_id)).toEqual([SAM, ALI]);
    expect(await screen.findByText("Everyone you've split with is on this bill.")).toBeTruthy();
  });

  it('43 (lesson 2026-11-24): the add worked but the refetch failed: the button is released and the screen says so', async () => {
    const gate = held();
    db.hold.add_participant = gate.promise;
    await openPeople();
    fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    db.failBills = true;
    await act(async () => gate.release());
    expect(await screen.findByText("Couldn't refresh the bill.")).toBeTruthy();
    expect(busy('Add Sam Lee')).toBe(false);
    expect(screen.getByText('Sam Lee added')).toBeTruthy();

    db.failBills = false;
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Refresh the bill'));
    });
    await waitFor(() => expect(screen.queryByLabelText('Add Sam Lee')).toBeNull());
    expect(screen.queryByText("Couldn't refresh the bill.")).toBeNull();
  });

  it('44: not_linked shows its copy and reloads the list', async () => {
    db.answer.add_participant = { data: null, error: { code: '22023', message: 'not_linked' } };
    await openPeople();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    });
    expect(await screen.findByText("You can only add people you've split a bill with.")).toBeTruthy();
    await waitFor(() => expect(calls('people_i_split_with')).toHaveLength(2));
    expect(disabled('Add Sam Lee')).toBe(false);
  });

  it('44: a network error shows the fixed copy (never the server text) and the button works again', async () => {
    db.answer.add_participant = { data: null, error: { code: '08006', message: 'server text' } };
    await openPeople();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    });
    expect(await screen.findByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    expect(disabled('Add Sam Lee')).toBe(false);
    delete db.answer.add_participant;
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add Sam Lee'));
    });
    expect(await screen.findByText('Sam Lee added')).toBeTruthy();
    expect(calls('add_participant')).toHaveLength(2);
  });

  it('a failed people list shows its error with "Try again"; the bill part still works', async () => {
    db.answer.people_i_split_with = { data: null, error: { code: '08006', message: 'x' } };
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText("Couldn't load people.")).toBeTruthy();
    expect(rowLabels()[0]).toBe('You, no items yet');
    delete db.answer.people_i_split_with;
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });
    expect(await screen.findByLabelText('Add Sam Lee')).toBeTruthy();
  });

  it('search shows with more than 5 addable people and keeps the order', async () => {
    const more = ['e', 'f', '10', '11'].map((n) => `00000000-0000-4000-8000-0000000000${n.padStart(2, '0')}`);
    const names = ['Sasha', 'Eve', 'Sid', 'Max'];
    more.forEach((id, i) => (NAMES[id] = names[i] ?? ''));
    db.people = [...db.people, ...more.map((id) => personRow(id, 1))];
    await openPeople();
    fireEvent.changeText(screen.getByLabelText('Search people'), 's');
    const adds = screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? '')).filter((l) => l.startsWith('Add '));
    expect(adds).toEqual(['Add Sam Lee', 'Add Sasha', 'Add Sid']);
  });

  // ----- On this bill -----

  it('45: "You" first, then join order, "No items yet" for anyone without claims', async () => {
    db.participants = [participant(B, 5), participant(A, 0), participant(SAM, 9)];
    db.claims = [{ line_item_id: FRIES, user_id: B, parts: 1 }];
    db.people = [personRow(ALI, 1)];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    await screen.findByLabelText('Add Ali');
    expect(rowLabels().filter((l) => !l.includes('together'))).toEqual(['You, no items yet', 'Bo', 'Sam Lee, no items yet']);
  });

  it('45: "Remove" shows exactly where canRemove holds (M2 payer no, M3 added yes, M5 claimer no, M7 mark no)', async () => {
    db.payer = B;
    db.participants = [participant(A, 0), participant(B, 5), participant(SAM, 9), participant(ALI, 10, true)];
    const extra = '00000000-0000-4000-8000-000000000012';
    NAMES[extra] = 'Cy';
    db.participants.push(participant(extra, 11));
    db.claims = [{ line_item_id: FRIES, user_id: extra, parts: 1 }];
    db.people = [];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    await screen.findByText('On this bill');
    await screen.findByText(/People you split bills with will show up here/);
    const removes = screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? '')).filter((l) => l.startsWith('Remove '));
    expect(removes).toEqual(['Remove Sam Lee from this bill']);
  });

  it('45: Remove calls removeParticipant once (double tap), waits for the refetch, and the person goes back to the addable list', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    db.participants = [participant(A, 0), participant(B, 5), participant(SAM, 9)];
    const gate = held();
    db.hold.remove_participant = gate.promise;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    const remove = await screen.findByLabelText('Remove Sam Lee from this bill');
    fireEvent.press(remove);
    fireEvent.press(remove);
    expect(calls('remove_participant')).toEqual([['remove_participant', { p_bill_id: BILL, p_user_id: SAM }]]);
    expect(busy('Remove Sam Lee from this bill')).toBe(true);
    await act(async () => gate.release());
    expect(await screen.findByText('Sam Lee removed')).toBeTruthy();
    expect(screen.queryByLabelText('Remove Sam Lee from this bill')).toBeNull();
    expect(screen.getByLabelText('Add Sam Lee')).toBeTruthy();
    if (os === 'ios') expect(announce).toHaveBeenCalledWith('Sam Lee removed');
  });

  it('45: cannot_remove shows its copy and refetches, so "Remove" goes away', async () => {
    db.participants = [participant(A, 0), participant(B, 5), participant(SAM, 9)];
    db.answer.remove_participant = { data: null, error: { code: '22023', message: 'cannot_remove' } };
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    const remove = await screen.findByLabelText('Remove Sam Lee from this bill');
    db.claims = [{ line_item_id: BURGER, user_id: SAM, parts: 1 }]; // Sam claimed just now
    const before = billFetches();
    await act(async () => {
      fireEvent.press(remove);
    });
    expect(await screen.findByText("Couldn't remove them. They may have just claimed an item.")).toBeTruthy();
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByLabelText('Remove Sam Lee from this bill')).toBeNull());
  });

  // ----- Empty states -----

  it('46: nobody to list shows the "show up here" copy', async () => {
    db.people = [];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(
      await screen.findByText('People you split bills with will show up here. To invite someone new, go back and share the link.'),
    ).toBeTruthy();
  });

  it('46: everyone already on the bill shows "Everyone you\'ve split with is on this bill."', async () => {
    db.people = [personRow(B, 2)];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    expect(await screen.findByText("Everyone you've split with is on this bill.")).toBeTruthy();
  });

  // ----- Accessibility -----

  it('49: buttons have labels and hints; the header is a header', async () => {
    db.participants = [participant(A, 0), participant(B, 5), participant(SAM, 9)];
    db.people = [personRow(ALI, 1)];
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/people` });
    const add = await screen.findByLabelText('Add Ali');
    expect(add.props.accessibilityRole).toBe('button');
    expect(add.props.accessibilityHint).toBeTruthy();
    expect(screen.getByLabelText('Remove Sam Lee from this bill').props.accessibilityHint).toBeTruthy();
    expect(screen.getByLabelText('Back').props.accessibilityHint).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Add people' })).toBeTruthy();
    expect(screen.getByLabelText(/^Ali, 1 bill together, on /)).toBeTruthy();
  });
});
