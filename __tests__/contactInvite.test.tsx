// "From contacts" in the Invite card: criteria 57–61 in docs/specs/2026-11-24-people-and-invites.md (Task 10).
// lib/contactPicker is mocked; the real native wrapper has its own tests (lib/contactPicker.native.test.ts).
import { router as appRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { AccessibilityInfo, Linking, Platform } from 'react-native';

import { inviteMessage, whatsAppUrl } from '@/lib/contactInvite';
import type { PickContactResult } from '@/lib/contactPicker';
import * as picker from '@/lib/contactPicker';
import { inviteUrl } from '@/lib/inviteLink';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

let mockSupported = true;
jest.mock('@/lib/contactPicker', () => ({
  get contactsSupported() {
    return mockSupported;
  },
  pickContactPhones: jest.fn(),
  smsAvailable: jest.fn(),
  sendSms: jest.fn(),
}));
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

const supabase = realSupabase as unknown as FakeSupabase;
const pick = picker.pickContactPhones as jest.MockedFunction<typeof picker.pickContactPhones>;
const smsOk = picker.smsAvailable as jest.MockedFunction<typeof picker.smsAvailable>;
const send = picker.sendSms as jest.MockedFunction<typeof picker.sendSms>;
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const CODE = '0123456789abcdef0123';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const MOBILE = '+1 (415) 555-0100';
const HOME = '(415) 555-0199';

function installFakes() {
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
      total_cents: 600,
      join_code: CODE,
      created_at: '2026-11-20T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    }),
  );
  supabase.__setTable('line_items', () =>
    ok([{ id: '22222222-0000-4000-8000-000000000001', name: 'Fries', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 600, split_set_by: null, split_set_at: null }]),
  );
  supabase.__setTable('bill_participants', () =>
    ok([A, B].map((id, i) => ({
      user_id: id,
      joined_at: `2026-11-20T19:0${i}:00Z`,
      settled_at: null,
      settled_cents: null,
      profile: { display_name: id === A ? 'Hana Lee' : 'Bo', venmo_username: null },
    }))),
  );
  supabase.__setTable('claims', () => ok([]));
  supabase.__setRpc(() => ok(null));
}

const viewAs = (id: string) => {
  const s = fakeSession('Test');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id } });
};
const picked = (...phones: { number: string; label: string | null }[]): PickContactResult => ({ status: 'picked', phones });
const fromContacts = () => screen.getByLabelText('From contacts');
const isDisabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled === true;

async function openBill() {
  const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
  await screen.findByText('Invite friends');
  return router;
}
async function tapFromContacts() {
  await act(async () => {
    fireEvent.press(fromContacts());
  });
}

let openURL: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  installFakes();
  viewAs(B);
  mockSupported = true;
  pick.mockResolvedValue({ status: 'cancelled' });
  smsOk.mockResolvedValue(true);
  send.mockResolvedValue('done');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('From contacts on web (criterion 57)', () => {
  it.each([
    ['host', A],
    ['guest', B],
  ])('the %s sees no "From contacts" (contactsSupported is false)', async (_who, id) => {
    jest.replaceProperty(Platform, 'OS', 'web');
    mockSupported = false;
    viewAs(id);
    await openBill();
    expect(screen.getByText('Copy link')).toBeTruthy();
    expect(screen.queryByLabelText('From contacts')).toBeNull();
    expect(pick).not.toHaveBeenCalled();
  });
});

describe.each(['ios', 'android'] as const)('From contacts on %s', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  });

  it.each([
    ['host', A],
    ['guest', B],
  ])('57: the %s sees "From contacts" with its hint', async (_who, id) => {
    viewAs(id);
    await openBill();
    expect(fromContacts().props.accessibilityRole).toBe('button');
    expect(fromContacts().props.accessibilityHint).toBe('Pick a contact and text them the link');
  });

  it('58: one number (count 1) goes straight to "Send with:"; Messages sends the link once, then back to idle', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }));
    await openBill();
    await tapFromContacts();
    expect(await screen.findByText('Send with:')).toBeTruthy();
    expect(screen.queryByText('Text which number?')).toBeNull();
    expect(screen.getByLabelText('Messages')).toBeTruthy();
    expect(screen.getByLabelText('WhatsApp')).toBeTruthy();
    expect(screen.getByLabelText('Cancel')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Messages'));
      fireEvent.press(screen.getByLabelText('Messages'));
    });
    expect(send.mock.calls).toEqual([[MOBILE, inviteMessage(inviteUrl(CODE))]]);
    await waitFor(() => expect(screen.queryByText('Send with:')).toBeNull());
    expect(screen.queryByText(MOBILE)).toBeNull();
    expect(isDisabled('From contacts')).toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('58: WhatsApp opens the wa.me link once, then back to idle', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: null }));
    await openBill();
    await tapFromContacts();
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('WhatsApp'));
    });
    expect(openURL.mock.calls).toEqual([[whatsAppUrl(MOBILE, inviteMessage(inviteUrl(CODE)))]]);
    expect(openURL.mock.calls[0]?.[0]).toMatch(/^https:\/\/wa\.me\/14155550100\?text=/);
    expect(screen.queryByText('Send with:')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('59: without SMS only WhatsApp and Cancel are offered', async () => {
    smsOk.mockResolvedValue(false);
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }));
    await openBill();
    await tapFromContacts();
    await screen.findByText('Send with:');
    expect(screen.queryByLabelText('Messages')).toBeNull();
    expect(screen.getByLabelText('WhatsApp')).toBeTruthy();
    expect(screen.getByLabelText('Cancel')).toBeTruthy();
  });

  it('59: two numbers ask "Text which number?" with their labels; choosing one goes to "Send with:"', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }, { number: HOME, label: 'home' }));
    await openBill();
    await tapFromContacts();
    expect(await screen.findByText('Text which number?')).toBeTruthy();
    expect(screen.getByText(MOBILE)).toBeTruthy();
    expect(screen.getByText('Mobile')).toBeTruthy();
    // Scoped to the number's button: the bill screen's header back control also reads "Home" (P1).
    expect(within(screen.getByLabelText(`Text Home, ${HOME}`)).getByText('Home')).toBeTruthy();
    expect(screen.getByLabelText(`Text Home, ${HOME}`).props.accessibilityRole).toBe('button');
    await act(async () => {
      fireEvent.press(screen.getByLabelText(`Text Home, ${HOME}`));
    });
    expect(await screen.findByText('Send with:')).toBeTruthy();
    expect(screen.queryByText('Text which number?')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Messages'));
    });
    expect(send).toHaveBeenCalledWith(HOME, inviteMessage(inviteUrl(CODE)));
    expect(screen.queryByText(HOME)).toBeNull();
  });

  it('59: the same number twice (different formatting) counts as one, so no question is asked', async () => {
    pick.mockResolvedValue(picked({ number: '+1 415 555 0100', label: 'mobile' }, { number: '+14155550100', label: 'iPhone' }));
    await openBill();
    await tapFromContacts();
    expect(await screen.findByText('Send with:')).toBeTruthy();
    expect(screen.queryByText('Text which number?')).toBeNull();
  });

  it('Cancel on "Text which number?" and on "Send with:" goes back to idle with nothing sent', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }, { number: HOME, label: 'home' }));
    await openBill();
    await tapFromContacts();
    await screen.findByText('Text which number?');
    fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.queryByText('Text which number?')).toBeNull();
    expect(screen.queryByText(MOBILE)).toBeNull();

    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }));
    await tapFromContacts();
    await screen.findByText('Send with:');
    fireEvent.press(screen.getByLabelText('Cancel'));
    expect(screen.queryByText('Send with:')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    expect(isDisabled('From contacts')).toBe(false);
  });

  it.each([
    ['no phone number', picked(), 'That contact has no phone number.'],
    ['only digit-less entries', picked({ number: '+', label: 'mobile' }), 'That contact has no phone number.'],
    ['a picker error', { status: 'error' } as PickContactResult, "Couldn't open your contacts. Use Share… instead."],
    ['a denied permission', { status: 'denied' } as PickContactResult, "SplitIt can't open your contacts. You can allow it in Settings."],
  ])('60: %s says so (live region) and goes back to idle', async (_case, result, text) => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    pick.mockResolvedValue(result);
    await openBill();
    await tapFromContacts();
    const notice = await screen.findByText(text);
    expect(notice.props.accessibilityLiveRegion).toBe('polite');
    expect(isDisabled('From contacts')).toBe(false);
    expect(screen.queryByText('Send with:')).toBeNull();
    if (os === 'ios') expect(announce).toHaveBeenCalledWith(text);
    else expect(announce).not.toHaveBeenCalled();
    // The next tap clears it.
    pick.mockResolvedValue({ status: 'cancelled' });
    await tapFromContacts();
    expect(screen.queryByText(text)).toBeNull();
  });

  it('60: a cancelled picker shows nothing new', async () => {
    await openBill();
    await tapFromContacts();
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Send with:')).toBeNull();
    expect(screen.queryByText(/That contact|Couldn't open|can't open/)).toBeNull();
    expect(isDisabled('From contacts')).toBe(false);
  });

  it('a composer that fails says "Couldn\'t open your contacts…"; WhatsApp failing says "Couldn\'t open WhatsApp…"', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: null }));
    send.mockResolvedValue('error');
    await openBill();
    await tapFromContacts();
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Messages'));
    });
    expect(await screen.findByText("Couldn't open your contacts. Use Share… instead.")).toBeTruthy();

    openURL.mockRejectedValue(new Error('no handler'));
    await tapFromContacts();
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('WhatsApp'));
    });
    expect(await screen.findByText("Couldn't open WhatsApp. Use Share… instead.")).toBeTruthy();
    expect(isDisabled('From contacts')).toBe(false);
  });

  it('61: a second tap while the picker is open does not open it again', async () => {
    let resolve: (r: PickContactResult) => void = () => {};
    pick.mockImplementation(() => new Promise((r) => (resolve = r)));
    await openBill();
    fireEvent.press(fromContacts());
    fireEvent.press(fromContacts());
    expect(pick).toHaveBeenCalledTimes(1);
    expect(fromContacts().props.accessibilityState?.busy).toBe(true);
    await act(async () => resolve({ status: 'cancelled' }));
    expect(isDisabled('From contacts')).toBe(false);
  });

  it('61: signing out mid-flow (the picker still open) drops it: no pending updates, nothing sent', async () => {
    let resolve: (r: PickContactResult) => void = () => {};
    pick.mockImplementation(() => new Promise((r) => (resolve = r)));
    const errors = jest.spyOn(console, 'error');
    const router = await openBill();
    fireEvent.press(fromContacts());
    await act(async () => {
      await supabase.auth.signOut();
    });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    await act(async () => resolve(picked({ number: MOBILE, label: 'mobile' })));
    expect(errors.mock.calls.filter((c) => /not wrapped in act|unmounted component/.test(String(c[0])))).toEqual([]);
    expect(smsOk).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByText(MOBILE)).toBeNull();
  });

  it('61: leaving the bill on "Send with:" and opening it again starts idle, with no number on screen', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }));
    const router = await openBill();
    await tapFromContacts();
    await screen.findByText('Send with:');
    act(() => appRouter.replace('/'));
    await waitFor(() => expect(router.getPathname()).toBe('/'));
    act(() => appRouter.push(`/bills/${BILL}`));
    await screen.findByText('Invite friends');
    expect(screen.queryByText('Send with:')).toBeNull();
    expect(screen.queryByText(MOBILE)).toBeNull();
    expect(isDisabled('From contacts')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('62: the bill screen never stores or sends the number anywhere but the composer', async () => {
    pick.mockResolvedValue(picked({ number: MOBILE, label: 'mobile' }));
    await openBill();
    const rpcBefore = supabase.rpc.mock.calls.length;
    await tapFromContacts();
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Messages'));
    });
    const sent = JSON.stringify([supabase.rpc.mock.calls.slice(rpcBefore), supabase.__queries]);
    expect(sent).not.toContain('415');
  });
});
