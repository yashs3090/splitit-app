# Proposal: effects that run when a screen opens are tested on every entry route; "only in file X" greps account for the test file

**Status: pending**

**Targets:** `.claude/agents/product-manager.md` (Rules); `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/implementer.md` (§ How to work); `.claude/agents/code-reviewer.md` (item 4, Tests)

**Promotion rules used:**
- Changes 1–4: the entry-route lesson is now in the log three times (testing area). The applied rule says "navigation and auth flows", and that wording is why it didn't apply here, so it gets reworded.
- Change 5: grep-based checks have given the wrong answer seven times.

## Evidence (docs/lessons/log.md)
- 2026-11-19 "Router tests must cover web and native paths" [testing]
- 2026-11-24 "Flow tests missed a path again: home mounting while the invite resumes" [testing] (led to the applied proposal `2026-11-24-flow-tests-every-entry-path.md`)
- 2026-11-24 "Entry-route tests missed a third time: 'opening a bill marks it seen' wasn't tested per route" [testing]: R1, criterion 41 of docs/specs/2026-11-24-bill-markers-and-notices.md
- 2026-11-24 "A 'matches only lib/X.ts' grep also matched X's test file" [testing], plus the six earlier grep entries it cites
- 2026-11-28 "Entry-route tests missed again: per-route tests for the new tabs" [testing] (added in the tab-bar-and-Activity retro): review R5 of docs/specs/2026-11-28-tab-bar-and-activity.md. Marking seen and refreshing badges on each way into Activity, Groups and the bills lacked per-route tests. This is the fifth occurrence. It's exactly the "screen-open effect" case Changes 1–4 name, so no rewording is needed.

## Change 1: `.claude/agents/product-manager.md`, new bullet in Rules, directly before "- Write only under `docs/`. Never edit code."

Old:
```
- Write only under `docs/`. Never edit code.
```

New:
```
- **Screen-open effects list their routes.** A criterion for something that must happen when a screen opens (mark seen, a fetch, clearing a prompt or notice) lists every route that reaches that screen (from Home, a deep link or invite resume, after joining or sign-in, a cold start) and expects the effect on each, on web and native.
- Write only under `docs/`. Never edit code.
```

## Change 2: `.claude/agents/product-engineer.md`, § Build, the "Test the paths people actually hit…" bullet (replace only its last sentence)

Old:
```
For navigation and auth flows, test every entry route (deep link, `/` after the web OAuth redirect, cold start) on web and native (`Platform.OS = 'web'` set explicitly), including screens that mount on the way.
```

New:
```
For navigation and auth flows, and for anything that must happen when a screen opens (marking it seen, a fetch, clearing a notice), test every entry route (from Home, a deep link or invite resume, `/` after the web OAuth redirect, after joining, cold start) on web and native (`Platform.OS = 'web'` set explicitly), including screens that mount on the way.
```

## Change 3: `.claude/agents/implementer.md`, § How to work (replace only the first sentence of the bullet)

Old:
```
- For navigation and auth flows (sign-in, invite resume, deep links), test every route the app can open on for that flow, on both web and native (set `Platform.OS = 'web'` explicitly for web): a deep link, `/` after the web OAuth redirect, and a cold start with a saved session.
```

New:
```
- For navigation and auth flows (sign-in, invite resume, deep links), and for any effect that must run when a screen opens (marking it seen, a fetch, clearing a notice), test every route the app can open on for that flow or screen, on both web and native (set `Platform.OS = 'web'` explicitly for web): from Home, a deep link, `/` after the web OAuth redirect, after joining, and a cold start with a saved session.
```

## Change 4: `.claude/agents/code-reviewer.md`, item 4 (Tests), replace only this sentence

This replaces a sentence, not the whole item, so it applies cleanly whether or not the pending parser proposal (`2026-11-24-parser-changes-differential-guard.md`, Change 1) has been applied first.

Old:
```
For navigation and auth flows, check there's a test per platform (web and native) and per entry route (deep link, `/` after the web OAuth redirect, cold start), including any screen that mounts on the way.
```

New:
```
For navigation and auth flows, and for effects that must run when a screen opens (mark seen, a fetch, clearing a notice), check there's a test per platform (web and native) and per entry route (from Home, deep link or invite resume, `/` after the web OAuth redirect, after joining, cold start), including any screen that mounts on the way.
```

## Change 5: `.claude/agents/product-manager.md`, end of the grep bullet (the one starting "Write grep-based criteria with plain `grep -rn`…")

Old:
```
If you couldn't run an equivalent search, write "not run" instead of "matches nothing", and the implementer runs it first.
```

New:
```
If you couldn't run an equivalent search, write "not run" instead of "matches nothing", and the implementer runs it first. A criterion that says a literal appears "only in" one file also lists that file's test (`lib/x.test.ts` asserts exact copy), or adds `--exclude='*.test.ts' --exclude='*.test.tsx'`.
```

## What this changes for you
Things that should happen whenever you open a bill (like clearing its "New" marker) get tested from every way you can get there, so one path can't quietly leave a marker stuck. Grep checks in specs stop failing just because a test file contains the same words.
