// Activity: a plain-sentence timeline of what happened on a bill, newest first, grouped by time.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Activity UX", Task 17).
//
// Text only: every sentence comes from lib/activityText.ts (fixed templates); events it can't
// describe are skipped. Names come from the bill's participants; anyone else reads "Someone".
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, type AvatarPerson } from '@/components/Avatars';
import { Centered, Loading } from '@/components/Centered';
import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { useSession } from '@/lib/auth';
import {
  defaultTimeFormatters,
  describeEvent,
  groupEvents,
  timeLabelText,
  type ActivityEvent,
} from '@/lib/activityText';
import { initials, makeNameOf } from '@/lib/billView';
import { BILL_ERROR_COPY, type BillParticipant } from '@/lib/bills';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useActivity } from '@/lib/useActivity';

const LOAD_ERROR = "Couldn't load the activity.";
const EMPTY = 'Nothing yet. Claims and changes will show up here.';
/** Re-labels groups ("Just now" → "7:42 PM") while the screen stays open. */
const CLOCK_TICK_MS = 60_000;

export default function ActivityRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  return <ActivityScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

function ActivityScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { load, refetch } = useActivity(id);
  // Back to the bill: pops to it when it's under this screen, otherwise opens it.
  const toBill = useCallback(() => router.dismissTo(`/bills/${id}`), [router, id]);

  // The bar is there in every state; the back control only where it always was (the timeline).
  const header = <BackHeader title="Activity" />;
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
        <Button label="Try again" variant="primary" onPress={refetch} />
      </Centered>
    );
  }
  return (
    <>
      <BackHeader title="Activity" back={{ label: 'Bill', accessibilityLabel: 'Back to bill', onPress: toBill }} />
      <Timeline events={load.events} participants={load.participants} myId={myId} />
    </>
  );
}

type Entry = { id: string; sentence: string; person: AvatarPerson };

function Timeline(props: { events: ActivityEvent[]; participants: BillParticipant[]; myId: string }) {
  const { events, participants, myId } = props;
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(events);

  const sections = useMemo(() => {
    const nameOf = makeNameOf(participants, myId);
    const names = new Map(participants.map((p) => [p.userId, p.displayName]));
    const person = (actorId: string | null): AvatarPerson => ({
      userId: actorId ?? '',
      name: nameOf(actorId),
      // A deleted account (null) or someone no longer in the bill shows "?".
      initials: actorId !== null && names.has(actorId) ? initials(names.get(actorId) ?? null) : '?',
      isMe: actorId !== null && actorId === myId,
    });
    return groupEvents(events, now, defaultTimeFormatters)
      .map((group) => ({
        title: timeLabelText(group.label),
        entries: group.events.flatMap((e): Entry[] => {
          const sentence = describeEvent(e, nameOf);
          return sentence === null ? [] : [{ id: e.id, sentence, person: person(e.actorId) }];
        }),
      }))
      .filter((s) => s.entries.length > 0);
  }, [events, participants, myId, now]);

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
    >
      <View style={styles.column}>
        <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
          Activity
        </Text>

        {sections.length === 0 ? (
          <Text style={[type.body, { color: colors.textMuted }]}>{EMPTY}</Text>
        ) : (
          sections.map((section, si) => (
            <View key={`${si}:${section.title}`} style={styles.section}>
              <SectionHeader title={section.title} />
              <Card style={styles.card}>
                {section.entries.map((entry, i) => (
                  <View
                    key={entry.id}
                    style={[styles.entry, i > 0 && [styles.divider, { borderTopColor: colors.divider }]]}
                  >
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

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.lg },
  section: { gap: space.sm },
  card: { paddingVertical: space.xs, gap: 0 },
  entry: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  // The avatar is 24 high and the first line 22: a 1-pt nudge centres it on that line.
  sentence: { flex: 1, minWidth: 0, marginTop: 1 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
