import {
  APP_BANNER_DISMISS_MS,
  appBannerTarget,
  detectMobileWeb,
  dismissedValue,
  insetsBelowBanner,
  isDismissed,
  readStoreUrls,
} from './appBanner';

const IOS_URL = 'https://apps.apple.com/us/app/splitit/id1234567890';
const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.yashs3090.splitit';
const URLS = { ios: IOS_URL, android: PLAY_URL };

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ Safari asks for desktop sites and reports a Mac; only touch support tells them apart.
  macOrIpad:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
};

describe('readStoreUrls', () => {
  it('returns nulls when neither variable is set or both are blank', () => {
    expect(readStoreUrls({ ios: undefined, android: undefined })).toEqual({ ios: null, android: null });
    expect(readStoreUrls({ ios: '  ', android: '' })).toEqual({ ios: null, android: null });
  });

  it('accepts App Store and Play Store listing URLs, trimmed', () => {
    expect(readStoreUrls({ ios: ` ${IOS_URL} `, android: PLAY_URL })).toEqual(URLS);
    expect(readStoreUrls({ ios: 'https://apps.apple.com/app/id1234567890', android: undefined })).toEqual({
      ios: 'https://apps.apple.com/app/id1234567890',
      android: null,
    });
    expect(
      readStoreUrls({ ios: undefined, android: 'https://play.google.com/store/apps/details?id=com.example.app&hl=en' }),
    ).toEqual({ ios: null, android: 'https://play.google.com/store/apps/details?id=com.example.app&hl=en' });
  });

  it.each([
    ['http, not https', 'http://apps.apple.com/app/id1'],
    ['another host', 'https://evil.example/app/id1'],
    ['a look-alike host', 'https://apps.apple.com.evil.example/app/id1'],
    ['credentials', 'https://user@apps.apple.com/app/id1'],
    ['the Play URL in the iOS variable', PLAY_URL],
    ['no app id', 'https://apps.apple.com/'],
    ['a script URL', 'javascript:alert(1)'],
  ])('rejects an iOS value with %s, naming the variable', (_label, value) => {
    expect(() => readStoreUrls({ ios: value, android: undefined })).toThrow(/EXPO_PUBLIC_IOS_APP_STORE_URL/);
  });

  it.each([
    ['http, not https', 'http://play.google.com/store/apps/details?id=com.example'],
    ['another host', 'https://play.google.com.evil.example/store/apps/details?id=com.example'],
    ['the App Store URL in the Android variable', IOS_URL],
    ['no package id', 'https://play.google.com/store/apps/details'],
    ['a market: link', 'market://details?id=com.example'],
  ])('rejects an Android value with %s, naming the variable', (_label, value) => {
    expect(() => readStoreUrls({ ios: undefined, android: value })).toThrow(/EXPO_PUBLIC_ANDROID_PLAY_STORE_URL/);
  });
});

describe('detectMobileWeb', () => {
  it.each([
    ['iPhone Safari', UA.iphoneSafari, 5, 'ios'],
    ['iPhone Chrome', UA.iphoneChrome, 5, 'ios'],
    ['an older iPad', UA.ipadOld, 5, 'ios'],
    ['an iPad asking for the desktop site', UA.macOrIpad, 5, 'ios'],
    ['Android Chrome', UA.androidChrome, 5, 'android'],
    ['an Android tablet', UA.androidTablet, 10, 'android'],
  ] as const)('%s on web is %s', (_label, userAgent, maxTouchPoints, expected) => {
    expect(detectMobileWeb({ os: 'web', userAgent, maxTouchPoints })).toBe(expected);
  });

  it.each([
    ['a Mac (no touch)', UA.macOrIpad, 0],
    ['Windows Chrome', UA.windowsChrome, 0],
    ['a Windows touch laptop', UA.windowsChrome, 10],
    ['Linux Firefox', UA.linuxFirefox, 0],
    ['an empty user agent', '', 0],
  ])('%s is desktop (null)', (_label, userAgent, maxTouchPoints) => {
    expect(detectMobileWeb({ os: 'web', userAgent, maxTouchPoints })).toBeNull();
  });

  it.each(['ios', 'android'] as const)('the native %s app is never mobile web, whatever the user agent', (os) => {
    expect(detectMobileWeb({ os, userAgent: UA.iphoneSafari, maxTouchPoints: 5 })).toBeNull();
    expect(detectMobileWeb({ os, userAgent: UA.androidChrome, maxTouchPoints: 5 })).toBeNull();
  });
});

describe('isDismissed', () => {
  const now = 1_800_000_000_000;

  it('is false when nothing was stored, or the value is junk', () => {
    expect(isDismissed(null, now)).toBe(false);
    expect(isDismissed('', now)).toBe(false);
    expect(isDismissed('yes', now)).toBe(false);
    expect(isDismissed('{"at":1}', now)).toBe(false);
    expect(isDismissed('NaN', now)).toBe(false);
  });

  it('is true for the whole dismissal window and false from its end', () => {
    expect(isDismissed(dismissedValue(now), now)).toBe(true);
    expect(isDismissed(dismissedValue(now), now + APP_BANNER_DISMISS_MS - 1)).toBe(true);
    expect(isDismissed(dismissedValue(now), now + APP_BANNER_DISMISS_MS)).toBe(false);
  });

  it('treats a time in the future (clock change or tampering) as not dismissed', () => {
    expect(isDismissed(dismissedValue(now + 1), now)).toBe(false);
  });

  it('lasts 14 days', () => {
    expect(APP_BANNER_DISMISS_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('stores only a timestamp', () => {
    expect(dismissedValue(now)).toBe(String(now));
  });
});

describe('appBannerTarget', () => {
  const now = 1_800_000_000_000;
  const base = { os: 'web', maxTouchPoints: 5, urls: URLS, dismissed: null, now } as const;

  it('iPhone: the App Store', () => {
    expect(appBannerTarget({ ...base, userAgent: UA.iphoneSafari })).toEqual({ store: 'ios', url: IOS_URL });
  });

  it('Android: Google Play', () => {
    expect(appBannerTarget({ ...base, userAgent: UA.androidChrome })).toEqual({ store: 'android', url: PLAY_URL });
  });

  it('desktop: nothing', () => {
    expect(appBannerTarget({ ...base, userAgent: UA.windowsChrome, maxTouchPoints: 0 })).toBeNull();
  });

  it('native app: nothing', () => {
    expect(appBannerTarget({ ...base, os: 'ios', userAgent: UA.iphoneSafari })).toBeNull();
    expect(appBannerTarget({ ...base, os: 'android', userAgent: UA.androidChrome })).toBeNull();
  });

  it('no store URLs (today): nothing on either phone', () => {
    const urls = { ios: null, android: null };
    expect(appBannerTarget({ ...base, urls, userAgent: UA.iphoneSafari })).toBeNull();
    expect(appBannerTarget({ ...base, urls, userAgent: UA.androidChrome })).toBeNull();
  });

  it("only the other platform's store set: nothing (never send an iPhone to Google Play)", () => {
    expect(appBannerTarget({ ...base, urls: { ios: null, android: PLAY_URL }, userAgent: UA.iphoneSafari })).toBeNull();
    expect(appBannerTarget({ ...base, urls: { ios: IOS_URL, android: null }, userAgent: UA.androidChrome })).toBeNull();
  });

  it('dismissed: nothing until the window ends', () => {
    const dismissed = dismissedValue(now);
    expect(appBannerTarget({ ...base, dismissed, userAgent: UA.iphoneSafari })).toBeNull();
    expect(
      appBannerTarget({ ...base, dismissed, now: now + APP_BANNER_DISMISS_MS, userAgent: UA.iphoneSafari }),
    ).toEqual({ store: 'ios', url: IOS_URL });
  });
});

describe('insetsBelowBanner', () => {
  const insets = { top: 47, right: 0, bottom: 34, left: 0 };

  it('banner shown: the screens below get top 0 and keep the other edges', () => {
    expect(insetsBelowBanner(insets, true)).toEqual({ top: 0, right: 0, bottom: 34, left: 0 });
    expect(insetsBelowBanner({ top: 20, right: 44, bottom: 21, left: 44 }, true)).toEqual({
      top: 0,
      right: 44,
      bottom: 21,
      left: 44,
    });
  });

  it('banner hidden: the insets pass through unchanged (same object, so no re-render below)', () => {
    expect(insetsBelowBanner(insets, false)).toBe(insets);
  });

  it('no top inset: same object either way', () => {
    const flat = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(insetsBelowBanner(flat, true)).toBe(flat);
  });
});
