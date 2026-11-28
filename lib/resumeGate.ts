// Resume gate (docs/specs/2026-11-26-sent-via-venmo.md § D3, A1 F10).
//
// Only the single sign-in resume effect navigates after sign-in (lesson 2026-11-19). The
// notification responder (components/SentCheckResponder.tsx, Task 9b) must not route a cold-start
// notification response while that resume is deciding where to go. `ResumeAfterSignIn` in
// app/_layout.tsx calls `settleResume(kind)` once it knows (the 3-line edit requested from the
// scan-pipeline session; Task 9b wires it). The responder awaits `whenResumed()` and acts on a
// cold-start response only when the kind is 'none'.
//
// Never hangs: `whenResumed` gives up after a time limit with 'timed_out', which the responder
// treats like 'signed_in' (drop the cold-start response; the inline question covers it). This also
// makes the spec's fallback (the layout never calls settleResume) safe by construction.
//
// One gate per app launch (module state), like the cold-start response itself.

export type ResumeKind = 'none' | 'signed_in';
export type ResumeWait = ResumeKind | 'timed_out';

/** Starting value: how long the responder waits for the sign-in resume before giving up. */
export const RESUME_GATE_TIMEOUT_MS = 5000;

let settled: ResumeKind | null = null;
let waiters: Array<(kind: ResumeKind) => void> = [];

/**
 * Called once by the sign-in resume when it has finished (or found nothing to resume). The first
 * call wins. An unexpected value counts as 'signed_in', the side that drops the cold-start response.
 * Never throws.
 */
export function settleResume(kind: ResumeKind): void {
  if (settled !== null) return;
  settled = kind === 'none' ? 'none' : 'signed_in';
  const pending = waiters;
  waiters = [];
  for (const wake of pending) {
    try {
      wake(settled);
    } catch {
      // A waiter's resolve can't throw; kept so one bad waiter could never block the rest.
    }
  }
}

/** The settled kind, or null if the resume hasn't settled yet. */
export function resumeKindNow(): ResumeKind | null {
  return settled;
}

/**
 * Resolves with the resume's kind: at once if it has settled, else when it does, else
 * 'timed_out' after `timeoutMs` (a non-finite or negative value uses the default). Never rejects.
 */
export function whenResumed(timeoutMs: number = RESUME_GATE_TIMEOUT_MS): Promise<ResumeWait> {
  if (settled !== null) return Promise.resolve(settled);
  const limit = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : RESUME_GATE_TIMEOUT_MS;
  return new Promise<ResumeWait>((resolve) => {
    let done = false;
    const wake = (kind: ResumeKind) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(kind);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      waiters = waiters.filter((w) => w !== wake);
      resolve('timed_out');
    }, limit);
    waiters.push(wake);
  });
}

/** Tests only: back to "not settled", with no waiters. */
export function resetResumeGateForTests(): void {
  settled = null;
  waiters = [];
}
