import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

import type { KeyValueStorage } from '@/lib/chunkedStorage';

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
export type FakeResult = { data: unknown; error: FakeDbError | null };

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
 * `rpc(fn, args)` resolves with whatever the handler set by `__setRpc` returns (default
 * `{ data: null, error: null }`). `from(table)` returns a chainable builder; awaiting it resolves
 * with the result set for that table by `__setTable` (default `{ data: [], error: null }`).
 * Every awaited query is recorded in `__queries` with its method calls, in order.
 */
export function createFakeDb() {
  let rpcHandler: RpcHandler = () => ({ data: null, error: null });
  const tables = new Map<string, TableHandler>();
  const queries: RecordedQuery[] = [];

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
      const handler = tables.get(table) ?? (() => ({ data: [], error: null }));
      return Promise.resolve()
        .then(() => handler(query))
        .then(onFulfilled, onRejected);
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
