// "Who had this?" on a group bill's item sheet (spec docs/specs/2026-11-26-groups-mvp.md T18,
// criteria 84 and 86). One chip per member: avatar, first name and a mark. Tapping a chip puts that
// person on the item or takes them off; the sheet does the write (lib/useAssignItem.ts).
// The words, order and labels come from lib/itemAssign.ts; this only lays them out.
//
// Checked shows by shape as well as color: a check mark, an outline in `primary` (4.84:1 light,
// 7.8:1 dark against the fill; the fills alone are only ~1.1:1 against the sheet) and a bolder name,
// against a plus on the plain muted fill, so it reads in dim light and for color-blind people. Both marks take the same
// slot, so a chip doesn't change width when it's tapped. Chips are at least 44 pt tall.
import Check from 'lucide-react-native/icons/check';
import Plus from 'lucide-react-native/icons/plus';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar, type AvatarPerson } from '@/components/Avatars';
import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { ariaProps } from '@/lib/ariaProps';
import { ASSIGN_COPY, assignChipHint, assignChips, chipNames, type AssignChip, type PartsMap } from '@/lib/itemAssign';
import { iconSize, opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  /** Every group member; the viewer is the one with `isMe`. */
  members: readonly AvatarPerson[];
  /** Who has the row now (member id → parts). */
  current: PartsMap;
  /** The member whose chip is being saved, or null. */
  busyId: string | null;
  /** No chip can be tapped (a write is in progress). */
  disabled: boolean;
  noun: 'item' | 'discount';
  onToggle: (userId: string) => void;
};

/** The chips in their order (viewer first, then by name), from lib. */
export function chipsFor(members: readonly AvatarPerson[], current: PartsMap): AssignChip[] {
  const viewerId = members.find((m) => m.isMe)?.userId ?? '';
  const names = new Map(members.map((m) => [m.userId, m.name]));
  return assignChips(members, current, viewerId, (id) => names.get(id) ?? '');
}

export function AssignChips({ members, current, busyId, disabled, noun, onToggle }: Props) {
  const { colors } = useTheme();
  const chips = chipsFor(members, current);
  const shown = chipNames(chips);
  const people = new Map(members.map((m) => [m.userId, m]));
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[type.section, { color: colors.textMuted }]}>
        {ASSIGN_COPY.heading}
      </Text>
      <View style={styles.wrap}>
        {chips.map((c) => {
          const p = people.get(c.userId);
          if (p === undefined) return null;
          return (
            <Chip
              key={c.userId}
              chip={c}
              person={p}
              text={shown[c.userId] ?? c.name}
              hint={assignChipHint(c, noun)}
              busy={busyId === c.userId}
              disabled={disabled}
              onPress={() => onToggle(c.userId)}
            />
          );
        })}
      </View>
    </View>
  );
}

type ChipProps = {
  chip: AssignChip;
  person: AvatarPerson;
  text: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
};

function Chip({ chip, person, text, hint, busy, disabled, onPress }: ChipProps) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  const { checked } = chip;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={chip.a11yLabel}
      accessibilityHint={hint}
      accessibilityState={{ checked, disabled, busy }}
      // react-native-web drops accessibilityState; the same values as aria-* reach the browser.
      {...ariaProps({ checked, disabled, busy })}
      disabled={disabled}
      onPress={onPress}
      {...focusProps}
      style={({ pressed }) => [
        styles.chip,
        checked
          ? { backgroundColor: colors.primarySurface, borderColor: colors.primary }
          : { backgroundColor: colors.surfaceMuted, borderColor: 'transparent' },
        pressed && styles.pressed,
        ringStyle,
      ]}
    >
      <Avatar person={person} />
      <Text
        numberOfLines={1}
        style={[checked ? type.label : type.body, styles.name, { color: checked ? colors.text : colors.textMuted }]}
      >
        {text}
      </Text>
      <View style={styles.mark}>
        {busy ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : checked ? (
          <View testID="assign-chip-checked">
            <Icon icon={Check} size="sm" color={colors.primary} />
          </View>
        ) : (
          <View testID="assign-chip-add">
            <Icon icon={Plus} size="sm" color={colors.textMuted} />
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: TOUCH_TARGET,
    maxWidth: '100%',
    paddingLeft: space.sm,
    paddingRight: space.md,
    borderRadius: radius.pill,
    borderCurve: 'continuous',
    // A chip is a checkbox (an input), so a checked one gets the outline inputs use; unchecked has a
    // clear border so the size never changes.
    borderWidth: 1.5,
  },
  pressed: { opacity: opacity.pressed },
  name: { flexShrink: 1, minWidth: 0 },
  // The busy spinner and both marks share one fixed slot.
  mark: { width: iconSize.md, alignItems: 'center', justifyContent: 'center' },
});
