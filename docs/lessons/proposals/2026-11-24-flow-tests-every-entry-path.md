# Proposal: flow tests cover every entry route on web and native

**Status:** applied (2026-11-24, approved by the user)
**Target files:** `.claude/agents/implementer.md` § How to work, `.claude/agents/code-reviewer.md` § What to look for (4. Tests)
**Promotion rule used:** a lesson in the same area seen twice. The M0 rule "Router tests must cover web and native paths" lives only in `native-mobile.md`, and it was missed again in this slice (R1), because the gap was an entry route (landing on `/` after the web OAuth redirect, so home mounts) rather than a literal `Platform.OS` branch.

## Change 1: `.claude/agents/implementer.md`

Old:
```
- For screens with live data, test the failure and concurrency paths, not just the happy path. Cover another user's change arriving while the screen is open, a failed write (rollback to the previous value), and a no-op save. In component tests, wait for async updates with `findBy*` / `waitFor` so no `act()` warnings leak.
```

New:
```
- For screens with live data, test the failure and concurrency paths, not just the happy path. Cover another user's change arriving while the screen is open, a failed write (rollback to the previous value), and a no-op save. In component tests, wait for async updates with `findBy*` / `waitFor` so no `act()` warnings leak.
- For navigation and auth flows (sign-in, invite resume, deep links), test every route the app can open on for that flow, on both web and native (set `Platform.OS = 'web'` explicitly for web): a deep link, `/` after the web OAuth redirect, and a cold start with a saved session. Where a screen mounts on the way (e.g. home while the resume effect runs), assert that it and its fetches don't navigate or show UI they shouldn't.
```

## Change 2: `.claude/agents/code-reviewer.md`

Old:
```
4. **Tests:** acceptance criteria with no test; tests that don't actually assert the behavior.
```

New:
```
4. **Tests:** acceptance criteria with no test; tests that don't actually assert the behavior. For navigation and auth flows, check there's a test per platform (web and native) and per entry route (deep link, `/` after the web OAuth redirect, cold start), including any screen that mounts on the way.
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Router tests must cover web and native paths [area: testing]"
- "2026-11-24: Flow tests missed a path again: home mounting while the invite resumes [area: testing]"
