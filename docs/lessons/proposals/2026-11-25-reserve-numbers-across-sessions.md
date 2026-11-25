# Proposal: reserve ADR numbers on disk, and declare what each parallel session owns

**Status: applied 2026-11-25** (all three changes applied exactly as written)

**Targets:** `.claude/skills/build-task/SKILL.md` (step 2, "Parallel tasks"); `.claude/agents/docs-writer.md` (Rules, ADRs); `.claude/agents/product-manager.md` (Rules)

**Promotion rule used:** a rule that caused a wrong result gets reworded. The current build-task rule (hand out ADR numbers up front) was followed and still collided, because the reservation lived only in the spec's text, which other sessions don't read. Parallel interference has now been logged six times.

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Parallel agents worked from a stale snapshot" [process]: ADR 0011 collision inside one session; the source of the current rule.
- 2026-11-25 "ADR numbers collided again, this time across sessions" [process]: 0015/0016 assigned on 11-22 became 0018/0019 on 11-25 (S-D-1).
- 2026-11-25 "Two Claude sessions worked side by side, and declaring file ownership up front worked" [process]: owned files had no collisions; unclaimed shared numbers and generated folders did.
- 2026-11-25 "An npm hook wiped `public/opencv/` while the harness was reading it" [testing].
- 2026-11-24 "Other sessions' half-finished edits broke whole-repo test and typecheck runs" [testing].

## Change 1: `.claude/skills/build-task/SKILL.md`, step 2

Old:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself (the next ADR number from `docs/learning/decisions/README.md`, migration timestamps) and tell each agent its number. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place. Keep at most two full test suites running at once.
```

New:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself and tell each agent its number. An ADR number counts as reserved only once it's on disk: create `docs/learning/decisions/NNNN-<slug>.md` as a stub (title plus `**Status:** Reserved by <spec path>, <date>`) and add its row to `decisions/README.md` at the moment you hand it out; the docs task later fills the stub in. Migration timestamps are taken when the migration file is created, not in advance. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place. Keep at most two full test suites running at once.
   - **Another Claude session active:** send it, before work starts, the files this session owns, the ADR numbers it has reserved (on disk, as above), and the generated folders its tools write or delete (`public/opencv/`, `public/tesseract/`, `dist/`). Don't edit files the other session owns. Long-running tools (harnesses, exports) use their own copy of generated assets instead of the shared folder.
```

## Change 2: `.claude/agents/docs-writer.md`, Rules, ADRs bullet

Old:
```
- **ADRs:** one decision per file, numbered, never renumbered.
```

New:
```
- **ADRs:** one decision per file, numbered, never renumbered. If the main session gave you a number, check that `docs/learning/decisions/` has your reserved stub for it; if the number is taken by a different ADR, use the next free one, write a note in the spec, and report it. Fill a reserved stub in place rather than creating a second file.
```

(Only the first sentence of the bullet is shown and changed; the rest of the bullet, from "Never rewrite a past decision…", stays as it is.)

## Change 3: `.claude/agents/product-manager.md`, Rules, new bullet before "Write only under `docs/`."

Old:
```
- Write only under `docs/`. Never edit code.
```

New:
```
- Refer to an ADR that doesn't exist yet by its title ("the staged-pipeline ADR"), not by a number, unless the main session has reserved the number with a stub file in `docs/learning/decisions/`.
- Write only under `docs/`. Never edit code.
```

## What this changes for you
ADR numbers stop shifting between the spec and the final docs, so links in specs keep pointing at the right decision. When two sessions work at once, each tells the other up front what it's working on, including the generated folders, so one session's build step can't delete files the other is using. You'll see "Reserved" ADR stubs in `docs/learning/decisions/` for a short time while a slice is in progress.
