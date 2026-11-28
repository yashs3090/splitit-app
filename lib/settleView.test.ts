// Settle view logic: criteria 41b–41d (spec Amendment A1, Task 8) and the brief's §10 copy.
// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md, Task 6):
// criteria 26–34, 59, 60, 64, 66, 67 at the end of this file.
import { makeNameOf, splitInputFor } from './billView';
import { BILL_ERROR_COPY } from './bills';
import type { BillData } from './bills';
import { billMarker } from './homeMarkers';
import { claimedItemNames, venmoPayUrl, venmoRequestUrl } from './paylinks';
import {
  balanceFor,
  differenceFor,
  ledgerSettlePlan,
  SETTLE_ALL_ZERO_COPY,
  settlePlan,
  type SettleMark,
  type SettleMarks,
  type SettleNotReceivedMap,
  type SettlePlan,
  type SettlePlanWithEarly,
} from './settle';
import {
  actionError,
  settleErrorShown,
  afterOpenRefusal,
  announceDifferenceText,
  addVenmoPrompt,
  differenceArgs,
  openedFor,
  billFooterAction,
  canChangePayer,
  payerAllPaidLine,
  noticeFor,
  openedStillMatches,
  payerIdOf,
  pickerDecision,
  settleCard,
  settleCards,
  splitSaveDecision,
  settleFooter,
  settleFooterAction,
  settlePeople,
  settleRequestWebLine,
  payOpenFailedLine,
  requestOpenFailedLine,
  saveRefreshFailed,
  settleViewInputFor,
  requestOpenFailedText,
  noticeSnapshot,
  chosenMethod,
  openFailedText,
  payBackOpenFailedText,
  sentCheckChangedText,
  announceSentText,
  announceNotReceivedText,
  SETTLE_COPY,
  type OpenedVenmo,
  type SettleCardModel,
  type SettleFooterAction,
  type SettlePeopleModel,
  type SettleViewInput,
} from './settleView';
import type { SplitClaim, SplitInput } from './split';
import type { PaymentMethod } from './paymentMethods';
import { PAYMENT_METHODS } from './paymentMethods';
import type { SentCheckBlob } from './sentCheck';
import { paymentsMovedBy } from './payers';
import { fakeMark, fakeNotReceived } from '@/test-utils/fakes';

// settleView reads BILL_ERROR_COPY from lib/bills.ts, which creates the Supabase client on import.
jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const A = 'A'; // Hana, host
const B = 'B'; // Sam
const D = 'D'; // Dee
const E = 'E'; // Ana
const PEOPLE = [
  { userId: A, displayName: 'Hana' },
  { userId: B, displayName: 'Sam' },
  { userId: D, displayName: 'Dee' },
  { userId: E, displayName: 'Ana' },
];
const c = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });
const at = '2026-11-24T10:00:00Z';
/** A mark as fetchBill parses it (A1): to the payer (A unless given), method 'other' unless given. */
const mk = (cents: number, method: PaymentMethod = 'other', to: string = A): SettleMark => fakeMark(cents, at, to, method);

/** D3 worked example (Burger A, Salad B, Fries A+B, total 3600): payer A → B owes 1510. */
function worked(extra: Partial<SplitInput> = {}): SplitInput {
  return {
    totalCents: 3600,
    items: [
      { id: 'burger', totalCents: 1500 },
      { id: 'salad', totalCents: 1000 },
      { id: 'fries', totalCents: 600 },
    ],
    claims: [c('burger', A), c('salad', B), c('fries', A), c('fries', B)],
    participantIds: [A, B],
    extrasMode: 'proportional',
    ...extra,
  };
}

function view(plan: SettlePlanWithEarly, viewerId: string, over: Partial<SettleViewInput> = {}): SettleViewInput {
  return {
    plan,
    nameOf: makeNameOf(PEOPLE, viewerId),
    viewerId,
    hostId: A,
    payerId: plan.status === 'ready' || plan.status === 'early' ? plan.payerId : A,
    extrasMode: 'proportional',
    payerVenmo: 'hana-1',
    viewerMarked: false,
    openedVenmo: null,
    platform: 'ios',
    mobileWeb: false,
    viewerItemNames: [],
    venmoOf: () => null,
    itemNamesOf: () => [],
    billId: 'bill-1',
    rememberedMethod: null,
    sentCheck: null,
    permissionUndetermined: false,
    ...over,
  };
}

/** Three people: payer A owes nothing to collect; B owes 500, D owes 300 (no extras). */
function three(marks: SettleMarks = {}): SettlePlan {
  const input: SplitInput = {
    totalCents: 1800,
    items: [
      { id: 'a', totalCents: 1000 },
      { id: 'b', totalCents: 500 },
      { id: 'd', totalCents: 300 },
    ],
    claims: [c('a', A), c('b', B), c('d', D)],
    participantIds: [A, B, D],
    extrasMode: 'proportional',
  };
  return settlePlan(input, A, marks);
}

/** B owes exactly `cents` (no extras) on a complete bill, payer A. */
function bOwesReady(cents: number, marks: SettleMarks = {}): SettlePlan {
  return settlePlan(
    { totalCents: 1000 + cents, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: cents }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'proportional' },
    A,
    marks,
  );
}

describe('settleCard: owes (brief §3.1, 3.2, 3.3, 3.5)', () => {
  const plan = settlePlan(worked(), A, {});
  const url = venmoPayUrl({ username: 'hana-1', cents: 1510 });

  it('3.1 default, before Pay', () => {
    const m = settleCard(view(plan, B));
    expect(m).toMatchObject({ state: 'owes', label: 'You owe Hana', amountCents: 1510, lines: [], notes: ['@hana-1 · $15.10'] });
    expect(m.primary).toEqual({
      label: 'Pay Hana $15.10 on Venmo',
      a11yLabel: 'Pay Hana $15.10 on Venmo, to @hana-1',
      a11yHint: 'Opens Venmo and records it as sent',
      action: { kind: 'pay', method: 'venmo', url, payerId: A, cents: 1510 },
    });
    // A1: "I already paid" is now "Paid another way" (method other).
    expect(m.secondary).toEqual([
      {
        label: 'Paid another way',
        a11yLabel: 'Paid another way',
        a11yHint: 'Records that you paid Hana outside SplitIt',
        action: { kind: 'mark', method: 'other', payerId: A, cents: 1510 },
      },
    ]);
  });

  it('3.1 on web adds the computer line (and not on ios)', () => {
    expect(settleCard(view(plan, B, { platform: 'web' })).notes).toEqual([
      '@hana-1 · $15.10',
      'On a computer? Send it from the Venmo app on your phone.',
    ]);
    expect(settleCard(view(plan, B, { platform: 'android' })).notes).toEqual(['@hana-1 · $15.10']);
  });

  it('3.1 mobile web: no "On a computer?" line (the person is on a phone); desktop web keeps it', () => {
    expect(settleCard(view(plan, B, { platform: 'web', mobileWeb: true })).notes).toEqual(['@hana-1 · $15.10']);
    expect(settleCard(view(plan, B, { platform: 'web', mobileWeb: false })).notes).toContain(
      'On a computer? Send it from the Venmo app on your phone.',
    );
    // Contract O's question on a phone: the same notes, without the computer line.
    expect(settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: 1510 }, platform: 'web', mobileWeb: true })).notes).toEqual([
      '@hana-1 · $15.10',
    ]);
  });

  it('3.2 after Pay (contract O, A1): "Did you send Hana $15.10?" with Yes, I sent it as the primary', () => {
    const m = settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: 1510 }, platform: 'web' }));
    expect(m).toMatchObject({ state: 'owes_opened', label: 'Did you send Hana $15.10?', amountCents: 1510 });
    expect(m.primary).toMatchObject({ label: 'Yes, I sent it', action: { kind: 'mark', method: 'venmo', payerId: A, cents: 1510 } });
    expect(m.notes).toEqual(['@hana-1 · $15.10', 'On a computer? Send it from the Venmo app on your phone.']);
    expect(m.secondary).toEqual([
      { label: 'Open Venmo again', a11yLabel: 'Open Venmo again', a11yHint: 'Opens Venmo', action: { kind: 'pay', method: 'venmo', url, payerId: A, cents: 1510 } },
    ]);
  });

  it('criterion 6 (Venmo note spec N4): Pay and "Open Venmo again" carry the viewer’s item names in the note', () => {
    const itemNames = ['Salad', 'Fries'];
    const named = venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames });
    expect(named).toBe('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    const before = settleCard(view(plan, B, { viewerItemNames: itemNames }));
    expect(before.primary?.action).toEqual({ kind: 'pay', method: 'venmo', url: named, payerId: A, cents: 1510 });
    const after = settleCard(view(plan, B, { viewerItemNames: itemNames, openedVenmo: { payerId: A, cents: 1510 } }));
    expect(after.secondary[0]?.action).toEqual({ kind: 'pay', method: 'venmo', url: named, payerId: A, cents: 1510 });
  });

  it('3.2 is dropped when the payer no longer matches; a different amount keeps it at the opened amount (contract O)', () => {
    expect(settleCard(view(plan, B, { openedVenmo: { payerId: D, cents: 1510 } })).state).toBe('owes');
    expect(settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: 1400 } }))).toMatchObject({
      state: 'owes_opened',
      amountCents: 1400,
      primary: { action: { kind: 'mark', payerId: A, cents: 1400 } },
    });
  });

  it('3.3 marked', () => {
    const m = settleCard(view(settlePlan(worked(), A, { B: mk(1510) }), B));
    expect(m).toMatchObject({
      state: 'marked',
      label: 'You paid Hana',
      amountCents: 1510,
      // A1: a ready marked card ends with the completion line (SV-UX-3).
      lines: [
        { text: 'Marked paid', tone: 'success', live: true },
        { text: "You're all set. Hana can see it.", tone: 'muted' },
      ],
      primary: null,
    });
    expect(m.secondary).toEqual([{ label: 'Undo', a11yLabel: 'Undo', a11yHint: 'Clears Marked paid for $15.10', action: { kind: 'unmark', userId: B } }]);
  });

  it('3.5 the payer has no Venmo (A1, SV-29): no Pay button; the cash primary and Paid another way', () => {
    const m = settleCard(view(plan, B, { payerVenmo: null }));
    expect(m).toMatchObject({
      state: 'owes_no_venmo',
      label: 'You owe Hana',
      amountCents: 1510,
      lines: [{ text: "Hana hasn't added Venmo yet.", tone: 'muted' }],
      notes: [],
      chooser: null,
    });
    expect(m.primary).toMatchObject({ label: 'I paid Hana $15.10 in cash', action: { kind: 'mark', method: 'cash', payerId: A, cents: 1510 } });
    expect(m.secondary.map((b) => b.label)).toEqual(['Paid another way']);
  });
});

describe('settleCard: share changed since the mark (Task 6: 3.4 is replaced by more_due / back_due)', () => {
  const mark = { B: mk(1510) };
  it('a share 1¢ off the mark shows the plain 3.3 card (B6, tolerance)', () => {
    for (const cents of [1509, 1511]) expect(settleCard(view(bOwesReady(cents, mark), B)).state).toBe('marked');
  });
  it('higher → more_due, lower → back_due, $0.00 → back_due for the whole mark', () => {
    expect(settleCard(view(bOwesReady(1620, mark), B)).state).toBe('more_due');
    expect(settleCard(view(bOwesReady(1400, mark), B)).state).toBe('back_due');
    const zero = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, mark);
    expect(settleCard(view(zero, B))).toMatchObject({
      state: 'back_due',
      amountCents: 1510,
      lines: [{ text: "Your share is now $0.00. You've paid $15.10.", tone: 'muted' }],
    });
  });
});

describe('settleCard: nothing, negative, payer (brief §3.6–3.8)', () => {
  it('3.6 nothing owed', () => {
    const plan = settlePlan(worked({ participantIds: [A, B, D] }), A, {});
    expect(settleCard(view(plan, D))).toMatchObject({
      state: 'nothing',
      label: "You're all set",
      amountCents: null,
      lines: [{ text: "You don't owe anything on this bill." }],
      primary: null,
      secondary: [],
    });
  });

  it('3.7 negative share (-100)', () => {
    const plan = settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
      A,
      {},
    );
    expect(settleCard(view(plan, B))).toMatchObject({
      state: 'negative',
      label: 'Hana owes you',
      amountCents: 100,
      lines: [{ text: 'Settle that outside the app.' }],
      primary: null,
      secondary: [],
    });
  });

  it('3.8 payer, nobody marked: "2 people owe you" / 800 / "0 of 2 paid"', () => {
    expect(settleCard(view(three(), A))).toMatchObject({
      state: 'payer',
      label: '2 people owe you',
      amountCents: 800,
      lines: [{ text: '0 of 2 settled up', live: true }],
      primary: null,
    });
  });

  it('3.8 payer, some marked', () => {
    expect(settleCard(view(three({ B: mk(500) }), A)).lines[0]?.text).toBe('1 of 2 settled up');
  });

  it('3.8 payer, all marked', () => {
    expect(settleCard(view(three({ B: mk(500), D: mk(300) }), A))).toMatchObject({
      state: 'payer_all_paid',
      label: "Everyone's settled up. Nice.",
      amountCents: 800,
      lines: [{ text: '2 marked paid', tone: 'success' }],
    });
  });

  it('3.8 one person: singular label', () => {
    expect(settleCard(view(settlePlan(worked(), A, {}), A)).label).toBe('1 person owes you');
  });

  it('3.8 nobody owes the payer', () => {
    const plan = settlePlan({ ...worked(), claims: [c('burger', A), c('salad', A), c('fries', A)] }, A, {});
    expect(settleCard(view(plan, A))).toMatchObject({ state: 'payer_nobody', label: 'Nobody owes you anything on this bill.', amountCents: null });
  });

  it('Add Venmo card: the payer without a handle, when someone owes them', () => {
    expect(addVenmoPrompt(view(three(), A, { payerVenmo: null }))).toEqual({
      text: 'Add your Venmo so people can pay you',
      button: { label: 'Add Venmo', a11yLabel: 'Add Venmo', a11yHint: 'Opens your profile', action: { kind: 'add_venmo' } },
    });
    expect(addVenmoPrompt(view(three(), A))).toBeNull(); // has a handle
    expect(addVenmoPrompt(view(three(), B, { payerVenmo: null }))).toBeNull(); // not the payer
  });
});

describe('settleCard: blocked (brief §3.9–3.11)', () => {
  const k2 = settlePlan({ ...worked(), claims: [c('burger', A), c('salad', B), c('fries', A)].slice(0, 2) }, A, {});

  it('3.9 K2-style: one item left, no amount', () => {
    const m = settleCard(view(k2, B));
    expect(m).toMatchObject({
      state: 'blocked',
      label: 'Not ready yet',
      amountCents: null,
      lines: [{ text: 'You can settle up once every item is claimed (1 item left).' }],
      primary: { label: 'Back to the bill', action: { kind: 'back' } },
    });
  });

  it('3.9 plural, and "Your I paid is saved" for a marked viewer', () => {
    const plan: SettlePlan = { status: 'blocked', unclaimedRows: 3, unclaimedDiscountRows: 0 };
    expect(settleCard(view(plan, B, { viewerMarked: true })).lines.map((l) => l.text)).toEqual([
      'You can settle up once every item is claimed (3 items left).',
      'Your "I paid" is saved.',
    ]);
  });

  it('R1 (Amendment A1): the blocked body names discounts', () => {
    const body = (unclaimedRows: number, unclaimedDiscountRows: number) =>
      settleCard(view({ status: 'blocked', unclaimedRows, unclaimedDiscountRows }, B)).lines[0]?.text;
    expect(body(1, 1)).toBe('You can settle up once every discount is claimed (1 discount left).');
    expect(body(2, 2)).toBe('You can settle up once every discount is claimed (2 discounts left).');
    expect(body(3, 1)).toBe('You can settle up once everything is claimed (2 items and 1 discount left).');
    expect(body(2, 0)).toBe('You can settle up once every item is claimed (2 items left).');
  });

  it('3.10 all-zero as host and as guest', () => {
    const plan: SettlePlan = { status: 'blocked_all_zero' };
    const host = settleCard(view(plan, A));
    expect(host.lines[0]?.text).toBe(SETTLE_ALL_ZERO_COPY);
    expect(host.primary).toMatchObject({ label: 'Edit items', action: { kind: 'edit' } });
    expect(host.secondary.map((b) => b.label)).toEqual(['Back to the bill']);
    const guest = settleCard(view(plan, B));
    expect(guest.lines.map((l) => l.text)).toEqual(['Every item is $0. Ask Hana to fix the prices.']);
    expect(guest.primary).toMatchObject({ label: 'Back to the bill' });
    expect(guest.secondary).toEqual([]);
  });

  it('R6: all-zero with the viewer marked also says the mark is saved (host and guest)', () => {
    const plan: SettlePlan = { status: 'blocked_all_zero' };
    expect(settleCard(view(plan, B, { viewerMarked: true })).lines.map((l) => l.text)).toEqual([
      'Every item is $0. Ask Hana to fix the prices.',
      'Your "I paid" is saved.',
    ]);
    expect(settleCard(view(plan, A, { viewerMarked: true })).lines.map((l) => l.text)).toEqual([
      SETTLE_ALL_ZERO_COPY,
      'Your "I paid" is saved.',
    ]);
  });

  it('3.11 bad payer: error and Try again, no payer line, no Change', () => {
    const plan: SettlePlan = { status: 'blocked_bad_payer' };
    expect(settleCard(view(plan, B))).toMatchObject({
      state: 'bad_payer',
      label: 'Something went wrong loading this bill.',
      primary: { label: 'Try again', action: { kind: 'retry' } },
    });
    expect(canChangePayer(A, A, 2, plan)).toBe(false);
  });

  it('blocked plans have no Everyone list', () => {
    expect(settlePeople(view(k2, A))).toBeNull();
  });
});

// The payer line itself is lib/payers.ts's paidByLine now (who paid A1.5; tested there).
describe('Change', () => {
  it('Change: host only, 2+ participants', () => {
    const plan = settlePlan(worked(), A, {});
    expect(canChangePayer(A, A, 2, plan)).toBe(true);
    expect(canChangePayer(A, A, 1, plan)).toBe(false);
    expect(canChangePayer(B, A, 3, plan)).toBe(false);
  });
});

describe('settlePeople (brief §4)', () => {
  it('payer view: B Paid, D Not yet, no payer row, and no aside (the card says "1 of 2 paid", R4)', () => {
    const m = settlePeople(view(three({ B: mk(500) }), A));
    expect(m?.title).toBe('Everyone');
    expect(m?.aside).toBeNull();
    expect(m?.rows.map((r) => [r.name, r.amountCents, r.status?.text ?? null, r.a11yLabel])).toEqual([
      ['Sam', 500, 'Paid', 'Sam, $5.00, marked paid'],
      ['Dee', 300, 'Not yet', 'Dee, $3.00, not paid yet'],
    ]);
  });

  it('everyone else sees the aside: "1 of 2 paid", then "All paid"', () => {
    expect(settlePeople(view(three({ B: mk(500) }), B))?.aside).toBe('1 of 2 settled up');
    expect(settlePeople(view(three({ B: mk(500), D: mk(300) }), D))?.aside).toBe('All settled up');
  });

  it('R4: the payer never gets the aside, all paid included', () => {
    expect(settlePeople(view(three({ B: mk(500), D: mk(300) }), A))?.aside).toBeNull();
  });

  it('the viewer comes first as "You", and the order is stable', () => {
    const rows = settlePeople(view(three(), D))?.rows ?? [];
    expect(rows.map((r) => r.name)).toEqual(['You', 'Sam']);
    const marked = settlePeople(view(three({ D: mk(300) }), D))?.rows ?? [];
    expect(marked.map((r) => r.name)).toEqual(['You', 'Sam']);
  });

  it('leaves out people who owe nothing, unless they have a mark', () => {
    const plan = settlePlan(worked({ participantIds: [A, B, D] }), A, {});
    expect(settlePeople(view(plan, A))?.rows.map((r) => r.userId)).toEqual([B]);
    const markedD = settlePlan(worked({ participantIds: [A, B, D] }), A, { D: mk(200) });
    const d = settlePeople(view(markedD, A))?.rows.find((r) => r.userId === D);
    // Task 6: a mark above a $0 share is a back difference (the host-payer pays it back).
    expect(d).toMatchObject({
      amountCents: 0,
      status: { text: 'You owe $2.00 back', tone: 'warning' },
      subLine: { text: 'Marked $2.00 · share now $0.00', tone: 'muted' },
      a11yLabel: 'Dee, marked paid $2.00, share is now $0.00, you owe Dee $2.00 back',
    });
  });

  it('share changed row (more due, payer viewing)', () => {
    const plan = three({ B: mk(450) });
    const b = settlePeople(view(plan, A))?.rows[0];
    expect(b).toMatchObject({
      status: { text: 'Owes $0.50 more', tone: 'muted' },
      subLine: { text: 'Marked $4.50 · share now $5.00', tone: 'muted' },
      a11yLabel: 'Sam, marked paid $4.50, share is now $5.00, owes $0.50 more',
    });
  });

  it('negative rows: others see "Hana owes Ana"; the payer sees "You owe Ana"', () => {
    const plan = settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B, D], extrasMode: 'equal' },
      D,
      {},
    );
    // Payer D; A owes, B is negative. Viewed by A (host, not payer):
    const fromA = settlePeople(view(plan, A))?.rows.find((r) => r.userId === B);
    expect(fromA).toMatchObject({ status: null, subLine: { text: 'Dee owes Sam. Settle outside the app.', tone: 'muted' }, a11yLabel: 'Sam, Dee owes Sam $1.00, settle outside the app' });
    const fromD = settlePeople(view(plan, D))?.rows.find((r) => r.userId === B);
    expect(fromD).toMatchObject({ subLine: { text: 'You owe Sam $1.00. Settle that outside the app.' }, a11yLabel: 'Sam, you owe Sam $1.00, settle outside the app' });
  });

  it('Undo: the host and the payer get a confirm; others none; the viewer\'s own row none (it is on the card)', () => {
    // Payer D (not the host); B and A marked.
    const input: SplitInput = {
      totalCents: 1800,
      items: [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 500 },
        { id: 'd', totalCents: 300 },
      ],
      claims: [c('a', A), c('b', B), c('d', D)],
      participantIds: [A, B, D],
      extrasMode: 'proportional',
    };
    const p = settlePlan(input, D, { B: mk(500, 'other', D), A: mk(1000, 'other', D) });
    const hostRows = settlePeople(view(p, A))?.rows ?? [];
    expect(hostRows.find((r) => r.userId === A)?.undo).toBeNull();
    expect(hostRows.find((r) => r.userId === B)?.undo).toEqual({ userId: B, confirm: true, a11yLabel: "Undo Sam's I paid", confirmText: 'Undo Sam\'s "I paid"?' });
    // A1 (SV-10): the payer gets Not received instead of Undo on every marked row.
    const payerRows = settlePeople(view(p, D))?.rows ?? [];
    expect(payerRows.find((r) => r.userId === B)?.undo).toBeNull();
    expect(payerRows.find((r) => r.userId === B)?.notReceived?.confirmText).toBe("Didn't get Sam's $5.00? This clears it and lets Sam know.");
    expect(payerRows.find((r) => r.userId === A)?.notReceived?.a11yLabel).toBe("Not received, Hana's $10.00");
    const bRows = settlePeople(view(p, B))?.rows ?? [];
    expect(bRows.every((r) => r.undo === null)).toBe(true);
  });
});

describe('picker (brief §5, criterion 41c)', () => {
  const nameOf = makeNameOf(PEOPLE, A);
  // Who paid (A1.5 M8): set_payer clears nothing now, so the old "This clears N marks" copy is gone.
  // `moved` is contract M (paymentsMovedBy); see the who-paid block at the end of this file for more.
  const movedTo = (toId: string, ...from: [string, number][]) => from.map(([fromId, cents]) => ({ fromId, toId, cents }));
  it('2 marks: names both, says their payments still count', () => {
    expect(pickerDecision({ targetId: B, payerId: A, moved: movedTo(A, [D, 500], [E, 700]), complete: true, viewerId: A, nameOf })).toEqual({
      kind: 'confirm',
      title: 'Dee and Ana already paid you',
      text: "If you switch to Sam, their payments still count. You'll pass $12.00 on to Sam.",
      button: 'Switch to Sam',
      cancelA11yLabel: 'Cancel: keep you as the payer',
    });
  });
  it('1 mark: singular', () => {
    const d = pickerDecision({ targetId: B, payerId: A, moved: movedTo(A, [D, 500]), complete: false, viewerId: A, nameOf });
    expect(d).toMatchObject({ title: 'Dee already paid you', text: "If you switch to Sam, Dee's $5.00 still counts. You'll pass it on to Sam." });
  });
  it('0 marks and complete: "People may already be paying Dee."', () => {
    const d = pickerDecision({ targetId: B, payerId: D, moved: [], complete: true, viewerId: A, nameOf });
    expect(d).toEqual({
      kind: 'confirm',
      title: null,
      text: 'Switch to Sam? People may already be paying Dee.',
      button: 'Switch to Sam',
      cancelA11yLabel: 'Cancel: keep Dee as the payer',
    });
  });
  it('0 marks and complete, the host is the payer: "paying you"', () => {
    expect(pickerDecision({ targetId: B, payerId: A, moved: [], complete: true, viewerId: A, nameOf })).toMatchObject({
      text: 'Switch to Sam? People may already be paying you.',
    });
  });
  it('0 marks and incomplete: no confirm', () => {
    expect(pickerDecision({ targetId: B, payerId: A, moved: [], complete: false, viewerId: A, nameOf })).toEqual({ kind: 'direct' });
  });
  it('the current payer: no-op', () => {
    expect(pickerDecision({ targetId: A, payerId: A, moved: movedTo(A, [B, 500]), complete: true, viewerId: A, nameOf })).toEqual({ kind: 'noop' });
  });
});

describe('noticeFor (brief §6, criterion 41d)', () => {
  const nameOf = makeNameOf(PEOPLE, B);
  const ctx = { iChangedPayer: false, iUndid: false, openedVenmo: null, nameOf, viewerId: B };
  it('payer A → D, not by me', () => {
    expect(noticeFor({ payerId: A, myMark: false }, { payerId: D, myMark: false }, ctx)).toBe('Dee is now collecting for this bill.');
  });
  it('with my mark cleared, it adds the sort-it-out line', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: D, myMark: false }, ctx)).toBe(
      'Dee is now collecting for this bill. If you already paid Hana, sort it out with them.',
    );
  });
  it('with openedVenmo pointing at the old payer, too', () => {
    expect(noticeFor({ payerId: A, myMark: false }, { payerId: D, myMark: false }, { ...ctx, openedVenmo: { payerId: A, cents: 1510 } })).toBe(
      'Dee is now collecting for this bill. If you already paid Hana, sort it out with them.',
    );
  });
  it('the viewer becomes the payer', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: B, myMark: false }, ctx)).toBe(
      "You're now collecting for this bill. If you already paid Hana, sort it out with them.",
    );
  });
  it('changed by me: no notice', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: D, myMark: false }, { ...ctx, iChangedPayer: true })).toBeNull();
  });
  it('my mark gone, same payer, not by me: the undone notice', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: A, myMark: false }, ctx)).toBe(
      'Your "I paid" was undone. Check Activity to see who.',
    );
  });
  it('iUndid: none', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: A, myMark: false }, { ...ctx, iUndid: true })).toBeNull();
  });
  it('nothing changed: none', () => {
    expect(noticeFor({ payerId: A, myMark: true }, { payerId: A, myMark: true }, ctx)).toBeNull();
  });
});

describe('actionError (brief §3.12)', () => {
  it.each([
    ['network', "Couldn't save. Try again.", false],
    ['payer_changed', BILL_ERROR_COPY.payer_changed, true],
    ['not_complete', 'Something on the bill just changed. Check your share and try again.', true], // SE-UX-13
    ['not_allowed', BILL_ERROR_COPY.not_allowed, false],
    ['invalid_bill', "Couldn't save. Refresh and try again.", true],
    ['marks_changed', BILL_ERROR_COPY.marks_changed, true],
    // Who paid S8: the host changed the total, so who paid no longer adds up; re-read to show the stale card.
    ['payers_stale', BILL_ERROR_COPY.payers_stale, true],
    // Delete group A3.4: a lock clash aborted the write. Definite, nothing changed: no re-read.
    ['busy', "That didn't go through. Please try again.", false],
  ] as const)('%s', (code, text, refetch) => {
    expect(actionError(code)).toEqual({ text, refetch });
  });
});

describe('settleFooter (brief §7)', () => {
  it('hidden with 1 participant', () => expect(settleFooter(1, 0)).toBeNull());
  it('incomplete: secondary with the plural caption', () => {
    expect(settleFooter(2, 1)).toEqual({ variant: 'secondary', caption: '1 item left to claim', a11yHint: '1 item left to claim first', incomplete: true });
    expect(settleFooter(3, 3)?.caption).toBe('3 items left to claim');
  });
  it('R1 (Amendment A1): names discounts when only discounts, or both kinds, are left', () => {
    expect(settleFooter(2, 1, 1)).toEqual({
      variant: 'secondary',
      caption: '1 discount left to claim',
      a11yHint: '1 discount left to claim first',
      incomplete: true,
    });
    expect(settleFooter(2, 2, 2)?.caption).toBe('2 discounts left to claim');
    expect(settleFooter(2, 3, 1)?.caption).toBe('2 items and 1 discount left to claim');
    expect(settleFooter(2, 2, 1)?.caption).toBe('1 item and 1 discount left to claim');
    expect(settleFooter(2, 1, 0)?.caption).toBe('1 item left to claim');
  });
  it('complete: primary', () => {
    expect(settleFooter(2, 0)).toEqual({ variant: 'primary', caption: null, a11yHint: 'See what you owe and pay' });
  });
});

it('copy constants match the brief', () => {
  expect(SETTLE_COPY.title).toBe('Settle up');
  expect(SETTLE_COPY.back).toBe('Bill');
  expect(SETTLE_COPY.pickerTitle).toBe('Who paid the bill?');
});

/** VP-30 / R8: no status or navigation glyph in any settle string; the screens draw icons from tone. */
const GLYPH = /[✓⚠‹›▴▾◉○]/u;

it('settle copy carries no status glyphs; the screens draw icons from tone (P3, VP-30)', () => {
  for (const text of Object.values(SETTLE_COPY)) expect(text).not.toMatch(GLYPH);
  for (const method of PAYMENT_METHODS) {
    expect(payerAllPaidLine([{ name: 'Sam', method }])).not.toMatch(GLYPH);
    expect(payerAllPaidLine([{ name: 'Sam', method }, { name: 'Dee', method: 'cash' }])).not.toMatch(GLYPH);
  }
  // Sentence builders too (R8): the share-changed lines and the row sub-line "Marked … · share now …".
  const changed = [bOwesReady(1620, { B: mk(1510) }), bOwesReady(1400, { B: mk(1510) })];
  for (const plan of changed) {
    for (const line of settleCard(view(plan, B)).lines) expect(line.text).not.toMatch(GLYPH);
    const row = settlePeople(view(plan, A))?.rows[0];
    expect(row?.subLine?.text).toMatch(/^Marked \$15\.10 · share now \$1[46]\.[02]0$/);
    expect(row?.subLine?.text).not.toMatch(GLYPH);
  }
});

describe('openedStillMatches and payerIdOf', () => {
  const plan = settlePlan(worked(), A, {});
  it('share kind (contract O): true for the same payer while the viewer is unmarked, whatever the amount', () => {
    expect(openedStillMatches(plan, B, { payerId: A, cents: 1510 })).toBe(true);
    expect(openedStillMatches(plan, B, { payerId: D, cents: 1510 })).toBe(false);
    expect(openedStillMatches(plan, B, { payerId: A, cents: 1400 })).toBe(true);
    expect(openedStillMatches(settlePlan(worked(), A, { B: mk(1510) }), B, { payerId: A, cents: 1510 })).toBe(false);
    expect(openedStillMatches({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B, { payerId: A, cents: 1510 })).toBe(false);
    expect(openedStillMatches(plan, A, { payerId: A, cents: 1510 })).toBe(false); // the payer owes nothing
  });
  it('payerIdOf reads the bill', () => {
    expect(payerIdOf({ bill: { payer_id: D } })).toBe(D);
  });
});

describe('payerAllPaidLine (A1, SV-UX-14)', () => {
  it('one ower: names them, per method (QA copy nit, 2026-11-24: never "All 1")', () => {
    expect(payerAllPaidLine([{ name: 'Sam', method: 'other' }])).toBe('Sam marked it paid');
    expect(payerAllPaidLine([{ name: 'Sam', method: 'venmo' }])).toBe('Sam sent it via Venmo');
  });
  it('counts two or more by method, in venmo, cash, other order', () => {
    const other = { name: 'x', method: 'other' as const };
    expect(payerAllPaidLine([other, other])).toBe('2 marked paid');
    expect(payerAllPaidLine([other, { name: 'y', method: 'cash' }, { name: 'z', method: 'venmo' }])).toBe('1 sent via Venmo · 1 paid in cash · 1 marked paid');
  });
});

// ---------------------------------------------------------------------------
// Venmo Request buttons (docs/specs/2026-11-25-venmo-request-buttons.md, Task 2: criteria 6–12)
// ---------------------------------------------------------------------------

/** One ower B with a share of `cents` (no extras), payer A; optional extra participant D who owes nothing. */
function oneOwer(cents: number, marks: SettleMarks = {}, withD = false): SettlePlan {
  return settlePlan(
    {
      totalCents: cents,
      items: [{ id: 'x', totalCents: cents }],
      claims: [c('x', B)],
      participantIds: withD ? [A, B, D] : [A, B],
      extrasMode: 'proportional',
    },
    A,
    marks,
  );
}

const TEJ = 'Tejesh-Bhaumik';
const venmoB = (id: string) => (id === B ? TEJ : null);
const rowOf = (input: SettleViewInput, userId: string) => settlePeople(input)?.rows.find((r) => r.userId === userId);
const noteOf = (url: string) => new URL(url).searchParams.get('note');

describe('settlePeople: Request (request spec R2, criteria 6–8)', () => {
  it('Q1: unmarked ower with a valid username gets @handle + Request for exactly owedCents', () => {
    const input = view(oneOwer(1510), A, { venmoOf: venmoB });
    const row = rowOf(input, B);
    expect(row?.request).toEqual({
      kind: 'link',
      userId: B,
      url: venmoRequestUrl({ username: TEJ, cents: 1510, itemNames: [] }),
      cents: 1510,
      handle: TEJ,
      caption: '@Tejesh-Bhaumik',
      label: 'Request',
      a11yLabel: 'Request $15.10 from Sam on Venmo, @Tejesh-Bhaumik',
      a11yHint: 'Opens Venmo',
    });
    // The row itself is unchanged (R3: the button sits outside the grouped row).
    expect(row).toMatchObject({ status: { text: 'Not yet' }, a11yLabel: 'Sam, $15.10, not paid yet', undo: null });
  });

  it('Q2: no username → caption "Hasn\'t added Venmo", no URL', () => {
    expect(rowOf(view(oneOwer(1510), A), B)?.request).toEqual({ kind: 'caption', caption: "Hasn't added Venmo" });
  });

  it('Q3: a stored username that fails the pattern → same as Q2', () => {
    for (const bad of ['ab', '@hana-1', 'ab cd', 'a'.repeat(31)]) {
      expect(rowOf(view(oneOwer(1510), A, { venmoOf: () => bad }), B)?.request).toEqual({ kind: 'caption', caption: "Hasn't added Venmo" });
    }
  });

  it('Q4: a share over 99,999,999¢ → caption "Request it in the Venmo app", no URL (criterion 8)', () => {
    expect(rowOf(view(oneOwer(100_000_000), A, { venmoOf: venmoB }), B)?.request).toEqual({
      kind: 'caption',
      caption: 'Request it in the Venmo app',
    });
  });

  it('R6 (Amendment A2): Q4 is decided by the amount; a bad or missing username over the cap also reads Q4', () => {
    expect(rowOf(view(oneOwer(100_000_000), A, { venmoOf: () => 'ab' }), B)?.request).toEqual({ kind: 'caption', caption: 'Request it in the Venmo app' });
    expect(rowOf(view(oneOwer(100_000_000), A), B)?.request).toEqual({ kind: 'caption', caption: 'Request it in the Venmo app' });
    expect(rowOf(view(oneOwer(99_999_999), A, { venmoOf: () => 'ab' }), B)?.request).toEqual({ kind: 'caption', caption: "Hasn't added Venmo" });
  });

  it('Q5: marked at the share → no request; row is Paid with Undo', () => {
    const row = rowOf(view(oneOwer(1510, { B: mk(1510) }), A, { venmoOf: venmoB }), B);
    expect(row?.request).toBeNull();
    expect(row).toMatchObject({ status: { text: 'Paid' }, subLine: null });
    // A1 (SV-10): the payer's control on a marked row is Not received, not Undo.
    expect(row?.undo).toBeNull();
    expect(row?.notReceived).not.toBeNull();
  });

  it('Q6 (reversed by Task 6, SE-4): more due → a Request for the difference; back due → no request, a pay-back instead', () => {
    const up = rowOf(view(oneOwer(700, { B: mk(500) }), A, { venmoOf: venmoB }), B);
    expect(up?.request).toMatchObject({ kind: 'link', cents: 200, label: 'Request $2.00' });
    expect(up?.subLine).toEqual({ text: 'Marked $5.00 · share now $7.00', tone: 'muted' });
    const down = rowOf(view(oneOwer(500, { B: mk(700) }), A, { venmoOf: venmoB }), B);
    expect(down?.request).toBeNull();
    expect(down?.payBack?.link).toMatchObject({ kind: 'link', cents: 200, label: 'Pay $2.00 back' });
    expect(down?.subLine).toEqual({ text: 'Marked $7.00 · share now $5.00', tone: 'muted' });
  });

  it('Q7: someone who owes nothing but has a mark → no request', () => {
    const plan = oneOwer(1510, { D: mk(200) }, true);
    const row = rowOf(view(plan, A, { venmoOf: () => 'dee-12345' }), D);
    // Task 6: a mark above a $0 share is a back difference; the payer gets pay-back controls, not a Request.
    expect(row).toMatchObject({ amountCents: 0, status: { text: 'You owe $2.00 back' } });
    expect(row?.request).toBeNull();
    expect(row?.payBack?.link).toMatchObject({ kind: 'link', cents: 200 });
  });

  it('Q8: a negative share → no request', () => {
    const plan = settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B, D], extrasMode: 'equal' },
      D,
      {},
    );
    const rows = settlePeople(view(plan, D, { venmoOf: () => 'someone-1' }))?.rows ?? [];
    expect(rows.find((r) => r.userId === B)?.request).toBeNull();
    expect(rows.find((r) => r.userId === B)?.subLine?.text).toBe('You owe Sam $1.00. Settle that outside the app.');
    // A owes D in that plan and is unmarked, so A's row does get a Request (Q1).
    expect(rows.find((r) => r.userId === A)?.request).toMatchObject({ kind: 'link' });
  });

  it('criterion 7: each ower\'s note lists only their own items, never the payer\'s, a name or an amount', () => {
    const items: Record<string, readonly string[]> = { [A]: ['Burger'], [B]: ['Pad Thai'], [D]: ['Beer'] };
    const input = view(three(), A, { venmoOf: (id) => ({ [B]: 'sam-1234', [D]: 'dee-1234' })[id] ?? null, itemNamesOf: (id) => items[id] ?? [] });
    const b = rowOf(input, B)?.request;
    const d = rowOf(input, D)?.request;
    if (b?.kind !== 'link' || d?.kind !== 'link') throw new Error('expected links');
    expect(b.url).toBe(venmoRequestUrl({ username: 'sam-1234', cents: 500, itemNames: ['Pad Thai'] }));
    expect(noteOf(b.url)).toBe('SplitIt: Pad Thai');
    expect(noteOf(d.url)).toBe('SplitIt: Beer');
    for (const note of [noteOf(b.url), noteOf(d.url)]) {
      for (const secret of ['Burger', 'Hana', 'Sam', 'Dee', '5.00', '3.00']) expect(note).not.toContain(secret);
    }
  });

  it('criterion 8: request.cents === owedCents at 1¢ and 99,999,999¢', () => {
    for (const cents of [1, 99_999_999]) {
      const r = rowOf(view(oneOwer(cents), A, { venmoOf: venmoB }), B)?.request;
      expect(r).toMatchObject({ kind: 'link', cents });
      if (r?.kind === 'link') expect(r.url).toBe(venmoRequestUrl({ username: TEJ, cents }));
    }
  });
});

describe('settlePeople: who sees Request (criterion 9)', () => {
  // Payer D, host A (not the payer). A owes 1000, B owes 500.
  const plan = settlePlan(
    {
      totalCents: 1800,
      items: [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 500 },
        { id: 'd', totalCents: 300 },
      ],
      claims: [c('a', A), c('b', B), c('d', D)],
      participantIds: [A, B, D],
      extrasMode: 'proportional',
    },
    D,
    {},
  );
  const all = { venmoOf: () => 'valid-name', itemNamesOf: () => ['Thing'] };

  it('Q9: the host who isn\'t the payer, and an ower, get request === null on every row', () => {
    for (const viewer of [A, B]) {
      const rows = settlePeople(view(plan, viewer, all))?.rows ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.request === null)).toBe(true);
    }
    // The payer does see them.
    expect(settlePeople(view(plan, D, all))?.rows.every((r) => r.request?.kind === 'link')).toBe(true);
  });

  it('Q10: blocked plans still give no list', () => {
    const blocked = settlePlan(worked({ claims: [c('burger', A), c('fries', A), c('fries', B)] }), A, {});
    expect(blocked.status).toBe('blocked');
    expect(settlePeople(view(blocked, A, all))).toBeNull();
    expect(settlePeople(view({ status: 'blocked_all_zero' }, A, all))).toBeNull();
    expect(settlePeople(view({ status: 'blocked_bad_payer' }, A, all))).toBeNull();
  });
});

describe('Request copy (R3, criterion 10)', () => {
  it('a11y label and open-failed line for Tejesh / @Tejesh-Bhaumik / 1510¢', () => {
    const names = (id: string | null) => (id === B ? 'Tejesh' : id === A ? 'You' : 'Someone');
    const r = rowOf(view(oneOwer(1510), A, { venmoOf: venmoB, nameOf: names }), B)?.request;
    expect(r).toMatchObject({ label: 'Request', a11yLabel: 'Request $15.10 from Tejesh on Venmo, @Tejesh-Bhaumik', a11yHint: 'Opens Venmo', caption: '@Tejesh-Bhaumik' });
    expect(requestOpenFailedText(TEJ, 1510)).toBe("Couldn't open Venmo. Request $15.10 from @Tejesh-Bhaumik in the Venmo app.");
  });

  it('fixed strings', () => {
    expect(SETTLE_COPY.request).toBe('Request');
    expect(SETTLE_COPY.requestNoVenmo).toBe("Hasn't added Venmo");
    expect(SETTLE_COPY.requestTooLarge).toBe('Request it in the Venmo app');
    expect(SETTLE_COPY.requestWebLine).toBe('On a computer? Send requests from the Venmo app on your phone.');
  });
});

describe('settleRequestWebLine (criterion 11)', () => {
  // Review R4: the caller passes the list it already built.
  const webLine = (input: SettleViewInput) => settleRequestWebLine(input, settlePeople(input));
  const LINE = 'On a computer? Send requests from the Venmo app on your phone.';

  it('web + payer + at least one Request URL → the line', () => {
    expect(webLine(view(oneOwer(1510), A, { venmoOf: venmoB, platform: 'web' }))).toBe(LINE);
  });

  it('null on ios and android', () => {
    for (const platform of ['ios', 'android']) {
      expect(webLine(view(oneOwer(1510), A, { venmoOf: venmoB, platform }))).toBeNull();
    }
  });

  it('null on mobile web (the person is already on a phone)', () => {
    expect(webLine(view(oneOwer(1510), A, { venmoOf: venmoB, platform: 'web', mobileWeb: true }))).toBeNull();
  });

  it('null for non-payers on web', () => {
    expect(webLine(view(oneOwer(1510), B, { venmoOf: () => TEJ, platform: 'web' }))).toBeNull();
  });

  it('null when every ower is marked or has no username, or only the too-large caption shows', () => {
    expect(webLine(view(oneOwer(1510, { B: mk(1510) }), A, { venmoOf: venmoB, platform: 'web' }))).toBeNull();
    expect(webLine(view(oneOwer(1510), A, { platform: 'web' }))).toBeNull();
    expect(webLine(view(oneOwer(100_000_000), A, { venmoOf: venmoB, platform: 'web' }))).toBeNull();
    expect(webLine(view({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, A, { venmoOf: venmoB, platform: 'web' }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shared view input + footer model (request spec Amendment A1, Task 3: criteria 23–28)
// ---------------------------------------------------------------------------

const BILL_AT = '2026-11-24T10:00:00Z';
type Member = BillData['participants'][number];
const member = (userId: string, displayName: string | null, venmoUsername: string | null = null, markCents: number | null = null): Member => ({
  userId,
  displayName,
  venmoUsername,
  mark: markCents === null ? null : fakeMark(markCents, BILL_AT, A),
  notReceived: null,
});
const billRow = (id: string, name: string, cents: number, g: number) => ({
  id,
  name,
  note: null,
  group_position: g,
  unit_index: 0,
  group_size: 1,
  total_cents: cents,
  kind: 'item' as const,
  applies_to: null,
  split_set_by: null,
  split_set_at: null,
});
const cl = (rowId: string, userId: string) => ({ line_item_id: rowId, user_id: userId, parts: 1 });

/** The note spec's worked fixture: Burger (Hana), Salad (Sam), Fries (both), tax 500, payer Hana @hana-1 → Sam owes 1510. */
function billData(
  over: { payerId?: string; participants?: Member[]; claims?: BillData['claims']; total?: number; rows?: BillData['rows'] } = {},
): BillData {
  return {
    bill: {
      id: 'bill-1',
      host_id: A,
      payer_id: over.payerId ?? A,
      join_code: 'code',
      created_at: BILL_AT,
      edited_at: null,
      extras_split: 'proportional',
      subtotal_cents: null,
      tax_cents: 500,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: over.total ?? 3600,
    },
    rows: over.rows ?? [billRow('burger', 'Burger', 1500, 0), billRow('salad', 'Salad', 1000, 1), billRow('fries', 'Fries', 600, 2)],
    participants: over.participants ?? [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ), member(D, 'Dee')],
    claims: over.claims ?? [cl('burger', A), cl('salad', B), cl('fries', A), cl('fries', B)],
    ...ledgerOf(over.participants ?? [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ), member(D, 'Dee')]),
  };
}

/**
 * Who paid (Task 5): fetchBill derives each member's mark and flag from bill_payments and
 * bill_payment_flags, so a fixture's marks are also ledger rows (one entry per mark, earlier key).
 */
function ledgerOf(participants: readonly Member[]): Pick<BillData, 'payers' | 'payments' | 'flags'> {
  return {
    payers: [],
    payments: participants.flatMap((p, i) =>
      p.mark === null
        ? []
        : [{ id: `10000000-0000-4000-8000-00000000000${i}`, fromId: p.userId, toId: p.mark.toUserId, cents: p.mark.cents, method: p.mark.method, planKey: null, at: p.mark.at }],
    ),
    flags: participants.flatMap((p) =>
      p.notReceived === null ? [] : [{ fromId: p.userId, toId: p.notReceived.toUserId, cents: p.notReceived.cents, method: p.notReceived.method }],
    ),
  };
}

/** The Settle page's planFor body before this task, copied verbatim so criterion 23 compares against it. */
function legacyInput(data: BillData, myId: string, platform: string): Omit<SettleViewInput, 'openedVenmo' | 'venmoOf' | 'itemNamesOf'> {
  const nameOf = makeNameOf(data.participants, myId);
  const marks = Object.fromEntries(data.participants.map((p) => [p.userId, p.mark]));
  // Task 6: the view now builds early plans, and carries the bill's split mode (SE-UX-8).
  const split = splitInputFor(data, data.claims);
  const plan = settlePlan(split, data.bill.payer_id, marks, { allowEarly: true });
  const payer = data.participants.find((p) => p.userId === data.bill.payer_id);
  const me = data.participants.find((p) => p.userId === myId);
  return {
    plan,
    nameOf,
    viewerId: myId,
    hostId: data.bill.host_id,
    payerId: data.bill.payer_id,
    extrasMode: split.extrasMode,
    payerVenmo: payer?.venmoUsername ?? null,
    viewerMarked: Boolean(me?.mark),
    platform,
    // The phone test is a device fact: false unless the screen passes it.
    mobileWeb: false,
    viewerItemNames: claimedItemNames(data.rows, data.claims, myId),
    // Sent via Venmo: the bill id and no device facts unless the screen passes them.
    billId: data.bill.id,
    rememberedMethod: null,
    sentCheck: null,
    permissionUndetermined: false,
  };
}

describe('settleViewInputFor (F1, criterion 23)', () => {
  const fixtures: [string, BillData][] = [
    ['worked', billData()],
    ['B marked', billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1510), member(D, 'Dee')] })],
    ['payer without Venmo', billData({ participants: [member(A, 'Hana'), member(B, 'Sam', TEJ), member(D, null)] })],
    ['payer is B', billData({ payerId: B })],
    ['early (salad unclaimed)', billData({ claims: [cl('burger', A), cl('fries', A), cl('fries', B)] })],
  ];

  it.each(fixtures)('%s: same input the Settle page built before, for every viewer and platform', (_name, data) => {
    for (const viewer of [A, B, D]) {
      for (const platform of ['ios', 'web']) {
        const opened = { payerId: A, cents: 1510 };
        const got = settleViewInputFor(data, viewer, platform, opened);
        const { nameOf, ...want } = legacyInput(data, viewer, platform);
        const { nameOf: gotNameOf, venmoOf, itemNamesOf, openedVenmo, ...rest } = got;
        // Who paid (Task 7): the same plan, plus the plan key and the payers mode.
        expect(rest).toEqual({ ...want, planKey: expect.stringMatching(/^[0-9a-f]{16}$/), payersMode: 'one' });
        expect(openedVenmo).toBe(opened);
        for (const id of [A, B, D, 'nobody', null]) expect(gotNameOf(id)).toBe(nameOf(id));
        for (const p of data.participants) {
          expect(venmoOf(p.userId)).toBe(p.venmoUsername);
          expect(itemNamesOf(p.userId)).toEqual(claimedItemNames(data.rows, data.claims, p.userId));
        }
        expect(venmoOf('nobody')).toBeNull();
        expect(itemNamesOf('nobody')).toEqual([]);
      }
    }
  });

  it('mobileWeb is a device fact: false by default, passed through when the screen gives it', () => {
    expect(settleViewInputFor(billData(), B, 'web', null).mobileWeb).toBe(false);
    expect(settleViewInputFor(billData(), B, 'web', null, { mobileWeb: true }).mobileWeb).toBe(true);
  });

  it('openedVenmo null passes through', () => {
    expect(settleViewInputFor(billData(), B, 'ios', null).openedVenmo).toBeNull();
  });
});

describe('settleFooterAction (F1, criteria 24–28)', () => {
  const PAY_URL = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries';
  const DETAILS = { label: 'Details', a11yLabel: 'Settle up details', a11yHint: "Shows who's paid and other ways to pay" };
  const F_F = { kind: 'settle', variant: 'primary', caption: null, a11yHint: 'See what you owe and pay' };
  const F_E = { kind: 'settle', variant: 'secondary', caption: 'Marked paid · $15.10', a11yHint: 'See who paid', tone: 'success', live: true };
  const inputFor = (data: BillData, viewer: string, platform = 'ios', opened: OpenedVenmoArg = null) => settleViewInputFor(data, viewer, platform, opened);
  type OpenedVenmoArg = { payerId: string; cents: number } | null;

  it('F-a: fewer than 2 participants → null', () => {
    const data = billData({ participants: [member(A, 'Hana', 'hana-1')], claims: [cl('burger', A), cl('salad', A), cl('fries', A)] });
    expect(settleFooterAction(inputFor(data, A), 1)).toBeNull();
    expect(settleFooterAction(inputFor(billData(), B), 1)).toBeNull();
  });

  it('F-b: items left and the viewer can\'t settle early (no item claim) → today\'s secondary "Settle up" + "1 item left to claim"', () => {
    const data = billData({ claims: [cl('burger', A), cl('fries', A), cl('fries', B)] });
    const got = settleFooterAction(inputFor(data, D), 3);
    expect(got).toEqual({ kind: 'settle', ...settleFooter(3, 1, 0) });
    expect(got).toMatchObject({ variant: 'secondary', caption: '1 item left to claim' });
  });

  it('F-c: the viewer owes → the Settle card\'s Pay button and notes, plus Details (criteria 25, 26)', () => {
    for (const platform of ['ios', 'web']) {
      const input = inputFor(billData(), B, platform);
      const got = settleFooterAction(input, 3);
      const cardModel = settleCard(input);
      expect(cardModel.state).toBe('owes');
      if (got?.kind !== 'pay') throw new Error('expected pay');
      expect(got.button.action).toEqual(cardModel.primary?.action);
      expect(got.button).toEqual(cardModel.primary);
      expect(got.button).toMatchObject({ label: 'Pay Hana $15.10 on Venmo', a11yHint: 'Opens Venmo and records it as sent' });
      expect(got.button.action.url).toBe(PAY_URL);
      expect(got.notes).toEqual(cardModel.notes);
      expect(got.details).toEqual(DETAILS);
      if (platform === 'web') expect(got.notes).toEqual(['@hana-1 · $15.10', 'On a computer? Send it from the Venmo app on your phone.']);
      else expect(got.notes).toEqual(['@hana-1 · $15.10']);
    }
  });

  it('F-d (contract O, A1): "Did you send Hana $15.10?" with Yes, I sent it (mark, venmo) and Not yet, plus Details', () => {
    const got = settleFooterAction(inputFor(billData(), B, 'ios', { payerId: A, cents: 1510 }), 3);
    expect(got).toEqual({
      kind: 'did_you_pay',
      text: 'Did you send Hana $15.10?',
      iPaid: {
        label: 'Yes, I sent it',
        a11yLabel: 'Yes, I sent it',
        a11yHint: 'Records your $15.10 to Hana as sent',
        // The plan key it was opened under (who paid A1.2), for mark_paid's p_plan_key.
        action: { kind: 'mark', method: 'venmo', payerId: A, cents: 1510, confirmsSend: true, planKey: expect.stringMatching(/^[0-9a-f]{16}$/) },
      },
      notYet: { label: 'Not yet', a11yLabel: 'Not yet' },
      details: DETAILS,
    });
  });

  it('F-e (A1, SV-UX-12): marked → secondary "Settle up" + "Marked paid · $15.10"', () => {
    const data = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1510), member(D, 'Dee')] });
    expect(settleFooterAction(inputFor(data, B), 3)).toEqual(F_E);
  });

  describe('F-f: everything else is today\'s primary "Settle up"', () => {
    it('viewer is the payer', () => {
      expect(settleFooterAction(inputFor(billData(), A), 3)).toEqual(F_F);
    });
    it('nothing owed', () => {
      expect(settleFooterAction(inputFor(billData(), D), 3)).toEqual(F_F);
    });
    it('negative share', () => {
      // A negative share needs a bill-level discount in even mode; swap that plan into a real view input.
      const plan = settlePlan(
        { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
        A,
        {},
      );
      const input = { ...inputFor(billData(), B), plan };
      expect(settleCard(input).state).toBe('negative');
      expect(settleFooterAction(input, 2)).toEqual(F_F);
    });
    it('marked, share changed (Task 6: a difference caption, still primary "Settle up")', () => {
      const data = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1400), member(D, 'Dee')] });
      expect(settleCard(inputFor(data, B)).state).toBe('more_due');
      expect(settleFooterAction(inputFor(data, B), 3)).toEqual({ ...F_F, caption: 'You owe Hana $1.10 more', a11yHint: 'See the difference and settle it' });
    });
    it('payer has no Venmo (null) or an invalid one (\'ab\') → A1: the cash footer (SV-UX-10)', () => {
      for (const v of [null, 'ab']) {
        const data = billData({ participants: [member(A, 'Hana', v), member(B, 'Sam', TEJ), member(D, 'Dee')] });
        expect(settleCard(inputFor(data, B)).state).toBe('owes_no_venmo');
        expect(settleFooterAction(inputFor(data, B), 3)).toMatchObject({ kind: 'cash', button: { label: 'I paid Hana $15.10 in cash' } });
      }
    });
    it('blocked_all_zero', () => {
      const input = { ...inputFor(billData(), B), plan: { status: 'blocked_all_zero' as const } };
      expect(settleFooterAction(input, 3)).toEqual(F_F);
    });
    it('bad payer', () => {
      const data = billData({ payerId: 'gone' });
      expect(settleCard(inputFor(data, B)).state).toBe('bad_payer');
      expect(settleFooterAction(inputFor(data, B), 3)).toEqual(F_F);
    });
  });

  it('criterion 27: amount boundaries 1¢ and 99,999,999¢ → F-c; 100,000,000¢ → the cash footer (A1)', () => {
    const one = (cents: number) => {
      const data = billData({ total: cents, claims: [cl('salad', B)] });
      data.rows = [billRow('salad', 'Salad', cents, 0)];
      return settleFooterAction(inputFor(data, B), 3);
    };
    const low = one(1);
    expect(low?.kind).toBe('pay');
    if (low?.kind === 'pay') expect(low.button.action.url).toContain('amount=0.01&');
    const high = one(99_999_999);
    expect(high?.kind).toBe('pay');
    if (high?.kind === 'pay') expect(high.button.action.url).toContain('amount=999999.99&');
    // Over the link cap there's no Venmo: A1 offers the cash footer for the same amount. A bill total
    // of $1,000,000.00 is outside bills_total_cents_range (payersState refuses it, who-paid Task 6),
    // so this one is built from settlePlan directly, as the view would get it.
    const over = settlePlan(
      { totalCents: 100_000_000, items: [{ id: 'salad', totalCents: 100_000_000 }], claims: [c('salad', B)], participantIds: [A, B, D], extrasMode: 'proportional' },
      A,
      {},
    );
    expect(settleFooterAction(view(over, B), 3)).toMatchObject({ kind: 'cash', button: { action: { kind: 'mark', method: 'cash', cents: 100_000_000 } } });
  });

  it('criterion 28: F-d only while the opened payer and amount still match', () => {
    const opened = { payerId: A, cents: 1510 };
    expect(settleFooterAction(inputFor(billData(), B, 'ios', opened), 3)?.kind).toBe('did_you_pay');
    // Payer changed to D (no Venmo) → the cash footer (A1); payer changed but Venmo valid → F-c, never F-d.
    const toD = billData({ payerId: D });
    expect(settleFooterAction(inputFor(toD, B, 'ios', opened), 3)?.kind).toBe('cash');
    const toDWithVenmo = billData({ payerId: D, participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ), member(D, 'Dee', 'dee-12345')] });
    expect(settleFooterAction(inputFor(toDWithVenmo, B, 'ios', opened), 3)?.kind).toBe('pay');
    // Contract O (criterion 59): the share changed (tax up) → still F-d, at the opened amount.
    const bigger = billData({ total: 3700 });
    const kept = settleFooterAction(inputFor(bigger, B, 'ios', opened), 3);
    expect(kept?.kind).toBe('did_you_pay');
    if (kept?.kind === 'did_you_pay') expect(kept.iPaid.action).toEqual({ kind: 'mark', method: 'venmo', payerId: A, cents: 1510, confirmsSend: true, planKey: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // Opened with a different amount → F-d with that amount.
    const other = settleFooterAction(inputFor(billData(), B, 'ios', { payerId: A, cents: 1400 }), 3);
    expect(other?.kind === 'did_you_pay' && other.iPaid.action.cents).toBe(1400);
    // The viewer is now marked → the prompt is gone (F-e).
    const marked = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1510), member(D, 'Dee')] });
    expect(settleFooterAction(inputFor(marked, B, 'ios', opened), 3)).toEqual(F_E);
  });
});

describe('billFooterAction (bill screen footer, VR-I6)', () => {
  const PAY: SettleFooterAction = {
    kind: 'pay',
    button: { label: 'Pay Hana $15.10 on Venmo', a11yLabel: 'x', action: { kind: 'pay', method: 'venmo', url: 'u', payerId: A, cents: 1510 } },
    notes: ['@hana-1 · $15.10'],
    details: { label: 'Details', a11yLabel: 'Settle up details', a11yHint: 'h' },
  };
  const BLOCKED: SettleFooterAction = { kind: 'settle', variant: 'secondary', caption: '1 item left to claim', a11yHint: '1 item left to claim first', incomplete: true };

  it('null stays null (fewer than 2 people)', () => {
    expect(billFooterAction(null, 0, 0)).toBeNull();
    expect(billFooterAction(null, 3, 1)).toBeNull();
  });

  it('server ready, nothing left on screen: the server footer as is', () => {
    expect(billFooterAction(PAY, 0, 0)).toBe(PAY);
  });

  it('the viewer just unclaimed something (optimistic): "N left to claim" at once, never a Pay with a stale amount', () => {
    expect(billFooterAction(PAY, 1, 0)).toEqual({ kind: 'settle', ...settleFooter(2, 1, 0) });
    expect(billFooterAction(PAY, 2, 1)).toEqual({ kind: 'settle', ...settleFooter(2, 2, 1) });
  });

  it('counts follow the screen while the server is behind', () => {
    expect(billFooterAction(BLOCKED, 3, 0)).toEqual({ kind: 'settle', ...settleFooter(2, 3, 0) });
  });

  it('the viewer just claimed the last item (server still blocked): today\'s primary "Settle up", no count', () => {
    expect(billFooterAction(BLOCKED, 0, 0)).toEqual({ kind: 'settle', ...settleFooter(2, 0, 0) });
  });
});

describe('open-failed lines follow the bill (review R2)', () => {
  it('payOpenFailedLine: shown while payer, amount and username match; gone after any of them changes', () => {
    const input = settleViewInputFor(billData(), B, 'ios', null);
    const owed = settleFooterAction(input, 3);
    if (owed?.kind !== 'pay') throw new Error('expected pay');
    const failure = { payerId: A, cents: owed.button.action.cents, handle: 'hana-1' };
    expect(payOpenFailedLine(input, failure)).toBe(`Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.`);
    expect(payOpenFailedLine(input, null)).toBeNull();
    expect(payOpenFailedLine(input, { ...failure, cents: 1620 })).toBeNull();
    expect(payOpenFailedLine(input, { ...failure, payerId: D })).toBeNull();
    expect(payOpenFailedLine(input, { ...failure, handle: 'hana-2' })).toBeNull();
    expect(payOpenFailedLine({ ...input, payerVenmo: 'hana-2' }, failure)).toBeNull();
  });

  it('requestOpenFailedLine: shown while that row offers the same request', () => {
    const people = settlePeople(view(oneOwer(1510), A, { venmoOf: () => TEJ }));
    const failure = { userId: B, cents: 1510, handle: TEJ };
    expect(requestOpenFailedLine(people, failure)).toBe(requestOpenFailedText(TEJ, 1510));
    expect(requestOpenFailedLine(people, null)).toBeNull();
    expect(requestOpenFailedLine(people, { ...failure, cents: 1620 })).toBeNull();
    expect(requestOpenFailedLine(people, { ...failure, handle: 'Other-Name' })).toBeNull();
    expect(requestOpenFailedLine(settlePeople(view(oneOwer(1510, { B: mk(1510) }), A, { venmoOf: () => TEJ })), failure)).toBeNull();
    expect(requestOpenFailedLine(null, failure)).toBeNull();
  });
});

describe('saveRefreshFailed (review R1)', () => {
  it('true only when a saved change\'s refetch finished without landing', () => {
    expect(saveRefreshFailed([], 3, 3)).toBe(false);
    expect(saveRefreshFailed([null], 3, 5)).toBe(false); // still saving
    expect(saveRefreshFailed([4], 3, 3)).toBe(false); // refetch not finished yet
    expect(saveRefreshFailed([4], 3, 4)).toBe(true); // finished, failed
    expect(saveRefreshFailed([4], 4, 4)).toBe(false); // landed
    expect(saveRefreshFailed([null, 6, 4], 3, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Settle early and differences, Task 6 (docs/specs/2026-11-25-settle-early-and-differences.md, A1)
// ---------------------------------------------------------------------------

/** Every string anywhere inside a model (for the glyph walk, criterion 66). */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

/** The worked example plus an unclaimed Dessert, proportional (criterion 26): an early plan. */
function earlyWorked(marks: SettleMarks = {}, extra: Partial<SplitInput> = {}): SettlePlanWithEarly {
  return settlePlan(
    {
      totalCents: 4400,
      items: [
        { id: 'burger', totalCents: 1500 },
        { id: 'salad', totalCents: 1000 },
        { id: 'fries', totalCents: 600 },
        { id: 'dessert', totalCents: 800 },
      ],
      claims: [c('burger', A), c('salad', B), c('fries', A), c('fries', B)],
      participantIds: [A, B, D],
      extrasMode: 'proportional',
      ...extra,
    },
    A,
    marks,
    { allowEarly: true },
  );
}

/** B owes exactly `cents` with one unclaimed $5 row left: an early plan, payer A. */
function bOwesEarly(cents: number, marks: SettleMarks = {}): SettlePlanWithEarly {
  return settlePlan(
    {
      totalCents: 1500 + cents,
      items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: cents }, { id: 'u', totalCents: 500 }],
      claims: [c('a', A), c('b', B)],
      participantIds: [A, B, D],
      extrasMode: 'proportional',
    },
    A,
    marks,
    { allowEarly: true },
  );
}

const owedOf = (plan: SettlePlanWithEarly, userId: string): number => {
  if (plan.status !== 'ready' && plan.status !== 'early') throw new Error('no amounts');
  const e = plan.people.find((p) => p.userId === userId);
  if (!e || e.role === 'payer') throw new Error('not an ower');
  return e.owedCents;
};
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`; // test-only, positive amounts

describe('early cards (criterion 26)', () => {
  const plan = earlyWorked();
  const share = owedOf(plan, B);
  const MAY = 'Your share may change until everything is claimed (1 item left).';

  it('the plan is early, and Sam unmarked sees You owe Hana, the early amount, Pay with the ready-card URL, and the may-change line', () => {
    expect(plan.status).toBe('early');
    const m = settleCard(view(plan, B, { viewerItemNames: ['Salad', 'Fries'] }));
    expect(m).toMatchObject({ state: 'owes', label: 'You owe Hana', amountCents: share, lines: [{ text: MAY, tone: 'muted' }] });
    expect(m.primary).toMatchObject({
      label: `Pay Hana ${money(share)} on Venmo`,
      action: { kind: 'pay', method: 'venmo', url: venmoPayUrl({ username: 'hana-1', cents: share, itemNames: ['Salad', 'Fries'] }), payerId: A, cents: share },
    });
    expect(m.secondary.map((b) => b.label)).toEqual(['Paid another way']);
  });

  it('after Pay and without Venmo, the may-change line stays (last in the head group)', () => {
    expect(settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: share } }))).toMatchObject({ state: 'owes_opened', lines: [{ text: MAY }] });
    expect(settleCard(view(plan, B, { payerVenmo: null })).lines.map((l) => l.text)).toEqual([
      "Hana hasn't added Venmo yet.",
      MAY,
    ]);
  });

  it('counts: 2 items, 1 discount, 2 items and 1 discount', () => {
    const line = (rows: number, discounts: number) =>
      settleCard(view({ ...(plan as Extract<SettlePlanWithEarly, { status: 'early' }>), unclaimedRows: rows, unclaimedDiscountRows: discounts }, B)).lines[0]?.text;
    expect(line(2, 0)).toBe('Your share may change until everything is claimed (2 items left).');
    expect(line(1, 1)).toBe('Your share may change until everything is claimed (1 discount left).');
    expect(line(3, 1)).toBe('Your share may change until everything is claimed (2 items and 1 discount left).');
  });

  it('Sam with no item claim: Not ready yet, no amount, Back to the bill', () => {
    const noClaim = earlyWorked({}, { claims: [c('burger', A), c('fries', A)] });
    expect(settleCard(view(noClaim, B))).toEqual({
      state: 'early_not_ready',
      label: 'Not ready yet',
      amountCents: null,
      lines: [{ text: 'Claim what you had on the bill, then come back to pay.', tone: 'muted' }],
      chooser: null,
      primary: { label: 'Back to the bill', a11yLabel: 'Back to the bill', action: { kind: 'back' } },
      notes: [],
      secondary: [],
      check: null,
    });
  });

  it('nothing (a $0 item, E4) and negative early cards add the may-change line', () => {
    const zero = earlyWorked({}, { items: [{ id: 'burger', totalCents: 1500 }, { id: 'salad', totalCents: 0 }, { id: 'fries', totalCents: 600 }, { id: 'dessert', totalCents: 800 }], claims: [c('burger', A), c('salad', B)] });
    expect(settleCard(view(zero, B))).toMatchObject({ state: 'nothing', lines: [{ text: "You don't owe anything on this bill." }, { text: 'Your share may change until everything is claimed (2 items left).' }] });
    // A claimed discount bigger than Sam's item makes his early share negative (CD-6).
    const neg = settlePlan(
      {
        totalCents: 1400,
        items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 100 }, { id: 'off', totalCents: -200, kind: 'discount' }, { id: 'u', totalCents: 500 }],
        claims: [c('a', A), c('b', B), c('off', B)],
        participantIds: [A, B],
        extrasMode: 'proportional',
      },
      A,
      {},
      { allowEarly: true },
    );
    expect(settleCard(view(neg, B))).toMatchObject({ state: 'negative', label: 'Hana owes you', amountCents: 100, lines: [{ text: 'Settle that outside the app.' }, { text: MAY }] });
  });

  it('payer: Waiting for everyone to claim, no amount, left line, and paid-so-far only when someone is marked (1 and 2)', () => {
    expect(settleCard(view(plan, A))).toEqual({
      state: 'payer_early',
      label: 'Waiting for everyone to claim',
      amountCents: null,
      lines: [{ text: '1 item left to claim', tone: 'muted' }],
      chooser: null,
      primary: null,
      notes: [],
      secondary: [],
      check: null,
    });
    expect(settleCard(view(earlyWorked({ B: mk(share) }), A)).lines).toEqual([
      { text: '1 item left to claim', tone: 'muted' },
      { text: '1 settled up so far', tone: 'muted', live: true },
    ]);
    const two = earlyWorked({ B: mk(share), D: mk(100) }, { claims: [c('burger', A), c('salad', B), c('fries', D)] });
    expect(settleCard(view(two, A)).lines[1]?.text).toBe('2 settled up so far');
  });

  it('marked early, no difference: Marked paid plus the settle-later line, plain Undo', () => {
    const m = settleCard(view(earlyWorked({ B: mk(share) }), B));
    expect(m).toMatchObject({
      state: 'marked',
      label: 'You paid Hana',
      amountCents: share,
      lines: [
        { text: 'Marked paid', tone: 'success', live: true },
        { text: "If your share changes, you'll settle the difference here once everything is claimed.", tone: 'muted' },
      ],
    });
    expect(m.secondary.map((b) => b.label)).toEqual(['Undo']);
  });

  it('addVenmoPrompt on early: shown to a payer without Venmo once someone can settle; null when nobody can; ready unchanged', () => {
    expect(addVenmoPrompt(view(plan, A, { payerVenmo: null }))?.text).toBe('Add your Venmo so people can pay you');
    expect(addVenmoPrompt(view(plan, A))).toBeNull();
    expect(addVenmoPrompt(view(plan, B, { payerVenmo: null }))).toBeNull();
    const nobody = earlyWorked({}, { claims: [c('burger', A)] });
    expect(addVenmoPrompt(view(nobody, A, { payerVenmo: null }))).toBeNull();
    expect(addVenmoPrompt(view(three(), A, { payerVenmo: null }))).not.toBeNull();
  });
});

describe('early cards with a difference (criterion 27)', () => {
  const mark = { B: mk(1510) };
  it('more, back, and a share below $0 (amount capped at the mark), each muted', () => {
    const line = (plan: SettlePlanWithEarly) => settleCard(view(plan, B)).lines[1];
    expect(line(bOwesEarly(1620, mark))).toEqual({ text: "Your share is now $16.20. You'll pay the $1.10 difference once everything is claimed.", tone: 'muted' });
    expect(line(bOwesEarly(1400, mark))).toEqual({ text: 'Your share is now $14.00. Hana will owe you $1.10 back once everything is claimed.', tone: 'muted' });
    const negative: SettlePlanWithEarly = {
      status: 'early',
      payerId: A,
      unclaimedRows: 1,
      unclaimedDiscountRows: 0,
      people: [
        { userId: A, role: 'payer', mark: null, notReceived: null },
        { userId: B, role: 'payer_owes_them', owedCents: -100, mark: mark.B, notReceived: null, canSettle: true, difference: differenceFor(-100, 1510) },
      ],
    };
    expect(line(negative)).toEqual({ text: 'Your share is now -$1.00. Hana will owe you $15.10 back once everything is claimed.', tone: 'muted' });
    expect(settleCard(view(negative, B)).state).toBe('marked');
  });

  it('no difference action anywhere in early models (card, rows, footer)', () => {
    for (const plan of [bOwesEarly(1620, mark), bOwesEarly(1400, mark)]) {
      for (const viewer of [A, B, D]) {
        const input = view(plan, viewer, { venmoOf: () => 'some-one' });
        const all = JSON.stringify([settleCard(input), settlePeople(input), settleFooterAction(input, 3)]);
        for (const kind of ['pay_difference', 'mark_difference', 'request', 'pay_back']) expect(all).not.toContain(`"kind":"${kind}"`);
        expect(settlePeople(input)?.rows.every((r) => r.request === null && r.payBack === null)).toBe(true);
      }
    }
  });
});

describe('ready more_due / more_opened (criterion 28)', () => {
  const mark = { B: mk(1510) };
  const items = ['Salad', 'Fries'];

  it('more_due: label, amount, line, chooser, Pay more, notes, I paid the difference, Undo all (A1)', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { viewerItemNames: items, platform: 'web' }));
    expect(m).toEqual({
      state: 'more_due',
      label: 'You owe Hana more',
      amountCents: 110,
      lines: [{ text: "Your share is now $16.20. You've paid $15.10.", tone: 'muted' }],
      chooser: {
        options: [
          { value: 'venmo', label: 'Venmo', a11yLabel: "Venmo, how you're paying" },
          { value: 'cash', label: 'Cash', a11yLabel: "Cash, how you're paying" },
        ],
        value: 'venmo',
        a11yLabel: "How you're paying",
      },
      primary: {
        label: 'Pay Hana $1.10 more on Venmo',
        a11yLabel: 'Pay Hana $1.10 more on Venmo, to @hana-1',
        a11yHint: 'Opens Venmo and records it as sent',
        action: {
          kind: 'pay_difference',
          method: 'venmo',
          url: venmoPayUrl({ username: 'hana-1', cents: 110, itemNames: items }),
          payerId: A,
          cents: 110,
          fromCents: 1510,
          toCents: 1620,
        },
      },
      notes: ['@hana-1 · $1.10', 'On a computer? Send it from the Venmo app on your phone.'],
      secondary: [
        {
          label: 'I paid the difference',
          a11yLabel: 'I paid the difference',
          a11yHint: 'Records the $1.10 difference as paid another way',
          action: { kind: 'mark_difference', method: 'other', userId: B, payerId: A, fromCents: 1510, toCents: 1620 },
        },
        { label: "$15.10 payment didn\'t go through", a11yLabel: "$15.10 payment didn\'t go through", a11yHint: 'Clears your whole $15.10 payment, not just the difference', action: { kind: 'unmark', userId: B } },
      ],
      check: null,
    });
  });

  it('more_due, payer without Venmo (A1): the no-Venmo line, the cash primary, I paid the difference, Undo all', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { payerVenmo: null }));
    expect(m.lines.map((l) => l.text)).toEqual(["Your share is now $16.20. You've paid $15.10.", "Hana hasn't added Venmo yet."]);
    expect(m.primary).toMatchObject({ label: 'I paid the $1.10 in cash', action: { kind: 'mark_difference', method: 'cash', fromCents: 1510, toCents: 1620 } });
    expect(m.secondary.map((b) => b.label)).toEqual(['I paid the difference', "$15.10 payment didn\'t go through"]);
    expect(m.notes).toEqual([]);
  });

  const opened: OpenedVenmo = { kind: 'more', payerId: A, cents: 110, fromCents: 1510 };
  it('more_opened (A1): Did you send Hana $1.10?, records 1510 → 1620 as venmo, Open Venmo again', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'more_opened', label: 'Did you send Hana $1.10?', amountCents: 110, lines: [], notes: ['@hana-1 · $1.10'] });
    expect(m.primary).toMatchObject({ label: 'Yes, I sent it', action: { kind: 'mark_difference', method: 'venmo', userId: B, payerId: A, fromCents: 1510, toCents: 1620 } });
    expect(m.secondary).toEqual([
      {
        label: 'Open Venmo again',
        a11yLabel: 'Open Venmo again',
        a11yHint: 'Opens Venmo',
        action: { kind: 'pay_difference', method: 'venmo', url: venmoPayUrl({ username: 'hana-1', cents: 110 }), payerId: A, cents: 110, fromCents: 1510, toCents: 1620 },
      },
    ]);
  });

  it('contract O: the share moved to 1700 with the mark still 1510 → still more_opened at $1.10, recording 1510 → 1620', () => {
    const m = settleCard(view(bOwesReady(1700, mark), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'more_opened', amountCents: 110, primary: { action: { fromCents: 1510, toCents: 1620 } } });
  });

  it('dropped when the mark is now 1620, the payer changed, or the plan is not ready', () => {
    expect(settleCard(view(bOwesReady(1620, { B: mk(1620) }), B, { openedVenmo: opened })).state).toBe('marked');
    expect(settleCard(view(bOwesReady(1620, mark), B, { openedVenmo: { ...opened, payerId: D } })).state).toBe('more_due');
    expect(settleCard(view(bOwesEarly(1620, mark), B, { openedVenmo: opened })).state).toBe('marked');
    expect(openedStillMatches(bOwesEarly(1620, mark), B, opened)).toBe(false);
    expect(openedStillMatches(bOwesReady(1700, mark), B, opened)).toBe(true);
  });
});

describe('ready back_due (criterion 29)', () => {
  const mark = { B: mk(1510) };
  const items = ['Salad'];

  it('back_due: Hana owes you, $1.10, outlined Request block button, never writes, Undo "I paid"', () => {
    const m = settleCard(view(bOwesReady(1400, mark), B, { viewerItemNames: items, platform: 'web' }));
    expect(m).toEqual({
      state: 'back_due',
      label: 'Hana owes you',
      amountCents: 110,
      lines: [{ text: "Your share is now $14.00. You've paid $15.10.", tone: 'muted' }],
      primary: {
        label: 'Request $1.10 from Hana on Venmo',
        a11yLabel: 'Request $1.10 from Hana on Venmo, @hana-1',
        a11yHint: 'Opens Venmo',
        variant: 'secondary',
        action: { kind: 'request', url: venmoRequestUrl({ username: 'hana-1', cents: 110, itemNames: items }) },
      },
      notes: ['@hana-1 · $1.10', 'On a computer? Send requests from the Venmo app on your phone.'],
      chooser: null,
      secondary: [{ label: "$15.10 payment didn\'t go through", a11yLabel: "$15.10 payment didn\'t go through", a11yHint: 'Clears your whole $15.10 payment, not just the difference', action: { kind: 'unmark', userId: B } }],
      check: null,
    });
    expect(JSON.stringify(m)).not.toContain('mark_difference');
  });

  it('back_due on mobile web: the handle line only, no "On a computer?" line', () => {
    const m = settleCard(view(bOwesReady(1400, mark), B, { viewerItemNames: items, platform: 'web', mobileWeb: true }));
    expect(m.notes).toEqual(['@hana-1 · $1.10']);
  });

  it('payer without Venmo: Ask Hana to pay you back., no request action', () => {
    const m = settleCard(view(bOwesReady(1400, mark), B, { payerVenmo: null }));
    expect(m.lines.map((l) => l.text)).toEqual(["Your share is now $14.00. You've paid $15.10.", 'Ask Hana to pay you back.']);
    expect(m.primary).toBeNull();
    expect(m.secondary.map((b) => b.label)).toEqual(["$15.10 payment didn\'t go through"]);
  });

  it('share −100: the extra outside-the-app line; amount capped at the mark', () => {
    const neg = settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
      A,
      mark,
    );
    expect(settleCard(view(neg, B))).toMatchObject({
      state: 'back_due',
      amountCents: 1510,
      lines: [
        { text: "Your share is now -$1.00. You've paid $15.10.", tone: 'muted' },
        { text: 'Hana also owes you $1.00 for your share. Settle that outside the app.', tone: 'muted' },
      ],
    });
  });

  it('after D3/D4 (mark cleared): 3.6 or 3.7, no Undo and no paid-back line', () => {
    const zero = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, {});
    expect(settleCard(view(zero, B))).toMatchObject({ state: 'nothing', secondary: [], lines: [{ text: "You don't owe anything on this bill." }] });
    const neg = settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
      A,
      {},
    );
    expect(settleCard(view(neg, B))).toMatchObject({ state: 'negative', secondary: [], lines: [{ text: 'Settle that outside the app.' }] });
  });
});

describe('even-mode blocked line (SE-UX-8)', () => {
  it('a blocked equal-mode bill says why; proportional blocked bills (allowEarly off) do not', () => {
    const plan: SettlePlan = { status: 'blocked', unclaimedRows: 3, unclaimedDiscountRows: 0 };
    expect(settleCard(view(plan, B, { extrasMode: 'equal', viewerMarked: true })).lines.map((l) => l.text)).toEqual([
      'You can settle up once every item is claimed (3 items left).',
      "Tax and tip are split evenly on this bill, so shares aren't set until then.",
      'Your "I paid" is saved.',
    ]);
    expect(settleCard(view(plan, B)).lines).toHaveLength(1);
  });
});

/** Payer A; Sam (B) owes 1620, Ana (E) owes 1400, Dee (D) owes 500; no extras. */
function rowsPlan(marks: SettleMarks): SettlePlan {
  return settlePlan(
    {
      totalCents: 4520,
      items: [
        { id: 'a', totalCents: 1000 },
        { id: 'b', totalCents: 1620 },
        { id: 'e', totalCents: 1400 },
        { id: 'd', totalCents: 500 },
      ],
      claims: [c('a', A), c('b', B), c('e', E), c('d', D)],
      participantIds: [A, B, D, E],
      extrasMode: 'proportional',
    },
    A,
    marks,
  );
}
const VENMO: Record<string, string> = { [B]: 'sam-1', [E]: 'ana-1', [D]: 'dee-12' };
const ITEMS: Record<string, readonly string[]> = { [B]: ['Pad Thai'], [E]: ['Soup'], [D]: ['Beer'] };
const rowsInput = (marks: SettleMarks, viewerId: string, hostId: string, over: Partial<SettleViewInput> = {}) =>
  view(rowsPlan(marks), viewerId, { hostId, venmoOf: (id) => VENMO[id] ?? null, itemNamesOf: (id) => ITEMS[id] ?? [], ...over });
const DIFF_MARKS: SettleMarks = { B: mk(1510), E: mk(1510) };
const row = (people: SettlePeopleModel | null, id: string) => {
  const r = people?.rows.find((x) => x.userId === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe('rows with differences (criterion 30)', () => {
  it('payer (not host): more due → status, muted sub-line, Request $1.10, no Undo', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, A, D));
    expect(row(people, B)).toEqual({
      userId: B,
      name: 'Sam',
      amountCents: 1620,
      status: { text: 'Owes $1.10 more', tone: 'muted' },
      subLine: { text: 'Marked $15.10 · share now $16.20', tone: 'muted' },
      a11yLabel: 'Sam, marked paid $15.10, share is now $16.20, owes $1.10 more',
      undo: null,
      // A1 (SV-10): Not received replaces the payer's Undo, difference rows included.
      notReceived: expect.objectContaining({
        a11yLabel: "Not received, Sam's $15.10",
        action: { kind: 'not_received', userId: B, payerId: A, expectedCents: 1510, expectedAt: at },
      }),
      request: {
        kind: 'link',
        userId: B,
        url: venmoRequestUrl({ username: 'sam-1', cents: 110, itemNames: ['Pad Thai'] }),
        cents: 110,
        handle: 'sam-1',
        caption: '@sam-1',
        label: 'Request $1.10',
        a11yLabel: 'Request $1.10 more from Sam on Venmo, @sam-1',
        a11yHint: 'Opens Venmo',
      },
      payBack: null,
    });
  });

  it('payer (not host): back due → warning status, Pay $1.10 back, I paid it back, no Undo', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, A, D));
    expect(row(people, E)).toEqual({
      userId: E,
      name: 'Ana',
      amountCents: 1400,
      status: { text: 'You owe $1.10 back', tone: 'warning' },
      subLine: { text: 'Marked $15.10 · share now $14.00', tone: 'muted' },
      a11yLabel: 'Ana, marked paid $15.10, share is now $14.00, you owe Ana $1.10 back',
      undo: null,
      notReceived: expect.objectContaining({ a11yLabel: "Not received, Ana's $15.10" }),
      request: null,
      payBack: {
        link: {
          kind: 'link',
          userId: E,
          url: venmoPayUrl({ username: 'ana-1', cents: 110, itemNames: ['Soup'] }),
          cents: 110,
          handle: 'ana-1',
          caption: '@ana-1',
          label: 'Pay $1.10 back',
          a11yLabel: 'Pay Ana $1.10 back on Venmo, to @ana-1',
          a11yHint: 'Opens Venmo',
        },
        record: {
          label: 'I paid it back',
          a11yLabel: 'Mark that you paid Ana $1.10 back',
          a11yHint: "Changes Ana's I paid to $14.00",
          action: { kind: 'mark_difference', method: 'other', userId: E, payerId: A, fromCents: 1510, toCents: 1400 },
        },
      },
    });
  });

  it('pay-back to $0 (D3): toCents 0 and the Clears hint', () => {
    const plan = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, { B: mk(1510) });
    const r = row(settlePeople(view(plan, A, { hostId: D, venmoOf: () => 'sam-1' })), B);
    expect(r.payBack?.record).toMatchObject({ a11yHint: "Clears Sam's I paid", action: { fromCents: 1510, toCents: 0 } });
    expect(r.payBack?.link).toMatchObject({ kind: 'link', cents: 1510 });
  });

  it('pay-back captions: no username → Hasn\'t added Venmo (I paid it back stays); more-due row the same caption', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, A, D, { venmoOf: () => null }));
    expect(row(people, E).payBack?.link).toEqual({ kind: 'caption', caption: "Hasn't added Venmo" });
    expect(row(people, E).payBack?.record.label).toBe('I paid it back');
    expect(row(people, B).request).toEqual({ kind: 'caption', caption: "Hasn't added Venmo" });
  });

  it('pay-back over the link cap → Pay it back in the Venmo app', () => {
    const big = 100_000_100;
    const plan = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, { B: mk(big) });
    expect(row(settlePeople(view(plan, A, { venmoOf: () => 'sam-1' })), B).payBack?.link).toEqual({ kind: 'caption', caption: 'Pay it back in the Venmo app' });
  });

  it('host-payer (A1, SV-10): the same controls plus Not received, never Undo', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, A, A));
    expect(row(people, B).undo).toBeNull();
    expect(row(people, E).undo).toBeNull();
    expect(row(people, B).notReceived?.action).toMatchObject({ userId: B, expectedCents: 1510 });
    expect(row(people, E).notReceived?.action).toMatchObject({ userId: E, expectedCents: 1510 });
    expect(row(people, B).request).toMatchObject({ kind: 'link' });
    expect(row(people, E).payBack).not.toBeNull();
  });

  it('host-not-payer: statuses, Undo, no difference actions', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, D, D));
    expect(row(people, B)).toMatchObject({ status: { text: 'Owes $1.10 more', tone: 'muted' }, request: null, payBack: null });
    expect(row(people, B).undo).not.toBeNull();
    expect(row(people, E)).toMatchObject({
      status: { text: 'Hana owes $1.10 back', tone: 'muted' },
      a11yLabel: 'Ana, marked paid $15.10, share is now $14.00, Hana owes Ana $1.10 back',
      request: null,
      payBack: null,
    });
    expect(row(people, E).undo).not.toBeNull();
  });

  it('other owers: statuses, no actions; own rows in the second person', () => {
    const fromB = settlePeople(rowsInput(DIFF_MARKS, B, D));
    expect(fromB?.rows[0]).toMatchObject({
      userId: B,
      name: 'You',
      status: { text: 'You owe $1.10 more', tone: 'muted' },
      a11yLabel: 'You, marked paid $15.10, share is now $16.20, you owe $1.10 more',
      undo: null,
      request: null,
      payBack: null,
    });
    expect(row(fromB, E)).toMatchObject({ status: { text: 'Hana owes $1.10 back' }, undo: null, request: null, payBack: null });
    const fromE = settlePeople(rowsInput(DIFF_MARKS, E, D));
    expect(fromE?.rows[0]).toMatchObject({
      status: { text: 'Hana owes you $1.10 back', tone: 'muted' },
      a11yLabel: 'You, marked paid $15.10, share is now $14.00, Hana owes you $1.10 back',
    });
  });

  it('once the difference is settled the row is Paid (success) with the payer\'s Not received (A1)', () => {
    const people = settlePeople(rowsInput({ B: mk(1620), E: mk(1400) }, A, D));
    expect(row(people, B)).toMatchObject({ status: { text: 'Paid', tone: 'success' }, subLine: null, payBack: null, request: null, undo: null });
    expect(row(people, B).notReceived?.action).toMatchObject({ expectedCents: 1620 });
  });

  it('wideStatus: true with any difference or method status row (A1, visual §4.1), false without', () => {
    expect(settlePeople(rowsInput(DIFF_MARKS, A, D))?.wideStatus).toBe(true);
    expect(settlePeople(rowsInput({ B: mk(1510) }, A, D))?.wideStatus).toBe(true);
    expect(settlePeople(rowsInput({}, A, D))?.wideStatus).toBe(false);
    expect(settlePeople(rowsInput({ B: mk(1620) }, A, D))?.wideStatus).toBe(true); // "Paid" is a method status
    expect(settlePeople(view(bOwesEarly(1620, { B: mk(1510) }), A))?.wideStatus).toBe(true);
  });

  it('list web line: pay-or-request when a pay-back link exists, else the request line', () => {
    const web = (input: SettleViewInput) => settleRequestWebLine(input, settlePeople(input));
    expect(web(rowsInput(DIFF_MARKS, A, D, { platform: 'web' }))).toBe('On a computer? Open Venmo on your phone to pay or request.');
    expect(web(rowsInput({ B: mk(1510) }, A, D, { platform: 'web' }))).toBe('On a computer? Send requests from the Venmo app on your phone.');
    expect(web(rowsInput(DIFF_MARKS, A, D))).toBeNull();
    // Mobile web: neither line (both start "On a computer?").
    expect(web(rowsInput(DIFF_MARKS, A, D, { platform: 'web', mobileWeb: true }))).toBeNull();
    expect(web(rowsInput({ B: mk(1510) }, A, D, { platform: 'web', mobileWeb: true }))).toBeNull();
  });

  it('no row status reads Paid back', () => {
    for (const viewer of [A, B, D, E]) {
      for (const r of settlePeople(rowsInput(DIFF_MARKS, viewer, D))?.rows ?? []) expect(r.status?.text).not.toMatch(/Paid back/);
    }
  });
});

describe('early rows (Task 6b)', () => {
  it('people with an item claim or a mark; no aside, no controls; a difference row keeps the warning sub-line', () => {
    const plan = bOwesEarly(1620, { B: mk(1510) });
    const people = settlePeople(view(plan, A, { venmoOf: () => 'sam-1' }));
    expect(people?.aside).toBeNull();
    expect(people?.rows.map((r) => r.userId)).toEqual([B]);
    expect(row(people, B)).toMatchObject({
      status: { text: 'Paid', tone: 'success' },
      subLine: { text: 'Marked $15.10 · share now $16.20', tone: 'warning' },
      a11yLabel: 'Sam, marked paid $15.10, share is now $16.20',
      request: null,
      payBack: null,
    });
    // A1 (SV-10): the host-payer's control is Not received, not Undo.
    expect(row(people, B).undo).toBeNull();
    expect(row(people, B).notReceived).not.toBeNull();
    const unmarked = settlePeople(view(bOwesEarly(1620), A, { venmoOf: () => 'sam-1' }));
    expect(row(unmarked, B)).toMatchObject({ status: { text: 'Not yet' }, a11yLabel: 'Sam, $16.20, not paid yet', request: null });
  });
});

describe('payer card with differences (criterion 31, F5)', () => {
  it('review R2: differences + someone unmarked → the paid-of line and the differences line (same as the footer)', () => {
    const input = view(rowsPlan(DIFF_MARKS), A);
    const m = settleCard(input);
    expect(m).toMatchObject({ state: 'payer', label: '3 people owe you' });
    expect(m.lines).toEqual([
      { text: '2 of 3 settled up', tone: 'muted', live: true },
      { text: '2 differences to settle', tone: 'warning', live: true },
    ]);
    const one = settleCard(view(rowsPlan({ B: mk(1510) }), A));
    expect(one.lines).toEqual([
      { text: '1 of 3 settled up', tone: 'muted', live: true },
      { text: '1 difference to settle', tone: 'warning', live: true },
    ]);
  });
  it('someone unmarked and no differences: the paid-of line only', () => {
    expect(settleCard(view(rowsPlan({ B: mk(1620) }), A)).lines).toEqual([{ text: '1 of 3 settled up', tone: 'muted', live: true }]);
  });
  it('every ower marked, 1 and 2 differences → payer with the warning differences line', () => {
    const one = settleCard(view(rowsPlan({ B: mk(1510), E: mk(1400), D: mk(500) }), A));
    expect(one).toMatchObject({ state: 'payer', label: '3 people owe you' });
    expect(one.lines).toEqual([
      { text: '3 of 3 settled up', tone: 'muted', live: true },
      { text: '1 difference to settle', tone: 'warning', live: true },
    ]);
    const two = settleCard(view(rowsPlan({ ...DIFF_MARKS, D: mk(500) }), A));
    expect(two.lines[1]?.text).toBe('2 differences to settle');
  });
  it('differences within tolerance → payer_all_paid', () => {
    expect(settleCard(view(rowsPlan({ B: mk(1619), E: mk(1401), D: mk(500) }), A)).state).toBe('payer_all_paid');
  });
  it('owingCount 0 with a back difference → payer_differences, never payer_nobody; no differences → payer_nobody', () => {
    const zero = (marks: SettleMarks) =>
      settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, marks);
    expect(settleCard(view(zero({ B: mk(1510) }), A))).toEqual({
      state: 'payer_differences',
      label: 'You owe money back',
      amountCents: null,
      lines: [{ text: '1 difference to settle', tone: 'warning', live: true }],
      chooser: null,
      primary: null,
      notes: [],
      secondary: [],
      check: null,
    });
    expect(settleCard(view(zero({}), A)).state).toBe('payer_nobody');
  });
});

describe('Everyone aside with open differences (QA F-1, SE-QA-1)', () => {
  // Every ower marked (allPaid), but a mark no longer matches its share: the aside must not say
  // "All paid". It uses the payer card's own differences wording instead.
  it('everyone marked, 1 difference open → "1 difference to settle", never "All paid"', () => {
    const plan = rowsPlan({ B: mk(1510), E: mk(1400), D: mk(500) });
    expect(plan.status === 'ready' && plan.allPaid).toBe(true);
    for (const viewer of [B, D, E]) expect(settlePeople(view(plan, viewer))?.aside).toBe('1 difference to settle');
  });
  it('everyone marked, 2 differences open → "2 differences to settle"', () => {
    const plan = rowsPlan({ ...DIFF_MARKS, D: mk(500) });
    for (const viewer of [B, D, E]) expect(settlePeople(view(plan, viewer))?.aside).toBe('2 differences to settle');
  });
  it('everyone marked, no open differences (within tolerance) → "All paid"', () => {
    const plan = rowsPlan({ B: mk(1619), E: mk(1401), D: mk(500) });
    expect(settlePeople(view(plan, D))?.aside).toBe('All settled up');
  });
  it('someone unmarked keeps "N of M paid", with or without a difference; the payer still gets no aside', () => {
    expect(settlePeople(view(rowsPlan({ B: mk(1510) }), D))?.aside).toBe('1 of 3 settled up');
    expect(settlePeople(view(rowsPlan({ B: mk(1620) }), D))?.aside).toBe('1 of 3 settled up');
    expect(settlePeople(view(rowsPlan({ ...DIFF_MARKS, D: mk(500) }), A))?.aside).toBeNull();
  });
});

describe('actionError additions (criterion 33)', () => {
  it('mark_changed and not_complete refetch with settle copy', () => {
    expect(actionError('mark_changed')).toEqual({ text: 'Your payment just changed. Check the amount and try again.', refetch: true });
    expect(actionError('not_complete')).toEqual({ text: 'Something on the bill just changed. Check your share and try again.', refetch: true });
  });
  it('not_allowed on a difference action (a stale token read as the other direction, 10a finding) refetches with the mark_changed copy', () => {
    expect(actionError('not_allowed', { difference: true })).toEqual({ text: 'Your payment just changed. Check the amount and try again.', refetch: true });
    expect(actionError('not_allowed')).toEqual({ text: BILL_ERROR_COPY.not_allowed, refetch: false });
    expect(actionError('payer_changed', { difference: true })).toEqual({ text: BILL_ERROR_COPY.payer_changed, refetch: true });
  });
  it("settleErrorShown: with the stale card on screen, payers_stale's banner would repeat it, so it's dropped", () => {
    expect(settleErrorShown(BILL_ERROR_COPY.payers_stale, 'blocked_payers')).toBeNull();
    // Positive controls: the same line before the re-read lands, and any other line on the stale card.
    expect(settleErrorShown(BILL_ERROR_COPY.payers_stale, 'ready')).toBe(BILL_ERROR_COPY.payers_stale);
    expect(settleErrorShown(BILL_ERROR_COPY.network, 'blocked_payers')).toBe(BILL_ERROR_COPY.network);
    // After Venmo opened, the "Don't send it" line is not a repeat: it always shows.
    const afterOpen = afterOpenRefusal('payers_stale');
    expect(settleErrorShown(afterOpen, 'blocked_payers')).toBe(afterOpen);
    expect(settleErrorShown(null, 'blocked_payers')).toBeNull();
  });
  it('payers_stale reads the same on a mark and on a difference (both functions refuse it, S8)', () => {
    const stale = { text: BILL_ERROR_COPY.payers_stale, refetch: true };
    expect(actionError('payers_stale', { difference: true })).toEqual(stale);
    expect(actionError('payers_stale', { notReceived: true })).toEqual(stale);
  });
});

describe('footer (criterion 34)', () => {
  const F_F = { kind: 'settle', variant: 'primary', caption: null, a11yHint: 'See what you owe and pay' };
  const earlyRows = [
    billRow('burger', 'Burger', 1500, 0),
    billRow('salad', 'Salad', 1000, 1),
    billRow('fries', 'Fries', 600, 2),
    billRow('dessert', 'Dessert', 800, 3),
  ];
  const early = (participants?: Member[]) => billData({ rows: earlyRows, total: 4400, participants });

  it('early, Sam unmarked owes → primary, You can pay now · 1 item left to claim, early pay', () => {
    const input = settleViewInputFor(early(), B, 'ios', null);
    expect(input.plan.status).toBe('early');
    expect(settleFooterAction(input, 3)).toEqual({
      kind: 'settle',
      variant: 'primary',
      caption: 'You can pay now · 1 item left to claim',
      a11yHint: 'You can pay your share now. 1 item left to claim',
      early: 'pay',
    });
  });

  it('early, Sam marked → secondary, Marked paid · 1 item left to claim, early marked', () => {
    const input = settleViewInputFor(early([member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1000), member(D, 'Dee')]), B, 'ios', null);
    expect(settleFooterAction(input, 3)).toEqual({
      kind: 'settle',
      variant: 'secondary',
      caption: 'Marked paid · 1 item left to claim',
      a11yHint: '1 item left to claim first',
      early: 'marked',
      method: 'other',
      tone: 'success',
    });
  });

  it('early, no item claim (Dee) and the payer → today\'s secondary footer', () => {
    expect(settleFooterAction(settleViewInputFor(early(), D, 'ios', null), 3)).toEqual({ kind: 'settle', ...settleFooter(3, 1, 0) });
    expect(settleFooterAction(settleViewInputFor(early(), A, 'ios', null), 3)).toEqual({ kind: 'settle', ...settleFooter(3, 1, 0) });
  });

  it('billFooterAction keeps early footers with on-screen counts; on-screen 0 → primary Settle up, no caption', () => {
    const pay = settleFooterAction(settleViewInputFor(early(), B, 'ios', null), 3);
    expect(billFooterAction(pay, 2, 0)).toEqual({
      kind: 'settle',
      variant: 'primary',
      caption: 'You can pay now · 2 items left to claim',
      a11yHint: 'You can pay your share now. 2 items left to claim',
      early: 'pay',
    });
    const marked = settleFooterAction(settleViewInputFor(early([member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1000), member(D, 'Dee')]), B, 'ios', null), 3);
    expect(billFooterAction(marked, 2, 1)).toEqual({
      kind: 'settle',
      variant: 'secondary',
      caption: 'Marked paid · 1 item and 1 discount left to claim',
      method: 'other',
      a11yHint: '1 item and 1 discount left to claim first',
      early: 'marked',
      tone: 'success',
    });
    expect(billFooterAction(pay, 0, 0)).toEqual(F_F);
    expect(billFooterAction(marked, 0, 0)).toEqual(F_F);
  });

  it('ready more_due, more_opened and back_due → primary with the difference caption', () => {
    const marked = (cents: number) => billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, cents), member(D, 'Dee')] });
    const hint = 'See the difference and settle it';
    expect(settleFooterAction(settleViewInputFor(marked(1400), B, 'ios', null), 3)).toEqual({ ...F_F, caption: 'You owe Hana $1.10 more', a11yHint: hint });
    expect(settleFooterAction(settleViewInputFor(marked(1400), B, 'ios', { kind: 'more', payerId: A, cents: 110, fromCents: 1400 }), 3)).toEqual({
      ...F_F,
      caption: 'You owe Hana $1.10 more',
      a11yHint: hint,
    });
    expect(settleFooterAction(settleViewInputFor(marked(1620), B, 'ios', null), 3)).toEqual({ ...F_F, caption: 'Hana owes you $1.10 back', a11yHint: hint });
  });

  it('payer with 1 and 2 differences', () => {
    const hint = 'See the difference and settle it';
    const one = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1400), member(D, 'Dee')] });
    expect(settleFooterAction(settleViewInputFor(one, A, 'ios', null), 3)).toEqual({ ...F_F, caption: '1 difference to settle', a11yHint: hint });
    const two = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1400), member(D, 'Dee', null, 200)] });
    expect(settleFooterAction(settleViewInputFor(two, A, 'ios', null), 3)).toEqual({ ...F_F, caption: '2 differences to settle', a11yHint: hint });
  });

  it('review R3: only the mark confirmations carry the success tone; only the exact "Marked paid" is live', () => {
    const tones = (a: ReturnType<typeof settleFooterAction>) => (a?.kind === 'settle' ? [a.caption, a.tone, a.live] : null);
    const sam = (cents: number | null) => [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, cents), member(D, 'Dee')];
    // Ready and marked: tone + live. Early and marked: tone, not live (it would speak on every claim tap).
    expect(tones(settleFooterAction(settleViewInputFor(billData({ participants: sam(1510) }), B, 'ios', null), 3))).toEqual(['Marked paid · $15.10', 'success', true]);
    expect(tones(settleFooterAction(settleViewInputFor(early(sam(1000)), B, 'ios', null), 3))).toEqual([
      'Marked paid · 1 item left to claim',
      'success',
      undefined,
    ]);
    // Everything else: no tone, not live.
    expect(tones(settleFooterAction(settleViewInputFor(early(), B, 'ios', null), 3))).toEqual(['You can pay now · 1 item left to claim', undefined, undefined]);
    expect(tones(settleFooterAction(settleViewInputFor(early(), D, 'ios', null), 3))).toEqual(['1 item left to claim', undefined, undefined]);
    expect(tones(settleFooterAction(settleViewInputFor(billData({ participants: sam(1400) }), B, 'ios', null), 3))).toEqual([
      'You owe Hana $1.10 more',
      undefined,
      undefined,
    ]);
    expect(tones(settleFooterAction(settleViewInputFor(billData(), A, 'ios', null), 3))).toEqual([null, undefined, undefined]);
    // billFooterAction's on-screen rebuilds keep the tone of an early "Marked paid" and add none elsewhere.
    const marked = settleFooterAction(settleViewInputFor(early(sam(1000)), B, 'ios', null), 3);
    expect(tones(billFooterAction(marked, 3, 0))).toEqual(['Marked paid · 3 items left to claim', 'success', undefined]);
    expect(tones(billFooterAction(marked, 0, 0))).toEqual([null, undefined, undefined]);
    const ready = settleFooterAction(settleViewInputFor(billData({ participants: sam(1510) }), B, 'ios', null), 3);
    expect(tones(billFooterAction(ready, 1, 0))).toEqual(['1 item left to claim', undefined, undefined]);
  });

  it('review R5 (criterion 59): an early plan with an opened Pay keeps the footer\'s "Did you pay?" at the opened amount', () => {
    const opened: OpenedVenmo = { payerId: A, cents: 1510 };
    const input = settleViewInputFor(early(), B, 'ios', opened);
    expect(input.plan.status).toBe('early');
    expect(settleCard(input).state).toBe('owes_opened');
    const got = settleFooterAction(input, 3);
    expect(got).toEqual({
      kind: 'did_you_pay',
      text: 'Did you send Hana $15.10?',
      iPaid: {
        label: 'Yes, I sent it',
        a11yLabel: 'Yes, I sent it',
        a11yHint: 'Records your $15.10 to Hana as sent',
        // The plan key it was opened under (who paid A1.2), for mark_paid's p_plan_key.
        action: { kind: 'mark', method: 'venmo', payerId: A, cents: 1510, confirmsSend: true, planKey: expect.stringMatching(/^[0-9a-f]{16}$/) },
      },
      notYet: { label: 'Not yet', a11yLabel: 'Not yet' },
      details: { label: 'Details', a11yLabel: 'Settle up details', a11yHint: "Shows who's paid and other ways to pay" },
    });
    // The screen's own counts don't replace it: the amount is the opened one, not a current share.
    expect(billFooterAction(got, 1, 0)).toBe(got);
    expect(billFooterAction(got, 0, 0)).toBe(got);
    // Dropped where contract O drops it: Sam can't settle early (no item claim) → today's footer.
    const noClaim = billData({ rows: earlyRows, total: 4400, claims: [cl('burger', A), cl('fries', A)] });
    expect(settleFooterAction(settleViewInputFor(noClaim, B, 'ios', opened), 3)?.kind).toBe('settle');
  });
});

describe('contract O, share kind (criterion 59)', () => {
  const opened: OpenedVenmo = { payerId: A, cents: 1510 };
  it('ready: the share moved to 1620 → still owes_opened at $15.10, "I paid" marks 1510', () => {
    const m = settleCard(view(bOwesReady(1620), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'owes_opened', amountCents: 1510, primary: { action: { kind: 'mark', payerId: A, cents: 1510 } } });
  });
  it('the same in an early plan where Sam can settle (with the may-change line)', () => {
    const m = settleCard(view(bOwesEarly(1620), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'owes_opened', amountCents: 1510, primary: { action: { cents: 1510 } } });
    expect(m.lines.map((l) => l.text)).toEqual(['Your share may change until everything is claimed (1 item left).']);
  });
  it('dropped when the payer changes, Sam is marked, the plan is blocked, or Sam can\'t settle early', () => {
    expect(openedStillMatches(bOwesReady(1620), B, { ...opened, payerId: D })).toBe(false);
    expect(openedStillMatches(bOwesReady(1620, { B: mk(1510) }), B, opened)).toBe(false);
    expect(openedStillMatches({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B, opened)).toBe(false);
    expect(openedStillMatches(earlyWorked({}, { claims: [c('burger', A)] }), B, opened)).toBe(false);
    expect(openedStillMatches(bOwesEarly(1620), B, opened)).toBe(true);
  });
  it('payOpenFailedLine still needs the current amount (the instruction to send money must be current)', () => {
    const failure = { payerId: A, cents: 1510, handle: 'hana-1' };
    expect(payOpenFailedLine(view(bOwesReady(1510), B), failure)).not.toBeNull();
    expect(payOpenFailedLine(view(bOwesReady(1620), B), failure)).toBeNull();
    // A failed Pay-more open: the line describes the difference while it's still due.
    expect(payOpenFailedLine(view(bOwesReady(1620, { B: mk(1510) }), B), { payerId: A, cents: 110, handle: 'hana-1' })).toBe(
      "Couldn't open Venmo. Send $1.10 to @hana-1 in the Venmo app, then tap Paid another way.",
    );
  });
});

describe('notices (criterion 60)', () => {
  const nameOf = makeNameOf(PEOPLE, B);
  const ctx = { iChangedPayer: false, iUndid: false, openedVenmo: null, nameOf, viewerId: B };
  const prev = { payerId: A, myMark: true, myShareCents: 1510 };
  it.each([
    [0, null],
    [-100, null],
    [500, 'Your "I paid" was undone. Check Activity to see who.'],
    [null, 'Your "I paid" was undone. Check Activity to see who.'],
  ] as const)('next share %s', (share, want) => {
    expect(noticeFor(prev, { payerId: A, myMark: false, myShareCents: share }, ctx)).toBe(want);
  });
  it('noticeSnapshot: the viewer\'s share from a ready or early plan, null otherwise', () => {
    expect(noticeSnapshot(view(bOwesReady(1620, { B: mk(1510) }), B, { viewerMarked: true }))).toEqual({ payerId: A, myMark: true, myShareCents: 1620, notReceived: false });
    expect(noticeSnapshot(view(bOwesEarly(700), B))).toEqual({ payerId: A, myMark: false, myShareCents: 700, notReceived: false });
    expect(noticeSnapshot(view(bOwesReady(700), A)).myShareCents).toBeNull(); // the payer has no share to collect
    expect(noticeSnapshot(view({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B)).myShareCents).toBeNull();
  });
});

/** Card fixtures of criteria 26–31 (non-payer and payer viewers), for criteria 66 and 67. */
function cardFixtures(): SettleViewInput[] {
  const m = (cents: number) => ({ B: mk(cents) });
  const share = owedOf(earlyWorked(), B);
  const neg = settlePlan(
    { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
    A,
    m(1510),
  );
  const zero = (marks: SettleMarks) =>
    settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, marks);
  const plans: SettlePlanWithEarly[] = [
    earlyWorked(),
    earlyWorked({ B: mk(share) }),
    earlyWorked({}, { claims: [c('burger', A), c('fries', A)] }),
    bOwesEarly(1620, m(1510)),
    bOwesEarly(1400, m(1510)),
    bOwesReady(1510),
    bOwesReady(1510, m(1510)),
    bOwesReady(1620, m(1510)),
    bOwesReady(1400, m(1510)),
    bOwesReady(1511, m(1510)),
    neg,
    settlePlan(
      { totalCents: 800, items: [{ id: 'a', totalCents: 1000 }, { id: 'b', totalCents: 0 }], claims: [c('a', A), c('b', B)], participantIds: [A, B], extrasMode: 'equal' },
      A,
      {},
    ),
    zero({}),
    zero(m(1510)),
    rowsPlan({}),
    rowsPlan(DIFF_MARKS),
    rowsPlan({ ...DIFF_MARKS, D: mk(500) }),
    rowsPlan({ B: mk(1620), E: mk(1400), D: mk(500) }),
    { status: 'blocked', unclaimedRows: 2, unclaimedDiscountRows: 0 },
    { status: 'blocked_all_zero' },
  ];
  const out: SettleViewInput[] = [];
  for (const plan of plans) {
    for (const viewer of [A, B]) {
      for (const payerVenmo of ['hana-1', null]) out.push(view(plan, viewer, { payerVenmo, venmoOf: () => 'some-one', platform: 'web' }));
    }
  }
  return out;
}

describe('glyph walk (criterion 66, VP-30, R8)', () => {
  it('no card, row, footer, notice or error string contains a glyph', () => {
    const texts: string[] = [];
    for (const input of cardFixtures()) {
      texts.push(...stringsIn(settleCard(input)), ...stringsIn(settlePeople(input)), ...stringsIn(settleFooterAction(input, 3)));
      texts.push(...stringsIn(addVenmoPrompt(input)), ...stringsIn(settleRequestWebLine(input, settlePeople(input))));
    }
    const nameOf = makeNameOf(PEOPLE, B);
    const ctx = { iChangedPayer: false, iUndid: false, openedVenmo: null, nameOf, viewerId: B };
    texts.push(noticeFor({ payerId: A, myMark: true }, { payerId: D, myMark: false }, ctx) ?? '');
    texts.push(noticeFor({ payerId: A, myMark: true }, { payerId: A, myMark: false, myShareCents: 500 }, ctx) ?? '');
    for (const e of ['mark_changed', 'not_complete', 'not_allowed', 'network'] as const) texts.push(actionError(e, { difference: true }).text);
    expect(texts.length).toBeGreaterThan(200);
    for (const t of texts) expect(t).not.toMatch(GLYPH);
  });
});

describe('markers agree with cards (criterion 67)', () => {
  // Steps 1–2 of billMarker never fire for these facts, so only the settle marker is compared.
  const summary = { hostId: A, payerId: A, added: false, seen: true, seenAt: null, claimedAny: true, complete: true };
  // Home shows one pill: "N left to pay" (H5) wins over differences (H6), even though the card shows both lines (review R2).
  const expected = (m: SettleCardModel, plan: SettleViewInput['plan'], viewerId: string): string | null => {
    switch (m.state) {
      case 'blocked':
      case 'blocked_all_zero':
        // Sent via Venmo D7 (Task 7): a guest who has claimed waits on others; the payer has no pill.
        return viewerId === summary.payerId ? null : 'waiting_on_others';
      case 'owes':
      case 'owes_no_venmo':
        return 'owes';
      case 'marked':
        return 'paid';
      case 'more_due':
        return 'paid_more';
      case 'back_due':
        return 'paid_back_due';
      case 'payer':
        if (plan.status === 'ready' && plan.paidCount < plan.owingCount) return 'left_to_pay';
        return m.lines.some((l) => /difference/.test(l.text)) ? 'differences' : 'left_to_pay';
      case 'payer_differences':
        return 'differences';
      case 'payer_all_paid':
        return 'settled';
      default:
        return null;
    }
  };
  it('every fixture: the Home marker is the one the card state implies', () => {
    const seen = new Set<string>();
    for (const input of cardFixtures()) {
      const cardModel = settleCard({ ...input, openedVenmo: null });
      seen.add(cardModel.state);
      expect([cardModel.state, billMarker(summary, input.viewerId, input.plan)]).toEqual([cardModel.state, expected(cardModel, input.plan, input.viewerId)]);
    }
    // The fixtures reach every state the criterion names.
    for (const s of ['owes', 'owes_no_venmo', 'marked', 'more_due', 'back_due', 'payer', 'payer_differences', 'payer_all_paid', 'payer_early', 'early_not_ready', 'nothing', 'negative', 'blocked']) {
      expect(seen).toContain(s);
    }
  });
});

describe('copy at a count of 1 and with "You" (criterion 32)', () => {
  it('the host-payer viewing a back row reads "You owe", never "You owes"; own rows never "Owes"', () => {
    for (const viewer of [A, B, D, E]) {
      for (const r of settlePeople(rowsInput(DIFF_MARKS, viewer, A))?.rows ?? []) {
        expect(r.status?.text ?? '').not.toMatch(/You owes|^You .*owes you/);
        expect(r.a11yLabel).not.toMatch(/You owes/);
        if (r.name === 'You') expect(r.status?.text).not.toMatch(/^Owes/);
      }
    }
  });
});

// Task 8: pass-through helpers, so screens never read money fields off actions (criterion 46).
describe('openedFor / differenceArgs', () => {
  it('Pay gives a share prompt; Pay more gives a "more" prompt with its starting mark', () => {
    expect(openedFor({ kind: 'pay', method: 'venmo', url: 'u', payerId: 'a', cents: 1510 })).toEqual({ payerId: 'a', cents: 1510 });
    expect(openedFor({ kind: 'pay_difference', method: 'venmo', url: 'u', payerId: 'a', cents: 110, fromCents: 1510, toCents: 1620 })).toEqual({
      kind: 'more',
      payerId: 'a',
      cents: 110,
      fromCents: 1510,
    });
  });

  it('differenceArgs is the action as built: person, payer, from, to (a pay-back to 0 included)', () => {
    expect(differenceArgs({ kind: 'mark_difference', method: 'venmo', userId: 'b', payerId: 'a', fromCents: 1510, toCents: 1620 })).toStrictEqual(['b', 'a', 1510, 1620, 'venmo']);
    expect(differenceArgs({ kind: 'mark_difference', method: 'other', userId: 'b', payerId: 'a', fromCents: 1510, toCents: 0 })).toStrictEqual(['b', 'a', 1510, 0, 'other']);
  });
});

// ---------------------------------------------------------------------------
// Sent via Venmo (docs/specs/2026-11-26-sent-via-venmo.md, Amendment A1, D4, D5; Task 6a/6b;
// criterion 28). Copy from the UX brief §12.
// ---------------------------------------------------------------------------

// Real UUIDs: the inline check's keys only accept them (D3).
const UH = '11111111-1111-4111-8111-111111111111'; // Hana, host and payer
const US = '22222222-2222-4222-8222-222222222222'; // Sam
const UD = '44444444-4444-4444-8444-444444444444'; // Dee
const UR = '55555555-5555-4555-8555-555555555555'; // Raj
const UK = '66666666-6666-4666-8666-666666666666'; // Kim, host who isn't the payer in some fixtures
const BILL = '33333333-3333-4333-8333-333333333333';
const SENT_AT = '2026-11-26T10:00:00.123456+00:00';
const SENT_MS = Date.parse(SENT_AT);
const SV_PEOPLE = [
  { userId: UH, displayName: 'Hana' },
  { userId: US, displayName: 'Sam' },
  { userId: UD, displayName: 'Dee' },
  { userId: UR, displayName: 'Raj' },
  { userId: UK, displayName: 'Kim' },
];
const sm = (cents: number, method: PaymentMethod, to: string = UH): SettleMark => fakeMark(cents, SENT_AT, to, method);

/** Sam owes `cents` to Hana (plus anyone in `others`, each owing their cents), complete unless `early`. */
function svPlan(
  cents: number,
  marks: SettleMarks = {},
  opts: { flags?: SettleNotReceivedMap; others?: Record<string, number>; early?: boolean; payer?: string } = {},
): SettlePlanWithEarly {
  const others = opts.others ?? {};
  const ids = [UH, US, ...Object.keys(others), ...(opts.payer !== undefined && opts.payer !== UH && !(opts.payer in others) ? [opts.payer] : [])];
  const items = [
    { id: 'h', totalCents: 1000 },
    { id: 's', totalCents: cents },
    ...Object.entries(others).map(([id, v]) => ({ id: `o-${id}`, totalCents: v })),
    ...(opts.early ? [{ id: 'u', totalCents: 500 }] : []),
  ];
  const claims = [c('h', opts.payer ?? UH), c('s', US), ...Object.keys(others).map((id) => c(`o-${id}`, id))];
  const total = items.reduce((s, i) => s + i.totalCents, 0);
  return settlePlan({ totalCents: total, items, claims, participantIds: ids, extrasMode: 'proportional' }, opts.payer ?? UH, marks, {
    allowEarly: true,
    notReceived: opts.flags ?? {},
  });
}

function sv(plan: SettlePlanWithEarly, viewerId: string, over: Partial<SettleViewInput> = {}): SettleViewInput {
  return view(plan, viewerId, { nameOf: makeNameOf(SV_PEOPLE, viewerId), hostId: UH, billId: BILL, ...over });
}
/** The inline check's inputs: no stored answers, `now` this long after the send. */
const fresh = (afterMs = 5_000, answers: SentCheckBlob = {}) => ({
  answers,
  now: SENT_MS + afterMs,
});
const CHECK_KEY = `${BILL}.${UH}.${SENT_MS}`;
const svPayUrl = (cents: number) => venmoPayUrl({ username: 'hana-1', cents });

describe('A1 chooser and default method (D5, criterion 28)', () => {
  const plan = svPlan(1510);

  it('Venmo available, nothing remembered: chooser Venmo | Cash on Venmo, the Pay primary, Paid another way', () => {
    const m = settleCard(sv(plan, US));
    expect(m.state).toBe('owes');
    expect(m.chooser).toEqual({
      options: [
        { value: 'venmo', label: 'Venmo', a11yLabel: "Venmo, how you're paying" },
        { value: 'cash', label: 'Cash', a11yLabel: "Cash, how you're paying" },
      ],
      value: 'venmo',
      a11yLabel: "How you're paying",
    });
    expect(m.primary).toEqual({
      label: 'Pay Hana $15.10 on Venmo',
      a11yLabel: 'Pay Hana $15.10 on Venmo, to @hana-1',
      a11yHint: 'Opens Venmo and records it as sent',
      action: { kind: 'pay', method: 'venmo', url: svPayUrl(1510), payerId: UH, cents: 1510 },
    });
    expect(m.notes).toEqual(['@hana-1 · $15.10']);
    expect(m.secondary).toEqual([
      {
        label: 'Paid another way',
        a11yLabel: 'Paid another way',
        a11yHint: 'Records that you paid Hana outside SplitIt',
        action: { kind: 'mark', method: 'other', payerId: UH, cents: 1510 },
      },
    ]);
    expect(m.lines).toEqual([]);
    expect(m.check).toBeNull();
  });

  it('notes: web adds the computer line; the permission note only on native while undetermined', () => {
    const PERM = "We'll check back in a minute to make sure it went through.";
    expect(settleCard(sv(plan, US, { platform: 'web' })).notes).toEqual(['@hana-1 · $15.10', 'On a computer? Send it from the Venmo app on your phone.']);
    expect(settleCard(sv(plan, US, { permissionUndetermined: true })).notes).toEqual(['@hana-1 · $15.10', PERM]);
    expect(settleCard(sv(plan, US, { platform: 'web', permissionUndetermined: true })).notes).not.toContain(PERM);
    expect(settleCard(sv(plan, US, { platform: 'web', permissionUndetermined: true })).notes).toHaveLength(2);
    // Cash selected: no notes at all (nothing opens).
    expect(settleCard(sv(plan, US, { rememberedMethod: 'cash', permissionUndetermined: true })).notes).toEqual([]);
  });

  it('remembered cash + payer with Venmo → Cash selected, the cash primary', () => {
    const m = settleCard(sv(plan, US, { rememberedMethod: 'cash' }));
    expect(m.state).toBe('owes');
    expect(m.chooser?.value).toBe('cash');
    expect(m.primary).toEqual({
      label: 'I paid Hana $15.10 in cash',
      a11yLabel: 'I paid Hana $15.10 in cash',
      a11yHint: 'Records that you paid in cash. Nothing opens.',
      action: { kind: 'mark', method: 'cash', payerId: UH, cents: 1510 },
    });
    expect(m.secondary.map((b) => b.label)).toEqual(['Paid another way']);
  });

  it('remembered venmo + payer without Venmo → cash only, no chooser, the no-Venmo line (SV-29)', () => {
    const m = settleCard(sv(plan, US, { rememberedMethod: 'venmo', payerVenmo: null }));
    expect(m).toMatchObject({ state: 'owes_no_venmo', label: 'You owe Hana', amountCents: 1510, chooser: null, notes: [] });
    expect(m.lines).toEqual([{ text: "Hana hasn't added Venmo yet.", tone: 'muted' }]);
    expect(m.primary?.action).toEqual({ kind: 'mark', method: 'cash', payerId: UH, cents: 1510 });
    expect(m.secondary.map((b) => b.action)).toEqual([{ kind: 'mark', method: 'other', payerId: UH, cents: 1510 }]);
    // A username that fails the pattern reads the same.
    expect(settleCard(sv(plan, US, { payerVenmo: 'no spaces allowed' })).chooser).toBeNull();
  });

  it('nothing remembered → Venmo; a remembered "other" is ignored', () => {
    expect(settleCard(sv(plan, US)).chooser?.value).toBe('venmo');
    expect(settleCard(sv(plan, US, { rememberedMethod: 'other' })).chooser?.value).toBe('venmo');
    expect(chosenMethod('other', 'hana-1')).toBe('venmo');
    expect(chosenMethod('cash', 'hana-1')).toBe('cash');
    expect(chosenMethod('venmo', null)).toBe('cash');
    expect(chosenMethod(null, null)).toBe('cash');
  });

  it('early owes card: the same chooser, the may-change line in the head', () => {
    const m = settleCard(sv(svPlan(1510, {}, { early: true }), US, { rememberedMethod: 'cash' }));
    expect(m.state).toBe('owes');
    expect(m.chooser?.value).toBe('cash');
    expect(m.lines[0]?.text).toMatch(/^Your share may change/);
    expect(m.primary?.label).toBe('I paid Hana $15.10 in cash');
  });

  it('$0.01: the Pay and cash primaries read the cent', () => {
    expect(settleCard(sv(svPlan(1), US)).primary?.label).toBe('Pay Hana $0.01 on Venmo');
    expect(settleCard(sv(svPlan(1), US, { rememberedMethod: 'cash' })).primary?.label).toBe('I paid Hana $0.01 in cash');
  });
});

describe('A1 contract O fallback (D2)', () => {
  it('share: "Did you send Hana $15.10?", Yes, I sent it records venmo and answers the check, Open Venmo again opens only', () => {
    const m = settleCard(sv(svPlan(1510), US, { openedVenmo: { payerId: UH, cents: 1510 } }));
    expect(m).toMatchObject({ state: 'owes_opened', label: 'Did you send Hana $15.10?', amountCents: 1510, chooser: null, check: null });
    expect(m.primary).toEqual({
      label: 'Yes, I sent it',
      a11yLabel: 'Yes, I sent it',
      a11yHint: 'Records your $15.10 to Hana as sent',
      action: { kind: 'mark', method: 'venmo', payerId: UH, cents: 1510, confirmsSend: true },
    });
    expect(m.notes).toEqual(['@hana-1 · $15.10']);
    expect(m.secondary).toEqual([
      {
        label: 'Open Venmo again',
        a11yLabel: 'Open Venmo again',
        a11yHint: 'Opens Venmo',
        action: { kind: 'pay', method: 'venmo', url: svPayUrl(1510), payerId: UH, cents: 1510 },
      },
    ]);
  });

  it('more: "Did you send Hana $1.10?", Yes, I sent it records the difference as venmo', () => {
    const m = settleCard(sv(svPlan(1620, { [US]: sm(1510, 'venmo') }), US, { openedVenmo: { kind: 'more', payerId: UH, cents: 110, fromCents: 1510 } }));
    expect(m).toMatchObject({ state: 'more_opened', label: 'Did you send Hana $1.10?', amountCents: 110 });
    expect(m.primary).toMatchObject({
      label: 'Yes, I sent it',
      action: { kind: 'mark_difference', method: 'venmo', userId: US, payerId: UH, fromCents: 1510, toCents: 1620 },
    });
  });

  it('footer: Did you send Hana $15.10? · Yes, I sent it · Not yet · Details', () => {
    const f = settleFooterAction(sv(svPlan(1510), US, { openedVenmo: { payerId: UH, cents: 1510 } }), 2);
    expect(f).toMatchObject({ kind: 'did_you_pay', text: 'Did you send Hana $15.10?', iPaid: { label: 'Yes, I sent it' }, notYet: { label: 'Not yet' } });
  });

  it('the open-failed line tells Sam to tap Paid another way', () => {
    expect(openFailedText('hana-1', 1510)).toBe("Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.");
    // The payer's Pay back names the control the payer has (Task 9a).
    expect(payBackOpenFailedText('sam-1', 110)).toBe("Couldn't open Venmo. Send $1.10 to @sam-1 in the Venmo app, then tap I paid it back.");
  });
});

describe('A1 marked cards by method (D5)', () => {
  const ALL_SET = { text: "You're all set. Hana can see it.", tone: 'muted' };

  it('venmo, check answered: You sent Hana / Sent via Venmo / the completion line / Didn\'t go through? Undo', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') });
    const answered = { answers: { [CHECK_KEY]: { a: 'yes' as const, t: SENT_MS } }, now: SENT_MS + 5_000 };
    const m = settleCard(sv(plan, US, { sentCheck: answered, viewerMarked: true }));
    expect(m).toMatchObject({ state: 'marked', label: 'You sent Hana', amountCents: 1510, primary: null, chooser: null, check: null });
    expect(m.lines).toEqual([{ text: 'Sent via Venmo', tone: 'success', live: true }, ALL_SET]);
    expect(m.secondary).toEqual([
      { label: "Didn't go through? Undo", a11yLabel: "Didn't go through? Undo", a11yHint: 'Clears Sent via Venmo for $15.10', action: { kind: 'unmark', userId: US } },
    ]);
  });

  it('venmo, check applies: the question and its answers; no Undo and no completion line while it shows', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') });
    const m = settleCard(sv(plan, US, { sentCheck: fresh(), viewerMarked: true }));
    const checkFacts = { key: CHECK_KEY, billId: BILL, payerId: UH, cents: 1510, markAtMs: SENT_MS };
    expect(m.lines).toEqual([{ text: 'Sent via Venmo', tone: 'success', live: true }]);
    expect(m.secondary).toEqual([]);
    expect(m.check).toEqual({
      question: 'Did it go through?',
      yes: { label: 'Yes', a11yLabel: 'Yes, it went through', action: { kind: 'sent_check_yes', ...checkFacts } },
      undo: {
        label: 'No, undo',
        a11yLabel: "No, undo. It didn't go through",
        a11yHint: 'Clears Sent via Venmo for $15.10',
        action: { kind: 'sent_check_undo', ...checkFacts },
      },
    });
  });

  it('check: none without check inputs, at 30 min + 1 ms, for a mark to a former payer; exactly 30 min still asks', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') });
    expect(settleCard(sv(plan, US, { sentCheck: null })).check).toBeNull();
    expect(settleCard(sv(plan, US, { sentCheck: fresh(30 * 60_000) })).check).not.toBeNull();
    expect(settleCard(sv(plan, US, { sentCheck: fresh(30 * 60_000 + 1) })).check).toBeNull();
    const stale = svPlan(1510, { [US]: sm(1510, 'venmo', UD) }, { others: { [UD]: 300 } });
    expect(settleCard(sv(stale, US, { sentCheck: fresh() })).state).toBe('marked');
    expect(settleCard(sv(stale, US, { sentCheck: fresh() })).check).toBeNull();
    // Stored 'shown' (navigated away) or 'undo' → gone.
    for (const a of ['shown', 'undo'] as const) {
      expect(settleCard(sv(plan, US, { sentCheck: fresh(5_000, { [CHECK_KEY]: { a, t: SENT_MS } }) })).check).toBeNull();
    }
    // A "more" send this screen just made never asks (F4).
    expect(settleCard(sv(plan, US, { sentCheck: { ...fresh(), lastSend: 'more' } })).check).toBeNull();
  });

  it('cash: You paid Hana / Paid in cash / completion / Undo; never a check', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'cash') });
    const m = settleCard(sv(plan, US, { sentCheck: fresh() }));
    expect(m).toMatchObject({ state: 'marked', label: 'You paid Hana', amountCents: 1510, check: null });
    expect(m.lines).toEqual([{ text: 'Paid in cash', tone: 'success', live: true }, ALL_SET]);
    expect(m.secondary).toEqual([{ label: 'Undo', a11yLabel: 'Undo', a11yHint: 'Clears Paid in cash for $15.10', action: { kind: 'unmark', userId: US } }]);
  });

  it('other: You paid Hana / Marked paid / completion / Undo', () => {
    const m = settleCard(sv(svPlan(1510, { [US]: sm(1510, 'other') }), US, { sentCheck: fresh() }));
    expect(m).toMatchObject({ label: 'You paid Hana', check: null });
    expect(m.lines).toEqual([{ text: 'Marked paid', tone: 'success', live: true }, ALL_SET]);
    expect(m.secondary[0]).toMatchObject({ label: 'Undo', a11yHint: 'Clears Marked paid for $15.10' });
  });

  it('early marked: the settle-early line instead of the completion line; a fresh venmo send still asks', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') }, { early: true });
    const asked = settleCard(sv(plan, US, { sentCheck: fresh() }));
    expect(asked).toMatchObject({ state: 'marked', label: 'You sent Hana' });
    expect(asked.lines).toEqual([
      { text: 'Sent via Venmo', tone: 'success', live: true },
      { text: "If your share changes, you'll settle the difference here once everything is claimed.", tone: 'muted' },
    ]);
    expect(asked.check).not.toBeNull();
    expect(asked.secondary).toEqual([]);
    const later = settleCard(sv(plan, US, { sentCheck: null }));
    expect(later.lines.map((l) => l.text)).not.toContain("You're all set. Hana can see it.");
    expect(later.secondary.map((b) => b.label)).toEqual(["Didn't go through? Undo"]);
  });

  it('no marked card or marked footer has a pay or cash action (decision 5)', () => {
    let checked = 0;
    for (const method of PAYMENT_METHODS) {
      for (const cents of [1510, 1620, 1400]) {
        for (const early of [false, true]) {
          for (const sentCheck of [null, fresh()]) {
            for (const rememberedMethod of [null, 'cash', 'venmo'] as const) {
              const input = sv(svPlan(cents, { [US]: sm(1510, method) }, { early }), US, { sentCheck, rememberedMethod, viewerMarked: true });
              const cardModel = settleCard(input);
              const all = [cardModel.primary, ...cardModel.secondary, cardModel.check?.yes, cardModel.check?.undo];
              expect(all.some((b) => b?.action.kind === 'pay' || (b?.action.kind === 'mark'))).toBe(false);
              const f = settleFooterAction(input, 2);
              expect(f?.kind === 'pay' || f?.kind === 'cash').toBe(false);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(108);
  });
});

describe('A1 not received, Sam\'s side (D4)', () => {
  const flagged = (method: PaymentMethod, cents = 1510, to = UH) => svPlan(1510, {}, { flags: { [US]: fakeNotReceived(cents, to, method) } });

  it('the first line under the amount, warning, by the cleared method; then the normal owes card', () => {
    const m = settleCard(sv(flagged('venmo'), US));
    expect(m.lines[0]).toEqual({ text: "Hana hasn't received your $15.10. Check Venmo before paying again.", tone: 'warning' });
    expect(m).toMatchObject({ state: 'owes', chooser: { value: 'venmo' }, primary: { label: 'Pay Hana $15.10 on Venmo' } });
    expect(settleCard(sv(flagged('cash'), US)).lines[0]?.text).toBe("Hana hasn't received your $15.10 in cash.");
    expect(settleCard(sv(flagged('other'), US)).lines[0]?.text).toBe("Hana hasn't received your $15.10.");
    // The flag's amount, not today's share.
    expect(settleCard(sv(flagged('venmo', 1400), US)).lines[0]?.text).toBe("Hana hasn't received your $14.00. Check Venmo before paying again.");
    expect(settleCard(sv(flagged('cash', 1), US)).lines[0]?.text).toBe("Hana hasn't received your $0.01 in cash.");
  });

  it('no line for a flag naming a former payer, or once Sam has marked again', () => {
    const former = svPlan(1510, {}, { flags: { [US]: fakeNotReceived(1510, UD) }, others: { [UD]: 300 } });
    const card1 = settleCard(sv(former, US));
    expect(card1.state).toBe('owes'); // positive control: the owes card is there
    expect(card1.lines.some((l) => l.tone === 'warning')).toBe(false);
    const remarked = svPlan(1510, { [US]: sm(1510, 'cash') }, { flags: { [US]: fakeNotReceived(1510, UH) } });
    const card2 = settleCard(sv(remarked, US));
    expect(card2.state).toBe('marked');
    expect(card2.lines.some((l) => l.tone === 'warning')).toBe(false);
  });

  it('the no-Venmo card puts the warning first, then the no-Venmo line', () => {
    const m = settleCard(sv(flagged('venmo'), US, { payerVenmo: null }));
    expect(m.lines.map((l) => l.text)).toEqual(["Hana hasn't received your $15.10. Check Venmo before paying again.", "Hana hasn't added Venmo yet."]);
  });

  it('footer: primary Settle up with the warning caption, never the Pay or cash footer', () => {
    for (const rememberedMethod of [null, 'cash'] as const) {
      for (const payerVenmo of ['hana-1', null]) {
        const f = settleFooterAction(sv(flagged('venmo'), US, { rememberedMethod, payerVenmo }), 2);
        expect(f).toEqual({
          kind: 'settle',
          variant: 'primary',
          caption: "Hana hasn't received your $15.10",
          a11yHint: 'See what you owe and pay',
          tone: 'warning',
        });
      }
    }
  });

  it('noticeSnapshot carries the flag, and noticeFor shows no "undone" banner then (SV-19)', () => {
    expect(noticeSnapshot(sv(flagged('venmo'), US)).notReceived).toBe(true);
    expect(noticeSnapshot(sv(svPlan(1510), US)).notReceived).toBe(false);
    const ctx = { iChangedPayer: false, iUndid: false, openedVenmo: null, nameOf: makeNameOf(SV_PEOPLE, US), viewerId: US };
    const prev = { payerId: UH, myMark: true, myShareCents: 1510, notReceived: false };
    expect(noticeFor(prev, { payerId: UH, myMark: false, myShareCents: 1510, notReceived: true }, ctx)).toBeNull();
    // Positive control: the same change without the flag is the undone banner.
    expect(noticeFor(prev, { payerId: UH, myMark: false, myShareCents: 1510, notReceived: false }, ctx)).toBe(SETTLE_COPY.markUndoneBanner);
  });
});

describe('A1 more-due and back-due cards (D5, SV-UX-18, SV-UX-22)', () => {
  it('more_due after a venmo mark: You\'ve sent, the chooser, Pay more, I paid the difference, Undo all', () => {
    const m = settleCard(sv(svPlan(1620, { [US]: sm(1510, 'venmo') }), US));
    expect(m).toMatchObject({ state: 'more_due', label: 'You owe Hana more', amountCents: 110, chooser: { value: 'venmo' } });
    expect(m.lines).toEqual([{ text: "Your share is now $16.20. You've sent $15.10.", tone: 'muted' }]);
    expect(m.primary).toEqual({
      label: 'Pay Hana $1.10 more on Venmo',
      a11yLabel: 'Pay Hana $1.10 more on Venmo, to @hana-1',
      a11yHint: 'Opens Venmo and records it as sent',
      action: { kind: 'pay_difference', method: 'venmo', url: svPayUrl(110), payerId: UH, cents: 110, fromCents: 1510, toCents: 1620 },
    });
    expect(m.notes).toEqual(['@hana-1 · $1.10']);
    expect(m.secondary).toEqual([
      {
        label: 'I paid the difference',
        a11yLabel: 'I paid the difference',
        a11yHint: 'Records the $1.10 difference as paid another way',
        action: { kind: 'mark_difference', method: 'other', userId: US, payerId: UH, fromCents: 1510, toCents: 1620 },
      },
      { label: "$15.10 payment didn\'t go through", a11yLabel: "$15.10 payment didn\'t go through", a11yHint: 'Clears your whole $15.10 payment, not just the difference', action: { kind: 'unmark', userId: US } },
    ]);
  });

  it('more_due with Cash selected, after a cash or other mark: I paid the $1.10 in cash, You\'ve paid', () => {
    for (const method of ['cash', 'other'] as const) {
      const m = settleCard(sv(svPlan(1620, { [US]: sm(1510, method) }), US, { rememberedMethod: 'cash', permissionUndetermined: true }));
      expect(m.lines[0]?.text).toBe("Your share is now $16.20. You've paid $15.10.");
      expect(m.primary).toEqual({
        label: 'I paid the $1.10 in cash',
        a11yLabel: 'I paid the $1.10 in cash',
        a11yHint: 'Records that you paid in cash. Nothing opens.',
        action: { kind: 'mark_difference', method: 'cash', userId: US, payerId: UH, fromCents: 1510, toCents: 1620 },
      });
      expect(m.notes).toEqual([]);
    }
  });

  it('more_due, payer without Venmo: no chooser, the no-Venmo line, the cash primary', () => {
    const m = settleCard(sv(svPlan(1620, { [US]: sm(1510, 'venmo') }), US, { payerVenmo: null }));
    expect(m).toMatchObject({ state: 'more_due', chooser: null });
    expect(m.lines.map((l) => l.text)).toEqual(["Your share is now $16.20. You've sent $15.10.", "Hana hasn't added Venmo yet."]);
    expect(m.primary?.label).toBe('I paid the $1.10 in cash');
    expect(m.secondary.map((b) => b.label)).toEqual(['I paid the difference', "$15.10 payment didn\'t go through"]);
  });

  it('more_due never shows the permission note (no check-in for more sends, F4)', () => {
    const m = settleCard(sv(svPlan(1620, { [US]: sm(1510, 'venmo') }), US, { permissionUndetermined: true }));
    expect(m.notes).toEqual(['@hana-1 · $1.10']);
  });

  it('back_due: Undo all with the mark amount; You\'ve sent for venmo', () => {
    const m = settleCard(sv(svPlan(1400, { [US]: sm(1510, 'venmo') }), US));
    expect(m.state).toBe('back_due');
    expect(m.lines[0]?.text).toBe("Your share is now $14.00. You've sent $15.10.");
    expect(m.secondary.map((b) => b.label)).toEqual(["$15.10 payment didn\'t go through"]);
    expect(m.check).toBeNull();
  });
});

describe('A1 payer card (SV-UX-14)', () => {
  const four = (marks: SettleMarks) => svPlan(1510, marks, { others: { [UD]: 2000, [UR]: 1010, [UK]: 1200 } });

  it('open: N people owe you / amount / "p of n settled up"', () => {
    expect(settleCard(sv(four({}), UH)).lines).toEqual([{ text: '0 of 4 settled up', tone: 'muted', live: true }]);
    expect(settleCard(sv(four({ [US]: sm(1510, 'venmo') }), UH)).lines[0]?.text).toBe('1 of 4 settled up');
    expect(settleCard(sv(svPlan(1510), UH))).toMatchObject({ label: '1 person owes you', lines: [{ text: '0 of 1 settled up' }] });
  });

  it('all settled: Everyone\'s settled up. Nice. with the method line in venmo, cash, other order', () => {
    const m = settleCard(sv(four({ [US]: sm(1510, 'venmo'), [UD]: sm(2000, 'cash'), [UR]: sm(1010, 'other'), [UK]: sm(1200, 'venmo') }), UH));
    expect(m).toMatchObject({ state: 'payer_all_paid', label: "Everyone's settled up. Nice.", amountCents: 5720 });
    expect(m.lines).toEqual([{ text: '2 sent via Venmo · 1 paid in cash · 1 marked paid', tone: 'success', live: true }]);
    const twoCash = settleCard(sv(svPlan(1510, { [US]: sm(1510, 'cash'), [UD]: sm(2000, 'cash') }, { others: { [UD]: 2000 } }), UH));
    expect(twoCash.lines[0]?.text).toBe('2 paid in cash');
  });

  it('one ower: the sentence names them, per method', () => {
    const line = (method: PaymentMethod) => settleCard(sv(svPlan(1510, { [US]: sm(1510, method) }), UH)).lines[0]?.text;
    expect(line('venmo')).toBe('Sam sent it via Venmo');
    expect(line('cash')).toBe('Sam paid in cash');
    expect(line('other')).toBe('Sam marked it paid');
  });

  it('early: "1 settled up so far" (count of 1 and 2)', () => {
    const early = (marks: SettleMarks) => svPlan(1510, marks, { early: true, others: { [UD]: 300 } });
    expect(settleCard(sv(early({ [US]: sm(1510, 'venmo') }), UH)).lines[1]).toEqual({ text: '1 settled up so far', tone: 'muted', live: true });
    expect(settleCard(sv(early({ [US]: sm(1510, 'venmo'), [UD]: sm(300, 'cash') }), UH)).lines[1]?.text).toBe('2 settled up so far');
  });

  it('the Everyone aside for everyone else: "1 of 2 settled up", then "All settled up"', () => {
    const plan2 = (marks: SettleMarks) => svPlan(1510, marks, { others: { [UD]: 300 } });
    expect(settlePeople(sv(plan2({ [US]: sm(1510, 'venmo') }), UD))?.aside).toBe('1 of 2 settled up');
    expect(settlePeople(sv(plan2({ [US]: sm(1510, 'venmo'), [UD]: sm(300, 'cash') }), UD))?.aside).toBe('All settled up');
  });

  it('footer: everyone settled → secondary "Everyone\'s settled up" with the success tone', () => {
    const f = settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, 'venmo') }), UH), 2);
    expect(f).toEqual({ kind: 'settle', variant: 'secondary', caption: "Everyone's settled up", a11yHint: 'See who paid', tone: 'success' });
    // Positive control: before Sam pays, the payer's footer is today's primary.
    expect(settleFooterAction(sv(svPlan(1510), UH), 2)).toMatchObject({ kind: 'settle', variant: 'primary', caption: null });
  });
});

describe('A1 rows (6b, D5)', () => {
  const marks = { [US]: sm(1510, 'venmo'), [UD]: sm(2000, 'cash'), [UR]: sm(1010, 'other') };
  const plan = svPlan(1510, marks, { others: { [UD]: 2000, [UR]: 1010, [UK]: 1200 } });

  it('payer view: method statuses (success), a11y labels, Not received and no Undo; wideStatus', () => {
    const people = settlePeople(sv(plan, UH));
    expect(people?.wideStatus).toBe(true);
    const sam = row(people, US);
    expect(sam).toMatchObject({ status: { text: 'Sent via Venmo', tone: 'success' }, subLine: null, a11yLabel: 'Sam, $15.10, sent via Venmo', undo: null });
    expect(sam.notReceived).toEqual({
      label: 'Not received',
      a11yLabel: "Not received, Sam's $15.10",
      a11yHint: 'Asks first, then clears it and lets Sam know',
      confirmText: "Didn't get Sam's $15.10? This clears it and lets Sam know.",
      confirmLabel: 'Not received',
      confirmA11yLabel: "Confirm: Sam's $15.10 not received",
      cancelLabel: 'Cancel',
      cancelA11yLabel: "Cancel: keep Sam's $15.10",
      action: { kind: 'not_received', userId: US, payerId: UH, expectedCents: 1510, expectedAt: SENT_AT },
    });
    expect(row(people, UD)).toMatchObject({ status: { text: 'Paid in cash', tone: 'success' }, a11yLabel: 'Dee, $20.00, paid in cash', undo: null });
    expect(row(people, UR)).toMatchObject({ status: { text: 'Paid', tone: 'success' }, a11yLabel: 'Raj, $10.10, marked paid', undo: null });
    expect(row(people, UK)).toMatchObject({ status: { text: 'Not yet' }, notReceived: null, undo: null });
  });

  it('host who isn\'t the payer: Undo on marked rows, never Not received', () => {
    const p = svPlan(1510, { [US]: sm(1510, 'venmo') }, { others: { [UK]: 1200 }, payer: UD });
    const people = settlePeople(sv(p, UH, { hostId: UH }));
    const sam = row(people, US);
    expect(sam.undo).not.toBeNull();
    expect(sam.notReceived).toBeNull();
  });

  it('anyone else: statuses only; the viewer\'s own row reads "You"', () => {
    const people = settlePeople(sv(plan, UD));
    const sam = row(people, US);
    expect(sam).toMatchObject({ status: { text: 'Sent via Venmo' }, undo: null, notReceived: null });
    const mine = settlePeople(sv(plan, US));
    expect(row(mine, US)).toMatchObject({ name: 'You', a11yLabel: 'You, $15.10, sent via Venmo', undo: null, notReceived: null });
  });

  it('a row never has both undo and notReceived (every viewer, host and payer combination)', () => {
    let seenNotReceived = 0;
    let seenUndo = 0;
    for (const viewer of [UH, US, UD, UR, UK]) {
      for (const hostId of [UH, UK]) {
        for (const r of settlePeople(sv(plan, viewer, { hostId }))?.rows ?? []) {
          expect(r.undo !== null && r.notReceived !== null).toBe(false);
          if (r.notReceived) seenNotReceived++;
          if (r.undo) seenUndo++;
        }
      }
    }
    expect(seenNotReceived).toBeGreaterThan(0);
    expect(seenUndo).toBeGreaterThan(0);
  });

  it('payer on difference rows: Not received replaces Undo there too, host-payer included', () => {
    const p = svPlan(1620, { [US]: sm(1510, 'venmo') }, { others: { [UD]: 1400 } });
    const withDiff = svPlan(1620, { [US]: sm(1510, 'venmo'), [UD]: sm(1510, 'cash') }, { others: { [UD]: 1400 } });
    for (const hostId of [UH, UK]) {
      const people = settlePeople(sv(withDiff, UH, { hostId }));
      expect(row(people, US)).toMatchObject({ status: { text: 'Owes $1.10 more' }, undo: null });
      expect(row(people, US).notReceived?.action).toEqual({ kind: 'not_received', userId: US, payerId: UH, expectedCents: 1510, expectedAt: SENT_AT });
      expect(row(people, UD)).toMatchObject({ status: { text: 'You owe $1.10 back' }, undo: null });
      expect(row(people, UD).notReceived?.a11yLabel).toBe("Not received, Dee's $15.10");
    }
    expect(settlePeople(sv(p, UH))?.wideStatus).toBe(true);
  });

  it('early rows: the payer gets Not received on a marked row', () => {
    const early = svPlan(1510, { [US]: sm(1510, 'venmo') }, { early: true });
    const r = row(settlePeople(sv(early, UH)), US);
    expect(r).toMatchObject({ status: { text: 'Sent via Venmo', tone: 'success' }, undo: null });
    expect(r.notReceived).not.toBeNull();
  });

  it('after Not received: Not yet, the muted sub-line, the a11y label; shown to whoever sees the row', () => {
    const flagged = svPlan(1510, {}, { flags: { [US]: fakeNotReceived(1510, UH, 'venmo') }, others: { [UD]: 300 } });
    for (const viewer of [UH, UD]) {
      const r = row(settlePeople(sv(flagged, viewer)), US);
      expect(r).toMatchObject({
        status: { text: 'Not yet', tone: 'muted' },
        subLine: { text: 'Not received · $15.10', tone: 'muted' },
        a11yLabel: 'Sam, $15.10, not paid yet, not received $15.10',
        notReceived: null,
      });
    }
    // A flag naming a former payer shows nothing.
    const former = svPlan(1510, {}, { flags: { [US]: fakeNotReceived(1510, UD) }, others: { [UD]: 300 } });
    expect(row(settlePeople(sv(former, UH)), US)).toMatchObject({ status: { text: 'Not yet' }, subLine: null, a11yLabel: 'Sam, $15.10, not paid yet' });
  });

  it('wideStatus false with no marked row and no difference', () => {
    const people = settlePeople(sv(svPlan(1510, {}, { others: { [UD]: 300 } }), UH));
    expect(people?.rows).toHaveLength(2); // positive control: the rows are there
    expect(people?.wideStatus).toBe(false);
  });
});

describe('A1 footer kinds (D5, SV-UX-10/11/12)', () => {
  it('ready owes: Venmo → pay (venmo action, the card\'s notes); Cash or no Venmo → cash', () => {
    const plan = svPlan(1510);
    const pay = settleFooterAction(sv(plan, US, { permissionUndetermined: true }), 2);
    expect(pay).toMatchObject({ kind: 'pay', button: { label: 'Pay Hana $15.10 on Venmo', action: { kind: 'pay', method: 'venmo' } } });
    expect(pay?.kind === 'pay' && pay.notes).toEqual(['@hana-1 · $15.10', "We'll check back in a minute to make sure it went through."]);
    for (const over of [{ rememberedMethod: 'cash' as const }, { payerVenmo: null }]) {
      expect(settleFooterAction(sv(plan, US, over), 2)).toEqual({
        kind: 'cash',
        button: {
          label: 'I paid Hana $15.10 in cash',
          a11yLabel: 'I paid Hana $15.10 in cash',
          a11yHint: 'Records that you paid in cash. Nothing opens.',
          action: { kind: 'mark', method: 'cash', payerId: UH, cents: 1510 },
        },
        notes: [],
        details: { label: 'Details', a11yLabel: 'Settle up details', a11yHint: "Shows who's paid and other ways to pay" },
      });
    }
  });

  it('inline check applies → sent_check: the full question, Yes, No, undo, Details (no primary)', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') });
    const facts = { key: CHECK_KEY, billId: BILL, payerId: UH, cents: 1510, markAtMs: SENT_MS };
    expect(settleFooterAction(sv(plan, US, { sentCheck: fresh() }), 2)).toEqual({
      kind: 'sent_check',
      text: 'Did your $15.10 to Hana go through?',
      yes: { label: 'Yes', a11yLabel: 'Yes, my $15.10 to Hana went through', action: { kind: 'sent_check_yes', ...facts } },
      undo: {
        label: 'No, undo',
        a11yLabel: 'No, undo my $15.10 to Hana',
        a11yHint: 'Clears Sent via Venmo for $15.10',
        action: { kind: 'sent_check_undo', ...facts },
      },
      details: { label: 'Details', a11yLabel: 'Settle up details', a11yHint: "Shows who's paid and other ways to pay" },
    });
    expect((settleFooterAction(sv(svPlan(1, { [US]: sm(1, 'venmo') }), US, { sentCheck: fresh() }), 2) as { text?: string }).text).toBe(
      'Did your $0.01 to Hana go through?',
    );
    // Early plans ask in the footer too, the same as the card.
    expect(settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, 'venmo') }, { early: true }), US, { sentCheck: fresh() }), 2)?.kind).toBe('sent_check');
  });

  it('ready marked, no difference: secondary Settle up, method caption, success, live', () => {
    const caption = (method: PaymentMethod) => settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, method) }), US), 2);
    expect(caption('venmo')).toEqual({ kind: 'settle', variant: 'secondary', caption: 'Sent to Hana · $15.10', a11yHint: 'See who paid', tone: 'success', live: true });
    expect(caption('cash')).toMatchObject({ variant: 'secondary', caption: 'Paid Hana in cash · $15.10', tone: 'success', live: true });
    expect(caption('other')).toMatchObject({ variant: 'secondary', caption: 'Marked paid · $15.10', tone: 'success', live: true });
  });

  it('early marked: method caption with the count, success, not live; billFooterAction keeps the method', () => {
    const early = (method: PaymentMethod) => settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, method) }, { early: true }), US), 2);
    expect(early('venmo')).toMatchObject({ kind: 'settle', variant: 'secondary', caption: 'Sent via Venmo · 1 item left to claim', tone: 'success' });
    expect(early('venmo')).not.toHaveProperty('live');
    expect(early('cash')).toMatchObject({ caption: 'Paid in cash · 1 item left to claim' });
    expect(early('other')).toMatchObject({ caption: 'Marked paid · 1 item left to claim' });
    expect(billFooterAction(early('cash'), 2, 0)).toMatchObject({ caption: 'Paid in cash · 2 items left to claim', tone: 'success' });
  });

  it('early, unmarked: "You can pay now" whatever the method or flag (no Pay or cash footer before completion)', () => {
    for (const over of [{ rememberedMethod: 'cash' as const }, { payerVenmo: null }, {}]) {
      const plan = svPlan(1510, {}, { early: true, flags: { [US]: fakeNotReceived(1510, UH) } });
      expect(settleFooterAction(sv(plan, US, over), 2)).toMatchObject({ kind: 'settle', variant: 'primary', caption: 'You can pay now · 1 item left to claim' });
    }
  });

  it('billFooterAction: a marked secondary footer passes through; sent_check passes through screen counts like did_you_pay', () => {
    const marked = settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, 'venmo') }), US), 2);
    expect(billFooterAction(marked, 0, 0)).toEqual(marked);
    const asking = settleFooterAction(sv(svPlan(1510, { [US]: sm(1510, 'venmo') }), US, { sentCheck: fresh() }), 2);
    expect(asking?.kind).toBe('sent_check');
    expect(billFooterAction(asking, 2, 0)).toEqual(asking);
    // The blocked footer still turns into today's primary once the screen shows nothing left.
    const blocked = settleFooterAction(sv({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, US), 2);
    expect(billFooterAction(blocked, 0, 0)).toMatchObject({ variant: 'primary', caption: null });
  });

  it('cash footer also follows on-screen counts (never a stale amount)', () => {
    const cash = settleFooterAction(sv(svPlan(1510), US, { rememberedMethod: 'cash' }), 2);
    expect(cash?.kind).toBe('cash');
    expect(billFooterAction(cash, 1, 0)).toMatchObject({ kind: 'settle', caption: '1 item left to claim' });
  });
});

describe('A1 actionError, copy constants and args', () => {
  it('mark_changed, invalid_method and the not-received variant', () => {
    expect(actionError('mark_changed')).toEqual({ text: 'Your payment just changed. Check the amount and try again.', refetch: true });
    expect(actionError('mark_changed', { notReceived: true })).toEqual({ text: "That payment just changed, so nothing was cleared. Check below.", refetch: true });
    expect(actionError('not_allowed', { notReceived: true })).toEqual({ text: BILL_ERROR_COPY.not_allowed, refetch: true });
    expect(actionError('invalid_method')).toEqual({ text: BILL_ERROR_COPY.invalid_method, refetch: false });
  });

  it('strings Task 9a shows around these models', () => {
    expect(SETTLE_COPY.alreadyMarked).toBe("You've already marked this. Check below.");
    expect(SETTLE_COPY.undoneNotSent).toBe('Undone. Not marked as sent.');
    expect(SETTLE_COPY.undoFailed).toBe("Couldn't undo. Try again.");
    expect(SETTLE_COPY.announceAllSet).toBe("You're all set");
    expect(SETTLE_COPY.announceCash).toBe('Marked paid in cash');
    expect(sentCheckChangedText('Hana')).toBe('Your payment to Hana changed since then, so nothing was undone. Check below.');
    expect(announceSentText('Hana', 1510)).toBe('Sent to Hana, $15.10');
    expect(announceNotReceivedText('Sam')).toBe('Marked not received. Sam will see it.');
  });

  it('differenceArgs carries the method as the last argument (settleDifference\'s order)', () => {
    expect(differenceArgs({ kind: 'mark_difference', method: 'cash', userId: US, payerId: UH, fromCents: 1510, toCents: 1620 })).toStrictEqual([US, UH, 1510, 1620, 'cash']);
  });

  it('settleViewInputFor: the bill id, the flags on the plan, and the device facts it\'s given', () => {
    const data = billData({ participants: [member(A, 'Hana', 'hana-1'), { ...member(B, 'Sam', TEJ), notReceived: fakeNotReceived(1510, A) }] });
    const got = settleViewInputFor(data, B, 'ios', null, { rememberedMethod: 'cash', sentCheck: fresh(), permissionUndetermined: true });
    expect(got).toMatchObject({ billId: 'bill-1', rememberedMethod: 'cash', sentCheck: fresh(), permissionUndetermined: true });
    const me = got.plan.status === 'ready' ? got.plan.people.find((p) => p.userId === B) : undefined;
    expect(me?.notReceived).toEqual(fakeNotReceived(1510, A));
    expect(settleViewInputFor(data, B, 'ios', null)).toMatchObject({ rememberedMethod: null, sentCheck: null, permissionUndetermined: false });
  });
});

describe('A1 glyph walk (VP-30) and copy with "You"', () => {
  it('no new model string contains a glyph', () => {
    const texts: string[] = [];
    const plans = [
      svPlan(1510),
      svPlan(1510, { [US]: sm(1510, 'venmo') }),
      svPlan(1510, { [US]: sm(1510, 'cash') }),
      svPlan(1620, { [US]: sm(1510, 'venmo') }),
      svPlan(1400, { [US]: sm(1510, 'cash') }),
      svPlan(1510, {}, { flags: { [US]: fakeNotReceived(1510, UH) } }),
      svPlan(1510, { [US]: sm(1510, 'venmo') }, { early: true }),
      svPlan(1510, { [US]: sm(1510, 'venmo'), [UD]: sm(300, 'cash') }, { others: { [UD]: 300 } }),
    ];
    for (const plan of plans) {
      for (const viewer of [UH, US, UD]) {
        for (const over of [{}, { rememberedMethod: 'cash' as const }, { payerVenmo: null }, { sentCheck: fresh(), platform: 'web' }, { permissionUndetermined: true }]) {
          const input = sv(plan, viewer, over);
          texts.push(...stringsIn(settleCard(input)), ...stringsIn(settlePeople(input)), ...stringsIn(settleFooterAction(input, 3)));
        }
      }
    }
    expect(texts.length).toBeGreaterThan(500);
    for (const t of texts) expect(t).not.toMatch(GLYPH);
  });

  it('the payer viewing never reads "You sent you"; own rows say "You"', () => {
    const plan = svPlan(1510, { [US]: sm(1510, 'venmo') });
    const all = [...stringsIn(settleCard(sv(plan, UH))), ...stringsIn(settlePeople(sv(plan, UH))), ...stringsIn(settlePeople(sv(plan, US)))];
    expect(all).toContain('Sam sent it via Venmo'); // positive control
    expect(all.some((t) => /You sent you|You's|You hasn't/.test(t))).toBe(false);
  });
});

describe('A1 live-check finding: a fetched flag reaches the card through settleViewInputFor', () => {
  it('a participant row carrying a flag to the current payer shows Sam the warning line', () => {
    const data = billData({ participants: [member(A, 'Hana', 'hana-1'), { ...member(B, 'Sam', TEJ), notReceived: fakeNotReceived(1510, A, 'venmo') }, member(D, 'Dee')] });
    const m = settleCard(settleViewInputFor(data, B, 'ios', null));
    expect(m.state).toBe('owes');
    expect(m.lines[0]).toEqual({ text: "Hana hasn't received your $15.10. Check Venmo before paying again.", tone: 'warning' });
    // Positive control: the same bill without the flag has no warning line.
    expect(settleCard(settleViewInputFor(billData(), B, 'ios', null)).lines.some((l) => l.tone === 'warning')).toBe(false);
  });
});

describe('afterOpenRefusal (review R1, D2: Venmo is already open, so the copy says to check it)', () => {
  it.each([
    ['already_marked', "Venmo opened, but this was already marked. Don't send it. Check Venmo before you pay again."],
    ['payer_changed', "Venmo opened, but who gets paid just changed. Don't send it. Check below before you pay."],
    ['mark_changed', "Venmo opened, but your payment just changed. Don't send it. Check below before you pay."],
    ['not_complete', "Venmo opened, but something on the bill just changed. Don't send it. Check your share below."],
    ['not_allowed', "Venmo opened, but this wasn't saved. Don't send it. Check Venmo before you pay again."],
    ['invalid_bill', "Venmo opened, but this wasn't saved. Don't send it. Check Venmo before you pay again."],
  ] as const)('%s', (code, text) => {
    expect(afterOpenRefusal(code)).toBe(text);
  });

  it('a "more" send: not_allowed means the mark moved (as actionError reads it)', () => {
    expect(afterOpenRefusal('not_allowed', { difference: true })).toBe(afterOpenRefusal('mark_changed'));
  });

  it('every line names Venmo and says not to send, so nobody pays twice', () => {
    for (const code of ['already_marked', 'payer_changed', 'mark_changed', 'not_complete', 'not_allowed', 'invalid_method', 'not_found'] as const) {
      const t = afterOpenRefusal(code);
      expect(t.startsWith('Venmo opened, but ')).toBe(true);
      expect(t).toContain("Don't send it.");
    }
  });
});

describe('announceDifferenceText (review R5): by method', () => {
  it('venmo says what was sent', () => expect(announceDifferenceText('venmo', 110)).toBe('Sent $1.10 more'));
  it('cash and another way keep "Difference marked paid"', () => {
    expect(announceDifferenceText('cash', 110)).toBe('Difference marked paid');
    expect(announceDifferenceText('other', 110)).toBe('Difference marked paid');
  });
});

// ---------------------------------------------------------------------------------------------------
// Who paid (docs/specs/2026-11-26-who-paid.md, A1.5, Task 7; criterion A-29). Plans come from
// ledgerSettlePlan, the function settleViewInputFor calls, never hand-built (lesson 2026-11-25 R6).
// Names: A Hana (host), B Sam, D Dee, E Ana. Expected amounts are worked out by hand from contract T.
// ---------------------------------------------------------------------------------------------------

const WP_VENMO: Record<string, string> = { A: 'hana-1', B: 'sam-2', D: 'dee-3', E: 'ana-5' };
const WAT = '2026-11-26T10:00:00.000001+00:00';

/** Each person's share is one item row they claim; no extras. `unclaimed` adds an unclaimed row. */
function sharesInput(shares: Record<string, number>, unclaimed = 0): SplitInput {
  const items = Object.entries(shares).map(([u, cents]) => ({ id: `row-${u}`, totalCents: cents }));
  if (unclaimed > 0) items.push({ id: 'left', totalCents: unclaimed });
  return {
    totalCents: items.reduce((s, i) => s + i.totalCents, 0),
    items,
    claims: Object.keys(shares).map((u) => c(`row-${u}`, u)),
    participantIds: Object.keys(shares).sort(),
    extrasMode: 'proportional',
  };
}

type WPay = { from: string; to: string; cents: number; key?: string | null; method?: PaymentMethod; id?: string };
const wpays = (ps: readonly WPay[]) =>
  ps.map((p, i) => ({
    id: p.id ?? `00000000-0000-4000-8000-00000000000${i}`,
    fromId: p.from,
    toId: p.to,
    cents: p.cents,
    method: p.method ?? ('venmo' as PaymentMethod),
    planKey: p.key ?? null,
    at: WAT,
  }));

function ledgerPlan(
  split: SplitInput,
  payerId: string,
  payers: { userId: string; paidCents: number }[] = [],
  payments: readonly WPay[] = [],
  flags: { fromId: string; toId: string; cents: number; method: PaymentMethod }[] = [],
) {
  return ledgerSettlePlan(split, { payerId, payers, payments: wpays(payments), flags }, { allowEarly: true });
}

/** The view input for a ledger plan, as settleViewInputFor wires it (planKey, payersMode). */
function lview(r: ReturnType<typeof ledgerPlan>, viewerId: string, over: Partial<SettleViewInput> = {}): SettleViewInput {
  const plan = r.plan;
  const lead = plan.status === 'routes' || plan.status === 'blocked_payers' ? plan.leadId : plan.status === 'ready' || plan.status === 'early' ? plan.payerId : A;
  return view(plan as SettlePlanWithEarly, viewerId, {
    plan,
    payerId: lead,
    payerVenmo: WP_VENMO[lead] ?? null,
    venmoOf: (u) => WP_VENMO[u] ?? null,
    planKey: r.planKey,
    payersMode: plan.status === 'routes' ? plan.mode : plan.status === 'blocked_payers' ? 'split' : 'one',
    ...over,
  });
}

// T5: paid A 5000, B 3000, E 2000; shares A 8000, B 1000, E 1000 → A→B 2000, A→E 1000.
const T5_SHARES = { A: 8000, B: 1000, E: 1000 };
const T5_PAYERS = [
  { userId: A, paidCents: 5000 },
  { userId: B, paidCents: 3000 },
  { userId: E, paidCents: 2000 },
];
// T2 shape: paid A 5000, B 5000; shares 2500 each → D→A 2500, E→B 2500.
const T2_SHARES = { A: 2500, B: 2500, D: 2500, E: 2500 };
const T2_PAYERS = [
  { userId: A, paidCents: 5000 },
  { userId: B, paidCents: 5000 },
];

describe('who paid · settleCards on a routes plan (A-29, M9, S5)', () => {
  it('T5: A owes two people: two owe cards, larger first, one filled Pay, distinct links, the heading', () => {
    const r = ledgerPlan(sharesInput(T5_SHARES), A, T5_PAYERS);
    const m = settleCards(lview(r, A));
    expect(m.heading).toBe('You owe 2 people · $30.00');
    expect(m.cards.map((x) => [x.state, x.label, x.amountCents])).toEqual([
      ['owes', 'You owe Sam', 2000],
      ['owes', 'You owe Ana', 1000],
    ]);
    const [first, second] = m.cards;
    expect(first?.primary).toMatchObject({
      label: 'Pay Sam $20.00 on Venmo',
      a11yLabel: 'Pay Sam $20.00 on Venmo, to @sam-2',
      action: { kind: 'pay', payerId: B, cents: 2000, url: venmoPayUrl({ username: 'sam-2', cents: 2000 }), planKey: r.planKey },
    });
    expect(first?.primary?.variant).toBeUndefined();
    expect(second?.primary).toMatchObject({
      label: 'Pay Ana $10.00 on Venmo',
      variant: 'secondary',
      action: { kind: 'pay', payerId: E, cents: 1000, url: venmoPayUrl({ username: 'ana-5', cents: 1000 }) },
    });
    expect(first?.primary?.a11yLabel).not.toBe(second?.primary?.a11yLabel);
    // Exactly one filled button across the cards.
    expect(m.cards.filter((x) => x.primary !== null && x.primary.variant === undefined)).toHaveLength(1);
    // settleCard is the first card.
    expect(settleCard(lview(r, A))).toEqual(first);
  });

  it('T5: the footer is the primary Settle up with the owed caption, and no Pay', () => {
    const r = ledgerPlan(sharesInput(T5_SHARES), A, T5_PAYERS);
    expect(settleFooterAction(lview(r, A), 3)).toEqual({
      kind: 'settle',
      variant: 'primary',
      caption: 'You owe 2 people · $30.00',
      a11yHint: 'See what you owe and pay',
    });
  });

  it("T5: once Sam's pair is marked with the current key, Ana's Pay is filled and the footer pays Ana", () => {
    const first = ledgerPlan(sharesInput(T5_SHARES), A, T5_PAYERS);
    const r = ledgerPlan(sharesInput(T5_SHARES), A, T5_PAYERS, [{ from: A, to: B, cents: 2000, key: first.planKey }]);
    const m = settleCards(lview(r, A));
    expect(m.cards.map((x) => [x.state, x.label])).toEqual([
      ['marked', 'You sent Sam'],
      ['owes', 'You owe Ana'],
    ]);
    expect(m.cards[1]?.primary?.variant).toBeUndefined();
    expect(m.heading).toBeNull(); // one person left to pay
    const f = settleFooterAction(lview(r, A), 3);
    expect(f).toMatchObject({ kind: 'pay', button: { action: { kind: 'pay', payerId: E, cents: 1000 } } });
    // The marked card's Undo names its pair, for unmarkPaid(bill, userId, payerId).
    expect(m.cards[0]?.secondary[0]?.action).toEqual({ kind: 'unmark', userId: A, payerId: B });
  });

  it('T1 shape: Dee pays two people; the S5 line says the share is split between them', () => {
    // Paid A 6000, B 4021; shares A 3341, B 3340, D 3340 → D→A 2659, D→B 681.
    const r = ledgerPlan(sharesInput({ A: 3341, B: 3340, D: 3340 }), A, [
      { userId: A, paidCents: 6000 },
      { userId: B, paidCents: 4021 },
    ]);
    const m = settleCards(lview(r, D));
    expect(m.cards.map((x) => [x.label, x.amountCents])).toEqual([
      ['You owe Hana', 2659],
      ['You owe Sam', 681],
    ]);
    expect(m.cards[0]?.lines).toContainEqual({ text: 'Hana and Sam split the paying. Your share is split between them.', tone: 'muted' });
    expect(m.cards[1]?.lines.some((l) => l.text.includes('split the paying'))).toBe(false);
    expect(m.heading).toBe('You owe 2 people · $33.40');
    expect(m.why).toBeNull();
  });

  it('T2 shape: one card for Dee, the S5 line, and the footer pays Hana', () => {
    const r = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS);
    const m = settleCards(lview(r, D));
    expect(m.cards).toHaveLength(1);
    expect(m.cards[0]).toMatchObject({ state: 'owes', label: 'You owe Hana', amountCents: 2500 });
    expect(m.cards[0]?.lines).toEqual([{ text: 'Hana and Sam split the paying. Paying Hana covers your share.', tone: 'muted' }]);
    expect(m.heading).toBeNull();
    const f = settleFooterAction(lview(r, D), 4);
    expect(f).toMatchObject({ kind: 'pay', button: { label: 'Pay Hana $25.00 on Venmo', action: { payerId: A, cents: 2500, planKey: r.planKey } } });
  });

  it('T2 shape: a payer sees what they paid and their share, and a card for who owes them', () => {
    const r = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS);
    const m = settleCards(lview(r, A));
    expect(m.why).toBe('You paid $50.00 · your share is $25.00');
    expect(m.cards).toHaveLength(1);
    expect(m.cards[0]).toMatchObject({ state: 'payer', label: '1 person owes you', amountCents: 2500 });
    expect(settleFooterAction(lview(r, A), 4)).toEqual({ kind: 'settle', variant: 'primary', caption: null, a11yHint: 'See what you owe and pay' });
  });

  it('T0: the sender is told her payment still counts; the holder sees what his card includes', () => {
    // Shares Dee 1200, Sam 1400, Hana 1400; Sam was the payer and Dee paid him 1200; now Hana pays.
    const r = ledgerPlan(sharesInput({ A: 1400, B: 1400, D: 1200 }), A, [], [{ from: D, to: B, cents: 1200 }]);
    expect(r.plan.status).toBe('routes');
    const dee = settleCards(lview(r, D));
    expect(dee.cards).toHaveLength(1);
    expect(dee.cards[0]).toMatchObject({ state: 'marked', label: 'You sent Sam', amountCents: 1200 });
    const sender = { text: 'Your $12.00 to Sam still counts. Sam passes it on to Hana.', tone: 'muted' };
    expect(dee.cards[0]?.lines).toContainEqual(sender);
    expect(settleFooterAction(lview(r, D), 3)).toMatchObject({ kind: 'settle', caption: sender.text });

    const sam = settleCards(lview(r, B));
    expect(sam.cards).toHaveLength(1);
    expect(sam.cards[0]).toMatchObject({ state: 'owes', label: 'You owe Hana', amountCents: 2600 });
    expect(sam.cards[0]?.lines).toContainEqual({ text: 'Includes $12.00 Dee sent you.', tone: 'muted' });

    expect(settleCards(lview(r, A)).cards[0]).toMatchObject({ state: 'payer', label: '1 person owes you', amountCents: 2600 });
  });

  describe('A-29b (review R1): a pair with paid ≤ 0 shows remainingCents everywhere, equal to balanceFor', () => {
    // T13: total $10.00, payers A 600 / B 400. Under the first shares (A 300, B 700) B paid A $3.00;
    // the shares are now A 800, B 200, so the pair is A→B with target 200, paid −300, remaining 500.
    const firstT13 = ledgerPlan(sharesInput({ A: 300, B: 700 }), A, [
      { userId: A, paidCents: 600 },
      { userId: B, paidCents: 400 },
    ]);
    const t13 = ledgerPlan(
      sharesInput({ A: 800, B: 200 }),
      A,
      [
        { userId: A, paidCents: 600 },
        { userId: B, paidCents: 400 },
      ],
      [{ from: B, to: A, cents: 300, key: firstT13.planKey }],
    );

    it('T13: the plan really is target 200, paid −300, remaining 500 (positive control)', () => {
      expect(t13.plan.status).toBe('routes');
      if (t13.plan.status !== 'routes') return;
      expect(t13.plan.pairs).toEqual([expect.objectContaining({ fromId: A, toId: B, targetCents: 200, paidCents: -300, remainingCents: 500 })]);
      const bal = balanceFor(t13.plan, A);
      expect(bal).toEqual({ known: true, final: true, owesCents: 500, owedCents: 0 });
    });

    it('T13, A (the payer of the pair): card, Venmo link and cash button are $5.00', () => {
      const card = settleCards(lview(t13, A)).cards[0];
      expect(card).toMatchObject({ state: 'owes', label: 'You owe Sam', amountCents: 500 });
      expect(card?.primary?.action).toMatchObject({ kind: 'pay', payerId: B, cents: 500, url: venmoPayUrl({ username: 'sam-2', cents: 500 }) });
      const cashCard = settleCards(lview(t13, A, { rememberedMethod: 'cash' })).cards[0];
      expect(cashCard?.primary).toMatchObject({ label: 'I paid Sam $5.00 in cash', action: { kind: 'mark', method: 'cash', payerId: B, cents: 500 } });
      const f = settleFooterAction(lview(t13, A), 2);
      expect(f).toMatchObject({ kind: 'pay', button: { action: { cents: 500 } } });
    });

    it("T13, B (the pair's recipient): the payer card and Hana's Request row are $5.00", () => {
      const m = settleCards(lview(t13, B));
      expect(m.cards[0]).toMatchObject({ state: 'payer', amountCents: 500 });
      const row = settlePeople(lview(t13, B))?.rows.find((x) => x.userId === A);
      expect(row?.request).toMatchObject({ userId: A, cents: 500 });
      expect(row?.a11yLabel).toContain('$5.00');
      if (t13.plan.status === 'routes') expect(balanceFor(t13.plan, B)).toMatchObject({ owedCents: 500 });
    });

    it('T0: Sam (paid 0 on his pair) owes Hana $26.00 on the card, link, cash button and her Request row', () => {
      const r = ledgerPlan(sharesInput({ A: 1400, B: 1400, D: 1200 }), A, [], [{ from: D, to: B, cents: 1200 }]);
      if (r.plan.status !== 'routes') throw new Error('expected routes');
      expect(balanceFor(r.plan, B)).toMatchObject({ owesCents: 2600 });
      const card = settleCards(lview(r, B)).cards[0];
      expect(card).toMatchObject({ amountCents: 2600, primary: { action: { cents: 2600, url: venmoPayUrl({ username: 'hana-1', cents: 2600 }) } } });
      expect(settleCards(lview(r, B, { rememberedMethod: 'cash' })).cards[0]?.primary?.label).toBe('I paid Hana $26.00 in cash');
      const row = settlePeople(lview(r, A))?.rows.find((x) => x.userId === B);
      expect(row?.request).toMatchObject({ userId: B, cents: 2600 });
    });
  });

  it("the holder line counts several senders: 'Includes $21.00 that 2 people sent you.'", () => {
    // Shares Dee 1200, Ana 900, Sam 1400, Hana 1400; Dee and Ana paid Sam earlier; Hana pays now.
    const r = ledgerPlan(sharesInput({ A: 1400, B: 1400, D: 1200, E: 900 }), A, [], [
      { from: D, to: B, cents: 1200 },
      { from: E, to: B, cents: 900 },
    ]);
    expect(settleCards(lview(r, B)).cards[0]?.lines).toContainEqual({ text: 'Includes $21.00 that 2 people sent you.', tone: 'muted' });
  });

  it('a split bill that is incomplete: the blocked card says why it waits (D11)', () => {
    const r = ledgerPlan(sharesInput({ A: 3000, B: 3000, D: 2000 }, 1000), A, [
      { userId: A, paidCents: 5000 },
      { userId: B, paidCents: 4000 },
    ]);
    expect(r.plan.status).toBe('blocked');
    const m = settleCard(lview(r, D, { payersMode: 'split' }));
    expect(m.state).toBe('blocked');
    expect(m.lines).toContainEqual({ text: 'Settling starts once every item is claimed, because more than one person paid.', tone: 'muted' });
    // One person: no such line (positive control: the same bill, one payer, is early for Dee).
    const one = ledgerPlan(sharesInput({ A: 3000, B: 3000, D: 2000 }, 1000), A);
    expect(one.plan.status).toBe('early');
  });
});

describe('who paid · blocked_payers (S6, A-29)', () => {
  // Payers add up to 10021, the total is 10321 (the host raised the tip by $3.00).
  const r = ledgerPlan(sharesInput({ A: 5000, B: 5321 }), A, [
    { userId: A, paidCents: 6000 },
    { userId: B, paidCents: 4021 },
  ]);

  it('the plan is blocked_payers', () => {
    expect(r.plan).toMatchObject({ status: 'blocked_payers', gapCents: 300, assignedCents: 10021 });
  });

  it('host: the card names the gap and offers Fix who paid', () => {
    const m = settleCard(lview(r, A));
    expect(m).toMatchObject({
      state: 'blocked_payers',
      label: "Who paid doesn't match the bill total",
      amountCents: null,
      lines: [{ text: '$100.21 of $103.21 is assigned.', tone: 'warning' }],
      primary: { label: 'Fix who paid', a11yLabel: 'Fix who paid', action: { kind: 'fix_payers' } },
      secondary: [],
    });
  });

  it('others: the host needs to update it, no button', () => {
    const m = settleCard(lview(r, B));
    expect(m.lines).toEqual([
      { text: '$100.21 of $103.21 is assigned.', tone: 'warning' },
      { text: 'Hana needs to update it before anyone can settle up.', tone: 'muted' },
    ]);
    expect(m.primary).toBeNull();
  });

  it('more than the total reads the same way', () => {
    const over = ledgerPlan(sharesInput({ A: 5000, B: 4721 }), A, [
      { userId: A, paidCents: 6000 },
      { userId: B, paidCents: 4021 },
    ]);
    expect(settleCard(lview(over, A)).lines[0]?.text).toBe('$100.21 of $97.21 is assigned.');
  });

  it('footer: host primary "Who paid needs fixing"; others secondary "Waiting for Hana"', () => {
    expect(settleFooterAction(lview(r, A), 2)).toEqual({
      kind: 'settle',
      variant: 'primary',
      caption: 'Who paid needs fixing',
      a11yHint: 'Who paid needs fixing before anyone can settle up',
      tone: 'warning',
    });
    expect(settleFooterAction(lview(r, B), 2)).toEqual({
      kind: 'settle',
      variant: 'secondary',
      caption: 'Waiting for Hana',
      a11yHint: 'Waiting for Hana to update who paid',
    });
  });

  it('no Everyone list and no Venmo prompt', () => {
    expect(settlePeople(lview(r, A))).toBeNull();
    expect(addVenmoPrompt(lview(r, A, { payerVenmo: null, venmoOf: () => null }))).toBeNull();
  });
});

describe('who paid · settlePeople on a routes plan (S4)', () => {
  it('T2 shape, Hana: grouped by recipient, "Paying you" first, a11y names the recipient', () => {
    const r = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS);
    const m = settlePeople(lview(r, A, { venmoOf: (u) => WP_VENMO[u] ?? null }));
    expect(m?.groups?.map((g) => [g.label, g.rows.map((x) => x.userId)])).toEqual([
      ['Paying you', [D]],
      ['Paying Sam', [E]],
    ]);
    expect(m?.rows.map((x) => x.userId)).toEqual([D, E]);
    expect(m?.groups?.[0]?.rows[0]?.a11yLabel).toBe('Dee, $25.00 to you, not paid yet');
    expect(m?.groups?.[1]?.rows[0]?.a11yLabel).toBe('Ana, $25.00 to Sam, not paid yet');
    // Hana's Request is only on her own group's row.
    expect(m?.groups?.[0]?.rows[0]?.request).toMatchObject({ kind: 'link', userId: D, cents: 2500 });
    expect(m?.groups?.[1]?.rows[0]?.request).toBeNull();
    expect(m?.aside).toBeNull();
  });

  it('T2 shape, Dee: her own row under Paying Hana; the aside counts every pair', () => {
    const r = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS);
    const m = settlePeople(lview(r, D));
    expect(m?.groups?.map((g) => [g.label, g.rows.map((x) => x.name)])).toEqual([
      ['Paying Hana', ['You']],
      ['Paying Sam', ['Ana']],
    ]);
    expect(m?.aside).toBe('0 of 2 settled up');
  });

  it('one recipient: no group label, rows as today', () => {
    const r = ledgerPlan(sharesInput({ A: 1400, B: 1400, D: 1200 }), A, [], [{ from: D, to: B, cents: 1200 }]);
    const m = settlePeople(lview(r, D));
    // Pairs Dee→Sam (settled) and Sam→Hana: two recipients, so labels show.
    expect(m?.groups?.map((g) => g.label)).toEqual(['Paying Hana', 'Paying Sam']);
    const single = ledgerPlan(sharesInput({ A: 1000, B: 600, D: 400 }), A, [{ userId: A, paidCents: 1000 }, { userId: B, paidCents: 1000 }]);
    expect(single.plan.status).toBe('routes');
    const s = settlePeople(lview(single, D));
    expect(s?.groups?.map((g) => g.label)).toEqual([null]);
    expect(s?.rows[0]?.a11yLabel).toBe('You, $4.00, not paid yet');
  });

  it("an off-route payment (T9 shape): the recipient's row offers the pay-back, stamped with the plan key", () => {
    const first = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS);
    // Dee pays Sam 2500 with the current key, though her route is to Hana.
    const r = ledgerPlan(sharesInput(T2_SHARES), A, T2_PAYERS, [{ from: D, to: B, cents: 2500, key: first.planKey }]);
    const row = settlePeople(lview(r, B))?.rows.find((x) => x.userId === D);
    expect(row?.status?.text).toBe('You owe $25.00 back');
    expect(row?.payBack?.record.action).toEqual({
      kind: 'mark_difference',
      method: 'other',
      userId: D,
      payerId: B,
      fromCents: 2500,
      toCents: 0,
      planKey: r.planKey,
    });
  });
});

describe('who paid · settleViewInputFor wiring (lesson 2026-11-27: through the caller)', () => {
  const people3 = [member(A, 'Hana', 'hana-1'), member(B, 'Sam', 'sam-2'), member(D, 'Dee')];

  it('a split bill: the plan is ledgerSettlePlan’s, with its key and the mode', () => {
    const data: BillData = {
      ...billData({ participants: people3 }),
      payers: [
        { userId: A, paidCents: 2000 },
        { userId: B, paidCents: 1600 },
      ],
    };
    const input = settleViewInputFor(data, D, 'ios', null);
    const want = ledgerSettlePlan(splitInputFor(data, data.claims), { payerId: A, payers: data.payers, payments: [], flags: [] }, { allowEarly: true });
    expect(input.plan).toEqual(want.plan);
    expect(input.planKey).toBe(want.planKey);
    expect(input.payersMode).toBe('split');
  });

  it('a one-person bill: same plan as settlePlan, and actions carry the key', () => {
    const data = billData({ participants: people3 });
    const input = settleViewInputFor(data, B, 'ios', null);
    expect(input.payersMode).toBe('one');
    expect(input.planKey).toMatch(/^[0-9a-f]{16}$/);
    expect(settleCard(input).primary?.action).toMatchObject({ kind: 'pay', payerId: A, cents: 1510, planKey: input.planKey });
    // Without a key (the regression builder), actions are exactly today's.
    expect(settleCard({ ...input, planKey: undefined }).primary?.action).not.toHaveProperty('planKey');
  });

  it('a payment to an ex-payer makes viewerMarked true for its sender', () => {
    const data: BillData = {
      ...billData({ participants: people3 }),
      payments: wpays([{ from: D, to: B, cents: 100 }]),
    };
    expect(settleViewInputFor(data, D, 'ios', null).viewerMarked).toBe(true);
    expect(settleViewInputFor(billData({ participants: people3 }), D, 'ios', null).viewerMarked).toBe(false);
  });
});

describe('who paid · contract O and the open-failed line on a routes plan', () => {
  const r = ledgerPlan(sharesInput(T5_SHARES), A, T5_PAYERS);

  it("an opened Venmo to Ana keeps its question on Ana's card only", () => {
    const opened = { payerId: E, cents: 1000 };
    expect(openedStillMatches(r.plan, A, opened)).toBe(true);
    expect(openedStillMatches(r.plan, A, { payerId: D, cents: 1000 })).toBe(false);
    const m = settleCards(lview(r, A, { openedVenmo: opened }));
    expect(m.cards.map((x) => x.state)).toEqual(['owes', 'owes_opened']);
    expect(m.cards[1]?.label).toBe('Did you send Ana $10.00?');
  });

  it('payOpenFailedLine follows the pair it was about', () => {
    expect(payOpenFailedLine(lview(r, A), { payerId: E, cents: 1000, handle: 'ana-5' })).toBe(openFailedText('ana-5', 1000));
    expect(payOpenFailedLine(lview(r, A), { payerId: E, cents: 999, handle: 'ana-5' })).toBeNull();
  });
});

describe('who paid · pickerDecision and the payer-change confirms (A1.5 M8, contract M)', () => {
  const nameOf = makeNameOf(PEOPLE, A);

  it('one person, payments moved from the viewer: names, total and "pass it on"', () => {
    const d = pickerDecision({
      targetId: B,
      payerId: A,
      moved: [
        { fromId: D, toId: A, cents: 1510 },
        { fromId: E, toId: A, cents: 1200 },
      ],
      complete: true,
      viewerId: A,
      nameOf,
    });
    expect(d).toEqual({
      kind: 'confirm',
      title: 'Dee and Ana already paid you',
      text: "If you switch to Sam, their payments still count. You'll pass $27.10 on to Sam.",
      button: 'Switch to Sam',
      cancelA11yLabel: 'Cancel: keep you as the payer',
    });
  });

  it('one person, the old payer is someone else', () => {
    const d = pickerDecision({ targetId: D, payerId: B, moved: [{ fromId: E, toId: B, cents: 900 }], complete: false, viewerId: A, nameOf });
    expect(d).toEqual({
      kind: 'confirm',
      title: 'Ana already paid Sam',
      text: "If you switch to Dee, Ana's $9.00 still counts. Sam will pass it on to Dee.",
      button: 'Switch to Dee',
      cancelA11yLabel: 'Cancel: keep Sam as the payer',
    });
  });

  it('switching to yourself: "If you become the payer … pass it on to you"', () => {
    const d = pickerDecision({ targetId: A, payerId: B, moved: [{ fromId: E, toId: B, cents: 900 }], complete: false, viewerId: A, nameOf });
    expect(d).toMatchObject({ text: "If you become the payer, Ana's $9.00 still counts. Sam will pass it on to you.", button: 'Switch to You' });
  });

  it('four senders: two names, then "and 2 others" (A1.5 names rule)', () => {
    const viewerB = makeNameOf(PEOPLE, B);
    const d = pickerDecision({
      targetId: B,
      payerId: D,
      moved: [A, E, 'Y', 'Z'].map((fromId) => ({ fromId, toId: D, cents: 100 })),
      complete: true,
      viewerId: B,
      nameOf: viewerB,
    });
    expect(d).toMatchObject({ title: 'Hana, Ana and 2 others already paid Dee', text: "If you become the payer, their payments still count. Dee will pass $4.00 on to you." });
    const three = pickerDecision({ targetId: B, payerId: D, moved: [A, E, 'Y'].map((fromId) => ({ fromId, toId: D, cents: 100 })), complete: true, viewerId: B, nameOf: viewerB });
    expect(three).toMatchObject({ title: 'Hana, Ana and Someone already paid Dee' });
  });

  it('nothing moved: complete asks; incomplete is direct; the current payer is a no-op', () => {
    expect(pickerDecision({ targetId: B, payerId: D, moved: [], complete: true, viewerId: A, nameOf })).toEqual({
      kind: 'confirm',
      title: null,
      text: 'Switch to Sam? People may already be paying Dee.',
      button: 'Switch to Sam',
      cancelA11yLabel: 'Cancel: keep Dee as the payer',
    });
    expect(pickerDecision({ targetId: B, payerId: A, moved: [], complete: true, viewerId: A, nameOf })).toMatchObject({
      text: 'Switch to Sam? People may already be paying you.',
    });
    expect(pickerDecision({ targetId: B, payerId: A, moved: [], complete: false, viewerId: A, nameOf })).toEqual({ kind: 'direct' });
    expect(pickerDecision({ targetId: A, payerId: A, moved: [{ fromId: B, toId: A, cents: 1 }], complete: true, viewerId: A, nameOf })).toEqual({
      kind: 'noop',
    });
  });

  it('the moved list comes from paymentsMovedBy (contract M), not from marks', () => {
    const moved = paymentsMovedBy(
      [
        { fromId: D, toId: A, netCents: 1510 },
        { fromId: E, toId: B, netCents: 900 },
      ],
      [A],
      [B],
    );
    expect(pickerDecision({ targetId: B, payerId: A, moved, complete: false, viewerId: A, nameOf })).toMatchObject({ title: 'Dee already paid you' });
  });

  it('split save that moves payments: confirm; amounts only with payments: the note', () => {
    expect(splitSaveDecision({ moved: [{ fromId: E, toId: B, cents: 900 }], paidIds: [E], viewerId: A, nameOf })).toEqual({
      confirm: {
        title: 'Ana already paid Sam',
        text: "Saving takes Sam off who paid. Ana's $9.00 still counts, and Sam will pass it on.",
        button: 'Save',
        cancelA11yLabel: 'Cancel: keep who paid as it is',
      },
      note: null,
    });
    expect(splitSaveDecision({ moved: [], paidIds: [D], viewerId: A, nameOf })).toEqual({
      confirm: null,
      note: 'Dee already paid. Their payment still counts after this change.',
    });
    expect(splitSaveDecision({ moved: [], paidIds: [D, E], viewerId: A, nameOf })).toEqual({
      confirm: null,
      note: 'Dee and Ana already paid. Their payments still count after this change.',
    });
    expect(splitSaveDecision({ moved: [], paidIds: [], viewerId: A, nameOf })).toEqual({ confirm: null, note: null });
  });
});
