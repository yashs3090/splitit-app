// The bottom tab bar's slots and labels (docs/specs/2026-11-28-tab-bar-and-activity.md U1, Contract C
// "Tab bar", Task 5). Pure: components/TabBar.tsx draws what this returns. The words themselves are
// TAB_COPY and the *TabLabel functions in lib/feedText.ts (one place for the copy).
//
// Five slots: Tabs · Groups · (+) · Activity · Profile. (+) is not a route: it opens /scan.

import { activityTabLabel, groupsTabLabel, TAB_COPY, tabsTabLabel } from './feedText';

/** The tab routes in app/(app)/(tabs)/, in bar order. */
export const TAB_ROUTES = ['index', 'groups', 'activity', 'profile'] as const;
export type TabRoute = (typeof TAB_ROUTES)[number];

export function isTabRoute(name: string): name is TabRoute {
  return (TAB_ROUTES as readonly string[]).includes(name);
}

/**
 * The badge facts the bar shows (Task 7 fills these in: lib/tabBadges.ts and useFeedBadges). Until
 * then every tab passes NO_TAB_BADGES and the labels are the plain tab names.
 */
export type TabBadges = {
  /** Bills not settled (tabsBadgeCount); 0 = no badge. */
  tabs: number;
  /** The Groups dot (groupsDot). */
  groups: boolean;
  /** Unread places in Activity; 0 = no badge. */
  activity: number;
};
export const NO_TAB_BADGES: TabBadges = { tabs: 0, groups: false, activity: 0 };

export type TabSlot = { kind: 'tab'; route: TabRoute; label: string; a11yLabel: string } | { kind: 'add'; a11yLabel: string };

/** The visible label for a tab. */
export function tabLabel(route: TabRoute): string {
  switch (route) {
    case 'index':
      return TAB_COPY.tabs;
    case 'groups':
      return TAB_COPY.groups;
    case 'activity':
      return TAB_COPY.activity;
    case 'profile':
      return TAB_COPY.profile;
  }
}

/** What a screen reader says for a tab: the badge goes in the label, because react-native-web drops hints. */
export function tabA11yLabel(route: TabRoute, badges: TabBadges): string {
  switch (route) {
    case 'index':
      return tabsTabLabel(badges.tabs);
    case 'groups':
      return groupsTabLabel(badges.groups);
    case 'activity':
      return activityTabLabel(badges.activity);
    case 'profile':
      return TAB_COPY.profile;
  }
}

/**
 * The bar's slots for the navigator's routes, in the navigator's order, with (+) right after Groups.
 * Routes that aren't tabs are left out. If Groups is missing, (+) goes in the middle.
 */
export function tabSlots(routeNames: readonly string[], badges: TabBadges): TabSlot[] {
  const tabs: TabSlot[] = routeNames.filter(isTabRoute).map((route) => ({
    kind: 'tab',
    route,
    label: tabLabel(route),
    a11yLabel: tabA11yLabel(route, badges),
  }));
  const add: TabSlot = { kind: 'add', a11yLabel: TAB_COPY.addLabel };
  const groupsAt = tabs.findIndex((s) => s.kind === 'tab' && s.route === 'groups');
  const at = groupsAt >= 0 ? groupsAt + 1 : Math.ceil(tabs.length / 2);
  return [...tabs.slice(0, at), add, ...tabs.slice(at)];
}

/** The raised (+)'s size on the full bar, and on the compact bar (still a full touch target). */
export const TAB_ADD_SIZE = 56;
export const TAB_ADD_SIZE_COMPACT = 44;
/**
 * Below this bar width (CSS px on web, points on phones) the bar goes compact. 300 sits under every
 * phone (320 and up) and over a 375 px window at 200% zoom (188), where the labels cut off and the
 * 56-pt (+) overlapped its neighbours (QA, criterion 52).
 */
export const TAB_BAR_COMPACT_BELOW = 300;

export type TabBarLayout = {
  /** No visible labels (screen-reader labels unchanged), counts drawn as dots, the (+) in its own narrow slot. */
  compact: boolean;
  addSize: number;
};

/** How the bar draws at this width. A width that isn't known yet (0, NaN) gets the full bar. */
export function tabBarLayout(width: number): TabBarLayout {
  const compact = Number.isFinite(width) && width > 0 && width < TAB_BAR_COMPACT_BELOW;
  return { compact, addSize: compact ? TAB_ADD_SIZE_COMPACT : TAB_ADD_SIZE };
}
