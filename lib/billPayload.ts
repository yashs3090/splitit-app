// Bill form draft <-> create_bill / update_bill arguments.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 7, design decision 4, A1.3, A2.4).
//
// Items with qty > 1 are stored as one line_items row per unit. A form row "Beer, qty 3, $10.00"
// becomes three rows of 334, 333 and 333 cents (largest remainder, equal weights: the first units
// get the extra cent), each carrying its group reference (group_position, unit_index, group_size).
// draftFromSaved does the reverse for the host's edit form. All money is integer cents.
//
// Claimable discounts (docs/specs/2026-11-24-claimable-discounts.md, C1, C5): a discount the host
// marks "Claim like an item" is one more row (kind 'discount', negative total_cents, after every
// item group), not part of p_subtotal_discount_cents / p_total_discount_cents. Item rows are sent
// without kind or applies_to, exactly as before.
import type { BillDraft, DraftDiscount, DraftEvaluation, DraftItem } from './billDraft';
import { formatCentsInput } from './money';
import { allocate, type RowKind } from './split';
import type { ParsedItem } from './receiptTypes';

/** What a `line_items` row is (C1). Absent means 'item'. Defined once, in lib/split.ts (review R4). */
export type { RowKind } from './split';
/** Where a discount row counts in the totals check: before or after the subtotal line (C2). */
export type DiscountAppliesTo = 'subtotal' | 'total';

export type BillRowArg = {
  id?: string;
  name: string;
  note: string | null;
  group_position: number;
  unit_index: number;
  group_size: number;
  /** Discount rows are negative (−9999999…−1). */
  total_cents: number;
  /** Only on discount rows ('discount'); item rows leave it out. */
  kind?: RowKind;
  /** Only on discount rows. */
  applies_to?: DiscountAppliesTo;
};

export type BillMoneyArgs = {
  p_subtotal_cents: number | null;
  p_tax_cents: number;
  p_fees_cents: number;
  p_tip_cents: number;
  /** Σ discounts applied before the subtotal line. */
  p_subtotal_discount_cents: number;
  /** Σ discounts applied after the subtotal line. */
  p_total_discount_cents: number;
  p_total_cents: number;
};

export type SaveBlock = 'has_errors' | 'no_items' | 'mismatch' | 'negative_total' | 'too_many_units';

export type SavedGroups = {
  /** Draft row id → saved line_items ids, in unit_index order. */
  units: Record<string, string[]>;
  /** Saved row ids that have at least one claim. */
  claimedIds: ReadonlySet<string>;
};

/** The `bills` columns draftFromSaved reads (a fetched row may carry more). */
export type SavedBill = {
  subtotal_cents: number | null;
  tax_cents: number;
  fees_cents: number;
  tip_cents: number;
  subtotal_discount_cents: number;
  total_discount_cents: number;
  total_cents: number;
};

/** One saved `line_items` row (one unit). */
export type SavedRow = {
  id: string;
  name: string;
  note: string | null;
  group_position: number;
  unit_index: number;
  group_size: number;
  total_cents: number;
  /** fetchBill always sets it; absent (hand-built rows) means 'item'. */
  kind?: RowKind;
  /** 'subtotal' | 'total' on discount rows, null on items; absent means null. */
  applies_to?: DiscountAppliesTo | null;
};

/** The `claims` columns draftFromSaved reads. */
export type SavedClaim = { line_item_id: string; user_id: string; parts: number };

export type BillArgsResult =
  | {
      ok: true;
      rows: BillRowArg[];
      money: BillMoneyArgs;
      /** Claimed unit ids dropped because the host lowered a quantity (confirm before saving). */
      droppedClaimedIds: string[];
      /**
       * Claimed unit ids of saved rows whose fields were all cleared: evaluateDraft skips a blank
       * row, so saving deletes it like a removed row (confirm before saving). Rows removed with
       * the delete action are not listed; the screen confirms those when they are deleted.
       */
      removedClaimedIds: string[];
      /**
       * Claimed ids of saved claimable discounts the host switched to Split: the row is deleted
       * (its claims go) and its amount moves into the bill's discount sum (confirm before saving).
       */
      splitClaimedIds: string[];
    }
  | { ok: false; reason: SaveBlock };

/** The database accepts at most this many rows per bill, discount rows included (private.validate_bill_rows). */
export const MAX_UNIT_ROWS = 500;

export const SAVE_BLOCK_COPY: Record<SaveBlock, string> = {
  has_errors: 'Fix the highlighted fields to save.',
  no_items: 'Add at least one item to save.',
  mismatch: 'The numbers need to add up before you can save.',
  negative_total: "The total can't be below $0.00.",
  too_many_units: "That's too many items for one bill (500 max).",
};

/** evaluateDraft's blank-row rule: such rows are skipped and produce no item. */
const isBlankRow = (row: DraftItem): boolean =>
  row.name.trim() === '' && row.price.trim() === '' && row.note.trim() === '';

/** evaluateDraft's blank-discount rule: such rows are skipped and produce no discount. */
const isBlankDiscount = (row: DraftDiscount): boolean => row.label.trim() === '' && row.amount.trim() === '';

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Which saved unit ids a draft row keeps for its new qty, and which claimed ones it drops.
 * On a decrease, unclaimed ids go first (highest unit_index first), then claimed ones (also
 * highest first). Kept ids keep their relative order and take units 0..kept-1.
 */
function keepIds(
  ids: readonly string[],
  qty: number,
  claimed: ReadonlySet<string>,
): { kept: string[]; droppedClaimed: string[] } {
  if (qty >= ids.length) return { kept: [...ids], droppedClaimed: [] };
  const dropOrder = [
    ...ids.filter((id) => !claimed.has(id)).reverse(),
    ...ids.filter((id) => claimed.has(id)).reverse(),
  ];
  const dropped = new Set(dropOrder.slice(0, ids.length - qty));
  return {
    kept: ids.filter((id) => !dropped.has(id)),
    droppedClaimed: ids.filter((id) => dropped.has(id) && claimed.has(id)),
  };
}

/**
 * Turns the form into create_bill / update_bill arguments. Pass `saved` (from draftFromSaved)
 * when editing, so kept units carry their line_items ids and their claims survive.
 */
export function toBillArgs(draft: BillDraft, ev: DraftEvaluation, saved?: SavedGroups): BillArgsResult {
  const items = ev.receipt.items;
  if (Object.keys(ev.errors).length > 0) return { ok: false, reason: 'has_errors' };
  if (items.length === 0) return { ok: false, reason: 'no_items' };
  if (ev.mismatches.length > 0) return { ok: false, reason: 'mismatch' };

  // With no errors, every non-blank draft row produced exactly one item, and every non-blank
  // discount row exactly one discount, in draft order.
  const sourceRows = draft.items.filter((row) => !isBlankRow(row));
  const sourceDiscounts = draft.discounts.filter((row) => !isBlankDiscount(row));
  const r = ev.receipt;
  if (sourceRows.length !== items.length || sourceDiscounts.length !== r.discounts.length) {
    throw new Error('toBillArgs: the evaluation does not match the draft');
  }
  const discounts = r.discounts.map((d, k) => ({ ...d, claimable: sourceDiscounts[k]?.claimable === true, draftId: sourceDiscounts[k]?.id ?? '' }));
  // A claimable discount of $0.00 moves no money and isn't stored (CD-12).
  const discountRows = discounts.filter((d) => d.claimable && d.cents > 0);
  if (sum(items.map((i) => i.qty)) + discountRows.length > MAX_UNIT_ROWS) return { ok: false, reason: 'too_many_units' };

  const tax = r.taxCents ?? 0;
  const fees = r.feesCents ?? 0;
  const tip = r.tipCents ?? 0;
  const discountOn = (on: DiscountAppliesTo, claimable: boolean): number =>
    sum(discounts.filter((d) => d.appliesTo === on && d.claimable === claimable).map((d) => d.cents));
  // Split discounts are the bill's sums; claimable ones are rows. The DB adds the rows back (C2).
  const subtotalDiscount = discountOn('subtotal', false);
  const totalDiscount = discountOn('total', false);
  const allDiscounts = sum(discounts.map((d) => d.cents));
  const total = r.totalCents ?? sum(items.map((i) => i.totalCents)) - allDiscounts + tax + fees + tip;
  if (total < 0) return { ok: false, reason: 'negative_total' };

  const rows: BillRowArg[] = [];
  const droppedClaimedIds: string[] = [];
  const claimed: ReadonlySet<string> = saved?.claimedIds ?? new Set<string>();
  const savedIds = (draftId: string): string[] => saved?.units[draftId] ?? [];
  const claimedOf = (draftIds: string[]): string[] => draftIds.flatMap(savedIds).filter((id) => claimed.has(id));

  // Saved rows the save deletes, by why. A cleared row, or a discount at $0.00: "Saving deletes".
  // A claimable discount switched to Split: "Sharing … with everyone". Rows removed with the
  // delete action aren't listed; the screen asks when they are deleted.
  const removedClaimedIds = claimedOf([
    ...draft.items.filter(isBlankRow).map((row) => row.id),
    ...draft.discounts.filter(isBlankDiscount).map((row) => row.id),
    ...discounts.filter((d) => d.cents === 0).map((d) => d.draftId),
  ]);
  const splitClaimedIds = claimedOf(discounts.filter((d) => !d.claimable && d.cents > 0).map((d) => d.draftId));

  items.forEach((item: ParsedItem, g) => {
    const draftRow = sourceRows[g];
    const { kept, droppedClaimed } = keepIds(draftRow ? savedIds(draftRow.id) : [], item.qty, claimed);
    droppedClaimedIds.push(...droppedClaimed);
    const note = item.modifiers.length > 0 ? item.modifiers.join(', ') : null;

    // Largest remainder with equal weights: the first units take the extra cents.
    allocate(item.totalCents, Array.from({ length: item.qty }, () => 1)).forEach((cents, u) => {
      const id = kept[u];
      const row: BillRowArg = {
        name: item.name,
        note,
        group_position: g,
        unit_index: u,
        group_size: item.qty,
        total_cents: cents,
      };
      rows.push(id === undefined ? row : { id, ...row });
    });
  });

  // Claimable discounts: one row each, after every item group, in draft order (C5).
  discountRows.forEach((d, k) => {
    const id = savedIds(d.draftId)[0];
    const row: BillRowArg = {
      name: d.label,
      note: null,
      group_position: items.length + k,
      unit_index: 0,
      group_size: 1,
      total_cents: -d.cents,
      kind: 'discount',
      applies_to: d.appliesTo,
    };
    rows.push(id === undefined ? row : { id, ...row });
  });

  return {
    ok: true,
    rows,
    money: {
      p_subtotal_cents: r.subtotalCents,
      p_tax_cents: tax,
      p_fees_cents: fees,
      p_tip_cents: tip,
      p_subtotal_discount_cents: subtotalDiscount,
      p_total_discount_cents: totalDiscount,
      p_total_cents: total,
    },
    droppedClaimedIds,
    removedClaimedIds,
    splitClaimedIds,
  };
}

const zeroAsBlank = (cents: number): string => (cents === 0 ? '' : formatCentsInput(cents));

/**
 * Loads a saved bill into the host's edit form: each group of unit rows becomes one form row
 * with qty = group_size and the summed price. Rows may arrive in any order.
 */
export function draftFromSaved(
  bill: SavedBill,
  rows: readonly SavedRow[],
  claims: readonly SavedClaim[],
): { draft: BillDraft; saved: SavedGroups } {
  const sorted = [...rows].sort((a, b) => a.group_position - b.group_position || a.unit_index - b.unit_index);
  const isDiscount = (row: SavedRow): boolean => row.kind === 'discount';
  const groups: SavedRow[][] = [];
  for (const row of sorted.filter((x) => !isDiscount(x))) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.group_position === row.group_position) last.push(row);
    else groups.push([row]);
  }

  let n = 1;
  const units: Record<string, string[]> = {};
  const items: DraftItem[] = [];
  for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    const id = `i${n++}`;
    units[id] = group.map((u) => u.id);
    items.push({
      id,
      name: first.name,
      qty: String(first.group_size),
      price: formatCentsInput(sum(group.map((u) => u.total_cents))),
      note: first.note ?? '',
      flagged: false,
    });
  }

  // One row per stored discount sum, before-subtotal first, so the form reconciles as saved.
  const discounts: DraftDiscount[] = [];
  for (const [cents, appliesTo] of [
    [bill.subtotal_discount_cents, 'subtotal'],
    [bill.total_discount_cents, 'total'],
  ] as const) {
    if (cents > 0) discounts.push({ id: `d${n++}`, label: 'Discount', amount: formatCentsInput(cents), appliesTo, claimable: false });
  }
  // Then each claimable discount row, in position order, keeping its id so its claims survive (C5).
  for (const row of sorted.filter(isDiscount)) {
    if (row.applies_to !== 'subtotal' && row.applies_to !== 'total') {
      // fetchBill's parseRow rejects such a row; reaching here means a caller built one by hand.
      throw new RangeError('draftFromSaved: a discount row needs applies_to');
    }
    const id = `d${n++}`;
    units[id] = [row.id];
    discounts.push({ id, label: row.name, amount: formatCentsInput(-row.total_cents), appliesTo: row.applies_to, claimable: true });
  }

  const rowIds = new Set(rows.map((r) => r.id));
  const claimedIds = new Set(claims.map((c) => c.line_item_id).filter((id) => rowIds.has(id)));

  return {
    draft: {
      source: 'manual',
      items,
      discounts,
      totals: {
        subtotal: bill.subtotal_cents === null ? '' : formatCentsInput(bill.subtotal_cents),
        tax: zeroAsBlank(bill.tax_cents),
        fees: zeroAsBlank(bill.fees_cents),
        tip: zeroAsBlank(bill.tip_cents),
        total: formatCentsInput(bill.total_cents),
      },
      nextId: n,
    },
    saved: { units, claimedIds },
  };
}
