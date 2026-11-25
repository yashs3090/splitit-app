# Database design

## The idea
A relational database stores data in **tables** (rows and columns) and links them with **keys**. Good design means each fact is stored once, relationships are enforced by the database, and common queries are fast.

Key vocabulary:
- **Primary key (PK):** a column that uniquely identifies a row. We use `uuid` ids (`gen_random_uuid()`), which can't be guessed or counted the way 1, 2, 3 can.
- **Foreign key (FK):** a column that must match a PK in another table, e.g. `line_items.bill_id → bills.id`. The database refuses orphan rows. `on delete cascade` deletes children when the parent goes; `on delete set null` keeps the child but blanks the link.
- **Composite key:** a key made of two or more columns, like `(bill_id, user_id)`.
- **One-to-many:** one bill has many line items.
- **Many-to-many:** users ↔ bills (a user is in many bills, a bill has many users). This needs a **join table** (`bill_participants`) with a composite PK `(bill_id, user_id)`.
- **Normalization:** don't duplicate facts. A bill's total is stored once on `bills`; a person's share is *computed* from claims rather than stored per person, so it can't drift out of sync.
- **Constraints:** rules the database enforces, like `check (total_cents >= 0)`, `not null` and `unique`. They're your last line of defense against bad data.
- **Index:** a lookup structure that makes `where bill_id = …` fast. Postgres indexes PKs and `unique` columns automatically, but **not FKs**, so we add those indexes ourselves.
- **Transaction:** a group of writes that all succeed or all fail. Saving a bill (bill + items + host participant) is one transaction.
- **Migration:** a versioned SQL file that changes the schema, named by timestamp (`supabase/migrations/20261121074115_bills_claims.sql`). Migrations are applied in order, everywhere, so every environment has the same schema. Once applied, a migration is never edited; changes go in a new one.

## Why it matters here
Money must add up to the cent, five phones must agree on who claimed what, and nobody should see a bill they weren't invited to. A lot of that is enforced by the schema itself: foreign keys, `check` constraints and cascades work even if the app has a bug.

## How we use it
### The tables (as built, updated 2026-11-25)
```
profiles          (id PK = auth.users.id, display_name, venmo_username NULL,
                   venmo_prompt_dismissed_at NULL, created_at, updated_at)            -- no email column
bills             (id PK, host_id FK→profiles, currency 'USD',
                   subtotal_cents NULL, tax_cents, fees_cents, tip_cents,
                   subtotal_discount_cents, total_discount_cents, total_cents,
                   join_code UNIQUE, extras_split 'proportional'|'equal',
                   payer_id NOT NULL,                       -- (id, payer_id) FK→bill_participants, deferred
                   created_at, edited_at)
line_items        (id PK, bill_id FK→bills, group_position, unit_index, group_size,
                   name, note, total_cents, split_set_by FK→profiles, split_set_at)   -- one row per UNIT
bill_participants (bill_id FK→bills, user_id FK→profiles, joined_at, added,
                   settled_at NULL, settled_cents NULL)                              PK(bill_id, user_id)
claims            (bill_id, line_item_id, user_id, parts 1–20, created_at, updated_at) PK(line_item_id, user_id)
bill_events       (id PK, bill_id FK→bills, actor_id FK→profiles NULL, kind, item_name, details jsonb, created_at)
bill_seen         (bill_id, user_id, seen_at)  PK + FK(bill_id, user_id)→bill_participants on delete cascade   -- owner-only
```
Where they're defined:
- `bills`, `line_items`, `bill_participants`, `claims`: `supabase/migrations/20261121074115_bills_claims.sql:28-146`.
- The two discount columns replaced a single `discount_cents`: `20261121074859_bill_discounts_split.sql:14-20`.
- `extras_split`: `20261121130144_extras_split.sql:15-17`.
- `bill_events`: `20261121080352_bill_events.sql:29-54`.
- Added 2026-11-24 (updated in this note 2026-11-25):
  - `profiles.venmo_username`, `venmo_prompt_dismissed_at`: `20261124072017_profile_venmo.sql` (Profile + Venmo).
  - `bills.payer_id`, `bill_participants.settled_at` / `settled_cents`: `20261124081411_settle_payer.sql`, `20261124081412_settle_marks.sql` (M3, [ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md)).
  - `bill_participants.added`: `20261124091041_people.sql` (true when the host added you; [ADR 0016](../decisions/0016-people-come-from-shared-bills.md)).
  - `bill_seen`: `20261124144925_bill_seen.sql` (private "when you last opened this bill"; no client grants at all, see [in-app notices](in-app-notices.md)).

Relationships:
- profile 1—* bills (as host).
- bills *—* profiles through `bill_participants`.
- bill 1—* line_items, bill 1—* bill_events.
- line_item *—* participants through `claims`.

### Design notes
- **All money is `integer` cents** with range checks (`0..99999999` on a bill, `0..9999999` per unit) ([ADR 0005](../decisions/0005-integer-cents.md)).
- **Unit rows.** "Beer ×2 $14.00" is stored as **two** `line_items` rows of 700¢. Each row has three group fields:
  - `group_position`: which form row it came from (0, 1, 2…);
  - `unit_index`: 0..N−1;
  - `group_size`: N.

  Why: every row then behaves the same (one claim toggle, an even split), so the split math and the screen never special-case quantities. The edit form regroups the units into "Beer, qty 2" (`draftFromSaved`, `lib/billPayload.ts:206`). A line's price is split across its units by largest remainder: "Beer ×3, $10.00" → 334, 333, 333 ([money and rounding](money-and-rounding.md)). The database checks that groups are consistent: contiguous unit indexes, and the same name, note and size on every unit.
- **`unique (bill_id, group_position, unit_index) deferrable initially deferred`.** "Deferrable" means the check runs at the end of the transaction instead of after each statement. A host edit can then swap two items' positions without a temporary clash. This unique index also makes `where bill_id = …` fast.
- **Claims carry a `bill_id` on purpose.** It's technically derivable from the item, but having it on the claim lets RLS check "are you in this bill?" directly, and lets realtime triggers know which bill changed. Two composite foreign keys keep it honest:
  - `(line_item_id, bill_id) → line_items (id, bill_id)`, so the claim's bill must be its item's bill;
  - `(bill_id, user_id) → bill_participants`, so only participants can hold claims.

  Both are `on delete cascade`: deleting an item, or a participant, removes their claims.
- **Parts, not units.** The plan had `claims.units`. Unit rows made that unnecessary. Instead, `parts` (default 1) handles custom splits of one item: A 2 parts and B 1 part means A pays two thirds.
- **`split_set_by` / `split_set_at`** on the item record who last set a custom split, for "Custom split · set by Pat". `on delete set null` keeps the item if that account is deleted.
- **`text` + `check` instead of enums** for `currency`, `extras_split` and `bill_events.kind`. A check constraint is easier to change in a later migration.
- **`subtotal_cents` is nullable** because many receipts don't print one. Blank means "not on the receipt", which is different from $0.00.
- **Two discount columns.** One `discount_cents` couldn't say whether a discount applied before or after the subtotal. When the bill was reloaded for editing, the form then showed a false "items don't add up" (spec Amendment A3).
- **`bill_events` is append-only** and stores ids plus an item-name snapshot ([audit log](audit-log.md)).
- **Indexes on foreign keys:** `bills(host_id)`, `bill_participants(user_id)`, `claims(bill_id)`, `claims(user_id)`, `line_items(split_set_by)` (partial), `bill_events(bill_id, created_at desc)` and `bill_events(actor_id)` (partial).
- **Nothing derived is stored.** No per-person share column. Shares come from `lib/split.ts` every time.
- **The payer is always a participant**, enforced by a composite foreign key `bills (id, payer_id) → bill_participants (bill_id, user_id)` checked at commit (deferred), so `create_bill` can insert the bill before its first participant row.
- **A mark is both columns or neither:** `settled_at` and `settled_cents` are set together, and `settled_cents` is 1–99,999,999.
- **Private per-person state gets its own table** (`bill_seen`), not a column on the shared `bill_participants` row, which every co-participant can read and whose changes broadcast.
- **Who can read and write what** is in [row level security](row-level-security.md). The write paths are database functions ([database functions](database-functions.md)).

### Dropped from the plan-era sketch
The 2026-11-19 plan sketched `bills.title`, `status`, `source_type`, `source_url`, `image_path`, `bill_participants.paid_at`, payment handles on `profiles`, `claims.units` and a `parse_runs` table. Most of these don't exist:
- `parse_runs` and link import were for Claude parsing and receipt links ([ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md));
- payment handles and `paid_at` became `profiles.venmo_username` and `bill_participants.settled_at` / `settled_cents` (added 2026-11-24);
- titles were cut from this slice;
- `units` was replaced by unit rows plus `parts`.

## Pitfalls
- Storing derived values (each person's share) that then go stale when a claim changes.
- Forgetting FK indexes, which makes joins and cascading deletes slow once data grows.
- Editing the schema in the dashboard instead of in a migration, so local and production diverge.
- Editing a migration that's already applied. It won't re-run; write a new one.
- Using `float`/`real` for money. Use `integer` or `bigint` cents ([ADR 0005](../decisions/0005-integer-cents.md)).
- A non-deferrable unique constraint on positions: swapping two rows fails halfway through the update.
- A plain FK from `claims.line_item_id` alone. Then nothing stops a claim's `bill_id` from disagreeing with its item's bill.

## Check yourself
1. Why is `bill_participants` a separate table instead of an array of user ids on `bills`?
2. What happens to `claims` when a line item is deleted? And when a participant's account is deleted?
3. Why don't we store each person's share in a column?
4. "Beer ×2" is two rows. What are each row's `group_position`, `unit_index` and `group_size` if Beer is the third item on the receipt?
5. Why does `claims` have a composite foreign key to `line_items (id, bill_id)` rather than just `line_item_id → line_items(id)`?
6. What does "deferrable initially deferred" buy us in `update_bill`?

## Learn more
- https://www.postgresql.org/docs/current/ddl-constraints.html
- Deferrable constraints (`SET CONSTRAINTS`): https://www.postgresql.org/docs/current/sql-set-constraints.html
- https://supabase.com/docs/guides/deployment/database-migrations


# todo 
we want to allow split of line items as well (3 people can share 1 item) and uneven distribution. we also want to use keys so to reduce lookup time and keep costs low - so one person can see all the bills they have (if they paid/someone else) and summary of al items they got or something like that? like venmo groups with multiple bills - this can be a future feature though - we just want to design with it in mind
