// Who can be removed from a bill, and who can leave it: rule L3 in
// docs/specs/2026-11-24-people-and-invites.md § D2. Pure.
//
// The database enforces L3 in remove_participant and leave_bill. This file mirrors it only to
// decide which buttons show; the server stays the authority (a claim made after the screen
// loaded makes the call fail with cannot_remove / cannot_leave, and the screen refetches).
import type { BillData } from './bills';

/**
 * L3: `targetId` is a participant, isn't the host, isn't the payer, has no claims on the bill and
 * hasn't marked "I paid". So removing or leaving never changes anyone's money.
 */
function removable(data: BillData, targetId: string): boolean {
  const participant = data.participants.find((p) => p.userId === targetId);
  if (!participant) return false;
  if (targetId === data.bill.host_id || targetId === data.bill.payer_id) return false;
  if (participant.mark !== null) return false;
  return !data.claims.some((c) => c.user_id === targetId);
}

/** Whether `viewerId` sees "Remove" next to `targetId`: only the host, and only when L3 holds. */
export function canRemove(data: BillData, viewerId: string, targetId: string): boolean {
  return viewerId === data.bill.host_id && removable(data, targetId);
}

/** Whether `viewerId` sees "Leave this bill": L3 for themself (so never the host or the payer). */
export function canLeave(data: BillData, viewerId: string): boolean {
  return removable(data, viewerId);
}
