# Proposal: build-task lists each parallel task's files, and checks the served backend before showing the user the app

**Status: pending**

**Target:** `.claude/skills/build-task/SKILL.md` (step 2, the "Environment first" and "Parallel tasks" sub-bullets)

**Promotion rule used:** the same lesson twice or more in the log (process area). Change 1: the hosted-dev-server mismatch is now seen twice (QA on 2026-11-24, the main session on 2026-11-25), and the existing fix covers only `qa-tester`. Change 2: parallel-work interference is at its seventh occurrence, and the 2026-11-24 log entry said to promote the "name who updates the fixtures" handoff if one was missed; it was missed here.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "Checks ran against an environment that wasn't the one assumed" [process]: QA found the :8081 dev server pointed at the hosted project. Fixed in `qa-tester` only.
- 2026-11-25 "The dev server shown to the user pointed at the hosted project, again" [process]: the main session hit the same thing before showing the user a demo bill; it found it by grepping the served bundle and restarted with inline values after asking.
- 2026-11-24 "Parallel waves with planned cross-task breakage worked" [process]: naming which task updates other tasks' fixtures worked; "promote to `build-task` if a handoff is missed".
- 2026-11-25 "Parallel agents edited the same files; one changed a label another task's tests assert" [process]: `lib/settleView.ts`, `lib/theme.ts` and tests edited at once; `settle.test` broke on the renamed "Settle up" label with no plan saying who updates it; another session changed `supabase/config.toml`.
- 2026-11-25 "Two sessions shared files; sequencing by message worked" [process] (added in the visual-pass retro): the visual pass wrote each task's files and what it waited for into its task table ("after the bill-footer merges"), and the settle-early session applied six of our review fixes in the files it owned. That is Change 2 done by hand, and it worked.
- 2026-11-25 "A new dependency needed a dev server restart; the agent rightly left it" [process] (added in the visual-pass retro): one more reason the main session checks the served app before a user check (Change 1): after a package is added, the server must be restarted with the same inline values.
- Earlier parallel-work entries: 2026-11-21 "Parallel agents worked from a stale snapshot", 2026-11-22 "App and DB tasks built in parallel drifted…", 2026-11-24 "Other sessions' half-finished edits broke whole-repo test and typecheck runs", 2026-11-25 "Two Claude sessions worked side by side…".

## Change 1: step 2, "Environment first" sub-bullet

Old:
```
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run".
```

New:
```
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run". Before you show the user the running app (a demo, a user check), check which Supabase host the served bundle uses, as `qa-tester` does (`curl -s` the bundle and `grep -o` for `127.0.0.1:54321` or `supabase.co`; never read `.env`). If it isn't the backend the change needs, ask the user, then restart the server with the values passed inline.
```

## Change 2: step 2, "Parallel tasks" sub-bullet, one sentence added after its first sentence

Old:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself
```

New:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, write down each task's files (source and tests); tasks that share a file run one after another. If one task changes copy, a label or a shared type that another task's tests assert, name the task that updates those tests, and tell agents in between to report those failures as "expected until Task N". If another session changes `supabase/config.toml` or `supabase/.env`, Supabase needs a restart; ask the user. Before starting them, hand out shared numbers yourself
```
(Only the start of the bullet is shown; the rest of it stays as it is.)

## What this changes for you
You won't be shown a demo that's quietly talking to the hosted project while the new work is only on your Mac. And when several agents work at once, two of them won't edit the same file at the same time, so the short "a test broke in someone else's file" detours in this slice don't come back.
