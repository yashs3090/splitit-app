// T10 group Activity sentences (spec T10, criteria 55, 126; A2.1 method).
// lib/groups.ts imports the Supabase client; these tests only use its types and balanceInputOf.
jest.mock('./supabase', () => ({ supabase: {} }));
import { makeNameOf } from './billView';
import { describeGroupEvent, paymentsFromEvents, type GroupEventContext } from './groupActivityText';
import type { GroupEvent } from './groups';

const ANA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BEN = 'bbbbbbbb-0000-4000-8000-000000000002';
const GONE = 'ffffffff-0000-4000-8000-000000000009';
const EXP = 'e1000000-0000-4000-8000-000000000001';
const PAY = '9c000000-0000-4000-8000-000000000001';
const BILL = 'b1000000-0000-4000-8000-000000000001';

const people = [
  { userId: ANA, displayName: 'Ana' },
  { userId: BEN, displayName: 'Ben' },
];
const asBen = makeNameOf(people, BEN);
const asAna = makeNameOf(people, ANA);
const ctx: GroupEventContext = { expenseTitle: (id) => (id === EXP ? 'Airbnb' : null) };

let seq = 0;
const ev = (kind: string, actorId: string | null, details: unknown): GroupEvent => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  seq,
  actorId,
  kind,
  details,
  createdAt: '2026-11-26T12:00:00.000Z',
});
const say = (e: GroupEvent, nameOf = asBen, c: GroupEventContext = ctx) => describeGroupEvent(e, nameOf, c);

describe('membership and group events', () => {
  it('created, with and without the name', () => {
    expect(say(ev('group_created', ANA, { name: 'Tahoe trip' }))).toBe('Ana created Tahoe trip');
    expect(say(ev('group_created', ANA, { name: 'Tahoe trip' }), asAna)).toBe('You created Tahoe trip');
    expect(say(ev('group_created', ANA, {}))).toBe('Ana created the group');
  });
  it('joined / left, the viewer, and a deleted account', () => {
    expect(say(ev('member_joined', ANA, {}))).toBe('Ana joined');
    expect(say(ev('member_joined', BEN, {}))).toBe('You joined');
    expect(say(ev('member_left', ANA, {}))).toBe('Ana left');
    expect(say(ev('member_left', null, {}))).toBe('Someone left');
    expect(say(ev('member_joined', GONE, {}))).toBe('Someone joined');
  });
  it('renamed and new link', () => {
    expect(say(ev('renamed', ANA, { from: 'Tahoe', to: 'Tahoe trip' }))).toBe('Ana renamed the group to Tahoe trip');
    expect(say(ev('renamed', BEN, { from: 'Tahoe', to: 'Tahoe trip' }))).toBe('You renamed the group to Tahoe trip');
    expect(say(ev('renamed', ANA, { from: 'x' }))).toBeNull();
    expect(say(ev('link_rotated', ANA, {}))).toBe('Ana made a new invite link');
    expect(say(ev('link_rotated', BEN, {}))).toBe('You made a new invite link');
  });
});

describe('expenses', () => {
  it('added / deleted with a known title, and without', () => {
    expect(say(ev('expense_added', ANA, { expense_id: EXP, amount_cents: 24000 }))).toBe('Ana added Airbnb, $240.00');
    expect(say(ev('expense_added', BEN, { expense_id: EXP, amount_cents: 1 }))).toBe('You added Airbnb, $0.01');
    const other = 'e2000000-0000-4000-8000-000000000002';
    expect(say(ev('expense_added', ANA, { expense_id: other, amount_cents: 24000 }))).toBe('Ana added an expense of $240.00');
    expect(say(ev('expense_deleted', ANA, { expense_id: other, amount_cents: 24000 }))).toBe('Ana deleted an expense of $240.00');
    expect(say(ev('expense_deleted', BEN, { expense_id: EXP, amount_cents: 24000 }))).toBe('You deleted Airbnb, $240.00');
    expect(say(ev('expense_added', ANA, { expense_id: EXP, amount_cents: 1.5 }))).toBeNull();
  });
  const edit = (before: object, after: object) => ev('expense_edited', ANA, { expense_id: EXP, before, after });
  const base = { title: 'Airbnb', amount_cents: 24000, payer_id: ANA, split_method: 'equal' };
  it('edited: amount, title, payer, split', () => {
    expect(say(edit(base, { ...base, amount_cents: 25000 }))).toBe('Ana changed Airbnb from $240.00 to $250.00');
    expect(say(edit(base, { ...base, title: 'Cabin' }))).toBe('Ana renamed Airbnb to Cabin');
    expect(say(edit(base, { ...base, payer_id: BEN }))).toBe('Ana changed who paid for Airbnb to you');
    expect(say(edit(base, { ...base, payer_id: BEN }), asAna)).toBe('You changed who paid for Airbnb to Ben');
    expect(say(edit(base, { ...base, split_method: 'exact' }))).toBe('Ana changed how Airbnb is split');
    expect(say(edit(base, base))).toBe('Ana changed how Airbnb is split');
    expect(say(edit(base, { ...base, amount_cents: 'x' }))).toBeNull();
  });
});

describe('payments (criterion 126: viewer as sender and as recipient)', () => {
  const rec = (actor: string, d: object) => ev('payment_recorded', actor, { payment_id: PAY, cents: 13002, ...d });
  it('sent via Venmo', () => {
    const e = rec(BEN, { from: BEN, to: ANA, method: 'venmo', source: 'venmo_link' });
    expect(say(e)).toBe('You sent Ana $130.02 via Venmo');
    expect(say(e, asAna)).toBe('Ben sent you $130.02 via Venmo');
  });
  it('cash and other, recorded by the sender', () => {
    expect(say(rec(BEN, { from: BEN, to: ANA, method: 'cash', source: 'manual' }))).toBe('You paid Ana $130.02 in cash');
    expect(say(rec(BEN, { from: BEN, to: ANA, method: 'other', source: 'manual' }), asAna)).toBe('Ben paid you $130.02');
  });
  it('recorded by the recipient ("Got paid another way")', () => {
    const e = rec(ANA, { from: BEN, to: ANA, method: 'other', source: 'manual' });
    expect(say(e, asAna)).toBe('You got $130.02 from Ben');
    expect(say(e)).toBe('Ana got $130.02 from you');
  });
  it('pre-A2 rows without a method still read (venmo source → Venmo)', () => {
    expect(say(rec(BEN, { from: BEN, to: ANA, source: 'venmo' }))).toBe('You sent Ana $130.02 via Venmo');
    expect(say(rec(BEN, { from: BEN, to: ANA, source: 'manual' }))).toBe('You paid Ana $130.02');
  });
  it('malformed payments are skipped', () => {
    expect(say(rec(BEN, { from: BEN, to: BEN, method: 'cash', source: 'manual' }))).toBeNull();
    expect(say(rec(BEN, { from: BEN, to: ANA, method: 'zelle', source: 'manual' }))).toBeNull();
    expect(say(ev('payment_recorded', BEN, { from: BEN, to: ANA, cents: 0 }))).toBeNull();
  });
  it('undone', () => {
    expect(say(ev('payment_undone', ANA, { payment_id: PAY }))).toBe('Ana undid a payment');
    expect(say(ev('payment_undone', BEN, { payment_id: PAY }))).toBe('You undid a payment');
  });
  it('undone, with the recorded payment known: sender undo and "not received"', () => {
    const c: GroupEventContext = { ...ctx, payment: () => ({ from: BEN, to: ANA, cents: 13002 }) };
    expect(say(ev('payment_undone', BEN, { payment_id: PAY }), asBen, c)).toBe('You undid your $130.02 to Ana');
    expect(say(ev('payment_undone', ANA, { payment_id: PAY }), asBen, c)).toBe("Ana didn't receive your $130.02");
    expect(say(ev('payment_undone', ANA, { payment_id: PAY }), asAna, c)).toBe("You marked Ben's $130.02 as not received");
  });
});

describe('receipts moved in and out', () => {
  it('added with converted marks, counts of 0, 1 and 2', () => {
    expect(say(ev('bill_added', ANA, { bill_id: BILL, converted: 0 }))).toBe('Ana added a receipt');
    expect(say(ev('bill_added', BEN, { bill_id: BILL, converted: 1 }))).toBe("You added a receipt. 1 'I paid' mark became a group payment");
    expect(say(ev('bill_added', ANA, { bill_id: BILL, converted: 2 }))).toBe("Ana added a receipt. 2 'I paid' marks became group payments");
    expect(say(ev('bill_added', ANA, { bill_id: BILL, converted: -1 }))).toBeNull();
  });
  it('removed', () => {
    expect(say(ev('bill_removed', ANA, { bill_id: BILL }))).toBe('Ana took a receipt out of the group');
    expect(say(ev('bill_removed', BEN, { bill_id: BILL }))).toBe('You took a receipt out of the group');
  });
});

describe('safety', () => {
  it('unknown kinds and non-object details are null', () => {
    expect(say(ev('something_new', ANA, {}))).toBeNull();
    expect(say(ev('member_joined', ANA, null))).toBeNull();
    expect(say(ev('renamed', ANA, [1]))).toBeNull();
  });
  it('a context is optional', () => {
    expect(describeGroupEvent(ev('expense_added', ANA, { expense_id: EXP, amount_cents: 100 }), asBen)).toBe('Ana added an expense of $1.00');
  });
});

describe('paymentsFromEvents', () => {
  it('maps recorded payments by id and skips malformed ones', () => {
    const ok = ev('payment_recorded', BEN, { payment_id: PAY, from: BEN, to: ANA, cents: 500, method: 'cash', source: 'manual' });
    const bad = ev('payment_recorded', BEN, { payment_id: BILL, from: BEN, to: BEN, cents: 500 });
    const m = paymentsFromEvents([ok, bad, ev('member_joined', ANA, {})]);
    expect([...m.entries()]).toEqual([[PAY, { from: BEN, to: ANA, cents: 500 }]]);
  });
});
