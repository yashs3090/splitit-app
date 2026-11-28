// The group expense screen: spec docs/specs/2026-11-26-groups-mvp.md T15, criteria 70–73 and 114
// (A1 GR-T8-1, GR-T8-2), decisions GR-T15-*. The data layer (lib/groups.ts) is mocked at its
// exported functions; its argument checks and error mapping are covered by lib/groups.test.ts.
// Every flow runs on iOS and on web (Platform.OS set explicitly); Android back has its own test.
import { router as appRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { BackHandler, Platform, Text } from 'react-native';

import { expensePayload } from '@/lib/groupExpense';
import { draftOf, formFromExpense } from '@/lib/groupExpenseForm';
import type { GroupError, GroupResult, GroupSnapshot } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { AIRBNB_ID, ANA, BEN, CY, DEE, MEMBERS, RENTAL_CAR_ID, W1 } from '@/test-utils/groupFixtures';
import { GROUP_ID, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

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
  return { ...actual, fetchGroupSnapshot: jest.fn(), addExpense: jest.fn(), editExpense: jest.fn(), deleteExpense: jest.fn() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const add = groups.addExpense as jest.MockedFunction<typeof groups.addExpense>;
const edit = groups.editExpense as jest.MockedFunction<typeof groups.editExpense>;
const del = groups.deleteExpense as jest.MockedFunction<typeof groups.deleteExpense>;

type SnapResult = Awaited<ReturnType<typeof groups.fetchGroupSnapshot>>;
const fail = (error: GroupError): { ok: false; error: GroupError } => ({ ok: false, error });
const done: GroupResult = { ok: true };

let snapshotReply: () => Promise<SnapResult>;
const replyWith = (s: GroupSnapshot) => {
  snapshotReply = async () => ({ ok: true, snapshot: s });
};
const W1_SNAP = snapshotOf(W1.input);
/** W1 with the Airbnb saved again by someone else (version 2, $250). */
const AIRBNB_V2: GroupSnapshot = {
  ...W1_SNAP,
  expenses: W1_SNAP.expenses.map((e) =>
    e.id === AIRBNB_ID ? { ...e, version: 2, amountCents: 25000, shares: MEMBERS.map((userId) => ({ userId, cents: 6250 })) } : e,
  ),
};

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function GroupStandIn() {
  return <Text>Group stand-in</Text>;
}
const ROUTES = { appDir: './app', overrides: { '(app)/groups/[id]/index': GroupStandIn, '(app)/(tabs)/index': () => <Text>Home stand-in</Text> } };
const NEW_PATH = `/groups/${GROUP_ID}/expense`;
const editPath = (expenseId: string) => `/groups/${GROUP_ID}/expense?expense=${expenseId}`;

async function open(path: string, ready = 'Save') {
  const r = renderRouter(ROUTES, { initialUrl: path });
  await screen.findByRole('button', { name: ready });
  return r;
}
/** Opens the group first, then the expense on top of it (the normal way in). */
async function openFromGroup(path = NEW_PATH) {
  const r = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
  await screen.findByText('Group stand-in');
  await act(async () => {
    appRouter.push(path);
  });
  await screen.findByRole('button', { name: 'Save' });
  return r;
}

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const type = async (label: string, text: string) => {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText(label), text);
  });
};
const save = () => screen.getByRole('button', { name: 'Save' });
const isDisabled = (el: ReturnType<typeof save>) => el.props.accessibilityState?.disabled === true;
const back = () => press(screen.getByRole('button', { name: 'Back to group' }));

beforeEach(() => {
  jest.clearAllMocks();
  signInAs(ANA);
  replyWith(W1_SNAP);
  fetchSnapshot.mockImplementation(() => snapshotReply());
  add.mockResolvedValue(done);
  edit.mockResolvedValue(done);
  del.mockResolvedValue(done);
});

describe.each(['ios', 'web'] as const)('expense screen (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a cold deep link opens a new expense: one heading, you paid, everyone in, Save waits for a title', async () => {
    await open(NEW_PATH);
    expect(fetchSnapshot).toHaveBeenCalledWith(GROUP_ID);
    expect(screen.getAllByRole('header', { name: 'New expense' })).toHaveLength(1);
    expect(screen.getByText('Paid by')).toBeTruthy();
    // "You" twice: as the payer and as the first person in the split.
    expect(screen.getAllByText('You')).toHaveLength(2);
    const people = screen.getAllByRole('checkbox');
    expect(people).toHaveLength(4);
    expect(people.every((p) => p.props.accessibilityState?.checked === true)).toBe(true);
    expect(isDisabled(save())).toBe(true);
    expect(screen.getByText('Add what it was for.')).toBeTruthy();
  });

  it('70: Equally with 4 people and $240.00 previews $60.00 each, and Save sends that payload', async () => {
    await openFromGroup();
    await type('What for', 'Airbnb');
    await type('Amount', '240');
    expect(screen.getAllByText('$60.00')).toHaveLength(4);
    expect(screen.getByRole('checkbox', { name: 'You, $60.00' })).toBeTruthy();
    await press(save());
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[0]).toMatchObject({
      groupId: GROUP_ID,
      payload: { p_title: 'Airbnb', p_payer_id: ANA, p_amount_cents: 24000, p_method: 'equal', p_shares: { [ANA]: 1, [BEN]: 1, [CY]: 1, [DEE]: 1 } },
    });
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('70: $1.00 among 3 previews $0.34 / $0.33 / $0.33 in member id order, and the left-out person shows none', async () => {
    await open(NEW_PATH);
    await type('Amount', '1');
    await press(screen.getByRole('checkbox', { name: /^Dee/ }));
    expect(screen.getByRole('checkbox', { name: 'You, $0.34' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Ben, $0.33' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Cy, $0.33' })).toBeTruthy();
    const dee = screen.getByRole('checkbox', { name: 'Dee' });
    expect(dee.props.accessibilityState).toMatchObject({ checked: false });
  });

  it('71: Exact $0.01 over reads "Off by $0.01" with Save disabled; fixed, "Adds up" and Save sends expensePayload’s JSON', async () => {
    await open(NEW_PATH);
    await type('What for', 'Rental car');
    await type('Amount', '300');
    await press(screen.getByRole('radio', { name: 'Exact amounts' }));
    await type('Your amount', '85.73');
    await type("Ben's amount", '85.71');
    await type("Cy's amount", '85.71');
    await type("Dee's amount", '42.86');
    expect(screen.getByText('Off by $0.01')).toBeTruthy();
    expect(isDisabled(save())).toBe(true);
    await press(save());
    expect(add).not.toHaveBeenCalled();
    await type('Your amount', '85.72');
    expect(screen.getByText('Adds up')).toBeTruthy();
    expect(isDisabled(save())).toBe(false);
    await press(save());
    const expected = expensePayload(
      draftOf(
        { title: 'Rental car', amountText: '300', payerId: ANA, method: 'exact', equalChosen: MEMBERS, exactText: { [ANA]: '85.72', [BEN]: '85.71', [CY]: '85.71', [DEE]: '42.86' } },
        MEMBERS,
      ),
    );
    expect(add.mock.calls[0]?.[0].payload).toEqual(expected);
    expect(add.mock.calls[0]?.[0].payload.p_shares).toEqual({ [ANA]: 8572, [BEN]: 8571, [CY]: 8571, [DEE]: 4286 });
  });

  it('114: a typed $0.00 shows "Leave it blank…" and blocks Save; cleared, that person is left out', async () => {
    await open(NEW_PATH);
    await type('What for', 'Tickets');
    await type('Amount', '50');
    await press(screen.getByRole('radio', { name: 'Exact amounts' }));
    await type('Your amount', '50');
    await type("Ben's amount", '0.00');
    expect(screen.getByText('Leave it blank if they don’t owe anything.')).toBeTruthy();
    expect(isDisabled(save())).toBe(true);
    await type("Ben's amount", '');
    expect(screen.queryByText('Leave it blank if they don’t owe anything.')).toBeNull();
    expect(screen.getByText('Adds up')).toBeTruthy();
    await press(save());
    expect(add.mock.calls[0]?.[0].payload.p_shares).toEqual({ [ANA]: 5000 });
  });

  it('GR-T8-2: $99,999.99 is accepted; one cent more says the cap', async () => {
    await open(NEW_PATH);
    await type('What for', 'Big one');
    await type('Amount', '100000');
    expect(screen.getByText('Enter an amount up to $99,999.99.', { exact: true })).toBeTruthy();
    expect(isDisabled(save())).toBe(true);
    await type('Amount', '99999.99');
    expect(isDisabled(save())).toBe(false);
    await press(save());
    expect(add.mock.calls[0]?.[0].payload.p_amount_cents).toBe(9_999_999);
  });

  it('who paid: Change lists the members as radios, and the pick is what Save sends', async () => {
    await open(NEW_PATH);
    const change = screen.getByRole('button', { name: 'Change who paid' });
    expect(change.props.accessibilityState).toMatchObject({ expanded: false });
    await press(change);
    expect(screen.getAllByRole('radio', { name: /^(You|Ben|Cy|Dee)$/ })).toHaveLength(4);
    await press(screen.getByRole('radio', { name: 'Dee' }));
    expect(screen.queryByRole('radio', { name: 'Ben' })).toBeNull();
    await type('What for', 'Gas');
    await type('Amount', '40');
    await press(save());
    expect(add.mock.calls[0]?.[0].payload.p_payer_id).toBe(DEE);
  });

  it('a failed save keeps the input, says so, re-enables Save, and the retry reuses the client id', async () => {
    add.mockResolvedValueOnce(fail('network'));
    await open(NEW_PATH);
    await type('What for', 'Airbnb');
    await type('Amount', '240');
    await press(save());
    expect(await screen.findByText("Couldn't save the expense. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByLabelText('What for').props.value).toBe('Airbnb');
    expect(screen.getByLabelText('Amount').props.value).toBe('240');
    expect(isDisabled(save())).toBe(false);
    await press(save());
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]?.[0].id).toBe(add.mock.calls[0]?.[0].id);
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('a double tap sends one add', async () => {
    let resolve: (r: GroupResult) => void = () => {};
    add.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await open(NEW_PATH);
    await type('What for', 'Airbnb');
    await type('Amount', '240');
    const button = save();
    await press(button);
    await press(button);
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeTruthy();
    await act(async () => resolve(done));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('72: someone who is neither creator nor payer sees the expense read-only, with no Save and no Delete', async () => {
    signInAs(CY);
    renderRouter(ROUTES, { initialUrl: editPath(AIRBNB_ID) });
    expect(await screen.findByRole('header', { name: 'Airbnb' })).toBeTruthy();
    expect(screen.getByText('$240.00')).toBeTruthy();
    expect(screen.getByText('Paid by Ana · Split equally')).toBeTruthy();
    expect(screen.getByLabelText('You, $60.00')).toBeTruthy();
    expect(screen.getByText('Only the person who paid or who added it can change this expense.')).toBeTruthy();
    // Positive control above (the expense rendered); then nothing to change.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete expense' })).toBeNull();
    expect(screen.queryByLabelText('What for')).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('72: the creator deletes after an inline confirm, with the loaded version', async () => {
    await openFromGroup(editPath(AIRBNB_ID));
    expect(screen.getAllByRole('header', { name: 'Edit expense' })).toHaveLength(1);
    expect(screen.getByLabelText('What for').props.value).toBe('Airbnb');
    expect(screen.getByLabelText('Amount').props.value).toBe('240.00');
    await press(screen.getByRole('button', { name: 'Delete expense' }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Airbnb? It comes out of everyone’s balances.')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByText('Delete Airbnb? It comes out of everyone’s balances.')).toBeNull();
    await press(screen.getByRole('button', { name: 'Delete expense' }));
    // The confirm's button carries the same name; it's the one with the confirm's hint.
    const confirm = screen.getAllByRole('button', { name: 'Delete expense' }).find((b) => b.props.accessibilityHint === 'Removes it from everyone’s balances');
    expect(confirm).toBeTruthy();
    if (confirm) await press(confirm);
    expect(del).toHaveBeenCalledWith(AIRBNB_ID, 1);
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('the payer of an expense someone else created can edit it (Dee, Rental car, exact)', async () => {
    signInAs(DEE);
    await open(editPath(RENTAL_CAR_ID));
    expect(screen.getByRole('radio', { name: 'Exact amounts' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByLabelText('Your amount').props.value).toBe('42.86');
    expect(screen.getByText('Adds up')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete expense' })).toBeTruthy();
  });

  it('a no-op save sends nothing and goes back to the group', async () => {
    await open(editPath(AIRBNB_ID));
    await type('What for', 'Airbnb ');
    await type('Amount', '240');
    await press(save());
    expect(edit).not.toHaveBeenCalled();
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('72: version_changed keeps what was typed, refetches, offers their changes, and the next Save sends the new version', async () => {
    edit.mockResolvedValueOnce(fail('version_changed'));
    await open(editPath(AIRBNB_ID));
    await type('Amount', '260');
    replyWith(AIRBNB_V2);
    const before = fetchSnapshot.mock.calls.length;
    await press(save());
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ id: AIRBNB_ID, expectedVersion: 1 });
    expect(await screen.findByText('Someone just changed this expense. Check it and try again.')).toBeTruthy();
    expect(fetchSnapshot.mock.calls.length).toBe(before + 1);
    expect(await screen.findByRole('button', { name: 'Show their changes' })).toBeTruthy();
    expect(screen.getByLabelText('Amount').props.value).toBe('260');
    await press(save());
    expect(edit.mock.calls[1]?.[0]).toMatchObject({ expectedVersion: 2, payload: { p_amount_cents: 26000 } });
  });

  it('72: "Show their changes" loads the saved expense into the form', async () => {
    edit.mockResolvedValueOnce(fail('version_changed'));
    await open(editPath(AIRBNB_ID));
    await type('Amount', '260');
    replyWith(AIRBNB_V2);
    await press(save());
    await press(await screen.findByRole('button', { name: 'Show their changes' }));
    expect(screen.getByLabelText('Amount').props.value).toBe('250.00');
    expect(screen.queryByText('Someone just changed this expense. Check it and try again.')).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'You, $62.50' })).toBeTruthy();
  });

  it('version_changed whose refetch fails says so with a working retry, and Save stays usable', async () => {
    edit.mockResolvedValueOnce(fail('version_changed'));
    await open(editPath(AIRBNB_ID));
    await type('Amount', '260');
    snapshotReply = async () => fail('network');
    await press(save());
    expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
    expect(isDisabled(save())).toBe(false);
    replyWith(AIRBNB_V2);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Show their changes' })).toBeTruthy();
    expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
  });

  it('an untouched edit form follows a newer saved version from a focus refetch', async () => {
    const r = await openFromGroup(editPath(AIRBNB_ID));
    replyWith(AIRBNB_V2);
    // Leave without changes (no guard), then come back: the focus refetch has the new version.
    await back();
    await screen.findByText('Group stand-in');
    await act(async () => {
      appRouter.push(editPath(AIRBNB_ID));
    });
    await waitFor(() => expect(screen.getByLabelText('Amount').props.value).toBe('250.00'));
    expect(r.getPathname()).toBe(`/groups/${GROUP_ID}/expense`);
  });

  it('73: the back control asks before discarding typed input; Keep editing stays, Discard leaves', async () => {
    await openFromGroup();
    await type('What for', 'Gas');
    await back();
    expect(screen.getByText('Discard this expense?')).toBeTruthy();
    expect(screen.queryByText('Group stand-in')).toBeNull();
    await press(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('What for').props.value).toBe('Gas');
    await back();
    await press(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('73: the iOS back-swipe’s pop (router.back) asks too; with nothing typed it just goes', async () => {
    await openFromGroup();
    await type('Amount', '12');
    await act(async () => {
      appRouter.back();
    });
    expect(screen.getByText('Discard this expense?')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
    await act(async () => {
      appRouter.push(NEW_PATH);
    });
    await screen.findByRole('button', { name: 'Save' });
    await act(async () => {
      appRouter.back();
    });
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('73: an edit asks "Discard your changes?" only once something changed', async () => {
    await openFromGroup(editPath(AIRBNB_ID));
    await type('What for', 'Cabin');
    await back();
    expect(screen.getByText('Discard your changes?')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Keep editing' }));
    await type('What for', 'Airbnb');
    await back();
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('not a member: fixed copy and Go home; a load error has Try again', async () => {
    snapshotReply = async () => fail('not_allowed');
    renderRouter(ROUTES, { initialUrl: NEW_PATH });
    expect(await screen.findByText("You're not in this group. Ask someone in it for the group's link.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go home' })).toBeTruthy();
  });

  it('a load error, then Try again loads the form', async () => {
    snapshotReply = async () => fail('network');
    renderRouter(ROUTES, { initialUrl: NEW_PATH });
    expect(await screen.findByText("Couldn't load the group.")).toBeTruthy();
    replyWith(W1_SNAP);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('an expense id that is not in the group shows fixed copy and never the id', async () => {
    renderRouter(ROUTES, { initialUrl: editPath('not-a-real-expense') });
    expect(await screen.findByText("This expense isn't in the group anymore.")).toBeTruthy();
    expect(screen.queryByText(/not-a-real-expense/)).toBeNull();
    await press(screen.getByRole('button', { name: 'Go to the group' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('someone deleting it while you edit: the refetch shows it is gone, with the way back', async () => {
    edit.mockResolvedValueOnce(fail('version_changed'));
    await open(editPath(AIRBNB_ID));
    await type('Amount', '260');
    replyWith({ ...W1_SNAP, expenses: W1_SNAP.expenses.filter((e) => e.id !== AIRBNB_ID) });
    await press(save());
    expect(await screen.findByText("This expense isn't in the group anymore.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await press(screen.getByRole('button', { name: 'Go to the group' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('every control has a role and a name', async () => {
    await open(editPath(AIRBNB_ID));
    await press(screen.getByRole('button', { name: 'Change who paid' }));
    // Positive control: the controls this checks are on screen (4 people, 4 payers + 2 split options).
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getAllByRole('radio')).toHaveLength(6);
    const controls = screen.UNSAFE_root.findAll(
      (n) => typeof n.type === 'string' && ['button', 'checkbox', 'radio'].includes(n.props.accessibilityRole as string),
    );
    expect(controls.length).toBeGreaterThan(12);
    for (const c of controls) {
      const label = c.props.accessibilityLabel;
      const text = within(c).queryAllByText(/\S/);
      expect(typeof label === 'string' ? label.trim().length > 0 : text.length > 0).toBe(true);
    }
  });
});

describe('web only', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'web');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('73: typed input asks the browser to confirm a reload or tab close (beforeunload); browser back is GR-T15-4', async () => {
    // React Native's Jest `window` has no DOM events; give it the two the screen uses.
    const addListener = jest.fn();
    const removeListener = jest.fn();
    const w = window as unknown as { addEventListener?: unknown; removeEventListener?: unknown };
    w.addEventListener = addListener;
    w.removeEventListener = removeListener;
    await open(NEW_PATH);
    expect(addListener.mock.calls.some(([name]) => name === 'beforeunload')).toBe(false);
    await type('What for', 'Gas');
    const call = addListener.mock.calls.find(([name]) => name === 'beforeunload');
    expect(call).toBeTruthy();
    const handler = call?.[1] as (e: { preventDefault: () => void; returnValue: unknown }) => void;
    const event = { preventDefault: jest.fn(), returnValue: undefined as unknown };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
    await type('What for', '');
    expect(removeListener.mock.calls.some(([name, fn]) => name === 'beforeunload' && fn === call?.[1])).toBe(true);
    delete w.addEventListener;
    delete w.removeEventListener;
  });
});

describe('android', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('73: the hardware back button asks before discarding', async () => {
    type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: BackListener[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.push(handler);
      return { remove: () => handlers.splice(handlers.indexOf(handler), 1) };
    });
    await openFromGroup();
    await type('What for', 'Gas');
    expect(handlers.length).toBeGreaterThan(0);
    await act(async () => {
      // The newest listener runs first, as BackHandler does.
      for (const h of [...handlers].reverse()) if (h({} as Parameters<BackListener>[0])) break;
    });
    expect(screen.getByText('Discard this expense?')).toBeTruthy();
    expect(screen.queryByText('Group stand-in')).toBeNull();
    await press(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });
});

// Keeps the fixture honest: the edit tests rely on Airbnb loading as these values.
it('fixture: Airbnb reloads as $240.00 split equally among the four', () => {
  const airbnb = W1_SNAP.expenses.find((e) => e.id === AIRBNB_ID);
  expect(airbnb && formFromExpense(airbnb, MEMBERS)).toMatchObject({ amountText: '240.00', method: 'equal', equalChosen: MEMBERS });
});
