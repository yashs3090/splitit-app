// Type-only entry for `./prepareImage`. Metro and Jest resolve `prepareImage.native.ts`
// (expo-file-system cache cleanup) or `prepareImage.web.ts` (blob: URLs, no expo-file-system)
// by platform; TypeScript resolves this file. Same pattern as `lib/textRecognition.ts`.
import type { PreparedImage } from './imageSize';

export {
  RECOGNITION_JPEG_COMPRESS,
  RECOGNITION_MAX_EDGE,
  RECOGNITION_UPSCALE,
  targetSize,
  type PreparedImage,
  type Size,
  type Upscale,
} from './imageSize';

/**
 * Resizes so the long edge is at most RECOGNITION_MAX_EDGE, scales a low-resolution photo (long edge
 * below RECOGNITION_UPSCALE.belowEdge) up to RECOGNITION_UPSCALE.toEdge, and re-encodes a JPEG (which
 * also drops EXIF, including location). Rejects with `RecognitionError('image_load_failed')`.
 */
export declare function prepareForRecognition(uri: string): Promise<PreparedImage>;

/** Frees temp images (native: deletes cache files; web: revokes blob: URLs). Never throws. */
export declare function deleteTempImages(uris: readonly (string | null | undefined)[]): Promise<void>;
