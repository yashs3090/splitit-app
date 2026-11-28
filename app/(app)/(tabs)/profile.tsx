// The Profile tab (route /profile): the Profile screen with no back control
// (docs/specs/2026-11-28-tab-bar-and-activity.md Task 5, criterion 30). The screen itself is
// components/ProfileScreen.tsx, shared with /account.
import { ProfileScreen } from '@/components/ProfileScreen';

export default function ProfileTab() {
  return <ProfileScreen withBack={false} />;
}
