// The shares summary in the bill screen's sticky footer: "Your share $X", expandable to everyone.
// It renders only what `displayShares` returned (A2.2): it never decides on its own whether totals
// are visible, and it does no money arithmetic (derived amounts and copy come from lib/billView.ts).
import { useState, type ReactNode } from 'react';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { MoneyText } from '@/components/ui/MoneyText';
import { useFocusRing } from '@/components/ui/useFocusRing';
import {
  breakdownText,
  pendingTotalText,
  pendingTotalWhen,
  personShareA11yLabel,
  showUnclaimedLine,
  unclaimedTotalCents,
  type NameOf,
} from '@/lib/billView';
import { formatCents } from '@/lib/money';
import type { DisplayShare, DisplayShares } from '@/lib/split';
import { opacity, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type Props = {
  shares: DisplayShares;
  myId: string;
  nameOf: NameOf;
  /** Task 19: the "Tax & tip" line/selector, shown in the expanded view only. */
  extrasControl?: ReactNode;
};

const EMPTY_SHARE = { itemsCents: 0, discountCents: 0, extrasCents: 0, totalCents: 0 } as const;

export function SharesSummary({ shares, myId, nameOf, extrasControl }: Props) {
  const { focusProps, ringStyle } = useFocusRing();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const mine = shares.people.find((p) => p.userId === myId) ?? { userId: myId, ...EMPTY_SHARE };
  // The viewer first, then everyone else in displayShares' order.
  const people = [mine, ...shares.people.filter((p) => p.userId !== myId)];
  const headline = shares.totalsVisible ? 'Your share' : 'Your items';
  const headlineCents = shares.totalsVisible && mine.totalCents !== null ? mine.totalCents : mine.itemsCents;
  const unclaimed = unclaimedTotalCents(shares);

  return (
    <View style={styles.wrap}>
      {open ? (
        <ScrollView style={styles.details} contentContainerStyle={styles.detailsContent}>
          {people.map((p) => (
            <PersonLine key={p.userId} share={p} name={nameOf(p.userId)} shares={shares} />
          ))}
          {showUnclaimedLine(shares) ? (
            <View accessible accessibilityLabel={`Unclaimed ${formatCents(unclaimed)}`} style={styles.line}>
              <Text style={[type.body, styles.grow, { color: colors.textMuted }]}>Unclaimed</Text>
              <MoneyText cents={unclaimed} muted />
            </View>
          ) : (
            <Text style={[type.caption, { color: colors.textMuted }]}>Everything&apos;s claimed.</Text>
          )}
          {extrasControl}
        </ScrollView>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${headline} ${formatCents(headlineCents)}`}
        accessibilityHint={open ? "Hides everyone's share" : "Shows everyone's share"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        {...focusProps}
        style={({ pressed }) => [styles.headline, pressed && styles.pressed, ringStyle]}
      >
        <Text style={[type.label, styles.grow, { color: colors.text }]}>{headline}</Text>
        <MoneyText cents={headlineCents} size="title" />
        <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.toggle}>
          <Text style={[type.caption, styles.toggleText, { color: colors.primary }]}>{open ? 'Hide' : 'Everyone'}</Text>
          <Icon icon={open ? ChevronDown : ChevronUp} size="sm" color={colors.primary} />
        </View>
      </Pressable>
    </View>
  );
}

function PersonLine({ share, name, shares }: { share: DisplayShare; name: string; shares: DisplayShares }) {
  const { colors } = useTheme();
  // Under "equal" before everything is claimed, displayShares gives null totals: show items only.
  const total = shares.totalsVisible ? share.totalCents : null;
  const extras = shares.totalsVisible ? share.extrasCents : null;
  // Claimed discounts (claimable discounts, C4) show with the totals, never before (CD-16).
  const discount = shares.totalsVisible ? share.discountCents : null;
  const amount = total ?? share.itemsCents;
  const detail =
    (extras !== null && extras !== 0) || (discount !== null && discount !== 0)
      ? breakdownText(share.itemsCents, extras ?? 0, discount ?? 0)
      : null;
  const pending = total === null ? pendingTotalText(shares.unclaimedRows, shares.unclaimedDiscountRows) : null;
  return (
    <View style={styles.person}>
      <View accessible accessibilityLabel={personShareA11yLabel(name, amount, total === null, pendingTotalWhen(shares.unclaimedRows, shares.unclaimedDiscountRows))} style={styles.line}>
        <Text style={[type.body, styles.grow, { color: colors.text }]}>{name}</Text>
        <MoneyText cents={amount} muted={total === null} />
      </View>
      {detail ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>{detail}</Text>
      ) : null}
      {pending ? <Text style={[type.caption, { color: colors.textMuted }]}>{pending}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  details: { maxHeight: 280 },
  detailsContent: { gap: space.md, paddingBottom: space.xs },
  person: { gap: space.xs },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  toggleText: { fontWeight: '600' },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  headline: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: TOUCH_TARGET },
  pressed: { opacity: opacity.pressed },
});
