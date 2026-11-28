// The tab bar's badges (docs/specs/2026-11-28-tab-bar-and-activity.md Task 7, criteria 35–36, A1.1, A1.3).
//
// - tabsBadgeCount: the Tabs badge, from the very `sections` Home renders (homeSections).
// - publishTabsBadge / useTabsBadge: a tiny store Home writes and the bar reads, per signed-in user,
//   so another person signing in on the same device never sees the last person's count.
// - useFeedBadges: the Activity count and the Groups dot (fetchBadgeInputs + readFeedSeen +
//   feedBadges). Refreshes on mount, on each tab change, on foreground, and FEED_SEEN_REFRESH_DELAY_MS
//   after the last of a run of markFeedSeen writes (R4: an open bill writes one per realtime version);
//   a failed, timed-out or late answer keeps the previous badges and shows no error.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { fetchBadgeInputs, feedBadges, FEED_REQUEST_TIMEOUT_MS } from './activityFeed';
import { TIMED_OUT, within } from './asyncTimeout';
import { onFeedSeenChange, readFeedSeen } from './feedSeen';
import type { HomeSections } from './homeSections';

// ---------------------------------------------------------------------------------------------
// The Tabs count

/**
 * A1.3: claim + pay + owed, each bill once. `waiting` is never added (it holds the same rows as claim +
 * pay); settled and hidden bills never count. Independent of which sections are open.
 */
export function tabsBadgeCount(sections: Pick<HomeSections<{ id: string }>, 'claim' | 'pay' | 'owed'>): number {
  const ids = new Set<string>();
  for (const row of [...sections.claim, ...sections.pay, ...sections.owed]) ids.add(row.id);
  return ids.size;
}

type TabsCount = { userId: string; count: number };
let tabsCount: TabsCount | null = null;
const tabsListeners = new Set<() => void>();

/** Home calls this with tabsBadgeCount(sections) whenever the sections it renders change. */
export function publishTabsBadge(userId: string, count: number): void {
  if (userId === '') return;
  const safe = Number.isSafeInteger(count) && count > 0 ? count : 0;
  if (tabsCount?.userId === userId && tabsCount.count === safe) return;
  tabsCount = { userId, count: safe };
  for (const l of [...tabsListeners]) l();
}

/** Test helper: forget the published count. */
export function resetTabsBadge(): void {
  tabsCount = null;
  for (const l of [...tabsListeners]) l();
}

function subscribeTabs(listener: () => void): () => void {
  tabsListeners.add(listener);
  return () => {
    tabsListeners.delete(listener);
  };
}
const tabsSnapshot = () => tabsCount;

/** The Tabs badge for `userId`: 0 until Home has published one for this user. */
export function useTabsBadge(userId: string): number {
  const snap = useSyncExternalStore(subscribeTabs, tabsSnapshot, tabsSnapshot);
  return snap !== null && userId !== '' && snap.userId === userId ? snap.count : 0;
}

// ---------------------------------------------------------------------------------------------
// The Activity count and the Groups dot

export type FeedBadgeState = { activity: number; groupsDot: boolean };

/**
 * R4: a seen write refreshes the badges this long after the last write in a run (trailing), so an
 * open bill that writes markFeedSeen on every realtime version costs one badge read, not one each.
 */
export const FEED_SEEN_REFRESH_DELAY_MS = 2000;
export const NO_FEED_BADGES: FeedBadgeState = Object.freeze({ activity: 0, groupsDot: false });

/**
 * One refresh: the seen times, then the badge inputs, both within Contract T's limit. Null means
 * "keep what you had" (failed, timed out, or signed out).
 */
export async function loadFeedBadges(userId: string, now: () => number = Date.now): Promise<FeedBadgeState | null> {
  if (userId === '') return null;
  try {
    const seen = await within(readFeedSeen(userId), FEED_REQUEST_TIMEOUT_MS);
    if (seen === TIMED_OUT || seen === null) return null;
    const at = now();
    const r = await within(fetchBadgeInputs(userId, seen, at), FEED_REQUEST_TIMEOUT_MS);
    if (r === TIMED_OUT || !r.ok) return null;
    return feedBadges(r.inputs, seen, at);
  } catch {
    return null;
  }
}

/**
 * The Activity count and Groups dot for `userId`. `focusedTab` is the tab in front; each change
 * refreshes. Only the newest request applies its answer.
 */
export function useFeedBadges(userId: string, focusedTab?: string): FeedBadgeState {
  const [state, setState] = useState<{ userId: string; badges: FeedBadgeState }>({ userId, badges: NO_FEED_BADGES });
  const latest = useRef(0);
  const seenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSeenRefresh = useCallback(() => {
    if (seenTimer.current !== null) clearTimeout(seenTimer.current);
    seenTimer.current = null;
  }, []);

  const refresh = useCallback(() => {
    // Any refresh reads the seen times as they are now, so a waiting seen refresh is redundant.
    cancelSeenRefresh();
    if (userId === '') return;
    const token = ++latest.current;
    void loadFeedBadges(userId).then((badges) => {
      if (badges === null || token !== latest.current) return;
      setState((prev) =>
        prev.userId === userId && prev.badges.activity === badges.activity && prev.badges.groupsDot === badges.groupsDot
          ? prev
          : { userId, badges },
      );
    });
  }, [cancelSeenRefresh, userId]);

  // Mount, a new user, and every tab change.
  useEffect(() => {
    refresh();
  }, [refresh, focusedTab]);

  // Foreground, and after each seen write; a late answer after unmount is ignored.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    const off = onFeedSeenChange((who) => {
      if (who !== userId) return;
      cancelSeenRefresh();
      seenTimer.current = setTimeout(() => {
        seenTimer.current = null;
        refresh();
      }, FEED_SEEN_REFRESH_DELAY_MS);
    });
    return () => {
      latest.current++;
      cancelSeenRefresh();
      // jest-expo's AppState mock may return no subscription; the real one always does.
      sub?.remove();
      off();
    };
  }, [cancelSeenRefresh, refresh, userId]);

  return state.userId === userId ? state.badges : NO_FEED_BADGES;
}
