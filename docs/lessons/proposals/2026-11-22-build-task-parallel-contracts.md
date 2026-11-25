# Proposal: reconcile parallel app/DB work, run status-describing docs last, surface repeated user actions

**Status:** applied 2026-11-22 (Change 1: "(the `live-db-smoke` skill, if approved)" written without "if approved", since that skill was approved and created the same day; the Parallel tasks bullet also carries the jest-worker-cap sentence)
**Target files:** `.claude/skills/build-task/SKILL.md`, `.claude/agents/docs-writer.md`, `.claude/agents/product-manager.md`, `CLAUDE.md` § Conventions
**Promotion rules used:**
- Stale parallel context (process) has now happened three times: M1a ADR numbering, M1a "fix already-fixed text", M1b+M2 app/DB contract drift and the "Task 19 not built" docs line. The current build-task rule didn't cover the last two, so this rewords and extends it.
- Money-math totals-check lessons seen twice (M1a invalid input counted as "adds up"; M1b+M2 DB and form checks disagreeing).
- Repeated user action (root `.env` Google variables) reported in two QA reports without being acted on.

## Exact change

### Change 1: `build-task` step 2, new bullet after "Parallel tasks"

Old:
```
   - **Screens:** a task that adds or changes a screen gets a design pass with the `ui-ux-designer` skill after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
```

New:
```
   - **Contract reconciliation:** if app tasks were written against database functions or tables before they existed (or in parallel with them), add a reconciliation step once the migrations apply and before review. Run the app's data layer against the live local DB (the `live-db-smoke` skill, if approved), compare function arguments and returned fields with what the app sends and reads, and check that every rule enforced on both sides (e.g. a totals tolerance) gives the same answer on the spec's boundary cases. Record any mismatch fix as a spec amendment.
   - **Docs that describe status run last:** a docs task that says what is or isn't built starts only after every task it describes has finished. Before the summary, check any "not built" / "pending" lines it wrote against the code.
   - **Screens:** a task that adds or changes a screen gets a design pass with the `ui-ux-designer` skill after the behavior is in and its tests pass, before review. The user wants screens simple and uncluttered.
```

### Change 2: `build-task` step 7, new first bullet

Old:
```
7. **Summary to the user:**
   - what was built
```

New:
```
7. **Summary to the user:**
   - open user actions reported in an earlier task and still not done (e.g. "still open since M1a: move the Google variables out of the root `.env`"), first, with one line on why each matters
   - what was built
```

### Change 3: `.claude/agents/docs-writer.md` § Rules, new bullet after "Facts:"

Old:
```
- Facts: cite official docs for anything about a library or service. If you can't verify it, label it "unverified".
```

New:
```
- Facts: cite official docs for anything about a library or service. If you can't verify it, label it "unverified".
- Build status: before writing that something is "not built", "pending" or "planned", check the code for it right then (other agents may be building it in parallel). If you can't tell, say "status not checked" rather than guessing.
```

### Change 4: `.claude/agents/product-manager.md` § Rules, new bullet after "Money math, privacy and RLS always get explicit acceptance criteria."

Old:
```
- Money math, privacy and RLS always get explicit acceptance criteria.
```

New:
```
- Money math, privacy and RLS always get explicit acceptance criteria.
- **Shared contracts are defined once.** When the app and the database both implement something (a function's arguments and result, a stored field the UI must reload exactly, a validation rule such as a totals tolerance), define it in one place in the spec (formula, tolerance, field list) and have both tasks point to it. Add boundary-case criteria that both sides must pass (exactly at tolerance, 1¢ over, off by 1¢ on each of two checks). Store what the UI needs to reload a form exactly; don't make it re-derive it (e.g. where a discount applied).
```

### Change 5: `CLAUDE.md` § Conventions, after the "Money is integer cents" bullet

Old:
```
- Pure logic (split math, payment-link builders, validators) lives in `lib/` with unit tests next to it (`*.test.ts`).
```

New:
```
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases.
- Pure logic (split math, payment-link builders, validators) lives in `lib/` with unit tests next to it (`*.test.ts`).
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: Parallel agents worked from a stale snapshot [area: process]"
- "2026-11-22: App and DB tasks built in parallel drifted from their shared contract [area: process]"
- "2026-11-22: A docs agent reported a task as "not built" because it ran before that task landed [area: process]"
- "2026-11-21: Invalid money input must never count as $0 or as "adds up" [area: money-math]"
- "2026-11-22: A money rule enforced in both `lib/` and the DB must be the same rule [area: money-math]"
- "2026-11-21: Root `.env` carries Google OAuth variables [area: expo]" and "2026-11-22: Root `.env` still carries Google OAuth variables (reported again) [area: expo]"
- Spec: Amendment A3 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md
