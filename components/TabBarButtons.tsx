// The tab bar's two kinds of control (components/TabBar.tsx; docs/specs/2026-11-28-tab-bar-and-activity.md
// U1, Contract C "Tab bar"). Kept apart from the bar so they render without a navigator (the web-markup
// test in __tests__/tabBar.test.tsx).
//
// - TabButton: native gets role "tab" + accessibilityState.selected (the bar is the "tablist"); on web,
//   react-native-web drops accessibilityState, so each tab is a link with aria-current="page" when selected.
//   Web keyboard (WCAG 2.1.1): react-native-web leaves Enter on a role="link" to the browser, which
//   only follows a real href, and this div has none; so Enter and Space activate the tab here.
// - AddButton: the raised round (+). Its label says what it opens (react-native-web drops hints).
//   react-native-web renders it as a real <button>, which the browser activates with Enter and Space.
// - Compact (lib/tabBar.ts tabBarLayout, below 300 px wide): no visible labels (the screen-reader
//   labels are unchanged), a count badge is drawn as the dot, and the (+) is 44 pt in its own slot.
import type { LucideIcon } from 'lucide-react-native';
import Plus from 'lucide-react-native/icons/plus';
import { Platform, Pressable, StyleSheet, Text, View, type PressableProps } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { TAB_ADD_SIZE } from '@/lib/tabBar';
import { opacity, radius, shadow, space, tabularNums, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

/** The raised (+) rises this far above the bar's top edge (its size: lib/tabBar.ts tabBarLayout). */
const ADD_RISE = space.lg;
/** Labels stay legible at large text sizes without pushing the bar past the screen (criterion 59). */
const LABEL_MAX_SCALE = 1.4;
/** The badge's digits grow a little with the text size, but never past the icon. */
const BADGE_MAX_SCALE = 1.2;
const BADGE_HEIGHT = 18;
const DOT_SIZE = 12;
const BADGE_RING = 2;

export function TabButton({
  icon,
  label,
  a11yLabel,
  selected,
  badge = null,
  dot = false,
  compact = false,
  testID,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  a11yLabel: string;
  selected: boolean;
  /** Task 7: the count badge's text (badgeText: "1"–"9", "9+"); null = none. */
  badge?: string | null;
  /** Task 7: the Groups dot. Ignored when there is a count badge. */
  dot?: boolean;
  /** The narrow bar (tabBarLayout): icon only, and a count shows as the dot. */
  compact?: boolean;
  testID?: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const tint = selected ? colors.primary : colors.textMuted;
  const web = Platform.OS === 'web';
  // Compact: a count wouldn't fit beside the icon without reaching the next tab; the label still says it.
  const count = compact ? null : badge;
  const showDot = badge !== null ? compact : dot;
  return (
    <Pressable
      accessibilityRole={web ? 'link' : 'tab'}
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected }}
      // Web: react-native-web ignores accessibilityState; aria-current is what it writes to the DOM.
      aria-current={web && selected ? 'page' : undefined}
      testID={testID}
      onPress={onPress}
      {...webLinkKeys(onPress)}
      {...focusProps}
      style={({ pressed }) => [styles.tab, compact && styles.tabCompact, pressed && styles.pressed, ringStyle]}
    >
      <View style={styles.iconBox}>
        <Icon icon={icon} size="lg" color={tint} />
        {/* Task 7: the count badge / Groups dot on the icon's top-right corner. The tab's label
            already says it, so the mark is hidden from screen readers. A ring in the bar's colour
            keeps it apart from the icon. */}
        {count !== null || showDot ? (
          <View
            testID={count !== null ? 'tab-badge' : 'tab-dot'}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
            pointerEvents="none"
            style={[
              count !== null ? styles.badge : styles.dot,
              { backgroundColor: colors.primary, borderColor: colors.surface },
            ]}
          >
            {count !== null ? (
              <Text maxFontSizeMultiplier={BADGE_MAX_SCALE} style={[styles.badgeText, tabularNums, { color: colors.onPrimary }]}>
                {count}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {compact ? null : (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={LABEL_MAX_SCALE}
          // iOS: shrink a label that doesn't fit (a narrow phone at a large text size) rather than cut it.
          adjustsFontSizeToFit
          minimumFontScale={0.8}
          style={[type.caption, selected ? styles.labelSelected : null, { color: tint }]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Web: Enter (a link's key) and Space (what a tab answers to as well) activate the tab. Space must
 * not also scroll the page, and a held key fires once. Native gets nothing: VoiceOver and TalkBack
 * activate through onPress.
 */
function webLinkKeys(onPress: () => void): Partial<PressableProps> {
  if (Platform.OS !== 'web') return {};
  // react-native-web forwards onKeyDown to the DOM element; React Native's types don't list it.
  const onKeyDown = (e: { key: string; repeat?: boolean; preventDefault: () => void }) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    if (e.repeat !== true) onPress();
  };
  return { onKeyDown } as Partial<PressableProps>;
}

export function AddButton({
  a11yLabel,
  size = TAB_ADD_SIZE,
  compact = false,
  onPress,
}: {
  a11yLabel: string;
  /** The circle's size (tabBarLayout's addSize). */
  size?: number;
  /** The narrow bar: the slot is just the circle's width, so the four tabs share the rest. */
  compact?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <View style={compact ? [styles.addSlotCompact, { width: size }] : styles.addSlot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        onPress={onPress}
        {...focusProps}
        style={({ pressed }) => [
          styles.add,
          { width: size, height: size, borderWidth: compact ? 3 : 4 },
          // A ring in the bar's colour lifts the circle off the bar's top edge.
          { backgroundColor: colors.primary, borderColor: colors.surface },
          pressed && styles.pressed,
          ringStyle,
        ]}
      >
        <Icon icon={Plus} size="lg" color={colors.onPrimary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: TOUCH_TARGET + space.xs,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: space.xs,
    borderRadius: radius.sm,
  },
  iconBox: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: -BADGE_HEIGHT / 2 + BADGE_RING,
    left: '55%',
    minWidth: BADGE_HEIGHT,
    height: BADGE_HEIGHT,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    borderWidth: BADGE_RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  dot: {
    position: 'absolute',
    top: -1,
    right: -2,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: radius.pill,
    borderWidth: BADGE_RING,
  },
  // Compact: four icons and the (+) fit in 160 px with no padding to squeeze.
  tabCompact: { paddingHorizontal: 0 },
  labelSelected: { fontWeight: '600' },
  addSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  addSlotCompact: { flexShrink: 0, alignItems: 'center', justifyContent: 'flex-end' },
  add: {
    marginTop: -ADD_RISE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.card,
  },
  pressed: { opacity: opacity.pressed },
});
