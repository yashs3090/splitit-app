# Proposal: CLAUDE.md says never to run a formatter over an existing file

**Status: pending**

**Target:** `CLAUDE.md` § Conventions (new bullet directly after the TypeScript bullet)

**Promotion rule used:** the same lesson twice or more in the log (process area). Two whole-file Prettier runs: the visual-designer on `app/(app)/profile.tsx` (2026-11-25), and now the main session on `app/(app)/bills/[id]/settle.tsx`. The first fix exists only as pending agent proposals, and those don't reach the main session, which reads `CLAUDE.md`. Putting the rule in `CLAUDE.md` covers the main session and every agent at once.

## Evidence (docs/lessons/log.md)
- 2026-11-28 "The main session ran Prettier over all of settle.tsx, the second whole-file format" [process]: reformatted to 80 columns; recovered with `--print-width 140 --single-quote`, but some long lines kept by hand were lost.
- 2026-11-25 "The designer ran Prettier over a whole untracked file, with no way to restore it" [process].
- 2026-11-27 "An agent restored a shared file from a 20-second-old backup during a positive control" [process]: same family (whole-file overwrites of shared files).

- 2026-11-28 "An agent ran Prettier on two untracked files, the third whole-file format" [process] (added in the tab-bar-and-Activity retro): two untracked files were reformatted by mistake and rebuilt by hand. "New files" in the first wording could be read as "untracked", which in a shared tree includes other sessions' new files, so the wording below is narrowed to files you created in this task.

## Change: `CLAUDE.md` § Conventions

Old:
```
- TypeScript strict everywhere. No `any` without a comment explaining why.
```

New:
```
- TypeScript strict everywhere. No `any` without a comment explaining why.
- The repo has no formatter config. Never run Prettier, `eslint --fix` or a codemod over an existing file: with no config it reformats every line (Prettier defaults to 80 columns), hides the real change, and can't be undone on untracked or shared files. Edit only the lines you change, in the file's existing style. If a file you created in this task needs formatting, use `npx prettier --print-width 140 --single-quote --write <that file>` on that file only. Untracked doesn't mean yours: other sessions' new files are untracked too.
```

## Relation to other proposals
`2026-11-25-visual-changes-keep-behavior.md` Changes 4/5 put a similar sentence in `visual-designer`, `implementer` and `product-engineer`. They can still be applied. This bullet is the one the main session will see, and it adds the settings to use for new files. If you approve this one, those agent sentences can be shortened to "follow the formatter rule in CLAUDE.md" or left as they are.

## What this changes for you
Neither the main session nor an agent will reformat a whole file again, so diffs show only real changes and lines you kept long by hand stay that way.
