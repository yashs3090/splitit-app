# Proposal: live-db-smoke runs the app's real TypeScript data layer, and cleans up when FKs restrict deletion

**Status: pending**

**Target:** `.claude/skills/live-db-smoke/SKILL.md` (Safety rules, the service-role bullet; Steps 2 and 6; Report)

**Promotion rules used:** (1) A multi-step workflow done by hand twice or more goes into a skill. The esbuild bundle was built by hand for T12 and again for the final Groups smoke run. (2) A rule that caused a wrong result gets reworded. Step 6's "delete every created user with `deleteUser`" can't work once a user is a group member with history, and the run's cleanup failed.

**Compatibility:** the pending `2026-11-26-dont-print-local-keys.md` changes only the first sentence of step 1. This proposal doesn't touch step 1, so the two can be applied in either order.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "The app's real TypeScript data layer ran in node through an esbuild bundle" [testing]: T12 (115/115) and the final smoke run (45/45, twice) ran `lib/groups.ts` and the group view models, bundled with esbuild, with a `./supabase` proxy shim (one client per user through `globalThis`) and stubs for `react-native` and `expo-*`.
- 2026-11-27 "The live smoke run couldn't delete its throwaway users, because group membership blocks deletion" [testing]: `group_members.user_id → profiles on delete restrict` (A1.9), and a member with history can't leave (C-G10). `deleteUser` failed, and cleanup needed superuser `psql`, deleting child-first.
- 2026-11-27 "Group members can't delete their account…" [rls]: the same FK, seen as a production risk (now in `docs/before-production.md`).
- 2026-11-27 "The esbuild live-smoke harness was reused in minutes" [testing] (added in the group claim status retro): QA bundled `lib/groups.ts` and `lib/groupClaimStatus.ts` the same way for criterion 37 (47/48; the miss was QA's own expectation). This is the third use, still rebuilt from the log each time.
- Background: 2026-11-22 "Live multi-user smoke tests with throwaway users, done by hand twice" (why the skill exists); 2026-11-24 "A pgTAP test counted all claims and failed on real local data" (the local DB holds the user's real data, so cleanup must touch only the run's rows).

## Change 1: Safety rules, the service-role bullet

Old:
```
- The service-role key is used **only** to create and delete the throwaway users (the auth admin API), and for checks that service_role is denied (e.g. writing audit rows). Every other check runs as a signed-in user with the anon key, because that's what the app does.
```

New:
```
- The service-role key is used **only** to create and delete the throwaway users (the auth admin API), and for checks that service_role is denied (e.g. writing audit rows). Every other check runs as a signed-in user with the anon key, because that's what the app does.
- The database superuser is used **only** in cleanup (step 6), and only on rows tied to this run's user ids, found by the run tag in their emails. The local DB holds the user's real data: never write a delete that isn't filtered to the run, and never disable a trigger or constraint to make cleanup pass.
```

## Change 2: Steps, step 2, its last sentence

Old:
```
To use the app's real queries, read the column lists out of `lib/bills.ts` rather than retyping them.
```

New:
```
To use the app's real queries, call the app's own data-layer functions rather than retyping them. Bundle the `lib/` module (e.g. `lib/groups.ts` or `lib/bills.ts`, plus any view models you check) with esbuild, which is already a dependency: `npx esbuild <entry>.ts --bundle --platform=node --format=esm --outfile=<scratchpad>/lib.mjs`, run from the repo root so packages resolve from the app's `node_modules`, with two plugins:
   - **Client shim:** resolve `./supabase` (the import of `lib/supabase.ts`) to a scratchpad shim. The shim exports `supabase` as a `Proxy` that forwards every property to `globalThis.__smokeClient`. The script sets `globalThis.__smokeClient` to user A's, B's or C's client (step 4) before each call, so one bundle acts as any user.
   - **Native stubs:** resolve `react-native` and `expo-*` to small stubs (e.g. `Platform.OS = 'web'`, no-op storage). If a stub is reached at run time in a way that changes a result, the check fails loudly rather than quietly using a fake.
   If esbuild can't bundle the module (a native-only import that can't be stubbed), fall back to reading the column lists out of the `lib/` file, and say so in the report.
```

## Change 3: Steps, step 6

Old:
```
6. Clean up in `finally`: delete every created user with `admin.auth.admin.deleteUser(id)` and log any deletion error code. Then confirm none remain: list users with `admin.auth.admin.listUsers()` and count those whose email contains the run tag. The count must be 0; if not, report it as a FAIL. Print the totals line `N/M passed`.
```

New:
```
6. Clean up in `finally`: delete every created user with `admin.auth.admin.deleteUser(id)` and log any deletion error code. Some rows block that on purpose: `group_members.user_id` references `profiles` `on delete restrict`, and a member with history can't leave a group through the app. If any deletion fails (or the run created groups), clean up as the database superuser in the same shell, with keys still inline: `psql "$DB_URL" -v tag=<run-tag> -f <scratchpad>/cleanup.sql`. `DB_URL` comes from the same `supabase status -o env`. If `psql` isn't installed, use `docker exec -i <db container> psql -U postgres`; `docker ps` shows the container's name. `cleanup.sql` runs in one transaction:
   - Collect the run's user ids from `auth.users` where the email matches `smoke-<run-tag>-%@example.test`, and the groups whose members are all run users. If a run user shares a group or bill with someone outside the run, stop, roll back and report it; don't delete it.
   - Delete child rows first, then parents: take the order from the foreign keys (`select conrelid::regclass, confrelid::regclass, confdeltype from pg_constraint where contype = 'f'`), not from memory. Delete parents (groups, bills) so that `on delete cascade` removes append-only event rows, whose triggers block direct deletes. Delete the run users' profiles and `auth.users` rows last.
   Then confirm none remain: list users with `admin.auth.admin.listUsers()` and count those whose email contains the run tag. Also count the run's rows that are left in profiles, groups, group memberships, bills and bill participants. Every count must be 0; if not, report it as a FAIL. Print the totals line `N/M passed`.
```

## Change 4: Report

Old:
```
the cleanup count (created, deleted, remaining = 0),
```

New:
```
the cleanup count (created, deleted, remaining = 0 for users and for each table counted in step 6, and whether superuser cleanup was needed and why),
```

## What this changes for you
Live checks will call the same functions the app calls, so a query that drifts from the app gets caught instead of retyped. Throwaway users from a run that joined a group will be cleaned up, and only those rows: your own local bills and groups aren't touched.
