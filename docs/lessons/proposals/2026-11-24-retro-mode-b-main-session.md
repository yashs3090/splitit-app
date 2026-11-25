# Proposal: say that the main session applies approved proposals (retro Mode B)

**Status: pending**

**Targets:** `.claude/skills/retro/SKILL.md` (Mode B); `.claude/agents/retro.md` (What you must only propose)

**Promotion rule used:** a rule that caused a wrong result gets reworded. The skill and the agent file disagreed, which cost one wasted round trip.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "The retro agent was asked to apply approved proposals and declined" [process]

## Change 1: `.claude/skills/retro/SKILL.md`, Mode B

Old:
```
## Mode B: apply decisions
When the user approves a proposal, apply its change exactly, set **Status: applied (YYYY-MM-DD)**, and mention it in your reply. When the user rejects one, set **Status: rejected** with their reason. That reason is itself a lesson; log it.
```

New:
```
## Mode B: apply decisions (main session only)
The main session does this itself. Don't hand it to the `retro` agent, which only logs and proposes. When the user approves a proposal, apply its change exactly, set **Status: applied (YYYY-MM-DD)**, and mention it in your reply. When the user rejects one, set **Status: rejected** with their reason. That reason is itself a lesson; log it.
```

## Change 2: `.claude/agents/retro.md`, end of "What you must only propose"

Old:
```
The user approves, and then the main session applies it.
```

New:
```
The user approves, and then the main session applies it. If you're asked to apply a proposal, don't. Reply that applying is the main session's job (retro skill, Mode B), and list the approved proposals' paths.
```

## What this changes for you
Nothing visible, apart from one less back-and-forth after you approve proposals.
