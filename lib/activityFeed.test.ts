// Contracts A and T, and criteria 8–12 and A1.1 of docs/specs/2026-11-28-tab-bar-and-activity.md.
// The fake client below records every call's shape and answers from in-memory tables by applying
// the filters the way PostgREST does (in, eq, gt, the keyset `or`, order, limit, range, and an exact
// count before the limit), so paging is tested against real filtering, not canned pages.
import { ANA, B1, B2, G1, G2_HIDDEN, MAYA, ME, SAM, billEvent, groupEvent } from '@/test-utils/feedFixtures';

import {
  compareFeedRows,
  feedOrder,
  fetchBadgeInputs,
  fetchEventPage,
  fetchFeedPage,
  feedBadges,
  FEED_BILL_READ_KINDS,
  FEED_GROUP_READ_KINDS,
  FEED_ID_CHUNK,
  FEED_MAX_LIMIT,
  FEED_PAGE_SIZE,
  FEED_REQUEST_TIMEOUT_MS,
  feedCursorIso,
  initialFeedState,
  loadFeedPlaces,
  newestOnly,
  type FeedPagerState,
} from './activityFeed';
import { fetchSettleData, type BillData } from './bills';
import { FEED_BILL_KINDS, FEED_GROUP_KINDS, type FeedBillEventRow, type FeedGroupEventRow } from './feedRules';
import { EMPTY_FEED_SEEN, forgetFeedPlaces, type FeedSeen } from './feedSeen';
import { fetchGroupSnapshot, GROUP_REQUEST_TIMEOUT_MS, listMyGroups, type GroupSnapshot, type GroupSummary } from './groups';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------------------------
// The fake client

type Row = Record<string, unknown>;
type Call = { method: string; args: unknown[] };
type Query = { table: string; calls: Call[] };
type Answer = { data: unknown; error: { code?: string; message: string } | null; count?: number | null };
type Override = (q: Query, computed: Answer) => Answer | Promise<Answer>;

const fake = {
  tables: new Map<string, Row[]>(),
  queries: [] as Query[],
  override: null as Override | null,
};

const micros = (v: unknown): number => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(v));
  if (!m) throw new Error(`fake: bad timestamp ${String(v)}`);
  return Date.parse(`${m[1]}T${m[2]}${m[4]}`) * 1000 + Number((m[3] ?? '').padEnd(6, '0'));
};

const KEYSET_RE = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]{36})\)$/;

function run(q: Query): Answer {
  let rows = [...(fake.tables.get(q.table) ?? [])];
  let limit: number | null = null;
  let range: [number, number] | null = null;
  const orders: { col: string; asc: boolean }[] = [];
  for (const { method, args } of q.calls) {
    if (method === 'in') rows = rows.filter((r) => (args[1] as unknown[]).includes(r[args[0] as string]));
    else if (method === 'eq') rows = rows.filter((r) => r[args[0] as string] === args[1]);
    else if (method === 'gt') rows = rows.filter((r) => micros(r[args[0] as string]) > micros(args[1]));
    else if (method === 'or') {
      const m = KEYSET_RE.exec(args[0] as string);
      if (!m || m[1] !== m[2]) throw new Error(`fake: unexpected or() ${String(args[0])}`);
      const at = micros(m[1]);
      const id = m[3]!;
      rows = rows.filter((r) => micros(r.created_at) < at || (micros(r.created_at) === at && String(r.id) < id));
    } else if (method === 'order') orders.push({ col: args[0] as string, asc: (args[1] as { ascending: boolean }).ascending });
    else if (method === 'limit') limit = args[0] as number;
    else if (method === 'range') range = [args[0] as number, args[1] as number];
    else if (method !== 'select') throw new Error(`fake: unexpected ${method}`);
  }
  rows.sort((a, b) => {
    for (const { col, asc } of orders) {
      const x = col === 'created_at' ? micros(a[col]) : String(a[col]);
      const y = col === 'created_at' ? micros(b[col]) : String(b[col]);
      if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
    }
    return 0;
  });
  const count = rows.length;
  if (range) rows = rows.slice(range[0], range[1] + 1);
  if (limit !== null) rows = rows.slice(0, limit);
  const select = q.calls.find((c) => c.method === 'select');
  const cols = String(select?.args[0]).split(',').map((s) => s.trim());
  const data = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  const wantsCount = (select?.args[1] as { count?: string } | undefined)?.count === 'exact';
  return wantsCount ? { data, error: null, count } : { data, error: null };
}

jest.mock('./supabase', () => {
  const from = jest.fn((table: string) => {
    const q = { table, calls: [] as { method: string; args: unknown[] }[] };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'gt', 'or', 'order', 'limit', 'range']) {
      builder[method] = (...args: unknown[]) => {
        q.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => mockAnswer(q).then(ok, bad);
    return builder;
  });
  return { supabase: { from } };
});
async function mockAnswer(q: Query): Promise<Answer> {
  fake.queries.push(q);
  const computed = run(q);
  return fake.override ? fake.override(q, computed) : computed;
}

jest.mock('./groups', () => ({
  ...jest.requireActual<typeof import('./groups')>('./groups'),
  listMyGroups: jest.fn(),
  fetchGroupSnapshot: jest.fn(),
}));
jest.mock('./bills', () => ({ ...jest.requireActual<typeof import('./bills')>('./bills'), fetchSettleData: jest.fn() }));
jest.mock('./storage', () => {
  const { createMemoryStorage: make } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: make() };
});

const mockListMyGroups = listMyGroups as jest.MockedFunction<typeof listMyGroups>;
const mockSnapshot = fetchGroupSnapshot as jest.MockedFunction<typeof fetchGroupSnapshot>;
const mockSettle = fetchSettleData as jest.MockedFunction<typeof fetchSettleData>;
void supabase;

// ---------------------------------------------------------------------------------------------
// Data helpers

const JOINED = '2026-11-01T12:00:00.000000+00:00';
let n = 0;
const uuid = (prefix: string) => {
  n += 1;
  return `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
const at = (minute: number, micro = 0) => {
  const d = new Date(Date.UTC(2026, 10, 27, 10, 0, 0) + minute * 60_000);
  return `${d.toISOString().slice(0, 19)}.${String(micro).padStart(6, '0')}+00:00`;
};

function group(id: string, over: Partial<GroupSummary> = {}): GroupSummary {
  return { id, name: id === G1 ? 'Tahoe' : 'Other', memberCount: 3, joinedAt: JOINED, hidden: false, ...over };
}

function seedPlaces(bills: { id: string; host: string; group: string | null }[], groups: GroupSummary[]) {
  fake.tables.set(
    'bill_participants',
    bills.map((b) => ({ bill_id: b.id, joined_at: JOINED, user_id: ME })),
  );
  fake.tables.set(
    'bills',
    bills.map((b) => ({ id: b.id, host_id: b.host, group_id: b.group, created_at: JOINED })),
  );
  mockListMyGroups.mockResolvedValue({ ok: true, groups });
}

const billRow = (e: FeedBillEventRow): Row => ({ ...e });
const groupRow = (e: FeedGroupEventRow): Row => ({ ...e });

function setEvents(bill: FeedBillEventRow[], grp: FeedGroupEventRow[]) {
  fake.tables.set('bill_events', bill.map(billRow));
  fake.tables.set('group_events', grp.map(groupRow));
}

function minimalBillData(id: string, host: string): BillData {
  return {
    bill: { id, host_id: host } as unknown as BillData['bill'],
    rows: [],
    participants: [],
    claims: [],
    payers: [],
    payments: [],
    flags: [],
  };
}

const queriesOf = (table: string) => fake.queries.filter((q) => q.table === table);
const callsOf = (q: Query, method: string) => q.calls.filter((c) => c.method === method).map((c) => c.args);

beforeEach(() => {
  fake.tables.clear();
  fake.queries.length = 0;
  fake.override = null;
  n = 0;
  forgetFeedPlaces();
  jest.useRealTimers();
  mockListMyGroups.mockReset();
  mockSnapshot.mockReset();
  mockSettle.mockReset();
  mockSettle.mockImplementation(async (ids) => ({ ok: true, bills: new Map(ids.map((id) => [id, minimalBillData(id, MAYA)])) }));
  mockSnapshot.mockResolvedValue({ ok: false, error: 'network' });
  fake.tables.set('profiles', [
    { id: MAYA, display_name: 'Maya' },
    { id: SAM, display_name: 'Sam' },
    { id: ANA, display_name: '  ' },
  ]);
  fake.tables.set('group_payments', []);
});

// ---------------------------------------------------------------------------------------------

describe('kinds read', () => {
  it('bill reads ask for FEED_BILL_KINDS plus item_added (a fully-claimed trigger only)', () => {
    expect(FEED_BILL_READ_KINDS).toEqual([...FEED_BILL_KINDS, 'item_added']);
  });
  it('group reads ask for every kind the Groups dot needs: all but renamed and link_rotated', () => {
    expect([...FEED_GROUP_READ_KINDS].sort()).toEqual(
      [
        'group_created',
        'member_joined',
        'member_left',
        'expense_added',
        'expense_edited',
        'expense_deleted',
        'payment_recorded',
        'payment_undone',
        'bill_added',
        'bill_removed',
      ].sort(),
    );
    for (const k of FEED_GROUP_KINDS) expect(FEED_GROUP_READ_KINDS).toContain(k);
  });
});

describe('loadFeedPlaces (Contract A, criteria 8 and 9)', () => {
  it('reads exactly the Contract A columns and returns bills, groups (hidden flagged) and group names', async () => {
    seedPlaces(
      [
        { id: B1, host: MAYA, group: null },
        { id: B2, host: SAM, group: G1 },
      ],
      [group(G1), group(G2_HIDDEN, { hidden: true })],
    );
    const res = await loadFeedPlaces(ME);
    if (!res.ok) throw new Error(res.error);
    expect(res.places.bills.get(B1)).toEqual({ joinedAt: JOINED, groupId: null, hostId: MAYA });
    expect(res.places.bills.get(B2)).toEqual({ joinedAt: JOINED, groupId: G1, hostId: SAM });
    expect(res.places.groups.get(G1)).toEqual({ joinedAt: JOINED, hidden: false });
    expect(res.places.groups.get(G2_HIDDEN)).toEqual({ joinedAt: JOINED, hidden: true });
    expect(res.places.groupNames.get(G1)).toBe('Tahoe');

    const [bp] = queriesOf('bill_participants');
    expect(callsOf(bp!, 'select')).toEqual([['bill_id, joined_at', { count: 'exact' }]]);
    expect(callsOf(bp!, 'eq')).toEqual([['user_id', ME]]);
    expect(callsOf(bp!, 'range')).toEqual([[0, 499]]);
    const [bills] = queriesOf('bills');
    expect(callsOf(bills!, 'select')).toEqual([['id, host_id, group_id, created_at', { count: 'exact' }]]);
    expect(callsOf(bills!, 'in')).toEqual([['id', [B1, B2]]]);
  });

  it('1,200 places over three ranges: all 1,200 are used', async () => {
    const bills = Array.from({ length: 1200 }, (_, i) => ({ id: uuid('b'), host: MAYA, group: null, i }));
    seedPlaces(bills, []);
    const res = await loadFeedPlaces(ME);
    if (!res.ok) throw new Error(res.error);
    expect(res.places.bills.size).toBe(1200);
    expect(queriesOf('bill_participants').map((q) => callsOf(q, 'range')[0])).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
    // Bill facts in chunks of FEED_ID_CHUNK, each id exactly once (criterion 10).
    const asked = queriesOf('bills').flatMap((q) => callsOf(q, 'in')[0]![1] as string[]);
    expect(asked).toHaveLength(1200);
    expect(new Set(asked).size).toBe(1200);
    expect(queriesOf('bills').every((q) => (callsOf(q, 'in')[0]![1] as string[]).length <= FEED_ID_CHUNK)).toBe(true);
    expect(queriesOf('bills')).toHaveLength(12);
  });

  it('fewer rows than the count (a cut-off page) is network, with no partial list', async () => {
    seedPlaces(
      Array.from({ length: 30 }, () => ({ id: uuid('b'), host: MAYA, group: null })),
      [],
    );
    fake.override = (q, c) => (q.table === 'bill_participants' ? { ...c, data: (c.data as Row[]).slice(0, 20) } : c);
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('a missing count, or a bills chunk cut short, is network', async () => {
    seedPlaces([{ id: B1, host: MAYA, group: null }], []);
    fake.override = (q, c) => (q.table === 'bill_participants' ? { ...c, count: null } : c);
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'network' });
    fake.override = (q, c) => (q.table === 'bills' ? { ...c, count: 2 } : c);
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('a bill RLS no longer returns is left out; my groups failing fails the read', async () => {
    seedPlaces(
      [
        { id: B1, host: MAYA, group: null },
        { id: B2, host: SAM, group: G1 },
      ],
      [group(G1)],
    );
    fake.tables.set('bills', [{ id: B1, host_id: MAYA, group_id: null, created_at: JOINED }]);
    const res = await loadFeedPlaces(ME);
    if (!res.ok) throw new Error(res.error);
    expect([...res.places.bills.keys()]).toEqual([B1]);
    mockListMyGroups.mockResolvedValue({ ok: false, error: 'not_allowed' });
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'not_allowed' });
  });

  it('errors: 42501 is not_allowed, anything else network, a throw network', async () => {
    seedPlaces([{ id: B1, host: MAYA, group: null }], []);
    fake.override = () => ({ data: null, error: { code: '42501', message: 'denied' } });
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    fake.override = () => ({ data: null, error: { code: 'PGRST301', message: 'jwt' } });
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'network' });
    fake.override = () => Promise.reject(new Error('offline'));
    await expect(loadFeedPlaces(ME)).resolves.toEqual({ ok: false, error: 'network' });
  });
});

describe('fetchEventPage (Contract A, criteria 8, 10 and A1.1)', () => {
  it('bill events: exact columns, kinds, order and limit, with an exact count', async () => {
    const e = billEvent('claimed', { actor_id: SAM, item_name: 'Fries', created_at: at(1) });
    setEvents([e], []);
    const res = await fetchEventPage('bill', [B1], FEED_BILL_READ_KINDS, null, 30);
    if (!res.ok) throw new Error(res.error);
    expect(res.rows).toEqual([e]);
    expect(res.more).toBe(false);
    const [q] = queriesOf('bill_events');
    expect(q!.calls).toEqual([
      { method: 'select', args: ['id, bill_id, actor_id, kind, item_name, details, created_at', { count: 'exact' }] },
      { method: 'in', args: ['bill_id', [B1]] },
      { method: 'in', args: ['kind', FEED_BILL_READ_KINDS] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [30] },
    ]);
  });

  it('group events: exact columns; the keyset cursor uses the PostgREST or() syntax with microseconds and Z', async () => {
    setEvents([], [groupEvent('expense_added', { created_at: at(1, 5) })]);
    const cursor = { at: '2026-11-27T19:42:00.123456+00:00', id: 'e0000000-0000-4000-8000-000000000009' };
    const res = await fetchEventPage('group', [G1], FEED_GROUP_KINDS, cursor, 30);
    expect(res.ok).toBe(true);
    const [q] = queriesOf('group_events');
    expect(q!.calls).toEqual([
      { method: 'select', args: ['id, group_id, actor_id, kind, details, created_at', { count: 'exact' }] },
      { method: 'in', args: ['group_id', [G1]] },
      { method: 'in', args: ['kind', FEED_GROUP_KINDS] },
      {
        method: 'or',
        args: [
          'created_at.lt."2026-11-27T19:42:00.123456Z",and(created_at.eq."2026-11-27T19:42:00.123456Z",id.lt.e0000000-0000-4000-8000-000000000009)',
        ],
      },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [30] },
    ]);
  });

  it('`since` adds .gt(created_at) in the same encoding', async () => {
    setEvents([], []);
    await fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 1000, '2026-11-14T12:00:00.000Z');
    expect(callsOf(queriesOf('bill_events')[0]!, 'gt')).toEqual([['created_at', '2026-11-14T12:00:00.000000Z']]);
  });

  it('feedCursorIso keeps microseconds and converts any offset to Z', () => {
    expect(feedCursorIso('2026-11-27T19:42:00.123456+00:00')).toBe('2026-11-27T19:42:00.123456Z');
    expect(feedCursorIso('2026-11-27T14:42:00.5-05:00')).toBe('2026-11-27T19:42:00.500000Z');
    expect(feedCursorIso('2026-11-27T19:42:00Z')).toBe('2026-11-27T19:42:00.000000Z');
    expect(feedCursorIso('nope')).toBeNull();
  });

  it('never asks for more than FEED_MAX_LIMIT (1000) rows', async () => {
    expect(FEED_MAX_LIMIT).toBe(1000);
    await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 1001)).resolves.toEqual({ ok: false, error: 'network' });
    await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 0)).resolves.toEqual({ ok: false, error: 'network' });
    expect(fake.queries).toHaveLength(0);
  });

  it('more than FEED_ID_CHUNK ids are chunked; every id is queried exactly once; results merge in order', async () => {
    const ids = Array.from({ length: FEED_ID_CHUNK * 2 + 5 }, () => uuid('b'));
    const events = ids.map((id, i) => billEvent('joined', { bill_id: id, actor_id: SAM, created_at: at(i) }));
    setEvents(events, []);
    const res = await fetchEventPage('bill', ids, FEED_BILL_KINDS, null, 10);
    if (!res.ok) throw new Error(res.error);
    const qs = queriesOf('bill_events');
    expect(qs).toHaveLength(3);
    const asked = qs.flatMap((q) => callsOf(q, 'in')[0]![1] as string[]);
    expect(asked.sort()).toEqual([...ids].sort());
    expect(qs.map((q) => (callsOf(q, 'in')[0]![1] as string[]).length)).toEqual([100, 100, 5]);
    // Newest 10 across all chunks.
    expect(res.rows.map((r) => r.id)).toEqual([...events].reverse().slice(0, 10).map((e) => e.id));
    expect(res.more).toBe(true);
  });

  it('A1.1: a chunk that returns exactly `limit` rows means "maybe more"', async () => {
    setEvents(
      [1, 2, 3].map((m) => billEvent('joined', { actor_id: SAM, created_at: at(m) })),
      [],
    );
    const full = await fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 3);
    expect(full.ok && full.more).toBe(true);
    const short = await fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 4);
    expect(short.ok && short.more).toBe(false);
  });

  it('a response cut below its count, a missing count, rows out of order, a row past the cursor or a stranger’s row is network', async () => {
    const rows = [1, 2, 3, 4].map((m) => billEvent('joined', { actor_id: SAM, created_at: at(m) }));
    setEvents(rows, []);
    const cases: Override[] = [
      (_q, c) => ({ ...c, data: (c.data as Row[]).slice(0, 2) }), // max_rows below the limit
      (_q, c) => ({ ...c, count: undefined }),
      (_q, c) => ({ ...c, data: [...(c.data as Row[])].reverse() }),
      (_q, c) => ({ ...c, data: [{ ...(c.data as Row[])[0], bill_id: B2 }, ...(c.data as Row[]).slice(1)] }),
      (_q, c) => ({ ...c, data: [{ ...(c.data as Row[])[0], created_at: 'later' }, ...(c.data as Row[]).slice(1)] }),
    ];
    for (const o of cases) {
      fake.override = o;
      await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 10)).resolves.toEqual({ ok: false, error: 'network' });
    }
    fake.override = null;
    const cursor = { at: rows[1]!.created_at, id: rows[1]!.id };
    fake.override = () => ({ data: [billRow(rows[3]!)], error: null, count: 1 }); // newer than the cursor
    await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, cursor, 10)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('copies only the Contract A columns from each row', async () => {
    fake.tables.set('bill_events', [{ ...billRow(billEvent('joined', { actor_id: SAM, created_at: at(1) })), venmo_username: 'x' }]);
    const res = await fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 10);
    if (!res.ok) throw new Error(res.error);
    expect(Object.keys(res.rows[0]!).sort()).toEqual(['actor_id', 'bill_id', 'created_at', 'details', 'id', 'item_name', 'kind']);
  });

  it('no ids makes no request', async () => {
    await expect(fetchEventPage('group', [], FEED_GROUP_KINDS, null, 30)).resolves.toEqual({ ok: true, rows: [], more: false });
    expect(fake.queries).toHaveLength(0);
  });
});

describe('feedOrder', () => {
  it('orders feed items newest first, ties by id desc, an unreadable time last', () => {
    const x = { at: at(1), id: 'e0000000-0000-4000-8000-00000000000a' };
    const y = { at: at(1), id: 'e0000000-0000-4000-8000-00000000000b' };
    const z = { at: 'never', id: 'e0000000-0000-4000-8000-00000000000f' };
    const w = { at: at(2), id: 'e0000000-0000-4000-8000-000000000001' };
    expect([z, x, w, y].sort(feedOrder).map((i) => i.id)).toEqual([w.id, y.id, x.id, z.id]);
    expect(feedOrder(x, x)).toBe(0);
  });
});

describe('compareFeedRows', () => {
  it('orders newest first by created_at (to the microsecond), then id desc, across both sources', () => {
    const a = billEvent('joined', { id: 'e0000000-0000-4000-8000-00000000000a', created_at: at(1) });
    const b = groupEvent('member_joined', { id: 'e0000000-0000-4000-8000-00000000000b', created_at: at(1) });
    const c = billEvent('joined', { id: 'e0000000-0000-4000-8000-00000000000c', created_at: at(1, 1) });
    expect([a, b, c].sort(compareFeedRows).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    // id compared as a lowercase string
    const upper = billEvent('joined', { id: 'E0000000-0000-4000-8000-00000000000D', created_at: at(1) });
    expect([a, upper].sort(compareFeedRows)[0]).toBe(upper);
  });
});

// ---------------------------------------------------------------------------------------------
// Merge and paging (criterion 11)

describe('fetchFeedPage: merge and paging (criterion 11)', () => {
  // 7 visible events over two sources; three share one created_at (two bill, one group).
  const T = at(10, 123456);
  const ID = (k: number) => `e0000000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const bills = [
    billEvent('claimed', { id: ID(1), actor_id: SAM, item_name: 'Fries', created_at: at(1) }),
    billEvent('claimed', { id: ID(2), actor_id: SAM, item_name: 'Fries', created_at: T }),
    billEvent('claimed', { id: ID(9), actor_id: SAM, item_name: 'Fries', created_at: T }),
    billEvent('joined', { id: ID(4), actor_id: ANA, created_at: at(20) }),
  ];
  const groups = [
    groupEvent('member_joined', { id: ID(5), actor_id: ANA, created_at: T }),
    groupEvent('member_joined', { id: ID(6), actor_id: SAM, created_at: at(5) }),
    groupEvent('member_joined', { id: ID(7), actor_id: SAM, created_at: at(30) }),
  ];
  const expectedOrder = [ID(7), ID(4), ID(9), ID(5), ID(2), ID(6), ID(1)];

  beforeEach(() => {
    seedPlaces([{ id: B1, host: MAYA, group: null }], [group(G1)]);
    setEvents(bills, groups);
  });

  async function all(state: FeedPagerState): Promise<{ ids: string[][]; ends: boolean[] }> {
    const ids: string[][] = [];
    const ends: boolean[] = [];
    let s = state;
    for (let i = 0; i < 20; i++) {
      const res = await fetchFeedPage('all', s);
      if (!res.ok) throw new Error(res.error);
      ids.push(res.page.items.map((x) => x.id));
      ends.push(res.page.end);
      s = res.page.state;
      if (res.page.end) break;
    }
    return { ids, ends };
  }

  it('equal created_at across sources merge in id desc order', async () => {
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items.map((x) => x.id)).toEqual(expectedOrder);
    expect(res.page.end).toBe(true);
  });

  it('page size 2 over 7 events: each exactly once, in order; pages joined = the unpaged order; end once', async () => {
    const { ids, ends } = await all(initialFeedState(ME, { pageSize: 2 }));
    expect(ids.flat()).toEqual(expectedOrder);
    expect(ids.every((p) => p.length <= 2)).toBe(true);
    expect(ends.filter(Boolean)).toHaveLength(1);
    expect(ends[ends.length - 1]).toBe(true);
  });

  it('rows fetched but dropped by the rules still advance the cursor', async () => {
    // My own events and a payment between others are dropped, but must not be re-fetched forever.
    const dropped = [
      billEvent('claimed', { id: ID(30), actor_id: ME, item_name: 'Tacos', created_at: at(25) }),
      billEvent('marked_paid', { id: ID(31), actor_id: SAM, details: { payer_id: MAYA, cents: 100 }, created_at: at(24) }),
      billEvent('claimed', { id: ID(32), actor_id: ME, item_name: 'Tacos', created_at: at(23) }),
    ];
    setEvents([...bills, ...dropped], groups);
    const { ids } = await all(initialFeedState(ME, { pageSize: 2 }));
    expect(ids.flat()).toEqual(expectedOrder);
    const page = await fetchFeedPage('all', initialFeedState(ME));
    if (!page.ok) throw new Error(page.error);
    expect(page.page.rows.map((r) => r.id)).toContain(ID(30)); // consumed, returned as a raw row
    expect(page.page.items.map((i) => i.id)).not.toContain(ID(30));
  });

  it('a page that needs more than 3 rounds returns what it has, and is not marked as the end', async () => {
    // Every bill round of 2 rows is all dropped (my own events); the one visible line is far back.
    const mine = Array.from({ length: 10 }, (_, i) =>
      billEvent('claimed', { id: ID(100 + i), actor_id: ME, item_name: 'Tacos', created_at: at(100 - i) }),
    );
    const visible = billEvent('joined', { id: ID(200), actor_id: SAM, created_at: at(50) });
    setEvents([...mine, visible], []);
    const first = await fetchFeedPage('all', initialFeedState(ME, { pageSize: 2 }));
    if (!first.ok) throw new Error(first.error);
    expect(first.page.items).toEqual([]);
    expect(first.page.end).toBe(false);
    expect(queriesOf('bill_events')).toHaveLength(3);
    // Scrolling continues from there.
    let s = first.page.state;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetchFeedPage('all', s);
      if (!r.ok) throw new Error(r.error);
      seen.push(...r.page.items.map((x) => x.id));
      s = r.page.state;
      if (r.page.end) break;
    }
    expect(seen).toEqual([ID(200)]);
  });

  it('A1.1: a source returning exactly `limit` rows is not the end, and the next page asks for more', async () => {
    setEvents(bills.slice(0, 2), []);
    const first = await fetchFeedPage('all', initialFeedState(ME, { pageSize: 2 }));
    if (!first.ok) throw new Error(first.error);
    expect(first.page.items).toHaveLength(2);
    expect(first.page.end).toBe(false);
    const before = queriesOf('bill_events').length;
    const next = await fetchFeedPage('all', first.page.state);
    if (!next.ok) throw new Error(next.error);
    expect(queriesOf('bill_events').length).toBe(before + 1);
    expect(callsOf(queriesOf('bill_events').at(-1)!, 'or')).toHaveLength(1);
    expect(next.page.items).toEqual([]);
    expect(next.page.end).toBe(true);
  });

  it('the filter applies to visible lines only; Groups keeps group events and group bills’ events', async () => {
    const res = await fetchFeedPage('groups', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items.map((x) => x.id)).toEqual([ID(7), ID(5), ID(6)]);
  });

  it('a failed read fails the page and leaves the given state usable for a retry', async () => {
    const first = await fetchFeedPage('all', initialFeedState(ME, { pageSize: 2 }));
    if (!first.ok) throw new Error(first.error);
    const second = await fetchFeedPage('all', first.page.state);
    if (!second.ok) throw new Error(second.error);
    expect(second.page.items.map((x) => x.id)).toEqual(expectedOrder.slice(2, 4));
    // Both buffers are empty now, so the third page must fetch.
    const reads = fake.queries.length;
    fake.override = (q, c) => (q.table === 'group_events' ? { data: null, error: { code: '500', message: 'x' } } : c);
    const failed = await fetchFeedPage('all', second.page.state);
    expect(failed).toEqual({ ok: false, error: 'network' });
    expect(fake.queries.length).toBeGreaterThan(reads);
    fake.override = null;
    const retry = await fetchFeedPage('all', second.page.state);
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.page.items.map((x) => x.id)).toEqual(expectedOrder.slice(4, 6));
  });

  it('hidden groups are not read', async () => {
    seedPlaces([{ id: B1, host: MAYA, group: null }], [group(G1), group(G2_HIDDEN, { hidden: true })]);
    await fetchFeedPage('all', initialFeedState(ME));
    const asked = queriesOf('group_events').flatMap((q) => callsOf(q, 'in')[0]![1] as string[]);
    expect(asked).toEqual([G1]);
  });
});

describe('fetchFeedPage: milestone candidates and view facts (Task 4 contract)', () => {
  beforeEach(() => {
    seedPlaces(
      [
        { id: B1, host: MAYA, group: null },
        { id: B2, host: SAM, group: G1 },
      ],
      [group(G1)],
    );
  });

  it('builds a candidate for every consumed row, my own included, and applies the filter to them', async () => {
    const mineAdded = billEvent('item_added', { bill_id: B1, actor_id: ME, item_name: 'Soda', created_at: at(3) });
    const myMark = billEvent('marked_paid', { bill_id: B2, actor_id: ME, details: { payer_id: SAM, cents: 500 }, created_at: at(2) });
    const other = billEvent('joined', { bill_id: B1, actor_id: ANA, created_at: at(1) });
    setEvents([mineAdded, myMark, other], []);
    const all = await fetchFeedPage('all', initialFeedState(ME));
    if (!all.ok) throw new Error(all.error);
    expect(all.page.items.map((i) => i.id)).toEqual([other.id]);
    expect(all.page.candidates.map((c) => c.id)).toEqual([`milestone:fully_claimed:${mineAdded.id}`, `milestone:all_square:${myMark.id}`]);
    const money = await fetchFeedPage('money', initialFeedState(ME));
    if (!money.ok) throw new Error(money.error);
    expect(money.page.candidates.map((c) => c.milestone)).toEqual(['all_square']);
    const groups = await fetchFeedPage('groups', initialFeedState(ME));
    if (!groups.ok) throw new Error(groups.error);
    expect(groups.page.candidates.map((c) => c.billId)).toEqual([B2]);
  });

  it('returns FeedViewFacts: myId, names, bills (places), groupNames, billData, snapshots', async () => {
    setEvents([billEvent('joined', { bill_id: B2, actor_id: ANA, created_at: at(1) })], []);
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    const f = res.page.viewFacts;
    expect(Object.keys(f).sort()).toEqual(['billData', 'bills', 'groupNames', 'myId', 'names', 'snapshots']);
    expect(f.myId).toBe(ME);
    expect(f.bills.get(B2)).toEqual({ joinedAt: JOINED, groupId: G1, hostId: SAM });
    expect(f.groupNames.get(G1)).toBe('Tahoe');
    expect(f.billData.has(B2)).toBe(true);
    expect(f.names.get(SAM)).toBe('Sam');
    expect(f.snapshots.size).toBe(0);
  });
});

describe('fetchFeedPage: facts', () => {
  const PAY = 'a1000000-0000-4000-8000-0000000000a1';
  beforeEach(() => {
    seedPlaces(
      [
        { id: B1, host: MAYA, group: null },
        { id: B2, host: SAM, group: G1 },
      ],
      [group(G1)],
    );
  });

  it('loads claims (fetchSettleData) for the page’s bills, so F-h is included when I claim on the bill', async () => {
    const changed = billEvent('amounts_changed', { actor_id: MAYA, details: { tip_cents: [1, 2] }, created_at: at(1) });
    setEvents([changed], []);
    const row = { id: '10000000-0000-4000-8000-000000000001', name: 'Tacos' };
    mockSettle.mockImplementation(async (ids) => ({
      ok: true,
      bills: new Map(
        ids.map((id) => [
          id,
          { ...minimalBillData(id, MAYA), rows: [row], claims: [{ line_item_id: row.id, user_id: ME, parts: 1 }] } as unknown as BillData,
        ]),
      ),
    }));
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items.map((i) => [i.id, i.category])).toEqual([[changed.id, 'share']]);
    expect(mockSettle).toHaveBeenCalledWith([B1]);
    expect(res.page.facts.bills.get(B1)).toBeDefined();
  });

  it('batches fetchSettleData at 20 ids per call', async () => {
    const ids = Array.from({ length: 45 }, () => uuid('b'));
    seedPlaces(ids.map((id) => ({ id, host: MAYA, group: null })), []);
    setEvents(
      ids.map((id, i) => billEvent('joined', { bill_id: id, actor_id: SAM, created_at: at(i) })),
      [],
    );
    const res = await fetchFeedPage('all', initialFeedState(ME, { pageSize: 50 }));
    expect(res.ok).toBe(true);
    expect(mockSettle.mock.calls.map((c) => c[0].length)).toEqual([20, 20, 5]);
    expect(new Set(mockSettle.mock.calls.flatMap((c) => [...c[0]])).size).toBe(45);
  });

  it('a failed claims read fails the page (network), so a share line is never silently dropped', async () => {
    setEvents([billEvent('amounts_changed', { details: { tip_cents: [1, 2] }, created_at: at(1) })], []);
    mockSettle.mockResolvedValue({ ok: false, error: 'network' });
    await expect(fetchFeedPage('all', initialFeedState(ME))).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('reads group payments for payment_undone with the Contract A columns; names from profiles (no venmo)', async () => {
    fake.tables.set('group_payments', [{ id: PAY, from_user: SAM, to_user: ME, cents: 2500, method: 'venmo', group_id: G1 }]);
    const undone = groupEvent('payment_undone', { actor_id: SAM, details: { payment_id: PAY, undone_reason: 'sender' }, created_at: at(2) });
    setEvents([], [undone]);
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items.map((i) => [i.category, i.amountCents, i.counterpartId])).toEqual([['money', 2500, SAM]]);
    const [pq] = queriesOf('group_payments');
    expect(pq!.calls).toEqual([
      { method: 'select', args: ['id, from_user, to_user, cents', { count: 'exact' }] },
      { method: 'in', args: ['id', [PAY]] },
    ]);
    const [names] = queriesOf('profiles');
    expect(callsOf(names!, 'select')).toEqual([['id, display_name', { count: 'exact' }]]);
    expect(res.page.facts.names.get(SAM)).toBe('Sam');
  });

  it('names: a missing profile is absent (reads "Someone"), a blank one is kept as is', async () => {
    const ghost = '0f000000-0000-4000-8000-00000000000f';
    setEvents(
      [
        billEvent('joined', { actor_id: ghost, created_at: at(1) }),
        billEvent('joined', { actor_id: ANA, created_at: at(2) }),
      ],
      [],
    );
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.facts.names.has(ghost)).toBe(false);
    expect(res.page.facts.names.get(ANA)).toBe('  ');
    // The bill hosts are named too, for captions ("Maya's bill").
    expect(res.page.facts.names.get(MAYA)).toBe('Maya');
  });

  it('loads a snapshot only for a group with a group-settled candidate; a failed snapshot leaves it out', async () => {
    const rec = groupEvent('payment_recorded', {
      actor_id: SAM,
      details: { payment_id: PAY, from: SAM, to: ME, cents: 2500, method: 'venmo', source: 'manual' },
      created_at: at(3),
    });
    setEvents([], [rec, groupEvent('member_joined', { actor_id: ANA, created_at: at(1) })]);
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(mockSnapshot.mock.calls).toEqual([[G1]]);
    expect(res.page.facts.snapshots.size).toBe(0);
  });

  it('R6: loads the snapshot of a group whose expense line is on the page, so the expense title can show', async () => {
    const EXP = 'e1000000-0000-4000-8000-000000000001';
    const snapshot = { expenses: [{ id: EXP, title: 'Gas' }] } as unknown as GroupSnapshot; // only expenses is read here
    mockSnapshot.mockResolvedValue({ ok: true, snapshot });
    setEvents([], [groupEvent('expense_added', { actor_id: SAM, details: { expense_id: EXP, title: 'Gas', amount_cents: 6000 }, created_at: at(1) })]);
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items.map((i) => i.expenseId)).toEqual([EXP]);
    expect(mockSnapshot.mock.calls).toEqual([[G1]]);
    expect(res.page.facts.snapshots.get(G1)).toBe(snapshot);
    expect(res.page.viewFacts.snapshots.get(G1)).toBe(snapshot);
  });

  it('R6: a failed expense snapshot only drops the title; a group with no expense line loads none', async () => {
    const EXP = 'e1000000-0000-4000-8000-000000000001';
    setEvents([], [groupEvent('expense_added', { actor_id: SAM, details: { expense_id: EXP, title: 'Gas', amount_cents: 6000 }, created_at: at(1) })]);
    const res = await fetchFeedPage('all', initialFeedState(ME));
    if (!res.ok) throw new Error(res.error);
    expect(res.page.items).toHaveLength(1); // positive control: the line is still listed
    expect(res.page.facts.snapshots.size).toBe(0);

    mockSnapshot.mockClear();
    setEvents([], [groupEvent('member_joined', { actor_id: ANA, created_at: at(1) })]);
    forgetFeedPlaces();
    const res2 = await fetchFeedPage('all', initialFeedState(ME));
    if (!res2.ok) throw new Error(res2.error);
    expect(res2.page.items).toHaveLength(1);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Time limits (criterion 12)

describe('time limits (criterion 12)', () => {
  it('a call that never answers gives up at 15 s and reads as network; its late answer is ignored', async () => {
    expect(FEED_REQUEST_TIMEOUT_MS).toBe(GROUP_REQUEST_TIMEOUT_MS);
    expect(FEED_REQUEST_TIMEOUT_MS).toBe(15_000);
    jest.useFakeTimers();
    setEvents([billEvent('joined', { actor_id: SAM, created_at: at(1) })], []);
    let release: (a: Answer) => void = () => {};
    fake.override = () => new Promise<Answer>((r) => (release = r));
    let result: unknown;
    void fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 10).then((r) => (result = r));
    await jest.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ ok: false, error: 'network' });
    release({ data: [], error: null, count: 0 });
    await jest.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('the places read and the claims read time out too', async () => {
    jest.useFakeTimers();
    seedPlaces([{ id: B1, host: MAYA, group: null }], []);
    fake.override = (q, c) => (q.table === 'bill_participants' ? new Promise<Answer>(() => {}) : c);
    let r1: unknown;
    void loadFeedPlaces(ME).then((r) => (r1 = r));
    await jest.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS);
    expect(r1).toEqual({ ok: false, error: 'network' });

    fake.override = null;
    setEvents([billEvent('joined', { actor_id: SAM, created_at: at(1) })], []);
    mockSettle.mockImplementation(() => new Promise(() => {}));
    let r2: unknown;
    void fetchFeedPage('all', initialFeedState(ME)).then((r) => (r2 = r));
    await jest.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS * 3);
    expect(r2).toEqual({ ok: false, error: 'network' });
  });

  it('errors: 42501 → not_allowed, anything else → network', async () => {
    fake.override = () => ({ data: null, error: { code: '42501', message: 'x' } });
    await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 10)).resolves.toEqual({ ok: false, error: 'not_allowed' });
    fake.override = () => ({ data: null, error: { code: '57014', message: 'x' } });
    await expect(fetchEventPage('bill', [B1], FEED_BILL_KINDS, null, 10)).resolves.toEqual({ ok: false, error: 'network' });
  });

  it('newestOnly: only the newest request of a kind applies its answer', () => {
    const gate = newestOnly();
    const first = gate.begin();
    const second = gate.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
    gate.cancel();
    expect(second()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Badge inputs (Contract S "Badge reads", Contract G)

describe('fetchBadgeInputs and feedBadges', () => {
  const NOW = Date.parse('2026-11-28T12:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const recent = (hoursAgo: number) => `${iso(NOW - hoursAgo * 3_600_000).slice(0, 19)}.000000+00:00`;

  beforeEach(() => {
    seedPlaces(
      [
        { id: B1, host: MAYA, group: null },
        { id: B2, host: SAM, group: G1 },
      ],
      [group(G1), group(G2_HIDDEN, { hidden: true })],
    );
  });

  it('reads bill events since max(14-day floor, activity seen) and group events with the dot’s kinds, limit 1000', async () => {
    setEvents([], []);
    const seen: FeedSeen = { ...EMPTY_FEED_SEEN, activity: iso(NOW - DAY) };
    const res = await fetchBadgeInputs(ME, seen, NOW);
    expect(res.ok).toBe(true);
    const [bq] = queriesOf('bill_events');
    expect(callsOf(bq!, 'in')).toEqual([
      ['bill_id', [B1, B2]],
      ['kind', FEED_BILL_KINDS],
    ]);
    expect(callsOf(bq!, 'gt')).toEqual([['created_at', `${iso(NOW - DAY).slice(0, 19)}.000000Z`]]);
    expect(callsOf(bq!, 'limit')).toEqual([[FEED_MAX_LIMIT]]);
    expect(callsOf(bq!, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    const [gq] = queriesOf('group_events');
    expect(callsOf(gq!, 'in')).toEqual([
      ['group_id', [G1]],
      ['kind', FEED_GROUP_READ_KINDS],
    ]);
    // Groups: since the 14-day floor, or the earliest of each group's opened / joined time if later.
    expect(callsOf(gq!, 'gt')).toEqual([['created_at', `${iso(NOW - 14 * DAY).slice(0, 19)}.000000Z`]]);
  });

  it('counts unseen counted items per place, and the Groups dot, through classifyFeedEvent and the seen rule', async () => {
    setEvents(
      [
        billEvent('participant_added', { bill_id: B1, details: { user_id: ME }, created_at: recent(5) }),
        billEvent('assigned', { bill_id: B1, item_name: 'Tacos', details: { user_id: ME }, created_at: recent(4) }),
        billEvent('claimed', { bill_id: B2, actor_id: SAM, item_name: 'Pizza', created_at: recent(3) }), // roll-up: never counts
        billEvent('marked_paid', { bill_id: B2, actor_id: SAM, details: { payer_id: ME, cents: 990 }, created_at: recent(2) }),
      ],
      [groupEvent('member_left', { actor_id: ANA, created_at: recent(1) })],
    );
    const res = await fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(feedBadges(res.inputs, EMPTY_FEED_SEEN, NOW)).toEqual({ activity: 2, groupsDot: true });
    // B1 opened after its items: only B2 is left. G1 opened after member_left: no dot.
    const seen: FeedSeen = { activity: null, bills: { [B1]: iso(NOW - 3_600_000) }, groups: { [G1]: iso(NOW) } };
    expect(feedBadges(res.inputs, seen, NOW)).toEqual({ activity: 1, groupsDot: false });
  });

  it('loads claims only for bills with share-kind events (F-h, F-i, F-k), and uses them', async () => {
    setEvents(
      [
        billEvent('extras_split_changed', { bill_id: B1, details: { before: 'proportional', after: 'equal' }, created_at: recent(2) }),
        billEvent('joined', { bill_id: B2, actor_id: ANA, created_at: recent(1) }),
      ],
      [],
    );
    const row = { id: '10000000-0000-4000-8000-000000000001', name: 'Tacos' };
    mockSettle.mockImplementation(async (ids) => ({
      ok: true,
      bills: new Map(ids.map((id) => [id, { ...minimalBillData(id, MAYA), rows: [row], claims: [{ line_item_id: row.id, user_id: ME, parts: 1 }] } as unknown as BillData])),
    }));
    const res = await fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(mockSettle.mock.calls).toEqual([[[B1]]]);
    expect(feedBadges(res.inputs, EMPTY_FEED_SEEN, NOW).activity).toBe(1);
  });

  it('A1.1: a full page counts as "at least": the badge rounds up to 9+, never down; the dot lights', async () => {
    const many = Array.from({ length: FEED_MAX_LIMIT }, (_, i) =>
      billEvent('claimed', { bill_id: B1, actor_id: SAM, item_name: 'Fries', created_at: `${iso(NOW - 60_000 - i * 1000).slice(0, 19)}.000000+00:00` }),
    );
    setEvents(many, Array.from({ length: FEED_MAX_LIMIT }, (_, i) => groupEvent('renamed', { created_at: recent(1 + i / 1000) })));
    // renamed isn't in the read kinds: the fake filters it out, so make group rows full of members leaving instead.
    fake.tables.set(
      'group_events',
      Array.from({ length: FEED_MAX_LIMIT }, (_, i) => groupRow(groupEvent('member_joined', { actor_id: ME, created_at: `${iso(NOW - 60_000 - i * 1000).slice(0, 19)}.000000+00:00` }))),
    );
    const res = await fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.inputs.truncated).toEqual({ bill: true, group: true });
    expect(feedBadges(res.inputs, EMPTY_FEED_SEEN, NOW)).toEqual({ activity: 10, groupsDot: true });
  });

  it("R7: a full group read forces 9+ only when what it cut off can fall in Activity's unread window; the dot still lights", async () => {
    setEvents([], []);
    // 1000 group rows from 1 min to ~17.6 min ago (newest first), read from the 14-day floor; what was
    // cut off is older than the oldest row read.
    fake.tables.set(
      'group_events',
      Array.from({ length: FEED_MAX_LIMIT + 5 }, (_, i) =>
        groupRow(groupEvent('member_joined', { actor_id: ME, created_at: `${iso(NOW - 60_000 - i * 1000).slice(0, 19)}.000000+00:00` })),
      ),
    );
    // Activity seen 10 min ago, after the oldest row read: everything cut off is older, so it's all seen.
    const seenLater: FeedSeen = { ...EMPTY_FEED_SEEN, activity: iso(NOW - 10 * 60_000) };
    const res = await fetchBadgeInputs(ME, seenLater, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.inputs.truncated).toEqual({ bill: false, group: true });
    expect(feedBadges(res.inputs, seenLater, NOW)).toEqual({ activity: 0, groupsDot: true });
    // Positive control: Activity seen 30 min ago, before the oldest row read, so cut-off rows may be unread: "at least" (9+).
    const seenEarlier: FeedSeen = { ...EMPTY_FEED_SEEN, activity: iso(NOW - 30 * 60_000) };
    expect(feedBadges(res.inputs, seenEarlier, NOW)).toEqual({ activity: 10, groupsDot: true });
    // Never seen at all (the 14-day floor): may be unread too.
    expect(feedBadges(res.inputs, EMPTY_FEED_SEEN, NOW).activity).toBe(10);
  });

  it('R7: a full bill read always forces 9+ (it is read from the unread window itself)', async () => {
    const many = Array.from({ length: FEED_MAX_LIMIT }, (_, i) =>
      billEvent('claimed', { bill_id: B1, actor_id: SAM, item_name: 'Fries', created_at: `${iso(NOW - 60_000 - i * 1000).slice(0, 19)}.000000+00:00` }),
    );
    setEvents(many, []);
    const seen: FeedSeen = { ...EMPTY_FEED_SEEN, activity: iso(NOW - 30 * 60_000) };
    const res = await fetchBadgeInputs(ME, seen, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.inputs.truncated).toEqual({ bill: true, group: false });
    expect(feedBadges(res.inputs, seen, NOW)).toEqual({ activity: 10, groupsDot: false });
  });

  it('a cut-off or failed read fails closed (network), so the previous badges stay', async () => {
    setEvents([billEvent('joined', { bill_id: B1, actor_id: SAM, created_at: recent(1) })], []);
    fake.override = (q, c) => (q.table === 'bill_events' ? { ...c, count: 5 } : c);
    await expect(fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW)).resolves.toEqual({ ok: false, error: 'network' });
    fake.override = (q, c) => (q.table === 'group_events' ? { data: null, error: { code: '42501', message: 'x' } } : c);
    await expect(fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW)).resolves.toEqual({ ok: false, error: 'not_allowed' });
  });

  it('items older than the 14-day floor never count, even unread', async () => {
    setEvents([billEvent('participant_added', { bill_id: B1, details: { user_id: ME }, created_at: `${iso(NOW - 15 * DAY).slice(0, 19)}.000000+00:00` })], []);
    fake.override = (_q, c) => c; // the gt filter drops it in the fake
    const res = await fetchBadgeInputs(ME, EMPTY_FEED_SEEN, NOW);
    if (!res.ok) throw new Error(res.error);
    expect(res.inputs.billEvents).toEqual([]);
    expect(feedBadges(res.inputs, EMPTY_FEED_SEEN, NOW).activity).toBe(0);
  });
});
