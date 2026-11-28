// Device-local "seen" state for the Activity badge, the unread dots and the Groups dot
// (spec docs/specs/2026-11-28-tab-bar-and-activity.md, Contract S; FEED-28, FEED-29, FEED-30).
//
// No database: the user rejected stored last-seen fields (U11). One lib/storage key per signed-in
// user, `splitit.feedSeen.<userId>`, holding only timestamps:
//   { activity: iso | null, bills: { [billId]: iso }, groups: { [groupId]: iso } }
// On native, lib/storage chunks SecureStore values at 1800 bytes, so size is handled there.
//
// - Writes are always max(stored, now), so a clock change never moves a time backwards.
// - Places that are no longer mine are pruned on each write, using the newest places list
//   loadFeedPlaces saw (rememberFeedPlaces). An entry written after that list was read is kept,
//   since the list may not know the place yet.
// - Every storage call gives up after GROUP_REQUEST_TIMEOUT_MS (Contract T). A failed or timed-out
//   write is ignored (the badge just stays); it never throws.
// - The key is per user, so another person signing in on this device never sees these times. They
//   are kept across sign-out (timestamps only; FEED-30).

import { TIMED_OUT, within } from './asyncTimeout';
import { feedTimeMicros, type FeedItem } from './feedRules';
import { GROUP_REQUEST_TIMEOUT_MS } from './groups';
import { storage } from './storage';

export type FeedSeen = {
  activity: string | null;
  bills: Readonly<Record<string, string>>;
  groups: Readonly<Record<string, string>>;
};

export type FeedSeenKind = 'activity' | 'bill' | 'group';

export const EMPTY_FEED_SEEN: FeedSeen = Object.freeze({ activity: null, bills: Object.freeze({}), groups: Object.freeze({}) });

/** FEED-29 (starting value): with nothing newer stored, anything older than this counts as seen. */
export const FEED_FIRST_RUN_DAYS = 14;
const FIRST_RUN_MS = FEED_FIRST_RUN_DAYS * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function feedSeenKey(userId: string): string {
  return `splitit.feedSeen.${userId}`;
}

function msOf(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function parseTimes(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [id, t] of Object.entries(v)) {
    const ms = msOf(t);
    if (isUuid(id) && ms !== null) out[id.toLowerCase()] = new Date(ms).toISOString();
  }
  return out;
}

/** The stored value, cleaned: unknown keys and malformed entries are dropped; unreadable JSON is empty. */
function parseSeen(raw: string | null): FeedSeen {
  if (raw === null) return EMPTY_FEED_SEEN;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_FEED_SEEN;
  }
  if (!isObj(v)) return EMPTY_FEED_SEEN;
  const activityMs = msOf(v.activity);
  return {
    activity: activityMs === null ? null : new Date(activityMs).toISOString(),
    bills: parseTimes(v.bills),
    groups: parseTimes(v.groups),
  };
}

/** The raw stored string, or undefined when storage failed or timed out. */
async function readRaw(userId: string): Promise<string | null | undefined> {
  try {
    const r = await within(storage.getItem(feedSeenKey(userId)), GROUP_REQUEST_TIMEOUT_MS);
    return r === TIMED_OUT ? undefined : r;
  } catch {
    return undefined;
  }
}

/** This user's seen times on this device. Nothing stored is EMPTY_FEED_SEEN; a failed or timed-out read is null. */
export async function readFeedSeen(userId: string): Promise<FeedSeen | null> {
  if (userId === '') return null;
  const raw = await readRaw(userId);
  return raw === undefined ? null : parseSeen(raw);
}

// ---------------------------------------------------------------------------------------------
// Known places, for pruning

type KnownPlaces = { bills: ReadonlySet<string>; groups: ReadonlySet<string>; asOf: number };
const known = new Map<string, KnownPlaces>();

/**
 * The places I'm in, from a successful places read that started at `asOf` (ms). The next write
 * drops stored times for other places, unless they were written at or after `asOf`.
 */
export function rememberFeedPlaces(userId: string, bills: Iterable<string>, groups: Iterable<string>, asOf: number): void {
  const prev = known.get(userId);
  if (prev !== undefined && prev.asOf > asOf) return; // an older read finishing late never replaces a newer one
  known.set(userId, {
    bills: new Set([...bills].map((id) => id.toLowerCase())),
    groups: new Set([...groups].map((id) => id.toLowerCase())),
    asOf,
  });
}

/** Clears the remembered places (tests; and harmless on sign-out). */
export function forgetFeedPlaces(): void {
  known.clear();
}

function pruned(times: Readonly<Record<string, string>>, mine: ReadonlySet<string> | undefined, asOf: number, keep: string | null) {
  const out: Record<string, string> = {};
  for (const [id, t] of Object.entries(times)) {
    const ms = msOf(t) ?? 0;
    if (mine === undefined || mine.has(id) || id === keep || ms >= asOf) out[id] = t;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writes

type Listener = (userId: string) => void;
const listeners = new Set<Listener>();

/** Called after each successful markFeedSeen (Task 7 refreshes the badges then). Returns the unsubscribe. */
export function onFeedSeenChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One write at a time per user, so two writes at once never lose each other's time. */
const queues = new Map<string, Promise<unknown>>();

function laterIso(stored: string | null | undefined, nowMs: number): string {
  const s = msOf(stored);
  return new Date(s !== null && s > nowMs ? s : nowMs).toISOString();
}

async function writeSeen(userId: string, kind: FeedSeenKind, id: string | null, nowMs: number): Promise<boolean> {
  const raw = await readRaw(userId);
  if (raw === undefined) return false; // never overwrite what we couldn't read
  const cur = parseSeen(raw);
  const places = known.get(userId);
  const keep = id === null ? null : id.toLowerCase();
  const bills = pruned(cur.bills, places?.bills, places?.asOf ?? 0, kind === 'bill' ? keep : null);
  const groups = pruned(cur.groups, places?.groups, places?.asOf ?? 0, kind === 'group' ? keep : null);
  let activity = cur.activity;
  if (kind === 'activity') activity = laterIso(cur.activity, nowMs);
  else if (kind === 'bill' && keep !== null) bills[keep] = laterIso(cur.bills[keep], nowMs);
  else if (kind === 'group' && keep !== null) groups[keep] = laterIso(cur.groups[keep], nowMs);
  const next: FeedSeen = { activity, bills, groups };
  try {
    const r = await within(storage.setItem(feedSeenKey(userId), JSON.stringify(next)), GROUP_REQUEST_TIMEOUT_MS);
    if (r === TIMED_OUT) return false;
  } catch {
    return false;
  }
  for (const l of [...listeners]) {
    try {
      l(userId);
    } catch {
      // A listener's failure is its own.
    }
  }
  return true;
}

/**
 * Records that `userId` saw Activity (`markFeedSeen(userId, 'activity')`), opened a bill
 * (`'bill', billId`) or opened a group (`'group', groupId`) at `now` (ms, default Date.now()).
 * Resolves true when stored; false (never a throw) for a bad argument or a storage failure.
 */
export function markFeedSeen(userId: string, kind: FeedSeenKind, id: string | null = null, now: number = Date.now()): Promise<boolean> {
  const validId = kind === 'activity' ? id === null : isUuid(id);
  if (userId === '' || !validId || !Number.isFinite(now)) return Promise.resolve(false);
  const prev = queues.get(userId) ?? Promise.resolve();
  const run = prev.then(
    () => writeSeen(userId, kind, id, now),
    () => writeSeen(userId, kind, id, now),
  );
  const settled = run.catch(() => false);
  queues.set(userId, settled);
  void settled.then(() => {
    if (queues.get(userId) === settled) queues.delete(userId);
  });
  return settled;
}

// ---------------------------------------------------------------------------------------------
// The rule

/**
 * The start of the unread window (ms): the later of now − FEED_FIRST_RUN_DAYS and the Activity
 * seen time. The badge reads ask only for bill events after it; isFeedItemSeen applies the same floor.
 */
export function feedUnreadSince(seen: FeedSeen, now: number): number {
  const floor = now - FIRST_RUN_MS;
  const activity = msOf(seen.activity);
  return activity !== null && activity > floor ? activity : floor;
}

/**
 * Contract S: an item is seen when max(activity, place) ≥ its time, where the place is the bill's
 * time for bill items and bill milestones and the group's time for pure group items. Equal counts
 * as seen; 1 ms earlier is unseen; a missing time means "never". Anything older than the
 * 14-day floor counts as seen (FEED-29), always, so the feed's dots and the badge reads agree. An
 * item whose time can't be read counts as seen (it never lights a badge).
 */
export function isFeedItemSeen(item: Pick<FeedItem, 'at' | 'billId' | 'groupId'>, seen: FeedSeen, now: number): boolean {
  const at = feedTimeMicros(item.at);
  if (at === null) return true;
  if (at < (now - FIRST_RUN_MS) * 1000) return true;
  const place = item.billId !== null ? seen.bills[item.billId.toLowerCase()] : item.groupId !== null ? seen.groups[item.groupId.toLowerCase()] : undefined;
  const times = [msOf(seen.activity), msOf(place)].filter((t): t is number => t !== null);
  if (times.length === 0) return false;
  return Math.max(...times) * 1000 >= at;
}
