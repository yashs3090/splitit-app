// Who can be removed from a bill, and who can leave it: rule L3 in
// docs/specs/2026-11-24-people-and-invites.md § D2, as extended for several payers and the payments
// ledger by docs/specs/2026-11-26-who-paid.md (A1.3 `private.is_removable`, A1.4 table L; eng
// review B7). Pure.
//
// The database enforces L3 in remove_participant and leave_bill (through private.is_removable).
// This file mirrors it only to decide which buttons show; the server stays the authority (a claim or
// payment made after the screen loaded makes the call fail with cannot_remove / cannot_leave, and the
// screen refetches). The two must be the same rule: boundary table L (L1–L7) is tested on both sides
// (lib/membership.test.ts and Task 4b's who_paid.test.sql, criterion A-17).
import type { BillData } from './bills';

/** The facts rule L3 reads, and nothing else. */
export type RemovableFacts = {
  hostId: string;
  /** bills.payer_id: the one payer, or the split's lead. */
  payerId: string;
  /** The bill_payers user ids: empty in one-person mode, 2+ in split mode. */
  payerIds: readonly string[];
  participantIds: readonly string[];
  /** The user_id of every claim on the bill (items and claimable discounts). */
  claimUserIds: readonly string[];
  /** Every bill_payments entry (only who, to whom and how much matter here). */
  payments: readonly { fromId: string; toId: string; cents: number }[];
};

/**
 * L3 (who-paid A1.3): `targetId` is a participant, isn't the host, isn't a payer (payer_id or any
 * bill_payers row), has no claims, and **every pair involving them has net 0** (Σ sent to X − Σ
 * received from X = 0 for every X; WP-36: someone fully paid back may leave). Not-received flags
 * don't block. So removing or leaving never changes anyone's money.
 */
export function isRemovable(facts: RemovableFacts, targetId: string): boolean {
  if (!facts.participantIds.includes(targetId)) return false;
  if (targetId === facts.hostId || targetId === facts.payerId) return false;
  if (facts.payerIds.includes(targetId)) return false;
  if (facts.claimUserIds.includes(targetId)) return false;
  const netWith = new Map<string, number>();
  for (const p of facts.payments) {
    if (p.fromId === targetId) netWith.set(p.toId, (netWith.get(p.toId) ?? 0) + p.cents);
    else if (p.toId === targetId) netWith.set(p.fromId, (netWith.get(p.fromId) ?? 0) - p.cents);
  }
  for (const net of netWith.values()) if (net !== 0) return false;
  return true;
}

function factsOf(data: BillData): RemovableFacts {
  return {
    hostId: data.bill.host_id,
    payerId: data.bill.payer_id,
    payerIds: data.payers.map((p) => p.userId),
    participantIds: data.participants.map((p) => p.userId),
    claimUserIds: data.claims.map((c) => c.user_id),
    payments: data.payments,
  };
}

/** Whether `viewerId` sees "Remove" next to `targetId`: only the host, and only when L3 holds. */
export function canRemove(data: BillData, viewerId: string, targetId: string): boolean {
  return viewerId === data.bill.host_id && isRemovable(factsOf(data), targetId);
}

/** Whether `viewerId` sees "Leave this bill": L3 for themself (so never the host or a payer). */
export function canLeave(data: BillData, viewerId: string): boolean {
  return isRemovable(factsOf(data), viewerId);
}
