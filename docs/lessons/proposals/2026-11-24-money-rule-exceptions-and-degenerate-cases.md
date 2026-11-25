# Proposal: allow a documented, user-approved app/DB exception; list degenerate split inputs in specs

**Status: pending**

**Targets:** `CLAUDE.md` § Conventions; `.claude/agents/product-manager.md` (Rules)

**Promotion rule used:** money-math lessons now appear several times in the log. A rule that gave the wrong result (the "same rule" convention had no way to record a deliberate difference, so K6 was decided against it) gets reworded.

## Evidence (docs/lessons/log.md)
- 2026-11-22 "A money rule enforced in both `lib/` and the DB must be the same rule" [money-math]: the source of the current convention.
- 2026-11-24 "The app and DB rules for 'complete' now differ on purpose (K6)" [money-math]: review R2, decisions M3-B-12 and M3-R-1.
- 2026-11-24 "A seeded property test found a money case the spec's boundary tables missed" [money-math]: Q10 came from Task 4's 500-bill test, not the spec.
- 2026-11-21 "Invalid money input must never count as $0 or as 'adds up'" [money-math]: an earlier money edge case that the spec didn't list.
- 2026-11-24 "A second deliberate app/DB difference: the DB accepts 'I paid' from someone who owes nothing" [money-math] (added in the people-and-invites retro): PI-M-1. The screen hides "I paid" for a $0 share, but `mark_paid` accepts it, for the same reason as K6 (matching would need `computeShares` in SQL). Two cases of the same shape now, so Change 1 has more support.
- 2026-11-24 "Degenerate split cases again: negative shares are now reachable, and all-zero weights leave extras unclaimed" [money-math] (added in the claimable-discounts retro): claiming a discount makes a negative share reachable in normal use (CD-6, still "needs your look"). QA reached the all-zero-weights case again: the extras stay under Unclaimed while the bill counts as complete. Both are inputs that Change 2 already lists. This is the third time such a case came up mid-build rather than in the spec, so Change 2 has more support. No wording change.

## Change 1: `CLAUDE.md` § Conventions

Old:
```
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases.
```

New:
```
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases. The only exception is a deliberate difference the user approves. The spec's boundary table lists that case with both answers and the reason, and both sides test it (e.g. K6 in `docs/specs/2026-11-24-m3-settle-venmo.md`).
```

## Change 2: `.claude/agents/product-manager.md`, Rules, the "Money math, privacy and RLS" bullet

Old:
```
- Money math, privacy and RLS always get explicit acceptance criteria. Client calls written into criteria name their columns (`.select('venmo_username')`, never a bare `.select()` or `select('*')`): on tables with column-level grants, `*` fails with `42501` for everyone.
```

New:
```
- Money math, privacy and RLS always get explicit acceptance criteria. Client calls written into criteria name their columns (`.select('venmo_username')`, never a bare `.select()` or `select('*')`): on tables with column-level grants, `*` fails with `42501` for everyone. A spec that builds on `computeShares` lists the degenerate split inputs among its boundary cases: every weight 0 in proportional mode, no rows with a total above 0, a negative share in even mode, one participant, and a three-way remainder tie. It also asks for a seeded property test over random bills in both modes. If the property test finds a case that changes what someone sees or owes, it goes to the user (as Q10 did in M3).
```

## Before applying
K6 itself is still open for your review (M3-B-12 / M3-R-1 in `docs/decisions-to-review.md`), and so is PI-M-1 (people and invites). Approving Change 1 makes that kind of exception possible. It doesn't approve K6 or PI-M-1. If you'd rather keep the rule strict, reject Change 1, and K6 becomes a follow-up to add the all-$0 check to `private.bill_is_complete`.

## What this changes for you
Specs will list the odd money cases up front, such as all items at $0 or a negative share, so fewer of them turn up mid-build. When the app and the database are allowed to disagree on purpose, that becomes a decision you make explicitly, not something agents settle on their own.
