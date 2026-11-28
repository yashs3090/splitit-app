// lib/profile.ts: criteria 19–24 and 26 in docs/specs/2026-11-24-profile-venmo.md (Task 3).
import { type FakeResult, type FakeSupabase, type RecordedQuery } from '@/test-utils/fakes';

import {
  dismissVenmoPrompt,
  getMyProfile,
  getMyUsername,
  isVenmoPromptPending,
  saveVenmoUsername,
  setUsername,
  USERNAME_REQUEST_TIMEOUT_MS,
  usernamesAvailable,
} from './profile';
import { supabase as realSupabase } from './supabase';

jest.mock('./supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const ME = 'bbbbbbbb-0000-4000-8000-00000000000a';

const calls = (q: RecordedQuery) => q.calls.map((c) => [c.method, ...c.args]);
const lastQuery = (): RecordedQuery => {
  const q = supabase.__queries[supabase.__queries.length - 1];
  if (!q) throw new Error('no query was made');
  return q;
};

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  supabase.__setTable('profiles', { data: [], error: null });
  supabase.__setRpc(() => ({ data: null, error: null }));
});

describe('getMyProfile', () => {
  it('19: makes the D3 read and maps the row', async () => {
    supabase.__setTable('profiles', { data: { display_name: 'Ada', venmo_username: 'Ada-L' }, error: null });
    await expect(getMyProfile(ME)).resolves.toEqual({ ok: true, displayName: 'Ada', venmoUsername: 'Ada-L' });
    const q = lastQuery();
    expect(q.table).toBe('profiles');
    expect(calls(q)).toEqual([['select', 'display_name, venmo_username'], ['eq', 'id', ME], ['single']]);
  });

  it('nulls come through as null', async () => {
    supabase.__setTable('profiles', { data: { display_name: null, venmo_username: null }, error: null });
    await expect(getMyProfile(ME)).resolves.toEqual({ ok: true, displayName: null, venmoUsername: null });
  });

  it('19: an error maps to { ok: false }', async () => {
    supabase.__setTable('profiles', { data: null, error: { code: 'PGRST116', message: 'no rows' } });
    await expect(getMyProfile(ME)).resolves.toEqual({ ok: false });
  });

  it('a malformed row maps to { ok: false }', async () => {
    supabase.__setTable('profiles', { data: { display_name: 7, venmo_username: null }, error: null });
    await expect(getMyProfile(ME)).resolves.toEqual({ ok: false });
  });

  it('a thrown request maps to { ok: false }', async () => {
    supabase.__setTable('profiles', () => Promise.reject(new Error('network')));
    await expect(getMyProfile(ME)).resolves.toEqual({ ok: false });
  });
});

describe('saveVenmoUsername', () => {
  it('20: normalizes, sends the D3 update and returns the stored value', async () => {
    supabase.__setTable('profiles', { data: [{ venmo_username: 'Jane-Doe_99' }], error: null });
    await expect(saveVenmoUsername(ME, '  @Jane-Doe_99 ', null)).resolves.toEqual({
      ok: true,
      value: 'Jane-Doe_99',
      changed: true,
    });
    const q = lastQuery();
    expect(q.table).toBe('profiles');
    expect(calls(q)).toEqual([
      ['update', { venmo_username: 'Jane-Doe_99' }],
      ['eq', 'id', ME],
      ['select', 'venmo_username'],
    ]);
  });

  it('20: the returned value (not the typed one) is the new baseline', async () => {
    supabase.__setTable('profiles', { data: [{ venmo_username: 'server-side' }], error: null });
    await expect(saveVenmoUsername(ME, 'typed-one', null)).resolves.toEqual({
      ok: true,
      value: 'server-side',
      changed: true,
    });
  });

  it.each(['', '   ', '@'])('21: %j clears the username (update to null)', async (input) => {
    supabase.__setTable('profiles', { data: [{ venmo_username: null }], error: null });
    await expect(saveVenmoUsername(ME, input, 'old-name')).resolves.toEqual({ ok: true, value: null, changed: true });
    expect(calls(lastQuery())[0]).toEqual(['update', { venmo_username: null }]);
  });

  it.each(['abcd', 'abc.de', '@@abcde'])('22: invalid %j makes no call', async (input) => {
    await expect(saveVenmoUsername(ME, input, null)).resolves.toEqual({ ok: false, reason: 'invalid' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('22: a value that normalizes to current makes no call', async () => {
    await expect(saveVenmoUsername(ME, ' @abcde ', 'abcde')).resolves.toEqual({
      ok: true,
      value: 'abcde',
      changed: false,
    });
    await expect(saveVenmoUsername(ME, '', null)).resolves.toEqual({ ok: true, value: null, changed: false });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('a different case is a change (case is kept, never compared case-insensitively)', async () => {
    supabase.__setTable('profiles', { data: [{ venmo_username: 'ABCDE' }], error: null });
    await expect(saveVenmoUsername(ME, 'ABCDE', 'abcde')).resolves.toEqual({ ok: true, value: 'ABCDE', changed: true });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  const failures: [string, FakeResult | (() => Promise<FakeResult>), string][] = [
    ['23514 check violation', { data: null, error: { code: '23514', message: 'check' } }, 'invalid'],
    ['42501 permission denied', { data: null, error: { code: '42501', message: 'denied' } }, 'not_allowed'],
    ['zero rows', { data: [], error: null }, 'not_allowed'],
    ['null data', { data: null, error: null }, 'not_allowed'],
    ['two rows', { data: [{ venmo_username: 'abcde' }, { venmo_username: 'abcde' }], error: null }, 'error'],
    ['a malformed row', { data: [{ venmo_username: 42 }], error: null }, 'error'],
    ['another error', { data: null, error: { code: '08006', message: 'connection' } }, 'error'],
    ['an error with no code', { data: null, error: { message: 'Failed to fetch' } }, 'error'],
    ['a thrown request', () => Promise.reject(new Error('network')), 'error'],
  ];
  it.each(failures)('23: %s → %s', async (_name, result, reason) => {
    supabase.__setTable('profiles', result);
    await expect(saveVenmoUsername(ME, 'abcde', null)).resolves.toEqual({ ok: false, reason });
  });
});

describe('Venmo prompt state', () => {
  it('24: pending only when the RPC returns data === true', async () => {
    supabase.__setRpc(() => ({ data: true, error: null }));
    await expect(isVenmoPromptPending()).resolves.toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith('venmo_prompt_pending');
  });

  it.each<[string, FakeResult]>([
    ['false', { data: false, error: null }],
    ['null', { data: null, error: null }],
    ['a string', { data: 'true', error: null }],
    ['a number', { data: 1, error: null }],
    ['an error', { data: true, error: { code: '42501', message: 'denied' } }],
  ])('24: %s fails closed (false)', async (_name, result) => {
    supabase.__setRpc(() => result);
    await expect(isVenmoPromptPending()).resolves.toBe(false);
  });

  it('24: a thrown RPC fails closed', async () => {
    supabase.__setRpc(() => Promise.reject(new Error('network')));
    await expect(isVenmoPromptPending()).resolves.toBe(false);
  });

  it('24: dismissVenmoPrompt calls the RPC with no args', async () => {
    await expect(dismissVenmoPrompt()).resolves.toEqual({ ok: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['dismiss_venmo_prompt']);
  });

  it('dismissVenmoPrompt reports a failure', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'connection' } }));
    await expect(dismissVenmoPrompt()).resolves.toEqual({ ok: false });
    supabase.__setRpc(() => Promise.reject(new Error('network')));
    await expect(dismissVenmoPrompt()).resolves.toEqual({ ok: false });
  });
});

// Usernames: criteria 17 and 18 in docs/specs/2026-11-28-usernames.md (Task 2, contract L), as
// amended by A3 (pick once, then locked).
describe('getMyUsername', () => {
  it('17 (A3): calls my_username_status once and maps username and locked', async () => {
    supabase.__setRpc(() => ({ data: [{ username: 'yash_s', locked: false }], error: null }));
    await expect(getMyUsername()).resolves.toEqual({ ok: true, username: 'yash_s', locked: false });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['my_username_status']);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('17 (A3): a locked username maps locked: true', async () => {
    supabase.__setRpc(() => ({ data: [{ username: 'yash_s', locked: true }], error: null }));
    await expect(getMyUsername()).resolves.toEqual({ ok: true, username: 'yash_s', locked: true });
  });

  it.each<[string, FakeResult | (() => Promise<FakeResult>)]>([
    // A1.5: username is NOT NULL, so a null from the server is malformed, not "no username yet".
    ['a null username', { data: [{ username: null, locked: false }], error: null }],
    ['an error', { data: null, error: { code: '42501', message: 'permission denied' } }],
    ['a number', { data: [{ username: 7, locked: false }], error: null }],
    ['a missing username', { data: [{ locked: false }], error: null }],
    ['a missing locked', { data: [{ username: 'yash_s' }], error: null }],
    ['a non-boolean locked', { data: [{ username: 'yash_s', locked: 'true' }], error: null }],
    ['no rows (signed out or no profile)', { data: [], error: null }],
    ['two rows', { data: [{ username: 'a_b', locked: false }, { username: 'c_d', locked: false }], error: null }],
    ['a bare object instead of rows', { data: { username: 'yash_s', locked: false }, error: null }],
    ['a null row', { data: [null], error: null }],
    ['null data', { data: null, error: null }],
    ['a thrown request', () => Promise.reject(new Error('network'))],
  ])('17: %s maps to { ok: false }', async (_name, result) => {
    supabase.__setRpc(typeof result === 'function' ? result : () => result);
    await expect(getMyUsername()).resolves.toEqual({ ok: false });
  });

  describe('timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a request that never settles maps to { ok: false } after 15 000 ms, not before', async () => {
      supabase.__setRpc(() => new Promise<FakeResult>(() => {}));
      let settled: unknown = 'pending';
      void getMyUsername().then((r) => {
        settled = r;
      });
      await jest.advanceTimersByTimeAsync(USERNAME_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a reply just inside the limit still counts', async () => {
      supabase.__setRpc(
        () => new Promise<FakeResult>((resolve) => setTimeout(() => resolve({ data: [{ username: 'yash_s', locked: true }], error: null }), USERNAME_REQUEST_TIMEOUT_MS - 1)),
      );
      const p = getMyUsername();
      await jest.advanceTimersByTimeAsync(USERNAME_REQUEST_TIMEOUT_MS - 1);
      await expect(p).resolves.toEqual({ ok: true, username: 'yash_s', locked: true });
    });
  });
});

describe('setUsername', () => {
  it.each([
    ['ab', 'too_short'],
    ['a'.repeat(21), 'too_long'],
    ['yash-s', 'invalid_chars'],
    ['ya..sh', 'bad_dots'],
    [' @ADMIN ', 'reserved'],
  ])('18: invalid %j makes no request and returns %s', async (input, reason) => {
    await expect(setUsername(input, null)).resolves.toEqual({ ok: false, reason });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('A3.1: input that normalizes to current is still sent, because picking it locks it', async () => {
    supabase.__setRpc(() => ({ data: 'yash_s', error: null }));
    await expect(setUsername(' @Yash_S ', 'yash_s')).resolves.toEqual({ ok: true, value: 'yash_s', changed: false });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['set_username', { p_username: 'yash_s' }]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('18: otherwise calls set_username once with the normalized value and returns the DB value', async () => {
    supabase.__setRpc(() => ({ data: 'yash_s', error: null }));
    await expect(setUsername(' @Yash_S ', 'old_name')).resolves.toEqual({ ok: true, value: 'yash_s', changed: true });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['set_username', { p_username: 'yash_s' }]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('18: success from null with changed: true', async () => {
    supabase.__setRpc(() => ({ data: 'abc', error: null }));
    await expect(setUsername('abc', null)).resolves.toEqual({ ok: true, value: 'abc', changed: true });
  });

  const failures: [string, FakeResult | (() => Promise<FakeResult>), string][] = [
    ['23505', { data: null, error: { code: '23505', message: 'username_taken' } }, 'taken'],
    ['22023 username_reserved', { data: null, error: { code: '22023', message: 'username_reserved' } }, 'reserved'],
    ['22023 username_invalid', { data: null, error: { code: '22023', message: 'username_invalid' } }, 'invalid'],
    ['22023 other message', { data: null, error: { code: '22023', message: 'something else' } }, 'invalid'],
    ['23514', { data: null, error: { code: '23514', message: 'check' } }, 'invalid'],
    ['42501 not_allowed', { data: null, error: { code: '42501', message: 'not_allowed' } }, 'not_allowed'],
    ['42501 username_locked (A3.2)', { data: null, error: { code: '42501', message: 'username_locked' } }, 'locked'],
    ['42501 other message', { data: null, error: { code: '42501', message: 'permission denied' } }, 'not_allowed'],
    ['an unknown code', { data: null, error: { code: '08006', message: 'connection' } }, 'error'],
    ['an error with no code', { data: null, error: { message: 'Failed to fetch' } }, 'error'],
    ['a thrown request', () => Promise.reject(new Error('network')), 'error'],
    ['a non-string value', { data: 42, error: null }, 'error'],
    ['null data', { data: null, error: null }, 'error'],
    ['a string that fails V', { data: 'Yash', error: null }, 'error'],
    ['a reserved string', { data: 'admin', error: null }, 'error'],
  ];
  it.each(failures)('18: %s → %s', async (_name, result, reason) => {
    supabase.__setRpc(typeof result === 'function' ? result : () => result);
    await expect(setUsername('abcde', null)).resolves.toEqual({ ok: false, reason });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  describe('timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('18: the limit is 15 000 ms (UN-9)', () => {
      expect(USERNAME_REQUEST_TIMEOUT_MS).toBe(15_000);
    });

    it('18: a request that never settles returns error after 15 000 ms, not before', async () => {
      supabase.__setRpc(() => new Promise<FakeResult>(() => {}));
      let settled: unknown = 'pending';
      void setUsername('abcde', null).then((r) => {
        settled = r;
      });
      await jest.advanceTimersByTimeAsync(USERNAME_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false, reason: 'error' });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

// Amendment A3.4: availability for suggestions.
describe('usernamesAvailable', () => {
  it('calls usernames_available once with the candidates and returns the free ones', async () => {
    supabase.__setRpc(() => ({ data: ['yash_s123', 'yash_s4567'], error: null }));
    await expect(usernamesAvailable(['yash_s123', 'yash_s999', 'yash_s4567'])).resolves.toEqual({
      ok: true,
      available: ['yash_s123', 'yash_s4567'],
    });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0]).toEqual(['usernames_available', { p_candidates: ['yash_s123', 'yash_s999', 'yash_s4567'] }]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('none free is an empty list, not a failure', async () => {
    supabase.__setRpc(() => ({ data: [], error: null }));
    await expect(usernamesAvailable(['abc'])).resolves.toEqual({ ok: true, available: [] });
  });

  it('an empty list makes no request', async () => {
    await expect(usernamesAvailable([])).resolves.toEqual({ ok: true, available: [] });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('10 candidates are sent; 11 are refused with no request (the database takes at most 10)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `name_${i}`);
    supabase.__setRpc(() => ({ data: [], error: null }));
    await expect(usernamesAvailable(ten)).resolves.toEqual({ ok: true, available: [] });
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    supabase.rpc.mockClear();
    await expect(usernamesAvailable([...ten, 'name_10'])).resolves.toEqual({ ok: false });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, FakeResult | (() => Promise<FakeResult>)]>([
    ['an error', { data: null, error: { code: '42501', message: 'not_allowed' } }],
    ['22023 too_many_candidates', { data: null, error: { code: '22023', message: 'too_many_candidates' } }],
    ['null data', { data: null, error: null }],
    ['a non-array', { data: 'abc', error: null }],
    ['a non-string element', { data: [7], error: null }],
    ['a name that was not sent', { data: ['someone_else'], error: null }],
    ['a thrown request', () => Promise.reject(new Error('network'))],
  ])('%s maps to { ok: false }', async (_name, result) => {
    supabase.__setRpc(typeof result === 'function' ? result : () => result);
    await expect(usernamesAvailable(['abc', 'abd'])).resolves.toEqual({ ok: false });
  });

  describe('timeout', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a request that never settles fails after 15 000 ms, not before', async () => {
      supabase.__setRpc(() => new Promise<FakeResult>(() => {}));
      let settled: unknown = 'pending';
      void usernamesAvailable(['abc']).then((r) => {
        settled = r;
      });
      await jest.advanceTimersByTimeAsync(USERNAME_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ ok: false });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
