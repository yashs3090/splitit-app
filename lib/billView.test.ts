// Pure view helpers for the bill screen (Task 10). The screen and its components render only
// what these return; they do no money arithmetic of their own.
import {
  applyClaimOverrides,
  applySplitOverrides,
  billListLabel,
  billTitle,
  breakdownText,
  discountRowA11yName,
  DISCOUNTS_HEADING,
  EXTRAS_MODES,
  extrasModeHelp,
  extrasModeName,
  extrasModeOf,
  extrasModeText,
  initials,
  makeNameOf,
  nameList,
  partsLabel,
  partsOf,
  leftToClaim,
  pendingTotalText,
  pendingTotalWhen,
  rowA11yName,
  rowDetailsA11yLabel,
  personShareA11yLabel,
  showUnclaimedLine,
  rowLabel,
  rowStatus,
  splitInputFor,
  splitPreview,
  stepParts,
  unclaimedTotalCents,
} from './billView';
import { computeShares, displayShares } from './split';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const bill = {
  subtotal_cents: null,
  tax_cents: 280,
  fees_cents: 0,
  tip_cents: 700,
  subtotal_discount_cents: 0,
  total_discount_cents: 0,
  total_cents: 4480,
  extras_split: 'proportional' as const,
};

function row(id: string, name: string, cents: number, g: number, u = 0, size = 1, setBy: string | null = null) {
  return {
    id,
    name,
    note: null,
    group_position: g,
    unit_index: u,
    group_size: size,
    total_cents: cents,
    split_set_by: setBy,
    split_set_at: setBy ? '2026-11-21T10:00:00Z' : null,
  };
}

const rows = [
  row('r-burger', 'Burger', 1500, 0),
  row('r-fries', 'Fries', 600, 1),
  row('r-beer1', 'Beer', 700, 2, 0, 2),
  row('r-beer2', 'Beer', 700, 2, 1, 2),
];
const participants = [
  { userId: A, displayName: 'Hana Lee' },
  { userId: B, displayName: 'Bo' },
  { userId: C, displayName: null },
];

describe('names', () => {
  const nameOf = makeNameOf(participants, B);
  it('shows the viewer as "You", a null name as "A friend", an unknown id as "Someone"', () => {
    expect(nameOf(B)).toBe('You');
    expect(nameOf(A)).toBe('Hana Lee');
    expect(nameOf(C)).toBe('A friend');
    expect(nameOf('00000000-0000-4000-8000-0000000000ff')).toBe('Someone');
    expect(nameOf(null)).toBe('Someone');
  });
  it('treats a blank display name like a missing one', () => {
    expect(makeNameOf([{ userId: A, displayName: '   ' }], B)(A)).toBe('A friend');
  });
  it('initials: first letters of the first and last words; "?" for no name', () => {
    expect(initials('Hana Lee')).toBe('HL');
    expect(initials('pat')).toBe('P');
    expect(initials('  Mary Jo  Kim ')).toBe('MK');
    expect(initials(null)).toBe('?');
    expect(initials('  ')).toBe('?');
    // Punctuation and bracketed notes are never initials (a "(demo)" suffix read as "T(").
    expect(initials('Tejesh (demo)')).toBe('T');
    expect(initials('Sam (demo) Lee')).toBe('SL');
    expect(initials('"Ana" - Ruiz')).toBe('AR');
    expect(initials('(demo)')).toBe('?');
    expect(initials('李 明')).toBe('李明');
    expect(initials('Émile Zola')).toBe('ÉZ');
  });
  it('joins names as "Pat", "Pat and Sam", "Pat, Sam and Ali"', () => {
    expect(nameList([])).toBe('');
    expect(nameList(['Pat'])).toBe('Pat');
    expect(nameList(['Pat', 'Sam'])).toBe('Pat and Sam');
    expect(nameList(['Pat', 'Sam', 'Ali'])).toBe('Pat, Sam and Ali');
  });
  it('titles the bill by its host', () => {
    expect(billTitle(A, B, nameOf)).toBe("Hana Lee's bill");
    expect(billTitle(B, B, nameOf)).toBe('Your bill');
    expect(billTitle(C, B, nameOf)).toBe("A friend's bill");
  });
});

describe('row labels', () => {
  it('tags units of a group with "n of N"', () => {
    expect(rowLabel(rows[0]!)).toBe('Burger');
    expect(rowLabel(rows[2]!)).toBe('Beer · 1 of 2');
    expect(rowLabel(rows[3]!)).toBe('Beer · 2 of 2');
    expect(rowA11yName(rows[2]!)).toBe('Beer 1 of 2');
    expect(rowA11yName(rows[1]!)).toBe('Fries');
  });
});

describe('row details label (R2)', () => {
  it('says the name, price and status, so screen readers hear what sighted users see', () => {
    expect(rowDetailsA11yLabel('Fries', 600, 'Split 2 ways · $3.00 each', ['You', 'Hana Lee'])).toBe(
      'Fries, $6.00, Split 2 ways · $3.00 each, claimed by You and Hana Lee',
    );
    expect(rowDetailsA11yLabel('Beer 1 of 2', 700, 'Unclaimed', [])).toBe('Beer 1 of 2, $7.00, Unclaimed');
  });

  it('does not repeat a single claimer the status already names', () => {
    expect(rowDetailsA11yLabel('Burger', 1500, 'Hana Lee', ['Hana Lee'])).toBe('Burger, $15.00, Hana Lee');
    expect(rowDetailsA11yLabel('Fries', 600, 'You · $6.00', ['You'])).toBe('Fries, $6.00, You · $6.00');
  });

  it('names the claimers of a custom split, which the status does not', () => {
    expect(rowDetailsA11yLabel('Nachos', 1200, 'Custom split · set by you', ['You', 'Pat', 'Sam'])).toBe(
      'Nachos, $12.00, Custom split · set by you, claimed by You, Pat and Sam',
    );
  });
});

describe('person share label (R4)', () => {
  it('says the total when it is shown', () => {
    expect(personShareA11yLabel('You', 1664, false)).toBe('You $16.64');
  });
  it('says these are items only while the total is pending', () => {
    expect(personShareA11yLabel('You', 1000, true)).toBe('You, items $10.00, total shows once all items are claimed');
  });
});

describe('unclaimed line (R5)', () => {
  // Every row claimed, but all at $0.00, with $2.00 tax: nobody's share can carry the tax.
  const zeroRows = displayShares({
    totalCents: 200,
    items: [
      { id: 'water', totalCents: 0 },
      { id: 'bread', totalCents: 0 },
    ],
    claims: [
      { itemId: 'water', userId: 'A', parts: 1 },
      { itemId: 'bread', userId: 'B', parts: 1 },
    ],
    participantIds: ['A', 'B'],
    extrasMode: 'proportional',
  });

  it('shows the tax as Unclaimed when every row is claimed at $0.00', () => {
    expect(zeroRows.complete).toBe(true);
    expect(unclaimedTotalCents(zeroRows)).toBe(200);
    expect(showUnclaimedLine(zeroRows)).toBe(true);
    // Shares plus Unclaimed still add up to the bill total.
    const shares = zeroRows.people.reduce((sum, p) => sum + (p.totalCents ?? 0), 0);
    expect(shares + unclaimedTotalCents(zeroRows)).toBe(200);
  });

  it('hides it when everything is claimed and nothing is left over', () => {
    expect(showUnclaimedLine({ complete: true, unclaimedItemsCents: 0, unclaimedDiscountCents: 0, unclaimedExtrasCents: 0 })).toBe(false);
  });

  it('shows it while rows are unclaimed, even at $0.00', () => {
    expect(showUnclaimedLine({ complete: false, unclaimedItemsCents: 0, unclaimedDiscountCents: 0, unclaimedExtrasCents: 0 })).toBe(true);
    expect(showUnclaimedLine({ complete: false, unclaimedItemsCents: 500, unclaimedDiscountCents: 0, unclaimedExtrasCents: 50 })).toBe(true);
  });
});

describe('extras mode', () => {
  it("reads the bill's extras_split (fetchBill has validated it)", () => {
    expect(extrasModeOf(bill)).toBe('proportional');
    expect(extrasModeOf({ ...bill, extras_split: 'equal' })).toBe('equal');
  });

  it('feeds the mode into the split input', () => {
    const participants = [{ userId: A, displayName: 'Hana' }];
    expect(splitInputFor({ bill, rows, participants }, []).extrasMode).toBe('proportional');
    expect(splitInputFor({ bill: { ...bill, extras_split: 'equal' }, rows, participants }, []).extrasMode).toBe('equal');
  });

  it('has the fixed copy for both modes (Claim screen UX, A1.7)', () => {
    expect(EXTRAS_MODES).toEqual(['proportional', 'equal']);
    expect(extrasModeText('proportional')).toBe('Tax & tip: split proportionally');
    expect(extrasModeText('equal')).toBe('Tax & tip: split evenly');
    expect(extrasModeName('equal')).toBe('split evenly');
    expect(extrasModeName('proportional')).toBe('split proportionally');
    expect(extrasModeHelp('equal')).toBe('Split evenly between everyone who has claimed something.');
    expect(extrasModeHelp('proportional')).toBeNull();
  });
});

describe('optimistic claims', () => {
  const claims = [{ line_item_id: 'r-fries', user_id: A, parts: 2 }];
  it('adds my claim at 1 part and removes it, leaving others alone', () => {
    const on = applyClaimOverrides(claims, new Map([['r-fries', true]]), B);
    expect(on).toEqual([...claims, { line_item_id: 'r-fries', user_id: B, parts: 1 }]);
    const off = applyClaimOverrides(on, new Map([['r-fries', false]]), B);
    expect(off).toEqual(claims);
  });
  it('does not duplicate a claim the server already has', () => {
    const mine = [...claims, { line_item_id: 'r-fries', user_id: B, parts: 3 }];
    expect(applyClaimOverrides(mine, new Map([['r-fries', true]]), B)).toEqual(mine);
  });
  it('returns the same claims with no overrides', () => {
    expect(applyClaimOverrides(claims, new Map(), B)).toBe(claims);
  });
});

describe('split input and row status', () => {
  const nameOf = makeNameOf(participants, B);
  const data = { bill, rows, participants };

  it('builds the split input from the bill (57a: Bo has Fries and Beer 1)', () => {
    const claims = [
      { line_item_id: 'r-fries', user_id: B, parts: 1 },
      { line_item_id: 'r-beer1', user_id: B, parts: 1 },
    ];
    const input = splitInputFor(data, claims);
    expect(input).toEqual({
      totalCents: 4480,
      items: rows.map((r) => ({ id: r.id, totalCents: r.total_cents })),
      claims: claims.map((c) => ({ itemId: c.line_item_id, userId: c.user_id, parts: c.parts })),
      participantIds: [A, B, C],
      extrasMode: 'proportional',
    });
    const res = computeShares(input);
    expect(res.people.find((p) => p.userId === B)?.totalCents).toBe(1664);
    expect(rowStatus(res.items['r-burger'], rows[0]!, B, nameOf)).toBe('Unclaimed');
    expect(rowStatus(res.items['r-fries'], rows[1]!, B, nameOf)).toBe('You · $6.00');
    expect(rowStatus(undefined, rows[0]!, B, nameOf)).toBe('Unclaimed');
  });

  it('names a single other claimer, and describes even and custom splits', () => {
    const claims = [
      { line_item_id: 'r-burger', user_id: A, parts: 1 },
      { line_item_id: 'r-fries', user_id: A, parts: 1 },
      { line_item_id: 'r-fries', user_id: B, parts: 1 },
    ];
    const res = computeShares(splitInputFor(data, claims));
    expect(rowStatus(res.items['r-burger'], rows[0]!, B, nameOf)).toBe('Hana Lee');
    expect(rowStatus(res.items['r-fries'], rows[1]!, B, nameOf)).toBe('Split 2 ways · $3.00 each');

    const custom = [claims[0]!, { ...claims[1]!, parts: 2 }, claims[2]!];
    const friesSetByBo = row('r-fries', 'Fries', 600, 1, 0, 1, B);
    const friesSetByHana = row('r-fries', 'Fries', 600, 1, 0, 1, A);
    const res2 = computeShares(splitInputFor({ ...data, rows: [rows[0]!, friesSetByBo] }, custom));
    expect(rowStatus(res2.items['r-fries'], friesSetByBo, B, nameOf)).toBe('Custom split · set by you');
    expect(rowStatus(res2.items['r-fries'], friesSetByHana, B, nameOf)).toBe('Custom split · set by Hana Lee');
    expect(rowStatus(res2.items['r-fries'], rows[1]!, B, nameOf)).toBe('Custom split');
  });

  it('shows a cent range when an even split cannot be exact', () => {
    const tenDollars = row('r-x', 'Nachos', 1000, 0);
    const claims = [A, B, C].map((u) => ({ line_item_id: 'r-x', user_id: u, parts: 1 }));
    const res = computeShares(splitInputFor({ bill: { ...bill, total_cents: 1000 }, rows: [tenDollars], participants }, claims));
    expect(rowStatus(res.items['r-x'], tenDollars, B, nameOf)).toBe('Split 3 ways · $3.33–$3.34 each');
  });
});

describe('summary text', () => {
  it('breaks a share into items plus extras, or items minus discounts', () => {
    expect(breakdownText(1300, 364)).toBe('Items $13.00 + tax, tip and fees $3.64');
    expect(breakdownText(2000, -500)).toBe('Items $20.00 − discounts $5.00');
    expect(breakdownText(1300, 0)).toBe('Items $13.00');
  });

  it('adds up what is unclaimed from displayShares (57a: $28.16)', () => {
    const claims = [
      { itemId: 'r-fries', userId: B, parts: 1 },
      { itemId: 'r-beer1', userId: B, parts: 1 },
    ];
    const ds = displayShares({
      totalCents: 4480,
      items: rows.map((r) => ({ id: r.id, totalCents: r.total_cents })),
      claims,
      participantIds: [A, B],
      extrasMode: 'proportional',
    });
    expect(unclaimedTotalCents(ds)).toBe(2816);
  });

  it('counts the items left in the pending line', () => {
    expect(pendingTotalText(1)).toBe('Total shows once all items are claimed (1 item left)');
    expect(pendingTotalText(3)).toBe('Total shows once all items are claimed (3 items left)');
  });

  it('R1 (Amendment A1): names discounts when only discounts, or both kinds, are left', () => {
    expect(pendingTotalText(1, 1)).toBe('Total shows once all discounts are claimed (1 discount left)');
    expect(pendingTotalText(2, 2)).toBe('Total shows once all discounts are claimed (2 discounts left)');
    expect(pendingTotalText(3, 1)).toBe('Total shows once everything is claimed (2 items and 1 discount left)');
    expect(pendingTotalText(1, 0)).toBe('Total shows once all items are claimed (1 item left)');
    expect(leftToClaim(4, 2)).toEqual({ count: '2 items and 2 discounts', all: 'everything', every: 'everything' });
    expect(leftToClaim(1)).toEqual({ count: '1 item', all: 'all items', every: 'every item' });
    expect(personShareA11yLabel('Pat', 1000, true, pendingTotalWhen(1, 1))).toBe(
      'Pat, items $10.00, total shows once all discounts are claimed',
    );
    expect(personShareA11yLabel('Pat', 1000, true)).toBe('Pat, items $10.00, total shows once all items are claimed');
  });
});

describe('item sheet helpers (Task 11)', () => {
  it('previews a row split by parts, the same way computeShares splits it', () => {
    // Fries $6.00, A 2 parts, B 1 part → $4.00 / $2.00 (criterion 86).
    expect(splitPreview(600, { [B]: 1, [A]: 2 })).toEqual({ [A]: 400, [B]: 200 });
    // Even: 1000 three ways is 334/333/333 in userId order (criterion 58).
    expect(splitPreview(1000, { [C]: 1, [B]: 1, [A]: 1 })).toEqual({ [A]: 334, [B]: 333, [C]: 333 });
    expect(splitPreview(0, { [A]: 3, [B]: 1 })).toEqual({ [A]: 0, [B]: 0 });
    const split = computeShares({
      totalCents: 700,
      items: [{ id: 'r', totalCents: 700 }],
      claims: [
        { itemId: 'r', userId: A, parts: 3 },
        { itemId: 'r', userId: B, parts: 4 },
      ],
      participantIds: [A, B],
      extrasMode: 'proportional',
    }).items.r?.byUser;
    expect(splitPreview(700, { [A]: 3, [B]: 4 })).toEqual(split);
  });

  it('previews nothing for no claimers', () => {
    expect(splitPreview(600, {})).toEqual({});
  });

  it('steps parts within 1–20', () => {
    expect(stepParts(1, 1)).toBe(2);
    expect(stepParts(1, -1)).toBe(1);
    expect(stepParts(20, 1)).toBe(20);
    expect(stepParts(5, -1)).toBe(4);
  });

  it('labels parts', () => {
    expect(partsLabel(1)).toBe('1 part');
    expect(partsLabel(2)).toBe('2 parts');
  });

  it("reads one row's current parts per claimer", () => {
    const claims = [
      { line_item_id: 'r-fries', user_id: A, parts: 2 },
      { line_item_id: 'r-fries', user_id: B, parts: 1 },
      { line_item_id: 'r-burger', user_id: A, parts: 1 },
    ];
    expect(partsOf(claims, 'r-fries')).toEqual({ [A]: 2, [B]: 1 });
    expect(partsOf(claims, 'r-beer1')).toEqual({});
  });

  it('applies an optimistic split to that row only, for current claimers only', () => {
    const claims = [
      { line_item_id: 'r-fries', user_id: A, parts: 1 },
      { line_item_id: 'r-fries', user_id: B, parts: 1 },
      { line_item_id: 'r-burger', user_id: A, parts: 1 },
    ];
    const out = applySplitOverrides(claims, new Map([['r-fries', { [A]: 2, [B]: 1, [C]: 5 }]]));
    expect(out).toEqual([
      { line_item_id: 'r-fries', user_id: A, parts: 2 },
      { line_item_id: 'r-fries', user_id: B, parts: 1 },
      { line_item_id: 'r-burger', user_id: A, parts: 1 },
    ]);
    // No one is added (C never claimed) and the input isn't changed.
    expect(claims[0]?.parts).toBe(1);
    expect(applySplitOverrides(claims, new Map())).toBe(claims);
  });
});

describe('home list label (Task 12)', () => {
  const fmt = (iso: string) => (iso.startsWith('2026-11-20') ? 'Nov 20' : '?');
  const summary = {
    id: 'b1',
    hostId: A,
    hostName: 'Hana Lee',
    totalCents: 4480,
    createdAt: '2026-11-20T19:00:00Z',
    // Bill markers D2 fields: billListLabel doesn't read them.
    payerId: A,
    joinedAt: '2026-11-20T19:00:00Z',
    added: false,
    seen: false,
    claimedAny: false,
    complete: false,
    seenAt: null,
  };
  it('reads "<host>\'s bill · date · $total", or "Your bill" for the host', () => {
    expect(billListLabel(summary, B, fmt)).toBe("Hana Lee's bill · Nov 20 · $44.80");
    expect(billListLabel(summary, A, fmt)).toBe('Your bill · Nov 20 · $44.80');
  });
  it('shows a missing or blank host name as "A friend"', () => {
    expect(billListLabel({ ...summary, hostName: null }, B, fmt)).toBe("A friend's bill · Nov 20 · $44.80");
    expect(billListLabel({ ...summary, hostName: '  ' }, B, fmt)).toBe("A friend's bill · Nov 20 · $44.80");
  });
  it('leaves out a date the formatter cannot read', () => {
    expect(billListLabel(summary, B, () => '')).toBe("Hana Lee's bill · $44.80");
  });
});

// ---------------------------------------------------------------------------
// Claimable discounts (spec 2026-11-24-claimable-discounts.md, Task 5)
// ---------------------------------------------------------------------------

describe('claimable discounts: view helpers', () => {
  const discountRow = (id: string, name: string, cents: number, g: number) => ({
    ...row(id, name, cents, g),
    kind: 'discount' as const,
    applies_to: 'subtotal' as const,
  });

  describe('breakdownText with claimed discounts (criterion 37)', () => {
    it('lists items, then the claimed discounts, then the extras', () => {
      expect(breakdownText(1603, 128, -1603)).toBe(
        'Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28',
      );
      expect(breakdownText(500, 0, -1000)).toBe('Items $5.00 − claimed discounts $10.00');
      expect(breakdownText(2000, -500, -100)).toBe('Items $20.00 − claimed discounts $1.00 − discounts $5.00');
    });

    it('reads exactly as before with two arguments or a 0 discount', () => {
      expect(breakdownText(1300, 364)).toBe('Items $13.00 + tax, tip and fees $3.64');
      expect(breakdownText(1300, 364, 0)).toBe('Items $13.00 + tax, tip and fees $3.64');
      expect(breakdownText(2000, -500, 0)).toBe('Items $20.00 − discounts $5.00');
      expect(breakdownText(1300, 0, 0)).toBe('Items $13.00');
    });

    it('refuses a positive or non-integer discount (it is always ≤ 0)', () => {
      expect(() => breakdownText(500, 0, 100)).toThrow(RangeError);
      expect(() => breakdownText(500, 0, -1.5)).toThrow(RangeError);
    });
  });

  describe('splitPreview on a discount row (criterion 38)', () => {
    it('splits the negative amount by parts', () => {
      expect(splitPreview(-1000, { [A]: 2, [B]: 1 }, 'discount')).toEqual({ [A]: -667, [B]: -333 });
      expect(splitPreview(-1000, { [B]: 1, [A]: 1 }, 'discount')).toEqual({ [A]: -500, [B]: -500 });
    });

    it('leaves item previews unchanged', () => {
      expect(splitPreview(1000, { [A]: 2, [B]: 1 })).toEqual({ [A]: 667, [B]: 333 });
      expect(splitPreview(1000, { [A]: 2, [B]: 1 }, 'item')).toEqual({ [A]: 667, [B]: 333 });
    });

    it('previews nothing for no claimers, and refuses a sign that does not match the kind', () => {
      expect(splitPreview(-1000, {}, 'discount')).toEqual({});
      expect(() => splitPreview(1000, { [A]: 1 }, 'discount')).toThrow(RangeError);
      expect(() => splitPreview(-1000, { [A]: 1 })).toThrow(RangeError);
    });
  });

  describe('splitInputFor passes the row kind', () => {
    it('marks discount rows and leaves item rows as they were (absent kind = item)', () => {
      const rowsWithComp = [row('r-steak', 'Steak', 1603, 0), discountRow('r-comp', 'Police comp', -1603, 1)];
      const input = splitInputFor(
        { bill: { ...bill, total_cents: 1640 }, rows: rowsWithComp, participants },
        [{ line_item_id: 'r-comp', user_id: A, parts: 1 }],
      );
      expect(input.items).toEqual([
        { id: 'r-steak', totalCents: 1603 },
        { id: 'r-comp', totalCents: -1603, kind: 'discount' },
      ]);
      expect(input.items[0]).not.toHaveProperty('kind');
      const res = computeShares(input);
      expect(res.people.find((p) => p.userId === A)?.discountCents).toBe(-1603);
    });

    it("treats a row with kind 'item' like one without kind", () => {
      const input = splitInputFor({ bill, rows: [{ ...row('r-x', 'Fries', 600, 0), kind: 'item' as const }], participants }, []);
      expect(input.items).toEqual([{ id: 'r-x', totalCents: 600 }]);
    });
  });

  describe('Unclaimed line with discounts (criterion 39)', () => {
    const shares = { complete: true, unclaimedItemsCents: 0, unclaimedDiscountCents: -1603, unclaimedExtrasCents: 0 };

    it('shows a discount nobody claimed and counts it in the unclaimed total', () => {
      expect(showUnclaimedLine(shares)).toBe(true);
      expect(unclaimedTotalCents(shares)).toBe(-1603);
    });

    it('adds items, discounts and extras (E4: shares + Unclaimed = bill total)', () => {
      // E1 with the comp unclaimed: A Steak, B Salad, comp unclaimed, tax 240, total 1640.
      const ds = displayShares({
        totalCents: 1640,
        items: [
          { id: 'steak', totalCents: 1603 },
          { id: 'salad', totalCents: 1400 },
          { id: 'comp', totalCents: -1603, kind: 'discount' },
        ],
        claims: [
          { itemId: 'steak', userId: A, parts: 1 },
          { itemId: 'salad', userId: B, parts: 1 },
        ],
        participantIds: [A, B],
        extrasMode: 'proportional',
      });
      expect(unclaimedTotalCents(ds)).toBe(-1603);
      expect(showUnclaimedLine(ds)).toBe(true);
      const people = ds.people.reduce((sum, p) => sum + (p.totalCents ?? 0), 0);
      expect(people + unclaimedTotalCents(ds)).toBe(1640);
    });

    it('can net to zero while a discount is still unclaimed; the line shows because the bill is incomplete', () => {
      const net0 = { complete: false, unclaimedItemsCents: 500, unclaimedDiscountCents: -500, unclaimedExtrasCents: 0 };
      expect(unclaimedTotalCents(net0)).toBe(0);
      expect(showUnclaimedLine(net0)).toBe(true);
    });
  });

  describe('labels (criterion 41)', () => {
    it('names a discount row for screen readers', () => {
      expect(discountRowA11yName('Police comp')).toBe('Police comp, discount');
    });

    it('captions the discount section', () => {
      expect(DISCOUNTS_HEADING).toBe('Discounts');
    });
  });
});
