// Native capture: camera permission, then the system camera (spec: Task 7 flow, moved here in A3 / Task 9).
import { launchCameraAsync, requestCameraPermissionsAsync } from 'expo-image-picker';

import type { CaptureResult } from './capturePhoto';
import { permissionState } from './cameraPermission';

export type { CaptureResult } from './capturePhoto';

export const CAPTURE_LABEL: string = 'Take photo';
// Was "Type it instead"; the two choices are equal now (spec 2026-11-25 scan screen redesign).
export const MANUAL_ENTRY_LABEL: string = 'Enter items';

export async function capturePhoto(): Promise<CaptureResult> {
  const state = permissionState(await requestCameraPermissionsAsync());
  if (state !== 'granted') return { kind: 'permission', state };
  const result = await launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  const uri = result.canceled ? undefined : result.assets[0]?.uri;
  return uri ? { kind: 'photo', uri } : { kind: 'cancelled' };
}
