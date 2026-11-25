# Proposal: product-engineer designs the "reload failed" path, guards outbound taps, and tests name/count copy

**Status: pending**

**Target:** `.claude/agents/product-engineer.md` (§ Build)

**Promotion rule used:** the async-flow lesson is now in the log three times (expo area). The copy-template lesson is new to the log but happened four times in this slice, and the fix is one test pattern.

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out" [expo]
- 2026-11-22 "App review: stale state, early optimism and lossy rollbacks" [expo]: "optimistic updates start only after what they depend on has committed", which pushes screens to wait for a refetch.
- 2026-11-24 "Waiting for the refetch meant a failed refetch left the buttons stuck" [expo]: review R1 (should-fix) and R7 (no double-tap guard on Pay).
- 2026-11-24 "Sentence templates broke at a count of 1 and when the name was 'You'" [expo]: R3, QA's "All 1 marked paid", M3-B-3, M3-B-4.

- 2026-11-24 "The refetch lesson was used before it was a rule, but 'never arrives' still has no answer" [expo] (added in the people-and-invites retro): the product-engineer followed the failed-refetch half from the log (PI-E-4), but chose no timeout for a refetch that never answers (PI-E-15), as the Settle screen does.

- 2026-11-25 "A failed refetch left Pay / I paid disabled again, because the rule is still only a proposal" [expo] (added in the Venmo request retro): review R1 of `docs/specs/2026-11-25-venmo-request-buttons.md`. The new bill-screen footer repeated the bug; fixed in A2 (`saveRefreshFailed`). Fourth occurrence, and it happened because this proposal hasn't been applied.
- 2026-11-25 "A 'Couldn't open Venmo' line outlived the payer and amount it described" [expo] (added in the same retro): review R2. Second occurrence after 2026-11-24 "A dismissal remembered on the device was keyed on the bill alone". This is the evidence for Change 2 below.

## Your choice before applying
Note (2026-11-25): the (a)/(b) choice below has held this proposal back while the failed-refetch bug came back. If you want time on the timeout question, apply (b) now; switching to (a) later is a one-line edit plus a follow-up task.

The first bullet below says a refetch that "never arrives" must also re-enable the controls. Two screens (Settle, and Add people per PI-E-15) currently don't, because that needs a timeout. Pick one:
- **(a) Keep it as written.** Both screens then need a timeout (a follow-up task), and new screens build one in.
- **(b) Drop the "or one that never arrives" part.** Replace "A failed refetch, or one that never arrives, re-enables the controls" with "A failed refetch re-enables the controls". The buttons stay busy until a later refetch (live update, focus, foreground) lands, as today.

## Change: `.claude/agents/product-engineer.md`, two new bullets in § Build, directly after the "Test the paths people actually hit…" bullet

Old:
```
- Only the root layout's resume effect navigates after sign-in. Screens don't hard-redirect once a session exists.
```
(Insert the two bullets directly before this line; the line itself stays unchanged.)

New (inserted):
```
- When the screen waits for a refetch to show a write's result (no optimistic update), treat the write and the refetch as two steps with their own endings. A failed refetch, or one that never arrives, re-enables the controls and shows an error with a retry, with a test. A control that opens something outside the app (a payment link, a share sheet) ignores repeat taps while it's opening, with a test.
- Every sentence that takes a name or a count is tested with a count of 1 and with the viewer as each name it takes (`nameOf` returns "You"). There should be no "All 1 …", no "You is …" and no "Hana changed … to Hana". If the spec's copy table doesn't say what those cases read, pick the wording and log it.
```

## Change 2 (added 2026-11-25; can be approved on its own): `.claude/agents/product-engineer.md`, one more bullet in § Build, directly after the two bullets above (still before the "Only the root layout's resume effect…" line)

New (inserted):
```
- A message, prompt or remembered choice about a specific thing (an error for one payment, a "Did you pay?" prompt, a dismissed notice) is stored with the facts that decide whether it's still true (the payer, whether the viewer is already marked, the membership time) and shown only while those match. Don't key it on details that can change while it stays true: a "Did you pay?" prompt keyed on the amount vanished when the share changed, though the person had already paid. Test both: change a deciding fact while it's showing (it goes), and change an incidental value such as the amount (it stays). On a live bill both change under the screen.
```

**Reworded 2026-11-25 (settle-early retro).** The earlier wording ("ids and values it describes (person, amount, membership time)… shown only while they still match") caused a wrong result: `openedStillMatches` in `lib/settleView.ts` followed it and dropped the prompt when the amount changed (F3 in docs/specs/2026-11-25-settle-early-and-differences-eng.md; review R5 / SE-R-5). Evidence: log 2026-11-25 "A pending rule would have caused F3: the prompt was keyed on the amount" [expo].

What it changes for you: lines like "Couldn't open Venmo to pay Hana $12" disappear when they stop being true (a different payer, or you're already marked paid), but a "Did you pay?" prompt doesn't vanish just because your share moved by a few cents.

## What this changes for you
Two kinds of bugs found late in M3 (buttons stuck after a failed reload, and odd sentences like "All 1 marked paid") get tested while the screen is built, instead of turning up in review or QA.
