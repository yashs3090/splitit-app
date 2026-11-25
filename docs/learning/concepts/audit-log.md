# Audit log (the Activity timeline)

## The idea
An **audit log** is a table of things that happened: who did what, and when. The key rule is that it's **append-only**. You add new entries, but you never change or delete old ones. A history you can rewrite isn't a history.

There are two ways to store "what happened":
- **References** point at live data: "claim on item `9f2…`". If the item is deleted, the entry no longer makes sense.
- **Snapshots** copy the relevant value at the time: "claim on *Fries*". The entry still reads correctly after the item is renamed or deleted.

SplitIt's log, `bill_events`, uses both: user **ids** (references), plus an **item-name snapshot**.

## Why it matters here
Five friends are claiming and the host is editing. Someone's share jumps from $12 to $15. "Why?" The Activity screen answers it in plain sentences:

- "Pat claimed Fries"
- "Sam changed the Nachos split: Sam 2 parts, Pat 1 part (was even)"
- "Hana changed Burger from $15.00 to $18.00"
- "Hana removed Soda (Pat's and Sam's claims were removed)"

People trust a bill-splitting app more when they can see how the numbers got there.

## How we use it
### The table
`public.bill_events` (`supabase/migrations/20261121080352_bill_events.sql:29-46`):

| Column | What it holds |
|---|---|
| `bill_id` | Which bill. `on delete cascade`: events last as long as the bill. |
| `actor_id` | Who did it. `on delete set null`: a deleted account's events stay and read "Someone". |
| `kind` | One of a fixed list: `bill_created`, `joined`, `claimed`, `unclaimed`, `split_changed`, `item_added`, `item_removed`, `item_changed`, `amounts_changed`, `link_rotated`, `extras_split_changed` |
| `item_name` | Snapshot of the item's name at the time |
| `details` | A small JSON object per kind, e.g. `{"price_cents": [1500, 1800]}` |
| `created_at` | When |

Participants can read their bills' events. Clients have **no** insert, update or delete grant on the table (`:56-66`). Since the M2 review fixes, **`service_role` can't write it either** (see "No role writes events directly" below).

### Who writes events
Only the database writes events, and only through one internal function, `private.log_event` (`:122-139`). No client role can execute it.
- **Claims are logged by a trigger** (`private.log_claim_event`, `:152-211`). Claims can be inserted or deleted directly under RLS, not only through `set_claim`, so a trigger on the `claims` table is the only place that sees every claim change. It's an `AFTER` trigger, so when it records the item's split it sees the claims as they are *after* the change.
- **Everything else is logged inside the functions that make the change**: `create_bill`, `join_bill`, `rotate_join_code`, `update_bill`, `set_item_split` and `set_extras_split` ([database functions](database-functions.md)). The event and the change are in the same transaction, so a failed edit logs nothing.
- **Edits are logged per item, not per unit row.** `update_bill` compares old and new item groups, so "Beer qty 2 → 3" is one event, not three. The current version is in `supabase/migrations/20261122085802_m2_review_fixes.sql:198-282` (first version `20261121080352_bill_events.sql:467-538`).
- **Cascades aren't logged as unclaims.** When the host deletes an item, its claims are deleted automatically. The claims trigger sees that the item is already gone and logs nothing (`20261121080352_bill_events.sql:173-185`). `update_bill` logs one `item_removed` event listing who had claimed it.
- **A lowered quantity says whose claims went** (M2 review R5, approved by the user 2026-11-22). Lowering "Beer ×2" to "×1" deletes one unit row. If someone had claimed that unit, their claim cascades away too. The `item_changed` event then carries `removed_claimer_ids`, a sorted list of the users who lost a claim (`m2_review_fixes.sql:268-274`). The key is left out when no dropped unit was claimed. Activity shows it like `item_removed` does: "Hana changed Beer: quantity 2 → 1 (Pat's claim was removed)" (`lib/activityText.ts:215-223`).
- **Discount changes are logged once** (M2 review R1). A bill stores two discounts: one before the subtotal and one on the total. `amounts_changed` now carries only `subtotal_discount_cents` and `total_discount_cents` (`m2_review_fixes.sql:284-298`). The first version also wrote a combined `discount_cents` key, so Activity showed one change twice. `lib/activityText.ts:162` still reads `discount_cents`, so events logged before the fix still render.

`item_changed` details are now any of `name`, `qty`, `price_cents` (each `[before, after]`), `note_changed: true`, and `removed_claimer_ids: [uid, …]`.

### The append-only guard
A `before update or delete` trigger, `private.bill_events_append_only` (`20261121080352_bill_events.sql:81-115`), refuses every change to an existing event with `42501`, **for every role, including `postgres`**. That means even our own definer functions can't rewrite history by mistake. `truncate` is blocked too.

It has exactly **two exceptions**, both automatic foreign-key actions:
1. **Delete, when the event's bill no longer exists.** That's the `on delete cascade` from `bills`. By the time the cascade reaches `bill_events`, the bill row is gone, so the trigger lets it through.
2. **Update that only sets `actor_id` to null, when that profile no longer exists.** That's the `on delete set null` from `profiles` when an account is deleted. Every other column must be unchanged.

The guard checks "is the parent gone?" rather than `pg_trigger_depth()`. Trigger depth would also let through an update issued from inside *any* other trigger, which is too loose.

**The guard is `security definer`** (M2 review R2, `supabase/migrations/20261122085802_m2_review_fixes.sql:37-40`). Its whole job is to look up `public.bills` and `public.profiles` and ask "is this row really gone?" As an invoker function (its first version), that lookup ran with the caller's rights, so RLS could filter it. A bill the caller isn't allowed to see would look "gone", and the guard would let a delete through. As a definer function owned by `postgres`, it reads the real tables, so "gone" means gone. It also has `set search_path = ''`, and nobody can call it directly: it only runs as a trigger, and `execute` is revoked from `public`, `anon` and `authenticated`. ([Database functions](database-functions.md) explains definer vs invoker.)

### No role writes events directly
The first migration revoked table rights only from `anon`, `authenticated` and `public`. Supabase's default privileges still gave `service_role` full rights on `bill_events`. The guard stopped its updates and deletes, but it could still **insert made-up events**. M2 review R3 closes that (`m2_review_fixes.sql:47`):
```sql
revoke insert, update, delete, truncate on public.bill_events from service_role;
```
`service_role` keeps `select`. Now the only way in is `private.log_event`.

Foreign-key cascades still work: deleting a bill still deletes its events, and deleting an account still sets `actor_id` to null. Those actions run as the table's owner, not as the role that deleted the parent row. The tests check both, run as `service_role` (`supabase/tests/database/m2_review_fixes.test.sql:288-331`).

### Privacy
Events store **user ids and an item-name snapshot only**. No emails, no display names, no join codes (`link_rotated` has empty `details`). Names are looked up when the screen renders, from the bill's participants. So if someone changes their display name, old events show the new name. The pgTAP tests check that no event contains an `@` or a 20-hex join code (`supabase/tests/database/bill_events.test.sql`).

### Turning events into sentences
The database stores data. **The wording lives in the app**, in `lib/activityText.ts`:
- `describeEvent(event, nameOf)` (`lib/activityText.ts:306-316`) returns one sentence, or `null` for an unknown kind or malformed `details`. It never throws, and the screen skips `null`s.
- Every sentence is a **fixed template**. Only names, the item name, quantities and `formatCents` amounts are filled in. Nothing else from `details` is ever shown, so a strange event can't put arbitrary text on screen.
- The viewer reads as "You" ("You claimed Burger").
- `groupEvents` and `timeLabel` put events under "Just now", "7:42 PM", "Yesterday" or "Nov 18".

Because wording is in the app, we can improve it without a database migration.

Data and screen:
- `lib/activity.ts:86-113` (`fetchActivity`) reads the newest 200 events plus participants and validates every field.
- `lib/useActivity.ts:63` refetches on the bill's live `changed` hint ([realtime](realtime.md)). There's no separate broadcast for events: every event is written in the same transaction as a change that already broadcasts.
- The screen is `app/(app)/bills/[id]/activity.tsx` (sentences built at `:89`).

## Pitfalls
- **Logging from the app.** A client could skip it, or log something false. Log in the database, in the same transaction as the change.
- **Only references, no snapshots.** "Removed claim on item 9f2…" is useless after the item is deleted.
- **Storing display names or emails in the log.** That's personal data copied into a table that's hard to clean up, and it goes stale.
- **Letting cascades create noise.** Deleting one item shouldn't produce "Pat removed their claim", "Sam removed their claim"…, because they didn't.
- **An append-only rule that only covers clients.** A bug in a definer function could still rewrite rows. Our guard blocks every role.
- **Forgetting the server roles' default grants.** Revoking from `anon` and `authenticated` isn't enough on Supabase: `service_role` gets its own default rights. Revoke what it shouldn't have too.
- **A guard that checks other tables as the caller.** If the check can be filtered by RLS, "I can't see it" turns into "it's gone". Make that kind of guard `security definer`.
- **Rendering `details` directly.** Always go through fixed templates, and treat unknown shapes as "skip".

## Check yourself
1. Why is the claim event written by a trigger, while `item_changed` is written inside `update_bill`?
2. The host deletes "Soda", which Pat and Sam had claimed. Which events appear, and which don't?
3. Name the two cases where the append-only guard lets a change through, and why each is safe.
4. Pat renames themself from "Pat" to "Patricia". What do old events show, and why?
5. Why do we turn events into sentences in the app instead of storing the sentence in the database?
6. Hana lowers "Beer ×3" to "×2". Rae claimed one unit and nobody claimed the other two. Which unit does the app drop, and does the `item_changed` event carry `removed_claimer_ids`? (Hint: `freshSaveCheck` in `lib/editBill.ts:92` drops unclaimed units first.)
7. `service_role` bypasses RLS. Why did it still need an explicit `revoke` on `bill_events`, and why do cascades keep working after it?

## Learn more
- PostgreSQL, trigger behavior (BEFORE/AFTER, row vs statement): https://www.postgresql.org/docs/current/trigger-definition.html
- PostgreSQL, foreign keys and `ON DELETE` actions: https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
- Supabase, Postgres triggers: https://supabase.com/docs/guides/database/postgres/triggers
