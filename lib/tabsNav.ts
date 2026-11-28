// "Home" from a screen pushed above the tabs (docs/specs/2026-11-28-tab-bar-and-activity.md Task 5,
// criteria 29 and 33): pop the (app) stack back to the tab navigator, keeping whichever tab was in
// front (Tabs, Groups or Activity). `dismissTo('/')` would switch the tabs to Tabs on the way.
// With nothing below to go back to (a screen that replaced its way in, e.g. /g/<code> → the group),
// open the tabs instead, which land on Tabs.
import type { ImperativeRouter } from 'expo-router';

export function backToTabs(router: Pick<ImperativeRouter, 'canDismiss' | 'dismissAll' | 'replace'>): void {
  if (router.canDismiss()) router.dismissAll();
  else router.replace('/');
}
