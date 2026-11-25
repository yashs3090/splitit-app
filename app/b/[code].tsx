// The invite link /b/<code>. Signed out: remember the invite and go to sign-in (the root layout's
// single resume effect brings the person back here afterwards). Signed in: join, then open the bill.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 12, criteria 94–97).
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Centered, Loading } from '@/components/Centered';
import { Button } from '@/components/ui/Button';
import { useSession } from '@/lib/auth';
import { BILL_ERROR_COPY, joinBill } from '@/lib/bills';
import { clearPendingInvite, normalizeInviteCode, savePendingInvite } from '@/lib/pendingInvite';
import { storage } from '@/lib/storage';
import { layout, space, type, useTheme } from '@/lib/theme';

export default function InviteScreen() {
  const params = useLocalSearchParams<{ code: string }>();
  const code = normalizeInviteCode(params.code);
  const { session, loading } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const signedIn = session !== null;

  useEffect(() => {
    if (loading || code === null) return;
    if (signedIn) {
      void clearPendingInvite(storage);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await savePendingInvite(storage, code, Date.now());
      } catch {
        // Storage failed: still send them to sign in; they can reopen the link afterwards.
      }
      if (active) router.replace('/sign-in');
    })();
    return () => {
      active = false;
    };
  }, [code, signedIn, loading, router]);

  if (code === null) {
    return (
      <Centered>
        <Text style={[type.body, styles.message, { color: colors.text }]}>This invite link isn&apos;t valid.</Text>
        <Link href="/" style={[type.label, styles.link, { color: colors.primary }]}>
          Go home
        </Link>
      </Centered>
    );
  }
  if (loading || !signedIn) return <Loading />;
  return <JoinBill code={code} />;
}

const JOIN_FAILED = "Couldn't join. Try again.";

type JoinState = { status: 'joining' } | { status: 'invalid' } | { status: 'failed' };

/**
 * Signed in with a well-formed code: join the bill once (join_bill), then open it. The code from
 * the URL is never shown; failures use fixed copy only (lessons: never echo URL text).
 */
function JoinBill({ code }: { code: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const [state, setState] = useState<JoinState>({ status: 'joining' });
  const [attempt, setAttempt] = useState(0);
  // One join per attempt, even if the effect runs twice (Strict Mode, re-renders).
  // A mounted flag rather than a per-run cleanup: with the guard, a re-run never repeats the call,
  // so the first run's result must still be applied.
  const started = useRef(-1);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (started.current === attempt) return;
    started.current = attempt;
    void joinBill(code).then((res) => {
      if (!mounted.current) return;
      if (res.ok) router.replace(`/bills/${res.billId}`);
      else setState({ status: res.error === 'invalid_code' ? 'invalid' : 'failed' });
    });
  }, [attempt, code, router]);

  if (state.status === 'joining') return <Loading />;
  return (
    <Centered>
      <Text style={[type.body, styles.message, { color: colors.text }]}>
        {state.status === 'invalid' ? BILL_ERROR_COPY.invalid_code : JOIN_FAILED}
      </Text>
      {state.status === 'failed' ? (
        <Button
          label="Try again"
          variant="primary"
          onPress={() => {
            setState({ status: 'joining' });
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
      <Button label="Go home" variant={state.status === 'invalid' ? 'primary' : 'ghost'} onPress={() => router.replace('/')} />
    </Centered>
  );
}

const styles = StyleSheet.create({
  message: { textAlign: 'center', maxWidth: layout.message },
  // Looks like the ghost "Go home" button below (label type, primary color, 44-pt target:
  // 20 line + 2 × 12) but stays a real link: role "link" and an <a href> on web.
  link: { paddingHorizontal: space.lg, paddingVertical: space.md },
});
