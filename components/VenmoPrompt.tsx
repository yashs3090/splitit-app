// The one-time "Add your Venmo" card on home (docs/specs/2026-11-24-profile-venmo.md, Task 5, Q2 option A).
// Shown only while the server says the prompt is pending; any error shows nothing (fail closed).
// It never navigates on its own: "Add Venmo" is a tap, so the post-sign-in resume flow is untouched (D4).
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { dismissVenmoPrompt, isVenmoPromptPending } from '@/lib/profile';
import { space, type, useTheme } from '@/lib/theme';

export const VENMO_PROMPT_TEXT = 'Add your Venmo so friends can pay you';

export function VenmoPrompt() {
  const router = useRouter();
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  // "Not now" wins for as long as home is mounted, even if the dismiss call failed or a
  // re-check that started earlier answers "pending" afterwards. Sign-out unmounts home.
  const dismissed = useRef(false);
  const latest = useRef(0);

  // Re-checks whenever home comes back into view, so the card goes away after a save on Profile.
  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      void isVenmoPromptPending().then((pending) => {
        if (mine !== latest.current || dismissed.current) return;
        setVisible(pending);
      });
      return () => {
        latest.current++; // ignore an answer that lands after leaving
      };
    }, []),
  );

  if (!visible) return null;

  function onNotNow() {
    dismissed.current = true;
    setVisible(false);
    void dismissVenmoPrompt();
  }

  return (
    <Card muted>
      <Text style={[type.label, { color: colors.text }]}>{VENMO_PROMPT_TEXT}</Text>
      <View style={styles.buttons}>
        <Button
          label="Add Venmo"
          accessibilityLabel="Add Venmo"
          accessibilityHint="Opens your profile"
          variant="secondary"
          onPress={() => router.push('/profile')}
        />
        <Button
          label="Not now"
          accessibilityLabel="Not now"
          accessibilityHint="Hides this and doesn't ask again"
          variant="ghost"
          onPress={onNotNow}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
});
