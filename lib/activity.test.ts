import { createFakeDb, type FakeDbError, type RecordedQuery } from '@/test-utils/fakes';

import { ACTIVITY_LIMIT, fetchActivity, type ActivityClient } from './activity';

const BILL = '11111111-2222-4333-8444-555555555555';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const PAT = 'bbbbbbbb-0000-4000-8000-00000000000b';
const E1 = 'eeeeeeee-0000-4000-8000-000000000001';
const E2 = 'eeeeeeee-0000-4000-8000-000000000002';
const SERVER_TEXT = 'permission denied for table bill_events (ada@example.com)';

function setup() {
  const db = createFakeDb();
  // Test double: the fake builder covers every method fetchActivity calls.
  const client = db as unknown as ActivityClient;
  return { db, client };
}

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: E1,
  actor_id: PAT,
  kind: 'claimed',
  item_name: 'Fries',
  details: { unit: null, split: null },
  created_at: '2026-11-21T19:42:00.123456+00:00',
  ...over,
});

const participants = [
  { user_id: HOST, profile: { display_name: 'Hana Lee' } },
  { user_id: PAT, profile: null },
];

function okTables(db: ReturnType<typeof createFakeDb>, events: unknown[], people: unknown = participants) {
  db.__setTable('bill_events', { data: events, error: null });
  db.__setTable('bill_participants', { data: people, error: null });
}

const query = (queries: RecordedQuery[], table: string) => queries.find((q) => q.table === table);

describe('fetchActivity', () => {
  it('reads the newest events for the bill, newest first with ties ordered by id, capped at 200', async () => {
    const { db, client } = setup();
    okTables(db, [eventRow()]);
    const res = await fetchActivity(client, BILL);
    expect(res.ok).toBe(true);
    const q = query(db.__queries, 'bill_events');
    expect(q?.calls).toEqual([
      { method: 'select', args: ['id, actor_id, kind, item_name, details, created_at'] },
      { method: 'eq', args: ['bill_id', BILL] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [ACTIVITY_LIMIT] },
    ]);
    expect(ACTIVITY_LIMIT).toBe(200);
    const p = query(db.__queries, 'bill_participants');
    expect(p?.calls).toEqual([
      { method: 'select', args: ['user_id, profile:profiles!bill_participants_user_id_fkey(display_name)'] },
      { method: 'eq', args: ['bill_id', BILL] },
    ]);
  });

  it('maps rows to ActivityEvent and participants with display names (null when hidden)', async () => {
    const { db, client } = setup();
    okTables(db, [eventRow(), eventRow({ id: E2, actor_id: null, kind: 'joined', item_name: null, details: {} })]);
    const res = await fetchActivity(client, BILL);
    expect(res).toEqual({
      ok: true,
      events: [
        {
          id: E1,
          kind: 'claimed',
          actorId: PAT,
          itemName: 'Fries',
          details: { unit: null, split: null },
          createdAt: '2026-11-21T19:42:00.123456+00:00',
        },
        { id: E2, kind: 'joined', actorId: null, itemName: null, details: {}, createdAt: '2026-11-21T19:42:00.123456+00:00' },
      ],
      participants: [
        { userId: HOST, displayName: 'Hana Lee' },
        { userId: PAT, displayName: null },
      ],
    });
  });

  it('passes unknown kinds and odd details through (describeEvent skips them)', async () => {
    const { db, client } = setup();
    okTables(db, [eventRow({ kind: 'confetti', details: 'not an object' })]);
    const res = await fetchActivity(client, BILL);
    expect(res.ok && res.events[0]?.kind).toBe('confetti');
  });

  it('is not_found for a non-UUID id without querying', async () => {
    const { db, client } = setup();
    expect(await fetchActivity(client, 'nope')).toEqual({ ok: false, error: 'not_found' });
    expect(db.__queries).toHaveLength(0);
  });

  it('is not_found when RLS returns no participants (not in the bill, or no such bill)', async () => {
    const { db, client } = setup();
    okTables(db, [], []);
    expect(await fetchActivity(client, BILL)).toEqual({ ok: false, error: 'not_found' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['non-uuid id', { id: 'e1' }],
    ['non-uuid actor', { actor_id: 'pat' }],
    ['numeric kind', { kind: 3 }],
    ['empty kind', { kind: '' }],
    ['numeric item name', { item_name: 12 }],
    ['missing details', { details: undefined }],
    ['unparseable time', { created_at: 'yesterday' }],
    ['numeric time', { created_at: 1700000000 }],
  ])('a malformed event (%s) is network, never coerced', async (_label, over) => {
    const { db, client } = setup();
    okTables(db, [eventRow(over)]);
    expect(await fetchActivity(client, BILL)).toEqual({ ok: false, error: 'network' });
  });

  it.each<[string, unknown, unknown]>([
    ['events not an array', { id: E1 }, participants],
    ['participant id not a uuid', [eventRow()], [{ user_id: 'x', profile: null }]],
    ['display name not a string', [eventRow()], [{ user_id: HOST, profile: { display_name: 5 } }]],
    ['profile not an object', [eventRow()], [{ user_id: HOST, profile: 'Hana' }]],
  ])('malformed data (%s) is network', async (_label, events, people) => {
    const { db, client } = setup();
    db.__setTable('bill_events', { data: events, error: null });
    db.__setTable('bill_participants', { data: people, error: null });
    expect(await fetchActivity(client, BILL)).toEqual({ ok: false, error: 'network' });
  });

  it.each<[string, FakeDbError, string]>([
    ['42501', { code: '42501', message: SERVER_TEXT }, 'not_allowed'],
    ['other SQLSTATE', { code: '08006', message: SERVER_TEXT }, 'network'],
    ['no SQLSTATE', { code: '', message: 'TypeError: Failed to fetch' }, 'network'],
  ])('errors map to a fixed code (%s), never the server text', async (_label, error, expected) => {
    const { db, client } = setup();
    okTables(db, []);
    db.__setTable('bill_events', { data: null, error });
    const res = await fetchActivity(client, BILL);
    expect(res).toEqual({ ok: false, error: expected });
    expect(JSON.stringify(res)).not.toContain('ada@example.com');
  });

  it('a thrown request is network', async () => {
    const { db, client } = setup();
    db.__setTable('bill_participants', () => {
      throw new Error(SERVER_TEXT);
    });
    expect(await fetchActivity(client, BILL)).toEqual({ ok: false, error: 'network' });
  });
});
