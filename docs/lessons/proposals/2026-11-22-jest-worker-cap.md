# Proposal: cap Jest workers and simultaneous test runs

**Status:** applied 2026-11-22 (Changes 1-4 only; the optional Jest-config `maxWorkers` change was not approved and was not applied)
**Target files:** `CLAUDE.md` § Commands, `.claude/agents/qa-tester.md`, `.claude/agents/implementer.md`, `.claude/skills/build-task/SKILL.md`
**Promotion rule used:** a lesson in the same area (testing: timeouts under load) seen twice.

## Exact change

### Change 1: `CLAUDE.md` § Commands, Tests line

Old:
```
- Tests: `npm test` (Jest, `jest-expo` preset). Pure-logic tests sit next to the code in `lib/*.test.ts`; router tests live in `__tests__/` (never under `app/`, or Expo Router would treat them as routes). Shared test fakes are in `test-utils/`.
```

New:
```
- Tests: `npm test` (Jest, `jest-expo` preset). Pure-logic tests sit next to the code in `lib/*.test.ts`; router tests live in `__tests__/` (never under `app/`, or Expo Router would treat them as routes). Shared test fakes are in `test-utils/`. Agents run `npm test -- --maxWorkers=4` (Jest uses every core by default, and several agents' runs at once overload the machine and cause timeout-only failures), or one file with `npx jest <file>`.
```

### Change 2: `.claude/agents/qa-tester.md` § Steps, step 2

Old:
```
2. Run the full test suite and the type-check in each repo the task touched. If a test fails only with a timeout, re-run that file on its own (`npx jest <file>`) before reporting; if it passes alone, report it as flaky under load with both outputs.
```

New:
```
2. Run the full test suite (`npm test -- --maxWorkers=4`) and the type-check in each repo the task touched. If a test fails only with a timeout, check `uptime`, then re-run that file on its own (`npx jest <file>`) before reporting; if it passes alone, report it as flaky under load with both outputs and the load average.
```

### Change 3: `.claude/agents/implementer.md` § How to work

Old:
```
- Run the relevant tests and the type-check before you finish. Don't report success if they fail; report the failure output.
```

New:
```
- Run the relevant tests and the type-check before you finish. Run single files with `npx jest <file>` while working and the full suite with `npm test -- --maxWorkers=4`; other agents may be testing at the same time. Don't report success if they fail; report the failure output.
```

### Change 4: `.claude/skills/build-task/SKILL.md` § Steps, step 2, Parallel tasks bullet (append one sentence)

Old:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself (the next ADR number from `docs/learning/decisions/README.md`, migration timestamps) and tell each agent its number. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place.
```

New:
```
   - **Parallel tasks:** independent tasks that touch different files may run in parallel. Before starting them, hand out shared numbers yourself (the next ADR number from `docs/learning/decisions/README.md`, migration timestamps) and tell each agent its number. Tell docs or cleanup tasks to re-read each target file just before editing and skip fixes that are already in place. Keep at most two full test suites running at once.
```

Note: if this proposal is applied and it conflicts textually with `2026-11-22-build-task-parallel-contracts.md` (same bullet), apply both sentences.

## Optional (code change, needs the user's OK and an implementer)
Put `maxWorkers: 4` (or `"50%"`) in the Jest config in `package.json` so plain `npm test` is safe for everyone. It's simpler than remembering a flag, but it also slows the user's own runs on an idle machine. It's the user's call.

## Evidence (docs/lessons/log.md)
- "2026-11-21: Jest timeouts under heavy machine load are not real failures [area: testing]"
- "2026-11-22: Parallel Jest runs overloaded the machine; cap workers [area: testing]"
