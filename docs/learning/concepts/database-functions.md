# Database functions (security definer vs invoker)

## The idea
A **database function** is a named piece of SQL (or PL/pgSQL, Postgres's built-in scripting language) stored in the database. The app calls it like a remote function:

```ts
const { data, error } = await supabase.rpc('join_bill', { p_code: code });
```

Supabase exposes functions in the `public` schema through its API (PostgREST), so `rpc('join_bill')` runs `public.join_bill(...)` inside Postgres.

The important question for any function is **whose permissions it runs with**:

- **`security invoker`** (the default): it runs as **the caller**. RLS policies and grants apply exactly as if the caller had typed the SQL themselves. The function is mainly a convenience.
- **`security definer`**: it runs as **the function's owner** (for us, `postgres`, which also owns the tables). Table owners aren't filtered by RLS (unless the table uses `force row level security`, which ours don't), so the function can read and write rows the caller can't. That makes the function a **trusted gatekeeper**: the caller can only do what the function's own checks allow.

A definer function is like a bank teller. You can't walk into the vault, but you can ask the teller, who checks your ID and moves only your money.

### `set search_path = ''`
When SQL says `bills` without a schema, Postgres looks it up through the `search_path` setting, a list of schemas to search in order. If a definer function used the caller's search path, a caller could create their own object called `bills` somewhere earlier in the path, and the function (running with the owner's power) would use the fake one. The Postgres docs warn about exactly this.

So every function we write:
- sets `set search_path = ''` (search nothing), and
- writes every name in full: `public.bills`, `auth.uid()`, `extensions.gen_random_bytes(10)`.

An unqualified name then fails loudly instead of quietly finding the wrong object.

### Grants on functions
Postgres lets **everyone (`PUBLIC`) execute a new function by default**. For a definer function that's dangerous, so every migration does this:

```sql
revoke execute on function public.join_bill(text) from public, anon, authenticated;
grant execute on function public.join_bill(text) to authenticated;
```

Signed-out callers (`anon`) then get `42501 permission denied`. Internal helpers that only other functions call (`private.log_event`, `private.validate_bill_rows`) get no grant at all. The definer functions that call them run as `postgres`, so they don't need one. Trigger functions don't need an `execute` grant to fire either.

## Why it matters here
Four writes can't be done safely as plain table writes from the app ([ADR 0013](../decisions/0013-writes-through-database-functions.md)):

1. **Saving a bill** writes `bills`, `line_items` and `bill_participants`. It must be all or nothing.
2. **Joining by code.** You aren't in the bill yet, so RLS won't let you read it.
3. **A host edit** is a diff across many rows, and must land in one go.
4. **Setting someone else's split.** Any claimer of an item may set everyone's parts on it. A grant can't say "only on items you've claimed".

Settling (M3) added more of the same kind: changing who gets paid clears *other people's* "I paid" marks, and the host or payer may undo someone else's mark. A grant can't express either ([ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md)).

People you've split with (2026-11-24) added three more: putting *someone else* on a bill only if you're linked to them, and taking someone off (or yourself) only if it changes nobody's money ([ADR 0016](../decisions/0016-people-come-from-shared-bills.md)). Both rules look at other tables (claims, marks, other bills), which no grant or simple policy can do.

### Atomic create and update
One `rpc()` call runs as **one transaction**. If any statement inside raises an error, Postgres undoes every change the function made. So:
- `create_bill` can't leave a bill with no items, or a bill with no host participant.
- `update_bill` validates first. If validation or any later step fails, the bill is exactly as it was, and no Activity events are logged either.

### Why `join_bill` can't be used to enumerate codes
"Enumerate" means trying codes until one works, to get into bills you weren't invited to. `join_bill` makes that hopeless:
- **Codes are 80 random bits** (20 hex characters from `extensions.gen_random_bytes(10)`), made by the database, never the app. That's about 1.2 × 10²⁴ possible codes. Even with a million live bills and 1,000 guesses a second, a lucky hit would take tens of millions of years on average.
- **A wrong code and a malformed code give the same error** (`P0002 'invalid_code'`). A guesser can't even learn "that one was the right shape".
- **It only answers "here's the bill id" for an exact match**, and the only thing it does is add *you* as a participant. It never lists bills or returns anyone else's data.
- **The host can rotate the code** (`rotate_join_code`). The old link stops working, and people already in the bill stay in.

The realistic abuse isn't guessing, it's **spam** (making lots of bills or calls). There's no rate limit for that yet (`docs/before-production.md` §4).

### Why this isn't a custom backend
These functions are SQL stored **inside the managed Supabase Postgres** and versioned in `supabase/migrations/`, just like tables and RLS policies. No server program of ours runs, nothing is deployed except migrations, and no secret key is involved. A custom backend would be code *we* run on a server (an Edge Function, a Node API). See [ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md) and [architecture overview](architecture-overview.md).

## How we use it
| Function | Kind | What it guards | Code |
|---|---|---|---|
| `create_bill` | definer | Host is always the caller (no host parameter). Rows may not carry ids. Join code generated here. One transaction. | `supabase/migrations/20261121080352_bill_events.sql:216-299` (current; first version `20261121074604_bill_functions.sql:178`) |
| `join_bill` | definer | Same error for bad and unknown codes. Adds only the caller. Since 2026-11-24 it also turns an added row into a joined one (R6) and locks the bill first. | `20261124094656_people_review_fixes.sql:311-357` (current; first version `20261121080352_bill_events.sql:304-340`) |
| `rotate_join_code` | definer | Host only. "Not the host" and "no such bill" look the same. | `20261121080352_bill_events.sql:345-389` |
| `update_bill` | definer | Host only. Every row id must belong to this bill. One new item may not merge rows from several old items. Locks the bill row so two edits can't interleave. | `20261122085802_m2_review_fixes.sql:130-357` (current; earlier `20261121080352_bill_events.sql:411-611`) |
| `set_item_split` | definer | See below. Since 2026-11-24 it locks the bill before the item. | `20261124094656_people_review_fixes.sql:192-303` (current; first version `20261121080352_bill_events.sql:620-724`) |
| `set_extras_split` | definer | Host only; mode must be `proportional` or `equal`. | `20261121130144_extras_split.sql:35-77` |
| `set_claim` | **invoker** | Nothing extra: RLS already says "only your own claim". A row deleted mid-claim gives the same error as a missing row. Since 2026-11-24 it locks the bill before writing. | `20261124094656_people_review_fixes.sql:140-184` (current; earlier `20261122085802_m2_review_fixes.sql:74-117`, first version `20261121074604_bill_functions.sql:347-381`) |
| `private.is_bill_participant`, `private.shares_bill_with` | definer helpers | Used inside RLS policies; always about the caller's own membership | `20261121074115_bills_claims.sql:157-187` |
| `private.bill_events_append_only` | definer trigger function | Blocks edits to Activity events; definer so its "is the bill gone?" check reads the real tables ([audit log](audit-log.md)) | `20261121080352_bill_events.sql:81-115`, made definer at `20261122085802_m2_review_fixes.sql:37-40` |
| `venmo_prompt_pending` | definer | Reads only the caller's own profile row. Returns a yes/no, never the timestamp. | `20261124072017_profile_venmo.sql:76-92` |
| `dismiss_venmo_prompt` | definer | Stamps only the caller's own row, only once. | `20261124072017_profile_venmo.sql:100-122` |
| `private.stamp_venmo_prompt` | **invoker** trigger function | Saving a Venmo username counts as answering the prompt | `20261124072017_profile_venmo.sql:50-69` |
| `set_payer` | definer | Host only. New payer must be a participant. Refuses if the number of "I paid" marks isn't what the confirm showed. Clears every mark. Locks the bill `for update`. | `20261124081411_settle_payer.sql:186-245` |
| `mark_paid` | definer | Only for yourself, only if you're not the payer, only on a complete bill, only for the payer your screen showed. Amount 1–99,999,999¢. Locks the bill `for share`. | `20261124081412_settle_marks.sql:50-108` |
| `unmark_paid` | definer | Only the host, the person themself, or the payer. Locks the bill `for share`. | `20261124081412_settle_marks.sql:117-167` |
| `private.bill_is_complete` | **invoker** helper | "Every item row has at least one claim". No client role may execute it. | `20261124081412_settle_marks.sql:24-38` |
| `private.bills_default_payer` | invoker trigger function | A new bill's payer is its host | `20261124081411_settle_payer.sql:70-86` |
| `private.bill_participants_reset_payer` | definer trigger function | If the payer's participant row is deleted, hand the bill back to the host and clear marks | `20261124081411_settle_payer.sql:94-142` |
| `people_i_split_with` | definer | No arguments, so it only ever answers about the caller. Returns only people the caller could already read through `profiles` RLS. | `20261124091041_people.sql:111-142` |
| `add_participant` | definer | Host only. Only people linked to the host (rule L1). Same `not_linked` for an unlinked user and an id that isn't a user. Locks the bill `for share`. | `20261124091041_people.sql:159-205` |
| `remove_participant` | definer | Host only. Only when the target is removable (rule L3), so nobody's share changes. Locks the bill, then the target's row, `for update`. | `20261124091042_membership.sql:74-116` |
| `leave_bill` | definer | Takes only yourself off. Same L3 rule. Refuses a non-participant **before** taking any lock. | `20261124094656_people_review_fixes.sql:372-420` (current; first version `20261124091042_membership.sql:127-166`) |
| `private.my_links` | **invoker** helper | Rule L1, written once: everyone the caller is linked with, and through which bills. No client role may execute it. | `20261124091041_people.sql:71-101` |
| `private.is_removable` | **invoker** helper | Rule L3, written once. No client role may execute it. | `20261124091042_membership.sql:43-63` |
| `private.lock_bill_key_share` | definer helper | Takes the bill lock first for claim writes, and only on a bill the caller is in (see "One lock order" below). | `20261124094656_people_review_fixes.sql:91-112` |
| `private.claims_lock_bill_first` | definer trigger function | Calls `lock_bill_key_share` before any claim insert, including a direct insert that skips `set_claim`. | `20261124094656_people_review_fixes.sql:117-135` |
| `mark_bill_seen` | definer | Writes only the caller's own `bill_seen` row, only on a bill they're on. Same `not_allowed` for "not on it" and "no such bill". Bill lock first. Logs nothing, broadcasts nothing. | `20261124144925_bill_seen.sql`, `public.mark_bill_seen` |
| `my_bills` | definer | No arguments: the caller's bills for Home (at most 20), with the caller's own `added`, `seen`, `claimed_any` and the bill's `complete`. Takes no locks. | `20261124144925_bill_seen.sql`, `public.my_bills` |

`set_claim` is invoker **on purpose**. Claiming yourself is an ordinary insert that RLS already allows, so running as the caller keeps RLS in charge. Use definer only when a write genuinely needs more than the caller's rights.

**`set_item_split`'s guard list is its security boundary.** In order:
1. The caller is signed in.
2. The item exists **and** the caller is a participant of its bill. If not, `P0002`, the same error for both, so outsiders learn nothing.
3. The item row and its claims are locked (`for update`), so nobody can claim or unclaim it halfway through.
4. The caller has a claim on this item. If not, `42501`.
5. `p_parts` names **exactly** the current claimers, each with a whole number 1–20. If someone joined or left meanwhile: `22023 'claimers_changed'`, and the app refetches.
6. It updates `parts` on **this item's claims only**. It never adds or removes a claim and never touches another item.

### M2 review fixes to `update_bill` and `set_claim` (2026-11-22)
All in `supabase/migrations/20261122085802_m2_review_fixes.sql`, tested in `supabase/tests/database/m2_review_fixes.test.sql`. Applied migrations aren't edited; this one uses `create or replace` (see Pitfalls).

**`update_bill` refuses to merge items (R4, `:186-196`).** The host's edit sends every row, and kept rows carry their old id. Activity works out "what changed" by matching each new item to the old item its ids came from. If one new item kept ids from *two* old items, say the Burger row and the Fries row became one "Combo", there's no single "before" to compare against. So the function raises `22023 invalid_bill` and nothing changes, not even Activity. The app's form never sends this: each form row only keeps the ids of the one saved item it was loaded from (`lib/billPayload.ts`, `toBillArgs`). Test: `m2_review_fixes.test.sql:166-195`.

**`update_bill` says whose claims a lower quantity removed (R5, `:268-274`).** See [audit log](audit-log.md): the `item_changed` event gets `removed_claimer_ids`.

**`update_bill` logs discounts once (R1, `:284-298`).** `amounts_changed` carries only the two discount keys the bill has, `subtotal_discount_cents` and `total_discount_cents`.

**`set_claim` and a row deleted mid-claim (R6, `:100-108`).** `set_claim` first reads the item (to find its bill), then inserts the claim. In between, the host's `update_bill` might delete that item. The insert then fails its foreign key with `23503 foreign_key_violation`. The function catches that and raises `P0002 not_found` instead, the same error as "no such item". For the person tapping, both mean "that item isn't there any more", and the app already handles `not_found` by refetching so the item leaves the list (`app/(app)/bills/[id]/index.tsx:186`). `lib/bills.ts:99` maps both `P0002` and `23503` to `not_found`. The test fakes the race with a trigger that deletes the item just before the insert (`m2_review_fixes.test.sql:244-287`).

### The app re-checks claims before saving an edit
The database can't ask the host a question, so the "are you sure?" step lives in the app. When the host taps Save on the edit screen, the app **fetches the bill again** and runs `freshSaveCheck` (`lib/editBill.ts:92-122`, called at `app/(app)/bills/[id]/edit.tsx:156`):
- If the bill's `edited_at` or its set of row ids changed since the form opened, someone else's edit landed. The screen says "The bill changed while you were editing. Go back and try again." and doesn't save.
- Otherwise it rebuilds the save from the **fresh** claims. When a quantity goes down, unclaimed units are dropped first.
- If the save would still remove someone's claim that the host wasn't already asked about (for example Pat claimed a Beer unit while the host was typing), it asks first: "Lowering the quantity removes 1 claimed Beer. Continue?"

There's still a small gap: a claim that lands in the second between this re-read and `update_bill` isn't asked about. Activity still records it through `removed_claimer_ids`. Closing the gap is listed in `docs/before-production.md` §4. Tests: `lib/editBill.test.ts:80`.

### Owner-only state: the Venmo prompt (2026-11-24)
This is the smallest example of why a definer function is sometimes the *only* safe way in.

New users see a card on home: "Add your Venmo so friends can pay you", with "Add Venmo" and "Not now". Once they answer, it should never come back, on any device. So the answer is stored in the database, in `profiles.venmo_prompt_dismissed_at`.

That column has **no client grant at all**, not even for the owner. A column grant would apply to every row RLS shows, and co-participants can see your row ([row level security](row-level-security.md#profiles-the-venmo-username-and-data-only-the-owner-may-see-2026-11-24)). So the app can't `select` or `update` it directly. Both fail with `42501`.

Instead, two tiny definer functions do the one thing the app needs, on the caller's own row only:

```sql
-- Read: "should I show the card?"  (20261124072017_profile_venmo.sql:76-89)
select coalesce(
  (select p.venmo_username is null and p.venmo_prompt_dismissed_at is null
     from public.profiles p
    where p.id = (select auth.uid())),
  false
);

-- Write: "Not now"  (:100-119)
update public.profiles
   set venmo_prompt_dismissed_at = coalesce(venmo_prompt_dismissed_at, now())
 where id = v_uid and venmo_prompt_dismissed_at is null;
```

What makes them safe:
- **No parameters.** The row is always `auth.uid()`. You can't ask about, or dismiss for, someone else.
- **`venmo_prompt_pending` returns a boolean, not the timestamp.** Even the owner never sees the raw value. It's `false` when there's no row, so an odd state never nags.
- **`dismiss_venmo_prompt` is idempotent.** "Idempotent" means calling it twice is the same as calling it once: the first time wins, and later calls change nothing. It raises `42501` if nobody is signed in.
- **Execute is granted to `authenticated` only.** Signed-out callers get `42501`.

The app calls them through `lib/profile.ts:79-96` (`isVenmoPromptPending`, `dismissVenmoPrompt`), and the card is `components/VenmoPrompt.tsx`. `isVenmoPromptPending` treats any error as "not pending", so a network failure never shows the card.

#### A BEFORE trigger can set a column the caller can't
Saving a Venmo username should also count as answering the prompt. Otherwise, clearing the username later would bring the card back. A trigger does this (`20261124072017_profile_venmo.sql:50-69`):

```sql
create trigger profiles_stamp_venmo_prompt
  before update of venmo_username on public.profiles
  for each row
  execute function private.stamp_venmo_prompt();
-- inside the function:
--   if new.venmo_username is not null and new.venmo_prompt_dismissed_at is null then
--     new.venmo_prompt_dismissed_at := now();
```

The caller has no UPDATE grant on `venmo_prompt_dismissed_at`, yet the trigger can set it, even though the function is **invoker**. Why? Postgres checks column UPDATE privileges against **the columns listed in the statement's `SET`**. The app's statement is `update profiles set venmo_username = 'Hana-1' where id = ...`. Only `venmo_username` is in the `SET` list, and that column is granted. What a `BEFORE` trigger then changes in `NEW` isn't checked again.

The Postgres `UPDATE` docs say you need "the `UPDATE` privilege on the table, or at least on the column(s) that are listed to be updated". They don't mention triggers directly, so we proved it with a test: `supabase/tests/database/profile_venmo.test.sql:195-220` (criterion 11). Dee sets her username, the timestamp is stamped, and clearing the username leaves the card gone.

Because this works with invoker rights, the trigger function stays invoker (definer only when needed). It lives in `private`, with execute revoked from everyone.

Tests: `supabase/tests/database/profile_venmo.test.sql:96-129` (definer, `search_path`, grants, trigger), `:147-190` (pending, dismiss, idempotent, only your own row), `:330-333` (`anon` refused).

### Settling: `set_payer`, `mark_paid`, `unmark_paid` (M3, 2026-11-24)
These three run the Settle screen ([ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md)). Clients have no UPDATE grant on `bills` or `bill_participants`, so these are the only way to change who gets paid (`bills.payer_id`) or an "I paid" mark (`bill_participants.settled_at` and `settled_cents`).

**`set_payer(p_bill_id, p_payer_id, p_expected_cleared)`**, host only. In order:
1. Signed in, and you're the host of this bill. Otherwise `42501 not_allowed` (the same error for "no such bill", so a non-host can't probe ids).
2. Lock the bill row `for update`.
3. The new payer is a participant. Otherwise `22023 not_participant`.
4. If it's already the payer: stop. No error, no event, marks kept.
5. Count the bill's marks. If the count isn't `p_expected_cleared`: `22023 marks_changed`, nothing changes.
6. Clear every mark, set the new payer, log one `payer_changed { before, after, cleared }`.

**`mark_paid(p_bill_id, p_payer_id, p_cents)`**, for yourself. The checks run in a fixed order, because `lib/bills.ts` maps each error to its own message and a test pins the order (criterion 22):
1. Signed in, the bill exists, and you're a participant: else `42501 not_allowed`.
2. `p_cents` is a whole number 1–99,999,999: else `22023 invalid_amount`.
3. `p_payer_id` is still the payer: else `22023 payer_changed`.
4. You aren't the payer: else `22023 is_payer`.
5. The bill is complete (`private.bill_is_complete`): else `22023 not_complete`.
6. Set your mark, but only `where settled_at is null`. If you were already marked, that update touches 0 rows, so nothing changes and no event is logged. That makes a double tap harmless (it's **idempotent**: twice is the same as once).

**`unmark_paid(p_bill_id, p_user_id)`**: the host, the person themself, or the payer. Anyone else gets `42501` **before** the function looks at the target, so a disallowed caller learns nothing about whether that person is marked. An unmarked target is a no-op with no event.

`p_expected_cleared` and `p_payer_id` are **stale-state tokens**: the screen sends what it showed, and the function refuses if that's no longer true. That pattern has its own note: [stale-state checks](stale-state-checks.md).

**`private.bill_is_complete(p_bill_id)`** answers "does every `line_items` row of this bill have at least one claim?". It's the database copy of the app's `sharesComplete` (`lib/split.ts:210`), and both sides test the same cases (K1 to K6 in the spec).
- It's `security invoker` and lives in `private`, with execute revoked from every client role. Only `mark_paid` calls it, and `mark_paid` runs as the owner, so no grant is needed.
- One known difference from the app, kept on purpose: a proportional bill whose items are all $0.00 but whose total isn't. The app blocks settling (`blocked_all_zero`); this helper says "complete". See ADR 0015, "K6".

#### Locking order: `for update` vs `for share`
`select … for update` and `select … for share` lock the rows they read until the transaction ends. The two locks differ in **who else can get in** (Postgres docs, "Row-Level Locks"):

| Lock | Others may also take `for share` | Others may take `for update`, or `UPDATE`/`DELETE` the row |
|---|---|---|
| `for update` (exclusive) | no, they wait | no, they wait |
| `for share` (shared) | **yes**, at the same time | no, they wait |

Think of a meeting room. `for share` is "I'm reading the whiteboard": many people can read at once, but nobody may erase it. `for update` is "I'm rewriting the whiteboard": everyone waits outside.

How M3 uses that, always on the **bill row**:
- `set_payer` takes `for update`. It reads the mark count, then clears exactly those marks. While it holds the lock, any `mark_paid` or `unmark_paid` waits at its own `for share` step, so no mark can sneak in between "count" and "clear".
- `mark_paid` and `unmark_paid` take `for share`. Sam and Dee marking at the same moment both get the shared lock and don't wait for each other. But a `set_payer` already in progress makes them wait. When they continue, they read the *new* payer, so Sam gets `payer_changed` instead of saving a mark to the old payer.
- Once a function holds the bill lock, it locks or updates participant rows. That's always the same order: **bill first, then participant rows**.

**Why the order matters: deadlocks.** A **deadlock** is two transactions each holding a lock the other one needs, so neither can go on. Postgres notices, aborts one of them with `40P01 deadlock_detected`, and lets the other finish. The Postgres docs' advice is to take locks on several objects in the same order everywhere.

We have one known exception. When the payer's account is deleted, the `DELETE` locks their participant row first, and then the trigger `private.bill_participants_reset_payer` locks the bill (`20261124081411_settle_payer.sql:105-108`). `unmark_paid` does the opposite: bill, then participant row (`20261124081412_settle_marks.sql:134-150`). An account deletion at the same instant as an Undo of that payer's mark could deadlock. Account deletion isn't built yet, so this is tracked in `docs/before-production.md` §6 (review R9): take the locks in the same order, or retry on `40P01`.

> *Note 2026-11-24:* the People review (R1) found that claims didn't follow "bill first" either, because of locks Postgres takes on its own. That is fixed, and a second, smaller exception is left open. See "One lock order for every bill" below.

Tests: `supabase/tests/database/settle_payer.test.sql` (criteria 1–13: columns, invariant, account deletion, grants, `set_payer`), `supabase/tests/database/settle_marks.test.sql` (criteria 14–23: completeness K1–K6, `mark_paid`, `unmark_paid`, error order, grants).

### People you've split with: add, remove, leave (2026-11-24)
These run the "People you've split with" list and the Add people screen ([ADR 0016](../decisions/0016-people-come-from-shared-bills.md)). Clients still have no INSERT or DELETE on `bill_participants`, so these functions (plus `create_bill` and `join_bill`) are the only way onto or off a bill.

**`private.my_links()`: rule L1 in one place.** It returns one row `(user_id, bill_id, bill_created_at)` for every other person the caller is linked with, and the bill that links them (`20261124091041_people.sql:71-101`). A row counts as "active" when `added = false` (host or joined by link) or the person has a claim there. Two people are linked through a bill when both rows are active.
- It takes **no arguments** and always answers about `auth.uid()`. It can't be asked "who is Sam linked with?".
- It's `security invoker` with no client grant. Only `people_i_split_with` and `add_participant` call it. They are definer, so inside them the helper runs as the owner and reads past RLS. `auth.uid()` still means the caller, because it reads the caller's token (the `request.jwt.claims` setting), not the current database role.
- Because the rule exists once, the list and the "can I add them?" check can never disagree.

**`people_i_split_with()`.** Groups `my_links()` by person, counts the bills (`shared_bills`) and takes the newest bill date (`last_shared_at`). It joins `profiles` for the name and Venmo username, ranks (most bills together first, then most recent, then name, then id) and stops at 200 rows. Every row is someone the caller shares a bill with, so `profiles` RLS already lets the caller read that name and handle. The function reveals nothing new.

**`add_participant(p_bill_id, p_user_id)`.** In order:
1. Signed in, and you host this bill, else `42501 not_allowed`. The bill row is locked `for share`.
2. Already on the bill (the host included): stop. No row, no event, no error.
3. Not linked (L1), or an id that isn't a user: `22023 not_linked`, the same answer either way ([row level security](row-level-security.md#not_linked-a-privacy-story-2026-11-24)).
4. Insert the row with `added = true` (`on conflict do nothing`, so two adds at once give one row) and log one `participant_added`.

**`private.is_removable(bill, user)`: rule L3 in one place** (`20261124091042_membership.sql:43-63`). True only when the person is on the bill, isn't the host or the payer, has no claims and has no "I paid" mark. Same shape as `my_links`: invoker, no client grant, called only from the two definer functions below.

**`remove_participant(p_bill_id, p_user_id)`** (host) and **`leave_bill(p_bill_id)`** (yourself):
1. Signed in, and allowed (the host for remove; a participant for leave), else `42501 not_allowed`.
2. Lock the bill row `for update`, then the target's participant row `for update`.
3. Only then, in a new statement, check `is_removable`. Refuse with `22023 cannot_remove` / `cannot_leave`.
4. Delete the row and log one `participant_removed { user_id }` or `left {}`.

Because L3 refuses anyone with a claim, a mark or the payer role, the delete never cascades away a claim and never fires the payer-reset trigger. Nobody's share changes.

**Review fix R4: `leave_bill` checks before it locks.** The first version locked the bill `for update` before checking that you're on it. A stranger who knew a bill id could then make that bill's writers wait, call after call. Now a non-participant (or a missing bill) is refused with no lock taken, and a participant's checks are repeated under the lock (`20261124094656_people_review_fixes.sql:386-392`).

**Review fix R6: opening the link after being added counts as joining.** `join_bill` now flips an added row to `added = false` and logs one `joined` event (`20261124094656_people_review_fixes.sql:343-349`). A repeat join of an already-joined row still changes nothing.

Tests: `supabase/tests/database/people.test.sql` (L1 cases P1–P9, ranking R1–R5, criteria 1–14), `membership.test.sql` (L3 cases M1–M8, criteria 15–22), `people_review_fixes.test.sql` (lock order, R4).

### One lock order for every bill: the People review fix (R1, 2026-11-24)
This is the deadlock lesson from the M3 section, a second time, with a twist: **some locks are taken by Postgres itself, and they count too.**

#### Locks you don't write: foreign keys
When you insert a row that has a foreign key, Postgres checks the row it points to still exists, and locks that row with **`for key share`** until your transaction ends. That lock means "don't delete this row or change its key while I depend on it". (The Postgres docs describe `for key share` and its conflicts, but don't spell out that foreign-key checks take it. That part comes from Postgres's behaviour and our migration header; treat it as *unverified against the docs*.)

The full row-lock conflict table, from the Postgres docs ("X" = must wait):

| You ask for ↓ / someone holds → | `for key share` | `for share` | `for no key update` | `for update` |
|---|---|---|---|---|
| `for key share` | | | | X |
| `for share` | | | X | X |
| `for no key update` | | X | X | X |
| `for update` | X | X | X | X |

So `for key share` is the weakest lock: it waits only for `for update` (and a `DELETE`, which takes `for update`).

#### The deadlock R1 found
The membership migration's header said a claim locks only the participant row. But a claim insert does more, in this order:
1. **Claims' foreign keys** take `for key share` on the line item row and on Sam's participant row.
2. **A trigger logs the claim** in Activity (`claims_log_event` → `private.log_event`). Inserting that event checks `bill_events`' foreign key to `bills`, so it takes `for key share` on the **bills row**.

So a claim locks **participant row first, bill second**. `remove_participant` locks **bill first, participant row second**. Opposite orders:

| Time | Sam taps "claim Fries" | Hana taps "Remove Sam" |
|---|---|---|
| 1 | Claim insert: holds `for key share` on Sam's participant row | |
| 2 | | Holds `for update` on the bill row |
| 3 | | Wants `for update` on Sam's participant row: **waits for Sam** |
| 4 | Activity insert wants `for key share` on the bill row: **waits for Hana** | |

Each waits for the other. Postgres sees the cycle and aborts one with `40P01 deadlock_detected`. The same shape existed between `update_bill` (bill first, then line items and claims) and `set_claim` / `set_item_split` (item or claim rows first, then the bill through Activity).

#### The fix: lock the bill first (`20261124094656_people_review_fixes.sql`)
Every path that locks rows of one bill now takes the **bills row first**, then line items, participants or claims. That includes the implicit foreign-key locks.
- **`private.lock_bill_key_share(bill)`** (`:91-112`) takes `for key share` on the bills row, but only if the caller is on that bill, so nobody can use it to hold locks on other people's bills.
  - Why a helper? `for key share` needs the UPDATE privilege on the table (Postgres `SELECT` docs, Description: the locking clauses require "`UPDATE` privilege as well"), and clients have no UPDATE on `bills`. `set_claim` is invoker, so it can't lock inline. The helper is definer.
  - It's granted to `authenticated` because invoker code calls it. It lives in `private`, which the API doesn't expose, so the app can't call it directly.
- **`set_claim`** calls it before its insert or delete (`:166`).
- **`claims_lock_bill_first`**, a `BEFORE INSERT` row trigger on `claims` (`:117-135`), calls it too. A `BEFORE INSERT` trigger runs before the row is written and before any foreign-key check, so even a direct insert through the Data API (which skips `set_claim`) locks the bill first.
- **`set_item_split`** locks the bill before its `for update` on the line item (`:212-217`).
- **`join_bill`** takes `for key share` on the bill in its lookup, before it inserts or updates the participant row (`:333`).

Now replay the race. Sam's claim and Hana's remove both start at the bills row, so they **queue there**:
- **Sam first:** Hana's `for update` waits until Sam's claim commits. Her `is_removable` check (a later statement, so it sees committed rows) finds the claim and refuses with `cannot_remove`. The screen says "Couldn't remove them. They may have just claimed an item."
- **Hana first:** Sam's claim waits at the bill lock. When Hana commits, Sam's row is gone, the claim's foreign key fails with `23503`, and `set_claim` turns that into `P0002 not_found`. Sam's app refetches, and the bill is gone from his screen.

Either way: no deadlock, and no claim silently cascaded away. Claims still don't block each other (`for key share` doesn't conflict with `for key share`), nor `add_participant` or `mark_paid` (`for share`).

#### What's still open
- **A direct `DELETE` on `claims` through the Data API.** Postgres locks the claim row before any `BEFORE DELETE` trigger can run, then the Activity insert locks the bill. Against `update_bill` that's the old order. The app never does this (it unclaims through `set_claim`), but `authenticated` still has DELETE on `claims` because invoker `set_claim` needs it. Decision PI-R-3 keeps it for now; `docs/before-production.md` §4 has the fix (make `set_claim` definer, then revoke direct INSERT/DELETE).
- **Account deletion** (R9 above), still in `docs/before-production.md` §6.

**Why no test reproduces the deadlock.** pgTAP runs in one transaction on one connection, and a deadlock needs two. So `people_review_fixes.test.sql` checks the order instead: the function bodies call the bill lock before their writes, and at run time the helper runs while the claim row doesn't exist yet.

### The bill markers: `mark_bill_seen` and `my_bills` (2026-11-24)
These two run Home's "Hana added you to a bill" card and the "New" / "Nothing claimed yet" pills on bill rows (spec `docs/specs/2026-11-24-bill-markers-and-notices.md`). Both live in `supabase/migrations/20261124144925_bill_seen.sql`. They're the only way to reach the `bill_seen` table, which no client role has any privilege on ([row level security](row-level-security.md#read-state-is-owner-only-bill_seen-2026-11-24) explains why).

The app calls them through `lib/bills.ts` (`listMyBills` and `markBillSeen`). Home calls `markBillSeen` for each bill when you tap "Dismiss" (`app/(app)/index.tsx`, `dismissNotice`). The bill screen calls it once per visit, after the bill first loads (`app/(app)/bills/[id]/index.tsx`).

#### `mark_bill_seen(p_bill_id)`: "I've opened this bill"
In order:
1. **Signed in?** If not: `42501 not_allowed`.
2. **Are you on this bill?** A plain read of `bill_participants`, **with no lock**. If you aren't, or the bill doesn't exist: `42501 not_allowed`, the same message for both (BM-16), so a stranger can't use it to test which bill ids exist. Checking *before* locking means a stranger can't make the bill's real users wait either (the `leave_bill` lesson, R4 above).
3. **Lock the bills row first:** `private.lock_bill_key_share(p_bill_id)` takes `for key share` on the bill.
4. **Check again under the lock.** If the host removed you, or you left, between step 2 and step 3, you're refused here.
5. **Upsert your row:** `insert ... on conflict (bill_id, user_id) do update set seen_at = greatest(old, now())`. The first call makes the row; later calls move `seen_at` forward. `greatest` keeps it from going backwards if two calls overlap, because `now()` is the time the *transaction* started, not the moment of the write (BM-D-3).

**Every lock it takes, in order, including the ones Postgres takes by itself:**

| # | Lock | On | Written by us? |
|---|---|---|---|
| 1 | `for key share` | the **bills** row | yes, through `lock_bill_key_share` |
| 2 | `for key share` | your **`bill_participants`** row | no: the foreign key `bill_seen → bill_participants` takes it when the row is inserted |
| 3 | row lock | your existing **`bill_seen`** row | no: the upsert's `do update` locks the row it updates (only on a repeat call) |

So the order is **bills → bill_participants → bill_seen**, the same direction as every other function since the R1 fix. There's one lock it *doesn't* take: it writes no Activity event, so it never locks the bill a second time through `bill_events`' foreign key.

**What it can wait for.** `for key share` on the bill only waits for `for update`. So `mark_bill_seen` queues behind `remove_participant`, `leave_bill`, `update_bill` and `set_payer`, and runs side by side with claims, "I paid" marks and other people's `mark_bill_seen` calls.

**The other side: deletes now cascade one table further.** The foreign key is `on delete cascade`, so deleting a participant row also deletes that person's `bill_seen` row. `remove_participant` and `leave_bill` already lock the bill, then the participant row, then delete. The cascade adds `bill_seen` at the end of that chain. That's the same order as `mark_bill_seen`, and since their `for update` on the bill conflicts with its `for key share`, the two never run at the same moment on one bill. Account deletion still deletes participant rows without locking the bill first (the open R9 item); `bill_seen` adds one more row to that cascade but no new ordering. If a deletion races your own `mark_bill_seen`, the insert's foreign key fails with `23503`, and the function turns that into the usual `42501 not_allowed` (BM-D-4).

**What it never does:** log a `bill_events` row, send a broadcast, or change `bill_participants`. There's no trigger on `bill_seen`. Opening a bill is invisible to everyone else (BM-18).

The app treats it as fire and forget: if the call fails, nothing shows on screen, and "New" stays until the next successful visit (BM-17).

#### `my_bills()`: Home's list in one call
It returns up to 20 of the caller's bills, newest first by **when you joined or were added** (`joined_at desc`, then the bill's `created_at desc`, then `bill_id`). Each row has the bill's summary plus four facts the pills need:
- `added`: you were put on the bill by the host (not by opening the link);
- `seen`: you have a `bill_seen` row for it;
- `claimed_any`: you have at least one claim on it;
- `complete`: `private.bill_is_complete(bill)`, the same rule `mark_paid` uses. The "is it complete?" rule exists once, in SQL.

Like `people_i_split_with`, it takes **no arguments**, so it only ever answers about the caller. It's `stable` (reads only) and takes no row locks.

**Why it's cheap.** Three of those columns are small queries of their own: an `exists` on `bill_seen`, an `exists` on `claims`, and `bill_is_complete`, which checks every line item for a claim. Running them for every bill you've ever been on would get slower as you use the app. But they only run for the **20 rows that are returned**. The Postgres `SELECT` docs say that since 9.6, Postgres "will effectively evaluate output expressions after sorting and limiting, so long as those expressions are not referenced in `DISTINCT`, `ORDER BY` or `GROUP BY`". Our `order by` uses only `joined_at`, `created_at` and `id`, which are plain columns. So Postgres sorts your participant rows, keeps the first 20, and only then runs the three subqueries, 20 times at most. (We haven't looked at this query's `EXPLAIN` output; the docs' guarantee is the basis.)

That makes the 20-row limit do two jobs: it keeps Home short, and it caps the work. The limit lives only here, so `lib/` never slices the list. (Bills beyond the 20th can't be reached from Home yet: `docs/before-production.md` §4.)

**Why `host_name` doesn't leak anything.** `my_bills` is definer, so it could read any profile. It only reads the host's `display_name`, and the host is always a participant on their own bill, so that's a co-participant's name that `profiles` RLS already lets you read. The test checks this for every fixture user (criterion 10).

Tests: `supabase/tests/database/bill_markers.test.sql` (criteria 1–16). Criterion 7 is the lock order: pgTAP can't run two sessions, so, as with `people_review_fixes.test.sql`, it checks that the function body runs the participation check, then the lock helper, then the upsert.

**The `private` schema.** Helpers live in `private`, which isn't listed in `config.toml [api] schemas`, so the API can't call them directly (`20261121074115_bills_claims.sql:21-23`). RLS policies still can.

**RLS recursion.** A policy on `bill_participants` that queried `bill_participants` would trigger itself forever. The policy calls `private.is_bill_participant` instead, which is definer, so its own lookup skips RLS. See [row level security](row-level-security.md).

**Error contract.** Functions raise a fixed SQLSTATE plus a fixed message (`'not_allowed'`, `'invalid_bill'`, `'claimers_changed'`…). `lib/bills.ts:119-130` maps only those to app codes. Server text never reaches the screen.

Tests (pgTAP): `supabase/tests/database/bill_functions.test.sql`, `bill_edit_realtime.test.sql`, `item_split.test.sql`, `extras_split.test.sql`, `m2_review_fixes.test.sql`, `profile_venmo.test.sql`, `settle_payer.test.sql`, `settle_marks.test.sql`, `people.test.sql`, `membership.test.sql`, `people_review_fixes.test.sql`, `bill_markers.test.sql`. They check `prosecdef` (definer or not), `proconfig = {search_path=""}`, `anon` being refused, and each guard.

## Pitfalls
- **Making a function definer "to be safe".** It's the opposite: definer *removes* RLS, so every check becomes your job. Default to invoker.
- **Forgetting `search_path = ''`**, or setting it but writing `bills` instead of `public.bills`. Supabase's database linter flags a mutable search path *(the linter rule name is unverified)*.
- **Forgetting to revoke `execute` from `public`.** The function is then callable by signed-out users.
- **Trusting parameters.** A definer function must take the caller's identity from `auth.uid()`, never from a parameter. That's why `create_bill` has no host parameter.
- **Different errors for "not allowed" and "doesn't exist".** That tells an attacker which ids exist. Our functions return the same error for both.
- **Checking, then writing, without a lock.** Between the check "you're a claimer" and the update, someone could unclaim. Lock first (`select … for update`), then check.
- **Letting a race leak a raw error.** If a row can vanish between a read and a write (as in `set_claim`), catch the specific error and raise the function's normal one. Otherwise the app sees an unexpected code and shows a generic failure.
- **Granting a column so a function isn't needed.** If the data is for the owner only and other people can see the row, a grant leaks it to them. Use a no-argument definer function that works on `auth.uid()`'s row, as the Venmo prompt does.
- **Adding a grant so a trigger can set a column.** Not needed: column privileges are checked against the statement's `SET` list, not against what a `BEFORE` trigger changes. Prove it with a test rather than granting "just in case".
- **Taking locks in different orders in different functions.** Two transactions can then each hold what the other needs (a deadlock), and Postgres aborts one. Pick one order (for us: the bill row, then participant rows) and keep to it, including in triggers.
- **Forgetting the locks Postgres takes for you.** A foreign-key check locks the row it points to, and a trigger that writes Activity locks the bill through `bill_events`' foreign key. Count those when you check a lock order, as review R1 did.
- **Locking before checking who's asking.** If a function takes `for update` before it checks that the caller belongs, any stranger can make real users wait. Do the cheap "are you allowed?" check first, then lock, then check again under the lock (`leave_bill`, R4).
- **Writing a rule twice.** L1 and L3 each live in one helper (`my_links`, `is_removable`) that every function calls. Two copies drift apart, and then the list says "you can add Sam" while the add says `not_linked`.
- **Using `for update` when `for share` is enough.** An exclusive lock makes unrelated callers queue up (two people marking "I paid" at once). Use `for share` when you only need the row to stay the same, and `for update` when you're about to change something that depends on what you read.
- **Running per-row subqueries before the limit.** If an expensive column (an `exists`, a helper like `bill_is_complete`) also appears in `order by`, Postgres must compute it for every row before it can sort. Sort and limit on plain columns, as `my_bills` does, and the expensive ones run only for the rows you return.
- **Editing an applied migration to change a function.** Write a new migration with `create or replace` (as `20261121080352_bill_events.sql` does). If the argument list changes, `drop` and re-create, then re-grant.

## Check yourself
1. `set_claim` is invoker but `set_item_split` is definer. What can `set_item_split` do that RLS alone couldn't allow?
2. Why does `create_bill` read the host from `auth.uid()` instead of accepting a `p_host_id` parameter?
3. A function says `select … from bills` with `search_path = ''`. What happens, and why is that better than finding a table?
4. Why do a wrong join code and a badly formatted one return exactly the same error?
5. `update_bill` deletes a row, then fails validation on the money. What's in the database afterwards?
6. Pat taps "claim" on Fries at the same moment the host's edit deletes Fries. What error does Pat's app get, and why is it the same one as for an item that never existed?
7. Why does `update_bill` reject one new item built from the Burger row and the Fries row, even though the money could add up?
8. `venmo_prompt_pending()` takes no arguments. What could go wrong if it took a `p_user_id` instead?
9. Hana has no UPDATE grant on `venmo_prompt_dismissed_at`, but saving her Venmo username sets it. Why doesn't Postgres refuse with `42501`? What would happen if her statement listed `venmo_prompt_dismissed_at` in its `SET`?
10. Sam and Dee tap "I paid" at the same moment. Why don't they wait for each other? What changes if the host's `set_payer` is running at that moment?
11. `mark_paid` is called twice by the same person, a second apart. What stops a second Activity event from being logged?
12. Why does `unmark_paid` check "are you allowed?" before looking at whether the target is marked?
13. Describe the deadlock that could happen between deleting the payer's account and `unmark_paid`. What are two ways to fix it?
14. `private.my_links()` is security invoker and takes no arguments. Inside `add_participant` (definer), whose rows can it read, and whose links does it return? Why?
15. Sam taps "claim" at the same moment Hana taps "Remove Sam". Before the R1 fix, which two rows did each transaction lock, in which order? After the fix, what are the two possible outcomes?
16. Why does `set_claim` need a definer helper to take `for key share` on the bill, when the claim's own foreign key takes that kind of lock without any help?
17. Why does `leave_bill` check "are you on this bill?" once without a lock, and then again after locking?
18. List every row lock `mark_bill_seen` takes, in order, including the two Postgres takes by itself. Why does the bills row have to come first?
19. Sam has been on 300 bills. Roughly how many times does `my_bills()` run `bill_is_complete` when he opens Home, and why? What would change if the query said `order by complete, joined_at desc`?
20. Hana removes Sam from a bill at the same moment Sam's phone calls `mark_bill_seen` on it. What are the two possible outcomes, and why can't they deadlock?

## Learn more
- PostgreSQL, `CREATE FUNCTION`, "Writing SECURITY DEFINER Functions Safely": https://www.postgresql.org/docs/current/sql-createfunction.html
- PostgreSQL, privileges (default `EXECUTE` for `PUBLIC`): https://www.postgresql.org/docs/current/ddl-priv.html
- PostgreSQL, `UPDATE` (column privileges are checked on the columns "listed to be updated"): https://www.postgresql.org/docs/current/sql-update.html
- PostgreSQL, trigger behavior (`BEFORE` row triggers can change `NEW`): https://www.postgresql.org/docs/current/trigger-definition.html
- PostgreSQL, explicit locking (row-level lock modes and how they conflict; deadlocks and lock order): https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL, `SELECT` (the locking clauses need the `UPDATE` privilege; "SELECT List" says output expressions are evaluated after `ORDER BY` and `LIMIT`): https://www.postgresql.org/docs/current/sql-select.html
- PostgreSQL, `INSERT ... ON CONFLICT DO UPDATE` (the upsert `mark_bill_seen` uses): https://www.postgresql.org/docs/current/sql-insert.html
- PostgreSQL, error codes (`40P01 deadlock_detected`, `23503`, `42501`): https://www.postgresql.org/docs/current/errcodes-appendix.html
- Supabase, database functions: https://supabase.com/docs/guides/database/functions
- Supabase, calling functions from JavaScript (`rpc`): https://supabase.com/docs/reference/javascript/rpc
