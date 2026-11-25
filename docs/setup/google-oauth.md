# Setting up Google sign-in (local dev)

SplitIt signs people in with Google only (spec M0, Amendment A1). This guide gets Google sign-in working against the **local** Supabase stack. Supabase's files live in the `supabase/` folder of this repo (`splitit-app`), and every command below runs from the **repo root** (the folder that has `package.json` and `supabase/` in it). It takes about 15 minutes.

> **Updated 2026-11-20:** the separate `splitit-backend` repo is gone; its Supabase files moved into `splitit-app/supabase/` ([ADR 0011](../learning/decisions/0011-single-repo.md)). Paths and commands below are for the single repo.

**Status: unverified.** Nobody has walked through these steps yet. Google's console layout changes often, so menu names may not match exactly. Steps marked **(unverified)** are written from Google's and Supabase's documentation rather than checked by clicking through them. If something differs, fix this file once you've finished.

What you'll end up with:
- A Google Cloud project with an OAuth consent screen in **Testing** mode, with your own Gmail as a test user.
- A "Web application" OAuth client whose **Client ID** and **Client secret** live in `supabase/.env`. That file is gitignored, so the secret is never committed and never reaches the app bundle.

Before you start, you need: Docker Desktop installed and running, and `npm install` already done in this repo. You do **not** need any Supabase keys or a database password for local development. The local stack generates its own when it starts. The only values you supply are the two Google ones from this guide.

### Two `.env` files, two jobs
This trips people up, so read it once:

| File | Read by | What goes in it | Secret? |
| --- | --- | --- | --- |
| `.env` (repo root) | Expo, when it builds the app | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | **No.** Public by design; baked into the app bundle |
| `supabase/.env` | The Supabase CLI, when it starts local Supabase | `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` | **Yes** (the secret) |

Why the Google secret goes in Supabase's file and not the app's: when someone signs in, Google sends back a one-time code. **Supabase Auth**, running on Supabase's servers (locally, in Docker), swaps that code for the user's identity, and it needs the client secret to do it. The app never touches the secret, so it never gets it. Anything in the root `.env` that starts with `EXPO_PUBLIC_` ends up readable by anyone who downloads the app. See [environment variables and secrets](../learning/concepts/env-vars-and-secrets.md).

Values you'll need (they match `supabase/config.toml`):

| What | Value |
| --- | --- |
| Authorized JavaScript origin | `http://localhost:8081` (the Expo web dev server) |
| Authorized redirect URI (local) | `http://127.0.0.1:54321/auth/v1/callback` (Supabase Auth on the local stack) |
| Authorized redirect URI (hosted, later) | `https://<project-ref>.supabase.co/auth/v1/callback` |

Type them exactly as shown. `127.0.0.1` and `localhost` are different hosts to Google. A one-character difference causes the `redirect_uri_mismatch` error.

## 1. Create a Google Cloud project (unverified)
1. Go to https://console.cloud.google.com/ and sign in with the Google account that should own the app.
2. Open the project picker in the top bar, then click **New project**.
3. Name it `SplitIt` (any name works). Leave the organization as "No organization" unless you have one. Click **Create**.
4. Make sure the new project is selected in the project picker before you continue.

## 2. Configure the OAuth consent screen (unverified)
Google now calls this area **Google Auth Platform**. Older guides call it **APIs & Services → OAuth consent screen**.

1. In the left menu (☰), go to **APIs & Services → OAuth consent screen**, or search the top bar for "Google Auth Platform". If you see **Get started**, click it.
2. **App information:** set App name to `SplitIt` and User support email to your Gmail. Click **Next**.
3. **Audience:** choose **External**. Click **Next**.
4. **Contact information:** enter your Gmail. Click **Next**, accept the policy, then click **Create**.
5. Open **Audience** (or the "Test users" section of the consent screen):
   - The publishing status should be **Testing**. Leave it there. In Testing mode, only the test users you list can sign in, which is what we want for now.
   - Under **Test users**, click **Add users**, enter your own Gmail address (plus any friends who will test), and click **Save**.
6. **Scopes / Data access:** you don't need to add anything. Supabase asks only for the basic `openid`, `email` and `profile` scopes. These are non-sensitive, so the app doesn't need Google verification while it's in Testing mode.

## 3. Create the "Web application" OAuth client (unverified)
1. Go to **Clients** (Google Auth Platform), or **APIs & Services → Credentials**. Click **Create client** (or **Create credentials → OAuth client ID**).
2. **Application type:** choose **Web application**. **Name:** `SplitIt local`.
3. Under **Authorized JavaScript origins**, click **Add URI** and enter `http://localhost:8081`.
4. Under **Authorized redirect URIs**, click **Add URI** and enter `http://127.0.0.1:54321/auth/v1/callback`.
   - When we create the hosted Supabase project, come back here and also add `https://<project-ref>.supabase.co/auth/v1/callback`.
5. Click **Create**. A dialog shows the **Client ID** (ending in `.apps.googleusercontent.com`) and the **Client secret**. Keep it open for the next step, or download the JSON.
   - Google may show the secret only once. If you lose it, open the client and add a new secret.

You need only this one Web client. The app opens Google in a browser on every platform, including the native flow through `expo-web-browser`, and Supabase Auth exchanges the code server-side with this client. Separate iOS and Android client IDs are needed only if we later switch to native Google sign-in SDKs. That is out of scope for M0.

## 4. Put the ID and secret in `supabase/.env`
1. In a terminal, go to the repo root:
   ```sh
   cd ~/Desktop/cs_projects/splitit-app        # or wherever you cloned it
   cp supabase/.env.example supabase/.env      # skip if supabase/.env already exists
   ```
2. Open `supabase/.env` in your editor and replace the two Google placeholders:
   ```
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<your client ID>.apps.googleusercontent.com
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=<your client secret>
   ```
   If the file has Apple lines, leave them empty.
3. Check that git ignores it: `git check-ignore supabase/.env` should print `supabase/.env`. If it prints nothing, stop and fix `.gitignore` before going further.
4. Never paste these values into `config.toml`, into the root `.env`, or into chat.

**If you put the Google values in the app's `.env` earlier, remove them now.** Open the root `.env` and delete any `SUPABASE_AUTH_EXTERNAL_GOOGLE_...` lines (or any line holding the client secret). When you're done, the root `.env` should have only two lines: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. They did nothing there (Expo ignores names without `EXPO_PUBLIC_`), but a secret sitting next to app config is easy to leak. If you ever named it `EXPO_PUBLIC_...`, or it ended up in a commit, chat or screenshot, treat it as leaked: in Google Cloud, open the client, add a new secret, delete the old one, and put the new one in `supabase/.env`.

How it gets loaded: `config.toml` refers to these variables with `env(SUPABASE_AUTH_EXTERNAL_GOOGLE_...)`. Each time the Supabase CLI reads `config.toml`, it loads `supabase/.env`, then `supabase/.env.local`, then your shell environment, with the shell winning over both. So `npx supabase start` needs no extra flags. This was confirmed in the CLI 3.2.0 source; an actual start with real credentials hasn't been run yet.

## 5. Restart Supabase
Auth reads its config only at startup. Make sure Docker Desktop is running, then from the repo root:
```sh
npx supabase stop
npx supabase start
```
The first `start` downloads Docker images and can take a few minutes. When it finishes it prints the local URLs and keys.

## 6. Try it (unverified)
1. Run `npx supabase status` from the repo root. Copy the **anon / publishable** key (not the secret or service-role key).
2. If you don't have a root `.env` yet: `cp .env.example .env`. Paste the key as `EXPO_PUBLIC_SUPABASE_ANON_KEY`. `EXPO_PUBLIC_SUPABASE_URL` should be `http://127.0.0.1:54321`.
3. Run `npm run web`. If it was already running, stop it and start it again, because `EXPO_PUBLIC_*` values are read at build time.
4. Open `http://localhost:8081/b/abcdefghij12` in a private window. You should land on sign-in.
5. Click **Continue with Google** and pick your test Gmail. You should land on the "joining bill abcdefghij12" stub.
6. Optional: check that a row exists in `public.profiles` with your Google name as `display_name`, using Studio at http://127.0.0.1:54323 → Table editor → `profiles`.

## Troubleshooting
- **`invalid_client` / "The OAuth client was not found"**: you still have the `replace-me` placeholders in `supabase/.env`. Paste the real client ID and secret (step 4), then restart (step 5).
- **`Error 400: redirect_uri_mismatch`**: the redirect URI on the Google client doesn't exactly match `http://127.0.0.1:54321/auth/v1/callback`. Check that it says `127.0.0.1`, not `localhost`, and has no trailing slash.
- **"Access blocked: SplitIt has not completed the Google verification process"** or **"…can only be used within its developer-approved users"**: the Gmail you picked isn't listed as a test user (step 2.5).
- **"Unsupported provider: provider is not enabled"**: Supabase was started before `supabase/.env` existed, the values are in the root `.env` instead of `supabase/.env`, or `enabled = true` is missing under `[auth.external.google]` in `supabase/config.toml`. Fix it, then restart with step 5.
- **`Cannot connect to the Docker daemon`** when running `npx supabase start`: open Docker Desktop, wait until it says it's running, and try again.
- **`npx supabase start` complains that `auth.external.google.client_id` is required**: `supabase/.env` is missing or the client ID is empty (step 4).
- **You land back on sign-in after Google**: check that `http://localhost:8081` is in `additional_redirect_urls` in `config.toml`, and that you opened the app on `localhost:8081`, not `127.0.0.1:8081`.

## Going to production later (not M0)
- Create the hosted Supabase project. Add its callback `https://<project-ref>.supabase.co/auth/v1/callback` to the same Google client, or to a separate production client.
- In the Supabase dashboard, go to **Authentication → Sign In / Providers → Google**, paste the client ID and secret, and set the Site URL and redirect URLs for the real domain. Hosted settings are separate from `config.toml`.
- Add the production web origin to **Authorized JavaScript origins**.
- To let anyone (not just test users) sign in, set the consent screen's publishing status to **In production**. With basic scopes only this shouldn't need a full Google review, but Google may ask for a privacy policy URL, a home page and domain verification (unverified).
- Don't copy local-only settings to the hosted project.

## Apple (later: required before App Store submission)
Apple's App Store Review Guidelines (4.8) require Sign in with Apple, or an equivalent privacy-focused option, when an iOS app offers a third-party login like Google. So Apple needs to be working before we submit to the App Store. In `config.toml` it is currently `enabled = false`, with `env(SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID)` and `env(SUPABASE_AUTH_EXTERNAL_APPLE_SECRET)` placeholders.

Checklist (unverified, do this when it's time):
- [ ] Join the Apple Developer Program ($99/yr). This is the user's decision on timing.
- [ ] Create an App ID for the iOS bundle identifier, with the **Sign in with Apple** capability.
- [ ] For web sign-in: create a **Services ID** (this becomes the OAuth `client_id`). Configure its domain and **Return URL** as `https://<project-ref>.supabase.co/auth/v1/callback`. Apple doesn't accept `http://` or `localhost` return URLs, so Apple web sign-in can only be tested against a hosted project.
- [ ] Create a **Sign in with Apple key** (`.p8`) and note the Key ID and Team ID.
- [ ] Generate the client secret, which is a JWT signed with the `.p8` key. It expires after at most 6 months, so put a reminder in the calendar to rotate it.
- [ ] Put the values in `supabase/.env` (locally) or the dashboard (hosted), set `enabled = true`, and restart.
- [ ] For native iOS, consider `expo-apple-authentication` with `signInWithIdToken`. The App ID or bundle ID must then be among the accepted client IDs.
- [ ] Native OAuth needs PKCE plus a code exchange on the deep-link callback. The app already uses `flowType: 'pkce'` (Amendment A1).
