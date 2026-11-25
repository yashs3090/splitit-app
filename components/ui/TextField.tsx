// TextField: an input with an optional visible label, a prefix (e.g. "$"), a hint and an error.
// The error is words (never color only) and is announced as an alert. A caller that shows the
// error elsewhere (`invalid`) passes its text as `accessibilityHint` so the input still announces it.
import { useState, type Ref } from 'react';
import { Platform, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';

import { radius, space, tabularNums, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = Omit<TextInputProps, 'style'> & {
  /** Accessibility label; also the visible label when `showLabel` is set. */
  label: string;
  showLabel?: boolean;
  prefix?: string;
  hint?: string;
  error?: string;
  /** Red ring without error text (the caller shows the message elsewhere, e.g. under a row). */
  invalid?: boolean;
  /** Right-align and use tabular numerals (money, quantities). */
  numeric?: boolean;
  /** Smaller, quieter input (e.g. an item note). */
  subtle?: boolean;
  /** Larger, bold text (the bill total). */
  large?: boolean;
  ref?: Ref<TextInput>;
  style?: StyleProp<ViewStyle>;
};

export function TextField({ label, showLabel = false, prefix, hint, error, invalid = false, numeric = false, subtle = false, large = false, ref, style, onFocus, onBlur, accessibilityHint, ...input }: Props) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  const bad = invalid || Boolean(error);
  const borderColor = bad ? colors.danger : focused ? colors.focus : colors.border;
  return (
    <View style={[styles.wrap, style]}>
      {showLabel ? <Text style={[type.caption, styles.label, { color: colors.textMuted }]}>{label}</Text> : null}
      <View
        style={[
          styles.box,
          subtle && styles.subtleBox,
          { borderColor, backgroundColor: subtle ? colors.surfaceMuted : colors.surface },
          (focused || bad) && styles.emphasis,
        ]}
      >
        {prefix ? (
          <Text accessible={false} importantForAccessibility="no" style={[large ? type.title : type.body, { color: colors.textMuted }]}>
            {prefix}
          </Text>
        ) : null}
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={accessibilityHint ?? error ?? hint}
          placeholderTextColor={colors.textMuted}
          autoCorrect={false}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[
            subtle ? type.caption : large ? type.title : type.body,
            styles.input,
            { color: colors.text },
            numeric && [tabularNums, styles.numeric],
            // The box draws its own focus ring, so drop the browser's outline on web.
            Platform.OS === 'web' && styles.noOutline,
          ]}
          {...input}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontWeight: '600' },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderRadius: radius.sm,
  },
  subtleBox: { minHeight: 36 },
  // A 2-pt ring on focus/error; padding shrinks by 1 so the text doesn't jump.
  emphasis: { borderWidth: 2, paddingHorizontal: space.md - 1 },
  input: { flex: 1, minWidth: 0, paddingVertical: space.sm },
  numeric: { textAlign: 'right' },
  noOutline: { outlineWidth: 0 },
});
