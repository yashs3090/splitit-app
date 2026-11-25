// ChoiceCard: one of a few equal, large choices (the scan screen's "Take photo" / "Enter items").
// Spec: docs/specs/2026-11-25-scan-screen-redesign.md. Presentational only: no logic, fixed copy comes in.
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { iconSize, radius, shadow, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  /** Visible title and the screen-reader label. */
  title: string;
  /** One line under the title; also the screen-reader hint (what pressing does). */
  hint: string;
  icon: LucideIcon;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
};

/** The icon's soft circle: twice the large icon size (48). */
const BADGE = iconSize.lg * 2;

export function ChoiceCard({ title, hint, icon, onPress, style }: Props) {
  const { colors } = useTheme();
  // Keyboard focus ring (web keyboard focus, hardware keyboards); press feedback comes from the style function.
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.divider },
        ringStyle,
        style,
      ]}
    >
      <View
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={[styles.badge, { backgroundColor: colors.primarySurface }]}
      >
        <Icon icon={icon} size="lg" color={colors.primary} />
      </View>
      <Text style={[type.headline, styles.center, { color: colors.text }]}>{title}</Text>
      <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{hint}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    boxShadow: shadow.card,
  },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  center: { textAlign: 'center' },
});
