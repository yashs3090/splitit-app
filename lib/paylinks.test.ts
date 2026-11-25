import { Linking, Platform } from 'react-native';

import {
  claimedItemNames,
  encodeVenmoNote,
  isSettleCents,
  openPaymentLink,
  SETTLE_MAX_CENTS,
  SETTLE_MIN_CENTS,
  SETTLE_NOTE,
  VENMO_LINK_FORMAT,
  VENMO_NOTE_INCLUDES_ITEMS,
  VENMO_NOTE_MAX,
  venmoNote,
  venmoNoteWith,
  venmoPayUrl,
  venmoPayUrlForFormat,
  venmoRequestUrl,
  venmoRequestUrlForFormat,
  type VenmoLinkFormat,
  type VenmoPayInput,
} from './paylinks';

describe('SETTLE_NOTE and VENMO_LINK_FORMAT (spec C5, Q7)', () => {
  it('starts as the fixed note "SplitIt" and the V1 format', () => {
    expect(SETTLE_NOTE).toBe('SplitIt');
    expect(VENMO_LINK_FORMAT).toBe('v1');
  });
});

describe('isSettleCents (rule C2)', () => {
  it('accepts 1 through 99,999,999 and nothing else', () => {
    expect(SETTLE_MIN_CENTS).toBe(1);
    expect(SETTLE_MAX_CENTS).toBe(99_999_999);
    expect(isSettleCents(1)).toBe(true); // A2
    expect(isSettleCents(99_999_999)).toBe(true); // A3
    expect(isSettleCents(0)).toBe(false); // A1
    expect(isSettleCents(100_000_000)).toBe(false); // A4
    expect(isSettleCents(-5)).toBe(false); // A5
    expect(isSettleCents(null)).toBe(false); // A6
    expect(isSettleCents(12.5)).toBe(false); // A7
    expect(isSettleCents(Number.NaN)).toBe(false);
    expect(isSettleCents(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSettleCents('15')).toBe(false);
  });
});

describe('venmoPayUrl (criteria 25–28)', () => {
  it('criterion 25: builds the exact V1 and V2 URLs', () => {
    expect(venmoPayUrlForFormat('v1', { username: 'Jane-Doe_99', cents: 1510 })).toBe(
      'https://venmo.com/?txn=pay&recipients=Jane-Doe_99&amount=15.10&note=SplitIt',
    );
    expect(venmoPayUrlForFormat('v2', { username: 'Jane-Doe_99', cents: 1510 })).toBe(
      'https://venmo.com/Jane-Doe_99?txn=pay&amount=15.10&note=SplitIt',
    );
  });

  it('criterion 25: venmoPayUrl uses VENMO_LINK_FORMAT', () => {
    const input = { username: 'Jane-Doe_99', cents: 1510 };
    expect(venmoPayUrl(input)).toBe(venmoPayUrlForFormat(VENMO_LINK_FORMAT, input));
    expect(venmoPayUrl(input)).toBe('https://venmo.com/?txn=pay&recipients=Jane-Doe_99&amount=15.10&note=SplitIt');
  });

  it('criterion 26: amount text has two decimals, no $ and no commas', () => {
    const amountOf = (cents: number) => {
      const url = venmoPayUrl({ username: 'hana-1', cents });
      if (url === null) throw new Error(`no url for ${cents}`);
      return new URL(url).searchParams.get('amount');
    };
    expect(amountOf(1)).toBe('0.01');
    expect(amountOf(5)).toBe('0.05');
    expect(amountOf(100)).toBe('1.00');
    expect(amountOf(123_450)).toBe('1234.50');
    expect(amountOf(99_999_999)).toBe('999999.99');
  });

  it('criterion 27: returns null for amounts outside C2', () => {
    for (const cents of [0, -1, 12.5, Number.NaN, 100_000_000]) {
      expect(venmoPayUrl({ username: 'hana-1', cents })).toBeNull();
      expect(venmoPayUrlForFormat('v2', { username: 'hana-1', cents })).toBeNull();
    }
  });

  it('criterion 27: returns null for usernames that fail VENMO_USERNAME_PATTERN', () => {
    for (const username of [null, '', 'abcd', '@abcde', 'abc de', 'josé1']) {
      expect(venmoPayUrl({ username, cents: 1510 })).toBeNull();
      expect(venmoPayUrlForFormat('v2', { username, cents: 1510 })).toBeNull();
    }
  });

  it('accepts the username length boundaries (5 and 30)', () => {
    expect(venmoPayUrl({ username: 'abcde', cents: 1 })).not.toBeNull();
    expect(venmoPayUrl({ username: 'a'.repeat(30), cents: 1 })).not.toBeNull();
    expect(venmoPayUrl({ username: 'a'.repeat(31), cents: 1 })).toBeNull();
  });

  it('criterion 28: the note goes through encodeURIComponent', () => {
    expect(encodeVenmoNote('Dinner & drinks #1')).toBe('Dinner%20%26%20drinks%20%231');
    expect(encodeVenmoNote(SETTLE_NOTE)).toBe('SplitIt');
  });

  it('criterion 28: venmoPayUrl ignores any extra note field (no note parameter)', () => {
    // A caller can't smuggle a note in; the type has no such field and the runtime ignores it.
    const sneaky = { username: 'hana-1', cents: 1510, note: 'Sam owes for beer' } as unknown as Parameters<
      typeof venmoPayUrl
    >[0];
    expect(venmoPayUrl(sneaky)).toBe('https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt');
  });
});

describe('openPaymentLink (criterion 30)', () => {
  const URL_V1 = 'https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt';
  let openURL: jest.SpiedFunction<typeof Linking.openURL>;

  beforeEach(() => {
    openURL = jest.spyOn(Linking, 'openURL');
  });
  afterEach(() => {
    openURL.mockRestore();
  });

  it.each(['ios', 'android', 'web'] as const)('on %s calls Linking.openURL once with the url', async (os) => {
    const restore = jest.replaceProperty(Platform, 'OS', os);
    try {
      openURL.mockResolvedValueOnce(true);
      await expect(openPaymentLink(URL_V1)).resolves.toEqual({ ok: true });
      expect(openURL).toHaveBeenCalledTimes(1);
      expect(openURL).toHaveBeenCalledWith(URL_V1);
    } finally {
      restore.restore();
    }
  });

  it.each(['ios', 'android', 'web'] as const)(
    'on %s calls Linking.openURL synchronously, before the returned promise is awaited (web popup rule, R8)',
    async (os) => {
      const restore = jest.replaceProperty(Platform, 'OS', os);
      try {
        openURL.mockResolvedValueOnce(true);
        const pending = openPaymentLink(URL_V1); // not awaited yet
        expect(openURL).toHaveBeenCalledTimes(1);
        expect(openURL).toHaveBeenCalledWith(URL_V1);
        await expect(pending).resolves.toEqual({ ok: true });
      } finally {
        restore.restore();
      }
    },
  );

  it.each(['ios', 'android', 'web'] as const)('on %s returns { ok: false } when openURL rejects', async (os) => {
    const restore = jest.replaceProperty(Platform, 'OS', os);
    try {
      openURL.mockRejectedValueOnce(new Error('No app can open this'));
      await expect(openPaymentLink(URL_V1)).resolves.toEqual({ ok: false });
      expect(openURL).toHaveBeenCalledTimes(1);
    } finally {
      restore.restore();
    }
  });

  it('returns { ok: false } when openURL throws synchronously', async () => {
    openURL.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(openPaymentLink(URL_V1)).resolves.toEqual({ ok: false });
  });
});

// ---- Venmo note with item names (docs/specs/2026-11-25-venmo-note-item-names.md) ----

const cp = (s: string) => Array.from(s).length;
const P = 'SplitIt: ';
const a = (n: number) => 'a'.repeat(n);
const b = (n: number) => 'b'.repeat(n);
const x = (n: number) => 'x'.repeat(n);
const B2 = ['Carnitas Bowl', 'Chicken Burrito'];

describe('venmoNote (criterion 1, boundary cases B1–B20)', () => {
  const rows: [string, readonly string[], string, number][] = [
    ['B1', [], 'SplitIt', 7],
    ['B2', B2, 'SplitIt: Carnitas Bowl, Chicken Burrito', 39],
    ['B3', [...B2, 'Chips'], 'SplitIt: Carnitas Bowl, Chicken Burrito + 1 more', 48],
    ['B4', [...B2, 'Chips', 'Guac', 'Horchata'], 'SplitIt: Carnitas Bowl, Chicken Burrito + 3 more', 48],
    ['B5', ['Margarita', 'Margarita', 'Nachos'], 'SplitIt: Margarita, Nachos', 26],
    ['B6', ['  ', '', '\n'], 'SplitIt', 7],
    ['B7', ['  Fish \n Tacos  '], 'SplitIt: Fish Tacos', 19],
    ['B8', [x(91)], P + x(91), 100],
    ['B9', [x(92)], P + x(90) + '…', 100],
    ['B10', [a(44), b(45)], P + a(44) + ', ' + b(45), 100],
    ['B11', [a(44), b(46)], P + a(44) + ' + 1 more', 62],
    ['B12', [a(40), b(40), 'Chips'], P + a(40) + ', ' + b(40) + ' + 1 more', 100],
    ['B13', [a(40), b(41), 'Chips'], P + a(40) + ' + 2 more', 58],
    ['B14', [x(82), b(20)], P + x(82) + ' + 1 more', 100],
    ['B15', [x(83), b(20)], P + x(81) + '…' + ' + 1 more', 100],
    ['B15b', [x(82), 'Fries'], P + x(82) + ', Fries', 98],
    ['B16', [x(200)], P + x(90) + '…', 100],
    ['B17', ['🌮'.repeat(95)], P + '🌮'.repeat(90) + '…', 100],
    ['B18', ['\uD800Fries'], 'SplitIt: �Fries', 15],
    ['B19', ['Mac, Cheese'], 'SplitIt: Mac, Cheese', 20],
  ];

  it.each(rows)('%s', (_id, names, note, length) => {
    const out = venmoNote(names);
    expect(out).toBe(note);
    expect(cp(out)).toBe(length);
  });

  it('B20: with the kill switch off, the note is plain SplitIt', () => {
    const out = venmoNoteWith(B2, false);
    expect(out).toBe('SplitIt');
    expect(cp(out)).toBe(7);
  });

  it('venmoNote uses the switch as configured (on) and the limit starts at 100', () => {
    expect(VENMO_NOTE_INCLUDES_ITEMS).toBe(true);
    expect(VENMO_NOTE_MAX).toBe(100);
    expect(venmoNoteWith(B2, true)).toBe(venmoNote(B2));
  });

  it('B17: the clipped note never splits a surrogate pair', () => {
    const out = venmoNote(['🌮'.repeat(95)]);
    expect(() => encodeURIComponent(out)).not.toThrow();
  });

  it('a lone low surrogate and a lone high surrogate at the end are both replaced', () => {
    expect(venmoNote(['Fries\uDC00', 'Tea\uD83C'])).toBe('SplitIt: Fries�, Tea�');
  });
});

/** Mulberry32: a small seeded PRNG so the random test is repeatable. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The spec's N2 cleaning, written independently for the test. */
function cleanForTest(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    let fixed = '';
    for (let i = 0; i < raw.length; i++) {
      const u = raw.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        const next = raw.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          fixed += raw[i]! + raw[i + 1]!;
          i++;
        } else fixed += '�';
      } else if (u >= 0xdc00 && u <= 0xdfff) fixed += '�';
      else fixed += raw[i]!;
    }
    const name = fixed.replace(/\s+/gu, ' ').trim();
    if (name !== '' && !out.includes(name)) out.push(name);
  }
  return out;
}

describe('venmoNote (criterion 2, 500 seeded random name lists)', () => {
  const POOL = ['a', 'Z', '7', ' ', ' ', '\n', '\t', ',', '+', '&', '#', '%', '…', 'é', '🌮', '𝔸', '\uD800', '\uDC00'];

  it('never throws, stays within the limit and shows at most 2 names with the right "+ N more"', () => {
    const rand = seeded(20261125);
    const int = (max: number) => Math.floor(rand() * (max + 1));
    for (let run = 0; run < 500; run++) {
      const names = Array.from({ length: int(10) }, () => {
        // A small pool most of the time so repeats (de-duplication) actually happen.
        if (rand() < 0.2) return ['Chips', 'Guac', ' Chips '][int(2)]!;
        return Array.from({ length: int(150) }, () => POOL[int(POOL.length - 1)]!).join('');
      });
      let out = '';
      expect(() => {
        out = venmoNote(names);
      }).not.toThrow();
      expect(cp(out)).toBeLessThanOrEqual(VENMO_NOTE_MAX);
      expect(out.startsWith('SplitIt')).toBe(true);
      expect(() => encodeURIComponent(out)).not.toThrow();

      const clean = cleanForTest(names);
      const n = clean.length;
      const suffix = (m: number) => (m > 0 ? ` + ${m} more` : '');
      if (n === 0) {
        expect(out).toBe('SplitIt');
        continue;
      }
      // Which k (names shown) produced the result: whole names first, then the clipped first name.
      let k: number | null = null;
      for (let tryK = Math.min(2, n); tryK >= 1 && k === null; tryK--) {
        if (out === P + clean.slice(0, tryK).join(', ') + suffix(n - tryK)) k = tryK;
      }
      if (k === null) {
        k = 1;
        const tail = '…' + suffix(n - 1);
        expect(out.endsWith(tail)).toBe(true);
        expect(cp(out)).toBe(VENMO_NOTE_MAX);
        const shown = out.slice(P.length, out.length - tail.length);
        expect(Array.from(clean[0]!).slice(0, cp(shown)).join('')).toBe(shown);
      }
      expect(k).toBeLessThanOrEqual(2);
      expect(out.endsWith(` + ${n - k} more`)).toBe(n > k);
    }
  });
});

describe('claimedItemNames (criterion 3)', () => {
  // M3 worked bill: Burger Hana; Salad Sam; Fries Hana + Sam. Plus unit rows and a discount.
  const HANA = 'hana';
  const SAM = 'sam';
  const rows = [
    { id: 'burger', name: 'Burger' },
    { id: 'salad', name: 'Salad', kind: 'item' as const },
    { id: 'fries', name: 'Fries' },
    { id: 'marg-1', name: 'Margarita' },
    { id: 'marg-2', name: 'Margarita' },
    { id: 'comp', name: 'Police comp', kind: 'discount' as const },
  ];
  const cl = (line_item_id: string, user_id: string, parts = 1) => ({ line_item_id, user_id, parts });
  const worked = [cl('burger', HANA), cl('salad', SAM), cl('fries', HANA), cl('fries', SAM)];

  it('returns the viewer’s own claimed rows, shared ones included (U1)', () => {
    expect(claimedItemNames(rows, worked, SAM)).toEqual(['Salad', 'Fries']);
    expect(claimedItemNames(rows, worked, HANA)).toEqual(['Burger', 'Fries']);
  });

  it('leaves out a claimed discount row (U2)', () => {
    expect(claimedItemNames(rows, [...worked, cl('comp', SAM)], SAM)).toEqual(['Salad', 'Fries']);
  });

  it('lists each claimed unit row (de-duplicated later by venmoNote)', () => {
    expect(claimedItemNames(rows, [cl('marg-1', SAM), cl('marg-2', SAM)], SAM)).toEqual(['Margarita', 'Margarita']);
    expect(claimedItemNames(rows, [cl('marg-2', SAM)], SAM)).toEqual(['Margarita']);
  });

  it('returns [] for a user with no claims, and a parts: 0 claim does not count', () => {
    expect(claimedItemNames(rows, worked, 'dee')).toEqual([]);
    expect(claimedItemNames(rows, [cl('salad', SAM, 0)], SAM)).toEqual([]);
  });

  it('follows the order of rows, not claims', () => {
    expect(claimedItemNames(rows, [...worked].reverse(), SAM)).toEqual(['Salad', 'Fries']);
  });

  it('returns names raw (cleaning is venmoNote’s job)', () => {
    expect(claimedItemNames([{ id: 'r', name: '  Fish \n Tacos ' }], [cl('r', SAM)], SAM)).toEqual(['  Fish \n Tacos ']);
  });
});

describe('venmoPayUrl with item names (criterion 4)', () => {
  const B3_NAMES = ['Carnitas Bowl', 'Chicken Burrito', 'Chips'];
  const NOTE = '&note=SplitIt%3A%20Carnitas%20Bowl%2C%20Chicken%20Burrito%20%2B%201%20more';

  it('builds the exact V1 URL and the V2 form ends with the same note', () => {
    expect(venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames: B3_NAMES })).toBe(
      `https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10${NOTE}`,
    );
    expect(venmoPayUrlForFormat('v2', { username: 'hana-1', cents: 1510, itemNames: B3_NAMES })).toBe(
      `https://venmo.com/hana-1?txn=pay&amount=15.10${NOTE}`,
    );
  });

  it('the decoded note is the B3 text (spaces are not +)', () => {
    for (const format of ['v1', 'v2'] as const) {
      const url = venmoPayUrlForFormat(format, { username: 'hana-1', cents: 1510, itemNames: B3_NAMES });
      if (url === null) throw new Error('no url');
      expect(new URL(url).searchParams.get('note')).toBe('SplitIt: Carnitas Bowl, Chicken Burrito + 1 more');
    }
  });

  it('with itemNames: [] the URL is unchanged from before', () => {
    expect(venmoPayUrl({ username: 'hana-1', cents: 1510, itemNames: [] })).toBe(
      'https://venmo.com/?txn=pay&recipients=hana-1&amount=15.10&note=SplitIt',
    );
    expect(venmoPayUrlForFormat('v2', { username: 'hana-1', cents: 1510, itemNames: [] })).toBe(
      'https://venmo.com/hana-1?txn=pay&amount=15.10&note=SplitIt',
    );
  });

  it('still returns null for a bad username or cents when itemNames is non-empty', () => {
    for (const format of ['v1', 'v2'] as const) {
      expect(venmoPayUrlForFormat(format, { username: 'abc de', cents: 1510, itemNames: B3_NAMES })).toBeNull();
      expect(venmoPayUrlForFormat(format, { username: null, cents: 1510, itemNames: B3_NAMES })).toBeNull();
      expect(venmoPayUrlForFormat(format, { username: 'hana-1', cents: 0, itemNames: B3_NAMES })).toBeNull();
      expect(venmoPayUrlForFormat(format, { username: 'hana-1', cents: 100_000_000, itemNames: B3_NAMES })).toBeNull();
    }
  });
});

// Venmo Request links (docs/specs/2026-11-25-venmo-request-buttons.md, R1, criteria 1–5).
describe('venmoRequestUrl (request spec criteria 1–5)', () => {
  const FORMATS = ['v1', 'v2'] as const;
  const B3_NAMES = ['Carnitas Bowl', 'Chicken Burrito', 'Chips'];
  const payAsCharge = (format: VenmoLinkFormat, input: VenmoPayInput) =>
    venmoPayUrlForFormat(format, input)?.replace('txn=pay', 'txn=charge') ?? null;

  it('criterion 1: the URL the user confirmed on iPhone, with and without empty itemNames', () => {
    const confirmed = 'https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=0.01&note=SplitIt';
    expect(venmoRequestUrl({ username: 'Tejesh-Bhaumik', cents: 1, itemNames: [] })).toBe(confirmed);
    expect(venmoRequestUrl({ username: 'Tejesh-Bhaumik', cents: 1 })).toBe(confirmed);
  });

  it('criterion 1: with B3 item names the note is the note spec criterion 4 note', () => {
    expect(venmoRequestUrl({ username: 'Tejesh-Bhaumik', cents: 1510, itemNames: B3_NAMES })).toBe(
      'https://venmo.com/?txn=charge&recipients=Tejesh-Bhaumik&amount=15.10&note=SplitIt%3A%20Carnitas%20Bowl%2C%20Chicken%20Burrito%20%2B%201%20more',
    );
  });

  it('V2 is the same shape as the V2 pay link with txn=charge', () => {
    expect(venmoRequestUrlForFormat('v2', { username: 'Tejesh-Bhaumik', cents: 1510 })).toBe(
      'https://venmo.com/Tejesh-Bhaumik?txn=charge&amount=15.10&note=SplitIt',
    );
  });

  const USERNAMES_OK = ['Jane-Doe_99', 'abcde', 'a'.repeat(30)];
  const USERNAMES_BAD: (string | null)[] = ['abcd', 'a'.repeat(31), '@hana-1', 'ab cd', null, ''];
  const CENTS: number[] = [1, 1510, 99_999_999, 0, 100_000_000, -5, 12.5, Number.NaN];
  const NAME_LISTS: (readonly string[] | undefined)[] = [
    undefined,
    [], // B1
    ['x'.repeat(92)], // B9
    ['x'.repeat(83), 'b'.repeat(20)], // B15
    ['🌮'.repeat(95)], // B17
    ['\uD800Fries'], // B18
  ];

  it('criterion 2: same-input equivalence with the pay link over a fixed table, both formats', () => {
    let checked = 0;
    for (const format of FORMATS) {
      for (const username of [...USERNAMES_OK, ...USERNAMES_BAD]) {
        for (const cents of CENTS) {
          for (const itemNames of NAME_LISTS) {
            const input: VenmoPayInput = itemNames === undefined ? { username, cents } : { username, cents, itemNames };
            expect(venmoRequestUrlForFormat(format, input)).toBe(payAsCharge(format, input));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(2 * 9 * 8 * 6);
  });

  it('criterion 2: same-input equivalence over 200 seeded random inputs, both formats', () => {
    const POOL = ['a', 'Z', '7', ' ', '\n', ',', '+', '&', '#', '%', '?', '=', '…', 'é', '🌮', '𝔸', '\uD800', '\uDC00'];
    const rand = seeded(20261126);
    const int = (max: number) => Math.floor(rand() * (max + 1));
    let withUrl = 0;
    for (let run = 0; run < 200; run++) {
      const itemNames = Array.from({ length: int(8) }, () =>
        Array.from({ length: int(120) }, () => POOL[int(POOL.length - 1)]!).join(''),
      );
      const username = rand() < 0.8 ? USERNAMES_OK[int(USERNAMES_OK.length - 1)]! : USERNAMES_BAD[int(USERNAMES_BAD.length - 1)]!;
      const cents = rand() < 0.8 ? 1 + int(SETTLE_MAX_CENTS - 1) : CENTS[int(CENTS.length - 1)]!;
      for (const format of FORMATS) {
        const input = { username, cents, itemNames };
        const url = venmoRequestUrlForFormat(format, input);
        expect(url).toBe(payAsCharge(format, input));
        if (url !== null) {
          withUrl++;
          expect(url).toContain('txn=charge');
          expect(url).not.toContain('txn=pay');
        }
      }
    }
    expect(withUrl).toBeGreaterThan(100); // most random inputs are valid, so this isn't null === null
  });

  it('criterion 3: amount boundaries (C2), both formats', () => {
    for (const format of FORMATS) {
      const at = (cents: number) => venmoRequestUrlForFormat(format, { username: 'Tejesh-Bhaumik', cents });
      expect(at(1)).toContain('amount=0.01&');
      expect(at(99_999_999)).toContain('amount=999999.99&');
      for (const bad of [0, 100_000_000, -5, 12.5, Number.NaN]) expect(at(bad)).toBeNull();
    }
  });

  it('criterion 3: username boundaries, both formats', () => {
    for (const format of FORMATS) {
      const as = (username: string | null) => venmoRequestUrlForFormat(format, { username, cents: 1510 });
      expect(as('a'.repeat(5))).not.toBeNull();
      expect(as('a'.repeat(30))).not.toBeNull();
      for (const bad of ['a'.repeat(4), 'a'.repeat(31), '@hana-1', 'ab cd', null]) expect(as(bad)).toBeNull();
    }
  });

  it('criterion 4: venmoRequestUrl uses VENMO_LINK_FORMAT (v1 today)', () => {
    const input = { username: 'Tejesh-Bhaumik', cents: 1510, itemNames: B3_NAMES };
    expect(VENMO_LINK_FORMAT).toBe('v1');
    expect(venmoRequestUrl(input)).toBe(venmoRequestUrlForFormat(VENMO_LINK_FORMAT, input));
  });

  it('the pay link is unchanged by the txn widening', () => {
    expect(venmoPayUrl({ username: 'Tejesh-Bhaumik', cents: 1 })).toBe(
      'https://venmo.com/?txn=pay&recipients=Tejesh-Bhaumik&amount=0.01&note=SplitIt',
    );
  });
});
