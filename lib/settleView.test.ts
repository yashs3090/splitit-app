// Settle view logic: criteria 41b–41d (spec Amendment A1, Task 8) and the brief's §10 copy.
// Settle early and differences (docs/specs/2026-11-25-settle-early-and-differences.md, Task 6):
// criteria 26–34, 59, 60, 64, 66, 67 at the end of this file.
import { makeNameOf, splitInputFor } from './billView';
import { BILL_ERROR_COPY } from './bills';
import type { BillData } from './bills';
import { billMarker } from './homeMarkers';
import { claimedItemNames, venmoPayUrl, venmoRequestUrl } from './paylinks';
import {
  differenceFor,
  SETTLE_ALL_ZERO_COPY,
  settlePlan,
  type SettleMarks,
  type SettlePlan,
  type SettlePlanWithEarly,
} from './settle';
import {
  actionError,
  addVenmoPrompt,
  differenceArgs,
  openedFor,
  billFooterAction,
  canChangePayer,
  payerAllPaidLine,
  noticeFor,
  openedStillMatches,
  payerIdOf,
  payerLine,
  pickerDecision,
  pickerRows,
  settleCard,
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
  SETTLE_COPY,
  type OpenedVenmo,
  type SettleCardModel,
  type SettleFooterAction,
  type SettlePeopleModel,
  type SettleViewInput,
} from './settleView';
import type { SplitClaim, SplitInput } from './split';

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
    viewerItemNames: [],
    venmoOf: () => null,
    itemNamesOf: () => [],
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
      a11yHint: 'Opens Venmo',
      action: { kind: 'pay', url, payerId: A, cents: 1510 },
    });
    expect(m.secondary).toEqual([
      { label: 'I already paid', a11yLabel: 'I already paid', a11yHint: 'Marks your share as paid', action: { kind: 'mark', payerId: A, cents: 1510 } },
    ]);
  });

  it('3.1 on web adds the computer line (and not on ios)', () => {
    expect(settleCard(view(plan, B, { platform: 'web' })).notes).toEqual([
      '@hana-1 · $15.10',
      'On a computer? Send it from the Venmo app on your phone.',
    ]);
    expect(settleCard(view(plan, B, { platform: 'android' })).notes).toEqual(['@hana-1 · $15.10']);
  });

  it('3.2 after Pay: "Did you pay Hana?" with I paid as the primary', () => {
    const m = settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: 1510 }, platform: 'web' }));
    expect(m).toMatchObject({ state: 'owes_opened', label: 'Did you pay Hana?', amountCents: 1510 });
    expect(m.primary).toMatchObject({ label: 'I paid', action: { kind: 'mark', payerId: A, cents: 1510 } });
    expect(m.notes).toEqual(['@hana-1 · $15.10', 'On a computer? Send it from the Venmo app on your phone.']);
    expect(m.secondary).toEqual([
      { label: 'Open Venmo again', a11yLabel: 'Open Venmo again', a11yHint: 'Opens Venmo', action: { kind: 'pay', url, payerId: A, cents: 1510 } },
    ]);
  });

  it('criterion 6 (Venmo note spec N4): Pay and "Open Venmo again" carry the viewer’s item names in the note', () => {
    const itemNames = ['Salad', 'Fries'];
    const named = venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames });
    expect(named).toBe('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries');
    const before = settleCard(view(plan, B, { viewerItemNames: itemNames }));
    expect(before.primary?.action).toEqual({ kind: 'pay', url: named, payerId: A, cents: 1510 });
    const after = settleCard(view(plan, B, { viewerItemNames: itemNames, openedVenmo: { payerId: A, cents: 1510 } }));
    expect(after.secondary[0]?.action).toEqual({ kind: 'pay', url: named, payerId: A, cents: 1510 });
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
    const m = settleCard(view(settlePlan(worked(), A, { B: { cents: 1510, at } }), B));
    expect(m).toMatchObject({
      state: 'marked',
      label: 'You paid Hana',
      amountCents: 1510,
      lines: [{ text: 'Marked paid', tone: 'success', live: true }],
      primary: null,
    });
    expect(m.secondary).toEqual([{ label: 'Undo', a11yLabel: 'Undo your I paid', action: { kind: 'unmark', userId: B } }]);
  });

  it('3.5 the payer has no Venmo: no Pay button, I paid is the only action', () => {
    const m = settleCard(view(plan, B, { payerVenmo: null }));
    expect(m).toMatchObject({
      state: 'owes_no_venmo',
      label: 'You owe Hana',
      amountCents: 1510,
      lines: [{ text: "Hana hasn't added Venmo yet. Ask them, or pay another way.", tone: 'muted' }],
      notes: [],
      secondary: [],
    });
    expect(m.primary).toMatchObject({ label: 'I paid', action: { kind: 'mark', payerId: A, cents: 1510 } });
  });
});

describe('settleCard: share changed since the mark (Task 6: 3.4 is replaced by more_due / back_due)', () => {
  const mark = { B: { cents: 1510, at } };
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
      lines: [{ text: "Your share is now $0.00. You've marked $15.10 paid.", tone: 'muted' }],
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
      lines: [{ text: '0 of 2 paid', live: true }],
      primary: null,
    });
  });

  it('3.8 payer, some marked', () => {
    expect(settleCard(view(three({ B: { cents: 500, at } }), A)).lines[0]?.text).toBe('1 of 2 paid');
  });

  it('3.8 payer, all marked', () => {
    expect(settleCard(view(three({ B: { cents: 500, at }, D: { cents: 300, at } }), A))).toMatchObject({
      state: 'payer_all_paid',
      label: "Everyone's paid",
      amountCents: 800,
      lines: [{ text: 'All 2 marked paid', tone: 'success' }],
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
    expect(payerLine(view(plan, B))).toBeNull();
    expect(canChangePayer(A, A, 2, plan)).toBe(false);
  });

  it('blocked plans have no Everyone list', () => {
    expect(settlePeople(view(k2, A))).toBeNull();
  });
});

describe('payer line and Change', () => {
  it('names the payer, "You" for the payer', () => {
    const plan = settlePlan(worked(), A, {});
    expect(payerLine(view(plan, B))).toBe('Hana paid the bill');
    expect(payerLine(view(plan, A))).toBe('You paid the bill');
  });
  it('Change: host only, 2+ participants', () => {
    const plan = settlePlan(worked(), A, {});
    expect(canChangePayer(A, A, 2, plan)).toBe(true);
    expect(canChangePayer(A, A, 1, plan)).toBe(false);
    expect(canChangePayer(B, A, 3, plan)).toBe(false);
  });
});

describe('settlePeople (brief §4)', () => {
  it('payer view: B Paid, D Not yet, no payer row, and no aside (the card says "1 of 2 paid", R4)', () => {
    const m = settlePeople(view(three({ B: { cents: 500, at } }), A));
    expect(m?.title).toBe('Everyone');
    expect(m?.aside).toBeNull();
    expect(m?.rows.map((r) => [r.name, r.amountCents, r.status?.text ?? null, r.a11yLabel])).toEqual([
      ['Sam', 500, 'Paid', 'Sam, $5.00, paid'],
      ['Dee', 300, 'Not yet', 'Dee, $3.00, not paid yet'],
    ]);
  });

  it('everyone else sees the aside: "1 of 2 paid", then "All paid"', () => {
    expect(settlePeople(view(three({ B: { cents: 500, at } }), B))?.aside).toBe('1 of 2 paid');
    expect(settlePeople(view(three({ B: { cents: 500, at }, D: { cents: 300, at } }), D))?.aside).toBe('All paid');
  });

  it('R4: the payer never gets the aside, all paid included', () => {
    expect(settlePeople(view(three({ B: { cents: 500, at }, D: { cents: 300, at } }), A))?.aside).toBeNull();
  });

  it('the viewer comes first as "You", and the order is stable', () => {
    const rows = settlePeople(view(three(), D))?.rows ?? [];
    expect(rows.map((r) => r.name)).toEqual(['You', 'Sam']);
    const marked = settlePeople(view(three({ D: { cents: 300, at } }), D))?.rows ?? [];
    expect(marked.map((r) => r.name)).toEqual(['You', 'Sam']);
  });

  it('leaves out people who owe nothing, unless they have a mark', () => {
    const plan = settlePlan(worked({ participantIds: [A, B, D] }), A, {});
    expect(settlePeople(view(plan, A))?.rows.map((r) => r.userId)).toEqual([B]);
    const markedD = settlePlan(worked({ participantIds: [A, B, D] }), A, { D: { cents: 200, at } });
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
    const plan = three({ B: { cents: 450, at } });
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
    const p = settlePlan(input, D, { B: { cents: 500, at }, A: { cents: 1000, at } });
    const hostRows = settlePeople(view(p, A))?.rows ?? [];
    expect(hostRows.find((r) => r.userId === A)?.undo).toBeNull();
    expect(hostRows.find((r) => r.userId === B)?.undo).toEqual({ userId: B, confirm: true, a11yLabel: "Undo Sam's I paid", confirmText: 'Undo Sam\'s "I paid"?' });
    const payerRows = settlePeople(view(p, D))?.rows ?? [];
    expect(payerRows.find((r) => r.userId === B)?.undo?.confirm).toBe(true);
    expect(payerRows.find((r) => r.userId === A)?.undo?.confirmText).toBe('Undo Hana\'s "I paid"?');
    const bRows = settlePeople(view(p, B))?.rows ?? [];
    expect(bRows.every((r) => r.undo === null)).toBe(true);
  });
});

describe('picker (brief §5, criterion 41c)', () => {
  const nameOf = makeNameOf(PEOPLE, A);
  it('rows: the viewer first, current payer checked', () => {
    expect(pickerRows([B, A, D], A, A, nameOf)).toEqual([
      { userId: A, name: 'You', checked: true },
      { userId: B, name: 'Sam', checked: false },
      { userId: D, name: 'Dee', checked: false },
    ]);
  });
  it('2 marks: the clear text with both names, expected 2', () => {
    expect(pickerDecision({ targetId: B, payerId: A, markedIds: [A, D], complete: true, viewerId: A, nameOf })).toEqual({
      kind: 'confirm',
      text: 'Switch to Sam? This clears 2 "I paid" marks (Dee, You).',
      button: 'Switch to Sam',
      expectedCleared: 2,
    });
  });
  it('1 mark: singular', () => {
    const d = pickerDecision({ targetId: B, payerId: A, markedIds: [D], complete: false, viewerId: A, nameOf });
    expect(d).toMatchObject({ text: 'Switch to Sam? This clears 1 "I paid" mark (Dee).', expectedCleared: 1 });
  });
  it('0 marks and complete: "People may already be paying Hana."', () => {
    const d = pickerDecision({ targetId: B, payerId: D, markedIds: [], complete: true, viewerId: A, nameOf });
    expect(d).toEqual({ kind: 'confirm', text: 'Switch to Sam? People may already be paying Dee.', button: 'Switch to Sam', expectedCleared: 0 });
  });
  it('0 marks and complete, the host is the payer: "paying you"', () => {
    expect(pickerDecision({ targetId: B, payerId: A, markedIds: [], complete: true, viewerId: A, nameOf })).toMatchObject({
      text: 'Switch to Sam? People may already be paying you.',
    });
  });
  it('0 marks and incomplete: no confirm', () => {
    expect(pickerDecision({ targetId: B, payerId: A, markedIds: [], complete: false, viewerId: A, nameOf })).toEqual({ kind: 'direct', expectedCleared: 0 });
  });
  it('the current payer: no-op', () => {
    expect(pickerDecision({ targetId: A, payerId: A, markedIds: [B], complete: true, viewerId: A, nameOf })).toEqual({ kind: 'noop' });
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
  ] as const)('%s', (code, text, refetch) => {
    expect(actionError(code)).toEqual({ text, refetch });
  });
});

describe('settleFooter (brief §7)', () => {
  it('hidden with 1 participant', () => expect(settleFooter(1, 0)).toBeNull());
  it('incomplete: secondary with the plural caption', () => {
    expect(settleFooter(2, 1)).toEqual({ variant: 'secondary', caption: '1 item left to claim', a11yHint: '1 item left to claim first' });
    expect(settleFooter(3, 3)?.caption).toBe('3 items left to claim');
  });
  it('R1 (Amendment A1): names discounts when only discounts, or both kinds, are left', () => {
    expect(settleFooter(2, 1, 1)).toEqual({
      variant: 'secondary',
      caption: '1 discount left to claim',
      a11yHint: '1 discount left to claim first',
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
  for (const n of [1, 2, 5]) expect(payerAllPaidLine(n)).not.toMatch(GLYPH);
  // Sentence builders too (R8): the share-changed lines and the row sub-line "Marked … · share now …".
  const changed = [bOwesReady(1620, { B: { cents: 1510, at } }), bOwesReady(1400, { B: { cents: 1510, at } })];
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
    expect(openedStillMatches(settlePlan(worked(), A, { B: { cents: 1510, at } }), B, { payerId: A, cents: 1510 })).toBe(false);
    expect(openedStillMatches({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B, { payerId: A, cents: 1510 })).toBe(false);
    expect(openedStillMatches(plan, A, { payerId: A, cents: 1510 })).toBe(false); // the payer owes nothing
  });
  it('payerIdOf reads the bill', () => {
    expect(payerIdOf({ bill: { payer_id: D } })).toBe(D);
  });
});

describe('payerAllPaidLine', () => {
  it('reads naturally for one person (QA copy nit, 2026-11-24)', () => {
    expect(payerAllPaidLine(1)).toBe('They marked paid');
  });
  it('counts two or more', () => {
    expect(payerAllPaidLine(2)).toBe('All 2 marked paid');
    expect(payerAllPaidLine(5)).toBe('All 5 marked paid');
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
    const row = rowOf(view(oneOwer(1510, { B: { cents: 1510, at } }), A, { venmoOf: venmoB }), B);
    expect(row?.request).toBeNull();
    expect(row).toMatchObject({ status: { text: 'Paid' }, subLine: null });
    expect(row?.undo).not.toBeNull();
  });

  it('Q6 (reversed by Task 6, SE-4): more due → a Request for the difference; back due → no request, a pay-back instead', () => {
    const up = rowOf(view(oneOwer(700, { B: { cents: 500, at } }), A, { venmoOf: venmoB }), B);
    expect(up?.request).toMatchObject({ kind: 'link', cents: 200, label: 'Request $2.00' });
    expect(up?.subLine).toEqual({ text: 'Marked $5.00 · share now $7.00', tone: 'muted' });
    const down = rowOf(view(oneOwer(500, { B: { cents: 700, at } }), A, { venmoOf: venmoB }), B);
    expect(down?.request).toBeNull();
    expect(down?.payBack?.link).toMatchObject({ kind: 'link', cents: 200, label: 'Pay $2.00 back' });
    expect(down?.subLine).toEqual({ text: 'Marked $7.00 · share now $5.00', tone: 'muted' });
  });

  it('Q7: someone who owes nothing but has a mark → no request', () => {
    const plan = oneOwer(1510, { D: { cents: 200, at } }, true);
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

  it('null for non-payers on web', () => {
    expect(webLine(view(oneOwer(1510), B, { venmoOf: () => TEJ, platform: 'web' }))).toBeNull();
  });

  it('null when every ower is marked or has no username, or only the too-large caption shows', () => {
    expect(webLine(view(oneOwer(1510, { B: { cents: 1510, at } }), A, { venmoOf: venmoB, platform: 'web' }))).toBeNull();
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
  mark: markCents === null ? null : { cents: markCents, at: BILL_AT },
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
    viewerItemNames: claimedItemNames(data.rows, data.claims, myId),
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
        expect(rest).toEqual(want);
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

  it('openedVenmo null passes through', () => {
    expect(settleViewInputFor(billData(), B, 'ios', null).openedVenmo).toBeNull();
  });
});

describe('settleFooterAction (F1, criteria 24–28)', () => {
  const PAY_URL = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt%3A%20Salad%2C%20Fries';
  const DETAILS = { label: 'Details', a11yLabel: 'Settle up details', a11yHint: "Shows who's paid and other ways to pay" };
  const F_F = { kind: 'settle', variant: 'primary', caption: null, a11yHint: 'See what you owe and pay' };
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
      expect(got.button).toMatchObject({ label: 'Pay Hana $15.10 on Venmo', a11yHint: 'Opens Venmo' });
      expect(got.button.action.url).toBe(PAY_URL);
      expect(got.notes).toEqual(cardModel.notes);
      expect(got.details).toEqual(DETAILS);
      if (platform === 'web') expect(got.notes).toEqual(['@hana-1 · $15.10', 'On a computer? Send it from the Venmo app on your phone.']);
      else expect(got.notes).toEqual(['@hana-1 · $15.10']);
    }
  });

  it('F-d: after the Pay tap, "Did you pay Hana?" with I paid (mark) and Not yet, plus Details', () => {
    const got = settleFooterAction(inputFor(billData(), B, 'ios', { payerId: A, cents: 1510 }), 3);
    expect(got).toEqual({
      kind: 'did_you_pay',
      text: 'Did you pay Hana?',
      iPaid: { label: 'I paid', a11yLabel: 'I paid', a11yHint: 'Marks your share as paid', action: { kind: 'mark', payerId: A, cents: 1510 } },
      notYet: { label: 'Not yet', a11yLabel: 'Not yet' },
      details: DETAILS,
    });
  });

  it('F-e: marked → primary "Settle up" + "Marked paid"', () => {
    const data = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1510), member(D, 'Dee')] });
    expect(settleFooterAction(inputFor(data, B), 3)).toEqual({ ...F_F, caption: 'Marked paid', tone: 'success', live: true });
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
    it('payer has no Venmo (null) or an invalid one (\'ab\')', () => {
      for (const v of [null, 'ab']) {
        const data = billData({ participants: [member(A, 'Hana', v), member(B, 'Sam', TEJ), member(D, 'Dee')] });
        expect(settleCard(inputFor(data, B)).state).toBe('owes_no_venmo');
        expect(settleFooterAction(inputFor(data, B), 3)).toEqual(F_F);
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

  it('criterion 27: amount boundaries 1¢ and 99,999,999¢ → F-c; 100,000,000¢ → F-f', () => {
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
    expect(one(100_000_000)).toEqual(F_F);
  });

  it('criterion 28: F-d only while the opened payer and amount still match', () => {
    const opened = { payerId: A, cents: 1510 };
    expect(settleFooterAction(inputFor(billData(), B, 'ios', opened), 3)?.kind).toBe('did_you_pay');
    // Payer changed to D (no Venmo) → F-f; payer changed but Venmo valid → F-c, never F-d.
    const toD = billData({ payerId: D });
    expect(settleFooterAction(inputFor(toD, B, 'ios', opened), 3)).toEqual(F_F);
    const toDWithVenmo = billData({ payerId: D, participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ), member(D, 'Dee', 'dee-12345')] });
    expect(settleFooterAction(inputFor(toDWithVenmo, B, 'ios', opened), 3)?.kind).toBe('pay');
    // Contract O (criterion 59): the share changed (tax up) → still F-d, at the opened amount.
    const bigger = billData({ total: 3700 });
    const kept = settleFooterAction(inputFor(bigger, B, 'ios', opened), 3);
    expect(kept?.kind).toBe('did_you_pay');
    if (kept?.kind === 'did_you_pay') expect(kept.iPaid.action).toEqual({ kind: 'mark', payerId: A, cents: 1510 });
    // Opened with a different amount → F-d with that amount.
    const other = settleFooterAction(inputFor(billData(), B, 'ios', { payerId: A, cents: 1400 }), 3);
    expect(other?.kind === 'did_you_pay' && other.iPaid.action.cents).toBe(1400);
    // The viewer is now marked → the prompt is gone (F-e).
    const marked = billData({ participants: [member(A, 'Hana', 'hana-1'), member(B, 'Sam', TEJ, 1510), member(D, 'Dee')] });
    expect(settleFooterAction(inputFor(marked, B, 'ios', opened), 3)).toEqual({ ...F_F, caption: 'Marked paid', tone: 'success', live: true });
  });
});

describe('billFooterAction (bill screen footer, VR-I6)', () => {
  const PAY: SettleFooterAction = {
    kind: 'pay',
    button: { label: 'Pay Hana $15.10 on Venmo', a11yLabel: 'x', action: { kind: 'pay', url: 'u', payerId: A, cents: 1510 } },
    notes: ['@hana-1 · $15.10'],
    details: { label: 'Details', a11yLabel: 'Settle up details', a11yHint: 'h' },
  };
  const BLOCKED: SettleFooterAction = { kind: 'settle', variant: 'secondary', caption: '1 item left to claim', a11yHint: '1 item left to claim first' };

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
    expect(payOpenFailedLine(input, failure)).toBe(`Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app.`);
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
    expect(requestOpenFailedLine(settlePeople(view(oneOwer(1510, { B: { cents: 1510, at } }), A, { venmoOf: () => TEJ })), failure)).toBeNull();
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
      action: { kind: 'pay', url: venmoPayUrl({ username: 'hana-1', cents: share, itemNames: ['Salad', 'Fries'] }), payerId: A, cents: share },
    });
    expect(m.secondary.map((b) => b.label)).toEqual(['I already paid']);
  });

  it('after Pay and without Venmo, the may-change line stays (last in the head group)', () => {
    expect(settleCard(view(plan, B, { openedVenmo: { payerId: A, cents: share } }))).toMatchObject({ state: 'owes_opened', lines: [{ text: MAY }] });
    expect(settleCard(view(plan, B, { payerVenmo: null })).lines.map((l) => l.text)).toEqual([
      "Hana hasn't added Venmo yet. Ask them, or pay another way.",
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
      primary: { label: 'Back to the bill', a11yLabel: 'Back to the bill', action: { kind: 'back' } },
      notes: [],
      secondary: [],
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
      primary: null,
      notes: [],
      secondary: [],
    });
    expect(settleCard(view(earlyWorked({ B: { cents: share, at } }), A)).lines).toEqual([
      { text: '1 item left to claim', tone: 'muted' },
      { text: '1 paid so far', tone: 'muted', live: true },
    ]);
    const two = earlyWorked({ B: { cents: share, at }, D: { cents: 100, at } }, { claims: [c('burger', A), c('salad', B), c('fries', D)] });
    expect(settleCard(view(two, A)).lines[1]?.text).toBe('2 paid so far');
  });

  it('marked early, no difference: Marked paid plus the settle-later line, plain Undo', () => {
    const m = settleCard(view(earlyWorked({ B: { cents: share, at } }), B));
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
  const mark = { B: { cents: 1510, at } };
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
        { userId: A, role: 'payer', mark: null },
        { userId: B, role: 'payer_owes_them', owedCents: -100, mark: mark.B, canSettle: true, difference: differenceFor(-100, 1510) },
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
  const mark = { B: { cents: 1510, at } };
  const items = ['Salad', 'Fries'];

  it('more_due: label, amount, line, Pay more, notes, I paid the difference, Undo "I paid"', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { viewerItemNames: items, platform: 'web' }));
    expect(m).toEqual({
      state: 'more_due',
      label: 'You owe Hana more',
      amountCents: 110,
      lines: [{ text: "Your share is now $16.20. You've marked $15.10 paid.", tone: 'muted' }],
      primary: {
        label: 'Pay Hana $1.10 more on Venmo',
        a11yLabel: 'Pay Hana $1.10 more on Venmo, to @hana-1',
        a11yHint: 'Opens Venmo',
        action: { kind: 'pay_difference', url: venmoPayUrl({ username: 'hana-1', cents: 110, itemNames: items }), payerId: A, cents: 110, fromCents: 1510, toCents: 1620 },
      },
      notes: ['@hana-1 · $1.10', 'On a computer? Send it from the Venmo app on your phone.'],
      secondary: [
        {
          label: 'I paid the difference',
          a11yLabel: 'I paid the difference',
          a11yHint: 'Marks the $1.10 difference as paid',
          action: { kind: 'mark_difference', userId: B, payerId: A, fromCents: 1510, toCents: 1620 },
        },
        { label: 'Undo "I paid"', a11yLabel: 'Undo your I paid', a11yHint: 'Clears your whole I paid of $15.10', action: { kind: 'unmark', userId: B } },
      ],
    });
  });

  it('more_due, payer without Venmo: the no-Venmo line, I paid the difference as primary, Undo "I paid"', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { payerVenmo: null }));
    expect(m.lines.map((l) => l.text)).toEqual(["Your share is now $16.20. You've marked $15.10 paid.", "Hana hasn't added Venmo yet. Ask them, or pay another way."]);
    expect(m.primary).toMatchObject({ label: 'I paid the difference', action: { kind: 'mark_difference', fromCents: 1510, toCents: 1620 } });
    expect(m.secondary.map((b) => b.label)).toEqual(['Undo "I paid"']);
    expect(m.notes).toEqual([]);
  });

  const opened: OpenedVenmo = { kind: 'more', payerId: A, cents: 110, fromCents: 1510 };
  it('more_opened: Did you pay Hana $1.10?, records 1510 → 1620, Open Venmo again', () => {
    const m = settleCard(view(bOwesReady(1620, mark), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'more_opened', label: 'Did you pay Hana $1.10?', amountCents: 110, lines: [], notes: ['@hana-1 · $1.10'] });
    expect(m.primary).toMatchObject({ label: 'I paid the difference', action: { kind: 'mark_difference', userId: B, payerId: A, fromCents: 1510, toCents: 1620 } });
    expect(m.secondary).toEqual([
      {
        label: 'Open Venmo again',
        a11yLabel: 'Open Venmo again',
        a11yHint: 'Opens Venmo',
        action: { kind: 'pay_difference', url: venmoPayUrl({ username: 'hana-1', cents: 110 }), payerId: A, cents: 110, fromCents: 1510, toCents: 1620 },
      },
    ]);
  });

  it('contract O: the share moved to 1700 with the mark still 1510 → still more_opened at $1.10, recording 1510 → 1620', () => {
    const m = settleCard(view(bOwesReady(1700, mark), B, { openedVenmo: opened }));
    expect(m).toMatchObject({ state: 'more_opened', amountCents: 110, primary: { action: { fromCents: 1510, toCents: 1620 } } });
  });

  it('dropped when the mark is now 1620, the payer changed, or the plan is not ready', () => {
    expect(settleCard(view(bOwesReady(1620, { B: { cents: 1620, at } }), B, { openedVenmo: opened })).state).toBe('marked');
    expect(settleCard(view(bOwesReady(1620, mark), B, { openedVenmo: { ...opened, payerId: D } })).state).toBe('more_due');
    expect(settleCard(view(bOwesEarly(1620, mark), B, { openedVenmo: opened })).state).toBe('marked');
    expect(openedStillMatches(bOwesEarly(1620, mark), B, opened)).toBe(false);
    expect(openedStillMatches(bOwesReady(1700, mark), B, opened)).toBe(true);
  });
});

describe('ready back_due (criterion 29)', () => {
  const mark = { B: { cents: 1510, at } };
  const items = ['Salad'];

  it('back_due: Hana owes you, $1.10, outlined Request block button, never writes, Undo "I paid"', () => {
    const m = settleCard(view(bOwesReady(1400, mark), B, { viewerItemNames: items, platform: 'web' }));
    expect(m).toEqual({
      state: 'back_due',
      label: 'Hana owes you',
      amountCents: 110,
      lines: [{ text: "Your share is now $14.00. You've marked $15.10 paid.", tone: 'muted' }],
      primary: {
        label: 'Request $1.10 from Hana on Venmo',
        a11yLabel: 'Request $1.10 from Hana on Venmo, @hana-1',
        a11yHint: 'Opens Venmo',
        variant: 'secondary',
        action: { kind: 'request', url: venmoRequestUrl({ username: 'hana-1', cents: 110, itemNames: items }) },
      },
      notes: ['@hana-1 · $1.10', 'On a computer? Send requests from the Venmo app on your phone.'],
      secondary: [{ label: 'Undo "I paid"', a11yLabel: 'Undo your I paid', a11yHint: 'Clears your whole I paid of $15.10', action: { kind: 'unmark', userId: B } }],
    });
    expect(JSON.stringify(m)).not.toContain('mark_difference');
  });

  it('payer without Venmo: Ask Hana to pay you back., no request action', () => {
    const m = settleCard(view(bOwesReady(1400, mark), B, { payerVenmo: null }));
    expect(m.lines.map((l) => l.text)).toEqual(["Your share is now $14.00. You've marked $15.10 paid.", 'Ask Hana to pay you back.']);
    expect(m.primary).toBeNull();
    expect(m.secondary.map((b) => b.label)).toEqual(['Undo "I paid"']);
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
        { text: "Your share is now -$1.00. You've marked $15.10 paid.", tone: 'muted' },
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
const DIFF_MARKS: SettleMarks = { B: { cents: 1510, at }, E: { cents: 1510, at } };
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
          action: { kind: 'mark_difference', userId: E, payerId: A, fromCents: 1510, toCents: 1400 },
        },
      },
    });
  });

  it('pay-back to $0 (D3): toCents 0 and the Clears hint', () => {
    const plan = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, { B: { cents: 1510, at } });
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
    const plan = settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, { B: { cents: big, at } });
    expect(row(settlePeople(view(plan, A, { venmoOf: () => 'sam-1' })), B).payBack?.link).toEqual({ kind: 'caption', caption: 'Pay it back in the Venmo app' });
  });

  it('host-payer: the same controls plus Undo', () => {
    const people = settlePeople(rowsInput(DIFF_MARKS, A, A));
    expect(row(people, B).undo).toMatchObject({ userId: B, confirm: true });
    expect(row(people, E).undo).toMatchObject({ userId: E, confirm: true });
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

  it('once the difference is settled the payer\'s Undo comes back (Paid, success)', () => {
    const people = settlePeople(rowsInput({ B: { cents: 1620, at }, E: { cents: 1400, at } }, A, D));
    expect(row(people, B)).toMatchObject({ status: { text: 'Paid', tone: 'success' }, subLine: null, payBack: null, request: null });
    expect(row(people, B).undo).not.toBeNull();
  });

  it('wideStatus: true with any difference row, false without', () => {
    expect(settlePeople(rowsInput(DIFF_MARKS, A, D))?.wideStatus).toBe(true);
    expect(settlePeople(rowsInput({ B: { cents: 1510, at } }, A, D))?.wideStatus).toBe(true);
    expect(settlePeople(rowsInput({}, A, D))?.wideStatus).toBe(false);
    expect(settlePeople(rowsInput({ B: { cents: 1620, at } }, A, D))?.wideStatus).toBe(false);
    expect(settlePeople(view(bOwesEarly(1620, { B: { cents: 1510, at } }), A))?.wideStatus).toBe(false);
  });

  it('list web line: pay-or-request when a pay-back link exists, else the request line', () => {
    const web = (input: SettleViewInput) => settleRequestWebLine(input, settlePeople(input));
    expect(web(rowsInput(DIFF_MARKS, A, D, { platform: 'web' }))).toBe('On a computer? Open Venmo on your phone to pay or request.');
    expect(web(rowsInput({ B: { cents: 1510, at } }, A, D, { platform: 'web' }))).toBe('On a computer? Send requests from the Venmo app on your phone.');
    expect(web(rowsInput(DIFF_MARKS, A, D))).toBeNull();
  });

  it('no row status reads Paid back', () => {
    for (const viewer of [A, B, D, E]) {
      for (const r of settlePeople(rowsInput(DIFF_MARKS, viewer, D))?.rows ?? []) expect(r.status?.text).not.toMatch(/Paid back/);
    }
  });
});

describe('early rows (Task 6b)', () => {
  it('people with an item claim or a mark; no aside, no controls; a difference row keeps the warning sub-line', () => {
    const plan = bOwesEarly(1620, { B: { cents: 1510, at } });
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
    expect(row(people, B).undo).not.toBeNull(); // Q4: the host-payer can undo
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
      { text: '2 of 3 paid', tone: 'muted', live: true },
      { text: '2 differences to settle', tone: 'warning', live: true },
    ]);
    const one = settleCard(view(rowsPlan({ B: { cents: 1510, at } }), A));
    expect(one.lines).toEqual([
      { text: '1 of 3 paid', tone: 'muted', live: true },
      { text: '1 difference to settle', tone: 'warning', live: true },
    ]);
  });
  it('someone unmarked and no differences: the paid-of line only', () => {
    expect(settleCard(view(rowsPlan({ B: { cents: 1620, at } }), A)).lines).toEqual([{ text: '1 of 3 paid', tone: 'muted', live: true }]);
  });
  it('every ower marked, 1 and 2 differences → payer with the warning differences line', () => {
    const one = settleCard(view(rowsPlan({ B: { cents: 1510, at }, E: { cents: 1400, at }, D: { cents: 500, at } }), A));
    expect(one).toMatchObject({ state: 'payer', label: '3 people owe you' });
    expect(one.lines).toEqual([
      { text: '3 of 3 paid', tone: 'muted', live: true },
      { text: '1 difference to settle', tone: 'warning', live: true },
    ]);
    const two = settleCard(view(rowsPlan({ ...DIFF_MARKS, D: { cents: 500, at } }), A));
    expect(two.lines[1]?.text).toBe('2 differences to settle');
  });
  it('differences within tolerance → payer_all_paid', () => {
    expect(settleCard(view(rowsPlan({ B: { cents: 1619, at }, E: { cents: 1401, at }, D: { cents: 500, at } }), A)).state).toBe('payer_all_paid');
  });
  it('owingCount 0 with a back difference → payer_differences, never payer_nobody; no differences → payer_nobody', () => {
    const zero = (marks: SettleMarks) =>
      settlePlan({ totalCents: 1000, items: [{ id: 'a', totalCents: 1000 }], claims: [c('a', A)], participantIds: [A, B], extrasMode: 'proportional' }, A, marks);
    expect(settleCard(view(zero({ B: { cents: 1510, at } }), A))).toEqual({
      state: 'payer_differences',
      label: 'You owe money back',
      amountCents: null,
      lines: [{ text: '1 difference to settle', tone: 'warning', live: true }],
      primary: null,
      notes: [],
      secondary: [],
    });
    expect(settleCard(view(zero({}), A)).state).toBe('payer_nobody');
  });
});

describe('actionError additions (criterion 33)', () => {
  it('mark_changed and not_complete refetch with settle copy', () => {
    expect(actionError('mark_changed')).toEqual({ text: 'Your "I paid" just changed. Check the amount and try again.', refetch: true });
    expect(actionError('not_complete')).toEqual({ text: 'Something on the bill just changed. Check your share and try again.', refetch: true });
  });
  it('not_allowed on a difference action (a stale token read as the other direction, 10a finding) refetches with the mark_changed copy', () => {
    expect(actionError('not_allowed', { difference: true })).toEqual({ text: 'Your "I paid" just changed. Check the amount and try again.', refetch: true });
    expect(actionError('not_allowed')).toEqual({ text: BILL_ERROR_COPY.not_allowed, refetch: false });
    expect(actionError('payer_changed', { difference: true })).toEqual({ text: BILL_ERROR_COPY.payer_changed, refetch: true });
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
    expect(tones(settleFooterAction(settleViewInputFor(billData({ participants: sam(1510) }), B, 'ios', null), 3))).toEqual(['Marked paid', 'success', true]);
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
      text: 'Did you pay Hana?',
      iPaid: { label: 'I paid', a11yLabel: 'I paid', a11yHint: 'Marks your share as paid', action: { kind: 'mark', payerId: A, cents: 1510 } },
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
    expect(openedStillMatches(bOwesReady(1620, { B: { cents: 1510, at } }), B, opened)).toBe(false);
    expect(openedStillMatches({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B, opened)).toBe(false);
    expect(openedStillMatches(earlyWorked({}, { claims: [c('burger', A)] }), B, opened)).toBe(false);
    expect(openedStillMatches(bOwesEarly(1620), B, opened)).toBe(true);
  });
  it('payOpenFailedLine still needs the current amount (the instruction to send money must be current)', () => {
    const failure = { payerId: A, cents: 1510, handle: 'hana-1' };
    expect(payOpenFailedLine(view(bOwesReady(1510), B), failure)).not.toBeNull();
    expect(payOpenFailedLine(view(bOwesReady(1620), B), failure)).toBeNull();
    // A failed Pay-more open: the line describes the difference while it's still due.
    expect(payOpenFailedLine(view(bOwesReady(1620, { B: { cents: 1510, at } }), B), { payerId: A, cents: 110, handle: 'hana-1' })).toBe(
      "Couldn't open Venmo. Send $1.10 to @hana-1 in the Venmo app.",
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
    expect(noticeSnapshot(view(bOwesReady(1620, { B: { cents: 1510, at } }), B, { viewerMarked: true }))).toEqual({ payerId: A, myMark: true, myShareCents: 1620 });
    expect(noticeSnapshot(view(bOwesEarly(700), B))).toEqual({ payerId: A, myMark: false, myShareCents: 700 });
    expect(noticeSnapshot(view(bOwesReady(700), A)).myShareCents).toBeNull(); // the payer has no share to collect
    expect(noticeSnapshot(view({ status: 'blocked', unclaimedRows: 1, unclaimedDiscountRows: 0 }, B)).myShareCents).toBeNull();
  });
});

/** Card fixtures of criteria 26–31 (non-payer and payer viewers), for criteria 66 and 67. */
function cardFixtures(): SettleViewInput[] {
  const m = (cents: number) => ({ B: { cents, at } });
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
    earlyWorked({ B: { cents: share, at } }),
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
    rowsPlan({ ...DIFF_MARKS, D: { cents: 500, at } }),
    rowsPlan({ B: { cents: 1620, at }, E: { cents: 1400, at }, D: { cents: 500, at } }),
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
  const summary = { hostId: A, payerId: A, added: false, seen: true, claimedAny: true, complete: true };
  // Home shows one pill: "N left to pay" (H5) wins over differences (H6), even though the card shows both lines (review R2).
  const expected = (m: SettleCardModel, plan: SettleViewInput['plan']): string | null => {
    switch (m.state) {
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
      expect([cardModel.state, billMarker(summary, input.viewerId, input.plan)]).toEqual([cardModel.state, expected(cardModel, input.plan)]);
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
    expect(openedFor({ kind: 'pay', url: 'u', payerId: 'a', cents: 1510 })).toEqual({ payerId: 'a', cents: 1510 });
    expect(openedFor({ kind: 'pay_difference', url: 'u', payerId: 'a', cents: 110, fromCents: 1510, toCents: 1620 })).toEqual({
      kind: 'more',
      payerId: 'a',
      cents: 110,
      fromCents: 1510,
    });
  });

  it('differenceArgs is the action as built: person, payer, from, to (a pay-back to 0 included)', () => {
    expect(differenceArgs({ kind: 'mark_difference', userId: 'b', payerId: 'a', fromCents: 1510, toCents: 1620 })).toEqual(['b', 'a', 1510, 1620]);
    expect(differenceArgs({ kind: 'mark_difference', userId: 'b', payerId: 'a', fromCents: 1510, toCents: 0 })).toEqual(['b', 'a', 1510, 0]);
  });
});
