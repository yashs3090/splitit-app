// Suggested payments for a group (spec docs/specs/2026-11-26-groups-mvp.md § C-G3). Pure, integer cents.
//
// Greedy: repeatedly the largest creditor is paid by the largest debtor, ties to the lower user id
// (code-unit order, as in lib/split.ts). Each step settles at least one person, so a group with k
// non-zero nets needs at most k − 1 payments, and the full list settles every net to exactly 0.
// It is not the fewest possible payments (that is NP-hard; plan v2), and it can route money between
// people who never shared a cost. See docs/learning/concepts/group-balances.md (T19).

/**
 * The settled-up threshold (GR-3, GR-S2, Money: needs your look). A payment is hidden from the
 * suggestions only when it is this many cents or fewer **and** both people's |net| are within it
 * (C-G3 step 3, Amendment A1 S2), so after the shown payments everyone's leftover is ≤ this value.
 */
export const GROUP_IGNORE_CENTS = 1;

/** C-G3 step 5: the one "settled up" predicate (status line, Settle screen, criteria). */
export function isSettledUp(netCents: number): boolean {
  return Number.isSafeInteger(netCents) && Math.abs(netCents) <= GROUP_IGNORE_CENTS;
}

export type Transfer = { from: string; to: string; cents: number };
export type Simplified = {
  /** Every payment, in the order they were chosen; settles every net to exactly 0. */
  full: Transfer[];
  /** `full` without the payments of ≤ GROUP_IGNORE_CENTS between two settled-up people, same order. */
  shown: Transfer[];
};

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * nets: user id → net cents (positive = owed money, negative = owes). Must be safe integers that sum
 * to exactly 0, else RangeError. The input is not changed; its key order never affects the result.
 */
export function simplify(nets: Readonly<Record<string, number>>): Simplified {
  const ids = Object.keys(nets).sort(byCodeUnit);
  const left = new Map<string, number>();
  let total = 0;
  for (const id of ids) {
    const v = nets[id];
    if (v === undefined || !Number.isSafeInteger(v)) throw new RangeError('simplify: nets must be safe integers');
    total += v;
    if (!Number.isSafeInteger(total)) throw new RangeError('simplify: sum of nets is out of range');
    if (v !== 0) left.set(id, v);
  }
  if (total !== 0) throw new RangeError('simplify: nets must sum to 0');

  const full: Transfer[] = [];
  for (;;) {
    // Scanning ids in code-unit order with strict comparisons gives ties to the lower id.
    let creditor: string | null = null;
    let debtor: string | null = null;
    let most = 0;
    let least = 0;
    for (const [id, v] of left) {
      if (v > most) {
        most = v;
        creditor = id;
      }
      if (v < least) {
        least = v;
        debtor = id;
      }
    }
    if (creditor === null || debtor === null) break;
    const cents = Math.min(most, -least);
    full.push({ from: debtor, to: creditor, cents });
    settle(left, creditor, most - cents);
    settle(left, debtor, least + cents);
  }
  // A person is on one side only (greedy never makes a creditor pay), so the hidden payments
  // touching a settled-up person add up to at most their |net| ≤ the threshold.
  const settled = (id: string) => isSettledUp(nets[id] ?? 0);
  const hidden = (p: Transfer) => p.cents <= GROUP_IGNORE_CENTS && settled(p.from) && settled(p.to);
  return { full, shown: full.filter((p) => !hidden(p)) };
}

function settle(left: Map<string, number>, id: string, value: number): void {
  if (value === 0) left.delete(id);
  else left.set(id, value);
}
