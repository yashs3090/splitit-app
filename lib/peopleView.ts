// Copy and rows for the People card (Profile) and the Add people screen. Pure.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6; Tasks 6 and 7).
//
// Who is linked (L1) and the order (L2) come from the database; who can be removed (L3) from
// lib/membership.ts. This file only words what the screens show.
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
} as const;

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
  /** Everything the row shows: "Sam Lee, no items yet". */
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
    return {
      userId: p.userId,
      name,
      noItems,
      removable: canRemove(data, viewerId, p.userId),
      a11yLabel: noItems ? `${name}, no items yet` : name,
    };
  });
}
