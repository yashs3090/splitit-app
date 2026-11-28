// The groups worked example (test-utils/groupFixtures.ts) as a parsed GroupSnapshot (lib/groups.ts),
// for the T10 view-model tests. Names, hosts, Venmo usernames, timestamps and payment ids are added
// here; the money comes unchanged from the WorkedCase inputs, so the nets are the spec's.

import type { GroupBalanceInput, GroupBill } from '@/lib/groupBalance';
import type { GroupSnapshot, SnapshotBill, SnapshotNotReceived, SnapshotPayment, SnapshotRow } from '@/lib/groups';
import {
  AIRBNB_ID,
  ANA,
  BEN,
  BRUNCH_ID,
  BRUNCH_ROWS,
  CY,
  DEE,
  DINNER_ID,
  DINNER_ROWS,
  MEMBERS,
  NAMES,
  RENTAL_CAR_ID,
} from './groupFixtures';

export const GROUP_ID = '9a000000-0000-4000-8000-000000000001';
export const GROUP_NAME = 'Tahoe trip';
export const VENMO: Readonly<Record<string, string | null>> = { [ANA]: 'ana-1', [BEN]: 'ben-1', [CY]: 'cy-1', [DEE]: 'dee-1' };

export const ROW_NAMES: Readonly<Record<string, string>> = {
  [DINNER_ROWS.ana]: 'Pasta',
  [DINNER_ROWS.ben]: 'Steak',
  [DINNER_ROWS.cy]: 'Salad',
  [DINNER_ROWS.nachos]: 'Nachos',
  [DINNER_ROWS.water]: 'Water',
  [DINNER_ROWS.happyHour]: 'Happy hour',
  [BRUNCH_ROWS.ana]: 'Pancakes',
  [BRUNCH_ROWS.ben]: 'Eggs',
  [BRUNCH_ROWS.cy]: 'Toast',
  [BRUNCH_ROWS.dee]: 'Waffles',
};

const HOSTS: Readonly<Record<string, string>> = { [DINNER_ID]: ANA, [BRUNCH_ID]: BEN };
const TITLES: Readonly<Record<string, string>> = { [AIRBNB_ID]: 'Airbnb', [RENTAL_CAR_ID]: 'Rental car' };

/** Minutes after the trip started, as an ISO timestamp. */
export const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 20, 12, minutes)).toISOString();
const BILL_AT: Readonly<Record<string, number>> = { [DINNER_ID]: 10, [BRUNCH_ID]: 30 };
const EXPENSE_AT: Readonly<Record<string, number>> = { [AIRBNB_ID]: 0, [RENTAL_CAR_ID]: 20 };

export const paymentId = (n: number) => `9c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;


function snapshotBill(b: GroupBill): SnapshotBill {
  const rows: SnapshotRow[] = b.split.items.map((item) => {
    const claims: Record<string, number> = {};
    for (const c of b.split.claims) if (c.itemId === item.id) claims[c.userId] = c.parts;
    const claimed = Object.keys(claims).length > 0;
    return {
      id: item.id,
      totalCents: item.totalCents,
      kind: item.kind ?? 'item',
      name: claimed ? null : (ROW_NAMES[item.id] ?? 'Item'),
      claims,
    };
  });
  return {
    id: b.id,
    hostId: HOSTS[b.id] ?? b.payerId,
    payerId: b.payerId,
    totalCents: b.totalCents,
    extrasSplit: b.split.extrasMode ?? 'proportional',
    createdAt: at(BILL_AT[b.id] ?? 40),
    rows,
    participantIds: [...b.split.participantIds],
  };
}

export type SnapshotOptions = {
  venmo?: Readonly<Record<string, string | null>>;
  /** Overrides per payment index (id, method, source, recordedBy, createdAt). */
  payments?: readonly Partial<SnapshotPayment>[];
  groupName?: string;
  /** GR-M6's `not_received` rows (T6). */
  notReceived?: readonly SnapshotNotReceived[];
  /** The viewer's "I wasn't part of this" bills (group claim status C4). Default none. */
  notPartBillIds?: readonly string[];
  /** Delete group contract F. Default FINGERPRINT. */
  moneyFingerprint?: string;
  /** The members, in this order. Default MEMBERS (the worked example's four). */
  members?: readonly string[];
  /** The viewer's "Hide for me". Default false. */
  hidden?: boolean;
};

/** A valid money_fingerprint (32 lowercase hex). The app never computes one; it only sends it back. */
export const FINGERPRINT = '0123456789abcdef0123456789abcdef';

export function snapshotOf(input: GroupBalanceInput, opts: SnapshotOptions = {}): GroupSnapshot {
  const venmo = opts.venmo ?? VENMO;
  const payments: SnapshotPayment[] = input.payments.map((p, i) => {
    const o = opts.payments?.[i] ?? {};
    return {
      id: paymentId(i + 1),
      from: p.from,
      to: p.to,
      cents: p.cents,
      source: 'manual',
      method: 'other',
      recordedBy: p.from,
      billId: null,
      createdAt: at(60 + i),
      ...o,
    };
  });
  return {
    group: { id: GROUP_ID, name: opts.groupName ?? GROUP_NAME, joinCode: '0123456789abcdef0123', createdBy: ANA, createdAt: at(0) },
    me: { hidden: opts.hidden ?? false, notPartBillIds: [...(opts.notPartBillIds ?? [])] },
    members: (opts.members ?? MEMBERS).map((userId, i) => ({
      userId,
      displayName: NAMES[userId] ?? null,
      venmoUsername: venmo[userId] ?? null,
      joinedAt: at(i),
    })),
    bills: input.bills.map(snapshotBill),
    expenses: input.expenses.map((e) => ({
      id: e.id,
      title: TITLES[e.id] ?? 'Expense',
      payerId: e.payerId,
      amountCents: e.amountCents,
      splitMethod: e.id === RENTAL_CAR_ID ? 'exact' : 'equal',
      createdBy: e.payerId,
      createdAt: at(EXPENSE_AT[e.id] ?? 50),
      editedAt: null,
      version: 1,
      shares: e.shares.map((s) => ({ ...s })),
    })),
    payments,
    notReceived: [...(opts.notReceived ?? [])],
    moneyFingerprint: opts.moneyFingerprint ?? FINGERPRINT,
  };
}

/**
 * The same snapshot with the viewer's opt-outs set to `billIds` (group claim status C4). Ids are
 * sorted like the database's `order by bill_id`; pass only ids of the snapshot's bills, as the
 * parser requires.
 */
export function withNotPart(snapshot: GroupSnapshot, billIds: readonly string[]): GroupSnapshot {
  return { ...snapshot, me: { ...snapshot.me, notPartBillIds: [...billIds].sort() } };
}
