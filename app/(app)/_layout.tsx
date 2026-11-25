import { Redirect, Stack } from 'expo-router';

import { Loading } from '@/components/Centered';
import { useSession } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

export default function ProtectedLayout() {
  const { session, loading } = useSession();
  const { colors } = useTheme();
  if (loading) return <Loading />;
  if (!session) return <Redirect href="/sign-in" />;
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        // Pushed screens turn the native header on (components/ui/BackHeader). It sits on the page's
        // own background with no hairline, so it reads as part of the page, not a separate bar.
        headerStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerTintColor: colors.primary,
      }}
    />
  );
}
