# Testing SplitIt locally

Everything you need to run and test SplitIt on your own Mac, from a fresh clone to a two-person claim test. Run every command from the repo root (the `splitit-app/` folder, which has `package.json` and `supabase/` in it).

- Quick tick-list version: [local-setup-checklist.md](local-setup-checklist.md)
- Click-by-click Google Cloud steps: [google-oauth.md](google-oauth.md)

> **What runs where:** the app (Expo, web on port 8081) and a local copy of Supabase (Docker; API on port 54321, Studio on 54323). There is no other server. See [ADR 0010](../learning/decisions/0010-on-device-ocr-no-custom-backend.md) and [ADR 0011](../learning/decisions/0011-single-repo.md).

---

## 1. One-time setup

### 1.1 Install the tools
| Tool | Why | Check |
|---|---|---|
| Node 20.19+ (this repo is pinned to Expo SDK 57 for Node 20, ADR 0009) | runs Expo, tests | `node -v` |
| Docker Desktop | runs local Supabase | open it, then `docker info` prints "Server:" |
| Xcode 26.4+ *(only for the iPhone app)* | builds the native app | `xcodebuild -version` |

Then install packages:
```sh
npm install
```

### 1.2 Google sign-in (one-time)
SplitIt only signs in with Google. Follow [google-oauth.md](google-oauth.md). You end up with:
- a Google Cloud **Web application** OAuth client with
  - Authorized JavaScript origin: `http://localhost:8081`
  - Authorized redirect URI: `http://127.0.0.1:54321/auth/v1/callback` (exactly, `127.0.0.1` not `localhost`)
- the consent screen in **Testing** mode, with **every Gmail you'll test with added as a Test user** (for the two-person test, add both).

### 1.3 Two `.env` files, two jobs
| File | Read by | Holds | Secret? |
|---|---|---|---|
| `supabase/.env` | Supabase (when it starts) | `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` | **Yes** |
| `.env` (repo root) | Expo (baked into the app) | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | No, public by design |

```sh
cp supabase/.env.example supabase/.env   # then paste your Google client ID and secret (no quotes)
cp .env.example .env                     # filled in at step 2.2
```
The Google values go **only** in `supabase/.env`, never in the root `.env`. Check: `grep -ci google .env` prints `0`.

---

## 2. Start everything (every session)

### 2.1 Start local Supabase
Open Docker Desktop first, then:
```sh
npm run db:start        # first run downloads images (several minutes)
```
It prints a table. Note the **Project URL** (`http://127.0.0.1:54321`) and the **Publishable** key. `npm run db:status` shows them again later.

Apply the database tables:
- **First time, or you don't mind losing local data:** `npm run db:reset` (wipes local data and applies every migration).
- **Pulled new migrations and want to keep your data and sign-in:** `npx supabase migration up`.

> Edited `supabase/.env` or `supabase/config.toml`? Restart: `npm run db:stop && npm run db:start`. Supabase only reads them at start.

### 2.2 Point the app at local Supabase (first time)
In the root `.env`:
```
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the Publishable key, sb_publishable_...>
```
Never use the **Secret** (`sb_secret_...`) key. The app refuses it, and anything `EXPO_PUBLIC_*` ships to every user.

### 2.3 Start the web app
```sh
npm run web
```
Use `npm run web`, not `npx expo start --web`: it first copies the Tesseract files the web scanner needs into `public/tesseract/`. If you do use `npx expo start --web`, run `node scripts/copy-tesseract-assets.mjs` first. The same hook also runs the OpenCV scripts; while OpenCV is switched off (`WEB_CV_PREPROCESS = false` in `lib/scanPipeline/config.ts`, the case today) they remove `public/opencv/` instead of filling it, so nothing extra is served. After changing `.env`, restart with `--clear` (values are baked in at build time).

Open **http://localhost:8081**.

---

## 3. Check it's healthy
```sh
npm run db:test       # database security and function tests; ends with "Result: PASS"
npm test              # app unit + screen tests (Jest)
npm run typecheck     # TypeScript strict check, prints nothing on success
npx expo-doctor       # Expo config health
```
Optional:
- **Production-style web build + leak check:**
  ```sh
  npm run export:web
  grep -rE "service_role|sb_secret_" dist/    # must print nothing
  ```
- **Look inside the database:** Supabase Studio at http://127.0.0.1:54323 (Authentication → users; Table editor → `profiles`, `bills`, `claims`, …).

---

## 4. What to test, step by step

### 4.1 Sign in
http://localhost:8081, then **Continue with Google**, pick a Gmail on your Test users list. You should land on the home screen ("Signed in as …"), and Studio → `profiles` gets a row for you.

### 4.2 Type a bill in by hand
Home → **Scan receipt** → **Enter items**:
1. Add 2–3 items (name, qty, price), edit one, delete one.
2. Type `12.999` as a price: you get an error under the row and the footer says "Fix the highlighted fields".
3. Fill subtotal, tax, tip and total until the footer says **✓ Adds up**.
4. Change the total by 2¢: the red banner appears with "Off by $0.02".

### 4.3 Scan a receipt on the web (Tesseract)
Home → **Scan receipt** → **Take or upload photo**, then pick a clear, flat receipt photo.
- First time: "Getting the text reader ready…" (about 7 MB download, then cached), then "Reading receipt…" with a progress bar and **Cancel**, then the form filled in to check.
- Taking the photo on your phone? AirDrop it to the Mac and upload it here (see §6 for why the phone browser can't sign in yet).
- Optional privacy check: browser DevTools → Network. Requests only go to `localhost:8081/tesseract/...`; the photo is never uploaded.

### 4.4 Save, share and claim with two people *(share-and-claim milestone; screens still being built)*
1. Make sure **both** Gmails are Test users (§1.2).
2. Use two separate browser profiles, e.g. normal Chrome + a second Chrome profile (or Chrome + Safari). An incognito window works too.
3. Person A: make a bill (§4.2 or §4.3) → **Save and share** → copy the invite link.
4. Person B: open the link in the other profile, sign in with the second Gmail. They land on the bill.
5. Tap items in each window. Claims, initials and shares should update live in the other window. Two people on one item split it evenly; "Split differently" sets custom parts.
6. Host edits a price: both screens update; Activity shows who changed what.

### 4.5 The iPhone app *(needs Xcode)*
```sh
sudo xcode-select -s /Applications/Xcode.app
npx expo run:ios --device
```
iPhone on iOS 16.4+, plugged in, **Developer Mode** on (Settings → Privacy & Security). On first launch trust the developer profile: Settings → General → VPN & Device Management. A free Apple ID install expires after 7 days; run the command again. Full device checks (D1–D10) are in [the M1a spec](../specs/2026-11-20-m1a-scan-receipt.md).
**Known limit:** signing in on the iPhone doesn't work against local Supabase yet (see §6).

### 4.6 Measure how well web scanning reads your receipts *(no sign-in, no Supabase needed)*
This scores the app's web reader on your own receipt photos. Everything stays on your Mac: `receipts/` and `eval/receipts/` are gitignored.
```sh
npx playwright install chromium                   # first time only: the headless browser the harness uses
npm run ocr:harness -- --variants web-current     # read every photo in receipts/ the way the web app does
npm run answers:draft                             # pre-filled answer files in receipts/answers/ (checked: no)
# fix each answer file with the photo open, then change its last line to "checked: yes"
npm run answers:check                             # finds typos and answers that don't add up
npm run eval                                      # score the reads against the checked answers
```
Full steps, the answer-file format and how to compare scan settings (`--compare`, `--flow`, `--confirm`): [receipt-answers.md](receipt-answers.md). Why it's done this way: [the scan pipeline](../learning/concepts/scan-pipeline.md).

### 4.7 What a failed scan looks like
If a scan reads no items, no total, or totals that don't add up, the scan screen now shows "We couldn't read this receipt clearly." with **Retake photo** and **Type it in** (the form, pre-filled with what was read). Try it with a blurry or partial photo. A clear photo goes straight to the form as before.

---

## 5. Stop everything
- Web app: `Ctrl+C` in its terminal.
- Supabase: `npm run db:stop` (keeps your data; `db:start` resumes it).
- Docker Desktop can then be quit.

---

## 6. Known limits of local testing
- **Phones can't sign in against local Supabase.** On a phone, `127.0.0.1` is the phone itself, and Google only accepts plain `http://` callbacks for `localhost`. Opening `http://<your-Mac-Wi-Fi-IP>:8081` loads the app but sign-in fails. The fix is the planned free **friend-test deploy** (hosted Supabase + an `https://` web address). Don't expose local Supabase with a public tunnel: it uses well-known default secret keys.
- **Local Supabase is visible on your Wi-Fi** (it listens on all network interfaces). Fine at home; avoid running it on public Wi-Fi.
- `npm run db:reset` deletes local users and bills. You'll need to sign in again.

## 7. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `Cannot connect to the Docker daemon` | Docker Desktop isn't running (or still starting). Open it, wait, retry. |
| Sign-in shows `server_error` | Check `docker logs supabase_auth_splitit-app`. `invalid_client … client secret is invalid` means a wrong secret in `supabase/.env`. Make a new one in Google Console, paste without quotes, restart Supabase. |
| `redirect_uri_mismatch` | Google's redirect URI isn't exactly `http://127.0.0.1:54321/auth/v1/callback`. |
| `Access blocked: app has not completed verification` | That Gmail isn't a Test user on the consent screen. |
| `invalid_client` / "OAuth client was not found" | `supabase/.env` still has `replace-me` placeholders, or Supabase wasn't restarted. |
| Web scan says "Couldn't load the text reader…" | Tesseract files missing. Start with `npm run web`, or run `node scripts/copy-tesseract-assets.mjs`. |
| App shows old config after editing `.env` | Restart the dev server with `npx expo start --web --clear`. |
| `/bill` or `/scan` sends you to sign-in | Expected: those screens need you to be signed in. |
| `git diff tsconfig.json` shows new `include` entries after running the dev server | Expo added them automatically; revert them. |
