// "Your groups" (route /groups): every group you're in, on the Groups tab (moved from
// app/(app)/groups/index.tsx by docs/specs/2026-11-28-tab-bar-and-activity.md Task 5; groups/new and
// groups/[id]/* stay in the (app) stack above the tabs). Title, one primary "New group" button, then the list.
// The list is components/GroupsSection with variant="page": the same rows as Home's Groups block
// (name, other members' initials, one status: "Claim your items on N bills" / "You owe $X" / "You're owed $X" / "N items left to claim" / "Settled up", or "4 people" until it loads, chevron), the
// same "Hidden groups (N)" with Unhide, its own load / error-with-retry / refetch-on-focus, and the
// same snapshot reads (at most GROUPS_HOME_DETAIL_LIMIT; the rest show the people count). Words in
// lib/groupHomeView.ts (GROUPS_PAGE_COPY). Decisions GR-GL-* in docs/decisions-to-review.md.
//
// Signed-in only (the (app) layout sends a signed-out visit to sign-in). Never navigates on its own:
// only a tap opens a screen. A tab has no back control: the tab bar is the way to Home.
import { useRouter } from 'expo-router';
import Plus from 'lucide-react-native/icons/plus';
import { useCallback } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GroupsSection } from '@/components/GroupsSection';
import { Button } from '@/components/ui/Button';
import { GROUPS_PAGE_COPY as COPY } from '@/lib/groupHomeView';
import { layout, space, type, useTheme } from '@/lib/theme';

export default function GroupsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const newGroup = useCallback(() => router.push('/groups/new'), [router]);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      // No header on a tab: the top safe area is ours. The tab bar covers the bottom one.
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.lg, paddingBottom: space.xl }]}
    >
      <View style={styles.column}>
        <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
          {COPY.title}
        </Text>
        <Button
          label={COPY.newGroup}
          accessibilityHint={COPY.newGroupHint}
          icon={Plus}
          variant="primary"
          block
          onPress={newGroup}
        />
        <GroupsSection variant="page" />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.lg },
});
