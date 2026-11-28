// The Profile username row (docs/specs/2026-11-28-usernames.md A3.9), rendered on its own (no (app)
// layout, so no gate) with lib/useUsernameStatus set per test: read-only once locked, and the
// provisional value with "Choose" otherwise (in practice the gate covers that case). The routed
// "locked" case runs through the whole app in __tests__/chooseUsername.test.tsx.
import { Slot } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { ProfileScreen } from '@/components/ProfileScreen';
import { AuthProvider } from '@/lib/auth';
import { supabase as realSupabase } from '@/lib/supabase';
import { USERNAME_GATE_COPY as COPY } from '@/lib/username';
import type { UsernameStatus } from '@/lib/useUsernameStatus';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';

const mockStatus: { current: UsernameStatus } = {
  current: { status: 'ready', username: 'ana', locked: true, retry: jest.fn(), markLocked: jest.fn() },
};
jest.mock('@/lib/useUsernameStatus', () => ({ useUsernameStatus: () => mockStatus.current }));
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const retry = jest.fn();

function status(next: Partial<Extract<UsernameStatus, { status: 'ready' }>> | { status: 'loading' }) {
  mockStatus.current =
    'status' in next && next.status === 'loading'
      ? { status: 'loading', retry, markLocked: jest.fn() }
      : { status: 'ready', username: 'ana', locked: true, retry, markLocked: jest.fn(), ...next };
}

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__setInitialSession(fakeSession('Ana'));
  supabase.__setRpc((fn) => (fn === 'people_i_split_with' ? { data: [], error: null } : { data: null, error: null }));
  supabase.__setTable('profiles', () => ({ data: { display_name: 'Ana', venmo_username: null }, error: null }));
});

// The real AuthProvider (ProfileScreen reads the session), with no (app) layout and so no gate.
const render = () =>
  renderRouter(
    {
      _layout: () => (
        <AuthProvider>
          <Slot />
        </AuthProvider>
      ),
      index: () => <ProfileScreen withBack={false} />,
    },
    { initialUrl: '/' },
  );

describe.each(['ios', 'web'] as const)('Profile username row (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('locked: @name under the name, before Venmo and Appearance, read-only', async () => {
    status({ locked: true });
    render();
    // The profile load lands first (the name comes with it).
    expect(await screen.findByLabelText('Venmo username', {}, { timeout: 5000 })).toBeTruthy();
    const row = screen.getByLabelText(COPY.profileRow('ana'));
    expect(row).toBeTruthy();
    expect(screen.getByText('@ana')).toBeTruthy();
    expect(screen.queryByRole('button', { name: COPY.chooseLabel })).toBeNull();
    // Order on screen: name, @name, then the Venmo field, then Appearance.
    const texts = screen.UNSAFE_root.findAll((n) => typeof n.props.children === 'string' && typeof n.type === 'string').map(
      (n) => n.props.children as string,
    );
    const at = texts.indexOf('@ana');
    expect(texts.indexOf('Ana')).toBeGreaterThanOrEqual(0);
    expect(texts.indexOf('Ana')).toBeLessThan(at);
    const after = screen.UNSAFE_root.findAll((n) => typeof n.props.children === 'string' && typeof n.type === 'string').map(
      (n) => n.props.children as string,
    );
    expect(after.indexOf('@ana')).toBeLessThan(after.indexOf('Appearance'));
  });

  it('provisional: the value plus "Choose", which reads the status again (bringing up the gate)', async () => {
    status({ locked: false });
    render();
    expect(await screen.findByLabelText(COPY.profileRow('ana'))).toBeTruthy();
    const choose = screen.getByRole('button', { name: COPY.chooseLabel });
    await act(async () => {
      fireEvent.press(choose);
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('while the status is loading, no username line (and no stale one)', async () => {
    status({ status: 'loading' });
    render();
    expect(await screen.findByLabelText('Venmo username', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Ana')).toBeTruthy();
    expect(screen.queryByLabelText(/^Username, @/)).toBeNull();
    expect(screen.queryByText('@ana')).toBeNull();
  });
});
