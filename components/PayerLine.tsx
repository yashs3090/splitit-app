// The quiet "Paid by …" line (spec docs/specs/2026-11-26-who-paid.md D6 as amended by A1.5 and A2,
// Task 9): on the bill screen under "Total $X", above "Edit items"; Settle up reuses it (Task 10).
//
// Renders lib/payers.ts's paidByLine model and builds no strings. Host: the whole line is one
// button ("Paid by Priya · Change", label "Paid by Priya. Change who paid", hint "Opens who paid"),
// at least 44 pt tall, no hitSlop. Stale: the TriangleAlert icon and warning tone, with words (not
// colour alone). Others: plain text. The text wraps at large Dynamic Type; amounts never truncate.
// It never navigates on its own: the screen passes onPress.
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import type { PaidByLine } from '@/lib/payers';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  /** From paidByLine(); null draws nothing (e.g. the stored rows didn't read). */
  line: PaidByLine | null;
  /** The host's Change / Fix: the screen opens /bills/<id>/payers. Ignored when line.action is null. */
  onPress: () => void;
};

export function PayerLine({ line, onPress }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  if (line === null) return null;

  const fg = line.tone === 'warning' ? colors.warning : colors.textMuted;
  const icon = line.icon === 'warning' ? <Icon icon={TriangleAlert} size="sm" color={colors.warning} /> : null;

  if (line.action === null || line.actionLabel === null) {
    return (
      <View style={styles.row}>
        {icon}
        <Text style={[type.body, styles.text, { color: fg }]}>{line.text}</Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={line.a11yLabel}
      accessibilityHint={line.a11yHint ?? undefined}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.row, styles.button, pressed && styles.pressed, ringStyle]}
    >
      {icon}
      <Text style={[type.body, styles.text, { color: fg }]}>
        {line.text}
        {/* The "·" is decorative; the label above carries the meaning. */}
        <Text style={{ color: colors.textMuted }}>{' · '}</Text>
        <Text style={[styles.action, { color: colors.primary }]}>{line.actionLabel}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  button: { minHeight: TOUCH_TARGET, alignSelf: 'flex-start' },
  // Wraps instead of truncating (D12).
  text: { flexShrink: 1 },
  action: { fontWeight: '600' },
  pressed: { opacity: opacity.pressed },
});
