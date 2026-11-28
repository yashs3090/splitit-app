// Router-test helpers for the bottom tab bar (docs/specs/2026-11-28-tab-bar-and-activity.md Task 6).
// The bar is on every tab, and on web its tabs are links, so screen-wide queries ("every link on
// Home") pick them up. `outsideTabBar` keeps a screen's own elements only.
import type { ReactTestInstance } from 'react-test-renderer';

/** components/TabBar.tsx's outer View. */
export const TAB_BAR_TEST_ID = 'tab-bar';

export function inTabBar(node: ReactTestInstance): boolean {
  for (let cur: ReactTestInstance | null = node; cur !== null; cur = cur.parent) {
    if (cur.props.testID === TAB_BAR_TEST_ID) return true;
  }
  return false;
}

export function outsideTabBar<T extends ReactTestInstance>(nodes: readonly T[]): T[] {
  return nodes.filter((n) => !inTabBar(n));
}

/**
 * A `@/lib/tabBadges` mock body for router tests about a screen, not the badges: the bar's Activity
 * and Groups reads (useFeedBadges, Task 7) would add RPCs to the screen's call log, so they return no
 * badges. The Tabs count stays real (it reads nothing). The badges themselves are tested in
 * lib/tabBadges.test.ts and __tests__/tabBar.test.tsx.
 *
 *   jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
 */
export function quietFeedBadges(): typeof import('@/lib/tabBadges') {
  const actual = jest.requireActual<typeof import('@/lib/tabBadges')>('@/lib/tabBadges');
  return { ...actual, useFeedBadges: () => actual.NO_FEED_BADGES };
}

/** A tab's accessibility label starts with its name ("Tabs", "Tabs, 2 open bills"). */
export function tabNamed(name: string): RegExp {
  return new RegExp(`^${name}(,|$)`);
}
