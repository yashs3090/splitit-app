// Web stages: strip tiling for tall receipts (spec Task 12, criteria 55–57). A fake OpenCV client, a
// fake canvas crop and a fake OCR session; the row-ink profiles come from rendered synthetic pages
// (test-utils/tallReceipt.ts), never from a receipt photo (criterion 70).
// Endings, each tested: success; not tall / no plan / OpenCV failing → the whole image as usual;
// cancel and timeout mid-strips; every strip image, the crop's PNG and the crop itself released.
import { RECOGNITION_MAX_EDGE, type Rect } from '../../imageSize';
import type { RecognizedLine, RecognizedText } from '../../receiptTypes';
import { RecognitionError } from '../../recognitionError';
import type { OcrSession, SessionReadOptions } from '../../webOcrSession';
import { renderTallPage, type TallPage } from '../../../test-utils/tallReceipt';
import { resolvePlan, VARIANTS } from '../config';
import { runScanPipeline } from '../run';
import { DEFAULT_TILING } from '../stripTiling';
import { asImg, type Quad } from '../types';
import { CvOpFailed, type CvClient } from './cvClient';
import { rowInkFromGray } from './cv/rowInk';
import type { CvLocation } from './cv/protocol';
import { createWebStages, type TileReport, type WebStageDeps } from './stages';

const plan = (name: string) => resolvePlan({ primary: name, retry: null }, 'web');

const LONG = renderTallPage({ width: 600, height: 3600 });
const LONG_INK = rowInkFromGray(LONG.gray, LONG.width, LONG.height);

/** What the fake canvas cut: strip URL → its rect (source pixels) and scale. */
type Cut = { base: string; rect: Rect; scale: number };

function fakeCrop() {
  const cuts = new Map<string, Cut>();
  let n = 0;
  const fn = jest.fn(async (base: string, rect: Rect, scale: number) => {
    const uri = `blob:strip-${++n}`;
    cuts.set(uri, { base, rect, scale });
    return { uri, width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
  });
  return { fn, cuts };
}

/**
 * A session that "reads" a strip: one line per text row of `page` wholly inside the strip's rect,
 * boxed in strip pixels, text `Item <row> <row>.00`. A read of anything else returns `whole`.
 */
function fakeSession(page: TallPage, cuts: Map<string, Cut>, whole: RecognizedText = { lines: [] }) {
  const s = {
    read: jest.fn(async (uri: string, opts?: SessionReadOptions): Promise<RecognizedText> => {
      opts?.onProgress?.(0.5);
      opts?.onProgress?.(1);
      const cut = cuts.get(uri);
      if (!cut) return whole;
      // The photo case: the strip rect is in source pixels; the page is drawn at `ratio` of them.
      const k = page.height / (cut.base === 'blob:photo' ? PHOTO.height : page.height);
      const lines: RecognizedLine[] = page.rows.flatMap((r, i) => {
        const top = r.top / k;
        const bottom = r.bottom / k;
        if (top < cut.rect.y || bottom > cut.rect.y + cut.rect.height) return [];
        const box = { x: 30 * cut.scale, y: (top - cut.rect.y) * cut.scale, width: 400 * cut.scale, height: (bottom - top) * cut.scale };
        return [{ text: `Item ${i} ${i}.00`, box, confidence: 80 }];
      });
      return { lines };
    }),
    close: jest.fn(),
  };
  return s as OcrSession & typeof s;
}

const DECODED_QUAD: Quad = [
  [100, 50],
  [800, 50],
  [800, 4000],
  [100, 4000],
];
/** The photo for the no-crop case: 1000 × 6000 source, decoded under the 4096 cap. */
const PHOTO = { width: 1000, height: 6000 };

type FakeCv = CvClient & { [K in 'load' | 'resize' | 'locate' | 'warp' | 'enhance' | 'encode' | 'rowInk' | 'revoke' | 'free' | 'close']: jest.Mock };
function fakeCv(o: { crop?: { width: number; height: number } | null; ink?: Uint32Array; decoded?: { width: number; height: number }; source?: { width: number; height: number } } = {}): FakeCv {
  let id = 10;
  let url = 0;
  const crop = o.crop === undefined ? { width: LONG.width, height: LONG.height } : o.crop;
  const source = o.source ?? { width: 3024, height: 4032 };
  const decoded = o.decoded ?? { width: 3072, height: 4096 };
  const found: CvLocation = crop ? { method: 'quad', quad: DECODED_QUAD, confidence: 0.9 } : { method: 'none', quad: null, confidence: 0 };
  return {
    started: true,
    load: jest.fn(async () => ({ id: ++id, ...decoded, sourceWidth: source.width, sourceHeight: source.height })),
    resize: jest.fn(async (_id: number, width: number, height: number) => ({ id: ++id, width, height })),
    locate: jest.fn(async () => found),
    warp: jest.fn(async () => ({ id: ++id, ...(crop ?? { width: 1, height: 1 }) })),
    enhance: jest.fn(async () => ({ id: ++id, width: 1, height: 1, lineHeightPx: null, kernelPx: null, greyLevels: 200 })),
    encode: jest.fn(async () => `blob:enc-${++url}`),
    rowInk: jest.fn(async () => o.ink ?? LONG_INK),
    revoke: jest.fn(),
    free: jest.fn(),
    close: jest.fn(),
  };
}

function setup(o: { cv?: FakeCv; page?: TallPage; whole?: RecognizedText; over?: Partial<WebStageDeps> } = {}) {
  const page = o.page ?? LONG;
  const crop = fakeCrop();
  const session = fakeSession(page, crop.cuts, o.whole);
  const cv = o.cv ?? fakeCv();
  const prepareForRecognition = jest.fn(async (_uri: string) => ({ uri: 'blob:prepared', width: 341, height: 2048 }));
  const prepareAtSize = jest.fn(async (_uri: string, size: { width: number; height: number }) => ({ uri: 'blob:prepared-2', ...size }));
  const deleteTempImages = jest.fn(async (_uris: readonly (string | null | undefined)[]) => undefined);
  const tiles: TileReport[] = [];
  const d: WebStageDeps = {
    prepareForRecognition,
    prepareAtSize,
    deleteTempImages,
    cropAtScale: crop.fn,
    openOcrSession: () => session,
    openCvClient: () => cv,
    cvPreprocess: true,
    onTiles: (t) => tiles.push(t),
    ...o.over,
  };
  const stages = createWebStages(d);
  const released = () => deleteTempImages.mock.calls.flatMap((c) => c[0]);
  return { stages, session, cv, crop, prepareForRecognition, prepareAtSize, deleteTempImages, released, tiles };
}

const strips = (crop: ReturnType<typeof fakeCrop>) => crop.fn.mock.calls.map((c) => ({ base: c[0], ...c[1], scale: c[2] }));

describe('variants (criterion 57; production unchanged)', () => {
  it('web-crop-strips / web-crop-th40-strips add only tiling (the spec starting values) to their bases', () => {
    for (const [name, base] of [
      ['web-crop-strips', 'web-crop-canvas'],
      ['web-crop-th40-strips', 'web-crop-th40'],
    ] as const) {
      const v = VARIANTS[name]!.config;
      const b = VARIANTS[base]!.config;
      expect(v.recognize.tiling).toEqual(DEFAULT_TILING);
      expect({ ...v, recognize: { ...v.recognize, tiling: false } }).toEqual(b);
    }
  });

  it('no variant both tiles and enhances (strips are read unenhanced)', () => {
    for (const v of Object.values(VARIANTS)) if (v.config.recognize.tiling) expect(v.config.enhance).toBe(false);
  });
});

describe('a tall crop is read in strips (web-crop-strips)', () => {
  it('rowInk on the crop → strips cut on blank rows at native resolution via the canvas path → one read per strip on the one session → merged in crop pixels', async () => {
    const t = setup();
    const progress: number[] = [];
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'), { onProgress: (f) => progress.push(f) });
    t.stages.close();

    // The profile is measured on the crop (warp output id 12), never on a shrunk copy.
    expect(t.cv.rowInk.mock.calls.map((c) => c[0])).toEqual([12]);
    // No whole-image shrink to the cap: neither today's prepare nor a cv resize.
    expect(t.prepareForRecognition).not.toHaveBeenCalled();
    expect(t.cv.resize).not.toHaveBeenCalled();
    // The crop leaves the worker once, losslessly, and every strip is cut from that PNG at scale 1.
    expect(t.cv.encode.mock.calls).toEqual([[12, 'png', undefined]]);
    const cut = strips(t.crop);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    for (const s of cut) expect(s).toMatchObject({ base: 'blob:enc-1', x: 0, width: 600, scale: 1 });
    expect(cut[0]!.y).toBe(0);
    expect(cut.at(-1)!.y + cut.at(-1)!.height).toBe(LONG.height);
    // No strip edge inside a text row.
    for (const s of cut) {
      for (const row of LONG.rows) {
        expect(s.y > row.top && s.y < row.bottom).toBe(false);
        expect(s.y + s.height > row.top && s.y + s.height < row.bottom).toBe(false);
      }
    }
    // One read per strip, in order, on the scan's one session.
    expect(t.session.read.mock.calls.map((c) => c[0])).toEqual(cut.map((_, i) => `blob:strip-${i + 1}`));
    // Merged: every row exactly once (the overlap copies deduped), top to bottom, boxes in crop pixels.
    const lines = r.best.text.lines;
    expect(lines.map((l) => l.text)).toEqual(LONG.rows.map((_, i) => `Item ${i} ${i}.00`));
    lines.forEach((l, i) => {
      expect(l.box!.y).toBeCloseTo(LONG.rows[i]!.top, 6);
      expect(l.box!.height).toBeCloseTo(28, 6);
    });
    expect(r.attempts[0]).toMatchObject({ cropApplied: true, scale: [1], passes: 1 });
    expect(t.tiles).toEqual([{ scale: 1, pitchPx: 44, strips: cut.map((s) => ({ width: 600, height: s.height })) }]);
    // Progress is the overall fraction across strips, ending at 1.
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toContain(0.5 / cut.length);
    // Every intermediate released: each strip as its read ends, the PNG, the crop and the photo.
    expect(t.released()).toEqual([...cut.map((_, i) => `blob:strip-${i + 1}`), 'blob:photo']);
    expect(t.cv.revoke).toHaveBeenCalledWith('blob:enc-1');
    expect(t.cv.free.mock.calls.flatMap((c) => c[0] as number[]).sort()).toEqual([11, 12]);
    expect(t.session.close).toHaveBeenCalledTimes(1);
    expect(t.cv.close).toHaveBeenCalledTimes(1);
  });

  it('a crop wider than the cap is read at width = cap (scale < 1), each strip under the cap', async () => {
    // 2400 × 6000 (1:2.5): text rows 60 px tall every 100 px, blank in between.
    const ink = Uint32Array.from({ length: 6000 }, (_, y) => (y >= 50 && y % 100 >= 20 && y % 100 < 80 ? 500 : 0));
    const cv = fakeCv({ crop: { width: 2400, height: 6000 }, ink });
    const t = setup({ cv });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    const cut = strips(t.crop);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    for (const s of cut) {
      expect(s.scale).toBeCloseTo(RECOGNITION_MAX_EDGE / 2400, 9);
      expect(Math.round(s.height * s.scale)).toBeLessThanOrEqual(RECOGNITION_MAX_EDGE);
    }
    expect(r.attempts[0]!.scale).toEqual([RECOGNITION_MAX_EDGE / 2400]);
  });

  it('a crop needing more than MAX_STRIPS strips at native resolution → no tiling, the whole crop as usual', async () => {
    const ink = Uint32Array.from({ length: 14000 }, (_, y) => (y % 44 < 28 ? 120 : 0));
    const cv = fakeCv({ crop: { width: 600, height: 14000 }, ink });
    const t = setup({ cv });
    await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(cv.rowInk).toHaveBeenCalledTimes(1);
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(t.prepareForRecognition).toHaveBeenCalledTimes(1);
  });

  it('no crop found, tall photo: the profile from the decode (freed at once), strips cut from the photo itself in its own pixels', async () => {
    // Profile drawn at the decoded height (683 × 4096 for a 1000 × 6000 photo).
    const page = renderTallPage({ width: 683, height: 4096 });
    const cv = fakeCv({ crop: null, source: PHOTO, decoded: { width: 683, height: 4096 }, ink: rowInkFromGray(page.gray, page.width, page.height) });
    const t = setup({ cv, page });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(r.attempts[0]!.cropApplied).toBe(false);
    expect(cv.rowInk.mock.calls.map((c) => c[0])).toEqual([11]);
    expect(cv.free.mock.calls[0]).toEqual([[11]]);
    expect(cv.encode).not.toHaveBeenCalled();
    expect(t.prepareForRecognition).not.toHaveBeenCalled();
    const cut = strips(t.crop);
    expect(cut.length).toBeGreaterThanOrEqual(2);
    for (const s of cut) expect(s).toMatchObject({ base: 'blob:photo', x: 0, width: 1000, scale: 1 });
    expect(cut.at(-1)!.y + cut.at(-1)!.height).toBe(6000);
    expect(r.best.text.lines).toHaveLength(page.rows.length);
  });
});

describe('strips never trigger on normal receipts, and anything off means today\'s whole-image read', () => {
  it.each([
    ['a normal-aspect crop (900 × 1800)', { width: 900, height: 1800 }],
    ['a tall but short crop (500 × 2400)', { width: 500, height: 2400 }],
  ])('%s: no profile, no strips; the crop goes through today\'s canvas path exactly as web-crop-canvas', async (_n, crop) => {
    const t = setup({ cv: fakeCv({ crop }) });
    const base = setup({ cv: fakeCv({ crop }) });
    await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    await runScanPipeline(asImg('blob:photo'), base.stages, plan('web-crop-canvas'));
    t.stages.close();
    base.stages.close();
    expect(t.cv.rowInk).not.toHaveBeenCalled();
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(t.prepareForRecognition.mock.calls).toEqual(base.prepareForRecognition.mock.calls);
    expect(t.session.read.mock.calls.map((c) => c[0])).toEqual(base.session.read.mock.calls.map((c) => c[0]));
    expect(t.tiles).toEqual([]);
  });

  it('a normal photo with no crop: no profile, today\'s prepare on the photo', async () => {
    const t = setup({ cv: fakeCv({ crop: null, source: { width: 3024, height: 4032 } }) });
    await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(t.cv.rowInk).not.toHaveBeenCalled();
    expect(t.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
  });

  it('web-crop-canvas (no tiling) on the same tall crop shrinks it whole, as today', async () => {
    const t = setup();
    await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-canvas'));
    t.stages.close();
    expect(t.cv.rowInk).not.toHaveBeenCalled();
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(t.prepareForRecognition.mock.calls).toEqual([['blob:enc-1']]);
  });

  it('a profile with no blank row in a window (a solid block) → no tiling: today\'s canvas path on the whole crop', async () => {
    const blocked = renderTallPage({ solidBlock: [900, 2200] });
    const t = setup({ cv: fakeCv({ ink: rowInkFromGray(blocked.gray, blocked.width, blocked.height) }) });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(t.cv.rowInk).toHaveBeenCalledTimes(1);
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(t.prepareForRecognition).toHaveBeenCalledTimes(1);
    expect(r.trace.some((e) => e.event === 'unavailable')).toBe(false);
  });

  it('rowInk failing (op error, or OpenCV gone) → no tiling; the scan still reads the whole crop', async () => {
    const cv = fakeCv();
    cv.rowInk.mockRejectedValue(new CvOpFailed('process_failed'));
    const t = setup({ cv });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(t.prepareForRecognition).toHaveBeenCalledTimes(1);
    expect(r.best).toBeDefined();
  });

  it('no canvas crop function injected, or cv off → no tiling and no profile', async () => {
    const a = setup({ over: { cropAtScale: undefined } });
    await runScanPipeline(asImg('blob:photo'), a.stages, plan('web-crop-strips'));
    a.stages.close();
    expect(a.cv.rowInk).not.toHaveBeenCalled();
    expect(a.prepareForRecognition).toHaveBeenCalledTimes(1);
    const b = setup({ over: { cvPreprocess: false } });
    await runScanPipeline(asImg('blob:photo'), b.stages, plan('web-crop-strips'));
    b.stages.close();
    expect(b.cv.load).not.toHaveBeenCalled();
    expect(b.prepareForRecognition.mock.calls).toEqual([['blob:photo']]);
  });
});

describe('endings mid-strips', () => {
  it('cancel during the second strip → cancelled; that strip released, no further strip cut, PNG revoked, crop freed, workers closed', async () => {
    const t = setup();
    const c = new AbortController();
    const read = t.session.read.getMockImplementation()!;
    t.session.read.mockImplementation(async (uri, opts) => {
      if (uri === 'blob:strip-2') {
        c.abort();
        throw new RecognitionError('cancelled');
      }
      return read(uri, opts);
    });
    await expect(runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'), { signal: c.signal })).rejects.toMatchObject({ code: 'cancelled' });
    t.stages.close();
    expect(t.crop.fn).toHaveBeenCalledTimes(2);
    expect(t.released()).toEqual(['blob:strip-1', 'blob:strip-2', 'blob:photo']);
    expect(t.cv.revoke).toHaveBeenCalledWith('blob:enc-1');
    expect(t.cv.free.mock.calls.flatMap((x) => x[0] as number[])).toContain(12);
    expect(t.session.close).toHaveBeenCalledTimes(1);
    expect(t.cv.close).toHaveBeenCalledTimes(1);
  });

  it('cancel between strips (signal aborted while a strip is being cut) → cancelled before the next read', async () => {
    const t = setup();
    const c = new AbortController();
    const cut = t.crop.fn.getMockImplementation()!;
    t.crop.fn.mockImplementation(async (base, rect, scale) => {
      const out = await cut(base, rect, scale);
      if (out.uri === 'blob:strip-2') c.abort();
      return out;
    });
    await expect(runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'), { signal: c.signal })).rejects.toMatchObject({ code: 'cancelled' });
    t.stages.close();
    // The fake session ignores the signal, so strip 2 may be read; strip 3 is never cut.
    expect(t.crop.fn).toHaveBeenCalledTimes(2);
    expect(t.released()).toEqual(expect.arrayContaining(['blob:strip-1', 'blob:strip-2', 'blob:photo']));
    expect(t.cv.revoke).toHaveBeenCalledWith('blob:enc-1');
  });

  it('a strip read timing out → the scan rejects with timeout (a partial page is not a read); everything released', async () => {
    const t = setup();
    const read = t.session.read.getMockImplementation()!;
    t.session.read.mockImplementation(async (uri, opts) => {
      if (uri === 'blob:strip-2') throw new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT');
      return read(uri, opts);
    });
    await expect(runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'))).rejects.toMatchObject({ code: 'timeout' });
    t.stages.close();
    expect(t.crop.fn).toHaveBeenCalledTimes(2);
    expect(t.released()).toEqual(['blob:strip-1', 'blob:strip-2', 'blob:photo']);
    expect(t.cv.revoke).toHaveBeenCalledWith('blob:enc-1');
    expect(t.session.close).toHaveBeenCalledTimes(1);
  });

  it('a strip cut failing → the scan rejects; earlier strips and the PNG are released', async () => {
    const t = setup();
    const cut = t.crop.fn.getMockImplementation()!;
    t.crop.fn.mockImplementation(async (base, rect, scale) => {
      if (t.crop.fn.mock.calls.length === 2) throw new RecognitionError('image_load_failed');
      return cut(base, rect, scale);
    });
    await expect(runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'))).rejects.toMatchObject({ code: 'image_load_failed' });
    t.stages.close();
    expect(t.released()).toEqual(['blob:strip-1', 'blob:photo']);
    expect(t.cv.revoke).toHaveBeenCalledWith('blob:enc-1');
  });

  // Review R2: was "→ failed". The original photo is still usable, so the pass is read whole from
  // today's prepare on it (a recognize `fallback`) instead of failing the scan.
  it('the PNG handoff failing → `fallback`: no strip cut; the original photo is prepared and read whole; crop freed', async () => {
    const cv = fakeCv();
    cv.encode.mockRejectedValue(new CvOpFailed('process_failed'));
    const t = setup({ cv });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-strips'));
    t.stages.close();
    expect(t.crop.fn).not.toHaveBeenCalled();
    expect(r.trace).toContainEqual({ variant: 'web-crop-strips', stage: 'recognize', event: 'fallback' });
    expect(t.prepareForRecognition.mock.calls.map((c) => c[0])).toEqual(['blob:photo']);
    expect(t.released()).toContain('blob:prepared');
    expect(t.session.read).toHaveBeenCalledTimes(1);
    expect(cv.free.mock.calls.flatMap((x) => x[0] as number[])).toContain(12);
  });
});

describe('text-height second pass with strips (web-crop-th40-strips)', () => {
  it('rows of 28 px → factor 40/28: the strips are re-planned at the new scale (still under the cap each), read, and the better pass kept', async () => {
    const t = setup();
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-th40-strips'));
    t.stages.close();
    expect(r.attempts[0]!.passes).toBe(2);
    const factor = 40 / 28;
    expect(r.attempts[0]!.scale).toEqual([1, factor]);
    // The profile is measured once and reused by the second plan.
    expect(t.cv.rowInk).toHaveBeenCalledTimes(1);
    expect(t.tiles).toHaveLength(2);
    expect(t.tiles[1]!.scale).toBeCloseTo(factor, 9);
    expect(t.tiles[1]!.strips.length).toBeGreaterThan(t.tiles[0]!.strips.length);
    for (const s of t.tiles[1]!.strips) expect(s.height).toBeLessThanOrEqual(RECOGNITION_MAX_EDGE);
    // No whole-image resize in either pass.
    expect(t.prepareForRecognition).not.toHaveBeenCalled();
    expect(t.prepareAtSize).not.toHaveBeenCalled();
    // Both passes cut from their own PNG of the crop; both revoked.
    expect(t.cv.encode).toHaveBeenCalledTimes(2);
    expect(t.cv.revoke.mock.calls.map((c) => c[0]).sort()).toEqual(['blob:enc-1', 'blob:enc-2']);
    // Every strip of both passes released.
    const n = t.tiles[0]!.strips.length + t.tiles[1]!.strips.length;
    expect(t.released()).toEqual([...Array.from({ length: n }, (_, i) => `blob:strip-${i + 1}`), 'blob:photo']);
  });

  it('a second-pass size that fits under the cap reads the whole crop resized (today\'s canvas path at that size)', async () => {
    // Rows 100 px tall → factor clamped to 0.5: 600 × 3600 → 300 × 1800, under the cap.
    const big = renderTallPage({ lineH: 100, pitch: 150 });
    const t = setup({ cv: fakeCv({ ink: rowInkFromGray(big.gray, big.width, big.height) }), page: big });
    const r = await runScanPipeline(asImg('blob:photo'), t.stages, plan('web-crop-th40-strips'));
    t.stages.close();
    expect(t.tiles).toHaveLength(1);
    expect(t.prepareAtSize.mock.calls).toEqual([['blob:enc-2', { width: 300, height: 1800 }]]);
    expect(r.attempts[0]!.passes).toBe(2);
  });

  it('enhance on a tiled pass is the identity (recorded as a fallback)', async () => {
    const t = setup();
    const onFallback = jest.fn();
    const out = await t.stages.enhance(asImg('tiles:1'), { gray: true, flatten: false, clahe: false }, { onFallback });
    expect(out).toBe('tiles:1');
    expect(onFallback).toHaveBeenCalledWith('enhance');
    expect(t.cv.enhance).not.toHaveBeenCalled();
    t.stages.close();
  });
});
