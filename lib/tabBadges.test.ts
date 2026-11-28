// lib/tabBadges.ts (docs/specs/2026-11-28-tab-bar-and-activity.md Task 7, criteria 35–36, A1.1, A1.3).
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { fakeMark } from '@/test-utils/fakes';

import * as activityFeed from './activityFeed';
import type { BillSummary } from './bills';
import * as feedSeen from './feedSeen';
import { homeRowView, homeSections, type HomeRowView, type HomeSettleFacts } from './homeSections';
import { settlePlan, type BillSettlePlan, type SettleMarks } from './settle';
import type { SplitClaim, SplitInput, SplitItem } from './split';
import {
  FEED_SEEN_REFRESH_DELAY_MS,
  loadFeedBadges,
  NO_FEED_BADGES,
  publishTabsBadge,
  resetTabsBadge,
  tabsBadgeCount,
  useFeedBadges,
  useTabsBadge,
} from './tabBadges';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('./activityFeed', () => {
  const actual = jest.requireActual<typeof import('./activityFeed')>('./activityFeed');
  return { ...actual, fetchBadgeInputs: jest.fn(), feedBadges: jest.fn() };
});
jest.mock('./feedSeen', () => {
  const actual = jest.requireActual<typeof import('./feedSeen')>('./feedSeen');
  return { ...actual, readFeedSeen: jest.fn() };
});

const fetchInputs = activityFeed.fetchBadgeInputs as jest.MockedFunction<typeof activityFeed.fetchBadgeInputs>;
const badgesOf = activityFeed.feedBadges as jest.MockedFunction<typeof activityFeed.feedBadges>;
const readSeen = feedSeen.readFeedSeen as jest.MockedFunction<typeof feedSeen.readFeedSeen>;

const ME = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HOST = 'bbbbbbbb-0000-4000-8000-00000000000a';
const DEE = 'bbbbbbbb-0000-4000-8000-00000000000c';
const OTHER = 'bbbbbbbb-0000-4000-8000-00000000000d';
const AT = '2026-11-25T10:00:00Z';

// ---------------------------------------------------------------------------------------------
// Rows built through homeRowView (as lib/homeSections.test.ts)

let n = 0;
function summary(over: Partial<BillSummary> = {}): BillSummary {
  n += 1;
  return {
    id: `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`,
    hostId: HOST,
    hostName: 'Hana',
    payerId: HOST,
    totalCents: 4480,
    createdAt: '2026-11-20T19:00:00Z',
    joinedAt: '2026-11-20T19:05:00Z',
    added: false,
    seen: false,
    claimedAny: false,
    complete: false,
    seenAt: null,
    ...over,
  };
}
const guestBill = (over: Partial<BillSummary> = {}) => summary({ seen: true, claimedAny: true, complete: true, ...over });
const myBill = (over: Partial<BillSummary> = {}) => summary({ hostId: ME, payerId: ME, seen: true, complete: true, ...over });
const cl = (itemId: string, userId: string): SplitClaim => ({ itemId, userId, parts: 1 });
const nameOf = () => 'Someone';
const facts = (plan: BillSettlePlan): HomeSettleFacts => ({ plan, nameOf });
const planOf = (input: SplitInput, payerId: string, marks: SettleMarks = {}) => settlePlan(input, payerId, marks, { allowEarly: true, notReceived: {} });
function bill(items: SplitItem[], claims: SplitClaim[]): SplitInput {
  return { totalCents: items.reduce((s, i) => s + i.totalCents, 0), items, claims, participantIds: [HOST, ME, DEE], extrasMode: 'proportional' };
}
/** Hana 1000 and me 1480; Hana pays. */
const guestSplit = () => bill([{ id: 'h', totalCents: 1000 }, { id: 'm', totalCents: 1480 }], [cl('h', HOST), cl('m', ME)]);
/** I pay: me 1000, Hana 500, Dee 300. */
const iPay = () =>
  bill(
    [{ id: 'm', totalCents: 1000 }, { id: 'h', totalCents: 500 }, { id: 'd', totalCents: 300 }],
    [cl('m', ME), cl('h', HOST), cl('d', DEE)],
  );

const row = (s: BillSummary, f?: HomeSettleFacts) => homeRowView(s, ME, f, 3, () => 'Nov 20');
/** A guest who hasn't claimed yet, plan not loaded: Waiting on you → Items to claim. */
const claimRow = () => row(summary({ seen: true, claimedAny: false }));
const payRow = () => row(guestBill(), facts(planOf(guestSplit(), HOST)));
const owedRow = () => row(myBill(), facts(planOf(iPay(), ME)));
const settledRow = () =>
  row(myBill(), facts(planOf(iPay(), ME, { [HOST]: fakeMark(500, AT, ME, 'venmo'), [DEE]: fakeMark(300, AT, ME, 'venmo') })));
const hiddenRow = () => row(guestBill(), facts(planOf(guestSplit(), HOST, { [ME]: fakeMark(1480, AT, HOST) })));

describe('tabsBadgeCount (criterion 35, A1.3)', () => {
  it('the fixtures land where the test says (positive controls)', () => {
    expect([claimRow().group, claimRow().waitingFor]).toEqual(['waiting', 'claim']);
    expect([payRow().group, payRow().waitingFor]).toEqual(['waiting', 'pay']);
    expect(owedRow().group).toBe('owed');
    expect(settledRow().group).toBe('settled');
    expect(hiddenRow().group).toBe('hidden');
  });

  it('A1.3: one bill in claim, one in pay and one in owed gives 3 (waiting is never added)', () => {
    const s = homeSections([claimRow(), payRow(), owedRow()]);
    expect(s.waiting).toHaveLength(2); // the same rows as claim + pay
    expect(tabsBadgeCount(s)).toBe(3);
  });

  it('settled and hidden bills never count', () => {
    const s = homeSections([claimRow(), payRow(), owedRow(), settledRow(), settledRow(), hiddenRow(), hiddenRow()]);
    expect(s.settled).toHaveLength(2);
    expect(s.hiddenCount).toBe(2);
    expect(tabsBadgeCount(s)).toBe(3);
  });

  it('nothing open gives 0 (no badge)', () => {
    expect(tabsBadgeCount(homeSections([settledRow(), hiddenRow()]))).toBe(0);
    expect(tabsBadgeCount(homeSections<HomeRowView>([]))).toBe(0);
  });

  it('counts each bill once, even if it appears in two sections', () => {
    const r = payRow();
    expect(tabsBadgeCount({ claim: [r], pay: [r], owed: [r] })).toBe(1);
  });

  it('9 open bills give 9 and 10 give 10 (badgeText makes it "9+")', () => {
    const nine = Array.from({ length: 9 }, (_, i) => (i % 3 === 0 ? claimRow() : i % 3 === 1 ? payRow() : owedRow()));
    expect(tabsBadgeCount(homeSections(nine))).toBe(9);
    expect(tabsBadgeCount(homeSections([...nine, owedRow()]))).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------------
// The store Home writes

describe('publishTabsBadge / useTabsBadge', () => {
  afterEach(() => act(() => resetTabsBadge()));

  it('is 0 until Home publishes, then follows each publish', () => {
    const { result } = renderHook(() => useTabsBadge(ME));
    expect(result.current).toBe(0);
    act(() => publishTabsBadge(ME, 4));
    expect(result.current).toBe(4);
    act(() => publishTabsBadge(ME, 0));
    expect(result.current).toBe(0);
  });

  it("another user never sees the last user's count", () => {
    act(() => publishTabsBadge(ME, 4));
    const { result } = renderHook(() => useTabsBadge(OTHER));
    expect(result.current).toBe(0);
    const signedOut = renderHook(() => useTabsBadge(''));
    expect(signedOut.result.current).toBe(0);
  });

  it('ignores a signed-out publish and a bad count', () => {
    const { result } = renderHook(() => useTabsBadge(ME));
    act(() => publishTabsBadge('', 5));
    expect(result.current).toBe(0);
    act(() => publishTabsBadge(ME, Number.NaN));
    expect(result.current).toBe(0);
    act(() => publishTabsBadge(ME, -2));
    expect(result.current).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The Activity count and the Groups dot

const SEEN: feedSeen.FeedSeen = { activity: null, bills: {}, groups: {} };
const INPUTS = { truncated: { bill: false, group: false } } as unknown as activityFeed.FeedBadgeInputs; // feedBadges is mocked
const ok = (): Awaited<ReturnType<typeof activityFeed.fetchBadgeInputs>> => ({ ok: true, inputs: INPUTS });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending promise callbacks run. */
const flush = () => act(async () => {});

beforeEach(() => {
  jest.useRealTimers();
  fetchInputs.mockReset();
  badgesOf.mockReset();
  readSeen.mockReset();
  readSeen.mockResolvedValue(SEEN);
  fetchInputs.mockImplementation(async () => ok());
  badgesOf.mockReturnValue({ activity: 3, groupsDot: true });
});

describe('loadFeedBadges', () => {
  it('reads seen, then the inputs, then feedBadges with the same seen and time', async () => {
    await expect(loadFeedBadges(ME, () => 1234)).resolves.toEqual({ activity: 3, groupsDot: true });
    expect(fetchInputs).toHaveBeenCalledWith(ME, SEEN, 1234);
    expect(badgesOf).toHaveBeenCalledWith(INPUTS, SEEN, 1234);
  });

  it.each([
    ['a failed seen read', () => readSeen.mockResolvedValue(null)],
    ['a throwing seen read', () => readSeen.mockRejectedValue(new Error('x'))],
    ['a network failure', () => fetchInputs.mockResolvedValue({ ok: false, error: 'network' })],
    ['a not-allowed failure', () => fetchInputs.mockResolvedValue({ ok: false, error: 'not_allowed' })],
    ['a throwing read', () => fetchInputs.mockRejectedValue(new Error('x'))],
  ])('%s gives null (keep the previous badges)', async (_name, arrange) => {
    arrange();
    await expect(loadFeedBadges(ME)).resolves.toBeNull();
  });

  it('signed out reads nothing', async () => {
    await expect(loadFeedBadges('')).resolves.toBeNull();
    expect(readSeen).not.toHaveBeenCalled();
  });

  it('gives up after FEED_REQUEST_TIMEOUT_MS (Contract T)', async () => {
    jest.useFakeTimers();
    fetchInputs.mockReturnValue(new Promise(() => {}));
    const p = loadFeedBadges(ME);
    await jest.advanceTimersByTimeAsync(activityFeed.FEED_REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toBeNull();
  });

  it('a seen read that never answers also gives up', async () => {
    jest.useFakeTimers();
    readSeen.mockReturnValue(new Promise(() => {}));
    const p = loadFeedBadges(ME);
    await jest.advanceTimersByTimeAsync(activityFeed.FEED_REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toBeNull();
    expect(fetchInputs).not.toHaveBeenCalled();
  });
});

describe('useFeedBadges (criterion 36)', () => {
  const appStateListeners: ((s: string) => void)[] = [];
  beforeEach(() => {
    appStateListeners.length = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, l) => {
      if (type === 'change') appStateListeners.push(l as (s: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('refreshes on mount', async () => {
    const { result } = renderHook(() => useFeedBadges(ME, 'index'));
    expect(result.current).toEqual(NO_FEED_BADGES);
    await flush();
    expect(result.current).toEqual({ activity: 3, groupsDot: true });
    expect(fetchInputs).toHaveBeenCalledTimes(1);
  });

  it('refreshes on every tab change', async () => {
    const { result, rerender } = renderHook(({ tab }: { tab: string }) => useFeedBadges(ME, tab), { initialProps: { tab: 'index' } });
    await flush();
    badgesOf.mockReturnValue({ activity: 1, groupsDot: false });
    rerender({ tab: 'groups' });
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ activity: 1, groupsDot: false });
  });

  it('refreshes when the app comes to the foreground (active only)', async () => {
    renderHook(() => useFeedBadges(ME, 'index'));
    await flush();
    act(() => appStateListeners.forEach((l) => l('background')));
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(1);
    act(() => appStateListeners.forEach((l) => l('active')));
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(2);
  });

  it("refreshes after markFeedSeen for this user (the real listener), FEED_SEEN_REFRESH_DELAY_MS later, not another user's", async () => {
    expect(FEED_SEEN_REFRESH_DELAY_MS).toBe(2000);
    jest.useFakeTimers();
    const { result } = renderHook(() => useFeedBadges(ME, 'index'));
    await flush();
    await act(async () => {
      await feedSeen.markFeedSeen(OTHER, 'activity');
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(1);
    badgesOf.mockReturnValue({ activity: 0, groupsDot: false });
    await act(async () => {
      await feedSeen.markFeedSeen(ME, 'activity');
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FEED_SEEN_REFRESH_DELAY_MS - 1);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(1); // trailing: not yet
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ activity: 0, groupsDot: false });
  });

  it('R4: a burst of seen writes (an open bill getting realtime versions) gives one trailing refresh', async () => {
    jest.useFakeTimers();
    renderHook(() => useFeedBadges(ME, 'index'));
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(1);
    const BILL = 'b1000000-0000-4000-8000-0000000000b1';
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await feedSeen.markFeedSeen(ME, 'bill', BILL);
        await jest.advanceTimersByTimeAsync(500);
      });
    }
    expect(fetchInputs).toHaveBeenCalledTimes(1); // each write pushed the refresh back
    await act(async () => {
      await jest.advanceTimersByTimeAsync(FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10 * FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(2);
  });

  it('R4: a tab change while a seen refresh is waiting refreshes at once and drops the wait', async () => {
    jest.useFakeTimers();
    const { rerender } = renderHook(({ tab }: { tab: string }) => useFeedBadges(ME, tab), { initialProps: { tab: 'index' } });
    await flush();
    await act(async () => {
      await feedSeen.markFeedSeen(ME, 'activity');
    });
    rerender({ tab: 'groups' });
    await flush();
    expect(fetchInputs).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2 * FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(2);
  });

  it('R4: a seen refresh still waiting at unmount never runs', async () => {
    jest.useFakeTimers();
    const { unmount } = renderHook(() => useFeedBadges(ME, 'index'));
    await flush();
    await act(async () => {
      await feedSeen.markFeedSeen(ME, 'activity');
    });
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2 * FEED_SEEN_REFRESH_DELAY_MS);
    });
    expect(fetchInputs).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the previous badges', async () => {
    const { result, rerender } = renderHook(({ tab }: { tab: string }) => useFeedBadges(ME, tab), { initialProps: { tab: 'index' } });
    await flush();
    fetchInputs.mockResolvedValue({ ok: false, error: 'network' });
    rerender({ tab: 'activity' });
    await flush();
    expect(result.current).toEqual({ activity: 3, groupsDot: true });
  });

  it('a timed-out refresh keeps the previous badges', async () => {
    const { result, rerender } = renderHook(({ tab }: { tab: string }) => useFeedBadges(ME, tab), { initialProps: { tab: 'index' } });
    await flush();
    jest.useFakeTimers();
    fetchInputs.mockReturnValue(new Promise(() => {}));
    rerender({ tab: 'activity' });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(activityFeed.FEED_REQUEST_TIMEOUT_MS + 1);
    });
    expect(result.current).toEqual({ activity: 3, groupsDot: true });
  });

  it('a late answer is ignored: only the newest request applies', async () => {
    const first = deferred<Awaited<ReturnType<typeof activityFeed.fetchBadgeInputs>>>();
    const second = deferred<Awaited<ReturnType<typeof activityFeed.fetchBadgeInputs>>>();
    fetchInputs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    badgesOf.mockReturnValueOnce({ activity: 2, groupsDot: false }).mockReturnValueOnce({ activity: 7, groupsDot: true });
    const { result, rerender } = renderHook(({ tab }: { tab: string }) => useFeedBadges(ME, tab), { initialProps: { tab: 'index' } });
    await flush();
    rerender({ tab: 'groups' });
    await flush();
    second.resolve(ok()); // the newer one answers first: 2
    await flush();
    expect(result.current).toEqual({ activity: 2, groupsDot: false });
    first.resolve(ok()); // the older one lands late: ignored
    await flush();
    expect(result.current).toEqual({ activity: 2, groupsDot: false });
  });

  it('a different user starts from no badges and never sees the last user’s', async () => {
    const { result, rerender } = renderHook(({ id }: { id: string }) => useFeedBadges(id, 'index'), { initialProps: { id: ME } });
    await flush();
    expect(result.current).toEqual({ activity: 3, groupsDot: true });
    const pending = deferred<Awaited<ReturnType<typeof activityFeed.fetchBadgeInputs>>>();
    fetchInputs.mockReturnValue(pending.promise);
    rerender({ id: OTHER });
    expect(result.current).toEqual(NO_FEED_BADGES);
    rerender({ id: '' });
    expect(result.current).toEqual(NO_FEED_BADGES);
    pending.resolve(ok()); // OTHER's answer lands after sign-out: still nothing shown
    await flush();
    expect(result.current).toEqual(NO_FEED_BADGES);
  });

  it('an answer that lands after unmount does nothing', async () => {
    const late = deferred<Awaited<ReturnType<typeof activityFeed.fetchBadgeInputs>>>();
    fetchInputs.mockReturnValueOnce(late.promise);
    const { result, unmount } = renderHook(() => useFeedBadges(ME, 'index'));
    unmount();
    late.resolve(ok());
    await flush();
    expect(result.current).toEqual(NO_FEED_BADGES);
  });
});
