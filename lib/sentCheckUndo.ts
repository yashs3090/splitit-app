// "No, undo" for a send via Venmo (docs/specs/2026-11-26-sent-via-venmo.md D3, A1 F6): re-read, then
// the undo rule. Shared by the bill screen's footer and the notification responder
// (components/SentCheckResponder.tsx), so both follow the same steps. The Settle page (Task 9a) runs
// the same steps inline.
//
// First match wins (undoDecision in lib/sentCheck.ts):
// - stored answer 'undo'  → noop (the bill isn't even re-read)
// - the mark is gone      → store 'undo', cancel the check-in, nothing shown ('silent')
// - it's the mark asked about → unmarkPaid(me), then store 'undo' and cancel ('unmarked')
// "The mark" is the pair's own (userId → payerId), read from bill_payments with contract P
// (pairMarkOf), never `participants[me].mark`, which only points at the lead (A-43b, review R2).
// - anything else         → store 'undo', cancel, the "changed" text ('changed')
// A failed re-read or unmarkPaid stores nothing and keeps the check-in, so the question stays.
// An unmark is noted in lib/ownUndo first, so the Settle page knows the undo was the viewer's own.
import { BILL_ERROR_COPY, fetchBill as realFetchBill, isUuid, unmarkPaid as realUnmarkPaid, type BillData, type BillResult } from './bills';
import { makeNameOf } from './billView';
import { cancelSentCheck as realCancelSentCheck } from './checkInNotifications';
import type { KeyValueStorage } from './chunkedStorage';
import { forgetOwnUndo, noteOwnUndo, ownUndoLanded } from './ownUndo';
import {
  answerFor,
  readSentCheckBlob,
  sentCheckKey,
  sentCheckNotificationId,
  storeSentCheckAnswer,
  undoDecision,
  type SentCheckMark,
} from './sentCheck';
import { SETTLE_COPY, sentCheckChangedText } from './settleView';
import { storage as realStorage } from './storage';
import { pairState } from './transfers';

/**
 * The fresh mark of the pair (userId → payerId), from the bill's payments by contract P, in the
 * SentCheckMark shape (toUserId = payerId). Null when the pair's net is ≤ 0. Works for any payer
 * (the lead, a co-payer, an ex-payer). Throws a RangeError on malformed entries or userId = payerId,
 * like pairState; callers treat a throw as a failed read.
 */
export function pairMarkOf(data: Pick<BillData, 'payments'>, userId: string, payerId: string): SentCheckMark | null {
  const mark = pairState(data.payments, userId, payerId).mark;
  return mark === null ? null : { cents: mark.cents, at: mark.at, method: mark.method, toUserId: payerId };
}

export type SentCheckUndoInput = { billId: string; userId: string; payerId: string; cents: number; markAtMs: number };

export type SentCheckUndoOutcome =
  | { kind: 'noop' }
  | { kind: 'silent' }
  | { kind: 'unmarked' }
  | { kind: 'changed'; text: string }
  | { kind: 'failed'; text: string };

export type SentCheckUndoDeps = {
  storage: KeyValueStorage;
  fetchBill: (id: string) => Promise<BillResult<BillData>>;
  /** unmarkPaid(bill, me, payer): the pair the check-in asked about (who-paid A1.3, S14). */
  unmarkPaid: (billId: string, userId: string, payerId: string) => Promise<BillResult>;
  cancelSentCheck: (identifier: string) => Promise<void>;
  now: () => number;
};

const DEFAULT_DEPS: SentCheckUndoDeps = {
  storage: realStorage,
  fetchBill: realFetchBill,
  unmarkPaid: realUnmarkPaid,
  cancelSentCheck: realCancelSentCheck,
  now: () => Date.now(),
};

const FAILED: SentCheckUndoOutcome = { kind: 'failed', text: SETTLE_COPY.undoFailed };

/** Runs the undo rule for one send. Never throws. */
export async function runSentCheckUndo(input: SentCheckUndoInput, deps: SentCheckUndoDeps = DEFAULT_DEPS): Promise<SentCheckUndoOutcome> {
  const { billId, userId, payerId, cents, markAtMs } = input;
  const key = sentCheckKey(billId, payerId, markAtMs);
  if (key === null || !isUuid(userId)) return FAILED;
  try {
    const stored = answerFor(await readSentCheckBlob(deps.storage, userId), key);
    if (stored === 'undo') return { kind: 'noop' };
    const fresh = await deps.fetchBill(billId);
    if (!fresh.ok) return FAILED;
    const freshMark = pairMarkOf(fresh, userId, payerId);
    const decision = undoDecision(stored, freshMark, { cents, markAtMs, payerId });

    const storeUndo = async () => {
      await storeSentCheckAnswer(deps.storage, userId, key, 'undo', deps.now());
      const nid = sentCheckNotificationId(userId, billId, payerId, markAtMs);
      if (nid !== null) void deps.cancelSentCheck(nid);
    };

    switch (decision) {
      case 'noop':
        return { kind: 'noop' };
      case 'silent':
        await storeUndo();
        return { kind: 'silent' };
      case 'changed':
        await storeUndo();
        return { kind: 'changed', text: sentCheckChangedText(makeNameOf(fresh.participants, userId)(payerId)) };
      case 'unmark': {
        // Noted first: a live refetch may show the mark gone before unmarkPaid returns (review R8).
        noteOwnUndo(billId, userId, deps.now());
        const res = await deps.unmarkPaid(billId, userId, payerId);
        if (!res.ok) {
          forgetOwnUndo(billId, userId);
          // busy: a lock clash aborted the unmark (delete-group A3.4). Definite, so say to retry.
          return res.error === 'busy' ? { kind: 'failed', text: BILL_ERROR_COPY.busy } : FAILED;
        }
        await storeUndo();
        ownUndoLanded(billId, userId);
        return { kind: 'unmarked' };
      }
    }
  } catch {
    // The storage and bill helpers don't throw; this keeps "never throws" true if one ever does.
    return FAILED;
  }
}
