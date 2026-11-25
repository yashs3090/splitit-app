// Copy and claim counts for the host's edit screen (app/(app)/bills/[id]/edit.tsx).
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 13, A3.4). Pure: no money math.
import { evaluateDraft, type BillDraft } from './billDraft';
import { toBillArgs, type BillArgsResult, type SavedClaim, type SavedGroups } from './billPayload';
import { nameList } from './billView';

/** The saved-row fields the confirmation copy needs. */
export type EditRow = { id: string; name: string; group_position: number };

export const EDIT_COPY = {
  title: 'Edit items',
  note: "Changing a price updates everyone's share. Deleting an item removes anyone's claim on it.",
  hostOnly: 'Only the person who created this bill can edit it.',
  loadError: "Couldn't load the bill.",
  save: 'Save changes',
  saving: 'Saving…',
  saveError: "Couldn't save your changes.",
  changedWhileEditing: 'The bill changed while you were editing. Go back and try again.',
} as const;

const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;
const claimsOf = (n: number): string => (n === 1 ? "1 person's claim" : `${n} people's claims`);

/** How many different people have a claim on any of these unit rows. */
export function claimerCount(unitIds: readonly string[], claims: readonly SavedClaim[]): number {
  const ids = new Set(unitIds);
  return new Set(claims.filter((c) => ids.has(c.line_item_id)).map((c) => c.user_id)).size;
}

/** Asked before deleting a form row whose units have claims. */
export function deleteConfirmCopy(claimers: number): string {
  return `${people(claimers)} claimed this. Delete it anyway?`;
}

/** Known ids grouped by item (group_position), in bill order. */
function byGroup(ids: readonly string[], rows: readonly EditRow[]): { name: string; ids: string[] }[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const groups = new Map<number, { name: string; ids: string[] }>();
  for (const id of ids) {
    const row = rowById.get(id);
    if (!row) continue;
    const g = groups.get(row.group_position) ?? { name: row.name, ids: [] };
    g.ids.push(id);
    groups.set(row.group_position, g);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, g]) => g);
}

/**
 * Asked before saving when the save would remove claimed units: a lowered quantity
 * (droppedClaimedIds), a saved row whose fields were all cleared (removedClaimedIds), or a
 * claimed claimable discount switched to Split (splitClaimedIds; docs/specs/2026-11-24-claimable-discounts.md).
 * Null when there is nothing to confirm.
 */
export function saveConfirmCopy(
  lost: { droppedClaimedIds: readonly string[]; removedClaimedIds: readonly string[]; splitClaimedIds?: readonly string[] },
  rows: readonly EditRow[],
  claims: readonly SavedClaim[],
): string | null {
  const sentences: string[] = [];
  const dropped = byGroup(lost.droppedClaimedIds, rows);
  if (dropped.length > 0) {
    sentences.push(`Lowering the quantity removes ${nameList(dropped.map((g) => `${g.ids.length} claimed ${g.name}`))}.`);
  }
  for (const g of byGroup(lost.removedClaimedIds, rows)) {
    sentences.push(`Saving deletes ${g.name}, which ${people(claimerCount(g.ids, claims))} claimed.`);
  }
  for (const g of byGroup(lost.splitClaimedIds ?? [], rows)) {
    sentences.push(`Sharing ${g.name} with everyone removes ${claimsOf(claimerCount(g.ids, claims))}.`);
  }
  return sentences.length === 0 ? null : `${sentences.join(' ')} Continue?`;
}

/** The parts of a fetched bill the save-time check reads. */
export type EditSnapshot = {
  bill: { edited_at: string | null };
  rows: readonly EditRow[];
  claims: readonly SavedClaim[];
};

export type FreshSaveCheck =
  /** Another edit landed since the form opened: don't save over it. */
  | { kind: 'changed' }
  /** The draft can't be saved (not reachable from the screen, which only checks a valid draft). */
  | { kind: 'blocked' }
  /** Save with `args`, after asking `question` when it isn't null. */
  | { kind: 'ready'; args: Extract<BillArgsResult, { ok: true }>; question: string | null };

/**
 * R1: re-checks a save against the bill as it is now. The form keeps its opening snapshot, but
 * claims keep arriving while the host edits. Rebuilds which saved units are claimed from the
 * fresh claims (so a lowered quantity drops unclaimed units first), and asks before removing any
 * claim the host wasn't asked about: dropped units, cleared rows, claimable discounts switched to
 * Split, and deleted rows (items or discounts) that had no claims when they were deleted. A different edited_at or set of row ids means the bill itself
 * changed: the caller shows the "changed while you were editing" copy.
 */
export function freshSaveCheck(
  draft: BillDraft,
  snapshot: EditSnapshot,
  saved: SavedGroups,
  fresh: EditSnapshot,
): FreshSaveCheck {
  const ids = (rows: readonly EditRow[]) => [...rows.map((r) => r.id)].sort().join(',');
  if (fresh.bill.edited_at !== snapshot.bill.edited_at || ids(fresh.rows) !== ids(snapshot.rows)) {
    return { kind: 'changed' };
  }

  const rowIds = new Set(fresh.rows.map((r) => r.id));
  const claimedIds = new Set(fresh.claims.map((c) => c.line_item_id).filter((id) => rowIds.has(id)));
  const args = toBillArgs(draft, evaluateDraft(draft), { units: saved.units, claimedIds });
  if (!args.ok) return { kind: 'blocked' };

  // Rows deleted from the form: the delete question used the opening claims, so only rows that
  // were unclaimed then (no question was asked) and are claimed now need asking about.
  // Discount draft ids count too: a kept claimable discount is in saved.units under its draft id.
  const inDraft = new Set([...draft.items.map((i) => i.id), ...draft.discounts.map((x) => x.id)]);
  const askedAtDelete = new Set(snapshot.claims.map((c) => c.line_item_id));
  const newlyClaimedDeleted = Object.entries(saved.units)
    .filter(([draftId, unitIds]) => !inDraft.has(draftId) && !unitIds.some((id) => askedAtDelete.has(id)))
    .flatMap(([, unitIds]) => unitIds.filter((id) => claimedIds.has(id)));

  const question = saveConfirmCopy(
    {
      droppedClaimedIds: args.droppedClaimedIds,
      removedClaimedIds: [...args.removedClaimedIds, ...newlyClaimedDeleted],
      splitClaimedIds: args.splitClaimedIds,
    },
    fresh.rows,
    fresh.claims,
  );
  return { kind: 'ready', args, question };
}
