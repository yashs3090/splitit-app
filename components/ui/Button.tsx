// Button: primary (one per screen, solid teal), secondary (tonal: teal tint, no outline), ghost
// (text only), danger (tonal red). Outlines are for inputs only (visual pass V6).
import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { opacity, radius, space, TOUCH_TARGET, type, useTheme, type Palette } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

type Props = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Icon before the label (e.g. Plus), in the label's color; hidden from screen readers. */
  icon?: LucideIcon;
  /**
   * No side padding (the label sits on the column edge); keeps the 44 × 44 minimum box.
   * `true` centres the label in that box (as before); 'start' / 'end' put it on the leading /
   * trailing edge, so a short label ("Yes", "Undo") lines up with the column instead of sitting
   * up to 8 pt in. Card ghost rows use 'start', row controls 'end'.
   */
  flush?: boolean | 'start' | 'end';
  accessibilityLabel?: string;
  /** Said after the label when the result (or why it's disabled) isn't obvious. */
  accessibilityHint?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Stretch to the container's width. */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
};

function variantColors(c: Palette, variant: ButtonVariant): { bg: string; fg: string; border: string } {
  switch (variant) {
    case 'primary':
      return { bg: c.primary, fg: c.onPrimary, border: c.primary };
    case 'secondary':
      return { bg: c.primarySurface, fg: c.primary, border: 'transparent' };
    case 'ghost':
      return { bg: 'transparent', fg: c.primary, border: 'transparent' };
    case 'danger':
      return { bg: c.dangerSurface, fg: c.danger, border: 'transparent' };
  }
}

export function Button({
  label,
  onPress,
  variant = 'secondary',
  icon,
  flush = false,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  loading = false,
  block = false,
  style,
}: Props) {
  const { colors } = useTheme();
  const v = variantColors(colors, variant);
  const inactive = disabled || loading;
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      // Web (QA F1): react-native-web drops accessibilityState; these reach the DOM (only when true).
      aria-busy={loading || undefined}
      aria-disabled={inactive || undefined}
      disabled={inactive}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: v.bg, borderColor: v.border },
        block ? styles.block : styles.inline,
        flush && styles.flush,
        pressed && styles.pressed,
        inactive && styles.inactive,
        ringStyle,
        style,
      ]}
    >
      <View style={[styles.content, flush === 'start' && styles.contentStart, flush === 'end' && styles.contentEnd]}>
        {loading ? <ActivityIndicator size="small" color={v.fg} /> : null}
        {icon && !loading ? <Icon icon={icon} color={v.fg} /> : null}
        <Text style={[type.label, styles.label, flush === 'start' && styles.labelStart, flush === 'end' && styles.labelEnd, { color: v.fg }]}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    borderWidth: 1,
    justifyContent: 'center',
  },
  inline: { alignSelf: 'flex-start' },
  block: { alignSelf: 'stretch' },
  flush: { paddingHorizontal: 0, minWidth: TOUCH_TARGET },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  // Long labels ("Pay Hana Lee-Watanabe $1.10 more on Venmo") wrap inside the button, centered.
  label: { flexShrink: 1, textAlign: 'center' },
  // flush 'start' / 'end'. The app is left-to-right only today; check the textAlign pair under
  // RTL if RTL is ever added (flex-start / flex-end follow the layout direction).
  contentStart: { justifyContent: 'flex-start' },
  contentEnd: { justifyContent: 'flex-end' },
  labelStart: { textAlign: 'left' },
  labelEnd: { textAlign: 'right' },
  pressed: { opacity: opacity.pressed },
  inactive: { opacity: opacity.disabled },
});
