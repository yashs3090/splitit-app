// Headless-browser OCR harness (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, Task 4, C1).
//
//   npm run ocr:harness -- --variants web-current [--only <name,...>] [--browser chromium|webkit]
//                          [--repeat <n>] [--timeout-ms <ms>] [--photos <dir>] [--dump-binary]
//
// For each photo in receipts/ and each variant, runs the app's own web scan pipeline in a real browser
// (page.ts) and writes eval/receipts/<name>.<variant>.ocr.json (C1). `npm run eval` and
// `npx tsx scripts/eval-init.ts` read those files.
//
// Guards:
// - The page bundle is built in memory and served with public/ and the photos by a read-only server on
//   127.0.0.1 (server.ts). Photos are read in place and never copied.
// - Every browser request whose host isn't the harness server is aborted and recorded; the browser's
//   proxy is a local trap that refuses and records anything that gets past that (worker requests
//   included). Any such request fails the run (exit 1) and nothing from that photo is written.
// - The only files written are eval/receipts/<name>.<variant>.ocr.json (gitignored).
// - `--repeat n` reads each photo n times, each in a fresh browser context, and fails if the lines
//   differ or a run fails (E0: criterion 13). The first successful run's file is written.
// - `--timeout-ms` (default 300000) bounds each run; a timeout names the phase and pipeline step.
// - cv variants (spec Task 9 fix): OpenCV is built into a private folder,
//   eval/receipts/.harness-opencv-<pid>/ (cvAssets.ts), served as /opencv/ for the whole run and
//   removed at the end, so the app's hooks deleting public/opencv/ can't affect a run. It is
//   re-checked before every photo. A cv run that didn't really use OpenCV (a cv stage `unavailable`
//   or `fallback` in the trace, no successful cv call, or a cvLoad too short to be real; checks.ts)
//   fails the harness (exit 1) and its file is not written.
// - `--dump-binary` also writes Tesseract's internal binarized image (what drives its layout and
//   line finding; the LSTM itself reads the grey pixels) to eval/receipts/<name>.<variant>.binary.png,
//   and `.binary-<n>.png` for a later read in the same scan. Harness only; the app never asks for it.
import { build, type Plugin } from 'esbuild';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { chromium, webkit, type Browser } from 'playwright';
import { usesCv, VARIANTS } from '../../lib/scanPipeline/config';
import { DEFAULT_EVAL_DIR, DEFAULT_PHOTOS_DIR, ROOT, err, listPhotos, ocrPath, out, parseArgs } from '../evalFiles';
import { cvRunProblem } from './checks';
import { buildHarnessCvAssets, harnessCvDir, missingCvAssets, removeStaleHarnessCvDirs } from './cvAssets';
import type { HarnessRequest, HarnessResponse, OcrHarnessFile } from './protocol';
import { HOST, isLocal, startHarnessServer, startProxyTrap } from './server';

const HERE = __dirname;
const PUBLIC_DIR = join(ROOT, 'public');
const DEFAULT_TIMEOUT_MS = 300_000;

/** Fails the bundle if anything outside the allowed web sources reaches React Native or expo-*. */
const rnFree: Plugin = {
  name: 'rn-free',
  setup(b) {
    b.onResolve({ filter: /^(react-native|expo)(\/|$)|^expo-/ }, (args) => {
      if (args.path === 'expo-modules-core') return { path: join(HERE, 'shims', 'expo-modules-core.ts') };
      if (/^expo-image-manipulator\/src\/web\//.test(args.path)) return undefined;
      return { errors: [{ text: `harness bundle must not import ${args.path} (from ${args.importer})` }] };
    });
  },
};

async function bundlePage(): Promise<string> {
  const result = await build({
    entryPoints: [join(HERE, 'page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    // Same value Metro inlines in a production web export.
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [rnFree],
    logLevel: 'silent',
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('esbuild produced no output');
  return file.text;
}

type Outcome = HarnessResponse;

/** Where a run is, for the failure message when it times out. */
type Phase = 'context' | 'load' | 'run';

async function readOnce(
  browser: Browser,
  origin: string,
  req: HarnessRequest,
  timeoutMs: number,
  violations: string[],
): Promise<Outcome> {
  let phase: Phase = 'context';
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let timer: NodeJS.Timeout | undefined;
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (isLocal(url, origin)) return route.continue();
      violations.push(url);
      return route.abort('blockedbyclient');
    });
    context.on('request', (r) => {
      if (!isLocal(r.url(), origin)) violations.push(r.url());
    });
    page.on('pageerror', (e) => err(`  page error: ${e.message}`));

    const work = (async (): Promise<Outcome> => {
      phase = 'load';
      await page.goto(`${origin}/`);
      await page.waitForFunction(() => 'run' in ((window as unknown as { __ocrHarness?: object }).__ocrHarness ?? {}));
      phase = 'run';
      return page.evaluate(
        (r) =>
          (window as unknown as { __ocrHarness: { run(x: HarnessRequest): Promise<HarnessResponse> } }).__ocrHarness.run(r),
        req,
      );
    })();
    work.catch(() => {});
    const timeout = new Promise<'timeout'>((ok) => {
      timer = setTimeout(() => ok('timeout'), timeoutMs);
    });
    const result = await Promise.race([work, timeout]);
    if (result !== 'timeout') return result;
    // Which pipeline step the page was in (page.ts keeps it), if the page still answers.
    const step = await Promise.race([
      page.evaluate(() => String((window as unknown as { __ocrHarnessStep?: string }).__ocrHarnessStep ?? 'none')),
      new Promise<string>((ok) => setTimeout(() => ok('no answer'), 5000)),
    ]).catch(() => 'no answer');
    return { ok: false, code: `timeout after ${timeoutMs} ms (phase ${phase}, step ${step})` };
  } catch (e) {
    return { ok: false, code: `harness error in phase ${phase}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` };
  } finally {
    clearTimeout(timer);
    // Closing the context ends the page, its Tesseract worker and anything still running.
    await context.close().catch(() => {});
  }
}

/** The output path, checked to be inside eval/receipts/. */
function outputPath(name: string, variant: string): string {
  const base = resolve(DEFAULT_EVAL_DIR);
  const target = resolve(ocrPath(base, name, variant));
  if (!target.startsWith(base + sep)) throw new Error(`refusing to write outside ${base}: ${target}`);
  return target;
}

const PNG_DATA_URL = 'data:image/png;base64,';

/**
 * Writes each read's binarized image as eval/receipts/<name>.<variant>.binary.png (then
 * `.binary-2.png`, …), inside eval/receipts/ only. Returns how many were written.
 */
function writeBinaries(name: string, variant: string, binaries: readonly string[]): number {
  let n = 0;
  binaries.forEach((dataUrl, i) => {
    if (!dataUrl.startsWith(PNG_DATA_URL)) return;
    const json = outputPath(name, variant);
    const target = json.replace(/\.ocr\.json$/, i === 0 ? '.binary.png' : `.binary-${i + 1}.png`);
    writeFileSync(target, Buffer.from(dataUrl.slice(PNG_DATA_URL.length), 'base64'));
    n += 1;
  });
  return n;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ['variants', 'only', 'browser', 'repeat', 'timeout-ms', 'photos'], ['dump-binary']);
  const dumpBinary = args.flags.has('dump-binary');
  const variants = args.values.get('variants') ?? [];
  if (variants.length === 0) {
    err('--variants <name,...> is required');
    return 2;
  }
  const webVariants = Object.keys(VARIANTS).filter((k) => VARIANTS[k]?.platform === 'web');
  const bad = variants.filter((v) => !webVariants.includes(v));
  if (bad.length > 0) {
    err(`Not a web variant: ${bad.join(', ')}. Web variants: ${webVariants.join(', ')}`);
    return 2;
  }
  const browserName = args.values.get('browser')?.[0] ?? 'chromium';
  if (browserName !== 'chromium' && browserName !== 'webkit') {
    err('--browser must be chromium or webkit');
    return 2;
  }
  const repeat = Number(args.values.get('repeat')?.[0] ?? '1');
  const timeoutMs = Number(args.values.get('timeout-ms')?.[0] ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(repeat) || repeat < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    err('--repeat must be an integer >= 1 and --timeout-ms a positive number');
    return 2;
  }
  if (!existsSync(join(PUBLIC_DIR, 'tesseract', 'worker.min.js'))) {
    err('public/tesseract/ is missing. Run: node scripts/copy-tesseract-assets.mjs');
    return 2;
  }

  // cv variants need opencv.js + the worker. The app flag is off, so the normal hooks don't build
  // them (and `npm run web` / `start` remove public/opencv/); build a private copy for this run.
  const needCv = variants.some((v) => usesCv(VARIANTS[v]!.config));
  const evalDir = resolve(DEFAULT_EVAL_DIR);
  const cvDir = needCv ? harnessCvDir(evalDir) : undefined;
  if (cvDir) {
    mkdirSync(evalDir, { recursive: true });
    removeStaleHarnessCvDirs(evalDir);
    buildHarnessCvAssets(ROOT, cvDir);
  }
  try {
    return await runAll({ args, variants, browserName, repeat, timeoutMs, dumpBinary, cvDir });
  } finally {
    if (cvDir) rmSync(cvDir, { recursive: true, force: true });
  }
}

async function runAll(o: {
  args: ReturnType<typeof parseArgs>;
  variants: string[];
  browserName: 'chromium' | 'webkit';
  repeat: number;
  timeoutMs: number;
  dumpBinary: boolean;
  cvDir: string | undefined;
}): Promise<number> {
  const { args, variants, browserName, repeat, timeoutMs, dumpBinary, cvDir } = o;
  const photosDir = resolve(args.values.get('photos')?.[0] ?? DEFAULT_PHOTOS_DIR);
  let photos = listPhotos(photosDir);
  const only = args.values.get('only');
  if (only) {
    const want = new Set(only);
    const unknown = only.filter((n) => !photos.some((p) => p.name === n || p.file === n));
    if (unknown.length > 0) {
      err(`Not a photo in ${photosDir}: ${unknown.join(', ')}. Names: ${photos.map((p) => p.name).join(', ')}`);
      return 2;
    }
    photos = photos.filter((p) => want.has(p.name) || want.has(p.file));
  }
  if (photos.length === 0) {
    out(`No photos in ${photosDir}. Add JPEG, PNG or WebP receipt photos there.`);
    return 0;
  }

  const bundle = await bundlePage();
  const server = await startHarnessServer({
    publicDir: PUBLIC_DIR,
    photosDir,
    photos: photos.map((p) => p.file),
    bundle,
    ...(cvDir ? { opencvDir: cvDir } : {}),
  });
  const trap = await startProxyTrap();
  const violations: string[] = [];
  let failed = false;
  let browser: Browser | undefined;
  try {
    // Everything that isn't loopback goes to the trap, which refuses it.
    browser = await (browserName === 'webkit' ? webkit : chromium).launch({
      proxy: { server: trap.server, bypass: `${HOST},localhost` },
    });
    const browserLabel = `${browserName} ${browser.version()}`;
    out(`ocr-harness: ${browserLabel}, ${photos.length} photo(s) × ${variants.join(', ')}, repeat ${repeat}`);
    for (const variant of variants) {
      for (const { file, name } of photos) {
        if (/\.hei[cf]$/i.test(file) && browserName === 'chromium') {
          out(`${name}: skipped, HEIC can't be decoded in Chromium (export it as JPEG)`);
          continue;
        }
        const cvVariant = usesCv(VARIANTS[variant]!.config);
        if (cvVariant && cvDir) {
          const missing = missingCvAssets(cvDir);
          if (missing.length > 0) {
            err(`${name} [${variant}]: OpenCV files missing from ${cvDir} (${missing.join(', ')}); nothing written`);
            failed = true;
            continue;
          }
        }
        const req: HarnessRequest = { photoUrl: `/photos/${encodeURIComponent(file)}`, photo: `receipts/${file}`, variant, dumpBinary };
        const before = violations.length + trap.hits.length;
        const runs: Outcome[] = [];
        for (let i = 0; i < repeat; i++) runs.push(await readOnce(browser, server.origin, req, timeoutMs, violations));
        if (violations.length + trap.hits.length > before) {
          err(`${name} [${variant}]: blocked a request to another host; nothing written`);
          failed = true;
          continue;
        }
        runs.forEach((r, i) => {
          if (!r.ok) err(`${name} [${variant}] run ${i + 1}: failed (${r.code})`);
        });
        // Any failed run fails the harness; the first successful run is still written.
        if (runs.some((r) => !r.ok)) failed = true;
        // A cv variant that didn't really use OpenCV would be web-current under a cv label: refuse it.
        const noCv = runs.flatMap((r, i) => {
          const why = r.ok ? cvRunProblem(cvVariant, r.file) : null;
          return why ? [`run ${i + 1}: ${why}`] : [];
        });
        if (noCv.length > 0) {
          noCv.forEach((m) => err(`${name} [${variant}] ${m}; nothing written`));
          failed = true;
          continue;
        }
        const first = runs.find((r): r is Extract<Outcome, { ok: true }> => r.ok);
        if (!first) continue;
        const linesJson = JSON.stringify(first.file.lines);
        const okRuns = runs.filter((r): r is Extract<Outcome, { ok: true }> => r.ok);
        const same = okRuns.every((r) => JSON.stringify(r.file.lines) === linesJson);
        const failedRuns = runs.length - okRuns.length;
        const target = outputPath(name, variant);
        mkdirSync(resolve(DEFAULT_EVAL_DIR), { recursive: true });
        const record: OcrHarnessFile = { ...first.file, meta: { ...first.file.meta, browser: browserLabel } };
        writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
        const pngs = writeBinaries(name, variant, first.binaries ?? []);
        const totals = runs.map((r) => (r.ok ? `${r.file.meta.timingsMs.total}` : 'failed')).join('/');
        const prep = first.file.prepared.map((p) => `${p.width}×${p.height}`).join(', ');
        out(
          `${name} [${variant}]: ${first.file.lines.length} lines, ${first.file.source.width}×${first.file.source.height} → ${prep}, ` +
            `${totals} ms${pngs > 0 ? `, ${pngs} binary png` : ''}${repeat > 1 ? `, repeat: ${okRuns.length} ok runs ${same ? 'identical' : 'DIFFERENT'}${failedRuns ? `, ${failedRuns} failed` : ''}` : ''}`,
        );
        if (!same) failed = true;
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
    await trap.close();
  }
  const blocked = [...new Set([...violations, ...trap.hits])];
  if (blocked.length > 0) {
    err(`Privacy guard: ${blocked.length} request(s) to a host other than ${HOST} were blocked:`);
    blocked.slice(0, 20).forEach((u) => err(`  ${u}`));
    return 1;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
