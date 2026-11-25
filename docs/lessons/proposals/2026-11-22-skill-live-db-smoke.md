# Proposal: new skill `live-db-smoke` (multi-user checks against the local Supabase)

**Status:** applied 2026-11-22. The "verify" gaps were filled from the M1b+M2 scripts (QA `live/live.mjs`, Task 9 `smoke/smoke.mjs`): users created with the auth admin API; sessions are locally signed HS256 JWTs (`JWT_SECRET`) sent as a global `Authorization` header plus `realtime.setAuth`; env names `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_SECRET`. Also corrected: scripts are plain `.mjs` with `createRequire` (`tsx` isn't a dependency). The cleanup count check (zero users left) was added as a required step; neither script contained it.
**Target file:** new `.claude/skills/live-db-smoke/SKILL.md`
**Promotion rule used:** a multi-step workflow done by hand twice or more becomes a skill. In M1b+M2, Task 8's reconciliation (21 checks) and QA's live multi-user run (49 checks) each rebuilt the same procedure: start local Supabase, pipe keys from `supabase status -o env` into the process, mint throwaway users with the admin API, act as each user through `supabase-js`, check RLS/claims/realtime, clean up.

**Before applying:** one detail is marked "verify" below: how each throwaway user gets a session, given that email sign-in is off (`[auth.email] enabled = false`). Fill it in with the exact method Task 8 and QA used (the main session has their reports), so the skill doesn't guess. The env variable names printed by `supabase status -o env` should also be checked against the installed CLI.

## Full new file

```markdown
---
name: live-db-smoke
description: Run SplitIt's app data layer against the live local Supabase as several throwaway users, to check RLS, database functions, claims and realtime end to end. Use after DB migrations land when app code was written against the spec (contract reconciliation), when QA needs a multi-user check, or when the user asks for a live or smoke test of bills/claims.
---

# Live multi-user smoke test (local only)

pgTAP checks the database from inside Postgres, and Jest uses fakes. This skill checks the real client calls, RLS and realtime together, as several real users.

## Safety rules
- **Local stack only.** Refuse if the API URL isn't `http://127.0.0.1:...` or `http://localhost:...`.
- **Keys stay in the process environment.** Never read, grep or write `.env*` files. Never print a key, write it to a file, or paste it into a report. Load keys inline: `eval "$(npx supabase status -o env)"` in the same shell command that runs the script (verify the variable names it prints with the installed CLI; they have been `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, and newer CLIs add publishable/secret key names).
- The service-role key is used **only** to create and delete the throwaway users. Every check runs as a signed-in user with the anon/publishable key, because that's what the app does.
- Users are throwaway: unique emails like `smoke-<run-id>-a@example.test`. Delete them (and their bills, via cascade) at the end, even on failure (`finally`).

## Steps
1. Check Docker and the stack: `npm run db:status`. If it's down, say so and stop (report "not run", not passed). Apply pending migrations with `npx supabase migration up`. Don't `db:reset` unless the user agrees, because it wipes local data.
2. Write the script in the session scratchpad, not the repo (unless the user wants it committed). Use TypeScript with `npx tsx`, importing the app's real data-layer modules from `lib/` where they run under Node. Otherwise call the same RPCs with `@supabase/supabase-js`.
3. Create users A (host), B and C with `auth.admin.createUser`. Get a session for each: **verify, then fill in the method used in M1b+M2** (email sign-in is disabled in `config.toml`, so password or magic-link sign-in may be refused).
4. For each user, create a separate client with that user's session. Call `supabase.realtime.setAuth(token)` after setting the session (private channels otherwise get the anon role). Use one channel per topic per client, and `await removeChannel()` before re-subscribing.
5. Run numbered checks. Each prints `PASS/FAIL <n> <what>` plus the error code on failure. Cover at least:
   - The host creates a bill; B and C join with the code; a non-participant D can't read it (expect `42501` or zero rows, as the spec says).
   - Only the host edits items; B and C get `42501`.
   - Each user claims and unclaims only their own claims; writing someone else's fails.
   - Every rule both the app and the DB enforce (e.g. the totals tolerance) is tested at the boundary: exactly at tolerance passes, 1¢ over fails, with the same input the `lib/` test uses.
   - Realtime: B sees A's change within a few seconds; after unsubscribe, no more events arrive.
   - Columns: co-participants see only the columns they're meant to (e.g. `display_name`, not the whole profile).
   - Activity events: each action writes exactly one event, and no client role can insert, update or delete one.
6. Clean up (delete the throwaway users) and print the totals line `N/M passed`.

## Report
The check table (number → PASS/FAIL → what was called and the error code), the totals line, anything not run and why, and any contract mismatch found (function argument, field name, rule disagreement). Mismatches become spec amendments, per `build-task`.
```

## Evidence (docs/lessons/log.md)
- "2026-11-22: Live multi-user smoke tests with throwaway users, done by hand twice [area: testing]"
- "2026-11-22: App and DB tasks built in parallel drifted from their shared contract [area: process]"
- "2026-11-22: Realtime facts verified from the installed packages [area: expo]"
