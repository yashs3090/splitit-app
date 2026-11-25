import {
  MAX_INPUT_CENTS,
  formatCents,
  formatCentsInput,
  formatPercent,
  isTooLarge,
  parseMoneyInput,
  parseMoneyToken,
  parsePercentInput,
  percentOfCents,
} from './money';

describe('parseMoneyToken', () => {
  it.each([
    ['12.99', 1299],
    ['$12.99', 1299],
    ['$ 12.99', 1299],
    ['1,234.50', 123450],
    ['-2.00', -200],
    ['-$2.00', -200],
    ['(2.00)', -200],
    ['2.00-', -200],
    ['($2.00)', -200],
    ['0.01', 1],
    ['0.00', 0],
    [' 12.99 ', 1299],
  ])('parses %j as %d', (input, cents) => {
    expect(parseMoneyToken(input)).toBe(cents);
  });

  it.each(['12', '12.9', '12.999', '12,99', '1.2.3', 'abc', '', '(2.00', '2.00)', '-(2.00)', '--2.00', '1,23.00', '- 2.00'])(
    'rejects %j',
    (input) => {
      expect(parseMoneyToken(input)).toBeNull();
    },
  );

  it('parses values where float x 100 goes wrong exactly', () => {
    expect(parseMoneyToken('0.29')).toBe(29);
    expect(parseMoneyToken('0.57')).toBe(57);
    expect(parseMoneyToken('1.15')).toBe(115);
    expect(parseMoneyToken('4.35')).toBe(435);
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseMoneyToken('-0.00'), 0)).toBe(true);
  });

  it('rejects absurdly long digit strings instead of losing precision', () => {
    expect(parseMoneyToken('1234567890123456789.00')).toBeNull();
  });
});

describe('formatCents', () => {
  it.each([
    [1299, '$12.99'],
    [-250, '-$2.50'],
    [0, '$0.00'],
    [5, '$0.05'],
    [123450, '$1,234.50'],
    [123456789, '$1,234,567.89'],
  ])('formats %d as %j', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

describe('formatting non-integers (R10)', () => {
  it.each([NaN, Infinity, -Infinity, 12.5, 0.1 + 0.2, Number.MAX_SAFE_INTEGER + 2])(
    'formatCents and formatCentsInput return an empty string for %p',
    (n) => {
      expect(formatCents(n)).toBe('');
      expect(formatCentsInput(n)).toBe('');
    },
  );
});

describe('parseMoneyInput', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.', 1200],
    ['.99', 99],
    ['$1,234.50', 123450],
    ['0', 0],
    ['0.29', 29],
    ['4.35', 435],
    ['99999.99', 9999999],
    ['  7.10 ', 710],
  ])('accepts %j as %d', (input, cents) => {
    expect(parseMoneyInput(input)).toBe(cents);
  });

  it.each(['', '  ', '-5', '(5.00)', '12.999', '1,23.00', 'abc', '1e3', '12 50', 'NaN', 'Infinity', '.', '100000.00', '$', '1,2345.00'])(
    'returns null for %j',
    (input) => {
      expect(parseMoneyInput(input)).toBeNull();
    },
  );

  it('caps at MAX_INPUT_CENTS and reports too-large separately', () => {
    expect(MAX_INPUT_CENTS).toBe(9_999_999);
    expect(isTooLarge('100000.00')).toBe(true);
    expect(isTooLarge('100000')).toBe(true);
    expect(isTooLarge('99999999999999999999999')).toBe(true);
    expect(isTooLarge('99999.99')).toBe(false);
    expect(isTooLarge('abc')).toBe(false);
    expect(isTooLarge('')).toBe(false);
  });
});

describe('formatCentsInput', () => {
  it.each([
    [1299, '12.99'],
    [5, '0.05'],
    [123450, '1234.50'],
    [0, '0.00'],
  ])('formats %d as %j', (cents, text) => {
    expect(formatCentsInput(cents)).toBe(text);
  });

  it('round-trips through parseMoneyInput', () => {
    for (const n of [0, 1, 5, 99, 100, 1299, 123450, 9999999]) {
      expect(parseMoneyInput(formatCentsInput(n))).toBe(n);
    }
  });
});

describe('parsePercentInput (tip %, in hundredths of a percent)', () => {
  it.each([
    ['20', 2000],
    ['18.5', 1850],
    ['7.25', 725],
    ['0.5', 50],
    ['.5', 50],
    ['20.', 2000],
    [' 20% ', 2000],
    ['0', 0],
    ['100', 10000],
    ['007', 700],
  ])('%p -> %p', (input, expected) => {
    expect(parsePercentInput(input)).toBe(expected);
  });

  it.each(['', '%', '.', 'abc', '-5', '18.555', '100.01', '101', '1e2', '20%%', '1,000', '0x10'])('rejects %p', (input) => {
    expect(parsePercentInput(input)).toBeNull();
  });
});

describe('percentOfCents (round half up, integer math)', () => {
  it.each([
    [4000, 2000, 800], // 20% of $40.00 = $8.00
    [4000, 1800, 720],
    [3333, 1500, 500], // 499.95 -> 500
    [3330, 1500, 500], // 499.5 -> 500 (half rounds up)
    [3329, 1500, 499], // 499.35 -> 499
    [1, 5000, 1], // 0.5 -> 1
    [1, 4999, 0],
    [2997, 1850, 554], // 554.445 -> 554
    [0, 2000, 0],
    [4000, 0, 0],
    [9_999_999, 10000, 9_999_999],
  ])('%p cents x %p hundredths -> %p', (cents, pct, expected) => {
    expect(percentOfCents(cents, pct)).toBe(expected);
  });

  it('is exact where float math is not (0.29, 0.57, 1.15, 4.35)', () => {
    expect(percentOfCents(29, 10000)).toBe(29);
    expect(percentOfCents(115, 5000)).toBe(58); // 57.5 -> 58
    expect(percentOfCents(435, 5000)).toBe(218); // 217.5 -> 218
  });

  it('throws on non-integer or negative input instead of returning garbage', () => {
    expect(() => percentOfCents(10.5, 2000)).toThrow(RangeError);
    expect(() => percentOfCents(1000, 20.5)).toThrow(RangeError);
    expect(() => percentOfCents(-1, 2000)).toThrow(RangeError);
    expect(() => percentOfCents(1000, -1)).toThrow(RangeError);
    expect(() => percentOfCents(Number.NaN, 2000)).toThrow(RangeError);
    expect(() => percentOfCents(Number.MAX_SAFE_INTEGER, 10000)).toThrow(RangeError);
  });
});

describe('formatPercent', () => {
  it.each([
    [2000, '20%'],
    [1850, '18.5%'],
    [725, '7.25%'],
    [50, '0.5%'],
    [5, '0.05%'],
    [0, '0%'],
    [10000, '100%'],
  ])('%p -> %p', (n, expected) => {
    expect(formatPercent(n)).toBe(expected);
  });

  it('gives an empty string for non-integers', () => {
    expect(formatPercent(1.5)).toBe('');
  });
});
