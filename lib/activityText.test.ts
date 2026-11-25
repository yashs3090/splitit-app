import {
  type ActivityEvent,
  type NameOf,
  type TimeFormatters,
  describeEvent,
  groupEvents,
  timeLabel,
  timeLabelText,
} from './activityText';

const HANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const PAT = 'aaaaaaaa-0000-4000-8000-000000000002';
const SAM = 'aaaaaaaa-0000-4000-8000-000000000003';
const ALEX = 'aaaaaaaa-0000-4000-8000-000000000004';
const ALI = 'aaaaaaaa-0000-4000-8000-000000000005';
const NAMES: Record<string, string> = { [HANA]: 'Hana', [PAT]: 'Pat', [SAM]: 'Sam', [ALEX]: 'Alex', [ALI]: 'Ali' };

/** Viewer is not part of the bill: everyone reads by name. */
const nameOf: NameOf = (id) => (id === null ? 'Someone' : (NAMES[id] ?? 'Someone'));
/** The viewer reads as "You". */
const asViewer =
  (viewer: string): NameOf =>
  (id) =>
    id === viewer ? 'You' : nameOf(id);

let seq = 0;
function ev(kind: string, actorId: string | null, details: unknown, itemName: string | null = null): ActivityEvent {
  seq += 1;
  return { id: `e${seq}`, kind, actorId, itemName, details, createdAt: '2026-11-21T19:42:00.000Z' };
}

describe('describeEvent: example sentences (criterion 132)', () => {
  it.each<[string, ActivityEvent, string]>([
    ['bill_created', ev('bill_created', HANA, { items: 3, total_cents: 4480 }), 'Hana created the bill ($44.80, 3 items)'],
    ['bill_created, one item', ev('bill_created', HANA, { items: 1, total_cents: 900 }), 'Hana created the bill ($9.00, 1 item)'],
    ['joined', ev('joined', PAT, {}), 'Pat joined'],
    ['claimed, no unit', ev('claimed', PAT, { unit: null, split: null }, 'Burger'), 'Pat claimed Burger'],
    ['claimed, unit', ev('claimed', PAT, { unit: [0, 2], split: null }, 'Beer'), 'Pat claimed Beer (1 of 2)'],
    ['claimed, unit of size 1', ev('claimed', PAT, { unit: [0, 1], split: null }, 'Soda'), 'Pat claimed Soda'],
    [
      'claimed, custom split',
      ev('claimed', PAT, { unit: null, split: { [SAM]: 2, [ALEX]: 1, [PAT]: 1 } }, 'Nachos'),
      'Pat claimed Nachos. Nachos is now split Sam 2 parts, Alex 1 part, Pat 1 part.',
    ],
    ['unclaimed', ev('unclaimed', PAT, { unit: null, split: null }, 'Fries'), 'Pat removed their claim on Fries'],
    [
      'unclaimed, custom split remains',
      ev('unclaimed', ALEX, { unit: null, split: { [PAT]: 1, [SAM]: 2 } }, 'Nachos'),
      'Alex removed their claim on Nachos. Nachos is now split Sam 2 parts, Pat 1 part.',
    ],
    [
      'split_changed from even',
      ev('split_changed', SAM, { unit: null, before: { [SAM]: 1, [PAT]: 1 }, after: { [SAM]: 2, [PAT]: 1 } }, 'Nachos'),
      'Sam changed the Nachos split: Sam 2 parts, Pat 1 part (was even)',
    ],
    [
      'split_changed back to even',
      ev('split_changed', SAM, { unit: null, before: { [SAM]: 2, [PAT]: 1 }, after: { [SAM]: 1, [PAT]: 1 } }, 'Nachos'),
      'Sam set Nachos back to an even split',
    ],
    ['item_added', ev('item_added', HANA, { qty: 1, price_cents: 900 }, 'Wings'), 'Hana added Wings ($9.00)'],
    ['item_added qty 2', ev('item_added', HANA, { qty: 2, price_cents: 1400 }, 'Beer'), 'Hana added Beer ×2 ($14.00)'],
    [
      'item_removed',
      ev('item_removed', HANA, { qty: 1, price_cents: 300, claimer_ids: [PAT, SAM] }, 'Soda'),
      "Hana removed Soda (Pat's and Sam's claims were removed)",
    ],
    [
      'item_changed price',
      ev('item_changed', HANA, { price_cents: [1200, 1400] }, 'Burger'),
      'Hana changed Burger from $12.00 to $14.00',
    ],
    [
      'item_changed qty and price',
      ev('item_changed', HANA, { qty: [2, 3], price_cents: [1400, 2100] }, 'Beer'),
      'Hana changed Beer: quantity 2 → 3, price $14.00 → $21.00',
    ],
    [
      'amounts_changed',
      ev('amounts_changed', HANA, { tip_cents: [700, 900], total_cents: [4480, 4680] }),
      'Hana changed the tip from $7.00 to $9.00 and the total from $44.80 to $46.80',
    ],
    ['link_rotated', ev('link_rotated', HANA, {}), 'Hana made a new invite link. The old one no longer works.'],
    [
      'extras_split_changed to equal',
      ev('extras_split_changed', HANA, { before: 'proportional', after: 'equal' }),
      'Hana changed tax & tip to split evenly',
    ],
    [
      'extras_split_changed to proportional',
      ev('extras_split_changed', HANA, { before: 'equal', after: 'proportional' }),
      'Hana changed tax & tip to split proportionally',
    ],
  ])('%s', (_label, e, expected) => {
    expect(describeEvent(e, nameOf)).toBe(expected);
  });
});

describe('describeEvent: the viewer reads as "You"', () => {
  it.each<[string, ActivityEvent, string, string]>([
    ['claimed', ev('claimed', PAT, { unit: null, split: null }, 'Burger'), PAT, 'You claimed Burger'],
    ['unclaimed', ev('unclaimed', PAT, { unit: null, split: null }, 'Fries'), PAT, 'You removed your claim on Fries'],
    ['joined', ev('joined', PAT, {}), PAT, 'You joined'],
    [
      'custom split names the viewer',
      ev('claimed', PAT, { unit: null, split: { [HANA]: 2, [PAT]: 1 } }, 'Fries'),
      HANA,
      'Pat claimed Fries. Fries is now split You 2 parts, Pat 1 part.',
    ],
    [
      'removed item with the viewer as a claimer',
      ev('item_removed', HANA, { qty: 1, price_cents: 300, claimer_ids: [PAT] }, 'Soda'),
      PAT,
      'Hana removed Soda (your claim was removed)',
    ],
    [
      'extras split by the host',
      ev('extras_split_changed', HANA, { before: 'proportional', after: 'equal' }),
      HANA,
      'You changed tax & tip to split evenly',
    ],
    [
      'host price change',
      ev('item_changed', HANA, { price_cents: [1500, 1800] }, 'Burger'),
      HANA,
      'You changed Burger from $15.00 to $18.00',
    ],
  ])('%s', (_label, e, viewer, expected) => {
    expect(describeEvent(e, asViewer(viewer))).toBe(expected);
  });
});

describe('describeEvent: names and parts (criterion 133)', () => {
  const removed = (ids: string[]) =>
    describeEvent(ev('item_removed', HANA, { qty: 1, price_cents: 300, claimer_ids: ids }, 'Soda'), nameOf);

  it('lists one, two and three claimers', () => {
    expect(removed([PAT])).toBe("Hana removed Soda (Pat's claim was removed)");
    expect(removed([PAT, SAM])).toBe("Hana removed Soda (Pat's and Sam's claims were removed)");
    expect(removed([PAT, SAM, ALI])).toBe("Hana removed Soda (Pat's, Sam's and Ali's claims were removed)");
  });

  it('omits the claims note when nobody had claimed the item', () => {
    expect(removed([])).toBe('Hana removed Soda');
  });

  it('reads a null actor as "Someone", whatever nameOf says', () => {
    const loud: NameOf = () => 'Not this';
    expect(describeEvent(ev('claimed', null, { unit: null, split: null }, 'Burger'), loud)).toBe('Someone claimed Burger');
    expect(describeEvent(ev('joined', null, {}), nameOf)).toBe('Someone joined');
  });

  it('reads an unknown user id as "Someone"', () => {
    expect(describeEvent(ev('joined', 'bbbbbbbb-0000-4000-8000-000000000009', {}), nameOf)).toBe('Someone joined');
  });

  it('falls back to "Someone" when nameOf returns nothing usable or throws', () => {
    const blank: NameOf = () => '  ';
    const boom: NameOf = () => {
      throw new Error('boom');
    };
    expect(describeEvent(ev('joined', PAT, {}), blank)).toBe('Someone joined');
    expect(describeEvent(ev('joined', PAT, {}), boom)).toBe('Someone joined');
  });

  it('shows a short "before" split and omits a long one', () => {
    const short = ev(
      'split_changed',
      SAM,
      { unit: [1, 2], before: { [SAM]: 3, [PAT]: 1 }, after: { [SAM]: 2, [PAT]: 1 } },
      'Beer',
    );
    expect(describeEvent(short, nameOf)).toBe(
      'Sam changed the Beer (2 of 2) split: Sam 2 parts, Pat 1 part (was Sam 3 parts, Pat 1 part)',
    );
    const before4 = { [SAM]: 2, [PAT]: 1, [ALEX]: 1, [ALI]: 1 };
    const after4 = { [SAM]: 3, [PAT]: 1, [ALEX]: 1, [ALI]: 1 };
    const long = ev('split_changed', SAM, { unit: null, before: before4, after: after4 }, 'Nachos');
    expect(describeEvent(long, nameOf)).toBe(
      'Sam changed the Nachos split: Sam 3 parts, Alex 1 part, Ali 1 part, Pat 1 part',
    );
  });

  it('treats after-parts that are all equal (not only all 1) as an even split', () => {
    const e = ev('split_changed', PAT, { unit: null, before: { [SAM]: 2, [PAT]: 1 }, after: { [SAM]: 2, [PAT]: 2 } }, 'Nachos');
    expect(describeEvent(e, asViewer(PAT))).toBe('You set Nachos back to an even split');
  });

  it('orders split entries by parts, then by name, independent of key order', () => {
    const a = ev('claimed', PAT, { unit: null, split: { [PAT]: 1, [ALEX]: 1, [SAM]: 2 } }, 'Nachos');
    const b = ev('claimed', PAT, { unit: null, split: { [SAM]: 2, [PAT]: 1, [ALEX]: 1 } }, 'Nachos');
    expect(describeEvent(a, nameOf)).toBe(describeEvent(b, nameOf));
  });

  it('drops an all-equal split suffix from claim events', () => {
    const e = ev('claimed', PAT, { unit: null, split: { [SAM]: 1, [PAT]: 1 } }, 'Fries');
    expect(describeEvent(e, nameOf)).toBe('Pat claimed Fries');
  });
});

describe('describeEvent: item_changed and amounts_changed wording', () => {
  it.each<[string, Record<string, unknown>, string, string]>([
    ['rename only', { name: ['Fries', 'Chips'] }, 'Chips', 'Hana renamed Fries to Chips'],
    ['qty only', { qty: [2, 1] }, 'Beer', 'Hana changed Beer: quantity 2 → 1'],
    ['note only', { note_changed: true }, 'Burger', 'Hana changed the note on Burger'],
    [
      'everything',
      { name: ['Beer', 'Lager'], qty: [2, 3], price_cents: [1400, 2100], note_changed: true },
      'Lager',
      'Hana changed Lager: name Beer → Lager, quantity 2 → 3, price $14.00 → $21.00, note updated',
    ],
  ])('%s', (_label, details, itemName, expected) => {
    expect(describeEvent(ev('item_changed', HANA, details, itemName), nameOf)).toBe(expected);
  });

  it('notes claims a quantity drop removed (removed_claimer_ids), like item_removed', () => {
    const qtyDrop = (ids: unknown) => ev('item_changed', HANA, { qty: [2, 1], removed_claimer_ids: ids }, 'Beer');
    expect(describeEvent(qtyDrop([PAT]), nameOf)).toBe("Hana changed Beer: quantity 2 → 1 (Pat's claim was removed)");
    expect(describeEvent(qtyDrop([PAT]), asViewer(PAT))).toBe('Hana changed Beer: quantity 2 → 1 (your claim was removed)');
    expect(describeEvent(qtyDrop([PAT, SAM]), nameOf)).toBe(
      "Hana changed Beer: quantity 2 → 1 (Pat's and Sam's claims were removed)",
    );
    // Missing or empty: no note.
    expect(describeEvent(qtyDrop([]), nameOf)).toBe('Hana changed Beer: quantity 2 → 1');
    expect(describeEvent(ev('item_changed', HANA, { qty: [2, 1] }, 'Beer'), nameOf)).toBe('Hana changed Beer: quantity 2 → 1');
    // Combined with a price change, the note still goes at the end.
    expect(
      describeEvent(ev('item_changed', HANA, { qty: [3, 1], price_cents: [2100, 700], removed_claimer_ids: [SAM] }, 'Beer'), nameOf),
    ).toBe("Hana changed Beer: quantity 3 → 1, price $21.00 → $7.00 (Sam's claim was removed)");
    // Malformed: skipped, like item_removed's claimer_ids.
    expect(describeEvent(qtyDrop([1]), nameOf)).toBeNull();
    expect(describeEvent(qtyDrop(PAT), nameOf)).toBeNull();
    expect(describeEvent(qtyDrop(null), nameOf)).toBeNull();
  });

  it('lists every changed amount in a fixed order', () => {
    const e = ev('amounts_changed', HANA, {
      total_cents: [4480, 4380],
      discount_cents: [0, 500],
      tax_cents: [300, 400],
      fees_cents: [0, 100],
      tip_cents: [700, 700],
    });
    expect(describeEvent(e, nameOf)).toBe(
      'Hana changed the tax from $3.00 to $4.00, the fees from $0.00 to $1.00, the tip from $7.00 to $7.00, ' +
        'the discount from $0.00 to $5.00 and the total from $44.80 to $43.80',
    );
  });

  it('reads the positional discounts (A3): a discount that only moved still renders', () => {
    expect(
      describeEvent(ev('amounts_changed', HANA, { subtotal_discount_cents: [500, 300] }), nameOf),
    ).toBe('Hana changed the discount before the subtotal from $5.00 to $3.00');
    expect(describeEvent(ev('amounts_changed', HANA, { total_discount_cents: [0, 250] }), nameOf)).toBe(
      'Hana changed the discount on the total from $0.00 to $2.50',
    );
    expect(
      describeEvent(
        ev('amounts_changed', HANA, {
          total_cents: [4480, 4280],
          total_discount_cents: [0, 200],
          subtotal_discount_cents: [500, 0],
          tip_cents: [700, 900],
        }),
        asViewer(HANA),
      ),
    ).toBe(
      'You changed the tip from $7.00 to $9.00, the discount before the subtotal from $5.00 to $0.00, ' +
        'the discount on the total from $0.00 to $2.00 and the total from $44.80 to $42.80',
    );
  });

  it('rejects malformed positional discounts', () => {
    expect(describeEvent(ev('amounts_changed', HANA, { subtotal_discount_cents: [5.5, 3] }), nameOf)).toBeNull();
    expect(describeEvent(ev('amounts_changed', HANA, { total_discount_cents: ['0', 200] }), nameOf)).toBeNull();
    expect(
      describeEvent(ev('amounts_changed', HANA, { tip_cents: [1, 2], total_discount_cents: [1] }), nameOf),
    ).toBeNull();
  });

  it('describes the exact amounts_changed shape the DB writes (positional discounts only), each change once', () => {
    // What update_bill logs after the DB fix: no legacy `discount_cents` key.
    const details = {
      tax_cents: [280, 300],
      fees_cents: [0, 150],
      tip_cents: [700, 800],
      subtotal_discount_cents: [0, 400],
      total_discount_cents: [250, 0],
      total_cents: [4480, 4900],
    };
    const text = describeEvent(ev('amounts_changed', HANA, details), nameOf);
    expect(text).toBe(
      'Hana changed the tax from $2.80 to $3.00, the fees from $0.00 to $1.50, the tip from $7.00 to $8.00, ' +
        'the discount before the subtotal from $0.00 to $4.00, the discount on the total from $2.50 to $0.00 ' +
        'and the total from $44.80 to $49.00',
    );
    // Each change appears exactly once (", the total from" is not inside "on the total from").
    for (const label of ['the tax', 'the fees', 'the tip', 'the discount before the subtotal', 'the discount on the total', 'and the total']) {
      expect(text?.split(`${label} from `)).toHaveLength(2);
    }
    expect(text?.match(/ from \$/g)).toHaveLength(6);
    // The legacy single-discount wording never appears for this shape.
    expect(text).not.toMatch(/the discount from/);
  });

  it('ignores unknown amount keys but needs at least one known one', () => {
    expect(describeEvent(ev('amounts_changed', HANA, { tip_cents: [1, 2], other: 'x' }), nameOf)).toBe(
      'Hana changed the tip from $0.01 to $0.02',
    );
    expect(describeEvent(ev('amounts_changed', HANA, { other: [1, 2] }), nameOf)).toBeNull();
  });
});

describe('describeEvent: malformed input (criterion 134)', () => {
  it.each<[string, ActivityEvent]>([
    ['unknown kind', ev('confetti', HANA, {})],
    ['empty kind', ev('', HANA, {})],
    ['null details', ev('joined', HANA, null)],
    ['string details', ev('joined', HANA, 'hi')],
    ['array details', ev('joined', HANA, [])],
    ['price_cents 12.5', ev('item_added', HANA, { qty: 1, price_cents: 12.5 }, 'Wings')],
    ['price_cents "1200"', ev('item_added', HANA, { qty: 1, price_cents: '1200' }, 'Wings')],
    ['changed price_cents "1200"', ev('item_changed', HANA, { price_cents: ['1200', 1400] }, 'Burger')],
    ['changed price 12.5', ev('item_changed', HANA, { price_cents: [1200, 12.5] }, 'Burger')],
    ['changed nothing', ev('item_changed', HANA, {}, 'Burger')],
    ['total_cents 44.8', ev('bill_created', HANA, { items: 3, total_cents: 44.8 })],
    ['items missing', ev('bill_created', HANA, { total_cents: 4480 })],
    ['unit string', ev('claimed', PAT, { unit: '1 of 2', split: null }, 'Beer')],
    ['unit with 3 numbers', ev('claimed', PAT, { unit: [0, 2, 3], split: null }, 'Beer')],
    ['unit with 1 number', ev('claimed', PAT, { unit: [0], split: null }, 'Beer')],
    ['unit with strings', ev('claimed', PAT, { unit: ['0', '2'], split: null }, 'Beer')],
    ['unit index out of range', ev('claimed', PAT, { unit: [2, 2], split: null }, 'Beer')],
    ['unit fractional', ev('claimed', PAT, { unit: [0.5, 2], split: null }, 'Beer')],
    ['missing item_name on claimed', ev('claimed', PAT, { unit: null, split: null }, null)],
    ['blank item_name on unclaimed', ev('unclaimed', PAT, { unit: null, split: null }, '   ')],
    ['missing item_name on item_added', ev('item_added', HANA, { qty: 1, price_cents: 900 }, null)],
    ['missing item_name on item_removed', ev('item_removed', HANA, { qty: 1, price_cents: 900, claimer_ids: [] }, null)],
    ['missing item_name on item_changed', ev('item_changed', HANA, { price_cents: [1, 2] }, null)],
    ['missing item_name on split_changed', ev('split_changed', SAM, { unit: null, before: {}, after: { [SAM]: 1 } }, null)],
    ['split parts 1.5', ev('claimed', PAT, { unit: null, split: { [SAM]: 1.5, [PAT]: 1 } }, 'Nachos')],
    ['split parts 0', ev('claimed', PAT, { unit: null, split: { [SAM]: 0, [PAT]: 1 } }, 'Nachos')],
    ['split as array', ev('claimed', PAT, { unit: null, split: [1, 2] }, 'Nachos')],
    ['split_changed empty after', ev('split_changed', SAM, { unit: null, before: {}, after: {} }, 'Nachos')],
    ['split_changed missing before', ev('split_changed', SAM, { unit: null, after: { [SAM]: 1 } }, 'Nachos')],
    ['claimer_ids not strings', ev('item_removed', HANA, { qty: 1, price_cents: 300, claimer_ids: [1, 2] }, 'Soda')],
    ['claimer_ids missing', ev('item_removed', HANA, { qty: 1, price_cents: 300 }, 'Soda')],
    ['qty 0', ev('item_added', HANA, { qty: 0, price_cents: 900 }, 'Wings')],
    ['extras mode unknown', ev('extras_split_changed', HANA, { before: 'proportional', after: 'random' })],
    ['amount pair of 3', ev('amounts_changed', HANA, { tip_cents: [1, 2, 3] })],
    ['note_changed not true', ev('item_changed', HANA, { note_changed: 'yes' }, 'Burger')],
    ['name pair with a number', ev('item_changed', HANA, { name: ['Fries', 7] }, 'Fries')],
  ])('%s → null', (_label, e) => {
    expect(describeEvent(e, nameOf)).toBeNull();
  });

  it('survives a whole event of the wrong shape', () => {
    const junk = [null, undefined, 42, 'x', [], { kind: 1 }, { kind: 'joined', actorId: 5, details: {} }];
    for (const j of junk) {
      expect(() => describeEvent(j as unknown as ActivityEvent, nameOf)).not.toThrow();
      expect(describeEvent(j as unknown as ActivityEvent, nameOf)).toBeNull();
    }
  });

  it('never throws and never prints junk over 200 seeded random details values', () => {
    const rand = mulberry32(20261121);
    const kinds = [
      'bill_created', 'joined', 'claimed', 'unclaimed', 'split_changed', 'item_added', 'item_removed',
      'item_changed', 'amounts_changed', 'link_rotated', 'extras_split_changed', 'nope',
    ];
    const keys = [
      'items', 'total_cents', 'unit', 'split', 'before', 'after', 'qty', 'price_cents', 'claimer_ids', 'name',
      'note_changed', 'tax_cents', 'fees_cents', 'tip_cents', 'discount_cents', 'subtotal_discount_cents',
      'total_discount_cents', '__proto__', 'toString',
    ];
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const randomValue = (depth: number): unknown => {
      const r = rand();
      if (r < 0.1) return null;
      if (r < 0.2) return undefined;
      if (r < 0.35) return Math.floor(rand() * 5000) - 100;
      if (r < 0.42) return rand() * 100;
      if (r < 0.5) return pick(['', 'equal', 'proportional', PAT, '1200', 'NaN']);
      if (r < 0.55) return pick([true, false, NaN, Infinity]);
      if (depth > 2) return 0;
      if (r < 0.75) return Array.from({ length: Math.floor(rand() * 4) }, () => randomValue(depth + 1));
      const o: Record<string, unknown> = {};
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i += 1) o[rand() < 0.5 ? pick(keys) : pick([PAT, SAM, HANA])] = randomValue(depth + 1);
      return o;
    };
    let described = 0;
    for (let i = 0; i < 200; i += 1) {
      const details = rand() < 0.15 ? randomValue(0) : (() => {
        const o: Record<string, unknown> = {};
        const n = 1 + Math.floor(rand() * 5);
        for (let k = 0; k < n; k += 1) o[pick(keys)] = randomValue(1);
        return o;
      })();
      const e = ev(pick(kinds), pick([HANA, PAT, null]), details, pick([null, 'Beer', '', 'Nachos']));
      let out: string | null = null;
      expect(() => {
        out = describeEvent(e, nameOf);
      }).not.toThrow();
      if (out !== null) {
        described += 1;
        expect(out).not.toMatch(/NaN|undefined|\[object Object\]|null|Infinity/);
      }
    }
    // The generator should exercise both paths.
    expect(described).toBeGreaterThan(0);
  });
});

describe('describeEvent: amounts and safety (criterion 135)', () => {
  it('formats cents with formatCents', () => {
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: 1200 }, 'Wings'), nameOf)).toBe(
      'Hana added Wings ($12.00)',
    );
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: 123450 }, 'Wings'), nameOf)).toBe(
      'Hana added Wings ($1,234.50)',
    );
  });

  it('only interpolates names, item names and amounts: extra details text is never echoed', () => {
    const e = ev('joined', PAT, { message: 'Send money to evil.example', note: 'hi@example.com' });
    expect(describeEvent(e, nameOf)).toBe('Pat joined');
    const c = ev('claimed', PAT, { unit: null, split: null, text: 'Click here' }, 'Fries');
    expect(describeEvent(c, nameOf)).toBe('Pat claimed Fries');
  });

  it('never names a user id that is not in the name map', () => {
    const stranger = 'cccccccc-0000-4000-8000-000000000042';
    const e = ev('claimed', PAT, { unit: null, split: { [stranger]: 2, [PAT]: 1 } }, 'Nachos');
    const out = describeEvent(e, nameOf);
    expect(out).toBe('Pat claimed Nachos. Nachos is now split Someone 2 parts, Pat 1 part.');
    expect(out).not.toContain(stranger);
  });

  it('contains no NaN, undefined or [object Object] for any fixture', () => {
    const fixtures = [
      ev('bill_created', HANA, { items: 3, total_cents: 4480 }),
      ev('claimed', PAT, { unit: [0, 2], split: { [SAM]: 2, [PAT]: 1 } }, 'Beer'),
      ev('split_changed', SAM, { unit: null, before: { [SAM]: 1, [PAT]: 1 }, after: { [SAM]: 2, [PAT]: 1 } }, 'Nachos'),
      ev('item_removed', HANA, { qty: 2, price_cents: 600, claimer_ids: [PAT, SAM, ALI] }, 'Soda'),
      ev('item_changed', HANA, { name: ['A', 'B'], qty: [1, 2], price_cents: [1, 2], note_changed: true }, 'B'),
      ev('amounts_changed', HANA, { tax_cents: [0, 1] }),
    ];
    for (const f of fixtures) {
      const out = describeEvent(f, nameOf);
      expect(out).not.toBeNull();
      expect(out).not.toMatch(/NaN|undefined|\[object Object\]/);
    }
  });
});

describe('timeLabel (criterion 136)', () => {
  // Local-time construction so the test holds in any time zone.
  const now = new Date(2026, 10, 21, 19, 42, 30);
  const fmt: TimeFormatters = {
    time: (d) => `T${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    date: (d) => `D${d.getMonth() + 1}/${d.getDate()}`,
  };
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('is "just now" under 2 minutes', () => {
    expect(timeLabel(ago(30_000), now, fmt)).toEqual({ kind: 'just_now' });
    expect(timeLabel(ago(119_000), now, fmt)).toEqual({ kind: 'just_now' });
  });

  it('treats a slightly future time (clock skew) as "just now"', () => {
    expect(timeLabel(ago(-60_000), now, fmt)).toEqual({ kind: 'just_now' });
  });

  it('is the time of day earlier the same day', () => {
    expect(timeLabel(ago(3 * 3600_000), now, fmt)).toEqual({ kind: 'today', text: 'T16:42' });
    expect(timeLabel(ago(2 * 60_000), now, fmt)).toEqual({ kind: 'today', text: 'T19:40' });
  });

  it('is "Yesterday" for the previous calendar day', () => {
    expect(timeLabel(new Date(2026, 10, 20, 23, 59).toISOString(), now, fmt)).toEqual({ kind: 'yesterday' });
    expect(timeLabel(new Date(2026, 10, 20, 0, 1).toISOString(), now, fmt)).toEqual({ kind: 'yesterday' });
  });

  it('is a date for anything older', () => {
    expect(timeLabel(new Date(2026, 10, 16, 12, 0).toISOString(), now, fmt)).toEqual({ kind: 'date', text: 'D11/16' });
    expect(timeLabel(new Date(2026, 10, 19, 23, 59).toISOString(), now, fmt)).toEqual({ kind: 'date', text: 'D11/19' });
  });

  it('handles the previous day across a month boundary', () => {
    const firstOfMonth = new Date(2026, 11, 1, 9, 0);
    expect(timeLabel(new Date(2026, 10, 30, 22, 0).toISOString(), firstOfMonth, fmt)).toEqual({ kind: 'yesterday' });
  });

  it('gives an empty date label for an unparseable timestamp', () => {
    expect(timeLabel('not a date', now, fmt)).toEqual({ kind: 'date', text: '' });
  });

  it('has fixed header text', () => {
    expect(timeLabelText({ kind: 'just_now' })).toBe('Just now');
    expect(timeLabelText({ kind: 'yesterday' })).toBe('Yesterday');
    expect(timeLabelText({ kind: 'today', text: '7:42 PM' })).toBe('7:42 PM');
    expect(timeLabelText({ kind: 'date', text: 'Nov 18' })).toBe('Nov 18');
  });
});

describe('groupEvents (criterion 136)', () => {
  const now = new Date(2026, 10, 21, 19, 42, 30);
  const fmt: TimeFormatters = {
    time: (d) => `T${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
    date: (d) => `D${d.getMonth() + 1}/${d.getDate()}`,
  };
  const at = (id: string, d: Date): ActivityEvent => ({
    id, kind: 'joined', actorId: PAT, itemName: null, details: {}, createdAt: d.toISOString(),
  });

  it('returns groups newest first and keeps each group together, whatever the input order', () => {
    const events = [
      at('old', new Date(2026, 10, 16, 12, 0)),
      at('now1', new Date(now.getTime() - 10_000)),
      at('y1', new Date(2026, 10, 20, 9, 0)),
      at('today1', new Date(2026, 10, 21, 16, 42, 5)),
      at('now2', new Date(now.getTime() - 50_000)),
      at('y2', new Date(2026, 10, 20, 21, 0)),
      at('today2', new Date(2026, 10, 21, 16, 42, 40)),
    ];
    const groups = groupEvents(events, now, fmt);
    expect(groups.map((g) => g.label)).toEqual([
      { kind: 'just_now' },
      { kind: 'today', text: 'T16:42' },
      { kind: 'yesterday' },
      { kind: 'date', text: 'D11/16' },
    ]);
    expect(groups.map((g) => g.events.map((e) => e.id))).toEqual([
      ['now1', 'now2'],
      ['today2', 'today1'],
      ['y2', 'y1'],
      ['old'],
    ]);
  });

  it('skips events with unparseable timestamps and does not mutate the input', () => {
    const events = [at('a', new Date(now.getTime() - 1000)), { ...at('bad', now), createdAt: 'nope' }];
    const copy = events.map((e) => e.id);
    const groups = groupEvents(events, now, fmt);
    expect(groups).toEqual([{ label: { kind: 'just_now' }, events: [events[0]] }]);
    expect(events.map((e) => e.id)).toEqual(copy);
  });

  it('returns an empty list for no events', () => {
    expect(groupEvents([], now, fmt)).toEqual([]);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// M3 settling events (spec docs/specs/2026-11-24-m3-settle-venmo.md § C4, criterion 41).

describe('describeEvent: settling sentences (criterion 41)', () => {
  it.each<[string, ActivityEvent, string]>([
    [
      'payer_changed, nothing cleared',
      ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: 0 }),
      'Hana changed who gets paid to Sam',
    ],
    [
      'payer_changed, 1 mark cleared',
      ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: 1 }),
      "Hana changed who gets paid to Sam and cleared 1 'I paid' mark",
    ],
    [
      'payer_changed, 2 marks cleared',
      ev('payer_changed', HANA, { before: SAM, after: PAT, cleared: 2 }),
      "Hana changed who gets paid to Pat and cleared 2 'I paid' marks",
    ],
    [
      'payer_changed by an account deletion (null actor)',
      ev('payer_changed', null, { before: SAM, after: HANA, cleared: 3 }),
      "Who gets paid changed back to Hana (an account was deleted) and cleared 3 'I paid' marks",
    ],
    [
      'payer_changed by an account deletion, nothing cleared',
      ev('payer_changed', null, { before: SAM, after: HANA, cleared: 0 }),
      'Who gets paid changed back to Hana (an account was deleted)',
    ],
    [
      'payer_changed to the actor themself (R3)',
      ev('payer_changed', HANA, { before: SAM, after: HANA, cleared: 1 }),
      "Hana changed who gets paid to themselves and cleared 1 'I paid' mark",
    ],
    [
      'payer_changed to a deleted or unknown user',
      ev('payer_changed', HANA, { before: HANA, after: 'bbbbbbbb-0000-4000-8000-000000000009', cleared: 0 }),
      'Hana changed who gets paid to Someone',
    ],
    ['marked_paid', ev('marked_paid', SAM, { payer_id: HANA, cents: 1510 }), 'Sam marked that they paid Hana $15.10'],
    ['marked_paid, 1 cent', ev('marked_paid', SAM, { payer_id: HANA, cents: 1 }), 'Sam marked that they paid Hana $0.01'],
    [
      'marked_paid, the C2 maximum',
      ev('marked_paid', SAM, { payer_id: HANA, cents: 99_999_999 }),
      'Sam marked that they paid Hana $999,999.99',
    ],
    ['unmarked_paid by the person', ev('unmarked_paid', SAM, { user_id: SAM, cents: 1510 }), "Sam undid their 'I paid'"],
    [
      'unmarked_paid by someone else',
      ev('unmarked_paid', HANA, { user_id: SAM, cents: 1510 }),
      "Hana undid Sam's 'I paid' ($15.10)",
    ],
    [
      'unmarked_paid with a null actor',
      ev('unmarked_paid', null, { user_id: SAM, cents: 1510 }),
      "Someone undid Sam's 'I paid' ($15.10)",
    ],
  ])('%s', (_label, event, expected) => {
    expect(describeEvent(event, nameOf)).toBe(expected);
  });

  it('R3: the viewer setting themself as the payer reads "to yourself"; a deletion back to the viewer reads "you"', () => {
    const asHana = asViewer(HANA);
    expect(describeEvent(ev('payer_changed', HANA, { before: SAM, after: HANA, cleared: 0 }), asHana)).toBe(
      'You changed who gets paid to yourself',
    );
    expect(describeEvent(ev('payer_changed', null, { before: SAM, after: HANA, cleared: 0 }), asHana)).toBe(
      'Who gets paid changed back to you (an account was deleted)',
    );
  });

  it('reads the viewer as "You" / "you" in every position', () => {
    const asHana = asViewer(HANA);
    const asSam = asViewer(SAM);
    expect(describeEvent(ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: 2 }), asHana)).toBe(
      "You changed who gets paid to Sam and cleared 2 'I paid' marks",
    );
    expect(describeEvent(ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: 0 }), asSam)).toBe(
      'Hana changed who gets paid to you',
    );
    expect(describeEvent(ev('marked_paid', SAM, { payer_id: HANA, cents: 1510 }), asSam)).toBe(
      'You marked that you paid Hana $15.10',
    );
    expect(describeEvent(ev('marked_paid', SAM, { payer_id: HANA, cents: 1510 }), asHana)).toBe(
      'Sam marked that they paid you $15.10',
    );
    expect(describeEvent(ev('unmarked_paid', SAM, { user_id: SAM, cents: 1510 }), asSam)).toBe("You undid your 'I paid'");
    expect(describeEvent(ev('unmarked_paid', HANA, { user_id: SAM, cents: 1510 }), asHana)).toBe(
      "You undid Sam's 'I paid' ($15.10)",
    );
    expect(describeEvent(ev('unmarked_paid', HANA, { user_id: SAM, cents: 1510 }), asSam)).toBe(
      "Hana undid your 'I paid' ($15.10)",
    );
  });

  it('never shows ids or anything else from details', () => {
    const out = describeEvent(ev('marked_paid', SAM, { payer_id: HANA, cents: 1510, note: 'Dinner at Lupa' }), nameOf);
    expect(out).toBe('Sam marked that they paid Hana $15.10');
    expect(out).not.toContain(HANA);
  });

  it.each<[string, ActivityEvent]>([
    ['payer_changed without before', ev('payer_changed', HANA, { after: SAM, cleared: 0 })],
    ['payer_changed without after', ev('payer_changed', HANA, { before: HANA, cleared: 0 })],
    ['payer_changed with a non-uuid after', ev('payer_changed', HANA, { before: HANA, after: 'Sam', cleared: 0 })],
    ['payer_changed with a non-uuid before', ev('payer_changed', HANA, { before: 7, after: SAM, cleared: 0 })],
    ['payer_changed without cleared', ev('payer_changed', HANA, { before: HANA, after: SAM })],
    ['payer_changed with negative cleared', ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: -1 })],
    ['payer_changed with fractional cleared', ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: 1.5 })],
    ['payer_changed with string cleared', ev('payer_changed', HANA, { before: HANA, after: SAM, cleared: '2' })],
    ['marked_paid without payer_id', ev('marked_paid', SAM, { cents: 1510 })],
    ['marked_paid with a non-uuid payer_id', ev('marked_paid', SAM, { payer_id: 'hana', cents: 1510 })],
    ['marked_paid without cents', ev('marked_paid', SAM, { payer_id: HANA })],
    ['marked_paid with fractional cents', ev('marked_paid', SAM, { payer_id: HANA, cents: 15.1 })],
    ['marked_paid with string cents', ev('marked_paid', SAM, { payer_id: HANA, cents: '1510' })],
    ['marked_paid with 0 cents (outside C2)', ev('marked_paid', SAM, { payer_id: HANA, cents: 0 })],
    ['marked_paid with negative cents', ev('marked_paid', SAM, { payer_id: HANA, cents: -5 })],
    ['marked_paid with cents above C2', ev('marked_paid', SAM, { payer_id: HANA, cents: 100_000_000 })],
    ['unmarked_paid without user_id', ev('unmarked_paid', HANA, { cents: 1510 })],
    ['unmarked_paid with a non-uuid user_id', ev('unmarked_paid', HANA, { user_id: null, cents: 1510 })],
    ['unmarked_paid without cents', ev('unmarked_paid', HANA, { user_id: SAM })],
    ['unmarked_paid with fractional cents', ev('unmarked_paid', SAM, { user_id: SAM, cents: 0.5 })],
    ['details not an object', ev('marked_paid', SAM, [HANA, 1510])],
  ])('returns null for malformed details: %s', (_label, event) => {
    expect(describeEvent(event, nameOf)).toBeNull();
  });

  it("still rejects an unknown kind such as 'paid'", () => {
    expect(describeEvent(ev('paid', SAM, { payer_id: HANA, cents: 1510 }), nameOf)).toBeNull();
  });
});

// docs/specs/2026-11-24-people-and-invites.md § D3 Activity events (criterion 32). Details hold ids only.
describe('describeEvent: membership (participant_added, participant_removed, left)', () => {
  const GONE = 'bbbbbbbb-0000-4000-8000-0000000000ff'; // no longer on the bill: nameOf says "Someone"

  it.each<[string, ActivityEvent, NameOf, string]>([
    ['added, about another person', ev('participant_added', HANA, { user_id: SAM }), nameOf, 'Hana added Sam'],
    ['added, about the viewer', ev('participant_added', HANA, { user_id: SAM }), asViewer(SAM), 'Hana added you'],
    ['added, by the viewer', ev('participant_added', HANA, { user_id: SAM }), asViewer(HANA), 'You added Sam'],
    ['added, someone not on the bill', ev('participant_added', HANA, { user_id: GONE }), nameOf, 'Hana added someone'],
    ['added, by someone gone', ev('participant_added', GONE, { user_id: SAM }), nameOf, 'Someone added Sam'],
    ['removed, still readable', ev('participant_removed', HANA, { user_id: SAM }), nameOf, 'Hana removed Sam'],
    ['removed, off the bill (PI-17)', ev('participant_removed', HANA, { user_id: GONE }), nameOf, 'Hana removed someone'],
    [
      'removed by the viewer, off the bill',
      ev('participant_removed', HANA, { user_id: GONE }),
      asViewer(HANA),
      'You removed someone',
    ],
    ['removed, the viewer', ev('participant_removed', HANA, { user_id: SAM }), asViewer(SAM), 'Hana removed you'],
    ['left, still readable', ev('left', SAM, {}), nameOf, 'Sam left'],
    ['left, an ex-participant (PI-17)', ev('left', GONE, {}), nameOf, 'Someone left'],
    ['left, the viewer', ev('left', SAM, {}), asViewer(SAM), 'You left'],
    ['left, a null actor', ev('left', null, {}), nameOf, 'Someone left'],
  ])('%s', (_label, event, names, expected) => {
    expect(describeEvent(event, names)).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['missing user_id', {}],
    ['null user_id', { user_id: null }],
    ['a non-uuid user_id', { user_id: 'sam' }],
    ['a numeric user_id', { user_id: 7 }],
    ['details that are not an object', [SAM]],
  ])('participant_added / participant_removed with %s → null', (_label, details) => {
    expect(describeEvent(ev('participant_added', HANA, details), nameOf)).toBeNull();
    expect(describeEvent(ev('participant_removed', HANA, details), nameOf)).toBeNull();
  });

  it('left with details that are not an object → null', () => {
    expect(describeEvent(ev('left', SAM, null), nameOf)).toBeNull();
    expect(describeEvent(ev('left', SAM, 'x'), nameOf)).toBeNull();
  });

  it('a participant with no display name reads "a friend" mid-sentence', () => {
    const noName: NameOf = (id) => (id === SAM ? 'A friend' : nameOf(id));
    expect(describeEvent(ev('participant_added', HANA, { user_id: SAM }), noName)).toBe('Hana added a friend');
    expect(describeEvent(ev('left', SAM, {}), noName)).toBe('A friend left');
  });

  it('never shows text from details, only names from nameOf', () => {
    const out = describeEvent(ev('participant_added', HANA, { user_id: SAM, name: 'Evil <b>' }), nameOf);
    expect(out).toBe('Hana added Sam');
  });
});

// Claimable discounts (spec 2026-11-24-claimable-discounts.md, criterion 40): update_bill marks a
// discount row's item_added / item_removed / item_changed with `discount: true`.
describe('describeEvent: claimable discount rows', () => {
  const added = ev('item_added', HANA, { qty: 1, price_cents: -1603, discount: true }, 'Police comp');
  const removed = (ids: string[]) =>
    ev('item_removed', HANA, { qty: 1, price_cents: -1603, claimer_ids: ids, discount: true }, 'Police comp');
  const changed = ev('item_changed', HANA, { price_cents: [-1603, -1000], discount: true }, 'Police comp');

  it.each<[string, ActivityEvent, string, string]>([
    ['added', added, 'Hana added the discount Police comp (-$16.03)', 'You added the discount Police comp (-$16.03)'],
    ['removed', removed([]), 'Hana removed the discount Police comp', 'You removed the discount Police comp'],
    [
      'removed with claims',
      removed([PAT]),
      "Hana removed the discount Police comp (Pat's claim was removed)",
      "You removed the discount Police comp (Pat's claim was removed)",
    ],
    [
      'changed amount',
      changed,
      'Hana changed the discount Police comp from -$16.03 to -$10.00',
      'You changed the discount Police comp from -$16.03 to -$10.00',
    ],
    [
      'renamed',
      ev('item_changed', HANA, { name: ['Comp', 'Police comp'], discount: true }, 'Police comp'),
      'Hana renamed the discount Comp to Police comp',
      'You renamed the discount Comp to Police comp',
    ],
    [
      'renamed and amount changed',
      ev('item_changed', HANA, { name: ['Comp', 'Police comp'], price_cents: [-1603, -1000], discount: true }, 'Police comp'),
      'Hana changed the discount Police comp: name Comp → Police comp, price -$16.03 → -$10.00',
      'You changed the discount Police comp: name Comp → Police comp, price -$16.03 → -$10.00',
    ],
  ])('%s, read by someone else and by the actor', (_label, e, other, own) => {
    expect(describeEvent(e, nameOf)).toBe(other);
    expect(describeEvent(e, asViewer(HANA))).toBe(own);
  });

  it("tells the viewer when their claim on the discount went", () => {
    expect(describeEvent(removed([PAT]), asViewer(PAT))).toBe('Hana removed the discount Police comp (your claim was removed)');
  });

  it('reads events without the key exactly as items', () => {
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: 900 }, 'Wings'), nameOf)).toBe('Hana added Wings ($9.00)');
  });

  it('leaves claim events on a discount row as they are', () => {
    expect(describeEvent(ev('claimed', SAM, { unit: null, split: null }, 'Police comp'), nameOf)).toBe('Sam claimed Police comp');
  });

  it.each<[string, unknown]>([
    ['false', false],
    ['null', null],
    ['"true"', 'true'],
    ['1', 1],
    ['an object', {}],
  ])('treats discount: %s as malformed (null)', (_label, flag) => {
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: -1603, discount: flag }, 'Police comp'), nameOf)).toBeNull();
    expect(
      describeEvent(ev('item_removed', HANA, { qty: 1, price_cents: -1603, claimer_ids: [], discount: flag }, 'Police comp'), nameOf),
    ).toBeNull();
    expect(
      describeEvent(ev('item_changed', HANA, { price_cents: [-1603, -1000], discount: flag }, 'Police comp'), nameOf),
    ).toBeNull();
  });

  it('treats a discount added with a quantity above 1 as malformed (discount rows are single rows)', () => {
    expect(describeEvent(ev('item_added', HANA, { qty: 2, price_cents: -1603, discount: true }, 'Police comp'), nameOf)).toBeNull();
  });

  it('still needs the item name and valid cents', () => {
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: -1603, discount: true }, null), nameOf)).toBeNull();
    expect(describeEvent(ev('item_added', HANA, { qty: 1, price_cents: -16.03, discount: true }, 'Police comp'), nameOf)).toBeNull();
  });
});

// docs/specs/2026-11-25-settle-early-and-differences.md § D8 (criterion 25). Details hold ids and cents
// only; the amount shown is |to − from|. The new sentences contain no quotes (A1.16).
describe('describeEvent: paid_difference and paid_back (settle early and differences D8)', () => {
  const GONE = 'bbbbbbbb-0000-4000-8000-0000000000ff'; // not on the bill any more: nameOf says "Someone"
  const more = (actor: string | null, d: Record<string, unknown>) => ev('paid_difference', actor, d);
  const back = (actor: string | null, d: Record<string, unknown>) => ev('paid_back', actor, d);

  it.each<[string, ActivityEvent, NameOf, string]>([
    // paid_difference: the person (actor) paid the payer more.
    ['paid_difference, actor is another person', more(SAM, { payer_id: HANA, from: 1510, to: 1620 }), nameOf, 'Sam paid Hana $1.10 more'],
    ['paid_difference, actor = viewer', more(SAM, { payer_id: HANA, from: 1510, to: 1620 }), asViewer(SAM), 'You paid Hana $1.10 more'],
    ['paid_difference, payer = viewer', more(SAM, { payer_id: HANA, from: 1510, to: 1620 }), asViewer(HANA), 'Sam paid you $1.10 more'],
    ['paid_difference, a third person viewing', more(SAM, { payer_id: HANA, from: 1510, to: 1620 }), asViewer(PAT), 'Sam paid Hana $1.10 more'],
    ['paid_difference of 1 cent', more(SAM, { payer_id: HANA, from: 1510, to: 1511 }), nameOf, 'Sam paid Hana $0.01 more'],
    ['paid_difference of 1 cent, viewer is the payer', more(SAM, { payer_id: HANA, from: 1, to: 2 }), asViewer(HANA), 'Sam paid you $0.01 more'],
    ['paid_difference up to the C2 maximum', more(SAM, { payer_id: HANA, from: 1, to: 99_999_999 }), nameOf, 'Sam paid Hana $999,999.98 more'],
    ['paid_difference with a null actor', more(null, { payer_id: HANA, from: 1510, to: 1620 }), nameOf, 'Someone paid Hana $1.10 more'],
    ['paid_difference to a payer who left', more(SAM, { payer_id: GONE, from: 1510, to: 1620 }), nameOf, 'Sam paid someone $1.10 more'],
    // paid_back: the payer (actor) paid the person back.
    ['paid_back, actor is another person', back(HANA, { user_id: SAM, from: 1510, to: 1400 }), nameOf, 'Hana paid Sam back $1.10'],
    ['paid_back, actor = viewer', back(HANA, { user_id: SAM, from: 1510, to: 1400 }), asViewer(HANA), 'You paid Sam back $1.10'],
    ['paid_back, person = viewer', back(HANA, { user_id: SAM, from: 1510, to: 1400 }), asViewer(SAM), 'Hana paid you back $1.10'],
    ['paid_back, a third person viewing', back(HANA, { user_id: SAM, from: 1510, to: 1400 }), asViewer(PAT), 'Hana paid Sam back $1.10'],
    ['paid_back to $0 (the mark cleared)', back(HANA, { user_id: SAM, from: 1510, to: 0 }), nameOf, 'Hana paid Sam back $15.10'],
    ['paid_back to $0, person = viewer', back(HANA, { user_id: SAM, from: 1510, to: 0 }), asViewer(SAM), 'Hana paid you back $15.10'],
    ['paid_back of 1 cent', back(HANA, { user_id: SAM, from: 1, to: 0 }), nameOf, 'Hana paid Sam back $0.01'],
    ['paid_back of 1 cent, actor = viewer', back(HANA, { user_id: SAM, from: 1511, to: 1510 }), asViewer(HANA), 'You paid Sam back $0.01'],
    ['paid_back from the C2 maximum', back(HANA, { user_id: SAM, from: 99_999_999, to: 0 }), nameOf, 'Hana paid Sam back $999,999.99'],
    ['paid_back with a null actor', back(null, { user_id: SAM, from: 1510, to: 1400 }), nameOf, 'Someone paid Sam back $1.10'],
    ['paid_back to someone who left', back(HANA, { user_id: GONE, from: 1510, to: 1400 }), nameOf, 'Hana paid someone back $1.10'],
  ])('%s', (_label, event, names, expected) => {
    expect(describeEvent(event, names)).toBe(expected);
  });

  it('never shows ids, the from/to amounts or anything else from details', () => {
    const out = describeEvent(more(SAM, { payer_id: HANA, from: 1510, to: 1620, note: 'Dinner at Lupa' }), nameOf);
    expect(out).toBe('Sam paid Hana $1.10 more');
    expect(out).not.toContain(HANA);
    expect(out).not.toContain('15.10');
    expect(out).not.toContain('16.20');
    expect(out).not.toMatch(/["']/);
  });

  it.each<[string, ActivityEvent]>([
    ['paid_difference without payer_id', more(SAM, { from: 1510, to: 1620 })],
    ['paid_difference with a non-uuid payer_id', more(SAM, { payer_id: 'hana', from: 1510, to: 1620 })],
    ['paid_difference without from', more(SAM, { payer_id: HANA, to: 1620 })],
    ['paid_difference without to', more(SAM, { payer_id: HANA, from: 1510 })],
    ['paid_difference with to = from', more(SAM, { payer_id: HANA, from: 1510, to: 1510 })],
    ['paid_difference with to < from (wrong direction)', more(SAM, { payer_id: HANA, from: 1510, to: 1400 })],
    ['paid_difference with from 0', more(SAM, { payer_id: HANA, from: 0, to: 500 })],
    ['paid_difference with a negative from', more(SAM, { payer_id: HANA, from: -5, to: 500 })],
    ['paid_difference with to above C2', more(SAM, { payer_id: HANA, from: 1510, to: 100_000_000 })],
    ['paid_difference with fractional cents', more(SAM, { payer_id: HANA, from: 1510, to: 1620.5 })],
    ['paid_difference with string cents', more(SAM, { payer_id: HANA, from: '1510', to: 1620 })],
    ['paid_difference by the payer themself', more(HANA, { payer_id: HANA, from: 1510, to: 1620 })],
    ['paid_back without user_id', back(HANA, { from: 1510, to: 1400 })],
    ['paid_back with a non-uuid user_id', back(HANA, { user_id: null, from: 1510, to: 1400 })],
    ['paid_back without from', back(HANA, { user_id: SAM, to: 1400 })],
    ['paid_back without to', back(HANA, { user_id: SAM, from: 1510 })],
    ['paid_back with to = from', back(HANA, { user_id: SAM, from: 1510, to: 1510 })],
    ['paid_back with to > from (wrong direction)', back(HANA, { user_id: SAM, from: 1510, to: 1620 })],
    ['paid_back with from 0', back(HANA, { user_id: SAM, from: 0, to: 0 })],
    ['paid_back with a negative to', back(HANA, { user_id: SAM, from: 1510, to: -100 })],
    ['paid_back with from above C2', back(HANA, { user_id: SAM, from: 100_000_000, to: 0 })],
    ['paid_back with fractional cents', back(HANA, { user_id: SAM, from: 1510, to: 0.5 })],
    ['paid_back with string cents', back(HANA, { user_id: SAM, from: 1510, to: '0' })],
    ['paid_back to the actor themself', back(SAM, { user_id: SAM, from: 1510, to: 1400 })],
    ['paid_back with details not an object', ev('paid_back', HANA, [SAM, 1510, 0])],
  ])('returns null for malformed details: %s', (_label, event) => {
    expect(describeEvent(event, nameOf)).toBeNull();
  });
});
