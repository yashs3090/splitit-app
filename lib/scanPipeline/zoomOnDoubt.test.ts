// Zoom on doubt (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 13, criteria 58–61, 70).
// Every input here is hand-made (synthetic rows), not copied from lib/fixtures/receipts.ts or any
// receipt's OCR output (criterion 70).
import { parseReceipt } from '../receiptText';
import type { RecognizedLine, RecognizedText } from '../receiptTypes';
import { RecognitionError } from '../recognitionError';
import { assessQuality } from './assessQuality';
import { MAX_RESCALE, MIN_RESCALE } from './textHeight';
import type { ZoomOptions } from './types';
import {
  MAX_ZOOM_ROWS,
  NO_TOTAL_LOOKAHEAD_LINES,
  ZOOM_DEFAULT_TARGET_PX,
  ZOOM_LOW_CONFIDENCE,
  ZOOM_MARGIN_LINE_HEIGHTS,
  ZOOM_MARGIN_MIN_PX,
  ZOOM_MIN_CONFIDENCE_GAIN,
  acceptZoomRead,
  clampRect,
  countPriceTokens,
  hasPriceToken,
  lineRole,
  scaledCropSize,
  selectDoubtfulRows,
  zoomCropRect,
  zoomOnDoubt,
  zoomScale,
  type ZoomReread,
} from './zoomOnDoubt';

const ROW_H = 20;
/** A synthetic line on row `i` (30 px pitch, 20 px boxes). */
function L(text: string, confidence: number | undefined, i: number): RecognizedLine {
  const box = { x: 10, y: i * 30, width: 300, height: ROW_H };
  return confidence === undefined ? { text, box } : { text, box, confidence };
}
function T(rows: [string, number | undefined][]): RecognizedText {
  return { lines: rows.map(([text, c], i) => L(text, c, i)) };
}
function select(text: RecognizedText, opts: Partial<Pick<ZoomOptions, 'minLineConfidence' | 'maxRows'>> = {}) {
  const parsed = parseReceipt(text);
  return selectDoubtfulRows(text, parsed, assessQuality(text, parsed), {
    minLineConfidence: opts.minLineConfidence ?? ZOOM_LOW_CONFIDENCE,
    maxRows: opts.maxRows ?? MAX_ZOOM_ROWS,
  });
}
const OPTS: ZoomOptions = {
  minLineConfidence: ZOOM_LOW_CONFIDENCE,
  maxRows: MAX_ZOOM_ROWS,
  minConfidenceGain: ZOOM_MIN_CONFIDENCE_GAIN,
  targetLineHeightPx: ZOOM_DEFAULT_TARGET_PX,
};

describe('constants (criterion 71: starting values)', () => {
  it('has the spec starting values', () => {
    expect(MAX_ZOOM_ROWS).toBe(8);
    expect(ZOOM_LOW_CONFIDENCE).toBe(60);
    expect(ZOOM_MIN_CONFIDENCE_GAIN).toBe(5);
    expect(ZOOM_MARGIN_MIN_PX).toBe(10);
    expect(ZOOM_MARGIN_LINE_HEIGHTS).toBe(0.3);
    expect(ZOOM_DEFAULT_TARGET_PX).toBe(40);
  });
});

describe('price tokens (same shape as the parser\'s money token)', () => {
  it.each([
    ['Widget 12.99', 1],
    ['Widget $12.99', 1],
    ['Widget 1,234.50', 1],
    ['Widget (3.00)', 1],
    ['Widget 12.9', 0],
    ['Widget 12.999', 0],
    ['Widget 1299', 0],
    ['Rate 8.25%', 0],
    ['Widget S12 99', 0],
    ['2 @ 4.50 9.00', 2],
    ['', 0],
  ])('%j has %i', (s, n) => {
    expect(countPriceTokens(s)).toBe(n);
    expect(hasPriceToken(s)).toBe(n > 0);
  });

  it('agrees with the parser: a name plus the token is an item exactly when it has a price token', () => {
    for (const tok of ['4.25', '$4.25', '1,004.25', '4.2', '4.255', '425', '4.25%', '$4.2O']) {
      const asItem = parseReceipt({ lines: [{ text: `Widget ${tok}` }] }).items.length > 0;
      expect([tok, hasPriceToken(`Widget ${tok}`)]).toEqual([tok, asItem]);
    }
  });
});

describe('lineRole (what the line is on its own)', () => {
  it.each([
    ['Widget 4.25', 'item'],
    ['Subtotal 10.00', 'subtotal'],
    ['Tax 0.80', 'tax'],
    ['Tip 2.00', 'tip'],
    ['Service charge 1.50', 'fees'],
    ['Total 14.30', 'total'],
    ['Coupon -1.00', 'discount'],
    ['$4.25', 'price'],
    ['Tax 0.8', null],
    ['Thank you', null],
    ['Card 14.30', null],
  ])('%j → %s', (s, role) => {
    expect(lineRole(s)).toBe(role);
  });
});

describe('selectDoubtfulRows (criterion 58)', () => {
  it('looks only in the item region: from the first priced line to the total line', () => {
    const text = T([
      ['Header with 12 digits', 10], // before the first price: never picked
      ['Widget 4.25', 95],
      ['Gadget 5.75', 95],
      ['Total 10.00', 95],
      ['Footer 555 0100', 5], // after the total: never picked
    ]);
    expect(select(text)).toEqual([]);
  });

  it('a row with no 2-dp price qualifies (a digit or $ in it first), as does a low-confidence row; confident priced rows don\'t', () => {
    const text = T([
      ['Widget 4.25', 95],
      ['Gadget $5.7', 90], // broken price
      ['Sprocket', 80], // no price, no digit
      ['Doohickey 3.00', 40], // low confidence
      ['Gizmo 2.00', 60], // exactly at the threshold: not low
      ['Subtotal 9.25', 95],
      ['Total 9.25', 95],
    ]);
    expect(select(text).map((r) => [r.index, r.reason])).toEqual([
      [1, 'no_price'],
      [2, 'no_price'],
      [3, 'low_confidence'],
    ]);
  });

  it('a qty_price_mismatch item\'s row qualifies as implicated', () => {
    const text = T([
      ['3 Lemonade 9.00', 90],
      ['(3 @ 2.00)', 90],
      ['Widget 4.00', 90],
      ['Total 13.00', 90],
    ]);
    expect(parseReceipt(text).items[0]?.flags).toEqual(['qty_price_mismatch']);
    expect(select(text).map((r) => [r.index, r.reason])).toEqual([[0, 'implicated']]);
  });

  it('when the totals don\'t add up, every priced row in the region is implicated (ascending confidence)', () => {
    const text = T([
      ['Widget 4.00', 90],
      ['Gadget 3.00', 70],
      ['Subtotal 10.00', 80],
      ['Total 10.00', 95],
      ['Card 10.00', 50], // after the total
    ]);
    expect(select(text).map((r) => [r.index, r.reason])).toEqual([
      [1, 'implicated'],
      [2, 'implicated'],
      [0, 'implicated'],
      [3, 'implicated'],
    ]);
  });

  it('orders by kind (broken price, implicated, no price, low confidence), then ascending confidence, and caps at maxRows', () => {
    const text = T([
      ['Alpha 1.00', 30],
      ['Beta 2', 50],
      ['Gamma', 10],
      ['Delta $3.0', 20],
      ['Epsilon 4.00', 20],
      ['Total 5.00', 99],
    ]);
    expect(select(text).map((r) => r.index)).toEqual([3, 1, 2, 4, 0]);
    expect(select(text, { maxRows: 2 }).map((r) => r.index)).toEqual([3, 1]);
    expect(select(text, { maxRows: 0 })).toEqual([]);
  });

  it('never returns more than MAX_ZOOM_ROWS with the default options', () => {
    const rows: [string, number][] = Array.from({ length: 20 }, (_, i) => [`Thing${i} ${i + 1}.0`, 30]);
    const text = T([['Start 1.00', 99], ...rows, ['Total 99.00', 99]]);
    expect(select(text)).toHaveLength(MAX_ZOOM_ROWS);
  });

  it('without a total line, the region ends NO_TOTAL_LOOKAHEAD_LINES after the last priced row', () => {
    const tail: [string, number][] = Array.from({ length: NO_TOTAL_LOOKAHEAD_LINES + 3 }, (_, i) => [`Note ${i}`, 10]);
    const text = T([['Widget 4.25', 95], ...tail]);
    expect(select(text).map((r) => r.index)).toEqual(Array.from({ length: NO_TOTAL_LOOKAHEAD_LINES }, (_, i) => i + 1));
  });

  it('skips lines without a box, and a read with no price at all has no region', () => {
    const text: RecognizedText = { lines: [L('Widget 4.25', 90, 0), { text: 'Gadget 5', confidence: 10 }, L('Total 4.25', 90, 2)] };
    expect(select(text)).toEqual([]);
    expect(select(T([['Nothing here', 10], ['Still 12 nothing', 10]]))).toEqual([]);
  });

  it('a line with no confidence counts as the least confident', () => {
    const text = T([
      ['Widget 4.25', 95],
      ['Gadget 5', 50],
      ['Sprocket 3', undefined],
      ['Total 4.25', 95],
    ]);
    expect(select(text).map((r) => [r.index, r.confidence])).toEqual([
      [2, null],
      [1, 50],
    ]);
  });
});

describe('acceptZoomRead (criterion 59)', () => {
  const old = (text: string, confidence?: number) => L(text, confidence, 0);
  const next = (text: string, confidence?: number) => ({ text, ...(confidence === undefined ? {} : { confidence }) });

  it('accepts a priceless row that gains exactly one price at exactly +5', () => {
    expect(acceptZoomRead(old('Widget $4.2', 50), next('Widget $4.25', 55), 5)).toEqual({ ok: true });
  });

  it('rejects a gain below +5', () => {
    expect(acceptZoomRead(old('Widget $4.2', 50), next('Widget $4.25', 54.9), 5)).toEqual({ ok: false, reason: 'no_gain' });
  });

  it('rejects a higher-confidence read that loses a price', () => {
    expect(acceptZoomRead(old('Widget 4.25', 40), next('Widget 4.2', 90), 5)).toEqual({ ok: false, reason: 'lost_price' });
  });

  it('rejects a priceless row gaining two price tokens', () => {
    expect(acceptZoomRead(old('Widget 4', 40), next('Widget 4.25 4.25', 90), 5)).toEqual({ ok: false, reason: 'not_one_price' });
  });

  it('accepts a changed price at higher confidence (the point: a misread digit)', () => {
    expect(acceptZoomRead(old('Widget 3.00', 40), next('Widget 9.00', 80), 5)).toEqual({ ok: true });
  });

  it('rejects a read that isn\'t a usable item, price or totals line', () => {
    expect(acceptZoomRead(old('Thanks 4', 20), next('Card 4.00', 90), 5)).toEqual({ ok: false, reason: 'invalid_line' });
  });

  it('rejects a read that changes what the line is (a total read as an item)', () => {
    expect(acceptZoomRead(old('Total 14.30', 40), next('Tota 14.30', 90), 5)).toEqual({ ok: false, reason: 'role_changed' });
    expect(acceptZoomRead(old('Tota1 $14.3', 40), next('Total $14.30', 90), 5)).toEqual({ ok: true });
  });

  it('an old line without confidence counts as 0; a new read without confidence is never accepted', () => {
    expect(acceptZoomRead(old('Widget $4.2'), next('Widget $4.25', 5), 5)).toEqual({ ok: true });
    expect(acceptZoomRead(old('Widget $4.2', 0), next('Widget $4.25'), 5)).toEqual({ ok: false, reason: 'no_gain' });
  });

  it('rejects an empty read', () => {
    expect(acceptZoomRead(old('Widget $4.2', 10), next('   ', 99), 5)).toEqual({ ok: false, reason: 'invalid_line' });
  });
});

describe('crop geometry', () => {
  it('margin is max(10 px, 0.3 × box height) on every side', () => {
    expect(zoomCropRect({ x: 100, y: 200, width: 300, height: 20 })).toEqual({ x: 90, y: 190, width: 320, height: 40 });
    // 0.3 × 50 = 15 > 10
    expect(zoomCropRect({ x: 100, y: 200, width: 300, height: 50 })).toEqual({ x: 85, y: 185, width: 330, height: 80 });
  });

  it('clampRect keeps the rect inside the image (integer pixels), null when nothing is left', () => {
    expect(clampRect({ x: -5, y: -3.5, width: 50, height: 20 }, { width: 40, height: 100 })).toEqual({ x: 0, y: 0, width: 40, height: 17 });
    expect(clampRect({ x: 50, y: 0, width: 10, height: 10 }, { width: 40, height: 100 })).toBeNull();
    expect(clampRect({ x: 0, y: 0, width: 0, height: 10 }, { width: 40, height: 100 })).toBeNull();
  });

  it('zoomScale brings the box height to the target, clamped to the text-height factor range', () => {
    expect(zoomScale(20, 40)).toBe(2);
    expect(zoomScale(40, 40)).toBe(1);
    expect(zoomScale(5, 40)).toBe(MAX_RESCALE);
    expect(zoomScale(200, 40)).toBe(MIN_RESCALE);
    expect(() => zoomScale(0, 40)).toThrow(RangeError);
    expect(() => zoomScale(20, Number.NaN)).toThrow(RangeError);
  });

  it('scaledCropSize scales and caps the long edge', () => {
    expect(scaledCropSize({ width: 320, height: 40 }, 2, 2048)).toEqual({ width: 640, height: 80 });
    expect(scaledCropSize({ width: 1500, height: 40 }, 2, 2048)).toEqual({ width: 2048, height: 55 });
    expect(scaledCropSize({ width: 3, height: 1 }, 0.1, 2048)).toEqual({ width: 1, height: 1 });
  });
});

describe('zoomOnDoubt (the re-read loop)', () => {
  /** Answers each re-read from `answers` (by line index); records the calls. */
  function fakeReread(answers: Record<number, { text: string; confidence?: number } | null | Error>) {
    const calls: number[] = [];
    const reread: ZoomReread = async (_line, index) => {
      calls.push(index);
      const a = answers[index];
      if (a instanceof Error) throw a;
      return a ?? null;
    };
    return { reread, calls };
  }

  it('replaces an accepted row (keeping its box), and keeps the zoomed read when it scores better', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 40],
      ['Subtotal 10.00', 95],
      ['Total 10.00', 95],
      ['Thank you', 95], // C2 wants at least 5 lines
    ]);
    const { reread, calls } = fakeReread({ 1: { text: 'Gadget $6.00', confidence: 80 } });
    const r = await zoomOnDoubt(text, OPTS, reread);
    // The broken price first; the sums don't add up as read, so the priced rows are implicated too.
    expect(calls).toEqual([1, 0, 2, 3]);
    expect(r.text.lines[1]).toEqual({ text: 'Gadget $6.00', confidence: 80, box: text.lines[1]?.box });
    expect(r.text.lines.filter((_, i) => i !== 1)).toEqual(text.lines.filter((_, i) => i !== 1));
    expect(r.report).toEqual({
      rows: [
        { index: 1, reason: 'no_price', before: 'Gadget $6.0', oldConfidence: 40, after: 'Gadget $6.00', newConfidence: 80, outcome: 'replaced' },
        { index: 0, reason: 'implicated', before: 'Widget 4.00', oldConfidence: 95, after: null, newConfidence: null, outcome: 'no_read' },
        { index: 2, reason: 'implicated', before: 'Subtotal 10.00', oldConfidence: 95, after: null, newConfidence: null, outcome: 'no_read' },
        { index: 3, reason: 'implicated', before: 'Total 10.00', oldConfidence: 95, after: null, newConfidence: null, outcome: 'no_read' },
      ],
      kept: 'zoomed',
      stopped: null,
    });
    expect(assessQuality(r.text, parseReceipt(r.text)).ok).toBe(true);
  });

  it('a rejected re-read keeps the original line', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 40],
      ['Total 10.00', 95],
    ]);
    const { reread } = fakeReread({ 1: { text: 'Gadget $6.00', confidence: 42 } });
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(r.text).toBe(text);
    expect(r.report.rows[0]).toMatchObject({ outcome: 'no_gain', after: 'Gadget $6.00' });
    expect(r.report.kept).toBe('unchanged');
  });

  it('criterion 60: when the zoomed read parses worse, the original is kept (pickBetter)', async () => {
    // Adds up as read; the low-confidence row's confident re-read would break the sums.
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget 6.00', 30],
      ['Subtotal 10.00', 95],
      ['Total 10.00', 95],
    ]);
    const { reread } = fakeReread({ 1: { text: 'Gadget 8.00', confidence: 90 } });
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(r.report.rows[0]?.outcome).toBe('replaced');
    expect(r.report.kept).toBe('original');
    expect(r.text).toBe(text);
  });

  it('re-reads at most maxRows rows', async () => {
    const rows: [string, number][] = Array.from({ length: 12 }, (_, i) => [`Thing${i} ${i}.5`, 30]);
    const text = T([['Start 1.00', 99], ...rows, ['Total 99.00', 99]]);
    const { reread, calls } = fakeReread({});
    await zoomOnDoubt(text, { ...OPTS, maxRows: 3 }, reread);
    expect(calls).toHaveLength(3);
  });

  it('no doubtful rows → no re-read, the same text back', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Total 4.00', 95],
    ]);
    const { reread, calls } = fakeReread({});
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(calls).toEqual([]);
    expect(r.text).toBe(text);
    expect(r.report).toEqual({ rows: [], kept: 'unchanged', stopped: null });
  });

  it('a re-read that finds nothing, or fails, skips that row and carries on', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 20],
      ['Sprocket $1', 30],
      ['Total 4.00', 95],
    ]);
    const { reread, calls } = fakeReread({ 1: null, 2: new RecognitionError('image_load_failed') });
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(calls).toEqual([1, 2]);
    expect(r.report.rows.map((x) => x.outcome)).toEqual(['no_read', 'read_failed']);
    expect(r.text).toBe(text);
  });

  it('cancel mid-zoom rejects with cancelled and stops re-reading', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 20],
      ['Sprocket $1', 30],
      ['Total 11.00', 95],
    ]);
    const { reread, calls } = fakeReread({ 1: new RecognitionError('cancelled') });
    await expect(zoomOnDoubt(text, OPTS, reread)).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([1]);
  });

  it('an aborted signal between rows rejects with cancelled before the next re-read', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 20],
      ['Sprocket $1', 30],
      ['Total 11.00', 95],
    ]);
    const c = new AbortController();
    const calls: number[] = [];
    const reread: ZoomReread = async (_l, i) => {
      calls.push(i);
      c.abort();
      return { text: 'Gadget $6.00', confidence: 99 };
    };
    await expect(zoomOnDoubt(text, OPTS, reread, c.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([1]);
  });

  it('a timeout mid-zoom stops re-reading and keeps what was accepted so far (still by pickBetter)', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 20],
      ['Sprocket $1', 30],
      ['Bolt $2', 35],
      ['Subtotal 10.00', 95],
      ['Total 10.00', 95],
    ]);
    const { reread, calls } = fakeReread({ 1: { text: 'Gadget $6.00', confidence: 90 }, 2: new RecognitionError('timeout') });
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(calls).toEqual([1, 2]);
    expect(r.report.stopped).toBe('timeout');
    expect(r.report.rows.map((x) => x.outcome)).toEqual(['replaced', 'timeout']);
    expect(r.report.kept).toBe('zoomed');
    expect(r.text.lines[1]?.text).toBe('Gadget $6.00');
  });

  it('an error that isn\'t a RecognitionError is a failed row, not a failed scan', async () => {
    const text = T([
      ['Widget 4.00', 95],
      ['Gadget $6.0', 20],
      ['Total 10.00', 95],
    ]);
    const { reread } = fakeReread({ 1: new Error('boom') });
    const r = await zoomOnDoubt(text, OPTS, reread);
    expect(r.report.rows[0]?.outcome).toBe('read_failed');
  });
});
