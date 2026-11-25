// Bill screen: the invite block moves (P8) without remounting (review R1). While the host is alone,
// SharePanel sits before the items; when the first guest joins live it moves below them. It must be
// moved, not remounted, so an open "Make a new link" confirm (and "Link copied", a contact pick)
// survives the join. Fakes and fixture follow __tests__/billScreen.test.tsx.
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeChannel, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

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

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const BURGER = '22222222-0000-4000-8000-000000000001';
const FRIES = '22222222-0000-4000-8000-000000000002';

const HOST = {
  user_id: A,
  joined_at: '2026-11-20T19:00:00Z',
  settled_at: null,
  settled_cents: null,
  profile: { display_name: 'Hana Lee', venmo_username: null },
};
const GUEST = {
  user_id: B,
  joined_at: '2026-11-20T19:05:00Z',
  settled_at: null,
  settled_cents: null,
  profile: { display_name: 'Bo', venmo_username: null },
};

let participants: Record<string, unknown>[] = [];

function row(id: string, name: string, cents: number, g: number) {
  return { id, name, note: null, group_position: g, unit_index: 0, group_size: 1, total_cents: cents, split_set_by: null, split_set_at: null };
}

function installTables() {
  const ok = (data: unknown): FakeResult => ({ data, error: null });
  supabase.__setTable('bills', () =>
    ok({
      id: BILL,
      host_id: A,
      payer_id: A,
      subtotal_cents: null,
      tax_cents: 0,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 2100,
      join_code: '0123456789abcdef0123',
      created_at: '2026-11-20T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    }),
  );
  supabase.__setTable('line_items', () => ok([row(BURGER, 'Burger', 1500, 0), row(FRIES, 'Fries', 600, 1)]));
  supabase.__setTable('bill_participants', () => ok(participants));
  supabase.__setTable('claims', () => ok([]));
}

const liveChannel = (): FakeChannel => {
  const ch = supabase.__channels.filter((c) => !c.removed).at(-1);
  if (!ch) throw new Error('no open channel');
  return ch;
};

/** Each button's accessible name, in screen order: its label, else its text. */
const buttonNames = () =>
  screen.getAllByRole('button').map((b) => String(b.props.accessibilityLabel ?? within(b).queryByText(/./)?.props.children ?? ''));

const realOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  participants = [HOST];
  installTables();
  supabase.__queries.length = 0;
  supabase.__setRpc(() => ({ data: null, error: null }));
  const session = fakeSession('Hana Lee');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: A } });
});

afterEach(() => {
  Platform.OS = realOS;
});

describe.each(['ios', 'web'] as const)('invite block placement on %s (R1)', (os) => {
  beforeEach(() => {
    Platform.OS = os;
  });

  it('R1: a guest joining live moves the invite block below the items and keeps an open "Make a new link" confirm', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $21.00');
    await waitFor(() => expect(liveChannel().subscribe).toHaveBeenCalled());

    // Alone: the invite block comes first.
    let names = buttonNames();
    expect(names.indexOf('Copy link')).toBeGreaterThan(-1);
    expect(names.indexOf('Copy link')).toBeLessThan(names.indexOf('Claim Burger'));

    // The host opens the rotate confirm.
    fireEvent.press(screen.getByText('Make a new link'));
    expect(screen.getByText('Make new link')).toBeTruthy();

    // Bo joins; the live refetch brings two participants.
    participants = [HOST, GUEST];
    await act(async () => liveChannel().__broadcast('changed', { t: 'bill_participants' }));
    await waitFor(() => {
      names = buttonNames();
      expect(names.indexOf('Copy link')).toBeGreaterThan(names.indexOf('Claim Burger'));
    });

    // Moved, not remounted: the confirm is still open.
    expect(screen.getByText('Make new link')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.queryByText('Make a new link')).toBeNull();
    router.unmount();
  });
});
