// The group Settle screen's writes and device facts (spec docs/specs/2026-11-26-groups-mvp.md T16, as
// amended by A2.2): the Venmo send, cash / "Paid another way", "Got paid another way", "Not received",
// the inline check, Undo, and Record a payment. The order of the send's steps comes from
// groupSendPlan (lib/groupSettleView.ts); this hook only runs them, so the screen does no platform
// branching of its own.
//
// Rules it keeps (lessons 2026-11-21/24/25, SV's useVenmoSend):
// - Web: openPaymentLinkWeb is the first thing the Pay handler does, before any await (popup rule).
// - A Pay or Request tap within PAY_REPEAT_MS of the last is ignored (1 s double-tap guard).
// - One write at a time (a ref). A write's control stays busy until the refetch after it has ended,
//   landed or failed. A failed refetch releases everything and says so (refreshFailedAt).
// - A client uuid per intent: one per Pay tap (reused by the "Did you send…?" Yes); manual records use
//   an IntentId keyed on their content, so a retry after a lost answer is a no-op on the server.
// - Remembered state (the attempt, the cash record, errors) carries the ids it describes; lib and the
//   screen show it only while those still match.
// - The inline check is stored 'shown' when the screen loses focus (once per payment), 'yes' after
//   either Yes (stored at the tap, keyed on the payment id, and applied in memory at once so it never
//   flashes), 'undo' after No, undo.
// - A payment this visit just sent shows "Sent via Venmo" with Undo; its inline check waits until the
//   person comes back (the app returns to the front, or the screen regains focus), criterion 121.
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, type AppStateStatus } from 'react-native';

import { TIMED_OUT, within } from './asyncTimeout';
import type { NameOf } from './billView';
import {
  createIntentId,
  GROUP_ERROR_COPY,
  newClientId,
  recordPayment,
  undoPayment,
  type GroupError,
  type GroupResult,
  type GroupSnapshot,
} from './groups';
import { GROUP_SETTLE_SCREEN_COPY as COPY, manualIntentKey } from './groupSettleText';
import {
  groupSendPlan,
  groupSentCheckKey,
  type GroupSendAttempt,
  type GroupSendPlatform,
  type GroupSendStep,
  type PayEntry,
  type ReceivedEntry,
  type RequestEntry,
  type SentEntry,
} from './groupSettleView';
import { closeOpenedTab, openPaymentLink, openPaymentLinkWeb, webOpenOutcome, type OpenedTab } from './paylinks';
import type { PaymentMethod } from './paymentMethods';
import { readSentCheckBlob, sentCheckInlineEndsInMs, storeSentCheckAnswer, withAnswer, type SentCheckAnswer, type SentCheckBlob } from './sentCheck';
import { announceNotReceivedText, announceSentText, SETTLE_COPY } from './settleView';
import { storage } from './storage';
import { PAY_REPEAT_MS, readRememberedMethod, rememberMethod } from './useVenmoSend';

/** How long the undo after a failed open may take before the button comes back (SV's value). */
export const GROUP_UNDO_AFTER_FAILED_OPEN_MS = 4000;

function announce(text: string) {
  // iOS VoiceOver ignores live regions; Android and web read the screen's live announcement line.
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
}

export type BusyKind = 'send' | 'yes' | 'cash' | 'other' | 'got_paid' | 'not_received' | 'undo' | 'form';
/** A write in flight: what it is, which card it belongs to, and the refetch that releases it. */
export type GroupBusy = { kind: BusyKind; target: string; clearAt: number | null };
/** An error line, shown on the card whose `target` it names (pay:<to>, sent:<id>, req:<from>, recv:<id>, rec:<id>, form). */
export type GroupWriteError = { target: string; text: string };

type Options = {
  groupId: string;
  viewerId: string;
  platform: GroupSendPlatform;
  snapshot: GroupSnapshot;
  nameOf: NameOf;
  refetch: () => number;
  version: number;
  finished: number;
};

export function useGroupSettle({ groupId, viewerId, platform, snapshot, nameOf, refetch, version, finished }: Options) {
  const [busy, setBusy] = useState<GroupBusy | null>(null);
  const [error, setError] = useState<GroupWriteError | null>(null);
  const [attempt, setAttempt] = useState<GroupSendAttempt | null>(null);
  const [justSent, setJustSent] = useState<readonly string[]>([]);
  /** The viewer's last cash / "Paid another way" record (its card shows while the payment exists). */
  const [recordedId, setRecordedId] = useState<string | null>(null);
  const [requestFailure, setRequestFailure] = useState<{ from: string; cents: number } | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  /** The `version` on screen when the refetch after a write failed; the line shows while it still is. */
  const [refreshFailedAt, setRefreshFailedAt] = useState<number | null>(null);
  // Device facts: the stored check answers and the remembered Venmo / Cash choice (both time-limited reads).
  const [answers, setAnswers] = useState<SentCheckBlob | null>(null);
  const [remembered, setRemembered] = useState<PaymentMethod | null>(null);
  const [methodRead, setMethodRead] = useState(false);
  /** Payments confirmed with a Yes in this visit: applied to the answers in memory at once. */
  const [yesIds, setYesIds] = useState<readonly string[]>([]);
  /** Sent in this visit: their inline check waits until the person comes back (in memory only). */
  const [deferred, setDeferred] = useState<readonly string[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const writing = useRef(false);
  const mounted = useRef(true);
  const lastPayAt = useRef(-Infinity);
  const lastRequestAt = useRef(-Infinity);
  const intent = useRef(createIntentId());
  /** What to announce once the refetch with the write lands; `show` puts it on screen too (when no card says it). */
  const landing = useRef<{ clearAt: number; text: string; show: boolean } | null>(null);
  const checkKeysOnScreen = useRef<string[]>([]);
  /** A late Pay record that answered 'network': undo it if the refetch numbered clearAt shows it (R2-N2). */
  const undoIfShown = useRef<{ id: string; clearAt: number } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void readSentCheckBlob(storage, viewerId).then((blob) => {
      if (live) setAnswers(blob);
    });
    void readRememberedMethod(storage, viewerId).then((m) => {
      if (!live) return;
      setRemembered(m);
      setMethodRead(true);
    });
    return () => {
      live = false;
    };
  }, [viewerId]);

  // Each new version of the data re-reads the clock (the inline check's time limit).
  useEffect(() => {
    setNow(Date.now());
  }, [version]);

  // Release the busy control once its refetch has ended; announce a write only once it's on screen.
  useEffect(() => {
    const l = landing.current;
    if (l !== null && version >= l.clearAt) {
      landing.current = null;
      if (l.show) setAnnouncement(l.text);
      announce(l.text);
    } else if (l !== null && finished >= l.clearAt) {
      landing.current = null;
    }
    if (busy === null || busy.clearAt === null) return;
    if (version < busy.clearAt && finished < busy.clearAt) return;
    if (version < busy.clearAt) setRefreshFailedAt(version);
    writing.current = false;
    setBusy(null);
  }, [busy, version, finished]);

  // A late record whose answer was lost (R2-N2): once the refetch after it lands, undo the payment if
  // it is there. If that refetch fails, the payment (if any) shows with its inline check, whose
  // "No, undo" does the same.
  useEffect(() => {
    const u = undoIfShown.current;
    if (u === null) return;
    if (version >= u.clearAt) {
      undoIfShown.current = null;
      if (!snapshot.payments.some((p) => p.id === u.id)) return;
      void undoPayment(u.id).then((res) => {
        if (!mounted.current) return;
        if (!res.ok) setError({ target: `sent:${u.id}`, text: SETTLE_COPY.undoFailed });
        refetch();
      });
    } else if (finished >= u.clearAt) {
      undoIfShown.current = null;
    }
  }, [version, finished, snapshot, refetch]);

  // This visit's Yes taps, applied over the stored answers in memory (stored at the tap, in confirmAsk).
  const yesKeys = useMemo(
    () => yesIds.flatMap((id) => {
      const key = groupSentCheckKey(groupId, id);
      return key === null ? [] : [key];
    }),
    [yesIds, groupId],
  );

  /**
   * The answers the model reads: stored ones, plus this visit's Yes taps (so a Yes never flashes the
   * check), plus an in-memory 'shown' for sends still waiting for the person to come back (never stored).
   */
  const sentChecks = useMemo<SentCheckBlob | null>(() => {
    if (answers === null) return null;
    let blob = answers;
    for (const key of yesKeys) blob = withAnswer(blob, key, 'yes', now);
    for (const id of deferred) {
      const key = groupSentCheckKey(groupId, id);
      if (key !== null && blob[key] === undefined) blob = withAnswer(blob, key, 'shown', now);
    }
    return blob;
  }, [answers, yesKeys, deferred, groupId, now]);

  // Coming back to the app (background → active only, as SV's D3) lets the deferred checks ask.
  useEffect(() => {
    let wentBackground = AppState.currentState === 'background';
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background') wentBackground = true;
      else if (state === 'active' && wentBackground) {
        wentBackground = false;
        setNow(Date.now());
        setDeferred([]);
      }
    });
    // jest-expo's AppState mock returns no subscription; the real one always does.
    return () => sub?.remove();
  }, []);

  const store = useCallback(
    (key: string | null, answer: SentCheckAnswer) => {
      if (key === null) return;
      setAnswers((b) => withAnswer(b ?? {}, key, answer, Date.now()));
      void storeSentCheckAnswer(storage, viewerId, key, answer, Date.now());
    },
    [viewerId],
  );

  // A check that was on screen is 'shown' once the screen loses focus: it asks once per payment.
  useFocusEffect(
    useCallback(() => {
      // Back on this screen from another one: the deferred checks may ask now.
      setDeferred((d) => (d.length === 0 ? d : []));
      return () => {
        const keys = checkKeysOnScreen.current;
        if (keys.length === 0) return;
        // In memory too: this screen may stay mounted under the next one and come back into view.
        setAnswers((b) => keys.reduce((acc, key) => withAnswer(acc, key, 'shown', Date.now()), b ?? {}));
        for (const key of keys) void storeSentCheckAnswer(storage, viewerId, key, 'shown', Date.now());
      };
    }, [viewerId]),
  );

  /** The screen tells the hook which checks it is showing, and when the next one's time runs out. */
  const noteChecks = useCallback(
    (sent: readonly SentEntry[]) => {
      checkKeysOnScreen.current = sent.flatMap((s) => (s.check?.key ? [s.check.key] : []));
      let soonest: number | null = null;
      for (const s of sent) {
        if (s.check === null) continue;
        const p = snapshot.payments.find((x) => x.id === s.paymentId);
        const left = sentCheckInlineEndsInMs(p?.createdAt ?? null, Date.now());
        if (left !== null && (soonest === null || left < soonest)) soonest = left;
      }
      return soonest;
    },
    [snapshot],
  );

  // ----- write plumbing -----

  const begin = (kind: BusyKind, target: string): boolean => {
    if (writing.current) return false;
    writing.current = true;
    setBusy({ kind, target, clearAt: null });
    setError(null);
    setRequestFailure(null);
    setAnnouncement(null);
    setRefreshFailedAt(null);
    return true;
  };

  /** Ends a write: waits for the refetch `clearAt` if there is one, else releases now. */
  const finish = (clearAt: number | null, landed?: string, show = true) => {
    if (clearAt !== null && landed !== undefined) landing.current = { clearAt, text: landed, show };
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
  };

  const fail = (target: string, err: GroupError | string, refresh: boolean) => {
    const text = err in GROUP_ERROR_COPY ? GROUP_ERROR_COPY[err as GroupError] : err;
    if (mounted.current) setError({ target, text });
    finish(refresh ? refetch() : null);
  };

  // ----- Pay on Venmo (A2.2) -----

  function pay(entry: PayEntry) {
    const venmo = entry.venmo;
    if (venmo === null || writing.current) return;
    const t = Date.now();
    if (t - lastPayAt.current < PAY_REPEAT_MS) return;
    lastPayAt.current = t;
    const first = groupSendPlan(platform, { step: 'start' });
    // Web: inside the tap, before anything is awaited.
    const tab: OpenedTab | null = 'do' in first && first.do === 'open_web' ? openPaymentLinkWeb(venmo.url) : null;
    if (!begin('send', entry.to)) return;
    setAttempt(null);
    const id = newClientId();
    const base = { id, to: entry.to, cents: entry.cents };
    const target = `pay:${entry.to}`;
    void (async () => {
      let step: GroupSendStep = first;
      let wrote = false;
      let late: Promise<GroupResult> | null = null;
      let refusal: GroupError | null = null;
      if ('do' in step && step.do === 'open_web') {
        const result = await webOpenOutcome(tab, platform === 'mobile_web');
        step = groupSendPlan(platform, { step: 'web_open', result });
      }
      while ('do' in step) {
        if (step.do === 'record') {
          const write = recordPayment({ id, groupId, from: viewerId, to: entry.to, cents: entry.cents, method: 'venmo', source: 'venmo_link' });
          wrote = true;
          const res = await within(write, step.timeoutMs);
          if (res === TIMED_OUT) late = write;
          const result = res === TIMED_OUT || (!res.ok && res.error === 'network') ? 'unknown' : res.ok ? 'ok' : 'refused';
          if (res !== TIMED_OUT && !res.ok) refusal = res.error;
          step = groupSendPlan(platform, { step: 'record', result });
        } else if (step.do === 'open') {
          const opened = await openPaymentLink(venmo.url);
          step = groupSendPlan(platform, { step: 'open', ok: opened.ok, recorded: step.recorded });
        } else if (step.do === 'undo') {
          // No payment stays behind a Venmo that never opened (SV-7).
          if (late !== null) {
            // The record is still running: there is nothing to undo yet, so undoing now could only fail
            // and say "Couldn't undo" falsely (review R3). Undo it when it lands; say so only if that fails.
            void late.then(async (r) => {
              if (r.ok) {
                const u = await undoPayment(id);
                if (!mounted.current) return;
                // The payment is on screen now, as its own sent card: the line goes there.
                if (!u.ok) setError({ target: `sent:${id}`, text: SETTLE_COPY.undoFailed });
                refetch();
                return;
              }
              if (!mounted.current) return;
              // 'network' (a lost answer, or the 15 s limit) may still have landed (R2-N2): re-read, and
              // undo it if the snapshot has it. A refusal wrote nothing; the refetch just confirms it.
              const clearAt = refetch();
              if (r.error === 'network') undoIfShown.current = { id, clearAt };
            });
            step = groupSendPlan(platform, { step: 'undo', ok: true });
            continue;
          }
          const undone = await within(undoPayment(id), GROUP_UNDO_AFTER_FAILED_OPEN_MS);
          if ((undone === TIMED_OUT || !undone.ok) && mounted.current) setError({ target, text: SETTLE_COPY.undoFailed });
          step = groupSendPlan(platform, { step: 'undo', ok: undone !== TIMED_OUT && undone.ok });
        } else {
          // 'open_web' only starts the flow; handled above.
          break;
        }
      }
      if (!('done' in step)) return finish(null);
      if (late !== null && step.done !== 'open_failed') void late.then(() => mounted.current && refetch());
      switch (step.done) {
        case 'sent':
          if (mounted.current) {
            setJustSent((s) => [...s, id]);
            setDeferred((d) => [...d, id]);
          }
          return finish(refetch(), announceSentText(nameOf(entry.to), entry.cents), false);
        case 'ask':
          if (mounted.current) setAttempt({ ...base, phase: 'ask' });
          return finish(wrote ? refetch() : null);
        case 'refused':
          // The tab we opened (mobile web) is pre-filled for a payment that wasn't recorded: close it.
          closeOpenedTab(tab as { close?: () => void } | null);
          return fail(target, refusal ?? 'network', true);
        case 'open_failed':
          if (mounted.current) setAttempt({ ...base, phase: 'open_failed' });
          return finish(wrote ? refetch() : null);
      }
    })();
  }

  /** "Yes, I sent it": records the opened amount with the same id (one row however often it's tapped). */
  function confirmAsk() {
    const a = attempt;
    if (a === null || a.phase !== 'ask' || !begin('yes', a.to)) return;
    void (async () => {
      const res = await recordPayment({ id: a.id, groupId, from: viewerId, to: a.to, cents: a.cents, method: 'venmo', source: 'venmo_link' });
      if (!res.ok) return fail(`pay:${a.to}`, res.error, res.error !== 'network');
      // Stored now, keyed on the payment id (R9): it doesn't wait for a refetch that might fail.
      const key = groupSentCheckKey(groupId, a.id);
      if (key !== null) void storeSentCheckAnswer(storage, viewerId, key, 'yes', Date.now());
      if (mounted.current) {
        setYesIds((s) => [...s, a.id]);
        setJustSent((s) => [...s, a.id]);
        setAttempt(null);
      }
      finish(refetch(), announceSentText(nameOf(a.to), a.cents), false);
    })();
  }

  const dismissAsk = () => {
    setAttempt(null);
    setError(null);
  };

  /** "Open Venmo again" isn't offered; a Request opens Venmo only and never writes. */
  function request(entry: RequestEntry) {
    const req = entry.request;
    if (req === null) return;
    const t = Date.now();
    if (t - lastRequestAt.current < PAY_REPEAT_MS) return;
    lastRequestAt.current = t;
    setRequestFailure(null);
    if (Platform.OS === 'web') {
      if (openPaymentLinkWeb(req.url) === null) setRequestFailure({ from: entry.from, cents: entry.cents });
      return;
    }
    void openPaymentLink(req.url).then((o) => {
      if (!o.ok && mounted.current) setRequestFailure({ from: entry.from, cents: entry.cents });
    });
  }

  // ----- Manual records -----

  /** A manual record (cash, "Paid another way", "Got paid another way", Record a payment). Resolves to the error, or null. */
  function recordManual(
    kind: Extract<BusyKind, 'cash' | 'other' | 'got_paid' | 'form'>,
    p: { from: string; to: string; cents: number; method: PaymentMethod },
    target: string,
  ): Promise<GroupError | null> {
    if (!begin(kind, target)) return Promise.resolve('network');
    const id = intent.current.idFor(manualIntentKey(p));
    return (async () => {
      const res = await recordPayment({ id, groupId, ...p, source: 'manual' });
      if (!res.ok) {
        // Invalid and refused answers mean the screen is stale: re-read. A network error keeps it.
        fail(target, res.error, res.error !== 'network');
        return res.error;
      }
      intent.current.done();
      if (mounted.current && (kind === 'cash' || kind === 'other')) setRecordedId(id);
      const text = kind === 'cash' ? SETTLE_COPY.announceCash : kind === 'other' ? SETTLE_COPY.announceMarked : COPY.announceRecorded;
      // Cash and "Paid another way" get their own card with a live method line; the others don't.
      finish(refetch(), text, kind === 'got_paid' || kind === 'form');
      return null;
    })();
  }

  const payCash = (entry: PayEntry) => void recordManual('cash', { from: viewerId, to: entry.to, cents: entry.cents, method: 'cash' }, `pay:${entry.to}`);
  const payOther = (entry: PayEntry) => void recordManual('other', { from: viewerId, to: entry.to, cents: entry.cents, method: 'other' }, `pay:${entry.to}`);
  const gotPaid = (entry: RequestEntry) =>
    recordManual('got_paid', { from: entry.from, to: viewerId, cents: entry.cents, method: 'other' }, `req:${entry.from}`);
  const recordFromForm = (p: { from: string; to: string; cents: number; method: PaymentMethod }) => recordManual('form', p, 'form');

  // ----- Undo -----

  /** undo_payment for the viewer's own record, "No, undo", or the recipient's "Not received". */
  function undo(
    paymentId: string,
    how: { kind: 'undo' | 'not_received'; target: string; checkKey?: string | null; landed: string },
  ): Promise<boolean> {
    if (!begin(how.kind, how.target)) return Promise.resolve(false);
    return (async () => {
      const res = await undoPayment(paymentId);
      if (!res.ok) {
        fail(how.target, res.error === 'network' ? SETTLE_COPY.undoFailed : res.error, res.error !== 'network');
        return false;
      }
      if (how.checkKey) store(how.checkKey, 'undo');
      if (mounted.current) {
        setJustSent((s) => s.filter((x) => x !== paymentId));
        setRecordedId((r) => (r === paymentId ? null : r));
      }
      finish(refetch(), how.landed);
      return true;
    })();
  }

  const undoSent = (s: SentEntry) => void undo(s.paymentId, { kind: 'undo', target: `sent:${s.paymentId}`, landed: SETTLE_COPY.undoneNotSent });
  const checkNo = (s: SentEntry) =>
    void undo(s.paymentId, { kind: 'undo', target: `sent:${s.paymentId}`, checkKey: s.check?.key ?? null, landed: SETTLE_COPY.undoneNotSent });
  const undoRecorded = (paymentId: string) => void undo(paymentId, { kind: 'undo', target: `rec:${paymentId}`, landed: COPY.announceUndone });
  const notReceived = (r: ReceivedEntry) =>
    undo(r.paymentId, { kind: 'not_received', target: `recv:${r.paymentId}`, landed: announceNotReceivedText(nameOf(r.from)) });

  /** "Yes" to "Did your $X to Dee go through?": no write; the card keeps its Undo for this visit. */
  function checkYes(s: SentEntry) {
    store(s.check?.key ?? null, 'yes');
    setJustSent((x) => (x.includes(s.paymentId) ? x : [...x, s.paymentId]));
    setAnnouncement(SETTLE_COPY.announceAllSet);
    announce(SETTLE_COPY.announceAllSet);
  }

  const choose = (method: PaymentMethod) => {
    setRemembered(method);
    void rememberMethod(storage, viewerId, method);
  };

  const retryRefresh = () => {
    setRefreshFailedAt(null);
    refetch();
  };

  return {
    busy,
    error,
    attempt,
    justSent,
    recordedId,
    requestFailure,
    announcement,
    refreshFailed: refreshFailedAt !== null && refreshFailedAt === version && busy === null,
    retryRefresh,
    /** null until the stored answers have been read (the card waits so it doesn't jump). */
    sentChecks,
    remembered,
    deviceReady: sentChecks !== null && methodRead,
    now,
    setNow,
    noteChecks,
    pay,
    confirmAsk,
    dismissAsk,
    request,
    payCash,
    payOther,
    gotPaid,
    recordFromForm,
    undoSent,
    checkNo,
    checkYes,
    undoRecorded,
    notReceived,
    choose,
  };
}
