// The feed view model (docs/specs/2026-11-28-tab-bar-and-activity.md, Task 4), criteria 21–24.
// Items come from classifyFeedEvent and milestone candidates from milestoneCandidate, both fed the
// shared fixtures; bill and group states are real BillData / GroupSnapshot values that go through the
// same functions Home and the Groups list use. Every expected sentence and amount is worked out by
// hand from the spec, never read off the code.

// lib/groups (via groupHomeView) loads the Supabase client; no call is made here.
jest.mock('./supabase', () => ({ supabase: {} }));

import {
  ANA,
  B1,
  B2,
  billEvent,
  feedCtx,
  FEED_NAMES,
  G1,
  groupEvent,
  JOINED_AT,
  MAYA,
  ME,
  ROW_FRIES,
  ROW_NACHOS,
  ROW_TACOS,
  SAM,
} from '@/test-utils/feedFixtures';
import { ANA as W_ANA, BEN, W1 } from '@/test-utils/groupFixtures';
import { GROUP_ID, paymentId, snapshotOf } from '@/test-utils/groupSnapshotFixtures';
import { fakePayment } from '@/test-utils/fakes';

import type { BillData } from './bills';
import { classifyFeedEvent, myClaimedRowNames, type FeedContext, type FeedEventRow, type FeedItem } from './feedRules';
import { feedView, milestoneCandidate, type FeedLine, type FeedSection, type FeedViewFacts, type FeedViewFormatters } from './feedView';
import type { GroupSnapshot } from './groups';

// ---------------------------------------------------------------------------------------------
// Time: local clock, so day headers and "7:42 PM" don't depend on the machine's zone.

const local = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).toISOString();
const AT = local(27, 19, 42);
const NOW = new Date(2026, 10, 27, 21, 0);
const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
const MIN = 60_000;

const pad = (n: number) => String(n).padStart(2, '0');
const fmt: FeedViewFormatters = {
  time: (d) => `${((d.getHours() + 11) % 12) + 1}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`,
  weekday: (d) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] ?? '',
  monthDay: (d) => `Nov ${d.getDate()}`,
  monthDayYear: (d) => `Nov ${d.getDate()}, ${d.getFullYear()}`,
};

const NONE_SEEN = () => false;
const ALL_SEEN = () => true;

// ---------------------------------------------------------------------------------------------
// Bills. B1 is Maya's (no group): Tacos $10.00 (me), Nachos $9.00 (me and Sam), Fries $5.00 (Sam),
// total $28.80, so extras are $4.80.
//   Proportional, by hand: my items 1000 + 450 = 1450 of 2400 → extras 480 × 1450/2400 = 290 →
//   my share 1740 ($17.40). Sam: 450 + 500 = 950, extras 190 → 1140 ($11.40).
//   Even: extras 480 between me and Sam → 240 each → mine 1690 ($16.90).

const LEO = '0d000000-0000-4000-8000-000000000005';
const SODA = '10000000-0000-4000-8000-000000000009';
const NAMES = new Map<string, string | null>([...Object.entries(FEED_NAMES), [LEO, 'Leo']]);

type Row = BillData['rows'][number];
const row = (id: string, name: string, cents: number): Row => ({
  id,
  name,
  note: null,
  group_position: 0,
  unit_index: 0,
  group_size: 1,
  total_cents: cents,
  kind: 'item',
  applies_to: null,
  split_set_by: null,
  split_set_at: null,
});
const member = (userId: string) => ({ userId, displayName: FEED_NAMES[userId] ?? 'Me', venmoUsername: null, mark: null, notReceived: null });

function b1Data(over: { mode?: 'proportional' | 'equal'; sodaUnclaimed?: boolean; payerId?: string; payments?: BillData['payments'] } = {}): BillData {
  const soda = over.sodaUnclaimed ? [row(SODA, 'Soda', 0)] : [];
  return {
    bill: {
      id: B1,
      host_id: MAYA,
      payer_id: over.payerId ?? MAYA,
      join_code: '0123456789abcdef0123',
      created_at: local(27, 19, 0),
      edited_at: null,
      extras_split: over.mode ?? 'proportional',
      subtotal_cents: 2400,
      tax_cents: 480,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 2880,
    },
    rows: [row(ROW_TACOS, 'Tacos', 1000), row(ROW_NACHOS, 'Nachos', 900), row(ROW_FRIES, 'Fries', 500), ...soda],
    participants: [member(MAYA), member(ME), member(SAM)],
    claims: [
      { line_item_id: ROW_TACOS, user_id: ME, parts: 1 },
      { line_item_id: ROW_NACHOS, user_id: ME, parts: 1 },
      { line_item_id: ROW_NACHOS, user_id: SAM, parts: 1 },
      { line_item_id: ROW_FRIES, user_id: SAM, parts: 1 },
    ],
    payers: [],
    payments: over.payments ?? [],
    flags: [],
  };
}

/** I'm the payer and Sam has paid me his whole share ($11.40): everyone's square. */
const b1Settled = () =>
  b1Data({ payerId: ME, payments: [fakePayment('f1000000-0000-4000-8000-000000000001', SAM, ME, 1140, local(27, 19, 30))] });
/** I'm the payer and Sam hasn't paid: I'm still owed. */
const b1Owed = () => b1Data({ payerId: ME });
/** Maya pays; I'm a guest and have paid her `cents` of my $17.40. */
const b1GuestPaid = (cents: number) =>
  b1Data({ payments: [fakePayment('f2000000-0000-4000-8000-000000000002', ME, MAYA, cents, local(27, 19, 30))] });

/** The classify context built through myClaimedRowNames from the same BillData the facts carry. */
function ctxFor(data: BillData | null, over: Partial<FeedContext> = {}): FeedContext {
  const claims = new Map<string, ReadonlySet<string>>();
  if (data !== null) claims.set(B1, myClaimedRowNames(data, ME));
  return feedCtx(claims, over);
}

function factsFor(over: Partial<FeedViewFacts> = {}): FeedViewFacts {
  return {
    myId: ME,
    names: NAMES,
    bills: ctxFor(null).bills,
    groupNames: new Map([[G1, 'Tahoe']]),
    billData: new Map(),
    snapshots: new Map(),
    ...over,
  };
}

function classify(e: FeedEventRow, ctx: FeedContext): FeedItem {
  const item = classifyFeedEvent(e, ctx);
  if (item === null) throw new Error(`fixture ${e.kind} was left out`);
  return item;
}
function candidate(e: FeedEventRow, ctx: FeedContext): FeedItem {
  const item = milestoneCandidate(e, ctx);
  if (item === null) throw new Error(`fixture ${e.kind} triggers no milestone`);
  return item;
}

const lines = (sections: readonly FeedSection[]): FeedLine[] => sections.flatMap((s) => s.lines);
const sentences = (sections: readonly FeedSection[]): string[] => lines(sections).map((l) => l.sentence);

// ---------------------------------------------------------------------------------------------

describe('line fields (criterion 24)', () => {
  it('a bill money line: sentence, caption, tone, glyph, opens and the accessibility label', () => {
    const ctx = ctxFor(null);
    const e = billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 1820, method: 'venmo' }, created_at: AT });
    const [line] = lines(feedView([classify(e, ctx)], factsFor(), NONE_SEEN, NOW, fmt));
    expect(line).toMatchObject({
      sentence: 'Sam marked $18.20 paid to you',
      place: "Maya's bill",
      time: '7:42 PM',
      caption: "Maya's bill · 7:42 PM",
      category: 'money',
      tone: 'money',
      glyph: 'banknote',
      unread: true,
      opens: { bill: B1 },
      a11yLabel: "Unread. Sam marked $18.20 paid to you. Maya's bill. 7:42 PM",
      run: null,
    });
  });

  it('a seen line is neutral, keeps its glyph and has no "Unread." prefix', () => {
    const ctx = ctxFor(null);
    const e = billEvent('not_received', { actor_id: MAYA, details: { user_id: ME, payer_id: MAYA, cents: 1820, method: 'venmo' }, created_at: AT });
    const unread = lines(feedView([classify(e, ctx)], factsFor(), NONE_SEEN, NOW, fmt))[0];
    const read = lines(feedView([classify(e, ctx)], factsFor(), ALL_SEEN, NOW, fmt))[0];
    expect(unread).toMatchObject({ tone: 'dispute', glyph: 'circle-alert', unread: true });
    expect(read).toMatchObject({ tone: 'neutral', glyph: 'circle-alert', unread: false });
    expect(read?.a11yLabel).toBe("Maya says they didn't get your $18.20. Maya's bill. 7:42 PM");
  });

  it('a group line opens the group and is placed by the group name', () => {
    const ctx = ctxFor(null);
    const e = groupEvent('payment_recorded', {
      actor_id: SAM,
      details: { payment_id: 'a1000000-0000-4000-8000-0000000000a1', from: SAM, to: ME, cents: 2500, method: 'venmo', source: 'venmo_link' },
      created_at: AT,
    });
    const [line] = lines(feedView([classify(e, ctx)], factsFor(), NONE_SEEN, NOW, fmt));
    expect(line).toMatchObject({ sentence: 'Sam marked $25.00 paid to you', caption: 'Tahoe · 7:42 PM', opens: { group: G1 } });
  });

  it("a group bill's line opens the bill, and its place names the host and the group", () => {
    const ctx = ctxFor(null);
    const e = billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 990, method: 'venmo' }, created_at: AT });
    const [line] = lines(feedView([classify(e, ctx)], factsFor(), NONE_SEEN, NOW, fmt));
    expect(line).toMatchObject({ caption: "Sam's bill · Tahoe · 7:42 PM", opens: { bill: B2 } });
  });

  it('names: a missing profile reads "Someone", a blank name "A friend" (in the sentence and the place)', () => {
    const ctx = ctxFor(null);
    const e = billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 500, method: 'venmo' }, created_at: AT });
    const names = new Map<string, string | null>([[MAYA, '  ']]);
    const [line] = lines(feedView([classify(e, ctx)], factsFor({ names }), NONE_SEEN, NOW, fmt));
    expect(line?.sentence).toBe('Someone marked $5.00 paid to you');
    expect(line?.place).toBe("A friend's bill");
  });

  it('group news uses the expense title from the snapshot when loaded, else the no-title form', () => {
    const ctx = ctxFor(null);
    const e = groupEvent('expense_added', {
      details: { expense_id: 'e1000000-0000-4000-8000-000000000001', title: 'Gas', amount_cents: 6000 },
      created_at: AT,
    });
    const item = classify(e, ctx);
    expect(sentences(feedView([item], factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Ana added an expense of $60.00']);
    // AIRBNB_ID's current title in the snapshot fixture is "Airbnb" (the event's "Gas" is never used).
    const snapshot = snapshotOf(W1.input);
    const facts = factsFor({ snapshots: new Map([[G1, snapshot]]) });
    expect(sentences(feedView([item], facts, NONE_SEEN, NOW, fmt))).toEqual(['Ana added Airbnb, $60.00']);
  });

  it('an item that cannot be worded is dropped, and the rest stay', () => {
    const ctx = ctxFor(null);
    const ok = classify(billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 500, method: 'venmo' }, created_at: AT }), ctx);
    const broken: FeedItem = { ...ok, id: 'e0000000-0000-4000-8000-0000000000ff', kind: 'something_new' };
    expect(sentences(feedView([broken, ok], factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam marked $5.00 paid to you']);
  });
});

describe('day sections (criterion 43 input)', () => {
  it('groups lines under Today / Yesterday / weekday, newest first', () => {
    const ctx = ctxFor(null);
    const paid = (at: string, cents: number) =>
      classify(billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents, method: 'venmo' }, created_at: at }), ctx);
    const sections = feedView([paid(AT, 100), paid(local(27, 8, 0), 200), paid(local(26, 23, 59), 300), paid(local(24, 12, 0), 400)], factsFor(), NONE_SEEN, NOW, fmt);
    expect(sections.map((s) => [s.title, s.lines.map((l) => l.sentence)])).toEqual([
      ['Today', ['Sam marked $1.00 paid to you', 'Sam marked $2.00 paid to you']],
      ['Yesterday', ['Sam marked $3.00 paid to you']],
      ['Tuesday', ['Sam marked $4.00 paid to you']],
    ]);
    expect(new Set(sections.map((s) => s.key)).size).toBe(3);
  });
});

describe('share clause (Contract H, criterion 22)', () => {
  const shareEvents = (): FeedEventRow[] => [
    billEvent('amounts_changed', { details: { tip_cents: [200, 400], tax_cents: [100, 120] }, created_at: AT }),
    billEvent('extras_split_changed', { details: { before: 'proportional', after: 'equal' }, created_at: minus(AT, 20 * MIN) }),
    billEvent('item_removed', { item_name: 'Nachos', details: { qty: 1, price_cents: 900, claimer_ids: [ME, SAM] }, created_at: minus(AT, 40 * MIN) }),
    billEvent('item_changed', { item_name: 'Tacos', details: { price_cents: [1200, 1000] }, created_at: minus(AT, 60 * MIN) }),
    billEvent('split_changed', {
      item_name: 'Nachos',
      details: { before: { [ME]: 1, [SAM]: 2 }, after: { [ME]: 1, [SAM]: 1 } },
      created_at: minus(AT, 80 * MIN),
    }),
    billEvent('unassigned', { item_name: 'Soda', details: { user_id: ME }, created_at: minus(AT, 100 * MIN) }),
  ];
  const heads = [
    'Maya changed the tip and the tax',
    'Maya changed how tax and tip are split',
    "Maya removed Nachos, which you'd claimed",
    'Maya changed Tacos',
    'Maya changed the split on Nachos',
    'Maya removed you from Soda',
  ];

  it('proportional, with my claims: every C10–C15 line ends ". Your share is now $17.40" (the bill screen\'s figure)', () => {
    const data = b1Data();
    const ctx = ctxFor(data);
    const items = shareEvents().map((e) => classify(e, ctx));
    const facts = factsFor({ billData: new Map([[B1, data]]) });
    expect(sentences(feedView(items, facts, NONE_SEEN, NOW, fmt))).toEqual(heads.map((h) => `${h}. Your share is now $17.40`));
  });

  it('even mode with an unclaimed item: no clause on C10–C15', () => {
    const data = b1Data({ mode: 'equal', sodaUnclaimed: true });
    const ctx = ctxFor(data);
    const items = shareEvents().map((e) => classify(e, ctx));
    const out = sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt));
    // The same six lines are there (positive control), just without a share.
    expect(out).toEqual(heads);
  });

  it('even mode, fully claimed: the clause shows the even share ($16.90)', () => {
    const data = b1Data({ mode: 'equal' });
    const ctx = ctxFor(data);
    const [first] = shareEvents();
    const out = sentences(feedView([classify(first!, ctx)], factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt));
    expect(out).toEqual(['Maya changed the tip and the tax. Your share is now $16.90']);
  });

  it('a failed facts read (no BillData for the bill): no clause', () => {
    const ctx = ctxFor(b1Data());
    const items = shareEvents().map((e) => classify(e, ctx));
    expect(sentences(feedView(items, factsFor(), NONE_SEEN, NOW, fmt))).toEqual(heads);
  });

  it('a money line never gets a share clause, even with the bill loaded', () => {
    const data = b1Data();
    const ctx = ctxFor(data);
    const e = billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 1820, method: 'venmo' }, created_at: AT });
    expect(sentences(feedView([classify(e, ctx)], factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))).toEqual([
      'Sam marked $18.20 paid to you',
    ]);
  });
});

describe('roll-up lines (Contract R, criterion 21)', () => {
  const ctx = ctxFor(null);
  const claimBy = (actor: string, name: string, at: string, bill = B1) =>
    classify(billEvent('claimed', { actor_id: actor, bill_id: bill, item_name: name, created_at: at }), ctx);

  it('3 claims by Sam within 10 min → "Sam claimed 3 items", children are the C26 sentences newest first', () => {
    const items = [claimBy(SAM, 'Fries', AT), claimBy(SAM, 'Nachos', minus(AT, 3 * MIN)), claimBy(SAM, 'Tacos', minus(AT, 9 * MIN))];
    const out = lines(feedView(items, factsFor(), NONE_SEEN, NOW, fmt));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sentence: 'Sam claimed 3 items',
      category: 'rollup',
      tone: 'neutral',
      glyph: 'users-round',
      opens: { bill: B1 },
      caption: "Maya's bill · 7:42 PM",
      a11yLabel: "Unread. Sam claimed 3 items. Maya's bill. 7:42 PM",
    });
    expect(out[0]?.run).toEqual({
      count: 3,
      children: [
        { key: items[0]!.id, sentence: 'Sam claimed Fries' },
        { key: items[1]!.id, sentence: 'Sam claimed Nachos' },
        { key: items[2]!.id, sentence: 'Sam claimed Tacos' },
      ],
    });
  });

  it('9 claims by four people → "Sam, Ana and 2 others claimed 9 items" (names newest first)', () => {
    const who = [SAM, SAM, ANA, MAYA, SAM, LEO, ANA, MAYA, LEO];
    const items = who.map((actor, i) => claimBy(actor, `Dish ${i + 1}`, minus(AT, i * MIN)));
    expect(sentences(feedView(items, factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam, Ana and 2 others claimed 9 items']);
  });

  it('a claim and a split → "made 2 changes"', () => {
    const split = classify(
      billEvent('split_changed', {
        actor_id: ANA,
        item_name: 'Fries',
        details: { before: { [SAM]: 1, [ANA]: 1 }, after: { [SAM]: 2, [ANA]: 1 } },
        created_at: minus(AT, MIN),
      }),
      ctx,
    );
    expect(sentences(feedView([claimBy(SAM, 'Fries', AT), split], factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam and Ana made 2 changes']);
  });

  it('two joins → "Sam and Ana joined"; for participant_added the added person is named (counterpartId → targetId)', () => {
    const joinSam = classify(billEvent('joined', { actor_id: SAM, created_at: AT }), ctx);
    const joinAna = classify(billEvent('joined', { actor_id: ANA, created_at: minus(AT, MIN) }), ctx);
    expect(sentences(feedView([joinSam, joinAna], factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam and Ana joined']);

    // Maya added Ana: the line names Ana, not Maya.
    const addedAna = classify(billEvent('participant_added', { actor_id: MAYA, details: { user_id: ANA }, created_at: minus(AT, MIN) }), ctx);
    expect(addedAna.category).toBe('rollup');
    const out = lines(feedView([joinSam, addedAna], factsFor(), NONE_SEEN, NOW, fmt));
    expect(out.map((l) => l.sentence)).toEqual(['Sam and Ana joined']);
    expect(out[0]?.run?.children.map((c) => c.sentence)).toEqual(['Sam joined', 'Maya added Ana']);
  });

  it('a lone roll-up item reads its C26 sentence with the target from counterpartId, and has no run', () => {
    const assigned = classify(billEvent('assigned', { actor_id: MAYA, item_name: 'Tacos', details: { user_id: SAM }, created_at: AT }), ctx);
    const [line] = lines(feedView([assigned], factsFor(), NONE_SEEN, NOW, fmt));
    expect(line).toMatchObject({ sentence: 'Maya assigned Tacos to Sam', run: null, glyph: 'users-round' });
  });

  it('a money item between two claims splits the run; different places never merge', () => {
    const money = classify(billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 500, method: 'venmo' }, created_at: minus(AT, MIN) }), ctx);
    const items = [claimBy(SAM, 'Fries', AT), money, claimBy(SAM, 'Nachos', minus(AT, 2 * MIN)), claimBy(SAM, 'Pizza', minus(AT, 3 * MIN), B2)];
    expect(sentences(feedView(items, factsFor(), NONE_SEEN, NOW, fmt))).toEqual([
      'Sam claimed Fries',
      'Sam marked $5.00 paid to you',
      'Sam claimed Nachos',
      'Sam claimed Pizza',
    ]);
  });

  it('a run is unread if any of its items is unseen', () => {
    const items = [claimBy(SAM, 'Fries', AT), claimBy(SAM, 'Nachos', minus(AT, MIN))];
    const oldest = items[1]!.id;
    const [someUnseen] = lines(feedView(items, factsFor(), (i) => i.id !== oldest, NOW, fmt));
    const [allSeen] = lines(feedView(items, factsFor(), ALL_SEEN, NOW, fmt));
    expect(someUnseen?.unread).toBe(true);
    expect(someUnseen?.a11yLabel.startsWith('Unread. ')).toBe(true);
    expect(allSeen?.unread).toBe(false);
    expect(allSeen?.sentence).toBe('Sam claimed 2 items'); // positive control: the same run
  });
});

describe('milestones (criterion 23)', () => {
  describe('fully claimed', () => {
    const claimFries = billEvent('claimed', { actor_id: SAM, item_name: 'Fries', created_at: AT });
    const claimNachos = billEvent('claimed', { actor_id: SAM, item_name: 'Nachos', created_at: minus(AT, 30 * MIN) });

    it('sits directly above its trigger, shows my share, and only the newest candidate per bill is kept', () => {
      const data = b1Data();
      const ctx = ctxFor(data);
      // Candidates arrive after their triggers, in any order: the view places them.
      const items = [classify(claimFries, ctx), classify(claimNachos, ctx), candidate(claimNachos, ctx), candidate(claimFries, ctx)];
      const out = lines(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt));
      expect(out.map((l) => l.sentence)).toEqual([
        'This bill is fully claimed, so totals are final. Your share is $17.40',
        'Sam claimed Fries',
        'Sam claimed Nachos',
      ]);
      expect(out[0]).toMatchObject({ category: 'done', tone: 'neutral', glyph: 'circle-check', opens: { bill: B1 }, run: null });
    });

    it('even mode, fully claimed: the share is the even one', () => {
      const data = b1Data({ mode: 'equal' });
      const ctx = ctxFor(data);
      const items = [classify(claimFries, ctx), candidate(claimFries, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))[0]).toBe(
        'This bill is fully claimed, so totals are final. Your share is $16.90',
      );
    });

    it('disappears when the bill is no longer complete (even mode with an unclaimed item: no line, so no share either)', () => {
      const data = b1Data({ mode: 'equal', sodaUnclaimed: true });
      const ctx = ctxFor(data);
      const items = [classify(claimFries, ctx), candidate(claimFries, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))).toEqual(['Sam claimed Fries']);
    });

    it('dropped when the bill data did not load (completeness unknown)', () => {
      const ctx = ctxFor(b1Data());
      const items = [classify(claimFries, ctx), candidate(claimFries, ctx)];
      expect(sentences(feedView(items, factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam claimed Fries']);
    });

    it('without a share for me (I claim nothing) the line has no share part', () => {
      // Maya takes my Tacos; Sam keeps Nachos and Fries. Every row is still claimed.
      const claims = b1Data().claims.filter((c) => c.user_id !== ME);
      const data: BillData = { ...b1Data(), claims: [...claims, { line_item_id: ROW_TACOS, user_id: MAYA, parts: 1 }] };
      const ctx = ctxFor(data);
      const items = [classify(claimFries, ctx), candidate(claimFries, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))[0]).toBe(
        'This bill is fully claimed, so totals are final',
      );
    });

    it('never counts', () => {
      const ctx = ctxFor(b1Data());
      expect(candidate(claimFries, ctx)).toMatchObject({ category: 'done', counts: false, amountCents: null, milestone: 'fully_claimed' });
    });
  });

  describe('all square', () => {
    const paidMe = billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 1140, method: 'venmo' }, created_at: AT });

    it('a payer whose owed amounts are all paid: kept', () => {
      const data = b1Settled();
      const ctx = ctxFor(data);
      const items = [classify(paidMe, ctx), candidate(paidMe, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))).toEqual([
        "You're all square on this bill",
        'Sam marked $11.40 paid to you',
      ]);
    });

    it('dropped when the bill is not settled (still owed), and when the bill did not load', () => {
      const data = b1Owed();
      const ctx = ctxFor(data);
      const items = [classify(paidMe, ctx), candidate(paidMe, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))).toEqual([
        'Sam marked $11.40 paid to you',
      ]);
      expect(sentences(feedView(items, factsFor(), NONE_SEEN, NOW, fmt))).toEqual(['Sam marked $11.40 paid to you']);
    });

    describe('a guest (Maya pays), from my own "I paid" (balanceFor, not Home\'s grouping)', () => {
      const myMark = (cents: number) =>
        billEvent('marked_paid', { actor_id: ME, details: { payer_id: MAYA, cents, method: 'venmo' }, created_at: AT });
      // A line on another bill, so the list is never empty (positive control for "dropped").
      const other = () =>
        classify(billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 100, method: 'venmo' }, created_at: minus(AT, MIN) }), ctxFor(null));
      const run = (data: BillData, cents: number) => {
        const ctx = ctxFor(data);
        expect(classifyFeedEvent(myMark(cents), ctx)).toBeNull(); // my own action is not a line
        return sentences(feedView([other(), candidate(myMark(cents), ctx)], factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt));
      };

      it('paid my whole share ($17.40): kept', () => {
        expect(run(b1GuestPaid(1740), 1740)).toEqual(["You're all square on this bill", 'Sam marked $1.00 paid to you']);
      });

      it('within the settled-up tolerance (1¢ short): kept; 2¢ short: dropped', () => {
        expect(run(b1GuestPaid(1739), 1739)).toEqual(["You're all square on this bill", 'Sam marked $1.00 paid to you']);
        expect(run(b1GuestPaid(1738), 1738)).toEqual(['Sam marked $1.00 paid to you']);
      });

      it("hasn't paid: dropped", () => {
        expect(run(b1Data(), 1740)).toEqual(['Sam marked $1.00 paid to you']);
      });

      it('paid, but the bill is not complete (an item unclaimed): dropped', () => {
        const data: BillData = { ...b1GuestPaid(1740), rows: [...b1GuestPaid(1740).rows, row(SODA, 'Soda', 0)] };
        expect(run(data, 1740)).toEqual(['Sam marked $1.00 paid to you']);
      });
    });

    it('a candidate from my own event (not a feed line) is placed by its time', () => {
      const data = b1Settled();
      const ctx = ctxFor(data);
      const mine = billEvent('paid_back', {
        actor_id: ME,
        details: { user_id: SAM, payer_id: ME, from: 1285, to: 1140, method: 'cash' },
        created_at: minus(AT, MIN),
      });
      expect(classifyFeedEvent(mine, ctx)).toBeNull();
      const newer = classify(billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 990, method: 'venmo' }, created_at: AT }), ctx);
      const older = classify(billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 100, method: 'venmo' }, created_at: minus(AT, 2 * MIN) }), ctx);
      const items = [newer, older, candidate(mine, ctx)];
      expect(sentences(feedView(items, factsFor({ billData: new Map([[B1, data]]) }), NONE_SEEN, NOW, fmt))).toEqual([
        'Sam marked $9.90 paid to you',
        "You're all square on this bill",
        'Sam marked $1.00 paid to you',
      ]);
    });
  });

  describe('group settled', () => {
    // W1 from the groups fixtures, seen as Ana (the groups fixtures' member, not the feed fixtures' Ana). Settled once the three suggested payments are recorded.
    const gctx = feedCtx(new Map(), { myId: W_ANA, groups: new Map([[GROUP_ID, { joinedAt: JOINED_AT, hidden: false }]]) });
    const paid = groupEvent('payment_recorded', {
      group_id: GROUP_ID,
      actor_id: BEN,
      details: { payment_id: paymentId(1), from: BEN, to: W_ANA, cents: 1000, method: 'venmo', source: 'venmo_link' },
      created_at: AT,
    });
    const facts = (snapshot: GroupSnapshot | null): FeedViewFacts =>
      factsFor({
        myId: W_ANA,
        names: new Map([[BEN, 'Ben']]),
        groupNames: new Map([[GROUP_ID, 'Tahoe trip']]),
        snapshots: snapshot === null ? new Map() : new Map([[GROUP_ID, snapshot]]),
      });

    it('kept when groupHomeStatus is settled, and it names the other party', () => {
      const settled = snapshotOf({ ...W1.input, payments: [...(W1.shown ?? [])] });
      const items = [classify(paid, gctx), candidate(paid, gctx)];
      const out = lines(feedView(items, facts(settled), NONE_SEEN, NOW, fmt));
      expect(out.map((l) => l.sentence)).toEqual(['You and Ben are settled up', 'Ben marked $10.00 paid to you']);
      expect(out[0]).toMatchObject({ opens: { group: GROUP_ID }, caption: 'Tahoe trip · 7:42 PM' });
    });

    it('dropped when the group is not settled, or its snapshot did not load', () => {
      const open = snapshotOf(W1.input);
      const items = [classify(paid, gctx), candidate(paid, gctx)];
      expect(sentences(feedView(items, facts(open), NONE_SEEN, NOW, fmt))).toEqual(['Ben marked $10.00 paid to you']);
      expect(sentences(feedView(items, facts(null), NONE_SEEN, NOW, fmt))).toEqual(['Ben marked $10.00 paid to you']);
    });
  });

  it('milestoneCandidate is null for an event that triggers nothing', () => {
    const ctx = ctxFor(null);
    expect(milestoneCandidate(billEvent('joined', { actor_id: SAM, created_at: AT }), ctx)).toBeNull();
  });
});
