# Home: mobile refresh (thumb reach, clearer rows, grouping, installed feel on web)

Date: 2026-11-26. The user approved this scope on 2026-11-26 for the Home screen (`app/(app)/index.tsx`). It's aimed at people using SplitIt on a phone, mostly the web build in a phone browser for the friend test.
Repo: `splitit-app` only (ADR 0011). No migration, no `supabase/` change, no ADR (nothing here is hard to reverse).

The user prefers that PM-level product and UX choices be decided and logged rather than block the build. Every such choice below is logged as **HR-1 to HR-18** in `docs/decisions-to-review.md` ("2026-11-26 · Home mobile refresh"). The two questions that need the user don't block any task (see "Questions for the user").

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already set up) | Task 4's live read check | $0 |
| Two Google test accounts (exist since M2) | User checks U1, U2 on web | $0 |
| A phone browser (iPhone Safari, ideally also Android Chrome) that can reach a web build signed in to a backend | User checks U3–U5 | $0, but **blocked** until the friend-test deploy (hosted, other session) is live, or a LAN setup exists (see "Device checks") |
| Vercel (friend-test deploy, owned by another session) | Serving `manifest.webmanifest` and the icons on the phone | $0; nothing new to sign up for |
| Web push, PWA install services, an app-icon designer | **Not needed** | $0 |

Nothing new to sign up for.

## Goal
On a phone, the one thing you do most on Home, "Scan receipt", sits under your thumb. Each bill row says at a glance whose it is, when, how many people, and the amount that matters to you, and bills that need something from you sit at the top under "Waiting on you". On a phone browser the web app looks like an app: the browser bar matches the page, nothing sits under the notch or home indicator, taps don't flash, typing in a field doesn't zoom the page, and "Add to Home Screen" shows the name SplitIt.

## In scope
1. **Thumb reach:** a sticky bottom bar on Home (above the safe area) holding the one primary button "Scan receipt", and under it a quiet "Type items instead" link that opens a blank bill form.
2. **Clearer rows:** title ("Your bill" / "Sam's bill"); caption "Nov 23 · 4 people" plus the existing marker pill; amount right-aligned in tabular numerals, the viewer's own share where the data already exists (D3).
3. **Two sections:** "Waiting on you" and "Recent", defined in D4.
4. **Web only, installed feel:** `theme-color` for light and dark, `viewport-fit=cover` with safe areas honoured, no tap-highlight flash, every text input at least 16px on web, a web app manifest and an apple-touch-icon named "SplitIt".

## Out of scope (cut)
- Header or wordmark changes, empty-state redesign, skeleton loading, pull-to-refresh (user).
- Any `supabase/` change, including a participant count in `my_bills()` (Questions for the user, Q2).
- `vercel.json`, `app.json`, `app.config.ts`, `app/_layout.tsx`, `components/AppBanner.tsx`, `lib/appLinks.ts`, `lib/appBanner.ts`, `scripts/write-well-known.ts`, `package.json`, `.env.example`, `inviteUrl` and the share/invite links: owned by other sessions.
- Apple's Smart App Banner meta tag (AB-10, undecided). It stays out of `public/index.html`.
- `display: standalone` / full-screen home-screen web app (HR-13).
- A real app icon (Q1). The home-screen icon uses the existing placeholder until one exists.
- Other mobile-web fixes from the `mobile-native` skill that the user didn't ask for: `touch-action`, `overscroll-behavior`, `user-select` on controls, `interactive-widget`. Listed in `docs/before-production.md` §8 for a later pass.
- Editing `lib/homeMarkers.ts`. The new logic calls it.

## Ownership and parallel work (read before starting)
- **Do not edit** the files listed under "Out of scope" (other sessions own them). `lib/homeMarkers.ts` was just changed by the settle-early session. This slice only imports from it.
- `app/(app)/index.tsx` and `__tests__/homeMarkers.test.tsx` were last changed by the settle-early session, which has committed and isn't editing Home now. Task 5 and Task 6 own them during this slice.
- Tests: never run the full Jest suite at the same time as another session. Use `npm test -- --maxWorkers=2`, or single files (`npx jest <file>`). A failure only in files this slice didn't touch is reported as outside the task (lessons log 2026-11-24).
- The project has no formatter config. Don't run Prettier or `eslint --fix` over files (lessons log 2026-11-25).

## Design

### D1. Sticky bottom bar (Task 5)
Layout: the screen becomes a column. The existing `ScrollView` (`flex: 1`) holds the header, the added-notice card, the Venmo prompt and the bills. A bar sits **below** the `ScrollView`, outside it, so it never scrolls.

| Part | What | Source |
|---|---|---|
| Bar surface | `colors.surface` background, a hairline top border in `colors.divider`; spans the full screen width | Same pattern as the bill screen footer (`app/(app)/bills/[id]/index.tsx`, the footer with `paddingBottom: insets.bottom + space.md`) and `components/BillForm.tsx`'s footer |
| Bar padding | top `space.md`; bottom `insets.bottom + space.md`; sides `layout.screenPadding` | `useSafeAreaInsets()` (already used on Home) |
| Content column | `maxWidth: layout.content`, centered, `gap: space.sm` | `lib/theme.ts` |
| 1. Heading | `SectionHeader` titled **"Split a bill"** (the primitive sets `accessibilityRole="header"`) | HR-1. Review R2's test (`__tests__/homeMarkers.test.tsx`, "visual-pass R2") must still pass |
| 2. Primary button | `Button` label **"Scan receipt"**, `variant="primary"`, `block`, `onPress={() => router.push('/scan')}` (unchanged) | The screen's only filled button |
| 3. Link | `TextLink` label **"Type items instead"**, centred (`style={{ alignSelf: 'center' }}`), `accessibilityHint` **"Opens a blank bill to type the items yourself"** | HR-2 |

- The intro line "Take a photo of the receipt, then check the items it found." is removed (HR-1).
- "Type items instead" does what the Scan screen's `onTypeInstead` does (`app/(app)/scan.tsx:111-115`) minus the abort: `clearScanResult()` (from `lib/scanSession`), then `router.push('/bill')`. So the form always opens blank, even after an earlier scan left a result in memory. Back from `/bill` returns to Home (existing VP-M1 behaviour, unchanged).
- The `ScrollView`'s bottom padding becomes `space.xl` (the bar now covers the safe area). Top padding stays `insets.top + space.lg`.
- Nothing else on Home becomes a filled button. The notice's and the Venmo prompt's buttons keep their variants.

### D2. Row content (Task 2 computes it, Task 5 renders it)
Each row is a `ListRow` (unchanged primitive; no prop changes):

| ListRow prop | Content |
|---|---|
| `title` | `"Your bill"` when `hostId === myId`, else `"<host>'s bill"` with `<host>` = trimmed `hostName`, or `"A friend"` when null/blank (same rule as `billListLabel`) |
| `caption` (element) | a `View` (`gap: space.xs`, `alignItems: 'flex-start'`) with: (a) the caption text in `type.caption`, `colors.textMuted`, when non-empty; (b) the existing `MarkerPill` when the row has a pill. The pill is unchanged: two tones, words only, no icon (Q-GLYPH) |
| `trailing` (not interactive) | a row: an amount block (right-aligned: the amount in `type.body`, `tabularNums`, `colors.text`, weight `'600'`; under it the amount label in `type.caption`, `colors.textMuted`), then the existing chevron |
| `accessibilityRole` / `accessibilityHint` / `onPress` | unchanged: `"link"`, `"Opens this bill"`, `router.push('/bills/<id>')` |
| `accessibilityLabel` | `homeRowA11yLabel` (D5) |

**Caption text:** `[date, people].filter(s => s !== '').join(' · ')`, where `date = formatShortDate(createdAt)` and `people = peopleText(count)`:

| People count for the bill | `peopleText` |
|---|---|
| unknown (not loaded, read failed, or the bill isn't in the result) | `''` |
| 1 | `Just you` |
| n ≥ 2 | `<n> people` |

The count includes the host and the viewer: it's the number of `bill_participants` rows (D6). Examples: `Nov 23 · 4 people`; `Nov 23` (count unknown); `4 people` (date unreadable).

### D3. Shared contract: the row's amount (Task 2 defines it; Task 5 renders it; criteria 9–11)
`rowAmount(summary, myId, plan)` returns `{ kind: 'share' | 'total'; cents: number }`. **First match wins:**

| Order | Condition | Result |
|---|---|---|
| 1 | `summary.hostId === myId` | `total`, `summary.totalCents` |
| 2 | no `plan`, or `plan.status !== 'ready'` | `total`, `summary.totalCents` |
| 3 | the viewer has no entry in `plan.people`, or the entry's `role === 'payer'` | `total`, `summary.totalCents` |
| 4 | the entry's `owedCents < 0` (a negative share, `payer_owes_them`) | `total`, `summary.totalCents` |
| 5 | otherwise | `share`, the entry's `owedCents` (≥ 0, read as is) |

- `plan` is the bill's `SettlePlanWithEarly` from the `settle` map Home already builds (`settleFactsOf` → `settleViewInputFor`, the same plan the Settle screen uses). **No new data and no arithmetic:** the share is read off the plan. `'early'` plans give `total` (an early share can still move as others claim; HR-3).
- Bills that aren't settle candidates (`settleCandidateIds`: 'new', 'unclaimed', payer-not-complete) have no plan, so they show `total`.
- Amount label (visible, under the figure): `share` → **`Your share`**; `total` → **`Total`**. On every row (HR-3), so a guest never mistakes the bill total for what they owe.
- Formatting only through `formatCents` (`lib/money.ts`).

### D4. Shared contract: sections (Task 2 defines; Task 5 renders; criteria 12–16)
Both sections come from the **same per-row view** that draws the pill, so a row's section and its pill can't disagree (lessons log 2026-11-25, "one status source per screen").

`homeRowView(summary, myId, facts, peopleCount)` returns `{ id, title, caption, pill: MarkerView | null, marker: HomeMarker | null, amount, amountLabel, a11yLabel, waiting: boolean }`, where:
- `marker = billMarker(summary, myId, facts?.plan)` and `pill = marker === null ? null : billMarkerView(marker, { plan: facts?.plan, viewerId: myId, nameOf: facts?.nameOf ?? noName })`. This is today's Home code (`app/(app)/index.tsx:223-228`), moved into `lib/` unchanged.
- **`waiting = pill !== null && WAITING_MARKERS.has(marker)`**, with

`WAITING_MARKERS = { 'new', 'unclaimed', 'owes', 'paid_more', 'differences' }` (exported, defined once in `lib/homeSections.ts`):

| Marker | Pill | Why it's "your move" |
|---|---|---|
| `new` | New | you were added and haven't looked |
| `unclaimed` | Nothing claimed yet | items are left and you've claimed nothing (HR-8) |
| `owes` | You owe $X | pay |
| `paid_more` | Paid · $X more to pay | pay the difference |
| `differences` | N differences to settle | (payer) settle the differences |
| `paid`, `paid_back_due`, `left_to_pay`, `settled`, no pill | (various) | Recent: waiting on others, or done |

`homeSections(rows)` splits the rows (already in `my_bills()` order) into `{ waiting: HomeRowView[]; recent: HomeRowView[] }`, **keeping the input order inside each** (a stable partition; HR-9).

| State | Home shows |
|---|---|
| loading | `SectionHeader` "Your bills" + the existing spinner card (unchanged) |
| error | "Your bills" + "Couldn't load your bills." + "Try again" (unchanged) |
| ready, 0 bills | "Your bills" + "No bills yet." (unchanged) |
| ready, ≥ 1 bill | **"Waiting on you"** (if `waiting` is non-empty), then **"Recent"** (if `recent` is non-empty). Each is a `SectionHeader` (header role) above its own `Card flush` of rows. The heading "Your bills" is not shown (HR-10) |

Headings come from `HOME_SECTION_TITLES = { waiting: 'Waiting on you', recent: 'Recent' }` in `lib/homeSections.ts`. No counts in the headings (HR-18). Dividers: `divider={i > 0}` within each card.

**When rows move between sections:** the list doesn't wait for settle data (SE-UX-14, kept). On first load, a bill whose pill comes from settle data (`owes`, `paid_more`, `differences`) shows in "Recent" until `fetchSettleData` lands, then moves to "Waiting on you" (HR-11). On a refresh, `keepCandidates` keeps each candidate's previous settle facts until the new read lands (unchanged), so rows don't move back and forth on every focus.

### D5. Shared contract: the row's screen-reader label (Task 2; criteria 17–18)
`homeRowA11yLabel` = `[title, date, people, amountPhrase].filter(s => s !== '').join(', ')`, plus `` `. ${pill.a11y}` `` when the row has a pill.
- `amountPhrase`: `share` → `` `your share ${formatCents(cents)}` ``; `total` → `` `total ${formatCents(cents)}` ``.
- Reading order matches the screen: title, caption, amount; the pill's words close the label, as they do today (BM K1, D7).

Examples (viewer `me`; host Hana; Nov 20; total 4480):

| Row | Label |
|---|---|
| guest, 'new', 3 people | `Hana's bill, Nov 20, 3 people, total $44.80. New, you haven't opened it yet` |
| guest, 'owes' (ready, owedCents 1480), count unknown | `Hana's bill, Nov 20, your share $14.80. You owe $14.80` |
| host, no pill, 1 person | `Your bill, Nov 20, Just you, total $44.80` |
| host, 'left_to_pay' (1), 2 people | `Your bill, Nov 20, 2 people, total $44.80. 1 person still has to pay you` |

This **deliberately changes** every Home row label (commas instead of " · ", the people count, the amount word). The old `billListLabel` / `billRowA11yLabel` functions stay in `lib/` (their unit tests are unchanged), but Home stops using them. Section headings are announced as headers, so a screen-reader user can jump to "Waiting on you" or "Recent".

### D6. Shared contract: people counts read (Task 1; criteria 1–6, 19–21)
`fetchPeopleCounts(billIds: readonly string[]): Promise<BillResult<{ counts: Map<string, number> }>>` in `lib/bills.ts`. It's a client read of an existing table under its existing RLS (`bill_participants_select_participant`, `20261121074115_bills_claims.sql:218-222`; table-level SELECT for `authenticated`, `20261124091041_people.sql:51`). No migration.

- Query: `supabase.from('bill_participants').select('bill_id', { count: 'exact' }).in('bill_id', ids).range(0, 999)`. Exactly the column `bill_id`, never `.select()` or `'*'`.
- `[]` → `{ ok: true, counts: new Map() }` with no request. More than 20 ids, or any id that isn't a UUID → `invalid_bill`, no request (same guard as `fetchSettleData`, reusing `SETTLE_DATA_MAX_BILLS` / `isUuid`). Duplicate ids are de-duplicated before the request.
- Cut-off guard, the same rule as `fetchSettleData` (`lib/bills.ts`, `cutOff`): data not an array, `count` not a number, `data.length < count`, or `data.length >= 1000` → `network`.
- Each row must be an object whose `bill_id` is a UUID that was asked for; anything else → `network` (whole result).
- `counts` maps each requested bill id that has ≥ 1 row to its row count. A requested id with no rows is **absent** (never 0).
- Error → `mapError('read', error)`; a thrown call → `network`. Never throws.

Home (Task 6) calls it with the same ids as the list, chained on the `latest` token like the settle read. While a refresh's read is pending, rows keep the previous counts for bills still listed. A failed read keeps the previous counts and shows no error (HR-7). Bills with no count show the date alone.

### D7. Web head (Task 3; criteria 22–30)
`web.output` is `"single"` (`app.json`), so `app/+html.tsx` isn't used. Expo's SPA build uses `public/index.html` when it exists (the template's own comment, lines 10-16). Everything in `public/` is copied into `dist/` on export (that's how `public/tesseract/` ships; verify for the new files in criterion 29).

`public/index.html` changes (keep every existing line, placeholder and the two style blocks):

| Item | Value | Notes |
|---|---|---|
| Viewport | `<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />` | Never `maximum-scale` or `user-scalable` (mobile-native skill, Hard Rule 4) |
| Theme colour, light | `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F3F4F6" />` | `colors.light.background` (HR-14) |
| Theme colour, dark | `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0B0F14" />` | `colors.dark.background` |
| Manifest | `<link rel="manifest" href="/manifest.webmanifest" />` | |
| Touch icon | `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />` | 180×180 PNG |
| Home-screen title | `<meta name="apple-mobile-web-app-title" content="SplitIt" />` | |
| Tap highlight | in the `splitit-background` style block (or a new `<style id="splitit-touch">`): `html { -webkit-tap-highlight-color: transparent; }` | react-native-web already injects the same rule at runtime (`node_modules/react-native-web/dist/exports/StyleSheet/dom/index.js:18`, checked 2026-11-26). The static rule also covers the page before JS runs, and documents it (HR-17) |

Update the template's comment block to list the new additions.

`public/manifest.webmanifest` (new):
```json
{
  "name": "SplitIt",
  "short_name": "SplitIt",
  "start_url": "/",
  "scope": "/",
  "display": "browser",
  "background_color": "#F3F4F6",
  "theme_color": "#F3F4F6",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```
- `display: "browser"` (HR-13). `background_color` / `theme_color` equal `colors.light.background` (the manifest has no dark variant).
- Icons (new files, committed): `public/apple-touch-icon.png` (180×180), `public/icons/icon-192.png`, `public/icons/icon-512.png`, resized from `assets/images/icon.png` (1024×1024, Expo's placeholder; AB-9, Q1), e.g. `sips -z 180 180 assets/images/icon.png --out public/apple-touch-icon.png` (macOS built-in; verify the source size and the output with `sips -g pixelWidth -g pixelHeight`; reword if `sips` behaves differently). Each output stays under 200 KB (starting value).

**Safe areas on web.** `react-native-safe-area-context` 5.7.0 reads `env(safe-area-inset-*)` on web (`node_modules/react-native-safe-area-context/lib/module/NativeSafeAreaProvider.web.js:93-101`, checked 2026-11-26). Without `viewport-fit=cover` those are all `0px`. With it, every screen's existing `insets.*` padding starts working on notched phones. Screens that already pad with insets: Home, bill, people, settle, activity, profile, scan, `BillForm`, `ItemSheet`. Pushed screens' native headers (`BackHeader`) pad the top through React Navigation. Task 3 doesn't change any screen; User check U4 looks at each.

**16px inputs on web.** The only `TextInput` rendered in `app/` or `components/` is in `components/ui/TextField.tsx` (Grep for `<TextInput\b` on 2026-11-26: only `components/ui/TextField.tsx:49`). Its `subtle` variant uses `type.caption` (13px). Today `subtle` is used only by the item note field (`components/BillForm.tsx:241`). On web, a `subtle` field's input uses `type.body` (16/22) instead. Native keeps `type.caption` (HR-16). `type.body` (16) and `type.title` (22) already meet the rule. The money fields use `type.body` or `type.title` (`large`), so they already do.

### D8. Privacy, RLS and money
- **One new client read:** `bill_participants.bill_id` for the viewer's own bills (≤ 20). RLS already lets every participant read every row of their bills, and the bill screen already reads them (`lib/bills.ts:638`). The count reveals nothing new. Nothing is written, logged or broadcast.
- **No money arithmetic in `app/` or `components/`.** The share is `owedCents` read off the plan; the total is `totalCents`. Both are formatted with `formatCents` in `lib/homeSections.ts`.
- **The manifest and the head** contain no user data, no secrets and no `EXPO_PUBLIC_*` values.

## Tasks
Order: **1** (data read) ‖ **2** (pure row and section logic) ‖ **3** (web head + TextField) → **4** (live check of 1) → **5** (sticky bar, after 2) → **6** (rows and sections, after 1, 2 and 5; same file as 5) → **7** (docs, after everything it describes has landed).

Files per task (shared files run one after another):

| Task | Agent | Files (all in `splitit-app`) |
|---|---|---|
| 1 | implementer | `lib/bills.ts`, `lib/bills.test.ts` |
| 2 | implementer | new `lib/homeSections.ts`, new `lib/homeSections.test.ts` |
| 3 | implementer | `public/index.html`, new `public/manifest.webmanifest`, new `public/apple-touch-icon.png`, new `public/icons/icon-192.png`, new `public/icons/icon-512.png`, `__tests__/webTemplate.test.ts`, `components/ui/TextField.tsx`, `__tests__/uiPrimitives.test.tsx` |
| 4 | implementer (`live-db-smoke` skill) | a scratchpad script only |
| 5 | product-engineer | `app/(app)/index.tsx`, new `__tests__/homeLayout.test.tsx`, plus existing tests listed in Task 5 |
| 6 | product-engineer | `app/(app)/index.tsx`, `__tests__/homeLayout.test.tsx`, `__tests__/homeMarkers.test.tsx`, `__tests__/shareAndJoin.test.tsx`, plus any test listed in Task 6 |
| 7 | docs-writer | `docs/before-production.md`, `docs/learning/concepts/design-system.md` (or a new concept note), `docs/learning/README.md`, `docs/decisions-to-review.md` |

Tasks 1, 2 and 3 touch different files and can run in parallel. Before Task 4, the main session runs `npm run db:status` and asks the user to start Docker if it's down.

### Task 1: `fetchPeopleCounts` (agent: implementer)
- `lib/bills.ts`: add `fetchPeopleCounts` per D6, next to `fetchSettleData`. Reuse `isUuid`, `SETTLE_DATA_MAX_BILLS`, `SETTLE_DATA_ROW_CAP`, `mapError` and the cut-off rule (factor the existing `cutOff` lambda into a module function if both need it; don't change its behaviour).
- `lib/bills.test.ts`: tests for criteria 1–6. Existing `fetchSettleData` tests must pass unchanged.

### Task 2: row view, sections, labels (agent: implementer)
- New `lib/homeSections.ts`: `WAITING_MARKERS`, `HOME_SECTION_TITLES`, `HOME_COPY` (`{ splitHeading: 'Split a bill', scan: 'Scan receipt', typeItems: 'Type items instead', typeItemsHint: 'Opens a blank bill to type the items yourself' }`), `peopleText` (D2), `rowTitle` (D2), `rowAmount` (D3), `homeRowView` (D4), `homeRowA11yLabel` (D5), `homeSections` (D4). Imports `billMarker`, `billMarkerView`, `MarkerView`, `HomeMarker` from `lib/homeMarkers.ts`, `formatShortDate` / `NameOf` from `lib/billView.ts`, `formatCents` from `lib/money.ts`. **Don't edit `lib/homeMarkers.ts` or `lib/billView.ts`.**
- Takes the settle facts as `{ plan: SettlePlanWithEarly; nameOf: NameOf } | undefined` (the shape Home's `SettleFacts` already has), and an injectable date formatter (as `billListLabel` does) so tests don't depend on locale.
- New `lib/homeSections.test.ts`: criteria 7–18. Build plans through `settlePlan` / `settleViewInputFor`, the functions the app uses, not by hand (lessons log 2026-11-25, "a hand-built state").

### Task 3: web head, manifest, icons, 16px inputs (agent: implementer, reading `.claude/skills/mobile-native/SKILL.md`)
- `public/index.html`, `public/manifest.webmanifest` and the three icons per D7.
- `__tests__/webTemplate.test.ts`: **extend** it (don't add a second template test). It already reads `public/index.html` and compares colours to `lib/theme.ts`. Criteria 22–27.
- `components/ui/TextField.tsx`: on web, a `subtle` field's input style uses `type.body` (D7). `__tests__/uiPrimitives.test.tsx`: criterion 28. Existing tests there must pass unchanged.
- Don't touch `app.json`, `app/_layout.tsx`, `vercel.json` or anything else outside these files.

### Task 4: live check of the counts read (agent: implementer, `live-db-smoke` skill)
- A scratchpad script with throwaway local users A, B, C. Keys loaded with `set -a; eval "$(npx supabase status -o env)"; set +a; node <script>.mjs` in one command (lessons log 2026-11-24). Criteria 19–21. Nothing written to the repo.

### Task 5: sticky bottom bar and "Type items instead" (agent: product-engineer, loading `ui-ux-designer`)
- `app/(app)/index.tsx`: D1. Copy comes from `HOME_COPY` (Task 2). If Task 2 hasn't landed, wait for it.
- New `__tests__/homeLayout.test.tsx`: criteria 31–36.
- Keep: the header (wordmark + Profile `IconButton`), the notice card above everything else in the scroll, the Venmo prompt, the focus and `AppState` refresh, the dismiss flow, and every settle-pill behaviour (`keepCandidates`, the `latest` token, pills dropping when the settle read fails; tests at the end of `__tests__/homeMarkers.test.tsx`).
- Existing tests that should pass **unchanged**: `__tests__/homeMarkers.test.tsx` "visual-pass R2" (the "Split a bill" header) and test 31 (card above "Split a bill"; the bar renders after the scroll, so the order holds), `__tests__/billForm.test.tsx:63-66` (presses "Scan receipt"). If one fails, fix the code, not the test, unless the change is one of D1's deliberate ones. List any edited line in the report.

### Task 6: rows, sections and people counts on Home (agent: product-engineer, loading `ui-ux-designer`)
- `app/(app)/index.tsx`: D2–D6. In `loadBills`, after a successful list, call `fetchPeopleCounts(ids)` alongside `fetchSettleData(candidates)`, chained on the same `latest` token and `mounted` ref. Keep a `counts` state (previous counts for still-listed bills kept during a refresh; failure keeps them). Render rows from `homeRowView` and sections from `homeSections`. `MarkerPill` stays as is.
- Tests: criteria 37–47 in `__tests__/homeLayout.test.tsx`.
- **Planned test breakage (this task updates them; list every changed line in the report):**
  - Visible titles: the row title is now the name alone. `__tests__/homeMarkers.test.tsx:270` (`/^Your bill · Nov 20 · \$44\.80$/`), `__tests__/shareAndJoin.test.tsx:273, 283, 295` (`/^Hana Lee's bill · .+ · \$6\.00$/`, `/^Your bill · .+ · \$6\.00$/`) → match the title, and where the test checks the amount, check the amount text separately.
  - Row labels (D5): `__tests__/homeMarkers.test.tsx:50, 291, 292, 707-709, 764-768, 796, 884` → the D5 format. Keep what each test checks (marker words, which rows, how many).
  - The "Your bills" heading is gone once bills exist: `__tests__/shareAndJoin.test.tsx:282` (`findByRole('header', { name: 'Your bills' })` while rows are listed) → `Recent` or `Waiting on you`, whichever the fixture produces. Tests that `findByText('Your bills')` only to wait for Home (`__tests__/inviteFlow.test.tsx:110, 116, 160, 195`, `__tests__/venmoPrompt.test.tsx:76, 124, 179`, `__tests__/billForm.test.tsx:63`, `__tests__/homeMarkers.test.tsx:143, 737`) still pass while Home is loading, but that's timing-dependent. Change them to wait for something stable (the "SplitIt" header, or the row they then use). Don't weaken what they assert afterwards.
  - Fakes: the counts read goes to `from('bill_participants')`. With no handler set, the fake answers `[]`, so counts are absent and captions show the date only. Tests that set a `bill_participants` handler for `fetchSettleData` will also answer the counts read. Assertions over **all** `__queries` (e.g. "no reads when there are no candidates") must be narrowed by the `select` columns. Never delete an assertion.
- Accessibility: compare each row's and heading's role, label and hint before and after (lessons log 2026-11-25, "Restyles dropped heading roles").

### Task 7: docs (agent: docs-writer; after Tasks 1–6 land)
Hand the docs-writer this spec, the review findings and the QA report in full (lessons log 2026-11-25, "docs handoff lacked the source material").
- `docs/learning/concepts/design-system.md`: a short section "Home on a phone": the sticky action bar (one primary within thumb reach, safe-area padding), the two sections and why they derive from the pill's view model, and the web head (theme-color per scheme, `viewport-fit=cover` + `env()` insets, why inputs must be 16px, manifest `display: browser`). Add a check-yourself question. If the section gets long, make it a new concept note `docs/learning/concepts/mobile-web.md` and link it from `docs/learning/README.md`.
- `docs/before-production.md`: the items under "Before-production items" below.
- `docs/decisions-to-review.md`: update any HR row the build changed.

## Acceptance criteria

### Data: Task 1 (`lib/bills.test.ts`)
1. `fetchPeopleCounts([A, B])` makes exactly one query: `from('bill_participants')`, `select('bill_id', { count: 'exact' })`, `in('bill_id', [A, B])`, `range(0, 999)`. Rows `[{bill_id: A} ×3, {bill_id: B} ×1]` → `counts` = `{A: 3, B: 1}`.
2. `[]` → `ok` with an empty map and no query. 21 ids, or one id `'x'` → `invalid_bill` with no query. `[A, A]` → one query with `[A]`.
3. A requested id with no rows is absent from `counts` (not 0).
4. Whole result `network` for: a row with no `bill_id`, a non-UUID `bill_id`, a `bill_id` that wasn't asked for, data not an array, `count` missing or `null`, `data.length < count` (e.g. 2 rows, count 3), 1000 rows. A Postgres error `42501` → `not_allowed` via `mapError('read', ...)`; a thrown call → `network`. Server text never appears in a result.
5. `grep -rnE "\.select\(\)|select\('\*'\)" lib app components` prints nothing (run with the Grep tool on 2026-11-26 over the same paths: no matches today).
6. `npx jest lib/bills.test.ts` passes, including every existing `fetchSettleData` and `listMyBills` test unchanged.

### Pure logic: Task 2 (`lib/homeSections.test.ts`)
Fixtures: viewer `me`; host Hana (`h`); `createdAt` formatted as "Nov 20" by an injected formatter; `totalCents` 4480. Plans are built with `settleViewInputFor` / `settlePlan`.

7. `peopleText`: `undefined` → `''`; 1 → `Just you`; 2 → `2 people`; 12 → `12 people`. Caption: date + count 4 → `Nov 20 · 4 people`; count unknown → `Nov 20`; formatter returns `''` + count 4 → `4 people`; both empty → `''`.
8. `rowTitle`: host → `Your bill`; guest with `hostName` "Hana" → `Hana's bill`; `"  Hana  "` → `Hana's bill`; `null` and `"  "` → `A friend's bill`.
9. `rowAmount` gives D3 exactly on these cases:

| # | Viewer | Plan | Viewer's entry | Expected |
|---|---|---|---|---|
| A1 | host (also payer) | ready | payer | `total` 4480 |
| A2 | host, not payer | ready | owes 1480 | `total` 4480 (order 1) |
| A3 | guest | none (not a candidate) | — | `total` 4480 |
| A4 | guest | `early` (proportional, one row unclaimed) | owes 1480 | `total` 4480 |
| A5 | guest | `blocked` | — | `total` 4480 |
| A6 | guest | ready | owes 1480 | `share` 1480 |
| A7 | guest | ready | `nothing` (0) | `share` 0 |
| A8 | guest | ready | `payer_owes_them` (−100) | `total` 4480 |
| A9 | guest who is the payer | ready | payer | `total` 4480 |
| A10 | guest | ready, viewer not in `people` | — | `total` 4480 |
| A11 | guest, marked paid | ready | owes 1480, mark 1480 | `share` 1480 |

10. Boundary on the share sign: `owedCents` 0 → `share` 0 (A7); `owedCents` −1 → `total` (A8 with −1); `owedCents` 1 → `share` 1.
11. Amount label: `share` → `Your share`; `total` → `Total`. The figure is `formatCents(cents)` exactly (`$14.80`, `$0.00`, `$44.80`).
12. `WAITING_MARKERS` contains exactly `new`, `unclaimed`, `owes`, `paid_more`, `differences`. For every `HomeMarker` value, `homeRowView(...).waiting` is true iff the row's `pill` is non-null and its `marker` is in that set (checked over one fixture per marker: H1–H7 of the settle-early spec D7 plus BM H2/H3).
13. Pill and section can't disagree: for a summary whose `billMarker` is `'owes'` but whose `facts` are missing (no plan), `pill` is `null`, `marker` is `null`, and `waiting` is false. For `'owes'` with a plan where `billMarkerView` returns null (stale plan: the viewer's entry isn't `owes`), `waiting` is false.
14. `homeSections` is a stable partition: input `[r1 (waiting), r2 (recent), r3 (waiting), r4 (recent)]` → `waiting [r1, r3]`, `recent [r2, r4]`. All waiting → `recent` is `[]`; none waiting → `waiting` is `[]`; `[]` → both `[]`.
15. `homeRowView`'s `pill` equals what `billMarkerView(billMarker(summary, me, plan), ...)` returns for the same inputs (deep equal), over every fixture in criterion 12. The H2 ('new') fixture gives pill text `New`, tone `accent`.
16. `HOME_SECTION_TITLES` is `{ waiting: 'Waiting on you', recent: 'Recent' }`. `grep -rnE "'Waiting on you'|'Type items instead'" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/homeSections.ts` (run with the Grep tool on 2026-11-26 over `app`, `components`, `lib` for `'Waiting on you'|'Recent'|'Type items instead'`: no matches today).
17. `homeRowA11yLabel` gives D5's four example strings exactly.
18. Labels with missing parts: count unknown and formatter `''` → `Hana's bill, total $44.80`; a pill whose view is null → no trailing sentence.

### Web head: Task 3 (`__tests__/webTemplate.test.ts`, `__tests__/uiPrimitives.test.tsx`, files)
22. The viewport meta contains `width=device-width`, `initial-scale=1` and `viewport-fit=cover`, and the template contains neither `maximum-scale` nor `user-scalable` (Grep for `maximum-scale|user-scalable` in `public/*.html` on 2026-11-26: no matches today).
23. Exactly two `theme-color` metas: one with `media="(prefers-color-scheme: light)"` whose content equals `colors.light.background`, one with `(prefers-color-scheme: dark)` equal to `colors.dark.background` (compared case-insensitively with `lib/theme.ts`, like the existing background test).
24. The template links `/manifest.webmanifest` (`rel="manifest"`) and `/apple-touch-icon.png` (`rel="apple-touch-icon"`), has `apple-mobile-web-app-title` = `SplitIt`, sets `-webkit-tap-highlight-color: transparent` on `html`, and still has `%LANG_ISO_CODE%`, `%WEB_TITLE%`, `<div id="root"></div>`, the `color-scheme` meta and both background colours (the three existing tests pass unchanged). It has no `apple-itunes-app` meta (AB-10).
25. `public/manifest.webmanifest` parses as JSON with `name` and `short_name` `SplitIt`, `start_url` `/`, `display` `browser`, `background_color` and `theme_color` equal to `colors.light.background`, and icons 192×192 and 512×512 whose `src` files exist under `public/`.
26. `public/apple-touch-icon.png` is 180×180, `public/icons/icon-192.png` 192×192, `public/icons/icon-512.png` 512×512 (read the PNG header's width and height in the test, bytes 16–23), each under 200 KB.
27. No icon or manifest path is gitignored: `git check-ignore public/manifest.webmanifest public/apple-touch-icon.png public/icons/icon-192.png public/icons/icon-512.png` prints nothing (`.gitignore` ignores only `public/tesseract/`, `public/opencv/` and two `public/.well-known/` files today).
28. With `Platform.OS` `'web'`, a `subtle` `TextField`'s input has a flattened `fontSize` ≥ 16; with `'ios'` it keeps `type.caption` (13). Non-subtle and `large` fields are ≥ 16 on both. (Every input in the app goes through `TextField`: Grep for `<TextInput\b` in `app/**`, `components/**` on 2026-11-26 matches only `components/ui/TextField.tsx:49`.)
29. `npm run export:web` succeeds, and the built `dist/` contains `manifest.webmanifest`, `apple-touch-icon.png`, `icons/icon-192.png`, `icons/icon-512.png`, and an `index.html` with the D7 head tags. Build into the scratchpad in the same run if checking bundle contents (lessons log 2026-11-24, stale builds).
30. No JS bundle or HTML file in the export contains a secret: `grep -rE "service_role|sb_secret_" dist/` prints nothing except the documented Tesseract CDN match (CLAUDE.md).

### Live: Task 4 (local DB, throwaway users)
19. A creates X; B joins X with the link; A creates Y alone. As B, `fetchPeopleCounts([X])` → `{X: 2}`. As A, `fetchPeopleCounts([X, Y])` → `{X: 2, Y: 1}`. No call returns `network` or `not_allowed`.
20. As C (on neither bill), `fetchPeopleCounts([X, Y])` → `ok` with an empty map (RLS hides the rows; nothing leaks). As B, `fetchPeopleCounts([Y])` → empty map.
21. `select('bill_id')` on `bill_participants` doesn't fail with `42501` for an `authenticated` participant (it's the exact call `fetchPeopleCounts` makes). A then adds C to X (`addParticipant`): as B, the count becomes 3.

### Sticky bar: Task 5 (`__tests__/homeLayout.test.tsx`)
31. "Scan receipt" is rendered outside the `ScrollView` (not a descendant of it), after it in the tree, with "Split a bill" (role header) and "Type items instead" in the same bar. Exactly one `Button` with `variant="primary"` renders on Home, in every state tested here (loading, error, empty, with a notice card, with the Venmo prompt).
32. Safe area: with `SafeAreaProvider` initial metrics `insets.bottom` 34, the bar's bottom padding is `34 + space.md`; with 0 it's `space.md`. The scroll content's bottom padding is `space.xl`. (Verify how the existing tests provide insets; reword if the provider is mocked differently.)
33. "Scan receipt" pushes `/scan` once. "Type items instead" (role button, label "Type items instead", hint "Opens a blank bill to type the items yourself") calls `clearScanResult` and then pushes `/bill` once.
34. After a scan result was stored with `setScanResult(...)`, pressing "Type items instead" and rendering `/bill` shows an empty form (no scanned rows). Tested through the router on web and on iOS (`Platform.OS`), because the entry route matters (lessons log 2026-11-24).
35. The intro line "Take a photo of the receipt, then check the items it found." is gone: assert first that the bar is rendered (the "Split a bill" header is found), then that the text is absent.
36. Home still never navigates by itself: `__tests__/homeMarkers.test.tsx` test 36 (a pending invite opened on `/` resumes to the bill; Home mounting with a new bill doesn't navigate) passes unchanged on iOS and web.

### Rows and sections: Task 6 (`__tests__/homeLayout.test.tsx`, updated existing tests)
37. A guest row (host Hana, 3 participants in the counts read, marker 'new') shows the title `Hana's bill`, the text `Nov 20 · 3 people`, the pill `New`, the amount `$44.80` and the label `Total`; its `accessibilityLabel` is D5's first example. The amount `Text` has `fontVariant` `['tabular-nums']`.
38. A guest row on a ready plan with the viewer owing 1480 shows `$14.80` with `Your share` and the pill `You owe $14.80`. The same bill with an `early` plan shows `$44.80` and `Total`.
39. Sections: with bills `[new(X), host-no-pill(Y), owes(Z), paid(W)]` (list order X, Y, Z, W), Home shows the header "Waiting on you" with rows X then Z, then the header "Recent" with Y then W. With only Recent rows, "Waiting on you" isn't rendered (assert "Recent" is found first), and the other way round. Loading, error and 0 bills show "Your bills" and today's text, and neither section header.
40. A bill moves when its settle data lands: first load, Z's settle read pending → Z under "Recent" with `Total`; after it resolves → Z under "Waiting on you" with `Your share`. On a refresh (focus) with Z's new settle read pending, Z stays under "Waiting on you" (`keepCandidates`). If that refresh's settle read fails, Z's pill drops and Z moves to "Recent" (HM-5).
41. People counts: the counts read is made once per successful list load with the list's ids, after `listMyBills`, and its answer is ignored if a newer load started (the `latest` token) or Home unmounted (no `act()` warnings). A failed counts read shows no error and keeps the previous counts; a bill that left the list loses its count.
42. The settle-pill tests at the end of `__tests__/homeMarkers.test.tsx` (SE-UX-14, R4, failure drops pills) pass, with only the label-format edits listed in Task 6.
43. `__tests__/shareAndJoin.test.tsx` criterion 98 (rows open their bill; "No bills yet."), the dismiss-flow and foreground-refresh tests in `__tests__/homeMarkers.test.tsx` (criteria 33, 35, 37 of the bill-markers spec) still check the same behaviour, with only the edits listed in Task 6.
44. No interactive element in `trailing`: the amount block and chevron are plain `Text`/`View`; pressing the amount presses the row (pushes `/bills/<id>`).
45. Components do no money arithmetic: `app/(app)/index.tsx` has no `+`, `-` or `*` on a cents value, and every figure comes from `homeRowView` (reviewer check).
46. Copy and headings come from `lib/homeSections.ts` (criterion 16's grep).
47. Each section header and each row is announced as in D4/D5: `getByRole('header', { name: 'Waiting on you' })`, `getByRole('header', { name: 'Recent' })`, every row `accessibilityRole` `link` with hint `Opens this bill`.

### Whole slice
48. `npm test -- --maxWorkers=2` and `npm run typecheck` pass (not at the same time as another session's full run). A failure only in files this slice didn't touch is reported as outside the task.
49. No file outside the Task table was changed by this slice (`git status` compared with the start; in particular `app.json`, `app/_layout.tsx`, `vercel.json`, `supabase/`, `lib/homeMarkers.ts`, `components/AppBanner.tsx` are untouched).
50. Docs (Task 7): the design-system section (or new concept note, linked from the README) exists; `docs/before-production.md` has every item listed below.

### User checks (need a person; QA lists them "for the user")
- **U1. Home on a narrow desktop browser (local, two Google accounts).** In Chrome, open the dev server with the window about 390 px wide (or device emulation, as a first look only).
  1. As A: create bill X (two items), share it. As B (second browser profile): join X, claim nothing. As A: create bill Y alone.
  2. As B on Home: "Waiting on you" lists X with "Nothing claimed yet", `Total` and `$…` (the bill total); caption `<date> · 2 people`.
  3. As B: claim one item; as A: claim the other. As B back on Home: X shows "You owe $…", `Your share` and B's share under "Waiting on you" (it may first appear under "Recent" for a moment). Record whether that move is noticeable.
  4. As B: mark paid (Settle up → I paid). Home: X moves to "Recent" with "Paid $…".
  5. As A on Home: Y under "Recent" with `Just you` and `Total`. "Scan receipt" stays pinned at the bottom while the list scrolls. "Type items instead" opens a blank form.
  6. Record whether the rows feel calm, and whether `Your share` / `Total` under the amount helps or clutters.
- **U2. Screen reader** (VoiceOver on the iOS simulator, or a browser screen reader on web): heading navigation lands on "Waiting on you", "Recent" and "Split a bill"; a row reads e.g. "Hana's bill, Nov 20, 3 people, total $44.80. New, you haven't opened it yet"; "Type items instead" reads with its hint.
- **U3. iPhone Safari (blocked until a phone can reach a backend; see below).** Open the web app:
  1. The bar at the top of Safari matches the page background in light and in dark mode (switch in Control Centre, reload).
  2. Tapping a row, the Profile icon and "Scan receipt" shows the app's pressed state, no grey flash.
  3. "Scan receipt" sits above the home indicator, not under it, with Safari's toolbar expanded and collapsed (scroll to collapse it).
  4. New bill → "+ Add note" on an item → tap the note field: the page doesn't zoom. Also tap a price field and the total field.
  5. Rotate to landscape on Home and on the bill form: nothing sits under the notch.
  6. Share → Add to Home Screen: the suggested name is "SplitIt" and the icon is the placeholder (Q1). Open it from the home screen and record whether it opens in Safari or as a separate web app (HR-13, iOS version dependent), and whether you're still signed in.
- **U4. Every screen's safe areas on iPhone Safari** (blocked as U3): sign-in, join (`/b/<code>`), bill, people, settle, activity, profile, scan, the item sheet: no control under the notch or home indicator.
- **U5. Android Chrome** (if available; blocked as U3): theme colour, no tap flash, no zoom on the note field; "Add to Home screen" shows "SplitIt".

## Device checks: how the device reaches the backend
- Web on the Mac and the iOS simulator use the Mac's `http://127.0.0.1:54321` directly (U1, U2).
- A physical phone can't: `127.0.0.1` on the phone is the phone. U3–U5 wait for the friend-test deploy (Vercel + the hosted Supabase project, owned by another session; `docs/before-production.md` §5), or a LAN setup: the dev server on `0.0.0.0`, `EXPO_PUBLIC_SUPABASE_URL` set to the Mac's LAN IP, and the matching Supabase and Google OAuth redirect URLs. Nothing in this slice sets either up, so U3–U5 are **blocked** until one exists. U3 steps 1–5 don't need sign-in to look at the sign-in screen's top and bottom edges, but Home and the bill form do.

## Before-production items (Task 7 adds them to `docs/before-production.md`)
- §1 / §5: replace the placeholder home-screen and manifest icons (`public/apple-touch-icon.png`, `public/icons/*`) with the real app icon when it exists (Q1, AB-9). Same task as the native icon.
- §5: the manifest's `display` is `browser` (HR-13). Before calling the web app installable, decide on `standalone` and test Google sign-in and invite links in a home-screen web app on iOS (separate storage from Safari).
- §5: check that the host (Vercel) serves `manifest.webmanifest` with `Content-Type: application/manifest+json` (verify; most hosts map the extension, but nothing here sets it).
- §8: Home makes one more read per load (`fetchPeopleCounts`). If `my_bills()` gains a participant count later (Q2), drop the read.
- §8: mobile-web fixes not done yet (`touch-action: manipulation` on controls, `overscroll-behavior`, `user-select: none` on buttons, `interactive-widget=resizes-content`). Revisit after the friend test with what testers report.
- §7: U3–U5 (real-phone checks) are still open until a phone can reach a backend.

## Risks
1. **A row can move on first load** (HR-11). A bill whose pill comes from settle data starts under "Recent" and moves to "Waiting on you" a moment later. If someone taps in that moment they may open the wrong bill. The fix, if U1 shows it matters, is to hold the list until the settle read lands or a short timeout passes, which reverses SE-UX-14 and needs the user.
2. **The share repeats the pill** (HR-4): "You owe $14.80" next to `$14.80 Your share`. Accepted for consistency of the amount column. If it reads as noise, the cheap change is to show `Total` on rows whose pill already names an amount.
3. **Top safe area under the "Get the app" bar.** With `viewport-fit=cover`, `insets.top` becomes non-zero in a home-screen web app and in some landscape cases. `components/AppBanner.tsx` (another session) doesn't pad for the top inset, and Home adds `insets.top` below it, so with the banner showing, the banner could sit under the status bar and Home would get a second inset gap. Today the banner renders nothing (no store URL; AB-2), and with `display: browser` Safari's portrait top inset is 0, so nothing shows now. **Hand this to the session that owns AppBanner** (main session, with this risk's text).
4. **The placeholder icon** shows Expo's "A" on the home screen and in the manifest (Q1).
5. **`theme-color` on iOS 26 Safari** may be ignored in favour of the page colour (verify; U3 step 1 checks). Harmless either way: the two match.
6. **Test churn** in `__tests__/homeMarkers.test.tsx` and `__tests__/shareAndJoin.test.tsx` (labels and titles). Listed up front in Task 6. Other tests that render Home and assert on all `__queries` may surface during the run.

## Questions for the user
None of these block a task.

- **Q1. App icon.** There's no SplitIt icon yet (every icon in `assets/` is Expo's placeholder; AB-9). The home-screen icon and manifest icons will show that placeholder. Options: (a) ship the placeholder now and swap the files when a real icon exists (recommended: no design work in this slice, one file swap later); (b) a plain temporary icon, e.g. a Settle Teal tile with a white "S", made now; (c) no icon until the real one. Which do you want, and do you have an icon in mind?
- **Q2. People count from the database (later).** Home now makes one extra read for "4 people". A cleaner version adds a `participant_count` column to `my_bills()` (a small read-only change to an existing database function, a migration). `supabase/` belongs to the friend-test deploy session right now, so it isn't in this slice. Do you want that change after the deploy settles? (Recommended: yes, when `supabase/` is free; it removes a request and keeps the count in the same snapshot as the list.)

Decisions made on your behalf (HR-1 to HR-18) are in `docs/decisions-to-review.md` under "2026-11-26 · Home mobile refresh". The ones most worth a look: HR-3 (where the amount shows your share), HR-8 ("Nothing claimed yet" counts as waiting on you), HR-1 (the intro line is removed), HR-13 (manifest opens in the browser, not as a standalone app).
