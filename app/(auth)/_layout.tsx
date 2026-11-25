import { Stack } from 'expo-router';

import { Loading } from '@/components/Centered';
import { useSession } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

export default function AuthLayout() {
  const { session, loading } = useSession();
  const { colors } = useTheme();
  // Signed in: the root layout's resume effect decides where to go (invite or home).
  if (loading || session) return <Loading />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
