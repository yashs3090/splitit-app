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
  - **Choosing any payment method for your own mark** (2026-11-27, [ADR 0024](../decisions/0024-sent-via-venmo-and-payment-methods.md)): a direct caller can mark "Sent via Venmo" without opening Venmo, or "Paid in cash" for a Venmo payment. Methods are self-reported, like the mark. The database only checks that the method is one of `venmo`, `cash`, `other` (`private.is_payment_method`), and nobody can set a method on someone else's row. The app writes `venmo` only from the Pay tap and from "Yes, I sent it".
  - **"Not received" on someone else's mark, as the payer** (2026-11-27, ADR 0024): `mark_not_received` clears another person's mark and puts a warning on their card. Like "I paid you back", it's no stronger than `unmark_paid`, which the payer already has; it's logged with the payer as actor; and it only works on the person's **current** mark, named by its exact cents **and** `settled_at` (`p_expected_cents`, `p_expected_at`). So a replayed old call can't clear a newer payment of the same amount ([stale-state checks](stale-state-checks.md), "Amount and time together").
  - **The payer's silent `unmark_paid`** (SV-26): in the app the payer now gets "Not received" instead of Undo, so the person is told. But the database still lets the payer call `unmark_paid` directly, which clears a mark with only an Activity line. Kept on purpose for this slice. Once there are several payers ([ADR 0023](../decisions/0023-several-payers.md)), `unmark_paid` will need a "to whom" argument (`docs/before-production.md` §4). *(Note 2026-11-27: done. It's now `unmark_paid(bill, user, payer)`, and it deletes only that pair's current mark. The silent clear itself is still allowed.)*
  - **Who paid, as a direct caller** (2026-11-27, ADR 0023): the host can set any valid split (checked and logged exactly as from the app); anyone can stamp any well-formed plan key on their own payment (it can only re-plan routes, never change what anyone owes); a former payer can pay back on a pair they received. See "The payments ledger" below.
  - **A repeated `mark_paid`** returns `created = false` and changes nothing. That's what stops the app opening Venmo twice; it isn't a security check, and a direct caller gains nothing by repeating it.
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

### Shared facts on the shared row, private choices on the device (2026-11-27)
The Sent via Venmo slice added four columns to `bill_participants`: how a mark was paid (`settled_method`) and the "Not received" flag (`not_received_cents`, `not_received_method`, `not_received_by`). Everyone on the bill can read them, and writing them broadcasts a "changed" hint. That's fine, because they're **shared facts**: the same thing already shows in Activity ("Sam sent Hana $15.10 via Venmo", "Hana hasn't received Sam's $15.10"), and the other people on the bill are meant to see them. No grant changed. No client can write them directly (`42501`); only `mark_paid`, `settle_difference`, `mark_not_received`, `unmark_paid` and `set_payer` do.

The **remembered** choice ("last time I picked Cash") is different: it's a private preference. A column on `profiles` would be readable by everyone you share a bill with. So it stays on the device (`splitit.payMethod.v1.<userId>`), as do the check-in answers (SV-18). The test for where data goes is the same as for `bill_seen`: *who can read it, and does writing it make anything visible to someone else?*

*Note 2026-11-27 (Who paid, [ADR 0023](../decisions/0023-several-payers.md)): these four columns, and `settled_at` / `settled_cents`, no longer exist. Marks moved to `bill_payments` and flags to `bill_payment_flags` (migrations `20261127140000`–`140002`). They're still shared facts, readable by everyone on the bill. See the next-but-two section.*

### Groups: co-members, member-only tables, and assigning as a definer-only write (2026-11-27)
*Added with the Groups MVP ([ADR 0022](../decisions/0022-groups.md), spec `docs/specs/2026-11-26-groups-mvp.md`).*

**Co-members can read each other's profile.** Members of one group need each other's names and Venmo usernames to pay each other, even with no shared bill (user decision U-G5). So the groups migration (`supabase/migrations/20261126082511_groups.sql`) replaced the profiles SELECT policy with one that adds a third case:
```sql
create policy "profiles_select_own_or_co_participant_or_co_member"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or private.shares_bill_with(id)
    or private.shares_group_with(id)
  );
```
Still **one** permissive policy, so the advisor warning from 2026-11-22 doesn't come back. The **column grants didn't change**: co-members see `id`, `display_name` and `venmo_username`, exactly what co-participants see, and `select *` still fails with `42501`. Example: Ana and Dee are in "Tahoe trip" but never on the same bill. Dee can read Ana's name and handle. Oli, in no group or bill with Ana, gets 0 rows.

**Group tables: members read, nobody writes.** `groups`, `group_members`, `group_events`, `expenses`, `expense_shares` and `group_payments` each have RLS on, `revoke all … from anon, authenticated, public`, a `grant select` to `authenticated`, and one policy `using (private.is_group_member(group_id))` (on `groups` itself, `id`). A non-member gets 0 rows. There is **no INSERT, UPDATE or DELETE grant** on any of them, so a direct write fails with `42501`. Every change goes through a `security definer` function (`create_group`, `add_expense`, `record_payment`, …) that checks membership and the rules itself ([ADR 0013](../decisions/0013-writes-through-database-functions.md)). `group_hidden` ("Hide for me") has no client grant at all, like `bill_seen`: it's private to you and read only through `my_groups()`.

**Assigning items: the one exception to "write only your own claims".** On a bill in a group, any member may set who had an item (U-G6). The claims RLS policies weren't loosened to allow this. They still let you write only your own claim, on every bill. Instead, `assign_item` is a `security definer` function (`supabase/migrations/20261127062139_assign_item.sql`). It runs as the owner, so it can write other people's claims, and it makes its own checks first:
- the bill is in a group, and the caller is a member of that group;
- every person being assigned is a member;
- the claimers the screen showed still match (`p_expected`, a [stale-state check](stale-state-checks.md)).

A bill that isn't in a group, a caller who isn't a member, and a bill that doesn't exist all get the same `42501 not_allowed`, so the call can't be used to learn which bills exist (the `not_linked` rule above). Every assignment is logged as "Ana assigned Tacos to Ben". That's why it's safe to give the power to a function: the function is the only door, and it can only do this one thing. Granting `authenticated` INSERT on other people's claims would have opened it on every bill.

Tests: `supabase/tests/database/groups.test.sql` (criteria 8, 9, 12), `assign_item.test.sql` (criteria 38–43).

### "I wasn't part of this": `bill_not_part`, owner-only with an own-rows read (2026-11-27)
*Added with `docs/specs/2026-11-27-group-claim-status.md` (contract C3, decisions GCS-3 and GCS-4). Migration: `supabase/migrations/20261127150000_bill_not_part.sql`.*

**What it's for.** On a group bill, Ben can say "I wasn't part of this" so the app stops reminding him to claim. The database has to remember that per person, per bill. It's private, like "seen": nobody else needs to know, and Ana shouldn't be able to tell that Ben opted out (GCS-3).

So it's the **second owner-only per-person table**, after `bill_seen`. Same questions, same answers: *can another person read it?* No. *Does writing it make anything visible to another person?* No: no Activity line, no Realtime message, no change to any shared row.

**One difference from `bill_seen`: the owner can read their own rows.**
- `bill_seen` has no grant at all. Even Sam's own `select` fails with `42501`, and the app learns "seen" only through `my_bills()`.
- `bill_not_part` has `grant select (bill_id, user_id, created_at) to authenticated`, plus one policy, `using (user_id = (select auth.uid()))`. Ben's `select` returns only his own rows. Ana running the same query on the same bill gets 0 rows, even though she's on that bill. `anon` has no grant, so its `select` fails with `42501`.

Why allow the read here? The bill screen needs to know "did I opt out of this bill?" (`fetchNotPart` in `lib/groups.ts`). A plain own-rows read does that with no new function. It's safe because the policy can only ever show your own rows, so the column grant can't leak to co-participants (compare "A column grant applies to every row RLS shows you" above: here RLS shows you only your rows).

**Nobody writes it directly.** There's no INSERT, UPDATE or DELETE grant, so a direct write (or an upsert) fails with `42501`. The only writer is `set_not_part(bill, not_part)`, a `security definer` function that works only on the caller's own row ([database functions](database-functions.md)):
- signed out, null arguments, no such bill, or not a participant: all the same `42501 not_allowed` (one answer, so it can't be used to find bills);
- `true` on a bill outside a group: `22023 not_in_group`;
- `true` when you've claimed anything on the bill: `22023 has_claims` ("claims win");
- `false` always works for a participant, group or not, so an old opt-out can always be cleared.

**A trigger on `claims` keeps it honest.** `claims_clear_not_part` runs after every insert into `claims` and deletes the claimer's `bill_not_part` row for that bill. It catches every way you can get a claim: claiming yourself (`set_claim`, `set_item_split`), someone assigning you (`assign_item`), or a direct insert (GCS-4). Example: Ben opted out of the dinner; Ana assigns him the Nachos; his opt-out is gone, so if the Nachos are later taken off him, the reminder comes back. The trigger function is `security definer` with EXECUTE revoked from every client role. On the installed Postgres 17, a trigger function's EXECUTE is checked only when the trigger is created, not when it fires, so inserts by `authenticated` and `service_role` still work (the migration header says it was checked, and the pgTAP test proves both).

**It goes away with the participant row.** A foreign key `(bill_id, user_id) → bill_participants on delete cascade`, the same shape as `bill_seen`. Leaving, being removed, deleting the bill or deleting the account all remove it. There's no foreign key to `profiles` or `auth.users`, so it doesn't block account deletion.

**How the group screen gets it.** `group_snapshot` (a definer function) returns `me.not_part_bill_ids`: only the caller's own opt-outs for that group's bills, never anyone else's.

Tests: `supabase/tests/database/bill_not_part.test.sql` (criteria 1–11: grants and `42501`s, own rows only, the function's errors, the trigger on three insert paths, the snapshot field, the cascade).

### The payments ledger: tables nobody writes, not even `service_role` (2026-11-27)
*Added with Who paid ([ADR 0023](../decisions/0023-several-payers.md), spec `docs/specs/2026-11-26-who-paid.md` A1.3). Migrations: `supabase/migrations/20261127140000_bill_payments.sql` and `20261127140002_who_paid.sql`.*

Three new tables hold money facts:
- `bill_payments`: one row per money movement ("Priya sent Sam $12.00 via Venmo"). A **ledger**: rows are added, never changed ([who pays whom](who-pays-whom.md)).
- `bill_payment_flags`: "Not received" flags.
- `bill_payers`: who paid the restaurant how much, on a split bill.

**Reading: everyone on the bill, nobody else.** Each table has RLS on and one policy, `for select to authenticated using (private.is_bill_participant(bill_id))`. Payments are shared facts, like claims: Dee should see that Sam paid Hana. An outsider gets 0 rows. `anon` has no grant, so its `select` fails with `42501`.

**Writing: no grant for anyone, `service_role` included.** The migrations say:
```sql
revoke all on public.bill_payments from anon, authenticated, public, service_role;
grant select on public.bill_payments to authenticated;
```
Note the fourth role. Earlier tables only revoked `anon`, `authenticated` and `public`, so Supabase's default privileges still let `service_role` write them (`docs/before-production.md` §4). Here it's revoked too, the same stance as `bill_events` and `group_payments`. Why go that far?
- **`service_role` skips RLS, but not grants.** Supabase's docs say the API uses this role "to bypass Row Level Security", so policies don't stop it. (In Postgres terms that's a role with the `BYPASSRLS` attribute; that it's this attribute is *unverified* against Supabase's docs.) A missing **grant** still stops it: Postgres checks privileges first (the "Two layers" section above). Revoking is the only way to say "not even the service key".
- **A forged payment is a money lie.** If any key could insert "Sam sent Hana $50", Settle up would tell Hana she's been paid. Nothing legitimate writes the ledger except our security definer functions (`mark_paid`, `settle_difference`, `unmark_paid`, `mark_not_received`, `set_payer(s)`), which run as the owner (`postgres`) and so don't need a grant.
- So a direct `insert`, `update`, `delete` or `truncate` from any client role fails with `42501`.

**And rows can't be updated, even by the owner.** A grant can't stop the table's owner, and the definer functions *are* the owner. So the first migration adds a trigger:
```sql
create trigger bill_payments_no_update
  before update on public.bill_payments
  for each row
  execute function private.bill_payments_no_update();  -- raises 42501 payments_are_immutable
```
A row trigger fires for every role, so no function written later can quietly "fix" a payment's amount. The only changes allowed are an insert (a new movement) and a delete (Undo or "Not received", which mean "this never happened"). This is the same idea as the append-only guard on Activity ([audit log](audit-log.md)).

**What a direct caller can still do** (honor system, recorded in the migration headers):
- the host can set any valid split, checked and logged as from the app;
- anyone can record a payment from themselves to any current payer, as in ADR 0015;
- anyone can stamp any well-formed plan key on their own payment. The database only checks the format (16 lowercase hex). A wrong key only makes routes re-plan; positions always count every payment, so nobody's amount changes;
- a former payer can pay back on a pair they received (they may be holding someone's money).

Tests: `supabase/tests/database/bill_payments.test.sql` and `who_paid.test.sql` (`42501` on every direct write as `authenticated`, `anon` refused, 0 rows for an outsider, the no-update trigger).

### Usernames: readable by co-people, written only through an RPC (2026-11-28)
*Added with the usernames groundwork ([ADR 0026](../decisions/0026-usernames.md), spec `docs/specs/2026-11-28-usernames.md`). Migration: `supabase/migrations/20261128070000_usernames.sql`.*

`profiles.username` (`@yash_s`) splits the two layers in a new way: **one role may read the column but not write it.** The migration grants `select (username)` to `authenticated`, and nothing else. No policy changed, so the existing row policy decides who sees it: you, people you share a bill with, people you share a group with. That's exactly who sees your display name. A stranger gets 0 rows, and anon gets `42501`.

There's no `update (username)` grant, not even for the owner. So `update profiles set username = 'yash_s' where id = <own id>` fails with `42501`. Compare `venmo_username`, which has a column UPDATE grant. Why the difference? The only way in is `set_username`, a definer function ([database functions](database-functions.md), "`set_username`: turning a constraint name into an error code"). It gives the app separate answers for "taken", "reserved" and "invalid", which a direct update can't. It also writes only the caller's own row, because it reads the row id from `auth.uid()`, not from a parameter.

So: **read** is a column grant plus the row policy; **write** is no grant plus one function. Use this shape whenever co-people should see a value but changing it needs checks a grant can't express.

The username rule widens only through a function too. Search, when built, will be one exact-match definer function that returns a few columns, never a looser `profiles` policy (ADR 0026, "Later: search").

Tests: `supabase/tests/database/usernames.test.sql` (criteria 7–9: co-participant and co-member reads, 0 rows for a stranger, `42501` for anon and for a direct update, the column privileges).

### The Activity feed: privacy that is only a display rule (2026-11-28)
*Added with the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md), spec `docs/specs/2026-11-28-tab-bar-and-activity.md` risk R1). No migration.*

The Activity tab shows amounts only for your own money: "Sam marked $18.20 paid to you". It never shows "Sam marked $18.20 paid to Maya". That rule is in `classifyFeedEvent` (`lib/feedRules.ts`), and the tests check it on every fixture.

**But the database doesn't enforce it.** The feed reads `bill_events` and `group_events` with the existing policies (`bill_events_select_participant`, `group_events_select_member`). They show every participant every event row on their bills, amounts and all. That's on purpose: the per-bill Activity screen already shows "Sam marked $18.20 paid to Maya" to everyone on the bill, and payments are shared facts (like the ledger above). So a person with a script and their own login can read the same amounts the feed leaves out.

So the feed's rule is a **display rule**: it decides what the timeline is about (you). It isn't a **security boundary**: it doesn't make anyone's payments secret. The test from "The app is not the only client" gives the answer straight away. *Can another person read the row?* Yes. Then hiding it on one screen doesn't make it private.

Compare the feed's seen state. It's truly private, but not because of RLS: it never reaches the database at all. It lives on your phone (`lib/feedSeen.ts`, FEED-30), so there's nothing for anyone else to read, and writing it touches nothing shared.

If amounts between other people ever have to be private, the fix belongs in the database: a narrower policy, or a definer read function that leaves them out. Changing the app alone wouldn't help. The question is open for the user before real users arrive (`docs/before-production.md` §4).

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
- **Forgetting `service_role` in the revoke.** `revoke all … from anon, authenticated, public` leaves Supabase's default grants for `service_role`, and it skips RLS. For tables only definer functions should write (the ledger), revoke it too.
- **Relying on grants to stop the owner.** Definer functions run as the owner, and grants don't apply to it. If rows must never change, say so with a `before update` trigger that raises (`bill_payments_no_update`).
- **Calling a display rule "privacy".** If the policy lets someone read a row, a screen that doesn't show it hides nothing. Write it down as a display rule (like the Activity feed's amounts), or enforce it in the database.
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
15. The new `settled_method` and `not_received_*` columns are on `bill_participants`, which every participant can read. Why is that fine here, when "seen" had to go in its own table?
16. Hana, the payer, calls `mark_not_received` from a script with Sam's old cents and time after Sam has paid again. What happens? What could she still do directly that the app no longer offers her?
17. Dee and Ana share a group but no bill. Can Dee read Ana's `venmo_username`? Can she read Ana's `created_at`? Which layer decides each answer?
18. Ana assigns the Tacos to Ben on a group bill. Why does that go through `assign_item` instead of a change to the claims RLS policy? What would go wrong with the policy change?
19. `bill_not_part` grants `select` to `authenticated`, but `bill_seen` grants nothing. Why is the grant safe for `bill_not_part`? What does Ana get if she selects Ben's opt-out on a bill they share?
20. Ben opted out of a bill, and then Ana assigns him an item on it. What removes his opt-out, and why is it a trigger on `claims` rather than a check inside `set_not_part`?
21. A script holding the service-role key runs `insert into bill_payments …`. What happens, and why doesn't skipping RLS help it?
22. `mark_paid` runs as the table owner, so grants don't limit it. What stops a future edit of a definer function from changing an existing payment's `cents`?
23. Sam stamps a made-up plan key on his own payment from a script. What can that change on Hana's Settle screen, and what can't it change?
24. Ana can update her own `venmo_username` directly, but `update profiles set username = 'ana' where id = <her id>` fails with `42501`. Which layer refuses, and why was it set up that way instead of granting `update (username)`?
25. The Activity feed never shows Ana what Sam paid Maya. Ana runs `select details from bill_events where bill_id = <their bill>` from a script. What does she get? What would it take to make those amounts truly private?

## Learn more
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- PostgreSQL privileges and column grants: https://www.postgresql.org/docs/current/ddl-priv.html
- PostgreSQL, `GRANT` (column privileges): https://www.postgresql.org/docs/current/sql-grant.html
- PostgreSQL, `UPDATE` (which privileges an update needs): https://www.postgresql.org/docs/current/sql-update.html
- supabase-js, `.select()` after a write: https://supabase.com/docs/reference/javascript/update
- PostgreSQL, `CREATE TRIGGER` (EXECUTE on the trigger function is needed by whoever creates the trigger): https://www.postgresql.org/docs/current/sql-createtrigger.html
- PostgreSQL, role attributes (`BYPASSRLS` skips row security policies): https://www.postgresql.org/docs/current/role-attributes.html
- Supabase, Postgres roles (`service_role` and its access): https://supabase.com/docs/guides/database/postgres/roles
- Supabase, database advisors (incl. "multiple permissive policies"): https://supabase.com/docs/guides/database/database-advisors
- OWASP, Authentication Cheat Sheet ("Authentication and Error Messages": generic responses so attackers can't tell which accounts exist): https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
