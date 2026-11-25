// Web stages: the cv normalize path (spec Task 6) with a fake cv client and a fake OCR session.
// Criterion 20: with cv off (WEB_CV_PREPROCESS = false today), no cv client and no Worker, even
// for a cv variant. Also: the cv size rule, encode for recognize, frees and revokes, the fallback
// to today's prepare when OpenCV can't be used, and abort.
import type { RecognizedText } from '../../receiptTypes';
import { RecognitionError } from '../../recognitionError';
import type { OcrSession } from '../../webOcrSession';
import { resolvePlan, usesCv, VARIANTS, WEB_CV_PREPROCESS, type ResolvedPlan } from '../config';
import { secondPassSize } from '../textHeight';
import { runScanPipeline } from '../run';
import { asImg } from '../types';
import { CvOpFailed, CvUnavailable, type CvClient } from './cvClient';
import { createWebStages, type WebStageDeps } from './stages';
import { warpGeometry } from './cv/geometry';
import type { CvLocation } from './cv/protocol';
import { RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE, targetSize } from '../../imageSize';
import type { Quad } from '../types';

const TEXT: RecognizedText = {
  lines: ['Cafe', 'Soup 4.00', 'Bread 6.00', 'Subtotal 10.00', 'Tax 1.00', 'Total 11.00'].map((text, i) => ({
    text,
    box: { x: 0, y: i * 30, width: 300, height: 20 },
  })),
};

function fakeSession(): OcrSession & { read: jest.Mock; close: jest.Mock } {
  return { read: jest.fn(async () => TEXT), close: jest.fn() };
}

type FakeCv = CvClient & { [K in 'load' | 'resize' | 'locate' | 'warp' | 'enhance' | 'encode' | 'rowInk' | 'revoke' | 'free' | 'close']: jest.Mock };
/** A fake worker client. `decodedScale` = decoded / source size (the 4096 cap); `found` = what locate returns (decoded pixels). */
function fakeCv(source = { width: 6000, height: 4000 }, opts: { decoded?: { width: number; height: number }; found?: CvLocation } = {}): FakeCv {
  let id = 10;
  let url = 0;
  const decoded = opts.decoded ?? { width: 4096, height: 2731 };
  return {
    started: true,
    load: jest.fn(async () => ({ id: ++id, ...decoded, sourceWidth: source.width, sourceHeight: source.height })),
    resize: jest.fn(async (_id: number, width: number, height: number) => ({ id: ++id, width, height })),
    locate: jest.fn(async (): Promise<CvLocation> => opts.found ?? { method: 'none', quad: null, confidence: 0 }),
    // The real worker's output size: the quad's flattened size plus the margin.
    warp: jest.fn(async (_id: number, quad: Quad, marginFraction: number) => {
      const g = warpGeometry(quad, marginFraction);
      return { id: ++id, width: g.width + 2 * g.margin, height: g.height + 2 * g.margin };
    }),
    // Same size as its input (the fake doesn't track sizes per id: 100 × 200 stands for "unchanged").
    enhance: jest.fn(async () => ({ id: ++id, width: 100, height: 200, lineHeightPx: 12, kernelPx: 49, greyLevels: 180 })),
    encode: jest.fn(async () => `blob:enc-${++url}`),
    rowInk: jest.fn(async () => new Uint32Array(0)),
    revoke: jest.fn(),
    free: jest.fn(),
    close: jest.fn(),
  };
}

function deps(over: Partial<WebStageDeps> = {}) {
  const session = fakeSession();
  const prepareForRecognition = jest.fn(async (_uri: string) => ({ uri: 'blob:prepared', width: 2048, height: 1365 }));
  const deleteTempImages = jest.fn(async (_uris: readonly (string | null | undefined)[]) => undefined);
  const d = { prepareForRecognition, deleteTempImages, openOcrSession: () => session, ...over };
  return { d: Object.assign(d, { prepareForRecognition, deleteTempImages }), session };
}

const g = globalThis as Record<string, unknown>;
const savedWorker = g.Worker;
let WorkerSpy: jest.Mock;
beforeEach(() => {
  WorkerSpy = jest.fn();
  g.Worker = WorkerSpy;
});
afterAll(() => {
  if (savedWorker === undefined) delete g.Worker;
  else g.Worker = savedWorker;
});

const plan = (name: string) => resolvePlan({ primary: name, retry: null }, 'web');

describe('cv off (criterion 20)', () => {
  it('the shipped flag is off', () => {
    expect(WEB_CV_PREPROCESS).toBe(false);
  });

  it.each(['web-current', 'cv-resize-jpeg', 'cv-resize-png', 'web-crop', 'web-crop-canvas', 'web-crop-flatten-clahe', 'web-crop-th40-flatten'])('%s with cv off: today\'s prepare, no cv client, no Worker', async (name) => {
    const openCvClient = jest.fn(fakeCv);
    const { d, session } = deps({ openCvClient });
    const stages = createWebStages(d); // default = WEB_CV_PREPROCESS
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan(name));
    stages.close();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(openCvClient).not.toHaveBeenCalled();
    expect(WorkerSpy).not.toHaveBeenCalled();
    expect(r.trace.some((t) => t.event === 'fallback')).toBe(false);
  });
});

describe('cv on', () => {
  it('cv-resize-jpeg: load → resize to today\'s size rule on the source size → encode jpeg90 → read → revoke; frees and closes', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'));
    stages.close();

    expect(d.prepareForRecognition).not.toHaveBeenCalled();
    expect(cv.load.mock.calls[0]?.[0]).toBe('blob:photo');
    // targetSize(6000, 4000, 2048, upscale) = 2048 × 1365, from the source size (not the 4096 decode).
    expect(cv.resize.mock.calls[0]?.slice(0, 3)).toEqual([11, 2048, 1365]);
    expect(cv.encode.mock.calls[0]?.slice(0, 2)).toEqual([12, 'jpeg90']);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:enc-1']);
    expect(cv.revoke).toHaveBeenCalledWith('blob:enc-1');
    // The full-size decode is freed right after the resize; the resized image at dispose.
    expect(cv.free.mock.calls).toEqual([[[11]], [[12]]]);
    // The photo's blob URL is still revoked by deleteTempImages; the cv handle isn't passed to it.
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(r.attempts[0]!.scale).toEqual([2048 / 6000]);
    expect(r.trace.some((t) => t.event === 'fallback')).toBe(false);
  });

  it('cv-resize-png encodes PNG; a small photo is scaled up by the same rule (cubic in the worker)', async () => {
    const cv = fakeCv({ width: 450, height: 263 });
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-png'));
    stages.close();
    // targetSize(450, 263, 2048, { belowEdge: 1000, toEdge: 1600 }) = 1600 × 935.
    expect(cv.resize.mock.calls[0]?.slice(1, 3)).toEqual([1600, 935]);
    expect(cv.encode.mock.calls[0]?.[1]).toBe('png');
  });

  it('OpenCV unavailable → today\'s prepare for the step, recorded as a `fallback` in the trace; the scan succeeds', async () => {
    const cv = fakeCv();
    cv.load.mockRejectedValue(new CvUnavailable());
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'));
    stages.close();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.trace).toContainEqual({ variant: 'cv-resize-jpeg', stage: 'normalize', event: 'fallback' });
    expect(r.best.verdict.ok).toBe(true);
    expect(cv.close).toHaveBeenCalledTimes(1);
  });

  it('a resize that fails as unavailable after load also falls back, and the decode is freed', async () => {
    const cv = fakeCv();
    cv.resize.mockRejectedValue(new CvUnavailable());
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'));
    stages.close();
    expect(cv.free.mock.calls).toEqual([[[11]]]);
    expect(d.prepareForRecognition).toHaveBeenCalledTimes(1);
  });

  it('a photo that won\'t decode → image_load_failed (no library text)', async () => {
    const cv = fakeCv();
    cv.load.mockRejectedValue(new CvOpFailed('decode_failed'));
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'))).rejects.toMatchObject({ code: 'image_load_failed' });
    stages.close();
    expect(d.deleteTempImages).toHaveBeenCalledWith(['blob:photo']);
    expect(cv.close).toHaveBeenCalledTimes(1);
  });

  it('abort during the cv step → cancelled; handles disposed, workers closed', async () => {
    const cv = fakeCv();
    const ac = new AbortController();
    cv.resize.mockImplementation(async () => {
      ac.abort();
      throw new RecognitionError('cancelled');
    });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'), { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    stages.close();
    expect(cv.free.mock.calls).toEqual([[[11]]]);
    expect(d.deleteTempImages).toHaveBeenCalledWith(['blob:photo']);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(session.read).not.toHaveBeenCalled();
  });

  // Review R2: was "an encode failure → failed". The original photo is still usable, so the read
  // falls back to today's prepare on it (recorded as a recognize `fallback`) instead of failing.
  it.each([
    ['an op failure', () => new CvOpFailed('process_failed')],
    ['OpenCV gone', () => new CvUnavailable()],
  ])('the encode before the read failing (%s) → `fallback`: today\'s prepare on the original photo is read; nothing leaked', async (_label, err) => {
    const cv = fakeCv();
    cv.encode.mockRejectedValue(err());
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'));
    stages.close();
    expect(r.best.verdict.ok).toBe(true);
    expect(r.trace).toContainEqual({ variant: 'cv-resize-jpeg', stage: 'recognize', event: 'fallback' });
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(cv.revoke).not.toHaveBeenCalled();
    // The fallback's prepared copy is released as soon as its read ends, the photo at dispose.
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:prepared']], [['blob:photo']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
  });

  it('a resize that fails as an op (not a decode) also falls back to today\'s prepare on the photo (R2)', async () => {
    const cv = fakeCv();
    cv.resize.mockRejectedValue(new CvOpFailed('process_failed'));
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'));
    stages.close();
    expect(r.trace).toContainEqual({ variant: 'cv-resize-jpeg', stage: 'normalize', event: 'fallback' });
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(cv.free.mock.calls).toEqual([[[11]]]);
  });

  it('the read failing still revokes the encoded URL', async () => {
    const cv = fakeCv();
    const session = fakeSession();
    session.read.mockRejectedValue(new RecognitionError('failed'));
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true, openOcrSession: () => session });
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, plan('cv-resize-jpeg'))).rejects.toMatchObject({ code: 'failed' });
    stages.close();
    expect(cv.revoke).toHaveBeenCalledWith('blob:enc-1');
  });
});

describe('variants', () => {
  it('cv variants differ from web-current only in normalize and output (one factor each)', () => {
    const base = VARIANTS['web-current']!.config;
    const jpeg = VARIANTS['cv-resize-jpeg']!.config;
    const png = VARIANTS['cv-resize-png']!.config;
    expect({ ...jpeg, normalize: undefined, recognize: { ...jpeg.recognize, output: undefined } }).toEqual({ ...base, normalize: undefined });
    expect(jpeg.normalize).toBe('cv');
    expect(jpeg.recognize.output).toBe('jpeg90');
    expect({ ...png, recognize: { ...png.recognize, output: 'jpeg90' } }).toEqual(jpeg);
  });
});

// ---------- Task 7: locate + crop ----------

/** A quad in decoded pixels: 2/3 of a 4096 × 2731 decode, slightly rotated. */
const DECODED_QUAD: Quad = [
  [700, 300],
  [3300, 360],
  [3260, 2400],
  [660, 2350],
];
const found = (confidence: number, quad: Quad | null = DECODED_QUAD): CvLocation => ({ method: 'quad', quad, confidence });

describe('locate + crop (Task 7)', () => {
  it('web-crop: one decode shared by locate and warp; quad reported in photo pixels; size rule on the crop; everything freed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();

    expect(cv.load).toHaveBeenCalledTimes(1);
    expect(cv.locate.mock.calls[0]?.[0]).toBe(11);
    // The warp gets the quad in decoded pixels again, and the spec's margin.
    const [warpId, warpQuad, margin] = cv.warp.mock.calls[0]!;
    expect(warpId).toBe(11);
    (warpQuad as Quad).forEach((p, i) => {
      expect(p[0]).toBeCloseTo(DECODED_QUAD[i]![0], 6);
      expect(p[1]).toBeCloseTo(DECODED_QUAD[i]![1], 6);
    });
    expect(margin).toBe(0.025);
    // Reported quad: decoded → source pixels.
    const att = r.attempts[0]!;
    expect(att.cropApplied).toBe(true);
    expect(att.locate.quad![1][0]).toBeCloseTo(3300 * (6000 / 4096), 6);
    expect(att.locate.quad![1][1]).toBeCloseTo(360 * (4000 / 2731), 6);
    // Normalize resizes the crop (id 12) by the size rule on the crop's own size.
    const crop = await cv.warp.mock.results[0]!.value;
    const size = targetSize(crop.width, crop.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
    expect(cv.resize.mock.calls[0]?.slice(0, 3)).toEqual([12, size.width, size.height]);
    expect(att.scale).toEqual([size.width / crop.width]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:enc-1']);
    // Decode freed right after the warp; crop and resized image at dispose. No prepare step.
    expect(cv.free.mock.calls[0]).toEqual([[11]]);
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12, 13]);
    expect(d.prepareForRecognition).not.toHaveBeenCalled();
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo']]]);
  });

  it('criterion 19/37 boundary: confidence minConfidence − 0.01 → no warp (identity), the decode reused by normalize; exactly minConfidence → crop', async () => {
    const below = fakeCv({ width: 6000, height: 4000 }, { found: found(0.49) });
    const a = deps({ openCvClient: () => below, cvPreprocess: true });
    const s1 = createWebStages(a.d);
    const r1 = await runScanPipeline(asImg('blob:photo'), s1, plan('web-crop'));
    s1.close();
    expect(below.warp).not.toHaveBeenCalled();
    expect(r1.attempts[0]!.cropApplied).toBe(false);
    expect(r1.trace).toContainEqual({ variant: 'web-crop', stage: 'crop', event: 'skipped', reason: 'low_confidence' });
    expect(below.load).toHaveBeenCalledTimes(1);
    // Whole photo: today's size rule on the source size, from the shared decode.
    expect(below.resize.mock.calls[0]?.slice(0, 3)).toEqual([11, 2048, 1365]);

    const at = fakeCv({ width: 6000, height: 4000 }, { found: found(0.5) });
    const b = deps({ openCvClient: () => at, cvPreprocess: true });
    const s2 = createWebStages(b.d);
    const r2 = await runScanPipeline(asImg('blob:photo'), s2, plan('web-crop'));
    s2.close();
    expect(at.warp).toHaveBeenCalledTimes(1);
    expect(r2.attempts[0]!.cropApplied).toBe(true);
  });

  it('cropAndFlatten itself is the identity below minConfidence, for a null quad, and with cv off (no cv call)', async () => {
    const cv = fakeCv();
    const on = createWebStages(deps({ openCvClient: () => cv, cvPreprocess: true }).d);
    const img = asImg('blob:photo');
    const opts = { marginFraction: 0.025, minConfidence: 0.5 };
    expect(await on.cropAndFlatten(img, found(0.49), opts, {})).toBe(img);
    expect(await on.cropAndFlatten(img, { method: 'mask', quad: null, confidence: 1 }, opts, {})).toBe(img);
    const openCvClient = jest.fn(() => cv);
    const off = createWebStages(deps({ openCvClient, cvPreprocess: false }).d);
    expect(await off.locateDocument(img, {})).toEqual({ method: 'none', quad: null, confidence: 0 });
    expect(await off.cropAndFlatten(img, found(1), opts, {})).toBe(img);
    expect(openCvClient).not.toHaveBeenCalled();
    on.close();
    off.close();
  });

  it('criterion 39 (D4): a receipt covering ~40% of a 480×640 frame is read at the crop\'s size rule, with more pixels per text row than today\'s whole-image rule', async () => {
    // Paper quad 250 × 490 px in a 480 × 640 frame ≈ 40% of the area.
    const paper: Quad = [
      [115, 75],
      [365, 75],
      [365, 565],
      [115, 565],
    ];
    expect((250 * 490) / (480 * 640)).toBeCloseTo(0.4, 1);
    const cv = fakeCv({ width: 480, height: 640 }, { decoded: { width: 480, height: 640 }, found: found(0.9, paper) });
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();
    const crop = await cv.warp.mock.results[0]!.value;
    const want = targetSize(crop.width, crop.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
    const [, w, h] = cv.resize.mock.calls[0]!;
    expect([w, h]).toEqual([want.width, want.height]);
    expect(Math.max(w as number, h as number)).toBe(Math.max(want.width, want.height));
    // Pixels per original pixel (so per text row): crop path vs today's rule on the whole frame.
    const cropScale = (w as number) / crop.width;
    const whole = targetSize(480, 640, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
    const wholeScale = whole.width / 480;
    expect(cropScale).toBeGreaterThan(wholeScale);
    expect(r.attempts[0]!.scale).toEqual([cropScale]);

    // Without a crop (identity), the size equals today's rule on the whole image.
    const none = fakeCv({ width: 480, height: 640 }, { decoded: { width: 480, height: 640 }, found: found(0.2, paper) });
    const n = deps({ openCvClient: () => none, cvPreprocess: true });
    const s2 = createWebStages(n.d);
    await runScanPipeline(asImg('blob:photo'), s2, plan('web-crop'));
    s2.close();
    expect(none.resize.mock.calls[0]?.slice(1, 3)).toEqual([whole.width, whole.height]);
  });

  it('OpenCV unavailable in locate → locate `unavailable` in the trace, crop skipped, normalize falls back to today\'s prepare; the scan succeeds', async () => {
    const cv = fakeCv();
    cv.load.mockRejectedValue(new CvUnavailable());
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();
    expect(r.trace).toContainEqual({ variant: 'web-crop', stage: 'locate', event: 'unavailable' });
    expect(r.trace).toContainEqual({ variant: 'web-crop', stage: 'normalize', event: 'fallback' });
    expect(r.attempts[0]!.cropApplied).toBe(false);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.best.verdict.ok).toBe(true);
  });

  it('a warp that fails → crop `unavailable`, the whole photo is read from the shared decode', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    cv.warp.mockRejectedValue(new CvOpFailed('process_failed'));
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();
    expect(r.trace).toContainEqual({ variant: 'web-crop', stage: 'crop', event: 'unavailable' });
    expect(r.attempts[0]!.cropApplied).toBe(false);
    expect(cv.load).toHaveBeenCalledTimes(1);
    expect(cv.resize.mock.calls[0]?.slice(0, 3)).toEqual([11, 2048, 1365]);
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12]);
  });

  it('OpenCV dying after the crop → normalize falls back to today\'s prepare on the original photo', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    cv.resize.mockRejectedValue(new CvUnavailable());
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.trace).toContainEqual({ variant: 'web-crop', stage: 'normalize', event: 'fallback' });
  });

  it('a crop resize failing as an op → normalize falls back to today\'s prepare on the original photo (R2)', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    cv.resize.mockRejectedValue(new CvOpFailed('process_failed'));
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'));
    stages.close();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.trace).toContainEqual({ variant: 'web-crop', stage: 'normalize', event: 'fallback' });
    expect(r.best.verdict.ok).toBe(true);
  });

  it('abort during locate → cancelled; decode freed, photo revoked, workers closed, nothing read', async () => {
    const cv = fakeCv();
    const ac = new AbortController();
    cv.locate.mockImplementation(async () => {
      ac.abort();
      throw new RecognitionError('cancelled');
    });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, plan('web-crop'), { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    stages.close();
    expect(cv.free.mock.calls).toEqual([[[11]]]);
    expect(d.deleteTempImages).toHaveBeenCalledWith(['blob:photo']);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(session.read).not.toHaveBeenCalled();
  });
});

describe('web-crop variant', () => {
  it('differs from cv-resize-jpeg only by locate + crop, with the spec\'s starting values', () => {
    const crop = VARIANTS['web-crop']!.config;
    const base = VARIANTS['cv-resize-jpeg']!.config;
    expect({ ...crop, locate: false, crop: false }).toEqual(base);
    expect(crop.locate).toBe(true);
    expect(crop.crop).toEqual({ marginFraction: 0.025, minConfidence: 0.5 });
    expect(usesCv(crop)).toBe(true);
    expect(usesCv(VARIANTS['web-current']!.config)).toBe(false);
    expect(usesCv(base)).toBe(true);
  });
});

// ---------- Task 7 follow-up: crop in OpenCV, size step on today's canvas path ----------

describe('web-crop-canvas (OpenCV locate + warp only; today\'s canvas resize on the crop)', () => {
  type Prepare = WebStageDeps['prepareForRecognition'];
  // `deps()` always exposes its own prepare mock, so a test changes that mock's implementation.
  const run = async (cv: FakeCv, prepareImpl?: Prepare, signal?: AbortSignal) => {
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    if (prepareImpl) d.prepareForRecognition.mockImplementation(prepareImpl);
    const stages = createWebStages(d);
    const result = runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-canvas'), { signal });
    return { d, session, stages, result };
  };

  it('is web-current + locate + crop: no cv normalize, no cv output encoding', () => {
    const v = VARIANTS['web-crop-canvas']!;
    expect(v.platform).toBe('web');
    expect({ ...v.config, locate: false, crop: false }).toEqual(VARIANTS['web-current']!.config);
    expect(v.config.locate).toBe(true);
    expect(v.config.crop).toEqual(VARIANTS['web-crop']!.config.crop);
    expect(v.config.normalize).toBeUndefined();
    expect(v.config.recognize.output).toBeUndefined();
    expect(usesCv(v.config)).toBe(true);
  });

  it('crop → lossless PNG handoff → today\'s prepare on it → read; no OpenCV resize; every intermediate freed or revoked', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const { d, session, stages, result } = await run(cv, async () => ({ uri: 'blob:prepared', width: 1200, height: 2048 }));
    const r = await result;
    stages.close();

    expect(cv.load).toHaveBeenCalledTimes(1);
    expect(cv.warp).toHaveBeenCalledTimes(1);
    expect(cv.resize).not.toHaveBeenCalled();
    // The crop (id 12) leaves the worker as PNG, never JPEG, and only once.
    expect(cv.encode.mock.calls.map((c) => c.slice(0, 2))).toEqual([[12, 'png']]);
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:enc-1']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    // The PNG is revoked once prepare has its own copy, before the read.
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1']]);
    expect(cv.revoke.mock.invocationCallOrder[0]!).toBeGreaterThan(d.prepareForRecognition.mock.invocationCallOrder[0]!);
    expect(cv.revoke.mock.invocationCallOrder[0]!).toBeLessThan(session.read.mock.invocationCallOrder[0]!);
    // Decode freed after the warp, the crop at dispose; the photo and the prepared copy revoked.
    expect(cv.free.mock.calls).toEqual([[[11]], [[12]]]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
    const crop = await cv.warp.mock.results[0]!.value;
    const att = r.attempts[0]!;
    expect(att.cropApplied).toBe(true);
    expect(att.scale).toEqual([1200 / crop.width]);
    expect(r.trace.some((t) => t.event === 'fallback' || t.event === 'unavailable')).toBe(false);
  });

  it('below minConfidence: no warp, no encode; the photo goes through today\'s prepare exactly like web-current, and the decode is freed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.49) });
    const { d, session, stages, result } = await run(cv);
    const r = await result;
    stages.close();
    expect(cv.warp).not.toHaveBeenCalled();
    expect(cv.encode).not.toHaveBeenCalled();
    expect(cv.resize).not.toHaveBeenCalled();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[])).toEqual([11]);
    expect(r.attempts[0]!.cropApplied).toBe(false);
    expect(r.attempts[0]!.scale).toEqual([null]);
  });

  it('OpenCV unavailable (fails to load): locate `unavailable`, no crop, today\'s prepare on the photo (identity); the scan succeeds', async () => {
    const cv = fakeCv();
    cv.load.mockRejectedValue(new CvUnavailable());
    const { d, session, stages, result } = await run(cv);
    const r = await result;
    stages.close();
    expect(r.trace).toContainEqual({ variant: 'web-crop-canvas', stage: 'locate', event: 'unavailable' });
    expect(r.attempts[0]!.cropApplied).toBe(false);
    expect(cv.warp).not.toHaveBeenCalled();
    expect(cv.encode).not.toHaveBeenCalled();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.best.verdict.ok).toBe(true);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
  });

  it('OpenCV dying between the warp and the PNG handoff → `fallback`: today\'s prepare on the original photo', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    cv.encode.mockRejectedValue(new CvUnavailable());
    const { d, session, stages, result } = await run(cv);
    const r = await result;
    stages.close();
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.trace).toContainEqual({ variant: 'web-crop-canvas', stage: 'normalize', event: 'fallback' });
    expect(cv.revoke).not.toHaveBeenCalled();
    expect(cv.close).toHaveBeenCalledTimes(1);
  });

  // Review R2: was "the PNG encode failing as an op → image_load_failed ... nothing read". The changed
  // assertion: the scan no longer rejects with image_load_failed; like OpenCV dying (the test above),
  // an op failure falls back to today's prepare on the original photo, which is read.
  it('the PNG encode failing as an op → `fallback`: today\'s prepare on the original photo; crop freed, photo revoked, workers closed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    cv.encode.mockRejectedValue(new CvOpFailed('process_failed'));
    const { d, session, stages, result } = await run(cv);
    const r = await result;
    stages.close();
    expect(r.trace).toContainEqual({ variant: 'web-crop-canvas', stage: 'normalize', event: 'fallback' });
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
    expect(r.best.verdict.ok).toBe(true);
    expect(cv.revoke).not.toHaveBeenCalled();
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('prepare failing on the PNG → image_load_failed; the PNG URL is still revoked and the crop freed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const { d, session, stages, result } = await run(cv, async () => {
      throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
    });
    await expect(result).rejects.toMatchObject({ code: 'image_load_failed' });
    stages.close();
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1']]);
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo']]]);
    expect(session.read).not.toHaveBeenCalled();
  });

  it('abort during the PNG handoff → cancelled; crop freed, photo revoked, workers closed, nothing prepared or read', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const ac = new AbortController();
    cv.encode.mockImplementation(async () => {
      ac.abort();
      throw new RecognitionError('cancelled');
    });
    const { d, session, stages, result } = await run(cv, undefined, ac.signal);
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    stages.close();
    expect(d.prepareForRecognition).not.toHaveBeenCalled();
    expect(cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.read).not.toHaveBeenCalled();
  });

  it('abort while prepare is running → cancelled at the next step; the PNG and the prepared copy are both released', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const ac = new AbortController();
    const { d, session, stages, result } = await run(
      cv,
      async () => {
        ac.abort();
        return { uri: 'blob:prepared', width: 1200, height: 2048 };
      },
      ac.signal,
    );
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    stages.close();
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1']]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(session.read).not.toHaveBeenCalled();
  });
});

describe('Tesseract settings (spec Task 5)', () => {
  it('web-current reads with today\'s options only (no tesseract settings, no image dump)', async () => {
    const { d, session } = deps();
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan('web-current'));
    stages.close();
    const opts = session.read.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(opts).sort()).toEqual(['onProgress', 'onStage', 'signal']);
  });

  it.each(['web-tess-thresh2-dpi300', 'web-tess-rotate', 'web-tess-nodict'])('%s passes its tesseract settings to the session', async (name) => {
    const { d, session } = deps();
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan(name));
    stages.close();
    expect(session.read.mock.calls[0]?.[1]).toMatchObject({ tesseract: VARIANTS[name]!.config.recognize.tesseract });
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
  });

  it('onImageBinary (harness) is passed to every read', async () => {
    const onImageBinary = jest.fn();
    const { d, session } = deps({ onImageBinary });
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan('web-current'));
    stages.close();
    expect(session.read.mock.calls[0]?.[1]).toMatchObject({ onImageBinary });
  });

  it('meanLineConfidence is the mean of the lines\' confidences, or null without any', async () => {
    const { d, session } = deps();
    const stages = createWebStages(d);
    session.read.mockResolvedValueOnce({ lines: [{ text: 'a', confidence: 80 }, { text: 'b', confidence: 60 }] });
    await expect(stages.recognize(asImg('blob:x'), VARIANTS['web-current']!.config.recognize, {})).resolves.toMatchObject({ meanLineConfidence: 70 });
    await expect(stages.recognize(asImg('blob:y'), VARIANTS['web-current']!.config.recognize, {})).resolves.toMatchObject({ meanLineConfidence: null });
    stages.close();
  });
});

// ---------- Task 8: size on the crop + the text-height second pass ----------

describe('text-height second pass (Task 8)', () => {
  // TEXT's lines are all 20 px tall, so the first read's median is 20.
  const withRescale = (name: string, targetLineHeightPx: number): ResolvedPlan => {
    const base = VARIANTS[name]!.config;
    return {
      primary: { variant: `${name}+th`, config: { ...base, textHeightRescale: { targetLineHeightPx, band: [0.85, 1.15] } } },
      retry: null,
    };
  };
  const prepareAtSize = () =>
    jest.fn(async (_uri: string, size: { width: number; height: number }) => ({ uri: 'blob:prepared-2', ...size }));

  it('recognize reports the read\'s median line height', async () => {
    const { d } = deps();
    const stages = createWebStages(d);
    await expect(stages.recognize(asImg('blob:x'), VARIANTS['web-current']!.config.recognize, {})).resolves.toMatchObject({
      medianLineHeight: 20,
    });
    stages.close();
  });

  it('crop on the canvas path: the crop (not the first-pass JPEG) is re-encoded as PNG and resized to first size × factor; all freed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const atSize = prepareAtSize();
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true, prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-crop-canvas', 40));
    stages.close();

    // Both passes start from the crop (id 12), each as its own lossless PNG.
    expect(cv.encode.mock.calls.map((c) => c.slice(0, 2))).toEqual([[12, 'png'], [12, 'png']]);
    expect(d.prepareForRecognition.mock.calls).toEqual([['blob:enc-1']]);
    // 40 / 20 = 2 × the first pass's 600 × 1000.
    expect(atSize.mock.calls).toEqual([['blob:enc-2', { width: 1200, height: 2000 }]]);
    expect(cv.resize).not.toHaveBeenCalled();
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared', 'blob:prepared-2']);
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1'], ['blob:enc-2']]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared', 'blob:prepared-2']]]);
    expect(cv.free.mock.calls).toEqual([[[11]], [[12]]]);
    const crop = await cv.warp.mock.results[0]!.value;
    expect(r.attempts[0]).toMatchObject({ passes: 2, cropApplied: true, scale: [600 / crop.width, 1200 / crop.width] });
  });

  it('no crop: the photo itself is resized again (never the first-pass image)', async () => {
    const atSize = prepareAtSize();
    const { d, session } = deps({ prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 1200, height: 1600 }));
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-current', 14));
    stages.close();
    // 14 / 20 = 0.7 × 1200 × 1600.
    expect(atSize.mock.calls).toEqual([['blob:photo', { width: 840, height: 1120 }]]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared', 'blob:prepared-2']);
    expect(r.attempts[0]).toMatchObject({ passes: 2, scale: [null, null] });
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared', 'blob:prepared-2']]]);
  });

  it('median in band → one read, no second resize', async () => {
    const atSize = prepareAtSize();
    const { d, session } = deps({ prepareAtSize: atSize });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-current', 20));
    stages.close();
    expect(atSize).not.toHaveBeenCalled();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({ variant: 'web-current+th', stage: 'normalize', event: 'skipped', reason: 'in_band' });
  });

  it('already at the size cap → no identical second read', async () => {
    const atSize = prepareAtSize();
    const { d, session } = deps({ prepareAtSize: atSize });
    // deps()'s prepare returns 2048 × 1365, the cap; a factor of 2 can't grow it.
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-current', 40));
    stages.close();
    expect(atSize).not.toHaveBeenCalled();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({ variant: 'web-current+th', stage: 'normalize', event: 'skipped', reason: 'no_change' });
  });

  it('a factor below 1 at the cap still shrinks (the cap only limits growth)', async () => {
    const atSize = prepareAtSize();
    const { d } = deps({ prepareAtSize: atSize });
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-current', 10));
    stages.close();
    expect(atSize.mock.calls).toEqual([['blob:photo', { width: 1024, height: 683 }]]);
  });

  it('without prepareAtSize the canvas path has no second pass', async () => {
    const { d, session } = deps();
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-current', 40));
    stages.close();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.attempts[0]?.passes).toBe(1);
  });

  it('cv variant: the crop is resized in the worker to the exact second-pass size', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-crop', 15));
    stages.close();
    const crop = await cv.warp.mock.results[0]!.value;
    const first = targetSize(crop.width, crop.height, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
    // 15 / 20 = 0.75 × the first pass (which is at the long-edge cap here).
    const second = secondPassSize(first, 0.75, RECOGNITION_MAX_EDGE)!;
    expect(second).not.toBeNull();
    expect(cv.resize.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      [12, first.width, first.height],
      [12, second.width, second.height],
    ]);
    expect(r.attempts[0]?.passes).toBe(2);
    expect(d.prepareForRecognition).not.toHaveBeenCalled();
  });

  it('OpenCV gone by the second pass → the first read stands; the scan still succeeds', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const atSize = prepareAtSize();
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true, prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    cv.encode.mockResolvedValueOnce('blob:enc-1').mockRejectedValueOnce(new CvUnavailable());
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-crop-canvas', 40));
    stages.close();
    expect(atSize).not.toHaveBeenCalled();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.best.verdict.ok).toBe(true);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
  });

  it('a second-pass encode failing as an op → the first read stands, recorded as a normalize `fallback` (R2)', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const atSize = prepareAtSize();
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true, prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    cv.encode.mockResolvedValueOnce('blob:enc-1').mockRejectedValueOnce(new CvOpFailed('process_failed'));
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, withRescale('web-crop-canvas', 40));
    stages.close();
    expect(atSize).not.toHaveBeenCalled();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.best.verdict.ok).toBe(true);
    expect(r.attempts[0]!.passes).toBe(1);
    expect(r.trace).toContainEqual({ variant: 'web-crop-canvas+th', stage: 'normalize', event: 'fallback' });
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
  });

  it('a failed second resize rejects the scan with its code, and everything is still freed and revoked', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const atSize = jest.fn(async () => {
      throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
    });
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true, prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, withRescale('web-crop-canvas', 40))).rejects.toMatchObject({
      code: 'image_load_failed',
    });
    stages.close();
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1'], ['blob:enc-2']]);
    expect(cv.free.mock.calls).toEqual([[[11]], [[12]]]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
  });
});

describe('enhance (Task 9)', () => {
  const STEPS = VARIANTS['web-crop-flatten']!.config.enhance;

  it('E3 variants: one step at a time on top of web-crop-canvas / web-crop-th40, PNG handoff, never anything else', () => {
    const cfg = (n: string) => VARIANTS[n]!.config;
    for (const [base, prefix] of [['web-crop-canvas', 'web-crop'], ['web-crop-th40', 'web-crop-th40']] as const) {
      const gray = cfg(`${prefix}-gray`);
      expect({ ...gray, enhance: false, recognize: { ...gray.recognize, output: undefined } }).toEqual({
        ...cfg(base),
        recognize: { ...cfg(base).recognize, output: undefined },
      });
      expect(gray.enhance).toEqual({ gray: true, flatten: false, clahe: false });
      expect(gray.recognize.output).toBe('png');
      expect({ ...cfg(`${prefix}-flatten`), enhance: gray.enhance }).toEqual(gray);
      expect(cfg(`${prefix}-flatten`).enhance).toEqual({ gray: true, flatten: { kernelLineHeights: 4 }, clahe: false });
      expect({ ...cfg(`${prefix}-flatten-clahe`), enhance: cfg(`${prefix}-flatten`).enhance }).toEqual(cfg(`${prefix}-flatten`));
      expect(cfg(`${prefix}-flatten-clahe`).enhance).toEqual({ gray: true, flatten: { kernelLineHeights: 4 }, clahe: { clipLimit: 2, tile: 8 } });
    }
  });

  it('crop on the canvas path: prepare\'s JPEG is loaded into the worker, enhanced, the load freed at once, the result read as PNG; all freed', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-flatten'));
    stages.close();
    // 11 = photo decode, 12 = crop, 13 = prepare's JPEG loaded, 14 = enhanced.
    expect(cv.load.mock.calls.map((c) => c[0])).toEqual(['blob:photo', 'blob:prepared']);
    expect(cv.enhance.mock.calls.map((c) => c.slice(0, 2))).toEqual([[13, STEPS]]);
    expect(cv.encode.mock.calls.map((c) => c.slice(0, 2))).toEqual([[12, 'png'], [14, 'png']]);
    expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:enc-2']);
    expect(cv.revoke.mock.calls).toEqual([['blob:enc-1'], ['blob:enc-2']]);
    // Decode after the warp, the loaded JPEG right after enhance, then crop + enhanced at dispose.
    expect(cv.free.mock.calls).toEqual([[[11]], [[13]], [[12, 14]]]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(r.trace.some((t) => t.event === 'unavailable' || t.event === 'fallback')).toBe(false);
    expect(cv.close).toHaveBeenCalledTimes(1);
  });

  it('the enhanced image\'s encode failing → `fallback`: the prepared (unenhanced) image it came from is read (R2)', async () => {
    for (const err of [new CvOpFailed('process_failed'), new CvUnavailable()]) {
      const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
      cv.encode.mockResolvedValueOnce('blob:enc-1').mockRejectedValueOnce(err);
      const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
      const stages = createWebStages(d);
      const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-flatten'));
      stages.close();
      expect(r.trace).toContainEqual({ variant: 'web-crop-flatten', stage: 'recognize', event: 'fallback' });
      expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
      // Only the crop's PNG went through prepare: the fallback reads prepare's copy, no new one.
      expect(d.prepareForRecognition).toHaveBeenCalledTimes(1);
      expect(r.best.verdict.ok).toBe(true);
      expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    }
  });

  it('an image already in the worker (cv resize) is enhanced in place, with no extra load', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 });
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    const config = { ...VARIANTS['cv-resize-png']!.config, enhance: STEPS };
    await runScanPipeline(asImg('blob:photo'), stages, { primary: { variant: 'x', config }, retry: null });
    stages.close();
    expect(cv.load).toHaveBeenCalledTimes(1);
    expect(cv.enhance.mock.calls[0]?.[0]).toBe(12);
    expect(cv.encode.mock.calls.map((c) => c.slice(0, 2))).toEqual([[13, 'png']]);
  });

  it('enhance failing (op error or OpenCV gone) → `unavailable` in the trace, the unenhanced image is read; the scan succeeds and the load is freed', async () => {
    for (const err of [new CvOpFailed('process_failed'), new CvUnavailable()]) {
      const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
      cv.enhance.mockRejectedValue(err);
      const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
      const stages = createWebStages(d);
      const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-flatten'));
      stages.close();
      expect(r.trace).toContainEqual({ variant: 'web-crop-flatten', stage: 'enhance', event: 'unavailable' });
      expect(session.read.mock.calls.map((c) => c[0])).toEqual(['blob:prepared']);
      expect(cv.free.mock.calls).toContainEqual([[13]]);
      expect(r.best.verdict.ok).toBe(true);
    }
  });

  it('abort during enhance → cancelled; the load freed, every handle disposed, workers closed, nothing read', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const ac = new AbortController();
    cv.enhance.mockImplementation(async () => {
      ac.abort();
      throw new RecognitionError('cancelled');
    });
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await expect(runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-flatten'), { signal: ac.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    stages.close();
    expect(session.read).not.toHaveBeenCalled();
    expect(cv.free.mock.calls).toEqual([[[11]], [[13]], [[12]]]);
    expect(d.deleteTempImages.mock.calls).toEqual([[['blob:photo', 'blob:prepared']]]);
    expect(cv.close).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('with the text-height second pass, each pass\'s image is enhanced (web-crop-th40-flatten)', async () => {
    const cv = fakeCv({ width: 6000, height: 4000 }, { found: found(0.9) });
    const atSize = jest.fn(async (_u: string, size: { width: number; height: number }) => ({ uri: 'blob:prepared-2', ...size }));
    const { d, session } = deps({ openCvClient: () => cv, cvPreprocess: true, prepareAtSize: atSize });
    d.prepareForRecognition.mockImplementation(async () => ({ uri: 'blob:prepared', width: 600, height: 1000 }));
    const stages = createWebStages(d);
    // TEXT's lines are 20 px: outside 40 ± 15%, so a second pass runs.
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-crop-th40-flatten'));
    stages.close();
    expect(r.attempts[0]!.passes).toBe(2);
    expect(cv.load.mock.calls.map((c) => c[0])).toEqual(['blob:photo', 'blob:prepared', 'blob:prepared-2']);
    expect(cv.enhance).toHaveBeenCalledTimes(2);
    expect(session.read).toHaveBeenCalledTimes(2);
    expect(cv.revoke).toHaveBeenCalledTimes(cv.encode.mock.calls.length);
  });

  it('enhance false, or every step off, is the identity with no cv call', async () => {
    const cv = fakeCv();
    const { d } = deps({ openCvClient: () => cv, cvPreprocess: true });
    const stages = createWebStages(d);
    await expect(stages.enhance(asImg('blob:x'), false, {})).resolves.toBe('blob:x');
    await expect(stages.enhance(asImg('blob:x'), { gray: false, flatten: false, clahe: false }, {})).resolves.toBe('blob:x');
    expect(cv.load).not.toHaveBeenCalled();
    expect(cv.enhance).not.toHaveBeenCalled();
    stages.close();
  });
});

// ---------- Task 13: zoom on doubt ----------

describe('zoom on doubt (Task 13)', () => {
  // A read whose "Gadget" price lost a digit, so the items don't add up to the subtotal.
  const ROWS: [string, number][] = [
    ['Cafe', 90],
    ['Widget 4.00', 90],
    ['Gadget $6.0', 40],
    ['Subtotal 10.00', 90],
    ['Tax 1.00', 90],
    ['Total 11.00', 90],
  ];
  const DOUBTFUL: RecognizedText = {
    lines: ROWS.map(([text, confidence], i) => ({ text, confidence, box: { x: 0, y: i * 30, width: 300, height: 20 } })),
  };
  const PSM7 = expect.objectContaining({ tessedit_pageseg_mode: '7' });
  /** The crop's URL names the row it was cut from (rect.y = row × 30 − the 10 px margin). */
  const cropAtScale = () =>
    jest.fn(async (_uri: string, rect: { x: number; y: number; width: number; height: number }, scale: number) => ({
      uri: `blob:row-${Math.round((rect.y + 10) / 30)}`,
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    }));
  /** Main reads get DOUBTFUL; a row read gets `rows[n]` (default: nothing read). */
  function answer(session: ReturnType<typeof fakeSession>, rows: Record<number, RecognizedText | Error | Promise<never>> = {}) {
    session.read.mockImplementation(async (uri: string) => {
      const m = /^blob:row-(\d+)$/.exec(uri);
      if (!m) return DOUBTFUL;
      const a = rows[Number(m[1])];
      if (a instanceof Error) throw a;
      return a ?? { lines: [] };
    });
  }
  const one = (text: string, confidence: number): RecognizedText => ({ lines: [{ text, confidence, box: { x: 0, y: 0, width: 600, height: 40 } }] });
  const zoomReads = (session: ReturnType<typeof fakeSession>) => session.read.mock.calls.filter((c) => String(c[0]).startsWith('blob:row-'));

  it('variants: web-current-zoom / web-crop-th40-zoom add only zoomOnDoubt to their bases; production unchanged', () => {
    const cur = VARIANTS['web-current-zoom']!.config;
    const th40 = VARIANTS['web-crop-th40-zoom']!.config;
    expect({ ...cur, recognize: { ...cur.recognize, zoomOnDoubt: false } }).toEqual(VARIANTS['web-current']!.config);
    expect({ ...th40, recognize: { ...th40.recognize, zoomOnDoubt: false } }).toEqual(VARIANTS['web-crop-th40']!.config);
    expect(cur.recognize.zoomOnDoubt).toEqual({ minLineConfidence: 60, maxRows: 8, minConfidenceGain: 5, targetLineHeightPx: 40 });
    expect(th40.recognize.zoomOnDoubt).toMatchObject({ targetLineHeightPx: 40 });
    expect(usesCv(cur)).toBe(false);
    expect(VARIANTS['web-current']!.config.recognize.zoomOnDoubt).toBe(false);
  });

  it('re-reads the doubtful rows from the image that pass read, as single lines (PSM 7) on the one session; replaces the accepted row; releases every crop', async () => {
    const crop = cropAtScale();
    const onZoom = jest.fn();
    const { d, session } = deps({ cropAtScale: crop, onZoom });
    answer(session, { 2: one('Gadget $6.00', 85) });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-current-zoom'));
    stages.close();

    // The broken price first, then the priced rows the failed sums implicate.
    expect(crop.mock.calls.map((c) => c[0])).toEqual(Array(5).fill('blob:prepared'));
    expect(crop.mock.calls.map((c) => Math.round((c[1].y + 10) / 30))).toEqual([2, 1, 3, 4, 5]);
    // max(10, 0.3 × 20) = 10 px margin; 20 px boxes scaled to the 40 px target.
    expect(crop.mock.calls[0]?.slice(1)).toEqual([{ x: -10, y: 50, width: 320, height: 40 }, 2]);
    const reads = zoomReads(session);
    expect(reads).toHaveLength(5);
    for (const [, opts] of reads) {
      expect(opts).toEqual({ signal: undefined, tesseract: { params: PSM7 } });
    }
    expect(r.best.text.lines[2]).toEqual({ text: 'Gadget $6.00', confidence: 85, box: DOUBTFUL.lines[2]?.box });
    expect(r.best.verdict.ok).toBe(true);
    expect(r.best.parsed.items.map((i) => i.totalCents)).toEqual([400, 600]);
    // Every crop URL is released, and the photo and the prepared copy as before.
    const released = d.deleteTempImages.mock.calls.flatMap((c) => c[0]);
    expect(released.filter((u) => String(u).startsWith('blob:row-')).sort()).toEqual(['blob:row-1', 'blob:row-2', 'blob:row-3', 'blob:row-4', 'blob:row-5']);
    expect(released).toEqual(expect.arrayContaining(['blob:photo', 'blob:prepared']));
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(onZoom.mock.calls[0]?.[0]).toMatchObject({ kept: 'zoomed', stopped: null });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the variant\'s own Tesseract params and init for the row reads, with PSM 7 on top', async () => {
    const crop = cropAtScale();
    const { d, session } = deps({ cropAtScale: crop });
    answer(session);
    const stages = createWebStages(d);
    const config = {
      ...VARIANTS['web-current-zoom']!.config.recognize,
      tesseract: { params: { user_defined_dpi: '300', tessedit_pageseg_mode: '6' }, init: { load_system_dawg: '0' }, rotateAuto: true },
    };
    await stages.recognize(asImg('blob:prepared'), config, {});
    stages.close();
    expect(session.read.mock.calls[0]?.[1]).toMatchObject({ tesseract: config.tesseract });
    expect(zoomReads(session)[0]?.[1]).toEqual({
      signal: undefined,
      tesseract: { params: { user_defined_dpi: '300', tessedit_pageseg_mode: '7' }, init: { load_system_dawg: '0' } },
    });
  });

  it('zoom off (web-current) never crops or re-reads', async () => {
    const crop = cropAtScale();
    const { d, session } = deps({ cropAtScale: crop });
    answer(session);
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, plan('web-current'));
    stages.close();
    expect(crop).not.toHaveBeenCalled();
    expect(session.read).toHaveBeenCalledTimes(1);
  });

  it('no crop function injected → no zoom, recorded as a recognize `fallback`', async () => {
    const { d, session } = deps();
    answer(session);
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-current-zoom'));
    stages.close();
    expect(session.read).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({ variant: 'web-current-zoom', stage: 'recognize', event: 'fallback' });
  });

  it('cancel during a row read → cancelled; that crop released, nothing more read, session closed, photo revoked', async () => {
    const crop = cropAtScale();
    const { d, session } = deps({ cropAtScale: crop });
    const c = new AbortController();
    session.read.mockImplementation(async (uri: string, opts?: { signal?: AbortSignal }) => {
      if (!uri.startsWith('blob:row-')) return DOUBTFUL;
      c.abort();
      expect(opts?.signal).toBe(c.signal);
      throw new RecognitionError('cancelled');
    });
    const stages = createWebStages(d);
    const p = runScanPipeline(asImg('blob:photo'), stages, plan('web-current-zoom'), { signal: c.signal });
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    stages.close();
    expect(crop).toHaveBeenCalledTimes(1);
    expect(zoomReads(session)).toHaveLength(1);
    const released = d.deleteTempImages.mock.calls.flatMap((x) => x[0]);
    expect(released).toEqual(expect.arrayContaining(['blob:row-2', 'blob:photo', 'blob:prepared']));
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('a row read timing out stops the zoom; the scan keeps the first read (no failure), the crop is released', async () => {
    const crop = cropAtScale();
    const onZoom = jest.fn();
    const { d, session } = deps({ cropAtScale: crop, onZoom });
    answer(session, { 2: new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT') });
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-current-zoom'));
    stages.close();
    expect(zoomReads(session)).toHaveLength(1);
    expect(r.best.text).toEqual(DOUBTFUL);
    expect(onZoom.mock.calls[0]?.[0]).toMatchObject({ stopped: 'timeout', kept: 'unchanged' });
    expect(d.deleteTempImages.mock.calls.flatMap((x) => x[0])).toContain('blob:row-2');
  });

  it('a crop that fails skips that row; the others are still read', async () => {
    const good = cropAtScale();
    const crop = jest.fn(async (uri: string, rect: { x: number; y: number; width: number; height: number }, scale: number) => {
      if (good.mock.calls.length === 0) {
        good.mock.calls.push([uri, rect, scale]);
        throw new RecognitionError('image_load_failed', 'PREPARE_FAILED');
      }
      return good(uri, rect, scale);
    });
    const { d, session } = deps({ cropAtScale: crop });
    answer(session);
    const stages = createWebStages(d);
    const r = await runScanPipeline(asImg('blob:photo'), stages, plan('web-current-zoom'));
    stages.close();
    expect(crop).toHaveBeenCalledTimes(5);
    expect(zoomReads(session)).toHaveLength(4);
    expect(r.best.text).toEqual(DOUBTFUL);
  });

  it('an image held in the OpenCV worker: rows are cut from its encoded URL before that URL is revoked', async () => {
    const cv = fakeCv();
    const crop = cropAtScale();
    const { d, session } = deps({ cropAtScale: crop, openCvClient: () => cv, cvPreprocess: true });
    answer(session);
    const order: string[] = [];
    crop.mockImplementation(async (uri, rect, scale) => {
      order.push(`crop:${uri}`);
      return { uri: `blob:row-${Math.round((rect.y + 10) / 30)}`, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
    });
    cv.revoke.mockImplementation((u: string) => order.push(`revoke:${u}`));
    const base = VARIANTS['cv-resize-jpeg']!.config;
    const zoomPlan: ResolvedPlan = {
      primary: { variant: 'cv+zoom', config: { ...base, recognize: { ...base.recognize, zoomOnDoubt: VARIANTS['web-current-zoom']!.config.recognize.zoomOnDoubt } } },
      retry: null,
    };
    const stages = createWebStages(d);
    await runScanPipeline(asImg('blob:photo'), stages, zoomPlan);
    stages.close();
    expect(order[0]).toBe('crop:blob:enc-1');
    expect(order[order.length - 1]).toBe('revoke:blob:enc-1');
    expect(order.filter((o) => o.startsWith('crop:'))).toHaveLength(5);
  });
});
