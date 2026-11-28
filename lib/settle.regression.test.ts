// Single-payer regression guard (docs/specs/2026-11-26-who-paid.md, A1.7 Task 6.0; eng review S1;
// criterion A-24's first bullet). lib/__fixtures__/settle-single-payer.json holds 1,000 seeded
// single-payer bills (inputs and today's outputs), captured before any who-paid lib edit. This test
// re-runs settlePlan(…, { allowEarly: true }), settleCard, settlePeople, settleFooterAction and
// billMarker on the committed inputs and compares with toStrictEqual.
//
// If a later task fails here, the change altered what a single-payer bill shows. Fix the code, or
// adapt the builder in test-utils/legacyMarks.ts for a new signature. Never regenerate the fixture
// or edit its outputs to make a change pass (WP-5: "same objects as today").
import {
  caseCoverage,
  fixtureCoverage,
  legacyLedgerOf,
  legacyMarksToPairs,
  legacyMarksToPayments,
  settleOutputsFor,
  type FixtureCoverage,
  type LegacyCase,
  type SettleFixture,
} from '@/test-utils/legacyMarks';
import { stillToCollectCents, viewerBalance } from './homeSections';
import { balanceFor, ledgerSettlePlan } from './settle';
import { computeShares } from './split';
import { settleTransfers, transfersFromReadyPlan, type SettleTransfersInput } from './transfers';

// settleView reads BILL_ERROR_COPY from lib/bills.ts, which creates the Supabase client on import.
// Nothing here calls it.
jest.mock('./supabase', () => ({ supabase: {} }));

const MIN_CASES = 1000;
const MIN_EACH = 30;
const BASELINE_FILES = ['lib/settle.ts', 'lib/settleView.ts', 'lib/homeMarkers.ts', 'lib/bills.ts'];

// Read with fs rather than `import` so tsc doesn't infer a type for a 4.7 MB literal (the app's
// tsconfig has no Node types, so fs is typed here, as in lib/paymentMethods.test.ts). JSON.parse
// returns `any`; the shape is SettleFixture by construction (checked field by field below).
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const FIXTURE = `${process.cwd()}/lib/__fixtures__/settle-single-payer.json`;
const fixture: SettleFixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const { header, cases } = fixture;

/** A deep copy, so a mutation in a positive control can't leak into the shared fixture. */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('the fixture', () => {
  it('records the baseline it was captured from', () => {
    expect(header.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(header.baseline).toMatch(/uncommitted working tree/);
    expect(Object.keys(header.baselineFiles).sort()).toEqual([...BASELINE_FILES].sort());
    for (const hash of Object.values(header.baselineFiles)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isSafeInteger(header.seed)).toBe(true);
  });

  it(`has at least ${MIN_CASES} cases, numbered in order`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(MIN_CASES);
    expect(header.caseCount).toBe(cases.length);
    cases.forEach((c, i) => expect(c.id).toBe(i));
  });

  it(`has at least ${MIN_EACH} cases of each S1 kind, as the header says`, () => {
    const counts = fixtureCoverage(cases.map((c) => c.output));
    expect(counts).toStrictEqual(header.coverage);
    for (const [kind, n] of Object.entries(counts)) {
      expect({ kind, atLeast: n >= MIN_EACH }).toEqual({ kind, atLeast: true });
    }
  });

  it('is single-payer: the payer never has a mark, every mark is to the payer, and every participant has an entry', () => {
    for (const { id, input } of cases) {
      const ids = [...input.split.participantIds].sort();
      expect({ id, payerIn: ids.includes(input.payerId) }).toEqual({ id, payerIn: true });
      expect({ id, payerMark: input.marks[input.payerId] }).toEqual({ id, payerMark: null });
      expect({ id, keys: Object.keys(input.marks).sort() }).toEqual({ id, keys: ids });
      expect({ id, keys: Object.keys(input.notReceived).sort() }).toEqual({ id, keys: ids });
      for (const mark of Object.values(input.marks)) {
        if (mark !== null) expect({ id, to: mark.toUserId, cents: mark.cents >= 1 }).toEqual({ id, to: input.payerId, cents: true });
      }
    }
  });
});

describe("today's functions on the fixture inputs", () => {
  it.each(['plan', 'card', 'people', 'footer', 'marker'] as const)('%s deep-equals the committed output for every case', (field) => {
    for (const { id, input, output } of cases) {
      const fresh = settleOutputsFor(input);
      expect({ id, [field]: fresh[field] }).toStrictEqual({ id, [field]: output[field] });
    }
  });

  // Positive controls: the comparison above can fail.
  it('fails when a mark moves by 1¢', () => {
    const c = cases.find((x) => x.output.plan.status === 'ready' && Object.values(x.input.marks).some((m) => m !== null));
    if (c === undefined) throw new Error('no ready case with a mark');
    const input = clone(c.input);
    const [userId, mark] = Object.entries(input.marks).find(([, m]) => m !== null) ?? [];
    if (userId === undefined || !mark) throw new Error('unreachable');
    input.marks[userId] = { ...mark, cents: mark.cents + 1 };
    expect(() => expect(settleOutputsFor(input).plan).toStrictEqual(c.output.plan)).toThrow();
  });

  it('fails when an expected output gains a field that is undefined', () => {
    const c = cases[0] as LegacyCase;
    const expected = { ...clone(c.output.card), extra: undefined };
    expect(() => expect(settleOutputsFor(c.input).card).toStrictEqual(expected)).toThrow();
  });
});

describe('legacyMarksToPairs (S1 adapter) agrees with the ledger code', () => {
  const plans = cases.flatMap((c) => {
    const p = c.output.plan;
    return p.status === 'ready' || p.status === 'early' ? [{ c, plan: p }] : [];
  });

  it('covers ready and early plans', () => {
    expect(plans.filter((x) => x.plan.status === 'ready').length).toBeGreaterThanOrEqual(MIN_EACH);
    expect(plans.filter((x) => x.plan.status === 'early').length).toBeGreaterThanOrEqual(MIN_EACH);
  });

  it("legacyMarksToPayments has one entry per mark, never from the payer", () => {
    for (const { c } of plans) {
      const entries = legacyMarksToPayments(c.input.marks);
      const marked = Object.values(c.input.marks).filter((m) => m !== null).length;
      expect({ id: c.id, n: entries.length, fromPayer: entries.some((e) => e.fromId === c.input.payerId) }).toEqual({
        id: c.id,
        n: marked,
        fromPayer: false,
      });
    }
  });

  it('settleTransfers on the marks as earlier-key or current-key entries gives the same pairs and outside routes', () => {
    for (const { c, plan } of plans) {
      const shares = computeShares(c.input.split).people.map((p) => ({ userId: p.userId, shareCents: p.totalCents }));
      const base: SettleTransfersInput = {
        mode: 'one',
        leadId: c.input.payerId,
        payers: [{ userId: c.input.payerId, paidCents: c.input.split.totalCents }],
        shares,
        entries: legacyMarksToPayments(c.input.marks),
        early: plan.status === 'early',
      };
      const want = legacyMarksToPairs(plan);
      const pre = settleTransfers(base);
      expect({ id: c.id, pairs: pre.pairs, outside: pre.outside }).toStrictEqual({ id: c.id, ...want });
      const post = settleTransfers({ ...base, entries: legacyMarksToPayments(c.input.marks, { planKey: pre.key }) });
      expect({ id: c.id, pairs: post.pairs, outside: post.outside }).toStrictEqual({ id: c.id, ...want });
    }
  });
});

describe('the ledger path (Task 6) gives today\'s plan on every case', () => {
  it('ledgerSettlePlan on the case as a ledger deep-equals the committed plan, with earlier-key or current-key payments', () => {
    for (const { id, input, output } of cases) {
      const pre = ledgerSettlePlan(input.split, legacyLedgerOf(input), { allowEarly: true });
      expect({ id, plan: pre.plan }).toStrictEqual({ id, plan: output.plan });
      const hasKey = output.plan.status === 'ready' || output.plan.status === 'early';
      expect({ id, hasKey: pre.planKey !== null }).toEqual({ id, hasKey });
      if (pre.planKey === null) continue;
      const post = ledgerSettlePlan(input.split, legacyLedgerOf(input, { planKey: pre.planKey }), { allowEarly: true });
      expect({ id, plan: post.plan, key: post.planKey }).toStrictEqual({ id, plan: output.plan, key: pre.planKey });
    }
  });

  it("the plan key is settleTransfers' key", () => {
    for (const { id, input, output } of cases) {
      const plan = output.plan;
      if (plan.status !== 'ready' && plan.status !== 'early') continue;
      const shares = computeShares(input.split).people.map((p) => ({ userId: p.userId, shareCents: p.totalCents }));
      const t = settleTransfers({
        mode: 'one',
        leadId: input.payerId,
        payers: [{ userId: input.payerId, paidCents: input.split.totalCents }],
        shares,
        entries: legacyMarksToPayments(input.marks),
        early: plan.status === 'early',
      });
      expect({ id, key: ledgerSettlePlan(input.split, legacyLedgerOf(input), { allowEarly: true }).planKey }).toEqual({ id, key: t.key });
    }
  });

  it('transfersFromReadyPlan is the S1 adapter', () => {
    for (const { id, output } of cases) {
      const plan = output.plan;
      if (plan.status !== 'ready' && plan.status !== 'early') continue;
      const got = transfersFromReadyPlan(plan);
      expect({ id, ...got }).toStrictEqual({ id, ...legacyMarksToPairs(plan), provenance: { heldFor: {}, passedOnBy: {} } });
    }
  });

  it("balanceFor (S2) matches Home's viewerBalance and stillToCollectCents for every participant", () => {
    for (const { id, input, output } of cases) {
      const summary = { payerId: input.payerId };
      for (const userId of input.split.participantIds) {
        const today = viewerBalance(summary, output.plan, userId);
        const b = balanceFor(output.plan, userId);
        if (!today.known) {
          expect({ id, userId, b }).toEqual({ id, userId, b: { known: false } });
          continue;
        }
        if (!b.known) throw new Error(`case ${id}: balanceFor unknown for ${userId}`);
        expect({ id, userId, final: b.final, owes: b.owesCents > 0, owed: b.owedCents > 0 }).toEqual({
          id,
          userId,
          final: today.final,
          owes: today.owes,
          owed: today.owed,
        });
        if (userId === input.payerId) {
          expect({ id, owed: b.owedCents }).toEqual({ id, owed: stillToCollectCents(output.plan, userId) });
        }
      }
    }
  });
});

describe('fixtureCoverage', () => {
  it('counts a case once per kind it has', () => {
    const kinds = Object.keys(header.coverage) as (keyof FixtureCoverage)[];
    const some = cases.find((c) => kinds.filter((k) => caseCoverage(c.output)[k]).length >= 2);
    if (some === undefined) throw new Error('no case with two kinds');
    const one = fixtureCoverage([some.output]);
    for (const k of kinds) expect(one[k]).toBe(caseCoverage(some.output)[k] ? 1 : 0);
  });
});
