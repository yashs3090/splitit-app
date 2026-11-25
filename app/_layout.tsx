import { Stack, useRouter, useSegments } from 'expo-router';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';

import { AuthProvider, useSession } from '@/lib/auth';
import { postSignInRoute, takePendingInvite } from '@/lib/pendingInvite';
import { storage } from '@/lib/storage';
import { useTheme } from '@/lib/theme';

type AuthPhase = 'loading' | 'signed-out' | 'signed-in';

/**
 * The single place that resumes a pending invite after sign-in.
 *
 * Runs when the session becomes available: after a sign-in in this app session
 * (signed-out → signed-in), or on first load (covers the web OAuth redirect
 * landing on `/`). Also moves a signed-in user off the sign-in and OAuth callback screens.
 */
function ResumeAfterSignIn() {
  const { session, loading } = useSession();
  const router = useRouter();
  // Typed routes are off, so read segments as plain strings.
  const segments: readonly string[] = useSegments();
  // Screens a signed-in user shouldn't stay on: sign-in, and the native OAuth callback.
  const onAuthScreen = segments[0] === '(auth)' || (segments[0] === 'auth' && segments[1] === 'callback');
  const previous = useRef<AuthPhase>('loading');

  useEffect(() => {
    if (loading) return;
    const was = previous.current;
    const now: AuthPhase = session ? 'signed-in' : 'signed-out';
    previous.current = now;
    if (now !== 'signed-in') return;

    const justSignedIn = was === 'signed-out';
    const firstLoad = was === 'loading';
    if (!justSignedIn && !firstLoad && !onAuthScreen) return;

    void (async () => {
      const code = await takePendingInvite(storage, Date.now());
      if (code !== null) {
        router.replace(postSignInRoute(code));
      } else if (justSignedIn || onAuthScreen) {
        router.replace('/');
      }
      // First load with no invite: stay on whatever URL was opened (e.g. reload of /b/<code>).
    })();
  }, [session, loading, onAuthScreen, router]);

  return null;
}

export default function RootLayout() {
  const { colors } = useTheme();
  // The root view behind every screen (seen during transitions, keyboard animations and, on web,
  // overscroll) follows the color scheme. app.json's single backgroundColor can't. Best effort: a
  // failure only leaves the platform default showing.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);
  return (
    <AuthProvider>
      <ResumeAfterSignIn />
      {/* Every screen's card paints the theme background (React Navigation's default is light). */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
    </AuthProvider>
  );
}
