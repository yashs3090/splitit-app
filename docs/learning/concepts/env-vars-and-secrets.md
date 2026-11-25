# Environment variables and secrets

## The idea
**Environment variables** are settings that live outside the code: URLs, API keys, feature flags. One codebase can then run against local, staging and production just by changing them. They usually come from a `.env` file that is **never committed** (it's in `.gitignore`). A committed `.env.example` lists the names with fake values, so people know what to fill in.

There are two very different kinds:

| | Server-side secrets | Client-side config |
|---|---|---|
| Examples | Google OAuth client **secret**, Supabase service-role key (and an Anthropic API key, if the shelved Claude fallback ever comes back) | Supabase URL, Supabase **anon/publishable** key |
| Where they live | `supabase/.env` (local, gitignored), the Supabase dashboard (hosted) | the app's `.env` at the repo root, as `EXPO_PUBLIC_*` |
| Who can see them | Only our servers | **Everyone.** They're compiled into the app |

## Why it matters here
In Expo, any variable named `EXPO_PUBLIC_*` is **inlined at build time**: the bundler literally replaces `process.env.EXPO_PUBLIC_SUPABASE_URL` with the string value. Anyone can download the web bundle or unzip the app and read it. That's fine for the anon key, because RLS protects the data ([row-level-security](row-level-security.md)). It would be a disaster for the service-role key, which bypasses RLS completely.

### Which `.env` is which
This repo has **two** `.env` files, read by different programs:
- **`.env` (repo root)** is read by Expo when it builds the app. It holds only `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`. Both are public by design: they get baked into the bundle. Copy `.env.example` and fill the key from `npx supabase status`.
- **`supabase/.env`** is read by the Supabase CLI when it starts the local stack. It holds `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`. Copy `supabase/.env.example`. Both files are gitignored.

Why the Google secret goes in Supabase's file: during sign-in, Google sends a one-time code, and **Supabase Auth** (running on Supabase's servers, not in our app) swaps that code for the user's identity using the client secret. The app never needs the secret, so it never gets it. Hosted, you paste it into the Supabase dashboard instead. See [Google OAuth setup](../../setup/google-oauth.md).

For local development you supply nothing else: the local stack generates its own keys and database password.

## How we use it
Our defenses:
- `lib/env.ts` refuses to start if the anon-key variable holds a secret key (`sb_secret_…` or a `service_role` JWT).
- The leak check after every web build: `grep -rE "service_role|sb_secret_" dist/` must print nothing.
- Secrets used by Supabase itself (like the Google client secret) go in `supabase/config.toml` as `env(NAME)` references, never literal values.

## Pitfalls
- **Stale values from the build cache.** Because values are baked in at build time, a cached build can keep an *old* value after you edit `.env`. QA hit this in M0. Our `export:web` script uses `--clear`. While the dev server is running, restart it after editing `.env`.
- Naming a secret `EXPO_PUBLIC_…` "just to make it work". That publishes it.
- Putting the Google values in the wrong `.env`. In the root `.env` they do nothing (Expo ignores names without `EXPO_PUBLIC_`), and the secret sits next to app config where it's easy to leak. They belong in `supabase/.env`.
- Pasting secrets into chat, issues or screenshots. Treat them as compromised and **rotate** them (generate a new one and revoke the old) if that happens.
- Assuming `.gitignore` protects a file that was already committed. It doesn't. Remove the file from git history and rotate the secret.
- AI tools can read files in your project. You can deny them access to `.env` files with permission rules (e.g. `Read(**/.env)` in Claude Code settings).

## Check yourself
1. Why is it OK for the Supabase anon key to be public, but not the service-role key?
2. You changed `EXPO_PUBLIC_SUPABASE_URL`, but the web build still calls the old URL. Why, and how do you fix it?
3. Where does the Google OAuth client secret live, and why not in the app?
4. You put the Google client ID in the root `.env` and sign-in says the provider isn't configured. Why?

## Learn more
- https://docs.expo.dev/guides/environment-variables/
- https://supabase.com/docs/guides/api/api-keys
