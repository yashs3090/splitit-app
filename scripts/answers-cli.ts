// CLI for the receipt answer files (logic and docs in scripts/answers.ts).
//
//   npm run answers:draft -- [--from <variant>] [--force <photo>] [--used-before-split <photo,...>] [--blank]
//   npm run answers:check
//
// Both also take --photos <dir>, --answers <dir> and --dir <eval dir> (defaults: receipts/,
// receipts/answers/, eval/receipts/).
import { DEFAULT_ANSWERS_DIR, DEFAULT_EVAL_DIR, DEFAULT_PHOTOS_DIR, DEFAULT_VARIANT, err, out, parseArgs } from './evalFiles';
import { runCheck, runDraft } from './answers';

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  const dirs = ['photos', 'answers', 'dir'];
  if (command === 'draft') {
    const a = parseArgs(rest, [...dirs, 'from', 'force', 'used-before-split'], ['blank']);
    return runDraft(
      {
        photosDir: a.values.get('photos')?.[0] ?? DEFAULT_PHOTOS_DIR,
        answersDir: a.values.get('answers')?.[0] ?? DEFAULT_ANSWERS_DIR,
        evalDir: a.values.get('dir')?.[0] ?? DEFAULT_EVAL_DIR,
        variant: a.values.get('from')?.[0] ?? DEFAULT_VARIANT,
        force: a.values.get('force') ?? [],
        usedBeforeSplit: a.values.get('used-before-split') ?? [],
        blank: a.flags.has('blank'),
      },
      out,
      err,
    );
  }
  if (command === 'check') {
    const a = parseArgs(rest, dirs, []);
    return runCheck(
      {
        photosDir: a.values.get('photos')?.[0] ?? DEFAULT_PHOTOS_DIR,
        answersDir: a.values.get('answers')?.[0] ?? DEFAULT_ANSWERS_DIR,
        evalDir: a.values.get('dir')?.[0] ?? DEFAULT_EVAL_DIR,
      },
      out,
      err,
    );
  }
  err('usage: tsx scripts/answers-cli.ts draft|check [options]');
  return 1;
}

try {
  process.exitCode = main();
} catch (e) {
  err(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
