// The Activity tab (route /activity): one timeline of what involves you, newest first, under day
// headers (docs/specs/2026-11-28-tab-bar-and-activity.md Task 8; Contracts C and M; criteria 39–52;
// A1.1). Data and seen state: lib/useActivityFeed.ts. Lines: lib/feedView.ts → components/FeedLine.
//
//   Activity                      ← title (header)
//   [All | Money | Groups]        ← one radiogroup; a change discards the pages and refetches
//   Today                         ← day header (header role)
//   ┌───────────────────────────┐
//   │ (◎) Maya added you. …   • │  ← a line opens its bill or group (one tap, one push)
//   └───────────────────────────┘
//   Loading more activity / Couldn't load more. Try again / That's everything.
//
// States (Contract C): loading (spinner "Loading activity"), first-load error with "Try again"
// (offline reads the same), empty per chip, the list, loading more, load-more error with "Try again",
// the end. A refresh that fails keeps the list and shows nothing. The title and chips stay on every
// state, so the screen never jumps, and stay mounted through a chip change (keyboard focus stays).
// Signed-in only (the (app) layout guards it); keyed by user, so
// another person on the device starts clean. Never navigates on its own: only a tap opens a screen.
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FeedLine } from '@/components/FeedLine';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SegmentedControl, type SegmentOption } from '@/components/ui/SegmentedControl';
import { defaultTimeFormatters } from '@/lib/activityText';
import { useSession } from '@/lib/auth';
import { FEED_FILTERS, type FeedFilter } from '@/lib/feedRules';
import { defaultDayHeaderFormatters, FEED_COPY, FEED_SCREEN_A11Y } from '@/lib/feedText';
import { feedView, type FeedLine as FeedLineView, type FeedSection, type FeedViewFormatters } from '@/lib/feedView';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useActivityFeed, type ActivityFeed } from '@/lib/useActivityFeed';

const FORMATTERS: FeedViewFormatters = { time: defaultTimeFormatters.time, ...defaultDayHeaderFormatters };

const CHIPS: readonly SegmentOption<FeedFilter>[] = FEED_FILTERS.map((f) => ({ value: f, label: FEED_COPY.chips[f] }));

export default function ActivityRoute() {
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  return <ActivityScreen key={myId} myId={myId} />;
}

function ActivityScreen({ myId }: { myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const feed = useActivityFeed(myId);
  const { load, isSeen } = feed;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const sections = useMemo<FeedSection[]>(
    () => (load.status === 'ready' ? feedView(load.items, load.facts, isSeen, load.now, FORMATTERS) : []),
    [load, isSeen],
  );

  // One tap, one push (criterion 48): set synchronously, cleared when the tab is focused again.
  const opening = useRef(false);
  useFocusEffect(
    useCallback(() => {
      opening.current = false;
    }, []),
  );
  const open = useCallback(
    (line: FeedLineView) => {
      if (opening.current) return;
      opening.current = true;
      // `from=feed`: a feed line proves membership, so a refused first load reads as a deleted group
      // (delete-group spec A1.1, DG-T6-1).
      router.push('bill' in line.opens ? `/bills/${line.opens.bill}` : `/groups/${line.opens.group}?from=feed`);
    },
    [router],
  );

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setFilter = useCallback(
    (f: FeedFilter) => {
      setExpanded(new Set());
      feed.setFilter(f);
    },
    [feed],
  );

  const ready = load.status === 'ready' ? load : null;
  // A page can hold no line yet still not be the end (rounds ran out, A1.1): keep reading.
  const needsMore = ready !== null && sections.length === 0 && !ready.end && ready.more === 'idle';
  const { loadMore, refresh } = feed;
  const onRefresh = useCallback(() => {
    if (ready !== null) refresh();
  }, [ready, refresh]);
  const onEndReached = useCallback(() => {
    if (ready !== null && ready.more === 'idle') loadMore();
  }, [ready, loadMore]);
  // Runs after each answer (load changes every time), so an empty-but-not-the-end page keeps going.
  useEffect(() => {
    if (needsMore) loadMore();
  }, [load, needsMore, loadMore]);

  const header = (
    <View style={styles.head}>
      <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
        {FEED_COPY.title}
      </Text>
      <SegmentedControl
        options={CHIPS}
        value={feed.filter}
        onChange={setFilter}
        semantics="radio"
        groupLabel={FEED_SCREEN_A11Y.filterGroup}
      />
    </View>
  );

  return (
    <FlatList
      testID="activity-list"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.lg, paddingBottom: space.xl }]}
      data={sections}
      keyExtractor={(s) => s.key}
      ListHeaderComponent={header}
      ListHeaderComponentStyle={styles.column}
      renderItem={({ item }) => (
        <View style={[styles.column, styles.section]}>
          <SectionHeader title={item.title} />
          <Card flush>
            {item.lines.map((line, i) => (
              <FeedLine
                key={line.key}
                line={line}
                divider={i > 0}
                expanded={expanded.has(line.key)}
                onToggle={toggle}
                onOpen={open}
              />
            ))}
          </Card>
        </View>
      )}
      ItemSeparatorComponent={Gap}
      ListEmptyComponent={<Body load={load} feed={feed} empty={ready !== null && ready.end} />}
      ListFooterComponent={sections.length > 0 && ready !== null ? <Footer more={ready.more} end={ready.end} onRetry={loadMore} /> : null}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      // Always mounted (criterion 50): react-native-web's ScrollView wraps its tree in the refresh
      // control when there is one, so adding or removing it on a chip change remounted the chips and
      // dropped keyboard focus. Pulling does nothing until a list is on screen.
      refreshControl={
        <RefreshControl enabled={ready !== null} refreshing={feed.refreshing} onRefresh={onRefresh} tintColor={colors.textMuted} />
      }
    />
  );
}

function Gap() {
  return <View style={styles.gap} />;
}

/** Everything shown when there are no lines: loading, the first-load error, or the chip's empty copy. */
function Body({ load, feed, empty }: { load: ActivityFeed['load']; feed: ActivityFeed; empty: boolean }) {
  const { colors } = useTheme();
  if (load.status === 'loading') {
    return (
      <View style={[styles.column, styles.state]}>
        <ActivityIndicator accessibilityLabel={FEED_COPY.loading} color={colors.textMuted} />
      </View>
    );
  }
  if (load.status === 'error') {
    return (
      <View style={[styles.column, styles.state]}>
        <Text accessibilityRole="alert" style={[type.body, styles.message, { color: colors.text }]}>
          {FEED_COPY.loadError}
        </Text>
        <Button label={FEED_COPY.tryAgain} variant="primary" onPress={feed.retry} />
      </View>
    );
  }
  if (empty) {
    return (
      <View style={[styles.column, styles.state]}>
        <Text style={[type.body, styles.message, { color: colors.textMuted }]}>{FEED_COPY.empty[feed.filter]}</Text>
      </View>
    );
  }
  // No line yet, but not the end: the next page is on its way.
  return <Footer more={load.more === 'error' ? 'error' : 'loading'} end={false} onRetry={feed.loadMore} />;
}

function Footer({ more, end, onRetry }: { more: 'idle' | 'loading' | 'error'; end: boolean; onRetry: () => void }) {
  const { colors } = useTheme();
  if (more === 'loading') {
    return (
      <View style={[styles.column, styles.footer]}>
        <ActivityIndicator accessibilityLabel={FEED_COPY.loadingMore} color={colors.textMuted} />
      </View>
    );
  }
  if (more === 'error') {
    return (
      <View style={[styles.column, styles.footer]}>
        <Text accessibilityRole="alert" style={[type.body, styles.message, { color: colors.text }]}>
          {FEED_COPY.loadMoreError}
        </Text>
        <Button label={FEED_COPY.tryAgain} variant="secondary" onPress={onRetry} />
      </View>
    );
  }
  if (end) {
    return (
      <View style={[styles.column, styles.footer]}>
        <Text style={[type.caption, styles.message, { color: colors.textMuted }]}>{FEED_COPY.end}</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: layout.screenPadding },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center' },
  head: { gap: space.lg, paddingBottom: space.lg },
  section: { gap: space.sm },
  gap: { height: space.lg },
  state: { alignItems: 'center', gap: space.lg, paddingVertical: space.xxl },
  footer: { alignItems: 'center', gap: space.md, paddingTop: space.xl },
  message: { textAlign: 'center', maxWidth: layout.message },
});
