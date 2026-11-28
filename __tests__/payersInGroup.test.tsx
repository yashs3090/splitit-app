// The Who paid page (app/(app)/bills/[id]/payers.tsx) when the bill moved into a group while the
// host had it open: set_payers refuses with in_group. The shared BILL_ERROR_COPY.in_group is worded
// for guests ("Ask for the group's link"), so this page says what's true for the host.
// Native and web (Platform.OS set explicitly). The rest of the page is tested in settle.test.tsx.
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { BILL_ERROR_COPY } from '@/lib/bills';
import { supabase as realSupabase } from '@/lib/supabase';
import { fakeSession, type FakeDbError, type FakeResult, type FakeSupabase } from '@/test-utils/fakes';

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
const IN_GROUP = 'This bill is in a group now, so who paid is set there.';

let setPayersAnswer: FakeDbError | null = null;

function install() {
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
      group_id: null,
      created_at: '2026-11-27T19:00:00Z',
      edited_at: null,
      extras_split: 'proportional',
    }),
  );
  supabase.__setTable('line_items', () =>
    ok([
      { id: BURGER, name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500, split_set_by: null, split_set_at: null },
      { id: FRIES, name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600, split_set_by: null, split_set_at: null },
    ]),
  );
  supabase.__setTable('bill_participants', () =>
    ok([
      { user_id: A, joined_at: '2026-11-27T19:00:00Z', profile: { display_name: 'Hana', venmo_username: null } },
      { user_id: B, joined_at: '2026-11-27T19:01:00Z', profile: { display_name: 'Sam', venmo_username: null } },
    ]),
  );
  supabase.__setTable('claims', () =>
    ok([
      { line_item_id: BURGER, user_id: A, parts: 1 },
      { line_item_id: FRIES, user_id: B, parts: 1 },
    ]),
  );
  supabase.__setRpc(async (fn) => {
    if (fn === 'set_payers' && setPayersAnswer !== null) return { data: null, error: setPayersAnswer };
    return ok(null);
  });
}

const field = (name: string) => screen.getByLabelText(`${name} paid, in dollars`);
const disabled = (label: string) => screen.getByLabelText(label).props.accessibilityState?.disabled === true;
const setPayersCalls = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'set_payers');

beforeEach(() => {
  jest.clearAllMocks();
  supabase.__queries.length = 0;
  setPayersAnswer = null;
  install();
  const s = fakeSession('Hana');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id: A } });
});

describe.each(['ios', 'web'] as const)('Who paid page, the bill moved into a group (%s)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  async function saveSplit() {
    renderRouter(ROUTES, { initialUrl: `/bills/${BILL}/payers` });
    await screen.findByText('Bill total');
    fireEvent.changeText(field('You'), '12');
    fireEvent.changeText(field('Sam'), '9');
    await waitFor(() => expect(disabled('Save')).toBe(false));
    fireEvent.press(screen.getByLabelText('Save'));
    await waitFor(() => expect(setPayersCalls()).toHaveLength(1));
  }

  it("in_group: the host's wording, announced, never the guest's; what was typed stays and Save works again", async () => {
    setPayersAnswer = { code: '22023', message: 'in_group' };
    await saveSplit();
    const line = await screen.findByText(IN_GROUP);
    // Announced: the line sits in an alert Banner (role alert on native; react-native-web maps the role).
    type Node = { parent: Node | null; props: { accessibilityRole?: string; role?: string } };
    let node: Node | null = line as unknown as Node;
    let inAlert = false;
    while (node !== null) {
      if (node.props.accessibilityRole === 'alert' || node.props.role === 'alert') inAlert = true;
      node = node.parent;
    }
    expect(inAlert).toBe(true);
    expect(screen.queryByText(BILL_ERROR_COPY.in_group)).toBeNull();
    expect(field('You').props.value).toBe('12');
    expect(field('Sam').props.value).toBe('9');
    expect(disabled('Save')).toBe(false);
  });

  it('positive control: another refusal still shows the shared copy (only in_group is reworded here)', async () => {
    setPayersAnswer = { code: '22023', message: 'invalid_payers' };
    await saveSplit();
    expect(await screen.findByText(BILL_ERROR_COPY.invalid_payers)).toBeTruthy();
    expect(screen.queryByText(IN_GROUP)).toBeNull();
  });
});
