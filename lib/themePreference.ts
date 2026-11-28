// The Appearance preference: Auto (follow the device), Light or Dark. Chosen on the Venmo card on
// Home and on Profile; read by useTheme() in lib/theme.ts, the single source of the color scheme.
//
// Device-local, no database (the user doesn't want tracking fields in the DB): one lib/storage key,
// `splitit.appearance`, holding 'system' | 'light' | 'dark'. It belongs to the device, not the
// person, so it is kept across sign-out (decisions-to-review APPEAR-1).
//
// - Web: read synchronously from localStorage when this module loads, so the first render already
//   has it. public/index.html runs the same read before the bundle, so the page never flashes the
//   wrong theme (__tests__/webTemplate.test.ts checks the two agree). react-native-web's
//   useColorScheme follows prefers-color-scheme, so useTheme() has to let the choice win.
// - Native: read from lib/storage (SecureStore) at launch, so the first frames use Auto until it
//   lands. A fixed choice also goes to Appearance.setColorScheme, so the keyboard, system alerts and
//   the status bar follow it too.
// - A choice applies at once; the write is best effort and never throws (a failed write only means
//   the next launch starts on Auto again).
import { useSyncExternalStore } from 'react';
import { Appearance, Platform } from 'react-native';

import { storage } from './storage';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

export const THEME_PREFERENCE_KEY = 'splitit.appearance';

/** The chooser's options, in order. "Auto" is the label for 'system'. */
export const THEME_PREFERENCE_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export const APPEARANCE_COPY = {
  /** The card title on Profile, the row label on the Venmo card, and the radio group's name. */
  label: 'Appearance',
  /** Under the chooser on Profile. */
  hint: "Auto follows your phone's setting.",
} as const;

/**
 * The page backgrounds per scheme: colors.light/dark.background in lib/theme.ts. Repeated here
 * because lib/theme.ts imports this file; lib/theme.test.ts keeps them equal.
 */
export const PAGE_BACKGROUND: Readonly<Record<ColorScheme, string>> = { light: '#F3F4F6', dark: '#0B0F14' };

export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** The scheme to draw: the device's for Auto (anything but 'dark' is light), otherwise the choice. */
export function resolveScheme(pref: ThemePreference, device: string | null | undefined): ColorScheme {
  if (pref === 'system') return device === 'dark' ? 'dark' : 'light';
  return pref;
}

let current: ThemePreference = 'system';
/** Bumped on every set, so a stored value that loads after a choice was made doesn't undo it. */
let generation = 0;
const listeners = new Set<() => void>();

export function getThemePreference(): ThemePreference {
  return current;
}

export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function apply(next: ThemePreference) {
  if (next === current) return;
  current = next;
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') applyWebAppearance(next, document);
  } else {
    try {
      Appearance.setColorScheme(next === 'system' ? 'unspecified' : next);
    } catch {
      // Best effort: the app's own colors already follow the choice through useTheme().
    }
  }
  for (const l of [...listeners]) l();
}

/** Applies the choice now and saves it on this device. Never rejects. */
export async function setThemePreference(next: ThemePreference): Promise<void> {
  if (next === current) return;
  generation++;
  apply(next);
  try {
    await storage.setItem(THEME_PREFERENCE_KEY, next);
  } catch {
    // Kept for this session; the next launch starts on Auto.
  }
}

/** Reads the stored choice. A choice made while this is in flight wins. Never rejects. */
export async function loadThemePreference(): Promise<void> {
  const mine = generation;
  let raw: string | null = null;
  try {
    raw = await storage.getItem(THEME_PREFERENCE_KEY);
  } catch {
    return;
  }
  if (mine !== generation) return;
  apply(parseThemePreference(raw));
}

/** Web: localStorage, synchronously (lib/storage's web copy is the same store, behind a Promise). */
function readWebSync(): ThemePreference {
  try {
    const ls = typeof window !== 'undefined' ? (window as { localStorage?: Pick<Storage, 'getItem'> }).localStorage : undefined;
    return parseThemePreference(ls?.getItem(THEME_PREFERENCE_KEY));
  } catch {
    return 'system';
  }
}

function init() {
  if (Platform.OS === 'web') {
    // The template's inline script already themed the page; this only sets the app's own value.
    current = readWebSync();
  } else {
    void loadThemePreference();
  }
}

/** Tests only: forget the choice and listeners, then read storage again as at launch. */
export function resetThemePreferenceForTests(): void {
  current = 'system';
  generation++;
  listeners.clear();
  init();
}

init();

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeThemePreference, getThemePreference, getThemePreference);
}

/** The bits of a DOM Document this needs (a fake one in tests). */
type MetaLike = { getAttribute(name: string): string | null; setAttribute(name: string, value: string): void };
export type AppearanceDocument = {
  documentElement: {
    style: { colorScheme: string };
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  querySelectorAll(selector: string): ArrayLike<MetaLike> & Iterable<MetaLike>;
};

/**
 * Themes the page itself for the choice: `data-appearance` on <html> (public/index.html's CSS paints
 * the forced background from it), the CSS color-scheme (scrollbars and form controls), the
 * color-scheme meta, and both theme-color metas (the browser toolbar tint). Auto restores the
 * template's values. public/index.html's inline script does the same before the bundle loads.
 */
export function applyWebAppearance(pref: ThemePreference, doc: AppearanceDocument): void {
  const root = doc.documentElement;
  if (pref === 'system') root.removeAttribute('data-appearance');
  else root.setAttribute('data-appearance', pref);
  root.style.colorScheme = pref === 'system' ? '' : pref;
  for (const m of Array.from(doc.querySelectorAll('meta[name="color-scheme"]'))) {
    m.setAttribute('content', pref === 'system' ? 'light dark' : pref);
  }
  for (const m of Array.from(doc.querySelectorAll('meta[name="theme-color"]'))) {
    const forMedia: ColorScheme = (m.getAttribute('media') ?? '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', PAGE_BACKGROUND[pref === 'system' ? forMedia : pref]);
  }
}
