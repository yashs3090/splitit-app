// When a group bill "needs me" (C1), and the copy for it (C6):
// docs/specs/2026-11-27-group-claim-status.md (T2).
//
// The rule is written once, in billNeedsViewer. Home and the group screen reach it through
// rowsOfSnapshotBill (or snapshotBillNeedsViewer, which also reads the opt-out from the snapshot);
// the bill screen through rowsOfBillData, given the claims it displays (so a tap on Claim clears
// the reminder before the save lands). Nothing here touches money: "I wasn't part of this" only
// hides a reminder and never changes a share (U-G3).
//
// Type-only imports from ./groups and ./bills: lib/groups.ts imports GROUP_CLAIM_COPY from here
// for its error copy, so a value import back would be a cycle.
import type { BillClaim, BillRow } from './bills';
import type { GroupSnapshot, SnapshotBill } from './groups';

/** One row (an item or a discount row) as C1 sees it: who has a claim on it. */
export type ClaimRowLike = { claimerIds: readonly string[] };

/**
 * C1: the bill needs `viewerId` when (a) some row has no claimer, (b) the viewer has no claim on
 * any row, and (c) the viewer hasn't said "I wasn't part of this" (`notPart`). Claims win: with a
 * claim, a stale opt-out doesn't matter. A bill with no rows needs nobody.
 */
export function billNeedsViewer(rows: readonly ClaimRowLike[], viewerId: string, notPart: boolean): boolean {
  if (rows.some((r) => r.claimerIds.includes(viewerId))) return false;
  if (notPart) return false;
  return rows.some((r) => r.claimerIds.length === 0);
}

/** A snapshot bill's rows, in order, with the ids that hold a claim on each. */
export function rowsOfSnapshotBill(bill: Pick<SnapshotBill, 'rows'>): ClaimRowLike[] {
  return bill.rows.map((r) => ({ claimerIds: Object.keys(r.claims) }));
}

/**
 * A bill's rows, in order, with the ids that hold a claim on each. `claims` may be the server's
 * or the displayed (optimistic) ones. A claim on a row that isn't in `rows` is ignored.
 */
export function rowsOfBillData(data: {
  rows: readonly Pick<BillRow, 'id'>[];
  claims: readonly Pick<BillClaim, 'line_item_id' | 'user_id'>[];
}): ClaimRowLike[] {
  const byRow = new Map<string, string[]>(data.rows.map((r) => [r.id, []]));
  for (const c of data.claims) {
    const claimers = byRow.get(c.line_item_id);
    if (claimers && !claimers.includes(c.user_id)) claimers.push(c.user_id);
  }
  return data.rows.map((r) => ({ claimerIds: byRow.get(r.id) ?? [] }));
}

/** C1 for one bill of a snapshot, with the viewer's opt-out read from `me.notPartBillIds`. */
export function snapshotBillNeedsViewer(snapshot: Pick<GroupSnapshot, 'me'>, bill: SnapshotBill, viewerId: string): boolean {
  return billNeedsViewer(rowsOfSnapshotBill(bill), viewerId, snapshot.me.notPartBillIds.includes(bill.id));
}

/** C6: every string for "needs you" and "I wasn't part of this". One definition each. */
export const GROUP_CLAIM_COPY = {
  /** Home's group row, rule 1 of C2. */
  homeClaim: (n: number): string => (n === 1 ? 'Claim your items on 1 bill' : `Claim your items on ${n} bills`),
  /** Home's group row, rule 5 of C2 (replaces GROUPS_HOME_COPY.settled). */
  homeSettled: 'Settled up',
  /** Caption of a group screen waiting row that needs me. */
  needsYou: "You haven't claimed anything here yet",
  /** Appended to a cost row's caption: "Ana paid $77.33 · Claim your items". */
  costNeedsYou: 'Claim your items',
  notPart: "I wasn't part of this",
  notPartHint: "Stops reminding you about this receipt. It doesn't change anyone's share.",
  /** Caption of a group screen waiting row I've opted out of. */
  notPartDone: "You weren't part of this",
  /** The bill screen's line once I've opted out. */
  notPartDoneBill: "You said you weren't part of this.",
  /** The bill screen's line, before the link. */
  notPartPrompt: 'Nothing here was yours?',
  undo: 'Undo',
  undoA11y: 'Undo, I was part of this',
  undoHint: 'Reminds you to claim your items on this receipt again',
  /** set_not_part 22023 has_claims (also GROUP_ERROR_COPY.has_claims). */
  hasClaims: "You've claimed something on this receipt, so you're part of it.",
  /** set_not_part 22023 not_in_group (also GROUP_ERROR_COPY.not_in_group). */
  notInGroup: "This receipt isn't in a group anymore.",
} as const;
