// Tip chips under the Tip field: 15% / 18% / 20% / 25% and Custom (a % | $ switch + input).
// Backlog item 1 (docs/backlog.md). Rendering only: the base, the % → cents rounding and how the
// total follows the tip all live in lib/billDraft.ts and lib/money.ts. Each chip shows the dollar
// amount it works out to; picking one dispatches `setTip` with that amount.
import { useState, type Dispatch, type Ref } from 'react';
import { Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';

import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TextField } from '@/components/ui/TextField';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { TIP_PRESETS, tipBaseCents, tipCents, tipForPercent, tipPresets, type BillDraft, type DraftAction } from '@/lib/billDraft';
import { formatCents, formatCentsInput, formatPercent, parseMoneyInput, parsePercentInput } from '@/lib/money';
import { opacity, radius, space, tabularNums, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

export const TIP_NO_BASE_COPY = 'Add the items or the subtotal to use a %.';
export const TIP_PERCENT_ERROR = 'Enter a percent like 18 or 18.5.';
export const TIP_AMOUNT_ERROR = 'Enter an amount like 12.99.';

type Mode = 'percent' | 'dollars';

type Props = {
  draft: BillDraft;
  dispatch: Dispatch<DraftAction>;
  customRef?: Ref<TextInput>;
  onCustomSubmit?: () => void;
};

export function TipOptions({ draft, dispatch, customRef, onCustomSubmit }: Props) {
  const { colors } = useTheme();
  const [customOpen, setCustomOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('percent');
  const [customText, setCustomText] = useState('');

  const presets = tipPresets(draft);
  const base = tipBaseCents(draft);
  const current = tipCents(draft);
  const setTip = (cents: number | null) => dispatch({ type: 'setTip', value: cents === null ? '' : formatCentsInput(cents) });

  // What the custom input works out to: cents, blank, or an error to show.
  const custom = ((): { cents: number } | { blank: true } | { error: string } => {
    if (customText.trim() === '') return { blank: true };
    if (mode === 'dollars') {
      const cents = parseMoneyInput(customText);
      return cents === null ? { error: TIP_AMOUNT_ERROR } : { cents };
    }
    const pct = parsePercentInput(customText);
    if (pct === null) return { error: TIP_PERCENT_ERROR };
    const cents = tipForPercent(draft, pct);
    return cents === null ? { error: TIP_NO_BASE_COPY } : { cents };
  })();

  const onCustomChange = (text: string) => {
    setCustomText(text);
    if (text.trim() === '') return setTip(null);
    if (mode === 'dollars') {
      const cents = parseMoneyInput(text);
      if (cents !== null) setTip(cents);
      return;
    }
    const pct = parsePercentInput(text);
    const cents = pct === null ? null : tipForPercent(draft, pct);
    if (cents !== null) setTip(cents);
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setCustomText('');
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        {TIP_PRESET_CHIPS(presets).map(({ hundredths, cents }) => {
          const selected = !customOpen && cents !== null && current !== null && current > 0 && current === cents;
          const pct = formatPercent(hundredths);
          return (
            <Chip
              key={hundredths}
              accessibilityLabel={`Tip ${pct.replace('%', ' percent')}${cents === null ? '' : `, ${formatCents(cents)}`}`}
              accessibilityHint={selected ? 'Removes the tip.' : undefined}
              selected={selected}
              disabled={cents === null}
              onPress={() => {
                if (cents === null) return;
                setCustomOpen(false);
                setTip(selected ? null : cents);
              }}
              top={pct}
              bottom={cents === null ? '–' : formatCents(cents)}
            />
          );
        })}
        <Chip
          accessibilityLabel="Custom tip"
          accessibilityHint={customOpen ? undefined : 'Enter your own percent or amount.'}
          selected={customOpen}
          onPress={() => setCustomOpen((open) => !open)}
          top="Custom"
        />
      </View>

      {customOpen ? (
        <View style={styles.customRow}>
          <SegmentedControl
            options={[
              { value: 'percent', label: '%', accessibilityLabel: 'Custom tip in percent' },
              { value: 'dollars', label: '$', accessibilityLabel: 'Custom tip in dollars' },
            ]}
            value={mode}
            onChange={switchMode}
          />
          <TextField
            ref={customRef}
            label={mode === 'percent' ? 'Custom tip percent' : 'Custom tip amount'}
            placeholder={mode === 'percent' ? '18' : '0.00'}
            prefix={mode === 'dollars' ? '$' : undefined}
            keyboardType="decimal-pad"
            numeric
            value={customText}
            onChangeText={onCustomChange}
            invalid={'error' in custom}
            accessibilityHint={'error' in custom ? custom.error : undefined}
            autoFocus
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={onCustomSubmit}
            style={styles.flex}
          />
          {mode === 'percent' ? (
            <Text style={[type.body, tabularNums, styles.equals, { color: colors.text }]}>
              {'cents' in custom ? `= ${formatCents(custom.cents)}` : '= –'}
            </Text>
          ) : null}
        </View>
      ) : null}

      {customOpen && 'error' in custom ? (
        <Text accessibilityRole="alert" style={[type.caption, styles.right, { color: colors.danger }]}>
          {custom.error}
        </Text>
      ) : base === null ? (
        <Text style={[type.caption, styles.right, { color: colors.textMuted }]}>{TIP_NO_BASE_COPY}</Text>
      ) : (
        <Text style={[type.caption, styles.right, { color: colors.textMuted }]}>{`% of ${formatCents(base)}, before tax`}</Text>
      )}
    </View>
  );
}

/** The chips to draw: with their amounts, or (no base yet) disabled with no amount. */
const TIP_PRESET_CHIPS = (presets: ReturnType<typeof tipPresets>): { hundredths: number; cents: number | null }[] =>
  presets ?? TIP_PRESETS.map((hundredths) => ({ hundredths, cents: null }));

function Chip({
  top,
  bottom,
  selected,
  disabled = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  top: string;
  bottom?: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.chip,
        // Tonal, no outline (outlines are for inputs). Selected is solid teal (≥5:1 against the card
        // and the muted chips) and heavier, so it reads by more than hue.
        { backgroundColor: selected ? colors.primary : colors.surfaceMuted },
        pressed && styles.pressed,
        disabled && styles.disabled,
        ringStyle,
      ]}
    >
      <Text style={[type.caption, { color: selected ? colors.onPrimary : colors.text, fontWeight: selected ? '700' : '600' }]}>
        {top}
      </Text>
      {bottom !== undefined ? (
        <Text style={[type.caption, tabularNums, { color: selected ? colors.onPrimary : colors.textMuted }]}>{bottom}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    flexGrow: 1,
    flexBasis: 56,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xs,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  equals: { minWidth: 72, textAlign: 'right' },
  right: { textAlign: 'right' },
  pressed: { opacity: opacity.pressed },
  disabled: { opacity: opacity.disabled },
});
