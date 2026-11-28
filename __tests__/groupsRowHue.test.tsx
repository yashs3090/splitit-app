// Groups-row hues (docs/specs/2026-11-28-tab-bar-and-activity.md Task 10, Contract M "Groups-list
// rows", criteria 54-55, FEED-20): a `claim` row has the warningSurface fill, a `settled` row the
// surfaceMuted fill and a check before "Settled up"; owe, owed, waiting and loading rows are plain.
// A highlighted row keeps its fill while pressed and dims its content to 0.7 instead; a plain row's
// pressed background is unchanged; `highlight={true}` renders as before.
//
// The pressed state is read by calling the Pressable's style and children functions with
// { pressed: true }: the test renderer doesn't drive Pressable's pressed state itself.
import { fireEvent, renderRouter, screen, waitFor, within } from 'expo-router/testing-library';
import { Slot } from 'expo-router';
import Check from 'lucide-react-native/icons/check';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { isValidElement, type ReactElement } from 'react';
import { Platform, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { render } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { GroupsSection } from '@/components/GroupsSection';
import { ListRow } from '@/components/ui/ListRow';
import { AuthProvider } from '@/lib/auth';
import type { GroupHomeStatus } from '@/lib/groupHomeView';
import * as groups from '@/lib/groups';
import type { GroupSummary } from '@/lib/groups';
import { supabase as realSupabase } from '@/lib/supabase';
import { colors, opacity } from '@/lib/theme';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { ANA, W2 } from '@/test-utils/groupFixtures';
import { snapshotOf } from '@/test-utils/groupSnapshotFixtures';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));
jest.mock('@/lib/groups', () => {
  const actual = jest.requireActual<typeof import('@/lib/groups')>('@/lib/groups');
  return { ...actual, listMyGroups: jest.fn(), fetchGroupSnapshot: jest.fn(), setGroupHidden: jest.fn() };
});
// Each group's status is fixed per test through mockStatus (keyed by group id); the rest of the row is
// the real groupHomeRow. `undefined` means the snapshot hasn't loaded (the row shows the people count).
const mockStatus = new Map<string, GroupHomeStatus | undefined>();
jest.mock('@/lib/groupHomeView', () => {
  const actual = jest.requireActual<typeof import('@/lib/groupHomeView')>('@/lib/groupHomeView');
  return {
    ...actual,
    groupHomeRow: (...args: Parameters<typeof actual.groupHomeRow>) => {
      const base = actual.groupHomeRow(args[0], null, args[2]);
      const status = mockStatus.get(args[0].id);
      if (!status) return base;
      return { ...base, status, caption: status.text, a11yLabel: `${base.title}, ${status.text}` };
    },
  };
});

const supabase = realSupabase as unknown as FakeSupabase;
const listGroups = groups.listMyGroups as jest.MockedFunction<typeof groups.listMyGroups>;
const fetchSnapshot = groups.fetchGroupSnapshot as jest.MockedFunction<typeof groups.fetchGroupSnapshot>;

const TS = '2026-11-26T10:00:00.000Z';
const gid = (n: number) => `9b000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;
const group = (n: number, name: string): GroupSummary => ({ id: gid(n), name, memberCount: 3, joinedAt: TS, hidden: false });

const CLAIM = group(1, 'Tahoe trip');
const SETTLED = group(2, 'Old flat');
const OWE = group(3, 'Ski week');
const OWED = group(4, 'Book club');
const WAITING = group(5, 'Road trip');
const LOADING = group(6, 'Lake house');
const ALL = [CLAIM, SETTLED, OWE, OWED, WAITING, LOADING];

const { GROUPS_HOME_COPY } = jest.requireActual<typeof import('@/lib/groupHomeView')>('@/lib/groupHomeView');
const SETTLED_TEXT = GROUPS_HOME_COPY.settled;
const CLAIM_TEXT = GROUPS_HOME_COPY.claim(1);

function setStatuses() {
  mockStatus.clear();
  mockStatus.set(CLAIM.id, { kind: 'claim', text: CLAIM_TEXT, tone: 'warning' });
  mockStatus.set(SETTLED.id, { kind: 'settled', text: SETTLED_TEXT, tone: 'muted' });
  mockStatus.set(OWE.id, { kind: 'owe', text: 'You owe $12.50', tone: 'text' });
  mockStatus.set(OWED.id, { kind: 'owed', text: "You're owed $8.00", tone: 'success' });
  mockStatus.set(WAITING.id, { kind: 'waiting', text: '2 items left to claim', tone: 'muted' });
  mockStatus.set(LOADING.id, undefined);
}

function signInAs(userId: string) {
  const s = fakeSession('Ana');
  supabase.__setInitialSession({ ...s, user: { ...s.user, id: userId } });
}

const flat = (style: unknown): Record<string, unknown> => (StyleSheet.flatten(style as StyleProp<ViewStyle>) as Record<string, unknown> | undefined) ?? {};

type PressableProps = {
  style: (s: { pressed: boolean }) => unknown;
  children: (s: { pressed: boolean }) => unknown;
};
/** The Pressable behind a row's link: the nearest ancestor whose style is a function of `pressed`. */
function pressableOf(host: ReactTestInstance): PressableProps {
  for (let cur: ReactTestInstance | null = host; cur !== null; cur = cur.parent) {
    if (typeof cur.props.style === 'function' && typeof cur.props.children === 'function') return cur.props as PressableProps;
  }
  throw new Error('no Pressable above this row');
}
/** The row's fill and its content's opacity, at rest or pressed. */
function rowLook(host: ReactTestInstance, pressed: boolean): { fill: unknown; contentOpacity: unknown } {
  const p = pressableOf(host);
  const content = p.children({ pressed });
  if (!isValidElement(content)) throw new Error('row content is not an element');
  return {
    fill: flat(p.style({ pressed })).backgroundColor,
    contentOpacity: flat((content as ReactElement<{ style: unknown }>).props.style).opacity,
  };
}

/** A group row's link (its host View), by the row's full label. */
function rowOf(name: string): ReactTestInstance {
  return screen.getByRole('link', { name });
}

const openGroups = () =>
  renderRouter(
    {
      _layout: () => (
        <AuthProvider>
          <Slot />
        </AuthProvider>
      ),
      index: () => <GroupsSection variant="page" />,
      'groups/[id]': () => <Text>Group stand-in</Text>,
      'sign-in': () => <Text>Sign-in stand-in</Text>,
    },
    { initialUrl: '/' },
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockScheme.mockReturnValue('light');
  signInAs(ANA);
  setStatuses();
  listGroups.mockImplementation(async () => ({ ok: true, groups: ALL }));
  fetchSnapshot.mockImplementation(async () => ({ ok: true, snapshot: snapshotOf(W2.input, { venmo: {} }) }));
});

describe.each(['ios', 'web'] as const)('Groups-row hues on %s (criterion 54)', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  it('a claim row has the warningSurface fill; a settled row the surfaceMuted fill', async () => {
    openGroups();
    const claim = await screen.findByRole('link', { name: `Tahoe trip, ${CLAIM_TEXT}` });
    expect(rowLook(claim, false).fill).toBe(colors.light.warningSurface);
    expect(rowLook(rowOf(`Old flat, ${SETTLED_TEXT}`), false).fill).toBe(colors.light.surfaceMuted);
  });

  it('owe, owed, waiting and loading rows have no fill', async () => {
    openGroups();
    await screen.findByText('Tahoe trip');
    for (const name of ['Ski week, You owe $12.50', "Book club, You're owed $8.00", 'Road trip, 2 items left to claim']) {
      expect(rowLook(rowOf(name), false).fill).toBeUndefined();
    }
    const loading = screen.getByRole('link', { name: /^Lake house/ });
    expect(rowLook(loading, false).fill).toBeUndefined();
  });

  it('the settled row has a check before "Settled up"; no other row has one', async () => {
    openGroups();
    await screen.findByText('Tahoe trip');
    const checks = screen.UNSAFE_getAllByType(Check);
    expect(checks).toHaveLength(1);
    const settledRow = rowOf(`Old flat, ${SETTLED_TEXT}`);
    // The check is inside the settled row, in the caption's colour, and hidden from screen readers.
    let inRow = false;
    for (let cur: ReactTestInstance | null = checks[0] ?? null; cur !== null; cur = cur.parent) if (cur === settledRow) inRow = true;
    expect(inRow).toBe(true);
    expect(checks[0]?.props.color).toBe(colors.light.textMuted);
    // The caption's words still say it, in the same row.
    expect(within(settledRow).getByText(SETTLED_TEXT)).toBeTruthy();
  });

  it('titles stay in `text` (never dimmed) and every chevron stays at full textMuted', async () => {
    openGroups();
    await screen.findByText('Tahoe trip');
    for (const g of ALL) {
      const style = flat(screen.getByText(g.name).props.style);
      expect(style.color).toBe(colors.light.text);
      expect(style.opacity).toBeUndefined();
    }
    const chevrons = screen.UNSAFE_getAllByType(ChevronRight);
    expect(chevrons).toHaveLength(ALL.length);
    for (const c of chevrons) expect(c.props.color).toBe(colors.light.textMuted);
  });
});

describe('pressed state (criterion 55)', () => {
  it('a pressed claim or settled row keeps its fill and dims its content to 0.7', async () => {
    openGroups();
    await screen.findByText('Tahoe trip');
    expect(rowLook(rowOf(`Tahoe trip, ${CLAIM_TEXT}`), true)).toEqual({ fill: colors.light.warningSurface, contentOpacity: opacity.pressed });
    const settled = rowLook(rowOf(`Old flat, ${SETTLED_TEXT}`), true);
    expect(settled).toEqual({ fill: colors.light.surfaceMuted, contentOpacity: 0.7 });
    // Pressed never reads as just surfaceMuted: the content changes too.
    expect(settled).not.toEqual(rowLook(rowOf(`Old flat, ${SETTLED_TEXT}`), false));
  });

  it('a pressed plain row is unchanged: the surfaceMuted background, content at full opacity', async () => {
    openGroups();
    await screen.findByText('Tahoe trip');
    expect(rowLook(rowOf('Ski week, You owe $12.50'), true)).toEqual({ fill: colors.light.surfaceMuted, contentOpacity: undefined });
  });

  it('tapping a tinted row still opens its group', async () => {
    const router = openGroups();
    const settled = await screen.findByRole('link', { name: `Old flat, ${SETTLED_TEXT}` });
    fireEvent.press(settled);
    await waitFor(() => expect(router.getPathname()).toBe(`/groups/${SETTLED.id}`));
  });
});

describe('ListRow highlight values', () => {
  const press = jest.fn();
  const linkOf = (label: string) => screen.getByRole('button', { name: label });

  it.each(['light', 'dark'] as const)('highlight={true} renders exactly as before at rest (%s)', (scheme) => {
    mockScheme.mockReturnValue(scheme);
    render(<ListRow title="Dinner" accessibilityLabel="Dinner, claim your items" onPress={press} highlight />);
    expect(flat(linkOf('Dinner, claim your items').props.style)).toEqual({ paddingLeft: 16, backgroundColor: colors[scheme].warningSurface });
    expect(rowLook(linkOf('Dinner, claim your items'), false).contentOpacity).toBeUndefined();
  });

  it("true and 'warning' are the same row", () => {
    render(
      <>
        <ListRow title="A" accessibilityLabel="A" onPress={press} highlight />
        <ListRow title="B" accessibilityLabel="B" onPress={press} highlight="warning" />
      </>,
    );
    for (const pressed of [false, true]) expect(rowLook(linkOf('A'), pressed)).toEqual(rowLook(linkOf('B'), pressed));
  });

  it('static rows (no onPress) take the fill too, with nothing pressed', () => {
    render(
      <>
        <ListRow title="Warn" highlight />
        <ListRow title="Muted" highlight="muted" />
        <ListRow title="Plain" />
      </>,
    );
    const fillOf = (title: string): unknown => {
      for (let cur: ReactTestInstance | null = screen.getByText(title); cur !== null; cur = cur.parent) {
        const bg = flat(cur.props?.style).backgroundColor;
        if (bg !== undefined) return bg;
      }
      return undefined;
    };
    expect(fillOf('Warn')).toBe(colors.light.warningSurface);
    expect(fillOf('Muted')).toBe(colors.light.surfaceMuted);
    expect(fillOf('Plain')).toBeUndefined();
  });
});

describe('contrast on the settled fill (WCAG, from the theme hex values)', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  it.each(['light', 'dark'] as const)('title (text) and caption, check and chevron (textMuted) on surfaceMuted are at least 4.5:1 (%s)', (scheme) => {
    const c = colors[scheme];
    expect(ratio(c.text, c.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.textMuted, c.surfaceMuted)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['light', 'dark'] as const)('the claim caption (warning) on warningSurface is at least 4.5:1 (%s)', (scheme) => {
    const c = colors[scheme];
    expect(ratio(c.warning, c.warningSurface)).toBeGreaterThanOrEqual(4.5);
  });
});
