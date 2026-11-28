# Proposal: tests build data through the shared builders in `test-utils/`, not raw row literals

**Status: pending**

**Targets:** `.claude/agents/implementer.md` (§ How to work, after the first bullet); `.claude/agents/product-engineer.md` (§ Build, first bullet)

**Promotion rule used:** the same lesson twice or more in the log (testing area).
- 2026-11-25: review R6 found a test state built by hand instead of through the code that makes it.
- 2026-11-28: raw snapshot literals broke when another session made `money_fingerprint` required. Tests built with `snapshotOf` kept passing.

## Evidence (docs/lessons/log.md)
- 2026-11-28 "Hand-built raw fixtures broke on a contract change; the shared fixture didn't" [testing].
- 2026-11-28 "Other sessions' changes broke our tests three times, one as a hang under Jest" [testing], item (3).
- 2026-11-25 "Review nits on tests: a hand-built state, and a user-chosen option with no router test" [testing] (R6, docs/specs/2026-11-25-settle-early-and-differences.md).
- Related: 2026-11-24 "A 'can't happen' row was false, and a fixture kept the old answer after the amendment" [process].

## Change 1: `.claude/agents/implementer.md`, § How to work, new bullet directly after the first

Old:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
```

New:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
- Build test data through the shared builders in `test-utils/` (for example `snapshotOf` in `groupSnapshotFixtures.ts`, `feedFixtures.ts`, `groupFixtures.ts`, `fakes.ts`) or through the app's own functions, not raw row or response literals. A literal copies the contract's shape into every test, so one contract change breaks every copy. If a builder for the shape you need doesn't exist, add it to `test-utils/` (or extend one) in this task. Frozen regression fixtures (`lib/__fixtures__/`) are the exception and stay as they are.
```

## Change 2: `.claude/agents/product-engineer.md`, § Build, end of the first bullet

Old:
```
- Behavior first, with tests: pure logic in `lib/` with `*.test.ts` written first; screens with router tests in `__tests__/` (never under `app/`).
```

New:
```
- Behavior first, with tests: pure logic in `lib/` with `*.test.ts` written first; screens with router tests in `__tests__/` (never under `app/`). Test data comes from the shared builders in `test-utils/` or the app's own functions, not raw row literals; add a builder there when a new shape needs one.
```

## What this changes for you
When a data format changes (a new required field, a renamed column), the fix lands in one builder file instead of in every test that wrote the rows out by hand. That's what kept the `snapshotOf` tests green this time.
