// Hands the parsed receipt from the scan screen to the bill form, in memory only.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 6).
//
// Receipt data is never put in route params or URLs: on web those land in browser
// history and server logs. A reload loses it, which is expected until M1b adds saving.
import type { ParsedReceipt } from './receiptTypes';

let current: ParsedReceipt | null = null;

export function setScanResult(r: ParsedReceipt): void {
  current = r;
}

export function getScanResult(): ParsedReceipt | null {
  return current;
}

export function clearScanResult(): void {
  current = null;
}
