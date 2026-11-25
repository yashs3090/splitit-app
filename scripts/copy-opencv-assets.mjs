#!/usr/bin/env node
// Copies the self-hosted OpenCV.js file and its license from node_modules into public/opencv/, so
// the web dev server and `expo export -p web` serve them from our own origin (spec Task 6; same
// rule as Tesseract, ADR 0012). public/opencv/ is gitignored: the version comes from
// package-lock.json (@techstark/opencv-js, exact pin).
//
// Only when wanted (scripts/opencv-assets.mjs: WEB_CV_PREPROCESS, or SPLITIT_OPENCV_ASSETS=1);
// otherwise public/opencv/ is removed (spec A1 Q2).
//
// Layout must match lib/scanPipeline/web/cv/protocol.ts:
//   public/opencv/opencv.js                 (loaded by the worker with importScripts, relative path)
//   public/opencv/LICENSE                   (Apache-2.0)
//   public/opencv/receipt-cv-worker.js      (written by scripts/build-cv-worker.mjs)
// Copies a file only when it is missing or differs (size, then SHA-256).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { OPENCV_OUT, opencvAssetsWanted, removeOpencvOut, root } from './opencv-assets.mjs';

const { wanted, why } = opencvAssetsWanted();
if (!wanted) {
  removeOpencvOut();
  console.log(`copy-opencv-assets: skipped (${why}); public/opencv/ removed. Set SPLITIT_OPENCV_ASSETS=1 to copy anyway.`);
  process.exit(0);
}

const require = createRequire(join(root, 'package.json'));
const pkg = dirname(require.resolve('@techstark/opencv-js/package.json'));
const files = [
  [join(pkg, 'dist', 'opencv.js'), 'opencv.js'],
  [join(pkg, 'LICENSE'), 'LICENSE'],
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sameContents = (a, b) => statSync(a).size === statSync(b).size && sha256(a) === sha256(b);

let copied = 0;
for (const [from, rel] of files) {
  if (!existsSync(from)) {
    console.error(`copy-opencv-assets: missing ${from}. Run npm install.`);
    process.exit(1);
  }
  const to = join(OPENCV_OUT, rel);
  if (existsSync(to) && sameContents(from, to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied += 1;
}
console.log(`copy-opencv-assets: ${copied} copied, ${files.length - copied} up to date in ${OPENCV_OUT} (${why})`);
