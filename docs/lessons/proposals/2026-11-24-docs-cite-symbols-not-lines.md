# Proposal: learning docs cite code by file and symbol, not line number; the docs task is handed over whole and reported item by item

**Status: pending**

**Targets:** `.claude/agents/docs-writer.md` (Rules, Concept notes bullet; Report); `docs/learning/README.md` (concept-note template, "How we use it"); `.claude/skills/build-task/SKILL.md` (step 2, docs bullet) (Changes 3–4 added in the bill-markers retro)

**Promotion rule used:** a rule that caused a wrong result gets reworded. "Link real code as `path:line`" produced the stale lines in ADR 0014. Several sessions edit `lib/bills.ts` and other shared files at once, so line numbers go stale within the same day.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "Docs went stale: line numbers moved, and an ADR missed the amendment" [process]: ADR 0014's Code list points at old `lib/bills.ts` lines. ADR 0017 was stale after A1.
- 2026-11-22 "A docs agent reported a task as 'not built' because it ran before that task landed" [process]: an earlier case of docs going stale because of parallel work.

## Change 1: `.claude/agents/docs-writer.md`, Rules, the Concept notes bullet

Old:
```
Link real code as `path:line` once it exists; otherwise say "not built yet".
```

New:
```
Link real code as the file plus the symbol name (`lib/split.ts`, `computeShares`; a migration plus its function name) once it exists, never by line number: other sessions edit shared files in parallel and line numbers go stale. Otherwise say "not built yet". The same goes for ADR Code lists. When you edit a doc that still has `path:line` links, convert the ones you touch.
```

## Change 2: `docs/learning/README.md`, line 28

Old:
```
- **How we use it:** pointers to our code (`file:line` once it exists)
```

New:
```
- **How we use it:** pointers to our code (file plus function or symbol name once it exists; no line numbers, they go stale)
```

## Related change, made to an existing pending proposal
The other half of the lesson (an amendment wasn't carried to ADR 0017) extends Change 3 of `2026-11-24-pm-library-shapes-reachability-state-table.md`. That change now says to grep `docs/learning/` as well as tests and fixtures. It is edited there so that the two proposals don't both change the same sentence of `build-task`.

## Change 3 (added 2026-11-24, bill-markers retro): `.claude/skills/build-task/SKILL.md`, step 2, after the "Docs that describe status run last" bullet

**Promotion rule used:** the main session reports this is the second time its docs instructions dropped items the spec's docs task listed. Evidence: log entry 2026-11-24 "The docs handoff dropped items the spec's docs task listed (second time)" [process]: Task 7 of docs/specs/2026-11-24-bill-markers-and-notices.md (the concept note `in-app-notices.md`, the PI-6 status and the ADR 0016 note were skipped; the main session filled them in).

Old:
```
   - **Docs that describe status run last:** a docs task that says what is or isn't built starts only after every task it describes has finished. Before the summary, check any "not built" / "pending" lines it wrote against the code.
```

New:
```
   - **Docs that describe status run last:** a docs task that says what is or isn't built starts only after every task it describes has finished. Before the summary, check any "not built" / "pending" lines it wrote against the code.
   - **Hand the docs task over whole:** give `docs-writer` the spec path and the docs task number, plus any extra items, rather than your own summary of the task. Also give it the review findings and the QA report in full (paths or pasted text, not just ids like "R1, R6"), plus the decisions log entries it should cover. Before the summary, check its item-by-item report against the spec's docs criterion and do or re-assign anything skipped.
```

**Extended 2026-11-25 (settle-early retro), third occurrence:** the docs-writer couldn't document review R1 and R6 because it was given the ids without their text. Evidence: log 2026-11-25 "The docs handoff lacked the source material, third time" [process]. The added sentence is "Also give it the review findings and the QA report in full…".

## Change 4 (added 2026-11-24, bill-markers retro): `.claude/agents/docs-writer.md`, § Report

Old:
```
Files created/changed with a one-line summary each, anything left stale, and suggested changes to files you don't own.
```

New:
```
Files created/changed with a one-line summary each, anything left stale, and suggested changes to files you don't own. If you were given a spec's docs task, read that task in the spec yourself (not only the instructions you were handed) and list every bullet in it as done or skipped, with the reason for each skip.
```

## What this changes for you
Code links in the docs you study will keep pointing to the right place (the function name) even after the file changes. Every learning note and status update a spec asks for will either be written or be listed as skipped with a reason, so nothing quietly goes missing from what you study.
