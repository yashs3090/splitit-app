// Initials avatars for the people who claimed a row: up to `max`, then "+N".
// Read by screen readers as one line ("Claimed by You and Hana Lee"), not avatar by avatar.
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { nameList } from '@/lib/billView';
import { radius, space, type, useTheme } from '@/lib/theme';

export type AvatarPerson = { userId: string; name: string; initials: string; isMe: boolean };

type Props = { people: readonly AvatarPerson[]; max?: number };

const SIZE = 24;

export function Avatars({ people, max = 3 }: Props) {
  const { colors } = useTheme();
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <View
      accessible
      accessibilityLabel={`Claimed by ${nameList(people.map((p) => p.name))}`}
      style={styles.row}
    >
      {shown.map((p, i) => (
        <Avatar key={p.userId} person={p} style={i > 0 ? styles.overlap : undefined} />
      ))}
      {extra > 0 ? <Text style={[type.micro, styles.more, { color: colors.textMuted }]}>+{extra}</Text> : null}
    </View>
  );
}

/**
 * One initials circle. Decorative: the caller puts the name in text or an accessibility label.
 * The 2-pt outer edge in `surface` is a cutout where avatars overlap. Inside it, a 1-pt ring keeps
 * the circle visible in dark mode, where the muted fill alone is 1.13:1 on the card: `border`
 * (3.74:1 light, 3.75:1 dark) for other people, `primary` for the viewer's own.
 */
export function Avatar({ person, style }: { person: AvatarPerson; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <View accessible={false} style={[styles.avatar, { borderColor: colors.surface }, style]}>
      <View
        style={[
          styles.circle,
          {
            backgroundColor: person.isMe ? colors.primary : colors.surfaceMuted,
            borderColor: person.isMe ? colors.primary : colors.border,
          },
        ]}
      >
        <Text maxFontSizeMultiplier={1.5} style={[type.micro, { color: person.isMe ? colors.onPrimary : colors.text }]}>
          {person.initials}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // The outer cutout ring (2 pt) around a 20-pt circle: 24 overall, as before.
  avatar: { minWidth: SIZE, minHeight: SIZE, borderRadius: radius.pill, borderWidth: 2 },
  circle: {
    flexGrow: 1,
    minWidth: SIZE - 4,
    minHeight: SIZE - 4,
    paddingHorizontal: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlap: { marginLeft: -6 },
  // Initials use type.micro: a fixed small size inside a fixed circle (capped at 1.5× under large
  // text); the names are also in the row's accessibility label.
  more: { marginLeft: space.xs },
});
