// Type-only entry for `./capturePhoto` (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, A3 / Task 9).
// Metro and Jest resolve `capturePhoto.native.ts` (camera permission + system camera) or
// `capturePhoto.web.ts` (the browser's file picker, which on phones also offers the camera).
// TypeScript resolves this file. Same pattern as `lib/textRecognition.ts`.

export type CaptureResult =
  | { kind: 'photo'; uri: string }
  | { kind: 'cancelled' }
  | { kind: 'permission'; state: 'ask' | 'blocked' };

/** Gets one receipt photo. Rejects only if the camera/picker itself fails. */
export declare function capturePhoto(): Promise<CaptureResult>;

/** The scan button's label on this platform. */
export declare const CAPTURE_LABEL: string;

/** The manual-entry choice's label next to it: "Enter items" on both platforms (spec 2026-11-25). */
export declare const MANUAL_ENTRY_LABEL: string;
