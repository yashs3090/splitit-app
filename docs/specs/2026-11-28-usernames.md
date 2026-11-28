# Usernames: groundwork (DB column, set_username, lib rules)

Date: 2026-11-28 · Status: ready to build · ADR: 0026 (stub at `docs/learning/decisions/0026-usernames.md`, filled in by T3)

**Scope note.** The user narrowed this on 2026-11-28 to groundwork only: "just create the framework to allow for it to happen ... like creating username, we will implement the feature later, don't deep dive into it". Screens, the required gate, search and friends are listed under **Later** and are not built here.

## Providers, accounts and costs

| Provider / account | Needed for | Setup cost |
|---|---|---|
| None new | Uses the existing local Supabase stack and Jest | $0 |

## Goal

Every user can later have a unique `@handle`, so two "Yash Saraiya"s can be told apart. This slice adds the stored field, the one safe way to set it and the shared rule, so the gate and the pickers can be built later without changing the database again.

## In scope

- `profiles.username`: nullable, stored lowercase without `@`, format and reserved-word check constraints, and a unique index on `lower(username)`.
- `public.set_username(p_username text)`: a security-definer RPC with distinct errors for taken, reserved and invalid.
- Read access exactly like `display_name`: the owner, co-participants and co-members. Anon gets nothing.
- `lib/username.ts`: the rule (contract **V**), the normalizer (**N**), the suggestion helpers (**S**) and the error copy.
- `lib/profile.ts`: `getMyUsername` and `setUsername`.
- ADR 0026 and the `docs/before-production.md` items.

## Out of scope (see Later)

The "Pick your username" gate, the account-screen editor, `@handle` in Add people, Who paid, group members and Settle, search and exact lookup, friends and friend requests. No screen, route or component changes. No changes to any file owned by session splitit-app-96 (`lib/bills.ts`, `lib/settleView.ts`, `lib/payers.ts`, `lib/homeMarkers.ts`, `app/(app)/index.tsx`, `app/(app)/bills/[id]/index.tsx`, `payers.tsx`, `settle.tsx`), and none owned by splitit-app-52 (`app/(app)/_layout.tsx`, the profile and account routes, `components/ProfileScreen.tsx`).

## Decisions in this spec

| ID | Decision | Why |
|---|---|---|
| UN-1 | Writes go only through the `set_username` RPC. Clients get **no** `UPDATE (username)` grant | A direct update can only report `23514`, and telling "reserved" from "invalid" would mean parsing the constraint name out of the error text. The RPC returns stable codes, does nothing when the name hasn't changed, and is the only write path. |
| UN-2 | The rule lives once in SQL as two named CHECK constraints, written inline (no function call). The RPC maps their violations by constraint name | One SQL definition. With no function in the CHECK, there's no EXECUTE grant for every writing role to get right (lesson 2026-11-27). |
| UN-3 | The database doesn't normalize. It stores and checks the exact value. Only `lib` trims, strips `@` and lowercases (contract N) | This keeps the shared rule to one thing (V). Postgres `lower()` follows the locale (e.g. `İ`), so a DB-side lowercase could accept what `lib` rejects. |
| UN-4 | Dots: not first, not last, never two in a row. Underscores are allowed anywhere. No letter is required (`123` and `___` are valid) | These are the common handle rules, and one regex expresses them the same way in JS and Postgres. |
| UN-5 | Reserved words match exactly (`admin` is blocked, `admin1` is not) | Small and predictable. A broader policy is a before-production review item. |
| UN-6 | No backfill. Existing and new users start at `null`, and `handle_new_user` is unchanged | Decided by the coordinator. Sign-up can't fail on a username. |
| UN-7 | A username can't be cleared back to `null` through the RPC | The user made it required. Only the gate will set the first one. |
| UN-8 | `lib/profile.ts` gets a separate `getMyUsername`. `getMyProfile` is left alone | `getMyProfile`'s select string is asserted in `__tests__/profile.test.tsx`, and `ProfileScreen` is being reworked by splitit-app-52. A new function touches neither. |
| UN-9 | `setUsername` gives up after 15 s (starting value) and reads that as `error` | A hung save on the future required gate would trap the user. A late commit is harmless: retrying the same name is a no-op success. |
| UN-10 | Changing your username logs no bill or group activity event | Bills key on the uuid, and the name shown is always read live. |
| UN-11 | The error copy is the table under "Copy" | One clear message per problem. |

## Shared contracts (defined once; T1 and T2 both point here)

### V: valid stored username

A stored value `s` is valid if and only if all three hold:

1. `3 <= length(s) <= 20`. Postgres: `char_length`. JS: `.length`. The two agree whenever (2) holds, because (2) allows ASCII only.
2. `s` matches `^[a-z0-9_]+(\.[a-z0-9_]+)*$`. The regex text is identical in both places. In both engines `$` matches only at the very end, so a trailing newline is rejected (verify in pgTAP, row B15).
3. `s` is not in **RESERVED**.

Verdict classes are `valid`, `invalid` (fails 1 or 2) and `reserved` (passes 1 and 2, fails 3). Length and format are checked before reserved, so `me` is `invalid`, not `reserved`.

SQL constraint names, which the RPC maps:
- `profiles_username_format`: `username is null or (char_length(username) between 3 and 20 and username ~ '<regex>')`
- `profiles_username_reserved`: `username is null or username <> all (array[<RESERVED>])`

**RESERVED** (starting list; the user reviews it, see Q1): `admin, administrator, splitit, split_it, support, help, helpdesk, root, system, sysadmin, null, undefined, nil, none, me, you, everyone, anonymous, guest, user, users, owner, host, staff, team, official, moderator, mod, security, billing, payments, venmo, paypal, cashapp, api, auth, login, signup, settings, account, profile, privacy, terms, test`.

`lib/username.ts` exports it as `RESERVED_USERNAMES` (a readonly array in this order), along with `USERNAME_PATTERN`, `USERNAME_MIN_LENGTH = 3` and `USERNAME_MAX_LENGTH = 20`. A Jest test reads the migration file and checks that both copies (the list and the regex) are identical. That makes drift a test failure.

### Shared boundary cases (both T1's pgTAP and T2's Jest assert the class)

| Row | Value | Class |
|---|---|---|
| B1 | `abc` | valid (3) |
| B2 | `ab` | invalid (2) |
| B3 | `a` × 20 | valid |
| B4 | `a` × 21 | invalid |
| B5 | `yash_saraiya` | valid |
| B6 | `yash.saraiya` | valid |
| B7 | `.yash` | invalid |
| B8 | `yash.` | invalid |
| B9 | `ya..sh` | invalid |
| B10 | `a.b.c` | valid |
| B11 | `Yash` | invalid (uppercase is never stored) |
| B12 | `yash-s` | invalid |
| B13 | `yash s` | invalid |
| B14 | `josé` | invalid |
| B15 | `yash` + `\n` | invalid |
| B16 | empty string | invalid |
| B17 | `admin` | reserved |
| B18 | `admin1` | valid |
| B19 | `you` | reserved |
| B20 | `me` | invalid (too short beats reserved) |
| B21 | `123` | valid |
| B22 | `___` | valid |
| B23 | `ADMIN` | invalid (uppercase). After N it's `admin`, which is reserved |
| B24 | `a.` + `b` × 18 (20 chars) | valid |

### N: normalize (lib only, applied before V and before any request)

`normalizeUsername(raw: string): string`, in this order:

1. JS `trim()`.
2. Remove one leading `@`.
3. Map ASCII `A`–`Z` to `a`–`z` with a character replace, not `toLowerCase()`, so `İ` stays non-ASCII and fails V.

Examples: `" @Yash_S "` → `yash_s`. `@@yash` → `@yash` (invalid_chars). `İsam` → `İsam` (invalid_chars).

### lib validation reasons (finer than the DB's classes; each maps to one class)

`validateUsername(s): { ok: true } | { ok: false; reason: 'too_short' | 'too_long' | 'invalid_chars' | 'bad_dots' | 'reserved' }`. The first matching check wins:

1. `too_short`: length < 3.
2. `too_long`: length > 20.
3. `invalid_chars`: any character outside `[a-z0-9_.]`.
4. `bad_dots`: the full pattern fails.
5. `reserved`: in RESERVED.

Reasons 1–4 are class `invalid`; reason 5 is class `reserved`. `validateUsername` takes the stored form. It does not normalize.

### S: suggestions (pure; used by the later gate)

`suggestUsername(displayName: string | null): string | null`:

1. Null or blank → `null`.
2. NFKD, then remove U+0300–U+036F.
3. ASCII-lowercase (as in N).
4. Each run of whitespace, `-`, `.` or `_` → `_`.
5. Remove every character outside `[a-z0-9_]`.
6. Collapse `__+` to `_` and trim `_` from both ends.
7. Cut to 20, then trim a trailing `_`.
8. If the result fails V (too short or reserved) → `null`.

Every non-null result passes V.

| Input | Output |
|---|---|
| `Yash Saraiya` | `yash_saraiya` |
| `José Núñez` | `jose_nunez` |
| `Mary-Jane O'Brien` | `mary_jane_obrien` |
| `J. R. Smith` | `j_r_smith` |
| `山田太郎` | `null` |
| `Al` | `null` |
| `Admin` | `null` |
| `Bartholomew Montgomery-Smythe` | `bartholomew_montgome` |
| `Yash 山田` | `yash` |

`withNumberSuffix(base: string, n: number): string` takes a valid base and an integer `n` from 1 to 9999. It returns `base.slice(0, 20 - String(n).length)` with any trailing `_` trimmed, then `n` appended. Example: `abcdefghijklmnopqrst`, 12 → `abcdefghijklmnopqr12`. **Amended 2026-11-28 (review R1, R4):** the trailing `_` is trimmed only if the result keeps at least 3 characters (`___`, 1 → `___1`; `a__`, 1 → `a__1`), so every output passes V. An invalid base throws `RangeError`; a reserved base is allowed (`admin`, 1 → `admin1`).

`fallbackUsername(n: number): string` takes an integer from 0 to 9999 and returns `'user' + String(n).padStart(4, '0')`. Example: 42 → `user0042`. The later gate supplies the number, and picks random or retry-on-taken there.

### R: `public.set_username(p_username text) returns text`

security definer, `set search_path = ''`, volatile. Execute is revoked from `public, anon, authenticated`, then granted to `authenticated`. In order:

| Case | Result |
|---|---|
| `auth.uid()` is null | raise `42501`, message `not_allowed` |
| `p_username` is null | raise `22023`, message `username_invalid` |
| equals the caller's current username | return it, no write (`updated_at` unchanged) |
| update the caller's row (`where id = auth.uid()`), and on `check_violation`: constraint `profiles_username_reserved` | raise `22023`, message `username_reserved` |
| … any other `check_violation` | raise `22023`, message `username_invalid` |
| … `unique_violation` | raise `23505`, message `username_taken` |
| no profile row for the caller | raise `42501`, message `not_allowed` |
| success | return the stored value |

The save itself decides "taken". There is no pre-check, so two people picking the same name at once both reach the unique index, and the second gets `23505`. The RPC takes no row lock stronger than the UPDATE's own. The UPDATE doesn't touch a key column (an expression index can't back a foreign key), so Postgres takes `FOR NO KEY UPDATE`, which doesn't conflict with the `FOR KEY SHARE` locks that `log_event` inserts take on the caller's profile. (Verify; the migration header lists the locks per the lock-order rule.)

### L: `lib/profile.ts` additions

- `getMyUsername(userId): Promise<{ ok: true; username: string | null } | { ok: false }>`. It calls `.from('profiles').select('username').eq('id', userId).single()`. A non-string, non-null value maps to `{ ok: false }`.
- `setUsername(rawInput: string, current: string | null): Promise<SetUsernameResult>`, where
  `SetUsernameResult = { ok: true; value: string; changed: boolean } | { ok: false; reason: SetUsernameReason }` and
  `SetUsernameReason = 'too_short' | 'too_long' | 'invalid_chars' | 'bad_dots' | 'reserved' | 'taken' | 'invalid' | 'not_allowed' | 'error'`.
  1. Apply N, then V. If invalid, return the V reason and make no request.
  2. If the normalized value equals `current`, return `{ ok: true, value: current, changed: false }` and make no request.
  3. Otherwise call `supabase.rpc('set_username', { p_username })` inside `within(…, USERNAME_REQUEST_TIMEOUT_MS)` from `lib/asyncTimeout.ts`. `USERNAME_REQUEST_TIMEOUT_MS = 15_000` is a starting value.
  4. Map the result:
     - `23505` → `taken`
     - `22023` with message `username_reserved` → `reserved`
     - other `22023` → `invalid`
     - `23514` → `invalid`
     - `42501` → `not_allowed`
     - any other error, a throw, a timeout, or returned data that isn't a string passing V → `error`

### Copy (exported once as `USERNAME_ERROR_COPY: Record<SetUsernameReason, string>` in `lib/username.ts`)

| Reason | Copy |
|---|---|
| too_short | Usernames are at least 3 characters. |
| too_long | Usernames are at most 20 characters. |
| invalid_chars | Use only letters, numbers, _ and . |
| bad_dots | A dot can't come first, last, or next to another dot. |
| reserved | That username is reserved. Try another one. |
| taken | That username is taken. Try another one. |
| invalid | That username isn't allowed. Try another one. |
| not_allowed | Couldn't save to your profile. Sign out, sign back in, then try again. |
| error | Couldn't save. Check your connection and try again. |

`invalid_chars` says "letters", not "lowercase letters", because N lowercases what the person types.

## Tasks

### T1: Migration and pgTAP (supabase-engineer)

Files (repo `splitit-app`):
- new `supabase/migrations/<ts>_usernames.sql`. The main session hands out `<ts>`. Draft it in the scratchpad and move it into `supabase/migrations/` only when applying (lesson 2026-11-27).
- new `supabase/tests/database/usernames.test.sql`.
- edit `docs/before-production.md` only if the items already added under §1 and §4 need correcting.

The migration:
- Adds the `username` column (text, null, no default) with the two V constraints.
- Adds `create unique index profiles_username_lower_key on public.profiles (lower(username))`.
- Grants `select (username) on public.profiles to authenticated`. No UPDATE or INSERT grant, and nothing for anon. Policies stay as they are: `profiles_select_own_or_co_participant_or_co_member` already scopes rows.
- Creates `public.set_username` per contract R.
- Adds a header comment that lists the client-unreadable columns (unchanged) and the locks.
- Does not edit `handle_new_user`.

Roughly 120 lines of SQL plus about 200 lines of pgTAP.

### T2: `lib/username.ts` and `lib/profile.ts` (implementer)

Can start in parallel with T1. It codes to the contracts above, not to T1's file. The drift test needs T1's migration on disk, so it lands after T1.

Files (repo `splitit-app`):
- new `lib/username.ts`: contracts V, N, S and the copy table.
- new `lib/username.test.ts`.
- edit `lib/profile.ts`: contract L only. Existing exports are unchanged.
- edit `lib/profile.test.ts`: add tests; existing tests are unchanged.

No component, route or `__tests__/` file changes. Roughly 250 lines including tests.

### T3: Docs (docs-writer, after T1 and T2 pass review)

Files:
- `docs/learning/decisions/0026-usernames.md`: fill in the stub with context, the RPC-over-column-grant choice (UN-1, UN-2), lowercase storage with no DB normalization (UN-3), no backfill (UN-6), and how exact lookup will be added later.
- `docs/learning/concepts/row-level-security.md` and `database-functions.md`: one short paragraph each (a column readable by co-people but writable only through an RPC; mapping a constraint name to an error code).
- `docs/learning/README.md` index line if ADRs are listed there.

## Acceptance criteria

**Database (T1; pgTAP unless noted).** Fixture users are filtered by fixture ids, never by whole-table counts.

1. `profiles.username` exists, is `text`, is nullable and has no default. Existing fixture rows and a newly inserted `auth.users` row both have `username is null`.
2. Sign-up still works with metadata that can't produce a username. Inserting `auth.users` rows with `{"full_name":"山田太郎"}`, `{}` and `{"full_name":"admin"}` each creates a profile with `username is null`. `handle_new_user`'s definition is the same as before the migration: compare `pg_get_functiondef` with the expected body, or show that the migration file has no `handle_new_user`.
3. Every row B1–B24 written directly as superuser (`update ... set username = <value>`) gives the class in the table: valid rows succeed; invalid rows raise `23514` on `profiles_username_format`; reserved rows raise `23514` on `profiles_username_reserved`.
4. The same rows through `set_username` as the row's owner give: valid → returns the value and it's stored; invalid → `22023 username_invalid`; reserved → `22023 username_reserved`. `set_username(null)` → `22023 username_invalid`.
5. Uniqueness: A sets `sam`, then B's `set_username('sam')` → `23505 username_taken`, and A still owns `sam`. A superuser insert of `Sam` (which bypasses the RPC) fails, either on the format constraint or on the unique index; the test asserts that it fails. A user setting their own current name again returns it, with `updated_at` unchanged (compare against a value stored before the call, not `now()`; lesson 2026-11-25).
6. A rename frees the old handle: A goes `sam` → `sam2`, then B's `set_username('sam')` succeeds.
7. Reads as `authenticated`:
   - The owner can read their own row with `select username from public.profiles where id = <own>`.
   - A co-participant on a shared bill and a co-member of a shared group can each read the other's username.
   - A user with no shared bill or group gets 0 rows.
   - `select * from public.profiles` still fails with `42501`.
8. Denied paths fail with `42501`:
   - anon `select username from public.profiles`
   - `authenticated` `update public.profiles set username = 'x' where id = <own>`, for the owner too
   - anon calling `set_username`
   - `set_username` with no JWT subject: raises `42501 not_allowed`
9. Grants: `has_column_privilege('authenticated', 'public.profiles', 'username', 'SELECT')` is true, and `UPDATE`, `INSERT` and `REFERENCES` on it are false. Anon has no privilege on any column (the existing loop in `profile_venmo.test.sql` still passes). The table-level privileges of `authenticated` and `anon` are still empty.
10. `set_username` is `security definer` with `proconfig = {search_path=""}`. Anon can't execute it; `authenticated` can.
11. `set_username` writes nothing to `bill_events` or the group events table (counts filtered by the fixture users' ids stay the same) (UN-10).
12. `npm run db:test` passes in full, including the existing `profiles`, `profile_venmo`, `m2_review_fixes` and `groups` files. If a failure is in a file this task didn't touch, follow the other-sessions rule (lesson 2026-11-27) before reporting it.

**lib (T2; Jest: `npx jest lib/username.test.ts lib/profile.test.ts`)**

13. `validateUsername` returns the class in the shared table for every row B1–B24. Invalid rows give the reason listed under "lib validation reasons": B2/B16/B20 `too_short`, B4 `too_long`, B11/B12/B13/B14/B15/B23 `invalid_chars`, B7/B8/B9 `bad_dots`, B17/B19 `reserved`.
14. `normalizeUsername` gives the three N examples. `normalizeUsername('ADMIN')` is `admin`, which `validateUsername` reports as `reserved`.
15. Drift guard: a test reads the one file matching `supabase/migrations/*_usernames.sql` and asserts that its `profiles_username_format` regex text equals `USERNAME_PATTERN.source`, that its length bounds equal 3 and 20, and that its reserved array equals `RESERVED_USERNAMES` (same members, same order). The test fails if no file or more than one file matches.
16. `suggestUsername` gives every output in the S table. For at least 50 generated names (letters with accents, CJK, emoji, punctuation, long runs of spaces, lengths 0–60), every non-null result passes `validateUsername`. `withNumberSuffix` and `fallbackUsername` give the S examples, and their outputs pass V for `n` = 1, 9, 10, 9999 and a 20-character base.
17. `getMyUsername` makes exactly `select('username')`, `eq('id', <id>)`, `single()` on `profiles`. It maps a string or null, and returns `{ ok: false }` on an error, a throw, or a non-string value.
18. `setUsername`:
    - Invalid input (each V reason) makes **no** request and returns that reason.
    - Input that normalizes to `current` makes no request and returns `{ ok: true, value: current, changed: false }`.
    - Otherwise it calls `rpc('set_username', { p_username: <normalized> })` once.
    - Each error mapping in contract L has a test: `23505`, `22023`+`username_reserved`, `22023`+other, `23514`, `42501`, an unknown code, a throw, a non-string or invalid returned value, and a timeout (fake timers, past 15 000 ms).
    - Success returns the DB's value with `changed: true`.
19. Every `SetUsernameReason` has an entry in `USERNAME_ERROR_COPY` matching the copy table: a type-level `Record` plus a test over the full list. `grep -rn "That username is taken" lib app components` matches only `lib/username.ts`. Grep for this phrase today (same pattern and paths): no files match.
20. No client code writes `username` directly. `grep -rnE "update\(\{\s*username\b" lib app components` prints nothing. Grep today: no files match. Positive control: QA shows the pattern matches a scratchpad file containing `.update({ username: 'x' })` before trusting the empty result.
21. `getMyProfile`, `saveVenmoUsername`, `__tests__/profile.test.tsx` and `components/ProfileScreen.tsx` are unchanged (check with `git diff --stat`). `npm run typecheck` passes. `npm test -- --maxWorkers=4` passes, or failures are only in files outside this task, reported per the 2026-11-24 rule.

**Live reconciliation (QA or T2, using the `live-db-smoke` skill with throwaway local users and the esbuild bundle of the real `lib/profile.ts`)**

22. Against the local DB with T1 applied:
    - `setUsername` returns `taken`, `reserved` and `invalid` for the real errors (`23505`, `22023 username_reserved`, and a value that skips lib validation by calling the RPC directly with `Yash`).
    - `getMyUsername` reads back what was set.
    - A second user who shares a bill reads the first user's `username` with `.select('id, display_name, username')`.
    - A stranger gets 0 rows.
    This confirms that PostgREST passes the RPC's SQLSTATE and message through as `error.code` and `error.message` (verify; reword if it differs).
23. Race: two throwaway users call `setUsername('<runtag>x', null)` at the same moment (`Promise.all`). Exactly one gets `{ ok: true }` and the other gets `taken`, and the stored owner is the one that succeeded. Cleanup leaves 0 rows for the run tag (lesson 2026-11-27, superuser cleanup).

No User checks: this slice has no screen and no device step.

## Later (not built here; each needs its own spec)

- **Required "Pick your username" gate.** This must be written against the post-tabs routes from splitit-app-52 (`docs/specs/2026-11-28-tab-bar-and-activity.md`), not today's `app/(app)/_layout.tsx`. Routes as landed (splitit-app-52, 2026-11-28): the Profile tab is `app/(app)/(tabs)/profile.tsx` (no back control), `app/(app)/account.tsx` renders the same screen with a Back header for links from Settle and VenmoPrompt, the shared screen is `components/ProfileScreen.tsx` (`withBack` prop), the tabs layout is `app/(app)/(tabs)/_layout.tsx`, and `app/(app)/_layout.tsx` keeps the auth guard and `SentCheckResponder` with `unstable_settings.initialRouteName = '(tabs)'`. It must keep the pending-invite resume (`lib/pendingInvite`, `ResumeAfterSignIn`), notification taps (`lib/resumeGate`) and `/auth/callback` working, with entry-route tests per lesson 2026-11-24. It uses `suggestUsername`, then `withNumberSuffix` on `taken`, then `fallbackUsername`. It needs copy for its saving and network states.
- **Account-screen editor** for changing the handle, in `components/ProfileScreen.tsx` (so it appears on both the Profile tab and `/account`).
- **Showing `@handle`** under display names in Add people, Who paid, group members and Settle. Adding `username` to `PARTICIPANT_COLUMNS` and `BillParticipant` in `lib/bills.ts` is a one-line edit in a splitit-app-96 file, and `people_i_split_with` and the group snapshot functions return explicit columns, so they need `username` added in a migration.
- **Exact-username search.** A security-definer `find_user_by_username(p text)` that returns `id, display_name, username` for an exact lowercase match only. It uses `profiles_username_lower_key`. It needs no grant or policy change on `profiles`, so co-people visibility stays as it is. Rate limiting is its own question (see before-production).
- **Friends and friend requests.**

## Risks / open questions (for the user; logged in `docs/decisions-to-review.md` as UN-*)

- **Q1. Reserved list contents, and exact-match versus substring blocking** (`splitit_support`, `admin.team`). Exact match on the starting list is built now; a broader policy is a before-production item.
- **Q2. All-digit and all-underscore handles** (`123`, `___`) are allowed (UN-4). The alternative is to require at least one letter.
- **Q3. Rename policy:** whether there's a limit on how often you can rename, and whether an old handle is freed right away (today it is, and on account deletion too). This is in before-production.
- **R1. "Taken" tells anyone signed in that a handle exists.** It's inherent to unique handles, and search will widen it. Rate limiting is already a before-production item; usernames are added to it.
- **R2. Deploy order.** The lib code only calls `set_username` from the later gate, so shipping lib before the migration breaks nothing today. The gate's spec must require the migration on the hosted project first.

## Amendment A1 (2026-11-28, user decision: username is mandatory). Wins over the body where they differ
User: "username should be mandatory" (replying to "profiles have an optional username field, empty for everyone for now"). Every account has a username from the moment it exists; the user can change it later (the editor is still Later).

- **A1.1 NOT NULL.** `profiles.username` becomes `not null`. UN-6 (no backfill) is reversed.
- **A1.2 Assigned at sign-up, never blocking it.** `handle_new_user` assigns a username in the same insert, with a new private helper `private.assign_username(p_display_name text) returns text` (security definer, `search_path = ''`, not executable by any client role):
  1. a base from the display name, the SQL counterpart of `suggestUsername` (ASCII-fold where Postgres can without the `unaccent` extension, lowercase a–z/0–9 only via an explicit translate, runs of space/`-`/`.`/`_` → `_`, trim `_`, cut to 20). If the base fails V (too short, reserved, empty, non-Latin name), use `user`;
  2. try the base, then the base plus a random number (`withNumberSuffix`'s cut rule), a bounded number of times, each attempt inside its own `begin … exception when unique_violation` block;
  3. a final fallback that can't collide in practice (`u` + 12 hex characters of `gen_random_uuid()`, which passes V).
  The trigger must still never fail sign-up: the fallback always succeeds, and the whole thing is tested with names that are CJK, emoji-only, `{}`, `admin`, empty, 60 characters long, and many users with the same name.
  The SQL base rule doesn't have to equal `suggestUsername` character for character (the suggestion is not a money rule and both outputs pass V, which is shared). Document the differences in the migration header and the ADR; add a pgTAP + Jest pair on a few common names (`Yash Saraiya` → `yash_saraiya`, `Zoë Smith` → `zoe_smith` if the fold is available, otherwise `zo_smith`) so drift is visible.
- **A1.3 Backfill.** The same migration assigns a username to every existing profile with none (in `created_at` order, through the same helper), then sets `not null`. The demo seed (`supabase/snippets/seed-demo.sql`, another session's file) inserts profiles directly: after this change it must still run. Prefer a column default that calls nothing a client can reach, or a `before insert` trigger on `profiles` that fills a null username with `private.assign_username(new.display_name)`, so direct inserts (seed, tests) keep working without listing a username. Pick one and say why.
- **A1.4 `set_username`** is unchanged, except that `null` stays refused (`username_invalid`) and can never clear the column.
- **A1.5 lib.** `getMyUsername` now returns a string for every signed-in user; a `null` from the server is malformed (`{ ok: false }`). Update its type and tests.
- **A1.6 Tests to update.** The pgTAP check that `handle_new_user` is unchanged (md5) is replaced by tests of the new behaviour; criterion 1's "starts null" and criterion 2's "username is null" become "has a valid, unique username". Every other pgTAP file that inserts profiles must still pass (full `db:test`).

## Amendment A2 (2026-11-28, user decision: a username can never change). Wins over the body and A1
User: "also enforce you cant change username - unique id". The username assigned at sign-up (A1) is permanent: a stable, unique id for the account.

- **A2.1 No rename path for clients.** `public.set_username` is dropped (it was only for the not-yet-built gate and editor). `authenticated` keeps no write path to `username`; a direct UPDATE was already 42501.
- **A2.2 Enforced in the database for every role.** A `before update of username on public.profiles` trigger raises `42501 username_immutable` when `new.username is distinct from old.username`, for every role including `postgres` and `service_role`. Same shape as the append-only guards: security definer, `search_path = ''`. The A1 backfill already ran, so no exception is needed for it. (Operator fixes, if ever needed, take a dedicated migration that drops and re-creates the trigger, on purpose.)
- **A2.3 Inserts unchanged.** Sign-up (`handle_new_user`), the fill trigger and direct inserts still assign a username exactly as in A1.
- **A2.4 lib.** `setUsername`, its copy entries that only rename produces (`taken` stays for no client path; remove what is unused), and its tests are removed from `lib/profile.ts`. `validateUsername`, `normalizeUsername`, `suggestUsername`, `withNumberSuffix`, `fallbackUsername` and the reserved list stay (they still describe rule V and the sign-up suggestion, and the drift test still compares them with the DB). `getMyUsername` stays.
- **A2.5 Tests.** pgTAP: `set_username` no longer exists; an UPDATE of `username` fails with `42501 username_immutable` as owner, `authenticated`, `service_role` and `postgres`; an UPDATE of any other profile column (display_name by the trigger owner path, venmo_username through its existing grant) still works and leaves `username` unchanged; account deletion still cascades the profile. Tests that renamed a username (criterion 6, the rename/frees-the-name cases, fixtures that "free a handle by renaming") are rewritten to not rename.
- **A2.6 Later list.** "Account-screen editor" is removed from Later. The "Pick your username" gate is removed too (there is nothing to pick). Showing `@handle` in pickers and exact search stay in Later.
- **A2.7 Open question (logged):** when an account is deleted its profile goes, so its username becomes free for someone new. Should usernames be retired forever instead (a small `retired_usernames` table checked by `assign_username`)? Not built; the user decides.
- **A2.8 Venmo stays editable** (the user, relayed by splitit-app-52: "venmo username can be changed but the splitit app username cant be changed"). `venmo_username` keeps its update grant, its Profile control and `saveVenmoUsername`, unchanged. Criterion: as the owner, updating `venmo_username` succeeds and leaves `username` unchanged; updating `username` in the same statement fails with `42501 username_immutable`.
- **A2.9 Open question (logged, UN-17):** is the auto-assigned username final, or may a person pick theirs once (e.g. on first launch) before it locks? Built as **final** (A2.1–A2.2) until the user says otherwise.

## Amendment A3 (2026-11-28, user decision UN-17: pick once, then locked). Wins over A2 where they differ
User (typed in session splitit-app-52, relayed): "they get to pick - but we verify its unique and add 3/4 random number after it, if not unique as suggested usernames".

- **A3.1 Provisional, then locked.** New nullable `profiles.username_locked_at timestamptz`. The username assigned at sign-up or by the A1 backfill is provisional (`username_locked_at is null`). The person picks once; then it is locked for good (A2's "never changes" applies from that moment). Picking the same name as the provisional one locks it too.
- **A3.2 `public.set_username` is kept, as set-once** (A2.1's drop is reversed). Allowed only while `username_locked_at is null`; one UPDATE sets `username` and `username_locked_at = now()`. Afterwards `42501 username_locked`. Other answers as before: `23505 username_taken`, `22023 username_reserved` / `username_invalid`, `42501 not_allowed` when signed out.
- **A3.3 Immutability (replaces A2.2's condition).** Once `username_locked_at` is set: any change to `username` fails with `42501 username_immutable` for every role, and `username_locked_at` can't be cleared or changed. While unlocked, `username` changes only together with setting the lock (the set_username path).
- **A3.4 Availability for suggestions.** `public.usernames_available(p_candidates text[]) returns text[]`: the candidates that pass V and are free (case-insensitive); at most 10 per call; authenticated only. Probing risk noted in before-production (rate limit before launch).
- **A3.5 Suggestions when taken.** `lib/username.ts` `suggestTakenAlternatives(base, rng)`: base + 3–4 random digits (cut to fit 20 by withNumberSuffix's rule), valid, de-duplicated, 3–5 candidates; the screen shows only the ones `usernamesAvailable` returns, and the person picks one or types another. The save itself (`set_username`) still decides (a suggestion taken in between gives `taken`).
- **A3.6 Pick step (screen, next task).** A "Choose your username" step on first launch while `username_locked_at is null`, prefilled with the provisional username. Whether it can be skipped (keeping the provisional name unlocked until later) is open (UN-18); default: required, with "Keep @yash_saraiya" as the one-tap choice. It is written against the post-tabs routes and must keep the pending-invite resume, notification taps and `/auth/callback` working. app/(app)/_layout.tsx and the tabs layout belong to splitit-app-52: coordinate before that task.
- **A3.7 Venmo** stays editable (A2.8, unchanged).
- **A3.8 Gate notes (from splitit-app-52, owner of the layouts; send it the plan before editing):**
  - The gate lives in `app/(app)/_layout.tsx`, next to the auth guard and `SentCheckResponder`, not in `(tabs)/_layout.tsx`, so deep links (`/bills/<id>`, `/b/<code>`, `/g/<code>`) are gated too. Keep `unstable_settings = { anchor: '(tabs)' }`.
  - The deep link survives the gate: after "Choose your username" the person continues to the invite or bill (`ResumeAfterSignIn` in `app/_layout.tsx`, `lib/resumeGate`), not to Tabs. `__tests__/tabBar.test.tsx` criteria 32a–f must still pass, plus new criteria for each entry path through the gate.
  - A `test-utils` helper (a locked username in the fake profile, the default) so the ~190 existing router suites need no edits.
  - Order with the first-run Venmo prompt: username first, then Venmo; they never stack.
- **A3.9 Profile shows the username** (user, relayed by splitit-app-52: "in profile also show splitit username"). `components/ProfileScreen.tsx` (Profile tab and `/account`) gets a read-only row `Username` · `@yash_saraiya`, no edit control once locked. While still provisional (`username_locked_at is null`) the row shows the provisional value with a `Choose` link to the pick step. Ships with the screen task (A3.6). ProfileScreen was edited today by splitit-app-96 (Appearance row): coordinate with 96 and re-read the file just before editing; exact-string edits only.
  - Placement (splitit-app-96, which owns the Appearance card; no further ask needed before editing): put `@name` (plus `Choose` while provisional) on the identity line under the name in the Profile header, or as the first row above the Venmo card. It always comes before Venmo and Appearance. Keep the Appearance card and `__tests__/appearance.test.tsx` intact. Any new web-render test that imports `lib/theme` needs the `@/lib/storage` memory mock (the expo-status-bar mock is already global in `test-utils/jestSetup.ts`).
- **A3.10 UN-18 decided (user, 2026-11-28): the pick step can't be skipped.** Every route under `app/(app)` is gated until `username_locked_at` is set; no Skip / Later / close control; Back on Android and the web back button stay on the step. "Keep @<provisional>" is the one-tap way through. Signing out is still possible from the step.
