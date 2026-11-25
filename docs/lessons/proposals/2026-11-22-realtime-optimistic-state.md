# Proposal: rules for live data, optimistic updates and rollbacks

**Status:** applied 2026-11-22
**Target files:** `.claude/agents/code-reviewer.md` § What to look for, `.claude/agents/implementer.md` § How to work
**Promotion rule used:** second expo-area lesson about async state ending badly (M1a's "every async flow needs a path for cancel, failure and sign-out"; the M1b+M2 app review: stale claims on the edit screen, an optimistic split before its claim committed, rollback to `null`, a no-op save rewriting "set by").

## Exact change

### Change 1: `code-reviewer.md` § What to look for, item 3

Old:
```
3. **Correctness:** logic errors, unhandled errors, race conditions in concurrent claiming, broken deep links.
```

New:
```
3. **Correctness:** logic errors, unhandled errors, race conditions in concurrent claiming, broken deep links. With live (realtime) data, check four things. (a) A decision that can destroy data (dropping claims, overwriting a split) uses current server state, not a snapshot from when the screen loaded. (b) An optimistic update starts only after what it depends on has committed. (c) A failed update rolls back to the exact previous value (not `null` or a default). (d) A save that changes nothing doesn't write or log anything. Also flag money math from `lib/` that runs repeatedly per render instead of once per data change.
```

### Change 2: `implementer.md` § How to work, new bullet after "Tests first for pure logic"

Old:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
```

New:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
- For screens with live data, test the failure and concurrency paths, not just the happy path. Cover another user's change arriving while the screen is open, a failed write (rollback to the previous value), and a no-op save. In component tests, wait for async updates with `findBy*` / `waitFor` so no `act()` warnings leak.
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: Every async flow needs a path for cancel, failure and sign-out [area: expo]"
- "2026-11-22: App review: stale state, early optimism and lossy rollbacks [area: expo]"
