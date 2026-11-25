// iOS/Android text recognition via expo-mlkit-ocr 0.2.7 (Apple Vision on iOS with
// `iosEngine: "vision"` in app.json, ML Kit v2 on Android).
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 2.
//
// The library is loaded lazily: its entry calls `requireNativeModule('ExpoMlkitOcr')` at import time,
// which throws in a build without the native code (e.g. Expo Go). Loading it on first use lets
// `isAvailable()` return false there, so the scan screen falls back to the manual form instead of
// the whole app crashing at startup.
import type { RecognitionResult } from 'expo-mlkit-ocr';

import type { Box, RecognizedLine, RecognizedText } from './receiptTypes';
import { RecognitionError, type RecognitionErrorCode } from './recognitionError';
import type { TextRecognizer } from './textRecognition';

export { RecognitionError, type RecognitionErrorCode } from './recognitionError';
export type { TextRecognizer } from './textRecognition';

type OcrLibrary = Pick<typeof import('expo-mlkit-ocr'), 'recognizeText' | 'isSupported'>;

let loaded: OcrLibrary | null | undefined;

function loadLibrary(): OcrLibrary | null {
  if (loaded === undefined) {
    try {
      loaded = require('expo-mlkit-ocr') as OcrLibrary;
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

/** Test hook: forget the cached library so the next call loads it again. */
export function resetLibraryCacheForTests(): void {
  loaded = undefined;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Android returns `{}` for a line without a box; treat anything incomplete as "no box".
function toBox(raw: unknown): Box | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y, width, height } = raw as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return undefined;
  }
  return { x, y, width, height };
}

/** Flattens `blocks[].lines[]` into lines, in the order the library returned them. Pure. */
export function mapOcrResult(result: RecognitionResult): RecognizedText {
  const lines: RecognizedLine[] = [];
  for (const block of result.blocks ?? []) {
    for (const line of block.lines ?? []) {
      if (typeof line.text !== 'string') continue;
      const box = toBox(line.boundingBox);
      lines.push(box ? { text: line.text, box } : { text: line.text });
    }
  }
  return { lines };
}

// Codes from the installed native source: iOS `ExpoMlkitOcrModule.swift` rejects with
// INVALID_URI, IMAGE_LOAD_FAILED or RECOGNITION_FAILED; Android with NO_CONTEXT,
// IMAGE_LOAD_FAILED or RECOGNITION_FAILED.
const IMAGE_LOAD_CODES = new Set(['IMAGE_LOAD_FAILED', 'INVALID_URI']);

/** Maps a library rejection to a `RecognitionError` code. Pure. */
export function mapOcrError(error: unknown): RecognitionError {
  const nativeCode =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  const code: RecognitionErrorCode = nativeCode && IMAGE_LOAD_CODES.has(nativeCode) ? 'image_load_failed' : 'failed';
  return new RecognitionError(code, nativeCode);
}

export const textRecognizer: TextRecognizer = {
  isAvailable() {
    const lib = loadLibrary();
    if (!lib) return false;
    try {
      return lib.isSupported();
    } catch {
      return false;
    }
  },

  async recognize(imageUri) {
    const lib = loadLibrary();
    if (!lib) throw new RecognitionError('unavailable');
    let result: RecognitionResult;
    try {
      result = await lib.recognizeText(imageUri);
    } catch (e) {
      throw mapOcrError(e);
    }
    try {
      return mapOcrResult(result);
    } catch {
      throw new RecognitionError('failed', 'MALFORMED_RESULT');
    }
  },
};
