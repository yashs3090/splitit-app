# Proposal: test runs go in the foreground with a time limit; a run past its limit is a hang

**Status: pending**

**Target:** `CLAUDE.md` § Commands, the Tests bullet (one sentence added at the end). It's in `CLAUDE.md` rather than the agent files because the main session and every agent read it, and the hung run was in an agent that isn't the only one that runs Jest.

**Promotion rule used:** the same lesson twice or more in the log (background work with no end).
- The first was 2026-11-25: a report was lost while background work was still running. That entry said to wait for every background command to finish, and to promote the rule if it happened again.
- The second is now: a backgrounded Jest loop hung for over 2 hours, and the agent kept "waiting on background work". "Wait until it finishes" has no upper bound, so a hang can't be told apart from a slow run.

## Evidence (docs/lessons/log.md)
- 2026-11-28 "A background test loop hung for over 2 hours, and the agent kept 'waiting on background work'" [testing]: another session found the stuck pid. The hang was in `__tests__/activity.test.tsx`.
- 2026-11-28 "Other sessions' changes broke our tests three times, one as a hang under Jest" [testing]: the cause was `expo-status-bar`'s `<StatusBar>` in `app/_layout.tsx`, found by bisecting. A per-file run with a limit would have pointed at the file within minutes.
- 2026-11-25 "An agent's report was lost twice while it still had background work" [process].
- 2026-11-27 "Machine load made single test files take over 340 s" [testing]: why a limit per call must allow for load. Chunking keeps each call under it.

## Change: `CLAUDE.md` § Commands, Tests bullet

Old:
```
Agents run `npm test -- --maxWorkers=4` (Jest uses every core by default, and several agents' runs at once overload the machine and cause timeout-only failures), or one file with `npx jest <file>`.
```

New:
```
Agents run `npm test -- --maxWorkers=4` (Jest uses every core by default, and several agents' runs at once overload the machine and cause timeout-only failures), or one file with `npx jest <file>`. Run tests in the foreground with the Bash tool's time limit set (up to 10 minutes). Don't start a run in the background and then wait on it. If the full suite won't fit in one call, run it in chunks of paths (for example `npx jest lib`, then `npx jest __tests__/[a-l]*`, then `npx jest __tests__/[m-z]*`). A run that passes its limit is a hang, not slowness: run that chunk's files one at a time (add `--detectOpenHandles` to the stuck one) and report the file. Don't wait longer. If something has to run in the background, check its output on a deadline, and treat 10 minutes with no new output as a hang.
```

## Compatibility
`2026-11-24-bundle-checks-jest-setup-tracked-items.md` Change 1 edits a different sentence in the same bullet ("Shared test fakes are in `test-utils/`."). They can be applied in either order.

## What this changes for you
A stuck test can no longer hold up a task for hours. It shows up within one time limit, with the file named, so it can be fixed (as the status-bar mock was) instead of waited on.
