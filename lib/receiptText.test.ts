import { getFixture, linesOf, receiptFixtures, visionColumnsBoxless } from './fixtures/receipts';
import { checkTotals, parseReceipt, totalsGaps } from './receiptText';
import type { ParsedItem, ParsedReceipt } from './receiptTypes';

function allCents(r: ParsedReceipt): (number | null)[] {
  return [
    r.subtotalCents,
    r.taxCents,
    r.tipCents,
    r.feesCents,
    r.totalCents,
    ...r.items.flatMap((i) => [i.unitCents, i.totalCents]),
    ...r.discounts.map((d) => d.cents),
  ];
}

describe('parseReceipt fixtures', () => {
  it('has the 12 spec fixtures (11 has a 1c and a 2c variant), vision-tilted, item-discount and the real receipts', () => {
    expect(receiptFixtures.map((f) => f.name)).toEqual([
      'diner-simple',
      'qty-and-at',
      'modifiers',
      'discount-before-subtotal',
      'discount-after-subtotal',
      'no-tip-no-dollar',
      'suggested-tip-block',
      'two-taxes-service-charge',
      'card-slip-noise',
      'vision-columns',
      'does-not-add-up-1c',
      'does-not-add-up',
      'missing-total',
      'vision-tilted',
      'item-discount',
      'tesseract-el-chalan',
      'tesseract-la-cabana',
      'el-chalan-as-printed',
      'la-cabana-as-printed',
      'tesseract-el-chalan-web',
      'tesseract-raintree-web',
    ]);
  });

  it.each(receiptFixtures.map((f) => [f.name, f] as const))('%s parses to its expected receipt', (_name, f) => {
    const parsed = parseReceipt(f.text);
    expect(parsed).toEqual(f.expected);
    for (const c of allCents(parsed)) {
      if (c !== null) expect(Number.isInteger(c)).toBe(true);
    }
    for (const i of parsed.items) expect(Number.isInteger(i.qty)).toBe(true);
  });

  it('vision-columns parses the same as the equivalent box-less receipt', () => {
    expect(parseReceipt(getFixture('vision-columns').text)).toEqual(parseReceipt(visionColumnsBoxless));
  });
});

describe('quantities', () => {
  const firstItem = (row: string): ParsedItem | undefined => parseReceipt(linesOf(row, 'Total 99.00')).items[0];

  it('reads "2 x", "2x", leading-integer and "@" forms', () => {
    expect(firstItem('2 x Burger 25.98')).toEqual({ name: 'Burger', qty: 2, unitCents: 1299, totalCents: 2598, modifiers: [] });
    expect(firstItem('2x Burger 25.98')).toMatchObject({ name: 'Burger', qty: 2, unitCents: 1299 });
    expect(firstItem('3 Fries 11.97')).toMatchObject({ name: 'Fries', qty: 3, unitCents: 399, totalCents: 1197 });
    expect(firstItem('Soda 2 @ 2.50 5.00')).toEqual({ name: 'Soda', qty: 2, unitCents: 250, totalCents: 500, modifiers: [] });
    expect(firstItem('Burger 2 @ 12.99 25.98')).toMatchObject({ name: 'Burger', qty: 2, unitCents: 1299, totalCents: 2598 });
  });

  it('flags qty x unit that does not match the line price', () => {
    const r = parseReceipt(linesOf('Soda 2 @ 2.50 6.00', 'Subtotal 6.00', 'Total 6.00'));
    expect(r.items[0]).toEqual({
      name: 'Soda',
      qty: 2,
      unitCents: 250,
      totalCents: 600,
      modifiers: [],
      flags: ['qty_price_mismatch'],
    });
    expect(r.reasons).toEqual(['qty_price_mismatch']);
    expect(r.needsReview).toBe(true);
  });

  it('gives unitCents null when the total does not divide by qty', () => {
    expect(firstItem('3 Wings 10.00')).toMatchObject({ qty: 3, unitCents: null, totalCents: 1000 });
  });

  it('does not treat 0 or 3-digit numbers as a quantity', () => {
    expect(firstItem('0 Calorie Soda 2.00')).toMatchObject({ name: '0 Calorie Soda', qty: 1 });
    expect(firstItem('100 Wings 50.00')).toMatchObject({ name: '100 Wings', qty: 1 });
  });
});

describe('modifiers', () => {
  it('folds priced modifiers into the item and keeps the text', () => {
    const r = parseReceipt(getFixture('modifiers').text);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({ name: 'Bowl', qty: 1, unitCents: 1300, totalCents: 1300, modifiers: ['avocado', 'no onions'] });
  });

  it('handles "add", "-" and recomputes unitCents for qty > 1', () => {
    const r = parseReceipt(linesOf('2 Tacos 8.00', 'add cheese 1.25', '- cilantro', 'Total 9.25'));
    expect(r.items).toEqual([{ name: 'Tacos', qty: 2, unitCents: null, totalCents: 925, modifiers: ['cheese', '- cilantro'] }]);
  });

  it('ignores a modifier with no previous item, and never makes one an item', () => {
    const r = parseReceipt(linesOf('+ avocado 1.50', 'Bowl 11.50', 'Subtotal 11.50', '+ extra 1.00', 'Total 11.50'));
    expect(r.items).toEqual([{ name: 'Bowl', qty: 1, unitCents: 1150, totalCents: 1150, modifiers: [] }]);
  });

  it('a "-" followed by a number is not a modifier (it is a discount, folded into the item per A2.2)', () => {
    const r = parseReceipt(linesOf('Bowl 11.50', '-2.00', 'Subtotal 9.50', 'Total 9.50'));
    expect(r.items).toEqual([{ name: 'Bowl', qty: 1, unitCents: 950, totalCents: 950, modifiers: ['Discount'] }]);
    expect(r.discounts).toEqual([]);
  });
});

describe('discounts', () => {
  it('stores positive cents with the right appliesTo, and both fixtures reconcile', () => {
    const before = parseReceipt(getFixture('discount-before-subtotal').text);
    expect(before.discounts).toEqual([{ label: 'Happy Hour', cents: 300, appliesTo: 'subtotal' }]);
    expect(before.needsReview).toBe(false);
    const after = parseReceipt(getFixture('discount-after-subtotal').text);
    expect(after.discounts).toEqual([{ label: 'Coupon', cents: 500, appliesTo: 'total' }]);
    expect(after.needsReview).toBe(false);
  });

  it('recognises keyword discounts printed without a minus', () => {
    const r = parseReceipt(linesOf('Steak 30.00', '***', 'Promo 5.00', 'Subtotal 25.00', 'Total 25.00'));
    expect(r.items).toHaveLength(1);
    expect(r.discounts).toEqual([{ label: 'Promo', cents: 500, appliesTo: 'subtotal' }]);
    expect(r.needsReview).toBe(false);
  });

  it('A2.2: folds a discount directly under an item into that item, keeping the text as a note', () => {
    const r = parseReceipt(getFixture('item-discount').text);
    expect(r.items[0]).toEqual({ name: 'Burger', qty: 1, unitCents: 1000, totalCents: 1000, modifiers: ['Happy Hour'] });
    expect(r.discounts).toEqual([]);
    expect(r.needsReview).toBe(false);
  });

  it('A2.2: folds after modifiers too, and recomputes unitCents', () => {
    const r = parseReceipt(linesOf('2 Tacos 8.00', '+ cheese 1.00', 'Coupon (1.50)', 'Subtotal 7.50', 'Total 7.50'));
    expect(r.items).toEqual([
      { name: 'Tacos', qty: 2, unitCents: 375, totalCents: 750, modifiers: ['cheese', 'Coupon'] },
    ]);
  });

  it('A2.2: a discount larger than the item stays bill-level and flags the item', () => {
    const r = parseReceipt(linesOf('Soda 2.00', 'Happy Hour -3.00', 'Wings 10.00', 'Subtotal 9.00', 'Total 9.00'));
    expect(r.items[0]).toEqual({
      name: 'Soda',
      qty: 1,
      unitCents: 200,
      totalCents: 200,
      modifiers: [],
      flags: ['qty_price_mismatch'],
    });
    expect(r.discounts).toEqual([{ label: 'Happy Hour', cents: 300, appliesTo: 'subtotal' }]);
    expect(r.reasons).toEqual(['qty_price_mismatch']);
  });

  it('A2.2: after the subtotal a discount stays bill-level even right after a row', () => {
    expect(parseReceipt(getFixture('discount-after-subtotal').text).discounts).toEqual([
      { label: 'Coupon', cents: 500, appliesTo: 'total' },
    ]);
  });

  it.each([
    ['Happy Hour Wings 8.00', 800],
    ['Comp Salad 0.00', 0],
    ['Coupon Book Special 5.00', 500],
    ['Kick-off Nachos 9.00', 900],
  ])('A2.2: a priced name that only contains a discount word is an item: %j', (row, cents) => {
    const r = parseReceipt(linesOf('Soup 6.00', row, 'Total 99.00'));
    expect(r.items[1]).toMatchObject({ name: row.replace(/ \d+\.\d{2}$/, ''), totalCents: cents });
    expect(r.items[0]?.modifiers).toEqual([]);
    expect(r.discounts).toEqual([]);
  });

  it.each(['Discount 2.00', 'Happy Hour Discount 2.00', '20% off 2.00', 'Senior discount 2.00', 'Promo code 2.00'])(
    'A2.2: a label of only discount words is a discount: %j',
    (row) => {
      const r = parseReceipt(linesOf('Soup 6.00', row, 'Total 4.00'));
      expect(r.items).toEqual([expect.objectContaining({ name: 'Soup', totalCents: 400 })]);
    },
  );

  it('does not match "off" inside a word', () => {
    expect(parseReceipt(linesOf('Coffee 3.00', 'Total 3.00')).items).toHaveLength(1);
  });
});

describe('tips and totals', () => {
  it('no-tip fixture has tipCents null and needs no review', () => {
    const r = parseReceipt(getFixture('no-tip-no-dollar').text);
    expect(r.tipCents).toBeNull();
    expect(r.needsReview).toBe(false);
  });

  it('suggested-tip block yields no tip and no items', () => {
    const r = parseReceipt(getFixture('suggested-tip-block').text);
    expect(r.tipCents).toBeNull();
    expect(r.items.map((i) => i.name)).toEqual(['Pho', 'Spring Rolls', 'Thai Tea', 'Banh Mi']);
    expect(r.items.some((i) => /%/.test(i.name))).toBe(false);
    expect(r.needsReview).toBe(false);
  });

  it('a tip row with % outside a suggested block is still a tip', () => {
    expect(parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Tip 18% 1.80', 'Total 11.80')).tipCents).toBe(180);
  });

  it('the last total wins and sub-total spellings are recognised', () => {
    const r = parseReceipt(linesOf('Soup 10.00', 'Sub-total 10.00', 'Total 10.00', 'Gratuity 2.00', 'Grand Total 12.00'));
    expect(r).toMatchObject({ subtotalCents: 1000, tipCents: 200, totalCents: 1200, needsReview: false });
  });

  it('does not read a tax rate percentage as the price', () => {
    expect(parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Tax 8.25% 0.83', 'Total 10.83')).taxCents).toBe(83);
  });

  it('ignores tax and items printed after the total', () => {
    const r = parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Total 10.00', 'Tax 1.00', 'Cookie 2.00'));
    expect(r).toMatchObject({ taxCents: null, totalCents: 1000 });
    expect(r.items).toHaveLength(1);
  });
});

describe('noise rows', () => {
  it('card-slip fixture leaks nothing from payment, server or table rows', () => {
    const r = parseReceipt(getFixture('card-slip-noise').text);
    for (const i of r.items) {
      expect(i.name).not.toMatch(/\d{4}|visa|auth|server|table/i);
    }
    const json = JSON.stringify(r);
    expect(json).not.toContain('1234');
    expect(json).not.toContain('Sam');
  });

  it('a priced payment row before the subtotal is not an item', () => {
    const r = parseReceipt(linesOf('Soup 6.00', 'VISA XXXX1234 6.00', 'Cash 10.00', 'Subtotal 6.00', 'Total 6.00'));
    expect(r.items.map((i) => i.name)).toEqual(['Soup']);
  });
});

describe('checkTotals', () => {
  const base = (over: Partial<ParsedReceipt> = {}): ParsedReceipt => ({
    items: [{ name: 'A', qty: 1, unitCents: 1000, totalCents: 1000, modifiers: [] }],
    subtotalCents: 1000,
    taxCents: 80,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: 1080,
    needsReview: false,
    reasons: [],
    ...over,
  });

  it('passes a reconciled receipt', () => {
    expect(checkTotals(base())).toEqual([]);
  });

  it.each([
    [1001, []],
    [999, []],
    [1002, ['items_vs_subtotal']],
    [998, ['items_vs_subtotal']],
  ])('items vs subtotal %d', (subtotal, reasons) => {
    // keep subtotal_vs_total reconciled
    expect(checkTotals(base({ subtotalCents: subtotal, totalCents: subtotal + 80 }))).toEqual(reasons);
  });

  it.each([
    [1081, []],
    [1079, []],
    [1082, ['subtotal_vs_total']],
    [1078, ['subtotal_vs_total']],
  ])('subtotal vs total %d', (total, reasons) => {
    expect(checkTotals(base({ totalCents: total }))).toEqual(reasons);
  });

  it('counts missing tax, tip and fees as 0, and includes tip, fees and total discounts', () => {
    expect(checkTotals(base({ taxCents: null, totalCents: 1000 }))).toEqual([]);
    expect(
      checkTotals(
        base({
          tipCents: 200,
          feesCents: 150,
          discounts: [
            { label: 'HH', cents: 100, appliesTo: 'subtotal' },
            { label: 'Coupon', cents: 300, appliesTo: 'total' },
          ],
          subtotalCents: 900,
          totalCents: 900 + 80 + 200 + 150 - 300,
        }),
      ),
    ).toEqual([]);
  });

  it('missing subtotal gives missing_subtotal, plus subtotal_vs_total only if items + extras != total (A2.1)', () => {
    expect(checkTotals(base({ subtotalCents: null }))).toEqual(['missing_subtotal']);
    expect(checkTotals(base({ subtotalCents: null, totalCents: 1081 }))).toEqual(['missing_subtotal']);
    expect(checkTotals(base({ subtotalCents: null, totalCents: 1082 }))).toEqual(['missing_subtotal', 'subtotal_vs_total']);
    expect(checkTotals(base({ subtotalCents: null, totalCents: 5 }))).toEqual(['missing_subtotal', 'subtotal_vs_total']);
    expect(checkTotals(base({ items: [], subtotalCents: null, totalCents: 5 }))).toEqual(['no_items', 'missing_subtotal']);
    // all discounts count, whichever side of the (missing) subtotal they were on
    expect(
      checkTotals(
        base({
          subtotalCents: null,
          tipCents: 100,
          feesCents: 50,
          discounts: [
            { label: 'A', cents: 200, appliesTo: 'subtotal' },
            { label: 'B', cents: 30, appliesTo: 'total' },
          ],
          totalCents: 1000 - 200 - 30 + 80 + 50 + 100,
        }),
      ),
    ).toEqual(['missing_subtotal']);
  });

  it('A2.1: parseReceipt flags a no-subtotal receipt whose items do not reach the total', () => {
    expect(parseReceipt(linesOf('Soup 6.00', 'Tax 0.48', 'Total 6.48')).reasons).toEqual(['missing_subtotal']);
    expect(parseReceipt(linesOf('Soup 6.00', 'Tax 0.48', 'Total 9.48')).reasons).toEqual([
      'missing_subtotal',
      'subtotal_vs_total',
    ]);
  });

  it('missing total gives missing_total', () => {
    expect(checkTotals(base({ totalCents: null }))).toEqual(['missing_total']);
  });

  it('no items gives no_items', () => {
    expect(checkTotals(base({ items: [] }))).toEqual(['no_items']);
    expect(checkTotals(base({ items: [], subtotalCents: null, totalCents: null }))).toEqual([
      'no_items',
      'missing_subtotal',
      'missing_total',
    ]);
  });

  it('R1: totalsGaps gives signed cents (computed minus printed) for each check that can run', () => {
    expect(totalsGaps(base())).toEqual({ items_vs_subtotal: 0, subtotal_vs_total: 0 });
    // items 10.00 vs subtotal 9.98: 2 cents over
    expect(totalsGaps(base({ subtotalCents: 998, totalCents: 1078 }))).toEqual({ items_vs_subtotal: 2, subtotal_vs_total: 0 });
    expect(totalsGaps(base({ totalCents: 1082 }))).toEqual({ items_vs_subtotal: 0, subtotal_vs_total: -2 });
    // missing pieces: no gap for checks that can't run
    expect(totalsGaps(base({ totalCents: null }))).toEqual({ items_vs_subtotal: 0 });
    expect(totalsGaps(base({ items: [] }))).toEqual({ subtotal_vs_total: 0 });
    expect(totalsGaps(base({ items: [], subtotalCents: null }))).toEqual({});
  });

  it('R1: totalsGaps covers the A2.1 no-subtotal case (items less every discount, plus extras)', () => {
    expect(totalsGaps(base({ subtotalCents: null, totalCents: 1082 }))).toEqual({ subtotal_vs_total: -2 });
    expect(
      totalsGaps(
        base({
          subtotalCents: null,
          discounts: [
            { label: 'A', cents: 200, appliesTo: 'subtotal' },
            { label: 'B', cents: 30, appliesTo: 'total' },
          ],
          totalCents: 1000 - 200 - 30 + 80 - 5,
        }),
      ),
    ).toEqual({ subtotal_vs_total: 5 });
  });

  it('R1: checkTotals flags exactly the gaps over the 1-cent tolerance', () => {
    for (const [sub, tot] of [[998, 1078], [999, 1082], [1003, 1050], [1000, 1080]] as const) {
      const r = base({ subtotalCents: sub, totalCents: tot });
      const gaps = totalsGaps(r);
      const over = (['items_vs_subtotal', 'subtotal_vs_total'] as const).filter((k) => Math.abs(gaps[k] ?? 0) > 1);
      expect(checkTotals(r)).toEqual(over);
    }
  });

  it('parseReceipt sets needsReview iff reasons is non-empty', () => {
    for (const f of receiptFixtures) {
      const r = parseReceipt(f.text);
      expect(r.needsReview).toBe(r.reasons.length > 0);
    }
  });
});

describe('robustness', () => {
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  it('handles empty input', () => {
    const r = parseReceipt({ lines: [] });
    expect(r.items).toEqual([]);
    expect(r.reasons).toContain('no_items');
    expect(r.needsReview).toBe(true);
  });

  it('never throws on 500 random garbage lines', () => {
    const rand = rng(42);
    const alphabet = 'abcXYZ0123456789 .,$-()+@%#*/:x\t';
    const lines = Array.from({ length: 500 }, () => {
      const len = Math.floor(rand() * 40);
      let text = '';
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)] ?? '';
      return rand() < 0.5
        ? { text }
        : { text, box: { x: rand() * 1000, y: rand() * 4000, width: rand() * 300, height: rand() * 60 } };
    });
    expect(() => parseReceipt({ lines })).not.toThrow();
    const r = parseReceipt({ lines });
    for (const c of allCents(r)) if (c !== null) expect(Number.isInteger(c)).toBe(true);
  });

  it('handles lines of only symbols', () => {
    const r = parseReceipt(linesOf('****', '----', '$$$', '()', '%%%', '....', '@@'));
    expect(r.items).toEqual([]);
    expect(r.reasons).toContain('no_items');
  });
});

describe('review fixes', () => {
  it('R1: merges an unpriced text row with a following price-only row', () => {
    const r = parseReceipt(linesOf('Burger', '12.99', 'Fries', '$3.99', 'Subtotal', '16.98', 'Total 16.98'));
    expect(r.items.map((i) => [i.name, i.totalCents])).toEqual([
      ['Burger', 1299],
      ['Fries', 399],
    ]);
    expect(r).toMatchObject({ subtotalCents: 1698, totalCents: 1698, needsReview: false });
  });

  it('R1: does not merge a price-only row into a row that already has a price', () => {
    const r = parseReceipt(linesOf('Soup 6.00', '2.00', 'Total 6.00'));
    expect(r.items.map((i) => i.name)).toEqual(['Soup']);
  });

  it('R3: "Total Tax" is tax, and savings/items/count summaries are not the total', () => {
    const r = parseReceipt(
      linesOf(
        'Soup 10.00',
        'Subtotal 10.00',
        'Total Tax 0.80',
        'Total 10.80',
        'Total Savings 2.00',
        'Total Discount 2.00',
        'Total Items 3.00',
        'Total Qty 1.00',
        'Item Count 1.00',
        'You saved 2.00',
      ),
    );
    expect(r).toMatchObject({ taxCents: 80, totalCents: 1080, needsReview: false, discounts: [] });
  });

  it('R3: savings summaries before the subtotal are not items or discounts', () => {
    const r = parseReceipt(linesOf('Soup 10.00', 'You saved 2.00', 'Subtotal 10.00', 'Total incl. tax 10.80', 'Tax 0.80'));
    expect(r.items.map((i) => i.name)).toEqual(['Soup']);
    expect(r.discounts).toEqual([]);
    expect(r.totalCents).toBe(1080);
  });

  it.each([
    ['Burger 2 12.99 25.98', { name: 'Burger', qty: 2, unitCents: 1299, totalCents: 2598 }],
    ['2 Burger 12.99 25.98', { name: 'Burger', qty: 2, unitCents: 1299, totalCents: 2598 }],
    ['Soda 2 @ $ 2.50 5.00', { name: 'Soda', qty: 2, unitCents: 250, totalCents: 500 }],
    ['Soda 2 @ 2.50 ea 5.00', { name: 'Soda', qty: 2, unitCents: 250, totalCents: 500 }],
    ['Soda 2 @ 2.50 each 5.00', { name: 'Soda', qty: 2, unitCents: 250, totalCents: 500 }],
  ])('R4: qty/unit/total columns %j', (row, expected) => {
    const r = parseReceipt(linesOf(row, 'Total 99.00'));
    expect(r.items).toEqual([{ ...expected, modifiers: [] }]);
    expect(r.reasons).not.toContain('qty_price_mismatch');
  });

  it('R4: a column unit that does not match qty x unit is flagged', () => {
    const r = parseReceipt(linesOf('Burger 2 12.99 24.00', 'Total 24.00'));
    expect(r.items[0]).toMatchObject({ qty: 2, unitCents: 1299, totalCents: 2400, flags: ['qty_price_mismatch'] });
    expect(r.reasons).toContain('qty_price_mismatch');
  });

  it.each(['12 oz Steak 30.00', '2 lb Brisket 30.00', '6 pc Wings 30.00', '10 in Pizza 30.00', '16 ml Shot 30.00'])(
    'R6: a unit word after a leading number is not a quantity: %j',
    (row) => {
      const item = parseReceipt(linesOf(row, 'Total 30.00')).items[0];
      expect(item).toMatchObject({ qty: 1, unitCents: 3000, name: row.replace(' 30.00', '') });
    },
  );

  it('R6 known limitation: "3 Cheese Pizza" reads 3 as a quantity', () => {
    expect(parseReceipt(linesOf('3 Cheese Pizza 15.00', 'Total 15.00')).items[0]).toMatchObject({
      name: 'Cheese Pizza',
      qty: 3,
      unitCents: 500,
    });
  });

  it.each(['Burger 12.99 T', 'Burger 12.99 TX', 'Burger $12.99 F'])('R7: drops a tax-code letter after the price: %j', (row) => {
    expect(parseReceipt(linesOf(row, 'Total 12.99')).items[0]).toMatchObject({ name: 'Burger', totalCents: 1299 });
  });

  it('R7: keeps a lowercase or longer word after the price', () => {
    expect(parseReceipt(linesOf('Burger 12.99 large', 'Total 12.99')).items[0]?.name).toBe('Burger large');
  });

  it('R8: "no"/"-" rows with a positive price are items, not modifiers', () => {
    const r = parseReceipt(linesOf('Soup 6.00', 'No Bake Cheesecake 7.00', 'Total 13.00'));
    expect(r.items.map((i) => [i.name, i.totalCents, i.modifiers])).toEqual([
      ['Soup', 600, []],
      ['No Bake Cheesecake', 700, []],
    ]);
  });

  it('R8: "+" and "add" rows with a price are still modifiers', () => {
    const r = parseReceipt(linesOf('Bowl 11.50', 'Add Bacon 2.00', 'Total 13.50'));
    expect(r.items).toEqual([{ name: 'Bowl', qty: 1, unitCents: 1350, totalCents: 1350, modifiers: ['Bacon'] }]);
  });

  it.each(['Time 7.45 PM', '7.45pm', 'Order 12.34', 'Order #12.34', 'Time: 11.30 AM'])('R9: %j is not an item', (row) => {
    expect(parseReceipt(linesOf(row, 'Soup 6.00', 'Total 6.00')).items.map((i) => i.name)).toEqual(['Soup']);
  });

  it('R9: "Order of" is still an item', () => {
    expect(parseReceipt(linesOf('Order of Fries 4.00', 'Total 4.00')).items[0]?.name).toBe('Order of Fries');
  });

  it('uses the first subtotal when a receipt prints two (Subtotal / Coupon / Subtotal)', () => {
    const r = parseReceipt(
      linesOf('Pasta 20.00', 'Subtotal 20.00', 'Coupon (5.00)', 'Subtotal 15.00', 'Tax 1.20', 'Total 16.20'),
    );
    expect(r).toMatchObject({
      subtotalCents: 2000,
      discounts: [{ label: 'Coupon', cents: 500, appliesTo: 'total' }],
      totalCents: 1620,
      needsReview: false,
    });
  });
});

describe('backlog item 2: quantity next to the name, tax and total labels', () => {
  const firstItem = (...rows: string[]): ParsedItem | undefined => parseReceipt(linesOf(...rows, 'Total 99.00')).items[0];

  describe('quantity after the name, before a single line price', () => {
    it.each([
      ['Mojito 2 24.00', { name: 'Mojito', qty: 2, unitCents: 1200, totalCents: 2400 }],
      ['Mojito 2 $24.00', { name: 'Mojito', qty: 2, unitCents: 1200, totalCents: 2400 }],
      ['Mojito x2 24.00', { name: 'Mojito', qty: 2, unitCents: 1200, totalCents: 2400 }],
      ['Mojito x 2 24.00', { name: 'Mojito', qty: 2, unitCents: 1200, totalCents: 2400 }],
      ['Mojito 2x 24.00', { name: 'Mojito', qty: 2, unitCents: 1200, totalCents: 2400 }],
      ['LIMONADA 1 $4.00', { name: 'LIMONADA', qty: 1, unitCents: 400, totalCents: 400 }],
      ['Oysters 12 36.00', { name: 'Oysters', qty: 12, unitCents: 300, totalCents: 3600 }],
      ['Beer 15 75.00', { name: 'Beer', qty: 15, unitCents: 500, totalCents: 7500 }],
    ])('%j', (row, expected) => {
      expect(firstItem(row)).toEqual({ ...expected, modifiers: [] });
    });

    it('without a QTY header, a trailing number that does not divide the price stays in the name', () => {
      expect(firstItem('Wings 10 12.99')).toMatchObject({ name: 'Wings 10', qty: 1, unitCents: 1299 });
    });

    it('an explicit "x2" is a quantity even when the price does not divide', () => {
      expect(firstItem('Wings x3 10.00')).toMatchObject({ name: 'Wings', qty: 3, unitCents: null, totalCents: 1000 });
    });

    it('with an ITEM QTY PRICE header, the number after the name is the quantity', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', 'Wings 3 10.00', 'Total 10.00'));
      expect(r.items[0]).toMatchObject({ name: 'Wings', qty: 3, unitCents: null, totalCents: 1000 });
    });

    it('with an ITEM QTY PRICE header, noise before the name is not the quantity', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', '4 CAUSA DE POLLO 1 $8.95', 'Total 8.95'));
      expect(r.items[0]).toMatchObject({ name: 'CAUSA DE POLLO', qty: 1, unitCents: 895, totalCents: 895 });
    });

    it('with a QTY ITEM PRICE header, the leading number wins', () => {
      const r = parseReceipt(linesOf('QTY ITEM PRICE', '2 Combo 3 24.00', 'Total 24.00'));
      expect(r.items[0]).toMatchObject({ name: 'Combo 3', qty: 2, unitCents: 1200 });
    });

    it('R6 still holds: sizes are not quantities, before or after the name', () => {
      expect(firstItem('12 oz Steak 30.00')).toMatchObject({ name: '12 oz Steak', qty: 1 });
      expect(firstItem('Steak 12 oz 30.00')).toMatchObject({ name: 'Steak 12 oz', qty: 1 });
    });

    it('known limitation: a number that is part of the name and divides the price reads as a quantity', () => {
      expect(firstItem('Combo 2 12.00')).toMatchObject({ name: 'Combo', qty: 2, unitCents: 600 });
    });
  });

  describe('quantity before the name', () => {
    it('keeps a menu number like "6." in the name', () => {
      expect(firstItem('1 6. Taco y Enchilada (Super Combo) 21.95')).toEqual({
        name: '6. Taco y Enchilada (Super Combo)',
        qty: 1,
        unitCents: 2195,
        totalCents: 2195,
        modifiers: [],
      });
      expect(firstItem('2 12. Pupusas 9.00')).toMatchObject({ name: '12. Pupusas', qty: 2, unitCents: 450 });
      expect(firstItem('1 2) Combo 12.00')).toMatchObject({ name: '2) Combo', qty: 1, unitCents: 1200 });
      expect(firstItem('2 2) Combo 24.00')).toMatchObject({ name: '2) Combo', qty: 2, unitCents: 1200 });
    });

    it('a number followed by "." or ")" is part of the name, never the quantity', () => {
      expect(firstItem('6. Taco y Enchilada 21.95')).toMatchObject({ name: '6. Taco y Enchilada', qty: 1, unitCents: 2195 });
      expect(firstItem('2) Combo 12.00')).toMatchObject({ name: '2) Combo', qty: 1, unitCents: 1200 });
      expect(firstItem('Combo 2) 12.00')).toMatchObject({ qty: 1, unitCents: 1200 });
    });

    it('reads any small quantity, not just 1', () => {
      expect(firstItem('3 Dos Tacos (Brunch) 54.00')).toMatchObject({ name: 'Dos Tacos (Brunch)', qty: 3, unitCents: 1800 });
    });
  });

  describe('prices glued to text', () => {
    it.each([
      ['1 6. Taco y Enchilada (Super Combo)21.95', '6. Taco y Enchilada (Super Combo)', 2195],
      ['Margarita12.75', 'Margarita', 1275],
      ['Margarita$12.75', 'Margarita', 1275],
    ])('%j', (row, name, cents) => {
      expect(firstItem(row)).toMatchObject({ name, totalCents: cents });
    });
  });

  it('drops a stray single character the camera picked up after the price', () => {
    expect(firstItem('CEVICHE DE CAMARONES 1 $16.95 a')).toMatchObject({ name: 'CEVICHE DE CAMARONES', qty: 1, totalCents: 1695 });
    expect(firstItem('Soup 6.00 /')).toMatchObject({ name: 'Soup', totalCents: 600 });
  });

  describe('tax labels', () => {
    it.each(['Total Taxes $3.67', 'Taxes 3.67', 'Sales Tax 3.67', 'Tax 1 3.67', 'FL Tax 3.67', 'Sales Tax 7% 3.67', 'Tax Total 3.67'])(
      '%j is tax, not the total',
      (row) => {
        const r = parseReceipt(linesOf('Soup 45.85', 'Subtotal $45.85', row, 'Grand Total $49.52'));
        expect(r).toMatchObject({ taxCents: 367, totalCents: 4952, needsReview: false });
      },
    );

    it('sums several tax lines', () => {
      const r = parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Tax 1 0.60', 'Tax 2 0.20', 'Total 10.80'));
      expect(r).toMatchObject({ taxCents: 80, needsReview: false });
    });

    it('a "Total Tax" line after the itemized taxes replaces their sum instead of doubling it', () => {
      const r = parseReceipt(
        linesOf('Soup 10.00', 'Subtotal 10.00', 'FL Tax 0.60', 'County Tax 0.20', 'Total Taxes 0.80', 'Total 10.80'),
      );
      expect(r).toMatchObject({ taxCents: 80, needsReview: false });
    });
  });

  describe('total labels', () => {
    it.each(['Amount Due: $49.52', 'Balance Due 49.52', 'Grand Total 49.52'])('%j is the total', (row) => {
      expect(parseReceipt(linesOf('Soup 45.85', 'Subtotal 45.85', 'Tax 3.67', row)).totalCents).toBe(4952);
    });

    it('equal Grand Total and Amount Due lines are fine', () => {
      const r = parseReceipt(linesOf('Soup 45.85', 'Subtotal 45.85', 'Tax 3.67', 'Grand Total $49.52', 'Amount Due: $49.52'));
      expect(r).toMatchObject({ totalCents: 4952, needsReview: false });
    });

    it.each(['Pay With Cash: 55.49', 'Cash Price 55.49', 'Card Price 57.71', 'Cash Discount Price: 55.49'])(
      '%j is ignored for the total (before or after it)',
      (row) => {
        const after = parseReceipt(linesOf('Soup 52.70', 'Subtotal 52.70', 'Sales Tax 5.01', 'Total 57.71', row));
        expect(after).toMatchObject({ totalCents: 5771, needsReview: false });
        const before = parseReceipt(linesOf('Soup 52.70', 'Subtotal 52.70', 'Sales Tax 5.01', row, 'Total 57.71'));
        expect(before).toMatchObject({ totalCents: 5771, needsReview: false });
        expect(before.items.map((i) => i.name)).toEqual(['Soup']);
      },
    );
  });

  describe('suggested-tip percentage blocks', () => {
    it('a percent row and the amounts under it are not a tip or items, even before the total', () => {
      const r = parseReceipt(
        linesOf('Soup 45.85', 'Subtotal $45.85', 'Tax $3.67', '15% 20% 25%', '$7.43 $9.90 $12.38', 'Total $49.52'),
      );
      expect(r).toMatchObject({ tipCents: null, totalCents: 4952, needsReview: false });
      expect(r.items.map((i) => i.name)).toEqual(['Soup']);
    });

    it('a row of only amounts is never an item', () => {
      const r = parseReceipt(linesOf('Soup 6.00', '$7.43 $9.90 $12.38', 'Subtotal 6.00', 'Total 6.00'));
      expect(r.items.map((i) => i.name)).toEqual(['Soup']);
    });

    it('"TIP IS NOT INCLUDED" is not a tip', () => {
      const r = parseReceipt(linesOf('Soup 6.00', 'Subtotal 6.00', 'Total 6.00', 'TIP IS NOT INCLUDED'));
      expect(r.tipCents).toBeNull();
    });
  });

  describe('integers are quantities, 2-decimal numbers are prices', () => {
    it.each(['Burger 12', 'Burger 2 12', '2 Burger 12', 'Burger 12.5', 'Burger 1299'])(
      'a bare integer or 1-decimal number is never a price: %j',
      (row) => {
        expect(parseReceipt(linesOf(row, 'Soup 6.00', 'Total 6.00')).items.map((i) => i.name)).toEqual(['Soup']);
      },
    );

    it('a 2-decimal number is never the quantity', () => {
      expect(firstItem('Burger 2.00 12.00')).toMatchObject({ name: 'Burger', qty: 1, unitCents: 200, totalCents: 1200 });
    });

    it('quantities are always integers', () => {
      for (const row of ['Mojito 2 24.00', '2 Mojito 24.00', 'Mojito x2 24.00', '1 6. Taco 21.95']) {
        expect(Number.isInteger(firstItem(row)?.qty)).toBe(true);
      }
    });
  });
});

describe('real web captures follow-up: header qty order, damaged totals, gratuity', () => {
  describe('a QTY column header decides which side of the name the quantity is on', () => {
    it('ITEM QTY PRICE: an integer before the name is noise, dropped from the name, qty 1', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', '4 CAUSA DE POLLO RTE $8.95', 'Total 8.95'));
      expect(r.items[0]).toEqual({ name: 'CAUSA DE POLLO RTE', qty: 1, unitCents: 895, totalCents: 895, modifiers: [] });
    });

    it('ITEM QTY PRICE: noise before the name is dropped with a printed unit price too', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', '4 Soda 2 2.50 5.00', 'Total 5.00'));
      expect(r.items[0]).toMatchObject({ name: 'Soda', qty: 2, unitCents: 250, totalCents: 500 });
      expect(r.items[0]?.flags).toBeUndefined();
    });

    it('ITEM QTY PRICE: an explicit "2 x" before the name is still the quantity', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', '2 x Burger 24.00', 'Total 24.00'));
      expect(r.items[0]).toMatchObject({ name: 'Burger', qty: 2, unitCents: 1200 });
    });

    it.each(['QTY ITEM PRICE', 'QTY DESCRIPTION AMOUNT'])(
      '%s: an integer after the name is not the quantity, even when it divides the price',
      (header) => {
        const r = parseReceipt(linesOf(header, 'Wings 3 12.00', 'Total 12.00'));
        expect(r.items[0]).toMatchObject({ name: 'Wings 3', qty: 1, unitCents: 1200 });
      },
    );

    it('QTY ITEM PRICE: the leading integer is the quantity', () => {
      const r = parseReceipt(linesOf('QTY ITEM PRICE', '4 Tacos 12.00', 'Total 12.00'));
      expect(r.items[0]).toMatchObject({ name: 'Tacos', qty: 4, unitCents: 300 });
    });

    it('QTY ITEM PRICE: an explicit "x3" after the name is still the quantity', () => {
      const r = parseReceipt(linesOf('QTY ITEM PRICE', 'Wings x3 10.00', 'Total 10.00'));
      expect(r.items[0]).toMatchObject({ name: 'Wings', qty: 3, totalCents: 1000 });
    });

    it('without a header, a leading integer is still the quantity', () => {
      const r = parseReceipt(linesOf('4 CAUSA DE POLLO $8.00', 'Total 8.00'));
      expect(r.items[0]).toMatchObject({ name: 'CAUSA DE POLLO', qty: 4, unitCents: 200 });
    });

    it('rows above the header are not affected by it', () => {
      const r = parseReceipt(linesOf('4 Tacos 12.00', 'ITEM QTY PRICE', 'Soup 1 6.00', 'Total 18.00'));
      expect(r.items.map((i) => [i.name, i.qty])).toEqual([
        ['Tacos', 4],
        ['Soup', 1],
      ]);
    });
  });

  describe('a total line with a time in front or an OCR-damaged "Total"', () => {
    const totalOf = (row: string) =>
      parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', 'Gratuity 15.60', row));

    it.each([
      '09:19PM Tota) 126.37',
      '"09:19PM Tota) 126.37',
      '09:19PM Total 126.37',
      '9:19 PM Total 126.37',
      '9:19 p.m. Total: 126.37',
      '09:19PH Total 126.37',
      '21:19 Total 126.37',
      'Tota) 126.37',
      'Tota] 126.37',
      'Tota1 126.37',
      'TotaI 126.37',
      'T0tal 126.37',
      'TOTA) $126.37',
    ])('%j is the total', (row) => {
      expect(totalOf(row)).toMatchObject({ totalCents: 12637, tipCents: 1560, needsReview: false });
    });

    it.each(['Subtota) 104.00', 'Subtota1 104.00', 'Sub Tota1 104.00'])('%j is the subtotal', (row) => {
      const r = parseReceipt(linesOf('Soup 104.00', row, 'Total 104.00'));
      expect(r).toMatchObject({ subtotalCents: 10400, totalCents: 10400, needsReview: false });
      expect(r.items.map((i) => i.name)).toEqual(['Soup']);
    });

    it('a time in front of a tax-sum line still reads as tax, not the total', () => {
      const r = parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', '09:19PM Total Tax 0.80', 'Total 10.80'));
      expect(r).toMatchObject({ taxCents: 80, totalCents: 1080, needsReview: false });
    });

    it.each(['09:19PM Total Savings 5.00', '09:19PM Total Items 5.00', '7:45 PM 5.00', '7:45 PM Table 5 20.00', '7.45 PM Total 20.00'])(
      '%j is not the total',
      (row) => {
        const r = parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Total 10.00', row));
        expect(r.totalCents).toBe(1000);
        expect(r.items.map((i) => i.name)).toEqual(['Soup']);
      },
    );

    it('a damaged label with more words is not guessed at', () => {
      const r = parseReceipt(linesOf('Soup 10.00', 'Subtotal 10.00', 'Tota) Items 3.00', 'Total 10.00'));
      expect(r.totalCents).toBe(1000);
    });

    it('a time row with a broken amount and another label is not read as the total', () => {
      // Real capture at 1400px: "126.37" lost its dot, so only the gratuity amount is a price.
      const r = parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', '09:19py Total 126 37 Gratuity 15.60'));
      expect(r.totalCents).toBeNull();
    });
  });

  describe('two totals lines joined on one row by the row grouping', () => {
    it.each(['09:19PM Tota) 126.37 Gratuity 15.60', 'Total 126.37 Gratuity 15.60', 'Gratuity 15.60 Total 126.37'])(
      '%j gives both the total and the tip',
      (row) => {
        const r = parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', row));
        expect(r).toMatchObject({ tipCents: 1560, totalCents: 12637, needsReview: false });
      },
    );

    it('subtotal and tax on one row', () => {
      const r = parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00 Tax 6.77', 'Total 110.77'));
      expect(r).toMatchObject({ subtotalCents: 10400, taxCents: 677, totalCents: 11077, needsReview: false });
    });

    it('an item row with a unit price and a line price is not split', () => {
      const r = parseReceipt(linesOf('Soda 2 @ 2.50 5.00', 'Total 5.00'));
      expect(r.items).toHaveLength(1);
      expect(r.items[0]).toMatchObject({ name: 'Soda', qty: 2, unitCents: 250, totalCents: 500 });
    });
  });

  describe('gratuity and service charges', () => {
    it.each(['Gratuity 15.60', 'Gratuity (18%) 15.60', 'Auto Gratuity 15.60', '18% Gratuity 15.60', 'GRATUITY: $15.60'])(
      '%j is the tip',
      (row) => {
        const r = parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', row, 'Total 126.37'));
        expect(r).toMatchObject({ tipCents: 1560, feesCents: null, totalCents: 12637, needsReview: false });
        expect(r.items.map((i) => i.name)).toEqual(['Soup']);
      },
    );

    it('a service charge is a fee, as before', () => {
      const r = parseReceipt(linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', 'Service Charge 15.60', 'Total 126.37'));
      expect(r).toMatchObject({ tipCents: null, feesCents: 1560, totalCents: 12637, needsReview: false });
    });

    it('"15% GRATUITY IS INCLUDED" text without an amount is ignored', () => {
      const r = parseReceipt(
        linesOf('Soup 104.00', 'Subtotal 104.00', 'Tax 6.77', 'Gratuity 15.60', 'Total 126.37', '15% GRATUITY', 'IS INCLUDED', '15% GRATUITY IS INCLUDED'),
      );
      expect(r).toMatchObject({ tipCents: 1560, totalCents: 12637, needsReview: false });
    });
  });
});

describe('leading quantity before a digit-led name, and OCR confusion in size units', () => {
  const firstItem = (row: string): ParsedItem | undefined => parseReceipt(linesOf(row, 'Total 99.00')).items[0];

  describe('the integer before a name whose first word starts with a digit is the quantity', () => {
    it.each([
      ['1 4 Cheese Calzone 14.00', { name: '4 Cheese Calzone', qty: 1, unitCents: 1400 }],
      ['2 10 Wings 24.00', { name: '10 Wings', qty: 2, unitCents: 1200 }],
      ['3 2nd Chance Lager 18.00', { name: '2nd Chance Lager', qty: 3, unitCents: 600 }],
      ['1 2007 Vintage Port 40.00', { name: '2007 Vintage Port', qty: 1, unitCents: 4000 }],
      ['1 24/7 Breakfast Plate 11.00', { name: '24/7 Breakfast Plate', qty: 1, unitCents: 1100 }],
      ['1 7 Up 3.00', { name: '7 Up', qty: 1, unitCents: 300 }],
      ['2 1/2 Rack Ribs 30.00', { name: '1/2 Rack Ribs', qty: 2, unitCents: 1500 }],
      ['1 31415 Pi Pie 9.00', { name: '31415 Pi Pie', qty: 1, unitCents: 900 }],
      ['2 12 oz Ribeye 60.00', { name: '12 oz Ribeye', qty: 2, unitCents: 3000 }],
    ])('%j', (row, expected) => {
      expect(firstItem(row)).toMatchObject({ ...expected, modifiers: [] });
    });

    it('keeps menu numbers, R6 sizes and the "3 Cheese Pizza" limit as before', () => {
      expect(firstItem('1 6. Taco y Enchilada 21.95')).toMatchObject({ name: '6. Taco y Enchilada', qty: 1 });
      expect(firstItem('2 2) Combo 24.00')).toMatchObject({ name: '2) Combo', qty: 2, unitCents: 1200 });
      expect(firstItem('12 oz Steak 30.00')).toMatchObject({ name: '12 oz Steak', qty: 1 });
      expect(firstItem('3 Cheese Pizza 15.00')).toMatchObject({ name: 'Cheese Pizza', qty: 3 });
      expect(firstItem('7 Up 3.00')).toMatchObject({ name: 'Up', qty: 7 }); // same known limit
    });

    it('needs a word with a letter after the digit-led word', () => {
      expect(firstItem('1 12 Wings 6.00')).toMatchObject({ name: '12 Wings', qty: 1 });
      expect(parseReceipt(linesOf('1 607 26.00', 'Total 99.00')).items).toEqual([]); // no name at all
    });

    it('with an ITEM QTY PRICE header, the integer before a digit-led name is noise, qty 1', () => {
      const r = parseReceipt(linesOf('ITEM QTY PRICE', '4 10 Wings 12.00', 'Total 12.00'));
      expect(r.items[0]).toMatchObject({ name: '10 Wings', qty: 1, unitCents: 1200 });
    });
  });

  describe('a size glued to its unit at the start of the name is repaired (O-0, Z-2/7, l-1, S-5)', () => {
    it.each([
      // oz
      ['1 8OZ Sirloin 20.00', '8oz Sirloin'],
      ['1 80Z Sirloin 20.00', '8oz Sirloin'],
      ['1 8O2 Sirloin 20.00', '8oz Sirloin'],
      ['1 8o7 Sirloin 20.00', '8oz Sirloin'],
      ['1 160Z Porterhouse 40.00', '16oz Porterhouse'],
      ['1 32O7 Pitcher Lager 18.00', '32oz Pitcher Lager'],
      // lb / lbs
      ['1 21b Pulled Pork 24.00', '2lb Pulled Pork'],
      ['1 2LB Pulled Pork 24.00', '2lb Pulled Pork'],
      ['1 31bs Crawfish 30.00', '3lbs Crawfish'],
      ['1 3lb5 Crawfish 30.00', '3lbs Crawfish'],
      // ml, g, kg, in
      ['1 750m1 House Red 28.00', '750ml House Red'],
      ['1 330ML Tonic Water 4.00', '330ml Tonic Water'],
      ['1 250G Cheese Board 16.00', '250g Cheese Board'],
      ['1 1KG Brisket 45.00', '1kg Brisket'],
      ['1 12IN Pepperoni Pizza 18.00', '12in Pepperoni Pizza'],
      // all-digit oz ("oz" read as "02"/"07") after a leading qty, one size digit 2-9
      ['1 807 Sirloin 20.00', '8oz Sirloin'],
      ['2 502 Shots Tequila 20.00', '5oz Shots Tequila'],
      // a letter form is clearly a unit, so it is repaired with no quantity in front too
      ['8OZ Sirloin 20.00', '8oz Sirloin'],
      ['21b Pulled Pork 24.00', '2lb Pulled Pork'],
      // the unit as its own word with the O read as a zero
      ['12 0Z Sirloin 30.00', '12 oz Sirloin'],
    ])('%j -> %j', (row, name) => {
      expect(firstItem(row)?.name).toBe(name);
    });

    it('a repaired size before the name keeps the leading quantity', () => {
      expect(firstItem('2 160Z Porterhouse 80.00')).toMatchObject({ name: '16oz Porterhouse', qty: 2, unitCents: 4000 });
      expect(firstItem('12 0Z Sirloin 30.00')).toMatchObject({ qty: 1 });
    });

    it.each([
      // An all-digit "unit" can't be told from a real number: never with a 2-3 digit size (a year,
      // a menu code), never for size 1 ("107"), and never without a quantity in front.
      ['1 107 Wings 10.00', '107 Wings'],
      ['1 102 Dalmatians Sundae 8.00', '102 Dalmatians Sundae'],
      ['1 1207 Club Sandwich 13.00', '1207 Club Sandwich'],
      ['1 2007 Vintage Port 40.00', '2007 Vintage Port'],
      ['1 2002 Reserve Merlot 40.00', '2002 Reserve Merlot'],
      ['807 Sirloin 20.00', '807 Sirloin'],
      // A leading zero is not a size.
      ['1 007 Martini 12.00', '007 Martini'],
      // Not the first token of the name.
      ['1 Route 66 Burger 12.00', 'Route 66 Burger'],
      ['1 Steak 8OZ Side Salad 20.00', 'Steak 8OZ Side Salad'],
      ['1 Sirloin 807 Cut 20.00', 'Sirloin 807 Cut'],
      // Not followed by a word.
      ['1 8OZ 20.00', '1 8OZ'],
      ['Sirloin 8OZ 20.00', 'Sirloin 8OZ'],
      // Not a unit, or more than the unit glued on.
      ['1 24/7 Breakfast Plate 11.00', '24/7 Breakfast Plate'],
      ['1 3Ozzy Burger 12.00', '3Ozzy Burger'],
      ['1 2in1 Combo 12.00', '2in1 Combo'],
      ['1 7 Up 3.00', '7 Up'],
    ])('%j keeps %j', (row, name) => {
      expect(firstItem(row)?.name).toBe(name);
    });

    it('known over-reach: a number glued to a unit letter is read as a size even when it is not one', () => {
      expect(firstItem('1 4G LTE Hotspot 10.00')).toMatchObject({ name: '4g LTE Hotspot', qty: 1 });
    });

    it('never touches prices or totals', () => {
      expect(firstItem('1 807 Sirloin 8.07')).toMatchObject({ name: '8oz Sirloin', totalCents: 807, unitCents: 807 });
      expect(firstItem('Wings 6.07')).toMatchObject({ name: 'Wings', totalCents: 607 });
      const r = parseReceipt(linesOf('1 807 Sirloin 20.07', 'Subtotal 20.07', 'Tax 2.07', 'Total 22.14'));
      expect(r).toMatchObject({ subtotalCents: 2007, taxCents: 207, totalCents: 2214, needsReview: false });
    });
  });
});

// User conventions, 2026-11-23. All lines are invented, not copied from a real receipt.
describe('"optional service" is a tip (user rule, 2026-11-23)', () => {
  const totalsBlock = (row: string) => linesOf('Pasta 80.00', 'Subtotal 80.00', 'Tax 6.40', row, 'Total 101.40');

  it.each([
    'Optional Service 15.00',
    'Optional Service (18%) 15.00',
    'Optional Service Charge 15.00',
    'OPTIONAL SERVICE CHARGE: $15.00',
    'OPT SERVICE 15.00',
    'Opt. Service 15.00',
    'Optional Svc 15.00',
    'Optional Serv Chg 15.00',
    'Discretionary Service Charge 12.5% 15.00',
    'Voluntary Service Charge 15.00',
  ])('%j is the tip, not a fee or an item', (row) => {
    const r = parseReceipt(totalsBlock(row));
    expect(r).toMatchObject({ tipCents: 1500, feesCents: null, totalCents: 10140, needsReview: false });
    expect(r.items.map((i) => i.name)).toEqual(['Pasta']);
  });

  it.each(['Service Charge 15.00', 'Service Fee 15.00', 'SERVICE CHARGE (18%) 15.00', 'Mandatory Service Charge 15.00'])(
    '%j stays a fee',
    (row) => {
      expect(parseReceipt(totalsBlock(row))).toMatchObject({ tipCents: null, feesCents: 1500, needsReview: false });
    },
  );

  it('"Service Charge 3.60" stays a fee next to an optional-service tip', () => {
    const r = parseReceipt(
      linesOf('Pasta 80.00', 'Subtotal 80.00', 'Service Charge 3.60', 'Optional Service 12.00', 'Total 95.60'),
    );
    expect(r).toMatchObject({ feesCents: 360, tipCents: 1200, totalCents: 9560, needsReview: false });
  });

  it('a "suggested gratuity" line is still part of the skipped tip guide, not a tip', () => {
    const r = parseReceipt(linesOf('Pasta 80.00', 'Subtotal 80.00', 'Suggested Gratuity (18%) 14.40', 'Total 80.00'));
    expect(r).toMatchObject({ tipCents: null, totalCents: 8000, needsReview: false });
  });

  it('an "optional service" note with no amount is ignored', () => {
    const r = parseReceipt(linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional service not included', 'Total 80.00'));
    expect(r).toMatchObject({ tipCents: null, feesCents: null, needsReview: false });
    expect(r.items).toHaveLength(1);
  });

  it('"Service" in an item name without optional/opt is not touched', () => {
    expect(parseReceipt(linesOf('Room Service Burger 14.00', 'Total 14.00')).items[0]?.name).toBe('Room Service Burger');
  });

  describe('optional service plus a separate tip line never double-counts', () => {
    it('the same amount printed twice (bill, then card slip) is one tip', () => {
      const r = parseReceipt(
        linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional Service 15.00', 'Total 95.00', 'Tip 15.00', 'Total 95.00'),
      );
      expect(r).toMatchObject({ tipCents: 1500, totalCents: 9500, needsReview: false });
    });

    it('two different tip lines are added only when their sum is what reconciles with the total', () => {
      const r = parseReceipt(
        linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional Service 12.00', 'Total 92.00', 'Additional Tip 5.00', 'Total 97.00'),
      );
      expect(r).toMatchObject({ tipCents: 1700, totalCents: 9700, needsReview: false });
    });

    it('when only the last tip line reconciles, it is the tip (no sum)', () => {
      const r = parseReceipt(linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional Service 12.00', 'Tip 15.00', 'Total 95.00'));
      expect(r).toMatchObject({ tipCents: 1500, totalCents: 9500, needsReview: false });
    });

    it('when neither reconciles, the last tip line is kept and the totals check flags it', () => {
      const r = parseReceipt(linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional Service 12.00', 'Tip 15.00', 'Total 99.00'));
      expect(r).toMatchObject({ tipCents: 1500, needsReview: true });
      expect(r.reasons).toEqual(['subtotal_vs_total']);
    });

    it('with no total to check against, the last tip line is kept', () => {
      const r = parseReceipt(linesOf('Pasta 80.00', 'Subtotal 80.00', 'Optional Service 12.00', 'Tip 5.00'));
      expect(r.tipCents).toBe(500);
    });
  });
});

describe('unit-price notation "(2@3.50)" is qty x unit (user rule, 2026-11-23)', () => {
  const firstItem = (...rows: string[]): ParsedItem | undefined => parseReceipt(linesOf(...rows, 'Total 99.00')).items[0];
  const margarita = { name: 'Margarita', qty: 2, unitCents: 350, totalCents: 700, modifiers: [] };

  it.each([
    'Margarita (2@3.50) 7.00',
    'Margarita (2 @ 3.50) 7.00',
    'Margarita (2@$3.50) 7.00',
    'Margarita ( 2 @ $ 3.50 ) 7.00',
    'Margarita (2@3.50 ea) 7.00',
    'Margarita 2@3.50 7.00',
    'Margarita 2 @ 3.50 7.00',
    'Margarita $7.00 (2@3.50)',
  ])('one line: %j', (row) => {
    expect(firstItem(row)).toEqual(margarita);
  });

  it.each([
    [['Margarita 7.00', '(2@3.50)']],
    [['Margarita 7.00', '2 @ 3.50']],
    [['Margarita 7.00', '2 @ $3.50 ea']],
    [['(2@3.50)', 'Margarita 7.00']],
    [['2 @ 3.50', 'Margarita 7.00']],
    [['Margarita', '2 @ 3.50 7.00']],
  ])('two lines: %j', (rows) => {
    const r = parseReceipt(linesOf(...rows, 'Subtotal 7.00', 'Total 7.00'));
    expect(r.items).toEqual([margarita]);
    expect(r.needsReview).toBe(false);
  });

  it('with no line total, the total is qty x unit in integer cents', () => {
    expect(firstItem('Margarita (2@3.50)')).toEqual(margarita);
    expect(firstItem('Wings (3@0.33)')).toEqual({ name: 'Wings', qty: 3, unitCents: 33, totalCents: 99, modifiers: [] });
    expect(firstItem('Wings 12 @ 1.15')).toMatchObject({ name: 'Wings', qty: 12, unitCents: 115, totalCents: 1380 });
  });

  it('a 1 cent rounding gap is accepted; the printed line total is kept', () => {
    const r = parseReceipt(linesOf('Bagel (3@0.33) 1.00', 'Total 1.00'));
    expect(r.items[0]).toEqual({ name: 'Bagel', qty: 3, unitCents: 33, totalCents: 100, modifiers: [] });
    expect(r.reasons).not.toContain('qty_price_mismatch');
  });

  it.each([
    [['Margarita (2@3.50) 7.50']],
    [['Margarita 7.50', '(2@3.50)']],
    [['(2@3.50)', 'Margarita 7.50']],
  ])('a gap over 1 cent keeps the printed total and flags qty_price_mismatch: %j', (rows) => {
    const r = parseReceipt(linesOf(...rows, 'Total 7.50'));
    expect(r.items).toEqual([{ ...margarita, totalCents: 750, flags: ['qty_price_mismatch'] }]);
    expect(r.reasons).toContain('qty_price_mismatch');
  });

  it('a note line between two items goes to the item it reconciles with', () => {
    const above = parseReceipt(linesOf('Margarita 7.00', '(2@3.50)', 'Nachos 9.00', 'Total 16.00'));
    expect(above.items).toEqual([margarita, { name: 'Nachos', qty: 1, unitCents: 900, totalCents: 900, modifiers: [] }]);
    const below = parseReceipt(linesOf('Nachos 9.00', '(2@3.50)', 'Margarita 7.00', 'Total 16.00'));
    expect(below.items).toEqual([{ name: 'Nachos', qty: 1, unitCents: 900, totalCents: 900, modifiers: [] }, margarita]);
  });

  it('the annotation is never a menu number, a price or a leading/trailing qty', () => {
    expect(firstItem('12. Margarita (2@3.50) 7.00')).toMatchObject({ name: '12. Margarita', qty: 2, totalCents: 700 });
    expect(firstItem('2 Margarita (2@3.50) 7.00')).toEqual(margarita);
    expect(firstItem('Margarita 2 (2@3.50) 7.00')).toEqual(margarita);
    expect(firstItem('Combo 3 (2@3.50) 7.00')).toMatchObject({ name: 'Combo 3', qty: 2, unitCents: 350 });
    const r = parseReceipt(linesOf('Margarita (2@3.50) 7.00', 'Subtotal 7.00', 'Total 7.00'));
    expect(r).toMatchObject({ subtotalCents: 700, totalCents: 700, needsReview: false });
  });

  it('works under QTY column headers', () => {
    expect(parseReceipt(linesOf('ITEM QTY PRICE', 'Margarita (2@3.50) 7.00', 'Total 7.00')).items).toEqual([margarita]);
    expect(parseReceipt(linesOf('QTY ITEM PRICE', '2 Margarita (2@3.50) 7.00', 'Total 7.00')).items).toEqual([margarita]);
  });

  it('a note under a modifier still reaches its item', () => {
    const r = parseReceipt(linesOf('Margarita 7.00', '+ Salt rim', '(2@3.50)', 'Total 7.00'));
    expect(r.items).toEqual([{ ...margarita, modifiers: ['Salt rim'] }]);
  });

  it.each([
    ['Email @ checkout 5.00', { name: 'Email @ checkout', qty: 1, unitCents: 500, totalCents: 500 }],
    ['Wings (2 pcs) 8.00', { name: 'Wings (2 pcs)', qty: 1, unitCents: 800, totalCents: 800 }],
    ['Brunch @ Home 12.00', { name: 'Brunch @ Home', qty: 1, unitCents: 1200, totalCents: 1200 }],
  ])('%j is not a unit price', (row, expected) => {
    expect(firstItem(row)).toEqual({ ...expected, modifiers: [] });
  });

  it('a lone note line with no item near it is dropped, not an item', () => {
    const r = parseReceipt(linesOf('(2@3.50)', 'Subtotal 0.00', 'Total 0.00'));
    expect(r.items).toEqual([]);
  });
});

describe('unit-price notation: 1-decimal unit inside the note (user rule, 2026-11-24)', () => {
  const firstItem = (...rows: string[]): ParsedItem | undefined => parseReceipt(linesOf(...rows, 'Total 99.00')).items[0];
  const pie = { name: 'Pie', qty: 2, unitCents: 350, totalCents: 700, modifiers: [] };

  it.each(['Pie (2@3.5) 7.00', 'Pie (2@3.5)', 'Pie 2 @ $3.5 7.00', 'Pie ( 2 @ $ 3.5 ea ) 7.00'])('one line: %j', (row) => {
    expect(firstItem(row)).toEqual(pie);
  });

  it('(10 @ $1.5) is qty 10 x 150 cents', () => {
    expect(firstItem('Wings (10 @ $1.5) 15.00')).toEqual({ name: 'Wings', qty: 10, unitCents: 150, totalCents: 1500, modifiers: [] });
    expect(firstItem('Wings (10 @ $1.5)')).toEqual({ name: 'Wings', qty: 10, unitCents: 150, totalCents: 1500, modifiers: [] });
  });

  it.each([[['Margarita 7.00', '(2@3.5)']], [['(2@3.5)', 'Margarita 7.00']], [['Margarita', '2 @ 3.5 7.00']]])(
    'two lines: %j',
    (rows) => {
      const r = parseReceipt(linesOf(...rows, 'Subtotal 7.00', 'Total 7.00'));
      expect(r.items).toEqual([{ ...pie, name: 'Margarita' }]);
      expect(r.needsReview).toBe(false);
    },
  );

  it('a gap over 1 cent keeps the printed total and flags qty_price_mismatch', () => {
    const r = parseReceipt(linesOf('Pie (2@3.5) 8.00', 'Total 8.00'));
    expect(r.items).toEqual([{ ...pie, totalCents: 800, flags: ['qty_price_mismatch'] }]);
    expect(r.reasons).toContain('qty_price_mismatch');
  });

  it.each([
    // A whole-number unit stays out: "2@3" reads as well as a count, a table or a size as a price.
    ['Pie (2@3) 7.00', { name: 'Pie (2@3)', qty: 1, unitCents: 700, totalCents: 700 }],
    ['Pie 2@3 7.00', { name: 'Pie 2@3', qty: 1, unitCents: 700, totalCents: 700 }],
    ['Pie (2@3.555) 7.00', { name: 'Pie (2@3.555)', qty: 1, unitCents: 700, totalCents: 700 }],
  ])('%j is not a unit price', (row, expected) => {
    expect(firstItem(row)).toEqual({ ...expected, modifiers: [] });
  });

  it('a 1-decimal number outside a note is still never a price', () => {
    const r = parseReceipt(linesOf('Tea 3.5', 'Soup 5.00', 'Total 5.00'));
    expect(r.items).toEqual([{ name: 'Soup', qty: 1, unitCents: 500, totalCents: 500, modifiers: [] }]);
  });
});

describe('unit-price notation: guards', () => {
  it('a second note never overrides an item that already has one', () => {
    const r = parseReceipt(linesOf('Margarita (2@3.50) 7.00', '(3@1.00)', 'Total 7.00'));
    expect(r.items).toEqual([{ name: 'Margarita', qty: 2, unitCents: 350, totalCents: 700, modifiers: [] }]);
  });

  it('time, payment and header rows are skipped as before', () => {
    const r = parseReceipt(linesOf('Party of 2 @ 7.00 PM', 'Soup 5.00', 'Visa 2 @ 3.50', 'Total 5.00'));
    expect(r.items).toEqual([{ name: 'Soup', qty: 1, unitCents: 500, totalCents: 500, modifiers: [] }]);
  });

  it('a priced modifier with a note adds qty x unit to its item', () => {
    const r = parseReceipt(linesOf('Latte 4.00', '+ Extra shot (2@0.50)', 'Total 5.00'));
    expect(r.items).toEqual([{ name: 'Latte', qty: 1, unitCents: 500, totalCents: 500, modifiers: ['Extra shot'] }]);
  });
});

describe('first of two different totals is the subtotal', () => {
  const parse = (...rows: string[]) => parseReceipt(linesOf(...rows));
  const names = (r: ParsedReceipt) => r.items.map((i) => i.name);
  // parseReceipt's reasons and checkTotals on its output must agree (criterion 8).
  const reasonsOf = (r: ParsedReceipt) => {
    expect(checkTotals(r)).toEqual(r.reasons);
    return r.reasons;
  };

  it('fires with a service charge between the totals', () => {
    const r = parse('Pasta 40.00', 'Salad 10.00', 'Total 50.00', 'Service charge 10% 5.00', 'Total 55.00');
    expect(r).toMatchObject({ subtotalCents: 5000, feesCents: 500, totalCents: 5500, taxCents: null, needsReview: false });
    expect(names(r)).toEqual(['Pasta', 'Salad']);
    expect(reasonsOf(r)).toEqual([]);
  });

  it('fires with a tip between the totals', () => {
    const r = parse('Burger 20.00', 'Total 20.00', 'Tip 4.00', 'Total 24.00');
    expect(r).toMatchObject({ subtotalCents: 2000, tipCents: 400, totalCents: 2400 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('counts tax printed between the totals', () => {
    const r = parse('Burger 20.00', 'Total 20.00', 'Tax 1.60', 'Tip 3.00', 'Total 24.60');
    expect(r).toMatchObject({ subtotalCents: 2000, taxCents: 160, tipCents: 300, totalCents: 2460 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('counts a tax-sum line printed between the totals', () => {
    const r = parse('Burger 20.00', 'Total 20.00', 'Tax Total 1.60', 'Tip 3.00', 'Total 24.60');
    expect(r).toMatchObject({ subtotalCents: 2000, taxCents: 160, tipCents: 300, totalCents: 2460 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('does not fire when a subtotal is printed', () => {
    const r = parse('Burger 20.00', 'Subtotal 20.00', 'Total 20.00', 'Tax 1.60', 'Total 21.60');
    expect(r).toMatchObject({ subtotalCents: 2000, taxCents: null, totalCents: 2160 });
  });

  it('does not fire when tax comes before the first total (card slip)', () => {
    const r = parse('Burger 46.30', 'Tax 3.70', 'Total 50.00', 'Tip 10.00', 'Total 60.00');
    expect(r).toMatchObject({ subtotalCents: null, taxCents: 370, tipCents: 1000, totalCents: 6000 });
    expect(reasonsOf(r)).toEqual(['missing_subtotal']);
  });

  it('does not fire when a tax-sum line comes before the first total', () => {
    const r = parse('Burger 46.30', 'Total Tax 3.70', 'Total 50.00', 'Tip 10.00', 'Total 60.00');
    expect(r).toMatchObject({ subtotalCents: null, taxCents: 370, tipCents: 1000, totalCents: 6000 });
    expect(reasonsOf(r)).toEqual(['missing_subtotal']);
  });

  it('does not fire when the totals are equal', () => {
    const r = parse('Burger 20.00', 'Total 20.00', 'Total 20.00');
    expect(r).toMatchObject({ subtotalCents: null, totalCents: 2000 });
    expect(reasonsOf(r)).toEqual(['missing_subtotal']);

    const zeroTip = parse('Burger 20.00', 'Total 20.00', 'Tip 0.00', 'Total 20.00');
    expect(zeroTip).toMatchObject({ subtotalCents: null, totalCents: 2000 });
    expect(names(zeroTip)).toEqual(['Burger']);
  });

  it('leaves a receipt with a single total unchanged', () => {
    const r = parse('Burger 20.00', 'Service charge 2.00', 'Total 22.00');
    expect(r).toMatchObject({ subtotalCents: null, feesCents: 200, totalCents: 2200 });
    expect(reasonsOf(r)).toEqual(['missing_subtotal']);
  });

  it('does not fire with three different total amounts (A1, Q1)', () => {
    const r = parse('Burger 50.00', 'Total 50.00', 'Service fee 2.00', 'Total 52.00', 'Tip 3.00', 'Total 55.00');
    expect(r).toMatchObject({ subtotalCents: null, totalCents: 5500, tipCents: 300 });
    expect(reasonsOf(r)).toContain('missing_subtotal');
  });

  it('fires when one of two amounts repeats', () => {
    const r = parse('Burger 50.00', 'Total 50.00', 'Service charge 5.00', 'Total 55.00', 'Total 55.00');
    expect(r).toMatchObject({ subtotalCents: 5000, feesCents: 500, totalCents: 5500 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('counts a discount between the totals on the total (A1, Q2)', () => {
    const r = parse('Burger 50.00', 'Total 50.00', 'Coupon -5.00', 'Total 45.00');
    expect(r).toMatchObject({ subtotalCents: 5000, totalCents: 4500 });
    expect(r.discounts).toEqual([{ label: 'Coupon', cents: 500, appliesTo: 'total' }]);
    expect(reasonsOf(r)).toEqual([]);
  });

  it('still ignores a discount after the total when the rule does not fire', () => {
    const r = parse('Burger 50.00', 'Subtotal 50.00', 'Total 50.00', 'Coupon -5.00', 'Total 45.00');
    expect(r.discounts).toEqual([]);
  });

  it('does not add included VAT printed between the totals (A1)', () => {
    const r = parse('Burger 54.00', 'Total 54.00', 'VAT included 4.00', 'Tip 10.00', 'Total 64.00');
    expect(r).toMatchObject({ subtotalCents: 5400, taxCents: null, tipCents: 1000, totalCents: 6400 });
    expect(reasonsOf(r)).toEqual([]);

    const incl = parse('Burger 54.00', 'Total 54.00', 'incl. tax 4.00', 'Tip 10.00', 'Total 64.00');
    expect(incl).toMatchObject({ subtotalCents: 5400, taxCents: null, tipCents: 1000, totalCents: 6400 });
  });

  it('still reads "Total incl. tax" as a total', () => {
    const r = parse('Burger 54.00', 'Total incl. tax 54.00', 'Tip 10.00', 'Total 64.00');
    expect(r).toMatchObject({ subtotalCents: 5400, taxCents: null, tipCents: 1000, totalCents: 6400 });
  });

  it('does not fire when the first total is larger and nothing comes off between them (A4)', () => {
    const r = parse('Burger 50.00', 'Total 55.00', 'Total 50.00');
    expect(r).toMatchObject({ subtotalCents: null, totalCents: 5000, discounts: [] });
    expect(reasonsOf(r)).toEqual(['missing_subtotal']);
  });

  it('chooses the same tip as without the rule when there are two tip lines (A4)', () => {
    const r = parse('Burger 20.00', 'Total 20.00', 'Gratuity 4.00', 'Tip 4.00', 'Total 24.00');
    expect(r).toMatchObject({ subtotalCents: 2000, tipCents: 400, totalCents: 2400 });
    expect(reasonsOf(r)).toEqual([]);
    // Without the rule the tax is ignored and the two tips summed reconcile; with it nothing
    // reconciles, so the receipt is read as without the rule (A6 R2), tip included.
    const summed = parse('Burger 20.00', 'Total 20.00', 'Tax 2.00', 'Tip 4.00', 'Tip 2.00', 'Total 26.00');
    expect(summed).toMatchObject({ subtotalCents: null, taxCents: null, tipCents: 600, totalCents: 2600 });
  });

  describe('falls back to the reading without the rule (A6)', () => {
    // Each expected value is what the parser printed before this rule existed.
    it.each([
      ['a service charge before the first Total', ['Burger 20.00', 'Service charge 2.00', 'Total 22.00', 'Tip 4.00', 'Total 26.00'], { feesCents: 200, tipCents: 400, totalCents: 2600 }],
      ['a gratuity before the first Total', ['Burger 20.00', 'Gratuity 3.60', 'Total 23.60', 'Tip 2.00', 'Total 25.60'], { tipCents: 560, totalCents: 2560 }],
      ['VAT after a VAT-inclusive Total', ['Fish 54.00', 'Total 54.00', 'VAT 20% 9.00', 'Gratuity 5.00', 'Total 59.00'], { tipCents: 500, totalCents: 5900 }],
      ['a Net / VAT breakdown after the Total', ['Fish 54.00', 'Total 54.00', 'Net 45.00', 'VAT 9.00', 'Tip 10.00', 'Total 64.00'], { tipCents: 1000, totalCents: 6400 }],
      ['tax already inside the first Total', ['Pasta 21.60', 'Total 21.60', 'Tax 1.60', 'Tip 3.00', 'Total 24.60'], { tipCents: 300, totalCents: 2460 }],
      ['tax between repeated last Totals', ['Fish 50.00', 'Total 50.00', 'Tip 5.00', 'Total 55.00', 'Tax 2.00', 'Total 55.00'], { tipCents: 500, totalCents: 5500 }],
      ['a savings line between the Totals', ['Pasta 50.00', 'Total 50.00', 'Savings 5.00', 'Tip 10.00', 'Total 60.00'], { tipCents: 1000, totalCents: 6000 }],
    ])('%s', (_name, rows, expected) => {
      const r = parse(...rows);
      expect(r).toMatchObject({ subtotalCents: null, taxCents: null, discounts: [], ...expected });
      expect(reasonsOf(r)).toEqual(['missing_subtotal']);
    });
  });

  describe('falls back when the added tax or discounts do not fit (A7)', () => {
    it.each([
      ['VAT after a VAT-inclusive Total', ['Fish 54.00', 'Total 59.00', 'VAT 20% 9.83', 'Gratuity 5.00', 'Total 64.00'], { tipCents: 500, totalCents: 6400 }, ['missing_subtotal', 'subtotal_vs_total']],
      ['tax already inside the first Total', ['Pasta 20.00', 'Total 21.60', 'Tax 1.60', 'Tip 3.00', 'Total 24.60'], { tipCents: 300, totalCents: 2460 }, ['missing_subtotal', 'subtotal_vs_total']],
      ['a savings line already taken off', ['Pasta 45.00', 'Total 50.00', 'Savings 5.00', 'Tip 10.00', 'Total 60.00'], { tipCents: 1000, totalCents: 6000 }, ['missing_subtotal', 'subtotal_vs_total']],
    ])('%s', (_name, rows, expected, reasons) => {
      const r = parse(...rows);
      expect(r).toMatchObject({ subtotalCents: null, taxCents: null, discounts: [], ...expected });
      expect(reasonsOf(r)).toEqual(reasons);
    });

    it('keeps the rule when the added tax fits and only the items are off', () => {
      const r = parse('Burger 18.00', 'Total 20.00', 'Tax 1.60', 'Tip 3.00', 'Total 24.60');
      expect(r).toMatchObject({ subtotalCents: 2000, taxCents: 160, tipCents: 300, totalCents: 2460 });
      expect(reasonsOf(r)).toEqual(['items_vs_subtotal']);
    });
  });

  it('does not add an included tax-sum line between the Totals (A6)', () => {
    const r = parse('Fish 54.00', 'Total 54.00', 'Tax total (incl.) 4.00', 'Tip 10.00', 'Total 64.00');
    expect(r).toMatchObject({ subtotalCents: 5400, taxCents: null, tipCents: 1000, totalCents: 6400 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('fires with an OCR-damaged, timed first Total', () => {
    const r = parse('Pasta 50.00', '09:19PM Tota) 50.00', 'Tip 10.00', 'Total 60.00');
    expect(r).toMatchObject({ subtotalCents: 5000, tipCents: 1000, totalCents: 6000 });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('ignores tax and discounts after the last Total while the rule fires', () => {
    const r = parse('Pasta 50.00', 'Total 50.00', 'Tip 10.00', 'Total 60.00', 'Tax 4.00', 'Coupon -2.00');
    expect(r).toMatchObject({ subtotalCents: 5000, taxCents: null, tipCents: 1000, totalCents: 6000, discounts: [] });
    expect(reasonsOf(r)).toEqual([]);
  });

  it('does not fire when included tax comes before the first Total', () => {
    const r = parse('Fish 54.00', 'VAT included 4.00', 'Total 54.00', 'Tip 10.00', 'Total 64.00');
    expect(r).toMatchObject({ subtotalCents: null, taxCents: 400, tipCents: 1000, totalCents: 6400 });
  });

  describe('totals check at its boundaries', () => {
    const run = (pasta: string, last: string) =>
      reasonsOf(parse(`Pasta ${pasta}`, 'Salad 10.00', 'Total 50.00', 'Service charge 10% 5.00', `Total ${last}`));

    it('as printed', () => expect(run('40.00', '55.00')).toEqual([]));
    it('last total 1 cent over', () => expect(run('40.00', '55.01')).toEqual([]));
    it('last total 2 cents over', () => expect(run('40.00', '55.02')).toEqual(['subtotal_vs_total']));
    it('items 2 cents short', () => expect(run('39.98', '55.00')).toEqual(['items_vs_subtotal']));
    it('both off by 1 cent', () => expect(run('39.99', '55.01')).toEqual([]));
  });
});
