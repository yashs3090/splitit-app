// Web stage set (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 and Task 3).
// Today's web behaviour only: normalize via the injected `prepareForRecognition` (expo-image-manipulator,
// injected by `lib/scanReceipt.web.ts`), recognize with Tesseract.js through one `OcrSession` per scan.
// Enhance: see Task 9 below.
//
// Task 6: a variant with `normalize: 'cv'` resizes in the OpenCV worker (`./cvClient.ts`), but only
// when `cvPreprocess` is on (default `WEB_CV_PREPROCESS`, false today). Off, OpenCV is never
// fetched and no Worker is created. If OpenCV can't be used, the step falls back to today's
// `prepareForRecognition` and reports it through `ctx.onFallback`.
//
// Task 7: `locateDocument` and `cropAndFlatten` run in the worker (`cv/locate.ts`, `cv/warp.ts`), also
// only with `cvPreprocess` on (off, locate finds nothing and the crop is the identity, with no cv
// call). The photo is decoded into the worker once per attempt and shared by locate, crop and
// normalize; it is freed after the step that last reads it (the warp, or the resize) and at dispose.
// Quads cross this boundary in the photo's own (source) pixels; the worker works in decoded pixels
// (≤ CV_MAX_DECODE_EDGE). A crop is a `cv:` handle. With `normalize: 'cv'` (`web-crop`) it is resized
// in the worker. Otherwise (`web-crop-canvas`) OpenCV only locates and flattens: the crop leaves the
// worker once as a lossless PNG and today's `prepareForRecognition` (canvas, Hermite, JPEG) applies
// the size rule to it, so the resampler is the same as `web-current`'s; the PNG URL is revoked as
// soon as prepare has its own copy. OpenCV failing in locate or crop throws `StageUnavailable`,
// so the orchestration uses the whole photo for the rest of the scan; it never fails the scan.
//
// Task 8: `recognize` reports the read's median line height (`textHeight.ts`), and the text-height
// second pass resizes the same image the first pass started from (the crop, or the photo without
// one) to the first-pass size × the factor the orchestration chose, capped at RECOGNITION_MAX_EDGE.
// It uses the first pass's resampler: the injected `prepareAtSize` (today's canvas resize at an
// exact size) unless the variant asks for cv. A crop is re-encoded as PNG for it, so the second
// pass resamples the crop once, never the first-pass JPEG.
//
// Task 9: `enhance` (grey → flatten → CLAHE, never binarized) runs in the worker, only with
// `cvPreprocess` on. Its input is the size step's output: a crop resized in the worker is used where
// it is; an image from today's canvas path is loaded into the worker for it, and that copy is freed
// as soon as the enhanced image exists. The result is a `cv:` handle that `recognize` encodes as the
// variant's `output`. OpenCV failing here throws `StageUnavailable`: the scan reads the unenhanced
// image for the rest of the scan (recorded in the trace).
//
// Task 13: zoom on doubt runs inside `recognize`, after each read, when the variant asks for it
// (`zoomOnDoubt.ts`): doubtful rows are cut from the image that read saw (the prepared JPEG, or the
// worker image's encoded URL, before it is revoked) with the injected `cropAtScale` (today's canvas
// path: crop + Hermite resize + JPEG; not the OpenCV resampler), read as single lines (PSM 7) on the
// scan's one Tesseract session, and each crop URL is released as soon as its read ends. Per-read
// settings go through the read's options (A4), so PSM 7 never leaks into the next page read.
//
// Task 12: strip tiling. When the variant tiles and the crop (or the photo, without one) is tall
// enough (`stripTiling.ts`: height / width ≥ 2.5 and height > 1.25 × RECOGNITION_MAX_EDGE),
// `normalizeScale` doesn't shrink it to the cap: it measures the row-ink profile in the worker
// (`rowInk`), plans strips cut only on blank rows, and returns a `tiles:` handle that stands for
// "this image, read in strips at native resolution" (width capped at RECOGNITION_MAX_EDGE). Any
// failure to plan (no blank row in a window, too many strips, OpenCV gone) means no tiling: today's
// size rule on the whole image. `recognize` cuts each strip from the image itself with the injected
// `cropAtScale` (today's canvas path, not the OpenCV resampler; a crop is encoded once as PNG for it),
// reads the strips one by one on the scan's one Tesseract session, releases each strip as soon as its
// read ends (and the PNG at the end, whatever happens), and merges the lines back into the image's
// pixels (`mergeStripLines`). The text-height second pass re-plans the strips at the new scale, or
// reads the whole image when the new size fits under the cap.
//
// Loaded only through `import()` from `lib/scanReceipt.web.ts` (and by the browser harness).
// Must not import `react-native` or `expo-*` (criterion 15). Handles are blob: URLs, or `cv:<id>`
// for an image held in the OpenCV worker.
import { RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE, targetSize, type PreparedImage, type Rect, type Size } from '../../imageSize';
import type { RecognizedText } from '../../receiptTypes';
import { RecognitionError } from '../../recognitionError';
import { createOcrSession, type OcrSession, type SessionReadOptions, type TesseractSettings } from '../../webOcrSession';
import { WEB_CV_PREPROCESS } from '../config';
import { meanLineConfidence } from '../lineConfidence';
import { medianLineHeight, secondPassSize } from '../textHeight';
import { mergeStripLines, planStrips, shouldTile, stripScale, type StripRead, type StripSpan } from '../stripTiling';
import { ZOOM_PAGESEG_MODE, zoomCropRect, zoomOnDoubt, zoomScale, type ZoomReport, type ZoomReread } from '../zoomOnDoubt';
import {
  asImg,
  StageUnavailable,
  type FirstPass,
  type Img,
  type LocateResult,
  type NormalizeResult,
  type RecognizeConfig,
  type RecognizeResult,
  type StageContext,
  type StageName,
  type StageSet,
  type TilingOptions,
} from '../types';
import { createCvClient, CvOpFailed, CvUnavailable, type CvClient } from './cvClient';
import { scaleQuad } from './cv/geometry';
import type { CvImage, CvLoaded } from './cv/protocol';

export type WebStageDeps = {
  prepareForRecognition(uri: string): Promise<PreparedImage>;
  /**
   * Today's canvas resize and JPEG encode (as `prepareForRecognition`), but to exactly `size`: the
   * text-height second pass. Unset = no second pass on the canvas path (normalize returns null).
   */
  prepareAtSize?(uri: string, size: Size): Promise<PreparedImage>;
  deleteTempImages(uris: readonly (string | null | undefined)[]): Promise<void>;
  /** Test seam; defaults to a real Tesseract.js session. */
  openOcrSession?: () => OcrSession;
  /** Whether cv stages may run. Default `WEB_CV_PREPROCESS`; the harness turns it on for cv variants. */
  cvPreprocess?: boolean;
  /** Test seam; defaults to the real worker client. Called at most once, on the first cv step. */
  openCvClient?: () => CvClient;
  /** Harness only (`--dump-binary`): gets Tesseract's binarized image (PNG data URL) after each read. */
  onImageBinary?: (pngDataUrl: string) => void;
  /**
   * Zoom on doubt (Task 13): today's canvas path (as `prepareAtSize`), but first cropping `uri` to
   * `rect` (pixels of `uri`, clamped to the image), then scaling by `scale` (long edge capped at
   * RECOGNITION_MAX_EDGE), saved as JPEG. Unset = no zoom (recorded as a recognize `fallback`).
   */
  cropAtScale?(uri: string, rect: Rect, scale: number): Promise<PreparedImage>;
  /** Harness only: what zoom on doubt did on each read that ran it (rows, outcomes). */
  onZoom?: (report: ZoomReport) => void;
  /** Harness only: each tiled read's strips (their image sizes, in read order). */
  onTiles?: (report: TileReport) => void;
};

/** What one tiled read did (harness `meta`). Sizes are the strip images handed to Tesseract. */
export type TileReport = { scale: number; pitchPx: number; strips: Size[] };

/** A web stage set plus `close()`, which ends the scan's Tesseract and OpenCV workers. Call it in `finally`. */
export type WebStageSet = StageSet & { close(): void };

const CV_PREFIX = 'cv:';
const isCvHandle = (img: string) => img.startsWith(CV_PREFIX);
/** A tiled pass: not an image, just "read this image in these strips at this scale" (Task 12). */
const TILES_PREFIX = 'tiles:';
const isTilesHandle = (img: string) => img.startsWith(TILES_PREFIX);

/** A planned tiled read of `source` (a crop handle or the photo URL), in `source`'s own pixels. */
type TiledPass = { source: Img; size: Size; scale: number; strips: StripSpan[]; pitch: number };
/** A source's row-ink profile; `ratio` = profile rows per source pixel (< 1 for a photo decoded under the 4096 cap). */
type InkProfile = { ink: Uint32Array; width: number; ratio: number };
const NOT_LOCATED: LocateResult = { method: 'none', quad: null, confidence: 0 };

/**
 * OpenCV can't do this step (gone, or one op failed) while the photo itself is fine, so the step
 * falls back to today's path on the original photo (review R2). A photo that won't decode
 * (`decode_failed`) is not this: today's path couldn't read it either.
 */
function cvStepFailed(e: unknown): boolean {
  return e instanceof CvUnavailable || (e instanceof CvOpFailed && e.code !== 'decode_failed');
}

/** OpenCV gone or an op failed in an optional step: that step is unavailable (identity), not a failed scan. */
function asOptionalStepError(e: unknown, stage: StageName): Error {
  if (e instanceof RecognitionError) return e;
  if (e instanceof CvUnavailable || e instanceof CvOpFailed) return new StageUnavailable(stage);
  return new RecognitionError('failed');
}

export function createWebStages(deps: WebStageDeps): WebStageSet {
  // One worker for the whole scan, started on the first read and reused by every pass and the retry.
  const session = (deps.openOcrSession ?? createOcrSession)();
  const cvOn = deps.cvPreprocess ?? WEB_CV_PREPROCESS;
  let cv: CvClient | null = null;
  const cvImages = new Map<Img, CvImage>();
  const getCv = () => (cv ??= (deps.openCvClient ?? createCvClient)());

  /** The size of each normalize input's first-pass image, for its text-height second pass. */
  const firstPassSize = new Map<Img, Size>();

  /** Task 12: tiled passes by handle; the scale each tiled source was first read at; profiles per source (null = don't tile). */
  const tiledPasses = new Map<Img, TiledPass>();
  const tiledFirstScale = new Map<Img, number>();
  const inkProfiles = new Map<Img, InkProfile | null>();
  let tilesSeq = 0;

  async function prepare(img: Img): Promise<NormalizeResult & Size> {
    // A decode left over from locate (no crop) isn't read again: free it before today's resize.
    freeDecoded(img);
    const prepared = await deps.prepareForRecognition(img);
    // Today's prepare step doesn't report the input size, so the factor isn't known here.
    return { img: asImg(prepared.uri), scale: null, width: prepared.width, height: prepared.height };
  }

  /** The photo decoded into the worker, once per attempt (shared by locate, crop and normalize). */
  const decoded = new Map<Img, CvLoaded>();
  /** crop handle → the photo it came from, so normalize can fall back to today's path on that photo. */
  const cropOrigin = new Map<Img, Img>();
  /**
   * cv handle → what `recognize` reads instead if the handle can't leave the worker (R2): the
   * original photo (`prepared: false`, so today's prepare runs on it first), or the canvas-prepared
   * image an enhanced handle was made from (`prepared: true`, read as it is).
   */
  const readableFallback = new Map<Img, { img: Img; prepared: boolean }>();
  const fallbackFor = (img: Img): { img: Img; prepared: boolean } | undefined =>
    isCvHandle(img) ? readableFallback.get(img) : { img, prepared: false };

  async function decode(img: Img, ctx: StageContext): Promise<CvLoaded> {
    const have = decoded.get(img);
    if (have) return have;
    const loaded = await getCv().load(img, ctx.signal);
    decoded.set(img, loaded);
    return loaded;
  }
  function freeDecoded(img: Img): void {
    const d = decoded.get(img);
    if (!d) return;
    decoded.delete(img);
    cv?.free([d.id]);
  }

  /**
   * Today's size rule, applied in the worker: to the photo's (EXIF-oriented) source size, or to a
   * crop's own size (D4: the size rule is applied to the crop).
   */
  async function cvNormalize(img: Img, ctx: StageContext, exact?: Size): Promise<NormalizeResult & Size> {
    const client = getCv();
    const held = cvImages.get(img);
    // A crop is already in the worker; a photo is decoded into it (or reused from locate).
    const loaded = held ? null : await decode(img, ctx);
    const src: CvImage = held ?? (loaded as CvImage);
    try {
      // Size rule on the source size, as `prepareForRecognition` measures it (EXIF-oriented).
      const w = loaded ? loaded.sourceWidth : src.width;
      const h = loaded ? loaded.sourceHeight : src.height;
      const size = exact ?? targetSize(w, h, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
      const out = await client.resize(src.id, size.width, size.height, ctx.signal);
      const handle = asImg(`${CV_PREFIX}${out.id}`);
      cvImages.set(handle, out);
      const fb = fallbackFor(img);
      if (fb) readableFallback.set(handle, fb);
      return { img: handle, scale: size.width / w, width: out.width, height: out.height };
    } finally {
      // The full-size decode isn't a pipeline handle: free it as soon as the resize is done.
      if (loaded) freeDecoded(img);
    }
  }

  /**
   * A crop resized by today's canvas path: the worker encodes it losslessly (PNG, so the only
   * resample is prepare's), `prepareForRecognition` applies the size rule to the crop's own size
   * (D4), and the PNG URL is revoked in `finally` once prepare has made its own copy. The crop
   * itself stays in the worker until dispose.
   */
  async function canvasNormalizeCrop(
    img: Img,
    ctx: StageContext,
    resize: (uri: string) => Promise<PreparedImage> = deps.prepareForRecognition,
  ): Promise<NormalizeResult & Size> {
    const client = getCv();
    const held = cvImages.get(img);
    if (!held) throw new RecognitionError('image_load_failed', 'CV_NORMALIZE_FAILED');
    const png = await client.encode(held.id, 'png', ctx.signal);
    try {
      const prepared = await resize(png);
      return { img: asImg(prepared.uri), scale: prepared.width / held.width, width: prepared.width, height: prepared.height };
    } finally {
      client.revoke(png);
    }
  }

  /** The first pass: the image-size rule on `img` (the crop, or the photo). */
  async function firstNormalize(img: Img, wantCv: boolean, ctx: StageContext): Promise<NormalizeResult & Size> {
    const crop = isCvHandle(img);
    if (!crop && (!wantCv || !cvOn)) return prepare(img);
    try {
      // A crop is resized in the worker only when the variant asks for cv; otherwise it is handed
      // to today's canvas path.
      return crop && !wantCv ? await canvasNormalizeCrop(img, ctx) : await cvNormalize(img, ctx);
    } catch (e) {
      // OpenCV didn't load / timed out / crashed: today's resize on the photo (for a crop, the
      // photo it was cut from, so the scan still reads something).
      // An op failing (not a decode) is treated the same way as OpenCV being gone (R2).
      const photo = isCvHandle(img) ? cropOrigin.get(img) : img;
      if (cvStepFailed(e) && photo !== undefined) {
        ctx.onFallback?.('normalize');
        return prepare(photo);
      }
      if (e instanceof RecognitionError) throw e;
      throw new RecognitionError('image_load_failed', 'CV_NORMALIZE_FAILED');
    }
  }

  /**
   * The text-height second pass: `img` (the same crop or photo the first pass started from)
   * resized to the first-pass size × `factor`, capped at RECOGNITION_MAX_EDGE, with the first
   * pass's resampler. Null when nothing would change, when there was no first pass for `img`, when
   * the canvas path has no `prepareAtSize`, or when OpenCV is gone by now (the first read stands).
   */
  async function secondPass(img: Img, first: FirstPass, wantCv: boolean, ctx: StageContext): Promise<NormalizeResult | null> {
    const from = firstPassSize.get(img);
    if (!from) return null;
    const size = secondPassSize(from, first.factor, RECOGNITION_MAX_EDGE);
    if (!size) return null;
    const crop = isCvHandle(img);
    const atSize = deps.prepareAtSize;
    try {
      if (wantCv && cvOn) {
        const out = await cvNormalize(img, ctx, size);
        return { img: out.img, scale: out.scale };
      }
      if (!atSize) return null;
      if (crop) {
        const out = await canvasNormalizeCrop(img, ctx, (uri) => atSize(uri, size));
        return { img: out.img, scale: out.scale };
      }
      freeDecoded(img);
      const prepared = await atSize(img, size);
      return { img: asImg(prepared.uri), scale: null };
    } catch (e) {
      // OpenCV gone or an op failed (R2): the first read stands; the trace shows the step fell back.
      if (cvStepFailed(e)) {
        ctx.onFallback?.('normalize');
        return null;
      }
      if (e instanceof RecognitionError) throw e;
      throw new RecognitionError('image_load_failed', 'CV_NORMALIZE_FAILED');
    }
  }

  /**
   * `img` couldn't leave the worker (OpenCV gone, or the encode failed; R2): read what it was made
   * from instead, through today's path. A prepared copy made here is released as soon as its read
   * ends. Without a usable source the read fails as before.
   */
  async function readFallback<T>(img: Img, read: (uri: string) => Promise<T>, ctx: StageContext): Promise<T> {
    const fb = readableFallback.get(img);
    if (!fb) throw new RecognitionError('failed', 'CV_ENCODE_FAILED');
    ctx.onFallback?.('recognize');
    if (fb.prepared) return read(fb.img);
    const p = await prepare(fb.img);
    try {
      return await read(p.img);
    } finally {
      await deps.deleteTempImages([p.img]);
    }
  }


  /** `img`'s size in its own pixels: a crop's held size, or the photo's (EXIF-oriented) source size. */
  async function sourceSize(img: Img, ctx: StageContext): Promise<Size> {
    const held = cvImages.get(img);
    if (held) return { width: held.width, height: held.height };
    const loaded = await decode(img, ctx);
    return { width: loaded.sourceWidth, height: loaded.sourceHeight };
  }

  /**
   * The row-ink profile of a tall `img`, measured once per source (null when it shouldn't be tiled).
   * A photo is measured on its decode (freed right after: the strips are cut from the photo itself).
   */
  async function inkProfile(img: Img, size: Size, tiling: TilingOptions, ctx: StageContext): Promise<InkProfile | null> {
    if (inkProfiles.has(img)) return inkProfiles.get(img) ?? null;
    if (!shouldTile(size, tiling, RECOGNITION_MAX_EDGE)) return null;
    const client = getCv();
    const held = cvImages.get(img);
    let profile: InkProfile;
    if (held) profile = { ink: await client.rowInk(held.id, ctx.signal), width: held.width, ratio: 1 };
    else {
      const loaded = await decode(img, ctx);
      profile = { ink: await client.rowInk(loaded.id, ctx.signal), width: loaded.width, ratio: loaded.height / loaded.sourceHeight };
      freeDecoded(img);
    }
    inkProfiles.set(img, profile);
    return profile;
  }

  /**
   * Plans a tiled read of `img` at `scale` and returns its `tiles:` handle, or null when `img` isn't
   * tiled (not tall enough, or no plan cuts only on blank rows within MAX_STRIPS). OpenCV failing
   * here is also "not tiled": the caller reads the whole image as usual. Cancel rejects.
   */
  async function planTiled(img: Img, scale: number | null, tiling: TilingOptions, ctx: StageContext): Promise<(NormalizeResult & Size) | null> {
    if (!cvOn || !deps.cropAtScale || inkProfiles.get(img) === null) return null;
    try {
      const size = await sourceSize(img, ctx);
      const profile = await inkProfile(img, size, tiling, ctx);
      if (!profile) {
        inkProfiles.set(img, null);
        return null;
      }
      const s = scale ?? stripScale(size.width, RECOGNITION_MAX_EDGE);
      const plan = planStrips(profile.ink, profile.width, { ...tiling, maxStripPx: (RECOGNITION_MAX_EDGE / s) * profile.ratio });
      if (!plan) {
        if (scale === null) inkProfiles.set(img, null);
        return null;
      }
      // Profile rows → source pixels (outwards, so a strip never loses a row of its span).
      const strips = plan.strips.map((t) => ({
        top: Math.max(0, Math.floor(t.top / profile.ratio)),
        bottom: Math.min(size.height, Math.ceil(t.bottom / profile.ratio)),
      }));
      const handle = asImg(`${TILES_PREFIX}${++tilesSeq}`);
      tiledPasses.set(handle, { source: img, size, scale: s, strips, pitch: plan.pitch / profile.ratio });
      return { img: handle, scale: s, width: Math.round(size.width * s), height: Math.round(size.height * s) };
    } catch (e) {
      if (e instanceof RecognitionError && e.code === 'cancelled') throw e;
      if (ctx.signal?.aborted) throw new RecognitionError('cancelled');
      inkProfiles.set(img, null);
      return null;
    }
  }

  /**
   * The text-height second pass of a source that was first read in strips: the strips re-planned at
   * the first scale × `factor` (width still capped), or, when that size fits under the cap, the
   * whole image resized as usual. Null when nothing would change.
   */
  async function tiledSecondPass(img: Img, s1: number, first: FirstPass, wantCv: boolean, tiling: TilingOptions, ctx: StageContext): Promise<NormalizeResult | null> {
    const size = await sourceSize(img, ctx);
    // The strips' width stays capped at RECOGNITION_MAX_EDGE, as in the first pass.
    const s2 = Math.min(s1 * first.factor, RECOGNITION_MAX_EDGE / size.width);
    if (Math.max(size.width, size.height) * s2 <= RECOGNITION_MAX_EDGE) return secondPass(img, first, wantCv, ctx);
    if (Math.round(size.width * s2) === Math.round(size.width * s1)) return null;
    const t = await planTiled(img, s2, tiling, ctx);
    return t && { img: t.img, scale: t.scale };
  }

  /** Reads a tiled pass strip by strip and merges the lines (boxes in the source's own pixels). */
  async function readTiled(
    t: TiledPass,
    read: (uri: string, onProgress?: (f: number) => void) => Promise<RecognizedText>,
    readWhole: (uri: string) => Promise<RecognizeResult>,
    ctx: StageContext,
  ): Promise<RecognizeResult> {
    const cropAtScale = deps.cropAtScale;
    if (!cropAtScale) throw new RecognitionError('failed', 'TILES_NO_CROP');
    // A crop lives in the worker: hand it over once, losslessly, for the canvas path to cut from.
    let base: string = t.source;
    let png: string | null = null;
    if (isCvHandle(t.source)) {
      const held = cvImages.get(t.source);
      if (!held || !cv) throw new RecognitionError('failed', 'CV_ENCODE_FAILED');
      try {
        png = await cv.encode(held.id, 'png', ctx.signal);
      } catch (e) {
        if (e instanceof RecognitionError) throw e;
        // The strips are planned in the crop's pixels, so the photo is read whole instead (R2).
        if (cvStepFailed(e)) return readFallback(t.source, readWhole, ctx);
        throw new RecognitionError('failed', 'CV_ENCODE_FAILED');
      }
      base = png;
    }
    try {
      const reads: StripRead[] = [];
      const sizes: Size[] = [];
      const n = t.strips.length;
      for (let k = 0; k < n; k++) {
        if (ctx.signal?.aborted) throw new RecognitionError('cancelled');
        const s = t.strips[k] as StripSpan;
        const h = s.bottom - s.top;
        // Native resolution (the width cap is in t.scale); a strip taller than the cap is fitted to it.
        const scale = Math.min(t.scale, RECOGNITION_MAX_EDGE / h);
        const strip = await cropAtScale(base, { x: 0, y: s.top, width: t.size.width, height: h }, scale);
        try {
          const onProgress = ctx.onProgress && ((f: number) => ctx.onProgress?.((k + f) / n));
          const text = await read(strip.uri, onProgress);
          reads.push({ left: 0, top: s.top, scaleX: strip.width / t.size.width, scaleY: strip.height / h, lines: text.lines });
          sizes.push({ width: strip.width, height: strip.height });
        } finally {
          await deps.deleteTempImages([strip.uri]);
        }
      }
      deps.onTiles?.({ scale: t.scale, pitchPx: t.pitch, strips: sizes });
      const text: RecognizedText = { lines: mergeStripLines(reads, t.strips.map((s) => s.bottom), t.pitch) };
      // Text height in the pixels Tesseract saw (the source × scale), like any other read.
      const median = medianLineHeight(text);
      return { text, medianLineHeight: median === null ? null : median * t.scale, meanLineConfidence: meanLineConfidence(text.lines) };
    } finally {
      if (png) cv?.revoke(png);
    }
  }

  /**
   * Zoom on doubt over one read of `uri` (Task 13). The text back is the read itself when the variant
   * has no zoom, nothing was doubtful, or pickBetter kept the original. A row read that times out ends
   * the zoom with what it has (the session is finished then, as after any timed-out read); cancel
   * rejects. Every crop URL is released when its read ends, whatever the outcome.
   */
  async function zoom(uri: string, text: RecognizedText, config: RecognizeConfig, ctx: StageContext): Promise<RecognizedText> {
    const z = config.zoomOnDoubt;
    if (z === false) return text;
    const cropAtScale = deps.cropAtScale;
    if (!cropAtScale) {
      ctx.onFallback?.('recognize');
      return text;
    }
    // The variant's own settings, with single-line segmentation on top; same init, so no re-init.
    // No rotateAuto (one row), no progress or stage reports (the screen stays on "Reading receipt").
    const tesseract: TesseractSettings = { params: { ...(config.tesseract?.params ?? {}), tessedit_pageseg_mode: ZOOM_PAGESEG_MODE } };
    if (config.tesseract?.init) tesseract.init = config.tesseract.init;
    const reread: ZoomReread = async (line) => {
      const crop = await cropAtScale(uri, zoomCropRect(line.box), zoomScale(line.box.height, z.targetLineHeightPx));
      try {
        const got = await session.read(crop.uri, { signal: ctx.signal, tesseract });
        return got.lines.length === 1 ? (got.lines[0] ?? null) : null;
      } finally {
        await deps.deleteTempImages([crop.uri]);
      }
    };
    const r = await zoomOnDoubt(text, z, reread, ctx.signal);
    deps.onZoom?.(r.report);
    return r.text;
  }

  return {
    async locateDocument(img, ctx) {
      if (!cvOn) return NOT_LOCATED;
      try {
        const loaded = await decode(img, ctx);
        const found = await getCv().locate(loaded.id, ctx.signal);
        // Worker (decoded) pixels → the photo's own pixels.
        const quad = found.quad && scaleQuad(found.quad, loaded.sourceWidth / loaded.width, loaded.sourceHeight / loaded.height);
        return { method: found.method, quad, confidence: found.confidence };
      } catch (e) {
        throw asOptionalStepError(e, 'locate');
      }
    },
    async cropAndFlatten(img, loc, opts, ctx) {
      // The identity below `minConfidence` (the orchestration checks too) or with cv off.
      if (!cvOn || loc.quad === null || !(loc.confidence >= opts.minConfidence)) return img;
      try {
        const loaded = await decode(img, ctx);
        const quad = scaleQuad(loc.quad, loaded.width / loaded.sourceWidth, loaded.height / loaded.sourceHeight);
        const out = await getCv().warp(loaded.id, quad, opts.marginFraction, ctx.signal);
        const handle = asImg(`${CV_PREFIX}${out.id}`);
        cvImages.set(handle, out);
        cropOrigin.set(handle, img);
        readableFallback.set(handle, { img, prepared: false });
        // The crop carries the pixels from here; the decode isn't needed by this attempt any more.
        freeDecoded(img);
        return handle;
      } catch (e) {
        throw asOptionalStepError(e, 'crop');
      }
    },
    async normalizeScale(img, { firstPass, method, tiling }, ctx) {
      if (firstPass !== null) {
        const s1 = tiledFirstScale.get(img);
        if (s1 !== undefined && tiling) return tiledSecondPass(img, s1, firstPass, method === 'cv', tiling, ctx);
        return secondPass(img, firstPass, method === 'cv', ctx);
      }
      const tiled = tiling ? await planTiled(img, null, tiling, ctx) : null;
      if (tiled) {
        tiledFirstScale.set(img, tiled.scale ?? 1);
        firstPassSize.set(img, { width: tiled.width, height: tiled.height });
        return { img: tiled.img, scale: tiled.scale };
      }
      const out = await firstNormalize(img, method === 'cv', ctx);
      firstPassSize.set(img, { width: out.width, height: out.height });
      return { img: out.img, scale: out.scale };
    },
    async enhance(img, opts, ctx) {
      if (opts === false || !cvOn || (!opts.gray && !opts.flatten && !opts.clahe)) return img;
      // A tiled pass isn't an image; its strips are read unenhanced (no variant combines the two).
      if (isTilesHandle(img)) {
        ctx.onFallback?.('enhance');
        return img;
      }
      try {
        const client = getCv();
        const held = cvImages.get(img);
        // Today's canvas path made a JPEG: load it into the worker just for this step.
        const loaded = held ? null : await client.load(img, ctx.signal);
        try {
          const out = await client.enhance((held ?? (loaded as CvImage)).id, opts, ctx.signal);
          const handle = asImg(`${CV_PREFIX}${out.id}`);
          cvImages.set(handle, out);
          // Its source: an image already in the worker inherits that one's; a canvas image is itself readable.
          const fb = held ? readableFallback.get(img) : { img, prepared: true };
          if (fb) readableFallback.set(handle, fb);
          return handle;
        } finally {
          if (loaded) client.free([loaded.id]);
        }
      } catch (e) {
        throw asOptionalStepError(e, 'enhance');
      }
    },
    async recognize(img, config, ctx) {
      // Task 5: the variant's Tesseract settings (unset for `web-current` = today's engine settings).
      const opts: SessionReadOptions = { signal: ctx.signal, onStage: ctx.onStage, onProgress: ctx.onProgress };
      if (config.tesseract) opts.tesseract = config.tesseract;
      if (deps.onImageBinary) opts.onImageBinary = deps.onImageBinary;
      const readText = async (uri: string, onProgress = ctx.onProgress) => {
        const first = await session.read(uri, onProgress === ctx.onProgress ? opts : { ...opts, onProgress });
        return zoom(uri, first, config, ctx);
      };
      const read = async (uri: string) => {
        const text = await readText(uri);
        return { text, medianLineHeight: medianLineHeight(text), meanLineConfidence: meanLineConfidence(text.lines) };
      };
      const tiles = tiledPasses.get(img);
      if (tiles) return readTiled(tiles, readText, read, ctx);
      const held = cvImages.get(img);
      if (!held || !cv) return read(img);
      let url: string;
      try {
        url = await cv.encode(held.id, config.output ?? 'jpeg90', ctx.signal);
      } catch (e) {
        if (e instanceof RecognitionError) throw e;
        // The image can't leave the worker, but what it was made from can still be read (R2).
        if (cvStepFailed(e)) return readFallback(img, read, ctx);
        throw new RecognitionError('failed', 'CV_ENCODE_FAILED');
      }
      try {
        return await read(url);
      } finally {
        cv.revoke(url);
      }
    },
    async dispose(all) {
      try {
        // Tiled passes hold no pixels of their own (their strips are released as they are read).
        for (const i of all) {
          tiledPasses.delete(i);
          tiledFirstScale.delete(i);
          inkProfiles.delete(i);
        }
        const imgs = all.filter((i) => !isTilesHandle(i));
        const inWorker = imgs.filter((i) => isCvHandle(i));
        if (inWorker.length > 0) {
          const ids = inWorker.flatMap((i) => {
            const h = cvImages.get(i);
            cvImages.delete(i);
            return h ? [h.id] : [];
          });
          cv?.free(ids);
        }
        for (const i of imgs) {
          cropOrigin.delete(i);
          readableFallback.delete(i);
          firstPassSize.delete(i);
          freeDecoded(i);
        }
        await deps.deleteTempImages(inWorker.length > 0 ? imgs.filter((i) => !isCvHandle(i)) : imgs);
      } catch {
        // Never throws.
      }
    },
    close() {
      session.close();
      cv?.close();
    },
  };
}
