// "Get the app" bar for the web app on phones and tablets (logic: lib/appBanner.ts; decisions AB-1 …
// AB-10 in docs/decisions-to-review.md). A slim bar above every screen that pushes content down
// rather than covering it. It never navigates inside the app: "Get the app" opens the store
// listing, and ✕ ("Continue on website") hides the bar for 14 days. Renders nothing on native, on
// desktop, after a dismissal, and whenever this platform's store URL isn't configured (today).
//
// Safe area (AB-11): while the bar shows it is the top of the window, so it pads for the top inset
// (status bar, notch; non-zero on web with viewport-fit=cover) inside its own background, and
// everything rendered below it (`children`) gets the same insets with top 0. Screens keep reading
// useSafeAreaInsets()/SafeAreaView as usual and stop adding the inset a second time; nothing for
// them to check. Hidden: the insets pass through untouched.
import Smartphone from 'lucide-react-native/icons/smartphone';
import X from 'lucide-react-native/icons/x';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  APP_BANNER_DISMISSED_KEY,
  appBannerTarget,
  dismissedValue,
  insetsBelowBanner,
  readStoreUrls,
  type AppBannerTarget,
} from '@/lib/appBanner';
import { radius, space, type, useTheme } from '@/lib/theme';

/** Fixed copy (task brief). */
export const APP_BANNER_COPY = {
  line: 'SplitIt works best in the app',
  get: 'Get the app',
  dismiss: 'Continue on website',
  dismissHint: 'Hides this for 14 days',
  region: 'Get the SplitIt app',
} as const;

const STORE_HINT: Record<AppBannerTarget['store'], string> = {
  ios: 'Opens SplitIt in the App Store',
  android: 'Opens SplitIt on Google Play',
};

// The browser globals this reads. Typed here, and every access guarded: the test environment (and
// any non-browser evaluation) has no navigator or localStorage, and Safari can throw on storage.
type BrowserGlobals = {
  navigator?: { userAgent?: unknown; maxTouchPoints?: unknown };
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
};
const browser = globalThis as BrowserGlobals;

function readDismissed(): string | null {
  try {
    return browser.localStorage?.getItem(APP_BANNER_DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

function saveDismissed(now: number): void {
  try {
    browser.localStorage?.setItem(APP_BANNER_DISMISSED_KEY, dismissedValue(now));
  } catch {
    // Storage blocked: the bar still hides for this visit; it comes back on the next one.
  }
}

/** The target to offer, worked out once when the bar mounts. Null: render nothing. */
function initialTarget(): AppBannerTarget | null {
  if (Platform.OS !== 'web') return null;
  // Read only on web, so a bad value can't take down the native app; on web it fails at start,
  // naming the variable (like lib/env.ts). Direct member accesses: Expo inlines them at build time.
  const urls = readStoreUrls({
    ios: process.env.EXPO_PUBLIC_IOS_APP_STORE_URL,
    android: process.env.EXPO_PUBLIC_ANDROID_PLAY_STORE_URL,
  });
  const nav = browser.navigator;
  return appBannerTarget({
    os: Platform.OS,
    userAgent: typeof nav?.userAgent === 'string' ? nav.userAgent : '',
    maxTouchPoints: typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
    urls,
    dismissed: readDismissed(),
    now: Date.now(),
  });
}

/** Repeat taps on "Get the app" within this window are ignored (it opens something outside the app). */
const OPEN_GUARD_MS = 1000;

/** The bar (when it shows) above `children`, which fill the rest of the column. */
export function AppBanner({ children }: { children: ReactNode }) {
  // Decided synchronously on first render (localStorage is synchronous on web), so the bar never
  // pops in and shifts the page after the screen has drawn.
  const [target, setTarget] = useState<AppBannerTarget | null>(initialTarget);
  // The tree keeps one shape whether or not the bar shows, so dismissing it never remounts the
  // screens (or loses their navigation state); only the insets value below changes.
  return (
    <View style={styles.column}>
      {target !== null ? <AppBannerBar target={target} onDismiss={() => setTarget(null)} /> : null}
      <View style={styles.column}>
        <BelowBanner bannerShown={target !== null}>{children}</BelowBanner>
      </View>
    </View>
  );
}

function BelowBanner({ bannerShown, children }: { bannerShown: boolean; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const value = useMemo(() => insetsBelowBanner(insets, bannerShown), [insets, bannerShown]);
  return <SafeAreaInsetsContext.Provider value={value}>{children}</SafeAreaInsetsContext.Provider>;
}

function AppBannerBar({ target, onDismiss }: { target: AppBannerTarget; onDismiss: () => void }) {
  const { colors } = useTheme();
  // The window's insets (this sits above BelowBanner's override). Top: the bar's background runs
  // under the status bar/notch while its content starts below it. Sides: landscape notches.
  const insets = useSafeAreaInsets();
  const lastOpen = useRef(0);

  const openStore = () => {
    const now = Date.now();
    if (now - lastOpen.current < OPEN_GUARD_MS) return;
    lastOpen.current = now;
    // A failure (popup blocked) leaves the bar as it was; the person can tap again or continue.
    Linking.openURL(target.url).catch(() => {});
  };

  const dismiss = () => {
    saveDismissed(Date.now());
    onDismiss();
  };

  return (
    <View
      role="region"
      aria-label={APP_BANNER_COPY.region}
      style={[
        styles.bar,
        {
          backgroundColor: colors.surface,
          borderBottomColor: colors.divider,
          paddingTop: insets.top + space.sm,
          paddingLeft: insets.left + space.lg,
          paddingRight: insets.right + space.xs,
        },
      ]}
    >
      {/* Stand-in mark until the real app icon exists (docs/before-production.md); decorative. */}
      <View style={[styles.mark, { backgroundColor: colors.primarySurface }]}>
        <Icon icon={Smartphone} color={colors.primary} />
      </View>
      {/* Caption, not label weight: the button is the one emphasis in the bar, and on a 320-pt
          phone the line stays at two lines instead of three. */}
      <Text style={[type.caption, styles.line, { color: colors.text }]}>{APP_BANNER_COPY.line}</Text>
      <Button
        label={APP_BANNER_COPY.get}
        variant="secondary"
        onPress={openStore}
        accessibilityHint={STORE_HINT[target.store]}
        style={styles.get}
      />
      <IconButton
        icon={X}
        accessibilityLabel={APP_BANNER_COPY.dismiss}
        accessibilityHint={APP_BANNER_COPY.dismissHint}
        onPress={dismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    // Top, left and right are set inline (they add the safe-area insets): top space.sm, left
    // space.lg, right space.xs (the ✕ has its own 44-pt target with an inset glyph; a smaller edge
    // keeps the glyph on the column edge).
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mark: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Wraps to two lines on a narrow phone rather than squeezing the button.
  line: { flex: 1, flexShrink: 1 },
  // Tighter than the default button so the line keeps its room; the 44-pt height stays.
  get: { paddingHorizontal: space.md },
});
