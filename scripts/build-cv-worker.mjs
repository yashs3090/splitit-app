#!/usr/bin/env node
// Builds the OpenCV Web Worker (lib/scanPipeline/web/cv/worker.ts) with esbuild into
// public/opencv/receipt-cv-worker.js (spec Task 6). A classic worker (IIFE, no `import`), because
// it loads OpenCV with `importScripts`. Metro never sees this file.
//
// Only when wanted (scripts/opencv-assets.mjs); otherwise public/opencv/ is removed. Writes only
// when the output changed, so an unchanged run leaves the file (and its mtime) alone. esbuild is
// imported only after that check (tested in build-cv-worker.test.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OPENCV_OUT, opencvAssetsWanted, removeOpencvOut, root } from './opencv-assets.mjs';

const { wanted, why } = opencvAssetsWanted();
if (!wanted) {
  removeOpencvOut();
  console.log(`build-cv-worker: skipped (${why}).`);
  process.exit(0);
}

// Imported only now: esbuild is a devDependency, and `npm run export:web` with OpenCV off must
// work in an install without devDependencies (review R5).
const { build } = await import('esbuild');
const outfile = join(OPENCV_OUT, 'receipt-cv-worker.js');
const result = await build({
  entryPoints: [join(root, 'lib', 'scanPipeline', 'web', 'cv', 'worker.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // OffscreenCanvas 2d needs Safari 16.4+; the syntax target is lower than that anyway.
  target: ['es2020', 'chrome100', 'safari16', 'firefox100'],
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});
const code = result.outputFiles[0].contents;
if (existsSync(outfile) && Buffer.compare(readFileSync(outfile), Buffer.from(code)) === 0) {
  console.log(`build-cv-worker: up to date (${why})`);
} else {
  mkdirSync(OPENCV_OUT, { recursive: true });
  writeFileSync(outfile, code);
  console.log(`build-cv-worker: wrote ${outfile}, ${code.length} bytes (${why})`);
}
