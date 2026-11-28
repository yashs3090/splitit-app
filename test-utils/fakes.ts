import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import type { KeyValueStorage } from '@/lib/chunkedStorage';
import type { PaymentMethod } from '@/lib/paymentMethods';
import type { SettleMark, SettleNotReceived } from '@/lib/settle';
import type { BillPayment, BillPaymentFlag } from '@/lib/bills';

export type MemoryStorage = KeyValueStorage & { data: Map<string, string> };

export function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

/**
 * A mark as fetchBill parses it (docs/specs/2026-11-26-sent-via-venmo.md D7): `toUserId` is the
 * plan's payer, and the method defaults to 'other' (every mark made before that slice).
 */
export function fakeMark(cents: number, at: string, toUserId: string, method: PaymentMethod = 'other'): SettleMark {
  return { cents, at, method, toUserId };
}

/** A "Not received" flag (D4): the cleared mark's cents and method, owed to `toUserId`. */
export function fakeNotReceived(cents: number, toUserId: string, method: PaymentMethod = 'venmo'): SettleNotReceived {
  return { cents, method, toUserId };
}

/**
 * One `bill_payments` entry as fetchBill parses it (who-paid A1.3, A1.4): `fromId` paid `toId`
 * `cents`, recorded at `at` (kept as the database sent it). `planKey` null = made under an earlier
 * state. The id only needs to be unique per bill in lib tests; fetchBill's parse requires a uuid.
 */
export function fakePayment(
  id: string,
  fromId: string,
  toId: string,
  cents: number,
  at: string,
  method: PaymentMethod = 'venmo',
  planKey: string | null = null,
): BillPayment {
  return { id, fromId, toId, cents, method, planKey, at };
}

/** One `bill_payment_flags` row (not received): `toId` said `fromId`'s payment never arrived. */
export function fakePaymentFlag(fromId: string, toId: string, cents: number, method: PaymentMethod = 'venmo'): BillPaymentFlag {
  return { fromId, toId, cents, method };
}

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

export function fakeSession(fullName = 'Ada Lovelace'): Session {
  // Test double: only the fields the app reads are filled in.
  return {
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    user: { id: 'user-a', email: 'ada@example.com', user_metadata: { full_name: fullName } },
  } as unknown as Session;
}

/**
 * A minimal stand-in for `supabase.auth`: holds a session, notifies listeners, and
 * simulates the Google flow (signInWithOAuth → browser → exchangeCodeForSession).
 */
export function createFakeSupabase() {
  const listeners = new Set<Listener>();
  let session: Session | null = null;

  const emit = (event: AuthChangeEvent, next: Session | null) => {
    session = next;
    listeners.forEach((l) => l(event, next));
  };

  const auth = {
    getSession: jest.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: jest.fn((listener: Listener) => {
      listeners.add(listener);
      return { data: { subscription: { id: 'sub', callback: listener, unsubscribe: () => listeners.delete(listener) } } };
    }),
    signInWithOAuth: jest.fn(async () => ({
      data: { provider: 'google', url: 'http://127.0.0.1:54321/auth/v1/authorize?provider=google' },
      error: null,
    })),
    exchangeCodeForSession: jest.fn(async (_code: string) => {
      const next = fakeSession();
      emit('SIGNED_IN', next);
      return { data: { session: next, user: next.user }, error: null };
    }),
    signOut: jest.fn(async () => {
      emit('SIGNED_OUT', null);
      return { error: null };
    }),
  };

  const db = createFakeDb();
  const live = createFakeRealtime();

  return {
    auth,
    rpc: db.rpc,
    from: db.from,
    channel: live.channel,
    removeChannel: live.removeChannel,
    realtime: live.realtime,
    /** Test control: set the session that getSession() returns, without notifying. */
    __setInitialSession(next: Session | null) {
      session = next;
    },
    __listenerCount: () => listeners.size,
    __setRpc: db.__setRpc,
    __setTable: db.__setTable,
    __queries: db.__queries,
    __channels: live.__channels,
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

// ---------------------------------------------------------------------------
// Database fakes: rpc() and a chainable from() query builder.
// ---------------------------------------------------------------------------

/** The shape supabase-js returns for a failed request (a PostgrestError), as far as the app reads it. */
export type FakeDbError = { code?: string; message: string; details?: string | null; hint?: string | null };
/** `count` is what supabase-js returns for `.select(cols, { count: 'exact' })`; leave it out otherwise. */
export type FakeResult = { data: unknown; error: FakeDbError | null; count?: number | null };

/** One builder method call, e.g. `{ method: 'eq', args: ['bill_id', 'b1'] }`. */
export type QueryCall = { method: string; args: unknown[] };
export type RecordedQuery = { table: string; calls: QueryCall[] };

type RpcHandler = (fn: string, args: Record<string, unknown> | undefined) => FakeResult | Promise<FakeResult>;
type TableHandler = (query: RecordedQuery) => FakeResult | Promise<FakeResult>;

const BUILDER_METHODS = [
  'select',
  'update',
  'eq',
  'neq',
  'in',
  'is',
  'order',
  'limit',
  'range',
  'filter',
  'match',
  'single',
  'maybeSingle',
] as const;

/** A thenable builder: every method records itself and returns the builder; awaiting runs the table handler. */
export type FakeQueryBuilder = { [K in (typeof BUILDER_METHODS)[number]]: (...args: unknown[]) => FakeQueryBuilder } &
  PromiseLike<FakeResult>;

/**
 * Like PostgREST, a `.select(cols, { count: 'exact' })` read gets a `count`. A handler that leaves
 * `count` out gets `data.length` (an uncut response); one that sets `count` (even to null or
 * undefined) keeps its value, to fake a cut-off response or a missing count.
 */
function withCount(query: RecordedQuery, result: FakeResult): FakeResult {
  const select = query.calls.find((c) => c.method === 'select');
  const options = select?.args[1];
  const wantsCount = typeof options === 'object' && options !== null && (options as { count?: unknown }).count === 'exact';
  if (!wantsCount || 'count' in result || !Array.isArray(result.data)) return result;
  return { ...result, count: result.data.length };
}

/** The latest result of each read the legacy bridge reuses (see legacyLedgerHandler). */
type LegacyReads = { bills: Promise<FakeResult> | null; participants: Promise<FakeResult> | null };

/**
 * **Transitional (who-paid Task 5; delete once Tasks 9–10 move the router fixtures).** Many router
 * tests still seed "I paid" marks and not-received flags as the old `bill_participants` columns
 * (`settled_at`, `settled_cents`, `settled_method`, `not_received_*`). When a test sets no handler for
 * `bill_payments` / `bill_payment_flags`, this answers them from the same fetch's own `bills` and
 * `bill_participants` results (the latest of each, which fetchBill / fetchSettleData start before
 * their ledger reads), exactly as migration 4a-1's data copy would (A1.3):
 * - one entry per marked participant: from the participant to its bill's `payer_id`, `cents` =
 *   settled_cents, `method` = settled_method (or 'other'), `recorded_at` = settled_at, plan_key null,
 *   and the participant's user id as the entry id (one mark per participant, so unique);
 * - one flag per flagged participant, to `not_received_by`.
 * A mark on the payer's own row (no pair) is skipped, as 4a's self-check refuses it. It never calls a
 * handler again (handlers may hold or count reads), and records nothing in `__queries`. A test that
 * sets its own ledger handler never reaches this.
 */
function legacyLedgerHandler(table: string, reads: LegacyReads): TableHandler | undefined {
  if (table !== 'bill_payments' && table !== 'bill_payment_flags') return undefined;
  const { bills: billsRead, participants: peopleRead } = reads;
  if (!peopleRead) return undefined;
  return async () => {
    const settle = async (p: Promise<FakeResult> | null) => (p ? p.catch(() => null) : null);
    const people = await settle(peopleRead);
    if (!people || people.error || !Array.isArray(people.data)) return { data: [], error: null };
    const bills = await settle(billsRead);
    const billRows: Record<string, unknown>[] = !bills
      ? []
      : Array.isArray(bills.data)
        ? (bills.data as Record<string, unknown>[])
        : bills.data && typeof bills.data === 'object'
          ? [bills.data as Record<string, unknown>]
          : [];
    const payerOf = (billId: unknown): unknown =>
      (billId === undefined && billRows.length === 1 ? billRows[0] : billRows.find((b) => b.id === billId))?.payer_id;
    const out: Record<string, unknown>[] = [];
    for (const raw of people.data as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const withBill = r.bill_id === undefined ? {} : { bill_id: r.bill_id };
      if (table === 'bill_payments') {
        if (r.settled_at === null || r.settled_at === undefined) continue;
        const to = payerOf(r.bill_id);
        if (to === undefined || to === r.user_id) continue;
        out.push({
          id: r.user_id,
          from_user: r.user_id,
          to_user: to,
          cents: r.settled_cents,
          method: r.settled_method ?? 'other',
          plan_key: null,
          recorded_at: r.settled_at,
          ...withBill,
        });
      } else {
        if (r.not_received_cents === null || r.not_received_cents === undefined) continue;
        out.push({
          from_user: r.user_id,
          to_user: r.not_received_by,
          cents: r.not_received_cents,
          method: r.not_received_method,
          ...withBill,
        });
      }
    }
    return { data: out, error: null };
  };
}

/**
 * `rpc(fn, args)` resolves with whatever the handler set by `__setRpc` returns (default
 * `{ data: null, error: null }`). `from(table)` returns a chainable builder; awaiting it resolves
 * with the result set for that table by `__setTable` (default `{ data: [], error: null }`).
 * Every awaited query is recorded in `__queries` with its method calls, in order.
 */
export function createFakeDb() {
  let rpcHandler: RpcHandler = () => ({ data: null, error: null });
  const tables = new Map<string, TableHandler>();
  const queries: RecordedQuery[] = [];
  const legacyReads: LegacyReads = { bills: null, participants: null };

  const rpc = jest.fn(async (fn: string, args?: Record<string, unknown>) => rpcHandler(fn, args));

  const from = jest.fn((table: string): FakeQueryBuilder => {
    const query: RecordedQuery = { table, calls: [] };
    const builder = {} as FakeQueryBuilder;
    for (const method of BUILDER_METHODS) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }
    builder.then = (onFulfilled, onRejected) => {
      queries.push(query);
      const handler = tables.get(table) ?? legacyLedgerHandler(table, legacyReads) ?? (() => ({ data: [], error: null }));
      const result = Promise.resolve()
        .then(() => handler(query))
        .then((r) => withCount(query, r));
      // Remembered for the legacy bridge: the bill reads, and the participant reads that carry profiles
      // (fetchBill / fetchSettleData's), not the people-count read (`select('bill_id')`).
      if (table === 'bills') legacyReads.bills = result;
      const select = query.calls.find((c) => c.method === 'select')?.args[0];
      if (table === 'bill_participants' && typeof select === 'string' && select.includes('profile')) legacyReads.participants = result;
      return result.then(onFulfilled, onRejected);
    };
    return builder;
  });

  return {
    rpc,
    from,
    __setRpc(handler: RpcHandler) {
      rpcHandler = handler;
    },
    /** A fixed result, or a function of the recorded query (to answer by filter). */
    __setTable(table: string, result: FakeResult | TableHandler) {
      tables.set(table, typeof result === 'function' ? result : () => result);
    },
    __queries: queries,
  };
}

// ---------------------------------------------------------------------------
// Realtime fakes: channel(), removeChannel() and realtime.setAuth().
// ---------------------------------------------------------------------------

type BroadcastCallback = (message: unknown) => void;
type StatusCallback = (status: string, err?: Error) => void;

export type FakeChannel = {
  topic: string;
  params: unknown;
  on: jest.Mock<FakeChannel, [string, { event: string }, BroadcastCallback]>;
  subscribe: jest.Mock<FakeChannel, [StatusCallback?]>;
  removed: boolean;
  /** Test control: deliver a broadcast `event` with `payload`, as the server would. */
  __broadcast(event: string, payload?: unknown): void;
  /** Test control: report a subscribe status (SUBSCRIBED, CHANNEL_ERROR, TIMED_OUT, CLOSED). */
  __status(status: string, err?: Error): void;
};

/**
 * Like the real client, `channel(topic)` returns the existing channel for a topic until it is
 * removed, so tests catch code that would subscribe the same channel twice.
 */
export function createFakeRealtime() {
  const channels: FakeChannel[] = [];

  const channel = jest.fn((topic: string, params?: unknown): FakeChannel => {
    const existing = channels.find((c) => c.topic === topic && !c.removed);
    if (existing) return existing;

    const bindings: { event: string; cb: BroadcastCallback }[] = [];
    let statusCb: StatusCallback | undefined;
    const ch: FakeChannel = {
      topic,
      params,
      removed: false,
      on: jest.fn((type: string, filter: { event: string }, cb: BroadcastCallback) => {
        if (type === 'broadcast') bindings.push({ event: filter.event, cb });
        return ch;
      }),
      subscribe: jest.fn((cb?: StatusCallback) => {
        statusCb = cb;
        return ch;
      }),
      __broadcast(event, payload) {
        if (ch.removed) return;
        bindings
          .filter((b) => b.event === event)
          .forEach((b) => b.cb({ type: 'broadcast', event, payload }));
      },
      __status(status, err) {
        if (!ch.removed) statusCb?.(status, err);
      },
    };
    channels.push(ch);
    return ch;
  });

  const removeChannel = jest.fn(async (ch: FakeChannel) => {
    ch.removed = true;
    return 'ok' as const;
  });

  const realtime = { setAuth: jest.fn(async (_token?: string | null) => {}) };

  return { channel, removeChannel, realtime, __channels: channels };
}
