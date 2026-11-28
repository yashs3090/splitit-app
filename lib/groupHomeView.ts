// Home's Groups block (components/GroupsSection.tsx): what each group row says, as a pure view model.
// Spec: docs/specs/2026-11-26-groups-mvp.md T13 (criterion 62), with the coordinator's additions for
// the row (member avatars), as changed by docs/specs/2026-11-27-group-claim-status.md (C2, T3).
// Decisions GR-T13-1..-6 and GCS-1..-14 in docs/decisions-to-review.md. The component renders only
// what this returns: no counting, no money, no status of its own (lesson 2026-11-25 "one status
// source per screen").
//
// GCS-5 overrides GR-20: a row now says what *I* have to do, or my own net. Its caption is the first
// of these that holds (C2):
//   1. "Claim your items on 2 bills"  receipts that need me (C1, lib/groupClaimStatus.ts)   warning
//   2. "You owe $12.50"               my net, below -1¢ (viewerNet / isSettledUp)           text
//   3. "You're owed $8.00"            my net, above +1¢                                     success
//   4. "2 items left to claim"        a receipt waits on others' claims (C-G1)              muted
//   5. "Settled up"                   nothing waits, I'm within 1¢, and the group has costs muted
//   -  "4 people" / "Just you"        otherwise (no costs yet, only all-$0 receipts waiting),
//                                     and until the group's snapshot has loaded
// Money comes only from viewerNet (fully claimed receipts only); this file does no arithmetic on it.

import { initials } from './billView';
import { GROUP_CLAIM_COPY, snapshotBillNeedsViewer } from './groupClaimStatus';
import { GROUP_COPY, groupMath, viewerNet } from './groupView';
import type { GroupSnapshot, GroupSummary } from './groups';
import { footerIncomplete } from './settleView';
import { isSettledUp } from './simplify';

export const GROUPS_HOME_COPY = {
  heading: 'Groups',
  newGroup: 'New group',
  newGroupHint: 'Name a group for a trip or a shared house',
  startGroup: 'Start a group',
  startGroupHint: "Keeps a trip's receipts and costs in one place",
  openHint: 'Opens this group',
  /** C2 rule 1 (C6 homeClaim). */
  claim: GROUP_CLAIM_COPY.homeClaim,
  /** C2 rule 5 (C6 homeSettled). */
  settled: GROUP_CLAIM_COPY.homeSettled,
  /** DisclosureRow's label and its screen-reader form (as Home's "Settled (N)" / "Settled, N bills"). */
  hiddenLabel: (n: number) => `Hidden groups (${n})`,
  hiddenA11y: (n: number) => (n === 1 ? 'Hidden groups, 1 group' : `Hidden groups, ${n} groups`),
  show: 'Show',
  hide: 'Hide',
  showHiddenHint: 'Lists the groups you hid from Home',
  hideHint: 'Folds the list away',
  unhide: 'Unhide',
  unhideA11y: (name: string) => `Unhide ${name}`,
  unhideHint: 'Shows this group on Home again',
  unhideFailed: "Couldn't unhide that group. Try again.",
  loadFailed: "Couldn't load your groups.",
  tryAgain: 'Try again',
  /** The retry's accessible name: Home can also show its bills' "Try again" (GR-HW-1). */
  tryAgainA11y: 'Try loading groups again',
} as const;

/**
 * The "Your groups" screen (app/(app)/groups/index.tsx, route /groups), reached from Home's header
 * icon. Its list reuses GroupsSection (variant "page") and so GROUPS_HOME_COPY for rows, hidden
 * groups and errors; these are only the screen's own words. Decisions GR-GL-* in
 * docs/decisions-to-review.md.
 */
export const GROUPS_PAGE_COPY = {
  title: 'Groups',
  back: 'Home',
  backHint: 'Goes to Home',
  newGroup: GROUPS_HOME_COPY.newGroup,
  newGroupHint: GROUPS_HOME_COPY.newGroupHint,
  empty: 'No groups yet. Start one for a trip or a shared house.',
  loading: 'Loading your groups',
} as const;

/** "Just you" for a group of one (a new group), "1 person" can't happen (you're always in it). */
export function peopleText(n: number): string {
  return n <= 1 ? 'Just you' : `${n} people`;
}

/** The status part of a row's caption, or null when it should fall back to the people count. */
export type GroupHomeStatus = {
  kind: 'claim' | 'owe' | 'owed' | 'waiting' | 'settled';
  text: string;
  /** The caption's color: warning, text, success, or textMuted for 'muted' (T4). */
  tone: 'warning' | 'text' | 'success' | 'muted';
} | null;

/**
 * C2 for `viewerId` (the header comment's cases 1-5). `snapshot.me` is the viewer's own (the
 * snapshot is read as them). Never throws: a snapshot groupMath refuses gives null
 * (fetchGroupSnapshot already refuses those).
 */
export function groupHomeStatus(snapshot: GroupSnapshot, viewerId: string): GroupHomeStatus {
  let math: ReturnType<typeof groupMath>;
  try {
    math = groupMath(snapshot);
  } catch {
    return null;
  }
  const needMe = snapshot.bills.filter((b) => snapshotBillNeedsViewer(snapshot, b, viewerId)).length;
  if (needMe > 0) return { kind: 'claim', text: GROUPS_HOME_COPY.claim(needMe), tone: 'warning' };
  const net = viewerNet(snapshot, viewerId);
  if (!isSettledUp(net)) {
    return net < 0 ? { kind: 'owe', text: GROUP_COPY.owe(-net), tone: 'text' } : { kind: 'owed', text: GROUP_COPY.owed(net), tone: 'success' };
  }
  const incomplete = math.balances.waiting.filter((w) => w.reason === 'incomplete');
  if (incomplete.length > 0) {
    let rows = 0;
    let discountRows = 0;
    for (const w of incomplete) {
      rows += w.unclaimedRows;
      discountRows += w.unclaimedDiscountRows;
    }
    return { kind: 'waiting', text: footerIncomplete(rows, discountRows), tone: 'muted' };
  }
  if (math.balances.waiting.length > 0) return null; // only all-$0 receipts are waiting
  if (snapshot.bills.length === 0 && snapshot.expenses.length === 0) return null;
  return { kind: 'settled', text: GROUPS_HOME_COPY.settled, tone: 'muted' };
}

/** Same shape as components/Avatars' AvatarPerson (lib can't import components). */
export type GroupAvatar = { userId: string; name: string; initials: string; isMe: boolean };

/** Avatars a row shows before "+N". */
export const GROUP_ROW_AVATARS = 3;

/**
 * The other members, in the snapshot's order (joined first). The viewer is left out: on your own
 * Home your face says nothing. A group of just you shows none (the caption says "Just you").
 */
export function groupAvatars(snapshot: GroupSnapshot, viewerId: string): GroupAvatar[] {
  return snapshot.members
    .filter((m) => m.userId !== viewerId)
    .map((m) => {
      const name = m.displayName?.trim() ? m.displayName.trim() : 'A friend';
      return { userId: m.userId, name, initials: initials(m.displayName), isMe: false };
    });
}

export type GroupHomeRow = {
  id: string;
  title: string;
  caption: string;
  status: GroupHomeStatus;
  avatars: GroupAvatar[];
  /** Everything the row shows that matters, in reading order. */
  a11yLabel: string;
};

/**
 * One visible group's row. `snapshot` is that group's group_snapshot, or null while it loads, when
 * it failed, or when Home didn't fetch it (past GROUPS_HOME_DETAIL_LIMIT). A snapshot of another
 * group is ignored.
 */
export function groupHomeRow(summary: GroupSummary, snapshot: GroupSnapshot | null, viewerId: string): GroupHomeRow {
  const detail = snapshot !== null && snapshot.group.id === summary.id ? snapshot : null;
  const people = peopleText(detail?.members.length ?? summary.memberCount);
  const status = detail === null ? null : groupHomeStatus(detail, viewerId);
  const avatars = detail === null ? [] : groupAvatars(detail, viewerId);
  return {
    id: summary.id,
    // The snapshot is newer than my_groups() when both landed (a rename on the group screen).
    title: detail?.group.name ?? summary.name,
    caption: status?.text ?? people,
    status,
    avatars,
    a11yLabel: [detail?.group.name ?? summary.name, people, ...(status ? [status.text] : [])].join(', '),
  };
}

/** A hidden group's row: name and people count only (no snapshot is read for hidden groups). */
export function hiddenGroupRow(summary: GroupSummary): { id: string; title: string; caption: string } {
  return { id: summary.id, title: summary.name, caption: peopleText(summary.memberCount) };
}

/**
 * Home reads one group_snapshot per visible group for the avatars and status, at most this many
 * (the newest joined). The rest show the people count. Starting value; a my_groups() column with
 * the status would replace these reads (docs/before-production.md, GR-T13-2).
 */
export const GROUPS_HOME_DETAIL_LIMIT = 10;

export function splitGroups(groups: readonly GroupSummary[]): { visible: GroupSummary[]; hidden: GroupSummary[] } {
  return { visible: groups.filter((g) => !g.hidden), hidden: groups.filter((g) => g.hidden) };
}

/** The ids whose snapshots Home reads: the first GROUPS_HOME_DETAIL_LIMIT visible groups. */
export function detailIds(groups: readonly GroupSummary[]): string[] {
  return splitGroups(groups).visible.slice(0, GROUPS_HOME_DETAIL_LIMIT).map((g) => g.id);
}

/** After a successful Unhide: the same list with that group visible (the refetch confirms it). */
export function withUnhidden(groups: readonly GroupSummary[], id: string): GroupSummary[] {
  return groups.map((g) => (g.id === id ? { ...g, hidden: false } : g));
}
