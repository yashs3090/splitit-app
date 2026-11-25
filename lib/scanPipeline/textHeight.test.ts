// textHeight (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 8, criterion 40).
// Every input is hand-made (criterion 70), not copied from receipt fixtures or OCR output.
import type { RecognizedLine, RecognizedText } from '../receiptTypes';
import {
  MAX_RESCALE,
  MIN_BOXED_LINES,
  MIN_RESCALE,
  medianLineHeight,
  rescaleFactor,
  secondPassSize,
  TEXT_HEIGHT_BAND,
} from './textHeight';

function boxed(...heights: number[]): RecognizedLine[] {
  return heights.map((height, i) => ({ text: `line ${i}`, box: { x: 0, y: i * 50, width: 200, height } }));
}
const text = (lines: RecognizedLine[]): RecognizedText => ({ lines });

describe('medianLineHeight', () => {
  it('is the median box height (odd count)', () => {
    expect(medianLineHeight(text(boxed(30, 10, 20)))).toBe(20);
  });

  it('averages the two middle heights (even count)', () => {
    expect(medianLineHeight(text(boxed(10, 40, 20, 30)))).toBe(25);
  });

  it('ignores lines without a box', () => {
    const lines = [...boxed(12, 14, 16), { text: 'no box' }, { text: 'no box either' }];
    expect(medianLineHeight(text(lines))).toBe(14);
  });

  it('is robust to one huge merged box (median, not mean)', () => {
    expect(medianLineHeight(text(boxed(20, 21, 22, 23, 400)))).toBe(22);
  });

  it(`is null with fewer than ${MIN_BOXED_LINES} boxed lines`, () => {
    expect(MIN_BOXED_LINES).toBe(3);
    expect(medianLineHeight(text([]))).toBeNull();
    expect(medianLineHeight(text(boxed(20, 22)))).toBeNull();
    expect(medianLineHeight(text([...boxed(20, 22), { text: 'unboxed' }, { text: 'unboxed' }]))).toBeNull();
    expect(medianLineHeight(text(boxed(20, 22, 24)))).toBe(22);
  });

  it('skips boxes with a non-positive or non-finite height', () => {
    expect(medianLineHeight(text(boxed(0, -5, Number.NaN, 20, 30, 40)))).toBe(30);
  });
});

describe('rescaleFactor', () => {
  const opts = { targetLineHeightPx: 40, band: [0.85, 1.15] as [number, number] };

  it('is null inside the band', () => {
    expect(rescaleFactor(40, opts)).toBeNull();
    expect(rescaleFactor(37, opts)).toBeNull();
    expect(rescaleFactor(45, opts)).toBeNull();
  });

  it('is null exactly at either band edge', () => {
    expect(rescaleFactor(34, opts)).toBeNull(); // 40 × 0.85
    expect(rescaleFactor(46, opts)).toBeNull(); // 40 × 1.15
    // Targets whose edges aren't exact in floating point.
    for (const target of [28, 34, 46, 33.3]) {
      const o = { targetLineHeightPx: target, band: [0.85, 1.15] as [number, number] };
      expect(rescaleFactor(target * 0.85, o)).toBeNull();
      expect(rescaleFactor(target * 1.15, o)).toBeNull();
      expect(rescaleFactor(target * 0.85 - 0.01, o)).not.toBeNull();
      expect(rescaleFactor(target * 1.15 + 0.01, o)).not.toBeNull();
    }
  });

  it('is target / median just outside the band', () => {
    expect(rescaleFactor(33.9, opts)).toBeCloseTo(40 / 33.9, 10);
    expect(rescaleFactor(46.1, opts)).toBeCloseTo(40 / 46.1, 10);
    expect(rescaleFactor(20, opts)).toBe(2);
    expect(rescaleFactor(64, opts)).toBe(0.625);
  });

  it(`is clamped to [${MIN_RESCALE}, ${MAX_RESCALE}]`, () => {
    expect([MIN_RESCALE, MAX_RESCALE]).toEqual([0.5, 3]);
    expect(rescaleFactor(5, opts)).toBe(3); // 8× wanted
    expect(rescaleFactor(13.3, opts)).toBe(3); // just over 3× wanted
    expect(rescaleFactor(200, opts)).toBe(0.5); // 0.2× wanted
    expect(rescaleFactor(80, opts)).toBe(0.5); // exactly 0.5×
  });

  it('is null for a missing, zero, negative or non-finite median', () => {
    expect(rescaleFactor(null, opts)).toBeNull();
    expect(rescaleFactor(0, opts)).toBeNull();
    expect(rescaleFactor(-12, opts)).toBeNull();
    expect(rescaleFactor(Number.NaN, opts)).toBeNull();
    expect(rescaleFactor(Number.POSITIVE_INFINITY, opts)).toBeNull();
  });

  it('works with any target (the band is relative)', () => {
    const small = { targetLineHeightPx: 28, band: TEXT_HEIGHT_BAND };
    expect(rescaleFactor(28 * 0.85, small)).toBeNull();
    expect(rescaleFactor(14, small)).toBe(2);
  });

  it('rejects a bad config instead of guessing', () => {
    expect(() => rescaleFactor(20, { targetLineHeightPx: 0, band: [0.85, 1.15] })).toThrow(RangeError);
    expect(() => rescaleFactor(20, { targetLineHeightPx: 40, band: [1.15, 0.85] })).toThrow(RangeError);
    expect(() => rescaleFactor(20, { targetLineHeightPx: 40, band: [0, 1.15] })).toThrow(RangeError);
  });
});

describe('secondPassSize', () => {
  it('scales the first-pass size by the factor, keeping the aspect ratio', () => {
    expect(secondPassSize({ width: 600, height: 1000 }, 1.5, 2048)).toEqual({ width: 900, height: 1500 });
    expect(secondPassSize({ width: 1200, height: 1600 }, 0.5, 2048)).toEqual({ width: 600, height: 800 });
  });

  it('is capped by the long-edge limit', () => {
    expect(secondPassSize({ width: 1000, height: 1600 }, 2, 2048)).toEqual({ width: 1280, height: 2048 });
    expect(secondPassSize({ width: 1600, height: 1000 }, 3, 2048)).toEqual({ width: 2048, height: 1280 });
  });

  it('is null when the result would be the first pass again (already at the cap)', () => {
    expect(secondPassSize({ width: 1280, height: 2048 }, 1.6, 2048)).toBeNull();
    expect(secondPassSize({ width: 500, height: 800 }, 1.0001, 2048)).toBeNull();
  });

  it('never returns a dimension below 1', () => {
    expect(secondPassSize({ width: 1, height: 900 }, 0.5, 2048)).toEqual({ width: 1, height: 450 });
  });

  it('rejects a bad factor or size', () => {
    expect(() => secondPassSize({ width: 100, height: 100 }, 0, 2048)).toThrow(RangeError);
    expect(() => secondPassSize({ width: 0, height: 100 }, 2, 2048)).toThrow(RangeError);
    expect(() => secondPassSize({ width: 100, height: 100 }, Number.NaN, 2048)).toThrow(RangeError);
  });
});
