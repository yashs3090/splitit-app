// Spec: docs/specs/2026-11-24-bill-markers-and-notices.md D4 (K1, K2), criteria 17–20; and
// docs/specs/2026-11-26-sent-via-venmo.md D7 (Task 7, criteria 29 and 58).
import { fakeMark, fakeNotReceived } from '@/test-utils/fakes';

import type { BillSummary } from './bills';
import type { NameOf } from './billView';
import {
  ADDED_NOTICE_DISMISS_HINT_MANY,
  ADDED_NOTICE_DISMISS_HINT_ONE,
  ADDED_NOTICE_DISMISS_LABEL,
  ADDED_NOTICE_OPEN_HINT,
  ADDED_NOTICE_OPEN_TEXT,
  addedNotice,
  addedNoticeOpenLabel,
  BILL_MARKER_COPY,
  billMarker,
  billRowA11yLabel,
  dismissKey,
  noticeBillIds,
  billMarkerView,
  settleCandidateIds,
  sentFacts,
  stillDismissed,
  type BillMarker,
  type HomeMarker,
  type MarkerTone,
  type MarkerView,
} from './homeMarkers';
import type { PaymentMethod } from './paymentMethods';
import type { Payer } from './payers';
import {
  balanceFor,
  ledgerSettlePlan,
  settlePlan,
  type BillSettlePlan,
  type SettleLedgerFlag,
  type SettleMark,
  type SettleNotReceivedMap,
  type SettlePlanWithEarly,
} from './settle';
import type { ExtrasMode, SplitClaim, SplitInput, SplitItem } from './split';
import type { Payment } from './transfers';

const ME = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000c';

/** Injected so the tests don't depend on the machine's locale (as lib/billView.test.ts does). */
const fmt = (iso: string) => (iso.startsWith('2026-11-20') ? 'Nov 20' : '?');

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

type Facts = Pick<BillSummary, 'added' | 'seen' | 'claimedAny' | 'complete'>;
type Viewer = 'host' | 'guest' | 'payer';

/** The spec's H1–H11 table. "guest" = neither host nor payer. */
const H: [string, Viewer, Facts, BillMarker | null][] = [
  ['H1', 'host', { added: false, seen: false, claimedAny: false, complete: false }, null],
  ['H2', 'guest', { added: true, seen: false, claimedAny: false, complete: false }, 'new'],
  ['H3', 'guest', { added: true, seen: true, claimedAny: false, complete: false }, 'unclaimed'],
  ['H4', 'guest', { added: true, seen: true, claimedAny: true, complete: false }, null],
  ['H5', 'guest', { added: false, seen: false, claimedAny: false, complete: false }, 'unclaimed'],
  ['H6', 'guest', { added: true, seen: true, claimedAny: false, complete: true }, null],
  ['H7', 'guest', { added: true, seen: false, claimedAny: false, complete: true }, 'new'],
  ['H8', 'payer', { added: false, seen: true, claimedAny: false, complete: false }, null],
  ['H9', 'payer', { added: true, seen: false, claimedAny: false, complete: false }, 'new'],
  ['H10', 'guest', { added: true, seen: false, claimedAny: true, complete: false }, 'new'],
  ['H11', 'host', { added: true, seen: false, claimedAny: false, complete: false }, null],
];

function fixture(viewer: Viewer, facts: Facts): BillSummary {
  if (viewer === 'host') return summary({ hostId: ME, hostName: 'Me Myself', payerId: ME, ...facts });
  if (viewer === 'payer') return summary({ hostId: HOST, payerId: ME, ...facts });
  return summary({ hostId: HOST, payerId: HOST, ...facts });
}

const H_FIXTURES = H.map(([id, viewer, facts, expected]) => ({ id, bill: fixture(viewer, facts), expected }));

describe('billMarker (K1, criterion 17)', () => {
  it.each(H_FIXTURES.map((f) => [f.id, f.bill, f.expected] as const))('%s', (_id, bill, expected) => {
    expect(billMarker(bill, ME)).toBe(expected);
  });

  it('a guest whose bill has a different payer still gets "unclaimed" (not only host-pays bills)', () => {
    expect(billMarker(summary({ payerId: OTHER, seen: true, added: true }), ME)).toBe('unclaimed');
  });
});

describe('BILL_MARKER_COPY and billRowA11yLabel (criterion 18)', () => {
  it('has the K1 pill text and appended label for each marker', () => {
    expect(BILL_MARKER_COPY).toEqual({
      new: { pill: 'New', a11y: "New, you haven't opened it yet" },
      unclaimed: { pill: 'Nothing claimed yet', a11y: "You haven't claimed anything yet" },
    });
  });

  it('H2 (new): appends the "New" label', () => {
    const h2 = H_FIXTURES.find((f) => f.id === 'H2')!.bill;
    expect(billRowA11yLabel(h2, ME, fmt)).toBe("Hana's bill · Nov 20 · $44.80. New, you haven't opened it yet");
  });

  it('H3 (unclaimed): appends the "claimed" label', () => {
    const h3 = H_FIXTURES.find((f) => f.id === 'H3')!.bill;
    expect(billRowA11yLabel(h3, ME, fmt)).toBe("Hana's bill · Nov 20 · $44.80. You haven't claimed anything yet");
  });

  it('H4 (no marker): the list label alone, with nothing appended', () => {
    const h4 = H_FIXTURES.find((f) => f.id === 'H4')!.bill;
    expect(billRowA11yLabel(h4, ME, fmt)).toBe("Hana's bill · Nov 20 · $44.80");
  });

  it('the viewer\'s own bill reads "Your bill" with no marker, even with added: true (H11)', () => {
    for (const id of ['H1', 'H11']) {
      const bill = H_FIXTURES.find((f) => f.id === id)!.bill;
      expect(billRowA11yLabel(bill, ME, fmt)).toBe('Your bill · Nov 20 · $44.80');
    }
  });

  it('a date the formatter cannot read is left out before the appended label', () => {
    const h2 = H_FIXTURES.find((f) => f.id === 'H2')!.bill;
    expect(billRowA11yLabel(h2, ME, () => '')).toBe("Hana's bill · $44.80. New, you haven't opened it yet");
  });
});

describe('addedNotice (K2, criterion 19)', () => {
  it('no new bills → null', () => {
    expect(addedNotice([], ME, fmt)).toBeNull();
    const notNew = H_FIXTURES.filter((f) => f.expected !== 'new').map((f) => f.bill);
    expect(addedNotice(notNew, ME, fmt)).toBeNull();
  });

  it('a count of 1 → kind "one" with the host, date and total (never "1 bills")', () => {
    const bill = summary({ added: true });
    const notice = addedNotice([summary({ added: false }), bill], ME, fmt);
    expect(notice).toEqual({ kind: 'one', bill, title: 'Hana added you to a bill', detail: 'Nov 20 · $44.80' });
    expect(JSON.stringify(notice)).not.toMatch(/\b1 bills?\b/);
  });

  it('trims the host name', () => {
    const notice = addedNotice([summary({ added: true, hostName: '  Hana Lee ' })], ME, fmt);
    expect(notice?.title).toBe('Hana Lee added you to a bill');
  });

  it.each([null, '', '  '])('host name %p → "A friend"', (hostName) => {
    expect(addedNotice([summary({ added: true, hostName })], ME, fmt)?.title).toBe('A friend added you to a bill');
  });

  it("a date formatter returning '' → the total alone", () => {
    expect(addedNotice([summary({ added: true })], ME, () => '')?.detail).toBe('$44.80');
  });

  it('formats the total as is (no arithmetic): 0 and large values', () => {
    expect(addedNotice([summary({ added: true, totalCents: 0 })], ME, fmt)?.detail).toBe('Nov 20 · $0.00');
    expect(addedNotice([summary({ added: true, totalCents: 123450 })], ME, fmt)?.detail).toBe('Nov 20 · $1,234.50');
  });

  it('a count of 2 → kind "many" with "2 bills"', () => {
    const a = summary({ added: true });
    const b = summary({ added: true, hostName: 'Sam' });
    expect(addedNotice([a, b], ME, fmt)).toEqual({
      kind: 'many',
      billIds: [a.id, b.id],
      title: 'You were added to 2 bills',
      detail: "They're marked New below.",
    });
  });

  it('three → kind "many", billIds in list order, skipping bills that are not new', () => {
    const a = summary({ added: true });
    const seen = summary({ added: true, seen: true });
    const b = summary({ added: true });
    const c = summary({ added: true });
    expect(addedNotice([c, seen, a, b], ME, fmt)).toEqual({
      kind: 'many',
      billIds: [c.id, a.id, b.id],
      title: 'You were added to 3 bills',
      detail: "They're marked New below.",
    });
  });

  it('a bill the viewer hosts never counts, even with added: true (H11; never "You added you")', () => {
    const own = summary({ hostId: ME, hostName: 'You', payerId: ME, added: true });
    expect(addedNotice([own], ME, fmt)).toBeNull();
    const other = summary({ added: true });
    const notice = addedNotice([own, other], ME, fmt);
    expect(notice).toEqual({ kind: 'one', bill: other, title: 'Hana added you to a bill', detail: 'Nov 20 · $44.80' });
  });

  it('a host literally named "You" reads as written (names are not rewritten)', () => {
    expect(addedNotice([summary({ added: true, hostName: 'You' })], ME, fmt)?.title).toBe('You added you to a bill');
  });

  it('always covers exactly the bills whose billMarker is "new" (every H fixture)', () => {
    const all = H_FIXTURES.map((f) => f.bill);
    const expectedIds = all.filter((b) => billMarker(b, ME) === 'new').map((b) => b.id);
    expect(expectedIds).toHaveLength(4); // H2, H7, H9, H10
    const notice = addedNotice(all, ME, fmt);
    expect(notice?.kind).toBe('many');
    expect(notice?.kind === 'many' && notice.billIds).toEqual(expectedIds);
    for (const f of H_FIXTURES) {
      const one = addedNotice([f.bill], ME, fmt);
      expect(one === null ? null : one.kind).toBe(f.expected === 'new' ? 'one' : null);
    }
  });
});

describe('notice buttons (K2, criterion 20)', () => {
  it('has the K2 labels and hints', () => {
    expect(ADDED_NOTICE_OPEN_TEXT).toBe('Open');
    expect(ADDED_NOTICE_OPEN_HINT).toBe('Opens the bill so you can claim what you had');
    expect(ADDED_NOTICE_DISMISS_LABEL).toBe('Dismiss');
    expect(ADDED_NOTICE_DISMISS_HINT_ONE).toBe('Hides this and removes New from the bill');
    expect(ADDED_NOTICE_DISMISS_HINT_MANY).toBe('Hides this and removes New from these bills');
  });

  it('labels Open with the same host name as the title', () => {
    expect(addedNoticeOpenLabel(summary({ hostName: ' Hana ' }))).toBe("Open Hana's bill");
    expect(addedNoticeOpenLabel(summary({ hostName: null }))).toBe("Open A friend's bill");
    expect(addedNoticeOpenLabel(summary({ hostName: '  ' }))).toBe("Open A friend's bill");
  });
});

// Home's Dismiss flow (D5, Task 5): which bills a notice covers, and which dismissed ids still hide.
describe('noticeBillIds', () => {
  it('gives the one bill, or every bill in list order', () => {
    const one = summary({ added: true });
    const notice1 = addedNotice([one], ME, fmt);
    expect(notice1 && noticeBillIds(notice1)).toEqual([one.id]);
    const a = summary({ added: true });
    const b = summary({ added: true });
    const notice2 = addedNotice([a, summary(), b], ME, fmt);
    expect(notice2 && noticeBillIds(notice2)).toEqual([a.id, b.id]);
  });
});

describe('stillDismissed (keys are bill id + joinedAt, R2)', () => {
  it('keeps a dismissed key while the server still says New (the write has not landed)', () => {
    const fresh = summary({ added: true, seen: false });
    const dismissed = new Set([dismissKey(fresh)]);
    expect(stillDismissed(dismissed, [fresh], ME)).toBe(dismissed); // unchanged: same set back
  });

  it('drops a key once the server shows it seen, so a later re-add gets a card again', () => {
    const seen = summary({ added: true, seen: true });
    expect([...stillDismissed(new Set([dismissKey(seen)]), [seen], ME)]).toEqual([]);
  });

  it('drops a key whose bill left the list (left or removed)', () => {
    const other = summary({ added: true });
    expect([...stillDismissed(new Set(['gone', dismissKey(other)]), [other], ME)]).toEqual([dismissKey(other)]);
  });

  it('a re-add (same id, new joinedAt) is a different key, so it is not dismissed', () => {
    const before = summary({ added: true, joinedAt: '2026-11-20T19:05:00Z' });
    const again = { ...before, joinedAt: '2026-11-21T09:00:00Z' };
    expect(dismissKey(again)).not.toBe(dismissKey(before));
    expect([...stillDismissed(new Set([dismissKey(before)]), [again], ME)]).toEqual([]);
  });

  it('an empty set stays the same set', () => {
    const empty = new Set<string>();
    expect(stillDismissed(empty, [summary({ added: true })], ME)).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// Home settle markers (docs/specs/2026-11-25-settle-early-and-differences.md D7, Task 7;
// criteria 35–37, 63, 64, 66). Plans are built with settlePlan(..., { allowEarly: true }), the same
// plan the Settle screen's cards are built from (A1.24).
// ---------------------------------------------------------------------------

const DEE = OTHER;
const AT = '2026-11-25T10:00:00Z';
/**
 * A mark as a test writes it. `toUserId` defaults to the plan's payer (planOf fills it in), the way
 * lib/bills.ts fills it from bills.payer_id at parse time.
 */
type TestMark = Omit<SettleMark, 'toUserId'> & { toUserId?: string };
const mark = (cents: number, over: { method?: PaymentMethod; at?: string; toUserId?: string } = {}): TestMark => ({
  cents,
  at: over.at ?? AT,
  method: over.method ?? 'other',
  ...(over.toUserId === undefined ? {} : { toUserId: over.toUserId }),
});
const cl = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });
const nameOf = (id: string | null) => (id === ME ? 'You' : id === HOST ? 'Hana' : id === DEE ? 'Dee' : 'Someone');

function planOf(
  input: SplitInput,
  payerId: string,
  marks: Readonly<Record<string, TestMark | undefined>> = {},
  notReceived: SettleNotReceivedMap = {},
): SettlePlanWithEarly {
  const full = Object.fromEntries(
    Object.entries(marks).map(([u, m]) => [u, m && fakeMark(m.cents, m.at, m.toUserId ?? payerId, m.method)]),
  );
  return settlePlan(input, payerId, full, { allowEarly: true, notReceived });
}
function input(items: SplitItem[], claims: SplitClaim[], totalCents: number, extrasMode: ExtrasMode = 'proportional'): SplitInput {
  return { totalCents, items, claims, participantIds: [HOST, ME, DEE], extrasMode };
}
/** The M3 worked example: Hana burger 1500, me salad 1000, fries 600 shared, total 3600 → I owe 1510. */
const WORKED = input(
  [{ id: 'burger', totalCents: 1500 }, { id: 'salad', totalCents: 1000 }, { id: 'fries', totalCents: 600 }],
  [cl('burger', HOST), cl('salad', ME), cl('fries', HOST), cl('fries', ME)],
  3600,
);
/** No extras, so each share is exactly its row: Hana 1000, me `mine`, Dee `dee` (0 = no row). */
function exact(mine: number, dee = 0, opts: { unclaimed?: number } = {}): SplitInput {
  const items: SplitItem[] = [{ id: 'h', totalCents: 1000 }, { id: 'm', totalCents: mine }];
  const claims = [cl('h', HOST), cl('m', ME)];
  if (dee > 0) {
    items.push({ id: 'd', totalCents: dee });
    claims.push(cl('d', DEE));
  }
  if (opts.unclaimed !== undefined) items.push({ id: 'u', totalCents: opts.unclaimed });
  return input(items, claims, items.reduce((s, i) => s + i.totalCents, 0));
}
/** I pay: me 1000, Hana `hana`, Dee `dee`, no extras. */
function iPay(hana: number, dee: number): SplitInput {
  return input(
    [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: hana }, { id: 'd', totalCents: dee }],
    [cl('m', ME), cl('h', HOST), cl('d', DEE)],
    1000 + hana + dee,
  );
}

/** A guest's bill (Hana hosts and pays), seen, with claims, complete unless said. */
const guestBill = (over: Partial<BillSummary> = {}) => summary({ seen: true, claimedAny: true, complete: true, ...over });
/** A bill I host and pay. */
const myBill = (over: Partial<BillSummary> = {}) => summary({ hostId: ME, payerId: ME, seen: true, complete: true, ...over });

function view(bill: BillSummary, plan: SettlePlanWithEarly | null, names: NameOf = nameOf): MarkerView | null {
  const marker = billMarker(bill, ME, plan);
  return marker === null ? null : billMarkerView(marker, { plan, viewerId: ME, nameOf: names, summary: bill });
}

const VIEWS_SEEN: MarkerView[] = [];
function expectView(bill: BillSummary, plan: SettlePlanWithEarly | null, marker: HomeMarker, expected: MarkerView) {
  expect(billMarker(bill, ME, plan)).toBe(marker);
  const v = view(bill, plan);
  expect(v).toEqual(expected);
  if (v) VIEWS_SEEN.push(v);
}

describe('settle markers H1–H7 (criterion 35)', () => {
  it('H1 ready: I owe and have not paid', () => {
    expectView(guestBill(), planOf(WORKED, HOST), 'owes', { pill: 'You owe $15.10', a11y: 'You owe $15.10', tone: 'accent', icon: null });
  });

  it('H2 ready: paid, no difference', () => {
    expectView(guestBill(), planOf(exact(1510), HOST, { [ME]: mark(1510) }), 'paid', {
      pill: 'Paid $15.10',
      a11y: 'Paid $15.10',
      tone: 'muted',
      icon: 'check',
    });
  });

  it('H2 ready: a 1¢ difference is within tolerance, still "Paid" at the mark amount', () => {
    expectView(guestBill(), planOf(exact(1511), HOST, { [ME]: mark(1510) }), 'paid', {
      pill: 'Paid $15.10',
      a11y: 'Paid $15.10',
      tone: 'muted',
      icon: 'check',
    });
  });

  it('H3 ready: my share went up', () => {
    expectView(guestBill(), planOf(exact(1620), HOST, { [ME]: mark(1510) }), 'paid_more', {
      pill: 'Paid · $1.10 more to pay',
      a11y: 'Paid, you owe $1.10 more',
      tone: 'accent',
      icon: null,
    });
  });

  it('H4 ready: my share went down, Hana owes me some back', () => {
    expectView(guestBill(), planOf(exact(1400), HOST, { [ME]: mark(1510) }), 'paid_back_due', {
      pill: 'You are owed $1.10',
      a11y: 'You are owed $1.10: Hana owes you $1.10 back',
      tone: 'muted',
      icon: null,
    });
  });

  it('H4 ready: my share is now $0, so all of it comes back', () => {
    const plan = planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST, { [ME]: mark(1510) });
    expectView(guestBill({ claimedAny: false }), plan, 'paid_back_due', {
      pill: 'You are owed $15.10',
      a11y: 'You are owed $15.10: Hana owes you $15.10 back',
      tone: 'muted',
      icon: null,
    });
  });

  it('H5: 2 people, then 1 person, left to pay', () => {
    expectView(myBill(), planOf(iPay(500, 300), ME), 'left_to_pay', {
      pill: '2 people left to pay',
      a11y: '2 people still have to pay you',
      tone: 'muted',
      icon: null,
    });
    expectView(myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(500) }), 'left_to_pay', {
      pill: '1 person left to pay',
      a11y: '1 person still has to pay you',
      tone: 'muted',
      icon: null,
    });
  });

  it('H5 wins while someone owing is unmarked, even with a difference elsewhere', () => {
    expect(billMarker(myBill(), ME, planOf(iPay(500, 300), ME, { [HOST]: mark(400) }))).toBe('left_to_pay');
  });

  it('H6: every ower marked, 1 then 2 differences', () => {
    expectView(myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(400), [DEE]: mark(300) }), 'differences', {
      pill: '1 difference to settle',
      a11y: '1 difference to settle',
      tone: 'accent',
      icon: null,
    });
    expectView(myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(400), [DEE]: mark(350) }), 'differences', {
      pill: '2 differences to settle',
      a11y: '2 differences to settle',
      tone: 'accent',
      icon: null,
    });
  });

  it('H6 when nobody owes me but I owe a pay-back (owingCount 0, A1.8)', () => {
    const plan = planOf(input([{ id: 'm', totalCents: 1000 }], [cl('m', ME)], 1000), ME, { [DEE]: mark(1510) });
    expect(plan.status === 'ready' && plan.owingCount).toBe(0);
    expectView(myBill(), plan, 'differences', { pill: '1 difference to settle', a11y: '1 difference to settle', tone: 'accent', icon: null });
  });

  it('H7: everyone has paid and nothing is left to settle', () => {
    expectView(myBill(), planOf(iPay(500, 300), ME, { [HOST]: mark(500), [DEE]: mark(301) }), 'settled', {
      pill: 'Settled up',
      a11y: 'Settled up, everyone has settled up with you',
      tone: 'muted',
      icon: 'check',
    });
  });

  it('no marker: payer with nobody owing and no differences, nothing/negative unmarked, blocked plans', () => {
    // Payer, owingCount 0, d 0.
    expect(billMarker(myBill(), ME, planOf(input([{ id: 'm', totalCents: 1000 }], [cl('m', ME)], 1000), ME))).toBeNull();
    // I owe nothing (no claims, complete bill).
    expect(billMarker(guestBill(), ME, planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST))).toBeNull();
    // Negative share, unmarked (even mode: items 1000 / 0, total 800 → me -100).
    const negative = input([{ id: 'h', totalCents: 1000 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 800, 'equal');
    expect(billMarker(guestBill(), ME, planOf(negative, HOST))).toBeNull();
    // Blocked even-mode bill, blocked_all_zero, bad payer: no settle marker. A guest with claims gets
    // 'waiting_on_others' there instead (sent-via-Venmo D7, criterion 58; tested below).
    const evenIncomplete = { ...exact(1510, 0, { unclaimed: 500 }), extrasMode: 'equal' as const };
    expect(planOf(evenIncomplete, HOST).status).toBe('blocked');
    expect(billMarker(guestBill({ complete: false }), ME, planOf(evenIncomplete, HOST))).toBe('waiting_on_others');
    const zero = input([{ id: 'h', totalCents: 0 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 500);
    expect(planOf(zero, HOST).status).toBe('blocked_all_zero');
    expect(billMarker(guestBill(), ME, planOf(zero, HOST))).toBe('waiting_on_others');
    expect(billMarker(guestBill(), ME, { status: 'blocked_bad_payer' })).toBeNull();
  });

  it('Settled up never shows while an ower is unmarked or a difference remains (seeded random marks)', () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n; // high bits: an LCG's low bits cycle
    };
    let settled = 0;
    for (let i = 0; i < 300; i++) {
      const hana = 1 + next(2000);
      const dee = next(3) === 0 ? 0 : 1 + next(2000);
      const marks: Record<string, TestMark> = {};
      for (const [u, share] of [[HOST, hana], [DEE, dee]] as const) {
        const roll = next(4);
        if (roll === 1) marks[u] = mark(Math.max(1, share));
        if (roll === 2) marks[u] = mark(Math.max(1, share + next(5) - 2));
        if (roll === 3) marks[u] = mark(1 + next(3000));
      }
      const plan = planOf(dee === 0 ? input([{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: hana }], [cl('m', ME), cl('h', HOST)], 1000 + hana) : iPay(hana, dee), ME, marks);
      if (billMarker(myBill(), ME, plan) !== 'settled') continue;
      settled++;
      if (plan.status !== 'ready') throw new Error('settled on a plan that is not ready');
      for (const e of plan.people) {
        if (e.role === 'owes') expect(e.mark).not.toBeNull();
        if (e.role !== 'payer') expect(e.difference ?? null).toBeNull();
      }
    }
    expect(settled).toBeGreaterThan(10); // positive control: the check ran
  });
});

describe('settle marker priority and the host (criterion 36)', () => {
  it('new beats a settle marker', () => {
    expect(billMarker(guestBill({ added: true, seen: false }), ME, planOf(WORKED, HOST))).toBe('new');
  });

  it('unclaimed beats a settle marker (even a stale plan that says I owe)', () => {
    expect(billMarker(guestBill({ claimedAny: false, complete: false }), ME, planOf(WORKED, HOST))).toBe('unclaimed');
  });

  it('the host who pays gets H5–H7 with settle data, and null without', () => {
    const bill = myBill();
    expect(billMarker(bill, ME, planOf(iPay(500, 300), ME))).toBe('left_to_pay');
    expect(billMarker(bill, ME, planOf(iPay(500, 300), ME, { [HOST]: mark(400), [DEE]: mark(300) }))).toBe('differences');
    expect(billMarker(bill, ME, planOf(iPay(500, 300), ME, { [HOST]: mark(500), [DEE]: mark(300) }))).toBe('settled');
    expect(billMarker(bill, ME)).toBeNull();
    expect(billMarker(bill, ME, null)).toBeNull();
    expect(billMarker(bill, ME, undefined)).toBeNull();
  });

  it('the host who owes (someone else pays) gets H1–H4', () => {
    const bill = summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: true, complete: true });
    expect(billMarker(bill, ME, planOf(WORKED, HOST))).toBe('owes');
    expect(billMarker(bill, ME, planOf(exact(1510), HOST, { [ME]: mark(1510) }))).toBe('paid');
    expect(billMarker(bill, ME, planOf(exact(1620), HOST, { [ME]: mark(1510) }))).toBe('paid_more');
    expect(billMarker(bill, ME, planOf(exact(1400), HOST, { [ME]: mark(1510) }))).toBe('paid_back_due');
  });

  it('the host never gets new or unclaimed, with or without settle data', () => {
    const bill = myBill({ added: true, seen: false, claimedAny: false, complete: false });
    expect(billMarker(bill, ME)).toBeNull();
    expect(billMarker(bill, ME, planOf(exact(1510, 0, { unclaimed: 500 }), ME))).toBeNull(); // payer in early
  });

  it('no plan (undefined or null) gives exactly today\'s result on every H fixture', () => {
    for (const f of H_FIXTURES) {
      expect(billMarker(f.bill, ME, undefined)).toBe(f.expected);
      expect(billMarker(f.bill, ME, null)).toBe(f.expected);
    }
  });
});

describe('settle markers in early plans (criterion 37)', () => {
  const EARLY = exact(1510, 0, { unclaimed: 500 }); // the 500 row is unclaimed: early, my share exactly 1510

  it('an ower who paid early → H2 at the mark amount, even with a difference', () => {
    expect(planOf(EARLY, HOST).status).toBe('early');
    expectView(guestBill({ complete: false }), planOf(EARLY, HOST, { [ME]: mark(1510) }), 'paid', {
      pill: 'Paid $15.10',
      a11y: 'Paid $15.10',
      tone: 'muted',
      icon: 'check',
    });
    const moved = planOf(exact(1620, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1510) });
    const me = moved.status === 'early' ? moved.people.find((p) => p.userId === ME) : undefined;
    expect(me && me.role !== 'payer' && me.difference).toEqual({ kind: 'more', cents: 110, fromCents: 1510, toCents: 1620 });
    expect(billMarker(guestBill({ complete: false }), ME, moved)).toBe('paid');
  });

  it('an ower in early who can settle and has not paid → H1', () => {
    expectView(guestBill({ complete: false }), planOf(EARLY, HOST), 'owes', {
      pill: 'You owe $15.10',
      a11y: 'You owe $15.10',
      tone: 'accent',
      icon: null,
    });
  });

  it('an ower in early with only a discount claim → none', () => {
    const plan = planOf(
      input(
        [{ id: 'h', totalCents: 1000 }, { id: 'u', totalCents: 500 }, { id: 'promo', totalCents: -100, kind: 'discount' }],
        [cl('h', HOST), cl('promo', ME)],
        1400,
      ),
      HOST,
    );
    expect(plan.status).toBe('early');
    expect(billMarker(guestBill({ complete: false }), ME, plan)).toBeNull();
  });

  it('an ower in early whose share is $0 (a $0 item) → none', () => {
    const plan = planOf(exact(0, 0, { unclaimed: 500 }), HOST);
    expect(billMarker(guestBill({ complete: false }), ME, plan)).toBeNull();
  });

  it('the payer in early → no marker when every mark is seen (HM-4 still holds without sent)', () => {
    const plan = planOf(
      input([{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: 500 }, { id: 'u', totalCents: 300 }], [cl('m', ME), cl('h', HOST)], 1800),
      ME,
      { [HOST]: mark(500) },
    );
    expect(plan.status).toBe('early');
    expect(billMarker(myBill({ complete: false }), ME, plan)).toBeNull();
  });
});

describe('billMarkerView', () => {
  it("new and unclaimed keep today's copy (accent / muted, no icon), with or without a plan", () => {
    expect(billMarkerView('new', { plan: null, viewerId: ME, nameOf })).toEqual({ ...BILL_MARKER_COPY.new, tone: 'accent', icon: null });
    expect(billMarkerView('unclaimed', { plan: planOf(WORKED, HOST), viewerId: ME, nameOf })).toEqual({
      ...BILL_MARKER_COPY.unclaimed,
      tone: 'muted',
      icon: null,
    });
  });

  it("returns null when the plan doesn't give that marker (never a guessed pill)", () => {
    const owes = planOf(WORKED, HOST);
    expect(billMarkerView('paid', { plan: owes, viewerId: ME, nameOf })).toBeNull();
    expect(billMarkerView('owes', { plan: null, viewerId: ME, nameOf })).toBeNull();
    expect(billMarkerView('settled', { plan: owes, viewerId: ME, nameOf })).toBeNull();
  });

  it('copy with "You": names come from nameOf, and only H1 and H4 say "You"', () => {
    for (const v of VIEWS_SEEN) {
      if (v.pill.startsWith('You owe') || v.pill.startsWith('You are owed')) continue;
      expect(v.pill).not.toMatch(/\bYou\b/);
    }
    // H4 names the payer, never the viewer's "You".
    const v = view(guestBill(), planOf(exact(1400), HOST, { [ME]: mark(1510) }));
    expect(v?.a11y).toBe('You are owed $1.10: Hana owes you $1.10 back');
  });

  it('a blank payer name falls back the way nameOf says (no special casing here)', () => {
    const v = billMarkerView('paid_back_due', { plan: planOf(exact(1400), HOST, { [ME]: mark(1510) }), viewerId: ME, nameOf: () => 'A friend' });
    expect(v?.a11y).toBe('You are owed $1.10: A friend owes you $1.10 back');
  });

  it('tone is only accent or muted, icon only check or null; no glyphs (criteria 64, 66)', () => {
    const tones: readonly MarkerTone[] = ['accent', 'muted'];
    expect(VIEWS_SEEN.length).toBeGreaterThanOrEqual(12);
    for (const v of [...VIEWS_SEEN, billMarkerView('new', { plan: null, viewerId: ME, nameOf })!, billMarkerView('unclaimed', { plan: null, viewerId: ME, nameOf })!]) {
      expect(tones).toContain(v.tone);
      expect([null, 'check']).toContain(v.icon);
      expect(v.pill).not.toMatch(/[✓⚠]/u);
      expect(v.a11y).not.toMatch(/[✓⚠]/u);
    }
    expect(VIEWS_SEEN.filter((v) => v.icon === 'check').map((v) => v.pill)).toEqual(
      expect.arrayContaining(['Paid $15.10', 'Settled up']),
    );
  });
});

describe('billRowA11yLabel with settle data', () => {
  it('appends the settle marker words', () => {
    const bill = guestBill();
    const plan = planOf(exact(1510), HOST, { [ME]: mark(1510) });
    expect(billRowA11yLabel(bill, ME, fmt, { plan, nameOf })).toBe("Hana's bill · Nov 20 · $44.80. Paid $15.10");
    expect(billRowA11yLabel(bill, ME, fmt, { plan: null, nameOf })).toBe("Hana's bill · Nov 20 · $44.80");
    expect(billRowA11yLabel(bill, ME, fmt)).toBe("Hana's bill · Nov 20 · $44.80");
  });

  it('the host-payer row reads "Your bill" plus the payer marker', () => {
    expect(billRowA11yLabel(myBill(), ME, fmt, { plan: planOf(iPay(500, 300), ME), nameOf })).toBe(
      'Your bill · Nov 20 · $44.80. 2 people still have to pay you',
    );
  });
});

describe('settleCandidateIds (criterion 63; HM-4 skip removed by sent-via-Venmo D7)', () => {
  it('skips new and unclaimed bills; keeps the rest in list order, payer-incomplete bills included', () => {
    const fresh = summary({ added: true, seen: false });
    const unclaimed = summary({ seen: true, claimedAny: false, complete: false });
    const payerIncomplete = summary({ payerId: ME, seen: true, claimedAny: true, complete: false });
    const hostPayerIncomplete = myBill({ complete: false });
    const hostPayerComplete = myBill();
    const owesIncomplete = guestBill({ complete: false });
    const owesComplete = guestBill();
    const ids = settleCandidateIds(
      [owesComplete, fresh, hostPayerComplete, unclaimed, payerIncomplete, owesIncomplete, hostPayerIncomplete],
      ME,
    );
    // payerIncomplete and hostPayerIncomplete are now read, so `sent` can show on early payer bills.
    expect(ids).toEqual([owesComplete.id, hostPayerComplete.id, payerIncomplete.id, owesIncomplete.id, hostPayerIncomplete.id]);
  });

  it('includes a complete bill I host but someone else pays, and an incomplete one I host and owe on', () => {
    const a = summary({ hostId: ME, payerId: HOST, complete: true });
    const b = summary({ hostId: ME, payerId: HOST, complete: false });
    expect(settleCandidateIds([a, b], ME)).toEqual([a.id, b.id]);
  });

  it('caps at 20 ids (fetchSettleData refuses more), keeping the first 20 in list order', () => {
    const bills = Array.from({ length: 23 }, () => guestBill());
    expect(settleCandidateIds(bills, ME)).toEqual(bills.slice(0, 20).map((b) => b.id));
  });

  it('[] → []', () => {
    expect(settleCandidateIds([], ME)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sent via Venmo (docs/specs/2026-11-26-sent-via-venmo.md D7, Task 7; criteria 29 and 58)
// ---------------------------------------------------------------------------

const EVE = 'bbbbbbbb-0000-4000-8000-00000000000d';
const names = (id: string | null) => (id === EVE ? 'Eve' : nameOf(id));
/** I pay: me 1000, Hana `hana`, Dee `dee`, Eve `eve`, no extras (four people, so two can send while one still owes). */
function iPay3(hana: number, dee: number, eve: number): SplitInput {
  return {
    totalCents: 1000 + hana + dee + eve,
    items: [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: hana }, { id: 'd', totalCents: dee }, { id: 'e', totalCents: eve }],
    claims: [cl('m', ME), cl('h', HOST), cl('d', DEE), cl('e', EVE)],
    participantIds: [HOST, ME, DEE, EVE],
    extrasMode: 'proportional',
  };
}
/** I pay, bill not complete (a 200 row is unclaimed): early, Hana 500, Dee 300. */
const EARLY_PAY = input(
  [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: 500 }, { id: 'd', totalCents: 300 }, { id: 'u', totalCents: 200 }],
  [cl('m', ME), cl('h', HOST), cl('d', DEE)],
  2000,
);
/** A bill I host and pay that I haven't opened since it was made (no bill_seen row). */
const unseenBill = (over: Partial<BillSummary> = {}) => myBill({ seen: false, seenAt: null, ...over });
const LATER = '2026-11-25T11:00:00Z';

/** Fails the test if billMarker / billMarkerView / sentFacts read the clock (no age-off, U-A1.5). */
function noClock<T>(fn: () => T): T {
  const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
    throw new Error('Home markers must not read the clock');
  });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

type Entry = { userId: string; role: string; mark: unknown };
function entriesOf(plan: SettlePlanWithEarly): readonly Entry[] {
  return plan.status === 'ready' || plan.status === 'early' ? plan.people : [];
}

const SENT_PLANS: SettlePlanWithEarly[] = [];
function expectSent(bill: BillSummary, plan: SettlePlanWithEarly, expected: MarkerView) {
  noClock(() => {
    expect(billMarker(bill, ME, plan)).toBe('sent');
    expect(view(bill, plan, names)).toEqual(expected);
  });
  SENT_PLANS.push(plan);
}
/** The marker isn't 'sent'. `noSenders`: nobody even counts as a sender (sentFacts null). */
function expectNotSent(bill: BillSummary, plan: SettlePlanWithEarly, marker: HomeMarker | null, noSenders = true) {
  noClock(() => {
    expect(billMarker(bill, ME, plan)).toBe(marker);
    if (noSenders) expect(sentFacts(bill, plan, ME, names)).toBeNull();
    else expect(sentFacts(bill, plan, ME, names)).not.toBeNull();
  });
}
const sentView = (pill: string, a11y = pill): MarkerView => ({ pill, a11y, tone: 'muted', icon: null });

describe('sent: the payer sees unseen sends (criterion 29, S1–S15)', () => {
  const oneSent = (method: PaymentMethod, at = AT) => planOf(iPay(500, 300), ME, { [HOST]: mark(500, { method, at }) });

  it('S1 unseen (seenAt null and seen false): one Venmo send while Dee still owes', () => {
    expectSent(unseenBill(), oneSent('venmo'), sentView('Hana sent you $5.00', 'Hana sent you $5.00 on Venmo'));
  });

  it('S2 seen after the mark → left_to_pay', () => {
    expectNotSent(unseenBill({ seen: true, seenAt: '2026-11-25T10:00:01Z' }), oneSent('venmo'), 'left_to_pay');
  });

  it('S3 seenAt null but seen true → not a sender', () => {
    expectNotSent(unseenBill({ seen: true, seenAt: null }), oneSent('venmo'), 'left_to_pay');
  });

  it.each(['2026-11-25T10:00:00.000Z', '2026-11-25T10:00:00+00:00', '2026-11-25T15:30:00+05:30'])(
    'S4 a mark exactly at seenAt (%s, same instant, other spelling) → not a sender (strict >)',
    (seenAt) => {
      expectNotSent(unseenBill({ seen: true, seenAt }), oneSent('venmo'), 'left_to_pay');
    },
  );

  it('S5 1 ms after seenAt → a sender', () => {
    expectSent(unseenBill({ seen: true, seenAt: '2026-11-25T09:59:59.999Z' }), oneSent('venmo'), sentView('Hana sent you $5.00', 'Hana sent you $5.00 on Venmo'));
  });

  it('S6 two senders → "2 people sent you money", a11y newest first; one seen → the other alone', () => {
    const plan = planOf(iPay3(500, 300, 200), ME, {
      [HOST]: mark(500, { method: 'venmo', at: AT }),
      [DEE]: mark(1200, { method: 'cash', at: LATER }),
    });
    expectSent(unseenBill(), plan, sentView('2 people sent you money', '2 people sent you money: Dee $12.00, Hana $5.00'));
    expectSent(unseenBill({ seen: true, seenAt: '2026-11-25T10:30:00Z' }), plan, sentView('Dee paid you $12.00 in cash'));
  });

  it('S7 cash → "paid you … in cash"', () => {
    expectSent(unseenBill(), oneSent('cash'), sentView('Hana paid you $5.00 in cash'));
  });

  it('S8 other → "paid you", a11y "says they paid you"', () => {
    expectSent(unseenBill(), oneSent('other'), sentView('Hana paid you $5.00', 'Hana says they paid you $5.00'));
  });

  it('S9 the viewer is not the payer → no sent (others\' marks to Hana are not mine)', () => {
    const plan = planOf(exact(1510, 300), HOST, { [DEE]: mark(300, { method: 'venmo' }) });
    expectNotSent(guestBill({ seen: false, seenAt: null }), plan, 'owes');
  });

  it('S9 a mark to someone else (a former payer) on my bill → not a sender', () => {
    const plan = planOf(iPay(500, 300), ME, { [HOST]: mark(500, { method: 'venmo', toUserId: DEE }) });
    expectNotSent(unseenBill(), plan, 'left_to_pay');
  });

  it('S9 my own entry is never a sender', () => {
    const plan = planOf(iPay(500, 300), ME, { [ME]: mark(1000, { method: 'venmo' }) });
    expectNotSent(unseenBill(), plan, 'left_to_pay');
  });

  it('S10 differences wins (every ower marked, one off)', () => {
    const plan = planOf(iPay(500, 300), ME, { [HOST]: mark(400, { method: 'venmo' }), [DEE]: mark(300, { method: 'venmo' }) });
    expectNotSent(unseenBill(), plan, 'differences', false);
  });

  it('S11 new wins (I pay, Hana hosts and added me)', () => {
    const bill = summary({ hostId: HOST, payerId: ME, added: true, seen: false, seenAt: null, claimedAny: true, complete: true });
    expect(noClock(() => billMarker(bill, ME, oneSent('venmo')))).toBe('new');
  });

  it('S12 early payer bill with an unmarked ower → sent; with nobody left owing, or nothing unseen → null', () => {
    const one = planOf(EARLY_PAY, ME, { [HOST]: mark(500, { method: 'venmo' }) });
    expect(one.status).toBe('early');
    expectSent(unseenBill({ complete: false }), one, sentView('Hana sent you $5.00', 'Hana sent you $5.00 on Venmo'));
    const both = planOf(EARLY_PAY, ME, { [HOST]: mark(500, { method: 'venmo' }), [DEE]: mark(300, { method: 'venmo' }) });
    expectNotSent(unseenBill({ complete: false }), both, null, false);
    expectNotSent(unseenBill({ complete: false, seen: true, seenAt: LATER }), one, null);
  });

  it("S13 the last ower's unseen mark makes nobody owe → settled, not sent", () => {
    const plan = planOf(iPay(500, 300), ME, { [HOST]: mark(500, { method: 'venmo' }), [DEE]: mark(300, { method: 'venmo' }) });
    expectNotSent(unseenBill(), plan, 'settled', false);
    expect(view(unseenBill(), plan, names)).toEqual({ pill: 'Settled up', a11y: 'Settled up, everyone has settled up with you', tone: 'muted', icon: 'check' });
  });

  it('S14 a cleared mark (Not received) is not a sender', () => {
    const plan = planOf(iPay(500, 300), ME, {}, { [HOST]: fakeNotReceived(500, ME) });
    expectNotSent(unseenBill(), plan, 'left_to_pay');
  });

  it('S15 blank name → "Someone"', () => {
    const blank = (id: string | null) => (id === HOST ? '  ' : names(id));
    const bill = unseenBill();
    const plan = oneSent('venmo');
    expect(view(bill, plan, blank)).toEqual(sentView('Someone sent you $5.00', 'Someone sent you $5.00 on Venmo'));
    expect(view(bill, oneSent('cash'), blank)?.pill).toBe('Someone paid you $5.00 in cash');
  });

  it('copy at a count of 1 never says "1 people", and never says "You"', () => {
    const v = view(unseenBill(), oneSent('venmo'), names);
    expect(v?.pill).not.toMatch(/\b1 (people|person)\b/);
    for (const p of [v?.pill, v?.a11y]) expect(p).not.toMatch(/\bYou\b/);
  });

  it('billMarkerView("sent") needs the summary and a plan that gives sent (never a guessed pill)', () => {
    const plan = oneSent('venmo');
    expect(billMarkerView('sent', { plan, viewerId: ME, nameOf: names })).toBeNull();
    expect(billMarkerView('sent', { plan, viewerId: ME, nameOf: names, summary: unseenBill({ seen: true, seenAt: LATER }) })).toBeNull();
    expect(billMarkerView('sent', { plan: null, viewerId: ME, nameOf: names, summary: unseenBill() })).toBeNull();
  });

  it('billRowA11yLabel appends the sent words', () => {
    expect(billRowA11yLabel(unseenBill(), ME, fmt, { plan: oneSent('venmo'), nameOf: names })).toBe(
      'Your bill · Nov 20 · $44.80. Hana sent you $5.00 on Venmo',
    );
  });

  it('criterion 58: every sent fixture has someone still owing the payer', () => {
    expect(SENT_PLANS.length).toBeGreaterThanOrEqual(7);
    for (const plan of SENT_PLANS) {
      expect(entriesOf(plan).some((e) => e.userId !== ME && e.role === 'owes' && e.mark === null)).toBe(true);
    }
  });
});

describe('sentFacts (D7)', () => {
  it('lists senders newest first with names, cents, method and time', () => {
    const bill = unseenBill();
    const plan = planOf(iPay3(500, 300, 200), ME, {
      [HOST]: mark(500, { method: 'venmo', at: AT }),
      [DEE]: mark(300, { method: 'other', at: LATER }),
    });
    expect(noClock(() => sentFacts(bill, plan, ME, names))).toEqual({
      billId: bill.id,
      senders: [
        { userId: DEE, name: 'Dee', cents: 300, method: 'other', at: LATER },
        { userId: HOST, name: 'Hana', cents: 500, method: 'venmo', at: AT },
      ],
      newestAt: LATER,
    });
  });

  it('null with no senders, on a blocked plan, and for the viewer\'s own mark', () => {
    expect(sentFacts(unseenBill(), planOf(iPay(500, 300), ME), ME, names)).toBeNull();
    expect(sentFacts(unseenBill(), { status: 'blocked_all_zero' }, ME, names)).toBeNull();
  });

  it('two sends at the same instant keep plan order', () => {
    const plan = planOf(iPay3(500, 300, 200), ME, { [HOST]: mark(500, { method: 'venmo' }), [DEE]: mark(300, { method: 'venmo' }) });
    expect(sentFacts(unseenBill(), plan, ME, names)?.senders.map((s) => s.userId)).toEqual([HOST, DEE]);
  });
});

const NOT_RECEIVED_PLANS: SettlePlanWithEarly[] = [];
function expectNotReceived(bill: BillSummary, plan: SettlePlanWithEarly, expected: MarkerView) {
  noClock(() => {
    expect(billMarker(bill, ME, plan)).toBe('not_received');
    expect(view(bill, plan)).toEqual(expected);
  });
  NOT_RECEIVED_PLANS.push(plan);
}

describe('not_received: the ower whose mark the payer cleared (criterion 29, S16)', () => {
  const flag = (toUserId = HOST, method: PaymentMethod = 'venmo') => ({ [ME]: fakeNotReceived(1510, toUserId, method) });
  const nr: MarkerView = { pill: 'Not received · $15.10', a11y: "Hana hasn't received your $15.10", tone: 'accent', icon: null };

  it("unmarked, owes, and the flag names the current payer → 'Not received · $15.10'", () => {
    expectNotReceived(guestBill(), planOf(exact(1510), HOST, {}, flag()), nr);
  });

  it('the pill shows the flag amount for every method (cash, other)', () => {
    expectNotReceived(guestBill(), planOf(exact(1510), HOST, {}, flag(HOST, 'cash')), nr);
    expectNotReceived(guestBill(), planOf(exact(1510), HOST, {}, flag(HOST, 'other')), nr);
  });

  it('early plan, can settle → not_received', () => {
    expectNotReceived(guestBill({ complete: false }), planOf(exact(1510, 0, { unclaimed: 500 }), HOST, {}, flag()), nr);
  });

  it('re-marked → paid, not not_received', () => {
    expect(billMarker(guestBill(), ME, planOf(exact(1510), HOST, { [ME]: mark(1510, { method: 'venmo' }) }, flag()))).toBe('paid');
  });

  it('the flag names a former payer → owes', () => {
    expect(billMarker(guestBill(), ME, planOf(exact(1510), HOST, {}, flag(DEE)))).toBe('owes');
    expect(billMarkerView('not_received', { plan: planOf(exact(1510), HOST, {}, flag(DEE)), viewerId: ME, nameOf })).toBeNull();
  });

  it('my share is now $0 (role nothing) → no marker', () => {
    expect(billMarker(guestBill(), ME, planOf(exact(0), HOST, {}, flag()))).toBeNull();
  });

  it('new and unclaimed win', () => {
    const plan = planOf(exact(1510), HOST, {}, flag());
    expect(billMarker(guestBill({ added: true, seen: false }), ME, plan)).toBe('new');
    expect(billMarker(guestBill({ claimedAny: false, complete: false }), ME, plan)).toBe('unclaimed');
  });

  it('copy never says "You" for the viewer', () => {
    const v = view(guestBill(), planOf(exact(1510), HOST, {}, flag()));
    for (const p of [v?.pill, v?.a11y]) expect(p).not.toMatch(/\bYou\b/);
  });

  it('criterion 58: every not_received fixture has the viewer unmarked with role owes', () => {
    expect(NOT_RECEIVED_PLANS.length).toBeGreaterThanOrEqual(4);
    for (const plan of NOT_RECEIVED_PLANS) {
      const me = entriesOf(plan).find((e) => e.userId === ME);
      expect(me?.role).toBe('owes');
      expect(me?.mark).toBeNull();
    }
  });
});

describe("the ower's own pills by method (criterion 29)", () => {
  const paidPlan = (method: PaymentMethod) => planOf(exact(1510), HOST, { [ME]: mark(1510, { method }) });

  it.each([
    ['venmo', 'Sent $15.10'],
    ['cash', 'Paid $15.10 in cash'],
    ['other', 'Paid $15.10'],
  ] as const)('paid, %s → %s', (method, text) => {
    expectView(guestBill(), paidPlan(method), 'paid', { pill: text, a11y: text, tone: 'muted', icon: 'check' });
  });

  it('early paid by Venmo → Sent', () => {
    expectView(guestBill({ complete: false }), planOf(exact(1510, 0, { unclaimed: 500 }), HOST, { [ME]: mark(1510, { method: 'venmo' }) }), 'paid', {
      pill: 'Sent $15.10',
      a11y: 'Sent $15.10',
      tone: 'muted',
      icon: 'check',
    });
  });

  it('more to pay: Venmo says Sent, cash and other keep Paid', () => {
    const more = (method: PaymentMethod) => planOf(exact(1620), HOST, { [ME]: mark(1510, { method }) });
    expectView(guestBill(), more('venmo'), 'paid_more', { pill: 'Sent · $1.10 more to pay', a11y: 'Sent, you owe $1.10 more', tone: 'accent', icon: null });
    expectView(guestBill(), more('cash'), 'paid_more', { pill: 'Paid · $1.10 more to pay', a11y: 'Paid, you owe $1.10 more', tone: 'accent', icon: null });
  });

  it('back to you: the same "You are owed" for Venmo and cash', () => {
    const back = (method: PaymentMethod) => planOf(exact(1400), HOST, { [ME]: mark(1510, { method }) });
    expectView(guestBill(), back('venmo'), 'paid_back_due', {
      pill: 'You are owed $1.10',
      a11y: 'You are owed $1.10: Hana owes you $1.10 back',
      tone: 'muted',
      icon: null,
    });
    expect(view(guestBill(), back('cash'))?.pill).toBe('You are owed $1.10');
  });
});

describe('waiting_on_others (criterion 58, groups v2 D-1)', () => {
  const evenIncomplete = { ...exact(1510, 0, { unclaimed: 500 }), extrasMode: 'equal' as const };
  const zero = input([{ id: 'h', totalCents: 0 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 500);
  const woo: MarkerView = { pill: 'Claimed · not ready to pay', a11y: "You've claimed. You can pay once the bill is ready", tone: 'muted', icon: null };

  it('a guest with claims on a blocked plan, and on a blocked_all_zero plan', () => {
    expectView(guestBill({ complete: false }), planOf(evenIncomplete, HOST), 'waiting_on_others', woo);
    expect(planOf(zero, HOST).status).toBe('blocked_all_zero');
    expectView(guestBill(), planOf(zero, HOST), 'waiting_on_others', woo);
  });

  it('a host who is not the payer and has claimed gets it too (the rule names the payer, not the host)', () => {
    const bill = summary({ hostId: ME, payerId: HOST, seen: true, claimedAny: true, complete: false });
    expect(billMarker(bill, ME, planOf(evenIncomplete, HOST))).toBe('waiting_on_others');
  });

  it("not when nothing's claimed (unclaimed, or null when complete)", () => {
    expect(billMarker(guestBill({ claimedAny: false, complete: false }), ME, planOf(evenIncomplete, HOST))).toBe('unclaimed');
    expect(billMarker(guestBill({ claimedAny: false }), ME, planOf(zero, HOST))).toBeNull();
  });

  it('not for the payer', () => {
    expect(billMarker(myBill({ complete: false, claimedAny: true }), ME, planOf(evenIncomplete, ME))).toBeNull();
    expect(billMarker(summary({ payerId: ME, seen: true, claimedAny: true, complete: false }), ME, planOf(evenIncomplete, ME))).toBeNull();
  });

  it('not without a plan, nor on bad payer, ready or early plans', () => {
    expect(billMarker(guestBill({ complete: false }), ME)).toBeNull();
    expect(billMarker(guestBill({ complete: false }), ME, null)).toBeNull();
    expect(billMarker(guestBill(), ME, { status: 'blocked_bad_payer' })).toBeNull();
    expect(billMarker(guestBill(), ME, planOf(exact(1510), HOST))).toBe('owes');
    expect(billMarker(guestBill({ complete: false }), ME, planOf(exact(0, 0, { unclaimed: 500 }), HOST))).toBeNull(); // early, $0
  });

  it('billMarkerView gives no pill on a plan that is not blocked', () => {
    expect(billMarkerView('waiting_on_others', { plan: planOf(exact(1510), HOST), viewerId: ME, nameOf })).toBeNull();
    expect(billMarkerView('waiting_on_others', { plan: null, viewerId: ME, nameOf })).toBeNull();
  });
});

// Type-level checks (criterion 64): the narrow overload keeps Home's existing BILL_MARKER_COPY lookup valid.
const narrow: BillMarker | null = billMarker(summary(), ME);
const wide: HomeMarker | null = billMarker(summary(), ME, null);
void narrow;
void wide;

// ---------------------------------------------------------------------------
// Who paid (docs/specs/2026-11-26-who-paid.md D9 last bullet, A1.2 contract O, A1.5; Task 8):
// markers on 'routes' plans (several payers, or money that moved between other people) and on
// 'blocked_payers' (a split that no longer adds up). Plans come from ledgerSettlePlan, the same
// plan the Settle screen reads. ME's id sorts after HOST's and before DEE's and EVE's.
// ---------------------------------------------------------------------------

const PEOPLE4 = [HOST, ME, DEE, EVE];
/** Everyone's display name as `viewer` sees it. */
const namesFor =
  (viewer: string): NameOf =>
  (id) =>
    id === viewer ? 'You' : id === HOST ? 'Hana' : id === ME ? 'Mo' : id === DEE ? 'Dee' : id === EVE ? 'Eve' : 'Someone';
/** One exact row per person with a share > 0 (no extras), plus an unclaimed row when asked. */
function sharesInput(shares: Readonly<Record<string, number>>, opts: { unclaimed?: number } = {}): SplitInput {
  const ids = Object.keys(shares);
  const items: SplitItem[] = ids.filter((id) => (shares[id] ?? 0) > 0).map((id) => ({ id: `i-${id}`, totalCents: shares[id] ?? 0 }));
  const claims = ids.filter((id) => (shares[id] ?? 0) > 0).map((id) => cl(`i-${id}`, id));
  if (opts.unclaimed !== undefined) items.push({ id: 'u', totalCents: opts.unclaimed });
  return { totalCents: items.reduce((s, i) => s + i.totalCents, 0), items, claims, participantIds: ids, extrasMode: 'proportional' };
}
let payN = 0;
function pay(fromId: string, toId: string, cents: number, planKey: string | null, method: PaymentMethod = 'venmo', at = AT): Payment {
  payN += 1;
  return { id: `00000000-0000-4000-8000-${String(payN).padStart(12, '0')}`, fromId, toId, cents, method, planKey, at };
}
type LedgerOpts = { payerId: string; payers?: Payer[]; payments?: Payment[]; flags?: SettleLedgerFlag[]; allowEarly?: boolean; input?: SplitInput };
function ledgerPlan(shares: Readonly<Record<string, number>>, o: LedgerOpts): BillSettlePlan {
  const inp = o.input ?? sharesInput(shares);
  return ledgerSettlePlan(inp, { payerId: o.payerId, payers: o.payers ?? [], payments: o.payments ?? [], flags: o.flags ?? [] }, { allowEarly: o.allowEarly ?? true }).plan;
}
function keyOf(plan: BillSettlePlan): string {
  if (plan.status !== 'routes') throw new Error(`expected routes, got ${plan.status}`);
  return plan.key;
}
function viewAs(viewer: string, bill: BillSummary, plan: BillSettlePlan | null): { marker: HomeMarker | null; view: MarkerView | null } {
  const marker = billMarker(bill, viewer, plan);
  const v = marker === null ? null : billMarkerView(marker, { plan, viewerId: viewer, nameOf: namesFor(viewer), summary: bill });
  return { marker, view: v };
}
const pill = (p: string, a11y: string, tone: MarkerTone, icon: 'check' | null = null): MarkerView => ({ pill: p, a11y, tone, icon });

/** T2 shape: Hana and Dee each paid 5000; four shares of 2500 → Mo→Hana 2500, Eve→Dee 2500. */
const T2_SHARES = { [HOST]: 2500, [ME]: 2500, [DEE]: 2500, [EVE]: 2500 };
const T2_PAYERS: Payer[] = [
  { userId: HOST, paidCents: 5000 },
  { userId: DEE, paidCents: 5000 },
];
const t2 = (payments: (key: string) => Payment[] = () => [], flags: SettleLedgerFlag[] = []) => {
  const base = ledgerPlan(T2_SHARES, { payerId: HOST, payers: T2_PAYERS });
  return ledgerPlan(T2_SHARES, { payerId: HOST, payers: T2_PAYERS, payments: payments(keyOf(base)), flags });
};
/** A guest bill (Hana hosts and leads), seen, claimed, complete, in a 4-person bill. */
const splitGuestBill = (over: Partial<BillSummary> = {}) => guestBill(over);

describe("who paid: 'routes' markers for someone who owes (D9, contract O)", () => {
  it('the plan is a routes plan (T2 shape)', () => {
    const plan = t2();
    expect(plan.status).toBe('routes');
    if (plan.status !== 'routes') return;
    expect(plan.pairs.map((q) => [q.fromId, q.toId, q.remainingCents])).toEqual([
      [ME, HOST, 2500],
      [EVE, DEE, 2500],
    ]);
  });

  it("owes one person: the counterparty's name is in the pill", () => {
    expect(viewAs(ME, splitGuestBill(), t2())).toEqual({
      marker: 'owes',
      view: pill('You owe Hana $25.00', 'You owe Hana $25.00', 'accent'),
    });
  });

  it('owes two people (T1 shape): "You owe 2 people", the a11y lists them, larger first', () => {
    // Paid Hana 6000, Dee 4021; shares Hana 3341, Mo 3340, Dee 3340 → Mo→Hana 2659, Mo→Dee 681.
    const shares = { [HOST]: 3341, [ME]: 3340, [DEE]: 3340 };
    const plan = ledgerPlan(shares, { payerId: HOST, payers: [{ userId: HOST, paidCents: 6000 }, { userId: DEE, paidCents: 4021 }] });
    expect(viewAs(ME, splitGuestBill(), plan)).toEqual({
      marker: 'owes',
      view: pill('You owe 2 people $33.40', 'You owe 2 people $33.40: Hana $26.59, Dee $6.81', 'accent'),
    });
    expect(balanceFor(plan, ME)).toEqual({ known: true, final: true, owesCents: 3340, owedCents: 0 });
  });

  it('a co-payer who owes the others (T5 shape) gets the owes pill, not a payer pill', () => {
    // Paid Mo 5000, Hana 3000, Dee 2000; shares Mo 8000, Hana 1000, Dee 1000 → Mo→Hana 2000, Mo→Dee 1000.
    const shares = { [HOST]: 1000, [ME]: 8000, [DEE]: 1000 };
    const payers: Payer[] = [{ userId: ME, paidCents: 5000 }, { userId: HOST, paidCents: 3000 }, { userId: DEE, paidCents: 2000 }];
    const plan = ledgerPlan(shares, { payerId: ME, payers });
    const bill = splitGuestBill({ payerId: ME });
    expect(viewAs(ME, bill, plan)).toEqual({
      marker: 'owes',
      view: pill('You owe 2 people $30.00', 'You owe 2 people $30.00: Hana $20.00, Dee $10.00', 'accent'),
    });
    expect(viewAs(HOST, bill, plan)).toEqual({ marker: 'left_to_pay', view: pill('1 person left to pay', '1 person still has to pay you', 'muted') });
  });

  it('paid along the route (current key) → the own pill with the method', () => {
    const plan = t2((k) => [pay(ME, HOST, 2500, k)]);
    expect(viewAs(ME, splitGuestBill(), plan)).toEqual({ marker: 'paid', view: pill('Sent $25.00', 'Sent $25.00', 'muted', 'check') });
  });

  it('paid less than the route → more to pay', () => {
    const plan = t2((k) => [pay(ME, HOST, 2000, k, 'cash')]);
    expect(viewAs(ME, splitGuestBill(), plan)).toEqual({
      marker: 'paid_more',
      view: pill('Paid · $5.00 more to pay', 'Paid, you owe $5.00 more', 'accent'),
    });
  });

  it('paid more than the route → owed some back, naming who owes it', () => {
    const plan = t2((k) => [pay(ME, HOST, 3000, k)]);
    expect(viewAs(ME, splitGuestBill(), plan)).toEqual({
      marker: 'paid_back_due',
      view: pill('You are owed $5.00', 'You are owed $5.00: Hana owes you $5.00 back', 'muted'),
    });
    expect(viewAs(HOST, splitGuestBill(), plan)).toEqual({
      marker: 'differences',
      view: pill('1 difference to settle', '1 difference to settle', 'accent'),
    });
  });

  it('within the 1¢ tolerance is still "paid"', () => {
    const plan = t2((k) => [pay(ME, HOST, 2499, k)]);
    expect(viewAs(ME, splitGuestBill(), plan).marker).toBe('paid');
    expect(viewAs(ME, splitGuestBill(), plan).view?.pill).toBe('Sent $24.99');
  });

  it("not received: the recipient's flag on an unpaid route, before owes", () => {
    const plan = t2(() => [], [{ fromId: ME, toId: HOST, cents: 2500, method: 'venmo' }]);
    expect(viewAs(ME, splitGuestBill(), plan)).toEqual({
      marker: 'not_received',
      view: pill('Not received · $25.00', "Hana hasn't received your $25.00", 'accent'),
    });
  });

  it("a flag to someone the viewer doesn't owe now is ignored", () => {
    const plan = t2(() => [], [{ fromId: ME, toId: DEE, cents: 2500, method: 'venmo' }]);
    expect(viewAs(ME, splitGuestBill(), plan).marker).toBe('owes');
  });

  it('someone with a zero share and no pairs gets no pill', () => {
    const shares = { [HOST]: 5000, [ME]: 0, [DEE]: 5000 };
    const plan = ledgerPlan(shares, { payerId: HOST, payers: T2_PAYERS });
    expect(viewAs(ME, splitGuestBill(), plan).marker).toBeNull();
  });

  it('someone not in the plan gets no settle pill', () => {
    const OUT = 'bbbbbbbb-0000-4000-8000-0000000000ff';
    expect(billMarker(splitGuestBill(), OUT, t2())).toBeNull();
    expect(billMarkerView('owes', { plan: t2(), viewerId: OUT, nameOf: namesFor(OUT) })).toBeNull();
  });
});

describe("who paid: 'routes' markers for someone who is owed", () => {
  // Paid Hana 6000, Dee 4000; shares Hana 1000, Mo 4000, Dee 1000, Eve 4000
  // → Mo→Hana 4000, Eve→Hana 1000, Eve→Dee 3000 (pairs ordered by fromId, then toId).
  const SHARES = { [HOST]: 1000, [ME]: 4000, [DEE]: 1000, [EVE]: 4000 };
  const PAYERS: Payer[] = [{ userId: HOST, paidCents: 6000 }, { userId: DEE, paidCents: 4000 }];
  const plan = (payments: (key: string) => Payment[] = () => []) =>
    ledgerPlan(SHARES, { payerId: HOST, payers: PAYERS, payments: payments(keyOf(ledgerPlan(SHARES, { payerId: HOST, payers: PAYERS }))) });
  const hostBill = (over: Partial<BillSummary> = {}) => summary({ hostId: HOST, payerId: HOST, seen: true, complete: true, ...over });

  it('the routes are as worked out', () => {
    const p = plan();
    if (p.status !== 'routes') throw new Error(p.status);
    expect(p.pairs.map((q) => [q.fromId, q.toId, q.remainingCents])).toEqual([
      [ME, HOST, 4000],
      [EVE, HOST, 1000],
      [EVE, DEE, 3000],
    ]);
  });

  it('2, then 1 person left to pay', () => {
    expect(viewAs(HOST, hostBill(), plan())).toEqual({ marker: 'left_to_pay', view: pill('2 people left to pay', '2 people still have to pay you', 'muted') });
    expect(viewAs(HOST, hostBill(), plan((k) => [pay(ME, HOST, 4000, k)]))).toEqual({
      marker: 'left_to_pay',
      view: pill('1 person left to pay', '1 person still has to pay you', 'muted'),
    });
  });

  it("sent: an unseen send while someone still owes the viewer (names from the viewer's nameOf)", () => {
    const p = plan((k) => [pay(ME, HOST, 4000, k)]);
    const bill = hostBill({ seen: false, seenAt: null });
    expect(viewAs(HOST, bill, p)).toEqual({ marker: 'sent', view: pill('Mo sent you $40.00', 'Mo sent you $40.00 on Venmo', 'muted') });
    expect(sentFacts(bill, p, HOST, namesFor(HOST))).toEqual({
      billId: bill.id,
      senders: [{ userId: ME, name: 'Mo', cents: 4000, method: 'venmo', at: AT }],
      newestAt: AT,
    });
    // Seen after the send → back to left_to_pay; no unseen senders.
    const seenBill = hostBill({ seen: true, seenAt: LATER });
    expect(viewAs(HOST, seenBill, p).marker).toBe('left_to_pay');
    expect(sentFacts(seenBill, p, HOST, namesFor(HOST))).toBeNull();
  });

  it('once everyone has paid the viewer, Settled up (even with an unseen send)', () => {
    const p = plan((k) => [pay(ME, HOST, 4000, k), pay(EVE, HOST, 1000, k)]);
    const settled = pill('Settled up', 'Settled up, everyone has settled up with you', 'muted', 'check');
    expect(viewAs(HOST, hostBill(), p)).toEqual({ marker: 'settled', view: settled });
    expect(viewAs(HOST, hostBill({ seen: false, seenAt: null }), p)).toEqual({ marker: 'settled', view: settled });
    expect(viewAs(DEE, splitGuestBill(), p).marker).toBe('left_to_pay'); // Eve→Dee still open
  });

  it('two differences on the viewer’s pairs are counted', () => {
    const p = plan((k) => [pay(ME, HOST, 3000, k), pay(EVE, HOST, 1500, k)]);
    expect(viewAs(HOST, hostBill(), p)).toEqual({ marker: 'differences', view: pill('2 differences to settle', '2 differences to settle', 'accent') });
  });

  it('someone who owes two people sees both (Eve)', () => {
    expect(viewAs(EVE, splitGuestBill(), plan()).view).toEqual(pill('You owe 2 people $40.00', 'You owe 2 people $40.00: Dee $30.00, Hana $10.00', 'accent'));
  });
});

describe("who paid: T0, a one-person bill with money to an ex-payer (A1.2)", () => {
  // Mo was the payer; Dee paid Mo 1200 (earlier key). The host sets the payer to Hana.
  // Shares Hana 1400, Mo 1400, Dee 1200 → Dee→Mo 1200 settled; Mo→Hana 2600.
  const SHARES = { [HOST]: 1400, [ME]: 1400, [DEE]: 1200 };
  const earlier = pay(DEE, ME, 1200, null, 'other');
  const t0 = (more: (key: string) => Payment[] = () => []) => {
    const base = ledgerPlan(SHARES, { payerId: HOST, payments: [earlier] });
    return ledgerPlan(SHARES, { payerId: HOST, payments: [earlier, ...more(keyOf(base))] });
  };

  it('the holder owes the new payer, by name', () => {
    expect(viewAs(ME, splitGuestBill(), t0())).toEqual({ marker: 'owes', view: pill('You owe Hana $26.00', 'You owe Hana $26.00', 'accent') });
  });
  it('the sender has nothing left: their own paid pill', () => {
    expect(viewAs(DEE, splitGuestBill(), t0())).toEqual({ marker: 'paid', view: pill('Paid $12.00', 'Paid $12.00', 'muted', 'check') });
  });
  it('the new payer waits on one person', () => {
    expect(viewAs(HOST, summary({ hostId: HOST, seen: true, complete: true }), t0()).marker).toBe('left_to_pay');
  });
  it('once the holder pays on, they read Settled up (they were paid and have paid)', () => {
    expect(viewAs(ME, splitGuestBill(), t0((k) => [pay(ME, HOST, 2600, k)])).marker).toBe('settled');
  });

  describe('early (incomplete, proportional, one payer)', () => {
    const earlyInput = sharesInput(SHARES, { unclaimed: 100 });
    const early = (more: (key: string) => Payment[] = () => []) => {
      const base = ledgerPlan(SHARES, { payerId: HOST, payments: [earlier], input: earlyInput });
      return ledgerPlan(SHARES, { payerId: HOST, payments: [earlier, ...more(keyOf(base))], input: earlyInput });
    };
    it('is an early routes plan', () => {
      const p = early();
      expect(p.status === 'routes' && p.early !== null).toBe(true);
    });
    it('an item claimer who owes → owes', () => {
      expect(viewAs(ME, splitGuestBill({ complete: false }), early()).marker).toBe('owes');
    });
    it('a difference paid early reads as paid (differences wait for completion)', () => {
      expect(viewAs(ME, splitGuestBill({ complete: false }), early((k) => [pay(ME, HOST, 2000, k)])).marker).toBe('paid');
    });
    it('the creditor gets no pill unless there is an unseen send while someone still owes (HM-4)', () => {
      const hostBill = summary({ hostId: HOST, seen: true, seenAt: LATER, complete: false });
      expect(viewAs(HOST, hostBill, early()).marker).toBeNull();
      // Mo, the only one owing Hana, sent part: nobody unpaid is left, so no pill (as one payer's early plan).
      expect(viewAs(HOST, summary({ hostId: HOST, complete: false }), early((k) => [pay(ME, HOST, 1000, k)])).marker).toBeNull();
      // Eve owes Hana too and hasn't paid: the unseen send shows.
      const shares = { [HOST]: 1400, [ME]: 1400, [DEE]: 1200, [EVE]: 300 };
      const inp = sharesInput(shares, { unclaimed: 100 });
      const base = ledgerPlan(shares, { payerId: HOST, payments: [earlier], input: inp });
      const p = ledgerPlan(shares, { payerId: HOST, payments: [earlier, pay(ME, HOST, 1000, keyOf(base))], input: inp });
      expect(viewAs(HOST, summary({ hostId: HOST, complete: false }), p)).toEqual({
        marker: 'sent',
        view: pill('Mo sent you $10.00', 'Mo sent you $10.00 on Venmo', 'muted'),
      });
    });
    it("someone who can't settle early (no item claim) gets no owes pill", () => {
      const shares = { [HOST]: 1400, [ME]: 1400, [DEE]: 1200, [EVE]: 0 };
      const inp = sharesInput(shares, { unclaimed: 100 });
      const p = ledgerPlan(shares, { payerId: HOST, payments: [earlier], input: inp });
      expect(p.status).toBe('routes');
      expect(viewAs(EVE, splitGuestBill({ complete: false, claimedAny: true }), p).marker).toBeNull();
    });
  });
});

describe("who paid: 'blocked_payers' (D9 Home pills, D10 groups)", () => {
  // Hana 6000 + Dee 4000 = 10000, but the total is now 10300.
  const SHARES = { [HOST]: 2575, [ME]: 2575, [DEE]: 2575, [EVE]: 2575 };
  const stale = () => ledgerPlan(SHARES, { payerId: HOST, payers: [{ userId: HOST, paidCents: 6000 }, { userId: DEE, paidCents: 4000 }] });
  const FIX = pill('Fix who paid', "Who paid doesn't match the new total. Fix who paid", 'accent');
  const UPDATING = pill('Who paid is being updated', "Who paid is being updated. You can settle up once it's fixed", 'muted');

  it('is a blocked_payers plan', () => {
    expect(stale().status).toBe('blocked_payers');
  });
  it('the host: Fix who paid (accent)', () => {
    const bill = summary({ hostId: ME, payerId: ME, seen: true, complete: true });
    expect(viewAs(ME, bill, stale())).toEqual({ marker: 'waiting_on_others', view: FIX });
  });
  it('the host, even with nothing claimed and the bill incomplete', () => {
    const bill = summary({ hostId: ME, payerId: ME, seen: true, complete: false, claimedAny: false });
    expect(viewAs(ME, bill, stale())).toEqual({ marker: 'waiting_on_others', view: FIX });
  });
  it('a guest who claimed: Who paid is being updated (muted)', () => {
    expect(viewAs(ME, splitGuestBill(), stale())).toEqual({ marker: 'waiting_on_others', view: UPDATING });
  });
  it('a co-payer who is not the host gets the same as other guests', () => {
    expect(viewAs(DEE, splitGuestBill(), stale())).toEqual({ marker: 'waiting_on_others', view: UPDATING });
  });
  it('a guest on a complete bill without claims still sees it', () => {
    expect(viewAs(ME, splitGuestBill({ claimedAny: false }), stale())).toEqual({ marker: 'waiting_on_others', view: UPDATING });
  });
  it('new and unclaimed still win for guests', () => {
    expect(billMarker(splitGuestBill({ added: true, seen: false }), ME, stale())).toBe('new');
    expect(billMarker(splitGuestBill({ claimedAny: false, complete: false }), ME, stale())).toBe('unclaimed');
  });
  it("without the summary's host id the view can't tell the host, so it gives the guest copy", () => {
    expect(billMarkerView('waiting_on_others', { plan: stale(), viewerId: ME, nameOf: namesFor(ME) })).toEqual(UPDATING);
  });
  it('the row label gains the a11y words', () => {
    const bill = summary({ hostId: ME, payerId: ME, seen: true, complete: true });
    expect(billRowA11yLabel(bill, ME, fmt, { plan: stale(), nameOf: namesFor(ME) })).toBe(
      "Your bill · Nov 20 · $44.80. Who paid doesn't match the new total. Fix who paid",
    );
  });
  it('other markers give no pill on a blocked_payers plan', () => {
    for (const m of ['owes', 'paid', 'left_to_pay', 'settled', 'sent'] as const) {
      expect(billMarkerView(m, { plan: stale(), viewerId: ME, nameOf: namesFor(ME) })).toBeNull();
    }
    expect(sentFacts(splitGuestBill(), stale(), ME, namesFor(ME))).toBeNull();
  });
});

describe('who paid: a split that is incomplete is blocked as before (rule E′)', () => {
  it('a guest who claimed: Claimed · not ready to pay', () => {
    const inp = sharesInput(T2_SHARES, { unclaimed: 0 });
    inp.items.push({ id: 'u2', totalCents: 0 });
    inp.totalCents = 10000;
    const plan = ledgerPlan(T2_SHARES, { payerId: HOST, payers: T2_PAYERS, input: inp });
    expect(plan.status).toBe('blocked');
    expect(viewAs(ME, splitGuestBill({ complete: false }), plan)).toEqual({
      marker: 'waiting_on_others',
      view: pill('Claimed · not ready to pay', "You've claimed. You can pay once the bill is ready", 'muted'),
    });
  });
});
