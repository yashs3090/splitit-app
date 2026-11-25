// meanLineConfidence (spec C1 `meta.meanLineConfidence`, C3 `RecognizeResult.meanLineConfidence`).
// Hand-made lines, not copied from any receipt (criterion 70).
import type { RecognizedLine } from '../receiptTypes';
import { meanLineConfidence } from './lineConfidence';

const l = (confidence?: number): RecognizedLine => (confidence === undefined ? { text: 'x' } : { text: 'x', confidence });

describe('meanLineConfidence', () => {
  it('averages the lines that have a confidence', () => {
    expect(meanLineConfidence([l(90), l(60), l()])).toBe(75);
  });

  it('is null when no line has one (native, or an engine without confidences) or there are no lines', () => {
    expect(meanLineConfidence([l(), l()])).toBeNull();
    expect(meanLineConfidence([])).toBeNull();
  });

  it('ignores values outside 0–100 or not finite', () => {
    expect(meanLineConfidence([l(50), l(Number.NaN), l(-3), l(101), l(Number.POSITIVE_INFINITY)])).toBe(50);
  });

  it('keeps 0 and 100', () => {
    expect(meanLineConfidence([l(0), l(100)])).toBe(50);
  });
});
