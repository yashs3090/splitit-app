// Home's rows and groups: pure, no I/O.
// Spec: docs/specs/2026-11-26-home-mobile-refresh.md D2–D5 (Task 2), and
// docs/specs/2026-11-26-home-groups-v2.md D1–D5 + amendment A1 (Task 1).
//
// One per-row view (homeRowView) gives every part of a Home row its content: the title, caption,
// pill, amount, screen-reader label and group. The group (Waiting on you, Owed to you, Settled, or
// hidden) comes only from the viewer's balance on the bill's settle plan (viewerBalance), never from
// the marker; the marker decides only the pill. Both read the same plan, and MARKER_GROUPS records
// which groups each pill may appear in, so tests can prove they agree. The only money sum is
// stillToCollectCents ("To collect", A1.M2); everything else is read off the plan or summary and formatted.
// Who paid X2 (docs/specs/2026-11-26-who-paid.md D10, A1.2 contract O): the plan is any BillSettlePlan.
// Balances come from settle's balanceFor on every plan (on single-payer plans it equals the earlier
// role/mark rule: lib/settle.regression.test.ts), so a 'routes' plan (several payers, or money moved
// between other people) groups by the same rule as a one-payer bill.
import type { BillSummary } from './bills';
import { formatShortDate, type NameOf } from './billView';
import { billMarker, billMarkerView, type HomeMarker, type MarkerTone, type MarkerView } from './homeMarkers';
import { formatCents } from './money';
import { balanceFor, type BillSettlePlan, type SettleEarlyEntry, type SettleEntry } from './settle';

/** A bill's settle facts as Home holds them (the plan from ledgerSettlePlan, and the names). */
export type HomeSettleFacts = { plan: BillSettlePlan; nameOf: NameOf };

/** GV D2: where a row goes. 'hidden' rows aren't drawn, only counted. */
export type HomeGroup = 'waiting' | 'owed' | 'settled' | 'hidden';

/**
 * GV D5: the section headings. HOME-SEC-1 (2026-11-27, user request): "Waiting on you" is drawn as
 * two sections, Items to claim and Still needs to be paid; `waiting` stays the group's name (the
 * marker checks use it). HOME-SEC-2: every bill section is a Show / Hide toggle with its count
 * (HOME-POLISH-1: the action sections start open).
 */
export const HOME_SECTION_TITLES = {
  claim: 'Items to claim',
  pay: 'Still needs to be paid',
  owed: 'Owed to you',
  settled: 'Settled',
} as const;

/** HOME-SEC-2: the bill sections that collapse (Settled has its own copy below). */
export type HomeOpenSection = 'claim' | 'pay' | 'owed';

// HOME-POLISH-1 (2026-11-28, user request "we can unhide by default"): Items to claim, Still needs
// to be paid and Owed to you start open on every mount; Settled starts collapsed (GV-11). All can
// still collapse. (This replaces HOME-SEC-2's amended "every section starts collapsed".)

/** HOME-SEC-2: a section toggle's visible text, e.g. "Owed to you (2)". */
export function sectionToggleText(section: HomeOpenSection, n: number): string {
  return `${HOME_SECTION_TITLES[section]} (${n})`;
}

/** HOME-SEC-2: a section toggle's screen-reader label, e.g. "Owed to you, 2 bills". */
export function sectionToggleA11y(section: HomeOpenSection, n: number): string {
  return `${HOME_SECTION_TITLES[section]}, ${n === 1 ? '1 bill' : `${n} bills`}`;
}

/**
 * HOME-SEC-1: which of the two "Waiting on you" sections a waiting row goes in. Items to claim when
 * the viewer hasn't claimed anything yet; otherwise (claimed and owes, or waiting on others or on
 * the host to fix who paid) Still needs to be paid. A split that doesn't add up waits on the host,
 * not on a claim, so it's always "pay".
 */
export function waitingFor(summary: Pick<BillSummary, 'claimedAny'>, plan: BillSettlePlan | null | undefined): 'claim' | 'pay' {
  if (plan?.status === 'blocked_payers') return 'pay';
  return summary.claimedAny ? 'pay' : 'claim';
}

/** D1: the sticky bar's copy, plus GV D5 / A1's groups copy. */
export const HOME_COPY = {
  splitHeading: 'Split a bill',
  addReceipt: 'Add receipt',
  addReceiptHint: 'Take a photo of the receipt, or type the items',
  sectionShowHint: 'Shows these bills',
  sectionHideHint: 'Hides these bills',
  settledShowHint: 'Shows bills everyone has paid you for',
  settledHideHint: 'Hides settled bills',
  settledShow: 'Show',
  settledHide: 'Hide',
  allClear: "You're all caught up.",
  hiddenNote: "Bills you've paid don't show here.",
} as const;

/** GV D5: the Settled toggle's visible text. */
export function settledToggleText(n: number): string {
  return `Settled (${n})`;
}

/** GV D5: the Settled toggle's screen-reader label. */
export function settledToggleA11y(n: number): string {
  return n === 1 ? 'Settled, 1 bill' : `Settled, ${n} bills`;
}

/**
 * A1.M3: how long Home's first load waits for the first settle read before showing the GV-5
 * fallback. Starting value (docs/before-production.md); exported so the screen and tests share it.
 */
export const FIRST_SETTLE_WAIT_MS = 1000;

/**
 * GV D1 (rule 8): the one "is the viewer the payer" check. A plan that names its payers is the newer
 * read, so it wins: a ready or early plan's payerId, or (who paid) anyone in a 'routes' or
 * 'blocked_payers' plan's payers, lead or not. Otherwise the summary's payer_id (the lead).
 */
export function viewerIsPayer(summary: Pick<BillSummary, 'payerId'>, plan: BillSettlePlan | null | undefined, myId: string): boolean {
  if (plan && (plan.status === 'ready' || plan.status === 'early')) return plan.payerId === myId;
  if (plan && (plan.status === 'routes' || plan.status === 'blocked_payers')) return plan.payers.some((p) => p.userId === myId);
  return summary.payerId === myId;
}

export type ViewerBalance = { known: false } | { known: true; final: boolean; owes: boolean; owed: boolean };

/**
 * GV D1 + who-paid contract O: does the viewer owe anyone on this bill, and is anyone owed by them?
 * balanceFor's cents as booleans (its differences use the SETTLE_DIFF_IGNORE_CENTS tolerance, and an
 * unmarked negative share never counts, GV-4). Unknown with no plan, a plan with no amounts
 * (blocked, all-$0, a stale split), or no entry for the viewer. `summary` is unused since balanceFor
 * reads the payers off the plan; kept so callers don't change.
 */
export function viewerBalance(_summary: Pick<BillSummary, 'payerId'>, plan: BillSettlePlan | null | undefined, myId: string): ViewerBalance {
  if (!plan) return { known: false };
  const b = balanceFor(plan, myId);
  if (!b.known) return { known: false };
  return { known: true, final: b.final, owes: b.owesCents > 0, owed: b.owedCents > 0 };
}

/**
 * GV D2: the group, from the viewer's balance and role only (rule 7: markers decide only the pill).
 * First match wins. Nothing is hidden or settled until a plan confirms it (GV-5).
 */
export function homeGroup(input: {
  summary: Pick<BillSummary, 'payerId' | 'claimedAny'>;
  plan: BillSettlePlan | null | undefined;
  myId: string;
}): HomeGroup {
  const { summary, plan, myId } = input;
  // Who-paid D10: a split that no longer adds up to the total is Waiting on you for everyone: the
  // host must fix it, and everyone else's amounts wait on that (co-payers too; its pill is
  // 'waiting_on_others' for all). Before the role rule, so a co-payer isn't put in Owed to you.
  if (plan?.status === 'blocked_payers') return 'waiting';
  const payer = viewerIsPayer(summary, plan, myId);
  const b = viewerBalance(summary, plan, myId);
  if (!b.known) return payer ? 'owed' : 'waiting'; // steps 1–2
  if (b.owed) return 'owed'; // step 3 (GV-2: before owes)
  if (b.owes) return 'waiting'; // step 4
  // Step 7, review R2 (user rule 1): a zero balance on a plan still being claimed, by a viewer who
  // hasn't claimed anything (a host who isn't the payer), is "nothing claimed yet": Waiting on you.
  // A guest bill is hidden only once the plan is final, or the viewer has claimed and owes nothing.
  if (!payer) return !b.final && !summary.claimedAny ? 'waiting' : 'hidden';
  return b.final ? 'settled' : 'owed'; // steps 6 and 5
}

/**
 * GV D4: the groups each marker's pill may appear in. Record<HomeMarker, …>, so a new marker kind
 * fails the type-check until it gets a line here (and a GROUP_FIXTURES entry in the test).
 */
export const MARKER_GROUPS: Readonly<Record<HomeMarker, readonly HomeGroup[]>> = {
  new: ['waiting', 'owed'], // guest: no plan → waiting; payer who isn't the host → owed
  unclaimed: ['waiting'],
  waiting_on_others: ['waiting'], // D-1: claimed, the plan is blocked or all-$0
  not_received: ['waiting'], // 92: unmarked, owes
  owes: ['waiting'],
  // ready → hidden; early with a difference → waiting / owed (D-2); who paid: a co-payer who has paid
  // what they owed another payer, with nobody owing them → settled (drawn without its pill there).
  paid: ['hidden', 'waiting', 'owed', 'settled'],
  paid_more: ['waiting'],
  paid_back_due: ['owed'],
  left_to_pay: ['owed'],
  differences: ['owed', 'waiting'], // owed when anyone owes the payer; waiting for pay-backs only
  sent: ['owed'], // 92: only while someone owes
  // Who paid: someone who isn't a payer now but was paid on this bill earlier (an earlier payer who
  // passed the money on), once everything is paid → hidden, like any guest who paid in full.
  settled: ['settled', 'hidden'],
};

/**
 * A1.M2 + who-paid contract O: what's still coming in to the viewer: balanceFor's owedCents. On a
 * single-payer plan that is every other person's unmarked positive share plus every 'more' difference
 * (1¢ tolerance), with 'back' differences not subtracted (GV-22); on 'routes' it sums the viewer's own
 * pairs. > 0 exactly when viewerBalance's `owed`. Integer cents. 0 for a plan without amounts.
 */
export function stillToCollectCents(plan: BillSettlePlan, myId: string): number {
  const b = balanceFor(plan, myId);
  return b.known ? b.owedCents : 0;
}

/** D2: "Just you", "<n> people", or '' when the count is unknown (or not a whole number ≥ 1). */
export function peopleText(count: number | undefined): string {
  if (count === undefined || !Number.isInteger(count) || count < 1) return '';
  return count === 1 ? 'Just you' : `${count} people`;
}

/** D2: "Nov 23 · 4 people", dropping whichever part is empty. */
export function rowCaption(createdAt: string, count: number | undefined, formatDate: (iso: string) => string = formatShortDate): string {
  return joinCaption(formatDate(createdAt), peopleText(count));
}

function joinCaption(date: string, people: string): string {
  return [date, people].filter((s) => s !== '').join(' · ');
}

/** D2: "Your bill" for the host, else "<host>'s bill" ("A friend" when the name is unset or blank). */
export function rowTitle(summary: Pick<BillSummary, 'hostId' | 'hostName'>, myId: string): string {
  if (summary.hostId === myId) return 'Your bill';
  const host = summary.hostName?.trim() ?? '';
  return `${host === '' ? 'A friend' : host}'s bill`;
}

export type RowAmountKind = 'share' | 'total' | 'collect';
export type RowAmount = { kind: RowAmountKind; cents: number };

/**
 * A1.M2 first: a payer, a final plan (ready, or routes that aren't early) and the 'owed' group →
 * stillToCollectCents. Then D3, first match wins: the host, no or non-final plan, viewer missing or a
 * payer, or a negative share → the bill total. Otherwise the viewer's share (≥ 0), read off the plan
 * as is: a ready plan's owedCents, or a routes plan's shareCents (what they had, not what's left: the
 * pill says what they still owe). `group` is the row's homeGroup; without it (callers from before
 * groups v2) the amount is never 'collect'.
 */
export function rowAmount(
  summary: Pick<BillSummary, 'hostId' | 'payerId' | 'totalCents'>,
  myId: string,
  plan: BillSettlePlan | null | undefined,
  group?: HomeGroup,
): RowAmount {
  const total: RowAmount = { kind: 'total', cents: summary.totalCents };
  const final = plan?.status === 'ready' || (plan?.status === 'routes' && plan.early === null);
  if (group === 'owed' && plan && final && viewerIsPayer(summary, plan, myId)) {
    return { kind: 'collect', cents: stillToCollectCents(plan, myId) };
  }
  if (summary.hostId === myId) return total;
  if (plan?.status === 'routes') {
    if (!final || viewerIsPayer(summary, plan, myId)) return total;
    const mine = plan.people.find((p) => p.userId === myId);
    if (mine === undefined || mine.shareCents < 0) return total;
    return { kind: 'share', cents: mine.shareCents };
  }
  if (!plan || plan.status !== 'ready') return total;
  const people: readonly (SettleEntry | SettleEarlyEntry)[] = plan.people;
  const me = people.find((e) => e.userId === myId);
  if (me === undefined || me.role === 'payer') return total;
  if (me.owedCents < 0) return total;
  return { kind: 'share', cents: me.owedCents };
}

/** D3: the visible label under the figure. */
export function amountLabel(kind: RowAmountKind): string {
  switch (kind) {
    case 'share':
      return 'Your share';
    case 'collect':
      return 'To collect';
    case 'total':
      return 'Total';
  }
}

/** D5 + A1.M2: the amount as the screen reader says it. */
function amountPhrase(amount: RowAmount): string {
  const figure = formatCents(amount.cents);
  switch (amount.kind) {
    case 'share':
      return `your share ${figure}`;
    case 'collect':
      return `to collect ${figure}`;
    case 'total':
      return `total ${figure}`;
  }
}

/**
 * D5: "Hana's bill, Nov 20, 3 people, total $44.80", then ". <pill words>" when there's a pill.
 * Reading order matches the screen: title, caption parts, amount, pill.
 */
export function homeRowA11yLabel(parts: {
  title: string;
  date: string;
  people: string;
  amount: RowAmount;
  pill: MarkerView | null;
}): string {
  const label = [parts.title, parts.date, parts.people, amountPhrase(parts.amount)].filter((s) => s !== '').join(', ');
  return parts.pill === null ? label : `${label}. ${parts.pill.a11y}`;
}

/**
 * HOME-POLISH-1: Home draws a row's marker as a status line (words in the tone's colour, no pill
 * shape). The words are billMarkerView's, except where Home says the next step instead. Only
 * 'unclaimed' is reworded: "Nothing claimed yet" becomes the viewer's step, in the accent tone (the
 * Groups rows already say "claim your items"). Home only; billMarkerView itself is unchanged.
 */
export const HOME_STATUS_COPY: Readonly<Partial<Record<HomeMarker, { readonly pill: string; readonly a11y: string; readonly tone: MarkerTone }>>> = {
  unclaimed: { pill: 'Claim your items', a11y: 'Claim your items', tone: 'accent' },
};

/** HOME-POLISH-1: the status line for a row's marker view (null when there's no view). */
export function homeStatus(marker: HomeMarker | null, view: MarkerView | null): MarkerView | null {
  if (marker === null || view === null) return null;
  const copy = HOME_STATUS_COPY[marker];
  return copy === undefined ? view : { ...view, ...copy };
}

/** HOME-POLISH-1: the host's initials circle (components/Avatars' AvatarPerson shape; lib can't import components). */
export type HomeHostAvatar = { userId: string; name: string; initials: string; isMe: boolean };

/**
 * "Y" for your own bill (its title says "Your bill"); else the host's one initial: the first letter
 * or digit of the name, so "Tejesh (demo)" is "T", not billView's two-letter "T(". "?" when there's none.
 */
export function hostAvatar(summary: Pick<BillSummary, 'hostId' | 'hostName'>, myId: string): HomeHostAvatar {
  if (summary.hostId === myId) return { userId: myId, name: 'You', initials: 'Y', isMe: true };
  const name = summary.hostName?.trim() ?? '';
  const first = /[\p{L}\p{N}]/u.exec(name)?.[0];
  return { userId: summary.hostId, name: name === '' ? 'A friend' : name, initials: first === undefined ? '?' : first.toUpperCase(), isMe: false };
}

export type HomeRowView = {
  id: string;
  title: string;
  /** The caption text ('' when both date and count are missing). */
  caption: string;
  /** billMarkerView's view for the marker, as is. */
  pill: MarkerView | null;
  /** HOME-POLISH-1: what Home draws under the title and reads in the label (homeStatus of the pill). */
  status: MarkerView | null;
  /** HOME-POLISH-1: the leading initials circle. Decorative: the title says whose bill it is. */
  host: HomeHostAvatar;
  marker: HomeMarker | null;
  amount: RowAmount;
  /** formatCents(amount.cents): the figure Home renders. */
  amountText: string;
  amountLabel: string;
  a11yLabel: string;
  /** GV D5: homeGroup from the same plan as marker, pill and amount. */
  group: HomeGroup;
  /** HOME-SEC-1: for a 'waiting' row, its section; null for every other group. */
  waitingFor: 'claim' | 'pay' | null;
};

/** Only billMarkerView's settle markers read names, and they only run with a plan's own nameOf. */
const noName: NameOf = () => 'Someone';

/** D4: everything Home draws for one bill row. `peopleCount` is undefined when unknown. */
export function homeRowView(
  summary: BillSummary,
  myId: string,
  facts: HomeSettleFacts | undefined,
  peopleCount: number | undefined,
  formatDate: (iso: string) => string = formatShortDate,
): HomeRowView {
  const plan = facts?.plan;
  const marker = billMarker(summary, myId, plan);
  // The summary carries the seen facts the 'sent' pill needs to tell which sends are unseen.
  const pill = marker === null ? null : billMarkerView(marker, { plan, viewerId: myId, nameOf: facts?.nameOf ?? noName, summary });
  const group = homeGroup({ summary, plan, myId });
  const title = rowTitle(summary, myId);
  const date = formatDate(summary.createdAt);
  const people = peopleText(peopleCount);
  const amount = rowAmount(summary, myId, plan, group);
  const status = homeStatus(marker, pill);
  return {
    id: summary.id,
    title,
    caption: joinCaption(date, people),
    pill,
    status,
    host: hostAvatar(summary, myId),
    marker,
    amount,
    amountText: formatCents(amount.cents),
    amountLabel: amountLabel(amount.kind),
    a11yLabel: homeRowA11yLabel({ title, date, people, amount, pill: status }),
    group,
    waitingFor: group === 'waiting' ? waitingFor(summary, plan) : null,
  };
}

/** `waiting` is every waiting row; `claim` and `pay` are the same rows split for drawing (HOME-SEC-1). */
export type HomeSections<R> = { waiting: R[]; claim: R[]; pay: R[]; owed: R[]; settled: R[]; hiddenCount: number };

/**
 * GV D5: a stable partition of the rows (already in my_bills() order) by group. Hidden rows only
 * count. Filters by nothing but the group.
 */
export function homeSections<R extends Pick<HomeRowView, 'group'> & Partial<Pick<HomeRowView, 'waitingFor'>>>(
  rows: readonly R[],
): HomeSections<R> {
  const out: HomeSections<R> = { waiting: [], claim: [], pay: [], owed: [], settled: [], hiddenCount: 0 };
  for (const row of rows) {
    if (row.group === 'hidden') out.hiddenCount += 1;
    else {
      out[row.group].push(row);
      // A row built without waitingFor (older callers, tests) counts as "pay".
      if (row.group === 'waiting') out[row.waitingFor === 'claim' ? 'claim' : 'pay'].push(row);
    }
  }
  return out;
}
