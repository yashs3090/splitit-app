// Data layer for the Activity feed and the Activity / Groups badges
// (spec docs/specs/2026-11-28-tab-bar-and-activity.md, Contracts A, S "Badge reads" and T; Amendment A1.1).
//
// Built only from existing RLS reads (FEED-1, FEED-27); no new table, column or function.
// - Every read names its columns, never `*` or a bare `.select()` (profiles has column grants).
// - Every read that can return many rows asks for an exact count and fails closed when fewer rows
//   arrive than it should (PostgREST's max_rows cuts silently; lessons 2026-11-25). Event reads
//   give an explicit order and a limit ≤ FEED_MAX_LIMIT; a page that comes back full means "maybe
//   more", never "everything" (A1.1).
// - Every call gives up after FEED_REQUEST_TIMEOUT_MS and reads as `network` (Contract T). A late
//   answer is dropped by `within`. 42501 is `not_allowed`; anything else is `network`. Never throws.
// - Which events show, their category and amounts are decided only by classifyFeedEvent
//   (lib/feedRules.ts). This file reads, pages, merges and loads the facts the rules need.
//
// Kinds read (Task 1 hand-off): bill reads add `item_added` to FEED_BILL_KINDS, because it can
// trigger the "fully claimed" milestone (it never shows as a line). Group reads ask for every kind
// the Groups dot counts (FEED_GROUP_READ_KINDS), which includes group_created and member_left that
// the feed itself leaves out; classifyFeedEvent drops those from the feed.

import { TIMED_OUT, within } from './asyncTimeout';
import { fetchSettleData, type BillData } from './bills';
import {
  activityUnreadCount,
  classifyFeedEvent,
  compareFeedRows,
  feedOrder,
  FEED_BILL_KINDS,
  FEED_GROUP_KINDS,
  feedTimeMicros,
  groupsDot,
  inFeedFilter,
  milestoneTrigger,
  myClaimedRowNames,
  type FeedBillEventRow,
  type FeedBillPlace,
  type FeedContext,
  type FeedEventRow,
  type FeedFilter,
  type FeedGroupEventRow,
  type FeedGroupPlace,
  type FeedItem,
  type FeedPayment,
} from './feedRules';
import { EMPTY_FEED_SEEN, feedUnreadSince, isFeedItemSeen, rememberFeedPlaces, type FeedSeen } from './feedSeen';
import { fetchGroupSnapshot, GROUP_REQUEST_TIMEOUT_MS, listMyGroups, type GroupSnapshot } from './groups';
import { milestoneCandidate, type FeedViewFacts } from './feedView';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------------------------
// Constants (starting values from the spec)

/** Ids per `.in()` filter; keeps URLs short (verify against hosted limits; docs/before-production.md). */
export const FEED_ID_CHUNK = 100;
/** Visible lines per page (FEED-14). */
export const FEED_PAGE_SIZE = 30;
/** Fetch rounds per page before it shows what it has (FEED-14). */
export const FEED_MAX_ROUNDS = 3;
/** bill_participants rows per range when loading my places. */
export const FEED_PLACES_PAGE = 500;
/** A1.1: no event read asks for more rows than the hosted max_rows (1000). */
export const FEED_MAX_LIMIT = 1000;
/** Contract T: the group calls' value (15 s). */
export const FEED_REQUEST_TIMEOUT_MS = GROUP_REQUEST_TIMEOUT_MS;
/** fetchSettleData takes at most 20 ids per call (lib/bills.ts SETTLE_DATA_MAX_BILLS). */
const SETTLE_BATCH = 20;

/** Bill kinds read: the feed's kinds plus `item_added`, a fully-claimed milestone trigger only. */
export const FEED_BILL_READ_KINDS: readonly string[] = [...FEED_BILL_KINDS, 'item_added'];
/**
 * Group kinds read: everything the Groups dot counts (Contract G: all but renamed and
 * link_rotated). A superset of FEED_GROUP_KINDS, so one read serves the feed and the dot.
 */
export const FEED_GROUP_READ_KINDS: readonly string[] = [
  ...FEED_GROUP_KINDS,
  ...['group_created', 'member_left'].filter((k) => !FEED_GROUP_KINDS.includes(k)),
];

const BILL_EVENT_COLUMNS = 'id, bill_id, actor_id, kind, item_name, details, created_at';
const GROUP_EVENT_COLUMNS = 'id, group_id, actor_id, kind, details, created_at';
const EXACT = { count: 'exact' } as const;

// ---------------------------------------------------------------------------------------------
// Results and helpers

export type FeedError = 'not_allowed' | 'network';
export type FeedResult<T extends object> = ({ ok: true } & T) | { ok: false; error: FeedError };

type Raw = { data: unknown; error: unknown; count?: number | null };
type Obj = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

class Failed extends Error {
  constructor(readonly error: FeedError) {
    super(error);
  }
}

function mapError(error: unknown): FeedError {
  return isObj(error) && error.code === '42501' ? 'not_allowed' : 'network';
}

/** Runs one read with the time limit. Returns its rows and count, or throws Failed. */
async function read(query: PromiseLike<Raw>): Promise<{ rows: unknown[]; count: number | null }> {
  let res: Raw | typeof TIMED_OUT;
  try {
    res = await within(Promise.resolve(query), FEED_REQUEST_TIMEOUT_MS);
  } catch {
    throw new Failed('network');
  }
  if (res === TIMED_OUT) throw new Failed('network');
  if (res.error) throw new Failed(mapError(res.error));
  if (!Array.isArray(res.data)) throw new Failed('network');
  return { rows: res.data as unknown[], count: typeof res.count === 'number' ? res.count : null };
}

/** A counted read whose whole result fits: fewer rows than the count (a cut) or no count is network. */
async function readAll(query: PromiseLike<Raw>): Promise<unknown[]> {
  const { rows, count } = await read(query);
  if (count === null || rows.length !== count) throw new Failed('network');
  return rows;
}

function chunks<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function failure(e: unknown): { ok: false; error: FeedError } {
  return { ok: false, error: e instanceof Failed ? e.error : 'network' };
}

/**
 * A timestamp as sent in a filter: ISO with microseconds and `Z` (Postgres keeps microseconds, and
 * Date would drop them, so a cursor at .123456 would skip rows tied with it). Null if unreadable.
 * Verified against the local PostgREST on 2026-11-28 (quoted and unquoted both parse).
 */
export function feedCursorIso(at: string): string | null {
  const us = feedTimeMicros(at);
  if (us === null) return null;
  const ms = Math.floor(us / 1000);
  const frac = String(us - Math.floor(us / 1_000_000) * 1_000_000).padStart(6, '0');
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac}Z`;
}

/** The merge order lives in lib/feedRules.ts (pure); re-exported for existing callers. */
export { compareFeedRows, feedOrder };

/**
 * Contract T: only the newest request of a kind applies its answer. `begin()` returns a check that
 * stays true until another `begin()` or `cancel()`. For the hooks (Tasks 7 and 8).
 */
export function newestOnly(): { begin: () => () => boolean; cancel: () => void } {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      const mine = latest;
      return () => mine === latest;
    },
    cancel() {
      latest += 1;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// My places (Contract A)

export type FeedPlaces = {
  bills: ReadonlyMap<string, FeedBillPlace>;
  /** My groups, hidden ones included and flagged (classifyFeedEvent and groupsDot leave them out). */
  groups: ReadonlyMap<string, FeedGroupPlace>;
  /** Group names from my_groups(), for captions. */
  groupNames: ReadonlyMap<string, string>;
};

/**
 * My bills (bill_participants, paged with an exact count; then their host and group from `bills`,
 * chunked) and my groups (my_groups()). Any cut-off page, failure or malformed row fails the whole
 * read: a partial list of places is never used. A bill `bills` doesn't return (I just left) is left out.
 */
export async function loadFeedPlaces(myId: string): Promise<FeedResult<{ places: FeedPlaces }>> {
  if (!isUuid(myId)) return { ok: false, error: 'not_allowed' };
  const startedAt = Date.now();
  try {
    const groupsRead = listMyGroups();

    // bill_participants: ranges of FEED_PLACES_PAGE, all against the first page's exact count.
    // Ordered by bill_id so the ranges are stable.
    const joined = new Map<string, string>();
    let total: number | null = null;
    for (let from = 0; total === null || from < total; from += FEED_PLACES_PAGE) {
      const { rows, count } = await read(
        supabase
          .from('bill_participants')
          .select('bill_id, joined_at', EXACT)
          .eq('user_id', myId)
          .order('bill_id', { ascending: true })
          .range(from, from + FEED_PLACES_PAGE - 1),
      );
      if (count === null || (total !== null && count !== total)) throw new Failed('network');
      total = count;
      if (rows.length !== Math.min(FEED_PLACES_PAGE, total - from)) throw new Failed('network');
      for (const r of rows) {
        if (!isObj(r) || !isUuid(r.bill_id) || typeof r.joined_at !== 'string' || feedTimeMicros(r.joined_at) === null) {
          throw new Failed('network');
        }
        const id = r.bill_id.toLowerCase();
        if (joined.has(id)) throw new Failed('network');
        joined.set(id, r.joined_at);
      }
    }

    const bills = new Map<string, FeedBillPlace>();
    const facts = await Promise.all(
      chunks([...joined.keys()], FEED_ID_CHUNK).map((ids) =>
        readAll(supabase.from('bills').select('id, host_id, group_id, created_at', EXACT).in('id', ids)),
      ),
    );
    for (const r of facts.flat()) {
      if (!isObj(r) || !isUuid(r.id) || !isUuid(r.host_id) || (r.group_id !== null && !isUuid(r.group_id))) throw new Failed('network');
      const id = r.id.toLowerCase();
      const joinedAt = joined.get(id);
      if (joinedAt === undefined || bills.has(id)) throw new Failed('network');
      bills.set(id, { joinedAt, groupId: r.group_id === null ? null : r.group_id.toLowerCase(), hostId: r.host_id.toLowerCase() });
    }

    const g = await groupsRead;
    if (!g.ok) throw new Failed(g.error === 'not_allowed' ? 'not_allowed' : 'network');
    const groups = new Map<string, FeedGroupPlace>();
    const groupNames = new Map<string, string>();
    for (const s of g.groups) {
      groups.set(s.id, { joinedAt: s.joinedAt, hidden: s.hidden });
      groupNames.set(s.id, s.name);
    }

    rememberFeedPlaces(myId, bills.keys(), groups.keys(), startedAt);
    return { ok: true, places: { bills, groups, groupNames } };
  } catch (e) {
    return failure(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Events (Contract A)

export type FeedSource = 'bill' | 'group';
export type FeedCursor = { at: string; id: string };

function parseEventRow(source: FeedSource, r: unknown, ids: ReadonlySet<string>, kinds: ReadonlySet<string>): FeedEventRow {
  if (!isObj(r) || !isUuid(r.id) || typeof r.kind !== 'string' || !kinds.has(r.kind)) throw new Failed('network');
  if (typeof r.created_at !== 'string' || feedTimeMicros(r.created_at) === null) throw new Failed('network');
  const placeKey = source === 'bill' ? 'bill_id' : 'group_id';
  const place = r[placeKey];
  if (!isUuid(place) || !ids.has(place.toLowerCase())) throw new Failed('network');
  // Copy only the Contract A columns. actor_id / item_name / details are checked by classifyFeedEvent.
  const base = { id: r.id, actor_id: r.actor_id as string | null, kind: r.kind, details: r.details, created_at: r.created_at };
  if (source === 'bill') {
    const row: FeedBillEventRow = { ...base, bill_id: place, item_name: r.item_name as string | null };
    return row;
  }
  const row: FeedGroupEventRow = { ...base, group_id: place };
  return row;
}

/**
 * One page of one source's events, newest first: up to `limit` rows strictly older than `cursor`
 * (keyset on (created_at, id)) and strictly newer than `since`, over `ids` in chunks of
 * FEED_ID_CHUNK. `more` is true when any chunk came back full or the merged rows were cut to
 * `limit` (A1.1: full means "maybe more"). Every chunk asks for an exact count; fewer rows than
 * min(limit, count), rows out of order, past the cursor, before `since`, on a place not asked for
 * or of a kind not asked for are network.
 */
export async function fetchEventPage(
  source: FeedSource,
  ids: readonly string[],
  kinds: readonly string[],
  cursor: FeedCursor | null,
  limit: number,
  since: string | null = null,
): Promise<FeedResult<{ rows: FeedEventRow[]; more: boolean }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) return { ok: false, error: 'network' };
  if (!ids.every(isUuid)) return { ok: false, error: 'network' };
  const cursorIso = cursor === null ? null : feedCursorIso(cursor.at);
  const sinceIso = since === null ? null : feedCursorIso(since);
  if ((cursor !== null && (cursorIso === null || !isUuid(cursor.id))) || (since !== null && sinceIso === null)) {
    return { ok: false, error: 'network' };
  }
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length === 0) return { ok: true, rows: [], more: false };
  const kindSet = new Set(kinds);
  const cursorUs = cursor === null ? null : feedTimeMicros(cursor.at);
  const sinceUs = since === null ? null : feedTimeMicros(since);
  const table = source === 'bill' ? 'bill_events' : 'group_events';
  const placeKey = source === 'bill' ? 'bill_id' : 'group_id';
  try {
    const perChunk = await Promise.all(
      chunks(unique, FEED_ID_CHUNK).map(async (chunk) => {
        let q = supabase
          .from(table)
          .select(source === 'bill' ? BILL_EVENT_COLUMNS : GROUP_EVENT_COLUMNS, EXACT)
          .in(placeKey, chunk)
          .in('kind', kinds as string[]);
        if (sinceIso !== null) q = q.gt('created_at', sinceIso);
        if (cursorIso !== null && cursor !== null) {
          q = q.or(`created_at.lt."${cursorIso}",and(created_at.eq."${cursorIso}",id.lt.${cursor.id.toLowerCase()})`);
        }
        const { rows, count } = await read(q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit));
        if (count === null || rows.length > limit || rows.length !== Math.min(limit, count)) throw new Failed('network');
        const chunkIds = new Set(chunk);
        const parsed = rows.map((r) => parseEventRow(source, r, chunkIds, kindSet));
        for (let i = 0; i < parsed.length; i++) {
          const row = parsed[i]!;
          const prev = parsed[i - 1];
          if (prev !== undefined && compareFeedRows(prev, row) >= 0) throw new Failed('network');
          const us = feedTimeMicros(row.created_at)!;
          if (cursor !== null && cursorUs !== null && compareFeedRows({ id: cursor.id, created_at: cursor.at }, row) >= 0) {
            throw new Failed('network');
          }
          if (sinceUs !== null && us <= sinceUs) throw new Failed('network');
        }
        return { parsed, full: parsed.length === limit };
      }),
    );
    const merged = perChunk.flatMap((c) => c.parsed).sort(compareFeedRows);
    if (new Set(merged.map((r) => r.id.toLowerCase())).size !== merged.length) throw new Failed('network');
    const more = perChunk.some((c) => c.full) || merged.length > limit;
    return { ok: true, rows: merged.slice(0, limit), more };
  } catch (e) {
    return failure(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Facts for a page (Contract A "Facts for a page")

/** Display names by user id. A missing id (deleted account, no longer shared) reads "Someone". */
async function loadNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const rows = (
    await Promise.all(chunks(ids, FEED_ID_CHUNK).map((c) => readAll(supabase.from('profiles').select('id, display_name', EXACT).in('id', c))))
  ).flat();
  for (const r of rows) {
    if (!isObj(r) || !isUuid(r.id) || (r.display_name !== null && typeof r.display_name !== 'string')) throw new Failed('network');
    out.set(r.id.toLowerCase(), r.display_name);
  }
  return out;
}

/** group_payments rows by id (members can read them: 20261126090704_group_payments.sql). */
async function loadPayments(ids: readonly string[]): Promise<Map<string, FeedPayment>> {
  const out = new Map<string, FeedPayment>();
  const rows = (
    await Promise.all(
      chunks(ids, FEED_ID_CHUNK).map((c) => readAll(supabase.from('group_payments').select('id, from_user, to_user, cents', EXACT).in('id', c))),
    )
  ).flat();
  for (const r of rows) {
    if (!isObj(r) || !isUuid(r.id) || !isUuid(r.from_user) || !isUuid(r.to_user) || typeof r.cents !== 'number') throw new Failed('network');
    out.set(r.id.toLowerCase(), { from: r.from_user.toLowerCase(), to: r.to_user.toLowerCase(), cents: r.cents });
  }
  return out;
}

/** BillData for bills, in batches of 20, each with the time limit. Any batch failing fails the call. */
async function loadBillData(ids: readonly string[]): Promise<Map<string, BillData>> {
  const out = new Map<string, BillData>();
  const results = await Promise.all(
    chunks(ids, SETTLE_BATCH).map(async (batch) => {
      let r: Awaited<ReturnType<typeof fetchSettleData>> | typeof TIMED_OUT;
      try {
        r = await within(fetchSettleData(batch), FEED_REQUEST_TIMEOUT_MS);
      } catch {
        throw new Failed('network');
      }
      if (r === TIMED_OUT) throw new Failed('network');
      if (!r.ok) throw new Failed(r.error === 'not_allowed' ? 'not_allowed' : 'network');
      return r.bills;
    }),
  );
  for (const m of results) for (const [id, data] of m) out.set(id.toLowerCase(), data);
  return out;
}

function paymentIdOf(row: FeedEventRow): string | null {
  if (!('group_id' in row) || row.kind !== 'payment_undone' || !isObj(row.details)) return null;
  const id = row.details.payment_id;
  return isUuid(id) ? id.toLowerCase() : null;
}

function contextOf(myId: string, places: FeedPlaces, bills: ReadonlyMap<string, BillData>, payments: ReadonlyMap<string, FeedPayment>): FeedContext {
  const myClaims = new Map<string, ReadonlySet<string>>();
  for (const [id, data] of bills) myClaims.set(id, myClaimedRowNames(data, myId));
  return { myId, bills: places.bills, groups: places.groups, myClaims, payments };
}

// ---------------------------------------------------------------------------------------------
// The feed: merge, buffer and pages (Contract A "Merge")

export type FeedFacts = {
  /** BillData per bill seen on loaded pages (claims, rows, shares, settle state). Missing: RLS hid it. */
  bills: ReadonlyMap<string, BillData>;
  payments: ReadonlyMap<string, FeedPayment>;
  /** Display names by user id (actors, counterparts, bill hosts). Missing = "Someone"; blank = "A friend". */
  names: ReadonlyMap<string, string | null>;
  /** Snapshots of groups with a group-settled candidate. Missing: not needed, or the read failed. */
  snapshots: ReadonlyMap<string, GroupSnapshot>;
};

type SourceState = { cursor: FeedCursor | null; exhausted: boolean; buffer: readonly FeedEventRow[] };

/** Everything a feed needs to continue. Immutable: a failed page leaves the state it was given usable. */
export type FeedPagerState = {
  myId: string;
  pageSize: number;
  maxRounds: number;
  /** Null until the first page loads them. */
  places: FeedPlaces | null;
  bill: SourceState;
  group: SourceState;
  facts: FeedFacts;
  /** Bills and groups whose facts were already asked for (a missing answer isn't asked again). */
  asked: { bills: ReadonlySet<string>; snapshots: ReadonlySet<string>; names: ReadonlySet<string>; payments: ReadonlySet<string> };
};

export type FeedPage = {
  /** Pass this to the next fetchFeedPage. */
  state: FeedPagerState;
  /** Every event consumed by this page, newest first, shown or not (milestone triggers; Task 4). */
  rows: FeedEventRow[];
  /** The page's lines: classified by classifyFeedEvent and inside the filter, newest first. */
  items: FeedItem[];
  /**
   * Milestone candidates (feedView's milestoneCandidate) for every consumed row, my own included,
   * inside the filter, newest first. feedView keeps or drops them against the current state.
   */
  candidates: FeedItem[];
  /** The facts in feedView's shape (accumulated over every page). Missing entry = not loaded. */
  viewFacts: FeedViewFacts;
  /** Both sources returned short pages and nothing is buffered: "That's everything." */
  end: boolean;
  /** The rule context the items were classified with (for milestoneTrigger in lib/feedView.ts). */
  ctx: FeedContext;
  places: FeedPlaces;
  /** Accumulated over every page of this feed. */
  facts: FeedFacts;
};

const EMPTY_SOURCE: SourceState = { cursor: null, exhausted: false, buffer: [] };

/** A fresh feed (a new focus, a refresh or a chip change all start here). */
export function initialFeedState(myId: string, opts: { pageSize?: number; maxRounds?: number } = {}): FeedPagerState {
  return {
    myId,
    pageSize: opts.pageSize ?? FEED_PAGE_SIZE,
    maxRounds: opts.maxRounds ?? FEED_MAX_ROUNDS,
    places: null,
    bill: EMPTY_SOURCE,
    group: EMPTY_SOURCE,
    facts: { bills: new Map(), payments: new Map(), names: new Map(), snapshots: new Map() },
    asked: { bills: new Set(), snapshots: new Set(), names: new Set(), payments: new Set() },
  };
}

/**
 * The next page of the feed for `filter`. Merges bill and group events by (created_at desc, id
 * desc), keeping fetched-but-unshown rows buffered with each source's cursor. A page is complete at
 * `pageSize` visible lines or when both sources are exhausted; after `maxRounds` fetch rounds it
 * returns what it has (not marked as the end), and scrolling continues from there. Rows the rules
 * drop still advance the cursor. Any required read failing fails the page; the given state stays
 * usable for a retry.
 */
export async function fetchFeedPage(filter: FeedFilter, state: FeedPagerState): Promise<FeedResult<{ page: FeedPage }>> {
  try {
    let places = state.places;
    if (places === null) {
      const p = await loadFeedPlaces(state.myId);
      if (!p.ok) return p;
      places = p.places;
    }
    const billIds = [...places.bills.keys()];
    const groupIds = [...places.groups].filter(([, g]) => !g.hidden).map(([id]) => id);
    const limit = Math.min(Math.max(state.pageSize, 1), FEED_MAX_LIMIT);

    const src = { bill: { ...state.bill, buffer: [...state.bill.buffer] }, group: { ...state.group, buffer: [...state.group.buffer] } };
    if (billIds.length === 0) src.bill = { cursor: null, exhausted: true, buffer: [] };
    if (groupIds.length === 0) src.group = { cursor: null, exhausted: true, buffer: [] };
    const bills = new Map(state.facts.bills);
    const payments = new Map(state.facts.payments);
    const names = new Map(state.facts.names);
    const snapshots = new Map(state.facts.snapshots);
    const asked = {
      bills: new Set(state.asked.bills),
      snapshots: new Set(state.asked.snapshots),
      names: new Set(state.asked.names),
      payments: new Set(state.asked.payments),
    };

    const consumed: FeedEventRow[] = [];
    const items: FeedItem[] = [];
    let ctx = contextOf(state.myId, places, bills, payments);

    const ready = (s: SourceState) => s.buffer.length > 0 || s.exhausted;
    const drain = () => {
      while (items.length < state.pageSize && ready(src.bill) && ready(src.group)) {
        const b = src.bill.buffer[0];
        const g = src.group.buffer[0];
        if (b === undefined && g === undefined) return;
        const takeBill = g === undefined || (b !== undefined && compareFeedRows(b, g) <= 0);
        const row = (takeBill ? src.bill.buffer : src.group.buffer).shift()!;
        consumed.push(row);
        const item = classifyFeedEvent(row, ctx);
        if (item !== null && inFeedFilter(item, filter)) items.push(item);
      }
    };

    let rounds = 0;
    for (;;) {
      drain();
      if (items.length >= state.pageSize) break;
      const need = (['bill', 'group'] as const).filter((k) => src[k].buffer.length === 0 && !src[k].exhausted);
      if (need.length === 0 || rounds >= state.maxRounds) break;
      rounds += 1;
      const fetched = await Promise.all(
        need.map((k) =>
          fetchEventPage(k, k === 'bill' ? billIds : groupIds, k === 'bill' ? FEED_BILL_READ_KINDS : FEED_GROUP_READ_KINDS, src[k].cursor, limit),
        ),
      );
      const newRows: FeedEventRow[] = [];
      need.forEach((k, i) => {
        const r = fetched[i]!;
        if (!r.ok) throw new Failed(r.error);
        const last = r.rows[r.rows.length - 1];
        src[k] = {
          cursor: last === undefined ? src[k].cursor : { at: last.created_at, id: last.id },
          exhausted: !r.more,
          buffer: r.rows,
        };
        newRows.push(...r.rows);
      });
      // Claims and group payments the rules need, before these rows are classified.
      const needBills = [...new Set(newRows.filter((r) => 'bill_id' in r).map((r) => (r as FeedBillEventRow).bill_id.toLowerCase()))].filter(
        (id) => !asked.bills.has(id),
      );
      const needPayments = [...new Set(newRows.map(paymentIdOf).filter((id): id is string => id !== null))].filter((id) => !asked.payments.has(id));
      const [billData, paymentRows] = await Promise.all([loadBillData(needBills), loadPayments(needPayments)]);
      needBills.forEach((id) => asked.bills.add(id));
      needPayments.forEach((id) => asked.payments.add(id));
      for (const [id, d] of billData) bills.set(id, d);
      for (const [id, p] of paymentRows) payments.set(id, p);
      ctx = contextOf(state.myId, places, bills, payments);
    }

    // Names and snapshots for what this page shows.
    const wantNames = new Set<string>();
    const wantSnapshots = new Set<string>();
    for (const row of consumed) {
      if (isUuid(row.actor_id)) wantNames.add(row.actor_id.toLowerCase());
      if ('bill_id' in row) {
        const host = places.bills.get(row.bill_id.toLowerCase())?.hostId;
        if (host) wantNames.add(host);
      }
      const trigger = milestoneTrigger(row, ctx);
      if (trigger?.counterpartId) wantNames.add(trigger.counterpartId.toLowerCase());
      if (trigger?.milestone === 'group_settled' && 'group_id' in row) wantSnapshots.add(row.group_id.toLowerCase());
    }
    for (const item of items) {
      if (item.counterpartId !== null) wantNames.add(item.counterpartId.toLowerCase());
      // An expense line's title comes from its group's snapshot (feedView's textItemOf).
      if (item.expenseId !== null && item.groupId !== null) wantSnapshots.add(item.groupId.toLowerCase());
    }
    const nameIds = [...wantNames].filter((id) => !asked.names.has(id));
    const snapIds = [...wantSnapshots].filter((id) => !asked.snapshots.has(id));
    const [nameRows, snaps] = await Promise.all([
      loadNames(nameIds),
      Promise.all(
        snapIds.map(async (id) => {
          const r = await fetchGroupSnapshot(id); // has its own GROUP_REQUEST_TIMEOUT_MS limit
          return r.ok ? ([id, r.snapshot] as const) : null; // optional: a failed snapshot only drops the milestone
        }),
      ),
    ]);
    nameIds.forEach((id) => asked.names.add(id));
    snapIds.forEach((id) => asked.snapshots.add(id));
    for (const [id, name] of nameRows) names.set(id, name);
    for (const s of snaps) if (s !== null) snapshots.set(s[0], s[1]);

    const facts: FeedFacts = { bills, payments, names, snapshots };
    const candidates: FeedItem[] = [];
    for (const row of consumed) {
      const c = milestoneCandidate(row, ctx);
      if (c !== null && inFeedFilter(c, filter)) candidates.push(c);
    }
    const viewFacts: FeedViewFacts = { myId: state.myId, names, bills: places.bills, groupNames: places.groupNames, billData: bills, snapshots };
    const end = src.bill.exhausted && src.group.exhausted && src.bill.buffer.length === 0 && src.group.buffer.length === 0;
    const next: FeedPagerState = { ...state, places, bill: src.bill, group: src.group, facts, asked };
    return { ok: true, page: { state: next, rows: consumed, items, candidates, end, ctx, places, facts, viewFacts } };
  } catch (e) {
    return failure(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Badge inputs (Contract S "Badge reads", Contract G)

/** F-h, F-i and F-k: kinds whose inclusion depends on my current claims on the bill. */
const CLAIM_KINDS: ReadonlySet<string> = new Set(['amounts_changed', 'extras_split_changed', 'item_changed']);

export type FeedBadgeInputs = {
  ctx: FeedContext;
  billEvents: FeedBillEventRow[];
  groupEvents: FeedGroupEventRow[];
  /** A1.1: a read came back full, so there may be more than was read ("at least"). */
  truncated: { bill: boolean; group: boolean };
};

/**
 * What the Activity badge and the Groups dot are computed from (Task 7: useFeedBadges).
 * - Bill events since max(14-day floor, Activity seen time), kinds FEED_BILL_KINDS (milestones
 *   never count, so item_added isn't needed).
 * - Group events since the later of the floor and the earliest visible group's opened time (or my
 *   joined_at there), kinds FEED_GROUP_READ_KINDS, so one read serves the Activity count and the dot.
 * - One page of FEED_MAX_LIMIT per id chunk, ordered, with an exact count; a cut-off read fails
 *   closed (the caller keeps its previous badges); a full page sets `truncated`.
 * - Claims (fetchSettleData) only for bills with an F-h / F-i / F-k event by someone else in the
 *   window (FEED-33); group payments for payment_undone.
 */
export async function fetchBadgeInputs(myId: string, seen: FeedSeen, now: number): Promise<FeedResult<{ inputs: FeedBadgeInputs }>> {
  try {
    const p = await loadFeedPlaces(myId);
    if (!p.ok) return p;
    const { places } = p;
    const floor = feedUnreadSince(EMPTY_FEED_SEEN, now);
    const billSince = new Date(feedUnreadSince(seen, now)).toISOString();
    const visibleGroups = [...places.groups].filter(([, g]) => !g.hidden);
    let groupSinceMs = Number.POSITIVE_INFINITY;
    for (const [id, g] of visibleGroups) {
      const opened = seen.groups[id] ?? g.joinedAt;
      const ms = Date.parse(opened);
      groupSinceMs = Math.min(groupSinceMs, Number.isNaN(ms) ? floor : ms);
    }
    const groupSince = new Date(Math.max(floor, Number.isFinite(groupSinceMs) ? groupSinceMs : floor)).toISOString();

    const [b, g] = await Promise.all([
      fetchEventPage('bill', [...places.bills.keys()], FEED_BILL_KINDS, null, FEED_MAX_LIMIT, billSince),
      fetchEventPage(
        'group',
        visibleGroups.map(([id]) => id),
        FEED_GROUP_READ_KINDS,
        null,
        FEED_MAX_LIMIT,
        groupSince,
      ),
    ]);
    if (!b.ok) return b;
    if (!g.ok) return g;
    const billEvents = b.rows as FeedBillEventRow[];
    const groupEvents = g.rows as FeedGroupEventRow[];

    const claimBills = [
      ...new Set(billEvents.filter((e) => CLAIM_KINDS.has(e.kind) && e.actor_id !== myId).map((e) => e.bill_id.toLowerCase())),
    ];
    const paymentIds = [...new Set(groupEvents.map(paymentIdOf).filter((id): id is string => id !== null))];
    const [billData, payments] = await Promise.all([loadBillData(claimBills), loadPayments(paymentIds)]);
    return {
      ok: true,
      inputs: {
        ctx: contextOf(myId, places, billData, payments),
        billEvents,
        groupEvents,
        truncated: { bill: b.more, group: g.more },
      },
    };
  } catch (e) {
    return failure(e);
  }
}

/** The count shown when a read was cut to its limit: badgeText(10) is "9+" (A1.1: round up, never down). */
const AT_LEAST = 10;

/**
 * The Activity unread count (distinct places among counted, unseen items; activityUnreadCount) and
 * the Groups dot (groupsDot with this device's opened times), from fetchBadgeInputs. A truncated
 * read counts as "at least": the count becomes at least 10 ("9+") when the cut-off rows can fall in
 * Activity's unread window (R7), and a truncated group read lights the dot when there is a visible group.
 */
export function feedBadges(inputs: FeedBadgeInputs, seen: FeedSeen, now: number): { activity: number; groupsDot: boolean } {
  const items: FeedItem[] = [];
  for (const e of [...inputs.billEvents, ...inputs.groupEvents]) {
    const item = classifyFeedEvent(e, inputs.ctx);
    if (item !== null) items.push(item);
  }
  let activity = activityUnreadCount(items, (item) => isFeedItemSeen(item, seen, now));
  // R7: a cut-off read counts as "at least" only if what it cut off can be unread. Rows come newest
  // first, so what's missing is no newer than the oldest row read; if that row is older than
  // Activity's unread window, everything missing is seen. (The group read can start earlier than
  // the window, for the dot; the bill read starts at the window, so its cut-off always counts.)
  const sinceMicros = feedUnreadSince(seen, now) * 1000;
  const cutInWindow = (truncated: boolean, rows: readonly FeedEventRow[]) => {
    if (!truncated) return false;
    if (rows.length === 0) return true;
    let oldest = Number.POSITIVE_INFINITY;
    for (const r of rows) {
      const us = feedTimeMicros(r.created_at);
      if (us === null) return true; // unreadable time: assume it can be unread
      oldest = Math.min(oldest, us);
    }
    return oldest >= sinceMicros;
  };
  if (cutInWindow(inputs.truncated.bill, inputs.billEvents) || cutInWindow(inputs.truncated.group, inputs.groupEvents)) {
    activity = Math.max(activity, AT_LEAST);
  }
  const openedAt = new Map(Object.entries(seen.groups));
  const anyVisible = [...inputs.ctx.groups.values()].some((g) => !g.hidden);
  const dot = (inputs.truncated.group && anyVisible) || groupsDot(inputs.groupEvents, { myId: inputs.ctx.myId, groups: inputs.ctx.groups, openedAt });
  return { activity, groupsDot: dot };
}
