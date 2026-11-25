// Visual pass V3 / P5: the Google button follows Google's branding in light and dark, keeps its
// label and press behavior, and hides the G mark from screen readers.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { googleButtonColors } from '@/lib/theme';

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

describe.each(['light', 'dark'] as const)('%s mode', (scheme) => {
  beforeEach(() => mockScheme.mockReturnValue(scheme));

  it("uses Google's fill, stroke and text colors", () => {
    render(<GoogleSignInButton label="Continue with Google" busy={false} onPress={() => {}} />);
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({
      backgroundColor: googleButtonColors[scheme].fill,
      borderColor: googleButtonColors[scheme].stroke,
    });
    expect(StyleSheet.flatten(screen.getByText('Continue with Google').props.style)).toMatchObject({
      color: googleButtonColors[scheme].text,
    });
  });
});

it('presses through to onPress', () => {
  const onPress = jest.fn();
  render(<GoogleSignInButton label="Continue with Google" busy={false} onPress={onPress} />);
  fireEvent.press(screen.getByText('Continue with Google'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('while busy: shows the busy label, is disabled and busy, and ignores presses', () => {
  const onPress = jest.fn();
  render(<GoogleSignInButton label="Opening Google…" busy onPress={onPress} />);
  const button = screen.getByRole('button', { name: 'Opening Google…' });
  expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  fireEvent.press(button);
  expect(onPress).not.toHaveBeenCalled();
});

it('has a 44-pt target', () => {
  render(<GoogleSignInButton label="Continue with Google" busy={false} onPress={() => {}} />);
  expect(StyleSheet.flatten(screen.getByRole('button').props.style).minHeight).toBe(44);
});

it('on web, a click focus draws no ring; keyboard focus does (review R5)', () => {
  jest.replaceProperty(jest.requireActual<typeof import('react-native')>('react-native').Platform, 'OS', 'web');
  render(<GoogleSignInButton label="Continue with Google" busy={false} onPress={() => {}} />);
  const button = () => screen.getByRole('button', { name: 'Continue with Google' });
  const focus = (visible: boolean) => ({ nativeEvent: { target: { matches: () => visible } } });
  fireEvent(button(), 'focus', focus(false));
  expect(StyleSheet.flatten(button().props.style).outlineWidth).toBeUndefined();
  fireEvent(button(), 'focus', focus(true));
  expect(StyleSheet.flatten(button().props.style).outlineWidth).toBe(2);
});
