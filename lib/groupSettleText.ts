// Copy and small pure helpers for the group Settle screen, Who paid what and Record a payment (spec
// docs/specs/2026-11-26-groups-mvp.md T16 as amended by A2). The money, statuses and sentences come
// from lib/groupSettleView.ts (groupSettle); this file names controls, joins strings lib already
// made, and looks things up, so the screens build no strings and do no money math of their own.

import type { NameOf } from './billView';
import type { GroupSnapshot, SnapshotPayment } from './groups';
import type { GroupSettleModel, PersonCost, WhoPaidWhatRow } from './groupSettleView';
import { formatCents, isTooLarge, MAX_INPUT_CENTS, parseMoneyInput } from './money';
import { isSettleCents } from './paylinks';
import { methodMarkLine, PAYMENT_METHOD_COPY, type PaymentMethod } from './paymentMethods';
import { paidLabel, requestOpenFailedText, SETTLE_COPY } from './settleView';

export const GROUP_SETTLE_SCREEN_COPY = {
  title: 'Settle up',
  back: 'Group',
  backA11y: 'Back to the group',
  suggestionsHeader: 'Suggested payments',
  everyoneSettled: SETTLE_COPY.footerPayerSettled,
  toYouHeader: 'Payments to you',
  whoPaidWhat: 'Who paid what',
  whoPaidWhatHint: 'Shows what everyone paid, their share and payments',
  recordPayment: 'Record a payment',
  recordPaymentHint: 'For cash, or part of what you owe',
  opensVenmo: SETTLE_COPY.opensVenmo,
  yesHint: 'Records it as sent via Venmo',
  notNowHint: 'Records nothing',
  undoRecordedA11y: 'Undo this payment',
  recordIt: 'Record it',
  cancel: SETTLE_COPY.cancel,
  undo: SETTLE_COPY.undo,
  undoHint: 'Removes this payment',
  notReceivedHint: 'Asks first',
  gotPaidHint: 'Asks first, then records it',
  announceRecorded: 'Payment recorded',
  announceUndone: 'Payment undone',
} as const;

export const WHO_PAID_WHAT_COPY = {
  title: 'Who paid what',
  back: 'Settle up',
  backA11y: 'Back to Settle up',
  intro: "Net is what they paid minus their share, adjusted for payments. Plus means they're owed money, minus means they owe.",
  paid: 'Paid',
  share: 'Share',
  payments: 'Payments',
  settledUp: 'Settled up',
  noCosts: 'Nothing counted for them yet.',
  costsHeader: 'Costs',
  paymentsHeader: 'Payments',
  noPayments: 'No payments yet.',
  undo: SETTLE_COPY.undo,
  undoHint: 'Removes this payment',
  undoConfirmHint: 'Asks first',
  cancel: SETTLE_COPY.cancel,
  undone: 'Payment undone',
} as const;

export const RECORD_PAYMENT_COPY = {
  title: 'Record a payment',
  direction: 'Which way',
  paid: 'I paid someone',
  gotPaid: 'Someone paid me',
  whoPaid: 'Who did you pay?',
  whoGotPaid: 'Who paid you?',
  amount: 'Amount',
  method: 'How',
  methodOther: 'Other',
  save: 'Save payment',
  saveAnyway: 'Save anyway',
  cancel: SETTLE_COPY.cancel,
  pickPerson: 'Choose who.',
  amountProblem: `Enter an amount from $0.01 to ${formatCents(MAX_INPUT_CENTS)}.`,
  saveFailed: "Couldn't save. Try again.",
} as const;

/** The Record a payment method choices: Cash first (the default, A2.2), then Venmo, then Other. */
export const RECORD_METHODS: readonly { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: PAYMENT_METHOD_COPY.cash.chooserLabel ?? 'Cash' },
  { value: 'venmo', label: PAYMENT_METHOD_COPY.venmo.chooserLabel ?? 'Venmo' },
  { value: 'other', label: RECORD_PAYMENT_COPY.methodOther },
];

/**
 * The Venmo | Cash chooser's segments for a pay card, in `availableMethods` order. Each label carries
 * the context because the group label may not be read on iOS/Android (as the bill card, SV-T12-2).
 */
export function chooserOptions(methods: readonly PaymentMethod[]): { value: PaymentMethod; label: string; accessibilityLabel: string }[] {
  return methods.flatMap((value) => {
    const label = PAYMENT_METHOD_COPY[value].chooserLabel;
    return label === null ? [] : [{ value, label, accessibilityLabel: `${label}, how you're paying` }];
  });
}

// ---------------------------------------------------------------------------------------------
// The viewer's own cash / "Paid another way" record, shown on the card until the next action.

export type RecordedEntry = {
  paymentId: string;
  to: string;
  cents: number;
  /** "You paid Dee". */
  label: string;
  amountText: string;
  /** "Paid in cash" / "Marked paid". */
  methodLine: string;
};

/**
 * The card for a payment the viewer just recorded with Cash or "Paid another way", or null when that
 * payment isn't in the snapshot any more (undone, or another account): the card is keyed on the
 * payment id, so it never outlives the payment it describes.
 */
export function recordedEntry(snapshot: GroupSnapshot, paymentId: string | null, viewerId: string, nameOf: NameOf): RecordedEntry | null {
  if (paymentId === null) return null;
  const p = snapshot.payments.find((x) => x.id === paymentId);
  if (!p || p.from !== viewerId || p.method === 'venmo') return null;
  return { paymentId: p.id, to: p.to, cents: p.cents, label: paidLabel(nameOf(p.to)), amountText: formatCents(p.cents), methodLine: methodMarkLine(p.method) };
}

/** The payment in the snapshot with this id, or null. */
export function paymentById(snapshot: GroupSnapshot, id: string): SnapshotPayment | null {
  return snapshot.payments.find((p) => p.id === id) ?? null;
}

/** A member's Venmo username, or null. */
export function venmoOf(snapshot: GroupSnapshot, userId: string): string | null {
  return snapshot.members.find((m) => m.userId === userId)?.venmoUsername ?? null;
}

/**
 * "Couldn't open Venmo. Request $130.02 from @ben-1 in the Venmo app." while a Request for that
 * person and amount is still on screen; null once either changed (lesson 2026-11-25).
 */
export function requestOpenFailedLine(
  model: Pick<GroupSettleModel, 'requests'>,
  snapshot: GroupSnapshot,
  failure: { from: string; cents: number } | null,
): string | null {
  if (failure === null) return null;
  const still = model.requests.some((r) => r.from === failure.from && r.cents === failure.cents && r.request !== null);
  const handle = venmoOf(snapshot, failure.from);
  return still && handle !== null ? requestOpenFailedText(handle, failure.cents) : null;
}

/** The sender-side "hasn't received" lines that no pay card already shows (the person isn't owed any more). */
export function looseNotReceived(model: Pick<GroupSettleModel, 'notReceived' | 'pays'>): string[] {
  return model.notReceived.filter((n) => !model.pays.some((p) => p.to === n.to)).map((n) => n.text);
}

// ---------------------------------------------------------------------------------------------
// Who paid what.

/** "Paid $317.33 · Share $187.31 · Payments +$0.00". */
export function whoPaidWhatLine(row: WhoPaidWhatRow): string {
  const c = WHO_PAID_WHAT_COPY;
  return `${c.paid} ${row.paidText} · ${c.share} ${row.shareText} · ${c.payments} ${row.paymentsText}`;
}

/** The row's screen-reader label, everything it shows in reading order. */
export function whoPaidWhatA11y(row: WhoPaidWhatRow): string {
  const c = WHO_PAID_WHAT_COPY;
  const settled = row.settled ? `, ${c.settledUp.toLowerCase()}` : '';
  return `${row.name}, net ${row.netText}${settled}. ${c.paid} ${row.paidText}, ${c.share.toLowerCase()} ${row.shareText}, ${c.payments.toLowerCase()} ${row.paymentsText}`;
}

/** "Shows Ana's costs" / "Shows your costs". */
export function costsHint(row: WhoPaidWhatRow, open: boolean): string {
  const whose = row.name === 'You' ? 'your' : `${row.name}'s`;
  return `${open ? 'Hides' : 'Shows'} ${whose} costs`;
}

/** One cost under a person: "Paid $240.00 · Share $60.00", or just the share when they didn't pay it. */
export function costLine(cost: PersonCost): string {
  const share = `${WHO_PAID_WHAT_COPY.share} ${formatCents(cost.shareCents)}`;
  return cost.paidCents > 0 ? `${WHO_PAID_WHAT_COPY.paid} ${formatCents(cost.paidCents)} · ${share}` : share;
}

// ---------------------------------------------------------------------------------------------
// Record a payment.

/**
 * The amount field: the cents, or a problem. Never treats bad input as $0 (lesson 2026-11-21).
 * Empty input is `empty` (no error shown until Save).
 */
export function recordAmount(input: string): { kind: 'ok'; cents: number } | { kind: 'empty' } | { kind: 'invalid' } {
  if (input.trim() === '') return { kind: 'empty' };
  if (isTooLarge(input)) return { kind: 'invalid' };
  const cents = parseMoneyInput(input);
  return cents !== null && isSettleCents(cents) ? { kind: 'ok', cents } : { kind: 'invalid' };
}

/** The other people in the group, in snapshot order (joined first), for the "Who did you pay?" list. */
export function otherMembers(snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): { userId: string; name: string }[] {
  return snapshot.members.filter((m) => m.userId !== viewerId).map((m) => ({ userId: m.userId, name: nameOf(m.userId) }));
}

/**
 * The suggestion between the viewer and `other` in the chosen direction, for recordPaymentCheck
 * (null when there is none: no warning, GR-T10-8).
 */
export function suggestionFor(
  model: Pick<GroupSettleModel, 'suggestions'>,
  viewerId: string,
  other: string,
  viewerPays: boolean,
  nameOf: NameOf,
): { cents: number; name: string; viewerPays: boolean } | null {
  const from = viewerPays ? viewerId : other;
  const to = viewerPays ? other : viewerId;
  const s = model.suggestions.find((x) => x.from === from && x.to === to);
  return s ? { cents: s.cents, name: nameOf(other), viewerPays } : null;
}

/** The IntentId key for a manual record: one id per content, reused by a retry (A1.6). */
export function manualIntentKey(p: { from: string; to: string; cents: number; method: PaymentMethod }): string {
  return `${p.from}|${p.to}|${p.cents}|${p.method}|manual`;
}
