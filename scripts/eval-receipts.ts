// Receipt parser eval (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C1 / Task 1).
//
//   npm run eval -- [--variant <v>] [--only <name,...>] [--confirm]
//   npm run eval -- --compare <baseline>,<candidate> [--core] [--strict] [--confirm]
//   npm run eval -- --flow <primary>,<retry> [--confirm]
//
// Scores `eval/receipts/<name>.<variant>.ocr.json` (default variant web-current) against each
// answer file `receipts/answers/<photo name>.txt` marked "checked: yes" (format:
// lib/receiptAnswers.ts; an old `<name>.expected.json` is used only when a photo has no .txt).
// The tuning / held-out set comes from eval/receipts/sets.json, else the name's hash. Drafts and
// photos with no answer are listed and skipped, and so is a checked answer whose set isn't recorded
// yet (`npm run answers:draft` records it). An invalid held-out answer file prints only its name
// until --confirm. Tuning and held-out are reported
// separately; held-out numbers print only with --confirm (run it once, after choosing on tuning).
// --compare applies `decide` (or `decideCore` with --core). Below the 12 / 8 receipt minimum the
// decision is printed as PROVISIONAL (Amendment A1); --strict gives NO DECISION instead.
// --flow replays the pipeline's retry rule (assessQuality + pickBetter) over two saved variants.
// Read-only: prints to the terminal and writes no files.
import { existsSync } from 'node:fs';
import {
  decide,
  decideCore,
  formatEvalReport,
  scoreReceipt,
  simulateFlow,
  validateOcrFile,
  type ReceiptScore,
  type Skipped,
} from '../lib/receiptEval';
import { parseReceipt } from '../lib/receiptText';
import type { RecognizedText } from '../lib/receiptTypes';
import {
  DEFAULT_ANSWERS_DIR,
  DEFAULT_EVAL_DIR,
  DEFAULT_PHOTOS_DIR,
  DEFAULT_VARIANT,
  err,
  loadGroundTruth,
  missingVariantsError,
  ocrPath,
  out,
  parseArgs,
  readJson,
  selectScorable,
  type Scorable,
} from './evalFiles';

type Checked = Scorable;

let failed = false;

function loadExpected(dirs: { photosDir: string; answersDir: string; evalDir: string }, only: Set<string> | null, confirm: boolean): { checked: Checked[]; skipped: Skipped[] } {
  const { truths, fatal } = loadGroundTruth(dirs);
  if (fatal.length > 0) {
    fatal.forEach(err);
    throw new Error('the set record is unreadable; nothing scored');
  }
  const r = selectScorable(truths, only, { confirm });
  r.errors.forEach(err);
  if (r.failed) failed = true;
  return { checked: r.checked, skipped: r.skipped };
}

function loadText(evalDir: string, name: string, variant: string): RecognizedText | 'missing' | 'invalid' {
  const file = ocrPath(evalDir, name, variant);
  if (!existsSync(file)) return 'missing';
  const raw = readJson(file);
  const v = raw.ok ? validateOcrFile(raw.value, file) : { ok: false as const, errors: [raw.error] };
  if (!v.ok) {
    v.errors.forEach(err);
    failed = true;
    return 'invalid';
  }
  return { lines: v.value.lines };
}

function scoreVariant(evalDir: string, checked: Checked[], variant: string): { scores: ReceiptScore[]; skipped: Skipped[] } {
  const scores: ReceiptScore[] = [];
  const skipped: Skipped[] = [];
  for (const { name, expected } of checked) {
    const text = loadText(evalDir, name, variant);
    if (text === 'missing') skipped.push({ name, why: `no ${variant} ocr.json, skipped` });
    else if (text === 'invalid') skipped.push({ name, why: `invalid ${variant} ocr.json, skipped` });
    else scores.push(scoreReceipt(name, expected, parseReceipt(text)));
  }
  return { scores, skipped };
}

function pair(values: string[] | undefined, flag: string): [string, string] {
  if (values?.length !== 2 || !values[0] || !values[1]) throw new Error(`${flag} needs two variants, like ${flag} a,b`);
  return [values[0], values[1]];
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), ['variant', 'compare', 'flow', 'only', 'dir', 'photos', 'answers'], ['confirm', 'core', 'strict']);
  const evalDir = args.values.get('dir')?.[0] ?? DEFAULT_EVAL_DIR;
  const photosDir = args.values.get('photos')?.[0] ?? DEFAULT_PHOTOS_DIR;
  const answersDir = args.values.get('answers')?.[0] ?? DEFAULT_ANSWERS_DIR;
  const confirm = args.flags.has('confirm');
  const onlyList = args.values.get('only');
  const only = onlyList ? new Set(onlyList) : null;

  // A variant with no ocr.json at all is a typo or a harness run that never happened: say so and
  // fail, instead of skipping every receipt and reporting "No checked receipts" with exit 0.
  const wanted = args.values.has('flow')
    ? pair(args.values.get('flow'), '--flow')
    : args.values.has('compare')
      ? pair(args.values.get('compare'), '--compare')
      : [args.values.get('variant')?.[0] ?? DEFAULT_VARIANT];
  const missing = missingVariantsError(evalDir, wanted);
  if (missing) {
    err(missing);
    return 2;
  }

  const { checked, skipped: draftSkips } = loadExpected({ photosDir, answersDir, evalDir }, only, confirm);
  if (checked.length === 0) {
    out(formatEvalReport({ variant: args.values.get('variant')?.[0] ?? DEFAULT_VARIANT, scores: [], skipped: draftSkips, confirm }));
    return failed ? 1 : 0;
  }

  if (args.values.has('flow')) {
    const [primary, retry] = pair(args.values.get('flow'), '--flow');
    const scores: ReceiptScore[] = [];
    const skipped = [...draftSkips];
    const counts = { tuning: { retried: 0, retryChosen: 0 }, heldout: { retried: 0, retryChosen: 0 } };
    for (const { name, expected } of checked) {
      const p = loadText(evalDir, name, primary);
      if (typeof p === 'string') {
        skipped.push({ name, why: `${p} ${primary} ocr.json, skipped` });
        continue;
      }
      const r = loadText(evalDir, name, retry);
      const flow = simulateFlow(p, typeof r === 'string' ? null : r);
      // A held-out receipt's result stays hidden without --confirm.
      const visible = confirm || expected.set === 'tuning';
      if (visible && !flow.verdict.ok && !flow.retried && typeof r === 'string') skipped.push({ name, why: `primary failed but ${r} ${retry} ocr.json; primary kept` });
      if (flow.retried) counts[expected.set].retried++;
      if (flow.chosen === 'retry') counts[expected.set].retryChosen++;
      scores.push(scoreReceipt(name, expected, flow.parsed));
    }
    out(formatEvalReport({ variant: `flow ${primary} -> ${retry}`, scores, skipped, confirm }));
    out(`Tuning: retried ${counts.tuning.retried}, retry chosen ${counts.tuning.retryChosen}`);
    if (confirm) out(`Held-out: retried ${counts.heldout.retried}, retry chosen ${counts.heldout.retryChosen}`);
    return failed ? 1 : 0;
  }

  if (args.values.has('compare')) {
    const [a, b] = pair(args.values.get('compare'), '--compare');
    const base = scoreVariant(evalDir, checked, a);
    const cand = scoreVariant(evalDir, checked, b);
    out(formatEvalReport({ variant: `${a} (baseline)`, scores: base.scores, skipped: [...draftSkips, ...base.skipped], confirm }));
    out('');
    out(formatEvalReport({ variant: `${b} (candidate)`, scores: cand.scores, skipped: cand.skipped, confirm }));
    out('');
    // Decide only over receipts both variants read, and say which were left out.
    const inBoth = new Set(base.scores.map((s) => s.name).filter((n) => cand.scores.some((s) => s.name === n)));
    const left = checked.map((c) => c.name).filter((n) => !inBoth.has(n));
    if (left.length > 0) out(`Left out of the decision (not read by both variants): ${left.join(', ')}`);
    const opts = { confirm, allowBelowMinimum: !args.flags.has('strict') };
    const rule = args.flags.has('core') ? decideCore : decide;
    const d = rule(
      base.scores.filter((s) => inBoth.has(s.name)),
      cand.scores.filter((s) => inBoth.has(s.name)),
      opts,
    );
    const tag = d.provisional ? ' (PROVISIONAL: below the 12 tuning / 8 held-out minimum; the held-out set is small)' : '';
    out(`${args.flags.has('core') ? 'decideCore' : 'decide'}: ${d.verdict.replace('_', ' ')}${tag}: ${d.reason}`);
    if (d.failed.length > 1) out(`  failing clauses: ${d.failed.join(', ')}`);
    return failed ? 1 : 0;
  }

  const variant = args.values.get('variant')?.[0] ?? DEFAULT_VARIANT;
  const r = scoreVariant(evalDir, checked, variant);
  out(formatEvalReport({ variant, scores: r.scores, skipped: [...draftSkips, ...r.skipped], confirm }));
  return failed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
