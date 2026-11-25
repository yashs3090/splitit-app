// Tests for the scan pipeline's "did it work?" rule (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md,
// C2 and criteria 16–18). Every receipt here is synthetic: built to sit exactly on a boundary, not
// taken from a real photo (D3).
import { receiptFixtures } from '../fixtures/receipts';
import type { ParsedItem, ParsedReceipt, RecognizedText } from '../receiptTypes';
import { checkTotals, parseReceipt } from '../receiptText';
import { MIN_LINES, assessQuality, pickBetter, type ScanProblem, type Scored } from './assessQuality';

function item(name: string, totalCents: number): ParsedItem {
  return { name, qty: 1, unitCents: totalCents, totalCents, modifiers: [] };
}

/** A receipt with two items (10.00 + 5.00), subtotal 15.00, tax 1.50, total 16.50: adds up exactly. */
function receipt(over: Partial<ParsedReceipt> = {}): ParsedReceipt {
  return {
    items: [item('Burger', 1000), item('Fries', 500)],
    subtotalCents: 1500,
    taxCents: 150,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: 1650,
    needsReview: false,
    reasons: [],
    ...over,
  };
}

/** `n` recognised lines; their content doesn't matter to the rule, only how many there are. */
function lines(n: number): RecognizedText {
  return { lines: Array.from({ length: n }, (_, i) => ({ text: `line ${i}` })) };
}

const ENOUGH = lines(8);

describe('assessQuality', () => {
  it('a receipt that adds up exactly is ok with no gap', () => {
    expect(assessQuality(ENOUGH, receipt())).toEqual({ ok: true, problems: [], gapCents: 0 });
  });

  describe('items vs subtotal (the parser tolerance, ±1¢)', () => {
    it('exactly 1¢ off is ok, and the gap is still reported', () => {
      // Items 15.00, subtotal 14.99, total adjusted so the second check is exact.
      const v = assessQuality(ENOUGH, receipt({ subtotalCents: 1499, totalCents: 1649 }));
      expect(v).toEqual({ ok: true, problems: [], gapCents: 1 });
    });

    it('2¢ off is items_vs_subtotal', () => {
      const v = assessQuality(ENOUGH, receipt({ subtotalCents: 1498, totalCents: 1648 }));
      expect(v).toEqual({ ok: false, problems: ['items_vs_subtotal'], gapCents: 2 });
    });

    it('2¢ off in the other direction is items_vs_subtotal too', () => {
      const v = assessQuality(ENOUGH, receipt({ subtotalCents: 1502, totalCents: 1652 }));
      expect(v).toEqual({ ok: false, problems: ['items_vs_subtotal'], gapCents: 2 });
    });
  });

  describe('subtotal vs total (the parser tolerance, ±1¢)', () => {
    it('exactly 1¢ off is ok', () => {
      expect(assessQuality(ENOUGH, receipt({ totalCents: 1651 }))).toEqual({ ok: true, problems: [], gapCents: 1 });
    });

    it('2¢ off is subtotal_vs_total', () => {
      expect(assessQuality(ENOUGH, receipt({ totalCents: 1648 }))).toEqual({
        ok: false,
        problems: ['subtotal_vs_total'],
        gapCents: 2,
      });
    });
  });

  it('1¢ off on both checks is ok: each check has its own ±1¢ (M1b A3.2)', () => {
    // Items 15.00 vs subtotal 14.99 (+1); 14.99 + 1.50 = 16.49 vs total 16.50 (−1).
    expect(assessQuality(ENOUGH, receipt({ subtotalCents: 1499 }))).toEqual({ ok: true, problems: [], gapCents: 2 });
  });

  it('1¢ on one check and 2¢ on the other is not ok, naming only the 2¢ check', () => {
    // Items 15.00 vs subtotal 14.99 (+1); 14.99 + 1.50 = 16.49 vs total 16.51 (−2).
    expect(assessQuality(ENOUGH, receipt({ subtotalCents: 1499, totalCents: 1651 }))).toEqual({
      ok: false,
      problems: ['subtotal_vs_total'],
      gapCents: 3,
    });
  });

  it('0 items is no_items', () => {
    const v = assessQuality(ENOUGH, receipt({ items: [] }));
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(['no_items']);
  });

  describe('too_few_lines', () => {
    it('MIN_LINES is 5', () => {
      expect(MIN_LINES).toBe(5);
    });

    it('MIN_LINES − 1 lines is too_few_lines', () => {
      const v = assessQuality(lines(MIN_LINES - 1), receipt());
      expect(v).toEqual({ ok: false, problems: ['too_few_lines'], gapCents: 0 });
    });

    it('exactly MIN_LINES lines is no problem', () => {
      expect(assessQuality(lines(MIN_LINES), receipt()).ok).toBe(true);
    });

    it('0 lines is too_few_lines', () => {
      expect(assessQuality(lines(0), receipt()).problems).toContain('too_few_lines');
    });
  });

  it('no total is no_total', () => {
    // Without a total only items vs subtotal can run, and it adds up.
    expect(assessQuality(ENOUGH, receipt({ totalCents: null }))).toEqual({
      ok: false,
      problems: ['no_total'],
      gapCents: 0,
    });
  });

  it('a missing subtotal alone is ok when items + extras = total (A2.1)', () => {
    expect(assessQuality(ENOUGH, receipt({ subtotalCents: null }))).toEqual({ ok: true, problems: [], gapCents: 0 });
  });

  it('a missing subtotal is subtotal_vs_total when items + extras are 2¢ off the total', () => {
    expect(assessQuality(ENOUGH, receipt({ subtotalCents: null, totalCents: 1652 }))).toEqual({
      ok: false,
      problems: ['subtotal_vs_total'],
      gapCents: 2,
    });
  });

  it('ignores qty_price_mismatch: the user fixes that in the form, a rescan does not', () => {
    const r = receipt({ reasons: ['qty_price_mismatch'], needsReview: true });
    expect(assessQuality(ENOUGH, r).ok).toBe(true);
  });

  it('reports several problems in a fixed order', () => {
    expect(assessQuality(lines(1), receipt({ items: [], totalCents: null })).problems).toEqual([
      'no_items',
      'too_few_lines',
      'no_total',
    ]);
  });

  it('agrees with checkTotals on every parser fixture (expected and actual parse)', () => {
    for (const f of receiptFixtures) {
      for (const parsed of [f.expected, parseReceipt(f.text)]) {
        const fromParser = checkTotals(parsed).filter((r) => r === 'items_vs_subtotal' || r === 'subtotal_vs_total');
        const fromRule = assessQuality(f.text, parsed).problems.filter(
          (p) => p === 'items_vs_subtotal' || p === 'subtotal_vs_total',
        );
        expect({ name: f.name, problems: fromRule }).toEqual({ name: f.name, problems: fromParser });
        expect({ name: f.name, noTotal: assessQuality(f.text, parsed).problems.includes('no_total') }).toEqual({
          name: f.name,
          noTotal: checkTotals(parsed).includes('missing_total'),
        });
      }
    }
  });
});

describe('pickBetter', () => {
  type V = { problems?: ScanProblem[]; gapCents?: number; items?: number; lines?: number };
  /**
   * A scored read with its verdict set by hand, so each test isolates one ordering step. Hand-made
   * (D3): the problem lists are the shapes assessQuality can produce, not copied from any photo.
   */
  function scored(tag: string, v: V): Scored & { tag: string } {
    const problems = v.problems ?? [];
    return {
      tag,
      text: lines(v.lines ?? 8),
      parsed: receipt({ items: Array.from({ length: v.items ?? 2 }, (_, i) => item(`i${i}`, 100)) }),
      verdict: { ok: problems.length === 0, problems, gapCents: v.gapCents ?? 0 },
    };
  }

  /** `better` wins whichever side it is passed on. */
  function expectWins(better: Scored & { tag: string }, worse: Scored & { tag: string }) {
    expect(pickBetter(better, worse).tag).toBe(better.tag);
    expect(pickBetter(worse, better).tag).toBe(better.tag);
  }

  it('1. ok beats not ok, even with worse later steps', () => {
    expectWins(scored('ok', { items: 1, lines: 5, gapCents: 2 }), scored('bad', { problems: ['subtotal_vs_total'], gapCents: 2, items: 9, lines: 30 }));
  });

  describe('2–4. a read that found more of the receipt beats one that found less, whatever the gap', () => {
    // The Task 8 inversion: a read with no total has gapCents 0 (there is nothing to compare), so
    // "fewer problems, then smaller gap" ranked it above a read that found the total but is off.
    it('found a total (off by $40.00) beats no total', () => {
      expectWins(
        scored('total', { problems: ['subtotal_vs_total'], gapCents: 4000, items: 4 }),
        scored('noTotal', { problems: ['no_total'], gapCents: 0, items: 4 }),
      );
    });

    it('found a total beats no total even when it has more items and lines', () => {
      expectWins(
        scored('total', { problems: ['subtotal_vs_total'], gapCents: 300, items: 2, lines: 10 }),
        scored('noTotal', { problems: ['no_total'], items: 9, lines: 40 }),
      );
    });

    it('a total failing both checks still beats no total (the count of gap problems is not severity)', () => {
      expectWins(
        scored('total', { problems: ['items_vs_subtotal', 'subtotal_vs_total'], gapCents: 900 }),
        scored('noTotal', { problems: ['no_total'] }),
      );
    });

    it('no total but the items add up to the subtotal still loses to a total that is off', () => {
      expectWins(
        scored('total', { problems: ['items_vs_subtotal'], gapCents: 50 }),
        scored('noTotal', { problems: ['no_total'], gapCents: 1 }),
      );
    });

    it('found items beats no items, even when the itemless read has a total and adds up otherwise', () => {
      expectWins(
        scored('items', { problems: ['no_total', 'items_vs_subtotal'], gapCents: 700, items: 1 }),
        scored('noItems', { problems: ['no_items'], items: 0, lines: 30 }),
      );
    });

    it('found items beats no items when both lack a total', () => {
      expectWins(
        scored('items', { problems: ['no_total'], items: 1 }),
        scored('noItems', { problems: ['no_items', 'no_total'], items: 0 }),
      );
    });

    it('a fragment (too few lines) loses to a full read that is off', () => {
      expectWins(
        scored('full', { problems: ['subtotal_vs_total'], gapCents: 500, lines: 20 }),
        scored('fragment', { problems: ['too_few_lines'], lines: 4 }),
      );
    });

    it('a full read with no total beats a fragment', () => {
      expectWins(scored('full', { problems: ['no_total'], lines: 20 }), scored('fragment', { problems: ['too_few_lines'], lines: 4 }));
    });

    it('a fragment with items beats a full read with no items', () => {
      expectWins(
        scored('fragment', { problems: ['too_few_lines'], items: 1, lines: 4 }),
        scored('noItems', { problems: ['no_items'], items: 0, lines: 30 }),
      );
    });
  });

  describe('5–6. between reads that found as much, the smaller gap wins, then fewer failed checks', () => {
    it('smaller gapCents wins over more items', () => {
      expectWins(
        scored('near', { problems: ['subtotal_vs_total'], gapCents: 2, items: 1 }),
        scored('far', { problems: ['subtotal_vs_total'], gapCents: 3, items: 9 }),
      );
    });

    it('two checks off by 2¢ each beat one check off by $50.00', () => {
      expectWins(
        scored('close', { problems: ['items_vs_subtotal', 'subtotal_vs_total'], gapCents: 4 }),
        scored('far', { problems: ['subtotal_vs_total'], gapCents: 5000 }),
      );
    });

    it('smaller gapCents decides between two reads with no total', () => {
      expectWins(
        scored('near', { problems: ['no_total', 'items_vs_subtotal'], gapCents: 2 }),
        scored('far', { problems: ['no_total', 'items_vs_subtotal'], gapCents: 90 }),
      );
    });

    it('at the same gap, fewer failed checks wins', () => {
      expectWins(
        scored('one', { problems: ['subtotal_vs_total'], gapCents: 4, items: 1 }),
        scored('two', { problems: ['items_vs_subtotal', 'subtotal_vs_total'], gapCents: 4, items: 9 }),
      );
    });

    it('between two ok reads, the smaller in-tolerance gap wins', () => {
      expectWins(scored('exact', { gapCents: 0, items: 1 }), scored('cent', { gapCents: 1, items: 9 }));
    });
  });

  it('7. more items wins', () => {
    expectWins(scored('more', { items: 3, lines: 5 }), scored('fewer', { items: 2, lines: 30 }));
  });

  it('8. more lines wins', () => {
    expectWins(scored('more', { lines: 9 }), scored('fewer', { lines: 8 }));
  });

  it('9. a full tie keeps the first argument', () => {
    const v: V = { problems: ['items_vs_subtotal', 'subtotal_vs_total'], gapCents: 4, items: 2, lines: 8 };
    const a = scored('a', v);
    const b = scored('b', v);
    expect(pickBetter(a, b)).toBe(a);
    expect(pickBetter(b, a)).toBe(b);
  });

  it('agrees with assessQuality end to end: a read with a total that is off beats the same read without the total line', () => {
    // Synthetic: the second read lost its TOTAL line, the first misread the total by $10.00.
    const withTotal = receipt({ totalCents: 2650 });
    const noTotal = receipt({ totalCents: null });
    const a = { tag: 'total', text: ENOUGH, parsed: withTotal, verdict: assessQuality(ENOUGH, withTotal) };
    const b = { tag: 'noTotal', text: ENOUGH, parsed: noTotal, verdict: assessQuality(ENOUGH, noTotal) };
    expect(a.verdict.gapCents).toBeGreaterThan(b.verdict.gapCents);
    expectWins(a, b);
  });
});
