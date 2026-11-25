// Home: start a new bill, open one of "Your bills" (the 20 newest you host or have joined), open Profile.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 12, criterion 98).
// Sign out moved to Profile; the Venmo card is docs/specs/2026-11-24-profile-venmo.md (Task 5).
// The "added you to a bill" card, the row markers and the foreground refresh are
// docs/specs/2026-11-24-bill-markers-and-notices.md (Task 5, D5).
import { useFocusEffect, useRouter } from 'expo-router';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleUserRound from 'lucide-react-native/icons/circle-user-round';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddedNotice } from '@/components/AddedNotice';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ListRow } from '@/components/ui/ListRow';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { VenmoPrompt } from '@/components/VenmoPrompt';
import { useSession } from '@/lib/auth';
import { billListLabel } from '@/lib/billView';
import { listMyBills, markBillSeen, type BillSummary } from '@/lib/bills';
import {
  addedNotice,
  BILL_MARKER_COPY,
  billMarker,
  billRowA11yLabel,
  dismissKey,
  noticeBillIds,
  stillDismissed,
  type BillMarker,
} from '@/lib/homeMarkers';
import { layout, radius, space, type, useTheme } from '@/lib/theme';

type BillsLoad = { status: 'loading' } | { status: 'error' } | { status: 'ready'; bills: BillSummary[] };

export default function HomeScreen() {
  const { session } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [bills, setBills] = useState<BillsLoad>({ status: 'loading' });
  const myId = session?.user.id ?? '';
  const latest = useRef(0);
  const mounted = useRef(true);
  // Bills whose notice was dismissed here, keyed by dismissKey (bill id + joinedAt, so a re-add is
  // new again). They stay hidden from the card while the server still
  // says "new" (the seen write hasn't landed, or it failed), for as long as Home is mounted. The ref
  // is the double-tap guard; the state re-renders the card.
  const dismissedRef = useRef<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(dismissedRef.current);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadBills = useCallback(() => {
    const mine = ++latest.current;
    void listMyBills().then((res) => {
      if (mine !== latest.current || !mounted.current) return;
      // A failed refresh keeps a list that's already on screen.
      if (res.ok) {
        setBills({ status: 'ready', bills: res.bills });
        // Forget dismissed bills the server now shows seen (or that left the list or were re-added),
        // so being added to one again brings the card back.
        dismissedRef.current = stillDismissed(dismissedRef.current, res.bills, myId);
        setDismissed(dismissedRef.current);
      } else setBills((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
    });
  }, [myId]);

  // Refreshes whenever home comes back into view (e.g. after saving, joining or opening a bill),
  // and when the app returns to the foreground while home is in view (BM-11; on web,
  // react-native-web's AppState reports tab visibility).
  useFocusEffect(
    useCallback(() => {
      loadBills();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') loadBills();
      });
      return () => {
        latest.current++; // ignore a response that lands after leaving
        // jest-expo's AppState mock returns no subscription; the real one always does.
        sub?.remove();
      };
    }, [loadBills]),
  );

  const list = bills.status === 'ready' ? bills.bills : null;
  const notice = useMemo(
    () => (list === null ? null : addedNotice(list.filter((b) => !dismissed.has(dismissKey(b))), myId)),
    [list, dismissed, myId],
  );

  // D5: hide the card at once, mark each bill seen, then reload once every call has settled.
  // A failed call shows nothing: that row keeps "New" until a later success (e.g. opening it).
  function dismissNotice() {
    if (notice === null || list === null) return;
    const ids = new Set(noticeBillIds(notice));
    const bills = list.filter((b) => ids.has(b.id) && !dismissedRef.current.has(dismissKey(b)));
    if (bills.length === 0) return; // a second tap before the card is gone
    dismissedRef.current = new Set([...dismissedRef.current, ...bills.map(dismissKey)]);
    setDismissed(dismissedRef.current);
    void Promise.allSettled(bills.map((b) => markBillSeen(b.id))).then(() => {
      if (mounted.current) loadBills();
    });
  }

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xl }]}
    >
      <View style={styles.column}>
        {/* The wordmark, and Profile as an icon (proposal P4: no "Signed in as"; Profile shows the name). */}
        <View style={styles.header}>
          <Text accessibilityRole="header" style={[type.display, styles.grow, { color: colors.text }]}>
            SplitIt
          </Text>
          <IconButton
            icon={CircleUserRound}
            accessibilityLabel="Profile"
            accessibilityHint="Your name, Venmo username and sign out"
            onPress={() => router.push('/profile')}
          />
        </View>

        {notice ? (
          <AddedNotice notice={notice} onOpen={(id) => router.push(`/bills/${id}`)} onDismiss={dismissNotice} />
        ) : null}

        {/* Start a bill: on the canvas, not in a card, so the one primary button is the focal point. */}
        <View style={styles.start}>
          <View style={styles.startText}>
            <Text accessibilityRole="header" style={[type.headline, { color: colors.text }]}>
              Split a bill
            </Text>
            <Text style={[type.body, { color: colors.textMuted }]}>
              Take a photo of the receipt, then check the items it found.
            </Text>
          </View>
          <Button label="Scan receipt" variant="primary" block onPress={() => router.push('/scan')} />
        </View>

        <VenmoPrompt />

        <View style={styles.section}>
          <SectionHeader title="Your bills" />
          {bills.status === 'loading' ? (
            <Card>
              <ActivityIndicator accessibilityLabel="Loading your bills" color={colors.textMuted} style={styles.spinner} />
            </Card>
          ) : bills.status === 'error' ? (
            <Card>
              <View style={styles.inline}>
                <Text style={[type.body, styles.grow, { color: colors.textMuted }]}>Couldn&apos;t load your bills.</Text>
                <Button label="Try again" variant="ghost" onPress={loadBills} />
              </View>
            </Card>
          ) : bills.bills.length === 0 ? (
            <Card>
              <Text style={[type.body, { color: colors.textMuted }]}>No bills yet.</Text>
            </Card>
          ) : (
            <Card flush>
              {bills.bills.map((b, i) => {
                const marker = billMarker(b, myId);
                return (
                  <ListRow
                    key={b.id}
                    title={billListLabel(b, myId)}
                    caption={marker ? <MarkerPill marker={marker} /> : undefined}
                    trailing={<Icon icon={ChevronRight} color={colors.textMuted} />}
                    accessibilityRole="link"
                    accessibilityLabel={billRowA11yLabel(b, myId)}
                    accessibilityHint="Opens this bill"
                    onPress={() => router.push(`/bills/${b.id}`)}
                    divider={i > 0}
                  />
                );
              })}
            </Card>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

/** The row's marker as words in a tinted pill: never colour alone (D5). */
function MarkerPill({ marker }: { marker: BillMarker }) {
  const { colors } = useTheme();
  const tone =
    marker === 'new'
      ? { bg: colors.primarySurface, fg: colors.primary }
      : { bg: colors.surfaceMuted, fg: colors.textMuted };
  return (
    <View style={[styles.pill, { backgroundColor: tone.bg }]}>
      <Text style={[type.caption, styles.pillText, { color: tone.fg }]}>{BILL_MARKER_COPY[marker].pill}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  // Sections (header, start, prompts, your bills) sit a section gap apart.
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  start: { gap: space.md },
  startText: { gap: space.xs },
  section: { gap: space.sm },
  spinner: { alignSelf: 'flex-start' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  // The pill hugs its caption: a 2-pt inset keeps it a pill rather than a button-sized chip.
  pill: { borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  pillText: { fontWeight: '600' },
});
