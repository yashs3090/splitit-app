# Lessons log

Lessons from building SplitIt, newest at the bottom. Written by the `retro` step (see `.claude/skills/retro/SKILL.md`). Agents read this before each task.

Format:
```
## YYYY-MM-DD: <short title>  [area: ...]
- What happened:
- Why (root cause):
- Fix / rule:
- Source:
```

## 2026-11-19: Ask the user about providers and setup costs before speccing  [area: process]
- What happened: The M0 spec built email OTP and magic link, with Google/Apple as disabled placeholders. Mid-build the user said "only allow sign in with Gmail" because they don't want to set up an email-sending account. That forced Amendment A1 after backend Tasks 1–3 were already written for email, so config and templates had to be redone.
- Why (root cause): The PM picked the option that was easiest to verify locally (Inbucket email) without asking. Which third-party service to use, and what accounts it needs (email sender, paid developer memberships, cloud consoles), is the user's call. The existing "don't make product decisions" rule was read too narrowly to cover it.
- Fix / rule: Before writing tasks, the PM lists every external provider or account the spec depends on (auth providers, email/SMS senders, paid memberships, cloud consoles), with its setup cost. The PM gets the user's choice up front instead of defaulting. If the user can't be asked, it goes at the top of open questions and is flagged as blocking.
- Source: user correction → Amendment A1 in docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md

## 2026-11-19: Check spec'd config keys against the installed tool version  [area: process]
- What happened: The spec said to use `[auth.email] enable_signup = false`. Supabase CLI 3.2.0 flags that key as a deprecated alias, so the backend used `[auth.email] enabled = false` instead (A1.1). It also had to avoid top-level `[auth] enable_signup = false`, which would have blocked new Google users too.
- Why (root cause): The spec named an exact config key from memory or older docs without checking it against the installed CLI.
- Fix / rule: When a spec prescribes exact config keys or flags, either check them against the installed version (`--help`, the generated default `config.toml`) or mark them "verify against installed version". Implementers who deviate say so explicitly, as was done here.
- Source: implementation deviation, Amendment A1.1

## 2026-11-19: Explain deviations to the user in plain language  [area: process]
- What happened: The user asked what "`enabled = false` instead of `enable_signup`" meant. The deviation report was accurate but written for engineers.
- Why (root cause): Reports passed on to the user were written in config-key terms. The user is learning (see `docs/learning/`) and needs the what and the why.
- Fix / rule: Every deviation reported to the user gets one plain-language sentence covering what changed, why, and whether it changes behavior for them. Example: "Email sign-in is switched off using the setting's current name; the old name still works but is being retired. No difference for you."
- Source: user question after implementation

## 2026-11-19: RLS is not enough; revoke default grants and grant the minimum  [area: rls]
- What happened: The `profiles` table had RLS enabled and correct policies, but relied on Supabase's implicit default grants to `anon`/`authenticated` on `public`. Fix: `revoke all` from `anon`, `authenticated` (and `public`), then grant `authenticated` only SELECT plus UPDATE(`display_name`). Forbidden operations now fail with `42501` instead of silently returning 0 rows. Criterion 12 was updated to match.
- Why (root cause): CLAUDE.md § Conventions says only "Every table has RLS enabled", so RLS was treated as the only security layer. Supabase grants broad table privileges by default, so one missing or overly permissive policy would expose the table.
- Fix / rule: Every new table gets an explicit `revoke all ... from anon, authenticated, public` plus the minimal per-role, per-column grants. RLS policies sit on top. Acceptance criteria for denied operations expect `42501` where the grant is absent.
- Source: R1 in review of docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md; QA criterion 12

## 2026-11-19: Only the single resume effect navigates after sign-in  [area: expo]
- What happened: A native `/auth/callback` route with a hard `<Redirect>` could race the single post-sign-in resume effect in the root layout and lose the pending invite.
- Why (root cause): A second place that navigated after sign-in was added, which broke the spec's "implement resume in one place" design.
- Fix / rule: Routes involved in the auth flow (callback, sign-in) must not hard-redirect once a session exists. They render a neutral/loading state and let the resume effect do `router.replace(postSignInRoute(code))`.
- Source: R2 in review of docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md

## 2026-11-19: Never echo URL-supplied text in the UI; allow-list it  [area: expo]
- What happened: The sign-in screen displayed an error code taken from the URL, which could be used for phishing (an attacker-crafted message on a trusted screen). It is now mapped through an allow-list of known codes to fixed copy.
- Why (root cause): Error params from the OAuth redirect were treated as trusted display text.
- Fix / rule: Any value from a URL or deep link that is shown to the user is mapped through an allow-list to app-owned strings. Unknown values get a generic message.
- Source: R3 in review of docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md

## 2026-11-19: Auth defaults: local sign-out, fail fast on placeholder config  [area: expo]
- What happened: `signOut()` used the global scope, which signs the user out on every device. It is now `scope: 'local'`. Separately, placeholder Supabase credentials failed late with an unclear error.
- Why (root cause): Library defaults were accepted without checking them against the product's expectations. Config wasn't validated at startup.
- Fix / rule: Pass auth options like the sign-out scope explicitly. `lib/env.ts`-style validation rejects placeholder or empty values at startup with a message that names the variable.
- Source: R6 and R7 in review of docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md

## 2026-11-19: Router tests must cover web and native paths  [area: testing]
- What happened: The router tests only exercised the native path, so web-only behavior (the OAuth redirect landing on `/`, `detectSessionInUrl`) wasn't tested.
- Why (root cause): Tests mocked one platform by default.
- Fix / rule: Any flow with a `Platform.OS` branch gets a test per branch (mock `Platform.OS = 'web'` explicitly).
- Source: R5 in review of docs/specs/2026-11-19-m0-scaffold-auth-deeplinks.md

## 2026-11-19: Agents don't write .env or break code on disk; use inline env vars  [area: testing]
- What happened: The permission classifier blocked agents' attempts to write a dummy `.env` and to temporarily break code (to show a test can fail). QA worked around the `.env` block by passing env vars inline (`EXPO_PUBLIC_SUPABASE_URL=... npm run export:web`). The user then asked how to stop Claude from reading `.env` files at all.
- Why (root cause): The CLAUDE.md Commands section tells humans to `cp .env.example .env`, and agents copied that. Secrets files are off-limits to agents.
- Fix / rule: Agents never create, edit or read `.env*` files (other than `.env.example`). Pass the needed values inline on the command line. To show a test can fail, use a mutation in the test's own fixture/input, or report the test as "not shown to fail", rather than editing source.
- Source: QA process; permission-classifier blocks; user question

## 2026-11-19: EXPO_PUBLIC_ values are baked in; rebuild with --clear  [area: expo]
- What happened: Metro reused a cached bundle that still had an old `EXPO_PUBLIC_` value, so QA saw stale config.
- Why (root cause): `EXPO_PUBLIC_*` values are inlined at build time, and the Metro cache doesn't key on env changes.
- Fix / rule: After any env change, build with `--clear` (`npm run export:web` already does this; for the dev server use `npx expo start --clear`). This is already written in CLAUDE.md § Commands. Logged so a repeat can be counted.
- Source: QA finding

## 2026-11-19: `npm run web` rewrites tsconfig.json includes  [area: expo]
- What happened: Starting the web dev server added `.expo/types` and `expo-env.d.ts` entries to `tsconfig.json`'s `include`, which created an unexpected diff. These entries were removed.
- Why (root cause): Expo CLI auto-edits tsconfig for typed routes when it finds them missing.
- Fix / rule: After running the dev server, check `git diff tsconfig.json` and revert generated include entries. If this recurs, decide on a permanent fix: either commit the entries or turn off typed-routes generation.
- Source: QA finding

## 2026-11-19: Build guard literals so leak-check grep doesn't match them  [area: testing]
- What happened: `lib/env.ts` contains the literals it refuses (`service_role`, `sb_secret_`), so the `dist/` leak-check grep matched the guard itself. The literals are now built via `split()`/join.
- Why (root cause): Detection code and a grep-based leak check look for the same strings.
- Fix / rule: Code that checks for secret markers builds those markers at runtime (split/join) and carries a comment pointing to the leak check. Don't weaken the grep.
- Source: implementation deviation, QA leak check

## 2026-11-21: PM defaulted a user-facing choice again; offer the options  [area: process]
- What happened: The M1a spec gave manual entry a paste box. The user wanted a real item form (name, qty, price rows, add/edit/delete) and said so in Amendment A1.3, which rewrote Tasks 5–8.
- Why (root cause): This is the second time (after M0's email-vs-Google sign-in) that the PM picked the cheaper, easier-to-verify option for something the user sees, without asking. The M0 rule only covered providers and accounts, so the PM read it as not applying to UX shape.
- Fix / rule: When a user-facing feature has more than one reasonable shape and they differ in effort or experience (paste box vs form, one button vs two), the PM writes both with a one-line trade-off in open questions, recommends one, and doesn't build tasks on top of the choice until the user answers. Second occurrence of the M0 lesson, so it is promoted to `product-manager.md`.
- Source: user correction → Amendment A1.3 in docs/specs/2026-11-20-m1a-scan-receipt.md

## 2026-11-21: Specs asserted tool behavior that turned out false  [area: process]
- What happened: Two spec'd facts about tools were wrong. Criterion 54 said native exports would contain no Tesseract files, but `expo export -p ios|android` copies all of `public/` (incl. `public/tesseract/`), so QA failed it (reworded in A5 to "no native JS bundle or `metadata.json` contains it"). The spec also picked Tesseract page-segmentation mode 4, which dropped every price on the test receipt; mode 6 works (A4.1).
- Why (root cause): Second occurrence of the M0 lesson "check spec'd config keys against the installed tool version". Most of A3 was marked "verify", but the criterion and the PSM value weren't, and criterion 54 was worded as an implementation proxy ("grep the whole export folder") instead of the property it protects ("no native JS bundle contains Tesseract").
- Fix / rule: A criterion that depends on what a tool does (what a build output contains, which parameter works) is either checked by the PM first or marked "verify; reword if the tool differs", and is worded as the property being protected. Tunable parameters are "starting value", with the implementer allowed to change them with evidence. Promoted to `product-manager.md`.
- Source: QA criterion 54 → Amendment A5; implementation deviation → Amendment A4.1

## 2026-11-21: Parallel agents worked from a stale snapshot  [area: process]
- What happened: Two collisions from parallel work. The PM numbered the library ADR 0011 while another agent was writing ADR 0011 ("single repo"), so the main session renumbered it to 0012. The spec also told the docs task to fix `CLAUDE.md` references that had already been fixed.
- Why (root cause): Each agent read the repo once at the start. Shared sequence numbers (ADRs) and "fix this stale text" instructions were based on what the files looked like before the parallel work landed.
- Fix / rule: When agents run in parallel, the main session hands out shared numbers (ADR numbers, migration timestamps) up front. A docs or cleanup task re-reads the target file right before editing and skips fixes that are already in place, saying so in its report.
- Source: spec phase of docs/specs/2026-11-20-m1a-scan-receipt.md (main-session renumbering)

## 2026-11-21: Fixes that change an acceptance criterion go to the user first  [area: process]
- What happened: Two parser review fixes changed spec criteria (no-subtotal cross-check, and the user's own rule that a discount under an item folds into that item), and QA's criterion 54 failure was a wording problem. Each time, the main session asked the user and recorded the result as an amendment (A2, A4.2, A5) before changing code or the verdict. That worked well.
- Why (root cause): Criteria are what the user signed off on. Changing them silently during the fix loop would make QA's PASS meaningless.
- Fix / rule: In build-task, a review or QA finding whose fix changes an acceptance criterion goes to the user before the implementer acts on it, and the decision is recorded as a dated amendment in the spec. Proposed for `build-task`.
- Source: review of Tasks 3–4 (R2, R5) → A2; full review → A4.2; QA → A5

## 2026-11-21: Parser fixtures were cleaner than real OCR output  [area: receipt-parsing]
- What happened: The parser passed its own fixtures, but the reviewer probed about 60 messy receipts and found 10 should-fixes. A ~2° tilt broke row pairing entirely. "Total Tax", "Total Savings" and "Total Items" were read as the total. Qty/unit/total columns confused it. "12 oz Steak" became qty 12. Tax-code letters (`F`, `T`) stayed in names. "No Bake Cheesecake" was folded as a modifier. `formatCents` printed garbage for non-integers.
- Why (root cause): The fixtures were typed by hand from the spec's idea of a receipt: perfectly level rows, one price column, simple names. Real Vision/Tesseract output has drift in y, extra columns, codes and noise (R11).
- Fix / rule: Parser tests include noisy cases on purpose: rows tilted by a few degrees (y drifting across the line), labels that start with "Total" but aren't the total, qty × unit = line-total columns, units in names (oz, lb, pc), trailing tax-code letters, item names that start with modifier words, and discount lines under items. When real scans exist, add them as `eval/receipts/` cases (receipt-eval skill). Reviewers of parser changes probe with generated messy inputs, as was done here.
- Source: R11 and the 10 should-fixes in the review of Tasks 3–4 of docs/specs/2026-11-20-m1a-scan-receipt.md

## 2026-11-21: Invalid money input must never count as $0 or as "adds up"  [area: money-math]
- What happened: In the bill form, an invalid field parsed to `null`, which the totals check treated as 0, so the footer said "Adds up" while a field showed an error. Separately, `formatCents` printed garbage when given a non-integer.
- Why (root cause): Money helpers and checks accepted any `number` and coerced bad or missing values instead of refusing them.
- Fix / rule: A totals check can only say "adds up" when every money field is valid; any invalid field gives a distinct "fix the highlighted field" state. Money helpers in `lib/money.ts` check `Number.isInteger` and fail loudly (or show a placeholder) rather than formatting a non-integer. Tests cover invalid input, not just valid amounts.
- Source: full M1a review (footer pill finding); review of Tasks 3–4 (`formatCents`)

## 2026-11-21: Money math was duplicated in a component  [area: expo]
- What happened: The "Off by $X" text in the bill form recomputed the difference itself instead of using `checkTotals` from `lib/`.
- Why (root cause): Display code needed one extra number, and computing it inline was quicker than extending the pure function's result.
- Fix / rule: Components never do money arithmetic. If the UI needs a derived amount (difference, remaining, share), the `lib/` function returns it and its test covers it. Reviewers flag any `+`/`-` on cents in `components/` or `app/`.
- Source: full M1a review

## 2026-11-21: Every async flow needs a path for cancel, failure and sign-out  [area: expo]
- What happened: The full review found three leaks. A half-started Tesseract worker wasn't terminated. On browsers without the file input's `cancel` event, closing the picker left the scan button disabled forever. The scan result stayed in memory after sign-out, so the next user on the same device could see it.
- Why (root cause): The happy path and the obvious error were handled, but not "the user walked away" (cancel with no event), "it failed halfway" or "a different person is now signed in".
- Fix / rule: For each async flow, list how it ends (success, error, cancel, abort, never settles) and make sure each one frees resources and re-enables the UI. Don't rely on a browser event that isn't supported everywhere: re-enable on focus/visibility return or a timeout as well. Per-user state (scan results, drafts) is cleared on sign-out, with a test.
- Source: full M1a review

## 2026-11-21: Screens get a design pass; the user wants simple, uncluttered UI  [area: expo]
- What happened: The full review found missing VoiceOver hints. The user asked for a `ui-ux-designer` skill (now created) to be used for screens, and said they want the UI simple and uncluttered.
- Why (root cause): Screens were built by implementers whose focus is behavior and tests. Nobody owned accessibility or visual simplicity.
- Fix / rule: Any task that adds or changes a screen gets a `ui-ux-designer` pass before review. Favour fewer elements over more: one primary action, no decoration that doesn't help the task. Interactive elements get `accessibilityLabel` and, where the result isn't obvious, `accessibilityHint`. Proposed for `build-task` and the `ui-ux-designer` skill.
- Source: user correction and preference; full M1a review (VoiceOver hints)

## 2026-11-21: `git grep` checks pass vacuously when files are untracked  [area: testing]
- What happened: Every file in the repo is untracked (only the initial commit exists), so every "`git grep ...` prints nothing" criterion passed without searching anything. QA spotted it and A4.4 switched to `grep -rn` until the first commit.
- Why (root cause): A "prints nothing" check passes both when the thing is absent and when the check can't see the files. Together with M0's leak-check lesson (the grep matched the guard itself), this is the second time a grep-based check gave the wrong answer.
- Fix / rule: Before trusting a "prints nothing" check, show it can find something: run it on a known match, or confirm the files are tracked (`git ls-files <path>` non-empty) when using `git grep`. If it can't be shown to work, mark it NOT VERIFIED. PMs write grep criteria with plain `grep -rn` unless the files are committed. Promoted to `qa-tester.md`.
- Source: QA report (A4.4); M0 lesson "Build guard literals so leak-check grep doesn't match them"

## 2026-11-21: Jest timeouts under heavy machine load are not real failures  [area: testing]
- What happened: Tests failed once with timeouts while the machine was busy with other agents and builds, then passed when re-run.
- Why (root cause): Async tests with real timers and the default 5 s timeout are sensitive to CPU contention.
- Fix / rule: A timeout-only failure is re-run once on its own (`npx jest <file>`) before it's reported or "fixed". If it passes alone, report it as flaky-under-load with both outputs. Don't raise timeouts globally to hide it; prefer fake timers or awaiting the real condition.
- Source: implementation report, M1a

## 2026-11-21: `npx expo install` writes `^` ranges for non-Expo packages  [area: expo]
- What happened: The spec asked for exact pins on `expo-mlkit-ocr` and `tesseract.js`, but `npx expo install` saved caret ranges for them. The implementer re-pinned with `npm i -E`.
- Why (root cause): `expo install` only picks SDK-matched versions for packages it knows about. For everything else it acts like `npm install`, which saves `^` by default. The agent rule "always use `expo install`" didn't mention this.
- Fix / rule: Use `npx expo install` for Expo SDK packages. For a third-party package the spec says to pin, install it, then re-pin with `npm i -E <pkg>@<version>` and check `package.json` shows no `^` or `~`. Proposed rewording in `native-mobile.md`.
- Source: implementation deviation, M1a Tasks 1 and 9

## 2026-11-21: Keep heavy web-only libraries behind one lazily imported module  [area: expo]
- What happened: To keep Tesseract.js out of the web entry bundle, the implementer put all of it in `lib/webOcrEngine.ts` and loaded that file with `await import()`. `npm run export:web` then showed a separate `webOcrEngine-*` chunk and a clean entry bundle (criterion 53).
- Why (root cause): A top-level import anywhere in the chain, even of types or constants, pulls the library into the entry bundle.
- Fix / rule: A heavy library used on one platform lives in a single module that only a dynamic `import()` reaches. Constants the rest of the app needs live elsewhere. Check the build output with a grep over the entry bundle, not just the source.
- Source: implementation deviation, M1a Task 9 / A4.2

## 2026-11-21: Agents tried to read `.env` again; the permission system blocked it  [area: testing]
- What happened: A Bash check that grepped `.env` files (only counting matches) was denied by permissions. That was correct: the M0 rule says agents never read `.env*`.
- Why (root cause): Second occurrence. The rule is in some agent files (`native-mobile`, `docs-writer`, `ui-ux-designer`) but not in `CLAUDE.md`, `implementer` or `qa-tester`, and "only counting" felt like it wasn't reading.
- Fix / rule: No agent reads, greps, counts, creates or edits `.env*` files (except `.env.example`), for any reason. To check config, use what the tool reports (e.g. `expo-doctor` output, `npx supabase status`) or ask the user. Promoted to `CLAUDE.md` § Conventions.
- Source: permission denial during M1a; M0 lesson "Agents don't write .env or break code on disk"

## 2026-11-21: Google sign-in `server_error` was a bad secret plus a stale Supabase  [area: process]
- What happened: The user's sign-in failed with `server_error`. The auth logs showed `invalid_client: client secret is invalid`. After fixing the secret in `supabase/.env`, it still failed until `npm run db:stop && npm run db:start`.
- Why (root cause): The Supabase CLI reads `supabase/.env` (through `config.toml`'s `env(...)`) only when the stack starts. The app only shows a generic error code, so the real cause is only in the auth logs.
- Fix / rule: For auth errors, check the auth service logs first, not the app. After any change to `supabase/.env` or `supabase/config.toml`, restart the stack (`db:stop` then `db:start`). (Unverified whether `db:reset` also reloads them; restart to be safe.) Worth adding to `CLAUDE.md` § Commands with the pending Commands proposal.
- Source: user's sign-in failure during M1a

## 2026-11-21: Root `.env` carries Google OAuth variables  [area: expo]
- What happened: QA's `npx expo-doctor` run reported that the root `.env` exports `google_oauth_webclient1_*` variables. They aren't bundled (no `EXPO_PUBLIC_` prefix), but CLAUDE.md says the Google OAuth values live only in `supabase/.env`.
- Why (root cause): Probably copied into the wrong file during sign-in setup. Expo CLI loads the root `.env` into the environment of every Expo command, so secrets there are one renamed variable away from the bundle.
- Fix / rule: The user moves those values out of the root `.env` into `supabase/.env` (agents don't touch either file). The root `.env` holds only `EXPO_PUBLIC_*` values. QA reads `expo-doctor`'s env warnings and reports them.
- Source: QA report, `expo-doctor` output

## 2026-11-21: On a physical phone, `127.0.0.1` is the phone  [area: expo]
- What happened: Signing in from the iPhone dev build couldn't reach the local Supabase, because the app's `EXPO_PUBLIC_SUPABASE_URL` is `http://127.0.0.1:54321`, and on the phone that address is the phone itself. A friend-test deploy slice is planned.
- Why (root cause): The spec's on-device checks assumed the device could reach the dev machine's backend the way the simulator and web do.
- Fix / rule: Any spec with on-device checks that need the backend says how the device reaches it (the Mac's LAN IP plus OAuth redirect URLs for it, a tunnel, or a hosted project), or marks those checks as blocked until the deploy slice. Promoted to `product-manager.md`.
- Source: user's on-device test during M1a

## 2026-11-21: Agent types created mid-session aren't spawnable until a new session  [area: process]
- What happened: `supabase-engineer`, `docs-writer` and `native-mobile` were added to `.claude/agents/` during the session but couldn't be spawned by name. The main session used general-purpose agents told to read and follow the agent file.
- Why (root cause): Agent definitions are loaded when the session starts.
- Fix / rule: After creating or renaming an agent file, either start a new session, or spawn a general-purpose agent whose prompt says "read and follow `.claude/agents/<name>.md`, including its tool limits". Note in the report which was used. (First occurrence; promote if it happens again.)
- Source: process, M1a session

## 2026-11-21: Keep `docs/before-production.md` current  [area: process]
- What happened: The user asked for a checklist of things that are fine for dev but must be revisited before real users, and wants it kept up to date. M1a already added several items (Tesseract assets in native exports, CDN default path, copy script in CI, `expo-mlkit-ocr` pin).
- Why (root cause): "Fine for now" decisions were scattered across ADRs, spec risks and review notes, so nothing collected them.
- Fix / rule: Whenever a task makes a "for now", "provisional" or "dev-only" decision, or a reviewer or QA flags a production-only risk, add an item to `docs/before-production.md` in the same task. Proposed for `CLAUDE.md` § How we work and `build-task` step 5.
- Source: user instruction during M1a

## 2026-11-22: App and DB tasks built in parallel drifted from their shared contract  [area: process]
- What happened: In M1b+M2 the app data layer (Task 8) was written against the spec before the database existed. Two mismatches surfaced mid-build: a single `discount_cents` lost whether the discount applied before or after the subtotal, so reloading a bill for host edit showed a false "doesn't add up" and blocked save; and the DB's one combined ±1¢ totals check disagreed with the form's two ±1¢ checks (a draft off by 1¢ + 1¢ passed the form and failed the DB as `invalid_bill`). Both were fixed in Amendment A3. A live smoke test against the local DB (21/21) then reconciled Task 8 with the real functions.
- Why (root cause): Second occurrence of the M1a "parallel agents worked from a stale snapshot" lesson, in a new form: two agents implemented the same contract (function arguments, stored fields, a validation rule) from the spec's prose, and nothing compared the two sides until something broke. The spec described the totals rule in words twice instead of defining it once.
- Fix / rule: When app and DB tasks run in parallel, the build has an explicit reconciliation step once the migrations apply: run the app's data layer against the live local DB, and check that every rule enforced on both sides gives the same answer on the same boundary cases. Data the UI must reload exactly (like a discount's position) is stored, not re-derived. Promoted to `build-task`, `product-manager` and `CLAUDE.md` § Conventions.
- Source: Amendment A3 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md; Task 8 smoke test

## 2026-11-22: A money rule enforced in both `lib/` and the DB must be the same rule  [area: money-math]
- What happened: The form (`checkTotals`) ran two ±1¢ checks; the DB ran one combined ±1¢ check. Each was correct on its own, but together the DB rejected bills the form accepted.
- Why (root cause): Second money-math lesson about totals checks (after M1a's "invalid input must never count as adds up"). The rule existed twice with no shared boundary tests.
- Fix / rule: A money rule that exists in both `lib/` and SQL is defined once in the spec (formula and tolerance), and both sides' tests include the same boundary cases (exactly at tolerance, 1¢ over, off by 1¢ on each of two checks). Promoted to `CLAUDE.md` § Conventions.
- Source: Amendment A3.2 in docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: A docs agent reported a task as "not built" because it ran before that task landed  [area: process]
- What happened: A docs agent running in parallel wrote "Task 19 not built" into the docs; Task 19 landed afterwards, so the statement was stale as soon as it was written.
- Why (root cause): Third occurrence of stale parallel context (M1a: ADR number collision, a docs task told to fix already-fixed text). The current `build-task` rule (re-read target files before editing) covers the files a docs agent edits, not its claims about the state of other tasks.
- Fix / rule: Docs tasks that describe what was built run after every task they describe has finished, or they leave status out. Before writing "not built", "pending" or similar, the docs agent checks the code itself, and the main session checks such lines before the summary. Promoted to `build-task` and `docs-writer`.
- Source: main session, M1b+M2 docs task

## 2026-11-22: Parallel Jest runs overloaded the machine; cap workers  [area: testing]
- What happened: Load average reached 56–163 while several agents ran Jest at the same time (each run uses all cores by default) alongside a macOS storage service. This caused repeated timeout-only failures. `--maxWorkers=4` and fewer simultaneous test runs fixed it.
- Why (root cause): Second occurrence of the M1a lesson "Jest timeouts under heavy machine load". Re-running a timed-out file alone (the M1a rule) treats the symptom; the cause is N parallel agents × all-core Jest runs.
- Fix / rule: Agents run `npm test -- --maxWorkers=4` (or a single file with `npx jest <file>`). The main session runs at most two full test suites at once. If load is still high, check `uptime` before treating timeouts as real. Promoted to `CLAUDE.md` § Commands, `qa-tester`, `implementer` and `build-task`.
- Source: environment issues during the M1b+M2 build; M1a lesson "Jest timeouts under heavy machine load are not real failures"

## 2026-11-22: Live multi-user smoke tests with throwaway users, done by hand twice  [area: testing]
- What happened: Task 8 reconciled the data layer with a 21-check live smoke test, and QA ran a 49-check live multi-user run. Both minted throwaway local users through the Supabase admin API, with keys piped from `npx supabase status -o env` into the command's environment (no `.env` read), and exercised RLS, claims and realtime as different users.
- Why (root cause): pgTAP checks the DB from inside Postgres, and Jest uses fakes. Only a live run as several real users checks the app's client calls, the RLS and realtime together. No script or skill existed, so each agent rebuilt the procedure.
- Fix / rule: The same multi-step workflow done by hand twice becomes a skill (`live-db-smoke`). Keys stay in process environment only, never printed or written to a file. Users are throwaway and local-only.
- Source: Task 8 and QA of docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: DB review: audit log could be forged, profiles over-shared, guards ran through the caller's RLS  [area: rls]
- What happened: The DB review found the following. Co-participants could read whole `profiles` rows when only `display_name` was intended. `service_role` could insert forged activity events. The append-only guard on events was judged through the caller's RLS instead of unconditionally. Two permissive policies covered the same role and action. `set_claim` had an FK race (the item could be deleted between check and insert). `discount_cents` was logged twice in one event, and a merge of groups wasn't logged at all.
- Why (root cause): Second RLS-area lesson (after M0's "RLS is not enough"). Table-level thinking again: "who can read this table" was answered, but not "which columns" or "who can write the audit trail". Event logging was added function by function with no test that each action logs exactly one event.
- Fix / rule: Cross-user reads expose only the intended columns (column-level SELECT grants, or a view/function returning only those columns). Audit/append-only tables are written only by triggers or `security definer` functions. Revoke INSERT/UPDATE/DELETE from every role that doesn't need it, including `service_role`, and enforce append-only with a trigger that doesn't depend on RLS. One permissive policy per role and action. Functions that insert child rows lock or re-check the parent in the same statement, and map FK violations to a clean error. pgTAP asserts one event per state-changing action, including merges. Promoted to `supabase-engineer` and `code-reviewer`.
- Source: DB review of docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: Realtime facts verified from the installed packages  [area: expo]
- What happened: Reading the installed `@supabase/*` sources and types showed four things. `realtime.setAuth()` must be called after a session is restored or private channels get the anon role. Only one channel per topic is allowed per client. `removeChannel` is async and must be awaited before re-subscribing. An embed is ambiguous when two FKs link the same tables, so the FK name has to be given.
- Why (root cause): Docs and memory disagreed with the installed versions; checking `node_modules` settled each question before it became a bug.
- Fix / rule: Keep doing this for library behavior that a design depends on: cite the installed file. These four facts belong in a concept note on realtime (main session's step 5).
- Source: Task 8 / realtime tasks, M1b+M2

## 2026-11-22: App review: stale state, early optimism and lossy rollbacks  [area: expo]
- What happened: The app review found several problems. The edit screen decided which claims a save would drop from a stale claims snapshot, so it could silently drop a claim made after the screen loaded. A custom split was applied optimistically before the claim it depended on had committed. A failed extras change rolled back to `null` instead of the previous value. A no-op split save rewrote "set by". Split math ran three times per render. Tests leaked `act()` warnings.
- Why (root cause): Second occurrence of M1a's "every async flow needs a path for cancel, failure and sign-out", now with live data. Decisions were made on whatever data the screen had, not the server's current state, and failure paths weren't designed.
- Fix / rule: With realtime data, a decision that can destroy data (drop claims, overwrite a split) re-reads current server state at decision time, or the server function checks it. Optimistic updates start only after what they depend on has committed. Rollback restores the exact previous value. Saves that change nothing don't write (or log). Derived money results are computed once per data change (`useMemo` over the `lib/` call). Tests await state updates (`findBy*`, `waitFor`) so there are no `act()` warnings. Promoted to `code-reviewer` and `implementer`.
- Source: app review of docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: A row's screen-reader label hid its price and status  [area: expo]
- What happened: An item row's `accessibilityLabel` gave only the name, so VoiceOver users couldn't hear the price or who claimed it.
- Why (root cause): Second accessibility finding (after M1a's missing hints). A custom `accessibilityLabel` on a grouped row replaces everything inside it for screen readers, and that wasn't obvious.
- Fix / rule: A custom label on a row or card includes everything the row shows that matters (name, amount, status, who), in reading order. Promoted to the `ui-ux-designer` skill.
- Source: app review of docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: A grep criterion matched an unrelated identifier  [area: testing]
- What happened: Criterion 107's literal grep (forbidding a user-facing message) matched a style name `styles.message`, so QA failed it although the behavior was right. The style was renamed.
- Why (root cause): Third grep-based check that gave the wrong answer (M0: the leak check matched the guard; M1a: `git grep` skipped untracked files). This time it was a false positive: the pattern was broader than the thing it protected.
- Fix / rule: The PM writes grep patterns that target the forbidden thing specifically (word boundaries, quotes, the call shape) and runs them once on the current tree to see what they match. QA reports a match that isn't the forbidden thing as "criterion wording", per the build-task criteria-change rule, rather than asking for a rename. Promoted to `product-manager`.
- Source: QA criterion 107, docs/specs/2026-11-20-m1b-m2-share-and-claim.md

## 2026-11-22: Agents cut off by usage limits resume cleanly; new agent types appear after a session branch  [area: process]
- What happened: Agents were cut off by usage limits three times. Resuming each with SendMessage lost no work. Agent types created mid-session became spawnable after the session was branched.
- Why (root cause): A resumed agent keeps its own context. Agent definitions load at session start, which confirms the M1a lesson.
- Fix / rule: After a cutoff, resume the same agent with SendMessage rather than spawning a fresh one, and ask it to re-check files it was editing. For new agent types, a session branch is enough (the M1a rule still holds). No promotion: the existing rule worked.
- Source: M1b+M2 build process

## 2026-11-22: Real user data went into a folder that wasn't gitignored  [area: process]
- What happened: The user saved real receipt photos in `receipts/` at the repo root, which wasn't gitignored (only `eval/receipts/` was). The main session added `/receipts/` to `.gitignore` before anything was committed.
- Why (root cause): The `receipt-eval` skill gitignores its own folder, but nothing checks a folder the user creates ad hoc.
- Fix / rule: Before reading or using a user-provided folder of real data (photos, exports), run `git check-ignore <path>`. If it isn't ignored, add it to `.gitignore` first and tell the user. First occurrence; promote if it recurs.
- Source: parser side-task, M1b+M2 session

## 2026-11-22: Root `.env` still carries Google OAuth variables (reported again)  [area: expo]
- What happened: QA again reported that `npx expo-doctor` sees `google_oauth_webclient1_*` in the root `.env`. This is at least the second report; the user action is still pending.
- Why (root cause): The item lives only in QA reports, where it's easy to skip over.
- Fix / rule: Open user actions that were reported before go at the top of the build summary as "still open since <task>", and into `docs/before-production.md` if they aren't there already. Promoted to `build-task` step 7.
- Source: QA report M1b+M2; M1a lesson "Root `.env` carries Google OAuth variables"

## 2026-11-22: Multi-user features need their interaction rules asked up front  [area: process]
- What happened: The spec phase took several waves of user decisions: live claims, host edits, seeing who claimed, auto even split plus custom split, qty > 1 as separate unit rows, any claimer setting everyone's parts, keeping custom parts when people join or leave, an activity log, proportional vs even extras with totals hidden until all claimed, and no settling while anything is unclaimed. The PM's questions were well structured. The user overrode several recommendations, usually toward the fuller behavior.
- Why (root cause): Multi-user features have a predictable set of questions (who may change what, what happens on join/leave, what others can see, what an incomplete state shows), and they came out one wave at a time.
- Fix / rule: For multi-user features, the PM's first round of open questions covers permissions per role, membership changes, visibility of other people's choices, incomplete/pending states and audit, all at once. When the PM recommends the simpler option, it says what the fuller one would give the user. First occurrence of this shape; promote if it recurs.
- Source: spec phase of docs/specs/2026-11-20-m1b-m2-share-and-claim.md (A1, A2)

## 2026-11-22: User UI preferences from M1b+M2  [area: expo]
- What happened: The user made these choices: optional input is opt-in ("+ Add note" instead of an empty note box); a tip option appears when the receipt has none (being built); the wording is "proportionally" / "evenly"; the activity log keeps per-minute headers; the "Unclaimed" row shows whenever $0 items plus tax are unaccounted for.
- Why (root cause): Same direction as M1a's "simple, uncluttered" preference: show controls only when they're wanted, and never hide money that isn't assigned yet.
- Fix / rule: Optional fields start collapsed behind a quiet "+ Add …" control. An unassigned remainder is always shown while it's non-zero, including when the items are $0 and only tax remains. Promoted (opt-in inputs) to the `ui-ux-designer` skill.
- Source: user preferences during M1b+M2

## 2026-11-22: User's rules for reading receipt lines  [area: receipt-parsing]
- What happened: Working with real receipts, the user stated three rules. A quantity is always an integer directly left or right of the item name. A price always has exactly two decimals. A number followed by "." or ")" is part of the name, not a quantity. Tesseract misreads (a lost price, "57.71" read as "57.1") are caught by the totals banner rather than by the parser.
- Why (root cause): These are the user's domain rules from their real receipts. They narrow what the parser should guess at.
- Fix / rule: Parser changes follow these rules, and their tests include a case for each (e.g. "2) Tacos", "1. Soup", a 1-decimal amount treated as not a price). OCR-level misreads are left to the totals check, not patched in the parser. Real receipts live in gitignored `/receipts/` or `eval/receipts/`.
- Source: user instruction, parser side-task during M1b+M2

## 2026-11-24: Flow tests missed a path again: home mounting while the invite resumes  [area: testing]
- What happened: Criterion 37 ("the Venmo prompt doesn't interrupt invite resume") was only tested on the path where home never mounts. The reviewer asked for the path that actually happens on web: prompt pending, a saved invite, and the app opening on `/` so home mounts and its prompt fetch runs while the resume effect navigates. The fix added that test on native and on web.
- Why (root cause): Second occurrence of the M0 lesson "Router tests must cover web and native paths". That rule is only in `native-mobile.md`, and it talks about `Platform.OS` branches. The gap here was a different entry route (landing on `/` after the OAuth redirect on web) rather than a literal branch, so the implementer didn't see the rule as applying.
- Fix / rule: A test for a navigation or auth flow covers every route the app can open on for that flow (deep link, `/` after the web OAuth redirect, cold start with a saved session) on both web and native, and checks that any screen that mounts on the way (and its fetches) doesn't navigate or show UI it shouldn't. Promoted to `implementer` and `code-reviewer`.
- Source: R1 in review of docs/specs/2026-11-24-profile-venmo.md; M0 lesson "Router tests must cover web and native paths"

## 2026-11-24: Spec said a grep "matches nothing today", but it matched  [area: testing]
- What happened: Criterion 18's grep `'A-Za-z0-9_-'` was noted as matching nothing outside `lib/venmo.ts`, but it matched the invite-code check in `lib/pendingInvite.ts:12`. The criterion was narrowed to `'A-Za-z0-9_-]{5,30}'` (wording only).
- Why (root cause): Fourth grep-based check that gave the wrong answer. The PM rule already says "run it once on the current tree and note what it matches today", but the PM has no Bash, so it can't run the exact `grep -rnF` command from the criterion, and the "matches nothing" note wasn't backed by a search with the same pattern and paths. A character class is also a pattern other validators share.
- Fix / rule: The PM runs the criterion's search with the Grep tool using the same pattern (regex-escaped if the criterion uses `-F`) and the same paths, and pastes the matching files into the spec. If it can't do that, it writes "not run" instead of "matches nothing", and the implementer runs it first. A pattern meant to find one definition includes something unique to it (the length bound, the constant name). Promoted to `product-manager`.
- Source: criterion 18 amendment, docs/specs/2026-11-24-profile-venmo.md; earlier grep lessons (2026-11-19, 2026-11-21, 2026-11-22)

## 2026-11-24: With column-level grants, a bare `.select()` fails with 42501  [area: rls]
- What happened: Criterion 34 used `update(...).eq(...).select()`. supabase-js sends `select=*`, so Postgres needs SELECT on every column for `RETURNING *`. `profiles` deliberately has no client SELECT on `created_at`, `updated_at` or `venmo_prompt_dismissed_at`, so the call fails with `42501` for every caller, the owner included. The criterion was amended to `.select('venmo_username')`, the shape `lib/profile.ts` already uses (pending the user's OK).
- Why (root cause): Third RLS-area lesson. Column-level grants (the M1b+M2 rule) have a side effect nobody wrote down: anything that expands to `*` (`select('*')`, a bare `.select()` after insert/update/upsert, `returning *` in SQL) breaks for clients. The PM wrote the criterion from the supabase-js habit, not from the table's grants.
- Fix / rule: On a table with column-level SELECT grants, every client read and every `.select()` after a write names its columns, in app code, criteria and smoke scripts. Reviewers flag a bare `.select()` or `select('*')` on such a table. The supabase-engineer notes in the migration's comments which columns clients can't read, so the spec writer sees it. Promoted to `supabase-engineer`, `code-reviewer` and `product-manager`.
- Source: criterion 34 amendment (Task 6), docs/specs/2026-11-24-profile-venmo.md

## 2026-11-24: A pgTAP test counted all claims and failed on real local data  [area: testing]
- What happened: The existing `bills_rls` criterion 21 test selected every row in `claims`. After `npx supabase migration up` (no reset, as the live-db-smoke skill says), the user's own local bills were in the table and the test failed. It's now scoped to the fixture bills.
- Why (root cause): The test was written against a freshly reset database. Once the rule became "don't `db:reset` without asking", the local DB can hold the user's real data, so whole-table assertions stop being reliable.
- Fix / rule: pgTAP assertions filter to the rows the test created (fixture ids or a unique run tag), never whole-table counts or selects. A test that only passes on an empty DB is a bug. Promoted to `supabase-engineer`.
- Source: process event during docs/specs/2026-11-24-profile-venmo.md (`bills_rls.test.sql` criterion 21)

## 2026-11-24: Checks ran against an environment that wasn't the one assumed  [area: process]
- What happened: Two things in one task. Docker was down, so the supabase-engineer couldn't run migrations or pgTAP, and the main session had to stop and ask the user to start it. QA then found that the dev server already running on :8081 points at the hosted Supabase project, where the new migration isn't applied, so it couldn't verify the slice through that server.
- Why (root cause): The fourth time the environment differed from what the step assumed (M1a: Supabase not restarted after a `supabase/.env` change; M1a: `127.0.0.1` on the phone; M1a: a cached bundle with stale `EXPO_PUBLIC_` values). Nobody checks the environment before agents start, and QA reuses whatever server is already running.
- Fix / rule: Before spawning any agent that needs the local DB, the main session runs `npm run db:status`; if Docker or the stack is down, it asks the user to start Docker first. QA doesn't trust an already-running dev server: it checks which Supabase host the served bundle points at (without reading `.env`) and, if it isn't local, starts its own on a free port with local values passed inline. Promoted to `build-task` and `qa-tester`.
- Source: process events and QA report, docs/specs/2026-11-24-profile-venmo.md; M1a lessons on stale Supabase, phone `127.0.0.1` and baked `EXPO_PUBLIC_` values

## 2026-11-24: Other sessions' half-finished edits broke whole-repo test and typecheck runs  [area: testing]
- What happened: Several sessions ran Jest and `tsc` at the same time. Files another session was in the middle of editing made the full suite and the type-check fail for a while, in files outside this task.
- Why (root cause): Fourth occurrence of parallel work interfering (stale ADR numbers, stale docs claims, Jest overload). `npm test` and `npm run typecheck` cover the whole repo, so one session's in-progress file fails everyone's run. The worker cap fixes load but not this.
- Fix / rule: When a full run fails only in files the task didn't touch, check `git status` / modification times for those files, re-run once after a short wait, and if it still fails, report it as "outside this task, likely in progress elsewhere" with the file list. Don't fix or revert those files. Your own files must pass on their own (`npx jest <your files>`). Promoted to `implementer` and `qa-tester`.
- Source: process event during docs/specs/2026-11-24-profile-venmo.md; 2026-11-21 and 2026-11-22 parallel-work lessons

## 2026-11-24: live-db-smoke's env loading didn't export the keys  [area: testing]
- What happened: The skill says `eval "$(npx supabase status -o env)" && node <script>.mjs`. Under Supabase CLI v3 the output is plain `NAME="value"` lines, so `eval` sets shell variables that the `node` child process doesn't see, and the script stops with "missing env". `set -a` before the `eval` fixes it.
- Why (root cause): The skill was written from the M1b+M2 runs and the variable names were marked "verify", but whether the output exports the variables wasn't checked.
- Fix / rule: Load keys with `set -a; eval "$(npx supabase status -o env)"; set +a; node <script>.mjs`, all in one command. A skill step that broke in use gets fixed in the skill. Proposed for `live-db-smoke`.
- Source: process event during Task 6 / QA of docs/specs/2026-11-24-profile-venmo.md

## 2026-11-24: Root `.env` Google variables, third report  [area: expo]
- What happened: `npx expo-doctor` again lists `google_oauth_webclient1_*` in the root `.env`. This is the third report (M1a, M1b+M2, this task). The build-task rule says to put it first in the summary and in `docs/before-production.md`, but it isn't in `docs/before-production.md` yet.
- Why (root cause): A user action that no file tracks keeps getting re-reported instead of closed.
- Fix / rule: The main session adds it to `docs/before-production.md` (§3 Sign-in) now and puts it first in this summary as "still open since M1a". No new rule; the existing one wasn't applied.
- Source: QA report, docs/specs/2026-11-24-profile-venmo.md; lessons 2026-11-21 and 2026-11-22

## 2026-11-24: Checks that need a human weren't planned as user steps  [area: process]
- What happened: Criterion 40 ended partial: real Google sign-in and the iOS simulator run weren't checked (an agent can't complete Google's sign-in page), and the phone check was blocked as the spec expected.
- Why (root cause): The spec listed the manual check as a QA criterion. Real OAuth sign-in and hands-on simulator use need the user, so "partial" was the predictable result.
- Fix / rule: The PM marks a criterion that needs a person (real Google sign-in, tapping through the simulator or a phone) as **User check**, with exact steps, and QA verifies everything around it (for example with a locally signed session) and lists it under "for the user" instead of partial. First occurrence in this form; included as a small change in the PM proposal because the cost of a wrong partial is low but recurring.
- Source: QA criterion 40, docs/specs/2026-11-24-profile-venmo.md

## 2026-11-24: User UI choices: one sign-out, prompts as dismissible cards  [area: expo]
- What happened: The user chose Sign out on Profile only (Q1, option A) and the "Add your Venmo" prompt as a small card on home with "Add Venmo" and "Not now" (Q2, option A), over an inline form or a full-screen step after sign-in. Both were the PM's recommendations, and asking up front meant Task 5 never had to be redone.
- Why (root cause): Same direction as earlier preferences (simple, uncluttered, opt-in): one place per action, and nudges that never interrupt a flow.
- Fix / rule: Each action has one home in the UI, with no duplicate controls. Nudges ("add X") are dismissible cards on an existing screen, not interstitial screens or modals, and they never touch the resume/navigation path. The "ask, don't default" PM rule worked here; keep it. First occurrence of the nudge preference; promote to `ui-ux-designer` if it recurs.
- Source: user decisions Q1 and Q2, docs/specs/2026-11-24-profile-venmo.md

## 2026-11-24: User wants a product- and UX-minded engineer to build screens  [area: process]
- What happened: The user asked for a senior engineer agent who "thinks product and UI/UX first" to build the screens.
- Why (root cause): The `implementer` focuses on behavior and tests. Design only comes in as a `ui-ux-designer` pass after the behavior is built (M1a lesson), so screen structure, states and copy are decided by someone who isn't thinking about the user, and fixing them afterwards means rework.
- Fix / rule: Screen tasks go to an agent that starts from the user's goal, states and copy, loads the `ui-ux-designer` skill before writing UI, and keeps the implementer's testing rules. Proposed as a new agent `product-engineer` plus a routing change in `build-task`.
- Source: user request during docs/specs/2026-11-24-profile-venmo.md

## 2026-11-24: A parser rule that reinterprets lines must compare against today's reading and fall back  [area: receipt-parsing]
- What happened: The "first of two different Totals is the subtotal" rule needed three review rounds. Round 1 (R1, R2, R3, R4): it fired when a fee or tip was printed above the first Total, and it counted tax a second time when that tax was already inside the first Total but its label lacked "incl" (VAT 20% after a VAT-inclusive Total, a Net/VAT breakdown, tax between repeated Totals). It also missed included tax-sum rows and took a positive "Savings" line as a discount. Round 2: when an item was lost to OCR, both readings were off, and the rule's reading was kept even though it added tax or a discount. The fixes were a wider guard (A6), a fallback to the old reading when the rule's reading has a mismatch the old one doesn't (A6 R5), and a fallback when the rule's `subtotal_vs_total` gap is over tolerance and it changed tax or discounts (A7).
- Why (root cause): Second occurrence of the 2026-11-21 lesson "Parser fixtures were cleaner than real OCR output" (review R5 said so). The spec's guard listed the layouts the PM thought of (a card slip with tax before the Total, "VAT included"). It didn't ask what could already be inside the reinterpreted amount: tax, fees, tip, discounts or included tax printed above or below it. Label-based guards can't cover every layout. The 2026-11-21 rule ("reviewers probe with generated messy inputs") was only in the log, not in any agent file. It still worked because this reviewer did it anyway: an old-vs-new probe harness on invented receipts found every counterexample.
- Fix / rule: A parser rule that reads lines differently from today computes today's reading as well and falls back to it whenever the new reading reconciles worse (`totalsGaps`), or is off and changed tax, tip or discounts. That way total, tip and tax are never worse than today (the user's priority, A2). The spec lists everything that could already be inside the reinterpreted amount before writing guards. Reviewers of `lib/receiptText.ts` changes run the old and new parser side by side on generated messy receipts and report each receipt whose total, tip or tax got worse. Promoted to `product-manager`, `implementer` and `code-reviewer`.
- Source: R1–R5 of review round 1 and the blocking finding of round 2, docs/specs/2026-11-24-first-total-as-subtotal.md (A6, A7); lesson 2026-11-21 "Parser fixtures were cleaner than real OCR output"

## 2026-11-24: A review fix covered the listed receipts, not their class  [area: testing]
- What happened: Round 1's fix (A6) handled the four receipts the reviewer listed, plus the "one reading off, the other not" case. Round 2 then found the same class of bug (the rule adds tax or a discount that's already counted) when both readings were off, because an item was also lost to OCR.
- Why (root cause): The fix was checked against the reviewer's examples, so the "both readings off" combination was never tested. Real OCR often has two problems on one receipt.
- Fix / rule: When a finding comes with example inputs, the implementer states the class they belong to, fixes that class, and adds at least one test that combines it with another common fault (a lost item, a misread amount). Included in the parser proposal for `implementer`.
- Source: review round 2 of docs/specs/2026-11-24-first-total-as-subtotal.md → A7

## 2026-11-24: User's rules for Total lines and parser priorities  [area: receipt-parsing]
- What happened: The user said "if several Totals differ, the last is the total and the first is the subtotal". They approved the guard (no Subtotal line, no tax before the first Total), chose not to fire with 3+ distinct Total amounts (Q1 b), chose to count a discount between the Totals (Q2 b), and asked for the VAT-included fix in the same task. They also set the priority: "total, tip and tax matter most; subtotal can be left blank (or computed from items)".
- Why (root cause): These are the user's domain rules, and they settle what the parser should do when it's unsure.
- Fix / rule: Parser changes must never make total, tip or tax worse than today. When unsure, leave `subtotalCents` null rather than guess (computing it from the items is a possible follow-up). If a guard is ambiguous, don't fire. Included in the parser proposal for `product-manager`.
- Source: user decisions, Amendments A1 and A2 of docs/specs/2026-11-24-first-total-as-subtotal.md

## 2026-11-24: The eval couldn't show the change, because the motivating receipt's read lacked the lines  [area: receipt-parsing]
- What happened: QA found the eval identical to the baseline. The web read of the held-out receipt that motivated the rule had lost both Total amounts, so the rule could never fire on it. The 8-receipt eval was neutral, and the invented unit tests were the only evidence.
- Why (root cause): The spec was written from the receipt's answer file (`receipts/answers/less-contrast.txt`), not from the saved OCR read the eval actually parses. Nobody checked that the read had the lines the rule depends on.
- Fix / rule: Before speccing a parser rule motivated by a real receipt, check its saved read (`eval/receipts/<name>.ocr.json`) for the lines the rule needs. If they aren't there, the spec says up front that the eval can't show the effect, so QA's "neutral" is expected rather than a surprise. Included in the parser proposal for `product-manager`.
- Source: QA report, criterion 10, docs/specs/2026-11-24-first-total-as-subtotal.md

## 2026-11-24: A spec said an existing test would "pass without edits", but it asserted the old behavior  [area: process]
- What happened: Task 2 (from the PM's UX pass: a blank subtotal no longer counts as "incomplete") had A3-9 say `lib/billPayload.test.ts` passes without edits. The assertion at `lib/billPayload.test.ts:311` expected `incomplete` for that draft, so A5 reworded the criterion.
- Why (root cause): Fifth unverified "nothing else is affected" claim in a spec (the earlier ones were grep criteria). The PM changed a behavior without searching the tests for assertions of the old behavior.
- Fix / rule: When a spec changes behavior, the PM greps the tests for the old expected value (status, reason code, copy key) and lists in the criterion each test that must change. "Passes without edits" is only written after that search. Included in the parser proposal for `product-manager`.
- Source: Amendment A5 of docs/specs/2026-11-24-first-total-as-subtotal.md; lessons 2026-11-21, 2026-11-22 and 2026-11-24 on grep claims

## 2026-11-24: The baseline parser copy went to the scratchpad, not the spec's path  [area: process]
- What happened: Step 0 said to copy the unmodified parser to `eval/receipts/receiptText.pre-2026-11-24.ts`. The main session saved it in the session scratchpad instead. Reviewers and A6/A7 tests used the "pre-change copy" for comparison. QA flagged the deviation.
- Why (root cause): The scratchpad was convenient, but it can be cleared, and other agents and later sessions can't count on it. The deviation also wasn't recorded as an amendment.
- Fix / rule: Baseline artifacts that criteria or later reviews depend on go to the path the spec names (durable and gitignored, like `eval/receipts/`). If a different path is used, record it in the spec. First occurrence; promote if it recurs.
- Source: QA report, docs/specs/2026-11-24-first-total-as-subtotal.md (Step 0)

## 2026-11-24: User delegated UX decisions: decide, log for review, keep building  [area: process]
- What happened: The user told the team to keep building and to log decisions in `docs/decisions-to-review.md` rather than stop. They asked for the PM to handle UX, with "don't over engineer but don't lose nice features, don't confuse end users". The PM decided A3 (leave a blank subtotal blank, don't auto-fill it) and logged it there. Task 2 shipped without a stop.
- Why (root cause): The standing "ask, don't default" rule would otherwise have paused the task. The user's direction overrides it for that task.
- Fix / rule: When the user delegates decisions for a task, the PM decides, gives the reason in one line, and records each decision in `docs/decisions-to-review.md` with the spec amendment it belongs to. Decisions about money, providers or anything hard to reverse still go to the user. First occurrence; promote to `product-manager` and `build-task` if it recurs.
- Source: user direction, Amendment A3 of docs/specs/2026-11-24-first-total-as-subtotal.md

## 2026-11-24: Delegated decisions, second time: about 40 logged, one departed from a CLAUDE.md convention  [area: process]
- What happened: In M3 the user answered Q1–Q10 with "accept all recommended", then asked the team to keep building without stopping and to log decisions in `docs/decisions-to-review.md`. The main session saved that as a feedback memory. About 40 decisions were logged (M3-1 … M3-11, M3-UX-1 … 15, M3-B-1 … 15, M3-R-1/2, M3-Q-1) and the slice shipped with no stop. Money questions still went to the user: Q10 (the all-$0 case) was raised as a question. But one decision under the "don't block" rule departed from a CLAUDE.md convention: review R2's app/DB difference on Q10 was recorded as K6 (M3-B-12, M3-R-1) instead of making both sides the same rule, as § Conventions asks. The entries also came in four formats (tables with and without a "Why" column, bullet lists, a decision repeated as M3-6, M3-B-12 and M3-R-1).
- Why (root cause): Second occurrence of the 2026-11-24 "user delegated UX decisions" lesson. The rule lives only in the log and in a session memory, not in `product-manager` or `build-task`, so each agent improvised the format, and nothing said that departing from a written convention needs the user's eyes even when building continues.
- Fix / rule: When the user delegates, agents decide, give a one-line reason and log each decision in one row format (id, decision, picked, alternatives, why, status), under the task's heading, updating an existing row instead of adding a new one for the same decision. Money, providers and hard-to-reverse choices still go to the user. A decision that departs from `CLAUDE.md` or an ADR doesn't stop the build, but it goes at the top of the build summary as "needs your look". Promoted to `product-manager` and `build-task`.
- Source: user direction during docs/specs/2026-11-24-m3-settle-venmo.md; `docs/decisions-to-review.md` (M3 sections); review R2; lesson 2026-11-24 "User delegated UX decisions"

## 2026-11-24: A staff-engineer review before the screen tasks simplified the plan  [area: process]
- What happened: The user asked for a staff engineer and a UX-minded PM to coordinate on the design. A Plan agent, acting as staff engineer, reviewed the spec and produced a technical brief: drop `AppState` return detection for v1 (iOS goes `inactive` for Control Center and Face ID, and a blocked web popup can't be seen), count every mark for `expected_cleared`, call `openPaymentLink` synchronously as the first statement on web (so popup blockers treat it as a user gesture), and merge Tasks 8, 9 and 11 into one screen task (the same files would have been reworked three times). The PM folded it into the UX brief and Amendment A1. The product-engineer built the screens in one task with one design pass.
- Why (root cause): The spec was written feature by feature. Nobody looked at the whole plan for platform traps and rework across tasks before implementation started. The one cost: "count every mark" left a count-based race (review R5, M3-R-2), so the brief's simplifications need their trade-offs written down.
- Fix / rule: For slices that add screens on top of new DB functions, a staff-engineer review of the spec runs before implementation. It looks for platform behavior that breaks the design, tasks that rework the same files, and simplifications, and it states the trade-off of each simplification. The PM merges its points as a dated amendment. User request, first occurrence; proposed as a `staff-engineer` agent and a `build-task` step.
- Source: user request; Amendment A1 and `docs/specs/2026-11-24-m3-settle-ux.md`; review R5

## 2026-11-24: A seeded property test found a money case the spec's boundary tables missed  [area: money-math]
- What happened: Task 4's 500-bill property test (criterion 33) produced a proportional bill whose rows were all $0.00 with a total above 0. The weights are all zero, so the extras can't be spread and `unassignedCents > 0` even though every item is claimed. The spec's K1–K5 and A1–A7 tables didn't include it. It went to the user as Q10, who chose to block settling with fixed copy.
- Why (root cause): The boundary tables listed the cases the PM thought of from the claim and amount rules. Degenerate inputs to the split math itself (every weight zero, no rows, negative shares) weren't listed. The random test explored them anyway.
- Fix / rule: Any spec that builds on `computeShares` lists the degenerate split inputs as boundary cases (every weight 0 in proportional mode, no rows with a total above 0, a negative share in even mode, one participant, a three-way remainder tie) and keeps a seeded property test over random bills in both modes. A case the property test finds goes to the user if it changes what someone sees or owes, as Q10 did. Money-math has several lessons now; included in the money-math proposal for `product-manager`.
- Source: Task 4 property test → Q10, docs/specs/2026-11-24-m3-settle-venmo.md

## 2026-11-24: The app and DB rules for "complete" now differ on purpose (K6)  [area: money-math]
- What happened: Review R2 found that the app blocks settling on the all-$0 bill (`blocked_all_zero`) but the DB's `private.bill_is_complete` says complete and accepts `mark_paid`. It was kept on purpose and recorded as C1 case K6, tested on both sides, because marks are honor-system and the app shows no Pay or "I paid" buttons there. Matching it in SQL would mean re-implementing part of `computeShares`.
- Why (root cause): Second time a rule enforced on both sides disagreed (after 2026-11-22's ±1¢ totals check). This time the difference is defensible, but the CLAUDE.md convention allows no exceptions, so it was decided against the written rule under "don't block".
- Fix / rule: If the two sides deliberately differ, the spec's boundary table lists the case with both answers and the reason, both sides test it, and the user approves the exception. Proposed as a wording change to `CLAUDE.md` § Conventions.
- Source: review R2; M3-B-12 and M3-R-1 in `docs/decisions-to-review.md`; lesson 2026-11-22 "A money rule enforced in both `lib/` and the DB must be the same rule"

## 2026-11-24: Waiting for the refetch meant a failed refetch left the buttons stuck  [area: expo]
- What happened: Review R1 (should-fix): the Settle screen makes no optimistic changes, so after a write it waits for the refetch that contains the result. When that refetch failed, the buttons stayed disabled. It was fixed with `useBill`'s `finished` signal. Review R7 (nit): Pay had no double-tap guard, so one double tap could open two Venmo tabs. It now ignores a second tap within 1 s (M3-B-15).
- Why (root cause): Third occurrence of the 2026-11-21 lesson "Every async flow needs a path for cancel, failure and sign-out" (after M1a and M1b+M2's app review). The 2026-11-22 rule "optimistic updates start only after what they depend on has committed" pushed the screen toward waiting on a refetch, and the refetch became a second async step whose failure nobody designed. `product-engineer` tests "failed save" but not "save worked, reload failed".
- Fix / rule: When the UI waits for a refetch to show a write's result, the write and the refetch are two steps with their own endings. A failed or never-arriving refetch re-enables the controls and shows an error with a retry. A control that opens something outside the app (a link, a share sheet) ignores repeat taps while that's happening. Promoted to `product-engineer`.
- Source: R1 and R7 in review of docs/specs/2026-11-24-m3-settle-venmo.md; lessons 2026-11-21 and 2026-11-22

## 2026-11-24: Sentence templates broke at a count of 1 and when the name was "You"  [area: expo]
- What happened: Four copy bugs of one kind in one slice. Activity read "Hana changed who gets paid to Hana" for a self-change (review R3). The payer's card read "All 1 marked paid" (QA; the main session changed it to "They marked paid"). The engineer caught "…paying You." and "You is now collecting…", because `nameOf` returns "You" for the viewer (M3-B-3, M3-B-4).
- Why (root cause): The brief's copy table filled in names and counts as if they were always another person and always plural. Criterion 41b tested some plurals ("1 person owes you") but not every templated line.
- Fix / rule: Every sentence that takes a name or a count is tested with a count of 1 and with the viewer as each name it takes (actor, target), and the copy table says what those cases read. Promoted to `product-engineer`.
- Source: R3 in review, QA copy nit (M3-Q-1), M3-B-3 and M3-B-4 in `docs/decisions-to-review.md`

## 2026-11-24: Two concurrency gaps in the settle functions  [area: rls]
- What happened: Review nits. R9: when a payer deletes their account, the cascade and its trigger can take locks in a different order from `set_payer` / `mark_paid`, so the two could deadlock. R5: `set_payer`'s `p_expected_cleared` compares the count of marks, so one undo plus one new mark keeps the count and clears a mark the confirm didn't name (M3-R-2, accepted as rare and recoverable). The deadlock is in `docs/before-production.md`; the count race isn't yet.
- Why (root cause): A function and a trigger that lock the same rows were designed one at a time, without one lock order. The expected-state check was simplified to a count (staff-engineer brief) without listing what a count can't detect.
- Fix / rule: When several functions or triggers lock rows of the same bill, the migration header states the lock order (for example, bill row first) and every path follows it. Consult the `supabase-postgres-best-practices` reference `lock-deadlock-prevention.md`. An expected-state parameter says in the spec what it can't detect. The main session adds the count race to `docs/before-production.md`. First occurrence; promote to `supabase-engineer` if it recurs.
- Source: R5 and R9 in review of docs/specs/2026-11-24-m3-settle-venmo.md

## 2026-11-24: QA's own dev server worked; shell values override the root `.env`  [area: testing]
- What happened: Using the new backend-host check, QA started its own web server on :8082 with local Supabase values passed inline. That confirmed that values set in the shell win over the root `.env` for Expo commands, so an agent can point a server at the local stack without touching `.env`.
- Why (root cause): The 2026-11-24 environment rule was written without knowing whether the inline values would beat `.env`.
- Fix / rule: Keep doing it. No change; the existing `qa-tester` rule worked. Logged because the override is now a checked fact, not an assumption.
- Source: QA report, docs/specs/2026-11-24-m3-settle-venmo.md

## 2026-11-24: Root `.env` Google variables, fourth report  [area: expo]
- What happened: `npx expo-doctor` again lists `google_oauth_webclient1_*` in the root `.env`. It is in `docs/before-production.md` §3 now, and the user hasn't acted on it yet.
- Why (root cause): It's a user action. Agents can't touch `.env*`.
- Fix / rule: No new rule. Keep it first in the build summary as "still open since M1a". QA can say "already tracked" instead of reporting it as new.
- Source: QA report, docs/specs/2026-11-24-m3-settle-venmo.md; lessons 2026-11-21, 2026-11-22 and 2026-11-24

## 2026-11-24: The retro agent was asked to apply approved proposals and declined  [area: process]
- What happened: The retro agent was asked to apply proposals the user had approved. It declined, because its agent file says only the main session applies. The main session then applied them itself.
- Why (root cause): The retro skill's Mode B says "apply its change exactly" without saying who does it, while `.claude/agents/retro.md` says the retro agent only proposes. The two files read differently, so a round trip was wasted.
- Fix / rule: Mode B is done by the main session, never by the retro agent. Proposed as a wording change to the retro skill.
- Source: process event after the previous retro

## 2026-11-24: A second deadlock: the lock argument missed the locks Postgres takes for you  [area: rls]
- What happened: Review R1 (should-fix): `set_claim` locked the participant row (the claims FK check) and then the bill row (the FK check of its `bill_events` insert), while `remove_participant` / `leave_bill` lock the bill and then the participant row. Two such calls at the same moment could deadlock (40P01). The migration header argued the order was safe, but it only counted the explicit `for update` / `for share` statements. `set_item_split` and `join_bill` had the same shape. The fix (`20261124094656_people_review_fixes.sql`) adds `private.lock_bill_key_share` and a BEFORE INSERT trigger on `claims`, so every claim path takes the bill row first. R4: `leave_bill` took the bill lock before checking that the caller was on the bill, so anyone could hold locks on a bill they aren't on. Still open: `set_claim` is security invoker, so `authenticated` keeps INSERT/DELETE on `claims`, and a direct delete racing `update_bill` can still deadlock (PI-R-3, in `docs/before-production.md`). pgTAP can't run two sessions, so the test checks the lock order instead of a real deadlock.
- Why (root cause): Second lock-order finding (after M3's R9: account-delete cascade vs `set_payer`). The M3 lesson said "the migration header states the lock order", and it did, but nothing said to count implicit locks: an FK check takes `FOR KEY SHARE` on the referenced row, so an insert into `claims` or `bill_events` locks the participant, item or bill row; cascades and triggers lock more. A function that enforces the order also doesn't help while clients can write the table directly.
- Fix / rule: Every path that locks rows of one bill takes the bill row first, and the lock-order note lists each path's locks in order, implicit ones included (FK checks, cascades, triggers, event inserts). Check who may act before taking any lock. If a function enforces the order but clients can also write the table, make it `security definer` and revoke the direct write, or record the gap in `docs/before-production.md`. Reviewers write down each path's lock sequence from the code instead of trusting the header. Second occurrence; promoted to `supabase-engineer` and `code-reviewer`.
- Source: R1 and R4 in review of docs/specs/2026-11-24-people-and-invites.md; PI-R-2, PI-R-3; lesson 2026-11-24 "Two concurrency gaps in the settle functions"

## 2026-11-24: The spec assumed a library's API: no permission needed, and phone fields that don't exist  [area: process]
- What happened: PI-19 said "From contacts" would ask for no permission. native-mobile (Task 8) read the installed `expo-contacts` 57.0.9 sources: `Contact.presentPicker()` needs no permission but returns only the contact's id, and reading the numbers goes back to the contacts store, which needs contacts access on both platforms (PI-N-1, citing `ios/next/ContactRepository.swift:32-35` and `android/.../ContactRepository.kt:233-238`). The spec's phone-field shape (`digits`, `countryCode`) also didn't exist; the library gives `number` and `label`. PI-19 had been marked "Task 8 verifies", so that part of the rule worked. The field shape wasn't marked.
- Why (root cause): Third occurrence of "spec'd tool facts turned out false" (2026-11-19 config key, 2026-11-21 criterion 54 and the PSM value). The PM rule says "verified or marked", but the package wasn't installed when the spec was written, and a field list written into a contract doesn't look like a "tool fact".
- Fix / rule: A spec that depends on a library's API (returned fields, permissions it needs, platform differences) cites the installed package's types or source. If the package isn't installed yet, the shape is marked "unverified", and the task that installs and checks it runs before any task built on that shape. Promoted to `product-manager` (and to the staff-engineer checklist, if that agent is approved).
- Source: Task 8 (native-mobile), PI-19, PI-N-1 and the native section of `docs/decisions-to-review.md`; lessons 2026-11-19 and 2026-11-21 on tool facts

## 2026-11-24: A "can't happen" row was false, and a fixture kept the old answer after the amendment  [area: process]
- What happened: Boundary row M7 ("0 claims but a mark") was written as a state the app can't produce. The live reconciliation (56/56, no app/DB mismatches) showed that `mark_paid` accepts a mark from someone with 0 claims once every item is claimed; only the screen hides the button (PI-M-1). M7 was amended, but a test fixture still encoded the old claim, and review R3 found it.
- Why (root cause): The claim was based on what the UI shows, not on what the DB refuses. The amendment was made without searching the tests for the case it changed. Second occurrence of "a spec change wasn't checked against the tests" (2026-11-24 "passes without edits").
- Fix / rule: A boundary row that says a state "can't happen" names the DB constraint or function check that prevents it. If only the UI prevents it, the row says "UI hides it; the DB allows it" and gets a DB-side criterion. Whoever amends a case greps the tests and fixtures for its id and old value and updates them in the same change. Keep running the live reconciliation after parallel app/DB tasks: it found this. Promoted to `product-manager` and `build-task`.
- Source: Task 5 live reconciliation → M7 amendment and PI-M-1; R3 in review of docs/specs/2026-11-24-people-and-invites.md

## 2026-11-24: A membership change wasn't specced: added, then opened the link  [area: process]
- What happened: Review R6: someone the host added who later opened the bill's link stayed "added" instead of counting as joined. The main session decided PI-R-1 (joining makes you active) and PI-R-4 (log a `joined` event).
- Why (root cause): Second occurrence of the 2026-11-22 lesson "Multi-user features need their interaction rules asked up front" (membership changes). The spec added a new membership state (`added`) and listed actions, but not every state against every action, so one transition had no answer.
- Fix / rule: When a spec adds or changes a membership or status state, it includes a state × action table: every state a person can be in (not on the bill, added, joined, left, removed) against every action (open the link, be added, be removed, leave, claim, mark paid, delete account), with the result and the event logged in each cell. Promoted to `product-manager`.
- Source: R6 in review of docs/specs/2026-11-24-people-and-invites.md; PI-R-1, PI-R-4; lesson 2026-11-22 "Multi-user features need their interaction rules asked up front"

## 2026-11-24: A bundle check ran on a stale build, and the shell's grep skipped the binary bundle  [area: testing]
- What happened: Review R2: criterion 54 ("the web bundle has no picker code") was checked against a web build made before Task 10 wired the picker in, so its "no match" proved nothing. QA rebuilt both web and iOS into the scratchpad and used the iOS export as a control. In this shell `grep` is ugrep, which silently skips binary files, so a plain grep found nothing in the iOS Hermes `.hbc` bundle; `/usr/bin/grep -a` found `presentPicker` and `sendSMSAsync` (PI-C-8).
- Why (root cause): Fifth and sixth grep-based checks that gave the wrong answer (2026-11-19, 2026-11-21, 2026-11-22, 2026-11-24 twice). The qa-tester rule "show the check can find something" worked once QA applied it, but nothing says a build artifact must come from the current tree, and nobody knew the shell's `grep` isn't GNU grep.
- Fix / rule: A check over build output runs on a build made in the same run, from the current tree, into the scratchpad (never an existing `dist/`). Binary bundles (`.hbc`) are searched with `/usr/bin/grep -a`, and the positive control uses the same command. Promoted to `CLAUDE.md` § Commands and `qa-tester`.
- Source: R2 in review and QA criterion 54, docs/specs/2026-11-24-people-and-invites.md; PI-N-9, PI-C-8

## 2026-11-24: Native modules that throw under Jest got one global stand-in, which had to fail loudly  [area: testing]
- What happened: Importing the real `expo-contacts` / `expo-sms` under Jest throws, and every screen test that renders the bill imports them through `lib/contactPicker.native.ts`. The product-engineer added `test-utils/jestSetup.ts` (`jest.setupFilesAfterEnv`) with stand-ins for both (PI-C-7). Review R5: the first version's stand-ins returned quiet defaults, so a test that tapped "From contacts" without its own mock silently did nothing. They now reject, which shows the error copy.
- Why (root cause): A global mock answers for every test, including ones that never thought about it, so a quiet default hides a missing mock.
- Fix / rule: Global stand-ins for native modules live in `test-utils/jestSetup.ts` and reject or throw ("<module> not mocked in this test") unless a harmless constant is clearly the safe answer. A new native module that screens import gets a stand-in there. First occurrence of the rule; the file's location is added to `CLAUDE.md` § Commands so the next agent finds it.
- Source: PI-C-7 and R5 in review of docs/specs/2026-11-24-people-and-invites.md

## 2026-11-24: Delegated decisions, third time: one reversed a privacy choice, and the main session's tables dropped "Why"  [area: process]
- What happened: The PM logged PI-1 to PI-19 and the build never stopped. Other agents logged PI-B, PI-D, PI-N, PI-E and PI-C in the agreed row format. Two things to note. PI-N-1 reversed PI-19's "contacts stay private, no permission" (the app now asks for contacts access). native-mobile marked it "needs your review" in its own row, but no written rule says a new OS permission belongs at the top of the summary. The main session's own tables (PI-M-1, PI-R-1 to PI-R-4) had no "Why" column.
- Why (root cause): Third occurrence of the delegated-decisions lesson. The pending proposal lists money, providers and hard-to-reverse choices as the user's, but not privacy (new permissions, new personal data read), and it tells agents the row format without saying the main session uses it too.
- Fix / rule: Extend the pending delegated-decisions proposal: a decision that adds an OS permission prompt, reads new personal data, or reverses an earlier privacy decision goes at the top of the build summary as "needs your look", and the main session's rows use the same format, Why column included.
- Source: PI-19, PI-N-1, PI-M-1, PI-R-1 to PI-R-4 in `docs/decisions-to-review.md`; proposal `2026-11-24-delegated-decisions.md`

## 2026-11-24: A second deliberate app/DB difference: the DB accepts "I paid" from someone who owes nothing  [area: money-math]
- What happened: PI-M-1: `mark_paid` accepts a mark from a participant with 0 claims once every item is claimed. Only the screen prevents it by not showing the button. Such a mark also stops that person from being removed or leaving. It was accepted as honor-system (ADR 0015), because refusing it in SQL would need the split math there.
- Why (root cause): Second time (after K6 in M3) that the app and the DB answer a money-adjacent rule differently on purpose, for the same reason: matching would mean re-implementing `computeShares` in SQL.
- Fix / rule: Same as the pending money-rule-exceptions proposal: a deliberate difference is listed in the spec's boundary table with both answers and the reason, both sides test it, and the user approves it. Added as evidence to that proposal.
- Source: PI-M-1; Task 5 live reconciliation; lesson 2026-11-24 "The app and DB rules for 'complete' now differ on purpose (K6)"

## 2026-11-24: The refetch lesson was used before it was a rule, but "never arrives" still has no answer  [area: expo]
- What happened: The product-engineer read the M3 log entry and built Add/Remove so that a failed refetch releases the button and shows "Couldn't refresh the bill." with "Try again" (PI-E-4). For a refetch that never answers, it chose no timeout, same as the Settle screen (PI-E-15). The pending product-engineer proposal says a refetch that never arrives must also re-enable the controls.
- Why (root cause): The proposal's "never arrives" half has no agreed mechanism (a timeout), and two screens now do the opposite.
- Fix / rule: The user picks one: keep "never arrives" in the proposal (both screens then need a timeout), or drop it and keep only the failed-refetch half. Noted in the product-engineer proposal.
- Source: PI-E-4, PI-E-15; proposal `2026-11-24-product-engineer-refetch-and-copy.md`

## 2026-11-24: Dark-mode avatar contrast is low  [area: expo]
- What happened: QA found the people avatars' contrast low in dark mode.
- Why (root cause): The `ui-ux-designer` skill already says to compute the contrast of new color pairs. It wasn't done for colors chosen per person (avatars), in dark mode.
- Fix / rule: Colors picked from a palette per person or item count as new color pairs: compute the ratio for every palette entry against its text in both schemes. First occurrence and the rule exists; log only.
- Source: QA report, docs/specs/2026-11-24-people-and-invites.md

## 2026-11-24: Root `.env` Google variables, fifth report  [area: expo]
- What happened: QA reported the `google_oauth_webclient1_*` variables in the root `.env` again. They're in `docs/before-production.md` §3, and the user hasn't moved them yet.
- Why (root cause): A user action. `qa-tester` has no rule to check what's already tracked, so it reports it as a finding each time.
- Fix / rule: QA checks `docs/before-production.md` before reporting an env or secrets warning, and reports a tracked item as one line: "still open, tracked in before-production §3". Included in the bundle-checks proposal for `qa-tester`.
- Source: QA report, docs/specs/2026-11-24-people-and-invites.md; lessons 2026-11-21, 2026-11-22 and two from 2026-11-24

## 2026-11-24: A delegated copy decision picked fewer strings over clarity, and review found it confusing  [area: process]
- What happened: Claimable discounts added a new kind of claimable row. The PM's CD-10 kept the existing "N items left to claim" copy and counted unclaimed discounts as items, noting in the spec that it was "fewer strings, but slightly imprecise". Review R1 (should-fix): when only a discount is unclaimed, the bill says "1 item left to claim" and nobody can find the item. A1 replaced it with copy that names what's left ("1 discount left to claim", "2 items and 1 discount left to claim") in the summary line, the settle blocker, the hidden-total line and the screen-reader label.
- Why (root cause): Second copy-at-the-edges lesson (after M3's "Sentence templates broke at a count of 1 and when the name was 'You'"). The spec reused strings written for the old concept and never wrote out what each one reads when only the new kind is left. Under delegation, the PM traded the end user's clarity for less code, though the user had said "don't make stuff confusing for end user".
- Fix / rule: When a spec adds a new kind of row or state that existing copy will count or name, the copy table lists every existing string that would include it and writes out what it reads with only the new kind left and with both kinds. When a delegated decision trades the end user's clarity for fewer strings or less code, pick clarity. Promoted to `product-manager`.
- Source: R1 in review of docs/specs/2026-11-24-claimable-discounts.md, CD-10 → Amendment A1; user direction (2026-11-24); lesson 2026-11-24 "Sentence templates broke…"

## 2026-11-24: Scanned text over a DB length limit failed to save with a "bill changed" error  [area: testing]
- What happened: Review R2: a scanned discount label over 100 characters saved fine as a split discount (stored in a sum). Once the host switched it to Claim, it became a bill row with a 100-character check. The save then failed with 22023, and the app showed the misleading "bill changed" error. A1 made `fromParsed` clip names and labels to 100 code points and notes to 200, counting as Postgres's `char_length` does. Round 2 found a rarer case of the same kind: a note clipped to exactly 200 can grow to 201 on save when "a,b" modifiers are added.
- Why (root cause): The task sent an existing value through a DB check it never hit before, and the limit was enforced only where people type, not where scanned text enters. The clip also ran on the input, not on the final saved value. And a DB validation error fell into the catch-all error that means "someone else edited the bill".
- Fix / rule: When a task sends a value into a column or check it didn't reach before, every way that value enters (typed form, scan import, reloaded edit) enforces the same limit, tested on the final value that's saved (after any joining or formatting) at exactly the limit and one over. A DB validation error (22023, 23514) gets its own message ("That label is too long"), never the "bill changed" one. First occurrence; log only. The 201-character note is still an open nit.
- Source: R2 and the round 2 nit in review of docs/specs/2026-11-24-claimable-discounts.md; Amendment A1

## 2026-11-24: Activity order inside one edit is random, and some edits show a banner with no Activity line  [area: rls]
- What happened: The Task 8 live smoke (60/60) found CD-T8-2: all events written by one `update_bill` call share `created_at` (`now()` is the transaction's start time), and the tie is broken by a random uuid, so their order in Activity changes from load to load. Review R5: an edit that only changes a discount's `applies_to` bumps the bill (people see the "bill updated" banner) but writes no Activity line. Both behaviors predate this task.
- Why (root cause): `bill_events` was designed with one event per call in mind. Nothing gives events from the same transaction an order, and the rule for "what shows the update banner" and the rule for "what writes an event" were written separately.
- Fix / rule: An event table that the UI lists in order needs a tiebreaker that follows insertion order (an identity column, or an ordinal per call), and a test that writes several events in one call and checks their order. Any change that triggers the update banner also writes an Activity line, or the banner doesn't show. First occurrence; log only. Neither is tracked yet: the main session should record CD-T8-2 and R5 as follow-ups.
- Source: CD-T8-2 (Task 8 live smoke); R5 in review of docs/specs/2026-11-24-claimable-discounts.md

## 2026-11-24: Parallel waves with planned cross-task breakage worked  [area: process]
- What happened: 9 tasks ran in 4 waves. Some breakage was known in advance and handed off: Task 3 made `DisplayShare.discountCents` required, which broke Task 7's fixtures and typecheck until Task 7 ran, and Task 5's `unclaimedTotalCents` gave NaN on old fixtures (one failing screen test) until Task 7 updated them. Nobody "fixed" the other task's files. Separately, other sessions editing `lib/bills.ts`, `BillSummary` and `lib/homeMarkers` caused short-lived typecheck and test failures, and the full suite flaked under load (3 failures that passed alone; one suite took 603 s). The existing rules handled both: re-run alone, report what's outside the task.
- Why (root cause): The wave plan said which task fixes which fixtures, so agents could tell expected failures from real ones.
- Fix / rule: Keep doing it. When a task changes a shared type or adds a field other tasks' fixtures use, the plan names the task that updates those fixtures, and agents in between report those failures as "expected until Task N". Log only; promote to `build-task` if a handoff is missed.
- Source: execution of docs/specs/2026-11-24-claimable-discounts.md (Tasks 3, 5, 7)

## 2026-11-24: Delegated decisions, fourth time: 18 decided without a stop; a money decision was built and flagged  [area: process]
- What happened: The user asked for discounts to be claimable "as an item or even split (small toggle button)", and said to keep building, log decisions, involve the PM for UX, "don't over engineer but also don't lose features that could be nice, don't make stuff confusing for end user". The PM decided 18 questions itself (CD-1 … CD-18), logged them, and the slice was built in 4 waves without stopping. CD-6 (a claimed discount can make someone's share negative) changes what someone owes. The PM built it and marked it "needs your look" instead of stopping, and it's still open. The one decision review overturned was CD-10 (see the copy lesson above).
- Why (root cause): Fourth occurrence. The pending delegated-decisions proposal says money questions "still go to the user as open questions", which would have stopped the build here. What actually happened (build the option that's easiest to change, raise it at the top) fit the user's "keep building" better, and the user hasn't objected.
- Fix / rule: Under "keep building", a money decision gets the option that's easiest to reverse, is built, and goes at the top of the summary as "Money: needs your look". The user's design preference also holds: a small toggle between two modes, defaulting to today's behavior, rather than picking one model. Added to the delegated-decisions proposal as a choice for the user.
- Source: user direction and corrections (2026-11-24); CD-6, CD-10 in docs/specs/2026-11-24-claimable-discounts.md; proposal `2026-11-24-delegated-decisions.md`

## 2026-11-24: Degenerate split cases again: negative shares are now reachable, and all-zero weights leave extras unclaimed  [area: money-math]
- What happened: Claiming a discount makes a negative share reachable through normal use (CD-6, E2; the settle screen shows the existing Q6 "they owe you" card). QA also found that a proportional bill whose item weights are all zero leaves the extras under Unclaimed while the bill counts as complete. That is the Q10 behavior from M3, and it was reached again from a new direction.
- Why (root cause): Third time degenerate inputs to `computeShares` came up during a build rather than in the spec's boundary table (Q10 in M3, then these two).
- Fix / rule: Same as the pending money-rule-exceptions proposal (Change 2 lists all-zero weights and negative shares). Added there as evidence. The all-zero display (shown as Unclaimed on a bill that counts as complete) goes to the user along with CD-6.
- Source: CD-6; QA edge case, docs/specs/2026-11-24-claimable-discounts.md; lesson 2026-11-24 "A seeded property test found a money case…"

## 2026-11-24: Docs went stale: line numbers moved, and an ADR missed the amendment  [area: process]
- What happened: The docs-writer found that ADR 0014's Code list cites `lib/bills.ts` line numbers that no longer match, because other sessions edited the file during the task. QA found that ADR 0017's line about CD-10 was stale after Amendment A1 (the main session fixed it).
- Why (root cause): `docs/learning/README.md` and `docs-writer` both say to link code as `file:line`, and line numbers in shared files move with every parallel edit. Amending a spec decision didn't include searching `docs/learning/` for that decision. This is the second time an amendment wasn't carried to everything that restates it (after 2026-11-24 "a fixture kept the old answer after the amendment").
- Fix / rule: Learning docs cite code as the file plus the symbol name (`lib/split.ts`, `computeShares`), not line numbers. Whoever amends a spec case greps the tests, fixtures and `docs/learning/` for its id and old wording and updates them in the same change. Proposed for `docs-writer` and `docs/learning/README.md`; the amendment half extends the pending reachability proposal's Change 3.
- Source: docs-writer report and QA doc note, docs/specs/2026-11-24-claimable-discounts.md; lesson 2026-11-24 "A 'can't happen' row was false, and a fixture kept the old answer…"

## 2026-11-24: Entry-route tests missed a third time: "opening a bill marks it seen" wasn't tested per route  [area: testing]
- What happened: Review R1 (nit): criterion 41 ("opening a bill that loads `ready` calls `mark_bill_seen` exactly once") was tested on the bill screen itself, but no test opened the bill through each way people reach it (from Home, from a link or invite resume, after joining) and checked that `mark_bill_seen` fired. A route that skipped it would leave a "New" marker that never clears.
- Why (root cause): Third occurrence of the entry-route lesson (2026-11-19 web vs native; 2026-11-24 home mounting during invite resume). The rule is now in `implementer`, `product-engineer` and `code-reviewer`, but each says "for navigation and auth flows". A side effect that must run whenever a screen opens (mark seen, a fetch, clearing a prompt) didn't read as a navigation flow, and criterion 41 didn't list the routes, so nobody was told to test them.
- Fix / rule: Any behavior tied to a screen opening counts as a flow for this rule: the spec's criterion lists every route that reaches the screen, and the tests assert the effect on each (web and native). The reviewer's check covers the same. Promoted to `product-manager`, `product-engineer`, `implementer` and `code-reviewer` (wording broadened from "navigation and auth flows").
- Source: R1 in review of docs/specs/2026-11-24-bill-markers-and-notices.md (criterion 41); lessons 2026-11-19 "Router tests must cover web and native paths" and 2026-11-24 "Flow tests missed a path again…"

## 2026-11-24: The docs handoff dropped items the spec's docs task listed (second time)  [area: process]
- What happened: The main session gave the docs-writer its own list of docs work. Three items from spec Task 7 weren't in it, so they were skipped: the new concept note `docs/learning/concepts/in-app-notices.md`, marking PI-6 "Changed" in `docs/decisions-to-review.md`, and the ADR 0016 note. The main session filled them in afterwards. Review R4 (before-production items not yet added) was the same Task 7 list, waiting for its turn. The main session reports this is the second time its docs instructions dropped spec items (the first wasn't logged separately).
- Why (root cause): The spec's docs task was paraphrased into a shorter list instead of handed over as it is, and neither the docs-writer nor the main session checked the result against the spec's docs criterion (criterion 47) before the summary.
- Fix / rule: When a spec has a docs task, the docs-writer gets the spec path and task number (plus any extra items), works through every bullet of that task, and reports each one as done or skipped with a reason. Before the summary, the main session checks the spec's docs criterion against what was written. Promoted to `build-task` and `docs-writer`.
- Source: main session report, Task 7 and criterion 47 of docs/specs/2026-11-24-bill-markers-and-notices.md; R4 in review

## 2026-11-24: A dismissal remembered on the device was keyed on the bill alone, so a re-add could stay hidden  [area: expo]
- What happened: BM-T5-2: Dismissed notice cards are remembered on the device until the server shows the bill as seen. Review R2 (nit): if the dismiss's `mark_bill_seen` failed and the person was later removed and added again, the remembered bill id kept the new add hidden. The fix keys the memory on bill id + `joinedAt`, so a new membership is a new notice.
- Why (root cause): The local "hide this" key named the object (the bill), not the event being dismissed (this membership). The state × action table idea (pending proposal) covers server states, not state kept on the device.
- Fix / rule: Local "dismissed / already shown" memory is keyed on the specific event (id plus the timestamp or version that changes when it happens again), and there's a test for the event happening a second time after a failed write. First occurrence; log only.
- Source: R2 in review and BM-T5-2, docs/specs/2026-11-24-bill-markers-and-notices.md

## 2026-11-24: Per-person state about a shared bill went in an owner-only table, and the live run proved no side channel  [area: rls]
- What happened: The PM put "has this person opened the bill" in a separate `bill_seen` table that no client role can touch directly (one `security definer` writer, one reader returning only the caller's rows), instead of a column on `bill_participants`, which co-participants can read and whose changes go out over Realtime. That would have been a read receipt. pgTAP (criterion 6) and the live reconciliation (37/37) both checked that marking seen changes no shared row and writes no event, and QA's browser run showed nothing leaking to the host.
- Why (root cause): Columns on a shared row inherit the row's readers and its broadcasts. Deciding where the data lives settled the privacy question before any grants were written.
- Fix / rule: Keep doing it. State that only one person should see about a shared thing (seen, dismissed, muted) lives in an owner-only table keyed on (thing, user), and the spec has a criterion that the write leaves shared rows and events unchanged. First occurrence; log only.
- Source: spec design (D3, criteria 6 and 11), live reconciliation and QA of docs/specs/2026-11-24-bill-markers-and-notices.md

## 2026-11-24: A "matches only lib/X.ts" grep also matched X's test file  [area: testing]
- What happened: Criterion 20 said `grep -rn "'Nothing claimed yet'" app components lib` matches only `lib/homeMarkers.ts`. The PM ran it when the file didn't exist yet. Once built, it also matched `lib/homeMarkers.test.ts`, which asserts the exact copy. Wording issue only.
- Why (root cause): Seventh grep-based check that gave the wrong answer. Tests sit next to the code in `lib/`, and copy tests assert the exact literal, so a "only in file X" grep over `lib` will always find the test as well.
- Fix / rule: A grep criterion that says where a literal may appear either lists the test file next to the source or adds `--exclude='*.test.ts' --exclude='*.test.tsx'`. Promoted (one sentence) to `product-manager`.
- Source: criterion 20 wording, docs/specs/2026-11-24-bill-markers-and-notices.md; earlier grep lessons (2026-11-19, 2026-11-21, 2026-11-22, 2026-11-24 ×3)

## 2026-11-24: Jest timeouts under load again, partly from QA's own build  [area: testing]
- What happened: QA's full Jest runs kept hitting 5 s timeouts in a different file each time, with load average 12–99 from several sessions plus QA's own export build. Every failing file passed on its own, and QA reported it as flaky under load, as the rule says.
- Why (root cause): Third occurrence (2026-11-21, 2026-11-22). The worker cap and "re-run alone" rules worked. The new part is that QA ran its build at the same time as its own test suite.
- Fix / rule: QA runs its builds (`export:web`, native exports, a dev server's first bundle) and the full Jest suite one after the other, not together. Added to the pending bundle-checks proposal for `qa-tester`. Load from other sessions isn't something one session can fix; the existing rules cover it.
- Source: QA report, docs/specs/2026-11-24-bill-markers-and-notices.md; lessons 2026-11-21 and 2026-11-22 on Jest under load

## 2026-11-24: Root `.env` Google variables, sixth report  [area: expo]
- What happened: QA reported the `google_oauth_webclient1_*` variables in the root `.env` again. They're tracked in `docs/before-production.md` §3, and the user hasn't moved them yet.
- Why (root cause): A user action. The proposal that makes QA report tracked items in one line (bundle-checks Change 5) is still pending.
- Fix / rule: No new rule. Added as evidence to `2026-11-24-bundle-checks-jest-setup-tracked-items.md`. Keep it first in the build summary.
- Source: QA report, docs/specs/2026-11-24-bill-markers-and-notices.md; five earlier reports

## 2026-11-25: A measurement slice built 15 tasks of stages before it had the answers to measure them  [area: receipt-parsing]
- What happened: The scan-pipeline slice (deep research, then spec, then 15 tasks) measured every stage with the Playwright harness on 8 real photos. For most of the slice only 1 receipt had a checked answer file (later 3). Text-height resize, strips, zoom on doubt, gray/flatten/CLAHE, Tesseract settings and retries were each built, measured and rejected on that data. Only the crop helped (tuning 36% → 73%), and it rests on 1–3 receipts. The shipping decision (S-1) waits on the user checking 3 more answer files, so the slice ends without a decision. The spec's own Risks said "four receipts can't support any decision", and A1 let work go ahead as "provisional".
- Why (root cause): Second occurrence of the 2026-11-24 lesson "The eval couldn't show the change, because the motivating receipt's read lacked the lines": evidence was assumed to be there and wasn't. The spec put ground truth (Q1) in open questions instead of making it Task 0, and nothing stopped later stages from being built while the core result was still provisional. The user checks answer files slowly and by hand, so that is the critical path; building stages doesn't shorten it.
- Fix / rule: For work judged by an eval (parser rules, scan stages, any "does this help" change), the spec's first task is the ground truth and a baseline run: the answer files the decision needs, drafted for the user, with a count of how many are checked. That is handed to the user on day one as a User check. Later stages are ordered by expected value and gated: the next optional stage starts only once the previous verdict is no longer PROVISIONAL, or the user says to build anyway knowing the result will be provisional. Promoted to `product-manager` and `build-task`.
- Source: Results log and Decision (proposed) in docs/specs/2026-11-22-web-opencv-preprocessing.md; A1; S-1 and S-6 in `docs/decisions-to-review.md`; lesson 2026-11-24 "The eval couldn't show the change…"

## 2026-11-25: ADR numbers collided again, this time across sessions  [area: process]
- What happened: The main session assigned ADRs 0015 and 0016 on 2026-11-22 (A1), as the build-task rule says. By the time the docs task wrote them (2026-11-25), other sessions' slices had taken 0015–0017, so they became 0018 and 0019 (S-D-1), and the spec carries a renumbering note.
- Why (root cause): Third ADR collision (2026-11-21 ADR 0011; now this). The build-task rule hands numbers out at the start, but that only works inside one session. A number reserved only in a spec's text isn't visible to another session that reads `docs/learning/decisions/` three days later.
- Fix / rule: A number is reserved only by putting it on disk where every session looks: create the ADR file (a stub with title and "Status: Reserved by <spec>, <date>") and its row in `decisions/README.md` at the moment the number is handed out. Specs that are written before the ADR refer to it by title ("the staged-pipeline ADR"), not by number, until it exists. Promoted to `build-task`, `docs-writer` and `product-manager`.
- Source: A1 and the 2026-11-25 Note in docs/specs/2026-11-22-web-opencv-preprocessing.md; S-D-1; lesson 2026-11-21 "Parallel agents worked from a stale snapshot"

## 2026-11-25: Two Claude sessions worked side by side, and declaring file ownership up front worked  [area: process]
- What happened: A second session built Profile/Venmo/M3 while this one built the scan pipeline. They coordinated with cross-session messages, each declaring up front which files it owned. There were no edit collisions in owned files. The collisions that did happen were in things nobody had claimed: ADR numbers (above), and the npm hooks that rebuilt `public/opencv/` (below).
- Why (root cause): Sixth occurrence of parallel work interfering. Ownership of files was declared; ownership of shared numbers and shared generated folders wasn't.
- Fix / rule: When another session is active, the main session's opening message to it lists the files it owns, the ADR numbers and migration timestamps it has reserved (on disk, per the rule above), and any generated folder its tools write (`public/opencv/`, `public/tesseract/`, `dist/`). Promoted to `build-task` with the ADR rule.
- Source: process, scan-pipeline slice; lessons 2026-11-21, 2026-11-22, 2026-11-24 on parallel work

## 2026-11-25: An npm hook wiped `public/opencv/` while the harness was reading it  [area: testing]
- What happened: Another run's `prestart`/`preweb` hook (which copies or removes `public/opencv/` based on `WEB_CV_PREPROCESS`) deleted the folder while the harness was running cv variants. A cv variant without OpenCV would quietly have measured the baseline. The fix: the harness builds a private OpenCV copy per run and refuses to write results if OpenCV didn't really run.
- Why (root cause): A shared generated folder that a lifecycle hook may delete. A measurement tool that falls back silently gives a plausible wrong number; this is the same shape as the grep lessons (a check that can't see the thing reports "fine").
- Fix / rule: A long-running tool keeps its own copy of generated assets (in the scratchpad or a run-specific folder), and any measurement checks in its output that the thing being measured actually ran (a trace entry, a positive control) before scoring. Covered by the pending receipt-eval proposal and its additions; log only.
- Source: harness runs, scan-pipeline slice

## 2026-11-25: The same rule copied instead of imported: the answer checker's tolerance and a price regex  [area: money-math]
- What happened: `answers:check` checked answer files with 0¢ tolerance while the parser uses ±1¢ (fixed in S-R-4 by calling `totalsGaps` / `checkTotals`). Separately, `zoomOnDoubt` carried a copy of the parser's price regex; the deviation wasn't logged until QA.
- Why (root cause): Third occurrence of "the same money rule in two places" (2026-11-22 ±1¢ app vs DB; 2026-11-24 K6 and PI-M-1). This time both copies were in TypeScript, in a script and a pipeline stage, where `lib/` could simply have been imported. The CLAUDE.md convention names only "`lib/` and the database", so a script or a second module didn't look covered.
- Fix / rule: A rule that already exists in `lib/` (a money tolerance, the totals check, the price pattern, the user's receipt-line rules) is imported wherever it's needed, including scripts, eval tools and other pipeline stages. Never copy it. If it can't be imported, the copy has a test that pins both to the same boundary cases, and the deviation is logged when it's made, not at QA. Promoted to `CLAUDE.md` § Conventions.
- Source: S-R-4 (review); zoomOnDoubt deviation found in QA; lessons 2026-11-22 and 2026-11-24 on app/DB money rules

## 2026-11-25: Optional stages failed the scan or threw away a good read  [area: expo]
- What happened: Three findings of one kind. Tesseract's `recognize` can stall forever, so a 30 s limit was added (the user chose 30 s over 90 s, S-4). A timeout in the retry or second pass discarded the first pass's good read instead of keeping it. `CvOpFailed` failed the whole scan instead of falling back to the uncropped path. Also, `esbuild` was imported before the OpenCV flag check, so a script needed it even when the flag was off.
- Why (root cause): Fourth occurrence of the 2026-11-21 lesson "Every async flow needs a path for cancel, failure and sign-out" (M1a, M1b+M2, M3, now). The "never settles" rule is written in `native-mobile` and `product-engineer` but not in `implementer` or `code-reviewer`, and it says nothing about stages that are optional improvements. The esbuild import is the second occurrence of "keep heavy things behind the flag or a lazy import" (2026-11-21), now in a script.
- Fix / rule: Every await on something outside our control (an OCR engine, a worker, a network fetch) has a time limit. An optional stage (crop, enhance, retry, zoom) that fails or times out falls back to the best result so far and records why in the trace; only the required read can fail the scan. A timeout on a later pass never discards an earlier pass's result. Optional heavy imports come after the flag check. Promoted to `implementer` and `code-reviewer`.
- Source: S-4, S-R-3 and the review fixes in `docs/decisions-to-review.md`; review of docs/specs/2026-11-22-web-opencv-preprocessing.md; lessons 2026-11-21 (async endings, lazy imports)

## 2026-11-25: "Verify" marks on library facts paid off; bundle markers must be counted in the real file  [area: testing]
- What happened: The spec marked OpenCV's worker start-up as "verify", and it was wrong for 4.12 (A2.1: the package declares its own `Module`, and `cv` is thenable, not a Promise). Task 6 caught it before Tasks 7–9 built on it. The spec's bundle marker `getBuildInformation` appears 0 times in `opencv.js` (the name lives inside the embedded wasm), so it was replaced with `matFromImageData|onRuntimeInitialized`, each counted once in the real file (A2.2).
- Why (root cause): The PM's "tool facts are verified or marked" rule worked. A marker chosen from the docs is a tool fact too.
- Fix / rule: Keep doing it. A string used as a marker in a bundle check is picked by counting it in the actual built file first (8th grep lesson; the existing qa-tester positive-control rule covers the check itself). Log only.
- Source: Amendment A2 in docs/specs/2026-11-22-web-opencv-preprocessing.md

## 2026-11-25: Scan pipeline findings to carry forward  [area: receipt-parsing]
- What happened: On this Mac's harness: OpenCV's resampler read worse than the canvas (Hermite) resize (mixed on tuning, worse on unchecked photos). The crop can shrink text (on `el-chalan` the crop isn't upscaled, lines 35 → 24 px, one item lost), so a crop without a text-height step can turn an OK read into a failure screen. `pickBetter` ranked a read with no total above one that found the total but was a few cents off (fixed in A5: has-total before gap size).
- Why (root cause): Assumed improvements (a "better" resampler, a crop) were not neutral, and the ranking rule was ordered by how easy each signal was to compute instead of by the user's priority (total, tip and tax matter most).
- Fix / rule: Rankings and comparisons of two reads order their signals by the user's priority: a read that has the total beats one without, before any gap or count is compared. Don't assume OpenCV's resize beats the canvas, or that a crop helps without a text-height check; measure both on native too. Log only (the native spec should read this).
- Source: Results log, Decision (proposed) and A5 in docs/specs/2026-11-22-web-opencv-preprocessing.md; S-5

## 2026-11-25: QA failed only on missing Results-log rows  [area: process]
- What happened: QA failed criteria 41 and 45 because § Results log had no E-cv0 rows and no PSM 4-after-crop row. The code was fine; the evidence for "cv resampler read worse" was only in a config comment. The rows were added afterwards ("QA-gap rows").
- Why (root cause): The spec's task loop said "append a row to § Results log", but nobody checked the log against the criteria that list its rows before QA, and agents cut off by usage limits resumed without re-checking it.
- Fix / rule: A task that runs an experiment isn't done until its Results-log row is written, with the verdict and the date. Before QA, the main session checks every "Results log has … rows" criterion against the log. Included in the receipt-eval additions proposal. First occurrence; log only beyond that.
- Source: QA criteria 41 and 45, docs/specs/2026-11-22-web-opencv-preprocessing.md

## 2026-11-25: Usage limits and a session restart stopped agents; resuming worked because results were in files  [area: process]
- What happened: Several agents were cut off by the 5-hour and weekly usage limits, and a session restart stopped two mid-task. All were resumed with SendMessage and lost no work, partly because each experiment's output was already on disk (`eval/receipts/*.ocr.json`, the Results log).
- Why (root cause): The 2026-11-22 rule (resume the same agent) held. A restart is the same case.
- Fix / rule: No new rule. For long multi-task slices, write each step's result to its file (Results log, decisions log) as it finishes, so a resumed or new agent can pick up from the files. Log only.
- Source: process, scan-pipeline slice; lesson 2026-11-22 "Agents cut off by usage limits resume cleanly…"

## 2026-11-25: User's preferences from the scan-pipeline slice  [area: receipt-parsing]
- What happened: The user (again) asked for no receipt-specific fixes, with rules that generalize and are validated on held-out receipts, and said total, tip and tax matter most while the subtotal may be blank. They asked for plain-text answer files in dollars as printed, instead of JSON in cents (A3). They allowed `2@3.5` (one decimal) only inside `(qty@unit)` notes (S-8), and said an optional service charge counts as tip. They kept "keep building and log decisions in `docs/decisions-to-review.md`" instead of stopping, and chose to check more answer files rather than ship the crop on thin evidence (S-1).
- Why (root cause): These are the user's domain rules and working style.
- Fix / rule: Anything the user fills in by hand is plain text in the units printed on the receipt (dollars), and the tool converts to cents. Parser work treats an optional service charge as tip, and accepts one decimal only inside `@` notes. Shipping decisions wait for checked answers; they aren't made on 1–3 receipts. Log only; the existing memory and pending parser proposal cover the rest.
- Source: A3, S-1, S-8 in docs/specs/2026-11-22-web-opencv-preprocessing.md and `docs/decisions-to-review.md`; user direction during the slice

## 2026-11-25: The user rejected the "import, never copy" CLAUDE.md convention  [area: process]
- What happened: The user approved five 2026-11-25 proposals and rejected `2026-11-25-one-rule-one-implementation.md` (a new `CLAUDE.md` § Conventions bullet: a rule that exists in `lib/` is imported in TypeScript, never copied). No reason was given. The 2026-11-25 money-math entry above says "Promoted to `CLAUDE.md` § Conventions"; that promotion did not happen.
- Why (root cause): Unknown; no reason given. Possibly the scope (a repo-wide convention) was broader than wanted. The narrower tool-side version did land, in the receipt-eval skill ("Use the app's rules, not copies": totals checks and tolerances in tools come from `lib/`).
- Fix / rule: Don't re-propose the same `CLAUDE.md` bullet. If "same rule copied" recurs, propose it narrowly in the agent that should have caught it (e.g. a `code-reviewer` check), and ask the user why the convention was rejected before drafting.
- Source: user decision on retro proposals, 2026-11-25

## 2026-11-25: A failed refetch left Pay / I paid disabled again, because the rule is still only a proposal  [area: expo]
- What happened: Review R1 (should-fix) of the Request buttons slice: on the bill screen's new footer (A1, design F), when the refetch after the viewer's own claim, split or extras save failed, Pay and I paid stayed disabled with no message. A2 added `saveRefreshFailed` in `lib/settleView.ts` and a "Couldn't refresh. Try again." line with Refresh. The reviewer named it a repeat of 2026-11-24 "Waiting for the refetch meant a failed refetch left the buttons stuck".
- Why (root cause): Fourth occurrence of the async-endings lesson for refetches (2026-11-21, 2026-11-22, 2026-11-24 twice). The fix rule has sat in `2026-11-24-product-engineer-refetch-and-copy.md` since 2026-11-24, waiting on the user's (a)/(b) choice about refetches that never arrive, so it's in no agent file. The PM's design F also listed the footer's states without "save worked, reload failed".
- Fix / rule: Same rule as the pending proposal. Added as evidence there, with a note that option (b) (failed refetch only) can be applied now and the timeout half decided later. A screen that waits on a refetch lists "refetch failed" as its own state in the plan and gets a test.
- Source: R1 in review of docs/specs/2026-11-25-venmo-request-buttons.md (A2); proposal `2026-11-24-product-engineer-refetch-and-copy.md`

## 2026-11-25: A "Couldn't open Venmo" line outlived the payer and amount it described  [area: expo]
- What happened: Review R2 (should-fix): after a failed open, the line "Couldn't open Venmo…" stayed on screen naming the old payer or amount after the payer or the share changed. A2 stores each line with what it described (`payOpenFailedLine`, `requestOpenFailedLine`; the request link model gained `userId`) and shows it only while that still matches.
- Why (root cause): Second occurrence of the 2026-11-24 lesson "A dismissal remembered on the device was keyed on the bill alone": local UI state (an error line, a dismissal) is remembered without the facts it was about, so it applies to a newer situation it doesn't describe. On a live bill those facts change under the screen.
- Fix / rule: A message or remembered choice about a specific thing (an error for a payment, a dismissed notice) is stored with the ids and values it describes (person, amount, membership time) and is shown only while they still match, with a test that changes one of them while it's showing. Promoted to `product-engineer` (Change 2 of the refetch proposal).
- Source: R2 in review of docs/specs/2026-11-25-venmo-request-buttons.md (A2); lesson 2026-11-24 "A dismissal remembered on the device…"

## 2026-11-25: The dev server shown to the user pointed at the hosted project, again  [area: process]
- What happened: Before showing the user a demo bill, the main session found the running web server on :8081 talked to the hosted Supabase project, while the new migrations were only local. It found this by grepping the served bundle for the Supabase URL, asked the user, and restarted the server with local values passed inline (no `.env` edits).
- Why (root cause): Second time the hosted-server mismatch came up (2026-11-24 QA found the same), and the fifth environment mismatch overall. The fix from 2026-11-24 went only into `qa-tester`, but the main session also runs the app for the user (demos, user checks), and `build-task`'s "Environment first" bullet only covers `db:status`.
- Fix / rule: Before the main session shows the user the running app or hands them a user check against it, it checks which Supabase host the served bundle uses, the way `qa-tester` does. If it isn't the one the change needs, it asks the user before restarting the server with values passed inline. Promoted to `build-task`.
- Source: main-session process during docs/specs/2026-11-25-venmo-request-buttons.md (A1 demo); lesson 2026-11-24 "Checks ran against an environment that wasn't the one assumed"

## 2026-11-25: Parallel agents edited the same files; one changed a label another task's tests assert  [area: process]
- What happened: The footer task, the designer pass and other agents edited `lib/settleView.ts`, `lib/theme.ts` and shared tests at the same time. Tests failed briefly in each other's files: `settle.test` still expected the old "Settle up" label after the footer task changed it, `uiPrimitives` Banner tests failed mid-edit, and `scanFlow` failed during the designer's work. QA also found `supabase/config.toml` changed by another session (localhost:8082 redirects).
- Why (root cause): Seventh occurrence of parallel work interfering. `build-task` says parallel tasks must "touch different files", but nobody listed each task's files before starting them. The 2026-11-24 entry "Parallel waves with planned cross-task breakage worked" said to promote the handoff rule if one was missed; this is that miss: no plan said which task updates the other's tests when the label changed.
- Fix / rule: Before starting parallel tasks, the main session lists each task's files (source and tests). Tasks that share a file run one after another. When one task changes copy, a label or a shared type that another task's tests assert, the plan names the task that updates those tests, and agents in between report the failures as "expected until Task N". A change to `supabase/config.toml` or `supabase/.env` by another session is announced, since it needs a Supabase restart. Promoted to `build-task`.
- Source: process events and QA report for docs/specs/2026-11-25-venmo-request-buttons.md; lessons 2026-11-21, 2026-11-22, 2026-11-24 ×2 and 2026-11-25 on parallel work

## 2026-11-25: An agent's report was lost twice while it still had background work  [area: process]
- What happened: The footer task's final report never reached the main session, twice. The agent had background work running when it handed back ("one report per result"). The main session confirmed what was built by grepping the files and running the tests itself.
- Why (root cause): The agent handed back (or tried to) while background commands were still going, so the result came back as a separate event that didn't carry the report. First occurrence of this kind.
- Fix / rule: Agents wait for every background command to finish before their final report, and the report lists files changed and test summary lines so it can be checked against disk. If a report goes missing, the main session resumes the same agent and asks for it again (or checks the files and tests itself, as here) before going on. Log only; promote to `build-task` and the agent files if it recurs.
- Source: main-session process during docs/specs/2026-11-25-venmo-request-buttons.md (Task 5)

## 2026-11-25: Text sent to another app: code points aren't characters, and control characters got through  [area: expo]
- What happened: Note review nits: `venmoNote` clips by code point, so it can split a ZWJ emoji (a family emoji becomes separate people) or leave a space before "…". Host-written item names go into other people's Venmo notes (accepted; tracked in `docs/before-production.md`). QA's edge case: control characters such as NUL survive the note's cleaning (only whitespace runs and lone surrogates are handled).
- Why (root cause): The cleaning rules in N2 were written for whitespace and surrogates, the cases the PM thought of. Counting in code points matches Postgres's `char_length`, but a person sees graphemes.
- Fix / rule: Text the app puts into another app's field (a payment note, a share message) drops control characters (`\p{Cc}`, keeping ZWJ), clips on grapheme boundaries (`Intl.Segmenter` where available) and trims before adding "…", with a test for each. First occurrence; log only. The open nits are worth one small follow-up.
- Source: review nits and QA edge case for docs/specs/2026-11-25-venmo-note-item-names.md

## 2026-11-25: A demo bill on the real screen changed the user's "don't build it"  [area: process]
- What happened: The user first said "no dont build it" about Request buttons. After the main session seeded a demo bill in the local DB (through the real `create_bill`, `join_bill` and `set_claim` functions, as each user via `request.jwt.claims`) and the user looked at Settle up, they asked for a per-row Request button and for people who owe to pay straight from the bill screen's footer (A1). The main session also set the user's local `venmo_username` for the demo.
- Why (root cause): The question was abstract until the user saw it on their own screen with realistic data. Their worry was clutter and complexity, which they could only judge by looking.
- Fix / rule: When the user is unsure about adding UI, offer a seeded demo on the local stack first (seed through the real functions, never by inserting rows past them), and tell the user about any change to their own local data (like their Venmo username). First time this was done by hand; if it happens again, make it a skill (or a section of `live-db-smoke`).
- Source: user decisions (2026-11-25), Amendment A1 of docs/specs/2026-11-25-venmo-request-buttons.md

## 2026-11-25: User's choices for Venmo notes and requests  [area: expo]
- What happened: The user asked for "SplitIt + the items name in the note", with rules U1–U5: shared items in, discounts out, at most 2 names then "+ N more", as many whole names as fit, and one long name truncated. They confirmed on iPhone that the pay link and the `txn=charge` request link open the right Venmo screens. They asked whether one link can "request all": no, a Venmo link carries one amount, so it's one Request per person. After the demo they chose per-row Request on Settle and a direct Pay in the bill footer, and they asked to keep it uncluttered.
- Why (root cause): These are the user's product rules and the limits of Venmo's links.
- Fix / rule: Venmo notes list only the person's own items, by U1–U5, through `venmoNote` and `claimedItemNames`. Requests are one link per person. New payment UI sits on existing rows and footers (no new screen), with one handle line and a Details link. Log only; the spec and ADR 0007's note hold the details.
- Source: user decisions U1–U5 in docs/specs/2026-11-25-venmo-note-item-names.md; A1 of docs/specs/2026-11-25-venmo-request-buttons.md

## 2026-11-25: A layout change remounted SharePanel and threw away what the host had typed  [area: expo]
- What happened: Review 2 (should-fix) of the visual pass. P8 shows the invite block above the items while the host is alone and below them once someone joins. It was built as two JSX slots, so when the first person joined, React unmounted `SharePanel` in one slot and mounted a new one in the other, and any in-progress state (a half-typed invite, an open contact picker result) was lost. Fixed by rendering the sections as one keyed array whose order changes, so `SharePanel` keeps its identity.
- Why (root cause): A "visual only" change (where a block sits) changed behavior, because in React a component's identity is its position in the tree. Moving a stateful component between two conditional slots is a remount, not a move. The visual-designer's "visual only" rule doesn't mention it, and nothing tested the transition with state in the panel.
- Fix / rule: When a component that holds state moves position depending on data, render it in one place with a stable `key` (a keyed array, or one slot with the order changed around it), and test the move with state in it: enter something, trigger the change (someone joins), check it's still there. First occurrence; proposed for `visual-designer` with the other "visual change, behavior effect" findings below.
- Source: review 2 should-fix (P8, SharePanel) of docs/specs/2026-11-25-visual-pass.md

## 2026-11-25: Restyles dropped heading roles, twice in one pass  [area: expo]
- What happened: Review 1 (nit) found a screen title with no heading role after V1–V4. Review 2 (should-fix) found "Split a bill" had lost its `accessibilityRole="header"` when it was moved onto the new primitives. Screen-reader users navigate by headings, so the screen lost its landmark with no visible change.
- Why (root cause): Swapping a `Text` for a primitive (`SectionHeader`, a native header title, a new `Text` style) carries the look but not the semantics, unless someone copies them over. The visual-designer rule says "never change accessibility semantics", but gives no step to check them, and sighted review of a restyle can't see roles. Same family as 2026-11-22 "A row's screen-reader label hid its price and status": accessibility lost while the screen looks right.
- Fix / rule: Before and after restyling an element, compare its `accessibilityRole`, label, hint and state. A heading that becomes a primitive keeps `accessibilityRole="header"` (or the primitive sets it), and a screen whose title moves into the native header still has exactly one heading. Second occurrence in this pass; promoted to `visual-designer`.
- Source: review 1 nit and review 2 should-fix of docs/specs/2026-11-25-visual-pass.md; lesson 2026-11-22 "A row's screen-reader label hid its price and status"

## 2026-11-25: Native headers and sheets added ways to leave that skip the "discard?" check  [area: expo]
- What happened: Two cases in one pass. (1) The new-bill form's "Discard this bill?" check (VP-M1) runs only for the visible Back control; the iOS back-swipe, the Android back button and browser back leave without asking (raised to the user as P13). (2) Round 3 of review 2: P6 made the item sheet an iOS page sheet, whose swipe-down could close it and discard an unsaved split. Fixed with `allowSwipeDismissal={!editing}`.
- Why (root cause): P1 (native headers) and P6 (native sheets) were approved as visual changes, but each brings system exit paths that a hand-built header or `Modal` didn't have (or had elsewhere). The guard was written for the button the designer drew, not for every way the screen can close. Same shape as 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out": list how it ends.
- Fix / rule: A screen or sheet that holds unsaved input lists every way it can close (its button, iOS back-swipe or swipe-down, Android back, browser back, tapping the scrim) and, for each, either keeps the guard or records why not, with a test where the platform allows one. Changing a screen to a native header or sheet counts as adding exit paths. Twice in this pass; promoted to `product-engineer`, `visual-designer` and `code-reviewer`.
- Source: VP-M1 and P13 in docs/specs/2026-11-25-visual-pass.md; round 3 of review 2 (`allowSwipeDismissal`); lesson 2026-11-21 "Every async flow needs a path for cancel, failure and sign-out"

## 2026-11-25: A "no glyphs" test passed because the part it checked was collapsed  [area: testing]
- What happened: Review 2 found ▴/▾ glyphs still on screen after P3 (icons instead of glyphs). The test that should have caught them asserted the glyphs were absent, but it ran with the shares summary collapsed, so the text it searched for was never rendered and the assertion passed vacuously.
- Why (root cause): Ninth check in the log that reported "absent" because it couldn't see the thing (grep on untracked files, grep matching its own guard, "matches nothing today", bundle markers, the OpenCV harness). The positive-control rule is in `qa-tester` for greps, but not in the agents that write unit tests, and code review's "tests that don't actually assert the behavior" didn't name this shape.
- Fix / rule: A test that asserts something is absent (`queryBy…` is null, `not.toHaveTextContent`) first asserts, in the same render and state, that the region it searches is there (a sibling label, the expanded section's heading). For "no X anywhere" checks, run them in every state that shows the region (collapsed and expanded). Promoted to `implementer`, `visual-designer` and `code-reviewer`.
- Source: review 2 should-fix (▴/▾) of docs/specs/2026-11-25-visual-pass.md; grep lessons 2026-11-19, 2026-11-21, 2026-11-22, 2026-11-24 ×2, 2026-11-25 ×2

## 2026-11-25: The designer ran Prettier over a whole untracked file, with no way to restore it  [area: process]
- What happened: The visual-designer ran Prettier over all of `app/(app)/profile.tsx`. The repo has no Prettier config, so it used Prettier's defaults and reformatted the whole file, not just the lines the task changed. The file is untracked (the repo has two commits and most work is uncommitted), so there was no git copy to restore or to diff against.
- Why (root cause): Nothing tells agents that the project has no formatter, so running one looked like tidying. On an untracked file a whole-file rewrite is irreversible and hides the real change from review. Same family as 2026-11-19 "Agents don't ... break code on disk".
- Fix / rule: The project has no formatter config: don't run Prettier, `eslint --fix` or codemods over files. Edit only the lines the task changes, in the file's existing style. If a bulk rewrite is ever needed, copy the file to the scratchpad first and say so in the report. First occurrence, but the damage can't be undone; proposed for `visual-designer` and `implementer`. Separately, a lot of finished work is uncommitted and untracked, so any tool slip has no restore point; whether to commit more often is the user's call.
- Source: process event during docs/specs/2026-11-25-visual-pass.md; lesson 2026-11-19 "Agents don't write .env or break code on disk"

## 2026-11-25: On web, the focus ring showed on mouse clicks and taps  [area: expo]
- What happened: Review 1 (should-fix): the new focus ring appeared when a button was clicked or tapped on web, not only on keyboard focus. In react-native-web, `Pressable`'s `onFocus` fires for every focus, whatever caused it. `useFocusRing` now shows the ring only when the browser says the focus is keyboard-visible (`isFocusVisible`).
- Why (root cause): A platform fact the primitive's author assumed (onFocus means keyboard focus) without checking.
- Fix / rule: Keyboard-only affordances on web check `:focus-visible` (through `components/ui/useFocusRing.ts`); new tappable primitives use that hook instead of their own `onFocus` state. First occurrence; log only.
- Source: review 1 should-fix of docs/specs/2026-11-25-scan-screen-redesign.md / visual pass V1–V4

## 2026-11-25: Design research: one skill vetted and installed, two declined; more design skills appeared unvetted  [area: process]
- What happened: The user asked for "a good app design ui/ux skill and framework", then "cleanest nicest look… we don't want tamagui (heavier)". No framework was adopted (`lib/theme.ts` + `components/ui/` already cover it). Expo's `expo-design-system` skill (MIT) was read in full and installed with a `SOURCE.md` (origin, commit, license, local precedence). `expo-native-ui` was declined because it tells agents to run `npx @expo/agent-cli@latest` from the internet and conflicts with our theme; `ui-ux-pro-max` was declined because it runs Python and exists in many forks. Later in the session more design skills showed up in `.claude/skills/` (`impeccable`, `apple-design`, `emil-design-eng`, `break-ui`, `animate-expo` and others) with no `SOURCE.md`; we didn't install them, `impeccable` ships executable scripts, and the user hasn't said whether to use them. QA used the installed skill's audit greps as a measure (hex outside brand 3 → 0, raw `fontSize` 9 → 1, glyph icons ~33 → 0, raw radius 0), which worked well.
- Why (root cause): There's no written rule for bringing in third-party skills, so the vetting was done by judgment. Skill files are instructions every agent may follow, so an unvetted one is like an unreviewed dependency.
- Fix / rule: A third-party skill is read in full before it's added; it isn't added if it runs downloaded or remote code (`npx …@latest`, scripts) or brings a second styling system; its origin, commit and license go in `SOURCE.md`; skills in `.claude/skills/` without a `SOURCE.md` and the user's OK aren't used. Audit greps with before/after counts are a good QA measure for visual work; keep using them. Proposed for `CLAUDE.md` § How we work (first occurrence; it's a safety gap).
- Source: user requests and research during docs/specs/2026-11-25-visual-pass.md; `.claude/skills/expo-design-system/SOURCE.md`; QA report

## 2026-11-25: A new agent type needed the general-purpose workaround a third time  [area: process]
- What happened: The user asked for a `visual-designer` agent ("v artistic… not over the top"). It was created mid-session, so it couldn't be spawned by name; the first audit ran as a general-purpose agent told to read and follow `.claude/agents/visual-designer.md`. It worked, as it did in M1a and M1b+M2.
- Why (root cause): Agent definitions load at session start (2026-11-21, 2026-11-22). The workaround lives only in the log.
- Fix / rule: Same rule, now written into `build-task`: when an agent file was created or changed in this session, spawn a general-purpose agent whose prompt says to read and follow that file, including its tool limits, and say so in the report. Third occurrence; promoted to `build-task`.
- Source: process, visual pass; lessons 2026-11-21 "Agent types created mid-session aren't spawnable…" and 2026-11-22 "…new agent types appear after a session branch"

## 2026-11-25: A new dependency needed a dev server restart; the agent rightly left it  [area: process]
- What happened: The scan redesign added `lucide-react-native`. The running web server didn't pick it up until it was restarted. The scan agent didn't restart it, because the server wasn't its own (its rule says not to), and reported it, so the restart was done outside the agent.
- Why (root cause): Metro resolves new packages at start. The rule against touching someone else's server held, and the report carried the need.
- Fix / rule: A task that adds a package says "dev server needs a restart" in its report, and the main session restarts it (with the same inline values, after checking the served backend) before any user check. Log only; the existing rules worked.
- Source: process, docs/specs/2026-11-25-scan-screen-redesign.md

## 2026-11-25: Two sessions shared files; sequencing by message worked  [area: process]
- What happened: The settle-early session (splitit-app-92) worked in files the visual pass also needed (bill screen, `lib/settleView.ts`, settle tests). The sessions sequenced by message ("after the bill-footer merges"), the visual pass's plan named which tasks waited on which merge, the other session applied six of our review fixes in files it owned, and it correctly updated our `claimable_discounts` pgTAP test when its change needed it.
- Why (root cause): The ownership-and-sequencing rules from 2026-11-25 were followed, and the plan wrote the waits into its task table.
- Fix / rule: Keep doing it: each task in a plan says what it waits for, and a finding in a file another session owns goes to that session with its id. Evidence for the pending `2026-11-25-build-task-shared-files-and-served-backend.md`. Log only.
- Source: § 5 task table and progress notes in docs/specs/2026-11-25-visual-pass.md (the "Last:" note lists the review fixes handed to splitit-app-92)

## 2026-11-25: Delegated decisions, fifth time: a decision listed two options and missed a third  [area: process]
- What happened: The main session decided VP-M1 (confirm before discarding the new-bill form), VP-M2 (which button is primary under P10) and VP-M3 without stopping, and raised P13 (system back paths) to the user. Review R11 noted that VP-M3 weighed only two options and left out a third: intercepting only Android's `BackHandler`, which keeps the iOS swipe and doesn't fight the browser.
- Why (root cause): Fifth occurrence of delegated decisions. Platform-split options (native only, Android only, web only) are easy to miss when a choice is framed as "intercept or not".
- Fix / rule: When a decision is about platform behavior, the alternatives column includes the per-platform options. Added as evidence to `2026-11-24-delegated-decisions.md`.
- Source: VP-M1…VP-M3, P13 and R11 in docs/specs/2026-11-25-visual-pass.md and `docs/decisions-to-review.md`

## 2026-11-25: User's choices for the look of the app  [area: expo]
- What happened: The user asked for the scan page to look good with its two options centered, then for "the cleanest nicest look", no heavy framework ("we don't want tamagui"), a designer who is "v artistic… not over the top", and the pass on every page. They approved P1–P10 (native headers, back on Scan and the new-bill form, icons instead of glyphs, Profile as an icon, Google's button branding, a native item sheet, teal splash, invite block first while the host is alone, failure state as choice cards, one primary on Settle). They rejected P11 ("Edit items" stays under the total) and P12 (the Discounts card stays visible, even though the opt-in rule pointed the other way).
- Why (root cause): The user's taste: native and light, calm, consistent; they keep things where people already find them.
- Fix / rule: Styling stays in `lib/theme.ts` + `components/ui/`, icons are `lucide-react-native`, and no UI framework is added. Changes that move a control or change what's visible by default go to the user as proposals, as P11 and P12 did; the opt-in rule doesn't override a placement the user has chosen to keep. User checks still open: light/dark look, the iPhone sheet, VoiceOver, the splash on a build. Log only (the `ui-ux-designer` proposal updates the stale icon and glyph lines).
- Source: user requests and decisions on P1–P12, docs/specs/2026-11-25-visual-pass.md and docs/specs/2026-11-25-scan-screen-redesign.md

## 2026-11-25: Plans, UX, visual and eng design before code: the staff-engineer review found 7 must-fixes  [area: process]
- What happened: The user asked for "plans, then UX/UI design, then eng design" before any code and reviewed them on a published review page. The order was: PM spec, then the PM's UX brief (`-ux`), then the visual-designer (`-visual`), then a staff-engineer review by a Plan agent (`-eng`). The review found 7 must-fixes (F1–F7). F1: Home's batch read could be silently cut off at PostgREST `max_rows = 1000`. F2: a $0 mark couldn't be undone, and rule L3 then stopped that person from leaving. F3: the "Did you pay?" prompt was dropped whenever the amount changed. F4/F5: the spec contradicted itself. F6/F7: breakage and task dependencies were missing from the plan. The PM folded them into Amendment A1, together with the visual pass's glyph rule and the ownership gate.
- Why (root cause): Second time a whole-plan engineering read before code paid off (after M3, 2026-11-24). None of the four kinds it caught (server row caps, degenerate $0 values, internal contradictions, missing dependencies) is on the PM's checklist. A read across all the design docs together is where they show up.
- Fix / rule: For slices with screens on top of new DB functions, run the staff-engineer review last, over the spec plus any UX and visual docs, and before any code. Its checklist adds server-side limits (row caps, size limits), degenerate values ($0, empty, one person), whether the spec agrees with itself, and the planned-breakage and dependency lists. Second occurrence; the pending `2026-11-24-staff-engineer-review.md` is extended and no longer marked optional.
- Source: docs/specs/2026-11-25-settle-early-and-differences-eng.md (F1–F7); Amendment A1; lesson 2026-11-24 "A staff-engineer review before the screen tasks simplified the plan"

## 2026-11-25: A pending rule would have caused F3: the prompt was keyed on the amount  [area: expo]
- What happened: `openedStillMatches` in `lib/settleView.ts` kept the "Did you pay?" prompt only while the payer and the **amount** matched. That follows the wording of the pending refetch proposal's Change 2 ("stored with the ids and values it describes (person, amount…)"). When the share changed, which early mode makes common, a person who had already paid in Venmo lost the prompt and was offered a button that records the new amount. The fix (F3) keeps the prompt while the payer and the mark match. Review R5 found the same prompt was lost when the bill turned early (decided as SE-R-5).
- Why (root cause): "Match every value it mentions" is too strict. A message should be keyed on the facts that decide whether it's still **true**. The amount on a "did you pay?" prompt is a detail; the payer and whether the person is already marked are what make it true.
- Fix / rule: Key a remembered message or prompt on the facts that decide whether it's still true, not on every value it shows. Test that it goes away when one of those facts changes **and** that it stays when an incidental value (the amount) changes. This is a rule that caused a wrong result, so Change 2 of `2026-11-24-product-engineer-refetch-and-copy.md` is reworded.
- Source: F3 in docs/specs/2026-11-25-settle-early-and-differences-eng.md; R5 and SE-R-5 in review; lesson 2026-11-25 "A 'Couldn't open Venmo' line outlived the payer and amount it described"

## 2026-11-25: A $0 mark was a trap: no Undo, and it blocked leaving  [area: money-math]
- What happened: F2: a "paid" mark at $0 (someone whose share is $0, or who was paid back) had no Undo on any screen. Rule L3 counts any mark, so that person could never leave or be removed, and the mark reached states nobody had designed ("You paid Hana / $0.00"). SE-ENG-2 (option A, chosen by the user) hides the "Your 'I paid' was undone" notice when the viewer's new share is $0 or less.
- Why (root cause): Fourth time a degenerate money value came up after the spec was written (Q10, CD-6, all-zero weights, now a $0 share with a mark). The PM's boundary list doesn't name "a person whose share is $0" or ask what every rule (leave, remove, undo, notices) does for them.
- Fix / rule: A spec that adds a rule about marks, leaving or notices checks it against a person whose share is $0 and one whose share is negative. Added to Change 2 of the pending `2026-11-24-money-rule-exceptions-and-degenerate-cases.md`.
- Source: F2 and SE-ENG-2 / A1.2 in docs/specs/2026-11-25-settle-early-and-differences*.md; lesson 2026-11-24 "Degenerate split cases again…"

## 2026-11-25: PostgREST `max_rows` cuts results off without an error, and the first guard assumed its value  [area: rls]
- What happened: F1: Home's batch read of other bills' state could be silently cut at `max_rows = 1000` (`supabase/config.toml`). The planned guard treated exactly 1000 rows as a failure. Review R7 found that guard assumed `max_rows` is at least 1000; a hosted project can set it lower. The fix uses an exact-count check (`count: 'exact'`) and compares it with the rows received.
- Why (root cause): A server-side limit that truncates instead of failing looks like success. The guard copied the limit's value instead of asking the server how many rows there were.
- Fix / rule: Any read that can return many rows either pages or asks for the exact count and fails closed when fewer rows arrive than the count. Don't hard-code `max_rows`. First occurrence; log only, and it's on the staff-engineer checklist.
- Source: F1 (eng doc) and R7 in review of docs/specs/2026-11-25-settle-early-and-differences.md

## 2026-11-25: pgTAP "settled_at unchanged" checks couldn't fail, because `now()` is fixed in a transaction  [area: testing]
- What happened: Review R1 (should-fix): pgTAP asserted `settled_at` was unchanged after a call that shouldn't touch it. Inside the test's single transaction, `now()` returns the same value every time, so a call that wrongly rewrote `settled_at` would also have passed. The fix backdates `settled_at` first, and a mutation run (the function changed to rewrite it) showed the test now fails.
- Why (root cause): Tenth check in the log that couldn't fail. The second `now()`-is-the-transaction-start finding (2026-11-24 "Activity order inside one edit is random…"). The pending absence-assertions proposal covers unit tests, not pgTAP.
- Fix / rule: In pgTAP, an "unchanged" check on a timestamp first sets the value to a known past time (or uses `clock_timestamp()` in the fixture), so a rewrite would differ. A new "unchanged" or "absent" check is shown to fail once against a deliberately broken version before it's trusted. Added as Change 5 (`supabase-engineer`) to `2026-11-25-absence-assertions-need-presence.md`.
- Source: R1 in review of docs/specs/2026-11-25-settle-early-and-differences.md; lessons 2026-11-24 "Activity order inside one edit…" and 2026-11-25 "A 'no glyphs' test passed…"

## 2026-11-25: Parts of one screen worked out the same status separately and disagreed  [area: expo]
- What happened: Five findings of one kind. F5: the payer card said "Nobody owes you anything" while pay-backs were owed. Review R2: the payer card and the footer disagreed. R3: the footer's icon was chosen by matching the copy text. R4: a stale pill stayed on a bill that was no longer a candidate. QA F-1: the non-payer's Everyone aside says "All paid" while differences are still open (a spec gap, being fixed).
- Why (root cause): The card, the footer, the aside and the Home pill each derived "settled / owes / owed" in their own code, and the spec described them in separate tables. Second occurrence of 2026-11-21 "Money math was duplicated in a component", now for status instead of amounts. Choosing an icon by matching copy breaks when the words change.
- Fix / rule: One `lib/` function per screen (the view model) gives every part of the screen its status, and the parts render from it. Icons and tones come from the status kind, never from the copy. A test sets up each status and checks that every part showing it agrees. New narrow proposal `2026-11-25-one-status-source-per-screen.md` for `product-engineer` and `code-reviewer`. It is scoped to screens, not the rejected repo-wide `CLAUDE.md` bullet.
- Source: F5 (eng doc), R2–R4 in review, QA F-1, docs/specs/2026-11-25-settle-early-and-differences.md; lesson 2026-11-21 "Money math was duplicated in a component"

## 2026-11-25: The same rule again, in SQL: `private.settle_state` restates `bill_is_complete`  [area: money-math]
- What happened: The docs-writer flagged that `private.settle_state` repeats the rule in `private.bill_is_complete` instead of calling it (it was written as one SQL statement for a consistent snapshot, A1.11).
- Why (root cause): Fourth "same rule in two places" (2026-11-22, 2026-11-24, 2026-11-25 TypeScript, now SQL). It had a reason (one statement under READ COMMITTED), but no test pins the two to the same cases.
- Fix / rule: Per the 2026-11-25 rejection entry, don't re-propose the convention. Ask the user why `one-rule-one-implementation` was rejected before drafting a narrow version (e.g. "a second copy gets a test that pins both to the same cases"). Meanwhile, a pgTAP test that runs both functions over the E1–E20 bills and expects the same "complete" answer would close this one.
- Source: docs-writer report, docs/specs/2026-11-25-settle-early-and-differences.md (A1.11); lesson 2026-11-25 "The user rejected the 'import, never copy' CLAUDE.md convention"

## 2026-11-25: Stale-token checks: the order of checks decides the error, and a value isn't a version  [area: rls]
- What happened: Live run 10a (8/8) found that a stale `p_expected_cents` in the opposite direction gets `not_allowed` rather than `mark_changed`, because a permission check that reads current state runs before the token check. This was relayed to T6 so the screen handles both. Review R8: the token is a value, not a version, so A→B→A passes as current (ABA). This is logged in `docs/before-production.md`.
- Why (root cause): The spec listed the error codes but not the order of the checks. With state-dependent permission checks, that order decides what a stale client sees. A value token is cheaper than a version column, at the cost of ABA.
- Fix / rule: When a function takes an expected-state token, the spec gives the order of its checks and the expected error for a stale token in each direction, and the screen maps every one to "this changed, reload". First occurrence; log only. The live multi-user run caught it, so keep doing those runs.
- Source: live 10a; R8 in review of docs/specs/2026-11-25-settle-early-and-differences.md

## 2026-11-25: Review nits on tests: a hand-built state, and a user-chosen option with no router test  [area: testing]
- What happened: Review R6: the tests built the "opened" state by hand rather than through the code that produces it. R9: the user's choice for SE-ENG-2 (option A) had no router test.
- Why (root cause): A hand-built fixture can drift from what the code really produces. A user decision added late (after A1) didn't get a criterion with a test.
- Fix / rule: Build test states through the same function the app uses. Every user decision recorded in a spec gets a criterion and a test. First occurrence; log only.
- Source: R6, R9 in review of docs/specs/2026-11-25-settle-early-and-differences.md

## 2026-11-25: The docs handoff lacked the source material, third time  [area: process]
- What happened: The docs-writer (which chose new ADR 0021) couldn't document review R1 and R6, because the main session gave it R ids with no text. This is the third time a docs handoff lacked its source material (after 2026-11-24 and the bill-markers task).
- Why (root cause): The pending fix (hand over the spec's docs task whole) covers the spec but not the review findings and QA report, which the docs often need to explain.
- Fix / rule: The docs handoff includes the paths or full text of the review findings, QA report and decisions it should cover, not only their ids. Third occurrence; extends Change 3 of `2026-11-24-docs-cite-symbols-not-lines.md`.
- Source: docs-writer report, docs/specs/2026-11-25-settle-early-and-differences.md; lesson 2026-11-24 "The docs handoff dropped items… (second time)"

## 2026-11-25: Another session committed everything onto a new branch mid-task  [area: process]
- What happened: The two sessions agreed a file-ownership gate and started with the non-overlapping DB and lib tasks. We folded in six of splitit-app-52's review fixes (R1, R2, R3, R7, R8, R10), and its designer folded in our Button-wrap and Avatar-ring fixes. That worked. Mid-task, though, another session's scan agent committed all work (ours included) onto a new branch `feat/qr-invite-settle-visual-pass` at the user's request, so HEAD moved off `main` under this task. QA F-2 also fell between sessions: dev warnings from `Icon.tsx` (owned by the other session) make the LogBox toast cover the footer. We told the other session.
- Why (root cause): The ownership gate covers files, not git state. A commit or branch switch affects every session's working tree, and nobody announced it beforehand.
- Fix / rule: A session that commits, switches branch or stashes while another session is active tells the other session first. The main session checks `git branch --show-current` and `git status` at the start of a task and again before its summary, and reports any change. Extends `2026-11-25-build-task-shared-files-and-served-backend.md` (Change 3). Dev warnings that show a LogBox toast count as findings, since the toast covers UI in QA and on device.
- Source: process and QA F-2, docs/specs/2026-11-25-settle-early-and-differences.md; lessons 2026-11-25 on two sessions

## 2026-11-25: Root `.env` Google variables, seventh report  [area: expo]
- What happened: QA again reported the `google_oauth_webclient1_*` variables in the root `.env`. They're tracked in `docs/before-production.md` §3.
- Why (root cause): A user action, still not done. The one-line-report proposal is still pending.
- Fix / rule: No new rule. Added as evidence to `2026-11-24-bundle-checks-jest-setup-tracked-items.md`.
- Source: QA report, docs/specs/2026-11-25-settle-early-and-differences.md; six earlier reports

## 2026-11-25: User's choices from settle early and pay the difference  [area: process]
- What happened: The user asked for a plan, then the UX/UI design, then the eng design, all before any code, and reviewed them on a published page. They answered Q-GLYPH (no check icon on Home pills; the words carry it) and SE-ENG-2 (option A: hide the "undone" notice when the viewer's new share is $0 or less). User checks still open: Venmo on a phone, Google sign-in, VoiceOver, Dynamic Type.
- Why (root cause): The user's working style for bigger slices: see the whole design before code.
- Fix / rule: For slices of this size, offer the staged design docs (spec, UX, visual, eng) with a review page before building. Log only; the staff-engineer proposal carries the order.
- Source: user decisions, docs/specs/2026-11-25-settle-early-and-differences.md (A1.2, Q-GLYPH)

## 2026-11-26: Absence check without a positive control, eleventh time, and assertions that ran before the data landed  [area: testing]
- What happened: Review R1 (should-fix), criterion 38 in `__tests__/homeLayout.test.tsx`: the test asserted "Your share" was absent for a bill with an `early` plan, but a row with no plan at all already shows "Total", so the check passed before the early plan had loaded. It had no positive control. R3 (nit): another assertion ran before the refresh's list had landed. Both were fixed in one pass.
- Why (root cause): Eleventh "check that couldn't fail" in the log. The rule for this has sat in the pending `2026-11-25-absence-assertions-need-presence.md` since 2026-11-25, so no agent file has it; the reviewer caught it again by hand. This case adds a timing side the proposal doesn't name: the region was rendered, but from the data before the change, so "same render and state" wasn't enough. The thing to wait for is the new data, not the region.
- Fix / rule: An absence check (and any assertion about async data) first waits for a positive marker that the data it depends on has landed (a value only the new plan or refreshed list produces), then asserts. Added as Change 6 to the pending absence proposal, with a note that it is the most repeated unapplied lesson in the log.
- Source: R1 and R3 in review of docs/specs/2026-11-26-home-mobile-refresh.md; lessons 2026-11-25 "A 'no glyphs' test passed…" and "pgTAP 'settled_at unchanged' checks couldn't fail…"

## 2026-11-26: Guard tests that couldn't fail on React 19, and a state tested only through another state's path  [area: testing]
- What happened: Review R2 (nit): an "answer after unmount sets no state" test couldn't fail. React 19 no longer warns about setting state after unmount, and the focus cleanup already bumps `latest`, so the guard under test was never the thing stopping it. It was replaced by tests that hold a read open while Profile is open and answer it afterwards; these were shown to fail with the guards removed. R4 (nit): D6's "a pending read keeps the previous counts" was tested only through the failure path, so the pending state itself had no test.
- Why (root cause): The test was written against an old React behaviour (the warning) and against one guard when two guards cover the same path. Nobody ran it once with the guard removed. Twelfth check-that-can't-fail; the second where the fix was proven by breaking the code on purpose (after the pgTAP `settled_at` fix, 2026-11-25).
- Fix / rule: A test for a guard (stale response, after unmount, after leaving the screen) holds the request open with a deferred promise, triggers the situation, then resolves it and checks what's on screen. It's run once with the guard removed to show it fails, and the report says so. Each state the spec lists (pending, failed, done) gets its own test; one state's test doesn't stand in for another's. Added as Change 7 to the absence proposal (implementer, product-engineer, code-reviewer).
- Source: R2 and R4 in review of docs/specs/2026-11-26-home-mobile-refresh.md; lesson 2026-11-25 "pgTAP 'settled_at unchanged' checks couldn't fail…"

## 2026-11-26: CLAUDE.md's leak-check note lists one expected `cdn.jsdelivr.net` match, but the build has two files with it  [area: testing]
- What happened: QA found `cdn.jsdelivr.net` in `dist/tesseract/worker.min.js` as well as in the lazy `webOcrEngine-*` chunk. Checked in `dist/`: one line in each file. The worker's line holds Tesseract's default core and language-data URLs, which we don't use because `lib/webOcrEngine.ts` passes self-hosted `workerPath`, `corePath` and `langPath`. CLAUDE.md names only the chunk, so each QA run has to decide whether the second match is a leak.
- Why (root cause): The note was written before `export:web` copied the Tesseract assets into `dist/` (the `preexport:web` hook). The build changed; the note didn't.
- Fix / rule: The expected-match note names both files and says any other match is a finding. Proposed for `CLAUDE.md` § Commands.
- Source: QA report, docs/specs/2026-11-26-home-mobile-refresh.md

## 2026-11-26: The live re-run printed the local stack's keys into the QA log  [area: testing]
- What happened: QA's live re-run (15/15) printed the local Supabase stack's demo keys into its log. They're local-only keys, but `live-db-smoke` says "Never print a key".
- Why (root cause): Likely the skill's own step 1 and the build-task "Environment first" step both run `npm run db:status`, which prints the URL and every key, and QA's report format asks for "the command and its relevant output". The rule says not to print keys, but the steps tell the agent to run a command that does. (Verify with QA's log which command printed them.)
- Fix / rule: Check the stack with a command that prints names only (`npx supabase status -o env | sed 's/=.*//'`, or check its exit code), and never paste key values into a report, even local ones. Proposed for `live-db-smoke` and `qa-tester` (a rule's own steps broke it).
- Source: QA report, docs/specs/2026-11-26-home-mobile-refresh.md; `.claude/skills/live-db-smoke/SKILL.md` step 1

## 2026-11-26: Root `.env` Google variables, eighth report  [area: expo]
- What happened: QA again reported the Google OAuth variables in the root `.env`, open as a user action since M1a and tracked in `docs/before-production.md` §3.
- Why (root cause): A user action, still not done; the one-line-report change is still pending.
- Fix / rule: No new rule. Added as evidence to `2026-11-24-bundle-checks-jest-setup-tracked-items.md` (Change 5).
- Source: QA report, docs/specs/2026-11-26-home-mobile-refresh.md; seven earlier reports

## 2026-11-26: Five sessions shared the repo; one Jest run at a time and builds in scratchpad copies worked  [area: process]
- What happened: Four other Claude sessions worked in the repo during this task. Coordination by message worked: file ownership was claimed up front, only one full Jest run ran at a time across all sessions, builds ran in scratchpad copies of the repo so the shared `dist/` and `public/tesseract/` weren't touched, and the AppBanner safe-area risk was handed to the session that owns `components/AppBanner.tsx`. No collisions were reported.
- Why (root cause): The ownership rules from 2026-11-25 held. The two new practices answer earlier lessons: Jest timeouts under load (2026-11-21, 2026-11-22, 2026-11-24 ×2) and a hook wiping a shared generated folder mid-run (2026-11-25 `public/opencv/`).
- Fix / rule: When other sessions are active, announce a full Jest run and wait for any other one to finish, and run builds or asset-copy hooks in a scratchpad copy of the repo. A risk found in a file another session owns goes to that session. Added as Change 4 to `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: process notes, docs/specs/2026-11-26-home-mobile-refresh.md; lessons 2026-11-22 "Parallel Jest runs overloaded the machine…", 2026-11-25 "An npm hook wiped `public/opencv/`…"

## 2026-11-26: A plain `sips` resize left the icon over the 200 KB limit  [area: expo]
- What happened: Task 3 resized the placeholder icon with `sips`; the PNG came out over the test's 200 KB limit. Flattening the near-opaque alpha channel and recompressing brought it under.
- Why (root cause): `sips` keeps the alpha channel and doesn't optimise PNG compression, so a resize alone doesn't shrink the file much.
- Fix / rule: For web and PWA icons, drop an alpha channel that's (nearly) opaque and recompress after resizing, then check the size against the test. First occurrence; log only.
- Source: Task 3, docs/specs/2026-11-26-home-mobile-refresh.md

## 2026-11-26: User's choice of Home headings  [area: expo]
- What happened: The user chose the Home section headings "Waiting on you" and "Recent". There were no corrections to the work.
- Why (root cause): User copy decision.
- Fix / rule: Keep these headings; they're in `lib/homeSections.ts` and the spec. Log only.
- Source: user decision during docs/specs/2026-11-26-home-mobile-refresh.md

## 2026-11-27: After Venmo opened, several endings could invite a second payment  [area: expo]
- What happened: Four findings of one kind in Sent via Venmo. Review R1 (blocking): after Venmo had opened, a refused write or `created = false` showed the generic error copy and left the tab open. The spec (D2: "copy saying to check Venmo") asked for "check Venmo" copy, but it was never built. R4: a network error followed by a failed open left a "Sent" mark for a payment that never started. QA re-check N3: a write that landed but whose refetches failed sent the screen back to Pay. The Groups session's review found that `useBill` counted a superseded refetch as finished, which showed a false "Couldn't refresh" right after the return from Venmo. R3 and R10 found missing async-edge tests and handling: timeouts, the 30-minute timer, and sign-out mid-send.
- Why (root cause): This is the sixth time the refetch and async-endings lesson has come up (2026-11-21, 2026-11-22, 2026-11-24 ×2, 2026-11-25). `2026-11-24-product-engineer-refetch-and-copy.md` has been pending since 2026-11-24. The 2026-11-25 async-limits rule was applied only to `implementer` and `code-reviewer`, but `product-engineer` built these screens, so it never had either rule. One new part: once money may have left through another app, "the write failed" and "the reload failed" are no longer harmless. The screen must never fall back to the state it showed before the send.
- Fix / rule: Once an outside payment app may have opened, every ending (refused, already marked, network or timeout, the reload failed, superseded) says to check that app before paying again and never shows Pay as the next step. A write the server confirmed is never undone on screen by a failed or superseded refetch. Only the latest refetch decides "finished". A mark is never left behind for an open that failed. Promoted: Change 3 of the refetch proposal (product-engineer, code-reviewer), which also copies the applied async-endings bullet into `product-engineer`.
- Source: R1, R3, R4, R10 in review; QA re-check N3; the Groups session's `useBill` finding; docs/specs/2026-11-26-sent-via-venmo.md D2; earlier refetch/async lessons listed above

## 2026-11-27: The Not received confirm took a fresh token, which defeated the ABA guard  [area: rls]
- What happened: Review R2: the "Not received" confirm read a fresh `p_expected_at` / `p_expected_cents` when the payer pressed confirm, instead of using the mark the payer had tapped. If the mark was cleared and made again in between, the confirm would clear the new mark, which the token was there to prevent.
- Why (root cause): This is the second stale-token lesson (2026-11-25 "Stale-token checks: the order of checks decides the error…"). The token's job is to say "what I was looking at". Re-reading it at confirm time turns it into "whatever is there now".
- Fix / rule: An expected-state token is captured from the data the person saw when they started the action (the row they tapped) and carried through any confirm step unchanged. A test changes the server state between the tap and the confirm and expects "this changed". Promoted: Change 4 of the refetch proposal (product-engineer, code-reviewer).
- Source: R2 in review of docs/specs/2026-11-26-sent-via-venmo.md; lesson 2026-11-25 "Stale-token checks…"

## 2026-11-27: Requirements written into the spec or UX brief, but without a numbered criterion, weren't built  [area: process]
- What happened: Two requirements were written down but never became numbered acceptance criteria, and neither was built. The "check Venmo" copy for write errors after an open was in D2 but had no criterion (it became R1). The chooser's keyboard behavior was in the UX brief's accessibility table ("arrow keys or Tab between segments, Space/Enter selects") but not in the spec (it became QA N2). Criterion 54 checked radio semantics only through `accessibilityState`.
- Why (root cause): Agents build and test against the numbered criteria. Prose in D sections and rows in companion docs get folded into the spec and then lost. This is the second time: 2026-11-25 R9 was a user decision with no criterion and no test. The staff-engineer checklist item 8 ("the documents agree") checks contradictions, not coverage.
- Fix / rule: Before handoff, the PM checks that every behavior, copy line and accessibility row in the D sections, the UX brief and the visual doc maps to a numbered criterion (or is marked "user check"), and lists any that don't. The staff-engineer's item 8 adds coverage. Promoted: new `2026-11-27-every-requirement-has-a-criterion.md`.
- Source: R1 and N2; docs/specs/2026-11-26-sent-via-venmo.md line 202 and criterion 54; docs/specs/2026-11-26-sent-via-venmo-ux.md accessibility table; lesson 2026-11-25 "Review nits on tests…"

## 2026-11-27: Web accessibility was checked in Jest, but react-native-web ignores `accessibilityState`  [area: expo]
- What happened: QA F1: the web radios had no `aria-checked`, because react-native-web doesn't map `accessibilityState` to ARIA. The Jest test passed because the test renderer reads `accessibilityState` directly. The re-check found N2: the radios lacked Space and arrow-key selection. A copy slip also showed "On a computer?" on mobile web.
- Why (root cause): This is the second time a react-native-web behavior was assumed (after 2026-11-25 "On web, the focus ring showed on mouse clicks and taps"). The Jest renderer isn't the browser DOM, so a test there can't show what a screen reader or keyboard user gets on web. A custom radio group also needs the keyboard pattern that native radios get for free. "Web" also covers phones, which `detectMobileWeb` exists to tell apart.
- Fix / rule: Web semantics are set through the props react-native-web turns into ARIA (`aria-checked`, `aria-disabled`, `role`), and QA checks them in the running browser's DOM, not only in Jest. A custom radio group or tab set implements the keyboard pattern (arrow keys move and select, Space selects, one tab stop). Desktop-only copy is gated on `detectMobileWeb`, not on `Platform.OS === 'web'`. Promoted: new `2026-11-27-web-accessibility-in-the-browser.md` (product-engineer, qa-tester).
- Source: QA F1, the copy fix and re-check N2, docs/specs/2026-11-26-sent-via-venmo.md; lesson 2026-11-25 "On web, the focus ring…"

## 2026-11-27: Two new panels overflowed at 200% zoom  [area: expo]
- What happened: QA F2: the Not received confirm overflowed at 200% browser zoom. After the fix, the re-check found N1: the method chooser overflowed the same way.
- Why (root cause): `visual-designer` says "layouts wrap instead of clipping", but nothing tells the builder or QA to check web zoom. A fixed row of segments and a confirm with side-by-side buttons don't wrap unless they're designed to.
- Fix / rule: Each new or changed panel is checked at 200% browser zoom (or a 320 px wide viewport) and at the largest Dynamic Type size. Rows of controls wrap or stack, and nothing is clipped or scrolls sideways. This happened twice in one task, so it's promoted with the web-accessibility proposal (product-engineer, qa-tester).
- Source: QA F2 and re-check N1, docs/specs/2026-11-26-sent-via-venmo.md

## 2026-11-27: The undo rule and the method list were written out in more than one place  [area: money-math]
- What happened: Review R6: the rule for who may undo a mark was implemented twice. R9: the payment-method subset (`venmo` / `cash`) was spelled out where it could have come from one list.
- Why (root cause): This is the fifth "same rule in two places" (2026-11-22, 2026-11-24, 2026-11-25 ×2). The user rejected the repo-wide `CLAUDE.md` bullet on 2026-11-25 and gave no reason. The 2026-11-25 entry said to propose a narrow version next time, but only after asking the user why the bullet was rejected.
- Fix / rule: Same lesson. Proposed narrowly as Change 3 of the pending `2026-11-25-one-status-source-per-screen.md`: `code-reviewer` flags a rule or allowed-values list decided in two places. The proposal puts the "why was it rejected" question to the user first.
- Source: R6, R9 in review of docs/specs/2026-11-26-sent-via-venmo.md; lesson 2026-11-25 "The user rejected the 'import, never copy' CLAUDE.md convention"

## 2026-11-27: Copy said "paid" for a send, and Settle was pushed twice  [area: expo]
- What happened: Review R5: copy said someone "paid" when the app only knows they sent money through Venmo (the payer hasn't confirmed it arrived). R8: Settle was pushed onto the stack twice.
- Why (root cause): R5: the copy described what we hope happened, not what the app knows. R8: notifications added a new source of navigation (the responder) next to the existing ones. This is the second case of more than one navigator (2026-11-19 "Only the single resume effect navigates after sign-in").
- Fix / rule: Status copy says only what the app knows: "Sent via Venmo" until the payer confirms. Any new navigation source (notification response, deep link, resume) goes through the existing gate, or skips the navigation if the target is already on top, with a test that fires two sources. Log only. The navigation rule is already in `product-engineer`, but it should name notification responses if this happens again.
- Source: R5, R8 in review of docs/specs/2026-11-26-sent-via-venmo.md; lesson 2026-11-19 "Only the single resume effect navigates…"

## 2026-11-27: A function used in a CHECK constraint needs EXECUTE for every role that writes, including service_role  [area: rls]
- What happened: Review R7 (accepted): a CHECK constraint calls a function whose EXECUTE was revoked from the roles that write the table, under our revoke-all convention, so `service_role` writes fail. The trade-off was accepted.
- Why (root cause): The explicit-grants convention revokes EXECUTE by default, and a CHECK constraint runs as the writing role.
- Fix / rule: When a CHECK constraint or trigger calls a function, grant EXECUTE to every role that writes the table, or record that the role is meant to be blocked (as here). Add a pgTAP test for it. First occurrence; log only.
- Source: R7 in review of docs/specs/2026-11-26-sent-via-venmo.md

## 2026-11-27: Unit tests passed on both sides, but `settleView` never passed `notReceived` into `settlePlan`  [area: testing]
- What happened: The T10 live check (61/61 in the end) found that `settleView` didn't pass `notReceived` into `settlePlan`. Both functions had passing unit tests. Separately, T6 added new footer kinds, and `SettleFooter` crashed on them until 9a fixed it.
- Why (root cause): Each function was tested alone, and nothing tested the input as it passed through the caller. A new member of a union reached a renderer that didn't handle it, and no exhaustiveness check flagged the renderer.
- Fix / rule: When a `lib/` function gains an input, at least one test goes through its caller (the view model) with that input set. A renderer that switches on a `kind` ends with an `assertNever` default, so `tsc` lists every consumer when a kind is added. The task that adds the kind names those consumers. The live multi-user run caught the wiring gap, so keep running it. First occurrence of each; log only.
- Source: T10 live check, T6 and 9a, docs/specs/2026-11-26-sent-via-venmo.md

## 2026-11-27: Our `migration up` applied another session's draft migration  [area: process]
- What happened: `npx supabase migration up` applied the Groups session's draft migration, because it was already in `supabase/migrations/`. The sessions then agreed to reserve a migration timestamp and keep in-progress migrations out of `supabase/migrations/` until they're ready.
- Why (root cause): `supabase/migrations/` is shared and is read in full by `migration up` and `db reset`. A file there counts as "ready", whoever wrote it. Reserving timestamps (applied 2026-11-25) covers names, not readiness.
- Fix / rule: Draft migrations live outside `supabase/migrations/` (in the scratchpad) until the task applies them. Before `migration up` or `db reset`, list `supabase/migrations/` and compare it with the files you expect. Report any file you didn't write before applying. Promoted: Change 5 of `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: process incident, docs/specs/2026-11-26-sent-via-venmo.md; lessons 2026-11-25 on reserved numbers and two sessions

## 2026-11-27: Fixes in another session's files stalled: a relay isn't approval, and one fix was never applied  [area: process]
- What happened: T7 needed a one-line change in the Groups session's `homeRowView`. The Task 9b agent was rightly blocked from editing another session's test file, because a relayed message from the main session isn't the user's approval. Four failures in `homeMarkers.test.tsx` stayed open to the end, because the owning session never applied the 2-line fix it was sent.
- Why (root cause): The ownership rules say a finding goes to the owner, but not who follows it up or what happens if the owner doesn't act. Only the user can approve an edit across ownership, so a fix sent by message stays open until someone tracks it.
- Fix / rule: A fix needed in another session's file is sent as an exact patch with an id. The main session tracks it as "open, waiting on <session>" and lists it in the build summary until the owner confirms. If the owner doesn't act, ask the user directly whether to apply it. Never tell an agent that a relay is approval. Promoted with the migration entry: Change 5 of `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: T7, Task 9b and the open `homeMarkers` failures, docs/specs/2026-11-26-sent-via-venmo.md

## 2026-11-27: Machine load made single test files take over 340 s  [area: testing]
- What happened: With several sessions running, single Jest files took over 340 s, and many runs timed out. A usage limit stopped the Task 9a agent partway through; it resumed later without losing work.
- Why (root cause): This is the sixth report of load. The worker cap and "one full run at a time" were followed, so the load came from other sessions. One session can't fix that.
- Fix / rule: There's no new agent rule. Keep reporting timeouts with `uptime`. The real lever is the number of concurrent sessions, which is the user's call, so the build summary says so when single files take minutes. Log only.
- Source: process, docs/specs/2026-11-26-sent-via-venmo.md; earlier load lessons (2026-11-21, 2026-11-22, 2026-11-24 ×2, 2026-11-26)

## 2026-11-27: expo-notifications always adds the push entitlement; a local plugin listed before it strips it  [area: expo]
- What happened: A read-only native spike found that the `expo-notifications` config plugin always adds `aps-environment`, and it has no option to skip it. The free Personal Team can't sign that capability. `plugins/withoutPushEntitlement.js` deletes the key and is listed before `"expo-notifications"` in `app.json`, because mods registered earlier run later. `__tests__/appConfig.test.ts` guards the order and the result. It's still unverified on a device (spec R1). The docs-writer suggested a `CLAUDE.md` line.
- Why (root cause): A native fact that the next person changing `app.json` plugins could easily break by reordering them.
- Fix / rule: Keep the stripper before the package, and run a new dev build after any plugin change. Proposed for `CLAUDE.md` § Commands as `2026-11-27-claude-md-notifications-plugin-order.md`. The spike itself paid off: it's added to the staff-engineer checklist (installed config plugins: what they add to the native project).
- Source: native spike and Task 8, docs/specs/2026-11-26-sent-via-venmo-notifications-check.md; `plugins/withoutPushEntitlement.js`; docs-writer report

## 2026-11-27: Staged design before code paid off a third time  [area: process]
- What happened: The phases were PM spec, UX brief, visual design, staff-engineer review (F1–F12 plus §11 multi-payer readiness), then Amendment A1, with a native spike alongside. The design phase caught the SecureStore key format (F1) and the check-in key that could never match after `settle_difference` (F4).
- Why (root cause): This is the third time the whole-plan read has paid off (2026-11-24, 2026-11-25).
- Fix / rule: No new rule. Evidence for the pending `2026-11-24-staff-engineer-review.md`, whose item 1 now names config plugins and item 8 names coverage.
- Source: docs/specs/2026-11-26-sent-via-venmo-eng.md; A1 in docs/specs/2026-11-26-sent-via-venmo.md

## 2026-11-27: User's choices from Sent via Venmo  [area: process]
- What happened: The user asked to build without stopping for questions, and asked for a "seamless, positive and reliable" experience. Mid-design they changed Home's groups. "Recent" was removed, which supersedes the 2026-11-26 entry "User's choice of Home headings". They reversed P4: a fully paid bill goes straight to Settled, with no age-off. Groups v2 and "Who paid" (a payments ledger) were negotiated with two other sessions.
- Why (root cause): The user's product direction. "Reliable" here means never inviting a double payment.
- Fix / rule: Home has no "Recent" group, and a fully paid bill moves to Settled at once. Copy is calm and says what to do next (UX brief: no "failed", "error" or "!"). Log only.
- Source: user direction during docs/specs/2026-11-26-sent-via-venmo*.md

## 2026-11-27: Root `.env` Google variables, ninth report  [area: expo]
- What happened: The Google OAuth variables in the root `.env` were reported again. They're tracked in `docs/before-production.md` §3.
- Why (root cause): A user action, still not done. The one-line-report change is still pending.
- Fix / rule: No new rule. Added as evidence to `2026-11-24-bundle-checks-jest-setup-tracked-items.md` (Change 5). Moving those variables to `supabase/.env` is the user's step.
- Source: QA report, docs/specs/2026-11-26-sent-via-venmo.md; eight earlier reports

## 2026-11-27: react-native-web dropped `accessibilityState` again, this time because the spec prescribed it  [area: expo]
- What happened: Review R1: `DisclosureRow` (the Settled toggle) had no `aria-expanded` on web, because react-native-web 0.21 drops `accessibilityState`, and it drops `accessibilityHint` too. The Jest RN renderer reads those props directly, so it couldn't catch this. The fix passes `aria-expanded` and `aria-hidden`, and adds a test that renders the component through react-native-web with `react-dom/server` (`renderToStaticMarkup`) and checks the attributes. `components/SharesSummary.tsx` has the same bug, tracked in `docs/before-production.md` §7. The spec itself told the builder to use `accessibilityState={{ expanded: open }}` and `accessibilityHint` (D7, "same pattern as SharesSummary"). It was written a day after the 2026-11-27 web-accessibility lesson. The static-markup test pattern is now copied by hand into four test files across sessions (`assignChips`, `billGroup`, `groupAriaWeb`, `uiPrimitives` ×2). There are also two answers to the same problem: the groups session's `lib/ariaProps.ts` and `DisclosureRow`'s inline props.
- Why (root cause): This is the third time a react-native-web behaviour was assumed and not checked (2026-11-25 focus ring, 2026-11-27 radios). The pending `2026-11-27-web-accessibility-in-the-browser.md` targets only `product-engineer` and `qa-tester`. The PM and designer who write the props into the spec don't have it, and neither does the reviewer. The applied `product-engineer` rule ("plus an `accessibilityHint`") also says nothing about web, where the hint is lost. That proposal predicted `DisclosureRow` would have this gap, and the next task proved it.
- Fix / rule: Specs and designs give web state as the `aria-*` props react-native-web maps (or `ariaProps(...)` from `lib/ariaProps.ts`), never `accessibilityState` alone. Anything a hint carries that matters on web goes in the label. The Jest proof for web semantics is a react-native-web static-markup render, through one shared helper in `test-utils/`, not a copy in every file. Promoted: Changes 3–5 added to `2026-11-27-web-accessibility-in-the-browser.md` (product-manager, visual-designer, code-reviewer, and a reworded product-engineer bullet).
- Source: R1 in review of docs/specs/2026-11-26-home-groups-v2.md (D7 line 209, Built note); lessons 2026-11-25 "On web, the focus ring…" and 2026-11-27 "Web accessibility was checked in Jest…"

## 2026-11-27: After several rule changes, one cell of the exhaustive table contradicted the user's binding rule  [area: process]
- What happened: Review R2: a host who isn't the payer and hasn't claimed anything was hidden from Home. That breaks user rule 1 ("nothing claimed yet" is Waiting on you). The cause was D3's cell "Guest: E, none, `nothing` → hidden". The user redefined the groups four times mid-spec (group by what's owed; hidden and Settled come back when money changes; marker-first reversed; multi-payer future-proofing). Each change was folded into the rules, but the derived D3 table wasn't re-derived from them, and the criteria tested the table. The fix makes the cell `!final && !claimedAny ? 'waiting' : 'hidden'`.
- Why (root cause): The criteria tested the table, not the rules. Once a table is derived, it becomes the spec the builders follow, so a cell left over from an earlier version of the rules ships. This is the third "amendment not carried to everything that restates it" (2026-11-24 "A 'can't happen' row was false, and a fixture kept the old answer…", 2026-11-24 "Docs went stale…").
- Fix / rule: When the user's binding rules change, the PM re-derives every table cell from the current rules, and each cell names the rule it comes from (rule 1, rule 4). A cell no rule decides is an open question. The reviewer checks the table against the rules, not only the code against the table. Promoted: Change 3 of `2026-11-27-every-requirement-has-a-criterion.md`.
- Source: R2 in review of docs/specs/2026-11-26-home-groups-v2.md (Built note); user corrections during that spec

## 2026-11-27: Kept settle facts outlived the payer they were about, fourth time for kept state  [area: expo]
- What happened: Review R3: `keepCandidates` kept settle facts from an earlier read (and A1.S5 now keeps them on a failed refresh too). A kept plan could name a payer that a newer bill summary had changed, so a row could show the old payer's pill or group. The fix drops a kept plan whose payer differs from the new list's.
- Why (root cause): This is the fourth time state kept from earlier was trusted after the facts it described changed (2026-11-24 dismissal keyed on the bill, 2026-11-25 "Couldn't open Venmo" line, 2026-11-25 F3 the prompt keyed on the amount). The pending rule (Change 2 of the refetch proposal) covers messages and remembered choices, not data kept across a refresh. "Keep the previous result on failure" (S5) makes this more common.
- Fix / rule: Data kept from an earlier read (on a failed refresh, or carried while a new read loads) is checked against the deciding facts in the newest data (the payer, membership, whether the bill is final) and dropped when they differ, with a test that changes the deciding fact between reads. Added as Change 2b of `2026-11-24-product-engineer-refetch-and-copy.md`.
- Source: R3 in review of docs/specs/2026-11-26-home-groups-v2.md; A1.S5; earlier kept-state lessons listed above

## 2026-11-27: `scrollTo` ran before the layout existed, and the spec's scroll formula left out a margin  [area: expo]
- What happened: Review R4: on open, the Settled scroll ran before the opened card had laid out, so the browser clamped `scrollTo` to the old content height. The fix moves the scroll to the opened card's `onLayout`. R6: A1.S2's formula measured `toggleY` as if it were the top of the 44 pt target, but `DISCLOSURE_ROW_MARGIN` sits on both sides, so the scroll overshot. The fix is `settledScrollTarget` with `2 × DISCLOSURE_ROW_MARGIN`.
- Why (root cause): R4: a scroll aimed at content that's about to appear depends on that content's layout, and web clamps to what's laid out now. R6: the spec wrote layout math out by hand, and the A1.S1 negative margin changed what `toggleY` measures.
- Fix / rule: Scroll to something new from its own `onLayout` (or after a frame), never in the same handler that makes it appear. Layout math lives in one named helper with a test that uses the real token values. A spec formula is a starting value, checked against the built layout. First occurrence of each; log only.
- Source: R4, R6 in review of docs/specs/2026-11-26-home-groups-v2.md (Built note)

## 2026-11-27: Absence check without a positive control, thirteenth time: hidden, but back in another form  [area: testing]
- What happened: Review R5: `S2_HIDDEN` in `__tests__/homeMarkers.test.tsx` checked that bill S2's "paid" label and "Paid $14.80" were absent. If S2 came back in another form (as `S1_PLAIN`, its no-plan label), the check still passed. The fix asserts the whole list of row labels equals the expected list, so S2 can't be on screen in any form.
- Why (root cause): Thirteenth "check that couldn't fail" in the log. The rule has been in the pending `2026-11-25-absence-assertions-need-presence.md` since 2026-11-25 and isn't in any agent file. This case adds a new side: "the thing is absent" was tested as "one form of it is absent". A row can render in several forms (with or without a plan, with a pill or without), and the check named only one.
- Fix / rule: To prove something is hidden, assert the exact full set that is shown (every row label, in order), not the absence of one representation of it. Added as Change 8 of the absence proposal.
- Source: R5 in review of docs/specs/2026-11-26-home-groups-v2.md; the twelve earlier entries listed in the proposal

## 2026-11-27: A new function's name collided with an existing field that meant something else  [area: process]
- What happened: Review R8: A1.M2 named a new helper `collectCents(plan, myId)` ("still to collect"), but `lib/settle.ts`'s ready plan already has a `collectCents` field meaning "every positive share, paid or not". The helper was renamed `stillToCollectCents`.
- Why (root cause): The spec picked a name without searching for it. In money code, the same name with two meanings invites the wrong amount.
- Fix / rule: Before a spec names a new money helper or field, grep `lib/` for the name. If it exists with another meaning, pick a name that says the difference. First occurrence; log only.
- Source: R8 in review of docs/specs/2026-11-26-home-groups-v2.md (Built note, "Rename")

## 2026-11-27: QA passed, then another session's change broke two of our tests, one of them a criterion  [area: process]
- What happened: QA passed the full suite. Afterwards splitit-app-92 added a 2000 ms debounce to `mark_bill_seen`. That broke `__tests__/homeMarkers.test.tsx` tests 32 and 36, which expect an immediate mark. Test 36 ("Home never navigates by itself") is this slice's criterion 37, which says it "passes unchanged". The file is shared: this slice owns its Home-section assertions, and other tests in it cover 92's behaviour.
- Why (root cause): The session that changed the behaviour didn't search for tests that assert it in files it doesn't own, and a QA pass is a snapshot. This is the third cross-session test break (2026-11-25 "Parallel agents… changed a label another task's tests assert", 2026-11-27 "Fixes in another session's files stalled").
- Fix / rule: Before changing a shared behaviour (an RPC call's timing, a label, a type), grep every test for it (`mark_bill_seen`, the label) and run those files. A failure in another session's file goes to its owner as an exact patch, tracked under the existing rule. The main session re-runs the files other sessions touched before its summary, and reports any criterion that stopped passing after QA. Added as Change 6 of `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: QA follow-up, docs/specs/2026-11-26-home-groups-v2.md (criterion 37); splitit-app-92's debounce change

## 2026-11-27: Four sessions coordinated well; a peer's edit request went to the user; a read-only agent couldn't save its review  [area: process]
- What happened: Four sessions coordinated by message: file ownership, one full Jest run at a time, sequenced migrations, and the Groups slot. No collisions were reported. Another session's agent was blocked from editing our test file and asked us to make the edit. The main session asked the user instead of acting on a peer's request, which is what the 2026-11-27 relay rule says. A peer agent of the Plan type was read-only, so it couldn't write its review file, and the main session saved the text.
- Why (root cause): The ownership and relay rules held, even though they're still only in a pending proposal. Plan agents can't write files, so a step that tells one to write a file can't be done as asked.
- Fix / rule: Keep it up. When an agent's output must be a file, spawn a type that can write, or tell it to return the text and have the main session save it word for word. Log only. The coordination rules stay evidence for `2026-11-25-build-task-shared-files-and-served-backend.md` Change 5.
- Source: process notes, docs/specs/2026-11-26-home-groups-v2.md

## 2026-11-27: User decisions arrived relayed through other sessions  [area: process]
- What happened: Several user decisions for this slice came through other sessions' messages instead of from the user directly.
- Why (root cause): With four sessions, the user answers in whichever one asks. The permission-laundering rule covers approvals for edits and permissions. Product decisions passed between sessions have no written handling, and a relay can drop words or context.
- Fix / rule: Record a relayed decision with its source ("relayed by <session>, <date>"). Treat it as binding for design, but list it in the build summary for the user to confirm. It never counts as approval for an edit, permission or config change. Added as Change 4 of `2026-11-24-delegated-decisions.md`.
- Source: process notes, docs/specs/2026-11-26-home-groups-v2.md

## 2026-11-27: Who-paid Task 2b wrote its implementation before its tests  [area: testing]
- What happened: In the related Who-paid slice, Task 2b's implementation came before its tests, which goes against `implementer`'s "Tests first for pure logic". This was offset by expectations computed by hand (not read off the code's output) and by mutants shown to fail.
- Why (root cause): Tests written after the code tend to assert whatever it returns. Hand-computed values and mutants bring back the independence that tests-first gives.
- Fix / rule: If tests-first is skipped, the report says so, the expected values are worked out by hand from the spec, and each key assertion is run against a mutant to show it fails. First occurrence; log only.
- Source: Who-paid Task 2b (related to docs/specs/2026-11-26-home-groups-v2.md)

## 2026-11-27: A pre-build UX critique paid off, the fourth staged design  [area: process]
- What happened: Before the build, the visual-designer reviewed the plan with the impeccable critique, giving M1–M3 and S1–S8. M1 replaced a one-off toggle with the shared `DisclosureRow`. The user decided M2, M3, S5 and S7. Review round 1 approved the build with should-fixes only.
- Why (root cause): This is the fourth time a whole-plan read before code has paid off (2026-11-24, 2026-11-25, 2026-11-27 Sent via Venmo). This time the read was a UX critique, not an engineering one.
- Fix / rule: No new rule. Evidence for the pending `2026-11-24-staff-engineer-review.md`; the UX critique fills the "after UX and visual docs" step that proposal describes.
- Source: docs/specs/2026-11-26-home-groups-v2-ux-review.md; A1 in docs/specs/2026-11-26-home-groups-v2.md

## 2026-11-27: User's choices from Home groups v2  [area: expo]
- What happened: The user set Home's groups. Waiting on you: you owe, nothing claimed, the amount went up, not received, and "claimed, can't pay yet". Owed to you: you're the payer and someone owes you. Settled: you're the payer and everyone has paid, collapsed with a count. Hidden: a guest who has paid in full. Hidden and Settled bills come back when the money changes in either direction. Groups are decided by what's owed, and markers decide only the pill (the marker-first rule is reversed). Every "is the viewer the payer" check sits in one helper, for multi-payer later. Decided from the UX review: M2 "To collect $X" on the payer's rows; M3 the first load waits up to 1000 ms for settle data; S5 a failed refresh keeps the previous groups (except on the first read); S7 the pill copy is "Claimed · not ready to pay".
- Why (root cause): The user's product direction.
- Fix / rule: Keep these. They're in `lib/homeSections.ts` and the spec's "user's rules". Log only.
- Source: user decisions and corrections, docs/specs/2026-11-26-home-groups-v2.md (rules 1–8, A1)

## 2026-11-27: pgTAP went red because shared test files already called another session's unapplied migrations  [area: testing]
- What happened: Near the end of Groups, `npm run db:test` failed in `group_bills`, `membership` and `assign_item` (test 4). It looked like a Groups failure. The cause was the Who-paid session: it had edited those shared pgTAP files to call functions from its migrations `2026112714000x`, which weren't applied locally yet. After that session applied them, db:test passed (29 files, 1943 tests).
- Why (root cause): The "failure only outside this task" rule (2026-11-24) covers Jest and `tsc`, not pgTAP. Here the failure was inside files this task owns, so the rule didn't apply. A shared test file can depend on a migration that another session hasn't applied yet. The tell is a "function does not exist" or "column does not exist" error.
- Fix / rule: Before blaming your own task for a db:test failure, list the unapplied migrations (`npx supabase migration list --local`, or compare `supabase/migrations/` with what `migration up` would apply). Then grep `supabase/migrations/` for the missing function or column and run `git log`/`git status` on the test file. If an unapplied file you didn't write defines it, report "waiting on <session>'s migration <name>" and don't apply it yourself (2026-11-27 "Our `migration up` applied another session's draft migration"). On the writing side, a test edit that needs a draft migration lands together with that migration, not before it. Promoted: new `2026-11-27-db-test-failures-other-sessions.md` (qa-tester, supabase-engineer) and Change 7 of `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: final db:test run, docs/specs/2026-11-26-groups-mvp.md; Who-paid migrations 2026112714000x; lessons 2026-11-24 "Other sessions' half-finished edits broke whole-repo test and typecheck runs", 2026-11-27 "Our `migration up` applied another session's draft migration"

## 2026-11-27: The live smoke run couldn't delete its throwaway users, because group membership blocks deletion  [area: testing]
- What happened: The Groups live smoke test (45/45, run twice) failed its cleanup. `group_members.user_id` references `profiles` `on delete restrict` (A1.9), and a member with history can't leave (C-G10). So `auth.admin.deleteUser` failed for every throwaway user who'd joined a group, and the app's own calls couldn't undo it. Cleanup needed superuser `psql`, deleting the run's rows child-first by hand.
- Why (root cause): `live-db-smoke` cleans up with `deleteUser` alone, which assumed every user-owned row cascades. Groups added the first restrict FK to `profiles` and the first membership you can't leave.
- Fix / rule: The smoke script owns a cleanup that works for restrict FKs. It deletes the run's own rows (by run-tag user ids only) as the database superuser, parents before auth users, so cascades handle the append-only event tables. Then it counts what's left of the run in each table (users, profiles, groups, memberships, bills), and every count must be 0. Promoted: Change 3 of `2026-11-27-live-db-smoke-groups.md`.
- Source: Groups live smoke test, docs/specs/2026-11-26-groups-mvp.md (A1.9, C-G10, A3 "cleanup left 0")

## 2026-11-27: Group members can't delete their account; the spec decided the FK but not account deletion  [area: rls]
- What happened: The same restrict FK means a group member with history can never delete their account, because they can't leave and the profile can't be removed. It's now in `docs/before-production.md` (account deletion, GR-26). Apple requires in-app account deletion (guideline 5.1.1(v)).
- Why (root cause): A1.9 chose `on delete restrict` to protect group balances, which is a fair choice. But account deletion isn't designed yet, so nothing checked what restrict does to it. The smoke cleanup found it first.
- Fix / rule: When a migration adds an FK to `profiles` or `auth.users`, the spec says what account deletion does to that row (cascade, anonymise, or block, and how the user gets out of a block), or it adds an item to `docs/before-production.md` in the same task. First occurrence; log only.
- Source: Groups live smoke cleanup; A1.9 and criterion 98 of docs/specs/2026-11-26-groups-mvp.md; `docs/before-production.md` account-deletion items

## 2026-11-27: The app's real TypeScript data layer ran in node through an esbuild bundle  [area: testing]
- What happened: T12 (115/115) and the final Groups smoke test (45/45) ran the app's own `lib/groups.ts` (and the group view-model files) against the local DB, not hand-copied queries. They bundled it with esbuild (already a dependency), with two plugins. One aliased `./supabase` to a shim whose `supabase` is a Proxy forwarding to the current user's client on `globalThis`, so the script switches user before each call. The other stubbed `react-native` and `expo-*` imports.
- Why (root cause): `live-db-smoke` says to read column lists out of `lib/bills.ts` and retype them, because `tsx` isn't installed. Retyped queries can drift from the app. Bundling tests the app's real calls, parsers and error mapping.
- Fix / rule: For a data layer in TypeScript, bundle it with esbuild into the scratchpad and call its exported functions. This is done by hand twice now, so it goes in the skill. Promoted: Change 2 of `2026-11-27-live-db-smoke-groups.md`.
- Source: T12 (A3) and the final smoke run, docs/specs/2026-11-26-groups-mvp.md

## 2026-11-27: A copy change nobody claimed broke another session's committed fixture  [area: process]
- What happened: A copy change in `lib/settleView.ts` ("payment didn't go through") broke another session's committed regression fixture. None of the active sessions knew who had made it. The user confirmed it came from an earlier session of theirs.
- Why (root cause): This is the fourth cross-session test break (2026-11-25, 2026-11-27 ×2), and the first where the change had no known owner. The pending Change 6 (grep every test for a label before changing it) would have stopped it at the source. Without an owner, nobody could send the patch to anyone, and changing the change or the fixture without asking would pick a winner.
- Fix / rule: When a change in a shared file isn't yours and no active session claims it, don't revert it or rewrite tests to match it. Ask the user who made it and which side is right, and record the answer in the spec. Promoted: Change 7 of `2026-11-25-build-task-shared-files-and-served-backend.md`, along with the pgTAP entry above.
- Source: process incident during docs/specs/2026-11-26-groups-mvp.md; user confirmation; lesson 2026-11-27 "QA passed, then another session's change broke two of our tests…"

## 2026-11-27: The docs handoff was too narrow again, so two concept notes T19 required were skipped (fourth time)  [area: process]
- What happened: The docs-writer was first handed a narrower scope than T19, and skipped the updates to `docs/learning/concepts/people-and-membership.md` and `row-level-security.md` that T19 required. That happened even though criterion 88 says "The docs-writer reports every T19 bullet". The gap was caught and the notes were written.
- Why (root cause): This is the fourth docs handoff that left out spec items or source material (2026-11-24 twice, 2026-11-25). The fix has been in the pending `2026-11-24-docs-cite-symbols-not-lines.md` (Changes 3 and 4) since 2026-11-24. The log line "Promoted to `build-task` and `docs-writer`" was never applied.
- Fix / rule: Hand the docs-writer the spec path and the docs task number, plus the full list of files that task names, and have it report every bullet. Evidence added to that proposal. It's now the main reason to approve it.
- Source: T19 and criterion 88 of docs/specs/2026-11-26-groups-mvp.md; lessons 2026-11-24 "The docs handoff dropped items…", 2026-11-25 "The docs handoff lacked the source material, third time"

## 2026-11-27: The staff-engineer review before code found 4 blocking issues, the fifth staged design to pay off  [area: process]
- What happened: `docs/specs/2026-11-26-groups-mvp-eng.md` gave 4 blocking findings, 15 should-fixes and 9 nits before T2–T7 were written. Among them: sequencing with Sent via Venmo's migration (B1), a `leave_group` × `edit_expense` deadlock (B2), and activity kinds missing from the check constraint (B4). A1 adopted all blocking and should-fix items. The code review then approved with should-fixes only (A4), and T12's live reconciliation needed no lib or DB change.
- Why (root cause): This is the fifth time a whole-plan read before code has paid off (2026-11-24, 2026-11-25, 2026-11-27 ×2).
- Fix / rule: No new rule. Evidence for the pending `2026-11-24-staff-engineer-review.md`.
- Source: docs/specs/2026-11-26-groups-mvp-eng.md; A1, A3, A4 of docs/specs/2026-11-26-groups-mvp.md

## 2026-11-27: Group refetches could be superseded, and group calls had no time limit  [area: expo]
- What happened: Review R1: an older `useGroupSnapshot` refetch could count as finished, so a screen could show "Couldn't refresh" for a write that had landed. R2: group RPCs and the snapshot refetch had no time limit, so a call that never answered left the screen waiting. The fixes: only the newest refetch counts (A4.1), and every group call gives up after `GROUP_REQUEST_TIMEOUT_MS` = 15 s and reads as `network`, with retries reusing the client id (A4.2, GR-RV-2).
- Why (root cause): This is the seventh occurrence of the async-endings lesson. R2 is the first time a screen got the "never arrives" timeout that the pending refetch proposal's (a)/(b) choice has been waiting on since 2026-11-24.
- Fix / rule: No new rule. Evidence added to `2026-11-24-product-engineer-refetch-and-copy.md`: GR-RV-2 is a working answer for option (a), and client-id idempotency is what makes a timeout safe to retry.
- Source: R1, R2 in review of docs/specs/2026-11-26-groups-mvp.md (A4.1, A4.2; GR-RV-1, GR-RV-2)

## 2026-11-27: User wants autocompact off with the 200k context window kept  [area: process]
- What happened: During the task, the user corrected a settings suggestion: turn autocompact off, but keep the 200k window ("without autocompact in that case").
- Why (root cause): The user's preference for how sessions run.
- Fix / rule: Don't suggest turning autocompact back on, or switching window size to get around it. Long tasks keep their state in files (spec amendments, decision rows, the scratchpad) so a full context can be resumed. Agents never change these settings themselves. Log only.
- Source: user correction during docs/specs/2026-11-26-groups-mvp.md

## 2026-11-27: A not-part error outlived the facts behind it, and `useNotPart`'s scope left out the bill (fifth time for kept state)  [area: expo]
- What happened: Review R1: an error from "I wasn't part of this" stayed on screen after the line state, or the group snapshot version, it was raised under had changed, so it described a state that no longer held. The fix clears it when either changes. The one exception is `has_claims`, whose message stays to explain why nothing happened. R6: `useNotPart`'s reset scope had the group but not `billId`, so a read for one bill could land after the screen moved to another. The fix adds `billId` to the scope, and the reset settles reads still in flight.
- Why (root cause): This is the fifth time kept state outlived the facts it described (2026-11-24 dismissal keyed on the bill, 2026-11-25 "Couldn't open Venmo", 2026-11-25 F3, 2026-11-27 kept settle facts). Change 2 of the pending refetch proposal ("a message … about a specific thing … shown only while those [facts] match") would have covered R1 as written. It's still unapplied, so the builder didn't have it. R6 is the same bug one level down: a hook's identity key is a deciding fact too.
- Fix / rule: An error or busy flag a hook keeps is tied to the version or state it was raised under, and clears when that changes (unless it explains why nothing happened). A hook's reset key lists every id its data belongs to (bill as well as group), and a reset makes any read still in flight a no-op. Test it by changing the version, or the id, while the error or read is pending. Added as Change 2c of `2026-11-24-product-engineer-refetch-and-copy.md`.
- Source: R1, R6 in review of docs/specs/2026-11-27-group-claim-status.md (A2); the kept-state lessons listed above

## 2026-11-27: A sort meant for one screen went into a shared helper and changed another screen  [area: expo]
- What happened: Review R2: GCS-9 ("bills that need me first") was built inside `waitingLines`, which the group Settle screen also uses. Settle's notices were reordered, and Settle was out of scope. The fix keeps `waitingLines` in snapshot order and sorts only in the group screen's model (`needsMeFirst`).
- Why (root cause): The decision named a screen ("the group's waiting list"), but the code put it where the list is built, not where it's shown. Nobody checked who else calls the helper.
- Fix / rule: Ordering and other display choices for one screen go in that screen's view model. Shared helpers return data in source order. Before changing a shared helper's output, grep its callers and check each one is in scope. First occurrence; log only.
- Source: R2 in review of docs/specs/2026-11-27-group-claim-status.md (A2, GCS-9)

## 2026-11-27: An opt-out moved the row the person had just tapped, and focus went with it  [area: expo]
- What happened: Review R4: tapping "I wasn't part of this" on the group screen re-sorted the list (a needs-me row drops below the others), so the row moved out from under the person and keyboard or screen-reader focus was lost. The fix keeps the row order after an opt-out until the next focus refetch (`keepOrder`).
- Why (root cause): The second time a data change moved what the person was acting on (2026-11-25 SharePanel remount, which lost typed text). Both come from re-rendering a list or layout from new data without asking what the person is touching. The pending `2026-11-25-visual-changes-keep-behavior.md` covers the remount half only, and only for "visual" changes.
- Fix / rule: When a person's own action changes the data that orders a list, the list keeps its order (and the acted-on row keeps focus) until a later refresh they didn't cause, such as focus or pull-to-refresh. Test by acting on a row and checking its position and focus right after. Added as Change 6 of `2026-11-25-visual-changes-keep-behavior.md` (product-engineer, code-reviewer).
- Source: R4 in review of docs/specs/2026-11-27-group-claim-status.md (A2); lesson 2026-11-25 "A layout change remounted SharePanel…"

## 2026-11-27: A third deadlock partner: the migration header said account deletion added "no new ordering"  [area: rls]
- What happened: Review R5: `set_not_part` takes the bill `FOR KEY SHARE`, then the caller's participant row `FOR UPDATE`. The payer-deletion trigger on `bill_participants`, fired by account deletion's cascade, holds that participant row and then wants the bill `FOR UPDATE`. So a payer deleting their account while tapping "I wasn't part of this" on the same bill could get `40P01`. The migration header listed its locks, implicit ones included, but said the cascade added "one more row … and no new ordering". It's documented in `docs/before-production.md` under the existing payer-deletion deadlock (M3 R9), not fixed.
- Why (root cause): The third deadlock lesson (2026-11-24 ×2). The header followed the pending lock-order rule for its own paths, but checked the account-deletion cascade only for rows it adds, not for the triggers that cascade fires. Triggers on a parent's delete are the implicit locks that are easiest to miss.
- Fix / rule: A new function's lock list also walks every existing path that deletes or updates the rows it locks (account deletion's cascade, leave, remove), including the triggers those paths fire, and checks each against the new order. Added as Change 1b of `2026-11-24-lock-order-implicit-locks.md`.
- Source: R5 in review of docs/specs/2026-11-27-group-claim-status.md; `supabase/migrations/20261127150000_bill_not_part.sql` header; `docs/before-production.md` (payer-deletion deadlock, `set_not_part` sub-item)

## 2026-11-27: Risks the spec already named reached `docs/before-production.md` only at the docs task  [area: process]
- What happened: Review R3: the deploy-order risk (spec R1: a web build with the new parser fails against a database without the migration) and the faint tint (R5, about 1.04:1) were in the spec's Risks but not yet in `docs/before-production.md` when review ran. T7 added them, as the spec planned.
- Why (root cause): The spec assigned the checklist items to the docs task, which runs after review. So the reviewer couldn't see them, and if T7 had been skipped they'd have been lost (the docs handoff has dropped items four times).
- Fix / rule: A risk the spec already names goes into `docs/before-production.md` in the task that creates it (the migration task for deploy order), not in the docs task. First occurrence; log only.
- Source: R3 in review of docs/specs/2026-11-27-group-claim-status.md; spec Risks R1, R5, T7

## 2026-11-27: The "I wasn't part of this" hint doesn't reach web, a decided departure (GCS-15)  [area: expo]
- What happened: Criterion 29 asked for the hint ("It doesn't change anyone's share") in the label or a caption. T5 left it as an `accessibilityHint`, which react-native-web drops, and logged GCS-15 instead of adding a caption. On web, a screen-reader user isn't told the opt-out leaves money alone.
- Why (root cause): The fourth time a react-native-web drop affected a spec (2026-11-25, 2026-11-27 ×2). This time it was known and logged, which is better, but the reassurance about money is something a web user needs.
- Fix / rule: Covered by Change 1 (reworded) of the pending `2026-11-27-web-accessibility-in-the-browser.md` ("anything the hint says that a web user needs goes in the label"). Evidence added there. GCS-15 is the user's call.
- Source: criterion 29 and GCS-15, docs/specs/2026-11-27-group-claim-status.md; docs/decisions-to-review.md

## 2026-11-27: Five sessions shared the bill screen and its tests without clobbering  [area: process]
- What happened: Five sessions and agents edited `app/(app)/bills/[id]/index.tsx` and its test file. The spec listed which lines this task could touch (`renderRow`, the `blocks` array and their wiring), and criterion 36 had the reviewer check that from `git diff`. Agents coordinated by message: one waited for the other, edits were exact strings made after a fresh read, and this task's bill tests moved to a new file (`__tests__/billNotPart.test.tsx`, A2). Nothing was overwritten. Separately, one agent's scripted rewrite of a file (with an added `eslint-disable` comment) was denied by the permission check, and it redid the change as exact edits.
- Why (root cause): Line-level ownership in the spec, a reviewer check on it, and a new test file instead of a shared one made sharing one file safe. The denied rewrite is the second whole-file rewrite by an agent (2026-11-25 Prettier). Whole-file rewrites hide the real change and can overwrite other sessions' edits.
- Fix / rule: Keep it up. When a shared file is unavoidable, the spec names the parts this task may change, and new tests go in a new file. Edit shared files with exact-string edits after a fresh read. Never use a scripted rewrite, and don't add lint-disable comments to get past a check. Evidence for `2026-11-25-build-task-shared-files-and-served-backend.md` Change 5 and for `2026-11-25-visual-changes-keep-behavior.md` Changes 2 and 5 (no codemods).
- Source: process notes (a), (c), docs/specs/2026-11-27-group-claim-status.md (file ownership, criterion 36, A2)

## 2026-11-27: The esbuild live-smoke harness was reused in minutes  [area: testing]
- What happened: QA's live reconciliation (criterion 37) reused the esbuild bundle and Supabase proxy shim from Groups, bundling `lib/groups.ts` and `lib/groupClaimStatus.ts`. Setup took minutes. Result: 47/48. The one miss was QA's own wrong expectation, not the product, and QA checked the spec before calling it.
- Why (root cause): The third use of the harness. It's still not in `live-db-smoke`, so each run rebuilds it from the log and the last run's scratchpad.
- Fix / rule: No new rule. Evidence for the pending `2026-11-27-live-db-smoke-groups.md` (Change 2). When a live check fails, compare the expectation with the spec before calling it a product failure (done here).
- Source: QA report, criterion 37, docs/specs/2026-11-27-group-claim-status.md; process note (b)

## 2026-11-27: User wants one web dev server, on :8081 against the local stack  [area: process]
- What happened: During the task, two web dev servers were running (the user's original request used `localhost:8082`), and that confused the user. They asked for one server, on :8081, against the local stack. `qa-tester` step 2 tells QA to start its own server on :8082 when :8081 isn't local and to leave the user's running, which is how a second server appears.
- Why (root cause): The rule caused a wrong result. It was written to keep QA from touching the user's server (2026-11-24 "QA's own dev server worked…"), but it leaves the user with two apps on two ports, and they can't tell which one has the new work.
- Fix / rule: One web dev server, on :8081, against the local stack. Agents don't start a second one. If :8081 is down or points at the hosted project, the main session restarts it on :8081 with local values passed inline and tells the user, per their choice. Promoted: new `2026-11-27-one-web-dev-server.md` (qa-tester, CLAUDE.md Commands).
- Source: user correction (d), docs/specs/2026-11-27-group-claim-status.md; lesson 2026-11-24 "QA's own dev server worked; shell values override the root `.env`"

## 2026-11-27: User's choices from group claim status  [area: expo]
- What happened: The user asked for a state on each Home group row (claim your items, you owe, you're owed, settled up), yellow on the receipts and items waiting on them, and a "not part of this" action. Their follow-up, relayed: "maybe a slight yellow hue on that line item", which made the highlight a faint background tint (`warningSurface`), not a badge or border. GCS-1..15 were decided without asking and are open in `docs/decisions-to-review.md`. GCS-2 (bill-level only), GCS-3 (private), GCS-5 (amounts on Home, reversing GR-20) and GCS-6 ("Settled up" means me) most need a look. Criterion 33, the user's light and dark visual check of the tint, is still open.
- Why (root cause): The user's product direction.
- Fix / rule: Keep these. Highlights the user calls "slight" are tints from existing tokens, always paired with text. Making the tint stronger is a token change and the user's call after criterion 33. Log only.
- Source: user request and relayed follow-up, docs/specs/2026-11-27-group-claim-status.md; GCS-1..15

## 2026-11-27: The $/% switch changed typed cents on bills over $100, and the only test used a $31 bill  [area: money-math]
- What happened: QA failed A-50(c). On the Who paid page, switching $ → % → $ rounded each row through 0.01%, so on a $10,000 bill $3,333.33 came back as $3,333.00, and Save stayed enabled for the changed amount. The one test used a $31 bill, where 0.01% is less than 1¢, so it couldn't fail. The fix keeps the typed cents across the switch and adds a property test over random bills up to $999,999.99. In review round 1, R10 found the other end: a % row that rounded to 0¢ was silently dropped instead of refused (now A-50(d), a row error).
- Why (root cause): A conversion through a coarser unit (0.01% of the total) is exact only while the total is small. The test amounts were picked for readable arithmetic, not for where the rounding step exceeds a cent. R10 is the second "invalid money input counted as $0" (2026-11-21 "Invalid money input must never count as $0…"). The seeded property test lesson (2026-11-24) was about split math, so nobody applied it to an input form.
- Fix / rule: Any money input or unit switch ($ ↔ %, share ↔ amount) is tested at a large amount where the coarser unit is worth more than 1¢ (at least $10,000, and the input's maximum), with a seeded round-trip property test: switching there and back with no edits returns the exact typed cents, and Save stays disabled. A row that rounds to 0¢ is refused with a message, never dropped. QA's own edge cases include one large amount. Promoted: new `2026-11-27-money-inputs-large-amounts.md` (product-engineer, implementer, qa-tester).
- Source: QA A-50(c) and R10 (round 1) in review of docs/specs/2026-11-26-who-paid.md (A2.6); lessons 2026-11-21 "Invalid money input…", 2026-11-24 "A seeded property test found a money case…"

## 2026-11-27: Settle used the target where Home used `remainingCents`, so the card asked for $2.00 instead of $5.00  [area: money-math]
- What happened: Review R1 (blocking): when a pair's paid was ≤ 0 (spec case T13: B had sent A $3.00, then the shares reversed and A owes B a $2.00 target), `settleView` used the target for the card, the Venmo link and the cash button. Home used `remainingCents` and showed $5.00. Both read the same plan; they picked different fields. Fixed, with A-29b requiring every amount to equal `balanceFor` and the "You owe N people" heading.
- Why (root cause): The sixth "same rule decided in two places" (2026-11-22, 2026-11-24, 2026-11-25 ×2, 2026-11-27). Here the rule was "which amount is owed on this route", and each screen chose it again from the plan's fields. The lib tests for T13 passed; nothing compared the two screens' amounts on T13.
- Fix / rule: The amount a person is asked to pay comes from one lib function (`balanceFor` / `remainingCents`), and every surface that shows or sends it (card, payment link, cash button, Request row, Home) reads that one value. A test runs the spec's worked examples (T0–T13) through every view model and checks they agree. Evidence added to the pending `2026-11-25-one-status-source-per-screen.md` (Change 3, the reviewer check for a rule decided in two places).
- Source: R1 (round 1) in review of docs/specs/2026-11-26-who-paid.md; A-29b in A2.6; T13 in A1.2

## 2026-11-27: Undo read the mark toward the lead payer only, so undo to a co-payer did nothing  [area: expo]
- What happened: Review R2 (blocking): `sentCheckUndo` and `useVenmoSend` looked up the participant's mark toward the lead payer. With several payers, "No, undo" on a payment to a non-lead co-payer found nothing and silently did nothing. A-43b now requires undo (inline, from the notification, and the late-send clearing) to delete exactly that pair's payment.
- Why (root cause): The code was written when a bill had one payer, and the multi-payer change replaced the payer in the model but not every lookup that assumed "the payer". The groups v2 rule put "is the viewer the payer" in one helper, but these lookups were by pair, outside it.
- Fix / rule: When a model goes from one of something to several (one payer → several), grep for every place that picks the single one (`payer_id`, `lead`, `[0]`, `find(` on payers) and either key it by the pair the person acted on or list why one is right. A test acts on the non-first one. First occurrence; log only.
- Source: R2 (round 1) in review of docs/specs/2026-11-26-who-paid.md; A-43b in A2.6

## 2026-11-27: Async endings, eighth time: no time limit on the page, and a timed-out write could commit late  [area: expo]
- What happened: Round 1 R5: the Who paid page's fetch and save had no time limit (A-50(h) added 15 s). Round 2 R1: a write that timed out could still commit afterwards, because `within` stops waiting but doesn't cancel the request; the late answer was unhandled. R2: `clearLateSend` had no time limit and no message. The reviewer counted R2 as the seventh time for this lesson.
- Why (root cause): The applied rule in `implementer` says "any await … has a time limit", but nothing says what a time limit means for a write: the request keeps going, so after a timeout the outcome is unknown, not failed. `product-engineer` still doesn't have the async-endings rule at all (Change 3a of `2026-11-24-product-engineer-refetch-and-copy.md`, pending since 2026-11-24). Clean-up calls (`clearLateSend`) were treated as fire-and-forget.
- Fix / rule: A timed-out write is "outcome unknown": the screen says it may have saved, refetches before it allows a retry (or the retry is idempotent by client id, as GR-RV-2 did), and the late answer is caught and only triggers that refetch. Clean-up and background calls get the same time limit and a message when they fail. Tests use a fake that answers after the timeout. Promoted: new `2026-11-27-late-answers-and-one-tap.md` (implementer, product-engineer, code-reviewer).
- Source: R5 (round 1), R1 and R2 (round 2) in review of docs/specs/2026-11-26-who-paid.md; A-50(h); earlier async lessons 2026-11-21, 2026-11-22, 2026-11-24 ×2, 2026-11-25, 2026-11-27 ×2

## 2026-11-27: A double tap sent two saves and two `router.back()`s, and a push had no guard  [area: expo]
- What happened: Round 1 R4: a double tap on the payers page's confirm sent two calls and went back twice. R8: the `router.push` that opens the page had no double-tap guard, so it could be pushed twice. A-50(g) and (j) now require one call, one back and one push.
- Why (root cause): The third and fourth time a repeated action got through (2026-11-24 R7 no guard on Pay, 2026-11-27 "Settle was pushed twice"). The 2026-11-27 entry said to log only and name the case if it recurred; it recurred in the next task. A busy flag in React state doesn't stop a second tap in the same tick.
- Fix / rule: Any control that writes or navigates ignores repeat taps while its action is in flight, using a ref set synchronously (not only state), with a test that taps twice in the same tick and expects one call and one navigation. Promoted with the async entry above in `2026-11-27-late-answers-and-one-tap.md`.
- Source: R4, R8 (round 1) in review of docs/specs/2026-11-26-who-paid.md; A-50(g), (j); lessons 2026-11-24 "Waiting for the refetch…" (R7), 2026-11-27 "Copy said 'paid' for a send, and Settle was pushed twice"

## 2026-11-27: Home's kept plan survived a change of co-payers, sixth time for kept state  [area: expo]
- What happened: Round 1 R11: Home kept a settle plan from an earlier read and dropped it only when the lead payer changed. When only the co-payers changed, the stale plan stayed.
- Why (root cause): The groups v2 fix (2026-11-27 "Kept settle facts outlived the payer…") compared the one payer, written before a bill could have several. The deciding fact is now the whole payer set and their amounts. Change 2b of the refetch proposal names "the payer", singular.
- Fix / rule: Kept data is checked against every deciding fact, and with several payers that's the full payer list and amounts (or the payers version), not the lead. Evidence added to `2026-11-24-product-engineer-refetch-and-copy.md` with a one-word rewording of Change 2b ("the payer" → "the payers and their amounts").
- Source: R11 (round 1) in review of docs/specs/2026-11-26-who-paid.md; the five earlier kept-state entries listed in that proposal

## 2026-11-27: A user-requested page replaced the planned sheet, and its criteria didn't come with it  [area: testing]
- What happened: Another session built the Who paid page at the user's request; A2 replaced the sheet (D7, A1.5) with it and dropped the sheet's criteria without writing new ones. Review R3 found the page had almost no router tests; R12 found no test for the stateful `ownPayerChange` module and R13 no test for the flags read. Review round 1 then wrote A-50(a)–(j), and QA's one failure (A-50(c)) was in that new list.
- Why (root cause): The third "requirement without a criterion" (2026-11-25, 2026-11-27). This time it was an amendment: replacing a design removed its criteria, and a page built outside the plan had none to start with. Builders and QA test against criteria, so the page had nothing to be held to until review.
- Fix / rule: An amendment that replaces a design (a sheet becomes a page) replaces its criteria in the same amendment, mapping each old criterion to a new one or marking it dropped with a reason. Work built outside the plan gets criteria before review. Added as Change 4 of `2026-11-27-every-requirement-has-a-criterion.md`.
- Source: R3, R12, R13 (round 1) in review of docs/specs/2026-11-26-who-paid.md; A2.1, A2.6

## 2026-11-27: A peer session edited this session's files for a user request without announcing it  [area: process]
- What happened: Session 0b built the user-requested Who paid page and changed two copy strings (`undoAllText`, the Home `paid_back_due` pill) inside files this session had claimed, without telling this session first. That broke the committed regression fixture `lib/__fixtures__/settle-single-payer.json`. (This is the same copy change that the Groups retro logged as "nobody claimed"; the owner turned out to be 0b.) The user confirmed both changes afterwards, and A2 records them.
- Why (root cause): The sixth cross-session break (2026-11-25, 2026-11-27 ×4). The ownership rules say who owns a file and how to send a fix, but not that a session acting on a direct user request must still announce before editing another session's claimed files. A user request feels like enough authority, but it doesn't tell the owner, whose tests and fixtures then break.
- Fix / rule: Before editing a file another active session has claimed, announce it to that session (file, change, why, and whether the user asked for it) and wait for an answer, even for a user-requested change. The editing session greps the tests and fixtures that assert what it changes and lists them in the announcement. Added as Change 8 of `2026-11-25-build-task-shared-files-and-served-backend.md`.
- Source: process incident; A2.1–A2.2 in docs/specs/2026-11-26-who-paid.md; lesson 2026-11-27 "A copy change nobody claimed broke another session's committed fixture"

## 2026-11-27: An agent restored a shared file from a 20-second-old backup during a positive control  [area: process]
- What happened: To show a test could fail, an agent broke `app/(app)/bills/[id]/index.tsx`, ran the test, then restored the file by copying back a backup taken 20 seconds earlier. Other sessions were editing that file at the time. Nothing was lost, but any edit made in those 20 seconds would have been silently overwritten.
- Why (root cause): The third whole-file overwrite of a shared file by an agent (2026-11-25 Prettier over an untracked file, 2026-11-27 a scripted rewrite the permission check denied). Positive controls are required by `qa-tester` and the absence-assertion proposal, but nothing says how to do one safely in a shared tree. Copying a backup back restores everyone's file, not just your change.
- Fix / rule: Never restore a shared file by copying a backup, `git checkout`, `git stash` or a scripted rewrite. Do mutation and positive-control checks in a scratchpad copy of the repo, or make the change as one exact-string edit and undo it with the reverse exact-string edit right after, then confirm the diff shows only your intended changes. Promoted: new `2026-11-27-no-whole-file-restores.md` (implementer, product-engineer, qa-tester, build-task).
- Source: process incident during docs/specs/2026-11-26-who-paid.md; lessons 2026-11-25 "The designer ran Prettier over a whole untracked file…", 2026-11-27 "Five sessions shared the bill screen…"

## 2026-11-27: The main session served the hosted backend for an hour, because the root `.env` now points at hosted  [area: process]
- What happened: The main session restarted the web dev server on :8081 with a plain start, not noticing that the root `.env` now points at the hosted Supabase project. A separate :8082 server had the local values. When the user asked for one server, the main session killed :8082, which was the local one. The user's app talked to the hosted project for about an hour, until another session flagged it. Fixed by restarting with `EXPO_PUBLIC_SUPABASE_URL` and the publishable key passed inline from `supabase status`, then checking the URL in the served bundle.
- Why (root cause): The third hosted-server mismatch shown to the user (2026-11-24 QA, 2026-11-25 main session, now). The check is still only in pending proposals (`2026-11-25-build-task-shared-files-and-served-backend.md` Change 1, `2026-11-27-one-web-dev-server.md`), so the main session had no rule. New parts: a plain `npm run web` is now hosted by default, and consolidating servers means choosing which to kill, which needs the same check.
- Fix / rule: Every start or restart of the web dev server passes the local URL and key inline, and is followed by a check of the Supabase host in the served bundle before anyone uses it. Before stopping any server (for example to keep only one), check which backend each one serves and keep or recreate the local one on :8081. Added as Change 3 of `2026-11-27-one-web-dev-server.md` (with a CLAUDE.md note that the root `.env` may point at hosted).
- Source: main-session process during docs/specs/2026-11-26-who-paid.md; lessons 2026-11-24 "Checks ran against an environment…", 2026-11-25 "The dev server shown to the user pointed at the hosted project, again", 2026-11-27 "User wants one web dev server…"

## 2026-11-27: The main session's handoff restated a spec decision wrongly (shareCents vs owesCents)  [area: process]
- What happened: The main session told the X2 agent to use `shareCents` for "Your share", which contradicts spec D10 (`owesCents`). It wasn't caught at handoff; it was logged afterwards as WP-X2-1.
- Why (root cause): The handoff paraphrased the spec's money field from memory instead of quoting it. An agent follows the handoff over the spec when they differ. The earlier handoff lessons (docs handoff too narrow, four times) were about missing items, not wrong ones.
- Fix / rule: A handoff names the spec section and decision ids (D10, contract O) and quotes field names and amounts from the spec, never restates them from memory. The agent is told the spec wins where they differ, and reports any difference it sees. First occurrence of a contradicting handoff; log only.
- Source: main-session process; WP-X2-1; D10 in docs/specs/2026-11-26-who-paid.md

## 2026-11-27: A deliberate copy change in a "never regenerate" fixture: targeted substitution, proved byte-identical in reverse  [area: testing]
- What happened: The two confirmed copy changes had to go into `lib/__fixtures__/settle-single-payer.json`, which must never be regenerated. They were applied as a targeted substitution of exactly those strings, and a reverse substitution produced a file byte-identical to the pre-edit copy, proving nothing else changed. Review R14: the spec first said 112 strings; the real count was 168 in 56 cases (the a11y hints were missed).
- Why (root cause): The method worked. The count was estimated from one kind of string instead of grepped.
- Fix / rule: To change a frozen fixture on purpose: substitute only the named strings, prove it with a reverse substitution that is byte-identical (`cmp`) to the original, and record the grepped count per string in the spec. Log only.
- Source: A2.2 and R14 (round 1) in review of docs/specs/2026-11-26-who-paid.md

## 2026-11-27: Who-paid review smaller items: a migration without begin/commit, before-production stale, a wrong back label  [area: process]
- What happened: Round 1 R6: migration 140002 had no explicit `begin;`/`commit;`, unlike 140000 and 140001; the CLI was checked and adds none, so a failure halfway would leave it partly applied. R7: `docs/before-production.md` was out of date at review. R9: the page's back control was labelled for one entry route; it opens from the bill screen and Settle, so it now reads "Back" (WP-R9).
- Why (root cause): R6: no rule for migration framing, and three migrations in one task were written differently. R7: the third time the checklist lagged the work (2026-11-21, 2026-11-27 "Risks the spec already named…"), though `CLAUDE.md` says same task. R9: the label assumed one entry route.
- Fix / rule: Every migration wraps its statements in `begin;` … `commit;` (the Supabase CLI adds no transaction). `docs/before-production.md` is updated in the task that creates the risk, and the reviewer checks it. A back label names the previous screen only if there's one way in. Log only; promote R6 to `supabase-engineer` if it recurs.
- Source: R6, R7, R9 (round 1) in review of docs/specs/2026-11-26-who-paid.md

## 2026-11-27: Cross-session coordination worked again: claims, migration announcements, one full suite at a time  [area: process]
- What happened: Sessions claimed files up front, announced migrations before applying them, ran one full Jest suite at a time across sessions, and flagged failures they saw in each other's areas. The other session caught the hosted-backend mistake.
- Why (root cause): The pending coordination rules (`2026-11-25-build-task-shared-files-and-served-backend.md` Changes 4–7) were followed by hand. The gaps were in the parts those rules don't cover yet: announcing before editing a claimed file, and whole-file restores.
- Fix / rule: Keep it up. Evidence for that proposal; it's now carrying eight changes from six retros, so applying it is the main lever for cross-session problems.
- Source: process notes, docs/specs/2026-11-26-who-paid.md

## 2026-11-27: User's choices from Who paid  [area: money-math]
- What happened: The user chose a separate Who paid page over the planned sheet (built by 0b, confirmed here), kept both of 0b's copy changes ("$X payment didn't go through"; "You are owed $X"), asked for one Venmo/Cash chooser per card, and for a person who owes two payers: "just give two venmo links for this, we should support it". Product defaults decided in review: a % row that rounds to $0.00 is refused (WP-R10), and the back control reads "Back" (WP-R9).
- Why (root cause): The user's product direction.
- Fix / rule: Keep these. Someone who owes several payers gets one card and one payment link per payer, each with its own method chooser. Log only.
- Source: user decisions during docs/specs/2026-11-26-who-paid.md (A2.1, A2.2, A2.6)

## 2026-11-28: The main session ran Prettier over all of settle.tsx, the second whole-file format  [area: process]
- What happened: The main session ran `npx prettier --write` on `app/(app)/bills/[id]/settle.tsx`. The repo has no Prettier config, so Prettier used its defaults and reformatted the whole file to 80 columns. It was recovered by running Prettier again with `--print-width 140 --single-quote`, which matches the repo's usual style, but a few long lines that had been kept by hand were lost.
- Why (root cause): The second time (2026-11-25, the visual-designer on `profile.tsx`). The rule from the first time is only in pending agent proposals (`2026-11-25-visual-changes-keep-behavior.md` Changes 4/5, `2026-11-27-no-whole-file-restores.md`), and those target agents. The main session reads `CLAUDE.md`, which says nothing about formatting. With no config, any formatter run reformats every line, not just the changed ones.
- Fix / rule: Never run a formatter (Prettier, `eslint --fix`, codemods) over an existing file in this repo. Edit only the changed lines, in the file's style. If formatting is needed, run `npx prettier --print-width 140 --single-quote --write` on new files only. Promoted to `CLAUDE.md` § Conventions: `2026-11-28-claude-md-no-formatter.md`.
- Source: user correction during docs/specs/2026-11-28-usernames.md; lesson 2026-11-25 "The designer ran Prettier over a whole untracked file, with no way to restore it"

## 2026-11-28: The first PM brief was for the whole usernames feature; the user wanted only the groundwork  [area: process]
- What happened: The main session briefed the product-manager for the full feature: the required username gate, an editor and pickers. The user narrowed it mid-spec: "just create the framework to allow for it to happen ... like creating username, we will implement the feature later dont deep dive into it". The brief had to be redirected, and the spec now has a scope note and a **Later** section.
- Why (root cause): The brief read the request as the whole feature, not the smallest slice the user's words supported. "Build without blocking" covers product details inside a scope. It doesn't cover the scope itself, which is the user's call.
- Fix / rule: When a request could mean groundwork or the whole feature, the brief takes the smallest reading and names the rest as **Later** in one line each, so the user can pull more in. A scope the user narrows is quoted word for word at the top of the spec, as was done here. First occurrence; log only.
- Source: user correction during docs/specs/2026-11-28-usernames.md (scope note)

## 2026-11-28: A handle builder's degenerate input: an all-underscore base  [area: testing]
- What happened: Review R1: `withNumberSuffix` could return a handle under 3 characters for a base like `___`, because it trimmed trailing `_` after cutting to length. The fix trims a trailing `_` only if 3 or more characters are left, and contract S was amended. QA then found `withNumberSuffix('___', 9999)` gives `9999`. That passes V, but the base is gone. R4: it now throws on an invalid base.
- Why (root cause): The S table and criterion 16 tested ordinary names, a 20-character base and several `n` values. They didn't test a base made only of the characters the function trims, though UN-4 and B22 make `___` a valid handle. This is the string version of the degenerate cases already logged for money (2026-11-24 ×2).
- Fix / rule: When a function cuts or trims user input, the spec's example table includes an input made only of the characters it trims, the shortest valid input, and the longest base with the largest suffix, each with its expected output. Whether `9999` is an acceptable handle for a `___` base is open (Q2 covers all-underscore handles) and belongs to the gate's spec; the main session should log it in `docs/decisions-to-review.md`. Log only.
- Source: R1, R4 in review and QA edge note, docs/specs/2026-11-28-usernames.md

## 2026-11-28: Usernames review nits: literal combining marks in a regex, and EXECUTE left with service_role  [area: rls]
- What happened: R2: a regex that strips combining marks had the marks as literal characters. They're invisible in an editor and in a diff, and easy to lose when a file is reformatted. They're now `\u` escapes. R3 (not changed): `service_role` probably keeps EXECUTE on `set_username`. That's harmless, because `service_role` already bypasses RLS and the function isn't used in a CHECK.
- Why (root cause): R2 is the same family as 2026-11-25 "Text sent to another app: code points aren't characters". R3: the explicit-grants rule is written for `anon`/`authenticated`/`public`; whether `service_role` should be revoked on new functions isn't stated (2026-11-27 showed a CHECK function needs it).
- Fix / rule: Invisible, combining or control characters in source code are written as `\u` escapes, never literally. Log only. R3 doesn't need a rule yet.
- Source: R2, R3 in review of docs/specs/2026-11-28-usernames.md

## 2026-11-28: Root `.env` Google variables, tenth report  [area: expo]
- What happened: QA saw `npx expo-doctor` list two non-`EXPO_PUBLIC_` variable names in the root `.env` (the Google OAuth client id and secret). `CLAUDE.md` says they belong in `supabase/.env`.
- Why (root cause): A user action, still not done. The change that makes this a one-line report is still pending.
- Fix / rule: No new rule. Added as evidence to `2026-11-24-bundle-checks-jest-setup-tracked-items.md` (Change 5). Moving the variables is the user's step.
- Source: QA report, docs/specs/2026-11-28-usernames.md; nine earlier reports

## 2026-11-28: Shared local DB across live sessions: the coordination steps worked, and the reserved ADR stub held  [area: process]
- What happened: Several live Claude sessions shared the local database and the test slots. Announcing before `migration up`, never running `db reset`, running Jest and pgTAP one file at a time, and asking the other sessions for the full-suite slot all worked. pgTAP passed 94/94 for usernames and 2101 across 31 files afterwards; the live smoke passed 24/24, including the two-user race. ADR 0026 was reserved as a stub on disk up front, and nothing collided. Two things differed from the written rules: the main session gave the PM a migration timestamp at spec time (build-task says timestamps are taken when the migration file is created; the spec reduced the risk by drafting the file in the scratchpad), and the full Jest suite wasn't run, only `lib/username` and `lib/profile` (134/134).
- Why (root cause): The applied ADR-stub rule (`2026-11-25-reserve-numbers-across-sessions.md`) works across sessions. The other steps are still only in the pending `2026-11-25-build-task-shared-files-and-served-backend.md`, so they were followed by hand. The task touched only `lib/` and a migration, so the targeted Jest run covered what changed.
- Fix / rule: Keep doing this. Follow the applied rule on timestamps: take the migration timestamp when the file moves into `supabase/migrations/`, not at spec time, so it sorts after every migration another session applied in the meantime. When a task skips the full Jest suite, QA says so and lists which files ran, as was done here. Log only; more evidence for the pending build-task proposal.
- Source: process notes, docs/specs/2026-11-28-usernames.md

## 2026-11-28: A "dry run" committed a migration to the shared local DB  [area: supabase]
- What happened: To time a dry run of `20261128100019_username_required.sql`, an agent piped `echo '\timing on'` plus the script into psql. zsh's `echo` turned `\t` into a tab, psql rejected that first line, and the error swallowed the script's `begin;`. Everything after ran in autocommit, so the final `rollback` undid nothing. For about 2–3 minutes the shared DB had `username` NOT NULL, a new trigger, a changed `handle_new_user`, backfilled usernames and ~10,000 throwaway users. The agent reverted it in one transaction; the main session verified the revert (column nullable, 0 usernames, 0 fixtures, `handle_new_user` md5 unchanged, last migration unchanged) and told every live session.
- Why (root cause): A dry run that depends on shell quoting has no guarantee its transaction ever opened. `echo` behaves differently across shells (zsh interprets backslash escapes).
- Fix / rule: Dry runs go through a file: `psql -v ON_ERROR_STOP=1 -f dryrun.sql`, with `begin;` as the file's first statement and `rollback;` as its last (or against a scratch database). Never pipe SQL through `echo`. After any dry run, check `supabase_migrations.schema_migrations` and the objects it would create, so a leak is caught at once. If a shared DB was changed by mistake, revert in one transaction, verify, and tell every session the time window.
- Source: the username-required supabase-engineer report, docs/specs/2026-11-28-usernames.md Amendment A1

## 2026-11-28: A background test loop hung for over 2 hours, and the agent kept "waiting on background work"  [area: testing]
- What happened: During tab bar and Activity, one of our agents started a Jest loop in the background. It hung on `__tests__/activity.test.tsx` for over 2 hours, and the agent kept reporting that it was waiting on background work. Another session found the stuck process by its pid. The cause was a hang, not load (next entry).
- Why (root cause): The second background-work problem (2026-11-25 "An agent's report was lost twice while it still had background work"). Backgrounding a run removes the tool's time limit, and "wait for every background command to finish" (that entry's rule) has no upper bound, so a hang looks the same as a slow run. Load reports (2026-11-27, 340 s per file) made long waits seem normal.
- Fix / rule: Run tests in the foreground with the Bash tool's time limit set. If the full suite won't fit in one call, run it in chunks of paths. A run that passes its limit is treated as a hang: find the file by running files one at a time (or with `--detectOpenHandles`) and report it. Never wait on a background run without a deadline. Promoted: `2026-11-28-foreground-test-runs-with-limits.md` (CLAUDE.md § Commands).
- Source: process event (a), docs/specs/2026-11-28-tab-bar-and-activity.md; lessons 2026-11-25 "An agent's report was lost twice…", 2026-11-27 "Machine load made single test files take over 340 s"

## 2026-11-28: Other sessions' changes broke our tests three times, one as a hang under Jest  [area: testing]
- What happened: (1) Another session added `<StatusBar>` from `expo-status-bar` to `app/_layout.tsx` (Appearance setting). Under Jest it left native async work pending, so `activity.test.tsx` hung (the entry above). It was found by bisecting, and fixed with a global stand-in in `test-utils/jestSetup.ts`. (2) The theme started reading device storage, so our web-render tests needed storage mocks. (3) Snapshot parsing started requiring `money_fingerprint`. Our tests that used the shared `snapshotOf` fixture (`test-utils/groupSnapshotFixtures.ts`) kept passing; only the hand-built ones broke (next entry).
- Why (root cause): The seventh to ninth cross-session test breaks. The session that changed the root layout, the theme or the parser didn't run the tests that mount them. A native module that hangs under Jest is worse than one that throws: there's no error, only a run that never ends. `test-utils/jestSetup.ts` stands in for modules that throw (2026-11-24 PI-C-7), but nothing says a module used in the root layout needs one.
- Fix / rule: A native module rendered by a layout every screen mounts (`app/_layout.tsx`, `app/(app)/_layout.tsx`) gets a stand-in in `test-utils/jestSetup.ts` in the same change, whether it throws or hangs under Jest. Evidence added to `2026-11-24-bundle-checks-jest-setup-tracked-items.md` (Change 1 reworded to cover hangs) and to `2026-11-25-build-task-shared-files-and-served-backend.md` (Change 6).
- Source: process events (b), (c), docs/specs/2026-11-28-tab-bar-and-activity.md; lesson 2026-11-24 "Native modules that throw under Jest got one global stand-in…"

## 2026-11-28: Hand-built raw fixtures broke on a contract change; the shared fixture didn't  [area: testing]
- What happened: When snapshot parsing started requiring `money_fingerprint`, the tests that wrote raw snapshot rows by hand failed. Tests built through `snapshotOf` picked up the new field from one place and kept passing.
- Why (root cause): The second time (2026-11-25 review R6, "the tests built the 'opened' state by hand"). A raw literal copies a contract's shape into each test, so every contract change breaks each copy. A shared builder holds the shape once.
- Fix / rule: Tests build data through the shared builders in `test-utils/` (`snapshotOf`, `feedFixtures`, `groupFixtures`, `fakes`) or the app's own functions, not raw row literals. When a task adds a new shape that tests need, it adds or extends a builder there. Promoted: `2026-11-28-tests-use-shared-fixtures.md` (implementer, product-engineer).
- Source: process event (c), docs/specs/2026-11-28-tab-bar-and-activity.md; lesson 2026-11-25 "Review nits on tests: a hand-built state…"

## 2026-11-28: The live tab bar's badge reads broke 7 suites' call-log assertions  [area: testing]
- What happened: Review R1: the tab bar mounts on every tab screen, and its badge reads added RPC calls to the call logs that 7 router suites assert exactly. They were fixed with a `quietFeedBadges()` mock (`test-utils/tabBar.ts`).
- Why (root cause): A component in a shared layout runs inside every router test that renders under it. The spec planned the Home-ready signal change (Task 6) but not the extra calls, so the break showed up only in review.
- Fix / rule: When a task adds reads to a layout or a component every screen mounts, the same task ships a quiet mock in `test-utils/` and lists the tests that assert call logs (grep for the RPC names, as Change 6 of the shared-files proposal says for RPC changes). First occurrence of this kind; log only.
- Source: R1 in review of docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: Feed reads raced: a loadMore during a refresh, and badge reloads on every bill version  [area: expo]
- What happened: Review R2: a `loadMore` that answered during a refresh appended its page onto the new list and left a gap. R4: the badges reloaded on every bill version change, so a busy bill caused a burst of reads. Now there's a 2 s debounce.
- Why (root cause): The same family as 2026-11-27 "Group refetches could be superseded…": a later read starts and an older answer still lands. A paged list has two kinds of reads (refresh and next page), and the older one wasn't dropped. Version-triggered reloads had no rate limit.
- Fix / rule: In a paged list, a refresh supersedes any next-page read in flight (a generation counter), and a page from an older generation is dropped. Reloads triggered by realtime or version changes are debounced. Evidence added to `2026-11-27-late-answers-and-one-tap.md`, with one sentence for paged lists.
- Source: R2, R4 in review of docs/specs/2026-11-28-tab-bar-and-activity.md; lesson 2026-11-27 "Group refetches could be superseded…"

## 2026-11-28: The seen stamp was taken after the loads, and compared across clocks  [area: expo]
- What happened: Review R3: Activity's seen time was taken after the feed's loads finished, so an event that arrived during the load was marked seen without being shown. The device's clock was also compared with server `created_at` times, so skew could mark events seen or unseen wrongly.
- Why (root cause): "Seen" means "seen up to what was shown", and that's fixed when the read starts, not when it ends. Device and server clocks differ.
- Fix / rule: A seen or read watermark is taken before the read starts (or is the newest shown row's server time), never "now" after the read. Compare server times with server times. If a device time has to be compared with a server time, allow for skew. First occurrence; log only.
- Source: R3 in review of docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: Entry-route tests missed again: per-route tests for the new tabs  [area: testing]
- What happened: Review R5: the new routes lacked per-route tests (marking seen and badge refresh on each way into Activity, Groups and the bills). This is the entry-route lesson again.
- Why (root cause): The fifth occurrence (2026-11-19, 2026-11-24 ×3). The rule that would have caught it ("screen-open effects list their routes") is still only in the pending `2026-11-24-screen-open-effects-every-entry-route.md`. The applied wording covers "navigation and auth flows", not effects that run when a screen opens.
- Fix / rule: No new rule. Evidence added to that proposal, which is now the most-repeated pending testing rule.
- Source: R5 in review of docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: Review nits: expense titles, and one busy group forced "9+"  [area: expo]
- What happened: R6: expense titles in feed lines needed fixing. R7: under A1.1 ("a full page counts as at least"), one busy group's full page of events made the Activity badge show "9+" even when few unread lines involved you.
- Why (root cause): R7 (as read from the finding's summary; the retro didn't have the full text): the "at least" rule was applied to the raw event page, before the feed rule filtered it, so a full page of events that don't count still rounded the badge up.
- Fix / rule: An "at least N" bound counts only rows that pass the rule, and rounds up to the cap only when that count reaches the cap. Log only.
- Source: R6, R7 in review of docs/specs/2026-11-28-tab-bar-and-activity.md; Amendment A1.1

## 2026-11-28: Web keyboard failures again: chips lost focus, tabs ignored Enter/Space, the narrow bar overlapped  [area: expo]
- What happened: QA failed three web checks. (1) The Activity filter chips lost keyboard focus, because react-native-web's `ScrollView` rebuilt its tree when the `RefreshControl` was added or removed. (2) Tab bar items had `role=link` without an `href`, so the browser ignored Enter and Space. (3) The bar overlapped below about 300 px. It's now a compact icon-only bar there (FEED-47). All fixed.
- Why (root cause): The fifth and sixth react-native-web cases (2026-11-25, 2026-11-27 ×3) and the third narrow-width overlap. Jest renders don't show focus loss, keyboard activation or layout, and the browser-check rule is still only in the pending `2026-11-27-web-accessibility-in-the-browser.md`. QA did check in the browser and found all three, which shows that check works.
- Fix / rule: On web, keep a focused control's tree stable: don't add or remove a wrapper prop such as `RefreshControl` on a state change; render it always and toggle `refreshing`. A web control with a link role has an `href`, or it uses the button role. Evidence and one added sentence in that proposal's Change 1.
- Source: QA report (fail round), docs/specs/2026-11-28-tab-bar-and-activity.md; FEED-45, FEED-47

## 2026-11-28: QA checked the docs criteria before the docs task had run  [area: process]
- What happened: QA ran while Task 12 (docs and logs) hadn't started, so criteria 57–58 had nothing to check. Task 12 ran afterwards.
- Why (root cause): The second time QA failed on writing that wasn't done yet (2026-11-25 "QA failed only on missing Results-log rows"). build-task says docs that describe status run last, but not that QA waits for every task. With 12 parallel tasks, QA started when the code tasks were done.
- Fix / rule: QA starts only after every task in the spec has finished, docs tasks included. If the main session starts it early on purpose, it tells QA which criteria are "pending Task N" so they're reported as not run, not failed. Promoted: `2026-11-28-build-task-qa-after-all-tasks.md`.
- Source: QA report, docs/specs/2026-11-28-tab-bar-and-activity.md (criteria 57–58); lesson 2026-11-25 "QA failed only on missing Results-log rows"

## 2026-11-28: An agent ran Prettier on two untracked files, the third whole-file format  [area: process]
- What happened: An agent ran Prettier on two untracked files by mistake. The repo has no Prettier config, so it reformatted them, and with no git history they had to be rebuilt by hand.
- Why (root cause): The third time (2026-11-25, 2026-11-28 settle.tsx). The pending `2026-11-28-claude-md-no-formatter.md` allows Prettier on "new files", but in a shared tree "untracked" doesn't mean "created by me in this task": other sessions' new files are untracked too, and they're the files with no way back.
- Fix / rule: Never run a formatter on a file you didn't create in this task, and treat untracked files as someone else's unless you created them. Evidence and a narrower wording added to that proposal.
- Source: process event (e), docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: A relayed message conflicted with the user's direct instruction on storage  [area: process]
- What happened: The user first said "dont make db changes / if we need to store new values/columns dont do it", then clarified "i didnt mean a blanket no on db migration - i just didnt want two last seen fields". A message relayed from another session briefly conflicted with the user's direct instruction. The main session confirmed with the user directly, and U11 records the final rule.
- Why (root cause): The second relay case (2026-11-27 "User decisions arrived relayed through other sessions"). The pending rule says a relayed decision can guide design. It doesn't say what to do when a relay and the user's own words disagree.
- Fix / rule: When a relayed decision conflicts with what the user said directly, the user's direct words stand, and the main session asks the user. Evidence and one sentence added to Change 4 of `2026-11-24-delegated-decisions.md`.
- Source: process event (d), user corrections (g); U11 in docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: The design review before building changed the colours and caught a pressed-state clash, the sixth staged design  [area: process]
- What happened: Before any code, the design review changed dispute markers from red to light orange, made every read line neutral grey, and found that the settled row's `surfaceMuted` fill is exactly `ListRow`'s pressed colour. The fix (content opacity 0.7 while pressed) went into Contract M before coding. The user later approved the visuals as built.
- Why (root cause): A whole-plan design read before code paid off again (2026-11-24, 2026-11-25, 2026-11-27 ×3).
- Fix / rule: Keep doing it. Evidence added to `2026-11-24-staff-engineer-review.md`.
- Source: process event (f); U12, Contract M, FEED-20 in docs/specs/2026-11-28-tab-bar-and-activity.md

## 2026-11-28: User's choices from tab bar and Activity  [area: expo]
- What happened: The user limited colour to three cases ("only these 3 warrant colors … not too much color"): needs-you amber, money green and dispute light orange ("give it a light orange"), each only while a line is unread. Red stays for app errors. Groups-list hues are only for "claim" and "settled" (U10). The tab label is "Tabs". No per-user tracking state in the database ("i just didnt want two last seen fields"), so seen state is device-local, but migrations stay allowed when they're needed for correctness or privacy. The user approved the visuals as built: the solid teal selected chip (FEED-42), the teal badge on the selected tab, and the grey settled row (FEED-20).
- Why (root cause): The user's product direction.
- Fix / rule: Keep these. New UI uses colour only for these three meanings, as light tints. The storage rule is U11 as the user clarified it: no per-user tracking state in the DB; other migrations only with a stated need. Log only.
- Source: user corrections (g), U10–U12, FEED-20, FEED-42 in docs/specs/2026-11-28-tab-bar-and-activity.md
