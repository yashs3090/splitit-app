// Review R3/R9 (visual pass V13): the host's tax-and-tip selector shows its open/closed state with
// a chevron icon next to the words (no ▴/▾ glyphs), keeps its semantics, and draws the shared
// focus ring.
import { fireEvent, render, screen } from '@testing-library/react-native';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import { StyleSheet } from 'react-native';

import { EXTRAS_SPLIT_LABEL, ExtrasSplitControl } from '@/components/ExtrasSplitControl';
import { colors } from '@/lib/theme';

const GLYPHS = /[▴▾✓]/;
const toggle = () => screen.getByRole('button', { name: EXTRAS_SPLIT_LABEL });

it('closed: "Change" with a down chevron, no glyph', () => {
  render(<ExtrasSplitControl mode="proportional" isHost onChange={() => {}} />);
  expect(toggle().props.accessibilityState).toMatchObject({ expanded: false });
  // The words are hidden from screen readers (the button's label and value carry them).
  expect(screen.getByText('Change', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.UNSAFE_getAllByType(ChevronDown)).toHaveLength(1);
  expect(screen.queryByText(GLYPHS, { includeHiddenElements: true })).toBeNull();
});

it('expanded as the host: "Done" with an up chevron, two radio options, no glyph', () => {
  render(<ExtrasSplitControl mode="proportional" isHost onChange={() => {}} />);
  fireEvent.press(toggle());
  expect(toggle().props.accessibilityState).toMatchObject({ expanded: true });
  expect(screen.getByText('Done', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.UNSAFE_getAllByType(ChevronUp)).toHaveLength(1);
  expect(screen.UNSAFE_queryAllByType(ChevronDown)).toHaveLength(0);
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  expect(screen.queryByText(GLYPHS, { includeHiddenElements: true })).toBeNull();
});

it('choosing the other option reports it and closes', () => {
  const onChange = jest.fn();
  render(<ExtrasSplitControl mode="proportional" isHost onChange={onChange} />);
  fireEvent.press(toggle());
  fireEvent.press(screen.getByRole('radio', { name: 'Split evenly' }));
  expect(onChange).toHaveBeenCalledWith('equal');
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
});

it('the selector and its options draw the shared focus ring', () => {
  render(<ExtrasSplitControl mode="proportional" isHost onChange={() => {}} />);
  fireEvent(toggle(), 'focus');
  expect(StyleSheet.flatten(toggle().props.style)).toMatchObject({ outlineWidth: 2, outlineColor: colors.light.focus });
  fireEvent.press(toggle());
  const option = screen.getByRole('radio', { name: 'Split evenly' });
  fireEvent(option, 'focus');
  expect(StyleSheet.flatten(screen.getByRole('radio', { name: 'Split evenly' }).props.style)).toMatchObject({ outlineWidth: 2 });
});

it('guests see the line as plain text, with no selector', () => {
  render(<ExtrasSplitControl mode="proportional" isHost={false} onChange={() => {}} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('Change', { includeHiddenElements: true })).toBeNull();
});
