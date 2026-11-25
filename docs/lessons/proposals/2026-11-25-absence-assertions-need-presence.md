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

## What this changes for you
Tests that say "this is gone" will prove they were looking in the right place, so leftovers like the ▴/▾ arrows get caught by the test suite instead of by a reviewer reading the screen.
