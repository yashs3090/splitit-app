// Visual pass V4: the new components/ui primitives. Each keeps its accessibility contract (role,
// label, state), a 44-pt target where it's tappable, and theme colors in light and dark.
import { fireEvent, render, screen } from '@testing-library/react-native';
import Check from 'lucide-react-native/icons/check';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Info from 'lucide-react-native/icons/info';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import Plus from 'lucide-react-native/icons/plus';
import X from 'lucide-react-native/icons/x';
import { StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ListRow } from '@/components/ui/ListRow';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusLine } from '@/components/ui/StatusLine';
import { TextLink } from '@/components/ui/TextLink';
import { colors, ICON_STROKE, iconSize, ROW_MIN_HEIGHT, TOUCH_TARGET } from '@/lib/theme';

// Some components import lib modules that reach the Supabase client; use the shared fake.
jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});

const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));

beforeEach(() => mockScheme.mockReturnValue('light'));

const flat = (style: unknown): Record<string, unknown> => (StyleSheet.flatten(style as never) as Record<string, unknown> | undefined) ?? {};

type Node = { props: { style?: unknown }; parent: Node | null };
/** The nearest ancestor whose own style sets `key`. */
function ancestorStyle(node: Node, key: string): Record<string, unknown> {
  for (let n: Node | null = node.parent; n; n = n.parent) {
    const s = flat(n.props.style) as Record<string, unknown>;
    if (key in s) return s;
  }
  throw new Error(`no ancestor sets ${key}`);
}

describe('Icon', () => {
  it('uses the theme size and stroke, and is hidden from screen readers', () => {
    render(<Icon icon={Plus} size="sm" color="#123456" />);
    const svg = screen.UNSAFE_getByType(Plus);
    expect(svg.props).toMatchObject({
      size: iconSize.sm,
      strokeWidth: ICON_STROKE,
      color: '#123456',
      accessible: false,
      importantForAccessibility: 'no-hide-descendants',
      accessibilityElementsHidden: true,
    });
  });

  it('defaults to md and the theme text color', () => {
    mockScheme.mockReturnValue('dark');
    render(<Icon icon={Plus} />);
    expect(screen.UNSAFE_getByType(Plus).props).toMatchObject({ size: iconSize.md, color: colors.dark.text });
  });
});

describe('IconButton', () => {
  it('is a labelled 44×44 button that presses through', () => {
    const onPress = jest.fn();
    render(<IconButton icon={X} accessibilityLabel="Remove item 1" accessibilityHint="Removes this item" onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Remove item 1' });
    expect(button.props.accessibilityHint).toBe('Removes this item');
    expect(flat(button.props.style)).toMatchObject({ width: TOUCH_TARGET, height: TOUCH_TARGET });
    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled: announces it and ignores presses', () => {
    const onPress = jest.fn();
    render(<IconButton icon={X} accessibilityLabel="Remove" onPress={onPress} disabled />);
    const button = screen.getByRole('button', { name: 'Remove' });
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('draws the theme focus ring only while focused', () => {
    render(<IconButton icon={X} accessibilityLabel="Remove" onPress={() => {}} />);
    const button = () => screen.getByRole('button', { name: 'Remove' });
    expect(flat(button().props.style).outlineWidth).toBeUndefined();
    fireEvent(button(), 'focus');
    expect(flat(button().props.style)).toMatchObject({ outlineWidth: 2, outlineColor: colors.light.focus });
    fireEvent(button(), 'blur');
    expect(flat(button().props.style).outlineWidth).toBeUndefined();
  });
});

describe('TextLink', () => {
  it('shows its label in the primary color with a 44-pt target, and presses through', () => {
    const onPress = jest.fn();
    render(<TextLink label="Add note" accessibilityLabel="Add note to item 2" icon={Plus} onPress={onPress} />);
    const link = screen.getByRole('button', { name: 'Add note to item 2' });
    expect(flat(link.props.style).minHeight).toBe(TOUCH_TARGET);
    expect(flat(screen.getByText('Add note').props.style).color).toBe(colors.light.primary);
    fireEvent.press(link);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('without an accessibilityLabel, the visible label is what is read', () => {
    render(<TextLink label="Tip options" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Tip options' })).toBeTruthy();
  });
});

describe('SectionHeader', () => {
  it.each(['light', 'dark'] as const)('is a header in muted text (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<SectionHeader title="Discounts" />);
    const header = screen.getByRole('header', { name: 'Discounts' });
    expect(flat(header.props.style)).toMatchObject({ color: colors[scheme].textMuted, fontWeight: '600', fontSize: 13 });
  });
});

describe('StatusLine', () => {
  it('success: check icon, success color, polite live region', () => {
    render(<StatusLine text="Saved" />);
    const text = screen.getByText('Saved');
    expect(text.props.accessibilityLiveRegion).toBe('polite');
    expect(flat(text.props.style).color).toBe(colors.light.success);
  });

  it('error: danger color', () => {
    mockScheme.mockReturnValue('dark');
    render(<StatusLine text="Couldn't copy" tone="error" />);
    expect(flat(screen.getByText("Couldn't copy").props.style).color).toBe(colors.dark.danger);
  });
});

describe('ListRow', () => {
  it('a static row is not a button and shows title, caption and slots', () => {
    render(<ListRow title="Sam" caption="Joined" leading={<Text>S</Text>} trailing={<Text>$12.00</Text>} />);
    expect(screen.queryByRole('button')).toBeNull();
    for (const t of ['Sam', 'Joined', 'S', '$12.00']) expect(screen.getByText(t)).toBeTruthy();
  });

  it('a tappable row is one button with the given label and hint', () => {
    const onPress = jest.fn();
    render(<ListRow title="Dinner" onPress={onPress} accessibilityLabel="Dinner, $48.00, 3 people" accessibilityHint="Opens the bill" />);
    const row = screen.getByRole('button', { name: 'Dinner, $48.00, 3 people' });
    expect(row.props.accessibilityHint).toBe('Opens the bill');
    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('rows are at least 56 high, and only rows after the first draw a hairline', () => {
    render(
      <>
        <ListRow title="First" />
        <ListRow title="Second" divider />
      </>,
    );
    const content = (t: string) => ancestorStyle(screen.getByText(t) as unknown as Node, 'minHeight');
    expect(content('First').minHeight).toBe(ROW_MIN_HEIGHT);
    expect(content('First').borderTopWidth).toBeUndefined();
    expect(content('Second')).toMatchObject({ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.light.divider });
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'subtotal', label: 'Before subtotal', accessibilityLabel: 'Discount 1 before subtotal' },
    { value: 'total', label: 'After subtotal', accessibilityLabel: 'Discount 1 after subtotal' },
  ] as const;

  it('marks only the current option selected and reports the pressed one', () => {
    const onChange = jest.fn();
    render(<SegmentedControl options={options} value="subtotal" onChange={onChange} stretch />);
    expect(screen.getByRole('button', { name: 'Discount 1 before subtotal' }).props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByRole('button', { name: 'Discount 1 after subtotal' }).props.accessibilityState).toMatchObject({ selected: false });
    fireEvent.press(screen.getByRole('button', { name: 'Discount 1 after subtotal' }));
    expect(onChange).toHaveBeenCalledWith('total');
  });

  it.each(['light', 'dark'] as const)('selected is tinted, bold and primary; unselected is plain (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<SegmentedControl options={[{ value: 'percent', label: '%' }, { value: 'dollars', label: '$' }]} value="dollars" onChange={() => {}} />);
    expect(flat(screen.getByText('$').props.style)).toMatchObject({ color: colors[scheme].primary, fontWeight: '700' });
    expect(flat(screen.getByText('%').props.style)).toMatchObject({ color: colors[scheme].text, fontWeight: '600' });
    expect(flat(screen.getByRole('button', { name: '$' }).props.style).backgroundColor).toBe(colors[scheme].primarySurface);
    expect(flat(screen.getByRole('button', { name: '%' }).props.style).backgroundColor).toBeUndefined();
  });

  it('segments reach a 44-pt target (40 tall plus a 2-pt slop above and below)', () => {
    render(<SegmentedControl options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} value="a" onChange={() => {}} />);
    const seg = screen.getByRole('button', { name: 'A' });
    const s = flat(seg.props.style);
    expect(s.minWidth).toBe(TOUCH_TARGET);
    expect((s.minHeight as number) + seg.props.hitSlop.top + seg.props.hitSlop.bottom).toBe(TOUCH_TARGET);
  });

  it('checkSelected shows a check only on the selected segment', () => {
    render(<SegmentedControl options={options} value="total" onChange={() => {}} checkSelected />);
    expect(screen.UNSAFE_getAllByType(Check)).toHaveLength(1);
  });
});

describe('Card (V7)', () => {
  // Imported here so the earlier sections read as before.
  const { Card } = jest.requireActual<typeof import('@/components/ui/Card')>('@/components/ui/Card');

  it.each(['light', 'dark'] as const)('has a hairline divider edge, continuous corners and a headline title (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(
      <Card title="Items" aside="3">
        <Text>Body</Text>
      </Card>,
    );
    expect(flat(screen.root.props.style)).toMatchObject({
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors[scheme].divider,
      backgroundColor: colors[scheme].surface,
      borderCurve: 'continuous',
      padding: 16,
    });
    expect(flat(screen.getByRole('header', { name: 'Items' }).props.style)).toMatchObject({ fontSize: 17, fontWeight: '600' });
  });

  it('flush: no padding or gap, clipped for ListRows', () => {
    render(
      <Card flush>
        <ListRow title="Sam" />
      </Card>,
    );
    expect(flat(screen.root.props.style)).toMatchObject({ padding: 0, gap: 0, overflow: 'hidden' });
  });
});

describe('HeaderBack (V8)', () => {
  const { HeaderBack } = jest.requireActual<typeof import('@/components/ui/BackHeader')>('@/components/ui/BackHeader');
  const ChevronLeft = jest.requireActual<typeof import('lucide-react-native/icons/chevron-left')>('lucide-react-native/icons/chevron-left').default;

  it.each(['light', 'dark'] as const)('chevron icon + label in the primary color, 44-pt target, presses through (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    const onPress = jest.fn();
    render(<HeaderBack label="Bill" accessibilityLabel="Back to bill" accessibilityHint="Returns to the bill" onPress={onPress} />);
    const back = screen.getByRole('button', { name: 'Back to bill' });
    expect(back.props.accessibilityHint).toBe('Returns to the bill');
    expect(flat(back.props.style)).toMatchObject({ minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET });
    expect(flat(screen.getByText('Bill').props.style).color).toBe(colors[scheme].primary);
    expect(screen.UNSAFE_getByType(ChevronLeft).props.color).toBe(colors[scheme].primary);
    // No text glyph: the chevron is an icon.
    expect(screen.queryByText(/‹/)).toBeNull();
    fireEvent.press(back);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled (edit while saving): announced and ignores presses', () => {
    const onPress = jest.fn();
    render(<HeaderBack label="Back" accessibilityLabel="Back" onPress={onPress} disabled />);
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(back);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('focus ring on web (review R5)', () => {
  const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
  const focusEvent = (focusVisible: boolean) => ({ nativeEvent: { target: { matches: (s: string) => s === ':focus-visible' && focusVisible } } });

  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));

  it('a mouse/tap focus (not :focus-visible) draws no ring', () => {
    render(<IconButton icon={X} accessibilityLabel="Remove" onPress={() => {}} />);
    fireEvent(screen.getByRole('button', { name: 'Remove' }), 'focus', focusEvent(false));
    expect(flat(screen.getByRole('button', { name: 'Remove' }).props.style).outlineWidth).toBeUndefined();
  });

  it('keyboard focus (:focus-visible) draws the ring', () => {
    render(<IconButton icon={X} accessibilityLabel="Remove" onPress={() => {}} />);
    fireEvent(screen.getByRole('button', { name: 'Remove' }), 'focus', focusEvent(true));
    expect(flat(screen.getByRole('button', { name: 'Remove' }).props.style)).toMatchObject({ outlineWidth: 2, outlineColor: colors.light.focus });
  });
});

describe('Avatars (V15)', () => {
  const { Avatar, Avatars } = jest.requireActual<typeof import('@/components/Avatars')>('@/components/Avatars');

  it.each(['light', 'dark'] as const)('initials and "+N" use the micro type step (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<Avatar person={{ userId: 'u1', name: 'Sam K', initials: 'SK', isMe: true }} />);
    expect(flat(screen.getByText('SK').props.style)).toMatchObject({ fontSize: 11, lineHeight: 13, fontWeight: '700', color: colors[scheme].onPrimary });
    const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ userId: id, name: id, initials: id.toUpperCase(), isMe: false }));
    render(<Avatars people={people} />);
    const more = screen.getByText(/^\+\d+$/);
    expect(flat(more.props.style)).toMatchObject({ fontSize: 11, fontWeight: '700', color: colors[scheme].textMuted });
  });
});

describe('Banner (V5)', () => {
  const { Banner, BannerText } = jest.requireActual<typeof import('@/components/ui/Banner')>('@/components/ui/Banner');
  const cases = [
    ['info', Info, 'textMuted', 'surfaceMuted'],
    ['warning', TriangleAlert, 'warning', 'warningSurface'],
    ['error', CircleAlert, 'danger', 'dangerSurface'],
    ['success', CircleCheck, 'success', 'successSurface'],
  ] as const;

  describe.each(['light', 'dark'] as const)('%s', (scheme) => {
    it.each(cases)('%s: its own icon in the tone color, on the tinted surface, no stripe', (tone, glyph, fg, bg) => {
      mockScheme.mockReturnValue(scheme);
      render(
        <Banner tone={tone} title="Title">
          <BannerText>Body</BannerText>
        </Banner>,
      );
      expect(screen.UNSAFE_getByType(glyph).props.color).toBe(colors[scheme][fg]);
      const style = flat(screen.root.props.style);
      expect(style.backgroundColor).toBe(colors[scheme][bg]);
      expect(style.borderLeftWidth).toBeUndefined();
      expect(style.borderCurve).toBe('continuous');
      expect(screen.queryByText(/[ℹ⚠✓]/)).toBeNull();
    });
  });

  it('alert banners are announced; others are not', () => {
    // The role sits on the container View (unchanged by V5), which RNTL's getByRole doesn't match.
    render(<Banner tone="error" title="Couldn't save" alert />);
    expect(screen.UNSAFE_getAllByProps({ accessibilityRole: 'alert' }).length).toBeGreaterThan(0);
    render(<Banner tone="info" title="FYI" />);
    expect(screen.UNSAFE_queryAllByProps({ accessibilityRole: 'alert' })).toHaveLength(0);
  });
});

describe('ChoiceCard (V16, review R1/R2/R4)', () => {
  const { ChoiceCard } = jest.requireActual<typeof import('@/components/ChoiceCard')>('@/components/ChoiceCard');
  const { shadow } = jest.requireActual<typeof import('@/lib/theme')>('@/lib/theme');

  it.each(['light', 'dark'] as const)('a tappable surface: ≥44 high, hairline divider edge, continuous corners, the card shadow token (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<ChoiceCard title="Take photo" hint="Opens the camera" icon={Plus} onPress={() => {}} />);
    const card = screen.getByRole('button', { name: 'Take photo' });
    const s = flat(card.props.style);
    expect(s.minHeight as number).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(s).toMatchObject({
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors[scheme].divider,
      borderCurve: 'continuous',
      boxShadow: shadow.card,
    });
    expect(screen.UNSAFE_getByType(Plus).props).toMatchObject({ size: iconSize.lg, strokeWidth: ICON_STROKE, color: colors[scheme].primary });
  });

  it('uses the shared focus ring (keyboard focus only on web)', () => {
    render(<ChoiceCard title="Take photo" hint="Opens the camera" icon={Plus} onPress={() => {}} />);
    fireEvent(screen.getByRole('button', { name: 'Take photo' }), 'focus');
    expect(flat(screen.getByRole('button', { name: 'Take photo' }).props.style)).toMatchObject({ outlineWidth: 2, outlineColor: colors.light.focus });
  });
});

describe('Button (V6, first part)', () => {
  const { Button } = jest.requireActual<typeof import('@/components/ui/Button')>('@/components/ui/Button');

  it.each(['light', 'dark'] as const)('icon: drawn before the label in the label color, hidden from screen readers (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<Button label="Add item" icon={Plus} variant="ghost" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy();
    expect(screen.UNSAFE_getByType(Plus).props).toMatchObject({ color: colors[scheme].primary, accessible: false });
    expect(screen.queryByText('+')).toBeNull();
  });

  it('flush: no side padding but still a 44-pt target; continuous corners', () => {
    render(<Button label="Undo" variant="ghost" flush onPress={() => {}} />);
    expect(flat(screen.getByRole('button', { name: 'Undo' }).props.style)).toMatchObject({
      paddingHorizontal: 0,
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      borderCurve: 'continuous',
    });
  });

  it('shows the shared focus ring while focused', () => {
    render(<Button label="Save" variant="primary" onPress={() => {}} />);
    fireEvent(screen.getByRole('button', { name: 'Save' }), 'focus');
    expect(flat(screen.getByRole('button', { name: 'Save' }).props.style)).toMatchObject({ outlineWidth: 2, outlineColor: colors.light.focus });
  });

  it('loading: busy, disabled, no icon, ignores presses', () => {
    const onPress = jest.fn();
    render(<Button label="Saving…" icon={Plus} loading onPress={onPress} />);
    const b = screen.getByRole('button', { name: 'Saving…' });
    expect(b.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    expect(screen.UNSAFE_queryAllByType(Plus)).toHaveLength(0);
    fireEvent.press(b);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('ListRow options (V9, V14)', () => {
  const { Button } = jest.requireActual<typeof import('@/components/ui/Button')>('@/components/ui/Button');

  it('a static row with a label reads as one element, and its trailing action stays its own button', () => {
    render(
      <ListRow
        title="Sam Lee"
        caption="Last split Nov 20"
        accessibilityLabel="Sam Lee, last split Nov 20"
        trailing={<Button label="Add" accessibilityLabel="Add Sam Lee" onPress={() => {}} />}
        edgeToEdge={false}
      />,
    );
    const group = screen.getByLabelText('Sam Lee, last split Nov 20');
    expect(group.props.accessible).toBe(true);
    expect(screen.getByRole('button', { name: 'Add Sam Lee' })).toBeTruthy();
    // Inside a padded card: no side padding of its own.
    expect(flat(screen.root.props.style).paddingLeft).toBeUndefined();
  });

  it('a tappable row can be a link (rows that open another screen)', () => {
    render(<ListRow title="Dinner" accessibilityRole="link" accessibilityLabel="Dinner, $48.00" onPress={() => {}} />);
    expect(screen.getByRole('link', { name: 'Dinner, $48.00' })).toBeTruthy();
  });

  it('caption can be an element (a status pill)', () => {
    render(<ListRow title="Dinner" caption={<Text>New</Text>} />);
    expect(screen.getByText('New')).toBeTruthy();
  });
});

describe('Button tonal variants (V6)', () => {
  const { Button } = jest.requireActual<typeof import('@/components/ui/Button')>('@/components/ui/Button');
  it.each([
    ['light', 'secondary', 'primarySurface', 'primary'],
    ['dark', 'secondary', 'primarySurface', 'primary'],
    ['light', 'danger', 'dangerSurface', 'danger'],
    ['dark', 'danger', 'dangerSurface', 'danger'],
  ] as const)('%s %s: tinted fill, no outline, text in the tone color', (scheme, variant, bg, fg) => {
    mockScheme.mockReturnValue(scheme);
    render(<Button label="Go" variant={variant} onPress={() => {}} />);
    expect(flat(screen.getByRole('button', { name: 'Go' }).props.style)).toMatchObject({ backgroundColor: colors[scheme][bg], borderColor: 'transparent' });
    expect(flat(screen.getByText('Go').props.style).color).toBe(colors[scheme][fg]);
  });
});

it('Button: a long label can wrap inside the button, centered', () => {
  const { Button } = jest.requireActual<typeof import('@/components/ui/Button')>('@/components/ui/Button');
  const label = 'Pay Hana Lee-Watanabe $1.10 more on Venmo';
  render(<Button label={label} variant="primary" block onPress={() => {}} />);
  expect(flat(screen.getByText(label).props.style)).toMatchObject({ flexShrink: 1, textAlign: 'center' });
});

describe('Avatar rings (dark-mode visibility)', () => {
  const { Avatar } = jest.requireActual<typeof import('@/components/Avatars')>('@/components/Avatars');
  it.each(['light', 'dark'] as const)('others get a 1-pt border ring, the viewer a 1-pt primary ring, inside the 2-pt cutout (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(
      <>
        <Avatar person={{ userId: 'a', name: 'Sam', initials: 'SA', isMe: false }} />
        <Avatar person={{ userId: 'b', name: 'You', initials: 'YO', isMe: true }} />
      </>,
    );
    const ring = (t: string) => ancestorStyle(screen.getByText(t) as unknown as Node, 'borderWidth');
    expect(ring('SA')).toMatchObject({ borderWidth: 1, borderColor: colors[scheme].border, backgroundColor: colors[scheme].surfaceMuted });
    expect(ring('YO')).toMatchObject({ borderWidth: 1, borderColor: colors[scheme].primary, backgroundColor: colors[scheme].primary });
  });
});

describe('ToneIcon and PayerPicker (V11, P3)', () => {
  const { ToneIcon } = jest.requireActual<typeof import('@/components/ui/ToneIcon')>('@/components/ui/ToneIcon');
  const { PayerPicker } = jest.requireActual<typeof import('@/components/PayerPicker')>('@/components/PayerPicker');
  const CircleDot = jest.requireActual<typeof import('lucide-react-native/icons/circle-dot')>('lucide-react-native/icons/circle-dot').default;
  const Circle = jest.requireActual<typeof import('lucide-react-native/icons/circle')>('lucide-react-native/icons/circle').default;

  it.each([
    ['success', Check],
    ['warning', TriangleAlert],
    ['error', CircleAlert],
  ] as const)('%s draws its icon, 16 pt, hidden from screen readers', (tone, glyph) => {
    render(<ToneIcon tone={tone} color="#123456" />);
    expect(screen.UNSAFE_getByType(glyph).props).toMatchObject({ size: iconSize.sm, color: '#123456', accessible: false });
  });

  it('muted draws nothing', () => {
    render(<ToneIcon tone="muted" color="#123456" />);
    expect(screen.toJSON()).toBeNull();
  });

  it('payer radios: dot for the checked row, ring for the others; radio semantics unchanged; no glyphs', () => {
    render(
      <PayerPicker
        rows={[
          { userId: 'a', name: 'Hana', checked: true },
          { userId: 'b', name: 'Sam', checked: false },
        ]}
        busyId={null}
        confirm={null}
        saving={false}
        error={null}
        onPick={() => {}}
        onConfirm={() => {}}
        onCancelConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Hana' }).props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.UNSAFE_getAllByType(CircleDot)).toHaveLength(1);
    expect(screen.UNSAFE_getAllByType(Circle)).toHaveLength(1);
    expect(screen.queryByText(/[◉○]/)).toBeNull();
  });
});

describe('focus rings on custom pressables (review R9)', () => {
  const { ClaimItemRow } = jest.requireActual<typeof import('@/components/ClaimItemRow')>('@/components/ClaimItemRow');
  const { PayerPicker } = jest.requireActual<typeof import('@/components/PayerPicker')>('@/components/PayerPicker');
  const ring = (el: { props: { style?: unknown } }) => flat(el.props.style).outlineWidth;

  it('claim toggle and the row details target', () => {
    render(
      <ClaimItemRow
        label="Fries"
        a11yName="Fries"
        priceCents={600}
        status="Unclaimed"
        claimers={[]}
        claimed={false}
        busy={false}
        onToggle={() => {}}
        onOpenDetails={() => {}}
      />,
    );
    const toggle = () => screen.getByRole('button', { name: 'Claim Fries' });
    expect(ring(toggle())).toBeUndefined();
    fireEvent(toggle(), 'focus');
    expect(ring(toggle())).toBe(2);
    const details = () => screen.getAllByRole('button').find((b) => String(b.props.accessibilityLabel).startsWith('Fries, '))!;
    fireEvent(details(), 'focus');
    expect(ring(details())).toBe(2);
  });

  it('payer rows', () => {
    render(
      <PayerPicker
        rows={[{ userId: 'a', name: 'Hana', checked: true }]}
        busyId={null}
        confirm={null}
        saving={false}
        error={null}
        onPick={() => {}}
        onConfirm={() => {}}
        onCancelConfirm={() => {}}
      />,
    );
    fireEvent(screen.getByRole('radio', { name: 'Hana' }), 'focus');
    expect(ring(screen.getByRole('radio', { name: 'Hana' }))).toBe(2);
  });
});
