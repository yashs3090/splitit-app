// The harness refuses a cv variant's run that didn't really use OpenCV (spec Task 9 harness fix).
// Hand-made result objects; no browser.
import { cvRunProblem, MIN_CV_LOAD_MS } from './checks';
import type { OcrHarnessFile } from './protocol';

function file(over: { trace?: OcrHarnessFile['trace']; cvCalls?: number; cvLoad?: number } = {}): OcrHarnessFile {
  return {
    version: 1,
    variant: 'web-crop-canvas',
    photo: 'receipts/x.jpg',
    source: { width: 100, height: 200 },
    prepared: [{ width: 100, height: 200 }],
    lines: [],
    stages: {
      locate: { method: 'none', confidence: 0, quad: null },
      cropApplied: false,
      scale: [1],
      enhance: [],
      passes: 1,
      tiles: 0,
      zoomRereads: 0,
      retried: false,
    },
    meta: {
      medianLineHeight: null,
      meanLineConfidence: null,
      timingsMs: { decode: 1, cvLoad: over.cvLoad ?? 250, locate: 1, crop: 0, normalize: 1, enhance: 0, ocr: 1, total: 260 },
      ...(over.cvCalls === undefined ? { cvCalls: 3 } : { cvCalls: over.cvCalls }),
    },
    trace: over.trace ?? [{ variant: 'web-crop-canvas', stage: 'crop', event: 'skipped', reason: 'low_confidence' }],
  };
}

describe('cvRunProblem', () => {
  it('a real cv run passes; a non-cv variant is never checked', () => {
    expect(cvRunProblem(true, file())).toBeNull();
    expect(cvRunProblem(false, file({ cvCalls: 0, cvLoad: 0, trace: [{ variant: 'v', stage: 'locate', event: 'unavailable' }] }))).toBeNull();
  });

  it.each(['unavailable', 'fallback'] as const)('a cv stage that was `%s` fails the run, naming the stage', (event) => {
    expect(cvRunProblem(true, file({ trace: [{ variant: 'v', stage: 'enhance', event }] }))).toMatch(new RegExp(`enhance.*${event}`));
  });

  it('no successful cv call (or the count missing) fails the run', () => {
    expect(cvRunProblem(true, file({ cvCalls: 0 }))).toMatch(/never used/);
    const f = file();
    delete f.meta.cvCalls;
    expect(cvRunProblem(true, f)).toMatch(/never used/);
  });

  it(`a cvLoad under ${MIN_CV_LOAD_MS} ms fails; exactly ${MIN_CV_LOAD_MS} passes`, () => {
    expect(cvRunProblem(true, file({ cvLoad: MIN_CV_LOAD_MS - 1 }))).toMatch(/too short/);
    expect(cvRunProblem(true, file({ cvLoad: MIN_CV_LOAD_MS }))).toBeNull();
    expect(cvRunProblem(true, file({ cvLoad: Number.NaN }))).toMatch(/too short/);
  });
});
