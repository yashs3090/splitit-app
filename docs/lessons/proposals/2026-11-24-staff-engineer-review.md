# Proposal: a `staff-engineer` design review before implementation of bigger slices

**Status: pending**

**Targets:** new `.claude/agents/staff-engineer.md`; `.claude/skills/build-task/SKILL.md` step 1

**Promotion rule used:** a gap in the team becomes a proposal for a new agent. The user asked for this role in M3. It's the first occurrence, so treat this as optional: you may prefer to keep asking for it case by case. If you reject the new agent but want the step, keep Change 2 and replace "`staff-engineer`" with "a Plan agent told to follow the checklist in this proposal".

**Notes before applying:** agent files load at session start. Start a new session or branch before spawning it by name (lessons 2026-11-21, 2026-11-22).

## Evidence (docs/lessons/log.md)
- 2026-11-24 "A staff-engineer review before the screen tasks simplified the plan" [process]: a Plan agent dropped `AppState` return detection (false prompts on iOS, blind to blocked popups), made Pay call `openPaymentLink` synchronously so web popup blockers allow it, simplified `expected_cleared`, and merged three screen tasks that would have reworked the same files. One simplification (count-based `expected_cleared`) left a race the review found (R5), so the trade-off line is part of the agent's output below.
- 2026-11-24 "The spec assumed a library's API…" and "A second deadlock: the lock argument missed the locks Postgres takes for you" [process, rls] (added in the people-and-invites retro): the contacts picker's real permission needs and field shape, and an FK-induced lock order, are both things a whole-plan read with `node_modules` and the migrations open could have caught before coding. Checklist items 1 and 4 below were extended for them.
- 2026-11-22 "App and DB tasks built in parallel drifted from their shared contract" and 2026-11-21 "Parallel agents worked from a stale snapshot" [process]: cross-task problems that a whole-plan read before implementation is placed to catch.

## Change 1: new file `.claude/agents/staff-engineer.md`

```
---
name: staff-engineer
description: Reviews a SplitIt spec as a whole before implementation starts. Finds platform behavior that breaks the design, tasks that rework the same files, contracts the app and DB could implement differently, and simpler designs, each with its trade-off. Read-only; returns a technical brief for the product-manager to merge. Use in build-task after the user has answered the spec's open questions, for slices with screens on top of new DB functions, realtime, or more than about six tasks.
tools: Read, Grep, Glob
---

You are a staff engineer reviewing the SplitIt spec you were given before anyone writes code. You don't edit files. You return a brief.

## Before you start
Read `CLAUDE.md`, the spec, the ADRs it cites, and the `docs/lessons/log.md` sections for the areas it touches. Read the existing code each task builds on (cite `file:line`). For library or platform behavior the design depends on, check the installed package in `node_modules` and cite the file; if you can't, mark it "unverified".

## What to look for
1. **Platform traps:** behavior that differs between iOS, Android and web and breaks the design (app lifecycle events, popup blockers and user-gesture rules, deep and universal links, focus and visibility events). For each native library the spec relies on, what it actually returns and which permissions it needs, from its installed source (or "unverified" if it isn't installed yet).
2. **Rework:** tasks that change the same files one after another; propose a merge or a different order.
3. **Contracts:** anything both the app and the DB implement (arguments, stored fields, a rule). Is it defined once, and do both sides test the same boundary cases?
4. **State and races:** destructive actions decided on stale screen data, expected-state parameters, lock order between functions and triggers (including the locks FK checks, cascades and event inserts take implicitly), async steps whose failure isn't designed (including "the write worked, the reload failed").
5. **Simpler designs:** what can be cut for v1 without losing what the user asked for.

## Output (returned to the main session, not written to a file)
- Numbered recommendations. Each one has: the change, why (evidence with `file:line` or an installed-package citation), **what it gives up** (what the simpler version can't detect or do), and which tasks and criteria it affects.
- Anything that needs the user's decision (money, providers, hard to reverse, or departing from `CLAUDE.md` or an ADR), listed separately.
- Keep it under about 60 lines. Don't restate the spec.
```

## Change 2: `.claude/skills/build-task/SKILL.md`, new sub-bullet under step 1

Old:
```
1. **Spec:** run the `product-manager` agent with the milestone or feature. It returns a spec path under `docs/specs/`. If the spec lists open questions that only the user can decide, ask the user before going on.
```

New:
```
1. **Spec:** run the `product-manager` agent with the milestone or feature. It returns a spec path under `docs/specs/`. If the spec lists open questions that only the user can decide, ask the user before going on.
   - **Design review:** for slices with screens on top of new DB functions or realtime, or more than about six tasks, run `staff-engineer` on the answered spec. Give its brief to the `product-manager`, which merges it (for screen-heavy slices, into a UX brief as well) as a dated amendment and writes each simplification's trade-off into the spec's Risks. Items the brief marks as the user's decision go to the user.
```

(If the delegated-decisions proposal is also approved, both sub-bullets go under step 1, delegated decisions first.)

## What this changes for you
Bigger slices get one read-only "does this plan hold together" review before coding starts. In M3, that review is what removed the unreliable "detect return from Venmo" idea and cut three screen tasks to one. You can say no and keep asking for it only when you want it.
