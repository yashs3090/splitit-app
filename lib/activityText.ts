// Turns `bill_events` rows into one plain sentence each, and groups them by time for the Activity
// screen. Pure: no I/O, no clock (the caller passes `now`).
//
// Safety: every sentence is a fixed template. The only things interpolated are display names
// (from `nameOf`), item-name snapshots, quantities and `formatCents` amounts. Nothing else from
// `details` is ever shown, so a malformed or unexpected event can't put arbitrary text on screen.
// Unknown kinds and malformed details return null and the screen skips them.

import { formatCents } from './money';
import { isSettleCents } from './paylinks';

export type ActivityEvent = {
  id: string;
  kind: string;
  actorId: string | null;
  itemName: string | null;
  details: unknown;
  createdAt: string; // ISO timestamp
};

/** "You" for the viewer, the display name, "A friend" if the name is blank, "Someone" for an unknown or null id. */
export type NameOf = (userId: string | null) => string;

export type TimeLabel =
  | { kind: 'just_now' }
  | { kind: 'today'; text: string }
  | { kind: 'yesterday' }
  | { kind: 'date'; text: string };

export type TimeFormatters = { time(d: Date): string; date(d: Date): string };

export type EventGroup = { label: TimeLabel; events: ActivityEvent[] };

const SOMEONE = 'Someone';
const YOU = 'You';
const A_FRIEND = 'A friend'; // makeNameOf's name for a participant with no display name
const MAX_PARTS = 20;
const JUST_NOW_MS = 2 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------
// Parsing helpers. Each returns the parsed value, or INVALID when the shape is wrong.

const INVALID = Symbol('invalid');
type Parsed<T> = T | typeof INVALID;

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function isCount(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

function itemLabel(itemName: unknown): string | null {
  if (typeof itemName !== 'string') return null;
  const trimmed = itemName.trim();
  return trimmed === '' ? null : trimmed;
}

/** `[unit_index (0-based), group_size]`, or null/missing for no unit. */
function parseUnit(v: unknown): Parsed<{ index: number; size: number } | null> {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 2) return INVALID;
  const [index, size] = v as unknown[];
  if (!isCount(index, 0) || !isCount(size, 1) || index >= size) return INVALID;
  return { index, size };
}

type PartsEntry = { userId: string; parts: number };

/** `{ "<user id>": parts }` with integer parts 1–20. */
function parseParts(v: unknown): Parsed<PartsEntry[]> {
  if (!isPlainObject(v)) return INVALID;
  const entries: PartsEntry[] = [];
  for (const userId of Object.keys(v)) {
    const parts = v[userId];
    if (!isCount(parts, 1) || parts > MAX_PARTS) return INVALID;
    entries.push({ userId, parts });
  }
  return entries;
}

function parsePair<T>(v: unknown, ok: (x: unknown) => x is T): Parsed<[T, T]> {
  if (!Array.isArray(v) || v.length !== 2) return INVALID;
  const [a, b] = v as unknown[];
  return ok(a) && ok(b) ? [a, b] : INVALID;
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

// ---------------------------------------------------------------------------------------------
// Wording helpers.

/** "Pat", "Pat and Sam", "Pat, Sam and Ali". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function partsText(n: number): string {
  return n === 1 ? '1 part' : `${n} parts`;
}

function possessive(name: string): string {
  return name === YOU ? 'your' : `${name}'s`;
}

/** A name after a verb or preposition: "you" for the viewer, the name otherwise. */
function objectName(name: string): string {
  return name === YOU ? 'you' : name;
}

/**
 * The person a membership event is about, mid-sentence: "you", "someone" (not on the bill any
 * more, PI-17), "a friend" (no display name), or the name. objectName keeps "Someone" capitalised
 * for the older sentences, whose tests pin that wording.
 */
function targetName(name: string): string {
  if (name === YOU) return 'you';
  if (name === SOMEONE) return 'someone';
  if (name === A_FRIEND) return 'a friend';
  return name;
}

function unitSuffix(unit: { index: number; size: number } | null): string {
  return unit && unit.size > 1 ? ` (${unit.index + 1} of ${unit.size})` : '';
}

function isEven(entries: PartsEntry[]): boolean {
  return entries.every((e) => e.parts === entries[0]?.parts);
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type Namer = (userId: string | null) => string;

/** "Sam 2 parts, Alex 1 part, Pat 1 part": most parts first, then by name, so key order never matters. */
function splitText(entries: PartsEntry[], name: Namer): string {
  return entries
    .map((e) => ({ ...e, name: name(e.userId) }))
    .sort((a, b) => b.parts - a.parts || codeUnitCompare(a.name, b.name) || codeUnitCompare(a.userId, b.userId))
    .map((e) => `${e.name} ${partsText(e.parts)}`)
    .join(', ');
}

function safeNamer(nameOf: NameOf): Namer {
  return (userId) => {
    if (userId === null) return SOMEONE;
    try {
      const n = nameOf(userId);
      return typeof n === 'string' && n.trim() !== '' ? n.trim() : SOMEONE;
    } catch {
      return SOMEONE;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Per-kind sentences. Each returns null when the details are malformed.

type Ctx = { actor: string; actorId: string | null; item: string | null; d: Obj; name: Namer };

const AMOUNT_FIELDS = [
  ['tax_cents', 'the tax'],
  ['fees_cents', 'the fees'],
  ['tip_cents', 'the tip'],
  // A3: bills store a discount before the subtotal and one on the total. `discount_cents` is the
  // pre-A3 single field, still read so older events render.
  ['subtotal_discount_cents', 'the discount before the subtotal'],
  ['total_discount_cents', 'the discount on the total'],
  ['discount_cents', 'the discount'],
  ['total_cents', 'the total'],
] as const;

function extrasModeText(mode: unknown): string | null {
  if (mode === 'equal') return 'split evenly';
  if (mode === 'proportional') return 'split proportionally';
  return null;
}

function claimSentence(c: Ctx, claimed: boolean): string | null {
  if (c.item === null) return null;
  const unit = parseUnit(c.d.unit);
  if (unit === INVALID) return null;
  let tail = '';
  if (c.d.split !== undefined && c.d.split !== null) {
    const split = parseParts(c.d.split);
    if (split === INVALID) return null;
    // Only a custom split (2+ claimers, unequal parts) is worth spelling out (A2.3).
    if (split.length >= 2 && !isEven(split)) tail = `. ${c.item}${unitSuffix(unit)} is now split ${splitText(split, c.name)}.`;
  }
  const label = `${c.item}${unitSuffix(unit)}`;
  const head = claimed
    ? `${c.actor} claimed ${label}`
    : `${c.actor} removed ${c.actor === YOU ? 'your' : 'their'} claim on ${label}`;
  return head + tail;
}

function splitChangedSentence(c: Ctx): string | null {
  if (c.item === null) return null;
  const unit = parseUnit(c.d.unit);
  const before = parseParts(c.d.before);
  const after = parseParts(c.d.after);
  if (unit === INVALID || before === INVALID || after === INVALID || after.length === 0) return null;
  const label = `${c.item}${unitSuffix(unit)}`;
  if (isEven(after)) return `${c.actor} set ${label} back to an even split`;
  let was = '';
  if (before.length > 0 && isEven(before)) was = ' (was even)';
  else if (before.length > 0 && before.length <= 3) was = ` (was ${splitText(before, c.name)})`;
  return `${c.actor} changed the ${label} split: ${splitText(after, c.name)}${was}`;
}

function isIdList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x): x is string => typeof x === 'string');
}

/** " (Pat's claim was removed)", " (your and Sam's claims were removed)", or '' for nobody. */
function removedClaimsNote(ids: string[], name: Namer): string {
  if (ids.length === 0) return '';
  const whose = joinList(ids.map((id) => possessive(name(id))));
  return ` (${whose} ${ids.length === 1 ? 'claim was removed' : 'claims were removed'})`;
}

/**
 * Claimable discounts: update_bill adds `discount: true` to a discount row's item_added,
 * item_removed and item_changed. Absent means an item row; any other value is malformed.
 * Returns the words put before the row's name ("the discount ", or '' for an item).
 */
function rowPrefix(d: Obj): Parsed<string> {
  if (d.discount === undefined) return '';
  return d.discount === true ? 'the discount ' : INVALID;
}

function itemChangedSentence(c: Ctx, prefix: string): string | null {
  const head = itemChangedHead(c, prefix);
  if (head === null) return null;
  // A quantity drop that removed claimed units lists whose claims went, like item_removed.
  const removed = c.d.removed_claimer_ids;
  if (removed === undefined) return head;
  if (!isIdList(removed)) return null;
  return head + removedClaimsNote(removed, c.name);
}

function itemChangedHead(c: Ctx, prefix: string): string | null {
  if (c.item === null) return null;
  const item = prefix + c.item;
  const { d } = c;
  const name = d.name === undefined ? null : parsePair(d.name, isNonBlankString);
  const qty = d.qty === undefined ? null : parsePair(d.qty, (x): x is number => isCount(x, 1));
  const price = d.price_cents === undefined ? null : parsePair(d.price_cents, isCents);
  if (name === INVALID || qty === INVALID || price === INVALID) return null;
  if (d.note_changed !== undefined && typeof d.note_changed !== 'boolean') return null;
  const note = d.note_changed === true;

  const changes: string[] = [];
  if (name) changes.push(`name ${name[0].trim()} → ${name[1].trim()}`);
  if (qty) changes.push(`quantity ${qty[0]} → ${qty[1]}`);
  if (price) changes.push(`price ${formatCents(price[0])} → ${formatCents(price[1])}`);
  if (note) changes.push('note updated');

  if (changes.length === 0) return null;
  if (changes.length === 1) {
    if (price) return `${c.actor} changed ${item} from ${formatCents(price[0])} to ${formatCents(price[1])}`;
    if (name) return `${c.actor} renamed ${prefix}${name[0].trim()} to ${name[1].trim()}`;
    if (note) return `${c.actor} changed the note on ${item}`;
  }
  return `${c.actor} changed ${item}: ${changes.join(', ')}`;
}

function amountsChangedSentence(c: Ctx): string | null {
  const parts: string[] = [];
  for (const [key, label] of AMOUNT_FIELDS) {
    if (c.d[key] === undefined) continue;
    const pair = parsePair(c.d[key], isCents);
    if (pair === INVALID) return null;
    parts.push(`${label} from ${formatCents(pair[0])} to ${formatCents(pair[1])}`);
  }
  return parts.length === 0 ? null : `${c.actor} changed ${joinList(parts)}`;
}

// M3 settling (spec docs/specs/2026-11-24-m3-settle-venmo.md § C4). Details hold user ids and cents
// only; mark cents follow rule C2 (isSettleCents), so anything else is malformed.

function payerChangedSentence(c: Ctx): string | null {
  const { before, after, cleared } = c.d;
  if (!isUuid(before) || !isUuid(after) || !isCount(cleared, 0)) return null;
  let head: string;
  if (c.actorId === null) {
    // Only an account deletion logs this with no actor: the payer's row went, so it reverts to the host.
    head = `Who gets paid changed back to ${objectName(c.name(after))} (an account was deleted)`;
  } else if (c.actorId === after) {
    head = `${c.actor} changed who gets paid to ${c.actor === YOU ? 'yourself' : 'themselves'}`;
  } else {
    head = `${c.actor} changed who gets paid to ${objectName(c.name(after))}`;
  }
  if (cleared === 0) return head;
  return `${head} and cleared ${cleared} 'I paid' ${cleared === 1 ? 'mark' : 'marks'}`;
}

function markedPaidSentence(c: Ctx): string | null {
  const { payer_id: payerId, cents } = c.d;
  if (!isUuid(payerId) || !isSettleCents(cents)) return null;
  const they = c.actor === YOU ? 'you' : 'they';
  return `${c.actor} marked that ${they} paid ${objectName(c.name(payerId))} ${formatCents(cents)}`;
}

function unmarkedPaidSentence(c: Ctx): string | null {
  const { user_id: userId, cents } = c.d;
  if (!isUuid(userId) || !isSettleCents(cents)) return null;
  if (c.actorId !== null && c.actorId === userId) {
    return `${c.actor} undid ${c.actor === YOU ? 'your' : 'their'} 'I paid'`;
  }
  return `${c.actor} undid ${possessive(c.name(userId))} 'I paid' (${formatCents(cents)})`;
}

// Settle early and differences (spec docs/specs/2026-11-25-settle-early-and-differences.md § D8).
// Details hold one user id and the mark before and after (`from`, `to`); the amount shown is
// |to − from|. `from` is a stored mark (rule C2). `to` is a mark too, except that a pay-back may end
// at 0, which cleared the mark (A1.1). The direction must match the kind. The database never lets
// the payer be the person on either side, so an event about the actor themself is malformed.

/** A pay-back may end at 0 (the mark was cleared); otherwise `to` follows rule C2 like any mark. */
function isMarkOrZero(v: unknown): v is number {
  return v === 0 || isSettleCents(v);
}

function paidDifferenceSentence(c: Ctx): string | null {
  const { payer_id: payerId, from, to } = c.d;
  if (!isUuid(payerId) || !isSettleCents(from) || !isSettleCents(to) || to <= from) return null;
  if (c.actorId === payerId) return null;
  return `${c.actor} paid ${targetName(c.name(payerId))} ${formatCents(to - from)} more`;
}

function paidBackSentence(c: Ctx): string | null {
  const { user_id: userId, from, to } = c.d;
  if (!isUuid(userId) || !isSettleCents(from) || !isMarkOrZero(to) || to >= from) return null;
  if (c.actorId === userId) return null;
  return `${c.actor} paid ${targetName(c.name(userId))} back ${formatCents(from - to)}`;
}

// People and invites (spec docs/specs/2026-11-24-people-and-invites.md § D3). Details hold ids only.

function membershipSentence(c: Ctx, verb: 'added' | 'removed'): string | null {
  const { user_id: userId } = c.d;
  if (!isUuid(userId)) return null;
  return `${c.actor} ${verb} ${targetName(c.name(userId))}`;
}

function sentenceFor(kind: string, c: Ctx): string | null {
  const { d, actor } = c;
  switch (kind) {
    case 'bill_created': {
      if (!isCount(d.items, 0) || !isCents(d.total_cents)) return null;
      const items = d.items === 1 ? '1 item' : `${d.items} items`;
      return `${actor} created the bill (${formatCents(d.total_cents)}, ${items})`;
    }
    case 'joined':
      return `${actor} joined`;
    case 'claimed':
      return claimSentence(c, true);
    case 'unclaimed':
      return claimSentence(c, false);
    case 'split_changed':
      return splitChangedSentence(c);
    case 'item_added': {
      const prefix = rowPrefix(d);
      if (prefix === INVALID || c.item === null || !isCount(d.qty, 1) || !isCents(d.price_cents)) return null;
      // A discount row is always a single row (group_size 1), so a quantity above 1 is malformed.
      if (prefix !== '' && d.qty !== 1) return null;
      const qty = d.qty > 1 ? ` ×${d.qty}` : '';
      return `${actor} added ${prefix}${c.item}${qty} (${formatCents(d.price_cents)})`;
    }
    case 'item_removed': {
      const prefix = rowPrefix(d);
      if (prefix === INVALID || c.item === null || !isCount(d.qty, 1) || !isCents(d.price_cents)) return null;
      const ids = d.claimer_ids;
      if (!isIdList(ids)) return null;
      return `${actor} removed ${prefix}${c.item}${removedClaimsNote(ids, c.name)}`;
    }
    case 'item_changed': {
      const prefix = rowPrefix(d);
      return prefix === INVALID ? null : itemChangedSentence(c, prefix);
    }
    case 'amounts_changed':
      return amountsChangedSentence(c);
    case 'link_rotated':
      return `${actor} made a new invite link. The old one no longer works.`;
    case 'extras_split_changed': {
      const before = extrasModeText(d.before);
      const after = extrasModeText(d.after);
      if (before === null || after === null) return null;
      return `${actor} changed tax & tip to ${after}`;
    }
    case 'payer_changed':
      return payerChangedSentence(c);
    case 'marked_paid':
      return markedPaidSentence(c);
    case 'unmarked_paid':
      return unmarkedPaidSentence(c);
    case 'paid_difference':
      return paidDifferenceSentence(c);
    case 'paid_back':
      return paidBackSentence(c);
    case 'participant_added':
      return membershipSentence(c, 'added');
    case 'participant_removed':
      return membershipSentence(c, 'removed');
    case 'left':
      return `${actor} left`;
    default:
      return null;
  }
}

/** One plain sentence, or null if the kind is unknown or details are malformed (the screen skips it). Never throws. */
export function describeEvent(e: ActivityEvent, nameOf: NameOf): string | null {
  try {
    if (!isPlainObject(e) || typeof e.kind !== 'string' || !isPlainObject(e.details)) return null;
    const actorId = typeof e.actorId === 'string' ? e.actorId : null;
    if (e.actorId !== null && actorId === null) return null; // actorId of the wrong type
    const name = safeNamer(nameOf);
    return sentenceFor(e.kind, { actor: name(actorId), actorId, item: itemLabel(e.itemName), d: e.details, name });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Time grouping.

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function parseTime(createdAt: unknown): Date | null {
  if (typeof createdAt !== 'string') return null;
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Groups by local time: under 2 min ago (or slightly in the future, from clock skew) is "just now";
 * the same day is a time ("7:42 PM"); the previous day is "Yesterday"; older is a date ("Nov 18").
 * An unparseable timestamp gives `{ kind: 'date', text: '' }`.
 */
export function timeLabel(createdAt: string, now: Date, fmt: TimeFormatters): TimeLabel {
  const d = parseTime(createdAt);
  if (d === null) return { kind: 'date', text: '' };
  if (now.getTime() - d.getTime() < JUST_NOW_MS) return { kind: 'just_now' };
  if (sameLocalDay(d, now)) return { kind: 'today', text: fmt.time(d) };
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return { kind: 'yesterday' };
  return { kind: 'date', text: fmt.date(d) };
}

/** The section header for a label: "Just now", "7:42 PM", "Yesterday", "Nov 18". */
export function timeLabelText(label: TimeLabel): string {
  switch (label.kind) {
    case 'just_now':
      return 'Just now';
    case 'yesterday':
      return 'Yesterday';
    case 'today':
    case 'date':
      return label.text;
  }
}

function labelKey(label: TimeLabel): string {
  return label.kind === 'today' || label.kind === 'date' ? `${label.kind}:${label.text}` : label.kind;
}

/** Newest first, one group per label. Events with unparseable timestamps are skipped. Doesn't mutate the input. */
export function groupEvents(events: ActivityEvent[], now: Date, fmt: TimeFormatters): EventGroup[] {
  const timed = events
    .map((event) => ({ event, time: parseTime(event.createdAt) }))
    .filter((x): x is { event: ActivityEvent; time: Date } => x.time !== null)
    .sort((a, b) => b.time.getTime() - a.time.getTime() || codeUnitCompare(b.event.id, a.event.id));

  const groups: EventGroup[] = [];
  let lastKey: string | null = null;
  for (const { event } of timed) {
    const label = timeLabel(event.createdAt, now, fmt);
    const key = labelKey(label);
    const last = groups[groups.length - 1];
    if (last && key === lastKey) last.events.push(event);
    else groups.push({ label, events: [event] });
    lastKey = key;
  }
  return groups;
}

/** Device-locale formatters for the screen: "7:42 PM" and "Nov 18". Tests inject their own. */
export const defaultTimeFormatters: TimeFormatters = {
  time: (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  date: (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
};
