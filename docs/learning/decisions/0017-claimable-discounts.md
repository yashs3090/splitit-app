# 0017: A bill-level discount can be claimed like an item

**Status:** Accepted (2026-11-24, spec `docs/specs/2026-11-24-claimable-discounts.md`; PM decisions CD-1 to CD-18 and the later CD-T entries in `docs/decisions-to-review.md`, made under the user's delegation). Amends [0014](0014-extras-split-proportional-or-equal.md). **One part needs the user's review:** CD-6, "a share may go negative" (section 4 below).

## Context
Hana and Sam have dinner. Hana is a police officer, and the restaurant comps her steak. The receipt says:

```
Steak            16.03
Salad            14.00
Police comp     -16.03
Subtotal         14.00
Tax               2.40
Total            16.40
```

The comp is for Hana's steak. But under [ADR 0014](0014-extras-split-proportional-or-equal.md), every bill-level discount is part of the "extras" (tax + tip + fees − discounts), and extras are spread over everyone. So the $16.03 comp lowered Sam's share too, even though it had nothing to do with his salad.

The user asked (2026-11-24): "for discount we can have it as an item or even split (small toggle button) if by item people can choose percentage and stuff like an item." A percentage field was left out: parts 1–20 already allow any split (CD-5). They let the PM make the detailed choices and log them.

The hard-to-reverse parts are how the discount is stored and what the split math does with it. Both affect every saved bill and every share.

## Options
| Question | Options considered | Chosen |
|---|---|---|
| The control | One setting per bill; a Split/Claim segmented row; **one switch per discount row** | One switch per discount, "Claim like an item", off by default (CD-1, CD-2) |
| Storage | New `bill_discounts` + `discount_claims` tables; **a `line_items` row with `kind = 'discount'`** | A bill row. It reuses claims, `set_claim`, `set_item_split`, realtime, Activity, "complete" and the membership rules, with no new write paths or RLS (CD-3) |
| Sign of the stored amount | Positive, with `kind` giving the sign; **negative `total_cents`** | Negative. "Total minus all rows" stays the extras formula (CD-4) |
| Sharing between people | A percentage field; **parts 1–20, like items** | Parts, in the same sheet as items (CD-5) |
| A discount bigger than the person's items | Cap at their items and share the rest; block the claim; **allow a negative share** | Allowed (CD-6, **needs the user's review**) |
| Proportional tax and tip | Weights net of the discount; **weights = items before discounts** | Items before discounts (CD-7) |
| Even-mode tax and tip | Anyone with a claim on any row; **anyone with a claim on an item** | Item claims only (CD-8) |
| A claimable discount nobody claimed | Fall back to Split; **counts as unclaimed, like an item** | Unclaimed blocks "complete" (CD-9) |

## Decision

### 1. One switch per discount, Split by default
Every discount row in the bill form (create and edit) has a switch, **"Claim like an item"**. It starts **off**, which is the old behavior: the discount is split across the bill as an extra (CD-1). When it's on, a caption says "People claim this like an item and can share it." Flipping it never changes the form's totals banner, because the discount still counts in the same place in the totals check (section 3).

Parsed discounts always arrive with the switch off. The parser doesn't change.

### 2. A claimable discount is a `line_items` row with a negative amount
`line_items` gets two columns:
- `kind`: `'item'` (the default, so old rows didn't need touching) or `'discount'`.
- `applies_to`: `'subtotal'` (before the subtotal line) or `'total'` (after it) on discount rows, `null` on items.

A database check, `line_items_kind_shape`, enforces the shape of each kind:

| | `kind = 'item'` | `kind = 'discount'` |
|---|---|---|
| `total_cents` | 0 … 9,999,999 | **−9,999,999 … −1** (stored negative, CD-4) |
| `applies_to` | null | `'subtotal'` or `'total'` |
| Other | (unchanged) | one unit (`group_size = 1`, `unit_index = 0`), no note |

Why negative? Because the extras formula is `total − Σ all rows`. With the comp stored as −1603, the formula needs no special case: the comp is simply not an extra any more. Anything else that adds up rows also stays right without knowing about discounts.

Discounts left as **Split** are stored as before, as two sums on the bill (`subtotal_discount_cents`, `total_discount_cents`).

A bill must still have at least one item row. A bill made only of discount rows is refused (`22023 invalid_bill`). A $0.00 claimable discount isn't stored at all (CD-12), because a $0 row would block settling until someone "claims nothing".

### 3. The totals check is the same rule, with each discount in its own bucket
The form and the database both check that the receipt adds up, within 1¢ per check (the CLAUDE.md rule for money checks enforced in both places). A claimable discount counts in exactly the same bucket it would as a split discount: before the subtotal (`Dsub`) or after it (`Dtot`). So switching a discount between Split and Claim never changes whether the bill adds up. The spec's boundary cases B1–B7 are tested on both sides, once with the comp claimable and once with it split, and give the same answers.

### 4. Split math: a discount row is split like any row, and shares aren't capped
- **Row allocation.** A discount row is shared among its claimers by parts, with the same largest-remainder `allocate` as items. A coupon of −1000¢ claimed by A (2 parts) and B (1 part) gives A −667¢ and B −333¢.
- **New fields.** Each person gets `discountCents` (≤ 0): their pieces of discount rows. `itemsCents` stays item rows only. `totalCents = itemsCents + discountCents + extrasCents`. The bill gets `unclaimedDiscountCents`.
- **Proportional weights are items before discounts (CD-7).** Tax and tip are spread by what each person ordered, not by what they ordered minus their comp. Weights never go negative, which keeps the math free of new edge cases. Tips are usually figured on the pre-discount amount anyway.
- **Even mode counts item claimers only (CD-8).** Tax and tip are shared among people with at least one claim on an **item** (a $0 item still counts). Someone who claims only a comp pays no share of the tip. This keeps ADR 0014's wording, "claimed at least one item", literally true.
- **No cap: a share may go negative (CD-6, needs the user's review).** If Hana orders $5.00 of fries and claims a $10.00 coupon, while Sam has a $15.00 burger, Hana's share is **−$5.00**. The Settle screen already handles a negative share (from even mode, ADR 0015). If Sam paid the restaurant, Hana's card says "Sam owes you" with $5.00 and "Settle that outside the app.", with no payment link.

  Why not cap her at $0 and share the leftover $5.00 with the table? The leftover, spread out by the usual rules, can land partly back on Hana and push her below zero again, so a cap needs a loop or a second special rule. Allowing a negative share keeps the sums exact with no extra rule, and the discount really was hers.

  **This changes what someone can owe, so it is flagged for the user** (CD-6 in `docs/decisions-to-review.md`, status Open). If the user prefers a cap, that will be a new ADR that supersedes this section.

The invariant is unchanged: everyone's totals plus Unclaimed equal the bill total, exactly.

### 5. An unclaimed claimable discount blocks "complete" (CD-9)
A bill is complete when **every** row has a claim, discount rows included. Until someone claims the comp:
- settling is blocked;
- in even mode, totals stay hidden;
- the Unclaimed line shows the negative amount ("Unclaimed −$16.03").

The database's `private.bill_is_complete` already counted every row, so it didn't change, and the app's `sharesComplete` uses the same rule. No new app/database difference (CD-18). The "left to claim" copy names unclaimed discounts separately, e.g. "1 discount left to claim" or "2 items and 1 discount left to claim" (CD-10, amended 2026-11-24 by spec Amendment A1 so a bill whose items are all claimed doesn't say "1 item left").

### 6. Host edits and Activity
- Changing a claimable discount's amount, label or before/after keeps the same row, so its claims stay (like an item price change).
- Switching it to Split, setting it to $0 or deleting it removes the row and its claims, after a confirm if anyone claimed it. Switching Split → Claim makes a new, unclaimed row.
- A row never changes kind in place. The database refuses a kept id sent with a different `kind` (CD-11, CD-T2-1).
- Activity reuses the item events with `discount: true` in the details: "Hana added the discount Police comp (-$16.03)". Claims read like items: "Sam claimed Police comp" (CD-13).

## What this changes in ADR 0014
0014 said: "**One setting covers all extras**, including bill-level discounts." That is still true for **split** discounts. A discount the host marks "Claim like an item" is no longer an extra: it's a bill row, and only the people who claim it get the money off. Everything else in 0014 (one host setting, proportional vs even, totals hidden in even mode until complete, largest remainder) is unchanged.

## Consequences
- **Good:** the person who got the comp gets the money off. Using the E1 bill above (proportional): Hana (Steak + comp) owes $1.28 and Sam (Salad) owes $15.12. As a split discount it would have been $8.75 and $7.65.
- **Good:** no new tables, write functions, RLS policies or lock paths. Claims on discount rows go through the same `set_claim` / `set_item_split` code as items.
- **Cost:** someone can be owed money (CD-6). The app has no way to move it; the payer settles it outside the app. **Pending the user's review.**
- **Cost:** an unclaimed comp blocks settling (CD-9). If groups often leave comps unclaimed, a later option is "an unclaimed discount falls back to Split at settle time".
- **Cost:** split discounts are still stored as two sums, so their labels and order aren't kept. On reload the edit form lists them first as "Discount" rows, then the claimable ones (CD-14).
- **Proposed, not applied:** a sentence for `CLAUDE.md` § Conventions (agents don't edit that file): "A bill-level discount the host marks 'Claim like an item' is a negative bill row that people claim like an item instead (ADR 0017)."

Code:
- Columns and the shape check: `supabase/migrations/20261124094657_claimable_discounts.sql:40-63`. `validate_bill_rows` (row keys, at least one item `:193-196`, C2 totals `:250-267`) is at `:87-269`. `create_bill` writes `kind` / `applies_to` at `:332-344`, and `bill_created` counts item groups only at `:350-358`.
- `update_bill`: `supabase/migrations/20261124094658_claimable_discounts_update_bill.sql`. A kept id can't change kind (`:80-89`), events get `discount: true` (`:148-174`), and `applies_to` is updated on kept discount rows (`:236`).
- "Complete": `private.bill_is_complete`, unchanged (`supabase/migrations/20261124081412_settle_marks.sql:24-36`).
- DB tests: `supabase/tests/database/claimable_discounts.test.sql`.
- Split math: `lib/split.ts`. Kind checks `:126-145`, row allocation `:173-198`, extras `:200`, even mode (item claimers only) `:206-223`, proportional (item weights) `:224-234`, per-person totals `:236-241`, `sharesComplete` `:254-259`, `displayShares` `:262-284`. Tests: `lib/split.test.ts:505` onward (E1 `:522`, E2 `:561`, E4 `:607`, property test `:754`).
- Negative share on Settle: `roleFor` and `NEGATIVE_SHARE_ROLE` (`lib/settle.ts:57-63`), copy in `lib/settleView.ts:38` and `:73`. Blocked while incomplete: `lib/settle.ts:68-70`.
- Form and payload: the switch (`components/BillForm.tsx:365-376`), `DraftDiscount.claimable` (`lib/billDraft.ts:33`), `setDiscountClaimable` (`lib/billDraft.ts:188-189`). `toBillArgs` turns claimable discounts into rows (`lib/billPayload.ts:169-200`, rows at `:224-237`), and `draftFromSaved` loads them back (`:303-312`).
- Data layer: `ROW_COLUMNS` (`lib/bills.ts:127-128`), `parseKind` (`:290-299`), `rowArg` sends `kind` / `applies_to` only on discount rows (`:390-401`). (Line numbers as of 2026-11-24; another task was editing `lib/bills.ts` at the time, so search by name if they've moved.)
- View helpers: `DISCOUNTS_HEADING` and `discountRowA11yName` (`lib/billView.ts:93-96`), `breakdownText` (`:182-191`), `unclaimedTotalCents` / `showUnclaimedLine` (`:199-211`). Activity's "the discount " prefix: `lib/activityText.ts:242-246`.
- Claim screen: discounts after items (`app/(app)/bills/[id]/index.tsx:325`) under the "Discounts" header (`:450`).

Details and worked examples: [money and rounding](../concepts/money-and-rounding.md#claimable-discounts-adr-0017-2026-11-24).
