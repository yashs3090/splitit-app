// runScanPipeline with fake stages (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3, criterion 19).
// All inputs are hand-made (criterion 70), not copied from receipt fixtures.
import type { RecognizedText } from '../receiptTypes';
import { RecognitionError } from '../recognitionError';
import type { RecognitionStage } from '../textRecognition';
import type { ResolvedPlan } from './config';
import { runScanPipeline } from './run';
import {
  StageUnavailable,
  asImg,
  type Img,
  type LocateResult,
  type PipelineConfig,
  type StageName,
  type StageSet,
} from './types';

// ---------- hand-made reads ----------

function lines(...texts: string[]): RecognizedText {
  return { lines: texts.map((text, i) => ({ text, box: { x: 0, y: i * 30, width: 300, height: 20 } })) };
}
/** Adds up: items 4.00 + 6.00 = subtotal 10.00, tax 1.00, total 11.00. */
const GOOD = lines('Corner Cafe', 'Soup 4.00', 'Bread 6.00', 'Subtotal 10.00', 'Tax 1.00', 'Total 11.00');
/** Two items, no total line: not ok (no_total). */
const NO_TOTAL = lines('Corner Cafe', 'Soup 4.00', 'Bread 6.00', 'Thank you', 'Come again');
/** Nothing usable. */
const JUNK = lines('~~', '|');

// ---------- config helpers ----------

const BASE: PipelineConfig = {
  locate: false,
  crop: false,
  enhance: false,
  textHeightRescale: false,
  recognize: { tiling: false, zoomOnDoubt: false },
};
function cfg(over: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...BASE, ...over };
}
const FULL = cfg({
  locate: true,
  crop: { marginFraction: 0.025, minConfidence: 0.5 },
  enhance: { gray: true, flatten: false, clahe: false },
});
function plan(primary: PipelineConfig, retry: PipelineConfig | null = null): ResolvedPlan {
  return { primary: { variant: 'p', config: primary }, retry: retry ? { variant: 'r', config: retry } : null };
}

const QUAD: LocateResult['quad'] = [
  [10, 10],
  [290, 12],
  [288, 590],
  [12, 588],
];
const INPUT = asImg('in');

// ---------- fake stages ----------

type Fake = StageSet & {
  calls: { stage: StageName; img?: Img; arg?: unknown }[];
  disposed: Img[][];
};

type FakeOpts = {
  loc?: LocateResult;
  /** One read per recognize call, in order (the last repeats). */
  reads?: RecognizedText[];
  /** Throw from a stage. */
  throwIn?: Partial<Record<StageName, unknown>>;
  /** normalizeScale with a first pass returns an image (true) or null (nothing to change). */
  secondPass?: boolean;
  /** The median line height each recognize call reports (the last repeats). Default 20. */
  medians?: (number | null)[];
  /** Run before each stage resolves (e.g. to abort). */
  before?: (stage: StageName) => void;
};

function fakeStages(o: FakeOpts = {}): Fake {
  const calls: Fake['calls'] = [];
  const disposed: Img[][] = [];
  const reads = o.reads ?? [GOOD];
  let reads_n = 0;
  let n = 0;
  const fresh = (prefix: string) => asImg(`${prefix}-${++n}`);
  async function run<T>(stage: StageName, img: Img | undefined, arg: unknown, value: () => T): Promise<T> {
    calls.push({ stage, img, arg });
    o.before?.(stage);
    const err = o.throwIn?.[stage];
    if (err !== undefined) throw err;
    return value();
  }
  return {
    calls,
    disposed,
    locateDocument: (img) => run('locate', img, undefined, () => o.loc ?? { method: 'quad', quad: QUAD, confidence: 0.9 }),
    cropAndFlatten: (img, loc, opts) => run('crop', img, { loc, opts }, () => fresh('crop')),
    normalizeScale: (img, opts) =>
      run('normalize', img, opts, () =>
        opts.firstPass === null ? { img: fresh('norm'), scale: 1.5 } : o.secondPass ? { img: fresh('norm2'), scale: 2 } : null,
      ),
    enhance: (img, opts) => run('enhance', img, opts, () => fresh('enh')),
    recognize: (img, config) =>
      run('recognize', img, config, () => {
        const text = reads[Math.min(reads_n, reads.length - 1)] ?? GOOD;
        const medianLineHeight = o.medians ? (o.medians[Math.min(reads_n, o.medians.length - 1)] ?? null) : 20;
        reads_n += 1;
        return { text, medianLineHeight, meanLineConfidence: null };
      }),
    async dispose(imgs) {
      disposed.push([...imgs]);
    },
  };
}

function stagesCalled(f: Fake): StageName[] {
  return f.calls.map((c) => c.stage);
}

describe('runScanPipeline: order and data flow', () => {
  it('runs locate → crop → normalize → enhance → recognize → assess', async () => {
    const f = fakeStages();
    const steps: StageName[] = [];
    const r = await runScanPipeline(INPUT, f, plan(FULL), { onStep: (s) => steps.push(s) });
    expect(steps).toEqual(['locate', 'crop', 'normalize', 'enhance', 'recognize', 'assess']);
    expect(stagesCalled(f)).toEqual(['locate', 'crop', 'normalize', 'enhance', 'recognize']);
    expect(r.best.verdict.ok).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ variant: 'p', cropApplied: true, scale: [1.5], passes: 1 });
  });

  it('normalizeScale receives the crop, not the input image; enhance gets the normalized image; recognize the enhanced one', async () => {
    const f = fakeStages();
    await runScanPipeline(INPUT, f, plan(FULL));
    const img = (s: StageName) => f.calls.find((c) => c.stage === s)?.img;
    expect(img('locate')).toBe(INPUT);
    expect(img('crop')).toBe(INPUT);
    expect(img('normalize')).toBe('crop-1');
    expect(img('enhance')).toBe('norm-2');
    expect(img('recognize')).toBe('enh-3');
  });

  it('disabled stages are not called and are traced as skipped', async () => {
    const f = fakeStages();
    const r = await runScanPipeline(INPUT, f, plan(BASE));
    expect(stagesCalled(f)).toEqual(['normalize', 'recognize']);
    expect(f.calls[0]?.img).toBe(INPUT);
    expect(r.attempts[0]).toMatchObject({ cropApplied: false, locate: { method: 'none', confidence: 0 } });
    expect(r.trace).toEqual([
      { variant: 'p', stage: 'locate', event: 'skipped', reason: 'disabled' },
      { variant: 'p', stage: 'crop', event: 'skipped', reason: 'disabled' },
      { variant: 'p', stage: 'enhance', event: 'skipped', reason: 'disabled' },
    ]);
  });
});

describe('runScanPipeline: crop confidence boundary (minConfidence 0.5)', () => {
  it.each([
    [0.2, false],
    [0.49, false],
    [0.5, true],
    [0.8, true],
  ])('confidence %p → crop applied: %p', async (confidence, applied) => {
    const f = fakeStages({ loc: { method: 'quad', quad: QUAD, confidence } });
    const r = await runScanPipeline(INPUT, f, plan(FULL));
    expect(stagesCalled(f).includes('crop')).toBe(applied);
    expect(r.attempts[0]?.cropApplied).toBe(applied);
    expect(f.calls.find((c) => c.stage === 'normalize')?.img).toBe(applied ? 'crop-1' : INPUT);
    if (!applied) expect(r.trace).toContainEqual({ variant: 'p', stage: 'crop', event: 'skipped', reason: 'low_confidence' });
  });

  it('a null quad is the identity even at full confidence', async () => {
    const f = fakeStages({ loc: { method: 'none', quad: null, confidence: 1 } });
    const r = await runScanPipeline(INPUT, f, plan(FULL));
    expect(stagesCalled(f)).not.toContain('crop');
    expect(r.attempts[0]?.cropApplied).toBe(false);
  });
});

describe('runScanPipeline: retry', () => {
  it('primary ok → no retry', async () => {
    const f = fakeStages({ reads: [GOOD, JUNK] });
    const r = await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(r.attempts.map((a) => a.variant)).toEqual(['p']);
    expect(stagesCalled(f).filter((s) => s === 'recognize')).toHaveLength(1);
  });

  it('primary not ok, retry better → the retry wins', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, GOOD] });
    const r = await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(r.attempts.map((a) => a.variant)).toEqual(['p', 'r']);
    expect(r.best.text).toEqual(GOOD);
    expect(r.best.verdict.ok).toBe(true);
  });

  it('retry worse → the primary is kept', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, JUNK] });
    const r = await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(r.attempts).toHaveLength(2);
    expect(r.best.text).toEqual(NO_TOTAL);
    expect(r.best.verdict.problems).toEqual(['no_total']);
  });

  it('a retry that found the total but is off beats a primary with no total (Task 11 pickBetter fix), both orders', async () => {
    // Off by $5.00: items 10.00, subtotal 10.00, tax 1.00, total read as 16.00.
    const OFF = lines('Corner Cafe', 'Soup 4.00', 'Bread 6.00', 'Subtotal 10.00', 'Tax 1.00', 'Total 16.00');
    const a = await runScanPipeline(INPUT, fakeStages({ reads: [NO_TOTAL, OFF] }), plan(BASE, BASE));
    expect(a.best.text).toEqual(OFF);
    expect(a.best.verdict.problems).toEqual(['subtotal_vs_total']);
    const b = await runScanPipeline(INPUT, fakeStages({ reads: [OFF, NO_TOTAL] }), plan(BASE, BASE));
    expect(b.attempts).toHaveLength(2);
    expect(b.best.text).toEqual(OFF);
  });

  it('retry: null → one attempt, even when not ok', async () => {
    const f = fakeStages({ reads: [JUNK] });
    const r = await runScanPipeline(INPUT, f, plan(BASE, null));
    expect(r.attempts).toHaveLength(1);
    expect(r.best.verdict.ok).toBe(false);
  });

  it('reports preparing → recognizing, then retrying for the second try', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, GOOD] });
    const stages: RecognitionStage[] = [];
    await runScanPipeline(INPUT, f, plan(BASE, BASE), { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['preparing', 'recognizing', 'retrying', 'retrying']);
  });
});

describe('runScanPipeline: text-height second pass', () => {
  // Target 34 px, ±15%: in band is [28.9, 39.1]. The fake's first read reports a median of 20 px.
  const RESCALE = cfg({ textHeightRescale: { targetLineHeightPx: 34, band: [0.85, 1.15] } });
  const CROP_RESCALE = cfg({ ...RESCALE, locate: true, crop: { marginFraction: 0.025, minConfidence: 0.5 } });

  it('resizes the crop (not the first-pass image) by target / median and keeps the better pass', async () => {
    const f = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD] });
    const r = await runScanPipeline(INPUT, f, plan(CROP_RESCALE));
    const normalizes = f.calls.filter((c) => c.stage === 'normalize');
    expect(normalizes.map((c) => c.img)).toEqual(['crop-1', 'crop-1']);
    expect(normalizes[0]?.arg).toEqual({ firstPass: null });
    expect(normalizes[1]?.arg).toEqual({ firstPass: { medianLineHeight: 20, factor: 34 / 20 } });
    // The second pass is enhanced and read from its own image, not the first pass's.
    const recognizes = f.calls.filter((c) => c.stage === 'recognize');
    expect(recognizes).toHaveLength(2);
    expect(recognizes.map((c) => c.img)).toEqual(['norm-2', 'norm2-3']);
    expect(r.attempts[0]).toMatchObject({ passes: 2, scale: [1.5, 2] });
    expect(r.best.text).toEqual(GOOD);
  });

  it('keeps the first pass when the second reads worse', async () => {
    const f = fakeStages({ secondPass: true, reads: [GOOD, NO_TOTAL] });
    const r = await runScanPipeline(INPUT, f, plan(RESCALE));
    expect(r.attempts[0]?.passes).toBe(2);
    expect(r.best.text).toEqual(GOOD);
  });

  it('second pass with enhance on: the resized crop is enhanced again before the read', async () => {
    const f = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD] });
    await runScanPipeline(INPUT, f, plan(cfg({ ...CROP_RESCALE, enhance: { gray: true, flatten: false, clahe: false } })));
    expect(f.calls.filter((c) => c.stage === 'enhance').map((c) => c.img)).toEqual(['norm-2', 'norm2-4']);
  });

  it('median in band (edges included) → the stage is not asked for a second pass; one pass, traced in_band', async () => {
    for (const median of [34, 28.9, 39.1]) {
      const f = fakeStages({ secondPass: true, medians: [median] });
      const r = await runScanPipeline(INPUT, f, plan(RESCALE));
      expect(f.calls.filter((c) => c.stage === 'normalize')).toHaveLength(1);
      expect(r.attempts[0]).toMatchObject({ passes: 1, scale: [1.5] });
      expect(r.trace).toContainEqual({ variant: 'p', stage: 'normalize', event: 'skipped', reason: 'in_band' });
    }
  });

  it('no median measured (null) → no second pass', async () => {
    const f = fakeStages({ secondPass: true, medians: [null] });
    const r = await runScanPipeline(INPUT, f, plan(RESCALE));
    expect(f.calls.filter((c) => c.stage === 'normalize')).toHaveLength(1);
    expect(r.attempts[0]?.passes).toBe(1);
  });

  it('strip tiling (Task 12): the variant\'s tiling options reach both normalize calls; without tiling the call is unchanged', async () => {
    const tiling = { minAspect: 2.5, minOverscale: 1.25, blankInkFraction: 0.002, cutWindowFraction: 0.25, maxStrips: 6 };
    const f = fakeStages({ secondPass: true, medians: [20] });
    await runScanPipeline(INPUT, f, plan(cfg({ ...RESCALE, recognize: { ...RESCALE.recognize, tiling } })));
    const args = f.calls.filter((c) => c.stage === 'normalize').map((c) => c.arg as { tiling?: unknown });
    expect(args.map((a) => a.tiling)).toEqual([tiling, tiling]);
    const g = fakeStages();
    await runScanPipeline(INPUT, g, plan(RESCALE));
    expect(Object.keys(g.calls.find((c) => c.stage === 'normalize')!.arg as object)).not.toContain('tiling');
  });

  it('a factor is clamped before it reaches the stage', async () => {
    const f = fakeStages({ secondPass: true, medians: [5] });
    await runScanPipeline(INPUT, f, plan(RESCALE));
    expect(f.calls.filter((c) => c.stage === 'normalize')[1]?.arg).toEqual({ firstPass: { medianLineHeight: 5, factor: 3 } });
  });

  it('the stage finds nothing to change (e.g. already at the size cap) → one pass, traced no_change', async () => {
    const f = fakeStages({ secondPass: false });
    const r = await runScanPipeline(INPUT, f, plan(RESCALE));
    expect(f.calls.filter((c) => c.stage === 'normalize')).toHaveLength(2);
    expect(r.attempts[0]?.passes).toBe(1);
    expect(r.trace).toContainEqual({ variant: 'p', stage: 'normalize', event: 'skipped', reason: 'no_change' });
  });

  it('textHeightRescale off → never a second normalize, even with a far-off median', async () => {
    const f = fakeStages({ secondPass: true, medians: [5] });
    const r = await runScanPipeline(INPUT, f, plan(BASE));
    expect(f.calls.filter((c) => c.stage === 'normalize')).toHaveLength(1);
    expect(r.attempts[0]?.passes).toBe(1);
  });

  it('every handle from both passes is disposed', async () => {
    const f = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD] });
    await runScanPipeline(INPUT, f, plan(CROP_RESCALE));
    expect(f.disposed).toEqual([['in', 'crop-1', 'norm-2', 'norm2-3']]);
  });
});

describe('runScanPipeline: a timeout after a read exists (criterion 23, review R1)', () => {
  const RESCALE = cfg({ textHeightRescale: { targetLineHeightPx: 34, band: [0.85, 1.15] } });
  /** Throws `RecognitionError('timeout')` from the `n`th call of `stage` (1-based). */
  function timeoutAt(stage: StageName, n: number) {
    let calls = 0;
    return (s: StageName) => {
      if (s === stage && ++calls === n) throw new RecognitionError('timeout');
    };
  }

  it('the retry\'s read times out → the primary\'s read is kept, the timeout is traced, everything disposed', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, GOOD], before: timeoutAt('recognize', 2) });
    const r = await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(r.best.text).toEqual(NO_TOTAL);
    expect(r.best.verdict.ok).toBe(false);
    expect(r.attempts.map((a) => a.variant)).toEqual(['p']);
    expect(r.trace).toContainEqual({ variant: 'r', stage: 'recognize', event: 'timeout' });
    expect(f.disposed).toEqual([[INPUT, 'norm-1', 'norm-2']]);
  });

  it('the retry times out before its read (in normalize) → the primary\'s read is kept', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, GOOD], before: timeoutAt('normalize', 2) });
    const r = await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(r.best.text).toEqual(NO_TOTAL);
    expect(r.trace).toContainEqual({ variant: 'r', stage: 'normalize', event: 'timeout' });
  });

  it('the text-height second pass times out → the first pass is kept (one pass, one scale) and traced', async () => {
    const f = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD], before: timeoutAt('recognize', 2) });
    const r = await runScanPipeline(INPUT, f, plan(RESCALE));
    expect(r.best.text).toEqual(NO_TOTAL);
    expect(r.attempts[0]).toMatchObject({ passes: 1, scale: [1.5] });
    expect(r.trace).toContainEqual({ variant: 'p', stage: 'recognize', event: 'timeout' });
    expect(f.disposed).toEqual([[INPUT, 'norm-1', 'norm2-2']]);
  });

  it('after a timeout in the primary\'s second pass, the retry is not started (the reader just timed out)', async () => {
    const f = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD], before: timeoutAt('recognize', 2) });
    const r = await runScanPipeline(INPUT, f, plan(RESCALE, BASE));
    expect(r.attempts.map((a) => a.variant)).toEqual(['p']);
    expect(f.calls.filter((c) => c.stage === 'recognize')).toHaveLength(2);
    expect(r.best.text).toEqual(NO_TOTAL);
  });

  it('the retry\'s second pass times out → the retry\'s first pass still competes with the primary', async () => {
    // Primary: one pass (median 34, in band); retry: first read at 20 px → second pass → timeout.
    const g = fakeStages({ secondPass: true, reads: [NO_TOTAL, GOOD], medians: [34, 20], before: timeoutAt('recognize', 3) });
    const r = await runScanPipeline(INPUT, g, plan(RESCALE, RESCALE));
    expect(r.attempts.map((a) => a.variant)).toEqual(['p', 'r']);
    expect(r.attempts[1]).toMatchObject({ passes: 1 });
    expect(r.best.text).toEqual(GOOD);
    expect(r.trace).toContainEqual({ variant: 'r', stage: 'recognize', event: 'timeout' });
  });

  it('a timeout before any read still rejects with timeout (nothing to show), and disposes', async () => {
    const f = fakeStages({ before: timeoutAt('recognize', 1) });
    await expect(runScanPipeline(INPUT, f, plan(BASE, BASE))).rejects.toMatchObject({ code: 'timeout' });
    expect(f.disposed).toEqual([[INPUT, 'norm-1']]);
  });

  it('cancel wins over a kept read: an abort with the timeout rejects cancelled', async () => {
    const controller = new AbortController();
    let n = 0;
    const f = fakeStages({
      reads: [NO_TOTAL, GOOD],
      before: (s) => {
        if (s === 'recognize' && ++n === 2) {
          controller.abort();
          throw new RecognitionError('timeout');
        }
      },
    });
    await expect(runScanPipeline(INPUT, f, plan(BASE, BASE), { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('other errors after a read still reject (only timeout keeps the read)', async () => {
    let n = 0;
    const f = fakeStages({
      reads: [NO_TOTAL, GOOD],
      before: (s) => {
        if (s === 'recognize' && ++n === 2) throw new RecognitionError('failed');
      },
    });
    await expect(runScanPipeline(INPUT, f, plan(BASE, BASE))).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('runScanPipeline: StageUnavailable and errors', () => {
  it('StageUnavailable in locate → completes with the full image, and trace records it', async () => {
    const f = fakeStages({ throwIn: { locate: new StageUnavailable('locate') } });
    const r = await runScanPipeline(INPUT, f, plan(FULL));
    expect(r.best.verdict.ok).toBe(true);
    expect(stagesCalled(f)).toEqual(['locate', 'normalize', 'enhance', 'recognize']);
    expect(f.calls.find((c) => c.stage === 'normalize')?.img).toBe(INPUT);
    expect(r.trace).toContainEqual({ variant: 'p', stage: 'locate', event: 'unavailable' });
    expect(r.attempts[0]?.cropApplied).toBe(false);
  });

  it('an unavailable stage stays the identity for the retry (not called again)', async () => {
    const f = fakeStages({ throwIn: { enhance: new StageUnavailable('enhance') }, reads: [NO_TOTAL, GOOD] });
    const r = await runScanPipeline(INPUT, f, plan(FULL, FULL));
    expect(stagesCalled(f).filter((s) => s === 'enhance')).toHaveLength(1);
    expect(r.trace.filter((t) => t.event === 'unavailable')).toEqual([{ variant: 'p', stage: 'enhance', event: 'unavailable' }]);
    expect(r.best.verdict.ok).toBe(true);
  });

  it('StageUnavailable in recognize → rejects with unavailable (there is no identity read)', async () => {
    const f = fakeStages({ throwIn: { recognize: new StageUnavailable('recognize') } });
    await expect(runScanPipeline(INPUT, f, plan(BASE))).rejects.toMatchObject({ name: 'RecognitionError', code: 'unavailable' });
  });

  it('a RecognitionError passes through unchanged', async () => {
    const err = new RecognitionError('image_load_failed', 'PREPARE_FAILED');
    const f = fakeStages({ throwIn: { normalize: err } });
    await expect(runScanPipeline(INPUT, f, plan(BASE))).rejects.toBe(err);
  });

  it('any other error becomes RecognitionError(failed) with a fixed message', async () => {
    const f = fakeStages({ throwIn: { crop: new Error('SECRET-LIB-TEXT /private/x') } });
    const e = await runScanPipeline(INPUT, f, plan(FULL)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RecognitionError);
    expect(e).toMatchObject({ code: 'failed' });
    expect((e as Error).message).not.toMatch(/SECRET/);
  });
});

describe('runScanPipeline: dispose', () => {
  it('disposes every handle once on success, input first, no duplicates', async () => {
    const f = fakeStages();
    await runScanPipeline(INPUT, f, plan(FULL));
    expect(f.disposed).toEqual([[INPUT, 'crop-1', 'norm-2', 'enh-3']]);
  });

  it('identity stages add no duplicate handles', async () => {
    const f = fakeStages();
    f.cropAndFlatten = async (img) => img;
    f.enhance = async (img) => img;
    await runScanPipeline(INPUT, f, plan(FULL));
    expect(f.disposed).toEqual([[INPUT, 'norm-1']]);
  });

  it('disposes on error, including handles made before the failing stage', async () => {
    const f = fakeStages({ throwIn: { recognize: new RecognitionError('failed') } });
    await expect(runScanPipeline(INPUT, f, plan(FULL))).rejects.toMatchObject({ code: 'failed' });
    expect(f.disposed).toEqual([[INPUT, 'crop-1', 'norm-2', 'enh-3']]);
  });

  it('disposes the retry handles too', async () => {
    const f = fakeStages({ reads: [NO_TOTAL, GOOD] });
    await runScanPipeline(INPUT, f, plan(BASE, BASE));
    expect(f.disposed).toEqual([[INPUT, 'norm-1', 'norm-2']]);
  });

  it.each(['locate', 'crop', 'normalize', 'enhance', 'recognize'] as const)(
    'abort during %s → rejects cancelled, later stages are not run, and every handle is disposed',
    async (stage) => {
      const controller = new AbortController();
      const f = fakeStages({ before: (s) => s === stage && controller.abort() });
      const e = await runScanPipeline(INPUT, f, plan(FULL), { signal: controller.signal }).catch((x: unknown) => x);
      expect(e).toMatchObject({ name: 'RecognitionError', code: 'cancelled' });
      const order: StageName[] = ['locate', 'crop', 'normalize', 'enhance', 'recognize'];
      expect(stagesCalled(f)).toEqual(order.slice(0, order.indexOf(stage) + 1));
      expect(f.disposed).toHaveLength(1);
      // Everything a stage returned is in the list (the aborted stage's own result too).
      const expected: Record<typeof stage, string[]> = {
        locate: [INPUT],
        crop: [INPUT, 'crop-1'],
        normalize: [INPUT, 'crop-1', 'norm-2'],
        enhance: [INPUT, 'crop-1', 'norm-2', 'enh-3'],
        recognize: [INPUT, 'crop-1', 'norm-2', 'enh-3'],
      };
      expect(f.disposed[0]).toEqual(expected[stage]);
    },
  );

  it('abort during the retry → cancelled and disposed', async () => {
    const controller = new AbortController();
    let recognizes = 0;
    const f = fakeStages({
      reads: [NO_TOTAL, GOOD],
      before: (s) => {
        if (s === 'recognize' && ++recognizes === 2) controller.abort();
      },
    });
    const e = await runScanPipeline(INPUT, f, plan(BASE, BASE), { signal: controller.signal }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'cancelled' });
    expect(f.disposed).toEqual([[INPUT, 'norm-1', 'norm-2']]);
  });

  it('an already-aborted signal runs no stage and still disposes the input', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fakeStages();
    await expect(runScanPipeline(INPUT, f, plan(FULL), { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.calls).toEqual([]);
    expect(f.disposed).toEqual([[INPUT]]);
  });

  it('a dispose that throws does not mask the result', async () => {
    const f = fakeStages();
    f.dispose = async () => {
      throw new Error('boom');
    };
    await expect(runScanPipeline(INPUT, f, plan(BASE))).resolves.toMatchObject({ best: { verdict: { ok: true } } });
  });
});
