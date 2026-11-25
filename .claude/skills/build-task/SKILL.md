---
name: build-task
description: Build one SplitIt milestone or feature end to end with the agent team. Runs product-manager spec → implementer → code-reviewer (fix loop, max 3 rounds) → qa-tester → retro, then summarizes. Use when the user asks to build, implement or ship a milestone (M0, M1, …) or feature.
---

# Build a task with the team

Input: a milestone ID from `docs/plans/bill-splitting-app-2026-11-19.md` (e.g. `M1`) or a feature description.

## Steps
1. **Spec:** run the `product-manager` agent with the milestone or feature. It returns a spec path under `docs/specs/`. If the spec lists open questions that only the user can decide, ask the user before going on.
2. **Implement:** for each task in the spec, in order, run the agent the task names (default `implementer`; `product-engineer` for tasks that add or change a screen or user-facing flow; `supabase-engineer` for `supabase/` work; `native-mobile` for camera, on-device text recognition or other native modules) with the spec path and the task number. Use `docs-writer` for larger doc changes in step 5.
   - **Environment first:** before spawning any agent that needs the local database (supabase-engineer tasks, live reconciliation, QA's DB criteria), run `npm run db:status`. If Docker or the stack is down, ask the user to start Docker before you spawn the agent, rather than letting the agent report "not run".
   - **Measurement gate:** if the spec's tasks are judged by an eval, start the ground-truth task first and tell the user right away which answer files to check and how many. Before starting each optional stage, check the eval's checked-answer count; if the last verdict is still PROVISIONAL and the user hasn't said to build anyway, pause that stage and say why in one line instead of building it.
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself and tell each agent its number. An ADR number counts as reserved only once it's on disk: create `docs/learning/decisions/NNNN-<slug>.md` as a stub (title plus `**Status:** Reserved by <spec path>, <date>`) and add its row to `decisions/README.md` at the moment you hand it out; the docs task later fills the stub in. Migration timestamps are taken when the migration file is created, not in advance. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place. Keep at most two full test suites running at once.
   - **Another Claude session active:** send it, before work starts, the files this session owns, the ADR numbers it has reserved (on disk, as above), and the generated folders its tools write or delete (`public/opencv/`, `public/tesseract/`, `dist/`). Don't edit files the other session owns. Long-running tools (harnesses, exports) use their own copy of generated assets instead of the shared folder.
   - **Contract reconciliation:** if app tasks were written against database functions or tables before they existed (or in parallel with them), add a reconciliation step once the migrations apply and before review. Run the app's data layer against the live local DB (the `live-db-smoke` skill), compare function arguments and returned fields with what the app sends and reads, and check that every rule enforced on both sides (e.g. a totals tolerance) gives the same answer on the spec's boundary cases. Record any mismatch fix as a spec amendment.
   - **Docs that describe status run last:** a docs task that says what is or isn't built starts only after every task it describes has finished. Before the summary, check any "not built" / "pending" lines it wrote against the code.
   - **Screens:** a task that adds or changes a screen goes to `product-engineer`, which plans the screen with the `ui-ux-designer` skill before building and runs the design pass after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
3. **Review:** run the `code-reviewer` agent on the changes.
   - If the verdict is CHANGES REQUESTED, send the blocking and should-fix findings back to the `implementer`, then review again.
   - Stop after 3 review rounds. If blocking findings remain, tell the user and include them.
   - If a finding's fix would change an acceptance criterion (or the spec's behavior), ask the user before sending it to the implementer. Record the answer as a dated amendment in the spec. The same applies when QA fails a criterion because its wording is wrong rather than the code.
4. **QA:** run the `qa-tester` agent with the spec path. If Overall is FAIL, return to step 2 with the failing criteria (this counts toward the 3-round limit).
5. **Learning notes:** for each new concept, design decision or pattern this task introduced, add or update a note under `docs/learning/` (rules in `docs/learning/README.md`). Do this yourself, in the main session. Also add an item to `docs/before-production.md` for every "for now", provisional or dev-only decision, and every production-only risk the reviewer or QA raised.
6. **Retro:** run the `retro` agent with the spec path, all review findings, the QA report, and any corrections the user made during the task.
7. **Summary to the user:**
   - open user actions reported in an earlier task and still not done (e.g. "still open since M1a: move the Google variables out of the root `.env`"), first, with one line on why each matters
   - what was built
   - test/QA results
   - remaining issues
   - learning notes added
   - retro proposals awaiting approval (paths)

Don't commit or push unless the user asks.
