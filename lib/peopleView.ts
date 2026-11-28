// Copy and rows for the People card (Profile) and the Add people screen. Pure.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6; Tasks 6 and 7).
//
// Who is linked (L1) and the order (L2) come from the database; who can be removed (L3) from
// lib/membership.ts. This file only words what the screens show. Who paid S12
// (docs/specs/2026-11-26-who-paid.md A1.5): a payer can't be removed or leave (L3), and the reason
// shows before any tap, in place of the button.
import type { NameOf } from './billView';
import type { BillData } from './bills';
import { canRemove } from './membership';

export const PEOPLE_COPY = {
  cardTitle: "People you've split with",
  loading: 'Loading people',
  loadError: "Couldn't load people.",
  tryAgain: 'Try again',
  searchLabel: 'Search people',
  emptyProfile: 'People you split bills with will show up here.',
  emptyAdd: 'People you split bills with will show up here. To invite someone new, go back and share the link.',
  everyoneOn: "Everyone you've split with is on this bill.",
  addPeople: 'Add people',
  addPeopleHint: "Add someone you've split a bill with",
  onThisBill: 'On this bill',
  noItems: 'No items yet',
  backToBill: 'Back to the bill',
  refreshFailed: "Couldn't refresh the bill.",
  leave: 'Leave this bill',
  leaveHint: 'Asks before taking you off this bill',
  leaveConfirm: "Leave this bill? You'll stop seeing it. You can rejoin with the link.",
  changeWhoPaid: 'Change who paid',
  changeWhoPaidHint: 'Opens Who paid, where you can change it',
} as const;

/** S12: the label of a payer row's "Change who paid", so two of them on one screen read apart. */
export function changeWhoPaidLabel(name: string): string {
  return `Change who paid before removing ${name}`;
}

/** The people rule L3 counts as payers: bills.payer_id and every bill_payers row. */
function payerIdsOf(data: BillData): Set<string> {
  return new Set([data.bill.payer_id, ...data.payers.map((p) => p.userId)]);
}

/** Several people paid (bill_payers rows), so each paid part of the bill. */
function splitPaying(data: BillData): boolean {
  return data.payers.length > 0;
}

/**
 * S12, the host's view: why `targetId` has no Remove, when it's because they paid. Null for the
 * host (never removable) and anyone who didn't pay. "Sam paid part of the bill. Change who paid first."
 */
function removeBlockedText(data: BillData, viewerId: string, targetId: string, name: string): string | null {
  const hostId = data.bill.host_id;
  if (viewerId !== hostId || targetId === hostId || !payerIdsOf(data).has(targetId)) return null;
  return splitPaying(data) ? `${name} paid part of the bill. Change who paid first.` : `${name} paid the bill. Change who paid first.`;
}

/**
 * S12, the guest's view: why "Leave this bill" is missing, when it's because they paid; else null
 * (the host never sees Leave). "You're one of the people who paid. Ask Hana to change who paid
 * before you leave."
 */
export function leaveBlockedText(data: BillData, viewerId: string): string | null {
  const hostId = data.bill.host_id;
  if (viewerId === hostId || !data.participants.some((p) => p.userId === viewerId) || !payerIdsOf(data).has(viewerId)) return null;
  const hostName = data.participants.find((p) => p.userId === hostId)?.displayName?.trim() || 'the host';
  const lead = splitPaying(data) ? "You're one of the people who paid." : 'You paid the bill.';
  return `${lead} Ask ${hostName} to change who paid before you leave.`;
}

/** PI-9 (starting value): the search field shows only with more than this many people. */
export const SEARCH_THRESHOLD = 5;
const MAX_QUERY_CHARS = 50;

export function showSearch(count: number): boolean {
  return count > SEARCH_THRESHOLD;
}

/** `No one matches "sam".` The query as search reads it: trimmed and cut to 50 characters (L4). */
export function noMatchesText(query: string): string {
  const shown = Array.from(query.trim()).slice(0, MAX_QUERY_CHARS).join('');
  return `No one matches "${shown}".`;
}

/** "Only Hana can add people." The host is never the viewer here (the host sees the screen itself). */
export function onlyHostText(hostDisplayName: string | null): string {
  const name = hostDisplayName?.trim() ?? '';
  return name === '' ? 'Only the host can add people.' : `Only ${name} can add people.`;
}

/** Announced after an add lands. The name is never "You": your own id is never in your list (P7). */
export function addedText(name: string): string {
  return `${name} added`;
}

/** Announced after a remove lands. The host can't be removed, so the name is never "You". */
export function removedText(name: string): string {
  return `${name} removed`;
}

export type OnBillRow = {
  userId: string;
  /** "You" for the viewer, else the display name or "A friend". */
  name: string;
  /** No claims on this bill yet (D5: the host can chase them in person). */
  noItems: boolean;
  /** "Remove" shows (canRemove, rule L3). */
  removable: boolean;
  /** S12: shown in place of Remove when they paid, with "Change who paid". Null otherwise. */
  payerNote: string | null;
  /** Everything the row shows: "Sam Lee, no items yet", then the payer note if any. */
  a11yLabel: string;
};

/** "On this bill": the viewer first, then everyone else in join order. */
export function onThisBillRows(data: BillData, viewerId: string, nameOf: NameOf): OnBillRow[] {
  const claimers = new Set(data.claims.map((c) => c.user_id));
  const me = data.participants.filter((p) => p.userId === viewerId);
  const others = data.participants.filter((p) => p.userId !== viewerId);
  return [...me, ...others].map((p) => {
    const name = nameOf(p.userId);
    const noItems = !claimers.has(p.userId);
    const payerNote = removeBlockedText(data, viewerId, p.userId, name);
    const label = noItems ? `${name}, no items yet` : name;
    return {
      userId: p.userId,
      name,
      noItems,
      removable: canRemove(data, viewerId, p.userId),
      payerNote,
      a11yLabel: payerNote === null ? label : `${label}. ${payerNote}`,
    };
  });
}
