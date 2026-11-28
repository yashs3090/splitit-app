// Contract M (docs/specs/2026-11-26-sent-via-venmo.md D1; criterion 22): the payment-method list, its
// copy, and the drift test against the database's one list, private.is_payment_method.
import {
  availableMethods,
  isPaymentMethod,
  isRememberedMethod,
  methodMarkLine,
  methodOwnPill,
  methodRowStatus,
  parseIsPaymentMethodList,
  PAYMENT_METHOD_COPY,
  PAYMENT_METHODS,
  type PaymentMethod,
} from './paymentMethods';

const fs = jest.requireActual<{
  readFileSync(file: string, encoding: 'utf8'): string;
  readdirSync(dir: string): string[];
}>('fs');

const MIGRATIONS = `${process.cwd()}/supabase/migrations`;

describe('PAYMENT_METHODS and isPaymentMethod', () => {
  it('is venmo, cash, other, in that order', () => {
    expect(PAYMENT_METHODS).toEqual(['venmo', 'cash', 'other']);
  });

  it.each(PAYMENT_METHODS)('accepts %s', (m) => {
    expect(isPaymentMethod(m)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['zelle', 'zelle'],
    ['a capitalised Venmo', 'Venmo'],
    ['a padded cash', ' cash'],
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an array', ['venmo']],
    ['an inherited key', 'toString'],
  ])('rejects %s', (_label, v) => {
    expect(isPaymentMethod(v)).toBe(false);
  });
});

describe('availableMethods (the chooser options; "Paid another way" is always a separate link)', () => {
  it('offers Venmo then Cash when the payer has a valid Venmo username', () => {
    expect(availableMethods('hana-1')).toEqual(['venmo', 'cash']);
  });

  it.each<[string, string | null]>([
    ['no username', null],
    ['an empty username', ''],
    ['a username with @', '@hana-1'],
    ['a too-short username', 'abcd'],
  ])('offers Cash only with %s (SV-29)', (_label, username) => {
    expect(availableMethods(username)).toEqual(['cash']);
  });

  it('never offers other (it is the "Paid another way" link, not a chooser option)', () => {
    expect(availableMethods('hana-1')).not.toContain('other');
    expect(availableMethods(null)).not.toContain('other');
  });
});

describe('copy by method (D1 table)', () => {
  it('has one entry per method and no others', () => {
    expect(Object.keys(PAYMENT_METHOD_COPY).sort()).toEqual([...PAYMENT_METHODS].sort());
  });

  it.each<[PaymentMethod, string | null, string, string]>([
    ['venmo', 'Venmo', 'Sent via Venmo', 'Sent via Venmo'],
    ['cash', 'Cash', 'Paid in cash', 'Paid in cash'],
    ['other', null, 'Marked paid', 'Paid'],
  ])('%s: chooser label, mark line, row status', (m, chooser, markLine, rowStatus) => {
    expect(PAYMENT_METHOD_COPY[m].chooserLabel).toBe(chooser);
    expect(methodMarkLine(m)).toBe(markLine);
    expect(methodRowStatus(m)).toBe(rowStatus);
  });

  it.each<[PaymentMethod, number, string]>([
    ['venmo', 1510, 'Sent $15.10'],
    ['cash', 1510, 'Paid $15.10 in cash'],
    ['other', 1510, 'Paid $15.10'],
    ['venmo', 1, 'Sent $0.01'],
    ['cash', 1, 'Paid $0.01 in cash'],
    ['other', 1, 'Paid $0.01'],
  ])("%s: the person's own Home pill at %i cents", (m, cents, pill) => {
    expect(methodOwnPill(m, cents)).toBe(pill);
  });

  it('never says "Confirmed", and Venmo never says "Paid" (decision 1)', () => {
    for (const m of PAYMENT_METHODS) {
      const all = [PAYMENT_METHOD_COPY[m].chooserLabel ?? '', methodMarkLine(m), methodRowStatus(m), methodOwnPill(m, 1510)];
      for (const s of all) expect(s).not.toMatch(/confirm/i);
    }
    expect([methodMarkLine('venmo'), methodRowStatus('venmo'), methodOwnPill('venmo', 1510)].join(' ')).not.toMatch(/paid/i);
  });
});

describe('parseIsPaymentMethodList (the drift test reader)', () => {
  it('reads the quoted list from a function definition', () => {
    const sql = `
      create or replace function private.is_payment_method(p text)
      returns boolean language sql immutable set search_path = ''
      as $$ select p in ('venmo', 'cash', 'other') $$;`;
    expect(parseIsPaymentMethodList(sql)).toEqual(['venmo', 'cash', 'other']);
  });

  it('reads a list without spaces, in upper-case SQL, with a different parameter name', () => {
    const sql = `CREATE FUNCTION private.is_payment_method(p_method text) RETURNS boolean LANGUAGE sql IMMUTABLE
      AS $fn$ SELECT p_method IN ('venmo','cash','other','zelle') $fn$;`;
    expect(parseIsPaymentMethodList(sql)).toEqual(['venmo', 'cash', 'other', 'zelle']);
  });

  it('returns the newest definition when one file defines it twice', () => {
    const sql = `
      create function private.is_payment_method(p text) returns boolean language sql as $$ select p in ('venmo') $$;
      create or replace function private.is_payment_method(p text) returns boolean language sql as $$ select p in ('venmo', 'cash') $$;`;
    expect(parseIsPaymentMethodList(sql)).toEqual(['venmo', 'cash']);
  });

  it('returns null when the file does not define the function (a call is not a definition)', () => {
    expect(parseIsPaymentMethodList(`check (private.is_payment_method(settled_method))`)).toBeNull();
    expect(parseIsPaymentMethodList('select 1;')).toBeNull();
  });

  it('a list that differs from PAYMENT_METHODS fails the comparison (positive control)', () => {
    const differing = parseIsPaymentMethodList(
      `create function private.is_payment_method(p text) returns boolean language sql as $$ select p in ('venmo', 'cash') $$;`,
    );
    expect(() => expect([...(differing ?? [])].sort()).toEqual([...PAYMENT_METHODS].sort())).toThrow();
  });
});

describe('criterion 22: PAYMENT_METHODS equals the newest private.is_payment_method in supabase/migrations', () => {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  // Newest first: the last migration (by timestamp) that defines the function is the live list.
  const newest = [...files]
    .reverse()
    .map((f) => ({ file: f, list: parseIsPaymentMethodList(fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8')) }))
    .find((x) => x.list !== null);

  it('finds a migration that defines private.is_payment_method', () => {
    // Fails until Task 2's migration (…_sent_via_venmo.sql) is on disk: a drift test must never pass
    // without the list it compares against.
    expect(newest?.file).toEqual(expect.any(String));
  });

  it('has exactly the same methods (order is not meaningful in SQL `in (...)`)', () => {
    expect(newest?.list).toEqual(expect.any(Array));
    expect([...(newest?.list ?? [])].sort()).toEqual([...PAYMENT_METHODS].sort());
    expect(new Set(newest?.list).size).toBe(newest?.list?.length);
  });
});

describe('isRememberedMethod (review R9): the chooser methods, derived from the copy table', () => {
  it('venmo and cash only', () => {
    expect(PAYMENT_METHODS.filter((m) => isRememberedMethod(m))).toEqual(['venmo', 'cash']);
  });
  it('is the same set as the methods with a chooser label', () => {
    for (const m of PAYMENT_METHODS) expect(isRememberedMethod(m)).toBe(PAYMENT_METHOD_COPY[m].chooserLabel !== null);
  });
  it.each([['other'], ['zelle'], [''], [null], [undefined], [1]])('refuses %p', (v) => expect(isRememberedMethod(v)).toBe(false));
});
