# Universal Links (iOS) and App Links (Android) for invite links

Goal: tapping `https://<host>/b/<code>` (the invite link and QR from `lib/inviteLink.ts`) opens SplitIt on the invite screen (`app/b/[code].tsx`) when it's installed, and the website otherwise. `<host>` is the host of `EXPO_PUBLIC_WEB_URL`, today `splitit-app-kappa.vercel.app`.

Prepared 2026-11-26. **Nothing is switched on yet**: everything waits for build-time values that don't exist yet (a paid Apple team, Android signing fingerprints). With them unset, the app and website build exactly as before.

## How it's wired

| Piece | Where | Switched on by |
| --- | --- | --- |
| iOS `ios.associatedDomains: ["applinks:<host>"]` and `ios.appleTeamId` | `app.config.ts` → `lib/appLinks.ts` (`withAppLinks`) | `APPLE_TEAM_ID` **and** `EXPO_PUBLIC_WEB_URL` at native build time |
| Android intent filter: `VIEW`, `autoVerify: true`, `https://<host>` with `pathPrefix: "/b/"`, `BROWSABLE` + `DEFAULT` | same | `ANDROID_CERT_SHA256` **and** `EXPO_PUBLIC_WEB_URL` at native build time |
| `public/.well-known/apple-app-site-association` (no extension): `applinks.details[].appIDs = ["<TEAMID>.com.yashs3090.splitit"]`, `components: [{ "/": "/b/*" }]` | `scripts/write-well-known.ts`, run by `prestart`, `preweb` and `preexport:web` | `APPLE_TEAM_ID` at web build time |
| `public/.well-known/assetlinks.json`: `delegate_permission/common.handle_all_urls` for `com.yashs3090.splitit` with your fingerprints | same | `ANDROID_CERT_SHA256` at web build time |
| Vercel: the SPA rewrite skips `/.well-known/`; both files are sent as `Content-Type: application/json` | `vercel.json` | always |

- `app.json` stays the base config. `app.config.ts` only adds to it; with the variables unset its output is exactly `app.json` (tested in `__tests__/appConfig.test.ts`).
- The `splitit://` scheme stays on in every build (sign-in still returns through it).
- A variable that's unset means its file is **removed** from `public/.well-known/` on the next build, so nothing stale or wrong is published. A malformed value (a 9-character team ID, a SHA-1 fingerprint) stops the build with an error naming the variable.
- The generated files are gitignored; their contents come from the env vars plus the bundle id / package in `app.json`.
- None of these variables is `EXPO_PUBLIC_`, so none of them ends up in the app's JavaScript. They aren't secrets anyway (the team ID and fingerprints are published in the files above), but they are per-account build settings.
- **Why the team ID gate matters:** a free Personal Team can't sign the Associated Domains entitlement, so adding it unconditionally would break today's free `npx expo run:ios` build *(this limitation is from the task brief and general knowledge; Apple's capability table didn't render when checked on 2026-11-26)*.

### Where to put the values (not `.env`)
The root `.env` holds only `EXPO_PUBLIC_*` values (CLAUDE.md), so set these elsewhere:

| Build | Where to set `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` |
| --- | --- |
| Local native build (`npx expo run:ios`, `run:android`, `prebuild`) | inline in the shell for that command, e.g. `APPLE_TEAM_ID=AB12CD34EF npx expo run:ios --device`, or `export` them in your shell profile |
| Website (Vercel) | Vercel → Project → Settings → Environment Variables (Production), then **redeploy**. They're read by `scripts/write-well-known.ts` during `npm run export:web` |
| EAS Build (if you use it later) | EAS environment variables for the build profile *(set them with `eas env:create` or the expo.dev dashboard; check the current EAS docs)*. EAS also needs `EXPO_PUBLIC_WEB_URL` there, since it reads `app.config.ts` on its servers |

`EXPO_PUBLIC_WEB_URL` must be set for the native build too (in `.env` locally, which the Expo CLI loads before reading `app.config.ts`), or the native side adds nothing and prints a warning.

## When the paid Apple account is ready (iOS)

1. **Find your Team ID.** developer.apple.com → Account → Membership details → Team ID (10 letters and digits). In Xcode: Settings → Accounts → your team.
2. **Website first.** In Vercel, add `APPLE_TEAM_ID=<TEAMID>` (Production) and redeploy. Then check the file:
   ```sh
   curl -sI https://splitit-app-kappa.vercel.app/.well-known/apple-app-site-association
   curl -s  https://splitit-app-kappa.vercel.app/.well-known/apple-app-site-association
   ```
   Expect `HTTP/2 200`, `content-type: application/json`, **no redirect**, and JSON whose `appIDs` is `["<TEAMID>.com.yashs3090.splitit"]`. If you get HTML, the rewrite or build is wrong; if you get 404, the variable didn't reach the build.
3. **Rebuild the app with the team.** The native folder is generated (CNG), so regenerate it with the new entitlement:
   ```sh
   APPLE_TEAM_ID=<TEAMID> npx expo prebuild --clean --platform ios
   APPLE_TEAM_ID=<TEAMID> npx expo run:ios --device
   ```
   Check the output of `APPLE_TEAM_ID=<TEAMID> npx expo config --type introspect` first if you like: `_internal.modResults.ios.entitlements` should contain `com.apple.developer.associated-domains: ["applinks:splitit-app-kappa.vercel.app"]`. With Xcode's automatic signing and the paid team, Xcode should enable the Associated Domains capability on the App ID for you *(unverified on this project)*.
4. **Wait for Apple's CDN.** Since iOS 14, devices fetch the file from Apple's CDN, not your server. Apple says the CDN requests it "within 24 hours", and devices check about once a week after install (Apple, "Supporting associated domains"). Deleting and reinstalling the app triggers a fresh check. To see what the CDN has: `curl -s https://app-site-association.cdn-apple.com/a/v1/splitit-app-kappa.vercel.app` *(widely used endpoint, not in Apple's docs page; unverified)*.
5. **Test on the iPhone.** Paste `https://splitit-app-kappa.vercel.app/b/<a real code>` into Notes or Messages and tap it (typing it into Safari's address bar doesn't trigger a universal link). It should open SplitIt on the invite screen, then join/sign-in as usual. If it opens Safari instead, check the CDN copy (step 4) and the iPhone's Settings → Developer → Universal Links diagnostics *(menu name unverified)*.
6. **Going back to the free team** (e.g. the paid membership lapses): unset `APPLE_TEAM_ID` and run `npx expo prebuild --clean --platform ios` again, or the old entitlement stays in `ios/` and signing fails.

Apple's file rules (checked 2026-11-26 in "Supporting associated domains"): named `apple-app-site-association` with no extension, in `/.well-known/`, served over `https://` with a valid certificate and **no redirects**. Apple's page doesn't name a content type; `application/json` is the usual choice and is what `vercel.json` sends.

## Android

1. **Get the SHA-256 fingerprints** of every key that signs a build people install:
   - **Local debug build** (`npx expo run:android`): the debug keystore in the generated project. After `npx expo prebuild --platform android`:
     ```sh
     keytool -list -v -keystore android/app/debug.keystore -alias androiddebugkey -storepass android -keypass android
     ```
     or `cd android && ./gradlew signingReport`. Copy the `SHA256:` line *(the keystore path and passwords are Expo's/React Native's template defaults; unverified for this SDK)*.
   - **EAS Build:** `eas credentials -p android`, pick the profile, copy "SHA256 Fingerprint" (Expo docs).
   - **Play Store:** with Play App Signing, Google re-signs the app with **its own** key. Play Console → Release → Setup → App signing shows the Digital Asset Links JSON / SHA-256 of the app signing key (Expo docs). That fingerprint must be in the list, or links from Play installs won't verify.
2. **Set `ANDROID_CERT_SHA256`** to the fingerprints, comma-separated (e.g. upload key + Play app-signing key + debug key), in Vercel, redeploy, and check:
   ```sh
   curl -sI https://splitit-app-kappa.vercel.app/.well-known/assetlinks.json
   curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://splitit-app-kappa.vercel.app&relation=delegate_permission/common.handle_all_urls"
   ```
   (The second is Google's Digital Asset Links API; *the exact URL is from general knowledge, unverified*.)
3. **Rebuild the app** with the same value (and `EXPO_PUBLIC_WEB_URL`), e.g. `ANDROID_CERT_SHA256=<fp1>,<fp2> npx expo prebuild --clean --platform android && ANDROID_CERT_SHA256=<fp1>,<fp2> npx expo run:android`.
4. **Verify on the device** (Android 12+, commands from Android's "Verify Android App Links"):
   ```sh
   adb shell pm set-app-links --package com.yashs3090.splitit 0 all
   adb shell pm verify-app-links --re-verify com.yashs3090.splitit
   # wait a minute, then:
   adb shell pm get-app-links com.yashs3090.splitit     # expect splitit-app-kappa.vercel.app: verified
   adb shell am start -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d "https://splitit-app-kappa.vercel.app/b/<code>"
   ```
   Android 15+ re-verifies in the background and can take up to 7 days to pick up a changed file; Android 14 and lower only re-check on install or update.

## What the app does with the link
Expo Router handles it with no extra code: for an `https://` URL it drops the origin and routes the path (`node_modules/expo-router/build/fork/extractPathFromURL.js`, "If a universal link / app link / web URL is used, we should use the path from the URL, while stripping the origin"). So `https://<host>/b/<code>` lands on the same `app/b/[code].tsx` screen as `splitit://b/<code>`. That screen validates the code with `normalizeInviteCode` (an allow-list regex) and never shows it; signed out, it saves the pending invite and goes to sign-in, and the root layout's single resume effect brings the person back afterwards (M0 flow, unchanged). Only `/b/*` is claimed by the app: every other path on the site keeps opening in the browser.

## Things to know
- **Links are tied to the domain.** The app claims `splitit-app-kappa.vercel.app` only. If you move to a bought domain, set `EXPO_PUBLIC_WEB_URL` to it, rebuild and resubmit the app, and keep the old host's files up until old installs have updated (`docs/before-production.md` §1, §5).
- **Preview deployments** get other hosts, so links to them never open the app. That's fine: friends only use Production.
- Not verified here: any device behavior (no iPhone or Android device run in this task), Vercel's live response headers, and Apple's CDN pick-up.

## "Get the app" banner on the website (added 2026-11-26)
Universal/App Links open the app for people who **have** it. For people who don't, the web app on a phone shows a slim bar at the top of every screen: a phone mark, "SplitIt works best in the app", **Get the app** (opens the store listing) and **✕** ("Continue on website", hides it for 14 days). Code: `lib/appBanner.ts` (rules, tested per platform) and `components/AppBanner.tsx`, mounted above the screens in `app/_layout.tsx` on web only. Decisions AB-1 … AB-10 in `docs/decisions-to-review.md` ("App banner").

**It's off today.** It shows only on a phone/tablet browser, and only when that platform's store URL is set at web build time:

| Variable (Vercel → Settings → Environment Variables, Production; then redeploy) | Example | Rule |
|---|---|---|
| `EXPO_PUBLIC_IOS_APP_STORE_URL` | `https://apps.apple.com/app/id1234567890` (App Store Connect → the app → App Information → Apple ID) | `https://apps.apple.com/…/id<digits>` only |
| `EXPO_PUBLIC_ANDROID_PLAY_STORE_URL` | `https://play.google.com/store/apps/details?id=com.yashs3090.splitit` | `https://play.google.com/store/apps/details?id=<package>` only |

Set one and only that platform gets the bar (an iPhone is never sent to Google Play). A malformed value stops the web app at start with an error naming the variable, so check the deploy right after setting it. These are public values (they ship in the bundle), so `EXPO_PUBLIC_` is right; they are never secrets. Locally, pass them inline: `EXPO_PUBLIC_IOS_APP_STORE_URL=… npm run export:web`.

**No "Open in app" button, on purpose.** For someone with the app, tapping the `https://…/b/<code>` link already opens the app (this guide). On the website, a `splitit://` button can't be made safe on iOS: without the app, Safari shows "Safari cannot open the page because the address is invalid", and there's no reliable way to check first. Android could use an `intent://…#Intent;…;S.browser_fallback_url=<Play URL>;end` link that falls back to Play, but it would do the same thing as "Get the app" for people without the app. Revisit once the app is live.

**Apple's Smart App Banner (later, iOS Safari only).** Once the app is on the App Store, Safari can show Apple's own banner from `<meta name="apple-itunes-app" content="app-id=<numeric id>, app-argument=<current URL>">`. Upsides: it says "Open" when the app is installed and "View" when not, and passes the URL to the app. Downsides: Safari only (not Chrome on iOS), and Safari reads the tag at page load, so it has to be in `public/index.html` at build time (`index.html` is a static template: it'd need a build step that writes the tag only when an App Store ID is configured, like `scripts/write-well-known.ts` does for the well-known files). If it's added, hide our own bar in iOS Safari so there aren't two banners.
