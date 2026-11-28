import type { ExpoConfig } from 'expo/config';

import {
  AASA_PATH,
  ASSETLINKS_PATH,
  appleAppSiteAssociation,
  assetLinks,
  planWellKnown,
  readAndroidFingerprints,
  readAppLinksEnv,
  readAppleTeamId,
  readLinkHost,
  withAppLinks,
} from './appLinks';

const FP_A = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const FP_B = Array.from({ length: 32 }, () => 'AB').join(':');
const HOST = 'splitit-app-kappa.vercel.app';
const WEB = `https://${HOST}`;

const base: ExpoConfig = {
  name: 'SplitIt',
  slug: 'splitit',
  scheme: 'splitit',
  ios: { bundleIdentifier: 'com.yashs3090.splitit' },
  android: { package: 'com.yashs3090.splitit' },
};

describe('readAppleTeamId', () => {
  it.each([undefined, '', '   '])('is null when unset (%p)', (v) => {
    expect(readAppleTeamId(v)).toBeNull();
  });
  it('accepts a 10-character ID, trimmed and upper-cased', () => {
    expect(readAppleTeamId(' ab12cd34ef\n')).toBe('AB12CD34EF');
  });
  it.each(['AB12CD34E', 'AB12CD34EFG', 'AB12-D34EF', 'AB12CD34EF.com.yashs3090.splitit'])(
    'throws naming APPLE_TEAM_ID for %p',
    (v) => {
      expect(() => readAppleTeamId(v)).toThrow(/APPLE_TEAM_ID/);
    },
  );
});

describe('readAndroidFingerprints', () => {
  it.each([undefined, '', ' , '])('is empty when unset (%p)', (v) => {
    expect(readAndroidFingerprints(v)).toEqual([]);
  });
  it('splits on commas, trims, upper-cases and drops duplicates in order', () => {
    expect(readAndroidFingerprints(` ${FP_B.toLowerCase()} ,${FP_A}, ${FP_B}`)).toEqual([FP_B, FP_A]);
  });
  it('accepts 64 hex digits without colons', () => {
    expect(readAndroidFingerprints(FP_A.split(':').join(''))).toEqual([FP_A]);
  });
  it.each([
    ['a SHA-1 (20 bytes)', FP_A.split(':').slice(0, 20).join(':')],
    ['a truncated paste', FP_A.slice(0, -1)],
    ['a non-hex byte', FP_A.replace(/^../, 'ZZ')],
    ['one bad entry among good ones', `${FP_A},nope`],
  ])('throws naming ANDROID_CERT_SHA256 for %s', (_label, v) => {
    expect(() => readAndroidFingerprints(v)).toThrow(/ANDROID_CERT_SHA256/);
  });
});

describe('readLinkHost', () => {
  it('is null when EXPO_PUBLIC_WEB_URL is unset', () => {
    expect(readLinkHost(undefined)).toBeNull();
    expect(readLinkHost('')).toBeNull();
  });
  it('returns the bare host, lower-cased, without the trailing slash', () => {
    expect(readLinkHost('https://SplitIt-App-Kappa.vercel.app/')).toBe(HOST);
  });
  it('throws for an origin with a port', () => {
    expect(() => readLinkHost(`${WEB}:8443`)).toThrow(/port/);
  });
  it('throws (via readWebUrl) for http or a path', () => {
    expect(() => readLinkHost(`http://${HOST}`)).toThrow(/EXPO_PUBLIC_WEB_URL/);
    expect(() => readLinkHost(`${WEB}/b`)).toThrow(/EXPO_PUBLIC_WEB_URL/);
  });
});

describe('readAppLinksEnv', () => {
  it('ignores the web URL entirely when no app-link variable is set (a dev URL with a port is fine)', () => {
    expect(readAppLinksEnv({ EXPO_PUBLIC_WEB_URL: `${WEB}:8443` })).toEqual({
      appleTeamId: null,
      androidFingerprints: [],
      host: null,
    });
  });
  it('reads all three when set', () => {
    expect(
      readAppLinksEnv({ APPLE_TEAM_ID: 'AB12CD34EF', ANDROID_CERT_SHA256: FP_A, EXPO_PUBLIC_WEB_URL: WEB }),
    ).toEqual({ appleTeamId: 'AB12CD34EF', androidFingerprints: [FP_A], host: HOST });
  });
});

describe('withAppLinks', () => {
  const none = { appleTeamId: null, androidFingerprints: [], host: HOST };

  it('returns the base config unchanged when nothing is set (free Personal Team build)', () => {
    const { config, warnings } = withAppLinks(base, none);
    expect(config).toEqual(base);
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.scheme).toBe('splitit');
    expect(warnings).toEqual([]);
  });

  it('adds associatedDomains and appleTeamId only when the team ID is set', () => {
    const { config, warnings } = withAppLinks(base, { ...none, appleTeamId: 'AB12CD34EF' });
    expect(config.ios).toEqual({
      bundleIdentifier: 'com.yashs3090.splitit',
      appleTeamId: 'AB12CD34EF',
      associatedDomains: [`applinks:${HOST}`],
    });
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.scheme).toBe('splitit');
    expect(warnings).toEqual([]);
  });

  it('adds one autoVerify https intent filter for /b/ only when fingerprints are set', () => {
    const { config } = withAppLinks(base, { ...none, androidFingerprints: [FP_A] });
    expect(config.android?.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: HOST, pathPrefix: '/b/' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ]);
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.scheme).toBe('splitit');
  });

  it('keeps existing domains and filters, does not duplicate the domain, and never mutates the base', () => {
    const withExisting: ExpoConfig = {
      ...base,
      ios: { ...base.ios, associatedDomains: [`applinks:${HOST}`, 'webcredentials:example.com'] },
      android: { ...base.android, intentFilters: [{ action: 'SEND' }] },
    };
    const snapshot = JSON.stringify(withExisting);
    const { config } = withAppLinks(withExisting, { appleTeamId: 'AB12CD34EF', androidFingerprints: [FP_A], host: HOST });
    expect(config.ios?.associatedDomains).toEqual([`applinks:${HOST}`, 'webcredentials:example.com']);
    expect(config.android?.intentFilters).toHaveLength(2);
    expect(config.android?.intentFilters?.[0]).toEqual({ action: 'SEND' });
    expect(JSON.stringify(withExisting)).toBe(snapshot);
  });

  it('adds nothing and warns when a value is set but the web URL is not', () => {
    const { config, warnings } = withAppLinks(base, { appleTeamId: 'AB12CD34EF', androidFingerprints: [FP_A], host: null });
    expect(config).toEqual(base);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/APPLE_TEAM_ID.*EXPO_PUBLIC_WEB_URL/);
    expect(warnings[1]).toMatch(/ANDROID_CERT_SHA256.*EXPO_PUBLIC_WEB_URL/);
  });
});

describe('well-known files', () => {
  it('AASA uses the current applinks.details format with appIDs and a /b/* component', () => {
    expect(JSON.parse(appleAppSiteAssociation('AB12CD34EF', 'com.yashs3090.splitit'))).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['AB12CD34EF.com.yashs3090.splitit'],
            components: [{ '/': '/b/*', comment: 'Bill invite links open the app.' }],
          },
        ],
      },
    });
  });

  it('assetlinks.json is one handle_all_urls statement listing every fingerprint', () => {
    expect(JSON.parse(assetLinks('com.yashs3090.splitit', [FP_A, FP_B]))).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.yashs3090.splitit',
          sha256_cert_fingerprints: [FP_A, FP_B],
        },
      },
    ]);
  });

  const ids = { bundleId: 'com.yashs3090.splitit', packageName: 'com.yashs3090.splitit' };

  it('plans neither file when nothing is set', () => {
    expect(planWellKnown({ appleTeamId: null, androidFingerprints: [] }, ids)).toEqual({
      [AASA_PATH]: null,
      [ASSETLINKS_PATH]: null,
    });
  });

  it('plans each file only when its own variable is set', () => {
    const ios = planWellKnown({ appleTeamId: 'AB12CD34EF', androidFingerprints: [] }, ids);
    expect(ios[AASA_PATH]).toContain('AB12CD34EF.com.yashs3090.splitit');
    expect(ios[ASSETLINKS_PATH]).toBeNull();
    const android = planWellKnown({ appleTeamId: null, androidFingerprints: [FP_A] }, ids);
    expect(android[AASA_PATH]).toBeNull();
    expect(android[ASSETLINKS_PATH]).toContain(FP_A);
  });

  it('throws rather than publish a file with an empty app id', () => {
    expect(() => planWellKnown({ appleTeamId: 'AB12CD34EF', androidFingerprints: [] }, { ...ids, bundleId: undefined })).toThrow(
      /bundleIdentifier/,
    );
    expect(() => planWellKnown({ appleTeamId: null, androidFingerprints: [FP_A] }, { ...ids, packageName: '' })).toThrow(
      /android\.package/,
    );
  });
});
