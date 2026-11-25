// IconButton: a 44×44 icon-only control (delete a row, copy, stepper). The label is required: it is
// all a screen reader has. Pressed: a soft circle behind the icon (red-tinted for `danger`).
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { opacity, radius, TOUCH_TARGET, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

type Props = {
  icon: LucideIcon;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  /** `danger` for removing things: the press shows red so the result is clear. */
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({ icon, accessibilityLabel, accessibilityHint, onPress, tone = 'neutral', disabled = false, style }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.button,
        pressed && { backgroundColor: tone === 'danger' ? colors.dangerSurface : colors.surfaceMuted },
        disabled && styles.disabled,
        ringStyle,
        style,
      ]}
    >
      {({ pressed }) => <Icon icon={icon} color={tone === 'danger' && pressed ? colors.danger : colors.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: opacity.disabled },
});
