// Add or edit a simple group expense ("Ana paid $240 for the Airbnb"). `?expense=<id>` means edit.
// Spec: docs/specs/2026-11-26-groups-mvp.md T15 (criteria 70–73, 114), as amended by A1 (GR-T8-1,
// GR-T8-2), A2 and A3. Decisions GR-T15-*.
//
// Rules this screen keeps:
// - The form, its checks, previews and copy come from lib/groupExpenseForm.ts (which calls
//   lib/groupExpense.ts). The screen does no money math and writes no strings.
// - Data: one group_snapshot read (lib/useGroupSnapshot.ts). The form is filled once; a later
//   refetch only refreshes an untouched edit form. An edit sends the version it was loaded from; if
//   someone saved in between (version_changed) the typed values stay, the screen refetches, and
//   "Show their changes" brings the saved expense in. The next Save sends the refetched version.
// - Save is disabled until the form is valid (the reason shows under it). A double tap sends one
//   call (a ref). A failed save keeps the input and re-enables Save. Saving an unchanged edit sends
//   nothing. A retried add reuses its client id (lib/groups.ts createIntentId).
// - Only the creator or the payer can edit or delete (C-G9, GR-M2); anyone else sees a read-only
//   summary.
// - Unsaved input asks "Discard…?" on every exit the navigator sees: the back control, iOS
//   back-swipe and Android back (usePreventRemove). Browser back on web resets the navigator
//   without asking it, so it can't be stopped; reload and closing the tab ask through the
//   browser's own prompt (beforeunload). GR-T15-4.
// - Save sits in a footer outside the scroll, inside a KeyboardAvoidingView, so the keyboard never
//   covers it.
// - The `expense` param is only looked up, never shown. State is keyed on group, expense and viewer.
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { HeaderHeightContext, usePreventRemove, type NavigationAction } from 'expo-router/react-navigation';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { ExpenseCheckRow, ExpensePayerRow } from '@/components/ExpenseFormRows';
import { GroupDeletedState } from '@/components/GroupDeletedState';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { MoneyText } from '@/components/ui/MoneyText';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextField } from '@/components/ui/TextField';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import { expensePayload, type SplitMethod } from '@/lib/groupExpense';
import {
  amountFieldError,
  canEditExpense,
  deleteConfirmText,
  draftOf,
  emptyForm,
  equalRowA11yLabel,
  equalRows,
  exactFieldLabel,
  exactLine,
  EXPENSE_SCREEN_COPY as COPY,
  formFromExpense,
  footerNote,
  formsEqual,
  intentKey,
  isNoopSave,
  saveBlockText,
  shareFieldError,
  readOnlySummary,
  type ExpenseForm,
} from '@/lib/groupExpenseForm';
import {
  addExpense,
  createIntentId,
  deleteExpense,
  editExpense,
  GROUP_ERROR_COPY,
  type GroupError,
  type GroupSnapshot,
  type SnapshotExpense,
} from '@/lib/groups';
import { groupNameOf } from '@/lib/groupScreenText';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useGroupSnapshot } from '@/lib/useGroupSnapshot';

type Back = { label: string; accessibilityLabel: string; accessibilityHint: string; onPress: () => void; disabled?: boolean };

export default function ExpenseRoute() {
  const params = useLocalSearchParams<{ id?: string | string[]; expense?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const expenseId = typeof params.expense === 'string' && params.expense !== '' ? params.expense : null;
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  // Another group, expense or account is a new screen: nothing typed carries over.
  return <ExpenseScreen key={`${id}:${expenseId ?? 'new'}:${myId}`} id={id} expenseId={expenseId} myId={myId} />;
}

function ExpenseScreen({ id, expenseId, myId }: { id: string; expenseId: string | null; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, version, finished, refetch } = useGroupSnapshot(id);
  const toGroup = useCallback(() => router.dismissTo({ pathname: '/groups/[id]', params: { id } }), [router, id]);
  const back: Back = { label: COPY.back, accessibilityLabel: COPY.backA11y, accessibilityHint: COPY.backHint, onPress: toGroup };
  const barTitle = expenseId === null ? COPY.newTitle : COPY.editTitle;

  if (load.status === 'loading') {
    return (
      <>
        <BackHeader title={barTitle} back={back} />
        <Loading />
      </>
    );
  }
  // Delete group C8 (docs/specs/2026-11-28-delete-group.md T6, criterion 46): the group is gone.
  if (load.status === 'deleted') return <GroupDeletedState header={<BackHeader title={barTitle} back={back} />} />;
  if (load.status !== 'ready') {
    const notMember = load.status === 'not_allowed';
    return (
      <Centered>
        <BackHeader title={barTitle} back={back} />
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{notMember ? COPY.notMember : COPY.loadError}</Text>
        {notMember ? (
          <Button label={COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
        ) : (
          <Button label={COPY.tryAgain} variant="primary" onPress={() => refetch()} />
        )}
      </Centered>
    );
  }
  const stored = expenseId === null ? null : (load.snapshot.expenses.find((e) => e.id === expenseId) ?? null);
  if (expenseId !== null && stored === null) {
    // Deleted, or never in this group. The id itself is never shown.
    return (
      <Centered>
        <BackHeader title={barTitle} back={back} />
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{COPY.notFound}</Text>
        <Button label={COPY.backToGroup} variant="primary" onPress={toGroup} />
      </Centered>
    );
  }
  if (stored !== null && !canEditExpense(stored, myId)) {
    return <ReadOnlyExpense expense={stored} snapshot={load.snapshot} myId={myId} back={back} />;
  }
  return (
    <ExpenseEditor
      groupId={id}
      myId={myId}
      expenseId={expenseId}
      snapshot={load.snapshot}
      version={version}
      finished={finished}
      refetch={refetch}
      back={back}
      toGroup={toGroup}
    />
  );
}

/** C-G9: someone who is neither the creator nor the payer sees what was saved, and can't change it. */
function ReadOnlyExpense({ expense, snapshot, myId, back }: { expense: SnapshotExpense; snapshot: GroupSnapshot; myId: string; back: Back }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const nameOf = useMemo(() => groupNameOf(snapshot.members, myId), [snapshot, myId]);
  return (
    <>
      <BackHeader title={COPY.viewTitle} back={back} />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      >
        <View style={styles.column}>
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {expense.title}
            </Text>
            <MoneyText cents={expense.amountCents} size="display" />
            <Text style={[type.body, { color: colors.textMuted }]}>
              {readOnlySummary(nameOf(expense.payerId), expense.splitMethod)}
            </Text>
          </View>
          <Card flush>
            {expense.shares.map((s, i) => (
              <ListRow
                key={s.userId}
                title={nameOf(s.userId)}
                trailing={<MoneyText cents={s.cents} />}
                accessibilityLabel={equalRowA11yLabel(nameOf(s.userId), s.cents)}
                divider={i > 0}
              />
            ))}
          </Card>
          <Text style={[type.caption, { color: colors.textMuted }]}>{COPY.readOnlyNote}</Text>
        </View>
      </ScrollView>
    </>
  );
}

type EditorProps = {
  groupId: string;
  myId: string;
  expenseId: string | null;
  snapshot: GroupSnapshot;
  version: number;
  finished: number;
  refetch: () => number;
  back: Back;
  toGroup: () => void;
};

/** A version_changed in flight: `waitFor` is the refetch after it; `landed` once that refetch has the new data. */
type Conflict = { waitFor: number; landed: boolean };
/** Where to go once the guard is off: the group (after a save or delete), or the exit the guard caught. */
type Exit = { kind: 'group' } | { kind: 'action'; action: NavigationAction };

function ExpenseEditor({ groupId, myId, expenseId, snapshot, version, finished, refetch, back, toGroup }: EditorProps) {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const isEdit = expenseId !== null;

  const memberIds = useMemo(() => snapshot.members.map((m) => m.userId), [snapshot]);
  const nameOf = useMemo(() => groupNameOf(snapshot.members, myId), [snapshot, myId]);
  const latest = isEdit ? (snapshot.expenses.find((e) => e.id === expenseId) ?? null) : null;

  // The expense this form was loaded from (edit): its version is what Save sends.
  const [base, setBase] = useState<SnapshotExpense | null>(latest);
  const [initial, setInitial] = useState<ExpenseForm>(() => (latest ? formFromExpense(latest, memberIds) : emptyForm(memberIds, myId)));
  const [form, setForm] = useState<ExpenseForm>(initial);
  const [payerOpen, setPayerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [pendingExit, setPendingExit] = useState<Exit | null>(null);
  const [exit, setExit] = useState<Exit | null>(null);

  const busyRef = useRef(false);
  const mounted = useRef(true);
  const intent = useRef(createIntentId());
  const amountRef = useRef<TextInput>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const busy = saving || deleting;
  const dirty = !formsEqual(form, initial);

  // An untouched edit form follows a newer saved version (a focus refetch), so nobody hits a
  // conflict over changes they never made. A touched one keeps what was typed.
  useEffect(() => {
    if (latest === null || base === null || latest.version === base.version || dirty || conflict !== null) return;
    const next = formFromExpense(latest, memberIds);
    setBase(latest);
    setInitial(next);
    setForm(next);
  }, [latest, base, dirty, conflict, memberIds]);

  // The refetch after a version_changed has ended: with new data, the next Save uses the new
  // version and "Show their changes" appears; if it failed, say so with a retry.
  useEffect(() => {
    if (conflict === null || conflict.landed || finished < conflict.waitFor) return;
    if (version >= conflict.waitFor) {
      if (latest !== null) setBase(latest);
      setConflict({ ...conflict, landed: true });
      setRefreshFailed(false);
    } else {
      setRefreshFailed(true);
    }
  }, [conflict, finished, version, latest]);

  // The guard: every exit the navigator sees asks first while there's unsaved input.
  usePreventRemove(exit === null && (dirty || busy), ({ data }) => {
    if (busyRef.current) return; // a save or delete is in flight: stay
    setConfirmDelete(false);
    setPendingExit({ kind: 'action', action: data.action });
  });
  // Reload or closing the tab on web (browser back can't be stopped: GR-T15-4).
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need returnValue set to show their prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  // Leaves once the guard is off (the render with `exit` set has turned usePreventRemove off).
  useEffect(() => {
    if (exit === null) return;
    if (exit.kind === 'group') toGroup();
    else navigation.dispatch(exit.action);
  }, [exit, toGroup, navigation]);

  const draft = draftOf(form, memberIds);
  const payload = expensePayload(draft);
  const blockText = saveBlockText(form, memberIds);
  const note = footerNote(form, memberIds);

  const edit = (patch: Partial<ExpenseForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setSaveError(null);
    setPendingExit(null);
  };
  const toggle = (userId: string) =>
    edit({ equalChosen: form.equalChosen.includes(userId) ? form.equalChosen.filter((u) => u !== userId) : [...form.equalChosen, userId] });
  const setShare = (userId: string, text: string) => edit({ exactText: { ...form.exactText, [userId]: text } });

  const announce = (text: string) => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  };

  const failed = (error: GroupError, kind: 'save' | 'delete') => {
    if (error === 'version_changed') {
      setConfirmDelete(false);
      setConflict({ waitFor: refetch(), landed: false });
      announce(GROUP_ERROR_COPY.version_changed);
      return;
    }
    if (error === 'id_conflict') intent.current.done(); // the next try is a new intent
    // Someone left, or our rights changed: refetch so the screen shows the group as it is now.
    if (error === 'not_member' || error === 'not_allowed') refetch();
    const text = error === 'network' ? (kind === 'save' ? COPY.saveFailed : COPY.deleteFailed) : GROUP_ERROR_COPY[error];
    if (kind === 'save') setSaveError(text);
    else setDeleteError(text);
    announce(text);
  };

  async function onSave() {
    if (busyRef.current || payload === null) return;
    if (isEdit && base !== null && isNoopSave(payload, base, memberIds)) {
      // Nothing changed: no write, no Activity line.
      setExit({ kind: 'group' });
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    const res =
      isEdit && base !== null
        ? await editExpense({ id: base.id, expectedVersion: base.version, payload })
        : await addExpense({ id: intent.current.idFor(intentKey(payload)), groupId, payload });
    if (!mounted.current) return;
    busyRef.current = false;
    setSaving(false);
    if (res.ok) {
      intent.current.done();
      setConflict(null);
      setExit({ kind: 'group' });
      return;
    }
    failed(res.error, 'save');
  }

  async function onDelete() {
    if (busyRef.current || base === null) return;
    busyRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    const res = await deleteExpense(base.id, base.version);
    if (!mounted.current) return;
    busyRef.current = false;
    setDeleting(false);
    if (res.ok) {
      setExit({ kind: 'group' });
      return;
    }
    failed(res.error, 'delete');
  }

  const showTheirs = () => {
    if (latest === null) return;
    const next = formFromExpense(latest, memberIds);
    setBase(latest);
    setInitial(next);
    setForm(next);
    setConflict(null);
    setSaveError(null);
  };
  const retryRefresh = () => {
    setRefreshFailed(false);
    if (conflict !== null) setConflict({ waitFor: refetch(), landed: false });
    else refetch();
  };

  const rows = form.method === 'equal' ? equalRows(form, memberIds) : [];
  const line = form.method === 'exact' ? exactLine(form, memberIds) : null;
  const amountError = amountFieldError(form.amountText);
  const payerName = draft.payerId === null ? null : nameOf(draft.payerId);
  const title = isEdit ? COPY.editTitle : COPY.newTitle;

  const footer = pendingExit !== null ? (
    <View style={styles.action}>
      <Banner tone="warning" title={isEdit ? COPY.discardEdit : COPY.discardAdd} alert />
      <View style={styles.buttons}>
        <Button label={COPY.keepEditing} variant="secondary" onPress={() => setPendingExit(null)} style={styles.grow} />
        <Button
          label={COPY.discard}
          variant="danger"
          accessibilityHint={COPY.discardHint}
          onPress={() => {
            setExit(pendingExit);
            setPendingExit(null);
          }}
          style={styles.grow}
        />
      </View>
    </View>
  ) : (
    <View style={styles.action}>
      {conflict !== null ? (
        <Banner tone="warning" title={GROUP_ERROR_COPY.version_changed} alert>
          {conflict.landed && latest !== null ? (
            <TextLink label={COPY.showTheirs} accessibilityHint={COPY.showTheirsHint} onPress={showTheirs} />
          ) : null}
        </Banner>
      ) : null}
      {refreshFailed ? (
        <View style={styles.inline}>
          <StatusLine text={COPY.refreshFailed} tone="error" alert style={styles.flex} />
          <TextLink label={COPY.tryAgain} onPress={retryRefresh} />
        </View>
      ) : null}
      {saveError !== null ? <StatusLine text={saveError} tone="error" size="caption" alert /> : null}
      <Button
        label={saving ? COPY.saving : COPY.save}
        variant="primary"
        block
        loading={saving}
        disabled={payload === null || deleting}
        accessibilityHint={blockText ?? (isEdit ? COPY.saveHintEdit : COPY.saveHintAdd)}
        onPress={() => void onSave()}
      />
      {note !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{note}</Text> : null}
    </View>
  );

  const locked = busy;

  return (
    // Only iOS needs padding to keep the focused field and Save above the keyboard; Android resizes the window.
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <BackHeader title={title} back={{ ...back, disabled: busy }} />
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[styles.content, { paddingBottom: space.xxl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.column}>
          <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
            {title}
          </Text>

          <View style={styles.fields}>
            <TextField
              label={COPY.titleLabel}
              showLabel
              placeholder={COPY.titlePlaceholder}
              value={form.title}
              onChangeText={(t) => edit({ title: t })}
              editable={!locked}
              autoFocus={!isEdit}
              autoCapitalize="sentences"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => amountRef.current?.focus()}
            />
            <TextField
              ref={amountRef}
              label={COPY.amountLabel}
              showLabel
              prefix="$"
              large
              numeric
              placeholder={COPY.amountPlaceholder}
              keyboardType="decimal-pad"
              returnKeyType="done"
              value={form.amountText}
              onChangeText={(t) => edit({ amountText: t })}
              error={amountError ?? undefined}
              editable={!locked}
            />
          </View>

          <View style={styles.group}>
            <View style={styles.inline}>
              <View style={styles.flex}>
                <Text style={[type.caption, styles.label, { color: colors.textMuted }]}>{COPY.paidBy}</Text>
                <Text style={[type.body, { color: payerName === null ? colors.danger : colors.text }]}>
                  {payerName ?? COPY.choosePayer}
                </Text>
              </View>
              <TextLink
                label={COPY.change}
                accessibilityLabel={COPY.changeA11y}
                accessibilityHint={COPY.changeHint}
                accessibilityState={{ expanded: payerOpen }}
                disabled={locked}
                onPress={() => setPayerOpen((o) => !o)}
              />
            </View>
            {payerOpen ? (
              <Card flush>
                <View accessibilityRole="radiogroup" accessibilityLabel={COPY.paidBy}>
                  {memberIds.map((userId, i) => (
                    <ExpensePayerRow
                      key={userId}
                      name={nameOf(userId)}
                      checked={draft.payerId === userId}
                      disabled={locked}
                      divider={i > 0}
                      onPick={() => {
                        edit({ payerId: userId });
                        setPayerOpen(false);
                      }}
                    />
                  ))}
                </View>
              </Card>
            ) : null}
          </View>

          <View style={styles.group}>
            <Text style={[type.caption, styles.label, { color: colors.textMuted }]}>{COPY.split}</Text>
            <SegmentedControl<SplitMethod>
              options={[
                { value: 'equal', label: COPY.equally },
                { value: 'exact', label: COPY.exact },
              ]}
              value={form.method}
              onChange={(method) => edit({ method })}
              stretch
              semantics="radio"
              groupLabel={COPY.split}
              disabled={locked}
            />
            {form.method === 'equal' ? (
              <Card flush>
                {rows.map((r, i) => (
                  <ExpenseCheckRow
                    key={r.userId}
                    name={nameOf(r.userId)}
                    checked={r.chosen}
                    cents={r.chosen ? r.cents : null}
                    accessibilityLabel={equalRowA11yLabel(nameOf(r.userId), r.chosen ? r.cents : null)}
                    accessibilityHint={COPY.equalHint}
                    disabled={locked}
                    divider={i > 0}
                    onToggle={() => toggle(r.userId)}
                  />
                ))}
              </Card>
            ) : (
              <>
                <Card>
                  {memberIds.map((userId) => {
                    const text = form.exactText[userId] ?? '';
                    const error = shareFieldError(text);
                    return (
                      <View key={userId} style={styles.exactRow}>
                        <View style={styles.inline}>
                          <Text style={[type.body, styles.flex, { color: colors.text }]}>{nameOf(userId)}</Text>
                          <TextField
                            label={exactFieldLabel(nameOf(userId))}
                            prefix="$"
                            numeric
                            placeholder={COPY.amountPlaceholder}
                            keyboardType="decimal-pad"
                            value={text}
                            onChangeText={(t) => setShare(userId, t)}
                            invalid={error !== null}
                            accessibilityHint={error ?? COPY.exactHint}
                            editable={!locked}
                            style={styles.exactField}
                          />
                        </View>
                        {error !== null ? (
                          <Text accessibilityRole="alert" style={[type.caption, styles.exactError, { color: colors.danger }]}>
                            {error}
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </Card>
                {line !== null ? (
                  line.tone === 'muted' ? (
                    <Text accessibilityLiveRegion="polite" style={[type.label, { color: colors.textMuted }]}>
                      {line.text}
                    </Text>
                  ) : (
                    <StatusLine text={line.text} tone={line.tone} />
                  )
                ) : null}
              </>
            )}
          </View>

          {isEdit ? (
            confirmDelete ? (
              <Card>
                <Text style={[type.body, { color: colors.text }]}>{deleteConfirmText(base?.title ?? form.title)}</Text>
                {deleteError !== null ? <StatusLine text={deleteError} tone="error" size="caption" alert /> : null}
                <View style={styles.buttons}>
                  <Button
                    label={COPY.deleteConfirmButton}
                    accessibilityLabel={COPY.deleteConfirmA11y}
                    accessibilityHint={COPY.deleteConfirmHint}
                    variant="danger"
                    loading={deleting}
                    disabled={saving}
                    onPress={() => void onDelete()}
                  />
                  <Button label={COPY.keep} variant="ghost" disabled={busy} onPress={() => setConfirmDelete(false)} />
                </View>
              </Card>
            ) : (
              <Button
                label={COPY.delete}
                variant="danger"
                accessibilityHint={COPY.deleteHint}
                disabled={busy}
                onPress={() => {
                  setDeleteError(null);
                  setPendingExit(null);
                  setConfirmDelete(true);
                }}
              />
            )
          ) : null}
        </View>
      </ScrollView>
      <View style={[styles.footer, { backgroundColor: colors.surface, borderTopColor: colors.divider, paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.footerColumn}>{footer}</View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: layout.screenPadding, paddingTop: space.md },
  column: { width: '100%', maxWidth: layout.form, alignSelf: 'center', gap: space.xl },
  titleBlock: { gap: space.xs },
  fields: { gap: space.lg },
  group: { gap: space.sm },
  label: { fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  exactRow: { gap: space.xs },
  exactField: { width: 140 },
  exactError: { textAlign: 'right' },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, paddingHorizontal: layout.screenPadding },
  footerColumn: { width: '100%', maxWidth: layout.form, alignSelf: 'center' },
  action: { gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  grow: { flex: 1 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
