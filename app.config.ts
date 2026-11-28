// Dynamic config on top of app.json (which stays the base: edit app settings there).
// Adds iOS Universal Links / Android App Links for invite links only when their build-time env
// vars are set (APPLE_TEAM_ID, ANDROID_CERT_SHA256, plus EXPO_PUBLIC_WEB_URL for the host); with
// them unset the result is exactly app.json, so the free Personal Team build is unchanged.
// See lib/appLinks.ts and docs/setup/app-links.md.
// tsx's require hook lets this file import another TypeScript file (Expo docs: guides/typescript,
// "App config"); tsx is already a devDependency (exact pin).
import 'tsx/cjs';

import type { ConfigContext, ExpoConfig } from 'expo/config';

import { readAppLinksEnv, withAppLinks } from './lib/appLinks';

export default ({ config }: ConfigContext): ExpoConfig => {
  const { config: out, warnings } = withAppLinks(config as ExpoConfig, readAppLinksEnv(process.env));
  for (const warning of warnings) console.warn(`app.config.ts: ${warning}`);
  return out;
};
