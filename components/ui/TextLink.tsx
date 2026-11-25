// TextLink: a quiet text action inside a form or card ("Add note", "Tip options", "Make a new link"),
// with a full 44-pt touch target. One step quieter than a ghost Button: caption size, primary color.
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

type Props = {
  label: string;
  onPress: () => void;
  /** Defaults to the visible label; pass one when the label needs context ("Add note to item 2"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Optional leading icon (e.g. Plus), 16 pt, in the link color. */
  icon?: LucideIcon;
  style?: StyleProp<ViewStyle>;
};

export function TextLink({ label, onPress, accessibilityLabel, accessibilityHint, icon, style }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.link, pressed && styles.pressed, ringStyle, style]}
    >
      {icon ? <Icon icon={icon} size="sm" color={colors.primary} /> : null}
      <Text style={[type.caption, styles.text, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: {
    minHeight: TOUCH_TARGET,
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
});
