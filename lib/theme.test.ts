// Design-token invariants and WCAG contrast for the color pairs the shared primitives rely on.
// Visual pass spec: docs/specs/2026-11-25-visual-pass.md (V1).
import { colors, googleButtonColors, iconSize, layout, opacity, radius, space, type, type Palette } from './theme';

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
