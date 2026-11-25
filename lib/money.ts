// Integer-cents money parsing and formatting. See docs/learning/concepts/money-and-rounding.md.
//
// Every conversion works on the digit string: the dollars digits and the two cents digits are
// concatenated and read with parseInt(…, 10). We never multiply a float by 100, because values
// like 0.29, 0.57, 1.15 and 4.35 are not exact in binary floating point.

/** Largest amount a form field accepts: $99,999.99. */
export const MAX_INPUT_CENTS = 9_999_999;

/** Receipt tokens longer than this (in dollar digits) are rejected so parseInt stays exact. */
const MAX_TOKEN_DOLLAR_DIGITS = 12;

const DOLLARS = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;

// `-$`, `$-` and `$ ` prefixes; `(…)` and trailing `-` negatives. A space is allowed only after `$`.
const TOKEN_RE = new RegExp(String.raw`^(\()?(-)?(\$\s?)?(-)?${DOLLARS}\.(\d{2})(\))?(-)?$`);

function digitsToCents(dollarDigits: string, centDigits: string): number {
  // "0" + "29" reads as 29: parseInt ignores leading zeros and is exact for these lengths.
  return parseInt(`${dollarDigits}${centDigits}`, 10);
}

/**
 * Parses one money token as printed on a receipt. Requires exactly two decimals.
 * Accepts `12.99`, `$12.99`, `$ 12.99`, `1,234.50`, `-2.00`, `-$2.00`, `(2.00)`, `2.00-`.
 * Returns signed integer cents, or null.
 */
export function parseMoneyToken(s: string): number | null {
  const m = TOKEN_RE.exec(s.trim());
  if (!m) return null;
  const [, openParen, leadMinus, , innerMinus, dollars = '', cents = '', closeParen, trailMinus] = m;
  if (Boolean(openParen) !== Boolean(closeParen)) return null;
  const negatives = [openParen, leadMinus, innerMinus, trailMinus].filter(Boolean).length;
  if (negatives > 1) return null;
  const dollarDigits = dollars.replace(/,/g, '');
  if (dollarDigits.replace(/^0+(?=\d)/, '').length > MAX_TOKEN_DOLLAR_DIGITS) return null;
  const value = digitsToCents(dollarDigits, cents);
  if (value === 0) return 0; // never -0
  return negatives === 1 ? -value : value;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function splitCents(n: number): { sign: string; dollars: string; cents: string } | null {
  // Only whole, exactly representable cents format; NaN, Infinity and fractions would print garbage.
  if (!Number.isSafeInteger(n)) return null;
  const abs = Math.abs(n);
  const digits = String(abs).padStart(3, '0');
  return { sign: n < 0 ? '-' : '', dollars: digits.slice(0, -2), cents: digits.slice(-2) };
}

/** 1299 → `$12.99`, -250 → `-$2.50`, 0 → `$0.00`, 123450 → `$1,234.50`. Non-integer input gives ''. */
export function formatCents(n: number): string {
  const parts = splitCents(n);
  if (!parts) return '';
  const { sign, dollars, cents } = parts;
  return `${sign}$${groupThousands(dollars)}.${cents}`;
}

/** The string shown in a form field: 1299 → `12.99`, 5 → `0.05`, 123450 → `1234.50`. No `$` or commas; non-integer input gives ''. */
export function formatCentsInput(n: number): string {
  const parts = splitCents(n);
  if (!parts) return '';
  const { sign, dollars, cents } = parts;
  return `${sign}${dollars}.${cents}`;
}

type InputResult = { kind: 'ok'; cents: number } | { kind: 'invalid' } | { kind: 'too_large' };

// Optional `$`, then dollars (plain or correctly comma-grouped, optional), then an optional `.`
// with 0–2 decimals. At least one digit overall is checked separately.
const INPUT_RE = /^\$?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{0,2}))?$/;
const MAX_INPUT_DOLLAR_DIGITS = String(MAX_INPUT_CENTS).length - 2;

function readMoneyInput(s: string): InputResult {
  const m = INPUT_RE.exec(s.trim());
  if (!m) return { kind: 'invalid' };
  const dollars = (m[1] ?? '').replace(/,/g, '');
  const fraction = m[2] ?? '';
  if (dollars === '' && fraction === '') return { kind: 'invalid' }; // '', '$', '.'
  const significant = dollars.replace(/^0+/, '');
  if (significant.length > MAX_INPUT_DOLLAR_DIGITS) return { kind: 'too_large' };
  const cents = digitsToCents(dollars || '0', fraction.padEnd(2, '0'));
  if (cents > MAX_INPUT_CENTS) return { kind: 'too_large' };
  return { kind: 'ok', cents };
}

/**
 * Parses what a user typed into a money field. More lenient than receipt tokens:
 * `12` → 1200, `12.5` → 1250, `12.` → 1200, `.99` → 99, `$1,234.50` → 123450.
 * Returns null for blank, negative, malformed or too-large input (see isTooLarge).
 */
export function parseMoneyInput(s: string): number | null {
  const r = readMoneyInput(s);
  return r.kind === 'ok' ? r.cents : null;
}

/** True when the input is well-formed money but above MAX_INPUT_CENTS. */
export function isTooLarge(s: string): boolean {
  return readMoneyInput(s).kind === 'too_large';
}

// ---------- percentages (tip %) ----------
// A percentage is held as integer hundredths of a percent: 20% → 2000, 18.5% → 1850, 7.25% → 725.
// Like money, it is read from the digit string, never through a float.

/** Largest percentage the tip field accepts, in hundredths: 100%. */
export const MAX_PERCENT_HUNDREDTHS = 10_000;

const PERCENT_RE = /^(\d{1,3})?(?:\.(\d{0,2}))?%?$/;

/**
 * Parses a typed percentage into integer hundredths of a percent, 0–100% with up to two
 * decimals: `20` → 2000, `18.5` → 1850, `.5` → 50, `20%` → 2000. Null for anything else.
 */
export function parsePercentInput(s: string): number | null {
  const m = PERCENT_RE.exec(s.trim());
  if (!m) return null;
  const whole = m[1] ?? '';
  const fraction = m[2] ?? '';
  if (whole === '' && fraction === '') return null; // '', '%', '.'
  const value = parseInt(`${whole || '0'}${fraction.padEnd(2, '0')}`, 10);
  return value <= MAX_PERCENT_HUNDREDTHS ? value : null;
}

/**
 * `hundredths` (hundredths of a percent) of `cents`, rounded half up to the cent:
 * round(cents × hundredths / 10000) with integers only. Throws on non-integer, negative or
 * overflowing input rather than returning a wrong amount.
 */
export function percentOfCents(cents: number, hundredths: number): number {
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(hundredths) || cents < 0 || hundredths < 0) {
    throw new RangeError('percentOfCents needs non-negative integer cents and hundredths');
  }
  const scaled = cents * hundredths + 5_000; // + half of 10000, so truncating rounds half up
  if (!Number.isSafeInteger(scaled)) throw new RangeError('percentOfCents input too large');
  return (scaled - (scaled % 10_000)) / 10_000;
}

/** 2000 → `20%`, 1850 → `18.5%`, 725 → `7.25%`, 5 → `0.05%`. Non-integer input gives ''. */
export function formatPercent(hundredths: number): string {
  if (!Number.isSafeInteger(hundredths) || hundredths < 0) return '';
  const digits = String(hundredths).padStart(3, '0');
  const fraction = digits.slice(-2).replace(/0+$/, '');
  return `${digits.slice(0, -2)}${fraction === '' ? '' : `.${fraction}`}%`;
}
