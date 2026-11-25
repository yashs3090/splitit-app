# Proposal: a rule that exists in `lib/` is imported, never copied

**Status: rejected 2026-11-25 by the user** (no reason given)

**Target:** `CLAUDE.md` § Conventions (new bullet right after the "A money rule enforced in both `lib/` and the database…" bullet)

**Promotion rule used:** a lesson in the same area seen twice or more becomes a rule in `CLAUDE.md` § Conventions. This is the third "same rule in two places" money-math lesson, and the first two copies that could simply have been imports.

## Evidence (docs/lessons/log.md)
- 2026-11-22 "A money rule enforced in both `lib/` and the DB must be the same rule" [money-math].
- 2026-11-24 "The app and DB rules for 'complete' now differ on purpose (K6)" and "A second deliberate app/DB difference…" (PI-M-1) [money-math].
- 2026-11-25 "The same rule copied instead of imported: the answer checker's tolerance and a price regex" [money-math]: `answers:check` used 0¢ against the parser's ±1¢ (S-R-4); `zoomOnDoubt` carried a copy of the parser's price regex, logged only at QA.
- 2026-11-21 "Money math was duplicated in a component" [expo]: the same habit in UI code.

## Exact change

Old:
```
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases.
```

New:
```
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases.
- Inside TypeScript, a rule that already exists in `lib/` (a money tolerance, `checkTotals` / `totalsGaps`, the price pattern, the user's receipt-line rules) is imported wherever it's needed: components, scripts, eval tools, other pipeline stages. Never copy it. If it truly can't be imported, the copy gets a test that runs both on the same boundary cases, and the deviation is logged in `docs/decisions-to-review.md` when it's made.
```

**Note on the pending proposal `2026-11-24-money-rule-exceptions-and-degenerate-cases.md`:** its Change 1 appends sentences to the first bullet. This proposal only adds a new bullet after it, so the two can be applied in either order; if both are approved, keep the first bullet as Change 1 rewrites it and add this bullet beneath it.

## What this changes for you
Checks like "does this receipt add up" will behave the same in the app, the eval and the answer-file checker, so a number you see in one place means the same thing in the others. Nothing changes in how the app works today.
