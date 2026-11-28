// View models and every string for the Settle up screen. Pure: no React, no I/O.
// Brief: docs/specs/2026-11-24-m3-settle-ux.md §3–§7, §10 (copy). Spec: 2026-11-24-m3-settle-venmo.md,
// Amendment A1, Task 8. Venmo Request buttons and the bill-screen footer:
// docs/specs/2026-11-25-venmo-request-buttons.md (R2, R3, F1, F3). Settling early and paying the
// difference: docs/specs/2026-11-25-settle-early-and-differences.md D6 (Task 6, Amendment A1). Sent via
// Venmo and choosing how you paid: docs/specs/2026-11-26-sent-via-venmo.md D2–D5 (Task 6, Amendment A1;
// copy from the UX brief §12): the method chooser, marks by method, the inline check, Not received.
// Who paid (docs/specs/2026-11-26-who-paid.md, Amendment A1.5, Task 7): the plan comes from
// ledgerSettlePlan. A 'routes' plan (several payers, or money that moved between other people) is
// shown pair by pair: each recipient gets a single-payer plan of the pairs paid to them
// (`recipientPlan`), so every card, row and footer state below works per pair unchanged. A stale split
// is 'blocked_payers'. The payer-change confirms are contract M's (pickerDecision, splitSaveDecision).
//
// Components render what these functions return. They do no money arithmetic and build no money
// sentences: every amount below is integer cents from lib/settle.ts, and every "$" string goes
// through formatCents here.
import { leftToClaim, makeNameOf, splitInputFor, type NameOf } from './billView';
import { BILL_ERROR_COPY, type BillData, type BillError } from './bills';
import { formatCents } from './money';
import type { MovedPayment, PayersMode } from './payers';
import { claimedItemNames, isSettleCents, venmoPayUrl, venmoRequestUrl } from './paylinks';
import { availableMethods, methodMarkLine, methodRowStatus, PAYMENT_METHOD_COPY, PAYMENT_METHODS, type PaymentMethod } from './paymentMethods';
import { sentCheckInline, type SentCheckBlob, type SentCheckInline } from './sentCheck';
import {
  balanceFor,
  differenceOf,
  ledgerSettlePlan,
  NEGATIVE_SHARE_ROLE,
  SETTLE_ALL_ZERO_COPY,
  type BillSettlePlan,
  type SettleBlockedPayers,
  type SettleDifference,
  type SettleEarly,
  type SettleEarlyEntry,
  type SettleEntry,
  type SettleMark,
  type SettleNotReceived,
  type SettlePlanWithEarly,
  type SettleReady,
  type SettleRoutes,
} from './settle';
import type { ExtrasMode } from './split';
import { pairState, type HeldMoney, type Pair } from './transfers';

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
  /** Was "I already paid" (M3-Δ2): method `other`, never remembered. */
  paidAnotherWay: 'Paid another way',
  openAgain: 'Open Venmo again',
  opensVenmo: 'Opens Venmo',
  markedPaid: 'Marked paid',
  undo: 'Undo',
  nothingLabel: "You're all set",
  nothingBody: "You don't owe anything on this bill.",
  negativeBody: 'Settle that outside the app.',
  /** SV-UX-14: "settled up", not "paid" (Venmo sends are only known to have opened). */
  payerAllPaidLabel: "Everyone's settled up. Nice.",
  payerNobody: 'Nobody owes you anything on this bill.',
  addVenmoCard: 'Add your Venmo so people can pay you',
  addVenmoButton: 'Add Venmo',
  addVenmoHint: 'Opens your profile',
  everyoneTitle: 'Everyone',
  allPaidAside: 'All settled up',
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
  // A Pay / cash / "another way" write landed, but every refetch since failed (QA N3): the screen
  // still shows "You owe", so it says the payment is saved and holds Pay until a refetch lands.
  savedNotRefreshed: "Your payment was saved, but we couldn't refresh. Try again before you pay again.",
  // Settle early and differences (spec D6, brief §10). Glyph-free; tone lives on the line (A1.22).
  earlyMarkedLine: "If your share changes, you'll settle the difference here once everything is claimed.",
  earlyNoClaim: 'Claim what you had on the bill, then come back to pay.',
  payerEarlyLabel: 'Waiting for everyone to claim',
  markDifference: 'I paid the difference',
  payerDifferencesLabel: 'You owe money back',
  evenBlockedLine: "Tax and tip are split evenly on this bill, so shares aren't set until then.",
  paidItBack: 'I paid it back',
  payBackTooLarge: 'Pay it back in the Venmo app',
  listVenmoWebLine: 'On a computer? Open Venmo on your phone to pay or request.',
  markChanged: 'Your payment just changed. Check the amount and try again.',
  notCompleteSettle: 'Something on the bill just changed. Check your share and try again.',
  differenceHint: 'See the difference and settle it',
  announceDifference: 'Difference marked paid',
  announcePaidBack: 'Marked paid back',
  // Sent via Venmo (spec D2–D5, brief §12)
  chooserA11y: "How you're paying",
  payHint: 'Opens Venmo and records it as sent',
  cashHint: 'Records that you paid in cash. Nothing opens.',
  permissionLine: "We'll check back in a minute to make sure it went through.",
  sentCheckCard: 'Did it go through?',
  sentCheckYes: 'Yes',
  sentCheckYesA11y: 'Yes, it went through',
  sentCheckUndo: 'No, undo',
  sentCheckUndoA11y: "No, undo. It didn't go through",
  sentUndoGhost: "Didn't go through? Undo",
  fallbackYes: 'Yes, I sent it',
  rowNotReceived: 'Not received',
  notReceivedChanged: 'That payment just changed, so nothing was cleared. Check below.',
  footerPayerSettled: "Everyone's settled up",
  seeWhoPaidHint: 'See who paid',
  alreadyMarked: "You've already marked this. Check below.",
  undoneNotSent: 'Undone. Not marked as sent.',
  undoFailed: "Couldn't undo. Try again.",
  announceAllSet: "You're all set",
  announceCash: 'Marked paid in cash',
  // Who paid (A1.5 S6, D11)
  payersStaleTitle: "Who paid doesn't match the bill total",
  fixPayers: 'Fix who paid',
  fixPayersHint: 'Opens who paid',
  payersStaleFooter: 'Who paid needs fixing',
  splitBlockedLine: 'Settling starts once every item is claimed, because more than one person paid.',
  payingYou: 'Paying you',
} as const;

// Who paid (A1.5)
/** S6: the stale card's line, e.g. "$100.21 of $103.21 is assigned." */
export const payersAssignedLine = (assignedCents: number, totalCents: number) =>
  `${formatCents(assignedCents)} of ${formatCents(totalCents)} is assigned.`;
export const payersHostNeeds = (host: string) => `${host} needs to update it before anyone can settle up.`;
export const payersWaitingFor = (host: string) => `Waiting for ${host}`;
/** M9 / U7: the heading over 2+ owe cards and the bill footer's caption. */
export const oweManyText = (n: number, cents: number) => `You owe ${n} people · ${formatCents(cents)}`;
/** S5, a payer on a split bill. */
export const payerPaidShare = (paidCents: number, shareCents: number) =>
  `You paid ${formatCents(paidCents)} · your share is ${formatCents(shareCents)}`;
/** S5, a non-payer on a split bill: `payers` already joined ("Hana and Sam"). */
export const splitWhyLine = (payers: string, oneTo: string | null) =>
  oneTo === null ? `${payers} split the paying. Your share is split between them.` : `${payers} split the paying. Paying ${oneTo} covers your share.`;
/** U4, the holder's owe card. */
export const includesLine = (cents: number, senders: readonly string[]) =>
  senders.length === 1 ? `Includes ${formatCents(cents)} ${senders[0] ?? ''} sent you.` : `Includes ${formatCents(cents)} that ${senders.length} people sent you.`;
/** U4, the sender's card and footer. `onward` null = several onward recipients. */
export const passedOnLine = (cents: number, holder: string, onward: string | null) =>
  `Your ${formatCents(cents)} to ${holder} still counts. ${holder} passes it on${onward === null ? '' : ` to ${onward}`}.`;

/** A1.5 names rule: up to 3 names, then "Dee, Pat and 2 others". */
function listNames(names: readonly string[]): string {
  const [a = '', b = '', c3 = ''] = names;
  if (names.length <= 1) return a;
  if (names.length === 2) return `${a} and ${b}`;
  if (names.length === 3) return `${a}, ${b} and ${c3}`;
  return `${a}, ${b} and ${names.length - 2} others`;
}

/** A name in the middle of a sentence: the viewer is "you", not "You" (S13). */
function midName(nameOf: NameOf, viewerId: string, id: string): string {
  return id === viewerId ? 'you' : nameOf(id);
}

/** Upper-cases the first letter (a sentence that starts with "you"). */
function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}


export const owesLabel = (payer: string) => `You owe ${payer}`;
export const payButtonText = (payer: string, cents: number) => `Pay ${payer} ${formatCents(cents)} on Venmo`;
export const handleLine = (handle: string, cents: number) => `@${handle} · ${formatCents(cents)}`;
/** Contract O's label (A1): what the person was about to send, named once. */
export const didYouSend = (payer: string, cents: number) => `Did you send ${payer} ${formatCents(cents)}?`;
export const paidLabel = (payer: string) => `You paid ${payer}`;
export const sentLabel = (payer: string) => `You sent ${payer}`;
/** SV-29 cash-only head line ("Paid another way" sits right below, so it isn't repeated). */
export const noVenmoOwer = (payer: string) => `${payer} hasn't added Venmo yet.`;
export const cashButtonText = (payer: string, cents: number) => `I paid ${payer} ${formatCents(cents)} in cash`;
export const cashMoreText = (cents: number) => `I paid the ${formatCents(cents)} in cash`;
export const otherWayHint = (payer: string) => `Records that you paid ${payer} outside SplitIt`;
export const allSetLine = (payer: string) => `You're all set. ${payer} can see it.`;
export const sentCheckFull = (payer: string, cents: number) =>
  payer.trim() === '' ? `Did your ${formatCents(cents)} go through?` : `Did your ${formatCents(cents)} to ${payer} go through?`;
export const sentCheckChangedText = (payer: string) => `Your payment to ${payer} changed since then, so nothing was undone. Check below.`;
/** Review R5: what a "more" landing says, by method ("Sent $1.10 more" for Venmo; never "Paid"). */
export const announceDifferenceText = (method: PaymentMethod, cents: number) =>
  method === 'venmo' ? `Sent ${formatCents(cents)} more` : SETTLE_COPY.announceDifference;
export const announceSentText = (payer: string, cents: number) => `Sent to ${payer}, ${formatCents(cents)}`;
export const announceNotReceivedText = (name: string) => `Marked not received. ${name} will see it.`;
/** "Clears Sent via Venmo for $15.10": what an Undo takes away, in the card's own words. */
const clearsHint = (method: PaymentMethod, cents: number) => `Clears ${methodMarkLine(method)} for ${formatCents(cents)}`;
/** The whole-mark undo, worded as what happened: the payment didn't go through. */
export const undoAllText = (cents: number) => `${formatCents(cents)} payment didn't go through`;
/** D4: Sam's warning line, by the cleared mark's method. */
export const notReceivedLine = (payer: string, flag: SettleNotReceived) => {
  const amount = formatCents(flag.cents);
  if (flag.method === 'venmo') return `${payer} hasn't received your ${amount}. Check Venmo before paying again.`;
  if (flag.method === 'cash') return `${payer} hasn't received your ${amount} in cash.`;
  return `${payer} hasn't received your ${amount}.`;
};
export const footerNotReceived = (payer: string, cents: number) => `${payer} hasn't received your ${formatCents(cents)}`;
/** SV-UX-12: the ready marked footer caption, by method. */
export const footerMarked = (payer: string, mark: SettleMark) => {
  const amount = formatCents(mark.cents);
  if (mark.method === 'venmo') return `Sent to ${payer} · ${amount}`;
  if (mark.method === 'cash') return `Paid ${payer} in cash · ${amount}`;
  return `Marked paid · ${amount}`;
};
export const rowNotReceivedSub = (cents: number) => `Not received · ${formatCents(cents)}`;
export const notReceivedConfirm = (name: string, cents: number) =>
  `Didn't get ${name}'s ${formatCents(cents)}? This clears it and lets ${name} know.`;
export const negativeLabel = (payer: string) => `${payer} owes you`;
export const payerOwedLabel = (n: number) => (n === 1 ? '1 person owes you' : `${n} people owe you`);
export const paidOfText = (paid: number, n: number) => `${paid} of ${n} settled up`;
const METHOD_COUNT: Record<PaymentMethod, (n: number) => string> = {
  venmo: (n) => `${n} sent via Venmo`,
  cash: (n) => `${n} paid in cash`,
  other: (n) => `${n} marked paid`,
};
const METHOD_ONE: Record<PaymentMethod, (name: string) => string> = {
  venmo: (name) => `${name} sent it via Venmo`,
  cash: (name) => `${name} paid in cash`,
  other: (name) => `${name} marked it paid`,
};
/**
 * The payer's finish line (SV-UX-14): how everyone settled, counts by method in the list's order;
 * with one ower, a sentence naming them. The payer is never an ower, so never "You".
 */
export function payerAllPaidLine(marks: readonly { name: string; method: PaymentMethod }[]): string {
  const only = marks.length === 1 ? marks[0] : undefined;
  if (only !== undefined) return METHOD_ONE[only.method](only.name);
  return PAYMENT_METHODS.map((m) => [m, marks.filter((x) => x.method === m).length] as const)
    .filter(([, n]) => n > 0)
    .map(([m, n]) => METHOD_COUNT[m](n))
    .join(' · ');
}
export const blockedBody = (rows: number, discountRows = 0) => {
  const left = leftToClaim(rows, discountRows);
  const what = left.every === 'everything' ? 'everything is claimed' : `${left.every} is claimed`;
  return `You can settle up once ${what} (${left.count} left).`;
};
export const SETTLE_ALL_ZERO_GUEST_COPY = (host: string) => `Every item is $0. Ask ${host} to fix the prices.`;
export const openFailedText = (handle: string, cents: number) =>
  `Couldn't open Venmo. Send ${formatCents(cents)} to @${handle} in the Venmo app, then tap Paid another way.`;
/** The payer's Pay back didn't open (9a): the next step is the row's "I paid it back", not "Paid another way". */
export const payBackOpenFailedText = (handle: string, cents: number) =>
  `Couldn't open Venmo. Send ${formatCents(cents)} to @${handle} in the Venmo app, then tap ${SETTLE_COPY.paidItBack}.`;
export const requestA11yLabel = (name: string, handle: string, cents: number) =>
  `Request ${formatCents(cents)} from ${name} on Venmo, @${handle}`;
export const requestOpenFailedText = (handle: string, cents: number) =>
  `Couldn't open Venmo. Request ${formatCents(cents)} from @${handle} in the Venmo app.`;
export const undoOtherConfirm = (name: string) => `Undo ${name}'s "I paid"?`;
export const footerIncomplete = (rows: number, discountRows = 0) => `${leftToClaim(rows, discountRows).count} left to claim`;

// Settle early (spec D6, brief §10)
export const mayChangeLine = (rows: number, discountRows = 0) =>
  `Your share may change until everything is claimed (${leftToClaim(rows, discountRows).count} left).`;
export const paidSoFar = (n: number) => `${n} settled up so far`;
/** A marked early card whose share moved: which way and how much, settled after completion (SE-UX-2). */
export const earlyDifferenceLine = (owedCents: number, diff: SettleDifference, payer: string) =>
  diff.kind === 'more'
    ? `Your share is now ${formatCents(owedCents)}. You'll pay the ${formatCents(diff.cents)} difference once everything is claimed.`
    : `Your share is now ${formatCents(owedCents)}. ${payer} will owe you ${formatCents(diff.cents)} back once everything is claimed.`;

// Differences on a complete bill (spec D6)
export const moreLabel = (payer: string) => `You owe ${payer} more`;
export const payMoreText = (payer: string, cents: number) => `Pay ${payer} ${formatCents(cents)} more on Venmo`;
/** SV-UX-22: "sent" for a venmo mark, "paid" for cash and other; a 0 mark has no second sentence. */
export const diffLine = (owedCents: number, mark: Pick<SettleMark, 'cents' | 'method'>) => {
  const share = `Your share is now ${formatCents(owedCents)}.`;
  if (mark.cents === 0) return share;
  return `${share} You've ${mark.method === 'venmo' ? 'sent' : 'paid'} ${formatCents(mark.cents)}.`;
};
/** diffLine for one pair of a routes plan: the pair's target, which isn't the viewer's share. */
export const routeDiffLine = (targetCents: number, mark: Pick<SettleMark, 'cents' | 'method'>, payer: string) => {
  const due = `It's now ${formatCents(targetCents)} to ${payer}.`;
  if (mark.cents === 0) return due;
  return `${due} You've ${mark.method === 'venmo' ? 'sent' : 'paid'} ${formatCents(mark.cents)}.`;
};
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
 * (spec D6; sent-via-Venmo D2): 'share' (or no kind) is their whole share; 'more' is a difference on
 * top of the mark `fromCents`. The "Did you send?" prompt stays while openedStillMatches holds. Task 9a
 * sets it only when the write's outcome is unknown, on desktop web, or when the mobile-web tab closed.
 */
export type OpenedVenmo =
  | { kind?: 'share'; payerId: string; cents: number }
  | { kind: 'more'; payerId: string; cents: number; fromCents: number };

/** The inline check's facts (lib/sentCheck.ts), carried by its two answers so screens recompute nothing. */
type SentCheckFacts = SentCheckInline;

export type SettleAction =
  /** Opens Venmo for the whole share. Only the "Pay … on Venmo" primary and "Open Venmo again" carry it. */
  | { kind: 'pay'; method: 'venmo'; url: string; payerId: string; cents: number; planKey?: string }
  /**
   * markPaid(bill, payerId, cents, method). `confirmsSend`: contract O's "Yes, I sent it", so the
   * screen stores 'yes' for the new mark's check key at once (D2; he has just answered).
   */
  | { kind: 'mark'; method: PaymentMethod; payerId: string; cents: number; confirmsSend?: true; planKey?: string }
  /** Opens Venmo for a difference; the screen then may show "Did you send?" (OpenedVenmo kind 'more'). */
  | { kind: 'pay_difference'; method: 'venmo'; url: string; payerId: string; cents: number; fromCents: number; toCents: number; planKey?: string }
  /** settleDifference(bill, userId, payerId, fromCents, toCents, method), values as shown (never recomputed). */
  | { kind: 'mark_difference'; method: PaymentMethod; userId: string; payerId: string; fromCents: number; toCents: number; planKey?: string }
  /** Opens a Venmo request; never writes anything (VR-6). */
  | { kind: 'request'; url: string }
  /** unmarkPaid(bill, userId, payerId). `payerId` is set on the app's inputs (see stamp). */
  | { kind: 'unmark'; userId: string; payerId?: string }
  /** The payer's Not received (D4): markNotReceived(bill, userId, payerId, expectedCents, expectedAt). */
  | { kind: 'not_received'; userId: string; payerId: string; expectedCents: number; expectedAt: string }
  /** The inline check's answers (D3): Yes stores 'yes'; No, undo runs undoDecision after a re-read. */
  | ({ kind: 'sent_check_yes' } & SentCheckFacts)
  | ({ kind: 'sent_check_undo' } & SentCheckFacts)
  | { kind: 'add_venmo' }
  | { kind: 'back' }
  | { kind: 'edit' }
  | { kind: 'retry' }
  /** S6: the host opens who paid from the stale card. */
  | { kind: 'fix_payers' };

/** `variant: 'secondary'` (outlined) only on the back-due card's Request (SE-VIS-3); absent = filled primary. */
export type SettleButton = { label: string; a11yLabel: string; a11yHint?: string; variant?: 'secondary'; action: SettleAction };

/** Copy carries no status glyphs (P3): the UI draws a Check (success) or TriangleAlert (warning) from `tone`. */
export type CardLine = { text: string; tone: 'muted' | 'success' | 'warning'; live?: boolean };

/** The brief §3 state the card is in. */
export type SettleCardState =
  | 'owes' // 3.1 (Venmo or Cash selected)
  | 'owes_opened' // contract O: "Did you send Hana $15.10?"
  | 'marked' // 3.3 (also marked early, with a line about later)
  | 'more_due' // the share went up after the mark (D6)
  | 'more_opened' // after "Pay … more", contract O
  | 'back_due' // the share went down after the mark
  | 'owes_no_venmo' // cash only (SV-29)
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
  | 'blocked_payers' // who paid doesn't add up to the total (S6)
  | 'bad_payer'; // 3.11

/**
 * The Venmo | Cash choice (D5, SV-UX-1). Null with fewer than two methods. Each option's own label
 * carries the context ("Venmo, how you're paying") because the radiogroup's label may not be read
 * on iOS/Android (SV-T12-2). Rendered between the head lines and the primary.
 */
export type SettleChooser = {
  options: { value: PaymentMethod; label: string; a11yLabel: string }[];
  value: PaymentMethod;
  a11yLabel: string;
};

/** The inline "Did it go through?" (D3). While non-null, `secondary` has no Undo and there's no completion line. */
export type SettleCheck = { question: string; yes: SettleButton; undo: SettleButton };

export type SettleCardModel = {
  state: SettleCardState;
  label: string;
  /** The big number, or null when the state shows none. */
  amountCents: number | null;
  /** Status lines under the amount. */
  lines: CardLine[];
  chooser: SettleChooser | null;
  primary: SettleButton | null;
  /** Muted captions under the primary button (handle line, web line, permission line). */
  notes: string[];
  secondary: SettleButton[];
  check: SettleCheck | null;
};

/** What the inline check needs from the device: the stored answers and the time (D3). */
export type SentCheckContext = {
  answers: SentCheckBlob;
  now: number;
  /** A "more" send this screen just made never asks (A1 F4). */
  lastSend?: 'share' | 'more';
};

export type SettleViewInput = {
  plan: BillSettlePlan;
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
  /**
   * The web app on a phone or tablet (lib/webEnv.ts isMobileWeb). The "On a computer?" lines show
   * on desktop web only (decision SV-WEB-1). Always false off the web.
   */
  mobileWeb: boolean;
  /** The viewer's own claimed item names (claimedItemNames), for the Venmo note only (spec N4). */
  viewerItemNames: readonly string[];
  /** Any participant's saved Venmo username, or null (request spec Task 2; the payer's Request buttons). */
  venmoOf: (userId: string) => string | null;
  /** Any participant's own claimed item names, for their request's note (VN-2: never someone else's). */
  itemNamesOf: (userId: string) => readonly string[];
  /** bills.id: part of the inline check's key. */
  billId: string;
  /** The Venmo/Cash choice remembered on this device (splitit.payMethod.v1), or null. `other` is ignored. */
  rememberedMethod: PaymentMethod | null;
  /** The inline check's device facts, or null (no question: answers not loaded yet, or none apply). */
  sentCheck: SentCheckContext | null;
  /** Native only: notification permission is still undetermined, so the card says we'll check back (SV-UX-7). */
  permissionUndetermined: boolean;
  /**
   * The plan key from ledgerSettlePlan (A1.2): a payment made from this screen is stamped with it.
   * When it's a string, every pay / mark / difference action carries it as `planKey`, and every
   * unmark carries its pair's `payerId`. Absent (test builders) = actions exactly as before.
   */
  planKey?: string | null;
  /** Contract W's mode: 'split' when several people paid (absent = one person). */
  payersMode?: PayersMode;
  /** Set only on the per-pair inputs this module builds for a routes plan. Screens never set it. */
  routeView?: true;
};

/** The device facts a screen adds to one version of server data. Absent = none known yet. */
export type SettleDeviceFacts = Partial<Pick<SettleViewInput, 'rememberedMethod' | 'sentCheck' | 'permissionUndetermined' | 'mobileWeb'>>;

/**
 * The Settle view input for one version of server data (request spec F1). Both the Settle page and
 * the bill screen's footer build it here, from `data` as fetched, never from optimistic claims.
 * Each person's "Not received" flag goes onto the plan (D4), so the card and rows can show it.
 */
export function settleViewInputFor(
  data: BillData,
  viewerId: string,
  platform: string,
  openedVenmo: OpenedVenmo | null,
  device: SettleDeviceFacts = {},
): SettleViewInput {
  const payerId = payerIdOf(data);
  const split = splitInputFor(data, data.claims);
  // SE-1: proportional bills open settling per person once they've claimed an item. To reverse it,
  // drop `allowEarly` here (and mark_paid's rule E in SQL). Rule E′ (no early on a split) is in
  // ledgerSettlePlan. One payer whose payments all involve them gets exactly today's settlePlan.
  const { plan, planKey } = ledgerSettlePlan(
    split,
    { payerId, payers: data.payers, payments: data.payments, flags: data.flags },
    { allowEarly: true },
  );
  const venmo = new Map(data.participants.map((p) => [p.userId, p.venmoUsername]));
  const venmoOf = (userId: string) => venmo.get(userId) ?? null;
  const me = data.participants.find((p) => p.userId === viewerId);
  // The viewer has money out on some pair: to the payer (their mark), or to anyone else (A1.2). A
  // one-person payer's own outgoing entries are pay-backs, never an "I paid", so they don't count.
  const onePersonPayer = viewerId === payerId && data.payers.length === 0;
  const sentOnAPair =
    !onePersonPayer && data.participants.some((p) => p.userId !== viewerId && pairState(data.payments, viewerId, p.userId).net > 0);
  return {
    plan,
    planKey,
    payersMode: data.payers.length > 0 ? 'split' : 'one',
    nameOf: makeNameOf(data.participants, viewerId),
    viewerId,
    hostId: data.bill.host_id,
    payerId,
    extrasMode: split.extrasMode,
    payerVenmo: venmoOf(payerId),
    viewerMarked: Boolean(me?.mark) || sentOnAPair,
    openedVenmo,
    platform,
    mobileWeb: device.mobileWeb ?? false,
    viewerItemNames: claimedItemNames(data.rows, data.claims, viewerId),
    venmoOf,
    itemNamesOf: (userId) => claimedItemNames(data.rows, data.claims, userId),
    billId: data.bill.id,
    rememberedMethod: device.rememberedMethod ?? null,
    sentCheck: device.sentCheck ?? null,
    permissionUndetermined: device.permissionUndetermined ?? false,
  };
}

/**
 * The selected method (D5, SV-18): the remembered one if this payer offers it, else Venmo if offered,
 * else Cash. `other` is never remembered, so it's ignored; a remembered Venmo on a cash-only card is
 * ignored (and kept for the next bill, which is the screen's job).
 */
export function chosenMethod(remembered: PaymentMethod | null, payerVenmo: string | null): PaymentMethod {
  const offered = availableMethods(payerVenmo);
  if (remembered !== null && remembered !== 'other' && offered.includes(remembered)) return remembered;
  return offered[0] ?? 'cash';
}

const backButton: SettleButton = { label: SETTLE_COPY.backToBill, a11yLabel: SETTLE_COPY.backToBill, action: { kind: 'back' } };

function card(state: SettleCardState, label: string, rest: Partial<Omit<SettleCardModel, 'state' | 'label'>> = {}): SettleCardModel {
  return { state, label, amountCents: null, lines: [], chooser: null, primary: null, notes: [], secondary: [], check: null, ...rest };
}

type OwerEntry = Exclude<SettleEntry | SettleEarlyEntry, { role: 'payer' }>;
type MarkedOwer = OwerEntry & { mark: SettleMark };
type PlanPeople = readonly (SettleEntry | SettleEarlyEntry)[];

/** Rule E per person: entries of a 'ready' plan can always settle; 'early' ones carry canSettle. */
function canSettleNow(e: OwerEntry): boolean {
  return 'canSettle' in e ? e.canSettle : true;
}

/** `d` (spec D6, D7): entries with a difference outside the tolerance. Same count Home's markers use. */
function differenceCount(people: PlanPeople): number {
  return people.filter((e) => differenceOf(e) !== null).length;
}

/**
 * D4: the person's "Not received" flag, only while it still applies: they're unmarked and the flag
 * names the plan's current payer. One rule for the card, the footer, the rows and the notice.
 */
function liveFlag(e: OwerEntry, payerId: string): SettleNotReceived | null {
  return e.mark === null && e.notReceived !== null && e.notReceived.toUserId === payerId ? e.notReceived : null;
}

/** The viewer's own entry in a ready/early plan, or null. */
function viewerEntry(input: SettleViewInput): OwerEntry | null {
  const { plan } = input;
  if (plan.status !== 'ready' && plan.status !== 'early') return null;
  const people: PlanPeople = plan.people;
  const me = people.find((p) => p.userId === input.viewerId);
  return me === undefined || me.role === 'payer' ? null : me;
}

/** Can the card offer Venmo for `cents`: a valid username and an amount the link accepts. */
function venmoUrlFor(input: SettleViewInput, cents: number): string | null {
  const handle = input.payerVenmo;
  if (handle === null || !availableMethods(handle).includes('venmo')) return null;
  return venmoPayUrl({ username: handle, cents, itemNames: input.viewerItemNames });
}

function chooserFor(selected: PaymentMethod): SettleChooser {
  // The chooser's segments are the methods with a chooser label (contract M: `other` is the link).
  const options = PAYMENT_METHODS.flatMap((value) => {
    const label = PAYMENT_METHOD_COPY[value].chooserLabel;
    return label === null ? [] : [{ value, label, a11yLabel: `${label}, how you're paying` }];
  });
  return { options, value: selected, a11yLabel: SETTLE_COPY.chooserA11y };
}

/**
 * The "On a computer?" lines are for desktop web only (decision SV-WEB-1): on a phone's browser
 * the person is already on their phone, and the line reads oddly.
 */
function desktopWeb(input: Pick<SettleViewInput, 'platform' | 'mobileWeb'>): boolean {
  return input.platform === 'web' && !input.mobileWeb;
}

/** The notes under a Venmo primary: handle line, then the web line or the permission line (never both). */
function venmoNotes(input: SettleViewInput, cents: number, opts: { permission: boolean }): string[] {
  const handle = input.payerVenmo;
  if (handle === null) return [];
  const web = input.platform === 'web';
  return [
    handleLine(handle, cents),
    ...(desktopWeb(input) ? [SETTLE_COPY.webComputerLine] : []),
    ...(!web && opts.permission && input.permissionUndetermined ? [SETTLE_COPY.permissionLine] : []),
  ];
}

function otherWayButton(payer: string, payerId: string, cents: number): SettleButton {
  return {
    label: SETTLE_COPY.paidAnotherWay,
    a11yLabel: SETTLE_COPY.paidAnotherWay,
    a11yHint: otherWayHint(payer),
    action: { kind: 'mark', method: 'other', payerId, cents },
  };
}

function undoAllButton(me: MarkedOwer): SettleButton {
  const label = undoAllText(me.mark.cents);
  return {
    label,
    a11yLabel: label,
    a11yHint: `Clears your whole ${formatCents(me.mark.cents)} payment, not just the difference`,
    action: { kind: 'unmark', userId: me.userId },
  };
}

/** The marked card's own Undo (hidden while the inline check shows). */
function markUndoButton(me: MarkedOwer): SettleButton {
  const label = me.mark.method === 'venmo' ? SETTLE_COPY.sentUndoGhost : SETTLE_COPY.undo;
  return { label, a11yLabel: label, a11yHint: clearsHint(me.mark.method, me.mark.cents), action: { kind: 'unmark', userId: me.userId } };
}

function markDifferenceButton(
  method: PaymentMethod,
  label: string,
  hint: string,
  args: { userId: string; payerId: string; fromCents: number; toCents: number },
): SettleButton {
  return { label, a11yLabel: label, a11yHint: hint, action: { kind: 'mark_difference', method, ...args } };
}

/** "Yes, I sent it" (contract O): records what was opened as venmo, and answers the check. */
function fallbackYes(payer: string, cents: number, action: SettleAction): SettleButton {
  return { label: SETTLE_COPY.fallbackYes, a11yLabel: SETTLE_COPY.fallbackYes, a11yHint: `Records your ${formatCents(cents)} to ${payer} as sent`, action };
}

/**
 * The inline question for the viewer's mark (D3), or null. One computation for the card and the
 * footer, so answering in either answers both. A difference card never asks.
 */
function checkFor(input: SettleViewInput, me: MarkedOwer, payerId: string, hasDifference: boolean): SentCheckInline | null {
  const ctx = input.sentCheck;
  if (ctx === null) return null;
  return sentCheckInline({ billId: input.billId, payerId, mark: me.mark, hasDifference, lastSend: ctx.lastSend }, ctx.answers, ctx.now);
}

function cardCheck(facts: SentCheckInline): SettleCheck {
  return {
    question: SETTLE_COPY.sentCheckCard,
    yes: { label: SETTLE_COPY.sentCheckYes, a11yLabel: SETTLE_COPY.sentCheckYesA11y, action: { kind: 'sent_check_yes', ...facts } },
    undo: {
      label: SETTLE_COPY.sentCheckUndo,
      a11yLabel: SETTLE_COPY.sentCheckUndoA11y,
      a11yHint: clearsHint('venmo', facts.cents),
      action: { kind: 'sent_check_undo', ...facts },
    },
  };
}

/** Payer's card on a complete bill. Pay-backs owed come before "nobody owes you" (F5, A1.8). */
function payerCard(plan: SettleReady, nameOf: NameOf): SettleCardModel {
  const d = differenceCount(plan.people);
  const diffLineModel: CardLine = { text: differencesToSettle(d), tone: 'warning', live: true };
  if (d > 0 && plan.owingCount === 0) return card('payer_differences', SETTLE_COPY.payerDifferencesLabel, { lines: [diffLineModel] });
  if (plan.owingCount === 0) return card('payer_nobody', SETTLE_COPY.payerNobody);
  if (plan.allPaid && d === 0) {
    // Counts only, from the marks (no money arithmetic): the people who owed, by how they settled.
    const marks = plan.people.flatMap((e) => (e.role === 'owes' && e.mark !== null ? [{ name: nameOf(e.userId), method: e.mark.method }] : []));
    return card('payer_all_paid', SETTLE_COPY.payerAllPaidLabel, {
      amountCents: plan.collectCents,
      lines: [{ text: payerAllPaidLine(marks), tone: 'success', live: true }],
    });
  }
  // The differences line shows whenever d > 0, so the card says what the footer says (review R2).
  return card('payer', payerOwedLabel(plan.owingCount), {
    amountCents: plan.collectCents,
    lines: [{ text: paidOfText(plan.paidCount, plan.owingCount), tone: 'muted', live: true }, ...(d > 0 ? [diffLineModel] : [])],
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

/** The viewer's marked card (ready or early) with no difference due: the label, method line, check or completion. */
function plainMarkedCard(me: MarkedOwer, input: SettleViewInput, payerId: string, early: boolean, extraLine: CardLine | null): SettleCardModel {
  const payer = input.nameOf(payerId);
  const facts = checkFor(input, me, payerId, false);
  const check = facts === null ? null : cardCheck(facts);
  const lines: CardLine[] = [{ text: methodMarkLine(me.mark.method), tone: 'success', live: true }];
  if (early) {
    if (extraLine !== null) lines.push(extraLine);
  } else if (check === null) {
    lines.push({ text: allSetLine(payer), tone: 'muted' });
  }
  return card('marked', me.mark.method === 'venmo' ? sentLabel(payer) : paidLabel(payer), {
    amountCents: me.mark.cents,
    lines,
    check,
    secondary: check === null ? [markUndoButton(me)] : [],
  });
}

/** The viewer's mark on a complete bill, with or without a difference (3.3, more_due, more_opened, back_due). */
function markedReadyCard(me: MarkedOwer, input: SettleViewInput, payerId: string): SettleCardModel {
  const payer = input.nameOf(payerId);
  const handle = input.payerVenmo;
  const opened = input.openedVenmo;

  // Contract O: the "Did you send?" prompt stays while the payer and the mark match; it records what was opened.
  if (opened !== null && opened.kind === 'more' && openedStillMatches(input.plan, input.viewerId, opened)) {
    const toCents = opened.fromCents + opened.cents;
    const url = venmoUrlFor(input, opened.cents);
    const args = { userId: me.userId, payerId: opened.payerId, fromCents: opened.fromCents, toCents };
    return card('more_opened', didYouSend(payer, opened.cents), {
      amountCents: opened.cents,
      primary: fallbackYes(payer, opened.cents, { kind: 'mark_difference', method: 'venmo', ...args }),
      notes: url === null ? [] : venmoNotes(input, opened.cents, { permission: false }),
      secondary:
        url === null
          ? []
          : [
              {
                label: SETTLE_COPY.openAgain,
                a11yLabel: SETTLE_COPY.openAgain,
                a11yHint: SETTLE_COPY.opensVenmo,
                action: { kind: 'pay_difference', method: 'venmo', url, payerId: opened.payerId, cents: opened.cents, fromCents: opened.fromCents, toCents },
              },
            ],
    });
  }

  const diff = differenceOf(me);
  // Within tolerance (B6) or exactly the share: the marked card.
  if (diff === null) return plainMarkedCard(me, input, payerId, false, null);

  // On a routes pair the amount is what's due on this pair, not the viewer's share (A1.2 step 6).
  const summary: CardLine = { text: input.routeView === true ? routeDiffLine(me.owedCents, me.mark, payer) : diffLine(me.owedCents, me.mark), tone: 'muted' };
  const undo = undoAllButton(me);

  if (diff.kind === 'more') {
    const args = { userId: me.userId, payerId, fromCents: diff.fromCents, toCents: diff.toCents };
    const other = markDifferenceButton('other', SETTLE_COPY.markDifference, `Records the ${formatCents(diff.cents)} difference as paid another way`, args);
    const cash = markDifferenceButton('cash', cashMoreText(diff.cents), SETTLE_COPY.cashHint, args);
    const url = venmoUrlFor(input, diff.cents);
    if (url === null) {
      return card('more_due', moreLabel(payer), {
        amountCents: diff.cents,
        lines: [summary, { text: noVenmoOwer(payer), tone: 'muted' }],
        primary: cash,
        secondary: [other, undo],
      });
    }
    const method = chosenMethod(input.rememberedMethod, handle);
    const label = payMoreText(payer, diff.cents);
    const pay: SettleButton = {
      label,
      a11yLabel: `${label}, to @${handle ?? ''}`,
      a11yHint: SETTLE_COPY.payHint,
      action: { kind: 'pay_difference', method: 'venmo', url, payerId, cents: diff.cents, fromCents: diff.fromCents, toCents: diff.toCents },
    };
    return card('more_due', moreLabel(payer), {
      amountCents: diff.cents,
      lines: [summary],
      chooser: chooserFor(method),
      primary: method === 'venmo' ? pay : cash,
      // No permission line: a "more" send never gets a check-in (F4).
      notes: method === 'venmo' ? venmoNotes(input, diff.cents, { permission: false }) : [],
      secondary: [other, undo],
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
    notes: [handleLine(handle, diff.cents), ...(desktopWeb(input) ? [SETTLE_COPY.requestWebLine] : [])],
    secondary: [undo],
  });
}

function oweCard(me: OwerEntry, input: SettleViewInput, plan: SettleReady | SettleEarly): SettleCardModel {
  const payerId = plan.payerId;
  const payer = input.nameOf(payerId);
  const early = plan.status === 'early';
  // The last line of the head group on every unmarked early card (spec D6).
  const mayChange: CardLine[] = early ? [{ text: mayChangeLine(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' }] : [];

  // A mark wins over the role: whatever the share is now, the person sees what they marked.
  if (me.mark) {
    const marked: MarkedOwer = { ...me, mark: me.mark };
    if (!early) return markedReadyCard(marked, input, payerId);
    // Early: a difference is settled once everything is claimed (SE-6), so it's an info line only.
    const diff = differenceOf(me);
    const later: CardLine = { text: diff === null ? SETTLE_COPY.earlyMarkedLine : earlyDifferenceLine(me.owedCents, diff, payer), tone: 'muted' };
    return plainMarkedCard(marked, input, payerId, true, later);
  }

  const opened = input.openedVenmo;
  // Contract O, 'share': kept while the payer matches and the viewer is unmarked; amounts are the opened ones.
  if (opened !== null && opened.kind !== 'more' && openedStillMatches(plan, input.viewerId, opened)) {
    const url = venmoUrlFor(input, opened.cents);
    return card('owes_opened', didYouSend(payer, opened.cents), {
      amountCents: opened.cents,
      lines: mayChange,
      primary: fallbackYes(payer, opened.cents, { kind: 'mark', method: 'venmo', payerId: opened.payerId, cents: opened.cents, confirmsSend: true }),
      notes: url === null ? [] : venmoNotes(input, opened.cents, { permission: false }),
      secondary:
        url === null
          ? []
          : [
              {
                label: SETTLE_COPY.openAgain,
                a11yLabel: SETTLE_COPY.openAgain,
                a11yHint: SETTLE_COPY.opensVenmo,
                action: { kind: 'pay', method: 'venmo', url, payerId: opened.payerId, cents: opened.cents },
              },
            ],
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
  // D4: the payer said the last one never arrived. First line under the amount (SV-UX-2).
  const flag = liveFlag(me, payerId);
  const warning: CardLine[] = flag === null ? [] : [{ text: notReceivedLine(payer, flag), tone: 'warning' }];
  const cash: SettleButton = {
    label: cashButtonText(payer, cents),
    a11yLabel: cashButtonText(payer, cents),
    a11yHint: SETTLE_COPY.cashHint,
    action: { kind: 'mark', method: 'cash', payerId, cents },
  };
  const other = otherWayButton(payer, payerId, cents);
  const url = venmoUrlFor(input, cents);
  if (url === null) {
    return card('owes_no_venmo', owesLabel(payer), {
      amountCents: cents,
      lines: [...warning, { text: noVenmoOwer(payer), tone: 'muted' }, ...mayChange],
      primary: cash,
      secondary: [other],
    });
  }
  const method = chosenMethod(input.rememberedMethod, input.payerVenmo);
  const label = payButtonText(payer, cents);
  const pay: SettleButton = {
    label,
    a11yLabel: `${label}, to @${input.payerVenmo ?? ''}`,
    a11yHint: SETTLE_COPY.payHint,
    action: { kind: 'pay', method: 'venmo', url, payerId, cents },
  };
  return card('owes', owesLabel(payer), {
    amountCents: cents,
    lines: [...warning, ...mayChange],
    chooser: chooserFor(method),
    primary: method === 'venmo' ? pay : cash,
    notes: method === 'venmo' ? venmoNotes(input, cents, { permission: true }) : [],
    secondary: [other],
  });
}

/** The card for one plan without stamping (routes plans go through settleCards). */
function cardFor(input: SettleViewInput): SettleCardModel {
  const { plan } = input;
  // A blocked plan shows no amounts, but a marked viewer is told their mark isn't lost (M3-UX-10, R6).
  const markSaved: CardLine[] = input.viewerMarked ? [{ text: SETTLE_COPY.blockedMarkSaved, tone: 'muted' }] : [];
  switch (plan.status) {
    case 'blocked': {
      // SE-UX-8: one bill lets you pay early and the next doesn't; say why on an even-split bill.
      // Who paid D11 / rule E′: a split bill never settles early, which is the reason to give first.
      const why: CardLine[] =
        input.payersMode === 'split'
          ? [{ text: SETTLE_COPY.splitBlockedLine, tone: 'muted' }]
          : input.extrasMode === 'equal'
            ? [{ text: SETTLE_COPY.evenBlockedLine, tone: 'muted' }]
            : [];
      return card('blocked', SETTLE_COPY.blockedLabel, {
        lines: [{ text: blockedBody(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' }, ...why, ...markSaved],
        primary: backButton,
      });
    }
    case 'blocked_payers':
      return blockedPayersCard(plan, input, markSaved);
    case 'routes':
      // Routes plans are drawn pair by pair (settleCards); this is its first card, unstamped.
      return routeCards(plan, input).cards[0] ?? card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] });
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
      if (input.viewerId === plan.payerId) return plan.status === 'ready' ? payerCard(plan, input.nameOf) : payerEarlyCard(plan);
      const me = viewerEntry(input);
      // Not on the bill (can't happen: fetchBill is not_found for non-participants).
      if (me === null) return card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] });
      return oweCard(me, input, plan);
    }
  }
}

/** The "your part" card for every role and state (brief §3; spec D6; sent-via-Venmo D5; who paid A1.5). */
export function settleCard(input: SettleViewInput): SettleCardModel {
  if (input.plan.status === 'routes') return settleCards(input).cards[0] ?? stamp(cardFor(input), input);
  return stamp(cardFor(input), input);
}

/**
 * Every card the viewer's part of Settle shows (A1.5 M9, S5). One card on every plan but 'routes',
 * where there's one card per pair the viewer pays (larger target first, then name), else the card
 * for what the viewer collects, else "nothing". Only the first card with a filled primary keeps it;
 * later ones are `secondary` until the first is done (M9).
 * - `heading`: "You owe 2 people · $30.00" when the viewer owes 2+ people (contract O's sum).
 * - `why`: a payer's "You paid $60.00 · your share is $33.41" on a split bill (S5), for the header.
 */
export type SettleCardsModel = { heading: string | null; why: string | null; cards: SettleCardModel[] };

export function settleCards(input: SettleViewInput): SettleCardsModel {
  const { plan } = input;
  if (plan.status !== 'routes') return { heading: null, why: null, cards: [stamp(cardFor(input), input)] };
  return routeCards(plan, input);
}

function blockedPayersCard(plan: SettleBlockedPayers, input: SettleViewInput, markSaved: CardLine[]): SettleCardModel {
  const assigned: CardLine = { text: payersAssignedLine(plan.assignedCents, plan.totalCents), tone: 'warning' };
  if (input.viewerId === input.hostId) {
    return card('blocked_payers', SETTLE_COPY.payersStaleTitle, {
      lines: [assigned, ...markSaved],
      primary: { label: SETTLE_COPY.fixPayers, a11yLabel: SETTLE_COPY.fixPayers, a11yHint: SETTLE_COPY.fixPayersHint, action: { kind: 'fix_payers' } },
    });
  }
  return card('blocked_payers', SETTLE_COPY.payersStaleTitle, {
    lines: [assigned, { text: payersHostNeeds(input.nameOf(input.hostId)), tone: 'muted' }, ...markSaved],
  });
}

// ---------------------------------------------------------------------------
// Routes plans, pair by pair (who paid A1.2, A1.5)
// ---------------------------------------------------------------------------

/**
 * The pairs paid to `toId`, as today's single-payer plan with `toId` as the payer: each pair's
 * `fromId` is an entry whose owedCents is the pair's target, with the pair's mark and difference and
 * the flag on that pair. The lead's plan also holds the outside routes (negative shares, WP-30).
 * An early routes plan gives an 'early' plan (canSettle from the routes plan's rule E).
 */
function recipientPlan(plan: SettleRoutes, toId: string): SettleReady | SettleEarly {
  const flagOf = (fromId: string): SettleNotReceived | null => {
    const f = plan.flags.find((x) => x.fromId === fromId && x.toId === toId);
    return f === undefined ? null : { cents: f.cents, method: f.method, toUserId: toId };
  };
  const canSettleOf = (id: string) => plan.people.find((p) => p.userId === id)?.canSettle ?? true;
  const owers: { userId: string; role: Exclude<SettleEntry['role'], 'payer'>; owedCents: number; mark: SettleMark | null; difference: SettleDifference | null }[] = [];
  for (const q of plan.pairs) {
    if (q.toId !== toId) continue;
    const mark = q.mark === null ? null : { cents: q.mark.cents, at: q.mark.at, method: q.mark.method, toUserId: toId };
    // Pairs are oriented so the target is ≥ 0 (a 0 target only exists with a payment on it). With a
    // mark (paid > 0), owedCents is the target and contract D's difference says what's left. With
    // paid ≤ 0 there's no mark, so owedCents is what's still to pay: remaining = target − paid, which
    // includes money the recipient sent the other way (T13, A-29b; balanceFor's rule).
    const owedCents = q.paidCents > 0 ? q.targetCents : q.remainingCents;
    owers.push({ userId: q.fromId, role: owedCents > 0 ? 'owes' : 'nothing', owedCents, mark, difference: q.difference });
  }
  if (toId === plan.leadId) {
    for (const o of plan.outside) {
      if (!owers.some((e) => e.userId === o.toId)) owers.push({ userId: o.toId, role: NEGATIVE_SHARE_ROLE, owedCents: -o.cents, mark: null, difference: null });
    }
  }
  owers.sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
  const payerEntry = { userId: toId, role: 'payer' as const, mark: null, notReceived: null };

  if (plan.early !== null) {
    const people: SettleEarlyEntry[] = [
      payerEntry,
      ...owers.map(({ difference, ...e }): SettleEarlyEntry => {
        const base = { ...e, notReceived: flagOf(e.userId), canSettle: canSettleOf(e.userId) };
        return e.mark === null ? base : { ...base, difference };
      }),
    ];
    return { status: 'early', payerId: toId, unclaimedRows: plan.early.unclaimedRows, unclaimedDiscountRows: plan.early.unclaimedDiscountRows, people };
  }

  let collectCents = 0;
  let owingCount = 0;
  let paidCount = 0;
  const people: SettleEntry[] = [
    payerEntry,
    ...owers.map(({ difference, ...e }): SettleEntry => {
      if (e.role === 'owes') {
        collectCents += e.owedCents;
        owingCount++;
        if (e.mark !== null) paidCount++;
      }
      const base = { ...e, notReceived: flagOf(e.userId) };
      if (e.mark === null) return base;
      const markDiffCents = e.owedCents - e.mark.cents;
      return { ...base, markDiffCents, markDiffers: markDiffCents !== 0, difference };
    }),
  ];
  return { status: 'ready', payerId: toId, people, collectCents, owingCount, paidCount, allPaid: paidCount === owingCount };
}

/** The view input for the pairs paid to `toId`: that person is "the payer" of a single-payer plan. */
function recipientInput(input: SettleViewInput, plan: SettleRoutes, toId: string): SettleViewInput {
  const sub = recipientPlan(plan, toId);
  const me = (sub.people as readonly (SettleEntry | SettleEarlyEntry)[]).find((e) => e.userId === input.viewerId);
  return {
    ...input,
    plan: sub,
    payerId: toId,
    payerVenmo: input.venmoOf(toId),
    viewerMarked: me !== undefined && me.mark !== null,
    routeView: true,
  };
}

/**
 * What the viewer owes on a routes plan, per counterpart, by contract O (balanceFor's rule): a pair
 * they pay (unpaid remaining, or a 'more' difference) or a 'back' they owe as the recipient.
 */
function owedByViewer(plan: SettleRoutes, viewerId: string): { ids: string[]; cents: number } {
  const ids: string[] = [];
  for (const q of plan.pairs) {
    if (q.fromId !== viewerId && q.toId !== viewerId) continue;
    const d = q.difference;
    const amt = q.paidCents > 0 ? (d === null ? 0 : d.kind === 'more' ? d.cents : -d.cents) : q.remainingCents;
    const forViewer = q.fromId === viewerId ? amt : -amt;
    const other = q.fromId === viewerId ? q.toId : q.fromId;
    if (forViewer > 0 && !ids.includes(other)) ids.push(other);
  }
  const b = balanceFor(plan, viewerId);
  return { ids, cents: b.known ? b.owesCents : 0 };
}

/** The viewer's outgoing pairs, in card order: larger target first, then the recipient's name. */
function viewerPairs(plan: SettleRoutes, input: SettleViewInput): Pair[] {
  return plan.pairs
    .filter((q) => q.fromId === input.viewerId)
    .sort((x, y) => {
      if (x.targetCents !== y.targetCents) return y.targetCents - x.targetCents;
      const nx = input.nameOf(x.toId);
      const ny = input.nameOf(y.toId);
      return nx < ny ? -1 : nx > ny ? 1 : x.toId < y.toId ? -1 : x.toId > y.toId ? 1 : 0;
    });
}

/** U4, the sender: "Your $12.00 to Sam still counts. Sam passes it on to Hana.", or null. */
function senderLine(plan: SettleRoutes, input: SettleViewInput, holderId: string): string | null {
  const items = (plan.provenance.passedOnBy[input.viewerId] ?? []).filter((h) => h.kind === 'passed_on' && h.holderId === holderId);
  const cents = items.reduce((sum, h) => sum + h.cents, 0);
  if (cents <= 0) return null;
  const onward = [...new Set(items.flatMap((h) => h.onwardIds))];
  const only = onward.length === 1 ? onward[0] : undefined;
  return passedOnLine(cents, input.nameOf(holderId), only === undefined ? null : midName(input.nameOf, input.viewerId, only));
}

const OWE_STATES: readonly SettleCardState[] = ['owes', 'owes_no_venmo', 'owes_opened'];

function routeCards(plan: SettleRoutes, input: SettleViewInput): SettleCardsModel {
  const viewerId = input.viewerId;
  const nameOf = input.nameOf;
  const isPayer = plan.payers.some((p) => p.userId === viewerId);
  const pairs = viewerPairs(plan, input);
  const cards: SettleCardModel[] = [];
  const usedHeld = new Set<HeldMoney>();
  const held = plan.provenance.heldFor[viewerId] ?? [];

  for (const q of pairs) {
    const sub = recipientInput(input, plan, q.toId);
    const m = stamp(cardFor(sub), sub);
    const extra: CardLine[] = [];
    // U4, the holder: money others sent the viewer that this pair passes on (each item once).
    const here = held.filter((h) => !usedHeld.has(h) && h.onwardIds.includes(q.toId));
    for (const h of here) usedHeld.add(h);
    const heldCents = here.reduce((sum, h) => sum + h.cents, 0);
    if (heldCents > 0 && OWE_STATES.includes(m.state)) {
      extra.push({ text: includesLine(heldCents, [...new Set(here.map((h) => h.senderId))].map(nameOf)), tone: 'muted' });
    }
    const sent = senderLine(plan, input, q.toId);
    if (sent !== null) extra.push({ text: sent, tone: 'muted' });
    cards.push(extra.length === 0 ? m : { ...m, lines: [...m.lines, ...extra] });
  }

  // Negative share: the lead settles it outside the app (WP-30), when no pair to the lead has a card.
  if (plan.outside.some((o) => o.toId === viewerId) && !pairs.some((q) => q.toId === plan.leadId)) {
    const sub = recipientInput(input, plan, plan.leadId);
    cards.push(stamp(cardFor(sub), sub));
  }

  if (cards.length === 0) {
    const collects = isPayer || plan.pairs.some((q) => q.toId === viewerId);
    if (collects) {
      const sub = recipientInput(input, plan, viewerId);
      cards.push(stamp(cardFor(sub), sub));
    } else {
      const me = plan.people.find((p) => p.userId === viewerId);
      cards.push(
        me !== undefined && !me.canSettle
          ? card('early_not_ready', SETTLE_COPY.blockedLabel, { lines: [{ text: SETTLE_COPY.earlyNoClaim, tone: 'muted' }], primary: backButton })
          : card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] }),
      );
    }
  }

  // S5: why a non-payer pays whom on a split bill, on the first card that asks them to pay.
  if (plan.mode === 'split' && !isPayer) {
    const due = pairs.filter((q) => q.remainingCents > 0);
    const i = cards.findIndex((m) => OWE_STATES.includes(m.state));
    const target = cards[i];
    if (target !== undefined && due.length > 0) {
      const payers = listNames(plan.payers.map((p) => midName(nameOf, viewerId, p.userId)));
      const oneTo = due.length === 1 && due[0] !== undefined ? nameOf(due[0].toId) : null;
      cards[i] = { ...target, lines: [...target.lines, { text: splitWhyLine(capital(payers), oneTo), tone: 'muted' }] };
    }
  }

  // M9: one filled button at a time across the cards.
  let filled = false;
  const ordered = cards.map((m) => {
    if (m.primary === null || m.primary.variant !== undefined) return m;
    if (!filled) {
      filled = true;
      return m;
    }
    return { ...m, primary: { ...m.primary, variant: 'secondary' as const } };
  });

  const owed = owedByViewer(plan, viewerId);
  const me = plan.people.find((p) => p.userId === viewerId);
  return {
    heading: owed.ids.length >= 2 ? oweManyText(owed.ids.length, owed.cents) : null,
    why: plan.mode === 'split' && isPayer && me !== undefined ? payerPaidShare(me.paidCents, me.shareCents) : null,
    cards: ordered,
  };
}

// ---------------------------------------------------------------------------
// Stamping (who paid A1.2): the plan key on every write a screen sends, and unmark's pair
// ---------------------------------------------------------------------------

/** Adds the input's plan key to pay / mark / difference actions and the pair's payer to unmark. */
function stampAction<T extends SettleAction>(action: T, input: SettleViewInput): T {
  const key = input.planKey;
  if (typeof key !== 'string') return action;
  switch (action.kind) {
    case 'pay':
    case 'mark':
    case 'pay_difference':
    case 'mark_difference':
      return { ...action, planKey: key };
    case 'unmark':
      return { ...action, payerId: input.payerId };
    default:
      return action;
  }
}

function stampButton<B extends SettleButton>(b: B, input: SettleViewInput): B {
  return { ...b, action: stampAction(b.action, input) };
}

function stamp(m: SettleCardModel, input: SettleViewInput): SettleCardModel {
  if (typeof input.planKey !== 'string') return m;
  return {
    ...m,
    primary: m.primary === null ? null : stampButton(m.primary, input),
    secondary: m.secondary.map((b) => stampButton(b, input)),
  };
}

function stampRow(row: SettleRowModel, input: SettleViewInput): SettleRowModel {
  if (typeof input.planKey !== 'string') return row;
  return {
    ...row,
    undo: row.undo === null ? null : { ...row.undo, payerId: input.payerId },
    payBack: row.payBack === null ? null : { ...row.payBack, record: stampButton(row.payBack.record, input) },
  };
}

/** The plan key a write action carries, or null (send it as p_plan_key). */
export function actionPlanKey(action: SettleAction): string | null {
  return 'planKey' in action && typeof action.planKey === 'string' ? action.planKey : null;
}

/**
 * The "Add your Venmo" card above the payer's card (§3.8), or null. Shown when someone owes the
 * viewer (ready), or in an early plan once anyone can settle (SE-UX-17).
 */
export function addVenmoPrompt(
  input: Pick<SettleViewInput, 'plan' | 'viewerId' | 'payerVenmo'> & Partial<Pick<SettleViewInput, 'venmoOf'>>,
): { text: string; button: SettleButton & { action: { kind: 'add_venmo' } } } | null {
  const { plan } = input;
  let someonePays: boolean;
  if (plan.status === 'routes') {
    // Routes: anyone with a pair still to pay the viewer, who has no Venmo saved.
    const own = input.venmoOf?.(input.viewerId) ?? (input.viewerId === plan.leadId ? input.payerVenmo : null);
    if (own !== null) return null;
    const canSettle = (id: string) => plan.people.find((p) => p.userId === id)?.canSettle ?? true;
    someonePays = plan.pairs.some((q) => q.toId === input.viewerId && q.remainingCents > 0 && canSettle(q.fromId));
  } else {
    if (plan.status !== 'ready' && plan.status !== 'early') return null;
    if (plan.payerId !== input.viewerId || input.payerVenmo !== null) return null;
    someonePays = plan.status === 'ready' ? plan.owingCount > 0 : plan.people.some((e) => e.role !== 'payer' && e.canSettle);
  }
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

/** "Change" shows only for the host, once at least 2 people are on the bill (§5). */
export function canChangePayer(viewerId: string, hostId: string, participantCount: number, plan: BillSettlePlan): boolean {
  return viewerId === hostId && participantCount >= 2 && plan.status !== 'blocked_bad_payer';
}

// ---------------------------------------------------------------------------
// Everyone list (brief §4)
// ---------------------------------------------------------------------------

/** `payerId`: the pair's payer for unmarkPaid, set on the app's inputs (see stamp). */
export type SettleRowUndo = { userId: string; confirm: boolean; a11yLabel: string; confirmText: string; payerId?: string };

/** The payer's Not received link and its inline confirm (D4, SV-UX-13). The action is the confirm's. */
export type SettleRowNotReceived = {
  label: string;
  a11yLabel: string;
  a11yHint: string;
  confirmText: string;
  confirmLabel: string;
  confirmA11yLabel: string;
  cancelLabel: string;
  cancelA11yLabel: string;
  action: Extract<SettleAction, { kind: 'not_received' }>;
};

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
  /** Q4, for the host who isn't the payer only (SV-10: the payer gets `notReceived` instead). */
  undo: SettleRowUndo | null;
  /** The payer's "Not received" on a row marked to them (D4), a TextLink. Never on a row with `undo`. */
  notReceived: SettleRowNotReceived | null;
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

/**
 * SE-VIS-6 + visual §4.1: `wideStatus` is true when any row shows a difference or a method status.
 * `groups` (routes plans only, S4): the rows by recipient, each with a section label ("Paying you",
 * "Paying Sam"), or label null when there's one recipient; `rows` is the same rows in group order.
 */
export type SettlePeopleGroup = { recipientId: string; label: string | null; rows: SettleRowModel[] };
export type SettlePeopleModel = { title: string; aside: string | null; rows: SettleRowModel[]; wideStatus: boolean; groups?: SettlePeopleGroup[] };

type RowBuild = { row: SettleRowModel; wide: boolean };

function rowFor(e: OwerEntry, plan: SettleReady | SettleEarly, input: SettleViewInput): RowBuild {
  const name = input.nameOf(e.userId);
  const payer = input.nameOf(plan.payerId);
  const viewerIsPayer = input.viewerId === plan.payerId;
  const own = e.userId === input.viewerId;
  const amount = formatCents(e.owedCents);
  const base = { userId: e.userId, name, amountCents: e.owedCents, request: null, payBack: null, notReceived: null };

  if (e.mark) {
    const mark = e.mark;
    // SV-10: the payer's control is Not received (only on a mark made to them), everywhere, difference
    // rows included; the host who isn't the payer keeps Undo (Q4). The viewer's own Undo lives on
    // their card only (one home per action), so their row has neither.
    const notReceived: SettleRowNotReceived | null =
      viewerIsPayer && !own && mark.toUserId === input.viewerId ? notReceivedControl(e.userId, name, plan.payerId, mark) : null;
    const undo: SettleRowUndo | null =
      !own && !viewerIsPayer && input.viewerId === input.hostId
        ? { userId: e.userId, confirm: true, a11yLabel: `Undo ${name}'s I paid`, confirmText: undoOtherConfirm(name) }
        : null;
    const controls = { undo, notReceived };
    const status = { text: methodRowStatus(mark.method), tone: 'success' as const };
    const how = ROW_A11Y_HOW[mark.method];
    const diff = differenceOf(e);
    const marked = formatCents(mark.cents);
    const changed = `${name}, marked paid ${marked}, share is now ${amount}`;
    const subText = markSubLine(mark.cents, e.owedCents);
    if (diff === null) {
      return { row: { ...base, status, subLine: null, a11yLabel: `${name}, ${amount}, ${how}`, ...controls }, wide: true };
    }
    if (plan.status === 'early') {
      // Settled after completion (SE-6): the method status with the warning sub-line, no difference controls.
      return { row: { ...base, status, subLine: { text: subText, tone: 'warning' }, a11yLabel: changed, ...controls }, wide: true };
    }
    const subLine = { text: subText, tone: 'muted' as const }; // SE-UX-5: the status already says it
    const d = formatCents(diff.cents);

    if (diff.kind === 'more') {
      const text = own ? `You owe ${d} more` : `Owes ${d} more`;
      return {
        row: {
          ...base,
          status: { text, tone: 'muted' },
          subLine,
          a11yLabel: `${changed}, ${own ? 'you owe' : 'owes'} ${d} more`,
          ...controls,
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
          ...controls,
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
              // A pay-back ignores the method (D1); 'other' is what the app always sends.
              action: { kind: 'mark_difference', method: 'other', userId: e.userId, payerId: plan.payerId, fromCents: diff.fromCents, toCents: diff.toCents },
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
        ...controls,
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

  // D4: after Not received, a muted sub-line (it's the payer's own action, nothing to fix).
  const flag = liveFlag(e, plan.payerId);
  return {
    row: {
      ...base,
      status: { text: SETTLE_COPY.rowNotYet, tone: 'muted' },
      subLine: flag === null ? null : { text: rowNotReceivedSub(flag.cents), tone: 'muted' },
      a11yLabel: `${name}, ${amount}, not paid yet${flag === null ? '' : `, not received ${formatCents(flag.cents)}`}`,
      undo: null,
      // Only 'owes' reaches here unmarked ('nothing' rows are listed only with a mark). No Request
      // before the bill is complete (SE-8).
      request: viewerIsPayer && plan.status === 'ready' && e.role === 'owes' ? requestFor(e.userId, name, e.owedCents, input) : null,
    },
    wide: false,
  };
}

/** How a marked row reads to a screen reader (brief §10.1): "Sam, $15.10, sent via Venmo". */
const ROW_A11Y_HOW: Record<PaymentMethod, string> = { venmo: 'sent via Venmo', cash: 'paid in cash', other: 'marked paid' };

function notReceivedControl(userId: string, name: string, payerId: string, mark: SettleMark): SettleRowNotReceived {
  const amount = formatCents(mark.cents);
  return {
    label: SETTLE_COPY.rowNotReceived,
    a11yLabel: `Not received, ${name}'s ${amount}`,
    a11yHint: `Asks first, then clears it and lets ${name} know`,
    confirmText: notReceivedConfirm(name, mark.cents),
    confirmLabel: SETTLE_COPY.rowNotReceived,
    confirmA11yLabel: `Confirm: ${name}'s ${amount} not received`,
    cancelLabel: SETTLE_COPY.cancel,
    cancelA11yLabel: `Cancel: keep ${name}'s ${amount}`,
    // The mark as fetched is the token (D4 F5): the cents and the exact settled_at string.
    action: { kind: 'not_received', userId, payerId, expectedCents: mark.cents, expectedAt: mark.at },
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
  if (plan.status === 'routes') return routePeople(plan, input);
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
  // "All paid" needs d === 0, the same rule as the payer card and Home's pill. With everyone marked
  // but a difference open, it uses the payer card's differences wording (QA F-1, SE-QA-1).
  const viewerIsPayer = input.viewerId === plan.payerId;
  const d = differenceCount(people);
  const aside =
    plan.status !== 'ready' || plan.owingCount === 0 || viewerIsPayer
      ? null
      : plan.allPaid
        ? d === 0
          ? SETTLE_COPY.allPaidAside
          : differencesToSettle(d)
        : paidOfText(plan.paidCount, plan.owingCount);
  const built = ordered.map((e) => rowFor(e, plan, input));
  return { title: SETTLE_COPY.everyoneTitle, aside, rows: built.map((b) => stampRow(b.row, input)), wideStatus: built.some((b) => b.wide) };
}

/** The entries of a plan the Everyone list shows (as settlePeople's rule), the viewer first. */
function listedEntries(people: PlanPeople, viewerId: string): OwerEntry[] {
  const listed = people.filter(
    (e): e is OwerEntry => e.role !== 'payer' && (e.role !== 'nothing' || e.mark !== null) && (canSettleNow(e) || e.mark !== null),
  );
  return [...listed.filter((e) => e.userId === viewerId), ...listed.filter((e) => e.userId !== viewerId)];
}

/**
 * S4: the Everyone list of a routes plan, grouped by who receives. Groups: the viewer's first, then
 * the payers (lead first), then anyone else who receives (an ex-payer, a pay-back). With two or more
 * groups each has a label and every row's screen-reader label names its recipient.
 */
function routePeople(plan: SettleRoutes, input: SettleViewInput): SettlePeopleModel | null {
  const viewerId = input.viewerId;
  const recipients: string[] = [];
  const add = (id: string) => {
    if (!recipients.includes(id)) recipients.push(id);
  };
  const receives = new Set(plan.pairs.map((q) => q.toId));
  if (plan.outside.length > 0) receives.add(plan.leadId);
  if (receives.has(viewerId)) add(viewerId);
  for (const p of plan.payers) if (receives.has(p.userId)) add(p.userId);
  for (const id of [...receives].sort()) add(id);

  const built = recipients.flatMap((toId) => {
    const sub = recipientInput(input, plan, toId);
    const subPlan = sub.plan as SettleReady | SettleEarly;
    const rows = listedEntries(subPlan.people, viewerId).map((e) => {
      const b = rowFor(e, subPlan, sub);
      return { row: stampRow(b.row, sub), wide: b.wide };
    });
    return rows.length === 0 ? [] : [{ toId, rows }];
  });
  if (built.length === 0) return null;

  const labelled = built.length >= 2;
  const groups: SettlePeopleGroup[] = built.map(({ toId, rows }) => {
    const to = midName(input.nameOf, viewerId, toId);
    return {
      recipientId: toId,
      label: labelled ? (toId === viewerId ? SETTLE_COPY.payingYou : `Paying ${input.nameOf(toId)}`) : null,
      rows: rows.map(({ row }) => (labelled ? { ...row, a11yLabel: withRecipient(row, to) } : row)),
    };
  });

  // The aside: as today, none for anyone who collects, none while early. Counts every pair to pay.
  const collects = receives.has(viewerId) || plan.payers.some((p) => p.userId === viewerId);
  const owing = plan.pairs.filter((q) => q.targetCents > 0);
  const marked = owing.filter((q) => q.paidCents > 0).length;
  const d = plan.pairs.filter((q) => q.difference !== null).length;
  const aside =
    plan.early !== null || collects || owing.length === 0
      ? null
      : marked === owing.length
        ? d === 0
          ? SETTLE_COPY.allPaidAside
          : differencesToSettle(d)
        : paidOfText(marked, owing.length);

  return {
    title: SETTLE_COPY.everyoneTitle,
    aside,
    rows: groups.flatMap((g) => g.rows),
    wideStatus: built.some((g) => g.rows.some((r) => r.wide)),
    groups,
  };
}

/** S4: "Dee, $33.40 to you, not paid yet"; any other label gets "to Sam" after the name. */
function withRecipient(row: SettleRowModel, to: string): string {
  const head = `${row.name}, ${formatCents(row.amountCents)},`;
  if (row.a11yLabel.startsWith(head)) return `${row.name}, ${formatCents(row.amountCents)} to ${to},${row.a11yLabel.slice(head.length)}`;
  const name = `${row.name}, `;
  return row.a11yLabel.startsWith(name) ? `${name}to ${to}, ${row.a11yLabel.slice(name.length)}` : row.a11yLabel;
}

/**
 * The web line under the list: desktop web, the payer, a ready plan, and at least one link on screen. With a
 * pay-back link it's the pay-or-request line (SE-UX-11); with Request links only, R3's line. Else null.
 * `people` is settlePeople(input), already built by the caller (review R4: not built twice).
 */
export function settleRequestWebLine(input: SettleViewInput, people: SettlePeopleModel | null): string | null {
  if (!desktopWeb(input)) return null;
  const { plan } = input;
  // A routes plan: the viewer's own links are the only ones built, so the rows decide.
  if (plan.status !== 'routes' && (plan.status !== 'ready' || input.viewerId !== plan.payerId)) return null;
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
  if (failure === null) return null;
  if (input.plan.status === 'routes') {
    // The pair the failed link was for, if the viewer still pays it.
    const routes = input.plan;
    if (!routes.pairs.some((q) => q.fromId === input.viewerId && q.toId === failure.payerId)) return null;
    return payOpenFailedLine(recipientInput(input, routes, failure.payerId), failure);
  }
  if (input.payerVenmo !== failure.handle) return null;
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

export type PickerDecision =
  | { kind: 'noop' } // the target already is the payer
  | { kind: 'direct' }
  /** A1.5 M8: nothing is cleared, so the button is primary. `title` null = the one-line confirm. */
  | { kind: 'confirm'; title: string | null; text: string; button: string; cancelA11yLabel: string };

/**
 * What switching a one-person bill's payer to `targetId` does (A1.5 confirm table), from freshly
 * read data (M3-UX-4). The ledger keeps every payment (A1.1), so the confirm says where the moved
 * ones go; it never says "clears".
 * - `moved`: contract M, `paymentsMovedBy(pairs, oldPayers, [targetId])`, with amounts.
 * `complete` means people can see Pay buttons right now (a ready plan).
 */
export function pickerDecision(args: {
  targetId: string;
  payerId: string;
  moved: readonly MovedPayment[];
  complete: boolean;
  viewerId: string;
  nameOf: NameOf;
}): PickerDecision {
  const { targetId, payerId, moved, viewerId, nameOf } = args;
  if (targetId === payerId) return { kind: 'noop' };
  const button = `Switch to ${nameOf(targetId)}`;
  const cancelA11yLabel = `Cancel: keep ${midName(nameOf, viewerId, payerId)} as the payer`;
  if (moved.length > 0) {
    const lead = targetId === viewerId ? 'If you become the payer' : `If you switch to ${nameOf(targetId)}`;
    const { title, counts, holders } = movedWords(moved, viewerId, nameOf);
    const onTo = midName(nameOf, viewerId, targetId);
    const pass = moved.length === 1 ? `${holders.verb} it on to ${onTo}` : `${holders.verb} ${formatCents(sumCents(moved))} on to ${onTo}`;
    return { kind: 'confirm', title, text: `${lead}, ${counts}. ${pass}.`, button, cancelA11yLabel };
  }
  if (args.complete) {
    // "paying You" reads wrong when the host is the payer: the viewer is "you" mid-sentence.
    return { kind: 'confirm', title: null, text: `${button}? People may already be paying ${midName(nameOf, viewerId, payerId)}.`, button, cancelA11yLabel };
  }
  return { kind: 'direct' };
}

/**
 * A1.5's split rows: saving amounts that take someone off who paid (`moved`, contract M) asks first;
 * changing amounts while payments exist (`paidIds`: people with a payment on the bill) shows the
 * note above Save. Both from data the screen re-read just before saving.
 */
export function splitSaveDecision(args: {
  moved: readonly MovedPayment[];
  paidIds: readonly string[];
  viewerId: string;
  nameOf: NameOf;
}): { confirm: { title: string; text: string; button: string; cancelA11yLabel: string } | null; note: string | null } {
  const { moved, viewerId, nameOf } = args;
  if (moved.length > 0) {
    const { title, counts, holders } = movedWords(moved, viewerId, nameOf);
    const off = `Saving takes ${holders.object} off who paid.`;
    const pass = moved.length === 1 ? `${holders.verbLower} it on` : `${holders.verbLower} them on`;
    return {
      confirm: { title, text: `${off} ${capital(counts)}, and ${pass}.`, button: 'Save', cancelA11yLabel: 'Cancel: keep who paid as it is' },
      note: null,
    };
  }
  const ids = [...new Set(args.paidIds)];
  if (ids.length === 0) return { confirm: null, note: null };
  const names = capital(listNames(ids.map((id) => midName(nameOf, viewerId, id))));
  return {
    confirm: null,
    note: ids.length === 1 ? `${names} already paid. Their payment still counts after this change.` : `${names} already paid. Their payments still count after this change.`,
  };
}

/** The moved payments' total, in cents. */
function sumCents(moved: readonly MovedPayment[]): number {
  return moved.reduce((sum, m) => sum + m.cents, 0);
}

/**
 * The shared words of the moved-payments confirms: the title ("Dee and Pat already paid you"),
 * what still counts ("their payments still count" / "Pat's $9.00 still counts"), and who passes it on.
 */
function movedWords(
  moved: readonly MovedPayment[],
  viewerId: string,
  nameOf: NameOf,
): { title: string; counts: string; holders: { object: string; verb: string; verbLower: string } } {
  const senders = [...new Set(moved.map((m) => m.fromId))];
  const holderIds = [...new Set(moved.map((m) => m.toId))];
  const holderList = listNames(holderIds.map((id) => midName(nameOf, viewerId, id)));
  const title = `${capital(listNames(senders.map((id) => midName(nameOf, viewerId, id))))} already paid ${holderList}`;
  const only = moved.length === 1 ? moved[0] : undefined;
  let counts: string;
  if (only !== undefined) {
    const whose = only.fromId === viewerId ? 'your' : `${nameOf(only.fromId)}'s`;
    counts = `${whose} ${formatCents(only.cents)} still counts`;
  } else {
    counts = senders.length === 1 && senders[0] === viewerId ? 'your payments still count' : 'their payments still count';
  }
  const holderIsViewer = holderIds.length === 1 && holderIds[0] === viewerId;
  const verbLower = holderIsViewer ? "you'll pass" : `${holderList} will pass`;
  return { title, counts, holders: { object: holderList, verb: capital(verbLower), verbLower } };
}

// ---------------------------------------------------------------------------
// Notices (brief §6) and action errors (brief §3.12)
// ---------------------------------------------------------------------------

/**
 * What the screen last showed, compared on every refetch. `myShareCents` is the viewer's share in a
 * ready/early plan, else null (SE-ENG-2). Optional only so screens that still build the snapshot by
 * hand keep compiling until Task 8 switches them to noticeSnapshot(); absent reads as null.
 */
export type NoticeSnapshot = {
  payerId: string;
  myMark: boolean;
  myShareCents?: number | null;
  /** The viewer's Not received flag applies (D4). Optional like myShareCents; absent reads as false. */
  notReceived?: boolean;
};

/** The snapshot for one version of the data, so the screen does no money reads (spec D6). */
export function noticeSnapshot(input: SettleViewInput): NoticeSnapshot {
  const { plan } = input;
  const me = viewerEntry(input);
  const myShareCents = me === null ? null : me.owedCents;
  const notReceived = me !== null && (plan.status === 'ready' || plan.status === 'early') && liveFlag(me, plan.payerId) !== null;
  return { payerId: input.payerId, myMark: input.viewerMarked, myShareCents, notReceived };
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
    // SV-19: the payer's Not received cleared it, and the card's warning line already says so.
    if (next.notReceived === true) return null;
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
export function actionError(error: BillError, ctx: { difference?: boolean; notReceived?: boolean } = {}): { text: string; refetch: boolean } {
  // The payer's Not received (D4): the mark moved (re-sent, undone, changed), or they're no longer
  // allowed (not the payer any more). Either way the row is stale, so re-read it.
  if (ctx.notReceived === true) {
    if (error === 'mark_changed') return { text: SETTLE_COPY.notReceivedChanged, refetch: true };
    if (error === 'not_allowed') return { text: BILL_ERROR_COPY.not_allowed, refetch: true };
  }
  switch (error) {
    case 'payer_changed':
    case 'marks_changed':
    // Who paid S8: the host changed the total, so who paid no longer adds up. The re-read shows
    // the stale card ("Who paid doesn't match the bill total").
    case 'payers_stale':
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
    case 'invalid_method':
      // Only after a database change to the method list (the app never sends a bad one).
      return { text: BILL_ERROR_COPY.invalid_method, refetch: false };
    case 'busy':
      // Delete group A3.4: a lock clash aborted the write. Nothing changed, so no re-read; the
      // button is free again and a second tap is safe.
      return { text: BILL_ERROR_COPY.busy, refetch: false };
    default:
      return { text: SETTLE_COPY.saveFailed, refetch: false };
  }
}

/**
 * The error line Settle shows next to a card or the list. While the stale card is on screen
 * (`blocked_payers`, S6), payers_stale's banner would only repeat it, so it's dropped; any other
 * line, including the "Venmo opened, but … Don't send it" one, still shows.
 */
export function settleErrorShown(text: string | null, planStatus: BillSettlePlan['status']): string | null {
  return planStatus === 'blocked_payers' && text === BILL_ERROR_COPY.payers_stale ? null : text;
}

/**
 * Review R1, D2 ("write errors after an open … with copy saying to check Venmo"): Venmo is already
 * open, pre-filled, when the write was refused or found an existing mark (`already_marked`, i.e.
 * `created = false`). Calm, and clear that this send shouldn't go, so nobody pays twice. Always
 * followed by a refetch.
 */
export function afterOpenRefusal(error: BillError | 'already_marked', ctx: { difference?: boolean } = {}): string {
  const lead = 'Venmo opened, but';
  const dont = "Don't send it.";
  if (error === 'already_marked') return `${lead} this was already marked. ${dont} Check Venmo before you pay again.`;
  if (error === 'payer_changed') return `${lead} who gets paid just changed. ${dont} Check below before you pay.`;
  if (error === 'mark_changed' || (error === 'not_allowed' && ctx.difference === true)) {
    return `${lead} your payment just changed. ${dont} Check below before you pay.`;
  }
  if (error === 'not_complete') return `${lead} something on the bill just changed. ${dont} Check your share below.`;
  return `${lead} this wasn't saved. ${dont} Check Venmo before you pay again.`;
}

// ---------------------------------------------------------------------------
// Bill screen footer entry (brief §7, Task 10)
// ---------------------------------------------------------------------------

export type SettleFooterModel = {
  variant: 'primary' | 'secondary';
  caption: string | null;
  a11yHint: string;
  /**
   * 'success': a mark confirmation, drawn with a check (review R3). 'warning': Not received (D4),
   * a triangle in the warning colour with muted text (SV-VIS-13). Absent: a plain caption.
   */
  tone?: 'success' | 'warning';
  /** Announced when it appears. Only the ready marked captions; counts would speak on every claim tap. */
  live?: true;
  /** The "N left to claim" footer of a blocked plan, which the screen's own counts may replace. */
  incomplete?: true;
};

/** "Settle up" in the bill screen's footer, or null with fewer than 2 participants. */
export function settleFooter(participantCount: number, unclaimedRows: number, unclaimedDiscountRows = 0): SettleFooterModel | null {
  if (participantCount < 2) return null;
  if (unclaimedRows > 0) {
    const caption = footerIncomplete(unclaimedRows, unclaimedDiscountRows);
    return { variant: 'secondary', caption, a11yHint: `${caption} first`, incomplete: true };
  }
  return { variant: 'primary', caption: null, a11yHint: SETTLE_COPY.settleUpHintReady };
}

export type FooterLink = { label: string; a11yLabel: string; a11yHint: string };
type PayAction = Extract<SettleAction, { kind: 'pay' }>;
type MarkAction = Extract<SettleAction, { kind: 'mark' }>;
type CheckAction = Extract<SettleAction, { kind: 'sent_check_yes' | 'sent_check_undo' }>;

/**
 * The bill screen's footer (request spec F1; sent-via-Venmo D5):
 * - null: F-a (fewer than 2 people).
 * - 'settle': the "Settle up" button with a caption (counts, method confirmations, Not received).
 *   `early` + `method`: an early-plan footer whose count billFooterAction refreshes from the screen.
 * - 'pay': the Settle card's own Pay button and notes, plus Details (Venmo selected).
 * - 'cash': the same shape with the card's cash primary (Cash selected, or the payer has no Venmo).
 * - 'sent_check': the inline check's full question, Yes, No, undo, Details (no primary).
 * - 'did_you_pay': contract O, "Did you send Hana $15.10?" with Yes, I sent it; Not yet clears
 *   openedVenmo (component state).
 */
export type SettleFooterAction =
  | ({ kind: 'settle'; early?: 'pay' | 'marked'; method?: PaymentMethod } & SettleFooterModel)
  | { kind: 'pay'; button: SettleButton & { action: PayAction }; notes: string[]; details: FooterLink }
  | { kind: 'cash'; button: SettleButton & { action: MarkAction }; notes: string[]; details: FooterLink }
  | {
      kind: 'sent_check';
      text: string;
      yes: SettleButton & { action: CheckAction };
      undo: SettleButton & { action: CheckAction };
      details: FooterLink;
    }
  | { kind: 'did_you_pay'; text: string; iPaid: SettleButton & { action: MarkAction }; notYet: { label: string; a11yLabel: string }; details: FooterLink };

const DETAILS_LINK: FooterLink = { label: SETTLE_COPY.details, a11yLabel: SETTLE_COPY.detailsA11y, a11yHint: SETTLE_COPY.detailsHint };

function hasPay(b: SettleButton | null): b is SettleButton & { action: PayAction } {
  return b !== null && b.action.kind === 'pay';
}
function hasMark(b: SettleButton | null): b is SettleButton & { action: MarkAction } {
  return b !== null && b.action.kind === 'mark';
}
function isCheckAction(a: SettleAction): a is CheckAction {
  return a.kind === 'sent_check_yes' || a.kind === 'sent_check_undo';
}

/** The early footers (SE-UX-9, SV-UX-12): primary "You can pay now · …" or secondary "<method> · …". */
function earlyFooter(early: 'pay' | 'marked', rows: number, discountRows: number, method: PaymentMethod = 'other'): SettleFooterAction {
  const left = footerIncomplete(rows, discountRows);
  return early === 'pay'
    ? { kind: 'settle', variant: 'primary', caption: `You can pay now · ${left}`, a11yHint: `You can pay your share now. ${left}`, early }
    : { kind: 'settle', variant: 'secondary', caption: `${methodMarkLine(method)} · ${left}`, a11yHint: `${left} first`, early, method, tone: 'success' };
}

/** Contract O: the card's "Did you send…?" and its Yes, I sent it, or null if the card has no mark button. */
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

/**
 * The inline check in the footer (SV-UX-5): the same answers as the card (so answering one answers
 * both), with the full question and labels that carry the payer and amount.
 */
function sentCheckFooter(cardModel: SettleCardModel, payer: string): SettleFooterAction | null {
  const check = cardModel.check;
  if (check === null || !isCheckAction(check.yes.action) || !isCheckAction(check.undo.action)) return null;
  const amount = formatCents(check.yes.action.cents);
  const to = payer.trim() === '' ? '' : ` to ${payer}`;
  return {
    kind: 'sent_check',
    text: sentCheckFull(payer, check.yes.action.cents),
    yes: { label: SETTLE_COPY.sentCheckYes, a11yLabel: `Yes, my ${amount}${to} went through`, action: check.yes.action },
    undo: { label: SETTLE_COPY.sentCheckUndo, a11yLabel: `No, undo my ${amount}${to}`, a11yHint: check.undo.a11yHint, action: check.undo.action },
    details: DETAILS_LINK,
  };
}

/** The footer, derived from the same settleCard the Settle page shows, so the two can't disagree (F1). */
export function settleFooterAction(input: SettleViewInput, participantCount: number): SettleFooterAction | null {
  const { plan } = input;
  if (plan.status === 'blocked_payers') {
    if (participantCount < 2) return null;
    // S6: the host fixes it from Settle up; everyone else waits.
    if (input.viewerId === input.hostId) {
      return {
        kind: 'settle',
        variant: 'primary',
        caption: SETTLE_COPY.payersStaleFooter,
        a11yHint: `${SETTLE_COPY.payersStaleFooter} before anyone can settle up`,
        tone: 'warning',
      };
    }
    const host = input.nameOf(input.hostId);
    return { kind: 'settle', variant: 'secondary', caption: payersWaitingFor(host), a11yHint: `${payersWaitingFor(host)} to update who paid` };
  }
  if (plan.status === 'routes') return routeFooter(plan, input, participantCount);
  const incomplete = plan.status === 'blocked' || plan.status === 'early';
  const unclaimed = incomplete ? plan.unclaimedRows : 0;
  const unclaimedDiscounts = incomplete ? plan.unclaimedDiscountRows : 0;
  const base = settleFooter(participantCount, unclaimed, unclaimedDiscounts);
  if (base === null) return null; // F-a
  const settle: SettleFooterAction = { kind: 'settle', ...base }; // F-b (blocked, early) or F-f
  if (plan.status !== 'ready' && plan.status !== 'early') return settle;

  const cardModel = settleCard(input);
  const payer = input.nameOf(plan.payerId);
  const me = viewerEntry(input);
  if (plan.status === 'early') {
    // Still no Pay or cash footer before the bill is complete: paying early happens on Settle up (SE-9).
    // But a Pay already opened keeps its "Did you send?" under contract O, as the card does (review R5),
    // and a fresh Venmo send asks here as it does on the card.
    switch (cardModel.state) {
      case 'owes_opened':
        return didYouPayFooter(cardModel) ?? earlyFooter('pay', unclaimed, unclaimedDiscounts);
      case 'owes':
      case 'owes_no_venmo':
        return earlyFooter('pay', unclaimed, unclaimedDiscounts);
      case 'marked':
        return sentCheckFooter(cardModel, payer) ?? earlyFooter('marked', unclaimed, unclaimedDiscounts, me?.mark?.method);
      default:
        return settle;
    }
  }

  const diffFooter = (caption: string): SettleFooterAction => ({ ...settle, caption, a11yHint: SETTLE_COPY.differenceHint });
  const settledFooter = (caption: string, live: boolean): SettleFooterAction => ({
    kind: 'settle',
    variant: 'secondary',
    caption,
    a11yHint: SETTLE_COPY.seeWhoPaidHint,
    tone: 'success',
    ...(live ? { live: true as const } : {}),
  });
  switch (cardModel.state) {
    case 'more_due':
    case 'more_opened':
      return cardModel.amountCents === null ? settle : diffFooter(`You owe ${payer} ${formatCents(cardModel.amountCents)} more`);
    case 'back_due':
      return cardModel.amountCents === null ? settle : diffFooter(`${payer} owes you ${formatCents(cardModel.amountCents)} back`);
    case 'payer_all_paid':
      return settledFooter(SETTLE_COPY.footerPayerSettled, false);
    case 'payer':
    case 'payer_differences':
    case 'payer_nobody': {
      const d = differenceCount(plan.people);
      return d > 0 ? diffFooter(differencesToSettle(d)) : settle;
    }
    case 'owes':
    case 'owes_no_venmo': {
      // SV-UX-11: after Not received, Sam reads the card before any money moves again.
      const flag = me === null ? null : liveFlag(me, plan.payerId);
      if (flag !== null) return { ...settle, caption: footerNotReceived(payer, flag.cents), tone: 'warning' };
      // SV-UX-10: the footer offers the card's primary, whatever the method.
      if (hasPay(cardModel.primary)) return { kind: 'pay', button: cardModel.primary, notes: cardModel.notes, details: DETAILS_LINK };
      if (hasMark(cardModel.primary)) return { kind: 'cash', button: cardModel.primary, notes: cardModel.notes, details: DETAILS_LINK };
      return settle;
    }
    case 'owes_opened':
      return didYouPayFooter(cardModel) ?? settle;
    case 'marked':
      if (me?.mark == null) return settle;
      return sentCheckFooter(cardModel, payer) ?? settledFooter(footerMarked(payer, me.mark), true);
    default:
      return settle; // F-f
  }
}

/**
 * A routes plan's footer (A1.5 U7): owing 2+ people → primary "Settle up" with "You owe 2 people ·
 * $30.00"; otherwise the single-payer footer of the one pair that matters (the one the viewer still
 * owes, else their first card's pair, else what they collect), so its Pay, cash, check and marked
 * footers are today's. A sender whose payment was passed on gets the U4 line as the caption.
 */
function routeFooter(plan: SettleRoutes, input: SettleViewInput, participantCount: number): SettleFooterAction | null {
  const early = plan.early;
  const base = settleFooter(participantCount, early?.unclaimedRows ?? 0, early?.unclaimedDiscountRows ?? 0);
  if (base === null) return null;
  const owed = owedByViewer(plan, input.viewerId);
  if (owed.ids.length >= 2) {
    return { kind: 'settle', variant: 'primary', caption: oweManyText(owed.ids.length, owed.cents), a11yHint: SETTLE_COPY.settleUpHintReady };
  }
  const pairs = viewerPairs(plan, input);
  const owedId = owed.ids[0];
  const isPayer = plan.payers.some((p) => p.userId === input.viewerId);
  let toId: string;
  if (owedId !== undefined) toId = pairs.some((q) => q.toId === owedId) ? owedId : input.viewerId; // a 'back' owed as recipient
  else if (pairs[0] !== undefined) toId = pairs[0].toId;
  else if (isPayer || plan.pairs.some((q) => q.toId === input.viewerId)) toId = input.viewerId;
  else toId = plan.leadId;
  const sub = recipientInput(input, plan, toId);
  const footer = settleFooterAction(sub, participantCount);
  const sent = toId === input.viewerId ? null : senderLine(plan, input, toId);
  if (footer !== null && footer.kind === 'settle' && sent !== null && settleCard(sub).state === 'marked') return { ...footer, caption: sent };
  return footer;
}

/**
 * The footer the bill screen shows (VR-I6). `server` is settleFooterAction over server data (F1);
 * `unclaimedRows` / `unclaimedDiscountRows` are the screen's optimistic counts (displayShares), so
 * "N left to claim" still follows a claim tap at once, as it did before the Pay footer:
 * - rows left on screen → the "N left to claim" footer from those counts (never a Pay or cash
 *   button, whose amount would be from before the unclaim);
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
  // "Did you send?" records the opened amount and the check asks about a mark already made, not a
  // current share, so on-screen counts don't replace them (contract O, review R5; D3). The refetch
  // drops them where the card does.
  if (server.kind === 'did_you_pay' || server.kind === 'sent_check') return server;
  // Early footers keep their kind, variant and method, with the count from the screen (spec D6).
  if (server.kind === 'settle' && server.early !== undefined) {
    if (unclaimedRows > 0) return earlyFooter(server.early, unclaimedRows, unclaimedDiscountRows, server.method);
    return { kind: 'settle', ...(settleFooter(2, 0) as SettleFooterModel) }; // until the refetch lands
  }
  // Any participantCount ≥ 2 gives the same model; the server action exists, so there are ≥ 2.
  if (unclaimedRows > 0) return { kind: 'settle', ...(settleFooter(2, unclaimedRows, unclaimedDiscountRows) as SettleFooterModel) };
  if (server.kind === 'settle' && server.incomplete === true) return { kind: 'settle', ...(settleFooter(2, 0) as SettleFooterModel) };
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
): [userId: string, payerId: string, expectedCents: number, newCents: number, method: PaymentMethod] {
  return [action.userId, action.payerId, action.fromCents, action.toCents, action.method];
}

/**
 * Contract O (spec D6, F3): whether the "Did you pay?" prompt still holds. The person may already
 * have sent that amount in Venmo, so it follows the payer and the mark, not the current amount:
 * - 'share' (or no kind): the plan is ready, or early with the viewer able to settle; same payer;
 *   the viewer has no mark.
 * - 'more': the plan is ready; same payer; the viewer's mark is still `fromCents`.
 * Otherwise the screen drops it.
 */
export function openedStillMatches(plan: BillSettlePlan, viewerId: string, opened: OpenedVenmo): boolean {
  if (plan.status === 'routes') {
    // The pair viewer → opened.payerId, read as its own single-payer plan.
    if (!plan.pairs.some((q) => q.fromId === viewerId && q.toId === opened.payerId)) return false;
    return openedStillMatches(recipientPlan(plan, opened.payerId), viewerId, opened);
  }
  if ((plan.status !== 'ready' && plan.status !== 'early') || plan.payerId !== opened.payerId) return false;
  const people: PlanPeople = plan.people;
  const me = people.find((p) => p.userId === viewerId);
  if (me === undefined || me.role === 'payer') return false;
  if (opened.kind === 'more') return plan.status === 'ready' && me.mark !== null && me.mark.cents === opened.fromCents;
  return me.mark === null && canSettleNow(me);
}
