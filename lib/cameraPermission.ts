// Camera permission state for the scan screen (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 7).
// Pure, so every branch is unit-tested without a device.

export type CameraPermissionState = 'granted' | 'ask' | 'blocked';

/**
 * - `granted`: open the camera.
 * - `ask`: denied, but the OS will show its prompt again ("Try again").
 * - `blocked`: denied for good; only the Settings app can turn it back on ("Open Settings").
 */
export function permissionState(resp: { granted: boolean; canAskAgain: boolean }): CameraPermissionState {
  if (resp.granted) return 'granted';
  return resp.canAskAgain ? 'ask' : 'blocked';
}
