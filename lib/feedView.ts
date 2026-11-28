// The Activity feed's view model (docs/specs/2026-11-28-tab-bar-and-activity.md, Task 4).
//
// feedView turns the loaded feed items (Contract F, newest first) plus the facts for them into day
// sections of ready-to-draw lines: sentence, caption, tone, glyph, unread flag, accessibility label
// and what the line opens. Components draw what it returns and do no money arithmetic (criterion 25).
// Pure: no I/O, no clock (callers pass `now`); never throws.
//
// What it decides, and nothing else:
// - Milestone candidates (FEED-10) are kept or dropped here, against the current state, through the
//   same functions the app already uses: sharesComplete (the bill screen's completeness), settle's
//   balanceFor with isSettledUp (my own balance), groupHomeStatus's `settled` kind. Only the newest candidate per
//   milestone and place is kept, and it sits directly above the event it comes from.
// - Roll-up runs (Contract R, lib/feedRollup.ts) and the share clause (Contract H, lib/feedShare.ts).
// Inclusion, category and amounts are classifyFeedEvent's (lib/feedRules.ts); wording is feedText's.
// Facts loading (fetchSettleData batches, snapshots, payment rows) is lib/activityFeed.ts's.

import type { BillData } from './bills';
import { splitInputFor } from './billView';
import { feedShareCents } from './feedShare';
import { rollUp, runIsUnseen, type FeedEntry } from './feedRollup';
import {
  feedOrder,
  feedPlaceKey,
  milestoneTrigger,
  type FeedAmountField,
  type FeedBillPlace,
  type FeedCategory,
  type FeedContext,
  type FeedEventRow,
  type FeedItem,
} from './feedRules';
import {
  billPlace,
  dayHeader,
  describeFeedItem,
  feedCaption,
  feedLineLabel,
  feedMarkerTone,
  feedTime,
  groupPlace,
  type DayHeaderFormatters,
  type FeedGlyph,
  type FeedTextContext,
  type FeedTextItem,
  type FeedTone,
} from './feedText';
import { groupHomeStatus } from './groupHomeView';
import type { GroupSnapshot } from './groups';
import { balanceFor, ledgerSettlePlan } from './settle';
import { isSettledUp } from './simplify';
import { sharesComplete } from './split';

// ---------------------------------------------------------------------------------------------
// Types

/**
 * What the view needs besides the items. Missing entries mean "not loaded": a line then reads
 * without that fact (no share clause, no expense title, "A friend's bill"), and a milestone that
 * needs it is dropped (it can't be confirmed).
 */
export type FeedViewFacts = {
  myId: string;
  /** profiles `id → display_name` (Contract A). Missing → "Someone", blank → "A friend". */
  names: ReadonlyMap<string, string | null>;
  /** My bills (Contract A's places): host and group, for the caption. */
  bills: ReadonlyMap<string, FeedBillPlace>;
  /** My groups' names (listMyGroups). */
  groupNames: ReadonlyMap<string, string>;
  /** fetchSettleData results by bill id. */
  billData: ReadonlyMap<string, BillData>;
  /** fetchGroupSnapshot results by group id. */
  snapshots: ReadonlyMap<string, GroupSnapshot>;
};

/** Contract S's rule for one item (lib/feedSeen.ts), passed in: true when seen. */
export type FeedSeenRule = (item: FeedItem) => boolean;

export type FeedViewFormatters = { time(d: Date): string } & DayHeaderFormatters;

export type FeedOpens = { bill: string } | { group: string };

export type FeedLine = {
  /** Stable React key: the item id, or "run:<newest item id>". */
  key: string;
  /** The (newest) item's created_at, as sent. */
  at: string;
  category: FeedCategory;
  sentence: string;
  /** The place part of the caption ("Maya's bill · Tahoe", "Tahoe"). */
  place: string;
  /** The local time ("7:42 PM"). */
  time: string;
  /** "{place} · {time}". */
  caption: string;
  tone: FeedTone;
  glyph: FeedGlyph;
  unread: boolean;
  /** "Unread. " (only when unseen) + sentence + ". " + place + ". " + time. */
  a11yLabel: string;
  opens: FeedOpens;
  /** A roll-up run's toggle count and its C26 children, newest first; null for every other line. */
  run: { count: number; children: { key: string; sentence: string }[] } | null;
};

export type FeedSection = { key: string; title: string; lines: FeedLine[] };

// ---------------------------------------------------------------------------------------------
// Milestone candidates

const MILESTONE_PREFIX = 'milestone';

/**
 * The milestone candidate an event can trigger (milestoneTrigger, Contract F), as a feed item:
 * category `done`, never counted, no amount, at the trigger's time and place. Its id is
 * "milestone:<kind>:<trigger event id>", so the view can place it above its trigger. My own events
 * may trigger one (they aren't feed lines themselves). Null when the event triggers nothing.
 */
export function milestoneCandidate(event: FeedEventRow, ctx: FeedContext): FeedItem | null {
  const t = milestoneTrigger(event, ctx);
  if (t === null) return null;
  const isBill = 'bill_id' in event;
  const billId = isBill ? event.bill_id : null;
  const groupId = isBill ? (ctx.bills.get(event.bill_id)?.groupId ?? null) : event.group_id;
  return {
    id: `${MILESTONE_PREFIX}:${t.milestone}:${event.id}`,
    source: isBill ? 'bill' : 'group',
    kind: t.milestone,
    at: event.created_at,
    billId,
    groupId,
    actorId: event.actor_id,
    category: 'done',
    counts: false,
    amountCents: null,
    counterpartId: t.counterpartId,
    itemName: null,
    direction: null,
    fields: null,
    expenseId: null,
    milestone: t.milestone,
  };
}

/** The trigger event id of a candidate built by milestoneCandidate. */
function triggerIdOf(item: FeedItem): string {
  const prefix = `${MILESTONE_PREFIX}:${item.milestone ?? ''}:`;
  return item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
}


/** Whether a candidate still holds against the current state (FEED-10). Never throws. */
function milestoneHolds(item: FeedItem, facts: FeedViewFacts): boolean {
  try {
    switch (item.milestone) {
      case 'fully_claimed': {
        const data = item.billId === null ? undefined : facts.billData.get(item.billId);
        return data !== undefined && sharesComplete(splitInputFor(data, data.claims)).complete;
      }
      case 'all_square': {
        const data = item.billId === null ? undefined : facts.billData.get(item.billId);
        return data !== undefined && billIsSettled(data, facts.myId);
      }
      case 'group_settled': {
        const snapshot = item.groupId === null ? undefined : facts.snapshots.get(item.groupId);
        return snapshot !== undefined && groupHomeStatus(snapshot, facts.myId)?.kind === 'settled';
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * All square (coordinator fix to contract guess 9): on a complete bill, MY own balance is settled
 * up, whoever I am (a guest who paid their share, or a payer whose owed amounts are all marked
 * paid). The plan is the one Home and Settle build (ledgerSettlePlan with early settling); the
 * balance is settle's balanceFor; "settled up" is isSettledUp (1¢) on both what I owe and what I'm
 * owed. Home's settled/hidden grouping is not used: it hides a guest who paid.
 */
function billIsSettled(data: BillData, myId: string): boolean {
  const input = splitInputFor(data, data.claims);
  if (!sharesComplete(input).complete) return false;
  const { plan } = ledgerSettlePlan(
    input,
    { payerId: data.bill.payer_id, payers: data.payers, payments: data.payments, flags: data.flags },
    { allowEarly: true },
  );
  const b = balanceFor(plan, myId);
  return b.known && b.final && isSettledUp(b.owesCents) && isSettledUp(b.owedCents);
}

/**
 * The items in feed order with the milestones resolved: candidates that no longer hold are dropped,
 * only the newest per (milestone, place) is kept, and each kept one sits directly above its trigger
 * (or, when the trigger isn't a line, where the trigger would sort).
 */
function withMilestones(items: readonly FeedItem[], facts: FeedViewFacts): FeedItem[] {
  const regular = items.filter((i) => i.milestone === null);
  const newest = new Map<string, FeedItem>();
  for (const c of items) {
    if (c.milestone === null) continue;
    const key = `${c.milestone}|${feedPlaceKey(c)}`;
    const prev = newest.get(key);
    if (prev === undefined || feedOrder({ at: c.at, id: triggerIdOf(c) }, { at: prev.at, id: triggerIdOf(prev) }) < 0) newest.set(key, c);
  }
  const kept = [...newest.values()].filter((c) => milestoneHolds(c, facts));
  const out = [...regular];
  // Insert newest-first so earlier insertions never shift a later candidate's anchor wrongly.
  kept.sort((a, b) => feedOrder({ at: a.at, id: triggerIdOf(a) }, { at: b.at, id: triggerIdOf(b) }));
  for (const c of kept) {
    const trigger = { at: c.at, id: triggerIdOf(c) };
    let at = out.findIndex((i) => i.milestone === null && feedOrder(i, trigger) >= 0);
    if (at === -1) at = out.length;
    out.splice(at, 0, c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lines

/** feedRules names amounts_changed fields; feedText reads key names (C10). */
const FIELD_KEYS: Readonly<Record<FeedAmountField, string>> = {
  tip: 'tip_cents',
  tax: 'tax_cents',
  fees: 'fees_cents',
  discount: 'discount_cents',
  total: 'total_cents',
};

const SHARE_KINDS: ReadonlySet<string> = new Set([
  'amounts_changed',
  'extras_split_changed',
  'item_removed',
  'item_changed',
  'split_changed',
  'unassigned',
]);

/** What feedText needs for one item; every field is one classifyFeedEvent allowed to be shown. */
function textItemOf(item: FeedItem, facts: FeedViewFacts): FeedTextItem {
  const billData = item.billId === null ? undefined : facts.billData.get(item.billId);
  const wantsShare = (item.category === 'share' && SHARE_KINDS.has(item.kind)) || item.milestone === 'fully_claimed';
  const expense =
    item.expenseId === null || item.groupId === null ? undefined : facts.snapshots.get(item.groupId)?.expenses.find((e) => e.id === item.expenseId);
  return {
    source: item.milestone !== null ? 'milestone' : item.source,
    kind: item.milestone ?? item.kind,
    category: item.category,
    actorId: item.actorId,
    itemName: item.itemName,
    amountCents: item.amountCents,
    // A roll-up's counterpartId is its target user (F-q); feedText reads that as targetId.
    counterpartId: item.category === 'rollup' ? null : item.counterpartId,
    targetId: item.category === 'rollup' ? item.counterpartId : facts.myId,
    ...(item.direction === null ? {} : { direction: item.direction }),
    ...(item.fields === null ? {} : { fields: item.fields.map((f) => FIELD_KEYS[f]) }),
    expenseTitle: expense?.title ?? null,
    shareCents: wantsShare ? feedShareCents(billData, facts.myId) : null,
  };
}

function placeOf(item: FeedItem, facts: FeedViewFacts): { place: string; opens: FeedOpens } {
  if (item.billId !== null) {
    const data = facts.billData.get(item.billId);
    const hostId = facts.bills.get(item.billId)?.hostId ?? data?.bill.host_id ?? '';
    const hostName = facts.names.has(hostId)
      ? (facts.names.get(hostId) ?? null)
      : (data?.participants.find((p) => p.userId === hostId)?.displayName ?? null);
    const groupName = item.groupId === null ? null : (facts.groupNames.get(item.groupId) ?? null);
    return { place: billPlace({ hostId, hostName }, facts.myId, groupName), opens: { bill: item.billId } };
  }
  const groupId = item.groupId ?? '';
  return {
    place: groupPlace(facts.groupNames.get(groupId) ?? facts.snapshots.get(groupId)?.group.name),
    opens: { group: groupId },
  };
}

type Worded = { item: FeedItem; text: FeedTextItem; sentence: string; glyph: FeedGlyph };

function lineOf(entry: FeedEntry, worded: ReadonlyMap<string, Worded>, facts: FeedViewFacts, isSeen: FeedSeenRule, fmt: FeedViewFormatters, tctx: FeedTextContext): FeedLine | null {
  const first = entry.type === 'item' ? entry.item : entry.items[0];
  if (first === undefined) return null;
  let sentence: string;
  let glyph: FeedGlyph;
  let unread: boolean;
  let run: FeedLine['run'] = null;
  if (entry.type === 'item') {
    const w = worded.get(entry.item.id);
    if (w === undefined) return null;
    sentence = w.sentence;
    glyph = w.glyph;
    unread = !isSeen(entry.item);
  } else {
    const children = entry.items.map((i) => worded.get(i.id)).filter((w): w is Worded => w !== undefined);
    const s = describeFeedItem({ source: 'run', kind: 'run', category: 'rollup', actorId: first.actorId, run: children.map((c) => c.text) }, tctx);
    if (s === null) return null;
    sentence = s.text;
    glyph = s.glyph;
    unread = runIsUnseen(entry, isSeen);
    run = { count: children.length, children: children.map((c) => ({ key: c.item.id, sentence: c.sentence })) };
  }
  const { place, opens } = placeOf(first, facts);
  const time = feedTime(first.at, fmt);
  return {
    key: entry.type === 'item' ? first.id : `run:${first.id}`,
    at: first.at,
    category: first.category,
    sentence,
    place,
    time,
    caption: feedCaption(place, first.at, fmt),
    tone: feedMarkerTone(first.category, unread),
    glyph,
    unread,
    a11yLabel: feedLineLabel(sentence, place, time, unread),
    opens,
    run,
  };
}

/**
 * The Activity screen's day sections. `items` are every loaded feed item in feed order (newest
 * first), milestone candidates included anywhere among them; `isSeen` is Contract S's rule as read
 * before this visit's markFeedSeen. Items that can't be worded are dropped (never a broken line).
 * Pass all pages' items together: runs are re-formed across page boundaries (Contract R).
 */
export function feedView(
  items: readonly FeedItem[],
  facts: FeedViewFacts,
  isSeen: FeedSeenRule,
  now: Date,
  fmt: FeedViewFormatters,
): FeedSection[] {
  const tctx: FeedTextContext = { myId: facts.myId, names: facts.names };
  const safeSeen: FeedSeenRule = (i) => {
    try {
      return isSeen(i);
    } catch {
      return false;
    }
  };
  const ordered = withMilestones(items, facts);
  const worded = new Map<string, Worded>();
  const wordable: FeedItem[] = [];
  for (const item of ordered) {
    try {
      const text = textItemOf(item, facts);
      const s = describeFeedItem(text, tctx);
      if (s === null || worded.has(item.id)) continue;
      worded.set(item.id, { item, text, sentence: s.text, glyph: s.glyph });
      wordable.push(item);
    } catch {
      // Left out: no line beats a wrong one.
    }
  }
  const sections: FeedSection[] = [];
  for (const entry of rollUp(wordable)) {
    let line: FeedLine | null;
    try {
      line = lineOf(entry, worded, facts, safeSeen, fmt, tctx);
    } catch {
      line = null;
    }
    if (line === null) continue;
    const title = dayHeader(line.at, now, fmt);
    const last = sections[sections.length - 1];
    if (last !== undefined && last.title === title) last.lines.push(line);
    else sections.push({ key: `day:${line.key}`, title, lines: [line] });
  }
  return sections;
}
