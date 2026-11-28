// The group Settle screen, Who paid what and Record a payment: spec docs/specs/2026-11-26-groups-mvp.md
// T16 as amended by A2 (criteria 75–77, 110, 119–124). The data layer (lib/groups.ts) is mocked at
// its exported functions over a small in-memory server, so a write shows up in the next snapshot
// read; its parser and error mapping are covered by lib/groups.test.ts. Venmo opening is mocked at
// lib/paylinks.ts. Router tests on iOS and with Platform.OS = 'web' (desktop and phone browsers).
//
// The worked example W1 (test-utils/groupFixtures.ts): Cy owes Dee $174.97, Ben owes Ana $130.02 and
// Dee $6.67. Venmo usernames ana-1, ben-1, cy-1, dee-1.
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { AppState, Platform, Text, type AppStateStatus } from 'react-native';

import type { GroupError, GroupResult, GroupSnapshot, SnapshotNotReceived, SnapshotPayment } from '@/lib/groups';
import * as groups from '@/lib/groups';
import { openPaymentLink, openPaymentLinkWeb, WEB_OPEN_CHECK_MS } from '@/lib/paylinks';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';
import { ANA, BEN, CY, DEE, W1, W7 } from '@/test-utils/groupFixtures';
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
  return { ...actual, fetchGroupSnapshot: jest.fn(), recordPayment: jest.fn(), undoPayment: jest.fn() };
});
jest.mock('@/lib/paylinks', () => {
  const actual = jest.requireActual<typeof import('@/lib/paylinks')>('@/lib/paylinks');
  return { ...actual, openPaymentLink: jest.fn(async () => ({ ok: true })), openPaymentLinkWeb: jest.fn(() => ({ closed: false, opener: null })) };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
const record = groups.recordPayment as jest.MockedFunction<typeof groups.recordPayment>;
const undo = groups.undoPayment as jest.MockedFunction<typeof groups.undoPayment>;
const openLink = openPaymentLink as jest.MockedFunction<typeof openPaymentLink>;
const openWeb = openPaymentLinkWeb as unknown as jest.Mock;

const PAY_DEE = 'Pay Dee $174.97 on Venmo';
const DEE_URL = 'https://venmo.com/?txn=pay&recipients=dee-1&amount=174.97&note=SplitIt%3A%20Tahoe%20trip';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPEN_FAILED = "Couldn't open Venmo. Send $174.97 to @dee-1 in the Venmo app, then tap Paid another way.";
const CHECK = 'Did your $174.97 to Dee go through?';
const pid = (n: number) => `9d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ----- the in-memory server -----

type Server = {
  base: GroupSnapshot;
  payments: SnapshotPayment[];
  notReceived: SnapshotNotReceived[];
  viewer: string;
  recordError: GroupError | null;
  undoError: GroupError | null;
  /** Holds record_payment until released. */
  recordHold: Promise<void> | null;
  /** Every snapshot read fails (network) while set. */
  failReads: boolean;
};
const server: Server = { base: snapshotOf(W1.input), payments: [], notReceived: [], viewer: CY, recordError: null, undoError: null, recordHold: null, failReads: false };

function current(): GroupSnapshot {
  return { ...server.base, payments: [...server.base.payments, ...server.payments], notReceived: [...server.notReceived] };
}

function installServer() {
  fetchSnapshot.mockImplementation(async () => (server.failReads ? { ok: false, error: 'network' } : { ok: true, snapshot: current() }));
  record.mockImplementation(async (a) => {
    if (server.recordHold) await server.recordHold;
    if (server.recordError) return { ok: false, error: server.recordError };
    if (!server.payments.some((p) => p.id === a.id)) {
      server.payments.push({
        id: a.id,
        from: a.from,
        to: a.to,
        cents: a.cents,
        method: a.method,
        source: a.source,
        recordedBy: server.viewer,
        billId: null,
        createdAt: new Date().toISOString(),
      });
    }
    return { ok: true } as GroupResult;
  });
  undo.mockImplementation(async (id) => {
    if (server.undoError) return { ok: false, error: server.undoError };
    const p = server.payments.find((x) => x.id === id);
    server.payments = server.payments.filter((x) => x.id !== id);
    if (p && p.to === server.viewer) {
      server.notReceived.push({ id: p.id, from: p.from, to: p.to, cents: p.cents, method: p.method, undoneAt: new Date().toISOString() });
    }
    return { ok: true } as GroupResult;
  });
}

function signInAs(userId: string) {
  server.viewer = userId;
  const session = fakeSession('Someone');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

function seedPayment(p: Partial<SnapshotPayment> & Pick<SnapshotPayment, 'id' | 'from' | 'to' | 'cents'>) {
  server.payments.push({ method: 'venmo', source: 'venmo_link', recordedBy: p.from, billId: null, createdAt: new Date().toISOString(), ...p });
}

function GroupStandIn() {
  return <Text>Group stand-in</Text>;
}
const ROUTES = { appDir: './app', overrides: { '(app)/groups/[id]/index': GroupStandIn } };

async function openSettle(path = `/groups/${GROUP_ID}/settle`) {
  const router = renderRouter(ROUTES, { initialUrl: path });
  await screen.findByRole('header', { name: 'Settle up' });
  await screen.findByText('Suggested payments');
  return router;
}

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const reads = () => fetchSnapshot.mock.calls.length;
/** Lets the 1 s double-tap guard pass between two separate taps. */
const later = () => act(() => jest.advanceTimersByTime(1100));

/** AppState as the screen sees it: returns the transitions to send. */
function captureAppState() {
  const handlers: ((s: AppStateStatus) => void)[] = [];
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    handlers.push(handler as (s: AppStateStatus) => void);
    return { remove: () => {} };
  });
  const send = async (s: AppStateStatus) => {
    await act(async () => handlers.forEach((h) => h(s)));
  };
  return { send, restore: () => spy.mockRestore() };
}

const g = globalThis as { navigator?: unknown };
const originalNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
function setBrowser(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(g, 'navigator', { configurable: true, value: { userAgent, maxTouchPoints } });
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  server.base = snapshotOf(W1.input);
  server.payments = [];
  server.notReceived = [];
  server.recordError = null;
  server.undoError = null;
  server.recordHold = null;
  server.failReads = false;
  signInAs(CY);
  installServer();
  openLink.mockResolvedValue({ ok: true });
  openWeb.mockReturnValue({ closed: false, opener: null });
  jest.replaceProperty(Platform, 'OS', 'ios');
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalNavigator) Object.defineProperty(g, 'navigator', originalNavigator);
  else delete g.navigator;
});

// ---------------------------------------------------------------------------
// Entry routes and what the screen shows
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('entry (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    if (os === 'web') setBrowser(MAC);
  });

  it('a cold deep link shows the viewer’s card first, then the suggestions, Who paid what and Record a payment', async () => {
    await openSettle();
    expect(fetchSnapshot).toHaveBeenCalledWith(GROUP_ID);
    expect(screen.getAllByRole('header', { name: 'Settle up' })).toHaveLength(1);
    expect(screen.getByText('You owe $174.97')).toBeTruthy();
    expect(screen.getByLabelText('You owe Dee $174.97')).toBeTruthy();
    expect(button(PAY_DEE)).toBeTruthy();
    expect(screen.getByText('@dee-1 · $174.97')).toBeTruthy();
    // Everyone's suggested payments, in plain words (no arrow glyphs).
    expect(screen.getByText('You pay Dee $174.97')).toBeTruthy();
    expect(screen.getByText('Ben pays Ana $130.02')).toBeTruthy();
    expect(screen.getByText('Ben pays Dee $6.67')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Who paid what' })).toBeTruthy();
    expect(button('Record a payment')).toBeTruthy();
    // Desktop web explains where to send from; native doesn't.
    if (os === 'web') expect(screen.getByText('On a computer? Send it from the Venmo app on your phone.')).toBeTruthy();
    else expect(screen.queryByText('On a computer? Send it from the Venmo app on your phone.')).toBeNull();
    // 124: no "I paid" button anywhere (positive control: the card rendered above).
    expect(screen.queryByRole('button', { name: 'I paid' })).toBeNull();
    expect(screen.queryByText('I paid')).toBeNull();
    // Nothing is waiting in W1: no notice.
    expect(screen.queryByText(/Balances don't include/)).toBeNull();
  });

  it('every control has a role and a name, and the chooser says what it is', async () => {
    await openSettle();
    const controls = screen.UNSAFE_root.findAll(
      (n) => typeof n.type === 'string' && ['button', 'link', 'radio'].includes(n.props.accessibilityRole as string),
    );
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) {
      const label = c.props.accessibilityLabel;
      expect(typeof label === 'string' ? label.trim().length > 0 : within(c).queryAllByText(/\S/).length > 0).toBe(true);
    }
    expect(screen.getByRole('radio', { name: "Venmo, how you're paying" })).toBeTruthy();
    expect(screen.getByRole('radio', { name: "Cash, how you're paying" })).toBeTruthy();
  });

  it('not a member: fixed copy and Go home; nothing from the URL is shown', async () => {
    fetchSnapshot.mockResolvedValue({ ok: false, error: 'not_allowed' });
    renderRouter(ROUTES, { initialUrl: '/groups/%3Cscript%3E/settle' });
    expect(await screen.findByText("You're not in this group. Ask someone in it for the group's link.")).toBeTruthy();
    expect(button('Go home')).toBeTruthy();
    expect(screen.queryByText(/script/)).toBeNull();
  });

  it('a failed first load shows Try again, which loads it', async () => {
    server.failReads = true;
    renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/settle` });
    expect(await screen.findByText("Couldn't load the group.")).toBeTruthy();
    server.failReads = false;
    await press(button('Try again'));
    expect(await screen.findByText('Suggested payments')).toBeTruthy();
  });

  it('Back goes to the group from a cold deep link', async () => {
    const router = await openSettle();
    await press(button('Back to the group'));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}`));
    expect(await screen.findByText('Group stand-in')).toBeTruthy();
  });

  it('110 (S1): with a waiting receipt the notice sits above the pay button (W7, Ana)', async () => {
    server.base = snapshotOf(W7.input);
    signInAs(ANA);
    await openSettle();
    const notice = screen.getByText("Balances don't include your receipt yet: Nachos left to claim");
    const pay = button('Pay Ben $27.49 on Venmo');
    const json = JSON.stringify(screen.toJSON());
    expect(json.indexOf("Balances don't include your receipt yet")).toBeLessThan(json.indexOf('Pay Ben $27.49 on Venmo'));
    expect(notice && pay).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Native send (criteria 119, 121, 122)
// ---------------------------------------------------------------------------

describe('native send', () => {
  it('119: records before opening, then reads Sent via Venmo with Undo; the check asks on return (121)', async () => {
    const app = captureAppState();
    await openSettle();
    await press(button(PAY_DEE));
    await waitFor(() => expect(openLink).toHaveBeenCalledWith(DEE_URL));
    expect(record).toHaveBeenCalledTimes(1);
    const args = record.mock.calls[0]?.[0];
    expect(args).toEqual({ id: expect.stringMatching(UUID), groupId: GROUP_ID, from: CY, to: DEE, cents: 17497, method: 'venmo', source: 'venmo_link' });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(openLink.mock.invocationCallOrder[0] ?? 0);
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    expect(screen.getByText('Sent via Venmo')).toBeTruthy();
    expect(button("Didn't go through? Undo")).toBeTruthy();
    expect(screen.queryByText(CHECK)).toBeNull();
    expect(screen.getByText("You're settled up")).toBeTruthy();
    // Back from Venmo: the inline check asks once.
    await app.send('background');
    await app.send('active');
    expect(await screen.findByText(CHECK)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Didn't go through? Undo" })).toBeNull();
    // No, undo: the payment goes and the suggestion comes back after the refetch.
    await press(screen.getByRole('button', { name: "No, undo. It didn't go through" }));
    expect(undo).toHaveBeenCalledWith(args?.id);
    expect(await screen.findByRole('button', { name: PAY_DEE })).toBeTruthy();
    expect(server.payments).toHaveLength(0);
    app.restore();
  });

  it('121: Yes to the check keeps the card and never asks again', async () => {
    const app = captureAppState();
    await openSettle();
    await press(button(PAY_DEE));
    await screen.findByText('You sent Dee');
    await app.send('background');
    await app.send('active');
    await press(await screen.findByRole('button', { name: 'Yes, it went through' }));
    expect(screen.queryByText(CHECK)).toBeNull();
    expect(screen.getByText('You sent Dee')).toBeTruthy();
    expect(storage.data.get(`splitit.sentcheck.v1.${CY}`)).toContain('"a":"yes"');
    app.restore();
  });

  it('a refusal opens nothing, says why, and Pay works again', async () => {
    server.recordError = 'not_member';
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText(groups.GROUP_ERROR_COPY.not_member)).toBeTruthy();
    expect(openLink).not.toHaveBeenCalled();
    await waitFor(() => expect(button(PAY_DEE).props.accessibilityState?.disabled).toBe(false));
  });

  it('119: a record slower than 4 s opens Venmo anyway and asks; Yes reuses the same id (one row)', async () => {
    let release: () => void = () => {};
    server.recordHold = new Promise<void>((r) => (release = r));
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    await act(async () => {});
    expect(openLink).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(4000));
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Did you send Dee $174.97?')).toBeTruthy();
    server.recordHold = null;
    await press(button('Yes, I sent it'));
    await act(async () => release());
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]?.[0].id).toBe(record.mock.calls[0]?.[0].id);
    expect(server.payments).toHaveLength(1);
    // A Yes is an answer: the inline check never asks about it.
    expect(screen.queryByText(CHECK)).toBeNull();
  });

  it('Not now records nothing and takes the question away', async () => {
    server.recordError = 'network';
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText('Did you send Dee $174.97?')).toBeTruthy();
    expect(openLink).toHaveBeenCalledTimes(1);
    await press(button('Not now'));
    expect(screen.queryByText('Did you send Dee $174.97?')).toBeNull();
    expect(button(PAY_DEE)).toBeTruthy();
    expect(server.payments).toHaveLength(0);
  });

  it('122: Venmo fails to open after the record → undo runs and "Couldn’t open Venmo…" shows; no payment remains', async () => {
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(undo).toHaveBeenCalledWith(record.mock.calls[0]?.[0].id);
    expect(server.payments).toHaveLength(0);
    expect(button(PAY_DEE)).toBeTruthy();
  });

  it('R3: the record times out, then Venmo fails to open: no undo (and no "Couldn’t undo…") until the late record lands, then it is undone', async () => {
    let release: () => void = () => {};
    server.recordHold = new Promise<void>((r) => (release = r));
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(4000));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    // Nothing to undo yet: the record hasn't landed.
    expect(undo).not.toHaveBeenCalled();
    expect(screen.queryByText("Couldn't undo. Try again.")).toBeNull();
    const id = record.mock.calls[0]?.[0].id;
    await act(async () => release());
    await waitFor(() => expect(undo).toHaveBeenCalledWith(id));
    await waitFor(() => expect(server.payments).toHaveLength(0));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Couldn't undo. Try again.")).toBeNull();
    await waitFor(() => expect(button(PAY_DEE).props.accessibilityState?.disabled).toBe(false));
  });

  it('R3: when that late undo fails, it says so and the payment shows with its Undo', async () => {
    let release: () => void = () => {};
    server.recordHold = new Promise<void>((r) => (release = r));
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(4000));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    server.undoError = 'network';
    await act(async () => release());
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    expect(server.payments).toHaveLength(1);
    // The payment shows with a way to undo it (the inline check's No, undo).
    expect(await screen.findByRole('button', { name: "No, undo. It didn't go through" })).toBeTruthy();
  });

  it('R2-N2: the late record answers network but did land → after the refetch shows it, it is undone', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    record.mockImplementationOnce(async (a) => {
      await hold;
      // Landed on the server, but the answer was lost (or the 15 s limit passed): reads as network.
      server.payments.push({ id: a.id, from: a.from, to: a.to, cents: a.cents, method: a.method, source: a.source, recordedBy: server.viewer, billId: null, createdAt: new Date().toISOString() });
      return { ok: false, error: 'network' };
    });
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(4000));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(undo).not.toHaveBeenCalled();
    const id = record.mock.calls[0]?.[0].id;
    await act(async () => release());
    await waitFor(() => expect(undo).toHaveBeenCalledWith(id));
    await waitFor(() => expect(server.payments).toHaveLength(0));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: PAY_DEE })).toBeTruthy();
    expect(screen.queryByText("Couldn't undo. Try again.")).toBeNull();
  });

  it('R2-N2: the late record answers network and did not land → nothing to undo, no error', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    record.mockImplementationOnce(async () => {
      await hold;
      return { ok: false, error: 'network' };
    });
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    await act(async () => {});
    act(() => jest.advanceTimersByTime(4000));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    const readsBefore = reads();
    await act(async () => release());
    // The refetch after the lost answer ran (positive control), and found no payment.
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(button(PAY_DEE).props.accessibilityState?.disabled).toBe(false));
    expect(undo).not.toHaveBeenCalled();
    expect(screen.queryByText("Couldn't undo. Try again.")).toBeNull();
  });

  it('the open-failed line goes once the amount it names changes (keyed on person and amount)', async () => {
    const app = captureAppState();
    openLink.mockResolvedValue({ ok: false });
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    // A refetch where only something else changed keeps it.
    await app.send('background');
    await app.send('active');
    expect(screen.getByText(OPEN_FAILED)).toBeTruthy();
    // Cy pays Dee $100 another way meanwhile: the suggestion is now $74.97, so the line no longer fits.
    seedPayment({ id: pid(9), from: CY, to: DEE, cents: 10000, method: 'cash', source: 'manual' });
    await app.send('background');
    await app.send('active');
    expect(await screen.findByRole('button', { name: 'Pay Dee $74.97 on Venmo' })).toBeTruthy();
    expect(screen.queryByText(/Couldn't open Venmo/)).toBeNull();
    app.restore();
  });

  it('signing out leaves the screen and takes the just-sent card with it', async () => {
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    await act(async () => {
      await supabase.auth.signOut();
    });
    await waitFor(() => expect(screen.queryByText('You sent Dee')).toBeNull());
    expect(screen.queryByRole('header', { name: 'Settle up' })).toBeNull();
  });

  it('a double tap sends one record and opens Venmo once (1 s guard)', async () => {
    await openSettle();
    await act(async () => {
      fireEvent.press(button(PAY_DEE));
      fireEvent.press(button(PAY_DEE));
    });
    await screen.findByText('You sent Dee');
    expect(record).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledTimes(1);
  });

  it('a failed refetch after the send says so, re-enables the screen, and Try again reloads', async () => {
    await openSettle();
    server.failReads = true;
    await press(button(PAY_DEE));
    expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
    // The old data is still on screen and its controls work.
    expect(button(PAY_DEE).props.accessibilityState?.disabled).toBe(false);
    server.failReads = false;
    await press(button('Try again'));
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    expect(screen.queryByText("Couldn't refresh. Try again.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cash, Paid another way, Got paid, Not received (A2.2; criteria 75, 123)
// ---------------------------------------------------------------------------

describe('other ways to pay', () => {
  it('Cash in the chooser records method cash, shows "You paid Dee · Paid in cash" with Undo, and is remembered', async () => {
    await openSettle();
    await press(screen.getByRole('radio', { name: "Cash, how you're paying" }));
    await press(button('I paid Dee $174.97 in cash'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ from: CY, to: DEE, cents: 17497, method: 'cash', source: 'manual' }));
    expect(await screen.findByText('You paid Dee')).toBeTruthy();
    expect(screen.getByText('Paid in cash')).toBeTruthy();
    expect(storage.data.get(`splitit.payMethod.v1.${CY}`)).toBe('cash');
    expect(openLink).not.toHaveBeenCalled();
    await press(button('Undo this payment'));
    expect(await screen.findByRole('button', { name: 'I paid Dee $174.97 in cash' })).toBeTruthy();
    expect(server.payments).toHaveLength(0);
  });

  it('Paid another way records method other, source manual', async () => {
    await openSettle();
    await press(button('Paid another way'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ from: CY, to: DEE, cents: 17497, method: 'other', source: 'manual' }));
    expect(await screen.findByText('Marked paid')).toBeTruthy();
  });

  it('a failed cash record keeps the card, says why, and a retry reuses the same id', async () => {
    server.recordError = 'network';
    await openSettle();
    await press(screen.getByRole('radio', { name: "Cash, how you're paying" }));
    await press(button('I paid Dee $174.97 in cash'));
    expect(await screen.findByText(groups.GROUP_ERROR_COPY.network)).toBeTruthy();
    server.recordError = null;
    await press(button('I paid Dee $174.97 in cash'));
    expect(await screen.findByText('You paid Dee')).toBeTruthy();
    expect(record.mock.calls[1]?.[0].id).toBe(record.mock.calls[0]?.[0].id);
  });

  it('a person with no Venmo gets the cash button and the line, with no chooser', async () => {
    server.base = snapshotOf(W1.input, { venmo: { [ANA]: 'ana-1', [BEN]: 'ben-1', [CY]: 'cy-1', [DEE]: null } });
    await openSettle();
    expect(screen.getByText("Dee hasn't added Venmo yet.")).toBeTruthy();
    expect(button('I paid Dee $174.97 in cash')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: "Venmo, how you're paying" })).toBeNull();
    expect(screen.queryByRole('button', { name: PAY_DEE })).toBeNull();
  });

  it('75: the person owed sees Request (opens only) and Got paid another way (asks, then records other/manual)', async () => {
    signInAs(ANA);
    await openSettle();
    expect(screen.getByLabelText('Ben owes you $130.02')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Request $130.02 from Ben on Venmo, @ben-1' }));
    expect(openLink).toHaveBeenCalledWith(expect.stringContaining('txn=charge'));
    expect(record).not.toHaveBeenCalled();
    await press(button('Got paid another way'));
    expect(screen.getByText('Record that Ben paid you $130.02?')).toBeTruthy();
    await press(button('Record it'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ from: BEN, to: ANA, cents: 13002, method: 'other', source: 'manual' }));
    expect(await screen.findByText('Payment recorded')).toBeTruthy();
    // Ben's row goes (he's paid up); the viewer's own record isn't listed as received from someone else.
    expect(screen.queryByLabelText('Ben owes you $130.02')).toBeNull();
    expect(screen.queryByText('Record that Ben paid you $130.02?')).toBeNull();
    expect(screen.queryByText('Payments to you')).toBeNull();
  });

  it('Request ignores a second tap within 1 s, and opens again after it', async () => {
    signInAs(ANA);
    await openSettle();
    const req = () => screen.getByRole('button', { name: 'Request $130.02 from Ben on Venmo, @ben-1' });
    await press(req());
    await press(req());
    expect(openLink).toHaveBeenCalledTimes(1);
    await later();
    await press(req());
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('123: the recipient’s Not received asks, then undoes; the sender then sees "Dee hasn’t received…"', async () => {
    seedPayment({ id: pid(1), from: CY, to: DEE, cents: 17497 });
    signInAs(DEE);
    await openSettle();
    expect(screen.getByLabelText('Cy sent you $174.97, Sent via Venmo')).toBeTruthy();
    await press(screen.getByRole('button', { name: 'Not received: Cy sent you $174.97' }));
    expect(screen.getByText("Didn't get Cy's $174.97? This clears it and lets Cy know.")).toBeTruthy();
    await press(button('Not received'));
    expect(undo).toHaveBeenCalledWith(pid(1));
    await waitFor(() => expect(screen.queryByText('Payments to you')).toBeNull());
    expect(await screen.findByText('Marked not received. Cy will see it.')).toBeTruthy();
  });

  it('123: the sender’s card says Dee hasn’t received it until a newer payment to Dee exists', async () => {
    server.notReceived = [{ id: pid(1), from: CY, to: DEE, cents: 17497, method: 'venmo', undoneAt: new Date(Date.now() - 60_000).toISOString() }];
    await openSettle();
    expect(screen.getByText("Dee hasn't received your $174.97. Check Venmo before paying again.")).toBeTruthy();
    await press(button('Paid another way'));
    await screen.findByText('Marked paid');
    expect(screen.queryByText("Dee hasn't received your $174.97. Check Venmo before paying again.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The inline check across visits (criterion 121)
// ---------------------------------------------------------------------------

describe('inline check', () => {
  it('asks once per payment: shown on this visit, gone after leaving and coming back', async () => {
    seedPayment({ id: pid(2), from: CY, to: DEE, cents: 17497 });
    const router = await openSettle();
    expect(screen.getByText(CHECK)).toBeTruthy();
    await press(screen.getByRole('link', { name: 'Who paid what' }));
    await screen.findByRole('header', { name: 'Who paid what' });
    await press(button('Back to Settle up'));
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${GROUP_ID}/settle`));
    await screen.findByText('Suggested payments');
    await waitFor(() => expect(storage.data.get(`splitit.sentcheck.v1.${CY}`)).toContain('"a":"shown"'));
    expect(screen.queryByText(CHECK)).toBeNull();
  });

  it('never asks about a payment recorded through Record a payment', async () => {
    seedPayment({ id: pid(3), from: CY, to: DEE, cents: 10000, method: 'venmo', source: 'manual' });
    await openSettle();
    expect(button('Pay Dee $74.97 on Venmo')).toBeTruthy();
    expect(screen.queryByText(/go through\?/)).toBeNull();
  });

  it('does not ask after the time limit', async () => {
    seedPayment({ id: pid(4), from: CY, to: DEE, cents: 17497, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    await openSettle();
    expect(screen.getByText("You're settled up")).toBeTruthy();
    expect(screen.queryByText(CHECK)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Web (criterion 120)
// ---------------------------------------------------------------------------

describe('web send', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'web');
  });

  it('120: Pay opens the tab inside the tap, before anything is awaited or recorded', async () => {
    setBrowser(MAC);
    await openSettle();
    fireEvent.press(button(PAY_DEE));
    // Same tick as the press: the opener ran, nothing was written, Linking wasn't used.
    expect(openWeb).toHaveBeenCalledWith(DEE_URL);
    expect(record).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('120: desktop web never records without Yes; Yes records once with venmo_link', async () => {
    setBrowser(MAC);
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText('Did you send Dee $174.97?')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
    await press(button('Yes, I sent it'));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ to: DEE, cents: 17497, method: 'venmo', source: 'venmo_link' }));
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    expect(screen.queryByText(CHECK)).toBeNull();
  });

  it('120: mobile web records when the tab is still open after the wait', async () => {
    setBrowser(IPHONE, 5);
    await openSettle();
    await press(button(PAY_DEE));
    expect(record).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(WEB_OPEN_CHECK_MS);
    });
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
  });

  it('120: mobile web asks instead when the tab closed during the wait', async () => {
    setBrowser(IPHONE, 5);
    openWeb.mockReturnValue({ closed: true, opener: null });
    await openSettle();
    await press(button(PAY_DEE));
    await act(async () => {
      jest.advanceTimersByTime(WEB_OPEN_CHECK_MS);
    });
    expect(await screen.findByText('Did you send Dee $174.97?')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });

  it('R3: mobile web: a refused record closes the tab it opened, says why, and Pay works again', async () => {
    setBrowser(IPHONE, 5);
    const close = jest.fn();
    openWeb.mockReturnValue({ closed: false, opener: null, close });
    server.recordError = 'not_allowed';
    await openSettle();
    await press(button(PAY_DEE));
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(WEB_OPEN_CHECK_MS);
    });
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("You can't make that change.")).toBeTruthy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(server.payments).toHaveLength(0);
    await waitFor(() => expect(button(PAY_DEE).props.accessibilityState?.disabled).toBe(false));
  });

  it('R3 control: mobile web leaves the tab open when the record lands', async () => {
    setBrowser(IPHONE, 5);
    const close = jest.fn();
    openWeb.mockReturnValue({ closed: false, opener: null, close });
    await openSettle();
    await press(button(PAY_DEE));
    await act(async () => {
      jest.advanceTimersByTime(WEB_OPEN_CHECK_MS);
    });
    expect(await screen.findByText('You sent Dee')).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it('R9: desktop Yes is stored at once, so a failed refetch then leaving never makes the inline check ask', async () => {
    setBrowser(MAC);
    const first = await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText('Did you send Dee $174.97?')).toBeTruthy();
    server.failReads = true;
    await press(button('Yes, I sent it'));
    expect(await screen.findByText("Couldn't refresh. Try again.")).toBeTruthy();
    const id = record.mock.calls[0]?.[0].id ?? '';
    await waitFor(() => expect(storage.data.get(`splitit.sentcheck.v1.${CY}`)).toContain(`"${GROUP_ID}.${id}.0":{"a":"yes"`));
    // Leave before any read lands, then come back with reads working.
    first.unmount();
    server.failReads = false;
    await openSettle();
    // Positive control: the payment is on screen (the suggestion to Dee is gone).
    expect(await screen.findByText("You're settled up")).toBeTruthy();
    expect(screen.queryByText(CHECK)).toBeNull();
  });

  it('120: a blocked popup records nothing and shows the open-failed line', async () => {
    setBrowser(IPHONE, 5);
    openWeb.mockReturnValue(null);
    await openSettle();
    await press(button(PAY_DEE));
    expect(await screen.findByText(OPEN_FAILED)).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Record a payment (criterion 76)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Record a payment (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    if (os === 'web') setBrowser(MAC);
  });

  async function openForm() {
    await openSettle();
    await press(button('Record a payment'));
    expect(screen.getByRole('header', { name: 'Record a payment' })).toBeTruthy();
  }

  it('76: $175.00 to Dee warns first and needs Save anyway', async () => {
    await openForm();
    await press(screen.getByRole('radio', { name: 'Dee' }));
    fireEvent.changeText(screen.getByLabelText('Amount'), '175');
    await press(button('Save payment'));
    expect(screen.getByText("That's more than you owe Dee ($174.97).")).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
    await press(button('Save anyway'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ from: CY, to: DEE, cents: 17500, method: 'cash', source: 'manual' }));
  });

  it('76: $100.00 saves with Cash by default and the new suggestion (W3) shows', async () => {
    await openForm();
    await press(screen.getByRole('radio', { name: 'Dee' }));
    fireEvent.changeText(screen.getByLabelText('Amount'), '100');
    await press(button('Save payment'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(UUID), from: CY, to: DEE, cents: 10000, method: 'cash' }));
    expect(await screen.findByText('You pay Dee $74.97')).toBeTruthy();
    expect(screen.queryByRole('header', { name: 'Record a payment' })).toBeNull();
    expect(await screen.findByText('Payment recorded')).toBeTruthy();
  });

  it('a failed save keeps what was typed and re-enables Save', async () => {
    server.recordError = 'network';
    await openForm();
    await press(screen.getByRole('radio', { name: 'Ana' }));
    await press(screen.getByRole('radio', { name: 'Venmo, how it was paid' }));
    fireEvent.changeText(screen.getByLabelText('Amount'), '12.50');
    await press(button('Save payment'));
    expect(await screen.findByText(groups.GROUP_ERROR_COPY.network)).toBeTruthy();
    expect(screen.getByLabelText('Amount').props.value).toBe('12.50');
    expect(screen.getByRole('radio', { name: 'Ana' }).props.accessibilityState?.checked).toBe(true);
    expect(button('Save payment').props.accessibilityState?.disabled).toBe(false);
    server.recordError = null;
    await press(button('Save payment'));
    expect(record.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ id: record.mock.calls[0]?.[0].id, method: 'venmo', source: 'manual' }));
  });

  it('asks for a person and a real amount; never sends $0', async () => {
    await openForm();
    await press(button('Save payment'));
    expect(screen.getByText('Choose who.')).toBeTruthy();
    await press(screen.getByRole('radio', { name: 'Ben' }));
    fireEvent.changeText(screen.getByLabelText('Amount'), '0');
    await press(button('Save payment'));
    expect(screen.getByText('Enter an amount from $0.01 to $99,999.99.')).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });

  it('"Someone paid me" records the other person as the sender', async () => {
    signInAs(ANA);
    await openForm();
    await press(screen.getByRole('radio', { name: 'Someone paid me' }));
    expect(screen.getByText('Who paid you?')).toBeTruthy();
    await press(screen.getByRole('radio', { name: 'Ben' }));
    fireEvent.changeText(screen.getByLabelText('Amount'), '20');
    await press(button('Save payment'));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ from: BEN, to: ANA, cents: 2000, method: 'cash', source: 'manual' }));
  });

  it('Cancel closes it without a write', async () => {
    await openForm();
    await press(button('Cancel'));
    expect(screen.queryByRole('header', { name: 'Record a payment' })).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Who paid what (criterion 77)
// ---------------------------------------------------------------------------

describe.each(['ios', 'web'] as const)('Who paid what (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    if (os === 'web') setBrowser(MAC);
  });

  async function openBalances() {
    const router = renderRouter(ROUTES, { initialUrl: `/groups/${GROUP_ID}/balances` });
    await screen.findByRole('header', { name: 'Who paid what' });
    return router;
  }

  it('77: a cold deep link lists every member with paid, share, payments and net, adding up to $0.00', async () => {
    await openBalances();
    expect(screen.getByRole('button', { name: /^You, net -\$174\.97\. Paid \$0\.00, share \$174\.97/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ana, net \+\$130\.02\./ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Ben, net -\$136\.69\./ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Dee, net \+\$181\.64\./ })).toBeTruthy();
    expect(screen.getByText("Everyone's balances add up to $0.00")).toBeTruthy();
    expect(screen.getByText('No payments yet.')).toBeTruthy();
  });

  it('tapping a person shows the costs behind their numbers', async () => {
    await openBalances();
    const ana = screen.getByRole('button', { name: /^Ana, net/ });
    expect(screen.queryByLabelText('Airbnb, Paid $240.00 · Share $60.00')).toBeNull();
    await press(ana);
    expect(ana.props.accessibilityState?.expanded).toBe(true);
    expect(screen.getByLabelText('Airbnb, Paid $240.00 · Share $60.00')).toBeTruthy();
    expect(screen.getByLabelText('Rental car, Share $85.72')).toBeTruthy();
  });

  it('77: Undo on your own payment doesn’t ask; on one someone else recorded it asks first', async () => {
    seedPayment({ id: pid(5), from: CY, to: DEE, cents: 5000, method: 'cash', source: 'manual' });
    seedPayment({ id: pid(6), from: DEE, to: CY, cents: 1000, method: 'cash', source: 'manual', recordedBy: DEE });
    await openBalances();
    await press(screen.getByRole('button', { name: 'Undo: You paid Dee $50.00' }));
    expect(undo).toHaveBeenCalledWith(pid(5));
    await waitFor(() => expect(screen.queryByText('You paid Dee $50.00')).toBeNull());
    await press(screen.getByRole('button', { name: 'Undo: Dee paid you $10.00' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Undo Dee's record of $10.00?")).toBeTruthy();
    await press(button('Undo'));
    expect(undo).toHaveBeenCalledWith(pid(6));
    expect(await screen.findByText('No payments yet.')).toBeTruthy();
  });

  it('a third member sees a payment between others without Undo', async () => {
    seedPayment({ id: pid(7), from: CY, to: DEE, cents: 5000, method: 'cash', source: 'manual' });
    signInAs(ANA);
    await openBalances();
    expect(screen.getByText('Cy paid Dee $50.00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
  });

  it('a failed undo says why and keeps the payment', async () => {
    seedPayment({ id: pid(8), from: CY, to: DEE, cents: 5000, method: 'cash', source: 'manual' });
    server.undoError = 'network';
    await openBalances();
    await press(screen.getByRole('button', { name: 'Undo: You paid Dee $50.00' }));
    expect(await screen.findByText(groups.GROUP_ERROR_COPY.network)).toBeTruthy();
    expect(screen.getByText('You paid Dee $50.00')).toBeTruthy();
    expect(reads()).toBeGreaterThan(0);
  });
});
