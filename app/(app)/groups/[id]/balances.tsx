// "Who paid what" for a group (spec docs/specs/2026-11-26-groups-mvp.md T16, U-G4): one row per
// member with what they paid, their share, their payments and the net, adding up to $0.00 (the sum
// line comes from lib); tap a person to see the costs behind their numbers. Then every live payment,
// with Undo for the two people in it (an inline confirm when someone else recorded it).
//
// Read-only except Undo. Every number and sentence comes from lib/groupSettleView.ts (whoPaidWhat,
// payments) and lib/groupSettleText.ts; no money math here. Undo keeps its button busy until the
// refetch after it has ended; a failed refetch says so with a retry.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { GroupDeletedState } from '@/components/GroupDeletedState';
import { WhoPaidWhatPersonRow } from '@/components/WhoPaidWhatPersonRow';
import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import { GROUP_ERROR_COPY, undoPayment, type GroupSnapshot } from '@/lib/groups';
import { GROUP_SCREEN_COPY, groupNameOf } from '@/lib/groupScreenText';
import { WHO_PAID_WHAT_COPY as COPY } from '@/lib/groupSettleText';
import { groupSettle, type PaymentRow } from '@/lib/groupSettleView';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useGroupSnapshot } from '@/lib/useGroupSnapshot';

export default function GroupBalancesRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  return <GroupBalancesScreen key={`${id}:${myId}`} id={id} myId={myId} />;
}

function GroupBalancesScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, version, finished, refetch } = useGroupSnapshot(id);
  // Pops to Settle up when it's under this screen, otherwise opens it (cold deep link).
  const back = { label: COPY.back, accessibilityLabel: COPY.backA11y, onPress: () => router.dismissTo(`/groups/${id}/settle`) };
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
  if (load.status === 'not_allowed' || load.status === 'error') {
    const notMember = load.status === 'not_allowed';
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{notMember ? GROUP_SCREEN_COPY.notMember : GROUP_SCREEN_COPY.loadError}</Text>
        {notMember ? (
          <Button label={GROUP_SCREEN_COPY.goHome} variant="primary" onPress={() => router.replace('/')} />
        ) : (
          <Button label={GROUP_SCREEN_COPY.tryAgain} variant="primary" onPress={() => refetch()} />
        )}
      </Centered>
    );
  }
  return (
    <>
      {header}
      <BalancesView myId={myId} snapshot={load.snapshot} version={version} finished={finished} refetch={refetch} />
    </>
  );
}

type ViewProps = { myId: string; snapshot: GroupSnapshot; version: number; finished: number; refetch: () => number };

function BalancesView({ myId, snapshot, version, finished, refetch }: ViewProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const nameOf = useMemo(() => groupNameOf(snapshot.members, myId), [snapshot, myId]);
  // Only Who paid what and the payment list are read; the send facts don't matter here.
  const model = useMemo(
    () => groupSettle({ snapshot, viewerId: myId, nameOf, platform: 'native', attempt: null, justSent: [], sentChecks: {}, now: 0 }),
    [snapshot, myId, nameOf],
  );
  const [open, setOpen] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; clearAt: number | null } | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const [refreshFailedAt, setRefreshFailedAt] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const writing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (busy === null || busy.clearAt === null || finished < busy.clearAt) return;
    if (version < busy.clearAt) setRefreshFailedAt(version);
    else setAnnouncement(COPY.undone);
    writing.current = false;
    setBusy(null);
  }, [busy, version, finished]);

  const undo = (p: PaymentRow) => {
    if (writing.current) return;
    writing.current = true;
    setBusy({ id: p.id, clearAt: null });
    setError(null);
    setAnnouncement(null);
    setRefreshFailedAt(null);
    void undoPayment(p.id).then((res) => {
      if (!mounted.current) return;
      if (!res.ok) {
        writing.current = false;
        setBusy(null);
        setError({ id: p.id, text: GROUP_ERROR_COPY[res.error] });
        return;
      }
      setConfirming(null);
      setBusy({ id: p.id, clearAt: refetch() });
    });
  };

  const toggle = (userId: string) => setOpen((o) => (o.includes(userId) ? o.filter((x) => x !== userId) : [...o, userId]));
  const showRefreshFailed = refreshFailedAt !== null && refreshFailedAt === version && busy === null;

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}>
      <View style={styles.column}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
            {COPY.title}
          </Text>
          <Text style={[type.caption, { color: colors.textMuted }]}>{COPY.intro}</Text>
        </View>

        {showRefreshFailed ? (
          <View style={styles.inline}>
            <StatusLine text={GROUP_SCREEN_COPY.refreshFailed} tone="error" alert style={styles.flex} />
            <TextLink
              label={GROUP_SCREEN_COPY.tryAgain}
              onPress={() => {
                setRefreshFailedAt(null);
                refetch();
              }}
            />
          </View>
        ) : null}

        <View style={styles.section}>
          <Card flush>
            {model.whoPaidWhat.rows.map((row, i) => (
              <WhoPaidWhatPersonRow key={row.userId} row={row} open={open.includes(row.userId)} divider={i > 0} onToggle={() => toggle(row.userId)} />
            ))}
          </Card>
          <Text style={[type.caption, styles.sum, { color: colors.textMuted }]}>{model.whoPaidWhat.sumLine}</Text>
        </View>

        <View style={styles.section}>
          <SectionHeader title={COPY.paymentsHeader} />
          {announcement !== null ? (
            <Text accessibilityLiveRegion="polite" style={[type.caption, { color: colors.textMuted }]}>
              {announcement}
            </Text>
          ) : null}
          {model.payments.length === 0 ? (
            <Text style={[type.body, { color: colors.textMuted }]}>{COPY.noPayments}</Text>
          ) : (
            <Card flush>
              {model.payments.map((p, i) => {
                const asking = confirming === p.id && p.undoConfirm !== null;
                const loading = busy?.id === p.id;
                return (
                  <View key={p.id} style={[styles.payment, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
                    <View style={styles.paymentTop}>
                      <View accessible accessibilityLabel={`${p.text}, ${p.methodLine}`} style={styles.flex}>
                        <Text style={[type.body, { color: colors.text }]}>{p.text}</Text>
                        <Text style={[type.caption, { color: colors.textMuted }]}>{p.methodLine}</Text>
                      </View>
                      {p.canUndo && !asking ? (
                        <Button
                          label={COPY.undo}
                          variant="ghost"
                          flush="end"
                          accessibilityLabel={`${COPY.undo}: ${p.text}`}
                          accessibilityHint={p.undoConfirm !== null ? COPY.undoConfirmHint : COPY.undoHint}
                          loading={loading}
                          disabled={busy !== null && !loading}
                          onPress={() => (p.undoConfirm !== null ? setConfirming(p.id) : undo(p))}
                        />
                      ) : null}
                    </View>
                    {asking && p.undoConfirm !== null ? (
                      <View style={styles.confirm}>
                        <Text style={[type.body, { color: colors.text }]}>{p.undoConfirm}</Text>
                        <View style={styles.buttons}>
                          <Button label={COPY.undo} variant="danger" loading={loading} disabled={busy !== null && !loading} onPress={() => undo(p)} />
                          <Button label={COPY.cancel} variant="ghost" disabled={loading} onPress={() => setConfirming(null)} />
                        </View>
                      </View>
                    ) : null}
                    {error?.id === p.id ? <StatusLine text={error.text} tone="error" size="caption" alert /> : null}
                  </View>
                );
              })}
            </Card>
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
  section: { gap: space.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  sum: { paddingHorizontal: space.xs },
  payment: { gap: space.sm, paddingVertical: space.md, paddingHorizontal: space.lg },
  paymentTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  confirm: { gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
