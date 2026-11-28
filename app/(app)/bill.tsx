// The bill form screen: review a scan, or enter the items by hand, then "Save and share".
// Specs: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 6) and
// docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 9).
//
// The screen owns the draft so it can save it. Whether saving is allowed, and why not, comes only
// from toBillArgs (lib/billPayload.ts); this file does no money math. A failed save shows fixed
// copy (never the server's text) and keeps the draft.
//
// Back (visual pass V10a, proposal P2, decision VP-M1): with nothing entered it goes straight back;
// with anything entered (or a scanned draft) the footer asks "Discard this bill?" first.
//
// From a group (docs/specs/2026-11-26-groups-mvp.md T17, GR-6): "Add, then Receipt" stored the group
// in lib/scanSession. The form reads it once (only if it was opened from that group's screen,
// lib/billGroup.ts receiptGroupFor), says which group the receipt goes in, and after
// create_bill succeeds calls attach_bill_to_group (two calls). A failed attach still opens the bill
// (it exists): the failure is left in lib/scanSession for the bill screen's "Couldn't add it to
// <group>. Try again." line and its retry. Either way the stored group is cleared.
import { useNavigation, useRouter } from 'expo-router';
import UsersRound from 'lucide-react-native/icons/users-round';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useReducer, useRef, useState, type Dispatch } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { BillForm } from '@/components/BillForm';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { draftHasEntries, draftReducer, emptyDraft, evaluateDraft, fromParsed, type BillDraft, type DraftAction } from '@/lib/billDraft';
import { SAVE_BLOCK_COPY, toBillArgs } from '@/lib/billPayload';
import { receiptGoesInText, receiptGroupFor, saveHintForGroup } from '@/lib/billGroup';
import { createBill } from '@/lib/bills';
import { attachBillToGroup } from '@/lib/groups';
import { clearScanGroup, clearScanResult, getScanGroup, getScanResult, setAttachFailure } from '@/lib/scanSession';
import { space, type, useTheme } from '@/lib/theme';

const SAVE_LABEL = 'Save and share';
export const SAVING_LABEL = 'Saving…';
const SAVE_ERROR_COPY = "Couldn't save the bill. Check your connection and try again.";
export const DISCARD_QUESTION = 'Discard this bill?';

export default function BillScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  // Read once on mount: the scan result comes from memory, never from the URL.
  const [draft, rawDispatch] = useReducer(draftReducer, undefined, (): BillDraft => {
    const scanned = getScanResult();
    return scanned ? fromParsed(scanned) : emptyDraft();
  });
  const scanned = draft.source === 'scan';
  const navigation = useNavigation();
  // Read once on mount, like the scan result: the group this receipt goes in. It applies only when
  // this form was opened from that group's screen (through Scan or not); see receiptGroupFor.
  const [target] = useState(() => receiptGroupFor(navigation.getState()?.routes ?? [], getScanGroup()));
  useEffect(() => {
    // A stored group that doesn't apply here is stale (the person left the group's flow).
    if (target === null) clearScanGroup();
  }, [target]);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // A ref, not state: a double press lands before React re-renders with saving = true.
  const inFlight = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 0 when no header is shown (e.g. under a test renderer without a navigator).
  const headerHeight = useContext(HeaderHeightContext) ?? 0;

  const args = toBillArgs(draft, evaluateDraft(draft));
  const blockedReason = args.ok ? undefined : SAVE_BLOCK_COPY[args.reason];

  // Editing after a failed save means the person is fixing things; the old error no longer applies.
  // Editing also closes an open "Discard this bill?": the person chose to keep going (review R5).
  const dispatch: Dispatch<DraftAction> = (action) => {
    setSaveFailed(false);
    setConfirmDiscard(false);
    rawDispatch(action);
  };

  async function onSave() {
    if (inFlight.current || !args.ok) return;
    inFlight.current = true;
    setSaving(true);
    setSaveFailed(false);
    const res = await createBill(args.rows, args.money);
    if (res.ok) {
      if (target !== null) {
        const attached = await attachBillToGroup(res.billId, target.groupId);
        if (!attached.ok) setAttachFailure({ billId: res.billId, groupId: target.groupId, groupName: target.name });
        clearScanGroup();
      }
      clearScanResult();
      router.replace(`/bills/${res.billId}`);
      return; // leaving the screen; keep the guard closed so nothing saves twice
    }
    inFlight.current = false;
    setSaving(false);
    setSaveFailed(true);
  }

  function onStartOver() {
    clearScanResult();
    router.replace('/scan');
  }

  function leave() {
    clearScanResult();
    if (router.canGoBack()) router.back();
    else {
      // Home isn't in the group's flow: the receipt no longer goes in that group.
      clearScanGroup();
      router.replace('/');
    }
  }

  function onBack() {
    if (draftHasEntries(draft)) setConfirmDiscard(true);
    else leave();
  }

  const footerAction = confirmDiscard ? (
    <View style={styles.action}>
      <Banner tone="warning" title={DISCARD_QUESTION} alert />
      <View style={styles.buttons}>
        <Button label="Keep editing" variant="secondary" onPress={() => setConfirmDiscard(false)} style={styles.grow} />
        <Button
          label="Discard"
          variant="danger"
          accessibilityHint="Throws away what you entered and goes back"
          onPress={leave}
          style={styles.grow}
        />
      </View>
    </View>
  ) : (
    <View style={styles.action}>
      {saveFailed ? <Banner tone="error" title={SAVE_ERROR_COPY} alert /> : null}
      <Button
        label={saving ? SAVING_LABEL : SAVE_LABEL}
        variant="primary"
        block
        loading={saving}
        disabled={!args.ok}
        accessibilityHint={blockedReason ?? (target ? saveHintForGroup(target.name) : 'Saves the bill and gets a link to send to your friends.')}
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
        title={scanned ? 'Check the items' : 'Enter the items'}
        back={{
          label: 'Back',
          accessibilityLabel: 'Back',
          // Says where Back goes: the previous screen, or Home on a cold link / reload (review R10).
          accessibilityHint: router.canGoBack() ? 'Goes back' : 'Goes to Home',
          onPress: onBack,
          disabled: saving,
        }}
      />
      <BillForm
        underHeader
        draft={draft}
        dispatch={dispatch}
        header={
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {scanned ? 'Check the items' : 'Enter the items'}
            </Text>
            <Text style={[type.body, { color: colors.textMuted }]}>
              {scanned
                ? 'Compare each line with the receipt and fix anything that looks off.'
                : 'Type each line from the receipt. We check the totals as you go.'}
            </Text>
            {target ? (
              <View style={styles.groupLine}>
                <Icon icon={UsersRound} size="sm" color={colors.textMuted} />
                <Text style={[type.caption, styles.flex, { color: colors.textMuted }]}>{receiptGoesInText(target.name)}</Text>
              </View>
            ) : null}
          </View>
        }
        footerAction={footerAction}
        footerNote={confirmDiscard ? undefined : blockedReason}
      >
        <Button label="Start over" variant="secondary" disabled={saving} onPress={onStartOver} />
      </BillForm>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { gap: space.xs },
  action: { gap: space.sm },
  buttons: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  groupLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingTop: space.xs },
});
