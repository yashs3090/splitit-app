# Proposal: build-task says how to run an agent that was created or changed in this session

**Status: pending**

**Target:** `.claude/skills/build-task/SKILL.md` (step 2, new sub-bullet after "Screens")

**Promotion rule used:** the same lesson three times in the log (process area). The 2026-11-21 entry said "promote if it happens again"; it happened in M1b+M2 and again now, and the workaround has always lived only in the log.

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Agent types created mid-session aren't spawnable until a new session" [process]: `supabase-engineer`, `docs-writer`, `native-mobile` ran as general-purpose agents told to follow their files.
- 2026-11-22 "Agents cut off by usage limits resume cleanly; new agent types appear after a session branch" [process]
- 2026-11-25 "A new agent type needed the general-purpose workaround a third time" [process]: `visual-designer`'s first audit ran this way.

## Change: `.claude/skills/build-task/SKILL.md`, step 2, new sub-bullet directly after the "Screens" sub-bullet

Old:
```
   - **Screens:** a task that adds or changes a screen goes to `product-engineer`, which plans the screen with the `ui-ux-designer` skill before building and runs the design pass after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
```

New:
```
   - **Screens:** a task that adds or changes a screen goes to `product-engineer`, which plans the screen with the `ui-ux-designer` skill before building and runs the design pass after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
   - **Agents created or changed this session:** agent files load when the session starts, so a new agent can't be spawned by name (and a changed one may still run its old text; unverified). Spawn a general-purpose agent whose prompt starts "Read and follow `.claude/agents/<name>.md`, including its tool limits", and say in the summary which tasks ran this way. A new session (or a session branch) picks the file up.
```

## What this changes for you
Nothing visible; it writes down the workaround that has worked three times, so agents you ask for (like the visual designer) can start on the same day without a restart.
