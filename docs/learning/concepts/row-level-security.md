# Row Level Security (RLS)

## The idea
**Authentication** answers "who are you?" **Authorization** answers "what are you allowed to do?" In Supabase, the app talks to Postgres almost directly, so authorization has to live *in the database*. **Row Level Security** policies are SQL conditions Postgres attaches to every query, per row.

Once a table has RLS enabled, **no rows are visible by default**. Each policy allows a specific operation (`select`, `insert`, `update`, `delete`) when its condition is true. `auth.uid()` returns the signed-in user's id from their JWT.

Our real policies on `claims` (`supabase/migrations/20261121074115_bills_claims.sql:226-245`):
```sql
alter table public.claims enable row level security;

-- Everyone in the bill sees who claimed what
create policy "claims_select_participant" on public.claims
  for select to authenticated
  using (private.is_bill_participant(bill_id));

-- You can only add a claim for yourself, on a bill you're in
create policy "claims_insert_own" on public.claims
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_bill_participant(bill_id));

-- You can only remove your own claim
create policy "claims_delete_own" on public.claims
  for delete to authenticated
  using (user_id = (select auth.uid()));
```
(`(select auth.uid())` instead of a bare `auth.uid()` lets Postgres work it out once per query instead of once per row, which Supabase recommends for speed.)
- `using (…)`: which existing rows you can see or affect.
- `with check (…)`: what new or changed rows are allowed to look like. Without it, a user could update a row to hand it to someone else.

## Why it matters here
The anon key ships inside the app, so anyone can extract it. RLS is the only thing stopping someone from reading every bill, or claiming items as another person.

### The app is not the only client (important)
*Added 2026-11-24, after decision PI-R-3.*

It's tempting to think "the app never does X, so X can't happen". That's only true for things the **database** forbids. Anything the database *allows* can be done by anyone with a login, without the app:
1. The Supabase project URL and the anon (publishable) key are built into every copy of the app and the web bundle. Anyone can read them.
2. Anyone can sign in with Google and get their own session token.
3. With those two, they can call the same Data API the app uses (`curl`, a script, the browser console) and do **everything their grants and RLS allow**: read any row RLS shows them, write any table they have INSERT/UPDATE/DELETE on, call any function they can EXECUTE, in any order and at any time.

So the real boundary is **grants + RLS + database functions**, never the screens. The screens decide what's *convenient*; the database decides what's *possible*.

What this means in SplitIt today:
- **Safe because the database enforces it:** reading other people's bills, claiming as someone else, editing a bill you don't host, setting the payer, marking paid for someone else, adding people you aren't linked with. All of these are refused with `42501` or `22023`, whatever client sends them.
- **Possible, but only for yourself, because the database allows it** (decisions in `docs/decisions-to-review.md`):
  - **PI-R-3:** writing your own claims directly (bypassing `set_claim`). A direct delete at the same moment as the host's save can deadlock, and Postgres cancels one of them. Nothing is lost; one save fails and is retried. The user accepted this risk on 2026-11-24, assuming nobody uses the API directly. That assumption **isn't enforced**: it holds only as long as nobody tries.
  - **PI-M-1:** marking "I paid" when you owe nothing (the screen hides the button; the database accepts it).
  - **Honor-system marks (ADR 0015):** the marked amount only has to be between $0.01 and $999,999.99, not equal to your share.
  - **Raising your own mark with `settle_difference`** (2026-11-25, [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md)): you can record "I paid more", up to $999,999.99, whatever your share is. The same honor system as the first mark. Activity logs it.
  - **Lowering other people's marks, as the payer** (2026-11-25, ADR 0021): the payer can record "I paid you back" on anyone's mark, down to clearing it. This one *does* touch another person's row, which is why it's worth spelling out. It's accepted because it's strictly weaker than `unmark_paid`, which the payer already has (Undo clears a mark in one step), it's the payer's own statement about money the payer sent, it's logged in Activity with the payer as the actor, and the person sees the change on their Settle card.
  - **Replaying an old `settle_difference` call** (2026-11-25, review R8): the token compares amounts, so if a mark goes away and back to the same amount, an old call can match again and record a second step. Only a direct caller can do this; the app builds each call from fresh data. Fix later with a version number ([stale-state checks](stale-state-checks.md)).
  - *No longer on this list:* **K6** (marking paid on an all-$0 bill). Since 2026-11-25 the database refuses it with `22023 all_zero`, the same rule as the app (ADR 0021).
- **Not limited at all yet:** how *often* someone calls things. There's no rate limiting without a backend (`docs/before-production.md` §4).
- **Private because the database hides it, not because the screen does:** whether you've opened a bill. No screen shows the host who has looked at their bill, but that alone wouldn't be enough: if the data sat in a table the host can read, a script could read it. So it lives in `bill_seen`, which no client can read at all. See "Read state is owner-only: `bill_seen`" below.

The rule of thumb when reviewing a feature: *for every write, ask "what if someone calls this directly, with odd values, twice, at the same moment as someone else?"* If the answer is harmful to **another** person, the database must refuse it. If it only affects the caller (like PI-R-3), it can be an accepted risk, but write it down.

### Two layers: GRANTs, then RLS
Postgres checks permissions in two steps, and you need both:
1. **Privileges (`GRANT`)** decide whether a *role* may run the operation on the table or column at all, e.g. "`authenticated` may `select` from `profiles`" or "may `update` only the `display_name` column". If this fails, you get error `42501 permission denied`.
2. **RLS policies** then decide *which rows* that operation can see or touch. If a policy hides a row, there's no error. You just get 0 rows.

Supabase quietly grants broad privileges on the `public` schema to `anon` and `authenticated`, and relies on RLS to do the real filtering. M0 review finding R1 pointed out that our profile table depended on those hidden defaults. We now write the grants explicitly in the migration:
```sql
revoke all on public.profiles from anon, authenticated;            -- start from nothing
grant select on public.profiles to authenticated;                  -- RLS then limits to your own row
grant update (display_name) on public.profiles to authenticated;   -- column-level: can't change id or created_at
```
(That's the M0 version, `supabase/migrations/20261119055012_init_profiles.sql:42-44`. In M2 the SELECT grant was narrowed to two columns; see "Profiles: one policy, two readable columns" below.)

Explicit grants are **defense in depth**: if a policy is ever wrong, the grant still stops signed-out users entirely. They also document what each role may do in the place where people read the schema.

How to read test results: `42501` means the grant said no. "0 rows" means RLS filtered the rows out.

**This is now a project rule** in `CLAUDE.md` § Conventions: every table gets RLS **and** explicit grants (`revoke all on <table> from anon, authenticated, public`, then only what each role needs, per column for UPDATE where possible). Denied operations should fail with `42501`, and acceptance criteria expect that.

## How we use it
The bill tables (`supabase/migrations/20261121074115_bills_claims.sql`):

| Table | Grants to `authenticated` (`anon`: none) | RLS |
|---|---|---|
| `bills` | `select` | participants read (`:206-210`) |
| `line_items` | `select` | participants read (`:212-216`) |
| `bill_participants` | `select` | participants read (`:218-222`) |
| `claims` | `select`, `delete`, and `insert` of only `(bill_id, line_item_id, user_id)`. **No `update`.** | participants read; insert/delete your own (`:226-245`) |
| `bill_events` | `select` | participants read (`20261121080352_bill_events.sql:56-66`) |

Grants: `20261121074115_bills_claims.sql:267-276`.

- **No client writes on `bills`, `line_items` or `bill_participants` at all.** Those go through database functions such as `create_bill` and `join_bill` ([database functions](database-functions.md), [ADR 0013](../decisions/0013-writes-through-database-functions.md)).
- **Claims have no `UPDATE` grant.** Changing `parts` is only possible through `set_item_split`, which checks you're a claimer of that item. If `parts` were updatable, RLS could only say "your own claim". That's both too loose (you could set yourself to 1 part out of 20) and too strict (claimers need to set *each other's* parts). So, as P: `update claims set parts = 3` on P's own claim fails with `42501`.
- **The insert grant is per column.** You can't choose `parts`, `created_at` or `updated_at` on insert; they take their defaults.
- **A composite foreign key pins a claim to its item's bill.** `claims (line_item_id, bill_id) → line_items (id, bill_id)` means a claim can't say "bill X" while pointing at an item from bill Y, even if RLS were wrong (`:127-129`).
- **Co-participants read each other's display name, and nothing else.** See the next section.
- **Helpers live in the `private` schema**, which the API doesn't expose (`:21-23`). `is_bill_participant` and `shares_bill_with` are `security definer` so their lookup in `bill_participants` skips RLS. That avoids the recursion described below. They only ever answer questions about the *caller's* own memberships.

Tests: `supabase/tests/database/bills_rls.test.sql` (fixture users Hana, Pat, Rae, an outsider Oli, and Q in another bill), `bills_claims_smoke.test.sql`, `profiles.test.sql`, `m2_review_fixes.test.sql`.

### Profiles: one policy, two readable columns (M2 review, 2026-11-22)
Everyone in a bill needs to see the others' names ("Pat claimed Fries"). They don't need anything else from someone's profile. The M2 review fixes (`supabase/migrations/20261122085802_m2_review_fixes.sql`) tightened `profiles` with both layers:

**1. The grant: only `id` and `display_name` can be read** (`:54-55`):
```sql
revoke select on public.profiles from authenticated;
grant select (id, display_name) on public.profiles to authenticated;
```
This is a **column-level grant**. Before, `authenticated` could select every column (`created_at`, `updated_at` too), and RLS then picked the rows. Now the grant itself says which columns exist for that role:
- `select display_name from profiles` works (RLS still picks the rows).
- `select created_at from profiles` fails with `42501`, even on your own row.
- `select * from profiles` also fails with `42501`, because `*` asks for columns you have no grant on. Code must name its columns.
- `id` stays readable because RLS, joins and the app's embed need it (`bill_participants → profiles`), and so does the own-row `update ... where id = ...`.

The app only ever embeds `display_name` (`lib/bills.ts:70`, `lib/activity.ts:29`), so nothing in the app changed.

**2. The policy: one SELECT policy instead of two** (`:60-67`):
```sql
create policy "profiles_select_own_or_co_participant"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_bill_with(id));
```
Before, there were two permissive policies: `profiles_select_own` (M0) and `profiles_select_co_participant` (M2, the old `20261121074115_bills_claims.sql:250-254`, now dropped). Permissive policies for the same action are OR'ed, so they gave the same result. But Postgres evaluates each one on every query, and Supabase's performance advisor warns about "multiple permissive policies". One policy with an `or` gives the same rows with less work.

Who sees what, with the test's users (Hana hosts bill X; Pat and Rae joined it; Oli is in no bill with them):
- Pat reads the display names of Hana, Pat and Rae. Not Oli's.
- Oli reads only his own.
- Pat can still change his own `display_name` (`grant update (display_name)` is unchanged).

Tests: `supabase/tests/database/m2_review_fixes.test.sql:52-74` (grants and policy shape) and `:128-164` (what each user can read).

(Since 2026-11-24 there's a third readable column, `venmo_username`. See the next section.)

### Profiles: the Venmo username, and data only the owner may see (2026-11-24)
The Profile + Venmo slice added two columns to `profiles` (`supabase/migrations/20261124072017_profile_venmo.sql`):
- `venmo_username`: the handle friends pay you at, stored without the `@`. Co-participants **should** see it, because in M3 they'll pay you there.
- `venmo_prompt_dismissed_at`: when you answered the one-time "Add your Venmo so friends can pay you" card. This is **owner-only**. Nobody else needs to know when you tapped "Not now".

The first column was easy. The second one shows a limit of column grants.

**A column grant applies to every row RLS shows you.** A grant is about a *role* (`authenticated`), not about a person. It can't say "you may read this column, but only on your own row". So the two layers combine like this:
- The grant says *which columns* the role may read.
- The SELECT policy (`profiles_select_own_or_co_participant`) says *which rows*: your own, plus everyone you share a bill with.

The role can read every granted column on every visible row. If we had granted SELECT on `venmo_prompt_dismissed_at`, Pat could read when Hana dismissed her prompt, because Pat can see Hana's row.

So the migration grants the Venmo column and nothing for the prompt column (`:41-42`):
```sql
grant select (venmo_username) on public.profiles to authenticated;
grant update (venmo_username) on public.profiles to authenticated;
-- nothing at all for venmo_prompt_dismissed_at
```

What each user can do now:

| Column | Read | Change |
|---|---|---|
| `id`, `display_name` | own row and co-participants (unchanged) | `display_name` only, own row (unchanged) |
| `venmo_username` | own row and co-participants | own row only (the UPDATE policy `profiles_update_own` picks the row) |
| `venmo_prompt_dismissed_at` | nobody directly: `42501` | nobody directly: `42501` |

So how does the app know whether to show the card? Through two small `security definer` functions, `venmo_prompt_pending()` and `dismiss_venmo_prompt()`. They run with the table owner's rights, touch only the caller's own row (`id = auth.uid()`), and return a yes/no instead of the timestamp. See [database functions](database-functions.md#owner-only-state-the-venmo-prompt-2026-11-24).

**The rule:** if data is for the owner only, and other people can see the row, don't grant the column. Reach it through a definer function that only works on the caller's own row. (Another option is a separate table whose RLS allows only your own row. We didn't need one for a single timestamp.)

Tests: `supabase/tests/database/profile_venmo.test.sql:303-309` (`42501` on the prompt column), `:341-353` (Ben, who joined Ann's bill, reads her handle; Cal, who shares no bill, gets 0 rows), `:298-301` (Ann can't change Ben's handle: 0 rows).

#### Name your columns after an update, too
`supabase-js` lets you ask for the changed row back: `.update(...).eq(...).select(...)`. With no argument, `.select()` asks for `*` (the default in `node_modules/@supabase/postgrest-js/dist/index.mjs:608`), which becomes `returning *` in SQL.

On `profiles`, clients have no SELECT on `created_at`, `updated_at` or `venmo_prompt_dismissed_at`. So `returning *` fails with `42501` for **every** caller, including the owner saving their own handle. The live check in Task 6 hit exactly this (spec criterion 34's amendment). Postgres's privilege docs say SELECT is needed to "reference existing column values" in an UPDATE; they don't spell out `RETURNING` by name, so that part comes from what we saw in the live run.

The fix is to name the columns, as `lib/profile.ts:57-61` does:
```ts
supabase.from('profiles')
  .update({ venmo_username: value })
  .eq('id', userId)
  .select('venmo_username');   // not .select()
```

### `not_linked`: a privacy story (2026-11-24)
RLS answers "which rows may you see?". A `security definer` function skips RLS, so it has to answer that question itself, and it must never tell you more than RLS would. Error messages are the easy place to get this wrong. This story shows why `add_participant` gives one message for two different situations.

**The setup.** Hana hosts Friday dinners. Max got hold of one of her old invite links (someone forwarded it to the wrong group chat), joined that bill, and is now curious. He can make his own bills, so he's a host too, and he can call `add_participant(<his bill>, <some id>)` from a script with his own sign-in.

**What Max would like to learn.** Whether a given id belongs to a real SplitIt account. With a yes/no answer to that, he could test ids he found somewhere (an id in a screenshot, a guessed pattern), and slowly map out who uses the app. Checking guesses one by one until you learn which ones exist is called **enumeration**. The classic example is a sign-in page that says "no account with that email" for one address and "wrong password" for another: an attacker can test a list of emails and learn which ones have accounts, without ever logging in.

**What a careless function would say.** Imagine `add_participant` checked "does this user exist?" first and raised `not_found`, and only then checked "are you linked?" and raised `not_linked`. Then:
- an id that isn't anyone → `not_found`
- a real person Max isn't linked with → `not_linked`

That difference is exactly the yes/no Max wanted. The function would be an "is this a SplitIt user?" oracle, though it never adds anyone.

**What ours says.** Both cases raise the same `22023 not_linked`, with the same message (`supabase/migrations/20261124091041_people.sql:189-191`). The function never asks "does this user exist?" at all. It only asks "is this id in *my* links?" through `private.my_links()`, and a made-up id simply isn't there. pgTAP pins it: an unlinked real user and a random UUID get the identical error (`supabase/tests/database/people.test.sql:341-344`, criterion 13).

**The other doors are closed too.**
- **Not your bill?** A caller who isn't the host gets `42501 not_allowed` before the function looks at the target at all. So a non-host learns nothing about the target, not even `not_linked`.
- **Already on the bill?** That's a silent no-op. Only the host gets that far, and the host can already see who is on their own bill.
- **The list itself.** `people_i_split_with()` takes no arguments, so Max can only ever see *his own* linked people. Every row it returns is someone `profiles` RLS already lets him read (criterion 9). He can't ask "who does Hana split with?".
- **Ids are hard to guess anyway.** User ids are random UUIDs, and they only show up on bills you share. The single error is a second lock on a door that's already hard to find.

**What Max *can* do, honestly.** Because he joined one of Hana's bills with the link, he and Hana are linked (rule L1), so he can add Hana to his bills. Hana can leave each one, and the host can remove a stranger who hasn't claimed anything. A real block ("don't let Max add me") isn't built yet; it's tracked in `docs/before-production.md` §6 ([ADR 0016](../decisions/0016-people-come-from-shared-bills.md)).

**The rule:** when a definer function refuses, ask "could the *reason* I'm giving tell the caller something RLS would hide?". If yes, merge those reasons into one error. Our other functions already follow it: `join_bill` gives the same `invalid_code` for a wrong and a malformed code, and `rotate_join_code` gives the same error for "not the host" and "no such bill" ([database functions](database-functions.md)).

The app maps the error to one fixed sentence, "You can only add people you've split a bill with." (`lib/bills.ts:47`), which is true in both cases.

### Read state is owner-only: `bill_seen` (2026-11-24)
*Added with the bill markers slice (spec `docs/specs/2026-11-24-bill-markers-and-notices.md`, decisions BM-2 and BM-18).*

**What it's for.** When Hana adds Sam to a bill, Sam's Home shows a card ("Hana added you to a bill") and the bill's row says "New". Once Sam opens the bill, "New" goes away. To know that, the database has to remember "Sam has opened this bill". That's **read state**: who has looked at what.

**The privacy rule.** Read state belongs to the reader. Nobody else, the host included, ever learns whether Sam opened the bill. No "seen by Sam" ticks, no **read receipts**. (A read receipt is any way for one person to learn when another person looked at something, like the "Read 9:41" line in a chat app.)

**The obvious design, and why it's wrong.** The quick idea is a `last_seen_at` column on `bill_participants`, since that table already has one row per person per bill. It would leak in two ways:
1. **Everyone on the bill could read it.** `authenticated` has a table-level SELECT on `bill_participants` (`supabase/migrations/20261124091041_people.sql`), and the SELECT policy shows every participant's row to every other participant. That's how the bill screen lists who's on the bill. So Hana could run `select user_id, last_seen_at from bill_participants where bill_id = ...` and see exactly when Sam looked. A column grant can't fix this, because a column grant applies to every row RLS shows you (see "A column grant applies to every row RLS shows you" above).
2. **Writing it would ring a doorbell.** Every UPDATE on `bill_participants` fires the trigger `bill_participants_broadcast_update` (`supabase/migrations/20261124081411_settle_payer.sql`), which tells every open bill screen "something changed, refetch" ([realtime](realtime.md)). So each time Sam opened the bill, Hana's screen would refetch. Even with the column hidden, the timing is a signal: "the screen just blinked, Sam must have opened it". That's a read receipt by **side channel**: information leaking through something other than the data itself (here, timing).

**What we built instead** (`supabase/migrations/20261124144925_bill_seen.sql`):
- A separate table `public.bill_seen (bill_id, user_id, seen_at)`, one row per person per bill they've opened (or whose notice they dismissed).
- **No client privileges at all**, not even for the owner: `revoke all on table public.bill_seen from anon, authenticated, public`, and no grant afterwards. Any `select`, `insert`, `update` or `delete` from the app or a script fails with `42501`, even on your own row.
- **RLS enabled with no policies**, as a second layer. If a grant were ever added by mistake, RLS would still show 0 rows.
- **Two `security definer` functions are the only way in** ([database functions](database-functions.md#the-bill-markers-mark_bill_seen-and-my_bills-2026-11-24)):
  - `mark_bill_seen(bill)` writes *your* row, and only on a bill you're on.
  - `my_bills()` returns *your* bills with *your* `seen` as a yes/no. It has no parameter, so you can't ask about anyone else.
- **No trigger on `bill_seen`, no Activity event, no broadcast, and no change to `bill_participants`.** Opening a bill is invisible to everyone else. A pgTAP test checks that a `mark_bill_seen` call leaves the bill's Activity and the caller's `bill_participants` row exactly as they were, and that the table has no triggers.
- A foreign key `(bill_id, user_id) → bill_participants on delete cascade`. When Sam leaves, is removed, or deletes his account, his seen row goes too. If Hana adds him again, the bill starts as "New" again, which is right.

This is the same rule as the Venmo prompt timestamp above, one size bigger: owner-only data gets **no grant**, and a definer function that works only on `auth.uid()`'s rows is the only door. The Venmo prompt was one timestamp per person, so a column on `profiles` with no grant was enough. Seen state is one row per person *per bill*, so it gets its own table.

**Tie-back to "The app is not the only client".** The screens never show anyone's seen state, but that isn't what keeps it private. A curious host with a script can call anything their grants allow. Because `bill_seen` has no grant, there's nothing to call. And because writing it touches nothing anyone else can see or hear (no broadcast, no event, no `bill_participants` change), there's no timing to watch either. When you add any "did they look?" feature, ask both questions: *can another person read it?* and *does writing it make anything visible to another person?*

Tests: `supabase/tests/database/bill_markers.test.sql` (criteria 1–16: the table's shape and grants, `42501` on direct reads and writes, the no-side-channel check, and what `my_bills()` returns to each user).

## Pitfalls
- **Forgetting to enable RLS on a new table** means it's readable by everyone. Every migration that creates a table should enable RLS in the same file.
- **Infinite recursion:** a policy on `bill_participants` that queries `bill_participants` loops forever. The standard fix is a `security definer` helper function that runs with the owner's rights, has `set search_path = ''`, and is used inside policies. Ours is `private.is_bill_participant(bill_id)` (`20261121074115_bills_claims.sql:157-170`).
- **Joining by code:** users aren't participants until they join, so they can't read the bill to find it. Joining goes through the `security definer` function `join_bill(code)`, which checks the code and inserts only the caller's participant row (`20261121080352_bill_events.sql:304-340`). Don't open up `select` on bills to everyone.
- **Granting `update` on a whole table "because RLS limits the rows".** RLS limits *which rows*, not *which columns* or *which values*. Use column grants, or no grant plus a function (as with `claims.parts`).
- **Two permissive policies for the same action** are OR'ed. That's correct, but each one is evaluated on every query, and Supabase's performance advisor warns about it. Prefer one policy with `or`, as `profiles` now has.
- **RLS can't hide columns.** A policy picks *rows*. If a co-participant may see your name but not your timestamps, that's a column grant, not a policy.
- **`select *` on a table with column grants fails** with `42501`. Name the columns you need. The same goes for a bare `.select()` after `.update()` in `supabase-js`: it means `returning *`, and fails on `profiles` even for the owner.
- **Granting a column "because RLS only shows the right rows".** RLS shows co-participants your row, so every granted column is visible to them. Owner-only data (like `venmo_prompt_dismissed_at`) gets no grant and goes through a definer function instead.
- **The service-role key bypasses RLS completely.** Only use it in trusted server-side places (the Supabase CLI and dashboard, or an Edge Function if we ever add one), never in the app.
- Testing only as the owner. Always test as a *second* user, who should be denied.
- **"The app never does that."** The app isn't the only client: anyone signed in can call the Data API directly with the public key. If a rule matters, the database must enforce it; otherwise record it as an accepted risk (see "The app is not the only client").
- **A definer function's errors saying more than RLS would.** "No such user" vs "not linked" tells a caller which accounts exist. Give one error for every case the caller isn't allowed to tell apart, and test that they're identical (`add_participant`'s `not_linked`).
- **Hiding private data but leaking it through a side effect.** Data no one else can read can still leak if writing it fires a broadcast, logs an event or updates a row others can see. Then the *timing* gives it away. Private writes (like `mark_bill_seen`) go to a table with no triggers and touch nothing shared.

## Check yourself
1. What's the difference between `using` and `with check`?
2. Why does joining a bill by code need a function instead of a plain `insert`?
3. A new table `comments` was added without `enable row level security`. Who can read it?
4. Why do clients have no `UPDATE` grant on `claims`, even on their own claim?
5. Pat and Oli are in no bill together. Can Pat read Oli's display name? What changes if they both join the same bill?
6. As Pat, a test runs `update bills set total_cents = 0`. Do you expect `42501` or "0 rows", and why?
7. As Pat, `select created_at from profiles where id = <Pat's own id>` fails. Which layer said no, and why couldn't an RLS policy alone have done this?
8. Why can't we just `grant select (venmo_prompt_dismissed_at)` and let RLS keep it private? Who would be able to read Hana's value?
9. Hana saves her handle with `.update({ venmo_username: 'Hana-1' }).eq('id', hanaId).select()`. It fails with `42501` although it's her own row. Why, and what's the fix?
10. `add_participant` returns `not_linked` both for a real user you aren't linked with and for an id that isn't anyone. What could a curious host learn if those two cases had different errors?
11. Why does `add_participant` check "are you the host?" before it looks at the person being added?
12. The app only ever unclaims through `set_claim`. Can a signed-in user still delete their own claim row without the app? What stops them deleting *someone else's* claim?
13. Why isn't "Sam has opened this bill" a `last_seen_at` column on `bill_participants`? Give both reasons: one about who can read it, one about what writing it would set off.
14. Sam runs `select seen_at from bill_seen where user_id = <his own id>` from a script. What does he get, and why? How does the app learn his `seen` value, then?

## Learn more
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL privileges and column grants: https://www.postgresql.org/docs/current/ddl-priv.html
- PostgreSQL, `GRANT` (column privileges): https://www.postgresql.org/docs/current/sql-grant.html
- PostgreSQL, `UPDATE` (which privileges an update needs): https://www.postgresql.org/docs/current/sql-update.html
- supabase-js, `.select()` after a write: https://supabase.com/docs/reference/javascript/update
- Supabase, database advisors (incl. "multiple permissive policies"): https://supabase.com/docs/guides/database/database-advisors
- OWASP, Authentication Cheat Sheet ("Authentication and Error Messages": generic responses so attackers can't tell which accounts exist): https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
