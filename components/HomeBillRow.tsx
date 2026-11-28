// One bill on Home (HOME-POLISH-1, 2026-11-28; research docs/research/2026-11-28-home-screen-research.md §5
// "Row anatomy"). Everything it shows comes from lib/homeSections' row view; it does no maths.
//
//   (H)  Hana's bill                 $14.80  ›
//        You owe $14.80          Your share
//        Nov 20 · 2 people
//
// Leading: the host's initials (components/Avatars' circle; "Y" on your own bill). Line 1: the
// title, and the amount in tabular figures, the row's largest text. Line 2: the status in words,
// teal at 600 when it's the viewer's next step (tone 'accent'), muted otherwise; it replaced the
// pill shape, and it's never colour alone (the words say it). The amount's label sits on this line.
// Line 3: the date and people count. The whole row is one link whose label says all of it (D5),
// so nothing inside is tappable and the avatar is decorative.
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatars';
import { Icon } from '@/components/ui/Icon';
import { ListRow } from '@/components/ui/ListRow';
import type { HomeRowView } from '@/lib/homeSections';
import { space, tabularNums, type, useTheme } from '@/lib/theme';

type Props = {
  row: HomeRowView;
  /** The hairline above this row (every row but the first). */
  divider: boolean;
  /**
   * Draw the status line. False on Settled rows: the section already says it (A1.S3). The row's
   * label keeps the words either way.
   */
  showStatus: boolean;
  onPress: () => void;
};

export function HomeBillRow({ row, divider, showStatus, onPress }: Props) {
  const { colors } = useTheme();
  const status = showStatus ? row.status : null;
  const accent = status?.tone === 'accent';
  const lines =
    status !== null || row.caption !== '' ? (
      <View style={styles.lines}>
        {status !== null ? (
          <Text style={[type.caption, accent && styles.accent, { color: accent ? colors.primary : colors.textMuted }]}>{status.pill}</Text>
        ) : null}
        {row.caption !== '' ? <Text style={[type.caption, { color: colors.textMuted }]}>{row.caption}</Text> : null}
      </View>
    ) : undefined;
  return (
    <ListRow
      title={row.title}
      caption={lines}
      leading={
        // Top-aligned on the title's line: the 24-pt circle sits 1 pt above the 22-pt line.
        <View
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          aria-hidden
          style={styles.leading}
        >
          <Avatar person={row.host} />
        </View>
      }
      trailing={
        <View style={styles.trailing}>
          <View style={styles.amount}>
            <Text style={[type.headline, tabularNums, { color: colors.text }]}>{row.amountText}</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>{row.amountLabel}</Text>
          </View>
          <Icon icon={ChevronRight} color={colors.textMuted} />
        </View>
      }
      accessibilityRole="link"
      accessibilityLabel={row.a11yLabel}
      accessibilityHint="Opens this bill"
      onPress={onPress}
      divider={divider}
    />
  );
}

const styles = StyleSheet.create({
  leading: { alignSelf: 'flex-start', marginTop: -1 },
  // The status and the caption under the title, at ListRow's title-to-caption spacing.
  lines: { gap: space.xs, alignItems: 'flex-start' },
  // Weight 600 for the next step: teal caption text stays above 4.5:1 on paper in both modes.
  accent: { fontWeight: '600' },
  // The amount block hugs the top so the figure sits on the title's line and its label on the
  // status line; the chevron stays centred on the whole row.
  trailing: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: space.sm },
  amount: { alignSelf: 'flex-start', alignItems: 'flex-end', gap: space.xs },
});
