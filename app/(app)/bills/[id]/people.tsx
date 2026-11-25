// Add people: the host adds someone they've split with straight onto this bill, and removes
// someone added by mistake. Spec: docs/specs/2026-11-24-people-and-invites.md (D6, Task 7, criteria 42–49).
//
// Rules this screen keeps:
// - Host only. Anyone else sees "Only <host> can add people." and the list is never fetched.
// - Nothing is optimistic. A write keeps its button busy until the refetch after it has finished:
//   landed (`version`) or failed (`finished`, then a "Couldn't refresh" line with a retry).
// - Every write is guarded by a ref per person, so a double tap sends one call.
// - No confirms (PI-3, PI-4): an add is undone with Remove, a remove with Add.
// - This screen never navigates on its own; only Back, and the not-found "Go home", do.
import { useLocalSearchParams, useRouter } from 'expo-router';
import Plus from 'lucide-react-native/icons/plus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatars';
import { Centered, Loading } from '@/components/Centered';
import { PeopleList } from '@/components/PeopleList';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusLine } from '@/components/ui/StatusLine';
import { defaultTimeFormatters } from '@/lib/activityText';
import { useSession } from '@/lib/auth';
import { initials, makeNameOf } from '@/lib/billView';
import { addParticipant, BILL_ERROR_COPY, removeParticipant, type BillData } from '@/lib/bills';
import { addablePeople, personName, type Person } from '@/lib/people';
import { addedText, onlyHostText, onThisBillRows, PEOPLE_COPY, removedText } from '@/lib/peopleView';
import { layout, ROW_MIN_HEIGHT, space, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';
import { usePeople } from '@/lib/usePeople';

const LOAD_ERROR = "Couldn't load the bill.";

export default function AddPeopleRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  // A new id is a new screen: no state carries over from another bill.
  return <AddPeopleScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

function AddPeopleScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, version, finished, refetch } = useBill(id);
  // Back to the bill: pops to it when it's under this screen, otherwise opens it (cold deep link).
  const toBill = useCallback(() => router.dismissTo(`/bills/${id}`), [router, id]);

  // The bar is there in every state; the back control only where it always was (the host's view).
  const header = <BackHeader title={PEOPLE_COPY.addPeople} />;
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
        <Button label="Go home" variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{LOAD_ERROR}</Text>
        <Button label="Try again" variant="primary" onPress={() => refetch()} />
      </Centered>
    );
  }

  const data = load.data;
  if (data.bill.host_id !== myId) {
    const host = data.participants.find((p) => p.userId === data.bill.host_id);
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{onlyHostText(host?.displayName ?? null)}</Text>
        <Button label={PEOPLE_COPY.backToBill} variant="primary" onPress={toBill} />
      </Centered>
    );
  }
  return (
    <>
      <BackHeader
        title={PEOPLE_COPY.addPeople}
        back={{ label: 'Back', accessibilityLabel: 'Back', accessibilityHint: 'Returns to the bill', onPress: toBill }}
      />
      <HostView data={data} myId={myId} version={version} finished={finished} refetch={refetch} />
    </>
  );
}

/** A write in flight for one person. `clearAt` is the refetch that must finish before release. */
type Busy = { kind: 'add' | 'remove'; name: string; clearAt: number | null };

type HostProps = {
  data: BillData;
  myId: string;
  version: number;
  finished: number;
  refetch: () => number;
};

function HostView({ data, myId, version, finished, refetch }: HostProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { load: peopleLoad, reload: reloadPeople } = usePeople(myId);

  const [busy, setBusy] = useState<ReadonlyMap<string, Busy>>(new Map());
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);

  /** People with a write in flight (double-tap guard; state lands a render later). */
  const writing = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Release a write once the refetch after it has finished. A newer refetch landing first counts
  // too: useBill only shows the newest response, so it already holds the change.
  useEffect(() => {
    const done = [...busy].filter(([, b]) => b.clearAt !== null && (version >= b.clearAt || finished >= b.clearAt));
    if (done.length === 0) return;
    for (const [userId] of done) writing.current.delete(userId);
    setBusy((prev) => {
      const next = new Map(prev);
      for (const [userId] of done) next.delete(userId);
      return next;
    });
    if (done.some(([, b]) => b.clearAt !== null && version < b.clearAt)) setRefreshFailed(true);
    const last = done[done.length - 1]?.[1];
    if (last) {
      // The server confirmed the write either way; announce it (iOS ignores live regions).
      const text = last.kind === 'add' ? addedText(last.name) : removedText(last.name);
      setAnnouncement(text);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
    }
  }, [busy, version, finished]);

  function start(userId: string, b: Busy) {
    writing.current.add(userId);
    setBusy((m) => new Map(m).set(userId, b));
    setAddError(null);
    setRemoveError(null);
    setAnnouncement(null);
    setRefreshFailed(false);
  }

  function waitForRefetch(userId: string) {
    const clearAt = refetch();
    setBusy((m) => {
      const b = m.get(userId);
      return b ? new Map(m).set(userId, { ...b, clearAt }) : m;
    });
  }

  function release(userId: string) {
    writing.current.delete(userId);
    setBusy((m) => {
      if (!m.has(userId)) return m;
      const next = new Map(m);
      next.delete(userId);
      return next;
    });
  }

  async function onAdd(person: Person) {
    const userId = person.userId;
    if (writing.current.has(userId)) return;
    start(userId, { kind: 'add', name: personName(person), clearAt: null });
    const res = await addParticipant(data.bill.id, userId);
    if (!mounted.current) return;
    if (res.ok) {
      waitForRefetch(userId);
      return;
    }
    release(userId);
    setAddError(BILL_ERROR_COPY[res.error]);
    // The list was out of date (they left their last shared bill): load it again.
    if (res.error === 'not_linked') reloadPeople();
    else if (res.error !== 'network') refetch();
  }

  async function onRemove(userId: string, name: string) {
    if (writing.current.has(userId)) return;
    start(userId, { kind: 'remove', name, clearAt: null });
    const res = await removeParticipant(data.bill.id, userId);
    if (!mounted.current) return;
    if (res.ok) {
      waitForRefetch(userId);
      return;
    }
    release(userId);
    setRemoveError(BILL_ERROR_COPY[res.error]);
    // They may have just claimed something: re-read so "Remove" goes away.
    if (res.error !== 'network') refetch();
  }

  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);
  const onBill = useMemo(() => onThisBillRows(data, myId, nameOf), [data, myId, nameOf]);
  const displayNames = useMemo(() => new Map(data.participants.map((p) => [p.userId, p.displayName])), [data.participants]);
  const all = peopleLoad.status === 'ready' ? peopleLoad.people : null;
  const addable = useMemo(
    () => (all === null ? [] : addablePeople(all, data.participants.map((p) => p.userId))),
    [all, data.participants],
  );

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.column}>
        <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
          {PEOPLE_COPY.addPeople}
        </Text>

        {announcement !== null ? <StatusLine text={announcement} /> : null}
        {refreshFailed ? (
          <Banner tone="error" alert>
            <View style={styles.noticeRow}>
              <View style={styles.grow}>
                <BannerText>{PEOPLE_COPY.refreshFailed}</BannerText>
              </View>
              <Button
                label="Try again"
                accessibilityLabel="Refresh the bill"
                variant="ghost"
                onPress={() => {
                  setRefreshFailed(false);
                  refetch();
                }}
                style={styles.inlineButton}
              />
            </View>
          </Banner>
        ) : null}

        <Card title={PEOPLE_COPY.cardTitle}>
          {addError !== null ? (
            <Banner tone="error" alert>
              <BannerText>{addError}</BannerText>
            </Banner>
          ) : null}
          {peopleLoad.status === 'loading' ? (
            <ActivityIndicator accessibilityLabel={PEOPLE_COPY.loading} color={colors.textMuted} style={styles.spinner} />
          ) : peopleLoad.status === 'error' ? (
            <>
              <Text accessibilityRole="alert" style={[type.body, { color: colors.text }]}>
                {PEOPLE_COPY.loadError}
              </Text>
              <Button
                label={PEOPLE_COPY.tryAgain}
                accessibilityHint="Loads the people you've split with again"
                variant="secondary"
                onPress={reloadPeople}
              />
            </>
          ) : (
            <PeopleList
              people={addable}
              all={peopleLoad.people}
              formatDate={defaultTimeFormatters.date}
              emptyText={peopleLoad.people.length === 0 ? PEOPLE_COPY.emptyAdd : PEOPLE_COPY.everyoneOn}
              renderAction={(person) => {
                const name = personName(person);
                return (
                  <Button
                    label="Add"
                    icon={Plus}
                    accessibilityLabel={`Add ${name}`}
                    accessibilityHint="Puts them on this bill so they can claim"
                    variant="secondary"
                    loading={busy.has(person.userId)}
                    onPress={() => void onAdd(person)}
                  />
                );
              }}
            />
          )}
        </Card>

        <Card title={PEOPLE_COPY.onThisBill}>
          {removeError !== null ? (
            <Banner tone="error" alert>
              <BannerText>{removeError}</BannerText>
            </Banner>
          ) : null}
          <View>
            {onBill.map((row, i) => (
              <View key={row.userId} style={[styles.row, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
                <View accessible accessibilityLabel={row.a11yLabel} style={styles.info}>
                  <Avatar
                    person={{
                      userId: row.userId,
                      name: row.name,
                      initials: initials(displayNames.get(row.userId) ?? null),
                      isMe: row.userId === myId,
                    }}
                  />
                  <View style={styles.grow}>
                    <Text style={[type.body, { color: colors.text }]}>{row.name}</Text>
                    {row.noItems ? (
                      <Text style={[type.caption, { color: colors.textMuted }]}>{PEOPLE_COPY.noItems}</Text>
                    ) : null}
                  </View>
                </View>
                {row.removable || busy.get(row.userId)?.kind === 'remove' ? (
                  <Button
                    label="Remove"
                    accessibilityLabel={`Remove ${row.name} from this bill`}
                    accessibilityHint="Takes them off this bill. You can add them again."
                    variant="ghost"
                    loading={busy.get(row.userId)?.kind === 'remove'}
                    // Their add may still be waiting for its refetch (a live update moved them here first).
                    disabled={busy.has(row.userId)}
                    onPress={() => void onRemove(row.userId, row.name)}
                  />
                ) : null}
              </View>
            ))}
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.lg },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inlineButton: { paddingHorizontal: space.sm },
  grow: { flex: 1, minWidth: 0 },
  spinner: { alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, minHeight: ROW_MIN_HEIGHT },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  info: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.md },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
