// Replaced by `npm run answers:draft` (scripts/answers.ts): ground truth now lives in plain-text
// answer files, receipts/answers/<photo name>.txt, in dollars (docs/setup/receipt-answers.md).
// This stub stays so an old command prints where to go instead of writing expected.json files
// the eval no longer prefers.
process.stderr.write(
  'eval-init.ts is replaced by "npm run answers:draft", which writes receipts/answers/<photo>.txt drafts.\n' +
    'See docs/setup/receipt-answers.md.\n',
);
process.exitCode = 1;
