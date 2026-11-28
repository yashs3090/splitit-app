// The feed rule (spec docs/specs/2026-11-28-tab-bar-and-activity.md, Contracts F and G).
//
// `classifyFeedEvent` is the only place that decides whether a bill or group event is in the
// Activity feed, its category, whether it counts toward the badge, and which amount may be shown.
// The Activity screen, the badges and the live check all call it; nothing else filters events.
// Pure: no I/O, no clock. Never throws: anything unexpected is null (left out).
//
// Privacy is a display rule (Risk R1), not a security boundary: participants can read every event
// through RLS. An item carries only ids, item names and the one amount the table allows. Nothing
// else from `details` is copied, and payment methods / Venmo usernames are never read.

import { isSettleCents } from './paylinks';

// ---------------------------------------------------------------------------------------------
// Types

/** A `bill_events` row as Contract A selects it. */
export type FeedBillEventRow = {
  id: string;
  bill_id: string;
  actor_id: string | null;
  kind: string;
  item_name: string | null;
  details: unknown;
  created_at: string;
};

/** A `group_events` row as Contract A selects it. */
export type FeedGroupEventRow = {
  id: string;
  group_id: string;
  actor_id: string | null;
  kind: string;
  details: unknown;
  created_at: string;
};

export type FeedEventRow = FeedBillEventRow | FeedGroupEventRow;

export type FeedCategory = 'needs_you' | 'money' | 'dispute' | 'share' | 'rollup' | 'news' | 'done';
/** Derived from loaded rows (FEED-10); built in lib/feedView.ts, never by classifyFeedEvent. */
export type FeedMilestone = 'fully_claimed' | 'all_square' | 'group_settled';
/** amounts_changed keys by name only (C10), in Contract C's order. */
export type FeedAmountField = 'tip' | 'tax' | 'fees' | 'discount' | 'total';

export type FeedItem = {
  /** The event id (a milestone uses its own id). */
  id: string;
  source: 'bill' | 'group';
  kind: string;
  /** created_at as the database sent it. */
  at: string;
  /** The bill for bill events, null for group events. */
  billId: string | null;
  /** The group: a group event's own, or the bill's group_id for bill events (null if none). */
  groupId: string | null;
  actorId: string | null;
  category: FeedCategory;
  /** True exactly for needs_you, money, dispute and share. */
  counts: boolean;
  /** Only in the rows Contract F marks "amount shown"; integer cents. */
  amountCents: number | null;
  /**
   * The other person on a money line (F-c … F-g, F-r … F-t), the bill's host on F-v, or the
   * target user of a roll-up assigned / unassigned / participant_added (F-q).
   */
  counterpartId: string | null;
  /** The event's item-name snapshot, trimmed. */
  itemName: string | null;
  /** F-r only: whether the recorded payment was to me or from me. */
  direction: 'to_me' | 'from_me' | null;
  /** F-h only: which amounts changed, by name. */
  fields: readonly FeedAmountField[] | null;
  /** F-u only: the expense, for its current title from the snapshot. */
  expenseId: string | null;
  milestone: FeedMilestone | null;
};

/** One of my bills (Contract A): when I joined, its group, its host. */
export type FeedBillPlace = { joinedAt: string; groupId: string | null; hostId: string | null };
/** One of my groups (`my_groups()`): when I joined, and whether I hid it. */
export type FeedGroupPlace = { joinedAt: string; hidden: boolean };
/** A group payment, as `group_payments` or `paymentsFromEvents` gives it. */
export type FeedPayment = { from: string; to: string; cents: number };

export type FeedContext = {
  myId: string;
  /** My bills. An event on any other bill is left out. */
  bills: ReadonlyMap<string, FeedBillPlace>;
  /** My groups. An event on any other group, or a hidden one, is left out. */
  groups: ReadonlyMap<string, FeedGroupPlace>;
  /** Per bill, the trimmed names of the rows I claim now (myClaimedRowNames). Missing = none. */
  myClaims: ReadonlyMap<string, ReadonlySet<string>>;
  /** Group payments by id, for payment_undone. */
  payments: ReadonlyMap<string, FeedPayment>;
};

// ---------------------------------------------------------------------------------------------
// Kinds (exactly Contract F's table; Contract A queries `.in('kind', ...)` with these)

export const FEED_BILL_KINDS: readonly string[] = [
  'participant_added',
  'assigned',
  'marked_paid',
  'paid_difference',
  'paid_back',
  'unmarked_paid',
  'not_received',
  'amounts_changed',
  'extras_split_changed',
  'item_removed',
  'item_changed',
  'split_changed',
  'unassigned',
  'payers_changed',
  'payer_changed',
  'claimed',
  'unclaimed',
  'joined',
];

export const FEED_GROUP_KINDS: readonly string[] = [
  'payment_recorded',
  'payment_undone',
  'expense_added',
  'expense_edited',
  'expense_deleted',
  'bill_added',
  'bill_removed',
  'member_joined',
];

// ---------------------------------------------------------------------------------------------
// Parsing helpers

type Obj = Record<string, unknown>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isCount = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
/** A pay-back may end at 0 (the mark was cleared); otherwise a mark follows rule C2. */
const isMarkOrZero = (v: unknown): v is number => v === 0 || isSettleCents(v);

function trimmedName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

const TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A timestamp in microseconds since the epoch, or null. Postgres sends microseconds
 * ("…:00.123456+00:00"), which Date drops; comparing them exactly keeps "at or after joined_at"
 * right for events written in the same transaction as the join. An offset is required.
 */
export function feedTimeMicros(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = TS_RE.exec(v.trim());
  if (m === null) return null;
  const [, date, time, frac = '', rawZone = 'Z'] = m;
  let zone = rawZone.toUpperCase();
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    zone = `${zone[0] ?? '+'}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
  }
  const ms = Date.parse(`${date}T${time}${zone}`);
  if (Number.isNaN(ms)) return null;
  return ms * 1000 + Number(frac.padEnd(6, '0').slice(0, 6));
}

/** "{ user id: parts }" keys, or null when it isn't an object of uuid keys. */
function partKeys(v: unknown): string[] | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  return keys.every(isUuid) ? keys : null;
}

/** payers_changed `before` / `after`: [{ user_id }], or null. */
function payerIds(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v as unknown[]) {
    if (!isObj(x) || !isUuid(x.user_id)) return null;
    out.push(x.user_id);
  }
  return out;
}

/** payers_changed `moved`: [{ from_user, to_user }] ids, or null. */
function movedIds(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v as unknown[]) {
    if (!isObj(x) || !isUuid(x.from_user) || !isUuid(x.to_user)) return null;
    out.push(x.from_user, x.to_user);
  }
  return out;
}

function validPayment(p: FeedPayment | undefined): p is FeedPayment {
  return p !== undefined && isObj(p) && isUuid(p.from) && isUuid(p.to) && p.from !== p.to && isSettleCents(p.cents);
}

// amounts_changed keys → field names, in the order Contract C lists them ("the tip, the tax and the fees").
const AMOUNT_FIELD_KEYS: readonly (readonly [FeedAmountField, readonly string[]])[] = [
  ['tip', ['tip_cents']],
  ['tax', ['tax_cents']],
  ['fees', ['fees_cents']],
  ['discount', ['subtotal_discount_cents', 'total_discount_cents', 'discount_cents']],
  ['total', ['total_cents']],
];

// ---------------------------------------------------------------------------------------------
// The common rules

type Base = {
  id: string;
  actorId: string | null;
  kind: string;
  at: string;
  d: Obj;
};

type BillBase = Base & { source: 'bill'; billId: string; place: FeedBillPlace; itemName: string | null };
type GroupBase = Base & { source: 'group'; groupId: string };

/**
 * The checks every row shares, except "the actor is not me" (milestone triggers allow my own
 * events): a well-formed row on a place of mine, at or after my joined_at, with object details.
 */
function baseOf(e: unknown, ctx: FeedContext): BillBase | GroupBase | null {
  if (!isObj(e)) return null;
  if (!isUuid(e.id) || typeof e.kind !== 'string' || !isObj(e.details)) return null;
  if (e.actor_id !== null && !isUuid(e.actor_id)) return null;
  const at = feedTimeMicros(e.created_at);
  if (at === null) return null;
  const base: Base = { id: e.id, actorId: e.actor_id, kind: e.kind, at: e.created_at as string, d: e.details };
  if ('bill_id' in e) {
    if (!isUuid(e.bill_id)) return null;
    const place = ctx.bills.get(e.bill_id);
    if (place === undefined || !onOrAfter(at, place.joinedAt)) return null;
    if (e.item_name !== null && e.item_name !== undefined && typeof e.item_name !== 'string') return null;
    return { ...base, source: 'bill', billId: e.bill_id, place, itemName: trimmedName(e.item_name) };
  }
  if ('group_id' in e) {
    if (!isUuid(e.group_id)) return null;
    const place = ctx.groups.get(e.group_id);
    if (place === undefined || place.hidden || !onOrAfter(at, place.joinedAt)) return null;
    return { ...base, source: 'group', groupId: e.group_id };
  }
  return null;
}

function onOrAfter(atMicros: number, bound: string): boolean {
  const b = feedTimeMicros(bound);
  return b !== null && atMicros >= b;
}

// ---------------------------------------------------------------------------------------------
// classifyFeedEvent

type Verdict = {
  category: Exclude<FeedCategory, 'done'>;
  amountCents?: number;
  counterpartId?: string | null;
  direction?: 'to_me' | 'from_me';
  fields?: FeedAmountField[];
  expenseId?: string;
};

const COUNTED: ReadonlySet<FeedCategory> = new Set(['needs_you', 'money', 'dispute', 'share']);

/** Kinds whose sentence names the item: no item name is malformed. */
const NEEDS_ITEM: ReadonlySet<string> = new Set(['assigned', 'unassigned', 'item_removed', 'item_changed', 'split_changed', 'claimed', 'unclaimed']);

function billVerdict(b: BillBase, ctx: FeedContext): Verdict | null {
  const { d } = b;
  const { myId } = ctx;
  const actor = b.actorId;
  if (NEEDS_ITEM.has(b.kind) && b.itemName === null) return null;
  const myRows = ctx.myClaims.get(b.billId);
  const iClaim = myRows !== undefined && myRows.size > 0;

  switch (b.kind) {
    case 'participant_added':
    case 'assigned':
    case 'unassigned': {
      if (!isUuid(d.user_id)) return null;
      if (d.user_id === myId) return { category: b.kind === 'unassigned' ? 'share' : 'needs_you' };
      return { category: 'rollup', counterpartId: d.user_id };
    }
    case 'marked_paid':
      if (!isUuid(d.payer_id) || !isSettleCents(d.cents)) return null;
      return d.payer_id === myId ? { category: 'money', amountCents: d.cents, counterpartId: actor } : null;
    case 'paid_difference':
      if (!isUuid(d.payer_id) || !isSettleCents(d.from) || !isSettleCents(d.to) || d.to <= d.from) return null;
      return d.payer_id === myId ? { category: 'money', amountCents: d.to - d.from, counterpartId: actor } : null;
    case 'paid_back':
      if (!isUuid(d.user_id) || !isSettleCents(d.from) || !isMarkOrZero(d.to) || d.to >= d.from) return null;
      return d.user_id === myId ? { category: 'money', amountCents: d.from - d.to, counterpartId: actor } : null;
    case 'unmarked_paid':
      if (!isUuid(d.user_id) || !isSettleCents(d.cents)) return null;
      return d.user_id === myId ? { category: 'money', amountCents: d.cents, counterpartId: actor } : null;
    case 'not_received':
      if (!isUuid(d.user_id) || !isUuid(d.payer_id) || !isSettleCents(d.cents)) return null;
      return d.user_id === myId ? { category: 'dispute', amountCents: d.cents, counterpartId: actor } : null;
    case 'amounts_changed': {
      if (!iClaim) return null;
      const fields = AMOUNT_FIELD_KEYS.filter(([, keys]) => keys.some((k) => d[k] !== undefined)).map(([f]) => f);
      return { category: 'share', fields };
    }
    case 'extras_split_changed':
      return iClaim ? { category: 'share' } : null;
    case 'item_removed': {
      const ids = d.claimer_ids;
      if (!Array.isArray(ids) || !ids.every(isUuid)) return null;
      return ids.includes(myId) ? { category: 'share' } : null;
    }
    case 'item_changed': {
      if (d.price_cents === undefined && d.qty === undefined) return null;
      // A2.1: a quantity drop that removed my claim changes my share, though I no longer claim the row.
      const removed = d.removed_claimer_ids;
      if (removed !== undefined && (!Array.isArray(removed) || !removed.every(isUuid))) return null;
      if (Array.isArray(removed) && removed.includes(myId)) return { category: 'share' };
      return myRows !== undefined && b.itemName !== null && myRows.has(b.itemName) ? { category: 'share' } : null;
    }
    case 'split_changed': {
      const before = d.before === undefined || d.before === null ? [] : partKeys(d.before);
      const after = partKeys(d.after);
      if (before === null || after === null) return null;
      return before.includes(myId) || after.includes(myId) ? { category: 'share' } : { category: 'rollup' };
    }
    case 'payers_changed': {
      const before = payerIds(d.before);
      const after = payerIds(d.after);
      const moved = movedIds(d.moved);
      if (before === null || after === null || moved === null) return null;
      return [...before, ...after, ...moved].includes(myId) ? { category: 'share' } : null;
    }
    case 'payer_changed':
      if (!isUuid(d.before) || !isUuid(d.after)) return null;
      return d.before === myId || d.after === myId ? { category: 'share' } : null;
    case 'claimed':
    case 'unclaimed':
    case 'joined':
      return { category: 'rollup' };
    default:
      return null;
  }
}

function groupVerdict(g: GroupBase, ctx: FeedContext): Verdict | null {
  const { d } = g;
  const myId = ctx.myId;
  switch (g.kind) {
    case 'payment_recorded': {
      if (!isUuid(d.from) || !isUuid(d.to) || d.from === d.to || !isSettleCents(d.cents)) return null;
      if (d.to === myId) return { category: 'money', amountCents: d.cents, counterpartId: d.from, direction: 'to_me' };
      if (d.from === myId) return { category: 'money', amountCents: d.cents, counterpartId: d.to, direction: 'from_me' };
      return null;
    }
    case 'payment_undone': {
      if (!isUuid(d.payment_id)) return null;
      const p = ctx.payments.get(d.payment_id);
      if (!validPayment(p)) return null;
      if (p.from === myId && g.actorId !== null && g.actorId === p.to) {
        return { category: 'dispute', amountCents: p.cents, counterpartId: g.actorId };
      }
      if (p.from === myId) return { category: 'money', amountCents: p.cents, counterpartId: p.to };
      if (p.to === myId) return { category: 'money', amountCents: p.cents, counterpartId: p.from };
      return null;
    }
    case 'expense_added':
    case 'expense_deleted':
    case 'expense_edited': {
      if (!isUuid(d.expense_id)) return null;
      const amount = g.kind === 'expense_edited' ? (isObj(d.after) ? d.after.amount_cents : undefined) : d.amount_cents;
      if (!isSettleCents(amount)) return null;
      return { category: 'news', amountCents: amount, expenseId: d.expense_id };
    }
    case 'bill_added':
    case 'bill_removed': {
      if (!isUuid(d.bill_id)) return null;
      const host = ctx.bills.get(d.bill_id)?.hostId;
      return { category: 'news', counterpartId: host !== undefined && isUuid(host) ? host : null };
    }
    case 'member_joined':
      return { category: 'rollup' };
    default:
      return null;
  }
}

/**
 * The feed item for one event, or null when it's left out (Contract F). Common rules: the place is
 * mine (and not a hidden group), created_at ≥ my joined_at there, and the actor is not me (a null
 * actor is allowed). Pure; never throws.
 */
export function classifyFeedEvent(event: FeedEventRow, ctx: FeedContext): FeedItem | null {
  try {
    const base = baseOf(event, ctx);
    if (base === null || base.actorId === ctx.myId) return null;
    const v = base.source === 'bill' ? billVerdict(base, ctx) : groupVerdict(base, ctx);
    if (v === null) return null;
    return {
      id: base.id,
      source: base.source,
      kind: base.kind,
      at: base.at,
      billId: base.source === 'bill' ? base.billId : null,
      groupId: base.source === 'bill' ? (isUuid(base.place.groupId) ? base.place.groupId : null) : base.groupId,
      actorId: base.actorId,
      category: v.category,
      counts: COUNTED.has(v.category),
      amountCents: v.amountCents ?? null,
      counterpartId: v.counterpartId ?? null,
      itemName: base.source === 'bill' ? base.itemName : null,
      direction: v.direction ?? null,
      fields: v.fields ?? null,
      expenseId: v.expenseId ?? null,
      milestone: null,
    };
  } catch {
    return null;
  }
}

/** The trimmed names of the rows `myId` claims, from a bill's rows and claims (BillData). */
export function myClaimedRowNames(
  data: { rows: readonly { id: string; name: string }[]; claims: readonly { line_item_id: string; user_id: string }[] },
  myId: string,
): ReadonlySet<string> {
  const mine = new Set(data.claims.filter((c) => c.user_id === myId).map((c) => c.line_item_id));
  const names = new Set<string>();
  for (const row of data.rows) {
    const name = trimmedName(row.name);
    if (mine.has(row.id) && name !== null) names.add(name);
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// Milestone triggers (Contract F, "Derived milestones"). Which loaded event a milestone candidate
// sits above; lib/feedView.ts keeps or drops the candidate against the current state.

const FULLY_CLAIMED_TRIGGERS: ReadonlySet<string> = new Set([
  'claimed',
  'unclaimed',
  'assigned',
  'unassigned',
  'item_added',
  'item_removed',
  'item_changed',
  'split_changed',
]);
const MY_MONEY_KINDS: ReadonlySet<string> = new Set(['marked_paid', 'paid_difference', 'paid_back', 'unmarked_paid']);

/**
 * The milestone an event can trigger, or null. Same place and joined_at rules as
 * classifyFeedEvent, but my own events are allowed: fully claimed follows anyone's claim or item
 * change; all square follows a bill money event involving me (F-c … F-g, or my own mark); group
 * settled follows a group payment event involving me, naming the other party.
 */
export function milestoneTrigger(event: FeedEventRow, ctx: FeedContext): { milestone: FeedMilestone; counterpartId: string | null } | null {
  try {
    const base = baseOf(event, ctx);
    if (base === null) return null;
    const mine = base.actorId === ctx.myId;
    if (base.source === 'bill') {
      if (FULLY_CLAIMED_TRIGGERS.has(base.kind)) return { milestone: 'fully_claimed', counterpartId: null };
      const category = mine ? null : billVerdict(base, ctx)?.category;
      const involvesMe = mine ? MY_MONEY_KINDS.has(base.kind) : category === 'money' || category === 'dispute';
      return involvesMe ? { milestone: 'all_square', counterpartId: null } : null;
    }
    if (base.kind === 'payment_recorded') {
      const { from, to } = base.d;
      if (!isUuid(from) || !isUuid(to) || from === to) return null;
      if (from === ctx.myId) return { milestone: 'group_settled', counterpartId: to };
      if (to === ctx.myId) return { milestone: 'group_settled', counterpartId: from };
      return null;
    }
    if (base.kind === 'payment_undone') {
      const id = base.d.payment_id;
      const p = isUuid(id) ? ctx.payments.get(id) : undefined;
      if (!validPayment(p)) return null;
      if (p.from === ctx.myId) return { milestone: 'group_settled', counterpartId: p.to };
      if (p.to === ctx.myId) return { milestone: 'group_settled', counterpartId: p.from };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Filters and the badge rule

export type FeedFilter = 'all' | 'money' | 'groups';
export const FEED_FILTERS: readonly FeedFilter[] = ['all', 'money', 'groups'];

const MONEY_CATEGORIES: ReadonlySet<FeedCategory> = new Set(['money', 'dispute', 'share']);
const MONEY_MILESTONES: ReadonlySet<FeedMilestone> = new Set(['all_square', 'group_settled']);

/** Money: money, dispute, share and the two money milestones. Groups: items with a group. All: everything. */
export function inFeedFilter(item: FeedItem, filter: FeedFilter): boolean {
  if (filter === 'money') {
    return MONEY_CATEGORIES.has(item.category) || (item.category === 'done' && item.milestone !== null && MONEY_MILESTONES.has(item.milestone));
  }
  if (filter === 'groups') return item.groupId !== null;
  return true;
}

/** The place an item belongs to for the badge: its bill if it has one, else its group. */
export function feedPlaceKey(item: FeedItem): string {
  return item.billId ?? item.groupId ?? item.id;
}

/** The Activity unread count: distinct places among counted items that aren't seen (Contract S's rule, passed in). */
export function activityUnreadCount(items: readonly FeedItem[], isSeen: (item: FeedItem) => boolean): number {
  const places = new Set<string>();
  for (const item of items) {
    if (item.counts && !isSeen(item)) places.add(feedPlaceKey(item));
  }
  return places.size;
}

/** 0 (or anything that isn't a positive integer) → no badge; 1–9 → "n"; 10 or more → "9+". */
export function badgeText(n: number): string | null {
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n > 9 ? '9+' : String(n);
}

/** What a screen reader says for the badge: "9+" reads "more than 9". */
export function badgeSpokenText(n: number): string | null {
  const text = badgeText(n);
  return text === '9+' ? 'more than 9' : text;
}

// ---------------------------------------------------------------------------------------------
// Contract G: the Groups dot

export type GroupsDotContext = {
  myId: string;
  groups: ReadonlyMap<string, FeedGroupPlace>;
  /** The device-local time I last opened each group (Contract S). */
  openedAt: ReadonlyMap<string, string>;
};

const DOT_IGNORED_KINDS: ReadonlySet<string> = new Set(['renamed', 'link_rotated']);

/**
 * True when a visible group of mine has a group event by someone else (a null actor counts), not a
 * rename or link rotation, strictly after that group's opened time on this device, or else my
 * joined_at there. Never throws.
 */
export function groupsDot(events: readonly FeedGroupEventRow[], ctx: GroupsDotContext): boolean {
  for (const e of events) {
    try {
      if (!isObj(e) || !isUuid(e.group_id) || typeof e.kind !== 'string' || DOT_IGNORED_KINDS.has(e.kind)) continue;
      if (e.actor_id !== null && (!isUuid(e.actor_id) || e.actor_id === ctx.myId)) continue;
      const place = ctx.groups.get(e.group_id);
      if (place === undefined || place.hidden) continue;
      const at = feedTimeMicros(e.created_at);
      const bound = feedTimeMicros(ctx.openedAt.get(e.group_id)) ?? feedTimeMicros(place.joinedAt);
      if (at !== null && bound !== null && at > bound) return true;
    } catch {
      // A malformed row never lights the dot.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Feed order (U9, Contract A "Merge"). Defined here, a pure module, so lib/feedView.ts and
// lib/activityFeed.ts share one rule without the view reaching lib/supabase.

/**
 * created_at desc in microseconds, then id desc as a lowercase string. Negative when `a` comes
 * first. An unreadable time sorts last. Over feed items ({ at, id }).
 */
export function feedOrder(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const ta = feedTimeMicros(a.at) ?? Number.NEGATIVE_INFINITY;
  const tb = feedTimeMicros(b.at) ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta > tb ? -1 : 1;
  const ia = a.id.toLowerCase();
  const ib = b.id.toLowerCase();
  return ia === ib ? 0 : ia > ib ? -1 : 1;
}

/** feedOrder over event rows (created_at instead of at). */
export function compareFeedRows(a: Pick<FeedEventRow, 'id' | 'created_at'>, b: Pick<FeedEventRow, 'id' | 'created_at'>): number {
  return feedOrder({ at: a.created_at, id: a.id }, { at: b.created_at, id: b.id });
}
