// The bill screen: one row per unit with a claim toggle, who claimed what, everyone's shares, live.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 10, "Claim screen UX").
//
// Mounted here: the item detail sheet with custom splits (Task 11, opened from a row's details
// target), the share panel (Task 12), links to the edit screen (Task 13) and Activity (Task 17),
// and the extras split control (Task 19, in SharesSummary's extrasControl slot).
// People and invites (docs/specs/2026-11-24-people-and-invites.md, Task 7): "Add people" in the
// share panel (host) and "Leave this bill" at the end of the content (guests, when canLeave).
// Claimable discounts (docs/specs/2026-11-24-claimable-discounts.md, Task 7): discount rows are
// claimed and shared like items, in their own card after every item under a "Discounts" header.
// Seen (sent-via-Venmo A1 F7, criterion 43): lib/useMarkSeen marks the bill seen after each new
// version of the data while the screen is in front (debounced) and once when it loses focus.
// The footer (docs/specs/2026-11-26-sent-via-venmo.md D5, Task 9b; components/SettleFooter.tsx):
// someone who owes gets the Settle card's own primary, "Pay <Payer> $X on Venmo" or "I paid <Payer>
// $X in cash", run by lib/useVenmoSend (the same hook as Settle up, F12); after a Venmo send, the
// inline "Did your $X to <Payer> go through?" (Yes / No, undo); contract O's "Did you send…?" when
// the outcome is unknown. Amounts come from server data only (settleViewInputFor), never from
// optimistic claims.
// Groups (docs/specs/2026-11-26-groups-mvp.md T17 part 2, T18 part 2; ADR 0022): lib/useBillGroup
// reads the bill's group on focus. The screen waits for the first answer, so a group bill never
// shows Pay first. On a group bill: "In Tahoe trip" under the title; "Invite people to Tahoe trip"
// (opens the group's invite) instead of the bill's invite card, so no Add people; no Leave bill;
// the footer says "Settled in Tahoe trip" instead of Pay / I paid / Settle up; claims go through
// assign_item (the row's own control and the item sheet's "Who had this?" chips), and the sheet
// shows the server's claimers. GR-T17-17 (money safety): while the group is unknown (the read
// failed, or a write was refused with in_group and it's being checked again), there is no Pay /
// I paid / Settle up, invite card or Leave: "Couldn't check this bill's group. Try again." stands in
// the footer, and claiming stays available. The normal footer shows only once a read says "no group".
// After the bill form's attach failed (lib/scanSession), the host gets "Couldn't add it to Tahoe
// trip. Try again." under the title; Try again attaches and stays busy until the group re-read ends.
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UserPlus from 'lucide-react-native/icons/user-plus';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AvatarPerson } from '@/components/Avatars';
import { BillGroupLine } from '@/components/BillGroupLine';
import { Centered, Loading } from '@/components/Centered';
import { ClaimItemRow } from '@/components/ClaimItemRow';
import { GroupCheckLine } from '@/components/GroupCheckLine';
import { ExtrasSplitControl } from '@/components/ExtrasSplitControl';
import { ItemSheet } from '@/components/ItemSheet';
import { LeaveBill } from '@/components/LeaveBill';
import { NotPartLine } from '@/components/NotPartLine';
import { PayerLine } from '@/components/PayerLine';
import { SettledInGroup } from '@/components/SettledInGroup';
import { SettleFooter } from '@/components/SettleFooter';
import { SharePanel } from '@/components/SharePanel';
import { SharesSummary } from '@/components/SharesSummary';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { useSession } from '@/lib/auth';
import {
  billGroupLine,
  claimMapFor,
  groupBillText,
  inGroupRefusalText,
  type AttachFailure,
  type BillGroupLineModel,
  type BillGroupRef,
} from '@/lib/billGroup';
import {
  applyClaimOverrides,
  applySplitOverrides,
  billTitle,
  DISCOUNTS_HEADING,
  discountRowA11yName,
  initials,
  makeNameOf,
  partsOf,
  rowA11yName,
  rowLabel,
  rowStatus,
  splitInputFor,
} from '@/lib/billView';
import {
  BILL_ERROR_COPY,
  leaveBill,
  rotateJoinCode,
  setClaim,
  setExtrasSplit,
  setItemSplit,
  type BillData,
  type BillError,
  type BillRow,
} from '@/lib/bills';
import { inviteUrl } from '@/lib/inviteLink';
import { canLeave } from '@/lib/membership';
import { leaveBlockedText } from '@/lib/peopleView';
import { cancelSentCheck, notificationPermission } from '@/lib/checkInNotifications';
import { markFeedSeen } from '@/lib/feedSeen';
import { assignItem, attachBillToGroup, GROUP_ERROR_COPY, listMyGroups, type GroupError } from '@/lib/groups';
import { rowsOfBillData } from '@/lib/groupClaimStatus';
import type { NotPartView } from '@/lib/notPartView';
import { formatCents } from '@/lib/money';
import { paidByLine, payersState, type PaidByLine } from '@/lib/payers';
import type { PaymentMethod } from '@/lib/paymentMethods';
import { clearAttachFailure, getAttachFailure } from '@/lib/scanSession';
import {
  readSentCheckBlob,
  sentCheckNotificationId,
  storeSentCheckAnswer,
  withAnswer,
  type SentCheckBlob,
  type SentCheckInline,
} from '@/lib/sentCheck';
import { runSentCheckUndo } from '@/lib/sentCheckUndo';
import {
  billFooterAction,
  openedStillMatches,
  payOpenFailedLine,
  saveRefreshFailed,
  settleFooterAction,
  settleViewInputFor,
  SETTLE_COPY,
  type SettleAction,
  type SettleFooterAction,
} from '@/lib/settleView';
import { displayShares, type ExtrasMode } from '@/lib/split';
import { storage } from '@/lib/storage';
import { backToTabs } from '@/lib/tabsNav';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';
import { knownGroup, useBillGroup } from '@/lib/useBillGroup';
import { useMarkSeen } from '@/lib/useMarkSeen';
import { useNotPart, type UseNotPart } from '@/lib/useNotPart';
import { useSentCheckNow } from '@/lib/useSentCheckNow';
import { PAY_REPEAT_MS, readRememberedMethod, useVenmoSend, type SendContext } from '@/lib/useVenmoSend';
import { isMobileWeb } from '@/lib/webEnv';

const LOAD_ERROR = "Couldn't load the bill.";
const CLAIM_ERROR = "Couldn't save your claim. Try again.";
const SPLIT_ERROR = "Couldn't save the split. Try again.";

type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;
type CheckAction = Extract<SettleAction, { kind: 'sent_check_yes' | 'sent_check_undo' }> & SentCheckInline;

/** Announced on iOS and Android; web reads the footer's live caption instead. */
function announceNative(text: string) {
  if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility(text);
}

export default function BillRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const { session } = useSession();
  const myId = session?.user.id ?? '';
  // A new id is a new screen: no state carries over from another bill.
  return <BillScreen key={id} id={id} myId={myId} />;
}

/** An optimistic claim: shown until a refetch started after the write (`clearAt`) has landed. */
type Pending = { claimed: boolean; clearAt: number | null };
/** An optimistic split (every claimer's parts on one row), cleared the same way. */
type PendingSplit = { parts: Record<string, number>; clearAt: number | null };
/** An optimistic extras split mode (host only), cleared the same way. */
type PendingMode = { mode: ExtrasMode; clearAt: number | null };
/** A new join code from "Make a new link", shown until a refetch that includes it has landed. */
type PendingCode = { code: string; clearAt: number };

/** Drops entries whose confirming refetch (`clearAt`) is now on screen. */
function settled<T extends { clearAt: number | null }>(prev: ReadonlyMap<string, T>, version: number): ReadonlyMap<string, T> {
  const next = new Map([...prev].filter(([, p]) => p.clearAt === null || p.clearAt > version));
  return next.size === prev.size ? prev : next;
}

function without<K, V>(m: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(m);
  next.delete(key);
  return next;
}

function BillScreen({ id, myId }: { id: string; myId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { load, version, finished, refetch, livePaused, edited, dismissEdited } = useBill(id);
  const billGroup = useBillGroup(id);
  const { reload: reloadGroup, recheck: recheckGroup } = billGroup;
  /** The group read failed (or is being checked again after an in_group refusal): no money actions. */
  const groupUnknown = billGroup.read.status === 'failed';
  /** A write refused with in_group (the bill was moved into a group under the screen), until the next action. */
  const [moved, setMoved] = useState<{ afterOpen: boolean } | null>(null);
  /** The bill's group: null for none, undefined while unknown (still loading, or never read). */
  const group = knownGroup(billGroup.read);
  /** The group of a group bill, else null (unknown reads as no group: see the header). */
  const inGroup: BillGroupRef | null = group ?? null;
  // The bill form's failed attach for this bill (GR-T17-10), kept until the bill is in a group.
  const [failure, setFailure] = useState<AttachFailure | null>(() => getAttachFailure(id));
  /** Try again on a failed attach: 'writing', then the group read it waits for; null when idle. */
  const [retrying, setRetrying] = useState<'writing' | number | null>(null);
  const [retryError, setRetryError] = useState<GroupError | null>(null);
  /** The host is in at least one group, so "Move to a group" is worth showing (GR-T17-12). */
  const [canMove, setCanMove] = useState(false);
  const askedGroups = useRef(false);

  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  /** Fixed copy for a failed claim, or null. */
  const [claimError, setClaimError] = useState<string | null>(null);
  const [splits, setSplits] = useState<ReadonlyMap<string, PendingSplit>>(new Map());
  const [sheetRowId, setSheetRowId] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<PendingCode | null>(null);
  const [pendingMode, setPendingMode] = useState<PendingMode | null>(null);
  const [modeError, setModeError] = useState(false);
  /** One footer write at a time across the send hook and the inline check's "No, undo". */
  const writing = useRef(false);
  /** The inline check's "No, undo" is running (it re-reads the bill first). */
  const [checking, setChecking] = useState(false);
  /** A failed or "changed" No, undo: shown under the footer until the next footer action. */
  const [checkError, setCheckError] = useState<string | null>(null);
  // Device facts (D3, D5), read like the Settle page: the remembered Venmo/Cash choice, the check-in
  // answers (re-read on every focus, so an answer given on Settle up shows here), the permission.
  const [remembered, setRemembered] = useState<PaymentMethod | null>(null);
  const [methodRead, setMethodRead] = useState(false);
  const [answers, setAnswers] = useState<SentCheckBlob | null>(null);
  const [permissionUndetermined, setPermissionUndetermined] = useState(false);
  // A phone's browser (read once: the browser doesn't change while the page is open).
  const [mobileWeb] = useState(isMobileWeb);
  /** The inline check in the footer right now: stored 'shown' when the screen loses focus. */
  const checkOnScreen = useRef<CheckAction | null>(null);
  /** Leaving for this bill's own Settle up (Details / Settle up): the question goes along, unanswered. */
  const toSettle = useRef(false);
  /** When the Who paid? page was last pushed from the "Paid by" line (A-50(j)). */
  const lastPayersPushAt = useRef(-Infinity);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The failed attach is over once the bill is in a group by any path.
  useEffect(() => {
    if (inGroup === null || failure === null) return;
    clearAttachFailure(id);
    setFailure(null);
    setRetryError(null);
  }, [inGroup, failure, id]);

  // Try again stays busy until the group read after the attach has ended (landed or failed).
  useEffect(() => {
    if (typeof retrying === 'number' && billGroup.finished >= retrying) setRetrying(null);
  }, [retrying, billGroup.finished]);

  useEffect(() => {
    let live = true;
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

  // D3: the question is "shown" once this screen loses focus with it on screen (navigation, not app
  // background), except on the way to this bill's Settle up, which asks the same question.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      toSettle.current = false;
      void readSentCheckBlob(storage, myId).then((blob) => {
        if (live) setAnswers(blob);
      });
      return () => {
        live = false;
        const c = checkOnScreen.current;
        if (c === null || toSettle.current) return;
        const now = Date.now();
        setAnswers((b) => withAnswer(b ?? {}, c.key, 'shown', now));
        void storeSentCheckAnswer(storage, myId, c.key, 'shown', now);
      };
    }, [myId]),
  );

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
      if (error !== 'in_group') return;
      setMoved({ afterOpen });
      recheckGroup();
    },
  });
  const { openedVenmo, setOpenedVenmo, lastSend } = send;

  const ready = load.status === 'ready';
  useMarkSeen(id, version, ready);
  // Activity's "opened this bill" time (tab-bar spec Contract S, Task 9): on each focus and each new version while ready.
  useFocusEffect(
    useCallback(() => {
      if (ready) void markFeedSeen(myId, 'bill', id);
    }, [ready, version, myId, id]),
  );

  // Drop optimistic claims, splits and codes once fresh data that includes the write is on screen.
  useEffect(() => {
    setPending((prev) => settled(prev, version));
    setSplits((prev) => settled(prev, version));
    setPendingCode((prev) => (prev !== null && prev.clearAt <= version ? null : prev));
    setPendingMode((prev) => (prev !== null && prev.clearAt !== null && prev.clearAt <= version ? null : prev));
  }, [version]);

  // The footer's Settle view input, from server data only (F1, VR-17), plus the device facts.
  const data = load.status === 'ready' ? load.data : null;
  const hostId = data?.bill.host_id ?? null;
  // Group claim status (spec 2026-11-27 T6): "I wasn't part of this" and the unclaimed-row tint,
  // from the server's claims (lib/notPartView.ts); read only on a group bill (lib/useNotPart.ts).
  const serverRows = useMemo(() => (data ? rowsOfBillData(data) : []), [data]);
  const notPart = useNotPart({ billId: id, viewerId: myId, enabled: inGroup !== null, serverRows, onRefused: refetch });
  const notPartShown = notPart.view;
  // One my_groups read, only for the host of a bill in no group (GR-T17-12).
  useEffect(() => {
    if (askedGroups.current || group !== null || hostId === null || hostId !== myId) return;
    askedGroups.current = true;
    void listMyGroups().then((res) => {
      if (mounted.current && res.ok) setCanMove(res.groups.length > 0);
    });
  }, [group, hostId, myId]);

  const myMarkAt = data?.participants.find((p) => p.userId === myId)?.mark?.at ?? null;
  // The inline check's clock moves on its own at the 30-minute mark, on focus and on return (R10).
  const now = useSentCheckNow(myMarkAt);
  const settleInput = useMemo(
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

  // Contract O: "Did you send…?" stays while the payer and the mark still match (as on Settle up).
  useEffect(() => {
    if (settleInput && openedVenmo !== null && !openedStillMatches(settleInput.plan, myId, openedVenmo)) setOpenedVenmo(null);
  }, [settleInput, openedVenmo, myId, setOpenedVenmo]);

  function sendContext(): SendContext {
    return {
      payerName: settleInput ? settleInput.nameOf(settleInput.payerId) : '',
      handle: settleInput?.payerVenmo ?? '',
      markAt: myMarkAt,
    };
  }

  function pay(action: PayAction) {
    // The hook opens (web) or records (native) first, straight from the press; messages clear after.
    send.pay(action, sendContext());
    setCheckError(null);
  }

  function mark(action: MarkAction) {
    setCheckError(null);
    send.mark(action, sendContext());
  }

  // ----- The inline check (D3): the same answers as the Settle card -----

  function onCheck(a: CheckAction) {
    if (a.kind === 'sent_check_yes') {
      // Nothing is written to the server: the answer lives on this device, and the question goes now.
      const now = Date.now();
      setAnswers((b) => withAnswer(b ?? {}, a.key, 'yes', now));
      void storeSentCheckAnswer(storage, myId, a.key, 'yes', now);
      const nid = sentCheckNotificationId(myId, a.billId, a.payerId, a.markAtMs);
      if (nid !== null) void cancelSentCheck(nid);
      setCheckError(null);
      send.clearMessages();
      announceNative(SETTLE_COPY.announceAllSet);
      return;
    }
    void undo(a);
  }

  /** "No, undo": re-read, then the undo rule (A1 F6). A failure keeps the question so it can be tapped again. */
  async function undo(a: CheckAction) {
    if (writing.current) return;
    writing.current = true;
    setChecking(true);
    setCheckError(null);
    send.clearMessages();
    const outcome = await runSentCheckUndo({ billId: a.billId, userId: myId, payerId: a.payerId, cents: a.cents, markAtMs: a.markAtMs });
    if (!mounted.current) return;
    writing.current = false;
    setChecking(false);
    if (outcome.kind === 'failed') {
      setCheckError(outcome.text);
      return;
    }
    if (outcome.kind !== 'noop') setAnswers((b) => withAnswer(b ?? {}, a.key, 'undo', Date.now()));
    if (outcome.kind === 'changed') setCheckError(outcome.text);
    if (outcome.kind === 'unmarked') announceNative(SETTLE_COPY.undoneNotSent);
    // The footer follows the refetch (owes again, or the current mark); the answer already hid the question.
    refetch();
  }

  // The sheet closes when a live refetch removed its row (the host deleted the item).
  const rows = load.status === 'ready' ? load.data.rows : null;
  useEffect(() => {
    if (rows !== null && sheetRowId !== null && !rows.some((r) => r.id === sheetRowId)) {
      setSheetRowId(null);
      setSheetError(null);
    }
  }, [rows, sheetRowId]);

  /** The failed attach's Try again: attach_bill_to_group again (the same group is a no-op success). */
  async function retryAttach(groupId: string) {
    if (retrying !== null) return;
    setRetrying('writing');
    setRetryError(null);
    const res = await attachBillToGroup(id, groupId);
    if (!mounted.current) return;
    if (res.ok) {
      refetch();
      setRetrying(reloadGroup());
      return;
    }
    setRetrying(null);
    setRetryError(res.error);
    // In another group already: the re-read shows which.
    if (res.error === 'already_in_group') reloadGroup();
  }

  async function saveSplit(rowId: string, parts: Record<string, number>) {
    if (splits.get(rowId)?.clearAt === null) return;
    setSheetError(null);
    setSplits((m) => new Map(m).set(rowId, { parts, clearAt: null }));
    const res = await setItemSplit(rowId, parts);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setSplits((m) => (m.get(rowId)?.parts === parts ? new Map(m).set(rowId, { parts, clearAt }) : m));
      return;
    }
    // Roll back, and re-read: the claimer set (or the row itself) may have changed.
    setSplits((m) => without(m, rowId));
    setSheetError(
      res.error === 'claimers_changed' || res.error === 'busy' ? BILL_ERROR_COPY[res.error] : SPLIT_ERROR,
    );
    refetch();
  }

  async function changeExtrasMode(billId: string, mode: ExtrasMode) {
    if (pendingMode?.clearAt === null) return;
    // A prior change may still be waiting for its refetch; a failure goes back to it, not to null.
    const previous = pendingMode;
    setModeError(false);
    setPendingMode({ mode, clearAt: null });
    const res = await setExtrasSplit(billId, mode);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setPendingMode((p) => (p?.mode === mode ? { mode, clearAt } : p));
      return;
    }
    // Roll back to what was shown before this change (the server's mode, or a saved one in transit).
    setPendingMode((p) => (p?.mode === mode && p.clearAt === null ? previous : p));
    setModeError(true);
  }

  async function rotate(billId: string): Promise<boolean> {
    const res = await rotateJoinCode(billId);
    if (!mounted.current) return false;
    if (!res.ok) return false;
    setPendingCode({ code: res.joinCode, clearAt: refetch() });
    return true;
  }

  async function toggle(rowId: string, claimed: boolean) {
    if (inFlight.has(rowId)) return;
    // A group bill's row waits for the refetch after its write: the next write's p_expected is the map then shown.
    if (inGroup !== null && pending.has(rowId)) return;
    setClaimError(null);
    setInFlight((s) => new Set(s).add(rowId));
    setPending((m) => new Map(m).set(rowId, { claimed, clearAt: null }));
    if (inGroup !== null && load.status === 'ready') {
      // One way to claim on a group bill (T18, GR-T18-12): the whole map through assign_item, with
      // the server's map as p_expected.
      const shown = partsOf(load.data.claims, rowId);
      const res = await assignItem(rowId, claimMapFor(shown, myId, claimed), shown);
      if (!mounted.current) return;
      setInFlight((s) => {
        const next = new Set(s);
        next.delete(rowId);
        return next;
      });
      if (res.ok) {
        const clearAt = refetch();
        setPending((m) => (m.get(rowId)?.claimed === claimed ? new Map(m).set(rowId, { claimed, clearAt }) : m));
        return;
      }
      setPending((m) => without(m, rowId));
      setClaimError(res.error === 'claims_changed' ? GROUP_ERROR_COPY.claims_changed : CLAIM_ERROR);
      if (res.error === 'claims_changed' || res.error === 'not_allowed') refetch();
      return;
    }
    const res = await setClaim(rowId, claimed);
    if (!mounted.current) return;
    setInFlight((s) => {
      const next = new Set(s);
      next.delete(rowId);
      return next;
    });
    if (res.ok) {
      const clearAt = refetch();
      setPending((m) => (m.get(rowId)?.claimed === claimed ? new Map(m).set(rowId, { claimed, clearAt }) : m));
    } else {
      setPending((m) => without(m, rowId));
      // busy (a lock clash aborted it, delete-group A3.4): nothing saved; the row is tappable again.
      setClaimError(res.error === 'busy' ? BILL_ERROR_COPY.busy : CLAIM_ERROR);
      // The row is gone (the host deleted it): re-read so it leaves the list.
      if (res.error === 'not_found') refetch();
    }
  }

  async function leave(billId: string): Promise<BillError | null> {
    const res = await leaveBill(billId);
    if (!mounted.current) return null;
    if (res.ok) {
      // Off the bill: RLS hides it now, so home is the only place to go.
      router.replace('/');
      return null;
    }
    if (res.error !== 'network') refetch();
    if (res.error === 'in_group') recheckGroup();
    return res.error;
  }

  // The bar is there in every state; Home and Activity only on the loaded bill, where they always were.
  const header = <BackHeader title="Bill" />;
  // The footer waits for the two device reads (each has a time limit), so Pay never turns into Cash.
  // ...and for the first group read, so a group bill never shows Pay before it says "Settled in".
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
        <Button label="Go home" variant="primary" onPress={() => router.replace('/')} />
      </Centered>
    );
  }
  if (load.status === 'error') {
    return (
      <Centered>
        {header}
        <Text style={[type.body, styles.centerText, { color: colors.text }]}>{LOAD_ERROR}</Text>
        <Button
          label="Try again"
          variant="primary"
          onPress={() => {
            refetch();
            reloadGroup();
          }}
        />
      </Centered>
    );
  }

  // Several people paid: settleFooterAction gives the routes footer (A1.5 U7: owing 2+ people, a
  // primary "Settle up" with "You owe 2 people · $X"; one pair, that pair's Pay or cash footer).
  const footerAction: SettleFooterAction | null = !settleInput
    ? null
    : settleFooterAction({ ...settleInput, openedVenmo }, load.data.participants.length);
  // The question on screen (billFooterAction passes sent_check through unchanged): "shown" on blur.
  // A group bill shows no footer question (it's settled in the group).
  checkOnScreen.current =
    inGroup === null && !groupUnknown && footerAction?.kind === 'sent_check' && isCheck(footerAction.yes.action) ? footerAction.yes.action : null;
  return (
    <BillView
      data={load.data}
      myId={myId}
      pending={pending}
      splits={splits}
      pendingMode={pendingMode}
      modeError={modeError}
      joinCode={pendingCode?.code ?? load.data.bill.join_code}
      sheetRowId={sheetRowId}
      sheetError={sheetError}
      inFlight={inFlight}
      claimError={claimError}
      livePaused={livePaused}
      edited={edited}
      insets={insets}
      group={inGroup}
      groupUnknown={groupUnknown}
      checkingGroup={billGroup.reading}
      onCheckGroup={() => {
        reloadGroup();
      }}
      movedNotice={moved === null ? null : inGroupRefusalText(inGroup?.name ?? null, moved.afterOpen)}
      groupLine={billGroupLine({ billId: id, group, isHost: load.data.bill.host_id === myId, canMove, failure, retryError })}
      retryingAttach={retrying !== null}
      onOpenGroup={(groupId) => router.push(`/groups/${groupId}`)}
      onManageGroup={() => router.push(`/bills/${id}/group`)}
      onRetryAttach={(groupId) => void retryAttach(groupId)}
      onInviteToGroup={(groupId) => router.push(`/groups/${groupId}?invite=1`)}
      version={version}
      finished={finished}
      refetch={refetch}
      onToggle={(rowId, claimed) => void toggle(rowId, claimed)}
      onOpenSheet={(rowId) => {
        setSheetError(null);
        setSheetRowId(rowId);
      }}
      onCloseSheet={() => {
        setSheetRowId(null);
        setSheetError(null);
      }}
      onSaveSplit={(rowId, parts) => void saveSplit(rowId, parts)}
      onRotate={() => rotate(load.data.bill.id)}
      onChangeExtrasMode={(mode) => void changeExtrasMode(load.data.bill.id, mode)}
      onDismissEdited={dismissEdited}
      onRefresh={() => refetch()}
      onHome={() => backToTabs(router)}
      onEdit={() => router.push(`/bills/${id}/edit`)}
      onWhoPaid={() => {
        // A-50(j), review R8: a double tap pushes Who paid? once (Settle's guard, PAY_REPEAT_MS).
        const now = Date.now();
        if (now - lastPayersPushAt.current < PAY_REPEAT_MS) return;
        lastPayersPushAt.current = now;
        router.push(`/bills/${id}/payers`);
      }}
      onActivity={() => router.push(`/bills/${id}/activity`)}
      onSettle={() => {
        toSettle.current = true;
        router.push(`/bills/${id}/settle`);
      }}
      onAddPeople={() => router.push(`/bills/${id}/people`)}
      onLeave={() => leave(load.data.bill.id)}
      footer={footerAction}
      marking={send.busy !== null}
      checking={checking}
      footerError={send.error ?? checkError ?? (settleInput ? payOpenFailedLine(settleInput, send.openFailure) : null)}
      // Review R1: a saved change whose refetch failed keeps Pay waiting; say so and offer a retry.
      refreshFailed={saveRefreshFailed(
        [...pending.values(), ...splits.values(), ...(pendingMode ? [pendingMode] : [])].map((p) => p.clearAt),
        version,
        finished,
      )}
      paymentHeld={send.held}
      onRetryPayment={send.retryRefresh}
      onPay={pay}
      onMark={mark}
      onCheck={onCheck}
      onNotYet={() => {
        setOpenedVenmo(null);
        setCheckError(null);
        send.clearMessages();
      }}
      notPart={{ view: notPartShown, state: notPart }}
    />
  );
}

type ViewProps = {
  data: BillData;
  myId: string;
  pending: ReadonlyMap<string, Pending>;
  splits: ReadonlyMap<string, PendingSplit>;
  pendingMode: PendingMode | null;
  modeError: boolean;
  joinCode: string;
  sheetRowId: string | null;
  sheetError: string | null;
  inFlight: ReadonlySet<string>;
  claimError: string | null;
  livePaused: boolean;
  edited: boolean;
  insets: { top: number; bottom: number };
  /** The bill's group (T17), or null for a bill in no group (or one whose group couldn't be read). */
  group: BillGroupRef | null;
  /** GR-T17-17: the group couldn't be read (yet); no pay, mark, invite or leave controls. */
  groupUnknown: boolean;
  checkingGroup: boolean;
  onCheckGroup: () => void;
  /** An in_group refusal's line (lib/billGroup.ts inGroupRefusalText), or null. */
  movedNotice: string | null;
  groupLine: BillGroupLineModel;
  retryingAttach: boolean;
  onOpenGroup: (groupId: string) => void;
  onManageGroup: () => void;
  onRetryAttach: (groupId: string) => void;
  onInviteToGroup: (groupId: string) => void;
  /** useBill's numbered refetch, for the item sheet's assign_item writes on a group bill (T18). */
  version: number;
  finished: number;
  refetch: () => number;
  onToggle: (rowId: string, claimed: boolean) => void;
  onOpenSheet: (rowId: string) => void;
  onCloseSheet: () => void;
  onSaveSplit: (rowId: string, parts: Record<string, number>) => void;
  onRotate: () => Promise<boolean>;
  onChangeExtrasMode: (mode: ExtrasMode) => void;
  onDismissEdited: () => void;
  onRefresh: () => void;
  onHome: () => void;
  onEdit: () => void;
  /** The host's "Paid by … · Change" line: open the Who paid page (who-paid Task 9). */
  onWhoPaid: () => void;
  onActivity: () => void;
  onSettle: () => void;
  onAddPeople: () => void;
  onLeave: () => Promise<BillError | null>;
  /** The footer from server data (settleFooterAction); the view adjusts only "left to claim" (VR-I6). */
  footer: SettleFooterAction | null;
  /** A send or mark from the footer is in flight (until the refetch that includes it has finished). */
  marking: boolean;
  /** The inline check's "No, undo" is running. */
  checking: boolean;
  footerError: string | null;
  refreshFailed: boolean;
  /** QA N3: a payment saved whose refetch failed; the footer says so and holds Pay. */
  paymentHeld: 'failed' | 'retrying' | null;
  onRetryPayment: () => void;
  onPay: (action: PayAction) => void;
  onMark: (action: MarkAction) => void;
  onCheck: (action: CheckAction) => void;
  onNotYet: () => void;
  /** Group claim status (T6): the tint and the "I wasn't part of this" line, and the write behind it. */
  notPart: { view: NotPartView; state: UseNotPart };
};

function isCheck(a: SettleAction): a is CheckAction {
  return a.kind === 'sent_check_yes' || a.kind === 'sent_check_undo';
}

function BillView(props: ViewProps) {
  const { data, myId, pending, splits, pendingMode, inFlight, insets, group, groupUnknown } = props;
  const { colors } = useTheme();
  const isHost = data.bill.host_id === myId;
  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);
  const groupText = group !== null ? groupBillText(group.name) : null;
  // "Paid by …" under the total (who-paid D6 / A1.5, Task 9). Null if the stored payer rows don't read.
  const payerLine = useMemo((): PaidByLine | null => {
    try {
      const state = payersState({ payerId: data.bill.payer_id, rows: data.payers, totalCents: data.bill.total_cents });
      return paidByLine({ state, viewerId: myId, hostId: data.bill.host_id, joinOrder: data.participants.map((p) => p.userId), nameOf });
    } catch {
      return null;
    }
  }, [data.bill.payer_id, data.payers, data.bill.total_cents, data.bill.host_id, data.participants, myId, nameOf]);

  const { shares, claims } = useMemo(() => {
    const overrides = new Map([...pending].map(([rowId, p]) => [rowId, p.claimed]));
    const withClaims = applyClaimOverrides(data.claims, overrides, myId);
    const effective = applySplitOverrides(withClaims, new Map([...splits].map(([rowId, p]) => [rowId, p.parts])));
    // A mode being saved shows its numbers at once (optimistic); a failure rolls it back.
    const bill = pendingMode ? { ...data.bill, extras_split: pendingMode.mode } : data.bill;
    const input = splitInputFor({ ...data, bill }, effective);
    // One pass of the split math: displayShares also returns the per-row splits.
    return { shares: displayShares(input), claims: effective };
  }, [data, pending, splits, pendingMode, myId]);

  // A split being saved reads as set by the viewer until the server's row arrives.
  const shownRows = useMemo(
    (): BillRow[] => data.rows.map((r) => (splits.has(r.id) ? { ...r, split_set_by: myId } : r)),
    [data.rows, splits, myId],
  );

  // Items first, then claimable discounts (C1: the DB doesn't require that order; the screen does).
  const itemRows = useMemo(() => shownRows.filter((r) => r.kind !== 'discount'), [shownRows]);
  const discountRows = useMemo(() => shownRows.filter((r) => r.kind === 'discount'), [shownRows]);

  /** The row's claimers, the viewer first. */
  const claimersOf = (rowId: string): string[] =>
    Object.keys(shares.items[rowId]?.byUser ?? {}).sort((a, b) => (a === myId ? -1 : b === myId ? 1 : 0));

  /**
   * R6: the viewer is a claimer for split purposes only once that is known to the server: while a
   * claim toggle on the row is still in flight, the server's claims decide; once it succeeded (and
   * waits for its refetch), the optimistic value does.
   */
  const iHaveSettledClaim = (rowId: string): boolean => {
    const p = pending.get(rowId);
    if (p && p.clearAt !== null) return p.claimed;
    return data.claims.some((c) => c.line_item_id === rowId && c.user_id === myId);
  };

  const url = useMemo(() => {
    try {
      return inviteUrl(props.joinCode);
    } catch {
      return null; // fetchBill validated the code; never build a link from anything else.
    }
  }, [props.joinCode]);

  const avatarFor = useMemo(() => {
    const names = new Map(data.participants.map((p) => [p.userId, p.displayName]));
    return (userId: string): AvatarPerson => ({
      userId,
      name: nameOf(userId),
      initials: initials(names.get(userId) ?? null),
      isMe: userId === myId,
    });
  }, [data.participants, nameOf, myId]);

  // M3 brief §7 + request spec F1: the bill's next step, next to the person's share. "N left to claim"
  // follows this screen's optimistic counts (VR-I6); Pay amounts come from server data only.
  const footer = billFooterAction(props.footer, shares.unclaimedRows, shares.unclaimedDiscountRows);
  // VR-17: Pay and "I paid" wait while the viewer's own claim, split or extras change is saving.
  const waitForSave = pending.size > 0 || splits.size > 0 || pendingMode !== null;

  function renderRow(row: BillRow, previous: BillRow | undefined) {
    const isDiscount = row.kind === 'discount';
    const split = shares.items[row.id];
    const claimerIds = claimersOf(row.id);
    const claimed = claimerIds.includes(myId);
    // A hairline between groups only, so units of one item read as one block.
    const newGroup = previous !== undefined && previous.group_position !== row.group_position;
    return (
      <View key={row.id} style={newGroup && [styles.divider, { borderTopColor: colors.divider }]}>
        <ClaimItemRow
          label={rowLabel(row)}
          a11yName={isDiscount ? discountRowA11yName(row.name) : rowA11yName(row)}
          priceCents={row.total_cents}
          status={rowStatus(split, row, myId, nameOf)}
          claimers={claimerIds.map(avatarFor)}
          claimed={claimed}
          // A group bill's row also waits for the refetch after its write (see toggle).
          busy={inFlight.has(row.id) || (group !== null && pending.has(row.id))}
          kind={isDiscount ? 'discount' : 'item'}
          // C5: nobody's yet, as displayed (a tap on Claim clears it at once), on a group bill I haven't opted out of.
          highlight={props.notPart.view.tintUnclaimed && claimerIds.length === 0}
          onToggle={() => props.onToggle(row.id, !claimed)}
          onOpenDetails={() => props.onOpenSheet(row.id)}
        />
      </View>
    );
  }

  // P8: while the host is alone on the bill, inviting people is their next step, so the invite
  // block comes before the items; once anyone has joined it moves below them. One keyed list, so
  // React moves SharePanel rather than remounting it: an open "Make a new link" confirm, "Link
  // copied" or a contact pick survives the first guest joining (review R1).
  const inviteFirst = isHost && data.participants.length === 1;
  // A group bill's people come from the group (T17): its invite instead of the bill's, and no Add people.
  const shareBlock =
    group !== null && groupText !== null ? (
      <View key="share" style={styles.inviteLink}>
        <TextLink
          label={groupText.invite}
          icon={UserPlus}
          accessibilityHint={groupText.inviteHint}
          onPress={() => props.onInviteToGroup(group.groupId)}
        />
      </View>
    ) : url !== null && !groupUnknown ? (
      <SharePanel
        key="share"
        url={url}
        isHost={isHost}
        onRotate={props.onRotate}
        onAddPeople={isHost ? props.onAddPeople : undefined}
      />
    ) : null;
  const itemsBlock = (
    <Card key="items" style={styles.list}>
      {itemRows.map((row, i) => renderRow(row, itemRows[i - 1]))}
    </Card>
  );
  const discountsBlock =
    discountRows.length > 0 ? (
      <View key="discounts" style={styles.section}>
        <SectionHeader title={DISCOUNTS_HEADING} />
        <Card style={styles.list}>{discountRows.map((row, i) => renderRow(row, discountRows[i - 1]))}</Card>
      </View>
    ) : null;
  const np = props.notPart.state;
  const notPartBlock = (
    <NotPartLine
      key="notPart"
      line={props.notPart.view.line}
      busy={np.busy}
      error={np.error}
      refreshFailed={np.refreshFailed}
      refreshing={np.reading}
      onSet={np.set}
      onRefresh={np.retry}
    />
  );
  const blocks = inviteFirst
    ? [shareBlock, itemsBlock, discountsBlock, notPartBlock]
    : [itemsBlock, discountsBlock, notPartBlock, shareBlock];

  const sheetRow = props.sheetRowId === null ? undefined : shownRows.find((r) => r.id === props.sheetRowId);
  // A group bill's sheet shows the server's claims only (T18): its chips send that map as
  // p_expected, so the people listed and their amounts must be the same map, never an optimistic one.
  const sheetShares = useMemo(
    () => (group !== null && sheetRow !== undefined ? displayShares(splitInputFor(data, data.claims)) : shares),
    [group, sheetRow, data, shares],
  );
  const sheetClaims = group !== null ? data.claims : claims;
  const sheetParts = sheetRow ? partsOf(sheetClaims, sheetRow.id) : {};
  const sheetClaimerIds = (rowId: string): string[] =>
    Object.keys(sheetShares.items[rowId]?.byUser ?? {}).sort((a, b) => (a === myId ? -1 : b === myId ? 1 : 0));

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <BackHeader
        title={billTitle(data.bill.host_id, myId, nameOf)}
        back={{ label: 'Home', accessibilityLabel: 'Home', onPress: props.onHome }}
        right={
          <Button
            label="Activity"
            accessibilityLabel="Activity"
            accessibilityHint="Shows who joined, claimed and changed what"
            variant="ghost"
            onPress={props.onActivity}
            flush
          />
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: space.md }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>

          <View style={styles.header}>
            <Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>
              {billTitle(data.bill.host_id, myId, nameOf)}
            </Text>
            <BillGroupLine
              model={props.groupLine}
              onOpenGroup={props.onOpenGroup}
              onManage={props.onManageGroup}
              onRetry={props.onRetryAttach}
              retrying={props.retryingAttach}
            />
            <Text style={[type.body, { color: colors.textMuted }]}>Total {formatCents(data.bill.total_cents)}</Text>
            <PayerLine line={payerLine} onPress={props.onWhoPaid} />
            {isHost ? (
              <Button
                label="Edit items"
                variant="ghost"
                accessibilityHint="Change items, prices or amounts"
                onPress={props.onEdit}
                flush
              />
            ) : null}
          </View>

          {props.edited && !isHost ? (
            <Banner tone="info">
              <View style={styles.noticeRow}>
                <View style={styles.grow}>
                  <BannerText>{`${nameOf(data.bill.host_id)} updated the bill. Shares were recalculated.`}</BannerText>
                </View>
                <Button label="Dismiss" variant="ghost" onPress={props.onDismissEdited} flush />
              </View>
            </Banner>
          ) : null}

          {props.livePaused ? (
            <View style={styles.liveRow}>
              <Text style={[type.caption, styles.grow, { color: colors.textMuted }]}>Live updates paused</Text>
              <Button label="Refresh" variant="ghost" onPress={props.onRefresh} flush />
            </View>
          ) : null}

          {blocks}
          {/* A group bill's people are the group's (the database refuses it too: in_group). */}
          {!isHost && group === null && !groupUnknown ? (
            <LeaveBill canLeave={canLeave(data, myId)} blockedText={leaveBlockedText(data, myId)} onLeave={props.onLeave} />
          ) : null}
        </View>
      </ScrollView>

      {/* Sticky footer: your share stays in reach while you claim. */}
      <View
        style={[
          styles.footer,
          { backgroundColor: colors.surface, borderTopColor: colors.divider, paddingBottom: insets.bottom + space.md },
        ]}
      >
        <View style={[styles.column, styles.footerColumn]}>
          {/* One compact line, not a full Banner: the footer stays short on small phones (V13). */}
          {props.claimError !== null ? <StatusLine text={props.claimError} tone="error" size="caption" alert /> : null}
          <SharesSummary
            shares={shares}
            myId={myId}
            nameOf={nameOf}
            extrasControl={
              <ExtrasSplitControl
                mode={shares.mode}
                isHost={isHost}
                saving={pendingMode?.clearAt === null}
                error={props.modeError}
                onChange={props.onChangeExtrasMode}
              />
            }
          />
          {groupUnknown ? (
            <GroupCheckLine onRetry={props.onCheckGroup} checking={props.checkingGroup} notice={props.movedNotice} />
          ) : group !== null ? (
            <>
              {props.movedNotice !== null ? <StatusLine text={props.movedNotice} tone="error" size="caption" alert /> : null}
              <SettledInGroup groupName={group.name} variant="footer" onOpenGroup={() => props.onOpenGroup(group.groupId)} />
              {/* A saved claim whose refetch failed keeps that row waiting; say so, as on any bill (review R1). */}
              {props.refreshFailed ? (
                <View style={styles.liveRow}>
                  <Text accessibilityRole="alert" style={[type.caption, styles.grow, { color: colors.textMuted }]}>
                    {SETTLE_COPY.refreshFailed}
                  </Text>
                  <Button
                    label={SETTLE_COPY.refresh}
                    accessibilityLabel={SETTLE_COPY.refresh}
                    accessibilityHint={SETTLE_COPY.refreshHint}
                    variant="ghost"
                    onPress={props.onRefresh}
                    flush
                  />
                </View>
              ) : null}
            </>
          ) : footer !== null ? (
            <SettleFooter
              action={footer}
              waitForSave={waitForSave}
              marking={props.marking}
              error={props.footerError}
              refreshFailed={props.refreshFailed}
              onRefresh={props.onRefresh}
              paymentHeld={props.paymentHeld}
              onRetryPayment={props.onRetryPayment}
              onPay={props.onPay}
              onMark={props.onMark}
              onCheck={(a) => {
                if (isCheck(a)) props.onCheck(a);
              }}
              checking={props.checking}
              onNotYet={props.onNotYet}
              onSettle={props.onSettle}
            />
          ) : null}
        </View>
      </View>

      {sheetRow ? (
        <ItemSheet
          key={sheetRow.id}
          label={rowLabel(sheetRow)}
          kind={sheetRow.kind === 'discount' ? 'discount' : 'item'}
          priceCents={sheetRow.total_cents}
          status={rowStatus(sheetShares.items[sheetRow.id], sheetRow, myId, nameOf)}
          claimers={sheetClaimerIds(sheetRow.id).map((userId) => ({
            person: avatarFor(userId),
            cents: sheetShares.items[sheetRow.id]?.byUser[userId] ?? 0,
            parts: sheetParts[userId] ?? 1,
          }))}
          canEdit={iHaveSettledClaim(sheetRow.id)}
          custom={sheetShares.items[sheetRow.id]?.custom ?? false}
          saving={splits.get(sheetRow.id)?.clearAt === null}
          error={props.sheetError}
          onSave={(parts) => props.onSaveSplit(sheetRow.id, parts)}
          onClose={props.onCloseSheet}
          // T18: on a group bill, "Who had this?" for every member (every member is on every group
          // bill, so the participants are the members) and the server's map as p_expected.
          assign={
            group !== null
              ? {
                  lineItemId: sheetRow.id,
                  members: data.participants.map((p) => avatarFor(p.userId)),
                  current: partsOf(data.claims, sheetRow.id),
                  refetch: props.refetch,
                  version: props.version,
                  finished: props.finished,
                }
              : undefined
          }
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xl },
  column: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: space.xl },
  header: { gap: space.xs },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  grow: { flex: 1, minWidth: 0 },
  list: { paddingVertical: space.xs, gap: 0 },
  section: { gap: space.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth },
  centerText: { textAlign: 'center', maxWidth: layout.message },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md, paddingHorizontal: space.lg },
  footerColumn: { gap: space.sm },
  inviteLink: { alignItems: 'flex-start' },
});
