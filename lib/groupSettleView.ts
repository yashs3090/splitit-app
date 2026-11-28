// The group Settle screen's view model (spec docs/specs/2026-11-26-groups-mvp.md T10, as amended by
// A1 (S1 notice, S2 isSettledUp, N1) and A2 (U-G7: group payments are recorded like bill payments
// under Sent via Venmo). Pure: no I/O, no clock (the caller passes `now`), no platform checks (the
// caller passes the send platform, and groupSendPlan says what to do next).
//
// Everything money-related comes from groupMath (lib/groupView.ts), so the status line, the cards,
// the suggestions and Who paid what can't disagree. Copy is reused from lib/settleView.ts and
// lib/paymentMethods.ts wherever the bill screens already say the same thing.

import type { NameOf } from './billView';
import type { GroupSnapshot, SnapshotPayment } from './groups';
import { groupMath, receiptLabel, statusLine, viewerNet, waitingLines, type StatusLine } from './groupView';
import { formatCents } from './money';
import { isSettleCents, venmoPayUrl, venmoRequestUrl } from './paylinks';
import { availableMethods, methodMarkLine, methodRowStatus, type PaymentMethod } from './paymentMethods';
import { answerFor, SENT_CHECK_INLINE_MAX_MINUTES, sentCheckKey, type SentCheckBlob } from './sentCheck';
import {
  cashButtonText,
  didYouSend,
  handleLine,
  noVenmoOwer,
  openFailedText,
  otherWayHint,
  payButtonText,
  requestA11yLabel,
  sentCheckFull,
  sentLabel,
  SETTLE_COPY,
} from './settleView';
import { isSettledUp } from './simplify';

// ---------------------------------------------------------------------------------------------
// Venmo note (U-G5, GR-T2-9).

/** U-G5 kill switch: false = group Venmo notes are plain "SplitIt" (the group name can be public on Venmo). */
export const GROUP_VENMO_NOTE_INCLUDES_NAME: boolean = true;

/**
 * A group name as it may go into a Venmo note: control characters (`\p{Cc}`) removed, whitespace
 * collapsed, trimmed. Format characters (`\p{Cf}`, which include the ZWJ in emoji sequences) are
 * kept, so this is not lib/sentCheck.ts's strip (A2.3; lesson 2026-11-25 "control characters got
 * through"). venmoNote then handles lone surrogates and the length.
 */
export function cleanNoteName(name: string): string {
  if (typeof name !== 'string') return '';
  // Tabs and newlines are both whitespace and Cc: turn them into spaces first so words don't join.
  return name.replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '').replace(/\s+/gu, ' ').trim();
}

/** The `itemNames` for venmoPayUrl / venmoRequestUrl: [the cleaned group name], or [] (switch off or nothing left). */
export function groupNoteItems(groupName: string, includeName: boolean = GROUP_VENMO_NOTE_INCLUDES_NAME): string[] {
  if (!includeName) return [];
  const clean = cleanNoteName(groupName);
  return clean === '' ? [] : [clean];
}

// ---------------------------------------------------------------------------------------------
// The send flow (A2.2): one pure step function, so the screen does no platform branching.

export type GroupSendPlatform = 'native' | 'mobile_web' | 'desktop_web';

/** `os` is Platform.OS; `mobileWeb` is detectMobileWeb(...) !== null (lib/appBanner.ts). */
export function sendPlatformOf(os: string, mobileWeb: boolean): GroupSendPlatform {
  if (os !== 'web') return 'native';
  return mobileWeb ? 'mobile_web' : 'desktop_web';
}

/** SV's limit on the record before opening Venmo (A2.2, starting value; verify on device). */
export const GROUP_SEND_RECORD_TIMEOUT_MS = 4000;

/** What just happened. `recorded` carries the record's outcome into the open step. */
export type GroupSendOutcome =
  | { step: 'start' }
  /** record_payment(id, …, 'venmo', 'venmo_link'): ok; refused (42501 / any 22023); unknown (network, timeout). */
  | { step: 'record'; result: 'ok' | 'refused' | 'unknown' }
  /** openPaymentLink (native). */
  | { step: 'open'; ok: boolean; recorded: 'ok' | 'unknown' }
  /** webOpenOutcome(openPaymentLinkWeb(url), mobile) (web). */
  | { step: 'web_open'; result: 'blocked' | 'ask' | 'record' }
  /** undo_payment(id) after Venmo failed to open. */
  | { step: 'undo'; ok: boolean };

/**
 * What to do next. `done` ends the flow:
 * - 'sent': refetch and add the id to `justSent` (the "You sent Dee" card).
 * - 'ask': keep the attempt as phase 'ask' ("Did you send Dee $174.97?"). Yes records with the same
 *   id; once it succeeds the screen stores 'yes' for groupSentCheckKey(group, payment id) so the
 *   inline check never asks about it (criterion 121).
 * - 'refused': show the error and refetch; nothing was opened (native) or recorded.
 * - 'open_failed': keep the attempt as phase 'open_failed' and refetch.
 * `open_web` must be the first statement of the tap handler (popup blockers): the screen calls
 * openPaymentLinkWeb synchronously, then awaits webOpenOutcome and passes the answer back here.
 */
export type GroupSendStep =
  | { do: 'record'; timeoutMs: number }
  | { do: 'open'; recorded: 'ok' | 'unknown' }
  | { do: 'open_web' }
  | { do: 'undo' }
  | { done: 'sent' | 'ask' | 'refused' | 'open_failed' };

export function groupSendPlan(platform: GroupSendPlatform, outcome: GroupSendOutcome): GroupSendStep {
  const record: GroupSendStep = { do: 'record', timeoutMs: GROUP_SEND_RECORD_TIMEOUT_MS };
  switch (outcome.step) {
    case 'start':
      // Native records first (SV F2 order); web must open inside the tap.
      return platform === 'native' ? record : { do: 'open_web' };
    case 'record':
      if (outcome.result === 'refused') return { done: 'refused' };
      if (platform === 'native') return { do: 'open', recorded: outcome.result };
      // Web: the tab is already open. Unknown outcome → ask on return (the Yes reuses the id).
      return { done: outcome.result === 'ok' ? 'sent' : 'ask' };
    case 'open':
      if (!outcome.ok) return { do: 'undo' }; // SV-7: no payment stays behind a Venmo that never opened
      return { done: outcome.recorded === 'ok' ? 'sent' : 'ask' };
    case 'web_open':
      if (outcome.result === 'blocked') return { done: 'open_failed' };
      // Desktop web never records without Yes (A2.2).
      if (outcome.result === 'record' && platform === 'mobile_web') return record;
      return { done: 'ask' };
    case 'undo':
      // A failed undo still ends here; the refetch then shows the payment with its Undo.
      return { done: 'open_failed' };
  }
}

/** The screen's own facts about its latest Pay tap (device state, not server data). */
export type GroupSendAttempt = {
  /** The client uuid made once per Pay tap, reused by every retry and the Yes. */
  id: string;
  to: string;
  /** The amount opened in Venmo: what Yes records. */
  cents: number;
  phase: 'ask' | 'open_failed';
};

// ---------------------------------------------------------------------------------------------
// The inline check (A2.2, GR-P2).

/**
 * Device-storage key for a group payment's inline check, in SV's answers blob (lib/sentCheck.ts):
 * `<group id>.<payment id>.0`, built by sentCheckKey so the blob keeps it (its entries must be
 * `<uuid>.<uuid>.<ms>`). Payment ids are fresh uuids, so the id alone names the payment and the last
 * part is a fixed 0. Keyed on the id only (review R9, GR-RV-9) so the desktop "Yes" can be stored at
 * the tap, before any refetch has brought the payment's time. It can't collide with a bill's key
 * (a bill's middle part is the payer's user id, never a payment id). null for a bad id.
 */
export function groupSentCheckKey(groupId: string, paymentId: string): string | null {
  return sentCheckKey(groupId, paymentId, 0);
}

const INLINE_MAX_MS = SENT_CHECK_INLINE_MAX_MINUTES * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Payments: method and source with or without A2's fields on the snapshot.

function methodOf(p: SnapshotPayment): PaymentMethod {
  return p.method;
}

/** Recorded through a Venmo link the app opened (A2.1). */
function isVenmoLink(p: SnapshotPayment): boolean {
  return p.source === 'venmo_link';
}

/** GR-M6: payments the recipient marked "Not received" (recent, undone), as the snapshot carries them. */
export type { SnapshotNotReceived } from './groups';

// ---------------------------------------------------------------------------------------------
// Copy (A2.2) not already in lib/settleView.ts.

export const GROUP_SETTLE_COPY = {
  owesText: (name: string, cents: number) => `You owe ${name} ${formatCents(cents)}`,
  owedByText: (name: string, cents: number) => `${name} owes you ${formatCents(cents)}`,
  requestButton: (cents: number) => `Request ${formatCents(cents)}`,
  gotPaid: 'Got paid another way',
  gotPaidConfirm: (name: string, cents: number) => `Record that ${name} paid you ${formatCents(cents)}?`,
  notNow: 'Not now',
  notReceived: 'Not received',
  notReceivedConfirm: (name: string, cents: number) =>
    `Didn't get ${name}'s ${formatCents(cents)}? This clears it and lets ${name} know.`,
  notReceivedSender: (name: string, cents: number) =>
    `${name} hasn't received your ${formatCents(cents)}. Check Venmo before paying again.`,
  sumLine: (cents: number) => `Everyone's balances add up to ${formatCents(cents)}`,
  over: (text: string) => text,
} as const;

/** "You"/name for the start of a sentence; "you"/name after a verb. */
function obj(name: string): string {
  if (name === 'You') return 'you';
  if (name === 'Someone') return 'someone';
  if (name === 'A friend') return 'a friend';
  return name;
}

function signed(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/** "Cy sent Dee $174.97", "You paid Dee $50.00", "Ana got $130.02 from you". */
function paymentText(p: SnapshotPayment, nameOf: NameOf): string {
  const from = nameOf(p.from);
  const to = nameOf(p.to);
  const amount = formatCents(p.cents);
  if (p.recordedBy === p.to && p.source !== 'bill_mark') return `${to} got ${amount} from ${obj(from)}`;
  return `${from} ${methodOf(p) === 'venmo' ? 'sent' : 'paid'} ${obj(to)} ${amount}`;
}

// ---------------------------------------------------------------------------------------------
// The model.

export type GroupSettleInput = {
  snapshot: GroupSnapshot;
  viewerId: string;
  nameOf: NameOf;
  platform: GroupSendPlatform;
  attempt: GroupSendAttempt | null;
  /** Payment ids this screen recorded through the send flow (each shows the "You sent" card). */
  justSent: readonly string[];
  /** The viewer's stored inline-check answers (lib/sentCheck.ts blob). */
  sentChecks: SentCheckBlob;
  /** Epoch ms. */
  now: number;
  /** Defaults to GROUP_VENMO_NOTE_INCLUDES_NAME. */
  includeNameInNote?: boolean;
};

export type PayEntry = {
  to: string;
  cents: number;
  state: 'pay' | 'ask_on_return';
  /** "You owe Dee $174.97". */
  text: string;
  /** availableMethods(recipient's Venmo): the chooser's options. */
  methods: readonly PaymentMethod[];
  venmo: { label: string; hint: string; url: string } | null;
  cash: { label: string; hint: string };
  otherWay: { label: string; hint: string };
  /** "@dee-1 · $174.97", or null without Venmo. */
  handleNote: string | null;
  /** Desktop web only. */
  webNote: string | null;
  noVenmoLine: string | null;
  /** "Did you send Dee $174.97?" (desktop web, or the record's outcome unknown). */
  ask: { text: string; yes: string; notNow: string; paymentId: string; cents: number } | null;
  openFailed: string | null;
  notReceivedLine: string | null;
};

export type SentEntry = {
  paymentId: string;
  to: string;
  cents: number;
  /** "You sent Dee". */
  label: string;
  amountText: string;
  /** "Sent via Venmo". */
  methodLine: string;
  /** "Didn't go through? Undo"; null while the inline check asks instead. */
  undo: { label: string } | null;
  /** The inline "Did your $174.97 to Dee go through?". */
  check: { text: string; yes: string; no: string; key: string | null } | null;
};

export type RequestEntry = {
  from: string;
  cents: number;
  /** "Ben owes you $130.02". */
  text: string;
  request: { label: string; a11yLabel: string; url: string } | null;
  webNote: string | null;
  /** Records method 'other', source 'manual', after the inline confirm. */
  gotPaid: { label: string; confirm: string };
};

export type ReceivedEntry = {
  paymentId: string;
  from: string;
  cents: number;
  /** "Ben sent you $130.02" / "Ben paid you $130.02". */
  text: string;
  /** methodRowStatus: "Sent via Venmo" / "Paid in cash" / "Paid". */
  status: string;
  /** Calls undo_payment after the inline confirm. */
  notReceived: { label: string; confirm: string };
};

export type SuggestionRow = { from: string; to: string; cents: number; role: 'pay' | 'request' | 'other'; text: string };

export type PersonCost = { id: string; title: string; paidCents: number; shareCents: number };
export type WhoPaidWhatRow = {
  userId: string;
  name: string;
  paidCents: number;
  shareCents: number;
  /** sent − received. */
  paymentsCents: number;
  netCents: number;
  paidText: string;
  shareText: string;
  paymentsText: string;
  netText: string;
  settled: boolean;
  /** Counting receipts and expenses this person paid or has a share in, newest first. */
  costs: PersonCost[];
};
export type WhoPaidWhat = { rows: WhoPaidWhatRow[]; sumLine: string };

export type PaymentRow = {
  id: string;
  from: string;
  to: string;
  cents: number;
  text: string;
  methodLine: string;
  canUndo: boolean;
  /** Inline confirm text when someone else recorded it; null = undo straight away. */
  undoConfirm: string | null;
};

export type GroupSettleModel = {
  status: StatusLine;
  /** "Balances don't include …" lines, above the suggestions (S1). */
  notices: string[];
  pays: PayEntry[];
  sent: SentEntry[];
  requests: RequestEntry[];
  received: ReceivedEntry[];
  /** "Dee hasn't received your $174.97…" (GR-P3). */
  notReceived: { to: string; cents: number; text: string }[];
  suggestions: SuggestionRow[];
  whoPaidWhat: WhoPaidWhat;
  payments: PaymentRow[];
};

function newestFirst<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** GR-P3 / GR-M6: the viewer's payments the recipient marked "Not received", latest per recipient, with no newer payment to them since. */
function notReceivedOf(input: GroupSettleInput): { to: string; cents: number; text: string }[] {
  const { snapshot, viewerId, nameOf } = input;
  const latest = new Map<string, { cents: number; at: number }>();
  for (const r of snapshot.notReceived) {
    if (r.from !== viewerId || !isSettleCents(r.cents)) continue;
    const at = Date.parse(r.undoneAt);
    if (Number.isNaN(at)) continue;
    const prev = latest.get(r.to);
    if (!prev || at > prev.at) latest.set(r.to, { cents: r.cents, at });
  }
  const out: { to: string; cents: number; text: string }[] = [];
  for (const [to, { cents, at }] of latest) {
    const newer = snapshot.payments.some((p) => p.from === viewerId && p.to === to && Date.parse(p.createdAt) > at);
    if (!newer) out.push({ to, cents, text: GROUP_SETTLE_COPY.notReceivedSender(nameOf(to), cents) });
  }
  return out;
}

export function groupSettle(input: GroupSettleInput): GroupSettleModel {
  const { snapshot, viewerId, nameOf, platform, attempt } = input;
  const math = groupMath(snapshot);
  const items = groupNoteItems(snapshot.group.name, input.includeNameInNote ?? GROUP_VENMO_NOTE_INCLUDES_NAME);
  const venmoOf = (u: string) => snapshot.members.find((m) => m.userId === u)?.venmoUsername ?? null;
  const desktop = platform === 'desktop_web';
  const shown = math.suggestions.shown;
  const notReceived = notReceivedOf(input);

  // A late success: the attempt's id reached the snapshot, so it's a sent payment, not a question.
  const attemptRecorded = attempt !== null && snapshot.payments.some((p) => p.id === attempt.id);

  const pays: PayEntry[] = shown
    .filter((t) => t.from === viewerId)
    .map((t) => {
      const name = nameOf(t.to);
      const handle = venmoOf(t.to);
      const url = handle === null ? null : venmoPayUrl({ username: handle, cents: t.cents, itemNames: items });
      // N1: the question is keyed on the recipient still being someone the viewer pays; it records the amount opened.
      const asks = attempt !== null && !attemptRecorded && attempt.phase === 'ask' && attempt.to === t.to;
      // The open-failed line names the handle and amount, so it shows only while both still match.
      const failed = attempt !== null && attempt.phase === 'open_failed' && attempt.to === t.to && attempt.cents === t.cents;
      return {
        to: t.to,
        cents: t.cents,
        state: asks ? 'ask_on_return' : 'pay',
        text: GROUP_SETTLE_COPY.owesText(name, t.cents),
        methods: availableMethods(handle),
        venmo: url === null ? null : { label: payButtonText(name, t.cents), hint: SETTLE_COPY.payHint, url },
        cash: { label: cashButtonText(name, t.cents), hint: SETTLE_COPY.cashHint },
        otherWay: { label: SETTLE_COPY.paidAnotherWay, hint: otherWayHint(name) },
        handleNote: url === null || handle === null ? null : handleLine(handle, t.cents),
        webNote: desktop && url !== null ? SETTLE_COPY.webComputerLine : null,
        noVenmoLine: url === null ? noVenmoOwer(name) : null,
        ask: asks
          ? { text: didYouSend(name, attempt.cents), yes: SETTLE_COPY.fallbackYes, notNow: GROUP_SETTLE_COPY.notNow, paymentId: attempt.id, cents: attempt.cents }
          : null,
        openFailed: failed && handle !== null ? openFailedText(handle, t.cents) : null,
        notReceivedLine: notReceived.find((n) => n.to === t.to)?.text ?? null,
      };
    });

  const justSent = new Set(input.justSent);
  if (attemptRecorded && attempt !== null) justSent.add(attempt.id);
  const sent: SentEntry[] = [];
  for (const p of [...snapshot.payments].sort(newestFirst)) {
    if (p.from !== viewerId || p.recordedBy !== viewerId) continue;
    const method = methodOf(p);
    const key = groupSentCheckKey(snapshot.group.id, p.id);
    const age = input.now - Date.parse(p.createdAt);
    const checks = method === 'venmo' && isVenmoLink(p) && key !== null && answerFor(input.sentChecks, key) === null && age <= INLINE_MAX_MS;
    if (!checks && !justSent.has(p.id)) continue;
    const name = nameOf(p.to);
    sent.push({
      paymentId: p.id,
      to: p.to,
      cents: p.cents,
      label: sentLabel(name),
      amountText: formatCents(p.cents),
      methodLine: methodMarkLine(method),
      undo: checks ? null : { label: SETTLE_COPY.sentUndoGhost },
      check: checks ? { text: sentCheckFull(name, p.cents), yes: SETTLE_COPY.sentCheckYes, no: SETTLE_COPY.sentCheckUndo, key } : null,
    });
  }

  const requests: RequestEntry[] = shown
    .filter((t) => t.to === viewerId)
    .map((t) => {
      const name = nameOf(t.from);
      const handle = venmoOf(t.from);
      const url = handle === null ? null : venmoRequestUrl({ username: handle, cents: t.cents, itemNames: items });
      return {
        from: t.from,
        cents: t.cents,
        text: GROUP_SETTLE_COPY.owedByText(name, t.cents),
        request:
          url === null || handle === null
            ? null
            : { label: GROUP_SETTLE_COPY.requestButton(t.cents), a11yLabel: requestA11yLabel(name, handle, t.cents), url },
        webNote: desktop && url !== null ? SETTLE_COPY.requestWebLine : null,
        gotPaid: { label: GROUP_SETTLE_COPY.gotPaid, confirm: GROUP_SETTLE_COPY.gotPaidConfirm(name, t.cents) },
      };
    });

  const received: ReceivedEntry[] = [...snapshot.payments]
    .sort(newestFirst)
    .filter((p) => p.to === viewerId && p.recordedBy !== viewerId)
    .map((p) => {
      const name = nameOf(p.from);
      const method = methodOf(p);
      return {
        paymentId: p.id,
        from: p.from,
        cents: p.cents,
        text: `${name} ${method === 'venmo' ? 'sent' : 'paid'} you ${formatCents(p.cents)}`,
        status: methodRowStatus(method),
        notReceived: { label: GROUP_SETTLE_COPY.notReceived, confirm: GROUP_SETTLE_COPY.notReceivedConfirm(name, p.cents) },
      };
    });

  const suggestions: SuggestionRow[] = shown.map((t) => ({
    ...t,
    role: t.from === viewerId ? 'pay' : t.to === viewerId ? 'request' : 'other',
    text: `${nameOf(t.from)} ${t.from === viewerId ? 'pay' : 'pays'} ${obj(nameOf(t.to))} ${formatCents(t.cents)}`,
  }));

  return {
    status: statusLine(viewerNet(snapshot, viewerId)),
    notices: waitingLines(snapshot, viewerId, nameOf).map((w) => w.notice),
    pays,
    sent,
    requests,
    received,
    notReceived,
    suggestions,
    whoPaidWhat: whoPaidWhat(snapshot, viewerId, nameOf),
    payments: [...snapshot.payments].sort(newestFirst).map((p) => {
      const mine = p.from === viewerId || p.to === viewerId;
      return {
        id: p.id,
        from: p.from,
        to: p.to,
        cents: p.cents,
        text: paymentText(p, nameOf),
        methodLine: methodRowStatus(methodOf(p)),
        canUndo: mine,
        undoConfirm: mine && p.recordedBy !== viewerId ? `Undo ${nameOf(p.recordedBy)}'s record of ${formatCents(p.cents)}?` : null,
      };
    }),
  };
}

/** Who paid what (T16): one row per member in snapshot order, from the same balances as everything else. */
export function whoPaidWhat(snapshot: GroupSnapshot, viewerId: string, nameOf: NameOf): WhoPaidWhat {
  const math = groupMath(snapshot);
  type Cost = PersonCost & { kind: 'bill' | 'expense'; createdAt: string; payerId: string; shares: ReadonlyMap<string, number> };
  const costs: Cost[] = [
    ...snapshot.bills.flatMap((b): Cost[] => {
      const shares = math.billShares.get(b.id);
      if (shares === undefined) return []; // waiting receipts add nothing (C-G1)
      return [{ id: b.id, kind: 'bill', title: receiptLabel(b.hostId, viewerId, nameOf), paidCents: 0, shareCents: 0, createdAt: b.createdAt, payerId: b.payerId, shares }];
    }),
    ...snapshot.expenses.map((e): Cost => ({
      id: e.id,
      kind: 'expense',
      title: e.title,
      paidCents: 0,
      shareCents: 0,
      createdAt: e.createdAt,
      payerId: e.payerId,
      shares: new Map(e.shares.map((s) => [s.userId, s.cents])),
    })),
  ].sort(newestFirst);
  const amountOf = (id: string) => snapshot.bills.find((b) => b.id === id)?.totalCents ?? snapshot.expenses.find((e) => e.id === id)?.amountCents ?? 0;

  let sum = 0;
  const rows = math.balances.members.map((m): WhoPaidWhatRow => {
    sum += m.netCents;
    const payments = m.sentCents - m.receivedCents;
    return {
      userId: m.userId,
      name: nameOf(m.userId),
      paidCents: m.paidCents,
      shareCents: m.shareCents,
      paymentsCents: payments,
      netCents: m.netCents,
      paidText: formatCents(m.paidCents),
      shareText: formatCents(m.shareCents),
      paymentsText: signed(payments),
      netText: signed(m.netCents),
      settled: isSettledUp(m.netCents),
      costs: costs
        // A receipt lists everyone on it; someone who claimed nothing ($0) and didn't pay it has no cost there (R7).
        .filter((c) => c.payerId === m.userId || (c.shares.has(m.userId) && (c.kind === 'expense' || (c.shares.get(m.userId) ?? 0) !== 0)))
        .map((c) => ({ id: c.id, title: c.title, paidCents: c.payerId === m.userId ? amountOf(c.id) : 0, shareCents: c.shares.get(m.userId) ?? 0 })),
    };
  });
  return { rows, sumLine: GROUP_SETTLE_COPY.sumLine(sum) };
}

// ---------------------------------------------------------------------------------------------
// Record a payment (T16).

export type RecordPaymentCheck = { status: 'ok' } | { status: 'invalid' } | { status: 'over'; text: string };

/**
 * The amount typed into Record a payment, against the suggestion between the two people in that
 * direction (null when there is none: no warning, GR-T10-8). `over` needs a second tap ("Save anyway").
 */
export function recordPaymentCheck(
  cents: number,
  suggested: { cents: number; name: string; viewerPays: boolean } | null,
): RecordPaymentCheck {
  if (!isSettleCents(cents)) return { status: 'invalid' };
  if (suggested === null || cents <= suggested.cents) return { status: 'ok' };
  const amount = formatCents(suggested.cents);
  return {
    status: 'over',
    text: suggested.viewerPays ? `That's more than you owe ${suggested.name} (${amount}).` : `That's more than ${suggested.name} owes you (${amount}).`,
  };
}
