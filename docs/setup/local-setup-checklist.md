# Local setup checklist (Supabase + Google sign-in)

Tick each box only once its **Verify** step passes. Detailed click-by-click steps for Google are in [google-oauth.md](google-oauth.md). Run all commands from the repo root (`splitit-app/`).

## A. Tools
- [x] **Docker Desktop installed and running.** *(done 2026-11-20)*
  Verify: `docker info` prints server info (not "Cannot connect to the Docker daemon").
- [x] **Packages installed.** *(done 2026-11-20)* `npm install`
  Verify: `npx supabase --version` prints `3.2.0` or newer.

## B. Google Cloud (one-time)
Details: [google-oauth.md](google-oauth.md) §1–4.
- [ ] **Project created** at https://console.cloud.google.com/.
- [ ] **OAuth consent screen** set up in **Testing** mode, with your Gmail added as a **test user**.
  Verify: the consent screen page shows "Testing", and your email is under Test users.
- [x] **OAuth client** of type **Web application** created *(confirmed by the user 2026-11-20)*, with:
  - Authorized JavaScript origin: `http://localhost:8081`
  - Authorized redirect URI: `http://127.0.0.1:54321/auth/v1/callback` (exactly; `127.0.0.1`, not `localhost`)

  Verify: open the client under APIs & Services → Credentials and compare both values character by character.

## C. Secrets in the right file
- [x] **`supabase/.env` created** *(done 2026-11-20)* from the example: `cp supabase/.env.example supabase/.env`, then paste the Client ID (ends in `.apps.googleusercontent.com`) and Client secret (starts with `GOCSPX-`) into:
  ```
  SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...
  SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
  ```
  Verify: `git status --ignored supabase/.env` lists it under "Ignored files" (so it can never be committed).
- [x] **Google values removed from the app's `.env`** *(done 2026-11-20)* (the root one). It should hold only `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
  Verify: `grep -ci google .env` prints `0`.

## D. Local Supabase running
- [x] **Start it:** *(done 2026-11-20)* `npm run db:start` (first run downloads Docker images; takes a few minutes).
  Verify: it ends by printing the API URL `http://127.0.0.1:54321` and the keys. `npm run db:status` shows the same any time.
- [x] **Database built from migrations:** *(done 2026-11-20)* `npm run db:reset`
  Verify: it finishes with no errors and applies `20261119055012_init_profiles.sql`.
- [x] **Database tests pass:** *(done 2026-11-20)* `npm run db:test`
  Verify: `profiles.test.sql .. ok` and `Result: PASS` (45 tests).
- [x] **Google provider active in local Auth.** *(done 2026-11-20)*
  Verify: open http://127.0.0.1:54321/auth/v1/settings and check that `"google": true` and `"email": false` appear under `external`.

## E. App connected to local Supabase
- [x] **Root `.env` filled** *(done 2026-11-20)* from `npm run db:status`:
  - `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`
  - `EXPO_PUBLIC_SUPABASE_ANON_KEY=` the **anon / publishable** key. **Never** the service_role / secret key (`lib/env.ts` refuses it).
- [x] **Web sign-in works:** *(done 2026-11-20)* `npx expo start --web --clear`, open http://localhost:8081, then tap Continue with Google.
  Verify: you land back in the app signed in. Supabase Studio (http://127.0.0.1:54323) → Authentication shows your user, and Table editor → `profiles` has a row for you.

## F. Signing in on the iPhone (open problem)
- [ ] **Decide how the phone reaches Supabase.** `127.0.0.1` on the iPhone means *the phone itself*, not your Mac, so the local setup above only works for web on this Mac. Google also only allows plain `http://` redirect URIs for `localhost`/`127.0.0.1`, so the Mac's Wi-Fi IP won't work for the Google callback. Options:
  1. A free **hosted Supabase project for dev** (https URL, so Google is happy; costs nothing on the free tier).
  2. An **https tunnel** (e.g. ngrok or Cloudflare Tunnel) to the local stack.
  3. A **dev-only sign-in bypass** for testing the scan screen on the phone.

  The choice is the user's. Once decided, add the steps here.

## If something fails
- `server_error` on sign-in, and the auth log (`docker logs supabase_auth_splitit-app`) says `invalid_client: The provided client secret is invalid`: the secret in `supabase/.env` is wrong. Make a new one in Google Console (Client secrets → Add secret), paste it in without quotes, then **restart** (`npm run db:stop && npm run db:start`). Supabase only reads `supabase/.env` at startup.
- `redirect_uri_mismatch`: the redirect URI in Google doesn't exactly match `http://127.0.0.1:54321/auth/v1/callback`.
- `invalid_client` / "OAuth client was not found": `supabase/.env` still has the `replace-me` placeholders, or the stack wasn't restarted after editing it (`npm run db:stop && npm run db:start`).
- `Access blocked: app has not completed verification`: your Gmail isn't in the consent screen's Test users.
- App shows stale config: restart the dev server with `--clear` (`EXPO_PUBLIC_*` values are baked in at build time).
