// Tests for the receipt eval core (spec docs/specs/2026-11-22-web-opencv-preprocessing.md, C1 /
// Task 1). Every input here is synthetic and hand-made (criterion 70): no receipt OCR output and
// nothing copied from lib/fixtures/receipts.ts.
import {
  assignSet,
  decide,
  decideCore,
  formatEvalReport,
  matchItems,
  MIN_HELDOUT_RECEIPTS,
  MIN_TUNING_RECEIPTS,
  NAME_MATCH_THRESHOLD,
  nameSimilarity,
  normalizeName,
  photoNames,
  scoreReceipt,
  sha256Hex,
  simulateFlow,
  slugifyPhotoName,
  summarizeSet,
  validateExpected,
  validateOcrFile,
  type ExpectedItem,
  type ExpectedReceipt,
  type ReceiptScore,
} from './receiptEval';
import type { ParsedItem, ParsedReceipt, RecognizedText } from './receiptTypes';

// ---------- helpers ----------

function parsedItem(name: string, totalCents: number, qty = 1): ParsedItem {
  return { name, qty, unitCents: null, totalCents, modifiers: [] };
}

function parsed(r: Partial<ParsedReceipt> & Pick<ParsedReceipt, 'items'>): ParsedReceipt {
  return {
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

function expectedReceipt(r: Partial<ExpectedReceipt> & Pick<ExpectedReceipt, 'items'>): ExpectedReceipt {
  return {
    version: 1,
    status: 'checked',
    set: 'tuning',
    setReason: 'hash',
    photo: 'receipts/sample.jpg',
    subtotalCents: null,
    taxCents: null,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: null,
    ...r,
  };
}

const ei = (name: string, totalCents: number, qty = 1): ExpectedItem => ({ name, qty, totalCents });

/** A valid expected.json body, for the validation tests to break one field at a time. */
function validJson(): Record<string, unknown> {
  return {
    version: 1,
    status: 'checked',
    set: 'tuning',
    setReason: 'hash',
    photo: 'receipts/sample.jpg',
    items: [
      { name: 'Soup', qty: 1, totalCents: 650 },
      { name: 'Bread', qty: 2, totalCents: 400 },
    ],
    subtotalCents: 1050,
    taxCents: 84,
    tipCents: null,
    feesCents: null,
    discounts: [{ label: 'Promo', cents: 100, appliesTo: 'total' }],
    totalCents: 1034,
  };
}

/** A per-receipt score with only the numbers decide() reads. */
function rs(name: string, set: 'tuning' | 'heldout', matched: number, opts: Partial<ReceiptScore> = {}): ReceiptScore {
  return {
    name,
    set,
    expected: 10,
    matched,
    exact: matched,
    extra: 0,
    reconciled: true,
    totalCorrect: true,
    missed: [],
    extraItems: [],
    ...opts,
  };
}

/** n tuning + m held-out receipts, each with 10 expected and `matched` matched. */
function scoreSet(n: number, m: number, matched = 5): ReceiptScore[] {
  return [
    ...Array.from({ length: n }, (_, i) => rs(`t${i}`, 'tuning', matched)),
    ...Array.from({ length: m }, (_, i) => rs(`h${i}`, 'heldout', matched)),
  ];
}

/** Copy of `scores` with `f` applied to the receipt called `name`. */
function edit(scores: ReceiptScore[], name: string, f: (s: ReceiptScore) => Partial<ReceiptScore>): ReceiptScore[] {
  return scores.map((s) => (s.name === name ? { ...s, ...f(s) } : s));
}

// ---------- names ----------

describe('normalizeName / nameSimilarity', () => {
  it('lowercases, strips diacritics and keeps only letters and digits', () => {
    expect(normalizeName('  Crème Brûlée (2x)! ')).toBe('cremebrulee2x');
    expect(normalizeName('JALAPEÑO-Poppers')).toBe('jalapenopoppers');
  });

  it('is 1 for names equal after normalising, and 1 - distance / longer length otherwise', () => {
    expect(nameSimilarity('Iced Tea', 'ICED-TEA')).toBe(1);
    // "burger" vs "burgr": one deletion over 6 characters.
    expect(nameSimilarity('Burger', 'Burgr')).toBeCloseTo(1 - 1 / 6, 10);
  });

  it('is 0 when either name has no letters or digits, so junk never matches by name', () => {
    expect(nameSimilarity('***', '***')).toBe(0);
    expect(nameSimilarity('', 'Soup')).toBe(0);
  });

  it('uses a 0.6 threshold', () => {
    expect(NAME_MATCH_THRESHOLD).toBe(0.6);
  });
});

// ---------- matching ----------

describe('matchItems', () => {
  it('matches an exact item and reports it as exact', () => {
    const r = matchItems([ei('Garden Salad', 950)], [parsedItem('Garden Salad', 950)]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.exact).toBe(true);
    expect(r.missed).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('matches an OCR-typo name at or above 0.6, but not a different item at the same price', () => {
    // "grilledcheese" vs "gri11edcheese": 2 substitutions over 13 => 0.846.
    expect(matchItems([ei('Grilled Cheese', 800)], [parsedItem('Gri11ed Cheese', 800)]).matches).toHaveLength(1);
    // "lemonade" vs "coffee": far below 0.6.
    const r = matchItems([ei('Lemonade', 400)], [parsedItem('Coffee', 400)]);
    expect(r.matches).toHaveLength(0);
    expect(r.missed).toHaveLength(1);
    expect(r.extra).toHaveLength(1);
  });

  it('matches exactly at the threshold and not just below it', () => {
    // "abcde" vs "abxyz": 3 edits over 5 => 0.4 (no); "abcde" vs "abcyz": 2 over 5 => 0.6 (yes).
    expect(matchItems([ei('abcde', 100)], [parsedItem('abcyz', 100)]).matches).toHaveLength(1);
    expect(matchItems([ei('abcde', 100)], [parsedItem('abxyz', 100)]).matches).toHaveLength(0);
  });

  it('never matches a price that is 1 cent different', () => {
    const r = matchItems([ei('Pancakes', 1099)], [parsedItem('Pancakes', 1100)]);
    expect(r.matches).toHaveLength(0);
  });

  it('matches duplicate items one to one', () => {
    const r = matchItems(
      [ei('Coke', 300), ei('Coke', 300), ei('Coke', 300)],
      [parsedItem('Coke', 300), parsedItem('Coke', 300)],
    );
    expect(r.matches).toHaveLength(2);
    expect(r.missed).toHaveLength(1);
    expect(r.extra).toHaveLength(0);
  });

  it('counts junk lines as extra', () => {
    const r = matchItems([ei('Tacos', 1200)], [parsedItem('Tacos', 1200), parsedItem('Thank you come again', 1200)]);
    expect(r.matches).toHaveLength(1);
    expect(r.extra.map((p) => p.name)).toEqual(['Thank you come again']);
  });

  it('pairs best similarity first, so a near-miss does not steal the true match', () => {
    const r = matchItems([ei('Chicken Wrap', 900), ei('Chicken Wings', 900)], [parsedItem('Chicken Wings', 900), parsedItem('Chicken Wrap', 900)]);
    expect(r.matches.map((m) => [m.expected.name, m.parsed.name])).toEqual(
      expect.arrayContaining([
        ['Chicken Wrap', 'Chicken Wrap'],
        ['Chicken Wings', 'Chicken Wings'],
      ]),
    );
  });

  it('counts a match with a different qty as matched but not exact', () => {
    const r = matchItems([ei('Wings', 1800, 2)], [parsedItem('Wings', 1800, 1)]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.exact).toBe(false);
  });
});

// ---------- scoring one receipt ----------

describe('scoreReceipt', () => {
  const items = [ei('Soup', 500), ei('Salad', 700)];

  it('counts matched, exact, extra and totalCorrect', () => {
    const s = scoreReceipt(
      'r1',
      expectedReceipt({ items, subtotalCents: 1200, totalCents: 1300, taxCents: 100 }),
      parsed({ items: [parsedItem('Soup', 500), parsedItem('Salad', 700, 2), parsedItem('Visa', 1300)], subtotalCents: 1200, taxCents: 100, totalCents: 1300 }),
    );
    expect(s).toMatchObject({ name: 'r1', set: 'tuning', expected: 2, matched: 2, exact: 1, extra: 1, totalCorrect: true });
    expect(s.extraItems).toEqual([{ name: 'Visa', totalCents: 1300 }]);
  });

  it('reconciled follows checkTotals: a 1 cent gap is reconciled, a 2 cent gap is not', () => {
    const exp = expectedReceipt({ items, subtotalCents: 1200, totalCents: 1200 });
    const one = parsed({ items: [parsedItem('Soup', 500), parsedItem('Salad', 701)], subtotalCents: 1200, totalCents: 1200 });
    const two = parsed({ items: [parsedItem('Soup', 500), parsedItem('Salad', 702)], subtotalCents: 1200, totalCents: 1200 });
    expect(scoreReceipt('r', exp, one).reconciled).toBe(true);
    expect(scoreReceipt('r', exp, two).reconciled).toBe(false);
    // The second check on its own: subtotal + tax 1 cent off, then 2 cents off.
    const t1 = parsed({ items: [parsedItem('Soup', 500), parsedItem('Salad', 700)], subtotalCents: 1200, taxCents: 99, totalCents: 1300 });
    const t2 = parsed({ items: [parsedItem('Soup', 500), parsedItem('Salad', 700)], subtotalCents: 1200, taxCents: 98, totalCents: 1300 });
    expect(scoreReceipt('r', exp, t1).reconciled).toBe(true);
    expect(scoreReceipt('r', exp, t2).reconciled).toBe(false);
  });

  it('is not reconciled when no totals check could run (nothing was checked)', () => {
    const s = scoreReceipt('r', expectedReceipt({ items }), parsed({ items: [] }));
    expect(s.reconciled).toBe(false);
  });

  it('totalCorrect needs the exact expected total, and a null expected total only matches null', () => {
    const exp = expectedReceipt({ items, totalCents: 1300 });
    expect(scoreReceipt('r', exp, parsed({ items: [], totalCents: 1301 })).totalCorrect).toBe(false);
    expect(scoreReceipt('r', expectedReceipt({ items, totalCents: null }), parsed({ items: [] })).totalCorrect).toBe(true);
  });

  it('lists what was missed', () => {
    const s = scoreReceipt('r', expectedReceipt({ items }), parsed({ items: [parsedItem('Soup', 500)] }));
    expect(s.missed).toEqual([{ name: 'Salad', totalCents: 700 }]);
  });
});

// ---------- per-set summary ----------

describe('summarizeSet', () => {
  it('sums one set only and picks the 3 worst by (expected - matched) + extra', () => {
    const scores = [
      rs('a', 'tuning', 10),
      rs('b', 'tuning', 4, { extra: 1 }), // 7
      rs('c', 'tuning', 8, { extra: 3, reconciled: false }), // 5
      rs('d', 'tuning', 9, { totalCorrect: false }), // 1
      rs('e', 'tuning', 2), // 8
      rs('z', 'heldout', 0),
    ];
    const s = summarizeSet(scores, 'tuning');
    expect(s).toMatchObject({ receipts: 5, matched: 33, expected: 50, extra: 4, reconciled: 4, totalCorrect: 4 });
    expect(s.accuracy).toBeCloseTo(33 / 50, 10);
    expect(s.worst.map((w) => w.name)).toEqual(['e', 'b', 'c']);
  });

  it('has null accuracy for an empty set', () => {
    expect(summarizeSet([], 'heldout').accuracy).toBeNull();
  });
});

// ---------- decide / decideCore ----------

describe('decide', () => {
  // 12 tuning × 10 expected = 120 expected; noise guard = max(2, ceil(2% × 120)) = max(2, 3) = 3.
  const base = scoreSet(12, 8);
  const plus = (scores: ReceiptScore[], names: string[], by = 1) =>
    names.reduce((acc, n) => edit(acc, n, (s) => ({ matched: s.matched + by })), scores);
  const good = plus(base, ['t0', 't1', 't2']); // +3 on tuning, held-out unchanged

  it('requires the sizes it was given', () => {
    expect(MIN_TUNING_RECEIPTS).toBe(12);
    expect(MIN_HELDOUT_RECEIPTS).toBe(8);
  });

  it('ADOPTs exactly at the noise guard, and REJECTs (a) one below it', () => {
    expect(decide(base, good, { confirm: true })).toMatchObject({ verdict: 'ADOPT', failed: [] });
    const r = decide(base, plus(base, ['t0', 't1']), { confirm: true });
    expect(r).toMatchObject({ verdict: 'REJECT', failed: ['a'] });
  });

  it('uses 2 as the noise floor on a small tuning set', () => {
    // 12 tuning × 5 expected = 60; 2% = 1.2 -> 2, so max(2, 2) = 2.
    const small = scoreSet(12, 8).map((s) => ({ ...s, expected: 5, matched: 3 }));
    expect(decide(small, plus(small, ['t0', 't1']), { confirm: true }).verdict).toBe('ADOPT');
    expect(decide(small, plus(small, ['t0']), { confirm: true }).failed).toEqual(['a']);
  });

  it('REJECTs (b) alone: one tuning receipt loses 2 while the sum still rises enough', () => {
    const cand = edit(plus(base, ['t1', 't2', 't3', 't4', 't5']), 't0', (s) => ({ matched: s.matched - 2 }));
    expect(decide(base, cand, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['b'] });
  });

  it('allows a tuning receipt to lose exactly 1', () => {
    const cand = edit(plus(base, ['t1', 't2', 't3', 't4']), 't0', (s) => ({ matched: s.matched - 1 }));
    expect(decide(base, cand, { confirm: true }).verdict).toBe('ADOPT');
  });

  it('REJECTs (c) alone: extra rises by 2 on tuning, but 1 is allowed', () => {
    const two = edit(good, 't5', () => ({ extra: 2 }));
    expect(decide(base, two, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['c'] });
    expect(decide(base, edit(good, 't5', () => ({ extra: 1 })), { confirm: true }).verdict).toBe('ADOPT');
  });

  it('REJECTs (d) alone: one fewer correct total on tuning', () => {
    const cand = edit(good, 't5', () => ({ totalCorrect: false }));
    expect(decide(base, cand, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['d'] });
  });

  it('REJECTs (e) alone: held-out sum falls with no receipt losing more than 1', () => {
    const cand = edit(good, 'h0', (s) => ({ matched: s.matched - 1 }));
    expect(decide(base, cand, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['e'] });
  });

  it('REJECTs (f) alone: one held-out receipt loses 2 while the held-out sum holds', () => {
    const cand = plus(edit(good, 'h0', (s) => ({ matched: s.matched - 2 })), ['h1', 'h2']);
    expect(decide(base, cand, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['f'] });
  });

  it('REJECTs (g) alone: one fewer correct total on held-out', () => {
    const cand = edit(good, 'h0', () => ({ totalCorrect: false }));
    expect(decide(base, cand, { confirm: true })).toMatchObject({ verdict: 'REJECT', failed: ['g'] });
  });

  it('without --confirm, never looks at held-out and stops at TUNING_PASSED', () => {
    const heldOutHarm = edit(good, 'h0', () => ({ matched: 0, totalCorrect: false }));
    expect(decide(base, heldOutHarm, { confirm: false })).toMatchObject({ verdict: 'TUNING_PASSED', failed: [] });
    // A tuning failure is still a REJECT without --confirm.
    expect(decide(base, base, { confirm: false })).toMatchObject({ verdict: 'REJECT', failed: ['a'] });
  });

  it('gives NO DECISION below 12 tuning or 8 held-out receipts', () => {
    const fewTuning = scoreSet(11, 8);
    const fewHeld = scoreSet(12, 7);
    expect(decide(fewTuning, plus(fewTuning, ['t0', 't1', 't2']), { confirm: true }).verdict).toBe('NO_DECISION');
    expect(decide(fewHeld, plus(fewHeld, ['t0', 't1', 't2']), { confirm: true }).verdict).toBe('NO_DECISION');
  });

  it('below the minimum, decides provisionally only when asked to (Amendment A1)', () => {
    const few = scoreSet(3, 2);
    const cand = plus(few, ['t0', 't1']);
    expect(decide(few, cand, { confirm: true, allowBelowMinimum: true })).toMatchObject({ verdict: 'ADOPT', provisional: true });
    expect(decide(base, good, { confirm: true, allowBelowMinimum: true }).provisional).toBe(false);
  });

  it('still gives NO DECISION for an empty set, even provisionally', () => {
    const none = scoreSet(3, 0);
    expect(decide(none, none, { confirm: true, allowBelowMinimum: true }).verdict).toBe('NO_DECISION');
    expect(decide([], [], { confirm: false, allowBelowMinimum: true }).verdict).toBe('NO_DECISION');
  });

  it('gives NO DECISION when the two variants did not score the same receipts', () => {
    const cand = good.filter((s) => s.name !== 't11');
    const r = decide(base, cand, { confirm: true });
    expect(r.verdict).toBe('NO_DECISION');
    expect(r.reason).toContain('t11');
  });
});

describe('decideCore', () => {
  const base = scoreSet(12, 8);

  it('ADOPTs equal numbers (no gain needed, only no harm)', () => {
    expect(decideCore(base, base, { confirm: true })).toMatchObject({ verdict: 'ADOPT', failed: [] });
  });

  it('REJECTs when one held-out receipt loses 2 items', () => {
    const cand = edit(base, 'h3', (s) => ({ matched: s.matched - 2 }));
    const r = decideCore(base, cand, { confirm: true });
    expect(r.verdict).toBe('REJECT');
    expect(r.failed).toContain('f');
  });

  it('still applies the tuning harm clauses (b)', () => {
    const cand = edit(base, 't0', (s) => ({ matched: s.matched - 2 }));
    expect(decideCore(base, cand, { confirm: true }).failed).toEqual(['b']);
  });
});

// ---------- validation ----------

describe('validateExpected', () => {
  it('accepts a valid file', () => {
    const r = validateExpected(validJson(), 'eval/receipts/x.expected.json');
    expect(r.ok).toBe(true);
  });

  it.each([
    ['12.5 cents', (j: Record<string, unknown>) => ({ ...j, subtotalCents: 12.5 }), 'subtotalCents'],
    ['negative cents', (j: Record<string, unknown>) => ({ ...j, taxCents: -1 }), 'taxCents'],
    ['a string amount', (j: Record<string, unknown>) => ({ ...j, items: [{ name: 'Soup', qty: 1, totalCents: '12.50' }] }), 'items[0].totalCents'],
    ['qty 0', (j: Record<string, unknown>) => ({ ...j, items: [{ name: 'Soup', qty: 0, totalCents: 650 }] }), 'items[0].qty'],
    ['a fractional qty', (j: Record<string, unknown>) => ({ ...j, items: [{ name: 'Soup', qty: 1.5, totalCents: 650 }] }), 'items[0].qty'],
    ['a string total', (j: Record<string, unknown>) => ({ ...j, totalCents: '1034' }), 'totalCents'],
    ['a fractional discount', (j: Record<string, unknown>) => ({ ...j, discounts: [{ label: 'x', cents: 0.5, appliesTo: 'total' }] }), 'discounts[0].cents'],
    ['a bad status', (j: Record<string, unknown>) => ({ ...j, status: 'done' }), 'status'],
    ['a bad set', (j: Record<string, unknown>) => ({ ...j, set: 'test' }), 'set'],
    ['a missing field', (j: Record<string, unknown>) => { const { feesCents: _drop, ...rest } = j; return rest; }, 'feesCents'],
    ['an empty item name', (j: Record<string, unknown>) => ({ ...j, items: [{ name: '  ', qty: 1, totalCents: 650 }] }), 'items[0].name'],
  ])('rejects %s, naming the file and the field', (_label, mutate, field) => {
    const r = validateExpected(mutate(validJson()), 'eval/receipts/x.expected.json');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('eval/receipts/x.expected.json') && e.includes(field))).toBe(true);
  });

  it('rejects a file that is not an object', () => {
    expect(validateExpected([], 'f.json').ok).toBe(false);
    expect(validateExpected(null, 'f.json').ok).toBe(false);
  });
});

describe('validateOcrFile', () => {
  it('accepts lines with optional boxes', () => {
    const r = validateOcrFile({ version: 1, variant: 'v', photo: 'p', lines: [{ text: 'a' }, { text: 'b', box: { x: 0, y: 0, width: 1, height: 1 } }] }, 'f');
    expect(r.ok).toBe(true);
  });

  it('rejects a missing lines array or a non-string line, naming the field', () => {
    const a = validateOcrFile({ version: 1 }, 'f.ocr.json');
    const b = validateOcrFile({ version: 1, lines: [{ text: 3 }] }, 'f.ocr.json');
    expect(a.ok || b.ok).toBe(false);
    if (!a.ok) expect(a.errors.join()).toContain('lines');
    if (!b.ok) expect(b.errors.join()).toContain('lines[0].text');
  });
});

// ---------- names of photos and the split ----------

describe('slugifyPhotoName / photoNames', () => {
  it('slugs the base name: lowercase, [a-z0-9-], at most 60 characters', () => {
    expect(slugifyPhotoName('My Café_Receipt (1).JPG')).toBe('my-cafe-receipt-1');
    const long = slugifyPhotoName(`${'a'.repeat(80)}.png`);
    expect(long).toHaveLength(60);
    expect(slugifyPhotoName('###.jpg')).toBe('receipt');
  });

  it('gives a second photo with the same slug a -2 suffix, in sorted file order', () => {
    expect(photoNames(['b.png', 'Lunch.jpg', 'lunch.png'])).toEqual([
      { file: 'Lunch.jpg', name: 'lunch' },
      { file: 'b.png', name: 'b' },
      { file: 'lunch.png', name: 'lunch-2' },
    ]);
  });

  it('keeps a suffixed name within 60 characters', () => {
    const n = photoNames([`${'a'.repeat(70)}.jpg`, `${'a'.repeat(70)}.png`]);
    expect(n[1]?.name).toHaveLength(60);
    expect(n[1]?.name.endsWith('-2')).toBe(true);
  });
});

describe('sha256Hex / assignSet', () => {
  it('matches the standard SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // Longer than one 64-byte block.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('assigns the set from the first hash byte mod 5 (0-2 tuning, 3-4 held-out)', () => {
    // First bytes (checked with `shasum -a 256`): dc, 83, bb, 49, ea.
    expect(assignSet('taco-stand')).toBe('tuning'); // 0xdc % 5 = 0
    expect(assignSet('corner-cafe-2')).toBe('tuning'); // 0x83 % 5 = 1
    expect(assignSet('bakery-long')).toBe('tuning'); // 0xbb % 5 = 2
    expect(assignSet('noodle-bar')).toBe('heldout'); // 0x49 % 5 = 3
    expect(assignSet('sample-diner')).toBe('heldout'); // 0xea % 5 = 4
  });
});

// ---------- report ----------

describe('formatEvalReport', () => {
  const scores = [rs('t0', 'tuning', 8), rs('h0', 'heldout', 3, { missed: [{ name: 'Secret Item', totalCents: 999 }] })];

  it('hides held-out numbers without --confirm and prints the hidden line', () => {
    const out = formatEvalReport({ variant: 'v1', scores, skipped: [], confirm: false });
    expect(out).toContain('held-out hidden (use --confirm once you\'ve chosen on tuning)');
    expect(out).toContain('Tuning');
    expect(out).not.toContain('Held-out:');
    expect(out).not.toContain('h0');
    expect(out).not.toContain('Secret Item');
  });

  it('with --confirm prints tuning and held-out separately and never a pooled number', () => {
    const out = formatEvalReport({ variant: 'v1', scores, skipped: [], confirm: true });
    expect(out).toContain('Tuning (1 receipts): line items 8/10 (80.0%)');
    expect(out).toContain('Held-out (1 receipts): line items 3/10 (30.0%)');
    expect(out).not.toContain('11/20');
    expect(out).not.toContain('held-out hidden');
  });

  it('lists drafts as unchecked and skipped', () => {
    const out = formatEvalReport({ variant: 'v1', scores, skipped: [{ name: 'd1', why: 'unchecked, skipped' }], confirm: false });
    expect(out).toContain('d1: unchecked, skipped');
  });

  it('says so when there is nothing checked to score', () => {
    const out = formatEvalReport({ variant: 'v1', scores: [], skipped: [], confirm: false });
    expect(out).toContain('No checked receipts to score');
  });
});

// ---------- --flow simulation ----------

describe('simulateFlow', () => {
  const lines = (...t: string[]): RecognizedText => ({ lines: t.map((text) => ({ text })) });
  // Synthetic reads: a good one that adds up (5+ lines, items = subtotal, subtotal + tax = total)
  // and a poor one with no total.
  const good = lines('CORNER DELI', 'Soup 5.00', 'Salad 7.00', 'Subtotal 12.00', 'Tax 1.00', 'Total 13.00');
  const poor = lines('CORNER DELI', 'Soup 5.00', 'Salad 7.00', 'Thanks', 'Come again');

  it('keeps an ok primary and never reads the retry', () => {
    const r = simulateFlow(good, poor);
    expect(r).toMatchObject({ chosen: 'primary', retried: false });
    expect(r.verdict.ok).toBe(true);
  });

  it('retries a failed primary and takes a better retry', () => {
    const r = simulateFlow(poor, good);
    expect(r).toMatchObject({ chosen: 'retry', retried: true });
    expect(r.parsed.totalCents).toBe(1300);
  });

  it('keeps the primary when the retry is worse', () => {
    const worse = lines('x');
    expect(simulateFlow(poor, worse)).toMatchObject({ chosen: 'primary', retried: true });
  });

  it('keeps the primary on a full tie', () => {
    expect(simulateFlow(poor, poor)).toMatchObject({ chosen: 'primary', retried: true });
  });

  it('keeps a failed primary when there is no retry read', () => {
    expect(simulateFlow(poor, null)).toMatchObject({ chosen: 'primary', retried: false });
  });
});
