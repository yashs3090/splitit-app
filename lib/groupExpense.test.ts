// Spec docs/specs/2026-11-26-groups-mvp.md: C-G4 (A1–A10), C-G5 (X1–X8), C-G6, criteria 45–46.
// The tables are written out here exactly as the spec writes them, so T3's pgTAP runs the same rows.

import {
  EXPENSE_MAX_CENTS,
  EXPENSE_MAX_EQUAL_USERS,
  EXPENSE_TITLE_MAX,
  draftFromExpense,
  equalPreview,
  exactCheck,
  exactCheckText,
  expenseErrorText,
  expensePayload,
  normalizeTitle,
  sharesFor,
  sortUserIds,
  validateExpense,
  type ExactEntry,
  type ExpenseDraft,
  type ExpenseError,
} from '@/lib/groupExpense';
import { groupBalances } from '@/lib/groupBalance';
import { allocate } from '@/lib/split';
import { AIRBNB, ANA, BEN, CY, DEE, MEMBERS, RENTAL_CAR, randomUuid, seededRng, shuffled } from '@/test-utils/groupFixtures';

// Twenty member ids already in code-unit order (u01 < u02 < … < u20).
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TWENTY = Array.from({ length: 20 }, (_, i) => uid(i + 1));

function draft(over: Partial<ExpenseDraft> = {}): ExpenseDraft {
  return {
    title: 'Rental car',
    amountCents: 30000,
    payerId: DEE,
    method: 'exact',
    equalUserIds: [],
    exactEntries: [],
    memberIds: MEMBERS,
    ...over,
  };
}

const entries = (m: Record<string, unknown>): ExactEntry[] =>
  // X7 puts a non-number in a value on purpose; the form type is number | null.
  Object.entries(m).map(([userId, cents]) => ({ userId, cents: cents as number | null }));

const centsOf = (shares: { userId: string; cents: number }[]) => shares.map((s) => s.cents);

describe('C-G4 equal allocation (A1–A10)', () => {
  it('A1: 100 among 1 user → [100]', () => {
    expect(centsOf(equalPreview(100, [ANA]))).toEqual([100]);
  });
  it('A2: 100 among 3 → [34, 33, 33]', () => {
    expect(centsOf(equalPreview(100, [ANA, BEN, CY]))).toEqual([34, 33, 33]);
  });
  it('A3: 1 among 3 → [1, 0, 0] (a $0 share is still a row)', () => {
    expect(equalPreview(1, [ANA, BEN, CY])).toEqual([
      { userId: ANA, cents: 1 },
      { userId: BEN, cents: 0 },
      { userId: CY, cents: 0 },
    ]);
  });
  it('A4: 24000 among 4 (Airbnb) → 6000 each', () => {
    expect(centsOf(equalPreview(24000, MEMBERS))).toEqual([6000, 6000, 6000, 6000]);
  });
  it('A5: 1001 among 4 → [251, 250, 250, 250]', () => {
    expect(centsOf(equalPreview(1001, MEMBERS))).toEqual([251, 250, 250, 250]);
  });
  it('A6: 99,999,999 among 20 → 19 × 5,000,000 then 4,999,999', () => {
    expect(centsOf(equalPreview(99_999_999, TWENTY))).toEqual([...Array(19).fill(5_000_000), 4_999_999]);
  });
  it('A7: 99,999,999 among 2 → [50,000,000, 49,999,999]', () => {
    expect(centsOf(equalPreview(99_999_999, [ANA, BEN]))).toEqual([50_000_000, 49_999_999]);
  });
  it('A8: users sent in reverse order give A2 by user id', () => {
    expect(equalPreview(100, [CY, BEN, ANA])).toEqual([
      { userId: ANA, cents: 34 },
      { userId: BEN, cents: 33 },
      { userId: CY, cents: 33 },
    ]);
  });
  it('A9: allocate(3, [1, 0, 1]) → [2, 0, 1]', () => {
    expect(allocate(3, [1, 0, 1])).toEqual([2, 0, 1]);
  });
  it('A10: allocate(5, [0, 0]) is refused with RangeError; so is equalPreview(5, [])', () => {
    expect(() => allocate(5, [0, 0])).toThrow(RangeError);
    expect(() => equalPreview(5, [])).toThrow(RangeError);
  });

  it('sorts by the lowercase id in code-unit order, like SQL `collate "C"` on uuid::text', () => {
    const upper = 'AAAAAAAA-0000-4000-8000-000000000009';
    // Lowercased, "aaaa…" sorts after "0000…" and before "bbbb…".
    expect(sortUserIds([BEN, upper, uid(1)])).toEqual([uid(1), upper, BEN]);
    // Code-unit order, not locale order: digits < lowercase letters.
    expect(sortUserIds(['b', 'a', '9'])).toEqual(['9', 'a', 'b']);
  });

  it('refuses a bad amount or a bad user list instead of previewing a wrong number', () => {
    expect(() => equalPreview(1.5, [ANA])).toThrow(RangeError);
    expect(() => equalPreview(Number.NaN, [ANA])).toThrow(RangeError);
    expect(() => equalPreview(-1, [ANA])).toThrow(RangeError);
    expect(() => equalPreview(100, [ANA, ANA])).toThrow(RangeError);
    expect(() => equalPreview(100, [...TWENTY, ...Array.from({ length: 31 }, (_, i) => uid(100 + i))])).toThrow(RangeError);
    expect(equalPreview(100, Array.from({ length: EXPENSE_MAX_EQUAL_USERS }, (_, i) => uid(i + 1)))).toHaveLength(50);
  });
});

describe('C-G5 exact amounts (X1–X8)', () => {
  const X1 = { [ANA]: 8572, [BEN]: 8571, [CY]: 8571, [DEE]: 4286 };

  it('X1: {8572, 8571, 8571, 4286} of 30000 → adds up; valid', () => {
    expect(exactCheck(30000, entries(X1))).toEqual({ status: 'adds_up' });
    expect(validateExpense(draft({ exactEntries: entries(X1) })).ok).toBe(true);
  });
  it('X2: Σ 30001 → off_by +1', () => {
    const e = entries({ ...X1, [DEE]: 4287 });
    expect(exactCheck(30000, e)).toEqual({ status: 'off_by', cents: 1 });
    expect(validateExpense(draft({ exactEntries: e }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'off_by', cents: 1 }],
    });
  });
  it('X3: Σ 29999 → off_by −1', () => {
    const e = entries({ ...X1, [DEE]: 4285 });
    expect(exactCheck(30000, e)).toEqual({ status: 'off_by', cents: -1 });
    expect(validateExpense(draft({ exactEntries: e }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'off_by', cents: -1 }],
    });
  });
  it('X4: {Ana 30000} → ok', () => {
    expect(exactCheck(30000, entries({ [ANA]: 30000 }))).toEqual({ status: 'adds_up' });
    expect(validateExpense(draft({ exactEntries: entries({ [ANA]: 30000 }) })).ok).toBe(true);
  });
  it('X5: {Ana 30000, Ben 0} → invalid (0), never adds_up', () => {
    const e = entries({ [ANA]: 30000, [BEN]: 0 });
    expect(exactCheck(30000, e)).toEqual({ status: 'invalid', field: 'share', userId: BEN, reason: 'zero' });
    expect(validateExpense(draft({ exactEntries: e }))).toEqual({
      ok: false,
      errors: [{ field: 'share', userId: BEN, code: 'zero' }],
    });
  });
  it('X6: {Ana 99,999,999} of 99,999,999 → ok', () => {
    const e = entries({ [ANA]: 99_999_999 });
    expect(exactCheck(99_999_999, e)).toEqual({ status: 'adds_up' });
    expect(validateExpense(draft({ amountCents: 99_999_999, exactEntries: e })).ok).toBe(true);
  });
  it.each([
    ['{Ana 50, Ben 50.5}', { [ANA]: 50, [BEN]: 50.5 }, BEN],
    ['{Ana "100"}', { [ANA]: '100' }, ANA],
  ])('X7: %s of 100 → invalid, never adds_up', (_label, m, bad) => {
    const r = exactCheck(100, entries(m));
    expect(r).toEqual({ status: 'invalid', field: 'share', userId: bad, reason: 'not_integer' });
    const v = validateExpense(draft({ amountCents: 100, exactEntries: entries(m) }));
    expect(v).toEqual({ ok: false, errors: [{ field: 'share', userId: bad, code: 'not_integer' }] });
  });
  it('X8: a non-member key (n/a for the form, which lists members only) is still refused by the lib', () => {
    const stranger = uid(999);
    const v = validateExpense(draft({ amountCents: 100, exactEntries: entries({ [stranger]: 100 }) }));
    expect(v).toEqual({ ok: false, errors: [{ field: 'share', userId: stranger, code: 'not_member' }] });
  });

  it('blank people are left out; an invalid amount or a duplicate person is invalid, never adds_up', () => {
    expect(exactCheck(100, entries({ [ANA]: 100, [BEN]: null }))).toEqual({ status: 'adds_up' });
    expect(exactCheck(null, entries({ [ANA]: 100 }))).toEqual({ status: 'invalid', field: 'amount' });
    expect(exactCheck(0, entries({ [ANA]: 0 }))).toEqual({ status: 'invalid', field: 'amount' });
    expect(exactCheck(1.5, entries({ [ANA]: 1 }))).toEqual({ status: 'invalid', field: 'amount' });
    expect(exactCheck(100, [{ userId: ANA, cents: 50 }, { userId: ANA, cents: 50 }])).toEqual({
      status: 'invalid',
      field: 'share',
      userId: ANA,
      reason: 'duplicate',
    });
    expect(exactCheck(100, entries({ [ANA]: -100, [BEN]: 200 }))).toEqual({
      status: 'invalid',
      field: 'share',
      userId: ANA,
      reason: 'out_of_range',
    });
    expect(exactCheck(EXPENSE_MAX_CENTS, entries({ [ANA]: EXPENSE_MAX_CENTS + 1 }))).toEqual({
      status: 'invalid',
      field: 'share',
      userId: ANA,
      reason: 'out_of_range',
    });
  });

  it('nobody filled in reads as off by the whole amount, not adds up', () => {
    expect(exactCheck(30000, entries({ [ANA]: null }))).toEqual({ status: 'off_by', cents: -30000 });
    expect(exactCheck(30000, [])).toEqual({ status: 'off_by', cents: -30000 });
  });

  it('copy for each state', () => {
    expect(exactCheckText({ status: 'adds_up' })).toBe('Adds up');
    expect(exactCheckText({ status: 'off_by', cents: 1 })).toBe('Off by $0.01');
    expect(exactCheckText({ status: 'off_by', cents: -1 })).toBe('Off by $0.01');
    expect(exactCheckText({ status: 'off_by', cents: -30000 })).toBe('Off by $300.00');
    expect(exactCheckText({ status: 'invalid', field: 'amount' })).toBe('Fix the amount first.');
    expect(exactCheckText({ status: 'invalid', field: 'share', userId: BEN, reason: 'zero' })).toBe(
      'Fix the highlighted amount.',
    );
  });
});

describe('C-G6 expense fields', () => {
  const equal = (over: Partial<ExpenseDraft> = {}) =>
    draft({ title: 'Airbnb', amountCents: 24000, payerId: ANA, method: 'equal', equalUserIds: MEMBERS, ...over });

  it.each([
    ['0 code points', '', 'empty'],
    ['only spaces', '   ', 'empty'],
    ['101 code points', 'x'.repeat(101), 'too_long'],
    ['101 emoji', '🍕'.repeat(101), 'too_long'],
  ])('title %s is refused', (_label, title, code) => {
    expect(validateExpense(equal({ title }))).toEqual({ ok: false, errors: [{ field: 'title', code }] });
  });

  it.each([
    ['1 code point', 'x'],
    ['100 code points', 'x'.repeat(100)],
    ['100 emoji (200 UTF-16 units)', '🍕'.repeat(100)],
    ['100 code points after trimming', `  ${'x'.repeat(100)}  `],
  ])('title %s is valid', (_label, title) => {
    expect(validateExpense(equal({ title })).ok).toBe(true);
  });

  it.each([
    [0, 'out_of_range'],
    [100_000_000, 'out_of_range'],
    [-1, 'out_of_range'],
    [1.5, 'out_of_range'],
    [Number.NaN, 'out_of_range'],
    [null, 'missing'],
  ])('amount %p is refused (%s)', (amountCents, code) => {
    expect(validateExpense(equal({ amountCents }))).toEqual({ ok: false, errors: [{ field: 'amount', code }] });
  });

  it.each([1, 99_999_999])('amount %p is valid', (amountCents) => {
    expect(validateExpense(equal({ amountCents })).ok).toBe(true);
  });

  it('payer: missing or not a member is refused', () => {
    expect(validateExpense(equal({ payerId: null }))).toEqual({ ok: false, errors: [{ field: 'payer', code: 'missing' }] });
    expect(validateExpense(equal({ payerId: uid(999) }))).toEqual({
      ok: false,
      errors: [{ field: 'payer', code: 'not_member' }],
    });
  });

  it('the payer need not be one of the people splitting it', () => {
    expect(validateExpense(equal({ payerId: DEE, equalUserIds: [ANA, BEN] })).ok).toBe(true);
  });

  it('equal: no people, too many, duplicates and non-members are refused', () => {
    expect(validateExpense(equal({ equalUserIds: [] }))).toEqual({ ok: false, errors: [{ field: 'split', code: 'no_people' }] });
    expect(validateExpense(equal({ equalUserIds: [ANA, ANA] }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'duplicate' }],
    });
    expect(validateExpense(equal({ equalUserIds: [ANA, uid(999)] }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'not_member' }],
    });
    const many = Array.from({ length: 51 }, (_, i) => uid(i + 1));
    expect(validateExpense(equal({ memberIds: many, payerId: uid(1), equalUserIds: many }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'too_many_people' }],
    });
    const fifty = many.slice(0, 50);
    expect(validateExpense(equal({ memberIds: many, payerId: uid(1), equalUserIds: fifty })).ok).toBe(true);
  });

  it('reports every bad field at once, and an off_by split only when the amount is valid', () => {
    const r = validateExpense(draft({ title: '', amountCents: null, payerId: null, exactEntries: entries({ [ANA]: 1 }) }));
    expect(r).toEqual({
      ok: false,
      errors: [
        { field: 'title', code: 'empty' },
        { field: 'amount', code: 'missing' },
        { field: 'payer', code: 'missing' },
      ],
    });
  });

  it('exact with nobody filled in reads as no_people', () => {
    expect(validateExpense(draft({ exactEntries: entries({ [ANA]: null }) }))).toEqual({
      ok: false,
      errors: [{ field: 'split', code: 'no_people' }],
    });
  });

  it('copy for every error', () => {
    const all: ExpenseError[] = [
      { field: 'title', code: 'empty' },
      { field: 'title', code: 'too_long' },
      { field: 'amount', code: 'missing' },
      { field: 'amount', code: 'out_of_range' },
      { field: 'payer', code: 'missing' },
      { field: 'payer', code: 'not_member' },
      { field: 'split', code: 'no_people' },
      { field: 'split', code: 'too_many_people' },
      { field: 'split', code: 'duplicate' },
      { field: 'split', code: 'not_member' },
      { field: 'split', code: 'off_by', cents: 1 },
      { field: 'share', userId: ANA, code: 'zero' },
      { field: 'share', userId: ANA, code: 'not_integer' },
      { field: 'share', userId: ANA, code: 'out_of_range' },
      { field: 'share', userId: ANA, code: 'duplicate' },
      { field: 'share', userId: ANA, code: 'not_member' },
    ];
    expect(all.map(expenseErrorText)).toEqual([
      'Add what it was for.',
      'Keep it to 100 characters.',
      'Enter the amount.',
      'Enter an amount from $0.01 to $999,999.99.',
      'Choose who paid.',
      'Choose who paid from the group.',
      'Choose at least one person.',
      'Choose up to 50 people.',
      'Choose each person once.',
      'Choose people from the group.',
      'Off by $0.01',
      'Leave it blank if they don’t owe anything.',
      'Enter dollars and cents, like 12.50.',
      'Enter an amount from $0.01 to $999,999.99.',
      'Enter each person once.',
      'Choose people from the group.',
    ]);
    expect(EXPENSE_TITLE_MAX).toBe(100);
  });
});

describe('normalizeTitle and the shared trim rows (A1.12, GR-T8-6; same rows in group_expenses.test.sql / groups.test.sql)', () => {
  const equal = (title: string) =>
    draft({ title, amountCents: 24000, payerId: ANA, method: 'equal', equalUserIds: MEMBERS });

  it('a title of only "\\t\\n" is refused', () => {
    expect(normalizeTitle('\t\n')).toBe('');
    expect(validateExpense(equal('\t\n'))).toEqual({ ok: false, errors: [{ field: 'title', code: 'empty' }] });
  });

  it('"  Airbnb\\t" is stored as "Airbnb"', () => {
    expect(normalizeTitle('  Airbnb\t')).toBe('Airbnb');
    expect(expensePayload(equal('  Airbnb\t'))?.p_title).toBe('Airbnb');
  });

  it('a trailing non-breaking space is kept (and counts as a code point)', () => {
    expect(normalizeTitle('Airbnb\u00a0')).toBe('Airbnb\u00a0');
    expect(expensePayload(equal('Airbnb\u00a0'))?.p_title).toBe('Airbnb\u00a0');
    expect(validateExpense(equal(`${'x'.repeat(100)}\u00a0`))).toEqual({
      ok: false,
      errors: [{ field: 'title', code: 'too_long' }],
    });
    // A title that is only a non-breaking space is not empty on either side.
    expect(validateExpense(equal('\u00a0')).ok).toBe(true);
  });

  it('trims exactly space, tab, newline, CR, VT and FF, and nothing else', () => {
    expect(normalizeTitle(' \t\n\r\v\fGas \t\n\r\v\f')).toBe('Gas');
    expect(normalizeTitle('\u3000Gas\u2003')).toBe('\u3000Gas\u2003');
    expect(normalizeTitle('\uFEFFGas')).toBe('\uFEFFGas');
    expect(normalizeTitle('Gas  station')).toBe('Gas  station'); // inside spaces untouched
  });
});

describe('expensePayload', () => {
  it('equal → {uid: 1} for the chosen users, in id order, title trimmed', () => {
    const p = expensePayload(
      draft({ title: '  Airbnb ', amountCents: 24000, payerId: ANA, method: 'equal', equalUserIds: [DEE, ANA, CY, BEN] }),
    );
    expect(p).toEqual({
      p_title: 'Airbnb',
      p_payer_id: ANA,
      p_amount_cents: 24000,
      p_method: 'equal',
      p_shares: { [ANA]: 1, [BEN]: 1, [CY]: 1, [DEE]: 1 },
    });
    expect(Object.keys(p?.p_shares ?? {})).toEqual([ANA, BEN, CY, DEE]);
  });

  it('exact → {uid: cents}, blank people left out', () => {
    const p = expensePayload(draft({ exactEntries: entries({ [DEE]: 4286, [ANA]: 25714, [BEN]: null }) }));
    expect(p?.p_shares).toEqual({ [ANA]: 25714, [DEE]: 4286 });
    expect(p?.p_method).toBe('exact');
  });

  it('ignores the other method’s inputs', () => {
    const p = expensePayload(
      draft({ method: 'equal', amountCents: 100, equalUserIds: [ANA], exactEntries: entries({ [BEN]: 7 }) }),
    );
    expect(p?.p_shares).toEqual({ [ANA]: 1 });
  });

  it('returns null for any invalid draft (X2, X5, X7)', () => {
    expect(expensePayload(draft({ exactEntries: entries({ [ANA]: 30001 }) }))).toBeNull();
    expect(expensePayload(draft({ exactEntries: entries({ [ANA]: 30000, [BEN]: 0 }) }))).toBeNull();
    expect(expensePayload(draft({ amountCents: 100, exactEntries: entries({ [ANA]: '100' }) }))).toBeNull();
  });

  it('builds the worked example’s Airbnb and Rental car exactly (T1 fixtures)', () => {
    const airbnb = expensePayload(
      draft({ title: 'Airbnb', amountCents: 24000, payerId: ANA, method: 'equal', equalUserIds: MEMBERS }),
    );
    const car = expensePayload(
      draft({ exactEntries: entries({ [ANA]: 8572, [BEN]: 8571, [CY]: 8571, [DEE]: 4286 }) }),
    );
    if (!airbnb || !car) throw new Error('expected valid payloads');
    expect(sharesFor(airbnb)).toEqual(AIRBNB.shares);
    expect(sharesFor(car)).toEqual(RENTAL_CAR.shares);
    // groupBalances accepts them (it throws when shares don't add up to the amount).
    const b = groupBalances({
      members: [...MEMBERS],
      bills: [],
      expenses: [
        { id: AIRBNB.id, payerId: ANA, amountCents: airbnb.p_amount_cents, shares: sharesFor(airbnb) },
        { id: RENTAL_CAR.id, payerId: DEE, amountCents: car.p_amount_cents, shares: sharesFor(car) },
      ],
      payments: [],
    });
    expect(b.members.reduce((s, m) => s + m.netCents, 0)).toBe(0);
  });
});

describe('draftFromExpense', () => {
  it('reloads who’s in exactly, $0 equal rows included (A3)', () => {
    const stored = { title: 'Gum', payerId: ANA, amountCents: 1, splitMethod: 'equal' as const, shares: equalPreview(1, [CY, ANA, BEN]) };
    const d = draftFromExpense(stored, MEMBERS);
    expect(d.equalUserIds).toEqual([ANA, BEN, CY]);
    expect(expensePayload(d)?.p_shares).toEqual({ [ANA]: 1, [BEN]: 1, [CY]: 1 });
  });

  it('round-trips an exact expense', () => {
    const stored = { title: 'Rental car', payerId: DEE, amountCents: 30000, splitMethod: 'exact' as const, shares: RENTAL_CAR.shares };
    const d = draftFromExpense(stored, MEMBERS);
    expect(d.method).toBe('exact');
    expect(sharesFor(expensePayload(d) ?? fail())).toEqual(RENTAL_CAR.shares);
  });
});

function fail(): never {
  throw new Error('unexpected null');
}

// Criterion 46: 500 random drafts. The checks below assert the payload's shape and Σ against the
// C-G5 / C-G6 rules as the spec states them (they don't call the validator under test).
describe('property: 500 random drafts', () => {
  const SEED = 20261126;

  it('never emits a 0 or a blank person, and every valid payload meets C-G5 / C-G6', () => {
    const r = seededRng(SEED);
    let valid = 0;
    const byMethod = { equal: 0, exact: 0 };
    for (let i = 0; i < 500; i++) {
      const members = Array.from({ length: 1 + r(8) }, () => randomUuid(r));
      const pick = <T,>(xs: readonly T[]): T => xs[r(xs.length)] as T;
      const amountPool = [null, 0, 1, 2, 99, 100, 1001, 24000, 99_999_999, 100_000_000, 1.5, -5];
      const amountCents = r(4) === 0 ? pick(amountPool) : 1 + r(50_000);
      const method = r(2) === 0 ? 'equal' : 'exact';
      const chosen = shuffled(members, r).slice(0, r(members.length + 1));
      const exactEntries: ExactEntry[] = members.map((userId) => ({
        userId,
        cents: pick([null, null, 0, 1, 1 + r(20_000), 2.5]),
      }));
      // Some drafts are made to add up, so the valid branch is exercised often.
      if (method === 'exact' && typeof amountCents === 'number' && Number.isInteger(amountCents) && amountCents > 1 && r(2) === 0) {
        const people = shuffled(members, r).slice(0, 1 + r(members.length));
        const cuts = allocate(amountCents, people.map(() => 1 + r(5)));
        for (const e of exactEntries) e.cents = null;
        people.forEach((userId, k) => {
          const e = exactEntries.find((x) => x.userId === userId);
          if (e) e.cents = cuts[k] ?? null;
        });
        if (r(3) === 0) exactEntries.push({ userId: pick(members), cents: null }); // a duplicate blank
      }
      const d: ExpenseDraft = {
        title: pick(['', ' ', '\t\n', 'Gas\u00a0', 'Gas', '🍕'.repeat(100), 'x'.repeat(101), '  Tickets  ']),
        amountCents,
        payerId: pick([...members, null]),
        method,
        equalUserIds: chosen,
        exactEntries,
        memberIds: members,
      };
      const p = expensePayload(d);
      if (!p) continue;
      valid++;
      byMethod[p.p_method]++;
      const keys = Object.keys(p.p_shares);
      const values = Object.values(p.p_shares);
      const title = Array.from(p.p_title);
      expect(title.length).toBeGreaterThanOrEqual(1);
      expect(title.length).toBeLessThanOrEqual(100);
      expect(p.p_title).toBe(normalizeTitle(p.p_title));
      expect(Number.isInteger(p.p_amount_cents) && p.p_amount_cents >= 1 && p.p_amount_cents <= 99_999_999).toBe(true);
      expect(members).toContain(p.p_payer_id);
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(members).toContain(k);
      for (const v of values) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(1);
      }
      if (p.p_method === 'equal') {
        expect(values.every((v) => v === 1)).toBe(true);
        expect(keys.length).toBeLessThanOrEqual(50);
      } else {
        for (const v of values) expect(v).toBeLessThanOrEqual(99_999_999);
        expect(values.reduce((s, v) => s + v, 0)).toBe(p.p_amount_cents);
      }
      // What the DB would store adds up to the amount in both methods.
      const stored = sharesFor(p);
      expect(stored.reduce((s, x) => s + x.cents, 0)).toBe(p.p_amount_cents);
      expect(stored.map((s) => s.userId)).toEqual(sortUserIds(keys));
    }
    // Both branches must actually run, or the property is vacuous.
    expect(valid).toBeGreaterThan(50);
    expect(valid).toBeLessThan(500);
    expect(byMethod.equal).toBeGreaterThan(20);
    expect(byMethod.exact).toBeGreaterThan(20);
  });
});
