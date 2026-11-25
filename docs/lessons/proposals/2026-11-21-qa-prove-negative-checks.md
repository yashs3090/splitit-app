# Proposal: qa-tester proves "prints nothing" checks can fail, handles load timeouts, starts web correctly

**Status:** applied 2026-11-21
**Target file:** `.claude/agents/qa-tester.md` § Steps
**Promotion rules used:**
- Same area seen twice: grep-based checks gave the wrong answer in M0 (the leak check matched the guard's own literals) and in M1a (`git grep` passed vacuously on untracked files) [area: testing].
- "A rule that caused a wrong result gets a proposal to reword it": step 3 tells QA to use `npx expo start --web`. Since M1a, that skips the `preweb` hook that copies the Tesseract files, so web scanning fails with "Couldn't load the text reader". `npm run web` runs the hook.
- The timeout bullet is a first occurrence, included because it changes how QA reports a FAIL. Drop it if you'd rather wait.

## Exact change

Old:
```
## Steps
1. Read the spec's acceptance criteria and the `Commands` section of `CLAUDE.md`.
2. Run the full test suite and the type-check in each repo the task touched.
3. For each acceptance criterion, run the test or manual step that proves it. Where possible, use the running app (Expo web via `npx expo start --web`, or a Supabase local stack) or call the Edge Function with curl.
4. Try at least two edge cases the spec didn't mention (e.g. an empty receipt, a single participant, a $0 tip, a unicode item name).
```

New:
```
## Steps
1. Read the spec's acceptance criteria, the `Commands` section of `CLAUDE.md`, and the `[area: testing]` lessons in `docs/lessons/log.md`.
2. Run the full test suite and the type-check in each repo the task touched. If a test fails only with a timeout, re-run that file on its own (`npx jest <file>`) before reporting; if it passes alone, report it as flaky under load with both outputs.
3. For each acceptance criterion, run the test or manual step that proves it. Where possible, use the running app (Expo web via `npm run web`, which runs the asset-copy hook first, or a Supabase local stack) or call the Edge Function with curl.
   - **"Prints nothing" checks must be shown to work.** Before you count an empty grep as PASS, show the same command finds something: run it on a known match, or for `git grep` confirm the paths are tracked (`git ls-files <path>` isn't empty). `git grep` skips untracked files. If you can't show the check works, use plain `grep -rn` over the same paths, or mark it NOT VERIFIED.
   - Read `npx expo-doctor` warnings and report any about env files or secrets (names only, never values).
   - Never read, grep, count, create or edit `.env*` files (except `.env.example`). Pass values inline on the command line.
4. Try at least two edge cases the spec didn't mention (e.g. an empty receipt, a single participant, a $0 tip, a unicode item name).
```

## Evidence (docs/lessons/log.md)
- "2026-11-19: Build guard literals so leak-check grep doesn't match them [area: testing]"
- "2026-11-21: `git grep` checks pass vacuously when files are untracked [area: testing]"
- "2026-11-21: Jest timeouts under heavy machine load are not real failures [area: testing]"
- "2026-11-21: Agents tried to read `.env` again; the permission system blocked it [area: testing]"
- "2026-11-21: Root `.env` carries Google OAuth variables [area: expo]"
- `package.json`: `preweb` and `prestart` run `scripts/copy-tesseract-assets.mjs`; `web` is `expo start --web`.
- Spec `docs/specs/2026-11-20-m1a-scan-receipt.md`: Amendment A4.4.
