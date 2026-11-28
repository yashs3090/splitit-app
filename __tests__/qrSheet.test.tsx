// components/QrSheet.tsx: the invite QR popup. iOS: the system page sheet (swipe down closes);
// Android and web: a bottom sheet over a scrim (tap outside or the back button / Escape closes).
// "Done" closes it everywhere. Shows the title, a large QR of exactly the link, the link itself and
// Copy link with its "Link copied" line. Focus lands on the title and returns to the trigger.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { createRef, useRef, useState } from 'react';
import { AccessibilityInfo, Dimensions, Modal, Platform, Pressable, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { QrSheet } from '@/components/QrSheet';
import { INVITE_QR_COPY, qrTileLayout } from '@/lib/inviteQr';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const URL_A = 'https://splitit-app-kappa.vercel.app/g/0123456789abcdef0123';
const URL_B = 'https://splitit-app-kappa.vercel.app/g/fedcba9876543210fedc';
const TITLE = 'Scan to join Tahoe trip';
const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

/** A trigger and the sheet, as SharePanel and GroupInvite wire them. */
function Harness({ url = URL_A }: { url?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  return (
    <>
      <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={INVITE_QR_COPY.show} onPress={() => setOpen(true)}>
        <Text>{INVITE_QR_COPY.show}</Text>
      </Pressable>
      <QrSheet visible={open} title={TITLE} url={url} onClose={() => setOpen(false)} returnFocusTo={trigger} />
    </>
  );
}

function renderHarness(url = URL_A) {
  const view = render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <Harness url={url} />
    </SafeAreaProvider>,
  );
  return {
    ...view,
    rerenderUrl: (next: string) =>
      view.rerender(
        <SafeAreaProvider initialMetrics={METRICS}>
          <Harness url={next} />
        </SafeAreaProvider>,
      ),
  };
}

/** The props of the host instance sendAccessibilityEvent got (the test renderer's stand-in). */
const propsOf = (target: unknown) => (target as { props: Record<string, unknown> }).props;
const open = () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.show }));
const modal = () => screen.UNSAFE_getByType(Modal);
const qr = () => screen.UNSAFE_getByType(QRCode).props as { value: string; size: number; color: string; backgroundColor: string };

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

describe.each(['ios', 'android', 'web'] as const)('on %s', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('is closed until opened, then shows the title (a header), the QR of exactly the link, the link and Copy link', () => {
    renderHarness();
    expect(modal().props.visible).toBe(false);
    expect(screen.queryByText(TITLE)).toBeNull();
    open();
    expect(modal().props.visible).toBe(true);
    expect(screen.getByRole('header', { name: TITLE })).toBeTruthy();
    expect(screen.getByRole('image', { name: INVITE_QR_COPY.imageLabel })).toBeTruthy();
    expect(qr().value).toBe(URL_A);
    const link = screen.getByLabelText(`Invite link ${URL_A}`);
    expect(link.props).toMatchObject({ selectable: true, numberOfLines: 1, ellipsizeMode: 'middle' });
    expect(screen.getByText(INVITE_QR_COPY.caption)).toBeTruthy();
    expect(screen.getByRole('button', { name: INVITE_QR_COPY.copy })).toBeTruthy();
  });

  it('the QR is as big as fits a 390-pt phone, dark on white', () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    renderHarness();
    open();
    expect(qr().size).toBe(qrTileLayout(390, 844).size);
    expect(qr().size).toBeGreaterThan(200);
    expect(qr()).toMatchObject({ color: '#111827', backgroundColor: '#FFFFFF' });
  });

  it('Copy link copies the link and says "Link copied"; a failed copy says what to do', async () => {
    renderHarness();
    open();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.copy })));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(URL_A);
    expect(screen.getByText(INVITE_QR_COPY.copied)).toBeTruthy();
    jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    await act(async () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.copy })));
    expect(screen.getByRole('alert', { name: INVITE_QR_COPY.copyFailed })).toBeTruthy();
  });

  it('"Done" closes it, and "Link copied" is gone the next time it opens', async () => {
    renderHarness();
    open();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.copy })));
    fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.done }));
    expect(modal().props.visible).toBe(false);
    open();
    expect(screen.queryByText(INVITE_QR_COPY.copied)).toBeNull();
  });

  it('a new link while open redraws the QR and the link, and drops the old "Link copied"', async () => {
    const { rerenderUrl } = renderHarness();
    open();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.copy })));
    rerenderUrl(URL_B);
    expect(qr().value).toBe(URL_B);
    expect(screen.getByLabelText(`Invite link ${URL_B}`)).toBeTruthy();
    expect(screen.queryByText(INVITE_QR_COPY.copied)).toBeNull();
  });

  it('the back button / swipe / Escape (onRequestClose) closes it', () => {
    renderHarness();
    open();
    act(() => modal().props.onRequestClose());
    expect(modal().props.visible).toBe(false);
  });
});

describe('on iOS: the system page sheet', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

  it('is a page sheet that a swipe can dismiss, with no drawn scrim', () => {
    renderHarness();
    open();
    expect(modal().props).toMatchObject({ presentationStyle: 'pageSheet', allowSwipeDismissal: true, animationType: 'slide' });
    expect(modal().props.transparent).toBeFalsy();
    expect(screen.queryByLabelText(INVITE_QR_COPY.close, { includeHiddenElements: true })).toBeNull();
  });

  it('moves VoiceOver to the title on show, and back to the trigger once it has slid away', () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
    renderHarness();
    open();
    act(() => modal().props.onShow());
    expect(focus).toHaveBeenLastCalledWith(expect.anything(), 'focus');
    expect(propsOf(focus.mock.calls[0]?.[0])).toMatchObject({ accessibilityRole: 'header', children: TITLE });

    fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.done }));
    // Not yet: the sheet is still animating away.
    expect(focus).toHaveBeenCalledTimes(1);
    act(() => modal().props.onDismiss());
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus.mock.calls[1]?.[1]).toBe('focus');
    expect(propsOf(focus.mock.calls[1]?.[0])).toMatchObject({ accessibilityLabel: INVITE_QR_COPY.show });
    focus.mockRestore();
  });

  it('announces "Link copied" (VoiceOver ignores live regions)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    renderHarness();
    open();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.copy })));
    expect(announce).toHaveBeenCalledWith(INVITE_QR_COPY.copied);
    announce.mockRestore();
  });
});

describe.each(['android', 'web'] as const)('on %s: a bottom sheet over a scrim', (os) => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', os));

  it('tapping the scrim closes it', () => {
    renderHarness();
    open();
    expect(modal().props.transparent).toBe(true);
    // The sheet is marked modal for screen readers, so the scrim counts as hidden to the query.
    const scrim = screen.getByLabelText(INVITE_QR_COPY.close, { includeHiddenElements: true });
    // Not a Tab stop on web: the focus trap lands inside the sheet; Escape closes it instead.
    expect(scrim.props.focusable).toBe(false);
    fireEvent.press(scrim);
    expect(modal().props.visible).toBe(false);
  });
});

it('on Android, focus goes to the title on show and back to the trigger when it closes', () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
  renderHarness();
  open();
  act(() => modal().props.onShow());
  expect(focus).toHaveBeenCalledTimes(1);
  expect(propsOf(focus.mock.calls[0]?.[0])).toMatchObject({ accessibilityRole: 'header', children: TITLE });
  fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.done }));
  expect(focus).toHaveBeenCalledTimes(2);
  expect(focus.mock.calls[1]?.[1]).toBe('focus');
  expect(propsOf(focus.mock.calls[1]?.[0])).toMatchObject({ accessibilityLabel: INVITE_QR_COPY.show });
  focus.mockRestore();
});

it('on web, focus is left to the Modal (its focus trap moves in and restores the opener)', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
  renderHarness();
  open();
  act(() => modal().props.onShow?.());
  fireEvent.press(screen.getByRole('button', { name: INVITE_QR_COPY.done }));
  expect(focus).not.toHaveBeenCalled();
  focus.mockRestore();
});

it('renders without a SafeAreaProvider (panels rendered alone)', () => {
  const ref = createRef<View>();
  render(<QrSheet visible title={TITLE} url={URL_A} onClose={() => {}} returnFocusTo={ref} />);
  expect(screen.getByRole('header', { name: TITLE })).toBeTruthy();
});
