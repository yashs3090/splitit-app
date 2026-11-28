# Vercel tooling for agents (machine setup)

Set up on 2026-11-24 by following Vercel's agent onboarding page (`https://vercel.com/get-started.md`). This is **tooling only**: nothing in this repo is linked to a Vercel project, and nothing has been deployed. Choosing Vercel to host the web build would be a separate decision (an ADR in `docs/learning/decisions/`), and the user makes it.

## What's installed

| Piece | Where | What it gives agents |
| --- | --- | --- |
| Vercel CLI 66.6.0 | global npm (`npm install --global vercel@latest`) | `vercel deploy`, `vercel env`, `vercel docs search`, `vercel kb search`, templates |
| Vercel plugin 0.56.0 (`vercel@claude-plugins-official`) | Claude Code, user scope | ~40 Vercel skills, `/vercel-plugin:*` commands, 3 agents, hooks, and the Vercel MCP server |
| Vercel MCP | added by the plugin, endpoint `https://mcp.vercel.com` | read Vercel docs, list teams/projects/deployments, read logs |

The guide says to install the plugin **or** the standalone `vercel-labs/agent-skills`, not both, so the standalone skills are not installed.

## Steps you finish yourself (sign-in)
1. **CLI:** run `! vercel login` (or `vercel signup` for a new account), then `vercel whoami` to check.
2. **MCP:** restart Claude Code, open `/mcp`, pick `vercel` (it shows as `plugin:vercel:vercel`), choose Authenticate, and finish the browser sign-in. Check the URL is exactly `https://mcp.vercel.com` before approving.
3. After that, an agent can confirm with the MCP tools `search_vercel_documentation` and `list_teams`.

MCP access equals your Vercel account's access. Keep Claude Code's confirmation on for any MCP call that changes something.

## Deploying SplitIt's web build to Vercel
`vercel.json` (repo root, added 2026-11-25) holds the build settings, so the dashboard's Build/Output/Install fields can stay empty:
- install `npm ci`, build `npm run export:web`, output `dist`, framework `null` ("Other").
- Every path except `/.well-known/…` rewrites to `/index.html` (single-page app), so `/b/<code>` doesn't 404. Real files in `dist/` are served first. `/.well-known/` is left out so a missing app-links file is a 404, not `index.html` (2026-11-26, [app links](app-links.md)); both well-known files are sent as `application/json`.
- App-links variables (optional, not `EXPO_PUBLIC_`): `APPLE_TEAM_ID` and `ANDROID_CERT_SHA256` make the build write `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. Leave them unset until the paid Apple account / signing keys exist ([app links](app-links.md)).
- Cache: `/_expo/static/*` (content-hashed) for a year; `/tesseract/*` and `/opencv/*` (names not hashed) for a day, then refreshed in the background for up to a week.
- `/tesseract/lang/*.gz` is sent as `application/gzip`, with no `Content-Encoding`, so the browser hands Tesseract the gzip bytes unchanged *(unverified on the live site: check a real scan)*.

Things specific to this repo that a default Vercel setup would get wrong:
- **Build through `npm run export:web`**, never a bare `expo export`. Its `preexport:web` hook copies the Tesseract/OpenCV assets; without them web scanning fails with "Couldn't load the text reader". Output folder is `dist/` (a single-page app, so all routes must rewrite to `index.html`).
- **`EXPO_PUBLIC_*` values are baked in at build time.** Set them as Vercel environment variables for the build. Only the Supabase URL and the anon/publishable key belong there; never the service-role/secret key (`lib/env.ts` refuses it anyway).
- **Run the leak check on the built output:** `grep -rE "service_role|sb_secret_" dist/` should print nothing.
- **Production Supabase and Google OAuth:** the hosted URL has to be added to Google's authorized origins and Supabase's redirect URLs. See `docs/before-production.md`.
- No server code: deploy `dist/` as static files only. No Vercel Functions (ADR 0010: the app plus Supabase only).
- `vercel deploy --temporary` gives a quick no-account preview with a claim link. Don't share the claim link.

## Friend-test deploy checklist (slice A1.1, added 2026-11-25)
Do these in order. `<vercel>` is the project's **Production** address, e.g. `https://splitit-xyz.vercel.app` (Vercel shows it once the project exists; it comes from the project name). `<ref>` is the hosted Supabase project's reference, the first part of `https://<ref>.supabase.co`.

1. **Push the migrations before the first deploy.** From the repo root: `npx supabase link --project-ref <ref>`, then `npx supabase db push`. The app reads tables and calls functions that only exist once every migration in `supabase/migrations/` is applied; without them Home shows "Couldn't load your bills." Then run the pgTAP tests against the hosted database (`docs/before-production.md` §4).
2. **Turn off Realtime "Allow public access"** in the Supabase dashboard (Realtime settings) *(the exact menu location is unverified: look under Project Settings → Realtime or Realtime → Settings)*. Our bill channels are private, and Supabase only enforces that once public access is off ([realtime](../learning/concepts/realtime.md)). Afterwards, check that someone who isn't on a bill can't listen to it.
3. **Supabase Auth URL configuration** (Authentication → URL Configuration):
   - **Site URL:** `<vercel>`.
   - **Redirect URLs:** `<vercel>/**` (web sign-in returns to `<vercel>/auth/callback`) and `splitit://**` (the phone app).
   - Preview deployments get a different address each time and sit behind Vercel's login, so friends use only the Production address. Don't add preview URLs.
4. **Google Cloud** (the OAuth client the hosted Supabase project uses):
   - **Authorized redirect URI:** `https://<ref>.supabase.co/auth/v1/callback`. Google redirects to Supabase, not to Vercel, so Vercel's address is not a redirect URI. Put the client ID and secret into the hosted project's Google provider settings in the Supabase dashboard, never into Vercel or the app.
   - **Authorized JavaScript origin:** `<vercel>` *(may not be needed, since Supabase runs the Google exchange; adding it is harmless)*.
   - **Test users:** while the consent screen is in "Testing", only listed Google accounts can sign in. Add each friend's Google address (Google Auth Platform → Audience → Test users *(menu names unverified)*). Google caps the number of test users *(unverified: check the current cap)*. Publishing the consent screen instead is a separate decision (`docs/before-production.md` §3).
5. **Vercel environment variables** (Project → Settings → Environment Variables, for Production). They're baked in at build time, so set them before the build, and **redeploy after any change**:

   | Name | Value |
   | --- | --- |
   | `EXPO_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the **publishable** key (`sb_publishable_…`) or the anon JWT. Never the secret / service-role key: it would ship to every browser (`lib/env.ts` refuses it, which fails the app at start). |
   | `EXPO_PUBLIC_WEB_URL` | `<vercel>`: https, no path, no trailing slash needed. Share and texted invite links become `<vercel>/b/<code>` on web **and** on phones. Empty means dev links (`localhost:8081` / `splitit://`). A bad value (http, a path, a query) stops the app at start with an error naming the variable. |

   If you only learn the address after the first deploy, set `EXPO_PUBLIC_WEB_URL` then and redeploy. The first build's share links would still be dev links.
6. **Deploy**, then run the **leak check** on a local production build made with the same values: `npm run export:web`, then `grep -rE "service_role|sb_secret_" dist/` should print nothing. (One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected; ADR 0012.) Also check that the built bundle contains your `<vercel>` origin: `grep -rl "<vercel>" dist/_expo/static/js/web/`.
7. **Smoke test on the live site:** open `<vercel>/b/<some code>` in a private window (it should load the app, not a 404), sign in with Google, create a bill, and check that the share link starts with `<vercel>/b/`.

## Undo
- Plugin: `claude plugin uninstall vercel@claude-plugins-official`
- CLI: `npm uninstall --global vercel`
