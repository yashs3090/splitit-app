// Home's per-row marker and the "added you to a bill" notice: pure, no I/O.
// Spec: docs/specs/2026-11-24-bill-markers-and-notices.md D4 (K1, K2), and the settle markers of
// docs/specs/2026-11-25-settle-early-and-differences.md D7 (Task 7, A1.10, A1.24).
//
// 'new' and 'unclaimed' read the facts my_bills() returns. "Complete" is the database's
// private.bill_is_complete (`summary.complete`), never re-derived here (BM-6). Settle markers read
// the entries of the bill's settle plan (lib/settle.ts: role, mark, canSettle, difference), the same
// plan the Settle screen's cards come from, so there's no second rule. No money arithmetic: amounts
// and counts are read off the plan and formatted.
import type { BillSummary } from './bills';
import { billListLabel, formatShortDate, type NameOf } from './billView';
import { formatCents } from './money';
import { differenceOf, type SettleEarlyEntry, type SettleEntry, type SettlePlanWithEarly } from './settle';

/** The markers that need no settle data (K1). */
export type BillMarker = 'new' | 'unclaimed';
/** D7 H1–H7, in that order. */
export type SettleMarker = 'owes' | 'paid' | 'paid_more' | 'paid_back_due' | 'left_to_pay' | 'differences' | 'settled';
export type HomeMarker = BillMarker | SettleMarker;

/** The facts billMarker reads. */
type MarkerFacts = Pick<BillSummary, 'hostId' | 'payerId' | 'added' | 'seen' | 'claimedAny' | 'complete'>;

/**
 * K1 + D7: the one marker a Home row gets, first match wins.
 * 1. 'new': someone else hosts it, they added you, and you haven't opened it or dismissed its notice.
 * 2. 'unclaimed': you're neither host nor payer, have no claims, and the bill isn't complete
 *    (so it never contradicts settle's "You owe" / "nothing to pay", which need a complete bill).
 * 3. A settle marker, when the bill's settle plan is given (settleMarker). The host skips 1–2 but
 *    reaches this step (A1.10). Without a plan the result is exactly today's.
 */
export function billMarker(summary: MarkerFacts, myId: string): BillMarker | null;
export function billMarker(summary: MarkerFacts, myId: string, plan: SettlePlanWithEarly | null | undefined): HomeMarker | null;
export function billMarker(summary: MarkerFacts, myId: string, plan?: SettlePlanWithEarly | null): HomeMarker | null {
  if (summary.hostId !== myId) {
    if (summary.added && !summary.seen) return 'new';
    if (summary.payerId !== myId && !summary.claimedAny && !summary.complete) return 'unclaimed';
  }
  return plan ? settleMarker(plan, myId) : null;
}

type PlanEntry = SettleEntry | SettleEarlyEntry;

/** Entries with a non-null difference: the `d` the payer card counts (D6, D7). */
function differenceCount(people: readonly PlanEntry[]): number {
  return people.filter((e) => differenceOf(e) !== null).length;
}

/** D7 H1–H7 from the plan's entries, or null (the "—" row). */
function settleMarker(plan: SettlePlanWithEarly, myId: string): SettleMarker | null {
  if (plan.status !== 'ready' && plan.status !== 'early') return null;
  const people: readonly PlanEntry[] = plan.people;
  const me = people.find((e) => e.userId === myId);
  if (me === undefined) return null;

  if (me.role === 'payer') {
    if (plan.status !== 'ready') return null; // HM-4: no payer marker before the bill is complete
    const d = differenceCount(people);
    if (plan.paidCount < plan.owingCount) return 'left_to_pay'; // H5: someone owing is unmarked
    if (d > 0) return 'differences'; // H6, including owingCount 0 (A1.8)
    if (plan.owingCount > 0) return 'settled'; // H7 (allPaid holds here)
    return null;
  }

  if (me.mark !== null) {
    if (plan.status === 'early') return 'paid'; // H2: early differences are settled after completion
    const diff = differenceOf(me);
    if (diff === null) return 'paid';
    return diff.kind === 'more' ? 'paid_more' : 'paid_back_due';
  }
  if (me.role !== 'owes') return null;
  if (plan.status === 'early' && !('canSettle' in me && me.canSettle)) return null;
  return 'owes'; // H1
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
export type MarkerViewContext = { plan: SettlePlanWithEarly | null | undefined; viewerId: string; nameOf: NameOf };

const peopleLeft = (n: number) => (n === 1 ? '1 person left to pay' : `${n} people left to pay`);
const peopleStillOwe = (n: number) => (n === 1 ? '1 person still has to pay you' : `${n} people still have to pay you`);
const differencesToSettle = (n: number) => (n === 1 ? '1 difference to settle' : `${n} differences to settle`);

/**
 * D7: the pill for a marker. Settle markers read their amounts and counts from `ctx.plan`; if that
 * plan doesn't give this marker for the viewer (stale or missing data), the result is null, so Home
 * shows no pill rather than a guessed one.
 */
export function billMarkerView(marker: HomeMarker, ctx: MarkerViewContext): MarkerView | null {
  if (marker === 'new') return { ...BILL_MARKER_COPY.new, tone: 'accent', icon: null };
  if (marker === 'unclaimed') return { ...BILL_MARKER_COPY.unclaimed, tone: 'muted', icon: null };
  const { plan, viewerId } = ctx;
  if (!plan || settleMarker(plan, viewerId) !== marker) return null;
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
      const text = `Paid ${formatCents(me.mark.cents)}`;
      return { pill: text, a11y: text, tone: 'muted', icon: 'check' };
    }
    case 'paid_more': {
      const diff = differenceOf(me);
      if (diff === null) return null;
      const amount = formatCents(diff.cents);
      return { pill: `Paid · ${amount} more to pay`, a11y: `Paid, you owe ${amount} more`, tone: 'accent', icon: null };
    }
    case 'paid_back_due': {
      const diff = differenceOf(me);
      if (diff === null) return null;
      const amount = formatCents(diff.cents);
      const payer = ctx.nameOf(plan.payerId);
      return { pill: `Paid · ${amount} back to you`, a11y: `Paid, ${payer} owes you ${amount} back`, tone: 'muted', icon: null };
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
      return { pill: 'Settled up', a11y: 'Settled up, everyone has paid you', tone: 'muted', icon: 'check' };
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
  settle?: { plan: SettlePlanWithEarly | null | undefined; nameOf: NameOf },
): string {
  const label = billListLabel(summary, myId, formatDate);
  const marker = billMarker(summary, myId, settle?.plan);
  if (marker === null) return label;
  const view = billMarkerView(marker, { plan: settle?.plan, viewerId: myId, nameOf: settle?.nameOf ?? (() => 'Someone') });
  return view === null ? label : `${label}. ${view.a11y}`;
}

/** fetchSettleData's limit (Task 4 refuses more than this many ids). */
export const SETTLE_CANDIDATE_LIMIT = 20;

/**
 * D7 (A1.9): the bills whose settle data Home reads, in list order, at most 20: every bill that can
 * show a settle pill. Skipped: bills already marked 'new' or 'unclaimed' (those win), and bills the
 * viewer pays for that aren't complete (HM-4: no payer marker before completion).
 */
export function settleCandidateIds(bills: readonly BillSummary[], myId: string): string[] {
  return bills
    .filter((b) => billMarker(b, myId) === null && !(b.payerId === myId && !b.complete))
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
