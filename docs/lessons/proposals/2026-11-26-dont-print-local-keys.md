# Proposal: check the local stack without printing its keys, and never paste key values into reports

**Status: pending**

**Targets:** `.claude/skills/live-db-smoke/SKILL.md` (Steps, step 1); `.claude/agents/qa-tester.md` (Report section); `.claude/skills/build-task/SKILL.md` (step 2, "Environment first")

**Promotion rule used:** a rule that caused a wrong result gets reworded. `live-db-smoke` says "Never print a key", but its own step 1 (and build-task's "Environment first") runs `npm run db:status`, which prints the API URL and every local key, and QA's report format asks for "the command and its relevant output".

**Before applying:** check QA's log for the home-mobile-refresh live re-run to confirm which command printed the keys. If it wasn't `db:status` (for example a debug print in the scratch script), keep Changes 2 and 3 and adjust Change 1 to name that command.

## Evidence (docs/lessons/log.md)
- 2026-11-26 "The live re-run printed the local stack's keys into the QA log" [testing]: QA of docs/specs/2026-11-26-home-mobile-refresh.md, live re-run 15/15.
- 2026-11-22 "Live multi-user smoke tests with throwaway users, done by hand twice" [testing] and 2026-11-24 "live-db-smoke's env loading didn't export the keys" [testing]: the "keys stay in the process environment" rule this protects.

These are local-stack keys, so the risk today is low. But the same habit run against a hosted project (or with the newer `sb_secret_` local keys) puts a real secret in a log, and the leak-check greps look for exactly those strings.

## Change 1: `.claude/skills/live-db-smoke/SKILL.md`, Steps, step 1, first sentence

Old:
```
1. Check Docker and the stack: `npm run db:status`. If it's down, say so and stop (report "not run", not passed).
```

New:
```
1. Check Docker and the stack without printing keys: `npx supabase status -o env | sed 's/=.*//'` (names only; an error or empty output means it's down). `npm run db:status` prints every key, so don't use it here. If it's down, say so and stop (report "not run", not passed).
```

## Change 2: `.claude/agents/qa-tester.md`, Report section, first line

Old:
```
A table: criterion # → PASS / FAIL / NOT VERIFIED → evidence (the command and its relevant output).
```

New:
```
A table: criterion # → PASS / FAIL / NOT VERIFIED → evidence (the command and its relevant output). Never include key or token values in evidence, local ones included: check the stack with names-only output (`npx supabase status -o env | sed 's/=.*//'`), and replace any value that slips into output with `<redacted>`.
```

## Change 3: `.claude/skills/build-task/SKILL.md`, step 2, "Environment first" sub-bullet

Old:
```
run `npm run db:status`. If Docker or the stack is down,
```

New:
```
run `npx supabase status -o env | sed 's/=.*//'` (names only; `npm run db:status` prints every key into the conversation). If Docker or the stack is down,
```
(Only this phrase changes. It survives Change 1 of the pending `2026-11-25-build-task-shared-files-and-served-backend.md`, which keeps this text and adds sentences after it.)

## What this changes for you
Status checks will confirm the local database is up without writing its keys into agent logs and reports. `npm run db:status` stays as your own command for when you want to see them.
