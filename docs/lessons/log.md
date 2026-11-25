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
