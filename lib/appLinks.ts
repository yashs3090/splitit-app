// iOS Universal Links and Android App Links for invite links (`https://<host>/b/<code>`).
// Setup guide: docs/setup/app-links.md.
//
// Pure logic shared by app.config.ts (native config, evaluated by the Expo CLI in Node) and
// scripts/write-well-known.ts (the files the website serves). No React Native imports: this file
// runs in Node, never in the app bundle.
//
// Everything is driven by build-time env vars that are NOT `EXPO_PUBLIC_` (nothing here ships in
// the app's JavaScript):
// - APPLE_TEAM_ID: 10-character Apple Developer Team ID. Only a paid team can sign the Associated
//   Domains entitlement, so `ios.associatedDomains` is added only when this is set; the free
//   Personal Team build keeps working without it.
// - ANDROID_CERT_SHA256: comma-separated SHA-256 signing-certificate fingerprints
//   (`AA:BB:…`, 32 bytes). The Android `autoVerify` intent filter is added only when set.
// - EXPO_PUBLIC_WEB_URL: the website origin (the same value lib/inviteLink.ts builds links from);
//   its host is the link domain. The native side needs it; the well-known files don't.
// The `splitit://` scheme stays in app.json either way.
import type { ExpoConfig } from 'expo/config';

import { readWebUrl } from './env';

export const TEAM_ID_VAR = 'APPLE_TEAM_ID';
export const FINGERPRINTS_VAR = 'ANDROID_CERT_SHA256';

/** The invite route the links open (app/b/[code].tsx). Keep in step with lib/inviteLink.ts. */
export const INVITE_PATH_PREFIX = '/b/';

export type AppLinksEnv = {
  /** Apple Team ID, or null when unset. */
  appleTeamId: string | null;
  /** Upper-case, colon-separated SHA-256 fingerprints; empty when unset. */
  androidFingerprints: string[];
  /** Bare host of EXPO_PUBLIC_WEB_URL (no scheme, no port), or null when unset. */
  host: string | null;
};

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const FINGERPRINT_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;

/** Throws naming APPLE_TEAM_ID unless the value is empty or a 10-character team ID. */
export function readAppleTeamId(value: string | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (!raw) return null;
  const id = raw.toUpperCase();
  if (!TEAM_ID_RE.test(id)) {
    throw new Error(
      `${TEAM_ID_VAR} must be your 10-character Apple Developer Team ID (letters and digits, e.g. AB12CD34EF), ` +
        `from developer.apple.com → Account → Membership details. Leave it unset for a free Personal Team build.`,
    );
  }
  return id;
}

/**
 * Comma-separated SHA-256 fingerprints → upper-case `AA:BB:…` list, de-duplicated, order kept.
 * Accepts the colon form in either case, or 64 hex digits with no colons. Throws naming
 * ANDROID_CERT_SHA256 on anything else (a SHA-1, a truncated paste), so a wrong file is never published.
 */
export function readAndroidFingerprints(value: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const raw = part.trim().toUpperCase();
    if (!raw) continue;
    const colon = /^[0-9A-F]{64}$/.test(raw) ? (raw.match(/../g) ?? []).join(':') : raw;
    if (!FINGERPRINT_RE.test(colon)) {
      throw new Error(
        `${FINGERPRINTS_VAR} must be comma-separated SHA-256 certificate fingerprints, each 32 bytes like ` +
          `"AB:CD:…" (95 characters). A SHA-1 fingerprint (20 bytes) won't work.`,
      );
    }
    if (!out.includes(colon)) out.push(colon);
  }
  return out;
}

/** The bare host of EXPO_PUBLIC_WEB_URL, or null when unset. Throws if the origin has a port. */
export function readLinkHost(webUrl: string | undefined): string | null {
  const origin = readWebUrl(webUrl);
  if (origin === null) return null;
  const host = origin.slice('https://'.length);
  if (host.includes(':')) {
    throw new Error(
      `EXPO_PUBLIC_WEB_URL has a port (${host}). App links need a plain https host on port 443, e.g. https://splitit-xyz.vercel.app.`,
    );
  }
  return host;
}

/**
 * Reads the three variables. The web URL is only checked when app links are wanted (a team ID or
 * fingerprints are set), so a dev setup without them never fails here.
 */
export function readAppLinksEnv(env: Record<string, string | undefined>): AppLinksEnv {
  const appleTeamId = readAppleTeamId(env[TEAM_ID_VAR]);
  const androidFingerprints = readAndroidFingerprints(env[FINGERPRINTS_VAR]);
  const wanted = appleTeamId !== null || androidFingerprints.length > 0;
  return { appleTeamId, androidFingerprints, host: wanted ? readLinkHost(env.EXPO_PUBLIC_WEB_URL) : null };
}

export type AppLinksResult = { config: ExpoConfig; warnings: string[] };

/**
 * Adds the native link config to the base (app.json) config. Never mutates `base`.
 * - iOS: `appleTeamId` + `associatedDomains: ['applinks:<host>']`, only with a team ID and a host.
 * - Android: one `autoVerify` intent filter for `https://<host>/b/…`, only with fingerprints and a host.
 * A team ID or fingerprints without a host add nothing and return a warning instead.
 */
export function withAppLinks(base: ExpoConfig, env: AppLinksEnv): AppLinksResult {
  const warnings: string[] = [];
  let ios = base.ios;
  let android = base.android;
  const { host, appleTeamId, androidFingerprints } = env;

  if (appleTeamId !== null) {
    if (host === null) {
      warnings.push(`${TEAM_ID_VAR} is set but EXPO_PUBLIC_WEB_URL isn't, so iOS Universal Links were not added.`);
    } else {
      const domain = `applinks:${host}`;
      const existing = ios?.associatedDomains ?? [];
      ios = {
        ...ios,
        appleTeamId,
        associatedDomains: existing.includes(domain) ? existing : [...existing, domain],
      };
    }
  }

  if (androidFingerprints.length > 0) {
    if (host === null) {
      warnings.push(`${FINGERPRINTS_VAR} is set but EXPO_PUBLIC_WEB_URL isn't, so Android App Links were not added.`);
    } else {
      android = {
        ...android,
        intentFilters: [
          ...(android?.intentFilters ?? []),
          {
            action: 'VIEW',
            autoVerify: true,
            data: [{ scheme: 'https', host, pathPrefix: INVITE_PATH_PREFIX }],
            category: ['BROWSABLE', 'DEFAULT'],
          },
        ],
      };
    }
  }

  return { config: { ...base, ios, android }, warnings };
}

// ---- Well-known files (served by the website) ----

export const AASA_PATH = '.well-known/apple-app-site-association';
export const ASSETLINKS_PATH = '.well-known/assetlinks.json';

/** Apple's current `components` format (iOS 14+; the app needs iOS 16.4+). */
export function appleAppSiteAssociation(teamId: string, bundleId: string): string {
  const aasa = {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: [{ '/': `${INVITE_PATH_PREFIX}*`, comment: 'Bill invite links open the app.' }],
        },
      ],
    },
  };
  return `${JSON.stringify(aasa, null, 2)}\n`;
}

/** Digital Asset Links statement for Android App Links. */
export function assetLinks(packageName: string, fingerprints: string[]): string {
  const statement = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: fingerprints },
    },
  ];
  return `${JSON.stringify(statement, null, 2)}\n`;
}

/**
 * What public/.well-known/ should hold: each path maps to its contents, or null when it must not
 * exist (its env value is unset, so nothing wrong is published). The host isn't needed: the files
 * are served from whatever domain the site is on.
 */
export function planWellKnown(
  env: Pick<AppLinksEnv, 'appleTeamId' | 'androidFingerprints'>,
  ids: { bundleId: string | undefined; packageName: string | undefined },
): Record<typeof AASA_PATH | typeof ASSETLINKS_PATH, string | null> {
  if (env.appleTeamId !== null && !ids.bundleId) throw new Error('app.json has no expo.ios.bundleIdentifier.');
  if (env.androidFingerprints.length > 0 && !ids.packageName) throw new Error('app.json has no expo.android.package.');
  return {
    [AASA_PATH]: env.appleTeamId === null ? null : appleAppSiteAssociation(env.appleTeamId, ids.bundleId ?? ''),
    [ASSETLINKS_PATH]:
      env.androidFingerprints.length === 0 ? null : assetLinks(ids.packageName ?? '', env.androidFingerprints),
  };
}
