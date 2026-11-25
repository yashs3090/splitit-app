#!/usr/bin/env node
// Decides whether the self-hosted OpenCV files (public/opencv/) are wanted, for
// scripts/copy-opencv-assets.mjs and scripts/build-cv-worker.mjs (spec Task 6, Amendment A1 Q2:
// "if OpenCV shows no gain, keep the code tested but switched off, and don't copy opencv.js into
// the build").
//
// - Default: follows `export const WEB_CV_PREPROCESS = true|false;` in lib/scanPipeline/config.ts,
//   read as text (this is plain Node, it can't import TypeScript). A missing or non-literal line
//   is an error, never a silent default.
// - SPLITIT_OPENCV_ASSETS=1 builds the files anyway (the browser harness and the eval run cv
//   variants while the app flag is off); SPLITIT_OPENCV_ASSETS=0 never builds them.
// - When not wanted, public/opencv/ is removed, so a stale copy from a harness run never reaches dist/.
// - SPLITIT_OPENCV_OUT=<absolute dir> (with SPLITIT_OPENCV_ASSETS=1 only) writes the files there
//   instead of public/opencv/. The OCR harness builds into its own private folder this way, so the
//   app's hooks (`npm run web` / `start`, which remove public/opencv/ while WEB_CV_PREPROCESS is
//   false) can't delete OpenCV in the middle of a harness run.
//
// `node scripts/opencv-assets.mjs --print` prints `true` / `false`; `--print-out` prints the output
// folder (both used by Jest tests).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Where the files go: public/opencv/, or SPLITIT_OPENCV_OUT (absolute; only with SPLITIT_OPENCV_ASSETS=1). */
export function opencvOutDir(env = process.env) {
  const out = env.SPLITIT_OPENCV_OUT;
  if (out === undefined || out === '') return join(root, 'public', 'opencv');
  if (!isAbsolute(out)) throw new Error('opencv-assets: SPLITIT_OPENCV_OUT must be an absolute path');
  // Never "not wanted" with an override: that path would remove the override folder.
  if (env.SPLITIT_OPENCV_ASSETS !== '1') throw new Error('opencv-assets: SPLITIT_OPENCV_OUT needs SPLITIT_OPENCV_ASSETS=1');
  return out;
}

export const OPENCV_OUT = opencvOutDir();
const CONFIG = join(root, 'lib', 'scanPipeline', 'config.ts');

export function flagFromConfig() {
  const m = /^export const WEB_CV_PREPROCESS\s*(?::\s*boolean\s*)?=\s*(true|false)\s*;/m.exec(readFileSync(CONFIG, 'utf8'));
  if (!m) throw new Error('opencv-assets: could not find `export const WEB_CV_PREPROCESS = true|false;` in lib/scanPipeline/config.ts');
  return m[1] === 'true';
}

/** { wanted, why } */
export function opencvAssetsWanted(env = process.env) {
  const force = env.SPLITIT_OPENCV_ASSETS;
  if (force === '1') return { wanted: true, why: 'SPLITIT_OPENCV_ASSETS=1' };
  if (force === '0') return { wanted: false, why: 'SPLITIT_OPENCV_ASSETS=0' };
  if (force !== undefined && force !== '') throw new Error('opencv-assets: SPLITIT_OPENCV_ASSETS must be 1 or 0');
  const flag = flagFromConfig();
  return { wanted: flag, why: `WEB_CV_PREPROCESS is ${flag}` };
}

/** Removes the generated folder. */
export function removeOpencvOut() {
  if (existsSync(OPENCV_OUT)) rmSync(OPENCV_OUT, { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--print')) console.log(String(opencvAssetsWanted().wanted));
  if (process.argv.includes('--print-out')) console.log(OPENCV_OUT);
}
