# Proposal: product-engineer designs the "reload failed" path, guards outbound taps, and tests name/count copy

**Status: pending**

**Target:** `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/code-reviewer.md` (item 3; Changes 3b and 4b, added 2026-11-27)

**Promotion rule used:** the async-flow lesson is now in the log three times (expo area). The copy-template lesson is new to the log but happened four times in this slice, and the fix is one test pattern.

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out" [expo]
- 2026-11-22 "App review: stale state, early optimism and lossy rollbacks" [expo]: "optimistic updates start only after what they depend on has committed", which pushes screens to wait for a refetch.
- 2026-11-24 "Waiting for the refetch meant a failed refetch left the buttons stuck" [expo]: review R1 (should-fix) and R7 (no double-tap guard on Pay).
- 2026-11-24 "Sentence templates broke at a count of 1 and when the name was 'You'" [expo]: R3, QA's "All 1 marked paid", M3-B-3, M3-B-4.

- 2026-11-24 "The refetch lesson was used before it was a rule, but 'never arrives' still has no answer" [expo] (added in the people-and-invites retro): the product-engineer followed the failed-refetch half from the log (PI-E-4), but chose no timeout for a refetch that never answers (PI-E-15), as the Settle screen does.

- 2026-11-25 "A failed refetch left Pay / I paid disabled again, because the rule is still only a proposal" [expo] (added in the Venmo request retro): review R1 of `docs/specs/2026-11-25-venmo-request-buttons.md`. The new bill-screen footer repeated the bug; fixed in A2 (`saveRefreshFailed`). Fourth occurrence, and it happened because this proposal hasn't been applied.
- 2026-11-25 "A 'Couldn't open Venmo' line outlived the payer and amount it described" [expo] (added in the same retro): review R2. Second occurrence after 2026-11-24 "A dismissal remembered on the device was keyed on the bill alone". This is the evidence for Change 2 below.

- 2026-11-27 "After Venmo opened, several endings could invite a second payment" [expo] and "The Not received confirm took a fresh token…" [rls] (added in the Sent-via-Venmo retro): the sixth occurrence, with a blocking review finding. This is the evidence for Changes 3 and 4. **This is now the longest-pending fix for a repeated bug. If you have time for one proposal, make it this one.**
- 2026-11-27 "Kept settle facts outlived the payer they were about, fourth time for kept state" [expo] (added in the Home groups v2 retro): review R3. This is the evidence for Change 2b.
- 2026-11-27 "Group refetches could be superseded, and group calls had no time limit" [expo] (added in the Groups MVP retro): review R1 (an older refetch counted as finished) and R2 (no time limit). This is the seventh occurrence. GR-RV-2 gave every group call a 15 s `GROUP_REQUEST_TIMEOUT_MS` that reads as `network`, and retries reuse the client id, so a timed-out write that did land is a no-op. That's a working, built answer for option (a) below. Groups now does (a), while Settle and Add people still do (b).
- 2026-11-27 "A not-part error outlived the facts behind it, and `useNotPart`'s scope left out the bill (fifth time for kept state)" [expo] (added in the group claim status retro): review R1 and R6. This is the evidence for Change 2c.

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

**Change 2b (added 2026-11-27, Home groups v2 retro; apply with Change 2):** at the end of the Change 2 bullet, add:
```
The same goes for data kept from an earlier read (kept on a failed refresh, or carried while a new read loads): check it against the deciding facts in the newest data (the payer, membership, whether the bill is final) and drop it when they differ, with a test that changes the deciding fact between reads.
```
Evidence: log 2026-11-27 "Kept settle facts outlived the payer they were about, fourth time for kept state" [expo]. In review R3 of docs/specs/2026-11-26-home-groups-v2.md, `keepCandidates` kept a plan whose payer a newer summary had changed. The user's A1.S5 ("keep the previous groups when a refresh fails") makes kept data the normal case on Home. This is the fourth kept-state occurrence (2026-11-24, 2026-11-25 ×2, 2026-11-27).

**Change 2c (added 2026-11-27, group claim status retro; apply with Change 2 and 2b):** after the 2b sentence, add:
```
An error or busy flag a hook keeps is kept state too: tie it to the version or state it was raised under and clear it when that changes, unless it explains why nothing happened. A hook's reset key lists every id its data belongs to (the bill as well as the group), and a reset makes reads still in flight no-ops. Test by changing the version or the id while the error is showing or the read is pending.
```
Evidence: log 2026-11-27 "A not-part error outlived the facts behind it, and `useNotPart`'s scope left out the bill (fifth time for kept state)" [expo]. Review R1 and R6 of docs/specs/2026-11-27-group-claim-status.md. Change 2 as written would have covered R1, but it hasn't been applied. This is the fifth kept-state occurrence, and the third task in a row with one.

**Reword of Change 2b (added 2026-11-27, Who-paid retro):** in the 2b sentence, replace "(the payer, membership, whether the bill is final)" with "(the payers and their amounts, membership, whether the bill is final)". Evidence: log 2026-11-27 "Home's kept plan survived a change of co-payers, sixth time for kept state" [expo]. Review R11 of docs/specs/2026-11-26-who-paid.md: Home dropped a kept plan only when the lead payer changed, so a change of co-payers kept a stale plan. "The payer", singular, would have built the same bug.

**More evidence for Change 3 (added 2026-11-27, Who-paid retro):** log 2026-11-27 "Async endings, eighth time…" [expo]. The Who paid page had no time limit on its fetch and save (R5), a late write answer was unhandled (round 2 R1), and `clearLateSend` had none either (R2). The late-answer and repeat-tap parts are proposed separately in `2026-11-27-late-answers-and-one-tap.md`, which can be applied on its own.

What it changes for you: lines like "Couldn't open Venmo to pay Hana $12" disappear when they stop being true (a different payer, or you're already marked paid), but a "Did you pay?" prompt doesn't vanish just because your share moved by a few cents.

## Change 3 (added 2026-11-27, Sent-via-Venmo retro; can be approved on its own): async endings in `product-engineer`, and "money may have left" endings
Evidence: log 2026-11-27 "After Venmo opened, several endings could invite a second payment" [expo]. Review R1 (blocking), R3, R4, R10, QA N3 and the `useBill` superseded-refetch bug, all in docs/specs/2026-11-26-sent-via-venmo.md. This is the sixth occurrence. The applied 2026-11-25 async-endings rule went only into `implementer` and `code-reviewer`, and `product-engineer` built these screens.

**3a. `.claude/agents/product-engineer.md`, § Build: one more bullet, directly after the Change 2 bullet (still before "Only the root layout's resume effect…")**

New (inserted):
```
- Every async flow has an ending for success, error, cancel, sign-out and "never settles", and each re-enables the UI. Any await on something outside our control (a fetch, an RPC, a native module, a timer) has a time limit, and timers and scheduled work are cleared on sign-out. Only the latest refetch decides "finished"; a superseded one is ignored, not counted as done or failed. Once another app may have taken money (a payment link opened), no ending shows the pre-send screen or Pay as the next step: a refused write, "already marked", a network error or timeout, and "saved but the reload failed" each say to check that app before paying again, and a mark is never left behind for an open that failed. A write the server confirmed stays shown as done even if the reload after it fails. Test each ending.
```

**3b. `.claude/agents/code-reviewer.md`, item 3 (Correctness), one sentence after "…a heavy import that runs before the flag that needs it."**

(If `2026-11-25-visual-changes-keep-behavior.md` Change 4 is applied first, put this after the sentences it adds.)

Old:
```
a heavy import that runs before the flag that needs it.
```

New:
```
a heavy import that runs before the flag that needs it. For a flow that opens a payment app, walk every ending after the open (refused, already done, network or timeout, saved but reload failed, superseded reload, sign-out) and flag any that shows Pay again or generic copy instead of "check <app> before paying again".
```

What it changes for you: after you tap Pay and Venmo opens, nothing SplitIt shows afterwards (an error, a slow network, a failed reload) can look like "you haven't paid yet, pay again".

## Change 4 (added 2026-11-27, Sent-via-Venmo retro; can be approved on its own): expected-state tokens come from what the person saw
Evidence: log 2026-11-27 "The Not received confirm took a fresh token, which defeated the ABA guard" [rls] (review R2), and 2026-11-25 "Stale-token checks: the order of checks decides the error, and a value isn't a version" [rls]. This is the second stale-token lesson.

**4a. `.claude/agents/product-engineer.md`, § Build: one more bullet, directly after the 3a bullet**

New (inserted):
```
- An expected-state token (`p_expected_cents`, `p_expected_at`, a version) is taken from the data the person saw when they started the action (the row they tapped) and carried unchanged through any confirm step. Never re-read it at confirm time. Test it by changing the server state between the tap and the confirm and expecting "this changed, reload".
```

**4b. `.claude/agents/code-reviewer.md`, item 3, after the 3b sentence**

New (appended):
```
Flag any expected-state token that's read again at confirm or submit time instead of carried from what the person tapped.
```

What it changes for you: a "Not received" or "Undo" confirm can't act on a newer mark that appeared while the confirm was open.

## What this changes for you
Two kinds of bugs found late in M3 (buttons stuck after a failed reload, and odd sentences like "All 1 marked paid") get tested while the screen is built, instead of turning up in review or QA.
