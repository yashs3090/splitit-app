# Group balances

How a group works out who owes whom across many receipts, expenses and payments, and how it turns that into a short list of payments. The decision is [ADR 0022](../decisions/0022-groups.md). The rules are C-G1 to C-G4 in `docs/specs/2026-11-26-groups-mvp.md`.

## The idea

### One number per person: the net balance
Inside a group, nobody pays "for this bill". Each person gets **one number** that sums up everything:

```
net = paid − share + sent − received
```

- **paid**: what you paid up front. The total of each counting receipt you paid for, plus each expense you paid.
- **share**: what your part of those costs was. Your share of each counting receipt (from the same split math as a normal bill), plus your cents of each expense.
- **sent**: group payments you made to other members.
- **received**: group payments other members made to you.

A **positive** net means people owe you ("You're owed $5.00"). A **negative** net means you owe ("You owe $4.00"). Zero means you're settled up.

**The nets always add up to exactly $0.** Here's why:
- Each receipt or expense adds its full amount to one person's *paid*, and the same amount, split up, to people's *shares*. The split always adds back to the total (largest-remainder rounding, below). So each cost adds `+amount − amount = 0` to the sum.
- Each payment adds its cents to one person's *sent* and the same cents to another's *received*. Again `+x − x = 0`.

So the sum is a sum of zeros. `groupBalances` checks this before it returns, and throws an error if it's ever not 0, rather than show balances that don't add up.

### Which receipts count: fully claimed only
A receipt in a group **counts only once every row is claimed** and none of its money is left unassigned (rule U-G3). Until then it adds **nothing** to anyone. Not to the payer's *paid*, not to anyone's *share*.

Why wait? A half-claimed receipt has no right answer yet. If it counted early, someone has to carry the unclaimed items. Putting them on the payer is unfair, and splitting them among everyone is a guess. Either way, everyone's balance and the suggested payments would change again when the last item is claimed, maybe after people already paid. Waiting means every number you see is final for the costs it includes.

The group shows what it's waiting for, for example "Ana's receipt: Soda left to claim". Settle up shows "Balances don't include Ana's receipt yet: Soda left to claim" above the suggestions. Any member can finish the receipt by assigning the item to whoever had it (`assign_item`).

The same rule keeps out a receipt where every item is $0.00 but the total isn't (all tax, nothing to spread it over: rule Z from [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md)).

### Turning nets into payments: greedy simplification
Once everyone has a net, the app suggests payments that bring every net to 0. It uses a simple **greedy** method (`simplify`):
1. Take the person **owed the most** (the largest net) and the person who **owes the most** (the most negative net).
2. The one who owes pays the other the smaller of the two amounts.
3. That brings at least one of them to exactly 0. Repeat until everyone is at 0.

Each round settles at least one person. So with `k` people whose net isn't 0, you get **at most `k − 1` payments**.

**Ties go to the lower user id.** If two people are both owed $5.00, the one whose id sorts first (plain character order) is picked first. So every phone gets the same list in the same order, no matter what order the data arrived in.

Greedy is not always the fewest possible payments. Finding the true minimum is a much harder problem (NP-hard). It's left for later (plan v2).

**It can route money between people who never shared a cost.** That's correct, but it surprises people. Example:
- Ana paid $20 for Ben's dinner. Ana +20, Ben −20.
- Cy paid $20 for Ana's taxi. Cy +20, Ana −20.
- Ana's net is now 0. Ben −20, Cy +20.
- The suggestion is **"Ben pays Cy $20"**, even though Ben and Cy shared nothing.

It works because balances are group-wide. Ben owes Ana, Ana owes Cy, so Ben paying Cy directly settles both debts with one payment instead of two. "Who paid what" shows each person's costs, so people can see why.

### Hiding 1¢ leftovers: `GROUP_IGNORE_CENTS`
Rounding can leave someone a cent or two off. Asking a friend to send $0.01 is noise. So a suggested payment is **hidden** when both of these are true:
- it is `GROUP_IGNORE_CENTS` (1¢) or less, **and**
- **both** people's |net| is within 1¢.

Examples (from the spec's criterion 6):
- Ana +1¢, Ben −1¢: the 1¢ payment is hidden. Both read "You're settled up".
- Ana +1¢, Ben +1¢, Cy −2¢: **both** 1¢ payments are shown, because Cy is 2¢ off.

`isSettledUp(net)` (|net| ≤ 1¢) is the one rule for "You're settled up" on every screen. "Who paid what" still shows the exact cents. The value 1 is a starting value, waiting for the user's look (GR-3). Setting it to 0 shows every cent.

### Equal splits: largest-remainder rounding
An expense split **Equally** among chosen members uses the same `allocate` as bills (see [money and rounding](money-and-rounding.md)). Everyone gets the amount divided by the number of people, rounded down. The leftover cents go one each to the first people **in user-id order**.
- $9.00 among Ana, Ben and Cy: $3.00 each, no leftover.
- $10.00 among the same three: $3.34, $3.33, $3.33. The extra cent goes to whoever's id sorts first. It doesn't go to the payer (GR-4).

The database computes the stored cents itself, with `private.allocate`, the same algorithm. It sorts ids with `collate "C"`, which matches JavaScript's `<` on lowercase uuid strings, so both sides pick the same person for the leftover cent.

**Exact amounts** have no rounding. They must add up to the amount exactly, to the cent (GR-5).

### Worked example
Three people, ids in the order **A < B < C**. All amounts in dollars; the code uses cents. This example was checked against the real database by the live smoke test on 2026-11-27.

**1. Bill 1 moves into the group.** A paid $31.00. B had the Burger ($15.00), C the Salad ($10.00), A the Fries ($6.00). Before the bill was in the group, B had marked "I paid $15.00" via Venmo. When it moved in, that mark became a group payment from B to A ($15.00, `source = 'bill_mark'`).

| | paid | share | sent | received | net |
|---|---|---|---|---|---|
| A | 31.00 | 6.00 | 0 | 15.00 | **+10.00** |
| B | 0 | 15.00 | 15.00 | 0 | **0** |
| C | 0 | 10.00 | 0 | 0 | **−10.00** |

B already paid his share, so he's at 0. C still owes for her salad.

**2. Bill 2 is added, but it waits.** A paid $15.00: Pizza $12.00 (A) and Soda $3.00 (nobody yet). It isn't fully claimed, so it adds nothing. The nets stay +10.00 / 0 / −10.00, and the group shows "A's receipt: Soda left to claim".

**3. A member assigns the Soda to B.** Now bill 2 counts. A's *paid* goes up $15.00 and her *share* up $12.00 (+3.00). B's *share* goes up $3.00 (−3.00).
Nets: **A +13.00, B −3.00, C −10.00.**

**4. C pays a $9.00 cab, split equally** among A, B and C ($3.00 each). C: +9.00 − 3.00 = +6.00. A and B: −3.00 each.
Nets: **A +10.00, B −6.00, C −4.00.**

**5. B pays $9.00 for snacks, split by exact amounts:** A $5.00, B $4.00. B: +9.00 − 4.00 = +5.00. A: −5.00.
Nets: **A +5.00, B −1.00, C −4.00.** Sum: 5 − 1 − 4 = 0.

The full columns at the end:

| | paid | share | sent | received | net |
|---|---|---|---|---|---|
| A | 46.00 | 26.00 | 0 | 15.00 | **+5.00** |
| B | 9.00 | 25.00 | 15.00 | 0 | **−1.00** |
| C | 9.00 | 13.00 | 0 | 0 | **−4.00** |

**6. Simplify.**
- Round 1: A is owed the most (+5.00), C owes the most (−4.00). **C pays A $4.00.** Now A +1.00, C 0.
- Round 2: A +1.00, B −1.00. **B pays A $1.00.** Everyone is at 0.

Two payments for three people with a non-zero net, which is the `k − 1` bound.

### Changing the payer of a group bill (N9)
The host can still change who paid a group bill (`set_payer`), as long as the new payer is a group member. A group bill has no marks, so there's nothing to clear. What changes is who gets the bill's total as *paid*. **Old `bill_mark` payments stay with the person who actually received them**, because that money really went to them.

Take the end of the worked example and say the host changes bill 1's payer from A to C:
- A loses $31.00 of *paid*; C gains it. B's $15.00 payment to A stays a payment to A.
- New nets: **A −26.00, B −1.00, C +27.00** (still sums to 0).
- Suggestions: **A pays C $26.00, B pays C $1.00.**

That's right. C actually paid the restaurant, and A is holding B's $15.00 for a bill she didn't pay, so she passes it on. Money moves inside the group; nothing is lost.

### "Needs you" and "I wasn't part of this" (2026-11-27)
*Added with `docs/specs/2026-11-27-group-claim-status.md` (contracts C1 and C2, decisions GCS-1 … GCS-15).*

A receipt that waits for claims holds up everyone's balance. So the app reminds the people who haven't done their part yet.

**When a bill "needs you."** A group bill needs Ben when all three are true:
1. at least one row (an item or a discount row) has nobody on it;
2. Ben has no claim on any row of that bill;
3. Ben hasn't said "I wasn't part of this" for that bill.

**Claims win.** If Ben has claimed anything, the bill doesn't need him, whatever he said before. A bill with no rows needs nobody.

Examples, for Ana's dinner:

| Rows (who claimed) | Ben said "not part"? | Needs Ben? |
|---|---|---|
| Tacos: Ana. Nachos: nobody | no | yes |
| Tacos: Ana. Nachos: nobody | yes | no |
| Tacos: Ben. Nachos: nobody | no | no (he claimed) |
| Tacos: Ana. Nachos: Cy | no | no (nothing left) |
| Tacos: Ana and Ben (split). Nachos: nobody | no | no (a split counts as a claim) |

**"I wasn't part of this" never changes money.** It only stops the reminder for Ben. It adds nothing to and takes nothing from any share, net or suggested payment. In the first two rows above, the dinner still doesn't count for anyone until somebody claims the Nachos, whether Ben opted out or not. Somebody (maybe Ana, by assigning) still has to finish the receipt.

If Ben later gets a claim on that bill (he claims something, or Ana assigns him the Nachos), the database deletes his "not part" mark by itself. So the mark can't silently hide a reminder after he's back in.

**Home's group rows: five states, first match wins.** Each group row on Home shows one caption, about *you*:

| Order | When | Example | Color |
|---|---|---|---|
| 1 | one or more bills need you | "Claim your items on 1 bill" | amber (`warning`) |
| 2 | your net is below −1¢ | "You owe $12.50" | normal text |
| 3 | your net is above +1¢ | "You're owed $8.00" | green (`success`) |
| 4 | a receipt is waiting on other people's claims | "2 items left to claim" | muted |
| 5 | none of the above, and the group has at least one cost | "Settled up" | muted |

Otherwise (no costs yet, only all-$0 receipts waiting, or the group's read failed) the row shows the people count, "4 people".

Why this order: "claim your items" is the only one you can fix right now, and it's what holds everyone else up, so it comes first. Then your own money. Then other people's waiting.

Two things to notice:
- **Your net comes only from receipts that count.** "You owe $12.50" can show while a different receipt is still waiting on someone else. That receipt isn't in the $12.50 yet.
- **"Settled up" means you**, within 1¢ (`isSettledUp`), and nothing waiting. It doesn't mean every member is settled (GCS-6).

**Where you see it.** On the group screen, each bill that needs you gets a slight yellow tint, the caption "You haven't claimed anything here yet", and a separate "I wasn't part of this" link. Its row in Costs reads "Ana paid $77.33 · Claim your items". Inside a group bill, each unclaimed item is tinted until you claim or opt out. The tint is never the only cue: words always go with it.

### Deleting needs everyone settled (2026-11-28)
*From [ADR 0027](../decisions/0027-delete-group.md) (contract S, A2.10).*

Any member can delete a group, but only when `canDeleteGroup` in `lib/groupView.ts` says ok. It asks two questions, in this order:
1. **Is any receipt waiting?** Then `receipts_waiting`: "Every receipt has to be fully claimed before you can delete this group."
2. **Is any member more than 1¢ off?** (`isSettledUp` on every net, not just yours.) Then `not_settled`: "Everyone has to be settled up before you can delete this group."

Why waiting comes first: a waiting receipt adds **nothing** to anyone's balance. So every net can read $0 while Ana's $45 dinner is still waiting. If deleting checked only the nets, Ana would lose the $45 people owe her for it.

It reads `groupMath` and does no arithmetic of its own, so it can't disagree with the balances on screen. Note the difference from Home's "Settled up", which is about **you** only.

The database can't check balances (they live only here), so it checks two cheaper things instead: that nothing in the money changed since your screen loaded (a fingerprint, see [stale-state checks](stale-state-checks.md)), and that no receipt is waiting, with the same rule as `groupBalances` (`private.group_bill_waiting`). Building that SQL rule found one case the old helpers missed: an **even-split** receipt where nobody claimed an item but the extras (tax, tip) aren't $0. Nobody is there to carry the extras, so lib says waiting, and now SQL does too.

## Why it matters here
A trip has many costs and many payers. Settling every bill separately means lots of small Venmo payments that often cancel out (Ben pays Ana for dinner while Ana pays Ben for brunch). One net per person, then a short list of payments, is what people actually want at the end of a trip.

Two SplitIt rules make this safe:
- **Money is integer cents, and every split adds up exactly.** That's what makes "the nets sum to $0" true, not just roughly true.
- **The math lives in one place.** The database stores costs and payments, and checks each one (amounts, members, who may write). It never computes a balance (GR-2). Balances, which receipts count, and the suggestions are computed only in `lib/` (C-G1 to C-G3). One copy means it can't disagree with itself. These rules are one-sided on purpose, so don't "fix" that by adding a SQL copy.

## How we use it
- **Read:** one call, `group_snapshot` (first defined in `supabase/migrations/20261127061004_group_snapshot.sql`; re-created in `20261127150000_bill_not_part.sql`, which adds `me.not_part_bill_ids`), returns the group's members, bills (rows and claims), live expenses and live payments in one statement. `fetchGroupSnapshot` in `lib/groups.ts` parses it strictly: any bad id or amount fails as a network error, never a partial balance. `balanceInputOf` turns it into the balance input.
- **Balances:** `groupBalances` in `lib/groupBalance.ts`. It returns each member's paid / share / sent / received / net, plus `counting` (bills that count) and `waiting` (bills that don't, with the reason and the unclaimed row ids). It uses `computeShares` and `sharesComplete` from `lib/split.ts`, the same split math as a normal bill. `netsOf` turns the result into the map `simplify` takes.
- **Suggestions:** `simplify`, `isSettledUp` and `GROUP_IGNORE_CENTS` in `lib/simplify.ts`. `simplify` returns `full` (every payment) and `shown` (without the hidden 1¢ ones).
- **Screens:** `groupMath`, `groupScreen` and `waitingLines` in `lib/groupView.ts`; `groupSettle` and `whoPaidWhat` in `lib/groupSettleView.ts`. Screens do no money arithmetic themselves (spec criterion 56 checks this with a grep).
- **Equal and Exact splits:** `equalPreview` and `exactCheck` in `lib/groupExpense.ts` (preview), `private.allocate` in `supabase/migrations/20261126085945_group_expenses.sql` (stored cents).
- **Marks becoming payments:** `attach_bill_to_group` in `supabase/migrations/20261127060131_group_bills.sql`.
- **"Needs you" and "not part":** the rule is written once, `billNeedsViewer` in `lib/groupClaimStatus.ts`. Home and the group screen reach it through `rowsOfSnapshotBill` / `snapshotBillNeedsViewer`; the bill screen through `rowsOfBillData`, with the claims it's showing (so a tap on Claim clears the tint before the save lands). The copy is `GROUP_CLAIM_COPY` in the same file. Home's five states: `groupHomeStatus` in `lib/groupHomeView.ts`. The group screen's rows: `waitingLines` / `groupScreen` in `lib/groupView.ts` (`needsMe`, `notPart`), drawn by `components/GroupWaitingRow.tsx`. The bill screen: `useNotPart` in `lib/useNotPart.ts` and `components/NotPartLine.tsx`. Writes: `setNotPart` and `fetchNotPart` in `lib/groups.ts`, which call `set_not_part` and read `bill_not_part` ([row level security](row-level-security.md)). Tests: `lib/groupClaimStatus.test.ts` (the C1 cases through both adapters), `lib/groupHomeView.test.ts`, `supabase/tests/database/bill_not_part.test.sql`.
- **Tests:** `lib/groupBalance.test.ts` and `lib/simplify.test.ts` run the spec's worked examples W1–W7 (fixtures in `test-utils/groupFixtures.ts`) and a property test over 1,000 random groups. It checks that the nets sum to 0, that shuffling the input never changes the answer, and the `k − 1` bound.

## Pitfalls
- **Counting a receipt before it's fully claimed.** It makes everyone's balance a guess that changes later. Use `groupBalances`' `counting` / `waiting`, never your own check.
- **Getting the signs of payments backwards.** Sending money *raises* your net (you're less in debt). Receiving *lowers* it. `net = paid − share + sent − received`.
- **Computing money in a component.** Two screens with their own formulas will disagree by a cent one day. Use the view models.
- **Expecting the database to check balances.** It doesn't (GR-2). It checks each cost and payment, not the totals.
- **Expecting the fewest possible payments.** Greedy gives at most `k − 1`, not always the minimum.
- **Being surprised by "Ben pays Cy" when they shared nothing.** That's correct (see above). Show "Who paid what" instead of changing the math.
- **Treating "You're settled up" as exactly $0.** It means within 1¢ (`isSettledUp`). "Who paid what" shows the exact cents.
- **Sorting user ids differently on the two sides.** JavaScript `<` on lowercase uuid strings and SQL `collate "C"` agree. A locale-aware sort may not, and then the leftover cent goes to a different person in the preview than in the database.
- **Assuming a share is never negative.** A claimed discount bigger than someone's items makes their receipt share negative ([ADR 0017](../decisions/0017-claimable-discounts.md)). The net still sums to 0.
- **Taking a bill out of a group while its converted payments are live.** The database refuses (`has_bill_payments`, GR-9). Undo those payments first, or the bill would ask for the same money again.
- **A receipt that stops counting.** If someone unclaims an item after people paid, the whole receipt drops out and every balance swings (worked example W7 in the spec). That's expected; the waiting notice explains it.
- **Treating "I wasn't part of this" as a money action.** It only hides a reminder. Never drop an opted-out person from a split, or count a receipt because "everyone left either claimed or opted out". The receipt still needs every row claimed.
- **Judging "safe to delete" from the nets alone.** A waiting receipt is $0 in every net. Check `waiting` first, as `canDeleteGroup` does.
- **Writing the "needs you" check a second time.** Home, the group screen and the bill screen must agree. Call `billNeedsViewer` through an adapter; don't write your own "has nobody claimed and not opted out" test in a component.

## Check yourself
1. In the worked example, why is B's net 0 after bill 1, even though he's never paid anyone inside the group app?
2. Bill 2 has Pizza (A) and an unclaimed Soda. What does it add to A's *paid* and to anyone's *share*, and why?
3. Nets are Ana +3.00, Ben +3.00, Cy −6.00. Ana's id sorts before Ben's. What does `simplify` suggest, and in what order?
4. Nets are Ana +1¢, Ben −1¢. What does Settle up show each of them, and what does "Who paid what" show?
5. $10.00 is split equally among three people. Who gets $3.34, and why not the payer?
6. Explain why the nets always add up to exactly $0.
7. Ben taps "I wasn't part of this" on Ana's dinner, where the Nachos are still unclaimed. Does the dinner now count toward balances? What does Ben's Home row say if his net is −$12.50?
8. Ben opted out of the dinner, then Ana assigns him the Nachos. Does the dinner need Ben now? What happened to his "not part" mark, and why is that the right behavior?
9. Every member's net is $0, but Ana's receipt still has the Soda unclaimed. Can anyone delete the group? What would go wrong if `canDeleteGroup` checked only the nets?

## Learn more
- Largest remainder method: https://en.wikipedia.org/wiki/Largest_remainder_method
- PostgreSQL, collation support (why `collate "C"` sorts by plain byte order): https://www.postgresql.org/docs/current/collation.html
- PostgreSQL, foreign keys and `ON DELETE RESTRICT` (why group history blocks account deletion today): https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
- MDN, `Number.isSafeInteger` (the check every sum goes through): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isSafeInteger
- Related notes: [money and rounding](money-and-rounding.md), [stale-state checks](stale-state-checks.md), [database functions](database-functions.md), [people and membership](people-and-membership.md).
