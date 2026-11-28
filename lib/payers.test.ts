// Who paid (spec docs/specs/2026-11-26-who-paid.md, Task 1 as re-planned by Amendment A1):
// contract W (table W), contract A (the sheet's amounts), contract M (table M) and paidByLine (A1.5).
import {
  MAX_PAID_CENTS,
  MAX_PAYERS,
  SPLIT_MIN_TOTAL_CENTS,
  addTheRest,
  flagsDroppedBy,
  paidByLine,
  paidItAllLink,
  payersChangeIsNoop,
  payersState,
  paymentsMovedBy,
  prefillSplitFields,
  splitDbCode,
  splitDraftChanged,
  splitDraftStatus,
  splitStatusSpoken,
  toPayersPayload,
  validateSplit,
  type PairNet,
  type SplitField,
} from './payers';
import type { PayersMode, Payer } from './payers';
import type { PlanMode, PlanPayer } from './transfers';

// Task 2a's PlanMode / PlanPayer and these types must stay interchangeable (both directions).
const modeCompat: [PayersMode, PlanMode] = ['one', 'split'];
const payerCompat: [Payer, PlanPayer] = [
  { userId: 'x', paidCents: 1 },
  { userId: 'x', paidCents: 1 },
];
const toPlan = (m: PayersMode): PlanMode => m;
const fromPlan = (m: PlanMode): PayersMode => m;
const payerToPlan = (p: Payer): PlanPayer => p;
const payerFromPlan = (p: PlanPayer): Payer => p;
void [modeCompat, payerCompat, toPlan, fromPlan, payerToPlan, payerFromPlan];

// The W12 / W13 tie fixture. pgTAP (Task 4b, who_paid.test.sql) must use these two literals: the
// first byte differs across the digit/letter boundary ('9' < 'a' in JS; 0x9f < 0xa0 in Postgres
// uuid byte order), so a rule that compared them any other way would disagree.
const ID_A = '9fffffff-ffff-4fff-8fff-ffffffffffff';
const ID_B = 'a0000000-0000-4000-8000-000000000000';
const ID_C = 'c0000000-0000-4000-8000-000000000000';
const ID_D = 'd0000000-0000-4000-8000-000000000000';
const ID_E = 'e0000000-0000-4000-8000-000000000000';

const NAMES: Record<string, string> = { [ID_A]: 'Hana', [ID_B]: 'Sam', [ID_C]: 'Dee', [ID_D]: 'Pat', [ID_E]: 'Ann' };
/** Like makeNameOf: "You" for the viewer. paidByLine must never print it mid-sentence. */
const nameOfFor = (viewerId: string) => (id: string | null) => (id === viewerId ? 'You' : (id !== null && NAMES[id]) || 'Someone');

const TOTAL = 10021;
const PARTICIPANTS = [ID_A, ID_B, ID_D];

describe('constants', () => {
  it('match the DB ranges', () => {
    expect(SPLIT_MIN_TOTAL_CENTS).toBe(2);
    expect(MAX_PAID_CENTS).toBe(99_999_999);
    expect(MAX_PAYERS).toBe(50);
  });
});

// ---------------------------------------------------------------------------------------------
// Contract W: table W (lib side). Total 10021 unless stated.
// ---------------------------------------------------------------------------------------------
describe('validateSplit (table W)', () => {
  const ctx = { totalCents: TOTAL, participantIds: PARTICIPANTS };
  const e = (userId: string, paidCents: unknown) => ({ userId, paidCents });

  it('W1: A 6000, B 4021 is ok', () => {
    expect(validateSplit([e(ID_A, 6000), e(ID_B, 4021)], ctx)).toEqual({
      ok: true,
      payers: [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4021 },
      ],
    });
  });

  it('W2: 1¢ short is total with gap 1', () => {
    expect(validateSplit([e(ID_A, 6000), e(ID_B, 4020)], ctx)).toEqual({ ok: false, reason: 'total', gapCents: 1 });
  });

  it('W3: 1¢ over is total with gap -1', () => {
    expect(validateSplit([e(ID_A, 6000), e(ID_B, 4022)], ctx)).toEqual({ ok: false, reason: 'total', gapCents: -1 });
  });

  it('W4: one entry is count', () => {
    expect(validateSplit([e(ID_A, 10021)], ctx)).toEqual({ ok: false, reason: 'count' });
    expect(validateSplit([], ctx)).toEqual({ ok: false, reason: 'count' });
  });

  it('more than MAX_PAYERS entries is count (DB step 2)', () => {
    const many = Array.from({ length: 51 }, (_, i) => e(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 1));
    expect(validateSplit(many, { totalCents: 51, participantIds: many.map((m) => m.userId) })).toEqual({
      ok: false,
      reason: 'count',
    });
    const fifty = many.slice(0, 50);
    expect(validateSplit(fifty, { totalCents: 50, participantIds: fifty.map((m) => m.userId) }).ok).toBe(true);
  });

  it('W5: the same user twice is duplicate', () => {
    expect(validateSplit([e(ID_A, 6000), e(ID_A, 4021)], ctx)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('W6: a 0 amount is amount', () => {
    expect(validateSplit([e(ID_A, 10021), e(ID_B, 0)], ctx)).toEqual({ ok: false, reason: 'amount' });
  });

  it('W7: a negative amount is amount (even though the sum matches)', () => {
    expect(validateSplit([e(ID_A, 10022), e(ID_B, -1)], ctx)).toEqual({ ok: false, reason: 'amount' });
  });

  it('W8 (A-20): A 99,999,998 + B 1 on a 99,999,999 bill is ok', () => {
    expect(
      validateSplit([e(ID_A, 99_999_998), e(ID_B, 1)], { totalCents: 99_999_999, participantIds: PARTICIPANTS }).ok,
    ).toBe(true);
  });

  it('W9: 100,000,000 is amount', () => {
    expect(validateSplit([e(ID_A, 100_000_000), e(ID_B, 1)], ctx)).toEqual({ ok: false, reason: 'amount' });
  });

  it('W10: a non-participant is participant', () => {
    expect(validateSplit([e(ID_A, 6000), e(ID_C, 4021)], ctx)).toEqual({ ok: false, reason: 'participant' });
  });

  it.each([[60.5], ['6000'], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined], [-0]])(
    'W11: paid_cents %p is amount',
    (bad) => {
      expect(validateSplit([e(ID_A, bad), e(ID_B, 4021)], ctx)).toEqual({ ok: false, reason: 'amount' });
    },
  );

  it('a malformed user id is id (DB: invalid_payers, step 2)', () => {
    expect(validateSplit([e('not-a-uuid', 6000), e(ID_B, 4021)], ctx)).toEqual({ ok: false, reason: 'id' });
    expect(validateSplit([e(ID_A.toUpperCase(), 6000), e(ID_B, 4021)], ctx)).toEqual({ ok: false, reason: 'id' });
  });

  it("follows set_payers' check order: count/duplicate, then amount, then participant, then total", () => {
    // duplicate beats amount
    expect(validateSplit([e(ID_A, 0), e(ID_A, 1)], ctx)).toEqual({ ok: false, reason: 'duplicate' });
    // amount beats participant
    expect(validateSplit([e(ID_A, 6000), e(ID_C, 0)], ctx)).toEqual({ ok: false, reason: 'amount' });
    // participant beats total
    expect(validateSplit([e(ID_A, 1), e(ID_C, 1)], ctx)).toEqual({ ok: false, reason: 'participant' });
  });

  it('maps each reason to the DB error code of table W', () => {
    expect(splitDbCode('count')).toBe('invalid_payers');
    expect(splitDbCode('duplicate')).toBe('invalid_payers');
    expect(splitDbCode('id')).toBe('invalid_payers');
    expect(splitDbCode('amount')).toBe('invalid_amount');
    expect(splitDbCode('participant')).toBe('not_participant');
    expect(splitDbCode('total')).toBe('payers_total');
  });
});

describe('payersState (contract W)', () => {
  it('one person when there are no rows: the payer paid the current total', () => {
    expect(payersState({ payerId: ID_B, rows: [], totalCents: TOTAL })).toEqual({
      mode: 'one',
      leadId: ID_B,
      payers: [{ userId: ID_B, paidCents: TOTAL }],
      stale: false,
      gapCents: 0,
      assignedCents: TOTAL,
    });
  });

  it('one person never goes stale when the total changes', () => {
    const s = payersState({ payerId: ID_B, rows: [], totalCents: 10321 });
    expect(s.stale).toBe(false);
    expect(s.payers).toEqual([{ userId: ID_B, paidCents: 10321 }]);
  });

  it('split, adding up', () => {
    const s = payersState({
      payerId: ID_A,
      rows: [
        { userId: ID_B, paidCents: 4021 },
        { userId: ID_A, paidCents: 6000 },
      ],
      totalCents: TOTAL,
    });
    expect(s).toEqual({
      mode: 'split',
      leadId: ID_A,
      payers: [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4021 },
      ],
      stale: false,
      gapCents: 0,
      assignedCents: TOTAL,
    });
  });

  it.each([
    [TOTAL + 1, 1],
    [TOTAL - 1, -1],
    [TOTAL + 300, 300],
  ])('stale when the total became %i (gap %i)', (total, gap) => {
    const s = payersState({
      payerId: ID_A,
      rows: [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4021 },
      ],
      totalCents: total,
    });
    expect(s.stale).toBe(true);
    expect(s.gapCents).toBe(gap);
    expect(s.assignedCents).toBe(TOTAL);
  });

  // W12 / W13: the order mirrors the DB's lead rule (largest amount, tie to the lower id by JS `<`).
  // lib never picks the lead (WP-21): leadId is always the stored payer_id.
  it('W12: A 5011 / B 5010 lists A first; A 5010 / B 5011 lists B first', () => {
    expect(ID_A < ID_B).toBe(true);
    const first = payersState({
      payerId: ID_A,
      rows: [
        { userId: ID_B, paidCents: 5010 },
        { userId: ID_A, paidCents: 5011 },
      ],
      totalCents: TOTAL,
    });
    expect(first.payers.map((p) => p.userId)).toEqual([ID_A, ID_B]);
    const second = payersState({
      payerId: ID_B,
      rows: [
        { userId: ID_A, paidCents: 5010 },
        { userId: ID_B, paidCents: 5011 },
      ],
      totalCents: TOTAL,
    });
    expect(second.payers.map((p) => p.userId)).toEqual([ID_B, ID_A]);
    expect(second.leadId).toBe(ID_B);
  });

  it('W13: a tie (total 10020, A 5010 / B 5010) lists the lower id (A) first', () => {
    const s = payersState({
      payerId: ID_A,
      rows: [
        { userId: ID_B, paidCents: 5010 },
        { userId: ID_A, paidCents: 5010 },
      ],
      totalCents: 10020,
    });
    expect(s.payers[0]?.userId).toBe(ID_A);
    expect(s.leadId).toBe(ID_A);
  });

  it('refuses stored rows the DB never leaves: one row, a duplicate, a bad amount, a lead not among them', () => {
    expect(() => payersState({ payerId: ID_A, rows: [{ userId: ID_A, paidCents: TOTAL }], totalCents: TOTAL })).toThrow(RangeError);
    expect(() =>
      payersState({
        payerId: ID_A,
        rows: [
          { userId: ID_A, paidCents: 1 },
          { userId: ID_A, paidCents: 2 },
        ],
        totalCents: 3,
      }),
    ).toThrow(RangeError);
    expect(() =>
      payersState({
        payerId: ID_A,
        rows: [
          { userId: ID_A, paidCents: 1.5 },
          { userId: ID_B, paidCents: 2 },
        ],
        totalCents: 3,
      }),
    ).toThrow(RangeError);
    expect(() =>
      payersState({
        payerId: ID_D,
        rows: [
          { userId: ID_A, paidCents: 1 },
          { userId: ID_B, paidCents: 2 },
        ],
        totalCents: 3,
      }),
    ).toThrow(RangeError);
    expect(() => payersState({ payerId: ID_A, rows: [], totalCents: 1.5 })).toThrow(RangeError);
  });
});

describe('payersChangeIsNoop (M5, set_payers step 6)', () => {
  const split = payersState({
    payerId: ID_A,
    rows: [
      { userId: ID_A, paidCents: 6000 },
      { userId: ID_B, paidCents: 4021 },
    ],
    totalCents: TOTAL,
  });
  const one = payersState({ payerId: ID_A, rows: [], totalCents: TOTAL });

  it('the identical split again (any order) is a no-op', () => {
    expect(
      payersChangeIsNoop(split, {
        mode: 'split',
        payers: [
          { userId: ID_B, paidCents: 4021 },
          { userId: ID_A, paidCents: 6000 },
        ],
      }),
    ).toBe(true);
  });

  it('new amounts, a new person, or one person from split are changes', () => {
    expect(
      payersChangeIsNoop(split, {
        mode: 'split',
        payers: [
          { userId: ID_A, paidCents: 6001 },
          { userId: ID_B, paidCents: 4020 },
        ],
      }),
    ).toBe(false);
    expect(
      payersChangeIsNoop(split, {
        mode: 'split',
        payers: [
          { userId: ID_A, paidCents: 6000 },
          { userId: ID_D, paidCents: 4021 },
        ],
      }),
    ).toBe(false);
    // From split, one person is never a no-op, even the lead (A-11).
    expect(payersChangeIsNoop(split, { mode: 'one', payerId: ID_A })).toBe(false);
  });

  it('one person to the same person is a no-op; to someone else, or to a split, is not', () => {
    expect(payersChangeIsNoop(one, { mode: 'one', payerId: ID_A })).toBe(true);
    expect(payersChangeIsNoop(one, { mode: 'one', payerId: ID_B })).toBe(false);
    expect(
      payersChangeIsNoop(one, {
        mode: 'split',
        payers: [
          { userId: ID_A, paidCents: 6000 },
          { userId: ID_B, paidCents: 4021 },
        ],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Contract A: the sheet's amounts.
// ---------------------------------------------------------------------------------------------
const f = (userId: string, text: string): SplitField => ({ userId, text });

describe('splitDraftStatus (contract A)', () => {
  it('Σ = total adds up and can save', () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.21'), f(ID_D, '')], TOTAL);
    expect(s).toMatchObject({
      kind: 'adds_up',
      text: 'Adds up to $100.21',
      tone: 'success',
      canSave: true,
      gapCents: 0,
      assignedCents: TOTAL,
      payingCount: 2,
      saveHint: null,
    });
  });

  it('1¢ under is left to assign (muted), no save', () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.20')], TOTAL);
    expect(s).toMatchObject({ kind: 'short', text: '$0.01 left to assign', tone: 'muted', canSave: false, gapCents: 1 });
    expect(s.saveHint).toBe('Amounts must add up to $100.21 first');
  });

  it('1¢ over is more than the total (warning), no save', () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.22')], TOTAL);
    expect(s).toMatchObject({ kind: 'over', text: '$0.01 more than the total', tone: 'warning', canSave: false, gapCents: -1 });
  });

  it("'0', '0.00' and '' mean not paying", () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.21'), f(ID_D, '0'), f(ID_C, '  '), f(ID_E, '0.00')], TOTAL);
    expect(s.kind).toBe('adds_up');
    expect(s.payingCount).toBe(2);
    expect(s.fields.map((x) => x.kind)).toEqual(['amount', 'amount', 'blank', 'blank', 'blank']);
  });

  it.each(['abc', '12.345', '-5', '1.2.3', '$', '.'])("'%s' is invalid with the format error", (text) => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, text)], TOTAL);
    expect(s.kind).toBe('invalid');
    expect(s.canSave).toBe(false);
    expect(s.tone).toBe('error');
    expect(s.text).toBe('Fix the amount marked above');
    expect(s.fields[1]).toEqual({ userId: ID_B, kind: 'invalid', error: 'Enter an amount like 12.50' });
  });

  it("'999999.99' is ok; '1000000.00' is too large", () => {
    // 999999.99 + 0.01 can't add up on a bill (the total caps at 99,999,999), so the field is what's checked.
    const ok = splitDraftStatus([f(ID_A, '999999.99'), f(ID_B, '0.01')], 99_999_999);
    expect(ok.fields[0]).toEqual({ userId: ID_A, kind: 'amount', cents: 99_999_999 });
    expect(ok.kind).toBe('over');
    const big = splitDraftStatus([f(ID_A, '1000000.00'), f(ID_B, '1')], TOTAL);
    expect(big.fields[0]).toEqual({ userId: ID_A, kind: 'invalid', error: 'That amount is too large' });
    expect(big.kind).toBe('invalid');
  });

  it('two valid fields that add up plus an invalid one never adds up', () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.21'), f(ID_D, 'abc')], TOTAL);
    expect(s.kind).toBe('invalid');
    expect(s.canSave).toBe(false);
  });

  it('two invalid fields say "amounts" (count 1 vs 2)', () => {
    const s = splitDraftStatus([f(ID_A, 'x'), f(ID_B, 'y')], TOTAL);
    expect(s.text).toBe('Fix the amounts marked above');
  });

  it('accepts the same lenient input as the bill form: $, commas, one decimal', () => {
    const s = splitDraftStatus([f(ID_A, '$60'), f(ID_B, '40.21'), f(ID_D, '')], TOTAL);
    expect(s.kind).toBe('adds_up');
    const t = splitDraftStatus([f(ID_A, '$1,000.5'), f(ID_B, '.5')], 100_100);
    expect(t.kind).toBe('adds_up');
  });

  it('all blank shows the whole total left to assign (one line, S7)', () => {
    const s = splitDraftStatus([f(ID_A, ''), f(ID_B, '')], TOTAL);
    expect(s).toMatchObject({ kind: 'short', text: '$100.21 left to assign', payingCount: 0, canSave: false });
  });

  it('one person short of the total shows only the gap line (S7)', () => {
    const s = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '')], TOTAL);
    expect(s).toMatchObject({ kind: 'short', text: '$40.21 left to assign', payingCount: 1 });
  });

  it('one person with the whole total is one_payer (WP-50), no save', () => {
    const s = splitDraftStatus([f(ID_A, ''), f(ID_B, '100.21')], TOTAL);
    expect(s).toMatchObject({
      kind: 'one_payer',
      text: "That's one person paying the whole bill.",
      tone: 'muted',
      canSave: false,
      onePayerId: ID_B,
    });
  });

  it('one person over the total is over', () => {
    expect(splitDraftStatus([f(ID_A, '200.00'), f(ID_B, '')], TOTAL).kind).toBe('over');
  });

  it('is unavailable with fewer than 2 people or a total under 2¢', () => {
    expect(splitDraftStatus([f(ID_A, '')], TOTAL)).toMatchObject({ kind: 'unavailable', reason: 'people', canSave: false });
    expect(splitDraftStatus([f(ID_A, ''), f(ID_B, '')], 1)).toMatchObject({ kind: 'unavailable', reason: 'total', canSave: false });
    expect(splitDraftStatus([f(ID_A, '0.01'), f(ID_B, '0.01')], 2).kind).toBe('adds_up');
  });

  it('more than 50 people with an amount cannot save (the DB refuses > 50)', () => {
    const fields = Array.from({ length: 51 }, (_, i) => f(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '0.01'));
    expect(splitDraftStatus(fields, 51)).toMatchObject({ kind: 'too_many', canSave: false });
  });

  it('refuses a non-integer or out-of-range total', () => {
    expect(() => splitDraftStatus([f(ID_A, '')], 1.5)).toThrow(RangeError);
    expect(() => splitDraftStatus([f(ID_A, '')], -1)).toThrow(RangeError);
  });

  it('a draft that saves always passes validateSplit (same rule both ways)', () => {
    const drafts: SplitField[][] = [
      [f(ID_A, '60.00'), f(ID_B, '40.21'), f(ID_D, '')],
      [f(ID_A, '0.01'), f(ID_B, '100.20')],
      [f(ID_A, '33.40'), f(ID_B, '33.40'), f(ID_D, '33.41')],
    ];
    for (const d of drafts) {
      expect(splitDraftStatus(d, TOTAL).canSave).toBe(true);
      const payload = toPayersPayload(d);
      expect(
        validateSplit(
          payload.map((p) => ({ userId: p.user_id, paidCents: p.paid_cents })),
          { totalCents: TOTAL, participantIds: PARTICIPANTS },
        ).ok,
      ).toBe(true);
    }
  });
});

describe('toPayersPayload', () => {
  it('lists people with an amount, in participant (field) order', () => {
    expect(toPayersPayload([f(ID_D, ''), f(ID_B, '40.21'), f(ID_A, '60'), f(ID_C, '0')])).toEqual([
      { user_id: ID_B, paid_cents: 4021 },
      { user_id: ID_A, paid_cents: 6000 },
    ]);
  });

  it('refuses a draft with an invalid field rather than dropping it', () => {
    expect(() => toPayersPayload([f(ID_A, '60'), f(ID_B, 'abc')])).toThrow(RangeError);
  });
});

describe('prefill and change (WP-14, S9)', () => {
  const split = payersState({
    payerId: ID_A,
    rows: [
      { userId: ID_A, paidCents: 6000 },
      { userId: ID_B, paidCents: 4021 },
    ],
    totalCents: TOTAL,
  });
  const one = payersState({ payerId: ID_A, rows: [], totalCents: TOTAL });

  it('from split mode, the stored amounts exactly; others blank; participant order', () => {
    expect(prefillSplitFields(split, [ID_D, ID_B, ID_A])).toEqual([f(ID_D, ''), f(ID_B, '40.21'), f(ID_A, '60.00')]);
  });

  it('from one-person mode, every field blank', () => {
    expect(prefillSplitFields(one, [ID_A, ID_B])).toEqual([f(ID_A, ''), f(ID_B, '')]);
  });

  it('the reloaded draft is unchanged; a 1¢ edit or a retyped equal value is judged by amounts', () => {
    const fields = prefillSplitFields(split, [ID_A, ID_B, ID_D]);
    expect(splitDraftChanged(fields, split)).toBe(false);
    expect(splitDraftChanged([f(ID_A, '60'), f(ID_B, '40.21'), f(ID_D, '0')], split)).toBe(false);
    expect(splitDraftChanged([f(ID_A, '60.01'), f(ID_B, '40.20'), f(ID_D, '')], split)).toBe(true);
  });

  it('any valid split draft is a change from one-person mode', () => {
    expect(splitDraftChanged([f(ID_A, '60.00'), f(ID_B, '40.21')], one)).toBe(true);
  });

  it('an invalid draft is never "unchanged"', () => {
    expect(splitDraftChanged([f(ID_A, '60.00'), f(ID_B, 'abc')], split)).toBe(true);
  });
});

describe('addTheRest (M2)', () => {
  const viewer = ID_A;
  const nameOf = nameOfFor(viewer);

  it('targets the last focused row and fills exactly the gap', () => {
    const r = addTheRest({ fields: [f(ID_A, '60.00'), f(ID_B, '')], totalCents: TOTAL, targetUserId: ID_B, viewerId: viewer, nameOf });
    expect(r).toEqual({
      userId: ID_B,
      cents: 4021,
      text: '40.21',
      label: 'Add the rest ($40.21) to Sam',
      a11yLabel: 'Add the rest, $40.21, to Sam',
      a11yHint: "Sets Sam's amount to $40.21",
    });
    const after = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, r?.text ?? '')], TOTAL);
    expect(after.kind).toBe('adds_up');
  });

  it("adds to the target's existing amount", () => {
    const r = addTheRest({ fields: [f(ID_A, '50.00'), f(ID_B, '10.00')], totalCents: TOTAL, targetUserId: ID_B, viewerId: viewer, nameOf });
    expect(r).toMatchObject({ cents: 5021, text: '50.21', label: 'Add the rest ($40.21) to Sam', a11yHint: "Sets Sam's amount to $50.21" });
  });

  it('uses "you" for the viewer (lowercase mid-sentence)', () => {
    const r = addTheRest({ fields: [f(ID_A, '60.00'), f(ID_B, '37.21')], totalCents: TOTAL, targetUserId: ID_A, viewerId: viewer, nameOf });
    expect(r).toMatchObject({
      label: 'Add the rest ($3.00) to you',
      a11yLabel: 'Add the rest, $3.00, to you',
      a11yHint: 'Sets your amount to $63.00',
    });
  });

  it('before any focus, targets the one blank row when exactly one is blank and one has an amount', () => {
    const r = addTheRest({ fields: [f(ID_A, '60.00'), f(ID_B, '')], totalCents: TOTAL, targetUserId: null, viewerId: viewer, nameOf });
    expect(r?.userId).toBe(ID_B);
    expect(
      addTheRest({ fields: [f(ID_A, '60.00'), f(ID_B, ''), f(ID_D, '')], totalCents: TOTAL, targetUserId: null, viewerId: viewer, nameOf }),
    ).toBeNull();
    expect(addTheRest({ fields: [f(ID_A, ''), f(ID_B, '')], totalCents: TOTAL, targetUserId: null, viewerId: viewer, nameOf })).toBeNull();
  });

  it('hidden when nothing is left, when over, when the target is invalid, or when any field is invalid', () => {
    const base = { totalCents: TOTAL, targetUserId: ID_B, viewerId: viewer, nameOf };
    expect(addTheRest({ ...base, fields: [f(ID_A, '60.00'), f(ID_B, '40.21')] })).toBeNull();
    expect(addTheRest({ ...base, fields: [f(ID_A, '160.00'), f(ID_B, '')] })).toBeNull();
    expect(addTheRest({ ...base, fields: [f(ID_A, '60.00'), f(ID_B, 'abc')] })).toBeNull();
    expect(addTheRest({ ...base, fields: [f(ID_A, 'abc'), f(ID_B, '')] })).toBeNull();
  });

  it('hidden for a target that is not a row, and when split is unavailable', () => {
    expect(addTheRest({ fields: [f(ID_A, '60.00'), f(ID_B, '')], totalCents: TOTAL, targetUserId: ID_C, viewerId: viewer, nameOf })).toBeNull();
    expect(addTheRest({ fields: [f(ID_A, '')], totalCents: TOTAL, targetUserId: ID_A, viewerId: viewer, nameOf })).toBeNull();
  });

  it('a blank name reads "a friend", never an empty string', () => {
    const r = addTheRest({
      fields: [f(ID_A, '60.00'), f(ID_B, '')],
      totalCents: TOTAL,
      targetUserId: ID_B,
      viewerId: viewer,
      nameOf: (id) => (id === viewer ? 'You' : '  '),
    });
    expect(r?.label).toBe('Add the rest ($40.21) to a friend');
    expect(r?.a11yHint).toBe("Sets a friend's amount to $40.21");
  });
});

describe('paidItAllLink (S7 / WP-50) and splitStatusSpoken (M4)', () => {
  const viewer = ID_A;
  const nameOf = nameOfFor(viewer);

  it('"Sam paid it all", and sentence-initial "You paid it all" for the viewer', () => {
    expect(paidItAllLink(ID_B, viewer, nameOf)).toEqual({
      label: 'Sam paid it all',
      a11yLabel: 'Sam paid it all',
      a11yHint: 'Saves Sam as the one person who paid',
    });
    expect(paidItAllLink(ID_A, viewer, nameOf)).toEqual({
      label: 'You paid it all',
      a11yLabel: 'You paid it all',
      a11yHint: 'Saves you as the one person who paid',
    });
  });

  it('spoken copy per status, with an announce key that changes only with kind or amount', () => {
    const short = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '')], TOTAL);
    expect(splitStatusSpoken(short, viewer, nameOf)).toBe('$40.21 left to assign');
    const over = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '43.21')], TOTAL);
    expect(splitStatusSpoken(over, viewer, nameOf)).toBe('$3.00 more than the total');
    const ok = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, '40.21')], TOTAL);
    expect(splitStatusSpoken(ok, viewer, nameOf)).toBe('Adds up to $100.21. You can save now.');
    const bad = splitDraftStatus([f(ID_A, '60.00'), f(ID_B, 'abc')], TOTAL);
    expect(splitStatusSpoken(bad, viewer, nameOf)).toBe("Sam's amount isn't valid. Enter an amount like 12.50.");
    const mine = splitDraftStatus([f(ID_A, 'abc'), f(ID_B, '')], TOTAL);
    expect(splitStatusSpoken(mine, viewer, nameOf)).toBe("Your amount isn't valid. Enter an amount like 12.50.");
    const big = splitDraftStatus([f(ID_A, '1000000'), f(ID_B, '')], TOTAL);
    expect(splitStatusSpoken(big, viewer, nameOf)).toBe("Your amount is too large.");
    const one = splitDraftStatus([f(ID_A, ''), f(ID_B, '100.21')], TOTAL);
    expect(splitStatusSpoken(one, viewer, nameOf)).toBe("That's one person paying the whole bill.");

    // Same kind and amount: same key, so the announcer stays quiet.
    const sameGap = splitDraftStatus([f(ID_A, '50.00'), f(ID_B, '10.00')], TOTAL);
    expect(sameGap.announceKey).toBe(short.announceKey);
    expect(over.announceKey).not.toBe(short.announceKey);
    expect(splitDraftStatus([f(ID_A, '60.01'), f(ID_B, '')], TOTAL).announceKey).not.toBe(short.announceKey);
  });
});

// ---------------------------------------------------------------------------------------------
// Contract M: table M. Pairs Sam→A 1510, Dee→A 1200, Pat→B 900; Ann has a flag only, to A.
// "A" and "B" are payers here (ids ID_A, ID_B); Sam, Dee, Pat, Ann are others.
// ---------------------------------------------------------------------------------------------
describe('paymentsMovedBy (table M)', () => {
  const SAM = '10000000-0000-4000-8000-000000000000';
  const DEE = '20000000-0000-4000-8000-000000000000';
  const PAT = '30000000-0000-4000-8000-000000000000';
  const ANN = '40000000-0000-4000-8000-000000000000';
  const PRIYA = '50000000-0000-4000-8000-000000000000';
  const SAMP = '60000000-0000-4000-8000-000000000000'; // M8's ex-payer "Sam"
  const pairs: PairNet[] = [
    { fromId: PAT, toId: ID_B, netCents: 900 },
    { fromId: DEE, toId: ID_A, netCents: 1200 },
    { fromId: SAM, toId: ID_A, netCents: 1510 },
  ];
  const flags = [{ fromId: ANN, toId: ID_A }];

  it('M1: one person A → one person B moves Dee→A and Sam→A, ordered by (from, to)', () => {
    expect(paymentsMovedBy(pairs, [ID_A], [ID_B])).toEqual([
      { fromId: SAM, toId: ID_A, cents: 1510 },
      { fromId: DEE, toId: ID_A, cents: 1200 },
    ]);
  });

  it('M2: split A+B → A+B with new amounts moves nothing', () => {
    expect(paymentsMovedBy(pairs, [ID_A, ID_B], [ID_B, ID_A])).toEqual([]);
  });

  it('M3: A+B → A+C moves Pat→B', () => {
    expect(paymentsMovedBy(pairs, [ID_A, ID_B], [ID_A, ID_C])).toEqual([{ fromId: PAT, toId: ID_B, cents: 900 }]);
  });

  it('M4: A+B → one person A moves Pat→B', () => {
    expect(paymentsMovedBy(pairs, [ID_A, ID_B], [ID_A])).toEqual([{ fromId: PAT, toId: ID_B, cents: 900 }]);
  });

  it('M5: the identical split again is a no-op (nothing moved, and payersChangeIsNoop says so)', () => {
    expect(paymentsMovedBy(pairs, [ID_A, ID_B], [ID_A, ID_B])).toEqual([]);
  });

  it('M6: A → A+B moves nothing', () => {
    expect(paymentsMovedBy(pairs, [ID_A], [ID_A, ID_B])).toEqual([]);
  });

  it("M7: Ann's flag is never moved; it is dropped when A leaves the payer set and kept in M2", () => {
    const withAnn: PairNet[] = [...pairs, { fromId: ANN, toId: ID_A, netCents: 0 }];
    expect(paymentsMovedBy(withAnn, [ID_A], [ID_B]).map((m) => m.fromId)).not.toContain(ANN);
    // Positive control: the same list does move Sam and Dee, so the absence above means something.
    expect(paymentsMovedBy(withAnn, [ID_A], [ID_B])).toHaveLength(2);
    expect(flagsDroppedBy(flags, [ID_B])).toEqual(flags);
    expect(flagsDroppedBy(flags, [ID_A, ID_B])).toEqual([]);
  });

  it('M8: a pair already pointing at an ex-payer is not moved again', () => {
    const withPriya: PairNet[] = [...pairs, { fromId: PRIYA, toId: SAMP, netCents: 1200 }];
    expect(paymentsMovedBy(withPriya, [ID_A], [ID_B]).map((m) => m.fromId)).toEqual([SAM, DEE]);
  });

  it('ignores pairs with net ≤ 0 and refuses malformed pairs', () => {
    expect(paymentsMovedBy([{ fromId: SAM, toId: ID_A, netCents: -300 }], [ID_A], [ID_B])).toEqual([]);
    expect(() => paymentsMovedBy([{ fromId: SAM, toId: ID_A, netCents: 1.5 }], [ID_A], [ID_B])).toThrow(RangeError);
    expect(() =>
      paymentsMovedBy(
        [
          { fromId: SAM, toId: ID_A, netCents: 1 },
          { fromId: SAM, toId: ID_A, netCents: 2 },
        ],
        [ID_A],
        [ID_B],
      ),
    ).toThrow(RangeError);
  });

  it('a payer-to-payer pair to a removed payer moves too', () => {
    expect(paymentsMovedBy([{ fromId: ID_B, toId: ID_A, netCents: 300 }], [ID_A, ID_B], [ID_B])).toEqual([
      { fromId: ID_B, toId: ID_A, cents: 300 },
    ]);
  });

  it('gives the same answer for any input order', () => {
    expect(paymentsMovedBy([...pairs].reverse(), [ID_A], [ID_B])).toEqual(paymentsMovedBy(pairs, [ID_A], [ID_B]));
  });
});

// ---------------------------------------------------------------------------------------------
// paidByLine (D6 as amended by A1.5).
// ---------------------------------------------------------------------------------------------
describe('paidByLine (A1.5)', () => {
  const HOST = ID_A; // Hana
  const JOIN = [ID_A, ID_B, ID_C, ID_D, ID_E];
  const one = (payerId: string) => payersState({ payerId, rows: [], totalCents: TOTAL });
  const split = (rows: { userId: string; paidCents: number }[], totalCents = TOTAL, lead = rows[0]?.userId ?? ID_A) =>
    payersState({ payerId: lead, rows, totalCents });
  const line = (state: ReturnType<typeof payersState>, viewerId: string, nameOf = nameOfFor(viewerId)) =>
    paidByLine({ state, viewerId, hostId: HOST, joinOrder: JOIN, nameOf });

  it('one person, the viewer (host) paid: "Paid by you · Change"', () => {
    expect(line(one(ID_A), ID_A)).toEqual({
      text: 'Paid by you',
      action: 'change',
      actionLabel: 'Change',
      tone: 'muted',
      icon: null,
      a11yLabel: 'Paid by you. Change who paid',
      a11yHint: 'Opens who paid',
    });
  });

  it('one person, someone else, host and non-host', () => {
    expect(line(one(ID_B), ID_A)).toMatchObject({ text: 'Paid by Sam', action: 'change', a11yLabel: 'Paid by Sam. Change who paid' });
    expect(line(one(ID_B), ID_D)).toEqual({
      text: 'Paid by Sam',
      action: null,
      actionLabel: null,
      tone: 'muted',
      icon: null,
      a11yLabel: 'Paid by Sam',
      a11yHint: null,
    });
  });

  it('one person, a non-host viewer paid: lowercase "you"', () => {
    expect(line(one(ID_B), ID_B)).toMatchObject({ text: 'Paid by you', action: null });
  });

  it('a blank name reads "a friend", never "Paid by "', () => {
    expect(line(one(ID_B), ID_D, (id) => (id === ID_D ? 'You' : ''))).toMatchObject({ text: 'Paid by a friend' });
    expect(line(one(ID_B), ID_D, () => { throw new Error('boom'); })).toMatchObject({ text: 'Paid by a friend' });
  });

  it('split, 2 payers: the viewer first, with amounts', () => {
    const s = split([
      { userId: ID_A, paidCents: 6000 },
      { userId: ID_B, paidCents: 4021 },
    ]);
    expect(line(s, ID_A)).toMatchObject({
      text: 'Paid by you $60.00 and Sam $40.21',
      action: 'change',
      a11yLabel: 'Paid by you $60.00 and Sam $40.21. Change who paid',
    });
    // Sam views: Sam first even though Hana paid more.
    expect(line(s, ID_B)).toMatchObject({ text: 'Paid by you $40.21 and Hana $60.00', action: null });
    // Dee (not a payer, not host): amount order.
    expect(line(s, ID_C)).toMatchObject({ text: 'Paid by Hana $60.00 and Sam $40.21', action: null, a11yLabel: 'Paid by Hana $60.00 and Sam $40.21' });
  });

  it('split, 3 payers: amount descending, then join order', () => {
    const s = split([
      { userId: ID_A, paidCents: 5000 },
      { userId: ID_D, paidCents: 2511 },
      { userId: ID_B, paidCents: 2510 },
    ]);
    expect(line(s, ID_A).text).toBe('Paid by you $50.00, Pat $25.11 and Sam $25.10');
    // An equal amount falls back to join order (Sam joined before Pat), not id or name.
    const tie = split([
      { userId: ID_A, paidCents: 5021 },
      { userId: ID_D, paidCents: 2500 },
      { userId: ID_B, paidCents: 2500 },
    ]);
    expect(line(tie, ID_C).text).toBe('Paid by Hana $50.21, Sam $25.00 and Pat $25.00');
  });

  it('split, 4+ payers: host "Paid by 4 people · Change"; others name two and count the rest', () => {
    const s = split([
      { userId: ID_A, paidCents: 4000 },
      { userId: ID_B, paidCents: 3000 },
      { userId: ID_C, paidCents: 2000 },
      { userId: ID_D, paidCents: 1021 },
    ]);
    expect(line(s, ID_A)).toMatchObject({ text: 'Paid by 4 people', action: 'change', a11yLabel: 'Paid by 4 people. Change who paid' });
    expect(line(s, ID_E)).toMatchObject({ text: 'Paid by Hana, Sam and 2 others', action: null });
    expect(line(s, ID_D)).toMatchObject({ text: 'Paid by you, Hana and 2 others' });
    const five = split([
      { userId: ID_A, paidCents: 4000 },
      { userId: ID_B, paidCents: 3000 },
      { userId: ID_C, paidCents: 2000 },
      { userId: ID_D, paidCents: 1000 },
      { userId: ID_E, paidCents: 21 },
    ]);
    expect(line(five, ID_C).text).toBe('Paid by you, Hana and 3 others');
  });

  it('never reads "1 people" or "1 others", and never "You" mid-sentence', () => {
    const states = [
      one(ID_A),
      one(ID_B),
      split([
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4021 },
      ]),
      split([
        { userId: ID_A, paidCents: 5000 },
        { userId: ID_B, paidCents: 3000 },
        { userId: ID_C, paidCents: 2021 },
      ]),
      split([
        { userId: ID_A, paidCents: 4000 },
        { userId: ID_B, paidCents: 3000 },
        { userId: ID_C, paidCents: 2000 },
        { userId: ID_D, paidCents: 1021 },
      ]),
    ];
    for (const s of states) {
      for (const v of JOIN) {
        const l = line(s, v);
        expect(l.text).not.toMatch(/\b1 (people|others)\b/);
        expect(l.text).not.toMatch(/.\bYou\b/);
        expect(l.a11yLabel).not.toMatch(/.\bYou\b/);
      }
    }
  });

  it.each([
    ['short', TOTAL + 300],
    ['over', TOTAL - 300],
  ])('stale (%s): host gets the warning with Fix; others wait for the host', (_label, total) => {
    const s = split(
      [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4021 },
      ],
      total,
    );
    expect(s.stale).toBe(true);
    expect(line(s, ID_A)).toEqual({
      text: "Who paid doesn't match the new total",
      action: 'fix',
      actionLabel: 'Fix',
      tone: 'warning',
      icon: 'warning',
      a11yLabel: "Who paid doesn't match the new total. Fix who paid",
      a11yHint: 'Opens who paid',
    });
    expect(line(s, ID_B)).toEqual({
      text: 'Waiting for Hana to update who paid',
      action: null,
      actionLabel: null,
      tone: 'muted',
      icon: null,
      a11yLabel: 'Waiting for Hana to update who paid',
      a11yHint: null,
    });
  });

  it('stale with a nameless host reads "the host"', () => {
    const s = split(
      [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4022 },
      ],
      TOTAL,
    );
    expect(line(s, ID_D, (id) => (id === ID_D ? 'You' : ' ')).text).toBe('Waiting for the host to update who paid');
  });

  it('1¢ off is already stale (tolerance 0)', () => {
    const s = split(
      [
        { userId: ID_A, paidCents: 6000 },
        { userId: ID_B, paidCents: 4020 },
      ],
      TOTAL,
    );
    expect(line(s, ID_A).action).toBe('fix');
  });
});
