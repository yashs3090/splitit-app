// Settle up: who owes whom, Pay on Venmo, "I paid", and (host) who paid the bill.
// Brief: docs/specs/2026-11-24-m3-settle-ux.md. Spec: docs/specs/2026-11-24-m3-settle-venmo.md (A1, Task 9).
//
// Rules this screen keeps:
// - Shows only what the server has confirmed. A write keeps its button loading until the refetch
//   that includes it has landed; nothing is optimistic.
// - Every write is guarded by a ref, so a double tap sends one call.
// - The Pay and Request handlers call openPaymentLink first, with no await before it (browsers only
//   allow a popup inside the user's gesture), and ignore taps within 1 s of the last one.
// - Request (the payer's rows, docs/specs/2026-11-25-venmo-request-buttons.md R4) never writes: no
//   rpc, no table write, no local "requested" state.
// - No app-state or page-visibility listening for the return from Venmo (M3-UX-1); no native
//   dialogs (inline confirms).
// - Every amount and every sentence comes from lib/settle.ts + lib/settleView.ts.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { PayerPicker, type PickerConfirm } from '@/components/PayerPicker';
import { SettleCard } from '@/components/SettleCard';
import { SettlePeopleList } from '@/components/SettlePeopleList';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSession } from '@/lib/auth';
import { BILL_ERROR_COPY, fetchBill, markPaid, setPayer, unmarkPaid, type BillData } from '@/lib/bills';
import { openPaymentLink } from '@/lib/paylinks';
import {
  actionError,
  addVenmoPrompt,
  canChangePayer,
  noticeFor,
  openedStillMatches,
  payerIdOf,
  payerLine,
  payOpenFailedLine,
  pickerDecision,
  pickerRows,
  requestOpenFailedLine,
  settleCard,
  settlePeople,
  settleRequestWebLine,
  settleViewInputFor,
  SETTLE_COPY,
  type NoticeSnapshot,
  type OpenedVenmo,
  type PayOpenFailure,
  type RequestOpenFailure,
  type SettleAction,
  type SettleRowRequest,
  type SettleViewInput,
} from '@/lib/settleView';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';

const LOAD_ERROR = "Couldn't load the bill.";
/** Pay (or Request) taps closer together than this are one tap (review R7, request spec R4). */
const PAY_REPEAT_MS = 1000;

export default function SettleRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  // A new id is a new screen: no state carries over from another bill.
  return <SettleScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

/** A write in flight: `clearAt` is the refetch that must land before its button is released. */
type Busy = { kind: 'mark' | 'unmark'; userId: string; from: 'card' | 'list'; clearAt: number | null };

type Pick = {
  open: boolean;
  busyId: string | null;
  confirm: (PickerConfirm & { expected: number }) | null;
  saving: boolean;
  error: string | null;
  /** After a successful set_payer: the refetch that closes the picker. */
  clearAt: number | null;
};
const PICK_CLOSED: Pick = { open: false, busyId: null, confirm: null, saving: false, error: null, clearAt: null };

function SettleScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { load, version, finished, refetch, livePaused } = useBill(id);

  const [openedVenmo, setOpenedVenmo] = useState<OpenedVenmo | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Open failures keep what they described, and show only while it still matches (review R2).
  const [payFailure, setPayFailure] = useState<PayOpenFailure | null>(null);
  const [requestFailure, setRequestFailure] = useState<RequestOpenFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick>(PICK_CLOSED);

  const mounted = useRef(true);
  /** One mark/undo at a time (double-tap guard). */
  const writing = useRef(false);
  /** One payer decision at a time. */
  const picking = useRef(false);
  /** What the screen last showed, for the §6 notices. */
  const shown = useRef<NoticeSnapshot | null>(null);
  const myPayerChange = useRef<string | null>(null);
  const iUndid = useRef(false);
  const iMarked = useRef(false);
  const openedRef = useRef<OpenedVenmo | null>(null);
  const lastPayAt = useRef(-Infinity);
  const lastRequestAt = useRef(-Infinity);
  openedRef.current = openedVenmo;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const data = load.status === 'ready' ? load.data : null;
  // The view input for this version of the data, from lib (request spec F1; review R5).
  const base = useMemo(() => (data ? settleViewInputFor(data, myId, Platform.OS, null) : null), [data, myId]);

  // Release a write's button, and close the picker, once the refetch after the write has finished:
  // landed (`version`), or failed (`finished`; the screen then keeps what the server last confirmed).
  // A newer refetch landing first counts too: useBill only shows the newest response, so it already
  // holds the change.
  useEffect(() => {
    const done = (clearAt: number | null) => clearAt !== null && (version >= clearAt || finished >= clearAt);
    setBusy((b) => {
      if (b === null || !done(b.clearAt)) return b;
      writing.current = false;
      return null;
    });
    setPick((p) => {
      if (!done(p.clearAt)) return p;
      picking.current = false;
      return PICK_CLOSED;
    });
  }, [version, finished]);

  // Notices (§6), announcements, and dropping a stale "Did you pay?" on every new version of the data.
  useEffect(() => {
    if (!data || !base) return;
    const me = data.participants.find((p) => p.userId === myId);
    const next: NoticeSnapshot = { payerId: payerIdOf(data), myMark: Boolean(me?.mark) };
    const prev = shown.current;
    shown.current = next;

    const opened = openedRef.current;
    if (prev !== null) {
      const text = noticeFor(prev, next, {
        iChangedPayer: myPayerChange.current === next.payerId,
        iUndid: iUndid.current,
        openedVenmo: opened,
        nameOf: base.nameOf,
        viewerId: myId,
      });
      if (text !== null) setNotice(text);
      if (prev.payerId !== next.payerId) myPayerChange.current = null;
      if (!prev.myMark && next.myMark && iMarked.current) {
        iMarked.current = false;
        // iOS VoiceOver ignores live regions; Android and web read the card's "Marked paid" line.
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SETTLE_COPY.announceMarked);
      }
      if (prev.myMark && !next.myMark && iUndid.current) {
        iUndid.current = false;
        setAnnouncement(SETTLE_COPY.announceUnmarked);
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SETTLE_COPY.announceUnmarked);
      }
    }

    // "Did you pay Hana?" only while it still matches the payer and the amount (§3.2).
    if (opened !== null && !openedStillMatches(base.plan, myId, opened)) setOpenedVenmo(null);
  }, [data, base, myId]);

  // ----- Actions -----

  function onPay(action: Extract<SettleAction, { kind: 'pay' }>) {
    // R7: a second tap within ~1 s (a double tap) doesn't open Venmo twice.
    const now = Date.now();
    if (now - lastPayAt.current < PAY_REPEAT_MS) return;
    lastPayAt.current = now;
    const opening = openPaymentLink(action.url); // the first call once the tap goes through; no await before it (web popup rule)
    const handle = base?.payerVenmo ?? '';
    setOpenedVenmo({ payerId: action.payerId, cents: action.cents });
    setCardError(null);
    setPayFailure(null);
    setAnnouncement(null);
    void opening.then((res) => {
      if (!res.ok && mounted.current) setPayFailure({ payerId: action.payerId, cents: action.cents, handle });
    });
  }

  function onRequest(request: Extract<SettleRowRequest, { kind: 'link' }>) {
    const now = Date.now();
    if (now - lastRequestAt.current < PAY_REPEAT_MS) return;
    lastRequestAt.current = now;
    const opening = openPaymentLink(request.url); // first call once the tap goes through; no await before it
    setListError(null);
    setRequestFailure(null);
    void opening.then((res) => {
      if (!res.ok && mounted.current) setRequestFailure({ userId: request.userId, cents: request.cents, handle: request.handle });
    });
  }

  async function onMark(payerId: string, cents: number) {
    if (writing.current) return;
    writing.current = true;
    setBusy({ kind: 'mark', userId: myId, from: 'card', clearAt: null });
    setCardError(null);
    setPayFailure(null);
    setAnnouncement(null);
    iMarked.current = true;
    const res = await markPaid(id, payerId, cents);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setBusy((b) => (b ? { ...b, clearAt } : b));
      return;
    }
    iMarked.current = false;
    writing.current = false;
    setBusy(null);
    const err = actionError(res.error);
    setCardError(err.text);
    if (err.refetch) refetch();
  }

  async function onUnmark(userId: string, from: 'card' | 'list') {
    if (writing.current) return;
    writing.current = true;
    const own = userId === myId;
    setBusy({ kind: 'unmark', userId, from, clearAt: null });
    setCardError(null);
    setListError(null);
    setPayFailure(null);
    setRequestFailure(null);
    setAnnouncement(null);
    if (own) iUndid.current = true;
    const res = await unmarkPaid(id, userId);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setBusy((b) => (b ? { ...b, clearAt } : b));
      return;
    }
    if (own) iUndid.current = false;
    writing.current = false;
    setBusy(null);
    const err = actionError(res.error);
    if (from === 'card') setCardError(err.text);
    else setListError(err.text);
    if (err.refetch) refetch();
  }

  function onAction(action: Exclude<SettleAction, { kind: 'pay' }>) {
    switch (action.kind) {
      case 'mark':
        void onMark(action.payerId, action.cents);
        return;
      case 'unmark':
        void onUnmark(action.userId, 'card');
        return;
      case 'add_venmo':
        router.push('/profile');
        return;
      case 'back':
        router.dismissTo(`/bills/${id}`);
        return;
      case 'edit':
        router.push(`/bills/${id}/edit`);
        return;
      case 'retry':
        refetch();
        return;
    }
  }

  // ----- Payer picker (§5) -----

  /** Re-reads the bill, then confirms or saves. `error` is shown above a re-shown confirm. */
  async function decidePayer(targetId: string, error: string | null) {
    setPick((p) => ({ ...p, busyId: targetId, confirm: null, saving: false, error }));
    const res = await fetchBill(id);
    if (!mounted.current) return;
    refetch(); // keep the screen in step with what the decision is based on
    if (!res.ok) {
      picking.current = false;
      setPick((p) => ({ ...p, busyId: null, error: SETTLE_COPY.saveFailed }));
      return;
    }
    const fresh: BillData = { bill: res.bill, rows: res.rows, participants: res.participants, claims: res.claims };
    const freshInput = settleViewInputFor(fresh, myId, Platform.OS, null);
    const decision = pickerDecision({
      targetId,
      payerId: payerIdOf(fresh),
      // EVERY mark on the bill: set_payer clears them all, and refuses a different count.
      markedIds: fresh.participants.filter((p) => p.mark).map((p) => p.userId),
      complete: freshInput.plan.status === 'ready',
      viewerId: myId,
      nameOf: freshInput.nameOf,
    });
    if (decision.kind === 'noop') {
      picking.current = false;
      setPick(PICK_CLOSED);
      return;
    }
    if (decision.kind === 'direct') {
      await savePayer(targetId, decision.expectedCleared);
      return;
    }
    picking.current = false;
    setPick((p) => ({
      ...p,
      busyId: null,
      confirm: {
        targetId,
        text: decision.text,
        button: decision.button,
        payerName: payerIdOf(fresh) === myId ? 'yourself' : freshInput.nameOf(payerIdOf(fresh)),
        expected: decision.expectedCleared,
      },
    }));
  }

  async function savePayer(targetId: string, expected: number) {
    picking.current = true;
    setPick((p) => ({ ...p, saving: true, error: null }));
    myPayerChange.current = targetId;
    const res = await setPayer(id, targetId, expected);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setPick((p) => ({ ...p, clearAt }));
      return;
    }
    myPayerChange.current = null;
    if (res.error === 'marks_changed') {
      await decidePayer(targetId, BILL_ERROR_COPY.marks_changed);
      return;
    }
    picking.current = false;
    const err = actionError(res.error);
    setPick((p) => ({ ...p, busyId: null, saving: false, confirm: null, error: err.text }));
    if (err.refetch) refetch();
  }

  function onPick(targetId: string) {
    if (picking.current || !data) return;
    if (targetId === payerIdOf(data)) {
      setPick(PICK_CLOSED);
      return;
    }
    picking.current = true;
    void decidePayer(targetId, null);
  }

  function onConfirmPick() {
    const c = pick.confirm;
    if (c === null || picking.current) return;
    void savePayer(c.targetId, c.expected);
  }

  // ----- Render -----

  // The bar is there in every state; the back control only where it always was (the settle view).
  const header = <BackHeader title={SETTLE_COPY.title} />;
  if (load.status === 'loading') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (load.status === 'not_found') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{BILL_ERROR_COPY.not_found}</Text>
        <Button label="Go home" accessibilityLabel="Go home" variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error' || !data || !base) {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{LOAD_ERROR}</Text>
        <Button label="Try again" accessibilityLabel="Try again" variant="primary" onPress={() => refetch()} />
      </Centered>
    );
  }

  const input: SettleViewInput = { ...base, openedVenmo };
  const cardModel = settleCard(input);
  const people = settlePeople(input);
  const requestWebLine = settleRequestWebLine(input, people);
  const venmoPrompt = addVenmoPrompt(input);
  const line = payerLine(input);
  const showChange = canChangePayer(myId, data.bill.host_id, data.participants.length, base.plan);
  const cardBusy = busy !== null && busy.from === 'card' ? busy.kind : null;

  return (
    <>
      <BackHeader
        title={SETTLE_COPY.title}
        back={{ label: SETTLE_COPY.back, accessibilityLabel: SETTLE_COPY.backA11y, onPress: () => router.dismissTo(`/bills/${id}`) }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {SETTLE_COPY.title}
            </Text>
            {line !== null ? (
              <View style={styles.payerRow}>
                <Text style={[type.body, styles.grow, { color: colors.textMuted }]}>{line}</Text>
                {showChange ? (
                  <Button
                    label={pick.open ? SETTLE_COPY.cancelChange : SETTLE_COPY.change}
                    accessibilityLabel={pick.open ? SETTLE_COPY.cancelChange : SETTLE_COPY.change}
                    accessibilityHint={pick.open ? undefined : SETTLE_COPY.changeHint}
                    variant="ghost"
                    disabled={pick.saving || pick.busyId !== null}
                    onPress={() => setPick(pick.open ? PICK_CLOSED : { ...PICK_CLOSED, open: true })}
                    flush
                  />
                ) : null}
              </View>
            ) : null}
          </View>

          {showChange && pick.open ? (
            <PayerPicker
              rows={pickerRows(
                data.participants.map((p) => p.userId),
                payerIdOf(data),
                myId,
                base.nameOf,
              )}
              busyId={pick.busyId}
              confirm={pick.confirm}
              saving={pick.saving}
              error={pick.error}
              onPick={onPick}
              onConfirm={onConfirmPick}
              onCancelConfirm={() => setPick((p) => ({ ...p, confirm: null, error: null }))}
            />
          ) : null}

          {notice !== null ? (
            <Banner tone="warning" alert>
              <View style={styles.noticeRow}>
                <View style={styles.grow}>
                  <BannerText>{notice}</BannerText>
                </View>
                <Button
                  label={SETTLE_COPY.dismiss}
                  accessibilityLabel="Dismiss notice"
                  variant="ghost"
                  onPress={() => setNotice(null)}
                  flush
                />
              </View>
            </Banner>
          ) : null}

          {livePaused ? (
            <View style={styles.noticeRow}>
              <Text style={[type.caption, styles.grow, { color: colors.textMuted }]}>Live updates paused</Text>
              <Button label="Refresh" accessibilityLabel="Refresh" variant="ghost" onPress={() => refetch()} flush />
            </View>
          ) : null}

          {venmoPrompt !== null ? (
            // A prompt, not the task: a quiet card with a tonal button, so Pay / "I paid" stays the
            // screen's only primary (P10, decision VP-M2).
            <Card muted>
              <Text style={[type.label, { color: colors.text }]}>{venmoPrompt.text}</Text>
              <Button
                label={venmoPrompt.button.label}
                accessibilityLabel={venmoPrompt.button.a11yLabel}
                accessibilityHint={venmoPrompt.button.a11yHint}
                variant="secondary"
                block
                onPress={() => onAction(venmoPrompt.button.action)}
              />
            </Card>
          ) : null}

          <SettleCard
            model={cardModel}
            busy={cardBusy}
            error={cardError ?? payOpenFailedLine(input, payFailure)}
            announcement={announcement}
            onPay={onPay}
            onAction={onAction}
          />

          {people !== null ? (
            <SettlePeopleList
              model={people}
              busyUserId={busy !== null && busy.from === 'list' ? busy.userId : null}
              error={listError ?? requestOpenFailedLine(people, requestFailure)}
              footnote={requestWebLine}
              onUndo={(userId) => void onUnmark(userId, 'list')}
              onRequest={onRequest}
            />
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  header: { gap: space.xs },
  payerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
