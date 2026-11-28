// The Activity tab's data (docs/specs/2026-11-28-tab-bar-and-activity.md Task 8; Contracts C, S, T;
// criteria 39–48; Amendment A1.1). The screen (app/(app)/(tabs)/activity.tsx) only draws what this
// returns, through feedView.
//
// - Every start (a focus, a refresh, a chip change, a retry) is numbered; only the newest one applies
//   its answer, so a late page for an old chip or an old refresh is ignored (Contract T, criterion 46).
//   Leaving the tab cancels whatever is in flight (a page that lands after you left wasn't seen).
// - Seen (Contract S, criterion 47): the seen times are read once per focus, before this focus's
//   markFeedSeen, and the dots use that read for the whole visit (refreshes and chip changes in the
//   same visit keep it). markFeedSeen(myId, 'activity') runs once per focus, after the first page
//   that loads successfully, never after a failed one. A failed seen read shows no dots (quiet
//   rather than a wall of "unread"). The time it stores (R3) is the focus start, or the newest loaded
//   line's server time if that's later (a phone clock behind the server), never "when the loads
//   finished": anything written while the page loaded stays unread.
// - A refresh (focus, foreground, pull) keeps the list on screen while it loads; a failed one keeps
//   it and shows nothing (criterion 45). A successful one replaces the pages from page 1, asking for
//   as many lines as are already loaded, so coming Back from a bill keeps the scroll position
//   (criterion 33). A chip change or a retry after a first-load error discards everything (pages,
//   buffer, cursors) and shows the loading state.
// - Paging (criterion 44): loadMore has a synchronous ref guard, so one request is in flight at a
//   time. While a refresh is in flight it asks nothing (R2: the old pager's next page wouldn't join
//   the refreshed list without a gap); a request made meanwhile runs once the refresh lands or fails. "That's everything." is decided only by fetchFeedPage's `end` (both sources returned a
//   short page; a full page means "maybe more", A1.1).
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { FEED_PAGE_SIZE, fetchFeedPage, initialFeedState, type FeedPagerState } from './activityFeed';
import { feedTimeMicros, type FeedFilter, type FeedItem } from './feedRules';
import { isFeedItemSeen, markFeedSeen, readFeedSeen, type FeedSeen } from './feedSeen';
import type { FeedSeenRule, FeedViewFacts } from './feedView';

export type FeedMore = 'idle' | 'loading' | 'error';

export type ActivityFeedLoad =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      /** Every loaded page's lines and milestone candidates, in page order (feedView's input). */
      items: readonly FeedItem[];
      facts: FeedViewFacts;
      /** The clock the lines were loaded at (feedView's `now`: day headers). */
      now: Date;
      end: boolean;
      more: FeedMore;
    };

export type ActivityFeed = {
  load: ActivityFeedLoad;
  filter: FeedFilter;
  /** This visit's seen rule (read before this focus's markFeedSeen). */
  isSeen: FeedSeenRule;
  /** Pull-to-refresh in progress (only the pull shows the spinner). */
  refreshing: boolean;
  setFilter: (f: FeedFilter) => void;
  /** First-load error's "Try again". */
  retry: () => void;
  /** Pull to refresh. */
  refresh: () => void;
  /** onEndReached, and the load-more error's "Try again". */
  loadMore: () => void;
};

type Start = 'focus' | 'refresh' | 'pull' | 'reset';

/** No seen read (it failed): every line reads as seen, so nothing is falsely marked new. */
const ALL_SEEN: FeedSeenRule = () => true;

function seenRule(seen: FeedSeen | null, now: number): FeedSeenRule {
  if (seen === null) return ALL_SEEN;
  return (item) => isFeedItemSeen(item, seen, now);
}

/** R3: the Activity seen time: the focus start, or the newest loaded line if later (rounded up to the ms). */
export function activitySeenStamp(focusAt: number, items: readonly Pick<FeedItem, 'at'>[]): number {
  let stamp = focusAt;
  for (const item of items) {
    const us = feedTimeMicros(item.at);
    if (us !== null) stamp = Math.max(stamp, Math.ceil(us / 1000));
  }
  return stamp;
}

export function useActivityFeed(myId: string): ActivityFeed {
  const [load, setLoad] = useState<ActivityFeedLoad>({ status: 'loading' });
  const [filter, setFilterState] = useState<FeedFilter>('all');
  const [isSeen, setIsSeen] = useState<FeedSeenRule>(() => ALL_SEEN);
  const [refreshing, setRefreshing] = useState(false);

  const mounted = useRef(true);
  const gen = useRef(0);
  const filterRef = useRef<FeedFilter>('all');
  const loadRef = useRef<ActivityFeedLoad>(load);
  const pager = useRef<FeedPagerState | null>(null);
  const moreInFlight = useRef(false);
  /** This focus's seen read (null result = the read failed). */
  const visitSeen = useRef<Promise<FeedSeenRule> | null>(null);
  const markedThisFocus = useRef(false);
  /** When this focus started (R3: the Activity seen time). */
  const focusAt = useRef<number | null>(null);
  /** R2: a refresh is in flight, so loadMore waits; `moreWanted` is a loadMore asked for meanwhile. */
  const refreshInFlight = useRef(false);
  const moreWanted = useRef(false);
  const loadMoreRef = useRef<() => void>(() => {});

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      gen.current += 1;
    };
  }, []);

  const apply = useCallback((next: ActivityFeedLoad) => {
    loadRef.current = next;
    setLoad(next);
  }, []);

  const start = useCallback(
    (kind: Start) => {
      const mine = ++gen.current;
      moreInFlight.current = false;
      refreshInFlight.current = true;
      moreWanted.current = false;
      if (kind === 'focus') {
        markedThisFocus.current = false;
        const at = Date.now();
        focusAt.current = at;
        visitSeen.current = readFeedSeen(myId).then(
          (s) => seenRule(s, at),
          () => ALL_SEEN,
        );
      }
      const seenRead = visitSeen.current ?? Promise.resolve(ALL_SEEN);
      const prev = loadRef.current;
      const keepList = kind !== 'reset' && prev.status === 'ready';
      if (!keepList) {
        pager.current = null;
        apply({ status: 'loading' });
      }
      if (kind === 'pull') setRefreshing(true);
      // A refresh asks for as many lines as are loaded, so the list keeps its length (and scroll).
      const loaded = keepList ? prev.items.filter((i) => i.milestone === null).length : 0;
      const first = initialFeedState(myId, { pageSize: Math.max(FEED_PAGE_SIZE, loaded) });
      const chip = filterRef.current;
      /** This start is over: paging may go on, and a loadMore asked for meanwhile runs now. */
      const release = () => {
        refreshInFlight.current = false;
        if (moreWanted.current) {
          moreWanted.current = false;
          loadMoreRef.current();
        }
      };
      void fetchFeedPage(chip, first)
        .then(async (res) => {
          if (!mounted.current || mine !== gen.current) return;
          if (!res.ok) {
            if (kind === 'pull') setRefreshing(false);
            // A failed refresh keeps the list and says nothing; only a first load shows the error.
            if (!keepList) apply({ status: 'error' });
            release();
            return;
          }
          const rule = await seenRead;
          if (!mounted.current || mine !== gen.current) return;
          const { page } = res;
          // Later pages go back to the normal size.
          pager.current = { ...page.state, pageSize: FEED_PAGE_SIZE };
          setIsSeen(() => rule);
          apply({
            status: 'ready',
            items: [...page.items, ...page.candidates],
            facts: page.viewFacts,
            now: new Date(),
            end: page.end,
            more: 'idle',
          });
          if (kind === 'pull') setRefreshing(false);
          if (!markedThisFocus.current) {
            markedThisFocus.current = true;
            void markFeedSeen(myId, 'activity', null, activitySeenStamp(focusAt.current ?? Date.now(), [...page.items, ...page.candidates]));
          }
          release();
        })
        .catch(() => {
          // fetchFeedPage never throws; this only guards the seen read's rule.
          if (!mounted.current || mine !== gen.current) return;
          if (kind === 'pull') setRefreshing(false);
          if (!keepList) apply({ status: 'error' });
          release();
        });
    },
    [apply, myId],
  );

  const loadMore = useCallback(() => {
    const cur = loadRef.current;
    const state = pager.current;
    if (refreshInFlight.current) {
      // R2: the refreshed pages replace these; ask once the refresh is over.
      if (cur.status === 'ready' && !cur.end) moreWanted.current = true;
      return;
    }
    if (cur.status !== 'ready' || cur.end || state === null || moreInFlight.current) return;
    moreInFlight.current = true;
    const mine = gen.current;
    apply({ ...cur, more: 'loading' });
    void fetchFeedPage(filterRef.current, state).then((res) => {
      if (!mounted.current || mine !== gen.current) return;
      moreInFlight.current = false;
      const now = loadRef.current;
      if (now.status !== 'ready') return;
      if (!res.ok) {
        // Every loaded line stays; the footer offers "Try again".
        apply({ ...now, more: 'error' });
        return;
      }
      const { page } = res;
      pager.current = page.state;
      apply({
        ...now,
        items: [...now.items, ...page.items, ...page.candidates],
        facts: page.viewFacts,
        end: page.end,
        more: 'idle',
      });
    });
  }, [apply]);
  loadMoreRef.current = loadMore;

  useFocusEffect(
    useCallback(() => {
      start('focus');
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'active') start('refresh');
      });
      return () => {
        // Leaving cancels what's in flight; the list stays for when you come Back.
        gen.current += 1;
        moreInFlight.current = false;
        // What's on screen matches the pager again (the cancelled refresh never applied).
        refreshInFlight.current = false;
        moreWanted.current = false;
        const cur = loadRef.current;
        if (cur.status === 'ready' && cur.more === 'loading') apply({ ...cur, more: 'idle' });
        setRefreshing(false);
        // jest-expo's AppState mock returns no subscription; the real one always does.
        sub?.remove();
      };
    }, [apply, start]),
  );

  const setFilter = useCallback(
    (f: FeedFilter) => {
      if (f === filterRef.current) return;
      filterRef.current = f;
      setFilterState(f);
      start('reset');
    },
    [start],
  );

  const retry = useCallback(() => start('reset'), [start]);
  const refresh = useCallback(() => start('pull'), [start]);

  return { load, filter, isSeen, refreshing, setFilter, retry, refresh, loadMore };
}
