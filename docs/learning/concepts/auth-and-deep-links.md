# Auth and deep links

## The idea
**Authentication with OAuth / OpenID Connect.** "Sign in with Apple/Google" means Apple or Google confirms who the user is and hands our auth server (Supabase Auth) a signed token. Supabase then issues its own session:
- an **access token (JWT)**: a short-lived, signed JSON token containing the user id (`sub`). Every request to Postgres sends it, and RLS reads it through `auth.uid()`.
- a **refresh token**: long-lived, used to get new access tokens without signing in again. On mobile it's stored in secure storage (Keychain/Keystore via `expo-secure-store`).

A **magic link** is passwordless email sign-in: we email a one-time link, and opening it proves you control the inbox.

**Deep links** open a specific screen in the app from a URL:
- *Custom scheme:* `splitit://b/abc123`. Easy, but only works if the app is installed, and any app can claim the same scheme.
- *Universal links (iOS) / App Links (Android):* `https://splitit.app/b/abc123`. They open the app if it's installed and the website otherwise. They need a verification file hosted on our domain (`apple-app-site-association`, `assetlinks.json`). This is what we use for invites.

## Why it matters here
The invite flow is our biggest drop-off risk ([ADR 0004](../decisions/0004-required-accounts.md)):
1. A friend taps `https://splitit.app/b/abc123`.
2. They aren't signed in, so the app **remembers the pending invite** (the code) and shows sign-in.
3. After the OAuth redirect back, the app reads the pending code, calls `join_bill(code)`, and navigates to the claim screen.

If step 2 forgets the code, the user lands on an empty home screen and gives up.

## How SplitIt does it (M0)
Sign-in is **Google only** ([ADR 0008](../decisions/0008-google-only-sign-in.md)), using the OAuth **PKCE** flow on every platform (`flowType: 'pkce'` in `lib/supabase.ts`).

**Web** (`lib/oauth.ts`, `signInWithGoogleWeb`):
1. "Continue with Google" calls `signInWithOAuth({ provider: 'google', options: { redirectTo: origin + '/' } })`. The whole page navigates away to Supabase, then to Google.
2. Google sends the user back to Supabase (`/auth/v1/callback`), which redirects to our `/` with `?code=…`.
3. `detectSessionInUrl: true` makes supabase-js exchange the code (plus the PKCE verifier it saved in `localStorage`) for a session.
4. This is a **full page load**, so React state is gone. That's why the pending invite must already be in storage.

**Native** (unverified until we have a simulator):
1. `signInWithOAuth({ …, skipBrowserRedirect: true })` returns the Google URL without navigating.
2. `WebBrowser.openAuthSessionAsync(url, 'splitit://auth/callback')` opens an in-app browser and waits for our redirect.
3. We parse `?code=` from the returned URL and call `exchangeCodeForSession(code)`.

**Pending invite** (`lib/pendingInvite.ts`):
- **One-shot:** `takePendingInvite` reads the invite *and deletes it*, so an old invite can't hijack a later sign-in.
- **24-hour expiry:** a stale invite on a shared device is dropped.
- **Validated twice:** when saved and when read. The code must match `[A-Za-z0-9_-]{10,64}`.
- **No open redirect:** after sign-in, `postSignInRoute` can only return `/` or `/b/<valid code>` (and, since group invites on 2026-11-27, `/g/<valid code>`). It never accepts a URL from the request. (An **open redirect** is when your site will forward users to any URL given in a parameter. Phishers abuse it to make evil links look like they're on your domain.)

**Resume in exactly one place:** `ResumeAfterSignIn` in `app/_layout.tsx` runs when the session goes from signed-out to signed-in, *and* on first load. The first-load case is how the web redirect gets resumed. One place means no two screens can fight over where to navigate. The reviewer found a case where `/auth/callback` *could* fight it on Android, so that screen now defers to the root as well.

**Session storage:**
- **Web:** `localStorage`. A cross-site scripting (XSS) bug could read it. That's acceptable for M0; revisit before a public web launch.
- **Native:** SecureStore (Keychain/Keystore), with values split into chunks, because SecureStore has a size limit per value and sessions can exceed it.

**Sign-out** uses `scope: 'local'`. It ends the session on this device only. The default (`global`) would also sign you out of your phone when you log out of a friend's laptop.

**Error messages from the URL:** the `?error=` value on the landing page can be typed by anyone, so we only translate known OAuth error codes and otherwise show a generic message. Echoing attacker-controlled text on a trusted screen is a phishing aid.

## Google and Supabase together, and the redirect allow-lists (added 2026-11-25)
Google and Supabase do different jobs. **Google proves who you are; Supabase holds the data and decides what you can see.** The app never talks to Google directly and never holds the Google client secret.

The sign-in has **two hops**, and each has its own allow-list:

```
App ──► Supabase Auth ──► Google sign-in page
                              │  user picks an account
 Hop 1: Google ──code──► https://<ref>.supabase.co/auth/v1/callback
                              │  Supabase swaps the code using the client ID + secret
 Hop 2: Supabase ──code──► splitit://auth/callback  (or the web app's URL)
                              │
                     App swaps the code (+ its PKCE verifier) for a session
```

| Hop | Who checks it | Where you set the list | What it protects |
|---|---|---|---|
| 1. Google → Supabase | Google | Google Cloud Console → Authorized redirect URIs | Google's code only goes to *your* Supabase project |
| 2. Supabase → app | Supabase | Supabase → Authentication → URL Configuration → Redirect URLs | Supabase's code only goes to *your* app or site |

**Why the lists exist.** The sign-in link says where to come back to, and the client ID in it isn't secret. If any `redirect_uri` were accepted, an attacker could send a real Google page with *your* client ID and `redirect_uri=https://evil.com`, and the code would go to them. The list makes the service refuse anything not on it (Google shows `redirect_uri_mismatch`).

**Pattern rules.** `splitit://**` matches any path under the scheme (`**` crosses `/`; a single `*` doesn't). `http://localhost:8081/**` is dev only: on someone else's device `localhost` is *their* device. Avoid wildcards like `https://*.netlify.app/**`, which anyone can match by making a site.

**Why `splitit://` is still safe enough: PKCE.** Any app on a phone can register the `splitit://` scheme and catch the hop-2 code. PKCE makes a caught code useless: before sign-in the app makes a random *verifier*, keeps it on the device, and sends Supabase only a scrambled version. To swap the code, the app must send the verifier; a thief doesn't have it. Universal links (`https://yourdomain/...`, owned by whoever owns the domain) close the gap fully, later.

**Supabase's fallback.** If the `redirectTo` the app asks for isn't on the hop-2 list, Supabase doesn't error. It quietly sends the user to the **Site URL** instead.

### Debugging story: "sign-in on my phone ends on a stuck localhost page"
On the phone, the app asks to come back to `splitit://auth/callback`. The hosted project's Redirect URLs didn't include `splitit://**`, so Supabase fell back to the Site URL, `http://localhost:8081`, which on a phone is the phone itself: a dead page. The in-app browser only closes when it sees a `splitit://` address, so it looked stuck. The fix was dashboard-only (add `splitit://**`, Save); no rebuild. The address bar tells you which case you're in (never share the part after `?`, which holds the code):

| Address bar shows | Meaning |
|---|---|
| `http://localhost:8081/…` | Redirect not allow-listed; Supabase used the Site URL |
| `http://localhost:3000/…` | Site URL never set (3000 is Supabase's default) *and* redirect not allowed |
| `http://127.0.0.1:54321/…` | The installed build still points at the **local** Supabase; `EXPO_PUBLIC_*` values are baked in at build time, so rebuild |

Local `supabase/config.toml` (`additional_redirect_urls`) only configures the **local** stack; the hosted project needs the same entries in its dashboard.

### Why share links don't open on friends' phones (yet)
`inviteUrl` uses `Linking.createURL`, so links are `http://localhost:8081/b/<code>` on web and `splitit://b/<code>` on native. Messaging apps usually don't make custom schemes tappable, friends don't have the app, and `localhost` is their own device. The fix is a hosted web app (the friend-test deploy, Vercel) and building links from its `https://` address; universal links come with a real domain.

### Universal Links / App Links, prepared but off (added 2026-11-26)
Both platforms need two halves that vouch for each other: the **app** says "I handle links on this host" (iOS: the `applinks:<host>` entitlement; Android: an intent filter with `autoVerify`), and the **website** says "this app may" (`/.well-known/apple-app-site-association` naming `<TeamID>.<bundle id>`; `/.well-known/assetlinks.json` naming the package and its signing-key fingerprints). Only when both match does the OS hand the `https://` link to the app instead of the browser. That's why it needs the paid Apple team (the team ID is part of the app's identity, and a free team can't sign the entitlement) and the exact signing keys (with Play App Signing, Google's key, not yours). SplitIt switches each half on from build-time env vars (`APPLE_TEAM_ID`, `ANDROID_CERT_SHA256`) in `app.config.ts` and `scripts/write-well-known.ts`, so the free build keeps working. Expo Router needs no code: it strips the origin from an `https://` URL and routes `/b/<code>` like `splitit://b/<code>`. Steps: [app links guide](../../setup/app-links.md).

### Tabs under the stack: where Back goes after a deep link (added 2026-11-28)
*From the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md), spec `docs/specs/2026-11-28-tab-bar-and-activity.md` Task 5, criteria 29–34).*

The app has a bottom tab bar now: Tabs · Groups · (+) · Activity · Profile. A bill, a group, `/scan` and the new-bill form are **pushed above** the tabs, so they show without the bar. Picture a stack of cards: the tabs are the bottom card, and a bill is a card on top. Back takes the top card off.

```
app/(app)/_layout.tsx          Stack (auth guard)
├── (tabs)/_layout.tsx         Tabs: index (Tabs), groups, activity, profile
├── bills/[id]/…               pushed above the tabs
├── groups/[id]/…, groups/new
├── scan, bill, account
app/b/[code].tsx, app/g/[code].tsx   join by link, then replace with the bill or group
```

The problem is a **deep link**. If Sam taps a link to `/bills/<id>` with the app closed, the app opens straight on the bill. Nothing is under it, so Back has nowhere to go. Three pieces fix that:

1. **The anchor.** `app/(app)/_layout.tsx` exports `unstable_settings = { initialRouteName: '(tabs)' }`. When the app builds its history from a URL, it puts `(tabs)` underneath first. So a cold start on `/bills/<id>` gives "Tabs, then the bill", and Back lands on Tabs. Expo's docs say the anchor is used only for deep links. During normal in-app navigation, the screen you came from is what's underneath. Expo's docs now call this setting `anchor` and list `initialRouteName` as the older name. The code comment records that expo-router 57.0.31 reads `anchor ?? initialRouteName`, so both work there.
2. **`withAnchor` on `/b` and `/g`.** Joining by link happens on `app/b/[code].tsx` (or `app/g/[code].tsx`), which then calls `router.replace('/bills/<id>', { withAnchor: true })`. A plain `replace` would swap the join screen for the bill with nothing under it. `withAnchor` tells the router to load the anchor route (the tabs) below the target, so Back from the bill reaches Tabs (criteria 32b, 32f).
3. **`backToTabs`** in `lib/tabsNav.ts`. A pushed screen's "Home" button calls it. If there's something to pop (`router.canDismiss()`), it pops the whole stack (`dismissAll`), which keeps whichever tab you were on: open a bill from Activity, tap Home, and you're back on Activity with its filter and scroll. If nothing is below (a screen that replaced its way in), it opens `/` instead, which lands on Tabs. The older `dismissTo('/')` would have switched you to Tabs every time.

Two more details:
- **Profile from Settle.** Settle's and `VenmoPrompt`'s "add your Venmo" links open `/account` (`app/(app)/account.tsx`), a copy of Profile with a Back header. Switching to the Profile *tab* would leave Settle behind, because Settle sits above the tabs (FEED-25, criterion 41).
- **Sign-in resume didn't change.** `ResumeAfterSignIn` still sends you to `/` (now the Tabs tab), or to `/b/<code>` or `/g/<code>` for a pending invite. Those join screens then open the bill or group with `withAnchor`, so the tabs end up under it (criteria 32a–32c).

### Google's "Testing" mode
While the Google consent screen is in Testing, only Gmail accounts listed as **test users** can sign in. Every friend must be added, or the app published (privacy policy, possibly Google's review).

## Pitfalls
- Losing the invite across the OAuth redirect or an app cold start. Persist it, don't keep it only in memory.
- Allow-listing redirects in `config.toml` and forgetting the hosted dashboard (or the reverse).
- Setting a Site URL that only makes sense on your Mac (`localhost`) and then testing on a phone.
- OAuth redirect URLs must be allow-listed in Supabase Auth settings for each platform (scheme, Expo Go, web origin).
- Storing tokens in plain `AsyncStorage` on native. Use secure storage for the refresh token.
- Treating the JWT's contents as secret. They're only signed, not encrypted, so anyone can read them. Never put private data in custom claims.
- **A `replace` after a join with nothing under it.** The screen opens fine, but Back has nowhere to go inside the app. Pass `{ withAnchor: true }` so the tabs load underneath.
- **`dismissTo('/')` for "Home".** It works, but it always switches to the Tabs tab, so someone who opened a bill from Activity loses their place. Use `backToTabs`.
- **Testing only in-app navigation.** The anchor only applies to deep links, so a test that taps through from Tabs never checks it. Test a cold start on `/bills/<id>` and `/groups/<id>` too (criterion 32e).

## Check yourself
1. What's the difference between an access token and a refresh token, and why have both?
2. Why are universal links better than `splitit://` links for invites?
3. Walk through what happens when a signed-out user taps an invite on a phone without the app installed.
4. Which of the two allow-lists stops an attacker from catching Google's code? Which one stops them catching Supabase's?
5. A malicious app registers `splitit://` and receives the hop-2 code. Why can't it sign in as the user?
6. Sign-in on a phone ends on `http://localhost:8081/?code=…`. What's missing, and where do you fix it?
7. Sam taps a group link, joins on `/g/<code>`, and lands on the group. What would Back do if the join screen used a plain `router.replace`? What does `withAnchor` change?
8. You open Maya's bill from the Activity tab and tap "Home". Where do you land, and why would `dismissTo('/')` land somewhere else?

## Learn more
- https://supabase.com/docs/guides/auth/native-mobile-deep-linking
- https://docs.expo.dev/linking/into-your-app/
- https://jwt.io/introduction
- https://supabase.com/docs/guides/auth/redirect-urls
- https://oauth.net/2/pkce/
- Expo Router, router settings (`anchor`, formerly `initialRouteName`, and `withAnchor`): https://docs.expo.dev/router/advanced/router-settings/
- Expo Router, tabs: https://docs.expo.dev/router/advanced/tabs/
