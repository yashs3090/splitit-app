// The native stack header for a pushed screen (visual pass V8, proposal P1). The bar is the system
// one (safe area, placement, back-swipe); it carries only our back control. The screen keeps its
// own 22-pt title in the content (once per screen, with its subtitle lines), so the bar's title
// stays empty and `title` only names the browser tab on web.
//
// Back behavior stays the screen's: each screen passes the handler its old "‹ …" button used
// (e.g. `router.dismissTo(bill)`, which also works on a cold deep link with no history, where a
// plain native back button wouldn't appear). Pass no `back` in states that had no back control
// (loading, errors) so the bar is there in every state and nothing jumps when it loads.
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import { Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

export type BackAction = {
  /** Visible text after the chevron ("Bill", "Back"). */
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  disabled?: boolean;
};

export function HeaderBack({ label, accessibilityLabel, accessibilityHint, onPress, disabled = false }: BackAction) {
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
      style={({ pressed }) => [styles.back, pressed && styles.pressed, disabled && styles.disabled, ringStyle]}
    >
      {/* The chevron's stroke starts ~6 pt inside its box; pulling it left lines it up with the column edge. */}
      <Icon icon={ChevronLeft} size="lg" color={colors.primary} style={styles.chevron} />
      <Text style={[type.body, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

/** `right`: one optional quiet action at the bar's trailing edge (e.g. the bill's "Activity"). */
export function BackHeader({ title, back, right }: { title: string; back?: BackAction; right?: ReactNode }) {
  return (
    <Stack.Screen
      options={{
        headerShown: true,
        title,
        headerTitle: '',
        headerBackVisible: false,
        headerLeft: back ? () => <HeaderBack {...back} /> : () => null,
        headerRight: right ? () => right : undefined,
      }}
    />
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: 'row', alignItems: 'center', minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET, paddingRight: space.sm },
  chevron: { marginLeft: -6 },
  pressed: { opacity: opacity.pressed },
  disabled: { opacity: opacity.disabled },
});
