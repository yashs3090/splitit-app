// Home's Groups block: your groups (name, the other members' avatars, and one status: "Claim your
// items on 1 bill", "You owe $12.50", "You're owed $8.00", "2 items left to claim" or "Settled up"),
// "New group", and "Hidden groups (N)" with Show / Hide and Unhide.
// Spec: docs/specs/2026-11-26-groups-mvp.md T13 (criterion 62) and the coordinator's row additions;
// docs/specs/2026-11-27-group-claim-status.md T4 (C2: the status's color comes from its tone).
// Row hues (docs/specs/2026-11-28-tab-bar-and-activity.md Contract M, Task 10; reverses GCS-7): only a
// `claim` row (warningSurface) and a `settled` row (surfaceMuted, with a check before "Settled up") are
// tinted; every other row is plain. Decisions GR-T13-1..-6, GCS-* and FEED-20 in docs/decisions-to-review.md.
// Every word and status comes from lib/groupHomeView.ts; this file only lays it out.
//
// Self-contained so Home adds it with one import and one element (between "Owed to you" and
// "Settled", home-groups-v2 D6). It loads its own data on focus, like Home's bill list, keeps the last
// good list when a refetch fails, and never navigates on its own: only a tap opens a screen.
// The hidden-groups toggle is components/ui/DisclosureRow, like Home's "Settled (N)".
//
// `variant="page"` is the same block as the body of the "Your groups" screen (app/(app)/groups/index.tsx),
// which owns the title and the one "New group" button. There the block has no heading or "New group"
// link of its own, shows a spinner while loading (it is the whole screen, not one block among others),
// and says "No groups yet. …" when there are none. Rows, snapshots, hidden groups and errors are shared.
import { useFocusEffect, useRouter } from 'expo-router';
import Check from 'lucide-react-native/icons/check';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import Plus from 'lucide-react-native/icons/plus';
import UsersRound from 'lucide-react-native/icons/users-round';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatars';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DisclosureRow } from '@/components/ui/DisclosureRow';
import { Icon } from '@/components/ui/Icon';
import { ListRow, type ListRowHighlight } from '@/components/ui/ListRow';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import {
  detailIds,
  GROUP_ROW_AVATARS,
  groupHomeRow,
  GROUPS_HOME_COPY as COPY,
  GROUPS_PAGE_COPY,
  hiddenGroupRow,
  splitGroups,
  withUnhidden,
  type GroupAvatar,
  type GroupHomeRow,
} from '@/lib/groupHomeView';
import { fetchGroupSnapshot, listMyGroups, setGroupHidden, type GroupSnapshot, type GroupSummary } from '@/lib/groups';
import { space, TOUCH_TARGET, type, useTheme, type Palette } from '@/lib/theme';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; groups: GroupSummary[] };

export type GroupsSectionVariant = 'home' | 'page';

export function GroupsSection({ variant = 'home' }: { variant?: GroupsSectionVariant }) {
  const page = variant === 'page';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  const router = useRouter();
  const { colors } = useTheme();

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, GroupSnapshot>>(new Map());
  const [showHidden, setShowHidden] = useState(false);
  const [unhiding, setUnhiding] = useState<string | null>(null);
  /** The group an Unhide failed for; shown only while that group is still in the hidden list. */
  const [unhideFailed, setUnhideFailed] = useState<string | null>(null);

  const latest = useRef(0);
  const unhidingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Another account on the same device never sees the last one's groups (sign-out also unmounts Home).
  useEffect(() => {
    setLoad({ status: 'loading' });
    setSnapshots(new Map());
    setShowHidden(false);
    setUnhideFailed(null);
  }, [myId]);

  const loadDetails = useCallback((groups: readonly GroupSummary[], mine: number) => {
    for (const id of detailIds(groups)) {
      void fetchGroupSnapshot(id).then((res) => {
        if (!mounted.current || mine !== latest.current || !res.ok) return; // a failed read keeps the last one
        setSnapshots((prev) => new Map(prev).set(id, res.snapshot));
      });
    }
  }, []);

  const loadGroups = useCallback(() => {
    if (!myId) return;
    const mine = ++latest.current;
    void listMyGroups().then((res) => {
      if (!mounted.current || mine !== latest.current) return;
      if (res.ok) {
        setLoad({ status: 'ready', groups: res.groups });
        loadDetails(res.groups, mine);
      } else {
        // A failed refresh keeps the list on screen; only a first load shows the error.
        setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      }
    });
  }, [myId, loadDetails]);

  useFocusEffect(
    useCallback(() => {
      loadGroups();
      return () => {
        latest.current++; // ignore responses that land after leaving Home
      };
    }, [loadGroups]),
  );

  const groups = load.status === 'ready' ? load.groups : null;
  const lists = useMemo(() => (groups === null ? null : splitGroups(groups)), [groups]);
  const rows = useMemo(
    () => lists?.visible.map((g) => groupHomeRow(g, snapshots.get(g.id) ?? null, myId)) ?? [],
    [lists, snapshots, myId],
  );
  const hiddenCount = lists?.hidden.length ?? 0;
  // When the last hidden group goes, the toggle unmounts and comes back closed.
  useEffect(() => {
    if (hiddenCount === 0) setShowHidden(false);
  }, [hiddenCount]);

  async function onUnhide(group: GroupSummary) {
    if (unhidingRef.current) return;
    unhidingRef.current = true;
    setUnhiding(group.id);
    setUnhideFailed(null);
    const res = await setGroupHidden(group.id, false);
    unhidingRef.current = false;
    if (!mounted.current) return;
    setUnhiding(null);
    if (!res.ok) {
      setUnhideFailed(group.id);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(COPY.unhideFailed);
      return;
    }
    // The write committed: show it now. The refetch is a separate step; if it fails, this stays.
    setLoad((prev) => (prev.status === 'ready' ? { status: 'ready', groups: withUnhidden(prev.groups, group.id) } : prev));
    loadGroups();
  }

  const openGroup = (id: string) => router.push(`/groups/${id}`);
  const newGroup = () => router.push('/groups/new');

  if (load.status === 'loading') {
    // On the Groups screen this block is the screen's content, so it shows that it's working.
    if (page) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator accessibilityLabel={GROUPS_PAGE_COPY.loading} color={colors.textMuted} />
        </View>
      );
    }
    // Quiet first load: Home already shows its own spinner for the bills, so this block waits
    // without a second one, and appears once there is something to show (no "Start a group" flash
    // for someone who has groups).
    return null;
  }

  if (load.status === 'error') {
    return (
      <View style={styles.section}>
        {page ? null : <SectionHeader title={COPY.heading} />}
        <Card>
          <View style={styles.inline}>
            <Text accessibilityRole="alert" style={[type.body, styles.grow, { color: colors.textMuted }]}>
              {COPY.loadFailed}
            </Text>
            <Button label={COPY.tryAgain} accessibilityLabel={COPY.tryAgainA11y} variant="ghost" onPress={loadGroups} />
          </View>
        </Card>
      </View>
    );
  }

  const hidden = lists?.hidden ?? [];
  const failedStillHidden = unhideFailed !== null && hidden.some((g) => g.id === unhideFailed);

  const hiddenBlock =
    hiddenCount > 0 ? (
      <View style={styles.section}>
        <HiddenToggle count={hiddenCount} open={showHidden} onToggle={() => setShowHidden((v) => !v)} />
        {showHidden ? (
          <Card flush>
            {hidden.map((g, i) => {
              const row = hiddenGroupRow(g);
              return (
                <ListRow
                  key={g.id}
                  title={row.title}
                  caption={row.caption}
                  accessibilityLabel={`${row.title}, ${row.caption}, hidden`}
                  divider={i > 0}
                  trailing={
                    <Button
                      label={COPY.unhide}
                      accessibilityLabel={COPY.unhideA11y(row.title)}
                      accessibilityHint={COPY.unhideHint}
                      variant="ghost"
                      loading={unhiding === g.id}
                      disabled={unhiding !== null && unhiding !== g.id}
                      onPress={() => void onUnhide(g)}
                    />
                  }
                />
              );
            })}
          </Card>
        ) : null}
        {showHidden && failedStillHidden ? <StatusLine text={COPY.unhideFailed} tone="error" size="caption" alert /> : null}
      </View>
    ) : null;

  if (rows.length === 0) {
    // No groups to show: one quiet way in (on the Groups screen, its "New group" button above is
    // the way in, so this only says why the list is empty), plus the hidden ones if there are any.
    return (
      <View style={styles.section}>
        {page ? (
          <Text style={[type.body, { color: colors.textMuted }]}>{GROUPS_PAGE_COPY.empty}</Text>
        ) : (
          <TextLink label={COPY.startGroup} accessibilityHint={COPY.startGroupHint} icon={UsersRound} onPress={newGroup} />
        )}
        {hiddenBlock}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {page ? null : (
        <View style={styles.headerRow}>
          <SectionHeader title={COPY.heading} style={styles.grow} />
          <TextLink label={COPY.newGroup} accessibilityHint={COPY.newGroupHint} icon={Plus} onPress={newGroup} />
        </View>
      )}
      <Card flush>
        {rows.map((row, i) => (
          <GroupRow key={row.id} row={row} divider={i > 0} onPress={() => openGroup(row.id)} />
        ))}
      </Card>
      {hiddenBlock}
    </View>
  );
}

/** C2's tone as a theme color. The words always carry the state too, so color is never the only cue. */
function toneColor(tone: NonNullable<GroupHomeRow['status']>['tone'] | undefined, colors: Palette): string {
  switch (tone) {
    case 'warning':
      return colors.warning;
    case 'success':
      return colors.success;
    case 'text':
      return colors.text;
    default:
      return colors.textMuted;
  }
}

/**
 * Contract M's row hue: only the two cases the user asked for (U10). Owe, owed, waiting and a row
 * still loading (no status yet) stay plain.
 */
function rowHue(kind: NonNullable<GroupHomeRow['status']>['kind'] | undefined): ListRowHighlight | undefined {
  if (kind === 'claim') return 'warning';
  if (kind === 'settled') return 'muted';
  return undefined;
}

/**
 * One group: name, then its status (or people count) under it in the status's color; the other
 * members' initials and a chevron on the right. The whole row is one link whose label says all of
 * it (the avatars and the settled check are decorative: the label says "Settled up").
 * The title stays in `text` and the chevron in `textMuted` on every row, tinted or not.
 */
function GroupRow({ row, divider, onPress }: { row: GroupHomeRow; divider: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const kind = row.status?.kind;
  const captionColor = toneColor(row.status?.tone, colors);
  const captionText = <Text style={[type.caption, { color: captionColor }]}>{row.caption}</Text>;
  return (
    <ListRow
      title={row.title}
      caption={
        kind === 'settled' ? (
          <View style={styles.captionRow}>
            <Icon icon={Check} size="sm" color={captionColor} />
            {captionText}
          </View>
        ) : (
          captionText
        )
      }
      highlight={rowHue(kind)}
      trailing={
        <View style={styles.trailing}>
          <AvatarStack people={row.avatars} />
          <Icon icon={ChevronRight} color={colors.textMuted} />
        </View>
      }
      accessibilityRole="link"
      accessibilityLabel={row.a11yLabel}
      accessibilityHint={COPY.openHint}
      onPress={onPress}
      divider={divider}
    />
  );
}

/** Up to GROUP_ROW_AVATARS overlapping initials, then "+N". Hidden from screen readers. */
function AvatarStack({ people }: { people: readonly GroupAvatar[] }) {
  const { colors } = useTheme();
  if (people.length === 0) return null;
  const shown = people.slice(0, GROUP_ROW_AVATARS);
  const extra = people.length - shown.length;
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      aria-hidden
      style={styles.avatars}
    >
      {shown.map((p, i) => (
        <Avatar key={p.userId} person={p} style={i > 0 ? styles.overlap : undefined} />
      ))}
      {extra > 0 ? <Text style={[type.micro, styles.more, { color: colors.textMuted }]}>+{extra}</Text> : null}
    </View>
  );
}

/** "Hidden groups (2)" with Show / Hide: the app's one disclosure row (components/ui/DisclosureRow). */
function HiddenToggle({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  return (
    <DisclosureRow
      label={COPY.hiddenLabel(count)}
      a11yLabel={COPY.hiddenA11y(count)}
      open={open}
      onToggle={onToggle}
      showHint={COPY.showHiddenHint}
      hideHint={COPY.hideHint}
      showText={COPY.show}
      hideText={COPY.hide}
    />
  );
}

/** The 44-pt "New group" target overlaps the gaps around the heading, so the heading keeps its grid (as DisclosureRow does). */
const HEADER_LINK_MARGIN = -(TOUCH_TARGET - type.section.lineHeight) / 2;

const styles = StyleSheet.create({
  section: { gap: space.sm },
  loading: { paddingVertical: space.xl, alignItems: 'center' },
  // The heading on the section grid, "New group" at the far end on the same line.
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginVertical: HEADER_LINK_MARGIN },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // The settled check sits on the caption's line, a small gap before "Settled up".
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  avatars: { flexDirection: 'row', alignItems: 'center' },
  // Same overlap and "+N" spacing as components/Avatars.
  overlap: { marginLeft: -6 },
  more: { marginLeft: space.xs },
});
