// Bill form screen: criteria 27–36 in docs/specs/2026-11-20-m1a-scan-receipt.md.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { MISMATCH_BANNER } from '@/components/BillForm';
import { NO_SUBTOTAL_MISMATCH_COPY, REASON_COPY } from '@/lib/billDraft';
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
const ROUTES = './app';
const NOISE = /NaN|undefined|Infinity/;

function type(label: string, value: string) {
  fireEvent.changeText(screen.getByLabelText(label), value);
}
function press(labelOrText: string) {
  fireEvent.press(screen.queryByLabelText(labelOrText) ?? screen.getByText(labelOrText));
}
const valueOf = (label: string): unknown => screen.getByLabelText(label).props.value;
const itemsLine = (dollars: string) => screen.getByText(`Items add up to ${dollars}`);
const bannerShown = () => screen.queryByText(MISMATCH_BANNER) !== null;
const expectNoNoise = () => expect(screen.queryByText(NOISE)).toBeNull();

async function openBill() {
  const router = renderRouter(ROUTES, { initialUrl: '/bill' });
  await screen.findByText(/Enter the items|Check the items/);
  return router;
}

/** Criterion 29's two items: Burger ×2 25.98 and Fries 3.99 = $29.97. */
function addBurgerAndFries() {
  press('Add item');
  press('Add item');
  type('Item 1 name', 'Burger');
  type('Item 1 qty', '2');
  type('Item 1 price', '25.98');
  type('Item 2 name', 'Fries');
  type('Item 2 price', '3.99');
}

beforeEach(() => {
  clearScanResult();
  supabase.__setInitialSession(fakeSession());
});

describe('bill form', () => {
  it('27: home shows "Scan receipt", which goes to /scan', async () => {
    const router = renderRouter(ROUTES, { initialUrl: '/' });
    expect(await screen.findByText('Your bills')).toBeTruthy();
    // Sign out moved to Profile (docs/specs/2026-11-24-profile-venmo.md, Q1); home links there.
    expect(screen.getByLabelText('Profile')).toBeTruthy();
    fireEvent.press(screen.getByText('Scan receipt'));
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
  });

  it('28: with no scan result, shows the empty manual form', async () => {
    await openBill();
    expect(screen.getByText('Enter the items')).toBeTruthy();
    expect(screen.queryByLabelText('Item 1 name')).toBeNull();
    expect(itemsLine('$0.00')).toBeTruthy();
    expect(screen.getByText(REASON_COPY.no_items)).toBeTruthy();
    // A3 (docs/specs/2026-11-24-first-total-as-subtotal.md): a blank subtotal isn't asked for.
    expect(screen.queryByText(REASON_COPY.missing_subtotal)).toBeNull();
    expect(screen.getByText(REASON_COPY.missing_total)).toBeTruthy();
    expect(bannerShown()).toBe(false);
    // M1b Task 9: the M1a placeholder "Saving comes in the next update." is replaced by the
    // "Save and share" button, disabled with its reason (saveBill.test.tsx covers saving).
    expect(screen.getByText('Add at least one item to save.')).toBeTruthy();
    expectNoNoise();
  });

  it('29–31: add, edit and delete items update the items line', async () => {
    await openBill();
    press('Add item');
    // A just-added blank row shows no errors.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    press('Add item');
    type('Item 1 name', 'Burger');
    type('Item 1 qty', '2');
    type('Item 1 price', '25.98');
    type('Item 2 name', 'Fries');
    type('Item 2 price', '3.99');
    expect(itemsLine('$29.97')).toBeTruthy();

    type('Item 2 price', '4.49');
    expect(itemsLine('$30.47')).toBeTruthy();

    press('Delete item 1');
    expect(screen.queryByDisplayValue('Burger')).toBeNull();
    expect(screen.queryByDisplayValue('25.98')).toBeNull();
    expect(valueOf('Item 1 name')).toBe('Fries');
    expect(screen.queryByLabelText('Item 2 name')).toBeNull();
    expect(itemsLine('$4.49')).toBeTruthy();
    expectNoNoise();
  });

  it('32: invalid money and qty show fixed errors, never change the items line, and clear when fixed', async () => {
    await openBill();
    addBurgerAndFries();
    expect(itemsLine('$29.97')).toBeTruthy();

    for (const bad of ['12.999', 'abc', '-5']) {
      type('Item 2 price', bad);
      expect(screen.getByText('Enter an amount like 12.99.')).toBeTruthy();
      expect(itemsLine('$25.98')).toBeTruthy(); // the invalid row is left out, never NaN
      expectNoNoise();
    }
    type('Item 2 price', '3.99');
    expect(screen.queryByText('Enter an amount like 12.99.')).toBeNull();
    expect(itemsLine('$29.97')).toBeTruthy();

    type('Item 1 qty', '1.5');
    expect(screen.getByText('Use a whole number from 1 to 99.')).toBeTruthy();
    expectNoNoise();
    type('Item 1 qty', '2');
    expect(screen.queryByText('Use a whole number from 1 to 99.')).toBeNull();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expectNoNoise();
  });

  it('33: the totals check updates as the totals change', async () => {
    await openBill();
    addBurgerAndFries();

    type('Subtotal', '29.99');
    expect(bannerShown()).toBe(true);
    expect(screen.getByText(REASON_COPY.items_vs_subtotal)).toBeTruthy();

    type('Subtotal', '29.97');
    expect(bannerShown()).toBe(false);

    type('Tax', '2.40');
    type('Total', '32.37');
    expect(bannerShown()).toBe(false);

    type('Total', '32.40');
    expect(bannerShown()).toBe(true);
    expect(screen.getByText(REASON_COPY.subtotal_vs_total)).toBeTruthy();
    expect(screen.queryByText(REASON_COPY.items_vs_subtotal)).toBeNull();

    type('Total', '32.37');
    expect(bannerShown()).toBe(false);
    const tip = screen.getByLabelText('Tip');
    expect(tip.props.value).toBe('');
    expect(tip.props.placeholder).toBe('Not on receipt');
    expect(screen.queryByText('$0.00')).toBeNull();
    expectNoNoise();
  });

  it('34: a discount before the subtotal reconciles; deleting it shows the banner', async () => {
    await openBill();
    addBurgerAndFries();
    press('Add discount');
    type('Discount 1 label', 'Coupon');
    type('Discount 1 amount', '5.00');
    press('Discount 1 before subtotal');
    expect(screen.getByLabelText('Discount 1 before subtotal').props.accessibilityState).toMatchObject({
      selected: true,
    });
    type('Subtotal', '24.97');
    expect(bannerShown()).toBe(false);

    // Switching it to after the subtotal breaks the items-vs-subtotal check.
    press('Discount 1 after subtotal');
    expect(bannerShown()).toBe(true);
    press('Discount 1 before subtotal');
    expect(bannerShown()).toBe(false);

    press('Delete discount 1');
    expect(screen.queryByLabelText('Discount 1 amount')).toBeNull();
    expect(bannerShown()).toBe(true);
    expect(screen.getByText(REASON_COPY.items_vs_subtotal)).toBeTruthy();
  });

  it('35: prefilled from a scan, with the same live check', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    const router = await openBill();
    expect(screen.getByText('Check the items')).toBeTruthy();
    expect(valueOf('Item 1 name')).toBe('Bowl');
    expect(valueOf('Item 1 price')).toBe('13.00');
    expect(valueOf('Item 1 note')).toBe('avocado, no onions');
    expect(valueOf('Item 2 name')).toBe('Lemonade');
    expect(valueOf('Subtotal')).toBe('17.00');
    expect(valueOf('Tax')).toBe('1.36');
    expect(valueOf('Total')).toBe('18.36');
    expect(valueOf('Tip')).toBe('');
    expect(itemsLine('$17.00')).toBeTruthy();
    expect(bannerShown()).toBe(false);

    type('Item 1 price', '13.02');
    expect(bannerShown()).toBe(true);
    expect(screen.getByText(REASON_COPY.items_vs_subtotal)).toBeTruthy();
    type('Item 1 price', '13.00');
    expect(bannerShown()).toBe(false);

    // Receipt data never goes in the URL.
    expect(router.getPathname()).toBe('/bill');
    expect(router.getSearchParams()).toEqual({});
  });

  it('a parser-flagged row shows the check-quantity note and reason until it is edited', async () => {
    const base = parseReceipt(getFixture('qty-and-at').text);
    setScanResult({
      ...base,
      items: base.items.map((it, i) => (i === 0 ? { ...it, flags: ['qty_price_mismatch' as const] } : it)),
    });
    await openBill();
    expect(screen.getByText('Check this quantity and price.')).toBeTruthy();
    expect(screen.getByText(REASON_COPY.qty_price_mismatch)).toBeTruthy();
    type('Item 1 qty', String(valueOf('Item 1 qty')));
    expect(screen.queryByText('Check this quantity and price.')).toBeNull();
    expect(screen.queryByText(REASON_COPY.qty_price_mismatch)).toBeNull();
  });

  it('36: "Start over" clears the scan and goes to /scan; /bill is then the empty form', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    const router = await openBill();
    expect(screen.getByText('Check the items')).toBeTruthy();
    type('Item 1 price', '14.00');
    expect(router.getPathname()).toBe('/bill');
    expect(router.getSearchParams()).toEqual({});

    await act(async () => {
      fireEvent.press(screen.getByText('Start over'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));
    expect(getScanResult()).toBeNull();

    await act(async () => {
      globalRouter.push('/bill');
    });
    expect(await screen.findByText('Enter the items')).toBeTruthy();
    expect(screen.queryByLabelText('Item 1 name')).toBeNull();
    expect(router.getPathname()).toBe('/bill');
    expect(router.getSearchParams()).toEqual({});
  });

  it('R1: a 2-cent gap shows "Off by $0.02" in the banner', async () => {
    await openBill();
    addBurgerAndFries();
    type('Subtotal', '29.99');
    expect(bannerShown()).toBe(true);
    expect(screen.getByText('Off by $0.02')).toBeTruthy();
  });

  it('A3-8: with a blank subtotal, the check uses the items and never asks for a subtotal', async () => {
    await openBill();
    press('Add item');
    type('Item 1 name', 'Burger');
    type('Item 1 price', '20.00');
    type('Tax', '1.60');
    type('Total', '21.62');
    expect(bannerShown()).toBe(true);
    expect(screen.getByText(NO_SUBTOTAL_MISMATCH_COPY)).toBeTruthy();
    expect(screen.queryByText(REASON_COPY.subtotal_vs_total)).toBeNull();
    expect(screen.getByText('Off by $0.02')).toBeTruthy();
    expect(screen.queryByText(REASON_COPY.missing_subtotal)).toBeNull();

    type('Total', '21.60');
    expect(bannerShown()).toBe(false);
    expect(screen.getByText('Adds up')).toBeTruthy();
    expect(screen.queryByText(REASON_COPY.missing_subtotal)).toBeNull();
    expect(screen.queryByText(REASON_COPY.missing_total)).toBeNull();
    expect(screen.queryByText(NO_SUBTOTAL_MISMATCH_COPY)).toBeNull();
    expectNoNoise();
  });

  it('R2: an invalid tax shows "Fix the highlighted fields", never "Adds up"', async () => {
    await openBill();
    press('Add item');
    type('Item 1 name', 'Burger');
    type('Item 1 price', '12.99');
    type('Subtotal', '12.99');
    type('Total', '12.99');
    expect(screen.getByLabelText('Totals check: Adds up')).toBeTruthy();

    type('Tax', '1.7x');
    expect(screen.queryByLabelText('Totals check: Adds up')).toBeNull();
    expect(screen.queryByText(/Adds up/)).toBeNull();
    expect(screen.getByLabelText('Totals check: Fix the highlighted fields')).toBeTruthy();

    type('Tax', '');
    expect(screen.getByLabelText('Totals check: Adds up')).toBeTruthy();
  });

  it('N3: a field with an error announces it as the input\'s accessibility hint', async () => {
    await openBill();
    press('Add item');
    type('Item 1 name', 'Burger');
    type('Item 1 qty', '0');
    type('Item 1 price', '1.2.3');
    type('Tax', 'abc');
    expect(screen.getByLabelText('Item 1 price').props.accessibilityHint).toBe('Enter an amount like 12.99.');
    expect(screen.getByLabelText('Item 1 qty').props.accessibilityHint).toBe('Use a whole number from 1 to 99.');
    expect(screen.getByLabelText('Tax').props.accessibilityHint).toBe('Enter an amount like 12.99.');
    expect(screen.getByLabelText('Item 1 name').props.accessibilityHint).toBeUndefined();

    type('Item 1 name', '');
    expect(screen.getByLabelText('Item 1 name').props.accessibilityHint).toBe('Add a name.');
    type('Item 1 price', '4.00');
    expect(screen.getByLabelText('Item 1 price').props.accessibilityHint).toBeUndefined();
  });

  it('N5: signing out (from Profile) clears an in-memory scan result', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    const router = renderRouter(ROUTES, { initialUrl: '/profile' });
    expect(await screen.findByText('Sign out')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Sign out'));
    });
    await waitFor(() => expect(router.getPathname()).toBe('/sign-in'));
    expect(getScanResult()).toBeNull();
  });

  it('notes are opt-in: "+ Add note" reveals a focused note field; an emptied note folds back on leave', async () => {
    await openBill();
    press('Add item');
    expect(screen.queryByLabelText('Item 1 note')).toBeNull();
    expect(screen.queryByPlaceholderText(/no onions/)).toBeNull();
    const link = screen.getByLabelText('Add note to item 1');
    expect(link.props.accessibilityRole).toBe('button');
    expect(screen.getByText('Add note')).toBeTruthy();

    press('Add note to item 1');
    const note = screen.getByLabelText('Item 1 note');
    expect(screen.queryByLabelText('Add note to item 1')).toBeNull();
    type('Item 1 note', 'no onions');
    fireEvent(screen.getByLabelText('Item 1 note'), 'blur');
    expect(valueOf('Item 1 note')).toBe('no onions'); // a non-empty note stays shown
    expect(note).toBeTruthy();

    type('Item 1 note', '');
    fireEvent(screen.getByLabelText('Item 1 note'), 'blur');
    expect(screen.queryByLabelText('Item 1 note')).toBeNull();
    expect(screen.getByLabelText('Add note to item 1')).toBeTruthy();
  });

  it('a scanned row with modifiers shows its note; rows without one show "+ Add note"', async () => {
    setScanResult(parseReceipt(getFixture('modifiers').text));
    await openBill();
    expect(valueOf('Item 1 note')).toBe('avocado, no onions');
    expect(screen.queryByLabelText('Add note to item 1')).toBeNull();
    expect(screen.queryByLabelText('Item 2 note')).toBeNull();
    expect(screen.getByLabelText('Add note to item 2')).toBeTruthy();
  });

  describe('tip chips (backlog item 1)', () => {
    /** One $40.00 item, subtotal 40.00, tax 3.20, total 43.20: a receipt with no tip. */
    async function noTipBill(total = '43.20') {
      await openBill();
      press('Add item');
      type('Item 1 name', 'Pasta');
      type('Item 1 price', '40.00');
      type('Subtotal', '40.00');
      type('Tax', '3.20');
      type('Total', total);
    }
    const chip = (label: string) => screen.getByLabelText(label);

    it('shows 15/18/20/25% with their dollar amounts on the subtotal before tax', async () => {
      await noTipBill();
      expect(chip('Tip 15 percent, $6.00')).toBeTruthy();
      expect(chip('Tip 18 percent, $7.20')).toBeTruthy();
      expect(chip('Tip 20 percent, $8.00')).toBeTruthy();
      expect(chip('Tip 25 percent, $10.00')).toBeTruthy();
      expect(chip('Custom tip')).toBeTruthy();
      expect(screen.getByText('% of $40.00, before tax')).toBeTruthy();
      expectNoNoise();
    });

    it('picking 20% sets the tip to 8.00 and moves the matching total so it still adds up', async () => {
      await noTipBill();
      press('Tip 20 percent, $8.00');
      expect(valueOf('Tip')).toBe('8.00');
      expect(valueOf('Total')).toBe('51.20');
      expect(chip('Tip 20 percent, $8.00').props.accessibilityState).toMatchObject({ selected: true });
      expect(screen.getByLabelText('Totals check: Adds up')).toBeTruthy();

      press('Tip 15 percent, $6.00');
      expect(valueOf('Tip')).toBe('6.00');
      expect(valueOf('Total')).toBe('49.20');

      // Tapping the selected chip removes the tip again.
      press('Tip 15 percent, $6.00');
      expect(valueOf('Tip')).toBe('');
      expect(valueOf('Total')).toBe('43.20');
    });

    it('fills a blank total, and leaves a different typed total for the check to flag', async () => {
      await noTipBill('');
      press('Tip 18 percent, $7.20');
      expect(valueOf('Total')).toBe('50.40');

      type('Total', '60.00');
      press('Tip 20 percent, $8.00');
      expect(valueOf('Tip')).toBe('8.00');
      expect(valueOf('Total')).toBe('60.00');
      expect(bannerShown()).toBe(true);
    });

    it('custom: a percent with decimals, or a dollar amount, via the % | $ switch', async () => {
      await noTipBill();
      press('Custom tip');
      expect(chip('Custom tip').props.accessibilityState).toMatchObject({ selected: true });
      expect(chip('Custom tip in percent').props.accessibilityState).toMatchObject({ selected: true });
      expect(chip('Custom tip in percent').props.accessibilityRole).toBe('button');

      type('Custom tip percent', '22.5');
      expect(screen.getByText('= $9.00')).toBeTruthy();
      expect(valueOf('Tip')).toBe('9.00');
      expect(valueOf('Total')).toBe('52.20');

      type('Custom tip percent', '18.555');
      expect(screen.getByText('Enter a percent like 18 or 18.5.')).toBeTruthy();
      expect(valueOf('Tip')).toBe('9.00'); // an invalid % never changes the tip

      press('Custom tip in dollars');
      expect(chip('Custom tip in dollars').props.accessibilityState).toMatchObject({ selected: true });
      type('Custom tip amount', '5');
      expect(valueOf('Tip')).toBe('5.00');
      expect(valueOf('Total')).toBe('48.20');
      expectNoNoise();
    });

    it('with a tip already on the receipt, chips stay hidden until "Tip options" or the Tip field is used', async () => {
      setScanResult({ ...parseReceipt(getFixture('modifiers').text), tipCents: 300, totalCents: 2136 });
      await openBill();
      expect(valueOf('Tip')).toBe('3.00');
      expect(screen.queryByLabelText(/^Tip 20 percent/)).toBeNull();
      press('Tip options');
      // 20% of the $17.00 subtotal.
      press('Tip 20 percent, $3.40');
      expect(valueOf('Tip')).toBe('3.40');
      expect(valueOf('Total')).toBe('21.76');
    });

    it('focusing the Tip field reveals the chips', async () => {
      setScanResult({ ...parseReceipt(getFixture('modifiers').text), tipCents: 300, totalCents: 2136 });
      await openBill();
      fireEvent(screen.getByLabelText('Tip'), 'focus');
      expect(screen.getByLabelText('Tip 25 percent, $4.25')).toBeTruthy();
    });

    it('typing a tip by hand moves a matching total too', async () => {
      await noTipBill();
      type('Tip', '5.00');
      expect(valueOf('Total')).toBe('48.20');
    });

    it('chips are disabled with a hint until there is a subtotal or items', async () => {
      await openBill();
      expect(screen.getByText('Add the items or the subtotal to use a %.')).toBeTruthy();
      expect(chip('Tip 20 percent').props.accessibilityState).toMatchObject({ disabled: true });
      type('Subtotal', '10.00');
      expect(chip('Tip 20 percent, $2.00')).toBeTruthy();
    });
  });

  // Claimable discounts, criteria 42–44 in docs/specs/2026-11-24-claimable-discounts.md (Task 6).
  describe('claim like an item', () => {
    const CAPTION = 'People claim this like an item and can share it.';
    const claimSwitch = (n = 1) => screen.getByRole('switch', { name: `Discount ${n}: claim like an item` });
    const footerStatus = (): unknown => screen.getByLabelText(/^Totals check:/).props.accessibilityLabel;

    it('42: each discount row has one switch, off by default; on shows the caption, off hides it', async () => {
      await openBill();
      expect(screen.queryByRole('switch')).toBeNull();
      press('Add discount');
      press('Add discount');
      expect(screen.getAllByRole('switch')).toHaveLength(2);
      expect(claimSwitch(1).props.accessibilityState).toMatchObject({ checked: false });
      expect(screen.getAllByText('Claim like an item')).toHaveLength(2);
      expect(screen.queryByText(CAPTION)).toBeNull();

      fireEvent(claimSwitch(1), 'valueChange', true);
      expect(claimSwitch(1).props.accessibilityState).toMatchObject({ checked: true });
      expect(claimSwitch(2).props.accessibilityState).toMatchObject({ checked: false });
      expect(screen.getAllByText(CAPTION)).toHaveLength(1);

      fireEvent(claimSwitch(1), 'valueChange', false);
      expect(claimSwitch(1).props.accessibilityState).toMatchObject({ checked: false });
      expect(screen.queryByText(CAPTION)).toBeNull();
    });

    it('42: tapping the "Claim like an item" text also flips the switch', async () => {
      await openBill();
      press('Add discount');
      fireEvent.press(screen.getByText('Claim like an item'));
      expect(claimSwitch().props.accessibilityState).toMatchObject({ checked: true });
      expect(screen.getByText(CAPTION)).toBeTruthy();
    });

    it('42: a scanned discount arrives as Split, with the switch off', async () => {
      setScanResult(parseReceipt(getFixture('discount-before-subtotal').text));
      await openBill();
      expect(valueOf('Discount 1 label')).toBe('Happy Hour');
      expect(claimSwitch().props.accessibilityState).toMatchObject({ checked: false });
      expect(screen.queryByText(CAPTION)).toBeNull();
    });

    it('43: turning the switch on or off changes neither the banner nor the footer status', async () => {
      await openBill();
      addBurgerAndFries();
      press('Add discount');
      type('Discount 1 label', 'Police comp');
      type('Discount 1 amount', '5.00');
      type('Subtotal', '24.97');
      type('Total', '24.97');
      const before = footerStatus();
      expect(before).toBe('Totals check: Adds up');
      fireEvent(claimSwitch(), 'valueChange', true);
      expect(footerStatus()).toBe(before);
      expect(bannerShown()).toBe(false);
      fireEvent(claimSwitch(), 'valueChange', false);
      expect(footerStatus()).toBe(before);

      // Same with a mismatch: the switch moves no money.
      type('Total', '30.00');
      const mismatch = footerStatus();
      expect(bannerShown()).toBe(true);
      fireEvent(claimSwitch(), 'valueChange', true);
      expect(footerStatus()).toBe(mismatch);
      expect(bannerShown()).toBe(true);
    });

    it('44: the discount label field allows at most 100 characters', async () => {
      await openBill();
      press('Add discount');
      expect(screen.getByLabelText('Discount 1 label').props.maxLength).toBe(100);
    });

    it('42: works the same on web', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        await openBill();
        press('Add discount');
        fireEvent(claimSwitch(), 'valueChange', true);
        expect(screen.getByText(CAPTION)).toBeTruthy();
      } finally {
        os.restore();
      }
    });
  });

  it('works the same on web (no keyboard padding branch)', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      await openBill();
      addBurgerAndFries();
      expect(itemsLine('$29.97')).toBeTruthy();
      type('Subtotal', '29.99');
      expect(bannerShown()).toBe(true);
    } finally {
      os.restore();
    }
  });
});
