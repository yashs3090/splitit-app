---
name: retro
description: The SplitIt learning loop. Logs lessons from the last task (review findings, QA failures, user corrections) and proposes updates to agents, skills and CLAUDE.md for the user to approve; applies proposals the user has approved. Use after build-task, when the user says /retro, or when the user says to apply or reject a retro proposal.
---

# Retro: learn from the last task

## Mode A: run a retro
Run the `retro` agent with what happened in the task: the spec path, the reviewer's findings, the QA report, and the user's corrections. If you're running this outside build-task, gather that from the conversation first.

The agent follows these rules:

**1. Log.** Append one entry per lesson to `docs/lessons/log.md`:
```
## YYYY-MM-DD: <short title>  [area: money-math | rls | expo | edge-fn | receipt-parsing | testing | process]
- What happened:
- Why (root cause):
- Fix / rule:
- Source: R3 in review of <spec> / QA criterion 4 / user correction
```
Only log something that would change future behavior. Skip one-off typos.

**2. Promote** (as proposals, never applied directly):
- A lesson in the same area seen **twice or more** in the log becomes a rule in the agent that should have caught it, or in `CLAUDE.md` § Conventions.
- A multi-step workflow done by hand **twice or more** becomes a new skill. Draft it following the `skill-creator` skill's guidance (frontmatter `name` + `description` that says when to trigger).
- A rule that caused a wrong result gets a proposal to delete or reword it.
- A gap in the team (e.g. reviews keep missing accessibility) becomes a proposal for a new agent.

**3. Proposal format:** `docs/lessons/proposals/<YYYY-MM-DD>-<slug>.md` with **Status: pending**, the target file, the exact change, and the log entries that justify it.

Then tell the user which proposals are waiting and what each one does, in a sentence each.

## Mode B: apply decisions
When the user approves a proposal, apply its change exactly, set **Status: applied (YYYY-MM-DD)**, and mention it in your reply. When the user rejects one, set **Status: rejected** with their reason. That reason is itself a lesson; log it.
