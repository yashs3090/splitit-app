// New group: one field (the name) and one button. On success it replaces itself with the group
// screen, with the invite panel open (`?invite=1`), so back from there goes to Home, not here.
// Spec: docs/specs/2026-11-26-groups-mvp.md T13 (criterion 63); C-G8 name rule (1..60 code points
// after normalizeTitle, A1.12); A1.6 client id: a retry after a lost response reuses the same id, so
// it returns the same group instead of making a second one. Decisions GR-T13-*.
// Signed-in only (the (app) layout). Never navigates on its own: only a successful Create does.
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextField } from '@/components/ui/TextField';
import { normalizeTitle } from '@/lib/groupExpense';
import { createGroup, createIntentId, groupNameProblem, type GroupError } from '@/lib/groups';
import { layout, space, type, useTheme } from '@/lib/theme';

const NEW_GROUP_COPY = {
  title: 'New group',
  intro: "Keep a trip's receipts and costs in one place. You'll get a link to invite people next.",
  nameLabel: 'Name',
  namePlaceholder: 'Tahoe trip',
  create: 'Create group',
  createHint: 'Creates the group and shows its invite link',
  empty: 'Give the group a name.',
  tooLong: 'Keep the name to 60 characters or fewer.',
  failed: "Couldn't create the group. Check your connection and try again.",
  back: 'Back',
} as const;

/** Server refusals the field can explain; anything else is the generic failure under the button. */
function fieldErrorFor(error: GroupError): string | null {
  return error === 'invalid_name' ? NEW_GROUP_COPY.tooLong : null;
}

export default function NewGroupScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // One id per intent (the trimmed name): a retry of the same name reuses it (A1.6).
  const intent = useRef(createIntentId());
  // State lands a render later; the ref stops a double tap from sending twice.
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function onChange(text: string) {
    setName(text);
    setFieldError(null);
    setSaveError(null);
  }

  async function onCreate() {
    if (savingRef.current) return;
    const problem = groupNameProblem(name);
    if (problem !== null) {
      setFieldError(problem === 'empty' ? NEW_GROUP_COPY.empty : NEW_GROUP_COPY.tooLong);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFieldError(null);
    setSaveError(null);
    const res = await createGroup(name, intent.current.idFor(normalizeTitle(name)));
    savingRef.current = false;
    if (!mounted.current) return;
    setSaving(false);
    if (res.ok) {
      intent.current.done();
      router.replace({ pathname: '/groups/[id]', params: { id: res.groupId, invite: '1' } });
      return;
    }
    // What was typed stays; the button is usable again.
    const forField = fieldErrorFor(res.error);
    if (forField !== null) setFieldError(forField);
    else {
      setSaveError(NEW_GROUP_COPY.failed);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(NEW_GROUP_COPY.failed);
    }
  }

  const onBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <>
      <BackHeader
        title={NEW_GROUP_COPY.title}
        back={{
          label: NEW_GROUP_COPY.back,
          accessibilityLabel: NEW_GROUP_COPY.back,
          accessibilityHint: router.canGoBack() ? 'Goes back' : 'Goes to Home',
          onPress: onBack,
          disabled: saving,
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
              {NEW_GROUP_COPY.title}
            </Text>
            <Text style={[type.body, { color: colors.textMuted }]}>{NEW_GROUP_COPY.intro}</Text>
          </View>

          <TextField
            label={NEW_GROUP_COPY.nameLabel}
            showLabel
            placeholder={NEW_GROUP_COPY.namePlaceholder}
            error={fieldError ?? undefined}
            value={name}
            onChangeText={onChange}
            onSubmitEditing={() => void onCreate()}
            editable={!saving}
            autoFocus
            autoCapitalize="sentences"
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
          />

          <View style={styles.actions}>
            <Button
              label={NEW_GROUP_COPY.create}
              accessibilityHint={NEW_GROUP_COPY.createHint}
              variant="primary"
              block
              loading={saving}
              onPress={() => void onCreate()}
            />
            {saveError !== null ? <StatusLine text={saveError} tone="error" size="caption" alert /> : null}
          </View>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  column: { width: '100%', maxWidth: layout.form, alignSelf: 'center', gap: space.xl },
  header: { gap: space.xs },
  actions: { gap: space.sm },
});
