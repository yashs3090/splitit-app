// Copy and small text helpers for the group screen and group Activity (spec
// docs/specs/2026-11-26-groups-mvp.md T14, as amended by A1 S9/S15 and decision GR-M7). Pure.
//
// The money and statuses come from lib/groupView.ts (groupScreen); this file only names things and
// joins strings lib already made, so the screens build no strings of their own.

import { timeLabel, timeLabelText, type TimeFormatters } from './activityText';
import type { NameOf } from './billView';
import { GROUP_CLAIM_COPY } from './groupClaimStatus';
import type { CostRow, DeleteCheck, StatusLine, WaitingLine } from './groupView';
import { GROUP_ERROR_COPY, type GroupError, type GroupEvent, type GroupSnapshot, type SnapshotMember } from './groups';
import { normalizeTitle } from './groupExpense';
import { peopleText } from './homeSections';

/** GR-M7: a member who has left isn't in the snapshot, so Activity calls them this. */
export const FORMER_MEMBER = 'A former member';

export const GROUP_SCREEN_COPY = {
  back: 'Home',
  backHint: 'Returns to your bills',
  loadError: "Couldn't load the group.",
  notMember: "You're not in this group. Ask someone in it for the group's link.",
  goHome: 'Go home',
  tryAgain: 'Try again',
  refreshFailed: "Couldn't refresh. Try again.",
  settleUp: 'Settle up',
  settleUpHint: 'Shows who pays whom',
  waitingHeader: 'Not in balances yet',
  waitingHint: 'Opens the receipt so people can claim what they had',
  costs: 'Costs',
  add: 'Add',
  addA11y: 'Add a cost',
  addHintClosed: 'Shows the kinds of cost you can add',
  addHintOpen: 'Hides the kinds of cost',
  expenseChoice: 'Expense',
  expenseChoiceCaption: 'Airbnb, gas, tickets: one amount split between people',
  expenseChoiceA11y: 'Expense: Airbnb, gas, tickets: one amount split between people',
  expenseChoiceHint: 'Opens a new expense',
  // T17 (A1 S15) turns this choice on.
  receiptChoice: 'Receipt',
  receiptChoiceCaption: 'Scan or type a receipt; everyone claims what they had',
  receiptChoiceA11y: 'Receipt: Scan or type a receipt; everyone claims what they had',
  receiptChoiceHint: 'Opens Scan. The new bill goes in this group.',
  noCosts: 'No costs yet. Add the first one, like the Airbnb or gas.',
  billHint: 'Opens the receipt',
  expenseHint: 'Opens the expense to edit it',
  activity: 'Activity',
  activityHint: 'Shows what changed in the group',
  options: 'Group options',
  optionsHintClosed: 'Shows invite, rename, hide and leave',
  optionsHintOpen: 'Hides the group options',
  invite: 'Invite people',
  inviteHint: 'Shows the group link, QR code and share options',
  inviteClose: 'Close invite',
  rename: 'Rename group',
  renameField: 'Group name',
  save: 'Save name',
  cancel: 'Cancel',
  hide: 'Hide for me',
  hideHint: 'Hides this group from your Home. Nobody else is told.',
  hidden: 'Hidden from your Home. Others still see it.',
  unhide: 'Unhide',
  unhideHint: 'Shows this group on your Home again',
  leave: 'Leave group',
  leaveHint: 'Asks first',
  leaveConfirmButton: 'Leave',
} as const;

export const GROUP_ACTIVITY_COPY = {
  title: 'Activity',
  back: 'Group',
  backA11y: 'Back to group',
  loadError: "Couldn't load the activity.",
  empty: 'Nothing yet. Costs, payments and people joining will show up here.',
} as const;

/** "Leave Tahoe trip? You'll need the group's link to come back." */
export function leaveConfirmText(groupName: string): string {
  return `Leave ${groupName}? You'll need the group's link to come back.`;
}

/** "4 people", "Just you". */
export function memberCountText(count: number): string {
  return peopleText(count);
}

/**
 * Names for the group screens: "You", the member's display name, "A friend" when it's unset, the
 * GR-M7 "A former member" for someone no longer in the group, and "Someone" for a deleted account.
 */
export function groupNameOf(members: readonly SnapshotMember[], viewerId: string): NameOf {
  const names = new Map(members.map((m) => [m.userId, m.displayName?.trim() || null]));
  return (userId) => {
    if (userId === null) return 'Someone';
    if (userId === viewerId) return 'You';
    if (!names.has(userId)) return FORMER_MEMBER;
    return names.get(userId) ?? 'A friend';
  };
}

/** The status line split for the screen: a small lead and the big amount. Its words equal `status.text`. */
export function statusParts(status: StatusLine): { lead: string; amountCents: number | null } {
  switch (status.kind) {
    case 'owes':
      return { lead: 'You owe', amountCents: status.amountCents };
    case 'owed':
      return { lead: "You're owed", amountCents: status.amountCents };
    case 'settled':
      return { lead: status.text, amountCents: null };
  }
}

/**
 * A cost row's caption: who paid, plus "Claim your items" when the receipt waits on me (group claim
 * status C6): "Ana paid $77.33 · Claim your items".
 */
export function costRowCaption(row: CostRow): string {
  return row.needsMe ? `${row.paidLine} · ${GROUP_CLAIM_COPY.costNeedsYou}` : row.paidLine;
}

/**
 * A cost row's screen-reader label, in reading order: "Ana's receipt, Ana paid $77.33, Your share
 * $30.08". A receipt that waits on me says so after who paid, where the caption shows it:
 * "Ana's receipt, Ana paid $77.33, Claim your items, Your share isn't counted until…".
 */
export function costRowA11yLabel(row: CostRow): string {
  const claim = row.needsMe ? `, ${GROUP_CLAIM_COPY.costNeedsYou}` : '';
  return `${row.title}, ${row.paidLine}${claim}, ${row.shareA11y}`;
}

/** A waiting line's caption: "You haven't claimed anything here yet", "You weren't part of this", or none. */
export function waitingCaption(line: WaitingLine): string | null {
  if (line.needsMe) return GROUP_CLAIM_COPY.needsYou;
  if (line.notPart) return GROUP_CLAIM_COPY.notPartDone;
  return null;
}

/**
 * A waiting line's screen-reader label: the full notice ("Balances don't include Ana's receipt yet:
 * Nachos left to claim"), then the caption when there is one, so the label says what the row shows.
 */
export function waitingA11yLabel(line: WaitingLine): string {
  const caption = waitingCaption(line);
  return caption === null ? line.notice : `${line.notice}. ${caption}`;
}

/** Whether a rename would change anything (the DB trims the same way and no-ops the same name). */
export function renameChanges(current: string, typed: string): boolean {
  return normalizeTitle(typed) !== normalizeTitle(current);
}

export type GroupEventSection = { title: string; events: GroupEvent[] };

/**
 * Time sections for group Activity, keeping the given order (newest `seq` first, A1 N2: events of
 * one call share a `created_at`, so sorting by time would shuffle them). Consecutive events with
 * the same label ("Just now", "7:42 PM", "Yesterday", "Nov 18") share a section.
 */
export function groupEventSections(events: readonly GroupEvent[], now: Date, fmt: TimeFormatters): GroupEventSection[] {
  const out: GroupEventSection[] = [];
  for (const e of events) {
    const title = timeLabelText(timeLabel(e.createdAt, now, fmt));
    const last = out[out.length - 1];
    if (last && last.title === title) last.events.push(e);
    else out.push({ title, events: [e] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Delete group (docs/specs/2026-11-28-delete-group.md copy table, as amended by A2.8 / A2.9). The
// group screen, its dialog, the deleted state and Home's notice read these; they build no strings.

export const DELETE_GROUP_COPY = {
  /** C1: the options card's last row, in the danger colour. */
  row: 'Delete group',
  /** C1a: the enabled row's hint (as Leave). */
  rowHint: GROUP_SCREEN_COPY.leaveHint,
  /** C2a (also C7 and GROUP_ERROR_COPY.receipts_waiting, C12: one definition). */
  waitingCaption: GROUP_ERROR_COPY.receipts_waiting,
  /** C2b. */
  notSettledCaption: 'Everyone has to be settled up before you can delete this group.',
  /** C4: the dialog's danger button. */
  confirm: 'Delete group',
  /** C4: the dialog's ghost button. */
  cancel: 'Cancel',
  /** C5: under the dialog's buttons after a network failure or time-out; the dialog stays open. */
  networkError: "Couldn't delete the group. Check your connection and try again.",
  /** C6 (= GROUP_ERROR_COPY.group_changed, C11): under the options card; the dialog closes. */
  changed: GROUP_ERROR_COPY.group_changed,
  /** C7: the same after receipts_waiting. */
  receiptsWaiting: GROUP_ERROR_COPY.receipts_waiting,
  /** C8: the group screen and sub-screens once the group is gone. */
  deletedHeading: 'This group was deleted',
  goHome: GROUP_SCREEN_COPY.goHome,
  /** C9: Home's one-shot notice after your own delete. */
  dismiss: 'Dismiss',
  dismissHint: 'Hides this message',
} as const;

/** C3: `Delete "Tahoe trip" for everyone?`. The name is the snapshot's (member-set group data), never URL text. */
export function deleteConfirmTitle(groupName: string): string {
  return `Delete "${groupName}" for everyone?`;
}

/** C9: `"Tahoe trip" was deleted.` */
export function deletedNoticeText(groupName: string): string {
  return `"${groupName}" was deleted.`;
}

const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
function joinParts(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/**
 * C3b as amended by A2.8: "Its 3 expenses, 2 receipts and payment history will be removed for all
 * 4 members. This can't be undone." Parts that are empty are left out ("Its 1 expense will be
 * removed for both members."); with none it reads "It will be removed for you." Who: 1 member →
 * "you", 2 → "both members", n ≥ 3 → "all n members". Counts are the snapshot's rows: live
 * expenses, the group's receipts, and "payment history" when any payment row exists. Undone payments
 * are deleted too (review R3), so a "Not received" row (`notReceived`) counts as well. The snapshot
 * carries only the undone payments GR-M6 shows, so an older undone one it doesn't carry can't count.
 */
export function deleteConfirmText(snapshot: GroupSnapshot): string {
  const n = snapshot.members.length;
  const who = n <= 1 ? 'you' : n === 2 ? 'both members' : `all ${n} members`;
  const parts: string[] = [];
  if (snapshot.expenses.length > 0) parts.push(countOf(snapshot.expenses.length, 'expense', 'expenses'));
  if (snapshot.bills.length > 0) parts.push(countOf(snapshot.bills.length, 'receipt', 'receipts'));
  if (snapshot.payments.length > 0 || snapshot.notReceived.length > 0) parts.push('payment history');
  const lead = parts.length === 0 ? 'It' : `Its ${joinParts(parts)}`;
  return `${lead} will be removed for ${who}. This can't be undone.`;
}

export type DeleteRowText = {
  label: string;
  /** The enabled row's hint; null when disabled. */
  hint: string | null;
  /** The disabled row's visible reason (C2a / C2b); null when enabled. */
  caption: string | null;
  /** C2c when disabled: "Delete group, unavailable. " + the caption. */
  a11yLabel: string;
  disabled: boolean;
};

/** The Delete row's text from groupScreen(...).canDelete. */
export function deleteRowText(check: DeleteCheck): DeleteRowText {
  const label = DELETE_GROUP_COPY.row;
  if (check.ok) return { label, hint: DELETE_GROUP_COPY.rowHint, caption: null, a11yLabel: label, disabled: false };
  const caption = check.reason === 'receipts_waiting' ? DELETE_GROUP_COPY.waitingCaption : DELETE_GROUP_COPY.notSettledCaption;
  return { label, hint: null, caption, a11yLabel: `${label}, unavailable. ${caption}`, disabled: true };
}

/**
 * What a refused deleteGroup means for the screen (criteria 44, 45 as amended by A2.11; A3):
 * - `close`: the dialog closes, `text` shows under the options card, and the screen refetches
 *   (group_changed → C6, receipts_waiting → C7);
 * - `gone`: the group no longer exists (a retry after a delete that went through, or someone else
 *   deleted it; A2.9 / A2.11): the dialog closes and the screen shows C8, with no error line;
 * - `stay`: the dialog stays open with `text` under its buttons and Delete enabled again (busy →
 *   GROUP_ERROR_COPY.busy; network, a time-out or anything unexpected → C5). A retry is safe: the
 *   database re-checks everything.
 */
export type DeleteRefusal = { kind: 'close'; text: string } | { kind: 'gone' } | { kind: 'stay'; text: string };

export function deleteRefusal(error: GroupError): DeleteRefusal {
  switch (error) {
    case 'group_changed':
      return { kind: 'close', text: DELETE_GROUP_COPY.changed };
    case 'receipts_waiting':
      return { kind: 'close', text: DELETE_GROUP_COPY.receiptsWaiting };
    case 'not_allowed':
      return { kind: 'gone' };
    case 'busy':
      return { kind: 'stay', text: GROUP_ERROR_COPY.busy };
    default:
      return { kind: 'stay', text: DELETE_GROUP_COPY.networkError };
  }
}
