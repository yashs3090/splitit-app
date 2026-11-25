// The harness's own copy of the OpenCV files (spec Task 9 harness fix).
//
// Why not public/opencv/: the app's `npm run web` / `npm start` hooks remove public/opencv/ while
// WEB_CV_PREPROCESS is false (spec A1 Q2), so a dev server started during a harness run deleted
// OpenCV mid-run and the cv variants silently read without it (Task 8). The harness now builds
// opencv.js + the worker into eval/receipts/.harness-opencv-<pid>/ (gitignored, inside the only
// folder the harness writes to), serves /opencv/ from there, re-checks it before every photo, and
// removes it at the end. Nothing else touches that folder.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The files the worker needs (layout of lib/scanPipeline/web/cv/protocol.ts). */
export const CV_ASSET_FILES = ['opencv.js', 'receipt-cv-worker.js'] as const;

const PREFIX = '.harness-opencv-';

export function harnessCvDir(evalDir: string, pid = process.pid): string {
  return join(evalDir, `${PREFIX}${pid}`);
}

/** Copies opencv.js and builds the worker into `dir` with the repo's own scripts. */
export function buildHarnessCvAssets(root: string, dir: string, stdio: 'inherit' | 'ignore' = 'inherit'): void {
  const env = { ...process.env, SPLITIT_OPENCV_ASSETS: '1', SPLITIT_OPENCV_OUT: dir };
  for (const script of ['copy-opencv-assets.mjs', 'build-cv-worker.mjs']) {
    execFileSync(process.execPath, [join(root, 'scripts', script)], { env, stdio });
  }
}

/** The needed files missing (or empty) in `dir`. */
export function missingCvAssets(dir: string): string[] {
  return CV_ASSET_FILES.filter((f) => {
    const p = join(dir, f);
    return !existsSync(p) || statSync(p).size === 0;
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes private folders left by harness runs that crashed (their process is gone). Returns them. */
export function removeStaleHarnessCvDirs(evalDir: string, isAlive: (pid: number) => boolean = alive): string[] {
  if (!existsSync(evalDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(evalDir)) {
    const m = new RegExp(`^${PREFIX.replace('.', '\\.')}(\\d+)$`).exec(name);
    if (!m || isAlive(Number(m[1]))) continue;
    rmSync(join(evalDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
