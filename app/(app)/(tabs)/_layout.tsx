// The tab navigator (docs/specs/2026-11-28-tab-bar-and-activity.md U1, Task 5): Tabs (Home) · Groups ·
// (+) · Activity · Profile. The bar is ours (components/TabBar.tsx); (+) is in it, not a route.
// Everything else (bills, groups/<id>, groups/new, scan, the new-bill form, /account) is pushed on the
// (app) stack above this navigator, so it shows without the bar and Back returns to the tab it came from.
// `title` names the browser tab on web; the screens draw their own headings (no navigator header).
import Tabs from 'expo-router/js-tabs';

import { LiveTabBar } from '@/components/TabBar';
import { TAB_COPY } from '@/lib/feedText';
import { useTheme } from '@/lib/theme';

export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      tabBar={(props) => <LiveTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      <Tabs.Screen name="index" options={{ title: 'SplitIt' }} />
      <Tabs.Screen name="groups" options={{ title: TAB_COPY.groups }} />
      <Tabs.Screen name="activity" options={{ title: TAB_COPY.activity }} />
      <Tabs.Screen name="profile" options={{ title: TAB_COPY.profile }} />
    </Tabs>
  );
}
