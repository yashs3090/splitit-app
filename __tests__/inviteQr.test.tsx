// Invite QR in the share panel: "Show QR code" reveals a QR of exactly the invite link, "Hide QR
// code" folds it away, a new link redraws it, and the tile stays dark-on-light in dark mode so it
// scans. Decisions: docs/decisions-to-review.md ("Invite QR").
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { INVITE_QR_COPY } from '@/components/InviteQr';
import { SharePanel } from '@/components/SharePanel';
import { colors, qrColors } from '@/lib/theme';

const URL_A = 'https://splitit-app-kappa.vercel.app/b/0123456789abcdef0123';
const URL_B = 'https://splitit-app-kappa.vercel.app/b/fedcba9876543210fedc';

/** WCAG 2.x contrast of two #RRGGBB colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function panel(url: string, isHost = true) {
  return <SharePanel url={url} isHost={isHost} onRotate={jest.fn(async () => true)} />;
}

const qrValue = () => screen.UNSAFE_getByType(QRCode).props.value as string;
const toggle = (name: string) => screen.getByRole('button', { name });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Show QR code toggle', () => {
  it('starts folded: a quiet toggle, no QR and no caption', () => {
    render(panel(URL_A));
    const show = toggle(INVITE_QR_COPY.show);
    expect(show.props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    expect(show.props.accessibilityHint).toBe(INVITE_QR_COPY.showHint);
    expect(screen.UNSAFE_queryAllByType(QRCode)).toHaveLength(0);
    expect(screen.queryByText(INVITE_QR_COPY.caption)).toBeNull();
  });

  it('shows the QR of exactly the invite link, with its caption, then hides it again', () => {
    render(panel(URL_A));
    fireEvent.press(toggle(INVITE_QR_COPY.show));

    expect(qrValue()).toBe(URL_A);
    expect(screen.getByText(INVITE_QR_COPY.caption)).toBeTruthy();
    expect(screen.getByRole('image', { name: INVITE_QR_COPY.imageLabel })).toBeTruthy();
    const hide = toggle(INVITE_QR_COPY.hide);
    expect(hide.props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    // One control: the same toggle now reads "Hide QR code".
    expect(screen.queryByRole('button', { name: INVITE_QR_COPY.show })).toBeNull();

    fireEvent.press(hide);
    expect(screen.UNSAFE_queryAllByType(QRCode)).toHaveLength(0);
    expect(screen.queryByText(INVITE_QR_COPY.caption)).toBeNull();
    expect(toggle(INVITE_QR_COPY.show)).toBeTruthy();
  });

  it('keeps the link text selectable and copyable while the QR shows', () => {
    render(panel(URL_A));
    fireEvent.press(toggle(INVITE_QR_COPY.show));
    const link = screen.getByLabelText(`Invite link ${URL_A}`);
    expect(link.props.selectable).toBe(true);
    expect(screen.getByText('Copy link')).toBeTruthy();
  });

  it('redraws for a new link and stays open (host made a new link)', () => {
    const { rerender } = render(panel(URL_A));
    fireEvent.press(toggle(INVITE_QR_COPY.show));
    expect(qrValue()).toBe(URL_A);

    rerender(panel(URL_B));
    expect(qrValue()).toBe(URL_B);
    expect(toggle(INVITE_QR_COPY.hide)).toBeTruthy();
  });

  it('is there for guests too: any participant can share the link', () => {
    render(panel(URL_A, false));
    fireEvent.press(toggle(INVITE_QR_COPY.show));
    expect(qrValue()).toBe(URL_A);
  });
});

describe('QR tile colors', () => {
  it.each(['light', 'dark'] as const)('draws dark modules on a light quiet zone in %s mode', (scheme) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(scheme);
    render(panel(URL_A));
    fireEvent.press(toggle(INVITE_QR_COPY.show));
    const props = screen.UNSAFE_getByType(QRCode).props as { color: string; backgroundColor: string };
    expect(props.color).toBe(qrColors.module);
    expect(props.backgroundColor).toBe(qrColors.background);
    // The caption under the tile follows the theme.
    const caption = screen.getByText(INVITE_QR_COPY.caption);
    expect(caption).toHaveStyle({ color: colors[scheme].textMuted });
  });

  it('fixed QR colors contrast strongly (scanners need dark on light)', () => {
    expect(contrast(qrColors.module, qrColors.background)).toBeGreaterThanOrEqual(15);
  });
});
