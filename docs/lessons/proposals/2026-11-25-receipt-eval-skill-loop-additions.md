# Proposal: add the experiment loop's lessons to the receipt-eval skill

**Status: applied 2026-11-25** (after `2026-11-25-receipt-eval-skill-answers.md`). Changes 1 and 3 applied exactly. Change 2's "Check the stage really ran" bullet was reworded to match the code: the harness already builds its own OpenCV copy and refuses cv variants that didn't use OpenCV (`scripts/ocr-harness/run.ts`, `checks.ts`), but it serves `public/tesseract/` directly, so the warning now names only that folder and says to check non-cv stages by hand.

**Target:** `.claude/skills/receipt-eval/SKILL.md`, the new body written by `2026-11-25-receipt-eval-skill-answers.md`

**Promotion rule used:** a multi-step workflow done by hand twice or more becomes a skill. The harness → answers → eval → Results-log loop was run by hand for nearly every task of the scan-pipeline slice (Tasks 5, 7, 8, 9, 11, 12, 13, 14). The pending receipt-eval proposal already turns the receipt-eval skill into that skill, so no new skill is needed; these additions carry the slice's lessons into it.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "A measurement slice built 15 tasks of stages before it had the answers to measure them" [receipt-parsing].
- 2026-11-25 "An npm hook wiped `public/opencv/` while the harness was reading it" [testing].
- 2026-11-25 "QA failed only on missing Results-log rows" [process].
- 2026-11-25 "Scan pipeline findings to carry forward" [receipt-parsing] (ranking by the user's priority).
- 2026-11-25 "The same rule copied instead of imported…" [money-math] (`answers:check` tolerance).

## Change 1: new section, inserted right before `## Tuning vs held-out (the rule that keeps results honest)`

Old:
```
## Tuning vs held-out (the rule that keeps results honest)
```

New:
```
## Before building anything to measure
- Count the checked answers first (`npm run answers:check`, `npm run eval`). If there are fewer than the minimum (12 tuning + 8 held-out), the first step is getting answers checked, not building stages: draft them (`answers:draft`) and give the user the list of files to check. Results below the minimum are PROVISIONAL and can't decide what ships.
- Build and measure one stage at a time, in order of expected value. Don't start the next optional stage while the last verdict is still PROVISIONAL unless the user has said to build anyway.

## Tuning vs held-out (the rule that keeps results honest)
```

## Change 2: § "Rules for changes being measured", append two bullets at the end of that section

Old:
```
- A rejected variant stays in `VARIANTS`; only the shipping step (spec Task 14) changes `PIPELINE` / `WEB_CV_PREPROCESS`, and only from results, with the user's approval.
```

New:
```
- A rejected variant stays in `VARIANTS`; only the shipping step (spec Task 14) changes `PIPELINE` / `WEB_CV_PREPROCESS`, and only from results, with the user's approval.
- **Check the stage really ran.** Before scoring a variant, confirm from its `ocr.json` trace that the stage under test ran (e.g. `cropApplied`, no `unavailable` / `fallback` entry for it). A variant that silently fell back measures the baseline. Don't run the harness while another session's `npm run web` / `start` / `export:web` may rebuild `public/opencv/` or `public/tesseract/`; the harness uses its own copy.
- **Use the app's rules, not copies.** Totals checks and tolerances in tools come from `lib/` (`checkTotals`, `totalsGaps`). Any rule that ranks two reads orders its signals by the user's priority: total, tip and tax first (a read with the total beats one without), then gaps and counts.
```

## Change 3: § "Report", replace the last bullet

Old:
```
- Append experiment rows to the spec's Results log when the task asks for it.
```

New:
```
- Append the experiment's row to the spec's Results log (variant, date, set counts, verdict, failing clause, timings) before reporting the task done. A task that ran an experiment without writing its row isn't finished. If a criterion lists the rows the Results log must have, check each one is there.
```

## What this changes for you
Next time the team measures scanning, it will ask you for answer files first and build fewer experiments until those exist; every result it reports will have its row in the spec, so QA doesn't fail on missing paperwork; and a result can't come from a run where the step being tested didn't actually happen.
