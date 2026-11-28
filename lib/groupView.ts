// The group screen's view model (spec docs/specs/2026-11-26-groups-mvp.md T10, as amended by A1:
// S1 waiting notice, S2 isSettledUp, S5 memoized balances, S9 named waiting rows). Pure: no I/O.
//
// One source for every status on the group screens (lesson 2026-11-25 "Parts of one screen worked
// out the same status separately"): the status line, waiting lines, cost rows and the Settle model
// (lib/groupSettleView.ts) all read groupMath(snapshot). Screens do no money arithmetic.

import type { NameOf } from './billView';
import { billNeedsViewer, rowsOfSnapshotBill, snapshotBillNeedsViewer } from './groupClaimStatus';
import { groupBalances, netsOf, type GroupBalances, type WaitingBill } from './groupBalance';
import { balanceInputOf, type GroupSnapshot } from './groups';
import { formatCents } from './money';
import { footerIncomplete, SETTLE_ALL_ZERO_GUEST_COPY } from './settleView';
import { isSettledUp, simplify, type Simplified } from './simplify';
import { computeShares } from './split';

// ---------------------------------------------------------------------------------------------
// The math, once per snapshot (A1.7, S5).

export type GroupMath = {
  balances: GroupBalances;
  /** simplify(nets): `shown` is what the Settle screen lists (C-G3). */
  suggestions: Simplified;
  /** Per counting bill: user id → that person's computeShares total. Waiting bills are absent. */
  billShares: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

// Keyed on the snapshot object: each fetch parses a new one, so a refetch recomputes and a re-render
// of the same data doesn't. A WeakMap lets old snapshots be collected.
const memo = new WeakMap<GroupSnapshot, GroupMath>();

/** Balances, suggestions and per-bill shares for one snapshot, computed once. Throws RangeError on a broken snapshot (fetchGroupSnapshot already refuses those). */
export function groupMath(snapshot: GroupSnapshot): GroupMath {
  const hit = memo.get(snapshot);
  if (hit) return hit;
  const input = balanceInputOf(snapshot);
  const balances = groupBalances(input);
  const counting = new Set(balances.counting);
  const billShares = new Map<string, ReadonlyMap<string, number>>();
  for (const b of input.bills) {
    if (!counting.has(b.id)) continue;
    billShares.set(b.id, new Map(computeShares(b.split).people.map((p) => [p.userId, p.totalCents])));
  }
  const math: GroupMath = { balances, suggestions: simplify(netsOf(balances)), billShares };
  memo.set(snapshot, math);
  return math;
}

/** The viewer's net, or 0 when the viewer isn't in the snapshot (GR-T10-3). */
export function viewerNet(snapshot: GroupSnapshot, viewerId: string): number {
  return groupMath(snapshot).balances.members.find((m) => m.userId === viewerId)?.netCents ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Status line (C-G3 step 5: isSettledUp is the one predicate).

export type StatusKind = 'owed' | 'owes' | 'settled';
export type StatusLine = { kind: StatusKind; text: string; /** The big number, or null when settled up. */ amountCents: number | null };

export const GROUP_COPY = {
  settledUp: "You're settled up",
  owed: (cents: number) => `You're owed ${formatCents(cents)}`,
  owe: (cents: number) => `You owe ${formatCents(cents)}`,
  yourReceipt: 'Your receipt',
  receiptOf: (name: string) => `${name}'s receipt`,
  hostAllZero: 'every item is $0. Fix the prices in Edit items.',
  notice: (label: string, reason: string) => `Balances don't include ${label} yet: ${reason}`,
  paid: (name: string, cents: number) => `${name} paid ${formatCents(cents)}`,
  share: (cents: number) => `you ${formatCents(cents)}`,
  shareWaiting: 'you —',
  shareA11y: (cents: number) => `Your share ${formatCents(cents)}`,
  shareWaitingA11y: "Your share isn't counted until everything is claimed",
} as const;

export function statusLine(netCents: number): StatusLine {
  if (isSettledUp(netCents)) return { kind: 'settled', text: GROUP_COPY.settledUp, amountCents: null };
  if (netCents > 0) return { kind: 'owed', text: GROUP_COPY.owed(netCents), amountCents: netCents };
  return { kind: 'owes', text: GROUP_COPY.owe(-netCents), amountCents: -netCents };
}

// ---------------------------------------------------------------------------------------------
// Waiting receipts (C-G1, A1 S1 + S9).

/** "Your receipt" for the viewer's own, "Ana's receipt" otherwise (bills have no title, GR-30). */
export function receiptLabel(hostId: string, viewerId: string, nameOf: NameOf): string {
  return hostId === viewerId ? GROUP_COPY.yourReceipt : GROUP_COPY.receiptOf(nameOf(hostId));
}

/** Mid-sentence form of the label: "your receipt" / "Ana's receipt". */
function labelInSentence(hostId: string, viewerId: string, nameOf: NameOf): string {
  return hostId === viewerId ? 'your receipt' : GROUP_COPY.receiptOf(nameOf(hostId));
}

/** The 1–2 unclaimed rows' names, or null when they can't be named cleanly (blank, repeated, 3+). */
function namedRows(w: WaitingBill, snapshot: GroupSnapshot): string | null {
  const ids = w.unclaimedRowIds;
  if (ids.length < 1 || ids.length > 2) return null;
  const rows = snapshot.bills.find((b) => b.id === w.billId)?.rows ?? [];
  const names = ids.map((id) => rows.find((r) => r.id === id)?.name?.replace(/\s+/gu, ' ').trim() ?? '');
  if (names.some((n) => n === '')) return null;
  // Unit rows share a name ("Beer", "Beer"): "Beer and Beer" reads wrong, so count instead (GR-T10-2).
  if (new Set(names).size !== names.length) return null;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? null);
}

/** Why a receipt is waiting, after the label: "Nachos left to claim", "2 items left to claim", the all-$0 copy. */
export function waitingReasonText(w: WaitingBill, snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): string {
  const hostId = snapshot.bills.find((b) => b.id === w.billId)?.hostId ?? null;
  if (w.reason === 'all_zero') {
    return hostId === viewerId ? GROUP_COPY.hostAllZero : SETTLE_ALL_ZERO_GUEST_COPY(nameOf(hostId));
  }
  const named = namedRows(w, snapshot);
  if (named !== null) return `${named} left to claim`;
  return footerIncomplete(w.unclaimedRows, w.unclaimedDiscountRows);
}

export type WaitingLine = {
  /** The bill the line links to (S9). */
  billId: string;
  reason: WaitingBill['reason'];
  /** The group screen's line: "Ana's receipt: Nachos left to claim". */
  text: string;
  /** The Settle notice: "Balances don't include Ana's receipt yet: Nachos left to claim" (S1). */
  notice: string;
  /** The receipt waits on me (group claim status C1): tinted, with "I wasn't part of this". */
  needsMe: boolean;
  /**
   * I said "I wasn't part of this" (it's in `me.notPartBillIds`) and hold no claim on it, so the row
   * offers Undo. Claims win (C1): a stale opt-out next to a claim of mine reads as neither.
   */
  notPart: boolean;
};

/**
 * The waiting lines in the snapshot's waiting order. Settle up's notices use this order as it is;
 * the group screen puts the needs-me lines first (needsMeFirst, GCS-9 is the group screen's only).
 */
export function waitingLines(snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): WaitingLine[] {
  const lines = groupMath(snapshot).balances.waiting.map((w): WaitingLine => {
    const bill = snapshot.bills.find((b) => b.id === w.billId);
    const hostId = bill?.hostId ?? '';
    const reason = waitingReasonText(w, snapshot, viewerId, nameOf);
    const optedOut = snapshot.me.notPartBillIds.includes(w.billId);
    const rows = bill === undefined ? [] : rowsOfSnapshotBill(bill);
    const claimedByMe = rows.some((r) => r.claimerIds.includes(viewerId));
    return {
      billId: w.billId,
      reason: w.reason,
      text: `${receiptLabel(hostId, viewerId, nameOf)}: ${reason}`,
      notice: GROUP_COPY.notice(labelInSentence(hostId, viewerId, nameOf), reason),
      needsMe: billNeedsViewer(rows, viewerId, optedOut),
      notPart: optedOut && !claimedByMe,
    };
  });
  return lines;
}

/** The group screen's order (GCS-9): needs-me lines first; each part keeps the order it came in. */
export function needsMeFirst(lines: readonly WaitingLine[]): WaitingLine[] {
  return [...lines.filter((l) => l.needsMe), ...lines.filter((l) => !l.needsMe)];
}

/**
 * Review R4: the lines in a previous order (bill ids), so a row doesn't jump away from the person
 * who just tapped "I wasn't part of this" on it. Lines not in `previous` follow, in their own order;
 * ids no longer waiting drop out. `previous` null: the lines as they are.
 */
export function keepOrder<T extends Pick<WaitingLine, 'billId'>>(lines: readonly T[], previous: readonly string[] | null): T[] {
  if (previous === null) return [...lines];
  const rank = new Map(previous.map((id, i) => [id, i]));
  const known = lines.filter((l) => rank.has(l.billId)).sort((a, b) => (rank.get(a.billId) ?? 0) - (rank.get(b.billId) ?? 0));
  return [...known, ...lines.filter((l) => !rank.has(l.billId))];
}

// ---------------------------------------------------------------------------------------------
// Costs list.

export type CostRow = {
  id: string;
  kind: 'bill' | 'expense';
  /** Set for a bill (the row links to it). */
  billId: string | null;
  title: string;
  payerId: string;
  amountCents: number;
  /** "Ana paid $77.33" / "You paid $77.33". */
  paidLine: string;
  /** "you $30.08", "you $0.00", or "you —" while the receipt is waiting. */
  shareLine: string;
  shareA11y: string;
  /** null while waiting. */
  viewerShareCents: number | null;
  waiting: boolean;
  /** A bill that waits on me (group claim status C1): tinted, caption gains "Claim your items". Never for an expense. */
  needsMe: boolean;
  createdAt: string;
};

/** Newest first; ties by id, higher first (deterministic). */
function newestFirst(a: CostRow, b: CostRow): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function costRows(snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): CostRow[] {
  const math = groupMath(snapshot);
  const share = (cents: number | null) => ({
    shareLine: cents === null ? GROUP_COPY.shareWaiting : GROUP_COPY.share(cents),
    shareA11y: cents === null ? GROUP_COPY.shareWaitingA11y : GROUP_COPY.shareA11y(cents),
    viewerShareCents: cents,
    waiting: cents === null,
  });
  const bills: CostRow[] = snapshot.bills.map((b) => {
    const shares = math.billShares.get(b.id);
    return {
      id: b.id,
      kind: 'bill',
      billId: b.id,
      title: receiptLabel(b.hostId, viewerId, nameOf),
      payerId: b.payerId,
      amountCents: b.totalCents,
      paidLine: GROUP_COPY.paid(nameOf(b.payerId), b.totalCents),
      ...share(shares === undefined ? null : (shares.get(viewerId) ?? 0)),
      needsMe: snapshotBillNeedsViewer(snapshot, b, viewerId),
      createdAt: b.createdAt,
    };
  });
  const expenses: CostRow[] = snapshot.expenses.map((e) => ({
    id: e.id,
    kind: 'expense',
    billId: null,
    title: e.title,
    payerId: e.payerId,
    amountCents: e.amountCents,
    paidLine: GROUP_COPY.paid(nameOf(e.payerId), e.amountCents),
    ...share(e.shares.find((s) => s.userId === viewerId)?.cents ?? 0),
    needsMe: false,
    createdAt: e.createdAt,
  }));
  return [...bills, ...expenses].sort(newestFirst);
}

// ---------------------------------------------------------------------------------------------
// Leaving (C-G10 mirror; advisory, the DB decides).

/**
 * Whether to offer Leave. Reads only what the snapshot carries (live rows), so the DB may still
 * refuse (deleted expenses and undone payments count there). $0 expense shares don't count (N3).
 */
export function canLeaveGroup(snapshot: GroupSnapshot, viewerId: string): boolean {
  if (!snapshot.members.some((m) => m.userId === viewerId)) return false;
  if (snapshot.members.length <= 1) return false;
  for (const b of snapshot.bills) {
    if (b.hostId === viewerId || b.payerId === viewerId) return false;
    if (b.rows.some((r) => Object.prototype.hasOwnProperty.call(r.claims, viewerId))) return false;
  }
  for (const e of snapshot.expenses) {
    if (e.payerId === viewerId || e.createdBy === viewerId) return false;
    if (e.shares.some((s) => s.userId === viewerId && s.cents > 0)) return false;
  }
  for (const p of snapshot.payments) {
    if (p.from === viewerId || p.to === viewerId || p.recordedBy === viewerId) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Deleting (docs/specs/2026-11-28-delete-group.md contract S; advisory, the DB re-checks W and F).

export type DeleteBlock = 'receipts_waiting' | 'not_settled';
export type DeleteCheck = { ok: true } | { ok: false; reason: DeleteBlock };

/**
 * Whether anyone may delete the group now (contract S). About every member, not the viewer:
 * 1. any receipt waiting (contract W, `groupMath(...).balances.waiting`) → receipts_waiting. First,
 *    because a waiting receipt counts as $0, so the nets can look settled while it waits;
 * 2. any member's net fails isSettledUp (within GROUP_IGNORE_CENTS, GR-3) → not_settled;
 * 3. else ok.
 * Reads groupMath only: no arithmetic of its own, no SQL copy of the balances (ADR 0022 §4). The
 * database checks the waiting rule with the same cases (private.group_bill_waiting) and the
 * fingerprint, but can't check balances, so this gate is the protection (A2.7).
 */
export function canDeleteGroup(snapshot: GroupSnapshot): DeleteCheck {
  const { balances } = groupMath(snapshot);
  if (balances.waiting.length > 0) return { ok: false, reason: 'receipts_waiting' };
  if (!Object.values(netsOf(balances)).every(isSettledUp)) return { ok: false, reason: 'not_settled' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The screen.

export type GroupScreenModel = {
  name: string;
  memberCount: number;
  status: StatusLine;
  /** Only when any receipt is waiting (S9: each links to its bill). */
  waiting: WaitingLine[];
  costs: CostRow[];
  canLeave: boolean;
  /** Delete group contract S: whether the Delete row is enabled, and if not, why. */
  canDelete: DeleteCheck;
};

export function groupScreen(snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): GroupScreenModel {
  return {
    name: snapshot.group.name,
    memberCount: snapshot.members.length,
    status: statusLine(viewerNet(snapshot, viewerId)),
    waiting: needsMeFirst(waitingLines(snapshot, viewerId, nameOf)),
    costs: costRows(snapshot, viewerId, nameOf),
    canLeave: canLeaveGroup(snapshot, viewerId),
    canDelete: canDeleteGroup(snapshot),
  };
}

