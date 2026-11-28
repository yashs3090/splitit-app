// Share panel, join, and home list: criteria 91–98 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md
// (Task 12). The M0 resume flow tests live in inviteFlow.test.tsx; this file adds the web path.
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Platform, Share } from 'react-native';

import { PENDING_INVITE_KEY } from '@/lib/pendingInvite';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { SEEN_DEBOUNCE_MS } from '@/lib/useMarkSeen';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage } from '@/test-utils/fakes';

// The live tab bar also reads the Activity and Groups badges; quiet those reads so this file's
// supabase call logs hold only Home's own. The Tabs count stays real.
jest.mock('@/lib/tabBadges', () => jest.requireActual<typeof import('@/test-utils/tabBar')>('@/test-utils/tabBar').quietFeedBadges());
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
// The link per platform, as Linking.createURL builds it in dev (lib/inviteLink.test.ts covers createURL).
jest.mock('@/lib/inviteLink', () => ({
  inviteUrl: (code: string) =>
    jest.requireActual<typeof import('react-native')>('react-native').Platform.OS === 'web'
      ? `http://localhost:8081/b/${code}`
      : `splitit://b/${code}`,
}));

const supabase = realSupabase as unknown as FakeSupabase;
/** Every rpc call except the fire-and-forget mark_bill_seen (sent-via-Venmo F7: per version, debounced, and on blur). */
// Also not the host's one my_groups read (groups GR-T17-12: "Move to a group"), which writes nothing.
const rpcCallsExceptSeen = () => supabase.rpc.mock.calls.filter(([fn]) => fn !== 'mark_bill_seen' && fn !== 'my_groups');
const storage = realStorage as unknown as MemoryStorage;

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const CODE = '0123456789abcdef0123';
const NEW_CODE = 'fedcba9876543210fedc';

const db: { bill: Record<string, unknown>; myBills: FakeResult } = { bill: {}, myBills: { data: [], error: null } };

function signInAs(userId: string) {
  const session = fakeSession('Bo Bo');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: userId } });
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  db.bill = {
    id: BILL,
    host_id: A,
    payer_id: A,
    subtotal_cents: null,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 600,
    join_code: CODE,
    group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
    created_at: '2026-11-20T19:00:00Z',
    edited_at: null,
    extras_split: 'proportional',
  };
  // fetchBill reads the bills table; Home's list comes from rpc my_bills (bill markers D2), below.
  supabase.__setTable('bills', () => ({ data: db.bill, error: null }));
  // B joined with the link: not added, has opened it, no claims, not complete.
  db.myBills = {
    data: [
      {
        bill_id: BILL,
        host_id: A,
        host_name: 'Hana Lee',
        payer_id: A,
        total_cents: 600,
        created_at: '2026-11-20T19:00:00Z',
        joined_at: '2026-11-20T19:05:00Z',
        added: false,
        seen: true,
        claimed_any: false,
        complete: false,
      },
    ],
    error: null,
  };
  supabase.__setTable('line_items', {
    data: [{ id: '22222222-0000-4000-8000-000000000002', name: 'Fries', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 600, split_set_by: null, split_set_at: null }],
    error: null,
  });
  supabase.__setTable('bill_participants', {
    data: [
      { user_id: A, joined_at: '2026-11-20T19:00:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Hana Lee', venmo_username: null } },
      { user_id: B, joined_at: '2026-11-20T19:05:00Z', settled_at: null, settled_cents: null, profile: { display_name: 'Bo', venmo_username: null } },
    ],
    error: null,
  });
  supabase.__setTable('claims', { data: [], error: null });
  supabase.__setRpc((fn) => {
    if (fn === 'join_bill') return { data: BILL, error: null };
    if (fn === 'my_bills') return db.myBills;
    if (fn === 'my_groups') return { data: [], error: null }; // Home's Groups block: no groups
    return { data: null, error: null };
  });
  signInAs(B);
});

async function openBill() {
  renderRouter('./app', { initialUrl: `/bills/${BILL}` });
  await screen.findByText('Invite friends');
}

// The test environment has no `navigator`; tests that need one install it on globalThis.
const g = globalThis as { navigator?: unknown };

describe('share panel', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
  afterEach(() => {
    if (originalNavigator) Object.defineProperty(g, 'navigator', originalNavigator);
    else Reflect.deleteProperty(g, 'navigator');
  });

  it('91: web without navigator.share: copies the localhost link; no "Share…"', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(g, 'navigator', { configurable: true, value: {} });
    await openBill();
    expect(screen.getByText(`http://localhost:8081/b/${CODE}`)).toBeTruthy();
    expect(screen.queryByText('Share…')).toBeNull();
    await act(async () => fireEvent.press(screen.getByText('Copy link')));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`http://localhost:8081/b/${CODE}`);
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('91: web with navigator.share shows "Share…"', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    Object.defineProperty(g, 'navigator', { configurable: true, value: { share: jest.fn() } });
    await openBill();
    expect(screen.getByText('Share…')).toBeTruthy();
  });

  it('92: native: "Share…" opens the share sheet once with the splitit:// link', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    await openBill();
    await act(async () => fireEvent.press(screen.getByText('Share…')));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0]).toEqual({ message: `Claim what you had on SplitIt: splitit://b/${CODE}` });
    share.mockRestore();
  });

  it('92: a copy that resolves false, or throws, shows the fallback copy', async () => {
    jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    await openBill();
    await act(async () => fireEvent.press(screen.getByText('Copy link')));
    expect(await screen.findByText("Couldn't copy. Select the link and copy it yourself.")).toBeTruthy();
    jest.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('no clipboard'));
    await act(async () => fireEvent.press(screen.getByText('Copy link')));
    expect(screen.getByText("Couldn't copy. Select the link and copy it yourself.")).toBeTruthy();
  });

  it('93: a non-host can copy but cannot make a new link', async () => {
    await openBill();
    expect(screen.getByText('Copy link')).toBeTruthy();
    expect(screen.queryByText('Make a new link')).toBeNull();
  });

  it('93: the host confirms, rotate_join_code runs, and the link updates; Cancel calls nothing', async () => {
    signInAs(A);
    supabase.__setRpc((fn) => (fn === 'rotate_join_code' ? { data: NEW_CODE, error: null } : { data: null, error: null }));
    await openBill();
    fireEvent.press(screen.getByText('Make a new link'));
    expect(screen.getByText('The old link will stop working. People already in the bill stay in.')).toBeTruthy();
    fireEvent.press(screen.getByText('Cancel'));
    expect(rpcCallsExceptSeen()).toHaveLength(0);
    expect(screen.queryByText(/old link will stop working/)).toBeNull();

    fireEvent.press(screen.getByText('Make a new link'));
    // The server now has the new code (the refetch after rotating reads it).
    db.bill = { ...db.bill, join_code: NEW_CODE };
    await act(async () => fireEvent.press(screen.getByText('Make new link')));
    expect(supabase.rpc).toHaveBeenCalledWith('rotate_join_code', { p_bill_id: BILL });
    expect(await screen.findByText(`splitit://b/${NEW_CODE}`)).toBeTruthy();
    expect(screen.queryByText(`splitit://b/${CODE}`)).toBeNull();
    expect(screen.queryByText(/old link will stop working/)).toBeNull();
  });

  it('93: a failed rotate keeps the old link and says so', async () => {
    signInAs(A);
    supabase.__setRpc(() => ({ data: null, error: { code: '08006', message: 'server text' } }));
    await openBill();
    fireEvent.press(screen.getByText('Make a new link'));
    await act(async () => fireEvent.press(screen.getByText('Make new link')));
    expect(await screen.findByText("Couldn't make a new link. Try again.")).toBeTruthy();
    expect(screen.getByText(`splitit://b/${CODE}`)).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
  });
});

describe('join', () => {
  const joins = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'join_bill');

  it('94: signed in, /b/<valid> calls join_bill exactly once and lands on the bill', async () => {
    const router = renderRouter('./app', { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(await screen.findByText('Total $6.00')).toBeTruthy();
    expect(joins()).toEqual([['join_bill', { p_code: CODE }]]);
    // R1: /b/<code> → join_bill → replace lands on a ready bill, which marks it seen (after the debounce, F7).
    act(() => jest.advanceTimersByTime(SEEN_DEBOUNCE_MS));
    await waitFor(() =>
      expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: BILL }]]),
    );
  });

  it('95 (web path): signed out → sign in → the web OAuth landing resumes → join → bill', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    supabase.__setInitialSession(null);
    const first = renderRouter('./app', { initialUrl: `/b/${CODE}` });
    await waitFor(() => expect(first.getPathname()).toBe('/sign-in'));
    expect(storage.data.get(PENDING_INVITE_KEY)).toContain(CODE);
    first.unmount();

    // Google redirects the browser back to the app's origin, signed in (detectSessionInUrl).
    signInAs(B);
    const router = renderRouter('./app', { initialUrl: '/' });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(joins()).toEqual([['join_bill', { p_code: CODE }]]);
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
    // R1: the web OAuth '/' resume also lands on a ready bill, marked seen (after the debounce, F7).
    expect(await screen.findByText('Total $6.00')).toBeTruthy();
    act(() => jest.advanceTimersByTime(SEEN_DEBOUNCE_MS));
    await waitFor(() =>
      expect(supabase.rpc.mock.calls.filter(([fn]) => fn === 'mark_bill_seen')).toEqual([['mark_bill_seen', { p_bill_id: BILL }]]),
    );
  });

  it('96: invalid_code shows the fixed copy and "Go home"', async () => {
    supabase.__setRpc(() => ({ data: null, error: { code: 'P0002', message: 'invalid_code' } }));
    const router = renderRouter('./app', { initialUrl: `/b/${CODE}` });
    expect(await screen.findByText("This link doesn't work anymore. Ask for a new one.")).toBeTruthy();
    expect(screen.queryByText(CODE)).toBeNull();
    fireEvent.press(screen.getByText('Go home'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('96: other errors show "Couldn\'t join. Try again."; retry calls join_bill again', async () => {
    let fail = true;
    supabase.__setRpc((): FakeResult =>
      fail ? { data: null, error: { code: '08006', message: 'server text' } } : { data: BILL, error: null },
    );
    const router = renderRouter('./app', { initialUrl: `/b/${CODE}` });
    expect(await screen.findByText("Couldn't join. Try again.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    fail = false;
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    expect(joins()).toHaveLength(2);
  });

  it('96: a well-formed but non-hex code is refused without a call', async () => {
    renderRouter('./app', { initialUrl: '/b/abcdefghij12' });
    expect(await screen.findByText("This link doesn't work anymore. Ask for a new one.")).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('97: /b/bad still shows the M0 invalid-invite message, with no rpc', async () => {
    renderRouter('./app', { initialUrl: '/b/bad' });
    expect(await screen.findByText(/This invite link isn.t valid/)).toBeTruthy();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('home', () => {
  // HOME-SEC-1/2: "Waiting on you" is drawn as Items to claim / Still needs to be paid, each a toggle.
  const WAITING_SECTION = /^(Items to claim|Still needs to be paid), \d+ bills?$/;

  it('98: lists your bills (here under "Waiting on you"), and each row opens its bill', async () => {
    const router = renderRouter('./app', { initialUrl: '/' });
    // Row titles, sections and amounts: docs/specs/2026-11-26-home-mobile-refresh.md D2–D4.
    const row = await screen.findByText("Hana Lee's bill");
    expect(screen.getByRole('button', { name: WAITING_SECTION })).toBeTruthy();
    expect(screen.getByText('$6.00')).toBeTruthy();
    fireEvent.press(row);
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL}`));
    // Let the bill screen finish loading so no update lands after the test.
    expect(await screen.findByText('Invite friends')).toBeTruthy();
  });

  it('visual pass V9 / P4 (tab-bar spec Task 5): Profile is a tab, not a Home icon; no "Signed in as"; rows are links with a chevron icon', async () => {
    renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByRole('button', { name: WAITING_SECTION })).toBeTruthy();
    await screen.findByText("Hana Lee's bill");
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    // Home's Profile icon button moved to the tab bar: the only "Profile" control is the tab.
    expect(screen.queryByRole('button', { name: 'Profile' })).toBeNull();
    // A tab on native, a link on web (an earlier test in this file leaves Platform.OS as 'web').
    const profile = screen.getByLabelText('Profile');
    expect(['tab', 'link']).toContain(profile.props.accessibilityRole);
    expect(within(profile).getByText('Profile')).toBeTruthy(); // a tab shows its label
    expect(screen.getAllByText('Profile')).toHaveLength(1);
    expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    expect(screen.queryByText('›')).toBeNull();
  });

  it('98: shows "Your bill" for bills you host', async () => {
    signInAs(A);
    renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByText('Your bill')).toBeTruthy();
    expect(screen.getByText('$6.00')).toBeTruthy();
  });

  it('98: an empty list shows "No bills yet."', async () => {
    db.myBills = { data: [], error: null };
    renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByText('No bills yet.')).toBeTruthy();
  });

  it('a failed load says so, and Try again reloads', async () => {
    db.myBills = { data: null, error: { code: '08006', message: 'server text' } };
    renderRouter('./app', { initialUrl: '/' });
    expect(await screen.findByText("Couldn't load your bills.")).toBeTruthy();
    db.myBills = { data: [], error: null };
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('No bills yet.')).toBeTruthy();
  });
});
