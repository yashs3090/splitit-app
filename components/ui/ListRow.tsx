// ListRow: one row in a grouped list (people, bills, settle rows, activity).
// Leading slot (avatar or icon), a title with an optional caption, a trailing slot (money, a button,
// a chevron). Tappable rows get a full-width pressed background; rows are separated by a hairline
// that starts at the content edge (iOS inset style).
//
// Group rows in a `flush` Card, so the pressed background reaches the card's edges and follows
// its corners:  <Card flush>{rows.map((r, i) => <ListRow key={…} divider={i > 0} … />)}</Card>
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ROW_MIN_HEIGHT, space, type, useTheme } from '@/lib/theme';

import { useFocusRing } from './useFocusRing';

type Props = {
  title: string;
  /** A muted line under the title, or a small element there (e.g. a status pill). */
  caption?: ReactNode;
  leading?: ReactNode;
  /**
   * Money, a status, a chevron, or a button. When the row has `onPress`, this must not be
   * interactive: a button inside a button can't be reached by screen readers or the keyboard.
   * A row with its own action in `trailing` leaves `onPress` unset.
   */
  trailing?: ReactNode;
  /**
   * Makes the whole row one button. Its label must say everything the row shows that matters.
   * On a static row (no onPress), `accessibilityLabel` makes the leading slot, title and caption one
   * screen-reader element, while `trailing` (e.g. an Add button) stays its own.
   */
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** "link" for rows that open another screen where the app already announced them as links. */
  accessibilityRole?: 'button' | 'link';
  /** Draw the hairline above this row (every row but the first). */
  divider?: boolean;
  /**
   * True (default): the row brings its own 16-pt side padding, for a `flush` Card.
   * False: no side padding, for rows inside a padded card next to other content (a search field).
   */
  edgeToEdge?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function ListRow({
  title,
  caption,
  leading,
  trailing,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  divider = false,
  edgeToEdge = true,
  style,
}: Props) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();

  const groupStatic = !onPress && accessibilityLabel !== undefined;
  const content = (
    <View style={[styles.content, !edgeToEdge && styles.noSide, divider && [styles.divider, { borderTopColor: colors.divider }]]}>
      <View
        accessible={groupStatic ? true : undefined}
        accessibilityLabel={groupStatic ? accessibilityLabel : undefined}
        style={styles.info}
      >
        {leading}
        <View style={styles.text}>
          <Text style={[type.body, { color: colors.text }]}>{title}</Text>
          {typeof caption === 'string' ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>{caption}</Text>
          ) : (
            (caption ?? null)
          )}
        </View>
      </View>
      {trailing}
    </View>
  );

  if (!onPress) return <View style={[edgeToEdge && styles.row, style]}>{content}</View>;
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceMuted }, ringStyle && [ringStyle, styles.ringInside], style]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingLeft: space.lg },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: ROW_MIN_HEIGHT,
    paddingVertical: space.md,
    paddingRight: space.lg,
  },
  noSide: { paddingRight: 0 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  info: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.md },
  // Title and caption: label-to-value spacing. minWidth 0 lets long names wrap instead of pushing
  // the trailing slot off the row.
  text: { flex: 1, minWidth: 0, alignItems: 'flex-start', gap: space.xs },
  // Rows sit edge to edge inside a clipped card, so the ring is drawn inside the row.
  ringInside: { outlineOffset: -2 },
});
