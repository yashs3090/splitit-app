import {
  draftHasEntries,
  draftReducer,
  emptyDraft,
  evaluateDraft,
  FIELD_ERROR_COPY,
  fromParsed,
  NAME_MAX_LENGTH,
  NO_SUBTOTAL_MISMATCH_COPY,
  NOTE_MAX_LENGTH,
  preTipTotalCents,
  REASON_COPY,
  reasonCopy,
  setDiscountClaimable,
  TIP_PRESETS,
  tipBaseCents,
  tipPresets,
  type BillDraft,
  type DraftAction,
  type DraftEvaluation,
} from './billDraft';
import { getFixture } from './fixtures/receipts';
import { checkTotals } from './receiptText';
import type { ParsedReceipt, ReviewReason } from './receiptTypes';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Applies actions in order, deep-freezing each intermediate draft so any mutation throws. */
function apply(draft: BillDraft, ...actions: DraftAction[]): BillDraft {
  return actions.reduce((d, a) => draftReducer(deepFreeze(d), a), draft);
}

/** Builds a draft with the given item rows (name, qty, price) and totals. */
function draftWith(
  items: Array<{ name: string; price: string; qty?: string; note?: string }>,
  totals: Partial<BillDraft['totals']> = {},
): BillDraft {
  let d = emptyDraft();
  for (const it of items) {
    d = apply(d, { type: 'addItem' });
    const id = d.items[d.items.length - 1]?.id ?? '';
    d = apply(d, { type: 'updateItem', id, patch: it });
  }
  for (const [field, value] of Object.entries(totals)) {
    d = apply(d, { type: 'setTotal', field: field as keyof BillDraft['totals'], value: value ?? '' });
  }
  return d;
}

function collectCents(e: DraftEvaluation): number[] {
  const r = e.receipt;
  return [
    e.itemsTotalCents,
    ...r.items.flatMap((i) => [i.totalCents, ...(i.unitCents === null ? [] : [i.unitCents])]),
    ...r.discounts.map((d) => d.cents),
    ...[r.subtotalCents, r.taxCents, r.tipCents, r.feesCents, r.totalCents].filter((v): v is number => v !== null),
  ];
}

describe('emptyDraft', () => {
  it('is a manual draft with no rows and blank totals', () => {
    expect(emptyDraft()).toEqual({
      source: 'manual',
      items: [],
      discounts: [],
      totals: { subtotal: '', tax: '', fees: '', tip: '', total: '' },
      nextId: 1,
    });
  });

  it('evaluates to no errors and only "missing" hints (criterion 22)', () => {
    const e = evaluateDraft(emptyDraft());
    expect(e.errors).toEqual({});
    expect(e.itemsTotalCents).toBe(0);
    expect(e.mismatches).toEqual([]);
    // Amendment A3 (docs/specs/2026-11-24-first-total-as-subtotal.md): a blank subtotal isn't asked for.
    expect(e.missing).toEqual(['no_items', 'missing_total']);
  });
});

describe('fromParsed', () => {
  it('round-trips the diner-simple receipt without losing anything (criterion 23)', () => {
    const { expected } = getFixture('diner-simple');
    const d = fromParsed(expected);
    expect(d.source).toBe('scan');
    const e = evaluateDraft(d);
    expect(e.receipt).toEqual(expected);
    expect(e.errors).toEqual({});
  });

  it('shows modifiers as the note and the folded price (criterion 23)', () => {
    const d = fromParsed(getFixture('modifiers').expected);
    expect(d.items[0]).toMatchObject({ name: 'Bowl', qty: '1', price: '13.00', note: 'avocado, no onions', flagged: false });
    expect(d.totals).toEqual({ subtotal: '17.00', tax: '1.36', fees: '', tip: '', total: '18.36' });
  });

  it('turns null totals into blank strings and maps discounts', () => {
    const d = fromParsed(getFixture('discount-before-subtotal').expected);
    expect(d.totals.tip).toBe('');
    expect(d.discounts).toEqual([{ id: expect.any(String), label: 'Happy Hour', amount: '3.00', appliesTo: 'subtotal', claimable: false }]);
  });

  it('gives every row a unique id and keeps nextId ahead of them', () => {
    const d = fromParsed(getFixture('discount-before-subtotal').expected);
    const ids = [...d.items.map((i) => i.id), ...d.discounts.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const after = apply(d, { type: 'addItem' });
    expect(ids).not.toContain(after.items[after.items.length - 1]?.id);
  });

  it('marks parser-flagged items', () => {
    const p: ParsedReceipt = {
      ...getFixture('diner-simple').expected,
      items: [{ name: 'Soda', qty: 2, unitCents: 250, totalCents: 600, modifiers: [], flags: ['qty_price_mismatch'] }],
    };
    expect(fromParsed(p).items[0]?.flagged).toBe(true);
  });
});

describe('draftReducer (criterion 24)', () => {
  it('addItem twice gives i1 and i2 with qty "1"', () => {
    const d = apply(emptyDraft(), { type: 'addItem' }, { type: 'addItem' });
    expect(d.items).toEqual([
      { id: 'i1', name: '', qty: '1', price: '', note: '', flagged: false },
      { id: 'i2', name: '', qty: '1', price: '', note: '', flagged: false },
    ]);
  });

  it('updateItem changes only the target row', () => {
    const d = apply(emptyDraft(), { type: 'addItem' }, { type: 'addItem' });
    const next = apply(d, { type: 'updateItem', id: 'i1', patch: { price: '4.50' } });
    expect(next.items[0]?.price).toBe('4.50');
    expect(next.items[1]).toEqual(d.items[1]);
  });

  it('updateItem clears the flag', () => {
    const d = fromParsed({
      ...getFixture('diner-simple').expected,
      items: [{ name: 'Soda', qty: 2, unitCents: 250, totalCents: 600, modifiers: [], flags: ['qty_price_mismatch'] }],
    });
    const id = d.items[0]?.id ?? '';
    expect(apply(d, { type: 'updateItem', id, patch: { name: 'Soda' } }).items[0]?.flagged).toBe(false);
  });

  it('removeItem leaves only the others', () => {
    const d = apply(emptyDraft(), { type: 'addItem' }, { type: 'addItem' }, { type: 'removeItem', id: 'i1' });
    expect(d.items.map((i) => i.id)).toEqual(['i2']);
  });

  it('treats unknown ids as no-ops', () => {
    const d = apply(emptyDraft(), { type: 'addItem' }, { type: 'addDiscount' });
    expect(apply(d, { type: 'updateItem', id: 'nope', patch: { name: 'x' } })).toEqual(d);
    expect(apply(d, { type: 'removeItem', id: 'nope' })).toEqual(d);
    expect(apply(d, { type: 'updateDiscount', id: 'nope', patch: { label: 'x' } })).toEqual(d);
    expect(apply(d, { type: 'removeDiscount', id: 'nope' })).toEqual(d);
  });

  it('adds, updates and removes discounts', () => {
    let d = apply(emptyDraft(), { type: 'addDiscount' });
    const id = d.discounts[0]?.id ?? '';
    expect(id).toMatch(/^d\d+$/);
    expect(d.discounts[0]).toEqual({ id, label: '', amount: '', appliesTo: 'subtotal', claimable: false });
    d = apply(d, { type: 'updateDiscount', id, patch: { amount: '3.00', appliesTo: 'total' } });
    expect(d.discounts[0]).toEqual({ id, label: '', amount: '3.00', appliesTo: 'total', claimable: false });
    expect(apply(d, { type: 'removeDiscount', id }).discounts).toEqual([]);
  });

  it('setTotal sets one field and reset replaces the draft', () => {
    const d = apply(emptyDraft(), { type: 'setTotal', field: 'tax', value: '1.72' });
    expect(d.totals).toEqual({ subtotal: '', tax: '1.72', fees: '', tip: '', total: '' });
    const other = fromParsed(getFixture('diner-simple').expected);
    expect(apply(d, { type: 'reset', draft: other })).toEqual(other);
  });

  it('never mutates its input (deep-frozen drafts would throw)', () => {
    const d = deepFreeze(apply(emptyDraft(), { type: 'addItem' }, { type: 'addDiscount' }));
    const snapshot = JSON.stringify(d);
    const actions: DraftAction[] = [
      { type: 'addItem' },
      { type: 'updateItem', id: 'i1', patch: { name: 'x' } },
      { type: 'removeItem', id: 'i1' },
      { type: 'addDiscount' },
      { type: 'updateDiscount', id: 'd2', patch: { label: 'x' } },
      { type: 'removeDiscount', id: 'd2' },
      { type: 'setTotal', field: 'total', value: '1' },
      { type: 'reset', draft: emptyDraft() },
    ];
    for (const a of actions) draftReducer(d, a);
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('evaluateDraft validation (criterion 25)', () => {
  it('ignores a just-added blank row', () => {
    const e = evaluateDraft(apply(emptyDraft(), { type: 'addItem' }));
    expect(e.errors).toEqual({});
    expect(e.receipt.items).toEqual([]);
    expect(e.itemsTotalCents).toBe(0);
  });

  it.each([
    ['12.999', 'invalid_money'],
    ['abc', 'invalid_money'],
    ['-5', 'invalid_money'],
    ['100000', 'too_large'],
  ] as const)('price %s gives %s and is excluded', (price, code) => {
    const d = draftWith([
      { name: 'Good', price: '5.00' },
      { name: 'Bad', price },
    ]);
    const e = evaluateDraft(d);
    expect(e.errors).toEqual({ 'i2.price': code });
    expect(e.itemsTotalCents).toBe(500);
    expect(e.receipt.items.map((i) => i.name)).toEqual(['Good']);
  });

  it('requires a price when there is a name, and a name when there is a price', () => {
    expect(evaluateDraft(draftWith([{ name: 'Burger', price: '' }])).errors).toEqual({ 'i1.price': 'price_required' });
    expect(evaluateDraft(draftWith([{ name: '  ', price: '4.00' }])).errors).toEqual({ 'i1.name': 'name_required' });
  });

  it.each(['0', '100', '1.5', 'x', '', '-1', '1 2'])('qty %p gives invalid_qty', (qty) => {
    const e = evaluateDraft(draftWith([{ name: 'Burger', price: '4.00', qty }]));
    expect(e.errors).toEqual({ 'i1.qty': 'invalid_qty' });
    expect(e.receipt.items).toEqual([]);
  });

  it('builds items with unit price when exact, modifiers from the note', () => {
    const e = evaluateDraft(
      draftWith([
        { name: ' Burger ', price: '25.98', qty: '2', note: 'avocado, , no onions ' },
        { name: 'Fries', price: '10.00', qty: ' 3 ' },
      ]),
    );
    expect(e.receipt.items).toEqual([
      { name: 'Burger', qty: 2, unitCents: 1299, totalCents: 2598, modifiers: ['avocado', 'no onions'] },
      { name: 'Fries', qty: 3, unitCents: null, totalCents: 1000, modifiers: [] },
    ]);
  });

  it('treats an invalid total field as null and reports it', () => {
    const e = evaluateDraft(draftWith([{ name: 'A', price: '1.00' }], { subtotal: '1.00', tax: 'abc', total: '1.00' }));
    expect(e.errors).toEqual({ 'totals.tax': 'invalid_money' });
    expect(e.receipt.taxCents).toBeNull();
    expect(evaluateDraft(draftWith([], { total: '100000' })).errors).toEqual({ 'totals.total': 'too_large' });
  });

  it('validates discounts: blank ignored, amount required, default label', () => {
    let d = apply(emptyDraft(), { type: 'addDiscount' }, { type: 'addDiscount' }, { type: 'addDiscount' });
    d = apply(
      d,
      { type: 'updateDiscount', id: 'd2', patch: { label: 'Coupon' } },
      { type: 'updateDiscount', id: 'd3', patch: { amount: '2.5', appliesTo: 'total' } },
    );
    const e = evaluateDraft(d);
    expect(e.errors).toEqual({ 'd2.amount': 'price_required' });
    expect(e.receipt.discounts).toEqual([{ label: 'Discount', cents: 250, appliesTo: 'total' }]);
    const bad = apply(d, { type: 'updateDiscount', id: 'd2', patch: { amount: '(5.00)' } });
    expect(evaluateDraft(bad).errors).toEqual({ 'd2.amount': 'invalid_money' });
  });

  it('produces only integer cents', () => {
    const e = evaluateDraft(
      draftWith(
        [
          { name: 'A', price: '0.29' },
          { name: 'B', price: '4.35', qty: '3' },
          { name: 'C', price: '.5' },
        ],
        { subtotal: '5.14', tax: '1.15', tip: '0.57', fees: '0', total: '6.86' },
      ),
    );
    const cents = collectCents(e);
    expect(cents.length).toBeGreaterThan(5);
    for (const c of cents) expect(Number.isInteger(c)).toBe(true);
  });
});

describe('evaluateDraft live totals check (criterion 26)', () => {
  const items = [
    { name: 'Burger', price: '12.99' },
    { name: 'Fries', price: '8.50' },
  ];

  it('reconciles a correct bill with tip blank', () => {
    const e = evaluateDraft(draftWith(items, { subtotal: '21.49', tax: '1.72', total: '23.21' }));
    expect(e.mismatches).toEqual([]);
    expect(e.missing).toEqual([]);
    expect(e.receipt.needsReview).toBe(false);
    expect(e.receipt.tipCents).toBeNull();
  });

  it('flags 2 cents off, passes 1 cent off', () => {
    expect(evaluateDraft(draftWith(items, { subtotal: '21.51', tax: '1.72', total: '23.23' })).mismatches).toEqual([
      'items_vs_subtotal',
    ]);
    expect(evaluateDraft(draftWith(items, { subtotal: '21.50', tax: '1.72', total: '23.22' })).mismatches).toEqual([]);
  });

  it('applies a discount before the subtotal, and not after', () => {
    let d = draftWith(items, { subtotal: '18.49' });
    d = apply(d, { type: 'addDiscount' });
    const id = d.discounts[0]?.id ?? '';
    d = apply(d, { type: 'updateDiscount', id, patch: { amount: '3.00' } });
    expect(evaluateDraft(d).mismatches).toEqual([]);
    d = apply(d, { type: 'updateDiscount', id, patch: { appliesTo: 'total' } });
    expect(evaluateDraft(d).mismatches).toEqual(['items_vs_subtotal']);
  });

  it('reports a subtotal-vs-total mismatch', () => {
    const e = evaluateDraft(draftWith(items, { subtotal: '21.49', tax: '1.72', total: '23.24' }));
    expect(e.mismatches).toEqual(['subtotal_vs_total']);
  });

  it('keeps qty_price_mismatch for a flagged row until it is edited, without double-reporting', () => {
    const p: ParsedReceipt = {
      items: [{ name: 'Soda', qty: 2, unitCents: 250, totalCents: 600, modifiers: [], flags: ['qty_price_mismatch'] }],
      subtotalCents: 600,
      taxCents: null,
      tipCents: null,
      feesCents: null,
      discounts: [],
      totalCents: 600,
      needsReview: true,
      reasons: ['qty_price_mismatch'],
    };
    const d = fromParsed(p);
    const e = evaluateDraft(d);
    expect(e.mismatches).toEqual(['qty_price_mismatch']);
    expect(e.receipt.reasons).toEqual(['qty_price_mismatch']);
    expect(e.receipt.needsReview).toBe(true);
    expect(e.receipt.items[0]?.flags).toEqual(['qty_price_mismatch']);

    const id = d.items[0]?.id ?? '';
    const edited = evaluateDraft(apply(d, { type: 'updateItem', id, patch: { price: '5.00' } }));
    expect(edited.mismatches).toEqual(['items_vs_subtotal']);
    expect(edited.receipt.items[0]?.flags).toBeUndefined();
  });

  it('does not report qty_price_mismatch for a flagged row that is invalid', () => {
    const d = fromParsed({
      ...getFixture('diner-simple').expected,
      items: [{ name: 'Soda', qty: 2, unitCents: 250, totalCents: 600, modifiers: [], flags: ['qty_price_mismatch'] }],
    });
    // Build an invalid flagged row directly (editing would clear the flag).
    const broken: BillDraft = { ...d, items: d.items.map((i) => ({ ...i, qty: '0' })) };
    expect(evaluateDraft(broken).mismatches).not.toContain('qty_price_mismatch');
  });
});

describe('evaluateDraft gaps and status (review R1, R2)', () => {
  const items = [
    { name: 'Burger', price: '12.99' },
    { name: 'Fries', price: '8.50' },
  ];

  it('R1: a 2-cent-off subtotal has gap 2; a reconciled bill has gap 0', () => {
    const off = evaluateDraft(draftWith(items, { subtotal: '21.47', tax: '1.72', total: '23.19' }));
    expect(off.mismatches).toEqual(['items_vs_subtotal']);
    expect(off.gaps.items_vs_subtotal).toBe(2);
    expect(off.gaps.subtotal_vs_total).toBe(0);
    const ok = evaluateDraft(draftWith(items, { subtotal: '21.49', tax: '1.72', total: '23.21' }));
    expect(ok.gaps).toEqual({ items_vs_subtotal: 0, subtotal_vs_total: 0 });
  });

  it('R1: the no-subtotal case reports the items-plus-extras gap against the total', () => {
    const e = evaluateDraft(draftWith(items, { tax: '1.72', total: '23.23' }));
    expect(e.mismatches).toEqual(['subtotal_vs_total']);
    expect(e.gaps).toEqual({ subtotal_vs_total: -2 });
  });

  it('R2: adds_up, mismatch and incomplete', () => {
    expect(evaluateDraft(draftWith(items, { subtotal: '21.49', tax: '1.72', total: '23.21' })).status).toBe('adds_up');
    expect(evaluateDraft(draftWith(items, { subtotal: '21.49', tax: '1.72', total: '23.24' })).status).toBe('mismatch');
    expect(evaluateDraft(draftWith(items, { subtotal: '21.49' })).status).toBe('incomplete');
    expect(evaluateDraft(emptyDraft()).status).toBe('incomplete');
  });

  it('R2: an invalid tax is has_errors, not adds_up, even though the rest reconciles without it', () => {
    const e = evaluateDraft(draftWith([{ name: 'Burger', price: '12.99' }], { subtotal: '12.99', tax: '1.7x', total: '12.99' }));
    expect(e.errors['totals.tax']).toBe('invalid_money');
    expect(e.mismatches).toEqual([]);
    expect(e.missing).toEqual([]);
    expect(e.status).toBe('has_errors');
  });

  it('R2: an invalid-price row left out of the sum is has_errors', () => {
    const e = evaluateDraft(
      draftWith(
        [
          { name: 'Burger', price: '12.99' },
          { name: 'Fries', price: '3.9.9' },
        ],
        { subtotal: '12.99', total: '12.99' },
      ),
    );
    expect(e.itemsTotalCents).toBe(1299);
    expect(e.mismatches).toEqual([]);
    expect(e.status).toBe('has_errors');
  });

  it('R2: field errors win over a mismatch', () => {
    const e = evaluateDraft(draftWith(items, { subtotal: '30.00', tax: 'abc', total: '30.00' }));
    expect(e.mismatches).toEqual(['items_vs_subtotal']);
    expect(e.status).toBe('has_errors');
  });
});

describe('copy', () => {
  it('has the fixed field error copy', () => {
    expect(FIELD_ERROR_COPY).toEqual({
      name_required: 'Add a name.',
      price_required: 'Add a price.',
      invalid_money: 'Enter an amount like 12.99.',
      too_large: 'That amount is too large.',
      invalid_qty: 'Use a whole number from 1 to 99.',
    });
  });

  it('has copy for every review reason', () => {
    const reasons: ReviewReason[] = [
      'no_items',
      'missing_subtotal',
      'missing_total',
      'items_vs_subtotal',
      'subtotal_vs_total',
      'qty_price_mismatch',
    ];
    for (const r of reasons) expect(REASON_COPY[r]).toMatch(/\S/);
    expect(REASON_COPY.items_vs_subtotal).toBe("The items don't add up to the subtotal.");
    expect(REASON_COPY.missing_total).toBe('Enter the total from the receipt to check it.');
  });
});

describe('tip helpers (backlog item 1)', () => {
  const setTip = (value: string): DraftAction => ({ type: 'setTip', value });
  const withDiscount = (d: BillDraft, amount: string, appliesTo: 'subtotal' | 'total'): BillDraft => {
    const added = apply(d, { type: 'addDiscount' });
    const id = added.discounts[added.discounts.length - 1]?.id ?? '';
    return apply(added, { type: 'updateDiscount', id, patch: { label: 'Promo', amount, appliesTo } });
  };

  describe('tipBaseCents', () => {
    it('uses the subtotal field when it is filled', () => {
      expect(tipBaseCents(draftWith([{ name: 'A', price: '30.00' }], { subtotal: '40.00', tax: '3.20' }))).toBe(4000);
    });

    it('with a blank subtotal, uses items less before-subtotal discounts (not after-subtotal ones)', () => {
      let d = draftWith([{ name: 'A', price: '30.00' }, { name: 'B', price: '15.00' }]);
      d = withDiscount(d, '5.00', 'subtotal');
      d = withDiscount(d, '2.00', 'total');
      expect(tipBaseCents(d)).toBe(4000);
    });

    it('is null when there is nothing to base it on, or a field it needs is invalid', () => {
      expect(tipBaseCents(emptyDraft())).toBeNull();
      expect(tipBaseCents(draftWith([{ name: 'A', price: '10.00' }], { subtotal: '1.2.3' }))).toBeNull();
      expect(tipBaseCents(draftWith([{ name: 'A', price: 'abc' }]))).toBeNull();
      expect(tipBaseCents(draftWith([{ name: 'A', price: '5.00' }, { name: '', price: '1.00' }]))).toBeNull();
    });

    it('is null when discounts make the base negative', () => {
      expect(tipBaseCents(withDiscount(draftWith([{ name: 'A', price: '1.00' }]), '5.00', 'subtotal'))).toBeNull();
    });
  });

  describe('tipPresets', () => {
    it('are 15/18/20/25% of the base, rounded half up', () => {
      expect(TIP_PRESETS).toEqual([1500, 1800, 2000, 2500]);
      expect(tipPresets(draftWith([], { subtotal: '40.00' }))).toEqual([
        { hundredths: 1500, cents: 600 },
        { hundredths: 1800, cents: 720 },
        { hundredths: 2000, cents: 800 },
        { hundredths: 2500, cents: 1000 },
      ]);
      expect(tipPresets(draftWith([], { subtotal: '33.30' }))?.[0]).toEqual({ hundredths: 1500, cents: 500 });
    });

    it('are null without a base', () => {
      expect(tipPresets(emptyDraft())).toBeNull();
    });
  });

  describe('preTipTotalCents', () => {
    it('is subtotal + tax + fees - after-subtotal discounts', () => {
      let d = draftWith([{ name: 'A', price: '40.00' }], { subtotal: '40.00', tax: '3.20', fees: '1.00' });
      d = withDiscount(d, '2.00', 'total');
      expect(preTipTotalCents(d)).toBe(4220);
    });

    it('with a blank subtotal, is items less every discount plus tax and fees (like the totals check)', () => {
      let d = draftWith([{ name: 'A', price: '40.00' }], { tax: '3.20' });
      d = withDiscount(d, '5.00', 'subtotal');
      d = withDiscount(d, '1.00', 'total');
      expect(preTipTotalCents(d)).toBe(3720);
    });

    it('is null when tax or fees are invalid, or there is no base', () => {
      expect(preTipTotalCents(draftWith([{ name: 'A', price: '4.00' }], { tax: 'x' }))).toBeNull();
      expect(preTipTotalCents(draftWith([{ name: 'A', price: '4.00' }], { fees: '1.234' }))).toBeNull();
      expect(preTipTotalCents(emptyDraft())).toBeNull();
    });
  });

  describe('setTip keeps the total in step', () => {
    const bill = (total: string) => draftWith([{ name: 'A', price: '40.00' }], { subtotal: '40.00', tax: '3.20', total });

    it('fills a blank total with pre-tip sum + tip', () => {
      const d = apply(bill(''), setTip('8.00'));
      expect(d.totals).toMatchObject({ tip: '8.00', total: '51.20' });
      expect(evaluateDraft(d).status).toBe('adds_up');
    });

    it('updates a total that equals the pre-tip sum (within 1 cent), keeping that cent', () => {
      expect(apply(bill('43.20'), setTip('8.00')).totals.total).toBe('51.20');
      expect(apply(bill('43.21'), setTip('8.00')).totals.total).toBe('51.21');
      expect(apply(bill('43.19'), setTip('8.00')).totals.total).toBe('51.19');
    });

    it('leaves a total the user typed differently, so the check flags it', () => {
      const d = apply(bill('60.00'), setTip('8.00'));
      expect(d.totals).toMatchObject({ tip: '8.00', total: '60.00' });
      expect(evaluateDraft(d).mismatches).toContain('subtotal_vs_total');
      expect(apply(bill('43.22'), setTip('8.00')).totals.total).toBe('43.22');
    });

    it('changing and removing the tip moves the total the same way', () => {
      let d = apply(bill(''), setTip('8.00'), setTip('10.00'));
      expect(d.totals.total).toBe('53.20');
      d = apply(d, setTip(''));
      expect(d.totals).toMatchObject({ tip: '', total: '43.20' });
      d = apply(d, setTip('0'));
      expect(d.totals.total).toBe('43.20');
    });

    it('stays in step while the user types into the tip field one keystroke at a time', () => {
      const d = apply(bill('43.20'), setTip('1'), setTip('12'), setTip('12.'), setTip('12.5'));
      expect(d.totals).toMatchObject({ tip: '12.5', total: '55.70' });
    });

    it('does not fill a blank total when the tip is cleared or zero', () => {
      expect(apply(bill(''), setTip('')).totals.total).toBe('');
      expect(apply(bill(''), setTip('0.00')).totals.total).toBe('');
    });

    it('leaves the total alone when the new tip is invalid, or the sum cannot be worked out', () => {
      expect(apply(bill('43.20'), setTip('8.x')).totals).toMatchObject({ tip: '8.x', total: '43.20' });
      const badTax = draftWith([{ name: 'A', price: '40.00' }], { subtotal: '40.00', tax: 'x', total: '' });
      expect(apply(badTax, setTip('8.00')).totals.total).toBe('');
      expect(apply(emptyDraft(), setTip('5.00')).totals).toMatchObject({ tip: '5.00', total: '' });
      const badTotal = draftWith([{ name: 'A', price: '40.00' }], { subtotal: '40.00', total: 'abc' });
      expect(apply(badTotal, setTip('8.00')).totals.total).toBe('abc');
    });

    it('never writes a total above the field limit', () => {
      const big = draftWith([], { subtotal: '99999.00', total: '' });
      expect(apply(big, setTip('5.00')).totals.total).toBe('');
    });

    it('setTotal on tip stays a plain field set (no total change)', () => {
      expect(apply(bill('43.20'), { type: 'setTotal', field: 'tip', value: '8.00' }).totals.total).toBe('43.20');
    });
  });
});

// Amendment A3, docs/specs/2026-11-24-first-total-as-subtotal.md: a blank subtotal is not
// "missing"; the checks use the items in its place, and the mismatch copy says so.
describe('blank subtotal (A3)', () => {
  const burger = [{ name: 'Burger', price: '20.00' }];
  const blankSub = (total: string) => draftWith(burger, { tax: '1.60', total });

  it('A3-1: items, tax and total that reconcile add up without a subtotal', () => {
    const e = evaluateDraft(blankSub('21.60'));
    expect(e.status).toBe('adds_up');
    expect(e.missing).toEqual([]);
    expect(e.mismatches).toEqual([]);
  });

  it('A3-2a: 1 cent off still adds up', () => {
    expect(evaluateDraft(blankSub('21.61')).status).toBe('adds_up');
  });

  it('A3-2b: 2 cents off is a mismatch with the no-subtotal copy', () => {
    const e = evaluateDraft(blankSub('21.62'));
    expect(e.status).toBe('mismatch');
    expect(e.mismatches).toEqual(['subtotal_vs_total']);
    expect(e.gaps.subtotal_vs_total).toBe(-2);
    expect(reasonCopy(e, 'subtotal_vs_total')).toBe(NO_SUBTOTAL_MISMATCH_COPY);
    expect(NO_SUBTOTAL_MISMATCH_COPY).toBe("The items, tax, fees and tip don't add up to the total.");
  });

  it('A3-2c: with a subtotal entered, the mismatch keeps the subtotal copy', () => {
    const e = evaluateDraft(draftWith(burger, { subtotal: '20.00', tax: '1.60', total: '21.62' }));
    expect(e.mismatches).toEqual(['subtotal_vs_total']);
    expect(reasonCopy(e, 'subtotal_vs_total')).toBe(REASON_COPY.subtotal_vs_total);
  });

  it('an invalid subtotal counts as blank in the check, so the copy talks about the items', () => {
    const e = evaluateDraft(draftWith(burger, { subtotal: 'abc', tax: '1.60', total: '21.62' }));
    expect(reasonCopy(e, 'subtotal_vs_total')).toBe(NO_SUBTOTAL_MISMATCH_COPY);
  });

  it('reasonCopy returns REASON_COPY for every other reason', () => {
    const e = evaluateDraft(blankSub('21.62'));
    for (const r of ['no_items', 'missing_subtotal', 'missing_total', 'items_vs_subtotal', 'qty_price_mismatch'] as const) {
      expect(reasonCopy(e, r)).toBe(REASON_COPY[r]);
    }
  });

  it('A3-3: items with subtotal and total blank only ask for the total', () => {
    const e = evaluateDraft(draftWith(burger));
    expect(e.missing).toEqual(['missing_total']);
    expect(e.status).toBe('incomplete');
  });

  it('A3-4: an empty draft asks for items and the total only', () => {
    expect(evaluateDraft(emptyDraft()).missing).toEqual(['no_items', 'missing_total']);
  });

  it('A3-5: a wrong subtotal is still checked against the items, with today\'s copy', () => {
    const e = evaluateDraft(draftWith(burger, { subtotal: '19.00', total: '19.00' }));
    expect(e.mismatches).toContain('items_vs_subtotal');
    expect(reasonCopy(e, 'items_vs_subtotal')).toBe(REASON_COPY.items_vs_subtotal);
  });

  it('A3-6: an invalid subtotal is still a field error', () => {
    const e = evaluateDraft(draftWith(burger, { subtotal: 'abc', total: '20.00' }));
    expect(e.errors['totals.subtotal']).toBe('invalid_money');
    expect(e.status).toBe('has_errors');
  });

  it('A3-7: receipt.reasons stay exactly what checkTotals returns (plus qty_price_mismatch)', () => {
    const drafts = [
      blankSub('21.60'),
      blankSub('21.61'),
      blankSub('21.62'),
      draftWith(burger, { subtotal: '20.00', tax: '1.60', total: '21.62' }),
      draftWith(burger),
      emptyDraft(),
      draftWith(burger, { subtotal: '19.00', total: '19.00' }),
    ];
    for (const d of drafts) {
      const e = evaluateDraft(d);
      expect(e.receipt.reasons).toEqual(checkTotals(e.receipt));
      expect(e.receipt.needsReview).toBe(e.receipt.reasons.length > 0);
    }
    const blank = evaluateDraft(blankSub('21.60'));
    expect(blank.receipt.reasons).toContain('missing_subtotal');
    expect(blank.receipt.needsReview).toBe(true);

    const flagged = fromParsed({
      items: [{ name: 'Burger', qty: 2, unitCents: null, totalCents: 2000, modifiers: [], flags: ['qty_price_mismatch'] }],
      subtotalCents: null,
      taxCents: 160,
      tipCents: null,
      feesCents: null,
      discounts: [],
      totalCents: 2160,
      needsReview: true,
      reasons: [],
    });
    const fe = evaluateDraft(flagged);
    expect(fe.receipt.reasons).toEqual([...checkTotals(fe.receipt), 'qty_price_mismatch']);
    expect(fe.missing).toEqual([]);
  });
});

// Claimable discounts: docs/specs/2026-11-24-claimable-discounts.md (C5, criteria 26 and 29).
describe('claimable discounts (criteria 26, 29)', () => {
  it('26: emptyDraft has none, addDiscount and fromParsed give claimable: false', () => {
    expect(emptyDraft().discounts).toEqual([]);
    const added = apply(emptyDraft(), { type: 'addDiscount' });
    expect(added.discounts[0]?.claimable).toBe(false);
    const parsed = fromParsed(getFixture('discount-before-subtotal').expected);
    expect(parsed.discounts.length).toBeGreaterThan(0);
    expect(parsed.discounts.every((x) => x.claimable === false)).toBe(true);
  });

  it('26: updateDiscount with { claimable: true } flips only that row', () => {
    const d = apply(emptyDraft(), { type: 'addDiscount' }, { type: 'addDiscount' });
    const [first, second] = d.discounts;
    const next = apply(d, { type: 'updateDiscount', id: second?.id ?? '', patch: { claimable: true } });
    expect(next.discounts[0]).toEqual(first);
    expect(next.discounts[1]).toEqual({ ...second, claimable: true });
    // And back.
    const back = apply(next, { type: 'updateDiscount', id: second?.id ?? '', patch: { claimable: false } });
    expect(back.discounts).toEqual(d.discounts);
  });

  it('setDiscountClaimable builds the updateDiscount action', () => {
    expect(setDiscountClaimable('d3', true)).toEqual({ type: 'updateDiscount', id: 'd3', patch: { claimable: true } });
    const d = apply(emptyDraft(), { type: 'addDiscount' });
    const id = d.discounts[0]?.id ?? '';
    expect(apply(d, setDiscountClaimable(id, true)).discounts[0]?.claimable).toBe(true);
  });

  it('29: toggling claimable changes neither the gaps nor the status', () => {
    // B1-shaped bill: Steak 16.03, Salad 14.00, comp 16.03 before the subtotal, subtotal 14.00, tax 2.40, total 16.40.
    const cases: Array<[string, string]> = [
      ['16.03', '16.40'], // adds up
      ['16.01', '16.40'], // mismatch
      ['', '16.40'], // has_errors (amount required)
      ['16.03', ''], // incomplete (no total)
    ];
    for (const [amount, total] of cases) {
      let d = draftWith([{ name: 'Steak', price: '16.03' }, { name: 'Salad', price: '14.00' }], { subtotal: '14.00', tax: '2.40', total });
      d = apply(d, { type: 'addDiscount' });
      const id = d.discounts[0]?.id ?? '';
      d = apply(d, { type: 'updateDiscount', id, patch: { label: 'Police comp', amount } });
      const split = evaluateDraft(d);
      const claim = evaluateDraft(apply(d, setDiscountClaimable(id, true)));
      expect(claim.gaps).toEqual(split.gaps);
      expect(claim.status).toBe(split.status);
      expect(claim.errors).toEqual(split.errors);
    }
  });
});

// Review R2 (Amendment A1): scanned text longer than the DB allows is clipped on the way into the
// form, so a long label can't fail the save once the discount is switched to Claim (22023).
describe('fromParsed clips text to the database limits (R2)', () => {
  const base = getFixture('discount-before-subtotal').expected;
  const long = (n: number) => 'x'.repeat(n);

  it('clips a discount label and an item name to 100 characters, and a note to 200', () => {
    const p: ParsedReceipt = {
      ...base,
      items: [{ name: long(150), qty: 1, unitCents: 500, totalCents: 500, modifiers: [long(120), long(120)] }],
      discounts: [{ label: long(101), cents: 100, appliesTo: 'subtotal' }],
    };
    const d = fromParsed(p);
    expect(NAME_MAX_LENGTH).toBe(100);
    expect(NOTE_MAX_LENGTH).toBe(200);
    expect(d.discounts[0]?.label).toBe(long(100));
    expect(d.items[0]?.name).toBe(long(100));
    expect(d.items[0]?.note.length).toBeLessThanOrEqual(200);
  });

  it('counts characters the way Postgres does (code points), and never leaves a trailing space', () => {
    const emoji = '🍔'.repeat(100); // 100 code points, 200 UTF-16 units
    const p: ParsedReceipt = {
      ...base,
      items: [{ name: emoji, qty: 1, unitCents: 500, totalCents: 500, modifiers: [] }],
      discounts: [{ label: `${long(99)} tail`, cents: 100, appliesTo: 'subtotal' }],
    };
    const d = fromParsed(p);
    expect(d.items[0]?.name).toBe(emoji);
    expect(d.discounts[0]?.label).toBe(long(99));
  });

  it('leaves text within the limits unchanged', () => {
    const d = fromParsed(base);
    expect(d.discounts[0]?.label).toBe('Happy Hour');
  });
});

// Visual pass V10a (P2, decision VP-M1): going back from the new-bill form asks first only when
// something was entered.
describe('draftHasEntries', () => {
  const add = (d: BillDraft, ...actions: DraftAction[]) => actions.reduce(draftReducer, d);

  it('an empty manual draft has nothing entered', () => {
    expect(draftHasEntries(emptyDraft())).toBe(false);
  });

  it('blank rows the person added but never typed in are not entries', () => {
    expect(draftHasEntries(add(emptyDraft(), { type: 'addItem' }, { type: 'addDiscount' }))).toBe(false);
  });

  it.each([
    ['an item name', { name: 'Fries' }],
    ['an item price', { price: '3.99' }],
    ['an item note', { note: 'no salt' }],
    ['a changed quantity', { qty: '2' }],
  ] as const)('%s is an entry', (_label, patch) => {
    const d = add(emptyDraft(), { type: 'addItem' });
    expect(draftHasEntries(add(d, { type: 'updateItem', id: 'i1', patch }))).toBe(true);
  });

  it('whitespace alone is not an entry, and a cleared quantity is not either', () => {
    const d = add(emptyDraft(), { type: 'addItem' }, { type: 'updateItem', id: 'i1', patch: { name: '  ', qty: '' } });
    expect(draftHasEntries(d)).toBe(false);
  });

  it.each([
    ['a discount label', { label: 'Coupon' }],
    ['a discount amount', { amount: '5' }],
  ] as const)('%s is an entry', (_label, patch) => {
    const d = add(emptyDraft(), { type: 'addDiscount' });
    expect(draftHasEntries(add(d, { type: 'updateDiscount', id: 'd1', patch }))).toBe(true);
  });

  it.each(['subtotal', 'tax', 'fees', 'total'] as const)('a %s is an entry', (field) => {
    expect(draftHasEntries(add(emptyDraft(), { type: 'setTotal', field, value: '1.00' }))).toBe(true);
  });

  it('a tip is an entry', () => {
    expect(draftHasEntries(add(emptyDraft(), { type: 'setTip', value: '2.00' }))).toBe(true);
  });

  it('a scanned draft always counts: leaving would throw the scan away', () => {
    expect(draftHasEntries({ ...emptyDraft(), source: 'scan' })).toBe(true);
  });
});
