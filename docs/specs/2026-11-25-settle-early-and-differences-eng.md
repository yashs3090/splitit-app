# Engineering design review: Settle early and pay the difference

Date: 2026-11-25. Staff-engineer review of `docs/specs/2026-11-25-settle-early-and-differences.md` (the spec) and `docs/specs/2026-11-25-settle-early-and-differences-ux.md` (the brief), checked against the code on disk. Fourth document for this feature, after the spec, the UX brief and the visual design. No code was changed by the review.

## Verdict
The core idea holds. In proportional mode, rule E can be the same rule in SQL and in lib, the 1¢ drift claim is true, and the token design is sound. Fix these before building:

| # | Must fix | Where |
|---|---|---|
| F1 | Home's batch read can be **silently cut off** at PostgREST `max_rows = 1000`, so wrong pills would follow | `supabase/config.toml:19`, spec D7 |
| F2 | A $0 mark can't be cleared from any screen, and rule L3 then stops that person leaving or being removed. A $0 mark also produces odd cards in early and blocked states | spec D4/D6/D9, brief SE-UX-16 |
| F3 | The "Did you pay?" prompt is dropped whenever the share changes, so a person who already paid in Venmo is offered a button that records the **new** amount. Early mode makes this frequent | `lib/settleView.ts` `openedStillMatches`, brief B2 |
| F4 | The spec contradicts itself on `blocked_all_zero` without `allowEarly` | spec Task 3 vs criterion 17b |
| F5 | The payer card says "Nobody owes you anything" when nobody owes but the payer owes pay-backs; H6 and the "no marker" row contradict each other | `lib/settleView.ts` `payerCard`, spec D7 |
| F6 | Some planned breakage isn't listed: Task 2 breaks `settle_payer.test.sql:86-88`; Task 6 (not Task 8) breaks the proportional-fixture screen and footer tests; Task 3 leaves typecheck red for three tasks | §8 |
| F7 | Task 10 also depends on Tasks 3, 6 and 7, not only 2, 4 and 5 | §8 |

## 1. Rule E parity (early settling)
**Can SQL and lib be the same rule? Yes.** Rule E needs only integer sums over `line_items.total_cents` by `kind`, `bills.total_cents`, `bills.extras_split`, whether a row has a claim, and whether this user has a claim on a `kind = 'item'` row. The lib reads the same columns (`splitInputFor`, `lib/billView.ts`; `normalize` in `lib/split.ts` only drops claims the DB constraints make impossible).

SQL rules:
- **One statement.** `private.settle_state` as a single `language sql` query (CTEs). In plpgsql under READ COMMITTED each `select` takes a new snapshot, so a claim committing between two reads could give an answer that matches no real state. `mark_paid` and `settle_difference` call `settle_state` once.
- **bigint throughout.** 500 rows × 9,999,999 overflows int4. Don't cast `extras` back to integer.
- **What the lock covers.** `FOR SHARE` on `bills` freezes `total_cents`, `extras_split` and the row set (`update_bill`, `set_extras_split` conflict). It doesn't freeze claims (`set_claim` takes `FOR KEY SHARE`), so rule E can be one claim out of date. Harmless: same as "Sam unclaimed after paying" (W3).

**Rule Z on a complete bill equals today's `unclaimedCents ≠ 0`, exactly** (proof in the original review: zero weights never get a remainder cent; equal mode always has an item claimer). Criterion 17a confirms it.

**Add five boundary cases to both tables:**

| New | State | Expected | Why |
|---|---|---|---|
| E16 | proportional; every item claimed, only a claimable discount row unclaimed; Sam has an item claim | early | incomplete only because of a discount; exercises "1 discount left" |
| E17 | proportional, complete, every item $0, total 0, no discounts | final | complete twin of E10; pins 17a |
| E18 | proportional; items all $0; one claimable discount of −1; total 0 | all_zero | extras = +1 comes only from a discount; catches SQL that sums only `kind='item'` for extras |
| E19 | proportional; items 1000; total 999, so extras = −1; incomplete; Sam claimed | early | negative extras path |
| E20 | E1, then the host deletes Sam's only item row | not_complete | hasItemClaim goes false through an edit |

**The 1¢ claim is true, and cumulative:** ≤1¢ from Sam's early mark to completion over any sequence of other people's actions. Widen criterion 17c to random sequences run to completion (others' unclaims, `set_item_split`, a new participant joining, and Sam's weight 0, where drift must be exactly 0).

## 2. Changing what a mark stores (SE-2: net, 0 allowed)
- The constraint changes `1..` to `0..`; no data migration needed.
- Tests that assume ≥ 1: `settle_payer.test.sql:86-88` (not listed in the spec), `lib/bills.test.ts:552`, `lib/activityText.test.ts:681`.
- Don't loosen `isSettleCents` (it guards the Venmo URL builder and `markPaid`); add a separate `isMarkCents` if 0 marks stay.

**F2: $0 marks are a trap.** No screen offers Undo on a $0 mark, L3 counts any mark (so a paid-back person can never leave or be removed), and a $0 mark reaches undesigned states ("You paid Hana / $0.00", "Your 'I paid' is saved" on blocked cards, a $0-marked person whose share rises again can only use `settle_difference`).

**Recommended: paying back to $0 clears the mark.** `settle_difference(..., p_new_cents = 0)` sets both columns to null and logs `paid_back {from, to: 0}`.

| You keep | You give up |
|---|---|
| The `1..` constraint (no schema change) | The "✓ Paid back" status on card and row; history is in Activity |
| No `isMarkCents`, no 0-cent `unmarked_paid` | |
| L3 works; the `set_payer` count doesn't change | |
| D7 (0 → 500) becomes a plain "You owe $5.00" card through `mark_paid` | |

Small cost: `noticeFor` would show "Your 'I paid' was undone". Suppress it when the new share is ≤ 0, or show "✓ Hana paid you back." instead.

## 3. `settle_difference`
- **Token** (`p_expected_cents`): right granularity; ABA is harmless (every path records a true from→to). Compare **after** the row lock.
- **Idempotency (change):** a retry after a lost response would get `mark_changed` and alarming copy. Instead, under the lock, if `settled_cents = p_new_cents`, return success with no event, before the token compare. Criterion 53 becomes "a second identical call is a no-op, one event".
- **Direct API callers:** raising your own mark is today's caller-only risk. The payer lowering anyone's mark is **strictly weaker than `unmark_paid`**, which the payer already has. No new harm to others.
- **Lock order:**

| # | Lock | Row | Notes |
|---|---|---|---|
| 0 | none | participation read | R4 rule; new for `mark_paid` too (today it takes `FOR SHARE` first) |
| 1 | `FOR SHARE` | `bills` | serializes with `set_payer`, `update_bill`, `set_extras_split`, remove/leave |
| 2 | none | `line_items`, `claims` (rule E) | |
| 3 | **`FOR NO KEY UPDATE`** (not `FOR UPDATE`) | target `bill_participants` row | `FOR UPDATE` conflicts with the `FOR KEY SHARE` every claim takes, so it would queue behind the person's own claim taps; `NO KEY UPDATE` still serializes with `unmark_paid` and `mark_paid`. Also correct D10: `mark_paid`'s implicit lock is `FOR NO KEY UPDATE` |
| 4 | none extra | UPDATE of `settled_cents` | no FK columns change |
| 5 | `FOR KEY SHARE` | `bills` (already held) and the **caller's `profiles` row** (`bill_events.actor_id` FK) | the profiles lock conflicts only with account deletion (existing R9 gap) |
| 6 | none | statement trigger → one broadcast | |

No cycles with any existing function. Interactions with `set_payer`, `unmark_paid`, remove/leave and edits are all serialized at `bills` or the participant row.

## 4. Home batch read (HM-1)
- **Cost with 20 bills:** every filter is indexed; RLS is a PK lookup per row; ~200 KB raw / 30–40 KB gzipped per Home focus; pills arrive ~2 round trips after focus; JS work under ~30 ms.
- **F1 truncation:** `max_rows = 1000` cuts results off **without an error**; 20 bills of 10-person dinners can exceed it, giving wrong "You owe $X". Fix: `.range(0, 999)` on each request and treat exactly 1000 rows as failure (no settle pills); and **only fetch ids that can show a settle pill** (skip bills already `new`/`unclaimed`, and payer-and-incomplete bills).
- **Snapshot consistency:** four requests are four transactions; a host edit between them can briefly mislabel a bill until the next focus. Accept; note in before-production.
- **Parity test:** `fetchBill` doesn't order claims, so compare claims as sets (or sort both).
- **Failures:** parse per bill with try/catch so one bad bill drops only its pill; if any request fails, clear every settle pill; Home must never crash on a `RangeError`.
- **SE-UX-14 (keep pills during refresh):** chain on the existing `latest` token in `app/(app)/index.tsx`; filter the previous map to listed ids; apply the new map only if still latest.
- **`billMarker` returns null for the host first** (`lib/homeMarkers.ts:22`): keep the host out of `new`/`unclaimed` but let it reach settle markers, or host-payers never get H5–H7.
- **Recommendation:** option (c), 4 × `.in()` + lib math, with the truncation guard and id trimming. Upgrade path (d): one definer RPC returning raw rows as jsonb (one snapshot, no truncation), logged in before-production.

## 5. UI state
- **Merge `pending` into `difference`:** same shape and formula; the view decides actionability from the plan status. One formula fewer.
- **F3:** keep the opened prompt while **payer and mark** match, not while the amount matches. `share` kind: keep while the payer matches and the viewer is unmarked; "I paid" records `opened.cents`. `more` kind: keep while the payer matches and `mark.cents === opened.fromCents`; record `fromCents → fromCents + opened.cents`. Any remaining gap shows as a normal difference.
- **Other places that only check `ready`:** `pickerDecision` (use `ready || early` so "People may already be paying…" shows), and the footer functions (test early with optimistic counts).
- **SE-UX-4:** the payer is the host by default, so replacing Undo means nobody but Sam can undo a mistaken mark while a difference is open. Keep Undo for the host-payer below the difference controls, or accept it as a stated regression.
- **F5:** "pay-backs owed" must take precedence over "nobody owes you" in `payerCard` and in the Home markers.

Races to test: payer change while `more_opened`; old payer tapping "I paid it back" after a switch; host edit while Sam is in Venmo (prompt kept under F3); an unmark landing during "I paid the difference"; double taps on record buttons (one rpc); two taps on open-link buttons within 1 s (one open); a failed refetch after a write re-enables the button.

## 6. Test plan
- **Same case ids in pgTAP and Jest**, plus a Jest test that reads the `.sql` test files and checks the E/D id sets match `lib/settle.test.ts`, so a case can't land on one side only.
- **Live reconciliation:** every E row plus E16–E20; 20 seeded random proportional bills comparing `maySettle(fetchBill)` with `markPaid`; payer change then old token; unmark then `settle_difference`; identical retry; pay-back to 0 under the F2 choice and L3; `fetchSettleData` vs `fetchBill` with claims as sets; a >1000-claim truncation case expecting no pills.
- **Router entry paths, native and web:** Settle pushed, cold deep link, returning from Venmo (the opened prompt must survive the refetch); Home after the OAuth redirect, back from a bill, foreground; the bill footer with optimistic claim taps.
- **Copy at 1 and with "You"**, including both Activity directions. **Quote mismatch:** spec D8 writes `Hana undid Sam's "I paid"` but the code uses `'I paid'`; pick one.

## 7. Simpler options
| Item | Simpler option | Gives up |
|---|---|---|
| $0 marks | Paying back to $0 clears the mark | "✓ Paid back" status (Activity keeps history) |
| Separate `pending` | One `difference` field | Nothing |
| Four Request/Pay-back link variants | Ship the acting side, defer the nudges (but keep the payer's "Request $1.10 more", since the user asked) | Some nudge buttons |
| Home reading all 20 bills | Read only ids that can show a settle pill | Nothing |
| `mark_changed` on identical retry | No-op success | Spotting a duplicate raise from two devices |
| `FOR UPDATE` on the participant row | `FOR NO KEY UPDATE` | Nothing |
| Polite caption slot (SE-UX-12) | iOS announce only | Clear Android/web announcement |

## 8. Task order
- **F4:** without `allowEarly`, an incomplete bill is `blocked` (as today); with it, an incomplete all-$0 bill is `blocked_all_zero`.
- **F6:** Task 3 adds a stub `case 'early'` in `settleCard` so typecheck stays green; Task 2 edits `settle_payer.test.sql:86-88` (or skips it under F2's option); Task 6 updates the copy-only screen assertions it breaks; Task 4 flips `lib/bills.test.ts:552`.
- **Order:**
```
1 → 2                     (DB)
3 ‖ 4 ‖ 5                 (start together)
10a after 1,2,3,4         (live parity: E table, random bills, D table, truncation), before screens
6 after 3 (+4)
7 after 6
8 after 4,6   ‖   9 after 4,7
10b after 5,6,7           (view, markers, Activity)
11 last
```
