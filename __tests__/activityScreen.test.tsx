// The Activity screen (docs/specs/2026-11-28-tab-bar-and-activity.md Task 8; Contracts C and M;
// criteria 39, 40, 42–51; A1.1). Router tests on native and with Platform.OS = 'web'.
//
// Mocked at the edges the screen calls: fetchFeedPage (lib/activityFeed) and the storage-backed
// readFeedSeen / markFeedSeen (lib/feedSeen). Everything between (classifyFeedEvent's items from the
// shared fixtures, feedView, isFeedItemSeen, rollUp, the wording) is real, so the lines read exactly
// as the app shows them. The bill and group screens are stand-ins (only where a tap goes matters).
import { router as globalRouter, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import type { ReactElement } from 'react';
import { AppState, Platform, StyleSheet, Text, type TextStyle, type ViewStyle } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import ActivityRoute from '@/app/(app)/(tabs)/activity';
import * as activityFeed from '@/lib/activityFeed';
import type { FeedPage, FeedResult } from '@/lib/activityFeed';
import { classifyFeedEvent, type FeedEventRow, type FeedFilter, type FeedItem } from '@/lib/feedRules';
import * as feedSeen from '@/lib/feedSeen';
import { EMPTY_FEED_SEEN, type FeedSeen } from '@/lib/feedSeen';
import type { FeedViewFacts } from '@/lib/feedView';
import { colors } from '@/lib/theme';
import {
  ANA,
  B1,
  billEvent,
  F_CASES,
  FEED_BILLS,
  FEED_GROUPS,
  FEED_NAMES,
  feedCtx,
  G1,
  groupEvent,
  ME,
  NO_CLAIMS,
  SAM,
} from '@/test-utils/feedFixtures';

jest.mock('@/lib/supabase', () => ({ supabase: {} }));
jest.mock('@/lib/auth', () => ({
  useSession: () => ({ session: { user: { id: '0e000000-0000-4000-8000-000000000001' } }, loading: false, oauthError: null }),
}));
jest.mock('@/lib/activityFeed', () => {
  const actual = jest.requireActual<typeof import('@/lib/activityFeed')>('@/lib/activityFeed');
  return { ...actual, fetchFeedPage: jest.fn() };
});
jest.mock('@/lib/feedSeen', () => {
  const actual = jest.requireActual<typeof import('@/lib/feedSeen')>('@/lib/feedSeen');
  return { ...actual, readFeedSeen: jest.fn(), markFeedSeen: jest.fn() };
});

const fetchPage = activityFeed.fetchFeedPage as jest.MockedFunction<typeof activityFeed.fetchFeedPage>;
const readSeen = feedSeen.readFeedSeen as jest.MockedFunction<typeof feedSeen.readFeedSeen>;
const markSeen = feedSeen.markFeedSeen as jest.MockedFunction<typeof feedSeen.markFeedSeen>;

// ----- items: classified from the shared fixtures, at times in the last hour (so "Today") -----
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ctx = feedCtx(NO_CLAIMS);
function item(event: FeedEventRow, at: string): FeedItem {
  const it = classifyFeedEvent({ ...event, id: event.id, created_at: at } as FeedEventRow, ctx);
  if (it === null) throw new Error(`fixture ${event.kind} isn't a feed line`);
  return it;
}
const ADDED = item(F_CASES['F-a'].met, ago(5)); // needs_you: "Maya added you. Claim what you had" on B1
const PAID = item(F_CASES['F-c'].met, ago(10)); // money: "Sam marked $18.20 paid to you" on B1
const JOINED_G1 = item(groupEvent('member_joined', { actor_id: ANA }), ago(30)); // a roll-up item alone, on G1
const CLAIM_A = item(billEvent('claimed', { actor_id: SAM, item_name: 'Fries' }), ago(40));
const CLAIM_B = item(billEvent('claimed', { actor_id: ANA, item_name: 'Soda' }), ago(41));

const ADDED_TEXT = 'Maya added you. Claim what you had';
const PAID_TEXT = 'Sam marked $18.20 paid to you';

const FACTS: FeedViewFacts = {
  myId: ME,
  names: new Map(Object.entries(FEED_NAMES)),
  bills: FEED_BILLS,
  groupNames: new Map([[G1, 'Tahoe']]),
  billData: new Map(),
  snapshots: new Map(),
};

let pageN = 0;
function page(items: FeedItem[], end: boolean): FeedResult<{ page: FeedPage }> {
  pageN += 1;
  const state = { ...activityFeed.initialFeedState(ME), pageSize: 1000 + pageN }; // a marker: which page this state came from
  return {
    ok: true,
    page: {
      state,
      rows: [],
      items,
      candidates: [],
      viewFacts: FACTS,
      end,
      ctx,
      places: { bills: FEED_BILLS, groups: FEED_GROUPS, groupNames: FACTS.groupNames },
      facts: { bills: new Map(), payments: new Map(), names: FACTS.names, snapshots: new Map() },
    },
  };
}
const FAIL: FeedResult<{ page: FeedPage }> = { ok: false, error: 'network' };

/** A promise the test resolves by hand (an answer in flight). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function BillStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill stand-in ${id}`}</Text>;
}
function GroupStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Group stand-in ${id}`}</Text>;
}
const ROUTES: Record<string, () => ReactElement> = {
  activity: ActivityRoute,
  'bills/[id]': BillStandIn,
  'groups/[id]': GroupStandIn,
};
const openActivity = () => renderRouter(ROUTES, { initialUrl: '/activity' });

/** Markers and dots are hidden from screen readers, so queries must ask for hidden elements. */
const HIDDEN = { includeHiddenElements: true } as const;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const press = async (el: ReactTestInstance) => {
  await act(async () => {
    fireEvent.press(el);
  });
};
const endReached = async () => {
  await act(async () => {
    fireEvent(screen.getByTestId('activity-list'), 'endReached');
  });
};
const lineButton = (text: string) => screen.getByRole('button', { name: new RegExp(text.replace(/[$.]/g, '\\$&')) });
const unreadLabel = (sentence: string, place: string) => new RegExp(`^Unread\\. ${sentence.replace(/[$.]/g, '\\$&')}\\. ${place}\\. \\d`);

beforeEach(() => {
  jest.clearAllMocks();
  pageN = 0;
  readSeen.mockResolvedValue(EMPTY_FEED_SEEN);
  markSeen.mockResolvedValue(true);
});

describe.each(['ios', 'web'] as const)('Activity screen (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('39: while the first page loads, a spinner labelled "Loading activity" under the title', async () => {
    const d = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(d.promise);
    openActivity();
    expect(await screen.findByLabelText('Loading activity')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Activity' })).toBeTruthy();
    await act(async () => d.resolve(page([ADDED], true)));
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.queryByLabelText('Loading activity')).toBeNull();
  });

  it('50: the pull-to-refresh control stays mounted while loading (keeps chip focus on web), but a pull then does nothing', async () => {
    const d = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(d.promise);
    openActivity();
    await screen.findByLabelText('Loading activity');
    const control = screen.getByTestId('activity-list').props.refreshControl;
    expect(control).toBeTruthy();
    expect(control.props.enabled).toBe(false);
    await act(async () => control.props.onRefresh());
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(page([ADDED], true)));
    await screen.findByText(ADDED_TEXT);
    expect(screen.getByTestId('activity-list').props.refreshControl.props.enabled).toBe(true);
  });

  it('40: a failed first load shows the error with Try again, which refetches; markFeedSeen never runs after it', async () => {
    fetchPage.mockResolvedValueOnce(FAIL).mockResolvedValueOnce(page([ADDED], true));
    openActivity();
    expect(await screen.findByText("Couldn't load your activity.")).toBeTruthy();
    expect(screen.getByText("Couldn't load your activity.").props.accessibilityRole).toBe('alert');
    expect(markSeen).not.toHaveBeenCalled();
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // 47: the first successful page of this focus marks Activity seen, once.
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
    expect(markSeen).toHaveBeenCalledWith(ME, 'activity', null, expect.any(Number));
  });

  it('40: not_allowed reads the same as a network failure', async () => {
    fetchPage.mockResolvedValueOnce({ ok: false, error: 'not_allowed' });
    openActivity();
    expect(await screen.findByText("Couldn't load your activity.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it.each([
    ['all', 'All', 'Nothing new. When someone adds you to a receipt or pays you, it shows up here.'],
    ['money', 'Money', 'No money activity yet.'],
    ['groups', 'Groups', 'No group activity yet.'],
  ] as const)('42: the empty copy for %s', async (filter, chip, copy) => {
    fetchPage.mockResolvedValue(page([], true));
    openActivity();
    if (filter !== 'all') {
      await screen.findByText('Nothing new. When someone adds you to a receipt or pays you, it shows up here.');
      await press(screen.getByRole('radio', { name: chip }));
    }
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(fetchPage).toHaveBeenLastCalledWith(filter, expect.anything());
    expect(screen.queryByText("That's everything.")).toBeNull(); // the empty copy says it already
  });

  it('43: lines under their day header, newest first, with marker, sentence, caption and (unseen) the dot', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED, PAID, JOINED_G1], true));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Today' })).toBeTruthy();
    const labels = screen
      .getAllByRole('button')
      .map((b) => String(b.props.accessibilityLabel ?? ''))
      .filter((l) => l.startsWith('Unread.'));
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(unreadLabel(ADDED_TEXT, "Maya's bill"));
    expect(labels[1]).toMatch(unreadLabel(PAID_TEXT, "Maya's bill"));
    expect(labels[2]).toMatch(/^Unread\. Ana joined.*\. Tahoe\. \d/);
    expect(screen.getAllByText(/^Maya's bill · \d/)).toHaveLength(2);
    expect(screen.getAllByTestId('feed-unread-dot', HIDDEN)).toHaveLength(3);
    // Contract M while unread: needs_you amber, money green, a roll-up neutral.
    expect(screen.getByTestId('feed-marker-needs_you', HIDDEN)).toBeTruthy();
    expect(screen.getByTestId('feed-marker-money', HIDDEN)).toBeTruthy();
    expect(screen.getByTestId('feed-marker-neutral', HIDDEN)).toBeTruthy();
    // 50: marker and dot are hidden from screen readers.
    for (const el of [screen.getByTestId('feed-marker-money', HIDDEN), screen.getAllByTestId('feed-unread-dot', HIDDEN)[0]!]) {
      expect(el.props.importantForAccessibility).toBe('no-hide-descendants');
      expect(el.props.accessibilityElementsHidden).toBe(true);
    }
    expect(screen.getByText("That's everything.")).toBeTruthy();
  });

  it('47: lines seen before this visit are neutral with no dot; dots use the seen read from before markFeedSeen', async () => {
    // Activity seen 7 min ago: ADDED (5 min ago) is unread, PAID (10 min ago) is seen.
    const seen: FeedSeen = { ...EMPTY_FEED_SEEN, activity: ago(7) };
    readSeen.mockResolvedValue(seen);
    fetchPage.mockResolvedValue(page([ADDED, PAID], true));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(lineButton(ADDED_TEXT).props.accessibilityLabel).toMatch(/^Unread\./);
    expect(lineButton(PAID_TEXT).props.accessibilityLabel).toMatch(/^Sam marked/);
    expect(screen.getAllByTestId('feed-unread-dot', HIDDEN)).toHaveLength(1);
    expect(screen.getByTestId('feed-marker-needs_you', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('feed-marker-money', HIDDEN)).toBeNull(); // read money line: neutral
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
    // markFeedSeen ran, but this visit keeps its dots: a pull refresh reads no new seen state.
    await act(async () => {
      screen.getByTestId('activity-list').props.refreshControl.props.onRefresh();
    });
    await flush();
    expect(readSeen).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('feed-unread-dot', HIDDEN)).toHaveLength(1);
    expect(markSeen).toHaveBeenCalledTimes(1);
    // The next visit (Back from a bill is a new focus) reads the time markFeedSeen wrote: neutral.
    readSeen.mockResolvedValue({ ...EMPTY_FEED_SEEN, activity: new Date().toISOString() });
    await press(lineButton(ADDED_TEXT));
    expect(await screen.findByText(`Bill stand-in ${B1}`)).toBeTruthy();
    await act(async () => globalRouter.back());
    await waitFor(() => expect(readSeen).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryAllByTestId('feed-unread-dot', HIDDEN)).toHaveLength(0));
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy(); // positive control: the line is still listed
    expect(screen.queryByTestId('feed-marker-needs_you', HIDDEN)).toBeNull();
    await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(2)); // once per focus
  });

  it('47: a failed seen read shows no dots (never a false "unread")', async () => {
    readSeen.mockResolvedValue(null);
    fetchPage.mockResolvedValueOnce(page([ADDED], true));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.queryAllByTestId('feed-unread-dot', HIDDEN)).toHaveLength(0);
    expect(lineButton(ADDED_TEXT).props.accessibilityLabel).toMatch(/^Maya added you/);
  });

  it('44 / A1.1: a full page is "maybe more": no end line; reaching the end asks once, even while in flight', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED], false));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.queryByText("That's everything.")).toBeNull();
    const d = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(d.promise);
    // Twice in the same tick (the ref guard alone), then again once the "loading" render is in.
    await act(async () => {
      fireEvent(screen.getByTestId('activity-list'), 'endReached');
      fireEvent(screen.getByTestId('activity-list'), 'endReached');
    });
    await endReached();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // The next page continues from the state the first page returned.
    expect(fetchPage.mock.calls[1]![1].pageSize).toBe(activityFeed.FEED_PAGE_SIZE);
    expect(screen.getByLabelText('Loading more activity')).toBeTruthy();
    await act(async () => d.resolve(page([PAID], true)));
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.getByText("That's everything.")).toBeTruthy();
    expect(screen.queryByLabelText('Loading more activity')).toBeNull();
    await endReached();
    expect(fetchPage).toHaveBeenCalledTimes(2); // the end: nothing more is asked for
  });

  it('44: a failed next page keeps every line and offers Try again, which asks again', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED], false)).mockResolvedValueOnce(FAIL).mockResolvedValueOnce(page([PAID], true));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    await endReached();
    expect(await screen.findByText("Couldn't load more.")).toBeTruthy();
    expect(screen.getByText("Couldn't load more.").props.accessibilityRole).toBe('alert');
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy();
    // Scrolling again doesn't retry by itself; the button does.
    await endReached();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    expect(screen.queryByText("Couldn't load more.")).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('44: a page with no lines that isn\'t the end keeps reading by itself', async () => {
    fetchPage.mockResolvedValueOnce(page([], false)).mockResolvedValueOnce(page([PAID], true));
    openActivity();
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Nothing new. When someone adds you to a receipt or pays you, it shows up here.')).toBeNull();
  });

  it('45: a refresh that fails keeps the list with no error; one that succeeds replaces the pages from page 1', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED], false)).mockResolvedValueOnce(page([PAID], false));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    await endReached();
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    // Pull: fails, list stays.
    fetchPage.mockResolvedValueOnce(FAIL);
    await act(async () => {
      screen.getByTestId('activity-list').props.refreshControl.props.onRefresh();
    });
    await flush();
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.getByText(PAID_TEXT)).toBeTruthy();
    expect(screen.queryByText("Couldn't load your activity.")).toBeNull();
    expect(screen.getByTestId('activity-list').props.refreshControl.props.refreshing).toBe(false);
    // Foreground: succeeds from page 1 (a fresh state, sized to the lines already loaded) and replaces.
    fetchPage.mockResolvedValueOnce(page([JOINED_G1], true));
    const listener = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)?.[1] as ((s: string) => void) | undefined;
    expect(listener).toBeDefined();
    await act(async () => listener!('active'));
    expect(await screen.findByText(/Ana joined/)).toBeTruthy();
    expect(screen.queryByText(ADDED_TEXT)).toBeNull();
    expect(screen.queryByText(PAID_TEXT)).toBeNull();
    const refreshState = fetchPage.mock.calls.at(-1)![1];
    expect(refreshState.places).toBeNull(); // page 1: nothing carried over
    expect(refreshState.bill.cursor).toBeNull();
    expect(refreshState.pageSize).toBe(activityFeed.FEED_PAGE_SIZE); // 2 lines loaded < 30
  });

  it('R2: reaching the end during a keep-list refresh asks nothing until the refresh lands, then continues from the refreshed pages', async () => {
    const first = page([ADDED], false);
    fetchPage.mockResolvedValueOnce(first);
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    const refreshing = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(refreshing.promise);
    await act(async () => {
      screen.getByTestId('activity-list').props.refreshControl.props.onRefresh();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // The old pager no longer matches what the refresh will show: no next page from it.
    await endReached();
    await endReached();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('Loading more activity')).toBeNull();
    // The refresh lands (a new line on top); the waiting "more" continues from the refreshed state.
    const fresh = page([PAID, ADDED], false);
    const next = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(next.promise);
    await act(async () => refreshing.resolve(fresh));
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    if (!fresh.ok) throw new Error('fixture');
    expect(fetchPage.mock.calls[2]![1].bill).toBe(fresh.page.state.bill);
    expect(fetchPage.mock.calls[2]![1].pageSize).toBe(activityFeed.FEED_PAGE_SIZE);
    await act(async () => next.resolve(page([JOINED_G1], true)));
    expect(await screen.findByText(/Ana joined/)).toBeTruthy();
    expect(screen.getByText(PAID_TEXT)).toBeTruthy();
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.getByText("That's everything.")).toBeTruthy();
  });

  it('R2: a failed keep-list refresh releases paging, which continues from the pages still on screen', async () => {
    const first = page([ADDED], false);
    fetchPage.mockResolvedValueOnce(first);
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    const refreshing = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(refreshing.promise);
    await act(async () => {
      screen.getByTestId('activity-list').props.refreshControl.props.onRefresh();
    });
    await endReached();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    fetchPage.mockResolvedValueOnce(page([PAID], true));
    await act(async () => refreshing.resolve(FAIL));
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    expect(fetchPage).toHaveBeenCalledTimes(3);
    if (!first.ok) throw new Error('fixture');
    expect(fetchPage.mock.calls[2]![1].bill).toBe(first.page.state.bill);
    expect(screen.getByText(ADDED_TEXT)).toBeTruthy();
    expect(screen.getByTestId('activity-list').props.refreshControl.props.refreshing).toBe(false);
  });

  it('R3: Activity is marked seen at the focus start time, not the time the loads finished', async () => {
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const d = deferred<FeedResult<{ page: FeedPage }>>();
      fetchPage.mockReturnValueOnce(d.promise);
      openActivity();
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
      clock.mockReturnValue(t0 + 60_000); // the page takes a minute; anything written meanwhile stays unread
      await act(async () => d.resolve(page([ADDED, PAID], true)));
      expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
      await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
      expect(markSeen).toHaveBeenCalledWith(ME, 'activity', null, t0);
    } finally {
      clock.mockRestore();
    }
  });

  it("R3: a loaded line newer than the phone's clock (server ahead) is still covered: max(focus time, newest line)", async () => {
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const ahead = item(F_CASES['F-a'].met, new Date(t0 + 30_000).toISOString().replace('Z', '123Z')); // microseconds
      fetchPage.mockResolvedValueOnce(page([ahead, PAID], true));
      openActivity();
      expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
      await waitFor(() => expect(markSeen).toHaveBeenCalledTimes(1));
      // Rounded up to the next ms, so the line's microseconds are covered too.
      expect(markSeen).toHaveBeenCalledWith(ME, 'activity', null, t0 + 30_001);
    } finally {
      clock.mockRestore();
    }
  });

  it('46: changing the chip discards the pages and fetches again; a late answer for the old chip is ignored', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED], false));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    // A next page for "All" is in flight when the chip changes.
    const late = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(late.promise);
    await endReached();
    const money = deferred<FeedResult<{ page: FeedPage }>>();
    fetchPage.mockReturnValueOnce(money.promise);
    await press(screen.getByRole('radio', { name: 'Money' }));
    // Discarded: the loading state, not the old list.
    expect(screen.queryByText(ADDED_TEXT)).toBeNull();
    expect(screen.getByLabelText('Loading activity')).toBeTruthy();
    const [filter, state] = fetchPage.mock.calls.at(-1)!;
    expect(filter).toBe<FeedFilter>('money');
    expect(state.places).toBeNull();
    expect(state.bill).toEqual({ cursor: null, exhausted: false, buffer: [] });
    expect(state.group).toEqual({ cursor: null, exhausted: false, buffer: [] });
    // The old chip's page lands late: ignored.
    await act(async () => late.resolve(page([JOINED_G1], true)));
    expect(screen.queryByText(/Ana joined/)).toBeNull();
    await act(async () => money.resolve(page([PAID], true)));
    expect(await screen.findByText(PAID_TEXT)).toBeTruthy();
    expect(screen.queryByText(/Ana joined/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Money' }).props.accessibilityState).toEqual({ checked: true });
  });

  it('48: a tap pushes the bill once, even on a double tap; a group line pushes the group', async () => {
    fetchPage.mockResolvedValue(page([ADDED, JOINED_G1], true));
    const router = openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    const line = lineButton(ADDED_TEXT);
    await act(async () => {
      fireEvent.press(line);
      fireEvent.press(line);
    });
    expect(await screen.findByText(`Bill stand-in ${B1}`)).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${B1}`);
    await act(async () => globalRouter.back());
    expect(router.getPathname()).toBe('/activity'); // one push: one Back returns to Activity
    expect(await screen.findByText(/Ana joined/)).toBeTruthy();
    await press(lineButton('Ana joined'));
    expect(await screen.findByText(`Group stand-in ${G1}`)).toBeTruthy();
    expect(router.getPathname()).toBe(`/groups/${G1}`);
    expect(router.getSearchParams()).toMatchObject({ from: 'feed' }); // delete-group A1.1 (plus the route's own id)
  });

  it('49: a roll-up run shows "Show 2" (label "Show the 2 changes"), expands its children and collapses with Hide', async () => {
    fetchPage.mockResolvedValueOnce(page([CLAIM_A, CLAIM_B], true));
    openActivity();
    expect(await screen.findByText(/claimed 2 items/)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show the 2 changes' });
    expect(within(toggle).getByText('Show 2')).toBeTruthy();
    expect(toggle.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    const childCount = () => screen.queryAllByText(/claimed (Fries|Soda)/).length;
    expect(childCount()).toBe(0);
    await press(toggle);
    const hide = screen.getByRole('button', { name: 'Hide the changes' });
    expect(within(hide).getByText('Hide')).toBeTruthy();
    expect(hide.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    expect(childCount()).toBe(2);
    await press(hide);
    expect(childCount()).toBe(0);
    expect(screen.getByRole('button', { name: 'Show the 2 changes' })).toBeTruthy();
  });

  it('50: the chips are one labelled radiogroup with All checked', async () => {
    fetchPage.mockResolvedValue(page([], true));
    openActivity();
    await screen.findByText('Nothing new. When someone adds you to a receipt or pays you, it shows up here.');
    // A radiogroup View isn't itself focusable, so role queries skip it; find it by its props.
    const group = screen.UNSAFE_getByProps({ accessibilityRole: 'radiogroup', accessibilityLabel: 'Filter activity' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityState)).toEqual([{ checked: true }, { checked: false }, { checked: false }]);
    expect(radios.map((r) => within(r).getByText(/All|Money|Groups/).props.children)).toEqual(['All', 'Money', 'Groups']);
  });

  it('51: no row background, no bold and no coloured text in a line', async () => {
    fetchPage.mockResolvedValueOnce(page([ADDED, PAID, CLAIM_A, CLAIM_B], true));
    openActivity();
    expect(await screen.findByText(ADDED_TEXT)).toBeTruthy();
    await press(screen.getByRole('button', { name: /^Show the 2 changes$/ }));
    const allowed = new Set([colors.light.text, colors.light.textMuted, colors.light.primary]); // primary: the toggle link only
    const lines = screen.getAllByTestId(/^feed-line-/);
    expect(lines.length).toBe(3); // positive control: two lines and one run
    for (const line of lines) {
      expect(StyleSheet.flatten(line.props.style as ViewStyle).backgroundColor).toBeUndefined();
      const texts = within(line).queryAllByText(/.+/);
      expect(texts.length).toBeGreaterThan(1);
      for (const t of texts) {
        const st = StyleSheet.flatten(t.props.style as TextStyle);
        expect(['400', 'normal', '600', undefined]).toContain(st.fontWeight);
        expect(allowed.has(String(st.color))).toBe(true);
        if (st.fontWeight === '600') expect(String(t.props.children)).toMatch(/^(Show \d+|Hide)$/); // the toggle (TextLink) only
        if (st.color === colors.light.primary) expect(String(t.props.children)).toMatch(/^(Show \d+|Hide)$/);
      }
    }
  });
});

// The chips on web: react-native-web writes the radio state as aria-checked, one tab stop
// (lesson 2026-11-27: Jest's renderer reads accessibilityState, the browser doesn't).
describe('Activity chips on web: the DOM carries the selection and the roving tab stop', () => {
  it('aria-checked on the selected chip, tabindex 0 only there, inside a radiogroup', () => {
    let html = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => jest.requireActual('react-native-web'));
      jest.doMock('@/components/ui/Icon', () => ({ Icon: () => null }));
      const React = jest.requireActual<typeof import('react')>('react');
      // @types/react-dom isn't installed; this is the one function used.
      const { renderToStaticMarkup } = jest.requireActual<{ renderToStaticMarkup: (el: ReactElement) => string }>('react-dom/server');
      const { SegmentedControl } = jest.requireActual<typeof import('@/components/ui/SegmentedControl')>('@/components/ui/SegmentedControl');
      const { FEED_COPY, FEED_SCREEN_A11Y } = jest.requireActual<typeof import('@/lib/feedText')>('@/lib/feedText');
      html = renderToStaticMarkup(
        React.createElement(SegmentedControl<FeedFilter>, {
          options: (['all', 'money', 'groups'] as const).map((f) => ({ value: f, label: FEED_COPY.chips[f] })),
          value: 'money',
          onChange: () => {},
          semantics: 'radio',
          groupLabel: FEED_SCREEN_A11Y.filterGroup,
        }),
      );
    });
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Filter activity"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
});
