// Strip tiling, pure parts (spec Task 12, criteria 55–57 and 70). Every input is synthetic: rendered
// tall pages (test-utils/tallReceipt.ts), random profiles, and hand-made lines. Nothing comes from a
// receipt photo or its OCR output.
import { RECOGNITION_MAX_EDGE } from '../imageSize';
import type { RecognizedLine } from '../receiptTypes';
import { prng } from '../../test-utils/opencv';
import { inTextRow, renderTallPage } from '../../test-utils/tallReceipt';
import { rowInkFromGray } from './web/cv/rowInk';
import {
  blankLimit,
  DEFAULT_TILING,
  estimateLinePitch,
  findCuts,
  MAX_STRIPS,
  mergeStripLines,
  MIN_STRIP_PITCHES,
  planStrips,
  shouldTile,
  STRIP_BLANK_INK_FRACTION,
  STRIP_CUT_WINDOW_FRACTION,
  STRIP_DEDUPE_PITCHES,
  STRIP_DEDUPE_SIMILARITY,
  STRIP_MIN_ASPECT,
  STRIP_MIN_OVERSCALE,
  stripScale,
  type StripRead,
} from './stripTiling';

const CUT = { blankInkFraction: STRIP_BLANK_INK_FRACTION, cutWindowFraction: STRIP_CUT_WINDOW_FRACTION, maxStrips: MAX_STRIPS };
const PLAN = { ...CUT, maxStripPx: RECOGNITION_MAX_EDGE };

describe('trigger (criterion 57)', () => {
  it('the spec starting values', () => {
    expect(DEFAULT_TILING).toEqual({ minAspect: 2.5, minOverscale: 1.25, blankInkFraction: 0.002, cutWindowFraction: 0.25, maxStrips: 6 });
    expect([STRIP_MIN_ASPECT, STRIP_MIN_OVERSCALE, MAX_STRIPS]).toEqual([2.5, 1.25, 6]);
  });

  it.each([
    ['12 MP portrait photo', 3024, 4032],
    ['12 MP landscape photo', 4032, 3024],
    ['a normal receipt crop (1:2)', 900, 1800],
    ['a long-ish crop just under the aspect (1:2.4)', 1100, 2640],
    ['a small thumbnail', 263, 450],
    ['a wide panorama', 6000, 1000],
  ])('normal-aspect / wide images never tile: %s', (_name, width, height) => {
    expect(shouldTile({ width, height }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
  });

  it('needs both conditions: tall enough AND long enough that the cap would shrink it by more than 20%', () => {
    // 1:6 but only 2400 px tall: the cap shrinks it by < 20%.
    expect(shouldTile({ width: 400, height: 2400 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
    // Exactly 1.25 × 2048 = 2560 is not "more than".
    expect(shouldTile({ width: 1024, height: 2560 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
    // Aspect exactly 2.5 and 2561 tall → tiles; a hair under 2.5 → doesn't.
    expect(shouldTile({ width: 1024, height: 2561 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(true);
    expect(shouldTile({ width: 1025, height: 2561 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
    expect(shouldTile({ width: 600, height: 3600 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(true);
  });

  it('bad sizes never tile', () => {
    expect(shouldTile({ width: 0, height: 4000 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
    expect(shouldTile({ width: NaN, height: 4000 }, DEFAULT_TILING, RECOGNITION_MAX_EDGE)).toBe(false);
  });

  it('strips are read at native resolution; only a width over the cap is scaled down', () => {
    expect(stripScale(700, 2048)).toBe(1);
    expect(stripScale(2048, 2048)).toBe(1);
    expect(stripScale(4096, 2048)).toBe(0.5);
  });
});

describe('estimateLinePitch', () => {
  it('is the median distance between text-row tops', () => {
    const page = renderTallPage({ pitch: 44, lineH: 28 });
    const ink = rowInkFromGray(page.gray, page.width, page.height);
    expect(estimateLinePitch(ink, page.width, STRIP_BLANK_INK_FRACTION)).toBe(44);
  });

  it('is null with fewer than 3 text rows', () => {
    const ink = new Uint32Array(300);
    ink.fill(50, 10, 30);
    ink.fill(50, 60, 80);
    expect(estimateLinePitch(ink, 600, STRIP_BLANK_INK_FRACTION)).toBeNull();
  });
});

describe('findCuts (criterion 55)', () => {
  /** A profile: `ink` per row, blank where `blank(y)`. */
  const profile = (h: number, blank: (y: number) => boolean, ink = 80) => Uint32Array.from({ length: h }, (_, y) => (blank(y) ? 0 : ink));

  it('cuts land only on rows whose ink is at or below the threshold', () => {
    const page = renderTallPage();
    const ink = rowInkFromGray(page.gray, page.width, page.height);
    const cuts = findCuts(ink, page.width, { ...CUT, targetStripPx: 1500 })!;
    expect(cuts.length).toBeGreaterThan(0);
    for (const c of cuts) {
      expect(ink[c]).toBeLessThanOrEqual(blankLimit(page.width, STRIP_BLANK_INK_FRACTION));
      expect(inTextRow(page.rows, c)).toBe(false);
    }
  });

  it('the threshold is inclusive: a row with exactly 0.2% of the width inked is blank, one more pixel is not', () => {
    // 1000 px wide → limit 2 px. Rows are all "text" (10 px) except one row of exactly 2 px.
    const ink = profile(3000, () => false, 10);
    ink[1500] = 2;
    expect(findCuts(ink, 1000, { ...CUT, targetStripPx: 1500 })).toEqual([1500]);
    ink[1500] = 3;
    expect(findCuts(ink, 1000, { ...CUT, targetStripPx: 1500 })).toBeNull();
  });

  it('picks the centre of the longest blank run in the window', () => {
    // Blank runs at 1200–1210 (short) and 1600–1660 (long), both inside [1125, 1875].
    const ink = profile(3000, (y) => (y >= 1200 && y < 1210) || (y >= 1600 && y < 1660));
    expect(findCuts(ink, 600, { ...CUT, targetStripPx: 1500 })).toEqual([1629]);
  });

  it('a window with no blank run → null (no tiling at all, never a cut through text)', () => {
    // Blank rows everywhere except a solid 1100–1900 block, which covers the whole first window.
    const ink = profile(3600, (y) => y % 40 < 10 && !(y >= 1100 && y < 1900));
    expect(findCuts(ink, 600, { ...CUT, targetStripPx: 1500 })).toBeNull();
    const page = renderTallPage({ solidBlock: [1000, 2000] });
    const real = rowInkFromGray(page.gray, page.width, page.height);
    expect(findCuts(real, page.width, { ...CUT, targetStripPx: 1500 })).toBeNull();
  });

  it('more than maxStrips strips needed → null', () => {
    const ink = profile(12000, (y) => y % 40 < 10); // needs 12000 / ~1500 ≈ 8 strips
    expect(findCuts(ink, 600, { ...CUT, targetStripPx: 1500 })).toBeNull();
    // Exactly maxStrips strips is allowed.
    const six = findCuts(profile(8500, (y) => y % 40 < 10), 600, { ...CUT, targetStripPx: 1500 });
    expect(six).not.toBeNull();
    expect(six!.length + 1).toBeLessThanOrEqual(MAX_STRIPS);
    expect(findCuts(profile(3600, (y) => y % 40 < 10), 600, { ...CUT, maxStrips: 2, targetStripPx: 1500 })).toBeNull();
  });

  it('a short image → no cuts', () => {
    expect(findCuts(profile(1800, (y) => y % 40 < 10), 600, { ...CUT, targetStripPx: 1500 })).toEqual([]);
    expect(findCuts(new Uint32Array(0), 600, { ...CUT, targetStripPx: 1500 })).toEqual([]);
  });

  it('fixed-seed property test: over 200 random profiles, a cut is never on an inked row', () => {
    const rnd = prng(2026);
    let withCuts = 0;
    for (let i = 0; i < 200; i++) {
      const h = 500 + Math.floor(rnd() * 9000);
      const width = 200 + Math.floor(rnd() * 1800);
      const ink = new Uint32Array(h);
      // Alternating runs of text (random ink, sometimes just above the limit) and gaps (0 or noise at/below it).
      const limit = blankLimit(width, STRIP_BLANK_INK_FRACTION);
      for (let y = 0; y < h; ) {
        const text = 5 + Math.floor(rnd() * (rnd() < 0.1 ? 900 : 40));
        for (let k = 0; k < text && y < h; k++, y++) ink[y] = Math.floor(limit) + 1 + Math.floor(rnd() * width * 0.3);
        const gap = Math.floor(rnd() * 25);
        for (let k = 0; k < gap && y < h; k++, y++) ink[y] = Math.floor(rnd() * (limit + 1));
      }
      const target = 300 + Math.floor(rnd() * 2000);
      const cuts = findCuts(ink, width, { ...CUT, targetStripPx: target });
      if (cuts && cuts.length > 0) withCuts += 1;
      for (const c of cuts ?? []) expect(ink[c]).toBeLessThanOrEqual(limit);
      // And a plan's strip edges are on blank rows too.
      const plan = planStrips(ink, width, { ...CUT, maxStripPx: target * 1.5 });
      for (const [k, s] of (plan?.strips ?? []).entries()) {
        if (k > 0) expect(ink[s.top]).toBeLessThanOrEqual(limit);
        if (k < plan!.strips.length - 1) expect(ink[s.bottom - 1]).toBeLessThanOrEqual(limit);
      }
    }
    // The property isn't vacuous: many profiles were actually cut.
    expect(withCuts).toBeGreaterThan(50);
  });

  it('rejects bad options', () => {
    expect(() => findCuts(new Uint32Array(10), 10, { ...CUT, targetStripPx: 0 })).toThrow(RangeError);
    expect(() => findCuts(new Uint32Array(10), 10, { ...CUT, cutWindowFraction: 1, targetStripPx: 5 })).toThrow(RangeError);
  });
});

describe('planStrips on a synthetic long receipt (40+ rows on a 1:6 page)', () => {
  const page = renderTallPage({ width: 600, height: 3600 });
  const ink = rowInkFromGray(page.gray, page.width, page.height);
  const plan = planStrips(ink, page.width, PLAN)!;

  it('the page is a long receipt: 1:6 and 40+ text rows', () => {
    expect(page.height / page.width).toBe(6);
    expect(page.rows.length).toBeGreaterThanOrEqual(40);
  });

  it('cuts it into a few strips, every cut and every strip edge on paper between rows', () => {
    expect(plan.strips.length).toBeGreaterThanOrEqual(2);
    expect(plan.strips.length).toBeLessThanOrEqual(MAX_STRIPS);
    expect(plan.pitch).toBe(44);
    for (const c of plan.cuts) expect(inTextRow(page.rows, c)).toBe(false);
    plan.strips.forEach((s, k) => {
      if (k > 0) expect(inTextRow(page.rows, s.top)).toBe(false);
      if (k < plan.strips.length - 1) expect(inTextRow(page.rows, s.bottom - 1)).toBe(false);
    });
  });

  it('covers the whole page, each strip under the cap, with about one line of overlap', () => {
    expect(plan.strips[0]!.top).toBe(0);
    expect(plan.strips[plan.strips.length - 1]!.bottom).toBe(page.height);
    for (const s of plan.strips) expect(s.bottom - s.top).toBeLessThanOrEqual(RECOGNITION_MAX_EDGE);
    for (let k = 1; k < plan.strips.length; k++) {
      const overlap = plan.strips[k - 1]!.bottom - plan.strips[k]!.top;
      // One full text row on each side of the cut, give or take the gaps.
      const rowsInOverlap = page.rows.filter((r) => r.top >= plan.strips[k]!.top && r.bottom <= plan.strips[k - 1]!.bottom);
      expect(rowsInOverlap).toHaveLength(2);
      expect(overlap).toBeGreaterThanOrEqual(2 * 28);
      expect(overlap).toBeLessThanOrEqual(4 * plan.pitch);
    }
    // Every text row lies wholly inside at least one strip.
    for (const r of page.rows) expect(plan.strips.some((s) => s.top <= r.top && r.bottom <= s.bottom)).toBe(true);
  });

  it('a shadow along the page (paper 230 → 170) still cuts only between rows', () => {
    const shaded = renderTallPage({ paper: 230, paperGradient: -60, ink: 40, seed: 3 });
    const p = planStrips(rowInkFromGray(shaded.gray, shaded.width, shaded.height), shaded.width, PLAN)!;
    expect(p).not.toBeNull();
    for (const c of p.cuts) expect(inTextRow(shaded.rows, c)).toBe(false);
  });

  it('no tiling: a page with a block of ink across a whole window, a page needing too many strips, a short page, no text', () => {
    const blocked = renderTallPage({ solidBlock: [1000, 2100] });
    expect(planStrips(rowInkFromGray(blocked.gray, blocked.width, blocked.height), blocked.width, PLAN)).toBeNull();
    const huge = renderTallPage({ width: 400, height: 14000 });
    expect(planStrips(rowInkFromGray(huge.gray, huge.width, huge.height), huge.width, PLAN)).toBeNull();
    const short = renderTallPage({ height: 1800 });
    expect(planStrips(rowInkFromGray(short.gray, short.width, short.height), short.width, PLAN)).toBeNull();
    expect(planStrips(new Uint32Array(4000), 600, PLAN)).toBeNull();
  });

  it(`no tiling when the cap leaves strips under ${MIN_STRIP_PITCHES} line pitches`, () => {
    expect(planStrips(ink, page.width, { ...CUT, maxStripPx: 44 * (MIN_STRIP_PITCHES + 2) })).toBeNull();
  });
});

describe('mergeStripLines (criterion 56)', () => {
  const line = (text: string, y: number, confidence?: number, x = 10, h = 20): RecognizedLine => ({
    text,
    box: { x, y, width: 300, height: h },
    ...(confidence === undefined ? {} : { confidence }),
  });
  // Strip 0 covers [0, 1100), strip 1 starts at 1000: overlap [1000, 1100]. Pitch 40.
  const strip = (top: number, lines: RecognizedLine[], scale = 1): StripRead => ({ left: 0, top, scaleX: scale, scaleY: scale, lines });

  it('a line read in both strips of the overlap appears once, keeping the higher-confidence copy', () => {
    const a = strip(0, [line('Soup 4.00', 500, 90), line('Bread 6.00', 1040, 60)]);
    const b = strip(1000, [line('Bread 6.0O', 42, 85), line('Tea 2.00', 200, 88)]);
    const merged = mergeStripLines([a, b], [1100, 2000], 40);
    expect(merged.map((l) => l.text)).toEqual(['Soup 4.00', 'Bread 6.0O', 'Tea 2.00']);
    // On a tie (or no confidences) the first strip's copy stays.
    const tie = mergeStripLines([strip(0, [line('Bread 6.00', 1040)]), strip(1000, [line('Bread 6.0O', 42)])], [1100, 2000], 40);
    expect(tie.map((l) => l.text)).toEqual(['Bread 6.00']);
  });

  it('equal text far apart is kept twice (two identical items), and so is equal text outside the overlap', () => {
    const a = strip(0, [line('Soda 2.00', 300), line('Soda 2.00', 1040)]);
    const b = strip(1000, [line('Soda 2.00', 40 + 40), line('Soda 2.00', 600)]); // 1080: one pitch below 1040
    const merged = mergeStripLines([a, b], [1100, 2000], 40);
    expect(merged.filter((l) => l.text === 'Soda 2.00')).toHaveLength(4);
  });

  it(`a match needs similarity ≥ ${STRIP_DEDUPE_SIMILARITY} and centres within ${STRIP_DEDUPE_PITCHES} pitch`, () => {
    // "Bread 6.00" vs "Brie 9.50": different lines at the same height → both kept.
    const diff = mergeStripLines([strip(0, [line('Bread 6.00', 1040)]), strip(1000, [line('Brie 9.50', 40)])], [1100, 2000], 40);
    expect(diff).toHaveLength(2);
    // Same text, 21 px apart (> 0.5 × 40) → both kept; 20 px → one.
    expect(mergeStripLines([strip(0, [line('Bread 6.00', 1040)]), strip(1000, [line('Bread 6.00', 61)])], [1100, 2000], 40)).toHaveLength(2);
    expect(mergeStripLines([strip(0, [line('Bread 6.00', 1040)]), strip(1000, [line('Bread 6.00', 60)])], [1100, 2000], 40)).toHaveLength(1);
  });

  it('boxes come back in the untiled image\'s pixels (offset and scale), ordered top to bottom', () => {
    // Strip 1 starts at 1000 and was read at half scale (a crop wider than the cap).
    const a = strip(0, [line('B 2.00', 900), line('A 1.00', 100)]);
    const b = strip(1000, [line('D 4.00', 400, undefined, 20, 10), line('C 3.00', 200, undefined, 20, 10)], 0.5);
    const merged = mergeStripLines([a, b], [1100, 3000], 40);
    expect(merged.map((l) => l.text)).toEqual(['A 1.00', 'B 2.00', 'C 3.00', 'D 4.00']);
    expect(merged[2]!.box).toEqual({ x: 40, y: 1400, width: 600, height: 20 });
    expect(merged[3]!.box).toEqual({ x: 40, y: 1800, width: 600, height: 20 });
  });

  it('lines without a box are kept, after their strip\'s previous line', () => {
    const a = strip(0, [line('A 1.00', 100), { text: 'no box' }, line('B 2.00', 300)]);
    expect(mergeStripLines([a], [1000], 40).map((l) => l.text)).toEqual(['A 1.00', 'no box', 'B 2.00']);
  });
});
