// View models and every string for the Settle up screen. Pure: no React, no I/O.
// Brief: docs/specs/2026-11-24-m3-settle-ux.md §3–§7, §10 (copy). Spec: 2026-11-24-m3-settle-venmo.md,
// Amendment A1, Task 8. Venmo Request buttons and the bill-screen footer:
// docs/specs/2026-11-25-venmo-request-buttons.md (R2, R3, F1, F3).
//
// Components render what these functions return. They do no money arithmetic and build no money
// sentences: every amount below is integer cents from lib/settle.ts, and every "$" string goes
// through formatCents here.
import { leftToClaim, makeNameOf, splitInputFor, type NameOf } from './billView';
import { BILL_ERROR_COPY, type BillData, type BillError } from './bills';
import { formatCents } from './money';
import { claimedItemNames, isSettleCents, venmoPayUrl, venmoRequestUrl } from './paylinks';
import { settlePlan, SETTLE_ALL_ZERO_COPY, type SettleEntry, type SettlePlan, type SettleReady } from './settle';

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

function shareChangedLine(owedCents: number, diffCents: number, payer: string): string {
  const now = `Your share is now ${formatCents(owedCents)}.`;
  return diffCents > 0
    ? `${now} Sort out the ${formatCents(diffCents)} with ${payer}.`
    : `${now} ${payer} owes you ${formatCents(-diffCents)} back.`;
}

// ---------------------------------------------------------------------------
// Card (brief §3)
// ---------------------------------------------------------------------------

/** What the person opened in Venmo on this screen (component state; never persisted). */
export type OpenedVenmo = { payerId: string; cents: number };

export type SettleAction =
  | { kind: 'pay'; url: string; payerId: string; cents: number }
  | { kind: 'mark'; payerId: string; cents: number }
  | { kind: 'unmark'; userId: string }
  | { kind: 'add_venmo' }
  | { kind: 'back' }
  | { kind: 'edit' }
  | { kind: 'retry' };

export type SettleButton = { label: string; a11yLabel: string; a11yHint?: string; action: SettleAction };

/** Copy carries no status glyphs (P3): the UI draws a Check (success) or TriangleAlert (warning) from `tone`. */
export type CardLine = { text: string; tone: 'muted' | 'success' | 'warning'; live?: boolean };

/** The brief §3 state the card is in. */
export type SettleCardState =
  | 'owes' // 3.1
  | 'owes_opened' // 3.2
  | 'marked' // 3.3
  | 'marked_changed' // 3.4
  | 'owes_no_venmo' // 3.5
  | 'nothing' // 3.6
  | 'negative' // 3.7
  | 'payer' // 3.8
  | 'payer_all_paid'
  | 'payer_nobody'
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
  plan: SettlePlan;
  nameOf: NameOf;
  viewerId: string;
  hostId: string;
  /** bills.payer_id (blocked plans don't carry it). */
  payerId: string;
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
  const plan = settlePlan(splitInputFor(data, data.claims), payerId, marks);
  const venmo = new Map(data.participants.map((p) => [p.userId, p.venmoUsername]));
  const venmoOf = (userId: string) => venmo.get(userId) ?? null;
  const me = data.participants.find((p) => p.userId === viewerId);
  return {
    plan,
    nameOf: makeNameOf(data.participants, viewerId),
    viewerId,
    hostId: data.bill.host_id,
    payerId,
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

function payerCard(plan: SettleReady): SettleCardModel {
  if (plan.owingCount === 0) return card('payer_nobody', SETTLE_COPY.payerNobody);
  if (plan.allPaid) {
    return card('payer_all_paid', SETTLE_COPY.payerAllPaidLabel, {
      amountCents: plan.collectCents,
      lines: [{ text: payerAllPaidLine(plan.owingCount), tone: 'success', live: true }],
    });
  }
  return card('payer', payerOwedLabel(plan.owingCount), {
    amountCents: plan.collectCents,
    lines: [{ text: paidOfText(plan.paidCount, plan.owingCount), tone: 'muted', live: true }],
  });
}

function oweCard(me: Extract<SettleEntry, { owedCents: number }>, input: SettleViewInput, payerId: string): SettleCardModel {
  const payer = input.nameOf(payerId);
  const web = input.platform === 'web';

  // A mark wins over the role: whatever the share is now, the person sees what they marked (§3.4).
  if (me.mark) {
    const undo: SettleButton = {
      label: SETTLE_COPY.undo,
      a11yLabel: 'Undo your I paid',
      action: { kind: 'unmark', userId: me.userId },
    };
    if (me.markDiffers && me.markDiffCents !== undefined) {
      return card('marked_changed', paidLabel(payer), {
        amountCents: me.mark.cents,
        lines: [{ text: shareChangedLine(me.owedCents, me.markDiffCents, payer), tone: 'warning' }],
        secondary: [undo],
      });
    }
    return card('marked', paidLabel(payer), {
      amountCents: me.mark.cents,
      lines: [{ text: SETTLE_COPY.markedPaid, tone: 'success', live: true }],
      secondary: [undo],
    });
  }

  if (me.role === 'nothing') {
    return card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] });
  }
  if (me.role === 'payer_owes_them') {
    return card('negative', negativeLabel(payer), {
      amountCents: -me.owedCents,
      lines: [{ text: SETTLE_COPY.negativeBody, tone: 'muted' }],
    });
  }

  const cents = me.owedCents;
  const handle = input.payerVenmo;
  const url = handle === null ? null : venmoPayUrl({ username: handle, cents, itemNames: input.viewerItemNames });
  if (handle === null || url === null) {
    return card('owes_no_venmo', owesLabel(payer), {
      amountCents: cents,
      lines: [{ text: noVenmoOwer(payer), tone: 'muted' }],
      primary: markButton(SETTLE_COPY.iPaid, payerId, cents),
    });
  }

  const notes = [handleLine(handle, cents), ...(web ? [SETTLE_COPY.webComputerLine] : [])];
  const opened = input.openedVenmo;
  // The prompt follows the tap (M3-UX-1), but only while it still matches the payer and amount.
  if (opened !== null && opened.payerId === payerId && opened.cents === cents) {
    return card('owes_opened', didYouPay(payer), {
      amountCents: cents,
      primary: markButton(SETTLE_COPY.iPaid, opened.payerId, opened.cents),
      notes,
      secondary: [
        {
          label: SETTLE_COPY.openAgain,
          a11yLabel: SETTLE_COPY.openAgain,
          a11yHint: SETTLE_COPY.opensVenmo,
          action: { kind: 'pay', url, payerId, cents },
        },
      ],
    });
  }
  return card('owes', owesLabel(payer), {
    amountCents: cents,
    primary: payButton(payer, handle, url, payerId, cents),
    notes,
    secondary: [markButton(SETTLE_COPY.alreadyPaid, payerId, cents)],
  });
}

/** The "your part" card for every role and state (brief §3). */
export function settleCard(input: SettleViewInput): SettleCardModel {
  const { plan } = input;
  // A blocked plan shows no amounts, but a marked viewer is told their mark isn't lost (M3-UX-10, R6).
  const markSaved: CardLine[] = input.viewerMarked ? [{ text: SETTLE_COPY.blockedMarkSaved, tone: 'muted' }] : [];
  switch (plan.status) {
    case 'blocked':
      return card('blocked', SETTLE_COPY.blockedLabel, {
        lines: [{ text: blockedBody(plan.unclaimedRows, plan.unclaimedDiscountRows), tone: 'muted' }, ...markSaved],
        primary: backButton,
      });
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
    case 'ready': {
      if (input.viewerId === plan.payerId) return payerCard(plan);
      const me = plan.people.find((p) => p.userId === input.viewerId);
      // Not on the bill (can't happen: fetchBill is not_found for non-participants).
      if (!me || me.role === 'payer') return card('nothing', SETTLE_COPY.nothingLabel, { lines: [{ text: SETTLE_COPY.nothingBody, tone: 'muted' }] });
      return oweCard(me, input, plan.payerId);
    }
  }
}

/** The "Add your Venmo" card above the payer's card (§3.8), or null. Shown only when someone owes the viewer. */
export function addVenmoPrompt(
  input: Pick<SettleViewInput, 'plan' | 'viewerId' | 'payerVenmo'>,
): { text: string; button: SettleButton & { action: { kind: 'add_venmo' } } } | null {
  const { plan } = input;
  if (plan.status !== 'ready' || plan.payerId !== input.viewerId || plan.owingCount === 0) return null;
  if (input.payerVenmo !== null) return null;
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
export function canChangePayer(viewerId: string, hostId: string, participantCount: number, plan: SettlePlan): boolean {
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

export type SettleRowModel = {
  userId: string;
  name: string;
  amountCents: number;
  status: { text: string; tone: 'success' | 'muted' } | null;
  subLine: { text: string; tone: 'warning' | 'muted' } | null;
  /** The row's one screen-reader label: everything the row shows that matters. */
  a11yLabel: string;
  undo: SettleRowUndo | null;
  request: SettleRowRequest | null;
};

/** Q1–Q4 for an unmarked ower, seen by the payer. The amount is owedCents as is (components do no arithmetic). */
function requestFor(userId: string, name: string, cents: number, input: SettleViewInput): SettleRowRequest {
  const handle = input.venmoOf(userId);
  const url = handle === null ? null : venmoRequestUrl({ username: handle, cents, itemNames: input.itemNamesOf(userId) });
  // The username rule lives only in venmoLink (review R6): a null link with an amount outside C2 is
  // Q4; any other null link means the username is missing or unusable (Q2, Q3).
  if (handle === null || url === null) {
    return { kind: 'caption', caption: isSettleCents(cents) ? SETTLE_COPY.requestNoVenmo : SETTLE_COPY.requestTooLarge };
  }
  return {
    kind: 'link',
    userId,
    url,
    cents,
    handle,
    caption: `@${handle}`,
    label: SETTLE_COPY.request,
    a11yLabel: requestA11yLabel(name, handle, cents),
    a11yHint: SETTLE_COPY.opensVenmo,
  };
}

export type SettlePeopleModel = { title: string; aside: string | null; rows: SettleRowModel[] };

function rowFor(e: Extract<SettleEntry, { owedCents: number }>, plan: SettleReady, input: SettleViewInput): SettleRowModel {
  const name = input.nameOf(e.userId);
  const payer = input.nameOf(plan.payerId);
  const viewerIsPayer = input.viewerId === plan.payerId;
  const amount = formatCents(e.owedCents);

  // Q4: the host, the payer and the person can undo. The viewer's own Undo lives on their card only
  // (one home per action), so their row has none.
  const mayUndo = e.mark !== null && e.userId !== input.viewerId && (input.viewerId === input.hostId || viewerIsPayer);
  const undo: SettleRowUndo | null = mayUndo
    ? { userId: e.userId, confirm: true, a11yLabel: `Undo ${name}'s I paid`, confirmText: undoOtherConfirm(name) }
    : null;

  if (e.mark) {
    const paid = { text: SETTLE_COPY.rowPaid, tone: 'success' as const };
    if (e.markDiffers) {
      const marked = formatCents(e.mark.cents);
      return {
        userId: e.userId,
        name,
        amountCents: e.owedCents,
        status: paid,
        subLine: { text: `Marked ${marked} · share now ${amount}`, tone: 'warning' },
        a11yLabel: `${name}, marked paid ${marked}, share is now ${amount}`,
        undo,
        request: null,
      };
    }
    return { userId: e.userId, name, amountCents: e.owedCents, status: paid, subLine: null, a11yLabel: `${name}, ${amount}, paid`, undo, request: null };
  }

  if (e.role === 'payer_owes_them') {
    const back = formatCents(-e.owedCents);
    const text = viewerIsPayer
      ? `You owe ${name} ${back}. Settle that outside the app.`
      : `${payer} owes ${name}. Settle outside the app.`;
    const a11y = viewerIsPayer
      ? `${name}, you owe ${name} ${back}, settle outside the app`
      : `${name}, ${payer} owes ${name} ${back}, settle outside the app`;
    return { userId: e.userId, name, amountCents: e.owedCents, status: null, subLine: { text, tone: 'muted' }, a11yLabel: a11y, undo: null, request: null };
  }

  return {
    userId: e.userId,
    name,
    amountCents: e.owedCents,
    status: { text: SETTLE_COPY.rowNotYet, tone: 'muted' },
    subLine: null,
    a11yLabel: `${name}, ${amount}, not paid yet`,
    undo: null,
    // Only 'owes' reaches here unmarked ('nothing' rows are listed only with a mark).
    request: viewerIsPayer && e.role === 'owes' ? requestFor(e.userId, name, e.owedCents, input) : null,
  };
}

/**
 * The Everyone list, or null when it isn't shown (blocked plans, or nobody to list). Rows: people
 * who owe and negative shares, plus a 'nothing' person who has a mark. Never the payer. The viewer
 * first, then plan order, so rows don't move when someone pays (M3-UX-12).
 */
export function settlePeople(input: SettleViewInput): SettlePeopleModel | null {
  const { plan } = input;
  if (plan.status !== 'ready') return null;
  const listed = plan.people.filter(
    (e): e is Extract<SettleEntry, { owedCents: number }> =>
      e.role !== 'payer' && (e.role !== 'nothing' || e.mark !== null),
  );
  if (listed.length === 0) return null;
  const ordered = [...listed.filter((e) => e.userId === input.viewerId), ...listed.filter((e) => e.userId !== input.viewerId)];
  // The payer's card already says "1 of 2 paid" right above, so their list has no aside (review R4).
  const viewerIsPayer = input.viewerId === plan.payerId;
  const aside =
    plan.owingCount === 0 || viewerIsPayer ? null : plan.allPaid ? SETTLE_COPY.allPaidAside : paidOfText(plan.paidCount, plan.owingCount);
  return { title: SETTLE_COPY.everyoneTitle, aside, rows: ordered.map((e) => rowFor(e, plan, input)) };
}

/**
 * R3's web line under the list: web, the payer, and at least one Request link on screen. Else null.
 * `people` is settlePeople(input), already built by the caller (review R4: not built twice).
 */
export function settleRequestWebLine(input: SettleViewInput, people: SettlePeopleModel | null): string | null {
  if (input.platform !== 'web' || input.plan.status !== 'ready' || input.viewerId !== input.plan.payerId) return null;
  const rows = people?.rows ?? [];
  return rows.some((r) => r.request?.kind === 'link') ? SETTLE_COPY.requestWebLine : null;
}

/** A Pay link that didn't open: what it described (review R2). Screen state, never persisted. */
export type PayOpenFailure = { payerId: string; cents: number; handle: string };

/**
 * "Couldn't open Venmo. Send $X to @y…" only while it still describes the bill: the same payer, the
 * viewer still owes exactly that amount, and the payer's username is unchanged (review R2). Else null.
 */
export function payOpenFailedLine(input: SettleViewInput, failure: PayOpenFailure | null): string | null {
  if (failure === null || input.payerVenmo !== failure.handle) return null;
  return openedStillMatches(input.plan, input.viewerId, failure) ? openFailedText(failure.handle, failure.cents) : null;
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

/** What the screen last showed, compared on every refetch. */
export type NoticeSnapshot = { payerId: string; myMark: boolean };

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
  if (prev.myMark && !next.myMark && !ctx.iUndid) return SETTLE_COPY.markUndoneBanner;
  return null;
}

/** The banner text for a failed mark, undo or payer change, and whether the screen re-reads. */
export function actionError(error: BillError): { text: string; refetch: boolean } {
  switch (error) {
    case 'payer_changed':
    case 'not_complete':
    case 'marks_changed':
      return { text: BILL_ERROR_COPY[error], refetch: true };
    case 'not_allowed':
      return { text: BILL_ERROR_COPY.not_allowed, refetch: false };
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

export type SettleFooterModel = { variant: 'primary' | 'secondary'; caption: string | null; a11yHint: string };

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
  | ({ kind: 'settle' } & SettleFooterModel)
  | { kind: 'pay'; button: SettleButton & { action: PayAction }; notes: string[]; details: FooterLink }
  | { kind: 'did_you_pay'; text: string; iPaid: SettleButton & { action: MarkAction }; notYet: { label: string; a11yLabel: string }; details: FooterLink };

const DETAILS_LINK: FooterLink = { label: SETTLE_COPY.details, a11yLabel: SETTLE_COPY.detailsA11y, a11yHint: SETTLE_COPY.detailsHint };

function hasPay(b: SettleButton | null): b is SettleButton & { action: PayAction } {
  return b !== null && b.action.kind === 'pay';
}
function hasMark(b: SettleButton | null): b is SettleButton & { action: MarkAction } {
  return b !== null && b.action.kind === 'mark';
}

/** The footer, derived from the same settleCard the Settle page shows, so the fallbacks can't drift (F1). */
export function settleFooterAction(input: SettleViewInput, participantCount: number): SettleFooterAction | null {
  const { plan } = input;
  const unclaimed = plan.status === 'blocked' ? plan.unclaimedRows : 0;
  const unclaimedDiscounts = plan.status === 'blocked' ? plan.unclaimedDiscountRows : 0;
  const base = settleFooter(participantCount, unclaimed, unclaimedDiscounts);
  if (base === null) return null; // F-a
  const settle: SettleFooterAction = { kind: 'settle', ...base }; // F-b (blocked) or F-f
  if (plan.status !== 'ready') return settle;

  const cardModel = settleCard(input);
  switch (cardModel.state) {
    case 'owes':
      return hasPay(cardModel.primary) ? { kind: 'pay', button: cardModel.primary, notes: cardModel.notes, details: DETAILS_LINK } : settle;
    case 'owes_opened':
      return hasMark(cardModel.primary)
        ? {
            kind: 'did_you_pay',
            text: cardModel.label,
            iPaid: cardModel.primary,
            notYet: { label: SETTLE_COPY.rowNotYet, a11yLabel: SETTLE_COPY.rowNotYet },
            details: DETAILS_LINK,
          }
        : settle;
    case 'marked':
      return { ...settle, caption: SETTLE_COPY.markedPaid }; // F-e
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
 * Whether the "Did you pay?" prompt still matches the bill: the same payer, and the viewer still
 * owes exactly the amount they opened Venmo with (§3.2). Otherwise the screen drops it.
 */
export function openedStillMatches(plan: SettlePlan, viewerId: string, opened: OpenedVenmo): boolean {
  if (plan.status !== 'ready' || plan.payerId !== opened.payerId) return false;
  const me = plan.people.find((p) => p.userId === viewerId);
  return me !== undefined && me.role === 'owes' && me.owedCents === opened.cents;
}
