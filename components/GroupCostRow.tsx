// One cost on the group screen: a receipt or an expense (spec docs/specs/2026-11-26-groups-mvp.md
// T14). Every word and amount comes from lib/groupView.ts's CostRow; this component only lays it
// out: what it was and who paid on the left, the viewer's share on the right.
//
// A receipt opens its bill; an expense opens its edit screen only for its creator or payer (the
// caller decides, C-G9). A row with nowhere to go is static and keeps the chevron's space, so
// every share lines up in one column.
//
// A receipt that waits on the viewer (group claim status C1/C5) gets the soft warningSurface tint
// and "· Claim your items" in its caption and label (lib/groupScreenText.ts). Expenses never do.
import Banknote from 'lucide-react-native/icons/banknote';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Receipt from 'lucide-react-native/icons/receipt';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { ListRow } from '@/components/ui/ListRow';
import type { CostRow } from '@/lib/groupView';
import { costRowA11yLabel, costRowCaption, GROUP_SCREEN_COPY } from '@/lib/groupScreenText';
import { iconSize, space, tabularNums, type, useTheme } from '@/lib/theme';

type Props = {
  row: CostRow;
  /** Unset: the row is static (an expense the viewer can't edit). */
  onPress?: () => void;
  divider?: boolean;
};

export function GroupCostRow({ row, onPress, divider = false }: Props) {
  const { colors } = useTheme();
  const shareColor = row.waiting ? colors.textMuted : colors.text;
  return (
    <ListRow
      title={row.title}
      caption={costRowCaption(row)}
      leading={<Icon icon={row.kind === 'bill' ? Receipt : Banknote} color={colors.textMuted} />}
      trailing={
        // On a static row ListRow groups only the title side under the label, which already says the
        // share, so the share text is hidden here to be read once.
        <View style={styles.trailing} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
          <Text style={[type.body, tabularNums, { color: shareColor }]}>{row.shareLine}</Text>
          {onPress ? <Icon icon={ChevronRight} color={colors.textMuted} /> : <View style={styles.chevronSpace} />}
        </View>
      }
      accessibilityRole={onPress ? 'link' : undefined}
      accessibilityLabel={costRowA11yLabel(row)}
      accessibilityHint={onPress ? (row.kind === 'bill' ? GROUP_SCREEN_COPY.billHint : GROUP_SCREEN_COPY.expenseHint) : undefined}
      onPress={onPress}
      divider={divider}
      highlight={row.needsMe}
    />
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chevronSpace: { width: iconSize.md },
});
