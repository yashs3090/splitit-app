# Proposal: check the environment before agents run; don't trust failures in other sessions' files

**Status:** applied (2026-11-24, approved by the user)
**Target files:** `.claude/skills/build-task/SKILL.md` § Steps, `.claude/agents/qa-tester.md` § Steps, `.claude/agents/implementer.md` § How to work
**Promotion rules used:**
- Changes 1 and 2: the fourth time a step ran against an environment that wasn't the one assumed (M1a: Supabase not restarted after `supabase/.env` changed; M1a: `127.0.0.1` on the phone; M1a: stale baked `EXPO_PUBLIC_` values; this slice: Docker down, and a dev server pointed at the hosted project).
- Changes 3 and 4: the fourth occurrence of parallel work interfering (ADR collision, stale docs claims, Jest overload, and now half-edited files from other sessions breaking whole-repo runs).

## Change 1: `.claude/skills/build-task/SKILL.md`, step 2

Old:
```
2. **Implement:** for each task in the spec, in order, run the agent the task names (default `implementer`; `supabase-engineer` for `supabase/` work; `native-mobile` for camera, on-device text recognition or other native modules) with the spec path and the task number. Use `docs-writer` for larger doc changes in step 5.
```

New:
```
2. **Implement:** for each task in the spec, in order, run the agent the task names (default `implementer`; `supabase-engineer` for `supabase/` work; `native-mobile` for camera, on-device text recognition or other native modules) with the spec path and the task number. Use `docs-writer` for larger doc changes in step 5.
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run".
```

## Change 2: `.claude/agents/qa-tester.md`, step 3

Old:
```
3. For each acceptance criterion, run the test or manual step that proves it. Where possible, use the running app (Expo web via `npm run web`, which runs the asset-copy hook first, or a Supabase local stack) or call the Edge Function with curl.
```

New:
```
3. For each acceptance criterion, run the test or manual step that proves it. Where possible, use the running app (Expo web via `npm run web`, which runs the asset-copy hook first, or a Supabase local stack) or call the Edge Function with curl.
   - **Check which backend the app talks to.** Don't assume an already-running dev server (e.g. the user's on :8081) points at the local stack: the user may have pointed theirs at the hosted project, where new migrations aren't applied. Check the Supabase host in the served bundle (e.g. `curl -s` the bundle URL and `grep -o` for `127.0.0.1:54321` or `supabase.co`), never by reading `.env`. If it isn't local, start your own on a free port with local values passed inline: `node scripts/copy-tesseract-assets.mjs && set -a && eval "$(npx supabase status -o env)" && set +a && EXPO_PUBLIC_SUPABASE_URL="$API_URL" EXPO_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY" npx expo start --web --port 8082 --clear`. (Verify: that shell values override the root `.env`, and that real Google sign-in redirects back to that port; if not, report the sign-in part as a user check.) Leave the user's server running.
```

## Change 3: `.claude/agents/qa-tester.md`, step 2

Old:
```
2. Run the full test suite (`npm test -- --maxWorkers=4`) and the type-check in each repo the task touched. If a test fails only with a timeout, check `uptime`, then re-run that file on its own (`npx jest <file>`) before reporting; if it passes alone, report it as flaky under load with both outputs and the load average.
```

New:
```
2. Run the full test suite (`npm test -- --maxWorkers=4`) and the type-check in each repo the task touched. If a test fails only with a timeout, check `uptime`, then re-run that file on its own (`npx jest <file>`) before reporting; if it passes alone, report it as flaky under load with both outputs and the load average. If the suite or the type-check fails only in files the task didn't touch, another session may be editing them: check `git status` and the files' modification times, re-run once after a short wait, and if it still fails, report it as "outside this task, likely in progress elsewhere" with the file list. The task's own test files must still pass on their own.
```

## Change 4: `.claude/agents/implementer.md`

Old:
```
- Run the relevant tests and the type-check before you finish. Run single files with `npx jest <file>` while working and the full suite with `npm test -- --maxWorkers=4`; other agents may be testing at the same time. Don't report success if they fail; report the failure output.
```

New:
```
- Run the relevant tests and the type-check before you finish. Run single files with `npx jest <file>` while working and the full suite with `npm test -- --maxWorkers=4`; other agents may be testing at the same time. Don't report success if they fail; report the failure output. If a failure is only in files outside your task, another session may be mid-edit: re-run once after a short wait, and if it persists, report it with the file list as "outside this task". Don't fix or revert those files.
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: Google sign-in `server_error` was a bad secret plus a stale Supabase [area: process]"
- "2026-11-21: On a physical phone, `127.0.0.1` is the phone [area: expo]"
- "2026-11-19: EXPO_PUBLIC_ values are baked in; rebuild with --clear [area: expo]"
- "2026-11-24: Checks ran against an environment that wasn't the one assumed [area: process]"
- "2026-11-21: Parallel agents worked from a stale snapshot [area: process]"
- "2026-11-22: A docs agent reported a task as "not built" because it ran before that task landed [area: process]"
- "2026-11-22: Parallel Jest runs overloaded the machine; cap workers [area: testing]"
- "2026-11-24: Other sessions' half-finished edits broke whole-repo test and typecheck runs [area: testing]"
