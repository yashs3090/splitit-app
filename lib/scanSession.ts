// Hands the parsed receipt from the scan screen to the bill form, in memory only.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 6).
//
// Receipt data is never put in route params or URLs: on web those land in browser
// history and server logs. A reload loses it, which is expected until M1b adds saving.
//
// Groups (docs/specs/2026-11-26-groups-mvp.md T17, GR-6): "Add, then Receipt" on a group screen
// stores which group the new bill goes in (`setScanGroup`), kept apart from the scan result because
// Scan and Home clear the result before every new draft while the person is still in the group's
// flow. The bill form reads it once, attaches the bill right after create_bill, and clears it. The
// group screen clears it whenever it's shown again (the flow was left) or closes. If the attach
// fails, the form leaves an AttachFailure for the bill screen (`getAttachFailure`), which shows
// "Couldn't add it to Tahoe trip. Try again." with a retry. Both are per-user and cleared on
// sign-out (clearGroupReceipt, from lib/signOut.ts).
import type { AttachFailure, BillGroupRef } from './billGroup';
import type { ParsedReceipt } from './receiptTypes';

let current: ParsedReceipt | null = null;
let group: BillGroupRef | null = null;
let failure: AttachFailure | null = null;

export function setScanResult(r: ParsedReceipt): void {
  current = r;
}

export function getScanResult(): ParsedReceipt | null {
  return current;
}

export function clearScanResult(): void {
  current = null;
}

/** The group a receipt started from a group screen goes into. */
export function setScanGroup(g: BillGroupRef): void {
  group = { groupId: g.groupId, name: g.name };
}

export function getScanGroup(): BillGroupRef | null {
  return group;
}

export function clearScanGroup(): void {
  group = null;
}

/** The bill form's attach after create_bill failed; the bill screen picks it up for that bill. */
export function setAttachFailure(f: AttachFailure): void {
  failure = { billId: f.billId, groupId: f.groupId, groupName: f.groupName };
}

/** The failure for this bill (null for any other bill). It stays until cleared, so a remount still shows it. */
export function getAttachFailure(billId: string): AttachFailure | null {
  return failure !== null && failure.billId === billId ? failure : null;
}

/** After a successful retry, or once the bill is in a group by any path. */
export function clearAttachFailure(billId: string): void {
  if (failure !== null && failure.billId === billId) failure = null;
}

/** Sign-out: the stored group and any failed attach belong to the person signing out. */
export function clearGroupReceipt(): void {
  group = null;
  failure = null;
}
