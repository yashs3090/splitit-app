# Proposal: one view model gives every part of a screen its status

**Status: pending**

**Targets:** `.claude/agents/product-engineer.md` (§ Build, the "Components never do money arithmetic" bullet); `.claude/agents/code-reviewer.md` (item 5, Conventions and simplicity)

**Promotion rule used:** the same lesson twice or more (expo area). 2026-11-21 "Money math was duplicated in a component" was about amounts; settle early had five findings where parts of one screen worked out the same status separately and disagreed.

**Not a re-proposal of the rejected `2026-11-25-one-rule-one-implementation.md`.** That was a repo-wide `CLAUDE.md` bullet ("import, never copy"). This one is scoped to how a screen gets its status, and it goes only into the agent that builds screens and the reviewer. If you rejected the earlier one for a reason that applies here too, please say so. The 2026-11-25 rejection entry asks for that reason.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "Parts of one screen worked out the same status separately and disagreed" [expo]:
  - F5 (eng doc): the payer card said "Nobody owes you anything" while pay-backs were owed.
  - Review R2: the payer card and the footer disagreed.
  - R3: the footer icon was picked by matching the copy text.
  - R4: a stale pill stayed on a bill that was no longer a candidate.
  - QA F-1: the Everyone aside says "All paid" while differences are open.
  - All in docs/specs/2026-11-25-settle-early-and-differences.md.
- 2026-11-21 "Money math was duplicated in a component" [expo]: the first occurrence. It produced the current "Components never do money arithmetic" rule.
- Related: 2026-11-25 "The same rule again, in SQL: `private.settle_state` restates `bill_is_complete`" [money-math]. This proposal does not cover the SQL case (see the open question in that entry).

## Change 1: `.claude/agents/product-engineer.md`, § Build

Old:
```
- Components never do money arithmetic; `lib/` returns any derived amount. Money is integer cents, formatted only through `lib/money.ts`.
```

New:
```
- Components never do money arithmetic or work out a status ("settled", "owes", "all paid") themselves. One `lib/` view-model function per screen returns every part's status (cards, footer, asides, Home pills), and each part renders from it. Icons and tones are chosen from the status kind, never by matching copy text. Add a test that sets up each status and checks every part showing it agrees. Money is integer cents, formatted only through `lib/money.ts`.
```

## Change 2: `.claude/agents/code-reviewer.md`, item 5

Old:
```
5. **Conventions and simplicity:** duplication, needless abstraction, `any`.
```

New:
```
5. **Conventions and simplicity:** duplication, needless abstraction, `any`. Flag two parts of a screen (or a screen and its Home marker) that work out the same status in separate code, and any icon or tone picked by matching the copy text; give the state where they disagree.
```

## Change 3 (added 2026-11-27, Sent-via-Venmo retro; can be approved or rejected on its own): `code-reviewer` flags a rule decided in two places

Evidence: log 2026-11-27 "The undo rule and the method list were written out in more than one place" [money-math]. Review R6 (who may undo a mark, implemented twice) and R9 (the `venmo` / `cash` method subset spelled out again) in docs/specs/2026-11-26-sent-via-venmo.md. This is the fifth "same rule in two places", after 2026-11-22, 2026-11-24, 2026-11-25 (TypeScript) and 2026-11-25 (SQL).

**A question for you first.** You rejected the `CLAUDE.md` bullet "import, never copy" on 2026-11-25 without a reason. This change is narrower: it's only a check the reviewer makes, and it isn't a rule for the whole repo. If your reason was that copies are sometimes right (for example, one SQL statement for a consistent snapshot), the wording below allows a copy that has a test pinning it. If your reason applies here too, reject this change and say why; that reason gets logged.

Old (item 5 as Change 2 leaves it, end):
```
give the state where they disagree.
```

New:
```
give the state where they disagree. Also flag a rule or allowed-values list (who may undo, which methods count, a tolerance) that is decided in two places in the change. It should come from one function or constant, or the copy should have a test that runs both on the same cases.
```

## More evidence for Change 3 (added 2026-11-27, Who-paid retro; no new change)
Log 2026-11-27 "Settle used the target where Home used `remainingCents`, so the card asked for $2.00 instead of $5.00" [money-math]. Review R1 (blocking) of docs/specs/2026-11-26-who-paid.md: on spec case T13, `settleView` picked the route's target for the card, Venmo link and cash button, while Home picked `remainingCents`. Both read the same plan. This is the sixth "same rule decided in two places", and the first where the two places were two screens showing the amount someone is asked to pay. Change 3's reviewer check would have flagged it.

## What this changes for you
The card, footer and summary on a screen can't tell you different things ("All paid" next to "you owe $2"), because they all read the same answer from one place.
