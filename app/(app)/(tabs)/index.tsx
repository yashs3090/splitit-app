// Home (the Tabs tab, route /): open one of your bills (the 20 newest you host or have joined).
// New bills start from the tab bar's (+); Groups and Profile are tabs (docs/specs/2026-11-28-tab-bar-and-activity.md
// Task 5: the Groups/Profile icons, the sticky "Add receipt" bar and the Groups block moved off Home).
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 12, criterion 98).
// Sign out moved to Profile; the Venmo card is docs/specs/2026-11-24-profile-venmo.md (Task 5).
// The "added you to a bill" card, the row markers and the foreground refresh are
// docs/specs/2026-11-24-bill-markers-and-notices.md (Task 5, D5).
// The settle markers (You owe, Paid, N people left to pay, ...; drawn as status lines in rows since
// HOME-POLISH-1, components/HomeBillRow.tsx) are
// docs/specs/2026-11-25-settle-early-and-differences.md (D7, Task 9, A1.19 / SE-UX-14).
// The sticky bar, the rows, the two sections and the people counts are
// docs/specs/2026-11-26-home-mobile-refresh.md (Tasks 5 and 6, D1–D6). The groups (Waiting on you,
// Owed to you, Settled, hidden), the caught-up card and the first-load wait are
// docs/specs/2026-11-26-home-groups-v2.md (Task 2, D6 + amendment A1). Split-paid bills (several
// payers, or a stale split) are docs/specs/2026-11-26-who-paid.md D10 / Dependency X2: each plan is
// ledgerSettlePlan's, so markers, groups and amounts read the same plan as for one-payer bills.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddedNotice } from '@/components/AddedNotice';
import { GroupDeletedNotice } from '@/components/GroupDeletedNotice';
import { HomeBillRow } from '@/components/HomeBillRow';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DISCLOSURE_ROW_MARGIN, DisclosureRow } from '@/components/ui/DisclosureRow';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { VenmoPrompt } from '@/components/VenmoPrompt';
import { useSession } from '@/lib/auth';
import { fetchPeopleCounts, fetchSettleData, listMyBills, markBillSeen, type BillData, type BillSummary } from '@/lib/bills';
import { makeNameOf, splitInputFor } from '@/lib/billView';
import {
  addedNotice,
  dismissKey,
  noticeBillIds,
  settleCandidateIds,
  stillDismissed,
} from '@/lib/homeMarkers';
import {
  FIRST_SETTLE_WAIT_MS,
  HOME_COPY,
  sectionToggleA11y,
  sectionToggleText,
  type HomeOpenSection,
  homeRowView,
  homeSections,
  settledToggleA11y,
  settledToggleText,
  type HomeSettleFacts,
} from '@/lib/homeSections';
import { ledgerSettlePlan, type BillSettlePlan } from '@/lib/settle';
import { publishTabsBadge, tabsBadgeCount } from '@/lib/tabBadges';
import { layout, ROW_MIN_HEIGHT, space, TOUCH_TARGET, type, useTheme } from '@/lib/theme';

type BillsLoad = { status: 'loading' } | { status: 'error' } | { status: 'ready'; bills: BillSummary[] };

/** What a row's settle pill and amount read: the bill's settle plan (the Settle screen's) and its names. */
type SettleMap = ReadonlyMap<string, HomeSettleFacts>;
const NO_SETTLE: SettleMap = new Map();
/** People on each bill (bill_participants rows), by bill id. A bill with no known count is absent. */
type CountMap = ReadonlyMap<string, number>;
const NO_COUNTS: CountMap = new Map();

/**
 * Each bill's plan from its payments ledger (who-paid A1.4): payer_id, the bill_payers rows, every
 * bill_payments entry and flag, with early settling allowed (SE-1, as the Settle screen). A one-payer
 * bill whose payments all involve its payer gets exactly today's settlePlan; a split, or money moved
 * between other people, gets 'routes'; a split that no longer adds up, 'blocked_payers'. A bill that
 * can't be built gets no pill.
 */
function settleFactsOf(bills: ReadonlyMap<string, BillData>, myId: string): SettleMap {
  const out = new Map<string, HomeSettleFacts>();
  for (const [id, data] of bills) {
    try {
      const { plan } = ledgerSettlePlan(
        splitInputFor(data, data.claims),
        { payerId: data.bill.payer_id, payers: data.payers, payments: data.payments, flags: data.flags },
        { allowEarly: true },
      );
      out.set(id, { plan, nameOf: makeNameOf(data.participants, myId) });
    } catch {
      // Left out: a missing pill is harmless, a wrong one isn't (HM-5).
    }
  }
  return out;
}

/**
 * The previous settle facts for this load's settle candidates only (SE-UX-14, review R4): a bill that
 * left the list, or can't show a settle pill any more (e.g. no longer complete for its payer), loses
 * its pill at once instead of keeping a stale one until the read lands. Same map when nothing dropped.
 */
function keepCandidates(prev: SettleMap, candidateIds: readonly string[], bills: readonly BillSummary[]): SettleMap {
  const kept = keepOnly(prev, candidateIds);
  // Review R3: a kept plan names the payer as it was; if the new list says someone else pays now,
  // the old plan would win in viewerIsPayer and put the row in the wrong group. Drop it instead.
  const payerOf = new Map(bills.map((b) => [b.id, b.payerId]));
  // Only listed bills: one that left the list was already dropped by keepOnly above.
  const stale = (id: string, { plan }: HomeSettleFacts) => {
    const planPayer = planPayerOf(plan);
    return payerOf.has(id) && planPayer !== null && planPayer !== payerOf.get(id);
  };
  if (![...kept].some(([id, f]) => stale(id, f))) return kept;
  return new Map([...kept].filter(([id, f]) => !stale(id, f)));
}

/** The payer_id a plan was built for (a split's lead), or null for a plan that doesn't name one. */
function planPayerOf(plan: BillSettlePlan): string | null {
  if (plan.status === 'ready' || plan.status === 'early') return plan.payerId;
  if (plan.status === 'routes' || plan.status === 'blocked_payers') return plan.leadId;
  return null;
}

/**
 * The previous people counts for bills still on the list (D6): kept while this load's counts read is
 * pending, and if it fails (HR-7). A bill that left the list loses its count. Same map when nothing dropped.
 */
function keepListed(prev: CountMap, listedIds: readonly string[]): CountMap {
  return keepOnly(prev, listedIds);
}

/**
 * A1.S2: where to scroll when Settled opens, so the toggle and its first row clear the bottom of the
 * scroll area (the tab bar sits below it), or null when that row is already in view. Layout
 * points, not money. `toggleY` is the Settled block's top in the scroll content.
 */
function settledScrollTarget(toggleY: number, scrollY: number, visibleHeight: number): number | null {
  // Review R6: the block's top is the toggle's margin box (its label line), not its 44-pt target, so
  // the two negative margins come off: label line + gap + the first row (no overshoot).
  const firstRowBottom = toggleY + TOUCH_TARGET + 2 * DISCLOSURE_ROW_MARGIN + space.sm + ROW_MIN_HEIGHT;
  if (firstRowBottom <= scrollY + visibleHeight) return null;
  return firstRowBottom + space.lg - visibleHeight;
}

function keepOnly<V>(prev: ReadonlyMap<string, V>, ids: readonly string[]): ReadonlyMap<string, V> {
  const keep = new Set(ids);
  if ([...prev.keys()].every((id) => keep.has(id))) return prev;
  return new Map([...prev].filter(([id]) => keep.has(id)));
}

export default function HomeScreen() {
  const { session } = useSession();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [bills, setBills] = useState<BillsLoad>({ status: 'loading' });
  // Settle pills' data, by bill id. Kept through a refresh until the new read lands (SE-UX-14).
  const [settle, setSettle] = useState<SettleMap>(NO_SETTLE);
  // People counts for the captions ("4 people"). Kept through a refresh and a failed read (D6).
  const [counts, setCounts] = useState<CountMap>(NO_COUNTS);
  const myId = session?.user.id ?? '';
  const latest = useRef(0);
  const mounted = useRef(true);
  // Bills whose notice was dismissed here, keyed by dismissKey (bill id + joinedAt, so a re-add is
  // new again). They stay hidden from the card while the server still
  // says "new" (the seen write hasn't landed, or it failed), for as long as Home is mounted. The ref
  // is the double-tap guard; the state re-renders the card.
  const dismissedRef = useRef<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(dismissedRef.current);
  // A1.M3: the first load shows "Your bills" + spinner until a settle read has been applied, or
  // FIRST_SETTLE_WAIT_MS has passed since the first list landed. Once true, it stays true for this
  // mount: refreshes never wait.
  const [firstSettleDone, setFirstSettleDone] = useState(false);
  const firstWaitStarted = useRef(false);
  const firstWaitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // GV-11: Settled is collapsed on every mount; not stored on the device.
  const [settledOpen, setSettledOpen] = useState(false);
  // HOME-POLISH-1 (2026-11-28, user request): the action sections start open on every mount and
  // can still collapse; not stored on the device. (Settled stays collapsed, above.)
  const [closedSections, setClosedSections] = useState<ReadonlySet<HomeOpenSection>>(() => new Set());
  function toggleSection(key: HomeOpenSection) {
    setClosedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // A1.S2: what the scroll-into-view on open needs. Refs: none of them changes what's drawn.
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const visibleHeight = useRef(0);
  const columnY = useRef(0);
  const settledY = useRef(0);
  const reduceMotion = useRef(false);
  // Review R4: set on open, consumed when the opened card has laid out.
  const scrollOnOpen = useRef(false);

  const endFirstWait = useCallback(() => {
    if (firstWaitTimer.current !== null) clearTimeout(firstWaitTimer.current);
    firstWaitTimer.current = null;
    if (mounted.current) setFirstSettleDone(true);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (firstWaitTimer.current !== null) clearTimeout(firstWaitTimer.current);
      firstWaitTimer.current = null;
    };
  }, []);

  // A1.S2: the open scroll animates only when Reduce Motion is off. react-native-web reads
  // prefers-reduced-motion for both calls; its addEventListener returns nothing without matchMedia.
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) reduceMotion.current = on;
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on: boolean) => {
      reduceMotion.current = on;
    });
    return () => {
      live = false;
      // Typed as always returned, but react-native-web returns undefined without matchMedia.
      sub?.remove();
    };
  }, []);

  const loadBills = useCallback(() => {
    const mine = ++latest.current;
    void listMyBills().then((res) => {
      if (mine !== latest.current || !mounted.current) return;
      // A failed refresh keeps a list that's already on screen.
      if (res.ok) {
        setBills({ status: 'ready', bills: res.bills });
        // A1.M3: the first list of this mount starts the wait for settle data.
        if (!firstWaitStarted.current) {
          firstWaitStarted.current = true;
          firstWaitTimer.current = setTimeout(endFirstWait, FIRST_SETTLE_WAIT_MS);
        }
        // D7: read settle data only for bills that can show a settle pill.
        const candidates = settleCandidateIds(res.bills, myId);
        // Candidates keep their previous settle pill until this load's settle read lands (SE-UX-14).
        setSettle((prev) => keepCandidates(prev, candidates, res.bills));
        // Applied only while this is still the latest load. A1.S5: a failed read keeps the previous
        // facts for this load's candidates, so a failed refresh moves no row and shows no error.
        // Before any read has landed there are none, so a failed first read leaves no plans (GV-5).
        void fetchSettleData(candidates)
          .catch(() => ({ ok: false }) as const)
          .then((data) => {
            if (mine !== latest.current || !mounted.current) return;
            setSettle((prev) => (data.ok ? settleFactsOf(data.bills, myId) : keepCandidates(prev, candidates, res.bills)));
            endFirstWait();
          });
        // D6: the people counts for the same list, on the same token. Listed bills keep their previous
        // count until this read lands; a failed read keeps them and shows nothing (HR-7).
        const ids = res.bills.map((b) => b.id);
        setCounts((prev) => keepListed(prev, ids));
        void fetchPeopleCounts(ids)
          .catch(() => ({ ok: false }) as const)
          .then((read) => {
            if (mine !== latest.current || !mounted.current || !read.ok) return;
            setCounts(read.counts);
          });
        // Forget dismissed bills the server now shows seen (or that left the list or were re-added),
        // so being added to one again brings the card back.
        dismissedRef.current = stillDismissed(dismissedRef.current, res.bills, myId);
        setDismissed(dismissedRef.current);
      } else setBills((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
    });
  }, [myId, endFirstWait]);

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

  // D2–D5 and GV D5: every row's content (title, caption, pill, amount, label) and its group come
  // from one view per bill, so a row's group can't disagree with its pill. Home groups nothing itself.
  const sections = useMemo(() => {
    if (list === null) return null;
    return homeSections(list.map((b) => homeRowView(b, myId, settle.get(b.id), counts.get(b.id))));
  }, [list, myId, settle, counts]);
  const settledCount = sections?.settled.length ?? 0;

  // Task 7 (criterion 35): the Tabs badge is counted from the very sections rendered here.
  useEffect(() => {
    if (sections !== null) publishTabsBadge(myId, tabsBadgeCount(sections));
  }, [sections, myId]);

  // D7: when the last settled bill goes, the toggle unmounts and comes back collapsed.
  useEffect(() => {
    if (settledCount === 0) setSettledOpen(false);
  }, [settledCount]);

  // A1.S2: opening scrolls just enough to show the toggle and the first settled row above the bar.
  // Review R4: only once the opened card has laid out (its onLayout below), because a browser clamps
  // scrollTo to the content height before the card is there. Closing never scrolls.
  function toggleSettled() {
    const opening = !settledOpen;
    scrollOnOpen.current = opening;
    setSettledOpen(opening);
  }
  function settledCardLaidOut() {
    if (!scrollOnOpen.current) return;
    scrollOnOpen.current = false;
    const y = settledScrollTarget(columnY.current + settledY.current, scrollY.current, visibleHeight.current);
    if (y !== null) scrollRef.current?.scrollTo({ y, animated: !reduceMotion.current });
  }

  const openBill = (id: string) => router.push(`/bills/${id}`);

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

  /**
   * GV D6: the caught-up card (only when nothing is open), Items to claim, Still needs to be paid,
   * Owed to you (HOME-SEC-1/2: each a Show / Hide toggle, open by default per HOME-POLISH-1), Settled. Groups is its own tab now. One keyed list, so a block keeps its place in the tree when another appears or goes.
   * A1.S8: rows change group, and Settled opens and closes, with no motion.
   */
  function groupBlocks(): ReactElement[] {
    if (sections === null) return [];
    const { waiting, claim, pay, owed, settled, hiddenCount } = sections;
    const blocks: ReactElement[] = [];
    if (waiting.length === 0 && owed.length === 0) {
      // A1.S4: one top line in text, the note muted under it, read as one element.
      const label = hiddenCount > 0 ? `${HOME_COPY.allClear} ${HOME_COPY.hiddenNote}` : HOME_COPY.allClear;
      blocks.push(
        <Card key="allClear">
          <View accessible accessibilityLabel={label} style={styles.allClear}>
            <Text style={[type.body, { color: colors.text }]}>{HOME_COPY.allClear}</Text>
            {hiddenCount > 0 ? <Text style={[type.caption, { color: colors.textMuted }]}>{HOME_COPY.hiddenNote}</Text> : null}
          </View>
        </Card>,
      );
    }
    // HOME-SEC-1/2: Items to claim, Still needs to be paid, Owed to you; each a Show / Hide toggle.
    for (const [key, rows] of [
      ['claim', claim],
      ['pay', pay],
      ['owed', owed],
    ] as const) {
      if (rows.length === 0) continue;
      const open = !closedSections.has(key);
      blocks.push(
        <View key={key} style={styles.section}>
          <DisclosureRow
            label={sectionToggleText(key, rows.length)}
            a11yLabel={sectionToggleA11y(key, rows.length)}
            open={open}
            onToggle={() => toggleSection(key)}
            showHint={HOME_COPY.sectionShowHint}
            hideHint={HOME_COPY.sectionHideHint}
            showText={HOME_COPY.settledShow}
            hideText={HOME_COPY.settledHide}
            quiet
          />
          {open ? (
            <Card flush>
              {rows.map((row, i) => (
                <HomeBillRow key={row.id} row={row} divider={i > 0} showStatus onPress={() => openBill(row.id)} />
              ))}
            </Card>
          ) : null}
        </View>,
      );
    }
    if (settled.length > 0) {
      blocks.push(
        <View key="settled" style={styles.section} onLayout={(e: LayoutChangeEvent) => (settledY.current = e.nativeEvent.layout.y)}>
          <DisclosureRow
            label={settledToggleText(settled.length)}
            a11yLabel={settledToggleA11y(settled.length)}
            open={settledOpen}
            onToggle={toggleSettled}
            showHint={HOME_COPY.settledShowHint}
            hideHint={HOME_COPY.settledHideHint}
            showText={HOME_COPY.settledShow}
            hideText={HOME_COPY.settledHide}
            quiet
          />
          {settledOpen ? (
            <View onLayout={settledCardLaidOut}>
              <Card flush>
                {settled.map((row, i) => (
                  // A1.S3: the toggle already says "Settled"; the row's label still does too.
                  <HomeBillRow key={row.id} row={row} divider={i > 0} showStatus={false} onPress={() => openBill(row.id)} />
                ))}
              </Card>
            </View>
          ) : null}
        </View>,
      );
    }
    return blocks;
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        onLayout={(e: LayoutChangeEvent) => (visibleHeight.current = e.nativeEvent.layout.height)}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => (scrollY.current = e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        // The tab bar below covers the bottom safe area, so the list only needs its own breathing room.
        contentContainerStyle={[styles.content, { paddingTop: insets.top + space.lg, paddingBottom: space.xl }]}
      >
        <View style={styles.column} onLayout={(e: LayoutChangeEvent) => (columnY.current = e.nativeEvent.layout.y)}>
          {/* The wordmark: the screen's one heading, and the router tests' Home-ready signal (tab-bar spec Task 6). */}
          <Text accessibilityRole="header" style={[type.display, { color: colors.text }]}>
            SplitIt
          </Text>

          <GroupDeletedNotice />

          {notice ? (
            <AddedNotice notice={notice} onOpen={openBill} onDismiss={dismissNotice} />
          ) : null}

          <VenmoPrompt />

          {bills.status === 'ready' && firstSettleDone && sections !== null && bills.bills.length > 0 ? (
            groupBlocks()
          ) : (
            <View style={styles.section}>
              <SectionHeader title="Your bills" />
              {bills.status === 'error' ? (
                <Card>
                  <View style={styles.inline}>
                    <Text style={[type.body, styles.grow, { color: colors.textMuted }]}>Couldn&apos;t load your bills.</Text>
                    <Button label="Try again" variant="ghost" onPress={loadBills} />
                  </View>
                </Card>
              ) : bills.status === 'ready' && firstSettleDone ? (
                <Card>
                  <Text style={[type.body, { color: colors.textMuted }]}>No bills yet.</Text>
                </Card>
              ) : (
                // Loading, and A1.M3's first-load wait for settle data: the same spinner card.
                <Card>
                  <ActivityIndicator accessibilityLabel="Loading your bills" color={colors.textMuted} style={styles.spinner} />
                </Card>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  // Sections (header, prompts, bills) sit a section gap apart.
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  section: { gap: space.sm },
  // A1.S4: two lines of one message, label-to-value spacing.
  allClear: { gap: space.xs },
  spinner: { alignSelf: 'flex-start' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
});
