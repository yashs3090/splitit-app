// Feed fixtures (spec docs/specs/2026-11-28-tab-bar-and-activity.md, Contracts A, F and G).
// Events are shaped exactly like the Contract A selects (snake_case columns):
//   bill_events:  id, bill_id, actor_id, kind, item_name, details, created_at
//   group_events: id, group_id, actor_id, kind, details, created_at
// Detail shapes follow the installed migrations (private.log_event / log_group_event callers).
// One event per F-row (the condition met, and where the table allows, unmet) plus the boundary
// cases. Reused by Tasks 2, 3, 4 and 11: keep the names stable.
//
// People: Me (the viewer), Maya (hosts B1), Sam (hosts B2), Ana.
// Places: B1 (Maya's bill, no group), B2 (Sam's bill, in group G1), G1 (visible), G2 (hidden).

import type {
  FeedBillEventRow,
  FeedBillPlace,
  FeedContext,
  FeedGroupEventRow,
  FeedGroupPlace,
  FeedPayment,
} from '@/lib/feedRules';

export const ME = '0e000000-0000-4000-8000-000000000001';
export const MAYA = '0a000000-0000-4000-8000-000000000002';
export const SAM = '05000000-0000-4000-8000-000000000003';
export const ANA = '0c000000-0000-4000-8000-000000000004';
export const FEED_NAMES: Readonly<Record<string, string>> = { [MAYA]: 'Maya', [SAM]: 'Sam', [ANA]: 'Ana' };

export const B1 = 'b1000000-0000-4000-8000-0000000000b1';
export const B2 = 'b2000000-0000-4000-8000-0000000000b2';
/** A bill I'm not on (not in the context). */
export const B_OTHER = 'b9000000-0000-4000-8000-0000000000b9';
export const G1 = '91000000-0000-4000-8000-000000000091';
export const G2_HIDDEN = '92000000-0000-4000-8000-000000000092';
/** A group I'm not in. */
export const G_OTHER = '99000000-0000-4000-8000-000000000099';

export const P_SAM_TO_ME = 'a1000000-0000-4000-8000-0000000000a1';
export const P_ME_TO_ANA = 'a2000000-0000-4000-8000-0000000000a2';
export const P_SAM_TO_ANA = 'a3000000-0000-4000-8000-0000000000a3';
export const P_MISSING = 'a9000000-0000-4000-8000-0000000000a9';
export const EXPENSE_GAS = 'e5000000-0000-4000-8000-0000000000e5';

/** When I joined every place. Events at exactly this time are included (FEED-5). */
export const JOINED_AT = '2026-11-20T12:00:00.000Z';
export const JOINED_AT_MINUS_1MS = '2026-11-20T11:59:59.999Z';
/** The default time of a fixture event: after JOINED_AT. */
export const EVENT_AT = '2026-11-27T19:42:00.000Z';
/** G1's device-local opened time in the Groups-dot tests. */
export const G1_OPENED_AT = '2026-11-27T18:00:00.000Z';

let seq = 0;
/** A fresh event id (uuid v4 shape). */
export function eventId(): string {
  seq += 1;
  return `e0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

export function billEvent(kind: string, over: Partial<FeedBillEventRow> = {}): FeedBillEventRow {
  return {
    id: eventId(),
    bill_id: B1,
    actor_id: MAYA,
    kind,
    item_name: null,
    details: {},
    created_at: EVENT_AT,
    ...over,
  };
}

export function groupEvent(kind: string, over: Partial<FeedGroupEventRow> = {}): FeedGroupEventRow {
  return {
    id: eventId(),
    group_id: G1,
    actor_id: ANA,
    kind,
    details: {},
    created_at: EVENT_AT,
    ...over,
  };
}

export const FEED_BILLS: ReadonlyMap<string, FeedBillPlace> = new Map<string, FeedBillPlace>([
  [B1, { joinedAt: JOINED_AT, groupId: null, hostId: MAYA }],
  [B2, { joinedAt: JOINED_AT, groupId: G1, hostId: SAM }],
]);

export const FEED_GROUPS: ReadonlyMap<string, FeedGroupPlace> = new Map<string, FeedGroupPlace>([
  [G1, { joinedAt: JOINED_AT, hidden: false }],
  [G2_HIDDEN, { joinedAt: JOINED_AT, hidden: true }],
]);

export const FEED_PAYMENTS: ReadonlyMap<string, FeedPayment> = new Map<string, FeedPayment>([
  [P_SAM_TO_ME, { from: SAM, to: ME, cents: 2500 }],
  [P_ME_TO_ANA, { from: ME, to: ANA, cents: 3000 }],
  [P_SAM_TO_ANA, { from: SAM, to: ANA, cents: 4400 }],
]);

/** Minimal BillData slices for myClaimedRowNames: I claim Tacos and Nachos on B1 and Pizza on B2. */
export const ROW_TACOS = '10000000-0000-4000-8000-000000000001';
export const ROW_NACHOS = '10000000-0000-4000-8000-000000000002';
export const ROW_FRIES = '10000000-0000-4000-8000-000000000003';
export const ROW_PIZZA = '10000000-0000-4000-8000-000000000004';
export const B1_CLAIMS_DATA = {
  rows: [
    { id: ROW_TACOS, name: ' Tacos ' },
    { id: ROW_NACHOS, name: 'Nachos' },
    { id: ROW_FRIES, name: 'Fries' },
  ],
  claims: [
    { line_item_id: ROW_TACOS, user_id: ME, parts: 1 },
    { line_item_id: ROW_NACHOS, user_id: ME, parts: 1 },
    { line_item_id: ROW_NACHOS, user_id: SAM, parts: 1 },
    { line_item_id: ROW_FRIES, user_id: SAM, parts: 1 },
  ],
};
export const B2_CLAIMS_DATA = {
  rows: [{ id: ROW_PIZZA, name: 'Pizza' }],
  claims: [{ line_item_id: ROW_PIZZA, user_id: ME, parts: 1 }],
};

/** No claims anywhere: F-h / F-i / F-k are unmet. */
export const NO_CLAIMS: ReadonlyMap<string, ReadonlySet<string>> = new Map();

/** The default context. `myClaims` is passed in so tests build it through myClaimedRowNames. */
export function feedCtx(myClaims: ReadonlyMap<string, ReadonlySet<string>>, over: Partial<FeedContext> = {}): FeedContext {
  return { myId: ME, bills: FEED_BILLS, groups: FEED_GROUPS, myClaims, payments: FEED_PAYMENTS, ...over };
}

// ---------------------------------------------------------------------------------------------
// One event per F-row. `met` meets the row's condition; `unmet` is the same event with the
// condition unmet (null when the table says the row is "always").

export type FeedCase = { met: FeedBillEventRow | FeedGroupEventRow; unmet: FeedBillEventRow | FeedGroupEventRow | null };

const split = (entries: Record<string, number>) => entries;

export const F_CASES = {
  'F-a': {
    met: billEvent('participant_added', { details: { user_id: ME } }),
    unmet: billEvent('participant_added', { details: { user_id: ANA } }),
  },
  'F-b': {
    met: billEvent('assigned', { item_name: 'Tacos', details: { user_id: ME } }),
    unmet: billEvent('assigned', { item_name: 'Tacos', details: { user_id: SAM } }),
  },
  'F-c': {
    met: billEvent('marked_paid', { actor_id: SAM, details: { payer_id: ME, cents: 1820, method: 'venmo' } }),
    unmet: billEvent('marked_paid', { actor_id: SAM, details: { payer_id: MAYA, cents: 1820, method: 'venmo' } }),
  },
  'F-d': {
    met: billEvent('paid_difference', { actor_id: SAM, details: { payer_id: ME, from: 1000, to: 1285, method: 'other' } }),
    unmet: billEvent('paid_difference', { actor_id: SAM, details: { payer_id: MAYA, from: 1000, to: 1285, method: 'other' } }),
  },
  'F-e': {
    met: billEvent('paid_back', { actor_id: SAM, details: { user_id: ME, payer_id: SAM, from: 1285, to: 1000, method: 'cash' } }),
    unmet: billEvent('paid_back', { actor_id: SAM, details: { user_id: MAYA, payer_id: SAM, from: 1285, to: 1000, method: 'cash' } }),
  },
  'F-f': {
    met: billEvent('unmarked_paid', { actor_id: MAYA, details: { user_id: ME, cents: 1820 } }),
    unmet: billEvent('unmarked_paid', { actor_id: MAYA, details: { user_id: SAM, cents: 1820 } }),
  },
  'F-g': {
    met: billEvent('not_received', { actor_id: MAYA, details: { user_id: ME, payer_id: MAYA, cents: 1820, method: 'venmo' } }),
    unmet: billEvent('not_received', { actor_id: MAYA, details: { user_id: SAM, payer_id: MAYA, cents: 1820, method: 'venmo' } }),
  },
  'F-h': {
    met: billEvent('amounts_changed', { details: { tip_cents: [200, 400], tax_cents: [100, 120] } }),
    // Unmet: the same event, classified with a context where I claim nothing on B1 (NO_CLAIMS).
    unmet: billEvent('amounts_changed', { details: { tip_cents: [200, 400], tax_cents: [100, 120] } }),
  },
  'F-i': {
    met: billEvent('extras_split_changed', { details: { before: 'proportional', after: 'equal' } }),
    unmet: billEvent('extras_split_changed', { details: { before: 'proportional', after: 'equal' } }),
  },
  'F-j': {
    met: billEvent('item_removed', { item_name: 'Nachos', details: { qty: 1, price_cents: 900, claimer_ids: [ME, SAM] } }),
    unmet: billEvent('item_removed', { item_name: 'Fries', details: { qty: 1, price_cents: 500, claimer_ids: [SAM] } }),
  },
  'F-k': {
    met: billEvent('item_changed', { item_name: 'Tacos', details: { price_cents: [1200, 1400] } }),
    unmet: billEvent('item_changed', { item_name: 'Fries', details: { price_cents: [500, 600] } }),
  },
  'F-l': {
    met: billEvent('split_changed', { item_name: 'Nachos', details: { before: split({ [ME]: 1, [SAM]: 1 }), after: split({ [ME]: 2, [SAM]: 1 }) } }),
    unmet: billEvent('split_changed', { item_name: 'Fries', details: { before: split({ [SAM]: 1, [ANA]: 1 }), after: split({ [SAM]: 2, [ANA]: 1 }) } }),
  },
  'F-m': {
    met: billEvent('unassigned', { item_name: 'Tacos', details: { user_id: ME } }),
    unmet: billEvent('unassigned', { item_name: 'Fries', details: { user_id: SAM } }),
  },
  'F-n': {
    met: billEvent('payers_changed', {
      details: { before: [{ user_id: MAYA, cents: 0 }], after: [{ user_id: SAM, cents: 0 }], moved: [{ from_user: ME, to_user: MAYA, cents: 1820 }] },
    }),
    unmet: billEvent('payers_changed', {
      details: { before: [{ user_id: MAYA, cents: 0 }], after: [{ user_id: SAM, cents: 0 }], moved: [] },
    }),
  },
  'F-o': {
    met: billEvent('payer_changed', { details: { before: MAYA, after: ME, cleared: 0 } }),
    unmet: billEvent('payer_changed', { details: { before: MAYA, after: SAM, cleared: 0 } }),
  },
  'F-p': {
    met: billEvent('claimed', { actor_id: SAM, item_name: 'Fries', details: {} }),
    unmet: null,
  },
  'F-r': {
    met: groupEvent('payment_recorded', {
      actor_id: SAM,
      details: { payment_id: P_SAM_TO_ME, from: SAM, to: ME, cents: 2500, method: 'venmo', source: 'venmo_link' },
    }),
    unmet: groupEvent('payment_recorded', {
      actor_id: SAM,
      details: { payment_id: P_SAM_TO_ANA, from: SAM, to: ANA, cents: 4400, method: 'venmo', source: 'venmo_link' },
    }),
  },
  'F-s': {
    met: groupEvent('payment_undone', { actor_id: SAM, details: { payment_id: P_SAM_TO_ME, undone_reason: 'undo' } }),
    unmet: groupEvent('payment_undone', { actor_id: SAM, details: { payment_id: P_SAM_TO_ANA, undone_reason: 'undo' } }),
  },
  'F-t': {
    met: groupEvent('payment_undone', { actor_id: ANA, details: { payment_id: P_ME_TO_ANA, undone_reason: 'not_received' } }),
    // Unmet: the actor is not the payment's recipient, so it's F-s (money), not a dispute.
    unmet: groupEvent('payment_undone', { actor_id: SAM, details: { payment_id: P_ME_TO_ANA, undone_reason: 'undo' } }),
  },
  'F-u': {
    met: groupEvent('expense_added', { details: { expense_id: EXPENSE_GAS, title: 'Gas', amount_cents: 6000 } }),
    unmet: null,
  },
  'F-v': {
    met: groupEvent('bill_added', { actor_id: SAM, details: { bill_id: B2, converted: 0 } }),
    unmet: null,
  },
  'F-w': {
    met: groupEvent('member_joined', { actor_id: ANA, details: {} }),
    unmet: null,
  },
} satisfies Record<string, FeedCase>;

/** F-p's other kinds and F-q's "not about me" variants. */
export const ROLLUP_EVENTS = {
  unclaimed: billEvent('unclaimed', { actor_id: SAM, item_name: 'Fries', details: {} }),
  joined: billEvent('joined', { actor_id: ANA, details: {} }),
  splitNotMe: F_CASES['F-l'].unmet,
  assignedSam: F_CASES['F-b'].unmet,
  unassignedSam: F_CASES['F-m'].unmet,
  addedAna: F_CASES['F-a'].unmet,
};

/** F-r from me (C7): Ana records my payment to her. F-u's other kinds. F-v removed, my own bill. */
export const MORE_EVENTS = {
  recordedFromMe: groupEvent('payment_recorded', {
    actor_id: ANA,
    details: { payment_id: P_ME_TO_ANA, from: ME, to: ANA, cents: 3000, method: 'cash', source: 'manual' },
  }),
  expenseEdited: groupEvent('expense_edited', {
    details: {
      expense_id: EXPENSE_GAS,
      before: { title: 'Gas', amount_cents: 6000, payer_id: ANA, split_method: 'equal' },
      after: { title: 'Gas', amount_cents: 6500, payer_id: ANA, split_method: 'equal' },
    },
  }),
  expenseDeleted: groupEvent('expense_deleted', { details: { expense_id: EXPENSE_GAS, title: 'Gas', amount_cents: 6500 } }),
  billRemovedMine: groupEvent('bill_removed', { actor_id: SAM, details: { bill_id: B_OTHER } }),
  paymentMissing: groupEvent('payment_undone', { actor_id: SAM, details: { payment_id: P_MISSING, undone_reason: 'undo' } }),
  itemChangedNameOnly: billEvent('item_changed', { item_name: 'Tacos', details: { name: ['Tacos', 'Taco plate'] } }),
  itemChangedNoteOnly: billEvent('item_changed', { item_name: 'Tacos', details: { note_changed: true } }),
  itemChangedQty: billEvent('item_changed', { item_name: 'Nachos', details: { qty: [1, 2] } }),
  /** A2.1: a quantity drop that removed my claim (I no longer claim Fries' row, so only the list says so). */
  itemChangedRemovedMe: billEvent('item_changed', { item_name: 'Fries', details: { qty: [2, 1], removed_claimer_ids: [ME] } }),
  /** A2.1 unmet: the drop removed only Sam's claim, on a row I don't claim. */
  itemChangedRemovedSam: billEvent('item_changed', { item_name: 'Fries', details: { qty: [2, 1], removed_claimer_ids: [SAM] } }),
  /** B2 is in G1: its events belong to the Groups filter. */
  groupBillPaid: billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 990, method: 'venmo' } }),
};

/** Kinds that are always excluded, with valid-looking details. */
export const EXCLUDED_BILL_EVENTS = [
  billEvent('bill_created', { details: { items: 3, total_cents: 4200 } }),
  billEvent('item_added', { item_name: 'Soda', details: { qty: 1, price_cents: 300 } }),
  billEvent('link_rotated', { details: {} }),
  billEvent('left', { actor_id: SAM, details: {} }),
  billEvent('participant_removed', { details: { user_id: SAM } }),
  billEvent('moved_to_group', { details: { group_id: G1, converted: 0 } }),
  billEvent('removed_from_group', { details: { group_id: G1 } }),
];

export const EXCLUDED_GROUP_EVENTS = [
  groupEvent('group_created', { details: { name: 'Tahoe' } }),
  groupEvent('member_left', { details: {} }),
  groupEvent('renamed', { details: { from: 'Tahoe', to: 'Tahoe 2026' } }),
  groupEvent('link_rotated', { details: {} }),
];
