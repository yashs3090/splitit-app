// Design tokens: colors (light + dark), spacing, radii and type. Tokens only, no components.
// Contrast ratios (WCAG) for every text/background pair are listed in the design report;
// text pairs are >= 4.5:1 and input borders >= 3:1 in both modes.
import { useColorScheme, type TextStyle, type ViewStyle } from 'react-native';

export type Palette = {
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  /** Input and control borders (>= 3:1 against surface). */
  border: string;
  /** Decorative hairlines between rows; not relied on to convey anything. */
  divider: string;
  primary: string;
  onPrimary: string;
  primarySurface: string;
  danger: string;
  dangerSurface: string;
  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  focus: string;
  /** Dims the screen behind a sheet. */
  scrim: string;
};

export const colors: { light: Palette; dark: Palette } = {
  light: {
    background: '#F3F4F6',
    surface: '#FFFFFF',
    surfaceMuted: '#F1F3F5',
    text: '#111827',
    textMuted: '#4B5563',
    border: '#7B8592',
    divider: '#E5E7EB',
    primary: '#0F766E',
    onPrimary: '#FFFFFF',
    primarySurface: '#E6F4F2',
    danger: '#B42318',
    dangerSurface: '#FEF3F2',
    success: '#067647',
    successSurface: '#ECFDF3',
    warning: '#93370D',
    warningSurface: '#FFFAEB',
    focus: '#0F766E',
    scrim: 'rgba(17, 24, 39, 0.45)',
  },
  dark: {
    background: '#0B0F14',
    surface: '#161B22',
    surfaceMuted: '#1F262F',
    text: '#F3F4F6',
    textMuted: '#A8B1BD',
    border: '#6B7684',
    divider: '#2A323C',
    primary: '#2DD4BF',
    onPrimary: '#04201D',
    primarySurface: '#0F2E2B',
    danger: '#FDA29B',
    dangerSurface: '#3A1714',
    success: '#75E0A7',
    successSurface: '#0F2A1D',
    warning: '#FEC84B',
    warningSurface: '#33260B',
    focus: '#5EEAD4',
    scrim: 'rgba(0, 0, 0, 0.6)',
  },
};

/**
 * Google's "Sign in with Google" button themes (Google Identity branding guidelines): light and
 * dark. Brand colors, not ours: used only by the Google button, never elsewhere.
 */
export const googleButtonColors = {
  light: { fill: '#FFFFFF', stroke: '#747775', text: '#1F1F1F' },
  dark: { fill: '#131314', stroke: '#8E918F', text: '#E3E3E3' },
} as const;

/** 4-pt spacing scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** `inner` is a shape nested 2 pt inside an `sm` one (a segment inside its track). */
export const radius = { sm: 8, md: 12, lg: 16, pill: 999, inner: 6 } as const;

/**
 * `boxShadow` strings (not the legacy shadow/elevation props). Kept faint: borders and color do the
 * grouping; in dark mode the shadow is barely visible, which is fine.
 */
export const shadow = { card: '0 1px 3px rgba(17, 24, 39, 0.08)' } as const;

/** Minimum touch target (iOS HIG / Material). */
export const TOUCH_TARGET = 44;

/** Minimum height of a list row with an avatar (people, bills, settle rows). */
export const ROW_MIN_HEIGHT = 56;

/**
 * Column widths and the screen edge. Reading screens use `content`; the bill form is wider
 * (`form`); a sentence on its own (centered states, sign-in) is held to `message`.
 */
export const layout = { content: 560, form: 640, message: 360, screenPadding: space.lg } as const;

/** Icon sizes: `sm` inline with caption text, `md` with body text and in icon buttons, `lg` in badges. */
export const iconSize = { sm: 16, md: 20, lg: 24 } as const;

/** One stroke for every icon (lucide's default is 2; 1.75 reads calmer). */
export const ICON_STROKE = 1.75;

/** Press feedback and the disabled look, the same everywhere. */
export const opacity = { pressed: 0.7, disabled: 0.5 } as const;

/**
 * Keyboard focus ring (web, hardware keyboards): a 2-pt line 2 pt off the edge, in `colors.focus`.
 * Apply with `outlineColor: colors.focus` while focused.
 */
export const focusRing = { outlineStyle: 'solid', outlineWidth: 2, outlineOffset: 2 } as const satisfies ViewStyle;

export const type = {
  caption: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  /** A card or choice title: between label and title. */
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  /** A label above a group of rows ("Discounts", "Just now"); use in `textMuted`. */
  section: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  /** Avatar initials and "+N" counts. Only inside small fixed shapes. */
  micro: { fontSize: 11, lineHeight: 13, fontWeight: '700' },
} as const satisfies Record<string, TextStyle>;

/** Money and other columns of figures line up with tabular numerals. */
export const tabularNums: TextStyle = { fontVariant: ['tabular-nums'] };

export type Theme = { scheme: 'light' | 'dark'; colors: Palette };

export function useTheme(): Theme {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: colors[scheme] };
}
