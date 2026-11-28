import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { AppBanner } from '@/components/AppBanner';
import { AuthProvider, useSession } from '@/lib/auth';
import { postSignInRoute, takePendingInvite } from '@/lib/pendingInvite';
import { settleResume, type ResumeKind } from '@/lib/resumeGate';
import { storage } from '@/lib/storage';
import { useTheme } from '@/lib/theme';

type AuthPhase = 'loading' | 'signed-out' | 'signed-in';

/**
 * The single place that resumes a pending invite after sign-in.
 *
 * Runs when the session becomes available: after a sign-in in this app session
 * (signed-out → signed-in), or on first load (covers the web OAuth redirect
 * landing on `/`). Also moves a signed-in user off the sign-in and OAuth callback screens.
 *
 * It also settles the resume gate (lib/resumeGate.ts, sent-via-Venmo F10) once per launch, so the
 * notification responder knows whether a cold-start response may navigate: 'none' only when this
 * effect found nothing to do on a restored session; 'signed_in' whenever it navigated, failed, or
 * the app started signed out (a sign-in then owns navigation). The first call wins.
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
    if (now !== 'signed-in') {
      // Started signed out: a cold-start notification response must wait for a sign-in, which navigates.
      if (was === 'loading') settleResume('signed_in');
      return;
    }

    const justSignedIn = was === 'signed-out';
    const firstLoad = was === 'loading';
    // A later run with nothing to resume: an earlier run already settled the gate (or will, in its finally).
    if (!justSignedIn && !firstLoad && !onAuthScreen) return;

    void (async () => {
      // Every way out settles the gate, so whenResumed() can't wait on this run forever.
      let kind: ResumeKind = 'signed_in';
      try {
        const code = await takePendingInvite(storage, Date.now());
        if (code !== null) {
          router.replace(postSignInRoute(code));
        } else if (justSignedIn || onAuthScreen) {
          router.replace('/');
        } else {
          // First load with no invite: stay on whatever URL was opened (e.g. reload of /b/<code>).
          kind = 'none';
        }
      } finally {
        settleResume(kind);
      }
    })();
  }, [session, loading, onAuthScreen, router]);

  return null;
}

export default function RootLayout() {
  // useTheme() follows the Appearance choice (Auto / Light / Dark, lib/themePreference.ts), so the
  // root view, every stack's background and the status bar below all follow it too.
  const { colors, scheme } = useTheme();
  // The root view behind every screen (seen during transitions, keyboard animations and, on web,
  // overscroll) follows the color scheme. app.json's single backgroundColor can't. Best effort: a
  // failure only leaves the platform default showing.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);
  // Every screen's card paints the theme background (React Navigation's default is light).
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
  return (
    <AuthProvider>
      {/* Dark text on a light screen and light text on a dark one; "auto" would follow the device, not the choice. Renders nothing on web. */}
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <ResumeAfterSignIn />
      {Platform.OS === 'web' ? (
        // Web only: the "Get the app" bar sits above every screen and pushes it down (never covers
        // it). It renders nothing on desktop, when dismissed or with no store URL configured, and it
        // never navigates, so the resume effect above stays the only post-sign-in navigation. While
        // it shows it takes the top safe-area inset and the screens below get top 0 (AB-11).
        <AppBanner>{stack}</AppBanner>
      ) : (
        stack
      )}
    </AuthProvider>
  );
}
