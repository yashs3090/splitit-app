// Settle up screen: criteria 42–53a in docs/specs/2026-11-24-m3-settle-venmo.md (Amendment A1, Task 9),
// copy from docs/specs/2026-11-24-m3-settle-ux.md §10.
//
// The bill is the spec's D3 worked example: Burger 15.00 (Hana), Salad 10.00 (Sam), Fries 6.00
// (both), total 36.00, proportional. Hana (A) hosts and is the payer (handle hana-1); Sam (B) owes
// $15.10. Dee (D) joins in some tests; C is an outsider.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import Check from 'lucide-react-native/icons/check';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { AccessibilityInfo, Platform } from 'react-native';

import { BILL_ERROR_COPY } from '@/lib/bills';
import { openPaymentLink } from '@/lib/paylinks';
import { savePendingInvite } from '@/lib/pendingInvite';
import { SETTLE_ALL_ZERO_COPY } from '@/lib/settle';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeChannel, type FakeDbError, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('@/lib/paylinks', () => {
  const actual = jest.requireActual<typeof import('@/lib/paylinks')>('@/lib/paylinks');
  return { ...actual, openPaymentLink: jest.fn(async () => ({ ok: true })) };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const openLink = openPaymentLink as jest.MockedFunction<typeof openPaymentLink>;
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const BURGER = '22222222-0000-4000-8000-000000000001';
const SALAD = '22222222-0000-4000-8000-000000000002';
const FRIES = '22222222-0000-4000-8000-000000000003';
const CODE = '0123456789abcdef0123';
const MONEY = /\$[\d,]+\.\d\d/;
const AT = '2026-11-24T19:30:00Z';

type Claim = { line_item_id: string; user_id: string; parts: number };
type Person = { id: string; name: string; venmo: string | null; mark: number | null };

const db: {
  bill: Record<string, unknown>;
  rows: Record<string, unknown>[];
  people: Person[];
  claims: Claim[];
  fail: boolean;
} = { bill: {}, rows: [], people: [], claims: [], fail: false };

/** What the next rpc call of each kind returns (default: success, applied to `db`). */
const next: {
  mark: FakeDbError | null;
  unmark: FakeDbError | null;
  setPayer: FakeDbError[];
  hold: Promise<void> | null;
  /** After a successful write, every bills read fails (the screen's own refetch fails). */
  failReadsAfterWrite: boolean;
  /** The next bills read waits for this (one shot). */
  holdNextRead: Promise<void> | null;
} = { mark: null, unmark: null, setPayer: [], hold: null, failReadsAfterWrite: false, holdNextRead: null };

function row(id: string, name: string, cents: number, g: number) {
  return { id, name, note: null, group_position: g, unit_index: 0, group_size: 1, total_cents: cents, split_set_by: null, split_set_at: null };
}
/** The decoded `note` parameter of a Venmo link. */
function noteOf(url: string | undefined): string | null {
  if (url === undefined) throw new Error('no link opened');
  return new URL(url).searchParams.get('note');
}
/** Venmo note spec criterion 8: the note never carries people's names or the amount. */
function expectPrivateNote(url: string | undefined) {
  const note = noteOf(url);
  for (const secret of ['Hana', 'Sam', '15.10']) expect(note).not.toContain(secret);
}
const claim = (rowId: string, userId: string): Claim => ({ line_item_id: rowId, user_id: userId, parts: 1 });
const person = (id: string, name: string, venmo: string | null = null, mark: number | null = null): Person => ({ id, name, venmo, mark });
const me = (id: string) => {
  const p = db.people.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
};

function reset() {
  db.bill = {
    id: BILL,
    host_id: A,
    payer_id: A,
    subtotal_cents: null,
    tax_cents: 500,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 3600,
    join_code: CODE,
    created_at: '2026-11-24T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
  db.rows = [row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)];
  db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam')];
  db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, A), claim(FRIES, B)];
  db.fail = false;
  next.mark = null;
  next.unmark = null;
  next.setPayer = [];
  next.hold = null;
  next.failReadsAfterWrite = false;
  next.holdNextRead = null;
}

function installServer() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', async () => {
    const hold = next.holdNextRead;
    next.holdNextRead = null;
    const failed = db.fail; // decided when the read starts
    const snapshot = { ...db.bill };
    if (hold) await hold;
    return failed ? { data: null, error: { code: '08006', message: 'server text' } } : ok(snapshot);
  });
  supabase.__setTable('line_items', () => ok(db.rows.map((r) => ({ ...r }))));
  supabase.__setTable('bill_participants', () =>
    ok(
      db.people.map((p, i) => ({
        user_id: p.id,
        joined_at: `2026-11-24T19:0${i}:00Z`,
        settled_at: p.mark === null ? null : AT,
        settled_cents: p.mark,
        profile: { display_name: p.name, venmo_username: p.venmo },
      })),
    ),
  );
  supabase.__setTable('claims', () => ok(db.claims.map((c) => ({ ...c }))));
  supabase.__setTable('profiles', (q) => {
    const update = q.calls.find((c) => c.method === 'update');
    if (update) {
      const patch = update.args[0] as { venmo_username: string | null };
      me(viewer).venmo = patch.venmo_username;
      return ok([{ venmo_username: patch.venmo_username }]);
    }
    const p = me(viewer);
    return ok({ display_name: p.name, venmo_username: p.venmo });
  });
  supabase.__setRpc(async (fn, args) => {
    if (next.hold) await next.hold;
    const a = args ?? {};
    if (fn === 'mark_paid') {
      if (next.mark) return { data: null, error: next.mark };
      me(viewer).mark = a.p_cents as number;
    } else if (fn === 'unmark_paid') {
      if (next.unmark) return { data: null, error: next.unmark };
      me(a.p_user_id as string).mark = null;
    } else if (fn === 'set_payer') {
      const err = next.setPayer.shift();
      if (err) return { data: null, error: err };
      if (a.p_payer_id !== db.bill.payer_id) {
        db.bill.payer_id = a.p_payer_id;
        db.people.forEach((p) => (p.mark = null));
      }
    } else if (fn === 'venmo_prompt_pending') {
      return ok(false);
    }
    if (next.failReadsAfterWrite && ['mark_paid', 'unmark_paid', 'set_payer'].includes(fn)) db.fail = true;
    return ok(null);
  });
}

let viewer = B;
function signInAs(id: string) {
  viewer = id;
  const s = fakeSession('Test User');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
}

const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);
const writes = () => supabase.rpc.mock.calls.filter(([name]) => ['mark_paid', 'unmark_paid', 'set_payer'].includes(name));
const billFetches = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};
/** The element sits inside a Banner announced as an alert (accessibilityRole="alert"). */
function inAlert(el: { parent: unknown }): boolean {
  let node = el as { parent: unknown; props?: { accessibilityRole?: string } } | null;
  while (node) {
    if (node.props?.accessibilityRole === 'alert') return true;
    node = node.parent as typeof node;
  }
  return false;
}
const disabled = (label: string) => Boolean(screen.getByLabelText(label).props.accessibilityState?.disabled);

async function openSettle(as = B) {
  signInAs(as);
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
  await screen.findByText('Settle up');
  await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());
  return router;
}

/** A server-side change arrives as a live hint; wait for the debounced refetch to land. */
async function liveChange() {
  const before = billFetches();
  await act(async () => liveChannel().__broadcast('changed'));
  await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  reset();
  installServer();
  signInAs(B);
});

// ---------------------------------------------------------------------------
// Entry paths (criterion 42), native and web
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('entry paths on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('pushed from the bill screen, and "Bill" dismisses back to it', async () => {
    signInAs(B);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $36.00');
    // B owes Hana, who has Venmo: the footer offers Pay, and Details opens Settle up (request spec F1, F-c).
    fireEvent.press(screen.getByLabelText('Settle up details'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();

    const dismissTo = jest.spyOn(globalRouter, 'dismissTo');
    fireEvent.press(screen.getByLabelText('Back to the bill'));
    expect(dismissTo).toHaveBeenCalledWith(`/bills/${BILL}`);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
    dismissTo.mockRestore();
  });

  it('a cold deep link or web reload opens the screen directly; Back still lands on the bill', async () => {
    const router = await openSettle(B);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Back to the bill'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
  });

  it('signed out: redirects to sign-in and reads nothing', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(billFetches()).toBe(0);
  });

  it('with a pending invite saved: the resume effect wins, and the settle screen writes nothing', async () => {
    await savePendingInvite(storage, CODE, Date.now());
    signInAs(B);
    supabase.__setRpc(async (fn) => (fn === 'join_bill' ? { data: BILL, error: null } : { data: null, error: null }));
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    // /b/<code> joins and opens the bill: the only navigation is the root layout's.
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
    expect(rpcCalls('join_bill')).toHaveLength(1);
    expect(writes()).toHaveLength(0);
  });

  it('a non-participant gets the not-found state', async () => {
    signInAs(C);
    supabase.__setTable('bills', () => ({ data: null, error: null }));
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText(BILL_ERROR_COPY.not_found)).toBeTruthy();
    expect(screen.getByText('Go home')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('coming back from /profile after "Add Venmo" refetches and drops the card', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    const router = await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Venmo'));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    me(A).venmo = 'hana-1'; // saved on Profile
    const before = billFetches();
    act(() => globalRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/settle`));
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByText('Add your Venmo so people can pay you')).toBeNull());
  });

  it('a failed load shows fixed copy and retries', async () => {
    db.fail = true;
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/settle` });
    expect(await screen.findByText("Couldn't load the bill.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    db.fail = false;
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Owes (criteria 44–46)
// ---------------------------------------------------------------------------

describe('owes', () => {
  it('44: shows the amount, Pay, the handle line and "I already paid"', async () => {
    await openSettle(B);
    expect(screen.getByText('Hana paid the bill')).toBeTruthy();
    expect(screen.getByText('You owe Hana')).toBeTruthy();
    expect(screen.getAllByText('$15.10')).toHaveLength(2); // the card, and Sam's row in Everyone
    expect(screen.getByText('Pay Hana $15.10 on Venmo')).toBeTruthy();
    expect(screen.getByText('@hana-1 · $15.10')).toBeTruthy();
    expect(screen.getByText('I already paid')).toBeTruthy();
    expect(screen.queryByText('Change')).toBeNull(); // host only
  });

  it('44: Pay opens Venmo synchronously with the exact link, marks nothing, then asks "Did you pay Hana?"', async () => {
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    // Called before any awaited tick: the browser still sees the user's gesture.
    expect(openLink).toHaveBeenCalledTimes(1);
    // Venmo note spec criteria 7–8: Sam's own items (Salad, shared Fries); no names or amounts.
    expect(openLink).toHaveBeenCalledWith('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    expect(rpcCalls('mark_paid')).toHaveLength(0);
    expect(await screen.findByText('Did you pay Hana?')).toBeTruthy();
    expect(screen.getByText('I paid')).toBeTruthy();
    expect(screen.getByText('Open Venmo again')).toBeTruthy();
    expect(screen.getByText('@hana-1 · $15.10')).toBeTruthy();
    act(() => jest.advanceTimersByTime(1000)); // R7: taps within ~1 s of the last Pay are ignored
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openLink).toHaveBeenCalledTimes(2);
    expect(rpcCalls('mark_paid')).toHaveLength(0);
  });

  it('44a: the "On a computer?" line shows on web and not on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const r = await openSettle(B);
    expect(screen.queryByText('On a computer? Send it from the Venmo app on your phone.')).toBeNull();
    r.unmount();
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    expect(screen.getByText('On a computer? Send it from the Venmo app on your phone.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(await screen.findByText('Did you pay Hana?')).toBeTruthy();
    expect(screen.getByText('On a computer? Send it from the Venmo app on your phone.')).toBeTruthy();
  });

  it.each([
    ['I already paid', false],
    ['I paid', true],
  ])('45: "%s" marks with the shown payer and amount; nothing is optimistic', async (label, afterPay) => {
    let release: () => void = () => {};
    await openSettle(B);
    if (afterPay) {
      fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
      await screen.findByText('Did you pay Hana?');
    }
    next.hold = new Promise<void>((r) => (release = r));
    fireEvent.press(screen.getByLabelText(label));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510 }]]);
    expect(disabled(label)).toBe(true);
    expect(screen.queryByText('Marked paid')).toBeNull();
    // A second tap while in flight sends nothing.
    fireEvent.press(screen.getByLabelText(label));
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    next.hold = null;
    await act(async () => release());
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(screen.getAllByText('$15.10').length).toBeGreaterThan(0);
    expect(screen.getByText('Marked paid').props.accessibilityLiveRegion).toBe('polite');
    expect(rpcCalls('mark_paid')).toHaveLength(1);
  });

  it('45: "Marked paid" is announced on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('I already paid'));
    await screen.findByText('You paid Hana');
    expect(announce).toHaveBeenCalledWith('Marked paid');
    announce.mockRestore();
  });

  it.each([
    ['network', { code: '08006', message: 'server text' }, "Couldn't save. Try again.", false],
    ['payer_changed', { code: '22023', message: 'payer_changed' }, BILL_ERROR_COPY.payer_changed, true],
    ['not_complete', { code: '22023', message: 'not_complete' }, BILL_ERROR_COPY.not_complete, true],
    ['not_allowed', { code: '42501', message: 'not_allowed' }, BILL_ERROR_COPY.not_allowed, false],
    ['invalid_bill', { code: '22023', message: 'is_payer' }, "Couldn't save. Refresh and try again.", true],
  ] as const)('45: %s shows its copy and re-enables the button', async (_code, error, copy, refetches) => {
    await openSettle(B);
    next.mark = error;
    const before = billFetches();
    fireEvent.press(screen.getByLabelText('I already paid'));
    const banner = await screen.findByText(copy);
    expect(inAlert(banner)).toBe(true);
    expect(screen.queryByText(/server text/)).toBeNull();
    await waitFor(() => expect(disabled('I already paid')).toBe(false));
    if (refetches) await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    else expect(billFetches()).toBe(before);
    expect(screen.queryByText('Marked paid')).toBeNull();
  });

  it('45: Venmo failing to open shows the fallback and still asks "Did you pay?"', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(await screen.findByText("Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app.")).toBeTruthy();
    expect(screen.getByText('Did you pay Hana?')).toBeTruthy();
  });

  it('45a: after Pay, the payer changes to Dee: notice, Dee\'s default, and no button marks Hana', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    await screen.findByText('Did you pay Hana?');
    db.bill.payer_id = D;
    await liveChange();
    expect(await screen.findByText('Dee is now collecting for this bill. If you already paid Hana, sort it out with them.')).toBeTruthy();
    expect(screen.getByText('You owe Dee')).toBeTruthy();
    expect(screen.queryByText('Did you pay Hana?')).toBeNull();
    fireEvent.press(screen.getByLabelText('I already paid'));
    await waitFor(() => expect(rpcCalls('mark_paid')).toHaveLength(1));
    expect(rpcCalls('mark_paid').every(([, args]) => (args as { p_payer_id: string }).p_payer_id !== A)).toBe(true);
    expect(await screen.findByText('You paid Dee')).toBeTruthy();
  });

  it('46: the payer has no Venmo: no Pay button; "I paid" still marks', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    await openSettle(B);
    expect(screen.getByText("Hana hasn't added Venmo yet. Ask them, or pay another way.")).toBeTruthy();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
    fireEvent.press(screen.getByLabelText('I paid'));
    expect(rpcCalls('mark_paid')).toEqual([['mark_paid', { p_bill_id: BILL, p_payer_id: A, p_cents: 1510 }]]);
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
  });

  it('46: the payer without a handle sees "Add Venmo", which opens /profile', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam')];
    const router = await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Venmo'));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
  });
});

// ---------------------------------------------------------------------------
// Blocked, nothing, negative, payer (criteria 43, 43a, 43b, 47, 48)
// ---------------------------------------------------------------------------

describe('other roles and states', () => {
  it('R1 (Amendment A1): blocked by an unclaimed discount only names the discount', async () => {
    const comp = { ...row('22222222-0000-4000-8000-000000000004', 'Police comp', -500, 3), kind: 'discount', applies_to: 'subtotal' };
    db.rows = [...db.rows, comp];
    await openSettle(B);
    expect(screen.getByText('You can settle up once every discount is claimed (1 discount left).')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('Venmo note criterion 8: a claimed discount ("Police comp") stays out of the note', async () => {
    const COMP = '22222222-0000-4000-8000-000000000004';
    const comp = { ...row(COMP, 'Police comp', -500, 3), kind: 'discount', applies_to: 'subtotal' };
    db.rows = [...db.rows, comp];
    db.claims = [...db.claims, claim(COMP, B)];
    await openSettle(B);
    fireEvent.press(screen.getByLabelText(/^Pay Hana \$[\d.]+ on Venmo, to @hana-1$/));
    expect(openLink).toHaveBeenCalledTimes(1);
    const note = noteOf(openLink.mock.calls[0]?.[0]);
    expect(note).toBe('SplitIt: Salad, Fries');
    expect(note).not.toContain('Police comp');
    expect(await screen.findByText('Did you pay Hana?')).toBeTruthy();
  });

  it('43: blocked (1 item left): no amounts, no buttons but Back, no Everyone list', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    const router = await openSettle(B);
    expect(screen.getByText('You can settle up once every item is claimed (1 item left).')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
    expect(screen.queryByText('I already paid')).toBeNull();
    expect(screen.queryByText('I paid')).toBeNull();
    expect(screen.queryByText('Everyone')).toBeNull();
    expect(screen.queryByText('Your "I paid" is saved.')).toBeNull();
    // The card's primary (the header's "Bill" back control carries the same label and does the same thing).
    const back = screen.getAllByLabelText('Back to the bill');
    expect(back).toHaveLength(2);
    fireEvent.press(screen.getByText('Back to the bill'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    await screen.findByText(/^Total \$/); // let the bill screen's load land inside the test
  });

  it('43: blocked with the viewer marked says the mark is saved, with no amount', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText('Your "I paid" is saved.')).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('43a: every item $0: the host gets the fix copy and Edit items; a guest gets the ask copy', async () => {
    db.rows = db.rows.map((r) => ({ ...r, total_cents: 0 }));
    db.bill.tax_cents = 3600;
    const router = await openSettle(A);
    expect(screen.getByText(SETTLE_ALL_ZERO_COPY)).toBeTruthy();
    expect(screen.queryByText(MONEY)).toBeNull();
    fireEvent.press(screen.getByLabelText('Edit items'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}/edit`));
    router.unmount();

    await openSettle(B);
    expect(screen.getByText('Every item is $0. Ask Hana to fix the prices.')).toBeTruthy();
    expect(screen.queryByText('Edit items')).toBeNull();
    expect(screen.queryByText(MONEY)).toBeNull();
  });

  it('43b: a bad payer shows an error and Try again, and never refetches on its own', async () => {
    db.bill.payer_id = C;
    await openSettle(B);
    expect(screen.getByText('Something went wrong loading this bill.')).toBeTruthy();
    const before = billFetches();
    // renderRouter runs on fake timers: let any pending timer (live debounce, retries) fire.
    act(() => jest.advanceTimersByTime(10_000));
    expect(billFetches()).toBe(before);
    db.bill.payer_id = A;
    fireEvent.press(screen.getByLabelText('Try again'));
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(billFetches()).toBe(before + 1);
  });

  it('47: nothing owed: "You\'re all set", no buttons', async () => {
    db.people = [...db.people, person(D, 'Dee')];
    await openSettle(D);
    expect(screen.getByText("You're all set")).toBeTruthy();
    expect(screen.getByText("You don't owe anything on this bill.")).toBeTruthy();
    expect(screen.queryByText('I already paid')).toBeNull();
    expect(screen.queryByText(/on Venmo$/)).toBeNull();
  });

  it('47: negative share (even mode, items 1000/0, total 800): "Hana owes you $1.00"', async () => {
    db.rows = [row(BURGER, 'Steak', 1000, 0), row(SALAD, 'Water', 0, 1)];
    db.claims = [claim(BURGER, A), claim(SALAD, B)];
    db.bill = { ...db.bill, total_cents: 800, tax_cents: 0, total_discount_cents: 200, extras_split: 'equal' };
    await openSettle(B);
    expect(screen.getByText('Hana owes you')).toBeTruthy();
    expect(screen.getByText('$1.00')).toBeTruthy();
    expect(screen.getByText('Settle that outside the app.')).toBeTruthy();
    expect(screen.queryByText('I already paid')).toBeNull();
  });

  it('48: the payer sees who owes and who paid, then "Everyone\'s paid"', async () => {
    // No extras (total 3100): Sam owes Salad + half the Fries = 1300; Dee owes half the Fries = 300.
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1300), person(D, 'Dee')];
    db.rows = [row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, B), claim(FRIES, D)];
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    await openSettle(A);
    expect(screen.getByText('You paid the bill')).toBeTruthy();
    expect(screen.getByText('2 people owe you')).toBeTruthy();
    expect(screen.getByText('$16.00')).toBeTruthy(); // 1300 + 300
    // R4: only the card says it; the payer's Everyone list has no aside.
    expect(screen.getAllByText('1 of 2 paid')).toHaveLength(1);
    expect(screen.getByLabelText('Sam, $13.00, paid')).toBeTruthy();
    expect(screen.getByLabelText('Dee, $3.00, not paid yet')).toBeTruthy();
    expect(screen.queryByLabelText(/^You, /)).toBeNull(); // the payer has no row

    me(D).mark = 300;
    await liveChange();
    expect(await screen.findByText("Everyone's paid")).toBeTruthy();
    expect(screen.getByText('All 2 marked paid')).toBeTruthy();
    expect(screen.queryByText('All paid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payer change (criterion 49)
// ---------------------------------------------------------------------------

describe('changing who paid (host)', () => {
  beforeEach(() => {
    // No extras (total 3100): Hana 1500, Sam 1000, Dee 600.
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
  });

  it('"Change" shows only for the host, and only with 2+ participants', async () => {
    const r = await openSettle(B);
    expect(screen.queryByText('Change')).toBeNull();
    r.unmount();
    db.people = [person(A, 'Hana', 'hana-1')];
    db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)];
    const r2 = await openSettle(A);
    expect(screen.queryByText('Change')).toBeNull();
    r2.unmount();
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam')];
    await openSettle(A);
    expect(screen.getByLabelText('Change').props.accessibilityHint).toBe('Choose who paid the restaurant');
  });

  it('picker rows are radios with checked state', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    expect(screen.getByText('Who paid the bill?')).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => [r.props.accessibilityLabel, r.props.accessibilityState?.checked])).toEqual([
      ['You', true],
      ['Sam', false],
      ['Dee', false],
    ]);
    expect(screen.getByLabelText('Cancel')).toBeTruthy(); // "Change" became "Cancel"
  });

  it('with 2 marks: re-reads, confirms with the count and both names, then calls setPayer(D, 2)', async () => {
    me(B).mark = 1000;
    me(A).mark = null;
    db.people.push(person(C, 'Cy', null, 100)); // a 4th participant, so 2 marks besides Dee
    db.claims.push(claim(FRIES, C));
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    const before = billFetches();
    fireEvent.press(screen.getByLabelText('Dee'));
    expect(await screen.findByText('Switch to Dee? This clears 2 "I paid" marks (Sam, Cy).')).toBeTruthy();
    expect(billFetches()).toBeGreaterThan(before);
    expect(rpcCalls('set_payer')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText('Switch to Dee'));
    expect(rpcCalls('set_payer')).toEqual([['set_payer', { p_bill_id: BILL, p_payer_id: D, p_expected_cleared: 2 }]]);
    expect(await screen.findByText('Dee paid the bill')).toBeTruthy();
    expect(screen.queryByText('Who paid the bill?')).toBeNull();
    // The host made the change: no "now collecting" notice for them.
    expect(screen.queryByText(/is now collecting/)).toBeNull();
  });

  it('expectedCleared counts every mark, including one on a person who owes nothing (not plan.paidCount)', async () => {
    db.people.push(person(C, 'Cy', null, 500)); // Cy has no claims: role "nothing", but marked
    me(B).mark = 1000;
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Dee'));
    expect(await screen.findByText('Switch to Dee? This clears 2 "I paid" marks (Sam, Cy).')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Switch to Dee'));
    expect(rpcCalls('set_payer')[0]?.[1]).toMatchObject({ p_expected_cleared: 2 });
    expect(await screen.findByText('Dee paid the bill')).toBeTruthy();
  });

  it('0 marks and complete: confirms "People may already be paying Hana.", then expectedCleared 0', async () => {
    // The viewer is the host, so the current payer must be someone else for the sentence to name them.
    db.bill.payer_id = D;
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    expect(await screen.findByText('Switch to Sam? People may already be paying Dee.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Switch to Sam'));
    expect(rpcCalls('set_payer')).toEqual([['set_payer', { p_bill_id: BILL, p_payer_id: B, p_expected_cleared: 0 }]]);
    expect(await screen.findByText('Sam paid the bill')).toBeTruthy();
  });

  it('0 marks and complete, the host is the payer: "People may already be paying you."', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    expect(await screen.findByText('Switch to Sam? People may already be paying you.')).toBeTruthy();
    expect(screen.getByLabelText('Cancel: keep yourself')).toBeTruthy();
  });

  it('0 marks and incomplete: no confirm', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD);
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    await waitFor(() => expect(rpcCalls('set_payer')).toHaveLength(1));
    expect(rpcCalls('set_payer')[0]?.[1]).toEqual({ p_bill_id: BILL, p_payer_id: B, p_expected_cleared: 0 });
    expect(screen.queryByText(/^Switch to/)).toBeNull();
    expect(await screen.findByText('Sam paid the bill')).toBeTruthy();
  });

  it('marks_changed: re-reads and the confirm shows the new count, with the error above it', async () => {
    me(B).mark = 1000;
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Dee'));
    expect(await screen.findByText('Switch to Dee? This clears 1 "I paid" mark (Sam).')).toBeTruthy();
    // Someone marks while the confirm is up; the server refuses the stale count.
    db.people.push(person(C, 'Cy', null, 100));
    next.setPayer = [{ code: '22023', message: 'marks_changed' }];
    fireEvent.press(screen.getByLabelText('Switch to Dee'));
    expect(await screen.findByText('Switch to Dee? This clears 2 "I paid" marks (Sam, Cy).')).toBeTruthy();
    expect(screen.getByText(BILL_ERROR_COPY.marks_changed)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Switch to Dee'));
    expect(rpcCalls('set_payer').map(([, a]) => (a as { p_expected_cleared: number }).p_expected_cleared)).toEqual([1, 2]);
    expect(await screen.findByText('Dee paid the bill')).toBeTruthy();
    expect(screen.queryByText(BILL_ERROR_COPY.marks_changed)).toBeNull(); // the picker closed with its error
  });

  it('Cancel makes no call; tapping the current payer makes no call', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    await screen.findByText(/^Switch to Sam\?/);
    fireEvent.press(screen.getByLabelText('Cancel: keep yourself'));
    await waitFor(() => expect(screen.queryByText(/^Switch to Sam\?/)).toBeNull());
    fireEvent.press(screen.getByLabelText('You'));
    expect(screen.queryByText('Who paid the bill?')).toBeNull();
    expect(rpcCalls('set_payer')).toHaveLength(0);
  });

  it('a double tap on the confirm sends one call', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    await screen.findByText(/^Switch to Sam\?/);
    next.hold = new Promise<void>(() => {});
    fireEvent.press(screen.getByLabelText('Switch to Sam'));
    fireEvent.press(screen.getByLabelText('Switch to Sam'));
    expect(rpcCalls('set_payer')).toHaveLength(1);
  });

  it('51: a payer change by the host updates Sam\'s screen live, with the notice', async () => {
    me(B).mark = 1000;
    await openSettle(B);
    expect(screen.getByText('You paid Hana')).toBeTruthy();
    db.bill.payer_id = D;
    db.people.forEach((p) => (p.mark = null));
    await liveChange();
    expect(await screen.findByText('Dee is now collecting for this bill. If you already paid Hana, sort it out with them.')).toBeTruthy();
    expect(screen.getByText('Dee paid the bill')).toBeTruthy();
    expect(screen.getByText('You owe Dee')).toBeTruthy();
    expect(screen.getByText('Pay Dee $10.00 on Venmo')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Dismiss notice'));
    expect(screen.queryByText(/is now collecting/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Undo (criterion 50) and live (51)
// ---------------------------------------------------------------------------

describe('undo and live', () => {
  beforeEach(() => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1510), person(D, 'Dee')];
  });

  it("50: Sam's own Undo (on the card) calls unmarkPaid at once, and his row has no second Undo", async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    expect(screen.getAllByLabelText('Undo your I paid')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText('Undo your I paid'));
    fireEvent.press(screen.getByLabelText('Undo your I paid')); // double tap
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B }]]);
    expect(await screen.findByText('You owe Hana')).toBeTruthy();
    expect(screen.getByText('Marked not paid').props.accessibilityLiveRegion).toBe('polite');
    // Own undo: no "was undone" notice.
    expect(screen.queryByText('Your "I paid" was undone. Check Activity to see who.')).toBeNull();
  });

  it.each([
    ['the host', A],
    ['the payer', D],
  ])("50: %s's Undo on Sam's row asks first; only confirming calls unmarkPaid", async (_who, viewerId) => {
    if (viewerId === D) db.bill.payer_id = D;
    await openSettle(viewerId);
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    expect(screen.getByText('Undo Sam\'s "I paid"?')).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Cancel: keep Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toHaveLength(0);
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toEqual([['unmark_paid', { p_bill_id: BILL, p_user_id: B }]]);
    expect(await screen.findByLabelText(/^Sam, \$[\d.]+, not paid yet$/)).toBeTruthy();
  });

  it("50: Dee (neither host nor payer) sees no Undo on Sam's row", async () => {
    await openSettle(D);
    expect(screen.getByLabelText(/^Sam, \$[\d.]+, paid$/)).toBeTruthy();
    expect(screen.queryByLabelText("Undo Sam's I paid")).toBeNull();
  });

  it('50: an undo failure shows the error under the list and re-enables Undo', async () => {
    next.unmark = { code: '42501', message: 'not_allowed' };
    await openSettle(A);
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(await screen.findByText(BILL_ERROR_COPY.not_allowed)).toBeTruthy();
    await waitFor(() => expect(disabled("Undo Sam's I paid")).toBe(false));
  });

  it('50: when someone else undoes Sam\'s mark, Sam sees the undone notice as an alert', async () => {
    await openSettle(B);
    me(B).mark = null;
    await liveChange();
    const text = await screen.findByText('Your "I paid" was undone. Check Activity to see who.');
    expect(inAlert(text)).toBe(true);
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });

  it("51: Dee's mark lands live on Hana's screen without a refresh", async () => {
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee')];
    await openSettle(A);
    expect(screen.getByLabelText(/^Dee, \$[\d.]+, not paid yet$/)).toBeTruthy();
    me(D).mark = 600;
    await liveChange();
    expect(await screen.findByLabelText(/^Dee, \$[\d.]+, paid$/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Share changed (criterion 50a)
// ---------------------------------------------------------------------------

describe('share changed since the mark (50a)', () => {
  it('higher: Sam sees the warning; Hana\'s row shows both amounts', async () => {
    // Tax 763 makes Sam's share exactly 1620 (largest remainder gives him the spare cent).
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    me(B).mark = 1510;
    const r = await openSettle(B);
    expect(screen.getByText('You paid Hana')).toBeTruthy();
    expect(screen.getAllByText('$15.10').length).toBeGreaterThan(0);
    expect(screen.getByText('Your share is now $16.20. Sort out the $1.10 with Hana.')).toBeTruthy();
    // P3: the warning is an icon beside the words, not a glyph in them.
    expect(screen.UNSAFE_queryAllByType(TriangleAlert).length).toBeGreaterThan(0);
    r.unmount();
    await openSettle(A);
    expect(screen.getByText('Marked $15.10 · share now $16.20')).toBeTruthy();
    expect(screen.getByLabelText('Sam, marked paid $15.10, share is now $16.20')).toBeTruthy();
  });

  it('lower', async () => {
    me(B).mark = 1620;
    await openSettle(B);
    expect(screen.getByText('Your share is now $15.10. Hana owes you $1.10 back.')).toBeTruthy();
  });

  it('$0.00', async () => {
    db.claims = [claim(BURGER, A), claim(SALAD, A), claim(FRIES, A)];
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText('Your share is now $0.00. Hana owes you $15.10 back.')).toBeTruthy();
  });

  it('negative', async () => {
    db.rows = [row(BURGER, 'Steak', 1000, 0), row(SALAD, 'Water', 0, 1)];
    db.claims = [claim(BURGER, A), claim(SALAD, B)];
    db.bill = { ...db.bill, total_cents: 800, tax_cents: 0, total_discount_cents: 200, extras_split: 'equal' };
    me(B).mark = 1510;
    await openSettle(B);
    expect(screen.getByText('Your share is now -$1.00. Hana owes you $16.10 back.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Accessibility (criterion 52)
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('52: every button has a label; Pay and the mark buttons have hints', async () => {
    db.bill = { ...db.bill, total_cents: 3100, tax_cents: 0 };
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', null, 600)];
    db.claims = [claim(BURGER, A), claim(SALAD, B), claim(FRIES, D)];
    await openSettle(B);
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
    const pay = screen.getByLabelText('Pay Hana $10.00 on Venmo, to @hana-1');
    expect(pay.props.accessibilityHint).toBe('Opens Venmo');
    expect(screen.getByLabelText('I already paid').props.accessibilityHint).toBe('Marks your share as paid');
    // Row labels say name, amount and status; status words are text, not colour.
    expect(screen.getByLabelText('You, $10.00, not paid yet')).toBeTruthy();
    expect(screen.getByLabelText('Dee, $6.00, paid')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    // P3: "Paid" carries a check icon; "Not yet" (muted) carries none.
    expect(screen.UNSAFE_queryAllByType(Check).length).toBeGreaterThan(0);
  });

  it('53: the worked example as Hana, payer: the amounts come from the plan', async () => {
    await openSettle(A);
    expect(screen.getByText('1 person owes you')).toBeTruthy();
    expect(screen.getAllByText('$15.10')).toHaveLength(2); // the card and Sam's row
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Review fixes R1 (a failed refetch after a write), R7 (Pay throttle), R8 (web, synchronous open)
// ---------------------------------------------------------------------------

describe('review fixes', () => {
  it('R1: the mark succeeds, then the screen\'s own refetch fails: the button is enabled again', async () => {
    await openSettle(B);
    next.failReadsAfterWrite = true;
    const before = billFetches();
    fireEvent.press(screen.getByLabelText('I already paid'));
    expect(rpcCalls('mark_paid')).toHaveLength(1);
    await waitFor(() => expect(billFetches()).toBeGreaterThan(before));
    await waitFor(() => expect(disabled('I already paid')).toBe(false));
    // Nothing optimistic: the screen still shows what the server last confirmed.
    expect(screen.queryByText('Marked paid')).toBeNull();
    expect(screen.getByText('You owe Hana')).toBeTruthy();
  });

  it('R1: an undo succeeds, then the refetch fails: Undo is enabled again', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null, 1510)];
    await openSettle(A);
    next.failReadsAfterWrite = true;
    fireEvent.press(screen.getByLabelText("Undo Sam's I paid"));
    fireEvent.press(screen.getByLabelText("Confirm: Undo Sam's I paid"));
    expect(rpcCalls('unmark_paid')).toHaveLength(1);
    await waitFor(() => expect(disabled("Undo Sam's I paid")).toBe(false));
  });

  it('R1: a payer change succeeds, then the refetch fails: the picker is released', async () => {
    db.claims = db.claims.filter((c) => c.line_item_id !== SALAD); // incomplete: no confirm
    await openSettle(A);
    next.failReadsAfterWrite = true;
    fireEvent.press(screen.getByLabelText('Change'));
    fireEvent.press(screen.getByLabelText('Sam'));
    await waitFor(() => expect(rpcCalls('set_payer')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Who paid the bill?')).toBeNull());
    expect(disabled('Change')).toBe(false);
  });

  it('R1: a newer live refetch that already shows the mark releases the button while the own refetch hangs', async () => {
    await openSettle(B);
    let release: () => void = () => {};
    // The screen's own refetch (the first read after the write) hangs.
    supabase.__setRpc(async (fn, args) => {
      if (fn === 'mark_paid') {
        me(B).mark = (args as { p_cents: number }).p_cents;
        next.holdNextRead = new Promise<void>((r) => (release = r));
      }
      return { data: null, error: null };
    });
    fireEvent.press(screen.getByLabelText('I already paid'));
    await waitFor(() => expect(next.holdNextRead).toBeNull()); // the own refetch has started and is held
    await liveChange();
    expect(await screen.findByText('You paid Hana')).toBeTruthy();
    expect(screen.getByLabelText('Undo your I paid').props.accessibilityState?.disabled).toBe(false);
    await act(async () => release());
  });

  it('R7: a second Pay tap within ~1 s is ignored; after that it opens again', async () => {
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    await screen.findByText('Did you pay Hana?');
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openLink).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText('Open Venmo again'));
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('R8: on web, Pay calls openPaymentLink before fireEvent.press returns', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    await openSettle(B);
    expect(openLink).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(openLink).toHaveBeenCalledTimes(1); // no awaited tick in between
    expect(openLink).toHaveBeenCalledWith('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    expect(await screen.findByText('Did you pay Hana?')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Venmo Request buttons for the payer (docs/specs/2026-11-25-venmo-request-buttons.md, criteria 13–20)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Request buttons on %s', (os) => {
  const REQUEST_SAM = 'Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik';
  const SAM_URL = 'https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries';
  const WEB_LINE = 'On a computer? Send requests from the Venmo app on your phone.';
  /** Every table write the fake client saw (none of the screen's reads use these methods). */
  const tableWrites = () =>
    supabase.__queries.filter((q) => q.calls.some((c) => ['insert', 'update', 'delete', 'upsert'].includes(c.method)));

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik')];
  });

  it('13: the payer sees @handle and Request; a tap opens the row\'s URL synchronously', async () => {
    await openSettle(A);
    expect(screen.getByText('@Tejesh-Bhaumik', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getAllByText('Request')).toHaveLength(1);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    // Called before any awaited tick: the browser still sees the payer's gesture.
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith(SAM_URL);
    // Criterion 7 on screen: Sam's own items only; no names, no amount.
    expectPrivateNote(openLink.mock.calls[0]?.[0]);
    await act(async () => {}); // let the open's result land
  });

  it('14: two taps within 1 s open once; a tap after 1 s opens again', async () => {
    await openSettle(A);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    expect(openLink).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    expect(openLink).toHaveBeenCalledTimes(2);
    await act(async () => {});
  });

  it('15: Venmo failing to open shows the request fallback under the list, as an alert', async () => {
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(A);
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    const banner = await screen.findByText("Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.");
    expect(inAlert(banner)).toBe(true);
    // The next successful tap clears it.
    act(() => jest.advanceTimersByTime(1000));
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    await waitFor(() => expect(screen.queryByText(/^Couldn't open Venmo\. Request/)).toBeNull());
  });

  it('16: requesting writes nothing, and the row still says "Not yet"', async () => {
    await openSettle(A);
    const rpcBefore = supabase.rpc.mock.calls.length;
    const fetchesBefore = billFetches();
    fireEvent.press(screen.getByLabelText(REQUEST_SAM));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(5000));
    expect(supabase.rpc.mock.calls.length).toBe(rpcBefore);
    expect(tableWrites()).toHaveLength(0);
    expect(billFetches()).toBe(fetchesBefore);
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    expect(screen.getByLabelText(REQUEST_SAM)).toBeTruthy();
  });

  it('17: a share change rebuilds the link; Sam marking removes Request and shows Paid', async () => {
    await openSettle(A);
    // Tax 763 makes Sam's share exactly 1620 (as in 50a).
    db.bill = { ...db.bill, total_cents: 3863, tax_cents: 763 };
    await liveChange();
    const request = await screen.findByLabelText('Request $16.20 from Sam on Venmo, @Tejesh-Bhaumik');
    fireEvent.press(request);
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink.mock.calls[0]?.[0]).toContain('amount=16.20');
    expect(openLink.mock.calls[0]?.[0]).toContain('txn=charge');

    me(B).mark = 500;
    await liveChange();
    await waitFor(() => expect(screen.queryAllByText('Request')).toHaveLength(0));
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.queryByText('@Tejesh-Bhaumik', { includeHiddenElements: true })).toBeNull();
  });

  it.each([
    ['the host who isn\'t the payer', A],
    ['the person who owes', B],
  ])('18: %s sees no Request button', async (_who, viewerId) => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik'), person(D, 'Dee', 'dee-22')];
    db.bill.payer_id = D;
    await openSettle(viewerId);
    expect(screen.getByText('Dee paid the bill')).toBeTruthy();
    expect(screen.queryAllByText('Request')).toHaveLength(0);
    expect(screen.queryByLabelText(/^Request /)).toBeNull();
    expect(screen.queryByText(WEB_LINE)).toBeNull();
    expect(screen.queryByText("Hasn't added Venmo")).toBeNull();
  });

  it('19: the button carries the row model\'s label and "Opens Venmo"; the row label is unchanged', async () => {
    await openSettle(A);
    const button = screen.getByLabelText(REQUEST_SAM);
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityHint).toBe('Opens Venmo');
    expect(screen.getByLabelText('Sam, $15.10, not paid yet')).toBeTruthy();
    for (const b of screen.getAllByRole('button')) expect(String(b.props.accessibilityLabel ?? '')).not.toBe('');
  });

  it('20: the web line shows once on web, never on native', async () => {
    await openSettle(A);
    if (os === 'web') expect(screen.getAllByText(WEB_LINE)).toHaveLength(1);
    else expect(screen.queryByText(WEB_LINE)).toBeNull();
  });

  it('Q2: an ower without Venmo gets "Hasn\'t added Venmo" and no button; the web line counts only links', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', null)];
    await openSettle(A);
    expect(screen.getByText("Hasn't added Venmo")).toBeTruthy();
    expect(screen.queryAllByText('Request')).toHaveLength(0);
    expect(screen.queryByText(WEB_LINE)).toBeNull();
  });

  it('the payer without their own Venmo still gets Request (VR-8), under the "Add your Venmo" card', async () => {
    db.people = [person(A, 'Hana', null), person(B, 'Sam', 'Tejesh-Bhaumik')];
    await openSettle(A);
    expect(screen.getByText('Add your Venmo so people can pay you')).toBeTruthy();
    expect(screen.getByLabelText(REQUEST_SAM)).toBeTruthy();
  });
});

// Review R2 (Amendment A2): an open-failed line shows only while it still describes the bill.
describe.each(['ios', 'web'] as const)('open-failed lines follow the bill on %s (review R2)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('Pay: the fallback goes away when the payer changes', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam'), person(D, 'Dee', 'dee-22')];
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(B);
    fireEvent.press(screen.getByLabelText('Pay Hana $15.10 on Venmo, to @hana-1'));
    expect(await screen.findByText("Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app.")).toBeTruthy();
    db.bill.payer_id = D;
    await liveChange();
    expect(await screen.findByText('You owe Dee')).toBeTruthy();
    expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull();
  });

  it('Request: the fallback goes away when that person\'s share changes', async () => {
    db.people = [person(A, 'Hana', 'hana-1'), person(B, 'Sam', 'Tejesh-Bhaumik')];
    openLink.mockResolvedValueOnce({ ok: false });
    await openSettle(A);
    fireEvent.press(screen.getByLabelText('Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik'));
    expect(await screen.findByText("Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.")).toBeTruthy();
    db.claims = db.claims.filter((c) => !(c.line_item_id === FRIES && c.user_id === B));
    await liveChange();
    await waitFor(() => expect(screen.queryByLabelText('Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik')).toBeNull());
    expect(screen.getAllByText('Request')).toHaveLength(1); // a request for the new amount
    expect(screen.queryByText(/^Couldn't open Venmo/)).toBeNull();
  });
});
