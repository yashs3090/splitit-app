// Group claim status on the bill screen (spec docs/specs/2026-11-27-group-claim-status.md T6,
// criteria 30–32, 34 and 35): the slight warningSurface tint on each still-unclaimed row of a group
// bill, and the "Nothing here was yours? I wasn't part of this" / Undo line under the items.
// Same fake server as __tests__/groupBillScreen.test.tsx (that file is the Groups session's; this one
// adds bill_not_part and set_not_part). Everything runs through the real lib/groups.ts wrappers.
// Every entry is a cold deep link; iOS and web both run.
//
// The bill: Burger $15.00, Fries $6.00, total $21.00, host and payer Ana. People: Ana, Ben, Cy, all
// in Tahoe trip. The viewer is Ben. By default Ana has Burger and Fries is nobody's.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { router as appRouter } from 'expo-router';
import { Platform, StyleSheet, Text } from 'react-native';

import { clearGroupReceipt } from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors } from '@/lib/theme';
import { fakeSession, type FakeResult, type FakeSupabase, type RecordedQuery } from '@/test-utils/fakes';

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

const TINT = colors.light.warningSurface;
const PROMPT = 'Nothing here was yours?';
const DONE = "You said you weren't part of this.";
const NOT_PART = "I wasn't part of this";
const UNDO = 'Undo, I was part of this';

type Claim = { line_item_id: string; user_id: string; parts: number };

/** A read or write that answers now ('ok'), fails, or waits for the test to release it. */
type Gate = 'ok' | 'fail' | Promise<void>;

/** What the fake server holds. */
const db: {
  groupId: string | null;
  claims: Claim[];
  /** Ben's bill_not_part row for the bill. */
  notPart: boolean;
  notPartRead: Gate;
  /** set_not_part's answer: null lands the write; otherwise the error it fails with. */
  setNotPart: { code: string; message: string } | null;
  setNotPartGate: Promise<void> | null;
  /** The reads after this many bill_not_part reads fail (a reread after a write). */
  failReadsAfter: number | null;
  /** Holds assign_item open until released. */
  assignGate: Promise<void> | null;
} = {
  groupId: GROUP,
  claims: [],
  notPart: false,
  notPartRead: 'ok',
  setNotPart: null,
  setNotPartGate: null,
  failReadsAfter: null,
  assignGate: null,
};

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
const notPartReads = () => supabase.__queries.filter((q) => q.table === 'bill_not_part');
const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);

function installServer() {
  supabase.__setTable('bills', (q) => (selects(q, 'group_id') ? ok({ group_id: db.groupId }) : ok(billRow())));
  supabase.__setTable('groups', () => ok({ id: GROUP, name: 'Tahoe trip' }));
  supabase.__setTable('line_items', () => ok([itemRow(BURGER, 'Burger', 1500, 0), itemRow(FRIES, 'Fries', 600, 1)]));
  supabase.__setTable('bill_participants', () => ok([person(ANA, 'Ana', 0), person(BEN, 'Ben', 1), person(CY, 'Cy', 2)]));
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  supabase.__setTable('bill_not_part', async () => {
    const gate = db.notPartRead;
    if (gate === 'fail') return failure('08006', 'server text: connection lost');
    if (gate !== 'ok') await gate;
    if (db.failReadsAfter !== null && notPartReads().length > db.failReadsAfter) return failure('08006', 'server text');
    return ok(db.notPart ? [{ bill_id: BILL }] : []);
  });
  supabase.__setRpc(async (fn, args) => {
    if (fn === 'set_not_part') {
      if (db.setNotPartGate !== null) await db.setNotPartGate;
      if (db.setNotPart !== null) return failure(db.setNotPart.code, db.setNotPart.message);
      db.notPart = (args as { p_not_part: boolean }).p_not_part;
      return ok(null);
    }
    if (fn === 'assign_item') {
      if (db.assignGate !== null) await db.assignGate;
      const a = args as { p_line_item_id: string; p_parts: Record<string, number> };
      db.claims = [
        ...db.claims.filter((c) => c.line_item_id !== a.p_line_item_id),
        ...Object.entries(a.p_parts).map(([user_id, parts]) => ({ line_item_id: a.p_line_item_id, user_id, parts })),
      ];
      return ok(null);
    }
    return ok(null);
  });
}

function signInAs(userId: string) {
  const session = fakeSession('Someone');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

const ROUTES = {
  appDir: './app',
  overrides: {
    '(app)/groups/[id]/index': () => <Text>Group stand-in</Text>,
  },
};

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};

/** The background of the row that holds `toggle` (its nearest ancestor with one: the row, or the card). */
function rowBackground(toggleLabel: string): string | undefined {
  let node = screen.getByLabelText(toggleLabel).parent;
  while (node) {
    const style: unknown = node.props.style;
    // Host views only: a composite above the toggle can carry the toggle's own style.
    if (typeof node.type === 'string' && typeof style !== 'function') {
      const bg = (StyleSheet.flatten(style as Parameters<typeof StyleSheet.flatten>[0]) as { backgroundColor?: string } | undefined)
        ?.backgroundColor;
      if (bg !== undefined) return bg;
    }
    node = node.parent;
  }
  return undefined;
}

async function openBill() {
  renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
  // Positive control for every absence check below: the items are on screen.
  await screen.findByText('Total $21.00');
  expect(screen.getByLabelText(/^(Un)?[Cc]laim Burger$/)).toBeTruthy();
}

/** Waits for the line, i.e. for the not-part read to have landed. */
const findPrompt = () => screen.findByText(PROMPT);

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  clearGroupReceipt();
  db.groupId = GROUP;
  db.claims = [{ line_item_id: BURGER, user_id: ANA, parts: 1 }];
  db.notPart = false;
  db.notPartRead = 'ok';
  db.setNotPart = null;
  db.setNotPartGate = null;
  db.failReadsAfter = null;
  db.assignGate = null;
  installServer();
  signInAs(BEN);
});

describe('contrast (criterion 30)', () => {
  // WCAG relative luminance from the theme's hex values.
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  it.each(['light', 'dark'] as const)('text and textMuted on warningSurface are at least 4.5:1 (%s)', (scheme) => {
    const c = colors[scheme];
    expect(ratio(c.text, c.warningSurface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.textMuted, c.warningSurface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each(['ios', 'web'] as const)('a group bill (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('30/32: the unclaimed row is tinted, the claimed one isn\'t; the prompt and its button show', async () => {
    await openBill();
    await findPrompt();
    expect(rowBackground('Claim Fries')).toBe(TINT);
    expect(rowBackground('Claim Burger')).not.toBe(TINT);
    const link = screen.getByRole('button', { name: NOT_PART });
    expect(link.props.accessibilityHint).toBe("Stops reminding you about this receipt. It doesn't change anyone's share.");
    // The read names its one column, for this bill.
    const q = notPartReads()[0];
    expect(q && selects(q, 'bill_id')).toBe(true);
    expect(q?.calls.some((c) => c.method === 'eq' && c.args[0] === 'bill_id' && c.args[1] === BILL)).toBe(true);
  });

  it('31: tapping Claim on a tinted row clears its tint before the save lands', async () => {
    let land = () => {};
    db.assignGate = new Promise<void>((r) => (land = r));
    await openBill();
    await findPrompt();
    expect(rowBackground('Claim Fries')).toBe(TINT);
    await press(screen.getByLabelText('Claim Fries'));
    // The save is still in flight: the row reads Mine and is no longer tinted.
    expect(rpcCalls('assign_item')).toHaveLength(1);
    expect(rowBackground('Unclaim Fries')).not.toBe(TINT);
    await act(async () => land());
    // The server now has my claim: the line goes.
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect(screen.getByLabelText('Unclaim Fries')).toBeTruthy();
  });

  it('32: once a server claim of mine exists, the line is gone; still-unclaimed rows stay tinted', async () => {
    db.claims = [{ line_item_id: BURGER, user_id: BEN, parts: 1 }];
    await openBill();
    await waitFor(() => expect(notPartReads().length).toBeGreaterThan(0));
    // Positive control: the read has landed and tints the unclaimed row.
    await waitFor(() => expect(rowBackground('Claim Fries')).toBe(TINT));
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByRole('button', { name: NOT_PART })).toBeNull();
  });

  it('32: opted out: "You said you weren\'t part of this." with Undo, and no row is tinted', async () => {
    db.notPart = true;
    await openBill();
    expect(await screen.findByText(DONE)).toBeTruthy();
    const undo = screen.getByRole('button', { name: UNDO });
    expect(undo.props.accessibilityHint).toBe('Reminds you to claim your items on this receipt again');
    expect(rowBackground('Claim Fries')).not.toBe(TINT);
    expect(screen.queryByText(PROMPT)).toBeNull();
  });

  it('32: a fully claimed bill with no opt-out shows no line and no tint', async () => {
    db.claims = [
      { line_item_id: BURGER, user_id: ANA, parts: 1 },
      { line_item_id: FRIES, user_id: CY, parts: 1 },
    ];
    await openBill();
    // Positive control: the read has landed (opted out would show its line here).
    await waitFor(() => expect(notPartReads().length).toBeGreaterThan(0));
    await screen.findByRole('link', { name: 'Settled in Tahoe trip' });
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByText(DONE)).toBeNull();
    expect(rowBackground('Claim Fries')).not.toBe(TINT);
  });

  it('34: while the read is loading, no tint and no line; then both arrive', async () => {
    let release = () => {};
    db.notPartRead = new Promise<void>((r) => (release = r));
    await openBill();
    await waitFor(() => expect(notPartReads()).toHaveLength(1));
    expect(rowBackground('Claim Fries')).not.toBe(TINT);
    expect(screen.queryByText(PROMPT)).toBeNull();
    await act(async () => release());
    expect(await findPrompt()).toBeTruthy();
    expect(rowBackground('Claim Fries')).toBe(TINT);
  });

  it('34: a failed read tints the rows and hides the line, with no alert; coming back reads again', async () => {
    db.notPartRead = 'fail';
    await openBill();
    await waitFor(() => expect(rowBackground('Claim Fries')).toBe(TINT));
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Leave and come back: the screen's focus reads again, and this time it lands.
    db.notPartRead = 'ok';
    const before = notPartReads().length;
    await press(await screen.findByRole('link', { name: 'Settled in Tahoe trip' }));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
    act(() => appRouter.back());
    expect(await findPrompt()).toBeTruthy();
    expect(notPartReads().length).toBeGreaterThan(before);
  });

  it('review R1: has_claims keeps its words while my claim shows, and drops them once I unclaim', async () => {
    const HAS_CLAIMS = "You've claimed something on this receipt, so you're part of it.";
    await openBill();
    await findPrompt();
    // The server already has Ben on Fries (someone assigned him); this screen hasn't seen it yet.
    db.setNotPart = { code: '22023', message: 'has_claims' };
    db.claims = [...db.claims, { line_item_id: FRIES, user_id: BEN, parts: 1 }];
    await press(screen.getByRole('button', { name: NOT_PART }));
    // The refetch shows his claim: no prompt, and the words say why.
    expect(await screen.findByLabelText('Unclaim Fries')).toBeTruthy();
    expect(screen.getByText(HAS_CLAIMS)).toBeTruthy();
    expect(screen.queryByText(PROMPT)).toBeNull();
    // He unclaims: the prompt is back, and "You've claimed something…" would be false now.
    await press(screen.getByLabelText('Unclaim Fries'));
    expect(await findPrompt()).toBeTruthy();
    expect(screen.queryByText(HAS_CLAIMS)).toBeNull();
  });

  it('review R1: a network error, then claiming: the error goes with the line', async () => {
    await openBill();
    await findPrompt();
    db.setNotPart = { code: '08006', message: 'server text' };
    await press(screen.getByRole('button', { name: NOT_PART }));
    expect(await screen.findByText('Something went wrong. Check your connection and try again.')).toBeTruthy();
    await press(screen.getByLabelText('Claim Fries'));
    await waitFor(() => expect(screen.queryByText(PROMPT)).toBeNull());
    expect(screen.getByLabelText('Unclaim Fries')).toBeTruthy();
    expect(screen.queryByText('Something went wrong. Check your connection and try again.')).toBeNull();
  });

  it('35: a double tap sends one set_not_part; busy until the reread; then the line flips; Undo sends false', async () => {
    let release = () => {};
    db.setNotPartGate = new Promise<void>((r) => (release = r));
    await openBill();
    const link = await screen.findByRole('button', { name: NOT_PART });
    await press(link);
    await press(link);
    expect(rpcCalls('set_not_part')).toEqual([['set_not_part', { p_bill_id: BILL, p_not_part: true }]]);
    expect(screen.getByRole('button', { name: NOT_PART }).props.accessibilityState).toMatchObject({ busy: true });
    await act(async () => release());
    expect(await screen.findByText(DONE)).toBeTruthy();
    expect(rowBackground('Claim Fries')).not.toBe(TINT);
    db.setNotPartGate = null;
    await press(screen.getByRole('button', { name: UNDO }));
    expect(await findPrompt()).toBeTruthy();
    expect(rpcCalls('set_not_part')[1]).toEqual(['set_not_part', { p_bill_id: BILL, p_not_part: false }]);
    expect(rowBackground('Claim Fries')).toBe(TINT);
  });

  it('35: has_claims shows its words under the line and rereads', async () => {
    db.setNotPart = { code: '22023', message: 'has_claims' };
    await openBill();
    await findPrompt();
    const reads = notPartReads().length;
    await press(screen.getByRole('button', { name: NOT_PART }));
    expect(await screen.findByText("You've claimed something on this receipt, so you're part of it.")).toBeTruthy();
    await waitFor(() => expect(notPartReads().length).toBeGreaterThan(reads));
    expect(screen.getByRole('button', { name: NOT_PART }).props.accessibilityState?.busy).toBeFalsy();
  });

  it('35: a network failure shows the network words and re-enables the link', async () => {
    db.setNotPart = { code: '08006', message: 'server text: connection lost' };
    await openBill();
    await findPrompt();
    await press(screen.getByRole('button', { name: NOT_PART }));
    expect(await screen.findByText("Something went wrong. Check your connection and try again.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    const link = screen.getByRole('button', { name: NOT_PART });
    expect(link.props.accessibilityState?.busy).toBeFalsy();
    expect(link.props.accessibilityState?.disabled).toBeFalsy();
  });

  it('saved, but the reread failed: "Couldn\'t refresh. Try again." and Refresh; the link works again', async () => {
    await openBill();
    await findPrompt();
    db.failReadsAfter = notPartReads().length;
    await press(screen.getByRole('button', { name: NOT_PART }));
    expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: NOT_PART }).props.accessibilityState?.busy).toBeFalsy();
    db.failReadsAfter = null;
    await press(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(DONE)).toBeTruthy();
    expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
  });
});

describe.each(['ios', 'web'] as const)('a bill in no group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('30: no row is tinted, no line, and no bill_not_part read is made', async () => {
    db.groupId = null;
    await openBill();
    // Positive control: the group read has answered (openBill waits for it: the screen shows nothing before).
    await waitFor(() => expect(supabase.__queries.some((q) => q.table === 'bills' && selects(q, 'group_id'))).toBe(true));
    expect(rowBackground('Claim Fries')).not.toBe(TINT);
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(notPartReads()).toHaveLength(0);
  });
});
