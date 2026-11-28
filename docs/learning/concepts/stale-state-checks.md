# Stale-state checks (optimistic concurrency)

## The idea
Every screen shows a **snapshot**: what the database said a moment ago. By the time you tap a button, the snapshot may be out of date. Someone else may have changed the bill a second earlier.

Usually that doesn't matter. But some taps are **decisions based on what you saw**: "clear these 2 marks", "I paid Hana". If what you saw is no longer true, the decision is wrong.

There are two ways to protect against this:
- **Pessimistic:** lock the data while the person decides, so nobody else can change it. That doesn't work for an app. A person can stare at a confirm for a minute, and a database lock can't be held across a phone screen.
- **Optimistic:** don't lock while deciding. Instead, **send along what you saw**, and let the database refuse if it's changed. That's called **optimistic concurrency**. "Concurrency" just means several people acting at the same time.

The "what you saw" value is a **stale-state token**, sometimes called an **expected value**. It's like saying to a shop "I'll take it at the $20 on the tag". If the price changed, the shop says no, and you look again.

The steps are always the same:
1. The screen reads the data and shows it.
2. The person decides and taps.
3. The app calls the database function with the token (the value the decision was based on).
4. Inside one transaction, the function **locks** the row, compares the token with the current value, and either does the work or raises a fixed error.
5. On that error, the app re-reads and shows the person the new state, so they can decide again.

The lock in step 4 matters. Without it, the value could change between the compare and the write. The lock is held only for the few milliseconds the function runs, not while the person thinks.

## Why it matters here
SplitIt is used by several phones at one table, all live. Races are normal, not rare:
- The host opens "change who gets paid" and sees 1 "I paid" mark. While the confirm is on screen, Dee taps "I paid". If the host's tap simply cleared everything, Dee's mark would vanish without the host ever being told about it.
- Sam's screen says "Pay Hana $15.10". He pays Hana in Venmo. Meanwhile the host switches the payer to Dee. If Sam's "I paid" were saved as-is, the app would say he paid Dee, which is false.

The lessons log rule from M2 says it plainly: with live data, a decision that can destroy data re-checks the server's current state, either by re-reading at decision time or by having the server function check it.

## How we use it
| Function | Token (what the screen saw) | If it changed | Code |
|---|---|---|---|
| `set_payer(bill, payer, p_expected_cleared)` | how many "I paid" marks the confirm said it would clear | `22023 marks_changed`, nothing changes | `supabase/migrations/20261124081411_settle_payer.sql:221-227` |
| `mark_paid(bill, p_payer_id, cents)` | who the screen said gets paid | `22023 payer_changed`, nothing saved | `supabase/migrations/20261124081412_settle_marks.sql:81-83` |
| `set_item_split(item, p_parts)` (M2) | the exact set of claimers, because `p_parts` must name each one | `22023 claimers_changed` | `supabase/migrations/20261121080352_bill_events.sql:620-724` |
| `settle_difference(bill, person, p_payer_id, p_expected_cents, p_new_cents)` (2026-11-25) | `p_expected_cents`: the person's "I paid" amount the screen showed (and `p_payer_id`, as in `mark_paid`) | `22023 mark_changed` (or `payer_changed`), nothing changes | `supabase/migrations/20261125090051_settle_difference.sql`, `public.settle_difference` |
| `mark_not_received(bill, person, p_payer_id, p_expected_cents, p_expected_at)` (2026-11-27) | the exact mark the payer's screen showed: its amount **and** its `settled_at` | `22023 mark_changed` (or `payer_changed`), nothing changes | `supabase/migrations/20261126080844_sent_via_venmo.sql`, `public.mark_not_received` |

*(2026-11-27: `mark_paid` and `settle_difference` were re-created with a payment-method argument in `20261126080844_sent_via_venmo.sql`; their tokens are unchanged.)*

*(2026-11-27, Who paid, [ADR 0023](../decisions/0023-several-payers.md)): three changes to this table.*
- *`set_payer` lost `p_expected_cleared`. A payer change now clears no payment (the ledger keeps every one), so there's nothing a stale count could wrongly destroy. The ABA hole below is gone with it.*
- *`settle_difference` and `mark_not_received` keep their tokens, but "the mark" is now worked out from ledger rows: its cents are the pair's net, and its time is when the latest positive run started (contract P, `private.pair_state`). Undo and Not received delete exactly that run's rows.*
- *`set_payers` has no token. The page re-reads the bill before saving, and the database refuses amounts that don't add up to the current total (`22023 payers_total`). See "Late answers after a timeout" below.*
- *`p_payer_id` is still the token for "who gets paid", now checked against the whole payer set.*

All of them lock the row first (`for update`, `for share` or `for no key update`) and then compare. See [database functions](database-functions.md) for which lock each one takes and why.

**What the app does on the error.** `lib/bills.ts:156-163` maps each message to an app error code. The Settle screen then:
- on `marks_changed`: re-reads the bill and shows the confirm again with the new count, plus "Someone marked that they paid just now. Check who'll be affected and try again." (`app/(app)/bills/[id]/settle.tsx:337-339`);
- on `payer_changed`: shows "Who gets paid just changed. Check the amount and try again." and refetches, so the card now says "Pay Dee …".

**Re-read before asking, too.** When the host picks a new payer, the screen first fetches the bill again and counts the marks *now* (`decidePayer`, `app/(app)/bills/[id]/settle.tsx:281-323`). So the confirm is usually right to begin with, and the token only catches the last-second race. The host's edit screen does the same kind of re-read (`freshSaveCheck`, `lib/editBill.ts:92`).

**Worked example (spec criterion 58, run live against the local database):**
1. Hana's confirm says "This clears 1 'I paid' mark" (Sam's).
2. Dee marks too. Now there are 2 marks.
3. Hana confirms. The app calls `setPayer(bill, X, 1)`.
4. The function locks the bill, counts 2, sees 2 ≠ 1, and raises `marks_changed`. Nothing changes.
5. Hana's screen re-reads and asks again: "This clears 2 'I paid' marks."

### Where we chose not to use a token (and why)
- **`unmark_paid` has none.** If Sam undoes and immediately re-marks while Hana's Undo of his old mark is in flight, her Undo clears his new mark. He can mark again in one tap, and Activity shows what happened. Judged not worth a contract change ([ADR 0015](../decisions/0015-settling-one-payer-self-reported-marks.md), decisions-to-review M3-11).
- **`set_payer`'s token is a count, not a list of names.** That has a known hole, the **ABA problem**: the value went from A to B and back to A, so a check that only compares values can't tell anything happened. Example: the confirm says 1 mark (Sam's). Sam undoes (0 marks), then Dee marks (1 mark). The count is 1 again, the check passes, and Dee's mark is cleared though the confirm didn't name her. Rare, recoverable and logged, so accepted for now (decisions-to-review M3-R-2). Passing the list of marked user ids would close it.

### The difference token: `p_expected_cents` (2026-11-25)
*From spec `docs/specs/2026-11-25-settle-early-and-differences.md` (D4) and [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md).*

`settle_difference` changes someone's "I paid" amount: Sam raises his own mark when he pays more, or Hana (the payer) lowers it when she pays him back. It says "change Sam's mark **from** 1510 **to** 1620". The "from" is the token: the amount the screen showed. Under the row lock, the function compares it with the stored mark. If they differ, it refuses with `mark_changed` and changes nothing, and the app shows `Your "I paid" just changed. Check the amount and try again.` and re-reads.

What it catches:
- **A double tap**, or the same tap on two phones. The first call moves the mark to 1620; a second "from 1510" no longer matches.
- **The other side acting at the same moment.** Sam is in Venmo paying $1.10 more while Hana records a pay-back. Whichever lands second finds a different "from" and is refused, instead of adding up to a wrong total.

**The idempotent retry comes first** (decision SE-ENG-3). Picture Sam's "I paid the difference": the database stores 1620, but the phone loses the response and retries. Without special handling, the retry's "from 1510" wouldn't match 1620, and Sam would be told his "I paid" had changed, for a write that worked. So, after the "who may call" and "is the bill complete" checks and before the token compare, the function asks: **is the mark already what this call asks for?** If so, it returns success with no write, no Activity event and no broadcast. "Idempotent" means doing it twice has the same effect as doing it once.

The order matters, the same way it does for `set_payer`'s "nothing to do" shortcut:
1. Checks that must always run (signed in, on the bill, valid amounts, still the payer, **allowed for this direction**, bill complete). An idempotent retry never skips these: a stranger repeating someone else's call is still refused (case D20).
2. Lock the person's row.
3. Already in the requested state? Return quietly.
4. Token compare: refuse with `mark_changed` if the "from" doesn't match.
5. Write and log.

**What the token can't detect:**
- **The share changing again** between screen load and tap. The token is the mark, not the share, and the database can't compute shares (they come from `computeShares` in `lib/`). That's fine: the record says what was actually sent ("from 1510 to 1620"), and if the share moved again, the next refetch shows a new difference.
- **A mark that goes away and comes back to the same amount** (review R8; the same ABA problem as `set_payer`'s count). Example: Hana records a pay-back, 1510 → 1400, but her phone loses the response. Later Sam pays $1.10 more, 1400 → 1510. If Hana's old call were now sent again unchanged, its "from 1510" matches again, and a second `paid_back` would be recorded. The app doesn't do this: its own retry is built from freshly read data. So only a direct API caller, or a very unlikely sequence, could. Accepted for now and tracked in `docs/before-production.md` §4. The full fix is to use a **version number** on the row as the token instead of the amount, because a version only ever goes up.
- **A direction flip.** If the mark moved so far that "from → to" now points the other way (a raise has become a pay-back), the call is refused by the "who may call this direction" check, before the token compare, with `42501 not_allowed`. For the app that means the same thing as `mark_changed` (the mark moved under the screen), so after a difference write the app shows the `mark_changed` copy and re-reads (decision SE-T6-2, `actionError(error, { difference: true })` in `lib/settleView.ts`).

**Where the app gets "from" and "to".** From the model the screen is showing, never recomputed in a component: `differenceArgs` in `lib/settleView.ts` turns the button's action into `settleDifference`'s arguments (`lib/bills.ts`). After "Did you pay Hana $1.10?", the values are the ones that were opened in Venmo, even if the share has moved since (contract O, [ADR 0021](../decisions/0021-settling-early-and-paying-differences.md) §6).

### Amount and time together: "Not received" (2026-11-27)
*From spec `docs/specs/2026-11-26-sent-via-venmo.md` (D4, A1 F5) and [ADR 0024](../decisions/0024-sent-via-venmo-and-payment-methods.md).*

Hana, the payer, taps **Not received** on Sam's row. That clears Sam's mark and tells him "Hana hasn't received your $15.10". It's destructive to someone else's record, so it needs a token. The first plan used the amount alone, like `settle_difference`. The engineering review found the ABA hole again, and this time the app itself could hit it:

1. Sam's mark: $15.10 via Venmo, made at 12:00:00.
2. Hana opens Settle up and sees "Sent via Venmo · $15.10".
3. Sam taps "No, undo" on his check-in, then pays again: a **new** $15.10 mark at 12:03:10.
4. Hana, still looking at her old screen, taps Not received → confirm.

With the amount alone, step 4's "$15.10" matches the new mark, and Hana clears a payment she never looked at. So the token is now **the amount and the time**: `p_expected_cents = 1510` and `p_expected_at = '12:00:00…'`. The new mark has a different `settled_at`, so the call fails with `mark_changed`, and Hana's screen re-reads.

**Why the time works as a version.** A version number is something that changes every time the thing changes and never comes back to an old value. `settled_at` is set when a mark is made, and every fresh mark gets a new one (the transaction's start time). A mark that goes away and comes back gets a **new** `settled_at`, even at the same amount. So for "is this still the mark I saw?", cents + time together behave like a version. (It's not perfect in general: `settle_difference` changes the cents but keeps the first `settled_at`, which is why the cents stay in the token too, and why R8 is still open for `settle_difference` itself.)

**Pass the time exactly as you read it.** `settled_at` is a `timestamptz` with microseconds. JavaScript's `Date` keeps only milliseconds. If the app parsed the time into a `Date` and formatted it back, it would never equal the stored value, and every Not received would fail `mark_changed`. So `markNotReceived` in `lib/bills.ts` sends the string exactly as fetched (SV-T3-4).

**The confirm keeps its token too** (review R2). The inline confirm ("Didn't get Sam's $15.10? This clears it and lets Sam know.") remembers the cents and time of the mark it was opened for. If a refetch shows a different mark while the confirm is open, the confirm closes and the link comes back with the new amount. Hana confirmed one payment; the tap must not clear another.

**The retry still comes first.** If Hana's response is lost and she retries, the row is already unmarked and flagged by her for those cents. That counts as success, with no second event. Like `settle_difference`, this check runs only after every permission check.

### Telling the caller whether it worked: `created` (2026-11-27)
`mark_paid` has no token for "already marked": marking twice has always been a harmless no-op. That stopped being harmless once the app opened Venmo right after the mark. A stale screen, a second phone or a double tap would get "ok" and open Venmo for a second payment. The fix isn't a token; it's an honest answer. `mark_paid` now returns `created`: true only if this call made the mark. The app opens Venmo only then, and otherwise shows "You've already marked this. Check below." ([database functions](database-functions.md), "Sent via Venmo").

### A plan key isn't a token: stale means "re-plan", not "refuse" (2026-11-27)
*From [ADR 0023](../decisions/0023-several-payers.md) §4 and [who pays whom](who-pays-whom.md).*

Every payment now carries a **plan key**: a fingerprint of the money state the payer's screen showed. It looks like a token, but the database never refuses a payment because its key is old. That's on purpose:
- A token protects a decision that would **destroy** something if it were based on old data. A payment destroys nothing. The money really moved.
- So the key only decides how the payment is *counted* when routes are worked out. A current-key payment reduces its own route. An old-key payment is folded into everyone's position, and the routes are planned again around it.

Example: Dee's Settle screen is a minute old. Meanwhile the host fixed a price. Dee pays Hana $25.00 with the old key. Nothing is refused. The next read counts her $25.00 as history and re-plans, so if Hana now holds a little too much, the new plan has Hana pass it on.

The rule of thumb: **refuse when acting on old data would lose something; re-plan when it can't.**

### Late answers after a timeout: the Who paid page (2026-11-27)
*From spec A2 criterion A-50(h) and review round 2. Code: the header of `app/(app)/bills/[id]/payers.tsx`, `PAYERS_REQUEST_TIMEOUT_MS` in `lib/payersForm.ts`, `lib/ownPayerChange.ts`.*

The page's requests (the re-read before saving, `set_payer`, `set_payers`) give up after **15 seconds** (`PAYERS_REQUEST_TIMEOUT_MS`, through `within` in `lib/asyncTimeout.ts`) and show the same network error as a lost connection, with Save and Back enabled again. Without a limit, a request that never answers would leave Save spinning forever.

But a timeout is the app giving up, not the database. **A write that timed out may still commit.** So "timed out" means "unknown", not "failed". The page handles the three things that can happen next:
1. **The answer arrives late and says ok.** The page says "Your earlier save went through." and re-reads. It doesn't navigate away by itself: the host may already be typing something else.
2. **A re-read shows the save landed.** If the draft on screen is still what was saved, the page goes back as after a normal save. If the host has changed it since, it says "Your earlier save went through." instead, so they aren't confused when the stored values differ from what they typed.
3. **The answer arrives late and is a refusal.** Nothing was saved; the page forgets the note.

**The note** (`lib/ownPayerChange.ts`): while a save is unknown, the page remembers "the host changed who paid on this bill", in memory, for at most `OWN_PAYER_CHANGE_MAX_MS` (2 minutes). Settle up reads it so it doesn't tell the host "You're now collecting" about their own change. Only the write's own answer (a refusal) or the time limit clears it, because only those prove what happened.

**One save at a time.** A double tap on Save (or on the confirm) sends one call and goes back once. The guard is a ref (a value that changes at once), not React state, because two taps can land before a re-render. Nothing is shown as saved until the database says so.

**The re-read before saving is a stale check too.** If the bill total changed since the page opened, the save stops with "The bill total changed to $X. Check the amounts and save again." The database would refuse it anyway (`payers_total`), but the app says why first.

### A whole-state token: the money fingerprint (2026-11-28)
*From [ADR 0027](../decisions/0027-delete-group.md) (contract F). Code: `private.group_money_fingerprint` and `public.delete_group` in `supabase/migrations/20261128100232_group_delete.sql`; `deleteGroup` in `lib/groups.ts`.*

Deleting a group is allowed only when everyone is settled. The app decides that (`canDeleteGroup`), because only `lib/` can compute balances. But Ben's screen may be a minute old. If Ana added a $40 expense meanwhile, Ben's "everyone is settled" is wrong, and the delete would wipe out money Ana is owed.

No single value covers that. The decision depends on **everything** that feeds the balances. So the token is a fingerprint of all of it: an md5 of the members, each receipt's payer, total, split mode, rows and claims, each live expense's `version`, and each live payment's id. `group_snapshot` returns it as `money_fingerprint`, computed in the same statement as the rest of the snapshot, so it describes exactly the data on screen.

1. Ben's screen loads the snapshot and its fingerprint.
2. Ben taps Delete group, then confirms.
3. The app sends the **same string back**, untouched. It never computes the fingerprint itself.
4. `delete_group` locks the group, recomputes the fingerprint, and compares. Different → `22023 group_changed`, nothing deleted.
5. The dialog closes, "Something in this group just changed. Check it and try again." shows, and the screen refetches.

What it includes and leaves out is chosen on purpose. Anything that can move a balance changes it: a claim, a price edit, a new expense, a payment, a new member. A rename, a new invite link or hiding the group doesn't, because those can't make "settled" wrong.

The token is the snapshot on screen **at the moment of the tap**. If a refetch lands while the dialog is open, the newer fingerprint is the one sent. If that refetch shows the group is no longer settled, the dialog closes by itself.

Like every token here, it protects honest people from stale screens, not against attackers. A modified app could send a fresh fingerprint for an unsettled group. That risk is accepted and listed in `docs/before-production.md`.

**No "already done" success this time.** A retry of `delete_group` after a lost answer finds no group and gets `42501`, the same as a non-member. The app treats that as done and shows "This group was deleted" (A2.11).

## Pitfalls
- **Comparing without a lock.** "Read, compare, write" without `for update` or `for share` lets the value change between the compare and the write. Lock first.
- **Not deciding whether the "nothing to do" shortcut comes before the token check.** `set_payer` returns early (no error, nothing cleared) when you pick the current payer, *before* it looks at the token. That's deliberate: nothing would be destroyed, so a wrong count doesn't matter (criterion 9).
- **A token that's too coarse.** A count can come back to the same number (ABA). A timestamp with low resolution can repeat. Prefer something that changes on every relevant change: the exact set of ids, or a version number.
- **Showing raw server errors.** Map each token error to fixed copy that tells the person what to do ("check and try again").
- **Forgetting to re-read after the error.** The screen still shows the old snapshot. Refetch, then ask again.
- **Using a token where nothing can be lost.** It adds an error path the UI must handle. `mark_paid` repeated is a harmless no-op, so it has no "already marked" token. But if the caller does something irreversible next (opening Venmo), the no-op must say it was a no-op (`created = false`).
- **Reformatting the token before sending it back.** A `timestamptz` round-tripped through a JavaScript `Date` loses its microseconds and never matches again. Send the value exactly as you read it.
- **A confirm that outlives what it confirmed.** If the data under an open confirm changes, close it (or re-ask) instead of applying it to the new data.
- **A fingerprint that misses an input.** If the decision reads something the fingerprint doesn't cover, a change to it slips through. List every input the decision reads (for `delete_group`, everything `groupBalances` reads) and leave out only what can't change the answer.
- **Treating the token as security.** It protects honest people from stale screens. Who may call the function is still checked separately (`auth.uid()`, host checks).
- **A retry that fails because the first try worked.** If a response can be lost, a second identical call will see the new state and fail the token check. Decide whether "already done" should count as success (as in `settle_difference`), and put that check after the permission checks, so nobody can use it to skip them.
- **Taking the token at confirm time instead of tap time.** The Not received confirm first re-read the amount when you pressed Confirm, so it always matched and the guard did nothing (review R2). Carry the token from what the person *saw and tapped*.
- **Re-enabling Pay when the write landed but the reload failed.** The screen still shows "You owe Hana / Pay", so a second payment looks right. `useVenmoSend` holds every write ("Your payment was saved, but we couldn't refresh. Try again before you pay again.") until a reload actually succeeds (N3, SV-RC-4).
- **Using an amount as a token where the amount can come back.** A value that can go 1510 → 1400 → 1510 can't tell a replay from a fresh request. A version number that only goes up can.
- **Refusing something that already happened.** A payment made from an old screen is still real money. Refusing it would make the app disagree with Venmo. Record it and re-plan around it (the plan key).
- **Treating a timeout as a failure.** The app stopped waiting; the database may still have committed. Treat it as "unknown", keep whatever depends on the outcome (the own-change note), and let a later answer or a re-read settle it.
- **A late answer that navigates.** By the time it arrives, the person may be doing something else. Say what happened and re-read; don't move them off the screen.

## Check yourself
1. Why can't the app just lock the bill row while the host looks at the "change who gets paid" confirm?
2. Sam's screen shows "Pay Hana". The host switches to Dee. Sam taps "I paid". What does `mark_paid` do, and what does Sam's screen show next?
3. The confirm said "clears 2 marks". Now there are 3. Walk through what `set_payer` does, step by step, and why it locks the bill before counting.
4. Describe a sequence of taps where `set_payer`'s count check passes but clears a mark the host didn't see. What token would prevent it?
5. `set_payer(bill, <current payer>, 99)` succeeds with no error even though 99 is wrong. Why is that safe?
6. Sam taps "I paid the difference" (1510 → 1620). The database saves it, but his phone never gets the answer and retries. What does `settle_difference` do with the retry, and what would Sam have seen without the idempotent check?
7. Why does the idempotent check run *after* "who may call this direction" and not before it? What could Dee (not the payer) do otherwise?
8. Give a sequence where replaying an old `settle_difference` call passes the `p_expected_cents` check. Why can't the app's own retry produce it, and what token would stop it?
9. After Sam taps Pay for $1.10 more, the host changes the tip and Sam's share moves again. What does the token catch, what doesn't it catch, and why is the record still right?
10. Sam undoes his $15.10 Venmo mark and sends $15.10 again while Hana's old screen is open. She taps Not received. Why would an amount-only token clear the wrong payment, and what does `p_expected_at` change?
11. Why does the app send `settled_at` back as the exact string it read, instead of a `Date`?
12. Why did `set_payer` lose its `p_expected_cleared` token once payments became a ledger? What could the old count token protect that no longer needs protecting?
13. Dee pays from a Settle screen whose plan key is a minute old. Why doesn't the database refuse it, and what does the next plan do with her payment?
14. The host taps Save on the Who paid page, and after 15 s the page shows a network error. Did the save fail? Name the three things that can happen next, and what the page does in each.
15. Why is the page's "one save at a time" guard a ref and not React state?
16. Why is `delete_group`'s token a fingerprint of the whole money state rather than one value? Name one change that alters it and one that doesn't, and say why each.

## Learn more
- PostgreSQL, explicit locking and row-level locks (`FOR UPDATE`, `FOR SHARE`): https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL, `SELECT ... FOR UPDATE` / `FOR SHARE` (the locking clause): https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
- PostgreSQL, current date/time (`now()` is the start time of the current transaction; `timestamptz` keeps microseconds): https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT
- MDN, `Date` (millisecond precision): https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
- MDN, `If-Match` (the same idea in HTTP: "only change it if it's still the version I saw"): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Match
- Wikipedia, optimistic concurrency control: https://en.wikipedia.org/wiki/Optimistic_concurrency_control
- Wikipedia, the ABA problem: https://en.wikipedia.org/wiki/ABA_problem
- React, `useRef` (a value that changes without waiting for a re-render): https://react.dev/reference/react/useRef
