# Proposal: a test that checks something is absent first shows the place it looks is there

**Status: pending**

**Targets:** `.claude/agents/implementer.md` (How to work); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/visual-designer.md` (How you work, Tests bullet); `.claude/agents/code-reviewer.md` (item 4, Tests)

**Promotion rule used:** the same lesson twice or more (testing area). This is the ninth check in the log that reported "absent" because it couldn't see what it was looking for. The positive-control rule already lives in `qa-tester` for greps; this is the first time it bit a unit test, and the agents that write unit tests don't have it.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "A 'no glyphs' test passed because the part it checked was collapsed" [testing]: the ▴/▾ test ran with the shares summary collapsed, so the glyphs were never rendered and "absent" passed; review 2 found them still on screen.
- 2026-11-21 "`git grep` checks pass vacuously when files are untracked" [testing] (applied to `qa-tester` via `2026-11-21-qa-prove-negative-checks.md`)
- 2026-11-19 "Build guard literals so leak-check grep doesn't match them" [testing]
- 2026-11-22 "A grep criterion matched an unrelated identifier" [testing]
- 2026-11-24 "Spec said a grep 'matches nothing today', but it matched" [testing]
- 2026-11-25 "'Verify' marks on library facts paid off; bundle markers must be counted in the real file" [testing]
- 2026-11-25 "An npm hook wiped `public/opencv/` while the harness was reading it" [testing]

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

## What this changes for you
Tests that say "this is gone" will prove they were looking in the right place, so leftovers like the ▴/▾ arrows get caught by the test suite instead of by a reviewer reading the screen.
