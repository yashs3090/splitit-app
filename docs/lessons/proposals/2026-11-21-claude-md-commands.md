# Proposal: update CLAUDE.md § Commands after M1a

**Status:** applied 2026-11-21 (with the user-approved addition to Change 3: "Restart Supabase (`npm run db:stop && npm run db:start`) after editing `supabase/.env` or `supabase/config.toml`; it reads them only at start.")
**Target file:** `CLAUDE.md` § Commands
**Why:** M1a (spec `docs/specs/2026-11-20-m1a-scan-receipt.md`, Task 8) changed how the web server starts (it now copies Tesseract assets first), added `npm run db:*` scripts, and showed the device-run prerequisites are more specific than "full Xcode". The line "Web has no on-device recognition, so the host types items by hand" is no longer true: web now reads receipts with Tesseract.js (ADR 0012).

**Caveat:** the device steps come from the spec and the Expo SDK 57 reference table. The first iPhone build (D1) hasn't run yet (Xcode not installed, 2026-11-21). Re-check this wording after D1 and adjust it if the real run differs.

## Change 1: web dev server

Old:
```
- Web dev server: `npm run web` (http://localhost:8081). Needs `.env` and, for real sign-in, the local Supabase running with Google configured.
```

New:
```
- Web dev server: `npm run web` (http://localhost:8081). It first runs `scripts/copy-tesseract-assets.mjs` (the `preweb` hook), which copies the self-hosted Tesseract.js files into `public/tesseract/` (gitignored, ~15 MB). If you start the server another way (`npx expo start --web`), run `node scripts/copy-tesseract-assets.mjs` first, or web scanning fails with "Couldn't load the text reader". `npm start` runs the same copy (`prestart`). Needs `.env` and, for real sign-in, the local Supabase running with Google configured.
```

## Change 2: web build

Old:
```
- Web build: `npm run export:web` (outputs `dist/`, SPA; uses `--clear` because `EXPO_PUBLIC_*` values are baked in at build time and a cached build can keep stale ones). Leak check after building: `grep -rE "service_role|sb_secret_" dist/` should print nothing.
```

New:
```
- Web build: `npm run export:web` (outputs `dist/`, SPA; uses `--clear` because `EXPO_PUBLIC_*` values are baked in at build time and a cached build can keep stale ones). Always build through this script: its `preexport:web` hook copies the Tesseract assets, and a bare `npx expo export -p web` ships without them. Leak check after building: `grep -rE "service_role|sb_secret_" dist/` should print nothing. One `cdn.jsdelivr.net` match inside the lazy `webOcrEngine-*` chunk is expected (Tesseract.js's unused default path; ADR 0012).
```

## Change 3: local database scripts (new line, after "Web build")

Old: (none)

New:
```
- Local database (run from the repo root, Docker running): `npm run db:start` / `db:stop` / `db:status` / `db:reset` (re-applies `supabase/migrations/`) / `db:test` (pgTAP tests in `supabase/tests/database/`). These wrap `supabase start|stop|status|db reset|test db`.
```

## Change 4: native device run

Old:
```
- Native features (camera + on-device text recognition) need a **development build**; Expo Go can't load that native code. Run `npx expo run:ios --device` (needs full Xcode and a free Apple ID; the install expires after 7 days) or use EAS Build (paid Apple Developer account). Web has no on-device recognition, so the host types items by hand.
```

New:
```
- Native features (camera + on-device text recognition) need a **development build**; Expo Go can't load that native code. Run `npx expo run:ios --device` or use EAS Build (paid Apple Developer account). Prerequisites for a device run:
  - Full Xcode **26.4 or newer** (SDK 57's minimum; an older Xcode won't build it), signed in with a free Apple ID (Personal Team). Free installs expire after 7 days, and a free team can have at most 3 such apps installed.
  - An iPhone on **iOS 16.4 or newer** with **Developer Mode** on (Settings → Privacy & Security → Developer Mode; the phone restarts).
  - On first launch, trust the developer profile: Settings → General → VPN & Device Management → your Apple ID → Trust.
  `ios/` and `android/` are generated and gitignored (CNG, ADR 0012): change native settings in `app.json`, never by editing those folders.
- Web scanning runs Tesseract.js in the browser (provisional, ADR 0012); "Enter items" is always there for typing items by hand.
```

## Not proposed (and why)
- **Stale lines elsewhere in `CLAUDE.md`, outside § Commands:** the "Repos" section still lists `../splitit-backend`, and § Conventions says the Google OAuth values live in `../splitit-backend/supabase/.env`. ADR 0011 (2026-11-20) moved everything into this repo's `supabase/`, so these should say `supabase/` and `supabase/.env`. Commands also says "run in `../splitit-backend`" for `npx supabase status`. Not part of this task's scope; listed so the user can approve a separate fix (or fold it into this one).
- **The first paragraph's "Receipts are read on device" wording** still holds for web (the browser is the device), so no change.

## Evidence
- `package.json` scripts: `prestart`, `preweb`, `preexport:web` (copy script), `db:start|stop|reset|status|test`.
- `scripts/copy-tesseract-assets.mjs`; `.gitignore` (`/public/tesseract/`, `/ios`, `/android`).
- Spec `docs/specs/2026-11-20-m1a-scan-receipt.md`: "Providers, accounts and costs" table and "On-device checks" prerequisites (Xcode 26.4+, iOS 16.4+, Developer Mode, trust the certificate); Amendments A3 and A4.2.
- `docs/learning/decisions/0012-receipt-capture-and-recognition-libraries.md`.
