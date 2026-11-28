// One group to choose on "Add to a group" (app/(app)/bills/[id]/group.tsx, groups T17): a radio row
// with the group's name and member count, edge to edge in a flush Card. Checked shows by shape (dot)
// and weight, not color alone. The state goes out as accessibilityState for native and as aria-*
// for react-native-web, which reads only those (lib/ariaProps.ts). At least 44 pt tall.
import Circle from 'lucide-react-native/icons/circle';
import CircleDot from 'lucide-react-native/icons/circle-dot';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { ariaProps } from '@/lib/ariaProps';
import { groupChoiceA11yLabel } from '@/lib/billGroup';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

export type GroupChoiceRowProps = { name: string; caption: string; checked: boolean; disabled: boolean; divider: boolean; onPick: () => void };

/** One group to choose: a radio with the name and member count. Checked shows by shape and weight. */
export function GroupChoiceRow({ name, caption, checked, disabled, divider, onPick }: GroupChoiceRowProps) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={groupChoiceA11yLabel(name, caption)}
      accessibilityState={{ checked, disabled }}
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
      <View style={styles.flex}>
        <Text style={[type.body, { color: colors.text }, checked && styles.checked]}>{name}</Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>{caption}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: TOUCH_TARGET + space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  flex: { flex: 1, minWidth: 0 },
  checked: { fontWeight: '600' },
  disabled: { opacity: opacity.disabled },
  ringInside: { outlineOffset: -2 },
});
