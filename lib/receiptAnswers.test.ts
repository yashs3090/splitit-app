// Tests for the plain-text receipt answer files (receipts/answers/<photo>.txt) and the set record.
// Every input is synthetic and hand-made: no real receipt text.
import {
  answerBaseName,
  answerFromExpected,
  answerFromParse,
  answerToExpected,
  answerTotalsCheck,
  formatAnswer,
  parseAnswer,
  resolveSet,
  validateSetsFile,
  type Answer,
} from './receiptAnswers';
import { assignSet, validateExpected, type ExpectedReceipt } from './receiptEval';
import { checkTotals } from './receiptText';
import type { ParsedReceipt } from './receiptTypes';

const FILE = 'receipts/answers/taco-stand.txt';

const GOOD = `# answer for: taco-stand.jpeg
1  Dos Tacos (Brunch)                18.00
1  6. Taco y Enchilada (Super Combo) 21.95
5  Cape Town Margarita               $90.00

subtotal  129.95
tax       5.01
tip       -
fees      3.60
total     138.56
checked: yes
`;

function ok(text: string, file = FILE): Answer {
  const r = parseAnswer(text, file);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value;
}

function errorsOf(text: string, file = FILE): string[] {
  const r = parseAnswer(text, file);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}

function blank(): Answer {
  return { checked: false, items: [], subtotalCents: null, taxCents: null, tipCents: null, feesCents: null, discounts: [], totalCents: null };
}

describe('parseAnswer', () => {
  it('reads items, totals and checked, in integer cents', () => {
    expect(ok(GOOD)).toEqual({
      checked: true,
      items: [
        { name: 'Dos Tacos (Brunch)', qty: 1, totalCents: 1800 },
        { name: '6. Taco y Enchilada (Super Combo)', qty: 1, totalCents: 2195 },
        { name: 'Cape Town Margarita', qty: 5, totalCents: 9000 },
      ],
      subtotalCents: 12995,
      taxCents: 501,
      tipCents: null,
      feesCents: 360,
      discounts: [],
      totalCents: 13856,
    });
  });

  it('converts amounts that floats get wrong exactly (0.29, 1.15, 4.35, 1,234.57)', () => {
    const a = ok('1 A 0.29\n1 B 1.15\n1 C 4.35\n1 D 1,234.57\ntotal 1,240.36\n');
    expect(a.items.map((i) => i.totalCents)).toEqual([29, 115, 435, 123457]);
    expect(a.totalCents).toBe(124036);
  });

  it('treats a missing checked line as a draft, and "checked: no" as a draft', () => {
    expect(ok('1 Soup 6.50\n').checked).toBe(false);
    expect(ok('1 Soup 6.50\nchecked: no\n').checked).toBe(false);
    expect(ok('1 Soup 6.50\nChecked: YES\n').checked).toBe(true);
    expect(ok('1 Soup 6.50\nchecked yes\n').checked).toBe(true);
  });

  it('reads a dash, a blank value or a missing line as "not printed" (null)', () => {
    const a = ok('1 Soup 6.50\ntip -\ntax\n');
    expect(a.tipCents).toBeNull();
    expect(a.taxCents).toBeNull();
    expect(a.subtotalCents).toBeNull();
  });

  it('accepts 0.00 as a printed zero, distinct from not printed', () => {
    expect(ok('1 Water 0.00\ntip 0.00\n')).toMatchObject({ tipCents: 0, items: [{ name: 'Water', qty: 1, totalCents: 0 }] });
  });

  it('accepts an optional colon after a keyword and any case', () => {
    expect(ok('1 Soup 6.50\nSubtotal: 6.50\nTOTAL: $6.50\n')).toMatchObject({ subtotalCents: 650, totalCents: 650 });
  });

  it('accepts "$ 12.50" with a space and tabs between columns', () => {
    expect(ok('2\tFish Tacos\t$ 25.00\n').items).toEqual([{ name: 'Fish Tacos', qty: 2, totalCents: 2500 }]);
  });

  it('keeps a number followed by "." or ")" as part of the name', () => {
    expect(ok('1  2) Tacos  9.00\n1  1. Soup  4.00\n').items.map((i) => i.name)).toEqual(['2) Tacos', '1. Soup']);
  });

  it('keeps a price-looking token inside the name, only the last token is the price', () => {
    expect(ok('1  Tacos 2.00 each  4.00\n').items).toEqual([{ name: 'Tacos 2.00 each', qty: 1, totalCents: 400 }]);
  });

  it('ignores comment lines and blank lines, including indented comments', () => {
    expect(ok('# hi\n   # indented\n\n1 Soup 6.50\n').items).toHaveLength(1);
  });

  it('sums repeated tax and fees lines', () => {
    expect(ok('1 Soup 6.50\ntax 0.50\ntax 0.25\nfees 1.00\nfees 2.00\n')).toMatchObject({ taxCents: 75, feesCents: 300 });
  });

  it('reads discounts: on the total by default, "before subtotal" for item discounts, optional label', () => {
    const a = ok('1 Soup 6.50\ndiscount 2.00\ndiscount before subtotal Happy hour 1.50\ndiscount Coupon -0.50\n');
    expect(a.discounts).toEqual([
      { label: 'Discount', cents: 200, appliesTo: 'total' },
      { label: 'Happy hour', cents: 150, appliesTo: 'subtotal' },
      { label: 'Coupon', cents: 50, appliesTo: 'total' },
    ]);
  });

  it('handles Windows line endings', () => {
    expect(ok('1 Soup 6.50\r\nchecked: yes\r\n')).toMatchObject({ checked: true, items: [{ name: 'Soup' }] });
  });

  it.each([
    ['a 1-decimal price', '1 Soup 6.5', 'line 1: price must look like 12.50 (two decimals); got "6.5"'],
    ['a 3-decimal price', '1 Soup 6.505', 'line 1: price must look like 12.50 (two decimals); got "6.505"'],
    ['no price at the end', '1 Soup', 'line 1: an item line ends with its price, like 12.50'],
    ['a name missing', '1 6.50', 'line 1: the item needs a name between the quantity and the price'],
    ['qty 0', '0 Soup 6.50', 'line 1: quantity must be a whole number 1 or more'],
    ['qty like 2x', '2x Soup 6.50', 'line 1: quantity must be a whole number on its own, like 2'],
    ['a fractional qty', '1.5 Soup 6.50', 'line 1: quantity must be a whole number on its own, like 2'],
    ['a negative item price', '1 Coupon -2.00', 'line 1: an item price can\'t be negative'],
    ['a bad total', 'total 57.1', 'line 1: total must be an amount like 12.50, or - if the receipt doesn\'t print it; got "57.1"'],
    ['text after a total', 'tip - not printed', 'line 1: tip must be an amount like 12.50'],
    ['a negative tax', 'tax -1.00', 'line 1: tax can\'t be negative'],
    ['a discount with no amount', 'discount Coupon', 'line 1: a discount line ends with its amount'],
    ['an unknown word', 'Soup 6.50', 'line 1: "Soup" isn\'t understood'],
    ['a bad checked value', 'checked: maybe', 'line 1: checked must be yes or no'],
  ])('rejects %s with a friendly message naming file and line', (_label, text, message) => {
    const errors = errorsOf(text);
    expect(errors.some((e) => e.startsWith(`${FILE} line 1:`) && e.includes(message.replace(/^line 1: /, '')))).toBe(true);
  });

  it('counts lines from 1 including comments, and reports every bad line', () => {
    const errors = errorsOf('# c\n1 Soup 6.5\n\n1 Tea x\n');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain(`${FILE} line 2:`);
    expect(errors[1]).toContain(`${FILE} line 4:`);
  });

  it('rejects a repeated subtotal, total, tip or checked line', () => {
    expect(errorsOf('1 Soup 6.50\ntotal 6.50\ntotal 6.50\n')[0]).toContain('line 3: total is written twice (first on line 2)');
    expect(errorsOf('checked: no\nchecked: yes\n')[0]).toContain('line 2: checked is written twice');
  });

  it('rejects a checked answer with no items', () => {
    expect(errorsOf('total 6.50\nchecked: yes\n')[0]).toContain(`${FILE}: checked: yes but there are no item lines`);
  });

  it('rejects amounts too large to be exact', () => {
    expect(errorsOf('1 Soup 1234567890123.00\n')[0]).toContain('line 1: price must look like 12.50');
  });
});

describe('formatAnswer', () => {
  it('round-trips through parseAnswer', () => {
    const a: Answer = {
      checked: false,
      items: [
        { name: 'Dos Tacos (Brunch)', qty: 1, totalCents: 1800 },
        { name: 'Cape Town Margarita', qty: 12, totalCents: 123456 },
        { name: 'Water', qty: 1, totalCents: 0 },
      ],
      subtotalCents: 125256,
      taxCents: 5,
      tipCents: null,
      feesCents: 0,
      discounts: [
        { label: 'Discount', cents: 200, appliesTo: 'total' },
        { label: 'Happy hour', cents: 150, appliesTo: 'subtotal' },
      ],
      totalCents: 125111,
    };
    const text = formatAnswer(a, { header: ['# hello'] });
    expect(ok(text)).toEqual(a);
    expect(ok(formatAnswer({ ...a, checked: true }, { header: [] })).checked).toBe(true);
  });

  it('writes money with two decimals, dashes for not printed and the checked line last', () => {
    const text = formatAnswer({ ...blank(), items: [{ name: 'Soup', qty: 1, totalCents: 650 }], taxCents: 5 }, { header: ['# h'] });
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('# h');
    expect(text).toMatch(/^1 {2}Soup {2}6\.50$/m);
    expect(text).toMatch(/^tax +0\.05$/m);
    expect(text).toMatch(/^tip +-$/m);
    expect(lines[lines.length - 1]).toBe('checked: no');
  });

  it('collapses whitespace in names so the file still parses', () => {
    const text = formatAnswer({ ...blank(), items: [{ name: ' Fish \n  Tacos\t', qty: 1, totalCents: 100 }] }, { header: [] });
    expect(ok(text).items[0]?.name).toBe('Fish Tacos');
  });
});

describe('answerFromParse', () => {
  function parsed(r: Partial<ParsedReceipt>): ParsedReceipt {
    return {
      items: [],
      subtotalCents: null,
      taxCents: null,
      tipCents: null,
      feesCents: null,
      discounts: [],
      totalCents: null,
      needsReview: false,
      reasons: [],
      ...r,
    };
  }

  it('copies items and totals as a draft', () => {
    const r = answerFromParse(
      parsed({ items: [{ name: 'Soup', qty: 2, unitCents: 325, totalCents: 650, modifiers: ['hot'] }], subtotalCents: 650, totalCents: 700, taxCents: 50 }),
    );
    expect(r.answer).toEqual({ ...blank(), items: [{ name: 'Soup', qty: 2, totalCents: 650 }], subtotalCents: 650, taxCents: 50, totalCents: 700 });
    expect(r.notes).toEqual([]);
  });

  it('moves lines a text file can\'t hold (negative price, empty name, bad qty) into notes', () => {
    const r = answerFromParse(
      parsed({
        items: [
          { name: 'Coupon', qty: 1, unitCents: null, totalCents: -200, modifiers: [] },
          { name: '  ', qty: 1, unitCents: null, totalCents: 300, modifiers: [] },
          { name: 'Tea', qty: 1, unitCents: null, totalCents: 250, modifiers: [] },
        ],
        subtotalCents: -5,
      }),
    );
    expect(r.answer.items).toEqual([
      { name: '(no name)', qty: 1, totalCents: 300 },
      { name: 'Tea', qty: 1, totalCents: 250 },
    ]);
    expect(r.answer.subtotalCents).toBeNull();
    expect(r.notes.join('\n')).toContain('Coupon -2.00');
    expect(r.notes.join('\n')).toContain('subtotal -0.05');
    expect(ok(formatAnswer(r.answer, { header: r.notes.map((n) => `# ${n}`) }))).toEqual(r.answer);
  });

  it('gives an empty draft for no parse', () => {
    expect(answerFromParse(null)).toEqual({ answer: blank(), notes: [] });
  });
});

describe('answerFromExpected / answerToExpected', () => {
  const expected: ExpectedReceipt = {
    version: 1,
    status: 'checked',
    set: 'heldout',
    setReason: 'hash',
    photo: 'receipts/x.jpeg',
    items: [{ name: 'Soup', qty: 1, totalCents: 650 }],
    subtotalCents: 650,
    taxCents: null,
    tipCents: 100,
    feesCents: null,
    discounts: [{ label: 'Coupon', cents: 50, appliesTo: 'subtotal' }],
    totalCents: 700,
  };

  it('migrates an expected.json faithfully, keeping checked', () => {
    const a = answerFromExpected(expected);
    expect(a.checked).toBe(true);
    expect(answerFromExpected({ ...expected, status: 'draft' }).checked).toBe(false);
    expect(answerToExpected(a, { set: 'heldout', setReason: 'hash', photo: 'receipts/x.jpeg' })).toEqual(expected);
    // The migrated text parses back to the same answer.
    expect(ok(formatAnswer(a, { header: [] }))).toEqual(a);
  });

  it('builds an expected receipt that passes validateExpected', () => {
    const e = answerToExpected(ok(GOOD), { set: 'tuning', setReason: 'used-before-split', photo: 'receipts/taco-stand.jpeg' });
    expect(validateExpected(e, 'x').ok).toBe(true);
    expect(e.status).toBe('checked');
  });
});

describe('answerTotalsCheck', () => {
  it('says it adds up when items = subtotal and subtotal + extras - discounts = total', () => {
    expect(answerTotalsCheck(ok(GOOD))).toEqual({ addsUp: true, problems: [] });
  });

  it('names each gap in dollars', () => {
    const r = answerTotalsCheck(ok('1 Soup 6.50\nsubtotal 7.00\ntax 0.50\ntotal 8.00\n'));
    expect(r.addsUp).toBe(false);
    expect(r.problems).toEqual(['items add up to 6.50 but subtotal is 7.00', 'subtotal + tax + tip + fees - discounts = 7.50 but total is 8.00']);
  });

  it('applies discounts the same way as the parser\'s totals check', () => {
    const r = answerTotalsCheck(ok('1 Soup 10.00\ndiscount before subtotal 1.00\nsubtotal 9.00\ndiscount 2.00\ntax 1.00\ntotal 8.00\n'));
    expect(r).toEqual({ addsUp: true, problems: [] });
  });

  it('checks items against the total when there is no subtotal', () => {
    expect(answerTotalsCheck(ok('1 Soup 6.50\ntax 0.50\ntotal 7.00\n')).addsUp).toBe(true);
    expect(answerTotalsCheck(ok('1 Soup 6.50\ntotal 7.00\n')).problems).toEqual(['items + tax + tip + fees - discounts = 6.50 but total is 7.00']);
  });

  it('can\'t say it adds up when there is nothing to check', () => {
    expect(answerTotalsCheck(ok('1 Soup 6.50\n'))).toEqual({ addsUp: false, problems: ['no subtotal or total written, so nothing to check'] });
  });

  // Review R3: one money rule, one tolerance (CLAUDE.md). The parser's ±1¢ per check, same boundaries.
  describe('uses the parser\'s totals rule and tolerance (±1¢ per check)', () => {
    const cases: [string, string, boolean][] = [
      ['items vs subtotal off by 1¢', '1 Soup 6.49\nsubtotal 6.50\ntax 0.50\ntotal 7.00\n', true],
      ['items vs subtotal off by 2¢', '1 Soup 6.48\nsubtotal 6.50\ntax 0.50\ntotal 7.00\n', false],
      ['subtotal vs total off by 1¢', '1 Soup 6.50\nsubtotal 6.50\ntax 0.50\ntotal 7.01\n', true],
      ['subtotal vs total off by 2¢', '1 Soup 6.50\nsubtotal 6.50\ntax 0.50\ntotal 7.02\n', false],
      ['off by 1¢ on each of the two checks', '1 Soup 6.49\nsubtotal 6.50\ntax 0.50\ntotal 7.01\n', true],
      ['no subtotal, items + extras vs total off by 1¢', '1 Soup 6.50\ntax 0.50\ntotal 6.99\n', true],
      ['no subtotal, items + extras vs total off by 2¢', '1 Soup 6.50\ntax 0.50\ntotal 6.98\n', false],
    ];
    it.each(cases)('%s → adds up: %p', (_label, text, addsUp) => {
      expect(answerTotalsCheck(ok(text)).addsUp).toBe(addsUp);
    });

    it('agrees with checkTotals on every boundary case', () => {
      for (const [, text] of cases) {
        const a = ok(text);
        const parsed: ParsedReceipt = {
          items: a.items.map((i) => ({ name: i.name, qty: i.qty, unitCents: null, totalCents: i.totalCents, modifiers: [] })),
          subtotalCents: a.subtotalCents,
          taxCents: a.taxCents,
          tipCents: a.tipCents,
          feesCents: a.feesCents,
          discounts: a.discounts,
          totalCents: a.totalCents,
          needsReview: false,
          reasons: [],
        };
        const gapReasons = checkTotals(parsed).filter((r) => r === 'items_vs_subtotal' || r === 'subtotal_vs_total');
        expect(answerTotalsCheck(a).addsUp).toBe(gapReasons.length === 0);
      }
    });

    it('a 2¢ gap still names the amounts in dollars', () => {
      expect(answerTotalsCheck(ok('1 Soup 6.48\nsubtotal 6.50\ntax 0.50\ntotal 7.00\n')).problems).toEqual([
        'items add up to 6.48 but subtotal is 6.50',
      ]);
    });
  });
});

describe('answerBaseName', () => {
  it('drops only the last extension, keeping the photo\'s own spelling', () => {
    expect(answerBaseName('sample_line_price.jpeg')).toBe('sample_line_price');
    expect(answerBaseName('My Receipt.v2.JPG')).toBe('My Receipt.v2');
    expect(answerBaseName('receipts/x.png')).toBe('x');
  });
});

describe('validateSetsFile / resolveSet', () => {
  it('accepts a valid sets file and rejects bad entries naming the file and key', () => {
    expect(validateSetsFile({ version: 1, sets: { a: { set: 'tuning', setReason: 'hash' } } }, 's.json').ok).toBe(true);
    const bad = validateSetsFile({ version: 1, sets: { a: { set: 'test', setReason: 'hash' } } }, 's.json');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain('s.json: sets.a.set');
    expect(validateSetsFile([], 's.json').ok).toBe(false);
  });

  it('prefers the recorded set, then a legacy expected.json set, then forced tuning, then the hash', () => {
    const rec = { set: 'heldout' as const, setReason: 'hash' as const };
    const legacy = { set: 'tuning' as const, setReason: 'used-before-split' as const };
    expect(resolveSet('noodle-bar', { recorded: rec, legacy, forceTuning: true })).toEqual(rec);
    expect(resolveSet('noodle-bar', { legacy, forceTuning: false })).toEqual(legacy);
    expect(resolveSet('noodle-bar', { forceTuning: true })).toEqual({ set: 'tuning', setReason: 'used-before-split' });
    expect(resolveSet('noodle-bar', { forceTuning: false })).toEqual({ set: assignSet('noodle-bar'), setReason: 'hash' });
    expect(resolveSet('noodle-bar', { forceTuning: false }).set).toBe('heldout');
  });
});
