// lib/username.ts: criteria 13–16 and 19 in docs/specs/2026-11-28-usernames.md (Task 2).
// Expected values below are copied from the spec's tables, not from the code's output.
import {
  fallbackUsername,
  normalizeUsername,
  RESERVED_USERNAMES,
  suggestTakenAlternatives,
  suggestUsername,
  USERNAME_ERROR_COPY,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  validateUsername,
  withNumberSuffix,
  type SetUsernameReason,
  type UsernameInvalidReason,
} from './username';

// No Node types in this tsconfig, so fs is typed by hand (as in __tests__/vercelConfig.test.ts).
const fs = jest.requireActual<{
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
}>('fs');

type Class = 'valid' | 'invalid' | 'reserved';

// Shared boundary table B1–B24 (the same rows as supabase/tests/database/usernames.test.sql), with
// the lib reason from "lib validation reasons" for each non-valid row.
const BOUNDARY: [string, string, Class, UsernameInvalidReason | null][] = [
  ['B1', 'abc', 'valid', null],
  ['B2', 'ab', 'invalid', 'too_short'],
  ['B3', 'a'.repeat(20), 'valid', null],
  ['B4', 'a'.repeat(21), 'invalid', 'too_long'],
  ['B5', 'yash_saraiya', 'valid', null],
  ['B6', 'yash.saraiya', 'valid', null],
  ['B7', '.yash', 'invalid', 'bad_dots'],
  ['B8', 'yash.', 'invalid', 'bad_dots'],
  ['B9', 'ya..sh', 'invalid', 'bad_dots'],
  ['B10', 'a.b.c', 'valid', null],
  ['B11', 'Yash', 'invalid', 'invalid_chars'],
  ['B12', 'yash-s', 'invalid', 'invalid_chars'],
  ['B13', 'yash s', 'invalid', 'invalid_chars'],
  ['B14', 'josé', 'invalid', 'invalid_chars'],
  ['B15', 'yash\n', 'invalid', 'invalid_chars'],
  ['B16', '', 'invalid', 'too_short'],
  ['B17', 'admin', 'reserved', 'reserved'],
  ['B18', 'admin1', 'valid', null],
  ['B19', 'you', 'reserved', 'reserved'],
  ['B20', 'me', 'invalid', 'too_short'],
  ['B21', '123', 'valid', null],
  ['B22', '___', 'valid', null],
  ['B23', 'ADMIN', 'invalid', 'invalid_chars'],
  ['B24', 'a.' + 'b'.repeat(18), 'valid', null],
];

const classOf = (s: string): Class => {
  const v = validateUsername(s);
  if (v.ok) return 'valid';
  return v.reason === 'reserved' ? 'reserved' : 'invalid';
};

describe('validateUsername (contract V)', () => {
  it('B24 really is 20 characters', () => {
    expect(('a.' + 'b'.repeat(18)).length).toBe(20);
  });

  it.each(BOUNDARY)('13: %s %j is %s', (_id, value, cls, reason) => {
    expect(classOf(value)).toBe(cls);
    expect(validateUsername(value)).toEqual(reason === null ? { ok: true } : { ok: false, reason });
  });

  it('does not normalize: a leading @ or surrounding spaces are invalid_chars', () => {
    expect(validateUsername('@yash')).toEqual({ ok: false, reason: 'invalid_chars' });
    expect(validateUsername(' yash')).toEqual({ ok: false, reason: 'invalid_chars' });
  });

  it('reserved words match exactly (UN-5)', () => {
    for (const word of RESERVED_USERNAMES) {
      if (word.length >= USERNAME_MIN_LENGTH) expect(validateUsername(word)).toEqual({ ok: false, reason: 'reserved' });
    }
    expect(validateUsername('admin1')).toEqual({ ok: true });
    expect(validateUsername('xadmin')).toEqual({ ok: true });
    expect(validateUsername('admin.team')).toEqual({ ok: true });
  });

  it('exports the bounds and the pattern from the spec', () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    expect(USERNAME_MAX_LENGTH).toBe(20);
    expect(USERNAME_PATTERN.source).toBe('^[a-z0-9_]+(\\.[a-z0-9_]+)*$');
    expect(USERNAME_PATTERN.flags).toBe('');
  });
});

describe('normalizeUsername (contract N)', () => {
  it.each([
    [' @Yash_S ', 'yash_s'],
    ['@@yash', '@yash'],
    ['İsam', 'İsam'],
  ])('14: %j → %j', (raw, out) => {
    expect(normalizeUsername(raw)).toBe(out);
  });

  it('14: the N examples land in the right V class', () => {
    expect(validateUsername(normalizeUsername(' @Yash_S '))).toEqual({ ok: true });
    expect(validateUsername(normalizeUsername('@@yash'))).toEqual({ ok: false, reason: 'invalid_chars' });
    expect(validateUsername(normalizeUsername('İsam'))).toEqual({ ok: false, reason: 'invalid_chars' });
  });

  it('14: ADMIN normalizes to admin, which is reserved', () => {
    expect(normalizeUsername('ADMIN')).toBe('admin');
    expect(validateUsername(normalizeUsername('ADMIN'))).toEqual({ ok: false, reason: 'reserved' });
  });

  it('lowercases only ASCII A–Z (not toLowerCase)', () => {
    // 'K' (U+212A Kelvin sign) lowercases to ASCII 'k' with toLowerCase(); N must leave it.
    expect(normalizeUsername('Kate')).toBe('Kate');
    expect(normalizeUsername('ÉCOLE')).toBe('École');
    expect(normalizeUsername('ABCXYZ')).toBe('abcxyz');
  });

  it('removes only one leading @, after trimming', () => {
    expect(normalizeUsername('  @abc')).toBe('abc');
    expect(normalizeUsername('a@bc')).toBe('a@bc');
  });
});

describe('drift guard: lib copy equals the migration (criterion 15)', () => {
  const dir = `${process.cwd()}/supabase/migrations`;
  const matches = fs.readdirSync(dir).filter((f) => /^[^/]*_usernames\.sql$/.test(f));

  it('exactly one *_usernames.sql migration exists', () => {
    expect(matches).toHaveLength(1);
  });

  const sql = (): string => {
    if (matches.length !== 1) throw new Error(`expected one *_usernames.sql, found ${matches.length}`);
    return fs.readFileSync(`${dir}/${matches[0] as string}`, 'utf8');
  };

  it('profiles_username_format has the same length bounds and regex text', () => {
    const m = /constraint profiles_username_format\s+check \(username is null or \(char_length\(username\) between (\d+) and (\d+) and username ~ '([^']*)'\)\)/.exec(
      sql(),
    );
    expect(m).not.toBeNull();
    const [, min, max, regex] = m as RegExpExecArray;
    expect(Number(min)).toBe(USERNAME_MIN_LENGTH);
    expect(Number(max)).toBe(USERNAME_MAX_LENGTH);
    expect(regex).toBe(USERNAME_PATTERN.source);
  });

  it('profiles_username_reserved has the same words in the same order', () => {
    const m = /constraint profiles_username_reserved\s+check \(username is null or username <> all \(array\[([^\]]*)\]\)\)/.exec(sql());
    expect(m).not.toBeNull();
    const words = (m as RegExpExecArray)[1]!.split(',').map((w) => {
      const t = w.trim();
      expect(t).toMatch(/^'[^']*'$/);
      return t.slice(1, -1);
    });
    expect(words).toEqual([...RESERVED_USERNAMES]);
  });

  it('the reserved list matches the spec', () => {
    expect([...RESERVED_USERNAMES]).toEqual(
      'admin, administrator, splitit, split_it, support, help, helpdesk, root, system, sysadmin, null, undefined, nil, none, me, you, everyone, anonymous, guest, user, users, owner, host, staff, team, official, moderator, mod, security, billing, payments, venmo, paypal, cashapp, api, auth, login, signup, settings, account, profile, privacy, terms, test'.split(
        ', ',
      ),
    );
  });
});

describe('suggestUsername (contract S)', () => {
  it.each<[string | null, string | null]>([
    ['Yash Saraiya', 'yash_saraiya'],
    ['José Núñez', 'jose_nunez'],
    ["Mary-Jane O'Brien", 'mary_jane_obrien'],
    ['J. R. Smith', 'j_r_smith'],
    ['山田太郎', null],
    ['Al', null],
    ['Admin', null],
    ['Bartholomew Montgomery-Smythe', 'bartholomew_montgome'],
    ['Yash 山田', 'yash'],
    [null, null],
    ['', null],
    ['   ', null],
  ])('16: %j → %j', (input, out) => {
    expect(suggestUsername(input)).toBe(out);
  });

  it('cuts to 20 and trims a trailing _ left by the cut', () => {
    // 'abcdefghijklmnopqrs t' → 'abcdefghijklmnopqrs_t' → cut 20 → 'abcdefghijklmnopqrs_' → trim.
    expect(suggestUsername('abcdefghijklmnopqrs tuv')).toBe('abcdefghijklmnopqrs');
  });

  it('collapses runs and trims _ from both ends', () => {
    expect(suggestUsername('  __Ann -- . Lee__  ')).toBe('ann_lee');
    expect(suggestUsername('a!!!b!!!c')).toBe('abc');
  });

  it('16: every non-null result over 60 generated names passes V', () => {
    // Seeded LCG so the run is reproducible.
    let seed = 20261128;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pools = [
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'éèêëáàâäãåñçøœßíìîïóòôöõúùûüýÿÉÑÇ',
      '山田太郎李王张刘陈김이박',
      '😀🎉👍🏽❤️🇺🇸',
      ".,'-_!?@#$%^&*()[]{}/\\|:;\"<>~`+=",
      '     \t\n 　',
      'ﬁＡＢＣ①ⅷKİ',
    ];
    const names: string[] = [''];
    for (let i = 0; i < 60; i += 1) {
      const len = rand(61);
      let s = '';
      while ([...s].length < len) {
        const pool = [...(pools[rand(pools.length)] as string)];
        s += pool[rand(pool.length)] as string;
      }
      names.push(s);
    }
    let nonNull = 0;
    for (const name of names) {
      const out = suggestUsername(name);
      if (out !== null) {
        nonNull += 1;
        expect({ name, v: validateUsername(out) }).toEqual({ name, v: { ok: true } });
      }
    }
    // The property must have been exercised, not passed by everything being null.
    expect(nonNull).toBeGreaterThan(10);
  });
});

// Amendment A1.2: the database's private.assign_username has its own base rule. pgTAP
// (supabase/tests/database/username_required.test.sql) asserts the same four outputs, so a drift on
// common names shows up on both sides. Known differences are listed in the migration header.
describe('suggestUsername vs the SQL base rule (A1.2 pair)', () => {
  it.each([
    ['Yash Saraiya', 'yash_saraiya'],
    ['Zoë Smith', 'zoe_smith'],
    ['José Núñez', 'jose_nunez'],
    ["Mary-Jane O'Brien", 'mary_jane_obrien'],
  ])('%j -> %s', (name, out) => {
    expect(suggestUsername(name)).toBe(out);
  });
});

describe('withNumberSuffix and fallbackUsername (contract S)', () => {
  it('16: the spec examples', () => {
    expect(withNumberSuffix('abcdefghijklmnopqrst', 12)).toBe('abcdefghijklmnopqr12');
    expect(fallbackUsername(42)).toBe('user0042');
  });

  it('appends to a short base without cutting', () => {
    expect(withNumberSuffix('yash', 1)).toBe('yash1');
    expect(withNumberSuffix('yash_saraiya', 9999)).toBe('yash_saraiya9999');
  });

  it('trims trailing _ left by the cut', () => {
    // 20 - 2 = 18 → 'abcdefghijklmnopq_' → 'abcdefghijklmnopq' + '10'.
    expect(withNumberSuffix('abcdefghijklmnopq_rs', 10)).toBe('abcdefghijklmnopq10');
  });

  it('keeps trailing _ when trimming would leave it too short (review R1)', () => {
    expect(withNumberSuffix('___', 1)).toBe('___1');
    expect(withNumberSuffix('a__', 1)).toBe('a__1');
  });

  it('refuses an invalid base, but suffixes a reserved one (review R4)', () => {
    expect(() => withNumberSuffix('.abc', 1)).toThrow(RangeError);
    expect(withNumberSuffix('admin', 1)).toBe('admin1');
  });

  it.each([1, 9, 10, 9999])('16: outputs pass V for n = %d', (n) => {
    for (const base of ['abc', 'yash_saraiya', 'a'.repeat(20), 'a.' + 'b'.repeat(18), 'abcdefghijklmnopq_rs', '___', 'a__', '_._']) {
      const out = withNumberSuffix(base, n);
      expect(out.length).toBeLessThanOrEqual(20);
      expect(out.endsWith(String(n))).toBe(true);
      expect(validateUsername(out)).toEqual({ ok: true });
    }
  });

  it.each([0, 1, 9, 10, 42, 9999])('16: fallbackUsername(%d) passes V', (n) => {
    const out = fallbackUsername(n);
    expect(out).toBe('user' + String(n).padStart(4, '0'));
    expect(validateUsername(out)).toEqual({ ok: true });
  });

  it('rejects numbers outside the contract range', () => {
    expect(() => withNumberSuffix('abc', 0)).toThrow(RangeError);
    expect(() => withNumberSuffix('abc', 10000)).toThrow(RangeError);
    expect(() => withNumberSuffix('abc', 1.5)).toThrow(RangeError);
    expect(() => fallbackUsername(-1)).toThrow(RangeError);
    expect(() => fallbackUsername(10000)).toThrow(RangeError);
  });
});

describe('USERNAME_ERROR_COPY (criterion 19)', () => {
  // The 'taken' line is split so criterion 19's grep for that sentence matches only lib/username.ts.
  const EXPECTED: Record<SetUsernameReason, string> = {
    too_short: 'Usernames are at least 3 characters.',
    too_long: 'Usernames are at most 20 characters.',
    invalid_chars: 'Use only letters, numbers, _ and .',
    bad_dots: "A dot can't come first, last, or next to another dot.",
    reserved: 'That username is reserved. Try another one.',
    taken: 'That username is ' + 'taken. Try another one.',
    invalid: "That username isn't allowed. Try another one.",
    locked: "Your username is already set, and it can't be changed.",
    not_allowed: "Couldn't save to your profile. Sign out, sign back in, then try again.",
    error: "Couldn't save. Check your connection and try again.",
  };

  it('has exactly one entry per reason, matching the copy table', () => {
    expect(USERNAME_ERROR_COPY).toEqual(EXPECTED);
    expect(Object.keys(USERNAME_ERROR_COPY).sort()).toEqual(
      ['too_short', 'too_long', 'invalid_chars', 'bad_dots', 'reserved', 'taken', 'invalid', 'locked', 'not_allowed', 'error'].sort(),
    );
  });
});

// Amendment A3.5: alternatives when the picked name is taken.
describe('suggestTakenAlternatives', () => {
  /** A deterministic RNG that replays `values` in a loop. */
  const seq = (values: number[]): (() => number) => {
    let i = 0;
    return () => values[i++ % values.length] ?? 0;
  };
  /** A seeded linear congruential generator, for property runs. */
  const lcg = (seed: number): (() => number) => {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  };

  it('picks 3 or 4 digits from the RNG and appends them (exact values)', () => {
    // Pairs: (choose length, choose number). < 0.5 → 4 digits (1000 + ⌊r·9000⌋), else 3 (100 + ⌊r·900⌋).
    const rng = seq([0.9, 0.0, 0.1, 0.0, 0.9, 0.5, 0.1, 0.999, 0.6, 0.25]);
    expect(suggestTakenAlternatives('yash_saraiya', rng)).toEqual([
      'yash_saraiya100',
      'yash_saraiya1000',
      'yash_saraiya550',
      'yash_saraiya9991',
      'yash_saraiya325',
    ]);
  });

  it('cuts a 20-character base so the digits fit, by withNumberSuffix\'s rule', () => {
    const base = 'abcdefghijklmnopqrst';
    const rng = seq([0.9, 0.0, 0.1, 0.0]);
    const out = suggestTakenAlternatives(base, rng, 3);
    expect(out[0]).toBe('abcdefghijklmnopq100');
    expect(out[1]).toBe('abcdefghijklmnop1000');
    for (const c of out) expect(c.length).toBe(20);
  });

  it('trims a trailing _ at the cut, and keeps an all-underscore base valid', () => {
    expect(suggestTakenAlternatives('abcdefghijklmnop_rst', seq([0.1, 0.0]), 3)[0]).toBe('abcdefghijklmnop1000');
    // withNumberSuffix's rule trims the trailing '_' when 3+ characters remain, so an all-underscore
    // base loses itself ('___' + 100 → '100'). Valid, but the base is gone: the open Q2 case from
    // the 2026-11-28 lesson, pinned here so a rule change shows up.
    const under = suggestTakenAlternatives('___', seq([0.9, 0.0]), 3);
    expect(under[0]).toBe('100');
    for (const c of under) expect(validateUsername(c)).toEqual({ ok: true });
  });

  it('a reserved base gets alternatives (admin → admin<digits>)', () => {
    const out = suggestTakenAlternatives('admin', seq([0.9, 0.0]), 3);
    expect(out[0]).toBe('admin100');
    for (const c of out) expect(validateUsername(c)).toEqual({ ok: true });
  });

  it('a stuck RNG still gives the full count, distinct, with no duplicate of the base', () => {
    const out = suggestTakenAlternatives('sam', () => 0.9);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    expect(out).not.toContain('sam');
    expect(out[0]).toBe('sam910');
  });

  it('a broken RNG (NaN, out of range) never makes a number outside 100–9999', () => {
    for (const bad of [Number.NaN, -1, 1, 2, Infinity]) {
      for (const c of suggestTakenAlternatives('sam', () => bad)) {
        expect(c).toMatch(/^sam\d{3,4}$/);
        expect(validateUsername(c)).toEqual({ ok: true });
      }
    }
  });

  it('count is 3 to 5 (default 5); anything else throws', () => {
    expect(suggestTakenAlternatives('sam', lcg(1))).toHaveLength(5);
    expect(suggestTakenAlternatives('sam', lcg(1), 3)).toHaveLength(3);
    expect(() => suggestTakenAlternatives('sam', lcg(1), 2)).toThrow(RangeError);
    expect(() => suggestTakenAlternatives('sam', lcg(1), 6)).toThrow(RangeError);
    expect(() => suggestTakenAlternatives('sam', lcg(1), 4.5)).toThrow(RangeError);
  });

  it('an invalid base throws RangeError, as withNumberSuffix does', () => {
    expect(() => suggestTakenAlternatives('Yash', lcg(1))).toThrow(RangeError);
    expect(() => suggestTakenAlternatives('ab', lcg(1))).toThrow(RangeError);
  });

  it('is pure: the same RNG sequence gives the same output', () => {
    expect(suggestTakenAlternatives('yash_s', lcg(42))).toEqual(suggestTakenAlternatives('yash_s', lcg(42)));
  });

  it('property: for 200 seeds and bases of every length, each output is valid, distinct, base + 3–4 digits', () => {
    const bases = ['abc', 'a.b', '___', 'yash_saraiya', 'a'.repeat(16), 'a'.repeat(17), 'a'.repeat(20), 'a.' + 'b'.repeat(18), 'x_'.repeat(10).slice(0, 20)];
    for (let seed = 0; seed < 200; seed++) {
      for (const base of bases) {
        const out = suggestTakenAlternatives(base, lcg(seed * 31 + base.length));
        expect(out).toHaveLength(5);
        expect(new Set(out).size).toBe(5);
        for (const c of out) {
          expect(validateUsername(c)).toEqual({ ok: true });
          expect(c).not.toBe(base);
          const digits = /\d{3,4}$/.exec(c)?.[0] ?? '';
          expect(digits.length === 3 || digits.length === 4).toBe(true);
          const n = Number(digits);
          expect(c).toBe(withNumberSuffix(base, n));
        }
      }
    }
  });
});
