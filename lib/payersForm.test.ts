import { payersState } from './payers';
import {
  canSavePayers,
  centsToPercents,
  initialPaidFields,
  PERCENT_ERROR_FORMAT,
  PERCENT_ERROR_TOO_LARGE,
  percentsToCents,
  PERCENT_ERROR_ROUNDS_TO_ZERO,
  payersFormStatus,
  rowCaptions,
  switchUnit,
} from './payersForm';

const H = 'host';
const A = 'aaa';
const B = 'bbb';
const IDS = [H, A, B];
const f = (h: string, a: string, b: string) => [
  { userId: H, text: h },
  { userId: A, text: a },
  { userId: B, text: b },
];

describe('percentsToCents (largest remainder)', () => {
  it('splits a total exactly when the percentages add up to 100', () => {
    expect(percentsToCents([3333, 3333, 3334], 10000)).toEqual([3333, 3333, 3334]);
    expect(percentsToCents([5000, 5000], 8462)).toEqual([4231, 4231]);
    // 1/3 each of $1.00: the extra cent goes to the largest remainder, ties to the earlier row.
    expect(percentsToCents([3333, 3333, 3334], 100)).toEqual([33, 33, 34]);
  });

  it('always sums to the total for 100% (random bills)', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let t = 0; t < 500; t += 1) {
      const total = rnd(1_000_000);
      const n = 2 + rnd(6);
      const parts: number[] = [];
      let left = 10000;
      for (let i = 0; i < n - 1; i += 1) {
        const p = rnd(left + 1);
        parts.push(p);
        left -= p;
      }
      parts.push(left);
      const cents = percentsToCents(parts, total);
      expect(cents.reduce((a, b) => a + b, 0)).toBe(total);
      cents.forEach((c) => expect(Number.isInteger(c) && c >= 0).toBe(true));
    }
  });

  it('refuses bad input instead of guessing', () => {
    expect(() => percentsToCents([6000, 5000], 100)).toThrow(RangeError);
    expect(() => percentsToCents([1.5], 100)).toThrow(RangeError);
    expect(() => percentsToCents([100], -1)).toThrow(RangeError);
  });
});

describe('centsToPercents', () => {
  it('gives exactly 100% for amounts that add up to the total', () => {
    expect(centsToPercents([100, 100, 100], 300)).toEqual([3334, 3333, 3333]);
    expect(centsToPercents([8462], 8462)).toEqual([10000]);
    const p = centsToPercents([1, 2, 8459], 8462);
    expect(p.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('a $0 total gives zeros', () => {
    expect(centsToPercents([0, 0], 0)).toEqual([0, 0]);
  });
});

describe('initialPaidFields: by default the payer (the host) paid the whole bill', () => {
  it('one person: the payer has the total, the others are blank', () => {
    const state = payersState({ payerId: H, rows: [], totalCents: 8462 });
    expect(initialPaidFields(state, IDS)).toEqual(f('84.62', '', ''));
  });

  it('split: the stored amounts', () => {
    const state = payersState({
      payerId: H,
      rows: [
        { userId: H, paidCents: 6000 },
        { userId: B, paidCents: 2462 },
      ],
      totalCents: 8462,
    });
    expect(initialPaidFields(state, IDS)).toEqual(f('60.00', '', '24.62'));
  });
});

describe('payersFormStatus, amounts', () => {
  it('one person with the whole bill saves as one payer', () => {
    const s = payersFormStatus('amount', f('84.62', '', ''), 8462);
    expect(s).toMatchObject({
      text: 'Adds up to $84.62',
      tone: 'success',
      change: { mode: 'one', payerId: H },
      saveHint: null,
    });
  });

  it('two people that add up save as a split', () => {
    const s = payersFormStatus('amount', f('60', '', '24.62'), 8462);
    expect(s.change).toEqual({
      mode: 'split',
      payers: [
        { userId: H, paidCents: 6000 },
        { userId: B, paidCents: 2462 },
      ],
    });
  });

  it('short, over and invalid never save, and say why', () => {
    expect(payersFormStatus('amount', f('60', '', ''), 8462)).toMatchObject({
      text: '$24.62 left to assign',
      tone: 'muted',
      change: null,
      saveHint: 'Amounts must add up to $84.62 first',
    });
    expect(payersFormStatus('amount', f('60', '30', ''), 8462)).toMatchObject({
      text: '$5.38 more than the total',
      tone: 'warning',
      change: null,
    });
    const bad = payersFormStatus('amount', f('6o', '', ''), 8462);
    expect(bad).toMatchObject({
      text: 'Fix the amount marked above',
      tone: 'error',
      change: null,
    });
    expect(bad.rows[0]).toEqual({
      userId: H,
      kind: 'invalid',
      error: 'Enter an amount like 12.50',
    });
  });

  it('one cent off is not close enough (tolerance 0)', () => {
    expect(payersFormStatus('amount', f('60', '', '24.61'), 8462).change).toBeNull();
    expect(payersFormStatus('amount', f('60', '', '24.63'), 8462).change).toBeNull();
  });

  it('nobody entered: nothing to save', () => {
    expect(payersFormStatus('amount', f('', '', ''), 0)).toMatchObject({
      text: 'Enter who paid',
      change: null,
    });
  });
});

describe('payersFormStatus, percentages', () => {
  it('100% to one person is one payer; the cents come from the total', () => {
    const s = payersFormStatus('percent', f('100', '', ''), 8462);
    expect(s).toMatchObject({
      text: 'Adds up to 100% · $84.62',
      tone: 'success',
      change: { mode: 'one', payerId: H },
    });
    expect(s.rows[0]).toEqual({
      userId: H,
      kind: 'value',
      cents: 8462,
      hundredths: 10000,
    });
  });

  it('a split by percentages adds up to the total exactly', () => {
    const s = payersFormStatus('percent', f('33.33', '33.33', '33.34'), 8462);
    expect(s.change?.mode).toBe('split');
    const payers = s.change?.mode === 'split' ? s.change.payers : [];
    expect(payers.reduce((sum, p) => sum + p.paidCents, 0)).toBe(8462);
  });

  it('short and over 100%', () => {
    expect(payersFormStatus('percent', f('50', '25', ''), 8462)).toMatchObject({
      text: '25% left to assign',
      change: null,
      saveHint: 'Percentages must add up to 100% first',
    });
    expect(payersFormStatus('percent', f('50', '60', ''), 8462)).toMatchObject({
      text: '10% more than 100%',
      tone: 'warning',
      change: null,
    });
  });

  it('field errors', () => {
    expect(payersFormStatus('percent', f('abc', '', ''), 8462).rows[0]).toEqual({
      userId: H,
      kind: 'invalid',
      error: PERCENT_ERROR_FORMAT,
    });
    expect(payersFormStatus('percent', f('150', '', ''), 8462).rows[0]).toEqual({
      userId: H,
      kind: 'invalid',
      error: PERCENT_ERROR_TOO_LARGE,
    });
    expect(payersFormStatus('percent', f('150', '', ''), 8462).tone).toBe('error');
  });

  it('accepts a trailing % sign', () => {
    expect(payersFormStatus('percent', f('60%', '40%', ''), 1000).change).toEqual({
      mode: 'split',
      payers: [
        { userId: H, paidCents: 600 },
        { userId: A, paidCents: 400 },
      ],
    });
  });
});

describe('payersFormStatus, a percentage that rounds to $0.00 (A-50(d), review R10)', () => {
  it('the copy', () => {
    expect(PERCENT_ERROR_ROUNDS_TO_ZERO).toBe('Rounds to $0.00. Enter a larger share or clear it.');
  });

  it('99.99% + 0.01% of $31.00: the 0.01% row is refused with the row error, and saving is blocked', () => {
    // 0.01% of 3100 = 0.31 of a cent; largest remainder gives the 99.99% row all 3100 cents.
    expect(percentsToCents([9999, 1, 0], 3100)).toEqual([3100, 0, 0]);
    const s = payersFormStatus('percent', f('99.99', '0.01', ''), 3100);
    expect(s.rows[1]).toEqual({ userId: A, kind: 'invalid', error: PERCENT_ERROR_ROUNDS_TO_ZERO });
    expect(s).toMatchObject({ text: 'Fix the percentage marked above', tone: 'error', change: null, saveHint: 'Fix the percentage marked above' });
    const state = payersState({ payerId: H, rows: [], totalCents: 3100 });
    expect(canSavePayers(s, state)).toBe(false);
  });

  it('two rows that round to $0.00 say so in the plural', () => {
    const s = payersFormStatus('percent', f('99.98', '0.01', '0.01'), 3100);
    expect(s.rows.slice(1).map((r) => r.kind)).toEqual(['invalid', 'invalid']);
    expect(s.text).toBe('Fix the percentages marked above');
    expect(s.change).toBeNull();
  });

  it('boundary: a row whose share rounds to exactly $0.01 is fine (positive control)', () => {
    // 0.04% of 3100 = 1.24 cents → 1 cent.
    const s = payersFormStatus('percent', f('99.96', '0.04', ''), 3100);
    expect(s.rows[1]).toMatchObject({ kind: 'value', cents: 1 });
    expect(s.change).toEqual({ mode: 'split', payers: [{ userId: H, paidCents: 3099 }, { userId: A, paidCents: 1 }] });
  });

  it('only decided once the percentages add up to 100% (a row short of it may still get a cent)', () => {
    const s = payersFormStatus('percent', f('50', '0.01', ''), 3100);
    expect(s.rows[1]?.kind).toBe('value');
    expect(s.text).toBe('49.99% left to assign');
  });

  it('a blank or 0 row is not an error, and a $0.00 bill keeps "Enter who paid"', () => {
    expect(payersFormStatus('percent', f('100', '0', ''), 3100).change).toEqual({ mode: 'one', payerId: H });
    expect(payersFormStatus('percent', f('100', '', ''), 0)).toMatchObject({ text: 'Enter who paid', change: null });
  });
});

describe('switchUnit', () => {
  it('amounts → percentages → amounts keeps a draft that adds up', () => {
    const pct = switchUnit('amount', 'percent', f('60', '', '24.62'), 8462);
    expect(pct.map((x) => x.text)).toEqual(['70.91', '', '29.09']);
    const back = switchUnit('percent', 'amount', pct, 8462);
    expect(back.map((x) => x.text)).toEqual(['60.00', '', '24.62']);
    const s = payersFormStatus('amount', back, 8462);
    expect(s.assignedCents).toBe(8462);
  });

  it('the default 100% to the host', () => {
    expect(switchUnit('amount', 'percent', f('84.62', '', ''), 8462).map((x) => x.text)).toEqual(['100', '', '']);
  });

  it("an invalid field keeps its raw text both ways (QA, A-50(c))", () => {
    expect(switchUnit('amount', 'percent', f('6o', '', ''), 8462).map((x) => x.text)).toEqual(['6o', '', '']);
    expect(switchUnit('percent', 'amount', f('abc', '', ''), 8462).map((x) => x.text)).toEqual(['abc', '', '']);
  });
});

describe('switchUnit keeps the cents (QA A-50(c): the % text is display only)', () => {
  const two = (h: string, a: string) => [
    { userId: H, text: h },
    { userId: A, text: a },
  ];
  const roundTrip = (fields: { userId: string; text: string }[], total: number) =>
    switchUnit('percent', 'amount', switchUnit('amount', 'percent', fields, total), total);
  const centsOf = (fields: readonly { userId: string; text: string }[], total: number) =>
    payersFormStatus('amount', fields, total).rows.map((r) => (r.kind === 'value' ? r.cents : null));

  it.each<[string, string, string, number]>([
    ['$10,000.00: $3,333.33 / $6,666.67', '3333.33', '6666.67', 1_000_000],
    ['$150.00: $0.22 / $149.78', '0.22', '149.78', 15_000],
    ["a draft that doesn't add up yet: $60.00 on $100.21", '60', '', 10_021],
  ])('QA: %s comes back to the same cents', (_n, h, a, total) => {
    const before = centsOf(two(h, a), total);
    const back = roundTrip(two(h, a), total);
    expect(centsOf(back, total)).toEqual(before);
  });

  it('$10,000.00 in % mode: the status, Save and the payload use the kept cents', () => {
    const pct = switchUnit('amount', 'percent', two('3333.33', '6666.67'), 1_000_000);
    expect(pct.map((x) => x.text)).toEqual(['33.33', '66.67']); // display only
    const s = payersFormStatus('percent', pct, 1_000_000);
    expect(s).toMatchObject({ text: 'Adds up to 100% · $10,000.00', tone: 'success' });
    expect(s.change).toEqual({ mode: 'split', payers: [{ userId: H, paidCents: 333_333 }, { userId: A, paidCents: 666_667 }] });
    // What the % text alone would give: positive control for the bug.
    expect(payersFormStatus('percent', two('33.33', '66.67'), 1_000_000).change).toEqual({
      mode: 'split',
      payers: [{ userId: H, paidCents: 333_300 }, { userId: A, paidCents: 666_700 }],
    });
  });

  it('editing one row in % mode changes only that row; the untouched row keeps its exact cents', () => {
    const pct = switchUnit('amount', 'percent', f('3333.33', '6666.67', ''), 1_000_000);
    const edited = pct.map((x) => (x.userId === H ? { userId: H, text: '20' } : x)); // what the screen's edit does
    const s = payersFormStatus('percent', edited, 1_000_000);
    expect(s.rows[0]).toMatchObject({ kind: 'value', cents: 200_000 });
    expect(s.rows[1]).toMatchObject({ kind: 'value', cents: 666_667 });
    expect(s).toMatchObject({ text: '$1,333.33 left to assign', change: null });
    expect(switchUnit('percent', 'amount', edited, 1_000_000).map((x) => x.text)).toEqual(['2000.00', '6666.67', '']);
    // Then the third row as a percentage: exact cents still, by tolerance 0.
    const done = edited.map((x) => (x.userId === B ? { userId: B, text: '13.3333' } : x));
    expect(payersFormStatus('percent', done, 1_000_000).rows[2]).toMatchObject({ kind: 'invalid' }); // 2 decimals at most
  });

  it('a kept row over the total, and the gap over it, read in dollars', () => {
    const pct = switchUnit('amount', 'percent', two('60', '50'), 10_000);
    expect(payersFormStatus('percent', pct, 10_000)).toMatchObject({ text: '$10.00 more than the total', change: null });
  });

  it('every row entered as a %: largest remainder still sums to exactly 100% · the total', () => {
    const s = payersFormStatus('percent', f('33.33', '33.33', '33.34'), 1_000_001);
    expect(s.text).toBe('Adds up to 100% · $10,000.01');
    const payers = s.change?.mode === 'split' ? s.change.payers : [];
    expect(payers.reduce((sum, p) => sum + p.paidCents, 0)).toBe(1_000_001);
  });

  it('property: $ → % → $ with no edits gives identical cents (random bills $0.01–$999,999.99)', () => {
    let seed = 20261127;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let i = 0; i < 3000; i += 1) {
      const total = int(1, 99_999_999);
      const n = int(1, 3);
      const addsUp = rand() < 0.7;
      const cents: number[] = [];
      let left = total;
      for (let k = 0; k < n; k += 1) {
        const c = k === n - 1 && addsUp ? left : int(0, Math.max(0, addsUp ? left : total));
        cents.push(c);
        left -= Math.min(c, left);
      }
      const fields = cents.map((c, k) => ({ userId: IDS[k] ?? `u${k}`, text: c === 0 ? '' : (c / 100).toFixed(2) }));
      const before = centsOf(fields, total);
      const back = roundTrip(fields, total);
      if (JSON.stringify(centsOf(back, total)) !== JSON.stringify(before)) {
        throw new Error(`total ${total}: ${JSON.stringify(fields)} → ${JSON.stringify(back)}`);
      }
      // In % mode, Save sees the same change as in $ mode.
      expect(payersFormStatus('percent', switchUnit('amount', 'percent', fields, total), total).change).toEqual(
        payersFormStatus('amount', fields, total).change,
      );
    }
  });
});

describe('canSavePayers: needs a change from what is stored', () => {
  const one = payersState({ payerId: H, rows: [], totalCents: 8462 });
  it('the same one payer is not a change', () => {
    expect(canSavePayers(payersFormStatus('amount', f('84.62', '', ''), 8462), one)).toBe(false);
    expect(canSavePayers(payersFormStatus('percent', f('100', '', ''), 8462), one)).toBe(false);
  });
  it('someone else, or a split, is', () => {
    expect(canSavePayers(payersFormStatus('amount', f('', '84.62', ''), 8462), one)).toBe(true);
    expect(canSavePayers(payersFormStatus('amount', f('42.31', '42.31', ''), 8462), one)).toBe(true);
  });
});

describe('rowCaptions', () => {
  it('amounts show their share, with the numbers switching to percent gives', () => {
    const amount = payersFormStatus('amount', f('60', '', '24.62'), 8462);
    expect(rowCaptions('amount', amount, 8462)).toEqual(['70.91% of the bill', null, '29.09% of the bill']);
  });
  it('percentages show cents only once they add up to 100%', () => {
    expect(rowCaptions('percent', payersFormStatus('percent', f('50', '50', ''), 8462), 8462)).toEqual(['$42.31', '$42.31', null]);
    expect(rowCaptions('percent', payersFormStatus('percent', f('50', '', ''), 8462), 8462)).toEqual([null, null, null]);
  });
});
