// Sent via Venmo, Task 12 (criterion 54): the primitive changes the Settle screen needs.
// SegmentedControl `disabled` + opt-in radio semantics, Button `flush: 'start' | 'end'`, and
// TextLink `minWidth` / `disabled` / `loading`. Each new option is opt-in: the default cases below
// pin today's behaviour so BillForm, TipOptions, SettleCard, SettlePeopleList and SettleFooter
// look and read the same as before.
import { fireEvent, render, screen } from '@testing-library/react-native';
import Plus from 'lucide-react-native/icons/plus';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { TextLink } from '@/components/ui/TextLink';
import { colors, opacity, TOUCH_TARGET } from '@/lib/theme';

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

beforeEach(() => mockScheme.mockReturnValue('light'));

const flat = (style: unknown): Record<string, unknown> => (StyleSheet.flatten(style as never) as Record<string, unknown> | undefined) ?? {};

type Node = { props: { style?: unknown }; parent: Node | null };
/** The nearest ancestor whose own style sets `key`. */
function ancestorStyle(node: unknown, key: string): Record<string, unknown> {
  for (let n: Node | null = (node as Node).parent; n; n = n.parent) {
    const s = flat(n.props.style);
    if (key in s) return s;
  }
  throw new Error(`no ancestor sets ${key}`);
}

const methods = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'cash', label: 'Cash' },
] as const;

describe('SegmentedControl: defaults unchanged', () => {
  it('segments stay buttons with `selected`; the track has no role and no disabled state', () => {
    render(<SegmentedControl options={methods} value="venmo" onChange={() => {}} />);
    const venmo = screen.getByRole('button', { name: 'Venmo' });
    expect(venmo.props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByRole('button', { name: 'Cash' }).props.accessibilityState).toEqual({ selected: false });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    // The track (the View with the inset padding): full opacity by default.
    expect(ancestorStyle(venmo, 'padding').opacity).toBeUndefined();
  });
});

describe('SegmentedControl: radio semantics (opt-in)', () => {
  it('the track is a radiogroup with the group label; segments are radios with `checked`', () => {
    const onChange = jest.fn();
    render(<SegmentedControl options={methods} value="venmo" onChange={onChange} semantics="radio" groupLabel="How you're paying" />);
    // The track isn't `accessible` (that would merge its radios into one element on native), so
    // getByRole can't see it: assert its role and label directly.
    expect(screen.getByLabelText("How you're paying").props.accessibilityRole).toBe('radiogroup');
    expect(screen.getByRole('radio', { name: 'Venmo', checked: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Cash', checked: false })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // `selected` isn't set alongside `checked`: one state per role.
    expect(screen.getByRole('radio', { name: 'Venmo' }).props.accessibilityState.selected).toBeUndefined();
    fireEvent.press(screen.getByRole('radio', { name: 'Cash' }));
    expect(onChange).toHaveBeenCalledWith('cash');
  });

  it('keeps the selected look and the 44-pt target', () => {
    render(<SegmentedControl options={methods} value="cash" onChange={() => {}} semantics="radio" groupLabel="How you're paying" />);
    const cash = screen.getByRole('radio', { name: 'Cash' });
    expect(flat(cash.props.style).backgroundColor).toBe(colors.light.primary);
    const s = flat(cash.props.style);
    expect(s.minWidth).toBe(TOUCH_TARGET);
    expect((s.minHeight as number) + cash.props.hitSlop.top + cash.props.hitSlop.bottom).toBe(TOUCH_TARGET);
  });
});

describe('SegmentedControl: large text fits its parent (QA N1)', () => {
  it.each(['button', 'radio'] as const)('the hugging track caps at its parent, shrinks and wraps; segments shrink to 44 pt (%s)', (semantics) => {
    render(<SegmentedControl options={methods} value="venmo" onChange={() => {}} semantics={semantics} groupLabel="How you're paying" />);
    const venmo = screen.getByRole(semantics, { name: 'Venmo' });
    const track = ancestorStyle(venmo, 'padding');
    expect(track).toMatchObject({ maxWidth: '100%', flexShrink: 1, flexWrap: 'wrap', alignSelf: 'flex-start' });
    const seg = flat(venmo.props.style);
    expect(seg).toMatchObject({ flexShrink: 1, flexGrow: 1, minWidth: TOUCH_TARGET });
    expect(seg.flex).toBeUndefined(); // still hugs its label at normal sizes (SV-VIS-1)
    expect(flat(screen.getByText('Venmo').props.style).flexShrink).toBe(1); // the label wraps inside
  });
});

describe('SegmentedControl: disabled', () => {
  it.each(['button', 'radio'] as const)('dims the whole control, blocks presses and announces it (%s)', (semantics) => {
    const onChange = jest.fn();
    render(<SegmentedControl options={methods} value="venmo" onChange={onChange} disabled semantics={semantics} groupLabel="How you're paying" />);
    const cash = screen.getByRole(semantics, { name: 'Cash' });
    expect(cash.props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByRole(semantics, { name: 'Venmo' }).props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(cash);
    expect(onChange).not.toHaveBeenCalled();
    expect(ancestorStyle(cash, 'padding').opacity).toBe(opacity.disabled);
  });
});

describe('Button flush', () => {
  it('true: unchanged (no side padding, 44 × 44 box, centred label)', () => {
    render(<Button label="Undo" variant="ghost" flush onPress={() => {}} />);
    expect(flat(screen.getByRole('button', { name: 'Undo' }).props.style)).toMatchObject({ paddingHorizontal: 0, minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET });
    expect(flat(screen.getByText('Undo').props.style).textAlign).toBe('center');
    expect(ancestorStyle(screen.getByText('Undo'), 'justifyContent').justifyContent).toBe('center');
  });

  it('not flush: unchanged (side padding, centred)', () => {
    render(<Button label="Save" onPress={() => {}} />);
    expect(flat(screen.getByRole('button', { name: 'Save' }).props.style).paddingHorizontal).toBeGreaterThan(0);
    expect(flat(screen.getByText('Save').props.style).textAlign).toBe('center');
  });

  it.each([
    ['start', 'flex-start', 'left'],
    ['end', 'flex-end', 'right'],
  ] as const)("'%s': label on that edge, still a 44 × 44 box with no side padding", (flush, justify, align) => {
    render(<Button label="Yes" variant="ghost" flush={flush} onPress={() => {}} />);
    expect(flat(screen.getByRole('button', { name: 'Yes' }).props.style)).toMatchObject({ paddingHorizontal: 0, minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET });
    expect(flat(screen.getByText('Yes').props.style).textAlign).toBe(align);
    expect(ancestorStyle(screen.getByText('Yes'), 'justifyContent').justifyContent).toBe(justify);
  });
});

describe('TextLink', () => {
  it('is at least 44 wide and 44 tall, label leading', () => {
    render(<TextLink label="Not received" onPress={() => {}} />);
    const s = flat(screen.getByRole('button', { name: 'Not received' }).props.style);
    expect(s).toMatchObject({ minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET });
    expect(s.justifyContent).toBeUndefined();
  });

  it('default: the caller’s accessibilityState passes through untouched, full opacity, presses through', () => {
    const onPress = jest.fn();
    render(<TextLink label="Show QR code" accessibilityState={{ expanded: false }} onPress={onPress} />);
    const link = screen.getByRole('button', { name: 'Show QR code' });
    expect(link.props.accessibilityState).toEqual({ expanded: false });
    expect(flat(link.props.style).opacity).toBeUndefined();
    fireEvent.press(link);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled: dimmed, announced, ignores presses', () => {
    const onPress = jest.fn();
    render(<TextLink label="Not received" disabled onPress={onPress} />);
    const link = screen.getByRole('button', { name: 'Not received' });
    expect(link.props.accessibilityState).toMatchObject({ disabled: true });
    expect(flat(link.props.style).opacity).toBe(opacity.disabled);
    fireEvent.press(link);
    expect(onPress).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'] as const)('loading: a small primary spinner instead of the icon, busy and disabled (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    const onPress = jest.fn();
    render(<TextLink label="Not received" icon={Plus} loading accessibilityState={{ expanded: true }} onPress={onPress} />);
    const link = screen.getByRole('button', { name: 'Not received' });
    expect(screen.UNSAFE_getByType(ActivityIndicator).props).toMatchObject({ size: 'small', color: colors[scheme].primary });
    expect(screen.UNSAFE_queryAllByType(Plus)).toHaveLength(0);
    expect(link.props.accessibilityState).toMatchObject({ busy: true, disabled: true, expanded: true });
    expect(screen.getByText('Not received')).toBeTruthy();
    fireEvent.press(link);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('no spinner unless loading', () => {
    render(<TextLink label="Tip options" onPress={() => {}} />);
    expect(screen.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  });
});
