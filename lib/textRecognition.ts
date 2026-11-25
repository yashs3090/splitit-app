// Contract for text recognition (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 2 and A3/Task 9).
//
// This file is for TypeScript only. At runtime Metro and Jest resolve `@/lib/textRecognition` to
// `textRecognition.native.ts` (iOS/Android, wraps expo-mlkit-ocr) or `textRecognition.web.ts`
// (Tesseract.js in the browser, loaded lazily). Both platform files annotate their exports with
// the types below and re-export the same `RecognitionError`, so they stay in sync with this file.
// Same pattern as `lib/storage.d.ts`.
import type { RecognizedText } from './receiptTypes';

export { RecognitionError, type RecognitionErrorCode } from './recognitionError';

/**
 * What the scan is doing right now, for the scan screen's status text.
 * - `preparing`: the scan pipeline is getting the photo ready (locate, crop, resize, enhance).
 * - `loading_engine` / `recognizing`: reported by the recognizer (web: the first run downloads the reader).
 * - `retrying`: the pipeline's automatic second try (spec 2026-11-22 C3); reported instead of
 *   `preparing`/`recognizing` during that attempt.
 * A recognizer on its own only ever reports `loading_engine` and `recognizing`.
 */
export type RecognitionStage = 'preparing' | 'loading_engine' | 'recognizing' | 'retrying';

export type RecognizeOptions = {
  /** Fraction 0–1 of the recognition step. Only engines that report progress call it (web). */
  onProgress?: (fraction: number) => void;
  /** Called when the engine starts loading (web: first run downloads the reader) and when reading starts. */
  onStage?: (stage: RecognitionStage) => void;
  /** Aborting rejects with `RecognitionError('cancelled')` and stops the engine where it can. */
  signal?: AbortSignal;
};

export type TextRecognizer = {
  /** Native: false when the module isn't in this build (e.g. Expo Go). Web: false without Worker/WebAssembly. */
  isAvailable(): boolean;
  /** Reads text from a local image (`file://` on native, `blob:`/`data:` on web). Rejects only with `RecognitionError`. */
  recognize(imageUri: string, opts?: RecognizeOptions): Promise<RecognizedText>;
};

export declare const textRecognizer: TextRecognizer;
