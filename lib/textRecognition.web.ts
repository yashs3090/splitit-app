// Web text recognition (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, A3 / Task 9), using
// Tesseract.js in the browser. Provisional: the receipt eval may replace it.
//
// - The engine (`lib/webOcrEngine.ts` + the library) is loaded only inside `recognize`, via
//   `import()`, so it is a separate lazy chunk and never part of the initial web bundle (52–53).
//   The engine module holds the asset base URL (self-hosted under /tesseract), the settings and
//   the result mapping.
// - One worker per call, always terminated afterwards (success, error or cancel). The worker
//   lifecycle lives in `lib/webOcrSession.ts`, shared with the web scan pipeline (which keeps one
//   worker for a whole multi-pass scan).
// - The image never leaves the browser. Privacy: no console calls; only a progress number leaves
//   the engine's logger.
// This file must never import the native OCR or file-system packages (criteria 5 and 55 grep for them).
import type { RecognizedText } from './receiptTypes';
import type { RecognizeOptions, TextRecognizer } from './textRecognition';
import { createOcrSession } from './webOcrSession';

export { RecognitionError, type RecognitionErrorCode } from './recognitionError';
export type { RecognitionStage, RecognizeOptions, TextRecognizer } from './textRecognition';
// The engine-loading test seam lives with the shared worker session; re-exported (same object).
export { engineLoader } from './webOcrSession';

export const textRecognizer: TextRecognizer = {
  isAvailable() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
  },

  /** One read in its own worker session: started, used once, and always terminated afterwards. */
  async recognize(imageUri: string, opts: RecognizeOptions = {}): Promise<RecognizedText> {
    const session = createOcrSession();
    try {
      return await session.read(imageUri, opts);
    } finally {
      session.close();
    }
  },
};
