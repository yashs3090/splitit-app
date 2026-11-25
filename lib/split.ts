// Split math: who owes what for one bill. Pure and integer-cents only (ADR 0005).
// See docs/learning/concepts/money-and-rounding.md and spec 2026-11-20-m1b-m2 § "lib/split.ts".
//
// Every amount is whole cents. Rounding is largest remainder, so pieces always add back up to the
// amount being split exactly; amount × weight is done in BigInt so it can't lose precision.
//
// Claimable discounts (spec 2026-11-24-claimable-discounts § C4, ADR 0017): a discount row is a
// negative row people claim like an item. It is split among its claimers like any row, but it is
// never a proportional weight (CD-7) and claiming only discounts doesn't count in equal mode (CD-8).
// Shares are not capped, so a person's total may be negative (CD-6).

export type RowKind = 'item' | 'discount';
/** One unit row. Absent kind = 'item' (totalCents integer ≥ 0); 'discount' needs an integer ≤ −1. */
export type SplitItem = { id: string; totalCents: number; kind?: RowKind };
export type SplitClaim = { itemId: string; userId: string; parts: number };
export type ExtrasMode = 'proportional' | 'equal';
export type SplitInput = {
  totalCents: number;
  items: SplitItem[];
  claims: SplitClaim[];
  participantIds: string[];
  extrasMode: ExtrasMode;
};
export type ItemSplit = {
  status: 'unclaimed' | 'claimed' | 'shared'; // 0 claimers / 1 / 2+
  custom: boolean; // 2+ claimers whose parts are not all equal
  byUser: Record<string, number>; // cents of this row per claimer
};
export type PersonShare = {
  userId: string;
  itemsCents: number; // item rows only
  discountCents: number; // ≤ 0: the person's pieces of discount rows
  extrasCents: number;
  totalCents: number; // itemsCents + discountCents + extrasCents (may be negative)
};
export type SplitResult = {
  people: PersonShare[]; // one per participantId, sorted by userId (code-unit order)
  unclaimedItemsCents: number;
  unclaimedDiscountCents: number; // ≤ 0: discount rows with no counted claim
  unclaimedExtrasCents: number;
  unclaimedCents: number; // unclaimedItemsCents + unclaimedDiscountCents + unclaimedExtrasCents
  extrasCents: number; // totalCents − Σ row totals, discount rows included (may be negative)
  items: Record<string, ItemSplit>;
};
export type DisplayShare = {
  userId: string;
  itemsCents: number;
  discountCents: number | null; // null = not shown yet (with the totals)
  extrasCents: number | null; // null = not shown yet
  totalCents: number | null;
};
export type DisplayShares = {
  mode: ExtrasMode;
  complete: boolean;
  unclaimedRows: number; // items and discount rows with no counted claim
  unclaimedDiscountRows: number; // of unclaimedRows, how many are discount rows (Amendment A1, R1)
  totalsVisible: boolean; // mode === 'proportional' || complete
  people: DisplayShare[]; // same order as SplitResult.people
  unclaimedItemsCents: number;
  unclaimedDiscountCents: number;
  unclaimedExtrasCents: number; // equal mode: 0 once anyone claimed (A1.7)
  items: Record<string, ItemSplit>; // same as SplitResult.items, so callers run the math once
};

const MAX_PARTS = 20;

/** BigInt → number. Callers only pass values ≤ a safe-integer amount, so this is exact. */
function toInt(b: bigint): number {
  return parseInt(b.toString(), 10);
}

/** Code-unit order (not locale order), so results are the same on every device. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Largest remainder, integer-only (BigInt for amount × weight). Ties go to the lower index.
 * Negative amount = −allocate(−amount). Throws RangeError for negative or non-integer weights,
 * a non-integer amount, or Σweights = 0 with amount ≠ 0.
 */
export function allocate(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount)) throw new RangeError('allocate: amount must be an integer');
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) throw new RangeError('allocate: weights must be integers ≥ 0');
  }
  if (amount < 0) return allocate(-amount, weights).map((p) => (p === 0 ? 0 : -p)); // no -0
  const total = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (total === 0n) {
    if (amount !== 0) throw new RangeError('allocate: weights sum to 0 but amount is not 0');
    return weights.map(() => 0);
  }
  const a = BigInt(amount);
  const floors = weights.map((w) => (a * BigInt(w)) / total);
  const rems = weights.map((w) => (a * BigInt(w)) % total);
  let left = toInt(a - floors.reduce((s, q) => s + q, 0n)); // < weights.length, so exact
  // Hand the leftover cents to the largest remainders; ties go to the lower index.
  const order = weights.map((_, i) => i).sort((i, j) => {
    const ri = rems[i] ?? 0n;
    const rj = rems[j] ?? 0n;
    return ri > rj ? -1 : ri < rj ? 1 : i - j;
  });
  const out = floors.map(toInt);
  for (const i of order) {
    if (left === 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}

type Normalized = {
  participants: string[]; // sorted, unique
  rows: Map<string, number>; // item id → cents
  kinds: Map<string, RowKind>; // item id → kind
  claimsByRow: Map<string, Map<string, number>>; // item id → (userId → clamped parts)
};

/** Applies the input rules: drops claims we can't count, clamps parts, and makes order irrelevant. */
function normalize(input: SplitInput): Normalized {
  if (!Number.isSafeInteger(input.totalCents)) throw new RangeError('computeShares: totalCents must be an integer');
  const participants = [...new Set(input.participantIds)].sort(byCodeUnit);
  const isParticipant = new Set(participants);

  const rows = new Map<string, number>();
  const kinds = new Map<string, RowKind>();
  for (const item of input.items) {
    const kind: unknown = item.kind ?? 'item';
    if (kind === 'item') {
      if (!Number.isSafeInteger(item.totalCents) || item.totalCents < 0) {
        throw new RangeError('computeShares: item totalCents must be an integer ≥ 0');
      }
    } else if (kind === 'discount') {
      if (!Number.isSafeInteger(item.totalCents) || item.totalCents > -1) {
        throw new RangeError('computeShares: discount totalCents must be an integer ≤ −1');
      }
    } else {
      throw new RangeError('computeShares: kind must be "item" or "discount"');
    }
    // Ids are unique in the DB; if one repeats anyway, its rows count as one (sum is order-free).
    // A repeat with the other kind has no sensible meaning, so it is refused (in any order).
    const seen = kinds.get(item.id);
    if (seen !== undefined && seen !== kind) throw new RangeError('computeShares: one id with two kinds');
    kinds.set(item.id, kind);
    rows.set(item.id, (rows.get(item.id) ?? 0) + item.totalCents);
  }

  const claimsByRow = new Map<string, Map<string, number>>();
  for (const claim of input.claims) {
    // Non-integer parts can't come from the DB (integer column); skip them like parts ≤ 0.
    if (!Number.isSafeInteger(claim.parts) || claim.parts <= 0) continue;
    if (!rows.has(claim.itemId) || !isParticipant.has(claim.userId)) continue;
    const parts = Math.min(claim.parts, MAX_PARTS);
    let byUser = claimsByRow.get(claim.itemId);
    if (!byUser) {
      byUser = new Map();
      claimsByRow.set(claim.itemId, byUser);
    }
    // The primary key prevents duplicates; if one appears, the larger parts wins (order-free).
    byUser.set(claim.userId, Math.max(parts, byUser.get(claim.userId) ?? 0));
  }
  return { participants, rows, kinds, claimsByRow };
}

export function computeShares(input: SplitInput): SplitResult {
  const { participants, rows, kinds, claimsByRow } = normalize(input);
  const itemsCents = new Map<string, number>(participants.map((u) => [u, 0]));
  const discountCents = new Map<string, number>(participants.map((u) => [u, 0]));
  const items: Record<string, ItemSplit> = {};
  let unclaimedItemsCents = 0;
  let unclaimedDiscountCents = 0;
  let rowsSum = 0;

  for (const [id, cents] of rows) {
    rowsSum += cents;
    const isDiscount = kinds.get(id) === 'discount';
    const claimers = [...(claimsByRow.get(id) ?? new Map<string, number>())].sort(([a], [b]) => byCodeUnit(a, b));
    if (claimers.length === 0) {
      if (isDiscount) unclaimedDiscountCents += cents;
      else unclaimedItemsCents += cents;
      items[id] = { status: 'unclaimed', custom: false, byUser: {} };
      continue;
    }
    // A negative (discount) row goes through allocate's −allocate(−amount) path.
    const pieces = allocate(cents, claimers.map(([, parts]) => parts));
    const byUser: Record<string, number> = {};
    const bucket = isDiscount ? discountCents : itemsCents;
    claimers.forEach(([userId], i) => {
      const piece = pieces[i] ?? 0;
      byUser[userId] = piece;
      bucket.set(userId, (bucket.get(userId) ?? 0) + piece);
    });
    const firstParts = claimers[0]?.[1];
    items[id] = {
      status: claimers.length === 1 ? 'claimed' : 'shared',
      custom: claimers.length > 1 && claimers.some(([, parts]) => parts !== firstParts),
      byUser,
    };
  }

  const extrasCents = input.totalCents - rowsSum;
  const personItems = participants.map((u) => itemsCents.get(u) ?? 0); // proportional weights (CD-7)
  const personDiscounts = participants.map((u) => discountCents.get(u) ?? 0);
  let personExtras: number[];
  let unclaimedExtrasCents: number;

  if (input.extrasMode === 'equal') {
    // Equal among participants with at least one counted claim on an item row (a $0 item counts;
    // a claim on a discount row alone doesn't, CD-8).
    const hasClaim = new Set<string>();
    for (const [id, byUser] of claimsByRow) {
      if (kinds.get(id) === 'discount') continue;
      for (const u of byUser.keys()) hasClaim.add(u);
    }
    const claimers = participants.filter((u) => hasClaim.has(u));
    if (claimers.length === 0) {
      personExtras = participants.map(() => 0);
      unclaimedExtrasCents = extrasCents;
    } else {
      const shares = allocate(extrasCents, claimers.map(() => 1));
      const shareOf = new Map(claimers.map((u, i) => [u, shares[i] ?? 0]));
      personExtras = participants.map((u) => shareOf.get(u) ?? 0);
      unclaimedExtrasCents = 0; // the Unclaimed line carries no extras under 'equal'
    }
  } else {
    const weights = [...personItems, unclaimedItemsCents];
    if (weights.every((w) => w === 0)) {
      personExtras = participants.map(() => 0);
      unclaimedExtrasCents = extrasCents;
    } else {
      const shares = allocate(extrasCents, weights);
      personExtras = shares.slice(0, participants.length);
      unclaimedExtrasCents = shares[participants.length] ?? 0;
    }
  }

  const people: PersonShare[] = participants.map((userId, i) => {
    const own = personItems[i] ?? 0;
    const off = personDiscounts[i] ?? 0;
    const extra = personExtras[i] ?? 0;
    return { userId, itemsCents: own, discountCents: off, extrasCents: extra, totalCents: own + off + extra };
  });
  return {
    people,
    unclaimedItemsCents,
    unclaimedDiscountCents,
    unclaimedExtrasCents,
    unclaimedCents: unclaimedItemsCents + unclaimedDiscountCents + unclaimedExtrasCents,
    extrasCents,
    items,
  };
}

/** A2.2 / C3: true iff every row (item or discount) has at least one counted claim. */
export function sharesComplete(input: SplitInput): { complete: boolean; unclaimedRows: number; unclaimedDiscountRows: number } {
  const { rows, kinds, claimsByRow } = normalize(input);
  let unclaimedRows = 0;
  let unclaimedDiscountRows = 0;
  for (const id of rows.keys()) {
    if (claimsByRow.has(id)) continue;
    unclaimedRows++;
    if (kinds.get(id) === 'discount') unclaimedDiscountRows++;
  }
  return { complete: unclaimedRows === 0, unclaimedRows, unclaimedDiscountRows };
}

/** What the screen may show. Under 'equal' and incomplete, extras and totals are null for everyone. */
export function displayShares(input: SplitInput): DisplayShares {
  const res = computeShares(input);
  // Same rule as sharesComplete (a row with no counted claim), read off the result so the
  // input is normalized only once.
  const unclaimedIds = Object.keys(res.items).filter((id) => res.items[id]?.status === 'unclaimed');
  const discountIds = new Set(input.items.filter((i) => i.kind === 'discount').map((i) => i.id));
  const unclaimedRows = unclaimedIds.length;
  const unclaimedDiscountRows = unclaimedIds.filter((id) => discountIds.has(id)).length;
  const complete = unclaimedRows === 0;
  const totalsVisible = input.extrasMode === 'proportional' || complete;
  return {
    mode: input.extrasMode,
    complete,
    unclaimedRows,
    unclaimedDiscountRows,
    totalsVisible,
    people: res.people.map((p) =>
      totalsVisible
        ? { ...p }
        : { userId: p.userId, itemsCents: p.itemsCents, discountCents: null, extrasCents: null, totalCents: null },
    ),
    unclaimedItemsCents: res.unclaimedItemsCents,
    unclaimedDiscountCents: res.unclaimedDiscountCents,
    unclaimedExtrasCents: res.unclaimedExtrasCents,
    items: res.items,
  };
}
