import { draftReducer, emptyDraft, evaluateDraft, type BillDraft, type DraftAction } from './billDraft';
import {
  draftFromSaved,
  SAVE_BLOCK_COPY,
  toBillArgs,
  type BillRowArg,
  type SaveBlock,
  type SavedBill,
  type SavedClaim,
  type SavedGroups,
  type SavedRow,
} from './billPayload';

function apply(draft: BillDraft, ...actions: DraftAction[]): BillDraft {
  return actions.reduce((d, a) => draftReducer(d, a), draft);
}

type ItemSpec = { name: string; price: string; qty?: string; note?: string };

/** Builds a draft through the reducer, as the form does. */
function draftWith(
  items: ItemSpec[],
  totals: Partial<BillDraft['totals']> = {},
  discounts: Array<{ label: string; amount: string; appliesTo: 'subtotal' | 'total'; claimable?: boolean }> = [],
): BillDraft {
  let d = emptyDraft();
  for (const it of items) {
    d = apply(d, { type: 'addItem' });
    const id = d.items[d.items.length - 1]?.id ?? '';
    d = apply(d, { type: 'updateItem', id, patch: it });
  }
  for (const disc of discounts) {
    d = apply(d, { type: 'addDiscount' });
    const id = d.discounts[d.discounts.length - 1]?.id ?? '';
    d = apply(d, { type: 'updateDiscount', id, patch: disc });
  }
  for (const [field, value] of Object.entries(totals)) {
    d = apply(d, { type: 'setTotal', field: field as keyof BillDraft['totals'], value: value ?? '' });
  }
  return d;
}

function args(d: BillDraft, saved?: SavedGroups) {
  return toBillArgs(d, evaluateDraft(d), saved);
}

function okArgs(d: BillDraft, saved?: SavedGroups) {
  const r = args(d, saved);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
}

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

const centsToInput = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

// Criterion 64's bill.
const BASE_ITEMS: ItemSpec[] = [
  { name: 'Burger', price: '15.00' },
  { name: 'Fries', price: '6.00' },
  { name: 'Beer', qty: '2', price: '14.00' },
];
const BASE_TOTALS = { tax: '2.80', tip: '7.00', total: '44.80' };
const baseDraft = (): BillDraft => draftWith(BASE_ITEMS, BASE_TOTALS);

const BILL_ID_ROWS: SavedRow[] = [
  { id: 'r-burger', name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500 },
  { id: 'r-fries', name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600 },
  { id: 'r-beer0', name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 2, total_cents: 700 },
  { id: 'r-beer1', name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 2, total_cents: 700 },
];
const SAVED_BILL: SavedBill = {
  subtotal_cents: null,
  tax_cents: 280,
  fees_cents: 0,
  tip_cents: 700,
  subtotal_discount_cents: 0,
  total_discount_cents: 0,
  total_cents: 4480,
};

function allNumbers(rows: BillRowArg[], money: Record<string, number | null>): number[] {
  return [
    ...rows.flatMap((r) => [r.group_position, r.unit_index, r.group_size, r.total_cents]),
    ...Object.values(money).filter((v): v is number => v !== null),
  ];
}

describe('toBillArgs: criterion 64 (create)', () => {
  it('expands Beer x2 into two unit rows with no ids and null notes', () => {
    const r = okArgs(baseDraft());
    expect(r.rows).toEqual([
      { name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500 },
      { name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600 },
      { name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 2, total_cents: 700 },
      { name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 2, total_cents: 700 },
    ]);
    for (const row of r.rows) expect('id' in row).toBe(false);
    expect(r.droppedClaimedIds).toEqual([]);
    expect(r.removedClaimedIds).toEqual([]);
  });

  it('builds the money args', () => {
    const r = okArgs(baseDraft());
    expect(r.money).toEqual({
      p_subtotal_cents: null,
      p_tax_cents: 280,
      p_fees_cents: 0,
      p_tip_cents: 700,
      p_subtotal_discount_cents: 0,
      p_total_discount_cents: 0,
      p_total_cents: 4480,
    });
  });

  it('uses only integers', () => {
    const r = okArgs(baseDraft());
    for (const n of allNumbers(r.rows, r.money)) expect(Number.isInteger(n)).toBe(true);
  });

  it('trims the name and joins the note from its modifiers', () => {
    const d = draftWith([{ name: '  Taco ', price: '5.00', note: ' avocado ,, no onions ' }], { total: '5.00' });
    const r = okArgs(d);
    expect(r.rows[0]).toMatchObject({ name: 'Taco', note: 'avocado, no onions' });
  });

  it('passes an entered subtotal through and repeats the note on every unit', () => {
    const d = draftWith([{ name: 'Wings', qty: '2', price: '9.00', note: 'hot' }], { subtotal: '9.00', total: '9.00' });
    const r = okArgs(d);
    expect(r.money.p_subtotal_cents).toBe(900);
    expect(r.rows.map((x) => x.note)).toEqual(['hot', 'hot']);
    expect(r.rows.map((x) => x.total_cents)).toEqual([450, 450]);
  });
});

describe('toBillArgs: criterion 65 (unit expansion)', () => {
  it('splits 10.00 over 3 units as 334, 333, 333', () => {
    const r = okArgs(draftWith([{ name: 'Beer', qty: '3', price: '10.00' }]));
    expect(r.rows.map((x) => x.total_cents)).toEqual([334, 333, 333]);
    expect(r.rows.map((x) => x.unit_index)).toEqual([0, 1, 2]);
    expect(r.rows.every((x) => x.group_size === 3 && x.group_position === 0)).toBe(true);
  });

  it('splits 1.00 over 99 units as one 2 and 98 ones', () => {
    const r = okArgs(draftWith([{ name: 'Shot', qty: '99', price: '1.00' }]));
    expect(r.rows).toHaveLength(99);
    expect(r.rows[0]?.total_cents).toBe(2);
    expect(r.rows.slice(1).every((x) => x.total_cents === 1)).toBe(true);
  });

  it('handles a $0.00 line and a price smaller than the qty', () => {
    const zero = okArgs(draftWith([{ name: 'Water', qty: '3', price: '0.00' }]));
    expect(zero.rows.map((x) => x.total_cents)).toEqual([0, 0, 0]);
    const small = okArgs(draftWith([{ name: 'Mint', qty: '4', price: '0.02' }]));
    expect(small.rows.map((x) => x.total_cents)).toEqual([1, 1, 0, 0]);
  });

  it('property (seeded): units sum exactly to the line price and differ by at most 1 cent', () => {
    const r = rng(20261121);
    for (let i = 0; i < 300; i++) {
      const qty = int(r, 1, 99);
      const cents = int(r, 0, 9_999_999);
      const res = okArgs(draftWith([{ name: 'X', qty: String(qty), price: centsToInput(cents) }]));
      const units = res.rows.map((x) => x.total_cents);
      expect(units).toHaveLength(qty);
      expect(units.reduce((a, b) => a + b, 0)).toBe(cents);
      expect(units.every((u) => Number.isInteger(u) && u >= 0)).toBe(true);
      expect(Math.max(...units) - Math.min(...units)).toBeLessThanOrEqual(1);
      // First units get the extra cent: non-increasing.
      for (let k = 1; k < units.length; k++) expect(units[k]).toBeLessThanOrEqual(units[k - 1] ?? 0);
    }
  });
});

describe('toBillArgs: criterion 66 (money)', () => {
  it('computes a blank total from the items and extras', () => {
    const d = draftWith(BASE_ITEMS, { tax: '2.80', tip: '7.00' });
    expect(okArgs(d).money.p_total_cents).toBe(4480);
  });

  it('sums discounts by where they apply and subtracts both from a computed total', () => {
    const d = draftWith(BASE_ITEMS, { tax: '2.80', tip: '7.00', fees: '1.00' }, [
      { label: 'Promo', amount: '5.00', appliesTo: 'subtotal' },
      { label: 'Coupon', amount: '1.00', appliesTo: 'total' },
    ]);
    const r = okArgs(d);
    expect(r.money.p_subtotal_discount_cents).toBe(500);
    expect(r.money.p_total_discount_cents).toBe(100);
    expect(r.money.p_fees_cents).toBe(100);
    expect(r.money.p_total_cents).toBe(3500 - 600 + 280 + 100 + 700);
  });
});

describe('toBillArgs: tolerance', () => {
  it('a draft 1 cent off on both checks (items vs subtotal, subtotal vs total) still saves', () => {
    // Items 35.00, subtotal 35.01 (+1), subtotal + extras 44.81 vs total 44.82 (+1): 2 cents end to end.
    const d = draftWith(BASE_ITEMS, { ...BASE_TOTALS, subtotal: '35.01', total: '44.82' });
    const ev = evaluateDraft(d);
    expect(ev.gaps).toEqual({ items_vs_subtotal: -1, subtotal_vs_total: -1 });
    const r = okArgs(d);
    expect(r.money).toMatchObject({ p_subtotal_cents: 3501, p_total_cents: 4482 });
  });
});

describe('toBillArgs: criterion 67 (save blocks, in order)', () => {
  const reason = (d: BillDraft): SaveBlock | null => {
    const r = args(d);
    return r.ok ? null : r.reason;
  };

  it('has_errors for an invalid price', () => {
    expect(reason(draftWith([{ name: 'Burger', price: '12.999' }]))).toBe('has_errors');
  });

  it('has_errors wins over no_items when the only row is invalid', () => {
    expect(reason(draftWith([{ name: '', price: '5.00' }]))).toBe('has_errors');
  });

  it('no_items for an empty draft and for blank rows only', () => {
    expect(reason(emptyDraft())).toBe('no_items');
    expect(reason(draftWith([{ name: '', price: '' }], { total: '1.00' }))).toBe('no_items');
  });

  it('mismatch when the subtotal is 2 cents off', () => {
    expect(reason(draftWith(BASE_ITEMS, { ...BASE_TOTALS, subtotal: '35.02' }))).toBe('mismatch');
  });

  it('a 1 cent gap is not a mismatch', () => {
    expect(reason(draftWith(BASE_ITEMS, { ...BASE_TOTALS, subtotal: '35.01', total: '44.81' }))).toBeNull();
  });

  it('too_many_units for 6 rows x qty 99 (594 units), and exactly 500 is fine', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, qty: '99', price: '99.00' }));
    expect(reason(draftWith(six))).toBe('too_many_units');
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `Item ${i}`, qty: '99', price: '99.00' }));
    expect(reason(draftWith([...five, { name: 'Last', qty: '5', price: '5.00' }]))).toBeNull();
    expect(reason(draftWith([...five, { name: 'Last', qty: '6', price: '6.00' }]))).toBe('too_many_units');
  });

  it('too_many_units is checked before negative_total', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, qty: '99', price: '0.00' }));
    const d = draftWith(six, {}, [{ label: 'Comp', amount: '1.00', appliesTo: 'total' }]);
    expect(reason(d)).toBe('too_many_units');
  });

  it('negative_total when discounts exceed a computed total', () => {
    const d = draftWith([{ name: 'Burger', price: '5.00' }], {}, [{ label: 'Comp', amount: '6.00', appliesTo: 'total' }]);
    expect(reason(d)).toBe('negative_total');
  });

  it('a total of exactly $0.00 saves', () => {
    const d = draftWith([{ name: 'Burger', price: '5.00' }], {}, [{ label: 'Comp', amount: '5.00', appliesTo: 'total' }]);
    expect(okArgs(d).money.p_total_cents).toBe(0);
  });

  it('a blank draft row in the middle does not shift group_position', () => {
    const d = draftWith(
      [
        { name: 'Burger', price: '15.00' },
        { name: '', price: '' },
        { name: 'Beer', qty: '2', price: '14.00' },
      ],
      { total: '29.00' },
    );
    const r = okArgs(d);
    expect(r.rows.map((x) => [x.name, x.group_position, x.unit_index])).toEqual([
      ['Burger', 0, 0],
      ['Beer', 1, 0],
      ['Beer', 1, 1],
    ]);
  });

  it('has copy for every reason', () => {
    expect(SAVE_BLOCK_COPY).toEqual({
      has_errors: 'Fix the highlighted fields to save.',
      no_items: 'Add at least one item to save.',
      mismatch: 'The numbers need to add up before you can save.',
      negative_total: "The total can't be below $0.00.",
      too_many_units: "That's too many items for one bill (500 max).",
    });
  });
});

describe('draftFromSaved', () => {
  it('criterion 68: regroups unit rows into 3 form rows, Beer qty 2 at 14.00', () => {
    const { draft, saved } = draftFromSaved(SAVED_BILL, BILL_ID_ROWS, []);
    expect(draft.items.map((i) => [i.name, i.qty, i.price, i.note, i.flagged])).toEqual([
      ['Burger', '1', '15.00', '', false],
      ['Fries', '1', '6.00', '', false],
      ['Beer', '2', '14.00', '', false],
    ]);
    const [burger, fries, beer] = draft.items;
    expect(saved.units).toEqual({
      [burger?.id ?? '']: ['r-burger'],
      [fries?.id ?? '']: ['r-fries'],
      [beer?.id ?? '']: ['r-beer0', 'r-beer1'],
    });
    expect(saved.claimedIds.size).toBe(0);
    expect(evaluateDraft(draft).status).toBe('adds_up'); // a blank subtotal isn't asked for (A3)
  });

  it('criterion 68: round trip gives the same rows with their saved ids and the same money', () => {
    const { draft, saved } = draftFromSaved(SAVED_BILL, BILL_ID_ROWS, []);
    const r = okArgs(draft, saved);
    expect(r.rows).toEqual(BILL_ID_ROWS);
    expect(r.money).toEqual(okArgs(baseDraft()).money);
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('sorts rows that arrive out of order and reads name and note from unit 0', () => {
    const rows: SavedRow[] = [
      { id: 'b1', name: 'Beer', note: 'IPA', group_position: 1, unit_index: 1, group_size: 2, total_cents: 333 },
      { id: 'a0', name: 'Nachos', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 900 },
      { id: 'b0', name: 'Beer', note: 'IPA', group_position: 1, unit_index: 0, group_size: 2, total_cents: 334 },
    ];
    const bill: SavedBill = { ...SAVED_BILL, tax_cents: 0, tip_cents: 0, total_cents: 1567 };
    const { draft, saved } = draftFromSaved(bill, rows, []);
    expect(draft.items.map((i) => [i.name, i.qty, i.price, i.note])).toEqual([
      ['Nachos', '1', '9.00', ''],
      ['Beer', '2', '6.67', 'IPA'],
    ]);
    expect(saved.units[draft.items[1]?.id ?? '']).toEqual(['b0', 'b1']);
  });

  it('criterion 70: tax, fees and tip of 0 and a null subtotal become blank', () => {
    const bill: SavedBill = { subtotal_cents: null, tax_cents: 0, fees_cents: 0, tip_cents: 0, subtotal_discount_cents: 0, total_discount_cents: 0, total_cents: 3500 };
    const { draft } = draftFromSaved(bill, BILL_ID_ROWS, []);
    expect(draft.totals).toEqual({ subtotal: '', tax: '', fees: '', tip: '', total: '35.00' });
    expect(draft.discounts).toEqual([]);
  });

  it('shows a saved subtotal and non-zero extras, and a discount as one total discount row', () => {
    const bill: SavedBill = { subtotal_cents: 3500, tax_cents: 280, fees_cents: 50, tip_cents: 700, subtotal_discount_cents: 0, total_discount_cents: 600, total_cents: 3930 };
    const { draft } = draftFromSaved(bill, BILL_ID_ROWS, []);
    expect(draft.totals).toEqual({ subtotal: '35.00', tax: '2.80', fees: '0.50', tip: '7.00', total: '39.30' });
    expect(draft.discounts).toEqual([{ id: expect.any(String), label: 'Discount', amount: '6.00', appliesTo: 'total', claimable: false }]);
    expect(evaluateDraft(draft).status).toBe('adds_up');
    expect(okArgs(draftFromSaved(bill, BILL_ID_ROWS, []).draft).money).toEqual({
      p_subtotal_cents: 3500,
      p_tax_cents: 280,
      p_fees_cents: 50,
      p_tip_cents: 700,
      p_subtotal_discount_cents: 0,
      p_total_discount_cents: 600,
      p_total_cents: 3930,
    });
  });

  it('reloads each stored discount in its position, so a before-subtotal discount reconciles', () => {
    // Items 35.00, 5.00 off before the subtotal, subtotal 30.00, tax 2.80, tip 7.00, total 39.80.
    const d = draftWith(BASE_ITEMS, { subtotal: '30.00', tax: '2.80', tip: '7.00', total: '39.80' }, [
      { label: 'Promo', amount: '5.00', appliesTo: 'subtotal' },
    ]);
    expect(evaluateDraft(d).status).toBe('adds_up');
    const first = okArgs(d);
    expect(first.money).toEqual({
      p_subtotal_cents: 3000,
      p_tax_cents: 280,
      p_fees_cents: 0,
      p_tip_cents: 700,
      p_subtotal_discount_cents: 500,
      p_total_discount_cents: 0,
      p_total_cents: 3980,
    });

    const bill: SavedBill = {
      subtotal_cents: 3000,
      tax_cents: 280,
      fees_cents: 0,
      tip_cents: 700,
      subtotal_discount_cents: 500,
      total_discount_cents: 0,
      total_cents: 3980,
    };
    const { draft, saved } = draftFromSaved(bill, BILL_ID_ROWS, []);
    expect(draft.discounts).toEqual([{ id: expect.any(String), label: 'Discount', amount: '5.00', appliesTo: 'subtotal', claimable: false }]);
    const ev = evaluateDraft(draft);
    expect(ev.status).toBe('adds_up');
    expect(ev.mismatches).toEqual([]);
    const again = okArgs(draft, saved);
    expect(again.money).toEqual(first.money);
    expect(again.rows).toEqual(BILL_ID_ROWS);
  });

  it('reloads both discounts, before-subtotal first', () => {
    const bill: SavedBill = { ...SAVED_BILL, subtotal_discount_cents: 300, total_discount_cents: 200, total_cents: 3980 };
    const { draft } = draftFromSaved(bill, BILL_ID_ROWS, []);
    expect(draft.discounts.map((x) => [x.amount, x.appliesTo])).toEqual([
      ['3.00', 'subtotal'],
      ['2.00', 'total'],
    ]);
    expect(okArgs(draft).money).toMatchObject({ p_subtotal_discount_cents: 300, p_total_discount_cents: 200, p_total_cents: 3980 });
  });

  it('gives every draft row and discount a unique id and a nextId past them', () => {
    const bill: SavedBill = { ...SAVED_BILL, subtotal_discount_cents: 100, total_discount_cents: 100, total_cents: 4280 };
    const { draft } = draftFromSaved(bill, BILL_ID_ROWS, []);
    const ids = [...draft.items.map((i) => i.id), ...draft.discounts.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
    const added = apply(draft, { type: 'addItem' });
    expect(ids).not.toContain(added.items[added.items.length - 1]?.id);
  });

  it('marks claimed rows, ignoring claims on unknown rows', () => {
    const claims: SavedClaim[] = [
      { line_item_id: 'r-fries', user_id: 'u1', parts: 1 },
      { line_item_id: 'r-fries', user_id: 'u2', parts: 2 },
      { line_item_id: 'r-beer1', user_id: 'u1', parts: 1 },
      { line_item_id: 'gone', user_id: 'u1', parts: 1 },
    ];
    const { saved } = draftFromSaved(SAVED_BILL, BILL_ID_ROWS, claims);
    expect([...saved.claimedIds].sort()).toEqual(['r-beer1', 'r-fries']);
  });
});

describe('toBillArgs with saved ids: criterion 69 (qty changes on edit)', () => {
  /** Loads criterion 64's saved bill, applies edits to the draft and returns the args. */
  function edit(claimed: string[], change: (d: BillDraft) => BillDraft) {
    const claims = claimed.map((id) => ({ line_item_id: id, user_id: 'u1', parts: 1 }));
    const { draft, saved } = draftFromSaved(SAVED_BILL, BILL_ID_ROWS, claims);
    return okArgs(change(draft), saved);
  }
  const rowId = (d: BillDraft, name: string): string => d.items.find((i) => i.name === name)?.id ?? '';
  const setBeer = (qty: string, price: string, total: string) => (d: BillDraft) =>
    apply(d, { type: 'updateItem', id: rowId(d, 'Beer'), patch: { qty, price } }, { type: 'setTotal', field: 'total', value: total });

  it('Beer 2 -> 3 at 21.00 keeps both ids on units 0 and 1; unit 2 has no id; all 700', () => {
    const r = edit([], setBeer('3', '21.00', '51.80'));
    const beer = r.rows.filter((x) => x.name === 'Beer');
    expect(beer).toEqual([
      { id: 'r-beer0', name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 3, total_cents: 700 },
      { id: 'r-beer1', name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 3, total_cents: 700 },
      { name: 'Beer', note: null, group_position: 2, unit_index: 2, group_size: 3, total_cents: 700 },
    ]);
    expect('id' in (beer[2] ?? {})).toBe(false);
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('Beer 2 -> 1 with unit 1 claimed keeps unit 1 and drops unclaimed unit 0', () => {
    const r = edit(['r-beer1'], setBeer('1', '7.00', '37.80'));
    expect(r.rows.filter((x) => x.name === 'Beer')).toEqual([
      { id: 'r-beer1', name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 1, total_cents: 700 },
    ]);
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('Beer 2 -> 1 with both claimed drops the highest index and reports it', () => {
    const r = edit(['r-beer0', 'r-beer1'], setBeer('1', '7.00', '37.80'));
    expect(r.rows.filter((x) => x.name === 'Beer').map((x) => x.id)).toEqual(['r-beer0']);
    expect(r.droppedClaimedIds).toEqual(['r-beer1']);
  });

  it('with no claims, a decrease drops the highest index first', () => {
    const r = edit([], setBeer('1', '7.00', '37.80'));
    expect(r.rows.filter((x) => x.name === 'Beer').map((x) => x.id)).toEqual(['r-beer0']);
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('unclaimed go first (highest index first), then claimed; kept ids keep their order', () => {
    // Shots x5: units 0, 2, 4 claimed; lower to 2 → drop 3, 1 (unclaimed), then 4 (claimed).
    const rows: SavedRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      name: 'Shot',
      note: null,
      group_position: 0,
      unit_index: i,
      group_size: 5,
      total_cents: 200,
    }));
    const bill: SavedBill = { subtotal_cents: null, tax_cents: 0, fees_cents: 0, tip_cents: 0, subtotal_discount_cents: 0, total_discount_cents: 0, total_cents: 1000 };
    const claims = ['s0', 's2', 's4'].map((id) => ({ line_item_id: id, user_id: 'u1', parts: 1 }));
    const { draft, saved } = draftFromSaved(bill, rows, claims);
    const id = draft.items[0]?.id ?? '';
    const edited = apply(draft, { type: 'updateItem', id, patch: { qty: '2', price: '4.00' } }, { type: 'setTotal', field: 'total', value: '4.00' });
    const r = okArgs(edited, saved);
    expect(r.rows.map((x) => [x.id, x.unit_index, x.group_size, x.total_cents])).toEqual([
      ['s0', 0, 2, 200],
      ['s2', 1, 2, 200],
    ]);
    expect(r.droppedClaimedIds).toEqual(['s4']);
  });

  it('deleting the Fries row omits its id and renumbers the groups after it', () => {
    const r = edit(['r-fries'], (d) =>
      apply(d, { type: 'removeItem', id: rowId(d, 'Fries') }, { type: 'setTotal', field: 'total', value: '38.80' }),
    );
    expect(r.rows.map((x) => x.id)).toEqual(['r-burger', 'r-beer0', 'r-beer1']);
    expect(r.rows.map((x) => x.group_position)).toEqual([0, 1, 1]);
    // Row deletion is confirmed by the screen (Task 13), not reported as a qty drop.
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('a saved row with every field cleared is removed and its claimed units are listed', () => {
    const r = edit(['r-beer0', 'r-fries'], (d) =>
      apply(
        d,
        { type: 'updateItem', id: rowId(d, 'Beer'), patch: { name: '', price: '', note: '' } },
        { type: 'setTotal', field: 'total', value: '30.80' },
      ),
    );
    expect(r.rows.map((x) => x.id)).toEqual(['r-burger', 'r-fries']);
    expect(r.removedClaimedIds).toEqual(['r-beer0']);
    expect(r.droppedClaimedIds).toEqual([]);
  });

  it('a cleared row with no claims is removed without anything to confirm', () => {
    const r = edit([], (d) =>
      apply(
        d,
        { type: 'updateItem', id: rowId(d, 'Fries'), patch: { name: ' ', price: '', note: '' } },
        { type: 'setTotal', field: 'total', value: '38.80' },
      ),
    );
    expect(r.rows.map((x) => x.id)).toEqual(['r-burger', 'r-beer0', 'r-beer1']);
    expect(r.removedClaimedIds).toEqual([]);
  });

  it('a newly added row has no ids', () => {
    const r = edit([], (d) => {
      const added = apply(d, { type: 'addItem' });
      const id = added.items[added.items.length - 1]?.id ?? '';
      return apply(added, { type: 'updateItem', id, patch: { name: 'Wine', qty: '2', price: '20.00' } }, { type: 'setTotal', field: 'total', value: '64.80' });
    });
    const wine = r.rows.filter((x) => x.name === 'Wine');
    expect(wine).toHaveLength(2);
    expect(wine.every((x) => !('id' in x) && x.group_position === 3)).toBe(true);
    expect(r.rows.filter((x) => x.id !== undefined)).toHaveLength(4);
  });

  it('a repriced row keeps its id and gets the new cents', () => {
    const r = edit([], (d) =>
      apply(d, { type: 'updateItem', id: rowId(d, 'Burger'), patch: { price: '18.00' } }, { type: 'setTotal', field: 'total', value: '47.80' }),
    );
    expect(r.rows[0]).toEqual({ id: 'r-burger', name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1800 });
    expect(r.money.p_total_cents).toBe(4780);
  });
});

// Claimable discounts: docs/specs/2026-11-24-claimable-discounts.md (C1, C2, C5; criteria 27–31).
describe('claimable discounts', () => {
  const STEAK_SALAD: ItemSpec[] = [
    { name: 'Steak', price: '16.03' },
    { name: 'Salad', price: '14.00' },
  ];
  type Case = { comp: string; appliesTo: 'subtotal' | 'total'; subtotal: string; total: string; accept: boolean };
  // C2 boundary table. Base: items 3003, comp, subtotal 14.00, tax 2.40, tip 0, fees 0, total 16.40.
  const C2: Record<string, Case> = {
    B1: { comp: '16.03', appliesTo: 'subtotal', subtotal: '14.00', total: '16.40', accept: true },
    B2: { comp: '16.02', appliesTo: 'subtotal', subtotal: '14.00', total: '16.40', accept: true },
    B3: { comp: '16.01', appliesTo: 'subtotal', subtotal: '14.00', total: '16.40', accept: false },
    B4: { comp: '16.02', appliesTo: 'subtotal', subtotal: '14.00', total: '16.39', accept: true },
    B5: { comp: '16.02', appliesTo: 'subtotal', subtotal: '', total: '16.40', accept: true },
    B5b: { comp: '16.01', appliesTo: 'subtotal', subtotal: '', total: '16.40', accept: false },
    B7: { comp: '16.03', appliesTo: 'total', subtotal: '14.00', total: '16.40', accept: false },
  };
  const compDraft = (c: Case, claimable: boolean): BillDraft =>
    draftWith(STEAK_SALAD, { subtotal: c.subtotal, tax: '2.40', total: c.total }, [
      { label: 'Police comp', amount: c.comp, appliesTo: c.appliesTo, claimable },
    ]);
  const cents = (s: string): number => Math.round(Number(s) * 100); // test-only: two-decimal fixtures

  describe.each(Object.entries(C2))('28: C2 case %s', (_name, c) => {
    it(`claimable: status ${c.accept ? 'adds_up' : 'mismatch'}, toBillArgs ok ${c.accept}`, () => {
      const d = compDraft(c, true);
      expect(evaluateDraft(d).status).toBe(c.accept ? 'adds_up' : 'mismatch');
      const r = args(d);
      expect(r.ok).toBe(c.accept);
      if (!r.ok) {
        expect(r.reason).toBe('mismatch');
        return;
      }
      // The claimable comp is a row, never in the sums.
      expect(r.money.p_subtotal_discount_cents).toBe(0);
      expect(r.money.p_total_discount_cents).toBe(0);
      expect(r.rows).toHaveLength(3);
      expect(r.rows[2]).toEqual({
        name: 'Police comp',
        note: null,
        group_position: 2,
        unit_index: 0,
        group_size: 1,
        total_cents: -cents(c.comp),
        kind: 'discount',
        applies_to: c.appliesTo,
      });
    });

    it('B6: the same comp as a split discount gives the same answer', () => {
      const split = compDraft(c, false);
      const claim = compDraft(c, true);
      expect(evaluateDraft(split).status).toBe(evaluateDraft(claim).status);
      expect(evaluateDraft(split).gaps).toEqual(evaluateDraft(claim).gaps);
      const r = args(split);
      expect(r.ok).toBe(c.accept);
      if (!r.ok) return;
      expect(r.rows).toHaveLength(2);
      expect(r.money[c.appliesTo === 'subtotal' ? 'p_subtotal_discount_cents' : 'p_total_discount_cents']).toBe(cents(c.comp));
      // DB Dsub/Dtot (sums + discount rows) equal the form's either way.
      const claimArgs = okArgs(claim);
      expect(claimArgs.money.p_total_cents).toBe(r.money.p_total_cents);
    });
  });

  it('27: B1 as a draft gives p_subtotal_discount_cents 0, the discount row, and item rows without kind keys', () => {
    const r = okArgs(compDraft(C2.B1!, true));
    expect(r.money).toEqual({
      p_subtotal_cents: 1400,
      p_tax_cents: 240,
      p_fees_cents: 0,
      p_tip_cents: 0,
      p_subtotal_discount_cents: 0,
      p_total_discount_cents: 0,
      p_total_cents: 1640,
    });
    expect(r.rows[2]).toEqual({
      name: 'Police comp',
      note: null,
      group_position: 2,
      unit_index: 0,
      group_size: 1,
      total_cents: -1603,
      kind: 'discount',
      applies_to: 'subtotal',
    });
    for (const row of r.rows.slice(0, 2)) {
      expect('kind' in row).toBe(false);
      expect('applies_to' in row).toBe(false);
    }
    expect(r.splitClaimedIds).toEqual([]);
  });

  it('puts claimable rows after every item group, in draft order, mixed with split ones', () => {
    const d = draftWith(
      [{ name: 'Beer', qty: '2', price: '14.00' }, { name: 'Fries', price: '6.00' }],
      { total: '11.00' },
      [
        { label: 'Coupon', amount: '5.00', appliesTo: 'total', claimable: true },
        { label: 'Happy hour', amount: '2.00', appliesTo: 'subtotal' },
        { label: '', amount: '2.00', appliesTo: 'subtotal', claimable: true },
      ],
    );
    expect(evaluateDraft(d).status).toBe('adds_up');
    const r = okArgs(d);
    expect(r.rows.map((x) => [x.name, x.group_position, x.total_cents, x.kind, x.applies_to])).toEqual([
      ['Beer', 0, 700, undefined, undefined],
      ['Beer', 0, 700, undefined, undefined],
      ['Fries', 1, 600, undefined, undefined],
      ['Coupon', 2, -500, 'discount', 'total'],
      ['Discount', 3, -200, 'discount', 'subtotal'], // 29: a blank label is stored as 'Discount'
    ]);
    expect(r.money).toMatchObject({ p_subtotal_discount_cents: 200, p_total_discount_cents: 0, p_total_cents: 1100 });
  });

  it('29: a claimable discount of 0.00 gives no row and no change to the sums', () => {
    const d = draftWith(STEAK_SALAD, { tax: '2.40', total: '32.43' }, [
      { label: 'Nothing', amount: '0.00', appliesTo: 'subtotal', claimable: true },
    ]);
    const r = okArgs(d);
    expect(r.rows).toHaveLength(2);
    expect(r.money).toMatchObject({ p_subtotal_discount_cents: 0, p_total_discount_cents: 0, p_total_cents: 3243 });
  });

  it('computes a blank total with every discount, claimable ones included', () => {
    const d = draftWith(STEAK_SALAD, { tax: '2.40' }, [
      { label: 'Police comp', amount: '16.03', appliesTo: 'subtotal', claimable: true },
      { label: 'Promo', amount: '1.00', appliesTo: 'total' },
    ]);
    const r = okArgs(d);
    expect(r.money.p_total_cents).toBe(3003 - 1603 - 100 + 240);
    expect(r.money.p_total_discount_cents).toBe(100);
  });

  it('blocks a claimable discount that takes the total below 0', () => {
    const d = draftWith([{ name: 'Burger', price: '5.00' }], {}, [{ label: 'Comp', amount: '6.00', appliesTo: 'total', claimable: true }]);
    expect(args(d)).toEqual({ ok: false, reason: 'negative_total' });
  });

  it('counts claimable discount rows toward the 500-row limit', () => {
    const fiveHundred = draftWith([{ name: 'Shot', qty: '99', price: '99.00' }, ...Array.from({ length: 4 }, () => ({ name: 'Shot', qty: '99', price: '99.00' })), { name: 'Shot', qty: '5', price: '5.00' }]);
    expect(args(fiveHundred).ok).toBe(true);
    const withComp = draftWith(
      [{ name: 'Shot', qty: '99', price: '99.00' }, ...Array.from({ length: 4 }, () => ({ name: 'Shot', qty: '99', price: '99.00' })), { name: 'Shot', qty: '5', price: '5.00' }],
      {},
      [{ label: 'Comp', amount: '1.00', appliesTo: 'subtotal', claimable: true }],
    );
    expect(args(withComp)).toEqual({ ok: false, reason: 'too_many_units' });
    // A split discount is not a row.
    const withSplit = draftWith(
      [{ name: 'Shot', qty: '99', price: '99.00' }, ...Array.from({ length: 4 }, () => ({ name: 'Shot', qty: '99', price: '99.00' })), { name: 'Shot', qty: '5', price: '5.00' }],
      {},
      [{ label: 'Comp', amount: '1.00', appliesTo: 'subtotal' }],
    );
    expect(args(withSplit).ok).toBe(true);
  });

  // C5 round trip (criterion 30): two items, one split discount (subtotal, 200), and two
  // claimable ones (-1603 subtotal; -500 total).
  const RT_BILL: SavedBill = {
    subtotal_cents: 1200,
    tax_cents: 240,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 200,
    total_discount_cents: 0,
    total_cents: 940,
  };
  const RT_ROWS: SavedRow[] = [
    { id: 'r-steak', name: 'Steak', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1603, kind: 'item', applies_to: null },
    { id: 'r-salad', name: 'Salad', note: 'no croutons', group_position: 1, unit_index: 0, group_size: 1, total_cents: 1400, kind: 'item', applies_to: null },
    { id: 'r-comp', name: 'Police comp', note: null, group_position: 2, unit_index: 0, group_size: 1, total_cents: -1603, kind: 'discount', applies_to: 'subtotal' },
    { id: 'r-coupon', name: 'Coupon', note: null, group_position: 3, unit_index: 0, group_size: 1, total_cents: -500, kind: 'discount', applies_to: 'total' },
  ];
  const shape = (rows: ReadonlyArray<BillRowArg | SavedRow>) =>
    rows.map((x) => [x.id, x.name, x.total_cents, x.kind === 'discount' ? 'discount' : 'item', x.applies_to ?? null, x.group_position, x.unit_index, x.group_size]);

  it('30: draftFromSaved lists the split sum first, then the claimable rows in position order', () => {
    // Rows arrive shuffled.
    const { draft, saved } = draftFromSaved(RT_BILL, [RT_ROWS[3]!, RT_ROWS[1]!, RT_ROWS[2]!, RT_ROWS[0]!], []);
    expect(draft.items.map((i) => i.name)).toEqual(['Steak', 'Salad']);
    expect(draft.discounts.map(({ id: _id, ...rest }) => rest)).toEqual([
      { label: 'Discount', amount: '2.00', appliesTo: 'subtotal', claimable: false },
      { label: 'Police comp', amount: '16.03', appliesTo: 'subtotal', claimable: true },
      { label: 'Coupon', amount: '5.00', appliesTo: 'total', claimable: true },
    ]);
    expect(saved.units[draft.discounts[1]?.id ?? '']).toEqual(['r-comp']);
    expect(saved.units[draft.discounts[2]?.id ?? '']).toEqual(['r-coupon']);
    expect(saved.units[draft.discounts[0]?.id ?? '']).toBeUndefined();
    const ids = [...draft.items.map((i) => i.id), ...draft.discounts.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(draft.nextId).toBeGreaterThan(ids.length);
    expect(evaluateDraft(draft).status).toBe('adds_up');
  });

  it('30: the round trip gives the same rows, kinds, applies_to, positions and money', () => {
    const { draft, saved } = draftFromSaved(RT_BILL, RT_ROWS, []);
    const r = okArgs(draft, saved);
    expect(shape(r.rows)).toEqual(shape(RT_ROWS));
    expect(r.money).toEqual({
      p_subtotal_cents: 1200,
      p_tax_cents: 240,
      p_fees_cents: 0,
      p_tip_cents: 0,
      p_subtotal_discount_cents: 200,
      p_total_discount_cents: 0,
      p_total_cents: 940,
    });
    expect(r.droppedClaimedIds).toEqual([]);
    expect(r.removedClaimedIds).toEqual([]);
    expect(r.splitClaimedIds).toEqual([]);
  });

  it('marks a claimed discount row as claimed', () => {
    const { saved } = draftFromSaved(RT_BILL, RT_ROWS, [{ line_item_id: 'r-comp', user_id: 'u1', parts: 1 }]);
    expect([...saved.claimedIds]).toEqual(['r-comp']);
  });

  it('treats rows without kind as items (fixtures and older callers)', () => {
    const { draft } = draftFromSaved(SAVED_BILL, BILL_ID_ROWS, []);
    expect(draft.items).toHaveLength(3);
    expect(draft.discounts).toEqual([]);
  });

  describe('31: editing after people claimed', () => {
    const claimedComp = [{ line_item_id: 'r-comp', user_id: 'u1', parts: 1 }];
    function open(claims: SavedClaim[] = claimedComp) {
      const { draft, saved } = draftFromSaved(RT_BILL, RT_ROWS, claims);
      const compId = draft.discounts[1]?.id ?? '';
      return { draft, saved, compId };
    }

    it('Claim → Split puts a claimed row in splitClaimedIds, drops the row and moves the amount to the sum', () => {
      const { draft, saved, compId } = open();
      const r = okArgs(apply(draft, { type: 'updateDiscount', id: compId, patch: { claimable: false } }), saved);
      expect(r.splitClaimedIds).toEqual(['r-comp']);
      expect(r.removedClaimedIds).toEqual([]);
      expect(r.rows.map((x) => x.id)).toEqual(['r-steak', 'r-salad', 'r-coupon']);
      expect(r.rows[2]?.group_position).toBe(2);
      expect(r.money.p_subtotal_discount_cents).toBe(200 + 1603);
    });

    it('Claim → Split on an unclaimed row lists nothing', () => {
      const { draft, saved, compId } = open([]);
      const r = okArgs(apply(draft, { type: 'updateDiscount', id: compId, patch: { claimable: false } }), saved);
      expect(r.splitClaimedIds).toEqual([]);
      expect(r.removedClaimedIds).toEqual([]);
    });

    it('setting a claimed one to 0.00 puts it in removedClaimedIds', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'updateDiscount', id: compId, patch: { amount: '0.00' } },
        { type: 'setTotal', field: 'subtotal', value: '28.03' },
        { type: 'setTotal', field: 'total', value: '25.43' },
      );
      expect(evaluateDraft(edited).status).toBe('adds_up');
      const r = okArgs(edited, saved);
      expect(r.removedClaimedIds).toEqual(['r-comp']);
      expect(r.splitClaimedIds).toEqual([]);
      expect(r.rows.map((x) => x.id)).not.toContain('r-comp');
    });

    it('clearing a claimed one (label and amount blank) puts it in removedClaimedIds', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'updateDiscount', id: compId, patch: { label: '', amount: '' } },
        { type: 'setTotal', field: 'subtotal', value: '28.03' },
        { type: 'setTotal', field: 'total', value: '25.43' },
      );
      const r = okArgs(edited, saved);
      expect(r.removedClaimedIds).toEqual(['r-comp']);
      expect(r.splitClaimedIds).toEqual([]);
    });

    it('switched to Split and set to 0.00 counts as removed, not split', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'updateDiscount', id: compId, patch: { amount: '0.00', claimable: false } },
        { type: 'setTotal', field: 'subtotal', value: '28.03' },
        { type: 'setTotal', field: 'total', value: '25.43' },
      );
      const r = okArgs(edited, saved);
      expect(r.removedClaimedIds).toEqual(['r-comp']);
      expect(r.splitClaimedIds).toEqual([]);
    });

    it('deleting the discount with ✕ lists nothing (the screen asked at delete time)', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'removeDiscount', id: compId },
        { type: 'setTotal', field: 'subtotal', value: '28.03' },
        { type: 'setTotal', field: 'total', value: '25.43' },
      );
      const r = okArgs(edited, saved);
      expect(r.rows.map((x) => x.id)).toEqual(['r-steak', 'r-salad', 'r-coupon']);
      expect(r.removedClaimedIds).toEqual([]);
      expect(r.splitClaimedIds).toEqual([]);
    });

    it('Claim → Split → Claim keeps the saved id and lists nothing', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'updateDiscount', id: compId, patch: { claimable: false } },
        { type: 'updateDiscount', id: compId, patch: { claimable: true } },
      );
      const r = okArgs(edited, saved);
      expect(shape(r.rows)).toEqual(shape(RT_ROWS));
      expect(r.splitClaimedIds).toEqual([]);
      expect(r.removedClaimedIds).toEqual([]);
    });

    it('a changed amount, label or position keeps the id', () => {
      const { draft, saved, compId } = open();
      const edited = apply(
        draft,
        { type: 'updateDiscount', id: compId, patch: { label: 'Comp', amount: '10.00', appliesTo: 'total' } },
        { type: 'setTotal', field: 'subtotal', value: '28.03' },
        { type: 'setTotal', field: 'total', value: '15.43' }, // 28.03 + 2.40 − 10.00 − 5.00 (coupon)
      );
      expect(evaluateDraft(edited).status).toBe('adds_up');
      const r = okArgs(edited, saved);
      expect(r.rows.find((x) => x.id === 'r-comp')).toEqual({
        id: 'r-comp',
        name: 'Comp',
        note: null,
        group_position: 2,
        unit_index: 0,
        group_size: 1,
        total_cents: -1000,
        kind: 'discount',
        applies_to: 'total',
      });
      expect(r.splitClaimedIds).toEqual([]);
    });

    it('Split → Claim on a new discount gives a new row without an id', () => {
      const { draft, saved } = open([]);
      const splitId = draft.discounts[0]?.id ?? '';
      const r = okArgs(apply(draft, { type: 'updateDiscount', id: splitId, patch: { claimable: true } }), saved);
      expect(r.money.p_subtotal_discount_cents).toBe(0);
      const added = r.rows.filter((x) => x.id === undefined);
      expect(added).toEqual([
        { name: 'Discount', note: null, group_position: 2, unit_index: 0, group_size: 1, total_cents: -200, kind: 'discount', applies_to: 'subtotal' },
      ]);
      // Comp and coupon move after it (draft order).
      expect(r.rows.slice(3).map((x) => [x.id, x.group_position])).toEqual([
        ['r-comp', 3],
        ['r-coupon', 4],
      ]);
    });
  });
});
