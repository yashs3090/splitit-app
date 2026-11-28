// Feed wording (docs/specs/2026-11-28-tab-bar-and-activity.md, Contract C, day headers, Contract M's
// FEED_MARKER_TONES; criteria 15–18 and 20). Every expected sentence below is typed out by hand from
// the spec's table, never read off the code.
import * as activityText from './activityText';
import * as groupActivityText from './groupActivityText';
import { colors } from './theme';
import {
  FEED_COPY,
  FEED_MARKER_TONES,
  activityTabLabel,
  billPlace,
  dayHeader,
  describeFeedItem,
  feedCaption,
  feedLineLabel,
  feedMarkerTone,
  groupPlace,
  groupsTabLabel,
  rollupToggle,
  tabsTabLabel,
  type DayHeaderFormatters,
  type FeedTextContext,
  type FeedTextItem,
} from './feedText';

const ME = '00000000-0000-4000-8000-000000000001';
const SAM = '00000000-0000-4000-8000-000000000002';
const ANA = '00000000-0000-4000-8000-000000000003';
const MAYA = '00000000-0000-4000-8000-000000000004';
const LEO = '00000000-0000-4000-8000-000000000005';
const BLANK = '00000000-0000-4000-8000-000000000006';
const GONE = '00000000-0000-4000-8000-000000000007'; // no profiles row (deleted / not shared)

const ctx: FeedTextContext = {
  myId: ME,
  names: new Map<string, string | null>([
    [ME, 'Me'],
    [SAM, 'Sam'],
    [ANA, '  Ana  '],
    [MAYA, 'Maya'],
    [LEO, 'Leo'],
    [BLANK, '   '],
  ]),
};

function bill(kind: string, over: Partial<FeedTextItem> = {}): FeedTextItem {
  return { source: 'bill', kind, category: 'share', actorId: SAM, ...over };
}
function group(kind: string, over: Partial<FeedTextItem> = {}): FeedTextItem {
  return { source: 'group', kind, category: 'news', actorId: SAM, ...over };
}
function text(item: FeedTextItem): string | null {
  return describeFeedItem(item, ctx)?.text ?? null;
}
function glyph(item: FeedTextItem): string | null {
  return describeFeedItem(item, ctx)?.glyph ?? null;
}

describe('C1–C9: needs you, money and disputes', () => {
  const cases: [id: string, item: FeedTextItem, sentence: string, glyph: string][] = [
    ['C1', bill('participant_added', { category: 'needs_you', targetId: ME }), 'Sam added you. Claim what you had', 'hand'],
    ['C2', bill('assigned', { category: 'needs_you', itemName: ' Tacos ', targetId: ME }), 'Sam assigned you Tacos', 'list-checks'],
    ['C3 bill', bill('marked_paid', { category: 'money', amountCents: 1820 }), 'Sam marked $18.20 paid to you', 'banknote'],
    ['C3 group', group('payment_recorded', { category: 'money', amountCents: 4000, direction: 'to_me' }), 'Sam marked $40.00 paid to you', 'banknote'],
    ['C4', bill('paid_difference', { category: 'money', amountCents: 285 }), 'Sam marked $2.85 more paid to you', 'banknote'],
    ['C5', bill('paid_back', { category: 'money', amountCents: 285 }), 'Sam paid you back $2.85', 'banknote'],
    ['C6', bill('unmarked_paid', { category: 'money', amountCents: 1820 }), 'Sam undid your $18.20 payment', 'banknote'],
    ['C7', group('payment_recorded', { category: 'money', actorId: ANA, amountCents: 4000, direction: 'from_me' }), 'Ana marked $40.00 from you as received', 'banknote'],
    ['C8', group('payment_undone', { category: 'money', amountCents: 4000 }), 'Sam undid the $40.00 payment', 'banknote'],
    ['C9 bill', bill('not_received', { category: 'dispute', amountCents: 1820 }), "Sam says they didn't get your $18.20", 'circle-alert'],
    ['C9 group', group('payment_undone', { category: 'dispute', amountCents: 123450 }), "Sam says they didn't get your $1,234.50", 'circle-alert'],
  ];
  it.each(cases)('%s', (_id, item, sentence, g) => {
    expect(text(item)).toBe(sentence);
    expect(glyph(item)).toBe(g);
  });

  it('reads "Someone" for a missing name and a null actor, "A friend" for a blank one', () => {
    expect(text(bill('marked_paid', { category: 'money', amountCents: 500, actorId: GONE }))).toBe('Someone marked $5.00 paid to you');
    expect(text(bill('marked_paid', { category: 'money', amountCents: 500, actorId: null }))).toBe('Someone marked $5.00 paid to you');
    expect(text(bill('marked_paid', { category: 'money', amountCents: 500, actorId: BLANK }))).toBe('A friend marked $5.00 paid to you');
    expect(text(bill('participant_added', { category: 'needs_you', actorId: BLANK, targetId: ME }))).toBe('A friend added you. Claim what you had');
  });

  it('trims names and strips control characters from names and item names', () => {
    const c2: FeedTextContext = { myId: ME, names: new Map([[SAM, ' Sam\u0007\nLee ']]) };
    expect(describeFeedItem(bill('assigned', { category: 'needs_you', itemName: 'Fish\ttacos\u0000', targetId: ME }), c2)?.text).toBe('Sam Lee assigned you Fish tacos');
  });

  it('gives no C2 line without an item name', () => {
    expect(text(bill('assigned', { category: 'needs_you', itemName: '  ', targetId: ME }))).toBeNull();
    expect(text(bill('assigned', { category: 'needs_you', targetId: ME }))).toBeNull();
  });
});

describe('C10–C16: share changes', () => {
  const clause = '. Your share is now $12.34';

  it('C10 lists every fields combination in the spec order, with and without a share', () => {
    const f = (fields: string[], shareCents?: number | null) => text(bill('amounts_changed', { fields, shareCents }));
    expect(f(['tip_cents'])).toBe('Sam changed the tip');
    expect(f(['tax_cents', 'tip_cents'])).toBe('Sam changed the tip and the tax');
    expect(f(['fees_cents', 'tax_cents', 'tip_cents'])).toBe('Sam changed the tip, the tax and the fees');
    expect(f(['tax_cents'])).toBe('Sam changed the tax');
    expect(f(['fees_cents'])).toBe('Sam changed the fees');
    expect(f(['total_cents'])).toBe('Sam changed the total');
    expect(f(['discount_cents'])).toBe('Sam changed the discount');
    // Any discount key, listed once.
    expect(f(['subtotal_discount_cents', 'total_discount_cents', 'discount_cents'])).toBe('Sam changed the discount');
    // FEED-44 (A3.2): the total is named only when nothing else changed; update_bill lists it with
    // every tip, tax or fees edit, and the share clause already says what it means for me.
    expect(f(['total_cents', 'total_discount_cents', 'fees_cents', 'tax_cents', 'tip_cents'])).toBe(
      'Sam changed the tip, the tax, the fees and the discount',
    );
    expect(f(['tip_cents', 'total_cents'])).toBe('Sam changed the tip');
    expect(f(['tip_cents', 'total_cents'], 500)).toBe('Sam changed the tip. Your share is now $5.00');
    expect(f(['discount_cents', 'total_cents'])).toBe('Sam changed the discount');
    // An unknown key isn't another field.
    expect(f(['total_cents', 'mystery_cents'])).toBe('Sam changed the total');
    expect(f([])).toBe('Sam changed the amounts');
    expect(f(['mystery_cents'])).toBe('Sam changed the amounts');
    expect(f([], undefined)).toBe('Sam changed the amounts');
    expect(text(bill('amounts_changed', {}))).toBe('Sam changed the amounts');
    expect(f(['tip_cents'], 1234)).toBe(`Sam changed the tip${clause}`);
    expect(glyph(bill('amounts_changed', { fields: ['tip_cents'] }))).toBe('refresh-cw');
  });

  const cases: [id: string, item: FeedTextItem, head: string][] = [
    ['C11', bill('extras_split_changed'), 'Sam changed how tax and tip are split'],
    ['C12', bill('item_removed', { itemName: 'Tacos' }), "Sam removed Tacos, which you'd claimed"],
    ['C13', bill('item_changed', { itemName: 'Tacos' }), 'Sam changed Tacos'],
    ['C14', bill('split_changed', { itemName: 'Tacos' }), 'Sam changed the split on Tacos'],
    ['C15', bill('unassigned', { itemName: 'Tacos', targetId: ME }), 'Sam removed you from Tacos'],
  ];
  it.each(cases)('%s without a share has no clause and no final period', (_id, item, head) => {
    expect(text(item)).toBe(head);
    expect(text({ ...item, shareCents: null })).toBe(head);
    expect(glyph(item)).toBe('refresh-cw');
  });
  it.each(cases)('%s with a share adds the share clause', (_id, item, head) => {
    expect(text({ ...item, shareCents: 1234 })).toBe(head + clause);
    expect(text({ ...item, shareCents: 0 })).toBe(`${head}. Your share is now $0.00`);
  });
  it.each(cases)('%s drops a bad share instead of printing it', (_id, item, head) => {
    expect(text({ ...item, shareCents: 12.5 })).toBe(head);
    expect(text({ ...item, shareCents: -1 })).toBe(head);
    expect(text({ ...item, shareCents: Number.NaN })).toBe(head);
  });

  it('C12–C15 need an item name', () => {
    for (const [, item] of cases.slice(1)) expect(text({ ...item, itemName: null })).toBeNull();
  });

  it('C16 for both payers_changed and the older payer_changed, with no share clause', () => {
    expect(text(bill('payers_changed'))).toBe('Sam changed who paid');
    expect(text(bill('payer_changed'))).toBe('Sam changed who paid');
    expect(text(bill('payers_changed', { shareCents: 1234 }))).toBe('Sam changed who paid');
    expect(glyph(bill('payer_changed'))).toBe('refresh-cw');
  });
});

describe('C18–C22: group news', () => {
  it('C18 added, with and without a title', () => {
    expect(text(group('expense_added', { amountCents: 6000, expenseTitle: ' Groceries ' }))).toBe('Sam added Groceries, $60.00');
    expect(text(group('expense_added', { amountCents: 6000 }))).toBe('Sam added an expense of $60.00');
    expect(text(group('expense_added', { amountCents: 6000, expenseTitle: '  ' }))).toBe('Sam added an expense of $60.00');
    expect(glyph(group('expense_added', { amountCents: 6000 }))).toBe('receipt');
  });
  it('C19 edited, with and without a title', () => {
    expect(text(group('expense_edited', { amountCents: 6500, expenseTitle: 'Groceries' }))).toBe('Sam edited Groceries');
    expect(text(group('expense_edited', { amountCents: 6500 }))).toBe('Sam edited an expense');
    expect(text(group('expense_edited', {}))).toBe('Sam edited an expense');
  });
  it('C20 deleted, with and without a title', () => {
    expect(text(group('expense_deleted', { amountCents: 6000, expenseTitle: 'Groceries' }))).toBe('Sam deleted Groceries, $60.00');
    expect(text(group('expense_deleted', { amountCents: 6000 }))).toBe('Sam deleted an expense of $60.00');
  });
  it("C21 and C22 name the bill's host, and say \"Your\" when it's mine", () => {
    expect(text(group('bill_added', { counterpartId: MAYA }))).toBe("Maya's receipt was added");
    expect(text(group('bill_added', { counterpartId: ME }))).toBe('Your receipt was added');
    expect(text(group('bill_removed', { counterpartId: MAYA }))).toBe("Maya's receipt was taken out");
    expect(text(group('bill_removed', { counterpartId: ME }))).toBe('Your receipt was taken out');
    expect(text(group('bill_added', { counterpartId: GONE }))).toBe("Someone's receipt was added");
    expect(text(group('bill_removed', { counterpartId: BLANK }))).toBe("A friend's receipt was taken out");
    expect(text(group('bill_added', {}))).toBe("Someone's receipt was added");
    expect(glyph(group('bill_removed', { counterpartId: ME }))).toBe('receipt');
  });
});

describe('C23–C25: milestones', () => {
  const ms = (kind: string, over: Partial<FeedTextItem> = {}): FeedTextItem => ({ source: 'milestone', kind, category: 'done', actorId: null, ...over });
  it('C23 fully claimed, with and without a share', () => {
    expect(text(ms('fully_claimed'))).toBe('This bill is fully claimed, so totals are final');
    expect(text(ms('fully_claimed', { shareCents: null }))).toBe('This bill is fully claimed, so totals are final');
    expect(text(ms('fully_claimed', { shareCents: 1234 }))).toBe('This bill is fully claimed, so totals are final. Your share is $12.34');
    expect(text(ms('fully_claimed', { shareCents: 1.5 }))).toBe('This bill is fully claimed, so totals are final');
    expect(glyph(ms('fully_claimed'))).toBe('circle-check');
  });
  it('C24 all square', () => {
    expect(text(ms('all_square'))).toBe("You're all square on this bill");
    expect(glyph(ms('all_square'))).toBe('circle-check');
  });
  it('C25 group settled, with and without a counterpart', () => {
    expect(text(ms('group_settled', { counterpartId: ANA }))).toBe('You and Ana are settled up');
    expect(text(ms('group_settled', { counterpartId: GONE }))).toBe('You and Someone are settled up');
    expect(text(ms('group_settled'))).toBe("You're settled up");
    expect(text(ms('group_settled', { counterpartId: null }))).toBe("You're settled up");
    expect(glyph(ms('group_settled'))).toBe('circle-check');
  });
  it('an unknown milestone gives no line', () => {
    expect(describeFeedItem(ms('confetti'), ctx)).toBeNull();
  });
});

describe('C26: a roll-up item alone', () => {
  const r = (kind: string, over: Partial<FeedTextItem> = {}) => bill(kind, { category: 'rollup', ...over });
  it('uses describeEvent / describeGroupEvent sentences', () => {
    expect(text(r('claimed', { itemName: 'Tacos' }))).toBe('Sam claimed Tacos');
    expect(text(r('unclaimed', { itemName: 'Tacos' }))).toBe('Sam removed their claim on Tacos');
    expect(text(r('joined'))).toBe('Sam joined');
    expect(text(r('assigned', { itemName: 'Tacos', targetId: ANA }))).toBe('Sam assigned Tacos to Ana');
    expect(text(r('unassigned', { itemName: 'Tacos', targetId: ANA }))).toBe('Sam removed Ana from Tacos');
    expect(text(r('participant_added', { targetId: ANA }))).toBe('Sam added Ana');
    expect(text(r('participant_added', { targetId: GONE }))).toBe('Sam added someone');
    expect(text(group('member_joined', { category: 'rollup' }))).toBe('Sam joined');
    expect(glyph(r('joined'))).toBe('users-round');
  });
  it("split_changed with ids only falls back to C14's wording without a clause", () => {
    expect(text(r('split_changed', { itemName: 'Tacos', shareCents: 999 }))).toBe('Sam changed the split on Tacos');
    expect(glyph(r('split_changed', { itemName: 'Tacos' }))).toBe('users-round');
  });
  it('passes only ids to describeEvent: no amounts leak in from the item', () => {
    // claimed with an amount on the item must not show it.
    expect(text(r('claimed', { itemName: 'Tacos', amountCents: 1820 }))).toBe('Sam claimed Tacos');
  });
  it('gives describeEvent / describeGroupEvent a details object of ids only (Contract C26)', () => {
    const bills = jest.spyOn(activityText, 'describeEvent');
    const groups = jest.spyOn(groupActivityText, 'describeGroupEvent');
    try {
      const extra = { amountCents: 1820, counterpartId: MAYA, fields: ['tip_cents'], shareCents: 5, expenseTitle: 'X' };
      text(r('claimed', { itemName: 'Tacos', ...extra }));
      text(r('assigned', { itemName: 'Tacos', targetId: ANA, ...extra }));
      text(r('participant_added', { targetId: ANA, ...extra }));
      text(group('member_joined', { category: 'rollup', ...extra }));
      expect(bills.mock.calls.map(([e]) => e.details)).toEqual([{}, { user_id: ANA }, { user_id: ANA }]);
      expect(groups.mock.calls.map(([e]) => e.details)).toEqual([{}]);
    } finally {
      bills.mockRestore();
      groups.mockRestore();
    }
  });
  it('a roll-up kind with malformed parts gives no line', () => {
    expect(text(r('claimed'))).toBeNull(); // no item name
    expect(text(r('assigned', { itemName: 'Tacos' }))).toBeNull(); // no target
  });
});

describe('C27: a roll-up run (Contract R sentence)', () => {
  const claim = (actorId: string | null) => bill('claimed', { category: 'rollup', actorId, itemName: 'Tacos' });
  const run = (items: FeedTextItem[]) => describeFeedItem({ source: 'run', kind: 'rollup', category: 'rollup', actorId: null, run: items }, ctx);

  it('one item is the C26 sentence', () => {
    expect(run([claim(SAM)])?.text).toBe('Sam claimed Tacos');
  });
  it('all claims → "{names} claimed {n} items"', () => {
    expect(run([claim(SAM), claim(SAM), claim(SAM)])?.text).toBe('Sam claimed 3 items');
    expect(run([claim(SAM), claim(ANA)])?.text).toBe('Sam and Ana claimed 2 items');
    expect(run([claim(SAM), claim(ANA), claim(MAYA)])?.text).toBe('Sam, Ana and 1 other claimed 3 items');
    expect(run([claim(SAM), claim(ANA), claim(SAM), claim(MAYA), claim(LEO), claim(ANA), claim(SAM), claim(LEO), claim(MAYA)])?.text).toBe(
      'Sam, Ana and 2 others claimed 9 items',
    );
    expect(run([claim(null), claim(GONE), claim(BLANK)])?.text).toBe('Someone, Someone and 1 other claimed 3 items');
    expect(run([claim(SAM), claim(SAM)])?.glyph).toBe('users-round');
  });
  it('all joins → "{names} joined"; participant_added names the added user', () => {
    expect(run([bill('joined', { category: 'rollup', actorId: SAM }), bill('joined', { category: 'rollup', actorId: ANA })])?.text).toBe('Sam and Ana joined');
    expect(run([group('member_joined', { category: 'rollup', actorId: ANA }), group('member_joined', { category: 'rollup', actorId: ANA })])?.text).toBe('Ana joined');
    expect(
      run([bill('participant_added', { category: 'rollup', actorId: MAYA, targetId: SAM }), bill('joined', { category: 'rollup', actorId: ANA })])?.text,
    ).toBe('Sam and Ana joined');
  });
  it('anything else → "{names} made {n} changes"', () => {
    expect(run([claim(SAM), bill('split_changed', { category: 'rollup', actorId: SAM, itemName: 'Tacos' })])?.text).toBe('Sam made 2 changes');
    expect(run([claim(SAM), bill('unclaimed', { category: 'rollup', actorId: ANA, itemName: 'Tacos' })])?.text).toBe('Sam and Ana made 2 changes');
  });
  it('an empty run gives no line', () => {
    expect(run([])).toBeNull();
  });
});

describe('bad amounts give no line (criterion 17)', () => {
  const amountLines: FeedTextItem[] = [
    bill('marked_paid', { category: 'money' }),
    bill('paid_difference', { category: 'money' }),
    bill('paid_back', { category: 'money' }),
    bill('unmarked_paid', { category: 'money' }),
    group('payment_recorded', { category: 'money', direction: 'from_me' }),
    group('payment_recorded', { category: 'money', direction: 'to_me' }),
    group('payment_undone', { category: 'money' }),
    bill('not_received', { category: 'dispute' }),
    group('expense_added', {}),
    group('expense_deleted', {}),
  ];
  const bad: unknown[] = [undefined, null, 18.5, -1, '1820', Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60];
  it.each(amountLines.map((i) => [`${i.source} ${i.kind} ${i.direction ?? ''}`, i] as const))('%s', (_label, item) => {
    expect(text({ ...item, amountCents: 100 })).not.toBeNull(); // positive control
    for (const b of bad) expect(text({ ...item, amountCents: b as number })).toBeNull();
  });
  it('a payment_recorded without a direction gives no line', () => {
    expect(text(group('payment_recorded', { category: 'money', amountCents: 100 }))).toBeNull();
  });
});

describe('unknown and excluded kinds give no line', () => {
  it.each([
    bill('bill_created'),
    bill('item_added', { itemName: 'Tacos' }),
    bill('link_rotated'),
    bill('left'),
    group('renamed'),
    group('group_created'),
    bill('mystery'),
    group('mystery'),
  ])('%#', (item) => {
    expect(describeFeedItem(item, ctx)).toBeNull();
  });
  it('never throws, even when the name lookup does', () => {
    const throwing: FeedTextContext = {
      myId: ME,
      names: {
        get: () => {
          throw new Error('boom');
        },
      } as unknown as ReadonlyMap<string, string | null>,
    };
    expect(describeFeedItem(bill('marked_paid', { category: 'money', amountCents: 100 }), throwing)?.text).toBe('Someone marked $1.00 paid to you');
    expect(describeFeedItem(null as unknown as FeedTextItem, ctx)).toBeNull();
  });
});

describe('money wording (criterion 16)', () => {
  const MONEY_RE =
    /^(.+ marked .+ paid to you|.+ marked .+ more paid to you|.+ paid you back .+|.+ undid (your|the) .+ payment|.+ marked .+ from you as received|.+ says they didn't get your .+)$/;
  const all: FeedTextItem[] = [];
  for (const actorId of [SAM, GONE, BLANK, null]) {
    for (const cents of [0, 1, 1820, 123450]) {
      all.push(
        bill('marked_paid', { category: 'money', actorId, amountCents: cents }),
        bill('paid_difference', { category: 'money', actorId, amountCents: cents }),
        bill('paid_back', { category: 'money', actorId, amountCents: cents }),
        bill('unmarked_paid', { category: 'money', actorId, amountCents: cents }),
        bill('not_received', { category: 'dispute', actorId, amountCents: cents }),
        group('payment_recorded', { category: 'money', actorId, amountCents: cents, direction: 'to_me' }),
        group('payment_recorded', { category: 'money', actorId, amountCents: cents, direction: 'from_me' }),
        group('payment_undone', { category: 'money', actorId, amountCents: cents }),
        group('payment_undone', { category: 'dispute', actorId, amountCents: cents }),
      );
    }
  }
  it('every money and dispute sentence matches the allowed forms', () => {
    expect(all).toHaveLength(144);
    for (const item of all) expect(text(item)).toMatch(MONEY_RE);
  });
  it('no sentence from any fixture says "paid you" except "paid you back"', () => {
    const others: FeedTextItem[] = [
      bill('participant_added', { category: 'needs_you', targetId: ME }),
      bill('assigned', { category: 'needs_you', itemName: 'Tacos', targetId: ME }),
      bill('amounts_changed', { fields: ['tip_cents'], shareCents: 100 }),
      bill('payers_changed'),
      group('expense_added', { amountCents: 100 }),
      { source: 'milestone', kind: 'all_square', category: 'done', actorId: null },
    ];
    const sentences = [...all, ...others].map(text);
    expect(sentences.every((s) => typeof s === 'string')).toBe(true);
    for (const s of sentences) expect(s).not.toMatch(/ paid you(?! back)/);
    expect('Sam paid you $5.00').toMatch(/ paid you(?! back)/); // positive control
  });
});

describe('places, captions and labels', () => {
  const fmt = { time: (d: Date) => `T${d.getUTCHours()}`, date: () => 'D' };
  it('bill places use rowTitle wording plus the group name', () => {
    expect(billPlace({ hostId: ME, hostName: 'Me' }, ME)).toBe('Your bill');
    expect(billPlace({ hostId: MAYA, hostName: ' Maya ' }, ME)).toBe("Maya's bill");
    expect(billPlace({ hostId: MAYA, hostName: '  ' }, ME)).toBe("A friend's bill");
    expect(billPlace({ hostId: MAYA, hostName: null }, ME)).toBe("A friend's bill");
    expect(billPlace({ hostId: MAYA, hostName: 'Maya\u0007' }, ME, ' Roommates\n')).toBe("Maya's bill · Roommates");
    expect(billPlace({ hostId: MAYA, hostName: 'Maya' }, ME, '   ')).toBe("Maya's bill");
  });
  it('group places are the cleaned group name', () => {
    expect(groupPlace(' Trip\tto  Lisbon ')).toBe('Trip to Lisbon');
    expect(groupPlace('  ')).toBe('A group');
    expect(groupPlace(null)).toBe('A group');
  });
  it('caption is "{place} · {time}"', () => {
    expect(feedCaption("Maya's bill", '2026-11-28T19:42:00.000Z', fmt)).toBe("Maya's bill · T19");
    expect(feedCaption("Maya's bill", 'not a time', fmt)).toBe("Maya's bill");
  });
  it('accessibility label: "Unread. " only when unseen, then sentence, place and time', () => {
    expect(feedLineLabel('Sam marked $5.00 paid to you', "Maya's bill", '7:42 PM', true)).toBe(
      "Unread. Sam marked $5.00 paid to you. Maya's bill. 7:42 PM",
    );
    expect(feedLineLabel('Sam marked $5.00 paid to you', "Maya's bill", '7:42 PM', false)).toBe("Sam marked $5.00 paid to you. Maya's bill. 7:42 PM");
  });
});

describe('day headers (criterion 18)', () => {
  const fmt: DayHeaderFormatters = {
    weekday: (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ?? '',
    monthDay: (d) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`,
    monthDayYear: (d) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`,
  };
  // Local times, so the test holds in any time zone. Wednesday 2026-11-25 10:00.
  const now = new Date(2026, 10, 25, 10, 0);
  const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).toISOString();

  it('Today, Yesterday, weekdays, dates', () => {
    expect(dayHeader(at(2026, 10, 25, 0, 0), now, fmt)).toBe('Today');
    expect(dayHeader(at(2026, 10, 24, 23, 59), now, fmt)).toBe('Yesterday');
    expect(dayHeader(at(2026, 10, 24, 0, 0), now, fmt)).toBe('Yesterday');
    expect(dayHeader(at(2026, 10, 23), now, fmt)).toBe('Monday'); // 2 days
    expect(dayHeader(at(2026, 10, 19), now, fmt)).toBe('Thursday'); // 6 days
    expect(dayHeader(at(2026, 10, 18), now, fmt)).toBe('Nov 18'); // 7 days
    expect(dayHeader(at(2026, 0, 1), now, fmt)).toBe('Jan 1');
    expect(dayHeader(at(2025, 10, 18), now, fmt)).toBe('Nov 18, 2025');
  });
  it('is correct on both sides of local midnight', () => {
    const justAfter = new Date(2026, 10, 25, 0, 0);
    expect(dayHeader(at(2026, 10, 24, 23, 59), justAfter, fmt)).toBe('Yesterday');
    expect(dayHeader(at(2026, 10, 25, 0, 0), justAfter, fmt)).toBe('Today');
    const justBefore = new Date(2026, 10, 24, 23, 59);
    expect(dayHeader(at(2026, 10, 24, 23, 59), justBefore, fmt)).toBe('Today');
    expect(dayHeader(at(2026, 10, 24, 0, 0), justBefore, fmt)).toBe('Today');
    expect(dayHeader(at(2026, 10, 23, 23, 59), justBefore, fmt)).toBe('Yesterday');
  });
  it('the year boundary: Dec 31 seen on Jan 1 is Yesterday; 7+ days back into the old year shows the year', () => {
    const jan1 = new Date(2027, 0, 1, 9, 0);
    expect(dayHeader(at(2026, 11, 31, 23, 59), jan1, fmt)).toBe('Yesterday');
    expect(dayHeader(at(2026, 11, 28), jan1, fmt)).toBe('Monday');
    expect(dayHeader(at(2026, 11, 25), jan1, fmt)).toBe('Dec 25, 2026');
  });
  it('a time slightly in the future (clock skew) is Today; a bad timestamp gives an empty header', () => {
    expect(dayHeader(new Date(now.getTime() + 60_000).toISOString(), now, fmt)).toBe('Today');
    expect(dayHeader('nope', now, fmt)).toBe('');
  });
});

describe('marker tones (criterion 20, Contract M)', () => {
  it('maps the four tones exactly', () => {
    expect(FEED_MARKER_TONES).toEqual({
      needs_you: { fill: 'warningSurface', icon: 'warning' },
      money: { fill: 'successSurface', icon: 'success' },
      dispute: { fill: 'disputeSurface', icon: 'dispute' },
      neutral: { fill: 'surfaceMuted', icon: 'textMuted' },
    });
    for (const tone of Object.values(FEED_MARKER_TONES)) {
      expect(colors.light[tone.fill]).toMatch(/^#/);
      expect(colors.dark[tone.icon]).toMatch(/^#/);
    }
  });
  it('unread needs_you, money and dispute keep their tone; everything else is neutral', () => {
    expect(feedMarkerTone('needs_you', true)).toBe('needs_you');
    expect(feedMarkerTone('money', true)).toBe('money');
    expect(feedMarkerTone('dispute', true)).toBe('dispute');
    for (const c of ['share', 'news', 'rollup', 'done'] as const) expect(feedMarkerTone(c, true)).toBe('neutral');
  });
  it('a read line of any category is neutral and keeps its glyph', () => {
    for (const c of ['needs_you', 'money', 'dispute', 'share', 'news', 'rollup', 'done'] as const) expect(feedMarkerTone(c, false)).toBe('neutral');
    const item = bill('not_received', { category: 'dispute', amountCents: 100 });
    expect(glyph(item)).toBe('circle-alert'); // the glyph doesn't depend on seen state
  });
  it('never uses danger', () => {
    expect(JSON.stringify(FEED_MARKER_TONES)).not.toMatch(/danger/);
  });
});

describe('screen and tab bar copy', () => {
  it('screen strings', () => {
    expect(FEED_COPY).toEqual({
      title: 'Activity',
      chips: { all: 'All', money: 'Money', groups: 'Groups' },
      loading: 'Loading activity',
      loadError: "Couldn't load your activity.",
      tryAgain: 'Try again',
      empty: {
        all: 'Nothing new. When someone adds you to a receipt or pays you, it shows up here.',
        money: 'No money activity yet.',
        groups: 'No group activity yet.',
      },
      loadingMore: 'Loading more activity',
      loadMoreError: "Couldn't load more.",
      end: "That's everything.",
    });
  });
  it('roll-up toggle', () => {
    expect(rollupToggle(3, false)).toEqual({ text: 'Show 3', label: 'Show the 3 changes' });
    expect(rollupToggle(3, true)).toEqual({ text: 'Hide', label: 'Hide the changes' });
  });
  it('tab labels carry the badge in the label itself', () => {
    expect(tabsTabLabel(0)).toBe('Tabs');
    expect(tabsTabLabel(1)).toBe('Tabs, 1 open bill');
    expect(tabsTabLabel(4)).toBe('Tabs, 4 open bills');
    expect(tabsTabLabel(12)).toBe('Tabs, 12 open bills');
    expect(groupsTabLabel(false)).toBe('Groups');
    expect(groupsTabLabel(true)).toBe('Groups, new activity');
    expect(activityTabLabel(0)).toBe('Activity');
    expect(activityTabLabel(1)).toBe('Activity, 1 new');
    expect(activityTabLabel(3)).toBe('Activity, 3 new');
    expect(activityTabLabel(9)).toBe('Activity, 9 new');
    expect(activityTabLabel(10)).toBe('Activity, more than 9 new');
    expect(activityTabLabel(-2)).toBe('Activity');
    expect(activityTabLabel(2.5)).toBe('Activity');
  });
});
