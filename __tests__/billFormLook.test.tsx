// Visual pass V10: the bill form's status pill and controls use icons, not text glyphs, and the
// shared primitives. Behavior is covered by billForm.test.tsx; this file checks only the look.
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import X from 'lucide-react-native/icons/x';
import { StyleSheet } from 'react-native';

import { clearScanResult } from '@/lib/scanSession';
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
const press = (label: string) => fireEvent.press(screen.queryByLabelText(label) ?? screen.getByText(label));
const type = (label: string, value: string) => fireEvent.changeText(screen.getByLabelText(label), value);
const GLYPHS = /[✓✕⚠…]/;

beforeEach(() => {
  clearScanResult();
  supabase.__setInitialSession(fakeSession());
});

async function openBill() {
  renderRouter('./app', { initialUrl: '/bill' });
  await screen.findByText(/Enter the items|Check the items/);
}

it('the status pill is icon + words with no outline, and changes icon with the status', async () => {
  await openBill();
  const pill = () => screen.getByLabelText(/^Totals check:/);
  expect(pill().props.accessibilityLabel).toBe('Totals check: Not checked yet');
  expect(StyleSheet.flatten(pill().props.style).borderWidth).toBeUndefined();
  expect(screen.UNSAFE_getAllByType(Ellipsis)).toHaveLength(1);

  press('Add item');
  type('Item 1 name', 'Fries');
  type('Item 1 price', '3.99');
  type('Total', '3.99');
  expect(pill().props.accessibilityLabel).toBe('Totals check: Adds up');
  expect(screen.UNSAFE_getAllByType(CircleCheck)).toHaveLength(1);
  expect(screen.queryByText(GLYPHS)).toBeNull();
});

it('rows: delete is an X icon button, "Add note" has no glyph, the discount position is a segmented control', async () => {
  await openBill();
  press('Add item');
  press('Add discount');
  expect(screen.getByRole('button', { name: 'Delete item 1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete discount 1' })).toBeTruthy();
  expect(screen.UNSAFE_getAllByType(X)).toHaveLength(2);
  expect(screen.getByText('Add note')).toBeTruthy();
  // Exactly one position is selected (it carries the check icon; SegmentedControl's own test covers that).
  const before = screen.getByRole('button', { name: 'Discount 1 before subtotal' });
  const after = screen.getByRole('button', { name: 'Discount 1 after subtotal' });
  const selectedCount = [before, after].filter((b) => b.props.accessibilityState?.selected).length;
  expect(selectedCount).toBe(1);
  expect(screen.queryByText(GLYPHS)).toBeNull();
});
