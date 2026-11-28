// "Get the app" banner for SplitIt's web app on phones and tablets (decisions AB-1 … AB-11 in
// docs/decisions-to-review.md, "App banner"). Pure logic only: should it show, which store, has it
// been dismissed. components/AppBanner.tsx renders it.
//
// - Web on a phone or tablet only: never in the native app, never on desktop.
// - Only when that platform's store URL is configured at build time; today neither is, so the
//   banner never shows (no dead "coming soon" button).
// - "Continue on website" hides it for APP_BANNER_DISMISS_MS. Only a timestamp is stored.

export type StoreUrls = { ios: string | null; android: string | null };
export type MobileWeb = 'ios' | 'android';
export type AppBannerTarget = { store: MobileWeb; url: string };

const IOS_VAR = 'EXPO_PUBLIC_IOS_APP_STORE_URL';
const ANDROID_VAR = 'EXPO_PUBLIC_ANDROID_PLAY_STORE_URL';

// Regexes, not `new URL()`: React Native's URL polyfill lacks the getters (see readWebUrl in lib/env.ts).
// The host is matched exactly right after `https://`, so credentials, look-alike hosts and other
// schemes can't pass.
// e.g. https://apps.apple.com/us/app/splitit/id1234567890 or https://apps.apple.com/app/id1234567890
const APP_STORE_RE = /^https:\/\/apps\.apple\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?app\/(?:[a-z0-9%-]+\/)?id\d+(?:\?[a-z0-9=&._%-]*)?$/i;
// e.g. https://play.google.com/store/apps/details?id=com.yashs3090.splitit (extra params like &hl=en ok)
const PLAY_STORE_RE =
  /^https:\/\/play\.google\.com\/store\/apps\/details\?id=[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+(?:&[a-z0-9_]+=[a-z0-9_.%-]*)*$/i;

function readOne(value: string | undefined, re: RegExp, name: string, example: string): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  if (!re.test(raw)) {
    throw new Error(
      `${name} must be an https store listing URL, e.g. ${example} (got ${JSON.stringify(raw)}). ` +
        'Leave it empty to hide the "Get the app" banner.',
    );
  }
  return raw;
}

/**
 * Validates the optional store listing URLs baked into the web bundle. Blank or unset gives null.
 * A bad value throws with the variable's name (like lib/env.ts), so a typo fails at app start
 * instead of sending people to the wrong page.
 *
 * Call with direct member accesses so Expo inlines them:
 *   readStoreUrls({ ios: process.env.EXPO_PUBLIC_IOS_APP_STORE_URL, android: process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL })
 */
export function readStoreUrls(input: { ios: string | undefined; android: string | undefined }): StoreUrls {
  return {
    ios: readOne(input.ios, APP_STORE_RE, IOS_VAR, 'https://apps.apple.com/app/id1234567890'),
    android: readOne(
      input.android,
      PLAY_STORE_RE,
      ANDROID_VAR,
      'https://play.google.com/store/apps/details?id=com.example.app',
    ),
  };
}

/**
 * Which phone/tablet browser this is, or null for desktop and for the native app.
 * iPadOS 13+ Safari reports a Mac user agent by default; a "Mac" with touch points is an iPad.
 */
export function detectMobileWeb(input: { os: string; userAgent: string; maxTouchPoints: number }): MobileWeb | null {
  if (input.os !== 'web') return null;
  const ua = input.userAgent;
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios';
  if (/\bMacintosh\b/.test(ua) && input.maxTouchPoints > 1) return 'ios';
  if (/\bAndroid\b/i.test(ua)) return 'android';
  return null;
}

/** How long "Continue on website" hides the banner. */
export const APP_BANNER_DISMISS_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage key. The value is a millisecond timestamp, nothing else. */
export const APP_BANNER_DISMISSED_KEY = 'splitit.appBanner.dismissedAt';

/** The value to store when the person dismisses the banner. */
export function dismissedValue(now: number): string {
  return String(now);
}

/** True while a stored dismissal is still in its window. Junk, or a time in the future, counts as not dismissed. */
export function isDismissed(stored: string | null, now: number, windowMs: number = APP_BANNER_DISMISS_MS): boolean {
  if (stored === null || !/^\d+$/.test(stored)) return false;
  const at = Number(stored);
  if (!Number.isSafeInteger(at) || at > now) return false;
  return now - at < windowMs;
}

/** What the banner should offer here, or null when it shouldn't show at all. */
export function appBannerTarget(input: {
  os: string;
  userAgent: string;
  maxTouchPoints: number;
  urls: StoreUrls;
  dismissed: string | null;
  now: number;
}): AppBannerTarget | null {
  const store = detectMobileWeb(input);
  if (store === null) return null;
  const url = input.urls[store];
  if (url === null) return null;
  if (isDismissed(input.dismissed, input.now)) return null;
  return { store, url };
}

/** The four safe-area insets, in points (same shape as react-native-safe-area-context's EdgeInsets). */
export type Insets = { top: number; right: number; bottom: number; left: number };

/**
 * The insets for everything rendered below the banner (decision AB-11). While the bar shows it
 * sits at the top of the window and pads for the top inset (status bar, notch) itself, so the
 * screens under it must not add that inset again: their top becomes 0. Left, right and bottom are
 * unchanged. Hidden: the insets pass through as they are.
 */
export function insetsBelowBanner(insets: Insets, bannerShown: boolean): Insets {
  if (!bannerShown || insets.top === 0) return insets;
  return { ...insets, top: 0 };
}
