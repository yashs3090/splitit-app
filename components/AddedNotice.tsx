// The "added you to a bill" card on Home (docs/specs/2026-11-24-bill-markers-and-notices.md, K2 and D5).
// A card, never a modal: it doesn't navigate on its own. Only "Open" (a tap) navigates, so it never
// touches the sign-in resume path. Copy, labels and hints all come from lib/homeMarkers.ts; this
// component formats nothing and does no money arithmetic (the detail line arrives ready to show).
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  ADDED_NOTICE_DISMISS_HINT_MANY,
  ADDED_NOTICE_DISMISS_HINT_ONE,
  ADDED_NOTICE_DISMISS_LABEL,
  ADDED_NOTICE_OPEN_HINT,
  ADDED_NOTICE_OPEN_TEXT,
  addedNoticeOpenLabel,
  type AddedNotice as Notice,
} from '@/lib/homeMarkers';
import { space, tabularNums, type, useTheme } from '@/lib/theme';

type Props = {
  notice: Notice;
  /** "Open" on a one-bill notice. */
  onOpen: (billId: string) => void;
  onDismiss: () => void;
};

export function AddedNotice({ notice, onOpen, onDismiss }: Props) {
  const { colors } = useTheme();
  const one = notice.kind === 'one' ? notice : null;
  return (
    <Card muted>
      <View style={styles.text}>
        <Text accessibilityRole="header" style={[type.headline, { color: colors.text }]}>
          {notice.title}
        </Text>
        <Text style={[type.body, tabularNums, { color: colors.textMuted }]}>{notice.detail}</Text>
      </View>
      <View style={styles.buttons}>
        {one ? (
          <Button
            label={ADDED_NOTICE_OPEN_TEXT}
            accessibilityLabel={addedNoticeOpenLabel(one.bill)}
            accessibilityHint={ADDED_NOTICE_OPEN_HINT}
            variant="secondary"
            onPress={() => onOpen(one.bill.id)}
          />
        ) : null}
        <Button
          label={ADDED_NOTICE_DISMISS_LABEL}
          accessibilityLabel={ADDED_NOTICE_DISMISS_LABEL}
          accessibilityHint={one ? ADDED_NOTICE_DISMISS_HINT_ONE : ADDED_NOTICE_DISMISS_HINT_MANY}
          variant="ghost"
          onPress={onDismiss}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  text: { gap: space.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
});
