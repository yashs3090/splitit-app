// Contract S (device-local seen state), criteria 13 and 14 of
// docs/specs/2026-11-28-tab-bar-and-activity.md. Expected values are worked out by hand from the spec.
import { createMemoryStorage, type MemoryStorage } from '@/test-utils/fakes';
import { B1, B2, G1, ME, SAM } from '@/test-utils/feedFixtures';

import { GROUP_REQUEST_TIMEOUT_MS } from './groups';
import {
  EMPTY_FEED_SEEN,
  FEED_FIRST_RUN_DAYS,
  feedSeenKey,
  feedUnreadSince,
  forgetFeedPlaces,
  isFeedItemSeen,
  markFeedSeen,
  onFeedSeenChange,
  readFeedSeen,
  rememberFeedPlaces,
  type FeedSeen,
} from './feedSeen';
import { storage as mockedStorage } from './storage';

jest.mock('./supabase', () => ({ supabase: {} }));
jest.mock('./storage', () => {
  const { createMemoryStorage: make } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: make() };
});

const store = mockedStorage as unknown as MemoryStorage;
const B3 = 'b3000000-0000-4000-8000-0000000000b3';
const G3 = '93000000-0000-4000-8000-000000000093';

const T0 = Date.parse('2026-11-28T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function stored(userId: string): FeedSeen | null {
  // The chunked native store isn't used under the web/memory mock: one key holds the JSON.
  const raw = store.data.get(feedSeenKey(userId));
  return raw === undefined ? null : (JSON.parse(raw) as FeedSeen);
}

beforeEach(() => {
  store.data.clear();
  forgetFeedPlaces();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('feedSeenKey', () => {
  it('is per user', () => {
    expect(feedSeenKey(ME)).toBe(`splitit.feedSeen.${ME}`);
  });
});

describe('markFeedSeen (criterion 13)', () => {
  it('writes only timestamps, under splitit.feedSeen.<userId>', async () => {
    await expect(markFeedSeen(ME, 'activity', null, T0)).resolves.toBe(true);
    await markFeedSeen(ME, 'bill', B1, T0 + 1);
    await markFeedSeen(ME, 'group', G1, T0 + 2);
    expect([...store.data.keys()]).toEqual([`splitit.feedSeen.${ME}`]);
    expect(stored(ME)).toEqual({
      activity: iso(T0),
      bills: { [B1]: iso(T0 + 1) },
      groups: { [G1]: iso(T0 + 2) },
    });
    // Nothing but ISO timestamps anywhere in the value.
    const s = stored(ME)!;
    const values = [s.activity, ...Object.values(s.bills), ...Object.values(s.groups)];
    for (const v of values) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Object.keys(s).sort()).toEqual(['activity', 'bills', 'groups']);
  });

  it('never moves a value backwards: an older now after a newer one keeps the newer', async () => {
    await markFeedSeen(ME, 'activity', null, T0 + 5000);
    await markFeedSeen(ME, 'activity', null, T0);
    await markFeedSeen(ME, 'bill', B1, T0 + 5000);
    await markFeedSeen(ME, 'bill', B1, T0 + 1);
    expect(stored(ME)?.activity).toBe(iso(T0 + 5000));
    expect(stored(ME)?.bills[B1]).toBe(iso(T0 + 5000));
    // A newer one still moves it forward.
    await markFeedSeen(ME, 'activity', null, T0 + 6000);
    expect(stored(ME)?.activity).toBe(iso(T0 + 6000));
  });

  it('prunes places that are no longer mine, keeping the one being written', async () => {
    await markFeedSeen(ME, 'bill', B1, T0);
    await markFeedSeen(ME, 'bill', B2, T0);
    await markFeedSeen(ME, 'group', G1, T0);
    await markFeedSeen(ME, 'group', G3, T0);
    // A later places read: I'm on B2 and in G1 only.
    rememberFeedPlaces(ME, [B2], [G1], T0 + 10);
    await markFeedSeen(ME, 'bill', B3, T0 + 20);
    expect(stored(ME)).toEqual({ activity: null, bills: { [B2]: iso(T0), [B3]: iso(T0 + 20) }, groups: { [G1]: iso(T0) } });
  });

  it('keeps a place written after the places read started (it may be newer than that list)', async () => {
    rememberFeedPlaces(ME, [B1], [], T0);
    await markFeedSeen(ME, 'bill', B3, T0 + 5); // joined after the read
    await markFeedSeen(ME, 'activity', null, T0 + 6);
    expect(stored(ME)?.bills).toEqual({ [B3]: iso(T0 + 5) });
  });

  it('without a known places list, prunes nothing', async () => {
    await markFeedSeen(ME, 'bill', B1, T0);
    await markFeedSeen(ME, 'bill', B2, T0);
    expect(Object.keys(stored(ME)!.bills).sort()).toEqual([B1, B2].sort());
  });

  it('swallows a storage failure: resolves false and throws nothing', async () => {
    jest.spyOn(store, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(markFeedSeen(ME, 'activity', null, T0)).resolves.toBe(false);
    expect(stored(ME)).toBeNull();
    jest.spyOn(store, 'getItem').mockRejectedValueOnce(new Error('locked'));
    await expect(markFeedSeen(ME, 'activity', null, T0)).resolves.toBe(false);
    // A read failure never overwrites what is stored with a fresh object.
    await markFeedSeen(ME, 'bill', B1, T0);
    jest.spyOn(store, 'getItem').mockRejectedValueOnce(new Error('locked'));
    await markFeedSeen(ME, 'group', G1, T0);
    expect(stored(ME)).toEqual({ activity: null, bills: { [B1]: iso(T0) }, groups: {} });
  });

  it('gives up on a storage write that never settles after the time limit, and resolves false', async () => {
    jest.useFakeTimers();
    jest.spyOn(store, 'setItem').mockImplementationOnce(() => new Promise<void>(() => {}));
    let result: boolean | undefined;
    void markFeedSeen(ME, 'activity', null, T0).then((r) => (result = r));
    await jest.advanceTimersByTimeAsync(GROUP_REQUEST_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  it('refuses a bad id or kind without writing', async () => {
    await expect(markFeedSeen(ME, 'bill', 'not-a-uuid', T0)).resolves.toBe(false);
    await expect(markFeedSeen(ME, 'group', null, T0)).resolves.toBe(false);
    await expect(markFeedSeen('', 'activity', null, T0)).resolves.toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('keeps both writes when two run at once (serialized per user)', async () => {
    await Promise.all([markFeedSeen(ME, 'bill', B1, T0), markFeedSeen(ME, 'group', G1, T0), markFeedSeen(ME, 'activity', null, T0)]);
    expect(stored(ME)).toEqual({ activity: iso(T0), bills: { [B1]: iso(T0) }, groups: { [G1]: iso(T0) } });
  });

  it('a second user on the same device (another key) sees none of the first user’s times', async () => {
    await markFeedSeen(ME, 'activity', null, T0);
    await markFeedSeen(ME, 'bill', B1, T0);
    await expect(readFeedSeen(SAM)).resolves.toEqual(EMPTY_FEED_SEEN);
    await markFeedSeen(SAM, 'bill', B2, T0 + 1);
    expect(stored(SAM)).toEqual({ activity: null, bills: { [B2]: iso(T0 + 1) }, groups: {} });
    expect(stored(ME)?.bills).toEqual({ [B1]: iso(T0) });
  });

  it('tells listeners after a successful write, not after a failed one', async () => {
    const heard: string[] = [];
    const off = onFeedSeenChange((u) => heard.push(u));
    await markFeedSeen(ME, 'activity', null, T0);
    jest.spyOn(store, 'setItem').mockRejectedValueOnce(new Error('x'));
    await markFeedSeen(ME, 'activity', null, T0 + 1);
    off();
    await markFeedSeen(ME, 'activity', null, T0 + 2);
    expect(heard).toEqual([ME]);
  });
});

describe('readFeedSeen', () => {
  it('reads what was written', async () => {
    await markFeedSeen(ME, 'bill', B1, T0);
    await expect(readFeedSeen(ME)).resolves.toEqual({ activity: null, bills: { [B1]: iso(T0) }, groups: {} });
  });

  it('nothing stored, or unreadable JSON, is the empty state', async () => {
    await expect(readFeedSeen(ME)).resolves.toEqual(EMPTY_FEED_SEEN);
    await store.setItem(feedSeenKey(ME), '{not json');
    await expect(readFeedSeen(ME)).resolves.toEqual(EMPTY_FEED_SEEN);
  });

  it('drops malformed entries and keeps good ones', async () => {
    await store.setItem(
      feedSeenKey(ME),
      JSON.stringify({ activity: 'yesterday', bills: { [B1]: iso(T0), nope: iso(T0), [B2]: 42 }, groups: [], extra: 'x' }),
    );
    await expect(readFeedSeen(ME)).resolves.toEqual({ activity: null, bills: { [B1]: iso(T0) }, groups: {} });
  });

  it('a failed or timed-out read is null (callers keep their previous badges)', async () => {
    jest.spyOn(store, 'getItem').mockRejectedValueOnce(new Error('locked'));
    await expect(readFeedSeen(ME)).resolves.toBeNull();
    jest.useFakeTimers();
    jest.spyOn(store, 'getItem').mockImplementationOnce(() => new Promise<string | null>(() => {}));
    let result: FeedSeen | null | undefined;
    void readFeedSeen(ME).then((r) => (result = r));
    await jest.advanceTimersByTimeAsync(GROUP_REQUEST_TIMEOUT_MS);
    expect(result).toBeNull();
  });
});

describe('isFeedItemSeen (criterion 14)', () => {
  const NOW = Date.parse('2026-11-28T12:00:00.000Z');
  const AT = '2026-11-27T19:42:00.000Z';
  const AT_MS = Date.parse(AT);
  const seen = (over: Partial<FeedSeen>): FeedSeen => ({ ...EMPTY_FEED_SEEN, ...over });
  const billItem = { at: AT, billId: B1, groupId: null };
  const groupBillItem = { at: AT, billId: B2, groupId: G1 };
  const groupItem = { at: AT, billId: null, groupId: G1 };

  it('an activity time equal to `at` is seen; 1 ms earlier is unseen', () => {
    expect(isFeedItemSeen(billItem, seen({ activity: iso(AT_MS) }), NOW)).toBe(true);
    expect(isFeedItemSeen(billItem, seen({ activity: iso(AT_MS - 1) }), NOW)).toBe(false);
    expect(isFeedItemSeen(groupItem, seen({ activity: iso(AT_MS) }), NOW)).toBe(true);
    expect(isFeedItemSeen(groupItem, seen({ activity: iso(AT_MS - 1) }), NOW)).toBe(false);
  });

  it('compares the event’s microseconds: an event 1 µs after the seen time is unseen', () => {
    const micro = { ...billItem, at: '2026-11-27T19:42:00.000001+00:00' };
    expect(isFeedItemSeen(micro, seen({ activity: iso(AT_MS) }), NOW)).toBe(false);
    expect(isFeedItemSeen({ ...billItem, at: '2026-11-27T19:42:00.000000+00:00' }, seen({ activity: iso(AT_MS) }), NOW)).toBe(true);
  });

  it('a bill time alone clears that bill’s items and milestones, but not group items', () => {
    const s = seen({ bills: { [B1]: iso(AT_MS), [B2]: iso(AT_MS) } });
    expect(isFeedItemSeen(billItem, s, NOW)).toBe(true);
    // A bill milestone is a bill item (billId set).
    expect(isFeedItemSeen({ at: AT, billId: B1, groupId: null }, s, NOW)).toBe(true);
    // A group bill's own events use the bill's time.
    expect(isFeedItemSeen(groupBillItem, s, NOW)).toBe(true);
    expect(isFeedItemSeen(groupItem, s, NOW)).toBe(false);
    // Another bill's time does nothing.
    expect(isFeedItemSeen(billItem, seen({ bills: { [B2]: iso(AT_MS + 1) } }), NOW)).toBe(false);
  });

  it('a group time alone clears that group’s items, but not its bills’ items', () => {
    const s = seen({ groups: { [G1]: iso(AT_MS) } });
    expect(isFeedItemSeen(groupItem, s, NOW)).toBe(true);
    expect(isFeedItemSeen(groupBillItem, s, NOW)).toBe(false);
    expect(isFeedItemSeen(groupItem, seen({ groups: { [G1]: iso(AT_MS - 1) } }), NOW)).toBe(false);
  });

  it('the later of activity and place time decides', () => {
    expect(isFeedItemSeen(billItem, seen({ activity: iso(AT_MS - 10), bills: { [B1]: iso(AT_MS) } }), NOW)).toBe(true);
    expect(isFeedItemSeen(billItem, seen({ activity: iso(AT_MS), bills: { [B1]: iso(AT_MS - 10) } }), NOW)).toBe(true);
  });

  it('first run (nothing stored): items older than 14 days count as seen, newer ones do not', () => {
    expect(FEED_FIRST_RUN_DAYS).toBe(14);
    const floor = NOW - 14 * 24 * 60 * 60 * 1000;
    expect(isFeedItemSeen({ ...billItem, at: iso(floor - 1) }, EMPTY_FEED_SEEN, NOW)).toBe(true);
    expect(isFeedItemSeen({ ...billItem, at: iso(floor) }, EMPTY_FEED_SEEN, NOW)).toBe(false);
    expect(isFeedItemSeen(billItem, EMPTY_FEED_SEEN, NOW)).toBe(false);
  });

  it('the 14-day floor also applies with an old stored activity time (same bound as the badge reads)', () => {
    const floor = NOW - 14 * 24 * 60 * 60 * 1000;
    const old = seen({ activity: iso(floor - 60_000) });
    expect(isFeedItemSeen({ ...billItem, at: iso(floor - 1) }, old, NOW)).toBe(true);
    expect(isFeedItemSeen({ ...billItem, at: iso(floor + 1) }, old, NOW)).toBe(false);
  });

  it('an unreadable time never counts as unseen', () => {
    expect(isFeedItemSeen({ ...billItem, at: 'soon' }, EMPTY_FEED_SEEN, NOW)).toBe(true);
  });
});

describe('feedUnreadSince', () => {
  const NOW = Date.parse('2026-11-28T12:00:00.000Z');
  const FLOOR = NOW - 14 * 24 * 60 * 60 * 1000;
  it('is the 14-day floor on first run, else the later of the floor and the activity time', () => {
    expect(feedUnreadSince(EMPTY_FEED_SEEN, NOW)).toBe(FLOOR);
    expect(feedUnreadSince({ ...EMPTY_FEED_SEEN, activity: iso(NOW - 1000) }, NOW)).toBe(NOW - 1000);
    expect(feedUnreadSince({ ...EMPTY_FEED_SEEN, activity: iso(FLOOR - 1000) }, NOW)).toBe(FLOOR);
  });
});
