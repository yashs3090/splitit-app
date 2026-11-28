import { Redirect, Stack } from 'expo-router';

import { Loading } from '@/components/Centered';
import { ChooseUsername, UsernameCheckFailed } from '@/components/ChooseUsername';
import { SentCheckResponder } from '@/components/SentCheckResponder';
import { useSession } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { useUsernameStatus } from '@/lib/useUsernameStatus';

/**
 * The tabs sit under every pushed screen (docs/specs/2026-11-28-tab-bar-and-activity.md Task 5). A cold
 * deep link (/bills/<id>, /groups/<id>, /scan) builds its state with (tabs) below it, so Back returns
 * to the tabs. Verified in expo-router 57.0.31: getRoutesCore reads `unstable_settings.anchor ?? unstable_settings.initialRouteName` (`anchor` is the current name;
 * initialRouteName is deprecated) from a layout, and getStateFromPath puts that route first.
 */
export const unstable_settings = { anchor: '(tabs)' };

export default function ProtectedLayout() {
  const { session, loading } = useSession();
  const { colors } = useTheme();
  // Before any early return (rules of hooks). Signed out (null) is idle and reads nothing.
  const username = useUsernameStatus(session?.user.id ?? null);
  if (loading) return <Loading />;
  if (!session) return <Redirect href="/sign-in" />;
  // "Choose your username" (docs/specs/2026-11-28-usernames.md A3.6–A3.10): while the username is
  // provisional, the step renders in place of the Stack. No navigation and no URL change, so the
  // route the person opened (a deep link, a resumed invite) is what shows once they pick. It can't
  // be skipped; a failed or timed-out read offers Try again and Sign out, never an endless spinner.
  const gate =
    username.status === 'error' ? (
      <UsernameCheckFailed onRetry={username.retry} />
    ) : username.status !== 'ready' ? (
      <Loading />
    ) : !username.locked ? (
      <ChooseUsername key={session.user.id} provisional={username.username} onLocked={username.markLocked} onRecheck={username.retry} />
    ) : null;
  return (
    <>
      {/* Answers to the "did it go through?" notification (signed in only; renders nothing). Above the
          gate, so a tap during the username step is still handled (its push lands under the step). */}
      <SentCheckResponder />
      {gate ?? <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          // Pushed screens turn the native header on (components/ui/BackHeader). It sits on the page's
          // own background with no hairline, so it reads as part of the page, not a separate bar.
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.primary,
        }}
      />}
    </>
  );
}
