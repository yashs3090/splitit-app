// SegmentedControl: two or three mutually exclusive options on a muted track ("Before / After
// subtotal", "% / $"). The selected segment is solid teal and heavier (700 vs 600: a small step, so
// labels don't change width when the selection moves), and is announced as selected.
// Segments keep role "button" + selected state by default, the semantics today's hand-built versions
// use. `semantics="radio"` is opt-in (Settle's "How you're paying"): the track becomes a labelled
// radiogroup and each segment a radio with `checked`. `disabled` dims the whole control and blocks
// presses (a write from the same card is in flight).
// Web (QA F1): react-native-web drops accessibilityState, so the state also goes out as aria-*:
// aria-checked on radios, aria-pressed on buttons (aria-selected isn't allowed on a button, so
// browsers would ignore it), aria-disabled when disabled. Native keeps accessibilityState.
// Web radio keyboard (QA N2, the WAI-ARIA radio group pattern): only the checked radio is a tab stop
// (roving tabindex); Space selects the focused radio (Enter already did); the arrow keys move the
// selection and focus to the previous / next radio, wrapping round. Button mode is unchanged.
// Large text (QA N1): the track never grows past its parent. Its segments shrink, and when even that
// isn't enough they wrap onto a second line, so the chooser stays inside its card at 200% zoom.
import Check from 'lucide-react-native/icons/check';
import { useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

import { Icon } from './Icon';
import { useFocusRing } from './useFocusRing';

/** Gap between the track's edge and its segments; radius.inner = radius.sm - INSET keeps the curves parallel. */
const INSET = 2;

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  accessibilityLabel?: string;
};

type Props<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Fill the row, with equal-width segments. Otherwise the track hugs its labels. */
  stretch?: boolean;
  /** Show a check before the selected label (when the label alone could be misread). */
  checkSelected?: boolean;
  /** Dim the whole control (opacity.disabled), block presses and announce it. */
  disabled?: boolean;
  /** 'button' (default): segments are buttons with `selected`. 'radio': a radiogroup of radios with `checked`. */
  semantics?: 'button' | 'radio';
  /** The radiogroup's label ("How you're paying"); used with `semantics="radio"`. */
  groupLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  stretch = false,
  checkSelected = false,
  disabled = false,
  semantics = 'button',
  groupLabel,
  style,
}: Props<T>) {
  const { colors } = useTheme();
  const radio = semantics === 'radio';
  const refs = useRef<(View | null)[]>([]);
  // Roving tabindex needs one tab stop even if `value` matches no option: then it's the first.
  const checkedIndex = options.findIndex((o) => o.value === value);
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0;

  /** Web radio keys (N2). Arrows move the selection and focus; Space selects the focused radio. */
  const onKey = (index: number, key: string): boolean => {
    if (disabled) return false;
    const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      const next = (index + step + options.length) % options.length;
      const o = options[next];
      if (o === undefined) return false;
      refs.current[next]?.focus();
      if (o.value !== value) onChange(o.value);
      return true;
    }
    if (key === ' ' || key === 'Spacebar') {
      const o = options[index];
      if (o !== undefined && o.value !== value) onChange(o.value);
      return true;
    }
    return false;
  };

  return (
    <View
      accessibilityRole={radio ? 'radiogroup' : undefined}
      accessibilityLabel={radio ? groupLabel : undefined}
      style={[
        styles.track,
        stretch ? styles.trackStretch : styles.trackHug,
        { backgroundColor: colors.surfaceMuted },
        disabled && styles.disabled,
        style,
      ]}
    >
      {options.map((o, i) => (
        <Segment
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          option={o}
          selected={o.value === value}
          stretch={stretch}
          checkSelected={checkSelected}
          disabled={disabled}
          radio={radio}
          tabStop={i === tabStop}
          onKey={(key) => onKey(i, key)}
          onPress={() => onChange(o.value)}
        />
      ))}
    </View>
  );
}

function Segment<T extends string>({
  ref,
  option,
  selected,
  stretch,
  checkSelected,
  disabled,
  radio,
  tabStop,
  onKey,
  onPress,
}: {
  ref: (el: View | null) => void;
  option: SegmentOption<T>;
  selected: boolean;
  stretch: boolean;
  checkSelected: boolean;
  disabled: boolean;
  radio: boolean;
  /** Radio mode on web: this radio is the group's one tab stop (roving tabindex). */
  tabStop: boolean;
  /** Radio mode on web: a key went down on this radio; true when it was handled. */
  onKey: (key: string) => boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const fg = selected ? colors.onPrimary : colors.text;
  return (
    <Pressable
      ref={ref}
      accessibilityRole={radio ? 'radio' : 'button'}
      accessibilityLabel={option.accessibilityLabel}
      accessibilityState={radio ? { checked: selected } : { selected }}
      {...webState(radio, selected)}
      {...webRadioKeys(radio, disabled, tabStop, onKey)}
      // Undefined when enabled, so Pressable leaves the state exactly as before (no `disabled: false`).
      disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      onPress={onPress}
      // The segment is 40 tall inside a 44 track; the slop gives it the full 44-pt target.
      hitSlop={{ top: INSET, bottom: INSET }}
      {...focusProps}
      style={({ pressed }) => [
        styles.segment,
        stretch && styles.segmentStretch,
        // Solid teal: the selected indicator is ≥3:1 against the muted track (a tint was ~1:1).
        selected && { backgroundColor: colors.primary },
        pressed && styles.pressed,
        ringStyle,
      ]}
    >
      {selected && checkSelected ? <Icon icon={Check} size="sm" color={fg} /> : null}
      <Text style={[type.label, styles.label, { color: fg, fontWeight: selected ? '700' : '600' }]}>{option.label}</Text>
    </Pressable>
  );
}

/**
 * The selection as the browser needs it (QA F1). A radio's aria-checked is typed and maps to the same
 * `checked` on native. A button's aria-pressed is web-only: React Native has no such prop.
 */
function webState(radio: boolean, selected: boolean): Partial<PressableProps> {
  if (radio) return { 'aria-checked': selected };
  if (Platform.OS !== 'web') return {};
  // react-native-web reads aria-pressed (createDOMProps); React Native's types don't list it.
  return { 'aria-pressed': selected } as Partial<PressableProps>;
}

/**
 * Radio mode on web (N2): the roving tab stop and the key handler. Native screen readers move
 * between radios themselves, and button mode keeps every segment a tab stop, so neither gets these.
 */
function webRadioKeys(radio: boolean, disabled: boolean, tabStop: boolean, onKey: (key: string) => boolean): Partial<PressableProps> {
  if (!radio || Platform.OS !== 'web') return {};
  // react-native-web forwards onKeyDown to the DOM element; React Native's types don't list it.
  const onKeyDown = (e: { key: string; preventDefault: () => void }) => {
    // Handled keys mustn't also scroll the page (Space, arrows).
    if (onKey(e.key)) e.preventDefault();
  };
  return { tabIndex: tabStop && !disabled ? 0 : -1, onKeyDown } as Partial<PressableProps>;
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    // N1: never wider than the parent; segments shrink, then wrap (large text, narrow screens).
    flexWrap: 'wrap',
    flexShrink: 1,
    maxWidth: '100%',
    padding: INSET,
    gap: INSET,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
  },
  trackHug: { alignSelf: 'flex-start' },
  trackStretch: { alignSelf: 'stretch' },
  segment: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET - 2 * INSET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.inner,
    borderCurve: 'continuous',
    // N1: a segment may shrink to its 44-pt minimum; its label wraps inside it. Once the track has
    // wrapped, each segment fills its row (equal widths, no dead track); a hugging track has no
    // free space at normal sizes, so growing changes nothing there.
    flexShrink: 1,
    flexGrow: 1,
  },
  segmentStretch: { flex: 1 },
  // Long labels wrap under large text instead of clipping.
  label: { flexShrink: 1, textAlign: 'center' },
  pressed: { opacity: opacity.pressed },
  disabled: { opacity: opacity.disabled },
});
