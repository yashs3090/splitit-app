// Profile screen: criteria 27–30 in docs/specs/2026-11-24-profile-venmo.md (Task 4).
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Platform } from 'react-native';

import { getFixture } from '@/lib/fixtures/receipts';
import { PENDING_INVITE_KEY, savePendingInvite } from '@/lib/pendingInvite';
import { SAVE_VENMO_ERROR_COPY } from '@/lib/profile';
import { parseReceipt } from '@/lib/receiptText';
import { getScanResult, setScanResult } from '@/lib/scanSession';
import { storage as realStorage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { VENMO_USERNAME_ERROR } from '@/lib/venmo';
import { fakeSession, type FakeResult, type FakeSupabase, type MemoryStorage, type RecordedQuery } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const storage = realStorage as unknown as MemoryStorage;
const ROUTES = './app';
const ME = 'user-a'; // fakeSession()'s user id
const CODE = '0123456789abcdef0123';

/** The fake `profiles` row, plus switches for failure paths. */
const db: {
  row: { display_name: string | null; venmo_username: string | null };
  failRead: boolean;
  updateResult: FakeResult | null; // null: apply the update and return the row
  holdUpdate: Promise<void> | null; // a pending save, released by the test
} = { row: { display_name: null, venmo_username: null }, failRead: false, updateResult: null, holdUpdate: null };

const isUpdate = (q: RecordedQuery) => q.calls[0]?.method === 'update';
const updates = () => supabase.__queries.filter((q) => q.table === 'profiles' && isUpdate(q));
const reads = () => supabase.__queries.filter((q) => q.table === 'profiles' && !isUpdate(q));

beforeEach(() => {
  jest.clearAllMocks();
  storage.data.clear();
  supabase.__queries.length = 0;
  supabase.__setInitialSession(fakeSession());
  db.row = { display_name: 'Ada L.', venmo_username: null };
  db.failRead = false;
  db.updateResult = null;
  db.holdUpdate = null;
  // Profile also shows "People you've split with" (people-and-invites Task 6); nobody yet.
  // Its own tests are in __tests__/people.test.tsx.
  supabase.__setRpc((fn) => (fn === 'people_i_split_with' ? { data: [], error: null } : { data: null, error: null }));
  supabase.__setTable('profiles', async (q) => {
    if (isUpdate(q)) {
      if (db.holdUpdate) await db.holdUpdate;
      if (db.updateResult) return db.updateResult;
      const patch = q.calls[0]?.args[0] as { venmo_username: string | null };
      db.row = { ...db.row, venmo_username: patch.venmo_username };
      return { data: [{ venmo_username: db.row.venmo_username }], error: null };
    }
    if (db.failRead) return { data: null, error: { code: '08006', message: 'connection' } };
    return { data: { ...db.row }, error: null };
  });
});

async function openProfile(initialUrl = '/profile') {
  const router = renderRouter(ROUTES, { initialUrl });
  await screen.findByLabelText('Venmo username');
  return router;
}
const field = () => screen.getByLabelText('Venmo username');
const saveButton = () => screen.getByLabelText('Save Venmo username');
const typeVenmo = (text: string) => fireEvent.changeText(field(), text);
async function pressSave() {
  await act(async () => {
    fireEvent.press(saveButton());
  });
}
const isDisabled = () => saveButton().props.accessibilityState?.disabled === true;

describe('Profile screen', () => {
  it('27: signed out, /profile redirects to /sign-in', async () => {
    supabase.__setInitialSession(null);
    const router = renderRouter(ROUTES, { initialUrl: '/profile' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('27: shows the DB display name and the saved username without "@"', async () => {
    db.row = { display_name: 'Ada L.', venmo_username: 'Ada-L_99' };
    await openProfile();
    expect(screen.getByText('Ada L.')).toBeTruthy();
    expect(field().props.value).toBe('Ada-L_99');
    expect(screen.getByText('@')).toBeTruthy(); // the visible prefix
    expect(reads()[0]?.calls).toEqual([
      { method: 'select', args: ['display_name, venmo_username'] },
      { method: 'eq', args: ['id', ME] },
      { method: 'single', args: [] },
    ]);
  });

  it('27: a null DB display name falls back to the session name; a null username is an empty field', async () => {
    db.row = { display_name: null, venmo_username: null };
    await openProfile();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(field().props.value).toBe('');
  });

  it('30: the field is set up for a username (no caps, no autocorrect)', async () => {
    await openProfile();
    expect(field().props.autoCapitalize).toBe('none');
    expect(field().props.autoCorrect).toBe(false);
    expect(field().props.accessibilityHint).toBe('Friends pay you here.');
    expect(screen.getByText('Friends pay you here.')).toBeTruthy();
  });

  it('28: "@jane-doe" saves "jane-doe", shows "Saved", and the field drops the "@"', async () => {
    await openProfile();
    typeVenmo('@jane-doe');
    expect(isDisabled()).toBe(false);
    await pressSave();

    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(updates()).toHaveLength(1);
    expect(updates()[0]?.calls).toEqual([
      { method: 'update', args: [{ venmo_username: 'jane-doe' }] },
      { method: 'eq', args: ['id', ME] },
      { method: 'select', args: ['venmo_username'] },
    ]);
    expect(field().props.value).toBe('jane-doe');
    expect(isDisabled()).toBe(true); // now equal to the saved value

    // Editing again hides "Saved".
    typeVenmo('jane-doe2');
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('28: "abc" shows the rule on the field and makes no DB call', async () => {
    await openProfile();
    typeVenmo('abc');
    await pressSave();
    expect(await screen.findByText(VENMO_USERNAME_ERROR)).toBeTruthy();
    expect(field().props.accessibilityHint).toBe(VENMO_USERNAME_ERROR);
    expect(updates()).toHaveLength(0);
    // Fixing the text clears the message.
    typeVenmo('abcde');
    expect(screen.queryByText(VENMO_USERNAME_ERROR)).toBeNull();
  });

  it('28: the keyboard "done" key saves too', async () => {
    await openProfile();
    typeVenmo('jane-doe');
    await act(async () => {
      fireEvent(field(), 'submitEditing');
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(updates()).toHaveLength(1);
  });

  it('28: Save is disabled while the input normalizes to the saved value (no-op save never writes)', async () => {
    db.row = { display_name: 'Ada L.', venmo_username: 'abcde' };
    await openProfile();
    expect(isDisabled()).toBe(true);
    typeVenmo('  @abcde ');
    expect(isDisabled()).toBe(true);
    await act(async () => {
      fireEvent(field(), 'submitEditing');
    });
    expect(updates()).toHaveLength(0);
    typeVenmo('ABCDE'); // case is a change
    expect(isDisabled()).toBe(false);
  });

  it('28: clearing the field removes the username (update to null)', async () => {
    db.row = { display_name: 'Ada L.', venmo_username: 'abcde' };
    await openProfile();
    typeVenmo('');
    await pressSave();
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(updates()[0]?.calls[0]).toEqual({ method: 'update', args: [{ venmo_username: null }] });
  });

  it('28: a failed save keeps the typed text, shows the fixed error and re-enables Save', async () => {
    db.updateResult = { data: null, error: { code: '08006', message: 'secret server text' } };
    await openProfile();
    typeVenmo('@new-name1');
    await pressSave();
    expect(await screen.findByText(SAVE_VENMO_ERROR_COPY.error)).toBeTruthy();
    expect(screen.queryByText(/secret server text/)).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
    expect(field().props.value).toBe('@new-name1');
    expect(isDisabled()).toBe(false);

    // Retrying after the problem clears works, and the error goes away.
    db.updateResult = null;
    await pressSave();
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(screen.queryByText(SAVE_VENMO_ERROR_COPY.error)).toBeNull();
  });

  it('28: a zero-row save (not allowed) shows its own copy; a 23514 shows the rule', async () => {
    db.updateResult = { data: [], error: null };
    await openProfile();
    typeVenmo('abcde');
    await pressSave();
    expect(await screen.findByText(SAVE_VENMO_ERROR_COPY.not_allowed)).toBeTruthy();

    db.updateResult = { data: null, error: { code: '23514', message: 'check' } };
    await pressSave();
    expect(await screen.findByText(VENMO_USERNAME_ERROR)).toBeTruthy();
    expect(screen.queryByText(SAVE_VENMO_ERROR_COPY.not_allowed)).toBeNull();
  });

  it('28: while saving, Save is busy and the field is locked; a second press sends nothing', async () => {
    let release: () => void = () => {};
    db.holdUpdate = new Promise<void>((r) => {
      release = r;
    });
    await openProfile();
    typeVenmo('jane-doe');
    await pressSave();
    expect(saveButton().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    expect(field().props.editable).toBe(false);
    await pressSave();

    await act(async () => {
      release();
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(updates()).toHaveLength(1);
    expect(field().props.editable).not.toBe(false);
  });

  it('29: a load error shows the message, and "Try again" refetches', async () => {
    db.failRead = true;
    renderRouter(ROUTES, { initialUrl: '/profile' });
    expect(await screen.findByText("Couldn't load your profile.")).toBeTruthy();
    expect(screen.queryByLabelText('Venmo username')).toBeNull();

    db.failRead = false;
    db.row = { display_name: 'Ada L.', venmo_username: 'abcde' };
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });
    expect(await screen.findByLabelText('Venmo username')).toBeTruthy();
    expect(field().props.value).toBe('abcde');
    expect(reads()).toHaveLength(2);
  });

  it('29: "Sign out" ends on /sign-in with the session, pending invite and scan result cleared', async () => {
    const router = await openProfile();
    await savePendingInvite(storage, CODE, Date.now());
    setScanResult(parseReceipt(getFixture('modifiers').text));
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(true);

    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });

    expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
    expect(getScanResult()).toBeNull();
    const { data } = await supabase.auth.getSession();
    expect(data.session).toBeNull();
  });

  it('29: a failed sign-out says so and stays on Profile', async () => {
    supabase.auth.signOut.mockImplementationOnce(async () => ({ error: { message: 'boom' } }) as never);
    const router = await openProfile();
    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });
    expect(await screen.findByText('Sign-out failed. Please try again.')).toBeTruthy();
    expect(router.getPathname()).toBe('/profile');
  });

  it('Back returns to home when Profile was opened from home', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    const profile = await screen.findByLabelText('Profile');
    await act(async () => {
      fireEvent.press(profile);
    });
    await screen.findByLabelText('Venmo username');
    expect(router.getPathname()).toBe('/profile');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Back'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('Back from a deep-linked /profile (nothing to go back to) replaces with home', async () => {
    const router = await openProfile();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Back'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/'));
  });

  it('30: controls have labels and hints; status and errors are announced', async () => {
    await openProfile();
    expect(screen.getByLabelText('Back').props.accessibilityHint).toBeTruthy();
    expect(saveButton().props.accessibilityHint).toBeTruthy();
    expect(screen.getByLabelText('Sign out').props.accessibilityHint).toBe('Signs you out on this device');
    expect(screen.getByRole('header', { name: 'Profile' })).toBeTruthy();

    typeVenmo('abcde');
    await pressSave();
    expect((await screen.findByText('Saved')).props.accessibilityLiveRegion).toBe('polite');

    db.updateResult = { data: null, error: { code: '08006', message: 'x' } };
    typeVenmo('abcdef');
    await pressSave();
    await screen.findByText(SAVE_VENMO_ERROR_COPY.error);
    // Banner's View has role "alert" but isn't `accessible`, so getByRole skips it; read the prop.
    const alerts = screen.UNSAFE_root.findAll((n) => n.props.accessibilityRole === 'alert' && typeof n.type === 'string');
    expect(alerts).toHaveLength(1);
  });

  it('30: the file carries the BILL HISTORY (v1) marker and shows no history UI', async () => {
    // The app's tsconfig has no Node types, so load fs with just the one signature used here.
    const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
    const source = fs.readFileSync(`${process.cwd()}/app/(app)/profile.tsx`, 'utf8');
    expect(source).toContain('BILL HISTORY (v1)');
    await openProfile();
    expect(screen.queryByText(/history/i)).toBeNull();
  });
});

// iOS ignores live regions, so "Saved" is announced explicitly there; web and Android use the live region.
describe('Profile screen: "Saved" announcement per platform', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['ios', true],
    ['android', false],
    ['web', false],
  ] as const)('%s: announceForAccessibility called = %s', async (os, expected) => {
    jest.replaceProperty(Platform, 'OS', os);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    await openProfile();
    typeVenmo('abcde');
    await pressSave();
    await screen.findByText('Saved');
    if (expected) expect(announce).toHaveBeenCalledWith('Saved');
    else expect(announce).not.toHaveBeenCalled();
  });
});
