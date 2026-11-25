# SplitIt

Bill-splitting app: the host takes a photo of a receipt, the phone reads the text on device (Apple Vision / ML Kit) and our parser (`lib/receiptText.ts`) turns it into line items, participants sign in and claim what they ordered, and each person's share (with tax and tip) is settled through Venmo/PayPal/Cash App payment links. No money moves in-app. No custom backend service: the app plus Supabase only (ADR 0010). Receipt-link import is deferred. If something needs a backend, tell the user so they can decide.

Full plan: `docs/plans/bill-splitting-app-2026-11-19.md`

## Repo layout (single repo, ADR 0011)
- `app/`, `lib/`, `components/`: Expo (React Native + Expo Router, TypeScript) for iOS/Android/web.
- `supabase/`: our managed-backend config: `config.toml` (auth providers), `migrations/` (tables, RLS, grants), `tests/database/` (pgTAP). No server code.
- `.claude/` (agents, skills), `docs/` (plans, specs, lessons, learning notes).

## Conventions
- TypeScript strict everywhere. No `any` without a comment explaining why.
- **Money is integer cents** (`number` of cents). Never floats for money. Tax, tip, fees and bill-level discounts are split either **proportionally** (by each person's items subtotal, the default) or **evenly** (among people who claimed something), chosen per bill by the host (ADR 0014). Both use largest-remainder rounding, so the shares always add up to the bill total exactly. In even mode, totals stay hidden until every item is claimed.
- A money rule enforced in both `lib/` and the database (e.g. the totals check) must be the same rule: same formula, same tolerance, and both sides tested on the same boundary cases.
- Pure logic (split math, payment-link builders, validators) lives in `lib/` with unit tests next to it (`*.test.ts`).
- Every table has RLS enabled **and** explicit grants: `revoke all on <table> from anon, authenticated, public`, then grant only the privileges each role needs (per column for UPDATE where possible). Never rely on Supabase's default grants on `public`. Denied operations should fail with `42501`, and acceptance criteria should expect that. Only participants can read a bill; only the host edits line items; users write only their own claims.
- Secrets (service-role key, Google OAuth client secret, any future API key) never go in the app bundle or in `EXPO_PUBLIC_*` vars. The Google OAuth values live in `supabase/.env` (gitignored, read by `supabase/config.toml` as `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`), never in the app's `.env`.
- Agents never read, grep, count, create or edit `.env*` files (only `.env.example`), for any reason. Pass needed values inline on the command line, use what tools report (`npx expo-doctor`, `npx supabase status`), or ask the user. The root `.env` holds only `EXPO_PUBLIC_*` values.
- Receipts are read on device and parsed by `lib/receiptText.ts`; there are no Claude API calls for now (ADR 0010). If Claude comes back (the fallback if parser accuracy stays under 85%), it goes only in an Edge Function with `@anthropic-ai/sdk`, model `claude-opus-5-5`, `output_config.format` and `fallbacks: "default"`. Parsing approach and model changes are the user's decision.

## How we work
- Use the `build-task` skill for feature work: product-manager → implementer → code-reviewer → qa-tester → retro.
- Before starting a task, read `docs/lessons/log.md` (at minimum, the sections tagged with the area you're touching).
- Run `/retro` after a task; it proposes updates to agents, skills or this file, and the user approves them.
- Keep `docs/learning/` current: when a task introduces a concept or a hard-to-reverse decision, add or update a concept note or an ADR (see `docs/learning/README.md`). The user studies these.
- Keep `docs/before-production.md` current: any "for now", provisional or dev-only decision, and any production-only risk found in review or QA, gets an item there in the same task.

## Commands
Expo SDK 57 (React Native 0.86), pinned because SDK 58 needs Node >= 22.13 and this machine has Node 20.19.5. Routes live in `app/`, non-route code in `lib/` and `components/`.

- Install: `npm install`. Add Expo packages with `npx expo install <pkg>` so versions match the SDK.
- Env: `cp .env.example .env`, then fill `EXPO_PUBLIC_SUPABASE_ANON_KEY` with the anon/publishable key from `npx supabase status`. Never the secret/service-role key: `EXPO_PUBLIC_*` values ship in the bundle, and `lib/env.ts` refuses secret keys.
- Tests: `npm test` (Jest, `jest-expo` preset). Pure-logic tests sit next to the code in `lib/*.test.ts`; router tests live in `__tests__/` (never under `app/`, or Expo Router would treat them as routes). Shared test fakes are in `test-utils/`. Agents run `npm test -- --maxWorkers=4` (Jest uses every core by default, and several agents' runs at once overload the machine and cause timeout-only failures), or one file with `npx jest <file>`.
- Type-check: `npm run typecheck` (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`).
- Web dev server: `npm run web` (http://localhost:8081). It first runs `scripts/copy-tesseract-assets.mjs` (the `preweb` hook), which copies the self-hosted Tesseract.js files into `public/tesseract/` (gitignored, ~15 MB). If you start the server another way (`npx expo start --web`), run `node scripts/copy-tesseract-assets.mjs` first, or web scanning fails with "Couldn't load the text reader". `npm start` runs the same copy (`prestart`). Needs `.env` and, for real sign-in, the local Supabase running with Google configured.
- Web build: `npm run export:web` (outputs `dist/`, SPA; uses `--clear` because `EXPO_PUBLIC_*` values are baked in at build time and a cached build can keep stale ones). Always build through this script: its `preexport:web` hook copies the Tesseract assets, and a bare `npx expo export -p web` ships without them. Leak check after building: `grep -rE "service_role|sb_secret_" dist/` should print nothing. One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected (Tesseract.js's unused default path; ADR 0012).
- Local database (run from the repo root, Docker running): `npm run db:start` (first run downloads images; prints the local URL and keys) / `db:stop` / `db:status` (shows the URL and keys again) / `db:reset` (wipes local data and re-applies `supabase/migrations/`; to apply only new migrations and keep data, use `npx supabase migration up`) / `db:test` (pgTAP tests in `supabase/tests/database/`). These wrap `supabase start|stop|status|db reset|test db`. Restart Supabase (`npm run db:stop && npm run db:start`) after editing `supabase/.env` or `supabase/config.toml`; it reads them only at start.
- Health check: `npx expo-doctor`.
- Native features (camera + on-device text recognition) need a **development build**; Expo Go can't load that native code. Run `npx expo run:ios --device` or use EAS Build (paid Apple Developer account). Prerequisites for a device run:
  - Full Xcode **26.4 or newer** (SDK 57's minimum; an older Xcode won't build it), signed in with a free Apple ID (Personal Team). Free installs expire after 7 days, and a free team can have at most 3 such apps installed.
  - An iPhone on **iOS 16.4 or newer** with **Developer Mode** on (Settings → Privacy & Security → Developer Mode; the phone restarts).
  - On first launch, trust the developer profile: Settings → General → VPN & Device Management → your Apple ID → Trust.
  `ios/` and `android/` are generated and gitignored (CNG, ADR 0012): change native settings in `app.json`, never by editing those folders.
- Web scanning runs Tesseract.js in the browser (provisional, ADR 0012); "Enter items" is always there for typing items by hand.
