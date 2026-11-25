import { type FakeDbError, type FakeSupabase, type RecordedQuery } from '@/test-utils/fakes';

import type { BillMoneyArgs, BillRowArg } from './billPayload';
import {
  addParticipant,
  BILL_ERROR_COPY,
  createBill,
  fetchBill,
  fetchSettleData,
  joinBill,
  leaveBill,
  listMyBills,
  markBillSeen,
  markPaid,
  removeParticipant,
  rotateJoinCode,
  setClaim,
  setExtrasSplit,
  setItemSplit,
  setPayer,
  settleDifference,
  unmarkPaid,
  updateBill,
  type BillError,
} from './bills';
import { SETTLE_MAX_CENTS, SETTLE_MIN_CENTS } from './paylinks';
import { supabase as realSupabase } from './supabase';

jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const supabase = realSupabase as unknown as FakeSupabase;

const BILL = '11111111-2222-4333-8444-555555555555';
const ROW_BURGER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ROW_FRIES = 'aaaaaaaa-0000-4000-8000-000000000002';
const ROW_BEER0 = 'aaaaaaaa-0000-4000-8000-000000000003';
const ROW_BEER1 = 'aaaaaaaa-0000-4000-8000-000000000004';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const PAT = 'bbbbbbbb-0000-4000-8000-00000000000b';
const DEE = 'bbbbbbbb-0000-4000-8000-00000000000d';
const CODE = '0123456789abcdef0123';
const SERVER_TEXT = 'duplicate key value violates unique constraint "secret_internal_name" for ada@example.com';

const ROWS: BillRowArg[] = [
  { name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500 },
  { name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600 },
  { name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 2, total_cents: 700 },
  { name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 2, total_cents: 700 },
];
const MONEY: BillMoneyArgs = {
  p_subtotal_cents: null,
  p_tax_cents: 280,
  p_fees_cents: 0,
  p_tip_cents: 700,
  p_subtotal_discount_cents: 0,
  p_total_discount_cents: 0,
  p_total_cents: 4480,
};

function pgError(code: string, message = SERVER_TEXT): FakeDbError {
  return { code, message, details: 'internal details', hint: 'internal hint' };
}

/** The network failure supabase-js reports when fetch itself fails (no SQLSTATE). */
const FETCH_FAILED: FakeDbError = { code: '', message: 'TypeError: Failed to fetch', details: '', hint: '' };

function rpcReturns(data: unknown, error: FakeDbError | null = null) {
  supabase.__setRpc(() => ({ data, error }));
}

/** Every copy string a screen could show for a BillError never contains server text. */
function expectNoServerText(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain('secret_internal_name');
  expect(text).not.toContain('@');
  expect(text).not.toContain('internal');
}

beforeEach(() => {
  supabase.rpc.mockClear();
  supabase.from.mockClear();
  supabase.__queries.length = 0;
  rpcReturns(null);
});

describe('createBill', () => {
  it('calls create_bill once with the rows and money args, and returns the id and code', async () => {
    rpcReturns([{ bill_id: BILL, join_code: CODE }]);
    const res = await createBill(ROWS, MONEY);
    expect(res).toEqual({ ok: true, billId: BILL, joinCode: CODE });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('create_bill', { p_rows: ROWS, ...MONEY });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['22023 invalid_bill', pgError('22023', 'invalid_bill'), 'invalid_bill'],
    ['42501 (signed out)', pgError('42501'), 'not_allowed'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE', pgError('XX000'), 'network'],
    ['a PostgREST code', pgError('PGRST202'), 'network'],
  ])('maps %s to a fixed code', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await createBill(ROWS, MONEY);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it.each([
    ['no rows', []],
    ['a non-uuid id', [{ bill_id: 'x', join_code: CODE }]],
    ['a malformed code', [{ bill_id: BILL, join_code: 'ABC' }]],
    ['a scalar', 'surprise'],
    ['null', null],
  ])('treats an unexpected response (%s) as network', async (_label, data) => {
    rpcReturns(data);
    expect(await createBill(ROWS, MONEY)).toEqual({ ok: false, error: 'network' });
  });

  it("maps anon's Postgres 42501 (permission denied for function) to not_allowed by SQLSTATE", async () => {
    rpcReturns(null, pgError('42501', 'permission denied for function create_bill'));
    expect(await createBill(ROWS, MONEY)).toEqual({ ok: false, error: 'not_allowed' });
  });

  it('rejects a row carrying an id without calling the database (create_bill would 22023)', async () => {
    const withId = ROWS.map((r, i) => (i === 0 ? { ...r, id: ROW_BURGER } : r));
    expect(await createBill(withId, MONEY)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('sends only the row keys create_bill accepts', async () => {
    rpcReturns([{ bill_id: BILL, join_code: CODE }]);
    const extra = ROWS.map((r) => ({ ...r, qty: 1, draftId: 'd1' }));
    await createBill(extra, MONEY);
    const args = supabase.rpc.mock.calls[0]?.[1] as { p_rows: Record<string, unknown>[] };
    for (const row of args.p_rows) {
      expect(Object.keys(row).sort()).toEqual(
        ['group_position', 'group_size', 'name', 'note', 'total_cents', 'unit_index'].sort(),
      );
    }
  });

  it('35: sends kind and applies_to only for discount rows', async () => {
    rpcReturns([{ bill_id: BILL, join_code: CODE }]);
    const comp: BillRowArg = { name: 'Police comp', note: null, group_position: 3, unit_index: 0, group_size: 1, total_cents: -1603, kind: 'discount', applies_to: 'subtotal' };
    // An item row that carries kind 'item' (or a stray applies_to) is still sent exactly as before.
    const item = { ...ROWS[0]!, kind: 'item', applies_to: 'total' } as BillRowArg;
    await createBill([item, ...ROWS.slice(1), comp], MONEY);
    const sent = (supabase.rpc.mock.calls[0]?.[1] as { p_rows: Record<string, unknown>[] }).p_rows;
    expect(sent.slice(0, 4)).toEqual(ROWS);
    for (const row of sent.slice(0, 4)) {
      expect('kind' in row).toBe(false);
      expect('applies_to' in row).toBe(false);
    }
    expect(sent[4]).toEqual(comp);
  });

  it('35: updateBill keeps a discount row id and sends its kind and applies_to', async () => {
    const comp: BillRowArg = { id: ROW_BURGER, name: 'Comp', note: null, group_position: 3, unit_index: 0, group_size: 1, total_cents: -500, kind: 'discount', applies_to: 'total' };
    await updateBill(BILL, [...ROWS, comp], MONEY);
    const sent = (supabase.rpc.mock.calls[0]?.[1] as { p_rows: Record<string, unknown>[] }).p_rows;
    expect(sent[4]).toEqual(comp);
    expect(Object.keys(sent[4]!)[0]).toBe('id');
  });

  it('treats a thrown error as network, without leaking its text', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    const res = await createBill(ROWS, MONEY);
    expect(res).toEqual({ ok: false, error: 'network' });
  });
});

describe('updateBill', () => {
  it('calls update_bill with the bill id, rows and money', async () => {
    const withIds = ROWS.map((r, i) => (i === 0 ? { ...r, id: ROW_BURGER } : r));
    expect(await updateBill(BILL, withIds, MONEY)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('update_bill', { p_bill_id: BILL, p_rows: withIds, ...MONEY });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 (not the host, or no such bill)', pgError('42501'), 'not_allowed'],
    ['22023', pgError('22023'), 'invalid_bill'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s', async (_label, error, expected) => {
    rpcReturns(null, error);
    expect(await updateBill(BILL, ROWS, MONEY)).toEqual({ ok: false, error: expected });
  });

  it('returns not_found for a non-UUID bill id without calling the database', async () => {
    expect(await updateBill('nope', ROWS, MONEY)).toEqual({ ok: false, error: 'not_found' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('joinBill', () => {
  it('calls join_bill with the code and returns the bill id', async () => {
    rpcReturns(BILL);
    expect(await joinBill(CODE)).toEqual({ ok: true, billId: BILL });
    expect(supabase.rpc).toHaveBeenCalledWith('join_bill', { p_code: CODE });
  });

  it('maps P0002 to invalid_code', async () => {
    rpcReturns(null, pgError('P0002', 'invalid_code'));
    expect(await joinBill(CODE)).toEqual({ ok: false, error: 'invalid_code' });
  });

  it.each([
    ['too short', 'abc'],
    ['uppercase hex', CODE.toUpperCase()],
    ['21 chars', `${CODE}a`],
    ['empty', ''],
    ['not a string', 42 as unknown as string],
  ])('returns invalid_code for a malformed code (%s) without calling the database', async (_l, code) => {
    expect(await joinBill(code)).toEqual({ ok: false, error: 'invalid_code' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('maps other errors to network, and a non-uuid response to network', async () => {
    rpcReturns(null, FETCH_FAILED);
    expect(await joinBill(CODE)).toEqual({ ok: false, error: 'network' });
    rpcReturns('not-a-uuid');
    expect(await joinBill(CODE)).toEqual({ ok: false, error: 'network' });
  });
});

describe('rotateJoinCode', () => {
  it('calls rotate_join_code and returns the new code', async () => {
    rpcReturns('fedcba9876543210fedc');
    expect(await rotateJoinCode(BILL)).toEqual({ ok: true, joinCode: 'fedcba9876543210fedc' });
    expect(supabase.rpc).toHaveBeenCalledWith('rotate_join_code', { p_bill_id: BILL });
  });

  it('maps 42501 to not_allowed and a malformed code to network', async () => {
    rpcReturns(null, pgError('42501'));
    expect(await rotateJoinCode(BILL)).toEqual({ ok: false, error: 'not_allowed' });
    rpcReturns('NOT-HEX');
    expect(await rotateJoinCode(BILL)).toEqual({ ok: false, error: 'network' });
  });
});

describe('setClaim', () => {
  it.each([true, false])('calls set_claim with p_claimed = %s', async (claimed) => {
    expect(await setClaim(ROW_FRIES, claimed)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('set_claim', { p_line_item_id: ROW_FRIES, p_claimed: claimed });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['P0002 (row not visible)', pgError('P0002', 'not_found'), 'not_found'],
    ['23503 (row deleted mid-claim)', pgError('23503'), 'not_found'],
    ['42501', pgError('42501'), 'not_allowed'],
    ['22023 invalid_claim (unreachable with a boolean)', pgError('22023', 'invalid_claim'), 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await setClaim(ROW_FRIES, true);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('returns not_found for a non-UUID row id without calling the database', async () => {
    expect(await setClaim('row-1', true)).toEqual({ ok: false, error: 'not_found' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('setItemSplit', () => {
  it('calls set_item_split with every claimer in p_parts', async () => {
    expect(await setItemSplit(ROW_FRIES, { [HOST]: 2, [PAT]: 1 })).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('set_item_split', {
      p_line_item_id: ROW_FRIES,
      p_parts: { [HOST]: 2, [PAT]: 1 },
    });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['22023 (claimers changed)', pgError('22023', 'claimers_changed'), 'claimers_changed'],
    // The two 22023s are told apart by their fixed message only.
    ['22023 (invalid parts)', pgError('22023', 'invalid_parts'), 'invalid_bill'],
    ['22023 with an unknown message', pgError('22023'), 'network'],
    ['22023 with no message', { code: '22023', message: '' }, 'network'],
    ['P0002', pgError('P0002'), 'not_found'],
    ['42501 (not a claimer)', pgError('42501'), 'not_allowed'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s', async (_label, error, expected) => {
    rpcReturns(null, error);
    expect(await setItemSplit(ROW_FRIES, { [HOST]: 2, [PAT]: 1 })).toEqual({ ok: false, error: expected });
  });

  it.each([
    ['no claimers', {}],
    ['parts 0', { [HOST]: 0 }],
    ['parts 21', { [HOST]: 21 }],
    ['parts 1.5', { [HOST]: 1.5 }],
    ['a string part', { [HOST]: '2' as unknown as number }],
    ['a non-uuid key', { someone: 1 }],
  ])('rejects %s locally as invalid_bill, without calling the database', async (_label, parts) => {
    expect(await setItemSplit(ROW_FRIES, parts)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const BILL_ROW = {
  id: BILL,
  host_id: HOST,
  subtotal_cents: null,
  tax_cents: 280,
  fees_cents: 0,
  tip_cents: 700,
  subtotal_discount_cents: 0,
  total_discount_cents: 0,
  total_cents: 4480,
  join_code: CODE,
  created_at: '2026-11-21T10:00:00+00:00',
  edited_at: null,
  extras_split: 'proportional',
  payer_id: HOST,
};

function unit(id: string, name: string, g: number, u: number, size: number, cents: number) {
  return {
    id,
    name,
    note: null,
    group_position: g,
    unit_index: u,
    group_size: size,
    total_cents: cents,
    split_set_by: null,
    split_set_at: null,
    kind: 'item',
    applies_to: null,
  };
}

const LINE_ITEMS = [
  unit(ROW_BURGER, 'Burger', 0, 0, 1, 1500),
  unit(ROW_FRIES, 'Fries', 1, 0, 1, 600),
  unit(ROW_BEER0, 'Beer', 2, 0, 2, 700),
  unit(ROW_BEER1, 'Beer', 2, 1, 2, 700),
];
const ROW_COMP = 'aaaaaaaa-0000-4000-8000-000000000005';
const COMP_ROW = { ...unit(ROW_COMP, 'Police comp', 3, 0, 1, -1603), kind: 'discount', applies_to: 'subtotal' };
const MARKED_AT = '2026-11-24T10:00:00.123456+00:00';
const PARTICIPANTS = [
  { user_id: HOST, settled_at: null, settled_cents: null, profile: { display_name: 'Hana', venmo_username: 'hana-1' } },
  { user_id: PAT, settled_at: MARKED_AT, settled_cents: 1510, profile: { display_name: null, venmo_username: null } },
];
const HOST_MEMBER = { userId: HOST, displayName: 'Hana', venmoUsername: 'hana-1', mark: null };
const PAT_MEMBER = { userId: PAT, displayName: null, venmoUsername: null, mark: { cents: 1510, at: MARKED_AT } };
const pat = (over: Record<string, unknown>, profile: Record<string, unknown> = {}) => ({
  ...PARTICIPANTS[1],
  ...over,
  profile: { ...PARTICIPANTS[1]!.profile, ...profile },
});
const CLAIMS = [
  { line_item_id: ROW_FRIES, user_id: HOST, parts: 2 },
  { line_item_id: ROW_FRIES, user_id: PAT, parts: 1 },
];

function seedBill(overrides: Partial<Record<'bills' | 'line_items' | 'bill_participants' | 'claims', unknown>> = {}) {
  supabase.__setTable('bills', { data: 'bills' in overrides ? overrides.bills : BILL_ROW, error: null });
  supabase.__setTable('line_items', { data: overrides.line_items ?? LINE_ITEMS, error: null });
  supabase.__setTable('bill_participants', { data: overrides.bill_participants ?? PARTICIPANTS, error: null });
  supabase.__setTable('claims', { data: overrides.claims ?? CLAIMS, error: null });
}

function queryFor(table: string): RecordedQuery {
  const q = supabase.__queries.find((x) => x.table === table);
  if (!q) throw new Error(`no query on ${table}`);
  return q;
}

describe('setExtrasSplit', () => {
  it.each(['proportional', 'equal'] as const)('calls set_extras_split with p_mode %s', async (mode) => {
    expect(await setExtrasSplit(BILL, mode)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('set_extras_split', { p_bill_id: BILL, p_mode: mode });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 (not the host, or no such bill)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ['22023 invalid_mode', pgError('22023', 'invalid_mode'), 'invalid_bill'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE', pgError('XX000'), 'network'],
  ])('maps %s to a fixed code', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await setExtrasSplit(BILL, 'equal');
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('rejects a non-UUID bill id or an unknown mode without calling the database', async () => {
    expect(await setExtrasSplit('nope', 'equal')).toEqual({ ok: false, error: 'not_found' });
    expect(await setExtrasSplit(BILL, 'even' as unknown as 'equal')).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await setExtrasSplit(BILL, 'equal')).toEqual({ ok: false, error: 'network' });
  });
});

describe('fetchBill', () => {
  it('reads the bill, its unit rows, participants and claims through RLS-protected selects', async () => {
    seedBill();
    const res = await fetchBill(BILL);
    expect(res).toEqual({
      ok: true,
      bill: BILL_ROW,
      rows: LINE_ITEMS,
      participants: [HOST_MEMBER, PAT_MEMBER],
      claims: CLAIMS,
    });
    expect(supabase.rpc).not.toHaveBeenCalled();

    expect(queryFor('bills').calls).toContainEqual({ method: 'eq', args: ['id', BILL] });
    expect(queryFor('line_items').calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['bill_id', BILL] },
        { method: 'order', args: ['group_position', { ascending: true }] },
        { method: 'order', args: ['unit_index', { ascending: true }] },
      ]),
    );
    expect(queryFor('bill_participants').calls).toContainEqual({ method: 'eq', args: ['bill_id', BILL] });
    expect(queryFor('claims').calls).toContainEqual({ method: 'eq', args: ['bill_id', BILL] });
  });

  it('selects extras_split and returns it (equal)', async () => {
    seedBill({ bills: { ...BILL_ROW, extras_split: 'equal' } });
    const res = await fetchBill(BILL);
    expect(res.ok && res.bill.extras_split).toBe('equal');
    const select = queryFor('bills').calls.find((c) => c.method === 'select')!.args[0] as string;
    expect(select).toContain('extras_split');
  });

  it('selects and returns payer_id, the marks and the Venmo handle (criterion 37)', async () => {
    seedBill({ bills: { ...BILL_ROW, payer_id: PAT } });
    const res = await fetchBill(BILL);
    expect(res.ok && res.bill.payer_id).toBe(PAT);
    expect(res.ok && res.participants).toEqual([HOST_MEMBER, PAT_MEMBER]);
    const billSelect = queryFor('bills').calls.find((c) => c.method === 'select')!.args[0] as string;
    expect(billSelect.split(', ')).toContain('payer_id');
    const partSelect = queryFor('bill_participants').calls.find((c) => c.method === 'select')!.args[0] as string;
    expect(partSelect).toMatch(/\bsettled_at\b/);
    expect(partSelect).toMatch(/\bsettled_cents\b/);
  });

  it.each([SETTLE_MIN_CENTS, SETTLE_MAX_CENTS])('reads a mark of %i cents exactly (C2 A2, A3)', async (cents) => {
    seedBill({ bill_participants: [pat({ settled_cents: cents })] });
    const res = await fetchBill(BILL);
    expect(res.ok && res.participants[0]?.mark).toEqual({ cents, at: MARKED_AT });
  });

  it('names every column it selects: no * and no bare select (column grants, lesson 2026-11-24)', async () => {
    seedBill();
    await fetchBill(BILL);
    for (const q of supabase.__queries) {
      const select = q.calls.find((c) => c.method === 'select');
      expect(select?.args[0]).toEqual(expect.any(String));
      expect((select?.args[0] as string).trim()).not.toBe('');
      expect(select?.args[0]).not.toMatch(/\*/);
    }
  });

  it('names the profiles relationship explicitly and never selects email', async () => {
    seedBill();
    await fetchBill(BILL);
    const selects = supabase.__queries.flatMap((q) => q.calls.filter((c) => c.method === 'select').map((c) => c.args[0]));
    expect(selects.join(' ')).not.toMatch(/email|\*/);
    const participantsSelect = queryFor('bill_participants').calls.find((c) => c.method === 'select')!.args[0];
    expect(participantsSelect).toContain('profiles!bill_participants_user_id_fkey(display_name, venmo_username)');
  });

  it('orders rows by group_position, unit_index even if the server returns them shuffled', async () => {
    seedBill({ line_items: [LINE_ITEMS[3], LINE_ITEMS[1], LINE_ITEMS[0], LINE_ITEMS[2]] });
    const res = await fetchBill(BILL);
    expect(res.ok && res.rows.map((r) => r.id)).toEqual([ROW_BURGER, ROW_FRIES, ROW_BEER0, ROW_BEER1]);
  });

  it('treats a missing profile (not visible) as a null display name', async () => {
    seedBill({ bill_participants: [{ user_id: HOST, settled_at: null, settled_cents: null, profile: null }] });
    const res = await fetchBill(BILL);
    expect(res.ok && res.participants).toEqual([{ userId: HOST, displayName: null, venmoUsername: null, mark: null }]);
  });

  it.each(['not-a-uuid', '', '../bills', `${BILL}x`])(
    'returns not_found for a non-UUID id (%p) without any query',
    async (id) => {
      expect(await fetchBill(id)).toEqual({ ok: false, error: 'not_found' });
      expect(supabase.from).not.toHaveBeenCalled();
      expect(supabase.rpc).not.toHaveBeenCalled();
    },
  );

  it('returns not_found when RLS returns no bill (unknown, or not a participant)', async () => {
    seedBill({ bills: null });
    expect(await fetchBill(BILL)).toEqual({ ok: false, error: 'not_found' });
  });

  it('maps a read error to a fixed code, never the server text', async () => {
    seedBill();
    supabase.__setTable('claims', { data: null, error: pgError('XX000') });
    const res = await fetchBill(BILL);
    expect(res).toEqual({ ok: false, error: 'network' });
    expectNoServerText(res);

    seedBill();
    supabase.__setTable('bills', { data: null, error: pgError('42501') });
    expect(await fetchBill(BILL)).toEqual({ ok: false, error: 'not_allowed' });
  });

  it.each<[string, Partial<Record<'bills' | 'line_items' | 'bill_participants' | 'claims', unknown>>]>([
    ['a float total', { bills: { ...BILL_ROW, total_cents: 44.8 } }],
    ['a string tax', { bills: { ...BILL_ROW, tax_cents: '280' } }],
    ['a missing subtotal discount', { bills: { ...BILL_ROW, subtotal_discount_cents: undefined } }],
    ['a float total discount', { bills: { ...BILL_ROW, total_discount_cents: 0.5 } }],
    ['a float subtotal', { bills: { ...BILL_ROW, subtotal_cents: 0.5 } }],
    ['a malformed join code', { bills: { ...BILL_ROW, join_code: 'nope' } }],
    ['an unknown extras_split', { bills: { ...BILL_ROW, extras_split: 'even' } }],
    ['a capitalised extras_split', { bills: { ...BILL_ROW, extras_split: 'Equal' } }],
    ['a missing extras_split', { bills: { ...BILL_ROW, extras_split: undefined } }],
    ['a float row price', { line_items: [{ ...LINE_ITEMS[0], total_cents: 15.5 }] }],
    ['a string unit_index', { line_items: [{ ...LINE_ITEMS[0], unit_index: '0' }] }],
    ['a non-string name', { line_items: [{ ...LINE_ITEMS[0], name: 7 }] }],
    ['a non-uuid row id', { line_items: [{ ...LINE_ITEMS[0], id: 'row' }] }],
    // Claimable discounts, criterion 34: kind, sign and applies_to must agree.
    ['an unknown kind', { line_items: [{ ...LINE_ITEMS[0], kind: 'coupon' }] }],
    ['a null kind', { line_items: [{ ...LINE_ITEMS[0], kind: null }] }],
    ['a discount with total_cents 100', { line_items: [{ ...COMP_ROW, total_cents: 100 }] }],
    ['a discount with total_cents 0', { line_items: [{ ...COMP_ROW, total_cents: 0 }] }],
    ['an item with total_cents -1', { line_items: [{ ...LINE_ITEMS[0], total_cents: -1 }] }],
    ['a discount with applies_to null', { line_items: [{ ...COMP_ROW, applies_to: null }] }],
    ['a discount with an unknown applies_to', { line_items: [{ ...COMP_ROW, applies_to: 'tip' }] }],
    ['an item with applies_to total', { line_items: [{ ...LINE_ITEMS[0], applies_to: 'total' }] }],
    ['float parts', { claims: [{ ...CLAIMS[0], parts: 1.5 }] }],
    ['string parts', { claims: [{ ...CLAIMS[0], parts: '2' }] }],
    ['a numeric display name', { bill_participants: [pat({}, { display_name: 5 })] }],
    // Criterion 37: payer and marks.
    ['a non-uuid payer', { bills: { ...BILL_ROW, payer_id: 'hana' } }],
    ['a null payer', { bills: { ...BILL_ROW, payer_id: null } }],
    ['a missing payer', { bills: { ...BILL_ROW, payer_id: undefined } }],
    ['settled_at without settled_cents', { bill_participants: [pat({ settled_cents: null })] }],
    ['settled_cents without settled_at', { bill_participants: [pat({ settled_at: null })] }],
    ['settled_cents 0 (C2 A1)', { bill_participants: [pat({ settled_cents: 0 })] }],
    ['settled_cents 100000000 (C2 A4)', { bill_participants: [pat({ settled_cents: SETTLE_MAX_CENTS + 1 })] }],
    ['negative settled_cents (C2 A5)', { bill_participants: [pat({ settled_cents: -5 })] }],
    ['float settled_cents (C2 A7)', { bill_participants: [pat({ settled_cents: 12.5 })] }],
    ['string settled_cents', { bill_participants: [pat({ settled_cents: '1510' })] }],
    ['a non-string settled_at', { bill_participants: [pat({ settled_at: 1700000000 })] }],
    ['an unparseable settled_at', { bill_participants: [pat({ settled_at: 'yesterday-ish' })] }],
    ['missing mark columns', { bill_participants: [{ user_id: PAT, profile: { display_name: null, venmo_username: null } }] }],
    ['a handle with @', { bill_participants: [pat({}, { venmo_username: '@hana-1' })] }],
    ['a handle too short', { bill_participants: [pat({}, { venmo_username: 'abcd' })] }],
    ['a handle with a space', { bill_participants: [pat({}, { venmo_username: 'abc de' })] }],
    ['a non-ASCII handle', { bill_participants: [pat({}, { venmo_username: 'josé1' })] }],
    ['an empty handle', { bill_participants: [pat({}, { venmo_username: '' })] }],
    ['a numeric handle', { bill_participants: [pat({}, { venmo_username: 12345 })] }],
    ['a missing handle column', { bill_participants: [pat({}, { venmo_username: undefined })] }],
    ['a non-array of claims', { claims: { nope: true } }],
  ])('rejects malformed data (%s) as network', async (_label, overrides) => {
    seedBill(overrides);
    expect(await fetchBill(BILL)).toEqual({ ok: false, error: 'network' });
  });

  it('34: selects exactly the named row columns, kind and applies_to included', async () => {
    seedBill();
    await fetchBill(BILL);
    const select = queryFor('line_items').calls.find((c) => c.method === 'select')!.args[0];
    expect(select).toBe('id, name, note, group_position, unit_index, group_size, total_cents, split_set_by, split_set_at, kind, applies_to');
  });

  it('34: returns kind and applies_to for item and discount rows', async () => {
    seedBill({ line_items: [...LINE_ITEMS, COMP_ROW, { ...COMP_ROW, id: ROW_BURGER.replace(/1$/, '6'), group_position: 4, total_cents: -9999999, applies_to: 'total' }] });
    const res = await fetchBill(BILL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.kind, r.applies_to, r.total_cents])).toEqual([
      ['item', null, 1500],
      ['item', null, 600],
      ['item', null, 700],
      ['item', null, 700],
      ['discount', 'subtotal', -1603],
      ['discount', 'total', -9999999],
    ]);
  });

  it('reads a row without kind or applies_to keys as an item (older fixtures)', async () => {
    const { kind: _k, applies_to: _a, ...bare } = LINE_ITEMS[0]!;
    seedBill({ line_items: [bare] });
    const res = await fetchBill(BILL);
    expect(res.ok && res.rows).toEqual([LINE_ITEMS[0]]);
  });

  it('treats a thrown query as network', async () => {
    seedBill();
    supabase.__setTable('line_items', () => {
      throw new Error(SERVER_TEXT);
    });
    expect(await fetchBill(BILL)).toEqual({ ok: false, error: 'network' });
  });
});

describe('listMyBills (docs/specs/2026-11-24-bill-markers-and-notices.md D2; criteria 21–22)', () => {
  /** One my_bills() row, as the function returns it. */
  function myBillsRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      bill_id: BILL,
      host_id: HOST,
      host_name: 'Hana',
      payer_id: HOST,
      total_cents: 4480,
      created_at: '2026-11-21T10:00:00+00:00',
      joined_at: '2026-11-21T10:05:00+00:00',
      added: true,
      seen: false,
      claimed_any: false,
      complete: false,
      ...over,
    };
  }
  const OTHER_BILL = '11111111-2222-4333-8444-666666666666';

  it('calls rpc my_bills once with no arguments, and reads no table (criterion 21)', async () => {
    rpcReturns([myBillsRow()]);
    await listMyBills();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('my_bills', {});
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.__queries).toEqual([]);
  });

  it('returns every D2 field, with the host name, in the order received (criterion 21)', async () => {
    rpcReturns([
      myBillsRow({ bill_id: OTHER_BILL, host_id: PAT, host_name: null, payer_id: DEE, total_cents: 0, added: false, seen: true, claimed_any: true, complete: true }),
      myBillsRow(),
    ]);
    expect(await listMyBills()).toEqual({
      ok: true,
      bills: [
        {
          id: OTHER_BILL,
          hostId: PAT,
          hostName: null,
          payerId: DEE,
          totalCents: 0,
          createdAt: '2026-11-21T10:00:00+00:00',
          joinedAt: '2026-11-21T10:05:00+00:00',
          added: false,
          seen: true,
          claimedAny: true,
          complete: true,
        },
        {
          id: BILL,
          hostId: HOST,
          hostName: 'Hana',
          payerId: HOST,
          totalCents: 4480,
          createdAt: '2026-11-21T10:00:00+00:00',
          joinedAt: '2026-11-21T10:05:00+00:00',
          added: true,
          seen: false,
          claimedAny: false,
          complete: false,
        },
      ],
    });
  });

  it('returns an empty list, and accepts exactly 20 rows (the database limit)', async () => {
    rpcReturns([]);
    expect(await listMyBills()).toEqual({ ok: true, bills: [] });
    const twenty = Array.from({ length: 20 }, (_, i) =>
      myBillsRow({ bill_id: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}` }),
    );
    rpcReturns(twenty);
    const res = await listMyBills();
    expect(res.ok && res.bills).toHaveLength(20);
  });

  it('keeps only the D2 fields (an extra column never reaches the screen)', async () => {
    rpcReturns([myBillsRow({ email: 'ada@example.com', seen_at: '2026-11-21T10:06:00+00:00' })]);
    const res = await listMyBills();
    expect(res.ok && Object.keys(res.bills[0]!).sort()).toEqual(
      ['added', 'claimedAny', 'complete', 'createdAt', 'hostId', 'hostName', 'id', 'joinedAt', 'payerId', 'seen', 'totalCents'],
    );
    expectNoServerText(res);
  });

  const twentyOne = () =>
    Array.from({ length: 21 }, (_, i) => myBillsRow({ bill_id: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}` }));

  it.each<[string, unknown]>([
    ['a non-UUID bill_id', [myBillsRow({ bill_id: 'b1' })]],
    ['a non-UUID host_id', [myBillsRow({ host_id: 'hana' })]],
    ['a non-UUID payer_id', [myBillsRow({ payer_id: null })]],
    ['total_cents 1.5', [myBillsRow({ total_cents: 1.5 })]],
    ['total_cents "4480"', [myBillsRow({ total_cents: '4480' })]],
    ['a non-string host_name', [myBillsRow({ host_name: 7 })]],
    ['added "true"', [myBillsRow({ added: 'true' })]],
    ['added 1', [myBillsRow({ added: 1 })]],
    ['added null', [myBillsRow({ added: null })]],
    ['seen "true"', [myBillsRow({ seen: 'true' })]],
    ['seen 1', [myBillsRow({ seen: 1 })]],
    ['seen null', [myBillsRow({ seen: null })]],
    ['claimed_any "true"', [myBillsRow({ claimed_any: 'true' })]],
    ['claimed_any 1', [myBillsRow({ claimed_any: 1 })]],
    ['claimed_any null', [myBillsRow({ claimed_any: null })]],
    ['complete "true"', [myBillsRow({ complete: 'true' })]],
    ['complete 1', [myBillsRow({ complete: 1 })]],
    ['complete null', [myBillsRow({ complete: null })]],
    ['an unparseable created_at', [myBillsRow({ created_at: 'x' })]],
    ['an unparseable joined_at', [myBillsRow({ joined_at: 'yesterday-ish' })]],
    ['a missing joined_at', [myBillsRow({ joined_at: undefined })]],
    ['two rows with the same bill_id', [myBillsRow(), myBillsRow({ seen: true })]],
    ['21 rows', twentyOne()],
    ['null data', null],
    ['an object instead of a list', myBillsRow()],
    ['a list holding a non-object', [myBillsRow(), 'row']],
  ])('the whole result is network for %s (criterion 22)', async (_label, data) => {
    rpcReturns(data);
    expect(await listMyBills()).toEqual({ ok: false, error: 'network' });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 not_allowed (signed out)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ["anon's permission denied", pgError('42501', 'permission denied for function my_bills'), 'not_allowed'],
    ['an unknown SQLSTATE', pgError('P0001'), 'network'],
    ['22023', pgError('22023', 'cannot_leave'), 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s (criterion 22)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await listMyBills();
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('treats a thrown rpc as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    const res = await listMyBills();
    expect(res).toEqual({ ok: false, error: 'network' });
    expectNoServerText(res);
  });
});

describe('markBillSeen (D3; criterion 23)', () => {
  it('calls mark_bill_seen once with exactly { p_bill_id }', async () => {
    expect(await markBillSeen(BILL)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('mark_bill_seen', { p_bill_id: BILL });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('ignores whatever data the function returns (it returns void)', async () => {
    rpcReturns('unexpected');
    expect(await markBillSeen(BILL)).toEqual({ ok: true });
  });

  it('a non-uuid bill is not_found, with no rpc', async () => {
    expect(await markBillSeen('x')).toEqual({ ok: false, error: 'not_found' });
    expect(await markBillSeen('')).toEqual({ ok: false, error: 'not_found' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 not_allowed (not on the bill, no such bill, signed out)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ["anon's permission denied", pgError('42501', 'permission denied for function mark_bill_seen'), 'not_allowed'],
    ['P0002', pgError('P0002', 'not_found'), 'network'],
    ['22023', pgError('22023', 'cannot_leave'), 'network'],
    ['23503', pgError('23503'), 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await markBillSeen(BILL);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await markBillSeen(BILL)).toEqual({ ok: false, error: 'network' });
  });
});

describe('BILL_ERROR_COPY', () => {
  it('has fixed, plain copy for every code', () => {
    const codes: BillError[] = [
      'invalid_code',
      'not_found',
      'not_allowed',
      'invalid_bill',
      'claimers_changed',
      'marks_changed',
      'payer_changed',
      'not_complete',
      'not_linked',
      'cannot_remove',
      'cannot_leave',
      'mark_changed',
      'network',
    ];
    for (const c of codes) {
      expect(typeof BILL_ERROR_COPY[c]).toBe('string');
      expect(BILL_ERROR_COPY[c].length).toBeGreaterThan(0);
    }
    expect(Object.keys(BILL_ERROR_COPY).sort()).toEqual([...codes].sort());
    expect(codes).toHaveLength(13);
  });

  it('has the people-and-invites copy (spec D7, criterion 31)', () => {
    expect(BILL_ERROR_COPY.not_linked).toBe("You can only add people you've split a bill with.");
    expect(BILL_ERROR_COPY.cannot_remove).toBe("Couldn't remove them. They may have just claimed an item.");
    expect(BILL_ERROR_COPY.cannot_leave).toBe("You can't leave right now. Unclaim your items first.");
  });

  it("never says 'payer' (the app uses names, spec § Words)", () => {
    for (const copy of Object.values(BILL_ERROR_COPY)) expect(copy.toLowerCase()).not.toContain('payer');
  });
});

// ---------------------------------------------------------------------------
// Settling (Task 5, contract C3)
// ---------------------------------------------------------------------------

describe('setPayer', () => {
  it('calls set_payer with the bill, the new payer and the expected cleared count (criterion 38)', async () => {
    expect(await setPayer(BILL, PAT, 2)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('set_payer', { p_bill_id: BILL, p_payer_id: PAT, p_expected_cleared: 2 });
  });

  it('sends expectedCleared 0 as 0', async () => {
    await setPayer(BILL, PAT, 0);
    expect(supabase.rpc).toHaveBeenCalledWith('set_payer', { p_bill_id: BILL, p_payer_id: PAT, p_expected_cleared: 0 });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 (not the host, signed out, or no such bill)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ["anon's permission denied", pgError('42501', 'permission denied for function set_payer'), 'not_allowed'],
    ['22023 marks_changed', pgError('22023', 'marks_changed'), 'marks_changed'],
    ['22023 not_participant', pgError('22023', 'not_participant'), 'invalid_bill'],
    ['22023 with an unknown message', pgError('22023'), 'network'],
    ['22023 with a message set_payer never raises', pgError('22023', 'not_complete'), 'network'],
    ['22023 with no message', { code: '22023', message: '' }, 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE', pgError('XX000'), 'network'],
  ])('maps %s (criterion 40)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await setPayer(BILL, PAT, 1);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it.each<[string, string, string, number]>([
    ['a non-uuid bill', 'nope', PAT, 0],
    ['a non-uuid payer', BILL, 'pat', 0],
    ['a negative expected count', BILL, PAT, -1],
    ['a fractional expected count', BILL, PAT, 1.5],
    ['NaN', BILL, PAT, Number.NaN],
  ])('refuses %s locally, without calling the database', async (_label, billId, payerId, expected) => {
    const res = await setPayer(billId, payerId, expected);
    expect(res.ok).toBe(false);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('a non-uuid bill is not_found; a bad payer or count is invalid_bill', async () => {
    expect(await setPayer('nope', PAT, 0)).toEqual({ ok: false, error: 'not_found' });
    expect(await setPayer(BILL, 'pat', 0)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(await setPayer(BILL, PAT, -1)).toEqual({ ok: false, error: 'invalid_bill' });
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await setPayer(BILL, PAT, 0)).toEqual({ ok: false, error: 'network' });
  });
});

describe('markPaid', () => {
  it('calls mark_paid with the bill, the payer the screen showed and the amount (criterion 38)', async () => {
    expect(await markPaid(BILL, HOST, 1510)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('mark_paid', { p_bill_id: BILL, p_payer_id: HOST, p_cents: 1510 });
  });

  it.each([
    ['A2', 1],
    ['A3', 99_999_999],
  ])('sends %s (%i cents)', async (_label, cents) => {
    expect(await markPaid(BILL, HOST, cents)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('mark_paid', { p_bill_id: BILL, p_payer_id: HOST, p_cents: cents });
  });

  it.each([
    ['A1', 0],
    ['A4', 100_000_000],
    ['A5', -5],
    ['A7', 12.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['A6 (null, a type error)', null as unknown as number],
    ['a string', '1510' as unknown as number],
  ])('refuses %s locally as invalid_bill, with no rpc (criterion 39)', async (_label, cents) => {
    expect(await markPaid(BILL, HOST, cents)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid bill (not_found) or payer (invalid_bill) locally', async () => {
    expect(await markPaid('nope', HOST, 1510)).toEqual({ ok: false, error: 'not_found' });
    expect(await markPaid(BILL, 'hana', 1510)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 (not a participant, signed out, or no such bill)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ['22023 invalid_amount', pgError('22023', 'invalid_amount'), 'invalid_bill'],
    ['22023 payer_changed', pgError('22023', 'payer_changed'), 'payer_changed'],
    ['22023 is_payer', pgError('22023', 'is_payer'), 'invalid_bill'],
    ['22023 not_complete', pgError('22023', 'not_complete'), 'not_complete'],
    ['22023 all_zero (settle early, rule Z)', pgError('22023', 'all_zero'), 'invalid_bill'],
    ['22023 with an unknown message', pgError('22023'), 'network'],
    ['22023 with a message mark_paid never raises', pgError('22023', 'marks_changed'), 'network'],
    ['22023 mark_changed (only settle_difference raises it)', pgError('22023', 'mark_changed'), 'network'],
    ['22023 with a near-miss message', pgError('22023', 'not_complete '), 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE', pgError('P0001', 'not_complete'), 'network'],
  ])('maps %s (criterion 40)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await markPaid(BILL, HOST, 1510);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await markPaid(BILL, HOST, 1510)).toEqual({ ok: false, error: 'network' });
  });
});

describe('unmarkPaid', () => {
  it('calls unmark_paid with the bill and the person whose mark is undone (criterion 38)', async () => {
    expect(await unmarkPaid(BILL, PAT)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('unmark_paid', { p_bill_id: BILL, p_user_id: PAT });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['42501 (not host, self or payer)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ['22023 (unmark_paid raises none)', pgError('22023', 'payer_changed'), 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
  ])('maps %s (criterion 40)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await unmarkPaid(BILL, DEE);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('refuses a non-uuid bill (not_found) or user (invalid_bill) locally', async () => {
    expect(await unmarkPaid('nope', PAT)).toEqual({ ok: false, error: 'not_found' });
    expect(await unmarkPaid(BILL, 'pat')).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Membership (docs/specs/2026-11-24-people-and-invites.md D3, D7; criteria 29–30)
// ---------------------------------------------------------------------------

type MembershipCall = {
  name: string;
  fn: string;
  call: (billId: string, userId: string) => Promise<unknown>;
  args: (billId: string, userId: string) => Record<string, unknown>;
  takesUser: boolean;
  ownMessage: 'not_linked' | 'cannot_remove' | 'cannot_leave';
};

const MEMBERSHIP: MembershipCall[] = [
  {
    name: 'addParticipant',
    fn: 'add_participant',
    call: (b, u) => addParticipant(b, u),
    args: (b, u) => ({ p_bill_id: b, p_user_id: u }),
    takesUser: true,
    ownMessage: 'not_linked',
  },
  {
    name: 'removeParticipant',
    fn: 'remove_participant',
    call: (b, u) => removeParticipant(b, u),
    args: (b, u) => ({ p_bill_id: b, p_user_id: u }),
    takesUser: true,
    ownMessage: 'cannot_remove',
  },
  {
    name: 'leaveBill',
    fn: 'leave_bill',
    call: (b) => leaveBill(b),
    args: (b) => ({ p_bill_id: b }),
    takesUser: false,
    ownMessage: 'cannot_leave',
  },
];

describe.each(MEMBERSHIP)('$name', ({ fn, call, args, takesUser, ownMessage }) => {
  it(`calls ${fn} once with exactly its arguments`, async () => {
    expect(await call(BILL, PAT)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(fn, args(BILL, PAT));
  });

  it('ignores whatever data the function returns (it returns void)', async () => {
    rpcReturns('unexpected');
    expect(await call(BILL, PAT)).toEqual({ ok: true });
  });

  it('a non-uuid bill is not_found, with no rpc', async () => {
    expect(await call('nope', PAT)).toEqual({ ok: false, error: 'not_found' });
    expect(await call('', PAT)).toEqual({ ok: false, error: 'not_found' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  if (takesUser) {
    it('a non-uuid user is invalid_bill, with no rpc', async () => {
      expect(await call(BILL, 'pat')).toEqual({ ok: false, error: 'invalid_bill' });
      expect(await call(BILL, '')).toEqual({ ok: false, error: 'invalid_bill' });
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  }

  const others = (['not_linked', 'cannot_remove', 'cannot_leave'] as const).filter((m) => m !== ownMessage);
  it.each<[string, FakeDbError, BillError]>([
    [`22023 ${ownMessage}`, pgError('22023', ownMessage), ownMessage],
    ['42501 not_allowed', pgError('42501', 'not_allowed'), 'not_allowed'],
    ["anon's permission denied", pgError('42501', `permission denied for function ${fn}`), 'not_allowed'],
    ['22023 with an unknown message', pgError('22023'), 'network'],
    [`22023 ${others[0]} (another function's message)`, pgError('22023', others[0] ?? ''), 'network'],
    [`22023 ${others[1]} (another function's message)`, pgError('22023', others[1] ?? ''), 'network'],
    ['22023 with a near-miss message', pgError('22023', `${ownMessage} `), 'network'],
    ['22023 with no message', { code: '22023', message: '' }, 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE with its message', pgError('P0001', ownMessage), 'network'],
  ])('maps %s (criterion 30)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await call(BILL, PAT);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await call(BILL, PAT)).toEqual({ ok: false, error: 'network' });
  });
});

// ---------------------------------------------------------------------------
// Settle early and differences, Task 4 (docs/specs/2026-11-25-settle-early-and-differences.md D4, D7;
// criteria 21–24, Amendment A1)
// ---------------------------------------------------------------------------

describe('BILL_ERROR_COPY: mark_changed (criterion 22)', () => {
  it('has the settle-difference copy', () => {
    expect(BILL_ERROR_COPY.mark_changed).toBe('Your "I paid" just changed. Check the amount and try again.');
  });
});

describe('settleDifference (D4; criteria 21–22)', () => {
  it('[D1] calls settle_difference once with exactly the five arguments (criterion 21)', async () => {
    expect(await settleDifference(BILL, PAT, HOST, 1510, 1620)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('settle_difference', {
      p_bill_id: BILL,
      p_user_id: PAT,
      p_payer_id: HOST,
      p_expected_cents: 1510,
      p_new_cents: 1620,
    });
  });

  it.each<[string, number, number]>([
    ['[D3] a pay-back to $0 (clears the mark)', 1510, 0],
    ['[D2] a pay-back', 1510, 1400],
    ['[D6] a 2-cent raise', 1510, 1512],
    ['[D5] a 1-cent raise (no tolerance in the data layer)', 1510, 1511],
    ['the smallest token', 1, 0],
    ['the largest values', 99_999_999, 99_999_998],
    ['a raise to the maximum', 1, 99_999_999],
  ])('sends %s', async (_label, expected, next) => {
    expect(await settleDifference(BILL, PAT, HOST, expected, next)).toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledWith('settle_difference', {
      p_bill_id: BILL,
      p_user_id: PAT,
      p_payer_id: HOST,
      p_expected_cents: expected,
      p_new_cents: next,
    });
  });

  it.each<[string, number, number]>([
    ['[D10] equal amounts', 1510, 1510],
    ['[D7] a 0 token (unmarked)', 0, 500],
    ['a negative token', -1, 5],
    ['a negative new amount', 5, -1],
    ['a new amount above the maximum', 5, 100_000_000],
    ['a token above the maximum', 100_000_000, 5],
    ['a fractional token', 1.5, 5],
    ['a fractional new amount', 5, 0.5],
    ['NaN', Number.NaN, 5],
    ['Infinity', 5, Number.POSITIVE_INFINITY],
    ['a null token (a type error)', null as unknown as number, 5],
    ['a string new amount', 5, '6' as unknown as number],
    ['0 → 0', 0, 0],
  ])('refuses %s locally as invalid_bill, with no rpc (criterion 21)', async (_label, expected, next) => {
    expect(await settleDifference(BILL, PAT, HOST, expected, next)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid bill (not_found), user or payer (invalid_bill) locally', async () => {
    expect(await settleDifference('nope', PAT, HOST, 1510, 1620)).toEqual({ ok: false, error: 'not_found' });
    expect(await settleDifference(BILL, 'pat', HOST, 1510, 1620)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(await settleDifference(BILL, PAT, 'hana', 1510, 1620)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('ignores whatever data the function returns (it returns void)', async () => {
    rpcReturns('unexpected');
    expect(await settleDifference(BILL, PAT, HOST, 1510, 1620)).toEqual({ ok: true });
  });

  it.each<[string, FakeDbError, BillError]>([
    ['22023 mark_changed', pgError('22023', 'mark_changed'), 'mark_changed'],
    ['22023 all_zero', pgError('22023', 'all_zero'), 'invalid_bill'],
    ['22023 not_complete', pgError('22023', 'not_complete'), 'not_complete'],
    ['22023 payer_changed', pgError('22023', 'payer_changed'), 'payer_changed'],
    ['22023 invalid_amount', pgError('22023', 'invalid_amount'), 'invalid_bill'],
    ['42501 not_allowed (wrong caller for the direction)', pgError('42501', 'not_allowed'), 'not_allowed'],
    ["anon's permission denied", pgError('42501', 'permission denied for function settle_difference'), 'not_allowed'],
    ['22023 with an unknown message', pgError('22023'), 'network'],
    ['22023 is_payer (settle_difference never raises it)', pgError('22023', 'is_payer'), 'network'],
    ['22023 marks_changed (another function’s message)', pgError('22023', 'marks_changed'), 'network'],
    ['22023 with a near-miss message', pgError('22023', 'mark_changed '), 'network'],
    ['22023 with no message', { code: '22023', message: '' }, 'network'],
    ['a fetch failure', FETCH_FAILED, 'network'],
    ['an unknown SQLSTATE with a known message', pgError('P0001', 'mark_changed'), 'network'],
  ])('maps %s (criterion 22)', async (_label, error, expected) => {
    rpcReturns(null, error);
    const res = await settleDifference(BILL, PAT, HOST, 1510, 1620);
    expect(res).toEqual({ ok: false, error: expected });
    expectNoServerText(res);
  });

  it('treats a thrown error as network', async () => {
    supabase.__setRpc(() => {
      throw new Error(SERVER_TEXT);
    });
    expect(await settleDifference(BILL, PAT, HOST, 1510, 1620)).toEqual({ ok: false, error: 'network' });
  });
});

describe('mark parsing is unchanged by A1 (criterion 23)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['settled_cents 0 with a settled_at', { settled_cents: 0 }],
    ['settled_cents -1', { settled_cents: -1 }],
    ['settled_cents without settled_at', { settled_at: null }],
  ])('%s is still network', async (_label, over) => {
    seedBill({ bill_participants: [pat(over)] });
    expect(await fetchBill(BILL)).toEqual({ ok: false, error: 'network' });
  });
});

// --- fetchSettleData (D7, criterion 24) -------------------------------------------------------

const BILL_B = '22222222-3333-4444-8555-666666666666';
const ROW_B1 = 'cccccccc-0000-4000-8000-000000000001';
const ROW_B2 = 'cccccccc-0000-4000-8000-000000000002';
const SETTLE_TABLES = ['bills', 'line_items', 'bill_participants', 'claims'] as const;
type SettleTable = (typeof SETTLE_TABLES)[number];
type RawRow = Record<string, unknown>;
type SettleDataset = Record<SettleTable, unknown[]>;

const BILL_ROW_B = { ...BILL_ROW, id: BILL_B, payer_id: DEE, extras_split: 'equal', total_cents: 2000, tax_cents: 0, tip_cents: 0 };
const withBill = (billId: string, rows: readonly RawRow[]): RawRow[] => rows.map((r) => ({ ...r, bill_id: billId }));

/** Two bills' rows as the database holds them: every child row carries its bill_id. Rows out of order on purpose. */
function twoBills(): SettleDataset {
  return {
    bills: [BILL_ROW, BILL_ROW_B],
    line_items: [
      ...withBill(BILL_B, [unit(ROW_B2, 'Soup', 1, 0, 1, 800)]),
      ...withBill(BILL, [LINE_ITEMS[2]!, LINE_ITEMS[0]!, LINE_ITEMS[3]!, LINE_ITEMS[1]!]),
      ...withBill(BILL_B, [unit(ROW_B1, 'Salad', 0, 0, 1, 1200)]),
    ],
    bill_participants: [
      ...withBill(BILL, PARTICIPANTS),
      ...withBill(BILL_B, [
        { user_id: DEE, settled_at: null, settled_cents: null, profile: { display_name: 'Dee', venmo_username: null } },
        { user_id: PAT, settled_at: MARKED_AT, settled_cents: 900, profile: { display_name: null, venmo_username: 'pat-22' } },
      ]),
    ],
    claims: [
      ...withBill(BILL, CLAIMS),
      ...withBill(BILL_B, [
        { line_item_id: ROW_B1, user_id: DEE, parts: 1 },
        { line_item_id: ROW_B2, user_id: PAT, parts: 3 },
        { line_item_id: ROW_B1, user_id: PAT, parts: 1 },
      ]),
    ],
  };
}

/**
 * Answers both fetchBill (eq) and fetchSettleData (in) from one dataset, the way PostgREST filters.
 * Batched claims come back in reverse order: fetchBill doesn't order claims, so the parity check
 * compares them as sets.
 */
function seedDataset(data: SettleDataset) {
  for (const table of SETTLE_TABLES) {
    supabase.__setTable(table, (q) => {
      const key = table === 'bills' ? 'id' : 'bill_id';
      const eq = q.calls.find((c) => c.method === 'eq');
      const inn = q.calls.find((c) => c.method === 'in');
      let rows = data[table];
      const keyOf = (r: unknown) => (typeof r === 'object' && r !== null ? (r as RawRow)[key] : undefined);
      if (eq) rows = rows.filter((r) => keyOf(r) === eq.args[1]);
      if (inn) rows = rows.filter((r) => (inn.args[1] as unknown[]).includes(keyOf(r)));
      if (q.calls.some((c) => c.method === 'maybeSingle')) return { data: rows[0] ?? null, error: null };
      if (inn && table === 'claims') rows = [...rows].reverse();
      return { data: rows, error: null };
    });
  }
}

const claimKey = (c: { line_item_id: string; user_id: string; parts: number }) => `${c.line_item_id}|${c.user_id}|${c.parts}`;
const asClaimSet = (claims: { line_item_id: string; user_id: string; parts: number }[]) => claims.map(claimKey).sort();

function selectOf(q: RecordedQuery): unknown {
  return q.calls.find((c) => c.method === 'select')?.args[0];
}

describe('fetchSettleData (D7; criterion 24)', () => {
  it('makes exactly four reads, each with .in() over the ids, the fetchBill columns and .range(0, 999)', async () => {
    seedDataset(twoBills());
    const res = await fetchSettleData([BILL, BILL_B]);
    expect(res.ok).toBe(true);
    expect(supabase.from).toHaveBeenCalledTimes(4);
    expect(supabase.__queries).toHaveLength(4);
    expect(supabase.rpc).not.toHaveBeenCalled();
    const batch = new Map(supabase.__queries.map((q) => [q.table, q]));
    expect([...batch.keys()].sort()).toEqual([...SETTLE_TABLES].sort());
    for (const table of SETTLE_TABLES) {
      const q = batch.get(table)!;
      expect(q.calls).toContainEqual({ method: 'in', args: [table === 'bills' ? 'id' : 'bill_id', [BILL, BILL_B]] });
      expect(q.calls).toContainEqual({ method: 'range', args: [0, 999] });
      expect(q.calls.filter((c) => c.method === 'range')).toHaveLength(1);
      expect(q.calls.some((c) => c.method === 'eq')).toBe(false);
    }

    // Same column constants as fetchBill. The child reads add bill_id, the only way to group rows by bill.
    supabase.__queries.length = 0;
    await fetchBill(BILL);
    const single = new Map(supabase.__queries.map((q) => [q.table, q]));
    expect(selectOf(batch.get('bills')!)).toBe(selectOf(single.get('bills')!));
    for (const table of ['line_items', 'bill_participants', 'claims'] as const) {
      expect(selectOf(batch.get(table)!)).toBe(`${selectOf(single.get(table)!) as string}, bill_id`);
    }
    for (const q of [...batch.values()]) {
      expect(selectOf(q)).toEqual(expect.any(String));
      expect(selectOf(q)).not.toMatch(/\*|email/);
    }
  });

  it('returns the same BillData per bill as fetchBill on the same rows (claims compared as sets)', async () => {
    seedDataset(twoBills());
    const res = await fetchSettleData([BILL, BILL_B]);
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect([...res.bills.keys()].sort()).toEqual([BILL, BILL_B].sort());
    for (const id of [BILL, BILL_B]) {
      const single = await fetchBill(id);
      if (!single.ok) throw new Error(`fetchBill failed: ${single.error}`);
      const { ok: _ok, claims: singleClaims, ...singleRest } = single;
      const batched = res.bills.get(id)!;
      const { claims: batchedClaims, ...batchedRest } = batched;
      expect(batchedRest).toEqual(singleRest);
      expect(asClaimSet(batchedClaims)).toEqual(asClaimSet(singleClaims));
      expect(batchedClaims).toHaveLength(singleClaims.length);
      // No bill_id leaks into the parsed values.
      expect(JSON.stringify(batched)).not.toContain('bill_id');
    }
    // Rows are in group/unit order within each bill, whatever order they arrived in.
    expect(res.bills.get(BILL)!.rows.map((r) => r.id)).toEqual([ROW_BURGER, ROW_FRIES, ROW_BEER0, ROW_BEER1]);
    expect(res.bills.get(BILL_B)!.rows.map((r) => r.id)).toEqual([ROW_B1, ROW_B2]);
  });

  it('makes no request for an empty list', async () => {
    const res = await fetchSettleData([]);
    expect(res.ok && res.bills.size).toBe(0);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('refuses 21 ids as invalid_bill, with no request; 20 are read', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `33333333-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(await fetchSettleData(ids)).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.from).not.toHaveBeenCalled();

    seedDataset(twoBills());
    const twenty = await fetchSettleData(ids.slice(0, 20));
    expect(twenty.ok && twenty.bills.size).toBe(0);
    expect(supabase.from).toHaveBeenCalledTimes(4);
  });

  it('refuses a non-uuid id as invalid_bill, with no request', async () => {
    expect(await fetchSettleData([BILL, 'nope'])).toEqual({ ok: false, error: 'invalid_bill' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('sends each id once', async () => {
    seedDataset(twoBills());
    await fetchSettleData([BILL, BILL_B, BILL]);
    expect(queryFor('claims').calls).toContainEqual({ method: 'in', args: ['bill_id', [BILL, BILL_B]] });
  });

  it.each(SETTLE_TABLES)('treats 1,000 rows from %s as a cut-off list: network, no data', async (table) => {
    const data = twoBills();
    const filler = data[table][0] as RawRow;
    data[table] = Array.from({ length: 1000 }, () => filler);
    seedDataset(data);
    expect(await fetchSettleData([BILL, BILL_B])).toEqual({ ok: false, error: 'network' });
  });

  it('treats more than 1,000 rows as a failure too', async () => {
    const data = twoBills();
    data.claims = Array.from({ length: 1001 }, () => (data.claims[0] as RawRow));
    seedDataset(data);
    expect(await fetchSettleData([BILL])).toEqual({ ok: false, error: 'network' });
  });

  it('accepts 999 rows (just under the cap)', async () => {
    const data = twoBills();
    data.claims = Array.from({ length: 999 }, () => ({ line_item_id: ROW_FRIES, user_id: PAT, parts: 1, bill_id: BILL }));
    seedDataset(data);
    const res = await fetchSettleData([BILL]);
    expect(res.ok && res.bills.get(BILL)?.claims).toHaveLength(999);
  });

  it.each(SETTLE_TABLES)('fails the whole call when the %s read fails', async (table) => {
    seedDataset(twoBills());
    supabase.__setTable(table, { data: null, error: pgError('XX000') });
    const res = await fetchSettleData([BILL, BILL_B]);
    expect(res).toEqual({ ok: false, error: 'network' });
    expectNoServerText(res);
  });

  it('maps a 42501 read error to not_allowed, a fetch failure to network', async () => {
    seedDataset(twoBills());
    supabase.__setTable('bill_participants', { data: null, error: pgError('42501') });
    expect(await fetchSettleData([BILL])).toEqual({ ok: false, error: 'not_allowed' });
    seedDataset(twoBills());
    supabase.__setTable('line_items', { data: null, error: FETCH_FAILED });
    expect(await fetchSettleData([BILL])).toEqual({ ok: false, error: 'network' });
  });

  it('treats a thrown query as network, never throwing', async () => {
    seedDataset(twoBills());
    supabase.__setTable('claims', () => {
      throw new Error(SERVER_TEXT);
    });
    await expect(fetchSettleData([BILL, BILL_B])).resolves.toEqual({ ok: false, error: 'network' });
  });

  it.each<[string, (d: SettleDataset) => void]>([
    ['a participant row that fails to parse', (d) => d.bill_participants.push({ ...(d.bill_participants[2] as RawRow), settled_cents: 0 })],
    ['a participant whose profile would make the parser throw', (d) => d.bill_participants.push({ ...(d.bill_participants[2] as RawRow), profile: 5 })],
    ['a malformed row', (d) => d.line_items.push({ ...(d.line_items[0] as RawRow), total_cents: 1.5 })],
    ['a malformed claim', (d) => d.claims.push({ line_item_id: ROW_B1, user_id: DEE, parts: '2', bill_id: BILL_B })],
    ['a malformed bill row', (d) => (d.bills[1] = { ...BILL_ROW_B, extras_split: 'even' })],
  ])('leaves out only the bill with %s; the other bill keeps its data', async (_label, spoil) => {
    const data = twoBills();
    spoil(data);
    seedDataset(data);
    const res = await fetchSettleData([BILL, BILL_B]);
    if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
    expect(res.bills.has(BILL_B)).toBe(false);
    expect(res.bills.get(BILL)?.participants).toEqual([HOST_MEMBER, PAT_MEMBER]);
  });

  it('leaves out a bill RLS does not return (no bill row), even if other rows mention it', async () => {
    const data = twoBills();
    data.bills = [BILL_ROW];
    seedDataset(data);
    const res = await fetchSettleData([BILL, BILL_B]);
    expect(res.ok && [...res.bills.keys()]).toEqual([BILL]);
  });

  it('leaves out a bill id returned twice', async () => {
    const data = twoBills();
    data.bills.push(BILL_ROW_B);
    seedDataset(data);
    const res = await fetchSettleData([BILL, BILL_B]);
    expect(res.ok && [...res.bills.keys()]).toEqual([BILL]);
  });

  it.each<[string, SettleTable, unknown]>([
    ['a null claim', 'claims', null],
    ['a row without a bill_id', 'line_items', { ...LINE_ITEMS[0]! }],
    ['a participant with a non-uuid bill_id', 'bill_participants', { ...PARTICIPANTS[0]!, bill_id: 'x' }],
    ['a claim for a bill that was not asked for', 'claims', { ...CLAIMS[0]!, bill_id: DEE }],
  ])('fails the whole call (network) on %s: it could belong to any bill', async (_label, table, stray) => {
    seedDataset(twoBills());
    // Returned as-is (no filtering), so the stray row reaches the parser.
    supabase.__setTable(table, { data: [...twoBills()[table], stray], error: null });
    await expect(fetchSettleData([BILL, BILL_B])).resolves.toEqual({ ok: false, error: 'network' });
  });

  it.each(SETTLE_TABLES)('treats a non-array response from %s as network', async (table) => {
    seedDataset(twoBills());
    supabase.__setTable(table, { data: { nope: true }, error: null });
    expect(await fetchSettleData([BILL])).toEqual({ ok: false, error: 'network' });
  });
});
