import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Centered } from '@/components/Centered';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { Banner, BannerText } from '@/components/ui/Banner';
import { useSession } from '@/lib/auth';
import { signInWithGoogleNative, signInWithGoogleWeb, type SignInOutcome } from '@/lib/oauth';
import { supabase } from '@/lib/supabase';
import { layout, space, type, useTheme } from '@/lib/theme';

function startGoogleSignIn(): Promise<SignInOutcome> {
  if (Platform.OS === 'web') {
    return signInWithGoogleWeb(supabase.auth, window.location.origin);
  }
  return signInWithGoogleNative({
    auth: supabase.auth,
    redirectTo: Linking.createURL('/auth/callback'),
    openAuthSession: (url, redirectUrl) => WebBrowser.openAuthSessionAsync(url, redirectUrl),
  });
}

export default function SignInScreen() {
  const { oauthError } = useSession();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(oauthError);

  async function onPress() {
    setBusy(true);
    setError(null);
    const outcome = await startGoogleSignIn();
    // 'redirecting' (web) leaves the page; 'signed-in' is picked up by the auth listener.
    if (outcome.status === 'error') setError(outcome.message);
    if (outcome.status === 'cancelled') setError('Sign-in was cancelled.');
    if (outcome.status !== 'redirecting') setBusy(false);
  }

  return (
    <Centered>
      <View style={styles.column}>
        <View style={styles.intro}>
          <Text accessibilityRole="header" style={[type.display, styles.center, { color: colors.text }]}>
            SplitIt
          </Text>
          <Text style={[type.body, styles.center, { color: colors.textMuted }]}>Sign in to split a bill.</Text>
        </View>
        <GoogleSignInButton label={busy ? 'Opening Google…' : 'Continue with Google'} busy={busy} onPress={onPress} />
        {error ? (
          <Banner tone="error" alert>
            <BannerText>{error}</BannerText>
          </Banner>
        ) : null}
      </View>
    </Centered>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: layout.message, gap: space.xl },
  intro: { gap: space.xs },
  center: { textAlign: 'center' },
});
