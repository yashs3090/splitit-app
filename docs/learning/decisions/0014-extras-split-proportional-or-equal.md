# 0014: Tax, tip, fees and bill-level discounts can be split proportionally or equally

**Status:** Accepted (2026-11-21, spec Amendments A1.7 and A2). Amends [0005](0005-integer-cents.md). Amended by [0017](0017-claimable-discounts.md) (2026-11-24).

> **Note (2026-11-24):** [0017](0017-claimable-discounts.md) changes the second bullet of the Decision ("one setting covers all extras, including bill-level discounts"). The host can now mark a bill-level discount **"Claim like an item"**. Such a discount is stored as a negative bill row that people claim, so it is no longer an extra and only its claimers get the money off. Discounts left as Split (the default) are still extras, exactly as below. In equal mode, "claimed at least one item" means an item row: claiming only a discount doesn't count. The text below is left as it was decided.

## Context
[ADR 0005](0005-integer-cents.md) said tax, tip and fees are allocated **in proportion to each person's item subtotal**. That's fair when people order very different amounts. But many groups prefer "we all chip in the same for the tip", and the user asked for that option (2026-11-21).

"Extras" in SplitIt means everything on the bill that isn't an item price: `total − Σ item rows`. That's tax + fees + tip − bill-level discounts, plus any 1¢ receipt rounding. Extras can be negative, for example when a big coupon is bigger than the tax and tip.

## Options
| Option | Problem |
|---|---|
| Proportional only (0005) | Doesn't match how many groups actually split the tip |
| A separate setting per extra (tax by order, tip equal) | More controls on a screen the user wants uncluttered. Not asked for. |
| **One bill-level setting for all extras: proportional or equal** | Simple. Item-level discounts still follow the items, because they're folded into item prices. |

## Decision
- A bill has `extras_split`: `'proportional'` (the default, the old behavior) or `'equal'`.
- **One setting covers all extras**, including bill-level discounts.
- **Only the host can change it**, through the `set_extras_split` database function ([0013](0013-writes-through-database-functions.md)). The change is shown to everyone live and logged in Activity.
- **Proportional:** extras are spread over each person's items subtotal, with "Unclaimed" as one more slot (unchanged from 0005).
- **Equal:** extras are divided evenly **among the participants who have claimed at least one item** (a $0.00 item counts). People with no claims pay $0 extras. **The Unclaimed line carries no extras.** If nobody has claimed anything yet, all extras sit in Unclaimed, so the numbers still add up.
- **Both modes use largest-remainder rounding**, so everyone's shares plus Unclaimed always equal the bill total exactly. Ties go to the person who comes first by user id, so every phone shows the same cents.
- **In equal mode, nobody's total is shown until every item is claimed.** Each person's items subtotal shows live. In place of their total the screen says "Total shows once all items are claimed (3 items left)". In proportional mode totals show live as before, because each person's share depends only on their own items. Whether totals may be shown is decided in pure logic (`sharesComplete` and `displayShares` in `lib/split.ts`), not in the screen.
- **For M3 (recorded, not built yet):** settling is never allowed while any item is unclaimed.

Example: three people ordered $5.00, $3.00 and $2.00 of food, and the tip is $10.00.
- Proportional: tips are 500/300/200¢.
- Equal: tips are 334/333/333¢ (largest remainder, the first person by user id gets the spare cent).

## Consequences
- **Early claimers carry the extras for a while.** Under "equal", if only one person has claimed so far, they hold all the tax and tip. Hiding totals until everything is claimed stops anyone from paying a number that's about to change.
- If one person never claims, nobody sees a total in equal mode. That gets resolved in M3 (who pays for unclaimed items).
- **Wording (resolved 2026-11-22, see the note below):** the app now uses one name per mode everywhere: "split proportionally" and "split evenly".
- `CLAUDE.md` § Conventions describes both modes (updated 2026-11-22; it originally said only "proportional").

### Note (2026-11-22): the two modes' names
The open wording question is closed. Before, the summary and the host's selector said "Tax & tip: split by what you ordered", while Activity said "… changed tax & tip to split by what each person ordered". The user chose one short name per mode, used on every screen:

| Mode (`extras_split`) | Name in the app | Where |
|---|---|---|
| `proportional` | "split proportionally" | `extrasModeName`, `lib/billView.ts:19-21` |
| `equal` | "split evenly" | same function |

- The summary line is "Tax & tip: split evenly" (`extrasModeText`, `lib/billView.ts:24-26`). The host's options are "Split proportionally" and "Split evenly" (`optionLabel`, `components/ExtrasSplitControl.tsx:26-29`).
- Activity uses the same words: "Hana changed tax & tip to split evenly" (`lib/activityText.ts:166-170`, sentence at `:298`).
- The database values (`'proportional'`, `'equal'`) didn't change. Only the words on screen did, so old Activity events read with the new words too.
- The decision itself (one setting, host only, equal among claimers, totals hidden until everything is claimed) is unchanged.

This note also updated some line numbers in the Code list below that had moved.

Code:
- Column and function: `supabase/migrations/20261121130144_extras_split.sql:15-17` and `:35-77`. Tests: `supabase/tests/database/extras_split.test.sql`.
- Math: `lib/split.ts:168-192` (both modes), `lib/split.ts:209-237` (`sharesComplete`, `displayShares`). Tests: `lib/split.test.ts`.
- Data layer: `fetchBill` reads and validates `extras_split` (`lib/bills.ts:66-67`, `:181`). `setExtrasSplit` calls the function (`lib/bills.ts:320-324`).
- View helpers: `EXTRAS_MODES`, `extrasModeOf`, `extrasModeName`, `extrasModeText` and `extrasModeHelp` (`lib/billView.ts:11-31`).
- Screen: the host's selector, or plain text for everyone else, is `components/ExtrasSplitControl.tsx:31`. It's mounted in the expanded summary at `app/(app)/bills/[id]/index.tsx:431`, and the optimistic change calls `setExtrasSplit` at `:147`.
- Tests: `__tests__/extrasSplit.test.tsx`.

Details and worked examples: [money and rounding](../concepts/money-and-rounding.md).
