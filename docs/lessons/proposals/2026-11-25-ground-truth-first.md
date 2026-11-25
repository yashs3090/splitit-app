# Proposal: measurement work starts with the ground truth, and later stages are gated on it

**Status: applied 2026-11-25** (both changes applied exactly as written)

**Targets:** `.claude/agents/product-manager.md` (Rules); `.claude/skills/build-task/SKILL.md` (step 2)

**Promotion rule used:** a lesson in the same area seen twice or more becomes a rule in the agent that should have caught it.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "The eval couldn't show the change, because the motivating receipt's read lacked the lines" [receipt-parsing]: a parser rule was specced and built, and the eval had nothing to show it on.
- 2026-11-25 "A measurement slice built 15 tasks of stages before it had the answers to measure them" [receipt-parsing]: most of the scan-pipeline slice ran on 1 checked answer file; six stages were built and rejected on that data, and the shipping decision (S-1) still waits on the user's answer checks.

## Change 1: `.claude/agents/product-manager.md`, Rules, new bullet after "Tool facts are verified or marked."

Old:
```
- **Device checks say how the device reaches the backend.**
```

New:
```
- **Ground truth comes first in measurement work.** When a change is judged by an eval (a parser rule, a scan stage, a "does this help" setting), Task 1 is the ground truth and a baseline run: draft the answer files the decision needs, say how many must be checked (the receipt-eval minimum), and hand the checking to the user as a **User check** on day one. Before speccing a rule motivated by a specific receipt, confirm its saved read has the lines the rule needs. Order the remaining stages by expected value and gate them: an optional stage starts only after the previous verdict is no longer PROVISIONAL, unless the user says to build anyway knowing results will be provisional. Put this gate in open questions with the cost of each choice.
- **Device checks say how the device reaches the backend.**
```

(The `**Device checks…**` line is unchanged; it is shown only as the anchor. Its full text stays as it is.)

## Change 2: `.claude/skills/build-task/SKILL.md`, step 2, new sub-bullet after "Environment first"

Old:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel.
```

New:
```
   - **Measurement gate:** if the spec's tasks are judged by an eval, start the ground-truth task first and tell the user right away which answer files to check and how many. Before starting each optional stage, check the eval's checked-answer count; if the last verdict is still PROVISIONAL and the user hasn't said to build anyway, pause that stage and say why in one line instead of building it.
   - **Parallel tasks:** independent tasks that touch different files may run in parallel.
```

(Only the first sentence of the Parallel tasks bullet is shown as the anchor; the rest of that bullet is unchanged here. See `2026-11-25-reserve-numbers-across-sessions.md` for its own change.)

## What this changes for you
On the next scan or parser slice, the first thing you'd get is a short list of answer files to check, and the team would build fewer experimental stages until those answers exist. That means less code that gets built and then switched off, and a shipping decision that comes sooner. You can still say "build anyway" for any stage.
