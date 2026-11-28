# Proposal: agents never restore or rewrite a shared file wholesale; positive controls run in a copy or as reversible exact edits

**Status: pending**

**Targets:** `.claude/agents/implementer.md` (§ How to work); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/qa-tester.md` (step 3, the "Prints nothing" bullet); `.claude/skills/build-task/SKILL.md` (step 2, "Parallel tasks", via `2026-11-25-build-task-shared-files-and-served-backend.md` Change 8)

**Promotion rule used:** same lesson twice or more in the log (process area). This is the third whole-file overwrite of a shared file by an agent: Prettier over an untracked file (2026-11-25), a scripted rewrite the permission check denied (2026-11-27), and now a file restored from a 20-second-old backup during a positive control.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "An agent restored a shared file from a 20-second-old backup during a positive control" [process]: `app/(app)/bills/[id]/index.tsx`, edited by several sessions, was put back from a copy taken before the test. Any edit made in between would have been lost. Nothing was, by luck.
- 2026-11-27 "Five sessions shared the bill screen and its tests without clobbering" [process]: exact-string edits after a fresh read worked; a scripted rewrite was denied.
- 2026-11-25 "The designer ran Prettier over a whole untracked file, with no way to restore it" [process].
- The pending `2026-11-25-absence-assertions-need-presence.md` and `qa-tester` step 3 require positive controls, which is why agents break files on purpose.

## Change 1: `.claude/agents/implementer.md`, § How to work, new bullet directly before "- Don't commit or push."

Old:
```
- Don't commit or push.
```
(Insert directly before this line; the line itself stays unchanged.)

New (inserted):
```
- Other sessions may be editing the same files. Change files only with exact-string edits after a fresh read. Never put a file back by copying a backup, `git checkout`/`git restore`, `git stash` or a scripted rewrite: that restores everyone's version, not just yours. To show a test can fail (a mutant or positive control), work in a scratchpad copy of the repo, or make one exact edit and undo it with the reverse exact edit straight after, then check `git diff` on the file shows only your intended changes.
```

## Change 2: `.claude/agents/product-engineer.md`, § Build, new bullet directly after "Stay inside the task's scope; note anything outside it in your report. Don't commit or push."

Old:
```
- Stay inside the task's scope; note anything outside it in your report. Don't commit or push.
```

New:
```
- Stay inside the task's scope; note anything outside it in your report. Don't commit or push.
- Other sessions may be editing the same files. Change files only with exact-string edits after a fresh read. Never put a file back by copying a backup, `git checkout`/`git restore`, `git stash` or a scripted rewrite. Mutants and positive controls run in a scratchpad copy of the repo, or as one exact edit undone by the reverse exact edit straight after, followed by a `git diff` check.
```

## Change 3: `.claude/agents/qa-tester.md`, step 3, the "Prints nothing" bullet, one sentence appended

Old:
```
If you can't show the check works, use plain `grep -rn` over the same paths, or mark it NOT VERIFIED.
```

New:
```
If you can't show the check works, use plain `grep -rn` over the same paths, or mark it NOT VERIFIED. If showing a test can fail means changing code, do it in a scratchpad copy of the repo, never in the shared tree: you don't edit files, and a restore from a backup would overwrite other sessions' work.
```

## Change 4: build-task
Carried as part of Change 8 in `2026-11-25-build-task-shared-files-and-served-backend.md`, so the main session tells agents the same rule in handoffs.

## What this changes for you
When an agent checks that a test really catches a bug, it can't wipe out what another session (or you) changed in the same file a few seconds earlier.
