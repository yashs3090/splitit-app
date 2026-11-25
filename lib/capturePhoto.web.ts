// Web capture: the browser's image file picker (spec: A3 decision 1 / Task 9). On phones the
// browser's own sheet offers "Take Photo / Photo Library / Choose File"; desktop shows a file
// chooser. There is no permission step: a file input doesn't use the camera API.
// The picked file stays in the browser as a blob: URL; nothing is uploaded.
// This file must never import the native file-system package (criterion 55 greps for it).
import { launchImageLibraryAsync } from 'expo-image-picker';

import type { CaptureResult } from './capturePhoto';

export type { CaptureResult } from './capturePhoto';

export const CAPTURE_LABEL: string = 'Take or upload photo';
export const MANUAL_ENTRY_LABEL: string = 'Enter items';

export async function capturePhoto(): Promise<CaptureResult> {
  const result = await launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  const uri = result.canceled ? undefined : result.assets?.[0]?.uri;
  return uri ? { kind: 'photo', uri } : { kind: 'cancelled' };
}
