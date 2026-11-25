// "Save and share" on /bill: criteria 71–74 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md (Task 9).
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { useLocalSearchParams } from 'expo-router';
import { Platform, Text } from 'react-native';

import { MISMATCH_BANNER } from '@/components/BillForm';
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

const BILL_ID = '11111111-2222-4333-8444-555555555555';
const CODE = '0123456789abcdef0123';
const SERVER_TEXT = 'new row violates check constraint "bills_total_cents_range" for ada@example.com';
const SAVE = 'Save and share';
const SAVE_ERROR = "Couldn't save the bill. Check your connection and try again.";

/**
 * The bill screen (Task 10) is built in parallel, so this test mounts a stand-in at its path.
 * It only proves where saving lands; it is not part of the app.
 */
function BillScreenStandIn() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Text>{`Bill screen ${id}`}</Text>;
}

function renderApp(initialUrl = '/bill') {
  return renderRouter(
    { appDir: './app', overrides: { '(app)/bills/[id]/index': BillScreenStandIn } },
    { initialUrl },
  );
}

async function openBill() {
  const router = renderApp();
  await screen.findByText(/Enter the items|Check the items/);
  return router;
}

function type(label: string, value: string) {
  fireEvent.changeText(screen.getByLabelText(label), value);
}
const saveButton = () => screen.getByRole('button', { name: SAVE });
const isDisabled = () => saveButton().props.accessibilityState?.disabled === true;
const valueOf = (label: string): unknown => screen.getByLabelText(label).props.value;

/** Criterion 64's bill: Burger 15.00, Fries 6.00, Beer ×2 14.00, tax 2.80, tip 7.00, total 44.80. */
function enterCriterion64Bill() {
  for (let i = 0; i < 3; i++) fireEvent.press(screen.getByText('Add item'));
  type('Item 1 name', 'Burger');
  type('Item 1 price', '15.00');
  type('Item 2 name', 'Fries');
  type('Item 2 price', '6.00');
  type('Item 3 name', 'Beer');
  type('Item 3 qty', '2');
  type('Item 3 price', '14.00');
  type('Tax', '2.80');
  type('Tip', '7.00');
  type('Total', '44.80');
}

const CRITERION_64_ARGS = {
  p_rows: [
    { name: 'Burger', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1500 },
    { name: 'Fries', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 600 },
    { name: 'Beer', note: null, group_position: 2, unit_index: 0, group_size: 2, total_cents: 700 },
    { name: 'Beer', note: null, group_position: 2, unit_index: 1, group_size: 2, total_cents: 700 },
  ],
  p_subtotal_cents: null,
  p_tax_cents: 280,
  p_fees_cents: 0,
  p_tip_cents: 700,
  p_subtotal_discount_cents: 0,
  p_total_discount_cents: 0,
  p_total_cents: 4480,
};

beforeEach(() => {
  clearScanResult();
  supabase.__setInitialSession(fakeSession());
  supabase.rpc.mockClear();
  supabase.__setRpc(() => ({ data: [{ bill_id: BILL_ID, join_code: CODE }], error: null }));
});

describe('save and share', () => {
  it('71: with an empty draft, "Save and share" is disabled with "Add at least one item to save."', async () => {
    await openBill();
    expect(isDisabled()).toBe(true);
    expect(screen.getByText('Add at least one item to save.')).toBeTruthy();
    expect(saveButton().props.accessibilityHint).toBe('Add at least one item to save.');
    expect(screen.queryByText('Saving comes in the next update.')).toBeNull();

    fireEvent.press(saveButton());
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('72: saves criterion 64\'s bill with one create_bill call (even on a double press), then lands on the bill', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text)); // a scan result that saving must clear
    const router = await openBill();
    // Start from an empty form so the rows are exactly criterion 64's.
    for (let i = 0; i < 2; i++) fireEvent.press(screen.getByLabelText('Delete item 1'));
    for (const f of ['Subtotal', 'Tax', 'Total']) type(f, '');
    enterCriterion64Bill();
    expect(isDisabled()).toBe(false);
    expect(screen.queryByText(/to save\.$/)).toBeNull();

    let resolveRpc: (v: { data: unknown; error: null }) => void = () => undefined;
    supabase.__setRpc(
      () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        }),
    );
    fireEvent.press(saveButton());
    fireEvent.press(screen.getByRole('button', { name: /Save and share|Saving…/ }));
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Saving…' }).props.accessibilityState).toMatchObject({
      disabled: true,
      busy: true,
    });
    fireEvent.press(screen.getByRole('button', { name: 'Saving…' }));

    await act(async () => {
      resolveRpc({ data: [{ bill_id: BILL_ID, join_code: CODE }], error: null });
    });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('create_bill', CRITERION_64_ARGS);
    expect(await screen.findByText(`Bill screen ${BILL_ID}`)).toBeTruthy();
    expect(router.getPathname()).toBe(`/bills/${BILL_ID}`);
    expect(getScanResult()).toBeNull();
  });

  it('73: a failed save shows the fixed copy, never the server text, and keeps every field', async () => {
    supabase.__setRpc(() => ({
      data: null,
      error: { code: '22023', message: SERVER_TEXT, details: 'internal', hint: 'internal' },
    }));
    const router = await openBill();
    enterCriterion64Bill();
    await act(async () => {
      fireEvent.press(saveButton());
    });

    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
    expect(screen.queryByText(/bills_total_cents_range|internal|@/)).toBeNull();
    expect(router.getPathname()).toBe('/bill');
    expect(valueOf('Item 1 name')).toBe('Burger');
    expect(valueOf('Item 1 price')).toBe('15.00');
    expect(valueOf('Item 2 name')).toBe('Fries');
    expect(valueOf('Item 3 qty')).toBe('2');
    expect(valueOf('Item 3 price')).toBe('14.00');
    expect(valueOf('Tax')).toBe('2.80');
    expect(valueOf('Tip')).toBe('7.00');
    expect(valueOf('Total')).toBe('44.80');

    // It can be tried again, and it re-enables (not stuck on "Saving…").
    expect(isDisabled()).toBe(false);
    supabase.__setRpc(() => ({ data: [{ bill_id: BILL_ID, join_code: CODE }], error: null }));
    await act(async () => {
      fireEvent.press(saveButton());
    });
    expect(await screen.findByText(`Bill screen ${BILL_ID}`)).toBeTruthy();
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
  });

  it('73: a thrown network failure shows the same copy; editing a field clears it', async () => {
    supabase.__setRpc(() => {
      throw new TypeError('Failed to fetch');
    });
    await openBill();
    enterCriterion64Bill();
    await act(async () => {
      fireEvent.press(saveButton());
    });
    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();

    type('Item 1 name', 'Cheeseburger');
    expect(screen.queryByText(SAVE_ERROR)).toBeNull();
  });

  it('74: with the mismatch banner shown, Save is disabled; after saving, the URL has no search params', async () => {
    const router = await openBill();
    enterCriterion64Bill();
    type('Subtotal', '35.02'); // 2¢ off the items
    expect(screen.getByText(MISMATCH_BANNER)).toBeTruthy();
    expect(isDisabled()).toBe(true);
    expect(screen.getByText('The numbers need to add up before you can save.')).toBeTruthy();
    fireEvent.press(saveButton());
    expect(supabase.rpc).not.toHaveBeenCalled();

    type('Subtotal', '35.00');
    expect(screen.queryByText(MISMATCH_BANNER)).toBeNull();
    expect(isDisabled()).toBe(false);
    await act(async () => {
      fireEvent.press(saveButton());
    });
    await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL_ID}`));
    // getSearchParams() includes the route's own [id] segment; nothing else (no receipt data,
    // no query string) may ride along in the URL.
    expect(router.getSearchParams()).toEqual({ id: BILL_ID });
    expect(supabase.rpc).toHaveBeenCalledWith('create_bill', { ...CRITERION_64_ARGS, p_subtotal_cents: 3500 });
  });

  it('shows the field-error reason while a field is invalid', async () => {
    await openBill();
    enterCriterion64Bill();
    type('Item 2 price', '6.999');
    expect(isDisabled()).toBe(true);
    expect(screen.getByText('Fix the highlighted fields to save.')).toBeTruthy();
  });

  it('works the same on web', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      const router = await openBill();
      enterCriterion64Bill();
      await act(async () => {
        fireEvent.press(saveButton());
      });
      await waitFor(() => expect(router.getPathname()).toBe(`/bills/${BILL_ID}`));
      expect(supabase.rpc).toHaveBeenCalledTimes(1);
    } finally {
      os.restore();
    }
  });
});
