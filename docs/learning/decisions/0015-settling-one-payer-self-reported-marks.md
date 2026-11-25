# 0015: Settling: one payer per bill, self-reported "I paid" marks, Venmo links

**Status:** Accepted (2026-11-24, spec `docs/specs/2026-11-24-m3-settle-venmo.md` and its Amendment A1). Amends [0007](0007-payment-deep-links.md). Note 2026-11-25 (§8): the payer can send Venmo requests, and owers can pay from the bill screen; marks unchanged.

## Context
M3 is the "settle up" step. Every item on the bill is claimed, so every person's share is known. Now money has to reach the person who paid the restaurant.

[ADR 0007](0007-payment-deep-links.md) already decided the big thing: no money moves inside SplitIt. We open a payment app (Venmo, PayPal, Cash App) with the amount filled in. It also said "participants mark themselves paid and the host confirms", and its example link always paid "the host".

Building M3 raised questions 0007 didn't answer:
- **Who gets paid?** Often a guest paid the restaurant, not the person who scanned the receipt.
- **What does "I paid" mean** when the app can't see Venmo?
- **What if the screen is out of date?** Two people can act at the same moment. A tap is based on what the screen showed, and that can be a few seconds old.
- **What happens to marks** when the person being paid changes, or leaves?

The user answered these on 2026-11-24 (spec "User decisions" and Q1 to Q10).

## Options
| Question | Options considered | Chosen |
|---|---|---|
| Who gets paid | Always the host (0007's example); several payers per bill; **one payer, picked by the host** | One payer, picked by the host. Defaults to the host |
| Who changes the payer | Anyone; the payer; **only the host** | Only the host |
| What "paid" means | Host confirms each payment (0007); **each person marks themselves** | Each person marks themselves. Nobody confirms |
| Who can undo a mark | Host only; **host, the person themself, and the payer** | All three (Q4) |
| Payment apps | Venmo, PayPal and Cash App at once; **Venmo only for now** | Venmo only. The others come later |
| Link scheme | `venmo://` app scheme; **an `https://venmo.com/...` link** | `https`. It opens the Venmo app if installed, the browser if not |

## Decision

### 1. One payer per bill, picked by the host
- `bills.payer_id` says who collects. A new bill sets it to the host (a `before insert` trigger), and old bills were backfilled to their host.
- Only the host changes it, through the database function `set_payer` ([0013](0013-writes-through-database-functions.md)). Clients have no UPDATE grant on `bills`.
- Everyone except the payer owes the payer their share. The payer owes nothing.
- **The payer is always a participant.** This is enforced by a **deferred composite foreign key**: `(bills.id, bills.payer_id)` must exist as `(bill_id, user_id)` in `bill_participants`.
  - "Deferred" (`deferrable initially deferred`) means Postgres checks it at the end of the transaction, not after each statement. That's needed because `create_bill` inserts the bill first and the host's participant row a moment later. In between, the payer isn't a participant yet.
  - A payer who isn't a participant fails at commit with `23503 foreign_key_violation`. `set_payer` checks first and gives the friendlier `22023 not_participant`.

### 2. "I paid" marks are self-reported
- A mark is two columns on the person's own `bill_participants` row: `settled_at` (when they tapped) and `settled_cents` (the amount the screen showed them). Both are set or both are null (a check constraint).
- You mark yourself with `mark_paid`. **Nobody checks it.** The app can't see Venmo, so "I paid" is an honor-system statement, like telling a friend "sent it".
- Marking again is a no-op. The first time and amount are kept, and no second event is logged.
- The host, the person themself, or the payer can undo a mark with `unmark_paid`. Anyone else gets `42501`.
- Everyone on the bill can see everyone's marks (Q5). It's the same as claims.
- Opening the Venmo link never marks anything. Only the "I paid" tap does.
- Every mark, undo and payer change is logged in Activity (`marked_paid`, `unmarked_paid`, `payer_changed`).

### 3. Changing the payer clears every mark
A mark means "I paid *that* person". If the payer changes from Hana to Sam, a mark that said "I paid Hana" is no longer about the person now collecting. So `set_payer` clears every mark on the bill, after a confirm that says how many will be cleared ("This clears 2 'I paid' marks").

### 4. Stale-state tokens on the risky calls
The screen sends what it was showing, and the database refuses if that's no longer true. This pattern is explained in [stale-state checks](../concepts/stale-state-checks.md).
- **`set_payer(bill, new_payer, p_expected_cleared)`.** `p_expected_cleared` is the number of marks the host's confirm showed. If the bill has a different number now, the function raises `22023 marks_changed` and changes nothing. The app re-reads and asks again with the new count. This stops the host from wiping a mark that arrived after the confirm appeared.
- **`mark_paid(bill, p_payer_id, cents)`.** `p_payer_id` is the payer the screen showed. If the host has switched payer since, the function raises `22023 payer_changed`. This stops Sam from saving "I paid Dee" right after he actually paid Hana.

### 5. Venmo only, links from one module
- `lib/paylinks.ts` is the only place a Venmo URL is built (`venmoPayUrl`) and the only place it's opened (`openPaymentLink`).
- The link is `https://venmo.com/?txn=pay&recipients=<username>&amount=<amount>&note=SplitIt` (format "V1"). A fallback "V2" format sits behind one switch, `VENMO_LINK_FORMAT`.
- **The format is unverified.** Venmo's page no longer documents these parameters (see 0007's note). A check on a real phone with Venmo installed (spec criterion 64) decides between V1 and V2. That check was still pending when this ADR was written (`VENMO_LINK_FORMAT` is `'v1'` at `lib/paylinks.ts:25`).
- *Updated 2026-11-25 (spec `docs/specs/2026-11-25-venmo-note-item-names.md`, the user's request).* When this ADR was written, the note was the fixed word "SplitIt" (M3 Q7). Now it also lists the payer's **own** claimed items, so people can tell their Venmo payments apart. Example: `SplitIt: Carnitas Bowl, Chicken Burrito + 3 more`.
  - At most 2 item names, then `+ N more`. The whole note is at most `VENMO_NOTE_MAX` (100) characters, counted as Unicode code points.
  - Shared items count; claimable discounts don't. With no claimed items, the note is plain "SplitIt".
  - It still never contains people's names or amounts.
  - The trade-off: Venmo notes can show on a public feed, so the note now reveals what someone ordered. The user asked for item names, so they're on by default (decision VN-8, waiting for the user's review). One constant, `VENMO_NOTE_INCLUDES_ITEMS`, turns them off again. See `docs/before-production.md` §6.
  - Code: `venmoNote` and `claimedItemNames` in `lib/paylinks.ts`.
- Amounts must be whole cents from 1 to 99,999,999 (rule C2). Outside that, there's no link and `mark_paid` refuses with `22023 invalid_amount`.

### 6. Known gaps, accepted on purpose
These are recorded so nobody "discovers" them later and thinks they're bugs.

**K6: the all-$0 bill.** Picture a proportional bill where every item is $0.00 but the total is $5.00 (all tax). Every item is claimed. Tax is split by item subtotals, and every subtotal is 0, so nobody can carry the tax.
- The app says the bill can't be settled (`blocked_all_zero`, "Every item is $0. Fix the prices, or switch to Split evenly."). It shows no Pay or "I paid" buttons.
- The database's completeness rule only asks "does every row have a claim?", so it says the bill is complete, and `mark_paid` would accept a mark.
- CLAUDE.md asks that a money rule enforced in both `lib/` and the database be the same rule. This is a deliberate exception: a mark moves no money, the app never offers the button, and matching `computeShares` exactly in SQL (with negative item prices) isn't simple. Both sides test the gap as case K6 (`lib/settle.test.ts:444`, `supabase/tests/database/settle_marks.test.sql:432`). Decisions-to-review M3-B-12 and M3-R-1.

**The count check has an "ABA" limit.** `p_expected_cleared` compares *how many* marks there are, not *whose*. "ABA" is the textbook name for this: the value went from A to B and back to A, so a check that only looks at the value can't tell anything happened.
- Example: Hana's confirm says "clears 1 mark" (Sam's). Before she taps, Sam undoes his mark and Dee marks hers. There's still 1 mark, so the check passes and Dee's mark is cleared, though the confirm didn't name her.
- Accepted because it's rare, nobody loses money, Activity records the clear, and Dee's screen tells her "If you already paid Hana, sort it out with them." The fix would be passing the list of marked user ids instead of a count (a contract change). Decisions-to-review M3-R-2.

**`unmark_paid` has no token.** If Sam undoes and re-marks while Hana's Undo on his old mark is in flight, Hana's Undo clears the new mark. Sam can simply mark again, and Activity shows both steps. Decisions-to-review M3-11.

### 7. If the payer's account is deleted
Account deletion cascades from `profiles` and removes the payer's participant row. That would break "the payer is a participant", so an `after delete` trigger on `bill_participants` (`private.bill_participants_reset_payer`) runs first:
- the bill goes back to the host;
- every mark on the bill is cleared (they were payments to the deleted person);
- one `payer_changed` event is logged with no actor (Activity reads "Who gets paid changed back to Hana (an account was deleted)").

The deletion then succeeds, because the deferred foreign key is checked at commit, after the trigger has fixed things. If the host is the one deleted, the whole bill is deleted as before and the trigger does nothing. Account deletion itself isn't built yet. Decisions-to-review M3-9.

### 8. Note (2026-11-25): Request buttons for the payer, and paying from the bill screen
This note adds two features. Nothing above changes: marks are still self-reported, nobody confirms, opening Venmo never marks anyone, and the database is untouched (no migration, no new Activity kind). Spec: `docs/specs/2026-11-25-venmo-request-buttons.md` and its Amendment A1. Decisions VR-1 … VR-18 in `docs/decisions-to-review.md`.

**The request link is confirmed.** On 2026-11-25 the user opened `https://venmo.com/?txn=charge&recipients=<username>&amount=0.01&note=SplitIt` on their iPhone, and Venmo's Request screen opened. Android, desktop and V2 are still unchecked. How the link is built: [0007](0007-payment-deep-links.md), note "Request links are built".

**Per-row Request, for the payer only.** On the Settle screen's Everyone list, the payer sees a small **Request** button on each row of someone who still owes them. Example: Yash paid the restaurant; Tejesh's row reads `Tejesh  $15.10  Not yet`, and under it `@Tejesh-Bhaumik` and **Request**. One tap opens Venmo's Request screen for $15.10 with Tejesh's items in the note.
- **Only the payer sees it** (VR-2). A Venmo request asks money for whoever is signed into Venmo on that phone. On the host's phone, when the host isn't the payer, it would ask money for the wrong person.
- **Only for people who owe and haven't marked "I paid"** (VR-3). The amount is exactly their share from `settlePlan`. No button for $0, negative shares or marked rows.
- **No username, no button.** The row shows "Hasn't added Venmo" instead (VR-8), or "Request it in the Venmo app" when the amount is over the link limit.
- **Requesting never writes anything** (VR-6, VR-7). No mark, no Activity event, no "Requested" label. The app can't see whether the payer actually sent the request. The row keeps "Not yet" until that person taps "I paid" themselves. When they do, the Request button disappears live.
- **No "Request all"** (VR-4, confirmed by the user). Each link carries one person and one amount, and browsers block every popup after the first in one tap.
- **A share that grew after "I paid" gets no Request for the difference** (VR-5). The existing "Marked $5.00 · share now $7.00" line stays.

**Owers pay straight from the bill screen.** Before, someone who owed had to tap "Settle up" and then Pay. Now the bill screen's footer shows the Pay button itself, for example `Pay Hana Lee $15.10 on Venmo`, with `@hana-1 · $15.10` under it and a quiet **Details** link to the Settle page.
- **One rule for both screens** (VR-11). The footer is worked out from the same Settle card the Settle page shows. So the bill screen offers Pay in exactly the cases the Settle page does, with the same URL, label and fallbacks. Everyone else (the payer, people who owe nothing, people with no payer username, marked people) still sees the old "Settle up" button.
- **"Did you pay?" step** (VR-14). After the Pay tap, the footer becomes one line: `Did you pay Hana Lee?` with **I paid** and **Not yet**. "I paid" calls the same `mark_paid` as the Settle page, with the same stale-state token (`p_payer_id`, §4). "Not yet" just brings back the Pay button and writes nothing. The prompt lives only in the screen's memory: leaving the screen forgets it, and it never marks anyone by itself.
- **After marking**, the footer goes back to "Settle up" with `✓ Marked paid` (VR-15).
- **Amounts come only from saved data** (VR-17). While your own claim, split or tax-mode change is still saving, Pay and "I paid" are disabled. A Venmo amount must never come from a claim the database hasn't accepted yet.
- **"I already paid"** (cash, another app) stays on the Settle page only, behind Details.

**Code** (cited by name, since line numbers move):
- Link: `venmoRequestUrl` and `venmoRequestUrlForFormat` in `lib/paylinks.ts`.
- Shared input for both screens: `settleViewInputFor` in `lib/settleView.ts` (moved there from the Settle screen so both screens build it the same way, from server data).
- Request rows: the `request` field on each row model in `lib/settleView.ts`, shown by `components/SettlePeopleList.tsx`; the web line comes from `settleRequestWebLine`.
- Footer: `settleFooterAction` (the footer from the Settle card) and `billFooterAction` (keeps "N left to claim" moving with each claim tap, but never builds a Pay from unsaved data) in `lib/settleView.ts`; drawn by `SettleFooter` in `components/SettleFooter.tsx`; wired in `app/(app)/bills/[id]/index.tsx`.

## How this relates to 0007
0007's core decision stands: settle through payment-app links, never move money in-app, and build links in one module. This ADR **amends** three details of it:

| 0007 said | 0015 says |
|---|---|
| The link pays "the host" | The link pays the bill's payer, which the host picks (default: the host) |
| "Participants mark themselves paid and the host confirms" | Participants mark themselves. Nobody confirms. The host, the person or the payer can undo |
| Venmo, PayPal and Cash App | Venmo only for now. PayPal and Cash App later, in the same module |

So 0007 is marked "Amended by 0015", not superseded.

## Consequences
- The app still never touches card or bank data, and there's still no custom backend: everything is SQL functions in Supabase plus pure code in `lib/`.
- "Paid" stays an honor system. `settled_cents` comes from the client, and the database checks only that it's a sensible number (C2). The app should say so in its help text (`docs/before-production.md` §6).
- A host can change the payer late and clear people's marks. The confirm and the Activity log make that visible, not silent.
- Amounts can change after someone marks (the host edits, someone unclaims). The mark keeps its original amount, and the screen shows the difference ("Your share is now $16.20. Sort out the $1.10 with Hana.") using `markDiffCents` from `lib/settle.ts`.
- If Venmo changes its link format, only `lib/paylinks.ts` changes.
- The payer-deletion trigger and `unmark_paid` take their locks in opposite orders, so a deletion racing an undo could deadlock (`docs/before-production.md` §6, review R9). To fix when account deletion is built.

Code:
- Payer, marks, invariant, deletion trigger, broadcast, `set_payer`: `supabase/migrations/20261124081411_settle_payer.sql` (foreign key `:47-51`, default payer `:70-86`, deletion trigger `:94-142`, broadcast `:160-164`, `set_payer` `:186-245`). Tests: `supabase/tests/database/settle_payer.test.sql`.
- `bill_is_complete`, `mark_paid`, `unmark_paid`: `supabase/migrations/20261124081412_settle_marks.sql` (`:24-38`, `:50-108`, `:117-167`). Tests: `supabase/tests/database/settle_marks.test.sql`.
- Links: `lib/paylinks.ts` (`venmoPayUrlForFormat` `:47-56`, `openPaymentLink` `:69-76`). Tests: `lib/paylinks.test.ts`.
- Who owes what: `settlePlan` in `lib/settle.ts:65-103`. Tests: `lib/settle.test.ts`.
- Data layer: `setPayer`, `markPaid`, `unmarkPaid` in `lib/bills.ts:410-443`.
- Screen: `app/(app)/bills/[id]/settle.tsx` (payer change with a fresh re-read at `:281-345`), view logic in `lib/settleView.ts`.

Concept notes: [stale-state checks](../concepts/stale-state-checks.md), [database functions](../concepts/database-functions.md), [money and rounding](../concepts/money-and-rounding.md), [realtime](../concepts/realtime.md).
