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

All four lock the row first (`for update`, `for share` or `for no key update`) and then compare. See [database functions](database-functions.md) for which lock each one takes and why.

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

## Pitfalls
- **Comparing without a lock.** "Read, compare, write" without `for update` or `for share` lets the value change between the compare and the write. Lock first.
- **Not deciding whether the "nothing to do" shortcut comes before the token check.** `set_payer` returns early (no error, nothing cleared) when you pick the current payer, *before* it looks at the token. That's deliberate: nothing would be destroyed, so a wrong count doesn't matter (criterion 9).
- **A token that's too coarse.** A count can come back to the same number (ABA). A timestamp with low resolution can repeat. Prefer something that changes on every relevant change: the exact set of ids, or a version number.
- **Showing raw server errors.** Map each token error to fixed copy that tells the person what to do ("check and try again").
- **Forgetting to re-read after the error.** The screen still shows the old snapshot. Refetch, then ask again.
- **Using a token where nothing can be lost.** It adds an error path the UI must handle. `mark_paid` repeated is a harmless no-op, so it has no "already marked" token.
- **Treating the token as security.** It protects honest people from stale screens. Who may call the function is still checked separately (`auth.uid()`, host checks).
- **A retry that fails because the first try worked.** If a response can be lost, a second identical call will see the new state and fail the token check. Decide whether "already done" should count as success (as in `settle_difference`), and put that check after the permission checks, so nobody can use it to skip them.
- **Using an amount as a token where the amount can come back.** A value that can go 1510 → 1400 → 1510 can't tell a replay from a fresh request. A version number that only goes up can.

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

## Learn more
- PostgreSQL, explicit locking and row-level locks (`FOR UPDATE`, `FOR SHARE`): https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL, `SELECT ... FOR UPDATE` / `FOR SHARE` (the locking clause): https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
- MDN, `If-Match` (the same idea in HTTP: "only change it if it's still the version I saw"): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-Match
- Wikipedia, optimistic concurrency control: https://en.wikipedia.org/wiki/Optimistic_concurrency_control
- Wikipedia, the ABA problem: https://en.wikipedia.org/wiki/ABA_problem
