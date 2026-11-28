// lib/useUsernameStatus: one my_username_status read per signed-in user, shared by every caller,
// with retry and a local "locked" after a pick (docs/specs/2026-11-28-usernames.md A3.6–A3.10).
// test-utils/jestSetup.ts mocks this module as "locked" for every other suite; this file tests the real one.
import { act, renderHook, waitFor } from '@testing-library/react-native';

import * as profile from '@/lib/profile';
import { markUsernameLocked, resetUsernameStatusForTests, useUsernameStatus } from '@/lib/useUsernameStatus';

jest.unmock('@/lib/useUsernameStatus');
jest.mock('@/lib/profile', () => ({ getMyUsername: jest.fn() }));

const getMyUsername = profile.getMyUsername as jest.MockedFunction<typeof profile.getMyUsername>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetUsernameStatusForTests();
});

describe('useUsernameStatus', () => {
  it('a null user id is idle and makes no read', () => {
    const { result } = renderHook(() => useUsernameStatus(null));
    expect(result.current.status).toBe('idle');
    expect(getMyUsername).not.toHaveBeenCalled();
  });

  it('loading, then ready with the username and whether it is locked', async () => {
    getMyUsername.mockResolvedValue({ ok: true, username: 'ana', locked: false });
    const { result } = renderHook(() => useUsernameStatus('u1'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', username: 'ana', locked: false }));
    expect(getMyUsername).toHaveBeenCalledTimes(1);
  });

  it('one read per user, shared by every caller and kept across remounts', async () => {
    getMyUsername.mockResolvedValue({ ok: true, username: 'ana', locked: true });
    const a = renderHook(() => useUsernameStatus('u1'));
    const b = renderHook(() => useUsernameStatus('u1'));
    await waitFor(() => expect(a.result.current.status).toBe('ready'));
    expect(b.result.current).toMatchObject({ status: 'ready', username: 'ana' });
    a.unmount();
    b.unmount();
    const c = renderHook(() => useUsernameStatus('u1'));
    expect(c.result.current).toMatchObject({ status: 'ready', username: 'ana', locked: true });
    expect(getMyUsername).toHaveBeenCalledTimes(1);
  });

  it('a failed read (error or the 15 s timeout, both { ok: false }) is an error; retry reads again', async () => {
    getMyUsername.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, username: 'ana', locked: true });
    const { result } = renderHook(() => useUsernameStatus('u1'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.retry());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', locked: true }));
    expect(getMyUsername).toHaveBeenCalledTimes(2);
  });

  it('markLocked sets it locked locally with the picked name, with no read', async () => {
    getMyUsername.mockResolvedValue({ ok: true, username: 'ana', locked: false });
    const { result } = renderHook(() => useUsernameStatus('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.markLocked('ana_s'));
    expect(result.current).toMatchObject({ status: 'ready', username: 'ana_s', locked: true });
    expect(getMyUsername).toHaveBeenCalledTimes(1);
  });

  it('markUsernameLocked for another user changes nothing', async () => {
    getMyUsername.mockResolvedValue({ ok: true, username: 'ana', locked: false });
    const { result } = renderHook(() => useUsernameStatus('u1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => markUsernameLocked('u2', 'bob'));
    expect(result.current).toMatchObject({ status: 'ready', username: 'ana', locked: false });
  });

  it('sign-out (null) clears it, and the next user gets their own read', async () => {
    getMyUsername
      .mockResolvedValueOnce({ ok: true, username: 'ana', locked: true })
      .mockResolvedValueOnce({ ok: true, username: 'bob', locked: false });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useUsernameStatus(id), {
      initialProps: { id: 'u1' as string | null },
    });
    await waitFor(() => expect(result.current).toMatchObject({ username: 'ana' }));
    rerender({ id: null });
    expect(result.current.status).toBe('idle');
    rerender({ id: 'u2' });
    // Never the previous user's answer, even for one render.
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', username: 'bob', locked: false }));
    expect(getMyUsername).toHaveBeenCalledTimes(2);
  });

  it('signing back in as the same user reads again (sign-out dropped the cached answer)', async () => {
    getMyUsername.mockResolvedValue({ ok: true, username: 'ana', locked: true });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useUsernameStatus(id), {
      initialProps: { id: 'u1' as string | null },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ id: null });
    rerender({ id: 'u1' });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(getMyUsername).toHaveBeenCalledTimes(2);
  });

  it('a late answer for a signed-out user is dropped', async () => {
    const late = deferred<Awaited<ReturnType<typeof profile.getMyUsername>>>();
    getMyUsername.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ ok: true, username: 'bob', locked: false });
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useUsernameStatus(id), {
      initialProps: { id: 'u1' as string | null },
    });
    rerender({ id: null });
    rerender({ id: 'u2' });
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', username: 'bob' }));
    await act(async () => late.resolve({ ok: true, username: 'ana', locked: true }));
    expect(result.current).toMatchObject({ status: 'ready', username: 'bob', locked: false });
  });

  it('a retry while a read is in flight drops the older answer', async () => {
    const first = deferred<Awaited<ReturnType<typeof profile.getMyUsername>>>();
    getMyUsername.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true, username: 'ana', locked: true });
    const { result } = renderHook(() => useUsernameStatus('u1'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', locked: true }));
    await act(async () => first.resolve({ ok: false }));
    expect(result.current).toMatchObject({ status: 'ready', locked: true });
  });
});
