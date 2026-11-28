// What the bill screen of a group bill shows for "I wasn't part of this" (spec
// docs/specs/2026-11-27-group-claim-status.md T6, C1, C5): whether still-unclaimed rows get the
// warningSurface tint, and which line (if any) goes under the items.
//
// - The line follows the **server** data: it shows while the bill needs me by C1's (a) and (b)
//   (some row has no claimer, I have no claim), the not-part read is ready, and the bill is a group
//   bill. It reads the prompt, or "You said you weren't part of this." once I've opted out.
// - The tint is per row and follows the **displayed** claimers (the screen decides which rows are
//   unclaimed, so a tap on Claim clears it before the save lands). Here only: is the tint on at all.
//   Off while the read is loading (no flash), on if it failed (fail toward reminding, GCS-10), off
//   once I've opted out, and back on when a claim of mine makes a stale opt-out moot (claims win).
// Nothing here touches money.
import { billNeedsViewer, type ClaimRowLike } from './groupClaimStatus';
import type { GroupError } from './groups';

/** lib/useNotPart's read of my bill_not_part row for this bill. */
export type NotPartRead = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; notPart: boolean };

export type NotPartView = {
  /** Unclaimed rows (as displayed) get the warningSurface tint. */
  tintUnclaimed: boolean;
  /** The line under the items: the prompt, the opted-out line, or none. */
  line: 'prompt' | 'done' | null;
};

/** A failed not-part write's error, with the line that was showing when the person tapped. */
export type NotPartError = { error: GroupError; under: NotPartView['line'] };

/**
 * Review R1: an error's words are about the moment it was raised, so it lasts only while that line
 * does. One step is expected: has_claims is answered by a refetch that shows my claim, which hides
 * the line, and the words then explain why; it follows to "no line" once. Any other change of line
 * (I unclaimed, so the prompt is back; I claimed after a network error, so there's nothing to
 * retry) clears it.
 */
export function nextNotPartError(e: NotPartError | null, line: NotPartView['line']): NotPartError | null {
  if (e === null || e.under === line) return e;
  if (e.error === 'has_claims' && line === null) return { ...e, under: null };
  return null;
}

/** The viewer holds a claim on at least one of the rows. */
export function hasClaimOn(rows: readonly ClaimRowLike[], viewerId: string): boolean {
  return rows.some((r) => r.claimerIds.includes(viewerId));
}

export function notPartView(input: {
  inGroup: boolean;
  read: NotPartRead;
  /** The server's rows (rowsOfBillData of the loaded data), never the optimistic ones. */
  serverRows: readonly ClaimRowLike[];
  viewerId: string;
}): NotPartView {
  const { inGroup, read, serverRows, viewerId } = input;
  if (!inGroup || read.status === 'loading') return { tintUnclaimed: false, line: null };
  const claimed = hasClaimOn(serverRows, viewerId);
  if (read.status === 'failed') return { tintUnclaimed: true, line: null };
  // Claims win: with a claim, an opt-out (stale until the reset lands) doesn't hide the tint.
  const optedOut = read.notPart && !claimed;
  const needsMe = billNeedsViewer(serverRows, viewerId, false);
  return { tintUnclaimed: !optedOut, line: needsMe ? (optedOut ? 'done' : 'prompt') : null };
}
