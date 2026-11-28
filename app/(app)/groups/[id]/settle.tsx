// A group's Settle up (spec docs/specs/2026-11-26-groups-mvp.md T16, as amended by A1 S1 and A2.2):
// the viewer's own part first (what they pay, what they just sent, who owes them, what they've
// received), then the suggested payments for everyone, "Who paid what" one tap away, and Record a
// payment for cash or part of a payment.
//
// Rules this screen keeps:
// - Every amount, status and sentence comes from lib/groupSettleView.ts's groupSettle (one source per
//   screen); copy for controls from lib/groupSettleText.ts. No money math here.
// - The writes and their endings live in lib/useGroupSettle.ts; the send's step order comes from
//   groupSendPlan. Pay calls straight into the hook from the press (web popup rule).
// - The waiting notice ("Balances don't include Hana's receipt yet: …") sits above everything that
//   pays or suggests, whenever a receipt is waiting (S1).
// - Inline confirms ("Got paid another way", "Not received") are keyed on the person and amount or
//   the payment id, and vanish when that is no longer on screen. Nothing here navigates on its own.
// - State lives under a key of the group id and the viewer, so nothing carries to another account.
import { useLocalSearchParams, useRouter } from 'expo-router';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { GroupPayCard, GroupReceivedRow, GroupRecordedCard, GroupRequestRow, GroupSentCard } from '@/components/GroupPayCard';
import { GroupDeletedState } from '@/components/GroupDeletedState';
import { GroupPaymentForm } from '@/components/GroupPaymentForm';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { ListRow } from '@/components/ui/ListRow';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { ToneIcon } from '@/components/ui/ToneIcon';
import { useSession } from '@/lib/auth';
import type { GroupSnapshot } from '@/lib/groups';
import { GROUP_SCREEN_COPY, groupNameOf } from '@/lib/groupScreenText';
import { GROUP_SETTLE_SCREEN_COPY as COPY, looseNotReceived, recordedEntry, requestOpenFailedLine, venmoOf } from '@/lib/groupSettleText';
import { groupSettle, sendPlatformOf } from '@/lib/groupSettleView';
import { chosenMethod, negativeLabel, owesLabel } from '@/lib/settleView';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useGroupSettle } from '@/lib/useGroupSettle';
import { useGroupSnapshot } from '@/lib/useGroupSnapshot';
import { isMobileWeb } from '@/lib/webEnv';

export default function GroupSettleRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  return <GroupSettleScreen key={`${id}:${myId}`} id={id} myId={myId} />;
}

function GroupSettleScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, version, finished, refetch } = useGroupSnapshot(id);
  // Pops to the group when it's under this screen, otherwise opens it (cold deep link).
  const back = { label: COPY.back, accessibilityLabel: COPY.backA11y, onPress: () => router.dismissTo(`/groups/${id}`) };
  const header = <BackHeader title={COPY.title} back={back} />;

  // Delete group C8 (docs/specs/2026-11-28-delete-group.md T6, criterion 46): the group is gone.
  if (load.status === 'deleted') return <GroupDeletedState header={header} />;
  if (load.status === 'loading') {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (load.status === 'not_allowed') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{GROUP_SCREEN_COPY.notMember}</Text>
        <Button label={GROUP_SCREEN_COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{GROUP_SCREEN_COPY.loadError}</Text>
        <Button label={GROUP_SCREEN_COPY.tryAgain} variant="primary" onPress={() => refetch()} />
      </Centered>
    );
  }
  return (
    <>
      {header}
      <SettleView id={id} myId={myId} snapshot={load.snapshot} version={version} finished={finished} refetch={refetch} />
    </>
  );
}

/** Mobile web is a phone browser (AB-6's test); anything else on web is desktop. */
function currentPlatform() {
  return sendPlatformOf(Platform.OS, isMobileWeb());
}

type Confirm = { kind: 'got_paid'; from: string; cents: number } | { kind: 'not_received'; paymentId: string };

type ViewProps = { id: string; myId: string; snapshot: GroupSnapshot; version: number; finished: number; refetch: () => number };

function SettleView({ id, myId, snapshot, version, finished, refetch }: ViewProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const platform = useMemo(currentPlatform, []);
  const nameOf = useMemo(() => groupNameOf(snapshot.members, myId), [snapshot, myId]);
  const s = useGroupSettle({ groupId: id, viewerId: myId, platform, snapshot, nameOf, refetch, version, finished });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const { attempt, justSent, sentChecks, now } = s;
  const model = useMemo(
    () => groupSettle({ snapshot, viewerId: myId, nameOf, platform, attempt, justSent, sentChecks: sentChecks ?? {}, now }),
    [snapshot, myId, nameOf, platform, attempt, justSent, sentChecks, now],
  );

  // The inline check leaves on its own when its time runs out, even if nothing else re-renders.
  const { noteChecks, setNow } = s;
  useEffect(() => {
    const left = noteChecks(model.sent);
    if (left === null) return;
    const t = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(t);
  }, [model.sent, noteChecks, setNow]);

  const recorded = recordedEntry(snapshot, s.recordedId, myId, nameOf);
  const loose = looseNotReceived(model);
  const errorFor = (target: string) => (s.error?.target === target ? s.error.text : null);
  const busyKind = s.busy?.kind ?? null;
  const formSaving = busyKind === 'form';
  // A confirm shows only while the thing it asks about is still on screen.
  const confirmingGotPaid = (from: string, cents: number) => confirm?.kind === 'got_paid' && confirm.from === from && confirm.cents === cents;
  const confirmingNotReceived = (paymentId: string) => confirm?.kind === 'not_received' && confirm.paymentId === paymentId;
  const requestFailed = requestOpenFailedLine(model, snapshot, s.requestFailure);
  const mine = s.deviceReady && (recorded !== null || model.sent.length > 0 || model.pays.length > 0 || model.requests.length > 0);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.column}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
            {COPY.title}
          </Text>
          <Text style={[type.body, { color: model.status.kind === 'owed' ? colors.success : colors.textMuted }]}>{model.status.text}</Text>
        </View>

        {s.refreshFailed ? (
          <View style={styles.inline}>
            <StatusLine text={GROUP_SCREEN_COPY.refreshFailed} tone="error" alert style={styles.flex} />
            <TextLink label={GROUP_SCREEN_COPY.tryAgain} onPress={s.retryRefresh} />
          </View>
        ) : null}

        {model.notices.length > 0 ? (
          // S1: above everything that pays or suggests.
          <Banner tone="warning">
            {model.notices.map((n) => (
              <BannerText key={n}>{n}</BannerText>
            ))}
          </Banner>
        ) : null}

        {loose.map((text) => (
          <View key={text} style={styles.inline}>
            <ToneIcon tone="warning" color={colors.warning} />
            <Text style={[type.caption, styles.flex, styles.strong, { color: colors.warning }]}>{text}</Text>
          </View>
        ))}

        {s.announcement !== null ? (
          <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
            {s.announcement}
          </Text>
        ) : null}

        {mine ? (
          <View style={styles.cards}>
            {recorded !== null ? (
              <GroupRecordedCard
                entry={recorded}
                busy={s.busy}
                error={errorFor(`rec:${recorded.paymentId}`)}
                onUndo={() => s.undoRecorded(recorded.paymentId)}
              />
            ) : null}
            {model.sent.map((e) => (
              <GroupSentCard
                key={e.paymentId}
                entry={e}
                busy={s.busy}
                error={errorFor(`sent:${e.paymentId}`)}
                onYes={() => s.checkYes(e)}
                onNo={() => s.checkNo(e)}
                onUndo={() => s.undoSent(e)}
              />
            ))}
            {model.pays.map((e) => (
              <GroupPayCard
                key={e.to}
                entry={e}
                label={owesLabel(nameOf(e.to))}
                method={chosenMethod(s.remembered, venmoOf(snapshot, e.to))}
                busy={s.busy}
                error={errorFor(`pay:${e.to}`)}
                onChoose={s.choose}
                onPay={() => s.pay(e)}
                onCash={() => s.payCash(e)}
                onOther={() => s.payOther(e)}
                onYes={s.confirmAsk}
                onNotNow={s.dismissAsk}
              />
            ))}
            {model.requests.length > 0 ? (
              <Card>
                {model.requests.map((e, i) => (
                  <GroupRequestRow
                    key={e.from}
                    entry={e}
                    label={negativeLabel(nameOf(e.from))}
                    busy={s.busy}
                    error={errorFor(`req:${e.from}`)}
                    openFailed={s.requestFailure?.from === e.from ? requestFailed : null}
                    confirming={confirmingGotPaid(e.from, e.cents)}
                    divider={i > 0}
                    onRequest={() => s.request(e)}
                    onGotPaid={() => setConfirm({ kind: 'got_paid', from: e.from, cents: e.cents })}
                    onConfirm={() => void s.gotPaid(e).then((err) => err === null && setConfirm(null))}
                    onCancel={() => setConfirm(null)}
                  />
                ))}
              </Card>
            ) : null}
          </View>
        ) : null}

        {s.deviceReady && model.received.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader title={COPY.toYouHeader} />
            <Card>
              {model.received.map((e, i) => (
                <GroupReceivedRow
                  key={e.paymentId}
                  entry={e}
                  busy={s.busy}
                  error={errorFor(`recv:${e.paymentId}`)}
                  confirming={confirmingNotReceived(e.paymentId)}
                  divider={i > 0}
                  onNotReceived={() => setConfirm({ kind: 'not_received', paymentId: e.paymentId })}
                  onConfirm={() => void s.notReceived(e).then((ok) => ok && setConfirm(null))}
                  onCancel={() => setConfirm(null)}
                />
              ))}
            </Card>
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader title={COPY.suggestionsHeader} />
          {model.suggestions.length === 0 ? (
            <Text style={[type.body, { color: colors.textMuted }]}>{COPY.everyoneSettled}</Text>
          ) : (
            <Card flush>
              {model.suggestions.map((t, i) => (
                <ListRow key={`${t.from}:${t.to}`} title={t.text} accessibilityLabel={t.text} divider={i > 0} />
              ))}
            </Card>
          )}
        </View>

        <View style={styles.section}>
          <Card flush>
            <ListRow
              title={COPY.whoPaidWhat}
              trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
              accessibilityRole="link"
              accessibilityLabel={COPY.whoPaidWhat}
              accessibilityHint={COPY.whoPaidWhatHint}
              onPress={() => router.push({ pathname: '/groups/[id]/balances', params: { id } })}
            />
          </Card>
          {formOpen ? (
            <GroupPaymentForm
              snapshot={snapshot}
              model={model}
              viewerId={myId}
              nameOf={nameOf}
              busy={s.busy !== null}
              saving={formSaving}
              error={errorFor('form')}
              onSave={s.recordFromForm}
              onClose={() => setFormOpen(false)}
            />
          ) : (
            <TextLink
              label={COPY.recordPayment}
              accessibilityHint={COPY.recordPaymentHint}
              accessibilityState={{ expanded: false }}
              onPress={() => setFormOpen(true)}
              style={styles.hug}
            />
          )}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.md },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  titleBlock: { gap: space.xs },
  cards: { gap: space.md },
  section: { gap: space.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  strong: { fontWeight: '600' },
  hug: { alignSelf: 'flex-start' },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
