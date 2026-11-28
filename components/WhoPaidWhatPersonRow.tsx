// Who paid what's member row (T16): name, net, the paid / share / payments line, and the costs
// behind it when opened. Moved out of app/(app)/groups/[id]/balances.tsx so it can be rendered on its
// own (the web aria test, __tests__/groupAriaWeb.test.tsx).
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { useFocusRing } from '@/components/ui/useFocusRing';
import { ariaProps } from '@/lib/ariaProps';
import { costLine, costsHint, WHO_PAID_WHAT_COPY as COPY, whoPaidWhatA11y, whoPaidWhatLine } from '@/lib/groupSettleText';
import type { WhoPaidWhatRow } from '@/lib/groupSettleView';
import { ROW_MIN_HEIGHT, space, tabularNums, type, useTheme } from '@/lib/theme';

/** One member in Who paid what: name, net and the line under it; tap to show the costs behind it. */
export function WhoPaidWhatPersonRow({ row, open, divider, onToggle }: { row: WhoPaidWhatRow; open: boolean; divider: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const { focusProps, ringStyle } = useFocusRing();
  return (
    <View style={divider && [styles.divider, { borderTopColor: colors.divider }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={whoPaidWhatA11y(row)}
        accessibilityHint={costsHint(row, open)}
        accessibilityState={{ expanded: open }}
        {...ariaProps({ expanded: open })}
        onPress={onToggle}
        {...focusProps}
        style={({ pressed }) => [styles.person, pressed && { backgroundColor: colors.surfaceMuted }, ringStyle]}
      >
        <View style={styles.personText}>
          <View style={styles.personTop}>
            <Text style={[type.label, styles.flex, { color: colors.text }]}>{row.name}</Text>
            <Text style={[type.headline, tabularNums, { color: row.settled ? colors.textMuted : colors.text }]}>{row.netText}</Text>
          </View>
          <Text style={[type.caption, tabularNums, { color: colors.textMuted }]}>{row.settled ? `${whoPaidWhatLine(row)} · ${COPY.settledUp}` : whoPaidWhatLine(row)}</Text>
        </View>
        <Icon icon={open ? ChevronUp : ChevronDown} size="sm" color={colors.primary} />
      </Pressable>
      {open ? (
        <View style={styles.costs}>
          {row.costs.length === 0 ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>{COPY.noCosts}</Text>
          ) : (
            row.costs.map((c) => (
              <View key={c.id} accessible accessibilityLabel={`${c.title}, ${costLine(c)}`} style={styles.cost}>
                <Text style={[type.body, styles.flex, { color: colors.text }]}>{c.title}</Text>
                <Text style={[type.caption, tabularNums, { color: colors.textMuted }]}>{costLine(c)}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  person: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: ROW_MIN_HEIGHT, paddingVertical: space.md, paddingHorizontal: space.lg },
  personText: { flex: 1, minWidth: 0, gap: space.xs },
  personTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  costs: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  cost: { gap: space.xs },
  flex: { flex: 1 },
});
