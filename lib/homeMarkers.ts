// Home's per-row marker and the "added you to a bill" notice: pure, no I/O.
// Spec: docs/specs/2026-11-24-bill-markers-and-notices.md D4 (K1, K2), and the settle markers of
// docs/specs/2026-11-25-settle-early-and-differences.md D7 (Task 7, A1.10, A1.24).
//
// 'new' and 'unclaimed' read the facts my_bills() returns. "Complete" is the database's
// private.bill_is_complete (`summary.complete`), never re-derived here (BM-6). Settle markers read
// the entries of the bill's settle plan (lib/settle.ts: role, mark, canSettle, difference), the same
// plan the Settle screen's cards come from, so there's no second rule. No money arithmetic: amounts
// and counts are read off the plan and formatted.
//
// Sent via Venmo (docs/specs/2026-11-26-sent-via-venmo.md D7, Task 7): 'sent' (the payer's unseen
// sends, only while someone still owes them), 'not_received' (the payer cleared your mark) and
// 'waiting_on_others' (you've claimed, the bill can't give amounts yet). Still pure: "unseen" compares
// the mark's time with summary.seenAt, never the clock (no age-off, U-A1.5).
//
// Who paid (docs/specs/2026-11-26-who-paid.md D9 last bullet, A1.2, A1.5; Task 8): the plan may be a
// 'routes' plan (several payers, or money that moved between other people) or 'blocked_payers' (a
// split that no longer adds up). Routes markers read the viewer's pairs (contract T): pairs `from`
// the viewer are what they owe, pairs `to` them what they're owed; the same kinds and copy as one
// payer, with the counterparty's name in "You owe Hana $33.40". 'blocked_payers' gives
// 'waiting_on_others' to everyone on the bill, with the host's copy "Fix who paid" (no new marker
// kind, so Home's groups table is unchanged: both are "Waiting on you", D10).
import type { BillSummary } from './bills';
import { billListLabel, formatShortDate, type NameOf } from './billView';
import { formatCents } from './money';
import { methodOwnPill, type PaymentMethod } from './paymentMethods';
import {
  differenceOf,
  type BillSettlePlan,
  type SettleEarlyEntry,
  type SettleEntry,
  type SettlePlanWithEarly,
  type SettleRoutes,
} from './settle';
import type { Pair } from './transfers';

/** The markers that need no settle data (K1). */
export type BillMarker = 'new' | 'unclaimed';
/** D7 H1–H7, in that order. */
export type SettleMarker =
  | 'owes'
  | 'paid'
  | 'paid_more'
  | 'paid_back_due'
  | 'left_to_pay'
  | 'differences'
  | 'settled'
  /** The payer has an unseen "Sam sent you $15.10", and someone still owes them ("Owed to you"). */
  | 'sent'
  /** The payer said your mark never arrived, and you haven't marked again ("Waiting on you"). */
  | 'not_received'
  /**
   * You've claimed, but the bill can't give amounts yet: blocked or all-$0 ("Waiting on you"). Also
   * everyone on a 'blocked_payers' bill: the host's pill is "Fix who paid", others' "Who paid is
   * being updated" (who-paid D9).
   */
  | 'waiting_on_others';
export type HomeMarker = BillMarker | SettleMarker;

/** The facts billMarker reads. */
type MarkerFacts = Pick<BillSummary, 'hostId' | 'payerId' | 'added' | 'seen' | 'claimedAny' | 'complete' | 'seenAt'>;
/** What "unseen" reads (D7, F9). */
type SeenFacts = Pick<BillSummary, 'seen' | 'seenAt'>;
/** What billMarkerView reads from the summary: the seen facts, and the host for 'blocked_payers'. */
type ViewFacts = SeenFacts & { hostId?: string | undefined };

/**
 * K1 + D7: the one marker a Home row gets, first match wins.
 * 1. 'new': someone else hosts it, they added you, and you haven't opened it or dismissed its notice.
 * 2. 'unclaimed': you're neither host nor payer, have no claims, and the bill isn't complete
 *    (so it never contradicts settle's "You owe" / "nothing to pay", which need a complete bill).
 * 3. A settle marker, when the bill's settle plan is given (settleMarker). The host skips 1–2 but
 *    reaches this step (A1.10). Without a plan the result is exactly today's.
 * 4. 'waiting_on_others': no settle marker, the plan is blocked or all-$0, you aren't the payer, and
 *    you've claimed something (sent-via-Venmo D7, groups v2 D-1).
 */
export function billMarker(summary: MarkerFacts, myId: string): BillMarker | null;
export function billMarker(summary: MarkerFacts, myId: string, plan: BillSettlePlan | null | undefined): HomeMarker | null;
export function billMarker(summary: MarkerFacts, myId: string, plan?: BillSettlePlan | null): HomeMarker | null {
  if (summary.hostId !== myId) {
    if (summary.added && !summary.seen) return 'new';
    if (summary.payerId !== myId && !summary.claimedAny && !summary.complete) return 'unclaimed';
  }
  if (!plan) return null;
  if (plan.status === 'blocked_payers') return 'waiting_on_others'; // who-paid D9: host and others alike
  return settleMarker(plan, myId, summary) ?? (waitingOnOthers(summary, myId, plan) ? 'waiting_on_others' : null);
}

/** D7: claimed, not the payer, and the plan can't give amounts yet. */
function waitingOnOthers(summary: Pick<BillSummary, 'payerId' | 'claimedAny'>, myId: string, plan: BillSettlePlan): boolean {
  return blockedForAmounts(plan) && summary.payerId !== myId && summary.claimedAny;
}

function blockedForAmounts(plan: BillSettlePlan): boolean {
  return plan.status === 'blocked' || plan.status === 'blocked_all_zero';
}

type PlanEntry = SettleEntry | SettleEarlyEntry;

/** Entries with a non-null difference: the `d` the payer card counts (D6, D7). */
function differenceCount(people: readonly PlanEntry[]): number {
  return people.filter((e) => differenceOf(e) !== null).length;
}

/**
 * D7 (F9): a mark is unseen when the viewer has never opened the bill (`seenAt` null and `seen`
 * false), or it's strictly newer than their last open. Parsed milliseconds, so two spellings of one
 * instant compare equal. An unparsable time is never newer (NaN > x is false): no pill on bad data.
 */
function isUnseen(at: string, seen: SeenFacts): boolean {
  if (seen.seenAt === null) return !seen.seen;
  return Date.parse(at) > Date.parse(seen.seenAt);
}

/** The other people whose mark to the viewer is unseen, in plan order (§11: by `toUserId`, not role). */
function unseenSenders(people: readonly PlanEntry[], myId: string, seen: SeenFacts): PlanEntry[] {
  return people.filter((e) => e.userId !== myId && e.mark !== null && e.mark.toUserId === myId && isUnseen(e.mark.at, seen));
}

/** U-A1.6: someone other than the viewer still has a positive share and no mark. */
function someoneUnmarkedOwes(people: readonly PlanEntry[], myId: string): boolean {
  return people.some((e) => e.userId !== myId && e.role === 'owes' && e.mark === null);
}

export type SentUpdate = { userId: string; name: string; cents: number; method: PaymentMethod; at: string };
/** D7: the payer's unseen sends, newest first. */
export type SentFacts = { billId: string; senders: SentUpdate[]; newestAt: string };

/** "Someone" for a blank name (D7 copy table). */
function displayName(nameOf: NameOf, userId: string): string {
  const name = nameOf(userId).trim();
  return name === '' ? 'Someone' : name;
}

/**
 * D7: who sent the viewer money they haven't seen yet, newest first (ties keep plan order), or null
 * when nobody has. It doesn't decide whether the 'sent' pill shows: billMarker adds "someone still
 * owes you" (U-A1.6).
 */
export function sentFacts(
  summary: Pick<BillSummary, 'id'> & SeenFacts,
  plan: BillSettlePlan,
  myId: string,
  nameOf: NameOf,
): SentFacts | null {
  const senders: SentUpdate[] = [];
  if (plan.status === 'routes') {
    for (const q of unseenIncoming(plan, myId, summary)) {
      if (q.mark === null) continue; // narrows; unseenIncoming keeps marked pairs only
      senders.push({ userId: q.fromId, name: displayName(nameOf, q.fromId), cents: q.mark.cents, method: q.mark.method, at: q.mark.at });
    }
  } else if (plan.status === 'ready' || plan.status === 'early') {
    const people: readonly PlanEntry[] = plan.people;
    for (const e of unseenSenders(people, myId, summary)) {
      if (e.mark === null) continue; // narrows; unseenSenders keeps marked entries only
      senders.push({ userId: e.userId, name: displayName(nameOf, e.userId), cents: e.mark.cents, method: e.mark.method, at: e.mark.at });
    }
  } else {
    return null;
  }
  senders.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // stable: equal times keep plan order
  const [newest] = senders;
  return newest === undefined ? null : { billId: summary.id, senders, newestAt: newest.at };
}

/**
 * D7 H1–H7 plus 'sent' and 'not_received' from the plan's entries, or null (the "—" row). `seen` is
 * the summary's seen facts; without them (billMarkerView called with no summary) 'sent' never applies.
 */
function settleMarker(plan: BillSettlePlan, myId: string, seen: SeenFacts | null): SettleMarker | null {
  if (plan.status === 'routes') return routesMarker(plan, myId, seen);
  if (plan.status !== 'ready' && plan.status !== 'early') return null;
  const people: readonly PlanEntry[] = plan.people;
  const me = people.find((e) => e.userId === myId);
  if (me === undefined) return null;

  if (me.role === 'payer') {
    // 'sent' replaces only a result where someone still owes the payer: H5, or the early null.
    const sent = seen !== null && unseenSenders(people, myId, seen).length > 0;
    if (plan.status !== 'ready') return sent && someoneUnmarkedOwes(people, myId) ? 'sent' : null; // HM-4 otherwise
    const d = differenceCount(people);
    if (plan.paidCount < plan.owingCount) return sent ? 'sent' : 'left_to_pay'; // H5: someone owing is unmarked
    if (d > 0) return 'differences'; // H6, including owingCount 0 (A1.8)
    if (plan.owingCount > 0) return 'settled'; // H7 (allPaid holds here), whatever the seen state (U-A1.6)
    return null;
  }

  if (me.mark !== null) {
    if (plan.status === 'early') return 'paid'; // H2: early differences are settled after completion
    const diff = differenceOf(me);
    if (diff === null) return 'paid';
    return diff.kind === 'more' ? 'paid_more' : 'paid_back_due';
  }
  if (me.role !== 'owes') return null;
  if (me.notReceived !== null && me.notReceived.toUserId === plan.payerId) return 'not_received'; // D4, before H1
  if (plan.status === 'early' && !('canSettle' in me && me.canSettle)) return null;
  return 'owes'; // H1
}

// ---------------------------------------------------------------------------
// Who paid: markers on a 'routes' plan (Task 8). A pair with paidCents ≤ 0 is unpaid (its remaining
// is > 0: contract T orients pairs so target ≥ 0, and drops target 0 with nothing paid); a pair with
// paidCents > 0 is marked, and its `difference` is contract D's (null within tolerance). No money
// arithmetic beyond summing the pairs' own cents for a pill.
// ---------------------------------------------------------------------------

/** The viewer's pairs: what they owe (`out`) and what they're owed (`in`), in plan order. */
type MyPairs = { out: Pair[]; in: Pair[] };

function myPairs(plan: SettleRoutes, myId: string): MyPairs {
  return { out: plan.pairs.filter((q) => q.fromId === myId), in: plan.pairs.filter((q) => q.toId === myId) };
}

const isUnpaid = (q: Pair) => q.paidCents <= 0;

/** The viewer's unpaid routes that carry the recipient's "Not received" flag (A1.3: one per pair). */
function notReceivedPairs(plan: SettleRoutes, out: readonly Pair[]): { pair: Pair; cents: number }[] {
  const found: { pair: Pair; cents: number }[] = [];
  for (const q of out) {
    if (!isUnpaid(q)) continue;
    const flag = plan.flags.find((f) => f.fromId === q.fromId && f.toId === q.toId);
    if (flag !== undefined) found.push({ pair: q, cents: flag.cents });
  }
  return found;
}

/** Marked pairs to the viewer whose mark is unseen (D7, F9). */
function unseenIncoming(plan: SettleRoutes, myId: string, seen: SeenFacts): Pair[] {
  return myPairs(plan, myId).in.filter((q) => q.mark !== null && isUnseen(q.mark.at, seen));
}

/**
 * The routes marker, first match wins. What the viewer must do comes first ("Waiting on you"):
 *   1. 'not_received': an unpaid route of theirs carries the recipient's flag;
 *   2. 'owes': an unpaid route of theirs (early plans: only if they may settle early, rule E);
 *   3. 'paid_more': a marked route of theirs short by more than the tolerance (not on early plans).
 * Then, if anyone pays them (any pair to them), the payer's markers over those pairs:
 *   4. early: 'sent' when there's an unseen send and someone still hasn't paid them (HM-4), else
 *      on to their own routes below;
 *   5. someone still owes them: 'sent' if unseen, else 'left_to_pay';
 *   6. a difference on any of their pairs: 'differences';
 *   7. 'settled'.
 * Otherwise, their own marked routes: 'paid_back_due' with a 'back' difference (complete plans), else
 * 'paid'. Nothing at all (no pairs, or not on the bill): null.
 */
function routesMarker(plan: SettleRoutes, myId: string, seen: SeenFacts | null): SettleMarker | null {
  const me = plan.people.find((p) => p.userId === myId);
  if (me === undefined) return null;
  const early = plan.early !== null;
  const { out, in: incoming } = myPairs(plan, myId);

  if (out.some(isUnpaid) && (!early || me.canSettle)) {
    return notReceivedPairs(plan, out).length > 0 ? 'not_received' : 'owes';
  }
  if (!early && out.some((q) => q.difference?.kind === 'more')) return 'paid_more';

  if (incoming.length > 0) {
    const sent = seen !== null && unseenIncoming(plan, myId, seen).length > 0;
    const someoneOwes = incoming.some(isUnpaid);
    if (early) {
      if (sent && someoneOwes) return 'sent';
    } else if (someoneOwes) {
      return sent ? 'sent' : 'left_to_pay';
    }
  }
  if (incoming.length > 0 && !early) {
    if ([...out, ...incoming].some((q) => q.difference !== null)) return 'differences';
    return 'settled';
  }

  const marked = out.filter((q) => !isUnpaid(q));
  if (marked.length === 0) return null;
  if (!early && marked.some((q) => q.difference?.kind === 'back')) return 'paid_back_due';
  return 'paid';
}

/** Larger amount first, then by name, then by id (the Settle cards' order, A1.5). */
function byAmountThenName(rows: { name: string; id: string; cents: number }[]) {
  return [...rows].sort((a, b) => b.cents - a.cents || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "Hana", "Hana and Dee", "Hana, Dee and Eve". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** One method when every mark shares it, else 'other' (the plain "Paid"). */
function sharedMethod(pairs: readonly Pair[]): PaymentMethod {
  const [first, ...rest] = pairs.map((q) => q.mark?.method ?? 'other');
  return first !== undefined && rest.every((m) => m === first) ? first : 'other';
}

const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

/** The pill for a routes marker; null when the plan doesn't give that marker for the viewer. */
function routesView(marker: SettleMarker, plan: SettleRoutes, ctx: MarkerViewContext): MarkerView | null {
  const { viewerId } = ctx;
  if (routesMarker(plan, viewerId, ctx.summary ?? null) !== marker) return null;
  const { out, in: incoming } = myPairs(plan, viewerId);
  const name = (id: string) => displayName(ctx.nameOf, id);

  switch (marker) {
    case 'owes': {
      const rows = byAmountThenName(out.filter(isUnpaid).map((q) => ({ id: q.toId, name: name(q.toId), cents: q.remainingCents })));
      const [one] = rows;
      if (one === undefined) return null;
      if (rows.length === 1) {
        const text = `You owe ${one.name} ${formatCents(one.cents)}`;
        return { pill: text, a11y: text, tone: 'accent', icon: null };
      }
      const text = `You owe ${rows.length} people ${formatCents(sum(rows.map((r) => r.cents)))}`;
      return { pill: text, a11y: `${text}: ${rows.map((r) => `${r.name} ${formatCents(r.cents)}`).join(', ')}`, tone: 'accent', icon: null };
    }
    case 'not_received': {
      const [first] = notReceivedPairs(plan, out);
      if (first === undefined) return null;
      const amount = formatCents(first.cents);
      return { pill: `Not received · ${amount}`, a11y: `${name(first.pair.toId)} hasn't received your ${amount}`, tone: 'accent', icon: null };
    }
    case 'paid_more': {
      const short = out.filter((q) => q.difference?.kind === 'more');
      const amount = formatCents(sum(short.map((q) => q.difference?.cents ?? 0)));
      const verb = ownVerb(sharedMethod(short));
      return { pill: `${verb} · ${amount} more to pay`, a11y: `${verb}, you owe ${amount} more`, tone: 'accent', icon: null };
    }
    case 'paid_back_due': {
      const over = out.filter((q) => q.difference?.kind === 'back');
      const amount = formatCents(sum(over.map((q) => q.difference?.cents ?? 0)));
      const who = nameList([...new Set(over.map((q) => q.toId))].map(name));
      const verb = over.length === 1 ? 'owes' : 'owe';
      return { pill: `You are owed ${amount}`, a11y: `You are owed ${amount}: ${who} ${verb} you ${amount} back`, tone: 'muted', icon: null };
    }
    case 'paid': {
      const marked = out.filter((q) => !isUnpaid(q));
      if (marked.length === 0) return null;
      const text = methodOwnPill(sharedMethod(marked), sum(marked.map((q) => q.paidCents)));
      return { pill: text, a11y: text, tone: 'muted', icon: 'check' };
    }
    case 'left_to_pay': {
      const left = incoming.filter(isUnpaid).length;
      return { pill: peopleLeft(left), a11y: peopleStillOwe(left), tone: 'muted', icon: null };
    }
    case 'differences': {
      const text = differencesToSettle([...out, ...incoming].filter((q) => q.difference !== null).length);
      return { pill: text, a11y: text, tone: 'accent', icon: null };
    }
    case 'settled':
      return { pill: 'Settled up', a11y: 'Settled up, everyone has settled up with you', tone: 'muted', icon: 'check' };
    case 'sent': {
      if (ctx.summary === undefined) return null; // routesMarker said 'sent' only with it; narrows
      const facts = sentFacts({ id: '', ...ctx.summary }, plan, viewerId, ctx.nameOf);
      return facts === null ? null : sentView(facts.senders);
    }
    case 'waiting_on_others':
      return null; // never a routes marker
  }
}

/** K1: the pill's visible text, and what the row's screen-reader label gains. */
export const BILL_MARKER_COPY: Readonly<Record<BillMarker, { readonly pill: string; readonly a11y: string }>> = {
  new: { pill: 'New', a11y: "New, you haven't opened it yet" },
  unclaimed: { pill: 'Nothing claimed yet', a11y: "You haven't claimed anything yet" },
};

/** SE-VIS-1: Home pills have two tones only. */
export type MarkerTone = 'accent' | 'muted';
/**
 * A pill's words, tone and icon. Strings carry no glyph (A1.22); `icon: 'check'` marks a "done" pill,
 * and whether Home draws it is open question Q-GLYPH.
 */
export type MarkerView = { pill: string; a11y: string; tone: MarkerTone; icon: 'check' | null };
/**
 * `summary` carries the seen facts 'sent' needs (D7). Without it billMarkerView('sent') is null, and
 * the other markers read as before.
 */
export type MarkerViewContext = {
  plan: BillSettlePlan | null | undefined;
  viewerId: string;
  nameOf: NameOf;
  /** The seen facts ('sent'), and `hostId` for a 'blocked_payers' plan (absent → the guests' copy). */
  summary?: ViewFacts | undefined;
};

const peopleLeft = (n: number) => (n === 1 ? '1 person left to pay' : `${n} people left to pay`);
const peopleStillOwe = (n: number) => (n === 1 ? '1 person still has to pay you' : `${n} people still have to pay you`);
const differencesToSettle = (n: number) => (n === 1 ? '1 difference to settle' : `${n} differences to settle`);

/** D7 (SV-UX-16): the 'sent' pill. Venmo is "sent", never "paid"; `other` is what the sender says. */
function sentView(senders: readonly SentUpdate[]): MarkerView | null {
  const [one] = senders;
  if (one === undefined) return null;
  if (senders.length > 1) {
    const pill = `${senders.length} people sent you money`;
    const list = senders.map((s) => `${s.name} ${formatCents(s.cents)}`).join(', ');
    return { pill, a11y: `${pill}: ${list}`, tone: 'muted', icon: null };
  }
  const amount = formatCents(one.cents);
  switch (one.method) {
    case 'venmo':
      return { pill: `${one.name} sent you ${amount}`, a11y: `${one.name} sent you ${amount} on Venmo`, tone: 'muted', icon: null };
    case 'cash': {
      const text = `${one.name} paid you ${amount} in cash`;
      return { pill: text, a11y: text, tone: 'muted', icon: null };
    }
    case 'other':
      return { pill: `${one.name} paid you ${amount}`, a11y: `${one.name} says they paid you ${amount}`, tone: 'muted', icon: null };
  }
}

/** The word an ower's own pill starts with: Venmo is "Sent" (the app only knows Venmo opened). */
const ownVerb = (method: PaymentMethod) => (method === 'venmo' ? 'Sent' : 'Paid');

/**
 * D7: the pill for a marker. Settle markers read their amounts and counts from `ctx.plan`; if that
 * plan doesn't give this marker for the viewer (stale or missing data), the result is null, so Home
 * shows no pill rather than a guessed one.
 */
export function billMarkerView(marker: HomeMarker, ctx: MarkerViewContext): MarkerView | null {
  if (marker === 'new') return { ...BILL_MARKER_COPY.new, tone: 'accent', icon: null };
  if (marker === 'unclaimed') return { ...BILL_MARKER_COPY.unclaimed, tone: 'muted', icon: null };
  const { plan, viewerId } = ctx;
  if (!plan) return null;
  if (marker === 'waiting_on_others') {
    if (plan.status === 'blocked_payers') {
      // Who-paid D9: only the host can change who paid (set_payers). Without the host id, the guests' copy.
      if (ctx.summary?.hostId === viewerId) {
        return { pill: 'Fix who paid', a11y: "Who paid doesn't match the new total. Fix who paid", tone: 'accent', icon: null };
      }
      return { pill: 'Who paid is being updated', a11y: "Who paid is being updated. You can settle up once it's fixed", tone: 'muted', icon: null };
    }
    // The claim and payer facts are billMarker's; here the plan must still be one with no amounts.
    if (!blockedForAmounts(plan)) return null;
    return { pill: 'Claimed · not ready to pay', a11y: "You've claimed. You can pay once the bill is ready", tone: 'muted', icon: null };
  }
  if (plan.status === 'routes') return routesView(marker, plan, ctx);
  if (settleMarker(plan, viewerId, ctx.summary ?? null) !== marker) return null;
  if (plan.status !== 'ready' && plan.status !== 'early') return null; // narrows; settleMarker said so already
  const people: readonly PlanEntry[] = plan.people;
  const me = people.find((e) => e.userId === viewerId);
  if (me === undefined) return null;

  switch (marker) {
    case 'owes': {
      if (me.role === 'payer') return null;
      const text = `You owe ${formatCents(me.owedCents)}`;
      return { pill: text, a11y: text, tone: 'accent', icon: null };
    }
    case 'paid': {
      if (me.mark === null) return null;
      const text = methodOwnPill(me.mark.method, me.mark.cents);
      return { pill: text, a11y: text, tone: 'muted', icon: 'check' };
    }
    case 'paid_more': {
      const diff = differenceOf(me);
      if (diff === null || me.mark === null) return null;
      const amount = formatCents(diff.cents);
      const verb = ownVerb(me.mark.method);
      return { pill: `${verb} · ${amount} more to pay`, a11y: `${verb}, you owe ${amount} more`, tone: 'accent', icon: null };
    }
    case 'paid_back_due': {
      const diff = differenceOf(me);
      if (diff === null || me.mark === null) return null;
      const amount = formatCents(diff.cents);
      const payer = ctx.nameOf(plan.payerId);
      return { pill: `You are owed ${amount}`, a11y: `You are owed ${amount}: ${payer} owes you ${amount} back`, tone: 'muted', icon: null };
    }
    case 'left_to_pay': {
      if (plan.status !== 'ready') return null;
      const left = plan.owingCount - plan.paidCount;
      return { pill: peopleLeft(left), a11y: peopleStillOwe(left), tone: 'muted', icon: null };
    }
    case 'differences': {
      const text = differencesToSettle(differenceCount(people));
      return { pill: text, a11y: text, tone: 'accent', icon: null };
    }
    case 'settled':
      return { pill: 'Settled up', a11y: 'Settled up, everyone has settled up with you', tone: 'muted', icon: 'check' };
    case 'sent': {
      if (ctx.summary === undefined) return null; // settleMarker said 'sent' only with it; narrows
      const facts = sentFacts({ id: '', ...ctx.summary }, plan, viewerId, ctx.nameOf);
      return facts === null ? null : sentView(facts.senders);
    }
    case 'not_received': {
      if (me.role === 'payer' || me.notReceived === null) return null;
      const amount = formatCents(me.notReceived.cents);
      const payer = displayName(ctx.nameOf, plan.payerId);
      return { pill: `Not received · ${amount}`, a11y: `${payer} hasn't received your ${amount}`, tone: 'accent', icon: null };
    }
  }
}

/**
 * "Hana's bill · Nov 20 · $44.80", plus ". New, you haven't opened it yet" (or the claim label, or a
 * settle marker's words when `settle` carries the bill's plan) when marked.
 */
export function billRowA11yLabel(
  summary: BillSummary,
  myId: string,
  formatDate: (iso: string) => string = formatShortDate,
  settle?: { plan: BillSettlePlan | null | undefined; nameOf: NameOf },
): string {
  const label = billListLabel(summary, myId, formatDate);
  const marker = billMarker(summary, myId, settle?.plan);
  if (marker === null) return label;
  const view = billMarkerView(marker, { plan: settle?.plan, viewerId: myId, nameOf: settle?.nameOf ?? (() => 'Someone'), summary });
  return view === null ? label : `${label}. ${view.a11y}`;
}

/** fetchSettleData's limit (Task 4 refuses more than this many ids). */
export const SETTLE_CANDIDATE_LIMIT = 20;

/**
 * D7 (A1.9): the bills whose settle data Home reads, in list order, at most 20: every bill that can
 * show a settle pill. Skipped: bills already marked 'new' or 'unclaimed' (those win). Bills the viewer
 * pays for that aren't complete are read too (sent-via-Venmo D7), since 'sent' can show on them.
 */
export function settleCandidateIds(bills: readonly BillSummary[], myId: string): string[] {
  return bills
    .filter((b) => billMarker(b, myId) === null)
    .slice(0, SETTLE_CANDIDATE_LIMIT)
    .map((b) => b.id);
}

// ---------------------------------------------------------------------------
// K2: the notice
// ---------------------------------------------------------------------------

export type AddedNotice =
  | { kind: 'one'; bill: BillSummary; title: string; detail: string }
  | { kind: 'many'; billIds: string[]; title: string; detail: string };

/** The one-bill notice's visible button text (its screen-reader label is addedNoticeOpenLabel). */
export const ADDED_NOTICE_OPEN_TEXT = 'Open';
export const ADDED_NOTICE_OPEN_HINT = 'Opens the bill so you can claim what you had';
export const ADDED_NOTICE_DISMISS_LABEL = 'Dismiss';
export const ADDED_NOTICE_DISMISS_HINT_ONE = 'Hides this and removes New from the bill';
export const ADDED_NOTICE_DISMISS_HINT_MANY = 'Hides this and removes New from these bills';

/** The trimmed host name, or "A friend" when it's unset or blank (same rule as billListLabel). */
function noticeHost(hostName: string | null): string {
  const trimmed = hostName?.trim() ?? '';
  return trimmed === '' ? 'A friend' : trimmed;
}

/** "Open Hana's bill": the one-bill notice's Open button label. */
export function addedNoticeOpenLabel(bill: Pick<BillSummary, 'hostName'>): string {
  return `Open ${noticeHost(bill.hostName)}'s bill`;
}

/**
 * K2: the bills whose marker is 'new', in list order, as one notice. null when there are none, so
 * the notice and the "New" pills always cover exactly the same bills.
 */
export function addedNotice(
  bills: readonly BillSummary[],
  myId: string,
  formatDate: (iso: string) => string = formatShortDate,
): AddedNotice | null {
  const fresh = bills.filter((b) => billMarker(b, myId) === 'new');
  const [first] = fresh;
  if (first === undefined) return null;
  if (fresh.length === 1) {
    const date = formatDate(first.createdAt);
    const total = formatCents(first.totalCents);
    return {
      kind: 'one',
      bill: first,
      title: `${noticeHost(first.hostName)} added you to a bill`,
      detail: date === '' ? total : `${date} · ${total}`,
    };
  }
  return {
    kind: 'many',
    billIds: fresh.map((b) => b.id),
    title: `You were added to ${fresh.length} bills`,
    detail: "They're marked New below.",
  };
}

// ---------------------------------------------------------------------------
// Home's Dismiss flow (D5)
// ---------------------------------------------------------------------------

/** The bills a notice covers, in list order: what Dismiss marks seen. */
export function noticeBillIds(notice: AddedNotice): string[] {
  return notice.kind === 'one' ? [notice.bill.id] : notice.billIds;
}

/**
 * What Home remembers for a dismissed bill: its id plus when the viewer joined it. Being removed and
 * added again gives a new joinedAt, so a re-added bill is a new key and gets its card back, even when
 * the earlier dismiss's write failed and Home never saw the bill leave (R2).
 */
export function dismissKey(bill: Pick<BillSummary, 'id' | 'joinedAt'>): string {
  return `${bill.id} ${bill.joinedAt}`;
}

/**
 * The dismissed keys (dismissKey) Home must keep hiding after a load: those whose bill the server
 * still shows as 'new' (the seen write hasn't landed, or it failed). A key the server now shows
 * seen, or whose bill left the list or was re-added, is dropped. Returns the same set when nothing
 * changed, so React can skip the update.
 */
export function stillDismissed(
  dismissed: ReadonlySet<string>,
  bills: readonly BillSummary[],
  myId: string,
): ReadonlySet<string> {
  if (dismissed.size === 0) return dismissed;
  const fresh = new Set(bills.filter((b) => billMarker(b, myId) === 'new').map(dismissKey));
  const kept = new Set([...dismissed].filter((key) => fresh.has(key)));
  return kept.size === dismissed.size ? dismissed : kept;
}
