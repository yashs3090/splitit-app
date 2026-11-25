// File helpers shared by scripts/eval-receipts.ts and scripts/eval-init.ts (spec:
// docs/specs/2026-11-22-web-opencv-preprocessing.md, C1 / Task 1). The scoring itself is pure and
// lives in lib/receiptEval.ts, the answer-file format in lib/receiptAnswers.ts. These scripts only
// read `receipts/`, write answer drafts into `receipts/answers/` and read/write `eval/receipts/`,
// all gitignored; photos are never copied.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { answerBaseName, answerToExpected, parseAnswer, resolveSet, validateSetsFile, type Answer, type SetEntry, type SetsFile } from '../lib/receiptAnswers';
import { photoNames, validateExpected, type ExpectedReceipt, type Skipped } from '../lib/receiptEval';

export const ROOT = resolve(__dirname, '..');
export const DEFAULT_PHOTOS_DIR = join(ROOT, 'receipts');
export const DEFAULT_EVAL_DIR = join(ROOT, 'eval', 'receipts');
export const DEFAULT_ANSWERS_DIR = join(ROOT, 'receipts', 'answers');
export const DEFAULT_VARIANT = 'web-current';

const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

/** Photos in `dir` (top level only) with their eval names. Empty if the folder doesn't exist. */
export function listPhotos(dir: string): { file: string; name: string }[] {
  if (!existsSync(dir)) return [];
  return photoNames(readdirSync(dir).filter((f) => PHOTO_EXT.test(f)));
}

export const expectedPath = (evalDir: string, name: string) => join(evalDir, `${name}.expected.json`);
export const ocrPath = (evalDir: string, name: string, variant: string) => join(evalDir, `${name}.${variant}.ocr.json`);

const OCR_FILE = /\.([^.]+)\.ocr\.json$/;

/** The variants that have at least one `<name>.<variant>.ocr.json` in `evalDir`, sorted. Empty if the folder doesn't exist. */
export function ocrVariants(evalDir: string): string[] {
  if (!existsSync(evalDir)) return [];
  const found = new Set<string>();
  for (const f of readdirSync(evalDir)) {
    const m = OCR_FILE.exec(f);
    if (m?.[1]) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * An error naming each requested variant that has no ocr.json at all in `evalDir` (usually a typo,
 * or the harness wasn't run for it), with the variants that do have files; null when all have some.
 */
export function missingVariantsError(evalDir: string, wanted: readonly string[]): string | null {
  const have = ocrVariants(evalDir);
  const missing = [...new Set(wanted)].filter((v) => !have.includes(v));
  if (missing.length === 0) return null;
  const which = missing.length === 1 ? `variant ${missing[0]}` : `variants ${missing.join(', ')}`;
  const list = have.length > 0 ? `Variants with ocr.json files: ${have.join(', ')}.` : 'No variant has ocr.json files there yet.';
  return `No ocr.json files for ${which} in ${show(evalDir)}. ${list} Check the name, or run: npm run ocr:harness -- --variants ${missing.join(',')}`;
}

export const answerPath = (answersDir: string, photoFile: string) => join(answersDir, `${answerBaseName(photoFile)}.txt`);
export const setsPath = (evalDir: string) => join(evalDir, 'sets.json');

/** A path for messages: relative to the repo when inside it. */
export function show(p: string): string {
  const r = relative(ROOT, p);
  return r.startsWith('..') || isAbsolute(r) ? p : r;
}

/** The recorded sets (empty if the file doesn't exist yet), or the errors in it. */
export function readSets(evalDir: string): { ok: true; value: SetsFile } | { ok: false; errors: string[] } {
  const file = setsPath(evalDir);
  if (!existsSync(file)) return { ok: true, value: { version: 1, sets: {} } };
  const raw = readJson(file);
  if (!raw.ok) return { ok: false, errors: [raw.error] };
  return validateSetsFile(raw.value, show(file));
}

/** An old-format expected.json's body and set, if the file exists. */
export function readLegacy(evalDir: string, name: string): { expected: ExpectedReceipt } | { errors: string[] } | null {
  const file = expectedPath(evalDir, name);
  if (!existsSync(file)) return null;
  const raw = readJson(file);
  const v = raw.ok ? validateExpected(raw.value, show(file)) : { ok: false as const, errors: [raw.error] };
  return v.ok ? { expected: v.value } : { errors: v.errors };
}

export type Truth = {
  /** Eval name (slug of the photo name): the key for ocr.json files and the set record. */
  name: string;
  photoFile: string | null;
  /** The answer file, or the old expected.json it falls back to. */
  file: string;
  source: 'answer' | 'expected-json' | 'none';
  state: 'checked' | 'draft' | 'missing' | 'invalid';
  errors: string[];
  set: SetEntry;
  /**
   * The set is on record: in eval/receipts/sets.json, or in the old expected.json it came from.
   * False when it is only the hash / "used before split" guess, which could still change before
   * `npm run answers:draft` records it (R7), so the eval doesn't score it.
   */
  setRecorded: boolean;
  answer: Answer | null;
  expected: ExpectedReceipt | null;
};

/**
 * Ground truth for every photo: `receipts/answers/<photo base>.txt` when it exists, else an old
 * `eval/receipts/<name>.expected.json` (kept only as a fallback, so nothing is lost), else missing.
 * Old expected.json files with no photo are still loaded, as before. `orphans` are answer files
 * with no photo. `fatal` is set when the set record itself can't be read.
 */
export function loadGroundTruth(dirs: { photosDir: string; answersDir: string; evalDir: string }): {
  truths: Truth[];
  orphans: string[];
  fatal: string[];
} {
  const { photosDir, answersDir, evalDir } = dirs;
  const sets = readSets(evalDir);
  if (!sets.ok) return { truths: [], orphans: [], fatal: sets.errors };
  const recorded = sets.value.sets;
  const photos = listPhotos(photosDir);
  const byBase = new Map<string, string[]>();
  for (const p of photos) byBase.set(answerBaseName(p.file), [...(byBase.get(answerBaseName(p.file)) ?? []), p.file]);

  const setFor = (name: string, legacy: ExpectedReceipt | null): SetEntry =>
    resolveSet(name, {
      recorded: recorded[name],
      legacy: legacy ? { set: legacy.set, setReason: legacy.setReason } : undefined,
      forceTuning: existsSync(join(evalDir, `${name}.jpg`)),
    });

  const truths: Truth[] = [];
  for (const { file: photoFile, name } of photos) {
    const target = answerPath(answersDir, photoFile);
    const legacyRead = readLegacy(evalDir, name);
    const legacy = legacyRead && 'expected' in legacyRead ? legacyRead.expected : null;
    const set = setFor(name, legacy);
    const setRecorded = recorded[name] !== undefined || legacy !== null;
    const base = { name, photoFile, set, setRecorded, answer: null, expected: null };
    const twins = byBase.get(answerBaseName(photoFile)) ?? [];
    if (twins.length > 1) {
      truths.push({ ...base, file: show(target), source: 'none', state: 'invalid', errors: [`${twins.join(' and ')} would share the answer file ${show(target)}; rename one photo`] });
    } else if (existsSync(target)) {
      const r = parseAnswer(readFileSync(target, 'utf8'), show(target));
      if (!r.ok) truths.push({ ...base, file: show(target), source: 'answer', state: 'invalid', errors: r.errors });
      else {
        // Labelled with the folder the photo was read from (--photos), not a fixed receipts/ (R11).
        const expected = answerToExpected(r.value, { ...set, photo: show(join(photosDir, photoFile)) });
        truths.push({ ...base, file: show(target), source: 'answer', state: r.value.checked ? 'checked' : 'draft', errors: [], answer: r.value, expected });
      }
    } else if (legacyRead) {
      truths.push(legacyTruth(name, photoFile, legacyRead, set, setRecorded, evalDir));
    } else {
      truths.push({ ...base, file: show(target), source: 'none', state: 'missing', errors: [] });
    }
  }

  // Old expected.json files with no photo (the eval scored these before answer files existed).
  const photoNamesSet = new Set(photos.map((p) => p.name));
  if (existsSync(evalDir)) {
    for (const f of readdirSync(evalDir).filter((x) => x.endsWith('.expected.json')).sort()) {
      const name = f.slice(0, -'.expected.json'.length);
      if (photoNamesSet.has(name)) continue;
      const legacyRead = readLegacy(evalDir, name);
      if (!legacyRead) continue;
      const legacy = 'expected' in legacyRead ? legacyRead.expected : null;
      truths.push(legacyTruth(name, null, legacyRead, setFor(name, legacy), recorded[name] !== undefined || legacy !== null, evalDir));
    }
  }

  const orphans = existsSync(answersDir)
    ? readdirSync(answersDir)
        .filter((f) => f.endsWith('.txt') && !byBase.has(f.slice(0, -'.txt'.length)))
        .sort()
        .map((f) => show(join(answersDir, f)))
    : [];
  return { truths, orphans, fatal: [] };
}

function legacyTruth(
  name: string,
  photoFile: string | null,
  read: { expected: ExpectedReceipt } | { errors: string[] },
  set: SetEntry,
  setRecorded: boolean,
  evalDir: string,
): Truth {
  const file = show(expectedPath(evalDir, name));
  if ('errors' in read) return { name, photoFile, file, source: 'expected-json', state: 'invalid', errors: read.errors, set, setRecorded, answer: null, expected: null };
  const expected = { ...read.expected, set: set.set, setReason: set.setReason };
  return { name, photoFile, file, source: 'expected-json', state: expected.status === 'checked' ? 'checked' : 'draft', errors: [], set, setRecorded, answer: null, expected };
}

export type Scorable = { name: string; expected: ExpectedReceipt };

/**
 * Which ground truths the eval scores, and what it prints about the rest. `only` matches the eval
 * name, the photo file or the answer file's name.
 * - Invalid answer files fail the run. A held-out one prints only its file name until `--confirm`
 *   (R6): its errors quote the file's lines, which would show held-out answers early.
 * - A checked answer whose set isn't on record is skipped, not scored (R7): scoring it under a
 *   guessed set could later count it in the other set. `npm run answers:draft` records it.
 */
export function selectScorable(
  truths: readonly Truth[],
  only: ReadonlySet<string> | null,
  opts: { confirm: boolean },
): { checked: Scorable[]; skipped: Skipped[]; errors: string[]; failed: boolean } {
  const checked: Scorable[] = [];
  const skipped: Skipped[] = [];
  const errors: string[] = [];
  let failed = false;
  const picked = truths.filter(
    (t) => only === null || only.has(t.name) || (t.photoFile !== null && (only.has(t.photoFile) || only.has(answerBaseName(t.photoFile)))),
  );
  for (const t of picked) {
    if (t.state === 'invalid') {
      failed = true;
      if (t.set.set === 'heldout' && !opts.confirm) {
        errors.push(`${t.file}: invalid answer file (held-out: details hidden until --confirm; npm run answers:check shows them)`);
      } else errors.push(...t.errors);
      skipped.push({ name: t.name, why: `invalid answer file ${t.file}, not scored (see errors above)` });
    } else if (t.state === 'missing') {
      skipped.push({ name: t.name, why: 'no answer file yet (npm run answers:draft), skipped' });
    } else if (t.state === 'draft' || t.expected === null) {
      skipped.push({ name: t.name, why: 'draft (checked: no), skipped' });
    } else if (!t.setRecorded) {
      skipped.push({ name: t.name, why: 'set not recorded yet; run npm run answers:draft to record it, skipped' });
    } else {
      checked.push({ name: t.name, expected: t.expected });
    }
  }
  return { checked, skipped, errors, failed };
}

/** Parsed JSON, or an error naming the file. */
export function readJson(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch (e) {
    return { ok: false, error: `${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type Args = { flags: Set<string>; values: Map<string, string[]> };

/** `--name value` (repeatable, comma lists split) and bare `--flag`s from the known lists. */
export function parseArgs(argv: string[], valued: string[], bare: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const key = a.replace(/^--/, '');
    if (bare.includes(key)) {
      flags.add(key);
    } else if (valued.includes(key)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      values.set(key, [...(values.get(key) ?? []), ...v.split(',').map((s) => s.trim()).filter(Boolean)]);
    } else {
      throw new Error(`unknown option ${a} (known: ${[...valued, ...bare].map((k) => `--${k}`).join(', ')})`);
    }
  }
  return { flags, values };
}

export const out = (s: string) => process.stdout.write(`${s}\n`);
export const err = (s: string) => process.stderr.write(`${s}\n`);
