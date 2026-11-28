// Settle up: who owes whom, how you're paying (Venmo / Cash / another way), and (host) who paid.
// Brief: docs/specs/2026-11-24-m3-settle-ux.md; sent via Venmo: docs/specs/2026-11-26-sent-via-venmo.md
// (Task 9a, D2–D5) with its -ux and -visual companions.
//
// Rules this screen keeps:
// - Shows only what the server has confirmed. A write keeps its button loading until the refetch
//   that includes it has finished; nothing is optimistic.
// - One write at a time (`writing`, shared with lib/useVenmoSend), so a double tap sends one call.
// - The Venmo send, the cash and "another way" marks and contract O live in lib/useVenmoSend (D2):
//   native records first and opens Venmo only when the mark was created; web opens first, in the tap.
// - Request and Pay back never write: no rpc, no table write, no local "requested" state.
// - The inline "Did it go through?" (D3) is stored 'shown' when this screen loses focus (navigation,
//   not app background). Its "No, undo" re-reads the bill and follows undoDecision.
// - Coming back to the app (background → active) cancels pending check-ins (in the hook); the
//   bill refetch on 'active' is useBill's.
// - No native dialogs (inline confirms). Every amount and sentence comes from lib/settleView.ts.
// - Several people paid (docs/specs/2026-11-26-who-paid.md D11, A1.5, A2; Task 10): one card per
//   person the viewer pays, each with its own Pay (only the first unmarked one filled, M9), the
//   heading "You owe 2 people · $X", the why line, and Everyone grouped by who receives. Each card's
//   writes go to that card's pair (its payer id, the plan key on routes plans). One person paying
//   looks as before, with the "Paid by … · Change" line (components/PayerLine) at the top.
// - A group bill (docs/specs/2026-11-26-groups-mvp.md T17, criterion 80; ADR 0022) is settled in its
//   group: the screen waits for lib/useBillGroup's first read, then shows one "Settled in <group>"
//   card linking to the group and nothing else (no payer, Pay, I paid, Request or marks). GR-T17-17
//   (money safety): while the group is unknown (its read failed, or a write was refused with
//   in_group and it's being checked again) the screen shows only the group check line with Try
//   again; an in_group refusal also says where the bill is settled now (inGroupRefusalText).
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Centered, Loading } from '@/components/Centered';
import { PayerLine } from '@/components/PayerLine';
import { SettleCard, type OpenAction } from '@/components/SettleCard';
import { GroupCheckLine } from '@/components/GroupCheckLine';
import { SettledInGroup } from '@/components/SettledInGroup';
import { SettlePeopleList, type NotReceivedAction, type RowLink } from '@/components/SettlePeopleList';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useSession } from '@/lib/auth';
import { inGroupRefusalText } from '@/lib/billGroup';
import { BILL_ERROR_COPY, markNotReceived, settleDifference, unmarkPaid, type BillData } from '@/lib/bills';
import { cancelSentCheck, notificationPermission } from '@/lib/checkInNotifications';
import { openPaymentLink } from '@/lib/paylinks';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { subscribeOwnPayerChange, takeOwnPayerChange } from '@/lib/ownPayerChange';
import { subscribeOwnUndo, takeOwnUndo } from '@/lib/ownUndo';
import { paidByLine, payersState, type PaidByLine } from '@/lib/payers';
import {
  markAtMsOf,
  readSentCheckBlob,
  sentCheckNotificationId,
  storeSentCheckAnswer,
  withAnswer,
  type SentCheckBlob,
  type SentCheckInline,
} from '@/lib/sentCheck';
import { runSentCheckUndo } from '@/lib/sentCheckUndo';
import {
  actionError,
  actionPlanKey,
  settleErrorShown,
  announceNotReceivedText,
  addVenmoPrompt,
  canChangePayer,
  differenceArgs,
  noticeFor,
  noticeSnapshot,
  openedStillMatches,
  payBackOpenFailedText,
  payerIdOf,
  payOpenFailedLine,
  requestOpenFailedLine,
  requestOpenFailedText,
  settleCards,
  settlePeople,
  settleRequestWebLine,
  settleViewInputFor,
  SETTLE_COPY,
  type NoticeSnapshot,
  type RequestOpenFailure,
  type SettleAction,
  type SettleCardModel,
  type SettleViewInput,
} from '@/lib/settleView';
import { storage } from '@/lib/storage';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';
import { knownGroup, useBillGroup } from '@/lib/useBillGroup';
import { useMarkSeen } from '@/lib/useMarkSeen';
import { useSentCheckNow } from '@/lib/useSentCheckNow';
import { PAY_REPEAT_MS, readRememberedMethod, rememberMethod, useVenmoSend, type SendContext } from '@/lib/useVenmoSend';
import { isMobileWeb } from '@/lib/webEnv';

const LOAD_ERROR = "Couldn't load the bill.";

/**
 * The "Paid by …" line (contract L, A1.5), or null if the stored rows don't read. `canChange` false
 * (fewer than 2 people, or not the host) draws it as plain text: there's no one to change it to.
 */
function paidByLineFor(data: BillData, myId: string, nameOf: (userId: string | null) => string, canChange: boolean): PaidByLine | null {
  let line: PaidByLine;
  try {
    const state = payersState({ payerId: data.bill.payer_id, rows: data.payers, totalCents: data.bill.total_cents });
    line = paidByLine({ state, viewerId: myId, hostId: data.bill.host_id, joinOrder: data.participants.map((p) => p.userId), nameOf });
  } catch {
    return null;
  }
  if (canChange || line.action === null) return line;
  return { ...line, action: null, actionLabel: null, a11yLabel: line.text, a11yHint: null };
}

/** The pair a card's writes go to (its payer), from the first action that names one; null if none. */
function cardPayerId(m: SettleCardModel): string | null {
  for (const b of [m.primary, ...m.secondary, m.check?.yes ?? null]) {
    const a = b?.action;
    if (a !== undefined && 'payerId' in a && typeof a.payerId === 'string') return a.payerId;
  }
  return null;
}

function isCheck(a: SettleAction): a is CheckAction & SentCheckInline {
  return a.kind === 'sent_check_yes' || a.kind === 'sent_check_undo';
}

type CheckAction = Extract<SettleAction, { kind: 'sent_check_yes' | 'sent_check_undo' }>;

/** Announced on iOS and Android; web has no announcer and reads the card (the completion line). */
function announceEverywhere(text: string) {
  if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(text);
}

export default function SettleRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  // A new id is a new screen: no state carries over from another bill.
  return <SettleScreen key={id} id={id} myId={session?.user.id ?? ''} />;
}

/**
 * A write in flight that this screen owns (the send hook owns Pay / cash / "another way"):
 * `clearAt` is the refetch that must land before its button is released.
 */
type Busy = {
  kind: 'unmark' | 'difference' | 'check' | 'not_received';
  userId: string;
  /** The pair's payer (several payers: a person can have a row in two groups). */
  payerId: string;
  from: 'card' | 'list';
  clearAt: number | null;
};

/** A link that didn't open, remembered by its URL (which carries the handle and amount; review R2). */
type LinkFailure = { url: string; handle: string; cents: number };

function SettleScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { load, version, finished, refetch, livePaused } = useBill(id);
  const billGroup = useBillGroup(id);
  const group = knownGroup(billGroup.read) ?? null;
  const groupUnknown = billGroup.read.status === 'failed';
  /** A write refused with in_group: the bill moved into a group under this screen. */
  const [moved, setMoved] = useState<{ afterOpen: boolean } | null>(null);

  const [busy, setBusy] = useState<Busy | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Open failures keep what they described, and show only while it still matches (review R2).
  const [requestFailure, setRequestFailure] = useState<RequestOpenFailure | null>(null);
  const [payBackFailure, setPayBackFailure] = useState<LinkFailure | null>(null);
  /** The back-due card's Request didn't open: its URL (the card's handle and amount come from the model). */
  const [cardRequestFailure, setCardRequestFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  /** "Marked paid back" under the list (SE-UX-12), until the next action. */
  const [listAnnouncement, setListAnnouncement] = useState<string | null>(null);
  // Device facts (D3, D5): the remembered Venmo/Cash choice, the check-in answers, the permission.
  // The card waits for the two reads (each has a time limit) so the chooser never jumps.
  const [remembered, setRemembered] = useState<PaymentMethod | null>(null);
  const [methodRead, setMethodRead] = useState(false);
  const [answers, setAnswers] = useState<SentCheckBlob | null>(null);
  const [permissionUndetermined, setPermissionUndetermined] = useState(false);
  // A phone's browser (read once: the browser doesn't change while the page is open).
  const [mobileWeb] = useState(isMobileWeb);

  const mounted = useRef(true);
  /** One write at a time across the screen and the send hook (double-tap guard). */
  const writing = useRef(false);
  /** What the screen last showed, for the §6 notices. */
  const shown = useRef<NoticeSnapshot | null>(null);
  const iUndid = useRef(false);
  const lastCardRequestAt = useRef(-Infinity);
  /** A-50(j), review R8: when the Who paid? page was last pushed (a double tap pushes it once). */
  const lastPayersPushAt = useRef(-Infinity);
  /** Opens Who paid?, once per tap: a second push within PAY_REPEAT_MS is ignored (the Request guard's window). */
  const openPayers = () => {
    const now = Date.now();
    if (now - lastPayersPushAt.current < PAY_REPEAT_MS) return;
    lastPayersPushAt.current = now;
    router.push(`/bills/${id}/payers`);
  };
  const lastRequestAt = useRef(-Infinity);
  /** A recorded write: what to announce once the refetch that includes it has landed. */
  const landing = useRef<{
    clearAt: number;
    text: string;
    list: boolean;
  } | null>(null);
  /** The inline checks on screen right now (one per card), stored 'shown' when the screen loses focus. */
  const checkOnScreen = useRef<SentCheckInline[]>([]);
  /** The card (by its payer id) the person last acted on: its spinner, errors and confirmations show there. */
  const [activeCard, setActiveCard] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void readSentCheckBlob(storage, myId).then((blob) => {
      if (live) setAnswers(blob);
    });
    void readRememberedMethod(storage, myId).then((m) => {
      if (!live) return;
      setRemembered(m);
      setMethodRead(true);
    });
    // The "we'll check back" note shows only while the permission is undetermined (native, SV-UX-7).
    if (Platform.OS !== 'web') {
      void notificationPermission().then((p) => {
        if (live) setPermissionUndetermined(p === 'undetermined');
      });
    }
    return () => {
      live = false;
    };
  }, [myId]);

  const send = useVenmoSend({
    billId: id,
    viewerId: myId,
    refetch,
    version,
    finished,
    writing,
    onAnswer: (key, answer) => setAnswers((b) => withAnswer(b ?? {}, key, answer, Date.now())),
    onPermission: (p) => setPermissionUndetermined(p === 'undetermined'),
    onRefused: (error, afterOpen) => {
      if (error === 'in_group') movedIntoGroup(afterOpen);
      // payers_stale needs no re-read here: useVenmoSend already re-reads (actionError says so), and
      // the stale card shows once it lands.
    },
  });
  const { openedVenmo, setOpenedVenmo } = send;
  const openedRef = useRef(openedVenmo);
  openedRef.current = openedVenmo;

  const data = load.status === 'ready' ? load.data : null;
  useMarkSeen(id, version, data !== null);

  /** The viewer's own mark toward the bill's payer as fetched (the key of its check-in), or null. */
  const myMark = data?.participants.find((p) => p.userId === myId)?.mark ?? null;
  /** The viewer's mark on each pair they pay (several payers: from the ledger's pairs). */
  const myMarks = useMemo((): ReadonlyMap<string, string> => {
    if (!data) return new Map();
    const plan = settleViewInputFor(data, myId, Platform.OS, null).plan;
    if (plan.status === 'routes') {
      return new Map(plan.pairs.flatMap((q) => (q.fromId === myId && q.mark !== null ? [[q.toId, q.mark.at] as const] : [])));
    }
    return myMark === null ? new Map() : new Map([[myMark.toUserId, myMark.at]]);
  }, [data, myId, myMark]);
  /** The viewer's mark `settled_at` on the pair to `payerId`, or null. */
  const markAtFor = (payerId: string): string | null => myMarks.get(payerId) ?? (myMark?.toUserId === payerId ? myMark.at : null);
  // The inline check's clock moves on its own at the 30-minute mark, on focus and on return (R10).
  // Several marks: the newest one is the next to cross it.
  const newestMarkAt = [...myMarks.values()].sort().at(-1) ?? myMark?.at ?? null;
  const now = useSentCheckNow(newestMarkAt);

  // The view input for this version of the data plus the device facts, from lib (request spec F1).
  const lastSend = send.lastSend;
  const base = useMemo(
    () =>
      data
        ? settleViewInputFor(data, myId, Platform.OS, null, {
            rememberedMethod: remembered,
            sentCheck: answers === null ? null : { answers, now, ...(lastSend !== null ? { lastSend } : {}) },
            permissionUndetermined,
            // The "On a computer?" lines are for desktop web only (SV-WEB-1).
            mobileWeb,
          })
        : null,
    [data, myId, remembered, answers, lastSend, permissionUndetermined, mobileWeb, now],
  );

  // The viewer's own "No, undo" from the notification (lib/sentCheckUndo) landed while this page is
  // open: re-read, so the card shows it (the responder doesn't push a second Settle page; R8).
  useEffect(
    () =>
      subscribeOwnUndo((billId, userId) => {
        if (billId === id && userId === myId && mounted.current) refetch();
      }),
    [id, myId, refetch],
  );

  // The host saved who paid on the "Who paid?" page (pushed over this one): re-read at once.
  useEffect(
    () =>
      subscribeOwnPayerChange((billId) => {
        if (billId === id && mounted.current) refetch();
      }),
    [id, refetch],
  );

  // D3, R3: a question that was on screen is "shown" once the screen loses focus (navigation, not
  // app background: useFocusEffect doesn't run on background). It doesn't come back.
  useFocusEffect(
    useCallback(() => {
      return () => {
        for (const c of checkOnScreen.current) void storeSentCheckAnswer(storage, myId, c.key, 'shown', Date.now());
      };
    }, [myId]),
  );

  // Release a write's button once the refetch after the write has finished:
  // landed (`version`), or failed (`finished`; the screen then keeps what the server last confirmed).
  // A newer refetch landing first counts too: useBill only shows the newest response, so it already
  // holds the change.
  useEffect(() => {
    const done = (clearAt: number | null) => clearAt !== null && (version >= clearAt || finished >= clearAt);
    // A recorded difference is announced only once the screen shows it (a failed refetch says nothing).
    const l = landing.current;
    if (l !== null && version >= l.clearAt) {
      landing.current = null;
      if (l.list) setListAnnouncement(l.text);
      // iOS VoiceOver ignores live regions; Android and web read "Marked paid" (card) or the list caption.
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(l.text);
    } else if (l !== null && finished >= l.clearAt) {
      landing.current = null;
    }
    setBusy((b) => {
      if (b === null || !done(b.clearAt)) return b;
      writing.current = false;
      return null;
    });
  }, [version, finished]);

  // Notices (§6), announcements, and dropping a stale "Did you pay?" on every new version of the data.
  useEffect(() => {
    if (!data || !base) return;
    const next: NoticeSnapshot = noticeSnapshot(base);
    const prev = shown.current;
    shown.current = next;

    const opened = openedRef.current;
    if (prev !== null) {
      // The viewer's own undo: this page's Undo (iUndid), or a "No, undo" through lib/sentCheckUndo
      // (the card's or the notification's), which notes itself in lib/ownUndo (R8).
      const ownUndo = iUndid.current || (prev.myMark && !next.myMark && takeOwnUndo(id, myId));
      const text = noticeFor(prev, next, {
        iChangedPayer: prev.payerId !== next.payerId && takeOwnPayerChange(id),
        iUndid: ownUndo,
        openedVenmo: opened,
        nameOf: base.nameOf,
        viewerId: myId,
      });
      if (text !== null) setNotice(text);
      if (prev.myMark && !next.myMark && iUndid.current) {
        iUndid.current = false;
        setAnnouncement((a) => a ?? SETTLE_COPY.announceUnmarked);
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SETTLE_COPY.announceUnmarked);
      }
    }

    // Contract O: "Did you send Hana?" stays while the payer and the mark still match (not the amount).
    if (opened !== null && !openedStillMatches(base.plan, myId, opened)) setOpenedVenmo(null);
  }, [data, base, myId, id, setOpenedVenmo]);

  // ----- Actions -----

  /** What the send hook needs that the action doesn't carry, for the pair to `payerId`. */
  function sendContext(payerId: string): SendContext {
    return {
      payerName: base ? base.nameOf(payerId) : '',
      handle: base?.venmoOf(payerId) ?? '',
      markAt: markAtFor(payerId),
    };
  }

  /**
   * The plan key a write from this screen carries (A1.2): the one the action was stamped with, on
   * every plan that has one (one payer or several), the same as lib/useVenmoSend's writes.
   */
  function planKeyOf(action: SettleAction): string | null {
    return actionPlanKey(action);
  }

  function clearCardMessages() {
    setCardError(null);
    setCardRequestFailure(null);
    setAnnouncement(null);
    send.clearMessages();
  }

  /** The card's links: Pay, Pay more, "Open Venmo again" (ghost) and the back-due Request. */
  function onOpen(action: OpenAction, slot: 'block' | 'ghost', cardId: string | null) {
    setActiveCard(cardId);
    if (action.kind === 'request') {
      // A nudge: nothing changes on screen, nothing is written (VR-6). R7: a double tap opens once.
      const now = Date.now();
      if (now - lastCardRequestAt.current < PAY_REPEAT_MS) return;
      lastCardRequestAt.current = now;
      const opening = openPaymentLink(action.url); // first call once the tap goes through; no await before it
      clearCardMessages();
      void opening.then((res) => {
        if (!res.ok && mounted.current) setCardRequestFailure(action.url);
      });
      return;
    }
    // Contract O's "Open Venmo again": opens only, never writes.
    if (slot === 'ghost') {
      send.openOnly(action.url);
      return;
    }
    const ctx = sendContext(action.payerId);
    // The hook opens (web) or records (native) first; messages are cleared after, never before.
    if (action.kind === 'pay') send.pay(action, ctx);
    else send.payMore(action, ctx);
    setCardError(null);
    setCardRequestFailure(null);
    setAnnouncement(null);
  }

  /** The list's links: Request (whole share or a "more" difference) and Pay back. Never write. */
  function onOpenLink(link: RowLink, kind: 'request' | 'pay_back') {
    const now = Date.now();
    if (now - lastRequestAt.current < PAY_REPEAT_MS) return;
    lastRequestAt.current = now;
    const opening = openPaymentLink(link.url); // first call once the tap goes through; no await before it
    setListError(null);
    setRequestFailure(null);
    setPayBackFailure(null);
    setListAnnouncement(null);
    void opening.then((res) => {
      if (res.ok || !mounted.current) return;
      if (kind === 'request')
        setRequestFailure({
          userId: link.userId,
          cents: link.cents,
          handle: link.handle,
        });
      else
        setPayBackFailure({
          url: link.url,
          handle: link.handle,
          cents: link.cents,
        });
    });
  }

  /** Cancels (and dismisses) the check-in for the viewer's current mark: any in-app undo of it (D3). */
  function cancelCheckInFor(payerId: string, markAt: string | null) {
    const ms = markAt === null ? null : markAtMsOf(markAt);
    const nid = ms === null ? null : sentCheckNotificationId(myId, id, payerId, ms);
    if (nid !== null) void cancelSentCheck(nid);
  }

  // ----- The inline check (D3) -----

  function onCheckYes(a: CheckAction) {
    // Nothing is written to the server: the answer lives on the device, and the question goes now.
    const now = Date.now();
    setAnswers((b) => withAnswer(b ?? {}, a.key, 'yes', now));
    void storeSentCheckAnswer(storage, myId, a.key, 'yes', now);
    const nid = sentCheckNotificationId(myId, a.billId, a.payerId, a.markAtMs);
    if (nid !== null) void cancelSentCheck(nid);
    clearCardMessages();
    announceEverywhere(SETTLE_COPY.announceAllSet);
  }

  /**
   * "No, undo": the one undo rule, lib/sentCheckUndo (A1 F6; review R6), as the bill footer and the
   * notification use it. Only the busy button and the announcement are this screen's. The "was
   * undone… see who" notice stays away through lib/ownUndo. A failure keeps the question.
   */
  async function onCheckUndo(a: CheckAction) {
    if (writing.current) return;
    writing.current = true;
    setBusy({ kind: 'check', userId: myId, payerId: a.payerId, from: 'card', clearAt: null });
    clearCardMessages();
    const release = (clearAt: number | null) => {
      if (clearAt === null) {
        writing.current = false;
        setBusy(null);
      } else setBusy((b) => (b ? { ...b, clearAt } : b));
    };
    const outcome = await runSentCheckUndo({
      billId: a.billId,
      userId: myId,
      payerId: a.payerId,
      cents: a.cents,
      markAtMs: a.markAtMs,
    });
    if (!mounted.current) return;
    if (outcome.kind === 'noop') {
      release(null);
      return;
    }
    if (outcome.kind === 'failed') {
      setCardError(outcome.text);
      release(null);
      return;
    }
    setAnswers((b) => withAnswer(b ?? {}, a.key, 'undo', Date.now()));
    const clearAt = refetch();
    if (outcome.kind === 'changed') setCardError(outcome.text);
    if (outcome.kind === 'unmarked') {
      // Shown in the card's polite slot (Android, web) once it lands; iOS hears it at once.
      setAnnouncement(SETTLE_COPY.undoneNotSent);
      if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SETTLE_COPY.undoneNotSent);
    }
    release(clearAt);
  }

  // ----- The payer's Not received (D4) -----

  async function onNotReceived(a: NotReceivedAction) {
    if (writing.current) return;
    writing.current = true;
    setBusy({
      kind: 'not_received',
      userId: a.userId,
      payerId: a.payerId,
      from: 'list',
      clearAt: null,
    });
    setListError(null);
    setRequestFailure(null);
    setPayBackFailure(null);
    setListAnnouncement(null);
    // The mark's exact cents and settled_at as fetched: the stale-state tokens (F5).
    const res = await markNotReceived(id, a.userId, a.payerId, a.expectedCents, a.expectedAt);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      landing.current = {
        clearAt,
        text: announceNotReceivedText(base ? base.nameOf(a.userId) : ''),
        list: true,
      };
      setBusy((b) => (b ? { ...b, clearAt } : b));
      return;
    }
    writing.current = false;
    setBusy(null);
    if (res.error === 'in_group') movedIntoGroup(false);
    const err = actionError(res.error, { notReceived: true });
    setListError(err.text);
    if (err.refetch) refetch();
  }

  /** GR-T17-17: a write refused with in_group. Check the group again; the screen then says where it's settled. */
  function movedIntoGroup(afterOpen: boolean) {
    setMoved({ afterOpen });
    billGroup.recheck();
  }

  /** The chooser (D5): the choice shows at once and is remembered on this device (Venmo / Cash only). */
  function onChoose(method: PaymentMethod) {
    setRemembered(method);
    send.clearMessages();
    void rememberMethod(storage, myId, method);
  }

  /** `pairPayer`: the pair's payer as lib stamped it on the action or row; the bill's payer if absent. */
  async function onUnmark(userId: string, from: 'card' | 'list', pairPayer: string | undefined) {
    if (writing.current || !data) return;
    writing.current = true;
    const own = userId === myId;
    const payerId = pairPayer ?? payerIdOf(data);
    setBusy({ kind: 'unmark', userId, payerId, from, clearAt: null });
    setCardError(null);
    setListError(null);
    send.clearMessages();
    setRequestFailure(null);
    setPayBackFailure(null);
    setCardRequestFailure(null);
    setAnnouncement(null);
    setListAnnouncement(null);
    if (own) iUndid.current = true;
    const undoneAt = own ? markAtFor(payerId) : null;
    const res = await unmarkPaid(id, userId, payerId);
    if (!mounted.current) return;
    if (res.ok) {
      if (undoneAt !== null) cancelCheckInFor(payerId, undoneAt);
      const clearAt = refetch();
      setBusy((b) => (b ? { ...b, clearAt } : b));
      return;
    }
    if (own) iUndid.current = false;
    writing.current = false;
    setBusy(null);
    const err = actionError(res.error);
    if (from === 'card') setCardError(err.text);
    else setListError(err.text);
    if (err.refetch) refetch();
  }

  /**
   * "I paid the difference" (card) or "I paid it back" (the payer's row): settleDifference with the
   * action's values as lib built them (the shown or opened model; never recomputed here).
   */
  async function onMarkDifference(action: Extract<SettleAction, { kind: 'mark_difference' }>, from: 'card' | 'list') {
    if (writing.current) return;
    writing.current = true;
    setBusy({ kind: 'difference', userId: action.userId, payerId: action.payerId, from, clearAt: null });
    setCardError(null);
    setListError(null);
    send.clearMessages();
    setRequestFailure(null);
    setPayBackFailure(null);
    setCardRequestFailure(null);
    setAnnouncement(null);
    setListAnnouncement(null);
    const res = await settleDifference(id, ...differenceArgs(action), planKeyOf(action));
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      landing.current = {
        clearAt,
        text: from === 'card' ? SETTLE_COPY.announceDifference : SETTLE_COPY.announcePaidBack,
        list: from === 'list',
      };
      setBusy((b) => (b ? { ...b, clearAt } : b));
      return;
    }
    writing.current = false;
    setBusy(null);
    if (res.error === 'in_group') movedIntoGroup(false);
    const err = actionError(res.error, { difference: true });
    if (from === 'card') setCardError(err.text);
    else setListError(err.text);
    if (err.refetch) refetch();
  }

  function onAction(action: Exclude<SettleAction, OpenAction>, cardId: string | null = null) {
    setActiveCard(cardId);
    switch (action.kind) {
      case 'mark':
        clearCardMessages();
        send.mark(action, sendContext(action.payerId));
        return;
      case 'mark_difference':
        clearCardMessages();
        send.markDifference(action, sendContext(action.payerId));
        return;
      case 'unmark':
        void onUnmark(action.userId, 'card', action.payerId);
        return;
      case 'sent_check_yes':
        onCheckYes(action);
        return;
      case 'sent_check_undo':
        void onCheckUndo(action);
        return;
      case 'not_received':
        void onNotReceived(action);
        return;
      case 'add_venmo':
        // /account, not the Profile tab: one Back returns here (tab-bar spec criterion 41).
        router.push('/account');
        return;
      case 'back':
        router.dismissTo(`/bills/${id}`);
        return;
      case 'edit':
        router.push(`/bills/${id}/edit`);
        return;
      case 'fix_payers':
        openPayers();
        return;
      case 'retry':
        refetch();
        return;
    }
  }

  // ----- Render -----

  // The bar is there in every state; the back control only where it always was (the settle view).
  const header = <BackHeader title={SETTLE_COPY.title} />;
  // The first group read too, so a group bill never shows Pay before "Settled in".
  if (load.status === 'loading' || (load.status === 'ready' && (answers === null || !methodRead || billGroup.read.status === 'loading'))) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (load.status === 'not_found') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{BILL_ERROR_COPY.not_found}</Text>
        <Button label="Go home" accessibilityLabel="Go home" variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error' || !data || !base) {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{LOAD_ERROR}</Text>
        <Button
          label="Try again"
          accessibilityLabel="Try again"
          variant="primary"
          onPress={() => {
            refetch();
            billGroup.reload();
          }}
        />
      </Centered>
    );
  }

  const back = {
    label: SETTLE_COPY.back,
    accessibilityLabel: SETTLE_COPY.backA11y,
    onPress: () => router.dismissTo(`/bills/${id}`),
  };
  const movedText = moved === null ? null : inGroupRefusalText(group?.name ?? null, moved.afterOpen);
  if (groupUnknown) {
    checkOnScreen.current = [];
    return (
      <>
        <BackHeader title={SETTLE_COPY.title} back={back} />
        <ScrollView
          style={{ backgroundColor: colors.background }}
          contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
        >
          <View style={styles.column}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {SETTLE_COPY.title}
            </Text>
            <GroupCheckLine onRetry={() => billGroup.reload()} checking={billGroup.reading} notice={movedText} />
          </View>
        </ScrollView>
      </>
    );
  }
  if (group !== null) {
    checkOnScreen.current = [];
    return (
      <>
        <BackHeader title={SETTLE_COPY.title} back={back} />
        <ScrollView
          style={{ backgroundColor: colors.background }}
          contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
        >
          <View style={styles.column}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {SETTLE_COPY.title}
            </Text>
            {movedText !== null ? (
              <Banner tone="warning" alert>
                <BannerText>{movedText}</BannerText>
              </Banner>
            ) : null}
            <SettledInGroup groupName={group.name} variant="card" onOpenGroup={() => router.push(`/groups/${group.groupId}`)} />
          </View>
        </ScrollView>
      </>
    );
  }

  const input: SettleViewInput = { ...base, openedVenmo };
  // One card per pair the viewer pays (several payers), else the one card as before (A1.5 M9).
  const cardsModel = settleCards(input);
  const cards = cardsModel.cards.map((model) => ({ model, payerId: cardPayerId(model) }));
  // Messages, spinners and confirmations go to the card the person last acted on (the first card
  // when there's one, or before any tap). Every other card is locked while a write is in flight.
  const activeIndex = Math.max(
    0,
    cards.findIndex((c) => c.payerId !== null && c.payerId === activeCard),
  );
  const people = settlePeople(input);
  const requestWebLine = settleRequestWebLine(input, people);
  const venmoPrompt = addVenmoPrompt(input);
  const showChange = canChangePayer(myId, data.bill.host_id, data.participants.length, base.plan);
  const line = base.plan.status === 'blocked_bad_payer' ? null : paidByLineFor(data, myId, base.nameOf, showChange);
  // The card's in-flight kinds: the send hook's write (only the button pressed: its kind and method),
  // or this screen's undo / check.
  const cardBusy: readonly SettleAction['kind'][] =
    send.busy !== null
      ? [send.busy.action]
      : busy?.from === 'card'
        ? busy.kind === 'check'
          ? ['sent_check_undo']
          : busy.kind === 'unmark'
            ? ['unmark']
            : ['mark_difference']
        : [];
  const anyWrite = cardBusy.length > 0 || send.held !== null || busy !== null;
  const listBusy =
    busy !== null && busy.from === 'list'
      ? {
          userId: busy.userId,
          payerId: busy.payerId,
          kind: busy.kind === 'unmark' || busy.kind === 'not_received' ? busy.kind : ('difference' as const),
        }
      : null;
  // The inline checks are "shown" once this screen loses focus with them on screen (D3).
  checkOnScreen.current = cards.flatMap(({ model }) =>
    model.check !== null && isCheck(model.check.yes.action) ? [model.check.yes.action] : [],
  );
  const active = cards[activeIndex];
  // Open-failed lines show only while the control they describe is still on screen (review R2).
  const cardRequest = active?.model.primary?.action.kind === 'request' ? active.model.primary.action : null;
  const requestHandle = active?.payerId != null ? base.venmoOf(active.payerId) : base.payerVenmo;
  const cardRequestFailed =
    cardRequestFailure !== null &&
    cardRequest?.url === cardRequestFailure &&
    requestHandle !== null &&
    active !== undefined &&
    active.model.amountCents !== null
      ? requestOpenFailedText(requestHandle, active.model.amountCents)
      : null;
  const payBackFailed =
    payBackFailure !== null &&
    (people?.rows ?? []).some((r) => r.payBack?.link.kind === 'link' && r.payBack.link.url === payBackFailure.url)
      ? payBackOpenFailedText(payBackFailure.handle, payBackFailure.cents)
      : null;
  // With the stale card on screen, payers_stale's banner would only repeat it (settleErrorShown).
  const cardMessage = settleErrorShown(
    send.error ?? cardError ?? payOpenFailedLine(input, send.openFailure) ?? cardRequestFailed,
    base.plan.status,
  );

  return (
    <>
      <BackHeader title={SETTLE_COPY.title} back={back} />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[styles.content, { paddingTop: space.md, paddingBottom: insets.bottom + space.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {SETTLE_COPY.title}
            </Text>
            <PayerLine line={line} onPress={openPayers} />
            {cardsModel.why !== null ? <Text style={[type.body, { color: colors.textMuted }]}>{cardsModel.why}</Text> : null}
          </View>

          {notice !== null ? (
            <Banner tone="warning" alert>
              <View style={styles.noticeRow}>
                <View style={styles.grow}>
                  <BannerText>{notice}</BannerText>
                </View>
                <Button
                  label={SETTLE_COPY.dismiss}
                  accessibilityLabel="Dismiss notice"
                  variant="ghost"
                  onPress={() => setNotice(null)}
                  flush
                />
              </View>
            </Banner>
          ) : null}

          {livePaused ? (
            <View style={styles.noticeRow}>
              <Text style={[type.caption, styles.grow, { color: colors.textMuted }]}>Live updates paused</Text>
              <Button label="Refresh" accessibilityLabel="Refresh" variant="ghost" onPress={() => refetch()} flush />
            </View>
          ) : null}

          {venmoPrompt !== null ? (
            // A prompt, not the task: a quiet card with a tonal button, so Pay / "I paid" stays the
            // screen's only primary (P10, decision VP-M2).
            <Card muted>
              <Text style={[type.label, { color: colors.text }]}>{venmoPrompt.text}</Text>
              <Button
                label={venmoPrompt.button.label}
                accessibilityLabel={venmoPrompt.button.a11yLabel}
                accessibilityHint={venmoPrompt.button.a11yHint}
                variant="secondary"
                block
                onPress={() => onAction(venmoPrompt.button.action)}
              />
            </Card>
          ) : null}

          <View style={styles.cards}>
            {cardsModel.heading !== null ? (
              <Text accessibilityRole="header" style={[type.label, { color: colors.text }]}>
                {cardsModel.heading}
              </Text>
            ) : null}
            {cards.map(({ model, payerId }, i) => {
              const isActive = i === activeIndex;
              return (
                <SettleCard
                  key={payerId ?? `card-${i}`}
                  model={model}
                  busy={isActive ? cardBusy : []}
                  busyMethod={isActive ? send.busy?.method : undefined}
                  // Another card's write is in flight: this one waits (one write at a time).
                  locked={!isActive && anyWrite}
                  // N3: a payment saved whose refetch failed: say so, and hold Pay until a refetch lands.
                  held={isActive ? send.held : null}
                  onRetry={send.retryRefresh}
                  error={isActive ? cardMessage : null}
                  announcement={isActive ? announcement : null}
                  onOpen={(action, slot) => onOpen(action, slot, payerId)}
                  onAction={(action) => onAction(action, payerId)}
                  onChoose={onChoose}
                />
              );
            })}
          </View>

          {people !== null ? (
            <SettlePeopleList
              model={people}
              busy={listBusy}
              error={settleErrorShown(listError, base.plan.status) ?? requestOpenFailedLine(people, requestFailure) ?? payBackFailed}
              footnote={requestWebLine}
              announcement={listAnnouncement}
              onUndo={(userId, payerId) => void onUnmark(userId, 'list', payerId)}
              onOpenLink={onOpenLink}
              onRecord={(action) => void onMarkDifference(action, 'list')}
              onNotReceived={(action) => void onNotReceived(action)}
            />
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.lg },
  column: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    gap: space.xl,
  },
  header: { gap: space.xs },
  // The heading and the cards it counts read as one group (A1.5 M9).
  cards: { gap: space.md },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  centerText: { textAlign: 'center', maxWidth: layout.message },
});
