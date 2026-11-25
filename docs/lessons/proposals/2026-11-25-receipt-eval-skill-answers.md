# Proposal: the receipt-eval skill describes the harness, answer files, sets and decision rules that exist now

**Status:** applied 2026-11-25. Applied with small accuracy fixes after checking the code (`scripts/ocr-harness/run.ts`, `scripts/answers-cli.ts`, `scripts/answers.ts`, `scripts/eval-receipts.ts`, `lib/receiptEval.ts`): harness flags `--timeout-ms` / `--photos` and the `preocr:harness` Tesseract hook added; `answers:draft` documented as also recording sets in `sets.json`, moving old `expected.json` files, `--from <variant>`, a timestamped `.bak`, and `--used-before-split` working only before the set is recorded; eval notes added that `--compare` without `--confirm` tops out at TUNING PASSED, that a checked answer with no recorded set is skipped until `answers:draft` runs, and that a variant with no ocr.json exits 2.
**Target file:** `.claude/skills/receipt-eval/SKILL.md` (whole body below the front matter)
**Promotion rule used:** a skill step that is wrong in use gets fixed in the skill. The current skill describes files and a command that no longer match the tools: ground truth is `receipts/answers/<photo>.txt`, not `eval/receipts/<name>.expected.json` (Amendment A3); reads come from `npm run ocr:harness`, not a phone; and it says nothing about tuning vs held-out, `--compare`, `--flow`, `--confirm` or the provisional verdict. An agent following it today would look for the wrong files and could peek at held-out receipts.

**Source of the text:** the spec's Task 15 asked for this proposal (originally named `2026-11-22-receipt-eval-skill-update.md`; the main session renamed it). The main session says the earlier answers agent drafted a version; that draft wasn't found in the repo on 2026-11-25 (searched `docs/`, `scripts/`, `eval/`), so this version was written from the current code (`scripts/eval-receipts.ts`, `scripts/answers-cli.ts`, `scripts/ocr-harness/run.ts`, `lib/receiptEval.ts`, `lib/receiptAnswers.ts`) and `docs/setup/receipt-answers.md`. **If the main session has that draft, merge any points it has that this one lacks.**

## Evidence
- Spec `docs/specs/2026-11-22-web-opencv-preprocessing.md`: C1 (data, scoring, decision rules), Task 1, Task 4 (harness), Amendment A1 (provisional verdicts below 12 / 8), A3 (answer files replace `expected.json`), Task 15 (this proposal).
- `docs/lessons/log.md` 2026-11-24 "The eval couldn't show the change, because the motivating receipt's read lacked the lines" [receipt-parsing]: check the saved read has the lines a rule needs before relying on the eval.
- `docs/lessons/log.md` 2026-11-22 "Real user data went into a folder that wasn't gitignored" [process]: `git check-ignore` before using a user's folder of real data.
- User memory "General fixes, not receipt-specific" and spec D3: rules must generalize; validate on held-out receipts.

## Exact change
Keep the front matter (`name`, `description`), but update the description, then replace everything below it.

Old front-matter description:
```
description: Measure how accurately SplitIt's receipt parser (lib/receiptText.ts) reads line items from saved on-device text-recognition output. Use when changing the parser, adding receipt fixtures, or the user asks how accurate parsing is.
```

New front-matter description:
```
description: Measure how accurately SplitIt reads receipts: run the app's web scan pipeline over the user's photos (OCR harness), score the reads against hand-checked answer files, and decide whether a parser or pipeline change ships (tuning vs held-out). Use when changing lib/receiptText.ts or lib/scanPipeline/, adding receipt photos or answers, or the user asks how accurate scanning is.
```

Old body (everything below the front matter):
```
# Receipt parser eval

Receipts are read on device (Apple Vision / ML Kit) and parsed by our own code in `lib/receiptText.ts` (ADR 0010). The eval runs the parser over **saved recognition output**, so it is free, offline, and needs no device.

The eval script is `scripts/eval-receipts.ts`. If it doesn't exist yet, say so and offer to run build-task for it.

## Data
- `eval/receipts/<name>.ocr.json`: the recognized text captured from a real scan (lines with text, and bounding boxes if the library gives them).
- `eval/receipts/<name>.expected.json`: the correct result in cents (items, subtotal, tax, tip, discounts, total).
- Optional `eval/receipts/<name>.jpg`: the original photo, for humans only.
- Real receipts can contain personal data (card digits, names). `eval/receipts/` is gitignored unless the user says otherwise.

## Run
`npx tsx scripts/eval-receipts.ts [--only <name>]`

## Report
- Line-item accuracy: matched / expected (name roughly equal, cents exactly equal)
- Totals reconciled: % of receipts where items = subtotal and subtotal + tax + tip − discounts = total (±1¢)
- The 3 worst receipts and what went wrong

The kill/fallback threshold is 85% line-item accuracy (ADR 0010). If the parser stays under it after tuning, tell the user; bringing back Claude in an Edge Function is their decision (it adds a backend and a per-scan cost). Add notable findings to `docs/lessons/log.md` with `[area: receipt-parsing]`.
```

New body:
````
# Receipt eval

Measures how well SplitIt reads real receipts, and decides whether a change to the parser (`lib/receiptText.ts`) or the scan pipeline (`lib/scanPipeline/`) ships. Free and offline: no model calls, no device, no backend (ADR 0010). Background for the user: `docs/learning/concepts/scan-pipeline.md`; step-by-step for the user: `docs/setup/receipt-answers.md`.

## Privacy first
- Photos live in `receipts/`, answers in `receipts/answers/`, reads and the set record in `eval/receipts/`. Before using any folder of real receipts, run `git check-ignore <path>`; if it isn't ignored, add it to `.gitignore` and tell the user.
- Never copy, upload or paste photos or receipt text anywhere outside those folders. Fixtures derived from a read have names and card/check numbers stripped (see `lib/fixtures/receipts.ts`).
- The harness serves files on `127.0.0.1` only and fails the run if anything else is contacted. Don't weaken that.

## The three tools (run from the repo root)
1. **Read the photos:** `npm run ocr:harness -- --variants <v1>,<v2> [--only <name,...>] [--browser chromium|webkit] [--repeat <n>] [--dump-binary]`
   - Runs the app's own web pipeline (`lib/scanPipeline/run.ts` + `web/stages.ts`) in headless Playwright Chromium. First time: `npx playwright install chromium`.
   - Writes `eval/receipts/<name>.<variant>.ocr.json` (lines, per-stage trace, timings). Variant names come from `VARIANTS` in `lib/scanPipeline/config.ts`; `web-current` is what the app does today.
   - OpenCV variants build a private OpenCV copy for the run (no need to flip `WEB_CV_PREPROCESS`). A cv run that didn't really use OpenCV fails the harness and writes nothing.
   - HEIC photos can't be decoded in Chromium; the harness says so and skips them. Ask the user for a JPEG.
2. **Answer files (the ground truth):** `receipts/answers/<photo name>.txt`, in dollars as printed (format: `docs/setup/receipt-answers.md`, parser `lib/receiptAnswers.ts`).
   - `npm run answers:draft` pre-fills a draft from the `web-current` read, marked `checked: no`. It never overwrites; `--force <photo>` redoes one (keeps a `.bak`), `--blank` writes an empty draft, `--used-before-split <photo>` forces a receipt you already looked at into tuning (first draft only).
   - **Only the user marks `checked: yes`.** Agents may draft and point out mistakes, but never mark an answer checked or edit a checked one without the user saying so.
   - `npm run answers:check` validates every file and reports answers that don't add up.
3. **Score:** `npm run eval`
   - `-- --variant <v>`: one variant's scores (default `web-current`).
   - `-- --compare <baseline>,<candidate>`: applies `decide`; add `--core` for `decideCore` (the crop only has to do no harm). `--strict` gives NO DECISION below the receipt minimum instead of PROVISIONAL.
   - `-- --flow <primary>,<retry>`: replays the pipeline's retry (`assessQuality`, then `pickBetter`) over two saved variants.
   - `--only <name,...>` limits the receipts. `--confirm` also prints held-out numbers.
   - Read-only: it prints and writes nothing.

## Tuning vs held-out (the rule that keeps results honest)
- Each receipt's set (tuning ≈ 60%, held-out ≈ 40%) comes from a hash of its name, is recorded once in `eval/receipts/sets.json`, and no tool or agent changes it. Receipts seen before the split are tuning.
- Choose on **tuning only**. Run `--confirm` **once per experiment**, after choosing. If held-out rejects the candidate, it's rejected: never adjust and re-run held-out.
- Below 12 tuning + 8 held-out checked answers, every verdict is **PROVISIONAL** (Amendment A1). Say so in the report, with the actual counts.
- `decide` adopts only if, on tuning, matched items rise by ≥ max(2, ⌈2% of expected⌉), no receipt loses more than 1 item, junk rises by at most 1 and correct totals don't fall; then on held-out, matched doesn't fall, no receipt loses more than 1 item and correct totals don't fall.

## Rules for changes being measured
- **General, never receipt-specific.** A new rule or threshold needs a general reason (`Why:` comment), a unit test on made-up input (not copied from a receipt's read), and a `Tuned:` comment with the tuning and held-out result. No receipt names in `lib/`, `app/` or `components/` code.
- **One factor per variant.** A new variant differs from its baseline by one thing, so a score change has one cause.
- **Check the read has the lines first.** Before relying on the eval for a parser rule motivated by a receipt, open its saved `ocr.json` and confirm the lines the rule needs are there. If not, say up front that the eval can't show the effect.
- A rejected variant stays in `VARIANTS`; only the shipping step (spec Task 14) changes `PIPELINE` / `WEB_CV_PREPROCESS`, and only from results, with the user's approval.

## Report
- Data: how many checked tuning / held-out answers, drafts skipped, photos without answers.
- Per set, never pooled: line-item accuracy (matched / expected), junk items, % reconciled (`checkTotals` ±1¢), % totals correct.
- The 3 worst receipts and what was missed or extra.
- For `--compare` / `--flow`: the verdict and the failing clause, PROVISIONAL if below 12 / 8, whether `--confirm` was run (and the date), and median timings per stage from the ocr.json files.
- Append experiment rows to the spec's Results log when the task asks for it.

The fallback threshold is 85% line-item accuracy (ADR 0010). If web or native stays under it, tell the user; bringing back Claude in an Edge Function is their decision (it adds a backend and a per-scan cost). Add notable findings to `docs/lessons/log.md` with `[area: receipt-parsing]`.
````

## What this changes for you
Agents measuring scans will use the answer files you check, never grade the app against its own drafts, look at held-out receipts only once per experiment, and tell you plainly when a result rests on too few receipts. Nothing about the app changes.
