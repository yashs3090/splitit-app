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
// Bill markers (docs/specs/2026-11-24-bill-markers-and-notices.md, Task 6, D6): the first load that
// comes back ready marks the bill seen, once per visit, which clears its "New" marker on Home.
// Pay from the footer (docs/specs/2026-11-25-venmo-request-buttons.md, F1–F4, Task 5): someone who
// owes gets "Pay <Payer> $X on Venmo" in the footer (components/SettleFooter.tsx), then "Did you
// pay?". Its amount comes from server data only (settleViewInputFor), never from optimistic claims.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AvatarPerson } from '@/components/Avatars';
import { Centered, Loading } from '@/components/Centered';
import { ClaimItemRow } from '@/components/ClaimItemRow';
import { ExtrasSplitControl } from '@/components/ExtrasSplitControl';
import { ItemSheet } from '@/components/ItemSheet';
import { LeaveBill } from '@/components/LeaveBill';
import { SettleFooter } from '@/components/SettleFooter';
import { SharePanel } from '@/components/SharePanel';
import { SharesSummary } from '@/components/SharesSummary';
import { BackHeader } from '@/components/ui/BackHeader';
import { Banner, BannerText } from '@/components/ui/Banner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { StatusLine } from '@/components/ui/StatusLine';
import { useSession } from '@/lib/auth';
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
  markBillSeen,
  markPaid,
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
import { formatCents } from '@/lib/money';
import { openPaymentLink } from '@/lib/paylinks';
import {
  actionError,
  billFooterAction,
  openedStillMatches,
  payOpenFailedLine,
  saveRefreshFailed,
  settleFooterAction,
  settleViewInputFor,
  SETTLE_COPY,
  type OpenedVenmo,
  type PayOpenFailure,
  type SettleAction,
  type SettleFooterAction,
} from '@/lib/settleView';
import { displayShares, type ExtrasMode } from '@/lib/split';
import { layout, space, type, useTheme } from '@/lib/theme';
import { useBill } from '@/lib/useBill';

const LOAD_ERROR = "Couldn't load the bill.";
const CLAIM_ERROR = "Couldn't save your claim. Try again.";
const SPLIT_ERROR = "Couldn't save the split. Try again.";
/** Pay taps closer together than this are one tap (same rule as the Settle page, M3 R7). */
const PAY_REPEAT_MS = 1000;

type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;

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

  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(new Set());
  const [claimError, setClaimError] = useState(false);
  const [splits, setSplits] = useState<ReadonlyMap<string, PendingSplit>>(new Map());
  const [sheetRowId, setSheetRowId] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<PendingCode | null>(null);
  const [pendingMode, setPendingMode] = useState<PendingMode | null>(null);
  const [modeError, setModeError] = useState(false);
  // Pay from the footer (F2): what was opened in Venmo (screen state only, never a mark), the
  // "I paid" write (its `clearAt` refetch must finish before the button is released), and the line
  // under the footer.
  const [openedVenmo, setOpenedVenmo] = useState<OpenedVenmo | null>(null);
  const [marking, setMarking] = useState<{ clearAt: number | null } | null>(null);
  /** A failed "I paid" (its own reason). */
  const [footerError, setFooterError] = useState<string | null>(null);
  /** A Pay link that didn't open: shown only while it still describes the bill (review R2). */
  const [payFailure, setPayFailure] = useState<PayOpenFailure | null>(null);
  const lastPayAt = useRef(-Infinity);
  const markWriting = useRef(false);
  const iMarked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // D6: once per mount, after the first load that comes back ready (never for not_found or error).
  // Later refetches (live hints, focus, foreground) don't repeat it. Fire and forget: the answer is
  // ignored, so a failure, a slow answer or one after unmount changes nothing on screen.
  const markedSeen = useRef(false);
  const ready = load.status === 'ready';
  useEffect(() => {
    if (!ready || markedSeen.current) return;
    markedSeen.current = true;
    void markBillSeen(id);
  }, [ready, id]);

  // Drop optimistic claims, splits and codes once fresh data that includes the write is on screen.
  useEffect(() => {
    setPending((prev) => settled(prev, version));
    setSplits((prev) => settled(prev, version));
    setPendingCode((prev) => (prev !== null && prev.clearAt <= version ? null : prev));
    setPendingMode((prev) => (prev !== null && prev.clearAt !== null && prev.clearAt <= version ? null : prev));
  }, [version]);

  // Release "I paid" once the refetch after it has finished: landed (`version`) or failed (`finished`),
  // the same rule as the Settle page.
  useEffect(() => {
    setMarking((m) => {
      if (m === null || m.clearAt === null || (version < m.clearAt && finished < m.clearAt)) return m;
      markWriting.current = false;
      return null;
    });
  }, [version, finished]);

  // The footer's Settle view input, from server data only (F1, VR-17).
  const data = load.status === 'ready' ? load.data : null;
  const settleInput = useMemo(() => (data ? settleViewInputFor(data, myId, Platform.OS, null) : null), [data, myId]);

  // On each new version of the data: drop a "Did you pay?" that no longer matches the payer or the
  // amount (as on Settle), or that a mark has answered; announce the viewer's own mark on iOS.
  useEffect(() => {
    if (!data || !settleInput) return;
    if (settleInput.viewerMarked) {
      setOpenedVenmo(null);
      if (iMarked.current) {
        iMarked.current = false;
        // VoiceOver ignores live regions; Android and web read the "Marked paid" caption.
        if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SETTLE_COPY.announceMarked);
      }
      return;
    }
    setOpenedVenmo((o) => (o !== null && !openedStillMatches(settleInput.plan, myId, o) ? null : o));
  }, [data, settleInput, myId]);

  function pay(action: PayAction) {
    const now = Date.now();
    if (now - lastPayAt.current < PAY_REPEAT_MS) return;
    lastPayAt.current = now;
    const opening = openPaymentLink(action.url); // first call once the tap goes through; no await before it (web popup rule)
    const handle = settleInput?.payerVenmo ?? '';
    setOpenedVenmo({ payerId: action.payerId, cents: action.cents });
    setFooterError(null);
    setPayFailure(null);
    void opening.then((res) => {
      if (!res.ok && mounted.current) setPayFailure({ payerId: action.payerId, cents: action.cents, handle });
    });
  }

  async function mark(action: MarkAction) {
    if (markWriting.current) return;
    markWriting.current = true;
    iMarked.current = true;
    setMarking({ clearAt: null });
    setFooterError(null);
    setPayFailure(null);
    const res = await markPaid(id, action.payerId, action.cents);
    if (!mounted.current) return;
    if (res.ok) {
      const clearAt = refetch();
      setMarking({ clearAt });
      return;
    }
    iMarked.current = false;
    markWriting.current = false;
    setMarking(null);
    const err = actionError(res.error);
    setFooterError(err.text);
    if (err.refetch) refetch();
  }

  // The sheet closes when a live refetch removed its row (the host deleted the item).
  const rows = load.status === 'ready' ? load.data.rows : null;
  useEffect(() => {
    if (rows !== null && sheetRowId !== null && !rows.some((r) => r.id === sheetRowId)) {
      setSheetRowId(null);
      setSheetError(null);
    }
  }, [rows, sheetRowId]);

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
    setSheetError(res.error === 'claimers_changed' ? BILL_ERROR_COPY.claimers_changed : SPLIT_ERROR);
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
    setClaimError(false);
    setInFlight((s) => new Set(s).add(rowId));
    setPending((m) => new Map(m).set(rowId, { claimed, clearAt: null }));
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
      setClaimError(true);
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
    return res.error;
  }

  // The bar is there in every state; Home and Activity only on the loaded bill, where they always were.
  const header = <BackHeader title="Bill" />;
  if (load.status === 'loading') {
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
        <Button label="Try again" variant="primary" onPress={() => refetch()} />
      </Centered>
    );
  }

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
      onHome={() => router.navigate('/')}
      onEdit={() => router.push(`/bills/${id}/edit`)}
      onActivity={() => router.push(`/bills/${id}/activity`)}
      onSettle={() => router.push(`/bills/${id}/settle`)}
      onAddPeople={() => router.push(`/bills/${id}/people`)}
      onLeave={() => leave(load.data.bill.id)}
      footer={
        settleInput ? settleFooterAction({ ...settleInput, openedVenmo }, load.data.participants.length) : null
      }
      marking={marking !== null}
      footerError={footerError ?? (settleInput ? payOpenFailedLine(settleInput, payFailure) : null)}
      // Review R1: a saved change whose refetch failed keeps Pay waiting; say so and offer a retry.
      refreshFailed={saveRefreshFailed(
        [...pending.values(), ...splits.values(), ...(pendingMode ? [pendingMode] : [])].map((p) => p.clearAt),
        version,
        finished,
      )}
      onPay={pay}
      onMark={(action) => void mark(action)}
      onNotYet={() => {
        setOpenedVenmo(null);
        setFooterError(null);
        setPayFailure(null);
      }}
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
  claimError: boolean;
  livePaused: boolean;
  edited: boolean;
  insets: { top: number; bottom: number };
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
  onActivity: () => void;
  onSettle: () => void;
  onAddPeople: () => void;
  onLeave: () => Promise<BillError | null>;
  /** The footer from server data (settleFooterAction); the view adjusts only "left to claim" (VR-I6). */
  footer: SettleFooterAction | null;
  marking: boolean;
  footerError: string | null;
  refreshFailed: boolean;
  onPay: (action: PayAction) => void;
  onMark: (action: MarkAction) => void;
  onNotYet: () => void;
};

function BillView(props: ViewProps) {
  const { data, myId, pending, splits, pendingMode, inFlight, insets } = props;
  const { colors } = useTheme();
  const isHost = data.bill.host_id === myId;
  const nameOf = useMemo(() => makeNameOf(data.participants, myId), [data.participants, myId]);

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
          busy={inFlight.has(row.id)}
          kind={isDiscount ? 'discount' : 'item'}
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
  const shareBlock =
    url !== null ? (
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
  const blocks = inviteFirst ? [shareBlock, itemsBlock, discountsBlock] : [itemsBlock, discountsBlock, shareBlock];

  const sheetRow = props.sheetRowId === null ? undefined : shownRows.find((r) => r.id === props.sheetRowId);
  const sheetParts = sheetRow ? partsOf(claims, sheetRow.id) : {};

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
            <Text style={[type.body, { color: colors.textMuted }]}>Total {formatCents(data.bill.total_cents)}</Text>
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
          {!isHost ? <LeaveBill canLeave={canLeave(data, myId)} onLeave={props.onLeave} /> : null}
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
          {props.claimError ? <StatusLine text={CLAIM_ERROR} tone="error" size="caption" alert /> : null}
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
          {footer !== null ? (
            <SettleFooter
              action={footer}
              waitForSave={waitForSave}
              marking={props.marking}
              error={props.footerError}
              refreshFailed={props.refreshFailed}
              onRefresh={props.onRefresh}
              onPay={props.onPay}
              onMark={props.onMark}
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
          status={rowStatus(shares.items[sheetRow.id], sheetRow, myId, nameOf)}
          claimers={claimersOf(sheetRow.id).map((userId) => ({
            person: avatarFor(userId),
            cents: shares.items[sheetRow.id]?.byUser[userId] ?? 0,
            parts: sheetParts[userId] ?? 1,
          }))}
          canEdit={iHaveSettledClaim(sheetRow.id)}
          custom={shares.items[sheetRow.id]?.custom ?? false}
          saving={splits.get(sheetRow.id)?.clearAt === null}
          error={props.sheetError}
          onSave={(parts) => props.onSaveSplit(sheetRow.id, parts)}
          onClose={props.onCloseSheet}
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
});
