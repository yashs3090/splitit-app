# Spec: claimable discounts (2026-11-24)

User request (2026-11-24): "for discount we can have it as an item or even split (small toggle button) if by item people can choose percentage and stuff like an item."

Example that prompted it: a receipt with "Police comp -16.03" on a $32.05 bill. The comp belongs to one person's meal, but today every bill-level discount is spread across everyone.

The user delegated the product decisions for this slice ("pick the best simple option, keep building, log every important decision"). Every decision below is logged in `docs/decisions-to-review.md` under "Claimable discounts" (rows CD-1 … CD-18). None of them changes a provider or an account, and none departs from `CLAUDE.md`. CD-6 (negative shares) builds on the settle flow's existing negative-share handling (Q6). It is marked "needs your look" because it changes what someone can owe.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| None new | Everything runs on the existing local Supabase stack and Expo app | $0 |

## Goal

The host marks any bill-level discount as **Claim like an item**. Participants then claim it the way they claim items, and can share it by parts. The person who got the comp (or used the coupon) gets the money off, not the whole table. Discounts the host doesn't flip keep today's behavior.

## In scope

- One per-discount switch in the bill form (create and edit): **Split** (default, today's behavior) or **Claim like an item**.
- Claimable discounts are stored as bill rows. They show in the claim list, take claims, and can be shared by parts with the same sheet and the same 1–20 parts as items.
- Split math, settle amounts, the totals check, "every row claimed" and Activity all handle them.
- Host edits: change the amount, label or position; flip either way; delete. Claims are kept or removed as with items.
- ADR 0017 (amends 0014), the concept note, and the decision log.

## Out of scope

- A percentage input. Sharing works by parts, exactly like items (CD-5).
- Storing split discounts one by one. They stay two sums (`subtotal_discount_cents`, `total_discount_cents`), so their labels and their order are still not kept on reload (existing behavior).
- Item-level discounts (a discount directly under an item). The parser already folds them into that item's price, and nothing about that changes.
- Parser changes. Parsed discounts arrive as Split.
- Host approval of who claims a discount (CD-15), and limits on who may claim it.
- A length check on item names (an existing gap: neither item names nor discount labels have one). This slice only adds `maxLength` to the discount label field (Task 6).
- Physical-phone checks. Web and the iOS simulator on the Mac reach the local Supabase at `127.0.0.1`, so no device reachability is needed.

## Shared contracts (defined once; tasks point here)

### C1. Row contract: a claimable discount is a `line_items` row

**Columns** (migration A, Task 1):
- `kind text not null default 'item'`, constraint `line_items_kind_known`: `kind in ('item', 'discount')`.
- `applies_to text null`.
- Drop `line_items_total_cents_range` and add `line_items_kind_shape`:
  - `kind = 'item'`: `applies_to is null` and `total_cents between 0 and 9999999`. This is the old rule.
  - `kind = 'discount'`: `applies_to in ('subtotal', 'total')`, `total_cents between -9999999 and -1` (**stored negative**, CD-4), `group_size = 1`, `unit_index = 0` and `note is null`.
- Existing rows become `kind = 'item'`, `applies_to = null` through the column defaults, and satisfy the new check.
- Grants are unchanged. `line_items` keeps its table-level SELECT for `authenticated` (so the new columns are readable) and no client INSERT, UPDATE or DELETE. The migration header says that no `line_items` column is hidden from clients.

**Row JSON** (`p_rows` element for `create_bill` / `update_bill`; `private.validate_bill_rows` checks it):
- Allowed keys: the existing ones (`id, name, note, group_position, unit_index, group_size, total_cents`) plus `kind` and `applies_to`. Any other key is still `22023 invalid_bill`.
- `kind`: absent means `'item'`. If present it must be the JSON string `"item"` or `"discount"`.
- Item rows: `applies_to` is absent or JSON null. Everything else is unchanged.
- Discount rows: `applies_to` is the JSON string `"subtotal"` or `"total"`. `total_cents` is a JSON integer in −9999999…−1. `group_size` is 1 and `unit_index` is 0. `note` is absent, null or blank. `name` follows the same rules as item names (trimmed, 1–100 characters).
- A bill must have **at least one item row**. Rows that are all discounts are `22023 invalid_bill`.
- Group positions are shared by items and discounts (0…G−1 contiguous, as today). Each discount row is a group of size 1. The app puts discount rows after every item group (C5). The DB doesn't require that order.
- **The app sends item rows without `kind` or `applies_to`** (payloads for items are byte-for-byte unchanged). Discount rows carry `kind: 'discount'` and `applies_to`.

**Reads:** `fetchBill`'s row select names its columns and adds `kind, applies_to`:
`'id, name, note, group_position, unit_index, group_size, total_cents, split_set_by, split_set_at, kind, applies_to'`. Never `*`.

### C2. Totals rule with claimable discounts (same rule in `lib/` and SQL)

Let:
- `I` = Σ `total_cents` of **item** rows.
- `R_sub` = Σ (−`total_cents`) of discount rows with `applies_to = 'subtotal'`, and `R_tot` the same for `'total'`.
- `Dsub = p_subtotal_discount_cents + R_sub` and `Dtot = p_total_discount_cents + R_tot`.
- `X = tax + fees + tip`. `S` = subtotal (nullable). `T` = total.

With a subtotal: `|I − Dsub − S| ≤ 1` **and** `|S + X − Dtot − T| ≤ 1`.
Without one: `|I − Dsub − Dtot + X − T| ≤ 1`.

This is exactly today's rule with each discount counted in its own bucket, whether it is split or claimable.
- **lib:** `checkTotals` / `totalsGaps` don't change. The draft's discount list holds both kinds. `toBillArgs` moves claimable discounts from the `p_*_discount_cents` sums into rows, so the DB's `Dsub` / `Dtot` equal the form's.
- **SQL:** `validate_bill_rows` computes `I`, `R_sub` and `R_tot` from the rows.

**Boundary cases.** Both sides test every row: lib through `evaluateDraft` + `toBillArgs`, DB through `create_bill`.

Base bill: items Steak 16.03 and Salad 14.00 (`I = 3003`), claimable comp, subtotal 14.00, tax 2.40, tip 0, fees 0, total 16.40.

| Case | Change from base | Gaps | Expected |
|---|---|---|---|
| B1 | none (comp 1603, `subtotal`) | 0 / 0 | accept |
| B2 | comp 1602 | 1 / 0 | accept |
| B3 | comp 1601 | 2 / 0 | reject |
| B4 | comp 1602, total 16.39 | 1 / 1 | accept (1¢ + 1¢) |
| B5 | no subtotal, comp 1602, total 16.40 | combined 1 | accept |
| B5b | no subtotal, comp 1601, total 16.40 | combined 2 | reject |
| B7 | comp 1603 with `applies_to = 'total'` | 1603 / … | reject |
| B6 | each of B1–B7 with the comp as a **split** discount (in `p_subtotal_discount_cents`, or `p_total_discount_cents` for B7) | same | same answer as the claimable version |

### C3. "Complete" means every row has a claim (same rule in `lib/` and SQL)

A bill is complete when **every** `line_items` row, item or discount, has at least one claim.
- **SQL:** `private.bill_is_complete` is unchanged and already counts every row. `mark_paid` raises `22023 not_complete` while the bill isn't complete.
- **lib:** `sharesComplete`, `displayShares` (`complete`, `unclaimedRows`) and `settlePlan` (`blocked`) count discount rows as rows.

| Case | State | lib | DB |
|---|---|---|---|
| K-D1 | every item claimed, the claimable discount unclaimed | incomplete, `unclaimedRows = 1`, settle `blocked` | `mark_paid` → `22023 not_complete` |
| K-D2 | everything claimed | complete | `mark_paid` succeeds (amount ≥ 1¢) |
| K-D3 | discount claimed, one item unclaimed | incomplete, `unclaimedRows = 1` | `not_complete` |

### C4. Split math (`lib/split.ts` only; the DB computes no shares, as before)

- `SplitItem = { id; totalCents; kind?: 'item' | 'discount' }`. An absent `kind` means `'item'`. Item rows need an integer `totalCents ≥ 0` and discount rows an integer `≤ −1`. Anything else throws `RangeError`, including a discount row with `totalCents ≥ 0` and an item row below 0, as today.
- **Row allocation:** every row, discount rows included, is split among its counted claimers by parts with `allocate` (largest remainder, ties to the lower index in code-unit userId order). A negative row uses `allocate`'s `−allocate(−amount)` path. `items[id]` (`ItemSplit`) is the same shape for both kinds; for discount rows `byUser` holds negative cents.
- `PersonShare` gains `discountCents` (≤ 0), the sum of the person's pieces of discount rows. `itemsCents` stays item rows only. `totalCents = itemsCents + discountCents + extrasCents`.
- `SplitResult` gains `unclaimedDiscountCents` (≤ 0), the sum of discount rows with no counted claim. `unclaimedCents = unclaimedItemsCents + unclaimedDiscountCents + unclaimedExtrasCents`.
- `extrasCents = totalCents − Σ all rows` (items and discount rows). The formula's text doesn't change. Because discount rows are in Σ rows, a claimable discount is no longer part of the extras.
- **Proportional:** the weights are `[itemsCents per person (item rows only)…, unclaimedItemsCents]`. Discount rows are never weights (CD-7). If every weight is 0, the extras go to Unclaimed, as today (Q10).
- **Equal:** the extras are shared among participants with at least one counted claim **on an item row** (a $0 item still counts). A claim on a discount row alone doesn't count (CD-8).
- **No cap.** A person's total may be negative (CD-6). `settlePlan` already gives that person the `payer_owes_them` role ("Hana owes you $X. Settle that outside the app.").
- **Display:** `DisplayShare` gains `discountCents: number | null` (null when totals are hidden), and `DisplayShares` gains `unclaimedDiscountCents`. With totals hidden (equal mode, incomplete), the summary shows items only, as today.
- **Invariant:** Σ people `totalCents` + `unclaimedCents` = bill `totalCents`, always.

**Worked examples.** Users A and B in code-unit order (A < B), C after B.

| # | Bill | Mode | Expected |
|---|---|---|---|
| E1 | A: Steak 1603. B: Salad 1400. Comp −1603 (subtotal) claimed by A. Tax 240, total 1640. | proportional | extras 240 over weights [1603, 1400, 0] → A 128, B 112. **A: items 1603, discount −1603, extras 128, total 128. B: 1400 + 112 = 1512.** Sum 1640. |
| E1-split | Same bill, comp as a split discount | proportional | extras −1363 → A −728, B −635. A total 875, B 765. (Today's behavior, for contrast.) |
| E1-even | E1 | equal | extras 240 / [A, B] → 120 each. A 120, B 1520. |
| E2 | A: Fries 500. B: Burger 1500. Coupon −1000 claimed by A. No tax or tip, total 1000. | proportional | A −500, B 1500. Settle with B as payer: A is `payer_owes_them` 500, `collectCents` 0. With A as payer: B owes 1500. |
| E3 | Coupon −1000 claimed by A (2 parts) and B (1 part) | either | byUser A −667, B −333 |
| E4 | E1 with the comp unclaimed | proportional | A 1731, B 1512, `unclaimedDiscountCents` −1603, `unclaimedCents` −1603, `complete` false |
| E5 | E1, but C claims only the comp | equal | extras among A and B only: A 1603 + 120 = 1723, B 1520, C −1603 |

### C5. Reload contract (the edit form reloads claimable discounts exactly)

- `DraftDiscount` gains `claimable: boolean`. It is false from `emptyDraft`, `addDiscount` and `fromParsed`.
- `toBillArgs`:
  - Split discounts are summed into `p_subtotal_discount_cents` / `p_total_discount_cents`, as today.
  - Each claimable discount with an amount > 0 becomes one row: `{ name: label or 'Discount', note: null, group_position: G + k, unit_index: 0, group_size: 1, total_cents: −amount, kind: 'discount', applies_to }`. G is the number of item groups and k is its index among the claimable discounts in draft order. It carries its saved id when editing (`saved.units[draftDiscountId]`).
  - A claimable discount of $0.00 contributes nothing and is not stored (CD-12).
- `draftFromSaved`:
  - Item rows become items, as today.
  - The two stored sums become `'Discount'` rows (claimable false), as today.
  - Then each `kind = 'discount'` row, in `group_position` order, becomes `{ label: name, amount: formatCentsInput(−total_cents), appliesTo: applies_to, claimable: true }`, and `saved.units[thatDraftId] = [row id]`. Rows with claims go into `claimedIds`.
- **Round trip:** for any saved bill, `toBillArgs(draftFromSaved(bill).draft, …)` without edits gives the same rows (ids, names, totals, kinds, `applies_to`, positions) and the same money arguments. The form status is `adds_up` when the saved bill was valid.

## Edits after people claimed

The host's edit screen uses these rules (Task 4 and Task 6).

| Host action on a claimable discount | Result | Asked first? | Events (Task 2) |
|---|---|---|---|
| Change amount, label or before/after | Same row id; claims kept (like a price change) | No | `item_changed` with only the fields that differ (`name`, `price_cents`), plus `discount: true`. A change to `applies_to` alone logs nothing (it moves nobody's money) |
| Switch Claim → Split | Row deleted (its claims cascade); amount moves into the bill's discount sum | At save, if claimed: "Sharing Police comp with everyone removes 1 person's claim. Continue?" | `item_removed` (`discount: true`, `claimer_ids`) + `amounts_changed` |
| Set the amount to $0 / clear the row | Row deleted | At save, if claimed: the existing "Saving deletes Police comp, which 1 person claimed." | `item_removed` (+ `amounts_changed` if sums moved) |
| Delete (✕) | Row deleted | At delete, if claimed: the existing `deleteConfirmCopy` ("1 person claimed this. Delete it anyway?") | `item_removed` |
| Switch Split → Claim | New unclaimed row; the bill sum drops | No | `item_added` (`qty: 1`, negative `price_cents`, `discount: true`) + `amounts_changed` |
| Flip Claim → Split → Claim before saving | Saved id reused; claims kept | No | none for the row |

"I paid" marks aren't touched by any edit, as today. A bill that becomes incomplete blocks new marks (C3), and existing marks show "amount changed" through `markDiffers`, as today.

**Activity copy** (Task 5): an event whose `details.discount === true` reads like the item sentence with "the discount " before the name. Examples:
- "Hana added the discount Police comp (-$16.03)"
- "Hana removed the discount Police comp"
- "Hana changed the discount Police comp from -$16.03 to -$10.00"

Claim events stay as they are: "Sam claimed Police comp". Events without the key read exactly as today.

## Tasks

Agents re-read every file right before editing it, because other sessions are working on bills and people. Migration timestamps are handed out here: **`20261124094657`** (Task 1) and **`20261124094658`** (Task 2). Before any task that needs the local DB, the main session runs `npm run db:status`. Apply new migrations with `npx supabase migration up`, never `db:reset` (the local DB holds the user's data).

**Parallel waves**
- Wave 1 (parallel): Task 1, Task 3, Task 4.
- Wave 2 (parallel): Task 2 (after 1), Task 5 (after 3 and 4).
- Wave 3 (parallel): Task 6 (after 4 and 5), Task 7 (after 3 and 5), Task 8 (after 1, 2 and 4).
- Wave 4: Task 9 (after everything).

Each screen task (6, 7) gets a `ui-ux-designer` pass before review. The review runs after wave 3.

### Task 1 (supabase-engineer): columns, validation, create_bill
- Files: `supabase/migrations/20261124094657_claimable_discounts.sql` (new) and `supabase/tests/database/claimable_discounts.test.sql` (new).
- C1 columns and constraints.
- `create or replace private.validate_bill_rows` with the same signature (C1 keys, at least one item row, C2 totals).
- `create or replace public.create_bill` with the same signature, from its latest body in `20261121080352_bill_events.sql`. It inserts `kind` / `applies_to`, and `bill_created.details.items` counts **item** groups only.
- Header: the lock-order note (no new lock paths; `set_claim`, `set_item_split` and `create_bill` are unchanged in what they lock), and "no `line_items` column is hidden from clients".
- Re-assert the revoke/grant lines for both functions.

### Task 2 (supabase-engineer): update_bill
- Files: `supabase/migrations/20261124094658_claimable_discounts_update_bill.sql` (new) and the same pgTAP file (a new section).
- `create or replace public.update_bill` with the same signature, from its latest body in `20261122085802_m2_review_fixes.sql`:
  - Write `kind` / `applies_to` on insert and update (`applies_to` may change on a kept discount row).
  - Reject a kept id whose stored `kind` differs from the row's `kind` (`22023 invalid_bill`, nothing changes).
  - Discount rows' `item_added`, `item_removed` and `item_changed` details carry `discount: true`. Item events are unchanged.
  - The lock sequence is unchanged; the header says so.

### Task 3 (implementer): split math
- Files: `lib/split.ts`, `lib/split.test.ts`.
- C4. Existing `toEqual` assertions on `PersonShare` / `DisplayShare` objects gain `discountCents: 0` (or `null` when hidden). These are `lib/split.test.ts` lines 159, 160, 169, 170, 181, 182, 339, 347, 348, 358, 371, 449, 450, 458 and 459 (found by searching for `extrasCents: `), with no other value changes. Add the seeded property test.

### Task 4 (implementer): form model, payload, data layer, edit checks
- Files: `lib/billDraft.ts`, `lib/billPayload.ts`, `lib/bills.ts`, `lib/editBill.ts`, and their `*.test.ts`.
- C5 and C1:
  - `DraftDiscount.claimable` and a `setDiscountClaimable` path through `updateDiscount`'s patch.
  - `toBillArgs` / `draftFromSaved`.
  - `SavedRow` / `BillRowArg` gain `kind` / `applies_to`.
  - `rowArg` passes `kind` / `applies_to` only for discount rows.
  - `ROW_COLUMNS` and `parseRow` validate kind/sign/`applies_to` consistency.
- `BillArgsResult` gains `splitClaimedIds` (claimed discount rows switched to Split).
- `freshSaveCheck` counts discount draft ids as "in the draft" and asks about `splitClaimedIds`.
- `saveConfirmCopy` gets the Split sentence.
- Update the existing test fixtures that need the new fields: `LINE_ITEMS` in `lib/bills.test.ts`, and `DraftDiscount` expectations in `lib/billDraft.test.ts` and `lib/billPayload.test.ts` (8 and 9 `appliesTo: '…'` matches today; add `claimable: false`). The parser's `Discount` type and its tests don't change.

### Task 5 (implementer): view helpers and Activity text
- Files: `lib/billView.ts`, `lib/billView.test.ts`, `lib/activityText.ts`, `lib/activityText.test.ts`.
- `splitInputFor` passes `kind`.
- `splitPreview(totalCents, parts, kind?)` accepts discount rows.
- `breakdownText(itemsCents, extrasCents, discountCents = 0)`.
- `showUnclaimedLine` / `unclaimedTotalCents` include `unclaimedDiscountCents`. `billView.test.ts` lines 172, 176 and 177 gain `unclaimedDiscountCents: 0`.
- New `discountRowA11yName(name)` and `DISCOUNTS_HEADING`.
- Activity sentences for `discount: true`.

### Task 6 (product-engineer): bill form switch and edit screen
- Files: `components/BillForm.tsx`, `app/(app)/bills/[id]/edit.tsx`, and tests under `__tests__/`.
- The switch on each discount row.
- `maxLength={100}` on the discount label.
- Delete-time confirm for a claimed discount.
- Save-time question for `splitClaimedIds` (through `freshSaveCheck`).

### Task 7 (product-engineer): claim screen, sheet and summary
- Files: `app/(app)/bills/[id]/index.tsx`, `components/ClaimItemRow.tsx` (only if a label prop is needed), `components/ItemSheet.tsx`, `components/SharesSummary.tsx`, and tests under `__tests__/`.
- Discount rows come after the items, under a "Discounts" caption.
- Negative prices.
- The sheet's preview with `kind`.
- The summary breakdown with the claimed discount and the Unclaimed line with discounts.
- Existing fixtures in `__tests__/billScreen.test.tsx` (lines 457, 458, 461, 513 and 514) gain the new fields.

### Task 8 (implementer): live reconciliation
- Script in the scratchpad, using the `live-db-smoke` skill (keys loaded with `set -a; eval "$(npx supabase status -o env)"; set +a; node …` in one command). Throwaway local users only.
- Runs the app's data layer against the migrated DB. Covers C2 B1–B7, C3 K-D1–K-D3, C5 round trip, E1 and E3 on live claims, the edit table and the Activity sentences.
- Any app/DB disagreement stops the build and goes to the main session.

### Task 9 (docs-writer, optional but recommended)
- Files:
  - `docs/learning/decisions/0017-claimable-discounts.md` (new).
  - `docs/learning/decisions/README.md` (add the 0017 row; mark 0014 "Accepted (amended by 0017)").
  - `docs/learning/concepts/money-and-rounding.md` (worked examples E1, E2, E4).
  - `docs/decisions-to-review.md` (update CD rows only if a task changed a decision).
- Runs after every other task. Re-read each file before editing it.
- Does **not** edit `CLAUDE.md`. The proposed § Conventions wording is under "Open questions" for the retro and the user.

## Acceptance criteria

### Database: columns, grants and RLS (Task 1)
1. After `npx supabase migration up`, `line_items` has `kind text not null default 'item'` and `applies_to text null`. Every pre-existing row has `kind = 'item'` and `applies_to is null`. pgTAP checks the columns with `has_column` / `col_default_is`, and the backfill on the test's own fixture rows.
2. As `postgres`, inserting a row that breaks `line_items_kind_shape` fails with `23514`. Each case is its own assertion on a fixture bill:
   - an item with `total_cents = -1`
   - an item with `applies_to = 'subtotal'`
   - a discount with `total_cents = 0`
   - a discount with `total_cents = 100`
   - a discount with `total_cents = -10000000`
   - a discount with `applies_to` null
   - a discount with `group_size = 2`
   - a discount with a note
   - `kind = 'coupon'`

   An item with `total_cents = 9999999` and a discount with `total_cents = -9999999` (`applies_to 'total'`) insert fine.
3. As `authenticated`, a participant can `select id, kind, applies_to from line_items` for their bill, and a non-participant gets 0 rows. A direct `insert into line_items`, `update line_items set kind = 'discount'` and `delete from line_items` as `authenticated` each fail with `42501`. `anon` selecting `line_items` fails with `42501`.

### Database: validation and create_bill (Task 1; C1, C2)
4. `create_bill` accepts the B1 rows (two items, plus `{"name":"Police comp","group_position":2,"unit_index":0,"group_size":1,"total_cents":-1603,"kind":"discount","applies_to":"subtotal"}`). It stores the discount row with `kind = 'discount'`, `applies_to = 'subtotal'`, `total_cents = -1603`, and stores the bill's `subtotal_discount_cents = 0`.
5. `create_bill` raises `22023 invalid_bill` for each of these, and no bill row is created for any of them:
   - `kind: "coupon"`
   - `kind: 1`
   - a discount without `applies_to`
   - `applies_to: "tip"`
   - an item with `applies_to: "subtotal"`
   - a discount with `total_cents` 0, 5 or −10000000
   - a discount with `total_cents: "-1603"` (a string)
   - a discount with `group_size: 2`
   - a discount with the note "x"
   - rows that are only discounts
   - an unknown key (`host_id`, as today)
6. C2 boundaries through `create_bill`: B1, B2, B4 and B5 are accepted, and B3, B5b and B7 raise `22023 invalid_bill`. B6: the same seven bills with the comp passed as `p_subtotal_discount_cents` (B7: `p_total_discount_cents`) and no discount row give the same accept/reject answer, one assertion each.
7. `bill_created.details.items` is 2 for the B1 bill (two item groups, one discount row), and `total_cents` is 1640.
8. Existing pgTAP suites pass unchanged (`npm run db:test`), including `bill_functions.test.sql` (unknown-key rejection at :349) and the negative-price rejection for item rows. Assertions in the new test filter to the rows it created (fixture ids), never whole tables.

### Database: claims, completeness and membership on discount rows (Task 1; C3)
9. A participant's `set_claim(<discount row id>, true)` inserts a claim with `parts = 1` and logs exactly one `claimed` event whose `item_name` is "Police comp". A non-participant's call raises `P0002 not_found`.
10. `set_item_split(<discount row id>, {A: 2, B: 1})`, by a claimer, sets the parts and logs exactly one `split_changed` event. A call that leaves out a current claimer raises `22023 claimers_changed`.
11. C3 through `mark_paid`, with A not the payer and amount 128:
    - K-D1 (items claimed, discount unclaimed) raises `22023 not_complete`.
    - K-D3 raises `22023 not_complete`.
    - K-D2 succeeds and logs one `marked_paid` event.
12. A participant whose only claim is on a discount row can't be removed. `remove_participant` raises `22023 cannot_remove`, and their `leave_bill` raises `22023 cannot_leave`. This is the same "has a claim" rule as items.

### Database: update_bill (Task 2)
13. Changing a claimed discount's amount from −1603 to −1000 (same id) keeps its claims and logs exactly one `item_changed` with details `{"price_cents": [-1603, -1000], "discount": true}`. Changing only its `applies_to` (with the money arguments adjusted so C2 still holds) logs no `item_changed`.
14. Dropping a claimed discount row from `p_rows` (Claim → Split, its amount moved into `p_subtotal_discount_cents`) deletes the row and its claims, and logs exactly one `item_removed` (`qty 1`, `price_cents -1603`, `discount true`, `claimer_ids` = [A]) and one `amounts_changed` with `subtotal_discount_cents: [0, 1603]`.
15. Adding a discount row in an edit logs exactly one `item_added` with `{"qty": 1, "price_cents": -1603, "discount": true}`. Adding an item row logs `item_added` **without** a `discount` key.
16. `update_bill` raises `22023 invalid_bill`, and changes nothing (rows, claims, bill and event count all equal before and after), in each case:
    - a kept item id sent with `kind: "discount"`
    - a kept discount id sent without `kind`
    - a discount row that breaks C1
17. The existing `update_bill` tests (R4 merge rejection, `removed_claimer_ids`, reorder logs nothing) pass unchanged. A non-host's `update_bill` raises `42501`.

### Split math (Task 3; C4)
18. E1, E1-split, E1-even, E2, E3, E4 and E5 give exactly the values in the C4 table: `itemsCents`, `discountCents`, `extrasCents` and `totalCents` per person, `items[comp].byUser`, `unclaimedDiscountCents` and `unclaimedCents`.
19. `computeShares` throws `RangeError` for a discount row with `totalCents` 0 or 5, or 1.5, and for an item row with −1 (the existing test at `lib/split.test.ts:280` still passes).
20. Proportional weights ignore discount rows. A bill where A claims a −50 discount and Fries 100, and B claims Fries 100, with tax 200 (total 350), gives A and B 100 extras each. A's total is 150 and B's is 200.
21. Equal mode doesn't count a discount-only claimer: E5's C gets `extrasCents 0`. If **only** discount rows are claimed, all extras sit in `unclaimedExtrasCents`.
22. `sharesComplete` and `displayShares.unclaimedRows` count unclaimed discount rows (K-D1: `complete false`, `unclaimedRows 1`). With totals hidden, each person's `discountCents` is `null`.
23. A seeded property test over 500 random bills (both modes; 0–3 discount rows of −1…−5000, each claimed by 0–3 random participants with parts 1–20; 0–6 items) checks two things. Σ people `totalCents` + `unclaimedCents` = `totalCents`. And for every claimed row, Σ `byUser` = the row's cents. The seed is printed on failure.
24. `settlePlan` on E2 with payer B: A has role `payer_owes_them` with `owedCents -500`, and `collectCents 0`. On K-D1 it is `{ status: 'blocked', unclaimedRows: 1 }`.
25. Every existing `lib/split.test.ts` and `lib/settle.test.ts` assertion passes. The only edits allowed are adding `discountCents` to the object literals listed in Task 3. `npx jest lib/split.test.ts lib/settle.test.ts` passes.

### Form model, payload and data layer (Task 4; C1, C5)
26. `emptyDraft`, `addDiscount` and `fromParsed` give discounts with `claimable: false`. `updateDiscount` with `{ claimable: true }` flips only that row.
27. `toBillArgs` on B1 as a draft (comp claimable) returns `p_subtotal_discount_cents 0` and a third row equal to `{ name: 'Police comp', note: null, group_position: 2, unit_index: 0, group_size: 1, total_cents: -1603, kind: 'discount', applies_to: 'subtotal' }`. Item rows have no `kind` or `applies_to` keys.
28. C2 from the form: `evaluateDraft` status and `toBillArgs` `ok` match the C2 table for B1–B7 and B6, one test per case, with the same numbers as criterion 6.
29. A claimable discount of `0.00` produces no row and no change to the sums. A blank label is stored as `'Discount'`. Toggling a discount's `claimable` doesn't change `evaluateDraft(...).gaps` or `status`.
30. C5 round trip. For a saved bill with two items, one split discount (subtotal, 200) and two claimable discounts (−1603 subtotal; −500 total), `draftFromSaved` gives discounts in this order: `{label 'Discount', amount '2.00', claimable false}`, then the two claimable rows with their names, amounts, `appliesTo` and `claimable: true`. `toBillArgs(draft, evaluateDraft(draft), saved)` returns the same row ids, names, `total_cents`, kinds, `applies_to` and positions, and the same money arguments.
31. Editing: switching a claimed claimable discount to Split puts its row id in `splitClaimedIds` (not in `removedClaimedIds`). Setting a claimed one to `0.00` or clearing the row puts it in `removedClaimedIds`. Flipping Claim → Split → Claim keeps the saved id and lists nothing.
32. `saveConfirmCopy` gives "Sharing Police comp with everyone removes 1 person's claim. Continue?" for one claimer, and "… removes 2 people's claims. Continue?" for two. Existing copy is unchanged.
33. `freshSaveCheck` doesn't report a claimable discount's draft id as deleted, and it asks about a discount row that someone claimed after the form opened and that the save would remove or switch to Split.
34. `fetchBill`'s `line_items` query is `.select('id, name, note, group_position, unit_index, group_size, total_cents, split_set_by, split_set_at, kind, applies_to')` (a test checks the exact string). `parseRow` returns `kind` / `applies_to`. These rows make `fetchBill` return `network` (malformed):
    - `kind: 'coupon'`
    - a discount with `total_cents: 100`
    - an item with `total_cents: -1`
    - a discount with `applies_to: null`
    - an item with `applies_to: 'total'`
35. `rowArg` sends `kind` and `applies_to` only for discount rows. `createBill` / `updateBill` send item rows exactly as before (existing `lib/bills.test.ts` rpc-argument assertions pass without edits).
36. No client read or write uses a bare `.select()` or `select('*')`. `grep -rnE "select\('\*'\)|\.select\(\)" lib app components` prints nothing. (Run with the Grep tool on 2026-11-24 over `lib`, `app` and `components`: no matches today.)

### View helpers and Activity (Task 5)
37. `breakdownText(1603, 128, -1603)` is "Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28". `breakdownText(500, 0, -1000)` is "Items $5.00 − claimed discounts $10.00". The two-argument calls give exactly today's strings.
38. `splitPreview(-1000, {A: 2, B: 1}, 'discount')` is `{A: -667, B: -333}`. `splitPreview(1000, {A: 2, B: 1})` is unchanged (`{A: 667, B: 333}`).
39. `showUnclaimedLine` is true for `{ complete: true, unclaimedItemsCents: 0, unclaimedDiscountCents: -1603, unclaimedExtrasCents: 0 }`, and `unclaimedTotalCents` of it is −1603.
40. Activity sentences, each tested with the viewer as actor ("You …") and as someone else:
    - "Hana added the discount Police comp (-$16.03)"
    - "Hana removed the discount Police comp" (with the existing claimer note when `claimer_ids` is non-empty)
    - "Hana changed the discount Police comp from -$16.03 to -$10.00"

    Events without `discount` read exactly as today: existing `lib/activityText.test.ts` passes without edits. `discount` that isn't `true` or absent makes the event unreadable (null), as malformed details do today.
41. `discountRowA11yName('Police comp')` is "Police comp, discount".

### Bill form and edit screen (Task 6)
42. Each discount row in `BillForm` has one switch, label "Claim like an item", off by default (`accessibilityRole="switch"`, `accessibilityLabel` "Discount 1: claim like an item", `accessibilityState.checked`). When on, the caption "People claim this like an item and can share it." shows under the row. When off there is no caption. The control appears on the create flow (scan and "Enter items") and on edit.
43. Turning the switch on or off doesn't change the totals banner or the footer status (a test reads the footer before and after).
44. The discount label field has `maxLength={100}`.
45. Edit: deleting a claimable discount that has claims shows the existing delete confirm ("1 person claimed this. Delete it anyway?"). Deleting an unclaimed one, or a split one, removes it at once.
46. Edit: switching a claimed discount to Split and saving shows "Sharing Police comp with everyone removes 1 person's claim. Continue?". "Save anyway" calls `updateBill` once with the row left out and the amount in `p_subtotal_discount_cents`. Cancelling calls nothing.
47. Opening the edit form on a bill saved with claimable discounts shows their switches on, labels and amounts as saved, and footer status "Adds up" (C5).

### Claim screen, sheet and summary (Task 7)
48. Discount rows render after every item row, under one "Discounts" caption (`accessibilityRole="header"`). The price shows as "-$16.03". Tapping claims and unclaims through `setClaim`, exactly like an item, and the row shows the same claimer avatars and status ("You · -$16.03", "Split 2 ways · -$8.02–-$8.01 each" style from `rowStatus`).
49. A discount row's details label reads "Police comp, discount, -$16.03, Unclaimed" (from `rowDetailsA11yLabel` with `discountRowA11yName`).
50. The item sheet opens for a discount row. Its parts steppers save through `setItemSplit`, and its preview shows negative cents from `splitPreview(..., 'discount')` (E3: A -$6.67, B -$3.33).
51. The summary's person line uses `breakdownText` with `discountCents`, so E1 shows A "$1.28" with "Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28". The Unclaimed line includes unclaimed discounts (E4: "Unclaimed -$16.03").
52. Equal mode before complete: an unclaimed discount keeps totals hidden ("Total shows once all items are claimed (1 item left)"). Components do no cents arithmetic: every amount on screen comes from `lib/` (reviewer check).
53. A negative share shows as a negative amount in the summary (E2: A "-$5.00"). The settle screen shows the existing negative-share card ("… owes you" / "Settle that outside the app.") with no new copy.

### Reconciliation, suites and docs
54. Task 8's live run passes against the migrated local DB, as two throwaway users:
    - B1–B7 accept/reject identically through `createBill` and in `evaluateDraft`.
    - K-D1–K-D3 agree between `settlePlan` and `markPaid`.
    - The C5 round trip holds after `fetchBill`.
    - E1 and E3 amounts match after real claims and `setItemSplit`.
    - The edit table's events render with the criterion 40 sentences.

    It reports a pass/fail count and no app/DB mismatches.
55. `npm test -- --maxWorkers=4`, `npm run typecheck` and `npm run db:test` pass. Failures only in files outside this task go through the "outside this task, likely in progress elsewhere" rule.
56. ADR 0017 exists and states:
    - the toggle and its default
    - storage as negative `line_items` rows
    - no cap, with negative shares settled outside the app
    - proportional weights are gross items
    - the equal-mode claimer rule
    - an unclaimed discount blocks complete

    The decisions README lists it and marks 0014 "Accepted (amended by 0017)". The concept note has E1, E2 and E4.

### User checks (need a person; QA verifies the parts above and lists these "for the user")
57. **User check, web** (`npm run web`, local Supabase, two Google accounts):
    1. As host, "Enter items": Steak 16.03, Salad 14.00, discount "Police comp" 16.03 before subtotal with **Claim like an item** on, subtotal 14.00, tax 2.40, total 16.40. Save.
    2. Open the link as the second account and claim Salad.
    3. As host, claim Steak and Police comp.
    4. Check that the host's share reads $1.28, the guest's $15.12, and Activity shows the claims.
    5. Edit, switch Police comp to Split, and confirm. Check that the shares become $8.75 / $7.65.
58. **User check, iOS simulator** (`npx expo run:ios`): steps 1–4 of criterion 57. Also confirm that the switch, the "Discounts" caption and the negative prices read well in light and dark mode, and that VoiceOver reads the switch and the discount row's label.

## Risks / open questions

These are decided under the delegation, and none of them blocks building. Full rows are in `docs/decisions-to-review.md`.
- **CD-6, needs your look:** a claimed discount can make someone's share negative (E2). The settle screen then says the payer owes them, to be settled outside the app (existing Q6 card). The alternative, capping at their items and sharing the rest, was rejected because the redistributed rest can land back on the same person and push them below zero again.
- **CD-9:** an unclaimed claimable discount blocks settling, like an unclaimed item. If groups leave comps unclaimed in practice, a later option is "unclaimed discounts fall back to Split at settle time".
- **CD-10:** "N items left" counts unclaimed discounts as items. That is fewer strings, but slightly imprecise.
- **CD-14:** split discounts are still stored as two sums, so a reloaded form lists them as "Discount" rows before the claimable ones. A form that mixes the two kinds won't keep its exact order.
- **Proposed `CLAUDE.md` § Conventions wording** (for the retro and the user; no task edits `CLAUDE.md`): after "...chosen per bill by the host (ADR 0014).", add "A bill-level discount the host marks 'Claim like an item' is a negative bill row that people claim like an item instead (ADR 0017)."
- **Concurrency:** no new lock paths. Claims on discount rows go through the same `set_claim` / trigger path as items, so the PI-R-3 direct-delete gap in `docs/before-production.md` covers them too. Nothing new for `docs/before-production.md`.

## Amendment A1 (2026-11-24): review fixes (main-session decisions)

From the code review of this slice, which was approved with fixes.

- **R1 (amends CD-10): "left to claim" copy names discounts.** The copy depends on what's left:
  - Only items left: today's copy.
  - Only discounts left: "1 discount left to claim" / "N discounts left to claim", "You can settle up once every discount is claimed (1 discount left).", and "Total shows once all discounts are claimed (1 discount left)".
  - Both left: "2 items and 1 discount left to claim", "…once everything is claimed (2 items and 1 discount left).", and "Total shows once everything is claimed (…)".
  - The person's screen-reader label while totals are hidden follows the same wording.
  - `sharesComplete`, `displayShares` and the `blocked` settle plan carry `unclaimedDiscountRows` (how many of `unclaimedRows` are discount rows). `leftToClaim` / `pendingTotalWhen` in `lib/billView.ts` build the wording. Components do no arithmetic.
  - Criteria 51 and 52 now expect "1 discount left to claim" and "Total shows once all discounts are claimed (1 discount left)".
- **R2: long scanned text.** `fromParsed` clips item names and discount labels to 100 characters and notes to 200. It counts code points, as Postgres's `char_length` does, and trims. A scanned label over 100 characters no longer fails the save (22023) once its discount is switched to Claim.
- **R4: one `RowKind`.** It is defined in `lib/split.ts` and re-exported from `lib/billPayload.ts`.

## Note (2026-11-25, from the settle-early slice)
Criterion 11's `mark_paid` → `not_complete` expectation for K-D1/K-D3 is superseded by `docs/specs/2026-11-25-settle-early-and-differences.md` (rule E): on a proportional bill, a person who claimed an item may mark paid early even while a claimable discount is unclaimed; any later change is settled through "pay the difference". C3 itself is unchanged: `private.bill_is_complete` is still false while a discount row is unclaimed. The pgTAP block in `supabase/tests/database/claimable_discounts.test.sql` now asserts C1 plus `settle_state = 'early'` instead (edited by the settle-early session).
