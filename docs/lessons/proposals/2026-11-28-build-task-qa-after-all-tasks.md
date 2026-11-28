# Proposal: QA starts after every spec task, docs tasks included

**Status: pending**

**Target:** `.claude/skills/build-task/SKILL.md`, step 4

**Promotion rule used:** the same lesson twice or more in the log (process area). Twice now, QA has failed or found nothing to check because written work wasn't done yet when it ran: the Results-log rows (2026-11-25), and now the docs task (Task 12) in tab bar and Activity.

## Evidence (docs/lessons/log.md)
- 2026-11-28 "QA checked the docs criteria before the docs task had run" [process]: criteria 57–58 of docs/specs/2026-11-28-tab-bar-and-activity.md.
- 2026-11-25 "QA failed only on missing Results-log rows" [process]: criteria 41 and 45 of docs/specs/2026-11-22-web-opencv-preprocessing.md.
- Related: 2026-11-22 "A docs agent reported a task as 'not built' because it ran before that task landed" [process], the reverse ordering slip. Its rule ("Docs that describe status run last") is applied, but it says nothing about QA.

## Change: `.claude/skills/build-task/SKILL.md`, step 4

Old:
```
4. **QA:** run the `qa-tester` agent with the spec path. If Overall is FAIL, return to step 2 with the failing criteria (this counts toward the 3-round limit).
```

New:
```
4. **QA:** run the `qa-tester` agent with the spec path once every task in the spec has finished, docs and log tasks included. Before you start it, check the criteria that name a file's contents (decisions rows, before-production items, Results-log rows) against the files. If you start QA early on purpose, tell it which criteria are "pending Task N" so it reports them as not run, not as failures. If Overall is FAIL, return to step 2 with the failing criteria (this counts toward the 3-round limit).
```

## What this changes for you
QA reports will stop showing failures that only mean "the docs step hasn't happened yet", so a FAIL means something is actually wrong.
