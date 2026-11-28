// Seeded generator for the single-payer regression fixture (lib/__fixtures__/settle-single-payer.json;
// docs/specs/2026-11-26-who-paid.md A1.7 Task 6.0, eng review S1). It made the committed inputs; the
// regression test reads those inputs, never this generator, so later edits here can't move the baseline.
//
// Shapes: 1–6 people, item rows (some $0), claimable discounts (some big enough to make a share
// negative), both extras modes, complete and incomplete bills, all-$0 bills, marks exact / within 1¢ /
// more / back / on a $0 or negative share, "Not received" flags (some naming an earlier payer), and
// the device facts (platform, opened Venmo, the inline sent check, remembered method). The payer never
// has a mark.
import type { PaymentMethod } from '../lib/paymentMethods';
import { sentCheckKey, type SentCheckAnswer } from '../lib/sentCheck';
import type { SettleMark, SettleNotReceived } from '../lib/settle';
import { computeShares, sharesComplete, type SplitClaim, type SplitInput, type SplitItem } from '../lib/split';
import type { LegacyCaseInput, LegacyViewFacts } from './legacyMarks';

/** mulberry32: small, seeded, deterministic. */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const chance = (r: Rng, p: number): boolean => r() < p;
function pick<T>(r: Rng, xs: readonly T[]): T {
  const x = xs[Math.floor(r() * xs.length)];
  if (x === undefined) throw new Error('pick: empty list');
  return x;
}
function weighted<T>(r: Rng, xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let roll = r() * total;
  for (const [x, w] of xs) {
    roll -= w;
    if (roll < 0) return x;
  }
  const last = xs[xs.length - 1];
  if (last === undefined) throw new Error('weighted: empty list');
  return last[0];
}

/** A lowercase v4-shaped uuid (the screens' keys check the format). */
function uuid(r: Rng): string {
  const hex = (n: number) => Array.from({ length: n }, () => int(r, 0, 15).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(r, ['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`;
}

const NAMES: readonly (string | null)[] = ['Sam', 'Hana', 'Priya', 'Jo', 'Ana María', 'Li', 'Bartholomew-Alexander', '', '  ', null];
const ITEM_NAMES = ['Tacos', 'Burger', 'Fries', 'Pad thai', 'Coke', 'Ramen', 'Salad', 'Beer', 'Dumplings', 'Café au lait'];
const METHODS: readonly PaymentMethod[] = ['venmo', 'cash', 'other'];
const BASE_MS = Date.UTC(2026, 10, 27, 12, 0, 0);

/** A timestamptz as the API sends it, with microseconds. */
function stamp(ms: number, micros: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-27T12:00:00.000Z
  return `${iso.slice(0, 19)}.${String(micros).padStart(6, '0')}+00:00`;
}

type Shape = 'complete' | 'incomplete_equal' | 'incomplete_prop' | 'all_zero' | 'negative';

function buildSplit(r: Rng, ids: string[], shape: Shape): { split: SplitInput; names: Map<string, string> } {
  const extrasMode =
    shape === 'incomplete_equal' ? 'equal' : shape === 'incomplete_prop' || shape === 'all_zero' ? 'proportional' : chance(r, 0.6) ? 'proportional' : 'equal';
  const items: SplitItem[] = [];
  const names = new Map<string, string>();
  const nItems = int(r, 1, 6);
  for (let i = 0; i < nItems; i++) {
    const id = `row-${i}`;
    const cents = shape === 'all_zero' || chance(r, 0.08) ? 0 : int(r, 1, 4000);
    items.push({ id, totalCents: cents, kind: 'item' });
    names.set(id, pick(r, ITEM_NAMES));
  }
  const nDiscounts = shape === 'all_zero' ? 0 : shape === 'negative' ? int(r, 1, 2) : chance(r, 0.25) ? int(r, 1, 2) : 0;
  for (let i = 0; i < nDiscounts; i++) {
    const id = `disc-${i}`;
    const big = shape === 'negative' && i === 0;
    items.push({ id, totalCents: -(big ? int(r, 3000, 9000) : int(r, 1, 1500)), kind: 'discount' });
    names.set(id, 'Discount');
  }

  const claims: SplitClaim[] = [];
  const incomplete = shape === 'incomplete_equal' || shape === 'incomplete_prop' || (shape !== 'all_zero' && chance(r, 0.05));
  const forcedUnclaimed = incomplete ? pick(r, items).id : null;
  for (const item of items) {
    const big = item.kind === 'discount' && shape === 'negative' && item.id === 'disc-0';
    if (item.id === forcedUnclaimed) continue;
    if (incomplete && chance(r, 0.3)) continue;
    const k = big ? 1 : int(r, 1, Math.min(ids.length, 3));
    const pool = [...ids];
    for (let j = 0; j < k; j++) {
      const who = pool.splice(int(r, 0, pool.length - 1), 1)[0];
      if (who === undefined) break;
      claims.push({ itemId: item.id, userId: who, parts: chance(r, 0.8) ? 1 : int(r, 2, 3) });
    }
  }

  const rowSum = items.reduce((s, i) => s + i.totalCents, 0);
  let extras = shape === 'all_zero' ? int(r, 100, 2500) : chance(r, 0.2) ? 0 : int(r, -300, 1500);
  if (rowSum + extras < 0) extras = -rowSum; // a total is never negative
  return { split: { totalCents: rowSum + extras, items, claims, participantIds: ids, extrasMode }, names };
}

function markCents(r: Rng, owed: number): number {
  const target = Math.max(owed, 0);
  const kind = weighted(r, [
    ['exact', 35],
    ['tolerance', 20],
    ['more', 18],
    ['back', 22],
    ['random', 5],
  ] as const);
  let cents: number;
  switch (kind) {
    case 'exact':
      cents = target;
      break;
    case 'tolerance':
      cents = target + pick(r, [-1, 1]);
      break;
    case 'more':
      cents = target - int(r, 2, 600);
      break;
    case 'back':
      cents = target + int(r, 2, 900);
      break;
    default: // 'random'
      cents = int(r, 1, 6000);
  }
  return Math.max(cents, 1); // a mark is never $0 (lesson 2026-11-25)
}

/** One case's inputs. */
export function generateCase(r: Rng): LegacyCaseInput {
  const n = weighted(r, [
    [1, 4],
    [2, 24],
    [3, 26],
    [4, 20],
    [5, 15],
    [6, 11],
  ] as const);
  const ids = Array.from({ length: n }, () => uuid(r));
  const shape = weighted<Shape>(r, [
    ['complete', 52],
    ['incomplete_equal', 11],
    ['incomplete_prop', 17],
    ['all_zero', 6],
    ['negative', 14],
  ]);
  const { split, names: rowNames } = buildSplit(r, ids, shape);
  const payerId = pick(r, ids);
  const hostId = chance(r, 0.6) ? payerId : pick(r, ids);
  const shares = computeShares(split);
  const owedOf = new Map(shares.people.map((p) => [p.userId, p.totalCents]));

  const marks: Record<string, SettleMark | null> = {};
  const notReceived: Record<string, SettleNotReceived | null> = {};
  let clock = BASE_MS + int(r, 0, 3 * 3600) * 1000;
  for (const id of ids) {
    marks[id] = null;
    notReceived[id] = null;
    if (id === payerId) continue; // the generator never gives the payer a mark
    if (chance(r, 0.5)) {
      clock += int(r, 1, 600) * 1000;
      marks[id] = { cents: markCents(r, owedOf.get(id) ?? 0), at: stamp(clock, int(r, 0, 999_999)), method: pick(r, METHODS), toUserId: payerId };
    }
    if (chance(r, 0.15)) {
      const others = ids.filter((x) => x !== id && x !== payerId);
      const to = others.length > 0 && chance(r, 0.25) ? pick(r, others) : payerId; // some flags name an earlier payer
      notReceived[id] = { cents: int(r, 1, 5000), method: pick(r, METHODS), toUserId: to };
    }
  }

  const viewerId = chance(r, 0.35) ? payerId : pick(r, ids);
  const itemNames: Record<string, string[]> = {};
  for (const id of ids) {
    const mine = new Set(split.claims.filter((c) => c.userId === id && c.parts >= 1).map((c) => c.itemId));
    itemNames[id] = split.items.filter((i) => i.kind !== 'discount' && mine.has(i.id)).map((i) => rowNames.get(i.id) ?? '');
  }
  const billId = uuid(r);
  const viewerMark = marks[viewerId] ?? null;
  const viewerOwed = owedOf.get(viewerId) ?? 0;

  let openedVenmo: LegacyViewFacts['openedVenmo'] = null;
  if (viewerId !== payerId && chance(r, 0.3)) {
    const to = chance(r, 0.9) ? payerId : pick(r, ids);
    if (viewerMark !== null && chance(r, 0.5)) {
      const target = Math.max(viewerOwed, 0);
      const more = target - viewerMark.cents;
      openedVenmo = { kind: 'more', payerId: to, cents: more > 0 && chance(r, 0.8) ? more : int(r, 1, 500), fromCents: viewerMark.cents };
    } else {
      openedVenmo = { payerId: to, cents: viewerOwed > 0 && chance(r, 0.8) ? viewerOwed : int(r, 1, 3000) };
      if (chance(r, 0.3)) openedVenmo = { kind: 'share', ...openedVenmo };
    }
  }

  let sentCheck: LegacyViewFacts['sentCheck'] = null;
  if (chance(r, 0.55)) {
    const markAt = viewerMark === null ? clock : Date.parse(viewerMark.at);
    const now = markAt + int(r, -60, 40 * 60) * 1000;
    const answers: Record<string, { a: SentCheckAnswer; t: number }> = {};
    const key = sentCheckKey(billId, payerId, markAt);
    if (key !== null && chance(r, 0.3)) answers[key] = { a: pick(r, ['yes', 'undo', 'shown'] as const), t: now - 1000 };
    const lastSend = weighted(r, [
      [null, 70],
      ['share', 15],
      ['more', 15],
    ] as const);
    sentCheck = lastSend === null ? { answers, now } : { answers, now, lastSend };
  }

  const names: Record<string, string | null> = {};
  const venmo: Record<string, string | null> = {};
  for (const id of ids) {
    names[id] = pick(r, NAMES);
    venmo[id] = weighted(r, [
      [`user_${uuid(r).slice(0, int(r, 4, 8))}`, 60],
      [null, 30],
      ['ab', 10], // invalid: no Venmo offered
    ] as const);
  }
  const platform = weighted(r, [
    ['ios', 40],
    ['android', 25],
    ['web', 35],
  ] as const);

  const seenRoll = weighted(r, [
    ['never', 30],
    ['dismissed', 15],
    ['opened', 55],
  ] as const);
  const summary = {
    hostId,
    payerId,
    added: chance(r, 0.3),
    seen: seenRoll !== 'never',
    claimedAny: split.claims.some((c) => c.userId === viewerId && c.parts >= 1),
    complete: sharesComplete(split).complete,
    seenAt: seenRoll === 'opened' ? stamp(BASE_MS + int(r, 0, 4 * 3600) * 1000, int(r, 0, 999_999)) : null,
  };

  return {
    split,
    payerId,
    marks,
    notReceived,
    view: {
      billId,
      viewerId,
      hostId,
      names,
      venmo,
      itemNames,
      platform,
      mobileWeb: platform === 'web' && chance(r, 0.5),
      openedVenmo,
      rememberedMethod: weighted(r, [
        [null, 40],
        ['venmo', 25],
        ['cash', 25],
        ['other', 10],
      ] as const),
      sentCheck,
      permissionUndetermined: chance(r, 0.3),
    },
    summary,
  };
}
