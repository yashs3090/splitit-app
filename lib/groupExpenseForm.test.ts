// The expense screen's form model (spec docs/specs/2026-11-26-groups-mvp.md T15, criteria 70–72,
// 114; GR-T8-1, GR-T8-2). The rules themselves live in lib/groupExpense.ts and are tested there;
// these tests pin how the screen's typed text reaches them.
import { expensePayload, type StoredExpense } from './groupExpense';
import {
  amountFieldError,
  canEditExpense,
  draftOf,
  emptyForm,
  equalRowA11yLabel,
  equalRows,
  exactFieldLabel,
  exactLine,
  readOnlySummary,
  footerNote,
  formFromExpense,
  formsEqual,
  isNoopSave,
  saveBlockText,
  shareFieldError,
  type ExpenseForm,
} from './groupExpenseForm';

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const CY = 'cccccccc-0000-4000-8000-000000000003';
const DEE = 'dddddddd-0000-4000-8000-000000000004';
const MEMBERS = [ANA, BEN, CY, DEE];

const filled = (patch: Partial<ExpenseForm> = {}): ExpenseForm => ({ ...emptyForm(MEMBERS, ANA), title: 'Airbnb', amountText: '240', ...patch });

describe('emptyForm', () => {
  it('starts with the viewer paying, split Equally among everyone, nothing typed', () => {
    expect(emptyForm(MEMBERS, BEN)).toEqual({
      title: '',
      amountText: '',
      payerId: BEN,
      method: 'equal',
      equalChosen: MEMBERS,
      exactText: {},
    });
  });
  it('leaves the payer empty when the viewer is not a member', () => {
    expect(emptyForm(MEMBERS, 'someone-else').payerId).toBeNull();
  });
});

describe('equalRows (criterion 70)', () => {
  it('$240.00 among 4 previews $60.00 each', () => {
    expect(equalRows(filled(), MEMBERS).map((r) => r.cents)).toEqual([6000, 6000, 6000, 6000]);
  });
  it('$1.00 among 3 gives the extra cent to the lowest id, and the left-out person no amount', () => {
    const rows = equalRows(filled({ amountText: '1', equalChosen: [CY, BEN, ANA] }), MEMBERS);
    expect(rows).toEqual([
      { userId: ANA, chosen: true, cents: 34 },
      { userId: BEN, chosen: true, cents: 33 },
      { userId: CY, chosen: true, cents: 33 },
      { userId: DEE, chosen: false, cents: null },
    ]);
  });
  it('$0.01 among 3: every chosen person gets a row, $0 included (A3)', () => {
    const rows = equalRows(filled({ amountText: '0.01', equalChosen: [ANA, BEN, CY] }), MEMBERS);
    expect(rows.filter((r) => r.chosen).map((r) => r.cents)).toEqual([1, 0, 0]);
  });
  it('no preview while the amount is blank, malformed, $0 or too large', () => {
    for (const amountText of ['', '12.345', '0', '100000']) {
      expect(equalRows(filled({ amountText }), MEMBERS).every((r) => r.cents === null)).toBe(true);
    }
  });
  it('ignores a chosen id that is no longer a member', () => {
    const rows = equalRows(filled({ amountText: '3', equalChosen: [ANA, 'gone'] }), [ANA, BEN]);
    expect(rows).toEqual([
      { userId: ANA, chosen: true, cents: 300 },
      { userId: BEN, chosen: false, cents: null },
    ]);
  });
});

describe('draftOf and the Exact check (criteria 71, 114)', () => {
  const exact = (texts: Record<string, string>, amountText = '300') => filled({ method: 'exact', amountText, exactText: texts });

  it('one field $0.01 over reads "Off by $0.01" and blocks Save; fixing it reads "Adds up"', () => {
    const over = exact({ [ANA]: '85.73', [BEN]: '85.71', [CY]: '85.71', [DEE]: '42.86' });
    expect(exactLine(over, MEMBERS)).toEqual({ text: 'Off by $0.01', tone: 'error' });
    expect(expensePayload(draftOf(over, MEMBERS))).toBeNull();
    const fixed = exact({ [ANA]: '85.72', [BEN]: '85.71', [CY]: '85.71', [DEE]: '42.86' });
    expect(exactLine(fixed, MEMBERS)).toEqual({ text: 'Adds up', tone: 'success' });
    expect(expensePayload(draftOf(fixed, MEMBERS))?.p_shares).toEqual({ [ANA]: 8572, [BEN]: 8571, [CY]: 8571, [DEE]: 4286 });
  });
  it('a typed $0 is refused with GR-T8-1 copy; clearing it leaves that person out of the payload', () => {
    const zero = exact({ [ANA]: '300', [BEN]: '0.00' });
    expect(shareFieldError('0.00')).toBe('Leave it blank if they don’t owe anything.');
    expect(expensePayload(draftOf(zero, MEMBERS))).toBeNull();
    expect(exactLine(zero, MEMBERS).tone).toBe('error');
    const cleared = exact({ [ANA]: '300', [BEN]: '' });
    expect(expensePayload(draftOf(cleared, MEMBERS))?.p_shares).toEqual({ [ANA]: 30000 });
  });
  it('a malformed or too-large field is invalid, never blank and never "Adds up"', () => {
    for (const bad of ['12.345', 'abc', '100000']) {
      const form = exact({ [ANA]: '300', [BEN]: bad });
      expect(exactLine(form, MEMBERS)).toEqual({ text: 'Fix the highlighted amount.', tone: 'error' });
      expect(expensePayload(draftOf(form, MEMBERS))).toBeNull();
    }
  });
  it('$99,999.99, the form cap, is accepted (GR-T8-2)', () => {
    const form = exact({ [ANA]: '99999.99' }, '99,999.99');
    expect(amountFieldError('99,999.99')).toBeNull();
    expect(expensePayload(draftOf(form, MEMBERS))).toMatchObject({ p_amount_cents: 9_999_999, p_shares: { [ANA]: 9_999_999 } });
  });
  it('drops a member who left from the draft', () => {
    const d = draftOf(filled({ equalChosen: [ANA, 'gone'], payerId: 'gone' }), MEMBERS);
    expect(d.equalUserIds).toEqual([ANA]);
    expect(d.payerId).toBeNull();
  });
  it('the line asks for the amount first when it is not valid', () => {
    expect(exactLine(exact({ [ANA]: '1' }, ''), MEMBERS)).toEqual({ text: 'Fix the amount first.', tone: 'muted' });
  });
});

describe('field errors', () => {
  it('amount', () => {
    expect(amountFieldError('')).toBeNull(); // blank: the footer says what to do
    expect(amountFieldError('12.50')).toBeNull();
    expect(amountFieldError('0')).toBe('Enter an amount above $0.00.');
    expect(amountFieldError('12.345')).toBe('Enter dollars and cents, like 12.50.');
    expect(amountFieldError('100000')).toBe('Enter an amount up to $99,999.99.');
  });
  it('share', () => {
    expect(shareFieldError('')).toBeNull();
    expect(shareFieldError('  ')).toBeNull();
    expect(shareFieldError('1')).toBeNull();
    expect(shareFieldError('-1')).toBe('Enter dollars and cents, like 12.50.');
    expect(shareFieldError('100000')).toBe('Enter an amount up to $99,999.99.');
  });
});

describe('saveBlockText', () => {
  it('says the first thing to fix, in field order', () => {
    expect(saveBlockText(emptyForm(MEMBERS, ANA), MEMBERS)).toBe('Add what it was for.');
    expect(saveBlockText(filled({ amountText: '' }), MEMBERS)).toBe('Enter the amount.');
    expect(saveBlockText(filled({ amountText: '0' }), MEMBERS)).toBe('Enter an amount above $0.00.');
    expect(saveBlockText(filled({ equalChosen: [] }), MEMBERS)).toBe('Choose at least one person.');
    expect(saveBlockText(filled({ method: 'exact', exactText: { [ANA]: '200' } }), MEMBERS)).toBe('Off by $40.00');
    expect(saveBlockText(filled({ method: 'exact', exactText: {} }), MEMBERS)).toBe('Choose at least one person.');
    expect(saveBlockText(filled({ method: 'exact', exactText: { [ANA]: '0' } }), MEMBERS)).toBe('Fix the highlighted amount.');
  });
  it('is null when the form can be saved', () => {
    expect(saveBlockText(filled(), MEMBERS)).toBeNull();
  });
});

const AIRBNB: StoredExpense & { createdBy: string } = {
  title: 'Airbnb',
  payerId: ANA,
  amountCents: 24000,
  splitMethod: 'equal',
  createdBy: BEN,
  shares: MEMBERS.map((userId) => ({ userId, cents: 6000 })),
};
const CAR: StoredExpense = {
  title: 'Rental car',
  payerId: DEE,
  amountCents: 30000,
  splitMethod: 'exact',
  shares: [
    { userId: ANA, cents: 8572 },
    { userId: BEN, cents: 8571 },
    { userId: CY, cents: 8571 },
    { userId: DEE, cents: 4286 },
  ],
};

describe('footerNote', () => {
  it('repeats nothing the field already says', () => {
    expect(footerNote(filled({ amountText: '0' }), MEMBERS)).toBeNull(); // the Amount error says it
    expect(footerNote(filled({ method: 'exact', exactText: { [ANA]: '200' } }), MEMBERS)).toBeNull(); // "Off by $40.00" line
    expect(footerNote(filled({ method: 'exact', exactText: { [ANA]: '0' } }), MEMBERS)).toBeNull(); // "Fix the highlighted amount." line
    expect(footerNote(emptyForm(MEMBERS, ANA), MEMBERS)).toBe('Add what it was for.');
    expect(footerNote(filled({ equalChosen: [] }), MEMBERS)).toBe('Choose at least one person.');
    expect(footerNote(filled(), MEMBERS)).toBeNull();
  });
});

describe('formFromExpense and isNoopSave', () => {
  it('reloads an equal expense as typed text, $0 rows included in who is chosen', () => {
    const f = formFromExpense({ ...AIRBNB, amountCents: 1, shares: [{ userId: ANA, cents: 1 }, { userId: BEN, cents: 0 }] }, MEMBERS);
    expect(f).toEqual({ title: 'Airbnb', amountText: '0.01', payerId: ANA, method: 'equal', equalChosen: [ANA, BEN], exactText: {} });
  });
  it('reloads an exact expense with a field per member (blank without a share) and the same people chosen for Equally', () => {
    const f = formFromExpense({ ...CAR, shares: CAR.shares.slice(0, 2).map((s, i) => ({ ...s, cents: i === 0 ? 21429 : 8571 })) }, MEMBERS);
    expect(f.exactText).toEqual({ [ANA]: '214.29', [BEN]: '85.71', [CY]: '', [DEE]: '' });
    expect(f.equalChosen).toEqual([ANA, BEN]);
  });
  it('an unchanged form is a no-op save (equal and exact)', () => {
    for (const e of [AIRBNB, CAR]) {
      const p = expensePayload(draftOf(formFromExpense(e, MEMBERS), MEMBERS));
      expect(p).not.toBeNull();
      if (p) expect(isNoopSave(p, e, MEMBERS)).toBe(true);
    }
  });
  it('trailing spaces and "240" vs "240.00" are still a no-op', () => {
    const p = expensePayload(draftOf({ ...formFromExpense(AIRBNB, MEMBERS), title: '  Airbnb\t', amountText: '240' }, MEMBERS));
    expect(p && isNoopSave(p, AIRBNB, MEMBERS)).toBe(true);
  });
  it('any changed field is a real save', () => {
    const base = formFromExpense(AIRBNB, MEMBERS);
    const changes: Partial<ExpenseForm>[] = [
      { title: 'Cabin' },
      { amountText: '241' },
      { payerId: BEN },
      { equalChosen: [ANA, BEN, CY] },
      { method: 'exact', exactText: { [ANA]: '60', [BEN]: '60', [CY]: '60', [DEE]: '60' } },
    ];
    for (const c of changes) {
      const p = expensePayload(draftOf({ ...base, ...c }, MEMBERS));
      expect(p && isNoopSave(p, AIRBNB, MEMBERS)).toBe(false);
    }
  });
});

describe('formsEqual (the unsaved-input guard)', () => {
  it('compares every field, chosen people in any order, blank exact fields as absent', () => {
    const a = filled({ exactText: { [ANA]: '' } });
    expect(formsEqual(a, filled())).toBe(true);
    expect(formsEqual(filled({ equalChosen: [...MEMBERS].reverse() }), filled())).toBe(true);
    expect(formsEqual(filled({ title: 'Airbnb ' }), filled())).toBe(false);
    expect(formsEqual(filled({ exactText: { [ANA]: '1' } }), filled())).toBe(false);
    expect(formsEqual(filled({ method: 'exact' }), filled())).toBe(false);
  });
});

describe('canEditExpense (C-G9, GR-M2)', () => {
  it('only the creator or the payer', () => {
    expect(canEditExpense(AIRBNB, ANA)).toBe(true); // payer
    expect(canEditExpense(AIRBNB, BEN)).toBe(true); // creator
    expect(canEditExpense(AIRBNB, CY)).toBe(false);
  });
});

describe('labels', () => {
  it('reads naturally for the viewer and for others', () => {
    expect(exactFieldLabel('You')).toBe('Your amount');
    expect(exactFieldLabel('Ben')).toBe("Ben's amount");
    expect(equalRowA11yLabel('You', 0)).toBe('You, $0.00');
    expect(equalRowA11yLabel('Ben', null)).toBe('Ben');
    expect(readOnlySummary('You', 'equal')).toBe('Paid by You · Split equally');
    expect(readOnlySummary('Dee', 'exact')).toBe('Paid by Dee · Split by exact amounts');
  });
});
