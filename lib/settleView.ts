// View models and every string for the Settle up screen. Pure: no React, no I/O.
// Brief: docs/specs/2026-11-24-m3-settle-ux.md §3–§7, §10 (copy). Spec: 2026-11-24-m3-settle-venmo.md,
// Amendment A1, Task 8. Venmo Request buttons and the bill-screen footer:
// docs/specs/2026-11-25-venmo-request-buttons.md (R2, R3, F1, F3). Settling early and paying the
// difference: docs/specs/2026-11-25-settle-early-and-differences.md D6 (Task 6, Amendment A1).
//
// Components render what these functions return. They do no money arithmetic and build no money
// sentences: every amount below is integer cents from lib/settle.ts, and every "$" string goes
// through formatCents here.
import { leftToClaim, makeNameOf, splitInputFor, type NameOf } from './billView';
import { BILL_ERROR_COPY, type BillData, type BillError } from './bills';
import { formatCents } from './money';
import { claimedItemNames, isSettleCents, venmoPayUrl, venmoRequestUrl } from './paylinks';
import {
  differenceOf,
  settlePlan,
  SETTLE_ALL_ZERO_COPY,
  type SettleDifference,
  type SettleEarly,
  type SettleEarlyEntry,
  type SettleEntry,
  type SettlePlanWithEarly,
  type SettleReady,
} from './settle';
import type { ExtrasMode } from './split';

// ---------------------------------------------------------------------------
// Copy (brief §10). Fixed strings are constants; sentences with names or amounts are functions.
// ---------------------------------------------------------------------------

export const SETTLE_COPY = {
  /** Visible text of the header back control; the chevron is an icon (P3). */
  back: 'Bill',
  backA11y: 'Back to the bill',
  title: 'Settle up',
  change: 'Change',
  cancelChange: 'Cancel',
  changeHint: 'Choose who paid the restaurant',
  pickerTitle: 'Who paid the bill?',
  cancel: 'Cancel',
  dismiss: 'Dismiss',
  webComputerLine: 'On a computer? Send it from the Venmo app on your phone.',
  alreadyPaid: 'I already paid',
  iPaid: 'I paid',
  markHint: 'Marks your share as paid',
  openAgain: 'Open Venmo again',
  opensVenmo: 'Opens Venmo',
  markedPaid: 'Marked paid',
  undo: 'Undo',
  nothingLabel: "You're all set",
  nothingBody: "You don't owe anything on this bill.",
  negativeBody: 'Settle that outside the app.',
  payerAllPaidLabel: "Everyone's paid",
  payerNobody: 'Nobody owes you anything on this bill.',
  addVenmoCard: 'Add your Venmo so people can pay you',
  addVenmoButton: 'Add Venmo',
  addVenmoHint: 'Opens your profile',
  everyoneTitle: 'Everyone',
  allPaidAside: 'All paid',
  rowPaid: 'Paid',
  rowNotYet: 'Not yet',
  blockedLabel: 'Not ready yet',
  blockedMarkSaved: 'Your "I paid" is saved.',
  backToBill: 'Back to the bill',
  editItems: 'Edit items',
  editItemsHint: 'Change items or prices',
  badPayer: 'Something went wrong loading this bill.',
  tryAgain: 'Try again',
  saveFailed: "Couldn't save. Try again.",
  invalidBill: "Couldn't save. Refresh and try again.",
  markUndoneBanner: 'Your "I paid" was undone. Check Activity to see who.',
  announceMarked: 'Marked paid',
  announceUnmarked: 'Marked not paid',
  settleUp: 'Settle up',
  settleUpHintReady: 'See what you owe and pay',
  // Venmo Request buttons (request spec R3)
  request: 'Request',
  requestNoVenmo: "Hasn't added Venmo",
  requestTooLarge: 'Request it in the Venmo app',
  requestWebLine: 'On a computer? Send requests from the Venmo app on your phone.',
  // Bill screen footer (request spec F3)
  details: 'Details',
  detailsA11y: 'Settle up details',
  detailsHint: "Shows who's paid and other ways to pay",
  // Bill screen footer: the refetch after the viewer's own change failed (review R1, Amendment A2)
  refreshFailed: "Couldn't refresh. Try again.",
  refresh: 'Refresh',
  refreshHint: 'Loads the latest bill',
  // Settle early and differences (spec D6, brief §10). Glyph-free; tone lives on the line (A1.22).
  earlyMarkedLine: "If your share changes, you'll settle the difference here once everything is claimed.",
  earlyNoClaim: 'Claim what you had on the bill, then come back to pay.',
  payerEarlyLabel: 'Waiting for everyone to claim',
  markDifference: 'I paid the difference',
  undoMark: 'Undo "I paid"',
  undoMarkA11y: 'Undo your I paid',
  payerDifferencesLabel: 'You owe money back',
  evenBlockedLine: "Tax and tip are split evenly on this bill, so shares aren't set until then.",
  paidItBack: 'I paid it back',
  payBackTooLarge: 'Pay it back in the Venmo app',
  listVenmoWebLine: 'On a computer? Open Venmo on your phone to pay or request.',
  markChanged: 'Your "I paid" just changed. Check the amount and try again.',
  notCompleteSettle: 'Something on the bill just changed. Check your share and try again.',
  differenceHint: 'See the difference and settle it',
  announceDifference: 'Difference marked paid',
  announcePaidBack: 'Marked paid back',
} as const;


export const payerLineText = (payer: string) => `${payer} paid the bill`;
export const owesLabel = (payer: string) => `You owe ${payer}`;
export const payButtonText = (payer: string, cents: number) => `Pay ${payer} ${formatCents(cents)} on Venmo`;
export const handleLine = (handle: string, cents: number) => `@${handle} · ${formatCents(cents)}`;
export const didYouPay = (payer: string) => `Did you pay ${payer}?`;
export const paidLabel = (payer: string) => `You paid ${payer}`;
export const noVenmoOwer = (payer: string) => `${payer} hasn't added Venmo yet. Ask them, or pay another way.`;
export const negativeLabel = (payer: string) => `${payer} owes you`;
export const payerOwedLabel = (n: number) => (n === 1 ? '1 person owes you' : `${n} people owe you`);
export const paidOfText = (paid: number, n: number) => `${paid} of ${n} paid`;
export const payerAllPaidLine = (n: number) => (n === 1 ? 'They marked paid' : `All ${n} marked paid`);
export const blockedBody = (rows: number, discountRows = 0) => {
  const left = leftToClaim(rows, discountRows);
  const what = left.every === 'everything' ? 'everything is claimed' : `${left.every} is claimed`;
  return `You can settle up once ${what} (${left.count} left).`;
};
export const SETTLE_ALL_ZERO_GUEST_COPY = (host: string) => `Every item is $0. Ask ${host} to fix the prices.`;
export const openFailedText = (handle: string, cents: number) =>
  `Couldn't open Venmo. Send ${formatCents(cents)} to @${handle} in the Venmo app.`;
export const requestA11yLabel = (name: string, handle: string, cents: number) =>
  `Request ${formatCents(cents)} from ${name} on Venmo, @${handle}`;
export const requestOpenFailedText = (handle: string, cents: number) =>
  `Couldn't open Venmo. Request ${formatCents(cents)} from @${handle} in the Venmo app.`;
export const undoOtherConfirm = (name: string) => `Undo ${name}'s "I paid"?`;
export const footerIncomplete = (rows: number, discountRows = 0) => `${leftToClaim(rows, discountRows).count} left to claim`;

// Settle early (spec D6, brief §10)
export const mayChangeLine = (rows: number, discountRows = 0) =>
  `Your share may change until everything is claimed (${leftToClaim(rows, discountRows).count} left).`;
export const paidSoFar = (n: number) => `${n} paid so far`;
/** A marked early card whose share moved: which way and how much, settled after completion (SE-UX-2). */
export const earlyDifferenceLine = (owedCents: number, diff: SettleDifference, payer: string) =>
  diff.kind === 'more'
    ? `Your share is now ${formatCents(owedCents)}. You'll pay the ${formatCents(diff.cents)} difference once everything is claimed.`
    : `Your share is now ${formatCents(owedCents)}. ${payer} will owe you ${formatCents(diff.cents)} back once everything is claimed.`;

// Differences on a complete bill (spec D6)
export const moreLabel = (payer: string) => `You owe ${payer} more`;
export const payMoreText = (payer: string, cents: number) => `Pay ${payer} ${formatCents(cents)} more on Venmo`;
export const didYouPayMore = (payer: string, cents: number) => `Did you pay ${payer} ${formatCents(cents)}?`;
export const diffLine = (owedCents: number, markCents: number) =>
  `Your share is now ${formatCents(owedCents)}. You've marked ${formatCents(markCents)} paid.`;
export const requestBackText = (payer: string, cents: number) => `Request ${formatCents(cents)} from ${payer} on Venmo`;
export const backNoVenmo = (payer: string) => `Ask ${payer} to pay you back.`;
export const backNegativeLine = (payer: string, cents: number) =>
  `${payer} also owes you ${formatCents(cents)} for your share. Settle that outside the app.`;
export const differencesToSettle = (n: number) => (n === 1 ? '1 difference to settle' : `${n} differences to settle`);
export const markSubLine = (markCents: number, owedCents: number) =>
  `Marked ${formatCents(markCents)} · share now ${formatCents(owedCents)}`;

// ---------------------------------------------------------------------------
// Card (brief §3)
// ---------------------------------------------------------------------------

/**
 * What the person opened in Venmo on this screen (component state; never persisted). Contract O
 * (spec D6): 'share' (or no kind) is their whole share; 'more' is a difference on top of the mark
 * `fromCents`. The "Did you pay?" prompt stays while openedStillMatches holds.
 */
export type OpenedVenmo =
  | { kind?: 'share'; payerId: string; cents: number }
  | { kind: 'more'; payerId: string; cents: number; fromCents: number };

export type SettleAction =
  | { kind: 'pay'; url: string; payerId: string; cents: number }
  | { kind: 'mark'; payerId: string; cents: number }
  /** Opens Venmo for a difference; the screen then shows "Did you pay?" (OpenedVenmo kind 'more'). */
  | { kind: 'pay_difference'; url: string; payerId: string; cents: number; fromCents: number; toCents: number }
  /** settleDifference(bill, userId, payerId, fromCents, toCents), values as shown (never recomputed). */
  | { kind: 'mark_difference'; userId: string; payerId: string; fromCents: number; toCents: number }
  /** Opens a Venmo request; never writes anything (VR-6). */
  | { kind: 'request'; url: string }
  | { kind: 'unmark'; userId: string }
  | { kind: 'add_venmo' }
  | { kind: 'back' }
  | { kind: 'edit' }
  | { kind: 'retry' };

/** `variant: 'secondary'` (outlined) only on the back-due card's Request (SE-VIS-3); absent = filled primary. */
export type SettleButton = { label: string; a11yLabel: string; a11yHint?: string; variant?: 'secondary'; action: SettleAction };

/** Copy carries no status glyphs (P3): the UI draws a Check (success) or TriangleAlert (warning) from `tone`. */
export type CardLine = { text: string; tone: 'muted' | 'success' | 'warning'; live?: boolean };

/** The brief §3 state the card is in. */
export type SettleCardState =
  | 'owes' // 3.1
  | 'owes_opened' // 3.2
  | 'marked' // 3.3 (also marked early, with a line about later)
  | 'more_due' // the share went up after the mark (D6)
  | 'more_opened' // after "Pay … more", contract O
  | 'back_due' // the share went down after the mark
  | 'owes_no_venmo' // 3.5
  | 'nothing' // 3.6
  | 'negative' // 3.7
  | 'payer' // 3.8
  | 'payer_all_paid'
  | 'payer_nobody'
  | 'payer_differences' // nobody owes, but the payer owes pay-backs (F5)
  | 'payer_early' // the payer before everything is claimed
  | 'early_not_ready' // early plan, the viewer has no item claim yet
  | 'blocked' // 3.9
  | 'blocked_all_zero' // 3.10
  | 'bad_payer'; // 3.11

export type SettleCardModel = {
  state: SettleCardState;
  label: string;
  /** The big number, or null when the state shows none. */
  amountCents: number | null;
  /** Status lines under the amount. */
  lines: CardLine[];
  primary: SettleButton | null;
  /** Muted captions under the primary button (handle line, web line). */
  notes: string[];
  secondary: SettleButton[];
};

export type SettleViewInput = {
  plan: SettlePlanWithEarly;
  nameOf: NameOf;
  viewerId: string;
  hostId: string;
  /** bills.payer_id (blocked plans don't carry it). */
  payerId: string;
  /** How extras are split (for the even-mode blocked line, SE-UX-8). */
  extrasMode: ExtrasMode;
  /** The payer's Venmo username, or null. */
  payerVenmo: string | null;
  /** The viewer has an "I paid" on this bill (blocked plans don't carry marks). */
  viewerMarked: boolean;
  openedVenmo: OpenedVenmo | null;
  /** Platform.OS */
  platform: string;
  /** The viewer's own claimed item names (claimedItemNames), for the Venmo note only (spec N4). */
  viewerItemNames: readonly string[];
  /** Any participant's saved Venmo username, or null (request spec Task 2; the payer's Request buttons). */
  venmoOf: (userId: string) => string | null;
  /** Any participant's own claimed item names, for their request's note (VN-2: never someone else's). */
  itemNamesOf: (userId: string) => readonly string[];
};

/**
 * The Settle view input for one version of server data (request spec F1). Both the Settle page and
 * the bill screen's footer build it here, from `data` as fetched, never from optimistic claims.
 */
export function settleViewInputFor(data: BillData, viewerId: string, platform: string, openedVenmo: OpenedVenmo | null): SettleViewInput {
  const payerId = payerIdOf(data);
  const marks = Object.fromEntries(data.participants.map((p) => [p.userId, p.mark]));
  const split = splitInputFor(data, data.claims);
  // SE-1: proportional bills open settling per person once they've claimed an item. To reverse it,
  // drop `allowEarly` here (and mark_paid's rule E in SQL).
  const plan = settlePlan(split, payerId, marks, { allowEarly: true });
  const venmo = new Map(data.participants.map((p) => [p.userId, p.venmoUsername]));
  const venmoOf = (userId: string) => venmo.get(userId) ?? null;
  const me = data.participants.find((p) => p.userId === viewerId);
  return {
    plan,
    nameOf: makeNameOf(data.participants, viewerId),
    viewerId,
    hostId: data.bill.host_id,
    payerId,
    extrasMode: split.extrasMode,
    payerVenmo: venmoOf(payerId),
    viewerMarked: Boolean(me?.mark),
    openedVenmo,
    platform,
    viewerItemNames: claimedItemNames(data.rows, data.claims, viewerId),
    venmoOf,
    itemNamesOf: (userId) => claimedItemNames(data.rows, data.claims, userId),
  };
}

const backButton: SettleButton = { label: SETTLE_COPY.backToBill, a11yLabel: SETTLE_COPY.backToBill, action: { kind: 'back' } };

function payButton(payer: string, handle: string, url: string, payerId: string, cents: number): SettleButton {
  const label = payButtonText(payer, cents);
  return {
    label,
    a11yLabel: `${label}, to @${handle}`,
    a11yHint: SETTLE_COPY.opensVenmo,
    action: { kind: 'pay', url, payerId, cents },
  };
}

function markButton(label: string, payerId: string, cents: number): SettleButton {
  return { label, a11yLabel: label, a11yHint: SETTLE_COPY.markHint, action: { kind: 'mark', payerId, cents } };
}

function card(state: SettleCardState, label: string, rest: Partial<Omit<SettleCardModel, 'state' | 'label'>> = {}): SettleCardModel {
  return { state, label, amountCents: null, lines: [], primary: null, notes: [], secondary: [], ...rest };
}

type OwerEntry = Exclude<SettleEntry | SettleEarlyEntry, { role: 'payer' }>;
type PlanPeople = readonly (SettleEntry | SettleEarlyEntry)[];

/** Rule E per person: entries of a 'ready' plan can always settle; 'early' ones carry canSettle. */
function canSettleNow(e: OwerEntry): boolean {
  return 'canSettle' in e ? e.canSettle : true;
}

/** `d` (spec D6, D7): entries with a difference outside the tolerance. Same count Home's markers use. */
function differenceCount(people: PlanPeople): number {
  return people.filter((e) => differenceOf(e) !== null).length;
}

function undoMarkButton(me: OwerEntry & { mark: NonNullable<OwerEntry['mark']> }): SettleButton {
  return {
    label: SETTLE_COPY.undoMark,
    a11yLabel: SETTLE_COPY.undoMarkA11y,
    a11yHint: `Clears your whole I paid of ${formatCents(me.mark.cents)}`,
    action: { kind: 'unmark', userId: me.userId },
  };
}

function markDifferenceButton(userId: string, payerId: string, fromCents: number, toCents: number, cents: number): SettleButton {
  return {
    label: SETTLE_COPY.markDifference,
    a11yLabel: SETTLE_COPY.markDifference,
    a11yHint: `Marks the ${formatCents(cents)} difference as paid`,
    action: { kind: 'mark_difference', userId, payerId, fromCents, toCents },
  };
}

/** Payer's card on a complete bill. Pay-backs owed come before "nobody owes you" (F5, A1.8). */
function payerCard(plan: SettleReady): SettleCardModel {
  const d = differenceCount(plan.people);
  const diffLine: CardLine = { text: differencesToSettle(d), tone: 'warning', live: true };
  if (d > 0 && plan.owingCount === 0) return card('payer_differences', SETTLE_COPY.payerDifferencesLabel, { lines: [diffLine] });
  if (plan.owingCount === 0) return card('payer_nobody', SETTLE_COPY.payerNobody);
  if (plan.allPaid && d === 0) {
    return card('payer_all_paid', SETTLE_COPY.payerAllPaidLabel, {
      amountCents: plan.collectCents,
      lines: [{ text: payerAllPaidLine(plan.owingCount), tone: 'success', live: true }],
    });
  }
  // The differences line shows whenever d > 0, so the card says what the footer says (review R2).
  return card('payer', payerOwedLabel(plan.owingCount), {
    amountCents: plan.collectCents,
    lines: [{ text: paidOfText(plan.paidCount, plan.owingCount), tone: 'muted', live: true }, ...(d > 0 ? [diffLine] : [])],
  });
}

/** The payer before everything is claimed (A6): no amount, no Request buttons (SE-8). */
function payerEarlyCard(plan: SettleEarly): SettleCardModel {
  const paid = plan.people.filter((e) => e.role !== 'payer' && e.mark !== null).length;
  return card('payer_early', SETTLE_COPY.payerEarlyLabel, {
    lines: [
      { text: footerIncomplete(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' },
      ...(paid > 0 ? [{ text: paidSoFar(paid), tone: 'muted' as const, live: true }] : []),
    ],
  });
}

/** The viewer's mark on a complete bill, with or without a difference (3.3, more_due, more_opened, back_due). */
function markedReadyCard(me: OwerEntry & { mark: NonNullable<OwerEntry['mark']> }, input: SettleViewInput, payerId: string): SettleCardModel {
  const payer = input.nameOf(payerId);
  const web = input.platform === 'web';
  const handle = input.payerVenmo;
  const opened = input.openedVenmo;

  // Contract O: the "Did you pay?" prompt stays while the payer and the mark match; it records what was opened.
  if (opened !== null && opened.kind === 'more' && openedStillMatches(input.plan, input.viewerId, opened)) {
    const toCents = opened.fromCents + opened.cents;
    const url = handle === null ? null : venmoPayUrl({ username: handle, cents: opened.cents, itemNames: input.viewerItemNames });
    return card('more_opened', didYouPayMore(payer, opened.cents), {
      amountCents: opened.cents,
      primary: markDifferenceButton(me.userId, opened.payerId, opened.fromCents, toCents, opened.cents),
      notes: handle === null || url === null ? [] : [handleLine(handle, opened.cents), ...(web ? [SETTLE_COPY.webComputerLine] : [])],
      secondary:
        handle === null || url === null
          ? []
          : [
              {
                label: SETTLE_COPY.openAgain,
                a11yLabel: SETTLE_COPY.openAgain,
                a11yHint: SETTLE_COPY.opensVenmo,
                action: { kind: 'pay_difference', url, payerId: opened.payerId, cents: opened.cents, fromCents: opened.fromCents, toCents },
              },
            ],
    });
  }

  const diff = differenceOf(me);
  if (diff === null) {
    // Within tolerance (B6) or exactly the share: today's 3.3 card.
    return card('marked', paidLabel(payer), {
      amountCents: me.mark.cents,
      lines: [{ text: SETTLE_COPY.markedPaid, tone: 'success', live: true }],
      secondary: [{ label: SETTLE_COPY.undo, a11yLabel: SETTLE_COPY.undoMarkA11y, action: { kind: 'unmark', userId: me.userId } }],
    });
  }

  const summary: CardLine = { text: diffLine(me.owedCents, me.mark.cents), tone: 'muted' };
  const undo = undoMarkButton(me);

  if (diff.kind === 'more') {
    const url = handle === null ? null : venmoPayUrl({ username: handle, cents: diff.cents, itemNames: input.viewerItemNames });
    const record = markDifferenceButton(me.userId, payerId, diff.fromCents, diff.toCents, diff.cents);
    if (handle === null || url === null) {
      return card('more_due', moreLabel(payer), {
        amountCents: diff.cents,
        lines: [summary, { text: noVenmoOwer(payer), tone: 'muted' }],
        primary: record,
        secondary: [undo],
      });
    }
    const label = payMoreText(payer, diff.cents);
    return card('more_due', moreLabel(payer), {
      amountCents: diff.cents,
      lines: [summary],
      primary: {
        label,
        a11yLabel: `${label}, to @${handle}`,
        a11yHint: SETTLE_COPY.opensVenmo,
        action: { kind: 'pay_difference', url, payerId, cents: diff.cents, fromCents: diff.fromCents, toCents: diff.toCents },
      },
      notes: [handleLine(handle, diff.cents), ...(web ? [SETTLE_COPY.webComputerLine] : [])],
      secondary: [record, undo],
    });
  }

  // 'back': the payer owes the viewer. The viewer may nudge with a Request; the payer records it (SE-4, SE-5).
  const lines: CardLine[] = [summary];
  if (me.owedCents < 0) lines.push({ text: backNegativeLine(payer, -me.owedCents), tone: 'muted' });
  const url = handle === null ? null : venmoRequestUrl({ username: handle, cents: diff.cents, itemNames: input.viewerItemNames });
  if (handle === null || url === null) {
    return card('back_due', negativeLabel(payer), {
      amountCents: diff.cents,
      lines: [...lines, { text: backNoVenmo(payer), tone: 'muted' }],
      secondary: [undo],
    });
  }
  return card('back_due', negativeLabel(payer), {
    amountCents: diff.cents,
    lines,
    primary: {
      label: requestBackText(payer, diff.cents),
      a11yLabel: requestA11yLabel(payer, handle, diff.cents),
      a11yHint: SETTLE_COPY.opensVenmo,
      variant: 'secondary',
      action: { kind: 'request', url },
    },
    notes: [handleLine(handle, diff.cents), ...(web ? [SETTLE_COPY.requestWebLine] : [])],
    secondary: [undo],
  });
}

function oweCard(me: OwerEntry, input: SettleViewInput, plan: SettleReady | SettleEarly): SettleCardModel {
  const payerId = plan.payerId;
  const payer = input.nameOf(payerId);
  const web = input.platform === 'web';
  const early = plan.status === 'early';
  // The last line of the head group on every unmarked early card (spec D6).
  const mayChange: CardLine[] = early ? [{ text: mayChangeLine(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' }] : [];

  // A mark wins over the role: whatever the share is now, the person sees what they marked.
  if (me.mark) {
    const marked = { ...me, mark: me.mark };
    if (!early) return markedReadyCard(marked, input, payerId);
    // Early: a difference is settled once everything is claimed (SE-6), so it's an info line only.
    const diff = differenceOf(me);
    return card('marked', paidLabel(payer), {
      amountCents: me.mark.cents,
      lines: [
        { text: SETTLE_COPY.markedPaid, tone: 'success', live: true },
        { text: diff === null ? SETTLE_COPY.earlyMarkedLine : earlyDifferenceLine(me.owedCents, diff, payer), tone: 'muted' },
      ],
      secondary: [{ label: SETTLE_COPY.undo, a11yLabel: SETTLE_COPY.undoMarkA11y, action: { kind: 'unmark', userId: me.userId } }],
    });
  }

  const handle = input.payerVenmo;
  const opened = input.openedVenmo;
  // Contract O, 'share': kept while the payer matches and the viewer is unmarked; amounts are the opened ones.
  if (opened !== null && opened.kind !== 'more' && openedStillMatches(plan, input.viewerId, opened)) {
    const url = handle === null ? null : venmoPayUrl({ username: handle, cents: opened.cents, itemNames: input.viewerItemNames });
    const linked = handle !== null && url !== null;
    return card('owes_opened', didYouPay(payer), {
      amountCents: opened.cents,
      lines: mayChange,
      primary: markButton(SETTLE_COPY.iPaid, opened.payerId, opened.cents),
      notes: linked ? [handleLine(handle, opened.cents), ...(web ? [SETTLE_COPY.webComputerLine] : [])] : [],
      secondary: linked
        ? [
            {
              label: SETTLE_COPY.openAgain,
              a11yLabel: SETTLE_COPY.openAgain,
              a11yHint: SETTLE_COPY.opensVenmo,
              action: { kind: 'pay', url, payerId: opened.payerId, cents: opened.cents },
            },
          ]
        : [],
    });
  }

  if (!canSettleNow(me)) {
    return card('early_not_ready', SETTLE_COPY.blockedLabel, { lines: [{ text: SETTLE_COPY.earlyNoClaim, tone: 'muted' }], primary: backButton });
  }
  if (me.role === 'nothing') {
    return card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }, ...mayChange] });
  }
  if (me.role === 'payer_owes_them') {
    return card('negative', negativeLabel(payer), {
      amountCents: -me.owedCents,
      lines: [{ text: SETTLE_COPY.negativeBody, tone: 'muted' }, ...mayChange],
    });
  }

  const cents = me.owedCents;
  const url = handle === null ? null : venmoPayUrl({ username: handle, cents, itemNames: input.viewerItemNames });
  if (handle === null || url === null) {
    return card('owes_no_venmo', owesLabel(payer), {
      amountCents: cents,
      lines: [{ text: noVenmoOwer(payer), tone: 'muted' }, ...mayChange],
      primary: markButton(SETTLE_COPY.iPaid, payerId, cents),
    });
  }
  return card('owes', owesLabel(payer), {
    amountCents: cents,
    lines: mayChange,
    primary: payButton(payer, handle, url, payerId, cents),
    notes: [handleLine(handle, cents), ...(web ? [SETTLE_COPY.webComputerLine] : [])],
    secondary: [markButton(SETTLE_COPY.alreadyPaid, payerId, cents)],
  });
}

/** The "your part" card for every role and state (brief §3; spec D6). */
export function settleCard(input: SettleViewInput): SettleCardModel {
  const { plan } = input;
  // A blocked plan shows no amounts, but a marked viewer is told their mark isn't lost (M3-UX-10, R6).
  const markSaved: CardLine[] = input.viewerMarked ? [{ text: SETTLE_COPY.blockedMarkSaved, tone: 'muted' }] : [];
  switch (plan.status) {
    case 'blocked': {
      // SE-UX-8: one bill lets you pay early and the next doesn't; say why on an even-split bill.
      const even: CardLine[] = input.extrasMode === 'equal' ? [{ text: SETTLE_COPY.evenBlockedLine, tone: 'muted' }] : [];
      return card('blocked', SETTLE_COPY.blockedLabel, {
        lines: [{ text: blockedBody(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' }, ...even, ...markSaved],
        primary: backButton,
      });
    }
    case 'blocked_all_zero':
      if (input.viewerId === input.hostId) {
        return card('blocked_all_zero', SETTLE_COPY.blockedLabel, {
          lines: [{ text: SETTLE_ALL_ZERO_COPY, tone: 'muted' }, ...markSaved],
          primary: { label: SETTLE_COPY.editItems, a11yLabel: SETTLE_COPY.editItems, a11yHint: SETTLE_COPY.editItemsHint, action: { kind: 'edit' } },
          secondary: [backButton],
        });
      }
      return card('blocked_all_zero', SETTLE_COPY.blockedLabel, {
        lines: [{ text: SETTLE_ALL_ZERO_GUEST_COPY(input.nameOf(input.hostId)), tone: 'muted' }, ...markSaved],
        primary: backButton,
      });
    case 'blocked_bad_payer':
      return card('bad_payer', SETTLE_COPY.badPayer, {
        primary: { label: SETTLE_COPY.tryAgain, a11yLabel: SETTLE_COPY.tryAgain, action: { kind: 'retry' } },
      });
    case 'ready':
    case 'early': {
      if (input.viewerId === plan.payerId) return plan.status === 'ready' ? payerCard(plan) : payerEarlyCard(plan);
      const people: PlanPeople = plan.people;
      const me = people.find((p) => p.userId === input.viewerId);
      // Not on the bill (can't happen: fetchBill is not_found for non-participants).
      if (!me || me.role === 'payer') return card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] });
      return oweCard(me, input, plan);
    }
  }
}

/**
 * The "Add your Venmo" card above the payer's card (§3.8), or null. Shown when someone owes the
 * viewer (ready), or in an early plan once anyone can settle (SE-UX-17).
 */
export function addVenmoPrompt(
  input: Pick<SettleViewInput, 'plan' | 'viewerId' | 'payerVenmo'>,
): { text: string; button: SettleButton & { action: { kind: 'add_venmo' } } } | null {
  const { plan } = input;
  if (plan.status !== 'ready' && plan.status !== 'early') return null;
  if (plan.payerId !== input.viewerId || input.payerVenmo !== null) return null;
  const someonePays =
    plan.status === 'ready' ? plan.owingCount > 0 : plan.people.some((e) => e.role !== 'payer' && e.canSettle);
  if (!someonePays) return null;
  return {
    text: SETTLE_COPY.addVenmoCard,
    button: {
      label: SETTLE_COPY.addVenmoButton,
      a11yLabel: SETTLE_COPY.addVenmoButton,
      a11yHint: SETTLE_COPY.addVenmoHint,
      action: { kind: 'add_venmo' },
    },
  };
}

/** The line under the title, e.g. "Hana paid the bill". None when the payer is unknown (bad payer). */
export function payerLine(input: Pick<SettleViewInput, 'plan' | 'nameOf' | 'payerId'>): string | null {
  if (input.plan.status === 'blocked_bad_payer') return null;
  return payerLineText(input.nameOf(input.payerId));
}

/** "Change" shows only for the host, once at least 2 people are on the bill (§5). */
export function canChangePayer(viewerId: string, hostId: string, participantCount: number, plan: SettlePlanWithEarly): boolean {
  return viewerId === hostId && participantCount >= 2 && plan.status !== 'blocked_bad_payer';
}

// ---------------------------------------------------------------------------
// Everyone list (brief §4)
// ---------------------------------------------------------------------------

export type SettleRowUndo = { userId: string; confirm: boolean; a11yLabel: string; confirmText: string };

/**
 * The payer's Request control on one row (R2): a link (Q1) or a muted caption saying why there is
 * none (Q2–Q4). null on every other row, and on every row for anyone but the payer.
 */
export type SettleRowRequest =
  | {
      kind: 'link';
      /** Who is asked (review R2: a failed open is remembered per person). */
      userId: string;
      url: string;
      cents: number;
      handle: string;
      caption: string;
      label: string;
      a11yLabel: string;
      a11yHint: string;
    }
  | { kind: 'caption'; caption: string };

/**
 * The payer's pay-back controls on a back-due row (spec D6): a Venmo pay link to the person (or a
 * caption saying why there's none), and "I paid it back", which records the difference.
 */
export type SettleRowPayBack = {
  link: SettleRowRequest;
  record: SettleButton & { action: Extract<SettleAction, { kind: 'mark_difference' }> };
};

export type SettleRowModel = {
  userId: string;
  name: string;
  amountCents: number;
  status: { text: string; tone: 'success' | 'muted' | 'warning' } | null;
  subLine: { text: string; tone: 'warning' | 'muted' } | null;
  /** The row's one screen-reader label: everything the row shows that matters. */
  a11yLabel: string;
  /** Q4; on a payer's difference row only when the payer is also the host, on its own line (SE-ENG-13). */
  undo: SettleRowUndo | null;
  /** The payer's Request: the whole share (unmarked), or the difference on a more-due row. */
  request: SettleRowRequest | null;
  /** The payer's pay-back controls on a back-due row, else null. */
  payBack: SettleRowPayBack | null;
};

/**
 * Q1–Q4 for one Venmo link to a participant, seen by the payer. `cents` is a share or a difference
 * as lib/settle.ts gave it (components do no arithmetic). `pay` builds a pay link (pay-back).
 */
function linkFor(
  userId: string,
  cents: number,
  input: SettleViewInput,
  copy: { label: string; a11yLabel: (handle: string) => string; tooLarge: string; pay?: boolean },
): SettleRowRequest {
  const handle = input.venmoOf(userId);
  const build = copy.pay === true ? venmoPayUrl : venmoRequestUrl;
  const url = handle === null ? null : build({ username: handle, cents, itemNames: input.itemNamesOf(userId) });
  // The username rule lives only in venmoLink (review R6): a null link with an amount outside C2 is
  // Q4; any other null link means the username is missing or unusable (Q2, Q3).
  if (handle === null || url === null) {
    return { kind: 'caption', caption: isSettleCents(cents) ? SETTLE_COPY.requestNoVenmo : copy.tooLarge };
  }
  return {
    kind: 'link',
    userId,
    url,
    cents,
    handle,
    caption: `@${handle}`,
    label: copy.label,
    a11yLabel: copy.a11yLabel(handle),
    a11yHint: SETTLE_COPY.opensVenmo,
  };
}

/** Q1–Q4 for an unmarked ower, seen by the payer. The amount is owedCents as is. */
function requestFor(userId: string, name: string, cents: number, input: SettleViewInput): SettleRowRequest {
  return linkFor(userId, cents, input, {
    label: SETTLE_COPY.request,
    a11yLabel: (handle) => requestA11yLabel(name, handle, cents),
    tooLarge: SETTLE_COPY.requestTooLarge,
  });
}

/** SE-VIS-6: `wideStatus` is true when any row shows a difference status. */
export type SettlePeopleModel = { title: string; aside: string | null; rows: SettleRowModel[]; wideStatus: boolean };

type RowBuild = { row: SettleRowModel; wide: boolean };

function rowFor(e: OwerEntry, plan: SettleReady | SettleEarly, input: SettleViewInput): RowBuild {
  const name = input.nameOf(e.userId);
  const payer = input.nameOf(plan.payerId);
  const viewerIsPayer = input.viewerId === plan.payerId;
  const own = e.userId === input.viewerId;
  const amount = formatCents(e.owedCents);
  const base = { userId: e.userId, name, amountCents: e.owedCents, request: null, payBack: null };

  // Q4: the host, the payer and the person can undo. The viewer's own Undo lives on their card only
  // (one home per action), so their row has none.
  const mayUndo = e.mark !== null && !own && (input.viewerId === input.hostId || viewerIsPayer);
  const undo: SettleRowUndo | null = mayUndo
    ? { userId: e.userId, confirm: true, a11yLabel: `Undo ${name}'s I paid`, confirmText: undoOtherConfirm(name) }
    : null;

  if (e.mark) {
    const paid = { text: SETTLE_COPY.rowPaid, tone: 'success' as const };
    const diff = differenceOf(e);
    const marked = formatCents(e.mark.cents);
    const changed = `${name}, marked paid ${marked}, share is now ${amount}`;
    const subText = markSubLine(e.mark.cents, e.owedCents);
    if (diff === null) {
      return { row: { ...base, status: paid, subLine: null, a11yLabel: `${name}, ${amount}, paid`, undo }, wide: false };
    }
    if (plan.status === 'early') {
      // Settled after completion (SE-6): today's row with the warning sub-line, no controls.
      return { row: { ...base, status: paid, subLine: { text: subText, tone: 'warning' }, a11yLabel: changed, undo }, wide: false };
    }
    const subLine = { text: subText, tone: 'muted' as const }; // SE-UX-5: the status already says it
    const d = formatCents(diff.cents);
    // SE-UX-4 + SE-ENG-13: while a difference is open, the payer's Undo gives way to the difference
    // controls, unless the payer is also the host (Undo then sits on its own line below them).
    const rowUndo = viewerIsPayer && input.viewerId !== input.hostId ? null : undo;

    if (diff.kind === 'more') {
      const status = own ? `You owe ${d} more` : `Owes ${d} more`;
      return {
        row: {
          ...base,
          status: { text: status, tone: 'muted' },
          subLine,
          a11yLabel: `${changed}, ${own ? 'you owe' : 'owes'} ${d} more`,
          undo: rowUndo,
          request: viewerIsPayer
            ? linkFor(e.userId, diff.cents, input, {
                label: `Request ${d}`,
                a11yLabel: (handle) => `Request ${d} more from ${name} on Venmo, @${handle}`,
                tooLarge: SETTLE_COPY.requestTooLarge,
              })
            : null,
        },
        wide: true,
      };
    }

    // 'back': the payer owes this person.
    if (viewerIsPayer) {
      return {
        row: {
          ...base,
          status: { text: `You owe ${d} back`, tone: 'warning' }, // the payer has to act
          subLine,
          a11yLabel: `${changed}, you owe ${name} ${d} back`,
          undo: rowUndo,
          payBack: {
            link: linkFor(e.userId, diff.cents, input, {
              label: `Pay ${d} back`,
              a11yLabel: (handle) => `Pay ${name} ${d} back on Venmo, to @${handle}`,
              tooLarge: SETTLE_COPY.payBackTooLarge,
              pay: true,
            }),
            record: {
              label: SETTLE_COPY.paidItBack,
              a11yLabel: `Mark that you paid ${name} ${d} back`,
              a11yHint: diff.toCents === 0 ? `Clears ${name}'s I paid` : `Changes ${name}'s I paid to ${formatCents(diff.toCents)}`,
              action: { kind: 'mark_difference', userId: e.userId, payerId: plan.payerId, fromCents: diff.fromCents, toCents: diff.toCents },
            },
          },
        },
        wide: true,
      };
    }
    return {
      row: {
        ...base,
        status: { text: own ? `${payer} owes you ${d} back` : `${payer} owes ${d} back`, tone: 'muted' },
        subLine,
        a11yLabel: own ? `${changed}, ${payer} owes you ${d} back` : `${changed}, ${payer} owes ${name} ${d} back`,
        undo: rowUndo,
      },
      wide: true,
    };
  }

  if (e.role === 'payer_owes_them') {
    const back = formatCents(-e.owedCents);
    const text = viewerIsPayer
      ? `You owe ${name} ${back}. Settle that outside the app.`
      : `${payer} owes ${name}. Settle outside the app.`;
    const a11y = viewerIsPayer
      ? `${name}, you owe ${name} ${back}, settle outside the app`
      : `${name}, ${payer} owes ${name} ${back}, settle outside the app`;
    return { row: { ...base, status: null, subLine: { text, tone: 'muted' }, a11yLabel: a11y, undo: null }, wide: false };
  }

  return {
    row: {
      ...base,
      status: { text: SETTLE_COPY.rowNotYet, tone: 'muted' },
      subLine: null,
      a11yLabel: `${name}, ${amount}, not paid yet`,
      undo: null,
      // Only 'owes' reaches here unmarked ('nothing' rows are listed only with a mark). No Request
      // before the bill is complete (SE-8).
      request: viewerIsPayer && plan.status === 'ready' && e.role === 'owes' ? requestFor(e.userId, name, e.owedCents, input) : null,
    },
    wide: false,
  };
}

/**
 * The Everyone list, or null when it isn't shown (blocked plans, or nobody to list). Rows: people
 * who owe and negative shares, plus a 'nothing' person who has a mark; in an early plan only people
 * with an item claim or a mark. Never the payer. The viewer first, then plan order, so rows don't
 * move when someone pays (M3-UX-12).
 */
export function settlePeople(input: SettleViewInput): SettlePeopleModel | null {
  const { plan } = input;
  if (plan.status !== 'ready' && plan.status !== 'early') return null;
  const people: PlanPeople = plan.people;
  const listed = people.filter(
    (e): e is OwerEntry =>
      e.role !== 'payer' && (e.role !== 'nothing' || e.mark !== null) && (canSettleNow(e) || e.mark !== null),
  );
  if (listed.length === 0) return null;
  const ordered = [...listed.filter((e) => e.userId === input.viewerId), ...listed.filter((e) => e.userId !== input.viewerId)];
  // The payer's card already says "1 of 2 paid" right above, so their list has no aside (review R4).
  // An early plan has no aside either (people can still be claiming).
  const viewerIsPayer = input.viewerId === plan.payerId;
  const aside =
    plan.status !== 'ready' || plan.owingCount === 0 || viewerIsPayer
      ? null
      : plan.allPaid
        ? SETTLE_COPY.allPaidAside
        : paidOfText(plan.paidCount, plan.owingCount);
  const built = ordered.map((e) => rowFor(e, plan, input));
  return { title: SETTLE_COPY.everyoneTitle, aside, rows: built.map((b) => b.row), wideStatus: built.some((b) => b.wide) };
}

/**
 * The web line under the list: web, the payer, a ready plan, and at least one link on screen. With a
 * pay-back link it's the pay-or-request line (SE-UX-11); with Request links only, R3's line. Else null.
 * `people` is settlePeople(input), already built by the caller (review R4: not built twice).
 */
export function settleRequestWebLine(input: SettleViewInput, people: SettlePeopleModel | null): string | null {
  if (input.platform !== 'web' || input.plan.status !== 'ready' || input.viewerId !== input.plan.payerId) return null;
  const rows = people?.rows ?? [];
  if (rows.some((r) => r.payBack?.link.kind === 'link')) return SETTLE_COPY.listVenmoWebLine;
  return rows.some((r) => r.request?.kind === 'link') ? SETTLE_COPY.requestWebLine : null;
}

/** A Pay link that didn't open: what it described (review R2). Screen state, never persisted. */
export type PayOpenFailure = { payerId: string; cents: number; handle: string };

/**
 * "Couldn't open Venmo. Send $X to @y…" only while it still describes the bill: the same payer, the
 * card still asks the viewer to send exactly that amount (their unmarked share, or a "more"
 * difference), and the payer's username is unchanged (review R2). Else null. Stricter than contract
 * O on purpose: this line tells someone how much to send, so it must be current.
 */
export function payOpenFailedLine(input: SettleViewInput, failure: PayOpenFailure | null): string | null {
  if (failure === null || input.payerVenmo !== failure.handle) return null;
  const { plan } = input;
  if ((plan.status !== 'ready' && plan.status !== 'early') || plan.payerId !== failure.payerId) return null;
  const people: PlanPeople = plan.people;
  const me = people.find((p) => p.userId === input.viewerId);
  if (me === undefined || me.role === 'payer') return null;
  const due = me.mark === null ? (me.role === 'owes' && canSettleNow(me) ? me.owedCents : null) : plan.status === 'ready' ? moreDue(me) : null;
  return due === failure.cents ? openFailedText(failure.handle, failure.cents) : null;
}

function moreDue(e: OwerEntry): number | null {
  const diff = differenceOf(e);
  return diff !== null && diff.kind === 'more' ? diff.cents : null;
}

/** A Request link that didn't open: whose, how much, which username (review R2). */
export type RequestOpenFailure = { userId: string; cents: number; handle: string };

/** The request's open-failed line only while that row still offers the same request (review R2). Else null. */
export function requestOpenFailedLine(people: SettlePeopleModel | null, failure: RequestOpenFailure | null): string | null {
  if (failure === null) return null;
  const request = people?.rows.find((r) => r.userId === failure.userId)?.request;
  return request?.kind === 'link' && request.cents === failure.cents && request.handle === failure.handle
    ? requestOpenFailedText(failure.handle, failure.cents)
    : null;
}

// ---------------------------------------------------------------------------
// Payer picker (brief §5)
// ---------------------------------------------------------------------------

export type PickerRow = { userId: string; name: string; checked: boolean };

/** One radio row per participant, the viewer first. */
export function pickerRows(participantIds: readonly string[], payerId: string, viewerId: string, nameOf: NameOf): PickerRow[] {
  const ids = [...participantIds.filter((id) => id === viewerId), ...participantIds.filter((id) => id !== viewerId)];
  return ids.map((userId) => ({ userId, name: nameOf(userId), checked: userId === payerId }));
}

export type PickerDecision =
  | { kind: 'noop' } // the target already is the payer
  | { kind: 'direct'; expectedCleared: number }
  | { kind: 'confirm'; text: string; button: string; expectedCleared: number };

/**
 * What picking `targetId` does, from freshly read data (M3-UX-4). `markedIds` is EVERY participant
 * with a mark on the bill (set_payer clears them all), so expectedCleared is their count.
 * `complete` means people can see Pay buttons right now (a 'ready' plan).
 */
export function pickerDecision(args: {
  targetId: string;
  payerId: string;
  markedIds: readonly string[];
  complete: boolean;
  viewerId: string;
  nameOf: NameOf;
}): PickerDecision {
  const { targetId, payerId, markedIds, nameOf } = args;
  if (targetId === payerId) return { kind: 'noop' };
  const target = nameOf(targetId);
  const button = `Switch to ${target}`;
  const n = markedIds.length;
  if (n > 0) {
    const names = [...markedIds.filter((id) => id !== args.viewerId), ...markedIds.filter((id) => id === args.viewerId)]
      .map(nameOf)
      .join(', ');
    const marks = n === 1 ? '1 "I paid" mark' : `${n} "I paid" marks`;
    return { kind: 'confirm', text: `Switch to ${target}? This clears ${marks} (${names}).`, button, expectedCleared: n };
  }
  if (args.complete) {
    // "paying You" reads wrong when the host is the payer: the viewer is "you" mid-sentence.
    const current = payerId === args.viewerId ? 'you' : nameOf(payerId);
    return { kind: 'confirm', text: `Switch to ${target}? People may already be paying ${current}.`, button, expectedCleared: 0 };
  }
  return { kind: 'direct', expectedCleared: 0 };
}

// ---------------------------------------------------------------------------
// Notices (brief §6) and action errors (brief §3.12)
// ---------------------------------------------------------------------------

/**
 * What the screen last showed, compared on every refetch. `myShareCents` is the viewer's share in a
 * ready/early plan, else null (SE-ENG-2). Optional only so screens that still build the snapshot by
 * hand keep compiling until Task 8 switches them to noticeSnapshot(); absent reads as null.
 */
export type NoticeSnapshot = { payerId: string; myMark: boolean; myShareCents?: number | null };

/** The snapshot for one version of the data, so the screen does no money reads (spec D6). */
export function noticeSnapshot(input: SettleViewInput): NoticeSnapshot {
  const { plan } = input;
  let myShareCents: number | null = null;
  if (plan.status === 'ready' || plan.status === 'early') {
    const people: PlanPeople = plan.people;
    const me = people.find((p) => p.userId === input.viewerId);
    if (me !== undefined && me.role !== 'payer') myShareCents = me.owedCents;
  }
  return { payerId: input.payerId, myMark: input.viewerMarked, myShareCents };
}

export function noticeFor(
  prev: NoticeSnapshot,
  next: NoticeSnapshot,
  ctx: { iChangedPayer: boolean; iUndid: boolean; openedVenmo: OpenedVenmo | null; nameOf: NameOf; viewerId: string },
): string | null {
  if (prev.payerId !== next.payerId) {
    if (ctx.iChangedPayer) return null;
    const lead =
      next.payerId === ctx.viewerId ? "You're now collecting for this bill." : `${ctx.nameOf(next.payerId)} is now collecting for this bill.`;
    const affected = (prev.myMark && !next.myMark) || ctx.openedVenmo?.payerId === prev.payerId;
    const oldIsMe = prev.payerId === ctx.viewerId;
    return affected && !oldIsMe ? `${lead} If you already paid ${ctx.nameOf(prev.payerId)}, sort it out with them.` : lead;
  }
  if (prev.myMark && !next.myMark && !ctx.iUndid) {
    // SE-ENG-2 (user, option A): a pay-back to $0 clears the mark, and "undone" would be wrong then.
    // We can't tell it from an Undo, so say nothing when the new share is ≤ $0; Activity has the story.
    const share = next.myShareCents ?? null;
    if (share !== null && share <= 0) return null;
    return SETTLE_COPY.markUndoneBanner;
  }
  return null;
}

/**
 * The banner text for a failed mark, undo, difference or payer change, and whether the screen
 * re-reads. `ctx.difference`: the write was settleDifference ("I paid the difference" / "I paid it
 * back"). There `not_allowed` means the mark moved under the screen (a stale token whose implied
 * direction flipped is refused at the DB's direction check, before the token compare; Task 10a), so
 * it reads like mark_changed and refetches rather than leaving a dead end.
 */
export function actionError(error: BillError, ctx: { difference?: boolean } = {}): { text: string; refetch: boolean } {
  switch (error) {
    case 'payer_changed':
    case 'marks_changed':
      return { text: BILL_ERROR_COPY[error], refetch: true };
    case 'not_complete':
      // SE-UX-13: an early mark fails this way when the host switched to even or the viewer unclaimed.
      return { text: SETTLE_COPY.notCompleteSettle, refetch: true };
    case 'mark_changed':
      return { text: SETTLE_COPY.markChanged, refetch: true };
    case 'not_allowed':
      return ctx.difference === true ? { text: SETTLE_COPY.markChanged, refetch: true } : { text: BILL_ERROR_COPY.not_allowed, refetch: false };
    case 'invalid_bill':
      return { text: SETTLE_COPY.invalidBill, refetch: true };
    case 'not_found':
      return { text: SETTLE_COPY.saveFailed, refetch: true };
    default:
      return { text: SETTLE_COPY.saveFailed, refetch: false };
  }
}

// ---------------------------------------------------------------------------
// Bill screen footer entry (brief §7, Task 10)
// ---------------------------------------------------------------------------

export type SettleFooterModel = {
  variant: 'primary' | 'secondary';
  caption: string | null;
  a11yHint: string;
  /** 'success': a mark confirmation, drawn with a check (review R3). Absent: a plain caption. */
  tone?: 'success';
  /** Announced when it appears. Only the exact "Marked paid"; counts would speak on every claim tap. */
  live?: true;
};

/** "Settle up" in the bill screen's footer, or null with fewer than 2 participants. */
export function settleFooter(participantCount: number, unclaimedRows: number, unclaimedDiscountRows = 0): SettleFooterModel | null {
  if (participantCount < 2) return null;
  if (unclaimedRows > 0) {
    const caption = footerIncomplete(unclaimedRows, unclaimedDiscountRows);
    return { variant: 'secondary', caption, a11yHint: `${caption} first` };
  }
  return { variant: 'primary', caption: null, a11yHint: SETTLE_COPY.settleUpHintReady };
}

export type FooterLink = { label: string; a11yLabel: string; a11yHint: string };
type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;

/**
 * The bill screen's footer (request spec F1):
 * - null: F-a (fewer than 2 people).
 * - 'settle': today's "Settle up" button (F-b secondary with "N left to claim", F-e primary with
 *   "Marked paid", F-f primary).
 * - 'pay': F-c, the Settle card's own Pay button and notes, plus Details.
 * - 'did_you_pay': F-d, the card's "Did you pay?" with I paid; Not yet clears openedVenmo (component state).
 */
export type SettleFooterAction =
  /** `early`: an early-plan footer whose count billFooterAction refreshes from the screen (spec D6). */
  | ({ kind: 'settle'; early?: 'pay' | 'marked' } & SettleFooterModel)
  | { kind: 'pay'; button: SettleButton & { action: PayAction }; notes: string[]; details: FooterLink }
  | { kind: 'did_you_pay'; text: string; iPaid: SettleButton & { action: MarkAction }; notYet: { label: string; a11yLabel: string }; details: FooterLink };

const DETAILS_LINK: FooterLink = { label: SETTLE_COPY.details, a11yLabel: SETTLE_COPY.detailsA11y, a11yHint: SETTLE_COPY.detailsHint };

function hasPay(b: SettleButton | null): b is SettleButton & { action: PayAction } {
  return b !== null && b.action.kind === 'pay';
}
function hasMark(b: SettleButton | null): b is SettleButton & { action: MarkAction } {
  return b !== null && b.action.kind === 'mark';
}

/** The early footers (SE-UX-9): primary "You can pay now · …" or secondary "Marked paid · …". */
function earlyFooter(early: 'pay' | 'marked', rows: number, discountRows: number): SettleFooterAction {
  const left = footerIncomplete(rows, discountRows);
  return early === 'pay'
    ? { kind: 'settle', variant: 'primary', caption: `You can pay now · ${left}`, a11yHint: `You can pay your share now. ${left}`, early }
    : { kind: 'settle', variant: 'secondary', caption: `${SETTLE_COPY.markedPaid} · ${left}`, a11yHint: `${left} first`, early, tone: 'success' };
}

/** F-d: the card's "Did you pay?" and its I paid (contract O), or null if the card has no mark button. */
function didYouPayFooter(cardModel: SettleCardModel): SettleFooterAction | null {
  if (!hasMark(cardModel.primary)) return null;
  return {
    kind: 'did_you_pay',
    text: cardModel.label,
    iPaid: cardModel.primary,
    notYet: { label: SETTLE_COPY.rowNotYet, a11yLabel: SETTLE_COPY.rowNotYet },
    details: DETAILS_LINK,
  };
}

/** The footer, derived from the same settleCard the Settle page shows, so the fallbacks can't drift (F1). */
export function settleFooterAction(input: SettleViewInput, participantCount: number): SettleFooterAction | null {
  const { plan } = input;
  const incomplete = plan.status === 'blocked' || plan.status === 'early';
  const unclaimed = incomplete ? plan.unclaimedRows : 0;
  const unclaimedDiscounts = incomplete ? plan.unclaimedDiscountRows : 0;
  const base = settleFooter(participantCount, unclaimed, unclaimedDiscounts);
  if (base === null) return null; // F-a
  const settle: SettleFooterAction = { kind: 'settle', ...base }; // F-b (blocked, early) or F-f
  if (plan.status === 'early') {
    // Still no Pay in the footer before the bill is complete: paying early happens on Settle up (SE-9).
    // But a Pay already opened keeps its "Did you pay?" under contract O, as the card does (review R5).
    const cardModel = settleCard(input);
    const state = cardModel.state;
    if (state === 'owes_opened') return didYouPayFooter(cardModel) ?? earlyFooter('pay', unclaimed, unclaimedDiscounts);
    if (state === 'owes' || state === 'owes_no_venmo') return earlyFooter('pay', unclaimed, unclaimedDiscounts);
    if (state === 'marked') return earlyFooter('marked', unclaimed, unclaimedDiscounts);
    return settle;
  }
  if (plan.status !== 'ready') return settle;

  const cardModel = settleCard(input);
  const payer = input.nameOf(plan.payerId);
  const diffFooter = (caption: string): SettleFooterAction => ({ ...settle, caption, a11yHint: SETTLE_COPY.differenceHint });
  switch (cardModel.state) {
    case 'more_due':
    case 'more_opened':
      return cardModel.amountCents === null ? settle : diffFooter(`You owe ${payer} ${formatCents(cardModel.amountCents)} more`);
    case 'back_due':
      return cardModel.amountCents === null ? settle : diffFooter(`${payer} owes you ${formatCents(cardModel.amountCents)} back`);
    case 'payer':
    case 'payer_differences':
    case 'payer_all_paid':
    case 'payer_nobody': {
      const d = differenceCount(plan.people);
      return d > 0 ? diffFooter(differencesToSettle(d)) : settle;
    }
    case 'owes':
      return hasPay(cardModel.primary) ? { kind: 'pay', button: cardModel.primary, notes: cardModel.notes, details: DETAILS_LINK } : settle;
    case 'owes_opened':
      return didYouPayFooter(cardModel) ?? settle;
    case 'marked':
      return { ...settle, caption: SETTLE_COPY.markedPaid, tone: 'success', live: true }; // F-e
    default:
      return settle; // F-f
  }
}

/**
 * The footer the bill screen shows (VR-I6). `server` is settleFooterAction over server data (F1);
 * `unclaimedRows` / `unclaimedDiscountRows` are the screen's optimistic counts (displayShares), so
 * "N left to claim" still follows a claim tap at once, as it did before the Pay footer:
 * - rows left on screen → the "N left to claim" footer from those counts (never a Pay, whose amount
 *   would be from before the unclaim);
 * - nothing left on screen but the server still blocked (the last claim is saving) → today's primary
 *   "Settle up" with no count, until the refetch brings the server's Pay / Settle state;
 * - otherwise the server footer unchanged. Pay amounts only ever come from `server`.
 */
export function billFooterAction(
  server: SettleFooterAction | null,
  unclaimedRows: number,
  unclaimedDiscountRows: number,
): SettleFooterAction | null {
  if (server === null) return null; // F-a: settleFooter's participant rule already applied
  // "Did you pay?" records the opened amount, not a current share, so on-screen counts don't replace
  // it (contract O, review R5). The refetch drops it where contract O does.
  if (server.kind === 'did_you_pay') return server;
  // Early footers keep their kind and variant, with the count from the screen (spec D6).
  if (server.kind === 'settle' && server.early !== undefined) {
    if (unclaimedRows > 0) return earlyFooter(server.early, unclaimedRows, unclaimedDiscountRows);
    return { kind: 'settle', ...(settleFooter(2, 0) as SettleFooterModel) }; // until the refetch lands
  }
  // Any participantCount ≥ 2 gives the same model; the server action exists, so there are ≥ 2.
  if (unclaimedRows > 0) return { kind: 'settle', ...(settleFooter(2, unclaimedRows, unclaimedDiscountRows) as SettleFooterModel) };
  if (server.kind === 'settle' && server.variant === 'secondary') return { kind: 'settle', ...(settleFooter(2, 0) as SettleFooterModel) };
  return server;
}

/**
 * Review R1: the viewer's own change saved, but the refetch meant to bring it back failed, so Pay and
 * I paid would stay disabled. True when some saved change's refetch (`clearAt`) has finished without
 * a version that includes it having landed. Changes still saving (`clearAt` null) don't count.
 */
export function saveRefreshFailed(clearAts: readonly (number | null)[], version: number, finished: number): boolean {
  return clearAts.some((c) => c !== null && c > version && finished >= c);
}


/** Who gets paid on this bill (bills.payer_id). Screens read it through here, never the column. */
export function payerIdOf(data: { bill: { payer_id: string } }): string {
  return data.bill.payer_id;
}

/**
 * What the screen remembers after a Pay or Pay-more link is opened (contract O). Here, so screens
 * never read money fields off actions (criterion 46). Added by Task 8.
 */
export function openedFor(action: Extract<SettleAction, { kind: 'pay' | 'pay_difference' }>): OpenedVenmo {
  return action.kind === 'pay'
    ? { payerId: action.payerId, cents: action.cents }
    : { kind: 'more', payerId: action.payerId, cents: action.cents, fromCents: action.fromCents };
}

/** settleDifference's arguments after the bill id, exactly as the action carries them (Task 8). */
export function differenceArgs(
  action: Extract<SettleAction, { kind: 'mark_difference' }>,
): [userId: string, payerId: string, expectedCents: number, newCents: number] {
  return [action.userId, action.payerId, action.fromCents, action.toCents];
}

/**
 * Contract O (spec D6, F3): whether the "Did you pay?" prompt still holds. The person may already
 * have sent that amount in Venmo, so it follows the payer and the mark, not the current amount:
 * - 'share' (or no kind): the plan is ready, or early with the viewer able to settle; same payer;
 *   the viewer has no mark.
 * - 'more': the plan is ready; same payer; the viewer's mark is still `fromCents`.
 * Otherwise the screen drops it.
 */
export function openedStillMatches(plan: SettlePlanWithEarly, viewerId: string, opened: OpenedVenmo): boolean {
  if ((plan.status !== 'ready' && plan.status !== 'early') || plan.payerId !== opened.payerId) return false;
  const people: PlanPeople = plan.people;
  const me = people.find((p) => p.userId === viewerId);
  if (me === undefined || me.role === 'payer') return false;
  if (opened.kind === 'more') return plan.status === 'ready' && me.mark !== null && me.mark.cents === opened.fromCents;
  return me.mark === null && canSettleNow(me);
}
