// The viewer's own "No, undo" of a Venmo send (docs/specs/2026-11-26-sent-via-venmo.md D3; review R8).
//
// The undo runs in lib/sentCheckUndo, sometimes outside the Settle page (the notification responder).
// When the page then sees the mark vanish, it must not say "Your 'I paid' was undone. Check Activity
// to see who." (that banner is for someone else's undo). runSentCheckUndo notes the undo here just
// before unmarkPaid, and announces it once it landed so an open Settle page can refetch.
//
// In memory only, keyed by bill and user, and short-lived (OWN_UNDO_MAX_MS), so a stale entry can't
// hide a later undo by someone else for long. Nothing here is per-user state that outlives the app.

/** How long a noted undo counts as ours. Starting value: long enough for a slow refetch to land. */
export const OWN_UNDO_MAX_MS = 2 * 60 * 1000;

type Listener = (billId: string, userId: string) => void;

const noted = new Map<string, number>();
const listeners = new Set<Listener>();

const keyOf = (billId: string, userId: string) => `${billId}|${userId}`;

/** Just before unmarkPaid: the next mark-gone on this bill for this user is ours. */
export function noteOwnUndo(billId: string, userId: string, now: number = Date.now()): void {
  noted.set(keyOf(billId, userId), now);
}

/** unmarkPaid failed: the mark stays, so nothing was ours. */
export function forgetOwnUndo(billId: string, userId: string): void {
  noted.delete(keyOf(billId, userId));
}

/** The screen saw this user's mark vanish: true (once) if it was this device's own undo. */
export function takeOwnUndo(billId: string, userId: string, now: number = Date.now()): boolean {
  const k = keyOf(billId, userId);
  const at = noted.get(k);
  if (at === undefined) return false;
  noted.delete(k);
  return now - at <= OWN_UNDO_MAX_MS;
}

/** The undo landed: an open screen for this bill refetches. Never throws. */
export function ownUndoLanded(billId: string, userId: string): void {
  for (const l of [...listeners]) {
    try {
      l(billId, userId);
    } catch {
      // One screen's handler failing doesn't stop the others.
    }
  }
}

export function subscribeOwnUndo(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetOwnUndosForTests(): void {
  noted.clear();
  listeners.clear();
}
