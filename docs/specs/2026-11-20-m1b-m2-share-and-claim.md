# M1b + M2: save a bill, share a link, friends join and claim live

Date: 2026-11-20 (Amendment A1: 2026-11-21). Milestones: the end of M1 ("saving", left out of M1a) and M2 in `docs/plans/bill-splitting-app-2026-11-19.md`.
Repo: `splitit-app` only (single repo, ADR 0011). Supabase changes go in `supabase/migrations/` and `supabase/tests/database/`.

The user's words: "lets say you created a bill and you send me a url so i can select what i added."

## Goal
A host saves the bill they entered or scanned, gets a link, and sends it to a friend. The friend opens it, signs in with Google, lands on the bill, and taps the items they had. Everyone in the bill sees, **live**, who claimed what, each person's exact share with tax and tip, and any edits the host makes. This tests the plan's riskiest assumption (ADR 0004 and the kill criterion): **that invitees will open the link, sign in and claim.**

## User decisions
### 2026-11-20 (relayed by the coordinator)
1. **Claims update live** on everyone's screen. Supabase Realtime is in this slice.
2. **The host can edit items after sharing.** Changing a price or qty keeps claims and recomputes shares. A deleted item takes its claims with it. Participants see the edit live.
3. **Everyone in a bill sees who claimed what** (initials avatars on each item). RLS: participants read all claims in their bills.
4. **Shared items split evenly automatically** when two or more people claim the same item (largest-remainder cents). Custom splits sit behind **one quiet, separate control**; the user doesn't want a cluttered claim screen. **The `ui-ux-designer` skill is required for the claim screen and the split sheet.**

### Amendment A1 (2026-11-21): answers to the open questions
Tasks and criteria below are updated in place. This section is the record.
1. **Q1, hosting:** the next slice is a $0 "friend-test deploy" (hosted Supabase free tier plus a free Netlify or Vercel subdomain). Whether to publish the consent screen is decided in that slice. It's out of scope here.
2. **Q2, custom splits (not the PM's recommendation):** **any current claimer of an item can set everyone's parts on that item.**
   - This goes through a `security definer` function, `set_item_split`. The caller must be a participant **and** a current claimer of that item.
   - It touches only that item's claims and changes parts only. It can't add or remove people.
   - It's atomic.
   - Direct table writes to other people's claims stay forbidden. Clients now have **no** `update` grant on `claims` at all.
   - Everyone sees the change live, with a small "Split set by <name>" line.
3. **Q3, items with qty > 1: shown as one row per unit** ("Beer ×2" becomes two "Beer" rows), and each row is claimed on its own.
   - **Model:** expand each item into one `line_items` row per unit at save and edit time. The line price is split across the units by largest remainder, so the units add up exactly to the line price.
   - Each row keeps a group reference (`group_position`, `unit_index`, `group_size`), so the host's edit form shows the group as one row with qty N again.
   - See design decision 4.
4. **Q5, approved:** writes go through database functions. This is recorded in ADR 0013 (Task 14).
5. **Q4, Q6, Q7, Q8 and Q9: the PM's recommendations are accepted.**
   - Q4: opening the link joins automatically.
   - Q6: any participant can share the link; only the host can make a new one.
   - Q7: the numbers must add up within 1¢ before saving or editing.
   - Q8: who pays for unclaimed items is decided in M3.
   - Q9: host edits aren't blocked once someone has claimed. Deleting a claimed row asks for confirmation, and participants see a notice.
6. **Activity log (new request, 2026-11-21).** Each bill gets an "Activity" timeline: who joined, who claimed or unclaimed what, how splits changed, and what the host changed. Every entry is one plain sentence for a normal person, not a developer log.
   - Events are **append-only**. Only `security definer` triggers and functions write them; participants can only read them.
   - Item names are snapshotted, so deleted items still read correctly.
   - The timeline sits behind a quiet entry point, so the claim list stays uncluttered. It updates live.
   - No filtering, search or export in this slice (later ideas).
   - See design decision 8, Tasks 15–17 and criteria 119–142.
7. **Tax, tip, fees and bill-level discounts can be split proportionally or equally (new request, 2026-11-21).**
   - A bill setting `extras_split`: `proportional` (default; this was the only behavior before) or `equal`.
   - Spec defaults, each listed as an open question (EQ1–EQ4):
     - **one setting for all extras**;
     - **"equal" means among people who have claimed at least one item**;
     - **under "equal", the Unclaimed line carries no extras**;
     - **only the host can change it.**
   - Largest-remainder cents in both modes, so people + unclaimed always sum exactly to the total.
   - The setting is shown to everyone, updates live and is logged in Activity.
   - `CLAUDE.md` § Conventions and ADR 0005 say "proportional". Task 14 writes a new ADR and **proposes** the CLAUDE.md wording for the user to approve.
   - See design decision 9, Tasks 18–19 and criteria 143–156.

### Amendment A2 (2026-11-21): user answers on the extras split and custom splits
Tasks and criteria below are updated in place; this section is the record.
1. **EQ1, EQ2, EQ4 and EQ5 are accepted as recommended:**
   - one setting for all extras;
   - "equal" is among people who have claimed something;
   - host only;
   - bill-level discounts follow the same mode.
2. **EQ3 (the user's rule):**
   - **(a) M3 rule: settling is never allowed while any item is unclaimed.** Recorded here for the M3 spec; nothing is built for it in this slice.
   - **(b) In "split equally" mode, nobody's tax & tip share or final total is shown until every item is claimed.**
     - Each person's items subtotal shows live.
     - In place of their total: "Total shows once all items are claimed (3 items left)", where the count is unclaimed rows.
     - Once everything is claimed, totals appear live.
     - In proportional mode, totals show live as before, because each person's share depends only on their own items.
     - Under "equal", the Unclaimed line still carries no extras.
   - **(c) The pending state is pure logic in `lib/split.ts`** (`sharesComplete` and `displayShares`), not UI logic.
3. **Custom splits keep their parts when claimers change (not the PM's recommendation):**
   - A newcomer on an item with a custom split gets 1 part, and the others keep theirs.
   - When someone leaves, the remaining parts stay.
   - With one claimer left, parts don't matter: they pay the whole item.
   - **The reset-to-even trigger (`claims_reset_split`) is dropped.**
   - Activity records each change, including the resulting split when the item is custom.
   - The manual "Reset to even" action in the item sheet stays.
4. **Accepted:** unclaimed units go first when the host lowers a quantity (with a confirmation for claimed units), and Activity events last as long as the bill.
5. **Ready to build:** see "Build order" at the end of the Tasks section.

## Providers, accounts and costs (read first)
| Need | What | Cost | Status |
|---|---|---|---|
| Local Supabase (Docker) | Postgres, Auth, RLS and **Realtime** (`[realtime] enabled = true` is already set) | Free | Already set up. `npm run db:reset` **wipes local data**. |
| Google OAuth client | Existing (`docs/setup/google-oauth.md`) | Free | Already set up |
| **A second Google account as a test user** | The consent screen is in **Testing** mode | Free | **User step U1. Blocks the two-account QA.** |
| `expo-clipboard` (~57.0.2) | Copy link on iOS, Android and web | Free | New native module. The iPhone dev build must be **rebuilt** before on-device use. |
| React Native `Share` | Native share sheet (built in) | Free | No install. `expo-sharing` is for files, so it isn't used. |
| Hosted Supabase, web hosting, domain, Apple Developer | **Not in this slice** | $0 | The next slice (A1.1) |

Nothing paid is needed. Nothing blocks building this slice or running QA on one machine.

### User setup steps (before QA)
- **U1.** Google Cloud Console → Google Auth Platform / OAuth consent screen → Audience → Test users. Add the second Google account *(verify the menu path against the current console)*.
- **U2.** `npm run db:start`, then `npm run db:reset` to apply the new migrations. Google sign-in must work locally as it did in M0.

## In scope
- **Save:** "Save and share" on `/bill` calls one database function. It creates the bill, its **unit rows** (integer cents), the host's participant row and a random join code, then opens the bill screen.
- **Join code:** generated **in the database**. It's 20 lowercase hex chars (80 random bits), unique, and **revocable** ("Make a new link").
- **Share:** "Copy link" (`expo-clipboard`) everywhere, plus "Share…" (React Native `Share`) on native and on web where `navigator.share` exists. The link uses the existing route `/b/<code>`: in dev that's `http://localhost:8081/b/<code>` on web and `splitit://b/<code>` on native.
- **Join:** the existing `/b/[code]` route and the M0 resume-after-sign-in flow. The stub becomes `join_bill(code)`, followed by the bill screen.
- **Bill screen `/bills/[id]`:** one screen for host and participants.
  - One row per unit, each with claimers' initials avatars and one claim toggle.
  - An item detail sheet, which is the only entry point to "Split differently".
  - Everyone's shares, plus "Unclaimed".
  - A share panel.
  - **Live updates** over a private Realtime channel.
- **Host edits after sharing:** `/bills/[id]/edit` reuses `BillForm`, with unit rows regrouped into qty-N rows. It saves atomically through `update_bill`, and participants see the change live with a one-line notice.
- **Split math:** `lib/split.ts`, pure and written test-first. Each row's price is split by parts (default 1 each, so an even split). Tax, tip and fees net of discounts are allocated by largest remainder. People plus "Unclaimed" always equal the total exactly.
- **Home:** a "Your bills" list (the 20 newest bills you host or have joined).
- **Activity (A1.6):**
  - An append-only `bill_events` table.
  - `lib/activityText.ts` (pure and tested) turns each event into one plain sentence.
  - `/bills/[id]/activity` shows a timeline: newest first, grouped by time, with initials avatars, updating live.
- **Security:** RLS, explicit grants and pgTAP for every table, function and the Realtime channel policy. Co-participants see each other's `display_name` only.
- **Docs:** concept notes and ADR 0013 (Task 14).

## Out of scope (explicitly cut)
- **The friend-test deploy** (hosted Supabase, Netlify/Vercel, Google redirect for the hosted project, consent-screen publishing). It's the next slice (A1.1).
- Settle, payment links, paid status, and who pays for unclaimed items (M3, A1.5).
- Removing a participant, leaving a bill, deleting a bill, locking a bill.
- The host claiming or unclaiming for someone else.
- Profile photos as avatars. We use initials. Photos would mean storing Google-hosted image URLs in `profiles`; ask if wanted.
- A bill title or merchant name. Bills are labelled "<host name>'s bill · <date> · <total>".
- Presence, typing indicators, push notifications. Groups, history across bills, running balances.
- Storing the receipt photo. Universal links and app links, a production domain (`docs/before-production.md` §1 and §5).
- A "Join <host>'s bill?" confirmation (A1.5).
- Server-side rate limiting (no backend, ADR 0010). Flagged in Risks.
- Guest claiming (ADR 0004).
- **Activity extras:** filtering, search, export, pagination beyond the newest 200 events, per-event undo, and notifications. These are later ideas.

## Key design decisions (and why)
1. **The join code is generated in the database** (`create_bill`, `rotate_join_code`).
   - The DB is the trust boundary. A client could send a weak, reused or attacker-chosen code, or skip the collision retry.
   - It uses `extensions.gen_random_bytes(10)` (pgcrypto), hex-encoded: 20 chars, 80 bits, `unique`.
   - Hex fits the existing `normalizeInviteCode` regex, needs no escaping, and has no trailing `-`/`_` for chat apps to cut off when they linkify.
   - *Verify that pgcrypto is in `extensions` on the installed stack.* If not, build the code from `gen_random_uuid()` hex with the dashes and version nibbles stripped, and report it as a deviation.
2. **Writes that span tables, host-only writes and other-people writes go through `security definer` SQL functions**: `create_bill`, `update_bill`, `join_bill`, `rotate_join_code` and `set_item_split`. **Claiming or unclaiming yourself** goes through a `security invoker` function, `set_claim`, so RLS still applies.
   - **Why:**
     - A bill, its rows and the host participant are one transaction. An edit is an atomic diff.
     - Joining by code must not need read access to `bills`.
     - A claimer setting other people's parts needs a function that can check "is the caller a claimer of *this* item", which a column grant can't express.
   - **Why this isn't a custom backend:** these are SQL functions in the managed Supabase Postgres, versioned in `supabase/migrations/`. No server program runs, and no secret is held. Approved in A1.4, recorded as ADR 0013.
3. **`join_bill` is the only way into a bill.**
   - There's no client `insert` on `bill_participants`. `bills` is readable only by participants.
   - Wrong and malformed codes return the **same** error.
   - Guessing 80 bits is infeasible. Spam is the realistic abuse, and only Supabase's platform limits guard against it (`before-production.md` §4).
4. **Items with qty > 1 are stored as unit rows** (A1.3).
   - The form's row "Beer, qty 2, $14.00" becomes two `line_items` rows "Beer" at 700 and 700. "Beer, qty 3, $10.00" becomes 334, 333 and 333: largest remainder with equal weights, so the first units get the extra cent.
   - Each row has `group_position` (the form row's index), `unit_index` (0..N−1) and `group_size` (N).
   - **The expansion happens in the client, in pure `lib/billPayload.ts`** (tested in Jest). The DB functions **validate** that groups are consistent:
     - unit indexes are contiguous;
     - every row in a group has the same name, note and size;
     - group positions are contiguous.
     The DB stays generic about rows.
   - **On edit**, `draftFromSaved` regroups the rows into one form row with qty N and the summed price.
     - When qty goes up, the existing unit ids are kept, new units are added and all units are repriced.
     - When qty goes down, **unclaimed units are dropped first**, highest index first. Claimed units go only after a confirmation.
     - Kept units keep their claims.
   - **Why unit rows:** every row then has the same claim behavior (one toggle, even split), so split math and the UI never special-case quantities.
5. **Claims and splits (decision 4 + A1.2).**
   - A claim is `(line_item, user, parts)`, with parts 1–20 and a default of 1.
   - A row's price is split among its claimers in proportion to parts. With everyone at the default of 1, that's an even split.
   - **Any current claimer of a row can set every claimer's parts on that row**, through `set_item_split`.
   - **When the set of claimers changes, parts are kept (A2.3).** A newcomer starts at 1 part (the column default), and everyone else keeps theirs. When someone leaves, the remaining parts stay. With one claimer, they pay the whole row whatever their parts. `split_set_by` stays until the next `set_item_split` or "Reset to even". There's no reset trigger.
   - `set_item_split` must receive **exactly** the current claimer set. Otherwise it raises `22023` (`claimers_changed`), and the client refetches.
6. **Extras** = `total − Σ row prices` (tax + fees + tip − discounts, plus any 1¢ receipt rounding).
   - Allocated as one amount by largest remainder, in proportion to each person's item amount, with **unclaimed as an extra slot**.
   - The invariant is people + unclaimed = total.
   - Extras can be negative.
7. **Realtime uses Broadcast from the database, not `postgres_changes`, and the messages carry no data.**
   - Triggers on `claims`, `bill_participants` and `bills` call `realtime.send(...)` on the **private** topic `bill:<bill_id>`, with the payload `{"t": "<table>"}` only.
   - Clients treat each message as a hint and **refetch** through the RLS-protected selects (`docs/learning/concepts/realtime.md`).
   - **Why not `postgres_changes`:**
     - Its deletes can't be filtered by `bill_id`.
     - Under RLS, the old record of a delete carries the primary key, which for `claims` is `(line_item_id, user_id)` *(verify against current docs; the decision stands either way)*.
     - Data-free broadcasts leak nothing, and the subscribe check is an RLS policy on `realtime.messages` that pgTAP can test.
   - `update_bill` touches `bills.edited_at`, and `set_item_split` updates `claims`. So `line_items` needs no trigger.
8. **Activity is an append-only event table, written only in the database** (A1.6).
   - **Where events are written:**
     - `claimed` / `unclaimed`: by a `security definer` trigger on `claims`. Claims can also be inserted or deleted directly under RLS, so a trigger is the only place that catches every write.
     - Everything else is written **inside the functions** that are already the only write paths: `create_bill`, `join_bill`, `rotate_join_code`, `update_bill` and `set_item_split`.
   - **Edits are logged per form item (group), not per unit row.** `update_bill` compares old and new groups. Groups are matched by any kept row id; a group with no kept ids counts as removed, and a group with no ids as added. So "Beer 2 → 3" is one event, not three.
   - **Cascade deletes don't log "removed their claim".** The claims trigger skips a delete when the line item or the participant row is already gone, so removing an item logs one `item_removed` event that lists the affected claimers.
   - **Privacy:** events store user **ids** and an item-name snapshot only. Display names are looked up at render time from the bill's participants. No emails, and no other personal data.
     - Events last as long as the bill (`on delete cascade`).
     - A deleted account's `actor_id` becomes null, which renders as "Someone".
   - **No extra Realtime trigger:** every event is written in the same transaction as a change that already broadcasts (`claims`, `bills`, `bill_participants`). The Activity screen refetches on the same hint.
   - **The text lives in the app, not the DB.** `lib/activityText.ts` maps `kind` + `details` to fixed copy, so wording can change without a migration, and unknown or malformed events are skipped safely.
9. **The extras split mode** (A1.7). "Extras" (design decision 6) are allocated in one of two modes:
   - **`proportional`** (default): unchanged from decision 6. Extras are spread over each person's item amount, with Unclaimed as an extra slot.
   - **`equal`**:
     - Extras are divided evenly (largest remainder, weights all 1, people sorted by userId) **among participants who have at least one claim on the bill** (a $0 row counts).
     - People with no claims pay $0 extras.
     - **The Unclaimed line carries no extras**, only unclaimed item prices.
     - If nobody has claimed anything yet, all extras sit in Unclaimed, the same as in proportional mode, so the total still adds up.
     - Consequence: while few items are claimed, the early claimers carry all of the tax and tip. That's visible on screen and evens out as others claim (EQ3).
   - In both modes: `Σ people + unclaimed = total`, and negative extras (big discounts) are allowed.
   - It's **one setting for all extras**, including bill-level discounts (`discount_cents` is part of extras). Item-level discounts are already folded into item prices (M1a A2), so they always follow the items.
   - **It's changed through a tiny host-only function, `set_extras_split`**, not `update_bill`, which would need the whole item list. The control lives on the bill screen. The function updates `bills` (so the existing broadcast fires) and logs an Activity event.

## Data model (Task 1)
Integer cents everywhere (ADR 0005). Every table: RLS on, `revoke all ... from anon, authenticated, public`, then the grants listed.

| Table | Columns | Grants to `authenticated` (anon: none) | RLS |
|---|---|---|---|
| `bills` | `id uuid pk default gen_random_uuid()`<br>`host_id uuid not null → profiles(id) on delete cascade`<br>`currency text not null default 'USD' check (currency = 'USD')`<br>`subtotal_cents integer null` (as printed, display only)<br>`tax_cents`, `fees_cents`, `tip_cents`, `discount_cents integer not null default 0`<br>`total_cents integer not null`<br>`join_code text not null unique check (join_code ~ '^[0-9a-f]{20}$')`<br>`created_at timestamptz not null default now()`<br>`edited_at timestamptz null`<br>`extras_split text not null default 'proportional' check (extras_split in ('proportional','equal'))` (A1.7; added in Task 18's migration)<br>All cents `between 0 and 99999999` | `select` | select: `private.is_bill_participant(id)` |
| `line_items` (one row per **unit**) | `id uuid pk default gen_random_uuid()`<br>`bill_id uuid not null → bills on delete cascade`<br>`group_position integer not null check (>= 0)`<br>`unit_index integer not null check (>= 0)`<br>`group_size integer not null check (between 1 and 99)`, plus `check (unit_index < group_size)`<br>`name text not null check (char_length(btrim(name)) between 1 and 100)`<br>`note text null check (note is null or char_length(note) <= 200)`<br>`total_cents integer not null check (between 0 and 9999999)` (this unit's price)<br>`split_set_by uuid null → profiles(id) on delete set null`<br>`split_set_at timestamptz null`<br>`unique (bill_id, group_position, unit_index) deferrable initially deferred`<br>`unique (id, bill_id)` | `select` | select: `private.is_bill_participant(bill_id)` |
| `bill_participants` | `bill_id uuid → bills on delete cascade`<br>`user_id uuid → profiles(id) on delete cascade`<br>`joined_at timestamptz not null default now()`<br>`pk (bill_id, user_id)` | `select` | select: `private.is_bill_participant(bill_id)` |
| `claims` | `bill_id uuid not null`<br>`line_item_id uuid not null`<br>`user_id uuid not null`<br>`parts integer not null default 1 check (parts between 1 and 20)`<br>`created_at`, `updated_at` (reuse `public.set_updated_at`)<br>`pk (line_item_id, user_id)`<br>`fk (line_item_id, bill_id) → line_items(id, bill_id) on delete cascade`<br>`fk (bill_id, user_id) → bill_participants(bill_id, user_id) on delete cascade` | `select`; `insert (bill_id, line_item_id, user_id)`; `delete`. **No `update`** (A1.2). | select: participant of `bill_id`.<br>insert: `with check (user_id = (select auth.uid()) and private.is_bill_participant(bill_id))`.<br>delete: `using (user_id = (select auth.uid()))`. |
| `profiles` (existing) | none | unchanged | **Add** a select policy: `private.shares_bill_with(id)` |

- **Helpers** go in a new schema `private`, which isn't in `config.toml [api] schemas`, so it isn't exposed through the API. Each is `security definer stable` with `search_path = ''`.
  - `private.is_bill_participant(p_bill_id uuid)`.
  - `private.shares_bill_with(p_user_id uuid)`.
  - Grants: `revoke all on schema private from public, anon`, then `grant usage ... to authenticated`. Revoke execute from `public, anon`, then grant execute to `authenticated`. *Verify against the `supabase` and `supabase-postgres-best-practices` skills.*
- **No claimer-change trigger (A2.3).** Parts are kept when claimers join or leave. The earlier `claims_reset_split` trigger is dropped from the plan; don't create it.
- **Indexes:** `claims(bill_id)`, `claims(user_id)`, `bill_participants(user_id)` and `bills(host_id)`. `line_items(bill_id)` is covered by the unique index.
- **No** insert, update or delete grants on `bills`, `line_items` or `bill_participants`, and no update on `claims`. The functions are the only write paths for those.

## Functions and Realtime (Tasks 3–5)
Every function has `set search_path = ''` and fully qualified names, revokes execute from `public, anon`, and grants execute to `authenticated`. A null `auth.uid()` raises `42501`. Errors use fixed SQLSTATEs plus fixed messages, and the app maps only those to its own copy.

**Shared row validation** (`private.validate_bill_rows(p_rows jsonb, money…)`, used by `create_bill` and `update_bill`):
- 1–500 rows. Each row is `{id?, name, note, group_position, unit_index, group_size, total_cents}`, and every number is a JSON **integer** (`12.5` and `"12"` are rejected).
- `group_position` values are contiguous 0..G−1.
- Within a group:
  - `unit_index` is exactly 0..group_size−1, each once;
  - `name`, `note` and `group_size` are the same on every row.
- Money arguments are non-null and ≥ 0, except subtotal, which may be null.
- `abs(total − (Σ row cents − discount + tax + fees + tip)) ≤ 1`.
- Any failure raises `22023` (`invalid_bill`).

| Function | Kind | Behavior |
|---|---|---|
| `public.create_bill(p_rows jsonb, p_subtotal_cents integer, p_tax_cents integer, p_fees_cents integer, p_tip_cents integer, p_discount_cents integer, p_total_cents integer) returns table (bill_id uuid, join_code text)` | definer | Validate, with **no** `id` allowed on any row. Insert the bill (`host_id = auth.uid()`, no host parameter) and the rows, with name trimmed and a blank note stored as null. Insert the host's participant row. Generate the code, retrying up to 3 times on `unique_violation`. |
| `public.update_bill(p_bill_id uuid, p_rows jsonb, <same 6 money params>) returns void` | definer | Not the host, or no such bill: `42501`, the same error either way. Validate. An `id` that isn't one of this bill's rows raises `22023`. In one transaction:<br>• update the rows that have an id (name, note, group fields, cents);<br>• insert the rows without one;<br>• **delete this bill's rows that aren't in the list** (their claims cascade);<br>• update the money columns;<br>• set `edited_at = now()`.<br>Claims on kept rows are left alone. |
| `public.join_bill(p_code text) returns uuid` | definer | A malformed code (not `^[0-9a-f]{20}$`) **or** an unknown code raises `P0002` (`invalid_code`), with the same SQLSTATE and message. Otherwise it inserts the participant row `on conflict do nothing` and returns the bill id. |
| `public.rotate_join_code(p_bill_id uuid) returns text` | definer | Not the host, or no such bill: `42501`. Otherwise it sets and returns a new code. |
| `public.set_claim(p_line_item_id uuid, p_claimed boolean) returns void` | **invoker** | The row isn't visible under RLS: `P0002` (`not_found`). `true` inserts the caller's claim (`parts` default 1) `on conflict do nothing`. `false` deletes it (a no-op if there's none). RLS and grants apply. Other claimers' parts are never changed (A2.3). |
| `public.set_item_split(p_line_item_id uuid, p_parts jsonb) returns void` | definer | `p_parts` is an object `{ "<user uuid>": <int> }`.<br>1. If the row doesn't exist, or the caller isn't a participant of its bill, raise `P0002` (the same error either way).<br>2. Lock the row's claims (`select ... for update`).<br>3. If the caller has no claim on this row, raise `42501`.<br>4. If the key set isn't **exactly** the current claimer set (adds a non-claimer or omits a claimer), or any value isn't a JSON integer in 1–20, raise `22023` (`claimers_changed` / `invalid_parts`).<br>5. Update `parts` on **this row's claims only**, and set `split_set_by = auth.uid()` and `split_set_at = now()` on the row.<br>It never inserts or deletes claims, and never touches another row. |
| `public.set_extras_split(p_bill_id uuid, p_mode text) returns void` (A1.7, Task 18) | definer | Not the host, or no such bill: `42501`, the same error either way. A mode other than `proportional`/`equal` raises `22023`. Setting the current value again is a no-op: no update and no event. Otherwise it updates `bills.extras_split`, which fires the existing `bills` broadcast, and logs `extras_split_changed`. It doesn't touch `edited_at`, so participants don't get the "updated the bill" notice for it; Activity shows it instead. |

**Realtime (Task 4):**
- **Trigger function** `private.broadcast_bill_change()`, `security definer`, `search_path = ''`.
  - It gets `bill_id` from `NEW` or `OLD`.
  - It calls `realtime.send(jsonb_build_object('t', TG_TABLE_NAME), 'changed', 'bill:' || bill_id, true)` *(check the signature against the installed `realtime` schema; the docs show named arguments `payload, event, topic, private`)*.
  - **The payload has no ids, names or amounts.**
- **Triggers:** `after insert or update or delete` on `claims`; `after insert` on `bill_participants`; `after update` on `bills`. No trigger on `line_items`.
- **Channel authorization:** an RLS policy on `realtime.messages`, `for select to authenticated using (private.can_listen_bill_topic((select realtime.topic())))`.
  - The helper parses `bill:<uuid>` **without raising**: a malformed topic returns false.
  - There's **no insert policy**, so clients can't broadcast.
  - *Verify `realtime.topic()` and the policy shape against the installed stack and the Realtime Authorization docs.*
- **Client** (Task 8): `supabase.realtime.setAuth()`, then `supabase.channel('bill:' + id, { config: { private: true } }).on('broadcast', { event: 'changed' }, …).subscribe(statusCb)`.
  - A debounced refetch (300 ms) on every message.
  - A refetch on every `SUBSCRIBED` (covers reconnects), on screen focus and when the app returns to the foreground.
  - `removeChannel` on unmount.
  - *Verify against supabase-js 2.109.*

## Pure-logic contracts
### `lib/split.ts` (Task 6)
```ts
export type SplitItem = { id: string; totalCents: number };            // one unit row
export type SplitClaim = { itemId: string; userId: string; parts: number };
export type ExtrasMode = 'proportional' | 'equal';
export type SplitInput = { totalCents: number; items: SplitItem[]; claims: SplitClaim[]; participantIds: string[];
  extrasMode: ExtrasMode };
export type ItemSplit = {
  status: 'unclaimed' | 'claimed' | 'shared';   // 0 claimers / 1 / 2+
  custom: boolean;                              // 2+ claimers whose parts are not all equal
  byUser: Record<string, number>;               // cents of this row per claimer
};
export type PersonShare = { userId: string; itemsCents: number; extrasCents: number; totalCents: number };
export type SplitResult = {
  people: PersonShare[];                        // one per participantId, sorted by userId (code-unit order)
  unclaimedItemsCents: number; unclaimedExtrasCents: number; unclaimedCents: number;
  extrasCents: number;                          // totalCents − Σ row totals (may be negative)
  items: Record<string, ItemSplit>;
};
/** Largest remainder, integer-only (BigInt for amount × weight). Ties go to the lower index.
 *  Negative amount = −allocate(−amount). Throws RangeError for negative or non-integer weights,
 *  a non-integer amount, or Σweights = 0 with amount ≠ 0. */
export function allocate(amount: number, weights: number[]): number[];
export function computeShares(input: SplitInput): SplitResult;

/** A2.2: true iff every row (with a valid id) has at least one counted claim. */
export function sharesComplete(input: SplitInput): { complete: boolean; unclaimedRows: number };
export type DisplayShare = { userId: string; itemsCents: number;
  extrasCents: number | null; totalCents: number | null };   // null = not shown yet
export type DisplayShares = {
  mode: ExtrasMode; complete: boolean; unclaimedRows: number;
  totalsVisible: boolean;                                     // mode === 'proportional' || complete
  people: DisplayShare[];                                     // same order as SplitResult.people
  unclaimedItemsCents: number; unclaimedExtrasCents: number;  // equal mode: unclaimedExtrasCents is 0 once anyone claimed (A1.7)
};
/** What the screen may show. Under 'equal' and incomplete, extras and totals are null for everyone. */
export function displayShares(input: SplitInput): DisplayShares;
```
Rules:
- Ignore claims for unknown rows or non-participants, and claims with `parts ≤ 0`. Clamp parts to 20.
- A row with no claimers: its full price goes to unclaimed. Otherwise: `allocate(row.totalCents, parts of the claimers sorted by userId)`.
- **`proportional`:** extras are allocated across `[each person's itemsCents (sorted by userId)…, unclaimedItemsCents]`. If every weight is 0, all extras go to unclaimed.
- **`equal`:** let C be the participants (sorted by userId) with at least one counted claim.
  - If C is empty, all extras go to unclaimed.
  - Otherwise `allocate(extras, [1 × |C|])` over C. Everyone else and `unclaimedExtrasCents` get 0.
- **Invariant:** `Σ people.totalCents + unclaimedCents === totalCents`, and every value is an integer.
- The output doesn't depend on the input order.
- No `parseFloat`, `toFixed` or `Math.round` on money.

### `lib/billPayload.ts` (Task 7)
```ts
export type BillRowArg = { id?: string; name: string; note: string | null;
  group_position: number; unit_index: number; group_size: number; total_cents: number };
export type BillMoneyArgs = { p_subtotal_cents: number | null; p_tax_cents: number; p_fees_cents: number;
  p_tip_cents: number; p_discount_cents: number; p_total_cents: number };
export type SaveBlock = 'has_errors' | 'no_items' | 'mismatch' | 'negative_total' | 'too_many_units';
export type SavedGroups = {
  units: Record<string, string[]>;   // draft row id → saved line_items ids, in unit_index order
  claimedIds: ReadonlySet<string>;   // saved row ids that have ≥1 claim
};
/** Expands each valid draft row into group_size unit rows (largest remainder, equal weights). */
export function toBillArgs(draft: BillDraft, ev: DraftEvaluation, saved?: SavedGroups):
  { ok: true; rows: BillRowArg[]; money: BillMoneyArgs; droppedClaimedIds: string[] } | { ok: false; reason: SaveBlock };
export function draftFromSaved(bill: SavedBill, rows: SavedRow[], claims: SavedClaim[]):
  { draft: BillDraft; saved: SavedGroups };
export const SAVE_BLOCK_COPY: Record<SaveBlock, string>;
```
- **Checks, in order:**
  1. Any `ev.errors` → `has_errors`.
  2. No valid items → `no_items`.
  3. `ev.mismatches` is non-empty → `mismatch`.
  4. More than 500 unit rows → `too_many_units`.
  5. Total below 0 → `negative_total`.
- **Rows:** with no errors, every non-blank draft row is valid. Zip the non-blank rows in draft order, using `evaluateDraft`'s blank rule, with `ev.receipt.items`.
  - Group `g` (0-based among valid rows) with qty N and price P becomes N rows. Each has `group_position: g`, `unit_index` 0..N−1 and `group_size: N`. The cents are `allocate(P, [1 × N])`, so the first units get the extra cent.
  - **Don't change `lib/billDraft.ts`.**
- **Edit ids (`saved` given):** for a draft row with saved unit ids `U` (length K) and new qty N:
  - If N ≥ K: keep all K ids on units 0..K−1, and units K..N−1 get no id.
  - If N < K: keep N ids, dropping **unclaimed ids first** (highest unit_index first), then claimed ones. Kept ids keep their relative order.
  - Dropped claimed ids are returned in `droppedClaimedIds`, so the screen can confirm.
  - A draft row with no saved ids (newly added) gets no ids.
- **Money:**
  - Tax, fees and tip: null becomes 0. Subtotal: null stays null.
  - Discount = the sum of all discounts.
  - Total = the entered total, or, if blank, `Σitems − discount + tax + fees + tip`.
- **Note** = `modifiers.join(', ')`, or null.
- **`draftFromSaved`:**
  - Groups the rows by `group_position`. Each group becomes one draft row: `qty = group_size`, `price = formatCentsInput(Σ unit cents)`, with name and note taken from unit 0.
  - Subtotal null becomes `''`. Tax, fees and tip of 0 become `''`.
  - `discount_cents > 0` becomes one discount row ("Discount", `appliesTo: 'total'`).
- **Copy:**
  - `has_errors`: "Fix the highlighted fields to save."
  - `no_items`: "Add at least one item to save."
  - `mismatch`: "The numbers need to add up before you can save."
  - `negative_total`: "The total can't be below $0.00."
  - `too_many_units`: "That's too many items for one bill (500 max)."

## Claim screen UX (Tasks 10–11; `ui-ux-designer` skill required)
The user wants an uncluttered screen. These are constraints; the layout is the designer's call.
- **One row per unit.** For groups with size > 1, every unit row shows a muted tag: "Beer · 1 of 2", "Beer · 2 of 2".
- **Each row has exactly one primary action:** the claim toggle (accessibility labels `Claim <name>` / `Unclaim <name>`; for units, `Claim Beer 1 of 2`).
- **Under the name:** the claimers' initials avatars (up to 3, then "+N"), plus one quiet status line:
  - "Unclaimed" (muted);
  - your amount when only you claimed it;
  - "Split 2 ways · $3.00 each";
  - or "Custom split · set by <name>" (A1.2).
- **The single secondary entry point:** tapping the avatars/status line or the name opens an **item detail sheet** (`accessibilityLabel` `Details for <row label>`). The sheet lists each claimer with their amount.
  - **If you're a claimer**, a small "Split differently" link reveals a parts stepper (− / +, 1–20) **for every claimer on this row**, with a live preview of each amount, and a "Save split" button.
  - Non-claimers see the amounts read-only, plus the hint "Claim this item to change how it's split."
  - "Reset to even" (claimers only) appears when parts differ, and sends every claimer at 1.
- **Saving a split when the claimers changed meanwhile** (`claimers_changed`) shows "Someone joined or left this item. Check the split and try again." and refetches.
- **No steppers, sliders or percentages on the main list.**
- **Shares:** a compact "Your share $X" at the top (or a sticky footer). Expanding it shows everyone's totals and "Unclaimed $Y". "Items $a + tax, tip and fees $b" appears only in the expanded view.
- **Live edits:** when a refetch brings a newer `edited_at`, show one dismissible line, "<Host> updated the bill. Shares were recalculated." An open sheet closes if its row was deleted.
- **Connection:** if the channel is in `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED` for more than 5 s, show a quiet "Live updates paused" with a "Refresh" link.
- **Extras split control (A1.7, Task 19):** one quiet line in the expanded shares summary, not on the item list.
  - Everyone sees it as text: "Tax & tip: split by what you ordered" or "Tax & tip: split equally".
  - **The host** sees it as a small selector with exactly those two options (`accessibilityLabel` "How tax and tip are split").
  - Under "equal", one muted helper line: "Split evenly between everyone who has claimed something."
  - **Pending state (A2.2)**, driven only by `displayShares`:
    - When `totalsVisible` is false, the top reads "Your items $X" instead of "Your share $X".
    - Each person's row shows their items subtotal, then the calm, muted line "Total shows once all items are claimed (N items left)" ("1 item left" when singular) in place of a total.
    - There's no tax/tip breakdown and no warning colour.
    - When the last row is claimed (live), totals appear with no other action.
  - Changing it is optimistic, with rollback and the fixed copy "Couldn't change how tax and tip are split." Other screens update live.
  - The "tax, tip and fees" breakdown in the summary uses the active mode's numbers.

## Activity log (A1.6; Tasks 15–17)
### Table `bill_events` (Task 15)
| Column | Type |
|---|---|
| `id` | `uuid pk default gen_random_uuid()` |
| `bill_id` | `uuid not null → bills on delete cascade` |
| `actor_id` | `uuid null → profiles(id) on delete set null` |
| `kind` | `text not null check (kind in ('bill_created','joined','claimed','unclaimed','split_changed','item_added','item_removed','item_changed','amounts_changed','link_rotated','extras_split_changed'))` (`extras_split_changed` added with A1.7) |
| `item_name` | `text null check (item_name is null or char_length(item_name) <= 100)` (snapshot) |
| `details` | `jsonb not null default '{}'` |
| `created_at` | `timestamptz not null default now()` |

- Index on `(bill_id, created_at desc)`.
- RLS is on. `revoke all ... from anon, authenticated, public`, then **only** `grant select ... to authenticated`.
- Policy: select using `private.is_bill_participant(bill_id)`.
- **No insert, update or delete grant or policy for any client role.**
- **Append-only guard:** a `before update or delete` trigger raises `42501` for every role except during a cascade from `bills` (`pg_trigger_depth() > 1`, or check that the parent bill is gone; *the engineer picks the reliable method and documents it*). So even `postgres`-run app functions can't rewrite history.
- `private.log_event(p_bill_id, p_actor, p_kind, p_item_name, p_details)`: `security definer`, `search_path = ''`, not executable by clients. All writers call it.

**`details` per kind** (cents are integers; user ids are uuids as strings):
| kind | written by | details | Example sentence (viewer is not the actor) |
|---|---|---|---|
| `bill_created` | `create_bill` | `{ "items": n, "total_cents": c }` | "Hana created the bill ($44.80, 3 items)" |
| `joined` | `join_bill` (only when a row is actually inserted) | `{}` | "Pat joined" |
| `claimed` | claims insert trigger | `{ "unit": [i, size] \| null, "split": {uid: parts} \| null }`. `split` is the row's parts **after** the change, included only when 2+ claimers remain and their parts aren't all equal (A2.3). | "Pat claimed Beer (1 of 2)" / "Pat claimed Nachos. Nachos is now split Sam 2 parts, Alex 1 part, Pat 1 part." |
| `unclaimed` | claims delete trigger (skipped on cascades) | same as `claimed` | "Pat removed their claim on Fries" |
| `split_changed` | `set_item_split` | `{ "unit": …, "before": {uid: parts}, "after": {uid: parts} }` | "Sam changed the Nachos split: Sam 2 parts, Pat 1 part (was even)" / "Sam set Nachos back to an even split" |
| `item_added` | `update_bill` | `{ "qty": n, "price_cents": c }` | "Hana added Wings ($9.00)" / "Hana added Beer ×2 ($14.00)" |
| `item_removed` | `update_bill` | `{ "qty": n, "price_cents": c, "claimer_ids": [uid…] }` | "Hana removed Soda (Pat's and Sam's claims were removed)" |
| `item_changed` | `update_bill` | any of `{ "name": [b,a], "qty": [b,a], "price_cents": [b,a], "note_changed": true }` | "Hana changed Burger from $12.00 to $14.00" / "Hana changed Beer: quantity 2 → 3, price $14.00 → $21.00" |
| `amounts_changed` | `update_bill` | any of `{ "tax_cents" \| "fees_cents" \| "tip_cents" \| "discount_cents" \| "total_cents": [b,a] }` | "Hana changed the tip from $7.00 to $9.00 and the total from $44.80 to $46.80" |
| `link_rotated` | `rotate_join_code` | `{}` (**never** the code itself) | "Hana made a new invite link. The old one no longer works." |
| `extras_split_changed` | `set_extras_split` | `{ "before": mode, "after": mode }` | "Hana changed tax & tip to split equally" / "Hana changed tax & tip to split by what each person ordered" |

- `item_name` is the group's name at the time; for `item_changed` with a rename, it's the **new** name.
- `unclaimed` uses the same `split` rule. For example, "Alex removed their claim on Nachos. Nachos is now split Sam 2 parts, Pat 1 part." When only one claimer remains, there's no split suffix.

### `lib/activityText.ts` (Task 16)
```ts
export type ActivityEvent = { id: string; kind: string; actorId: string | null; itemName: string | null;
  details: unknown; createdAt: string /* ISO */ };
export type NameOf = (userId: string | null) => string;   // "You" for the viewer, display name, "A friend" if null name, "Someone" if unknown/null id
/** One plain sentence, or null if the kind is unknown or details are malformed (the screen skips it). Never throws. */
export function describeEvent(e: ActivityEvent, nameOf: NameOf): string | null;
export type TimeLabel = { kind: 'just_now' } | { kind: 'today'; text: string } | { kind: 'yesterday' } | { kind: 'date'; text: string };
/** Groups by local time: < 2 min ago = just now; same day = "7:42 PM"; previous day = "Yesterday"; older = "Nov 18". Formatters injected for tests. */
export function timeLabel(createdAt: string, now: Date, fmt: { time(d: Date): string; date(d: Date): string }): TimeLabel;
export function groupEvents(events: ActivityEvent[], now: Date, fmt: …): { label: TimeLabel; events: ActivityEvent[] }[]; // newest first
```
- **Copy rules:**
  - Fixed sentence templates, with only names, item names and `formatCents` amounts interpolated.
  - The viewer reads as "You" ("You claimed Burger", "You removed your claim on Fries").
  - Name lists read "Pat", "Pat and Sam", or "Pat, Sam and Ali".
  - Parts read "1 part" or "2 parts".
  - A split's "before" is shown only when it's short (≤ 3 people), otherwise it's omitted.
  - An even "after" reads "back to an even split".
  - The unit suffix " (1 of 2)" appears only when `size > 1`.
- **Defensive parsing:** wrong types, missing fields, non-integer cents, or unknown kinds → `null`. No `parseFloat`.

### Activity UX (Task 17; `ui-ux-designer` skill required)
- **Entry point:** one quiet "Activity" text link in the bill screen header (`accessibilityLabel` "Activity"), which opens `/bills/[id]/activity`. There's no badge or counter in this slice, and nothing is added to item rows.
- **Screen:**
  - The title is "Activity".
  - Sections use the `timeLabel` headers ("Just now", "7:42 PM", "Yesterday", "Nov 18"), newest first.
  - Each entry shows the actor's initials avatar and the sentence, as `Text` only.
  - Empty state: "Nothing yet. Claims and changes will show up here."
  - The screen fetches the newest 200 events, refreshes live on the bill channel's `changed` hint (the same `subscribeToBill`), and also refetches on focus.
  - Events whose `describeEvent` returns `null` are skipped.
- **Access:** a non-participant or unknown bill shows the same no-access copy as the bill screen.

## Tasks
Order:
- **Track DB:** Task 1, then 2, then 3, then 4, then 5.
- **Track logic** (no DB needed): Tasks 6 and 7, starting immediately.
- Task 8 needs the contracts of Tasks 3–5.
- Task 9 needs Tasks 7 and 8. Task 10 needs Tasks 6 and 8. Tasks 11 and 12 need Task 10. Task 13 needs Tasks 7 and 10.
- Task 14 can start after Task 5, and must finish before the slice closes.
- **Activity (A1.6):**
  - Task 15 needs Tasks 3–5.
  - Task 16 (pure) can start immediately.
  - Task 17 needs Tasks 8, 10, 15 (contract) and 16.
  - Task 14 also covers Activity, so it finishes after Task 15.
- **Extras split (A1.7):**
  - Task 18 needs Task 15 (it logs an event).
  - Task 6 includes both modes from the start.
  - Task 19 needs Tasks 10 and 18 (contract).
  - Task 14 also covers this.

| # | Agent | Needs | Files (all in `splitit-app`) |
|---|---|---|---|
| 1 | supabase-engineer | none | `supabase/migrations/<ts>_bills_claims.sql` |
| 2 | supabase-engineer | 1 | `supabase/tests/database/bills_rls.test.sql` |
| 3 | supabase-engineer | 1 | `supabase/migrations/<ts>_bill_functions.sql`, `supabase/tests/database/bill_functions.test.sql` |
| 4 | supabase-engineer | 3 | `supabase/migrations/<ts>_bill_edit_realtime.sql`, `supabase/tests/database/bill_edit_realtime.test.sql` |
| 5 | supabase-engineer | 3 | `supabase/migrations/<ts>_item_split.sql`, `supabase/tests/database/item_split.test.sql` |
| 6 | implementer | none | `lib/split.ts`, `lib/split.test.ts` |
| 7 | implementer | none | `lib/billPayload.ts`, `lib/billPayload.test.ts` |
| 8 | implementer | 3–5 (contracts) | `lib/bills.ts`, `lib/bills.test.ts`, `lib/billLive.ts`, `lib/billLive.test.ts`, `lib/inviteLink.ts`, `lib/inviteLink.test.ts`, `test-utils/fakes.ts` |
| 9 | implementer + `ui-ux-designer` | 7, 8 | `app/(app)/bill.tsx`, `components/BillForm.tsx`, `__tests__/saveBill.test.tsx` |
| 10 | implementer + `ui-ux-designer` | 6, 8 | `app/(app)/bills/[id]/index.tsx`, `components/ClaimItemRow.tsx`, `components/Avatars.tsx`, `components/SharesSummary.tsx`, `lib/useBill.ts`, `__tests__/billScreen.test.tsx` |
| 11 | implementer + `ui-ux-designer` | 10 | `components/ItemSheet.tsx`, `app/(app)/bills/[id]/index.tsx`, `__tests__/itemSheet.test.tsx` |
| 12 | implementer + `ui-ux-designer` | 10 | `package.json` (`npx expo install expo-clipboard`), `components/SharePanel.tsx`, `app/b/[code].tsx`, `app/(app)/index.tsx`, `__tests__/inviteFlow.test.tsx`, `__tests__/shareAndJoin.test.tsx` |
| 13 | implementer + `ui-ux-designer` | 7, 10 | `app/(app)/bills/[id]/edit.tsx`, `__tests__/editBill.test.tsx` |
| 14 | docs-writer | 5, 15 | `docs/learning/**`, `docs/before-production.md` |
| 15 | supabase-engineer | 3, 4, 5 | `supabase/migrations/<ts>_bill_events.sql`, `supabase/tests/database/bill_events.test.sql` |
| 16 | implementer | none | `lib/activityText.ts`, `lib/activityText.test.ts` |
| 17 | implementer + `ui-ux-designer` | 8, 10, 15, 16 | `app/(app)/bills/[id]/activity.tsx`, `app/(app)/bills/[id]/index.tsx` (header link), `lib/bills.ts` (`fetchActivity`), `__tests__/activity.test.tsx` |
| 18 | supabase-engineer | 15 | `supabase/migrations/<ts>_extras_split.sql`, `supabase/tests/database/extras_split.test.sql` |
| 19 | implementer + `ui-ux-designer` | 10, 18 | `components/SharesSummary.tsx`, `components/ExtrasSplitControl.tsx`, `lib/bills.ts` (`setExtrasSplit`, plus `extrasSplit` in `fetchBill`), `lib/activityText.ts` (the new kind), `__tests__/extrasSplit.test.tsx` |

`native-mobile` isn't needed (no config plugin). The user rebuilds the dev client before any on-device check. Routes use `bills/[id]/index.tsx` plus `bills/[id]/edit.tsx`; the implementer confirms this nesting against Expo Router 57.

### Build order (A2.5)
There's one `supabase-engineer`, so the DB tasks run **one after another, in this order: 1 → 3 → 2 → 4 → 5 → 15 → 18**. Task 2 can also go right after Task 1. The other tasks run in parallel around them:

| Wave | Runs in parallel | Waits for |
|---|---|---|
| 1 | **T1** (DB), **T6** `split.ts`, **T7** `billPayload.ts`, **T16** `activityText.ts` | none |
| 2 | **T3**, then T2 (DB); **T8** data layer, coded against the contracts and checked against T3 once it lands | T1 |
| 3 | **T4**, then **T5** (DB); **T9** save; **T10** bill screen | T3; T7 + T8 for T9; T6 + T8 for T10 |
| 4 | **T15** (DB); **T11** item sheet, then **T12** share/join/home (serial: both mount into `bills/[id]/index.tsx`); **T13** edit screen in parallel | T4 + T5 for T15; T10 for T11–T13 |
| 5 | **T18** (DB); **T17** Activity screen | T15; T10 + T16 for T17 |
| 6 | **T19** extras control; **T14** docs | T18 + T10; T5 + T15 + T18 for T14 |

Then code review, QA (U1 and U2 first) and retro, per the `build-task` skill.

### Task 1 (supabase-engineer): schema, helpers, RLS, grants
- `npx supabase migration new bills_claims`. Everything in "Data model" (there is no reset trigger, A2.3).
- Comment each grant and each `security definer` the way the M0 migration does.
- `npm run db:reset` succeeds, and `profiles.test.sql` still passes with plan(45) unchanged.
- About 210 lines.

### Task 2 (supabase-engineer): pgTAP for schema, grants, RLS
- Fixture users:
  - **H** (host, `'Hana'`), **P** (`'Pat'`) and **R** (`'Rae'`, a participant who claims nothing).
  - **O** (outsider, `'Oli'`).
  - **Q**, who is in bill Y with O only.
- Insert the fixtures as `postgres`.
- Criteria 7–21. `plan(N)` must match.
- About 280 lines. If it's over, split it into `bills_rls` and `claims_rls`.

### Task 3 (supabase-engineer): create/join/rotate/set_claim + pgTAP
- `private.validate_bill_rows`, `create_bill`, `join_bill`, `rotate_join_code` and `set_claim`. Criteria 22–34.
- About 200 lines of SQL plus 220 of tests. If it's over 300, make two passes: validation and create, then join, rotate and set_claim.

### Task 4 (supabase-engineer): update_bill + Realtime broadcast + channel policy + pgTAP
- Criteria 35–44. Test the broadcast by counting `realtime.messages` rows for `bill:<X>` (as `postgres`) and checking the payload's keys.
- If `realtime.messages` isn't writable in the test DB (it's partitioned), report it, and test through a stubbable wrapper. Don't skip silently.
- About 250 lines.

### Task 5 (supabase-engineer): set_item_split + pgTAP
- `set_item_split`. There's no reset trigger (A2.3); parts are kept when claimers change. Criteria 45–52.
- About 200 lines.

### Task 6 (implementer): `lib/split.ts`, test-first
- Write the tests for criteria 53–63 (`extrasMode: 'proportional'`) 148–151 (`'equal'`, A1.7) and 157–160 (`sharesComplete`/`displayShares`, A2.2) first, including seeded property tests (no unseeded `Math.random`), then implement.
- About 110 lines of source plus 220 of tests.

### Task 7 (implementer): `lib/billPayload.ts`, test-first
- `toBillArgs` (unit expansion, edit id mapping), `draftFromSaved` and `SAVE_BLOCK_COPY`. Criteria 64–70. Tests build drafts through `draftReducer`/`fromParsed`. It reuses `allocate` from `lib/split.ts`; if Task 6 isn't merged yet, stub against the contract.
- About 260 lines.

### Task 8 (implementer): data layer, live channel, invite link
- **`lib/bills.ts`:** wrappers returning `{ ok: true, … } | { ok: false, error: BillError }`. `BillError` is `'invalid_code' | 'not_found' | 'not_allowed' | 'invalid_bill' | 'claimers_changed' | 'network'`, mapped from the SQLSTATE or the fixed message only.
  - `createBill`, `updateBill`, `joinBill`, `rotateJoinCode`, `setClaim(rowId, claimed)`, `setItemSplit(rowId, parts: Record<userId, number>)` and `listMyBills()`.
  - `fetchBill(id)` returns `{ bill, rows (ordered by group_position, unit_index), participants: { userId, displayName | null }[], claims }`.
    - A non-UUID id returns `not_found` without a query, and so do 0 rows.
    - Every cents and parts value is checked with `Number.isInteger`.
- **`lib/billLive.ts`:** `subscribeToBill(client, billId, onChange, onStatus): () => void`, per "Realtime" above. It ignores the payload. Tested with a fake channel and fake timers.
- **`lib/inviteLink.ts`:** `inviteUrl(code)` is `Linking.createURL('/b/' + code)` after `normalizeInviteCode`. An invalid code throws.
- **`test-utils/fakes.ts`:** `rpc`, a chainable `from()` fake, and `channel`/`removeChannel`/`realtime.setAuth` fakes. The `auth` fake doesn't change.
- About 300 lines.

### Task 9 (implementer, `ui-ux-designer`): save from the bill form
- Lift the draft state: `bill.tsx` owns `useReducer`, and `BillForm({ draft, dispatch })` becomes controlled. The M1a `billForm.test.tsx` must pass unchanged; if an assertion must change, name it and say why.
- **"Save and share"** replaces "Saving comes in the next update.":
  - Disabled with the `SAVE_BLOCK_COPY` reason when `toBillArgs` isn't ok.
  - "Saving…" while a save is in flight.
  - On success: `clearScanResult()`, then `router.replace('/bills/' + id)`.
  - On error: "Couldn't save the bill. Check your connection and try again.", with the draft kept.
- Criteria 71–74. About 200 lines.

### Task 10 (implementer, `ui-ux-designer`): bill screen, claims, avatars, shares, live
- **`lib/useBill.ts`:** fetch, subscribe, refetch on focus and foreground, and track `edited_at`.
- **The screen** follows "Claim screen UX".
  - States:
    - loading;
    - `not_found`: "You don't have access to this bill, or it doesn't exist." plus "Go home";
    - error: "Couldn't load the bill." plus "Try again".
  - The host sees "Edit items".
- **The claim toggle** calls `setClaim(row, true/false)`. It's optimistic, and rolls back with "Couldn't save your claim. Try again." on failure.
- **Avatars:** initials. A null name shows as "A friend" / "?". You're shown as "You".
- **Summary:** numbers come only from `displayShares` (A2.2) and `formatCents`. The component never decides on its own whether totals are visible. Negative extras are labelled "Items $a − discounts $b". When nothing is unclaimed: "Everything's claimed."
- Criteria 75–84. About 300 lines. If it's over, the summary moves to Task 11.

### Task 11 (implementer, `ui-ux-designer`): item detail sheet + custom split
- `ItemSheet` per "Claim screen UX": every claimer's stepper is editable for claimers, with "Save split" calling `setItemSplit` with **all** current claimers, plus "Reset to even".
- Optimistic, with rollback. `claimers_changed` shows the copy and refetches.
- Criteria 85–90. About 250 lines.

### Task 12 (implementer, `ui-ux-designer`): share panel, rotate, join, home list
- `npx expo install expo-clipboard` (report the version).
- **`SharePanel`**, for all participants:
  - The link text.
  - "Copy link", which shows "Link copied", or "Couldn't copy. Select the link and copy it yourself." on `false` or a throw.
  - "Share…", which calls `Share.share({ message: 'Claim what you had on SplitIt: ' + url })`. It's rendered only if `Platform.OS !== 'web'` or `typeof navigator.share === 'function'`.
  - "Make a new link" (host only), with the confirmation "The old link will stop working. People already in the bill stay in."
- **`/b/[code]`:** signed in with a valid code, call `joinBill` once (ref guard), then `router.replace('/bills/' + id)`.
  - `invalid_code`: "This link doesn't work anymore. Ask for a new one." plus "Go home".
  - Other errors: "Couldn't join. Try again." plus retry.
  - The signed-out branch and the single resume effect don't change (lessons).
- **Home:** "Your bills". Rows read "<host or 'You'>'s bill · date · $total". Empty state: "No bills yet." Keep "Scan receipt" and "Sign out".
- Update `inviteFlow.test.tsx`: the stub-text assertions become a `join_bill` call plus a landing on `/bills/<id>`.
- Criteria 91–98. About 300 lines.

### Task 13 (implementer, `ui-ux-designer`): host edit screen
- `/bills/[id]/edit`:
  - Host only. Anyone else sees "Only the person who created this bill can edit it." plus "Back".
  - `fetchBill`, then `draftFromSaved`, then a controlled `BillForm`.
  - The note "Changing a price updates everyone's share. Deleting an item removes anyone's claim on it."
  - Deleting a form row whose units have claims confirms first: "<N> people claimed this. Delete it anyway?"
  - On save, if `toBillArgs` returns non-empty `droppedClaimedIds` (qty lowered below the claimed units), confirm with "Lowering the quantity removes <N> claimed <item>. Continue?"
  - Then `updateBill`, then back to `/bills/<id>`.
  - Errors:
    - `invalid_bill`: "The bill changed while you were editing. Go back and try again."
    - `not_allowed`: the host-only copy.
    - Other errors: "Couldn't save your changes."
- Criteria 99–104. About 260 lines.

### Task 14 (docs-writer): learning notes, ADR 0013, before-production
- **New** `docs/learning/concepts/security-definer-functions.md`:
  - Definer vs invoker, and `search_path = ''`.
  - Why `set_item_split` is definer and how it limits itself (claimer check, this row only, parts only, row lock).
  - The `private` schema and RLS recursion.
  - Why this is not a custom backend.
  - Link the migrations.
- **Update** `realtime.md`: broadcast from the database vs `postgres_changes`, the data-free hint plus refetch, private channels, the `realtime.messages` policy. Answer its "Check yourself" questions.
- **Update** `money-and-rounding.md`:
  - Link `lib/split.ts`.
  - Unit rows: how a line price is split into units by largest remainder.
  - Parts and the even default, kept parts when claimers change (A2.3), the unclaimed slot, negative extras, the BigInt reasoning, and the "equal" pending state (A2.2).
- **Update** `row-level-security.md` and `database-design.md` with the real schema, including unit rows and the group fields. Keep the user's todo section.
- **ADR 0013** (0012 is reserved by M1a Task 8; if it's still free when this runs, still use 0013 and note why): "Multi-table, host-only and split writes go through SQL functions; live updates use data-free broadcasts; qty > 1 stored as unit rows". It amends ADR 0010's "the app writes `line_items` directly" (approved A1.4). Update the ADR README.
- **`before-production.md`:**
  - §4: rate limits for `create_bill`/`join_bill`/`set_claim`/`set_item_split`/`update_bill`; a participant cap; the 500-row cap; Realtime quotas on the free tier *(unverified)*.
  - §5: dev links are `localhost`/`splitit://`, and the friend-test deploy is the next slice.
- **Activity (A1.6):**
  - A new concept note, `docs/learning/concepts/audit-log.md`: append-only event tables, why writes happen in DB triggers and functions, snapshots vs references, and why the text is rendered in the app.
  - `before-production.md` §6: activity events are kept as long as the bill and record who did what and when. Decide retention and deletion along with account deletion and the privacy policy (a deleted account's events stay but show "Someone").

- **Extras split (A1.7):**
  - A new ADR (expected 0014; superseding nothing, but **amending ADR 0005**'s "allocated in proportion"): "Extras split mode: proportional or equal". Mark ADR 0005 with "Amended by 0014". Update the ADR README.
  - `money-and-rounding.md` gets an "Equal mode" section with the 334/333/333 example and the "early claimers carry it" consequence.
  - **Propose, don't apply**, this `CLAUDE.md` § Conventions wording for the user to approve: "Tax, tip, fees and bill-level discounts are allocated by the bill's `extras_split` setting: in proportion to each person's item subtotal (default) or equally among people who claimed something. Always largest-remainder rounding, so the shares add up to the bill total exactly."

### Task 18 (supabase-engineer): `extras_split` column + `set_extras_split` + pgTAP
- New migration:
  - add the column with its check;
  - add the function per the Functions table;
  - extend the `bill_events.kind` check with `extras_split_changed`.
- Criteria 143–147. About 120 lines.

### Task 19 (implementer, `ui-ux-designer`): extras split control
- `fetchBill` returns `extrasSplit` (validated against the two values; anything else counts as `network`). Add `setExtrasSplit(billId, mode)`.
- `ExtrasSplitControl` goes in the expanded summary, per "Claim screen UX". `computeShares` gets `extrasMode` from the bill.
- `describeEvent` handles `extras_split_changed`.
- The pending state under "equal" (A2.2b), rendered from `displayShares`.
- Criteria 152–155 and 161–163. About 220 lines.

### Task 15 (supabase-engineer): `bill_events` + writers + pgTAP
- New migration: the table, the index, grants, policy, the append-only guard and `private.log_event`.
- The claims AFTER insert/delete trigger writes `claimed`/`unclaimed`, skipping cascades. It includes `details.split` (the remaining parts) when 2+ claimers remain with unequal parts (A2.3).
- `create or replace` of `create_bill`, `join_bill`, `rotate_join_code`, `update_bill` and `set_item_split` to log their events. Don't edit the earlier migrations.
- In `update_bill`: group matching, one `item_changed` per changed group with only the changed fields, and one `amounts_changed` only if a money field changed. An edit with no actual changes logs nothing.
- Criteria 119–131. About 280 lines. If it's over, make two passes: table plus claim events, then function events.

### Task 16 (implementer): `lib/activityText.ts`, test-first
- `describeEvent`, `timeLabel` and `groupEvents` per the contract. Criteria 132–136.
- About 200 lines including tests.

### Task 17 (implementer, `ui-ux-designer`): Activity screen
- `fetchActivity(billId)` in `lib/bills.ts`: newest 200, mapped to `ActivityEvent`, with the same error mapping as the other wrappers.
- The header link on the bill screen and `app/(app)/bills/[id]/activity.tsx`, per "Activity UX". Live via `subscribeToBill`.
- Criteria 137–140. About 200 lines.

## Acceptance criteria
Tags:
- **[db]**: pgTAP.
- **[unit]** and **[router]**: Jest.
- **[manual-web]**: two Google accounts.
- **[device]**: optional, the user. QA reports these as NOT VERIFIED.

### Build
1. `npm run typecheck` exits 0, `npm test` exits 0, and `npx expo-doctor` has no failed checks (warnings listed with reasons).
2. `npm run db:reset` applies all migrations, and `npm run db:test` passes every file, including the unchanged `profiles.test.sql`. If Docker isn't running, the result is "not run".
3. `package.json` has `expo-clipboard` 57.x (added with `npx expo install`) and no `expo-sharing`.
4. `npm run export:web` (env inline) exits 0, and `grep -rE "service_role|sb_secret_" dist/` prints nothing.
5. `git diff --stat supabase/migrations/20261119055012_init_profiles.sql` is empty.
6. After the dev server runs, `git diff tsconfig.json` is clean or reverted.

### Schema and grants [db]
7. RLS is on for all four tables, and `anon` has no table privileges on them.
8. `authenticated`:
   - `bills`, `line_items`, `bill_participants`: `SELECT` only.
   - `claims`: `SELECT, DELETE` plus column `INSERT` on (bill_id, line_item_id, user_id), and **no `UPDATE` on any column**.
9. Every money column is `integer`. As `postgres`, each of these fails with `23514`:
   - a negative `total_cents`;
   - `group_size` 0 or 100;
   - `unit_index >= group_size`;
   - `parts` 0 or 21.
10. The `private` helpers are `security definer` with `proconfig = {search_path=""}`, and `anon` can't execute them. `config.toml [api] schemas` is unchanged.
11. The FK indexes exist.

### RLS [db] (bill X: host H, participants P and R. H and P have claims, R has none. Bill Y: O and Q.)
12. As O: all four tables return 0 rows for X. An unfiltered `bills` select returns only Y.
13. As P: P sees X, its rows, all three participants and **all** claims, including H's. P sees nothing of Y.
14. As O: a direct claim insert on an X row (with `user_id = O`) fails with `42501`.
15. As P: inserting a claim with `user_id = H` fails with `42501`. Deleting H's claim affects 0 rows.
16. As P: `update claims set parts = 3` on **P's own** claim fails with `42501` (no update grant).
17. A claim whose `line_item_id` belongs to X but whose `bill_id` is Y fails with `23503`, even as `postgres`.
18. As H and as P: writes to `line_items` and `bills`, and inserts into `bill_participants`, fail with `42501`.
19. Profiles:
    - H, P and R read each other's `display_name`.
    - O can't read them, and P can't read O or Q.
    - P can't update H's profile.
    - There's still no email column.
20. Deleting H's auth user cascades to X's rows, participants and claims.
21. Deleting one unit row (as `postgres`) deletes only that row's claims.

### Create, join, rotate, claim [db]
22. Every function has `proconfig = {search_path=""}`. Every function except `set_claim` is `security definer`. As `anon`, and as `authenticated` with no `sub`, each one raises `42501`.
23. `create_bill` as H with groups [Burger ×1 1500, Fries ×1 600, Beer ×2 700/700]:
    - It returns an id and a code matching `^[0-9a-f]{20}$`.
    - `host_id = H`.
    - The 4 rows have the given `group_position` and `unit_index`.
    - H is a participant.
    - The total check passes at 0 and at ±1¢.
24. 200 calls give 200 distinct, well-formed codes.
25. `create_bill` raises `22023` and leaves no rows for each of:
    - 0 rows, or 501 rows;
    - a row with an `id`;
    - `group_size` 0;
    - a group whose `unit_index` values are {0, 2}, or that has a duplicate `unit_index`;
    - a group whose rows have different names, or a size that differs from the row count;
    - `group_position` {0, 2};
    - `total_cents` −1, `12.5` or `"1250"`;
    - a blank or 101-char name, or a 201-char note;
    - a total 2¢ off;
    - a null tax.
26. `create_bill` has no host parameter (`pg_proc` argument names). A bill created as P has `host_id = P`.
27. `join_bill` as O with X's code returns X's id and makes O a participant. A second call returns the same id, with one participant row.
28. These all raise `P0002` with the same SQLSTATE and message, with no change: an unknown well-formed code, `'abc'`, uppercase hex, 21 chars, `''`, null.
29. `rotate_join_code(X)` as P, as O, and as H with a random UUID each raise `42501`. As H with X, it returns a new valid code. The old code then raises `P0002`, the new one works, and P still reads X.
30. `set_claim` as P:
    - `true` creates the claim with `parts = 1`, `user_id = P` and `bill_id = X`.
    - `true` again is a no-op.
    - `false` deletes it, and `false` again is a no-op.
    - It never changes H's claim.
31. As O: `set_claim` on an X row raises `P0002`, the same as with a random UUID.
32. A joiner can claim right after `join_bill`.
33. As O: `rotate_join_code(X.id)` gives the same error as with a random UUID.
34. No function body references `email`.

### Edit and Realtime [db]
35. `update_bill` as H on X, given Burger (kept, repriced to 1800), Fries (kept), Beer as a size-1 group (unit 0 kept, unit 1 **omitted**) and a new group "Wine ×1":
    - Beer unit 1 and **only its claims** are gone.
    - The claims on Burger, Fries and Beer unit 0 are unchanged (same users and parts).
    - Wine exists.
    - The money columns are updated and `edited_at` is set.
    - A failing validation leaves X exactly as before.
36. `update_bill` as P or O raises `42501`. A row `id` from Y raises `22023`, with X unchanged. Swapping two groups' `group_position` succeeds (the deferrable unique).
37. `update_bill` applies the criterion 25 validation: spot-check 0 rows, `12.5`, a total 2¢ off, and a broken `unit_index`.
38. After `set_claim` by P, `realtime.messages` has a new row with topic `bill:<X>`, event `changed`, private set, and a payload exactly `{"t":"claims"}` (no ids, parts or cents).
39. `join_bill` produces exactly one message with `t = bill_participants`. `update_bill` produces exactly one with `t = bills`, and none with `t = line_items`.
40. Claim deletes and `set_item_split` updates produce messages on the right topic (on deletes, the topic comes from `OLD`).
41. `private.can_listen_bill_topic('bill:<X>')` is true for H, P and R, and false for O. Malformed topics (`'bill:x'`, `'bill:'`, `'other:<X>'`, null) return false **without raising**. It's definer with an empty `search_path`.
42. `realtime.messages` has the select policy for `authenticated` and no client insert or update policy. As O, X's messages return 0 rows. As P, they're returned.
43. Triggers exist on `claims` (insert, update, delete), `bill_participants` (insert) and `bills` (update), and **not** on `line_items`.
44. When `update_bill` deletes a row that has claims, the claim deletes cascade without error. Any resulting messages go only to topic `bill:<X>`.

### Item split [db] (row F = Fries on X, claimed by H and P. R is a participant with no claim on F.)
45. As P, `set_item_split(F, {H: 2, P: 1})` sets H's parts to 2 and P's to 1, with `split_set_by = P` and `split_set_at` set.
46. As **R** (a participant, not a claimer of F), it raises `42501`, and nothing changes. As **O** (not a participant), it raises `P0002`, the same as with a random UUID.
47. As P, `{H: 2, P: 1, R: 1}` (adds a non-claimer) raises `22023`, and R has no claim afterwards. `{P: 2}` (omits H) also raises `22023`. Neither changes anything.
48. As P, the values `0`, `21`, `1.5`, `"2"` and a non-UUID key each raise `22023`, with no change.
49. Only row F is touched: P's and H's claims on Burger keep their parts, and Burger's `split_set_by` stays null.
50. It never inserts or deletes: the claim count on F is the same before and after any call.
51. **Parts are kept (A2.3):**
    - After the split from criterion 45 (H 2, P 1), R claims F: R has `parts = 1`, H still 2, P still 1, and `split_set_by` is still P.
    - Then P unclaims: H stays 2 and R stays 1.
    - Then R unclaims: H stays 2, and H is the only claimer.
    - The database has no trigger on `claims` that updates `parts` (check `pg_trigger` and `prosrc`).
52. `set_item_split` is definer with an empty `search_path`, and `anon` can't execute it. Its body takes a row lock on the item's claims (`for update`, checked in `prosrc`).

### Split math [unit], `lib/split.test.ts` (criteria 53–63 use `extrasMode: 'proportional'`)
53. `allocate`:
    - `allocate(100, [1000,1000,1000])` → `[34,33,33]`.
    - `allocate(1000, [2000,1000,1000])` → `[500,250,250]`.
    - `allocate(0, [1,2])` → `[0,0]`.
    - `allocate(-100, [1,1,1])` → `[-34,-33,-33]`.
    - `allocate(5, [0,3])` → `[0,5]`.
    - `allocate(1000, [1,1,1])` → `[334,333,333]` (unit expansion).
54. It throws `RangeError` for `[-1,2]`, for `[1.5]`, for an amount of `10.5`, and for `allocate(10, [0,0])`.
55. `allocate(99_999_999, [1_999_999_800, 1, 7])` sums exactly, with integer parts.
56. Property test, seeded, 1,000 cases: the sum is exact, the parts are integers, and each part is within 1 of the exact proportion.
57. **Worked bill:** rows Burger 1500, Fries 600, Beer#1 700, Beer#2 700, total 4480 (extras 980).
    - **(a)** Only B claims Fries and Beer#1: B gets 1300 + 364 = 1664. Unclaimed is items 2200, extras 616, total 2816.
    - **(b)** Then A claims Burger, Fries and Beer#2: A gets 2500 + 700 = 3200, and B gets 1000 + 280 = 1280. Unclaimed is 0. Fries is `shared` (300/300). Beer#1 and Beer#2 are each `claimed`.
    - **(c)** Then the Fries split is set to A 2, B 1: Fries is 400/200, `custom`. A gets 2600 + 728 = 3328, and B gets 900 + 252 = 1152.
58. Even split rounding: a row of 1000 claimed by `u1`, `u2`, `u3` gives 334/333/333 in userId order.
59. Nothing claimed: everyone gets 0, and unclaimed equals the total. Zero participants gives `people: []`. A claimed $0.00 row doesn't throw.
60. Discount: items 2000 (A 1500, B 500), total 1500, gives A 1125 and B 375.
61. Robustness:
    - Parts 50 are treated as 20.
    - Unknown rows and non-participants are ignored, and the invariant holds.
    - 10 seeded shuffles of the inputs give deep-equal results.
62. Invariant property test, seeded, 500 random bills: `Σ people + unclaimed === total`, with all values integers.
63. An edit recomputes: 57(b) with Burger repriced to 1800 and total 4780 gives a sum of 4780, with claims unchanged.

### Payload [unit], `lib/billPayload.test.ts`
64. Burger `15.00`, Fries `6.00`, Beer qty `2` `14.00`, tax `2.80`, tip `7.00`, total `44.80` gives:
    - 4 rows: Burger (g0, u0, size 1, 1500), Fries (g1, u0, 1, 600), Beer (g2, u0, 2, 700) and Beer (g2, u1, 2, 700). None has an `id`, and the notes are null.
    - Money: subtotal null, tax 280, fees 0, tip 700, discount 0, total 4480.
    - Every number is an integer.
65. Beer qty 3 at `10.00` expands to 334, 333 and 333 (sum 1000). Qty 99 at `1.00` (100 cents) gives one row of 2 and 98 rows of 1. A seeded property test over random qty (1–99) and price shows the units always sum exactly to the line price, with no two units more than 1¢ apart.
66. A blank total gives 4480 (computed). A `5.00` subtotal discount plus a `1.00` total discount gives discount 600.
67. Each of these returns its reason in the contract's order: `has_errors` (`12.999`), `no_items`, `mismatch` (subtotal 2¢ off), `too_many_units` (6 rows × qty 99), and `negative_total`. A blank draft row in the middle doesn't shift `group_position`.
68. Round trip: `draftFromSaved` on criterion 64's saved rows gives 3 form rows with Beer qty `2`, price `14.00`. `toBillArgs` with `saved` gives the same rows with their saved ids.
69. Qty changes on edit:
    - Beer from 2 to 3 at `21.00` keeps both ids on units 0 and 1, and unit 2 has no id. All three are 700.
    - Beer from 2 to 1 at `7.00`, with unit 1 claimed and unit 0 unclaimed, **keeps unit 1's id** and drops unit 0's. `droppedClaimedIds` is empty.
    - With both claimed, it drops the highest index, and `droppedClaimedIds` holds that id.
    - Deleting the Fries row omits Fries' id.
    - A newly added row has no ids.
70. `draftFromSaved` shows tax, fees and tip of 0 as `''`, and a null subtotal as `''`.

### Save [router], `__tests__/saveBill.test.tsx`
71. With an empty draft, "Save and share" is disabled, with "Add at least one item to save."
72. Saving criterion 64's bill calls `rpc('create_bill', …)` **once** (even on a double press) with exactly criterion 64's rows and money, then lands on `/bills/<id>`. `getScanResult()` is null.
73. A failed save shows the fixed copy, doesn't show the server message, and keeps every field.
74. With the mismatch banner shown, Save is disabled. After saving, the pathname has no search params.

### Bill screen [router], `__tests__/billScreen.test.tsx` (criterion 57's bill, signed in as B)
75. Shows 4 rows: Burger, Fries, "Beer · 1 of 2" and "Beer · 2 of 2". Also "Total $44.80", the host's name, and B as "You".
76. Each row has exactly **one** button (the toggle) plus the details target. There's no stepper or percentage on the list.
77. `Claim Fries` calls `rpc('set_claim', { p_line_item_id, p_claimed: true })`, and B's avatar appears before it resolves. `Claim Beer 1 of 2` claims only that unit row.
78. State 57(a): "Your share $16.64", and the expanded summary shows "Unclaimed $28.16". State 57(b): "Your share $12.80", A at "$32.00", "Everything's claimed.", and Fries "Split 2 ways · $3.00 each". State 57(c): Fries shows "Custom split · set by <name>".
79. A failed `set_claim` rolls back and shows the fixed copy, not the server message.
80. **Live:** a fake `changed` message gives one refetch after the debounce, and three quick messages also give one. New claims appear without any user action. Re-emitting `SUBSCRIBED` refetches. Unmounting calls `removeChannel`.
81. The channel is `bill:<id>` with `private: true`, and the payload is never read: a payload containing `user_id` changes nothing beyond the refetched data.
82. A newer `edited_at` shows the "updated the bill" line, which can be dismissed.
83. A channel error lasting more than 5 s shows "Live updates paused" with "Refresh", and pressing Refresh refetches.
84. An unknown id, a non-UUID id or 0 rows shows the no-access copy with no `rpc`. A null name shows "A friend". `queryByText(/@/)` is null with a session that has an email.

### Item sheet [router], `__tests__/itemSheet.test.tsx`
85. `Details for Fries` lists every claimer with their amount (A $3.00, B $3.00).
86. As a claimer (B), "Split differently" shows **a stepper for each claimer** (A and B). Changing A to 2 previews $4.00/$2.00. "Save split" calls `rpc('set_item_split', { p_line_item_id, p_parts: { <A>: 2, <B>: 1 } })`, with **every** current claimer in `p_parts`.
87. A non-claimer sees amounts only, with no steppers and no "Save split", plus "Claim this item to change how it's split."
88. `claimers_changed` shows "Someone joined or left this item. Check the split and try again." and refetches. Any other failure rolls back the preview with fixed copy.
89. "Reset to even" only shows when parts differ, and it sends every claimer at 1.
90. When a live refetch deletes the row, the sheet closes.

### Share and join [router], `__tests__/shareAndJoin.test.tsx` + `inviteFlow.test.tsx`
91. Web (no `navigator.share`): "Copy link" calls `setStringAsync('http://localhost:8081/b/<code>')` and shows "Link copied". "Share…" isn't rendered.
92. Native (`'ios'`): "Share…" calls `Share.share` once, with a message containing `splitit://b/<code>`. If the copy resolves `false`, the fallback copy shows.
93. A non-host sees "Copy link" but not "Make a new link". The host confirms, `rotate_join_code` runs, and the link updates. Cancelling calls nothing.
94. Signed in, `/b/<valid>` calls `join_bill` **exactly once** and lands on `/bills/<id>`.
95. Signed out, `/b/<code>` → sign in → resume → join → `/bills/<id>`. Tested on **both** the web and native paths.
96. `invalid_code` shows "This link doesn't work anymore. Ask for a new one." Other errors show "Couldn't join. Try again.", and retry calls the function again.
97. `/b/bad` still shows the M0 invalid-invite message, with no `rpc`.
98. Home lists "Your bills", and each row links to its bill. An empty list shows "No bills yet."

### Edit [router], `__tests__/editBill.test.tsx`
99. As the host, "Edit items" opens `/bills/<id>/edit` with 3 form rows. Beer shows qty `2` and price `14.00`.
100. Burger to `18.00` and the total to `47.80`, then save: `update_bill` is called with Burger's saved id at 1800, the Beer unit ids unchanged and total 4780. The app returns to the bill.
101. Deleting Fries (2 claimers) asks "2 people claimed this. Delete it anyway?". Cancelling keeps it. Confirming and saving omits Fries' id.
102. Beer qty from `2` to `1` with both units claimed asks "Lowering the quantity removes 1 claimed Beer. Continue?". Cancelling makes no `rpc`.
103. A non-host sees the host-only copy and no form. `invalid_bill` shows the "changed while you were editing" copy.
104. Save is blocked with the `SAVE_BLOCK_COPY` reason while the numbers don't add up.

### Hygiene and privacy
105. `git grep -nE "console\.(log|info|debug|warn)\(" -- lib/split.ts lib/billPayload.ts lib/bills.ts lib/billLive.ts lib/useBill.ts lib/inviteLink.ts components/ClaimItemRow.tsx components/Avatars.tsx components/SharesSummary.tsx components/ItemSheet.tsx components/SharePanel.tsx "app/(app)/bills" "app/b"` returns nothing.
106. `git grep -nE "parseFloat|toFixed|Math\.round|\* ?100\b" -- lib/split.ts lib/billPayload.ts lib/bills.ts components/SharesSummary.tsx components/ItemSheet.tsx` returns nothing.
107. `git grep -nE "error\.message|\.message\}" -- app components` returns nothing.
108. The only route params are `id` (a UUID) and `code`.

### Manual web [manual-web]: two Google accounts in two browser profiles side by side (U1, U2)
109. **A:** sign in → Scan receipt → Enter items. Enter criterion 64's bill → "Save and share". The bill shows 4 rows (two "Beer · n of 2") and "Total $44.80". "Copy link" copies `http://localhost:8081/b/<20 hex>`.
110. **B (signed out):** open the link → sign-in → Google → B lands on the bill. B's home lists it.
111. **Live join:** within about 3 s, B appears on A's screen without A doing anything.
112. **Live claims:** B claims Fries and "Beer · 1 of 2". Without a refresh, A sees B's avatars within about 3 s, and B's share is $16.64. Then A claims Burger, Fries and "Beer · 2 of 2". Both screens show A $32.00, B $12.80, "Everything's claimed." and Fries "Split 2 ways · $3.00 each".
113. **Custom split by any claimer:** **B** opens Fries → Split differently and sets A to 2 and B to 1 → Save split. Both screens show A $33.28 and B $11.52, and Fries "Custom split · set by <B's name>". Then B unclaims Fries: A alone pays the $6.00 Fries. B reclaims: **A's 2 parts are kept** and B gets 1, so it's back to A $33.28, B $11.52, still "Custom split · set by <B's name>" (A2.3).
114. **Host edit live:** A edits Burger to $18.00 and Beer to qty 1 at $7.00 (confirming the claimed-unit prompt if shown), sets the total to match, and saves. B's screen updates without a refresh: one Beer row, the notice line, and shares that sum to the new total.
115. **Isolation:** A's second bill, never shared, doesn't appear in B's list, and its URL shows the no-access copy in B's profile.
116. **Revoke:** after "Make a new link", the old link shows "This link doesn't work anymore…" for B, and B still opens the bill from home.
117. **Reconnect:** set B's profile offline (DevTools → Network → Offline) while A changes a claim, then back online. B shows the change within about 5 s.
118. A's email address appears nowhere in B's profile (browser find for `@`).

### Activity: table and writers [db], `bill_events.test.sql` (fixtures as in criteria 12 and 45)
119. RLS is on for `bill_events`. `anon` has no privileges. `authenticated` has `SELECT` only (`table_privs_are`).
120. As P, `insert into bill_events …` fails with `42501`. As P, `update` and `delete` on X's events fail with `42501` (no grant).
121. The append-only guard: as `postgres`, `update`/`delete` of an X event raises `42501`. Deleting bill X (as `postgres`, by deleting H's user) still cascades and removes X's events.
122. As O, X's events return 0 rows. As P and R, they're returned. As P, Y's events return 0 rows.
123. `private.log_event` is definer with an empty `search_path`, and isn't executable by `anon` or `authenticated`.
124. `create_bill` logs exactly one `bill_created` event (actor H, `details` with `items` and `total_cents`). `join_bill` logs one `joined` event on the first call and **none** on a repeat call.
125. `set_claim(F, true)` as R logs `claimed` (actor R, `item_name` 'Fries'). `set_claim(F, false)` logs `unclaimed`. A claim on "Beer 1 of 2" logs `details.unit = [0, 2]`. With F split H 2, P 1, R's claim logs `details.split = {H: 2, P: 1, R: 1}`. P's later unclaim logs `split = {H: 2, R: 1}`. When only one claimer remains, `split` is null. An even split logs `split` null.
126. `set_item_split` as P logs one `split_changed` event with actor P, and `before`/`after` equal to the parts before and after. A failed call (criteria 46–48) logs nothing.
127. `update_bill` with Burger repriced 1500 → 1800, Beer qty 2 → 1, Soda removed (claimed by P and R) and Wings added logs exactly:
     - `item_changed` Burger `{price_cents: [1500, 1800]}`;
     - `item_changed` Beer `{qty: [2, 1], price_cents: [1400, 700]}`;
     - `item_removed` Soda with `claimer_ids` = [P, R] (any order);
     - `item_added` Wings;
     - `amounts_changed` with only the changed money fields.
     It logs **no** `unclaimed` events for the cascaded claims.
128. `update_bill` with identical content logs no events. A failed `update_bill` logs nothing (it's all one transaction).
129. `rotate_join_code` logs `link_rotated`, and its `details` don't contain the old or new code (`details::text` doesn't match `[0-9a-f]{20}`).
130. No event row contains an email: `details::text` and `item_name` across all fixture events don't match `@`, and the table has no email column.
131. The column defaults and kind check hold: an unknown `kind` (inserted as `postgres` with the guard bypassed for the test, or through `log_event`) fails with `23514`.

### Activity: text [unit], `lib/activityText.test.ts`
132. For every kind in the table above, `describeEvent` returns the example sentence exactly (names supplied by `nameOf`). With the viewer as the actor, it returns "You claimed Burger", "You removed your claim on Fries", and so on.
133. Name lists: one, two and three claimers read "Pat", "Pat and Sam", "Pat, Sam and Ali". A null `actorId` reads "Someone". Parts read "1 part" or "2 parts". A split whose after-parts are all 1 reads "… back to an even split".
134. Malformed input returns `null` and never throws:
     - an unknown kind;
     - `details` that is null, a string or an array;
     - `price_cents` of `12.5` or `"1200"`;
     - a `unit` that isn't a 2-number array;
     - a missing `item_name` for item kinds.
     Run it over 200 seeded random `details` values.
135. Amounts go through `formatCents` (1200 → "$12.00"). The output contains no `NaN`, `undefined` or `[object Object]` for any fixture.
136. `timeLabel` with an injected `now` and formatters: 30 s ago is `just_now`, 3 h ago on the same day is `today`, 1 day earlier is `yesterday`, 5 days earlier is `date`. `groupEvents` returns newest first and keeps events in the same group together.

### Activity: screen [router], `__tests__/activity.test.tsx`
137. The bill screen has exactly one "Activity" link and no activity content on the item rows. Pressing it opens `/bills/<id>/activity`.
138. With fake events from criterion 127 plus claims, the screen shows "Activity", time headers, and each sentence with initials, newest first. An event that maps to `null` isn't rendered and doesn't crash the screen.
139. A `changed` hint on the fake channel refetches once after the debounce, and a new "Pat claimed Wings" appears. The empty state shows "Nothing yet. Claims and changes will show up here."
140. An unknown or inaccessible bill shows the no-access copy. `queryByText(/@/)` is null.

### Activity: manual [manual-web], continuing from criteria 109–118
141. After steps 112–114, A opens Activity: it reads like plain sentences, in time groups. It includes "<B> joined", "<B> claimed Fries", "<B> changed the Fries split: …", "<B> removed their claim on Fries" and "<B> claimed Fries. Fries is now split You 2 parts, <B> 1 part." (from the unclaim and reclaim; the exact name-list wording comes from `activityText`), "You changed Burger from $15.00 to $18.00" and "You changed Beer: quantity 2 → 1, …". B's Activity shows the same events, with B's own entries as "You".
142. With A's Activity open, B claims something. A new line appears without a refresh, under "Just now".

### Extras split: database [db], `extras_split.test.sql` (A1.7)
143. `bills.extras_split` defaults to `proportional`. As `postgres`, `'even'` fails with `23514`. As P, a direct `update bills set extras_split = 'equal'` fails with `42501`.
144. `set_extras_split(X, 'equal')` as H sets the column, logs one `extras_split_changed` event `{before: 'proportional', after: 'equal'}` with actor H, and produces one `bill:<X>` broadcast. `edited_at` is unchanged.
145. As P, as R, and as H with a random UUID, it raises `42501`. As O with X's id, it raises `42501`, the same as with a random UUID. Nothing changes and nothing is logged.
146. `set_extras_split(X, 'Equal')`, `''` and null each raise `22023`. Setting `'equal'` twice logs only one event.
147. The function is definer with an empty `search_path`. `anon` can't execute it.

### Extras split: math [unit], `lib/split.test.ts` (`extrasMode: 'equal'`)
148. **Three people, $10.00 tip:** items u1 500, u2 300, u3 200 (one row each, each claimed by one person), tip 1000, total 2000. Equal gives extras 334/333/333 to u1/u2/u3 (userId order), so totals 834/633/533 = 2000. Proportional on the same input gives 500/300/200.
149. **Worked bill, equal:**
     - 57(a) (only B claimed): B gets 1300 + 980 = 2280. Unclaimed is items 2200 and **extras 0**, total 2200. Sum 4480.
     - 57(b) (A and B claimed): A gets 2500 + 490 = 2990, and B gets 1000 + 490 = 1490. Sum 4480.
150. Edge cases:
     - Nobody claimed: every extra goes to unclaimed (`unclaimedExtrasCents === extrasCents`).
     - A participant with no claims gets 0 extras.
     - A person whose only claim is a $0.00 row still gets an equal share.
     - Negative extras (−500 between 2 claimers) give −250/−250.
     - Odd negatives (−101 between 2) give −51/−50.
151. Property test, seeded, 500 random bills in `equal` mode: `Σ people + unclaimed === total`. All values are integers. Any two claimers' `extrasCents` differ by at most 1. Unclaimed extras are 0 whenever anyone has claimed. Shuffled inputs give deep-equal results.

### Extras split: screen [router], `__tests__/extrasSplit.test.tsx`
152. Expanding the summary shows "Tax & tip: split by what you ordered" to everyone. A non-host sees text only, with no control (no element with `accessibilityLabel` "How tax and tip are split").
153. As the host, choosing "split equally" calls `rpc('set_extras_split', { p_bill_id, p_mode: 'equal' })`. Before it resolves, the shares update to criterion 149(b)'s numbers (A $29.90, B $14.90) and the helper line appears. On failure, they roll back with "Couldn't change how tax and tip are split."
154. A live refetch that brings `extras_split = 'equal'` updates a participant's screen with no action.
155. Activity renders `extras_split_changed` as "Hana changed tax & tip to split equally", or "You changed …" for the host.

### Extras split: manual [manual-web], continuing from criterion 112's state (A $32.00, B $12.80)
156. A (host) opens the summary and switches tax & tip to "split equally". Both screens show A $29.90 and B $14.90 without a refresh, and still add up to $44.80. B sees the setting as text only. Both Activity screens show "… changed tax & tip to split equally". Switching back restores $32.00 / $12.80.

### Pending totals under "equal" [unit], `lib/split.test.ts` (A2.2)
157. `sharesComplete`:
     - The worked bill with nothing claimed gives `{ complete: false, unclaimedRows: 4 }`.
     - 57(a) gives `unclaimedRows: 2`, and 57(b) gives `{ complete: true, unclaimedRows: 0 }`.
     - A claim with parts ≤ 0, or by a non-participant, doesn't count.
     - A claimed $0.00 row counts as claimed.
158. `displayShares` in `equal` mode with Burger unclaimed (A: Fries and Beer#2; B: Fries and Beer#1):
     - `totalsVisible: false`.
     - A and B each have `itemsCents` 1000 with `extrasCents` and `totalCents` **null**.
     - `unclaimedItemsCents` is 1500, `unclaimedExtrasCents` is 0, and `unclaimedRows` is 1.
     - Once Burger is claimed by A: `totalsVisible: true`, A 2500 + 490 = 2990, and B 1000 + 490 = 1490.
159. `displayShares` in `proportional` mode with the same incomplete claims has `totalsVisible: true` and numbers identical to `computeShares`.
160. Property test, seeded, 300 random bills in both modes:
     - `totalsVisible === (mode === 'proportional' || complete)`.
     - When visible, the numbers equal `computeShares` exactly.
     - When hidden, every `extrasCents` and `totalCents` is null, and every `itemsCents` still equals `computeShares`'s.

### Pending totals: screen [router], `__tests__/extrasSplit.test.tsx` (A2.2)
161. In `equal` mode with 1 unclaimed row, the summary shows "Your items $10.00" (no "Your share"), and each person's row shows "Total shows once all items are claimed (1 item left)". With 3 unclaimed rows, it shows "(3 items left)". No tax/tip breakdown is rendered, and `queryByText(/\$29\.90|\$14\.90/)` is null.
162. A live refetch in which the last row becomes claimed replaces the pending lines with the totals (A $29.90, B $14.90) without any user action. Switching the host control to proportional while incomplete shows totals at once.
163. The summary component contains no completeness logic of its own: with `displayShares` mocked to `totalsVisible: false`, it renders the pending state even when every row is claimed in the props.

### Pending totals: manual [manual-web] (A2.2)
164. A switches to "split equally", then B unclaims "Beer · 1 of 2". Both screens show only items subtotals and "Total shows once all items are claimed (1 item left)". B reclaims it, and both screens show the totals again within about 3 s. In proportional mode the same unclaim leaves totals visible.

### On device [device], optional, the user (rebuild the dev client first)
- **D1.** The app builds and launches after `npx expo install expo-clipboard` and `npx expo run:ios --device`.
- **D2.** "Share…" opens the iOS share sheet with `splitit://b/<code>`, and "Copy link" works.
- **D3.** A claim made on the phone shows up live in the web profile (if the phone can reach the Mac's Supabase).

## Risks / open questions
### Decided
- A1.1–A1.7 and A2.1–A2.4 above. The friend-test deploy (A1.1) is the next slice.
- **For M3 (A2.2a):** settling is blocked while any item is unclaimed.

### Open (no decision needed to build; raise if it feels wrong in QA)
- **Kept custom parts can surprise a newcomer** (A2.3). Example: Sam 2, Alex 1, then Pat joins at 1 → 2:1:1. Mitigations: Activity spells out the resulting split, and the item shows "Custom split · set by <name>". Watch for confusion in QA.
- **The pending total under "equal"** (A2.2b) means nobody sees a final number until the last item is claimed. That's intended. If one person never claims, the host needs a way to resolve it: that's the M3 unclaimed-items decision (A1.5).
- **Activity retention:** events live as long as the bill, and a deleted account shows as "Someone". Fine for dev. Decide alongside account deletion and the privacy policy before launch (logged in `before-production.md` §6 by Task 14).
- **Activity later ideas** (not in this slice): filter by person or item, search, export, "load older" beyond 200, an unread badge on the Activity link.

### Technical risks
- **Realtime API details** come from the docs and haven't been run yet (`realtime.send` arguments, `realtime.topic()`, the policy shape, `setAuth` in supabase-js 2.109). Tasks 4 and 8 verify them and report each deviation in one plain sentence (lessons).
- **Testing `realtime.messages` in pgTAP** may be awkward (it's partitioned). Task 4 has a fallback and must not skip silently.
- **`set_item_split` is a definer function writing other people's rows.** Its guard list (participant, current claimer, exact claimer set, this row only, parts only, row lock) is the security boundary. Code review must check each item against criteria 45–52.
- **Race:** someone claims a row while another claimer saves a split. The row lock plus the exact-claimer-set check returns `claimers_changed`, and the client refetches.
- **Unit-row volume:** a qty-99 line becomes 99 rows. The 500-row cap limits this. The UI must stay usable with many identical rows; the `ui-ux-designer` skill decides whether long groups collapse visually without adding controls.
- **No server-side rate limiting** (ADR 0010). Spam on create, join, claim and split is possible, and Realtime message volume grows with claims × participants. Logged in `before-production.md`.
- **RLS recursion** on `bill_participants` must go through the definer helper (criteria 12–13).
- **Activity `split` snapshot:** the claims event trigger (Task 15) reads the row's remaining claims after the insert or delete to build `details.split`. It must be an AFTER trigger so it sees the final state. Criterion 125 checks it.
- **Telling a cascade apart from a user's own unclaim** in the claims delete trigger relies on the parent row being gone at trigger time. Verify on Postgres 17 (criterion 127 checks it).
- **The append-only guard vs bill cascades:** the guard must block direct updates and deletes but still let `on delete cascade` from `bills` through (criterion 121).
- **M0 and M1a tests change:** `inviteFlow.test.tsx` (the stub text) and possibly `billForm.test.tsx` (lifted state). The behavior must not change, and each changed assertion is named.
- **Expo Router nesting** of `bills/[id]/index.tsx` and `edit.tsx`: verify it.
- **Native rebuild** for `expo-clipboard`. Free Apple ID installs expire after 7 days.
- **`db:reset` wipes local data.**

## Amendment A3 (2026-11-21): discounts stored by position; DB totals check matches the form
Found while building Task 7. Main-session engineering decision (no product change).
1. **Bills store two discounts, not one.** `bills.discount_cents` is replaced by `subtotal_discount_cents` and `total_discount_cents` (integer, 0..99999999, default 0). `create_bill` / `update_bill` take `p_subtotal_discount_cents` and `p_total_discount_cents` instead of `p_discount_cents`. Reason: with one number, reloading a bill for host edit couldn't tell where a discount applied, so the form showed a false "items don't add up to the subtotal" and blocked save. `draftFromSaved` reloads each non-zero amount as one discount row in its position.
2. **The DB totals check is the same two ±1¢ checks as `checkTotals`** (items − subtotal discounts vs subtotal; subtotal + tax + fees + tip − total discounts vs total), not one combined check, so a draft the form accepts (e.g. 1¢ + 1¢) is never rejected as `invalid_bill`.
3. **The `amounts_changed` activity event** carries both discount fields.
4. **Task 13:** the edit screen confirms before saving when `toBillArgs` returns a non-empty `removedClaimedIds` (saved rows whose fields were all cleared — treated like deletion) as well as `droppedClaimedIds` (quantity lowered on claimed units).
Everywhere else this spec says `discount_cents`, read it as these two fields.

## Amendment A4 (2026-11-22): wording and review fixes
1. **Mode names (user decision):** the two extras modes are shown as **"split proportionally"** (default) and **"split evenly"** everywhere: summary, host selector, even-mode helper and Activity. The DB values stay `proportional` / `equal`. Read every "split by what you ordered" / "split equally" in this spec as these names.
2. **Review fixes** landed in `supabase/migrations/20261122085802_m2_review_fixes.sql`:
   - `amounts_changed` carries only `subtotal_discount_cents` / `total_discount_cents`.
   - `item_changed` carries `removed_claimer_ids` when lowering a quantity drops claimed units (user-approved).
   - Co-participants can read `profiles(id, display_name)` only, through one merged SELECT policy.
   - service_role can't write `bill_events`.
   - The append-only guard is security definer.
   - `update_bill` rejects merging rows from several old groups.
   - `set_claim` maps a concurrent-delete FK violation to `P0002`.
   - App side: the edit screen re-checks claims before saving (`freshSaveCheck`); "Unclaimed $X" shows whenever unclaimed cents ≠ 0 (user decision); Activity time headers stay per-minute (user decision).
3. **Criterion 107:** its grep matched a style name (`styles.message` in `app/(app)/scan.tsx`), not error text. The style was renamed to `messageBox`; the criterion's wording is unchanged.
