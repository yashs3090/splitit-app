// scripts/build-cv-worker.mjs must not need esbuild (a devDependency) when OpenCV is off, so
// `npm run export:web` works in an install without devDependencies (review R5). The script and its
// helper are copied into a temp folder with no node_modules above it, where `esbuild` can't resolve.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'splitit-cvworker-'));
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['build-cv-worker.mjs', 'opencv-assets.mjs']) copyFileSync(join(__dirname, f), join(dir, 'scripts', f));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(assets: '0' | '1'): string {
  const { SPLITIT_OPENCV_ASSETS: _a, SPLITIT_OPENCV_OUT: _b, NODE_PATH: _c, ...rest } = process.env;
  return execFileSync(process.execPath, [join(dir, 'scripts', 'build-cv-worker.mjs')], {
    cwd: dir,
    env: { ...rest, SPLITIT_OPENCV_ASSETS: assets },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('build-cv-worker without esbuild', () => {
  it('this setup really has no esbuild: a wanted build fails on the esbuild import', () => {
    let stderr = '';
    try {
      run('1');
    } catch (e) {
      stderr = String((e as { stderr?: unknown }).stderr);
    }
    expect(stderr).toMatch(/Cannot find (package|module) 'esbuild'/);
  });

  it('OpenCV off → skips and exits 0 without importing esbuild', () => {
    expect(run('0')).toContain('build-cv-worker: skipped (SPLITIT_OPENCV_ASSETS=0)');
  });
});
