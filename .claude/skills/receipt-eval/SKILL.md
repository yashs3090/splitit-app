---
name: receipt-eval
description: Measure how accurately SplitIt reads receipts: run the app's web scan pipeline over the user's photos (OCR harness), score the reads against hand-checked answer files, and decide whether a parser or pipeline change ships (tuning vs held-out). Use when changing lib/receiptText.ts or lib/scanPipeline/, adding receipt photos or answers, or the user asks how accurate scanning is.
---

# Receipt eval

Measures how well SplitIt reads real receipts, and decides whether a change to the parser (`lib/receiptText.ts`) or the scan pipeline (`lib/scanPipeline/`) ships. Free and offline: no model calls, no device, no backend (ADR 0010). Background for the user: `docs/learning/concepts/scan-pipeline.md`; step-by-step for the user: `docs/setup/receipt-answers.md`.

## Privacy first
- Photos live in `receipts/`, answers in `receipts/answers/`, reads and the set record in `eval/receipts/`. Before using any folder of real receipts, run `git check-ignore <path>`; if it isn't ignored, add it to `.gitignore` and tell the user.
- Never copy, upload or paste photos or receipt text anywhere outside those folders. Fixtures derived from a read have names and card/check numbers stripped (see `lib/fixtures/receipts.ts`).
- The harness serves files on `127.0.0.1` only and fails the run if anything else is contacted. Don't weaken that.

## The three tools (run from the repo root)
1. **Read the photos:** `npm run ocr:harness -- --variants <v1>,<v2> [--only <name,...>] [--browser chromium|webkit] [--repeat <n>] [--timeout-ms <ms>] [--photos <dir>] [--dump-binary]`
   - Runs the app's own web pipeline (`lib/scanPipeline/run.ts` + `web/stages.ts`) in headless Playwright Chromium. First time: `npx playwright install chromium`. Its `preocr:harness` hook copies the Tesseract files into `public/tesseract/`.
   - Writes `eval/receipts/<name>.<variant>.ocr.json` (lines, per-stage trace, timings). Variant names come from `VARIANTS` in `lib/scanPipeline/config.ts`; `web-current` is what the app does today.
   - OpenCV variants build a private OpenCV copy for the run (no need to flip `WEB_CV_PREPROCESS`). A cv run that didn't really use OpenCV fails the harness and writes nothing.
   - HEIC photos can't be decoded in Chromium; the harness says so and skips them. Ask the user for a JPEG.
2. **Answer files (the ground truth):** `receipts/answers/<photo name>.txt`, in dollars as printed (format: `docs/setup/receipt-answers.md`, parser `lib/receiptAnswers.ts`).
   - `npm run answers:draft` pre-fills a draft from the `web-current` read (`--from <variant>` for another), marked `checked: no`; an old `eval/receipts/<name>.expected.json` is moved over instead. It also records each photo's tuning / held-out set once in `eval/receipts/sets.json`. It never overwrites; `--force <photo>` redoes one (keeps a timestamped `.bak`), `--blank` writes an empty draft, `--used-before-split <photo>` forces a receipt you already looked at into tuning (only before its set is recorded, i.e. its first draft).
   - **Only the user marks `checked: yes`.** Agents may draft and point out mistakes, but never mark an answer checked or edit a checked one without the user saying so.
   - `npm run answers:check` validates every file and reports answers that don't add up.
3. **Score:** `npm run eval`
   - `-- --variant <v>`: one variant's scores (default `web-current`).
   - `-- --compare <baseline>,<candidate>`: applies `decide`; add `--core` for `decideCore` (the crop only has to do no harm). Without `--confirm` the best verdict is TUNING PASSED; ADOPT needs `--confirm`. `--strict` gives NO DECISION below the receipt minimum instead of PROVISIONAL.
   - `-- --flow <primary>,<retry>`: replays the pipeline's retry (`assessQuality`, then `pickBetter`) over two saved variants.
   - `--only <name,...>` limits the receipts. `--confirm` also prints held-out numbers.
   - A checked answer whose set isn't in `sets.json` yet is skipped; run `npm run answers:draft` to record it. A variant with no `ocr.json` at all is an error (exit 2), not "no receipts".
   - Read-only: it prints and writes nothing.

## Before building anything to measure
- Count the checked answers first (`npm run answers:check`, `npm run eval`). If there are fewer than the minimum (12 tuning + 8 held-out), the first step is getting answers checked, not building stages: draft them (`answers:draft`) and give the user the list of files to check. Results below the minimum are PROVISIONAL and can't decide what ships.
- Build and measure one stage at a time, in order of expected value. Don't start the next optional stage while the last verdict is still PROVISIONAL unless the user has said to build anyway.

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
- **Check the stage really ran.** Before scoring a variant, confirm from its `ocr.json` trace that the stage under test ran (e.g. `cropApplied`, no `unavailable` / `fallback` entry for it). A variant that silently fell back measures the baseline. The harness already refuses cv variants that didn't use OpenCV; check the other stages yourself. The harness has its own OpenCV copy, but it serves `public/tesseract/` directly, so don't run it while another session may be rebuilding that folder.
- **Use the app's rules, not copies.** Totals checks and tolerances in tools come from `lib/` (`checkTotals`, `totalsGaps`). Any rule that ranks two reads orders its signals by the user's priority: total, tip and tax first (a read with the total beats one without), then gaps and counts.

## Report
- Data: how many checked tuning / held-out answers, drafts skipped, photos without answers.
- Per set, never pooled: line-item accuracy (matched / expected), junk items, % reconciled (`checkTotals` ±1¢), % totals correct.
- The 3 worst receipts and what was missed or extra.
- For `--compare` / `--flow`: the verdict and the failing clause, PROVISIONAL if below 12 / 8, whether `--confirm` was run (and the date), and median timings per stage from the ocr.json files.
- Append the experiment's row to the spec's Results log (variant, date, set counts, verdict, failing clause, timings) before reporting the task done. A task that ran an experiment without writing its row isn't finished. If a criterion lists the rows the Results log must have, check each one is there.

The fallback threshold is 85% line-item accuracy (ADR 0010). If web or native stays under it, tell the user; bringing back Claude in an Edge Function is their decision (it adds a backend and a per-scan cost). Add notable findings to `docs/lessons/log.md` with `[area: receipt-parsing]`.
