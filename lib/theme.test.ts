// Design-token invariants and WCAG contrast for the color pairs the shared primitives rely on.
// Visual pass spec: docs/specs/2026-11-25-visual-pass.md (V1).
import { act, renderHook } from '@testing-library/react-native';

import { colors, googleButtonColors, iconSize, layout, opacity, radius, space, type, type Palette, useTheme } from './theme';
import { storage as realStorage } from './storage';
import { PAGE_BACKGROUND, resetThemePreferenceForTests, setThemePreference } from './themePreference';
import type { MemoryStorage } from '@/test-utils/fakes';

// Keep the store in memory only (no SecureStore under Jest).
jest.mock('./storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});
// jest.mock is hoisted; mockScheme is read lazily, so the factory may name it.
const mockScheme = jest.fn<'light' | 'dark' | null, []>(() => 'light');
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockScheme(),
}));


/** WCAG 2.x relative luminance of a #RRGGBB color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SPACE_STEPS: readonly number[] = Object.values(space);

describe('tokens', () => {
  it('nests radius.inner 2 pt inside radius.sm (a segment inside its track)', () => {
    expect(radius.inner).toBe(radius.sm - 2);
  });

  it('keeps the screen edge on the spacing scale', () => {
    expect(layout.screenPadding).toBe(space.lg);
  });

  it('orders icon sizes and keeps them on the 4-pt grid', () => {
    expect(iconSize.sm).toBeLessThan(iconSize.md);
    expect(iconSize.md).toBeLessThan(iconSize.lg);
    for (const s of Object.values(iconSize)) expect(s % 4).toBe(0);
  });

  it('keeps pressed feedback lighter than the disabled look', () => {
    expect(opacity.pressed).toBeGreaterThan(opacity.disabled);
  });

  it('adds section and micro type steps below caption size', () => {
    expect(type.section.fontSize).toBe(type.caption.fontSize);
    expect(type.micro.fontSize).toBeLessThan(type.caption.fontSize);
  });

  it('uses only spacing steps for column padding', () => {
    expect(SPACE_STEPS).toContain(layout.screenPadding);
  });
});

// Text pairs need 4.5:1 (WCAG AA body text); UI parts and large text need 3:1.
const TEXT_PAIRS: [fg: keyof Palette, bg: keyof Palette][] = [
  ['text', 'background'],
  ['text', 'surface'],
  ['text', 'surfaceMuted'],
  ['textMuted', 'background'],
  ['textMuted', 'surface'],
  ['textMuted', 'surfaceMuted'],
  ['primary', 'background'],
  ['primary', 'surface'],
  ['primary', 'primarySurface'],
  ['onPrimary', 'primary'],
  ['danger', 'background'],
  ['danger', 'dangerSurface'],
  ['success', 'background'],
  ['success', 'surface'],
  ['success', 'successSurface'],
  ['warning', 'warningSurface'],
];

describe.each(['light', 'dark'] as const)('%s contrast', (scheme) => {
  const c = colors[scheme];
  it.each(TEXT_PAIRS)('%s on %s is at least 4.5:1', (fg, bg) => {
    expect(contrast(c[fg], c[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('focus ring is at least 3:1 against the background and surface', () => {
    expect(contrast(c.focus, c.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.focus, c.surface)).toBeGreaterThanOrEqual(3);
  });
});

describe.each(['light', 'dark'] as const)('%s Google button (brand colors)', (scheme) => {
  const g = googleButtonColors[scheme];
  it('label is at least 4.5:1 on the fill', () => {
    expect(contrast(g.text, g.fill)).toBeGreaterThanOrEqual(4.5);
  });
  it('stroke is at least 3:1 against the screen background', () => {
    expect(contrast(g.stroke, colors[scheme].background)).toBeGreaterThanOrEqual(3);
  });
});

// Feed markers (docs/specs/2026-11-28-tab-bar-and-activity.md Contract M, criterion 19): the dispute
// tone is a light orange, never `danger` (red stays for app errors). The icon needs 3:1 on its fill;
// the pair also clears 4.5:1, so text drawn in `dispute` on the fill or the surface would be readable.
describe.each(['light', 'dark'] as const)('%s dispute tokens', (scheme) => {
  const c = colors[scheme];
  it('has the Contract M values', () => {
    const expected = scheme === 'light' ? { disputeSurface: '#FFF6ED', dispute: '#C4320A' } : { disputeSurface: '#3A1D0B', dispute: '#FDBA8C' };
    expect({ disputeSurface: c.disputeSurface, dispute: c.dispute }).toEqual(expected);
  });
  it('dispute icon is at least 3:1 on disputeSurface', () => {
    expect(contrast(c.dispute, c.disputeSurface)).toBeGreaterThanOrEqual(3);
  });
  it.each(['disputeSurface', 'surface', 'background'] as const)('dispute as text is at least 4.5:1 on %s', (bg) => {
    expect(contrast(c.dispute, c[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it('is not the danger color', () => {
    expect(c.dispute).not.toBe(c.danger);
    expect(c.disputeSurface).not.toBe(c.dangerSurface);
  });
});

describe('contrast helper (positive control)', () => {
  it('computes the WCAG ratio of known pairs', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // A pair known to fail 3:1, so the dispute assertions above can fail.
    expect(contrast('#FDBA8C', '#FFF6ED')).toBeLessThan(3);
  });
});

// Appearance (Auto / Light / Dark): the selected segment of the chooser must stand out from its
// track on both the Profile card (surface track on surfaceMuted) and the Venmo card (surface track).
describe.each(['light', 'dark'] as const)('%s Appearance chooser', (scheme) => {
  const c = colors[scheme];
  it.each(['surfaceMuted', 'surface'] as const)('the selected segment is at least 3:1 against a %s track', (track) => {
    expect(contrast(c.primary, c[track])).toBeGreaterThanOrEqual(3);
  });
});

describe('useTheme follows the Appearance choice', () => {
  beforeEach(() => {
    // A choice persists (that's the point), so each case starts from an empty device.
    (realStorage as unknown as MemoryStorage).data.clear();
    resetThemePreferenceForTests();
  });

  it("the web page backgrounds it applies are the theme's", () => {
    expect(PAGE_BACKGROUND).toEqual({ light: colors.light.background, dark: colors.dark.background });
  });

  it.each([
    ['system', 'light', 'light'],
    ['system', 'dark', 'dark'],
    ['system', null, 'light'],
    ['light', 'dark', 'light'],
    ['dark', 'light', 'dark'],
  ] as const)('choice %s with the device in %s → %s', async (pref, device, expected) => {
    mockScheme.mockReturnValue(device);
    await setThemePreference(pref);
    const { result } = renderHook(() => useTheme());
    expect(result.current.scheme).toBe(expected);
    expect(result.current.colors).toBe(colors[expected]);
  });

  it('re-renders when the choice changes, in both directions', async () => {
    mockScheme.mockReturnValue('light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.scheme).toBe('light');
    await act(async () => {
      await setThemePreference('dark');
    });
    expect(result.current.scheme).toBe('dark');
    expect(result.current.colors.disputeSurface).toBe(colors.dark.disputeSurface);
    await act(async () => {
      await setThemePreference('light');
    });
    expect(result.current.scheme).toBe('light');
    mockScheme.mockReturnValue('dark');
    await act(async () => {
      await setThemePreference('system');
    });
    expect(result.current.scheme).toBe('dark');
  });
});
