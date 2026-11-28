// /account: the Profile screen pushed above the tabs, with a Back header
// (docs/specs/2026-11-28-tab-bar-and-activity.md Task 5, criterion 41, FEED-25). Settle's and
// VenmoPrompt's Venmo links open this, not the Profile tab: switching to a tab would leave Settle
// (it sits above the tabs), and one Back has to bring the person back to where they were.
import { ProfileScreen } from '@/components/ProfileScreen';

export default function AccountScreen() {
  return <ProfileScreen withBack />;
}
