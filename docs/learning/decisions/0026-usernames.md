# 0026: Usernames: a unique @handle, set only through `set_username`

**Status:** Accepted (2026-11-28, spec `docs/specs/2026-11-28-usernames.md`, groundwork only). T1 (migration + pgTAP) and T2 (`lib/`) are built and reviewed; contract S was amended after review (R1, R4; see below). QA passed overall, and the live smoke check passed 24 of 24, including the two-user race. The full pgTAP suite passed afterwards (2026-11-28: 31 files, 2101 tests). The full Jest suite has not been run (the machine was shared); the slice's own Jest files pass (134 tests). Decisions UN-1 to UN-11 and open questions Q1–Q3 are waiting for the user's look in `docs/decisions-to-review.md` ("2026-11-28 · Usernames groundwork").

*Numbering note:* 0026 was reserved with a stub on 2026-11-28 by this spec. This file fills that stub in place.

## Context
Every person already has a **display name**. It comes from Google when you sign in ("Yash Saraiya"). It isn't unique: two people can both be "Yash Saraiya", and the app can't tell them apart in Add people or Who paid.

A **username** is a different thing: a short handle like `@yash_s` that **only one account can have**. It's how two "Yash Saraiya"s get told apart, and later how you'd find a friend.

| | Display name | Username |
|---|---|---|
| Example | Yash Saraiya | `yash_s` (shown as `@yash_s`) |
| Where it comes from | Google, at sign-up | The person picks it |
| Unique? | No | Yes, ignoring case |
| Stored as | Whatever Google sent | Lowercase, without the `@` |
| Who can read it | You, plus people you share a bill or group with | The same people |

The user's rules: letters, numbers, `_` and `.`; 3 to 20 characters; unique ignoring case; required; editable. On 2026-11-28 the user narrowed this slice to **groundwork only**: "just create the framework to allow for it to happen ... we will implement the feature later". So this ADR covers the stored field, the one safe way to write it and the shared rule. No screen uses it yet.

## Options
| Question | Options considered | Chosen |
|---|---|---|
| How a username is written | A column `UPDATE` grant plus check constraints; **a `security definer` RPC** | The RPC `set_username` (UN-1) |
| Where the rule lives in SQL | A private validation function called from a CHECK; **two named inline CHECK constraints** | Inline constraints (UN-2) |
| Who lowercases | The database (`lower()`) and the app; **only the app** | Only the app; the database rejects uppercase (UN-3) |
| Existing users | Generate a username for everyone; **leave them empty** | Empty (`null`) until the later gate (UN-6) |
| Who can read it | Everyone signed in; **the same people who can read your display name** | Same as `display_name` |

## Decision

### 1. One column, one rule (contract V)
`profiles.username` is `text`, nullable, with no default (`supabase/migrations/20261128070000_usernames.sql`). A stored value is valid only if:
1. it's 3 to 20 characters long;
2. it matches `^[a-z0-9_]+(\.[a-z0-9_]+)*$`. In plain words: lowercase letters, digits and `_`, with dots allowed only between other characters (not first, not last, never two in a row);
3. it isn't on the reserved list (`admin`, `support`, `venmo`, `me`, `you` and 39 more).

Examples: `yash_saraiya` and `a.b.c` are valid. `.yash`, `ya..sh`, `Yash` and `josé` are invalid. `admin` is reserved, but `admin1` is fine (exact match only, UN-5).

A unique index on `lower(username)` (`profiles_username_lower_key`) makes sure only one account has each handle.

The same rule is in `lib/username.ts` (`USERNAME_PATTERN`, `RESERVED_USERNAMES`, `USERNAME_MIN_LENGTH`, `USERNAME_MAX_LENGTH`, `validateUsername`). That follows the `CLAUDE.md` rule for a rule kept in two places: same rule, same boundary cases (rows B1–B24 in the spec) tested on both sides. A Jest test reads the migration file and fails if its regex or reserved list differs from `lib/`, so drift is a test failure.

### 2. Writes go only through an RPC, not a column grant (UN-1, UN-2)
Clients have **no** `UPDATE` or `INSERT` grant on `username`. The only way to set it is `public.set_username(p_username text)`: `security definer`, `set search_path = ''`, executable by `authenticated` only.

**Why not just grant `update (username)`?** That's how `venmo_username` works, and it's simpler. But a direct update can only fail with one code for a bad value: `23514 check_violation`. The app needs to tell the person *which* problem it is:
- "That username is reserved" and "That username isn't allowed" are different messages. With a direct update, the only way to tell them apart is to read the constraint's name out of the error text. Error text isn't a stable contract.
- "That username is taken" would arrive as a raw `23505` that also carries the conflicting value in its detail.

The RPC does the update itself, catches the error, and re-raises a fixed code and message:

| What happened | The RPC raises |
|---|---|
| Not signed in, or no profile row | `42501 not_allowed` |
| `null` | `22023 username_invalid` |
| Broke the format or length check | `22023 username_invalid` |
| Broke the reserved check (`profiles_username_reserved`) | `22023 username_reserved` |
| Someone else has it | `23505 username_taken` |
| Same as your current username | returns it, writes nothing (`updated_at` unchanged) |

It tells "reserved" from "invalid" by the constraint name, using `get stacked diagnostics ... constraint_name` inside the function, where the name is reliable. The client only ever sees our fixed message, never the constraint name or the other person's value.

**Why inline constraints and not a helper function (UN-2).** The rule is written once in SQL, as two named CHECK constraints with no function call inside. A CHECK that calls a function makes every role that writes the table need EXECUTE on that function, which is easy to get wrong (lesson 2026-11-27; [database functions](../concepts/database-functions.md), "Grants on functions"). Postgres checks CHECK constraints in name order, so `profiles_username_format` runs before `profiles_username_reserved`. That's why `me` (too short *and* reserved) reports "invalid", matching `lib/`.

A username can't be cleared back to empty through the RPC (UN-7): the user made it required. Renaming logs no Activity event (UN-10): bills key on the account id, and names are always read live.

### 3. Taken is decided by the save itself
There's no "is this free?" check before saving. The unique index decides. If Ana and Ben both try `sam` at the same moment, both reach the index, one commits first, and the other gets `23505 username_taken`. The live smoke check ran exactly this race with two throwaway users: exactly one won, and the loser got `taken`.

`setUsername` in `lib/profile.ts` maps `23505` to the reason `taken`, and the screen copy is "That username is taken. Try another one." (`USERNAME_ERROR_COPY` in `lib/username.ts`).

The update only changes non-key columns, so Postgres takes the weaker `FOR NO KEY UPDATE` row lock. It doesn't block bill or group writes that point at your profile. The migration header lists every lock.

### 4. Lowercase storage, no normalizing in the database (UN-3)
The database stores and checks the **exact** value. It never lowercases, trims or strips `@`. Only the app does that, in `normalizeUsername` (contract N):
1. trim spaces;
2. drop one leading `@`;
3. change ASCII `A`–`Z` to `a`–`z`, one character at a time (not `toLowerCase()`).

So `" @Yash_S "` becomes `yash_s` before it's sent. If a script sends `Yash` straight to the RPC, the database refuses it with `username_invalid` (the live check confirmed this).

**Why not lowercase in the database too?** Two copies of "lowercase" can disagree. The Postgres docs say `lower()` converts "according to the rules of the database's locale", so its answer for non-ASCII letters (such as the Turkish dotted capital `İ`) depends on how the server was set up. A database `lower()` could turn a name the app rejects into one that passes. Keeping the database strict, and doing only plain ASCII changes in the app, means the shared rule stays one thing: V.

That's also why the app doesn't use `toLowerCase()`. It lowercases more than ASCII: the Kelvin sign `K` (U+212A, not a normal K) becomes a plain `k`, so `toLowerCase()` would quietly turn a look-alike character into a valid handle. With the ASCII-only replace, `İsam` and `Kate` (with the Kelvin sign) stay as typed and fail V with "Use only letters, numbers, _ and .".

### 5. No backfill; sign-up is never blocked (UN-6)
Existing users and new users both start with `username = null`. `handle_new_user`, the trigger that makes a profile at sign-up, is **unchanged**. So sign-up can never fail because of a username. pgTAP checks this with names that can't become a handle (`山田太郎`, empty metadata, `admin`): each still gets a profile with a null username. Asking people to pick one is the job of the later "Pick your username" gate.

### 6. Reads follow `display_name`'s rule
The migration grants `select (username)` to `authenticated` and changes no policy. The existing policy, `profiles_select_own_or_co_participant_or_co_member`, already limits rows to you, people you share a bill with and people you share a group with. So exactly those people can read your username, the same as your display name. Anon gets nothing, and a stranger gets 0 rows ([row level security](../concepts/row-level-security.md)).

### 7. Suggestions for the later gate (contract S, amended 2026-11-28)
`lib/username.ts` also has three pure helpers the gate will use:
- `suggestUsername(displayName)`: `Yash Saraiya` → `yash_saraiya`, `José Núñez` → `jose_nunez`, `山田太郎` → `null`. Every non-null result passes V.
- `withNumberSuffix(base, n)`: for when the suggestion is taken. `yash_saraiya`, 2 → `yash_saraiya2`. It cuts the base so the result fits in 20 characters.
- `fallbackUsername(n)`: `user0042`.

**Amendment (review R1, R4, 2026-11-28).** The first version of `withNumberSuffix` always trimmed a trailing `_` before adding the number. For a base like `___` that left an empty base, and a short result could fail the 3-character minimum. Now the trailing `_` is trimmed only if the result still has at least 3 characters: `___`, 1 → `___1`; `a__`, 1 → `a__1`. So every output passes V. An invalid base throws `RangeError`. A reserved base is allowed (`admin`, 1 → `admin1`).

**Edge case QA noticed:** `withNumberSuffix('___', 9999)` returns `9999`. With 4 digits the trim still leaves 4 characters, so the base is dropped completely. That's valid (all-digit handles are allowed, UN-4), but it's a poor suggestion. The later gate should prefer suggestions that keep some of the base.

## What's deliberately not built yet
Each of these needs its own spec:
- **The "Pick your username" gate** that asks every signed-in person without a handle to pick one. It must keep invite resume, notification taps and `/auth/callback` working, and use `suggestUsername`, then `withNumberSuffix` on `taken`, then `fallbackUsername`.
- **The editor** on the Profile / account screen for changing your handle.
- **`@handle` in pickers**: under names in Add people, Who paid, group members and Settle. That needs `username` added to `lib/bills.ts`'s participant columns and to `people_i_split_with` and the group snapshot functions (a migration).
- **Search** (see below).
- **Friends** and friend requests.

Checked 2026-11-28: no file in `app/`, `components/` or `__tests__/` calls `getMyUsername`, `setUsername` or `set_username` yet.

## Later: search
Today's read rule (you, plus people you share a bill or group with) is **deliberate**. A stranger can't read your username, which also means a stranger can't find you by it yet.

When search is built, it will let strangers find you, so it widens who can learn a handle. The user agreed (in chat, 2026-11-28) that it widens **through one narrow function**, never by widening `profiles`' row policy. The function must:
- **match the exact handle only.** No prefix search ("ya…"), no "contains", no listing. You have to already know someone's handle to find them;
- **return only the username, the display name and the id needed to invite.** Never `venmo_username`, and nothing else from the profile;
- be **`security definer` with `search_path = ''`**, executable by `authenticated` only (not anon);
- be **rate-limited per user**, so nobody can test thousands of handles. Without a backend there's no rate limit today; this is the same open question as `set_username`'s "taken" answer, which already tells any signed-in user that a handle exists (spec R1, `docs/before-production.md` §4).

Browsing `profiles` stays limited to people you share something with. The exact match can use `profiles_username_lower_key`. Tracked in `docs/before-production.md` §1, "Username search: add a narrow lookup, don't open the table". When search is built, record it as an amendment to this ADR (or a new ADR if it changes a decision here).

## Consequences
- **Handles are first come, first served.** The reserved list is a starting list; whether to block look-alikes by substring (`splitit_support`, `admin.team`) is open (Q1, `docs/before-production.md` §1).
- **`123` and `___` are valid handles** (UN-4). Requiring a letter is open (Q2).
- **Renames are unlimited, and an old handle is free again at once**, including after account deletion. Whether to add a cooldown or hold old handles is open (Q3, `docs/before-production.md` §1).
- **"Taken" leaks that a handle exists** to anyone signed in, one call at a time. That's inherent to unique handles; the rate-limit item above covers it.
- **Deploy order.** Nothing shipped reads `username` yet, so the migration is safe to push at any time. It must reach the hosted project **before** a build with the gate (spec R2, `docs/before-production.md`).
- **Two copies of the rule.** Changing the length, the pattern or the reserved list means a new migration **and** the same change in `lib/username.ts`. The drift test fails until both match.

## Code (by name, since line numbers move)
- Database: `supabase/migrations/20261128070000_usernames.sql` (the `username` column, `profiles_username_format`, `profiles_username_reserved`, `profiles_username_lower_key`, `public.set_username`). Tests: `supabase/tests/database/usernames.test.sql` (94 pgTAP tests).
- Rule and copy: `USERNAME_PATTERN`, `RESERVED_USERNAMES`, `validateUsername`, `normalizeUsername`, `suggestUsername`, `withNumberSuffix`, `fallbackUsername`, `USERNAME_ERROR_COPY` in `lib/username.ts`.
- Data layer: `getMyUsername`, `setUsername` (with `USERNAME_REQUEST_TIMEOUT_MS`, 15 s) in `lib/profile.ts`.
- Jest: `lib/username.test.ts` and `lib/profile.test.ts`, 134 tests in the slice, including the drift test.

Docs: PostgreSQL string functions (`lower()` follows "the rules of the database's locale"): https://www.postgresql.org/docs/current/functions-string.html. PL/pgSQL `GET STACKED DIAGNOSTICS` (`CONSTRAINT_NAME`): https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-EXCEPTION-DIAGNOSTICS.

Concept notes: [row level security](../concepts/row-level-security.md) ("Usernames: readable by co-people, written only through an RPC"), [database functions](../concepts/database-functions.md) ("`set_username`: turning a constraint name into an error code").
