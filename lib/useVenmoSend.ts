// The Venmo send, the cash / "another way" marks and contract O, in one hook for the Settle page and
// the bill screen (docs/specs/2026-11-26-sent-via-venmo.md D2, A1 F2 + F3 + F12 + eng §1).
//
// Native, a share: permission (once) → markPaid('venmo') raced against 4 s → scheduleSentCheck
// (1 s; only when the mark was created and permission is granted) → openPaymentLink. Venmo opens
// only when this call created the mark. If Venmo doesn't open: unmark, cancel the check-in and show
// the open-failed line. A network error or timeout opens Venmo anyway and asks on return (contract O).
//
// Web: openPaymentLinkWeb runs first, synchronously, inside the tap (popup rule). Then
// webOpenOutcome: blocked → nothing written; desktop → ask (contract O); mobile → record only if the
// tab is still open after WEB_OPEN_CHECK_MS. No notification on web.
//
// "More": open first, then settleDifference('venmo'), never a check-in (F4); afterwards the mark's
// key is stored 'shown' so a later visit doesn't ask about the first send (SV-T5-5).
//
// After an open (web, and every "more"), a refusal or an existing mark closes the tab we opened (web)
// and shows afterOpenRefusal's line: don't send it, check Venmo (review R1). Native, an unknown
// outcome followed by a failed open clears a mark that landed anyway (R4). A send that straddles a
// sign-out schedules no check-in (R10).
//
// Every write keeps its button busy until the refetch after it has finished (landed or failed),
// the same `clearAt` rule as the rest of the Settle page. Nothing is optimistic.
//
// Saved, but not refreshed (QA N3): a write that landed whose refetch failed leaves the screen on
// "You owe … / Pay", which invites a second payment. So `held` is set: the screen says the payment
// was saved, and every write here is refused, until a refetch lands (`version` reaches it). The
// screen's Try again calls `retryRefresh`, which holds while that refetch runs.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AccessibilityInfo, AppState, Platform, type AppStateStatus } from 'react-native';

import { TIMED_OUT, within } from './asyncTimeout';
import { fetchBill, markPaid, settleDifference, unmarkPaid, type BillError } from './bills';
import {
  askNotificationPermissionOnce,
  cancelSentCheck,
  cancelSentChecks,
  scheduleSentCheck,
  type NotificationPermission,
} from './checkInNotifications';
import { SCHEDULE_TIMEOUT_MS } from './checkInNotifications.types';
import { closeOpenedTab, openPaymentLink, openPaymentLinkWeb, webOpenOutcome, type ClosableTab } from './paylinks';
import type { KeyValueStorage } from './chunkedStorage';
import { isRememberedMethod, type PaymentMethod } from './paymentMethods';
import {
  isLateOwnSend,
  markAtMsOf,
  payMethodKey,
  SENT_CHECK_STORAGE_TIMEOUT_MS,
  sentCheckKey,
  sentCheckNotification,
  storeSentCheckAnswer,
  type SentCheckAnswer,
  type SentCheckMark,
} from './sentCheck';
import { pairMarkOf } from './sentCheckUndo';
import {
  actionError,
  actionPlanKey,
  afterOpenRefusal,
  announceDifferenceText,
  announceSentText,
  differenceArgs,
  openedFor,
  SETTLE_COPY,
  type OpenedVenmo,
  type PayOpenFailure,
  type SettleAction,
} from './settleView';
import { storage } from './storage';
import { supabase } from './supabase';
import { isMobileWeb } from './webEnv';

/** Starting value (D2 step 2): how long the mark may take before Venmo opens anyway. The call isn't aborted. */
export const MARK_BEFORE_OPEN_TIMEOUT_MS = 4000;
/** Starting value (review R10): how long the unmark after a failed open may take before the button comes back. */
export const UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS = 4000;
/** Starting value: a session read is local, so this only guards a stuck storage read. */
const SESSION_CHECK_TIMEOUT_MS = 1000;
/** Pay taps closer together than this are one tap (review R7). */
export const PAY_REPEAT_MS = 1000;

export type PayAction = Extract<SettleAction, { kind: 'pay' }>;
export type PayMoreAction = Extract<SettleAction, { kind: 'pay_difference' }>;
export type MarkAction = Extract<SettleAction, { kind: 'mark' }>;
export type MarkDifferenceAction = Extract<SettleAction, { kind: 'mark_difference' }>;

/** What a send needs that the action doesn't carry. All of it comes from lib's view input. */
export type SendContext = {
  /** The payer's name as shown (the notification body; never "You", the payer never pays themself). */
  payerName: string;
  /** The payer's Venmo username, for the open-failed line. */
  handle: string;
  /** The viewer's current mark `settled_at`, or null: the key a "more" send stores 'shown' for. */
  markAt: string | null;
};

/**
 * A write from the card in flight. `clearAt` is the refetch that must land before it's released.
 * `action` and `method` name the button that was pressed, so only that one shows its spinner (two
 * buttons share a kind: Cash and "Paid another way" are both `mark`).
 */
export type SendBusy = {
  kind: 'send' | 'mark' | 'difference';
  action: Extract<SettleAction['kind'], 'pay' | 'pay_difference' | 'mark' | 'mark_difference'>;
  method: PaymentMethod;
  clearAt: number | null;
};

/**
 * A write landed but the refetch after it failed (N3): 'failed' while nothing newer has landed,
 * 'retrying' while Try again's refetch runs. Null otherwise.
 */
export type SendHeld = 'failed' | 'retrying' | null;

type Options = {
  billId: string;
  viewerId: string;
  refetch: () => number;
  /** useBill's `version` and `finished`: the busy button is released once its refetch has finished. */
  version: number;
  finished: number;
  /** One write at a time across the whole screen (the screen's other writes use the same ref). */
  writing: MutableRefObject<boolean>;
  /** An answer was stored for a check key (contract O's 'yes', a "more" send's 'shown'). */
  onAnswer?: (key: string, answer: SentCheckAnswer) => void;
  /** The permission after the first Venmo tap asked (or didn't need to). */
  onPermission?: (permission: NotificationPermission) => void;
  /**
   * A write was refused (`afterOpen`: Venmo had already opened). Groups GR-T17-17: on `in_group`
   * the screen re-reads the bill's group and says where it's settled now.
   */
  onRefused?: (error: BillError, afterOpen: boolean) => void;
};

export type VenmoSend = {
  busy: SendBusy | null;
  /** Contract O: set only when the write's outcome is unknown, on desktop web, or the mobile-web tab closed. */
  openedVenmo: OpenedVenmo | null;
  setOpenedVenmo: (o: OpenedVenmo | null) => void;
  /** The card's error Banner text, or null. */
  error: string | null;
  /** Saved, but not refreshed (N3): show SETTLE_COPY.savedNotRefreshed and keep Pay disabled. */
  held: SendHeld;
  /** Try again for `held`: refetches, and holds until that refetch has finished. */
  retryRefresh: () => void;
  /** Venmo didn't open: lib's payOpenFailedLine shows it while it still matches. */
  openFailure: PayOpenFailure | null;
  /** The last send this screen made, for the inline check (a 'more' send never asks). */
  lastSend: 'share' | 'more' | null;
  /** Clears the error and open-failed line (another action started). */
  clearMessages: () => void;
  /** "Pay … on Venmo" for the whole share. Call straight from the press (web popup rule). */
  pay: (action: PayAction, ctx: SendContext) => void;
  /** "Pay … more on Venmo". Call straight from the press. */
  payMore: (action: PayMoreAction, ctx: SendContext) => void;
  /** Opens Venmo only ("Open Venmo again"): never writes. Call straight from the press. */
  openOnly: (url: string) => void;
  /** Cash, "Paid another way", or contract O's "Yes, I sent it" (`confirmsSend`). */
  mark: (action: MarkAction, ctx: SendContext) => void;
  /** The more-due card's cash / "I paid the difference", or contract O's "Yes, I sent it" on a "more". */
  markDifference: (action: MarkDifferenceAction, ctx: SendContext) => void;
};

// The time limit and the mobile-web test live in shared modules (lib/asyncTimeout.ts, lib/webEnv.ts);
// re-exported here so existing imports keep working. Mobile web records a send; desktop web asks.
export { TIMED_OUT, within, isMobileWeb };

// ----- The remembered Venmo / Cash choice (D5, SV-18): `splitit.payMethod.v1.<userId>` -----

/** The user's remembered choice, or null. Only 'venmo' / 'cash' count; anything else (or a slow read) is null. */
export async function readRememberedMethod(store: KeyValueStorage, userId: string): Promise<PaymentMethod | null> {
  const key = payMethodKey(userId);
  if (key === null) return null;
  try {
    const raw = await within(store.getItem(key), SENT_CHECK_STORAGE_TIMEOUT_MS);
    return isRememberedMethod(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Remembers a chooser tap. "Paid another way" is never remembered. Never throws. */
export async function rememberMethod(store: KeyValueStorage, userId: string, method: PaymentMethod): Promise<void> {
  const key = payMethodKey(userId);
  if (key === null || !isRememberedMethod(method)) return;
  try {
    await within(store.setItem(key, method), SENT_CHECK_STORAGE_TIMEOUT_MS);
  } catch {
    // Not remembered this time; the default applies next visit.
  }
}

/**
 * Is `userId` still the signed-in user (review R10)? A send can straddle a sign-out, whose
 * cancelAllSentChecks would then miss a check-in scheduled after it. Never throws; unsure → false.
 */
async function stillSignedInAs(userId: string): Promise<boolean> {
  try {
    const res = await within(supabase.auth.getSession(), SESSION_CHECK_TIMEOUT_MS);
    return res !== TIMED_OUT && res.data.session?.user.id === userId;
  } catch {
    return false;
  }
}

function announce(text: string) {
  // iOS VoiceOver ignores live regions; Android and web read the card's live method line.
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
}

const MARK_ANNOUNCE = { cash: SETTLE_COPY.announceCash, other: SETTLE_COPY.announceMarked } as const;

export function useVenmoSend({ billId, viewerId, refetch, version, finished, writing, onAnswer, onPermission, onRefused }: Options): VenmoSend {
  const [busy, setBusy] = useState<SendBusy | null>(null);
  const [openedVenmo, setOpenedVenmoState] = useState<OpenedVenmo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFailure, setOpenFailure] = useState<PayOpenFailure | null>(null);
  const [lastSend, setLastSend] = useState<'share' | 'more' | null>(null);
  /** N3: the refetch that must land to release the hold, and whether Try again's refetch is running. */
  const [hold, setHold] = useState<{ clearAt: number; retrying: boolean; text: string } | null>(null);
  /** The same, for the synchronous guards in the press handlers. */
  const holdRef = useRef(hold);
  holdRef.current = hold;

  const mounted = useRef(true);
  const lastPayAt = useRef(-Infinity);
  /** The permission the last ask left us with (native). Undetermined until the first Venmo tap. */
  const permission = useRef<NotificationPermission>('undetermined');
  /** What to announce (iOS) once the refetch that includes the write has landed. */
  const landing = useRef<{ clearAt: number; text: string } | null>(null);
  const callbacks = useRef({ onAnswer, onPermission, onRefused });
  callbacks.current = { onAnswer, onPermission, onRefused };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Release the busy button once its refetch has finished; announce a landed write (never a failed refetch).
  // A landed write whose refetch failed is held (N3) until a later refetch lands, then announced.
  useEffect(() => {
    const l = landing.current;
    if (l !== null && version >= l.clearAt) {
      landing.current = null;
      announce(l.text);
    } else if (l !== null && finished >= l.clearAt) {
      landing.current = null;
      const h = { clearAt: l.clearAt, retrying: false, text: l.text };
      holdRef.current = h;
      setHold(h);
    }
    const h = holdRef.current;
    if (h !== null && version >= h.clearAt) {
      holdRef.current = null;
      setHold(null);
      announce(h.text);
    } else if (h !== null && h.retrying && finished >= h.clearAt) {
      const failed = { ...h, retrying: false };
      holdRef.current = failed;
      setHold(failed);
    }
    setBusy((b) => {
      if (b === null || b.clearAt === null || (version < b.clearAt && finished < b.clearAt)) return b;
      writing.current = false;
      return null;
    });
  }, [version, finished, writing]);

  // D3: coming back to the app (background → active only, never inactive → active) cancels and
  // dismisses this user's pending check-ins; the inline question takes over.
  useEffect(() => {
    let wentBackground = AppState.currentState === 'background';
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') wentBackground = true;
      else if (state === 'active' && wentBackground) {
        wentBackground = false;
        void cancelSentChecks(viewerId);
      }
    });
    // jest-expo's AppState mock returns no subscription; the real one always does.
    return () => sub?.remove();
  }, [viewerId]);

  const safe = useCallback(<A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
    if (mounted.current) fn(...a);
  }, []);

  /** Starts a write: false if another is in flight, or a saved write isn't on screen yet (N3). */
  const begin = useCallback(
    (kind: SendBusy['kind'], action: SendBusy['action'], method: PaymentMethod): boolean => {
      if (writing.current || holdRef.current !== null) return false;
      writing.current = true;
      setBusy({ kind, action, method, clearAt: null });
      setError(null);
      setOpenFailure(null);
      return true;
    },
    [writing],
  );

  /** Ends a write: waits for `clearAt` if there is one, else releases now. */
  const finish = useCallback(
    (clearAt: number | null, landed?: string) => {
      if (clearAt !== null && landed !== undefined) landing.current = { clearAt, text: landed };
      if (!mounted.current) {
        writing.current = false;
        return;
      }
      if (clearAt === null) {
        writing.current = false;
        setBusy(null);
      } else {
        setBusy((b) => (b ? { ...b, clearAt } : b));
      }
    },
    [writing],
  );

  /** A refused write: its copy, and a refetch when the copy says the screen is stale. */
  const refused = useCallback(
    (err: Parameters<typeof actionError>[0], ctx: { difference?: boolean } = {}) => {
      const e = actionError(err, ctx);
      safe(setError)(e.text);
      finish(e.refetch ? refetch() : null);
      if (mounted.current) callbacks.current.onRefused?.(err, false);
    },
    [finish, refetch, safe],
  );

  /**
   * A refusal (or an existing mark) after Venmo is already open (review R1, D2): close the tab we
   * opened (web), say not to send it and to check Venmo, and re-read.
   */
  const refusedAfterOpen = useCallback(
    (err: BillError | 'already_marked', ctx: { difference?: boolean; tab?: ClosableTab | null } = {}) => {
      closeOpenedTab(ctx.tab ?? null);
      safe(setError)(afterOpenRefusal(err, { difference: ctx.difference }));
      finish(refetch());
      if (err !== 'already_marked' && mounted.current) callbacks.current.onRefused?.(err, true);
    },
    [finish, refetch, safe],
  );

  /** Re-reads the bill and clears the viewer's mark if it's this send landing for a Venmo that never opened (R4). */
  const clearLateSend = useCallback(
    async (action: PayAction, tapAtMs: number) => {
      const fresh = await within(fetchBill(billId), UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS);
      if (fresh === TIMED_OUT || !fresh.ok) return;
      // The pair's own mark (viewer → this payer), not participants[me].mark, which points at the
      // lead only: a send to a co-payer must be found and cleared too (A-43b, review R2).
      let mark: SentCheckMark | null;
      try {
        mark = pairMarkOf(fresh, viewerId, action.payerId);
      } catch (e) {
        // Entries the pair rule refuses: clear nothing rather than guess, and say the undo didn't run.
        if (__DEV__) console.warn('clearLateSend: the payments did not read', e);
        safe(setError)(SETTLE_COPY.undoFailed);
        return;
      }
      if (!isLateOwnSend(mark, { cents: action.cents, payerId: action.payerId, tapAtMs })) return;
      // Time-limited like the undo after a mark that landed (R10): a late answer only refetches.
      const undoing = unmarkPaid(billId, viewerId, action.payerId);
      const undone = await within(undoing, UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS);
      if (undone === TIMED_OUT) void undoing.then(() => mounted.current && refetch());
      if (undone === TIMED_OUT || !undone.ok) safe(setError)(SETTLE_COPY.undoFailed);
    },
    [billId, viewerId, refetch, safe],
  );

  const repeatTap = () => {
    const now = Date.now();
    if (now - lastPayAt.current < PAY_REPEAT_MS) return true;
    lastPayAt.current = now;
    return false;
  };

  const storeAnswer = useCallback(
    async (key: string | null, answer: SentCheckAnswer) => {
      if (key === null) return;
      await storeSentCheckAnswer(storage, viewerId, key, answer, Date.now());
      if (mounted.current) callbacks.current.onAnswer?.(key, answer);
    },
    [viewerId],
  );

  const keyFor = useCallback(
    (payerId: string, markAt: string | null): string | null => {
      const ms = markAt === null ? null : markAtMsOf(markAt);
      return ms === null ? null : sentCheckKey(billId, payerId, ms);
    },
    [billId],
  );

  const failedOpen = (action: { payerId: string; cents: number }, ctx: SendContext) =>
    safe(setOpenFailure)({ payerId: action.payerId, cents: action.cents, handle: ctx.handle });

  // ----- The share -----

  async function recordShare(action: PayAction, ctx: SendContext, from: 'native' | 'web', tab: ClosableTab | null = null): Promise<void> {
    const tapAtMs = Date.now();
    const write = markPaid(billId, action.payerId, action.cents, 'venmo', actionPlanKey(action));
    const res = await within(write, MARK_BEFORE_OPEN_TIMEOUT_MS);
    const unknown = res === TIMED_OUT || (!res.ok && res.error === 'network');

    if (from === 'web') {
      // Venmo is already open. Unknown → ask on return; a late result only refetches.
      if (unknown) {
        safe(setOpenedVenmoState)(openedFor(action));
        if (res === TIMED_OUT) void write.then(() => mounted.current && refetch());
        finish(refetch());
        return;
      }
      // Refused, or already marked: the tab we opened is pre-filled, so close it and say so (R1).
      if (!res.ok) return refusedAfterOpen(res.error, { tab });
      if (!res.created) return refusedAfterOpen('already_marked', { tab });
      safe(setLastSend)('share');
      finish(refetch(), announceSentText(ctx.payerName, action.cents));
      return;
    }

    if (unknown) {
      // The outcome is unknown: open anyway, no check-in, ask on return (contract O).
      const opened = await openPaymentLink(action.url);
      if (!opened.ok) {
        failedOpen(action, ctx);
        // A mark that landed for a Venmo that never opened would say "Sent" untruly: clear it.
        if (res === TIMED_OUT) {
          // The write is still running: its own answer says whether it made the mark.
          void write.then(async (late) => {
            if (late.ok && late.created) await unmarkPaid(billId, viewerId, action.payerId);
            if (mounted.current) refetch();
          });
          finish(refetch());
        } else {
          // A network error: it may have landed anyway (R4). Re-read, then clear it if it's this send.
          await clearLateSend(action, tapAtMs);
          finish(refetch());
        }
        return;
      }
      safe(setOpenedVenmoState)(openedFor(action));
      if (res === TIMED_OUT) void write.then(() => mounted.current && refetch());
      finish(refetch());
      return;
    }
    if (!res.ok) return refused(res.error);
    if (!res.created) {
      // Already marked (stale screen, second device, double tap): never open Venmo a second time (F3).
      safe(setError)(SETTLE_COPY.alreadyMarked);
      finish(refetch());
      return;
    }

    let scheduledId: string | null = null;
    const markAtMs = res.markAt === null ? null : markAtMsOf(res.markAt);
    // Signed out since the tap (R10): no check-in for someone who isn't here any more.
    if (permission.current === 'granted' && markAtMs !== null && (await stillSignedInAs(viewerId))) {
      const n = sentCheckNotification({
        payerName: ctx.payerName,
        billId,
        userId: viewerId,
        payerId: action.payerId,
        cents: action.cents,
        markAtMs,
      });
      if (n !== null) {
        const scheduled = await within(scheduleSentCheck(n), SCHEDULE_TIMEOUT_MS);
        if (scheduled === true) scheduledId = n.identifier;
        // Timed out here: the module cancels a late schedule; ask it too, so "no notification" holds.
        else if (scheduled === TIMED_OUT) void cancelSentCheck(n.identifier);
        // A sign-out while it was scheduling has already run cancelAllSentChecks: cancel this one too.
        if (scheduledId !== null && !(await stillSignedInAs(viewerId))) {
          void cancelSentCheck(scheduledId);
          scheduledId = null;
        }
      }
    }

    const opened = await openPaymentLink(action.url);
    if (!opened.ok) {
      if (scheduledId !== null) void cancelSentCheck(scheduledId);
      failedOpen(action, ctx);
      // Time-limited (R10): a hung unmark mustn't keep the button busy. A late one only refetches.
      const undoing = unmarkPaid(billId, viewerId, action.payerId);
      const undone = await within(undoing, UNDO_AFTER_FAILED_OPEN_TIMEOUT_MS);
      if (undone === TIMED_OUT) void undoing.then(() => mounted.current && refetch());
      if (undone === TIMED_OUT || !undone.ok) safe(setError)(SETTLE_COPY.undoFailed);
      finish(refetch());
      return;
    }
    safe(setLastSend)('share');
    finish(refetch(), announceSentText(ctx.payerName, action.cents));
  }

  function pay(action: PayAction, ctx: SendContext) {
    if (Platform.OS === 'web') {
      if (writing.current || holdRef.current !== null || repeatTap()) return;
      // First, synchronously, inside the gesture: nothing is awaited before it.
      const w = openPaymentLinkWeb(action.url);
      if (!begin('send', 'pay', 'venmo')) return;
      setOpenedVenmoState(null);
      void (async () => {
        const outcome = await webOpenOutcome(w, isMobileWeb());
        if (outcome === 'blocked') {
          failedOpen(action, ctx);
          finish(null);
          return;
        }
        if (outcome === 'ask') {
          safe(setOpenedVenmoState)(openedFor(action));
          finish(null);
          return;
        }
        await recordShare(action, ctx, 'web', w);
      })();
      return;
    }
    if (writing.current || holdRef.current !== null || repeatTap()) return;
    if (!begin('send', 'pay', 'venmo')) return;
    setOpenedVenmoState(null);
    void (async () => {
      // Never blocks the flow: any answer (or a timeout inside the module) carries on.
      permission.current = await askNotificationPermissionOnce();
      if (mounted.current) callbacks.current.onPermission?.(permission.current);
      await recordShare(action, ctx, 'native');
    })();
  }

  // ----- "More" -----

  /** Records a "more" after Venmo has opened (both platforms open first). `tab`: the web tab, to close on a refusal. */
  async function recordMore(action: PayMoreAction, ctx: SendContext, tab: ClosableTab | null = null): Promise<void> {
    const args = differenceArgs({ kind: 'mark_difference', method: 'venmo', userId: viewerId, payerId: action.payerId, fromCents: action.fromCents, toCents: action.toCents });
    const write = settleDifference(billId, ...args, actionPlanKey(action));
    const res = await within(write, MARK_BEFORE_OPEN_TIMEOUT_MS);
    if (res === TIMED_OUT || (!res.ok && res.error === 'network')) {
      safe(setOpenedVenmoState)(openedFor(action));
      if (res === TIMED_OUT) void write.then(() => mounted.current && refetch());
      finish(refetch());
      return;
    }
    // Venmo is already open, pre-filled: say not to send it and to check Venmo (R1).
    if (!res.ok) return refusedAfterOpen(res.error, { difference: true, tab });
    safe(setLastSend)('more');
    // The mark keeps its first settled_at, so its key is the original send's: don't ask about it later.
    await storeAnswer(keyFor(action.payerId, ctx.markAt), 'shown');
    finish(refetch(), announceDifferenceText('venmo', action.cents));
  }

  function payMore(action: PayMoreAction, ctx: SendContext) {
    if (writing.current || holdRef.current !== null || repeatTap()) return;
    if (Platform.OS === 'web') {
      const w = openPaymentLinkWeb(action.url);
      if (!begin('difference', 'pay_difference', 'venmo')) return;
      setOpenedVenmoState(null);
      void (async () => {
        const outcome = await webOpenOutcome(w, isMobileWeb());
        if (outcome === 'blocked') {
          failedOpen(action, ctx);
          finish(null);
          return;
        }
        if (outcome === 'ask') {
          safe(setOpenedVenmoState)(openedFor(action));
          finish(null);
          return;
        }
        await recordMore(action, ctx, w);
      })();
      return;
    }
    // Native "more" opens first (SV-8): settle_difference has no `created`, and there's no check-in.
    const opening = openPaymentLink(action.url);
    if (!begin('difference', 'pay_difference', 'venmo')) return;
    setOpenedVenmoState(null);
    void (async () => {
      const opened = await opening;
      if (!opened.ok) {
        failedOpen(action, ctx);
        finish(null);
        return;
      }
      await recordMore(action, ctx);
    })();
  }

  function openOnly(url: string) {
    if (repeatTap()) return;
    setError(null);
    if (Platform.OS === 'web') {
      openPaymentLinkWeb(url);
      return;
    }
    void openPaymentLink(url);
  }

  // ----- Marks without a send -----

  function mark(action: MarkAction, ctx: SendContext) {
    if (!begin('mark', 'mark', action.method)) return;
    void (async () => {
      const res = await markPaid(billId, action.payerId, action.cents, action.method, actionPlanKey(action));
      if (!res.ok) return refused(res.error);
      if (action.confirmsSend === true) {
        // He has just answered "did it go through?": the inline question never follows (D2).
        // A repeat after a write that landed (created false) is the same answer.
        await storeAnswer(keyFor(action.payerId, res.markAt), 'yes');
        safe(setOpenedVenmoState)(null);
        finish(refetch(), announceSentText(ctx.payerName, action.cents));
        return;
      }
      if (!res.created) {
        safe(setError)(SETTLE_COPY.alreadyMarked);
        finish(refetch());
        return;
      }
      const text = action.method === 'venmo' ? announceSentText(ctx.payerName, action.cents) : MARK_ANNOUNCE[action.method];
      finish(refetch(), text);
    })();
  }

  function markDifference(action: MarkDifferenceAction, ctx: SendContext) {
    if (!begin('difference', 'mark_difference', action.method)) return;
    void (async () => {
      const res = await settleDifference(billId, ...differenceArgs(action), actionPlanKey(action));
      if (!res.ok) return refused(res.error, { difference: true });
      if (action.method === 'venmo') {
        safe(setLastSend)('more');
        await storeAnswer(keyFor(action.payerId, ctx.markAt), 'shown');
      }
      safe(setOpenedVenmoState)(null);
      finish(refetch(), announceDifferenceText(action.method, action.toCents - action.fromCents));
    })();
  }

  const clearMessages = useCallback(() => {
    setError(null);
    setOpenFailure(null);
  }, []);

  const retryRefresh = useCallback(() => {
    const clearAt = refetch();
    const h = holdRef.current;
    if (h === null) return;
    const retrying = { ...h, clearAt, retrying: true };
    holdRef.current = retrying;
    setHold(retrying);
  }, [refetch]);

  return {
    busy,
    openedVenmo,
    setOpenedVenmo: setOpenedVenmoState,
    error,
    held: hold === null ? null : hold.retrying ? 'retrying' : 'failed',
    retryRefresh,
    openFailure,
    lastSend,
    clearMessages,
    pay,
    payMore,
    openOnly,
    mark,
    markDifference,
  };
}
