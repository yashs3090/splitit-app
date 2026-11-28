# Proposal: a `staff-engineer` design review before implementation of bigger slices

**Status: pending**

**Targets:** new `.claude/agents/staff-engineer.md`; `.claude/skills/build-task/SKILL.md` step 1

**Promotion rule used:** a gap in the team becomes a proposal for a new agent. The user asked for this role in M3. **Updated 2026-11-25 (settle-early retro):** it has now paid off twice, so it's no longer marked optional. In settle early, the review found 7 must-fixes before any code. If you reject the new agent but want the step, keep Change 2 and replace "`staff-engineer`" with "a Plan agent told to follow the checklist in this proposal".

**Notes before applying:** agent files load at session start. Start a new session or branch before spawning it by name (lessons 2026-11-21, 2026-11-22).

## Evidence (docs/lessons/log.md)
- 2026-11-24 "A staff-engineer review before the screen tasks simplified the plan" [process]: a Plan agent dropped `AppState` return detection (false prompts on iOS, blind to blocked popups), made Pay call `openPaymentLink` synchronously so web popup blockers allow it, simplified `expected_cleared`, and merged three screen tasks that would have reworked the same files. One simplification (count-based `expected_cleared`) left a race the review found (R5), so the trade-off line is part of the agent's output below.
- 2026-11-24 "The spec assumed a library's API…" and "A second deadlock: the lock argument missed the locks Postgres takes for you" [process, rls] (added in the people-and-invites retro): the contacts picker's real permission needs and field shape, and an FK-induced lock order, are both things a whole-plan read with `node_modules` and the migrations open could have caught before coding. Checklist items 1 and 4 below were extended for them.
- 2026-11-22 "App and DB tasks built in parallel drifted from their shared contract" and 2026-11-21 "Parallel agents worked from a stale snapshot" [process]: cross-task problems that a whole-plan read before implementation is placed to catch.
- 2026-11-25 "Plans, UX, visual and eng design before code: the staff-engineer review found 7 must-fixes" [process] (added in the settle-early retro): F1 `max_rows` truncation, F2 the $0-mark trap, F3 the prompt dropped on an amount change, F4/F5 spec contradictions, F6/F7 missing breakage and dependencies (docs/specs/2026-11-25-settle-early-and-differences-eng.md). Checklist items 6–8 and the "after UX and visual docs" wording in Change 2 come from it. Related entries: "PostgREST `max_rows` cuts results off…" [rls], "A $0 mark was a trap…" [money-math].

- 2026-11-27 "Staged design before code paid off a third time" and "expo-notifications always adds the push entitlement…" [process, expo] (added in the Sent-via-Venmo retro): the review (F1–F12, §11) caught the SecureStore key format and a check-in key that could never match. A read-only spike of the installed `expo-notifications` config plugin found the push entitlement it always adds. Item 1 below now names config plugins. Separately, 2026-11-27 "Requirements written into the spec or UX brief, but without a numbered criterion, weren't built" [process] adds coverage to item 8. That edit is also in `2026-11-27-every-requirement-has-a-criterion.md`, so whichever one is applied first, the other skips it.

- 2026-11-27 "A pre-build UX critique paid off, the fourth staged design" [process] (added in the Home groups v2 retro): before code, the visual-designer's impeccable critique (M1–M3, S1–S8, docs/specs/2026-11-26-home-groups-v2-ux-review.md) replaced a one-off toggle with the shared `DisclosureRow`. It also gave the user four decisions (M2, M3, S5, S7) before any code. Review round 1 approved the build with should-fixes only. This is the fourth time a whole-plan read has paid off.

- 2026-11-27 "The staff-engineer review before code found 4 blocking issues, the fifth staged design to pay off" [process] (added in the Groups MVP retro): `docs/specs/2026-11-26-groups-mvp-eng.md` gave 4 blocking findings (B1 migration sequencing with another session, B2 a `leave_group` × `edit_expense` deadlock, B4 missing activity kinds), 15 should-fixes and 9 nits, all before T2–T7. The code review then approved with should-fixes only, and T12's live reconciliation needed no lib or DB change. B1 is a cross-session item, so checklist item 6 (missing breakage and dependencies) should name other sessions' migrations as well.

- 2026-11-28 "The design review before building changed the colours and caught a pressed-state clash, the sixth staged design" [process] (added in the tab-bar-and-Activity retro): before code, the review for docs/specs/2026-11-28-tab-bar-and-activity.md changed disputes from red to light orange and made read lines neutral grey. It also found that the settled row's `surfaceMuted` fill equals `ListRow`'s pressed colour, and Contract M fixed that before coding. The user approved the visuals as built. Review R1 (7 suites' call logs broken by the tab bar's reads) is the kind of cross-task breakage checklist item 6 is for, so that item should also name "components every screen mounts".

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
1. **Platform traps:** behavior that differs between iOS, Android and web and breaks the design (app lifecycle events, popup blockers and user-gesture rules, deep and universal links, focus and visibility events). For each native library the spec relies on, what it actually returns and which permissions it needs, from its installed source (or "unverified" if it isn't installed yet). For each config plugin, what it adds to the native project (entitlements, permissions, Info.plist keys) and whether the user's signing setup (the free Personal Team) can build with it.
2. **Rework:** tasks that change the same files one after another; propose a merge or a different order.
3. **Contracts:** anything both the app and the DB implement (arguments, stored fields, a rule). Is it defined once, and do both sides test the same boundary cases?
4. **State and races:** destructive actions decided on stale screen data, expected-state parameters, lock order between functions and triggers (including the locks FK checks, cascades and event inserts take implicitly), async steps whose failure isn't designed (including "the write worked, the reload failed").
5. **Simpler designs:** what can be cut for v1 without losing what the user asked for.
6. **Server limits:** reads that can hit a server-side cap that truncates without an error (PostgREST `max_rows` in `supabase/config.toml`, column length limits). Each needs paging or an exact-count check that fails closed, never a hard-coded copy of the limit.
7. **Degenerate values:** what every new rule (leave, remove, undo, notices, cards) does for a person whose share is $0 or negative, an empty bill, and a bill with one person.
8. **The documents agree:** the spec, the UX brief and the visual design don't contradict each other or themselves (a state in one table and missing from another, two rows for the same case). The planned-breakage list and the task dependencies are complete. Every behavior, copy line and accessibility row in the companion docs maps to a numbered acceptance criterion; list the ones that don't.

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
   - **Design review:** for slices with screens on top of new DB functions or realtime, or more than about six tasks, run `staff-engineer` on the answered spec, last and before any code: if there's a UX brief or visual design, it reviews them together with the spec. Give its brief to the `product-manager`, which merges it (for screen-heavy slices, into a UX brief as well) as a dated amendment and writes each simplification's trade-off into the spec's Risks. Items the brief marks as the user's decision go to the user.
```

(If the delegated-decisions proposal is also approved, both sub-bullets go under step 1, delegated decisions first.)

## What this changes for you
Bigger slices get one read-only "does this plan hold together" review before coding starts. In M3, that review is what removed the unreliable "detect return from Venmo" idea and cut three screen tasks to one. You can say no and keep asking for it only when you want it.
