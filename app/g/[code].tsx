// The group invite link /g/<code> (QR codes and shared links open it). Signed out: remember it as
// `g-<code>` and go to sign-in; the root layout's single resume effect brings the person back here
// afterwards (postSignInRoute). Signed in: join (idempotent: someone already in the group just
// lands on it), then replace this screen with the group.
// Spec: docs/specs/2026-11-26-groups-mvp.md T13 (criterion 64), GR-29; same shape as app/b/[code].tsx.
// The code from the URL is never shown; every message is fixed copy (lessons 2026-11-19).
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';

import { Centered, Loading } from '@/components/Centered';
import { Button } from '@/components/ui/Button';
import { useSession } from '@/lib/auth';
import { GROUP_ERROR_COPY, joinGroup } from '@/lib/groups';
import { clearPendingInvite, normalizeGroupCode, savePendingGroupInvite } from '@/lib/pendingInvite';
import { storage } from '@/lib/storage';
import { layout, space, type, useTheme } from '@/lib/theme';

const COPY = {
  notValid: "This invite link isn't valid.",
  joining: 'Joining the group',
  failed: "Couldn't join the group. Try again.",
  tryAgain: 'Try again',
  goHome: 'Go home',
} as const;

export default function GroupInviteScreen() {
  const params = useLocalSearchParams<{ code: string }>();
  const code = normalizeGroupCode(params.code);
  const { session, loading } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const signedIn = session !== null;

  useEffect(() => {
    if (loading || code === null) return;
    if (signedIn) {
      // Opened while signed in (or resumed here): nothing left to resume.
      void clearPendingInvite(storage);
      return;
    }
    let active = true;
    void (async () => {
      try {
        await savePendingGroupInvite(storage, code, Date.now());
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
        <Text style={[type.body, styles.message, { color: colors.text }]}>{COPY.notValid}</Text>
        <Link href="/" style={[type.label, styles.link, { color: colors.primary }]}>
          {COPY.goHome}
        </Link>
      </Centered>
    );
  }
  if (loading || !signedIn) return <Loading />;
  return <JoinGroup code={code} />;
}

type JoinState = { status: 'joining' } | { status: 'refused'; message: string } | { status: 'failed' };

/** Signed in with a well-formed code: one join per attempt, then the group. */
function JoinGroup({ code }: { code: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const [state, setState] = useState<JoinState>({ status: 'joining' });
  const [attempt, setAttempt] = useState(0);
  // One join per attempt, even if the effect runs twice (Strict Mode, re-renders); a mounted flag
  // rather than a per-run cleanup, so the first run's result still lands (as app/b/[code].tsx).
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
    void joinGroup(code).then((res) => {
      if (!mounted.current) return;
      // withAnchor: the tabs go under the group, so Back (and the back gesture) reach Tabs (tab-bar spec 32f).
      if (res.ok) router.replace(`/groups/${res.groupId}`, { withAnchor: true });
      else if (res.error === 'invalid_code' || res.error === 'group_full') setState({ status: 'refused', message: GROUP_ERROR_COPY[res.error] });
      else setState({ status: 'failed' });
    });
  }, [attempt, code, router]);

  if (state.status === 'joining') {
    return (
      <Centered>
        <ActivityIndicator accessibilityLabel={COPY.joining} color={colors.textMuted} />
      </Centered>
    );
  }
  const failed = state.status === 'failed';
  return (
    <Centered>
      <Text accessibilityRole="alert" style={[type.body, styles.message, { color: colors.text }]}>
        {failed ? COPY.failed : state.message}
      </Text>
      {failed ? (
        <Button
          label={COPY.tryAgain}
          variant="primary"
          onPress={() => {
            setState({ status: 'joining' });
            setAttempt((n) => n + 1);
          }}
        />
      ) : null}
      <Button label={COPY.goHome} variant={failed ? 'ghost' : 'primary'} onPress={() => router.replace('/')} />
    </Centered>
  );
}

const styles = StyleSheet.create({
  message: { textAlign: 'center', maxWidth: layout.message },
  // Looks like a ghost button (label type, primary color, 44-pt target) but stays a real link.
  link: { paddingHorizontal: space.lg, paddingVertical: space.md },
});
