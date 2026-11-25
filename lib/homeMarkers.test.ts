// Spec: docs/specs/2026-11-24-bill-markers-and-notices.md D4 (K1, K2), criteria 17–20.
import type { BillSummary } from './bills';
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
  stillDismissed,
  type BillMarker,
  type HomeMarker,
  type MarkerTone,
  type MarkerView,
} from './homeMarkers';
import { settlePlan, type SettleMarks, type SettlePlanWithEarly } from './settle';
import type { ExtrasMode, SplitClaim, SplitInput, SplitItem } from './split';

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
const mark = (cents: number) => ({ cents, at: AT });
const cl = (itemId: string, userId: string, parts = 1): SplitClaim => ({ itemId, userId, parts });
const nameOf = (id: string | null) => (id === ME ? 'You' : id === HOST ? 'Hana' : id === DEE ? 'Dee' : 'Someone');

function planOf(input: SplitInput, payerId: string, marks: SettleMarks = {}): SettlePlanWithEarly {
  return settlePlan(input, payerId, marks, { allowEarly: true });
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

function view(bill: BillSummary, plan: SettlePlanWithEarly | null): MarkerView | null {
  const marker = billMarker(bill, ME, plan);
  return marker === null ? null : billMarkerView(marker, { plan, viewerId: ME, nameOf });
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
      pill: 'Paid · $1.10 back to you',
      a11y: 'Paid, Hana owes you $1.10 back',
      tone: 'muted',
      icon: null,
    });
  });

  it('H4 ready: my share is now $0, so all of it comes back', () => {
    const plan = planOf(input([{ id: 'h', totalCents: 1000 }], [cl('h', HOST)], 1000), HOST, { [ME]: mark(1510) });
    expectView(guestBill({ claimedAny: false }), plan, 'paid_back_due', {
      pill: 'Paid · $15.10 back to you',
      a11y: 'Paid, Hana owes you $15.10 back',
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
      a11y: 'Settled up, everyone has paid you',
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
    // Blocked even-mode bill, blocked_all_zero, bad payer.
    const evenIncomplete = { ...exact(1510, 0, { unclaimed: 500 }), extrasMode: 'equal' as const };
    expect(planOf(evenIncomplete, HOST).status).toBe('blocked');
    expect(billMarker(guestBill({ complete: false }), ME, planOf(evenIncomplete, HOST))).toBeNull();
    const zero = input([{ id: 'h', totalCents: 0 }, { id: 'm', totalCents: 0 }], [cl('h', HOST), cl('m', ME)], 500);
    expect(planOf(zero, HOST).status).toBe('blocked_all_zero');
    expect(billMarker(guestBill(), ME, planOf(zero, HOST))).toBeNull();
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
      const marks: Record<string, { cents: number; at: string }> = {};
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

  it('the payer in early → no marker, even with marks', () => {
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

  it('copy with "You": names come from nameOf, and only H1 says "You"', () => {
    for (const v of VIEWS_SEEN) {
      if (v.pill.startsWith('You owe')) continue;
      expect(v.pill).not.toMatch(/\bYou\b/);
    }
    // H4 names the payer, never the viewer's "You".
    const v = view(guestBill(), planOf(exact(1400), HOST, { [ME]: mark(1510) }));
    expect(v?.a11y).toBe('Paid, Hana owes you $1.10 back');
  });

  it('a blank payer name falls back the way nameOf says (no special casing here)', () => {
    const v = billMarkerView('paid_back_due', { plan: planOf(exact(1400), HOST, { [ME]: mark(1510) }), viewerId: ME, nameOf: () => 'A friend' });
    expect(v?.a11y).toBe('Paid, A friend owes you $1.10 back');
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

describe('settleCandidateIds (criterion 63)', () => {
  it('skips new, unclaimed and payer-incomplete bills; keeps the rest in list order', () => {
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
    expect(ids).toEqual([owesComplete.id, hostPayerComplete.id, owesIncomplete.id]);
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

// Type-level checks (criterion 64): the narrow overload keeps Home's existing BILL_MARKER_COPY lookup valid.
const narrow: BillMarker | null = billMarker(summary(), ME);
const wide: HomeMarker | null = billMarker(summary(), ME, null);
void narrow;
void wide;
