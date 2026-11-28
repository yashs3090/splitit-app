// TextLink: a quiet text action inside a form or card ("Add note", "Tip options", "Make a new link"),
// with a full 44 × 44 touch target (the label stays leading). One step quieter than a ghost Button:
// caption size, primary color. `disabled` dims it and blocks presses; `loading` also shows a small
// spinner in place of the icon (e.g. "Not received" while that row's write is in flight).
// Web (QA F1): react-native-web drops accessibilityState, so the same state also goes out as aria-*
// (expanded, busy, disabled); lib/ariaProps.ts.
import type { LucideIcon } from 'lucide-react-native';
import type { Ref } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type AccessibilityState, type StyleProp, type View, type ViewStyle } from 'react-native';

import { ariaProps } from '@/lib/ariaProps';
import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

type Props = {
  label: string;
  onPress: () => void;
  /** Defaults to the visible label; pass one when the label needs context ("Add note to item 2"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** E.g. `{ expanded }` when the link shows and hides something ("Show QR code"). */
  accessibilityState?: AccessibilityState;
  /** Optional leading icon (e.g. Plus), 16 pt, in the link color. */
  icon?: LucideIcon;
  /** Dimmed (opacity.disabled), not pressable, announced as disabled. */
  disabled?: boolean;
  /** Disabled plus a small primary spinner before the label, announced as busy. */
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  /** The pressable, e.g. so focus can return to "Show QR code" when its popup closes (React 19 ref prop). */
  ref?: Ref<View>;
};

export function TextLink({
  label,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  icon,
  disabled = false,
  loading = false,
  style,
  ref,
}: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const inactive = disabled || loading;
  // Unchanged unless loading; Pressable adds `disabled` itself from the prop below.
  const state = loading ? { ...accessibilityState, busy: true } : accessibilityState;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={state}
      {...ariaProps(state)}
      aria-disabled={inactive || undefined}
      // Undefined when active, so existing links' accessibilityState stays exactly as the caller set it.
      disabled={inactive || undefined}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.link, pressed && styles.pressed, inactive && styles.inactive, ringStyle, style]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.primary} /> : null}
      {icon && !loading ? <Icon icon={icon} size="sm" color={colors.primary} /> : null}
      <Text style={[type.caption, styles.text, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: {
    minHeight: TOUCH_TARGET,
    // Short labels still get a 44-wide target; the label stays leading (no justifyContent).
    minWidth: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    // Only the focus ring shows this shape.
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  text: { fontWeight: '600' },
  pressed: { opacity: opacity.pressed },
  inactive: { opacity: opacity.disabled },
});
