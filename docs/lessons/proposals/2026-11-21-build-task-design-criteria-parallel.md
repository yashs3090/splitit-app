# Proposal: build-task gets a design pass, a criteria-change gate, parallel-work rules and the before-production list

**Status:** applied 2026-11-21
**Target file:** `.claude/skills/build-task/SKILL.md` § Steps
**Promotion rules used:**
- User instructions (M1a): use the `ui-ux-designer` skill for screens; keep `docs/before-production.md` up to date. These are the user's own requests, so they don't need a second occurrence.
- "A multi-step workflow done by hand twice or more": asking the user before a fix changes an acceptance criterion, then recording an amendment, was done by hand three times in M1a (A2, A4.2, A5).
- Parallel-work collisions happened twice in M1a (ADR 0011 numbering; a docs task told to fix already-fixed text).

## Exact change

### Change 1: step 2 (implement)

Old:
```
2. **Implement:** for each task in the spec, in order, run the agent the task names (default `implementer`; `supabase-engineer` for `supabase/` work; `native-mobile` for camera, on-device text recognition or other native modules) with the spec path and the task number. Independent tasks that touch different files may run in parallel. Use `docs-writer` for larger doc changes in step 5.
```

New:
```
2. **Implement:** for each task in the spec, in order, run the agent the task names (default `implementer`; `supabase-engineer` for `supabase/` work; `native-mobile` for camera, on-device text recognition or other native modules) with the spec path and the task number. Use `docs-writer` for larger doc changes in step 5.
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself (the next ADR number from `docs/learning/decisions/README.md`, migration timestamps) and tell each agent its number. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place.
   - **Screens:** a task that adds or changes a screen gets a design pass with the `ui-ux-designer` skill after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
```

### Change 2: step 3 (review), new bullet

Old:
```
   - Stop after 3 review rounds. If blocking findings remain, tell the user and include them.
```

New:
```
   - Stop after 3 review rounds. If blocking findings remain, tell the user and include them.
   - If a finding's fix would change an acceptance criterion (or the spec's behavior), ask the user before sending it to the implementer. Record the answer as a dated amendment in the spec. The same applies when QA fails a criterion because its wording is wrong rather than the code.
```

### Change 3: step 5 (learning notes)

Old:
```
5. **Learning notes:** for each new concept, design decision or pattern this task introduced, add or update a note under `docs/learning/` (rules in `docs/learning/README.md`). Do this yourself, in the main session.
```

New:
```
5. **Learning notes:** for each new concept, design decision or pattern this task introduced, add or update a note under `docs/learning/` (rules in `docs/learning/README.md`). Do this yourself, in the main session. Also add an item to `docs/before-production.md` for every "for now", provisional or dev-only decision, and every production-only risk the reviewer or QA raised.
```

## Not proposed (and why)
- **Spawning agent types created mid-session** (use a general-purpose agent told to follow `.claude/agents/<name>.md`): happened once. Logged; promote if it recurs.

## Evidence (docs/lessons/log.md)
- "2026-11-21: Screens get a design pass; the user wants simple, uncluttered UI [area: expo]"
- "2026-11-21: Fixes that change an acceptance criterion go to the user first [area: process]"
- "2026-11-21: Parallel agents worked from a stale snapshot [area: process]"
- "2026-11-21: Keep `docs/before-production.md` current [area: process]"
- Spec `docs/specs/2026-11-20-m1a-scan-receipt.md`: Amendments A2, A4.2, A5.
