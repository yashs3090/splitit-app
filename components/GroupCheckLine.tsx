// "Couldn't check this bill's group. Try again." (groups GR-T17-17, money safety): stands where the
// bill's pay, mark, request, leave and invite controls would be while its group is unknown because
// the group read failed. Compact (one alert line and a ghost Try again), so it fits the bill footer.
// Optionally carries an in_group refusal's line above it (lib/billGroup.ts inGroupRefusalText).
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { GROUP_CHECK_COPY } from '@/lib/billGroup';
import { space, type, useTheme } from '@/lib/theme';

type Props = {
  onRetry: () => void;
  /** The re-read is in flight. */
  checking: boolean;
  /** An in_group refusal said before the group is known, or null. */
  notice?: string | null;
};

export function GroupCheckLine({ onRetry, checking, notice = null }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.stack}>
      {notice !== null ? <StatusLine text={notice} tone="error" size="caption" alert /> : null}
      <View style={styles.row}>
        <Text
          accessibilityRole={checking ? undefined : 'alert'}
          accessibilityLiveRegion={checking ? 'polite' : undefined}
          style={[type.caption, styles.grow, { color: colors.textMuted }]}
        >
          {checking ? GROUP_CHECK_COPY.checking : GROUP_CHECK_COPY.failed}
        </Text>
        <Button
          label={GROUP_CHECK_COPY.tryAgain}
          accessibilityLabel={GROUP_CHECK_COPY.tryAgain}
          accessibilityHint={GROUP_CHECK_COPY.tryAgainHint}
          variant="ghost"
          loading={checking}
          onPress={onRetry}
          flush
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
});
