// The host's edit screen: change items, prices and amounts after sharing.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 13, design decision 4, A3.4).
//
// Loads the bill with fetchBill, regroups its unit rows into the form with draftFromSaved, and
// saves with toBillArgs (passing the saved unit ids, so kept units keep their claims) and
// updateBill. Anything that would remove someone's claim asks first: deleting a claimed row,
// lowering a quantity below the claimed units, saving a claimed row whose fields were cleared, or
// switching a claimed claimable discount to Split (docs/specs/2026-11-24-claimable-discounts.md).
// Confirmations sit in the sticky footer, in place of the save button, so they work the same on
// web and native. This file does no money math; failures show fixed copy, never server text.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useCallback, useContext, useEffect, useReducer, useRef, useState, type Dispatch } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { BillForm } from '@/components/BillForm';
import { Centered, Loading } from '@/components/Centered';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { useSession } from '@/lib/auth';
import { draftReducer, evaluateDraft, type DraftAction } from '@/lib/billDraft';
import { draftFromSaved, SAVE_BLOCK_COPY, toBillArgs, type BillArgsResult, type SavedGroups } from '@/lib/billPayload';
import { BILL_ERROR_COPY, fetchBill, updateBill, type BillData, type BillError } from '@/lib/bills';
import { claimerCount, deleteConfirmCopy, EDIT_COPY, freshSaveCheck } from '@/lib/editBill';
import { layout, space, type, useTheme } from '@/lib/theme';

type Load =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error' }
  | { status: 'not_host' }
  | { status: 'ready'; data: BillData };

export default function EditBillRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  // A new id is a new screen: no draft carries over from another bill.
  return <EditBillScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

function EditBillScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    void fetchBill(id).then((res) => {
      if (!live) return;
      // A read RLS refuses (not_allowed) gets the no-access copy too, like useBill.
      if (!res.ok) setLoad({ status: res.error === 'not_found' || res.error === 'not_allowed' ? 'not_found' : 'error' });
      else if (res.bill.host_id !== myId) setLoad({ status: 'not_host' });
      else {
        const { bill, rows, participants, claims, payers, payments, flags } = res;
        setLoad({ status: 'ready', data: { bill, rows, participants, claims, payers, payments, flags } });
      }
    });
    return () => {
      live = false;
    };
  }, [id, myId, attempt]);

  // Back to the bill: pops to it when it's under this screen, otherwise opens it.
  const toBill = useCallback(() => router.dismissTo(`/bills/${id}`), [router, id]);

  // The bar is there in every state; the back control only where it always was (the form).
  const header = <BackHeader title={EDIT_COPY.title} />;
  if (load.status === 'loading') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (load.status === 'ready') return <EditForm id={id} data={load.data} onDone={toBill} />;

  const message: Record<Exclude<Load['status'], 'loading' | 'ready'>, string> = {
    not_found: BILL_ERROR_COPY.not_found,
    error: EDIT_COPY.loadError,
    not_host: EDIT_COPY.hostOnly,
  };
  return (
    <Centered>
      {header}
      <Text style={[type.body, styles.centerText, { color: colors.text }]}>{message[load.status]}</Text>
      {load.status === 'not_found' ? (
        <Button label="Go home" variant="primary" onPress={() => router.replace('/')} />
      ) : load.status === 'error' ? (
        <Button label="Try again" variant="primary" onPress={() => setAttempt((n) => n + 1)} />
      ) : (
        <Button label="Back" variant="primary" onPress={toBill} />
      )}
    </Centered>
  );
}

type ReadyArgs = Extract<BillArgsResult, { ok: true }>;
type DeleteAction = Extract<DraftAction, { type: 'removeItem' | 'removeDiscount' }>;
type Confirm = { kind: 'delete'; action: DeleteAction; text: string } | { kind: 'save'; text: string; args: ReadyArgs };

const SAVE_ERROR_COPY: Partial<Record<BillError, string>> = {
  invalid_bill: EDIT_COPY.changedWhileEditing,
  not_allowed: EDIT_COPY.hostOnly,
};

function EditForm({ id, data, onDone }: { id: string; data: BillData; onDone: () => void }) {
  const { colors } = useTheme();
  // Loaded once: the form is a snapshot of the bill when editing started.
  const [initial] = useState(() => draftFromSaved(data.bill, data.rows, data.claims));
  const saved: SavedGroups = initial.saved;
  const [draft, rawDispatch] = useReducer(draftReducer, initial.draft);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [saving, setSaving] = useState(false);
  // 0 when no header is shown (e.g. under a test renderer without a navigator).
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [saveError, setSaveError] = useState<string | null>(null);
  // A ref, not state: a double press lands before React re-renders with saving = true.
  const inFlight = useRef(false);

  const args = toBillArgs(draft, evaluateDraft(draft), saved);
  const blockedReason = args.ok ? undefined : SAVE_BLOCK_COPY[args.reason];

  const dispatch: Dispatch<DraftAction> = (action) => {
    // Deleting a claimed item, or a claimed claimable discount (saved.units holds its row id), asks first.
    if (action.type === 'removeItem' || action.type === 'removeDiscount') {
      const claimers = claimerCount(saved.units[action.id] ?? [], data.claims);
      if (claimers > 0) {
        setConfirm({ kind: 'delete', action, text: deleteConfirmCopy(claimers) });
        return;
      }
    }
    // Any edit makes an open question or an old error out of date.
    setConfirm(null);
    setSaveError(null);
    rawDispatch(action);
  };

  async function save(ready: ReadyArgs) {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirm(null);
    setSaving(true);
    setSaveError(null);
    const res = await updateBill(id, ready.rows, ready.money);
    if (res.ok) {
      onDone();
      return; // leaving the screen; keep the guard closed so nothing saves twice
    }
    inFlight.current = false;
    setSaving(false);
    setSaveError(SAVE_ERROR_COPY[res.error] ?? EDIT_COPY.saveError);
  }

  // R1: claims may have changed since the form opened. Re-read the bill, rebuild which units are
  // claimed from the fresh claims (so a lowered quantity drops unclaimed units first), and ask
  // about anything that would now remove a claim. If the host's own saved rows changed (another
  // edit landed), stop with the "changed while you were editing" copy instead of saving.
  async function onSave() {
    if (inFlight.current || !args.ok) return;
    inFlight.current = true;
    setConfirm(null);
    setSaveError(null);
    setSaving(true);
    const fresh = await fetchBill(id);
    inFlight.current = false;
    setSaving(false);
    if (!fresh.ok) {
      setSaveError(fresh.error === 'not_allowed' ? EDIT_COPY.hostOnly : EDIT_COPY.saveError);
      return;
    }
    const check = freshSaveCheck(draft, data, saved, fresh);
    if (check.kind === 'changed') {
      setSaveError(EDIT_COPY.changedWhileEditing);
      return;
    }
    if (check.kind === 'blocked') return; // can't happen: the draft is unchanged and was valid
    if (check.question !== null) setConfirm({ kind: 'save', text: check.question, args: check.args });
    else void save(check.args);
  }

  function onConfirm() {
    if (confirm?.kind === 'delete') {
      setConfirm(null);
      setSaveError(null);
      rawDispatch(confirm.action);
    } else if (confirm?.kind === 'save') {
      void save(confirm.args);
    }
  }

  const footer = confirm ? (
    <View style={styles.action}>
      <Banner tone="warning" alert>
        <BannerText>{confirm.text}</BannerText>
      </Banner>
      <View style={styles.buttons}>
        <Button label="Cancel" variant="secondary" onPress={() => setConfirm(null)} style={styles.grow} />
        <Button
          label={confirm.kind === 'delete' ? 'Delete' : 'Save anyway'}
          variant="danger"
          accessibilityHint={
            confirm.kind === 'save'
              ? 'Saves and removes those claims'
              : confirm.action.type === 'removeDiscount'
                ? 'Removes this discount and its claims'
                : 'Removes this item and its claims'
          }
          onPress={onConfirm}
          style={styles.grow}
        />
      </View>
    </View>
  ) : (
    <View style={styles.action}>
      {saveError ? <Banner tone="error" title={saveError} alert /> : null}
      <Button
        label={saving ? EDIT_COPY.saving : EDIT_COPY.save}
        variant="primary"
        block
        loading={saving}
        disabled={!args.ok}
        accessibilityHint={blockedReason ?? "Saves your changes and updates everyone's shares."}
        onPress={() => void onSave()}
      />
    </View>
  );

  return (
    // Only iOS needs padding to keep the focused field above the keyboard; Android resizes the window itself.
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // The header sits above this view, so the keyboard overlap is measured from below it.
      keyboardVerticalOffset={headerHeight}
    >
      <BackHeader
        title={EDIT_COPY.title}
        back={{ label: 'Back', accessibilityLabel: 'Back', onPress: onDone, disabled: saving }}
      />
      <BillForm
        underHeader
        draft={draft}
        dispatch={dispatch}
        header={
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {EDIT_COPY.title}
            </Text>
            <Text style={[type.body, { color: colors.textMuted }]}>{EDIT_COPY.note}</Text>
          </View>
        }
        footerAction={footer}
        footerNote={confirm ? undefined : blockedReason}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { gap: space.xs },
  action: { gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
