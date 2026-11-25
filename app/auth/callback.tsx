import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Centered, Loading } from '@/components/Centered';
import { useSession } from '@/lib/auth';
import { describeOAuthCallbackError, exchangeCodeOnce } from '@/lib/oauth';
import { supabase } from '@/lib/supabase';
import { layout, space, type, useTheme } from '@/lib/theme';

/**
 * Native OAuth redirect target (`splitit://auth/callback?code=…`). Usually the sign-in
 * screen exchanges the code from openAuthSessionAsync's result, but on Android the deep
 * link can also land here (e.g. Custom Tabs reports `dismiss`). This screen never
 * navigates on success: it shows a loading state and the root layout's resume effect
 * decides where to go (pending invite or home). The exchange is deduplicated per code.
 */
export default function AuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const code = typeof params.code === 'string' && params.code ? params.code : null;
  const callbackError = typeof params.error === 'string' && params.error ? params.error : null;
  const { session, loading } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || session) return;
    if (callbackError) {
      setError(describeOAuthCallbackError(callbackError));
      return;
    }
    if (code === null) {
      router.replace('/sign-in');
      return;
    }
    let active = true;
    void exchangeCodeOnce(supabase.auth, code).then((outcome) => {
      if (active && outcome.status === 'error') setError(outcome.message);
    });
    return () => {
      active = false;
    };
  }, [code, callbackError, session, loading, router]);

  if (error) {
    return (
      <Centered>
        <Text accessibilityRole="alert" style={[type.body, styles.message, { color: colors.text }]}>
          {error}
        </Text>
        <Link href="/sign-in" style={[type.label, styles.link, { color: colors.primary }]}>
          Back to sign-in
        </Link>
      </Centered>
    );
  }
  return <Loading />;
}

const styles = StyleSheet.create({
  message: { textAlign: 'center', maxWidth: layout.message },
  // Looks like a ghost button (label type, primary color) with a 44-pt target (20 line + 2 × 12),
  // but stays a real link: role "link" and an <a href> on web.
  link: { paddingHorizontal: space.lg, paddingVertical: space.md },
});
