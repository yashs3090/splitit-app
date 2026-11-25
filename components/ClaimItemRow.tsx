// One unit row on the bill screen. Exactly one primary action: the claim toggle.
// The name, avatars and status line are the row's single secondary target, which opens the item
// detail sheet once Task 11 passes `onOpenDetails`; without it they are plain text.
// A claimable discount row (spec 2026-11-24-claimable-discounts, Task 7) is the same row with a
// negative price; only its toggle hints change (`kind`).
import Check from 'lucide-react-native/icons/check';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatars, type AvatarPerson } from '@/components/Avatars';
import { Icon } from '@/components/ui/Icon';
import { MoneyText } from '@/components/ui/MoneyText';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { rowDetailsA11yLabel } from '@/lib/billView';
import type { RowKind } from '@/lib/split';
import { opacity, radius, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  /** Visible name, e.g. "Beer · 1 of 2". */
  label: string;
  /** Name for accessibility labels, e.g. "Beer 1 of 2" or "Police comp, discount". */
  a11yName: string;
  priceCents: number;
  /** The one quiet status line ("Unclaimed", "Split 2 ways · $3.00 each", …). */
  status: string;
  claimers: readonly AvatarPerson[];
  /** The viewer has claimed this row. */
  claimed: boolean;
  /** A claim change for this row is in flight. */
  busy: boolean;
  onToggle: () => void;
  /** Task 11: opens the item detail sheet. */
  onOpenDetails?: () => void;
  /** A claimable discount row reads "Takes this discount off your share". Absent means an item. */
  kind?: RowKind;
};

const TOGGLE_HINTS: Record<RowKind, { claim: string; unclaim: string }> = {
  item: { claim: 'Adds this item to your share', unclaim: 'Removes this item from your share' },
  discount: { claim: 'Takes this discount off your share', unclaim: 'Puts this discount back for someone to claim' },
};

export function ClaimItemRow(props: Props) {
  const { label, a11yName, priceCents, status, claimers, claimed, busy, onToggle, onOpenDetails, kind = 'item' } = props;
  const { colors } = useTheme();
  const unclaimed = claimers.length === 0;
  const detailsRing = useFocusRing();
  const toggleRing = useFocusRing();

  const info = (
    <>
      <View style={styles.nameLine}>
        <Text style={[type.body, styles.name, { color: colors.text }]}>{label}</Text>
        <MoneyText cents={priceCents} />
      </View>
      <View style={styles.statusLine}>
        <Avatars people={claimers} />
        <Text style={[type.caption, styles.status, { color: colors.textMuted }]}>{status}</Text>
      </View>
    </>
  );

  return (
    <View style={styles.row}>
      {onOpenDetails ? (
        <Pressable
          accessibilityRole="button"
          // The button hides its children from screen readers, so its label carries them.
          accessibilityLabel={rowDetailsA11yLabel(a11yName, priceCents, status, claimers.map((p) => p.name))}
          accessibilityHint="Shows who pays what"
          onPress={onOpenDetails}
          {...detailsRing.focusProps}
          style={({ pressed }) => [styles.info, pressed && styles.pressed, detailsRing.ringStyle]}
        >
          {info}
        </Pressable>
      ) : (
        <View style={styles.info}>{info}</View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${claimed ? 'Unclaim' : 'Claim'} ${a11yName}`}
        accessibilityHint={claimed ? TOGGLE_HINTS[kind].unclaim : TOGGLE_HINTS[kind].claim}
        accessibilityState={{ selected: claimed, busy }}
        disabled={busy}
        onPress={onToggle}
        {...toggleRing.focusProps}
        // Three looks, told apart by words and icon as well as color (visual pass V12):
        // mine = solid teal with a check and "Mine"; nobody's yet = teal tint "Claim";
        // someone else's = muted grey "Claim". No outlines.
        style={({ pressed }) => [
          styles.toggle,
          { backgroundColor: claimed ? colors.primary : unclaimed ? colors.primarySurface : colors.surfaceMuted },
          pressed && styles.pressed,
          toggleRing.ringStyle,
        ]}
      >
        {claimed ? <Icon icon={Check} size="sm" color={colors.onPrimary} /> : null}
        <Text style={[type.label, { color: claimed ? colors.onPrimary : unclaimed ? colors.primary : colors.text }]}>
          {claimed ? 'Mine' : 'Claim'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  info: { flex: 1, minWidth: 0, gap: space.xs },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  name: { flex: 1, minWidth: 0 },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  status: { flexShrink: 1 },
  toggle: {
    minHeight: TOUCH_TARGET,
    // Wide enough for "Claim" and check + "Mine" alike, so the row doesn't shift when it toggles.
    minWidth: 84,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    flexDirection: 'row',
    gap: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: opacity.pressed },
});
