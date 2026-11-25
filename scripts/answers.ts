// `npm run answers:draft` and `npm run answers:check`: the plain-text answer files the receipt
// eval scores against (receipts/answers/<photo name without extension>.txt; format in
// lib/receiptAnswers.ts, how-to in docs/setup/receipt-answers.md). The CLI is scripts/answers-cli.ts;
// these functions take their folders as arguments so tests can run them on temp folders.
//
// draft: for every photo in receipts/ with no answer file, writes a draft with "checked: no":
//   - moved from an old eval/receipts/<name>.expected.json if there is one (values and checked kept),
//   - else pre-filled from the app parser's read of <name>.<variant>.ocr.json (default web-current),
//   - else, with --blank, an empty draft to type by hand.
//   Never overwrites an answer file unless named with --force (the old file is kept as .bak first).
//   Records each photo's tuning / held-out set once in eval/receipts/sets.json; never changes one.
// check: validates every answer file and lists checked / draft / missing / errors. No OCR, no writes.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerBaseName, answerFromExpected, answerFromParse, answerTotalsCheck, formatAnswer, resolveSet, type Answer, type SetEntry } from '../lib/receiptAnswers';
import { validateOcrFile } from '../lib/receiptEval';
import { parseReceipt } from '../lib/receiptText';
import { formatCentsInput } from '../lib/money';
import { answerPath, expectedPath, listPhotos, loadGroundTruth, ocrPath, readJson, readLegacy, readSets, setsPath, show } from './evalFiles';

export type Dirs = { photosDir: string; answersDir: string; evalDir: string };
export type Log = (line: string) => void;

const HOW_TO = 'docs/setup/receipt-answers.md';

/** `photo`: the photo's path as shown to the user (the --photos folder it was read from; R11). */
function draftHeader(photo: string, source: string, notes: string[]): string[] {
  return [
    `# Answer for photo: ${photo}`,
    `# ${source}`,
    '# Fix it with the photo open, then change the last line to "checked: yes".',
    `# How-to: ${HOW_TO}`,
    '#',
    '# Items: quantity, name, line price (what the whole line costs, 2 decimals, $ optional):',
    '#   2  Fish Tacos  25.00',
    '# subtotal / tax / tip / fees / total: the amount, or - if the receipt does not print it.',
    '#   fees = service charges. Several tax lines? Write one "tax" line for each; they add up.',
    '# discount 2.00                  = taken off the total (subtotal + tax + tip + fees - discount = total)',
    '# discount before subtotal 2.00  = taken off the items (items - discount = subtotal)',
    '# Add, fix or delete lines freely. Lines starting with # are ignored.',
    ...notes.map((n) => `# Note: ${n}`),
  ];
}

export type DraftOptions = Dirs & { variant: string; force: string[]; usedBeforeSplit: string[]; blank: boolean; now?: () => Date };

/** Returns the exit code. */
export function runDraft(o: DraftOptions, log: Log, logErr: Log): number {
  const photos = listPhotos(o.photosDir);
  if (photos.length === 0) {
    log(`No photos in ${show(o.photosDir)}. Add JPEG, PNG or WebP receipt photos there.`);
    return 0;
  }
  const sets = readSets(o.evalDir);
  if (!sets.ok) {
    sets.errors.forEach(logErr);
    logErr(`Fix ${show(setsPath(o.evalDir))} first; it records which receipts are held out.`);
    return 1;
  }
  const recorded: Record<string, SetEntry> = { ...sets.value.sets };

  // --force / --used-before-split accept the eval name, the photo file or the answer name.
  const lookup = new Map<string, string>();
  for (const p of photos) [p.name, p.file, answerBaseName(p.file), `${answerBaseName(p.file)}.txt`].forEach((k) => lookup.set(k, p.name));
  const unknown = [...o.force, ...o.usedBeforeSplit].filter((n) => !lookup.has(n));
  if (unknown.length > 0) {
    logErr(`Not a photo in ${show(o.photosDir)}: ${unknown.join(', ')}. Photos: ${photos.map((p) => p.file).join(', ')}`);
    return 1;
  }
  const force = new Set(o.force.map((n) => lookup.get(n)));
  const usedBefore = new Set(o.usedBeforeSplit.map((n) => lookup.get(n)));

  let failed = false;
  let written = 0;
  let setsChanged = false;
  for (const { file, name } of photos) {
    const target = answerPath(o.answersDir, file);
    const shown = show(target);
    const legacyRead = readLegacy(o.evalDir, name);
    const legacy = legacyRead && 'expected' in legacyRead ? legacyRead.expected : null;

    // The set: recorded once, never changed.
    const forceTuning = usedBefore.has(name) || existsSync(join(o.evalDir, `${name}.jpg`));
    const prev = recorded[name];
    if (prev && usedBefore.has(name) && prev.set !== 'tuning') {
      logErr(`${file}: --used-before-split, but its set is already recorded as ${prev.set} (${prev.setReason}); sets are never changed by the tools`);
      failed = true;
      continue;
    }
    if (!prev) {
      recorded[name] = resolveSet(name, { legacy: legacy ? { set: legacy.set, setReason: legacy.setReason } : undefined, forceTuning });
      setsChanged = true;
    }
    const set = recorded[name] ?? resolveSet(name, { forceTuning });

    const exists = existsSync(target);
    if (exists && !force.has(name)) {
      log(`${shown}: already there, unchanged`);
      continue;
    }

    let answer: Answer;
    let source: string;
    let notes: string[] = [];
    if (!exists && legacyRead) {
      // Migration: an old expected.json is moved over as it is, so nothing typed into it is lost.
      if ('errors' in legacyRead) {
        legacyRead.errors.forEach(logErr);
        logErr(`${file}: not moving ${show(expectedPath(o.evalDir, name))} because it is invalid; fix it, or use --force ${file} to start from the app's read`);
        failed = true;
        continue;
      }
      answer = answerFromExpected(legacyRead.expected);
      source = `Moved from ${show(expectedPath(o.evalDir, name))} (pre-filled earlier from the app's read${answer.checked ? '; it was checked, so checked: yes is kept' : '; never checked'}).`;
    } else {
      const ocrFile = ocrPath(o.evalDir, name, o.variant);
      if (existsSync(ocrFile)) {
        const raw = readJson(ocrFile);
        const ocr = raw.ok ? validateOcrFile(raw.value, show(ocrFile)) : { ok: false as const, errors: [raw.error] };
        if (!ocr.ok) {
          ocr.errors.forEach(logErr);
          failed = true;
          continue;
        }
        ({ answer, notes } = answerFromParse(parseReceipt({ lines: ocr.value.lines })));
        source = `Pre-filled from the app's read of the photo (${o.variant}). Expect mistakes.`;
      } else if (o.blank) {
        ({ answer } = answerFromParse(null));
        source = 'Blank: type the receipt in by hand.';
      } else {
        log(`${file}: no ${o.variant} read yet; run "npm run ocr:harness -- --variants ${o.variant}" first, or use --blank to type it by hand`);
        continue;
      }
    }

    mkdirSync(o.answersDir, { recursive: true });
    if (exists) {
      const stamp = (o.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
      const backup = `${target}.${stamp}.bak`;
      copyFileSync(target, backup);
      log(`${shown}: kept the old file as ${show(backup)}`);
    }
    // 'wx' refuses to replace a file that appeared since the check above.
    writeFileSync(target, formatAnswer(answer, { header: draftHeader(show(join(o.photosDir, file)), source, notes) }), { flag: exists ? 'w' : 'wx' });
    written++;
    log(`${shown}: wrote ${answer.checked ? 'answer (checked: yes kept)' : 'draft'} with ${answer.items.length} items (${set.set})`);
  }

  if (setsChanged) {
    mkdirSync(o.evalDir, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    writeFileSync(setsPath(o.evalDir), `${JSON.stringify({ version: 1, sets: sorted }, null, 2)}\n`);
  }
  log(`${written} file(s) written to ${show(o.answersDir)}. Fix each against its photo, set "checked: yes", then run npm run answers:check.`);
  return failed ? 1 : 0;
}

const money = (c: number | null) => (c === null ? '-' : formatCentsInput(c));

/** Returns the exit code: 1 if any answer file has errors. */
export function runCheck(o: Dirs, log: Log, logErr: Log): number {
  const { truths, orphans, fatal } = loadGroundTruth(o);
  if (fatal.length > 0) {
    fatal.forEach(logErr);
    return 1;
  }
  if (truths.length === 0 && orphans.length === 0) {
    log(`No photos in ${show(o.photosDir)}. Add receipt photos there first.`);
    return 0;
  }
  const count = (s: string) => truths.filter((t) => t.state === s).length;
  log(`Answers in ${show(o.answersDir)}: ${count('checked')} checked, ${count('draft')} draft, ${count('missing')} missing, ${count('invalid')} with errors`);
  for (const t of truths) {
    const label = { checked: 'CHECKED', draft: 'draft  ', missing: 'MISSING', invalid: 'ERROR  ' }[t.state];
    const what = t.photoFile ? `receipts/${t.photoFile}` : `${t.name} (no photo)`;
    if (t.state === 'missing') {
      log(`  ${label}  ${what}: no answer file; run npm run answers:draft`);
      continue;
    }
    if (t.state === 'invalid') {
      log(`  ${label}  ${t.file}`);
      t.errors.forEach((e) => log(`      ${e}`));
      continue;
    }
    const e = t.expected;
    const detail = e ? `${e.items.length} items, total ${money(e.totalCents)}` : '';
    const old = t.source === 'expected-json' ? ' (old format; npm run answers:draft moves it to a .txt)' : '';
    log(`  ${label}  ${t.file}${old}: ${t.set.set}, ${detail}`);
    if (t.answer) {
      const totals = answerTotalsCheck(t.answer);
      if (totals.addsUp) log('      adds up');
      else totals.problems.forEach((p) => log(`      doesn't add up: ${p}`));
    }
  }
  for (const f of orphans) log(`  ?        ${f}: no photo with this name in ${show(o.photosDir)}, so it isn't scored`);
  const invalid = count('invalid');
  if (invalid > 0) logErr(`${invalid} answer file(s) have errors (above).`);
  else if (count('checked') > 0) log('Next: npm run eval');
  return invalid > 0 ? 1 : 0;
}
