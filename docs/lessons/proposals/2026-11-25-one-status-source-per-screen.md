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

## What this changes for you
The card, footer and summary on a screen can't tell you different things ("All paid" next to "you owe $2"), because they all read the same answer from one place.
