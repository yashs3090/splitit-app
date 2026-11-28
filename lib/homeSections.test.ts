// Spec: docs/specs/2026-11-26-home-mobile-refresh.md D2–D5, Task 2, criteria 7–18, and
// docs/specs/2026-11-26-home-groups-v2.md D1–D5 + A1, Task 1, criteria 9–25 (the "GV" blocks).
// Plans are built with settlePlan(..., { allowEarly: true }), exactly as settleViewInputFor builds
// the plan Home and the Settle screen use, never by hand.
import { fakeMark, fakeNotReceived, fakePayment, fakePaymentFlag } from '@/test-utils/fakes';

import type { BillPayment, BillPaymentFlag, BillSummary } from './bills';
import { billMarker, billMarkerView, type HomeMarker, type MarkerView } from './homeMarkers';
import {
  FIRST_SETTLE_WAIT_MS,
  HOME_COPY,
  HOME_SECTION_TITLES,
  HOME_STATUS_COPY,
  homeStatus,
  sectionToggleA11y,
  sectionToggleText,
  waitingFor,
  MARKER_GROUPS,
  amountLabel,
  stillToCollectCents,
  homeGroup,
  homeRowA11yLabel,
  homeRowView,
  homeSections,
  peopleText,
  rowAmount,
  rowCaption,
  rowTitle,
  settledToggleA11y,
  settledToggleText,
  viewerBalance,
  viewerIsPayer,
  type HomeGroup,
  type HomeRowView,
  type HomeSettleFacts,
  type RowAmount,
} from './homeSections';
import type { Payer } from './payers';
import {
  balanceFor,
  differenceOf,
  ledgerSettlePlan,
  settlePlan,
  type BillSettlePlan,
  type SettleMarks,
  type SettleNotReceivedMap,
  type SettlePlanWithEarly,
} from './settle';
import type { ExtrasMode, SplitClaim, SplitInput, SplitItem } from './split';

const ME = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const DEE = 'bbbbbbbb-0000-4000-8000-00000000000c';
const AT = '2026-11-25T10:00:00Z';

/** Injected so the tests don't depend on the machine's locale. */
const fmt = (iso: string) => (iso.startsWith('2026-11-20') ? 'Nov 20' : '');
const noDate = () => '';
const nameOf = (id: string | null) => (id === ME ? 'You' : id === HOST ? 'Hana' : id === DEE ? 'Dee' : 'Someone');

let n = 0;
function summary(over: Partial<BillSummary> = {}): BillSummary {
  n += 1;
  return {
    id: `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`,
    hostId: HOST,
    hostName: 'Hana',
    payerId: HOST,
    totalCents: 4480,
    createdAt: '2026-11-20T19:00:00Z',
    joinedAt: '2026-11-20T19:05:00Z',
    added: false,
    seen: false,
    claimedAny: false,
    complete: false,
    seenAt: null,
    ...over,
  };
}
/** A guest's bill (Hana hosts and pays), seen, with claims, complete unless said. */
const guestBill = (over: Partial<BillSummary> = {}) => summary({ seen: true, claimedAny: true, complete: true, ...over });
/** A bill I host and pay. */
const myBill = (over: Partial<BillSummary> = {}) => summary({ hostId: ME, payerId: ME, seen: true, complete: true, ...over });

const mark = (cents: number) => fakeMark(cents, AT, HOST);
/** A mark paid to me (I'm the payer), Venmo so a 'sent' pill reads "Hana sent you …". */
const markMe = (cents: number) => fakeMark(cents, AT, ME, 'venmo');
const cl = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });

function planOf(input: SplitInput, payerId: string, marks: SettleMarks = {}, notReceived: SettleNotReceivedMap = {}): SettlePlanWithEarly {
  return settlePlan(input, payerId, marks, { allowEarly: true, notReceived });
}
function input(
  items: SplitItem[],
  claims: SplitClaim[],
  totalCents: number,
  extrasMode: ExtrasMode = 'proportional',
  participantIds: string[] = [HOST, ME, DEE],
): SplitInput {
  return { totalCents, items, claims, participantIds, extrasMode };
}
const sum = (items: SplitItem[]) => items.reduce((s, i) => s + i.totalCents, 0);
/** No extras, so each share is exactly its row: Hana 1000, me `mine`, Dee `dee` (0 = no row). */
function exact(mine: number, dee = 0, opts: { unclaimed?: number } = {}): SplitInput {
  const items: SplitItem[] = [{ id: 'h', totalCents: 1000 }, { id: 'm', totalCents: mine }];
  const claims = [cl('h', HOST), cl('m', ME)];
  if (dee > 0) {
    items.push({ id: 'd', totalCents: dee });
    claims.push(cl('d', DEE));
  }
  if (opts.unclaimed !== undefined) items.push({ id: 'u', totalCents: opts.unclaimed });
  return input(items, claims, sum(items));
}
/** I pay: me 1000, Hana `hana`, Dee `dee`, no extras. */
function iPay(hana: number, dee: number): SplitInput {
  const items = [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: hana }, { id: 'd', totalCents: dee }];
  return input(items, [cl('m', ME), cl('h', HOST), cl('d', DEE)], sum(items));
}
/** Even mode, items Hana 1000 / me 0, total 1000 + 2·delta: each person's share moves by `delta`. */
function evenShift(delta: number): SplitInput {
  return input([{ id: 'h', totalCents: 1000 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 1000 + 2 * delta, 'equal', [HOST, ME]);
}

const facts = (plan: BillSettlePlan): HomeSettleFacts => ({ plan, nameOf });
function myEntry(plan: BillSettlePlan) {
  if (plan.status !== 'ready' && plan.status !== 'early') throw new Error(`plan is ${plan.status}`);
  const people: readonly (typeof plan.people)[number][] = plan.people;
  return people.find((e) => e.userId === ME);
}
function owedOf(plan: BillSettlePlan): number | undefined {
  const e = myEntry(plan);
  return e === undefined || e.role === 'payer' ? undefined : e.owedCents;
}

// ---------------------------------------------------------------------------
// Criterion 7: people text and caption
// ---------------------------------------------------------------------------

describe('peopleText and rowCaption (D2, criterion 7)', () => {
  it.each([
    [undefined, ''],
    [1, 'Just you'],
    [2, '2 people'],
    [12, '12 people'],
  ] as const)('peopleText(%p) → %p', (count, expected) => {
    expect(peopleText(count)).toBe(expected);
  });

  it('treats a count that isn\'t a whole number ≥ 1 as unknown', () => {
    expect(peopleText(0)).toBe('');
    expect(peopleText(-2)).toBe('');
    expect(peopleText(2.5)).toBe('');
    expect(peopleText(Number.NaN)).toBe('');
  });

  it('joins date and people with " · ", dropping empty parts', () => {
    const at = '2026-11-20T19:00:00Z';
    expect(rowCaption(at, 4, fmt)).toBe('Nov 20 · 4 people');
    expect(rowCaption(at, undefined, fmt)).toBe('Nov 20');
    expect(rowCaption(at, 4, noDate)).toBe('4 people');
    expect(rowCaption(at, undefined, noDate)).toBe('');
    expect(rowCaption(at, 1, fmt)).toBe('Nov 20 · Just you');
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: title
// ---------------------------------------------------------------------------

describe('rowTitle (D2, criterion 8)', () => {
  it('host → Your bill', () => {
    expect(rowTitle(myBill({ hostName: 'Me Myself' }), ME)).toBe('Your bill');
  });
  it.each([
    ['Hana', "Hana's bill"],
    ['  Hana  ', "Hana's bill"],
    [null, "A friend's bill"],
    ['  ', "A friend's bill"],
  ] as const)('guest with hostName %p → %p', (hostName, expected) => {
    expect(rowTitle(summary({ hostName }), ME)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Criteria 9–11: the amount
// ---------------------------------------------------------------------------

describe('rowAmount (D3, criterion 9)', () => {
  const owes1480 = planOf(exact(1480), HOST);

  it('fixture check: the ready plan has me owing 1480', () => {
    expect(owes1480.status).toBe('ready');
    expect(myEntry(owes1480)?.role).toBe('owes');
    expect(owedOf(owes1480)).toBe(1480);
  });

  it('A1 host who is also the payer, ready → total', () => {
    const plan = planOf(iPay(500, 300), ME);
    expect(myEntry(plan)?.role).toBe('payer');
    expect(rowAmount(myBill(), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A2 host who is not the payer, owing 1480 → total (order 1)', () => {
    const bill = summary({ hostId: ME, payerId: HOST, seen: true, complete: true });
    expect(rowAmount(bill, ME, owes1480)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A3 guest, no plan → total', () => {
    expect(rowAmount(guestBill(), ME, undefined)).toEqual({ kind: 'total', cents: 4480 });
    expect(rowAmount(guestBill(), ME, null)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A4 guest, early plan owing 1480 → total', () => {
    const plan = planOf(exact(1480, 0, { unclaimed: 500 }), HOST);
    expect(plan.status).toBe('early');
    expect(owedOf(plan)).toBe(1480);
    expect(rowAmount(guestBill({ complete: false }), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A5 guest, blocked plan → total', () => {
    const plan = planOf({ ...exact(1480, 0, { unclaimed: 500 }), extrasMode: 'equal' }, HOST);
    expect(plan.status).toBe('blocked');
    expect(rowAmount(guestBill({ complete: false }), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A6 guest, ready, owes 1480 → share 1480', () => {
    expect(rowAmount(guestBill(), ME, owes1480)).toEqual({ kind: 'share', cents: 1480 });
  });

  it('A7 guest, ready, nothing to pay (0) → share 0', () => {
    const plan = planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST);
    expect(myEntry(plan)?.role).toBe('nothing');
    expect(owedOf(plan)).toBe(0);
    expect(rowAmount(guestBill(), ME, plan)).toEqual({ kind: 'share', cents: 0 });
  });

  it('A8 guest, ready, payer_owes_them (−100) → total', () => {
    const plan = planOf(evenShift(-100), HOST);
    expect(myEntry(plan)?.role).toBe('payer_owes_them');
    expect(owedOf(plan)).toBe(-100);
    expect(rowAmount(guestBill(), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A9 guest who is the payer, ready → total', () => {
    const plan = planOf(iPay(500, 300), ME);
    expect(rowAmount(guestBill({ payerId: ME }), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A10 guest, ready, viewer not in people → total', () => {
    const plan = planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000, 'proportional', [HOST, DEE]), HOST);
    expect(plan.status).toBe('ready');
    expect(myEntry(plan)).toBeUndefined();
    expect(rowAmount(guestBill(), ME, plan)).toEqual({ kind: 'total', cents: 4480 });
  });

  it('A11 guest marked paid 1480, owes 1480 → share 1480', () => {
    const plan = planOf(exact(1480), HOST, { [ME]: mark(1480) });
    expect(myEntry(plan)?.mark).toEqual(mark(1480));
    expect(rowAmount(guestBill(), ME, plan)).toEqual({ kind: 'share', cents: 1480 });
  });
});

describe('rowAmount share-sign boundary (criterion 10)', () => {
  it.each([
    [-1, { kind: 'total', cents: 4480 }],
    [1, { kind: 'share', cents: 1 }],
  ] as const)('owedCents %p', (delta, expected) => {
    const plan = planOf(evenShift(delta), HOST);
    expect(owedOf(plan)).toBe(delta);
    expect(rowAmount(guestBill(), ME, plan)).toEqual(expected);
  });
});

describe('amount label and figure (criterion 11)', () => {
  it('labels', () => {
    expect(amountLabel('share')).toBe('Your share');
    expect(amountLabel('total')).toBe('Total');
  });

  it('the row view formats the figure with formatCents', () => {
    const share = homeRowView(guestBill(), ME, facts(planOf(exact(1480), HOST)), undefined, fmt);
    expect([share.amountText, share.amountLabel]).toEqual(['$14.80', 'Your share']);
    const zero = homeRowView(guestBill(), ME, facts(planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST)), undefined, fmt);
    expect([zero.amountText, zero.amountLabel]).toEqual(['$0.00', 'Your share']);
    const total = homeRowView(guestBill(), ME, undefined, undefined, fmt);
    expect([total.amountText, total.amountLabel]).toEqual(['$44.80', 'Total']);
  });
});

// ---------------------------------------------------------------------------
// Groups v2 fixtures. Every plan goes through settlePlan via the helpers above.
// ---------------------------------------------------------------------------

const XAV = 'bbbbbbbb-0000-4000-8000-00000000000d';
/** A seenAt before AT, so marks at AT are unseen (what 'sent' needs). */
const SEEN_BEFORE = '2026-11-24T00:00:00Z';

type GroupFixture = { name: string; bill: BillSummary; facts: HomeSettleFacts | undefined; group: HomeGroup };
const fx = (name: string, bill: BillSummary, plan: BillSettlePlan | undefined, group: HomeGroup): GroupFixture => ({
  name,
  bill,
  facts: plan === undefined ? undefined : facts(plan),
  group,
});

/** Proportional, all items $0, total 500: complete, but no weights → blocked_all_zero. */
const allZero = () => input([{ id: 'h', totalCents: 0 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 500);
/** I pay, with an unclaimed $2.00 row (proportional → early): me 1000, Hana 500, Dee 300. */
function iPayEarly(): SplitInput {
  const items = [
    { id: 'm', totalCents: 1000 },
    { id: 'h', totalCents: 500 },
    { id: 'd', totalCents: 300 },
    { id: 'u', totalCents: 200 },
  ];
  return input(items, [cl('m', ME), cl('h', HOST), cl('d', DEE)], sum(items));
}
/** I pay; Hana's share is −100 (payer_owes_them), Dee's 300, mine 1000 (even mode, a $3 discount). */
function iPayNegative(): SplitInput {
  const items = [{ id: 'm', totalCents: 1100 }, { id: 'h', totalCents: 0 }, { id: 'd', totalCents: 400 }];
  return input(items, [cl('m', ME), cl('h', HOST), cl('d', DEE)], sum(items) - 300, 'equal');
}
/** Hana claims her row; I claim nothing; a $5.00 row is unclaimed (early, my role 'nothing'). */
const earlyNothing = () => input([{ id: 'h', totalCents: 1000 }, { id: 'u', totalCents: 500 }], [cl('h', HOST)], 1500);
/** earlyNothing, plus a $0.00 row I claimed (early, my role still 'nothing', but I've claimed). */
const earlyClaimedZero = () =>
  input([{ id: 'h', totalCents: 1000 }, { id: 'u', totalCents: 500 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 1500);

// Criterion 11: guest balance boundaries (ready, Hana pays).
type BalanceRow = GroupFixture & { owes: boolean; owed: boolean };
const G: Record<string, BalanceRow> = {
  G1: { ...fx('G1 1480 unmarked', guestBill(), planOf(exact(1480), HOST), 'waiting'), owes: true, owed: false },
  G2: { ...fx('G2 1480 marked 1480', guestBill(), planOf(exact(1480), HOST, { [ME]: mark(1480) }), 'hidden'), owes: false, owed: false },
  G3: { ...fx('G3 1481 marked 1480', guestBill(), planOf(exact(1481), HOST, { [ME]: mark(1480) }), 'hidden'), owes: false, owed: false },
  G4: { ...fx('G4 1482 marked 1480', guestBill(), planOf(exact(1482), HOST, { [ME]: mark(1480) }), 'waiting'), owes: true, owed: false },
  G5: { ...fx('G5 1479 marked 1480', guestBill(), planOf(exact(1479), HOST, { [ME]: mark(1480) }), 'hidden'), owes: false, owed: false },
  G6: { ...fx('G6 1478 marked 1480', guestBill(), planOf(exact(1478), HOST, { [ME]: mark(1480) }), 'owed'), owes: false, owed: true },
  G7: {
    ...fx('G7 nothing', guestBill(), planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST), 'hidden'),
    owes: false,
    owed: false,
  },
  G8: { ...fx('G8 −100 unmarked', guestBill(), planOf(evenShift(-100), HOST), 'hidden'), owes: false, owed: false },
  G9: { ...fx('G9 −100 marked 500', guestBill(), planOf(evenShift(-100), HOST, { [ME]: mark(500) }), 'owed'), owes: false, owed: true },
};

// Criterion 12: payer balance boundaries (ready, I pay; Hana 500, Dee 300).
const P: Record<string, BalanceRow> = {
  P1: { ...fx('P1 both unmarked', myBill(), planOf(iPay(500, 300), ME), 'owed'), owes: false, owed: true },
  P2: { ...fx('P2 both marked', myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(300) }), 'settled'), owes: false, owed: false },
  P3: { ...fx('P3 Dee 301 (1¢)', myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(301) }), 'settled'), owes: false, owed: false },
  P4: { ...fx('P4 Dee 298 (more 2)', myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(298) }), 'owed'), owes: false, owed: true },
  P5: { ...fx('P5 Dee 302 (back 2)', myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(302) }), 'waiting'), owes: true, owed: false },
  P6: { ...fx('P6 Hana more 2, Dee back 2', myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(498), [DEE]: markMe(302) }), 'owed'), owes: true, owed: true },
  P7: { ...fx('P7 Hana unmarked, Dee back 2', myBill(), planOf(iPay(500, 300), ME, { [DEE]: markMe(302) }), 'owed'), owes: true, owed: true },
  P8: { ...fx('P8 both nothing', myBill(), planOf(iPay(0, 0), ME), 'settled'), owes: false, owed: false },
  P9: { ...fx('P9 Hana −100 unmarked, Dee marked', myBill(), planOf(iPayNegative(), ME, { [DEE]: markMe(300) }), 'settled'), owes: false, owed: false },
};

// ---------------------------------------------------------------------------
// Who paid X2 (docs/specs/2026-11-26-who-paid.md D10, A1.2 contract O): 'routes' and
// 'blocked_payers' plans, built with ledgerSettlePlan(..., { allowEarly: true }) exactly as Home
// builds them. Expected markers, groups and amounts are worked out by hand from contract T, not read
// off the code: each pair is "what the ower is short" split over the payers who are over.
// ---------------------------------------------------------------------------

const PAY_AT = '2026-11-26T10:00:00.000001+00:00';
let payN = 0;
/** One bill_payments entry, on the given plan key (null = made under an earlier state). */
function pay(fromId: string, toId: string, cents: number, planKey: string | null): BillPayment {
  payN += 1;
  return fakePayment(`30000000-0000-4000-8000-${String(payN).padStart(12, '0')}`, fromId, toId, cents, PAY_AT, 'venmo', planKey);
}
/** Each person's share is exactly one claimed row (no extras); 0 = no row. Everyone is a participant. */
function shares3(hana: number, mine: number, dee: number, opts: { unclaimed?: number } = {}): SplitInput {
  const items: SplitItem[] = [];
  const claims: SplitClaim[] = [];
  for (const [id, userId, cents] of [['h', HOST, hana], ['m', ME, mine], ['d', DEE, dee]] as const) {
    if (cents === 0) continue;
    items.push({ id, totalCents: cents });
    claims.push(cl(id, userId));
  }
  if (opts.unclaimed !== undefined) items.push({ id: 'u', totalCents: opts.unclaimed });
  return input(items, claims, sum(items));
}
type LedgerFacts = { payers?: Payer[]; flags?: BillPaymentFlag[]; payments?: (key: string | null) => BillPayment[] };
/**
 * Home's plan: ledgerSettlePlan with allowEarly. `payments` gets the plan key of the same bill with
 * no payments, so a payment "made from this plan" carries it (as mark_paid stamps it).
 */
function ledgerOf(split: SplitInput, payerId: string, f: LedgerFacts = {}): BillSettlePlan {
  const base = { payerId, payers: f.payers ?? [], flags: f.flags ?? [] };
  const key = ledgerSettlePlan(split, { ...base, payments: [] }, { allowEarly: true }).planKey;
  return ledgerSettlePlan(split, { ...base, payments: f.payments?.(key) ?? [] }, { allowEarly: true }).plan;
}

type WhoPaidFixture = GroupFixture & { marker: HomeMarker | null; amount: RowAmount; status: BillSettlePlan['status'] };
const wp = (
  name: string,
  bill: BillSummary,
  plan: BillSettlePlan,
  marker: HomeMarker | null,
  group: HomeGroup,
  amount: RowAmount,
): WhoPaidFixture => ({ ...fx(name, bill, plan, group), marker, amount, status: plan.status });
const share = (cents: number): RowAmount => ({ kind: 'share', cents });
const totalOf = (cents: number): RowAmount => ({ kind: 'total', cents });
const collectOf = (cents: number): RowAmount => ({ kind: 'collect', cents });

/** A: Hana (host, lead) and I paid 1500 each; shares 1000 each, so Dee owes 500 to each of us. */
const splitA = () => shares3(1000, 1000, 1000);
const payersA: Payer[] = [{ userId: HOST, paidCents: 1500 }, { userId: ME, paidCents: 1500 }];
/** B: Hana (host, lead) and Dee paid 1500 each; I owe 500 to each. */
const payersB: Payer[] = [{ userId: HOST, paidCents: 1500 }, { userId: DEE, paidCents: 1500 }];
/** C: I paid 500 of a 3000 bill but my share is 2000, so I owe Hana (paid 2500, share 1000) 1500. */
const splitC = () => shares3(1000, 2000, 0);
const payersC: Payer[] = [{ userId: HOST, paidCents: 2500 }, { userId: ME, paidCents: 500 }];
/** D: the split adds up to 2500 of a 3000 total: stale → blocked_payers. */
const payersStale: Payer[] = [{ userId: HOST, paidCents: 1500 }, { userId: ME, paidCents: 1000 }];
const payersStaleDee: Payer[] = [{ userId: HOST, paidCents: 1500 }, { userId: DEE, paidCents: 1000 }];
const payersStaleMine: Payer[] = [{ userId: ME, paidCents: 1500 }, { userId: HOST, paidCents: 1000 }];
/**
 * E (who-paid T0): Dee paid me 1200 when I was the payer; Hana pays now (one payer, no bill_payers
 * rows). Shares Dee 1200, me 1400, Hana 1400: I pass Dee's 1200 on, so I owe Hana 2600.
 */
const splitE = (opts: { unclaimed?: number } = {}) => shares3(1400, 1400, 1200, opts);
const deePaidMe = () => [pay(DEE, ME, 1200, null)];

const W: Record<string, WhoPaidFixture> = {
  A1: wp('A1 co-payer, Dee unpaid → owed, to collect 500', guestBill(), ledgerOf(splitA(), HOST, { payers: payersA }), 'left_to_pay', 'owed', collectOf(500)),
  A2: wp(
    'A2 co-payer, Dee paid me 500 (Hana still owed) → settled',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersA, payments: (k) => [pay(DEE, ME, 500, k)] }),
    'settled',
    'settled',
    totalOf(4480),
  ),
  A3: wp(
    'A3 co-payer, Dee paid me 400 of 500 → owed, to collect 100',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersA, payments: (k) => [pay(DEE, ME, 400, k)] }),
    'differences',
    'owed',
    collectOf(100),
  ),
  B1: wp('B1 guest owes two payers → waiting, share 1000', guestBill(), ledgerOf(splitA(), HOST, { payers: payersB }), 'owes', 'waiting', share(1000)),
  B2: wp(
    'B2 guest paid Hana, still owes Dee → waiting',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersB, payments: (k) => [pay(ME, HOST, 500, k)] }),
    'owes',
    'waiting',
    share(1000),
  ),
  B3: wp(
    'B3 guest paid both → hidden',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersB, payments: (k) => [pay(ME, HOST, 500, k), pay(ME, DEE, 500, k)] }),
    'paid',
    'hidden',
    share(1000),
  ),
  B4: wp(
    'B4 guest paid Dee 600 of 500 → owed (100 back), share stays',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersB, payments: (k) => [pay(ME, HOST, 500, k), pay(ME, DEE, 600, k)] }),
    'paid_back_due',
    'owed',
    share(1000),
  ),
  B5: wp(
    'B5 guest, Dee flagged my payment as not received → waiting',
    guestBill(),
    ledgerOf(splitA(), HOST, { payers: payersB, flags: [fakePaymentFlag(ME, DEE, 500)] }),
    'not_received',
    'waiting',
    share(1000),
  ),
  C1: wp('C1 co-payer who owes the lead → waiting, total', guestBill(), ledgerOf(splitC(), HOST, { payers: payersC }), 'owes', 'waiting', totalOf(4480)),
  C2: wp(
    'C2 co-payer paid the lead → settled (a payer with nothing left either way)',
    guestBill(),
    ledgerOf(splitC(), HOST, { payers: payersC, payments: (k) => [pay(ME, HOST, 1500, k)] }),
    'paid',
    'settled',
    totalOf(4480),
  ),
  D1: wp('D1 stale split, guest → waiting', guestBill({ totalCents: 3000 }), ledgerOf(splitA(), HOST, { payers: payersStaleDee }), 'waiting_on_others', 'waiting', totalOf(3000)),
  D2: wp('D2 stale split, I host and lead → waiting (fix who paid)', myBill({ totalCents: 3000 }), ledgerOf(splitA(), ME, { payers: payersStaleMine }), 'waiting_on_others', 'waiting', totalOf(3000)),
  D3: wp('D3 stale split, I’m a co-payer, not the host → waiting', guestBill({ totalCents: 3000 }), ledgerOf(splitA(), HOST, { payers: payersStale }), 'waiting_on_others', 'waiting', totalOf(3000)),
  E1: wp('E1 earlier payer passes Dee’s money on → waiting, share 1400', guestBill(), ledgerOf(splitE(), HOST, { payments: () => deePaidMe() }), 'owes', 'waiting', share(1400)),
  E2: wp(
    'E2 earlier payer paid Hana 2600 → hidden',
    guestBill(),
    ledgerOf(splitE(), HOST, { payments: (k) => [...deePaidMe(), pay(ME, HOST, 2600, k)] }),
    'settled',
    'hidden',
    share(1400),
  ),
  F1: wp(
    'F1 early routes (a row unclaimed), I owe → waiting, total',
    guestBill({ complete: false }),
    ledgerOf(splitE({ unclaimed: 500 }), HOST, { payments: () => deePaidMe() }),
    'owes',
    'waiting',
    totalOf(4480),
  ),
  F2: wp(
    'F2 early routes, I host but don’t pay, nothing paid back yet → waiting',
    summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: true, complete: false }),
    ledgerOf(splitE({ unclaimed: 500 }), HOST, { payments: () => deePaidMe() }),
    'owes',
    'waiting',
    totalOf(4480),
  ),
};
const wpick = (key: string): WhoPaidFixture => {
  const f = W[key];
  if (f === undefined) throw new Error(`missing fixture ${key}`);
  return f;
};

const pick = (table: Record<string, GroupFixture>, key: string): GroupFixture => {
  const f = table[key];
  if (f === undefined) throw new Error(`missing fixture ${key}`);
  return f;
};

/** 92's 'sent' state: Hana's unseen Venmo mark to me, Dee still unmarked. */
const sentPlan = planOf(iPay(500, 300), ME, { [HOST]: markMe(500) });
/** The same plan with the last person marked: nobody owes me. */
const sentAllPaidPlan = planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(300) });
const unseenBill = () => myBill({ seenAt: SEEN_BEFORE });

/**
 * Criterion 19: at least one fixture per HomeMarker, keyed by the marker billMarker gives it. Typed
 * Record<HomeMarker, …>, so a new marker kind fails the type-check here as well as in MARKER_GROUPS.
 * Includes 92's fixtures (formerly MARKER_FIXTURES, one per kind), named "92 …".
 */
const GROUP_FIXTURES: Record<HomeMarker, readonly GroupFixture[]> = {
  new: [
    fx('92 guest, added, not opened', summary({ added: true, seen: false }), undefined, 'waiting'),
    fx('payer who isn’t the host, added, not opened (GV-10)', summary({ added: true, seen: false, payerId: ME }), undefined, 'owed'),
  ],
  unclaimed: [fx('92 guest, added, opened, nothing claimed', summary({ added: true, seen: true }), undefined, 'waiting')],
  waiting_on_others: [
    // sent-via-Venmo D7 / groups v2 D-1: claimed on an even-split bill still being claimed
    fx('92 guest B (even, incomplete)', guestBill({ complete: false }), planOf({ ...exact(1510, 0, { unclaimed: 500 }), extrasMode: 'equal' }, HOST), 'waiting'),
    fx('guest B (blocked_all_zero)', guestBill(), planOf(allZero(), HOST), 'waiting'),
    wpick('D1'),
    wpick('D2'),
    wpick('D3'),
  ],
  not_received: [
    fx('guest R, G1 plan, flagged', guestBill(), planOf(exact(1480), HOST, {}, { [ME]: fakeNotReceived(1480, HOST) }), 'waiting'),
    fx('guest E, flagged', guestBill({ complete: false }), planOf(exact(1480, 0, { unclaimed: 500 }), HOST, {}, { [ME]: fakeNotReceived(1480, HOST) }), 'waiting'),
    wpick('B5'),
  ],
  owes: [
    fx('92 guest R owes 1480', guestBill(), planOf(exact(1480), HOST), 'waiting'),
    pick(G, 'G1'),
    fx('guest E owes 1480', guestBill({ complete: false }), planOf(exact(1480, 0, { unclaimed: 500 }), HOST), 'waiting'),
    wpick('B1'),
    wpick('B2'),
    wpick('C1'),
    wpick('E1'),
    wpick('F1'),
    wpick('F2'),
  ],
  paid: [
    fx('92 guest R paid 1480', guestBill(), planOf(exact(1480), HOST, { [ME]: mark(1480) }), 'hidden'),
    pick(G, 'G2'),
    pick(G, 'G3'),
    pick(G, 'G5'),
    fx('guest E paid, zero', guestBill({ complete: false }), planOf(exact(1480, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1480) }), 'hidden'),
    fx('guest E paid, more', guestBill({ complete: false }), planOf(exact(1620, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1480) }), 'waiting'),
    fx('guest E paid, back', guestBill({ complete: false }), planOf(exact(1400, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1480) }), 'owed'),
    wpick('B3'),
    wpick('C2'),
  ],
  paid_more: [fx('92 guest R 1620 marked 1510', guestBill(), planOf(exact(1620), HOST, { [ME]: mark(1510) }), 'waiting'), pick(G, 'G4')],
  paid_back_due: [
    fx('92 guest R 1400 marked 1510 (GV-3)', guestBill(), planOf(exact(1400), HOST, { [ME]: mark(1510) }), 'owed'),
    pick(G, 'G6'),
    pick(G, 'G9'),
    wpick('B4'),
  ],
  left_to_pay: [fx('92 payer R both unmarked', myBill(), planOf(iPay(500, 300), ME), 'owed'), pick(P, 'P1'), pick(P, 'P7'), wpick('A1')],
  differences: [
    fx('92 payer R Hana 400 of 500', myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(400), [DEE]: mark(300) }), 'owed'),
    pick(P, 'P4'),
    pick(P, 'P6'),
    pick(P, 'P5'),
    wpick('A3'),
  ],
  sent: [
    fx('payer R, Hana sent (unseen), Dee unmarked', unseenBill(), sentPlan, 'owed'),
    fx('payer E, Hana sent (unseen), Dee unmarked', unseenBill(), planOf(iPayEarly(), ME, { [HOST]: markMe(500) }), 'owed'),
  ],
  settled: [
    fx('92 payer R Dee 301', myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(500), [DEE]: mark(301) }), 'settled'),
    pick(P, 'P2'),
    pick(P, 'P3'),
    pick(P, 'P9'),
    fx('payer R, last person paid with an unseen send (rule 7)', unseenBill(), sentAllPaidPlan, 'settled'),
    wpick('A2'),
    wpick('E2'),
  ],
};

/** D3's "none (null)" row, cell by cell (criterion 13). */
const NULL_FIXTURES: readonly GroupFixture[] = [
  fx('D3 payer N (incomplete, no plan) → owed', myBill({ complete: false }), undefined, 'owed'),
  fx('D3 payer L (complete, no settle entry) → owed', myBill(), undefined, 'owed'),
  fx('D3 payer B blocked_all_zero → owed', myBill(), planOf(allZero(), ME), 'owed'),
  fx('D3 payer B blocked (even, incomplete) → owed', myBill({ complete: false }), planOf({ ...iPayEarly(), extrasMode: 'equal' }, ME), 'owed'),
  fx('D3 payer E (no marker) → owed', myBill({ complete: false }), planOf(iPayEarly(), ME), 'owed'),
  fx('D3 payer E, all claimers marked, zero → owed (not final)', myBill({ complete: false }), planOf(iPayEarly(), ME, { [HOST]: markMe(500), [DEE]: markMe(300) }), 'owed'),
  fx('D3 payer R zero, no marker → settled (GV-7)', myBill(), planOf(iPay(0, 0), ME), 'settled'),
  fx('D3 guest L (claimed, complete, no facts) → waiting', guestBill(), undefined, 'waiting'),
  fx(
    'D3 guest B, host who isn’t the payer, claimed nothing → waiting',
    summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: false, complete: false }),
    planOf({ ...earlyNothing(), extrasMode: 'equal' }, HOST),
    'waiting',
  ),
  // A guest who claimed nothing is 'unclaimed' (never a settle candidate, so no plan); the reachable
  // "E nothing" viewer is a host who isn't the payer and hasn't claimed yet. Review R2 (user rule 1):
  // "nothing claimed yet" is Waiting on you, even though the early plan says they owe $0.
  fx(
    'D3 guest E nothing, claimed nothing (host who isn’t the payer) → waiting (review R2)',
    summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: false, complete: false }),
    planOf(earlyNothing(), HOST),
    'waiting',
  ),
  // Positive control for R2: the same early plan, but the viewer has claimed (a $0 item), so their
  // zero is confirmed: hidden.
  fx(
    'D3 guest E nothing, claimed a $0 item → hidden (review R2 control)',
    summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: true, complete: false }),
    planOf(earlyClaimedZero(), HOST),
    'hidden',
  ),
  // R2 stays within the plan: the same claimed-nothing viewer on a final plan is hidden (G7's shape
  // with the summary saying so), and on an even/blocked plan it's Waiting (balance unknown).
  fx(
    'D3 guest R nothing, claimed nothing → hidden (final; review R2)',
    summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: false, complete: true }),
    planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST),
    'hidden',
  ),
  pick(G, 'G7'),
  pick(G, 'G8'),
  fx(
    'D3 guest R, ME missing from the plan → waiting (GV-16)',
    guestBill(),
    planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000, 'proportional', [HOST, DEE]), HOST),
    'waiting',
  ),
];

const MARKED_FIXTURES: readonly (GroupFixture & { marker: HomeMarker })[] = (Object.keys(GROUP_FIXTURES) as HomeMarker[]).flatMap((marker) =>
  GROUP_FIXTURES[marker].map((f) => ({ ...f, marker })),
);
const ALL_FIXTURES: readonly GroupFixture[] = [...MARKED_FIXTURES, ...NULL_FIXTURES, ...Object.values(G), ...Object.values(P)];

const groupOf = (f: Pick<GroupFixture, 'bill' | 'facts'>) => homeGroup({ summary: f.bill, plan: f.facts?.plan, myId: ME });
const rowOf = (f: Pick<GroupFixture, 'bill' | 'facts'>, count: number | undefined = 3) => homeRowView(f.bill, ME, f.facts, count, fmt);

// ---------------------------------------------------------------------------
// GV criterion 9: viewerIsPayer
// ---------------------------------------------------------------------------

describe('viewerIsPayer (GV D1, criterion 9)', () => {
  it('no plan → the summary decides', () => {
    expect(viewerIsPayer({ payerId: ME }, undefined, ME)).toBe(true);
    expect(viewerIsPayer({ payerId: HOST }, undefined, ME)).toBe(false);
  });

  it('ready plan wins: the summary says I pay, the plan says Hana → false', () => {
    const plan = planOf(exact(1480), HOST);
    expect(plan.status).toBe('ready');
    expect(viewerIsPayer({ payerId: ME }, plan, ME)).toBe(false);
    expect(viewerIsPayer({ payerId: HOST }, planOf(iPay(500, 300), ME), ME)).toBe(true);
  });

  it('early plan wins too', () => {
    const plan = planOf(iPayEarly(), ME);
    expect(plan.status).toBe('early');
    expect(viewerIsPayer({ payerId: HOST }, plan, ME)).toBe(true);
  });

  it('blocked plans have no payer: the summary decides', () => {
    const blocked = planOf({ ...iPayEarly(), extrasMode: 'equal' }, ME);
    expect(blocked.status).toBe('blocked');
    expect(viewerIsPayer({ payerId: ME }, blocked, ME)).toBe(true);
    expect(viewerIsPayer({ payerId: HOST }, blocked, ME)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GV criterion 10: unknown balance
// ---------------------------------------------------------------------------

describe('viewerBalance unknown (GV D1, criterion 10)', () => {
  const cases: [string, SettlePlanWithEarly | undefined, string][] = [
    ['no plan', undefined, 'none'],
    ['blocked', planOf({ ...exact(1480, 0, { unclaimed: 500 }), extrasMode: 'equal' }, HOST), 'blocked'],
    ['blocked_all_zero', planOf(allZero(), HOST), 'blocked_all_zero'],
    ['blocked_bad_payer', planOf(exact(1480), XAV), 'blocked_bad_payer'],
    ['ready, ME missing', planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000, 'proportional', [HOST, DEE]), HOST), 'ready'],
  ];
  it.each(cases)('%s → { known: false }', (_name, plan, status) => {
    expect(plan?.status ?? 'none').toBe(status);
    expect(viewerBalance({ payerId: HOST }, plan, ME)).toEqual({ known: false });
  });
});

// ---------------------------------------------------------------------------
// GV criteria 11–12: balance boundaries
// ---------------------------------------------------------------------------

describe('guest balance boundaries (GV criterion 11)', () => {
  it('fixture checks: G7 nothing, G8/G9 payer_owes_them −100, G9 back', () => {
    expect(myEntry(pick(G, 'G7').facts!.plan)?.role).toBe('nothing');
    expect(myEntry(pick(G, 'G8').facts!.plan)?.role).toBe('payer_owes_them');
    expect(owedOf(pick(G, 'G8').facts!.plan)).toBe(-100);
    const g9 = myEntry(pick(G, 'G9').facts!.plan);
    expect(g9 && differenceOf(g9)?.kind).toBe('back');
  });

  it.each(Object.entries(G))('%s', (_k, f) => {
    expect(viewerBalance(f.bill, f.facts?.plan, ME)).toEqual({ known: true, final: true, owes: f.owes, owed: f.owed });
    expect(groupOf(f)).toBe(f.group);
  });
});

describe('payer balance boundaries (GV criterion 12)', () => {
  it('fixture checks: P8 both nothing, P9 Hana payer_owes_them', () => {
    const p8 = pick(P, 'P8').facts!.plan;
    if (p8.status !== 'ready') throw new Error('P8 not ready');
    expect(p8.people.filter((e) => e.userId !== ME).map((e) => e.role)).toEqual(['nothing', 'nothing']);
    const p9 = pick(P, 'P9').facts!.plan;
    if (p9.status !== 'ready') throw new Error('P9 not ready');
    expect(p9.people.find((e) => e.userId === HOST)).toMatchObject({ role: 'payer_owes_them', owedCents: -100, mark: null });
  });

  it.each(Object.entries(P))('%s', (_k, f) => {
    expect(viewerBalance(f.bill, f.facts?.plan, ME)).toEqual({ known: true, final: true, owes: f.owes, owed: f.owed });
    expect(groupOf(f)).toBe(f.group);
  });

  it('the markers the spec names for P1–P9', () => {
    const markerOf = (k: string) => billMarker(pick(P, k).bill, ME, pick(P, k).facts?.plan);
    expect(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'].map(markerOf)).toEqual([
      'left_to_pay',
      'settled',
      'settled',
      'differences',
      'differences',
      'differences',
      'left_to_pay',
      null,
      'settled',
    ]);
  });
});

// ---------------------------------------------------------------------------
// GV criteria 13–15: every D3 cell
// ---------------------------------------------------------------------------

describe('D3 cells with no marker (GV criterion 13)', () => {
  it.each(NULL_FIXTURES.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    expect(billMarker(f.bill, ME, f.facts?.plan)).toBeNull();
    expect(groupOf(f)).toBe(f.group);
    expect(rowOf(f).group).toBe(f.group);
  });

  it('guest L shows no pill', () => {
    const f = NULL_FIXTURES.find((x) => x.name.startsWith('D3 guest L'));
    if (!f) throw new Error('missing fixture');
    expect(rowOf(f).pill).toBeNull();
  });
});

describe('D3 cells with a marker (GV criteria 13–15)', () => {
  it.each(MARKED_FIXTURES.map((f) => [`${f.marker}: ${f.name} → ${f.group}`, f] as const))('%s', (_n, f) => {
    expect(billMarker(f.bill, ME, f.facts?.plan)).toBe(f.marker);
    expect(groupOf(f)).toBe(f.group);
  });
});

describe("92's kinds (GV criterion 15)", () => {
  it("'sent': someone still owes → owed, with the pill (homeRowView passes the summary)", () => {
    const row = homeRowView(unseenBill(), ME, facts(sentPlan), 3, fmt);
    expect(row.marker).toBe('sent');
    expect(row.group).toBe('owed');
    expect(row.pill).toEqual({ pill: 'Hana sent you $5.00', a11y: 'Hana sent you $5.00 on Venmo', tone: 'muted', icon: null });
  });

  it("the same plan with the last person marked → settled at once (rule 7), even with unseen sends", () => {
    const bill = unseenBill();
    expect(billMarker(bill, ME, sentAllPaidPlan)).toBe('settled');
    expect(homeGroup({ summary: bill, plan: sentAllPaidPlan, myId: ME })).toBe('settled');
  });

  it("'not_received' on a G1 plan → waiting, with the accent pill", () => {
    const [f] = GROUP_FIXTURES.not_received;
    if (!f) throw new Error('missing fixture');
    const row = rowOf(f);
    expect(row.marker).toBe('not_received');
    expect(row.group).toBe('waiting');
    expect(row.pill?.tone).toBe('accent');
  });
});

// ---------------------------------------------------------------------------
// GV criterion 16: loading never hides or settles
// ---------------------------------------------------------------------------

describe('loading never hides or settles (GV criterion 16, GV-5)', () => {
  it.each(['G2', 'G3', 'G5', 'G7', 'G8'])('%s without facts → waiting', (k) => {
    const f = pick(G, k);
    expect(groupOf(f)).toBe('hidden'); // positive control: with the plan it's hidden
    expect(groupOf({ bill: f.bill, facts: undefined })).toBe('waiting');
  });
  it.each(['P2', 'P3', 'P8', 'P9'])('%s without facts → owed', (k) => {
    const f = pick(P, k);
    expect(groupOf(f)).toBe('settled');
    expect(groupOf({ bill: f.bill, facts: undefined })).toBe('owed');
  });
});

// ---------------------------------------------------------------------------
// GV criterion 17: coming back (rule 6)
// ---------------------------------------------------------------------------

type State = { bill: BillSummary; plan: BillSettlePlan | undefined; marker: HomeMarker | null; group: HomeGroup };
const st = (bill: BillSummary, plan: BillSettlePlan | undefined, marker: HomeMarker | null, group: HomeGroup): State => ({ bill, plan, marker, group });

const guestHidden = () => st(guestBill(), planOf(exact(1480), HOST, { [ME]: mark(1480) }), 'paid', 'hidden');
const payerSettled = () => st(myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(300) }), 'settled', 'settled');
const allMarked = { [HOST]: markMe(500), [DEE]: markMe(300) };
/** iPay plus Xav, who joined: `xav` is his claimed row (0 = he claimed nothing). */
function iPayWithXav(xav: number): SplitInput {
  const items = [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: 500 }, { id: 'd', totalCents: 300 }];
  const claims = [cl('m', ME), cl('h', HOST), cl('d', DEE)];
  if (xav > 0) {
    items.push({ id: 'x', totalCents: xav });
    claims.push(cl('x', XAV));
  }
  return input(items, claims, sum(items), 'proportional', [HOST, ME, DEE, XAV]);
}

const COMING_BACK: [string, State, State][] = [
  ['guest hidden, share → 1620 → waiting', guestHidden(), st(guestBill(), planOf(exact(1620), HOST, { [ME]: mark(1480) }), 'paid_more', 'waiting')],
  ['guest hidden, share → 1400 → owed', guestHidden(), st(guestBill(), planOf(exact(1400), HOST, { [ME]: mark(1480) }), 'paid_back_due', 'owed')],
  [
    'guest hidden, new item, share unchanged → hidden',
    guestHidden(),
    st(guestBill({ complete: false }), planOf(exact(1480, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1480) }), 'paid', 'hidden'),
  ],
  [
    'guest hidden, new item and share 1620 → waiting',
    guestHidden(),
    st(guestBill({ complete: false }), planOf(exact(1620, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1480) }), 'paid', 'waiting'),
  ],
  [
    'guest hidden (even), a new unclaimed item → blocked → waiting',
    st(guestBill(), planOf({ ...exact(1480), extrasMode: 'equal' }, HOST, { [ME]: mark(1480) }), 'paid', 'hidden'),
    st(guestBill({ complete: false }), planOf({ ...exact(1480, 0, { unclaimed: 500 }), extrasMode: 'equal' }, HOST, { [ME]: mark(1480) }), 'waiting_on_others', 'waiting'),
  ],
  [
    'guest paid_more pays the difference → hidden (back to zero)',
    st(guestBill(), planOf(exact(1620), HOST, { [ME]: mark(1480) }), 'paid_more', 'waiting'),
    st(guestBill(), planOf(exact(1620), HOST, { [ME]: mark(1620) }), 'paid', 'hidden'),
  ],
  ['payer settled, one share up → owed', payerSettled(), st(myBill(), planOf(iPay(500, 400), ME, allMarked), 'differences', 'owed')],
  ['payer settled, a new person claims an item → owed', payerSettled(), st(myBill(), planOf(iPayWithXav(200), ME, allMarked), 'left_to_pay', 'owed')],
  ['payer settled, a new person claims nothing → settled', payerSettled(), st(myBill(), planOf(iPayWithXav(0), ME, allMarked), 'settled', 'settled')],
  ['payer settled, the host adds an item (N) → owed', payerSettled(), st(myBill({ complete: false }), undefined, null, 'owed')],
  ['payer settled, the host adds an item (E) → owed', payerSettled(), st(myBill({ complete: false }), planOf(iPayEarly(), ME, allMarked), null, 'owed')],
  ['payer settled, one share drops (pay-back) → waiting', payerSettled(), st(myBill(), planOf(iPay(500, 250), ME, allMarked), 'differences', 'waiting')],
  [
    'payer differences (more) is paid → settled (back to zero)',
    st(myBill(), planOf(iPay(500, 400), ME, allMarked), 'differences', 'owed'),
    st(myBill(), planOf(iPay(500, 400), ME, { [HOST]: markMe(500), [DEE]: markMe(400) }), 'settled', 'settled'),
  ],
  [
    'payer left_to_pay, the last one marks paid (unseen) → settled at once',
    st(myBill(), planOf(iPay(500, 300), ME, { [HOST]: markMe(500) }), 'left_to_pay', 'owed'),
    st(unseenBill(), sentAllPaidPlan, 'settled', 'settled'),
  ],
  [
    'payer two unpaid, one marks paid (unseen) → sent, still owed',
    st(myBill(), planOf(iPay(500, 300), ME), 'left_to_pay', 'owed'),
    st(unseenBill(), sentPlan, 'sent', 'owed'),
  ],
];

describe('coming back (GV criterion 17, rule 6)', () => {
  it.each(COMING_BACK)('%s', (_n, before, after) => {
    for (const s of [before, after]) {
      expect(billMarker(s.bill, ME, s.plan)).toBe(s.marker);
      expect(homeGroup({ summary: s.bill, plan: s.plan, myId: ME })).toBe(s.group);
    }
  });
});

const COMING_BACK_FIXTURES: readonly GroupFixture[] = COMING_BACK.flatMap(([name, before, after]) =>
  [before, after].map((s) => fx(name, s.bill, s.plan, s.group)),
);
const EVERY_FIXTURE: readonly GroupFixture[] = [...ALL_FIXTURES, ...COMING_BACK_FIXTURES];

// ---------------------------------------------------------------------------
// GV criterion 18: the group is the balance
// ---------------------------------------------------------------------------

describe('the group is the balance (GV criterion 18)', () => {
  it.each(EVERY_FIXTURE.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    const plan = f.facts?.plan;
    const b = viewerBalance(f.bill, plan, ME);
    const known = b.known ? b : null;
    const payer = viewerIsPayer(f.bill, plan, ME);
    const g = groupOf(f);
    const zero = known !== null && !known.owes && !known.owed;
    // Review R2: a guest's zero on a plan still being claimed, with nothing claimed, isn't confirmed.
    const unclaimedEarly = !payer && known?.final === false && !f.bill.claimedAny;
    // settled or hidden ⇔ a confirmed zero balance: final for the payer, final or claimed for a guest.
    expect(g === 'settled' || g === 'hidden').toBe(zero && (payer ? known?.final === true : !unclaimedEarly));
    if (zero && unclaimedEarly) expect(g).toBe('waiting');
    if (g === 'settled') expect(payer && known?.final === true).toBe(true);
    if (g === 'hidden') expect(payer).toBe(false);
    if (known !== null && (known.owes || known.owed)) expect(g).toBe(known.owed ? 'owed' : 'waiting');
    // Who-paid D10: a stale split is Waiting on you for everyone (the host must fix it; the others
    // wait on that), co-payers included; otherwise an unknown balance goes by role (GV-5).
    if (known === null) expect(g).toBe(payer && plan?.status !== 'blocked_payers' ? 'owed' : 'waiting');
  });

  it('homeGroup takes no marker', () => {
    const f = pick(G, 'G1');
    // @ts-expect-error: the group never reads the marker (D2).
    expect(homeGroup({ summary: f.bill, plan: f.facts?.plan, myId: ME, marker: 'paid' })).toBe('waiting');
  });
});

// ---------------------------------------------------------------------------
// GV criteria 19–21: MARKER_GROUPS, fixtures, and pill/group agreement
// ---------------------------------------------------------------------------

describe('MARKER_GROUPS (GV D4, criteria 19–20)', () => {
  it('equals D4 (plus D-1’s waiting_on_others)', () => {
    expect(MARKER_GROUPS).toEqual({
      new: ['waiting', 'owed'],
      unclaimed: ['waiting'],
      waiting_on_others: ['waiting'],
      not_received: ['waiting'],
      owes: ['waiting'],
      paid: ['hidden', 'waiting', 'owed', 'settled'],
      paid_more: ['waiting'],
      paid_back_due: ['owed'],
      left_to_pay: ['owed'],
      differences: ['owed', 'waiting'],
      sent: ['owed'],
      settled: ['settled', 'hidden'],
    });
  });

  it('GROUP_FIXTURES has the same keys, each with at least one fixture', () => {
    expect(Object.keys(GROUP_FIXTURES).sort()).toEqual(Object.keys(MARKER_GROUPS).sort());
    for (const list of Object.values(GROUP_FIXTURES)) expect(list.length).toBeGreaterThan(0);
  });

  it('every group a marker allows has a fixture showing it', () => {
    for (const marker of Object.keys(MARKER_GROUPS) as HomeMarker[]) {
      const shown = new Set(GROUP_FIXTURES[marker].map((f) => f.group));
      expect([...MARKER_GROUPS[marker]].sort()).toEqual([...shown].sort());
    }
  });
});

describe('pill and group cannot disagree (GV criterion 21)', () => {
  it.each(EVERY_FIXTURE.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    const plan = f.facts?.plan;
    const row = rowOf(f);
    const marker = billMarker(f.bill, ME, plan);
    expect(row.marker).toBe(marker);
    const expected: MarkerView | null =
      marker === null ? null : billMarkerView(marker, { plan, viewerId: ME, nameOf: f.facts?.nameOf ?? (() => 'Someone'), summary: f.bill });
    expect(row.pill).toEqual(expected);
    // HOME-POLISH-1: the drawn status line is the pill, reworded only where Home maps it.
    expect(row.status).toEqual(homeStatus(marker, expected));
    expect(row.group).toBe(homeGroup({ summary: f.bill, plan, myId: ME }));
    expect(row.group).toBe(f.group);
    if (row.marker !== null) expect(MARKER_GROUPS[row.marker]).toContain(row.group);
  });

  it('every marked fixture draws its pill (positive control for the check above)', () => {
    for (const f of MARKED_FIXTURES) {
      const row = rowOf(f);
      expect([f.name, row.marker]).toEqual([f.name, f.marker]);
      expect([f.name, row.pill === null]).toEqual([f.name, false]);
    }
  });
});

describe("homeRowView's pill is billMarkerView's (criterion 15)", () => {
  it("H2 'new' → pill New, tone accent", () => {
    const [f] = GROUP_FIXTURES.new;
    if (!f) throw new Error('missing fixture');
    const { pill } = homeRowView(f.bill, ME, f.facts, 3, fmt);
    expect(pill?.pill).toBe('New');
    expect(pill?.tone).toBe('accent');
  });

  it('carries the bill id, title and caption', () => {
    const bill = summary({ added: true });
    const row = homeRowView(bill, ME, undefined, 4, fmt);
    expect(row.id).toBe(bill.id);
    expect(row.title).toBe("Hana's bill");
    expect(row.caption).toBe('Nov 20 · 4 people');
    expect(row.amount).toEqual({ kind: 'total', cents: 4480 });
  });
});

// ---------------------------------------------------------------------------
// GV criterion 21a: To collect (A1.M2)
// ---------------------------------------------------------------------------

describe('To collect (GV A1.M2, criterion 21a)', () => {
  const collect = (cents: number) => ({ kind: 'collect', cents });
  const total = { kind: 'total', cents: 4480 };

  it.each([
    ['P1', 800],
    ['P4', 2],
    ['P6', 2],
    ['P7', 500],
  ] as const)('%s → collect %p', (k, cents) => {
    const f = pick(P, k);
    expect(rowOf(f).amount).toEqual(collect(cents));
    expect(stillToCollectCents(f.facts!.plan, ME)).toBe(cents);
  });

  it("the 'sent' fixture → only Dee's unmarked share", () => {
    expect(homeRowView(unseenBill(), ME, facts(sentPlan), 3, fmt).amount).toEqual(collect(300));
  });

  it.each(['P2', 'P3', 'P8', 'P9', 'P5'])('%s (settled, or waiting with pay-backs only) → total', (k) => {
    const f = pick(P, k);
    expect(rowOf(f).amount).toEqual(total);
    expect(stillToCollectCents(f.facts!.plan, ME)).toBe(0);
  });

  it('a payer with an early, blocked or no plan → total, even when owed', () => {
    for (const f of NULL_FIXTURES.filter((x) => x.bill.payerId === ME && x.group === 'owed')) {
      expect([f.name, rowOf(f).amount]).toEqual([f.name, total]);
    }
    const early = GROUP_FIXTURES.sent[1];
    if (!early) throw new Error('missing fixture');
    expect(early.facts?.plan.status).toBe('early');
    expect(rowOf(early).amount).toEqual(total);
    expect(rowAmount(myBill(), ME, planOf(iPayEarly(), ME), 'owed')).toEqual(total);
  });

  it('collect needs the owed group: the same ready plan with another group is the total', () => {
    const plan = pick(P, 'P1').facts!.plan;
    expect(rowAmount(myBill(), ME, plan, 'owed')).toEqual(collect(800));
    expect(rowAmount(myBill(), ME, plan, 'waiting')).toEqual(total);
    expect(rowAmount(myBill(), ME, plan, 'settled')).toEqual(total);
    expect(rowAmount(myBill(), ME, plan)).toEqual(total);
  });

  it("a guest's amount is unchanged on every guest fixture", () => {
    const guests = EVERY_FIXTURE.filter((f) => !viewerIsPayer(f.bill, f.facts?.plan, ME));
    expect(guests.length).toBeGreaterThan(10);
    for (const f of guests) {
      expect([f.name, rowOf(f).amount]).toEqual([f.name, rowAmount(f.bill, ME, f.facts?.plan)]);
    }
    expect(rowOf(pick(G, 'G6')).amount).toEqual({ kind: 'share', cents: 1478 }); // paid_back_due stays share (C2 skipped)
  });

  it('tolerance: a 1¢ more adds 0, 2¢ adds 2', () => {
    const oneCent = planOf(iPay(500, 300), ME, { [HOST]: markMe(500), [DEE]: markMe(299) });
    expect(stillToCollectCents(oneCent, ME)).toBe(0);
    expect(homeGroup({ summary: myBill(), plan: oneCent, myId: ME })).toBe('settled');
    expect(stillToCollectCents(pick(P, 'P4').facts!.plan, ME)).toBe(2);
  });

  it('stillToCollectCents > 0 exactly when the payer is owed, on every payer fixture with a ready plan', () => {
    const payers = EVERY_FIXTURE.filter((f) => f.facts?.plan.status === 'ready' && viewerIsPayer(f.bill, f.facts.plan, ME));
    expect(payers.length).toBeGreaterThan(10);
    for (const f of payers) {
      const b = viewerBalance(f.bill, f.facts?.plan, ME);
      expect([f.name, stillToCollectCents(f.facts!.plan, ME) > 0]).toEqual([f.name, b.known && b.owed]);
    }
  });

  it('label and screen-reader phrase', () => {
    expect(amountLabel('collect')).toBe('To collect');
    const row = rowOf(pick(P, 'P1'));
    expect([row.amountText, row.amountLabel]).toEqual(['$8.00', 'To collect']);
    expect(row.a11yLabel).toBe('Your bill, Nov 20, 3 people, to collect $8.00. 2 people still have to pay you');
  });
});

// ---------------------------------------------------------------------------
// Who paid X2: routes and blocked_payers on Home (D10, contract O)
// ---------------------------------------------------------------------------

describe('who paid X2: routes and blocked_payers plans', () => {
  it('fixture checks: each plan has the status and pairs worked out by hand', () => {
    const statuses = Object.fromEntries(Object.entries(W).map(([k, f]) => [k, f.status]));
    expect(statuses).toEqual({
      A1: 'routes', A2: 'routes', A3: 'routes', B1: 'routes', B2: 'routes', B3: 'routes', B4: 'routes', B5: 'routes',
      C1: 'routes', C2: 'routes', D1: 'blocked_payers', D2: 'blocked_payers', D3: 'blocked_payers',
      E1: 'routes', E2: 'routes', F1: 'routes', F2: 'routes',
    });
    // Contract O by hand: A, Dee owes 500 to each payer; B, I owe 500 to each; C, I owe Hana 1500;
    // E, I owe Hana 2600 (my 1400 plus Dee's 1200 passed on).
    const bal = (k: string) => balanceFor(wpick(k).facts!.plan, ME);
    expect(bal('A1')).toEqual({ known: true, final: true, owesCents: 0, owedCents: 500 });
    expect(bal('A3')).toEqual({ known: true, final: true, owesCents: 0, owedCents: 100 });
    expect(bal('B1')).toEqual({ known: true, final: true, owesCents: 1000, owedCents: 0 });
    expect(bal('B4')).toEqual({ known: true, final: true, owesCents: 0, owedCents: 100 });
    expect(bal('C1')).toEqual({ known: true, final: true, owesCents: 1500, owedCents: 0 });
    expect(bal('E1')).toEqual({ known: true, final: true, owesCents: 2600, owedCents: 0 });
    expect(bal('E2')).toEqual({ known: true, final: true, owesCents: 0, owedCents: 0 });
    expect(bal('F1')).toMatchObject({ known: true, final: false });
    expect(bal('D1')).toEqual({ known: false });
  });

  it.each(Object.entries(W))('%s: marker, group and amount', (_k, f) => {
    const row = rowOf(f);
    expect([f.name, row.marker, row.group, row.amount]).toEqual([f.name, f.marker, f.group, f.amount]);
    if (row.marker !== null) expect(row.pill).not.toBeNull();
  });

  it('viewerIsPayer: anyone in the plan’s payers, on routes and blocked_payers; the summary’s payer doesn’t decide', () => {
    expect(viewerIsPayer({ payerId: HOST }, wpick('A1').facts!.plan, ME)).toBe(true); // co-payer, not the lead
    expect(viewerIsPayer({ payerId: HOST }, wpick('A1').facts!.plan, HOST)).toBe(true); // the lead
    expect(viewerIsPayer({ payerId: HOST }, wpick('A1').facts!.plan, DEE)).toBe(false);
    expect(viewerIsPayer({ payerId: ME }, wpick('B1').facts!.plan, ME)).toBe(false); // summary says me, plan doesn't
    expect(viewerIsPayer({ payerId: HOST }, wpick('D3').facts!.plan, ME)).toBe(true);
    expect(viewerIsPayer({ payerId: ME }, wpick('D1').facts!.plan, ME)).toBe(false);
    // One payer with history: the routes plan's one payer is Hana, not the earlier payer (me).
    expect(viewerIsPayer({ payerId: HOST }, wpick('E1').facts!.plan, ME)).toBe(false);
    expect(viewerIsPayer({ payerId: HOST }, wpick('E1').facts!.plan, HOST)).toBe(true);
  });

  it('viewerBalance is balanceFor’s cents as booleans, on every fixture (single-payer ones included)', () => {
    const all = [...EVERY_FIXTURE, ...Object.values(W)];
    expect(all.length).toBeGreaterThan(80);
    for (const f of all) {
      const plan = f.facts?.plan;
      const b = plan === undefined ? ({ known: false } as const) : balanceFor(plan, ME);
      const want = b.known ? { known: true, final: b.final, owes: b.owesCents > 0, owed: b.owedCents > 0 } : { known: false };
      expect([f.name, viewerBalance(f.bill, plan, ME)]).toEqual([f.name, want]);
    }
  });

  it('stillToCollectCents is balanceFor’s owedCents', () => {
    expect(stillToCollectCents(wpick('A1').facts!.plan, ME)).toBe(500);
    expect(stillToCollectCents(wpick('A3').facts!.plan, ME)).toBe(100);
    expect(stillToCollectCents(wpick('A2').facts!.plan, ME)).toBe(0);
    expect(stillToCollectCents(wpick('A1').facts!.plan, HOST)).toBe(500); // the lead's own 500 from Dee
    expect(stillToCollectCents(wpick('D2').facts!.plan, ME)).toBe(0); // no amounts on a stale split
  });

  it('blocked_payers is Waiting on you for everyone, whatever the role (positive control: blocked goes by role)', () => {
    const groups = ['D1', 'D2', 'D3'].map((k) => groupOf(wpick(k)));
    expect(groups).toEqual(['waiting', 'waiting', 'waiting']);
    // The same co-payer on an incomplete even bill (blocked, no amounts) goes by the summary's role.
    const blocked = planOf({ ...iPayEarly(), extrasMode: 'equal' }, ME);
    expect(homeGroup({ summary: myBill({ complete: false }), plan: blocked, myId: ME })).toBe('owed');
    expect(homeGroup({ summary: myBill({ complete: false }), plan: wpick('D2').facts!.plan, myId: ME })).toBe('waiting');
  });

  it('collect is only for a payer on a final routes plan in Owed to you', () => {
    const plan = wpick('A1').facts!.plan;
    expect(rowAmount(guestBill(), ME, plan, 'owed')).toEqual(collectOf(500));
    // A payer outside Owed to you sees the bill total, as on single-payer bills.
    expect(rowAmount(guestBill(), ME, plan, 'waiting')).toEqual(totalOf(4480));
    expect(rowAmount(guestBill(), ME, plan)).toEqual(totalOf(4480));
    // Early routes are never 'collect' (not final), even in Owed to you.
    expect(rowAmount(guestBill({ hostId: DEE }), HOST, wpick('F1').facts!.plan, 'owed')).toEqual(totalOf(4480));
    // A guest who's owed a pay-back (B4) keeps their share, as on single-payer bills (GV-22).
    expect(rowAmount(guestBill(), ME, wpick('B4').facts!.plan, 'owed')).toEqual(share(1000));
    // The host still sees the bill total unless they're a payer being collected for.
    expect(rowAmount(myBill(), ME, wpick('B1').facts!.plan, 'waiting')).toEqual(totalOf(4480));
  });

  it('a split row’s screen-reader label carries the amount and the pill', () => {
    const row = rowOf(wpick('A1'));
    expect(row.a11yLabel.startsWith("Hana's bill, Nov 20, 3 people, to collect $5.00. ")).toBe(true);
    const guest = rowOf(wpick('B1'));
    expect(guest.a11yLabel.startsWith("Hana's bill, Nov 20, 3 people, your share $10.00. ")).toBe(true);
  });

  it('homeSections places split rows by group', () => {
    const rows = ['A1', 'B1', 'B3', 'A2', 'D3'].map((k) => ({ ...rowOf(wpick(k)), id: k }));
    const out = homeSections(rows);
    expect(out.waiting.map((r) => r.id)).toEqual(['B1', 'D3']);
    expect(out.owed.map((r) => r.id)).toEqual(['A1']);
    expect(out.settled.map((r) => r.id)).toEqual(['A2']);
    expect(out.hiddenCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GV criterion 22: sections
// ---------------------------------------------------------------------------

describe('homeSections (GV D5, criterion 22)', () => {
  const row = (id: string, group: HomeGroup): HomeRowView => ({ ...homeRowView(myBill({ id }), ME, undefined, 1, fmt), group });

  it('is a stable partition; hidden rows only count', () => {
    const rows = [row('w1', 'waiting'), row('o1', 'owed'), row('s1', 'settled'), row('h1', 'hidden'), row('w2', 'waiting'), row('o2', 'owed'), row('s2', 'settled'), row('h2', 'hidden')];
    const out = homeSections(rows);
    expect(out.waiting.map((r) => r.id)).toEqual(['w1', 'w2']);
    expect(out.owed.map((r) => r.id)).toEqual(['o1', 'o2']);
    expect(out.settled.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(out.hiddenCount).toBe(2);
  });

  it('empty, and all hidden', () => {
    const none = { waiting: [], claim: [], pay: [], owed: [], settled: [] };
    expect(homeSections([])).toEqual({ ...none, hiddenCount: 0 });
    expect(homeSections([row('a', 'hidden'), row('b', 'hidden'), row('c', 'hidden')])).toEqual({ ...none, hiddenCount: 3 });
  });

  it('works on real row views', () => {
    const rows: HomeRowView[] = [
      homeRowView(summary({ id: 'X', added: true }), ME, undefined, 3, fmt), // new → waiting
      homeRowView(myBill({ id: 'Y', complete: false }), ME, undefined, 1, fmt), // payer N → owed
      homeRowView(guestBill({ id: 'Z' }), ME, facts(planOf(exact(1480), HOST)), 3, fmt), // owes → waiting
      homeRowView(guestBill({ id: 'W' }), ME, facts(planOf(exact(1480), HOST, { [ME]: mark(1480) })), 3, fmt), // paid → hidden
      homeRowView(myBill({ id: 'S' }), ME, facts(planOf(iPay(500, 300), ME, allMarked)), 3, fmt), // settled
    ];
    const out = homeSections(rows);
    expect(out.waiting.map((r) => r.id)).toEqual(['X', 'Z']);
    expect(out.owed.map((r) => r.id)).toEqual(['Y']);
    expect(out.settled.map((r) => r.id)).toEqual(['S']);
    expect(out.hiddenCount).toBe(1);
  });

  // HOME-SEC-1: "Waiting on you" drawn as Items to claim (nothing claimed yet) and Still needs to be paid.
  it('HOME-SEC-1: waiting rows split into claim (nothing claimed) and pay (claimed), each in list order', () => {
    const rows: HomeRowView[] = [
      homeRowView(summary({ id: 'X', added: true }), ME, undefined, 3, fmt), // new, nothing claimed → claim
      homeRowView(guestBill({ id: 'Z', claimedAny: true }), ME, facts(planOf(exact(1480), HOST)), 3, fmt), // claimed, owes → pay
      homeRowView(summary({ id: 'U', claimedAny: false }), ME, undefined, 3, fmt), // nothing claimed → claim
      homeRowView(myBill({ id: 'Y', complete: false }), ME, undefined, 1, fmt), // owed: not split
    ];
    expect(rows.map((r) => r.waitingFor)).toEqual(['claim', 'pay', 'claim', null]);
    const out = homeSections(rows);
    expect(out.claim.map((r) => r.id)).toEqual(['X', 'U']);
    expect(out.pay.map((r) => r.id)).toEqual(['Z']);
    expect(out.waiting.map((r) => r.id)).toEqual(['X', 'Z', 'U']);
    expect(out.owed.map((r) => r.id)).toEqual(['Y']);
  });

  it('HOME-SEC-1: waitingFor: a split that doesn\'t add up waits on the host, so it is "pay" even with nothing claimed', () => {
    const blocked = { status: 'blocked_payers' } as unknown as BillSettlePlan; // only the status is read
    expect(waitingFor({ claimedAny: false }, blocked)).toBe('pay');
    expect(waitingFor({ claimedAny: false }, undefined)).toBe('claim');
    expect(waitingFor({ claimedAny: true }, undefined)).toBe('pay');
  });

  it('HOME-SEC-2: toggle text and label carry the count', () => {
    expect(sectionToggleText('pay', 2)).toBe('Still needs to be paid (2)');
    expect(sectionToggleA11y('pay', 2)).toBe('Still needs to be paid, 2 bills');
    expect(sectionToggleText('claim', 1)).toBe('Items to claim (1)');
    expect(sectionToggleA11y('owed', 1)).toBe('Owed to you, 1 bill');
  });
});

// ---------------------------------------------------------------------------
// Criterion 16 (last slice) and GV criterion 23: copy
// ---------------------------------------------------------------------------

describe('copy (criterion 16, GV criterion 23)', () => {
  it('section titles', () => {
    expect(HOME_SECTION_TITLES).toEqual({ claim: 'Items to claim', pay: 'Still needs to be paid', owed: 'Owed to you', settled: 'Settled' });
  });
  it('bar copy and the groups copy', () => {
    expect(HOME_COPY).toEqual({
      splitHeading: 'Split a bill',
      addReceipt: 'Add receipt',
      addReceiptHint: 'Take a photo of the receipt, or type the items',
      sectionShowHint: 'Shows these bills',
      sectionHideHint: 'Hides these bills',
      settledShowHint: 'Shows bills everyone has paid you for',
      settledHideHint: 'Hides settled bills',
      settledShow: 'Show',
      settledHide: 'Hide',
      allClear: "You're all caught up.",
      hiddenNote: "Bills you've paid don't show here.",
    });
  });
  it('Settled toggle text and label', () => {
    expect(settledToggleText(5)).toBe('Settled (5)');
    expect(settledToggleA11y(1)).toBe('Settled, 1 bill');
    expect(settledToggleA11y(2)).toBe('Settled, 2 bills');
  });
  it('FIRST_SETTLE_WAIT_MS (A1.M3)', () => {
    expect(FIRST_SETTLE_WAIT_MS).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Criteria 17–18: screen-reader label
// ---------------------------------------------------------------------------

describe('homeRowA11yLabel (D5, criterion 17)', () => {
  it("guest, 'new', 3 people", () => {
    const row = homeRowView(summary({ added: true }), ME, undefined, 3, fmt);
    expect(row.a11yLabel).toBe("Hana's bill, Nov 20, 3 people, total $44.80. New, you haven't opened it yet");
  });

  it("guest, 'owes' (ready, 1480), count unknown", () => {
    const row = homeRowView(guestBill(), ME, facts(planOf(exact(1480), HOST)), undefined, fmt);
    expect(row.a11yLabel).toBe("Hana's bill, Nov 20, your share $14.80. You owe $14.80");
  });

  it('host, no pill, 1 person', () => {
    const row = homeRowView(myBill({ complete: false }), ME, undefined, 1, fmt);
    expect(row.a11yLabel).toBe('Your bill, Nov 20, Just you, total $44.80');
  });

  it("host, 'left_to_pay' (1), 2 people", () => {
    const row = homeRowView(myBill(), ME, facts(planOf(iPay(500, 300), ME, { [HOST]: mark(500) })), 2, fmt);
    expect(row.marker).toBe('left_to_pay');
    // Groups v2 A1.M2: a ready payer row in Owed to you reads what's left to collect (Dee's 300).
    expect(row.a11yLabel).toBe('Your bill, Nov 20, 2 people, to collect $3.00. 1 person still has to pay you');
  });

  it('the row view and the label function agree', () => {
    const row = homeRowView(summary({ added: true }), ME, undefined, 3, fmt);
    expect(
      homeRowA11yLabel({ title: row.title, date: 'Nov 20', people: peopleText(3), amount: row.amount, pill: row.pill }),
    ).toBe(row.a11yLabel);
  });
});

describe('homeRowA11yLabel with missing parts (criterion 18)', () => {
  it('count unknown and no date', () => {
    const row = homeRowView(guestBill({ complete: false, claimedAny: true }), ME, undefined, undefined, noDate);
    expect(row.pill).toBeNull();
    expect(row.a11yLabel).toBe("Hana's bill, total $44.80");
  });

  it('a pill whose view is null adds no trailing sentence', () => {
    expect(homeRowA11yLabel({ title: "Hana's bill", date: 'Nov 20', people: '', amount: { kind: 'share', cents: 1480 }, pill: null })).toBe(
      "Hana's bill, Nov 20, your share $14.80",
    );
  });
});

// ---------------------------------------------------------------------------
// HOME-POLISH-1 (2026-11-28): the status line and the host avatar
// ---------------------------------------------------------------------------

describe('homeStatus (HOME-POLISH-1)', () => {
  it("'unclaimed' reads as the viewer's next step, in the accent tone; the pill keeps its words", () => {
    const row = homeRowView(summary({ seen: true }), ME, undefined, 3, fmt);
    expect(row.marker).toBe('unclaimed');
    expect(row.pill?.pill).toBe('Nothing claimed yet');
    expect(row.status).toEqual({ pill: 'Claim your items', a11y: 'Claim your items', tone: 'accent', icon: null });
    expect(row.a11yLabel).toBe("Hana's bill, Nov 20, 3 people, total $44.80. Claim your items");
  });

  it('the copy table maps only unclaimed', () => {
    expect(HOME_STATUS_COPY).toEqual({ unclaimed: { pill: 'Claim your items', a11y: 'Claim your items', tone: 'accent' } });
  });

  it('every other marked fixture: the status is the pill as is (positive control: it is drawn)', () => {
    for (const f of MARKED_FIXTURES.filter((x) => x.marker !== 'unclaimed')) {
      const row = rowOf(f);
      expect([f.name, row.status]).toEqual([f.name, row.pill]);
      expect([f.name, row.status === null]).toEqual([f.name, false]);
    }
  });

  it('no marker or no view → no status', () => {
    expect(homeStatus(null, null)).toBeNull();
    expect(homeStatus('owes', null)).toBeNull();
    const row = homeRowView(myBill({ complete: false }), ME, undefined, 1, fmt);
    expect(row.status).toBeNull();
  });
});

describe('row host avatar (HOME-POLISH-1)', () => {
  it("a guest's row: the host's one initial, not the viewer", () => {
    expect(homeRowView(guestBill({ hostName: 'Hana Lee' }), ME, undefined, 3, fmt).host).toEqual({
      userId: HOST,
      name: 'Hana Lee',
      initials: 'H',
      isMe: false,
    });
  });

  it('the initial is the first letter or digit: punctuation and a trailing "(demo)" are skipped, case is upper', () => {
    const initialOf = (hostName: string) => homeRowView(guestBill({ hostName }), ME, undefined, 3, fmt).host.initials;
    expect(initialOf('Tejesh (demo)')).toBe('T');
    expect(initialOf('(Sam)')).toBe('S');
    expect(initialOf('élodie')).toBe('É');
    expect(initialOf('7 Eleven crew')).toBe('7');
    expect(initialOf('…')).toBe('?');
  });

  it('your own bill: "Y" for You, marked as the viewer', () => {
    expect(homeRowView(myBill(), ME, undefined, 1, fmt).host).toEqual({ userId: ME, name: 'You', initials: 'Y', isMe: true });
  });

  it('a blank or unset host name: "?" and "A friend", matching the title', () => {
    for (const hostName of [null, '   ']) {
      const row = homeRowView(guestBill({ hostName }), ME, undefined, 3, fmt);
      expect(row.title).toBe("A friend's bill");
      expect(row.host).toEqual({ userId: HOST, name: 'A friend', initials: '?', isMe: false });
    }
  });
});
