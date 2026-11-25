import { normalizeVenmoUsername, VENMO_USERNAME_ERROR, VENMO_USERNAME_PATTERN } from './venmo';

// Shared boundary cases B1–B15 from D2 in docs/specs/2026-11-24-profile-venmo.md.
// The pgTAP file (supabase/tests/database/profile_venmo.test.sql) writes the same
// literal inputs as-is; this file checks what the app normalizer returns for them.
const invalid = { ok: false, message: VENMO_USERNAME_ERROR } as const;

const cases: ReadonlyArray<[id: string, input: string, expected: ReturnType<typeof normalizeVenmoUsername>]> = [
  ['B1', 'abcd', invalid],
  ['B2', 'abcde', { ok: true, value: 'abcde' }],
  ['B3', 'a'.repeat(30), { ok: true, value: 'a'.repeat(30) }],
  ['B4', 'a'.repeat(31), invalid],
  ['B5', 'Jane-Doe_99', { ok: true, value: 'Jane-Doe_99' }],
  ['B6', '12345', { ok: true, value: '12345' }],
  ['B7', 'abc.de', invalid],
  ['B8', 'abc de', invalid],
  ['B9', 'josé1', invalid],
  ['B10', '@abcde', { ok: true, value: 'abcde' }],
  ['B11', '  @abcde  ', { ok: true, value: 'abcde' }],
  ['B12', '@@abcde', invalid],
  ['B13', '@abcd', invalid],
  ['B14 (empty)', '', { ok: true, value: null }],
  ['B14 (spaces)', '   ', { ok: true, value: null }],
  ['B14 (@ only)', '@', { ok: true, value: null }],
  ['B15', 'abcde\n', { ok: true, value: 'abcde' }],
];

describe('normalizeVenmoUsername: shared boundary cases', () => {
  it.each(cases)('%s: %j', (_id, input, expected) => {
    expect(normalizeVenmoUsername(input)).toEqual(expected);
  });

  it('B9 uses a precomposed é, so it is really a non-ASCII letter', () => {
    expect('josé1').toHaveLength(5);
    expect('josé1'.normalize('NFC')).toBe('josé1');
  });
});

describe('normalizeVenmoUsername: other rules', () => {
  it('keeps case exactly as typed', () => {
    expect(normalizeVenmoUsername('AbCdE')).toEqual({ ok: true, value: 'AbCdE' });
  });

  it('strips exactly one leading @ only, not one in the middle or at the end', () => {
    expect(normalizeVenmoUsername('ab@cde')).toEqual(invalid);
    expect(normalizeVenmoUsername('abcde@')).toEqual(invalid);
  });

  it('trims before stripping the @, and does not trim again after', () => {
    expect(normalizeVenmoUsername('@ abcde')).toEqual(invalid);
    // '@ ' trims to '@', which strips to '' and so clears.
    expect(normalizeVenmoUsername('@ ')).toEqual({ ok: true, value: null });
  });

  it('trims tabs and other leading/trailing whitespace', () => {
    expect(normalizeVenmoUsername('\t@abcde\r\n')).toEqual({ ok: true, value: 'abcde' });
  });

  it('rejects a decomposed accent, other symbols and full-width characters', () => {
    expect(normalizeVenmoUsername('josé1')).toEqual(invalid);
    expect(normalizeVenmoUsername('abc+de')).toEqual(invalid);
    expect(normalizeVenmoUsername('abc/de')).toEqual(invalid);
    expect(normalizeVenmoUsername('ａｂｃｄｅ')).toEqual(invalid);
  });

  it('accepts names made only of - or _ (no first-character rule)', () => {
    expect(normalizeVenmoUsername('-----')).toEqual({ ok: true, value: '-----' });
    expect(normalizeVenmoUsername('_abcde')).toEqual({ ok: true, value: '_abcde' });
  });

  it('every invalid outcome carries the one fixed message', () => {
    for (const input of ['abcd', 'a'.repeat(31), 'abc.de', 'josé1', '@@abcde', '@abcd']) {
      const result = normalizeVenmoUsername(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toBe(VENMO_USERNAME_ERROR);
    }
    expect(VENMO_USERNAME_ERROR).toBe('Venmo usernames are 5–30 letters, numbers, - or _.');
  });
});

describe('VENMO_USERNAME_PATTERN', () => {
  it('matches the whole string only (anchored) and is not stateful', () => {
    expect(VENMO_USERNAME_PATTERN.flags).toBe('');
    expect(VENMO_USERNAME_PATTERN.test('abcde')).toBe(true);
    expect(VENMO_USERNAME_PATTERN.test('abcde')).toBe(true);
    expect(VENMO_USERNAME_PATTERN.test('x abcde')).toBe(false);
    expect(VENMO_USERNAME_PATTERN.test('abcde x')).toBe(false);
    expect(VENMO_USERNAME_PATTERN.test('abcde\n')).toBe(false);
  });

  it('every accepted value is URL-safe without escaping', () => {
    for (const value of ['abcde', 'Jane-Doe_99', '12345', 'a'.repeat(30)]) {
      expect(VENMO_USERNAME_PATTERN.test(value)).toBe(true);
      expect(encodeURIComponent(value)).toBe(value);
    }
  });
});
