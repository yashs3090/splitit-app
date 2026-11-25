// lib/profile.ts: criteria 19–24 and 26 in docs/specs/2026-11-24-profile-venmo.md (Task 3).
import { type FakeResult, type FakeSupabase, type RecordedQuery } from '@/test-utils/fakes';

import { dismissVenmoPrompt, getMyProfile, isVenmoPromptPending, saveVenmoUsername } from './profile';
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
