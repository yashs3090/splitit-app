# Proposal: a test that checks something is absent first shows the place it looks is there

**Status: pending**

**Targets:** `.claude/agents/implementer.md` (How to work); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/visual-designer.md` (How you work, Tests bullet); `.claude/agents/code-reviewer.md` (item 4, Tests); `.claude/agents/supabase-engineer.md` (Change 5, added in the settle-early retro)

**Promotion rule used:** the same lesson twice or more (testing area). This is the ninth check in the log that reported "absent" because it couldn't see what it was looking for. The positive-control rule already lives in `qa-tester` for greps; this is the first time it bit a unit test, and the agents that write unit tests don't have it.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "A 'no glyphs' test passed because the part it checked was collapsed" [testing]: the ▴/▾ test ran with the shares summary collapsed, so the glyphs were never rendered and "absent" passed; review 2 found them still on screen.
- 2026-11-21 "`git grep` checks pass vacuously when files are untracked" [testing] (applied to `qa-tester` via `2026-11-21-qa-prove-negative-checks.md`)
- 2026-11-19 "Build guard literals so leak-check grep doesn't match them" [testing]
- 2026-11-22 "A grep criterion matched an unrelated identifier" [testing]
- 2026-11-24 "Spec said a grep 'matches nothing today', but it matched" [testing]
- 2026-11-25 "'Verify' marks on library facts paid off; bundle markers must be counted in the real file" [testing]
- 2026-11-25 "An npm hook wiped `public/opencv/` while the harness was reading it" [testing]
- 2026-11-26 "Absence check without a positive control, eleventh time…" and "Guard tests that couldn't fail on React 19…" [testing] (added in the home-mobile-refresh retro; see Changes 6 and 7)
- 2026-11-27 "Absence check without a positive control, thirteenth time: hidden, but back in another form" [testing] (added in the Home groups v2 retro; see Change 8)

## Change 1: `.claude/agents/implementer.md`, How to work, new bullet directly before the "Follow the conventions in `CLAUDE.md`" bullet

Old:
```
- Follow the conventions in `CLAUDE.md`: integer cents, strict TypeScript, RLS on every table, no secrets in the app.
```
(Insert the bullet directly before this line; the line itself stays unchanged. It doesn't touch the lines that pending proposals insert after "Tests first for pure logic" or replace in the navigation bullet.)

New (inserted):
```
- A test that asserts something is absent (`queryBy…` returns null, `not.toHaveTextContent`, "no X anywhere") first asserts, in the same render and state, that the region it searches is on screen (a sibling label, the expanded section's heading). If the region has states (collapsed and expanded, empty and filled), run the absence check in each state that shows it. An absence check that can't see the region passes no matter what.
```

## Change 2: `.claude/agents/product-engineer.md`, § Build, new bullet directly before the "Follow `CLAUDE.md`" bullet

Old:
```
- Follow `CLAUDE.md`: strict TypeScript, no `any` without a comment, no secrets in the app.
```
(Insert directly before this line; the line itself stays unchanged.)

New (inserted):
```
- An absence assertion (`queryBy…` is null, `not.toHaveTextContent`) is paired with a presence assertion in the same state that shows the region it searches is rendered; run it in every state that shows that region (collapsed and expanded).
```

## Change 3: `.claude/agents/visual-designer.md`, How you work, the Tests bullet (first sentence only)

Old:
```
- **Tests:** update router tests that assert layout details you changed, and keep every behavior assertion passing.
```

New:
```
- **Tests:** update router tests that assert layout details you changed, and keep every behavior assertion passing. When you remove something (glyphs, an old label) and test that it's gone, first assert the region is rendered in that state, and check each state that shows it (collapsed and expanded).
```

## Change 4: `.claude/agents/code-reviewer.md`, item 4 (Tests), replace only this phrase

Old:
```
tests that don't actually assert the behavior.
```

New:
```
tests that don't actually assert the behavior, including an absence assertion that never shows the region it searches was rendered in that state (a "not shown" check run with the section collapsed passes no matter what).
```
(This phrase survives the pending `2026-11-24-parser-changes-differential-guard.md` and `2026-11-24-screen-open-effects-every-entry-route.md` changes to item 4, so it can be applied before or after them.)

## Change 5 (added 2026-11-25, settle-early retro): `.claude/agents/supabase-engineer.md`, new bullet directly after the pgTAP-fixtures bullet

Evidence: log 2026-11-25 "pgTAP 'settled_at unchanged' checks couldn't fail, because `now()` is fixed in a transaction" [testing]. Review R1 of docs/specs/2026-11-25-settle-early-and-differences.md: the checks would have passed even if `settled_at` was rewritten. They were fixed by backdating, and a mutation run proved it. This is the tenth check that couldn't fail, and the second `now()` finding (2026-11-24 "Activity order inside one edit is random…").

Old (anchor; unchanged):
```
- pgTAP assertions filter to the rows the test created (fixture ids or a unique tag), never whole-table counts or selects. The local DB may hold the user's real data, because we apply migrations with `migration up` rather than `db:reset`. A test that only passes on an empty DB is a bug.
```

New (inserted directly after it):
```
- `now()` returns the same time for the whole test transaction, so an "unchanged" check on a timestamp (`settled_at`, `updated_at`) first sets it to a known past value, so a wrongful rewrite would show up. Every new "unchanged" or "nothing written" assertion is run once against a deliberately broken version of the function (then reverted) to show it can fail; say so in your report.
```

## Change 6 (added 2026-11-26, home-mobile-refresh retro): wait for the new data, not just the region

Evidence: log 2026-11-26 "Absence check without a positive control, eleventh time, and assertions that ran before the data landed" [testing]. Review R1 (should-fix) of docs/specs/2026-11-26-home-mobile-refresh.md, criterion 38: "Your share" absent for an `early` plan passed before the plan loaded, because a row with no plan already shows "Total". R3: an assertion ran before the refresh's list landed. The reviewer called it "about the 10th time". This proposal has been pending since 2026-11-25, and the lesson keeps coming back because no agent file has it yet. It is the most repeated unapplied lesson in the log, so it's the one most worth approving.

Apply after Changes 1, 2 and 4; each adds one sentence to the text those changes insert.

6a. In the bullet Change 1 inserts into `implementer.md`, after "An absence check that can't see the region passes no matter what.", add:
```
When the screen loads or refreshes data, first wait for a marker that only the new data produces (the early plan's "Total" amount, a row only the refreshed list has), then assert. A region rendered from the old data counts as not seen.
```

6b. At the end of the bullet Change 2 inserts into `product-engineer.md`, add:
```
With async data, first wait for a marker that only the new data produces, then assert.
```

6c. In the phrase Change 4 puts into `code-reviewer.md`, after "(a "not shown" check run with the section collapsed passes no matter what)", add:
```
, or one that runs before the data it's about has loaded
```

## Change 7 (added 2026-11-26, home-mobile-refresh retro): guard tests are shown to fail

Evidence: log 2026-11-26 "Guard tests that couldn't fail on React 19, and a state tested only through another state's path" [testing]. R2: an "answer after unmount sets no state" test couldn't fail on React 19 (no warning, and the focus cleanup already bumps `latest`); the replacement tests hold a read open while Profile is open and were proven to fail with the guards removed. R4: D6's pending state was only tested through the failure path. Same family as Change 5 (pgTAP checks proven against a broken function).

7a. `.claude/agents/implementer.md`, How to work: insert directly after the bullet Change 1 inserts:
```
- A test for a guard (a stale response, an answer after unmount or after leaving the screen) holds the request open with a deferred promise, causes the situation, then resolves the promise and checks what's on screen. Don't rely on React warnings; React 19 doesn't warn about state set after unmount. Run the test once with the guard removed to show it fails, put the guard back, and say so in your report. Each state the spec lists (pending, failed, done) gets its own test.
```

7b. `.claude/agents/product-engineer.md`, § Build: insert directly after the bullet Change 2 inserts:
```
- Guard tests (stale response, after unmount) hold the request open with a deferred promise and are run once with the guard removed to show they fail. Each listed state (pending, failed, done) gets its own test.
```

7c. `.claude/agents/code-reviewer.md`, item 4, after the text Change 4 (and 6c) adds, before the sentence "For navigation and auth flows":
```
 Flag a guard test that would pass with the guard removed (for example one that relies on a React warning, or on another guard that covers the same path), and a listed state that's only tested through another state's path.
```

## Change 8 (added 2026-11-27, Home groups v2 retro): "hidden" is proved by the full list, not by one form being absent

Evidence: log 2026-11-27 "Absence check without a positive control, thirteenth time: hidden, but back in another form" [testing]. Review R5 of docs/specs/2026-11-26-home-groups-v2.md: `S2_HIDDEN` in `__tests__/homeMarkers.test.tsx` checked that S2's paid label and "Paid $14.80" were absent. If S2 had come back as its no-plan label, the check would still have passed. The fix compares the full list of row labels with the expected list. **This is the thirteenth occurrence, and all of them came after this proposal was written on 2026-11-25. It's the most repeated unapplied lesson in the log.** If only part can be approved, approve Changes 1, 2 and 4.

8a. In the bullet Change 1 inserts into `implementer.md`, after the sentence Change 6a adds, add:
```
To show that something is hidden from a list, assert the exact full list that is shown (every row label, in order), not the absence of one form of the hidden item. A row can render in several forms (with or without a plan, with or without a pill).
```

8b. At the end of the bullet Change 2 inserts into `product-engineer.md` (after 6b), add:
```
"Hidden from the list" is asserted as the exact list shown, not as one label being absent.
```

8c. In the text Change 4 puts into `code-reviewer.md` (after 6c's addition), add:
```
, or a "hidden" check that looks for one form of the item instead of comparing the full list shown
```

## What this changes for you
Tests that say "this is gone" will prove they were looking in the right place, so leftovers like the ▴/▾ arrows get caught by the test suite instead of by a reviewer reading the screen. Tests that wait for data will wait for the new data, and tests for "ignore a late answer" guards will be shown to fail when the guard is missing.
