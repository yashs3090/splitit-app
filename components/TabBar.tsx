// The bottom tab bar (docs/specs/2026-11-28-tab-bar-and-activity.md U1, Task 5): Tabs · Groups · (+) ·
// Activity · Profile, drawn for Expo Router's `Tabs` through its `tabBar` prop
// (app/(app)/(tabs)/_layout.tsx). Slots and labels come from lib/tabBar.ts.
//
// - A tab press follows React Navigation's tab-bar contract: emit `tabPress`, then navigate unless a
//   listener prevented it or the tab is already focused.
// - (+) is not a route. It pushes /scan (the scan screen offers the photo and "Enter items"), with a
//   synchronous ref guard so a double tap in the same tick pushes once. The guard opens again when the
//   tabs come back into focus.
// - Selected state and the (+) look: components/TabBarButtons.tsx.
// - Badges (Task 7): `badges` (lib/tabBar.ts TabBadges) go in the labels and as marks on the icons
//   (TabBarButtons' `TabButton`): a count on Tabs and Activity (badgeText, "9+" past 9), a dot on Groups.
//   `LiveTabBar` is the one the tabs layout uses: it reads them (lib/tabBadges.ts).
// - Narrow widths (QA, criterion 52): below 300 px the bar goes compact (lib/tabBar.ts tabBarLayout),
//   so nothing overlaps down to 160 px (a 375 px window at 200% zoom is 188).
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useFocusEffect, useRouter } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import Bell from 'lucide-react-native/icons/bell';
import CircleUserRound from 'lucide-react-native/icons/circle-user-round';
import Receipt from 'lucide-react-native/icons/receipt';
import UsersRound from 'lucide-react-native/icons/users-round';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddButton, TabButton } from '@/components/TabBarButtons';
import { useSession } from '@/lib/auth';
import { badgeText } from '@/lib/feedRules';
import { NO_TAB_BADGES, tabBarLayout, tabSlots, type TabBadges, type TabRoute } from '@/lib/tabBar';
import { useFeedBadges, useTabsBadge } from '@/lib/tabBadges';
import { layout, space, useTheme } from '@/lib/theme';

const ICONS: Record<TabRoute, LucideIcon> = {
  index: Receipt,
  groups: UsersRound,
  activity: Bell,
  profile: CircleUserRound,
};

type Props = BottomTabBarProps & { badges?: TabBadges };

/** The count mark for a tab (null = none). */
function badgeFor(route: TabRoute, badges: TabBadges): string | null {
  if (route === 'index') return badgeText(badges.tabs);
  if (route === 'activity') return badgeText(badges.activity);
  return null;
}

/** The bar with live badges: the Tabs count Home publishes, and the Activity count and Groups dot. */
export function LiveTabBar(props: BottomTabBarProps) {
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  const tabs = useTabsBadge(myId);
  const feed = useFeedBadges(myId, props.state.routes[props.state.index]?.name);
  return <TabBar {...props} badges={{ tabs, groups: feed.groupsDot, activity: feed.activity }} />;
}

export function TabBar({ state, descriptors, navigation, badges = NO_TAB_BADGES }: Props) {
  const { colors } = useTheme();
  // The same insets every screen reads (the navigator's `insets` prop carries the same values).
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const adding = useRef(false);

  // The (+) guard opens again whenever the tabs are back in front (Back from /scan, or anything else).
  useFocusEffect(
    useCallback(() => {
      adding.current = false;
    }, []),
  );

  const addReceipt = () => {
    if (adding.current) return;
    adding.current = true;
    try {
      router.push('/scan');
    } catch {
      adding.current = false;
    }
  };

  const keyboardUp = useAndroidKeyboardUp();
  // The row is never wider than layout.content, so that's the most width a slot can get.
  const { width } = useWindowDimensions();
  const { compact, addSize } = tabBarLayout(Math.min(width, layout.content));
  const slots = tabSlots(
    state.routes.map((r) => r.name),
    badges,
  );
  const focusedName = state.routes[state.index]?.name;

  // Android resizes the window for the keyboard, which would lift the bar over Profile's Venmo field
  // (the default bar's tabBarHideOnKeyboard; a custom bar has to do it itself). iOS and web overlay it.
  if (keyboardUp) return null;

  return (
    <View
      testID="tab-bar"
      style={[
        styles.bar,
        { backgroundColor: colors.surface, borderTopColor: colors.divider, paddingBottom: Math.max(insets.bottom, space.sm) },
      ]}
    >
      <View accessibilityRole={Platform.OS === 'web' ? undefined : 'tablist'} style={styles.row}>
        {slots.map((slot) => {
          if (slot.kind === 'add') {
            return <AddButton key="add" a11yLabel={slot.a11yLabel} size={addSize} compact={compact} onPress={addReceipt} />;
          }
          const route = state.routes.find((r) => r.name === slot.route);
          if (route === undefined) return null;
          const selected = focusedName === slot.route;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!selected && !event.defaultPrevented) navigation.navigate(route.name, route.params);
          };
          return (
            <TabButton
              key={route.key}
              icon={ICONS[slot.route]}
              label={slot.label}
              a11yLabel={slot.a11yLabel}
              selected={selected}
              badge={badgeFor(slot.route, badges)}
              dot={slot.route === 'groups' && badges.groups}
              compact={compact}
              testID={descriptors[route.key]?.options.tabBarButtonTestID}
              onPress={onPress}
            />
          );
        })}
      </View>
    </View>
  );
}

/** True while the Android keyboard is up; always false elsewhere. */
function useAndroidKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setUp(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setUp(false));
    return () => {
      // jest-expo's Keyboard mock may return no subscription; the real one always does.
      show?.remove();
      hide?.remove();
    };
  }, []);
  return up;
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.xs },
  row: { flexDirection: 'row', alignItems: 'flex-end', width: '100%', maxWidth: layout.content, alignSelf: 'center' },
});
