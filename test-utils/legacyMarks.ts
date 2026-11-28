// Single-payer regression fixture (docs/specs/2026-11-26-who-paid.md, Amendment A1.7 Task 6.0;
// eng review S1). Shared by lib/settle.regression.test.ts and the seeded generator
// (test-utils/settleSinglePayerGen.ts):
//   - the fixture's types (inputs as plain JSON, today's outputs);
//   - `settleOutputsFor`: one case's inputs → settlePlan, settleCard, settlePeople,
//     settleFooterAction and billMarker, built the way the app builds them today
//     (settleViewInputFor's wiring, without BillData);
//   - the `legacyMarksToPairs` adapter (today's marks/plan → contract T's pairs and outside routes)
//     and `legacyMarksToPayments` (today's marks → `bill_payments`-style ledger entries), so later
//     tasks can feed the same cases through the ledger code;
//   - `legacyLedgerOf`: a case as BillData's ledger (no payer rows, marks as payments, flags), for
//     ledgerSettlePlan;
//   - `fixtureCoverage`: the S1 coverage counts.
//
// The fixture freezes today's behaviour. When a later task changes these functions' signatures,
// adapt the builder here, never the fixture's expected outputs.
import { makeNameOf } from '../lib/billView';
import { billMarker, type HomeMarker } from '../lib/homeMarkers';
import type { PaymentMethod } from '../lib/paymentMethods';
import {
  settlePlan,
  type SettleEarly,
  type SettleLedger,
  type SettleMark,
  type SettleNotReceived,
  type SettlePlanWithEarly,
  type SettleReady,
} from '../lib/settle';
import {
  settleCard,
  settleFooterAction,
  settlePeople,
  type OpenedVenmo,
  type SentCheckContext,
  type SettleCardModel,
  type SettleFooterAction,
  type SettlePeopleModel,
  type SettleViewInput,
} from '../lib/settleView';
import type { SplitInput } from '../lib/split';
import type { Outside, Pair, Payment } from '../lib/transfers';

/** billMarker's summary facts (Pick<BillSummary, …>, spelled out so the fixture is plain JSON). */
export type LegacyMarkerFacts = {
  hostId: string;
  payerId: string;
  added: boolean;
  seen: boolean;
  claimedAny: boolean;
  complete: boolean;
  seenAt: string | null;
};

/** The device and screen facts settleViewInputFor would add, as plain data (no functions). */
export type LegacyViewFacts = {
  billId: string;
  viewerId: string;
  hostId: string;
  /** displayName per participant (null = unset), for makeNameOf. */
  names: Record<string, string | null>;
  /** venmoUsername per participant (null, valid, or an invalid string the screens must ignore). */
  venmo: Record<string, string | null>;
  /** claimedItemNames per participant, as the screen would compute them. */
  itemNames: Record<string, string[]>;
  platform: 'ios' | 'android' | 'web';
  mobileWeb: boolean;
  openedVenmo: OpenedVenmo | null;
  rememberedMethod: PaymentMethod | null;
  sentCheck: SentCheckContext | null;
  permissionUndetermined: boolean;
};

/** One seeded single-payer bill, seen by one viewer. Every participant has a key in marks and notReceived. */
export type LegacyCaseInput = {
  split: SplitInput;
  payerId: string;
  /** The generator never gives the payer a mark. A mark's toUserId is the payer (marks store no payer, §11). */
  marks: Record<string, SettleMark | null>;
  /** A flag's toUserId may name someone other than today's payer (a flag from an earlier payer). */
  notReceived: Record<string, SettleNotReceived | null>;
  view: LegacyViewFacts;
  summary: LegacyMarkerFacts;
};

/** Today's results for one case. */
export type LegacyCaseOutput = {
  plan: SettlePlanWithEarly;
  card: SettleCardModel;
  people: SettlePeopleModel | null;
  footer: SettleFooterAction | null;
  marker: HomeMarker | null;
};

export type LegacyCase = { id: number; input: LegacyCaseInput; output: LegacyCaseOutput };

export type FixtureCoverage = {
  blocked: number;
  blocked_all_zero: number;
  early: number;
  payer_owes_them: number;
  'difference.more': number;
  'difference.back': number;
  within_tolerance: number;
  flag_present: number;
};

export type SettleFixtureHeader = {
  description: string;
  /** `git rev-parse HEAD` when captured. */
  gitHead: string;
  /** What the baseline was: the commit, or the uncommitted working tree on top of it. */
  baseline: string;
  capturedAt: string;
  seed: number;
  generator: string;
  caseCount: number;
  /** sha256 of each baseline file's bytes when the fixture was captured. */
  baselineFiles: Record<string, string>;
  /** sha256 of the modules the baseline files import (context only). */
  dependencyFiles: Record<string, string>;
  coverage: FixtureCoverage;
  /** Informational distributions (plan status, card state, footer kind, marker). */
  distribution: Record<string, Record<string, number>>;
};

export type SettleFixture = { header: SettleFixtureHeader; cases: LegacyCase[] };

/** The SettleViewInput today's settleViewInputFor builds, from the case's plain facts and the plan. */
export function legacyViewInput(input: LegacyCaseInput, plan: SettlePlanWithEarly): SettleViewInput {
  const { view, split, payerId } = input;
  const participants = split.participantIds.map((userId) => ({ userId, displayName: view.names[userId] ?? null }));
  const venmoOf = (userId: string) => view.venmo[userId] ?? null;
  return {
    plan,
    nameOf: makeNameOf(participants, view.viewerId),
    viewerId: view.viewerId,
    hostId: view.hostId,
    payerId,
    extrasMode: split.extrasMode,
    payerVenmo: venmoOf(payerId),
    viewerMarked: Boolean(input.marks[view.viewerId]),
    openedVenmo: view.openedVenmo,
    platform: view.platform,
    mobileWeb: view.mobileWeb,
    viewerItemNames: view.itemNames[view.viewerId] ?? [],
    venmoOf,
    itemNamesOf: (userId) => view.itemNames[userId] ?? [],
    billId: view.billId,
    rememberedMethod: view.rememberedMethod,
    sentCheck: view.sentCheck,
    permissionUndetermined: view.permissionUndetermined,
  };
}

/** Today's five results for one case (settlePlan with allowEarly, as the app calls it). */
export function settleOutputsFor(input: LegacyCaseInput): LegacyCaseOutput {
  const plan = settlePlan(input.split, input.payerId, input.marks, { allowEarly: true, notReceived: input.notReceived });
  const viewInput = legacyViewInput(input, plan);
  return {
    plan,
    card: settleCard(viewInput),
    people: settlePeople(viewInput),
    footer: settleFooterAction(viewInput, input.split.participantIds.length),
    marker: billMarker(input.summary, input.view.viewerId, plan),
  };
}

const byPair = (x: { fromId: string; toId: string }, y: { fromId: string; toId: string }): number =>
  x.fromId < y.fromId ? -1 : x.fromId > y.fromId ? 1 : x.toId < y.toId ? -1 : x.toId > y.toId ? 1 : 0;

/**
 * S1's adapter: today's single-payer plan as contract T's shape (A1.2 step 6). One pair per marked or
 * owing non-payer, `fromId` → payer, with target = max(owed, 0), paid = the mark's cents, the mark and
 * contract D's difference; each negative share is an outside route payer → them. Pairs with target 0
 * and nothing paid are dropped. Ordered by fromId, then toId (A1.2 output order).
 */
export function legacyMarksToPairs(plan: SettleReady | SettleEarly): { pairs: Pair[]; outside: Outside[] } {
  const payerId = plan.payerId;
  const pairs: Pair[] = [];
  const outside: Outside[] = [];
  for (const p of plan.people) {
    if (p.role === 'payer') continue;
    const target = Math.max(p.owedCents, 0);
    const paid = p.mark?.cents ?? 0;
    if (p.role === 'payer_owes_them') outside.push({ fromId: payerId, toId: p.userId, cents: -p.owedCents });
    if (target === 0 && paid === 0) continue;
    pairs.push({
      fromId: p.userId,
      toId: payerId,
      targetCents: target,
      paidCents: paid,
      remainingCents: target - paid,
      mark: p.mark ? { cents: p.mark.cents, at: p.mark.at, method: p.mark.method } : null,
      difference: p.mark ? (p.difference ?? null) : null,
    });
  }
  return { pairs: pairs.sort(byPair), outside: outside.sort(byPair) };
}

/**
 * Today's marks as ledger entries (A1.3 `bill_payments`, the 4a-1 data copy): one entry per mark,
 * from the marked person to the mark's toUserId, with the mark's cents, method and time. Ordered by
 * userId; ids are fixed lowercase uuids so the (at, id) tie-break is deterministic. `planKey` null
 * (default) makes them earlier-key history; the current key makes them today's-route payments. Either
 * gives the same single-payer result (A1.2 "partition independence").
 */
export function legacyMarksToPayments(
  marks: Readonly<Record<string, SettleMark | null | undefined>>,
  opts: { planKey?: string | null } = {},
): Payment[] {
  const ids = Object.keys(marks).sort();
  const out: Payment[] = [];
  ids.forEach((userId) => {
    const mark = marks[userId];
    if (!mark) return;
    out.push({
      id: `00000000-0000-4000-8000-${String(out.length + 1).padStart(12, '0')}`,
      fromId: userId,
      toId: mark.toUserId,
      cents: mark.cents,
      method: mark.method,
      planKey: opts.planKey ?? null,
      at: mark.at,
    });
  });
  return out;
}

/**
 * A case as ledgerSettlePlan's input (Task 6): one person (no bill_payers rows), the marks as
 * earlier-key payments (legacyMarksToPayments), and each flag as a bill_payment_flags row from the
 * flagged person to the flag's toUserId (which may be an earlier payer).
 */
export function legacyLedgerOf(input: LegacyCaseInput, opts: { planKey?: string | null } = {}): SettleLedger {
  const flags = Object.keys(input.notReceived)
    .sort()
    .flatMap((fromId) => {
      const f = input.notReceived[fromId];
      return f ? [{ fromId, toId: f.toUserId, cents: f.cents, method: f.method }] : [];
    });
  return { payerId: input.payerId, payers: [], payments: legacyMarksToPayments(input.marks, opts), flags };
}

/** S1's counts: cases whose plan has at least one of each. */
export function caseCoverage(output: LegacyCaseOutput): Record<keyof FixtureCoverage, boolean> {
  const { plan } = output;
  const has: Record<keyof FixtureCoverage, boolean> = {
    blocked: plan.status === 'blocked',
    blocked_all_zero: plan.status === 'blocked_all_zero',
    early: plan.status === 'early',
    payer_owes_them: false,
    'difference.more': false,
    'difference.back': false,
    within_tolerance: false,
    flag_present: false,
  };
  if (plan.status !== 'ready' && plan.status !== 'early') return has;
  for (const e of plan.people) {
    if (e.notReceived !== null) has.flag_present = true;
    if (e.role === 'payer') continue;
    if (e.role === 'payer_owes_them') has.payer_owes_them = true;
    const diff = e.difference ?? null;
    if (diff?.kind === 'more') has['difference.more'] = true;
    if (diff?.kind === 'back') has['difference.back'] = true;
    // Within tolerance: marked, the mark isn't the target, and contract D shows no difference.
    if (e.mark !== null && diff === null && Math.max(e.owedCents, 0) !== e.mark.cents) has.within_tolerance = true;
  }
  return has;
}

export function fixtureCoverage(outputs: readonly LegacyCaseOutput[]): FixtureCoverage {
  const counts: FixtureCoverage = {
    blocked: 0,
    blocked_all_zero: 0,
    early: 0,
    payer_owes_them: 0,
    'difference.more': 0,
    'difference.back': 0,
    within_tolerance: 0,
    flag_present: 0,
  };
  for (const o of outputs) {
    const has = caseCoverage(o);
    for (const k of Object.keys(counts) as (keyof FixtureCoverage)[]) if (has[k]) counts[k] += 1;
  }
  return counts;
}

/** Plan status, card state, footer kind and marker counts (for the header and the report). */
export function fixtureDistribution(outputs: readonly LegacyCaseOutput[]): Record<string, Record<string, number>> {
  const dist: Record<string, Record<string, number>> = { planStatus: {}, cardState: {}, footerKind: {}, marker: {}, peopleRows: {} };
  const bump = (group: string, key: string) => {
    const g = dist[group] ?? (dist[group] = {});
    g[key] = (g[key] ?? 0) + 1;
  };
  for (const o of outputs) {
    bump('planStatus', o.plan.status);
    bump('cardState', o.card.state);
    bump('footerKind', o.footer === null ? 'null' : o.footer.kind === 'settle' && o.footer.early ? `settle.early.${o.footer.early}` : o.footer.kind);
    bump('marker', o.marker ?? 'null');
    bump('peopleRows', o.people === null ? 'null' : String(o.people.rows.length));
  }
  return dist;
}
