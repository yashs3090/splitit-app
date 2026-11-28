// The Who paid? page (app/(app)/bills/[id]/payers.tsx): criteria A-50(a)–(j) of
// docs/specs/2026-11-26-who-paid.md (Amendment A2 item 6), on iOS and on web (aria-* there).
//
// __tests__/settle.test.tsx ("changing who paid (host): the Who paid? page") already covers these on
// iOS, so they run here on web only: (a) the refusal, (b) Save disabled until it adds up, (c) the
// percent toggle saving exact cents, (f) the confirm copy. Everything else runs on both.
//
// The bill: total 31.00, no extras. Hana (A) hosts and paid the whole bill; Sam (B) had the Salad
// 10.00, Dee (D) the Fries 6.00, Hana the Burger 15.00.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { BILL_ERROR_COPY } from '@/lib/bills';
import { takeOwnPayerChange } from '@/lib/ownPayerChange';
import { PAYERS_REQUEST_TIMEOUT_MS, PERCENT_ERROR_ROUNDS_TO_ZERO } from '@/lib/payersForm';
import { PAY_REPEAT_MS } from '@/lib/useVenmoSend';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeDbError, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

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
  return { ...actual, openPaymentLink: jest.fn(async () => ({ ok: true })), openPaymentLinkWeb: jest.fn(() => ({ closed: false, opener: null })) };
});
jest.mock('@/lib/checkInNotifications', () => ({
  supported: true,
  notificationPermission: jest.fn(async () => 'denied'),
  askNotificationPermissionOnce: jest.fn(async () => 'denied'),
  ensureSentCheckCategory: jest.fn(async () => true),
  ensureAndroidChannel: jest.fn(async () => true),
  scheduleSentCheck: jest.fn(async () => true),
  cancelSentCheck: jest.fn(async () => {}),
  cancelSentChecks: jest.fn(async () => {}),
  cancelAllSentChecks: jest.fn(async () => {}),
  subscribeSentCheckResponses: jest.fn(() => () => {}),
  lastSentCheckResponse: jest.fn(() => null),
  clearLastSentCheckResponse: jest.fn(),
  useSentCheckResponses: jest.fn(),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const ROUTES = './app';
const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const D = '00000000-0000-4000-8000-00000000000d';
const BURGER = '22222222-0000-4000-8000-000000000001';
const SALAD = '22222222-0000-4000-8000-000000000002';
const FRIES = '22222222-0000-4000-8000-000000000003';
const PAGE = `/bills/${BILL}/payers`;
const SETTLE = `/bills/${BILL}/settle`;
const NEVER = new Promise<never>(() => {});
/** A request held until the test lets it go. */
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const SAVED_EARLIER = 'Your earlier save went through.';

const db: { totalCents: number; payerId: string; payers: { user_id: string; paid_cents: number }[] } = { totalCents: 3100, payerId: A, payers: [] };
const next: {
  /** Every bills read from now on waits forever (the request never answers). */
  holdReads: boolean;
  /** The total the next reads see (the host changed it on another device). */
  totalOnServer: number | null;
  /** set_payer / set_payers: 'hang' never answers; 'land-then-hang' applies the change, then never answers. */
  write: 'ok' | 'hang' | 'land-then-hang' | FakeDbError;
  /** set_payer / set_payers wait for this before doing anything (one shot; then `write` decides). */
  writeHold: Promise<void> | null;
} = { holdReads: false, totalOnServer: null, write: 'ok', writeHold: null };

let viewer = A;
function signInAs(id: string) {
  viewer = id;
  const s = fakeSession('Test User');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
}

const row = (id: string, name: string, cents: number, g: number) => ({
  id,
  name,
  note: null,
  group_position: g,
  unit_index: 0,
  group_size: 1,
  total_cents: cents,
  split_set_by: null,
  split_set_at: null,
});

function installServer() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', async () => {
    if (next.holdReads) return NEVER;
    const total = next.totalOnServer ?? db.totalCents;
    return ok({
      id: BILL,
      host_id: A,
      payer_id: db.payerId,
      subtotal_cents: null,
      tax_cents: total - 3100,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: total,
      join_code: '0123456789abcdef0123',
      group_id: null,
      created_at: '2026-11-24T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    });
  });
  supabase.__setTable('line_items', () => ok([row(BURGER, 'Burger', 1500, 0), row(SALAD, 'Salad', 1000, 1), row(FRIES, 'Fries', 600, 2)]));
  supabase.__setTable('bill_participants', () =>
    ok(
      [
        [A, 'Hana', 'hana-1'],
        [B, 'Sam', 'sam-2'],
        [D, 'Dee', 'dee-22'],
      ].map(([id, name, venmo], i) => ({ user_id: id, joined_at: `2026-11-24T19:0${i}:00Z`, profile: { display_name: name, venmo_username: venmo } })),
    ),
  );
  supabase.__setTable('claims', () =>
    ok([
      { line_item_id: BURGER, user_id: A, parts: 1 },
      { line_item_id: SALAD, user_id: B, parts: 1 },
      { line_item_id: FRIES, user_id: D, parts: 1 },
    ]),
  );
  supabase.__setTable('bill_payers', () => ok(db.payers.map((p) => ({ ...p }))));
  supabase.__setTable('bill_payments', () => ok([]));
  supabase.__setTable('bill_payment_flags', () => ok([]));
  supabase.__setTable('profiles', () => ok({ display_name: viewer === A ? 'Hana' : 'Sam', venmo_username: null }));
  supabase.__setRpc(async (fn, args) => {
    const a = args ?? {};
    if (fn === 'set_payer' || fn === 'set_payers') {
      const hold = next.writeHold;
      next.writeHold = null;
      if (hold) await hold;
      const w = next.write;
      if (w === 'hang') return NEVER;
      if (typeof w === 'object') return { data: null, error: w };
      if (fn === 'set_payer') {
        db.payerId = a.p_payer_id as string;
        db.payers = [];
      } else {
        const rows = a.p_payers as { user_id: string; paid_cents: number }[];
        db.payers = rows.map((r) => ({ ...r }));
        db.payerId = rows.slice().sort((x, y) => y.paid_cents - x.paid_cents)[0]?.user_id ?? db.payerId;
      }
      if (w === 'land-then-hang') return NEVER;
      return ok(null);
    }
    if (fn === 'venmo_prompt_pending') return ok(false);
    return ok(null);
  });
}

const rpcCalls = (fn: string) => supabase.rpc.mock.calls.filter(([name]) => name === fn);
const writes = () => supabase.rpc.mock.calls.filter(([name]) => name === 'set_payer' || name === 'set_payers');
const billReads = () => supabase.__queries.filter((q) => q.table === 'bills').length;
const field = (name: string, unit: 'dollars' | 'percent' = 'dollars') =>
  screen.getByLabelText(unit === 'dollars' ? `${name} paid, in dollars` : `${name} paid, percent of the bill`);

/**
 * The props the Pressable labelled `label` receives: on web that is what react-native-web turns
 * into DOM attributes (its Pressable writes aria-disabled from `disabled`; aria-checked passes
 * through). Under Jest, React Native folds aria-* into accessibilityState on the host node, so the
 * host can't show what the browser gets.
 */
type PressProps = { disabled?: boolean; 'aria-disabled'?: boolean; 'aria-checked'?: boolean; accessibilityState?: { disabled?: boolean } };
function pressable(label: string): PressProps {
  // The outermost composite with this label and a role: the Pressable our component rendered
  // (Button / Segment / HeaderBack pass the label without a role on their own props).
  const found = screen.UNSAFE_root.findAll((n) => {
    const p = n.props as { accessibilityLabel?: unknown; accessibilityRole?: unknown };
    return typeof n.type !== 'string' && p.accessibilityLabel === label && p.accessibilityRole !== undefined;
  });
  const first = found[0];
  if (first === undefined) throw new Error(`no Pressable labelled ${label}`);
  return first.props as PressProps;
}
/** Disabled as each platform says it: accessibilityState on native; on web, the DOM's aria-disabled. */
function isDisabled(label: string): boolean {
  if (Platform.OS !== 'web') return Boolean((screen.getByLabelText(label).props as PressProps).accessibilityState?.disabled);
  const p = pressable(label);
  return p.disabled === true || p['aria-disabled'] === true;
}
/** The header's back control: never disabled once nothing is in flight. */
const backDisabled = () => isDisabled('Back');

async function openSettle(as = A) {
  signInAs(as);
  const router = renderRouter(ROUTES, { initialUrl: SETTLE });
  await screen.findByText('Settle up');
  return router;
}
/** Settle up, then "Paid by you. Change who paid": the page as the host reaches it. */
async function openPage() {
  const router = await openSettle(A);
  fireEvent.press(screen.getByLabelText('Paid by you. Change who paid'));
  await waitFor(() => expect(router.getPathname()).toBe(PAGE));
  await screen.findByText('Bill total');
  return router;
}

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  db.totalCents = 3100;
  db.payerId = A;
  db.payers = [];
  next.holdReads = false;
  next.totalOnServer = null;
  next.write = 'ok';
  next.writeHold = null;
  installServer();
  signInAs(A);
});

afterEach(() => {
  takeOwnPayerChange(BILL); // no note outlives its test
});

// ---------------------------------------------------------------------------
// Web only: the iOS side of these is in settle.test.tsx
// ---------------------------------------------------------------------------

describe('on web (A-50 a, b, c, f; iOS in settle.test.tsx)', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));

  it('(a) someone who is not the host sees the refusal, no fields and no Save; Back works', async () => {
    const router = await openSettle(B);
    act(() => globalRouter.push(PAGE));
    expect(await screen.findByText('Only Hana can change who paid.')).toBeTruthy();
    expect(screen.queryByLabelText(/paid, in dollars$/)).toBeNull();
    expect(screen.queryByLabelText('Save')).toBeNull();
    expect(screen.getAllByLabelText('Back')).toHaveLength(1); // the header's, the one way out
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(writes()).toHaveLength(0);
  });

  it('(b) Save is aria-disabled until the amounts add up exactly and something changed', async () => {
    await openPage();
    expect(isDisabled('Save')).toBe(true); // the stored split: nothing changed
    fireEvent.changeText(field('You'), '20');
    expect(screen.getByText('$11.00 left to assign')).toBeTruthy();
    expect(isDisabled('Save')).toBe(true);
    fireEvent.changeText(field('Sam'), '11.01');
    expect(isDisabled('Save')).toBe(true); // over by 1 cent: tolerance 0
    fireEvent.changeText(field('Sam'), '11');
    expect(isDisabled('Save')).toBe(false); // positive control
    expect(pressable('Save')['aria-disabled']).toBeUndefined();
  });

  it('(c) the % switch is a radio group with aria-checked, and 33.33/33.33/33.34 saves exact cents', async () => {
    await openPage();
    expect(pressable('Percentages of the bill')['aria-checked']).toBe(false);
    expect(pressable('Amounts in dollars')['aria-checked']).toBe(true);
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    expect(pressable('Percentages of the bill')['aria-checked']).toBe(true);
    expect(pressable('Amounts in dollars')['aria-checked']).toBe(false);
    fireEvent.changeText(field('You', 'percent'), '33.33');
    fireEvent.changeText(field('Sam', 'percent'), '33.33');
    fireEvent.changeText(field('Dee', 'percent'), '33.34');
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    const sent = (rpcCalls('set_payers')[0]?.[1] as { p_payers: { paid_cents: number }[] }).p_payers;
    expect(sent.map((p) => p.paid_cents)).toEqual([1033, 1033, 1034]);
  });

  it("(f) the one-person confirm uses contract M's copy", async () => {
    await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText('Switch to Dee? People may already be paying you.')).toBeTruthy();
    expect(screen.getByLabelText('Switch to Dee')).toBeTruthy();
    expect(screen.getByLabelText('Cancel: keep you as the payer')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Both platforms
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('(c) switching $ → % → $ keeps the typed values', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    expect(field('You', 'percent').props.value).toBe('64.52');
    expect(field('Sam', 'percent').props.value).toBe('35.48');
    expect(screen.getByText('Adds up to 100% · $31.00')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Amounts in dollars'));
    expect(field('You').props.value).toBe('20.00');
    expect(field('Sam').props.value).toBe('11.00');
  });

  it('(c, QA) a $10,000.00 bill: $ → % → $ → % keeps the typed cents, and the save sends 333333 / 666667', async () => {
    db.totalCents = 1_000_000;
    const router = await openPage();
    fireEvent.changeText(field('You'), '3333.33');
    fireEvent.changeText(field('Sam'), '6666.67');
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    expect(field('You', 'percent').props.value).toBe('33.33'); // display only
    expect(field('Sam', 'percent').props.value).toBe('66.67');
    expect(screen.getByText('Adds up to 100% · $10,000.00')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Amounts in dollars'));
    expect(field('You').props.value).toBe('3333.33');
    expect(field('Sam').props.value).toBe('6666.67');
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    expect(isDisabled('Save')).toBe(false);
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    expect(rpcCalls('set_payers')[0]?.[1]).toEqual({
      p_bill_id: BILL,
      p_payers: [
        { user_id: A, paid_cents: 333_333 },
        { user_id: B, paid_cents: 666_667 },
      ],
    });
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
  });

  it('(c, QA) editing one row in % mode changes only that row', async () => {
    db.totalCents = 1_000_000;
    await openPage();
    fireEvent.changeText(field('You'), '3333.33');
    fireEvent.changeText(field('Sam'), '6666.67');
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    fireEvent.changeText(field('You', 'percent'), '20');
    expect(screen.getByText('$1,333.33 left to assign')).toBeTruthy();
    expect(isDisabled('Save')).toBe(true);
    fireEvent.press(screen.getByLabelText('Amounts in dollars'));
    expect(field('You').props.value).toBe('2000.00');
    expect(field('Sam').props.value).toBe('6666.67');
  });

  it('(d) a percentage that rounds to $0.00 is refused on its row, and Save stays disabled', async () => {
    await openPage();
    fireEvent.press(screen.getByLabelText('Percentages of the bill'));
    fireEvent.changeText(field('You', 'percent'), '99.99');
    fireEvent.changeText(field('Sam', 'percent'), '0.01');
    const err = screen.getByText(PERCENT_ERROR_ROUNDS_TO_ZERO);
    expect(err.props.accessibilityRole).toBe('alert');
    expect(screen.getByText('Fix the percentage marked above')).toBeTruthy();
    expect(isDisabled('Save')).toBe(true);
    expect(screen.getByLabelText('Save').props.accessibilityHint).toBe('Fix the percentage marked above');
    fireEvent.press(screen.getByLabelText('Save'));
    expect(writes()).toHaveLength(0);
    // Positive control: a share that rounds to a cent is fine.
    fireEvent.changeText(field('You', 'percent'), '99.96');
    fireEvent.changeText(field('Sam', 'percent'), '0.04');
    expect(screen.queryByText(PERCENT_ERROR_ROUNDS_TO_ZERO)).toBeNull();
    expect(isDisabled('Save')).toBe(false);
  });

  it('(e) the total changed since the page opened: the save stops with a message, no write', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    next.totalOnServer = 3400; // the host raised the tip on another device
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText('The bill total changed to $34.00. Check the amounts and save again.')).toBeTruthy();
    expect(writes()).toHaveLength(0);
    expect(router.getPathname()).toBe(PAGE);
    expect(backDisabled()).toBe(false);
  });

  it('(g) a double tap on Save sends one re-read and one call, and goes back once', async () => {
    const back = jest.spyOn(globalRouter, 'back');
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    const readsBefore = billReads();
    const save = screen.getByLabelText('Save');
    act(() => {
      fireEvent.press(save);
      fireEvent.press(save);
    });
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('set_payers')).toHaveLength(1);
    expect(billReads() - readsBefore).toBeGreaterThanOrEqual(1);
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('(g) a double tap on the confirm sends one call and goes back once', async () => {
    const back = jest.spyOn(globalRouter, 'back');
    const router = await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    const confirm = await screen.findByLabelText('Switch to Dee');
    act(() => {
      fireEvent.press(confirm);
      fireEvent.press(confirm);
    });
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('set_payer')).toEqual([['set_payer', { p_bill_id: BILL, p_payer_id: D }]]);
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('(h) the re-read before saving never answers: after 15 s a network error, Save and Back work again', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    next.holdReads = true;
    fireEvent.press(screen.getByLabelText('Save'));
    expect(backDisabled()).toBe(true); // while saving
    act(() => jest.advanceTimersByTime(PAYERS_REQUEST_TIMEOUT_MS - 1));
    expect(screen.queryByText(BILL_ERROR_COPY.network)).toBeNull();
    await act(async () => jest.advanceTimersByTime(1));
    expect(await screen.findByText(BILL_ERROR_COPY.network)).toBeTruthy();
    expect(writes()).toHaveLength(0);
    expect(isDisabled('Save')).toBe(false);
    expect(field('You').props.value).toBe('20'); // what was typed is kept
    expect(backDisabled()).toBe(false);
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
  });

  it("(h) set_payers never answers and didn't land: after 15 s a network error; the note is kept (it may still commit)", async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    next.write = 'hang';
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    const readsBefore = billReads();
    await act(async () => jest.advanceTimersByTime(PAYERS_REQUEST_TIMEOUT_MS));
    expect(await screen.findByText(BILL_ERROR_COPY.network)).toBeTruthy();
    await waitFor(() => expect(billReads()).toBeGreaterThan(readsBefore)); // the refetch that decides
    await act(async () => {});
    expect(router.getPathname()).toBe(PAGE);
    expect(isDisabled('Save')).toBe(false);
    expect(backDisabled()).toBe(false);
    // Round 2 R1: a timed-out write can still commit, so a "didn't land" refetch doesn't forget the
    // note; OWN_PAYER_CHANGE_MAX_MS bounds it.
    expect(takeOwnPayerChange(BILL)).toBe(true);
  });

  it('(h, round 2 R1) set_payer times out, the refetch shows the old payer, then it commits: no "now collecting", the page says it saved', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    const write = deferred();
    next.writeHold = write.promise;
    fireEvent.press(await screen.findByLabelText('Switch to Dee'));
    await waitFor(() => expect(rpcCalls('set_payer')).toHaveLength(1));
    const readsBefore = billReads();
    await act(async () => jest.advanceTimersByTime(PAYERS_REQUEST_TIMEOUT_MS));
    expect(await screen.findByText(BILL_ERROR_COPY.network)).toBeTruthy();
    await waitFor(() => expect(billReads()).toBeGreaterThan(readsBefore)); // the refetch: still Hana
    await act(async () => {});
    expect(router.getPathname()).toBe(PAGE);
    expect(db.payerId).toBe(A);
    // The write commits late and answers ok.
    await act(async () => write.resolve());
    expect(db.payerId).toBe(D);
    expect(await screen.findByText(SAVED_EARLIER)).toBeTruthy();
    expect(screen.queryByText(BILL_ERROR_COPY.network)).toBeNull();
    expect(router.getPathname()).toBe(PAGE); // it says so here; it doesn't navigate on its own
    await waitFor(() => expect(isDisabled('Save')).toBe(true)); // the draft is what's stored now
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(await screen.findByLabelText('Paid by Dee. Change who paid')).toBeTruthy();
    expect(screen.queryByText(/is now collecting/)).toBeNull();
  });

  it('(h, round 2 R1) a timed-out write that is refused late forgets the note', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    const write = deferred();
    next.writeHold = write.promise;
    next.write = { code: '42501', message: 'permission denied' };
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    await act(async () => jest.advanceTimersByTime(PAYERS_REQUEST_TIMEOUT_MS));
    expect(await screen.findByText(BILL_ERROR_COPY.network)).toBeTruthy();
    await act(async () => write.resolve());
    expect(screen.queryByText(SAVED_EARLIER)).toBeNull();
    expect(takeOwnPayerChange(BILL)).toBe(false);
  });

  it('(round 2 R4) a saved change that keeps the same lead forgets the note (Settle only takes it when the lead changes)', async () => {
    db.payers = [
      { user_id: A, paid_cents: 2000 },
      { user_id: B, paid_cents: 1100 },
    ];
    const router = await openSettle(A);
    fireEvent.press(screen.getByLabelText('Paid by you $20.00 and Sam $11.00. Change who paid'));
    await waitFor(() => expect(router.getPathname()).toBe(PAGE));
    await screen.findByText('Bill total');
    fireEvent.changeText(field('You'), '31');
    fireEvent.changeText(field('Sam'), '');
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(rpcCalls('set_payer')).toEqual([['set_payer', { p_bill_id: BILL, p_payer_id: A }]]);
    expect(takeOwnPayerChange(BILL)).toBe(false);
  });

  it('(round 2 R4) a refusal that lands after the page closed still forgets the note', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    const write = deferred();
    next.writeHold = write.promise;
    next.write = { code: '42501', message: 'permission denied' };
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(1));
    act(() => globalRouter.back()); // the page closes (a back gesture) while the write is out
    await waitFor(() => expect(screen.queryByText('Bill total')).toBeNull());
    await act(async () => write.resolve());
    expect(takeOwnPayerChange(BILL)).toBe(false);
  });

  it('(h) set_payer landed but its answer never came: the refetch decides, the page goes back, no "now collecting" notice', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '');
    fireEvent.changeText(field('Dee'), '31');
    fireEvent.press(screen.getByLabelText('Save'));
    next.write = 'land-then-hang';
    fireEvent.press(await screen.findByLabelText('Switch to Dee'));
    await waitFor(() => expect(rpcCalls('set_payer')).toHaveLength(1));
    await act(async () => jest.advanceTimersByTime(PAYERS_REQUEST_TIMEOUT_MS));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE));
    expect(await screen.findByLabelText('Paid by Dee. Change who paid')).toBeTruthy();
    expect(screen.queryByText(/is now collecting/)).toBeNull(); // the kept note told Settle it was ours
  });

  it('(h) a refused save keeps what was typed, re-enables Save and Back, and forgets the note', async () => {
    await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    next.write = { code: '42501', message: 'permission denied' };
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText(BILL_ERROR_COPY.not_allowed)).toBeTruthy();
    expect(field('You').props.value).toBe('20');
    expect(isDisabled('Save')).toBe(false);
    expect(backDisabled()).toBe(false);
    expect(takeOwnPayerChange(BILL)).toBe(false);
  });

  it('(busy, delete-group A3.4) a 40P01 abort shows the retry copy, keeps what was typed, re-enables Save and Back, and forgets the note', async () => {
    const router = await openPage();
    fireEvent.changeText(field('You'), '20');
    fireEvent.changeText(field('Sam'), '11');
    next.write = { code: '40P01', message: 'deadlock detected' };
    fireEvent.press(screen.getByLabelText('Save'));
    expect(await screen.findByText("That didn't go through. Please try again.")).toBeTruthy();
    expect(screen.queryByText(BILL_ERROR_COPY.network)).toBeNull();
    expect(screen.queryByText(/deadlock/)).toBeNull();
    expect(router.getPathname()).toBe(PAGE);
    expect(field('You').props.value).toBe('20');
    expect(isDisabled('Save')).toBe(false);
    expect(backDisabled()).toBe(false);
    // A definite failure, not an unknown outcome: the own-change note is forgotten.
    expect(takeOwnPayerChange(BILL)).toBe(false);
    // Retry: the second tap sends again and saves.
    next.write = 'ok';
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(rpcCalls('set_payers')).toHaveLength(2));
  });

  it('(i) the back control reads "Back" (a11y "Back") on the form, while loading and on the refusal', async () => {
    next.holdReads = true;
    signInAs(A);
    renderRouter(ROUTES, { initialUrl: PAGE });
    const loadingBack = await screen.findByLabelText('Back');
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.queryByLabelText('Back to Settle up')).toBeNull();
    expect(loadingBack).toBeTruthy();
    expect(backDisabled()).toBe(false);
    screen.unmount();
    next.holdReads = false;
    await openPage();
    expect(screen.getByLabelText('Back')).toBeTruthy();
    expect(screen.queryByText('Settle up', { exact: true })).toBeNull();
  });

  it('(i) opened from the bill screen, Back returns to the bill', async () => {
    signInAs(A);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    fireEvent.press(await screen.findByLabelText('Paid by you. Change who paid'));
    await waitFor(() => expect(router.getPathname()).toBe(PAGE));
    await screen.findByText('Bill total');
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
  });

  it('(j) a double tap on "Change who paid" on Settle up pushes the page once', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    const router = await openSettle(A);
    const line = screen.getByLabelText('Paid by you. Change who paid');
    act(() => {
      fireEvent.press(line);
      fireEvent.press(line);
    });
    await waitFor(() => expect(router.getPathname()).toBe(PAGE));
    expect(push.mock.calls.filter(([to]) => to === PAGE)).toHaveLength(1);
    await screen.findByText('Bill total');
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(SETTLE)); // one back is enough: one page
    // After the window, the line opens the page again (the guard doesn't stick).
    act(() => jest.advanceTimersByTime(PAY_REPEAT_MS));
    fireEvent.press(screen.getByLabelText('Paid by you. Change who paid'));
    await waitFor(() => expect(router.getPathname()).toBe(PAGE));
    push.mockRestore();
  });

  it('(j) a double tap on "Paid by" on the bill screen pushes the page once', async () => {
    const push = jest.spyOn(globalRouter, 'push');
    signInAs(A);
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    const line = await screen.findByLabelText('Paid by you. Change who paid');
    act(() => {
      fireEvent.press(line);
      fireEvent.press(line);
    });
    await waitFor(() => expect(router.getPathname()).toBe(PAGE));
    expect(push.mock.calls.filter(([to]) => to === PAGE)).toHaveLength(1);
    await screen.findByText('Bill total');
    fireEvent.press(screen.getByLabelText('Back'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    push.mockRestore();
  });
});
