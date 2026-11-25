#!/usr/bin/env node
// Copies the self-hosted Tesseract.js assets from node_modules into public/tesseract/ so the web
// dev server and `expo export -p web` serve them from our own origin (spec A3 / Task 9; user's
// choice: self-host, no jsDelivr). public/tesseract/ is gitignored: the versions come from
// package-lock.json, and nobody commits ~15 MB of binaries.
//
// Layout must match `tesseractPaths()` in lib/webOcrEngine.ts:
//   public/tesseract/worker.min.js
//   public/tesseract/core/tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js   (OEM 1 = LSTM only)
//   public/tesseract/lang/eng.traineddata.gz                                  (4.0.0_best_int)
// Copies a file only when it is missing or its contents differ (size first, then a SHA-256 of both
// files), so a same-size package update is still picked up and an unchanged run copies nothing.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));
const out = join(root, 'public', 'tesseract');

const files = [
  [join(pkgDir('tesseract.js'), 'dist', 'worker.min.js'), 'worker.min.js'],
  [join(pkgDir('tesseract.js'), 'LICENSE.md'), 'LICENSE-tesseract.js.md'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map(
    (f) => [join(pkgDir('tesseract.js-core'), f), join('core', f)],
  ),
  [join(pkgDir('tesseract.js-core'), 'LICENSE'), join('core', 'LICENSE')],
  [join(pkgDir('@tesseract.js-data/eng'), '4.0.0_best_int', 'eng.traineddata.gz'), join('lang', 'eng.traineddata.gz')],
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sameContents = (a, b) => statSync(a).size === statSync(b).size && sha256(a) === sha256(b);

let copied = 0;
for (const [from, rel] of files) {
  if (!existsSync(from)) {
    console.error(`copy-tesseract-assets: missing ${from}. Run npm install.`);
    process.exit(1);
  }
  const to = join(out, rel);
  if (existsSync(to) && sameContents(from, to)) continue;
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied += 1;
}
console.log(`copy-tesseract-assets: ${copied} copied, ${files.length - copied} up to date in public/tesseract/`);
