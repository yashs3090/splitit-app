// SegmentedControl: two or three mutually exclusive options on a muted track ("Before / After
// subtotal", "% / $"). The selected segment is solid teal and heavier (700 vs 600: a small step, so
// labels don't change width when the selection moves), and is announced as selected.
// Segments keep role "button" + selected state, the semantics today's hand-built versions use.
import Check from 'lucide-react-native/icons/check';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

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
  style?: StyleProp<ViewStyle>;
};

export function SegmentedControl<T extends string>({ options, value, onChange, stretch = false, checkSelected = false, style }: Props<T>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.track, stretch ? styles.trackStretch : styles.trackHug, { backgroundColor: colors.surfaceMuted }, style]}>
      {options.map((o) => (
        <Segment key={o.value} option={o} selected={o.value === value} stretch={stretch} checkSelected={checkSelected} onPress={() => onChange(o.value)} />
      ))}
    </View>
  );
}

function Segment<T extends string>({
  option,
  selected,
  stretch,
  checkSelected,
  onPress,
}: {
  option: SegmentOption<T>;
  selected: boolean;
  stretch: boolean;
  checkSelected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const fg = selected ? colors.onPrimary : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={option.accessibilityLabel}
      accessibilityState={{ selected }}
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

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
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
  },
  segmentStretch: { flex: 1 },
  // Long labels wrap under large text instead of clipping.
  label: { flexShrink: 1, textAlign: 'center' },
  pressed: { opacity: opacity.pressed },
});
