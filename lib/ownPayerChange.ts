// The host's own change of who paid, made on the "Who paid?" page (app/(app)/bills/[id]/payers.tsx).
//
// The Settle page stays mounted under that page. When it then sees the payer change, it must not
// show "Sam is now collecting for this bill" to the host who just made the change (noticeFor's
// `iChangedPayer`), and it should refetch at once instead of waiting for the live channel.
// Same shape as lib/ownUndo: in memory only, keyed by bill, short-lived.

export const OWN_PAYER_CHANGE_MAX_MS = 2 * 60 * 1000;

type Listener = (billId: string) => void;

const noted = new Map<string, number>();
const listeners = new Set<Listener>();

/** Just before set_payer / set_payers: the next payer change on this bill is ours. */
export function noteOwnPayerChange(billId: string, now: number = Date.now()): void {
  noted.set(billId, now);
}

/** The write failed: nothing changed, so nothing was ours. */
export function forgetOwnPayerChange(billId: string): void {
  noted.delete(billId);
}

/** The screen saw the payer change: true (once) if it was this device's own change. */
export function takeOwnPayerChange(billId: string, now: number = Date.now()): boolean {
  const at = noted.get(billId);
  if (at === undefined) return false;
  noted.delete(billId);
  return now - at <= OWN_PAYER_CHANGE_MAX_MS;
}

/** The change landed: an open screen for this bill refetches. Never throws. */
export function announceOwnPayerChange(billId: string): void {
  for (const l of [...listeners]) {
    try {
      l(billId);
    } catch {
      // A listener's failure must not stop the others.
    }
  }
}

export function subscribeOwnPayerChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
