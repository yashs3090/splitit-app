import { type FakeSupabase } from '@/test-utils/fakes';
import { AIRBNB_ID, ANA, BEN, BRUNCH_ID, CY, DEE, DINNER_ID, DINNER_ROWS, MEMBERS, NAMES, W1, W3 } from '@/test-utils/groupFixtures';

import { BUSY_COPY, BUSY_SQLSTATES } from './bills';
import { groupBalances } from './groupBalance';
import type { ExpensePayload } from './groupExpense';
import {
  addExpense,
  assignItem,
  attachBillToGroup,
  balanceInputOf,
  createGroup,
  createIntentId,
  deleteExpense,
  deleteGroup,
  detachBillFromGroup,
  editExpense,
  fetchBillGroup,
  fetchGroupEvents,
  fetchGroupSnapshot,
  fetchNotPart,
  GROUP_ERROR_COPY,
  GROUP_EVENTS_LIMIT,
  GROUP_NAME_MAX,
  GROUP_REQUEST_TIMEOUT_MS,
  groupNameProblem,
  joinGroup,
  leaveGroup,
  listMyGroups,
  newClientId,
  recordPayment,
  renameGroup,
  rotateGroupCode,
  setGroupHidden,
  setNotPart,
  undoPayment,
  type GroupError,
} from './groups';
import { supabase as realSupabase } from './supabase';

jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const GROUP = '9a000000-0000-4000-8000-000000000001';
const OTHER_GROUP = '9a000000-0000-4000-8000-000000000002';
const BILL = 'b1000000-0000-4000-8000-000000000001';
const ROW = DINNER_ROWS.nachos;
const EXPENSE = 'e1000000-0000-4000-8000-000000000001';
const PAYMENT = 'f1000000-0000-4000-8000-000000000001';
const PAYMENT2 = 'f1000000-0000-4000-8000-000000000002';
const CLIENT_ID = 'c1000000-0000-4000-8000-000000000001';
const CODE = '0123456789abcdef0123';
const TS = '2026-11-26T10:00:00.000Z';
const SERVER_TEXT = 'duplicate key value violates unique constraint "secret_internal_name" for ada@example.com';
/** A valid money_fingerprint (contract F): 32 lowercase hex. */
const FP = '0123456789abcdef0123456789abcdef';
const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  supabase.rpc.mockClear();
  supabase.from.mockClear();
  supabase.__queries.length = 0;
  supabase.__setRpc(() => ({ data: null, error: null }));
});

function lastRpc(): [string, Record<string, unknown> | undefined] | undefined {
  return supabase.rpc.mock.calls.at(-1) as [string, Record<string, unknown> | undefined] | undefined;
}

// ---------------------------------------------------------------------------
// A raw group_snapshot (C-G11 as amended by A1.7), built from the worked example W1.
// ---------------------------------------------------------------------------

// Test-only: plain JSON the tests corrupt in place, one field at a time. Typing every nested shape
// would only restate the parser; `any` keeps each mutation a one-liner.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function rawSnapshot(payments = W1.input.payments): Json {
  return {
    group: { id: GROUP, name: 'Tahoe trip', join_code: CODE, created_by: ANA, created_at: TS },
    me: { hidden: false, not_part_bill_ids: [] },
    members: MEMBERS.map((id) => ({
      user_id: id,
      display_name: NAMES[id],
      venmo_username: id === BEN ? null : `${NAMES[id]?.toLowerCase()}-venmo`,
      joined_at: TS,
    })),
    bills: W1.input.bills.map((b) => ({
      id: b.id,
      host_id: b.payerId,
      payer_id: b.payerId,
      total_cents: b.totalCents,
      extras_split: b.split.extrasMode,
      created_at: TS,
      rows: b.split.items.map((item) => {
        const claims: Record<string, number> = {};
        for (const c of b.split.claims) if (c.itemId === item.id) claims[c.userId] = c.parts;
        return {
          id: item.id,
          total_cents: item.totalCents,
          kind: item.kind ?? 'item',
          name: Object.keys(claims).length === 0 ? 'Water' : null,
          claims,
        };
      }),
      participant_ids: [...b.split.participantIds],
    })),
    expenses: W1.input.expenses.map((e) => ({
      id: e.id,
      title: e.id === AIRBNB_ID ? 'Airbnb' : 'Rental car',
      payer_id: e.payerId,
      amount_cents: e.amountCents,
      split_method: e.id === AIRBNB_ID ? 'equal' : 'exact',
      created_by: e.payerId,
      created_at: TS,
      edited_at: null,
      version: 1,
      shares: e.shares.map((s) => ({ user_id: s.userId, cents: s.cents })),
    })),
    payments: payments.map((p, i) => ({
      id: `f1000000-0000-4000-8000-00000000000${i + 1}`,
      from_user: p.from,
      to_user: p.to,
      cents: p.cents,
      method: 'cash',
      source: 'manual',
      recorded_by: p.from,
      bill_id: null,
      created_at: TS,
    })),
    not_received: [],
    money_fingerprint: FP,
  };
}

function serveSnapshot(data: Json) {
  supabase.__setRpc((fn) => (fn === 'group_snapshot' ? { data, error: null } : { data: null, error: null }));
}

describe('fetchGroupSnapshot', () => {
  it('calls group_snapshot once with the group id and parses the W1 snapshot', async () => {
    serveSnapshot(rawSnapshot());
    const res = await fetchGroupSnapshot(GROUP);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(lastRpc()).toEqual(['group_snapshot', { p_group_id: GROUP }]);
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    const s = res.snapshot;
    expect(s.group).toEqual({ id: GROUP, name: 'Tahoe trip', joinCode: CODE, createdBy: ANA, createdAt: TS });
    expect(s.me).toEqual({ hidden: false, notPartBillIds: [] });
    expect(s.members.map((m) => m.userId)).toEqual([...MEMBERS]);
    expect(s.members[1]).toEqual({ userId: BEN, displayName: 'Ben', venmoUsername: null, joinedAt: TS });
    expect(s.bills).toHaveLength(2);
    expect(s.bills[0]?.rows.find((r) => r.id === ROW)).toEqual({
      id: ROW,
      totalCents: 1000,
      kind: 'item',
      name: null,
      claims: { [ANA]: 1, [BEN]: 1, [CY]: 1 },
    });
    expect(s.expenses.map((e) => e.splitMethod)).toEqual(['equal', 'exact']);
    expect(s.payments).toEqual([]);
    expect(s.notReceived).toEqual([]);
    expect(s.moneyFingerprint).toBe(FP);
  });

  // Delete group criterion 35: the key is required, exactly 32 lowercase hex characters.
  it.each<[string, unknown]>([
    ['missing', undefined],
    ['null', null],
    ['uppercase', FP.toUpperCase()],
    ['31 characters', FP.slice(1)],
    ['33 characters', `${FP}0`],
    ['a non-hex character', `${FP.slice(1)}g`],
    ['a number', 1234],
    ['with surrounding space', ` ${FP}`],
  ])('money_fingerprint %s → network', async (_label, value) => {
    const raw = rawSnapshot();
    if (value === undefined) delete raw.money_fingerprint;
    else raw.money_fingerprint = value;
    serveSnapshot(raw);
    await expect(fetchGroupSnapshot(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('parses not_received (GR-M6) into notReceived, in the order received', async () => {
    const raw = rawSnapshot();
    raw.not_received = [validNotReceived(), { ...validNotReceived(), id: PAYMENT2, from: BEN, to: ANA, cents: 13002, method: 'cash' }];
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.notReceived).toEqual([
      { id: PAYMENT, from: CY, to: DEE, cents: 17497, method: 'venmo', undoneAt: TS },
      { id: PAYMENT2, from: BEN, to: ANA, cents: 13002, method: 'cash', undoneAt: TS },
    ]);
  });

  // Criterion 12 (C4): the caller's own opt-outs, as bill ids from this snapshot.
  it('parses me.not_part_bill_ids into me.notPartBillIds, in the order received', async () => {
    const raw = rawSnapshot();
    raw.me.not_part_bill_ids = [DINNER_ID, BRUNCH_ID];
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.me).toEqual({ hidden: false, notPartBillIds: [DINNER_ID, BRUNCH_ID] });
  });

  it('an opt-out changes no balance (the same nets with and without it)', async () => {
    const raw = rawSnapshot();
    raw.me.not_part_bill_ids = [DINNER_ID];
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    const nets = groupBalances(balanceInputOf(res.snapshot)).members.map((m) => m.netCents);
    expect(nets).toEqual(MEMBERS.map((id) => W1.expected?.[id]?.net));
  });

  it('balanceInputOf the parsed W1 snapshot gives the W1 nets through groupBalances', async () => {
    serveSnapshot(rawSnapshot());
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    const nets = groupBalances(balanceInputOf(res.snapshot)).members.map((m) => m.netCents);
    expect(nets).toEqual(MEMBERS.map((id) => W1.expected?.[id]?.net));
  });

  it('carries live payments through to the balance input (W3)', async () => {
    serveSnapshot(rawSnapshot(W3.input.payments));
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.payments[0]).toMatchObject({ from: CY, to: DEE, cents: 10000, method: 'cash', source: 'manual', billId: null });
    const nets = groupBalances(balanceInputOf(res.snapshot)).members.map((m) => m.netCents);
    expect(nets).toEqual(MEMBERS.map((id) => W3.expected?.[id]?.net));
  });

  it('accepts an unclaimed row with its name, a claimable discount, an edited expense and a bill_mark payment', async () => {
    const raw = rawSnapshot(W3.input.payments);
    raw.bills[0].rows.push({ id: DINNER_ROWS.water, total_cents: 0, kind: 'item', name: 'Water', claims: {} });
    raw.bills[0].rows.push({ id: DINNER_ROWS.happyHour, total_cents: -500, kind: 'discount', name: 'Happy hour', claims: {} });
    raw.expenses[0].edited_at = TS;
    raw.expenses[0].version = 3;
    raw.payments[0].source = 'bill_mark';
    raw.payments[0].method = 'other'; // a pre-SV mark with no method (A2.1)
    raw.payments[0].bill_id = BILL;
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.bills[0]?.rows.at(-1)).toMatchObject({ kind: 'discount', name: 'Happy hour', claims: {} });
    expect(res.snapshot.expenses[0]).toMatchObject({ editedAt: TS, version: 3 });
    expect(res.snapshot.payments[0]).toMatchObject({ method: 'other', source: 'bill_mark', billId: BILL });
  });

  it('accepts a group whose creator deleted their account (created_by null, GR-T2-5)', async () => {
    const raw = rawSnapshot();
    raw.group.created_by = null;
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.group.createdBy).toBeNull();
  });

  it('accepts a $0 share in an equal expense (A3)', async () => {
    const raw = rawSnapshot();
    raw.expenses[0].amount_cents = 1;
    raw.expenses[0].shares = [
      { user_id: ANA, cents: 1 },
      { user_id: BEN, cents: 0 },
      { user_id: CY, cents: 0 },
    ];
    serveSnapshot(raw);
    expect((await fetchGroupSnapshot(GROUP)).ok).toBe(true);
  });

  // Criteria 48 and 105: every check fails closed with 'network' (never a partial balance).
  const corruptions: [string, (s: Json) => void][] = [
    // Missing keys
    ['a missing top-level key (payments)', (s) => delete s.payments],
    ['a missing me', (s) => delete s.me],
    ['a missing group.join_code', (s) => delete s.group.join_code],
    ['a missing member display_name', (s) => delete s.members[0].display_name],
    ['a missing bill participant_ids', (s) => delete s.bills[0].participant_ids],
    ['a missing row claims', (s) => delete s.bills[0].rows[0].claims],
    ['a missing expense version', (s) => delete s.expenses[0].version],
    ['a missing payment source', (s) => (s.payments = [{ ...validPayment() }]) && delete s.payments[0].source],
    ['a null snapshot', (s) => Object.keys(s).forEach((k) => delete s[k])],
    // Ids
    ['a non-uuid member id', (s) => (s.members[0].user_id = 'ana')],
    ['an uppercase uuid (member)', (s) => (s.members[0].user_id = ANA.toUpperCase())],
    // Row ids in the fixture are all digits, so use one with hex letters.
    ['an uppercase uuid (row)', (s) => (s.bills[0].rows[0].id = 'ABCDEF00-0000-4000-8000-000000000001')],
    ['an uppercase claim key', (s) => (s.bills[0].rows[0].claims = { [ANA.toUpperCase()]: 1 })],
    ['a group id other than the one asked for', (s) => (s.group.id = OTHER_GROUP)],
    ['a bad join code', (s) => (s.group.join_code = 'XYZ')],
    ['a non-uuid group creator', (s) => (s.group.created_by = 'ana')],
    ['a duplicate member', (s) => s.members.push({ ...s.members[0] })],
    ['no members', (s) => (s.members = [])],
    ['a duplicate bill id', (s) => s.bills.push(JSON.parse(JSON.stringify(s.bills[0])))],
    ['the same row id on two bills', (s) => (s.bills[1].rows[0].id = s.bills[0].rows[0].id)],
    ['a duplicate expense id', (s) => (s.expenses[1].id = s.expenses[0].id)],
    // Amounts
    ['a non-integer bill total', (s) => (s.bills[0].total_cents = 7733.5)],
    ['a negative bill total', (s) => (s.bills[0].total_cents = -1)],
    ['an unsafe bill total', (s) => (s.bills[0].total_cents = Number.MAX_SAFE_INTEGER + 2)],
    ['a string row total', (s) => (s.bills[0].rows[0].total_cents = '2000')],
    ['an item row below 0', (s) => (s.bills[0].rows[0].total_cents = -1)],
    ['a discount row of 0', (s) => Object.assign(s.bills[0].rows[0], { kind: 'discount', total_cents: 0 })],
    ['an unknown row kind', (s) => (s.bills[0].rows[0].kind = 'fee')],
    ['claim parts of 0', (s) => (s.bills[0].rows[0].claims[ANA] = 0)],
    ['claim parts of 21', (s) => (s.bills[0].rows[0].claims[ANA] = 21)],
    ['claim parts of 1.5', (s) => (s.bills[0].rows[0].claims[ANA] = 1.5)],
    ['an expense amount of 0', (s) => (s.expenses[0].amount_cents = 0)],
    ['an expense amount of 100,000,000', (s) => (s.expenses[0].amount_cents = 100_000_000)],
    ['a version of 0', (s) => (s.expenses[0].version = 0)],
    ['a payment of 0', (s) => (s.payments = [{ ...validPayment(), cents: 0 }])],
    ['a payment of 100,000,000', (s) => (s.payments = [{ ...validPayment(), cents: 100_000_000 }])],
    ['a payment of 1.5', (s) => (s.payments = [{ ...validPayment(), cents: 1.5 }])],
    // References and S6 checks
    ['a claim on a row by someone not on the bill', (s) => (s.bills[0].rows[0].claims = { [GROUP]: 1 })],
    ['participant_ids missing a member', (s) => (s.bills[0].participant_ids = [ANA, BEN, CY])],
    ['participant_ids with a non-member', (s) => s.bills[0].participant_ids.push(GROUP)],
    ['participant_ids with a repeat', (s) => s.bills[0].participant_ids.push(ANA)],
    ['a payer not in participant_ids', (s) => (s.bills[0].payer_id = GROUP)],
    ['a host who is not a member', (s) => (s.bills[0].host_id = GROUP)],
    ['an expense payer who is not a member', (s) => (s.expenses[0].payer_id = GROUP)],
    ['an expense creator who is not a member', (s) => (s.expenses[0].created_by = GROUP)],
    ['an expense share user who is not a member', (s) => (s.expenses[0].shares[0].user_id = GROUP)],
    ['an expense whose shares do not sum to its amount', (s) => (s.expenses[0].shares[0].cents += 1)],
    ['an expense share listed twice', (s) => (s.expenses[1].shares[1].user_id = s.expenses[1].shares[0].user_id)],
    ['an exact share of 0', (s) => Object.assign(s.expenses[1], { amount_cents: 21714 }) && (s.expenses[1].shares[3].cents = 0)],
    ['an expense with no shares', (s) => (s.expenses[0].shares = [])],
    ['a payment party who is not a member', (s) => (s.payments = [{ ...validPayment(), to_user: GROUP }])],
    ['a payment recorder who is not a member', (s) => (s.payments = [{ ...validPayment(), recorded_by: GROUP }])],
    ['a payment to yourself', (s) => (s.payments = [{ ...validPayment(), to_user: CY }])],
    ['an unknown payment source', (s) => (s.payments = [{ ...validPayment(), source: 'cash' }])],
    ["the pre-A2 source 'venmo'", (s) => (s.payments = [{ ...validPayment(), source: 'venmo' }])],
    ['a missing payment method', (s) => (s.payments = [{ ...validPayment(), method: undefined }])],
    ['an unknown payment method', (s) => (s.payments = [{ ...validPayment(), method: 'zelle' }])],
    ['venmo_link with method cash (A2.1 pairs)', (s) => (s.payments = [{ ...validPayment(), method: 'cash' }])],
    ['venmo_link with method other', (s) => (s.payments = [{ ...validPayment(), method: 'other' }])],
    ['a non-uuid payment bill_id', (s) => (s.payments = [{ ...validPayment(), bill_id: 'b1' }])],
    // not_received (GR-M6)
    ['a missing not_received', (s) => delete s.not_received],
    ['not_received not an array', (s) => (s.not_received = {})],
    ['a not_received row that is not an object', (s) => (s.not_received = [null])],
    ['a not_received non-uuid id', (s) => (s.not_received = [{ ...validNotReceived(), id: 'p1' }])],
    ['a not_received uppercase id', (s) => (s.not_received = [{ ...validNotReceived(), id: 'ABCDEF00-0000-4000-8000-000000000001' }])],
    ['a not_received repeated id', (s) => (s.not_received = [validNotReceived(), validNotReceived()])],
    ['a not_received sender who is not a member', (s) => (s.not_received = [{ ...validNotReceived(), from: GROUP }])],
    ['a not_received recipient who is not a member', (s) => (s.not_received = [{ ...validNotReceived(), to: GROUP }])],
    ['a not_received payment to yourself', (s) => (s.not_received = [{ ...validNotReceived(), to: CY }])],
    ['a not_received unknown method', (s) => (s.not_received = [{ ...validNotReceived(), method: 'zelle' }])],
    ['a not_received missing method', (s) => (s.not_received = [{ ...validNotReceived(), method: undefined }])],
    ['not_received cents of 0', (s) => (s.not_received = [{ ...validNotReceived(), cents: 0 }])],
    ['not_received cents of -5', (s) => (s.not_received = [{ ...validNotReceived(), cents: -5 }])],
    ['not_received cents of 1.5', (s) => (s.not_received = [{ ...validNotReceived(), cents: 1.5 }])],
    ['not_received cents of 100,000,000', (s) => (s.not_received = [{ ...validNotReceived(), cents: 100_000_000 }])],
    ['a not_received bad undone_at', (s) => (s.not_received = [{ ...validNotReceived(), undone_at: 'yesterday' }])],
    ['a not_received undone_at that is not ISO', (s) => (s.not_received = [{ ...validNotReceived(), undone_at: 'Nov 26 2026' }])],
    ['a not_received missing undone_at', (s) => (s.not_received = [{ ...validNotReceived(), undone_at: undefined }])],
    // Other fields
    ['a claimed row with a name (A1.7: null unless unclaimed)', (s) => (s.bills[0].rows[0].name = 'Burger')],
    ['an unclaimed row with no name', (s) => s.bills[0].rows.push({ id: DINNER_ROWS.water, total_cents: 0, kind: 'item', name: null, claims: {} })],
    ['an unknown extras_split', (s) => (s.bills[0].extras_split = 'shares')],
    ['an unknown split_method', (s) => (s.expenses[0].split_method = 'shares')],
    ['an empty expense title', (s) => (s.expenses[0].title = '')],
    ['a 101-code-point expense title', (s) => (s.expenses[0].title = '😀'.repeat(101))],
    ['an empty group name', (s) => (s.group.name = '')],
    ['a 61-code-point group name', (s) => (s.group.name = 'a'.repeat(61))],
    ['a non-boolean hidden', (s) => (s.me.hidden = 'false')],
    // me.not_part_bill_ids (C4, criterion 12). Bill ids in the fixture have hex letters (b1…, b2…).
    ['a missing me.not_part_bill_ids', (s) => delete s.me.not_part_bill_ids],
    ['a null me.not_part_bill_ids', (s) => (s.me.not_part_bill_ids = null)],
    ['me.not_part_bill_ids not an array', (s) => (s.me.not_part_bill_ids = { [DINNER_ID]: true })],
    ['me.not_part_bill_ids as a string', (s) => (s.me.not_part_bill_ids = DINNER_ID)],
    ['a not_part bill id not in bills', (s) => (s.me.not_part_bill_ids = ['b9000000-0000-4000-8000-000000000009'])],
    ['a not_part id that is a row id', (s) => (s.me.not_part_bill_ids = [DINNER_ROWS.nachos])],
    ['an uppercase not_part bill id', (s) => (s.me.not_part_bill_ids = [DINNER_ID.toUpperCase()])],
    ['a repeated not_part bill id', (s) => (s.me.not_part_bill_ids = [DINNER_ID, DINNER_ID])],
    ['a non-string not_part bill id', (s) => (s.me.not_part_bill_ids = [1])],
    ['a not_part bill id when there are no bills', (s) => (s.bills = []) && (s.me.not_part_bill_ids = [DINNER_ID])],
    ['a bad timestamp', (s) => (s.bills[0].created_at = 'yesterday')],
    ['a bad Venmo username', (s) => (s.members[0].venmo_username = 'a b')],
    ['rows not an array', (s) => (s.bills[0].rows = {})],
  ];

  // A not_received row as T6 sends it (GR-M6): from/to/undone_at, not the payment's own key names.
  function validNotReceived(): Json {
    return { id: PAYMENT, from: CY, to: DEE, cents: 17497, method: 'venmo', undone_at: TS };
  }

  function validPayment(): Json {
    return {
      id: PAYMENT,
      from_user: CY,
      to_user: DEE,
      cents: 100,
      method: 'venmo',
      source: 'venmo_link',
      recorded_by: CY,
      bill_id: null,
      created_at: TS,
    };
  }

  it('the control: validPayment alone parses', async () => {
    const raw = rawSnapshot();
    raw.payments = [validPayment()];
    serveSnapshot(raw);
    expect((await fetchGroupSnapshot(GROUP)).ok).toBe(true);
  });

  it.each([
    ['venmo', 'venmo_link'],
    ['venmo', 'manual'],
    ['cash', 'manual'],
    ['other', 'manual'],
    ['venmo', 'bill_mark'],
    ['cash', 'bill_mark'],
    ['other', 'bill_mark'],
  ])('parses a payment with method %s and source %s (A2.1 allowed pair)', async (method, source) => {
    const raw = rawSnapshot();
    raw.payments = [{ ...validPayment(), method, source }];
    serveSnapshot(raw);
    const res = await fetchGroupSnapshot(GROUP);
    if (!res.ok) throw new Error(res.error);
    expect(res.snapshot.payments[0]).toMatchObject({ method, source });
  });

  it.each(corruptions)('returns network for %s', async (_label, corrupt) => {
    const raw = rawSnapshot();
    corrupt(raw);
    serveSnapshot(raw);
    await expect(fetchGroupSnapshot(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it.each([null, [], 'snapshot', 42])('returns network for a %p response', async (data) => {
    serveSnapshot(data);
    await expect(fetchGroupSnapshot(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('42501 (not a member) is not_allowed; other errors and a throw are network; server text never leaks', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '42501', message: 'not_allowed' } }));
    await expect(fetchGroupSnapshot(GROUP)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    supabase.__setRpc(() => ({ data: null, error: { code: 'XX000', message: SERVER_TEXT } }));
    const res = await fetchGroupSnapshot(GROUP);
    expect(res).toEqual({ ok: false, error: 'network' });
    expect(JSON.stringify(res)).not.toContain('secret');
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    await expect(fetchGroupSnapshot(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('R2: a snapshot read that never answers is network after GROUP_REQUEST_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    try {
      supabase.__setRpc(() => new Promise<never>(() => {}));
      let settled: unknown = 'pending';
      void fetchGroupSnapshot(GROUP).then((r) => (settled = r));
      await jest.advanceTimersByTimeAsync(GROUP_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false, error: 'network' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('R2: GROUP_REQUEST_TIMEOUT_MS is 15 s (starting value)', () => expect(GROUP_REQUEST_TIMEOUT_MS).toBe(15_000));

  it('a non-uuid group id makes no call', async () => {
    await expect(fetchGroupSnapshot('g1')).resolves.toEqual({ ok: false, error: 'not_allowed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error mapping (criteria 47 and 106)
// ---------------------------------------------------------------------------

const EQUAL_PAYLOAD: ExpensePayload = {
  p_title: 'Airbnb',
  p_payer_id: ANA,
  p_amount_cents: 24000,
  p_method: 'equal',
  p_shares: { [ANA]: 1, [BEN]: 1, [CY]: 1, [DEE]: 1 },
};
const EXACT_PAYLOAD: ExpensePayload = {
  p_title: 'Rental car',
  p_payer_id: DEE,
  p_amount_cents: 30000,
  p_method: 'exact',
  p_shares: { [ANA]: 8572, [BEN]: 8571, [CY]: 8571, [DEE]: 4286 },
};

type Call = () => Promise<{ ok: boolean; error?: GroupError }>;
type Wrapper = { fn: string; call: Call; codes: [sqlstate: string, message: string, expected: GroupError][] };

const WRAPPERS: Wrapper[] = [
  {
    fn: 'create_group',
    call: () => createGroup('Tahoe trip', CLIENT_ID),
    codes: [
      ['22023', 'invalid_name', 'invalid_name'],
      ['22023', 'id_conflict', 'id_conflict'],
    ],
  },
  {
    fn: 'join_group',
    call: () => joinGroup(CODE),
    codes: [
      ['P0002', 'invalid_code', 'invalid_code'],
      ['22023', 'group_full', 'group_full'],
    ],
  },
  { fn: 'rename_group', call: () => renameGroup(GROUP, 'Tahoe'), codes: [['22023', 'invalid_name', 'invalid_name']] },
  { fn: 'rotate_group_code', call: () => rotateGroupCode(GROUP), codes: [] },
  { fn: 'set_group_hidden', call: () => setGroupHidden(GROUP, true), codes: [] },
  { fn: 'my_groups', call: () => listMyGroups(), codes: [] },
  {
    fn: 'add_expense',
    call: () => addExpense({ id: EXPENSE, groupId: GROUP, payload: EQUAL_PAYLOAD }),
    codes: [
      ['22023', 'invalid_expense', 'invalid_expense'],
      ['22023', 'invalid_shares', 'invalid_shares'],
      ['22023', 'not_member', 'not_member'],
      ['22023', 'id_conflict', 'id_conflict'],
    ],
  },
  {
    fn: 'edit_expense',
    call: () => editExpense({ id: EXPENSE, expectedVersion: 1, payload: EXACT_PAYLOAD }),
    codes: [
      ['22023', 'invalid_expense', 'invalid_expense'],
      ['22023', 'invalid_shares', 'invalid_shares'],
      ['22023', 'not_member', 'not_member'],
      ['22023', 'version_changed', 'version_changed'],
    ],
  },
  { fn: 'delete_expense', call: () => deleteExpense(EXPENSE, 1), codes: [['22023', 'version_changed', 'version_changed']] },
  {
    fn: 'record_payment',
    call: () => recordPayment({ id: PAYMENT, groupId: GROUP, from: CY, to: DEE, cents: 17497, method: 'venmo', source: 'venmo_link' }),
    codes: [
      ['22023', 'invalid_amount', 'invalid_amount'],
      ['22023', 'invalid_payment', 'invalid_payment'],
      ['22023', 'not_member', 'not_member'],
      ['22023', 'id_conflict', 'id_conflict'],
    ],
  },
  { fn: 'undo_payment', call: () => undoPayment(PAYMENT), codes: [] },
  {
    fn: 'attach_bill_to_group',
    call: () => attachBillToGroup(BILL, GROUP),
    codes: [
      ['22023', 'already_in_group', 'already_in_group'],
      ['22023', 'participants_not_members', 'participants_not_members'],
      ['22023', 'not_complete', 'not_complete'],
      ['22023', 'in_group', 'in_group'],
      ['22023', 'split_paying', 'split_paying'],
    ],
  },
  {
    fn: 'detach_bill_from_group',
    call: () => detachBillFromGroup(BILL),
    codes: [['22023', 'has_bill_payments', 'has_bill_payments']],
  },
  {
    fn: 'leave_group',
    call: () => leaveGroup(GROUP),
    codes: [
      ['22023', 'cannot_leave', 'cannot_leave'],
      ['23503', 'insert or update on table violates foreign key constraint', 'cannot_leave'],
    ],
  },
  {
    fn: 'assign_item',
    call: () => assignItem(ROW, { [BEN]: 1 }, {}),
    codes: [
      ['22023', 'invalid_parts', 'invalid_parts'],
      ['22023', 'claims_changed', 'claims_changed'],
      ['23503', 'insert or update on table "claims" violates foreign key constraint', 'claims_changed'],
    ],
  },
  { fn: 'group_snapshot', call: () => fetchGroupSnapshot(GROUP), codes: [] },
  {
    fn: 'delete_group',
    call: () => deleteGroup(GROUP, FP),
    codes: [
      ['22023', 'group_changed', 'group_changed'],
      ['22023', 'receipts_waiting', 'receipts_waiting'],
      // A2.12: the DB maps a 23503 in its deletes to group_changed; an unmapped one reads the same.
      ['23503', 'update or delete on table "group_members" violates foreign key constraint', 'group_changed'],
    ],
  },
  {
    fn: 'set_not_part',
    call: () => setNotPart(BILL, true),
    codes: [
      ['22023', 'has_claims', 'has_claims'],
      ['22023', 'not_in_group', 'not_in_group'],
    ],
  },
];

describe.each(WRAPPERS)('$fn error mapping', ({ fn, call, codes }) => {
  // Functions with no own refusals (codes = []) still get the 42501 / network / P0002 cases below.
  if (codes.length > 0) it.each(codes)('%s %s → %s', async (sqlstate, message, expected) => {
    supabase.__setRpc(() => ({ data: null, error: { code: sqlstate, message, details: SERVER_TEXT } }));
    const res = await call();
    expect(res).toEqual({ ok: false, error: expected });
    expect(lastRpc()?.[0]).toBe(fn);
  });

  it('42501 → not_allowed (signed out, not a member, anon)', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '42501', message: 'permission denied for function ' + fn } }));
    await expect(call()).resolves.toEqual({ ok: false, error: 'not_allowed' });
  });

  it.each([
    ['an unknown 22023 message', { code: '22023', message: SERVER_TEXT }],
    ['an unknown SQLSTATE', { code: '23505', message: SERVER_TEXT }],
    ['no SQLSTATE', { message: SERVER_TEXT }],
    // Another function's message is not this one's (only the listed messages count).
    ['a message another function raises', { code: '22023', message: fn === 'assign_item' ? 'version_changed' : 'claims_changed' }],
  ])('%s → network, and no server text in the result', async (_label, error) => {
    supabase.__setRpc(() => ({ data: null, error }));
    const res = await call();
    expect(res).toEqual({ ok: false, error: 'network' });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('a thrown call → network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    await expect(call()).resolves.toEqual({ ok: false, error: 'network' });
  });

  // Delete group A3.1: a lock clash reads as busy for every group function, before its own map.
  it.each(['40P01', '40001', '55P03'])('%s → busy, and no server text in the result', async (sqlstate) => {
    // The message is one this function maps, to show the code wins over the per-function map.
    const message = codes[0]?.[1] ?? 'not_allowed';
    supabase.__setRpc(() => ({ data: null, error: { code: sqlstate, message, details: SERVER_TEXT } }));
    const res = await call();
    expect(res).toEqual({ ok: false, error: 'busy' });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('A3.3: a thrown error object with code 40P01 → busy, never a throw', async () => {
    supabase.__setRpc(() => {
      throw Object.assign(new Error(SERVER_TEXT), { code: '40P01' });
    });
    await expect(call()).resolves.toEqual({ ok: false, error: 'busy' });
  });

  it('A3.3: a rejected rpc with a non-busy code → network', async () => {
    supabase.__setRpc(() => Promise.reject(Object.assign(new Error(SERVER_TEXT), { code: '23505' })));
    await expect(call()).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('P0002 is invalid_code only for join_group', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: 'P0002', message: 'invalid_code' } }));
    await expect(call()).resolves.toEqual({ ok: false, error: fn === 'join_group' ? 'invalid_code' : 'network' });
  });
  it('R2: an rpc that never answers is network after GROUP_REQUEST_TIMEOUT_MS, not before', async () => {
    jest.useFakeTimers();
    try {
      supabase.__setRpc(() => new Promise<never>(() => {}));
      let settled: unknown = 'pending';
      void call().then((r) => (settled = r));
      await jest.advanceTimersByTimeAsync(GROUP_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false, error: 'network' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('GROUP_ERROR_COPY', () => {
  it('has fixed copy for every error, including the A1 additions', () => {
    const all: GroupError[] = [
      'not_allowed',
      'invalid_code',
      'invalid_name',
      'invalid_expense',
      'invalid_shares',
      'not_member',
      'id_conflict',
      'version_changed',
      'cannot_leave',
      'already_in_group',
      'participants_not_members',
      'has_bill_payments',
      'in_group',
      'claims_changed',
      'invalid_parts',
      'invalid_amount',
      'invalid_payment',
      'not_complete',
      'group_full',
      'split_paying',
      'has_claims',
      'not_in_group',
      'group_changed',
      'receipts_waiting',
      'busy',
      'network',
    ];
    expect(Object.keys(GROUP_ERROR_COPY).sort()).toEqual([...all].sort());
    for (const e of all) expect(GROUP_ERROR_COPY[e].length).toBeGreaterThan(0);
  });

  it('uses the spec wording where the spec gives it', () => {
    expect(GROUP_ERROR_COPY.cannot_leave).toBe(
      "You can't leave this group because you're part of its costs. You can hide it instead.",
    );
    expect(GROUP_ERROR_COPY.version_changed).toBe('Someone just changed this expense. Check it and try again.');
    expect(GROUP_ERROR_COPY.claims_changed).toBe('Someone changed this item. Check and try again.');
    expect(GROUP_ERROR_COPY.not_complete).toBe('Finish claiming before moving it into the group.');
    expect(GROUP_ERROR_COPY.in_group).toBe("This bill is in a group. Ask for the group's link.");
    expect(GROUP_ERROR_COPY.split_paying).toBe('This bill has more than one payer. Groups need one payer per bill.');
    // Delete group C11, C12 (C6, C2a) and A3.2 (the same copy as bills, imported).
    expect(GROUP_ERROR_COPY.group_changed).toBe('Something in this group just changed. Check it and try again.');
    expect(GROUP_ERROR_COPY.receipts_waiting).toBe('Every receipt has to be fully claimed before you can delete this group.');
    expect(GROUP_ERROR_COPY.busy).toBe("That didn't go through. Please try again.");
    expect(GROUP_ERROR_COPY.busy).toBe(BUSY_COPY);
  });

  it('A2.9: there is no group_deleted error (a deleted group reads as not_allowed)', () => {
    expect(Object.keys(GROUP_ERROR_COPY)).not.toContain('group_deleted');
  });

  it('A3.1: the busy codes are the ones lib/bills.ts defines', () => {
    expect([...BUSY_SQLSTATES].sort()).toEqual(['40001', '40P01', '55P03']);
  });
});

// ---------------------------------------------------------------------------
// Groups core (T2)
// ---------------------------------------------------------------------------

describe('group names (C-G8, trimmed like normalizeTitle)', () => {
  it.each([
    ['', 'empty'],
    [' \t\n', 'empty'],
    ['a'.repeat(GROUP_NAME_MAX + 1), 'too_long'],
    ['😀'.repeat(61), 'too_long'],
  ])('%p → %s', (name, problem) => {
    expect(groupNameProblem(name)).toBe(problem);
  });

  it.each(['a', 'a'.repeat(60), '😀'.repeat(60), `  ${'a'.repeat(60)}\t`, 'Tahoe '])('%p is valid', (name) => {
    expect(groupNameProblem(name)).toBeNull();
  });

  it('GROUP_NAME_MAX is 60', () => expect(GROUP_NAME_MAX).toBe(60));
});

describe('createGroup', () => {
  it('sends the client id and the trimmed name; returns the id the DB confirms', async () => {
    supabase.__setRpc(() => ({ data: CLIENT_ID, error: null }));
    await expect(createGroup('  Tahoe trip\t', CLIENT_ID)).resolves.toEqual({ ok: true, groupId: CLIENT_ID });
    expect(lastRpc()).toEqual(['create_group', { p_id: CLIENT_ID, p_name: 'Tahoe trip' }]);
  });

  it('a different returned id is network', async () => {
    supabase.__setRpc(() => ({ data: GROUP, error: null }));
    await expect(createGroup('Tahoe trip', CLIENT_ID)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it.each(['', '   ', 'a'.repeat(61)])('refuses the name %p locally (invalid_name, no call)', async (name) => {
    await expect(createGroup(name, CLIENT_ID)).resolves.toEqual({ ok: false, error: 'invalid_name' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a malformed client id makes no call', async () => {
    await expect(createGroup('Tahoe trip', 'not-a-uuid')).resolves.toEqual({ ok: false, error: 'network' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('createIntentId: a retry reuses its client id (A1.6)', () => {
  it('reuses the id for the same intent, makes a new one when the intent changes or after done()', async () => {
    let n = 0;
    const ids = ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003'];
    const intent = createIntentId(() => ids[n++] ?? 'unexpected');

    // First tap: the response is lost (network). Second tap with the same name: same id.
    supabase.__setRpc(() => ({ data: null, error: { message: 'Failed to fetch' } }));
    await createGroup('Tahoe trip', intent.idFor('Tahoe trip'));
    supabase.__setRpc((_fn, args) => ({ data: args?.p_id, error: null }));
    const second = await createGroup('Tahoe trip', intent.idFor('Tahoe trip'));
    expect(second).toEqual({ ok: true, groupId: ids[0] });
    const sent = supabase.rpc.mock.calls.map((c) => (c[1] as { p_id: string }).p_id);
    expect(sent).toEqual([ids[0], ids[0]]);

    // A changed intent (another name) gets a new id; done() after success starts afresh too.
    expect(intent.idFor('Tahoe 2')).toBe(ids[1]);
    intent.done();
    expect(intent.idFor('Tahoe 2')).toBe(ids[2]);
  });
});

describe('newClientId', () => {
  it('returns distinct lowercase v4 uuids', () => {
    const a = newClientId();
    const b = newClientId();
    expect(a).toMatch(UUID_LOWER);
    expect(b).toMatch(UUID_LOWER);
    expect(a).not.toBe(b);
  });

  function withCrypto(value: unknown, run: () => void) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
    try {
      run();
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
      else delete (globalThis as { crypto?: unknown }).crypto;
    }
  }

  it('uses crypto.randomUUID when present, lowercased (criterion 127)', () => {
    const randomUUID = jest.fn(() => 'ABCDEF01-2345-4678-89AB-CDEF01234567');
    withCrypto({ randomUUID, getRandomValues: jest.fn() }, () => {
      expect(newClientId()).toBe('abcdef01-2345-4678-89ab-cdef01234567');
      expect(randomUUID).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back to Math.random when there is no crypto at all', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      withCrypto(undefined, () => {
        expect(newClientId()).toBe('00000000-0000-4000-8000-000000000000');
        expect(newClientId()).toMatch(UUID_LOWER);
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to getRandomValues when randomUUID is missing', () => {
    const original = globalThis.crypto;
    const getRandomValues = jest.fn(<T extends ArrayBufferView | null>(arr: T): T => {
      if (arr instanceof Uint8Array) arr.fill(0xff);
      return arr;
    });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
    try {
      expect(newClientId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
      expect(getRandomValues).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
  });
});

describe('joinGroup', () => {
  it('normalizes the code and returns the group id', async () => {
    supabase.__setRpc(() => ({ data: GROUP, error: null }));
    await expect(joinGroup(` ${CODE.toUpperCase()} `)).resolves.toEqual({ ok: true, groupId: GROUP });
    expect(lastRpc()).toEqual(['join_group', { p_code: CODE }]);
  });

  it.each(['', 'abcdefghij12', `g-${CODE}`, '0123456789/bcdef0123'])('a malformed code %p is invalid_code with no call', async (code) => {
    await expect(joinGroup(code)).resolves.toEqual({ ok: false, error: 'invalid_code' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a non-uuid response is network', async () => {
    supabase.__setRpc(() => ({ data: 'g1', error: null }));
    await expect(joinGroup(CODE)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('renameGroup, rotateGroupCode, setGroupHidden', () => {
  it('renameGroup sends the trimmed name', async () => {
    await expect(renameGroup(GROUP, ' Tahoe ')).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['rename_group', { p_group_id: GROUP, p_name: 'Tahoe' }]);
  });

  it('renameGroup refuses a bad name locally', async () => {
    await expect(renameGroup(GROUP, '')).resolves.toEqual({ ok: false, error: 'invalid_name' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('rotateGroupCode returns the new code and refuses a malformed one', async () => {
    supabase.__setRpc(() => ({ data: CODE, error: null }));
    await expect(rotateGroupCode(GROUP)).resolves.toEqual({ ok: true, joinCode: CODE });
    expect(lastRpc()).toEqual(['rotate_group_code', { p_group_id: GROUP }]);
    supabase.__setRpc(() => ({ data: 'ABC', error: null }));
    await expect(rotateGroupCode(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it.each([true, false])('setGroupHidden(%p)', async (hidden) => {
    await expect(setGroupHidden(GROUP, hidden)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['set_group_hidden', { p_group_id: GROUP, p_hidden: hidden }]);
  });

  it.each([
    ['renameGroup', () => renameGroup('g1', 'Tahoe')],
    ['rotateGroupCode', () => rotateGroupCode('g1')],
    ['setGroupHidden', () => setGroupHidden('g1', true)],
    ['leaveGroup', () => leaveGroup('g1')],
    ['undoPayment', () => undoPayment('p1')],
    ['deleteExpense', () => deleteExpense('e1', 1)],
    ['detachBillFromGroup', () => detachBillFromGroup('b1')],
    ['attachBillToGroup', () => attachBillToGroup(BILL, 'g1')],
    ['fetchBillGroup', () => fetchBillGroup('b1')],
    ['fetchGroupEvents', () => fetchGroupEvents('g1')],
    ['setNotPart', () => setNotPart('b1', true)],
    ['setNotPart (uppercase)', () => setNotPart(BILL.toUpperCase(), false)],
    ['fetchNotPart', () => fetchNotPart('b1')],
  ])('%s with a non-uuid id → not_allowed, no request', async (_label, call) => {
    await expect(call()).resolves.toEqual({ ok: false, error: 'not_allowed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe('listMyGroups', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: 'Tahoe trip',
    member_count: 4,
    joined_at: TS,
    hidden: false,
    ...over,
  });

  it('parses my_groups() rows in the order received', async () => {
    supabase.__setRpc(() => ({ data: [row(GROUP), row(OTHER_GROUP, { hidden: true, member_count: 1 })], error: null }));
    await expect(listMyGroups()).resolves.toEqual({
      ok: true,
      groups: [
        { id: GROUP, name: 'Tahoe trip', memberCount: 4, joinedAt: TS, hidden: false },
        { id: OTHER_GROUP, name: 'Tahoe trip', memberCount: 1, joinedAt: TS, hidden: true },
      ],
    });
    expect(lastRpc()).toEqual(['my_groups', {}]);
  });

  it.each([
    ['a repeated id', [row(GROUP), row(GROUP)]],
    ['a member count of 0', [row(GROUP, { member_count: 0 })]],
    ['a string member count', [row(GROUP, { member_count: '4' })]],
    ['a non-boolean hidden', [row(GROUP, { hidden: null })]],
    ['an empty name', [row(GROUP, { name: '' })]],
    ['an uppercase id', [row(GROUP.toUpperCase())]],
    ['not an array', { groups: [] }],
  ])('returns network for %s', async (_label, data) => {
    supabase.__setRpc(() => ({ data, error: null }));
    await expect(listMyGroups()).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('a list of 1,000 rows or more could be cut off by max_rows: network', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => row(`9a000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    supabase.__setRpc(() => ({ data: many, error: null }));
    await expect(listMyGroups()).resolves.toEqual({ ok: false, error: 'network' });
  });
});

// ---------------------------------------------------------------------------
// Expenses (T3) and payments (T4)
// ---------------------------------------------------------------------------

describe('addExpense / editExpense / deleteExpense', () => {
  it('addExpense spreads the T8 payload with p_id and p_group_id', async () => {
    await expect(addExpense({ id: EXPENSE, groupId: GROUP, payload: EQUAL_PAYLOAD })).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['add_expense', { p_id: EXPENSE, p_group_id: GROUP, ...EQUAL_PAYLOAD }]);
  });

  it('editExpense sends p_id, p_expected_version and the payload (no group id)', async () => {
    await expect(editExpense({ id: EXPENSE, expectedVersion: 2, payload: EXACT_PAYLOAD })).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['edit_expense', { p_id: EXPENSE, p_expected_version: 2, ...EXACT_PAYLOAD }]);
  });

  it('deleteExpense sends the id and the loaded version', async () => {
    await expect(deleteExpense(EXPENSE, 3)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['delete_expense', { p_id: EXPENSE, p_expected_version: 3 }]);
  });

  it('an extra property on the payload never reaches the database', async () => {
    const payload = { ...EQUAL_PAYLOAD, p_deleted_at: TS } as ExpensePayload;
    await addExpense({ id: EXPENSE, groupId: GROUP, payload });
    expect(lastRpc()?.[1]).not.toHaveProperty('p_deleted_at');
  });

  it.each<[string, Partial<ExpensePayload>, GroupError]>([
    ['amount 0', { p_amount_cents: 0 }, 'invalid_expense'],
    ['amount 100,000,000', { p_amount_cents: 100_000_000 }, 'invalid_expense'],
    ['amount 1.5', { p_amount_cents: 1.5 }, 'invalid_expense'],
    ['an empty title', { p_title: '' }, 'invalid_expense'],
    ['a 101-code-point title', { p_title: '😀'.repeat(101) }, 'invalid_expense'],
    ['an unknown method', { p_method: 'shares' as ExpensePayload['p_method'] }, 'invalid_expense'],
    ['a non-uuid payer', { p_payer_id: 'ana' }, 'invalid_expense'],
    ['no shares', { p_shares: {} }, 'invalid_shares'],
    ['an equal share other than 1', { p_shares: { [ANA]: 2 } }, 'invalid_shares'],
    ['a non-uuid share key', { p_shares: { ana: 1 } }, 'invalid_shares'],
  ])('addExpense refuses %s locally with no call', async (_label, over, error) => {
    await expect(addExpense({ id: EXPENSE, groupId: GROUP, payload: { ...EQUAL_PAYLOAD, ...over } })).resolves.toEqual({
      ok: false,
      error,
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, number>]>([
    ['a 0', { [ANA]: 30000, [BEN]: 0 }],
    ['1.5', { [ANA]: 29998.5, [BEN]: 1.5 }],
    ['100,000,000', { [ANA]: 100_000_000 }],
  ])('editExpense refuses an exact share of %s locally', async (_label, shares) => {
    const payload = { ...EXACT_PAYLOAD, p_shares: shares };
    await expect(editExpense({ id: EXPENSE, expectedVersion: 1, payload })).resolves.toEqual({ ok: false, error: 'invalid_shares' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, -1])('editExpense / deleteExpense refuse an expected version of %p', async (v) => {
    await expect(editExpense({ id: EXPENSE, expectedVersion: v, payload: EXACT_PAYLOAD })).resolves.toEqual({
      ok: false,
      error: 'version_changed',
    });
    await expect(deleteExpense(EXPENSE, v)).resolves.toEqual({ ok: false, error: 'version_changed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('recordPayment / undoPayment', () => {
  it('sends every argument, method and source included (A2.1)', async () => {
    await expect(
      recordPayment({ id: PAYMENT, groupId: GROUP, from: CY, to: DEE, cents: 17497, method: 'venmo', source: 'venmo_link' }),
    ).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual([
      'record_payment',
      { p_id: PAYMENT, p_group_id: GROUP, p_from: CY, p_to: DEE, p_cents: 17497, p_method: 'venmo', p_source: 'venmo_link' },
    ]);
    await expect(undoPayment(PAYMENT)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['undo_payment', { p_id: PAYMENT }]);
  });

  it.each([1, 99_999_999])('accepts %p cents', async (cents) => {
    await expect(recordPayment({ id: PAYMENT, groupId: GROUP, from: CY, to: DEE, cents, method: 'cash', source: 'manual' })).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    ['venmo', 'venmo_link'],
    ['venmo', 'manual'],
    ['cash', 'manual'],
    ['other', 'manual'],
  ] as const)('sends the allowed pair method %s / source %s', async (method, source) => {
    await expect(recordPayment({ id: PAYMENT, groupId: GROUP, from: CY, to: DEE, cents: 100, method, source })).resolves.toEqual({ ok: true });
    expect(lastRpc()?.[1]).toMatchObject({ p_method: method, p_source: source });
  });

  it.each<[string, Partial<Parameters<typeof recordPayment>[0]>, GroupError]>([
    ['0 cents', { cents: 0 }, 'invalid_amount'],
    ['100,000,000 cents', { cents: 100_000_000 }, 'invalid_amount'],
    ['1.5 cents', { cents: 1.5 }, 'invalid_amount'],
    ['from = to', { to: CY }, 'invalid_payment'],
    ["source 'bill_mark' (DB-only)", { source: 'bill_mark' as 'manual' }, 'invalid_payment'],
    ["the pre-A2 source 'venmo'", { source: 'venmo' as 'manual' }, 'invalid_payment'],
    ["method 'zelle'", { method: 'zelle' as 'cash' }, 'invalid_payment'],
    ['venmo_link with method cash', { method: 'cash', source: 'venmo_link' }, 'invalid_payment'],
    ['venmo_link with method other', { method: 'other', source: 'venmo_link' }, 'invalid_payment'],
    ['a non-uuid party', { to: 'dee' }, 'invalid_payment'],
  ])('refuses %s locally with no call', async (_label, over, error) => {
    const args = { id: PAYMENT, groupId: GROUP, from: CY, to: DEE, cents: 100, method: 'cash' as const, source: 'manual' as const, ...over };
    await expect(recordPayment(args)).resolves.toEqual({ ok: false, error });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bills in groups (T5) and assigning items (T7)
// ---------------------------------------------------------------------------

describe('attach / detach / leave', () => {
  it('attachBillToGroup and detachBillFromGroup send their ids', async () => {
    await expect(attachBillToGroup(BILL, GROUP)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['attach_bill_to_group', { p_bill_id: BILL, p_group_id: GROUP }]);
    await expect(detachBillFromGroup(BILL)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['detach_bill_from_group', { p_bill_id: BILL }]);
  });

  it('leaveGroup sends the group id', async () => {
    await expect(leaveGroup(GROUP)).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['leave_group', { p_group_id: GROUP }]);
  });
});

describe('assignItem', () => {
  it('sends the whole claimer map and the map the screen showed', async () => {
    await expect(assignItem(ROW, { [ANA]: 1, [BEN]: 2 }, { [ANA]: 1 })).resolves.toEqual({ ok: true });
    expect(lastRpc()).toEqual(['assign_item', { p_line_item_id: ROW, p_parts: { [ANA]: 1, [BEN]: 2 }, p_expected: { [ANA]: 1 } }]);
  });

  it('{} means nobody (both maps)', async () => {
    await expect(assignItem(ROW, {}, {})).resolves.toEqual({ ok: true });
    expect(lastRpc()?.[1]).toEqual({ p_line_item_id: ROW, p_parts: {}, p_expected: {} });
  });

  it.each<[string, Record<string, unknown>]>([
    ['parts 0', { [BEN]: 0 }],
    ['parts 21', { [BEN]: 21 }],
    ['parts 1.5', { [BEN]: 1.5 }],
    ['parts "2"', { [BEN]: '2' }],
    ['a non-uuid key', { ben: 1 }],
    ['an uppercase key', { [BEN.toUpperCase()]: 1 }],
  ])('refuses %s in p_parts or p_expected locally (invalid_parts, no call)', async (_label, bad) => {
    const parts = bad as Record<string, number>;
    await expect(assignItem(ROW, parts, {})).resolves.toEqual({ ok: false, error: 'invalid_parts' });
    await expect(assignItem(ROW, {}, parts)).resolves.toEqual({ ok: false, error: 'invalid_parts' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a non-uuid row id → not_allowed, no call', async () => {
    await expect(assignItem('row', {}, {})).resolves.toEqual({ ok: false, error: 'not_allowed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reads: group Activity and a bill's group
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Delete group (docs/specs/2026-11-28-delete-group.md T4, A2)
// ---------------------------------------------------------------------------

describe('deleteGroup (criterion 31)', () => {
  it('calls delete_group with exactly p_group_id and p_fingerprint', async () => {
    supabase.__setRpc(() => ({ data: null, error: null }));
    await expect(deleteGroup(GROUP, FP)).resolves.toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(lastRpc()).toEqual(['delete_group', { p_group_id: GROUP, p_fingerprint: FP }]);
    expect(Object.keys(lastRpc()?.[1] ?? {}).sort()).toEqual(['p_fingerprint', 'p_group_id']);
  });

  it.each(['', 'not-a-uuid', GROUP.toUpperCase(), `${GROUP} `])('group id %p → not_allowed, with no request', async (id) => {
    await expect(deleteGroup(id, FP)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each(['', FP.toUpperCase(), FP.slice(1), `${FP}0`, `${FP.slice(1)}g`, ` ${FP.slice(1)}`])(
    'fingerprint %p → group_changed, with no request',
    async (fp) => {
      await expect(deleteGroup(GROUP, fp)).resolves.toEqual({ ok: false, error: 'group_changed' });
      expect(supabase.rpc).not.toHaveBeenCalled();
    },
  );

  it('A2.11: a retry after a delete that went through gets 42501 → not_allowed (the group is gone)', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '42501', message: 'not_allowed' } }));
    await expect(deleteGroup(GROUP, FP)).resolves.toEqual({ ok: false, error: 'not_allowed' });
  });

  it('A2.9: a group_deleted message (no longer raised) is network, not its own error', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '22023', message: 'group_deleted' } }));
    await expect(deleteGroup(GROUP, FP)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('table reads: busy (A3.1, reads included)', () => {
  const reads: [string, string, () => Promise<{ ok: boolean; error?: GroupError }>][] = [
    ['fetchGroupEvents', 'group_events', () => fetchGroupEvents(GROUP)],
    ['fetchBillGroup', 'bills', () => fetchBillGroup(BILL)],
    ['fetchNotPart', 'bill_not_part', () => fetchNotPart(BILL)],
  ];

  describe.each(reads)('%s', (_name, table, call) => {
    it.each(['40P01', '40001', '55P03'])('a returned %s → busy', async (code) => {
      supabase.__setTable(table, { data: null, error: { code, message: SERVER_TEXT } });
      const res = await call();
      expect(res).toEqual({ ok: false, error: 'busy' });
      expect(JSON.stringify(res)).not.toContain('secret');
    });

    it('a thrown error with code 40P01 → busy', async () => {
      supabase.__setTable(table, () => {
        throw Object.assign(new Error(SERVER_TEXT), { code: '40P01' });
      });
      await expect(call()).resolves.toEqual({ ok: false, error: 'busy' });
    });
  });
});

describe('fetchGroupEvents', () => {
  const event = (seq: number, over: Record<string, unknown> = {}) => ({
    id: `ee000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    actor_id: ANA,
    kind: 'member_joined',
    details: {},
    created_at: TS,
    ...over,
  });

  it('names its columns, filters by group, orders by seq desc only and limits to 100 (A1 N2)', async () => {
    supabase.__setTable('group_events', { data: [event(3), event(2, { actor_id: null, kind: 'renamed', details: { from: 'a', to: 'b' } })], error: null });
    const res = await fetchGroupEvents(GROUP);
    expect(res).toEqual({
      ok: true,
      events: [
        { id: event(3).id, seq: 3, actorId: ANA, kind: 'member_joined', details: {}, createdAt: TS },
        { id: event(2).id, seq: 2, actorId: null, kind: 'renamed', details: { from: 'a', to: 'b' }, createdAt: TS },
      ],
    });
    expect(supabase.__queries).toEqual([
      {
        table: 'group_events',
        calls: [
          { method: 'select', args: ['id, seq, actor_id, kind, details, created_at'] },
          { method: 'eq', args: ['group_id', GROUP] },
          { method: 'order', args: ['seq', { ascending: false }] },
          { method: 'limit', args: [GROUP_EVENTS_LIMIT] },
        ],
      },
    ]);
    expect(GROUP_EVENTS_LIMIT).toBe(100);
  });

  it.each([
    ['a non-integer seq', [event(1, { seq: 1.5 })]],
    ['a string seq', [event(1, { seq: '1' })]],
    ['seq out of order', [event(1), event(2)]],
    ['a repeated seq', [event(2), event(2, { id: event(9).id })]],
    ['an empty kind', [event(1, { kind: '' })]],
    ['a non-uuid actor', [event(1, { actor_id: 'ana' })]],
    ['a missing details', [event(1, { details: undefined })]],
    ['a bad timestamp', [event(1, { created_at: 'now' })]],
    ['more than the limit', Array.from({ length: 101 }, (_, i) => event(200 - i))],
  ])('returns network for %s', async (_label, data) => {
    supabase.__setTable('group_events', { data, error: null });
    await expect(fetchGroupEvents(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('maps a read error by SQLSTATE only', async () => {
    supabase.__setTable('group_events', { data: null, error: { code: '42501', message: SERVER_TEXT } });
    await expect(fetchGroupEvents(GROUP)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    supabase.__setTable('group_events', { data: null, error: { code: 'PGRST000', message: SERVER_TEXT } });
    await expect(fetchGroupEvents(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('fetchBillGroup', () => {
  it('reads bills.group_id, then the group id and name (named columns)', async () => {
    supabase.__setTable('bills', { data: { group_id: GROUP }, error: null });
    supabase.__setTable('groups', { data: { id: GROUP, name: 'Tahoe trip' }, error: null });
    await expect(fetchBillGroup(BILL)).resolves.toEqual({ ok: true, group: { groupId: GROUP, name: 'Tahoe trip' } });
    expect(supabase.__queries).toEqual([
      {
        table: 'bills',
        calls: [
          { method: 'select', args: ['group_id'] },
          { method: 'eq', args: ['id', BILL] },
          { method: 'maybeSingle', args: [] },
        ],
      },
      {
        table: 'groups',
        calls: [
          { method: 'select', args: ['id, name'] },
          { method: 'eq', args: ['id', GROUP] },
          { method: 'maybeSingle', args: [] },
        ],
      },
    ]);
  });

  it('a bill with no group is null, with one request', async () => {
    supabase.__setTable('bills', { data: { group_id: null }, error: null });
    await expect(fetchBillGroup(BILL)).resolves.toEqual({ ok: true, group: null });
    expect(supabase.__queries).toHaveLength(1);
  });

  it.each([
    ['a bill RLS hides', { data: null, error: null }, null, 'not_allowed'],
    ['a group RLS hides', { data: { group_id: GROUP }, error: null }, { data: null, error: null }, 'not_allowed'],
    ['a non-uuid group_id', { data: { group_id: 'g1' }, error: null }, null, 'network'],
    ['a missing group_id key', { data: {}, error: null }, null, 'network'],
    ['another group than the bill names', { data: { group_id: GROUP }, error: null }, { data: { id: OTHER_GROUP, name: 'x' }, error: null }, 'network'],
    ['an empty group name', { data: { group_id: GROUP }, error: null }, { data: { id: GROUP, name: '' }, error: null }, 'network'],
    ['a read error', { data: null, error: { code: '42501', message: SERVER_TEXT } }, null, 'not_allowed'],
  ] as const)('%s → %s', async (_label, bills, groups, error) => {
    supabase.__setTable('bills', bills);
    if (groups) supabase.__setTable('groups', groups);
    await expect(fetchBillGroup(BILL)).resolves.toEqual({ ok: false, error });
  });
});

// ---------------------------------------------------------------------------
// "I wasn't part of this" (docs/specs/2026-11-27-group-claim-status.md, T2, criteria 14–15)
// ---------------------------------------------------------------------------

describe('setNotPart', () => {
  it.each([true, false])('sends set_not_part { p_bill_id, p_not_part: %p } once and returns ok', async (notPart) => {
    await expect(setNotPart(BILL, notPart)).resolves.toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(lastRpc()).toEqual(['set_not_part', { p_bill_id: BILL, p_not_part: notPart }]);
  });

  it('a non-boolean flag sends nothing', async () => {
    // A caller's value isn't trusted at run time (the type says boolean).
    await expect(setNotPart(BILL, 'true' as unknown as boolean)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('has_claims and not_in_group have the C6 copy', () => {
    expect(GROUP_ERROR_COPY.has_claims).toBe("You've claimed something on this receipt, so you're part of it.");
    expect(GROUP_ERROR_COPY.not_in_group).toBe("This receipt isn't in a group anymore.");
  });

  it("another function's messages aren't set_not_part's", async () => {
    for (const message of ['not_complete', 'in_group', 'cannot_leave']) {
      supabase.__setRpc(() => ({ data: null, error: { code: '22023', message } }));
      await expect(setNotPart(BILL, true)).resolves.toEqual({ ok: false, error: 'network' });
    }
  });

  it('has_claims and not_in_group are only set_not_part\'s', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '22023', message: 'has_claims' } }));
    await expect(leaveGroup(GROUP)).resolves.toEqual({ ok: false, error: 'network' });
    supabase.__setRpc(() => ({ data: null, error: { code: '22023', message: 'not_in_group' } }));
    await expect(attachBillToGroup(BILL, GROUP)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('fetchNotPart', () => {
  it('reads bill_not_part with the exact select string and filter (named column, RLS: own rows)', async () => {
    supabase.__setTable('bill_not_part', { data: [], error: null });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: true, notPart: false });
    expect(supabase.from).toHaveBeenCalledWith('bill_not_part');
    expect(supabase.__queries).toEqual([
      {
        table: 'bill_not_part',
        calls: [
          { method: 'select', args: ['bill_id'] },
          { method: 'eq', args: ['bill_id', BILL] },
        ],
      },
    ]);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('0 rows → false, 1 matching row → true', async () => {
    supabase.__setTable('bill_not_part', { data: [], error: null });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: true, notPart: false });
    supabase.__setTable('bill_not_part', { data: [{ bill_id: BILL }], error: null });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: true, notPart: true });
  });

  it.each([
    ['2 rows', [{ bill_id: BILL }, { bill_id: BILL }]],
    ['a row for another bill', [{ bill_id: BRUNCH_ID }]],
    ['an uppercase bill id', [{ bill_id: BILL.toUpperCase() }]],
    ['a row with no bill_id', [{}]],
    ['a row that is not an object', [null]],
    ['data that is not an array', { bill_id: BILL }],
    ['null data with no error', null],
  ])('%s → network', async (_label, data) => {
    supabase.__setTable('bill_not_part', { data, error: null });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('maps a read error by SQLSTATE only, with no server text', async () => {
    supabase.__setTable('bill_not_part', { data: null, error: { code: '42501', message: SERVER_TEXT } });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    supabase.__setTable('bill_not_part', { data: null, error: { code: 'PGRST205', message: SERVER_TEXT } });
    const res = await fetchNotPart(BILL);
    expect(res).toEqual({ ok: false, error: 'network' });
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('a thrown read → network', async () => {
    supabase.__setTable('bill_not_part', () => {
      throw new Error(SERVER_TEXT);
    });
    await expect(fetchNotPart(BILL)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('a read that never answers is network after GROUP_REQUEST_TIMEOUT_MS, not before', async () => {
    jest.useFakeTimers();
    try {
      supabase.__setTable('bill_not_part', () => new Promise<never>(() => {}));
      let settled: unknown = 'pending';
      void fetchNotPart(BILL).then((r) => (settled = r));
      await jest.advanceTimersByTimeAsync(GROUP_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false, error: 'network' });
    } finally {
      jest.useRealTimers();
    }
  });
});
