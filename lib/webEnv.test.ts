import { Platform } from 'react-native';

import { isMobileWeb } from './webEnv';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';

const g = globalThis as { navigator?: unknown };
let saved: PropertyDescriptor | undefined;
beforeEach(() => {
  saved = Object.getOwnPropertyDescriptor(g, 'navigator');
});
afterEach(() => {
  if (saved) Object.defineProperty(g, 'navigator', saved);
  else delete g.navigator;
});
const setNavigator = (value: unknown) => Object.defineProperty(g, 'navigator', { configurable: true, value });

describe('isMobileWeb', () => {
  it.each([
    ['iPhone', IPHONE, 5, true],
    ['Android phone', ANDROID, 5, true],
    ['iPad (reports a Mac with touch points)', MAC, 5, true],
    ['desktop Mac', MAC, 0, false],
  ])('web, %s → %s', (_name, userAgent, maxTouchPoints, want) => {
    jest.replaceProperty(Platform, 'OS', 'web');
    setNavigator({ userAgent, maxTouchPoints });
    expect(isMobileWeb()).toBe(want);
  });

  it('web with no navigator (a non-browser evaluation) → false: treated as desktop', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    setNavigator(undefined);
    expect(isMobileWeb()).toBe(false);
  });

  it.each(['ios', 'android'] as const)('native %s → false even with a phone user agent', (os) => {
    jest.replaceProperty(Platform, 'OS', os);
    setNavigator({ userAgent: IPHONE, maxTouchPoints: 5 });
    expect(isMobileWeb()).toBe(false);
  });
});
