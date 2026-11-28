// The group screen and group Activity: spec docs/specs/2026-11-26-groups-mvp.md T14, criteria 66–69
// and 112 (A1 S9, S15), GR-M7. The data layer (lib/groups.ts) is mocked at its exported functions:
// its parser and error mapping are covered by lib/groups.test.ts, and the screen reads only what
// those functions return.
import { router as appRouter, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Platform, StyleSheet, Text } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import type { GroupError, GroupEvent, GroupResult, GroupSnapshot } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { clearGroupReceipt, getScanGroup } from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { GROUP_CLAIM_COPY } from '@/lib/groupClaimStatus';
import { colors } from '@/lib/theme';
import { AIRBNB_ID, ANA, BEN, BRUNCH_ID, brunchBill, DEE, DINNER_ID, dinnerBill, W1, W2 } from '@/test-utils/groupFixtures';
import { GROUP_ID, GROUP_NAME, snapshotOf, withNotPart } from '@/test-utils/groupSnapshotFixtures';

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
    fetchGroupSnapshot: jest.fn(),
    fetchGroupEvents: jest.fn(),
    renameGroup: jest.fn(),
    setGroupHidden: jest.fn(),
    leaveGroup: jest.fn(),
    setNotPart: jest.fn(),
  };
});

const supabase = realSupabase as unknown as FakeSupabase;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const fetchEvents = groups.fetchGroupEvents as jest.MockedFunction<typeof groups.fetchGroupEvents>;
const rename = groups.renameGroup as jest.MockedFunction<typeof groups.renameGroup>;
const setHidden = groups.setGroupHidden as jest.MockedFunction<typeof groups.setGroupHidden>;
const leave = groups.leaveGroup as jest.MockedFunction<typeof groups.leaveGroup>;
const setNotPart = groups.setNotPart as jest.MockedFunction<typeof groups.setNotPart>;

const EVE = 'eeeeeeee-0000-4000-8000-000000000005';
const FORMER = 'ffffffff-0000-4000-8000-000000000006';

type SnapResult = Awaited<ReturnType<typeof groups.fetchGroupSnapshot>>;
const ok = (snapshot: GroupSnapshot): SnapResult => ({ ok: true, snapshot });
const fail = (error: GroupError): { ok: false; error: GroupError } => ({ ok: false, error });
const done: GroupResult = { ok: true };

/** W1 with Eve, who joined last and is in nothing yet (so she may leave). */
function withEve(s: GroupSnapshot): GroupSnapshot {
  return { ...s, members: [...s.members, { userId: EVE, displayName: 'Eve', venmoUsername: null, joinedAt: '2026-11-20T13:00:00.000Z' }] };
}

/** What every fetch returns; a test swaps it (a value, a rejection, or a pending promise). */
let snapshotReply: () => Promise<SnapResult>;
const replyWith = (s: GroupSnapshot) => {
  snapshotReply = async () => ok(s);
};

function signInAs(userId: string) {
  const session = fakeSession('Ana');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function StandIn() {
  const params = useLocalSearchParams<{ id?: string; expense?: string }>();
  return <Text>{`Stand-in ${params.id ?? ''} ${params.expense ?? ''}`}</Text>;
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
    '(app)/(tabs)/index': HomeStandIn,
    '(app)/bills/[id]/index': StandIn,
    '(app)/groups/[id]/settle': StandIn,
    '(app)/groups/[id]/expense': StandIn,
    '(app)/scan': ScanStandIn,
  },
};

async function openGroup(path = `/groups/${GROUP_ID}`) {
  const router = renderRouter(ROUTES, { initialUrl: path });
  await screen.findByRole('button', { name: 'Settle up' });
  return router;
}

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const openOptions = () => press(screen.getByRole('button', { name: 'Group options' }));
const snapshotCalls = () => fetchSnapshot.mock.calls.length;

beforeEach(() => {
  jest.clearAllMocks();
  signInAs(ANA);
  replyWith(snapshotOf(W1.input));
  fetchSnapshot.mockImplementation(() => snapshotReply());
  fetchEvents.mockResolvedValue({ ok: true, events: [] });
  rename.mockResolvedValue(done);
  setHidden.mockResolvedValue(done);
  leave.mockResolvedValue(done);
  setNotPart.mockResolvedValue(done);
});

describe.each(['ios', 'web'] as const)('group screen (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('66/69: a cold deep link shows the status, one Settle up, the costs and no waiting lines (W1)', async () => {
    await openGroup();
    expect(fetchSnapshot).toHaveBeenCalledWith(GROUP_ID);
    // Exactly one title-level heading, the group name; the section labels are the others.
    expect(screen.getAllByRole('header', { name: GROUP_NAME })).toHaveLength(1);
    expect(screen.getByText('4 people')).toBeTruthy();
    // The status reads its amount in the words on screen.
    expect(screen.getByLabelText("You're owed $130.02")).toBeTruthy();
    expect(screen.getByText("You're owed")).toBeTruthy();
    expect(screen.getByText('$130.02')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Settle up' })).toHaveLength(1);
    // Cost rows, newest first: what it was, who paid, the viewer's share.
    expect(screen.getByLabelText('Your receipt, You paid $77.33, Your share $30.08')).toBeTruthy();
    expect(screen.getByLabelText('Airbnb, You paid $240.00, Your share $60.00')).toBeTruthy();
    expect(screen.getByLabelText("Ben's receipt, Ben paid $50.01, Your share $11.51")).toBeTruthy();
    // Positive control above (the costs landed), then the absence.
    expect(screen.queryByText('Not in balances yet')).toBeNull();
  });

  it('the ⋯ options button and Add carry their open state (expanded)', async () => {
    await openGroup();
    const options = () => screen.getByRole('button', { name: 'Group options' });
    const add = () => screen.getByRole('button', { name: 'Add a cost' });
    expect(options().props.accessibilityState?.expanded).toBe(false);
    expect(add().props.accessibilityState?.expanded).toBe(false);
    await openOptions();
    expect(options().props.accessibilityState?.expanded).toBe(true);
    await press(add());
    expect(add().props.accessibilityState?.expanded).toBe(true);
  });

  it('69: every control has a role and a name', async () => {
    await openGroup();
    await openOptions();
    await press(screen.getByRole('button', { name: 'Add a cost' }));
    expect(screen.getByRole('link', { name: /^Expense/ })).toBeTruthy();
    const controls = screen.UNSAFE_root.findAll(
      (n) => typeof n.type === 'string' && (n.props.accessibilityRole === 'button' || n.props.accessibilityRole === 'link'),
    );
    expect(controls.length).toBeGreaterThan(8);
    for (const c of controls) {
      const label = c.props.accessibilityLabel;
      const text = within(c).queryAllByText(/\S/);
      expect(typeof label === 'string' ? label.trim().length > 0 : text.length > 0).toBe(true);
    }
  });

  it('66 (S9): with W2 the waiting line names the row, says why, and opens the bill', async () => {
    signInAs(BEN);
    replyWith(snapshotOf(W2.input));
    const router = await openGroup();
    expect(screen.getByRole('header', { name: 'Not in balances yet' })).toBeTruthy();
    expect(screen.getByText("Ana's receipt: Nachos left to claim")).toBeTruthy();
    const line = screen.getByRole('link', { name: "Balances don't include Ana's receipt yet: Nachos left to claim" });
    // The waiting receipt's own cost row shows no share yet.
    expect(screen.getByLabelText("Ana's receipt, Ana paid $77.33, Your share isn't counted until everything is claimed")).toBeTruthy();
    await press(line);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${DINNER_ID}`));
  });

  it('Settle up and Activity open their screens', async () => {
    const router = await openGroup();
    await press(screen.getByRole('button', { name: 'Settle up' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/settle`));
    expect(await screen.findByText(`Stand-in ${GROUP_ID} `)).toBeTruthy();
  });

  it('112 (S15, after T17): Add offers Expense and Receipt, and Expense opens a new expense', async () => {
    clearGroupReceipt();
    const router = await openGroup();
    const add = screen.getByRole('button', { name: 'Add a cost' });
    expect(add.props.accessibilityState).toMatchObject({ expanded: false });
    await press(add);
    expect(screen.getByRole('button', { name: 'Add a cost' }).props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Airbnb, gas, tickets: one amount split between people')).toBeTruthy();
    expect(screen.getByText('Receipt')).toBeTruthy();
    expect(screen.getByText('Scan or type a receipt; everyone claims what they had')).toBeTruthy();
    await press(screen.getByRole('link', { name: /^Expense/ }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/expense`));
    // An expense isn't a receipt: no group is stored for the scan flow.
    expect(getScanGroup()).toBeNull();
  });

  it('112 (T17, GR-6): Receipt stores this group and opens Scan; coming back clears it', async () => {
    clearGroupReceipt();
    const router = await openGroup();
    await press(screen.getByRole('button', { name: 'Add a cost' }));
    const receipt = screen.getByRole('link', { name: 'Receipt: Scan or type a receipt; everyone claims what they had' });
    expect(receipt.props.accessibilityHint).toBe('Opens Scan. The new bill goes in this group.');
    await press(receipt);
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(await screen.findByText('Scan stand-in')).toBeTruthy();
    expect(getScanGroup()).toEqual({ groupId: GROUP_ID, name: GROUP_NAME });
    // Back on the group screen, the receipt flow was left.
    await act(async () => appRouter.back());
    await screen.findByRole('button', { name: 'Settle up' });
    expect(getScanGroup()).toBeNull();
  });

  it('T17 (GR-6): Scan to Home, then a new bill from Home, doesn\'t go in the group (cold link keeps the group screen below)', async () => {
    clearGroupReceipt();
    const router = await openGroup(); // a cold link: Home isn't under it, so Home is pushed above
    await press(screen.getByRole('button', { name: 'Add a cost' }));
    await press(screen.getByRole('link', { name: /^Receipt/ }));
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(getScanGroup()).not.toBeNull();
    await act(async () => appRouter.dismissTo('/'));
    expect(await screen.findByText('Home stand-in')).toBeTruthy();
    await act(async () => appRouter.push('/scan'));
    await act(async () => appRouter.push('/bill'));
    // The real bill form: positive control first, then the absence.
    expect(await screen.findByText('Type each line from the receipt. We check the totals as you go.')).toBeTruthy();
    expect(screen.queryByText(/^Goes in/)).toBeNull();
    expect(getScanGroup()).toBeNull();
  });

  it('C-G9: an expense opens for its payer; for anyone else its row is static', async () => {
    const router = await openGroup();
    await press(screen.getByRole('link', { name: 'Airbnb, You paid $240.00, Your share $60.00' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/expense`));
    expect(await screen.findByText(`Stand-in ${GROUP_ID} ${AIRBNB_ID}`)).toBeTruthy();
  });

  it('C-G9: Ben sees Ana\'s Airbnb as a static row, and receipts as links', async () => {
    signInAs(BEN);
    await openGroup();
    const airbnb = screen.getByLabelText('Airbnb, Ana paid $240.00, Your share $60.00');
    expect(airbnb.props.accessibilityRole).toBeUndefined();
    expect(screen.queryByRole('link', { name: /^Airbnb/ })).toBeNull();
    expect(screen.getByRole('link', { name: "Ana's receipt, Ana paid $77.33, Your share $27.49" })).toBeTruthy();
  });

  it('loading, then an error with a working Try again', async () => {
    let resolve: (r: SnapResult) => void = () => {};
    snapshotReply = () => new Promise((r) => (resolve = r));
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    expect(await screen.findByLabelText('Loading')).toBeTruthy();
    await act(async () => resolve(fail('network')));
    expect(await screen.findByText("Couldn't load the group.")).toBeTruthy();
    replyWith(snapshotOf(W1.input));
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeTruthy();
  });

  it('not a member: fixed copy and Go home, nothing from the URL', async () => {
    snapshotReply = async () => fail('not_allowed');
    const router = renderRouter(ROUTES, { initialUrl: '/groups/not-a-real-id' });
    expect(await screen.findByText("You're not in this group. Ask someone in it for the group's link.")).toBeTruthy();
    expect(screen.queryByText(/not-a-real-id/)).toBeNull();
    await press(screen.getByRole('button', { name: 'Go home' }));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('an empty group: just you, no costs, settled up, and no Leave (the only member)', async () => {
    const s = snapshotOf({ members: [ANA], bills: [], expenses: [], payments: [] } as unknown as typeof W1.input);
    replyWith({ ...s, members: s.members.slice(0, 1) });
    await openGroup();
    expect(screen.getByText('Just you')).toBeTruthy();
    expect(screen.getByLabelText("You're settled up")).toBeTruthy();
    expect(screen.getByText('No costs yet. Add the first one, like the Airbnb or gas.')).toBeTruthy();
    await openOptions();
    expect(screen.getByRole('button', { name: 'Rename group' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
  });

  it('signed out, a cold link to the group goes to sign-in and reads nothing', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  describe('group claim status (docs/specs/2026-11-27-group-claim-status.md T5)', () => {
    const TINT = colors.light.warningSurface;
    const bgOf = (n: ReactTestInstance): unknown => StyleSheet.flatten(n.props.style)?.backgroundColor;
    /** Whether `n` or one of its ancestors has the tint as its background. */
    const tinted = (n: ReactTestInstance): boolean => {
      for (let cur: ReactTestInstance | null = n; cur !== null; cur = cur.parent) if (bgOf(cur) === TINT) return true;
      return false;
    };
    /** The tinted (or not) block of one waiting row: the nearest host View holding the row's link. */
    const rowBlock = (linkName: RegExp): ReactTestInstance => {
      const link = screen.getByRole('link', { name: linkName });
      let cur: ReactTestInstance | null = link.parent;
      while (cur !== null && !(typeof cur.type === 'string' && cur.parent !== null && within(cur).queryAllByRole('button').length > 0)) cur = cur.parent;
      if (cur === null) throw new Error('no row block');
      return cur;
    };
    const DINNER_LINK = /^Balances don't include Ana's receipt yet: Nachos left to claim/;
    const DINNER_COST_NEEDS = "Ana's receipt, Ana paid $77.33, Claim your items, Your share isn't counted until everything is claimed";
    const DINNER_COST_PLAIN = "Ana's receipt, Ana paid $77.33, Your share isn't counted until everything is claimed";
    /** Dinner (nachos open) and Brunch (Dee's waffles open): both wait on Dee only. */
    const both = () => {
      const b = brunchBill();
      return snapshotOf({ ...W1.input, bills: [dinnerBill({ nachosClaimers: [] }), { ...b, split: { ...b.split, claims: b.split.claims.filter((c) => c.userId !== DEE) } }] });
    };

    beforeEach(() => {
      signInAs(DEE);
      replyWith(snapshotOf(W2.input));
    });

    it('25: a receipt that needs me is tinted, says so, opens the bill, and offers "I wasn\'t part of this"', async () => {
      const router = await openGroup();
      const title = screen.getByText("Ana's receipt: Nachos left to claim");
      const caption = screen.getByText("You haven't claimed anything here yet");
      expect(tinted(title)).toBe(true);
      expect(tinted(caption)).toBe(true);
      const notPart = screen.getByRole('button', { name: "I wasn't part of this" });
      expect(notPart.props.accessibilityHint).toBe("Stops reminding you about this receipt. It doesn't change anyone's share.");
      expect(tinted(notPart)).toBe(true);
      // The cost row: tinted, "· Claim your items" in its caption and label. Expenses never tinted.
      expect(screen.getByText('Ana paid $77.33 · Claim your items')).toBeTruthy();
      expect(bgOf(screen.getByRole('link', { name: DINNER_COST_NEEDS }))).toBe(TINT);
      const airbnb = screen.getByLabelText(/^Airbnb, /);
      expect(tinted(airbnb)).toBe(false);
      // The row and the link are separate targets: the link isn't inside the row's link.
      const row = screen.getByRole('link', { name: DINNER_LINK });
      expect(row.props.accessibilityLabel).toBe("Balances don't include Ana's receipt yet: Nachos left to claim. You haven't claimed anything here yet");
      expect(within(row).queryByRole('button', { name: "I wasn't part of this" })).toBeNull();
      await press(row);
      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${DINNER_ID}`));
    });

    it('25: a waiting receipt I claimed on has neither the tint nor the link (positive control first)', async () => {
      signInAs(BEN);
      await openGroup();
      const title = screen.getByText("Ana's receipt: Nachos left to claim");
      expect(tinted(title)).toBe(false);
      expect(screen.queryByRole('button', { name: "I wasn't part of this" })).toBeNull();
      expect(screen.queryByText("You haven't claimed anything here yet")).toBeNull();
      expect(bgOf(screen.getByRole('link', { name: DINNER_COST_PLAIN }))).not.toBe(TINT);
    });

    it('26: one write per double tap, busy until the refetch, then "You weren\'t part of this" with Undo; Undo brings it back', async () => {
      let resolveWrite: (r: GroupResult) => void = () => {};
      setNotPart.mockImplementation(() => new Promise((r) => (resolveWrite = r)));
      await openGroup();
      const link = screen.getByRole('button', { name: "I wasn't part of this" });
      await press(link);
      await press(link);
      expect(setNotPart).toHaveBeenCalledTimes(1);
      expect(setNotPart).toHaveBeenCalledWith(DINNER_ID, true);
      expect(screen.getByRole('button', { name: "I wasn't part of this" }).props.accessibilityState).toMatchObject({ busy: true });

      let resolveRefetch: (r: SnapResult) => void = () => {};
      snapshotReply = () => new Promise((r) => (resolveRefetch = r));
      const before = snapshotCalls();
      await act(async () => resolveWrite(done));
      expect(snapshotCalls()).toBe(before + 1);
      expect(screen.getByRole('button', { name: "I wasn't part of this" }).props.accessibilityState).toMatchObject({ busy: true });
      await act(async () => resolveRefetch(ok(withNotPart(snapshotOf(W2.input), [DINNER_ID]))));

      const caption = await screen.findByText("You weren't part of this");
      expect(tinted(caption)).toBe(false);
      expect(tinted(screen.getByText("Ana's receipt: Nachos left to claim"))).toBe(false);
      expect(bgOf(screen.getByRole('link', { name: DINNER_COST_PLAIN }))).not.toBe(TINT);
      expect(screen.getByRole('link', { name: "Balances don't include Ana's receipt yet: Nachos left to claim. You weren't part of this" })).toBeTruthy();
      expect(screen.queryByRole('button', { name: "I wasn't part of this" })).toBeNull();
      const undo = screen.getByRole('button', { name: 'Undo, I was part of this' });
      expect(undo.props.accessibilityHint).toBe('Reminds you to claim your items on this receipt again');

      setNotPart.mockResolvedValue(done);
      replyWith(snapshotOf(W2.input));
      await press(undo);
      expect(setNotPart).toHaveBeenLastCalledWith(DINNER_ID, false);
      expect(await screen.findByText("You haven't claimed anything here yet")).toBeTruthy();
      expect(tinted(screen.getByText("Ana's receipt: Nachos left to claim"))).toBe(true);
      expect(screen.getByRole('button', { name: "I wasn't part of this" })).toBeTruthy();
    });

    it('GCS-16: with two receipts, each "I wasn\'t part of this" sits in its own bill\'s card, with that bill\'s row only', async () => {
      replyWith(both());
      await openGroup();
      const links = screen.getAllByRole('button', { name: "I wasn't part of this" });
      expect(links).toHaveLength(2);
      /** The nearest rounded (card) ancestor of `n`. */
      const cardOf = (n: ReactTestInstance): ReactTestInstance => {
        for (let cur: ReactTestInstance | null = n.parent; cur !== null; cur = cur.parent) {
          if (typeof cur.type === 'string' && StyleSheet.flatten(cur.props.style)?.borderRadius !== undefined && within(cur).queryAllByRole('link').length > 0) return cur;
        }
        throw new Error('no card');
      };
      const rowsIn = (card: ReactTestInstance) => within(card).getAllByRole('link', { name: /^Balances don't include/ }).map((r) => r.props.accessibilityLabel);
      const [first, second] = links.map(cardOf);
      expect(first).not.toBe(second);
      expect(rowsIn(first!)).toHaveLength(1);
      expect(rowsIn(second!)).toHaveLength(1);
      expect(rowsIn(first!)).not.toEqual(rowsIn(second!));
      expect(bgOf(first!)).toBe(TINT);
      expect(bgOf(second!)).toBe(TINT);
    });

    it('26: while one not-part write is out, only its link is busy and the other link starts nothing', async () => {
      replyWith(both());
      let resolveWrite: (r: GroupResult) => void = () => {};
      setNotPart.mockImplementation(() => new Promise((r) => (resolveWrite = r)));
      await openGroup();
      const links = screen.getAllByRole('button', { name: "I wasn't part of this" });
      expect(links).toHaveLength(2);
      await press(links[0]!);
      await press(links[1]!);
      expect(setNotPart).toHaveBeenCalledTimes(1);
      expect(setNotPart).toHaveBeenCalledWith(DINNER_ID, true);
      const [first, second] = screen.getAllByRole('button', { name: "I wasn't part of this" });
      expect(first!.props.accessibilityState).toMatchObject({ busy: true });
      expect(second!.props.accessibilityState?.busy).toBeFalsy();
      replyWith(withNotPart(both(), [DINNER_ID]));
      await act(async () => resolveWrite(done));
      expect(await screen.findByRole('button', { name: 'Undo, I was part of this' })).toBeTruthy();
      const order = () => screen.getAllByRole('link', { name: /^Balances don't include/ }).map((n) => n.props.accessibilityLabel);
      // Review R4: the row the person just acted on stays where it was until the screen is shown again.
      expect(order()).toEqual([
        "Balances don't include Ana's receipt yet: Nachos left to claim. You weren't part of this",
        "Balances don't include Ben's receipt yet: Waffles left to claim. You haven't claimed anything here yet",
      ]);
      // Leave and come back: the focus refetch puts the needs-me line first (GCS-9).
      await press(screen.getByRole('link', { name: /^Balances don't include Ben's receipt/ }));
      await screen.findByText(`Stand-in ${BRUNCH_ID} `);
      act(() => appRouter.back());
      await waitFor(() =>
        expect(order()).toEqual([
          "Balances don't include Ben's receipt yet: Waffles left to claim. You haven't claimed anything here yet",
          "Balances don't include Ana's receipt yet: Nachos left to claim. You weren't part of this",
        ]),
      );
    });

    it('27: has_claims shows its words under that row and refetches', async () => {
      replyWith(both());
      setNotPart.mockResolvedValue(fail('has_claims'));
      await openGroup();
      const before = snapshotCalls();
      await press(screen.getAllByRole('button', { name: "I wasn't part of this" })[0]!);
      const error = await screen.findByText(GROUP_CLAIM_COPY.hasClaims);
      expect(error.props.accessibilityRole).toBe('alert');
      // Under Dinner's row, not Brunch's.
      expect(within(rowBlock(DINNER_LINK)).getByText(GROUP_CLAIM_COPY.hasClaims)).toBeTruthy();
      expect(within(rowBlock(/^Balances don't include Ben's receipt/)).queryByText(GROUP_CLAIM_COPY.hasClaims)).toBeNull();
      await waitFor(() => expect(snapshotCalls()).toBe(before + 1));
      // Review R1: the refusal's own refetch keeps the words; a later snapshot (here, coming back to
      // the screen after claiming on the bill) clears them, since they may no longer be true.
      expect(screen.getByText(GROUP_CLAIM_COPY.hasClaims)).toBeTruthy();
      await press(screen.getByRole('link', { name: DINNER_LINK }));
      await screen.findByText(`Stand-in ${DINNER_ID} `);
      act(() => appRouter.back());
      await waitFor(() => expect(snapshotCalls()).toBe(before + 2));
      // Positive control: the screen is back with the same rows, then the words are gone.
      expect(await screen.findByRole('link', { name: DINNER_LINK })).toBeTruthy();
      await waitFor(() => expect(screen.queryByText(GROUP_CLAIM_COPY.hasClaims)).toBeNull());
    });

    it('27: a network failure shows the network copy, re-enables the link and does not refetch', async () => {
      setNotPart.mockResolvedValue(fail('network'));
      await openGroup();
      const before = snapshotCalls();
      await press(screen.getByRole('button', { name: "I wasn't part of this" }));
      expect(await screen.findByText(groups.GROUP_ERROR_COPY.network)).toBeTruthy();
      const link = screen.getByRole('button', { name: "I wasn't part of this" });
      expect(link.props.accessibilityState?.busy).toBeFalsy();
      expect(link.props.accessibilityState?.disabled).toBeFalsy();
      expect(snapshotCalls()).toBe(before);
      setNotPart.mockResolvedValue(done);
      await press(link);
      expect(setNotPart).toHaveBeenCalledTimes(2);
      // A new attempt clears the old error.
      await waitFor(() => expect(screen.queryByText(groups.GROUP_ERROR_COPY.network)).toBeNull());
    });

    it('27: a write that lands but whose refetch fails shows "Couldn\'t refresh" and re-enables the link', async () => {
      await openGroup();
      snapshotReply = async () => fail('network');
      await press(screen.getByRole('button', { name: "I wasn't part of this" }));
      expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
      const link = screen.getByRole('button', { name: "I wasn't part of this" });
      expect(link.props.accessibilityState?.busy).toBeFalsy();
      expect(link.props.accessibilityState?.disabled).toBeFalsy();
    });

    it('28: an opt-out changes no balance: the same status with and without it', async () => {
      await openGroup();
      const status = screen.getByLabelText(/^You('re| owe)/).props.accessibilityLabel as string;
      expect(status).toMatch(/\$/); // positive control: an amount is shown
      replyWith(withNotPart(snapshotOf(W2.input), [DINNER_ID]));
      await press(screen.getByRole('button', { name: "I wasn't part of this" }));
      await screen.findByText("You weren't part of this");
      expect(screen.getByLabelText(status)).toBeTruthy();
    });
  });

  describe('invite (T13 hand-off)', () => {
    it('?invite=1 opens the invite panel; Close invite closes it', async () => {
      await openGroup(`/groups/${GROUP_ID}?invite=1`);
      expect(screen.getByRole('header', { name: 'Invite people' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
      await press(screen.getByRole('button', { name: 'Close invite' }));
      expect(screen.queryByRole('header', { name: 'Invite people' })).toBeNull();
    });

    it('any other invite value is ignored, and Invite people in the options opens it', async () => {
      await openGroup(`/groups/${GROUP_ID}?invite=yes`);
      // Positive control: the screen is there; then the absence.
      expect(screen.getByRole('header', { name: GROUP_NAME })).toBeTruthy();
      expect(screen.queryByRole('header', { name: 'Invite people' })).toBeNull();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Invite people' }));
      expect(screen.getByRole('header', { name: 'Invite people' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Rename group' })).toBeNull();
    });

    it('a new link refetches the group', async () => {
      supabase.__setRpc((fn) => (fn === 'rotate_group_code' ? { data: 'abcdefabcdefabcdefab', error: null } : { data: null, error: null }));
      await openGroup(`/groups/${GROUP_ID}?invite=1`);
      const before = snapshotCalls();
      await press(screen.getByRole('button', { name: 'Make a new link' }));
      await press(screen.getByRole('button', { name: 'Make new link' }));
      await waitFor(() => expect(snapshotCalls()).toBe(before + 1));
    });
  });

  describe('rename', () => {
    it('the same name sends nothing; a blank name shows the field error and sends nothing', async () => {
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Rename group' }));
      const field = screen.getByLabelText('Group name');
      expect(field.props.value).toBe(GROUP_NAME);
      fireEvent.changeText(field, `  ${GROUP_NAME}\t`);
      await press(screen.getByRole('button', { name: 'Save name' }));
      expect(rename).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Group name')).toBeNull();

      await openOptions();
      await press(screen.getByRole('button', { name: 'Rename group' }));
      fireEvent.changeText(screen.getByLabelText('Group name'), '   ');
      await press(screen.getByRole('button', { name: 'Save name' }));
      expect(screen.getByText('Give the group a name of up to 60 characters.')).toBeTruthy();
      expect(rename).not.toHaveBeenCalled();
    });

    it('a new name saves once (double tap), stays busy until the refetch, then shows', async () => {
      let resolveRename: (r: GroupResult) => void = () => {};
      rename.mockImplementation(() => new Promise((r) => (resolveRename = r)));
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Rename group' }));
      fireEvent.changeText(screen.getByLabelText('Group name'), 'Cabin weekend');
      const save = screen.getByRole('button', { name: 'Save name' });
      await press(save);
      await press(save);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledWith(GROUP_ID, 'Cabin weekend');
      expect(screen.getByRole('button', { name: 'Save name' }).props.accessibilityState).toMatchObject({ busy: true });

      let resolveRefetch: (r: SnapResult) => void = () => {};
      snapshotReply = () => new Promise((r) => (resolveRefetch = r));
      const before = snapshotCalls();
      await act(async () => resolveRename(done));
      expect(snapshotCalls()).toBe(before + 1);
      // Still busy while the refetch is out.
      expect(screen.getByRole('button', { name: 'Save name' }).props.accessibilityState).toMatchObject({ busy: true });
      await act(async () => resolveRefetch(ok(snapshotOf(W1.input, { groupName: 'Cabin weekend' }))));
      expect(await screen.findByRole('header', { name: 'Cabin weekend' })).toBeTruthy();
      expect(screen.queryByLabelText('Group name')).toBeNull();
      expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
    });

    it('a failed save keeps the typed name and re-enables Save', async () => {
      rename.mockResolvedValue(fail('network'));
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Rename group' }));
      fireEvent.changeText(screen.getByLabelText('Group name'), 'Cabin weekend');
      await press(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
      expect(screen.getByLabelText('Group name').props.value).toBe('Cabin weekend');
      const save = screen.getByRole('button', { name: 'Save name' });
      expect(save.props.accessibilityState?.busy).toBeFalsy();
      expect(save.props.accessibilityState?.disabled).toBeFalsy();
      rename.mockResolvedValue(done);
      await press(save);
      expect(rename).toHaveBeenCalledTimes(2);
    });

    it('68: a failed refetch after the write re-enables everything and offers a working retry', async () => {
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Rename group' }));
      fireEvent.changeText(screen.getByLabelText('Group name'), 'Cabin weekend');
      snapshotReply = async () => fail('network');
      await press(screen.getByRole('button', { name: 'Save name' }));
      expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
      // Nothing is stuck: the old data stays, the options and Settle up work.
      expect(screen.getByRole('header', { name: GROUP_NAME })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Group options' }).props.accessibilityState?.disabled).toBeFalsy();
      expect(screen.getByRole('button', { name: 'Settle up' }).props.accessibilityState?.disabled).toBeFalsy();
      replyWith(snapshotOf(W1.input, { groupName: 'Cabin weekend' }));
      await press(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('header', { name: 'Cabin weekend' })).toBeTruthy();
      expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
    });
  });

  describe('hide', () => {
    it('Hide for me writes, then shows the hidden line with Unhide; Unhide writes back', async () => {
      await openGroup();
      await openOptions();
      replyWith({ ...snapshotOf(W1.input), me: { hidden: true, notPartBillIds: [] } });
      await press(screen.getByRole('button', { name: 'Hide for me' }));
      expect(setHidden).toHaveBeenCalledWith(GROUP_ID, true);
      expect(await screen.findByText('Hidden from your Home. Others still see it.')).toBeTruthy();
      await openOptions();
      expect(screen.getByRole('button', { name: 'Rename group' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Hide for me' })).toBeNull();
      replyWith(snapshotOf(W1.input));
      await press(screen.getByRole('button', { name: 'Unhide' }));
      expect(setHidden).toHaveBeenLastCalledWith(GROUP_ID, false);
      await waitFor(() => expect(screen.queryByText('Hidden from your Home. Others still see it.')).toBeNull());
    });
  });

  describe('leave (67)', () => {
    it('is offered only when canLeave', async () => {
      await openGroup();
      await openOptions();
      expect(screen.getByRole('button', { name: 'Rename group' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
    });

    it('asks inline, then leaves and goes Home', async () => {
      signInAs(EVE);
      replyWith(withEve(snapshotOf(W1.input)));
      const router = await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Leave group' }));
      expect(screen.getByText("Leave Tahoe trip? You'll need the group's link to come back.")).toBeTruthy();
      expect(leave).not.toHaveBeenCalled();
      await press(screen.getByRole('button', { name: 'Leave group' }));
      expect(leave).toHaveBeenCalledWith(GROUP_ID);
      await waitFor(() => expect(router.getPathname()).toBe('/'));
    });

    it('cannot_leave from the DB shows why and offers Hide instead', async () => {
      signInAs(EVE);
      replyWith(withEve(snapshotOf(W1.input)));
      leave.mockResolvedValue(fail('cannot_leave'));
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Leave group' }));
      await press(screen.getByRole('button', { name: 'Leave group' }));
      expect(await screen.findByText("You can't leave this group because you're part of its costs. You can hide it instead.")).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
      await press(screen.getByRole('button', { name: 'Hide for me' }));
      expect(setHidden).toHaveBeenCalledWith(GROUP_ID, true);
    });

    it('a refetch that makes the viewer part of a cost takes the confirm away (no stale Leave)', async () => {
      signInAs(EVE);
      replyWith(withEve(snapshotOf(W1.input)));
      await openGroup();
      await openOptions();
      await press(screen.getByRole('button', { name: 'Leave group' }));
      expect(screen.getByText(/^Leave Tahoe trip\?/)).toBeTruthy();
      // Someone adds Eve to the Airbnb meanwhile; she comes back to the screen (focus refetch).
      const s = withEve(snapshotOf(W1.input));
      replyWith({
        ...s,
        expenses: s.expenses.map((e) => (e.id === AIRBNB_ID ? { ...e, shares: [...e.shares.slice(0, 3), { userId: EVE, cents: e.shares[3]!.cents }] } : e)),
      });
      await press(screen.getByRole('link', { name: 'Activity' }));
      await screen.findByRole('header', { name: 'Activity' });
      await press(screen.getByRole('button', { name: 'Back to group' }));
      await waitFor(() => expect(screen.queryByText(/^Leave Tahoe trip\?/)).toBeNull());
      // The options list is back, without Leave.
      expect(screen.getByRole('button', { name: 'Rename group' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Leave group' })).toBeNull();
    });
  });
});

describe.each(['ios', 'web'] as const)('group Activity (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const event = (seq: number, actorId: string | null, kind: string, details: unknown = {}): GroupEvent => ({
    id: `0e000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    actorId,
    kind,
    details,
    createdAt: '2026-11-20T12:00:00.000Z',
  });

  it('a cold link shows sentences in seq order, names from the snapshot, and "A former member" (GR-M7)', async () => {
    fetchEvents.mockResolvedValue({
      ok: true,
      events: [
        event(5, BEN, 'expense_added', { expense_id: AIRBNB_ID, amount_cents: 24000 }),
        event(4, FORMER, 'member_left'),
        event(3, FORMER, 'member_joined'),
        event(2, null, 'unknown_kind'),
        event(1, ANA, 'group_created', { name: 'Tahoe trip' }),
      ],
    });
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/activity` });
    expect(await screen.findByText('You created Tahoe trip')).toBeTruthy();
    expect(screen.getAllByRole('header', { name: 'Activity' })).toHaveLength(1);
    const sentences = screen
      .getAllByText(/Airbnb|former member|created/)
      .map((n) => n.props.children as string);
    expect(sentences).toEqual(['Ben added Airbnb, $240.00', 'A former member left', 'A former member joined', 'You created Tahoe trip']);
    expect(fetchEvents).toHaveBeenCalledWith(GROUP_ID);
  });

  it('empty, and an error with a working Try again', async () => {
    fetchEvents.mockResolvedValueOnce(fail('network'));
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/activity` });
    expect(await screen.findByText("Couldn't load the activity.")).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing yet. Costs, payments and people joining will show up here.')).toBeTruthy();
  });

  it('Back returns to the group on a cold link', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/activity` });
    await screen.findByText('Nothing yet. Costs, payments and people joining will show up here.');
    await press(screen.getByRole('button', { name: 'Back to group' }));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    expect(await screen.findByRole('button', { name: 'Settle up' })).toBeTruthy();
  });
});
