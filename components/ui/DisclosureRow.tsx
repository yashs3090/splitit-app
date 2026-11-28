// DisclosureRow: a section label that shows and hides the group under it ("Settled (5)  Show ⌄").
// Spec: docs/specs/2026-11-26-home-groups-v2.md, amendment A1.M1 / S1 / S6 / S8.
//
// The label reads like a SectionHeader (type.section, textMuted, the same 4-pt inset); the action
// on the right is the app's one disclosure language (SharesSummary's toggle): a teal Show/Hide word
// and a down/up chevron. Never ChevronRight: on Home that means "opens a screen".
// It's a button, not a header: React Native gives an element one role, and the expanded state
// needs the button. The word and chevron aren't announced; `expanded` and the hint say it.
// No animation: the content under it appears and goes at once; pressed opacity is the feedback.
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

type Props = {
  /** The visible label, e.g. "Settled (5)". */
  label: string;
  /** What a screen reader says instead, e.g. "Settled, 5 bills". */
  a11yLabel: string;
  open: boolean;
  onToggle: () => void;
  /** The hint while closed (what opening does), and while open. */
  showHint: string;
  hideHint: string;
  /** The visible action word while closed ("Show") and while open ("Hide"). */
  showText: string;
  hideText: string;
  /**
   * Quiet: the Show/Hide word and chevron in textMuted at the regular weight instead of teal, for a
   * screen where teal marks each row's next step (Home, HOME-POLISH-1). Still a 44-pt button.
   */
  quiet?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * A1.S1: the 44-pt target overlaps the gaps above and below by this much, so the label sits on the
 * section-heading grid (24 pt under the previous card, 8 pt over its own) like every SectionHeader.
 */
export const DISCLOSURE_ROW_MARGIN = -(TOUCH_TARGET - type.section.lineHeight) / 2;

export function DisclosureRow({ label, a11yLabel, open, onToggle, showHint, hideHint, showText, hideText, quiet = false, style }: Props) {
  const { colors } = useTheme();
  const actionColor = quiet ? colors.textMuted : colors.primary;
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={open ? hideHint : showHint}
      accessibilityState={{ expanded: open }}
      // Review R1: react-native-web 0.21 drops accessibilityState, so web gets no aria-expanded from
      // it. The aria prop reaches the DOM on web and maps to the same state on native.
      aria-expanded={open}
      onPress={onToggle}
      {...focusProps}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, ringStyle, style]}
    >
      <Text style={[type.section, styles.label, { color: colors.textMuted }]}>{label}</Text>
      {/* aria-hidden for web, where react-native-web ignores the other two hiding props. */}
      <View accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden aria-hidden style={styles.action}>
        <Text style={[type.caption, !quiet && styles.actionText, { color: actionColor }]}>{open ? hideText : showText}</Text>
        <Icon icon={open ? ChevronUp : ChevronDown} size="sm" color={actionColor} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TOUCH_TARGET,
    // SectionHeader's inset, on both ends.
    paddingHorizontal: space.xs,
    marginVertical: DISCLOSURE_ROW_MARGIN,
    // Only the focus ring shows this shape.
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  // Wraps at large text sizes instead of pushing the action off the row.
  label: { flex: 1, minWidth: 0 },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  // Weight 600 keeps teal caption text above 4.5:1 on the table grey in light mode (4.97). The quiet
  // textMuted word needs no weight: 6.87:1 light, 8.87:1 dark on the table grey.
  actionText: { fontWeight: '600' },
  pressed: { opacity: opacity.pressed },
});
