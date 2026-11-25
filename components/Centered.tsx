import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { space, useTheme } from '@/lib/theme';

/**
 * A full-screen centered column for loading, error and one-message screens. It paints the theme
 * background itself, so these states never show the navigator's light default in dark mode.
 */
export function Centered({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[styles.container, { backgroundColor: colors.background }]}>{children}</View>;
}

export function Loading() {
  const { colors } = useTheme();
  return (
    <Centered>
      <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
    </Centered>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg },
});
