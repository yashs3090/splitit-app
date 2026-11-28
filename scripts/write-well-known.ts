// Writes (or removes) the files that let the website vouch for the app, from build-time env vars:
//   public/.well-known/apple-app-site-association   when APPLE_TEAM_ID is set       (iOS Universal Links)
//   public/.well-known/assetlinks.json              when ANDROID_CERT_SHA256 is set (Android App Links)
// A file whose variable is unset is removed, so a stale or wrong file is never published; an
// invalid value fails the build. Run from the prestart / preweb / preexport:web hooks (like the
// Tesseract copy), so `npm run export:web` on Vercel picks up the Vercel env vars.
// Bundle id and package come from app.json. public/.well-known/ is gitignored.
//
// SPLITIT_WELL_KNOWN_OUT=<absolute dir> writes there instead of public/ (used by the Jest test).
// Guide: docs/setup/app-links.md. Logic: lib/appLinks.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { planWellKnown, readAndroidFingerprints, readAppleTeamId } from '../lib/appLinks';

const root = join(__dirname, '..');
const outRoot = process.env.SPLITIT_WELL_KNOWN_OUT?.trim() || join(root, 'public');
if (!isAbsolute(outRoot)) {
  console.error('write-well-known: SPLITIT_WELL_KNOWN_OUT must be an absolute path.');
  process.exit(1);
}

type AppJson = { expo?: { ios?: { bundleIdentifier?: string }; android?: { package?: string } } };

try {
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as AppJson;
  const plan = planWellKnown(
    {
      appleTeamId: readAppleTeamId(process.env.APPLE_TEAM_ID),
      androidFingerprints: readAndroidFingerprints(process.env.ANDROID_CERT_SHA256),
    },
    { bundleId: app.expo?.ios?.bundleIdentifier, packageName: app.expo?.android?.package },
  );
  const lines: string[] = [];
  for (const [rel, contents] of Object.entries(plan)) {
    const file = join(outRoot, rel);
    if (contents === null) {
      if (existsSync(file)) rmSync(file);
      lines.push(`${rel}: not written (variable unset)`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      lines.push(`${rel}: written`);
    }
  }
  const dir = join(outRoot, '.well-known');
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  console.log(`write-well-known: ${lines.join('; ')}`);
} catch (error) {
  console.error(`write-well-known: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
