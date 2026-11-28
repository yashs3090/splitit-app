// "Choose your username": the one-time pick, shown by app/(app)/_layout.tsx in place of the app while
// the signed-in user's username is still provisional (docs/specs/2026-11-28-usernames.md A3.6–A3.10).
// Not a route: the URL the person opened (/bills/<id>, a resumed invite, /) stays as it is, so once the
// pick lands the layout shows that screen. This component never navigates.
//
// - The field starts with the provisional name; "Keep @name" picks it in one tap (A3.6).
// - Validated as you type (lib/username validateUsername); set_username still decides (taken in between).
// - On "taken": suggestTakenAlternatives, filtered through usernamesAvailable, shows only free names;
//   tapping one fills the field (A3.5).
// - It can't be skipped (A3.10): no Skip, Later or close, Android back is swallowed, and web back lands
//   on another (app) route, which shows this step again. Sign out is the only other way out.
// - 'locked' (picked on another device): treated as done; the layout reads the status again.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, BackHandler, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered } from '@/components/Centered';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { TextLink } from '@/components/ui/TextLink';
import { setUsername, usernamesAvailable, type SetUsernameReason } from '@/lib/profile';
import { signOutThisDevice } from '@/lib/signOut';
import { layout, space, type, useTheme } from '@/lib/theme';
import {
  atUsername,
  normalizeUsername,
  suggestTakenAlternatives,
  USERNAME_ERROR_COPY,
  USERNAME_GATE_COPY as COPY,
  validateUsername,
} from '@/lib/username';

/** Failures that are about the name itself: shown under the field. The rest go in a banner. */
const FIELD_REASONS: ReadonlySet<SetUsernameReason> = new Set([
  'too_short',
  'too_long',
  'invalid_chars',
  'bad_dots',
  'reserved',
  'taken',
  'invalid',
]);

type Props = {
  /** The provisional username from sign-up. */
  provisional: string;
  /** set_username succeeded: the stored value. */
  onLocked: (username: string) => void;
  /** Read the status again ('locked' from another device). */
  onRecheck: () => void;
};

export function ChooseUsername({ provisional, onLocked, onRecheck }: Props) {
  const { colors } = useTheme();
  const [input, setInput] = useState(provisional);
  const [saveReason, setSaveReason] = useState<SetUsernameReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const savingRef = useRef(false);
  // Bumped on every edit, so a suggestions answer for an older name is dropped.
  const edit = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useStayOnStep();

  const normalized = normalizeUsername(input);
  const valid = validateUsername(normalized);
  const isKeep = normalized === provisional;
  const fieldError = !valid.ok
    ? USERNAME_ERROR_COPY[valid.reason]
    : saveReason !== null && FIELD_REASONS.has(saveReason)
      ? USERNAME_ERROR_COPY[saveReason]
      : undefined;
  const bannerError = saveReason !== null && !FIELD_REASONS.has(saveReason) ? USERNAME_ERROR_COPY[saveReason] : null;

  async function showFreeAlternatives(taken: string) {
    const mine = edit.current;
    let candidates: string[];
    try {
      candidates = suggestTakenAlternatives(taken, Math.random);
    } catch {
      return;
    }
    const res = await usernamesAvailable(candidates);
    if (!mounted.current || mine !== edit.current || !res.ok) return;
    setSuggestions(res.available);
  }

  async function save(raw: string) {
    if (savingRef.current) return;
    if (!validateUsername(normalizeUsername(raw)).ok) return;
    savingRef.current = true;
    setSaving(true);
    setSaveReason(null);
    const res = await setUsername(raw, provisional);
    savingRef.current = false;
    if (!mounted.current) return;
    setSaving(false);
    if (res.ok) {
      if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(COPY.saved);
      onLocked(res.value);
      return;
    }
    if (res.reason === 'locked') {
      // Picked on another device: done here too. The layout's fresh read lets the person through.
      onRecheck();
      return;
    }
    setSaveReason(res.reason);
    if (res.reason === 'taken') void showFreeAlternatives(normalizeUsername(raw));
  }

  function onChange(text: string) {
    edit.current += 1;
    setInput(text);
    setSaveReason(null);
    setSuggestions([]);
  }

  function fill(name: string) {
    edit.current += 1;
    setInput(name);
    setSaveReason(null);
  }

  function keep() {
    fill(provisional);
    void save(provisional);
  }

  const primaryLabel = !valid.ok ? COPY.useInvalid : isKeep ? COPY.keep(provisional) : COPY.use(normalized);

  return (
    <StepFrame>
      <View style={styles.intro}>
        <Text accessibilityRole="header" style={[type.title, styles.center, { color: colors.text }]}>
          {COPY.title}
        </Text>
        <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{COPY.intro}</Text>
      </View>

      <View style={styles.form}>
        <TextField
          label={COPY.fieldLabel}
          showLabel
          prefix="@"
          value={input}
          onChangeText={onChange}
          onSubmitEditing={() => void save(input)}
          error={fieldError}
          editable={!saving}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          textContentType="none"
          returnKeyType="done"
          maxLength={40}
        />

        {suggestions.length > 0 ? (
          <View style={styles.suggestions}>
            <Text style={[type.caption, { color: colors.textMuted }]}>{COPY.suggestionsTitle}</Text>
            <View style={styles.chips}>
              {suggestions.map((name) => (
                <Button
                  key={name}
                  label={atUsername(name)}
                  accessibilityLabel={COPY.suggestionLabel(name)}
                  accessibilityHint={COPY.suggestionHint}
                  variant="secondary"
                  disabled={saving}
                  onPress={() => fill(name)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <Button
          label={primaryLabel}
          accessibilityHint={valid.ok ? COPY.saveHint : COPY.invalidHint}
          variant="primary"
          block
          disabled={!valid.ok}
          loading={saving}
          onPress={() => void save(input)}
        />
        {!isKeep ? (
          <TextLink
            label={COPY.keep(provisional)}
            accessibilityHint={COPY.saveHint}
            disabled={saving}
            onPress={keep}
            style={styles.centerSelf}
          />
        ) : null}

        {bannerError ? (
          <Banner tone="error" alert>
            <BannerText>{bannerError}</BannerText>
          </Banner>
        ) : null}
      </View>

      <SignOut />
    </StepFrame>
  );
}

/** The status read failed or timed out: never an endless spinner. Try again, or sign out. */
export function UsernameCheckFailed({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme();
  useStayOnStep();
  return (
    <Centered>
      <View style={styles.column}>
        <Text accessibilityRole="alert" style={[type.body, styles.center, { color: colors.text }]}>
          {COPY.loadError}
        </Text>
        <Button label={COPY.tryAgain} accessibilityHint={COPY.tryAgainHint} variant="primary" block onPress={onRetry} />
        <SignOut />
      </View>
    </Centered>
  );
}

/** Android's back button stays on the step (A3.10). Web back is covered by the gate itself. */
function useStayOnStep() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);
}

function StepFrame({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.column}>{children}</View>
    </ScrollView>
  );
}

/** Signing out is always possible from the step (A3.10). Same action and copy as Profile's. */
function SignOut() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function onPress() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const res = await signOutThisDevice();
    busyRef.current = false;
    // On success the layout sees no session and redirects to /sign-in, unmounting this.
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) setFailed(true);
  }

  return (
    <View style={styles.footer}>
      {failed ? (
        <Banner tone="error" alert>
          <BannerText>{COPY.signOutError}</BannerText>
        </Banner>
      ) : null}
      <Button
        label={COPY.signOut}
        accessibilityHint={COPY.signOutHint}
        variant="ghost"
        loading={busy}
        onPress={() => void onPress()}
        style={styles.signOut}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: layout.screenPadding },
  column: { width: '100%', maxWidth: layout.message, alignSelf: 'center', gap: space.xl },
  intro: { gap: space.xs },
  form: { gap: space.lg },
  center: { textAlign: 'center' },
  centerSelf: { alignSelf: 'center' },
  suggestions: { gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  footer: { gap: space.md, marginTop: space.sm },
  signOut: { alignSelf: 'center' },
});
