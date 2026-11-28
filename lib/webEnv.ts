// Facts about the browser the web app runs in. The phone test itself is lib/appBanner.ts's
// detectMobileWeb (pure, tested there); this reads Platform.OS and the real navigator for it.
import { Platform } from 'react-native';

import { detectMobileWeb } from './appBanner';

/**
 * The web app on a phone or tablet (AB-6's one phone test). False in the native app, on desktop
 * web, and where there is no navigator (treated as desktop).
 */
export function isMobileWeb(): boolean {
  const nav: { userAgent?: string; maxTouchPoints?: number } | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  return detectMobileWeb({ os: Platform.OS, userAgent: nav?.userAgent ?? '', maxTouchPoints: nav?.maxTouchPoints ?? 0 }) !== null;
}
