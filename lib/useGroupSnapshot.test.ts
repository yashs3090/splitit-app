// useGroupSnapshot's numbering (review R1, Amendment A4): a refetch that a newer one has superseded
// doesn't count as finished, so a screen waiting for "the refetch after my write" keeps waiting for
// the newer one instead of reading the ignored answer as a failure. R2: a read that never settles
// ends as a failed refetch after GROUP_REQUEST_TIMEOUT_MS.
import { act, renderHook } from '@testing-library/react-native';

import { snapshotOf, GROUP_ID } from '@/test-utils/groupSnapshotFixtures';
import { W1 } from '@/test-utils/groupFixtures';

import * as groups from './groups';
import { GROUP_REQUEST_TIMEOUT_MS, type GroupResult, type GroupSnapshot } from './groups';
import { useGroupSnapshot } from './useGroupSnapshot';

jest.mock('expo-router', () => ({
  // The hook's first load runs from its focus effect; a plain effect stands in for focus here.
  useFocusEffect: (cb: () => void) => jest.requireActual<typeof import('react')>('react').useEffect(cb, [cb]),
}));
jest.mock('./supabase', () => ({ supabase: {} }));
jest.mock('./groups', () => {
  const actual = jest.requireActual<typeof import('./groups')>('./groups');
  return { ...actual, fetchGroupSnapshot: jest.fn() };
});

const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;
type Answer = GroupResult<{ snapshot: GroupSnapshot }>;

/** Each read waits until the test answers it. */
function deferredReads() {
  const pending: ((a: Answer) => void)[] = [];
  fetchSnapshot.mockImplementation(() => new Promise<Answer>((resolve) => pending.push(resolve)));
  return pending;
}

const SNAP = snapshotOf(W1.input);
const ok: Answer = { ok: true, snapshot: SNAP };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useGroupSnapshot', () => {
  it('two overlapping refetches: the older answer counts as finished only once the newer one ends', async () => {
    const reads = deferredReads();
    const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
    await act(async () => reads[0]?.(ok));
    expect(result.current.version).toBe(1);
    expect(result.current.finished).toBe(1);

    // A write's refetch (2), then a focus refetch (3) before 2 answers.
    let mine = 0;
    act(() => {
      mine = result.current.refetch();
      result.current.refetch();
    });
    expect(mine).toBe(2);

    // 2 answers first: superseded, so it's ignored and doesn't count as finished.
    await act(async () => reads[1]?.(ok));
    expect(result.current.version).toBe(1);
    expect(result.current.finished).toBeLessThan(mine);

    // 3 lands: the waiter for 2 now sees version >= 2, i.e. landed, never "Couldn't refresh".
    await act(async () => reads[2]?.(ok));
    expect(result.current.version).toBe(3);
    expect(result.current.finished).toBe(3);
  });

  it('a superseded answer that arrives after the newer one changes nothing', async () => {
    const reads = deferredReads();
    const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
    await act(async () => reads[0]?.(ok));
    act(() => {
      result.current.refetch();
      result.current.refetch();
    });
    await act(async () => reads[2]?.(ok));
    expect(result.current.version).toBe(3);
    await act(async () => reads[1]?.({ ok: false, error: 'network' }));
    expect(result.current.version).toBe(3);
    expect(result.current.finished).toBe(3);
    expect(result.current.load.status).toBe('ready');
  });

  it('the newest refetch failing still ends the wait (finished passes version)', async () => {
    const reads = deferredReads();
    const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
    await act(async () => reads[0]?.(ok));
    act(() => {
      result.current.refetch();
    });
    await act(async () => reads[1]?.({ ok: false, error: 'network' }));
    expect(result.current.finished).toBe(2);
    expect(result.current.version).toBe(1);
    expect(result.current.load.status).toBe('ready');
  });

  it('R2: a read that never settles ends as a failed refetch after the time limit', async () => {
    jest.useFakeTimers();
    try {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      act(() => {
        result.current.refetch();
      });
      await act(async () => {
        jest.advanceTimersByTime(GROUP_REQUEST_TIMEOUT_MS - 1);
      });
      expect(result.current.finished).toBe(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(result.current.finished).toBe(2);
      expect(result.current.version).toBe(1);
      // A late answer to the timed-out read is ignored.
      await act(async () => reads[1]?.(ok));
      expect(result.current.version).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('R2: a first load that never settles shows the error state', async () => {
    jest.useFakeTimers();
    try {
      deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      expect(result.current.load.status).toBe('loading');
      await act(async () => {
        jest.advanceTimersByTime(GROUP_REQUEST_TIMEOUT_MS);
      });
      expect(result.current.load.status).toBe('error');
    } finally {
      jest.useRealTimers();
    }
  });

  // Delete group criterion 37 as amended by A2.9: a deleted group has no rows, so group_snapshot
  // answers 42501 (not_allowed). After a load, that means the group is gone.
  describe('deleted (delete group T4)', () => {
    const notAllowed: Answer = { ok: false, error: 'not_allowed' };

    it('ready, then a refetch answers not_allowed → deleted', async () => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      expect(result.current.load.status).toBe('ready');
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[1]?.(notAllowed));
      expect(result.current.load).toEqual({ status: 'deleted' });
      expect(result.current.finished).toBe(2);
    });

    it('a first load that answers not_allowed stays not_allowed (never loaded: not a member, or an old link)', async () => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(notAllowed));
      expect(result.current.load).toEqual({ status: 'not_allowed' });
    });

    it('ready → a failed refetch (kept ready) → not_allowed is still deleted', async () => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[1]?.({ ok: false, error: 'network' }));
      expect(result.current.load.status).toBe('ready');
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[2]?.(notAllowed));
      expect(result.current.load).toEqual({ status: 'deleted' });
    });

    it.each(['network', 'busy'] as const)('deleted stays deleted after a %s refetch, and after another not_allowed', async (error) => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[1]?.(notAllowed));
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[2]?.({ ok: false, error }));
      expect(result.current.load).toEqual({ status: 'deleted' });
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[3]?.(notAllowed));
      expect(result.current.load).toEqual({ status: 'deleted' });
    });

    it.each(['network', 'busy'] as const)('a %s refetch from ready keeps ready (as before)', async (error) => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      act(() => {
        result.current.refetch();
      });
      await act(async () => reads[1]?.({ ok: false, error }));
      expect(result.current.load.status).toBe('ready');
    });

    it('a superseded not_allowed answer is ignored (the newer ready wins)', async () => {
      const reads = deferredReads();
      const { result } = renderHook(() => useGroupSnapshot(GROUP_ID));
      await act(async () => reads[0]?.(ok));
      act(() => {
        result.current.refetch();
        result.current.refetch();
      });
      await act(async () => reads[2]?.(ok));
      await act(async () => reads[1]?.(notAllowed));
      expect(result.current.load.status).toBe('ready');
    });
  });
});
