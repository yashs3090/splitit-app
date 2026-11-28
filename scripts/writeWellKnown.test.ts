// Runs the real scripts/write-well-known.ts (through tsx, as the npm hooks do) into a temp folder:
// each file is written only when its variable is set, and removed again when it's unset.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const script = join(__dirname, 'write-well-known.ts');
const FP = Array.from({ length: 32 }, () => 'C3').join(':');

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'well-known-'));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function run(env: Record<string, string>): string {
  const { APPLE_TEAM_ID: _a, ANDROID_CERT_SHA256: _b, ...rest } = process.env;
  return execFileSync(tsx, [script], {
    env: { ...rest, ...env, SPLITIT_WELL_KNOWN_OUT: out },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const aasa = () => join(out, '.well-known', 'apple-app-site-association');
const assetlinks = () => join(out, '.well-known', 'assetlinks.json');

describe('write-well-known', () => {
  it('writes nothing (and no .well-known folder) when both variables are unset', () => {
    run({});
    expect(existsSync(out)).toBe(true);
    expect(existsSync(join(out, '.well-known'))).toBe(false);
  });

  it('writes both files from app.json ids when both are set, then removes them when unset', () => {
    run({ APPLE_TEAM_ID: 'AB12CD34EF', ANDROID_CERT_SHA256: FP });
    const apple = JSON.parse(readFileSync(aasa(), 'utf8')) as { applinks: { details: { appIDs: string[] }[] } };
    expect(apple.applinks.details[0]?.appIDs).toEqual(['AB12CD34EF.com.yashs3090.splitit']);
    const google = JSON.parse(readFileSync(assetlinks(), 'utf8')) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    expect(google[0]?.target).toEqual({ namespace: 'android_app', package_name: 'com.yashs3090.splitit', sha256_cert_fingerprints: [FP] });

    run({ ANDROID_CERT_SHA256: FP });
    expect(existsSync(aasa())).toBe(false);
    expect(existsSync(assetlinks())).toBe(true);

    run({});
    expect(existsSync(assetlinks())).toBe(false);
    expect(existsSync(join(out, '.well-known'))).toBe(false);
  });

  it('fails the build on an invalid value and leaves no file behind', () => {
    expect(() => run({ APPLE_TEAM_ID: 'not-a-team' })).toThrow();
    expect(existsSync(aasa())).toBe(false);
  });
});
