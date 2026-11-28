# Who pays whom: the payments ledger and routes

*Added 2026-11-27 with the Who paid slice ([ADR 0023](../decisions/0023-several-payers.md), spec `docs/specs/2026-11-26-who-paid.md` with Amendments A1 and A2). Read [money and rounding](money-and-rounding.md) first; [group balances](group-balances.md) uses the same greedy.*

## The idea
When one person pays the restaurant, settling up is simple: everyone else pays that person their share. When **several** people paid, or the payer changed after someone already paid, you need three ideas.

**1. A ledger: write down every money movement, and never erase one.** A *ledger* is a list of entries like "Priya sent Sam $12.00 via Venmo, at 12:03". Once money has moved, it has moved. If the app later learns something new ("actually Hana paid the restaurant, not Sam"), it doesn't delete Priya's entry. It works out what to do *next*, given everything that already happened. That's the same reason a bank statement never deletes a transfer: it adds a new one.

**2. A position per person: how far from even they are.**

> position = paid for the bill + sent − received − share

- *Paid for the bill:* what they paid the restaurant (0 for most people).
- *Sent / received:* the ledger entries to and from them.
- *Share:* what they owe for what they had (`computeShares`).

Positive means "I'm owed money". Negative means "I owe money". The positions of everyone on a bill always add up to exactly 0, because the shares add up to the bill total (largest-remainder rounding) and the paid amounts do too (rule W, below). Every entry moves the same cents out of one position and into another.

**3. Routes: the remaining payments that bring everyone to 0.** Finding the true fewest payments is NP-hard (a known result, not proven here: it's like splitting a set of numbers into groups that each sum to 0). So we use a simple **greedy** that's fast and always gives the same answer:

1. Find the smallest position (the biggest debtor) and the largest (the biggest creditor). Ties go to the lower user id.
2. The debtor pays the creditor as much as closes one of them: `min(−debtor, creditor)`.
3. Repeat until everyone is at 0.

Each step brings at least one person to 0, so it uses at most (people with a non-zero position − 1) payments.

**4. Routes that stay put.** Greedy has one problem. If C pays *part* of a route, the positions change, and running greedy again might send D to someone else. The user's rule was: "after payments made unless bill is changed whom you pay shouldnt be changed". So each payment carries a **plan key**: a short fingerprint (16 hex characters) of the money state the payer's screen showed (who paid how much, and everyone's share). When the app works out routes:
- payments made under the **current** key were made along today's routes, so they only reduce the route they're on;
- payments made under **another** key (or none) are history: they're folded into the positions, and the routes are planned again.

Paying never moves anyone else. A real change to the money (a price, a claim, who paid) gives a new key and a fresh plan.

## Why it matters here
**The user's example (T0).** A $40.00 bill. Shares: You $14.00, Sam $14.00, Priya $12.00. Sam was the payer, and Priya sent Sam $12.00. Then the host says "actually, I paid".

The old rule ([ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md) §3) cleared Priya's mark and asked her to pay again, to You. But her $12.00 really is in Sam's Venmo. The ledger gets it right:

| Person | paid for bill | sent | received | share | position |
|---|---|---|---|---|---|
| You | 4000 | 0 | 0 | 1400 | **+2600** |
| Sam | 0 | 0 | 1200 | 1400 | **−2600** |
| Priya | 0 | 1200 | 0 | 1200 | **0** |

Greedy: Sam (−2600) pays You (+2600) $26.00. Done. Priya owes nothing; her card says "Your $12.00 to Sam still counts. Sam passes it on". Sam's card says "Includes $12.00 Priya sent you." That's the user's own answer: "sam should pay priya that $12 since money movement was down from someone to sam and now sam owes".

**Two payers, one person owes both (T1).** Total $100.21. A paid $60.00, B paid $40.21. Shares A $33.41, B $33.40, C $33.40.
- Positions: A 6000 − 3341 = **+2659**, B 4021 − 3340 = **+681**, C **−3340**.
- Greedy: C pays A $26.59 (A is the largest), then C pays B $6.81.
- C has two Venmo links, one per card. Only the first card's Pay button is filled until it's marked, so there's one main action at a time.

**Why stable routes matter (T6).** A paid $60, B paid $40. Shares: A $0, B $0, C $50, D $50.
- Plan: C→A $50, D→A $10, D→B $40.
- C sends A $20 from that screen (current key). Now C→A shows $30 left, and D still sees exactly D→A $10 and D→B $40.
- If the same $20 had been made under an **old** key, the app would re-plan around it: C→A settled at $20, C→B $30, D→A $40, D→B $10. That re-plan is right after a bill change, but it would be confusing after a simple payment. That's what the key prevents.

**A bill change after someone paid (T7).** A and B paid $50 each; shares $25 × 4; D paid B $25. Then the host edits a price so C's share is $24 and D's is $26 (new key). Positions: A +2500, B 0 (B received D's $25), C −2400, D −100. Routes: C→A $24, D→A $1. D→B stays settled. Nobody is asked for a refund.

## How we use it
**Storage** (database, [ADR 0023](../decisions/0023-several-payers.md)):
- `bill_payers (bill_id, user_id, paid_cents)`: only on split bills. No rows means one person paid the whole bill (`bills.payer_id`).
- `bill_payments`: one row per movement (`from_user`, `to_user`, `cents`, `method`, `plan_key`, `recorded_at`, `recorded_by`). Never updated; see [row level security](row-level-security.md) and [database functions](database-functions.md).
- `bill_payment_flags`: "Not received" flags.

**Rule W: paid amounts add up exactly.** `validateSplit` (`lib/payers.ts`) and `set_payers` both refuse a split unless Σ paid = the bill total, tolerance 0, 2 to 50 people, each 1–99,999,999¢. If the host later edits the total, the split is **stale**: `payersState` reports the gap, `ledgerSettlePlan` returns `blocked_payers`, and `mark_paid` refuses with `payers_stale` until the host fixes it.

**Largest remainder shows up twice:**
- in the shares, from `computeShares` ([money and rounding](money-and-rounding.md));
- on the Who paid page's Percent mode: `percentsToCents` (`lib/payersForm.ts`) turns percentages into cents so 100% is exactly the total. Example: $100.21 at 50% / 50% is 5010.5¢ each. Floors give 5010 + 5010 = 10020, and the spare cent goes to the first row (ties to the earlier row): $50.11 and $50.10. Switching from $ to % keeps each row's exact cents (`keptCents`), so switching back never loses a cent.

**A pair's mark (contract P).** The screens still show one "mark" per pair ("Sent via Venmo · $15.10"). It's worked out from the entries between two people, in order of (`recorded_at`, `id`): the running net, and the time the latest positive run started. `pairState` in `lib/transfers.ts` and `private.pair_state` in SQL implement it, tested on the same table (P1–P6).

**The plan** (`lib/transfers.ts`, pure, integer cents):
- `currentPlanKey`: the key the plan uses. With no history it's `planKey(mode, lead, payers, shares)`. It also changes when the set of older payments changes (an undo, a stale-screen payment). The 2,000-run simulation found that without this, current payments could stay pinned to routes that no longer exist (WP-51).
- `planRoutes`: positions from the history, then three steps:
  1. **pins:** a non-payer with a negative share is paid back by the lead "outside the app", as before;
  2. **refunds:** a non-payer who overpaid is refunded by the person they paid, repeated until none are left;
  3. **the greedy.**
- `settleTransfers`: turns routes into **pairs** for the screens. Each pair has `targetCents` (what should go from one to the other), `paidCents` (what has, net), `remainingCents`, the mark and the difference (contract D from [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md), ±1¢ ignored). It also gives **provenance**: who holds money that isn't theirs (`passed_on`), and who is getting their own money back (`returned`, T13). The "Your $12.00 still counts" lines come from it. Nothing about them is stored.
- `transfersFromReadyPlan`: today's single-payer plan in the same shape, so `balanceFor` reads every plan the same way.

**The plan for a bill** (`lib/settle.ts`): `ledgerSettlePlan` picks one of these:
- `blocked_payers` (stale split), checked first, as the database does;
- today's `ready` / `early` plan, when there's one payer and every payment involves them (so single-payer bills behave exactly as before);
- otherwise `routes`, with the pairs and the key.

`balanceFor` gives Home "you owe / you're owed" from any of them (`lib/homeSections.ts`).

**Stamping the key.** Settle up sends the plan's key as `p_plan_key` with every `mark_paid` and `settle_difference`. The database only checks the format (16 lowercase hex, or null).

**Changing who paid** (contract M): `paymentsMovedBy` (`lib/payers.ts`) lists the payments whose recipient is leaving the payer set. The confirm names them ("Pat already paid Sam … Sam will pass it on to Dee"), built by `pickerDecision` / `splitSaveDecision` in `lib/settleView.ts`. The database logs the same list in the `payers_changed` event.

**Tests:** `lib/transfers.test.ts` (P1–P6, worked examples T0–T13, and a seeded simulation of 2,000+ random bills with random payments, undos and bill changes that checks every position ends at 0, paying changes only its own pair, the output doesn't depend on input order, and one payer gives today's plan). The suite was shown to fail on three deliberate bugs (no stability step, no refunds, a 1¢ error). `lib/settle.regression.test.ts` checks 1,000 single-payer bills against a fixture recorded before the change.

## Pitfalls
- **Clearing payments when who paid changes.** That was the old rule. After Sent via Venmo, a mark is usually real money. Deleting it doesn't un-send it, and the person gets asked to pay twice.
- **Updating a ledger row instead of adding one.** A pay-back is a new row in the other direction. Only Undo and "Not received" delete entries, because they mean "this never happened".
- **Re-running greedy after every payment.** People who already paid would see their route move. Stamp payments with the plan key, and let current-key payments only reduce their own route.
- **Planning from the shares alone.** Positions must include every earlier payment, or money already in someone's Venmo is counted twice.
- **Comparing timestamps with `Date.parse`.** `recorded_at` has microseconds, and `Date` keeps milliseconds. Two entries a few microseconds apart would tie in the wrong order. `timestampMicros` in `lib/transfers.ts` turns the exact string into whole microseconds, and both sides order by (`recorded_at`, `id`).
- **Using `now()` to time entries written in one transaction.** `now()` is the transaction's start time, so all of them get the same value. The table uses `clock_timestamp()`, which is the actual time of each insert.
- **Letting a 1¢ gap through on paid amounts.** Typed amounts have no rounding, so rule W is exact (tolerance 0), on both sides.
- **Trusting the key as security.** The app computes it and the database only checks its format. A wrong key can only make routes re-plan; it can never change what anyone owes, because positions always count every payment.
- **Promising "at most n − 1 payments".** That holds for the greedy step alone. Refunds can add a few.
- **Settling early on a split bill.** Early shares don't add up to the total, so the positions wouldn't sum to 0. Rule E′ blocks it in both `maySettle` and `private.settle_state`.

## Check yourself
1. In T0, work out each person's position. Why does Priya owe nothing, and why does Sam pay $26.00, not $14.00?
2. In T1, why does C get two Venmo links? Which one is filled first, and why only one?
3. In T6, C pays A $20.00. Why does D's screen not change? What would D see if C's payment had an old plan key?
4. The host renames "Fries" to "French fries". Does the plan key change? Does anyone's route move?
5. The host raises the tip after A and B split the paying $60.00 / $40.21. What does Settle up show, and what does `mark_paid` answer until it's fixed?
6. On the Who paid page, a $100.21 bill is set to 50% / 50%. What cents does each row get, and why does that add up exactly?

## Learn more
- Largest remainder method: https://en.wikipedia.org/wiki/Largest_remainder_method
- Fowler–Noll–Vo (FNV) hash, which the plan key uses: https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function
- Double-entry bookkeeping (why ledgers add entries instead of editing them): https://en.wikipedia.org/wiki/Double-entry_bookkeeping
- PostgreSQL, current date/time (`now()` vs `clock_timestamp()`): https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT
- PostgreSQL, window functions (how `private.pair_state` keeps a running net): https://www.postgresql.org/docs/current/tutorial-window.html
- MDN, `Date` (millisecond precision): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
