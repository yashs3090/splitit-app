import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

jest.mock('expo-linking', () => ({
  createURL: jest.fn((path: string) => `splitit://${path.replace(/^\//, '')}`),
}));

const CODE = '0123456789abcdef0123';
const ORIGIN = 'https://splitit-xyz.vercel.app';
const ORIGINAL_OS = Platform.OS;
const ORIGINAL_WEB_URL = process.env.EXPO_PUBLIC_WEB_URL;

/** Loads lib/groupInviteLink fresh with EXPO_PUBLIC_WEB_URL set to `webUrl` (it reads the value once, on load). */
function loadGroupInviteUrl(webUrl: string | undefined): (code: string) => string {
  if (webUrl === undefined) delete process.env.EXPO_PUBLIC_WEB_URL;
  else process.env.EXPO_PUBLIC_WEB_URL = webUrl;
  let fn: ((code: string) => string) | undefined;
  jest.isolateModules(() => {
    fn = jest.requireActual<typeof import('./groupInviteLink')>('./groupInviteLink').groupInviteUrl;
  });
  if (!fn) throw new Error('groupInviteLink did not load');
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

describe('groupInviteUrl without EXPO_PUBLIC_WEB_URL (dev)', () => {
  it.each([undefined, '', '  '])('builds the /g/<code> deep link with Linking.createURL when the value is %p', (v) => {
    const groupInviteUrl = loadGroupInviteUrl(v);
    expect(groupInviteUrl(CODE)).toBe(`splitit://g/${CODE}`);
    expect(Linking.createURL).toHaveBeenCalledWith(`/g/${CODE}`);
  });

  it('uses the web origin that createURL returns on web', () => {
    setOS('web');
    const groupInviteUrl = loadGroupInviteUrl(undefined);
    jest.mocked(Linking.createURL).mockImplementationOnce((path: string) => `http://localhost:8081${path}`);
    expect(groupInviteUrl(CODE)).toBe(`http://localhost:8081/g/${CODE}`);
  });

  it('trims and lowercases the code the way normalizeGroupCode does', () => {
    expect(loadGroupInviteUrl(undefined)(`  ${CODE.toUpperCase()}\n`)).toBe(`splitit://g/${CODE}`);
  });
});

describe('groupInviteUrl with EXPO_PUBLIC_WEB_URL set', () => {
  it.each(['web', 'ios', 'android'] as const)('builds <origin>/g/<code> on %s without calling createURL', (os) => {
    setOS(os);
    const groupInviteUrl = loadGroupInviteUrl(ORIGIN);
    expect(groupInviteUrl(CODE)).toBe(`${ORIGIN}/g/${CODE}`);
    expect(Linking.createURL).not.toHaveBeenCalled();
  });

  it('uses the normalized origin (trailing slash trimmed)', () => {
    expect(loadGroupInviteUrl(`${ORIGIN}/`)(CODE)).toBe(`${ORIGIN}/g/${CODE}`);
  });

  it.each(['http://splitit-xyz.vercel.app', 'https://splitit-xyz.vercel.app/app'])(
    'refuses a bad value (%p) as soon as the module loads, naming the variable',
    (bad) => {
      expect(() => loadGroupInviteUrl(bad)).toThrow(/EXPO_PUBLIC_WEB_URL/);
    },
  );
});

describe.each([
  ['unset', undefined],
  ['set', ORIGIN],
])('invalid codes with EXPO_PUBLIC_WEB_URL %s', (_label, webUrl) => {
  it.each([
    ['empty', ''],
    ['a bill-style code', 'abcdefghij12'],
    ['19 hex', CODE.slice(1)],
    ['the stored g- form', `g-${CODE}`],
    ['a slash (path injection)', '0123456789/../evil'],
    ['a scheme', 'https://evil.example'],
  ])('throws RangeError for %s without building a link', (_l, code) => {
    const groupInviteUrl = loadGroupInviteUrl(webUrl);
    expect(() => groupInviteUrl(code)).toThrow(RangeError);
    expect(Linking.createURL).not.toHaveBeenCalled();
  });
});
