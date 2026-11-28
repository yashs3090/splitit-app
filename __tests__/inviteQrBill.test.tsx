// Invite QR on the bill screen (iOS and web): the QR is the string inviteUrl(join_code) returns,
// it follows the host's "Make a new link", and when no link can be built there is no QR toggle
// (like the link itself). Fakes and fixture follow __tests__/sharePanelPlacement.test.tsx.
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { INVITE_QR_COPY } from '@/components/InviteQr';
import { inviteUrl } from '@/lib/inviteLink';
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
// The real builder, wrapped so one test can make it throw (a link that can't be built).
jest.mock('@/lib/inviteLink', () => {
  const actual = jest.requireActual<typeof import('@/lib/inviteLink')>('@/lib/inviteLink');
  return { inviteUrl: jest.fn(actual.inviteUrl) };
});

const supabase = realSupabase as unknown as FakeSupabase;
const mockedInviteUrl = inviteUrl as jest.MockedFunction<typeof inviteUrl>;
const realInviteUrl = jest.requireActual<typeof import('@/lib/inviteLink')>('@/lib/inviteLink').inviteUrl;
const ROUTES = './app';

const BILL = '11111111-1111-4111-8111-111111111111';
const A = '00000000-0000-4000-8000-00000000000a';
const BURGER = '22222222-0000-4000-8000-000000000001';
const CODE = '0123456789abcdef0123';
const NEW_CODE = 'fedcba9876543210fedc';

const HOST = {
  user_id: A,
  joined_at: '2026-11-20T19:00:00Z',
  settled_at: null,
  settled_cents: null,
  profile: { display_name: 'Hana Lee', venmo_username: null },
};

let joinCode = CODE;

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
      total_cents: 1500,
      join_code: joinCode,
      group_id: null, // bills.group_id: fetchBillGroup reads it (a bill in no group)
      created_at: '2026-11-20T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    }),
  );
  supabase.__setTable('line_items', () =>
    ok([
      {
        id: BURGER,
        name: 'Burger',
        note: null,
        group_position: 0,
        unit_index: 0,
        group_size: 1,
        total_cents: 1500,
        split_set_by: null,
        split_set_at: null,
      },
    ]),
  );
  supabase.__setTable('bill_participants', () => ok([HOST]));
  supabase.__setTable('claims', () => ok([]));
}

const qrValue = () => screen.UNSAFE_getByType(QRCode).props.value as string;
const realOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  mockedInviteUrl.mockImplementation(realInviteUrl);
  joinCode = CODE;
  installTables();
  supabase.__setRpc((fn) => (fn === 'rotate_join_code' ? { data: NEW_CODE, error: null } : { data: null, error: null }));
  const session = fakeSession('Hana Lee');
  supabase.__setInitialSession({ ...session, user: { ...session.user, id: A } });
});

afterEach(() => {
  Platform.OS = realOS;
});

describe.each(['ios', 'web'] as const)('invite QR on the bill screen on %s', (os) => {
  beforeEach(() => {
    Platform.OS = os;
  });

  it('the popup shows the QR of exactly inviteUrl(join_code), and the new one after "Make a new link"', async () => {
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $15.00');

    fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.show }));
    expect(qrValue()).toBe(realInviteUrl(CODE));

    // The popup covers the card: close it first, as a person would.
    fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.done }));
    expect(screen.UNSAFE_queryAllByType(QRCode)).toHaveLength(0);

    // The host makes a new link; the refetch brings the new code.
    joinCode = NEW_CODE;
    installTables();
    fireEvent.press(screen.getByText('Make a new link'));
    await act(async () => fireEvent.press(screen.getByText('Make new link')));
    await waitFor(() => expect(screen.getByLabelText(`Invite link ${realInviteUrl(NEW_CODE)}`)).toBeTruthy());

    // Reopened, the popup shows the new link's QR and the new link, never the old one.
    fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.show }));
    expect(qrValue()).toBe(realInviteUrl(NEW_CODE));
    expect(screen.getAllByLabelText(`Invite link ${realInviteUrl(NEW_CODE)}`)).toHaveLength(2);
    expect(screen.queryAllByLabelText(`Invite link ${realInviteUrl(CODE)}`)).toHaveLength(0);
    router.unmount();
  });

  it('has no QR toggle when the link cannot be built (like the link itself)', async () => {
    mockedInviteUrl.mockImplementation(() => {
      throw new RangeError('inviteUrl: invalid invite code');
    });
    const router = renderRouter(ROUTES, { initialUrl: `/bills/${BILL}` });
    await screen.findByText('Total $15.00');
    expect(screen.queryByText('Copy link')).toBeNull();
    expect(screen.queryByRole('button', { name: INVITE_QR_COPY.show })).toBeNull();
    expect(screen.UNSAFE_queryAllByType(QRCode)).toHaveLength(0);
    router.unmount();
  });
});
