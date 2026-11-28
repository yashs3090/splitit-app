// Home's Groups block (components/GroupsSection.tsx) and New group (app/(app)/groups/new.tsx).
// docs/specs/2026-11-26-groups-mvp.md T13, criteria 62–63, plus the coordinator's row additions
// (avatars, "N items left to claim" / "Settled"). GroupsSection isn't on Home yet (splitit-app-96 owns
// app/(app)/index.tsx), so it is rendered here on a stand-in Home inside the real auth provider.
//
// Group claim status T4 (docs/specs/2026-11-27-group-claim-status.md, C2, criteria 21-23): each row
// shows one state for the viewer, in its tone's color. Viewers: Ana (W1 owed $130.02, W2 owed
// $82.77) and Dee (no claim on Dinner, so W2 needs her).
import { router as appRouter, Stack } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform, StyleSheet, Text } from 'react-native';

import { GroupsSection } from '@/components/GroupsSection';
import { AuthProvider } from '@/lib/auth';
import type { GroupBalanceInput } from '@/lib/groupBalance';
import type { GroupSnapshot } from '@/lib/groups';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { fakeSession, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, DEE, dinnerBill, MEMBERS, W1, W2 } from '@/test-utils/groupFixtures';
import { GROUP_ID, snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const HIDDEN_ID = '9a000000-0000-4000-8000-000000000002';
const TS = '2026-11-26T10:00:00.000Z';
const SERVER_TEXT = 'secret_internal_name for ada@example.com';

function signInAs(userId: string) {
  const s = fakeSession('Ana');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id: userId } });
}

/**
 * The worked-example snapshot for a balance input. No Venmo usernames: the fixture's short ones
 * ("cy-1") are under Venmo's 5-character minimum, which the strict parser refuses.
 */
const snap = (input: Parameters<typeof snapshotOf>[0], groupName?: string) => snapshotOf(input, { venmo: {}, ...(groupName ? { groupName } : {}) });

/** A parsed GroupSnapshot back to group_snapshot()'s JSON (C-G11 as built, A3.1). */
function toRaw(s: GroupSnapshot): unknown {
  return {
    group: { id: s.group.id, name: s.group.name, join_code: s.group.joinCode, created_by: s.group.createdBy, created_at: s.group.createdAt },
    me: { hidden: s.me.hidden, not_part_bill_ids: s.me.notPartBillIds },
    members: s.members.map((m) => ({ user_id: m.userId, display_name: m.displayName, venmo_username: m.venmoUsername, joined_at: m.joinedAt })),
    bills: s.bills.map((b) => ({
      id: b.id,
      host_id: b.hostId,
      payer_id: b.payerId,
      total_cents: b.totalCents,
      extras_split: b.extrasSplit,
      created_at: b.createdAt,
      rows: b.rows.map((r) => ({ id: r.id, total_cents: r.totalCents, kind: r.kind, name: r.name, claims: r.claims })),
      participant_ids: b.participantIds,
    })),
    expenses: s.expenses.map((e) => ({
      id: e.id,
      title: e.title,
      payer_id: e.payerId,
      amount_cents: e.amountCents,
      split_method: e.splitMethod,
      created_by: e.createdBy,
      created_at: e.createdAt,
      edited_at: e.editedAt,
      version: e.version,
      shares: e.shares.map((x) => ({ user_id: x.userId, cents: x.cents })),
    })),
    payments: s.payments.map((p) => ({
      id: p.id,
      from_user: p.from,
      to_user: p.to,
      cents: p.cents,
      method: p.method,
      source: p.source,
      recorded_by: p.recordedBy,
      bill_id: p.billId,
      created_at: p.createdAt,
    })),
    not_received: [],
    money_fingerprint: s.moneyFingerprint,
  };
}

const gid = (n: number) => `9a000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;

/** A snapshot read as another group (group_snapshot is per group; the row ignores a mismatched id). */
const inGroup = (s: GroupSnapshot, id: string, name: string): GroupSnapshot => ({ ...s, group: { ...s.group, id, name } });

/** The caption Text's color (the status's tone, C2). */
const captionColor = (el: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(el.props.style as Parameters<typeof StyleSheet.flatten>[0]) as { color?: string }).color;

const expense = (n: number, payerId: string, shares: { userId: string; cents: number }[]) => ({
  id: `e9000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  payerId,
  amountCents: shares.reduce((sum, s) => sum + s.cents, 0),
  shares,
});

/** Only Dinner with its nachos unclaimed: it counts for no one yet, so Ana's net is 0 (C2 rule 4). */
const WAITING_ONLY: GroupBalanceInput = { members: [...MEMBERS], bills: [dinnerBill({ nachosClaimers: [] })], expenses: [], payments: [] };
/** Ana paid $25.00 for her and Dee: Dee owes $12.50 (C2 rule 2). */
const DEE_OWES_1250: GroupBalanceInput = {
  members: [...MEMBERS],
  bills: [],
  expenses: [expense(1, ANA, [{ userId: ANA, cents: 1250 }, { userId: DEE, cents: 1250 }])],
  payments: [],
};
/** Dee paid $16.00 for her and Ana: Dee is owed $8.00 (C2 rule 3). */
const DEE_OWED_800: GroupBalanceInput = {
  members: [...MEMBERS],
  bills: [],
  expenses: [expense(2, DEE, [{ userId: ANA, cents: 800 }, { userId: DEE, cents: 800 }])],
  payments: [],
};

const groupRow = (id: string, over: Record<string, unknown> = {}) => ({ id, name: 'Tahoe trip', member_count: 4, joined_at: TS, hidden: false, ...over });
const TAHOE = groupRow(GROUP_ID);
const OLD_FLAT = groupRow(HIDDEN_ID, { name: 'Old flat', member_count: 2, hidden: true });

/** The server's view of OLD_FLAT's hidden flag: set_group_hidden changes it, my_groups reads it. */
let oldFlatHidden = true;

type Db = {
  myGroups: () => FakeResult | Promise<FakeResult>;
  snapshot: (id: string) => FakeResult | Promise<FakeResult>;
  setHidden: () => FakeResult | Promise<FakeResult>;
  create: (args: Record<string, unknown>) => FakeResult | Promise<FakeResult>;
};
let db: Db;

const calls = (fn: string) => supabase.rpc.mock.calls.filter(([f]) => f === fn);

beforeEach(() => {
  jest.clearAllMocks();
  signInAs(ANA);
  oldFlatHidden = true;
  db = {
    myGroups: () => ({ data: [TAHOE, { ...OLD_FLAT, hidden: oldFlatHidden }], error: null }),
    snapshot: () => ({ data: toRaw(snap(W1.input)), error: null }),
    setHidden: () => ({ data: null, error: null }),
    create: (args) => ({ data: args.p_id, error: null }),
  };
  supabase.__setRpc((fn, args) => {
    if (fn === 'my_groups') return db.myGroups();
    if (fn === 'group_snapshot') return db.snapshot(String(args?.p_group_id));
    if (fn === 'set_group_hidden') {
      return Promise.resolve(db.setHidden()).then((r) => {
        if (r.error === null) oldFlatHidden = args?.p_hidden === true;
        return r;
      });
    }
    if (fn === 'create_group') return db.create(args ?? {});
    return { data: null, error: null };
  });
});

function HomeStandIn() {
  return <GroupsSection />;
}

/** GroupsSection on a stand-in Home, with stand-ins for the screens it opens. */
function renderHome() {
  return renderRouter(
    {
      _layout: () => (
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </AuthProvider>
      ),
      index: HomeStandIn,
      'groups/new': () => <Text>New group stand-in</Text>,
      'groups/[id]': () => <Text>Group stand-in</Text>,
    },
    { initialUrl: '/' },
  );
}

describe('GroupsSection', () => {
  it('62: two groups, one hidden: one row ("Tahoe trip", "4 people"), "New group", "Hidden groups (1)" with Show', async () => {
    renderHome();
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Groups' })).toBeTruthy();
    // The people count is in the link name; the caption shows Ana's state once the snapshot lands.
    expect(await screen.findByRole('link', { name: "Tahoe trip, 4 people, You're owed $130.02" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New group' })).toBeTruthy();
    expect(screen.getByText('Hidden groups (1)')).toBeTruthy();
    expect(screen.getByText('Show', { includeHiddenElements: true })).toBeTruthy();
    // The hidden group is folded away (the visible row above shows the list landed).
    expect(screen.queryByText('Old flat')).toBeNull();
    expect(screen.queryByText('Start a group')).toBeNull();
    // Snapshots are read for visible groups only.
    await waitFor(() => expect(calls('group_snapshot')).toEqual([['group_snapshot', { p_group_id: GROUP_ID }]]));
  });

  it('62: no groups: only "Start a group" (no heading, no "New group", no toggle)', async () => {
    db.myGroups = () => ({ data: [], error: null });
    renderHome();
    expect(await screen.findByRole('button', { name: 'Start a group' })).toBeTruthy();
    expect(screen.queryByRole('header', { name: 'Groups' })).toBeNull();
    expect(screen.queryByText('New group')).toBeNull();
    expect(screen.queryByText(/Hidden groups/)).toBeNull();
  });

  it('only hidden groups: "Start a group" and the toggle', async () => {
    db.myGroups = () => ({ data: [OLD_FLAT], error: null });
    renderHome();
    expect(await screen.findByRole('button', { name: 'Start a group' })).toBeTruthy();
    expect(screen.getByText('Hidden groups (1)')).toBeTruthy();
    expect(calls('group_snapshot')).toHaveLength(0);
  });

  it('shows nothing while the first load is out (no "Start a group" flash)', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    db.myGroups = () => new Promise<FakeResult>((r) => (resolve = r));
    renderHome();
    await waitFor(() => expect(calls('my_groups')).toHaveLength(1));
    expect(screen.queryByText('Start a group')).toBeNull();
    expect(screen.queryByText('Groups')).toBeNull();
    await act(async () => resolve({ data: [TAHOE], error: null }));
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
  });

  it('a receipt waiting on others, nothing owed: "1 item left to claim" (muted), the other members\' initials, and a label that says it all', async () => {
    db.snapshot = () => ({ data: toRaw(snap(WAITING_ONLY)), error: null });
    renderHome();
    const caption = await screen.findByText('1 item left to claim');
    expect(captionColor(caption)).toBe(colors.light.textMuted);
    expect(screen.getByRole('link', { name: 'Tahoe trip, 4 people, 1 item left to claim' })).toBeTruthy();
    // Initials are decorative (hidden from screen readers); the viewer (Ana) isn't among them.
    expect(screen.getByText('B', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText('D', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByText('A', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByText('B')).toBeNull();
  });

  it('W2 for Ana: her net counts only the claimed receipts, "You\'re owed $82.77" in the success color', async () => {
    db.snapshot = () => ({ data: toRaw(snap(W2.input)), error: null });
    renderHome();
    const caption = await screen.findByText("You're owed $82.77");
    expect(captionColor(caption)).toBe(colors.light.success);
    expect(screen.getByRole('link', { name: "Tahoe trip, 4 people, You're owed $82.77" })).toBeTruthy();
  });

  it('W2 for Dee (nothing claimed on Dinner): "Claim your items on 1 bill" in the warning color', async () => {
    signInAs(DEE);
    db.snapshot = () => ({ data: toRaw(snap(W2.input)), error: null });
    renderHome();
    const caption = await screen.findByText('Claim your items on 1 bill');
    expect(captionColor(caption)).toBe(colors.light.warning);
    expect(screen.getByRole('link', { name: 'Tahoe trip, 4 people, Claim your items on 1 bill' })).toBeTruthy();
  });

  it('every suggestion paid: "Settled up" (muted)', async () => {
    db.snapshot = () => ({ data: toRaw(snap({ ...W1.input, payments: [...(W1.shown ?? [])] })), error: null });
    renderHome();
    const caption = await screen.findByText('Settled up');
    expect(captionColor(caption)).toBe(colors.light.textMuted);
    expect(screen.getByRole('link', { name: 'Tahoe trip, 4 people, Settled up' })).toBeTruthy();
    expect(screen.queryByText('Settled')).toBeNull();
  });

  it('21: four groups for Dee read in order, each in its own color: claim, owe, settled, owed', async () => {
    signInAs(DEE);
    const ids = [GROUP_ID, gid(1), gid(2), gid(3)];
    const names = ['Tahoe trip', 'Flat', 'Ski week', 'Lunch club'];
    const inputs: GroupBalanceInput[] = [W2.input, DEE_OWES_1250, { ...W1.input, payments: [...(W1.shown ?? [])] }, DEE_OWED_800];
    db.myGroups = () => ({ data: ids.map((id, i) => groupRow(id, { name: names[i] })), error: null });
    db.snapshot = (id) => {
      const i = ids.indexOf(id);
      return { data: toRaw(inGroup(snap(inputs[i] as GroupBalanceInput), id, names[i] ?? '')), error: null };
    };
    renderHome();
    const expected = [
      { text: 'Claim your items on 1 bill', color: colors.light.warning },
      { text: 'You owe $12.50', color: colors.light.text },
      { text: 'Settled up', color: colors.light.textMuted },
      { text: "You're owed $8.00", color: colors.light.success },
    ];
    for (const [i, e] of expected.entries()) {
      expect(captionColor(await screen.findByText(e.text))).toBe(e.color);
      expect(screen.getByRole('link', { name: `${names[i]}, 4 people, ${e.text}` })).toBeTruthy();
    }
    // Reading order follows my_groups.
    expect(screen.getAllByRole('link').map((l) => l.props.accessibilityLabel)).toEqual(
      expected.map((e, i) => `${names[i]}, 4 people, ${e.text}`),
    );
  });

  it('22: one snapshot failing: the other row shows its state, the failed one the people count, no alert', async () => {
    db.myGroups = () => ({ data: [TAHOE, groupRow(gid(1), { name: 'Flat' })], error: null });
    db.snapshot = (id) => (id === GROUP_ID ? { data: toRaw(snap(W2.input)), error: null } : { data: null, error: { code: '08006', message: SERVER_TEXT } });
    renderHome();
    expect(await screen.findByText("You're owed $82.77")).toBeTruthy();
    await waitFor(() => expect(calls('group_snapshot')).toHaveLength(2));
    expect(screen.getByRole('link', { name: 'Flat, 4 people' })).toBeTruthy();
    expect(captionColor(screen.getByText('4 people'))).toBe(colors.light.textMuted);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't load your groups.")).toBeNull();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
  });

  it('23: before the snapshot lands the row shows the people count; then the state replaces it', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    db.snapshot = () => new Promise<FakeResult>((r) => (resolve = r));
    renderHome();
    expect(await screen.findByRole('link', { name: 'Tahoe trip, 4 people' })).toBeTruthy();
    expect(screen.getByText('4 people')).toBeTruthy();
    await act(async () => resolve({ data: toRaw(snap(W2.input)), error: null }));
    expect(await screen.findByRole('link', { name: "Tahoe trip, 4 people, You're owed $82.77" })).toBeTruthy();
    expect(screen.queryByText('4 people')).toBeNull();
  });

  it('a failed snapshot read leaves the row as name + people count (no error, no avatars)', async () => {
    db.snapshot = () => ({ data: null, error: { code: '08006', message: SERVER_TEXT } });
    renderHome();
    expect(await screen.findByText('4 people')).toBeTruthy();
    await waitFor(() => expect(calls('group_snapshot')).toHaveLength(1));
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    expect(screen.queryByText('B', { includeHiddenElements: true })).toBeNull();
  });

  it('a row opens its group; "New group" opens the form', async () => {
    const router = renderHome();
    fireEvent.press(await screen.findByRole('link', { name: /^Tahoe trip/ }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    await act(async () => appRouter.back());
    fireEvent.press(await screen.findByRole('button', { name: 'New group' }));
    await waitFor(() => expect(router.getPathname()).toBe('/groups/new'));
  });

  it('a failed first load: "Couldn\'t load your groups." with Try again, which loads them', async () => {
    let fail = true;
    db.myGroups = () => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: [TAHOE], error: null });
    renderHome();
    expect(await screen.findByText("Couldn't load your groups.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Try loading groups again' }));
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
  });

  it('refetches on focus; a failed refetch keeps the list on screen', async () => {
    renderHome();
    fireEvent.press(await screen.findByRole('button', { name: 'New group' }));
    await screen.findByText('New group stand-in');
    db.myGroups = () => ({ data: null, error: { code: '08006', message: SERVER_TEXT } });
    await act(async () => appRouter.back());
    await waitFor(() => expect(calls('my_groups')).toHaveLength(2));
    expect(screen.getByText('Tahoe trip')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your groups.")).toBeNull();
  });

  it('a rename seen on refetch replaces the row title', async () => {
    renderHome();
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    db.myGroups = () => ({ data: [groupRow(GROUP_ID, { name: 'Tahoe 2026' })], error: null });
    db.snapshot = () => ({ data: toRaw(snap(W1.input, 'Tahoe 2026')), error: null });
    fireEvent.press(screen.getByRole('button', { name: 'New group' }));
    await screen.findByText('New group stand-in');
    await act(async () => appRouter.back());
    expect(await screen.findByText('Tahoe 2026')).toBeTruthy();
  });

  it('signing out clears the groups (per-user state)', async () => {
    renderHome();
    expect(await screen.findByText('Tahoe trip')).toBeTruthy();
    await act(async () => {
      await supabase.auth.signOut();
    });
    await waitFor(() => expect(screen.queryByText('Tahoe trip')).toBeNull());
    expect(screen.queryByText('Hidden groups (1)')).toBeNull();
  });
});

describe('GroupsSection: hidden groups', () => {
  async function openHidden() {
    const toggle = await screen.findByRole('button', { name: 'Hidden groups, 1 group' });
    expect(toggle.props.accessibilityState).toMatchObject({ expanded: false });
    fireEvent.press(toggle);
    expect(await screen.findByText('Old flat')).toBeTruthy();
  }

  it('Show / Hide folds the hidden list in and out', async () => {
    renderHome();
    await openHidden();
    expect(screen.getByText('2 people')).toBeTruthy();
    const hide = screen.getByRole('button', { name: 'Hidden groups, 1 group' });
    expect(hide.props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Hide', { includeHiddenElements: true })).toBeTruthy();
    fireEvent.press(hide);
    expect(screen.getByText('Tahoe trip')).toBeTruthy();
    expect(screen.queryByText('Old flat')).toBeNull();
  });

  it('Unhide: one write, the group moves to the list, the toggle goes; a failed refetch keeps it there', async () => {
    renderHome();
    await openHidden();
    db.myGroups = () => ({ data: null, error: { code: '08006', message: SERVER_TEXT } });
    fireEvent.press(screen.getByRole('button', { name: 'Unhide Old flat' }));
    await waitFor(() => expect(screen.getByRole('link', { name: /^Old flat/ })).toBeTruthy());
    expect(calls('set_group_hidden')).toEqual([['set_group_hidden', { p_group_id: HIDDEN_ID, p_hidden: false }]]);
    await waitFor(() => expect(calls('my_groups')).toHaveLength(2));
    expect(screen.getByRole('link', { name: /^Old flat/ })).toBeTruthy();
    expect(screen.queryByText(/Hidden groups/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unhide Old flat' })).toBeNull();
  });

  it('a double tap on Unhide sends once', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    db.setHidden = () => new Promise<FakeResult>((r) => (resolve = r));
    renderHome();
    await openHidden();
    const unhide = screen.getByRole('button', { name: 'Unhide Old flat' });
    // Both taps land before React re-renders (the button isn't disabled yet): only the ref guard stops the second.
    act(() => {
      fireEvent.press(unhide);
      fireEvent.press(unhide);
    });
    await waitFor(() => expect(calls('set_group_hidden')).toHaveLength(1));
    await act(async () => resolve({ data: null, error: null }));
    expect(await screen.findByRole('link', { name: /^Old flat/ })).toBeTruthy();
    expect(calls('set_group_hidden')).toHaveLength(1);
  });

  it('a failed Unhide: an alert, the group stays hidden, and Unhide works again', async () => {
    let fail = true;
    db.setHidden = () => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: null, error: null });
    renderHome();
    await openHidden();
    fireEvent.press(screen.getByRole('button', { name: 'Unhide Old flat' }));
    expect(await screen.findByText("Couldn't unhide that group. Try again.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    expect(screen.getByText('Old flat')).toBeTruthy();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Unhide Old flat' }));
    expect(await screen.findByRole('link', { name: /^Old flat/ })).toBeTruthy();
    expect(calls('set_group_hidden')).toHaveLength(2);
    expect(screen.queryByText("Couldn't unhide that group. Try again.")).toBeNull();
  });
});

describe.each(['ios', 'web'] as const)('New group on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  const field = () => screen.getByLabelText('Name');
  const create = () => screen.getByRole('button', { name: 'Create group' });

  it('63: a valid name calls create_group once (trimmed, client id) and lands on the group with the invite open', async () => {
    const router = renderRouter('./app', { initialUrl: '/groups/new' });
    expect(await screen.findByRole('header', { name: 'New group' })).toBeTruthy();
    fireEvent.changeText(field(), '  Tahoe trip\t');
    fireEvent.press(create());
    await waitFor(() => expect(router.getPathname()).toMatch(/^\/groups\/[0-9a-f-]{36}$/));
    const creates = calls('create_group');
    expect(creates).toHaveLength(1);
    const args = creates[0]?.[1] as { p_id: string; p_name: string };
    expect(args.p_name).toBe('Tahoe trip');
    expect(router.getPathname()).toBe(`/groups/${args.p_id}`);
    expect(router.getSearchParams()).toMatchObject({ invite: '1' });
  });

  it('63: blank, spaces only and 61 characters show the field error and send nothing', async () => {
    renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    fireEvent.press(create());
    expect(await screen.findByText('Give the group a name.')).toBeTruthy();
    fireEvent.changeText(field(), ' \t ');
    fireEvent(field(), 'submitEditing');
    expect(await screen.findByText('Give the group a name.')).toBeTruthy();
    fireEvent.changeText(field(), 'x'.repeat(61));
    fireEvent.press(create());
    expect(await screen.findByText('Keep the name to 60 characters or fewer.')).toBeTruthy();
    expect(calls('create_group')).toHaveLength(0);
  });

  it('60 emoji is a valid name (code points, C-G8)', async () => {
    const router = renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    // 120 UTF-16 units, 60 code points.
    fireEvent.changeText(field(), '🏔'.repeat(60));
    fireEvent.press(create());
    await waitFor(() => expect(router.getPathname()).toMatch(/^\/groups\//));
    // Let the form's header unmount settle before the test ends.
    await act(async () => {});
    expect(calls('create_group')).toHaveLength(1);
  });

  it('63: a double tap sends once', async () => {
    let resolve: (r: FakeResult) => void = () => {};
    let id = '';
    db.create = (args) => {
      id = String(args.p_id);
      return new Promise<FakeResult>((r) => (resolve = r));
    };
    const router = renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    fireEvent.changeText(field(), 'Tahoe trip');
    // All three land before React re-renders (nothing is disabled yet): only the ref guard stops the rest.
    act(() => {
      const button = create();
      const input = field();
      fireEvent.press(button);
      fireEvent.press(button);
      fireEvent(input, 'submitEditing');
    });
    await waitFor(() => expect(calls('create_group')).toHaveLength(1));
    await act(async () => resolve({ data: id, error: null }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${id}`));
    expect(calls('create_group')).toHaveLength(1);
  });

  it('a failed create keeps the name, re-enables the button, and the retry reuses the same id', async () => {
    let fail = true;
    db.create = (args) => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: args.p_id, error: null });
    const router = renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    fireEvent.changeText(field(), 'Tahoe trip');
    fireEvent.press(create());
    expect(await screen.findByText("Couldn't create the group. Check your connection and try again.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    expect(field().props.value).toBe('Tahoe trip');
    expect(create().props.accessibilityState).not.toMatchObject({ disabled: true });
    fail = false;
    fireEvent.press(create());
    await waitFor(() => expect(router.getPathname()).toMatch(/^\/groups\//));
    // Let the form's header unmount settle before the test ends.
    await act(async () => {});
    const [first, second] = calls('create_group').map(([, a]) => (a as { p_id: string }).p_id);
    expect(first).toBe(second);
  });

  it('a different name after a failure is a new intent with a new id', async () => {
    db.create = () => ({ data: null, error: { code: '08006', message: SERVER_TEXT } });
    renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    fireEvent.changeText(field(), 'Tahoe trip');
    fireEvent.press(create());
    await screen.findByText("Couldn't create the group. Check your connection and try again.");
    fireEvent.changeText(field(), 'Tahoe 2026');
    fireEvent.press(create());
    await waitFor(() => expect(calls('create_group')).toHaveLength(2));
    const [first, second] = calls('create_group').map(([, a]) => (a as { p_id: string }).p_id);
    expect(first).not.toBe(second);
  });

  it('the database refusing the name (22023 invalid_name) shows the field error', async () => {
    db.create = () => ({ data: null, error: { code: '22023', message: 'invalid_name' } });
    renderRouter('./app', { initialUrl: '/groups/new' });
    await screen.findByRole('header', { name: 'New group' });
    fireEvent.changeText(field(), 'Tahoe trip');
    fireEvent.press(create());
    expect(await screen.findByText('Keep the name to 60 characters or fewer.')).toBeTruthy();
  });

  it('signed out: /groups/new goes to sign-in and creates nothing', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter('./app', { initialUrl: '/groups/new' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(calls('create_group')).toHaveLength(0);
  });
});
