// "People you've split with": the list, search, row captions and who can still be added to a bill.
// Spec: docs/specs/2026-11-24-people-and-invites.md (L1, L2, L4, D6, D7; Tasks 3 and 4); group-only links: docs/specs/2026-11-26-groups-mvp.md (U-G5, T11).
//
// The app never decides who is linked (rule L1) or how the list is ranked (L2): both live only in
// the database's people_i_split_with(). Everything here keeps the order it was given.
import { isUuid } from './bills';
import { supabase } from './supabase';
import { VENMO_USERNAME_PATTERN } from './venmo';

export type Person = {
  userId: string;
  displayName: string | null;
  venmoUsername: string | null;
  /** Bills you're both linked through (L1); an integer ≥ 0. 0 means linked only through a group (Groups U-G5). */
  sharedBills: number;
  /** created_at of the newest of those bills, or the later group join (ISO timestamp). */
  lastSharedAt: string;
};

export type ListPeopleResult = { ok: true; people: Person[] } | { ok: false; error: 'not_allowed' | 'network' };

/** Formats a date for a caption ("Nov 20"). The screen passes the device-locale one; tests pass their own. */
export type FormatDate = (d: Date) => string;

const NO_NAME = 'A friend';
const MAX_QUERY_CHARS = 50;
// Combining marks left after NFD (diacritics). Explicit ranges rather than \p{M}, so the rule
// doesn't depend on the JS engine's Unicode property support.
const COMBINING_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

// ---------------------------------------------------------------------------
// Search (L4)
// ---------------------------------------------------------------------------

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => w !== '');
}

/**
 * L4: the query is trimmed and cut to 50 characters; empty matches everyone. Both sides are folded
 * (lower case, accents removed). Every query word must be the start of some word in the name.
 * A person with no name matches only the empty query.
 */
export function matchesQuery(name: string | null, query: string): boolean {
  const cut = Array.from(query.trim()).slice(0, MAX_QUERY_CHARS).join('');
  const queryWords = words(fold(cut));
  if (queryWords.length === 0) return true;
  const nameWords = words(fold(name ?? ''));
  return queryWords.every((q) => nameWords.some((w) => w.startsWith(q)));
}

/** The people matching `query`, in the order given (L2). */
export function filterPeople(people: readonly Person[], query: string): Person[] {
  return people.filter((p) => matchesQuery(p.displayName, query));
}

/** The people not on the bill yet, in the order given. */
export function addablePeople(people: readonly Person[], participantIds: readonly string[]): Person[] {
  const on = new Set(participantIds);
  return people.filter((p) => !on.has(p.userId));
}

// ---------------------------------------------------------------------------
// Rows (D6, PI-10)
// ---------------------------------------------------------------------------

/** The name a row shows: the trimmed display name, or "A friend". */
export function personName(person: Person): string {
  const trimmed = person.displayName?.trim() ?? '';
  return trimmed === '' ? NO_NAME : trimmed;
}

/** The name as compared for duplicates: what the row shows, spaces collapsed, case ignored. */
function nameKey(person: Person): string {
  return personName(person).replace(/\s+/g, ' ').toLowerCase();
}

/** The handle to show, or null: only when someone else in `all` reads as the same name (PI-10). */
function shownHandle(person: Person, all: readonly Person[]): string | null {
  if (person.venmoUsername === null) return null;
  const key = nameKey(person);
  const duplicate = all.some((other) => other.userId !== person.userId && nameKey(other) === key);
  return duplicate ? person.venmoUsername : null;
}

function billCount(n: number): string {
  return n === 1 ? '1 bill' : `${n} bills`;
}

const IN_A_GROUP = 'In a group together';

/**
 * "1 bill · Nov 20", "4 bills · last Nov 20", "In a group together" (no shared bill, Groups T11),
 * plus " · @handle" for a same-name person (PI-10).
 */
export function personCaption(person: Person, all: readonly Person[], formatDate: FormatDate): string {
  if (person.sharedBills === 0) {
    const handle = shownHandle(person, all);
    return `${IN_A_GROUP}${handle === null ? '' : ` · @${handle}`}`;
  }
  const date = formatDate(new Date(person.lastSharedAt));
  const when = person.sharedBills === 1 ? date : `last ${date}`;
  const handle = shownHandle(person, all);
  return `${billCount(person.sharedBills)} · ${when}${handle === null ? '' : ` · @${handle}`}`;
}

/**
 * "Sam Lee, 4 bills together, last on Nov 20", "Sam Lee, in a group together" (no shared bill),
 * plus ", Venmo @sam-lee" when the caption shows the handle.
 */
export function personA11yLabel(person: Person, all: readonly Person[], formatDate: FormatDate): string {
  if (person.sharedBills === 0) {
    const handle = shownHandle(person, all);
    return `${personName(person)}, in a group together${handle === null ? '' : `, Venmo @${handle}`}`;
  }
  const date = formatDate(new Date(person.lastSharedAt));
  const when = person.sharedBills === 1 ? `on ${date}` : `last on ${date}`;
  const handle = shownHandle(person, all);
  const venmo = handle === null ? '' : `, Venmo @${handle}`;
  return `${personName(person)}, ${billCount(person.sharedBills)} together, ${when}${venmo}`;
}

// ---------------------------------------------------------------------------
// Data (D7)
// ---------------------------------------------------------------------------

class Malformed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parsePerson(v: unknown): Person {
  if (!isObject(v)) throw new Malformed();
  const { user_id, display_name, venmo_username, shared_bills, last_shared_at } = v;
  if (!isUuid(user_id)) throw new Malformed();
  if (display_name !== null && typeof display_name !== 'string') throw new Malformed();
  if (venmo_username !== null && (typeof venmo_username !== 'string' || !VENMO_USERNAME_PATTERN.test(venmo_username))) {
    throw new Malformed();
  }
  if (typeof shared_bills !== 'number' || !Number.isInteger(shared_bills) || shared_bills < 0) throw new Malformed();
  if (typeof last_shared_at !== 'string' || Number.isNaN(new Date(last_shared_at).getTime())) throw new Malformed();
  return {
    userId: user_id,
    displayName: display_name,
    venmoUsername: venmo_username,
    sharedBills: shared_bills,
    lastSharedAt: last_shared_at,
  };
}

/**
 * The signed-in user's linked people, in the database's order (L2, at most 200). Any malformed
 * row makes the whole result 'network'. 42501 (signed out, or anon) is 'not_allowed'. Server
 * text is never returned. Never throws.
 */
export async function listPeople(): Promise<ListPeopleResult> {
  let data: unknown;
  try {
    const res = await supabase.rpc('people_i_split_with');
    if (res.error) {
      const code = (res.error as { code?: unknown }).code;
      return { ok: false, error: code === '42501' ? 'not_allowed' : 'network' };
    }
    data = res.data as unknown;
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!Array.isArray(data)) return { ok: false, error: 'network' };
  try {
    const people = data.map(parsePerson);
    // The function returns each person once; a repeat would mean a broken result (and duplicate row keys).
    if (new Set(people.map((p) => p.userId)).size !== people.length) return { ok: false, error: 'network' };
    return { ok: true, people };
  } catch {
    return { ok: false, error: 'network' };
  }
}
