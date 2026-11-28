// The group options card's last row, "Delete group" (docs/specs/2026-11-28-delete-group.md T5, C1–C2c).
// Styled like components/ui/ListRow.tsx (which isn't edited for this), with the title in the danger
// colour. When the group can't be deleted yet the row is disabled and shows why as visible text
// (C2a / C2b), and its label says it too (C2c). Every word comes from lib/groupScreenText.ts's
// deleteRowText; this draws it.
//
// Web: react-native-web drops accessibilityState, so the disabled state also goes out as
// aria-disabled (lesson 2026-11-27).
import type { Ref } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { DeleteRowText } from '@/lib/groupScreenText';
import { opacity, ROW_MIN_HEIGHT, space, type, useTheme } from '@/lib/theme';

import { useFocusRing } from './ui/useFocusRing';

type Props = {
  text: DeleteRowText;
  onPress: () => void;
  /** Draw the hairline above the row (it's never the card's first row). */
  divider?: boolean;
  /** For returning focus here when the confirm dialog closes. */
  ref?: Ref<View>;
};

export function DeleteGroupRow({ text, onPress, divider = true, ref }: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const { disabled } = text;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={text.a11yLabel}
      accessibilityHint={text.hint ?? undefined}
      accessibilityState={{ disabled }}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled && { backgroundColor: colors.surfaceMuted },
        ringStyle && [ringStyle, styles.ringInside],
      ]}
    >
      <View style={[styles.content, divider && [styles.divider, { borderTopColor: colors.divider }]]}>
        <Text style={[type.body, { color: colors.danger }, disabled && styles.dim]}>{text.label}</Text>
        {text.caption !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{text.caption}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // ListRow's measurements: 16-pt leading padding, a 56-pt row, the hairline starting at the content edge.
  row: { paddingLeft: space.lg },
  content: {
    minHeight: ROW_MIN_HEIGHT,
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.md,
    paddingRight: space.lg,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  // Only the title dims; the reason under it stays fully readable.
  dim: { opacity: opacity.disabled },
  ringInside: { outlineOffset: -2 },
});
