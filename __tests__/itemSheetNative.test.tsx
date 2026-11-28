// Proposal P6 (visual pass V15): on iOS the item sheet is the system page sheet, which the person
// can swipe down to close (RN reports that through onRequestClose when allowSwipeDismissal is set).
// Android and web keep the bottom sheet over a scrim: tapping the scrim or Android's back button
// closes it. "Done" closes it everywhere. Behavior of the sheet's contents is in itemSheet.test.tsx.
import { fireEvent, render, screen } from '@testing-library/react-native';
import Minus from 'lucide-react-native/icons/minus';
import Plus from 'lucide-react-native/icons/plus';
import { Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ItemSheet, type SheetAssign, type SheetClaimer } from '@/components/ItemSheet';

// The sheet's group-bill writes import lib/groups (and so the Supabase client): use the fake.
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const person = (userId: string, name: string, isMe: boolean) => ({ userId, name, initials: name.slice(0, 2).toUpperCase(), isMe });
const CLAIMERS: SheetClaimer[] = [
  { person: person('a', 'You', true), cents: 300, parts: 1 },
  { person: person('b', 'Sam', false), cents: 300, parts: 1 },
];

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const GROUP: SheetAssign = {
  lineItemId: '22222222-0000-4000-8000-000000000002',
  members: [CLAIMERS[0]!.person, CLAIMERS[1]!.person],
  current: { a: 1, b: 1 },
  refetch: () => 1,
  version: 0,
  finished: 0,
};

function renderSheet(onClose = jest.fn(), claimers: SheetClaimer[] = CLAIMERS, assign?: SheetAssign) {
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ItemSheet
        label="Fries"
        priceCents={600}
        status="Split 2 ways · $3.00 each"
        claimers={claimers}
        canEdit
        custom={false}
        saving={false}
        error={null}
        onSave={() => {}}
        onClose={onClose}
        assign={assign}
      />
    </SafeAreaProvider>,
  );
  return onClose;
}

describe('on iOS: a native page sheet', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

  it('is presented as a page sheet that a swipe can dismiss, with no custom scrim', () => {
    renderSheet();
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props).toMatchObject({ presentationStyle: 'pageSheet', allowSwipeDismissal: true, animationType: 'slide' });
    expect(modal.props.transparent).toBeFalsy();
    // The system dims what's behind; there is no drawn scrim button.
    expect(screen.queryByLabelText('Close', { includeHiddenElements: true })).toBeNull();
  });

  it('while a split is being edited, swipe-to-close is off; Cancel turns it back on', () => {
    renderSheet();
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    expect(screen.UNSAFE_getByType(Modal).props.allowSwipeDismissal).toBe(false);
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.UNSAFE_getByType(Modal).props.allowSwipeDismissal).toBe(true);
  });

  it('a swipe down (onRequestClose) closes it', () => {
    const onClose = renderSheet();
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe.each(['android', 'web'] as const)('on %s: the bottom sheet over a scrim', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('tapping the scrim closes it', () => {
    const onClose = renderSheet();
    expect(screen.UNSAFE_getByType(Modal).props.transparent).toBe(true);
    // The sheet is marked modal for VoiceOver, so the scrim counts as hidden to the query.
    fireEvent.press(screen.getByLabelText('Close', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the back button (onRequestClose) closes it', () => {
    const onClose = renderSheet();
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe.each(['ios', 'android', 'web'] as const)('on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('"Done" closes it', () => {
    const onClose = renderSheet();
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the parts stepper uses Minus/Plus icons in 44-pt buttons, with the same labels', () => {
    renderSheet();
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    expect(screen.getByRole('button', { name: 'More parts for Sam' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fewer parts for Sam' }).props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.UNSAFE_getAllByType(Plus)).toHaveLength(2);
    expect(screen.UNSAFE_getAllByType(Minus)).toHaveLength(2);
    expect(screen.queryByText(/^[−+]$/)).toBeNull();
  });
});

it('"More parts" is disabled at 20 parts (the maximum)', () => {
  renderSheet(jest.fn(), [CLAIMERS[0]!, { ...CLAIMERS[1]!, parts: 20 }]);
  fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
  expect(screen.getByRole('button', { name: 'More parts for Sam' }).props.accessibilityState).toMatchObject({ disabled: true });
  expect(screen.getByRole('button', { name: 'More parts for You' }).props.accessibilityState).toMatchObject({ disabled: false });
});

describe('a group bill (T18) keeps the same sheet on each platform', () => {
  it('on iOS: the page sheet, swipe-to-close off only while a split is being edited', () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    renderSheet(jest.fn(), CLAIMERS, GROUP);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.UNSAFE_getByType(Modal).props).toMatchObject({ presentationStyle: 'pageSheet', allowSwipeDismissal: true });
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    expect(screen.UNSAFE_getByType(Modal).props.allowSwipeDismissal).toBe(false);
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.UNSAFE_getByType(Modal).props.allowSwipeDismissal).toBe(true);
  });

  it.each(['android', 'web'] as const)('on %s: the scrim closes it, and the stepper is the same IconButtons', (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    const onClose = renderSheet(jest.fn(), CLAIMERS, GROUP);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    fireEvent.press(screen.getByRole('button', { name: 'Split differently' }));
    expect(screen.getByRole('button', { name: 'More parts for Sam' })).toBeTruthy();
    expect(screen.UNSAFE_getAllByType(Plus).length).toBeGreaterThanOrEqual(2);
    fireEvent.press(screen.getByLabelText('Close', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

it('without `assign` there are no chips and no "Who had this?" (criterion 85)', () => {
  renderSheet();
  expect(screen.getByLabelText('Sam $3.00')).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByText('Who had this?')).toBeNull();
});
