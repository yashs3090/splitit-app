# 0023: Several payers per bill: a payments ledger, the fewest payments, stable routes

**Status:** Accepted (2026-11-27, spec `docs/specs/2026-11-26-who-paid.md` with Amendments A1 and A2; A2 wins where they differ). Built (Tasks 1–11, X2 and the "Who paid?" page), approved in two review rounds, QA passed on web (A-50(c), the $ / % switch losing cents on bills over $100, found by QA and fixed), live check 41 of 41. **Amends [0015](0015-settling-one-payer-self-reported-marks.md)** (one payer, and "changing the payer clears every mark") and **[0021](0021-settling-early-and-paying-differences.md)** (its difference rule, contract D, now applies to each pair of people, and split-paid bills can't settle early). Notes [0024](0024-sent-via-venmo-and-payment-methods.md)'s marks and flags, which moved to new tables. Decisions still open for the user's look are in `docs/decisions-to-review.md` ("2026-11-26 · Who paid", WP-51, WP-52 and the WP-PAGE rows). The user checks U1–U3 aren't part of QA; their status wasn't checked by this docs task.

*Numbering note:* the number 0023 was reserved with a stub on 2026-11-26 (the Groups spec named it, and this spec calls it "the split-paying and transfers ADR"). This file fills that stub in place.

## Context
Before this, a bill had **one payer** (`bills.payer_id`). Everyone else paid that person their share ([ADR 0015](0015-settling-one-payer-self-reported-marks.md)). The host could change the payer only on Settle up, and the change **cleared every "I paid" mark**, because a mark said "I paid *that* person".

The user asked for two things (2026-11-26):
- change the payer from the bill itself, even right after scanning;
- let several people share the paying: "I paid $60, Sam paid $40.21".

Two facts made the old "clear the marks" rule wrong:
- Since [ADR 0024](0024-sent-via-venmo-and-payment-methods.md), many marks are real money. Opening Venmo records "Sent via Venmo". Clearing that mark doesn't un-send the money.
- With several payers, one person can owe two people. A single mark column per person can't say who it was to.

**The user's example (T0).** A $40.00 bill. Shares: You $14.00, Sam $14.00, Priya $12.00. Sam was the payer, and Priya sent Sam her $12.00. Then the host says "actually, I paid". Under the old rule, Priya's mark is cleared and she's asked to pay again. The user's answer: "then sam should pay priya that $12 since money movement was down from someone to sam and now sam owes". Read back and confirmed: Priya is done, and Sam pays You $26.00 (his $14.00 share plus Priya's $12.00).

## Options
| Question | Options considered | Chosen |
|---|---|---|
| How is who-paid stored? | Always store rows (one row = whole total); drop `payer_id`; **keep `payer_id` and add `bill_payers` rows only when split** | Keep `payer_id` (the one payer, or the "lead" of a split) and add `bill_payers` only in split mode (WP-2). Old bills need no migration, and a one-person bill can't go stale when its total changes |
| What happens to payments when who paid changes? | Clear marks to anyone who's no longer a payer (the first spec, WP-7); lock who paid once anyone has paid; **keep every payment and work out the rest from it (a ledger)** | The ledger (the user, 2026-11-26) |
| How are payments stored? | Mark columns per person (as before); one row per pair with a running net (`bill_marks`, the first spec); **one row per money movement (`bill_payments`)** | One row per movement (WP-26). Stable routes need to know *when* each payment was made, and a running net loses that |
| Who pays whom? | Each non-payer pays exactly one payer, and paid people are "sticky" (the first spec, WP-4); everyone through the lead; **the fewest payments overall** | Fewest payments, with routes that don't move when someone pays (the user, 2026-11-26) |
| How do routes stay put? | A server-side bill version (triggers on claims, items, bills and payers); read the Activity log; store the plan; **stamp each payment with a fingerprint of the bill state the payer saw (a plan key)** | The plan key (WP-27). See Decision §4 for why the others lost |
| Total edited after a split | Give the difference to the person who paid most; refuse the edit; **pause settling until the host fixes the amounts** | Pause (WP-9, kept by the user) |
| Where who paid is edited | A bottom sheet (the spec's A1.5 design); **a separate page** | A page, `/bills/<id>/payers` (the user, 2026-11-27, A2.1) |

## Decision

### 1. One person, or several people with amounts (contract W)
- **One person:** the bill has no `bill_payers` rows. `payer_id` paid the whole bill. That amount is never stored; it's always the current total, so it can't go stale (WP-10).
- **Several people:** 2 to 50 rows in `bill_payers (bill_id, user_id, paid_cents)`. Exactly one row is never valid.
- **The amounts must add up to the bill total exactly.** Tolerance 0, the same rule in `validateSplit` (`lib/payers.ts`) and `set_payers` (WP-11). Typed amounts have no rounding, so there's no reason to allow a 1¢ gap.
- **Every payer is on the bill** (a deferred foreign key to `bill_participants`, the same mechanism as 0015's invariant).
- **The lead** is the payer with the largest amount; a tie goes to the lower user id. Only the database works it out, and stores it in `payer_id` (WP-21). So every older reader of `payer_id` still sees one sensible person.
- **Only the host** changes who paid (`set_payer` for one person, `set_payers` for several).

### 2. A payments ledger: payments are never cleared
Every recorded payment is a real money movement. It's one row in `bill_payments`: from, to, cents, method, plan key, time.
- **Rows are never updated.** A trigger refuses any `UPDATE` with `42501 payments_are_immutable`, whoever runs it.
- **Changing who paid deletes no payment** (WP-31). `set_payer` lost its `p_expected_cleared` token, because there's nothing to clear.
- **Two things do delete entries:** Undo and "Not received". Both mean "this money never moved", so they delete the current mark's entries (WP-33). A pay-back is a real movement, so it's a new row in the other direction, not a deletion.
- **A pair's "mark"** (what the screens show: "Sent via Venmo · $15.10") is worked out from the entries, never stored (contract P, `pairState` in `lib/transfers.ts` and `private.pair_state` in SQL, tested on the same table P1–P6).
- "Not received" flags moved to `bill_payment_flags`.

### 3. Each person's position
For each person on the bill:

> position = paid for the bill + sent − received − share

- "Paid for the bill" is what they paid the restaurant (0 for most people).
- "Share" comes from `computeShares` (largest-remainder rounding, so the shares add up to the total).
- Positions always add up to 0. The code checks this and throws if not.
- Positive means the person is owed money; negative means they owe.

In T0, after the host becomes the payer: You 4000 − 1400 = **+2600**. Sam 0 + 0 − 1200 − 1400 = **−2600** (he received Priya's $12.00). Priya 0 + 1200 − 0 − 1200 = **0**.

### 4. The fewest payments, and routes that stay put
**Routes.** The remaining payments bring every position to 0. The algorithm is the same greedy as Groups (GR-3): the person with the smallest position pays the person with the largest, as much as closes one of them, ties to the lower id, until everyone is at 0. Before that, two fixed steps keep single-payer bills exactly as they were:
- a non-payer with a negative share is paid back by the lead "outside the app" (WP-30, as before);
- a non-payer who has overpaid is refunded by the person they paid (WP-29).

The greedy uses at most (people with a non-zero position − 1) payments. The true minimum is NP-hard to find (a known result, not proven here), so nothing promises better. One person may owe two people, which the user accepted.

**Stability.** The user also said: "after payments made unless bill is changed whom you pay shouldnt be changed". Greedy alone breaks that. If C pays part of a route, the positions change, and greedy could send D somewhere else. So every payment is stamped with a **plan key**: 16 hex characters, a fingerprint of the money state (who paid how much, everyone's share) the payer's screen showed.
- Payments under the **current** key were made along today's routes. They only reduce the route they're on. Nothing else moves.
- Payments under **another** key (or none, like the marks copied from before) are history. They're folded into the positions, and the routes are worked out again from there.

So paying changes nothing else, and any real bill change (a share, a paid amount) gives a new key and re-plans everything from the money. An item rename doesn't change any share, so it doesn't re-route anyone. Example T6: A paid $60, B paid $40, C and D owe $50 each. Routes: C→A $50, D→A $10, D→B $40. C pays A $20 with the current key: C→A shows $30 left, and D's two routes don't move. The same $20 under an old key would re-plan to C→B $30, D→A $40, D→B $10.

**Why not the other ways of keeping routes stable** (WP-27):
- A server-side bill version would need triggers on claims, items, bills and payers that update one row on every claim tap: extra locking, and it would tangle with Groups' claim triggers.
- The Activity log doesn't record every money-relevant edit (a discount's "applies to" change writes no event).
- A stored plan would have to be written by the app anyway, because the database can't compute shares ([ADR 0021](0021-settling-early-and-paying-differences.md) §3).

**The current key is a little more than A1's fingerprint** (WP-51, found by the 2,000-run simulation in Task 2b; open for the user's review). A1's key didn't change when an older payment was undone or a stale-screen payment arrived, so current-key payments could stay pinned to routes that no longer existed. `currentPlanKey` also covers *which* payments are history. With no history, it equals the plain fingerprint. Refunds also repeat until none are left (WP-52).

**The app stamps the key** (`ledgerSettlePlan` returns it; Settle sends it as `p_plan_key` on every `mark_paid` and `settle_difference`, one-payer bills too, WP-T10-2). The database only checks the format (`^[0-9a-f]{16}$` or null). A wrong or forged key can only make routes re-plan. It can never change what anyone owes, because positions always count every payment.

### 5. Changing who paid moves payments; it doesn't clear them (contract M)
When a payer leaves the payer set, the payments they received still count. They now hold money that isn't theirs, so their position goes down and they pass it on (T0: Sam pays You Priya's $12.00 as well as his own share).
- `paymentsMovedBy` (`lib/payers.ts`) lists those payments; the database writes the same list into the `payers_changed` event's `moved`.
- The host's confirm says it plainly: "Pat already paid Sam. If you switch to Dee, Pat's $9.00 still counts. Sam will pass it on to Dee." The button is primary, not danger, because nothing is lost (WP-32).
- The people affected are told on their own cards, worked out from the plan, nothing stored (WP-38): Priya reads "Your $12.00 to Sam still counts. Sam passes it on to Hana." Sam's card reads "Includes $12.00 Priya sent you."
- Not-received flags to someone who's no longer a payer are deleted (0024's rule).

### 6. When the total changes after a split (stale)
If the host edits the total, the split amounts no longer add up. That's **stale**. Settling pauses: `mark_paid` and `settle_difference` refuse with `22023 payers_stale`, `ledgerSettlePlan` returns `blocked_payers`, and the host sees "Who paid doesn't match the new total · Fix". Nobody guesses who paid the extra tip (WP-9). Payments already made still count once it's fixed. The stale check runs before the all-$0 check on both sides (S8).

### 7. Rules that keep it safe
- **No settling early on a split-paid bill (rule E′, WP-8).** Early shares don't add up to the total, so positions wouldn't sum to 0. One-person bills keep settling early as in 0021. `private.settle_state` and `maySettle` give the same answers on the same table (E1–E4).
- **Group bills keep one payer.** `set_payers` refuses a bill in a group (`22023 in_group`), and moving a split-paid bill into a group is refused (`22023 split_paying`). Groups settle through group payments ([ADR 0022](0022-groups.md)), and their math assumes one payer per bill.
- **Leaving (rule L3, WP-15, WP-36).** You can't leave, and the host can't remove you, while you're one of the payers, or while any pair involving you hasn't netted to $0. Someone fully paid back may leave. The same rule is in `private.is_removable` and `lib/membership.ts` (table L1–L7).
- **A deleted account (WP-16).** If a payer's account is deleted, the bill goes back to one person, the host. That person's own payments go with them (counted as `lost` in the event); everyone else's are kept. The trigger runs **before** the delete, because foreign-key cascades fire before any `AFTER` trigger and would remove the payments before they could be counted (eng review B3).

### 8. The "Who paid?" page (A2, the user's decision 2026-11-27)
Who paid is edited on its own page, `app/(app)/bills/[id]/payers.tsx`, opened by "Change" on the bill's "Paid by…" line and on Settle up. It replaced the spec's bottom sheet.
- One row per person and the bill total at the bottom. The host starts at 100%.
- An **Amount ($) / Percent (%)** switch. Percentages turn into cents by largest remainder, so 100% is exactly the total. Switching units keeps each row's exact cents (`keptCents`), so a bill over $100 never loses a cent (QA A-50(c)).
- Save works only when the amounts add up exactly and something changed. One person with the whole bill saves through `set_payer`; two or more through `set_payers`.
- A row whose percentage rounds to $0.00 is refused (WP-R10).
- One save at a time; requests give up after 15 s; a late answer that turns out to have saved says "Your earlier save went through." ([stale-state checks](../concepts/stale-state-checks.md)).

## The user's decisions
**2026-11-26 (spec "User decisions" and A1.1):**
1. The payer can be changed from the bill itself, including right after scanning.
2. Several people can share the paying, with editable amounts.
3. It's rare, so it's a quiet line, not a step in the default flow.
4. **WP-7 → the ledger.** Recorded payments are kept; holders pass money on.
5. **WP-9 → kept.** Amounts must add up to the new total, settling pauses until then, and past payments keep counting.
6. **WP-4 → the fewest payments overall**, one person may pay two people, and routes change only when the bill changes.
7. The UX reviewer's recommendations U1–U7 were taken: "Change" (not "Edit"), "Paid by you" in lower case mid-sentence, amounts kept in the line, one filled button across several "You owe" cards, and a primary "Settle up" when you owe two or more people.

**2026-11-27 (Amendment A2):**
1. The editor is a separate page with a $ / % switch, not a sheet (A2.1, WP-53).
2. Copy: "Undo all $X" became "$X payment didn't go through", and the Home pill "Paid · $X back to you" became "You are owed $X" (A2.2, WP-54).
3. With several cards on Settle, each keeps its own Venmo / Cash chooser (WP-T10-3).

## How this relates to earlier ADRs
| Earlier ADR said | 0023 says |
|---|---|
| 0015 §1: one payer per bill | One payer, or 2–50 payers with amounts that add up exactly. `payer_id` is the one payer or the lead |
| 0015 §2: a mark is two columns on your participant row | A mark is worked out from ledger rows (`bill_payments`), one per money movement, per pair of people |
| 0015 §3: changing the payer clears every mark | Changing who paid clears nothing. Money a former payer received is passed on |
| 0015 §4: `set_payer` takes an expected-count token | `set_payer(bill, payer)` has no token; nothing it does can lose a payment |
| 0021: a difference is the gap between your share and your mark | The same rule (contract D, ±1¢ ignored), applied to each pair: the route's target vs what was paid on it |
| 0021: proportional bills can settle early | Still true for one-person bills. Split-paid bills wait until every item is claimed (E′) |
| 0024: marks and flags are columns on `bill_participants` | They're `bill_payments` and `bill_payment_flags` rows (0024's own amendment note says so) |

So 0015 and 0021 are amended, not superseded: self-reported payments, Venmo links, differences and early settling on one-person bills all stand.

## Consequences
- **Single-payer bills behave exactly as before.** A committed fixture of 1,000 seeded one-payer bills (`lib/__fixtures__/settle-single-payer.json`) must deep-equal the new code's output (`lib/settle.regression.test.ts`). The only strings changed in it are A2.2's two copy changes, checked by a reverse substitution.
- **Old app builds break after the push.** The migrations drop `bill_participants.settled_*` and `not_received_*`, `set_payer`'s 3-argument form and `unmark_paid`'s 2-argument form. An older web tab or phone build can't open bills or change the payer. So the hosted push order is fixed: **Sent via Venmo → Groups → Who paid, each in the same sitting as its app deploy**, with a database snapshot before the Who paid push (`docs/before-production.md` §4). Pushing is the user's call.
- **The client stamps the plan key.** It's an honor-system value like the marks. It can only change how routes are drawn, never the money (`docs/before-production.md` §8).
- **Split-paid bills can't settle early** (E′), and **group bills refuse split paying** (`in_group`, `split_paying`).
- **Someone can owe two people**, and a former payer may have to pass money on. Both are explained on their cards, not just in Activity.
- **Routes can cost a payment or two more than the true minimum**, and refunds can push past the n − 1 bound. That's the price of a deterministic, shared algorithm.
- **Nobody writes the ledger directly**, not even `service_role` ([row level security](../concepts/row-level-security.md)). The functions are the only door.
- **The account-deletion deadlock class grew** (eng review S17): the reset trigger locks participant then bill, the payment functions lock bill then participants (`docs/before-production.md` §6 and §8). Account deletion isn't built yet.
- **Direct API callers** can: set any valid split (the host only, logged), mark a payment to any current payer (self-reported, as in 0015), stamp any well-formed plan key, and, as a former payer, pay back on a pair they received.

## Code (by name, since line numbers move)
- **Database:**
  - `supabase/migrations/20261127140000_bill_payments.sql`: `bill_payments`, `bill_payment_flags`, the `bill_payments_no_update` trigger, `private.broadcast_bill_ledger_change`, the copy of old marks with its self-check.
  - `supabase/migrations/20261127140001_bill_payments_functions.sql`: `private.pair_state` (contract P), `mark_paid` and `settle_difference` with `p_plan_key`, `unmark_paid(bill, user, payer)`, `mark_not_received`, `private.is_removable`, the Groups ports (`private.bill_payments_no_group`, `attach_bill_to_group`), the column drop.
  - `supabase/migrations/20261127140002_who_paid.sql`: `bill_payers`, `private.bill_payer_ids`, `private.payers_valid`, `private.settle_state` (E′), `private.payments_moved` (contract M), `set_payers`, `set_payer(bill, payer)`, `private.bill_participants_reset_payer` (BEFORE DELETE), the `payers_changed` event kind.
  - Tests: `supabase/tests/database/bill_payments.test.sql`, `who_paid.test.sql`.
- **lib:**
  - `lib/payers.ts`: `payersState`, `validateSplit`, `splitDraftStatus`, `paymentsMovedBy`, `pairNetsTo`, `paidByLine`, `SPLIT_MIN_TOTAL_CENTS`.
  - `lib/transfers.ts`: `pairState`, `planKey`, `currentPlanKey`, `planRoutes`, `settleTransfers`, `transfersFromReadyPlan`.
  - `lib/settle.ts`: `ledgerSettlePlan` (the `routes` and `blocked_payers` plans), `balanceFor` (contract O, used by Home), `maySettle` (E′).
  - `lib/settleView.ts`: `settleCards`, `pickerDecision`, `splitSaveDecision`, `canChangePayer`.
  - `lib/bills.ts`: `BILL_PAYER_COLUMNS`, `PAYMENT_COLUMNS`, `FLAG_COLUMNS`, `setPayer`, `setPayers`, `markPaid`, `settleDifference`, `unmarkPaid`.
  - `lib/membership.ts`: `isRemovable`, `canRemove`, `canLeave` (rule L3).
  - `lib/payersForm.ts`: `percentsToCents`, `centsToPercents`, `switchUnit`, `payersFormStatus`, `canSavePayers`, `PAYERS_REQUEST_TIMEOUT_MS`; `lib/ownPayerChange.ts`.
  - `lib/homeMarkers.ts`, `lib/activityText.ts` (`payers_changed` sentences), `lib/homeSections.ts` (`viewerIsPayer`, balances through `balanceFor`).
  - Tests: `lib/transfers.test.ts` (P1–P6, T0–T13, the seeded simulation), `lib/payers.test.ts`, `lib/payersForm.test.ts`, `lib/settle.regression.test.ts`.
- **Screens:** `app/(app)/bills/[id]/payers.tsx` (the Who paid page), `components/PayerLine.tsx` (the "Paid by…" line on the bill screen and Settle up), `app/(app)/bills/[id]/settle.tsx` (one card per person you owe).

Concept notes: [who pays whom](../concepts/who-pays-whom.md), [money and rounding](../concepts/money-and-rounding.md), [row level security](../concepts/row-level-security.md), [database functions](../concepts/database-functions.md), [stale-state checks](../concepts/stale-state-checks.md), [group balances](../concepts/group-balances.md) (the same greedy).
