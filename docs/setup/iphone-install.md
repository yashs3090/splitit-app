# Installing SplitIt on your iPhone (dev build + hosted Supabase)

Gets the real app onto your iPhone, where sign-in works and the app runs without your Mac. Two parts: a free hosted Supabase project the phone can reach, then an Xcode build.

> Why hosted Supabase: on the phone, `127.0.0.1` means the phone itself, so it can't reach the Supabase running on your Mac. Google sign-in also only accepts plain `http://` for `localhost`. A hosted project has a real `https://<ref>.supabase.co` address that both the phone and Google accept.

Commands run from the repo root (`splitit-app/`). In Claude Code, put `!` in front of a command to run it yourself.

---

## Part A: free hosted Supabase project (one time)

1. **Create the project.** Sign up at https://supabase.com and create a **new project** on the free plan. Pick a region near you.
   - Save the **database password** in a password manager. Never paste it into chat or into any file in this repo.
   - Note the **project ref**: the `xxxxxxxx` in `https://xxxxxxxx.supabase.co` (also under Project Settings → General).
2. **Link this repo to it and push the database.**
   ```sh
   npx supabase login                               # opens a browser to authorise the CLI
   npx supabase link --project-ref <your-ref>       # asks for the database password
   npx supabase db push                             # applies supabase/migrations/ to the hosted project
   ```
   Check: Dashboard → Table Editor lists `profiles`, `bills`, `line_items`, `bill_participants`, `claims`, `bill_events`.
3. **Turn on Google sign-in** (Dashboard → Authentication → Sign In / Providers → Google):
   - Enable it and paste the same **Client ID** and **Client secret** as in `supabase/.env`. The secret lives only in the dashboard, never in the app.
   - Make sure Email sign-in is **off** (ADR 0008).
4. **Allowed redirect URLs** (Dashboard → Authentication → URL Configuration):
   - Site URL: `http://localhost:8081`
   - Redirect URLs: add `splitit://**` (the iPhone app) and `http://localhost:8081/**` (web dev).
5. **Realtime:** Dashboard → Realtime → Settings → turn **off** "Allow public access", so only private channels work, which is what the app uses (see `docs/before-production.md`).
6. **Google Cloud Console** (APIs & Services → Credentials → your Web OAuth client):
   - Add authorized redirect URI: `https://<your-ref>.supabase.co/auth/v1/callback`. Keep the local one too.
   - Consent screen (Audience): your Gmail, and anyone else testing, must be listed under **Test users**.
7. **Point the app at the hosted project.** In the root `.env`, set:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<the project's Publishable key>   # Project Settings → API Keys
   ```
   Never the secret / service_role key. Keep the old local values commented out so you can switch back (`npm run web` against local Supabase).

## Part B: build onto the iPhone

1. **Install Xcode 26.4 or newer** from the Mac App Store, open it once, accept the license and let it install components.
   ```sh
   sudo xcode-select -s /Applications/Xcode.app
   xcodebuild -version        # should print 26.4 or newer
   ```
2. **Sign Xcode in with your Apple ID:** Xcode → Settings → Accounts → + → Apple ID. A free account gives a "Personal Team".
3. **Prepare the iPhone:** iOS 16.4+, plug it in by cable, unlock it, tap "Trust This Computer", then Settings → Privacy & Security → **Developer Mode** on. The phone restarts.
4. **Build and install:**
   ```sh
   npx expo run:ios --device --configuration Release
   ```
   Pick your iPhone. `Release` bundles the JavaScript into the app, so it runs on its own, without your Mac or a dev server. For day-to-day development with live reload, use `npx expo run:ios --device` (Debug), which loads JavaScript from your Mac over Wi-Fi.
   - Signing error: open `ios/SplitIt.xcworkspace` in Xcode → SplitIt target → Signing & Capabilities → tick "Automatically manage signing", set Team to your Personal Team, check the Bundle Identifier is `com.yashs3090.splitit`, then run the command again.
5. **First launch:** if iOS says "Untrusted Developer", go to Settings → General → VPN & Device Management → your Apple ID → Trust.
6. **Test** (device checks D1–D10 in `docs/specs/2026-11-20-m1a-scan-receipt.md`): sign in with Google → Scan receipt → camera → the bill form → Save and share → claim.

**Limits of a free Apple ID:** the install expires after 7 days (run step 4 again), and you can have at most 3 such apps installed.
