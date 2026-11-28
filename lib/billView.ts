// Pure view helpers for the bill screen (spec 2026-11-20-m1b-m2, Task 10, "Claim screen UX").
// Components render what these return and do no money arithmetic of their own (lessons log,
// "Money math was duplicated in a component"). Every amount is integer cents, formatted only
// through lib/money.ts.
import type { BillParticipant, BillRecord, BillRow, BillSummary } from './bills';
import type { SavedBill, SavedClaim, SavedRow } from './billPayload';
import { formatCents } from './money';
import {
  computeShares,
  type DisplayShares,
  type ExtrasMode,
  type ItemSplit,
  type RowKind,
  type SplitInput,
  type SplitItem,
} from './split';

/** The two extras split modes, in the order the host's selector lists them. */
export const EXTRAS_MODES: readonly ExtrasMode[] = ['proportional', 'equal'];

/** The bill's extras mode (A1.7). fetchBill has already checked it is one of EXTRAS_MODES. */
export function extrasModeOf(bill: Pick<BillRecord, 'extras_split'>): ExtrasMode {
  return bill.extras_split;
}

/** What each mode is called on its own ("split evenly"), for the host's options (user wording). */
export function extrasModeName(mode: ExtrasMode): string {
  return mode === 'equal' ? 'split evenly' : 'split proportionally';
}

/** The line everyone sees in the expanded summary: "Tax & tip: split evenly". */
export function extrasModeText(mode: ExtrasMode): string {
  return `Tax & tip: ${extrasModeName(mode)}`;
}

/** The muted helper line under "equal"; none under proportional. */
export function extrasModeHelp(mode: ExtrasMode): string | null {
  return mode === 'equal' ? 'Split evenly between everyone who has claimed something.' : null;
}

export type NameOf = (userId: string | null) => string;

function cleanName(name: string | null): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** "You" for the viewer, the display name, "A friend" when it's unset, "Someone" when unknown. */
export function makeNameOf(participants: readonly BillParticipant[], myId: string): NameOf {
  const names = new Map(participants.map((p) => [p.userId, cleanName(p.displayName)]));
  return (userId) => {
    if (userId === null) return 'Someone';
    if (userId === myId) return 'You';
    if (!names.has(userId)) return 'Someone';
    return names.get(userId) ?? 'A friend';
  };
}

/**
 * Up to two letters: the first letters of the first and last words. "?" when there is no name.
 * Bracketed notes ("Tejesh (demo)") are dropped and a word's letter is its first letter or digit,
 * so punctuation never shows up as an initial.
 */
export function initials(name: string | null): string {
  const cleaned = cleanName(name)?.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') ?? '';
  const words = cleaned.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const first = words[0];
  if (first === undefined) return '?';
  const letter = (w: string) => (w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').toUpperCase();
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return letter(first) + (last ? letter(last) : '');
}

/** "Pat", "Pat and Sam", "Pat, Sam and Ali". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Hana's bill", or "Your bill" for the host. */
export function billTitle(hostId: string, myId: string, nameOf: NameOf): string {
  return hostId === myId ? 'Your bill' : `${nameOf(hostId)}'s bill`;
}

type UnitFields = Pick<SavedRow, 'name' | 'unit_index' | 'group_size'>;

/** "Beer · 1 of 2" for a unit of a group, else the name. */
export function rowLabel(row: UnitFields): string {
  return row.group_size > 1 ? `${row.name} · ${row.unit_index + 1} of ${row.group_size}` : row.name;
}

/** The row's name for accessibility labels: "Beer 1 of 2", "Fries". */
export function rowA11yName(row: UnitFields): string {
  return row.group_size > 1 ? `${row.name} ${row.unit_index + 1} of ${row.group_size}` : row.name;
}

/** Caption over the claimable discount rows, which come after every item (claimable discounts). */
export const DISCOUNTS_HEADING = 'Discounts';

/** A claimable discount row's name for accessibility labels: "Police comp, discount". */
export function discountRowA11yName(name: string): string {
  return `${name}, discount`;
}

/**
 * The accessibility label of a row's details target, which hides its children from screen
 * readers: "Fries, $6.00, Split 2 ways · $3.00 each, claimed by You and Hana Lee". With one
 * claimer the status already names them, so the names are added only for 2+.
 */
export function rowDetailsA11yLabel(
  a11yName: string,
  priceCents: number,
  status: string,
  claimerNames: readonly string[],
): string {
  const parts = [a11yName, formatCents(priceCents), status];
  if (claimerNames.length > 1) parts.push(`claimed by ${nameList(claimerNames)}`);
  return parts.join(', ');
}

/** Applies in-flight claim toggles (row id → claimed) for the viewer on top of the server's claims. */
export function applyClaimOverrides(
  claims: readonly SavedClaim[],
  overrides: ReadonlyMap<string, boolean>,
  myId: string,
): readonly SavedClaim[] {
  if (overrides.size === 0) return claims;
  const out = claims.filter((c) => !(c.user_id === myId && overrides.get(c.line_item_id) === false));
  overrides.forEach((claimed, rowId) => {
    if (claimed && !out.some((c) => c.line_item_id === rowId && c.user_id === myId)) {
      out.push({ line_item_id: rowId, user_id: myId, parts: 1 });
    }
  });
  return out;
}

/**
 * One row as split math sees it. A row without `kind` is an item (Task 4, CD-T4-1/2), and item
 * rows are passed without `kind` so their input is exactly what it was before discounts.
 */
function splitItemOf(r: SavedRow): SplitItem {
  return r.kind === 'discount'
    ? { id: r.id, totalCents: r.total_cents, kind: 'discount' }
    : { id: r.id, totalCents: r.total_cents };
}

/** The split-math input for this bill and these (possibly optimistic) claims. */
export function splitInputFor(
  data: { bill: SavedBill & Pick<BillRecord, 'extras_split'>; rows: readonly SavedRow[]; participants: readonly BillParticipant[] },
  claims: readonly SavedClaim[],
): SplitInput {
  return {
    totalCents: data.bill.total_cents,
    items: data.rows.map(splitItemOf),
    claims: claims.map((c) => ({ itemId: c.line_item_id, userId: c.user_id, parts: c.parts })),
    participantIds: data.participants.map((p) => p.userId),
    extrasMode: extrasModeOf(data.bill),
  };
}

/** The one quiet status line under a row's name. */
export function rowStatus(split: ItemSplit | undefined, row: Pick<BillRow, 'split_set_by'>, myId: string, nameOf: NameOf): string {
  if (!split || split.status === 'unclaimed') return 'Unclaimed';
  const entries = Object.entries(split.byUser);
  if (split.status === 'claimed') {
    const [userId, cents] = entries[0] ?? [null, 0];
    return userId === myId ? `You · ${formatCents(cents)}` : nameOf(userId);
  }
  if (split.custom) {
    if (row.split_set_by === null) return 'Custom split';
    const by = row.split_set_by === myId ? 'you' : nameOf(row.split_set_by);
    return `Custom split · set by ${by}`;
  }
  const amounts = entries.map(([, cents]) => cents);
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const each = low === high ? formatCents(low) : `${formatCents(low)}–${formatCents(high)}`;
  return `Split ${entries.length} ways · ${each} each`;
}

/**
 * "Items $13.00 + tax, tip and fees $3.64", or "Items $20.00 − discounts $5.00" when extras are
 * negative. A person's claimed discounts (`discountCents`, always ≤ 0) come right after the items:
 * "Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28". With no claimed discount the
 * text is exactly what it was before claimable discounts.
 */
export function breakdownText(itemsCents: number, extrasCents: number, discountCents = 0): string {
  if (!Number.isSafeInteger(discountCents) || discountCents > 0) {
    throw new RangeError('breakdownText: discountCents must be an integer ≤ 0');
  }
  let text = `Items ${formatCents(itemsCents)}`;
  if (discountCents !== 0) text += ` − claimed discounts ${formatCents(-discountCents)}`;
  if (extrasCents > 0) text += ` + tax, tip and fees ${formatCents(extrasCents)}`;
  else if (extrasCents < 0) text += ` − discounts ${formatCents(-extrasCents)}`;
  return text;
}

type UnclaimedParts = Pick<DisplayShares, 'unclaimedItemsCents' | 'unclaimedDiscountCents' | 'unclaimedExtrasCents'>;

/**
 * What nobody has claimed yet: items, claimable discounts nobody claimed (≤ 0) and extras (0 extras
 * under "equal" once anyone has claimed). May be negative when an unclaimed discount outweighs the rest.
 */
export function unclaimedTotalCents(shares: UnclaimedParts): number {
  return shares.unclaimedItemsCents + shares.unclaimedDiscountCents + shares.unclaimedExtrasCents;
}

/**
 * R5 (user decision 2026-11-22): the Unclaimed line shows while any row is unclaimed, and also
 * whenever money is left over with every row claimed (e.g. all claimed rows are $0.00 but there
 * is tax), so the shares plus Unclaimed always add up to the total on screen. Otherwise the
 * summary says "Everything's claimed."
 */
export function showUnclaimedLine(shares: UnclaimedParts & Pick<DisplayShares, 'complete'>): boolean {
  return !shares.complete || unclaimedTotalCents(shares) !== 0;
}

const countOf = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What's left to claim, named by kind (claimable discounts, Amendment A1 / R1). `unclaimedRows`
 * counts every unclaimed row; `unclaimedDiscountRows` is how many of them are discount rows.
 * - `count`: "1 item", "2 discounts", "2 items and 1 discount"
 * - `all` / `every`: "all items" / "every item", "all discounts" / "every discount", or "everything"
 */
export function leftToClaim(
  unclaimedRows: number,
  unclaimedDiscountRows = 0,
): { count: string; all: string; every: string } {
  const discounts = unclaimedDiscountRows;
  const items = unclaimedRows - discounts;
  if (discounts === 0) return { count: countOf(items, 'item', 'items'), all: 'all items', every: 'every item' };
  const d = countOf(discounts, 'discount', 'discounts');
  if (items === 0) return { count: d, all: 'all discounts', every: 'every discount' };
  return { count: `${countOf(items, 'item', 'items')} and ${d}`, all: 'everything', every: 'everything' };
}

/** "all items are claimed", "all discounts are claimed" or "everything is claimed", for what's left. */
export function pendingTotalWhen(unclaimedRows: number, unclaimedDiscountRows = 0): string {
  const { all } = leftToClaim(unclaimedRows, unclaimedDiscountRows);
  return all === 'everything' ? 'everything is claimed' : `${all} are claimed`;
}

/** A2.2: shown in place of a total under "equal" until every row is claimed. */
export function pendingTotalText(unclaimedRows: number, unclaimedDiscountRows = 0): string {
  const { count } = leftToClaim(unclaimedRows, unclaimedDiscountRows);
  return `Total shows once ${pendingTotalWhen(unclaimedRows, unclaimedDiscountRows)} (${count} left)`;
}

/**
 * One person's line in the expanded summary, for screen readers: "Pat $16.64", or while the
 * total is pending (A2.2) "Pat, items $10.00, total shows once all items are claimed".
 */
export function personShareA11yLabel(
  name: string,
  cents: number,
  totalPending: boolean,
  pendingWhen = 'all items are claimed', // pendingTotalWhen(...) for what's left (R1)
): string {
  return totalPending
    ? `${name}, items ${formatCents(cents)}, total shows once ${pendingWhen}`
    : `${name} ${formatCents(cents)}`;
}

// ---------------------------------------------------------------------------
// Item sheet: custom split (Task 11)
// ---------------------------------------------------------------------------

/** Parts per claimer are whole numbers in this range (the claims.parts check). */
export const MIN_PARTS = 1;
export const MAX_PARTS = 20;

/** One step up or down, kept within MIN_PARTS..MAX_PARTS. */
export function stepParts(parts: number, delta: 1 | -1): number {
  return Math.min(MAX_PARTS, Math.max(MIN_PARTS, parts + delta));
}

/** "1 part", "2 parts". */
export function partsLabel(parts: number): string {
  return `${parts} ${parts === 1 ? 'part' : 'parts'}`;
}

/** The current parts on one row, per claimer. */
export function partsOf(claims: readonly SavedClaim[], rowId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of claims) if (c.line_item_id === rowId) out[c.user_id] = c.parts;
  return out;
}

/**
 * What each claimer would pay for a row of `totalCents` with these parts. It runs the real split
 * math on that one row, so the preview always matches what the shares will show after saving. A
 * discount row (`kind` 'discount', negative total) previews negative pieces; like computeShares, a
 * total whose sign doesn't fit the kind throws RangeError.
 */
export function splitPreview(
  totalCents: number,
  parts: Readonly<Record<string, number>>,
  kind: RowKind = 'item',
): Record<string, number> {
  const userIds = Object.keys(parts);
  if (userIds.length === 0) return {};
  const result = computeShares({
    totalCents,
    items: [kind === 'discount' ? { id: 'preview', totalCents, kind } : { id: 'preview', totalCents }],
    claims: userIds.map((userId) => ({ itemId: 'preview', userId, parts: parts[userId] ?? MIN_PARTS })),
    participantIds: userIds,
    extrasMode: 'proportional',
  });
  return { ...(result.items.preview?.byUser ?? {}) };
}

/**
 * Applies in-flight splits (row id → parts per user) on top of the claims. Only existing claims on
 * that row change; nobody is added or removed, like set_item_split itself.
 */
export function applySplitOverrides(
  claims: readonly SavedClaim[],
  overrides: ReadonlyMap<string, Readonly<Record<string, number>>>,
): readonly SavedClaim[] {
  if (overrides.size === 0) return claims;
  return claims.map((c) => {
    const parts = overrides.get(c.line_item_id)?.[c.user_id];
    return parts === undefined ? c : { ...c, parts };
  });
}

// ---------------------------------------------------------------------------
// Home: "Your bills" (Task 12)
// ---------------------------------------------------------------------------

/** "Nov 20" in the device's locale, or '' for a date that can't be read. */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Hana's bill · Nov 20 · $44.80", or "Your bill · …" for bills you host. */
export function billListLabel(
  summary: BillSummary,
  myId: string,
  formatDate: (iso: string) => string = formatShortDate,
): string {
  const host = summary.hostId === myId ? 'Your bill' : `${cleanName(summary.hostName) ?? 'A friend'}'s bill`;
  const date = formatDate(summary.createdAt);
  return [host, date, formatCents(summary.totalCents)].filter((part) => part !== '').join(' · ');
}
