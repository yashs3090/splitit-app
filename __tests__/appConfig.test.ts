// app.config.ts on top of the real app.json: unchanged with the app-link env vars unset (so the free
// Personal Team build keeps working), links added only when they're set. docs/setup/app-links.md.
import type { ConfigContext, ExpoConfig } from 'expo/config';

import appConfig from '../app.config';

const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const appJson = (JSON.parse(fs.readFileSync(`${process.cwd()}/app.json`, 'utf8')) as { expo: ExpoConfig }).expo;

const VARS = ['APPLE_TEAM_ID', 'ANDROID_CERT_SHA256', 'EXPO_PUBLIC_WEB_URL'] as const;
const saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};
const FP = Array.from({ length: 32 }, () => '0F').join(':');

function run(env: Partial<Record<(typeof VARS)[number], string>>): ExpoConfig {
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, env);
  return appConfig({ config: structuredClone(appJson) } as ConfigContext);
}

beforeAll(() => {
  for (const v of VARS) saved[v] = process.env[v];
});
afterAll(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe('app.config.ts', () => {
  it('is exactly app.json when the app-link variables are unset, even with a web URL', () => {
    expect(run({ EXPO_PUBLIC_WEB_URL: 'https://splitit-app-kappa.vercel.app' })).toEqual(appJson);
    expect(run({})).toEqual(appJson);
  });

  it('adds Associated Domains and the team only with APPLE_TEAM_ID set', () => {
    const config = run({ APPLE_TEAM_ID: 'AB12CD34EF', EXPO_PUBLIC_WEB_URL: 'https://splitit-app-kappa.vercel.app' });
    expect(config.ios?.associatedDomains).toEqual(['applinks:splitit-app-kappa.vercel.app']);
    expect(config.ios?.appleTeamId).toBe('AB12CD34EF');
    expect(config.ios?.bundleIdentifier).toBe('com.yashs3090.splitit');
    expect(config.android?.intentFilters).toBeUndefined();
    expect(config.scheme).toBe('splitit');
    expect(config.plugins).toEqual(appJson.plugins);
  });

  it('adds the Android App Links filter only with ANDROID_CERT_SHA256 set', () => {
    const config = run({ ANDROID_CERT_SHA256: FP, EXPO_PUBLIC_WEB_URL: 'https://splitit-app-kappa.vercel.app' });
    expect(config.android?.intentFilters?.[0]).toMatchObject({
      autoVerify: true,
      data: [{ scheme: 'https', host: 'splitit-app-kappa.vercel.app', pathPrefix: '/b/' }],
    });
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.scheme).toBe('splitit');
  });

  it('warns and adds nothing when APPLE_TEAM_ID is set without a web URL', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(run({ APPLE_TEAM_ID: 'AB12CD34EF' })).toEqual(appJson);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/EXPO_PUBLIC_WEB_URL/));
    } finally {
      warn.mockRestore();
    }
  });

  it('fails loudly on a malformed APPLE_TEAM_ID', () => {
    expect(() => run({ APPLE_TEAM_ID: 'nope', EXPO_PUBLIC_WEB_URL: 'https://splitit-app-kappa.vercel.app' })).toThrow(
      /APPLE_TEAM_ID/,
    );
  });
});

// The push entitlement (docs/specs/2026-11-26-sent-via-venmo.md, Task 8, criterion 53). expo-notifications'
// config plugin always adds `aps-environment`, which the free Personal Team can't sign, and local
// notifications don't need it. plugins/withoutPushEntitlement.js deletes it; it must be listed BEFORE
// "expo-notifications" because mods registered earlier run later. These cases run the real prebuild
// pipeline (the same one `npx expo prebuild` uses) in introspect mode, so nothing is written to disk.
describe('iOS entitlements after prebuild (no push entitlement)', () => {
  type Entitlements = Record<string, unknown>;
  type Introspected = { _internal?: { modResults?: { ios?: { entitlements?: Entitlements } } } };
  const { getPrebuildConfigAsync } = jest.requireActual<{
    getPrebuildConfigAsync(root: string, props: { platforms: string[] }): Promise<{ exp: ExpoConfig }>;
  }>('@expo/prebuild-config');
  const { compileModsAsync } = jest.requireActual<{
    compileModsAsync(config: ExpoConfig, props: Record<string, unknown>): Promise<ExpoConfig & Introspected>;
  }>('@expo/config-plugins');

  async function entitlements(env: Partial<Record<(typeof VARS)[number], string>>): Promise<Entitlements> {
    for (const v of VARS) delete process.env[v];
    Object.assign(process.env, env);
    const { exp } = await getPrebuildConfigAsync(process.cwd(), { platforms: ['ios'] });
    const out = await compileModsAsync(exp, {
      projectRoot: process.cwd(),
      platforms: ['ios'],
      introspect: true,
      assertMissingModProviders: false,
    });
    const result = out._internal?.modResults?.ios?.entitlements;
    if (result === undefined) throw new Error('introspection returned no iOS entitlements');
    return result;
  }

  function pluginName(entry: NonNullable<ExpoConfig['plugins']>[number]): unknown {
    return Array.isArray(entry) ? entry[0] : entry;
  }

  it('app.json lists ./plugins/withoutPushEntitlement before expo-notifications', () => {
    const names = (appJson.plugins ?? []).map(pluginName);
    const strip = names.indexOf('./plugins/withoutPushEntitlement');
    const notifications = names.indexOf('expo-notifications');
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(notifications).toBeGreaterThan(strip);
  });

  it('has no aps-environment on the plain app.json path', async () => {
    const ent = await entitlements({});
    expect(ent).not.toHaveProperty('aps-environment');
    // The check can see entitlements at all: introspection returned an object.
    expect(typeof ent).toBe('object');
  }, 60000);

  it('has no aps-environment with APPLE_TEAM_ID set, and keeps associated-domains', async () => {
    const ent = await entitlements({
      APPLE_TEAM_ID: 'AB12CD34EF',
      EXPO_PUBLIC_WEB_URL: 'https://splitit-app-kappa.vercel.app',
    });
    expect(ent).not.toHaveProperty('aps-environment');
    // Positive control: this path does add an entitlement, so an empty result can't pass by accident.
    expect(ent['com.apple.developer.associated-domains']).toEqual(['applinks:splitit-app-kappa.vercel.app']);
  }, 60000);
});
