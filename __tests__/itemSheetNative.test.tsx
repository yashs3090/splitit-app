// Proposal P6 (visual pass V15): on iOS the item sheet is the system page sheet, which the person
// can swipe down to close (RN reports that through onRequestClose when allowSwipeDismissal is set).
// Android and web keep the bottom sheet over a scrim: tapping the scrim or Android's back button
// closes it. "Done" closes it everywhere. Behavior of the sheet's contents is in itemSheet.test.tsx.
import { fireEvent, render, screen } from '@testing-library/react-native';
import Minus from 'lucide-react-native/icons/minus';
import Plus from 'lucide-react-native/icons/plus';
import { Modal, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ItemSheet, type SheetClaimer } from '@/components/ItemSheet';

const person = (userId: string, name: string, isMe: boolean) => ({ userId, name, initials: name.slice(0, 2).toUpperCase(), isMe });
const CLAIMERS: SheetClaimer[] = [
  { person: person('a', 'You', true), cents: 300, parts: 1 },
  { person: person('b', 'Sam', false), cents: 300, parts: 1 },
];

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

function renderSheet(onClose = jest.fn(), claimers: SheetClaimer[] = CLAIMERS) {
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
