// Group Activity: a plain-sentence timeline of what happened in a group (people joining and
// leaving, costs, payments, receipts moving in or out), newest first. Spec:
// docs/specs/2026-11-26-groups-mvp.md T14 (with T10's lib/groupActivityText.ts), A1 N2, GR-M7.
//
// Two reads: the events (fetchGroupEvents, newest `seq` first) and the snapshot, for names and
// expense titles. Every sentence is a fixed template from describeGroupEvent; events it can't
// describe are skipped. Someone who left reads "A former member" (GR-M7). Refetched on focus.
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, type AvatarPerson } from '@/components/Avatars';
import { Centered, Loading } from '@/components/Centered';
import { GroupDeletedState } from '@/components/GroupDeletedState';
import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { defaultTimeFormatters } from '@/lib/activityText';
import { useSession } from '@/lib/auth';
import { initials } from '@/lib/billView';
import { describeGroupEvent, paymentsFromEvents } from '@/lib/groupActivityText';
import { fetchGroupEvents, fetchGroupSnapshot, type GroupEvent, type GroupSnapshot } from '@/lib/groups';
import { GROUP_ACTIVITY_COPY as COPY, GROUP_SCREEN_COPY, groupEventSections, groupNameOf } from '@/lib/groupScreenText';
import { layout, space, type, useTheme } from '@/lib/theme';

/** Re-labels sections ("Just now" becomes "7:42 PM") while the screen stays open. */
const CLOCK_TICK_MS = 60_000;

type Load =
  | { status: 'loading' }
  | { status: 'not_allowed' }
  | { status: 'error' }
  | { status: 'ready'; events: GroupEvent[]; snapshot: GroupSnapshot }
  /** Shown, then refused: the group was deleted (docs/specs/2026-11-28-delete-group.md A2.9, T6). Sticky. */
  | { status: 'deleted' };

export default function GroupActivityRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  return <GroupActivityScreen key={`${id}:${myId}`} id={id} myId={myId} />;
}

function GroupActivityScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const started = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    const mine = ++started.current;
    void Promise.all([fetchGroupEvents(id), fetchGroupSnapshot(id)]).then(([ev, snap]) => {
      if (!mounted.current || mine !== started.current) return;
      if (ev.ok && snap.ok) {
        setLoad({ status: 'ready', events: ev.events, snapshot: snap.snapshot });
      } else if ((!ev.ok && ev.error === 'not_allowed') || (!snap.ok && snap.error === 'not_allowed')) {
        // Once the timeline was shown, a refusal means the group is gone (as lib/useGroupSnapshot.ts).
        setLoad((prev) => (prev.status === 'ready' || prev.status === 'deleted' ? { status: 'deleted' } : { status: 'not_allowed' }));
      } else {
        // A failed refetch keeps the timeline on screen; the first load shows the error.
        setLoad((prev) => (prev.status === 'ready' || prev.status === 'deleted' ? prev : { status: 'error' }));
      }
    });
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  // Back to the group: pops to it when it's under this screen, otherwise opens it (cold deep link).
  const toGroup = useCallback(() => router.dismissTo(`/groups/${id}`), [router, id]);
  const header = <BackHeader title={COPY.title} back={{ label: COPY.back, accessibilityLabel: COPY.backA11y, onPress: toGroup }} />;

  // Delete group C8 (criterion 46): nothing about the group is shown.
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
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{COPY.loadError}</Text>
        <Button label={GROUP_SCREEN_COPY.tryAgain} variant="primary" onPress={refetch} />
      </Centered>
    );
  }
  return (
    <>
      {header}
      <Timeline events={load.events} snapshot={load.snapshot} myId={myId} />
    </>
  );
}

type Entry = { id: string; sentence: string; person: AvatarPerson };

function Timeline({ events, snapshot, myId }: { events: GroupEvent[]; snapshot: GroupSnapshot; myId: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(events);

  const sections = useMemo(() => {
    const nameOf = groupNameOf(snapshot.members, myId);
    const members = new Map(snapshot.members.map((m) => [m.userId, m.displayName]));
    const titles = new Map(snapshot.expenses.map((e) => [e.id, e.title]));
    const payments = paymentsFromEvents(events);
    const ctx = { expenseTitle: (eid: string) => titles.get(eid) ?? null, payment: (pid: string) => payments.get(pid) ?? null };
    const person = (actorId: string | null): AvatarPerson => ({
      userId: actorId ?? '',
      name: nameOf(actorId),
      // A deleted account or a former member shows "?".
      initials: actorId !== null && members.has(actorId) ? initials(members.get(actorId) ?? null) : '?',
      isMe: actorId !== null && actorId === myId,
    });
    return groupEventSections(events, now, defaultTimeFormatters)
      .map((section) => ({
        title: section.title,
        entries: section.events.flatMap((e): Entry[] => {
          const sentence = describeGroupEvent(e, nameOf, ctx);
          return sentence === null ? [] : [{ id: e.id, sentence, person: person(e.actorId) }];
        }),
      }))
      .filter((s) => s.entries.length > 0);
  }, [events, snapshot, myId, now]);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
    >
      <View style={styles.column}>
        <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
          {COPY.title}
        </Text>
        {sections.length === 0 ? (
          <Text style={[type.body, { color: colors.textMuted }]}>{COPY.empty}</Text>
        ) : (
          sections.map((section, si) => (
            <View key={`${si}:${section.title}`} style={styles.section}>
              <SectionHeader title={section.title} />
              <Card style={styles.card}>
                {section.entries.map((entry, i) => (
                  <View key={entry.id} style={[styles.entry, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}>
                    <Avatar person={entry.person} />
                    <Text style={[type.body, styles.sentence, { color: colors.text }]}>{entry.sentence}</Text>
                  </View>
                ))}
              </Card>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

/** The current time, refreshed when new events arrive and once a minute. */
function useNow(events: unknown): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => setNow(new Date()), [events]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** components/Avatars.tsx's Avatar: a 20-pt circle inside a 2-pt ring, 24 overall (not exported there). */
const AVATAR_OUTER = 24;
/**
 * Optical nudge, not a spacing token (no token is this small; review R10): moves the sentence down so
 * its first line (type.body, 22 high) is centred on the 24-pt avatar beside it. Works out to 1 pt.
 */
const SENTENCE_NUDGE = (AVATAR_OUTER - type.body.lineHeight) / 2;

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingTop: space.md },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.lg },
  section: { gap: space.sm },
  card: { paddingVertical: space.xs, gap: 0 },
  entry: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  sentence: { flex: 1, minWidth: 0, marginTop: SENTENCE_NUDGE },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
