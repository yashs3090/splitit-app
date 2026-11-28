// What a group screen (the group, Settle up, Who paid what, an expense, Activity) shows once its group
// is gone: the C8 heading and Go home (docs/specs/2026-11-28-delete-group.md C8, criterion
// 46). Nothing about the group (name, amounts, members) is shown. Go home replaces the screen with
// Home, so Back doesn't return to a group that no longer exists. Copy from lib/groupScreenText.ts.
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Centered } from '@/components/Centered';
import { Button } from '@/components/ui/Button';
import { DELETE_GROUP_COPY } from '@/lib/groupScreenText';
import { layout, type, useTheme } from '@/lib/theme';

/** `header`: the screen's own BackHeader, so the bar stays the same as in its other states. */
export function GroupDeletedState({ header }: { header?: ReactNode }) {
  const router = useRouter();
  const { colors } = useTheme();
  return (
    <Centered>
      {header}
      <Text accessibilityRole="header" style={[type.title, styles.center, { color: colors.text }]}>
        {DELETE_GROUP_COPY.deletedHeading}
      </Text>
      <Button label={DELETE_GROUP_COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
    </Centered>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center', maxWidth: layout.message },
});
