// Contract R (docs/specs/2026-11-28-tab-bar-and-activity.md), criterion 21: which items form a run.
// Items are built through classifyFeedEvent from the shared fixtures, never by hand, so they are
// exactly what the feed holds. The run sentences are tested through feedView (lib/feedView.test.ts).
import {
  ANA,
  B1,
  B2,
  billEvent,
  feedCtx,
  G1,
  groupEvent,
  MAYA,
  ME,
  NO_CLAIMS,
  SAM,
} from '@/test-utils/feedFixtures';

import { ROLLUP_WINDOW_MS, rollUp, rollUpNextPage, runIsUnseen, type FeedEntry } from './feedRollup';
import { classifyFeedEvent, type FeedEventRow, type FeedItem } from './feedRules';

const ctx = feedCtx(NO_CLAIMS);
const T0 = Date.parse('2026-11-27T19:42:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const min = (n: number) => n * 60_000;

function item(e: FeedEventRow): FeedItem {
  const it = classifyFeedEvent(e, ctx);
  if (it === null) throw new Error(`fixture ${e.kind} was left out`);
  return it;
}
/** Sam's (or `actor`'s) claim on B1, `offsetMs` before T0. */
const claim = (offsetMs: number, actor = SAM, bill = B1) =>
  item(billEvent('claimed', { actor_id: actor, bill_id: bill, item_name: 'Fries', created_at: iso(T0 - offsetMs) }));
const money = (offsetMs: number) =>
  item(billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 1820, method: 'venmo' }, created_at: iso(T0 - offsetMs) }));

/** Entry shapes as item ids: a string per single item, an array per run. */
function shape(entries: readonly FeedEntry[]): (string | string[])[] {
  return entries.map((e) => (e.type === 'item' ? e.item.id : e.items.map((i) => i.id)));
}

describe('rollUp (Contract R)', () => {
  it('the window is 10 minutes', () => {
    expect(ROLLUP_WINDOW_MS).toBe(600_000);
  });

  it('consecutive roll-up items on one place within the window form one run, newest first', () => {
    const a = claim(0);
    const b = claim(min(4));
    const c = claim(min(9));
    const entries = rollUp([a, b, c]);
    expect(shape(entries)).toEqual([[a.id, b.id, c.id]]);
  });

  it('a lone roll-up item stays a single item (C26), not a run', () => {
    const a = claim(0);
    expect(shape(rollUp([a]))).toEqual([a.id]);
  });

  it('each gap is measured from the previous item: exactly 10 min stays, 10 min + 1 ms splits', () => {
    const a = claim(0);
    const b = claim(ROLLUP_WINDOW_MS); // exactly 10 min after... before a
    const c = claim(ROLLUP_WINDOW_MS * 2); // 10 min before b: still chained
    expect(shape(rollUp([a, b, c]))).toEqual([[a.id, b.id, c.id]]);

    const d = claim(0);
    const e = claim(ROLLUP_WINDOW_MS + 1);
    expect(shape(rollUp([d, e]))).toEqual([d.id, e.id]);
  });

  it('uses the microseconds Postgres sends: 10 min + 1 µs splits', () => {
    const a = item(billEvent('claimed', { actor_id: SAM, item_name: 'Fries', created_at: '2026-11-27T19:42:00.000001+00:00' }));
    const b = item(billEvent('claimed', { actor_id: SAM, item_name: 'Fries', created_at: '2026-11-27T19:32:00.000001+00:00' }));
    const c = item(billEvent('claimed', { actor_id: SAM, item_name: 'Fries', created_at: '2026-11-27T19:32:00+00:00' }));
    expect(shape(rollUp([a, b]))).toEqual([[a.id, b.id]]);
    expect(shape(rollUp([a, c]))).toEqual([a.id, c.id]);
  });

  it('a money item between two claims splits the run', () => {
    const a = claim(0);
    const m = money(min(1));
    const b = claim(min(2));
    expect(m.category).toBe('money');
    expect(shape(rollUp([a, m, b]))).toEqual([a.id, m.id, b.id]);
  });

  it('non-rollup categories never join a run (needs_you, share, news), even on the same place in the window', () => {
    const addedMe = item(billEvent('participant_added', { details: { user_id: ME }, created_at: iso(T0 - min(1)) }));
    const share = item(billEvent('unassigned', { item_name: 'Tacos', details: { user_id: ME }, created_at: iso(T0 - min(2)) }));
    const news = item(groupEvent('expense_added', { details: { expense_id: 'e5000000-0000-4000-8000-0000000000e5', amount_cents: 6000 }, created_at: iso(T0 - min(3)) }));
    const joinA = item(groupEvent('member_joined', { actor_id: ANA, created_at: iso(T0 - min(4)) }));
    expect([addedMe.category, share.category, news.category]).toEqual(['needs_you', 'share', 'news']);
    const a = claim(0);
    expect(shape(rollUp([a, addedMe, share, news, joinA]))).toEqual([a.id, addedMe.id, share.id, news.id, joinA.id]);
  });

  it('different places never merge: another bill, a group, or a bill in that group', () => {
    const a = claim(0, SAM, B1);
    const b = claim(min(1), SAM, B2); // B2 is in G1
    const j = item(groupEvent('member_joined', { group_id: G1, actor_id: ANA, created_at: iso(T0 - min(2)) }));
    const c = claim(min(3), SAM, B2);
    expect(shape(rollUp([a, b, j, c]))).toEqual([a.id, b.id, j.id, c.id]);
  });

  it('mixed roll-up kinds on one place form one run (claims, splits by others, joins)', () => {
    const a = claim(0);
    const split = item(
      billEvent('split_changed', {
        actor_id: SAM,
        item_name: 'Fries',
        details: { before: { [SAM]: 1, [ANA]: 1 }, after: { [SAM]: 2, [ANA]: 1 } },
        created_at: iso(T0 - min(1)),
      }),
    );
    const join = item(billEvent('joined', { actor_id: ANA, created_at: iso(T0 - min(2)) }));
    expect(split.category).toBe('rollup');
    expect(shape(rollUp([a, split, join]))).toEqual([[a.id, split.id, join.id]]);
  });

  it('never throws and drops nothing on an unreadable time: that item just stands alone', () => {
    const a = claim(0);
    const bad = { ...claim(min(1)), at: 'not a time' };
    const b = claim(min(2));
    expect(shape(rollUp([a, bad, b]))).toEqual([a.id, bad.id, b.id]);
  });
});

describe('rollUpNextPage (paging never splits a run)', () => {
  it('a run that crosses a page boundary merges when the next page arrives', () => {
    const items = [claim(0), claim(min(1)), claim(min(2)), claim(min(3)), money(min(4)), claim(min(5))];
    const page1 = rollUp(items.slice(0, 2));
    const joined = rollUpNextPage(page1, items.slice(2));
    expect(shape(joined)).toEqual(shape(rollUp(items)));
    expect(shape(joined)).toEqual([[items[0]!.id, items[1]!.id, items[2]!.id, items[3]!.id], items[4]!.id, items[5]!.id]);
  });

  it('a single trailing roll-up item becomes a run with the next page', () => {
    const items = [money(0), claim(min(1)), claim(min(2))];
    const page1 = rollUp(items.slice(0, 2));
    expect(shape(page1)).toEqual([items[0]!.id, items[1]!.id]);
    expect(shape(rollUpNextPage(page1, items.slice(2)))).toEqual([items[0]!.id, [items[1]!.id, items[2]!.id]]);
  });

  it('pages in any split equal the unpaged result', () => {
    const items = [claim(0), claim(min(1), MAYA), money(min(2)), claim(min(3)), claim(min(4), ANA), claim(min(30)), claim(min(31))];
    const whole = shape(rollUp(items));
    for (let cut = 0; cut <= items.length; cut++) {
      expect(shape(rollUpNextPage(rollUp(items.slice(0, cut)), items.slice(cut)))).toEqual(whole);
    }
  });

  it('does not change the previous page (pure)', () => {
    const items = [claim(0), claim(min(1))];
    const page1 = rollUp(items.slice(0, 1));
    const before = shape(page1);
    rollUpNextPage(page1, items.slice(1));
    expect(shape(page1)).toEqual(before);
  });
});

describe('runIsUnseen', () => {
  it('a run is unseen if any of its items is unseen', () => {
    const [a, b, c] = [claim(0), claim(min(1)), claim(min(2))];
    const [run] = rollUp([a, b, c]);
    if (run?.type !== 'run') throw new Error('expected a run');
    expect(runIsUnseen(run, () => true)).toBe(false);
    expect(runIsUnseen(run, (i) => i.id !== c.id)).toBe(true);
    expect(runIsUnseen(run, () => false)).toBe(true);
  });
});
