// Rows for the group expense screen (spec docs/specs/2026-11-26-groups-mvp.md T15): a person you
// include in an equal split (checkbox) and a person who paid (radio). Words and amounts come from
// the screen's lib (lib/groupExpenseForm.ts); these only lay them out. Checked state shows by shape
// (filled box / dot) and weight, never color alone. Rows are at least 44 pt tall.
import Circle from 'lucide-react-native/icons/circle';
import CircleDot from 'lucide-react-native/icons/circle-dot';
import Square from 'lucide-react-native/icons/square';
import SquareCheck from 'lucide-react-native/icons/square-check';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { MoneyText } from '@/components/ui/MoneyText';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { ariaProps } from '@/lib/ariaProps';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type CheckProps = {
  name: string;
  checked: boolean;
  /** The preview share; null when there's nothing to show (left out, or no valid amount yet). */
  cents: number | null;
  accessibilityLabel: string;
  accessibilityHint: string;
  disabled: boolean;
  onToggle: () => void;
  divider: boolean;
};

export function ExpenseCheckRow({ name, checked, cents, accessibilityLabel, accessibilityHint, disabled, onToggle, divider }: CheckProps) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ checked, disabled }}
      // Web: react-native-web drops accessibilityState (lib/ariaProps.ts).
      {...ariaProps({ checked, disabled })}
      disabled={disabled}
      onPress={onToggle}
      {...focusProps}
      style={({ pressed }) => [
        styles.row,
        divider && [styles.divider, { borderTopColor: colors.divider }],
        pressed && { backgroundColor: colors.surfaceMuted },
        disabled && styles.disabled,
        ringStyle && [ringStyle, styles.ringInside],
      ]}
    >
      <Icon icon={checked ? SquareCheck : Square} size="lg" color={checked ? colors.primary : colors.textMuted} />
      <Text style={[type.body, styles.name, { color: checked ? colors.text : colors.textMuted }, checked && styles.checked]}>{name}</Text>
      {cents !== null ? <MoneyText cents={cents} /> : null}
    </Pressable>
  );
}

type RadioProps = {
  name: string;
  checked: boolean;
  disabled: boolean;
  onPick: () => void;
  divider: boolean;
};

export function ExpensePayerRow({ name, checked, disabled, onPick, divider }: RadioProps) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={name}
      accessibilityState={{ checked, disabled }}
      // Web: react-native-web drops accessibilityState (lib/ariaProps.ts).
      {...ariaProps({ checked, disabled })}
      disabled={disabled}
      onPress={onPick}
      {...focusProps}
      style={({ pressed }) => [
        styles.row,
        divider && [styles.divider, { borderTopColor: colors.divider }],
        pressed && { backgroundColor: colors.surfaceMuted },
        disabled && styles.disabled,
        ringStyle && [ringStyle, styles.ringInside],
      ]}
    >
      <Icon icon={checked ? CircleDot : Circle} size="lg" color={checked ? colors.primary : colors.textMuted} />
      <Text style={[type.body, styles.name, { color: colors.text }, checked && styles.checked]}>{name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Rows sit edge to edge in a flush Card, like ListRow.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TOUCH_TARGET + space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, minWidth: 0 },
  checked: { fontWeight: '600' },
  disabled: { opacity: opacity.disabled },
  ringInside: { outlineOffset: -2 },
});
