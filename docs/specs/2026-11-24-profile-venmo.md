# Profile + Venmo: a profile screen and a stored Venmo username

Date: 2026-11-24. Milestone: "Profile + Venmo (S, before M3; user decision 2026-11-24)" in `docs/plans/bill-splitting-app-2026-11-19.md`.
Repo: `splitit-app` only (ADR 0011). Database changes go in `supabase/migrations/` and `supabase/tests/database/`.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already running) | new column, constraint, grants, two functions | $0, already set up |
| Google sign-in (already configured) | signing in to reach the Profile screen | $0, already set up |
| Venmo | nothing. We store a username string only: no Venmo API, no Venmo account, no payment link in this slice | $0 |

Nothing new to sign up for.

## Goal
A signed-in user can see their name, save or change their Venmo username, and sign out from one Profile screen. New users get one skippable nudge to add their Venmo. That way, when M3 builds "pay the payer on Venmo", the payer's handle is already stored and their co-participants can read it.

## User decisions (2026-11-24, fixed)
1. A Profile screen under `app/(app)/` showing the display name, an editable Venmo username, and sign out. It has a clearly marked spot for bill history later; history isn't built.
2. An optional, skippable "Add your Venmo so friends can pay you" prompt, shown once after first sign-in. It must not interrupt the resume-after-sign-in flow into `/b/<code>`.
3. New column `profiles.venmo_username`, nullable, stored without a leading `@` (the app strips one if typed). The same rule is enforced in `lib/` and in a DB check constraint, with Jest and pgTAP tests on the same boundary cases.
4. Readable by the owner and by co-participants (same audience as `display_name`). Updatable only by the owner, through a per-column UPDATE grant. RLS plus explicit grants; denied operations fail with `42501`.
5. Out of scope: settle screen, payment links, payer selection, paid status (M3), bill history, PayPal/Cash App.
6. Screens stay simple and uncluttered.

## In scope
- DB: `venmo_username` column + format check, `venmo_prompt_dismissed_at` column (owner state, never client-readable), column grants, a trigger, and two small `security definer` functions (`venmo_prompt_pending`, `dismiss_venmo_prompt`). pgTAP tests.
- `lib/venmo.ts`: the one app-side normalizer and validator.
- `lib/profile.ts`: read own profile, save Venmo username, read and dismiss the prompt state.
- `lib/signOut.ts`: the existing sign-out steps moved out of the home screen so the Profile screen and home share them.
- `app/(app)/profile.tsx`: the Profile screen.
- The prompt and the home entry point to Profile (Task 5 was blocked on Q1 and Q2; both answered 2026-11-24).
- Learning notes and `docs/before-production.md` items.

## Out of scope (cut)
- Everything M3: settle screen, Venmo links, payer selection, "I paid", host undo.
- Showing anyone else's Venmo username anywhere in the UI. M3 adds the embed; this slice only proves the DB lets co-participants read it (criteria 13, 33).
- **Display-name editing (PM call: cut).** The DB already allows it (`grant update (display_name)`, 1–50 chars), but it would need a second shared rule (trim, blank handling) and its own boundary tests, and nobody asked for it. The Profile screen shows the name read-only. Listed in "Later".
- Bill history (a code marker only, see Task 4).
- PayPal / Cash App handles.
- Checking with Venmo that a username exists (no API; see Risks).
- Realtime on profiles. `profiles` isn't in the realtime publication, and nothing here needs live updates.

## Design decisions

### D1. How "shown once" is remembered: in the database (PM decision)
The prompt state is a nullable timestamp, `profiles.venmo_prompt_dismissed_at`.
- **Why the DB rather than a device flag:** "once after first sign-in" is about the account, not the device. This user group signs in on web (the invite flow is web-first) and on a phone. A device flag would show the prompt again on every new browser or device, after a reinstall, and whenever web storage is cleared. The DB costs one column, one trigger and two small functions.
- **Why the column isn't client-readable:** a column SELECT grant applies to every row RLS lets you see, and co-participants can see your row. Granting SELECT on this column would show co-participants when you dismissed a prompt. So clients get **no** grant on it, and read and write it only through two `security definer` functions that touch the caller's own row (ADR 0013's pattern).
- **Answered means never again:** the prompt is pending only while `venmo_username is null and venmo_prompt_dismissed_at is null`. A trigger stamps `venmo_prompt_dismissed_at` the first time `venmo_username` becomes non-null, so clearing the username later doesn't bring the prompt back.
- **Existing accounts** (created before this migration) have both columns null, so they see the prompt once, next time it would show. That's intended.

### D2. Shared contract: the Venmo username rule (defined once; Task 1 and Task 2 both point here)

**Stored value:** `null`, or a string matching `^[A-Za-z0-9_-]{5,30}$` (ASCII letters, digits, hyphen, underscore; 5 to 30 characters). The case is kept exactly as typed. Empty string, `@`, spaces, dots and non-ASCII letters are never stored.

**Source:** Venmo's help page ["Check or edit your username"](https://help.venmo.com/cs/articles/check-or-edit-your-username-vhel208) says: "Your Venmo username must be between 5 and 30 characters (no special characters other than - and _ )." Verified 2026-11-24.
**Unverified, chosen to be permissive but safe:**
- ASCII-only letters. The page doesn't say whether accented letters are allowed; we reject them.
- No rule on the first character or all-digit names. Venmo's page doesn't state one, so we allow them.
- Case-insensitivity on Venmo's side. We store the case as typed and never compare case-insensitively.

Every allowed character is URL-safe, so M3 can put the value into a link without escaping it. That's the "safe" part.

**App normalization (`lib/venmo.ts` only), in this order:**
1. Trim leading and trailing whitespace (`String.prototype.trim`).
2. If the result starts with `@`, remove exactly **one** `@`.
3. If the result is empty, the outcome is `{ ok: true, value: null }` (clear the username).
4. If it matches the stored-value regex, the outcome is `{ ok: true, value }`.
5. Otherwise the outcome is `{ ok: false }`. One fixed message for every failure: "Venmo usernames are 5–30 letters, numbers, - or _." (Starting copy; the design pass may reword it.)

**DB rule:** `constraint profiles_venmo_username_format check (venmo_username is null or venmo_username ~ '^[A-Za-z0-9_-]{5,30}$')`. Verify: Postgres bracket ranges can depend on collation. The constraint must reject `josé1` and accept `Jane-Doe_99` (both in the table below). If the range form misbehaves, the supabase-engineer may spell the classes out (or use `COLLATE "C"`), as long as every row below still holds.

**Shared boundary cases.** Both `lib/venmo.test.ts` and the pgTAP file test every row. The "DB (stored as-is)" column is what the check constraint does when that exact string is written. The "App input → outcome" column is what `normalizeVenmoUsername` returns.

| # | Input | App input → outcome | DB (stored as-is) |
|---|---|---|---|
| B1 | `abcd` (4) | invalid | reject `23514` |
| B2 | `abcde` (5) | `abcde` | accept |
| B3 | 30 × `a` | same | accept |
| B4 | 31 × `a` | invalid | reject |
| B5 | `Jane-Doe_99` | `Jane-Doe_99` (case kept) | accept |
| B6 | `12345` | `12345` | accept |
| B7 | `abc.de` | invalid | reject |
| B8 | `abc de` | invalid | reject |
| B9 | `josé1` | invalid | reject |
| B10 | `@abcde` | `abcde` | reject (a stored `@` is never valid) |
| B11 | `  @abcde  ` | `abcde` | reject (spaces/`@`) |
| B12 | `@@abcde` | invalid (one `@` stripped, `@abcde` left) | reject |
| B13 | `@abcd` | invalid (4 after strip) | reject |
| B14 | `` (empty), `   `, `@` | `null` (clear) | empty string: reject; `null`: accept |
| B15 | `abcde` + newline (`E'abcde\n'`) | `abcde` (trim removes it) | reject |

### D3. Shared contract: functions and columns (Task 1 defines them, Task 3 calls them)

| Name | Shape | Who | Behavior |
|---|---|---|---|
| `profiles.venmo_username` | `text null`, D2 check | SELECT: `authenticated` (RLS: own row or co-participant). UPDATE: `authenticated`, column-level, RLS own row only | — |
| `profiles.venmo_prompt_dismissed_at` | `timestamptz null` | **no** client grant at all | set by the trigger and by `dismiss_venmo_prompt` |
| `public.venmo_prompt_pending()` | `returns boolean`, no args, `stable security definer set search_path = ''` | execute: `authenticated` only | `true` iff the caller's profile row has `venmo_username is null and venmo_prompt_dismissed_at is null`; `false` otherwise (including no row) |
| `public.dismiss_venmo_prompt()` | `returns void`, no args, `security definer set search_path = ''` | execute: `authenticated` only | sets the caller's `venmo_prompt_dismissed_at = coalesce(venmo_prompt_dismissed_at, now())`; idempotent; touches no other row or column |
| trigger on `profiles` | `before update of venmo_username` | — | if `new.venmo_username is not null and new.venmo_prompt_dismissed_at is null`, set it to `now()`. The function lives in `private`, with execute revoked from `public, anon, authenticated` |

App calls (Task 3), exactly:
- Read own: `supabase.from('profiles').select('display_name, venmo_username').eq('id', <my id>).single()`.
- Save: `supabase.from('profiles').update({ venmo_username: <normalized value or null> }).eq('id', <my id>).select('venmo_username')`. Exactly one returned row counts as saved, and the returned value is the new baseline. Zero rows is an error.
- `supabase.rpc('venmo_prompt_pending')` and `supabase.rpc('dismiss_venmo_prompt')`.

When M3 embeds the handle, it follows the existing FK-named pattern (`profiles!bills_host_id_fkey(display_name, venmo_username)` / `profiles!bill_participants_user_id_fkey(...)`, see `lib/bills.ts:70-72`). Criterion 33 checks that this embed works for a co-participant now.

### D4. Navigation stays in one place
The Profile screen and the prompt never navigate after sign-in. `app/_layout.tsx` (`ResumeAfterSignIn`) is the only post-sign-in navigator (lessons log, "Only the single resume effect navigates after sign-in") and isn't edited in this slice unless the user picks Q2 option C.

## Tasks
Order: 1 ‖ (2 → 3 → 4), then 6 (reconciliation), then 5 (after Q1/Q2), then 7. Task 1 runs in parallel with 2–3 against the D2/D3 contract. **The main session assigns the migration timestamp** (suggested `20261124NNNNNN_profile_venmo.sql`, later than `20261122085802`).

Files other sessions are editing right now, which no task here touches: `lib/receiptText.ts`, `lib/scanPipeline/**`, `lib/webOcr*.ts`, `lib/prepareImage*.ts`, `app/(app)/scan.tsx`.

### Task 1: DB column, rule, grants, functions (agent: supabase-engineer)
Files: `supabase/migrations/<assigned>_profile_venmo.sql` (new), `supabase/tests/database/profile_venmo.test.sql` (new). Optionally reword the description strings at `supabase/tests/database/profiles.test.sql:65` and `supabase/tests/database/m2_review_fixes.test.sql:59` ("id and display_name only"), which still pass but would now be inaccurate; don't change their assertions.
- Add both columns per D3, and the check constraint per D2.
- `grant select (venmo_username) on public.profiles to authenticated;` `grant update (venmo_username) on public.profiles to authenticated;`. Add nothing for `venmo_prompt_dismissed_at`. Keep the existing `(id, display_name)` SELECT and `display_name` UPDATE grants as they are. The existing policies (`profiles_select_own_or_co_participant`, `profiles_update_own`) already scope rows; add no new policy.
- Add the trigger and the two functions per D3, with `revoke execute ... from public, anon` and `grant execute ... to authenticated`.
- Apply to the user's local DB with `npx supabase migration up` (**not** `db reset`). `npm run db:test` runs the pgTAP suite in a rolled-back transaction.

### Task 2: the Venmo rule in `lib/` (agent: implementer)
Files: `lib/venmo.ts` (new), `lib/venmo.test.ts` (new).
- Export `VENMO_USERNAME_PATTERN` (the D2 regex), `normalizeVenmoUsername(input: string): { ok: true; value: string | null } | { ok: false; message: string }` and `VENMO_USERNAME_ERROR` (the fixed copy). Nothing else in the app defines the pattern.

### Task 3: profile data layer and shared sign-out (agent: implementer)
Files: `lib/profile.ts` (new), `lib/profile.test.ts` (new), `lib/signOut.ts` (new), `lib/signOut.test.ts` (new). Extend `test-utils/fakes.ts` only if `update`/`single` chaining is missing.
- `getMyProfile(userId)`: `{ ok: true, displayName: string | null, venmoUsername: string | null } | { ok: false }`.
- `saveVenmoUsername(userId, rawInput, current)`: runs `normalizeVenmoUsername`. It returns `{ ok: false, reason: 'invalid' }` without any network call when the input is invalid, and `{ ok: true, value: current, changed: false }` without a network call when the normalized value equals `current`. Otherwise it makes the D3 update. Errors map to fixed reasons: `23514` → `'invalid'`, `42501` or zero rows → `'not_allowed'`, anything else → `'error'`.
- `isVenmoPromptPending()`: `rpc('venmo_prompt_pending')`. Any error or non-boolean returns `false` (fail closed: never nag on an error). `dismissVenmoPrompt()`: `rpc('dismiss_venmo_prompt')` → `{ ok: boolean }`.
- No module-level state or cache in `lib/profile.ts`, so nothing survives sign-out.
- `signOutThisDevice()`: moves the body of `onSignOut` from `app/(app)/index.tsx:56-62` unchanged in behavior (`clearScanResult()`, `clearPendingInvite(storage)`, `supabase.auth.signOut({ scope: 'local' })`) and returns `{ ok: boolean }`. Task 5 switches home to it.

### Task 4: Profile screen (agent: implementer, then a `ui-ux-designer` pass)
Files: `app/(app)/profile.tsx` (new), `__tests__/profile.test.tsx` (new).
- Layout, top to bottom, nothing else:
  - a Back control (`router.canGoBack() ? router.back() : router.replace('/')`);
  - "Profile" header;
  - the name: `displayName` from the DB, else `displayNameFor(session.user)` from `lib/displayName.ts`;
  - a `TextField` (`components/ui/TextField.tsx`) labelled "Venmo username", with `prefix="@"`, `autoCapitalize="none"`, `autoCorrect={false}`, and a short hint ("Friends pay you here.", starting copy);
  - one Save button;
  - a ghost "Sign out" button at the bottom.
- A code comment marker exactly `BILL HISTORY (v1)` in the JSX, at the spot where history will go (between the Venmo section and Sign out). No visible placeholder.
- States:
  - loading: spinner;
  - load error: "Couldn't load your profile." plus "Try again";
  - saving: button disabled;
  - saved: "Saved" text, announced to screen readers;
  - invalid input: the D2 message on the field, no network call;
  - save error: fixed copy, the typed value stays, the button re-enables;
  - sign-out error: "Sign-out failed. Please try again."
- Save is disabled when the normalized input equals the saved value. The screen does no validation of its own beyond calling `lib/`.

### Task 5: home entry point and the Venmo prompt (agent: implementer, then `ui-ux-designer`). **Blocked on Q1 and Q2.**
Files: `app/(app)/index.tsx` (**small edit, flagged:** coordinator asked to prefer `app/(app)/_layout.tsx`, see note), `components/VenmoPrompt.tsx` (new, only for Q2 option A or B), `__tests__/inviteFlow.test.tsx` (test 26 signs out via whichever screen Q1 picks), `__tests__/venmoPrompt.test.tsx` (new).
- **Why `index.tsx` and not `_layout.tsx`:** every screen in `(app)` runs with `headerShown: false` and draws its own top bar (`app/(app)/_layout.tsx:10`, home's header at `app/(app)/index.tsx:70-75`). A native header from the layout would show on home only, look different from every other screen, and double home's top padding, which would mean editing `index.tsx` anyway.
- The edit to `index.tsx` is limited to these three things (about 20 lines changed):
  - one "Profile" button in the existing header `View`;
  - one `<VenmoPrompt />` line (Q2 A/B);
  - the Q1 sign-out change: either remove the home sign-out button and its handler, or switch the handler to `signOutThisDevice()`.
- `VenmoPrompt`, under Q2 option A:
  - It calls `isVenmoPromptPending()` on mount and renders nothing unless the result is `true`.
  - The card reads "Add your Venmo so friends can pay you" and has two buttons: "Add Venmo" (opens `/profile`) and "Not now" (calls `dismissVenmoPrompt()` and hides the card at once, even if the call fails).
  - When home comes back into focus, it re-checks (`useFocusEffect`), so the card disappears after a save on Profile.

### Task 6: live reconciliation against the local DB (agent: implementer, using the `live-db-smoke` skill)
No repo files beyond what the skill writes to the scratchpad.
- Run once Tasks 1 and 3 are done.
- Mint throwaway local users A (host), B (joined A's bill) and C (no shared bill). Keys stay in the process environment only.
- Run criteria 31–34 through the real `@supabase/supabase-js` client and `lib/profile.ts`.

### Task 7: docs (agent: docs-writer; runs after Tasks 1–6 land)
Files: `docs/learning/concepts/row-level-security.md`, `docs/learning/concepts/database-functions.md`, `docs/learning/decisions/0007-payment-deep-links.md`, `docs/before-production.md`. Re-read each before editing (parallel-work lesson).
- `row-level-security.md`: add a section explaining that a column grant applies to every row RLS shows you, so owner-only data (`venmo_prompt_dismissed_at`) can't be a column grant when co-participants can see the row. Owner-only state goes through `security definer` functions instead. Link `file:line`.
- `database-functions.md`: add `venmo_prompt_pending` / `dismiss_venmo_prompt` as the small example of owner-only reads and writes.
- ADR 0007: append a dated note covering how the handle is stored (no `@`, the D2 rule with its verified and unverified parts), and that every allowed character is URL-safe for M3's link.
- `docs/before-production.md`: add the items under "Before-production items" below.

## Acceptance criteria
Run the DB checks with `npm run db:test`. Run Jest with `npm test -- --maxWorkers=4` or `npx jest <file>`.

### Database (Task 1, pgTAP in `supabase/tests/database/profile_venmo.test.sql`)
1. `public.profiles` has `venmo_username text` (nullable) and `venmo_prompt_dismissed_at timestamptz` (nullable). Existing rows have both null after the migration.
2. For each row B1–B15 of the D2 table, writing the "DB (stored as-is)" input into `venmo_username` (as the owner, through the client role) gives the result in that column: accepted rows store the exact string, rejected rows fail with `23514`. `null` is accepted.
3. `has_column_privilege('authenticated', 'public.profiles', 'venmo_username', 'SELECT')` and `... 'UPDATE'` are both true.
4. `authenticated` has neither SELECT nor UPDATE on `venmo_prompt_dismissed_at`. `anon` has no privilege on any column of `profiles`. `table_privs_are` for `authenticated` and `anon` is still empty (no table-level grants).
5. The existing grants are unchanged: SELECT on `id`, `display_name`; UPDATE on `display_name` only. There is still no SELECT on `created_at` / `updated_at`, and no INSERT or DELETE.
6. As A: `update profiles set venmo_username = 'alice-1' where id = A` returns A's row, and the value is stored.
7. As A: `update profiles set venmo_username = 'hacked' where id = B` affects **0 rows** (RLS filters the row; this is Postgres' behavior for an RLS-hidden row, same as M0 criterion 10), and B's value is unchanged when checked as superuser.
8. As A: `select venmo_prompt_dismissed_at from profiles` fails with `42501`. `update profiles set venmo_prompt_dismissed_at = now() where id = A` fails with `42501`.
9. As anon: selecting `venmo_username` fails with `42501`, updating it fails with `42501`, and `select public.venmo_prompt_pending()` and `select public.dismiss_venmo_prompt()` both fail with `42501`.
10. As A (fresh, both null): `venmo_prompt_pending()` is `true`. After `dismiss_venmo_prompt()` it's `false`. Calling dismiss a second time leaves `venmo_prompt_dismissed_at` at its first value (idempotent).
11. As A (fresh): setting `venmo_username` to a valid value makes `venmo_prompt_pending()` return `false`, and `venmo_prompt_dismissed_at` is non-null (the trigger set it even though A has no UPDATE grant on it). Setting `venmo_username` back to `null` keeps `venmo_prompt_pending()` at `false`.
12. `dismiss_venmo_prompt()` as A changes only A's row. B's `venmo_prompt_dismissed_at` is still null and `venmo_prompt_pending()` as B is still `true`. Neither function changes `venmo_username` or `display_name`.
13. Co-participant read: with A hosting a bill that B joined (through the real `create_bill` / `join_bill`), B can `select venmo_username from profiles where id = A` and gets A's value. C (no shared bill) gets 0 rows for A. A gets their own row.
14. Both functions are `security definer` with `proconfig = {search_path=""}`. Execute is granted to `authenticated` and not to `anon` or `public`. The trigger function's execute is revoked from `public`, `anon` and `authenticated`.
15. The existing `profiles.test.sql`, `m2_review_fixes.test.sql` and all other pgTAP files still pass.

### `lib/venmo.ts` (Task 2)
16. `lib/venmo.test.ts` covers every row B1–B15 of the D2 table with the "App input → outcome" result, using the same literal inputs as the pgTAP test.
17. Every invalid outcome carries `VENMO_USERNAME_ERROR`, the same single message.
18. The pattern is defined once in app code: `grep -rnF 'A-Za-z0-9_-]{5,30}' app components lib` matches only `lib/venmo.ts`. (*Amended 2026-11-24:* the original grep `'A-Za-z0-9_-'` also matched the unrelated invite-code check in `lib/pendingInvite.ts:12`; wording fix only, behavior unchanged.)

### `lib/profile.ts` and `lib/signOut.ts` (Task 3)
19. `getMyProfile` makes the exact D3 read (columns `display_name, venmo_username`, filtered by id, `single`) and maps an error to `{ ok: false }`.
20. `saveVenmoUsername` with input `"  @Jane-Doe_99 "` sends `update({ venmo_username: 'Jane-Doe_99' })` with `.eq('id', userId)` and `.select('venmo_username')`, and returns the value the fake DB returned.
21. `saveVenmoUsername` with an empty or whitespace-only input sends `update({ venmo_username: null })` (clear).
22. `saveVenmoUsername` with an invalid input (B1, B7, B12) makes **no** `from()` call and returns `reason: 'invalid'`. With the normalized value equal to `current`, it makes no call and returns `changed: false`.
23. Error mapping: a DB error `23514` → `'invalid'`; `42501` → `'not_allowed'`; zero returned rows → `'not_allowed'`; any other error → `'error'`. Each case has a test.
24. `isVenmoPromptPending` returns `true` only when the RPC returns `data === true`. An RPC error, `null` or a non-boolean returns `false`. `dismissVenmoPrompt` calls `rpc('dismiss_venmo_prompt')` with no args.
25. `signOutThisDevice` calls `clearScanResult`, clears the pending invite and calls `signOut({ scope: 'local' })`. It returns `{ ok: false }` when `signOut` errors.
26. Profile reads and writes go through `lib/profile.ts` only: `grep -rnE "from\(['\"]profiles['\"]\)" app components lib` matches only `lib/profile.ts` (and its test). `grep -rn 'venmo_prompt_dismissed_at' app components lib` prints nothing. (Run on 2026-11-24: both match nothing today. The existing embeds `profiles!…(display_name)` in `lib/bills.ts` and `lib/activity.ts` use `.from('bills')` / `.from('bill_participants')` and don't match.)

### Profile screen (Task 4, router tests in `__tests__/profile.test.tsx`)
27. Signed out, opening `/profile` redirects to `/sign-in`. Signed in, `/profile` shows the DB display name and the saved Venmo username (without `@` in the field value). With a null DB display name, it shows `displayNameFor(session.user)`.
28. Typing `@jane-doe` and pressing Save calls the D3 update with `jane-doe` and shows "Saved". Typing `abc` shows the D2 message and makes no DB call. A failed save keeps the typed text, shows the fixed error and re-enables Save. Save is disabled while the input normalizes to the saved value.
29. A load error shows "Couldn't load your profile." and "Try again" refetches. Pressing "Sign out" on Profile ends on `/sign-in` with the session and pending invite cleared (same assertions as `inviteFlow` test 26).
30. Accessibility and layout: the Venmo field has `accessibilityLabel` "Venmo username". Save, Sign out and Back have labels, and a hint where the result isn't obvious. "Saved" and errors are announced (live region or `accessibilityRole="alert"`). The file contains the marker `BILL HISTORY (v1)` and no visible history UI. The `ui-ux-designer` pass is recorded in the implementer's report.

### Live reconciliation (Task 6, live local DB, throwaway users)
31. As A through `lib/profile.ts`: save `"@Alice_1"`. `getMyProfile` then returns `venmoUsername: 'Alice_1'`, and `isVenmoPromptPending()` returns `false`.
32. As A: a raw client update of `venmo_username` to `'@bad'` (bypassing `lib/venmo.ts`) gets error code `23514`. A raw select of `venmo_prompt_dismissed_at` gets `42501`.
33. As B (joined A's bill): `from('bills').select('id, host:profiles!bills_host_id_fkey(display_name, venmo_username)').eq('id', <A's bill>)` returns A's `venmo_username`. As C, the same query returns no rows.
34. As C: `from('profiles').update({ venmo_username: 'hacked1' }).eq('id', A).select('venmo_username')` returns 0 rows, and A's value is unchanged. (*Amended 2026-11-24, Task 6, approved by the user 2026-11-24:* the original bare `.select()` sends `select=*`, and `RETURNING *` needs SELECT on every column; clients have no SELECT on `created_at`, `updated_at` or `venmo_prompt_dismissed_at`, so it fails with `42501` for every caller, the owner included. The write is blocked either way and A's value stays unchanged. The amended form is the D3 save shape that `lib/profile.ts` uses. Wording fix only; behavior unchanged.)

### Home and prompt (Task 5; final wording depends on Q1/Q2)
35. From home, a "Profile" control (with `accessibilityLabel`) opens `/profile`. Q1: if Profile-only, home has no "Sign out" button; if both, home's sign-out calls `signOutThisDevice`. In either case `inviteFlow` test 26 passes via the chosen screen.
36. (Option A) When `venmo_prompt_pending` is `true`, home shows "Add your Venmo so friends can pay you" with "Add Venmo" and "Not now". "Not now" calls `dismiss_venmo_prompt` and the card disappears. When it's `false` or errors, no card shows.
37. Invite resume isn't interrupted: with `venmo_prompt_pending` faked `true` and a pending invite saved, signing in lands on `/bills/<id>` (the existing resume path). The prompt text isn't on screen, and no route other than the resume effect's `router.replace` runs. All existing `__tests__/inviteFlow.test.tsx` tests pass.
38. `app/_layout.tsx` isn't modified (under Q2 option C this criterion is replaced by a test per resume branch).

### Whole-slice gates
39. `npm run typecheck` passes. `npm test -- --maxWorkers=4` passes. `npm run db:test` passes.
40. Web: `npm run web`, sign in, open Profile, save a Venmo username, reload the page: the saved value is shown. Then sign out. Native: the same steps on the **iOS simulator** (which reaches the Mac's `127.0.0.1:54321`). **A physical iPhone check is blocked**: on the phone, `127.0.0.1` is the phone itself, so the check waits for the friend-test deploy slice (hosted Supabase) or the Mac's LAN IP plus matching Supabase/Google redirect URLs.
41. No web bundle contains a secret key marker: after `npm run export:web`, `grep -rE "service_role|sb_secret_" dist/` prints nothing (the CLAUDE.md leak check).

## Before-production items (Task 7 adds them to `docs/before-production.md`)
- **§6 Privacy:** the Venmo username is visible to everyone who shares a bill with you. Anyone with an invite link can join, so anyone the link reaches can read the host's handle. List "payment username shared with bill participants" in the privacy policy and the store privacy forms. Decide whether that's acceptable once links leave the friend group.
- **§4 Database:** the Venmo username rule is partly unverified (ASCII-only letters, no first-character rule). Re-check Venmo's help page before launch and loosen or tighten both sides together (D2). A real user whose handle the rule rejects can't save it.
- **§4 Database:** `profile_venmo.test.sql` and the new functions must pass on the hosted project (`npx supabase db push`, then pgTAP).
- **§6 Privacy:** account deletion already cascades the profile, so the Venmo username goes with it. Note this in the deletion item.

## Risks
- **Wrong handle, wrong person paid (M3).** We can't check that a username exists on Venmo. A typo here sends friends' money to a stranger in M3. M3 should show the handle on the settle screen before the link opens. Noted for the M3 spec; nothing is built here.
- **Unverified parts of the rule** (D2) could reject a real handle. The rule is permissive inside Venmo's stated limits, and both sides change together if it's wrong.
- **Trigger and column privilege.** Criterion 11 checks that a BEFORE trigger can set a column the caller has no UPDATE grant on. This is expected Postgres behavior; verify it, and if it fails the supabase-engineer reports back rather than adding a grant.
- **Home edit vs. coordinator preference.** Task 5 edits `app/(app)/index.tsx` (about 20 lines). Nothing in the other session's file list includes it, but the main session should check before starting Task 5.

## Open questions (the user decides; Task 5 waits on both)

**Q1. Where does "Sign out" live?** *Answered 2026-11-24 by the user: option A, Profile only.*
- A. **Profile only (recommended).** Home loses its Sign out button. One place, a cleaner home. Costs one extra tap to sign out.
- B. Both home and Profile. Nothing moves for people used to it, but there are two identical controls.

**Q2. What does the "Add your Venmo" prompt look like?** *Answered 2026-11-24 by the user: option A, a small card on home with "Add Venmo" (opens Profile) and "Not now".*
- A. **A small card on home with "Add Venmo" (opens Profile) and "Not now" (recommended).** It never interrupts anything, including the invite flow, and reuses the one Venmo form. "Once" means it stays until the user taps Not now or saves a username, not one glance.
- B. The same card with the Venmo field inline. One less tap, but it duplicates the form and its error states on home.
- C. A one-time full screen right after sign-in (Save / Skip), shown only when there's no pending invite. Closest to the literal "after first sign-in". It adds a branch and a DB round trip to the single resume effect in `app/_layout.tsx`. People who first sign in through an invite need a rule too (show it on their next sign-in, or never).

## Later (not this slice)
- Display-name editing (the DB grant exists; it needs a shared trim/blank rule and boundary tests).
- Bill history at the `BILL HISTORY (v1)` marker.
- PayPal / Cash App handles (same pattern: one column, one shared rule).
