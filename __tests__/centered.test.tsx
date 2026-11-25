// Visual pass V2: centered loading/error states paint the theme background, so dark mode never
// shows the navigator's light default behind them.
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { Centered, Loading } from '@/components/Centered';
import { colors } from '@/lib/theme';

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

describe.each(['light', 'dark'] as const)('%s mode', (scheme) => {
  beforeEach(() => mockScheme.mockReturnValue(scheme));

  it('Centered paints the theme background', () => {
    render(
      <Centered>
        <Text>Message</Text>
      </Centered>,
    );
    // The root host view is Centered's container.
    expect(StyleSheet.flatten(screen.root.props.style)).toMatchObject({ backgroundColor: colors[scheme].background });
  });

  it('Loading keeps its label and uses the muted text color for the spinner', () => {
    render(<Loading />);
    const spinner = screen.getByLabelText('Loading');
    expect(spinner.props.color).toBe(colors[scheme].textMuted);
  });
});
