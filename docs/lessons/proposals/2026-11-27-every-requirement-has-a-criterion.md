# Proposal: every requirement in the spec and its companion docs maps to a numbered criterion

**Status: pending**

**Targets:** `.claude/agents/product-manager.md` (Rules); `.claude/agents/code-reviewer.md` (item 4; Change 3b, added 2026-11-27); the checklist in the pending `2026-11-24-staff-engineer-review.md` (item 8). That proposal already carries the item-8 edit, so if it is applied first, skip Change 2 here.

**Promotion rule used:** same lesson twice or more in the log (process area). Spec content that had no numbered criterion went unbuilt or untested twice: a user decision with no criterion (2026-11-25, R9), and now two Sent-via-Venmo requirements, one of which was a blocking review finding.

## Evidence (docs/lessons/log.md)
- 2026-11-27 "Requirements written into the spec or UX brief, but without a numbered criterion, weren't built" [process]:
  - The "check Venmo" copy for write errors after an open is in D2 (docs/specs/2026-11-26-sent-via-venmo.md, the "Write errors after an open" line). It has no criterion, it wasn't built, and it became review R1 (blocking).
  - The chooser's keyboard behavior is in the UX brief's accessibility table (docs/specs/2026-11-26-sent-via-venmo-ux.md: "arrow keys or Tab between segments, Space/Enter selects"). Criterion 54 checks radio semantics only through `accessibilityState`. The keyboard behavior wasn't built, and it became QA N2.
- 2026-11-25 "Review nits on tests: a hand-built state, and a user-chosen option with no router test" [testing]: R9, a user decision added after A1 with no criterion.
- Related: 2026-11-27 "After Venmo opened, several endings could invite a second payment" [expo].

## Change 1: `.claude/agents/product-manager.md`, Rules, new bullet directly after the "Money math, privacy and RLS always get explicit acceptance criteria." bullet

Old:
```
- **Shared contracts are defined once.**
```
(Insert the bullet directly before this line; the line itself stays unchanged.)

New (inserted):
```
- **Every requirement has a criterion.** Agents build and test against the numbered criteria, not against prose. Before you hand the spec back, go through the D sections, every amendment, the UX brief and the visual design. Each behavior, copy line, error ending and accessibility row (role and state, keyboard keys, zoom and Dynamic Type) maps to a numbered criterion, or is marked **User check**. Add a short "Coverage" list at the end of the criteria naming anything you left out on purpose and why. Write accessibility criteria as what the person gets (for example "on web the radio exposes `aria-checked`; arrow keys move the selection"), not as the prop that's set.
```

## Change 2: `2026-11-24-staff-engineer-review.md`, checklist item 8, end (skip if already applied there)

Old:
```
The planned-breakage list and the task dependencies are complete.
```

New:
```
The planned-breakage list and the task dependencies are complete. Every behavior, copy line and accessibility row in the companion docs maps to a numbered acceptance criterion; list the ones that don't.
```

## Change 3 (added 2026-11-27, Home groups v2 retro): derived tables are re-derived when the user's rules change

Evidence: log 2026-11-27 "After several rule changes, one cell of the exhaustive table contradicted the user's binding rule" [process]. In review R2 of docs/specs/2026-11-26-home-groups-v2.md, D3's cell "Guest: E, none, `nothing` → hidden" hid a non-payer host who had claimed nothing, which breaks user rule 1. The user redefined the groups four times mid-spec, and the criteria tested the table rather than the rules. This is the third "amendment not carried to everything that restates it" (2026-11-24 ×2). This is the same coverage idea as Change 1, applied in the other direction: Change 1 maps prose to criteria, and Change 3 maps derived tables back to the rules they come from.

3a. `.claude/agents/product-manager.md`, Rules: at the end of the bullet Change 1 inserts, add:
```
When the spec has binding user rules and a table derived from them (a state table, a group-per-case table), each cell names the rule that decides it (rule 1, rule 4). Whenever the user changes or reverses a rule, re-derive every cell from the current rules and update the criteria that test them. A cell no rule decides is an open question, not a default.
```

3b. `.claude/agents/code-reviewer.md`, item 4 (Tests), add at the end of the item:
```
When the spec has binding user rules and a derived table, check a sample of the table's cells against the rules themselves, not only the code against the table.
```

## Change 4 (added 2026-11-27, Who-paid retro): an amendment that replaces a design replaces its criteria

Evidence: log 2026-11-27 "A user-requested page replaced the planned sheet, and its criteria didn't come with it" [testing]. A2 of docs/specs/2026-11-26-who-paid.md replaced the "Who paid?" sheet with a page built by another session, and dropped the sheet's criteria without new ones. Review round 1 R3, R12 and R13 found the page almost untested; A-50(a)–(j) were written in review, and QA's only failure (A-50(c)) was in that list. This is the third "requirement without a criterion" (2026-11-25, 2026-11-27 ×2).

4a. `.claude/agents/product-manager.md`, Rules: at the end of the bullet Change 1 inserts (after the 3a sentences, if applied), add:
```
An amendment that replaces a design (a sheet becomes a page, a flow is redone) replaces its criteria in the same amendment: map each old criterion to a new one, or mark it dropped with a reason. Work built outside the plan (another session, a direct user request) gets numbered criteria before it goes to review.
```

4b. `.claude/agents/code-reviewer.md`, item 4 (Tests), add at the end of the item (after the 3b sentence, if applied):
```
When an amendment replaced or dropped a design, check its old criteria were mapped or dropped with a reason, and that any new screen has criteria and router tests.
```

## What this changes for you
Things the design documents promise, like "tell Sam to check Venmo before paying again" or "arrow keys work on the chooser", become checklist items that get built and tested. They stop turning up as review or QA findings at the end.
