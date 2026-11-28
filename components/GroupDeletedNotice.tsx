// Home's one-line notice after you delete a group: `"Tahoe trip" was deleted.` with Dismiss
// (docs/specs/2026-11-28-delete-group.md T6, C9, DG-7). The group screen leaves it in
// lib/groupDeletedNotice.ts just before it goes Home; this takes it, for the signed-in account only,
// each time Home comes into focus (Home may already be mounted under the group screen). It goes away
// on Dismiss or when Home loses focus. No timer, so a screen reader has time to read it.
// A polite live region (StatusLine) on Android and web; VoiceOver is told directly.
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';

import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import { takeGroupDeletedNotice } from '@/lib/groupDeletedNotice';
import { DELETE_GROUP_COPY, deletedNoticeText } from '@/lib/groupScreenText';
import { space } from '@/lib/theme';

export function GroupDeletedNotice() {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const [text, setText] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const notice = takeGroupDeletedNotice(userId);
      if (notice !== null) {
        const line = deletedNoticeText(notice.name);
        setText(line);
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(line);
      }
      return () => setText(null);
    }, [userId]),
  );

  if (text === null) return null;
  return (
    <View style={styles.line}>
      <StatusLine text={text} style={styles.flex} />
      <TextLink
        label={DELETE_GROUP_COPY.dismiss}
        accessibilityLabel={DELETE_GROUP_COPY.dismiss}
        accessibilityHint={DELETE_GROUP_COPY.dismissHint}
        onPress={() => setText(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  flex: { flex: 1 },
});
