# Mobile web: making the web app feel at home in a phone browser

Built on 2026-11-26 by the Home mobile refresh (`docs/specs/2026-11-26-home-mobile-refresh.md`, D7, decisions HR-13 to HR-17 in `docs/decisions-to-review.md`, all still **Open**). Home's own phone changes (the sticky bar and the two sections) are in [design system](design-system.md), section 10.

## The idea

When someone opens a website on a phone, the browser decides a lot on its own: the colour of its toolbar, whether the page goes under the notch, whether a tapped link flashes grey, whether the page zooms when you tap a text field, and what name and icon "Add to Home Screen" uses. A web app can tell the browser what it wants through a few lines in the page's `<head>` and one small file, the **web app manifest**. Get them right and the web app looks like an app. Leave them out and it looks like a web page squeezed onto a phone.

## Why it matters here

For the friend test, most people will use SplitIt as a website in their phone's browser (no App Store build yet). They open an invite link from Messages, sign in, and claim what they ate. Before this change, a friend on an iPhone saw a white Safari bar above a grey page, a grey flash on every tap, and the page zooming in when they tapped the item note field. "Add to Home Screen" suggested the page title, not "SplitIt".

## How we use it

### Where the head lives

Our web build is a single-page app (`web.output: "single"` in `app.json`). For that output, Expo builds the page from `public/index.html` when the file exists. `app/+html.tsx` is only used for static output, so we don't have one. Everything in `public/` is copied into `dist/` on export, which is how `manifest.webmanifest` and the icons ship. (The same reason the page background lives in `public/index.html`; see [design system](design-system.md), section 6.)

### The head tags (`public/index.html`)

| Tag | What it does | SplitIt value |
|---|---|---|
| `viewport` with `viewport-fit=cover` | Lets the page fill the whole screen, under the notch and the home indicator. Turns on the `env(safe-area-inset-*)` values | `width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover` |
| Two `theme-color` metas, each with a `media` query | Tints the browser's toolbar or status bar. The `media` attribute picks one per colour scheme | `#F3F4F6` (light) and `#0B0F14` (dark): the page background, `colors.light.background` / `colors.dark.background` in `lib/theme.ts` (HR-14) |
| `<link rel="manifest">` | Points to the manifest (below) | `/manifest.webmanifest` |
| `<link rel="apple-touch-icon">` | The icon iOS uses for "Add to Home Screen" | `/apple-touch-icon.png`, 180×180 |
| `apple-mobile-web-app-title` | The name iOS suggests for the home-screen icon | `SplitIt` |
| `html { -webkit-tap-highlight-color: transparent; }` | Turns off the grey flash over tapped elements on iOS Safari and Android Chrome. Our buttons draw their own pressed state | In the `splitit-touch` style block (HR-17) |

`__tests__/webTemplate.test.ts` reads `public/index.html` and the manifest and fails if a colour drifts from `lib/theme.ts`, if a tag goes missing, or if someone adds `maximum-scale` or `user-scalable`.

### Safe areas: `viewport-fit=cover` plus `env()`

A notched phone has parts of the screen you can't use: the notch or Dynamic Island at the top, the home indicator at the bottom, the rounded corners. The browser reports their size as four CSS values, `env(safe-area-inset-top)`, `-right`, `-bottom` and `-left`. MDN: they are `0` when nothing covers the viewport, and a `px` value above 0 otherwise.

On iOS those values are only non-zero once the page asks to fill the screen with `viewport-fit=cover`. MDN's viewport page says that with `cover`, "It's highly recommended to use the safe area inset variables to ensure that important content doesn't end up outside the display."

We don't write `env()` in our own CSS. `react-native-safe-area-context` reads those values on web and hands them to our screens as `insets` (`useSafeAreaInsets()`). Every screen that already pads with `insets.top` / `insets.bottom` for native (Home, bill, people, settle, activity, profile, scan, `BillForm`, `ItemSheet`) now pads on web too. Home's sticky bar is an example: its bottom padding is `insets.bottom + space.md`, so "Scan receipt" sits above the home indicator.

### Inputs must be at least 16px on web

iOS Safari zooms the page in when you focus a text field whose font is smaller than 16px, and it doesn't zoom back out when you leave the field. (Apple doesn't document this rule; it's widely reported and was the behaviour this spec was written against. Unverified against Apple's docs.) The friend then has to pinch the page back to size.

The wrong fix is turning zoom off (`maximum-scale=1` or `user-scalable=no`). MDN warns that disabling zoom stops people with low vision from reading the page, and WCAG asks for at least 2× zoom. So zoom stays on, and the inputs get big enough instead.

Every input in the app goes through one component, `components/ui/TextField.tsx` (`TextField`). Its `subtle` variant (the item note field) used `type.caption`, which is 13px. On web, a `subtle` field now uses `type.body` (16px). Native keeps 13px, because native apps don't zoom on focus (HR-16). The other variants already use `type.body` (16) or `type.title` (22). Fixing it in the one component means a new screen can't bring the problem back. A global CSS rule with `!important` was rejected: it fights react-native-web's own styles.

### The manifest (`public/manifest.webmanifest`)

A web app manifest is a small JSON file that tells the browser the app's name, icons, colours and how to open it from the home screen.

```json
{ "name": "SplitIt", "short_name": "SplitIt", "start_url": "/", "scope": "/",
  "display": "browser", "background_color": "#F3F4F6", "theme_color": "#F3F4F6",
  "icons": [ { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
             { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" } ] }
```

**Why `display: "browser"`** (HR-13). MDN: `browser` "Opens the app in a conventional browser tab or new window". `standalone` makes it look like a native app, with no URL bar. Standalone feels more "installed", but on iOS a home-screen web app keeps its own storage, separate from Safari. A friend signed in in Safari would be signed out in the home-screen app, and invite links from Messages open in Safari anyway. Google sign-in inside a standalone web app isn't tested. So we stay in the browser for now, and `docs/before-production.md` §5 has the item to revisit. (Platform note: Android Chrome follows `display`; iOS may open home-screen sites as web apps depending on the iOS version. User check U3 records what happens.)

The manifest has no dark variant, so its two colours are the light background.

**Content type.** MDN says a manifest should be served with `Content-Type: application/manifest+json`, and `.webmanifest` is the recommended extension. Nothing in our repo sets that header; most hosts map the extension on their own. Checking it on Vercel is a before-production item (§5).

### The icons are placeholders

`public/apple-touch-icon.png` (180×180), `public/icons/icon-192.png` and `public/icons/icon-512.png` are Expo's template icon (`assets/images/icon.png`) resized, because SplitIt has no real icon yet (question Q1 in the spec, AB-9, HR-15). When a real icon arrives, replace the three files with the same names and sizes. `__tests__/webTemplate.test.ts` checks each is a square PNG of the right size and under 200 KB. If a plain resize comes out bigger than that, drop the alpha channel (home-screen icons don't need transparency) and recompress it.

### The leak check: two expected `cdn.jsdelivr.net` matches

After `npm run export:web`, the leak check `grep -rE "service_role|sb_secret_" dist/` should print nothing secret. `CLAUDE.md` says one `cdn.jsdelivr.net` match is expected, inside the lazy `webOcrEngine-*` chunk (Tesseract.js's unused default download path, ADR 0012). QA on 2026-11-26 found a second one that is also expected: `dist/tesseract/worker.min.js`, Tesseract's own worker file, which we host ourselves. Neither is a secret. (`CLAUDE.md` lists only the first; the retro will propose adding the second.)

## Pitfalls

- **Turning zoom off to stop the input zoom.** `maximum-scale=1` or `user-scalable=no` hides the problem and fails people who need to zoom. Make the input 16px instead.
- **Adding a raw `<TextInput>` in a screen.** It skips `TextField`'s web rule and brings the zoom back. Use `TextField`.
- **`viewport-fit=cover` without insets.** Once the page fills the screen, anything that doesn't pad with `insets` can slide under the notch or the home indicator. A new full-screen layout has to use `useSafeAreaInsets()` (or a `BackHeader`, which the native header pads for you).
- **Editing `app/+html.tsx` and expecting a change.** Our build is single-page output, which uses `public/index.html`.
- **Hard-coding a theme colour.** If `lib/theme.ts`'s background changes, the meta, the manifest and the page background must change with it. The template test catches it.
- **Building with `npx expo export -p web` directly.** That skips the `preexport:web` hook, so the build ships without the Tesseract files. Use `npm run export:web`.
- **Switching to `display: standalone` without testing sign-in.** It changes where the session is stored on iOS. Test Google sign-in and invite links in a home-screen web app first.

## Check yourself

1. A friend says the page zooms in when they tap the new "Bill name" field on their iPhone. What's the likely cause, and where do you fix it?
2. Why don't we just add `maximum-scale=1` to the viewport meta?
3. You add a new full-screen page with a footer button. On an iPhone in Safari the button sits under the home indicator. Which two things have to be true for it to sit above it?
4. Why is the manifest's `display` set to `browser` and not `standalone`, even though `standalone` looks more like an app?
5. A designer sends the real app icon as a 512×512 PNG with transparency, and the template test fails on size. What do you do?

## Learn more

- MDN, `<meta name="viewport">` (including `viewport-fit` and the zoom warning): https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport
- MDN, `env()` and `safe-area-inset-*`: https://developer.mozilla.org/en-US/docs/Web/CSS/env
- MDN, `<meta name="theme-color">`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/theme-color
- MDN, web app manifest (file name and content type): https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest
- MDN, manifest `display`: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display
- `react-native-safe-area-context`: https://appandflow.github.io/react-native-safe-area-context/
- Expo, publishing websites (`web.output: "single"`, overriding the template with `public/index.html`): https://docs.expo.dev/guides/publishing-websites/
- Expo, progressive web apps (manifest and `npx expo customize public/index.html`): https://docs.expo.dev/guides/progressive-web-apps/
- In this repo: `.claude/skills/mobile-native/SKILL.md` (the mobile-web rules this slice followed), `docs/specs/2026-11-26-home-mobile-refresh.md` (D7)
