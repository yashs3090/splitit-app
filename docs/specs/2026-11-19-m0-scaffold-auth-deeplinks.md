# M0: Expo + Supabase scaffold, auth, deep links

Date: 2026-11-19. Milestone: M0 in `docs/plans/bill-splitting-app-2026-11-19.md`.
Repos: `splitit-app` (Expo app) and `../splitit-backend` (Supabase).

> ## Note (2026-11-20): backend repo merged into `splitit-app/supabase/`
> M0 was built across two repos, and this spec is kept as written. Since then the user deleted `splitit-backend` and its Supabase files moved into this repo's `supabase/` folder ([ADR 0011](../learning/decisions/0011-single-repo.md)). Where this spec says `splitit-backend/supabase/...`, read `supabase/...`. Where it says to run `npm run db:start|db:stop|db:status|db:reset` or `npm test` in the backend, run `npx supabase start|stop|status|db reset` or `npx supabase test db` from the `splitit-app` root (Docker running). Google OAuth values go in `supabase/.env`; see `docs/setup/google-oauth.md`.

> ## ⚠️ Amendment A1 (2026-11-19, user decision): Google sign-in ONLY
> The user decided: **"only allow sign in with Gmail"**. No email code, no magic link (no email account to send from). This amendment **overrides** anything below that conflicts with it.
>
> **Backend (Task 1 changes)**
> - `[auth.external.google]`:
>   - `enabled = true`
>   - `client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"`
>   - `secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"`
>   - `redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"`, the local callback that also gets added in Google Cloud.
>   - `skip_nonce_check = false`
> - Apple stays `enabled = false` with its placeholders. It will be needed before App Store submission, because the guidelines require Sign in with Apple when Google sign-in is offered on iOS.
> - Turn off email sign-in: `[auth.email] enabled = false` (A1.1: `enable_signup` is a deprecated alias in CLI 3.2.0; don't set top-level `[auth] enable_signup = false`, which would block new Google users too). Remove the custom email templates and the `email_sent` rate-limit override; they're no longer needed.
> - `supabase/.env.example` lists the Google vars (and the Apple ones for later). `npm run db:start` must load `supabase/.env`. Document how.
> - `handle_new_user` should take the display name from Google's metadata: `full_name`, falling back to `name` (Google provides both). Keep the trim, truncation and blank-to-null handling.
>
> **App (Task 7 changes)**
> - `app/(auth)/sign-in.tsx` has a single **"Continue with Google"** button. There is no email field.
>   - **Web:** `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/' } })`. The session is picked up from the redirect (PKCE, `detectSessionInUrl: true`).
>   - **Native:** `signInWithOAuth({ provider: 'google', options: { redirectTo: Linking.createURL('/auth/callback'), skipBrowserRedirect: true } })`, then `WebBrowser.openAuthSessionAsync(url, redirectTo)`, then `supabase.auth.exchangeCodeForSession(code)` from the returned URL. Put this in `lib/oauth.ts` and unit-test the URL/code parsing. Native is [native, not verifiable now].
>   - Use `flowType: 'pkce'` in the Supabase client on both platforms.
>   - Errors (user cancelled, provider not configured, network) are shown as text. Never log tokens.
> - Home shows "Signed in as `<display name or email>`".
> - Pending-invite resume (Task 8) is unchanged: it fires when the session goes from null to signed in. That includes the web OAuth redirect landing on `/`, which is the same "cold start" path that criterion 30 covers.
>
> **Docs (Task 9 changes)**
> - `docs/setup/google-oauth.md` is a click-by-click guide for the user:
>   1. Google Cloud project.
>   2. OAuth consent screen (External, Testing mode, add your own Gmail as a test user).
>   3. A "Web application" OAuth client. Authorized JavaScript origin `http://localhost:8081`. Redirect URI `http://127.0.0.1:54321/auth/v1/callback`; later also the hosted `https://<project>.supabase.co/auth/v1/callback`.
>   4. Paste the ID and secret into `splitit-backend/supabase/.env`.
>   5. Restart Supabase.
>
>   Keep the Apple section of the existing checklist as "later".
>
> **Acceptance criteria changes**
> - **3:** replaced. `config.toml` has Google `enabled = true` with `env(...)` credentials, and `[auth.email] enabled = false`. No literal credentials appear (criterion 2 still applies).
> - **20b (new) [auto]:** `lib/oauth.ts` extracts `code` from a callback URL, handles `error`/`error_description` params, and returns null for unrelated URLs. All of this is unit-tested.
> - **22–26:** unchanged, but the "simulate signed-in" step is an auth state change from the mocked Google flow.
> - **25:** the sign-in screen renders a "Continue with Google" button and no email input.
> - **27:** [requires Docker + Google credentials + manual browser]. Open `/b/abcdefghij12` signed out, which goes to sign-in. Click Continue with Google, pick the test Gmail account, and you land on the stub for `abcdefghij12`. A `public.profiles` row exists with `display_name` = your Google name.
> - **28:** removed (there's no magic link).
> - **29–30:** unchanged, but they now need Google credentials too.

## Goal
An invitee who opens `/b/<code>` while signed out can sign in without a password and lands back on that invite, not on an empty home screen. This tests the riskiest technical assumption behind ADR 0004: that the invite survives sign-in. Everything else in M0 is the minimum scaffold needed to prove that.

## Environment constraints (read before starting)
- Node 20.19.5 and npm. The Supabase CLI runs through `npx supabase` (devDependency, v3.2.0).
- **Docker is not running.** Anything that needs `supabase start`, `supabase db reset` or `supabase test db` is tagged **[requires Docker]**. QA reports these as NOT VERIFIED (not FAIL) if Docker is still down.
- **No iOS simulator** (Xcode 14.3.1). We verify on Expo web (`npx expo start --web`, `npx expo export -p web`), with type-checks and Jest. Native-only behaviour is tagged **[native, not verifiable now]**.
- **QA has no browser tool.** Steps that need clicking in a browser are tagged **[manual browser]** for the user to run. The invite flow is also covered by Jest router tests so QA can verify it automatically.
- No Apple/Google credentials. Local auth uses **email OTP / magic link** delivered to the local Supabase mail catcher (Mailpit/Inbucket at http://127.0.0.1:54324).

## In scope
**splitit-backend**
- `supabase init`, with `config.toml` set up for local dev: auth redirect URLs for the Expo web origin and the `splitit://` scheme, email templates that include the 6-digit code, a local email rate limit high enough for testing, and Apple/Google providers present but **disabled** with `env(...)` placeholders.
- First migration: `public.profiles` (id, display_name, created_at, updated_at), a trigger that creates a profile on signup, and RLS (own row only).
- pgTAP tests for the profiles RLS and trigger.
- npm scripts and the `Commands` section of `CLAUDE.md`.

**splitit-app**
- Expo app (TypeScript, Expo Router), strict tsconfig, Jest (`jest-expo`), scheme `splitit`, and web output set to `single` (SPA; see Risks).
- `lib/env.ts`: reads and validates `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
- Supabase client with platform storage: `expo-secure-store` on native (chunked, because SecureStore values are size-limited) and `localStorage` on web.
- `lib/pendingInvite.ts`: pure, unit-tested code validation plus save/take with a TTL, using injected storage and clock.
- Sign-in screen (email, then a 6-digit code). Magic-link click-through works on web.
- Protected home (shows the signed-in email and a sign-out button).
- `app/b/[code].tsx`: saves the pending invite when signed out, resumes after sign-in, and shows a **stub** "You're joining bill `<code>`" screen. There is no real join yet.
- Router-level Jest tests for the invite flow.
- `Commands` section of `CLAUDE.md`, an Apple/Google setup checklist doc, and an update to the auth concept note.

## Out of scope (explicitly cut)
- **`join_bill` RPC and any bill tables.** These need the M2 schema. Writing a throwaway `bills` table now would mean migrating it twice. The `b/[code]` screen is a stub.
- **Working Apple/Google sign-in.** Only config placeholders and a checklist doc.
- **Universal links / App Links** (`https://splitit.app/b/...`, AASA, `assetlinks.json`). These need a domain and hosting. M0 uses the custom scheme `splitit://b/<code>` on native and the path `/b/<code>` on web.
- Native builds, EAS, app icons/splash, and store config.
- A hosted Supabase project. Local only.
- Display-name entry UI, payment handles (`venmo`/`paypal`/`cashapp` columns go in M3), avatars and account deletion (needed before launch, not M0).
- Co-participant profile visibility (M2 adds a policy once `bill_participants` exists).
- Analytics for the invite funnel. Noted in Risks; not built.
- Money math. M0 has none. No money-math criteria apply.

## Tasks
Order matters. Backend tasks 1 to 3 and app task 4 can run in parallel. Line counts exclude generated files (`create-expo-app` output, `supabase init` output, lockfiles).

### Task 1 (splitit-backend): init and auth config
- Run `npx supabase init`. Commit `supabase/config.toml` and `supabase/.gitignore`.
- Edit `supabase/config.toml`:
  - `[auth] site_url = "http://localhost:8081"`.
  - `additional_redirect_urls` includes `http://localhost:8081`, `http://localhost:8081/**`, `splitit://**` and `exp://**`. Nothing else, and no wildcard hosts.
  - `[auth.rate_limit] email_sent` raised for local testing (e.g. 30/hour; the default is very low) and commented as local-only.
  - `[auth.email.template.magic_link]` and `[auth.email.template.confirmation]` point to new templates `supabase/templates/magic_link.html` and `supabase/templates/confirmation.html`. Both include `{{ .ConfirmationURL }}` **and** `{{ .Token }}`, so OTP entry works whichever email a new or returning user receives.
  - `[auth.external.apple]` and `[auth.external.google]`: `enabled = false`, `client_id = "env(SUPABASE_AUTH_EXTERNAL_<PROVIDER>_CLIENT_ID)"`, `secret = "env(SUPABASE_AUTH_EXTERNAL_<PROVIDER>_SECRET)"`, with a comment pointing to the checklist doc (Task 9).
- `package.json` scripts: `db:start` (`supabase start`), `db:stop`, `db:reset` (`supabase db reset`), `db:status`, `test` (`supabase test db`). Remove the placeholder `test` script that exits 1.
- Add `supabase/.env.example` listing the four Apple/Google env vars with empty values. Make sure `.env` is gitignored.
- Files: `supabase/config.toml`, `supabase/templates/*.html`, `supabase/.env.example`, `package.json`, `.gitignore`.

### Task 2 (splitit-backend): profiles migration
- `npx supabase migration new init_profiles` creates `supabase/migrations/<timestamp>_init_profiles.sql`.
- `public.profiles`:
  - `id uuid primary key references auth.users(id) on delete cascade`.
  - `display_name text null`, with a check for length 1 to 50 when not null.
  - `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
  - **No email column** (privacy: profiles will later be readable by co-participants).
- `alter table public.profiles enable row level security;`
- Policies, all `to authenticated`, using `(select auth.uid())`:
  - select: `id = (select auth.uid())`.
  - update: `using (id = (select auth.uid())) with check (id = (select auth.uid()))`.
  - No insert policy and no delete policy. Rows are created by the trigger and removed by cascade.
- Trigger function `public.handle_new_user()`: `security definer`, `set search_path = ''`, inserts `(id)` into `public.profiles`. It may copy `raw_user_meta_data->>'full_name'` into `display_name`, truncated to 50 characters; it never copies email. Trigger `on_auth_user_created after insert on auth.users`.
- `updated_at` trigger on update.
- Revoke `execute` on `handle_new_user()` from `public`, `anon` and `authenticated`.
- Files: one migration file.

### Task 3 (splitit-backend): pgTAP tests for profiles
- `supabase/tests/database/profiles.test.sql`, using `begin; select plan(n); ... select * from finish(); rollback;`.
- Create users A and B by inserting into `auth.users`. Impersonate them with `set local role authenticated` and `set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}'`. Impersonate anonymous users with `set local role anon`.
- It must cover acceptance criteria 6 to 13. Every policy gets at least one "should be denied" case.
- Files: one test file.

### Task 4 (splitit-app): Expo scaffold
- `splitit-app` is not empty (README, CLAUDE.md, IDEAS.md, `.claude/`, `docs/`). Generate the app with `npx create-expo-app@latest` (default Expo Router + TypeScript template) **in a scratch directory and copy it in**, or use an equivalent that does not overwrite existing files. Then run the template's `reset-project` script, or delete the example screens/components by hand, so no demo code remains.
- Pin an Expo SDK whose minimum Node version is ≤ 20.19.5. If the latest SDK needs a newer Node, use the newest one that doesn't and note this in the PR summary.
- `tsconfig.json`: `"strict": true`, plus `noUncheckedIndexedAccess: true`, and the `@/*` path alias.
- `app.json`: `"scheme": "splitit"` and `"web": { "output": "single" }`.
- Jest with the `jest-expo` preset and `@testing-library/react-native`. Add one smoke test.
- `package.json` scripts: `test` (`jest`), `typecheck` (`tsc --noEmit`), `web` (`expo start --web`), `export:web` (`expo export -p web`).
- `.gitignore` covers `.env`, `.env.local`, `dist/`, `node_modules/`, `.expo/`.
- Files: generated scaffold, `tsconfig.json`, `app.json`, `package.json`, `jest.config.js` (or a `jest` key in `package.json`), `app/_layout.tsx`, `app/index.tsx` placeholder.

### Task 5 (splitit-app): env + Supabase client + storage adapters
- `lib/env.ts`: `readSupabaseEnv(input: { url: string | undefined; key: string | undefined })` returns `{ url, key }` or throws a clear error naming the missing variable.
  - It rejects a key that looks like a secret/service-role key: an `sb_secret_` prefix, or a JWT whose payload `role` is `service_role`.
  - It rejects a URL that is not http(s).
  - The call site must read `process.env.EXPO_PUBLIC_SUPABASE_URL` and `process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY` **as direct member accesses**, because Expo only inlines static references. Don't pass `process.env` as an object.
- `lib/env.test.ts`.
- `lib/chunkedStorage.ts`: pure `createChunkedStorage(backing, { chunkSize })`, which splits values across keys `<key>.0..n` with a `<key>.count` entry. `removeItem` deletes all chunks. Plus `lib/chunkedStorage.test.ts` using an in-memory fake.
- `lib/storage.native.ts`: `expo-secure-store` wrapped by `createChunkedStorage`. `lib/storage.web.ts`: `localStorage`, guarded with `typeof window !== 'undefined'`. Both export the same `{ getItem, setItem, removeItem }` async interface. Web must not import `expo-secure-store`.
- `lib/supabase.ts`: `createClient(url, key, { auth: { storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: Platform.OS === 'web' } })`. On native, wire `AppState` to `startAutoRefresh`/`stopAutoRefresh`, as in the Supabase Expo guide.
- `.env.example` with `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` and `EXPO_PUBLIC_SUPABASE_ANON_KEY=` (with a comment: paste the anon/publishable key from `npx supabase status`, **never** the secret/service-role key).
- Files: `lib/env.ts`, `lib/env.test.ts`, `lib/chunkedStorage.ts`, `lib/chunkedStorage.test.ts`, `lib/storage.native.ts`, `lib/storage.web.ts`, `lib/supabase.ts`, `.env.example`, `package.json` (deps).

### Task 6 (splitit-app): `lib/pendingInvite.ts` (pure, test-first)
- `normalizeInviteCode(raw: unknown): string | null`: trims, accepts `^[A-Za-z0-9_-]{10,64}$`, preserves case, and returns `null` for anything else.
- `savePendingInvite(storage, code, now: number): Promise<void>`: validates first and ignores invalid codes. Stores `{ code, savedAt }` as JSON under one constant key. The newest invite overwrites older ones.
- `takePendingInvite(storage, now: number, ttlMs = 24h): Promise<string | null>`: returns the code and **removes it** (one-shot). It returns `null` and removes the entry if the invite has expired, the JSON is corrupt, or the stored code no longer validates. It never throws, even if storage throws.
- `clearPendingInvite(storage)`.
- `postSignInRoute(code: string | null): '/' | \`/b/${string}\``: returns `/b/<code>` only for a valid code, otherwise `/`. There are **no free-form return URLs** anywhere in the auth flow, so there is no open redirect.
- `lib/pendingInvite.test.ts` covers acceptance criteria 17 to 19.
- Files: `lib/pendingInvite.ts`, `lib/pendingInvite.test.ts`.

### Task 7 (splitit-app): auth provider, sign-in, protected home
- `lib/auth.tsx`: `AuthProvider` + `useSession()` → `{ session, loading }`, driven by `supabase.auth.getSession()` and `onAuthStateChange`. It unsubscribes on unmount.
- `app/(auth)/sign-in.tsx`:
  - Step 1: an email field, then "Send code". This calls `signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo } })`, where `emailRedirectTo = Linking.createURL('/')`.
  - Step 2: a 6-digit code field, then `verifyOtp({ email, token, type: 'email' })`.
  - It shows errors (invalid code, rate limited, network) as text. It never logs tokens or the session.
- `app/(app)/_layout.tsx` (or Expo Router `Stack.Protected`): signed-out users are redirected to `/sign-in`. Signed-in users visiting `/sign-in` are redirected away (see Task 8 for where to).
- `app/(app)/index.tsx`: "Signed in as `<email>`" and "Sign out". Sign-out calls `supabase.auth.signOut()` **and** `clearPendingInvite`.
- Files: `lib/auth.tsx`, `app/_layout.tsx`, `app/(auth)/_layout.tsx`, `app/(auth)/sign-in.tsx`, `app/(app)/_layout.tsx`, `app/(app)/index.tsx`.

### Task 8 (splitit-app): `b/[code]` route + resume after sign-in
- `app/b/[code].tsx`:
  - Invalid code: "This invite link isn't valid" plus a link home. Nothing is stored.
  - Valid code and signed out: `savePendingInvite`, then `router.replace('/sign-in')`.
  - Valid code and signed in: call `clearPendingInvite` and render the stub "You're joining bill `<code>`. Joining arrives in M2." Keep it to one component so M2 replaces it in one place.
- Resume: when the session changes from null to signed in (OTP verify, or the magic-link redirect landing on `/` on web), run `takePendingInvite`, then `router.replace(postSignInRoute(code))`. Implement this in **one** place (the root layout or auth provider effect), not per screen.
- `app/__tests__/inviteFlow.test.tsx` using `expo-router/testing-library` `renderRouter`, with the Supabase auth module mocked and in-memory storage. It covers acceptance criteria 22 to 26.
- Files: `app/b/[code].tsx`, `app/_layout.tsx` (resume effect), `app/__tests__/inviteFlow.test.tsx`, possibly `lib/auth.tsx`.

### Task 9 (both repos): docs and commands
- `splitit-app/CLAUDE.md` `Commands`: install, `npm test`, `npm run typecheck`, `npm run web`, `npm run export:web`, and `.env` setup (from `npx supabase status` in the backend). Also note where to read OTP emails locally (http://127.0.0.1:54324).
- `splitit-backend/CLAUDE.md` `Commands`: `npm run db:start|db:stop|db:reset|db:status`, `npm test` (pgTAP, requires Docker), and `npx supabase migration new <name>`. Keep the existing lines.
- `splitit-app/docs/setup/oauth-apple-google.md`: a checklist for enabling Apple and Google later. Cover the Apple Developer membership, Services ID, key, and return URL; the Google Cloud OAuth client IDs (web, iOS, Android); the Supabase provider env vars from Task 1; the redirect URLs to add; and a reminder that Apple requires Sign in with Apple if Google is offered on iOS. Mark it as unverified until someone actually walks through it.
- `splitit-app/docs/learning/concepts/auth-and-deep-links.md`: add a short "How SplitIt does it (M0)" section covering the one-shot pending invite with TTL, the platform storage split, and why web uses SPA output.
- Files: the two `CLAUDE.md`, `docs/setup/oauth-apple-google.md`, `docs/learning/concepts/auth-and-deep-links.md`.

## Acceptance criteria
Tags: **[auto]** = QA can run it now. **[requires Docker]** = NOT VERIFIED while Docker is down. **[manual browser]** = the user clicks through it. **[native, not verifiable now]** = report NOT VERIFIED.

### Backend config
1. [auto] `splitit-backend/supabase/config.toml` exists. `additional_redirect_urls` contains exactly `http://localhost:8081`, `http://localhost:8081/**`, `splitit://**` and `exp://**`, and `site_url` is `http://localhost:8081`. (Check with grep.)
2. [auto] `[auth.external.apple]` and `[auth.external.google]` both have `enabled = false`, and their `client_id`/`secret` use `env(...)`. No literal credentials appear anywhere in the repo: `git grep -nE "(secret|client_id)\s*=\s*\"[^e]"` on `config.toml` returns nothing.
3. [auto] Both email templates exist and contain `{{ .Token }}` and `{{ .ConfirmationURL }}`.
4. [auto] `npm test` in splitit-backend no longer runs the placeholder `exit 1` script. It invokes `supabase test db`.
5. [requires Docker] `npm run db:start` then `npm run db:reset` applies all migrations with no errors.

### Backend RLS and privacy (all [requires Docker], via `npm test`, which must report all tests passing)
6. RLS is enabled on `public.profiles` (`pg_class.relrowsecurity = true`).
7. Inserting a user into `auth.users` creates exactly one `public.profiles` row with the same id.
8. User A can select their own profile (1 row).
9. User A selecting B's profile by id returns 0 rows. Selecting all profiles as A returns only A's row.
10. User A updating B's `display_name` affects 0 rows, and B's row is unchanged afterwards (checked as B or as superuser).
11. User A cannot insert a profile row (for B or for a random id). It is denied with SQLSTATE `42501`, or the insert affects 0 rows.
12. User A cannot delete their own or B's profile, and the `anon` role cannot read profiles. Since review fix R1 (explicit grants), both are denied with `42501` (no privilege) rather than returning 0 rows. Also: `anon` has no table privileges; `authenticated` has only SELECT plus UPDATE on `display_name`.
13. User A cannot change their own `id` to B's id (the update is rejected or affects 0 rows).
14. [auto] `public.profiles` has no `email` column, and the trigger function does not reference `email` (grep the migration). The function is `security definer` with `set search_path = ''`.

### App scaffold and config
15. [auto] In splitit-app, `npm run typecheck` exits 0 and `npm test` exits 0. `tsconfig.json` has `"strict": true`. `app.json` has `"scheme": "splitit"` and web `output: "single"`. No template demo screens remain (e.g. no `explore` tab).
16. [auto] With `.env` populated from `.env.example` (a dummy key is fine), `npm run export:web` exits 0. After that, `grep -rE "service_role|sb_secret_" dist/` returns nothing, and `grep -r "expo-secure-store" dist/` finds no SecureStore implementation code in the web bundle (a stub module name alone is acceptable; report what is found).

### Pure logic (Jest, [auto])
17. `normalizeInviteCode`:
    - Accepts a 10-character and a 64-character `[A-Za-z0-9_-]` code, and trims surrounding whitespace.
    - Rejects `""`, a 9-character code, a 65-character code, `"abc/../def12"`, `"abcdefghij%2F"`, a code with a space inside, a non-string (`undefined`, `123`), and a unicode code (`"ábcdefghijk"`).
18. Pending invite storage:
    - Save then take returns the code, and a second take returns `null`.
    - Saving B after A means take returns B.
    - Take after `savedAt + ttl + 1` returns `null` and the key is removed.
    - Take at exactly `savedAt + ttl - 1` returns the code.
    - Corrupt JSON returns `null` without throwing, and the key is removed.
    - A storage `getItem` that throws returns `null` without throwing.
    - Saving an invalid code stores nothing.
19. `postSignInRoute("abcdefghij12")` returns `/b/abcdefghij12`. `postSignInRoute(null)` and `postSignInRoute("https://evil.com")` return `/`.
20. `readSupabaseEnv` (env tests):
    - Throws, naming the variable, when either value is missing or empty.
    - Throws for a key starting with `sb_secret_` and for a JWT whose payload role is `service_role`.
    - Throws for a non-http(s) URL.
    - Accepts a local URL plus an anon-role JWT or an `sb_publishable_` key.
21. `createChunkedStorage`:
    - A value of 3x `chunkSize` round-trips intact.
    - `removeItem` leaves no `<key>.*` entries in the backing fake.
    - Overwriting a long value with a short one leaves no stale chunks.
    - A missing key returns `null`.

### Invite flow (Jest router tests, [auto])
22. Signed out, rendering `/b/abcdefghij12` ends on `/sign-in`, and storage holds a pending invite with code `abcdefghij12`.
23. With that invite stored, simulating a signed-in auth state change navigates to `/b/abcdefghij12`, shows the stub text containing the code, and leaves the pending invite cleared.
24. Signed out, rendering `/b/bad` shows the invalid-invite message, stores nothing, and does not redirect to `/sign-in`.
25. Signed out, rendering `/` redirects to `/sign-in`. A sign-in with no pending invite lands on `/` showing "Signed in as".
26. Sign-out clears both the session and any pending invite (checked through the storage fake).

### End to end on web ([requires Docker] + [manual browser])
27. With `npm run db:start` running and `.env` filled from `npx supabase status`, `npm run web`:
    - Open `http://localhost:8081/b/abcdefghij12` in a fresh profile. You are sent to sign-in.
    - Enter an email. The code arrives in Mailpit at `:54324`.
    - Enter the code. You land on the "joining bill abcdefghij12" stub.
    - A row exists in `public.profiles` for the new user.
28. Same as 27, but click the **magic link** in the email instead of entering the code. You end on the stub for the same code, even if the link opens in a new tab.
29. Reload the stub page after sign-in. You are still signed in (the session persisted to `localStorage`). Sign out, then reload `/`. You are on sign-in.
30. Open `/b/abcdefghij12` signed out, close the tab, then reopen `http://localhost:8081/` within 24h and sign in. You land on the stub (the invite survived a "cold start" on web).

### Native ([native, not verifiable now])
31. `splitit://b/abcdefghij12` opens the stub route on a device or simulator, and the session is stored through SecureStore. Report NOT VERIFIED until a simulator or device is available.

### Hygiene ([auto])
32. `git grep -nE "console\.(log|info|debug)\(.*(session|token|access_token|refresh_token)"` in splitit-app returns nothing.
33. Both `CLAUDE.md` `Commands` sections are filled in, and every command listed there is one QA actually ran (or is tagged requires Docker). `docs/setup/oauth-apple-google.md` exists.

## Risks / open questions
**Decisions for the user**
1. **OTP code vs magic link as the main sign-in UX.** The spec builds both: the code works everywhere and doesn't depend on email-link redirects, while the magic link is easiest on the same device. Which should the UI lead with? This affects drop-off (ADR 0004).
2. **Pending-invite TTL.** I set 24h. Shorter is safer on shared devices; longer helps people who sign up the next day.
3. **Invite code format.** M0 accepts `[A-Za-z0-9_-]{10,64}` so it doesn't block M2. The plan says ≥10 random characters and revocable. M2 should fix the exact alphabet and length (e.g. avoiding look-alike characters if codes are ever typed by hand).
4. **Web output `single` (SPA) vs `static`.** SPA avoids `localStorage` crashing during static rendering and keeps M0 small. The cost is that `/b/<code>` pages won't have server-rendered link previews (iMessage/WhatsApp cards) until we revisit this. Is that acceptable for now?
5. **Domain for universal links.** Does the user own `splitit.app` (or another domain)? Universal/App Links need it, and they're the plan's chosen invite mechanism.
6. **Apple Developer Program ($99/yr) timing.** It's needed for Sign in with Apple and for iOS builds. The user should decide when to buy it.
7. **Display name at sign-up.** M0 collects none. Should invitees be asked for a name before claiming (more friction), or should we default to OAuth `full_name` or the email's local part? This is relevant to M2.
8. **Guest claiming** (the open question in the plan's Phase 5) would change whether `/b/<code>` sits behind auth at all. It doesn't block M0, but we shouldn't add more auth-wall polish until it's decided.

**Technical risks**
- **Expo SDK vs Node 20.19.5.** The latest SDK may require a newer Node; Task 4 says to pin a compatible SDK.
- `create-expo-app` into a non-empty repo can clobber README or `.gitignore`. Task 4 says to generate in a scratch directory and copy.
- **SecureStore value size.** Supabase sessions can exceed what SecureStore handles reliably, hence the chunked adapter. It's untestable on device right now, and this lives in criterion 31.
- **Web token storage in `localStorage`** is readable by any XSS on our origin. It's acceptable for M0; revisit before the web launch (CSP, avoiding `dangerouslySetInnerHTML`).
- **Local email rate limits.** The default `email_sent` limit is tiny and will make QA's repeated sign-ins fail with 429s unless Task 1 raises it. The raised value must not be copied to the hosted project.
- **Auth flow type.** The spec relies on supabase-js defaults plus `detectSessionInUrl` on web. Native OAuth in the future will likely need PKCE plus an explicit code exchange on the deep-link callback. That's out of scope here, but it's noted in the OAuth checklist.
- **Funnel measurement** (invite opened → signed in → claimed) is the plan's key metric and isn't instrumented. It needs a decision on an analytics tool before the real-dinner tests.
