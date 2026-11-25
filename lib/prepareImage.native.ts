// Native (iOS/Android): prepares a captured photo for on-device recognition, and cleans up temp
// files afterwards. Spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 2 (split per A3/Task 9;
// the web version is `prepareImage.web.ts`).
//
// The photo is always re-rendered and re-saved (even when it's already small enough): the
// recognizer then reads a fresh JPEG written by expo-image-manipulator rather than the camera
// file, which is what we rely on for upright orientation (expo-mlkit-ocr's Vision path doesn't
// swap box sizes for rotated images). Whether the output is upright and EXIF-free is checked on
// a device (D4); the docs don't say. A low-resolution photo is scaled up (RECOGNITION_UPSCALE)
// so its text is tall enough to read; that only touches small images, never the camera path.
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';

import { RECOGNITION_JPEG_COMPRESS, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE, targetSize, type PreparedImage } from './imageSize';
import { RecognitionError } from './recognitionError';

export {
  RECOGNITION_JPEG_COMPRESS,
  RECOGNITION_MAX_EDGE,
  RECOGNITION_UPSCALE,
  targetSize,
  type PreparedImage,
  type Size,
  type Upscale,
} from './imageSize';

function release(ref: { release(): void } | null): void {
  try {
    ref?.release();
  } catch {
    // Best effort: freeing native memory must not mask the real result.
  }
}

/**
 * Resizes so the long edge is at most RECOGNITION_MAX_EDGE (and, below RECOGNITION_UPSCALE.belowEdge,
 * scales a low-resolution photo up to RECOGNITION_UPSCALE.toEdge), then saves a JPEG in the cache folder.
 * Rejects with `RecognitionError('image_load_failed')` if the photo can't be read or written.
 */
export async function prepareForRecognition(uri: string): Promise<PreparedImage> {
  let original: ImageRef | null = null;
  let resized: ImageRef | null = null;
  try {
    // Render once to learn the decoded size, then resize from that in-memory image (no second decode).
    original = await ImageManipulator.manipulate(uri).renderAsync();
    const size = targetSize(original.width, original.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
    let toSave = original;
    if (size.width !== original.width || size.height !== original.height) {
      resized = await ImageManipulator.manipulate(original).resize(size).renderAsync();
      toSave = resized;
    }
    const saved = await toSave.saveAsync({ format: SaveFormat.JPEG, compress: RECOGNITION_JPEG_COMPRESS });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } catch {
    throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
  } finally {
    release(resized);
    release(original);
  }
}

function stripFileScheme(uri: string): string {
  return uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
}

// Only files inside the app's cache folder are deleted, so a caller can never remove a file the
// user owns (e.g. a photo-library original) by passing the wrong URI. The camera and
// expo-image-manipulator both write into the cache folder.
function isInCache(uri: string): boolean {
  const cache = stripFileScheme(Paths.cache.uri);
  const path = stripFileScheme(uri);
  return cache.length > 0 && path.startsWith(`${cache}/`) && !path.split('/').includes('..');
}

/** Deletes temp images, best effort. Skips blanks, duplicates and anything outside the cache folder. Never throws. */
export async function deleteTempImages(uris: readonly (string | null | undefined)[]): Promise<void> {
  const unique = new Set(uris.filter((u): u is string => typeof u === 'string' && u.length > 0));
  for (const uri of unique) {
    try {
      if (!isInCache(uri)) continue;
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // Best effort: a leftover cache file is harmless and the OS clears the cache folder.
    }
  }
}
