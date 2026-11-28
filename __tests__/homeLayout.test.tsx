// Home's layout: the sticky bottom bar (criteria 31–36) and the rows, sections and people counts
// (criteria 37–47) of docs/specs/2026-11-26-home-mobile-refresh.md (Tasks 5 and 6). Every flow runs
// on native and on web (lessons log 2026-11-19 and 2026-11-24: entry paths on both platforms).
// The viewer is B; Hana (A) hosts and pays unless a fixture says otherwise.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import {
  AccessibilityInfo,
  AppState,
  Platform,
  ScrollView,
  StyleSheet,
  type AppStateStatus,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { Button } from '@/components/ui/Button';
import { DISCLOSURE_ROW_MARGIN, DisclosureRow } from '@/components/ui/DisclosureRow';
import { FIRST_SETTLE_WAIT_MS } from '@/lib/homeSections';
import * as scanSession from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors, ROW_MIN_HEIGHT, space, TOUCH_TARGET, type } from '@/lib/theme';
import { fakeSession, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';
import { outsideTabBar, TAB_BAR_TEST_ID } from '@/test-utils/tabBar';

// The live tab bar also reads the Activity and Groups badges; quiet those reads so this file's
// supabase call logs hold only Home's own. The Tabs count stays real.
jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
// expo-router's test root gives every inset as 0 (ExpoRoot's INITIAL_METRICS under NODE_ENV=test),
// and its own SafeAreaProvider sits inside any wrapper a test could pass. So criterion 32 sets the
// insets the hook returns here; 0 everywhere unless a test says otherwise.
const mockInsets = { top: 0, right: 0, bottom: 0, left: 0 };
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual<typeof import('react-native-safe-area-context')>('react-native-safe-area-context');
  return { ...actual, useSafeAreaInsets: () => mockInsets };
});

const supabase = realSupabase as unknown as FakeSupabase;
const ROUTES = './app';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const X = '11111111-1111-4111-8111-111111111111';

// Midday UTC, so the short date is "Nov 20" in any test-machine time zone from UTC-11 to UTC+11.
const CREATED = '2026-11-20T12:00:00Z';
const INTRO = 'Take a photo of the receipt, then check the items it found.';
const TYPE_ITEMS = 'Type items instead';
const ADD_RECEIPT = 'Add receipt';
const ADD_RECEIPT_LABEL = 'Add receipt, opens a photo or typing the items';

type Row = {
  bill_id: string;
  host_id: string;
  host_name: string | null;
  payer_id: string;
  total_cents: number;
  created_at: string;
  joined_at: string;
  added: boolean;
  seen: boolean;
  claimed_any: boolean;
  complete: boolean;
};

/** A my_bills() row; by default 'new' (added by Hana, not opened, nothing claimed). */
function mine(bill_id: string, over: Partial<Row> = {}): Row {
  return {
    bill_id,
    host_id: A,
    host_name: 'Hana',
    payer_id: A,
    total_cents: 4480,
    created_at: CREATED,
    joined_at: '2026-11-20T12:05:00Z',
    added: true,
    seen: false,
    claimed_any: false,
    complete: false,
    ...over,
  };
}

const server: { rows: Row[]; myBills: (() => FakeResult | Promise<FakeResult>) | null; venmoPending: boolean } = {
  rows: [],
  myBills: null,
  venmoPending: false,
};

/** my_groups() rows; none unless a test seeds some. */
let myGroups: Record<string, unknown>[] = [];
const TAHOE_ID = '9a000000-0000-4000-8000-000000000001';
const TAHOE = { id: TAHOE_ID, name: 'Tahoe trip', member_count: 4, joined_at: CREATED, hidden: false };

function signInAs(userId: string) {
  const session = fakeSession('Bo Bo');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

/** The nearest host View above `node` whose flattened style passes `test`. */
function viewAbove(node: ReturnType<typeof screen.getByText>, test: (s: ViewStyle) => boolean) {
  let n = node.parent;
  while (n) {
    const style = StyleSheet.flatten(n.props.style as StyleProp<ViewStyle>);
    if (String(n.type) === 'View' && style && test(style)) return { node: n, style };
    n = n.parent;
  }
  throw new Error('no matching view');
}

/** The tab bar (components/TabBar.tsx): it replaced the sticky bar (tab-bar spec Task 5, HOME-ADD-1 → FEED-19). */
const barOf = () => {
  const node = screen.getByTestId(TAB_BAR_TEST_ID);
  return { node, style: StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) };
};
/** The tab bar's (+). */
const addButton = () => screen.getByRole('button', { name: ADD_RECEIPT_LABEL });

const primaryButtons = () => screen.UNSAFE_queryAllByType(Button).filter((b) => b.props.variant === 'primary');

async function openHome() {
  const router = renderRouter(ROUTES, { initialUrl: '/' });
  await screen.findByRole('header', { name: 'SplitIt' });
  await waitFor(() => expect(screen.queryByLabelText('Loading your bills')).toBeNull());
  return router;
}

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  Object.assign(mockInsets, { top: 0, right: 0, bottom: 0, left: 0 });
  signInAs(B);
  scanSession.clearScanResult();
  server.rows = [mine(X)];
  server.myBills = null;
  server.venmoPending = false;
  myGroups = [];
  supabase.__setRpc((fn) => {
    if (fn === 'my_bills') return server.myBills ? server.myBills() : { data: server.rows.map((r) => ({ ...r })), error: null };
    if (fn === 'venmo_prompt_pending') return { data: server.venmoPending, error: null };
    // GroupsSection on Home reads these; no groups unless a test seeds some (__tests__/homeGroups.test.tsx).
    if (fn === 'my_groups') return { data: myGroups.map((g) => ({ ...g })), error: null };
    return { data: null, error: null };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Tab-bar spec (docs/specs/2026-11-28-tab-bar-and-activity.md) Task 5/6: the sticky "Split a bill" bar
// (criteria 31–33 of the home-mobile-refresh spec) is replaced by the tab bar's (+). These are its
// tests rewritten for (+); the bar's own tests are in __tests__/tabBar.test.tsx.
describe.each(['ios', 'web'] as const)('Home and the tab bar\'s (+) (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('31: (+) sits in the tab bar, outside Home\'s ScrollView; the "Split a bill" bar and heading are gone', async () => {
    await openHome();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    const add = addButton();
    expect(scroll.findAll((n) => n === add)).toEqual([]);
    expect(barOf().node.findAll((n) => n === add)).toHaveLength(1);
    expect(screen.queryByRole('header', { name: 'Split a bill' })).toBeNull();
    expect(screen.queryByText('Split a bill')).toBeNull();
    // The visible "Add receipt" button text went with the bar: (+) is an icon with its label.
    expect(screen.queryByText(ADD_RECEIPT)).toBeNull();
    // 2026-11-27: no second way in on Home; the scan screen offers typing the items.
    expect(screen.queryByText(TYPE_ITEMS)).toBeNull();
    expect(screen.queryByText('Scan receipt')).toBeNull();
  });

  it.each<[string, () => void, () => Promise<unknown>]>([
    ['loading', () => (server.myBills = () => new Promise<FakeResult>(() => {})), () => screen.findByLabelText('Loading your bills')],
    ['error', () => (server.myBills = () => ({ data: null, error: { code: '08006', message: 'x' } })), () => screen.findByText("Couldn't load your bills.")],
    ['empty', () => (server.rows = []), () => screen.findByText('No bills yet.')],
    ['with the added-you card', () => {}, () => screen.findByText('Hana added you to a bill')],
    ['with the Venmo prompt', () => (server.venmoPending = true), () => screen.findByLabelText('Add Venmo')],
  ])('31: (+) is there and Home has no primary button of its own (%s)', async (_state, arrange, shown) => {
    arrange();
    renderRouter(ROUTES, { initialUrl: '/' });
    await shown();
    expect(addButton()).toBeTruthy();
    expect(primaryButtons()).toHaveLength(0);
  });

  it.each([34, 0])('32: with a bottom inset of %d the tab bar pads it (at least space.sm); the scroll pads space.xl', async (bottom) => {
    mockInsets.bottom = bottom;
    await openHome();
    expect(barOf().style.paddingBottom).toBe(Math.max(bottom, space.sm));
    const scroll = screen.UNSAFE_getByType(ScrollView);
    const content = StyleSheet.flatten(scroll.props.contentContainerStyle as StyleProp<ViewStyle>);
    expect(content.paddingBottom).toBe(space.xl);
  });

  it('33: (+) says what it does in its label and pushes /scan once, even on a double tap', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openHome();
    // react-native-web drops hints, so the label carries it (tab-bar spec Contract C).
    expect(addButton().props.accessibilityLabel).toBe(ADD_RECEIPT_LABEL);
    await act(async () => {
      fireEvent.press(addButton());
      fireEvent.press(addButton());
    });
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(push.mock.calls).toEqual([['/scan']]);
  });

  it('35: the intro line is gone', async () => {
    await openHome();
    expect(addButton()).toBeTruthy(); // the way in is there
    expect(screen.queryByText(INTRO)).toBeNull();
  });

  it('36: Home mounting with a new bill does not navigate', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const replace = jest.spyOn(globalRouter, 'replace');
    const router = await openHome();
    await screen.findByText('Hana added you to a bill');
    await act(async () => {
      await Promise.resolve();
    });
    expect(router.getPathname()).toBe('/');
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 6: rows, sections and people counts (criteria 37–47).
// ---------------------------------------------------------------------------

const C = '00000000-0000-4000-8000-00000000000c';
const Y = '11111111-1111-4111-8111-222222222222';
const Z = '11111111-1111-4111-8111-333333333333';
const W = '11111111-1111-4111-8111-444444444444';
const CODE = '0123456789abcdef0123';
const SETTLE_TABLES = ['bills', 'line_items', 'bill_participants', 'claims'] as const;
type SettleTable = (typeof SETTLE_TABLES)[number];
type RawRow = Record<string, unknown>;
type Person = { user: string; cents: number; marked?: number };
const NAMES: Record<string, string> = { [A]: 'Hana', [B]: 'Bo', [C]: 'Cy' };

/**
 * One bill's settle tables: each person claims one item of `cents`; `unclaimed` adds one more item
 * nobody claimed (so the bill isn't complete and the plan is 'early'). `payer` hosts and pays (Hana
 * unless given).
 */
function settleBill(id: string, people: Person[], unclaimed = 0, payer = A): Record<SettleTable, RawRow[]> {
  const items = [...people.map((p) => p.cents), ...(unclaimed > 0 ? [unclaimed] : [])];
  const itemId = (i: number) => `${id.slice(0, -2)}${String(10 + i)}`;
  return {
    bills: [
      {
        id,
        host_id: payer,
        payer_id: payer,
        subtotal_cents: null,
        tax_cents: 0,
        fees_cents: 0,
        tip_cents: 0,
        subtotal_discount_cents: 0,
        total_discount_cents: 0,
        total_cents: items.reduce((sum, c) => sum + c, 0),
        join_code: CODE,
        created_at: CREATED,
        edited_at: null,
        extras_split: 'proportional',
      },
    ],
    line_items: items.map((cents, i) => ({
      bill_id: id,
      id: itemId(i),
      name: `Item ${i + 1}`,
      note: null,
      group_position: i,
      unit_index: 0,
      group_size: 1,
      total_cents: cents,
      split_set_by: null,
      split_set_at: null,
    })),
    bill_participants: people.map((p) => ({
      bill_id: id,
      user_id: p.user,
      joined_at: CREATED,
      settled_at: p.marked === undefined ? null : '2026-11-21T12:00:00Z',
      settled_cents: p.marked ?? null,
      profile: { display_name: NAMES[p.user] ?? null, venmo_username: null },
    })),
    claims: people.map((p, i) => ({ bill_id: id, line_item_id: itemId(i), user_id: p.user, parts: 1 })),
  };
}

/** B owes Hana $14.80 on a $44.80 bill; `marked` records B's "I paid". */
const owesBill = (id: string, marked?: number, unclaimed = 0) =>
  settleBill(
    id,
    [
      { user: A, cents: 3000 - unclaimed },
      { user: B, cents: 1480, marked },
    ],
    unclaimed,
  );

/** The my_bills row for a settle bill B has claimed on. */
const settleRow = (id: string, over: Partial<Row> = {}) => mine(id, { added: false, seen: true, claimed_any: true, complete: true, ...over });

/**
 * The settle tables (answering fetchSettleData's `.in()` reads, gated on the bills read like the
 * homeMarkers tests) and the people counts (answering fetchPeopleCounts: a bill_participants read
 * of exactly `bill_id`), each with its own gates and failure switch.
 */
const fake: {
  settle: Record<SettleTable, RawRow[]>;
  settleGates: Promise<void>[];
  settleFail: boolean;
  people: Record<string, number>;
  countGates: Promise<void>[];
  countFail: boolean;
} = { settle: { bills: [], line_items: [], bill_participants: [], claims: [] }, settleGates: [], settleFail: false, people: {}, countGates: [], countFail: false };

function useSettleBills(...bills: Record<SettleTable, RawRow[]>[]) {
  fake.settle = {
    bills: bills.flatMap((b) => b.bills),
    line_items: bills.flatMap((b) => b.line_items),
    bill_participants: bills.flatMap((b) => b.bill_participants),
    claims: bills.flatMap((b) => b.claims),
  };
}

const isCountsRead = (q: { calls: { method: string; args: unknown[] }[] }) =>
  q.calls.some((c) => c.method === 'select' && c.args[0] === 'bill_id');

function seedTables() {
  for (const table of SETTLE_TABLES) {
    supabase.__setTable(table, async (q) => {
      const inn = q.calls.find((c) => c.method === 'in');
      const ids = (inn?.args[1] as unknown[] | undefined) ?? [];
      if (table === 'bill_participants' && isCountsRead(q)) {
        // Answer with the counts as they were when the request was sent.
        const people = { ...fake.people };
        const fail = fake.countFail;
        const gate = fake.countGates.shift();
        if (gate) await gate;
        if (fail) return { data: null, error: { code: '08006', message: 'server text' } };
        return { data: ids.flatMap((id) => Array.from({ length: people[String(id)] ?? 0 }, () => ({ bill_id: id }))), error: null };
      }
      const key = table === 'bills' ? 'id' : 'bill_id';
      const rows = fake.settle[table];
      if (table === 'bills') {
        const gate = fake.settleGates.shift();
        const fail = fake.settleFail;
        if (gate) await gate;
        if (fail) return { data: null, error: { code: '08006', message: 'server text' } };
      }
      return { data: rows.filter((r) => ids.includes(r[key])), error: null };
    });
  }
}

/** A gate the next read of that kind waits on, and its release. */
function hold(gates: Promise<void>[]) {
  let release: () => void = () => {};
  gates.push(new Promise<void>((r) => (release = r)));
  return async () => {
    await act(async () => release());
  };
}

/** How many settle reads (fetchSettleData's bills `.in()` request) have been sent. */
const settleReads = () => supabase.__queries.filter((q) => q.table === 'bills' && q.calls.some((c) => c.method === 'in')).length;

/** The ids each counts read asked for, in order. */
const countReads = () =>
  supabase.__queries.filter((q) => q.table === 'bill_participants' && isCountsRead(q)).map((q) => q.calls.find((c) => c.method === 'in')?.args[1]);

function spyAppState() {
  const subs: { handler: (s: AppStateStatus) => void; removed: boolean }[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    const sub = { handler: handler as (s: AppStateStatus) => void, removed: false };
    subs.push(sub);
    return { remove: () => (sub.removed = true) };
  });
  return {
    subs,
    emit: async (state: AppStateStatus) => {
      await act(async () => subs.filter((x) => !x.removed).forEach((x) => x.handler(state)));
    },
  };
}

/** The row links under a section heading, by label, in order. */
// HOME-SEC-1/2 (2026-11-27): each bill section is a Show / Hide toggle ("Owed to you, 2 bills"), and
// "Waiting on you" is drawn as two sections, Items to claim then Still needs to be paid. The older
// tests ask for "Waiting on you": these helpers read it as those two sections together, in that order.
const SECTION_PARTS: Record<string, readonly string[]> = {
  'Waiting on you': ['Items to claim', 'Still needs to be paid'],
};
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The section toggles for a title (one, or two for "Waiting on you"), in screen order. */
function sectionToggles(title: string) {
  const parts = SECTION_PARTS[title] ?? [title];
  return parts.flatMap((t) => {
    const re = new RegExp(`^${escapeRe(t)}, \\d+ bills?$`);
    return screen.queryAllByRole('button').filter((b) => re.test(String(b.props.accessibilityLabel ?? '')));
  });
}
const querySection = (title: string) => sectionToggles(title)[0] ?? null;
function getSection(title: string) {
  const s = querySection(title);
  if (s === null) throw new Error(`no section ${title}`);
  return s;
}
const findSection = (title: string) => waitFor(() => getSection(title));

function rowsUnder(title: string): string[] {
  const toggles = sectionToggles(title);
  if (toggles.length === 0) throw new Error(`no rows under ${title}`);
  return toggles.flatMap((t) => {
    // Up from the toggle to the section's View: the first ancestor with rows (sections start open).
    let node = t.parent;
    const links = (n: NonNullable<typeof node>) => n.findAll((c) => typeof c.type === 'string' && c.props.accessibilityRole === 'link');
    while (node && links(node).length === 0) node = node.parent;
    if (!node) throw new Error(`no rows under ${title}`);
    return links(node).map((l) => l.props.accessibilityLabel as string);
  });
}

/** The DisclosureRow element for a section title (its props are what reach aria-expanded on web). */
function disclosureOf(title: string) {
  const row = screen.UNSAFE_getAllByType(DisclosureRow).find((r) => String(r.props.label).startsWith(`${title} (`));
  if (!row) throw new Error(`no toggle for ${title}`);
  return row;
}

const styleOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style as StyleProp<TextStyle>);

// D5 labels.
const X_LABEL = "Hana's bill, Nov 20, 3 people, total $44.80. New, you haven't opened it yet";
const Y_LABEL = 'Your bill, Nov 20, total $44.80';
const Z_OWES = "Hana's bill, Nov 20, 2 people, your share $14.80. You owe $14.80";
const Z_PLAIN = "Hana's bill, Nov 20, 2 people, total $44.80";
// The early plan (criterion 38): B can settle early, so the pill shows, but the amount is the total.
const Z_EARLY = "Hana's bill, Nov 20, 2 people, total $44.80. You owe $14.80";
const W_PAID = "Hana's bill, Nov 20, 2 people, your share $14.80. Paid $14.80";

describe.each(['ios', 'web'] as const)('Home rows, sections and counts (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    fake.settleGates = [];
    fake.settleFail = false;
    fake.countGates = [];
    fake.countFail = false;
    fake.people = { [X]: 3, [Z]: 2, [W]: 2 };
    useSettleBills(owesBill(Z), owesBill(W, 1480));
    seedTables();
    // List order X, Y, Z, W (criterion 39): new, host with no pill, owes, paid.
    server.rows = [mine(X), mine(Y, { host_id: B, host_name: 'Bo', payer_id: B, added: false, seen: true }), settleRow(Z), settleRow(W)];
  });

  async function openLoaded() {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(X_LABEL)).toBeTruthy();
    expect(await screen.findByLabelText(Z_OWES)).toBeTruthy();
    return router;
  }

  it('37: a guest row shows its title, caption, pill and amount, and D5\'s label; the figure is tabular', async () => {
    server.rows = [mine(X)];
    renderRouter(ROUTES, { initialUrl: '/' });
    const row = await screen.findByLabelText(X_LABEL);
    expect(row.props.accessibilityRole).toBe('link');
    expect(screen.getByText("Hana's bill")).toBeTruthy();
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText('$44.80')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(styleOf('$44.80').fontVariant).toEqual(['tabular-nums']);
  });

  it('38: on a ready plan B\'s share shows with "Your share"; on an early plan the total with "Total"', async () => {
    server.rows = [settleRow(Z)];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(Z_OWES)).toBeTruthy();
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    expect(screen.getByText('$14.80')).toBeTruthy();
    expect(screen.getByText('Your share')).toBeTruthy();
    expect(screen.queryByText('Total')).toBeNull();
    screen.unmount();

    // The same bill with an unclaimed $5 item: the plan is 'early', so the row shows the total.
    useSettleBills(owesBill(Z, undefined, 500));
    server.rows = [settleRow(Z, { complete: false })];
    supabase.__queries.length = 0;
    renderRouter(ROUTES, { initialUrl: '/' });
    // Review R1: wait for the early plan itself. Without a plan this row has no pill (B has claimed),
    // so the early pill (B can settle early: canSettle) appears only once the plan is applied.
    expect(await screen.findByLabelText(Z_EARLY)).toBeTruthy();
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
    expect(screen.getByText('$44.80')).toBeTruthy();
    expect(screen.queryByText('Your share')).toBeNull();
  });

  // Groups v2 (criteria 27, 36): Y is B's own bill, not complete (no plan): "Owed to you". W is paid
  // up on a ready plan: hidden. The test's subject (order inside a group, headers, links) is kept.
  it('39 + 47: "Waiting on you" lists X then Z, "Owed to you" Y; W is hidden; headings are headers, rows links with the hint', async () => {
    await openLoaded(); // Z's "You owe" label: the plans have landed
    expect(rowsUnder('Waiting on you')).toEqual([X_LABEL, Z_OWES]);
    expect(rowsUnder('Owed to you')).toEqual([Y_LABEL]);
    expect(screen.queryByLabelText(W_PAID)).toBeNull();
    const text = JSON.stringify(screen.toJSON());
    expect(text.indexOf('Waiting on you')).toBeLessThan(text.indexOf('Owed to you'));
    expect(screen.queryByText('Your bills')).toBeNull();
    expect(screen.queryByRole('header', { name: /Recent/ })).toBeNull();
    // Bill rows only: on web the tab bar's tabs are links too (tab-bar spec Task 5).
    const links = outsideTabBar(screen.getAllByRole('link'));
    expect(links.map((l) => l.props.accessibilityLabel)).toEqual([X_LABEL, Z_OWES, Y_LABEL]);
    for (const l of links) expect(l.props.accessibilityHint).toBe('Opens this bill');
  });

  it('39: only owed rows → no "Waiting on you"; only waiting rows → no "Owed to you"', async () => {
    server.rows = [mine(Y, { host_id: B, host_name: 'Bo', payer_id: B, added: false, seen: true })];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await findSection('Owed to you')).toBeTruthy();
    expect(querySection('Waiting on you')).toBeNull();
    screen.unmount();

    server.rows = [mine(X)];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await findSection('Waiting on you')).toBeTruthy();
    expect(querySection('Owed to you')).toBeNull();
  });

  // HOME-SEC-1/2 (user request 2026-11-27).
  it('HOME-SEC-1: X (nothing claimed) is under "Items to claim", Z (claimed, owes) under "Still needs to be paid", in that order', async () => {
    await openLoaded();
    expect(rowsUnder('Items to claim')).toEqual([X_LABEL]);
    expect(rowsUnder('Still needs to be paid')).toEqual([Z_OWES]);
    expect(getSection('Items to claim').props.accessibilityLabel).toBe('Items to claim, 1 bill');
    expect(screen.getByText('Still needs to be paid (1)')).toBeTruthy();
    const text = JSON.stringify(screen.toJSON());
    expect(text.indexOf('Items to claim')).toBeLessThan(text.indexOf('Still needs to be paid'));
    expect(text.indexOf('Still needs to be paid')).toBeLessThan(text.indexOf('Owed to you'));
    expect(screen.queryByText('Waiting on you')).toBeNull();
  });

  // HOME-POLISH-1 (2026-11-28, user: "we can unhide by default"): no test override any more; this is the real default.
  it('HOME-POLISH-1: every action section starts open on first render, each with aria-expanded; the rows show at once', async () => {
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(X_LABEL)).toBeTruthy(); // no tap needed
    expect(await screen.findByLabelText(Z_OWES)).toBeTruthy();
    expect(screen.getByLabelText(Y_LABEL)).toBeTruthy();
    for (const t of ['Items to claim', 'Still needs to be paid', 'Owed to you']) {
      const s = getSection(t);
      expect([t, s.props.accessibilityState]).toEqual([t, { expanded: true }]);
      // Web: DisclosureRow passes `open` as aria-expanded (react-native-web drops accessibilityState;
      // the DOM attribute itself is checked in uiPrimitives.test.tsx's web markup test).
      expect([t, disclosureOf(t).props.open, disclosureOf(t).props.quiet]).toEqual([t, true, true]);
      expect([t, s.props.accessibilityHint]).toEqual([t, 'Hides these bills']);
    }
    // Each can still collapse on its own.
    await act(async () => fireEvent.press(getSection('Items to claim')));
    expect(screen.queryByLabelText(X_LABEL)).toBeNull();
    expect(disclosureOf('Items to claim').props.open).toBe(false);
    expect(screen.getByLabelText(Z_OWES)).toBeTruthy();
    expect(screen.getByLabelText(Y_LABEL)).toBeTruthy();
  });

  it('HOME-POLISH-1 row anatomy: host initials, title, status line, caption; amount, its label and a chevron; 56-pt row', async () => {
    await openLoaded();
    const row = screen.getByLabelText(Z_OWES);
    const inRow = (t: string) => within(row).getByText(t);
    // Leading: the host's initial (Hana → "H"); the viewer's own bill reads "Y".
    // The avatar is decorative (hidden from screen readers; the title says whose bill it is).
    expect(within(row).getByText('H', { includeHiddenElements: true })).toBeTruthy();
    expect(within(row).queryByText('H')).toBeNull();
    expect(within(screen.getByLabelText(Y_LABEL)).getByText('Y', { includeHiddenElements: true })).toBeTruthy();
    expect(inRow("Hana's bill")).toBeTruthy();
    expect(inRow('You owe $14.80')).toBeTruthy();
    expect(inRow('Nov 20 · 2 people')).toBeTruthy();
    expect(inRow('$14.80')).toBeTruthy();
    expect(inRow('Your share')).toBeTruthy();
    expect(row.findAllByType(ChevronRight)).toHaveLength(1);
    // Reading order on screen matches the label: title, status, caption.
    const texts = row.findAll((n) => String(n.type) === 'Text').map((n) => String(n.props.children));
    expect(texts).toEqual(['H', "Hana's bill", 'You owe $14.80', 'Nov 20 · 2 people', '$14.80', 'Your share']);
    // The amount is the row's largest text, tabular; its label is a muted caption.
    expect(styleOf('$14.80')).toMatchObject({ ...type.headline, fontVariant: ['tabular-nums'], color: colors.light.text });
    expect(styleOf('Your share')).toMatchObject({ ...type.caption, color: colors.light.textMuted });
    // The row's content keeps the 56-pt minimum.
    let content = within(row).getByText("Hana's bill").parent;
    while (content && StyleSheet.flatten(content.props.style as StyleProp<ViewStyle>)?.minHeight === undefined) content = content.parent;
    expect(StyleSheet.flatten(content?.props.style as StyleProp<ViewStyle>).minHeight).toBe(ROW_MIN_HEIGHT);
  });

  it('HOME-SEC-2: with sections open, each hides / shows its rows on its own toggle', async () => {
    await openLoaded();
    const owed = getSection('Owed to you');
    expect(owed.props.accessibilityState).toMatchObject({ expanded: true });
    expect(owed.props.accessibilityHint).toBe('Hides these bills');
    await act(async () => fireEvent.press(owed));
    expect(screen.queryByLabelText(Y_LABEL)).toBeNull();
    expect(screen.getByLabelText(Z_OWES)).toBeTruthy(); // the other sections stay open
    expect(getSection('Owed to you').props.accessibilityState).toMatchObject({ expanded: false });
    expect(getSection('Owed to you').props.accessibilityHint).toBe('Shows these bills');
    expect(screen.getByText('Owed to you (1)')).toBeTruthy(); // the count stays while closed
    await act(async () => fireEvent.press(getSection('Owed to you')));
    expect(screen.getByLabelText(Y_LABEL)).toBeTruthy();
  });

  it.each<[string, () => void, () => Promise<unknown>]>([
    ['loading', () => (server.myBills = () => new Promise<FakeResult>(() => {})), () => screen.findByLabelText('Loading your bills')],
    ['error', () => (server.myBills = () => ({ data: null, error: { code: '08006', message: 'x' } })), () => screen.findByText("Couldn't load your bills.")],
    ['no bills', () => (server.rows = []), () => screen.findByText('No bills yet.')],
  ])('39 + 32: %s shows "Your bills" and today\'s text, and no group, toggle or caught-up card', async (_state, arrange, shown) => {
    arrange();
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await shown()).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Your bills' })).toBeTruthy();
    expect(querySection('Waiting on you')).toBeNull();
    expect(querySection('Owed to you')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Settled/ })).toBeNull();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
  });

  // Groups v2 (A1.M3, A1.S5): the first load waits for the settle read, so Z appears once, under
  // "Waiting on you"; a pending refresh and a failed one both keep Z's facts, so it doesn't move.
  it('40: Z appears in "Waiting on you" once its settle data lands, stays there on a refresh, and on a failed one', async () => {
    const app = spyAppState();
    server.rows = [mine(X), settleRow(Z)];
    const releaseFirst = hold(fake.settleGates);
    renderRouter(ROUTES, { initialUrl: '/' });
    // First load, settle read pending: the list has landed (the read is sent from its answer), but
    // Home keeps the spinner, so Z never shows without its plan.
    await waitFor(() => expect(settleReads()).toBe(1));
    expect(screen.getByLabelText('Loading your bills')).toBeTruthy();
    expect(screen.queryByLabelText(Z_PLAIN)).toBeNull();
    await releaseFirst();
    expect(await screen.findByLabelText(Z_OWES)).toBeTruthy();
    expect(rowsUnder('Waiting on you')).toEqual([X_LABEL, Z_OWES]);
    expect(screen.getByText('Your share')).toBeTruthy();

    // A refresh whose settle read is pending: Z keeps its facts (keepCandidates), so it doesn't move.
    const releaseRefresh = hold(fake.settleGates);
    fake.settleFail = true; // ...and when it lands, it fails
    const reads = settleReads();
    await app.emit('active');
    // Review R3: the refresh's list has landed once its settle read is sent (it's sent from that answer).
    await waitFor(() => expect(settleReads()).toBe(reads + 1));
    expect(rowsUnder('Waiting on you')).toEqual([X_LABEL, Z_OWES]);
    expect(screen.queryByLabelText('Loading your bills')).toBeNull(); // refreshes never wait
    await releaseRefresh();
    await act(async () => {});
    // A1.S5: the failed refresh keeps Z's plan, so it stays put with its pill; no error shows.
    expect(rowsUnder('Waiting on you')).toEqual([X_LABEL, Z_OWES]);
    expect(screen.queryByLabelText(Z_PLAIN)).toBeNull();
    expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();
  });

  it('41: one counts read per successful list load, with the list\'s ids, made after my_bills answers', async () => {
    const app = spyAppState();
    let answer: (r: FakeResult) => void = () => {};
    server.myBills = () => new Promise<FakeResult>((r) => (answer = r));
    renderRouter(ROUTES, { initialUrl: '/' });
    await screen.findByLabelText('Loading your bills');
    await act(async () => {});
    expect(countReads()).toEqual([]); // nothing before the list
    await act(async () => answer({ data: server.rows.map((r) => ({ ...r })), error: null }));
    expect(await screen.findByLabelText(X_LABEL)).toBeTruthy();
    expect(countReads()).toEqual([[X, Y, Z, W]]);

    // A failed list load makes no counts read; the next good one makes exactly one.
    server.myBills = () => ({ data: null, error: { code: '08006', message: 'x' } });
    await app.emit('active');
    await act(async () => {});
    expect(countReads()).toHaveLength(1);
    server.myBills = null;
    server.rows = [mine(X), settleRow(Z)];
    await app.emit('active');
    await waitFor(() => expect(countReads()).toHaveLength(2));
    expect(countReads()[1]).toEqual([X, Z]);
  });

  it('41: a counts answer from an older load is ignored once a newer load has started', async () => {
    const app = spyAppState();
    await openLoaded();
    // Load 2's counts read is held and answers with old counts (X: 3); load 3's answers at once (X: 5).
    const releaseOld = hold(fake.countGates);
    await app.emit('active');
    await waitFor(() => expect(countReads()).toHaveLength(2));
    // Review R4 / D6: while that read is pending, the row keeps the previous count.
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy();
    fake.people = { ...fake.people, [X]: 5 };
    await app.emit('active');
    expect(await screen.findByText('Nov 20 · 5 people')).toBeTruthy();
    await releaseOld();
    await act(async () => {});
    expect(screen.getByText('Nov 20 · 5 people')).toBeTruthy();
    expect(screen.queryByText('Nov 20 · 3 people')).toBeNull();
  });

  // Smoke test only (review R2): React 19 doesn't warn about a state update after unmount, and the
  // focus cleanup already bumps `latest`, so this can't catch a missing guard. The two tests after it
  // can: Home stays mounted under Profile, so a stale answer would change what Home shows.
  it('41 smoke: a counts answer landing after Home unmounted doesn\'t throw or log', async () => {
    const errors = jest.spyOn(console, 'error');
    const release = hold(fake.countGates);
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(countReads()).toHaveLength(1));
    router.unmount();
    await release();
    expect(errors).not.toHaveBeenCalled();
  });

  it('41: a counts answer landing after Home lost focus is ignored (the latest token)', async () => {
    const app = spyAppState();
    const router = await openLoaded();
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy();
    // A refresh whose counts read is held and will answer X: 5.
    fake.people = { ...fake.people, [X]: 5 };
    const releaseStale = hold(fake.countGates);
    await app.emit('active');
    await waitFor(() => expect(countReads()).toHaveLength(2));
    // Leave Home (it stays mounted under Profile), and let the stale answer land there.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Profile'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    await releaseStale();
    // Back on Home, hold the focus reload's counts read, so only the stale answer could have changed X.
    const releaseFresh = hold(fake.countGates);
    await act(async () => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await waitFor(() => expect(countReads()).toHaveLength(3));
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy();
    expect(screen.queryByText('Nov 20 · 5 people')).toBeNull();
    await releaseFresh();
    expect(await screen.findByText('Nov 20 · 5 people')).toBeTruthy(); // positive control: a current read applies
  });

  it('40: a settle answer landing after Home lost focus is ignored (the latest token)', async () => {
    const app = spyAppState();
    server.rows = [settleRow(Z)];
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(Z_OWES)).toBeTruthy();
    // A refresh whose settle read is held and will answer "B paid".
    useSettleBills(owesBill(Z, 1480));
    const releaseStale = hold(fake.settleGates);
    const reads = settleReads();
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toBe(reads + 1));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Profile'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    await releaseStale();
    const releaseFresh = hold(fake.settleGates);
    await act(async () => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await waitFor(() => expect(settleReads()).toBe(reads + 2));
    // Only the stale answer could have changed Z; it was dropped, so Z keeps its "You owe" facts.
    expect(screen.getByText('You owe $14.80')).toBeTruthy();
    expect(screen.queryByText("You're all caught up.")).toBeNull();
    await releaseFresh();
    // Positive control: a current read applies. B has paid, so Z is hidden (groups v2) and the
    // caught-up card shows in its place.
    expect(await screen.findByLabelText("You're all caught up. Bills you've paid don't show here.")).toBeTruthy();
    expect(screen.queryByText('You owe $14.80')).toBeNull();
  });

  it('41: a failed counts read shows no error and keeps the counts; a bill that left the list loses its count', async () => {
    const app = spyAppState();
    await openLoaded();
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy();
    fake.countFail = true;
    await app.emit('active');
    await waitFor(() => expect(countReads()).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText('Nov 20 · 3 people')).toBeTruthy(); // kept
    expect(screen.getByLabelText(X_LABEL)).toBeTruthy();
    expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();

    // X leaves the list, then comes back, with every counts read failing: its old count is gone.
    server.rows = [mine(Y, { host_id: B, host_name: 'Bo', payer_id: B, added: false, seen: true })];
    await app.emit('active');
    await waitFor(() => expect(screen.queryByLabelText(X_LABEL)).toBeNull());
    expect(screen.getByLabelText(Y_LABEL)).toBeTruthy(); // positive control: the list is there
    server.rows = [mine(X)];
    await app.emit('active');
    expect(await screen.findByLabelText("Hana's bill, Nov 20, total $44.80. New, you haven't opened it yet")).toBeTruthy();
    expect(screen.getByText('Nov 20')).toBeTruthy();
    expect(screen.queryByText('Nov 20 · 3 people')).toBeNull();
  });

  it('44: nothing in the trailing slot is interactive; pressing the amount opens the bill', async () => {
    server.rows = [mine(X)];
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    const row = await screen.findByLabelText(X_LABEL);
    const inner = row.findAll(
      (n) => n !== row && typeof n.type === 'string' && (n.props.accessibilityRole !== undefined || n.props.accessible === true || n.props.onClick !== undefined),
    );
    expect(inner).toEqual([]);
    // Positive control: the amount and the label are inside the row.
    expect(row.findAll((n) => n === screen.getByText('$44.80'))).toHaveLength(1);
    await act(async () => {
      fireEvent.press(screen.getByText('$44.80'));
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${X}`));
  });
});

// ---------------------------------------------------------------------------
// Groups v2: Waiting on you, Owed to you, Settled, hidden, the caught-up card and the first-load
// wait. docs/specs/2026-11-26-home-groups-v2.md Task 2, criteria 27–34 and 36 (as rewritten by A1).
// ---------------------------------------------------------------------------

const GX = '22222222-2222-4222-8222-000000000001'; // Hana's bill, B owes $14.80
const GW = '22222222-2222-4222-8222-000000000002'; // Hana's bill, B paid his $14.80: hidden
const PY = '22222222-2222-4222-8222-000000000003'; // B's bill, Hana hasn't paid her $30.00
const PS1 = '22222222-2222-4222-8222-000000000004'; // B's bill, Hana paid: settled
const PS2 = '22222222-2222-4222-8222-000000000005'; // B's bill, Hana paid: settled

/** B pays; Hana's $30.00 share, marked or not (`hana`), B's own $14.80. */
const payerBill = (id: string, hana?: number) =>
  settleBill(
    id,
    [
      { user: A, cents: 3000, marked: hana },
      { user: B, cents: 1480 },
    ],
    0,
    B,
  );
/** The my_bills row for a complete bill B hosts and pays; `total` tells the rows apart. */
const payerRow = (id: string, total: number) =>
  settleRow(id, { host_id: B, host_name: 'Bo', payer_id: B, total_cents: total });

const GX_OWES = "Hana's bill, Nov 20, 2 people, your share $14.80. You owe $14.80";
const GW_PAID = "Hana's bill, Nov 20, 2 people, your share $14.80. Paid $14.80";
/** GV-5's fallback, with no plan: GW under Waiting with the total and no pill. */
const GW_FALLBACK = "Hana's bill, Nov 20, 2 people, total $44.80";
const PY_COLLECT = 'Your bill, Nov 20, 2 people, to collect $30.00. 1 person still has to pay you';
const PS1_SETTLED = 'Your bill, Nov 20, 2 people, total $50.00. Settled up, everyone has settled up with you';
const PS2_SETTLED = 'Your bill, Nov 20, 2 people, total $51.00. Settled up, everyone has settled up with you';
/** GV-5's fallback: PS1 under Owed with the total and no pill. */
const PS1_FALLBACK = 'Your bill, Nov 20, 2 people, total $50.00';
const CAUGHT_UP = "You're all caught up.";
const HIDDEN_NOTE = "Bills you've paid don't show here.";

const toggle = () => screen.getByRole('button', { name: /^Settled, \d+ bills?$/ });
const queryToggle = () => screen.queryByRole('button', { name: /^Settled, \d+ bills?$/ });
/** HOME-SEC-2: every bill section is a DisclosureRow now; this is Settled's. */
const settledRow = () => {
  const row = screen.UNSAFE_getAllByType(DisclosureRow).find((r) => String(r.props.label).startsWith('Settled ('));
  if (!row) throw new Error('no Settled toggle');
  return row;
};
const links = () => outsideTabBar(screen.getAllByRole('link')).map((l) => l.props.accessibilityLabel as string);
/** The rows in the Settled block: the links inside the toggle's parent View. */
function settledRows(): string[] {
  let box = toggle().parent;
  // Walk up to the View that holds both the toggle and (when open) the card: the one with onLayout.
  while (box && box.props.onLayout === undefined) box = box.parent;
  if (!box) throw new Error('no Settled block');
  return box
    .findAll((c) => typeof c.type === 'string' && c.props.accessibilityRole === 'link')
    .map((l) => l.props.accessibilityLabel as string);
}
const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const json = () => JSON.stringify(screen.toJSON());

/** The wait timer Home sets on its first list (A1.M3), from a setTimeout spy. */
function waitTimerOf(spy: jest.SpyInstance) {
  const i = (spy.mock.calls as unknown[][]).findIndex((c) => c[1] === FIRST_SETTLE_WAIT_MS);
  return i === -1 ? undefined : (spy.mock.results[i]?.value as unknown);
}

describe.each(['ios', 'web'] as const)('Home groups v2 (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    fake.settleGates = [];
    fake.settleFail = false;
    fake.countGates = [];
    fake.countFail = false;
    fake.people = { [GX]: 2, [GW]: 2, [PY]: 2, [PS1]: 2, [PS2]: 2 };
    useSettleBills(owesBill(GX), owesBill(GW, 1480), payerBill(PY), payerBill(PS1, 3000), payerBill(PS2, 3000));
    seedTables();
    // Criterion 27's list, in my_bills order.
    server.rows = [settleRow(GX), payerRow(PY, 6000), settleRow(GW), payerRow(PS1, 5000), payerRow(PS2, 5100)];
  });

  /** Home with the plans landed: GX's "You owe" pill is the plan-only marker. */
  async function openGroups(countedRows = 2) {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(GX_OWES)).toBeTruthy();
    // The counts have landed (GX and PY show theirs; the others are hidden or collapsed).
    expect(await screen.findAllByText('Nov 20 · 2 people')).toHaveLength(countedRows);
    return router;
  }

  it('27 + 36: Waiting has GX, Owed has PY with "To collect", Settled (2) is a collapsed button; GW is hidden', async () => {
    await openGroups();
    expect(screen.getByText('You owe $14.80')).toBeTruthy(); // the plans have landed
    expect(rowsUnder('Waiting on you')).toEqual([GX_OWES]);
    expect(rowsUnder('Owed to you')).toEqual([PY_COLLECT]);
    expect(getSection('Waiting on you')).toBeTruthy();
    expect(getSection('Owed to you')).toBeTruthy();
    expect(screen.queryByRole('header', { name: /Recent/ })).toBeNull();
    // A1.M2: PY's figure is what's still to collect, not the $60.00 total.
    expect(screen.getByText('$30.00')).toBeTruthy();
    expect(screen.getByText('To collect')).toBeTruthy();
    expect(screen.queryByText('$60.00')).toBeNull();
    // The toggle: a button, collapsed, visible "Settled (2)"; S1 and S2 aren't rendered.
    expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.getByText('Settled (2)')).toBeTruthy();
    expect(settledRows()).toEqual([]);
    expect(screen.queryByLabelText(PS1_SETTLED)).toBeNull();
    expect(screen.queryByLabelText(PS2_SETTLED)).toBeNull();
    // GW isn't anywhere, in either form.
    expect(screen.queryByLabelText(GW_PAID)).toBeNull();
    expect(screen.queryByLabelText(GW_FALLBACK)).toBeNull();
    expect(links()).toEqual([GX_OWES, PY_COLLECT]);
    // Order on screen: Waiting, Owed, then Settled. No caught-up card (something is open).
    const text = json();
    expect(text.indexOf('Waiting on you')).toBeLessThan(text.indexOf('Owed to you'));
    expect(text.indexOf('Owed to you')).toBeLessThan(text.indexOf('Settled (2)'));
    expect(screen.queryByText(CAUGHT_UP)).toBeNull();
    // 35 (tab-bar spec Task 5): the way in is the tab bar's (+); Home has no filled button and keeps its heading.
    expect(addButton()).toBeTruthy();
    expect(primaryButtons()).toHaveLength(0);
    expect(screen.getByRole('header', { name: 'SplitIt' })).toBeTruthy();
  });

  it('HOME-POLISH-1: Settled starts collapsed (aria-expanded false) while the action sections above it start open', async () => {
    await openGroups();
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
    expect(settledRow().props).toMatchObject({ open: false, quiet: true });
    expect(settledRows()).toEqual([]);
    for (const t of ['Still needs to be paid', 'Owed to you']) {
      expect([t, getSection(t).props.accessibilityState, disclosureOf(t).props.open]).toEqual([t, { expanded: true }, true]);
    }
    expect(links()).toEqual([GX_OWES, PY_COLLECT]); // open rows drawn, settled ones not
    await press(toggle());
    expect(settledRow().props.open).toBe(true);
    expect(settledRows()).toEqual([PS1_SETTLED, PS2_SETTLED]);
  });

  it('28 + S3: the toggle shows PS1 then PS2 with no visible pill, their labels keep "Settled up"; again hides them', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openGroups();
    expect(toggle().props.accessibilityHint).toBe('Shows bills everyone has paid you for');
    await press(toggle());
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: true });
    expect(toggle().props.accessibilityHint).toBe('Hides settled bills');
    // Positive control: the rows are there, found by their labels, in list order, inside Settled.
    expect(screen.getByLabelText(PS1_SETTLED)).toBeTruthy();
    expect(settledRows()).toEqual([PS1_SETTLED, PS2_SETTLED]);
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.queryByText('Settled up')).toBeNull(); // A1.S3: no visible pill
    for (const label of [PS1_SETTLED, PS2_SETTLED]) {
      expect(label.endsWith('. Settled up, everyone has settled up with you')).toBe(true);
      const row = screen.getByLabelText(label);
      expect(row.props.accessibilityRole).toBe('link');
      expect(row.props.accessibilityHint).toBe('Opens this bill');
    }
    await press(toggle());
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
    expect(screen.queryByLabelText(PS1_SETTLED)).toBeNull();
    // Open again and open PS2: it pushes its bill.
    await press(toggle());
    await press(screen.getByLabelText(PS2_SETTLED));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${PS2}`));
    expect(push.mock.calls).toEqual([[`/bills/${PS2}`]]);
  });

  it('29: the toggle is DisclosureRow: 44-pt target, full width, Show + ChevronDown / Hide + ChevronUp, never ChevronRight', async () => {
    await openGroups();
    const row = settledRow();
    const style = StyleSheet.flatten(toggle().props.style as StyleProp<ViewStyle>);
    expect(Number(style.minHeight)).toBeGreaterThanOrEqual(44);
    expect(style.alignSelf).toBeUndefined(); // stretches across the column
    expect(style.width).toBeUndefined();
    expect(style.marginVertical).toBe(-(TOUCH_TARGET - type.section.lineHeight) / 2);
    // Closed: the word and the chevron (positive control), and no right chevron.
    expect(row.findAllByType(ChevronDown)).toHaveLength(1);
    expect(row.findAllByType(ChevronUp)).toHaveLength(0);
    expect(row.findAllByType(ChevronRight)).toHaveLength(0);
    expect(within(settledRow()).getByText('Show', { includeHiddenElements: true })).toBeTruthy();
    // The word and chevron aren't announced: they sit in a hidden View; the label stays the count.
    let box = within(settledRow()).getByText('Show', { includeHiddenElements: true }).parent;
    while (box && box.props.importantForAccessibility === undefined) box = box.parent;
    expect(box?.props).toMatchObject({ accessible: false, importantForAccessibility: 'no-hide-descendants' });
    expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
    // Look: label in type.section / textMuted; HOME-POLISH-1: Home's word is quiet, textMuted caption
    // at the regular weight (teal is kept for the rows' next steps).
    expect(styleOf('Settled (2)')).toMatchObject({ ...type.section, color: colors.light.textMuted });
    const word = StyleSheet.flatten(within(settledRow()).getByText('Show', { includeHiddenElements: true }).props.style as StyleProp<TextStyle>);
    expect(word).toMatchObject({ fontSize: type.caption.fontSize, color: colors.light.textMuted });
    expect(word.fontWeight).toBeUndefined();
    await press(toggle());
    expect(settledRow().findAllByType(ChevronUp)).toHaveLength(1);
    expect(settledRow().findAllByType(ChevronDown)).toHaveLength(0);
    expect(settledRow().findAllByType(ChevronRight)).toHaveLength(0);
    expect(within(settledRow()).getByText('Hide', { includeHiddenElements: true })).toBeTruthy();
    expect(within(settledRow()).queryByText('Show', { includeHiddenElements: true })).toBeNull();
    expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
    // The rows' own right chevrons are there (positive control for the detector above).
    expect(screen.UNSAFE_getAllByType(ChevronRight).length).toBeGreaterThan(0);
  });

  describe('29a: opening scrolls the first settled row into view', () => {
    /** Mocked layout: the scroll area's height, the column's offset, the Settled block's offset. */
    function layOut(visible: number, columnY: number, blockY: number, scrollY = 0) {
      const scroll = screen.UNSAFE_getByType(ScrollView);
      fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 375, height: visible } } });
      fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { x: 0, y: scrollY } } });
      let column = screen.getByRole('header', { name: 'SplitIt' }).parent;
      while (column && column.props.onLayout === undefined) column = column.parent;
      let block = toggle().parent;
      while (block && block.props.onLayout === undefined) block = block.parent;
      if (!column || !block) throw new Error('no layout targets');
      fireEvent(column, 'layout', { nativeEvent: { layout: { x: 0, y: columnY, width: 343, height: 900 } } });
      fireEvent(block, 'layout', { nativeEvent: { layout: { x: 0, y: blockY, width: 343, height: 18 } } });
      return scroll.instance as { scrollTo: jest.Mock };
    }

    /** Review R4: the opened card's layout event (the View around it, inside the Settled block). */
    function cardLaidOut() {
      const card = screen.getByLabelText(PS1_SETTLED);
      let n = card.parent;
      while (n && n.props.onLayout === undefined) n = n.parent;
      if (!n) throw new Error('no card layout target');
      // The nearest onLayout above a settled row is the card's wrapper, not the block (which holds the toggle too).
      expect(n.findAll((x) => x === toggle())).toHaveLength(0);
      fireEvent(n, 'layout', { nativeEvent: { layout: { x: 0, y: 26, width: 343, height: 113 } } });
    }
    /** The first row's bottom: the block's top + the label line (the target minus both margins) + gap + row. */
    const firstRowBottom = (toggleY: number) => toggleY + TOUCH_TARGET + 2 * DISCLOSURE_ROW_MARGIN + space.sm + ROW_MIN_HEIGHT;

    it('below the visible area: one scrollTo after the opened card lays out, the smallest offset, animated; closing never scrolls', async () => {
      await openGroups();
      const scroller = layOut(500, 16, 480);
      scroller.scrollTo.mockClear();
      await press(toggle());
      expect(screen.getByLabelText(PS1_SETTLED)).toBeTruthy(); // it opened...
      expect(scroller.scrollTo).not.toHaveBeenCalled(); // ...but the card hasn't laid out yet (R4)
      cardLaidOut();
      expect(DISCLOSURE_ROW_MARGIN).toBe(-13);
      // R6: 496 + 18 + 8 + 56 = 578; plus space.lg, minus the 500-pt view.
      expect(scroller.scrollTo.mock.calls).toEqual([[{ y: firstRowBottom(16 + 480) + space.lg - 500, animated: true }]]);
      expect(firstRowBottom(16 + 480)).toBe(578);
      cardLaidOut(); // a later re-layout doesn't scroll again
      await press(toggle()); // close
      expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    });

    it('already in view (taking the scroll offset into account): no scroll', async () => {
      await openGroups();
      // The first row's bottom is 16 + 480 + 18 + 8 + 56 = 578; scrolled by 80, the view shows to 580.
      const scroller = layOut(500, 16, 480, 80);
      scroller.scrollTo.mockClear();
      await press(toggle());
      cardLaidOut();
      expect(screen.getByLabelText(PS1_SETTLED)).toBeTruthy(); // it did open
      expect(scroller.scrollTo).not.toHaveBeenCalled();
    });

    it('2 pt short of the row\'s bottom: it scrolls (the boundary)', async () => {
      await openGroups();
      const scroller = layOut(500, 16, 480, 76); // shows to 576 < 578
      scroller.scrollTo.mockClear();
      await press(toggle());
      cardLaidOut();
      expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    });

    it('with Reduce Motion on, the scroll is not animated', async () => {
      jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockResolvedValueOnce(true);
      await openGroups();
      const scroller = layOut(500, 16, 480);
      scroller.scrollTo.mockClear();
      await press(toggle());
      cardLaidOut();
      expect(scroller.scrollTo.mock.calls).toEqual([[expect.objectContaining({ animated: false })]]);
    });

    it('Reduce Motion turned on while Home is open (reduceMotionChanged) also stops the animation', async () => {
      await openGroups();
      // The mock's calls are typed for one event's overload; read them as plain pairs.
      const calls = jest.mocked(AccessibilityInfo.addEventListener).mock.calls as unknown as [string, (on: boolean) => void][];
      const listener = calls.find(([name]) => name === 'reduceMotionChanged')?.[1];
      expect(listener).toBeDefined();
      await act(async () => listener?.(true));
      const scroller = layOut(500, 16, 480);
      scroller.scrollTo.mockClear();
      await press(toggle());
      cardLaidOut();
      expect(scroller.scrollTo.mock.calls).toEqual([[expect.objectContaining({ animated: false })]]);
    });
  });

  it('30: the open state survives a focus refresh and resets on remount', async () => {
    const router = await openGroups();
    await press(toggle());
    expect(settledRows()).toEqual([PS1_SETTLED, PS2_SETTLED]);
    const reads = settleReads();
    await press(screen.getByLabelText('Profile'));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    await act(async () => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await waitFor(() => expect(settleReads()).toBe(reads + 1)); // the focus reload ran
    await act(async () => {});
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: true });
    expect(settledRows()).toEqual([PS1_SETTLED, PS2_SETTLED]);
    screen.unmount();

    await openGroups();
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
    expect(settledRows()).toEqual([]);
  });

  it('30: a refresh that leaves no settled bill removes the toggle; when one comes back it is collapsed', async () => {
    const app = spyAppState();
    await openGroups();
    await press(toggle());
    expect(settledRows()).toEqual([PS1_SETTLED, PS2_SETTLED]);
    // Both settled bills leave the list.
    server.rows = [settleRow(GX), payerRow(PY, 6000)];
    await app.emit('active');
    await waitFor(() => expect(queryToggle()).toBeNull());
    expect(links()).toEqual([GX_OWES, PY_COLLECT]); // positive control: the list is there
    // One comes back.
    server.rows = [settleRow(GX), payerRow(PY, 6000), payerRow(PS1, 5000)];
    await app.emit('active');
    await waitFor(() => expect(queryToggle()).not.toBeNull());
    expect(toggle().props.accessibilityLabel).toBe('Settled, 1 bill');
    expect(screen.getByText('Settled (1)')).toBeTruthy();
    expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
    expect(settledRows()).toEqual([]);
  });

  describe('31 + S4: all caught up', () => {
    const cardOf = (label: string) => screen.getByLabelText(label);

    it('all hidden: the card with the hidden note, one element, no section headers or toggle, the tab bar\'s (+) there', async () => {
      useSettleBills(owesBill(GW, 1480));
      server.rows = [settleRow(GW)];
      renderRouter(ROUTES, { initialUrl: '/' });
      const card = await screen.findByLabelText(`${CAUGHT_UP} ${HIDDEN_NOTE}`);
      expect(card.props.accessible).toBe(true);
      expect(card.props.accessibilityRole).toBeUndefined();
      expect(StyleSheet.flatten(card.props.style as StyleProp<ViewStyle>).gap).toBe(space.xs);
      expect(styleOf(CAUGHT_UP)).toMatchObject({ ...type.body, color: colors.light.text });
      expect(styleOf(HIDDEN_NOTE)).toMatchObject({ ...type.caption, color: colors.light.textMuted });
      expect(querySection('Waiting on you')).toBeNull();
      expect(querySection('Owed to you')).toBeNull();
      expect(screen.queryByRole('header', { name: 'Your bills' })).toBeNull();
      expect(queryToggle()).toBeNull();
      expect(screen.queryByLabelText(GW_PAID)).toBeNull();
      expect(screen.getByRole('header', { name: 'SplitIt' })).toBeTruthy();
      expect(addButton()).toBeTruthy();
      expect(primaryButtons()).toHaveLength(0);
    });

    it('all settled: the card without the note (nothing hidden), then Settled (2)', async () => {
      useSettleBills(payerBill(PS1, 3000), payerBill(PS2, 3000));
      server.rows = [payerRow(PS1, 5000), payerRow(PS2, 5100)];
      renderRouter(ROUTES, { initialUrl: '/' });
      expect(await screen.findByText('Settled (2)')).toBeTruthy(); // the plans have landed
      expect(cardOf(CAUGHT_UP).props.accessible).toBe(true);
      expect(screen.getByText(CAUGHT_UP)).toBeTruthy();
      expect(screen.queryByText(HIDDEN_NOTE)).toBeNull();
      const text = json();
      expect(text.indexOf(CAUGHT_UP)).toBeLessThan(text.indexOf('Settled (2)'));
      expect(querySection('Owed to you')).toBeNull();
    });

    it('mixed hidden and settled: the card with the note, plus the toggle', async () => {
      useSettleBills(owesBill(GW, 1480), payerBill(PS1, 3000));
      server.rows = [settleRow(GW), payerRow(PS1, 5000)];
      renderRouter(ROUTES, { initialUrl: '/' });
      expect(await screen.findByText('Settled (1)')).toBeTruthy();
      expect(cardOf(`${CAUGHT_UP} ${HIDDEN_NOTE}`)).toBeTruthy();
      expect(screen.getByText(HIDDEN_NOTE)).toBeTruthy();
      expect(screen.queryByLabelText(GW_PAID)).toBeNull();
    });

    it('something open: no card (positive control: the open row is there)', async () => {
      await openGroups();
      expect(screen.getByLabelText(GX_OWES)).toBeTruthy();
      expect(screen.queryByText(CAUGHT_UP)).toBeNull();
    });
  });

  describe('33 (A1.M3 + S5): the first load waits for settle data; refreshes never reshuffle', () => {
    it('(a) + (b): the spinner shows while the first read is held; resolving shows the final groups at once', async () => {
      const release = hold(fake.settleGates);
      renderRouter(ROUTES, { initialUrl: '/' });
      // renderRouter turns on Jest's fake timers itself (replacing earlier spies), so spy after it.
      const setT = jest.spyOn(globalThis, 'setTimeout');
      const clearT = jest.spyOn(globalThis, 'clearTimeout');
      await waitFor(() => expect(settleReads()).toBe(1)); // the list has landed
      expect(screen.getByLabelText('Loading your bills')).toBeTruthy();
      expect(screen.getByRole('header', { name: 'Your bills' })).toBeTruthy();
      const pending = [json()];
      await act(async () => {});
      pending.push(json());
      for (const snap of pending) {
        for (const absent of [GW_FALLBACK, GW_PAID, PS1_FALLBACK, 'Waiting on you', 'Owed to you', 'Settled (']) {
          expect([absent, snap.includes(absent)]).toEqual([absent, false]);
        }
        expect(snap).toContain('Loading your bills'); // positive control: the snapshot is the screen
      }
      await release();
      expect(await screen.findByLabelText(GX_OWES)).toBeTruthy();
      expect(screen.getByText('Settled (2)')).toBeTruthy();
      expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
      expect(screen.queryByLabelText(GW_FALLBACK)).toBeNull();
      expect(screen.queryByLabelText(PS1_FALLBACK)).toBeNull();
      // The read ended the wait, not the timer: the wait timer was cleared.
      const timer = waitTimerOf(setT);
      expect(timer).toBeDefined();
      expect((clearT.mock.calls as unknown[][]).map((c) => c[0])).toContain(timer);
    });

    it('(c) the read still held at FIRST_SETTLE_WAIT_MS: GV-5 fallback; resolving then moves GW out and PS1 to Settled', async () => {
      const release = hold(fake.settleGates);
      renderRouter(ROUTES, { initialUrl: '/' });
      // renderRouter turns on Jest's fake timers itself (replacing earlier spies), so spy after it.
      const setT = jest.spyOn(globalThis, 'setTimeout');
      await waitFor(() => expect(settleReads()).toBe(1));
      expect(screen.getByLabelText('Loading your bills')).toBeTruthy();
      expect(waitTimerOf(setT)).toBeDefined(); // set for FIRST_SETTLE_WAIT_MS
      await act(async () => {
        jest.advanceTimersByTime(FIRST_SETTLE_WAIT_MS);
      });
      expect(screen.queryByLabelText('Loading your bills')).toBeNull();
      // No plans: guest bills under Waiting with no pill, payer bills under Owed with the total.
      // GX and GW read the same with no plan.
      expect(await screen.findAllByLabelText(GW_FALLBACK)).toHaveLength(2);
      expect(rowsUnder('Waiting on you')).toEqual([GW_FALLBACK, GW_FALLBACK]);
      expect(rowsUnder('Owed to you')).toContain(PS1_FALLBACK);
      expect(queryToggle()).toBeNull();
      await release();
      expect(await screen.findByLabelText(GX_OWES)).toBeTruthy();
      expect(screen.queryByLabelText(GW_FALLBACK)).toBeNull();
      expect(screen.queryByLabelText(PS1_FALLBACK)).toBeNull();
      expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
    });

    it('(d) the first read fails before the timer: the fallback renders at once, with no error', async () => {
      fake.settleFail = true;
      const release = hold(fake.settleGates);
      renderRouter(ROUTES, { initialUrl: '/' });
      // renderRouter turns on Jest's fake timers itself (replacing earlier spies), so spy after it.
      const setT = jest.spyOn(globalThis, 'setTimeout');
      const clearT = jest.spyOn(globalThis, 'clearTimeout');
      await waitFor(() => expect(settleReads()).toBe(1));
      expect(screen.getByLabelText('Loading your bills')).toBeTruthy();
      await release();
      expect(await screen.findAllByLabelText(GW_FALLBACK)).toHaveLength(2); // GX and GW, no plan
      expect(rowsUnder('Owed to you')).toContain(PS1_FALLBACK);
      expect((clearT.mock.calls as unknown[][]).map((c) => c[0])).toContain(waitTimerOf(setT)); // not by the timer
      expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();
    });

    it('(e) a list with no settle candidates renders without waiting for the timer', async () => {
      server.rows = [mine(X)]; // new: not a candidate
      fake.people = { [X]: 3 };
      renderRouter(ROUTES, { initialUrl: '/' });
      // renderRouter turns on Jest's fake timers itself (replacing earlier spies), so spy after it.
      const setT = jest.spyOn(globalThis, 'setTimeout');
      const clearT = jest.spyOn(globalThis, 'clearTimeout');
      expect(await screen.findByLabelText(X_LABEL)).toBeTruthy();
      expect(settleReads()).toBe(0); // fetchSettleData([]) answers without a read
      expect((clearT.mock.calls as unknown[][]).map((c) => c[0])).toContain(waitTimerOf(setT));
    });

    it('(f) a refresh with the settle read held: no spinner, GW stays hidden, PS1 stays settled', async () => {
      const app = spyAppState();
      await openGroups();
      const release = hold(fake.settleGates);
      const reads = settleReads();
      await app.emit('active');
      await waitFor(() => expect(settleReads()).toBe(reads + 1));
      expect(screen.queryByLabelText('Loading your bills')).toBeNull();
      expect(links()).toEqual([GX_OWES, PY_COLLECT]);
      expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
      expect(screen.queryByLabelText(GW_FALLBACK)).toBeNull();
      await release();
    });

    it('(g) a refresh whose settle read fails: every group and pill unchanged, no error', async () => {
      const app = spyAppState();
      await openGroups();
      const before = json();
      fake.settleFail = true;
      const reads = settleReads();
      await app.emit('active');
      await waitFor(() => expect(settleReads()).toBe(reads + 1)); // the failed read was made
      await act(async () => {});
      expect(links()).toEqual([GX_OWES, PY_COLLECT]);
      expect(screen.getByText('You owe $14.80')).toBeTruthy();
      expect(screen.getByText('1 person left to pay')).toBeTruthy();
      expect(toggle().props.accessibilityLabel).toBe('Settled, 2 bills');
      expect(screen.queryByLabelText(GW_FALLBACK)).toBeNull();
      expect(json()).toBe(before);
      expect(screen.queryByText(/server text|Couldn't|wrong/)).toBeNull();
    });

    it('(h) unmounting during the wait clears the timer, and the late answer changes nothing', async () => {
      const errors = jest.spyOn(console, 'error');
      const release = hold(fake.settleGates);
      const router = renderRouter(ROUTES, { initialUrl: '/' });
      // renderRouter turns on Jest's fake timers itself (replacing earlier spies), so spy after it.
      const setT = jest.spyOn(globalThis, 'setTimeout');
      const clearT = jest.spyOn(globalThis, 'clearTimeout');
      await waitFor(() => expect(settleReads()).toBe(1));
      const timer = waitTimerOf(setT);
      expect(timer).toBeDefined();
      expect((clearT.mock.calls as unknown[][]).map((c) => c[0])).not.toContain(timer); // still waiting
      router.unmount();
      expect((clearT.mock.calls as unknown[][]).map((c) => c[0])).toContain(timer);
      await release();
      await act(async () => {
        jest.advanceTimersByTime(FIRST_SETTLE_WAIT_MS);
      });
      expect(errors).not.toHaveBeenCalled();
    });
  });

  it('review R3: the payer changes in the list and the settle read fails: the old plan is dropped, so the row is under Owed to you', async () => {
    const app = spyAppState();
    useSettleBills(owesBill(GX));
    server.rows = [settleRow(GX)];
    await openGroups(1);
    expect(rowsUnder('Waiting on you')).toEqual([GX_OWES]); // positive control: Hana's plan applied
    // Hana makes B the payer; the refresh's settle read fails, so no new plan arrives.
    server.rows = [settleRow(GX, { payer_id: B })];
    fake.settleFail = true;
    const reads = settleReads();
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toBe(reads + 1)); // the failed read was made
    await act(async () => {});
    // The kept plan said Hana pays; the list says B. Without that plan B is the payer with no plan:
    // Owed to you, the total, no pill (GV-5), and no stale "You owe".
    expect(rowsUnder('Owed to you')).toEqual(["Hana's bill, Nov 20, 2 people, total $44.80"]);
    expect(querySection('Waiting on you')).toBeNull();
    expect(screen.queryByText('You owe $14.80')).toBeNull();
  });

  it('34: coming back: GW owes more → Waiting with "Paid · $1.40 more to pay"; PS1 a share up → Owed; the toggle goes', async () => {
    const app = spyAppState();
    useSettleBills(owesBill(GX), owesBill(GW, 1480), payerBill(PS1, 3000));
    server.rows = [settleRow(GX), settleRow(GW), payerRow(PS1, 5000)];
    await openGroups(1);
    expect(toggle().props.accessibilityLabel).toBe('Settled, 1 bill');
    // GW's share goes to $16.20 (B marked $14.80); Hana's on PS1 to $32.00 (she marked $30.00).
    const gw = settleBill(GW, [
      { user: A, cents: 3000 },
      { user: B, cents: 1620, marked: 1480 },
    ]);
    const ps1 = settleBill(
      PS1,
      [
        { user: A, cents: 3200, marked: 3000 },
        { user: B, cents: 1480 },
      ],
      0,
      B,
    );
    useSettleBills(owesBill(GX), gw, ps1);
    await app.emit('active');
    expect(await screen.findByText('Paid · $1.40 more to pay')).toBeTruthy();
    expect(rowsUnder('Waiting on you')).toEqual([GX_OWES, expect.stringMatching(/^Hana's bill, Nov 20, 2 people, your share \$16\.20\. /)]);
    expect(screen.getByText('1 difference to settle')).toBeTruthy();
    expect(rowsUnder('Owed to you')).toEqual([expect.stringMatching(/^Your bill, Nov 20, 2 people, to collect \$2\.00\. /)]);
    expect(queryToggle()).toBeNull();
  });

  // Tab-bar spec Task 5 (U1): Groups moved to its own tab, so Home has no Groups block. These were the
  // groups-mvp T13 / home-groups-v2 D6 placement tests; they now check the block is gone in each state.
  const myGroupsReads = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'my_groups');

  it('Groups (tab-bar Task 5): with a group, Home has no Groups block; the bills and Settled are all there is', async () => {
    myGroups = [TAHOE];
    await openGroups();
    expect(rowsUnder('Waiting on you')).toEqual([GX_OWES]); // positive control: the sections have landed
    expect(rowsUnder('Owed to you')).toEqual([PY_COLLECT]);
    expect(links()).toEqual([GX_OWES, PY_COLLECT]);
    expect(screen.getByText('Settled (2)')).toBeTruthy();
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    expect(screen.queryByRole('header', { name: 'Groups' })).toBeNull();
    expect(screen.queryByText('Start a group')).toBeNull();
    expect(myGroupsReads()).toHaveLength(0); // Home doesn't read groups at all now
  });

  it('Groups (tab-bar Task 5): with no groups, no "Start a group" link on Home either', async () => {
    await openGroups();
    expect(links()).toEqual([GX_OWES, PY_COLLECT]);
    expect(screen.getByText('Settled (2)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start a group' })).toBeNull();
    expect(screen.queryByRole('header', { name: 'Groups' })).toBeNull();
  });

  it('GR-HW-1 (tab-bar Task 5): no Groups block during the first-load settle wait, nor once it ends', async () => {
    myGroups = [TAHOE];
    const release = hold(fake.settleGates);
    renderRouter(ROUTES, { initialUrl: '/' });
    await waitFor(() => expect(settleReads()).toBe(1)); // the list has landed, the settle read is held
    expect(screen.getByLabelText('Loading your bills')).toBeTruthy(); // positive control: the wait
    await act(async () => {});
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    await release();
    expect(await screen.findByLabelText(GX_OWES)).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    expect(screen.queryByRole('header', { name: 'Groups' })).toBeNull();
    expect(myGroupsReads()).toHaveLength(0);
  });
});

// Tab-bar spec Task 5: Home's Groups and Profile icons are gone; Groups and Profile are tabs.
describe.each(['ios', 'web'] as const)('Home header without icons; Groups is a tab (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Home\'s header is only "SplitIt"; the Groups tab opens /groups once', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openHome();
    expect(screen.getByRole('header', { name: 'SplitIt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Groups' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Profile' })).toBeNull();
    const groupsTab = screen.getByLabelText('Groups');
    expect(barOf().node.findAll((n) => n === groupsTab)).toHaveLength(1);
    await press(groupsTab);
    await waitFor(() => expect(router.getPathname()).toBe('/groups'));
    expect(await screen.findByRole('header', { name: 'Groups' })).toBeTruthy();
    // A tab switch, not a push: nothing is stacked above the tabs.
    expect(push).not.toHaveBeenCalled();
  });

  it('Home never navigates to /groups by itself', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    myGroups = [TAHOE];
    const router = await openHome();
    expect(await screen.findByText("Hana's bill")).toBeTruthy(); // positive control: the rows have landed
    await act(async () => {});
    expect(router.getPathname()).toBe('/');
    expect(push).not.toHaveBeenCalled();
  });
});

// GR-HW-1 (resolved), then tab-bar spec Task 5: with no bill sections Home still has no Groups block.
describe.each(['ios', 'web'] as const)('Home without bill sections has no Groups block (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    myGroups = [TAHOE];
  });

  it('no bills + a group: "No bills yet." and no Groups block', async () => {
    server.rows = [];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText('No bills yet.')).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    expect(screen.queryByRole('header', { name: 'Groups' })).toBeNull();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'my_groups')).toHaveLength(0);
  });

  it('bills fail to load + a group: the error card and no Groups block', async () => {
    server.myBills = () => ({ data: null, error: { code: '08006', message: 'x' } });
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText("Couldn't load your bills.")).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'my_groups')).toHaveLength(0);
  });

  it('first load (bills still loading): no Groups block, and no groups read yet', async () => {
    server.myBills = () => new Promise<FakeResult>(() => {});
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText('Loading your bills')).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText('Tahoe trip')).toBeNull();
    expect(screen.queryByText('Start a group')).toBeNull();
    expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'my_groups')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Who paid X2 (docs/specs/2026-11-26-who-paid.md D10, Dependency X2): split-paid bills on Home.
// Each plan is ledgerSettlePlan's over the bill_payers rows, so a split bill gets its group, pill
// and amount like any other (the WP-PAGE-7 "no pill on split bills" guard is gone). The viewer is B.
// ---------------------------------------------------------------------------

const SP1 = '33333333-3333-4333-8333-000000000001'; // Hana and B paid 1500 each; Cy owes each 500
const SP2 = '33333333-3333-4333-8333-000000000002'; // Hana and Cy paid 1500 each; B owes each 500
const SP3 = '33333333-3333-4333-8333-000000000003'; // Hana's split adds up to 2500 of 3000: stale
const SP4 = '33333333-3333-4333-8333-000000000004'; // B hosts and leads a stale split

/** Three people, $10.00 each; `payer` hosts and leads. */
const threeWay = (id: string, payer = A) =>
  settleBill(
    id,
    [
      { user: A, cents: 1000 },
      { user: B, cents: 1000 },
      { user: C, cents: 1000 },
    ],
    0,
    payer,
  );
const PAYERS: Record<string, { user_id: string; paid_cents: number }[]> = {
  [SP1]: [
    { user_id: A, paid_cents: 1500 },
    { user_id: B, paid_cents: 1500 },
  ],
  [SP2]: [
    { user_id: A, paid_cents: 1500 },
    { user_id: C, paid_cents: 1500 },
  ],
  [SP3]: [
    { user_id: A, paid_cents: 1500 },
    { user_id: C, paid_cents: 1000 },
  ],
  [SP4]: [
    { user_id: B, paid_cents: 1500 },
    { user_id: A, paid_cents: 1000 },
  ],
};
/** The bill_payers read, answering only the ids asked for (as PostgREST's `.in()`). */
function seedPayers(payers: Record<string, { user_id: string; paid_cents: number }[]>) {
  supabase.__setTable('bill_payers', async (q) => {
    const ids = (q.calls.find((c) => c.method === 'in')?.args[1] as unknown[] | undefined) ?? [];
    return { data: ids.flatMap((id) => (payers[String(id)] ?? []).map((p) => ({ ...p, bill_id: id }))), error: null };
  });
}

describe.each(['ios', 'web'] as const)('Home split-paid bills, who paid X2 (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    fake.settleGates = [];
    fake.settleFail = false;
    fake.countGates = [];
    fake.countFail = false;
    fake.people = { [SP1]: 3, [SP2]: 3, [SP3]: 3, [SP4]: 3 };
    useSettleBills(threeWay(SP1), threeWay(SP2), threeWay(SP3), threeWay(SP4, B));
    seedTables();
    seedPayers(PAYERS);
    server.rows = [
      settleRow(SP1, { total_cents: 3000 }),
      settleRow(SP2, { total_cents: 3000 }),
      settleRow(SP3, { total_cents: 3000 }),
      settleRow(SP4, { host_id: B, host_name: 'Bo', payer_id: B, total_cents: 3000 }),
    ];
  });

  afterEach(() => {
    // The default for a table no test seeds: no rows (one-person bills).
    supabase.__setTable('bill_payers', { data: [], error: null });
  });

  const SP1_LABEL = "Hana's bill, Nov 20, 3 people, to collect $5.00. 1 person still has to pay you";
  const SP2_LABEL = "Hana's bill, Nov 20, 3 people, your share $10.00. You owe 2 people $10.00: Cy $5.00, Hana $5.00";
  // A stale split: the guests' copy, and the host's (B hosts and leads SP4).
  const SP3_LABEL = "Hana's bill, Nov 20, 3 people, total $30.00. Who paid is being updated. You can settle up once it's fixed";
  const SP4_LABEL = "Your bill, Nov 20, 3 people, total $30.00. Who paid doesn't match the new total. Fix who paid";

  it('a co-payer is under "Owed to you" with "To collect"; an ower and both stale splits are under "Waiting on you"', async () => {
    renderRouter(ROUTES, { initialUrl: '/' });
    // The plans have landed once B's co-payer row reads what's left to collect.
    expect(await screen.findByLabelText(SP1_LABEL)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Nov 20 · 3 people')).toHaveLength(4));
    // The whole list under each heading (the order is my_bills'), so no row is elsewhere in any form.
    expect(rowsUnder('Owed to you')).toEqual([SP1_LABEL]);
    expect(rowsUnder('Waiting on you')).toEqual([SP2_LABEL, SP3_LABEL, SP4_LABEL]);
    expect(links()).toEqual([SP2_LABEL, SP3_LABEL, SP4_LABEL, SP1_LABEL]);
    expect(queryToggle()).toBeNull();
    // The pills are drawn (not only in the labels).
    expect(screen.getByText('1 person left to pay')).toBeTruthy();
    expect(screen.getByText('Fix who paid')).toBeTruthy();
    // SP1: B is owed $5.00 by Cy; the figure is "To collect", not the $30.00 total.
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('To collect')).toBeTruthy();
    // SP2: B's share with "Your share".
    expect(screen.getByText('$10.00')).toBeTruthy();
    expect(screen.getByText('Your share')).toBeTruthy();
  });

  it('another user changes the split while Home is open: on refresh SP1 goes stale and moves to "Waiting on you"', async () => {
    const app = spyAppState();
    useSettleBills(threeWay(SP1));
    server.rows = [settleRow(SP1, { total_cents: 3000 })];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(SP1_LABEL)).toBeTruthy(); // positive control
    // Hana edits who paid: her 1500 becomes 1000, so the split adds up to 2500 of 3000.
    seedPayers({
      [SP1]: [
        { user_id: A, paid_cents: 1000 },
        { user_id: B, paid_cents: 1500 },
      ],
    });
    await app.emit('active');
    const stale = "Hana's bill, Nov 20, 3 people, total $30.00. Who paid is being updated. You can settle up once it's fixed";
    expect(await screen.findByLabelText(stale)).toBeTruthy();
    expect(rowsUnder('Waiting on you')).toEqual([stale]);
    expect(querySection('Owed to you')).toBeNull();
    expect(links()).toEqual([stale]);
  });

  it('a failed refresh keeps the split plans: no row moves, no error', async () => {
    const app = spyAppState();
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(SP1_LABEL)).toBeTruthy();
    fake.settleFail = true;
    const reads = settleReads();
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toBe(reads + 1)); // the failed read was made
    await act(async () => {});
    expect(rowsUnder('Owed to you')).toEqual([SP1_LABEL]);
    expect(rowsUnder('Waiting on you')).toEqual([SP2_LABEL, SP3_LABEL, SP4_LABEL]);
    expect(screen.queryByText(/Couldn.t load/)).toBeNull();
  });

  it('review R3 for splits: the lead changes in the list and the settle read fails: the kept routes plan is dropped', async () => {
    const app = spyAppState();
    useSettleBills(threeWay(SP2));
    server.rows = [settleRow(SP2, { total_cents: 3000 })];
    renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByLabelText(SP2_LABEL)).toBeTruthy(); // positive control: the routes plan applied
    // The bill now names B as payer_id (one payer); the refresh's settle read fails.
    server.rows = [settleRow(SP2, { total_cents: 3000, payer_id: B })];
    fake.settleFail = true;
    const reads = settleReads();
    await app.emit('active');
    await waitFor(() => expect(settleReads()).toBe(reads + 1));
    await act(async () => {});
    // Without the kept plan B is the payer with no plan: Owed to you, the total, no pill (GV-5).
    expect(links()).toEqual(["Hana's bill, Nov 20, 3 people, total $30.00"]);
    expect(rowsUnder('Owed to you')).toEqual(["Hana's bill, Nov 20, 3 people, total $30.00"]);
    expect(screen.queryByText(/^You owe/)).toBeNull();
  });
});
