// Native (iOS/Android) stage set (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 and Task 3).
// Identity stubs until the native spec: locate → none, crop → identity, enhance → identity,
// normalizeScale → today's `prepareForRecognition`, recognize → today's on-device recognizer.
// So a native scan makes exactly today's prepare → recognize calls.
//
// RN-free: the platform pieces are injected by `lib/scanReceipt.native.ts` (criterion 15).
import type { PreparedImage } from '../../imageSize';
import type { TextRecognizer } from '../../textRecognition';
import { medianLineHeight } from '../textHeight';
import { asImg, type StageSet } from '../types';

export type NativeStageDeps = {
  prepareForRecognition(uri: string): Promise<PreparedImage>;
  deleteTempImages(uris: readonly (string | null | undefined)[]): Promise<void>;
  recognizer: Pick<TextRecognizer, 'recognize'>;
};

export function createNativeStages(deps: NativeStageDeps): StageSet {
  return {
    async locateDocument() {
      return { method: 'none', quad: null, confidence: 0 };
    },
    async cropAndFlatten(img) {
      return img;
    },
    async normalizeScale(img, { firstPass }) {
      // No text-height second pass on native yet (Task 8 is web; the native spec decides).
      if (firstPass !== null) return null;
      const prepared = await deps.prepareForRecognition(img);
      // Today's prepare step doesn't report the input size, so the factor isn't known here.
      return { img: asImg(prepared.uri), scale: null };
    },
    async enhance(img) {
      return img;
    },
    async recognize(img, _config, ctx) {
      const text = await deps.recognizer.recognize(img, {
        signal: ctx.signal,
        onStage: ctx.onStage,
        onProgress: ctx.onProgress,
      });
      // Reported for the trace and a future native second pass; nothing on native reads it yet.
      return { text, medianLineHeight: medianLineHeight(text), meanLineConfidence: null };
    },
    async dispose(imgs) {
      try {
        await deps.deleteTempImages(imgs);
      } catch {
        // Never throws: a leftover cache file is harmless.
      }
    },
  };
}
