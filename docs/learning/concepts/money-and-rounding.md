# Money and rounding

## The idea
1. **Integer cents.** `$12.34` is stored as `1234`. Integers add up exactly; floats don't (`0.1 + 0.2 = 0.30000000000000004`).
2. **Allocating the extras.** "Extras" means tax, tip and fees minus bill-level discounts. (Since 2026-11-24, a discount the host marks "Claim like an item" is not an extra: it's a negative bill row that people claim. See "Claimable discounts" below and [ADR 0017](../decisions/0017-claimable-discounts.md).) By default they're shared **in proportion** to what each person ordered: ordering 60% of the food means paying 60% of the tip. The host can switch a bill to **equal**, where everyone who claimed something pays the same extras ([ADR 0014](../decisions/0014-extras-split-proportional-or-equal.md); see "Equal mode" below). On screen the two modes are called **"split proportionally"** and **"split evenly"** (the user's wording, 2026-11-22). In the code and the database they're `'proportional'` and `'equal'`.
3. **Largest-remainder rounding.** Proportional shares produce fractions of a cent. Round everyone *down*, then hand out the leftover cents one at a time to the people with the largest fractional parts. The parts always sum exactly to the whole.

### Worked example
Subtotals: Ana 1000¢, Ben 1000¢, Cy 1000¢. Tax = 100¢.
- Exact shares: 33.33…¢ each. Rounded down: 33 + 33 + 33 = 99¢, so **1¢ left over**.
- Fractional parts are all 0.33 (a tie). Break ties deterministically, e.g. by user id: Ana gets +1.
- Result: 34 / 33 / 33 = 100¢ ✓

If everyone had rounded to the nearest cent on their own, the shares would be 33 + 33 + 33 = 99¢. The host is short a cent, and with uneven shares you can also end up *over* the total.

### The algorithm (sketch)
```ts
// weights: each person's item subtotal in cents; amount: cents to allocate
function allocate(amount: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return weights.map(() => 0); // caller decides: equal split?
  const exact = weights.map(w => (amount * w) / totalWeight);
  const floors = exact.map(Math.floor);
  let leftover = amount - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i); // deterministic tie-break
  for (const { i } of order) { if (leftover-- <= 0) break; floors[i] += 1; }
  return floors;
}
```
This sketch is only for understanding: `amount * w / totalWeight` is float math, which can be off for big numbers. The real code is below.

### The real `allocate` (`lib/split.ts:81-109`)
- **It uses `BigInt` for `amount × weight`.** A bill total can be up to 99,999,999¢ and a weight can be just as large, so the product can pass 2⁵³, where plain JavaScript numbers stop being exact. BigInt division gives the exact floor and the exact remainder, with no floats anywhere.
- **Leftover cents go to the largest remainders. Ties go to the lower index**, and callers always pass people sorted by user id, so every phone gets the same cents.
- **A negative amount** (a discount bigger than tax and tip) is allocated as the negative of the positive one: `allocate(-100, [1,1,1])` → `[-34,-33,-33]`.
- **It refuses bad input** with a `RangeError`: negative or non-integer weights, a non-integer amount, or weights that sum to 0 when the amount isn't 0.

### Unit rows: splitting a line's price into units
A receipt line "Beer ×2 $14.00" is stored as **two rows**, "Beer · 1 of 2" and "Beer · 2 of 2", so each one can be claimed on its own (spec A1.3; [database design](database-design.md)). The line price is split across the units with the same `allocate`, using equal weights:
- "Beer ×2, $14.00" → `allocate(1400, [1,1])` → 700 / 700.
- "Beer ×3, $10.00" → `allocate(1000, [1,1,1])` → **334 / 333 / 333**. The first unit gets the spare cent, and the units add back up to exactly $10.00.

This happens in the app, in `toBillArgs` (`lib/billPayload.ts:209`), before saving. The database then checks the rows add up (`private.validate_bill_rows`).

### Shared items and parts
Each claim has **parts** (1–20, default 1). An item's price is split among its claimers in proportion to their parts:
- Fries (600¢) claimed by A and B at 1 part each → `allocate(600, [1,1])` → 300 / 300 ("Split 2 ways · $3.00 each").
- B sets a custom split, A 2 parts and B 1 → 400 / 200 ("Custom split · set by B").
- **Parts are kept when claimers change** (spec A2.3). If Pat then claims the Fries too, Pat starts at 1 part and A keeps 2, so it's 2:1:1. When someone leaves, the others keep theirs. With only one claimer left, they pay the whole item whatever their parts.
- **An unclaimed item** goes to the "Unclaimed" line. It's never dropped. Settling is blocked until everything is claimed. *(Updated 2026-11-24: M3 added no special tool for leftovers (the user's Q1 answer). Someone claims the item, and "Split differently" can share it.)*

### Proportional mode (the default, "split proportionally")
Extras = `total − Σ rows` (item rows, plus any claimable discount rows, which are negative). They're allocated across **each person's items subtotal, plus one extra slot for Unclaimed** (`lib/split.ts:224-234`). The weights are item rows only: a claimed discount never lowers your weight (ADR 0017, CD-7). The Unclaimed slot matters: until everything is claimed, part of the tax and tip belongs to the unclaimed food, not to the people who've claimed so far.

Worked bill (from `lib/split.test.ts`): Burger 1500, Fries 600, Beer 700, Beer 700, total 4480, so extras are 980.
- Only B has claimed (Fries + one Beer = 1300). Weights are [B 1300, Unclaimed 2200], so B's extras are 980 × 1300 / 3500 = **364**. B owes 1664, and Unclaimed shows 2200 + 616 = 2816.
- Then A claims Burger, half the Fries and the other Beer: A has 2500 and B has 1000. Extras are 700 / 280. **A owes 3200, B owes 1280**, total 4480 ✓.

### Equal mode ("split evenly")
Under "equal" ([ADR 0014](../decisions/0014-extras-split-proportional-or-equal.md), `lib/split.ts:206-223`):
- Extras are divided **evenly among the participants who have claimed at least one item** (a $0.00 item counts), with weights all 1 and people sorted by user id. A claim on a claimable discount alone doesn't count (ADR 0017, CD-8).
- People who haven't claimed anything pay $0 extras.
- **The Unclaimed line carries no extras**, only the unclaimed item prices.
- If nobody has claimed anything yet, all extras sit in Unclaimed, so the numbers still add up.

**Example: three people, $10.00 tip.** u1 ordered $5.00, u2 $3.00, u3 $2.00. Total $20.00, extras 1000¢.
- Equal: `allocate(1000, [1,1,1])` → **334 / 333 / 333**. Totals 834 / 633 / 533 = 2000 ✓.
- Proportional on the same bill: 500 / 300 / 200.

Same worked bill as above, equal mode: with A and B both claiming, extras are 490 / 490, so **A owes 2990 and B owes 1490** (instead of 3200 / 1280).

**The catch: early claimers carry the extras.** If only B has claimed so far, B holds all 980¢ of extras. That's why equal mode hides totals until everything is claimed.

### When totals may be shown: `sharesComplete` and `displayShares`
- `sharesComplete(input)` (`lib/split.ts:254-259`) says whether every row has at least one counted claim, and how many rows don't. Claimable discount rows are rows too.
- `displayShares(input)` (`lib/split.ts:262-284`) is what the screen renders. `totalsVisible` is `mode === 'proportional' || complete`. When it's false, everyone's `discountCents`, `extrasCents` and `totalCents` are `null`, and only `itemsCents` is filled in. The screen then shows "Your items $10.00" and "Total shows once all items are claimed (1 item left)" (`pendingTotalText`, `lib/billView.ts:214-216`).
- In proportional mode totals always show, because your share depends only on your own items.
- **The decision lives in `lib/`, not in the component.** `components/SharesSummary.tsx` renders whatever `displayShares` returns and never works out completeness itself.

### When the Unclaimed line shows: `showUnclaimedLine`
The summary shows an "Unclaimed" line **whenever the unclaimed amount isn't $0.00**, not only while some item is unclaimed (`showUnclaimedLine`, `lib/billView.ts:209-211`, used at `components/SharesSummary.tsx:47`; user decision 2026-11-22). Otherwise it says "Everything's claimed."

Why "every item is claimed" isn't enough: in proportional mode, extras follow each person's items subtotal. Example (from the test): A claims a free Water ($0.00), B claims free Bread ($0.00), and the bill total is $2.00, all of it tax. Every weight is 0, so nobody's subtotal can carry the tax, and `computeShares` puts all 200¢ in Unclaimed (`lib/split.ts:226-228`). Every row is claimed, but 200¢ is still unclaimed. If the screen hid the line, A's and B's totals ($0.00 each) wouldn't add up to the $2.00 bill on screen.

The rule, in short: show the line if `!complete` **or** `unclaimedItemsCents + unclaimedDiscountCents + unclaimedExtrasCents !== 0`. (`unclaimedDiscountCents` is claimable discounts nobody has claimed; it's 0 on bills without them.) The amount itself comes from `unclaimedTotalCents` (`lib/billView.ts:199-201`), so the component does no money math. Tests: `lib/billView.test.ts:148-181` and `:468-504`.

### The invariant
In both modes, **Σ people's totals + Unclaimed = bill total, exactly, in integer cents**. Seeded property tests in `lib/split.test.ts` check this on hundreds of random bills, check that shuffling the input gives identical results, and check that in equal mode any two claimers' extras differ by at most 1¢.

**Where the mode comes from.** `fetchBill` reads `bills.extras_split` and rejects anything other than the two modes (`lib/bills.ts:62`, `:279`). `splitInputFor` passes it into the split math through `extrasModeOf` (`lib/billView.ts:22-24`). The host changes it with `components/ExtrasSplitControl.tsx` (mounted at `app/(app)/bills/[id]/index.tsx:485`), which calls `setExtrasSplit` (`lib/bills.ts:466-470`). The host's options read "Split proportionally" and "Split evenly". Everyone else sees the mode as text ("Tax & tip: split evenly", `extrasModeText`, `lib/billView.ts:32-34`). Both come from one function, `extrasModeName` (`lib/billView.ts:27-29`), and Activity uses the same words ("Hana changed tax & tip to split evenly", `lib/activityText.ts:378-382`). Tests: `__tests__/extrasSplit.test.tsx`, `lib/billView.test.ts:199-200`. *(Line numbers updated 2026-11-24. `lib/bills.ts` was being edited by another task that day, so if its numbers have moved, search for `extras_split` and `setExtrasSplit`.)*

### Settling up: who owes the payer (M3, 2026-11-24)
Once every item is claimed, everyone except the **payer** (the person who paid the restaurant) pays the payer their share ([ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md)). `settlePlan` in `lib/settle.ts:65-103` works out who owes what.

**Settle amounts come straight from `computeShares`.** There's no second formula. `settlePlan` runs `computeShares` once, and each non-payer's `owedCents` is exactly their `totalCents` from it. The payer's own share is never collected (you don't pay yourself). Because the shares already add up to the bill total, this always holds:

> Σ owedCents (everyone but the payer) + the payer's own share = bill total

A seeded property test checks it on 500 random complete bills in both modes, with a random payer (`lib/settle.test.ts:348-391`).

**Worked example** (the spec's, used by both the app and database tests). Hana hosts, Sam joined. Burger 1500¢ (Hana), Salad 1000¢ (Sam), Fries 600¢ shared 1:1. Total 3600¢, so extras are 500¢.
- Items: Hana 1500 + 300 = 1800, Sam 1000 + 300 = 1300.
- Proportional extras: `allocate(500, [1800, 1300, 0])` gives 290 and 209 rounded down (499), and the spare cent goes to Sam, whose remainder is larger. So Hana 2090, Sam 1510.
- If Hana is the payer, Sam sees "Pay Hana $15.10 on Venmo". If Sam is the payer, Hana owes $20.90.
- Split evenly instead: extras 250 each, so Sam owes 1550.

**When there's nothing to settle yet.** `settlePlan` returns a "blocked" result with no amounts at all:
- `blocked`: some row has no claim. Same rule as `sharesComplete`, and the same rule the database uses (`private.bill_is_complete`). Showing no amounts keeps even mode's "totals hidden until everything is claimed". *(Updated 2026-11-25: on a proportional bill, an incomplete bill now gives the `early` plan instead, once the Settle screen asks for it. See "Paying early" below.)*
- `blocked_all_zero`: everything is claimed, but `computeShares` still has cents nobody carries (`unclaimedCents ≠ 0`). That only happens in proportional mode when every item is $0.00 and the total isn't, the same case as "When the Unclaimed line shows" above. The screen says "Every item is $0. Fix the prices, or switch to Split evenly." *(Until 2026-11-25 the database didn't block this case: the deliberate "K6" difference in ADR 0015. Since [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md) it does, with the same rule Z, so K6 is closed.)*

**Roles.** Each non-payer gets a role from their `owedCents`:
- above 0: `owes` (shown with a Pay button);
- exactly 0: `nothing` ("You don't owe anything on this bill.");
- below 0: `payer_owes_them`. *(Updated 2026-11-24: this can now also happen when someone claims a discount bigger than their items, in either mode; see E2 under "Claimable discounts" below.)* With split discounts it happens only in even mode with a big bill-level discount. Example: items 1000¢ and 0¢, total 800¢, so extras are −200¢, split evenly −100¢ each. The shares are 900¢ and **−100¢**: the payer owes that person $1.00. The screen says "Hana owes you $1.00. Settle that outside the app." with no link.

**`markDiffCents`: the share changed after "I paid".** *(Note 2026-11-25: this is how M3 worked. The screens now use `difference` instead, with buttons to settle it; see "Paying a difference" below. `markDiffCents` still exists in `lib/settle.ts` with the same meaning, but no screen reads it, and the "Sort out the $1.10" copy is gone.)* An "I paid" mark stores the amount the screen showed (`settled_cents`). Later the host might edit a price, or someone might unclaim, and the share moves. The mark keeps its old amount (the user's Q3 answer), and `settlePlan` adds two fields for each marked person:
- `markDiffCents = owedCents − mark.cents` (signed whole cents);
- `markDiffers = markDiffCents !== 0`.

Examples, with Sam marked at 1510¢:

| Sam's share now | `markDiffCents` | What Sam sees |
|---|---|---|
| 1620¢ | 110 | "⚠ Your share is now $16.20. Sort out the $1.10 with Hana." |
| 1510¢ | 0 | no warning, just "Marked paid" |
| 1400¢ | −110 | "⚠ Your share is now $14.00. Hana owes you $1.10 back." |

The subtraction happens once, in `lib/settle.ts:90`, and the sentences are built in `lib/settleView.ts` with `formatCents`. Components never subtract cents (lessons log, "Money math was duplicated in a component"). Tests: `lib/settle.test.ts:393-442`.

**C2: which amounts are allowed.** A mark's amount, and the amount in a Venmo link, must be **a whole number of cents from 1 to 99,999,999** (the same upper bound as a bill total).
- Why not "at most the bill total"? In the negative-share example above, one share (900¢) is more than the bill total (800¢). A cap at the total would refuse a real share.
- Why not 0 or negative? Nobody marks "I paid $0", and a negative share has no Pay button.
- Where it's checked, with the same bounds everywhere: `isSettleCents` (`lib/paylinks.ts:32-34`), used by `venmoPayUrl` (no link) and `markPaid` (`lib/bills.ts:501-503`, refused with no network call); in the database, the `settled_cents` check constraint (`supabase/migrations/20261124081411_settle_payer.sql:56-57`) and `mark_paid`'s `22023 invalid_amount` (`20261124081412_settle_marks.sql:77-79`).

| Value | App | Database |
|---|---|---|
| 0 | refused | `invalid_amount` |
| 1 | sent | accepted |
| 99,999,999 | sent | accepted |
| 100,000,000 | refused | `invalid_amount` |
| −5 | refused | `invalid_amount` |
| 12.5 | refused | can't happen (integer parameter) |

Both sides test these same cases (the CLAUDE.md rule for money checks enforced in two places).

*Note 2026-11-25:* `settle_difference` (below) takes two amounts. The "from" amount follows C2 exactly (1 to 99,999,999). The "to" amount may also be **0**, which means "paid back in full" and clears the mark. A stored mark is still never 0. The app's `settleDifference` refuses the same values before sending (`lib/bills.ts`).

### Paying early: why proportional shares stay put (2026-11-25)
*From spec `docs/specs/2026-11-25-settle-early-and-differences.md` (D1) and [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md).*

Since 2026-11-25, on a proportional bill you can pay as soon as you've claimed at least one item, without waiting for everyone else. That's only safe if your amount won't change when *other* people claim. Here's why it doesn't.

**The key fact: the weights always add up to the same number.** Proportional extras are spread over `[each person's items, Unclaimed items]` (see "Proportional mode" above). Add those weights up and you get the sum of every item row on the bill, whoever has claimed what. When Dee claims the Dessert, 500¢ of weight moves from the Unclaimed slot to Dee's slot. The total weight doesn't change, and neither does Sam's weight (his own items). So Sam's exact share of the extras, `extras × Sam's items ÷ all items`, stays the same.

The one thing that can move is **rounding**. Largest-remainder rounding hands out the spare cents by comparing everyone's fractions, and when the Unclaimed slot is split between new people, the spare cent can land somewhere else.

**Worked example (a tiny 7¢ fee, so the arithmetic stays small).** Burger 2500¢ (Hana), Salad 3500¢ (Sam), two Desserts 2000¢ each that nobody has claimed. Total 10,007¢, so extras are 7¢. Weights add up to 10,000.

| | Hana (2500) | Sam (3500) | Unclaimed (4000) | Dee (2000) | Eve (2000) |
|---|---|---|---|---|---|
| Exact extras, before | 1.75 | 2.45 | 2.80 | | |
| Rounded, before | 1 + 1 = **2** | **2** | 2 + 1 = **3** | | |
| Exact extras, after Dee and Eve claim a Dessert each | 1.75 | 2.45 | | 1.40 | 1.40 |
| Rounded, after | 1 + 1 = **2** | 2 + 1 = **3** | | **1** | **1** |

Before: rounding down gives 1 + 2 + 2 = 5, so 2 cents are spare. They go to the two largest fractions: Unclaimed (.80) and Hana (.75). Sam pays 3502¢ if he pays early.

After: rounding down gives 1 + 2 + 1 + 1 = 5, and the 2 spare cents go to Hana (.75) and Sam (.45), because Dee's and Eve's fractions (.40) are smaller. Sam's share is now 3503¢: **1¢ more**, though he did nothing.

That 1¢ is the most rounding can move it. A seeded property test checks this: it takes random early bills, lets **other** people claim, unclaim, change splits and join in random orders (up to 12 steps) until the bill is complete, and checks the early payer's share moved by **at most 1¢ in total**, and by exactly 0 when their items add up to $0 (`lib/settle.test.ts`, criterion 17c, "other people's actions, run to completion").

**Why this doesn't work in even mode.** In even mode, extras are divided among the people who have claimed something. When Dee claims her first item, the tip is split three ways instead of two, and Sam's share drops by a lot more than a cent. So even-mode bills still wait until every item is claimed.

**What *can* still change your early share** (spec D1, causes W1–W9). These aren't rounding, so they can be any size:
- someone joins an item you claimed, or changes its split (your piece of that item shrinks or grows);
- you claim or unclaim something yourself;
- the host edits prices, tax, tip or the total, or adds or removes a row;
- the host switches to "Split evenly" (the bill goes back to waiting, and your mark stays);
- someone claims a claimable discount you share;
- someone sharing your item leaves or is removed;
- the host changes who gets paid (every mark is cleared, as before).

That's why the early card says "Your share may change until everything is claimed (1 item left)", and why differences exist.

### Paying a difference (2026-11-25)
When your share moves after you've marked "I paid", the plan gives you a `difference` (`differenceFor` and `differenceOf` in `lib/settle.ts`). With your mark at `mark` and your share at `owed`:
1. `target = max(owed, 0)`. A share below $0 is only paid back down to $0; the rest stays "settle that outside the app" (decision SE-12).
2. `delta = target − mark`.
3. If `|delta| ≤ SETTLE_DIFF_IGNORE_CENTS` (1¢): no difference.
4. If `delta > 0`: `{ kind: 'more', cents: delta }`. You owe the payer more.
5. If `delta < 0`: `{ kind: 'back', cents: −delta }`. The payer owes you that much back.

Sam is marked at 1510¢:

| Sam's share now | `difference` | What happens once the bill is complete |
|---|---|---|
| 1620¢ | more 110 | Sam: "Pay Hana $1.10 more on Venmo", then "I paid the difference" (mark becomes 1620) |
| 1511¢ | none (within 1¢) | nothing; Sam's card just says "Marked paid" |
| 1400¢ | back 110 | Hana: "Pay $1.10 back", then "I paid it back" (mark becomes 1400) |
| 0¢ | back 1510 | Hana pays back the whole 1510; the mark is **cleared**, not set to 0 |
| −100¢ | back 1510 | as above, plus "Hana also owes you $1.00 for your share. Settle that outside the app." |

**The mark is the net amount.** After those steps, `settled_cents` holds what has been settled overall (marked + paid more − paid back). The card shows one number, and Activity keeps each step ("Sam paid Hana $1.10 more").

**The 1¢ tolerance.** `SETTLE_DIFF_IGNORE_CENTS = 1` (a starting value, decision SE-11; waiting for the user's review). It exists because of the rounding cent above: without it, Sam in the worked example would be asked to send Hana $0.01. The cost: a payer can end up 1¢ short or over per person. Set it to 0 and every cent shows (a test does exactly that through `differenceFor`'s third argument).

**Why the database has no tolerance, and why that isn't two different money rules.** The database never compares a mark with a share. It can't: shares come from `computeShares`, which exists only in `lib/`. `settle_difference` just records "from X to Y", checking that X is the current mark and that Y is a valid amount. So a direct API call that records a 1¢ difference is accepted (case D5). The tolerance is only about which differences the app *asks* people to settle, not a rule about which amounts are valid. The rules that both sides do enforce (rule E for who may pay, rule Z for all-$0 bills, the C2 amount range) are written in both places and tested on the same cases.

### Claimable discounts (ADR 0017, 2026-11-24)
A bill-level discount is normally an extra, so it lowers everyone's share. But some discounts belong to one person: a comp on their meal, a coupon they brought. So each discount row in the bill form has a switch, **"Claim like an item"** (off by default). When it's on, the discount becomes a bill row that people claim and share by parts, exactly like an item ([ADR 0017](../decisions/0017-claimable-discounts.md)).

**How it's stored.** A claimable discount is a `line_items` row with `kind = 'discount'` and a **negative** `total_cents` (the comp below is −1603). Because it's negative, the extras formula doesn't change: extras are still `total − Σ rows`, and the comp, being a row, simply isn't part of the extras any more. Discounts left as Split are still the two sums on the bill.

**The math** (`computeShares`, `lib/split.ts:173-241`):
- A discount row is split among its claimers by parts with the same `allocate` (the negative-amount path). A −1000¢ coupon at 2 parts to 1 gives −667 / −333.
- Each person gets a new field, `discountCents` (≤ 0). Their total is `itemsCents + discountCents + extrasCents`.
- **Proportional weights are items only.** A claimed discount doesn't lower your weight for tax and tip (CD-7).
- **Even mode counts item claimers only.** Claiming just a discount doesn't put you in the tax-and-tip split (CD-8).
- **No cap.** A share can go negative (CD-6, still **waiting for the user's review**; see E2).
- A discount row nobody has claimed is an unclaimed row: the bill isn't complete, settling is blocked, and the Unclaimed line shows the negative amount (`unclaimedDiscountCents`).

**The totals check doesn't care which kind it is.** The comp counts in the same bucket (before or after the subtotal) whether it's split or claimable, so flipping the switch never changes whether the bill adds up. Same rule in the form and in the database (`validate_bill_rows`, `supabase/migrations/20261124094657_claimable_discounts.sql:250-267`).

The examples below use the spec's bill, tested in `lib/split.test.ts:505` onward. Hana and Sam stand for the tests' users A and B (A sorts first).

**E1: the comp is claimed (proportional mode).** Steak 1603¢ (Hana), Salad 1400¢ (Sam), "Police comp" −1603¢ claimed by Hana. Subtotal 1400¢, tax 240¢, total 1640¢.
- Σ rows = 1603 + 1400 − 1603 = 1400, so extras = 1640 − 1400 = **240** (just the tax).
- Weights are items only: `allocate(240, [1603, 1400, 0])`. Exact shares are 128.1 and 111.9. Rounded down that's 128 + 111 = 239, and the spare cent goes to Sam (larger remainder): **128 / 112**.
- Hana: 1603 − 1603 + 128 = **128¢**. Sam: 1400 + 112 = **1512¢**. Sum 1640 ✓.
- For contrast, the same comp as a **split** discount: extras = 1640 − 3003 = −1363, allocated −728 / −635, so Hana owes 875¢ and Sam 765¢. The comp would have taken $6.35 off Sam's salad.
- In even mode (E1-even): extras 240 split 120 / 120, so Hana owes 120¢ and Sam 1520¢.

**E2: a discount bigger than your items (a negative share).** Fries 500¢ (Hana), Burger 1500¢ (Sam), a −1000¢ coupon claimed by Hana. No tax or tip, total 1000¢.
- Extras = 1000 − (500 + 1500 − 1000) = 0.
- Hana: 500 − 1000 = **−500¢**. Sam: **1500¢**. Sum 1000 ✓.
- **If Sam paid the restaurant:** Hana's role is `payer_owes_them`. Her Settle card says "Sam owes you" with $5.00 and "Settle that outside the app.", and there's no payment link (`negativeLabel`, `negativeBody`, `lib/settleView.ts:73`, `:38`). Nobody pays Sam through the app (`collectCents` is 0).
- **If Hana paid:** Sam owes her 1500¢. Hana paid $10.00 and gets $15.00 back, so she ends $5.00 up, which is her coupon minus her fries.
- Why allow it? The coupon was Hana's. Capping her at $0 would mean sharing the leftover $5.00 with the table, and that leftover can land partly back on her and push her below zero again. **This is decision CD-6, flagged for the user's review** because it changes what someone can owe.

**E4: nobody has claimed the comp yet (proportional mode).** Same bill as E1, but the comp has no claim.
- Extras are still 240, with the same weights: 128 / 112.
- Hana: 1603 + 128 = **1731¢**. Sam: **1512¢**. Unclaimed: **−1603¢** (`unclaimedDiscountCents`). Sum 1731 + 1512 − 1603 = 1640 ✓.
- The bill isn't complete (`unclaimedRows` is 1), so settling is blocked, and the summary shows "Unclaimed -$16.03". Once Hana claims the comp, it becomes E1. The database agrees: `private.bill_is_complete` already counted every row, discounts included, so `mark_paid` refuses with `not_complete`.

**On screen.** The person's summary line comes from `breakdownText` (`lib/billView.ts:182-191`). For Hana in E1 it reads "Items $16.03 − claimed discounts $16.03 + tax, tip and fees $1.28". In even mode, claimed discounts only appear once the totals do (CD-16).

## Why it matters here
SplitIt's whole promise is "everyone pays exactly their share, and the shares add up to the bill". A single lost cent means the host is out of pocket, and two phones showing different cents means people stop trusting the app. Money enters SplitIt in two ways, and both have to land as exact integer cents:
- **From a receipt:** the parser reads text like `$12.99` or `(2.00)`.
- **From a person typing:** the host corrects or enters prices in the bill form.

([ADR 0005](../decisions/0005-integer-cents.md) records the decision.)

## How we use it
All money conversion lives in `lib/money.ts`. Nothing else turns text into cents.
- **The trick: never multiply a float by 100.** `Math.round(parseFloat("4.35") * 100)` happens to work, but `parseFloat("4.35") * 100` is `434.99999999999994`, and code that forgets the rounding (or uses `Math.floor`) gets 434¢. Instead we glue the dollar digits and the two cent digits into one string and read it as an integer: `"4" + "35"` → `parseInt("435", 10)` → 435 (`digitsToCents`, `lib/money.ts:18`). A test checks values like 0.29, 0.57, 1.15 and 4.35, where the float approach goes wrong.
- **Receipt text:** `parseMoneyToken` (`lib/money.ts:28`) is strict. It needs exactly two decimals (`12.99`, `$12.99`, `1,234.50`) and understands receipt-style negatives (`-2.00`, `(2.00)`, `2.00-`). `12` or `12.9` on a receipt is probably not a price, so it's rejected.
- **Showing money:** `formatCents` (`lib/money.ts:55`) gives `$1,234.50` for display. `formatCentsInput` (`lib/money.ts:63`) gives `1234.50` to put in a text field (no `$`, no commas). Both refuse non-integers instead of printing garbage like `NaN`.

### Form input: strings in, cents out
The bill form (`components/BillForm.tsx`) keeps **the exact string the user typed** in each field, not a number (`DraftItem.price: string`, `lib/billDraft.ts:12-21`). Why:
- **Half-typed values survive.** While typing `12.50`, the field passes through `1`, `12`, `12.` and `12.5`. If we turned each keystroke into a number and back, `12.` would become `12` and the user couldn't type the decimal point.
- **Invalid input stays visible.** If someone types `12.999`, we keep showing `12.999` with the error "Enter an amount like 12.99." instead of silently rounding it.
- **There's only one place that makes cents.** `evaluateDraft` (`lib/billDraft.ts:167`) reads each field through `readMoney` (`lib/billDraft.ts:150`), which calls `parseMoneyInput` (`lib/money.ts:95`). Blank means "not on the receipt" (`null`, never 0); invalid means an error message and the field is left out of the totals check.

`parseMoneyInput` is more forgiving than the receipt parser, because people type differently from how receipts print:
- **Accepted:** `12` → 1200, `12.5` → 1250, `12.` → 1200, `.99` → 99, `$1,234.50` → 123450.
- **Rejected (returns null):** negatives (`-5`, `(5.00)`; discounts have their own field), more than 2 decimals (`12.999`), badly grouped commas (`1,23.00`), and things JavaScript's `Number()` would happily accept, like `1e3`, `Infinity` and `NaN`.
- **Too large:** anything over `MAX_INPUT_CENTS` ($99,999.99, `lib/money.ts:8`) returns null, and `isTooLarge` (`lib/money.ts:101`) tells the form to say "That amount is too large." rather than "invalid".

It's the same integer string math as the receipt parser: a regex splits dollars and cents, then `digitsToCents` joins them. A grep in the spec's acceptance criteria (45) checks that `parseFloat`, `Number(`, `* 100` and `toFixed` never appear in the money, parser or form files.

## Pitfalls
- Rounding each person separately.
- Ordering that isn't deterministic: two phones show different cents.
- Discounts: negative lines or a bill-level discount must reduce subtotals before tax and tip are allocated, *if* the receipt computed tax after the discount. Follow the receipt.
- Formatting: `(1234 / 100).toFixed(2)` is fine for display, but never feed the result back into math. We use `formatCents` anyway, which never goes through a float.
- Converting form fields to numbers on every keystroke: the user can't type `12.` and invalid input gets silently "fixed".
- Treating a blank field as 0. A blank tip means "no tip line on the receipt", which is different from "tip was $0.00". We keep it `null`.
- Using `Number(s)` or `parseFloat(s)` to validate input: both accept `1e3`, and `Number("")` is 0.
- Leaving out the Unclaimed slot in proportional mode. Then the first person to claim pays all the tax and tip.
- Computing `amount * weight` with plain numbers. Past 2⁵³ the result isn't exact. Use `BigInt` (as `allocate` does).
- Splitting "Beer ×3, $10.00" as 333 × 3 = 999. Use `allocate` so the units add back up.
- Deciding in a component whether totals are visible. That rule is `displayShares`'s job, so it's tested once and every screen agrees.
- Computing a settle amount with its own formula. Use `computeShares`' total for each person, so the Settle screen and the bill screen can never disagree by a cent.
- Capping a mark's amount at the bill total. In even mode with a big discount, one share can be bigger than the total (C2 above).
- Hiding "Unclaimed" just because every item has a claimer. Leftover cents (like tax on a bill of $0.00 items) still need a line, or the screen stops adding up. Use `showUnclaimedLine`.
- Using a claimed discount as a proportional weight. Weights would go down, or even below 0, and `allocate` refuses negative weights. Weights are item rows only (CD-7).
- Storing a claimable discount as a positive number and "remembering" to subtract it. Every place that sums rows would need to know. Stored negative, `total − Σ rows` just works.
- Assuming a share is never negative. Since ADR 0017, a claimed coupon can make it negative in either mode. Code that formats, caps or sums shares must handle it (the Settle screen does, with `payer_owes_them`).
- Forgetting the unclaimed discount when adding up "Unclaimed". It's `unclaimedItemsCents + unclaimedDiscountCents + unclaimedExtrasCents`; leave one out and the screen stops adding up (E4).
- Letting people pay early in even mode. Every new claimer changes everyone's even share, so an early amount would be wrong by much more than a cent.
- Expecting an early share to be *exactly* stable. Rounding can move it by 1¢ (the worked example above). Code that compares a mark with a share needs the 1¢ tolerance, or it asks people to send $0.01.
- Storing a $0 mark for "paid back in full". It would need its own card, couldn't be undone, and would stop the person leaving the bill. Clear the mark instead; Activity keeps the history.
- Paying back more than the mark when a share goes negative. Pay-backs stop at $0; the rest is settled outside the app.

## Check yourself
1. Allocate a 1000¢ tip across subtotals 2000¢, 1000¢, 1000¢.
2. Why must the tie-break be deterministic?
3. What should happen when nobody has claimed anything yet (total weight is 0)?
4. The host types `12.` into a price field and pauses. What's stored in the draft, what does `parseMoneyInput` return for it, and why don't we store 1200 straight away?
5. Why does `parseMoneyInput` accept `12` but `parseMoneyToken` rejects it?
6. What do `Number("1e3")` and `Number("")` return, and why does that make `Number()` a bad money validator?
7. "Wine ×3, $25.00": what does each unit row cost?
8. In equal mode, A and B have claimed and C hasn't. Tax and tip total $9.01. What extras does each person pay, and what does the Unclaimed line carry?
9. Why does equal mode hide totals until every item is claimed, but proportional mode doesn't?
10. Sam has 2 parts on the Nachos and Alex has 1. Pat claims the Nachos too. What are the parts now?
11. Every item on a bill is claimed, but the summary still shows "Unclaimed $1.50". How can that happen, and why is showing it the right call?
12. In the worked settle example, Sam is the payer. How much does Hana owe, and why is Sam's own $15.10 not on anyone's Pay button?
13. Sam marked "I paid" at $15.10. The host then corrects the Salad's price and the tip, and Sam's share becomes $16.20. What are `markDiffCents` and `markDiffers`, and what does Sam see?
14. Why does C2 allow up to 99,999,999¢ instead of "no more than the bill total"?
15. In E1, why does Sam's share go *up* (from 765¢ to 1512¢) when Hana's comp is switched from Split to "Claim like an item"? Where did the difference go?
16. A bill has a $20.00 burger (Sam), a $10.00 pasta (Hana) and a −$4.00 claimable coupon claimed by Hana. Tax is $3.00 and the bill is in proportional mode. What are the weights for the tax, and why isn't Hana's weight 600?
17. Cy claims only the coupon on an even-mode bill. Does Cy pay a share of the tip? What would go wrong if a claim on a discount counted?
18. On a proportional bill, Sam paid early. Dee then claims the last unclaimed item. Why does Sam's share stay the same (or move by at most 1¢)? What would happen on an even-mode bill?
19. Sam marked $15.10 and his share is now $15.11. Why doesn't the app ask him to pay 1¢, and what does the database do if a script records 1510 → 1511 anyway?
20. Sam marked $15.10, and after a coupon his share is −$1.00. How much does Hana pay back through the app, what happens to Sam's mark, and what happens to the other $1.00?

## Learn more
- Largest remainder method: https://en.wikipedia.org/wiki/Largest_remainder_method
- Martin Fowler, Money pattern: https://martinfowler.com/eaaCatalog/money.html
- MDN, `Number.isSafeInteger` (why integer cents stay exact up to 2^53 − 1): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isSafeInteger
- MDN, floating-point precision (`Number.EPSILON`): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/EPSILON
