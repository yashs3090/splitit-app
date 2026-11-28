# Proposal: before blaming your own task for a db:test failure, check for unapplied migrations from other sessions

**Status: pending**

**Targets:** `.claude/agents/qa-tester.md` (Steps, step 2); `.claude/agents/supabase-engineer.md` (Rules, after the "If Docker isn't running" bullet)

**Promotion rule used:** the same lesson seen twice or more in the log. A failure caused by another session's work in progress has now been logged for whole-repo Jest and `tsc` runs (2026-11-24, promoted to `implementer` and `qa-tester`) and, for the first time, for pgTAP. The existing rule covers only failures in files the task didn't touch. In this case the failing files were shared ones the task does own, so that rule didn't fire.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "pgTAP went red because shared test files already called another session's unapplied migrations" [testing]: `group_bills`, `membership` and `assign_item` test 4 failed. They called functions from Who-paid's migrations `2026112714000x`, which weren't applied yet. After that session applied them: 29 files, 1943 tests passed.
- 2026-11-24 "Other sessions' half-finished edits broke whole-repo test and typecheck runs" [testing]: the Jest/`tsc` version, already a rule.
- 2026-11-27 "Our `migration up` applied another session's draft migration" [process]: why the fix is "report and wait", not "apply it yourself".

## Change 1: `.claude/agents/qa-tester.md`, Steps, step 2, one sentence added at the end

Old:
```
The task's own test files must still pass on their own.
```

New:
```
The task's own test files must still pass on their own. If `npm run db:test` fails with "function … does not exist" or "column … does not exist" (or a plan count mismatch) in a shared test file, check for another session's migration first: run `npx supabase migration list --local` (check `--help` if the flag differs) or compare `supabase/migrations/` with what is applied, grep `supabase/migrations/` for the missing name, and run `git status` / `git log -1` on the test file. If an unapplied migration you didn't write defines it, report "waiting on <session>'s migration <file>" with the failing tests, don't apply it yourself, and re-run once it has been applied.
```

## Change 2: `.claude/agents/supabase-engineer.md`, Rules, a new bullet after "If Docker isn't running, say so and report the database tests as "not run", not passed."

New:
```
- A db:test failure that names a function or column your migrations don't define may come from another session: list the unapplied migrations (`npx supabase migration list --local`), grep `supabase/migrations/` for the name, and report "waiting on <session>'s migration" instead of changing your SQL to match. When your own task edits a shared pgTAP file to call something from a new migration, the edit lands together with that migration, never before it.
```

## What this changes for you
When the database tests go red because another session is partway through its work, agents will say so and name the migration they're waiting for. They won't spend time "fixing" this task's SQL, and they won't apply someone else's draft.
