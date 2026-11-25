// Card: a surface for one real group (the item list, the totals, a list of rows). Hairline edge,
// no shadow (a shadow means "this whole surface is tappable": ChoiceCard only).
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, space, type, useTheme } from '@/lib/theme';

type Props = {
  title?: string;
  /** Short text on the right of the title row (e.g. a count). */
  aside?: string;
  /**
   * For a group of ListRows: no padding or gap (rows bring their own), and clipped so the first and
   * last rows' pressed background follows the corners. Don't combine with `title`; put a
   * SectionHeader above the card instead.
   */
  flush?: boolean;
  /** A quiet notice (a nudge or prompt): muted fill, no edge. Not for groups of content. */
  muted?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function Card({ title, aside, flush = false, muted = false, children, style }: Props) {
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.card,
        flush && styles.flush,
        muted ? { backgroundColor: colors.surfaceMuted, borderColor: 'transparent' } : { backgroundColor: colors.surface, borderColor: colors.divider },
        style,
      ]}
    >
      {title ? (
        <View style={styles.header}>
          <Text accessibilityRole="header" style={[type.headline, styles.title, { color: colors.text }]}>
            {title}
          </Text>
          {aside ? <Text style={[type.caption, { color: colors.textMuted }]}>{aside}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.md,
  },
  flush: { padding: 0, gap: 0, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.sm },
  // Long titles wrap under large text instead of pushing the aside off the card.
  title: { flexShrink: 1 },
});
