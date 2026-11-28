// Roll-ups (docs/specs/2026-11-28-tab-bar-and-activity.md, Contract R): which feed items form one
// expandable line. Pure; never throws. The run's sentence (C27) and its children (C26) are worded by
// lib/feedText.ts; lib/feedView.ts puts them on the line.
//
// Walking the feed newest first, consecutive `rollup` items form one run when they are on the same
// place (feedPlaceKey: the bill, else the group) and each is within ROLLUP_WINDOW_MS of the item
// before it. Any other item in between ends the run; money, dispute, share, needs_you, news and done
// items never join one.

import { feedPlaceKey, feedTimeMicros, type FeedItem } from './feedRules';

/** Starting value (FEED-12). Inclusive: a gap of exactly 10 minutes stays in the run. */
export const ROLLUP_WINDOW_MS = 10 * 60 * 1000;

/** One feed entry: a single item, or a run of two or more roll-up items, newest first. */
export type FeedEntry = { type: 'item'; item: FeedItem } | { type: 'run'; items: readonly FeedItem[] };

const WINDOW_MICROS = ROLLUP_WINDOW_MS * 1000;

/** Whether `next` (older) continues a run whose last item is `prev`. */
function continues(prev: FeedItem, next: FeedItem): boolean {
  if (prev.category !== 'rollup' || next.category !== 'rollup') return false;
  if (feedPlaceKey(prev) !== feedPlaceKey(next)) return false;
  const a = feedTimeMicros(prev.at);
  const b = feedTimeMicros(next.at);
  if (a === null || b === null) return false;
  const gap = a - b;
  return gap >= 0 && gap <= WINDOW_MICROS;
}

function entryOf(group: readonly FeedItem[]): FeedEntry | null {
  const [first] = group;
  if (first === undefined) return null;
  return group.length === 1 ? { type: 'item', item: first } : { type: 'run', items: [...group] };
}

/** The feed's entries for items in feed order (newest first). */
export function rollUp(items: readonly FeedItem[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let group: FeedItem[] = [];
  const flush = () => {
    const e = entryOf(group);
    if (e !== null) out.push(e);
    group = [];
  };
  for (const item of items) {
    const last = group[group.length - 1];
    if (last !== undefined && !continues(last, item)) flush();
    group.push(item);
  }
  flush();
  return out;
}

/**
 * The entries after the next page arrives. The previous page's last entry, when it's a roll-up
 * (a run, or a lone roll-up item), is merged with the new rows again, so paging never splits a run.
 * `prev` is not changed. Equal to rollUp(all items) for any split.
 */
export function rollUpNextPage(prev: readonly FeedEntry[], page: readonly FeedItem[]): FeedEntry[] {
  const last = prev[prev.length - 1];
  if (last === undefined) return rollUp(page);
  const tail = last.type === 'run' ? last.items : last.item.category === 'rollup' ? [last.item] : null;
  if (tail === null) return [...prev, ...rollUp(page)];
  return [...prev.slice(0, -1), ...rollUp([...tail, ...page])];
}

/** A run is unseen if any item in it is unseen. */
export function runIsUnseen(run: Extract<FeedEntry, { type: 'run' }>, isSeen: (item: FeedItem) => boolean): boolean {
  return run.items.some((i) => !isSeen(i));
}
