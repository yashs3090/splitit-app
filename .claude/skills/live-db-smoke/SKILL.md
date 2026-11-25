---
name: live-db-smoke
description: Run SplitIt's app data layer against the live local Supabase as several throwaway users, to check RLS, database functions, claims and realtime end to end. Use after DB migrations land when app code was written against the spec (contract reconciliation), when QA needs a multi-user check, or when the user asks for a live or smoke test of bills/claims.
---

# Live multi-user smoke test (local only)

pgTAP checks the database from inside Postgres, and Jest uses fakes. This skill checks the real client calls, RLS and realtime together, as several real users.

## Safety rules
- **Local stack only.** Refuse if `API_URL` isn't `http://127.0.0.1:...` or `http://localhost:...`.
- **Keys stay in the process environment.** Never read, grep or write `.env*` files. Never print a key, write it to a file, or paste it into a report. Load them inline, in the same shell command that runs the script: `set -a && eval "$(npx supabase status -o env)" && set +a && node <script>.mjs`. `set -a` is required: the CLI (v3) prints plain `NAME="value"` lines, so without it the variables never reach `node`. The script reads exactly these variables: `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_SECRET`. It stops with "missing env" if any is empty (don't print them to debug).
- The service-role key is used **only** to create and delete the throwaway users (the auth admin API), and for checks that service_role is denied (e.g. writing audit rows). Every other check runs as a signed-in user with the anon key, because that's what the app does.
- Users are throwaway: unique emails like `smoke-<run-tag>-a@example.test`. Delete them at the end, even on failure (`finally`).

## Steps
1. Check Docker and the stack: `npm run db:status`. If it's down, say so and stop (report "not run", not passed). Apply pending migrations with `npx supabase migration up`. Don't `db:reset` unless the user agrees, because it wipes local data.
2. Write the script in the session scratchpad, not the repo (unless the user wants it committed). Use plain `.mjs` run with `node`, and load the app's `@supabase/supabase-js` with `createRequire('<app path>/package.json')` (`tsx` isn't a dependency). To use the app's real queries, read the column lists out of `lib/bills.ts` rather than retyping them.
3. Create users A (host), B and C with `admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name } })` on a service-role client (`persistSession: false, autoRefreshToken: false`). Email sign-in is off (`[auth.email] enabled = false`), so don't sign in. Instead, give each user a **locally signed JWT**: HS256, signed with `JWT_SECRET` using `node:crypto` HMAC-SHA256 over `base64url(header).base64url(payload)`, payload `{ sub: <user id>, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 600..3600 }` (adding `email` and `session_id` is fine). This only works against the local stack, whose JWT secret is known.
4. For each user, create a separate anon-key client with `auth: { persistSession: false, autoRefreshToken: false }` and `global: { headers: { Authorization: 'Bearer ' + token } }`. For realtime, also call `client.realtime.setAuth(token)` (private channels otherwise get the anon role). Use one channel per topic per client (`{ config: { private: true } }`), and `await removeChannel()` / `unsubscribe()` before re-subscribing or at the end. If a client needs no realtime, pass a no-op `realtime: { transport: class {} }` so it doesn't open a socket.
5. Run numbered checks. Each prints `PASS/FAIL <n> <what>` plus the error code on failure. Cover at least:
   - The host creates a bill; B and C join with the code; a non-participant D can't read it (expect `42501` or zero rows, as the spec says).
   - Only the host edits items; B and C get `42501`.
   - Each user claims and unclaims only their own claims; writing someone else's fails.
   - Every rule both the app and the DB enforce (e.g. the totals tolerance) is tested at the boundary: exactly at tolerance passes, 1¢ over fails, with the same input the `lib/` test uses.
   - Realtime: B sees A's change within a few seconds; an outsider gets nothing; after unsubscribe, no more events arrive.
   - Columns: co-participants see only the columns they're meant to (e.g. `display_name`, not the whole profile).
   - Activity events: each action writes exactly one event, and no client role (including service_role) can insert, update or delete one.
6. Clean up in `finally`: delete every created user with `admin.auth.admin.deleteUser(id)` and log any deletion error code. Then confirm none remain: list users with `admin.auth.admin.listUsers()` and count those whose email contains the run tag. The count must be 0; if not, report it as a FAIL. Print the totals line `N/M passed`.

## Report
The check table (number → PASS/FAIL → what was called and the error code), the totals line, the cleanup count (created, deleted, remaining = 0), anything not run and why, and any contract mismatch found (function argument, field name, rule disagreement). Mismatches become spec amendments, per `build-task`.
