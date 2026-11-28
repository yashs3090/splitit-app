// Visual pass V10a (proposal P2, decision VP-M1): the new-bill form has a back control.
// Nothing entered: it goes straight back. Anything entered (or a scanned draft): it asks
// "Discard this bill?" first, with Discard / Keep editing. Covered on native and web.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { getFixture } from '@/lib/fixtures/receipts';
import { parseReceipt } from '@/lib/receiptText';
import { clearScanResult, getScanResult, setScanResult } from '@/lib/scanSession';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const DISCARD_QUESTION = 'Discard this bill?';
const back = () => screen.getByRole('button', { name: 'Back' });
const type = (label: string, value: string) => fireEvent.changeText(screen.getByLabelText(label), value);

/** Opens Profile, then pushes the new-bill form on top, so "back" has somewhere to go. */
async function openFormFromProfile() {
  const router = renderRouter('./app', { initialUrl: '/profile' });
  await screen.findByRole('header', { name: 'Profile' });
  act(() => globalRouter.push('/bill'));
  await screen.findByText(/Enter the items|Check the items/);
  return router;
}

beforeEach(() => {
  clearScanResult();
  supabase.__setInitialSession(fakeSession());
});

describe.each(['ios', 'web'] as const)('on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('nothing entered: Back goes straight to the previous screen, without asking', async () => {
    const router = await openFormFromProfile();
    fireEvent.press(screen.getByText('Add item')); // a blank row is not an entry
    fireEvent.press(back());
    expect(screen.queryByText(DISCARD_QUESTION)).toBeNull();
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
  });

  it('something entered: Back asks first; Keep editing stays with the typing intact', async () => {
    const router = await openFormFromProfile();
    fireEvent.press(screen.getByText('Add item'));
    type('Item 1 name', 'Fries');
    fireEvent.press(back());
    expect(await screen.findByText(DISCARD_QUESTION)).toBeTruthy();
    expect(router.getPathname()).toBe('/bill');
    // The confirm replaces the Save button while it's open.
    expect(screen.queryByText('Save and share')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText(DISCARD_QUESTION)).toBeNull();
    expect(screen.getByLabelText('Item 1 name').props.value).toBe('Fries');
    expect(screen.getByText('Save and share')).toBeTruthy();
    expect(router.getPathname()).toBe('/bill');
  });

  it('something entered: Discard goes back', async () => {
    const router = await openFormFromProfile();
    type('Total', '12.00');
    fireEvent.press(back());
    fireEvent.press(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
  });

  it('a scanned draft always asks, and Discard clears the scan', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    const router = await openFormFromProfile();
    fireEvent.press(back());
    expect(await screen.findByText(DISCARD_QUESTION)).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(router.getPathname()).toBe('/profile'));
    expect(getScanResult()).toBeNull();
  });

  it('review R5: typing while "Discard this bill?" is open closes it and keeps editing', async () => {
    await openFormFromProfile();
    type('Total', '12.00');
    fireEvent.press(back());
    expect(await screen.findByText(DISCARD_QUESTION)).toBeTruthy();
    type('Tax', '1.00');
    expect(screen.queryByText(DISCARD_QUESTION)).toBeNull();
    expect(screen.getByText('Save and share')).toBeTruthy();
  });

  it('review R4: while a save is pending, Back is disabled and pressing it goes nowhere', async () => {
    const router = await openFormFromProfile();
    fireEvent.press(screen.getByText('Add item'));
    type('Item 1 name', 'Fries');
    type('Item 1 price', '3.99');
    type('Total', '3.99');
    supabase.__setRpc(() => new Promise(() => {})); // createBill never settles
    fireEvent.press(screen.getByRole('button', { name: 'Save and share' }));
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(back().props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(back());
    expect(screen.queryByText(DISCARD_QUESTION)).toBeNull();
    expect(router.getPathname()).toBe('/bill');
  });

  it('review R10: the Back hint says where it goes', async () => {
    await openFormFromProfile();
    expect(back().props.accessibilityHint).toBe('Goes back');
    screen.unmount();
    renderRouter('./app', { initialUrl: '/bill' });
    await screen.findByText(/Enter the items|Check the items/);
    // Tab-bar spec Task 5: a cold /bill has the tabs anchored under it, so there is somewhere to go
    // back to (the next test shows Back lands on Tabs, '/').
    expect(back().props.accessibilityHint).toBe('Goes back');
  });

  it('opened with no history (cold link or reload): Back goes home (the Tabs tab)', async () => {
    const router = renderRouter('./app', { initialUrl: '/bill' });
    await screen.findByText(/Enter the items|Check the items/);
    fireEvent.press(back());
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    expect(await screen.findByRole('header', { name: 'SplitIt' })).toBeTruthy();
  });
});
