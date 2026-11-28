// Spec docs/specs/2026-11-28-tab-bar-and-activity.md, Contracts F and G, criteria 1–7.
// Expected values are worked out by hand from the spec's table, not read off the code.
import {
  activityUnreadCount,
  badgeSpokenText,
  badgeText,
  classifyFeedEvent,
  FEED_BILL_KINDS,
  FEED_GROUP_KINDS,
  feedPlaceKey,
  groupsDot,
  inFeedFilter,
  milestoneTrigger,
  myClaimedRowNames,
  type FeedCategory,
  type FeedItem,
} from './feedRules';
import {
  ANA,
  B1,
  B1_CLAIMS_DATA,
  B2,
  B2_CLAIMS_DATA,
  B_OTHER,
  billEvent,
  EVENT_AT,
  EXCLUDED_BILL_EVENTS,
  EXCLUDED_GROUP_EVENTS,
  EXPENSE_GAS,
  F_CASES,
  feedCtx,
  G1,
  G1_OPENED_AT,
  G2_HIDDEN,
  G_OTHER,
  groupEvent,
  JOINED_AT,
  JOINED_AT_MINUS_1MS,
  MAYA,
  ME,
  MORE_EVENTS,
  NO_CLAIMS,
  P_ME_TO_ANA,
  P_MISSING,
  P_SAM_TO_ANA,
  P_SAM_TO_ME,
  ROLLUP_EVENTS,
  SAM,
} from '@/test-utils/feedFixtures';

const claims = new Map([
  [B1, myClaimedRowNames(B1_CLAIMS_DATA, ME)],
  [B2, myClaimedRowNames(B2_CLAIMS_DATA, ME)],
]);
const ctx = feedCtx(claims);
const noClaimsCtx = feedCtx(NO_CLAIMS);

type Expect = { category: FeedCategory; counts: boolean; amountCents: number | null; counterpartId: string | null };

function pick(item: FeedItem | null): Expect | null {
  if (item === null) return null;
  return { category: item.category, counts: item.counts, amountCents: item.amountCents, counterpartId: item.counterpartId };
}

describe('myClaimedRowNames', () => {
  it('lists the trimmed names of the rows I claim, from BillData claims', () => {
    expect([...myClaimedRowNames(B1_CLAIMS_DATA, ME)].sort()).toEqual(['Nachos', 'Tacos']);
    expect([...myClaimedRowNames(B1_CLAIMS_DATA, SAM)].sort()).toEqual(['Fries', 'Nachos']);
    expect(myClaimedRowNames(B1_CLAIMS_DATA, ANA).size).toBe(0);
  });
});

describe('FEED_BILL_KINDS / FEED_GROUP_KINDS', () => {
  it('are exactly the kinds named in the Contract F table', () => {
    expect([...FEED_BILL_KINDS].sort()).toEqual(
      [
        'participant_added',
        'assigned',
        'marked_paid',
        'paid_difference',
        'paid_back',
        'unmarked_paid',
        'not_received',
        'amounts_changed',
        'extras_split_changed',
        'item_removed',
        'item_changed',
        'split_changed',
        'unassigned',
        'payers_changed',
        'payer_changed',
        'claimed',
        'unclaimed',
        'joined',
      ].sort(),
    );
    expect([...FEED_GROUP_KINDS].sort()).toEqual(
      ['payment_recorded', 'payment_undone', 'expense_added', 'expense_edited', 'expense_deleted', 'bill_added', 'bill_removed', 'member_joined'].sort(),
    );
  });
});

// Criterion 1: each F-row, met and unmet.
describe('classifyFeedEvent: inclusion and category (criterion 1)', () => {
  const rows: [keyof typeof F_CASES, Expect, Expect | null][] = [
    ['F-a', { category: 'needs_you', counts: true, amountCents: null, counterpartId: null }, { category: 'rollup', counts: false, amountCents: null, counterpartId: ANA }],
    ['F-b', { category: 'needs_you', counts: true, amountCents: null, counterpartId: null }, { category: 'rollup', counts: false, amountCents: null, counterpartId: SAM }],
    ['F-c', { category: 'money', counts: true, amountCents: 1820, counterpartId: SAM }, null],
    ['F-d', { category: 'money', counts: true, amountCents: 285, counterpartId: SAM }, null],
    ['F-e', { category: 'money', counts: true, amountCents: 285, counterpartId: SAM }, null],
    ['F-f', { category: 'money', counts: true, amountCents: 1820, counterpartId: MAYA }, null],
    ['F-g', { category: 'dispute', counts: true, amountCents: 1820, counterpartId: MAYA }, null],
    ['F-j', { category: 'share', counts: true, amountCents: null, counterpartId: null }, null],
    ['F-k', { category: 'share', counts: true, amountCents: null, counterpartId: null }, null],
    ['F-l', { category: 'share', counts: true, amountCents: null, counterpartId: null }, { category: 'rollup', counts: false, amountCents: null, counterpartId: null }],
    ['F-m', { category: 'share', counts: true, amountCents: null, counterpartId: null }, { category: 'rollup', counts: false, amountCents: null, counterpartId: SAM }],
    ['F-n', { category: 'share', counts: true, amountCents: null, counterpartId: null }, null],
    ['F-o', { category: 'share', counts: true, amountCents: null, counterpartId: null }, null],
    ['F-r', { category: 'money', counts: true, amountCents: 2500, counterpartId: SAM }, null],
    ['F-s', { category: 'money', counts: true, amountCents: 2500, counterpartId: SAM }, null],
    ['F-t', { category: 'dispute', counts: true, amountCents: 3000, counterpartId: ANA }, { category: 'money', counts: true, amountCents: 3000, counterpartId: ANA }],
  ];
  it.each(rows)('%s', (row, met, unmet) => {
    const c = F_CASES[row];
    expect(pick(classifyFeedEvent(c.met, ctx))).toEqual(met);
    expect(c.unmet).not.toBeNull();
    if (c.unmet !== null) expect(pick(classifyFeedEvent(c.unmet, ctx))).toEqual(unmet);
  });

  it('F-h and F-i: share when I have a claim on the bill now; null when I have none', () => {
    for (const c of [F_CASES['F-h'], F_CASES['F-i']]) {
      expect(pick(classifyFeedEvent(c.met, ctx))).toEqual({ category: 'share', counts: true, amountCents: null, counterpartId: null });
      expect(classifyFeedEvent(c.unmet, noClaimsCtx)).toBeNull();
    }
  });

  it('F-h carries the changed fields by name only, in Contract C order (tip, tax, fees, discount, total)', () => {
    const item = classifyFeedEvent(F_CASES['F-h'].met, ctx);
    expect(item?.fields).toEqual(['tip', 'tax']);
    const all = billEvent('amounts_changed', {
      details: {
        total_cents: [1, 2],
        subtotal_discount_cents: [0, 100],
        total_discount_cents: [0, 50],
        fees_cents: [0, 1],
        tax_cents: [1, 2],
        tip_cents: [1, 2],
      },
    });
    expect(classifyFeedEvent(all, ctx)?.fields).toEqual(['tip', 'tax', 'fees', 'discount', 'total']);
    // No known key: still a share line ("the amounts"), with no fields.
    expect(classifyFeedEvent(billEvent('amounts_changed', { details: {} }), ctx)?.fields).toEqual([]);
  });

  it('F-k: price or qty changes on a row I claim (matched by name); name/note-only changes are excluded', () => {
    expect(classifyFeedEvent(MORE_EVENTS.itemChangedQty, ctx)?.category).toBe('share');
    expect(classifyFeedEvent(MORE_EVENTS.itemChangedNameOnly, ctx)).toBeNull();
    expect(classifyFeedEvent(MORE_EVENTS.itemChangedNoteOnly, ctx)).toBeNull();
    // Positive control for the name-only case: the same row with a price change is included.
    expect(classifyFeedEvent(F_CASES['F-k'].met, ctx)?.itemName).toBe('Tacos');
    expect(classifyFeedEvent(F_CASES['F-k'].met, noClaimsCtx)).toBeNull();
  });

  it('F-k (A2.1): a quantity drop that lists me in removed_claimer_ids is a share change, like F-k', () => {
    const met = classifyFeedEvent(MORE_EVENTS.itemChangedRemovedMe, noClaimsCtx);
    expect(pick(met)).toEqual({ category: 'share', counts: true, amountCents: null, counterpartId: null });
    // Same wording inputs as F-k: the item name, no amount, no fields.
    const fk = classifyFeedEvent(F_CASES['F-k'].met, ctx);
    expect([met?.kind, met?.itemName, met?.fields, met?.direction]).toEqual([fk?.kind, 'Fries', fk?.fields, fk?.direction]);
    // Also when I still claim other rows of the bill (Fries isn't one of them).
    expect(classifyFeedEvent(MORE_EVENTS.itemChangedRemovedMe, ctx)?.category).toBe('share');
    // Unmet: only Sam's claim went, on a row I don't claim.
    expect(classifyFeedEvent(MORE_EVENTS.itemChangedRemovedSam, ctx)).toBeNull();
    // A malformed list is malformed details.
    const bad = billEvent('item_changed', { item_name: 'Fries', details: { qty: [2, 1], removed_claimer_ids: ['me'] } });
    expect(classifyFeedEvent(bad, ctx)).toBeNull();
    // My own quantity drop is still my own action.
    expect(classifyFeedEvent({ ...MORE_EVENTS.itemChangedRemovedMe, actor_id: ME }, ctx)).toBeNull();
  });

  it('F-n: me as a payer before/after, or as from_user/to_user in moved', () => {
    const asAfter = billEvent('payers_changed', {
      details: { before: [{ user_id: MAYA, cents: 0 }], after: [{ user_id: ME, cents: 0 }], moved: [] },
    });
    const asBefore = billEvent('payers_changed', {
      details: { before: [{ user_id: ME, cents: 0 }], after: [{ user_id: SAM, cents: 0 }], moved: [] },
    });
    const asTo = billEvent('payers_changed', {
      details: { before: [{ user_id: ANA, cents: 0 }], after: [{ user_id: SAM, cents: 0 }], moved: [{ from_user: MAYA, to_user: ME, cents: 5 }] },
    });
    for (const e of [asAfter, asBefore, asTo]) expect(classifyFeedEvent(e, ctx)?.category).toBe('share');
  });

  it('F-o: before or after = me', () => {
    expect(classifyFeedEvent(billEvent('payer_changed', { details: { before: ME, after: SAM, cleared: 1 } }), ctx)?.category).toBe('share');
  });

  it('F-p: claimed, unclaimed and joined are always roll-ups', () => {
    for (const e of [F_CASES['F-p'].met, ROLLUP_EVENTS.unclaimed, ROLLUP_EVENTS.joined]) {
      expect(pick(classifyFeedEvent(e, ctx))).toEqual({ category: 'rollup', counts: false, amountCents: null, counterpartId: null });
    }
  });

  it('F-q: the counterpart is the target user for assigned / unassigned / participant_added', () => {
    expect(classifyFeedEvent(ROLLUP_EVENTS.assignedSam, ctx)?.counterpartId).toBe(SAM);
    expect(classifyFeedEvent(ROLLUP_EVENTS.unassignedSam, ctx)?.counterpartId).toBe(SAM);
    expect(classifyFeedEvent(ROLLUP_EVENTS.addedAna, ctx)?.counterpartId).toBe(ANA);
    expect(classifyFeedEvent(ROLLUP_EVENTS.splitNotMe, ctx)?.counterpartId).toBeNull();
  });

  it('F-r: to me and from me, with the direction and the other party', () => {
    const toMe = classifyFeedEvent(F_CASES['F-r'].met, ctx);
    expect(toMe?.direction).toBe('to_me');
    const fromMe = classifyFeedEvent(MORE_EVENTS.recordedFromMe, ctx);
    expect(pick(fromMe)).toEqual({ category: 'money', counts: true, amountCents: 3000, counterpartId: ANA });
    expect(fromMe?.direction).toBe('from_me');
  });

  it('F-u: expense news with the amount (edited: the after amount) and the expense id, not the title', () => {
    const added = classifyFeedEvent(F_CASES['F-u'].met, ctx);
    expect(pick(added)).toEqual({ category: 'news', counts: false, amountCents: 6000, counterpartId: null });
    expect(added?.expenseId).toBe(EXPENSE_GAS);
    expect(pick(classifyFeedEvent(MORE_EVENTS.expenseEdited, ctx))).toEqual({ category: 'news', counts: false, amountCents: 6500, counterpartId: null });
    expect(pick(classifyFeedEvent(MORE_EVENTS.expenseDeleted, ctx))).toEqual({ category: 'news', counts: false, amountCents: 6500, counterpartId: null });
  });

  it("F-v: receipt news with the bill's host as counterpart (null when the bill isn't known)", () => {
    expect(pick(classifyFeedEvent(F_CASES['F-v'].met, ctx))).toEqual({ category: 'news', counts: false, amountCents: null, counterpartId: SAM });
    const removedB1 = groupEvent('bill_removed', { actor_id: SAM, details: { bill_id: B1 } });
    expect(classifyFeedEvent(removedB1, ctx)?.counterpartId).toBe(MAYA);
    expect(pick(classifyFeedEvent(MORE_EVENTS.billRemovedMine, ctx))).toEqual({ category: 'news', counts: false, amountCents: null, counterpartId: null });
  });

  it('F-w: member_joined is always a roll-up', () => {
    expect(pick(classifyFeedEvent(F_CASES['F-w'].met, ctx))).toEqual({ category: 'rollup', counts: false, amountCents: null, counterpartId: null });
  });

  it('places: a bill event carries its bill and the bill group; a group event carries only the group', () => {
    const b1 = classifyFeedEvent(F_CASES['F-c'].met, ctx);
    expect([b1?.source, b1?.billId, b1?.groupId]).toEqual(['bill', B1, null]);
    const b2 = classifyFeedEvent(MORE_EVENTS.groupBillPaid, ctx);
    expect([b2?.source, b2?.billId, b2?.groupId]).toEqual(['bill', B2, G1]);
    const g = classifyFeedEvent(F_CASES['F-r'].met, ctx);
    expect([g?.source, g?.billId, g?.groupId]).toEqual(['group', null, G1]);
  });

  it('a null actor is allowed (reads "Someone" later)', () => {
    const e = billEvent('participant_added', { actor_id: null, details: { user_id: ME } });
    expect(classifyFeedEvent(e, ctx)?.actorId).toBeNull();
    expect(classifyFeedEvent(e, ctx)?.category).toBe('needs_you');
  });
});

// Criterion 2: exclusions.
describe('classifyFeedEvent: exclusions (criterion 2)', () => {
  it('my own events of every kind', () => {
    let included = 0;
    for (const kind of FEED_BILL_KINDS) {
      const base = Object.values(F_CASES).find((c) => c.met.kind === kind)?.met ?? Object.values(ROLLUP_EVENTS).find((e) => e.kind === kind);
      expect(base).toBeDefined();
      if (base === undefined) continue;
      // Positive control: someone else's version is included.
      if (classifyFeedEvent(base, ctx) !== null) included += 1;
      expect(classifyFeedEvent({ ...base, actor_id: ME }, ctx)).toBeNull();
    }
    for (const kind of FEED_GROUP_KINDS) {
      const base = Object.values(F_CASES).find((c) => c.met.kind === kind)?.met ?? Object.values(MORE_EVENTS).find((e) => e.kind === kind);
      expect(base).toBeDefined();
      if (base === undefined) continue;
      if (classifyFeedEvent(base, ctx) !== null) included += 1;
      expect(classifyFeedEvent({ ...base, actor_id: ME }, ctx)).toBeNull();
    }
    expect(included).toBe(FEED_BILL_KINDS.length + FEED_GROUP_KINDS.length);
  });

  it('joinedAt boundary: 1 ms before is excluded, exactly at is included (bill and group)', () => {
    const bill = F_CASES['F-c'].met;
    expect(classifyFeedEvent({ ...bill, created_at: JOINED_AT_MINUS_1MS }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...bill, created_at: JOINED_AT }, ctx)?.category).toBe('money');
    const group = F_CASES['F-r'].met;
    expect(classifyFeedEvent({ ...group, created_at: JOINED_AT_MINUS_1MS }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...group, created_at: JOINED_AT }, ctx)?.category).toBe('money');
  });

  it('compares Postgres microsecond timestamps exactly', () => {
    const bills = new Map([[B1, { joinedAt: '2026-11-20T12:00:00.123456+00:00', groupId: null, hostId: MAYA }]]);
    const c = feedCtx(claims, { bills });
    const e = F_CASES['F-c'].met;
    expect(classifyFeedEvent({ ...e, created_at: '2026-11-20T12:00:00.123455+00:00' }, c)).toBeNull();
    expect(classifyFeedEvent({ ...e, created_at: '2026-11-20T12:00:00.123456+00:00' }, c)).not.toBeNull();
    expect(classifyFeedEvent({ ...e, created_at: '2026-11-20T13:00:00.1234+01:00' }, c)).toBeNull();
  });

  it('hidden groups, and places that are not mine', () => {
    expect(classifyFeedEvent({ ...F_CASES['F-r'].met, group_id: G2_HIDDEN }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...F_CASES['F-r'].met, group_id: G_OTHER }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...F_CASES['F-c'].met, bill_id: B_OTHER }, ctx)).toBeNull();
  });

  it('always-excluded kinds, and unknown kinds', () => {
    for (const e of [...EXCLUDED_BILL_EVENTS, ...EXCLUDED_GROUP_EVENTS]) expect(classifyFeedEvent(e, ctx)).toBeNull();
    expect(classifyFeedEvent(billEvent('confetti', { details: { user_id: ME } }), ctx)).toBeNull();
    expect(classifyFeedEvent(groupEvent('confetti', { details: {} }), ctx)).toBeNull();
  });

  it('payments between two other people (bill and group)', () => {
    for (const e of [F_CASES['F-c'].unmet, F_CASES['F-d'].unmet, F_CASES['F-e'].unmet, F_CASES['F-f'].unmet, F_CASES['F-g'].unmet, F_CASES['F-r'].unmet, F_CASES['F-s'].unmet]) {
      expect(classifyFeedEvent(e, ctx)).toBeNull();
    }
  });

  it('malformed details: 18.5, −1 or "1820" cents, a non-uuid payer_id, a non-object details', () => {
    const base = F_CASES['F-c'].met;
    for (const cents of [18.5, -1, '1820', 0, null]) {
      expect(classifyFeedEvent({ ...base, details: { payer_id: ME, cents, method: 'venmo' } }, ctx)).toBeNull();
    }
    expect(classifyFeedEvent({ ...base, details: { payer_id: 'me', cents: 1820, method: 'venmo' } }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...base, details: null }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...base, details: [ME] }, ctx)).toBeNull();
    // Group amounts too.
    const rec = F_CASES['F-r'].met;
    expect(classifyFeedEvent({ ...rec, details: { payment_id: P_SAM_TO_ME, from: SAM, to: ME, cents: 18.5 } }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...F_CASES['F-u'].met, details: { expense_id: EXPENSE_GAS, amount_cents: '6000' } }, ctx)).toBeNull();
  });

  it('malformed rows: bad ids or timestamps never throw and return null', () => {
    const base = F_CASES['F-c'].met;
    expect(classifyFeedEvent({ ...base, id: 'x' }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...base, actor_id: 'sam' }, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...base, created_at: 'yesterday' }, ctx)).toBeNull();
    // Not even an object: still no throw.
    expect(classifyFeedEvent(null as never, ctx)).toBeNull();
    expect(classifyFeedEvent({ ...base, details: { payer_id: ME, cents: 1820, get boom() { throw new Error('x'); } } }, ctx)).not.toBeUndefined();
  });

  it('paid_difference / paid_back with the wrong direction are malformed', () => {
    expect(classifyFeedEvent(billEvent('paid_difference', { actor_id: SAM, details: { payer_id: ME, from: 1285, to: 1000 } }), ctx)).toBeNull();
    expect(classifyFeedEvent(billEvent('paid_back', { actor_id: SAM, details: { user_id: ME, from: 1000, to: 1285 } }), ctx)).toBeNull();
    // A pay-back may end at 0.
    expect(classifyFeedEvent(billEvent('paid_back', { actor_id: SAM, details: { user_id: ME, from: 1285, to: 0 } }), ctx)?.amountCents).toBe(1285);
  });
});

// Criterion 3: amounts.
describe('classifyFeedEvent: amounts (criterion 3)', () => {
  it('paid_difference 1000 → 1285 is 285; paid_back 1285 → 1000 is 285', () => {
    expect(classifyFeedEvent(F_CASES['F-d'].met, ctx)?.amountCents).toBe(285);
    expect(classifyFeedEvent(F_CASES['F-e'].met, ctx)?.amountCents).toBe(285);
  });

  it("payment_undone uses the looked-up payment's cents, and is dropped when the payment can't be found", () => {
    expect(classifyFeedEvent(F_CASES['F-s'].met, ctx)?.amountCents).toBe(2500);
    expect(classifyFeedEvent(MORE_EVENTS.paymentMissing, ctx)).toBeNull();
    // The same undo with the payment in the lookup is included (positive control).
    const payments = new Map([[P_MISSING, { from: SAM, to: ME, cents: 700 }]]);
    expect(classifyFeedEvent(MORE_EVENTS.paymentMissing, feedCtx(claims, { payments }))?.amountCents).toBe(700);
    // A malformed lookup entry is treated as missing.
    const bad = new Map([[P_SAM_TO_ME, { from: SAM, to: ME, cents: 18.5 }]]);
    expect(classifyFeedEvent(F_CASES['F-s'].met, feedCtx(claims, { payments: bad }))).toBeNull();
  });

  it('no rollup, share, news (except F-u) or done item carries an amount', () => {
    for (const item of allItems()) {
      if (item.category === 'rollup' || item.category === 'share' || item.category === 'done') expect(item.amountCents).toBeNull();
      if (item.category === 'news' && !item.kind.startsWith('expense_')) expect(item.amountCents).toBeNull();
    }
  });
});

function allEvents() {
  return [
    ...Object.values(F_CASES).flatMap((c) => (c.unmet === null ? [c.met] : [c.met, c.unmet])),
    ...Object.values(ROLLUP_EVENTS),
    ...Object.values(MORE_EVENTS),
    ...EXCLUDED_BILL_EVENTS,
    ...EXCLUDED_GROUP_EVENTS,
  ];
}

function allItems(): FeedItem[] {
  const items = allEvents()
    .map((e) => classifyFeedEvent(e, ctx))
    .filter((x): x is FeedItem => x !== null);
  // Positive control: the sweep actually sees every category classify can return.
  expect(new Set(items.map((i) => i.category))).toEqual(new Set(['needs_you', 'money', 'dispute', 'share', 'rollup', 'news']));
  return items;
}

// Criterion 4: privacy.
describe('classifyFeedEvent: privacy (criterion 4)', () => {
  const ALLOWED_KEYS = [
    'id',
    'source',
    'kind',
    'at',
    'billId',
    'groupId',
    'actorId',
    'category',
    'counts',
    'amountCents',
    'counterpartId',
    'itemName',
    'direction',
    'fields',
    'expenseId',
    'milestone',
  ].sort();

  it('no item exposes an amount for a payment between two people who are not me', () => {
    const items = allItems();
    let checked = 0;
    for (const item of items) {
      if (item.amountCents === null || item.category === 'news') continue;
      checked += 1;
      // Every money/dispute item with an amount has me on one side: the counterpart is someone else.
      expect(['money', 'dispute']).toContain(item.category);
      expect(item.counterpartId).not.toBeNull();
      expect(item.counterpartId).not.toBe(ME);
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    // And the others' payments in the fixtures produce no item at all.
    const othersPayment = groupEvent('payment_recorded', { actor_id: ANA, details: { payment_id: P_SAM_TO_ANA, from: SAM, to: ANA, cents: 4400 } });
    expect(classifyFeedEvent(othersPayment, ctx)).toBeNull();
  });

  it('no item carries any details field other than ids, item names and the allowed amount', () => {
    const items = allItems();
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(ALLOWED_KEYS);
      // No raw details values anywhere (methods, sources, titles, reasons), and no Venmo text.
      expect(JSON.stringify(Object.values(item))).not.toMatch(/venmo|method|source|title|Gas|undone_reason|converted/i);
    }
  });
});

// Criterion 5: badge rule.
describe('activityUnreadCount and badgeText (criterion 5)', () => {
  const at = (iso: string) => ({ created_at: iso });
  const b1a = classifyFeedEvent(F_CASES['F-c'].met, ctx);
  const b1b = classifyFeedEvent({ ...F_CASES['F-a'].met, ...at('2026-11-27T19:43:00.000Z') }, ctx);
  const g1 = classifyFeedEvent(F_CASES['F-r'].met, ctx);
  const items = [b1a, b1b, g1].filter((x): x is FeedItem => x !== null);
  const never = () => false;

  it('two unseen counted items on B1 → 1; plus one on G1 → 2', () => {
    expect(items).toHaveLength(3);
    expect(activityUnreadCount(items.slice(0, 2), never)).toBe(1);
    expect(activityUnreadCount(items, never)).toBe(2);
  });

  it('a seen item, an unseen roll-up, news or done item, or my own action adds nothing', () => {
    const rollup = classifyFeedEvent({ ...F_CASES['F-p'].met, bill_id: B2 }, ctx);
    const news = classifyFeedEvent({ ...F_CASES['F-u'].met, group_id: G1 }, ctx);
    const seenB2 = classifyFeedEvent(MORE_EVENTS.groupBillPaid, ctx);
    expect([rollup?.category, news?.category, seenB2?.category]).toEqual(['rollup', 'news', 'money']);
    const done: FeedItem = { ...(seenB2 as FeedItem), id: 'm', category: 'done', counts: false, amountCents: null, milestone: 'all_square' };
    const mine = classifyFeedEvent({ ...MORE_EVENTS.groupBillPaid, actor_id: ME }, ctx);
    expect(mine).toBeNull();
    const extra = [rollup, news, done, seenB2].filter((x): x is FeedItem => x !== null);
    const isSeen = (i: FeedItem) => i === seenB2;
    expect(activityUnreadCount([...items, ...extra], isSeen)).toBe(2);
    // Positive control: unseen, B2's payment adds one.
    expect(activityUnreadCount([...items, ...extra], never)).toBe(3);
  });

  it('feedPlaceKey is the bill id if present, else the group id', () => {
    expect(feedPlaceKey(b1a as FeedItem)).toBe(B1);
    expect(feedPlaceKey(classifyFeedEvent(MORE_EVENTS.groupBillPaid, ctx) as FeedItem)).toBe(B2);
    expect(feedPlaceKey(g1 as FeedItem)).toBe(G1);
  });

  it('badgeText: 0 → none, 1 → "1", 9 → "9", 10 → "9+", 12 → "9+"', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(1)).toBe('1');
    expect(badgeText(9)).toBe('9');
    expect(badgeText(10)).toBe('9+');
    expect(badgeText(12)).toBe('9+');
    expect(badgeText(-1)).toBeNull();
    expect(badgeText(2.5)).toBeNull();
  });

  it('"9+" reads "more than 9"', () => {
    expect(badgeSpokenText(0)).toBeNull();
    expect(badgeSpokenText(3)).toBe('3');
    expect(badgeSpokenText(10)).toBe('more than 9');
  });
});

// Criterion 6: Groups dot.
describe('groupsDot (criterion 6)', () => {
  const opened = new Map([[G1, G1_OPENED_AT]]);
  const dotCtx = { myId: ME, groups: ctx.groups, openedAt: opened };
  const after = '2026-11-27T18:00:00.001Z';
  const anaExpense = groupEvent('expense_added', { actor_id: ANA, created_at: after, details: { expense_id: EXPENSE_GAS, amount_cents: 6000 } });

  it("true for Ana's expense_added after G1's opened time; false at exactly the opened time", () => {
    expect(groupsDot([anaExpense], dotCtx)).toBe(true);
    expect(groupsDot([{ ...anaExpense, created_at: G1_OPENED_AT }], dotCtx)).toBe(false);
  });

  it('false for renamed or link_rotated, for my own events, and for hidden groups', () => {
    expect(groupsDot([{ ...anaExpense, kind: 'renamed', details: { to: 'x' } }], dotCtx)).toBe(false);
    expect(groupsDot([{ ...anaExpense, kind: 'link_rotated' }], dotCtx)).toBe(false);
    expect(groupsDot([{ ...anaExpense, actor_id: ME }], dotCtx)).toBe(false);
    expect(groupsDot([{ ...anaExpense, group_id: G2_HIDDEN }], dotCtx)).toBe(false);
    expect(groupsDot([{ ...anaExpense, group_id: G_OTHER }], dotCtx)).toBe(false);
    // Other kinds (outside FEED_GROUP_KINDS) and a null actor still count.
    expect(groupsDot([{ ...anaExpense, kind: 'member_left' }], dotCtx)).toBe(true);
    expect(groupsDot([{ ...anaExpense, actor_id: null }], dotCtx)).toBe(true);
  });

  it("with no opened time, the group's joined_at is the bound", () => {
    const none = { ...dotCtx, openedAt: new Map<string, string>() };
    expect(groupsDot([{ ...anaExpense, created_at: JOINED_AT }], none)).toBe(false);
    expect(groupsDot([{ ...anaExpense, created_at: '2026-11-20T12:00:00.001Z' }], none)).toBe(true);
    // Positive control for the bound: with G1's opened time the same event is before it.
    expect(groupsDot([{ ...anaExpense, created_at: '2026-11-20T12:00:00.001Z' }], dotCtx)).toBe(false);
  });

  it('empty input, malformed rows → false, never throws', () => {
    expect(groupsDot([], dotCtx)).toBe(false);
    expect(groupsDot([{ ...anaExpense, created_at: 'soon' }], dotCtx)).toBe(false);
    expect(groupsDot([null as never], dotCtx)).toBe(false);
  });
});

// Criterion 7: filters.
describe('inFeedFilter (criterion 7)', () => {
  const items = allItems();
  const base = classifyFeedEvent(MORE_EVENTS.groupBillPaid, ctx) as FeedItem;
  const milestone = (m: 'fully_claimed' | 'all_square' | 'group_settled', groupId: string | null): FeedItem => ({
    ...base,
    id: m,
    category: 'done',
    counts: false,
    amountCents: null,
    groupId,
    milestone: m,
  });
  const milestones = [milestone('fully_claimed', null), milestone('all_square', null), milestone('group_settled', G1)];

  it('Money keeps exactly money, dispute, share and the two money milestones', () => {
    const kept = [...items, ...milestones].filter((i) => inFeedFilter(i, 'money'));
    expect(new Set(kept.map((i) => (i.category === 'done' ? i.milestone : i.category)))).toEqual(
      new Set(['money', 'dispute', 'share', 'all_square', 'group_settled']),
    );
    expect(items.filter((i) => ['needs_you', 'rollup', 'news'].includes(i.category)).length).toBeGreaterThan(0);
  });

  it("Groups keeps exactly the items with a group, including a group bill's events", () => {
    const all = [...items, ...milestones];
    const kept = all.filter((i) => inFeedFilter(i, 'groups'));
    expect(kept).toEqual(all.filter((i) => i.groupId !== null));
    expect(kept.some((i) => i.source === 'bill' && i.billId === B2)).toBe(true);
    expect(kept.some((i) => i.source === 'group')).toBe(true);
    expect(all.some((i) => i.groupId === null)).toBe(true);
  });

  it('All keeps everything', () => {
    const all = [...items, ...milestones];
    expect(all.filter((i) => inFeedFilter(i, 'all'))).toEqual(all);
  });
});

// Contract F milestones: which loaded events can trigger which candidate (kept or dropped in feedView).
describe('milestoneTrigger', () => {
  it('fully claimed: claim / assignment / item changes by anyone, me included', () => {
    for (const kind of ['claimed', 'unclaimed', 'assigned', 'unassigned', 'item_removed', 'item_changed', 'split_changed']) {
      expect(milestoneTrigger(billEvent(kind, { actor_id: ME, item_name: 'Tacos' }), ctx)).toEqual({ milestone: 'fully_claimed', counterpartId: null });
    }
    expect(milestoneTrigger(billEvent('joined', { actor_id: SAM }), ctx)).toBeNull();
  });

  it('all square: money events involving me, mine included; not others’ payments', () => {
    expect(milestoneTrigger(F_CASES['F-c'].met, ctx)).toEqual({ milestone: 'all_square', counterpartId: null });
    expect(milestoneTrigger(F_CASES['F-g'].met, ctx)).toEqual({ milestone: 'all_square', counterpartId: null });
    const mine = billEvent('marked_paid', { actor_id: ME, details: { payer_id: MAYA, cents: 1820 } });
    expect(milestoneTrigger(mine, ctx)).toEqual({ milestone: 'all_square', counterpartId: null });
    const myBack = billEvent('paid_back', { actor_id: ME, details: { user_id: SAM, payer_id: ME, from: 1285, to: 1000 } });
    expect(milestoneTrigger(myBack, ctx)).toEqual({ milestone: 'all_square', counterpartId: null });
    expect(milestoneTrigger(F_CASES['F-c'].unmet, ctx)).toBeNull();
  });

  it('group settled: a group payment involving me, naming the other party', () => {
    expect(milestoneTrigger(F_CASES['F-r'].met, ctx)).toEqual({ milestone: 'group_settled', counterpartId: SAM });
    const mine = groupEvent('payment_recorded', { actor_id: ME, details: { payment_id: P_ME_TO_ANA, from: ME, to: ANA, cents: 3000 } });
    expect(milestoneTrigger(mine, ctx)).toEqual({ milestone: 'group_settled', counterpartId: ANA });
    expect(milestoneTrigger(F_CASES['F-t'].met, ctx)).toEqual({ milestone: 'group_settled', counterpartId: ANA });
    expect(milestoneTrigger(F_CASES['F-r'].unmet, ctx)).toBeNull();
  });

  it('the common rules still apply: my places only, from joinedAt', () => {
    expect(milestoneTrigger({ ...F_CASES['F-c'].met, bill_id: B_OTHER }, ctx)).toBeNull();
    expect(milestoneTrigger({ ...F_CASES['F-c'].met, created_at: JOINED_AT_MINUS_1MS }, ctx)).toBeNull();
    expect(milestoneTrigger({ ...F_CASES['F-r'].met, group_id: G2_HIDDEN }, ctx)).toBeNull();
    expect(EVENT_AT > JOINED_AT).toBe(true);
  });
});
