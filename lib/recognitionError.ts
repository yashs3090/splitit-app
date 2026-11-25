// The one error type text recognition throws (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 2).
//
// It lives in its own file, not in `textRecognition.ts`, because Metro and Jest resolve
// `./textRecognition` to `textRecognition.native.ts` / `textRecognition.web.ts`. A class defined in
// the base file would never load at runtime, and a platform file importing it from
// `./textRecognition` would import itself.

export type RecognitionErrorCode =
  | 'unavailable'
  | 'image_load_failed'
  | 'failed'
  /** The caller's AbortSignal fired; the engine was stopped (A3). */
  | 'cancelled'
  /** The web text reader (worker, core or language data) couldn't be downloaded or started (A3). */
  | 'engine_load_failed'
  /**
   * The web text reader started reading but didn't finish within `RECOGNIZE_TIMEOUT_MS`
   * (lib/webOcrSession.ts); its worker was terminated. Not retried automatically.
   */
  | 'timeout';

// Fixed messages only: never the library's message, which can include the file path.
const MESSAGES: Record<RecognitionErrorCode, string> = {
  unavailable: 'Text recognition is not available on this device.',
  image_load_failed: 'The photo could not be loaded for text recognition.',
  failed: 'Text recognition failed.',
  cancelled: 'Text recognition was cancelled.',
  engine_load_failed: 'The text reader could not be loaded.',
  timeout: 'Text recognition took too long.',
};

export class RecognitionError extends Error {
  readonly code: RecognitionErrorCode;
  /** The native library's error code (e.g. `IMAGE_LOAD_FAILED`), for debugging. Never shown to users. */
  readonly nativeCode: string | undefined;

  constructor(code: RecognitionErrorCode, nativeCode?: string) {
    super(MESSAGES[code]);
    this.name = 'RecognitionError';
    this.code = code;
    this.nativeCode = nativeCode;
  }
}
