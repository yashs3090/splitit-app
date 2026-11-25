// "People you've split with" on Profile: criteria 38–41 in docs/specs/2026-11-24-people-and-invites.md (Task 6).
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { defaultTimeFormatters } from '@/lib/activityText';
import { personA11yLabel, personCaption, type Person } from '@/lib/people';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const ROUTES = './app';
const fmt = defaultTimeFormatters.date;

type Row = { user_id: string; display_name: string | null; venmo_username: string | null; shared_bills: number; last_shared_at: string };

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, name: string | null, bills: number, handle: string | null = null): Row => ({
  user_id: uid(n),
  display_name: name,
  venmo_username: handle,
  shared_bills: bills,
  last_shared_at: '2026-11-20T19:00:00Z',
});
const toPerson = (r: Row): Person => ({
  userId: r.user_id,
  displayName: r.display_name,
  venmoUsername: r.venmo_username,
  sharedBills: r.shared_bills,
  lastSharedAt: r.last_shared_at,
});

const THREE = [person(1, 'Sam Lee', 4), person(2, 'Ali', 1), person(3, 'Sasha Kim', 2)];
const SIX = [...THREE, person(4, 'Bo', 1), person(5, 'Alex Kim', 1, 'alex-k1'), person(6, 'alex kim', 1)];

const people: { result: FakeResult | Promise<FakeResult> } = { result: { data: [], error: null } };
const peopleCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'people_i_split_with');

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  supabase.__setInitialSession(fakeSession());
  supabase.__setTable('profiles', () => ({ data: { display_name: 'Ada L.', venmo_username: null }, error: null }));
  people.result = { data: THREE, error: null };
  supabase.__setRpc((fn) => (fn === 'people_i_split_with' ? people.result : { data: null, error: null }));
});

async function openProfile() {
  const router = renderRouter(ROUTES, { initialUrl: '/profile' });
  await screen.findByLabelText('Venmo username');
  return router;
}

/** The rendered row labels, top to bottom. */
const rowLabels = () =>
  screen.UNSAFE_root.findAll((n) => typeof n.type === 'string' && n.props.accessible === true && /bills? together/.test(String(n.props.accessibilityLabel ?? '')))
    .map((n) => String(n.props.accessibilityLabel));

describe.each(['ios', 'web'] as const)('Profile: People card (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('38: 3 people show in the given order with captions, between Venmo and Sign out, with no search field', async () => {
    await openProfile();
    expect(await screen.findByText('Sam Lee')).toBeTruthy();
    expect(screen.getByRole('header', { name: "People you've split with" })).toBeTruthy();
    const all = THREE.map(toPerson);
    expect(rowLabels()).toEqual(all.map((p) => personA11yLabel(p, all, fmt)));
    for (const p of all) expect(screen.getByText(personCaption(p, all, fmt))).toBeTruthy();
    // A count of 1 reads "1 bill", without "last".
    expect(screen.getByText(/^1 bill · /)).toBeTruthy();
    expect(screen.getByText(/^4 bills · last /)).toBeTruthy();
    expect(screen.queryByLabelText('Search people')).toBeNull();
    expect(peopleCalls()).toEqual([['people_i_split_with']]);

    // Order on screen: the Venmo field, then the card, then Sign out.
    const texts = screen.UNSAFE_root.findAll((n) => typeof n.type === 'string').flatMap((n) => {
      const label = n.props.accessibilityLabel;
      return typeof label === 'string' ? [label] : [];
    });
    const venmo = texts.indexOf('Venmo username');
    const firstRow = texts.findIndex((t) => t.startsWith('Sam Lee, '));
    const signOut = texts.indexOf('Sign out');
    expect(venmo).toBeGreaterThanOrEqual(0);
    expect(firstRow).toBeGreaterThan(venmo);
    expect(signOut).toBeGreaterThan(firstRow);
  });

  it('38: with 6 people the search field shows; "sa" keeps order; no match shows the quoted query', async () => {
    people.result = { data: SIX, error: null };
    await openProfile();
    const search = await screen.findByLabelText('Search people');
    fireEvent.changeText(search, 'sa');
    expect(rowLabels().map((l) => l.split(',')[0])).toEqual(['Sam Lee', 'Sasha Kim']);
    fireEvent.changeText(search, 'zzz');
    expect(screen.getByText('No one matches "zzz".')).toBeTruthy();
    expect(rowLabels()).toEqual([]);
    fireEvent.changeText(search, '');
    expect(rowLabels()).toHaveLength(6);
  });

  it('PI-10: two people with the same name show their handle when they have one', async () => {
    people.result = { data: SIX, error: null };
    await openProfile();
    await screen.findByText('Alex Kim');
    expect(screen.getByText(/^1 bill · .* · @alex-k1$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Alex Kim, 1 bill together, on .*, Venmo @alex-k1$/)).toBeTruthy();
    // The other Alex has no handle, so nothing is added; unique names never get one.
    expect(screen.getByLabelText(/^alex kim, 1 bill together, on [^,]*$/)).toBeTruthy();
  });

  it('39: loading shows "Loading people"', async () => {
    people.result = new Promise<FakeResult>(() => {});
    await openProfile();
    expect(screen.getByLabelText('Loading people')).toBeTruthy();
  });

  it('39: an error shows the message and "Try again" loads the list', async () => {
    people.result = { data: null, error: { code: '08006', message: 'server text' } };
    await openProfile();
    expect(await screen.findByText("Couldn't load people.")).toBeTruthy();
    expect(screen.queryByText(/server text/)).toBeNull();
    people.result = { data: THREE, error: null };
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });
    expect(await screen.findByText('Sam Lee')).toBeTruthy();
    expect(peopleCalls()).toHaveLength(2);
    expect(screen.queryByText("Couldn't load people.")).toBeNull();
  });

  it('39: a malformed answer is an error too', async () => {
    people.result = { data: [{ ...person(1, 'Sam', 0) }], error: null };
    await openProfile();
    expect(await screen.findByText("Couldn't load people.")).toBeTruthy();
  });

  it('39: an empty list shows the "show up here" line', async () => {
    people.result = { data: [], error: null };
    await openProfile();
    expect(await screen.findByText('People you split bills with will show up here.')).toBeTruthy();
  });

  it('40: rows are display only (no button or link role, no onPress)', async () => {
    await openProfile();
    await screen.findByText('Sam Lee');
    const card = screen.getByText('Sam Lee');
    let n: typeof card | null = card;
    while (n) {
      expect(['button', 'link']).not.toContain(n.props.accessibilityRole);
      expect(n.props.onPress).toBeUndefined();
      if (typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Sam Lee,')) break;
      n = n.parent;
    }
    const buttons = screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? ''));
    expect(buttons.some((l) => /Sam Lee|Ali|Sasha/.test(l))).toBe(false);
  });

  it('41: a late answer after leaving Profile sets no state (no act() warnings)', async () => {
    let release: (r: FakeResult) => void = () => {};
    people.result = new Promise<FakeResult>((r) => (release = r));
    const errors = jest.spyOn(console, 'error');
    const router = await openProfile();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Back'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    await act(async () => release({ data: THREE, error: null }));
    expect(screen.queryByText('Sam Lee')).toBeNull();
    expect(errors.mock.calls.filter((c) => /not wrapped in act|unmounted component/.test(String(c[0])))).toEqual([]);
  });

  it('signed out: /profile goes to /sign-in and never asks for the list', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: '/profile' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(peopleCalls()).toEqual([]);
  });

  it('sign-out takes the list off screen with the rest of Profile', async () => {
    const router = await openProfile();
    await screen.findByText('Sam Lee');
    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(screen.queryByText('Sam Lee')).toBeNull();
  });

  it('the card has no "Add" or other per-person action on Profile', async () => {
    await openProfile();
    const header = await screen.findByRole('header', { name: "People you've split with" });
    expect(header).toBeTruthy();
    expect(within(screen.UNSAFE_root).queryByLabelText(/^Add /)).toBeNull();
  });
});
