# Proposal: build-output checks use a fresh build and a grep that reads binaries; note the global Jest setup; QA reports tracked items in one line

**Status: pending**

**Targets:** `CLAUDE.md` § Commands (Tests, Web build); `.claude/agents/qa-tester.md` (step 3; step 2 for Change 6, added in the bill-markers retro)

**Promotion rules used:** grep-based checks that gave the wrong answer are now in the log five times (testing area). The root `.env` report is in the log five times. The Jest-setup line is a fact the next agent needs to find, not a new rule. The qa-tester "(Verify: …)" wording is a rule that has since been checked, so it's reworded.

## Evidence (docs/lessons/log.md)
- 2026-11-19 "Build guard literals so leak-check grep doesn't match them", 2026-11-21 "`git grep` checks pass vacuously when files are untracked", 2026-11-22 "A grep criterion matched an unrelated identifier", 2026-11-24 "Spec said a grep 'matches nothing today', but it matched" [testing]
- 2026-11-24 "A bundle check ran on a stale build, and the shell's grep skipped the binary bundle" [testing]: review R2 (criterion 54 on a pre-Task-10 web build); PI-C-8 (ugrep skipped the iOS `.hbc`; `/usr/bin/grep -a` found the strings).
- 2026-11-24 "Native modules that throw under Jest got one global stand-in, which had to fail loudly" [testing]: PI-C-7, review R5.
- 2026-11-21, 2026-11-22, 2026-11-24 (twice) and 2026-11-24 "Root `.env` Google variables, fifth report" [expo]
- 2026-11-24 "QA's own dev server worked; shell values override the root `.env`" [testing]
- 2026-11-24 "Root `.env` Google variables, sixth report" and 2026-11-25 "Root `.env` Google variables, seventh report" [expo] (added in later retros): still reported in full each time; Change 5 would make it one line.
- 2026-11-26 "Root `.env` Google variables, eighth report" [expo] (added in the home-mobile-refresh retro). Separately, the expected-`cdn.jsdelivr.net` sentence that Change 2 keeps is reworded by `2026-11-26-claude-md-leak-check-two-jsdelivr-matches.md`; the two apply in either order.
- 2026-11-27 "Root `.env` Google variables, ninth report" [expo] (added in the Sent-via-Venmo retro): reported again in full. Change 5 alone would turn this into one line per report and can be approved on its own.
- 2026-11-28 "Root `.env` Google variables, tenth report" [expo] (added in the usernames retro): reported again.

## Change 1: `CLAUDE.md` § Commands, Tests bullet

Old:
```
Shared test fakes are in `test-utils/`.
```

New:
```
Shared test fakes are in `test-utils/`. `test-utils/jestSetup.ts` runs before every test file and holds stand-ins for native modules that throw under Jest (`expo-contacts`, `expo-sms`). A new native module that screens import gets a stand-in there, and it rejects ("<module> not mocked in this test") instead of returning a quiet default.
```

**Change 1, reworded (added 2026-11-28, tab-bar-and-Activity retro).** Apply this text instead of Change 1's "New" above.

Evidence: log 2026-11-28 "Other sessions' changes broke our tests three times, one as a hang under Jest" [testing] and "A background test loop hung for over 2 hours…" [testing]. Another session's `<StatusBar>` from `expo-status-bar` in `app/_layout.tsx` left native async work pending under Jest. `__tests__/activity.test.tsx` hung instead of throwing, which took a bisection to find. The fix is a stand-in in `test-utils/jestSetup.ts` that records calls (`(StatusBar as jest.Mock).mock.calls`). A module that hangs needs a stand-in as much as one that throws, and a layout every screen mounts is where it matters most.
```
Shared test fakes are in `test-utils/`. `test-utils/jestSetup.ts` runs before every test file and holds stand-ins for native modules that throw or hang under Jest (`expo-contacts`, `expo-sms`, `expo-status-bar`). A native module that screens or a root layout (`app/_layout.tsx`, `app/(app)/_layout.tsx`) render gets a stand-in there in the same change. It rejects ("<module> not mocked in this test") instead of returning a quiet default, unless it only renders or sets display state, where a `jest.fn()` returning null is the safe answer.
```
(`2026-11-28-foreground-test-runs-with-limits.md` adds a sentence at the end of the same bullet; the two apply in either order.)

## Change 2: `CLAUDE.md` § Commands, end of the Web build bullet

Old:
```
One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected (Tesseract.js's unused default path; ADR 0012).
```

New:
```
One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected (Tesseract.js's unused default path; ADR 0012). Any check over build output (the leak check, "bundle X doesn't contain Y") runs on a build made in the same run from the current tree, never on a `dist/` or export left from earlier. Native exports (`npx expo export -p ios --output-dir <scratchpad>`) contain binary Hermes bundles (`.hbc`). The shell's `grep` may be ugrep, which silently skips binary files, so search them with `/usr/bin/grep -a`, and run the positive control with the same command.
```

## Change 3: `.claude/agents/qa-tester.md`, step 3, the "Check which backend the app talks to" bullet

Old:
```
(Verify: that shell values override the root `.env`, and that real Google sign-in redirects back to that port; if not, report the sign-in part as a user check.)
```

New:
```
(Shell values override the root `.env`; checked in M3. Verify that real Google sign-in redirects back to that port; if not, report the sign-in part as a user check.)
```

## Change 4: `.claude/agents/qa-tester.md`, step 3, the "Prints nothing" bullet, new sentence at the end

Old:
```
If you can't show the check works, use plain `grep -rn` over the same paths, or mark it NOT VERIFIED.
```

New:
```
If you can't show the check works, use plain `grep -rn` over the same paths, or mark it NOT VERIFIED. Checks over build output use a build you made in this run from the current tree (see `CLAUDE.md` § Commands, Web build), and binary bundles are searched with `/usr/bin/grep -a`.
```

## Change 5: `.claude/agents/qa-tester.md`, step 3, the expo-doctor bullet

Old:
```
   - Read `npx expo-doctor` warnings and report any about env files or secrets (names only, never values).
```

New:
```
   - Read `npx expo-doctor` warnings and report any about env files or secrets (names only, never values). Check `docs/before-production.md` first: an item already tracked there gets one line ("still open, tracked in before-production §3"), not a new finding.
```

## Change 6 (added 2026-11-24, bill-markers retro): `.claude/agents/qa-tester.md`, step 2, new sentence after the timeout sentence

Evidence: log entries 2026-11-24 "Jest timeouts under load again, partly from QA's own build" [testing] (load 12–99; timeouts in a different file each run, all passing alone) and 2026-11-24 "Root `.env` Google variables, sixth report" [expo] (more evidence for Change 5).

Old:
```
if it passes alone, report it as flaky under load with both outputs and the load average.
```

New:
```
if it passes alone, report it as flaky under load with both outputs and the load average. Don't run your own builds (`npm run export:web`, native exports, a dev server's first bundle) at the same time as the full suite: run them one after the other.
```

## What this changes for you
"The bundle doesn't contain X" checks will always run on a fresh build, with a search that can read the phone bundle, so a pass means something. QA's reports will stop listing the Google variables in the root `.env` as a new problem each time; they'll show as one "still open" line until you move them.
