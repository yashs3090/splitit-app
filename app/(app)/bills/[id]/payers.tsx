// Who paid?: the host enters how much each person paid toward the bill, as amounts or as
// percentages, with the bill total at the bottom. Opened from "Change" on Settle up.
// Logic: lib/payersForm.ts (pure, tested). Decision log: docs/decisions-to-review.md, WP-PAGE-*.
//
// Rules this screen keeps:
// - Host only. Anyone else sees "Only <host> can change who paid." and no fields.
// - By default the payer (the host, unless someone changed it) has the whole bill.
// - Save is enabled only when the amounts add up to the bill total exactly (percentages: to 100%,
//   turned into cents by largest remainder) and differ from what's stored.
// - One person with the whole bill saves with set_payer; two or more with set_payers.
// - Before saving it re-reads the bill. A changed total stops the save with a message. The ledger
//   keeps every payment (who paid A1.1), so the confirm says where moved payments go (contract M,
//   A1.5's confirm table): one person → one person through pickerDecision (also "People may already
//   be paying you." on a complete bill); any change involving several people through
//   splitSaveDecision, which asks only when the save takes someone with payments off who paid, and
//   otherwise shows its note ("Dee already paid. Their payment still counts…") above Save.
// - One save at a time (a ref), so a double tap on Save or on the confirm sends one call and goes
//   back once (A-50(g)). Nothing is optimistic.
// - The page's own requests give up after PAYERS_REQUEST_TIMEOUT_MS (15 s) and read as a network
//   error, with Save and Back enabled again (A-50(h)). A write whose outcome is unknown (timed out,
//   or a network error) keeps the noted own change (lib/ownPayerChange): a timed-out write can
//   still commit, so only its own answer forgets the note (a refusal), and OWN_PAYER_CHANGE_MAX_MS
//   bounds it otherwise. A refetch that shows it landed tells the Settle page and goes back if the
//   draft is still what was saved (else "Your earlier save went through."); a late ok answer says
//   the same on the page and refetches, but never navigates.
// - The note is settled from the write's answer even if the page has closed (a refusal forgets it),
//   and an ok save that keeps the same lead forgets it too: Settle takes it only when the lead
//   changes. lib never computes a split's lead (WP-21), so that's decidable for one person only.
// - The back control reads "Back" in every state (A-50(i)): the page opens from the bill screen too.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatars';
import { Centered, Loading } from '@/components/Centered';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { MoneyText } from '@/components/ui/MoneyText';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TextField } from '@/components/ui/TextField';
import { TIMED_OUT, within } from '@/lib/asyncTimeout';
import { useSession } from '@/lib/auth';
import { initials, makeNameOf } from '@/lib/billView';
import { BILL_ERROR_COPY, fetchBill, setPayer, setPayers, type BillData, type BillError, type BillResult } from '@/lib/bills';
import { formatCents } from '@/lib/money';
import { announceOwnPayerChange, forgetOwnPayerChange, noteOwnPayerChange } from '@/lib/ownPayerChange';
import {
  pairNetsTo,
  payersChangeIsNoop,
  paymentsMovedBy,
  payersState,
  type MovedPayment,
  type PayersChange,
  type PayersState,
} from '@/lib/payers';
import {
  canSavePayers,
  initialPaidFields,
  PAYERS_FORM_COPY,
  PAYERS_REQUEST_TIMEOUT_MS,
  payersFormStatus,
  rowCaptions,
  switchUnit,
  type PaidField,
  type PaidUnit,
} from '@/lib/payersForm';
import { pickerDecision, settleViewInputFor, splitSaveDecision } from '@/lib/settleView';
import { layout, space, tabularNums, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';

const LOAD_ERROR = "Couldn't load the bill.";

/**
 * Save refusals as this page words them. BILL_ERROR_COPY.in_group is a guest's line ("Ask for the
 * group's link"); here the host is told where who paid lives now. Everything else is shared.
 */
const SAVE_ERROR_COPY: Record<BillError, string> = {
  ...BILL_ERROR_COPY,
  in_group: 'This bill is in a group now, so who paid is set there.',
};

export default function PayersRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  return <PayersScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

function PayersScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, refetch, version } = useBill(id);
  const toSettle = () => (router.canGoBack() ? router.back() : router.replace(`/bills/${id}/settle`));
  // Back in every state, so a load that never answers can't strand anyone here (A-50(h)).
  const header = <BackHeader title={PAYERS_FORM_COPY.title} back={backAction(toSettle, false)} />;

  if (load.status === 'loading') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (load.status === 'not_found' || load.status === 'error') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>
          {load.status === 'not_found' ? BILL_ERROR_COPY.not_found : LOAD_ERROR}
        </Text>
        {load.status === 'error' ? <Button label="Try again" accessibilityLabel="Try again" variant="primary" onPress={() => refetch()} /> : null}
      </Centered>
    );
  }
  const data = load.data;
  const nameOf = makeNameOf(data.participants, myId);
  if (data.bill.host_id !== myId) {
    return (
      <Centered>
        {header}
        {/* The header's Back is the one way out (one place per action). */}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{PAYERS_FORM_COPY.onlyHost(nameOf(data.bill.host_id))}</Text>
      </Centered>
    );
  }
  return <PayersForm id={id} myId={myId} data={data} refetch={refetch} version={version} onDone={toSettle} />;
}

/** The header's back control (A-50(i), WP-R9): "Back", because the page opens from the bill screen too. */
function backAction(onPress: () => void, disabled: boolean) {
  return { label: PAYERS_FORM_COPY.back, accessibilityLabel: PAYERS_FORM_COPY.back, onPress, disabled };
}

/** A write whose answer never came (timed out) or was lost (network): did it land? */
type UnknownWrite = { change: PayersChange; refetchNo: number; fields: readonly PaidField[]; leadBefore: string };

type Confirm = { title: string | null; text: string; button: string; cancelA11yLabel: string; change: PayersChange };

/** The payer ids a change leaves (one person, or the split's rows). */
function newPayerIds(change: PayersChange): string[] {
  return change.mode === 'one' ? [change.payerId] : change.payers.map((p) => p.userId);
}

/**
 * Contract M on `data`: the payments that saving `change` moves, and who has a payment to a current
 * payer. Each pair's net is contract P's (lib/payers pairNetsTo). Null if the ledger doesn't read.
 */
function movedBy(data: BillData, change: PayersChange): { moved: MovedPayment[]; paidIds: string[] } | null {
  const oldIds = [...new Set([data.bill.payer_id, ...data.payers.map((p) => p.userId)])];
  const ids = [...new Set([...data.participants.map((p) => p.userId), ...data.payments.flatMap((p) => [p.fromId, p.toId])])];
  try {
    const nets = pairNetsTo(data.payments, oldIds, ids);
    const paidIds = [...new Set(nets.filter((n) => n.netCents > 0).map((n) => n.fromId))];
    return { moved: paymentsMovedBy(nets, oldIds, newPayerIds(change)), paidIds };
  } catch {
    return null;
  }
}

function PayersForm({
  id,
  myId,
  data,
  refetch,
  version,
  onDone,
}: {
  id: string;
  myId: string;
  data: BillData;
  refetch: () => number;
  /** useBill's `version`: the number of the refetch whose data is shown. */
  version: number;
  onDone: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);
  const totalCents = data.bill.total_cents;
  const participantIds = useMemo(() => data.participants.map((p) => p.userId), [data.participants]);
  const state: PayersState = useMemo(
    () =>
      payersState({
        payerId: data.bill.payer_id,
        rows: data.payers,
        totalCents,
      }),
    [data.bill.payer_id, data.payers, totalCents],
  );

  const [unit, setUnit] = useState<PaidUnit>('amount');
  const [fields, setFields] = useState<PaidField[]>(() => initialPaidFields(state, participantIds));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  /** "Your earlier save went through." after an unknown write turned out to have saved (round 2 R1, R6). */
  const [savedEarlier, setSavedEarlier] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const unknownWrite = useRef<UnknownWrite | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Someone joined or left while the page was open: add their (blank) row, drop a leaver's.
  useEffect(() => {
    setFields((prev) => {
      // Whole rows, so a row's kept cents (percent mode, QA A-50(c)) survive too.
      const byId = new Map(prev.map((f) => [f.userId, f]));
      const next = participantIds.map((userId): PaidField => byId.get(userId) ?? { userId, text: '' });
      const same = next.length === prev.length && next.every((f, i) => f.userId === prev[i]?.userId);
      return same ? prev : next;
    });
  }, [participantIds]);

  // A write with an unknown outcome: the first refetch after it that lands looks (a failed one
  // decides nothing). Not there yet → keep the note: a timed-out write can still commit, and its own
  // late answer settles the note (send), while OWN_PAYER_CHANGE_MAX_MS bounds it otherwise.
  useEffect(() => {
    const w = unknownWrite.current;
    if (w === null || version < w.refetchNo) return;
    unknownWrite.current = null;
    if (!payersChangeIsNoop(state, w.change)) return;
    settleNote({ ok: true }, w.change, w.leadBefore);
    setError(null);
    // Saved after all. Go back as a save does, unless the host has edited since (then say so, R6).
    if (!busy.current && fields === w.fields) onDone();
    else showSavedEarlier();
  }, [version, state, fields, id, onDone]);

  const status = useMemo(() => payersFormStatus(unit, fields, totalCents), [unit, fields, totalCents]);
  const captions = useMemo(() => rowCaptions(unit, status, totalCents), [unit, status, totalCents]);
  const canSave = canSavePayers(status, state) && !saving;
  // A1.5: a change involving several people, while payments exist, says above Save that they still count.
  const pending = canSave ? status.change : null;
  const live = useMemo(
    () => (pending !== null && !(pending.mode === 'one' && data.payers.length === 0) ? movedBy(data, pending) : null),
    [pending, data],
  );
  const note = live === null ? null : splitSaveDecision({ moved: live.moved, paidIds: live.paidIds, viewerId: myId, nameOf }).note;

  function edit(userId: string, text: string) {
    // A typed row loses its kept cents: from now on its text decides (QA A-50(c)).
    setFields((prev) => prev.map((f) => (f.userId === userId ? { userId, text } : f)));
    setError(null);
    setSavedEarlier(false);
    setConfirm(null);
  }

  function changeUnit(next: PaidUnit) {
    if (next === unit) return;
    setFields((prev) => switchUnit(unit, next, prev, totalCents));
    setUnit(next);
    setConfirm(null);
  }

  /** Re-reads the bill, then saves, or asks first. */
  async function onSave() {
    const change = status.change;
    if (change === null || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    setConfirm(null);
    const read = await within(fetchBill(id), PAYERS_REQUEST_TIMEOUT_MS);
    if (!mounted.current) return;
    if (read === TIMED_OUT) return fail(SAVE_ERROR_COPY.network, false);
    const res = read;
    if (!res.ok) return fail(res.error === 'network' ? SAVE_ERROR_COPY.network : PAYERS_FORM_COPY.saveFailed, false);
    refetch();
    if (res.bill.total_cents !== totalCents) {
      return fail(`The bill total changed to ${formatCents(res.bill.total_cents)}. Check the amounts and save again.`, false);
    }
    const fresh: BillData = { ...res };
    const ask = confirmFor(fresh, change);
    if (ask === 'unreadable') return fail(PAYERS_FORM_COPY.saveFailed, false);
    if (ask === null) return void send(change);
    busy.current = false;
    setSaving(false);
    setConfirm(ask);
  }

  /** The confirm for `change` on freshly read data, null to save at once, 'unreadable' if the ledger doesn't read. */
  function confirmFor(fresh: BillData, change: PayersChange): Confirm | null | 'unreadable' {
    const m = movedBy(fresh, change);
    if (m === null) return 'unreadable';
    const freshNameOf = makeNameOf(fresh.participants, myId);
    if (change.mode === 'one' && fresh.payers.length === 0) {
      const plan = settleViewInputFor(fresh, myId, Platform.OS, null).plan;
      // People can see Pay buttons right now (several-payer history makes a routes plan).
      const complete = plan.status === 'ready' || plan.status === 'early' || plan.status === 'routes';
      const d = pickerDecision({
        targetId: change.payerId,
        payerId: fresh.bill.payer_id,
        moved: m.moved,
        complete,
        viewerId: myId,
        nameOf: freshNameOf,
      });
      return d.kind === 'confirm' ? { title: d.title, text: d.text, button: d.button, cancelA11yLabel: d.cancelA11yLabel, change } : null;
    }
    const d = splitSaveDecision({ moved: m.moved, paidIds: m.paidIds, viewerId: myId, nameOf: freshNameOf });
    return d.confirm === null ? null : { ...d.confirm, change };
  }

  /** The confirm's button: one save at a time, so a double tap sends one call (A-50(g), R4). */
  function confirmSave(change: PayersChange) {
    if (busy.current) return;
    void send(change);
  }

  /**
   * What a write's answer means for the own-change note, whether or not the page is still open.
   * ok → tell the Settle page (it refetches); and when the lead stays the same, forget the note,
   * because Settle takes it only when the lead changes (round 2 R4). A refusal → forget it (nothing
   * changed); 'busy' is one (a lock clash aborted the write, delete-group A3.4). 'network' → unknown: keep it.
   */
  function settleNote(res: BillResult, change: PayersChange, leadBefore: string) {
    if (res.ok) {
      announceOwnPayerChange(id);
      if (change.mode === 'one' && change.payerId === leadBefore) forgetOwnPayerChange(id);
    } else if (res.error !== 'network') {
      forgetOwnPayerChange(id);
    }
  }

  function showSavedEarlier() {
    setSavedEarlier(true);
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(PAYERS_FORM_COPY.savedEarlier);
  }

  /** Sends the change (onSave has re-read the bill, or the host confirmed). */
  async function send(change: PayersChange) {
    busy.current = true;
    unknownWrite.current = null;
    setSaving(true);
    setConfirm(null);
    setSavedEarlier(false);
    noteOwnPayerChange(id);
    const savedFields = fields;
    const leadBefore = state.leadId;
    const call = change.mode === 'one' ? setPayer(id, change.payerId) : setPayers(id, change.payers, { totalCents, participantIds });
    const answer = await within(call, PAYERS_REQUEST_TIMEOUT_MS);
    if (answer === TIMED_OUT) {
      // within() doesn't cancel the call: it may still commit. Its own answer settles the note;
      // an ok one also says so here and refetches (round 2 R1), but never navigates.
      void call.then((late) => {
        settleNote(late, change, leadBefore);
        if (!late.ok || !mounted.current) return;
        unknownWrite.current = null;
        setError(null);
        showSavedEarlier();
        refetch();
      });
    } else {
      settleNote(answer, change, leadBefore); // before the mounted check: a refusal still forgets it
    }
    if (!mounted.current) return;
    const res = answer === TIMED_OUT ? ({ ok: false, error: 'network' } as const) : answer;
    if (res.ok) {
      busy.current = false;
      onDone();
      return;
    }
    if (res.error === 'network') {
      // Unknown: it may have landed. Keep the note; a refetch looks (see the effect above).
      busy.current = false;
      setSaving(false);
      setError(SAVE_ERROR_COPY.network);
      unknownWrite.current = { change, refetchNo: refetch(), fields: savedFields, leadBefore };
      return;
    }
    const refresh = res.error === 'payers_total' || res.error === 'not_participant' || res.error === 'marks_changed';
    fail(SAVE_ERROR_COPY[res.error] ?? PAYERS_FORM_COPY.saveFailed, refresh);
  }

  function fail(text: string, refresh: boolean) {
    busy.current = false;
    setSaving(false);
    setError(text);
    if (refresh) refetch();
  }

  const toneColor = {
    muted: colors.textMuted,
    warning: colors.warning,
    success: colors.success,
    error: colors.danger,
  }[status.tone];
  const back = backAction(onDone, saving);

  return (
    <>
      <BackHeader title={PAYERS_FORM_COPY.title} back={back} />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ backgroundColor: colors.background }}
          contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.column}>
            <View style={styles.header}>
              <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
                {PAYERS_FORM_COPY.title}
              </Text>
              <Text style={[type.body, { color: colors.textMuted }]}>{PAYERS_FORM_COPY.subtitle}</Text>
            </View>

            <SegmentedControl
              options={[
                {
                  value: 'amount',
                  label: PAYERS_FORM_COPY.unitAmount,
                  accessibilityLabel: 'Amounts in dollars',
                },
                {
                  value: 'percent',
                  label: PAYERS_FORM_COPY.unitPercent,
                  accessibilityLabel: 'Percentages of the bill',
                },
              ]}
              value={unit}
              onChange={changeUnit}
              stretch
              semantics="radio"
              groupLabel={PAYERS_FORM_COPY.unitGroup}
              disabled={saving}
            />

            <Card>
              {data.participants.length < 2 ? (
                <Text style={[type.caption, { color: colors.textMuted }]}>{PAYERS_FORM_COPY.alone}</Text>
              ) : null}
              {data.participants.map((p, i) => {
                const name = nameOf(p.userId);
                const field = fields.find((f) => f.userId === p.userId);
                const row = status.rows[i];
                const err = row?.kind === 'invalid' ? row.error : undefined;
                const caption = captions[i] ?? undefined;
                return (
                  <View key={p.userId} style={styles.row}>
                    <Avatar
                      person={{
                        userId: p.userId,
                        name,
                        initials: initials(name),
                        isMe: p.userId === myId,
                      }}
                    />
                    <Text style={[type.body, styles.name, { color: colors.text }]} numberOfLines={2}>
                      {name}
                    </Text>
                    <View style={styles.fieldWrap}>
                      <View style={styles.fieldLine}>
                        <TextField
                          label={unit === 'amount' ? `${name} paid, in dollars` : `${name} paid, percent of the bill`}
                          prefix={unit === 'amount' ? '$' : undefined}
                          value={field?.text ?? ''}
                          onChangeText={(t) => edit(p.userId, t)}
                          placeholder={unit === 'amount' ? '0.00' : '0'}
                          keyboardType="decimal-pad"
                          inputMode="decimal"
                          numeric
                          editable={!saving}
                          error={err}
                          hint={caption}
                          style={styles.field}
                        />
                        {unit === 'percent' ? <Text style={[type.body, styles.percent, { color: colors.textMuted }]}>%</Text> : null}
                      </View>
                    </View>
                  </View>
                );
              })}
            </Card>

            <View style={[styles.totalRow, { borderTopColor: colors.divider }]}>
              <Text style={[type.label, styles.name, { color: colors.text }]}>{PAYERS_FORM_COPY.total}</Text>
              <MoneyText cents={totalCents} size="title" />
            </View>
            <Text accessibilityLiveRegion="polite" aria-live="polite" style={[type.label, tabularNums, { color: toneColor }]}>
              {status.text}
            </Text>

            {error !== null ? (
              <Banner tone="error" alert>
                <BannerText>{error}</BannerText>
              </Banner>
            ) : null}

            {/* Polite, not an alert: good news after an error (iOS hears it from showSavedEarlier). */}
            <View accessibilityLiveRegion="polite" aria-live="polite">
              {savedEarlier && error === null ? (
                <Banner tone="success">
                  <BannerText>{PAYERS_FORM_COPY.savedEarlier}</BannerText>
                </Banner>
              ) : null}
            </View>

            {confirm === null && note !== null ? <Text style={[type.caption, { color: colors.textMuted }]}>{note}</Text> : null}

            {confirm !== null ? (
              <Banner tone="warning" title={confirm.title ?? undefined}>
                <BannerText>{confirm.text}</BannerText>
                <View style={styles.buttons}>
                  <Button label={confirm.button} accessibilityLabel={confirm.button} variant="primary" onPress={() => confirmSave(confirm.change)} />
                  <Button
                    label={PAYERS_FORM_COPY.cancel}
                    accessibilityLabel={confirm.cancelA11yLabel}
                    variant="ghost"
                    onPress={() => setConfirm(null)}
                  />
                </View>
              </Banner>
            ) : (
              <View style={styles.buttons}>
                <Button
                  label={PAYERS_FORM_COPY.save}
                  accessibilityLabel={PAYERS_FORM_COPY.save}
                  accessibilityHint={canSave ? PAYERS_FORM_COPY.saveHint : (status.saveHint ?? 'Nothing has changed yet')}
                  variant="primary"
                  disabled={!canSave}
                  loading={saving}
                  onPress={() => void onSave()}
                />
                <Button label={PAYERS_FORM_COPY.cancel} accessibilityLabel={PAYERS_FORM_COPY.cancel} variant="ghost" disabled={saving} onPress={onDone} />
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: space.lg },
  column: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    gap: space.lg,
  },
  header: { gap: space.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.xs,
    flexWrap: 'wrap',
  },
  name: { flex: 1, minWidth: 96, paddingTop: space.sm },
  fieldWrap: { width: 148 },
  fieldLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  field: { flex: 1 },
  percent: { paddingTop: space.sm },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.md,
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
