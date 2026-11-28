// Wording for the Activity feed (docs/specs/2026-11-28-tab-bar-and-activity.md, Contract C, day
// headers and Contract M's FEED_MARKER_TONES). Pure: no I/O, no clock (callers pass `now`).
//
// What to say is decided here; what to show is not. `classifyFeedEvent` (lib/feedRules.ts, Contract
// F) is the only place that decides inclusion, category and which amount may be shown. This module
// takes the item it built and turns it into one fixed-template sentence. The only things interpolated
// are display names, item names, expense titles and group names (cleaned of control characters), and
// `formatCents` amounts that Contract F allowed. A missing or malformed amount where a sentence needs
// one gives no line (null), never "$NaN" or an invented "$0.00".
//
// Roll-up children (C26) reuse describeEvent (lib/activityText.ts) and describeGroupEvent
// (lib/groupActivityText.ts), given a details object built only from ids.

import { describeEvent, type ActivityEvent, type TimeFormatters } from './activityText';
import type { FeedCategory } from './feedRules';
import { describeGroupEvent } from './groupActivityText';
import type { GroupEvent } from './groups';
import { rowTitle } from './homeSections';
import { formatCents } from './money';
import type { Palette } from './theme';

// ---------------------------------------------------------------------------------------------
// Types. FeedCategory is Contract F's, defined once in lib/feedRules.ts.

/** Lucide glyph names (all checked in lucide-react-native 1.80.0, Contract C). */
export type FeedGlyph = 'hand' | 'list-checks' | 'banknote' | 'circle-alert' | 'refresh-cw' | 'receipt' | 'circle-check' | 'users-round';

/**
 * What the wording needs from one feed item. Built by the view model (Task 4) from a Contract F
 * FeedItem; every field is something classifyFeedEvent already allowed to be shown.
 *
 * - `source`: 'bill' / 'group' for event rows, 'milestone' for derived lines (kind 'fully_claimed',
 *   'all_square', 'group_settled'), 'run' for a roll-up run (Contract R; children in `run`).
 * - `kind`: the event kind (both `payers_changed` and the older `payer_changed` are handled).
 * - `amountCents`: Contract F's "amount shown", absent when none.
 * - `counterpartId`: the other party (C25), or the bill's host (C21/C22).
 * - `targetId`: `details.user_id` for assigned / unassigned / participant_added.
 * - `direction`: group `payment_recorded` only: 'to_me' (C3) or 'from_me' (C7).
 * - `fields`: the `details` key names of an `amounts_changed` (C10). Key names only, never values.
 * - `expenseTitle`: the expense's current title from the group snapshot, when loaded (C18–C20).
 * - `shareCents`: Contract H's current share, or null/absent when it gives none.
 */
export type FeedTextItem = {
  source: 'bill' | 'group' | 'milestone' | 'run';
  kind: string;
  category: FeedCategory;
  actorId: string | null;
  itemName?: string | null;
  amountCents?: number | null;
  counterpartId?: string | null;
  targetId?: string | null;
  direction?: 'to_me' | 'from_me';
  fields?: readonly string[];
  expenseTitle?: string | null;
  shareCents?: number | null;
  /** source 'run': the run's items, newest first. */
  run?: readonly FeedTextItem[];
};

/** `names`: profiles `id → display_name` (Contract A). A missing id reads "Someone", a blank name "A friend". */
export type FeedTextContext = { myId: string; names: ReadonlyMap<string, string | null> };

export type FeedSentence = { text: string; glyph: FeedGlyph };

// ---------------------------------------------------------------------------------------------
// Cleaning and names.

const SOMEONE = 'Someone';
const A_FRIEND = 'A friend';
const YOU = 'You';
const A_GROUP = 'A group';

// Control characters and lone surrogates become spaces, as safeGroupNamer does in lib/activityText.ts.
// Format characters (\p{Cf}) stay: ZWJ joins emoji.
const UNPRINTABLE = /[\p{Cc}\p{Cs}]/gu;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(UNPRINTABLE, ' ').replace(/\s+/gu, ' ').trim();
  return t === '' ? null : t;
}

/** The display name for a user id, for the start of a sentence. Never throws. */
function displayName(id: string | null | undefined, ctx: FeedTextContext): string {
  if (typeof id !== 'string') return SOMEONE;
  try {
    if (!ctx.names.has(id)) return SOMEONE;
    return clean(ctx.names.get(id)) ?? A_FRIEND;
  } catch {
    return SOMEONE;
  }
}

/** The NameOf that describeEvent / describeGroupEvent expect: "You" for me. */
function nameOfFor(ctx: FeedTextContext): (id: string | null) => string {
  return (id) => (id !== null && id === ctx.myId ? YOU : displayName(id, ctx));
}

function isAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** "A", "A and B", "A, B and C". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

// ---------------------------------------------------------------------------------------------
// Per-line sentences (Contract C table).

/**
 * C10's field names, in the spec's listed order ("the tip, the tax and the fees"). "the total" only
 * when it's the only named field (FEED-44, A3.2): update_bill lists total_cents with every tip, tax
 * or fees change, so "changed the tip and the total" would say one edit twice.
 */
function fieldsText(fields: readonly string[] | undefined): string {
  const keys = new Set(fields ?? []);
  const parts: string[] = [];
  if (keys.has('tip_cents')) parts.push('the tip');
  if (keys.has('tax_cents')) parts.push('the tax');
  if (keys.has('fees_cents')) parts.push('the fees');
  if ([...keys].some((k) => k.includes('discount'))) parts.push('the discount');
  if (keys.has('total_cents') && parts.length === 0) parts.push('the total');
  return parts.length === 0 ? 'the amounts' : joinList(parts);
}

function shareClause(shareCents: number | null | undefined, word: 'is' | 'is now'): string {
  return isAmount(shareCents) ? `. Your share ${word} ${formatCents(shareCents)}` : '';
}

function money(item: FeedTextItem, make: (amount: string) => string): FeedSentence | null {
  return isAmount(item.amountCents) ? { text: make(formatCents(item.amountCents)), glyph: 'banknote' } : null;
}

function dispute(actor: string, item: FeedTextItem): FeedSentence | null {
  return isAmount(item.amountCents) ? { text: `${actor} says they didn't get your ${formatCents(item.amountCents)}`, glyph: 'circle-alert' } : null;
}

function share(text: string | null, item: FeedTextItem): FeedSentence | null {
  return text === null ? null : { text: text + shareClause(item.shareCents, 'is now'), glyph: 'refresh-cw' };
}

function billSentence(item: FeedTextItem, ctx: FeedTextContext): FeedSentence | null {
  const actor = displayName(item.actorId, ctx);
  const name = clean(item.itemName);
  if (item.category === 'rollup') return rollupChild(item, ctx);
  switch (item.kind) {
    case 'participant_added': // C1
      return { text: `${actor} added you. Claim what you had`, glyph: 'hand' };
    case 'assigned': // C2
      return name === null ? null : { text: `${actor} assigned you ${name}`, glyph: 'list-checks' };
    case 'marked_paid': // C3
      return money(item, (a) => `${actor} marked ${a} paid to you`);
    case 'paid_difference': // C4
      return money(item, (a) => `${actor} marked ${a} more paid to you`);
    case 'paid_back': // C5
      return money(item, (a) => `${actor} paid you back ${a}`);
    case 'unmarked_paid': // C6
      return money(item, (a) => `${actor} undid your ${a} payment`);
    case 'not_received': // C9
      return dispute(actor, item);
    case 'amounts_changed': // C10
      return share(`${actor} changed ${fieldsText(item.fields)}`, item);
    case 'extras_split_changed': // C11
      return share(`${actor} changed how tax and tip are split`, item);
    case 'item_removed': // C12
      return share(name === null ? null : `${actor} removed ${name}, which you'd claimed`, item);
    case 'item_changed': // C13
      return share(name === null ? null : `${actor} changed ${name}`, item);
    case 'split_changed': // C14
      return share(name === null ? null : `${actor} changed the split on ${name}`, item);
    case 'unassigned': // C15
      return share(name === null ? null : `${actor} removed you from ${name}`, item);
    case 'payers_changed': // C16
    case 'payer_changed':
      return { text: `${actor} changed who paid`, glyph: 'refresh-cw' };
    default:
      return null;
  }
}

function expenseLine(actor: string, verb: 'added' | 'deleted', item: FeedTextItem): FeedSentence | null {
  if (!isAmount(item.amountCents)) return null;
  const amount = formatCents(item.amountCents);
  const title = clean(item.expenseTitle);
  return { text: title === null ? `${actor} ${verb} an expense of ${amount}` : `${actor} ${verb} ${title}, ${amount}`, glyph: 'receipt' };
}

function receiptLine(item: FeedTextItem, ctx: FeedTextContext, tail: string): FeedSentence {
  const mine = item.counterpartId === ctx.myId;
  return { text: mine ? `Your receipt ${tail}` : `${displayName(item.counterpartId, ctx)}'s receipt ${tail}`, glyph: 'receipt' };
}

function groupSentence(item: FeedTextItem, ctx: FeedTextContext): FeedSentence | null {
  const actor = displayName(item.actorId, ctx);
  if (item.category === 'rollup') return rollupChild(item, ctx);
  switch (item.kind) {
    case 'payment_recorded': // C3 (to me) / C7 (from me)
      if (item.direction === 'to_me') return money(item, (a) => `${actor} marked ${a} paid to you`);
      if (item.direction === 'from_me') return money(item, (a) => `${actor} marked ${a} from you as received`);
      return null;
    case 'payment_undone': // C9 (F-t, dispute) / C8 (F-s)
      return item.category === 'dispute' ? dispute(actor, item) : money(item, (a) => `${actor} undid the ${a} payment`);
    case 'expense_added': // C18
      return expenseLine(actor, 'added', item);
    case 'expense_edited': {
      // C19
      const title = clean(item.expenseTitle);
      return { text: title === null ? `${actor} edited an expense` : `${actor} edited ${title}`, glyph: 'receipt' };
    }
    case 'expense_deleted': // C20
      return expenseLine(actor, 'deleted', item);
    case 'bill_added': // C21
      return receiptLine(item, ctx, 'was added');
    case 'bill_removed': // C22
      return receiptLine(item, ctx, 'was taken out');
    default:
      return null;
  }
}

function milestoneSentence(item: FeedTextItem, ctx: FeedTextContext): FeedSentence | null {
  switch (item.kind) {
    case 'fully_claimed': // C23
      return { text: `This bill is fully claimed, so totals are final${shareClause(item.shareCents, 'is')}`, glyph: 'circle-check' };
    case 'all_square': // C24
      return { text: "You're all square on this bill", glyph: 'circle-check' };
    case 'group_settled': // C25
      return {
        text: typeof item.counterpartId === 'string' ? `You and ${displayName(item.counterpartId, ctx)} are settled up` : "You're settled up",
        glyph: 'circle-check',
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Roll-ups: C26 (one item) and C27 (a run, Contract R's sentence; forming runs is lib/feedRollup.ts).

const TARGETED_KINDS = new Set(['assigned', 'unassigned', 'participant_added']);
const JOIN_KINDS = new Set(['joined', 'member_joined', 'participant_added']);

/** C26: describeEvent / describeGroupEvent, given a details object built only from ids. */
function rollupChild(item: FeedTextItem, ctx: FeedTextContext): FeedSentence | null {
  const details: Record<string, string> = {};
  if (TARGETED_KINDS.has(item.kind)) {
    if (typeof item.targetId !== 'string') return null;
    details.user_id = item.targetId;
  }
  const nameOf = nameOfFor(ctx);
  let text: string | null;
  if (item.source === 'group') {
    const e: GroupEvent = { id: '', seq: 0, actorId: item.actorId, kind: item.kind, details, createdAt: '' };
    text = describeGroupEvent(e, nameOf);
  } else {
    const e: ActivityEvent = { id: '', kind: item.kind, actorId: item.actorId, itemName: clean(item.itemName), details, createdAt: '' };
    text = describeEvent(e, nameOf);
    // describeEvent needs the parts to word a split change, and only ids may be passed, so an
    // ids-only split_changed reads as C14's head (no share clause on a roll-up line).
    if (text === null && item.kind === 'split_changed') {
      const name = clean(item.itemName);
      text = name === null ? null : `${displayName(item.actorId, ctx)} changed the split on ${name}`;
    }
  }
  return text === null ? null : { text, glyph: 'users-round' };
}

/** Contract R names: distinct people (by id), newest first. */
function runNames(ids: readonly (string | null)[], ctx: FeedTextContext): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const id of ids) {
    const key = id ?? '\u0000null';
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(displayName(id, ctx));
  }
  const [a = SOMEONE, b] = names;
  if (names.length <= 1) return a;
  if (names.length === 2) return `${a} and ${b ?? SOMEONE}`;
  const k = names.length - 2;
  return `${a}, ${b ?? SOMEONE} and ${k} ${k === 1 ? 'other' : 'others'}`;
}

function runSentence(items: readonly FeedTextItem[], ctx: FeedTextContext): FeedSentence | null {
  const [first] = items;
  if (first === undefined) return null;
  if (items.length === 1) return rollupChild(first, ctx);
  const n = items.length;
  if (items.every((i) => i.kind === 'claimed')) {
    return { text: `${runNames(items.map((i) => i.actorId), ctx)} claimed ${n} items`, glyph: 'users-round' };
  }
  if (items.every((i) => JOIN_KINDS.has(i.kind))) {
    const who = items.map((i) => (i.kind === 'participant_added' ? (i.targetId ?? null) : i.actorId));
    return { text: `${runNames(who, ctx)} joined`, glyph: 'users-round' };
  }
  return { text: `${runNames(items.map((i) => i.actorId), ctx)} made ${n} changes`, glyph: 'users-round' };
}

/**
 * The sentence and glyph for one feed line, or null when it can't be worded (unknown kind, missing
 * item name, bad amount): the view then shows no line. Never throws.
 */
export function describeFeedItem(item: FeedTextItem, ctx: FeedTextContext): FeedSentence | null {
  try {
    if (typeof item !== 'object' || item === null) return null;
    switch (item.source) {
      case 'bill':
        return billSentence(item, ctx);
      case 'group':
        return groupSentence(item, ctx);
      case 'milestone':
        return milestoneSentence(item, ctx);
      case 'run':
        return runSentence(item.run ?? [], ctx);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Places, captions and labels.

/** A bill's place: rowTitle's wording, plus " · {group name}" when the bill is in a group. */
export function billPlace(host: { hostId: string; hostName: string | null }, myId: string, groupName?: string | null): string {
  const title = rowTitle({ hostId: host.hostId, hostName: clean(host.hostName) }, myId);
  const g = clean(groupName);
  return g === null ? title : `${title} · ${g}`;
}

/** A group's place: its cleaned name ("A group" when blank). */
export function groupPlace(name: string | null | undefined): string {
  return clean(name) ?? A_GROUP;
}

function parseTime(at: unknown): Date | null {
  if (typeof at !== 'string') return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The local time of a line ("7:42 PM"), or '' for a bad timestamp. */
export function feedTime(at: string, fmt: Pick<TimeFormatters, 'time'>): string {
  const d = parseTime(at);
  return d === null ? '' : fmt.time(d);
}

/** "{place} · {time}" (just the place when the time can't be read). */
export function feedCaption(place: string, at: string, fmt: Pick<TimeFormatters, 'time'>): string {
  const time = feedTime(at, fmt);
  return time === '' ? place : `${place} · ${time}`;
}

/** "Unread. " (only when unseen) + sentence + ". " + place + ". " + time. */
export function feedLineLabel(sentence: string, place: string, time: string, unread: boolean): string {
  return `${unread ? 'Unread. ' : ''}${sentence}. ${place}. ${time}`;
}

// ---------------------------------------------------------------------------------------------
// Day headers.

export type DayHeaderFormatters = { weekday(d: Date): string; monthDay(d: Date): string; monthDayYear(d: Date): string };

export const defaultDayHeaderFormatters: DayHeaderFormatters = {
  weekday: (d) => d.toLocaleDateString(undefined, { weekday: 'long' }),
  monthDay: (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
  monthDayYear: (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local calendar days between two dates (DST-safe: compares local midnights, then rounds). */
function daysBetween(earlier: Date, later: Date): number {
  const a = new Date(earlier.getFullYear(), earlier.getMonth(), earlier.getDate()).getTime();
  const b = new Date(later.getFullYear(), later.getMonth(), later.getDate()).getTime();
  return Math.round((b - a) / DAY_MS);
}

/**
 * Local time: the same day → "Today"; the day before → "Yesterday"; 2–6 days → the weekday;
 * older → "Nov 18", or "Nov 18, 2025" in another year. A time in the future (clock skew) is "Today";
 * a bad timestamp gives ''.
 */
export function dayHeader(at: string, now: Date, fmt: DayHeaderFormatters = defaultDayHeaderFormatters): string {
  const d = parseTime(at);
  if (d === null) return '';
  const days = daysBetween(d, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 6) return fmt.weekday(d);
  return d.getFullYear() === now.getFullYear() ? fmt.monthDay(d) : fmt.monthDayYear(d);
}

// ---------------------------------------------------------------------------------------------
// Markers (Contract M). Consumed only by components/FeedMarker.tsx.

export type FeedTone = 'needs_you' | 'money' | 'dispute' | 'neutral';

export const FEED_MARKER_TONES = {
  needs_you: { fill: 'warningSurface', icon: 'warning' },
  money: { fill: 'successSurface', icon: 'success' },
  dispute: { fill: 'disputeSurface', icon: 'dispute' },
  neutral: { fill: 'surfaceMuted', icon: 'textMuted' },
} as const satisfies Record<FeedTone, { fill: keyof Palette; icon: keyof Palette }>;

/** Colour only while unread: needs_you, money and dispute keep their tone; everything else, and every read line, is neutral. */
export function feedMarkerTone(category: FeedCategory, unread: boolean): FeedTone {
  if (!unread) return 'neutral';
  return category === 'needs_you' || category === 'money' || category === 'dispute' ? category : 'neutral';
}

// ---------------------------------------------------------------------------------------------
// Screen and tab bar copy (Contract C).

export const FEED_COPY = {
  title: 'Activity',
  chips: { all: 'All', money: 'Money', groups: 'Groups' },
  loading: 'Loading activity',
  loadError: "Couldn't load your activity.",
  tryAgain: 'Try again',
  empty: {
    all: 'Nothing new. When someone adds you to a receipt or pays you, it shows up here.',
    money: 'No money activity yet.',
    groups: 'No group activity yet.',
  },
  loadingMore: 'Loading more activity',
  loadMoreError: "Couldn't load more.",
  end: "That's everything.",
} as const;

/**
 * Activity screen words the spec leaves open (Task 8, not fixed by Contract C): the chips' group
 * label and the line hints. Hints are dropped on web (react-native-web), so nothing here is needed
 * to understand a line: its label already names the place.
 */
export const FEED_SCREEN_A11Y = {
  filterGroup: 'Filter activity',
  opensBill: 'Opens the bill',
  opensGroup: 'Opens the group',
} as const;

/** The roll-up toggle's visible text and its accessibility label. */
export function rollupToggle(n: number, expanded: boolean): { text: string; label: string } {
  return expanded ? { text: 'Hide', label: 'Hide the changes' } : { text: `Show ${n}`, label: `Show the ${n} changes` };
}

export const TAB_COPY = {
  tabs: 'Tabs',
  groups: 'Groups',
  activity: 'Activity',
  profile: 'Profile',
  add: 'Add receipt',
  addLabel: 'Add receipt, opens a photo or typing the items',
} as const;

function isPositiveCount(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** "Tabs, 4 open bills" / "Tabs, 1 open bill" / "Tabs". The label carries the exact count (react-native-web drops hints). */
export function tabsTabLabel(n: number): string {
  if (!isPositiveCount(n)) return TAB_COPY.tabs;
  return `${TAB_COPY.tabs}, ${n} open ${n === 1 ? 'bill' : 'bills'}`;
}

export function groupsTabLabel(dot: boolean): string {
  return dot ? `${TAB_COPY.groups}, new activity` : TAB_COPY.groups;
}

/** "Activity, 3 new"; the "9+" badge reads "Activity, more than 9 new". */
export function activityTabLabel(n: number): string {
  if (!isPositiveCount(n)) return TAB_COPY.activity;
  return `${TAB_COPY.activity}, ${n > 9 ? 'more than 9' : n} new`;
}
