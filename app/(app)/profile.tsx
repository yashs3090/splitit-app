// Profile: your name, your Venmo username (so friends can pay you), the people you've split with, and sign out.
// Spec: docs/specs/2026-11-24-profile-venmo.md (Task 4, criteria 27–30); the People card is
// docs/specs/2026-11-24-people-and-invites.md (D6, Task 6, criteria 38–41).
// This screen never navigates after sign-in; app/_layout.tsx's resume effect is the only one that does (D4).
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PeopleList } from '@/components/PeopleList';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextField } from '@/components/ui/TextField';
import { defaultTimeFormatters } from '@/lib/activityText';
import { useSession } from '@/lib/auth';
import { displayNameFor } from '@/lib/displayName';
import { PEOPLE_COPY } from '@/lib/peopleView';
import { getMyProfile, SAVE_VENMO_ERROR_COPY, saveVenmoUsername } from '@/lib/profile';
import { signOutThisDevice } from '@/lib/signOut';
import { layout, space, type, useTheme } from '@/lib/theme';
import { usePeople } from '@/lib/usePeople';
import { normalizeVenmoUsername, VENMO_USERNAME_ERROR } from '@/lib/venmo';

const LOAD_ERROR = "Couldn't load your profile.";
const SIGN_OUT_ERROR = 'Sign-out failed. Please try again.';
const SAVED = 'Saved';

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      displayName: string | null;
      venmoUsername: string | null;
    };

export default function ProfileScreen() {
  const { session } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const userId = session?.user.id ?? '';

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [input, setInput] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  // Refs guard against double presses (state updates land a render later) and late responses.
  const savingRef = useRef(false);
  const signingOutRef = useRef(false);
  const latestLoad = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const fetchProfile = useCallback(() => {
    const mine = ++latestLoad.current;
    setLoad({ status: 'loading' });
    void getMyProfile(userId).then((res) => {
      if (!mounted.current || mine !== latestLoad.current) return;
      if (!res.ok) {
        setLoad({ status: 'error' });
        return;
      }
      setLoad({
        status: 'ready',
        displayName: res.displayName,
        venmoUsername: res.venmoUsername,
      });
      setInput(res.venmoUsername ?? '');
    });
  }, [userId]);

  useEffect(() => {
    if (userId) fetchProfile();
  }, [userId, fetchProfile]);

  const saved = load.status === 'ready' ? load.venmoUsername : null;
  const normalized = normalizeVenmoUsername(input);
  // Nothing to save while the input means the same as what's stored (" @abcde " vs "abcde").
  const unchanged = normalized.ok && normalized.value === saved;

  async function onSave() {
    if (load.status !== 'ready' || savingRef.current || unchanged) return;
    if (!normalized.ok) {
      setFieldError(normalized.message);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFieldError(null);
    setSaveError(null);
    setJustSaved(false);
    const res = await saveVenmoUsername(userId, input, saved);
    savingRef.current = false;
    if (!mounted.current) return;
    setSaving(false);
    if (res.ok) {
      setLoad({ ...load, venmoUsername: res.value });
      setInput(res.value ?? '');
      setJustSaved(true);
      // iOS VoiceOver ignores live regions; Android and web read the "Saved" text's live region.
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SAVED);
    } else if (res.reason === 'invalid') {
      setFieldError(VENMO_USERNAME_ERROR);
    } else {
      setSaveError(SAVE_VENMO_ERROR_COPY[res.reason]);
    }
  }

  function onChangeVenmo(text: string) {
    setInput(text);
    setFieldError(null);
    setSaveError(null);
    setJustSaved(false);
  }

  async function onSignOut() {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    setSigningOut(true);
    setSignOutError(null);
    const res = await signOutThisDevice();
    signingOutRef.current = false;
    // On success the (app) layout sees no session and redirects to /sign-in, unmounting this screen.
    if (!mounted.current) return;
    setSigningOut(false);
    if (!res.ok) setSignOutError(SIGN_OUT_ERROR);
  }

  const onBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <>
      <BackHeader
        title="Profile"
        back={{
          label: 'Back',
          accessibilityLabel: 'Back',
          accessibilityHint: router.canGoBack() ? 'Goes back' : 'Goes to Home',
          onPress: onBack,
        }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={styles.column}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              Profile
            </Text>
            {load.status === 'ready' ? (
              // Muted so it reads as the title's subtitle, not a second title.
              <Text style={[type.body, { color: colors.textMuted }]}>
                {load.displayName ?? displayNameFor(session?.user)}
              </Text>
            ) : null}
          </View>

          {load.status === 'loading' ? (
            <ActivityIndicator
              accessibilityLabel="Loading your profile"
              color={colors.textMuted}
              style={styles.spinner}
            />
          ) : load.status === 'error' ? (
            <Card>
              <Text accessibilityRole="alert" style={[type.body, { color: colors.text }]}>
                {LOAD_ERROR}
              </Text>
              <Button label="Try again" variant="secondary" onPress={fetchProfile} />
            </Card>
          ) : (
            <Card>
              <TextField
                label="Venmo username"
                showLabel
                prefix="@"
                placeholder="your-username"
                hint="Friends pay you here."
                error={fieldError ?? undefined}
                value={input}
                onChangeText={onChangeVenmo}
                onSubmitEditing={() => void onSave()}
                editable={!saving}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                textContentType="none"
                returnKeyType="done"
              />
              <Button
                label="Save"
                accessibilityLabel="Save Venmo username"
                accessibilityHint={
                  unchanged ? 'Nothing to save. Edit your username first.' : 'Saves it to your profile'
                }
                variant="primary"
                block
                disabled={unchanged}
                loading={saving}
                onPress={() => void onSave()}
              />
              {justSaved ? <StatusLine text={SAVED} /> : null}
              {saveError ? (
                <Banner tone="error" alert>
                  <BannerText>{saveError}</BannerText>
                </Banner>
              ) : null}
            </Card>
          )}

          <PeopleCard userId={userId} />

          {/* BILL HISTORY (v1): past bills go here, between the Venmo section and Sign out. Not built yet; no placeholder. */}

          <View style={styles.footer}>
            {signOutError ? (
              <Banner tone="error" alert>
                <BannerText>{signOutError}</BannerText>
              </Banner>
            ) : null}
            <Button
              label="Sign out"
              accessibilityLabel="Sign out"
              accessibilityHint="Signs you out on this device"
              variant="ghost"
              loading={signingOut}
              onPress={() => void onSignOut()}
              style={styles.signOut}
            />
          </View>
        </View>
      </ScrollView>
    </>
  );
}

/** "People you've split with": display only; adding happens on a bill (Add people). */
function PeopleCard({ userId }: { userId: string }) {
  const { colors } = useTheme();
  const { load, reload } = usePeople(userId);
  return (
    <Card title={PEOPLE_COPY.cardTitle}>
      {load.status === 'loading' ? (
        <ActivityIndicator accessibilityLabel={PEOPLE_COPY.loading} color={colors.textMuted} style={styles.spinner} />
      ) : load.status === 'error' ? (
        <>
          <Text accessibilityRole="alert" style={[type.body, { color: colors.text }]}>
            {PEOPLE_COPY.loadError}
          </Text>
          <Button
            label={PEOPLE_COPY.tryAgain}
            accessibilityHint="Loads the people you've split with again"
            variant="secondary"
            onPress={reload}
          />
        </>
      ) : (
        <PeopleList people={load.people} formatDate={defaultTimeFormatters.date} emptyText={PEOPLE_COPY.emptyProfile} />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  header: { gap: space.xs },
  spinner: { alignSelf: 'flex-start' },
  // Sign out sits apart from everything above it: 24 (section gap) + 8 = 32.
  footer: { gap: space.md, marginTop: space.sm },
  signOut: { alignSelf: 'center' },
});
