import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `splitit://${path.replace(/^\//, '')}`),
}));

const CODE = '0123456789abcdef0123';
const ORIGIN = 'https://splitit-xyz.vercel.app';
const ORIGINAL_OS = Platform.OS;
const ORIGINAL_WEB_URL = process.env.EXPO_PUBLIC_WEB_URL;

/**
 * Loads lib/inviteLink fresh with EXPO_PUBLIC_WEB_URL set to `webUrl` (undefined = unset), because the
 * module reads and validates the value once, when it loads (like lib/supabase.ts does).
 */
function loadInviteUrl(webUrl: string | undefined): (code: string) => string {
  if (webUrl === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = webUrl;
  let fn: ((code: string) => string) | undefined;
  jest.isolateModules(() => {
    fn = jest.requireActual<typeof import('./inviteLink')>('./inviteLink').inviteUrl;
  });
  if (!fn) throw new Error('inviteLink did not load');
  return fn;
}

function setOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

afterEach(() => {
  jest.mocked(Linking.createURL).mockClear();
  setOS(ORIGINAL_OS);
  if (ORIGINAL_WEB_URL === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = ORIGINAL_WEB_URL;
});

describe('inviteUrl without EXPO_PUBLIC_WEB_URL (dev behaviour, unchanged)', () => {
  it.each([undefined, '', '  '])('builds the /b/<code> deep link with Linking.createURL when the value is %p', (v) => {
    const inviteUrl = loadInviteUrl(v);
    expect(inviteUrl(CODE)).toBe(`splitit://b/${CODE}`);
    expect(Linking.createURL).toHaveBeenCalledWith(`/b/${CODE}`);
  });

  it('uses the web origin that createURL returns on web', () => {
    setOS('web');
    const inviteUrl = loadInviteUrl(undefined);
    jest.mocked(Linking.createURL).mockImplementationOnce((path: string) => `http://localhost:8081${path}`);
    expect(inviteUrl(CODE)).toBe(`http://localhost:8081/b/${CODE}`);
  });

  it('trims the code the same way normalizeInviteCode does', () => {
    expect(loadInviteUrl(undefined)(`  ${CODE}\n`)).toBe(`splitit://b/${CODE}`);
  });
});

describe('inviteUrl with EXPO_PUBLIC_WEB_URL set (friend-test deploy)', () => {
  it.each(['web', 'ios', 'android'] as const)('builds <origin>/b/<code> on %s without calling createURL', (os) => {
    setOS(os);
    const inviteUrl = loadInviteUrl(ORIGIN);
    expect(inviteUrl(CODE)).toBe(`${ORIGIN}/b/${CODE}`);
    expect(Linking.createURL).not.toHaveBeenCalled();
  });

  it('uses the normalized origin (trailing slash trimmed)', () => {
    expect(loadInviteUrl(`${ORIGIN}/`)(CODE)).toBe(`${ORIGIN}/b/${CODE}`);
  });

  it('trims the code', () => {
    expect(loadInviteUrl(ORIGIN)(` ${CODE} `)).toBe(`${ORIGIN}/b/${CODE}`);
  });

  it.each(['http://splitit-xyz.vercel.app', 'https://splitit-xyz.vercel.app/app', 'https://x.example?q=1'])(
    'refuses a bad value (%p) as soon as the module loads, naming the variable',
    (bad) => {
      expect(() => loadInviteUrl(bad)).toThrow(/EXPO_PUBLIC_WEB_URL/);
    },
  );
});

describe.each([
  ['unset', undefined],
  ['set', ORIGIN],
])('invalid codes with EXPO_PUBLIC_WEB_URL %s', (_label, webUrl) => {
  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['a slash (path injection)', '0123456789/../evil'],
    ['a query string', '0123456789abcdef?x=1'],
    ['a scheme', 'https://evil.example'],
  ])('throws RangeError for %s without building a link', (_l, code) => {
    const inviteUrl = loadInviteUrl(webUrl);
    expect(() => inviteUrl(code)).toThrow(RangeError);
    expect(Linking.createURL).not.toHaveBeenCalled();
  });
});
