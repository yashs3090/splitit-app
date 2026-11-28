// "Who had this?" on a group bill (spec docs/specs/2026-11-26-groups-mvp.md, U-G6, C-G12, T11).
// Any group member can set who had a row. The screen sends the whole new claimer map to
// assign_item(row, next, current), so these helpers only build that map and the chips. Pure.

/** Member id → parts (1..20), the same shape assign_item and set_item_split take. `{}` = nobody. */
export type PartsMap = Readonly<Record<string, number>>;

export const MAX_ASSIGN_PARTS = 20;

function isParts(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_ASSIGN_PARTS;
}

/**
 * The claimer map after tapping `userId`'s chip: someone who had it is removed (their key is
 * dropped); someone who didn't is added at 1 part. Everyone else keeps their parts. Never mutates
 * `current`. Throws RangeError for an empty id or a `current` with parts outside 1..20 (the bill's
 * parser never produces one), so a broken map is never sent.
 */
export function toggleAssignee(current: PartsMap, userId: string): Record<string, number> {
  if (typeof userId !== 'string' || userId === '') throw new RangeError('toggleAssignee: empty user id');
  const next: Record<string, number> = {};
  for (const [id, parts] of Object.entries(current)) {
    if (!isParts(parts)) throw new RangeError('toggleAssignee: parts must be integers 1..20');
    if (id !== userId) next[id] = parts;
  }
  if (!Object.prototype.hasOwnProperty.call(current, userId)) next[userId] = 1;
  return next;
}

export type AssignChip = {
  userId: string;
  /** "You" for the viewer, else the member's name ("A friend" if blank). */
  name: string;
  isViewer: boolean;
  /** Whether they had this row (they're in the claimer map). */
  checked: boolean;
  /** Their parts, or null when they didn't have it. */
  parts: number | null;
  /** "Ben, had this" / "Ben, didn't have this"; "You had this" / "You didn't have this" for the viewer. */
  a11yLabel: string;
};

const A_FRIEND = 'A friend';

function safeName(nameOf: (userId: string) => string, userId: string): string {
  try {
    const n = nameOf(userId);
    return typeof n === 'string' && n.trim() !== '' ? n.trim() : A_FRIEND;
  } catch {
    return A_FRIEND;
  }
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One chip per member (each id once): the viewer first, then by name ignoring case, ties by id.
 * Claim keys that aren't members get no chip (a group bill's parser refuses them anyway).
 */
export function assignChips(
  members: readonly { userId: string }[],
  current: PartsMap,
  viewerId: string,
  nameOf: (userId: string) => string,
): AssignChip[] {
  const seen = new Set<string>();
  const chips: AssignChip[] = [];
  for (const { userId } of members) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    const isViewer = userId === viewerId;
    const name = isViewer ? 'You' : safeName(nameOf, userId);
    const parts = Object.prototype.hasOwnProperty.call(current, userId) ? (current[userId] ?? null) : null;
    const checked = parts !== null;
    const a11yLabel = isViewer
      ? checked
        ? 'You had this'
        : "You didn't have this"
      : `${name}, ${checked ? 'had this' : "didn't have this"}`;
    chips.push({ userId, name, isViewer, checked, parts, a11yLabel });
  }
  return chips.sort(
    (a, b) =>
      Number(b.isViewer) - Number(a.isViewer) ||
      codeUnitCompare(a.name.toLowerCase(), b.name.toLowerCase()) ||
      codeUnitCompare(a.userId, b.userId),
  );
}

/** Fixed words for the "Who had this?" section of the item sheet (T18). */
export const ASSIGN_COPY = {
  heading: 'Who had this?',
  refreshFailed: "Couldn't refresh this item. Try again.",
  retry: 'Try again',
  retryHint: 'Loads the latest for this item',
  splitSaved: 'Split saved',
} as const;

function firstWord(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/**
 * What each chip shows (member id → text): the first name, "You" for the viewer, "A friend" whole.
 * When two people other than the viewer share a first name (case ignored), both show their full
 * names, so the chips can't be confused. The chip's accessibility label always has the full name.
 */
export function chipNames(chips: readonly AssignChip[]): Record<string, string> {
  const short = (c: AssignChip) => (c.isViewer || c.name === A_FRIEND ? c.name : firstWord(c.name));
  const counts = new Map<string, number>();
  for (const c of chips) {
    if (c.isViewer || c.name === A_FRIEND) continue;
    const key = short(c).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const c of chips) {
    const s = short(c);
    out[c.userId] = !c.isViewer && c.name !== A_FRIEND && (counts.get(s.toLowerCase()) ?? 0) > 1 ? c.name : s;
  }
  return out;
}

/** The screen-reader hint: what a tap on this chip does ("Puts Ben on this item"). */
export function assignChipHint(chip: AssignChip, noun: 'item' | 'discount'): string {
  const who = chip.isViewer ? 'you' : chip.name;
  return chip.checked ? `Takes ${who} off this ${noun}` : `Puts ${who} on this ${noun}`;
}
