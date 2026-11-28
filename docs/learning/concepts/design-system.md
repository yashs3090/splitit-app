# Design system: tokens, primitives and the "native slop" checklist

Built on 2026-11-25 by the scan-screen redesign (`docs/specs/2026-11-25-scan-screen-redesign.md`, decisions SR-1…SR-5) and the app-wide visual pass (`docs/specs/2026-11-25-visual-pass.md`, decisions VP-1…VP-41; VP-39 replaced VP-6). Both sets of decisions are in `docs/decisions-to-review.md`, and most are still **Open** (waiting for the user's review). This note describes the code as it is on disk today.

*Updated 2026-11-26:* section 10, "Home on a phone", from the Home mobile refresh (`docs/specs/2026-11-26-home-mobile-refresh.md`, decisions HR-1 to HR-18, all **Open**). The web head tags from the same slice (theme colour, safe areas, 16px inputs, manifest) are in their own note, [mobile web](mobile-web.md).

*Updated 2026-11-27:* section 10 rewritten for Home groups v2 (`docs/specs/2026-11-26-home-groups-v2.md`, decisions GV-1 to GV-28). "Recent" is gone. Home now has **Waiting on you**, **Owed to you**, a collapsed **Settled**, and hidden bills. The new `DisclosureRow` primitive is in section 2.

*Updated 2026-11-28:* new section 11, "The tab bar, badges and feed colours", from the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md), spec `docs/specs/2026-11-28-tab-bar-and-activity.md`, decisions FEED-1 onward). It adds the `disputeSurface` / `dispute` tokens and `ListRow`'s `'warning'` / `'muted'` highlight with its own pressed look. Home moved to `app/(app)/(tabs)/index.tsx` and lost its sticky bar, its Groups block and its header icons, so parts of section 10 now describe history (see the note there).

## The idea

A **design system** is a small set of shared building blocks that every screen uses, so the app looks like one app. It has two layers:

1. **Design tokens.** Named values for every visual choice: colors, spacing steps, corner radii, text styles, icon sizes. A screen writes `space.lg`, never `16`. If you change a token, every screen that uses it changes too.
2. **Primitives.** Small reusable components (`Button`, `Card`, `ListRow`…) built only from tokens. Screens are built from primitives.

The rule that holds it together: **there is one source of truth.** Tokens live in one file, primitives live in one folder, and there is never a second styling system next to them.

## Why it matters here

Before the visual pass, SplitIt's screens each made small choices by hand. Three column widths (480/560/640). Pressed opacity `0.7` in nine files. Disabled opacity `0.5` in some places and `0.4` in others. Text glyphs like `‹ ✓ ⚠` used as icons in about 25 places. Every screen hand-built its own back button. In dark mode, every loading and error screen showed a light grey page.

None of these is a big bug on its own. Together, they make the app feel unfinished. People use SplitIt one-handed at a restaurant table, often in dim light. The screens need to be calm, readable and the same everywhere.

## How we use it

### 1. Tokens: `lib/theme.ts`

| Token | What it holds | Example |
|---|---|---|
| `colors.light` / `colors.dark` (type `Palette`) | Every color, as a light/dark pair with the same names | `primary` is `#0F766E` (light) and `#2DD4BF` (dark) |
| `space` | A 4-pt spacing scale | `xs 4, sm 8, md 12, lg 16, xl 24, xxl 32` |
| `radius` | Corner radii | `sm 8` inputs, `md 12` buttons, `lg 16` cards, `pill`, `inner 6` |
| `type` | The text ramp | `caption`, `body`, `label`, `headline`, `title`, `display`, `section`, `micro` |
| `layout` | Column widths and screen edge | `content 560`, `form 640`, `message 360`, `screenPadding` |
| `iconSize`, `ICON_STROKE` | Icon sizes and one stroke width | `sm 16, md 20, lg 24`; stroke `1.75` |
| `opacity` | Press and disabled look | `pressed 0.7`, `disabled 0.5` |
| `focusRing` | Keyboard focus outline | 2-pt solid line, 2 pt off the edge |
| `shadow.card` | The one shadow | `'0 1px 3px rgba(17, 24, 39, 0.08)'` |
| `TOUCH_TARGET`, `ROW_MIN_HEIGHT` | Minimum sizes | 44 and 56 |

Components read the current colors with `useTheme()`:

```tsx
const { colors } = useTheme(); // picks colors.light or colors.dark from the OS setting
<Text style={[type.body, { color: colors.textMuted }]}>Start a bill from your receipt.</Text>
```

Spacing follows a rhythm: related things sit close, groups sit further apart, sections further still. Label to value is `xs`, rows inside a card are `md`, the screen edge is `lg`, and sections are `xl` apart. The audit called the old habit of using 16 for every gap "16-Everything".

**Why no UI framework.** We looked at NativeWind (Tailwind classes), Unistyles and Tamagui, and chose plain React Native `StyleSheet` plus our own token file. The app has about a dozen screens. A token file and roughly 15 small components cover them, and we don't add a dependency or a second way to style things. The `expo-design-system` skill's rule is "never introduce a second system beside an existing one": a NativeWind class next to a `theme.ts` value means two places to change a color, and they will drift apart. The `visual-designer` agent repeats it: "Never add a second styling system or a UI framework." The full comparison, including the icon library and the review checklist, is in [ADR 0020](../decisions/0020-styling-without-a-ui-framework.md).

### 2. Primitives: `components/ui/`

| Primitive | What it is |
|---|---|
| `Button` | Variants `primary` (solid teal, one per screen), `secondary` (**tonal**: teal tint fill, teal text, no outline), `ghost` (text only), `danger` (tonal red). Options: `icon`, `block`, `loading`, and `flush` (no side padding, so the label lines up with the column edge, but still at least 44 pt wide) |
| `Card` | A hairline-edged surface for one real group. `flush`: no padding, clipped, for a list of `ListRow`s. `muted`: grey fill, no edge, for a quiet prompt |
| `ListRow` | One row in a grouped list: leading slot, title, caption, trailing slot, inset hairline, full-width pressed background. `highlight` (`'warning'`, `'muted'`, or `true` for `'warning'`) gives it a soft fill; a highlighted row dims its content when pressed instead (section 11) |
| `SectionHeader` | The small muted label above a group ("Discounts", "Just now"), with the `header` role |
| `StatusLine` + `ToneIcon` | A short result or error ("Saved", "Couldn't save your claim"): icon plus words, announced to screen readers |
| `SegmentedControl` | Two or three exclusive options on a muted track ("% / $") |
| `IconButton` | A 44×44 icon-only control. `accessibilityLabel` is required |
| `TextLink` | A quiet text action with a 44-pt target ("Add note", "Make a new link") |
| `DisclosureRow` | A section label that shows and hides the group under it: "Settled (5)" on the left, a teal "Show" + down chevron (or "Hide" + up chevron) on the right. Role `button` with an expanded state. Added 2026-11-27 for Home's Settled group (section 10) |
| `BackHeader` | Turns on the native stack header and puts our back control in it |
| `Icon`, `useFocusRing` | Helpers the others use (below) |

Also in the folder: `Banner`, `MoneyText` (money with tabular numbers), `TextField`.

A list of bills, built only from primitives (simplified; Home's real rows, now grouped into "Waiting on you", "Owed to you" and "Settled", are in section 10):

```tsx
<SectionHeader title="Your bills" />
<Card flush>
  {bills.map((b, i) => (
    <ListRow key={b.id} title={b.name} divider={i > 0} onPress={() => open(b.id)}
      trailing={<Icon icon={ChevronRight} color={colors.textMuted} />} />
  ))}
</Card>
```

**Fix the system, not the screen.** If a value appears twice, it becomes a token. If an element appears on two screens, it becomes a primitive. If a screen looks wrong, first ask whether the token or primitive is wrong. Example: the outlined `secondary` button made six screens look like wireframes. We changed `Button` once (VP-29), and every screen got calmer. There were also hand-written `edgeButton`, `ghost` and `dismiss` padding overrides in ten files. They all became the one `flush` option.

**Callers may change layout, not identity.** Every primitive takes a `style` prop and applies it last, so a screen can set margins or `flex`. If a screen needs to change a button's *colors*, the variant set is missing something. Fix `Button`, not the screen.

### 3. The no-glyph rule (VP-30)

Text glyphs (`✓ ⚠ ‹ › ▴ ▾ ◉ ○`) used as icons have three problems. They render differently on each platform (on iOS, `⚠` can show as a color emoji). They don't match our icon style. And screen readers read them aloud ("warning sign, Your share is now…").

The rule:
- `lib/` returns **plain words plus a `tone`** (`success`, `warning`, `error`, `muted`), never a glyph.
- The UI draws the icon from the tone. `ToneIcon` maps it:

```tsx
// components/ui/ToneIcon.tsx
const ICONS = { success: Check, warning: TriangleAlert, error: CircleAlert } as const;
// 'muted' draws nothing
```

- The icon is hidden from screen readers (`Icon` sets `accessible={false}`), so they hear exactly the words.

So `lib/settleView.ts` now says "Marked paid", not "✓ Marked paid". The "glyph walk" test in `lib/settleView.test.ts` checks every string in every settle model and fails if any contains a glyph. Status is also never shown by color alone: an icon and words go with it, and error and warning icons differ in shape (`CircleAlert` vs `TriangleAlert`), not just color.

### 4. Icons: lucide, one icon per import

We use `lucide-react-native` (pinned at `1.80.0`; it draws with `react-native-svg`), decided in SR-1. Every icon is imported from its own file:

```tsx
import Check from 'lucide-react-native/icons/check';        // only this icon is bundled
// not: import { Check } from 'lucide-react-native';        // risks pulling in the whole set
```

That keeps the bundle small: the app imports 18 icons out of a set of about 4,800 (the 18 counted in `app/` and `components/` on 2026-11-25; the 4,800 figure is unverified). `import type { LucideIcon } from 'lucide-react-native'` is fine, because type-only imports are removed at build time.

Jest can't load those per-icon paths directly, so `package.json` maps them to lucide's CommonJS build:

```json
"moduleNameMapper": {
  "^lucide-react-native/icons/(.*)$": "<rootDir>/node_modules/lucide-react-native/dist/cjs/icons/$1.js"
}
```

All icons go through `Icon`, which applies `iconSize`, `ICON_STROKE` and the color, and hides itself from screen readers. Sizes: 16 next to caption text, 20 next to body text and in icon buttons, 24 in badges.

### 5. Contrast: checked by a test

WCAG (the web accessibility guidelines) sets minimum contrast between two colors:
- **4.5:1** for normal text against its background.
- **3:1** for large text and for UI parts you need to see to use a control (an input's border, a focus ring).

The ratio comes from each color's **relative luminance** (how bright it looks, from 0 for black to 1 for white). `lib/theme.test.ts` computes it the way WCAG defines it:

```ts
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;   // green counts most: eyes are most sensitive to it
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; // brighter first
  return (hi + 0.05) / (lo + 0.05);   // 1 (same color) up to 21 (black on white)
}
```

The test runs every text pair in `TEXT_PAIRS` (e.g. `primary` on `primarySurface`, used by tonal buttons: 4.84 light, 7.80 dark) against 4.5:1 in **both** light and dark, plus the focus ring against 3:1. Change a color in `lib/theme.ts` and the test tells you if it broke a pair. (WCAG now writes the threshold as 0.04045 instead of 0.03928. WCAG says the change makes no practical difference.)

`border` (input edges) is 3.74:1 on `surface`, so you can see where to type. `divider` (row hairlines) is only 1.24:1, so it may only decorate. It must never be the only thing that shows where a control is.

### 6. Dark mode: paint every layer

Swapping `colors.light` for `colors.dark` isn't enough. Anything that doesn't paint its own background shows whatever is underneath, and the default underneath is light. We had to set the background at four levels:

| Layer | Fix | Where |
|---|---|---|
| The stack's screen container | `contentStyle: { backgroundColor: colors.background }` | `app/_layout.tsx`, `app/(app)/_layout.tsx`, `app/(auth)/_layout.tsx` |
| Loading / error / one-message screens | `Centered` paints `colors.background` itself | `components/Centered.tsx` |
| The native root view (seen behind screens during transitions) | `expo-system-ui`'s `SystemUI.setBackgroundColorAsync(colors.background)` | `app/_layout.tsx` (VP-20) |
| The web page before the app loads | `<meta name="color-scheme" content="light dark">` and a `prefers-color-scheme` page background | `public/index.html` (VP-20); `__tests__/webTemplate.test.ts` keeps its colors equal to `lib/theme.ts` |

Why `public/index.html` and not `app/+html.tsx`: our web build is a single-page app (`web.output: "single"`), and `+html.tsx` only applies to static output.

### 7. Focus ring: only for the keyboard

People who use a keyboard (on web, or with a hardware keyboard on a tablet) need to see which control has focus. But a ring that appears after every mouse click looks like a bug. Browsers solve this with the CSS `:focus-visible` state: it matches when focus came from the keyboard, not from a click.

`useFocusRing` (in `components/ui/useFocusRing.ts`) asks the browser the same question:

```ts
// on web: draw only if the browser would show a ring here
return native?.target?.matches?.(':focus-visible') ?? true;
```

If `matches` isn't available it draws the ring anyway (better one ring too many than none). On iOS and Android, focus only happens through a keyboard or switch control, so it always draws. Every primitive uses this hook, so the ring looks the same everywhere (VP-8, VP-13). Rows draw it inside their edge (`outlineOffset: -2`), because the card around them clips anything outside.

### 8. Native headers and the native sheet

**Headers.** Before, every pushed screen set `headerShown: false` and drew its own "‹ Bill" button (the "Hand-Rolled Header" tell). Now `BackHeader` turns on the real native stack header. The system then handles the safe area and the iOS back-swipe. The bar is styled once in `app/(app)/_layout.tsx` (page background, no hairline, teal tint). Our own back control (`HeaderBack`) still goes inside it, because each screen's back handler also works on a cold deep link with no history, where the system's back button wouldn't appear (VP-11).

**Item sheet.** On iOS, `components/ItemSheet.tsx` uses the system page sheet, so people can swipe it down like any iOS sheet:

```tsx
<Modal presentationStyle="pageSheet" allowSwipeDismissal={!editing} onRequestClose={onClose}>
```

`allowSwipeDismissal` is iOS-only and needs `onRequestClose`. We turn it off while "Split differently" is open (VP-37a), so a swipe can't silently throw away an unsaved split. Save, Cancel or Done turn it back on. Android and web keep the drawn bottom sheet over a dimmed background (VP-38).

**QR sheet.** `components/QrSheet.tsx` (the invite QR popup, 2026-11-27) uses the same split: iOS page sheet, Android/web bottom sheet over a scrim. Two things it adds:
- It stays mounted and toggles `visible`, instead of being mounted only while open. That lets the sheet slide out, and on iOS gives `onDismiss`, which fires only after the sheet has finished sliding away. That is the moment to move VoiceOver back to the "Show QR code" link (`AccessibilityInfo.sendAccessibilityEvent(ref, 'focus')`); doing it earlier lands on a view that is still covered. Android does it as soon as `visible` turns false. On web, React Native Web's `Modal` has its own focus trap that moves focus into the sheet and gives it back to the opener on close, so the sheet doesn't do it again.
- The scrim is `focusable={false}`: on web it isn't a Tab stop (Escape closes instead), so the focus trap lands on the sheet's first real control.

### 9. "Native slop": a review checklist

The `expo-design-system` skill (`.claude/skills/expo-design-system/references/native-slop.md`) names 20 common mistakes in generated React Native apps. The `visual-designer` agent uses them as its review checklist. Examples we found and fixed:

| Tell | What we had | Fix |
|---|---|---|
| **Dark-Mode Amnesia** | Loading and error screens showed light grey in dark mode | Backgrounds painted at every layer (section 6) |
| **The Hand-Rolled Header** | `headerShown: false` and six hand-built "‹ Back" buttons | Native header via `BackHeader` |
| **Wireframe Borders** | Grey-outlined secondary buttons everywhere | Tonal buttons; outlines only on inputs |
| **Emoji Iconography** | `⚠` and `ℹ` glyphs, which can render as color emoji on iOS | lucide icons, drawn from a tone |
| **Everything's a Card** | Home was three stacked cards; a panel inside a card | Plain text on the page, grouped `Card flush` lists, muted cards for prompts |
| **The X-Button Sheet** | The item sheet closed only with a button | iOS page sheet with swipe-down to close |

These are prompts to check, not bans. Cards, borders and shadows are fine where they do a job. The scan screen's choice cards keep `shadow.card`, because in SplitIt a shadow means "this whole surface is tappable" (SR-5, VP-24).

### 10. Home on a phone (2026-11-26, groups v2 2026-11-27)

*Note 2026-11-28 (tab bar, [ADR 0025](../decisions/0025-tab-bar-and-activity.md)):* Home is now the **Tabs** tab, at `app/(app)/(tabs)/index.tsx`. The sticky action bar described below is gone: the raised (+) in the tab bar replaced it (FEED-19, which supersedes HOME-ADD-1; the bar's "Scan receipt" button had already become one "Add receipt" button on 2026-11-27). Home's Groups block and its Groups/Profile header icons are gone too: those are tabs now. The bill groups, rows, amounts, first-load wait and `DisclosureRow` below are unchanged. The sticky-bar paragraphs are kept as history.

People use SplitIt one-handed at the table. Two slices shaped Home. The Home mobile refresh (2026-11-26) added the sticky bar and the new rows. Home groups v2 (2026-11-27, spec `docs/specs/2026-11-26-home-groups-v2.md`) replaced its two sections with groups based on money. The screen is `app/(app)/index.tsx`, and the logic is in `lib/homeSections.ts`. Copy and headings come from that file (`HOME_COPY`, `HOME_SECTION_TITLES`), so no screen writes them twice.

**A sticky action bar under the thumb (HR-1, HR-2).** The thing you do most on Home is start a bill, and the easiest place to reach with your thumb is the bottom of the screen. So Home is now a column: the `ScrollView` (header, notice card, Venmo prompt, bills) fills the top, and a bar sits **below** it, outside the scroll, so it never moves. The bar holds three things:
1. a `SectionHeader` "Split a bill" (it keeps the `header` role, so a screen-reader user can jump to it);
2. the `Button` "Scan receipt", `variant="primary"`, `block`. It's the **only** filled button on Home, so there's one obvious action;
3. a `TextLink` "Type items instead" (hint "Opens a blank bill to type the items yourself"). It calls `clearScanResult()` and then opens `/bill`, so the form is always blank even if an earlier scan left a result in memory.

The bar pads its bottom by `insets.bottom + space.md`, so the button sits above the iPhone home indicator instead of under it. The scroll's own bottom padding drops to `space.xl`, because the bar now covers the safe area. The old intro line ("Take a photo of the receipt…") was removed to keep the bar short. Even so, the bar is about 146 pt tall plus the bottom inset, more than the spec's first estimate of about 100 pt. That's a lot of a small phone's screen, so user check U1 looks at it.

**Rows say what matters at a glance (D2, D3).** Each bill is a `ListRow` (the primitive didn't change):

| Part | Example | Where it comes from |
|---|---|---|
| Title | `Your bill` / `Hana's bill` | `rowTitle` |
| Caption | `Nov 23 · 4 people`, then the marker pill | `rowCaption` / `peopleText` ("Just you" for 1). The count is `fetchPeopleCounts` in `lib/bills.ts`, one extra read per Home load; unknown counts show the date alone |
| Amount, right-aligned, tabular numbers | `$14.80` with **Your share** under it, `$8.00` with **To collect**, or `$44.80` with **Total** | `rowAmount` |

`rowAmount` shows **your share** only for a guest (not the host, not the payer) on a bill whose settle plan is `ready`, when the share is $0 or more. It shows **To collect** for a payer whose row is in Owed to you (below). Everything else shows the bill total. The share is read straight off the plan Home already builds for the pills. No new data and no arithmetic in the screen. Every amount has its label, so a guest never mistakes the bill total for what they owe (HR-3).

**Groups, from what's owed (groups v2, decisions GV-1 to GV-20).** Every bill lands in exactly one place:

| Group | What's in it | Example |
|---|---|---|
| **Waiting on you** | Bills where you still have to pay someone, or will once you can: a new bill you were added to, nothing claimed yet, "You owe $14.80", "Paid · $1.10 more to pay", and "Claimed · not ready to pay" | Sam claimed the fries on Hana's bill and hasn't paid |
| **Owed to you** | Bills where someone still owes you: you're the payer and someone hasn't paid, or you're a guest the payer owes money back | Hana paid; Dee still owes her $5.00 |
| **Settled** (collapsed, with a count) | Only bills **you paid for** where everyone has paid you | Hana's bill after Sam and Dee both paid |
| **Hidden** (not drawn, only counted) | Guest bills where you've paid your whole share, even if others haven't | Sam's view of Hana's bill after Sam paid |

The rule behind it: **the group comes only from your balance on the bill. The pill is only a label** (user rules 6 and 7). `viewerBalance` reads two yes/no facts off the bill's settle plan:
- `owes`: do you still owe anyone? (An unpaid share, or a share that went up after you paid.)
- `owed`: does anyone still owe you? (Someone who hasn't paid you, someone whose share went up, or a payer who owes you money back.)

Then `homeGroup` picks the group. First match wins:

```ts
// lib/homeSections.ts, homeGroup (simplified)
if (!b.known) return payer ? 'owed' : 'waiting';   // no plan yet: never hide or settle on a guess (GV-5)
if (b.owed) return 'owed';                         // someone owes you (checked before owes, GV-2)
if (b.owes) return 'waiting';                      // you owe someone
if (!payer) return !b.final && !summary.claimedAny ? 'waiting' : 'hidden';  // review R2, below
return b.final ? 'settled' : 'owed';               // payer: Settled only on a finished (ready) plan
```

Both yes/no facts use `differenceOf` from `lib/settle.ts`, so a 1¢ change doesn't count (`SETTLE_DIFF_IGNORE_CENTS`). There's no adding up of money here, only "is there at least one…".

*Why the balance and not the pill?* An earlier idea grouped rows by marker kind (the old `WAITING_MARKERS` list). The user reversed it: "after Sam pays it should move out, since she isn't owed for the bill anymore." Grouping on what's owed also makes bills **come back on their own**. If Hana raises the fries from $10 to $12 after Sam paid, Sam's share goes up, his `owes` turns true, and the bill comes back to Waiting on you with "Paid · $X more to pay". Nobody has to clear a "hidden" flag, because there isn't one (rule 6).

*Review R2 (user rule 1).* A host who isn't the payer and hasn't claimed anything yet owes $0 on a bill that's still being claimed. The balance says "zero", but that zero isn't final. So that bill stays in Waiting on you as "nothing claimed yet" instead of disappearing. A guest bill is hidden only once the plan is final, or once you've claimed something and owe nothing.

**The pill can't disagree with the group.** The group and the marker both read **the same plan**. `MARKER_GROUPS` records which groups each pill may appear in, for example `paid_more: ['waiting']` and `settled: ['settled']`. Tests check every fixture against it. It's typed as a full `Record<HomeMarker, …>`, so adding a new marker kind fails `npm run typecheck` until someone adds its line. The old hand-written list didn't fail like that when the Sent-via-Venmo session added `sent` and `not_received`.

**One "am I the payer?" check.** Every payer comparison in `lib/homeSections.ts` goes through `viewerIsPayer`. A ready or early plan is the newer read, so its payer wins; otherwise the bill summary's. Multi-payer bills (backlog item 4) would change this helper and the payer branch of `viewerBalance`, and nothing else.

**To collect (A1.M2, user decision; GV-22, GV-23).** On a payer's row in Owed to you with a `ready` plan, the figure is what's still coming in, labelled **To collect**. `stillToCollectCents(plan, myId)` adds every other person's unpaid share plus every "more" difference. Example: Sam hasn't paid his $5.00, and Dee paid $3.00 but her share later went to $3.50. Hana's row shows **$5.50 To collect**. Money Hana owes back is **not** subtracted: the figure answers "how much is coming to me?" (GV-22). It uses the same 1¢ tolerance as `owed`, so "To collect" is above $0 exactly when the row is in Owed to you. Early, blocked and no-plan payer rows, and Settled rows, keep **Total**, because those shares can still move. It's the only money sum in the file. The spec called it `collectCents`; it was built as `stillToCollectCents` because `lib/settle.ts`'s ready plan already has a `collectCents` field that means something else (the sum of every positive share, paid or not).

**The first load waits a moment (A1.M3, user decision; GV-24, GV-28).** The groups need the settle plans, which come from a second read after the bill list. Without plans, a paid-up guest bill would show under Waiting on you and then disappear, and a settled bill would sit under Owed to you and then fold away. That's rows jumping while someone reaches to tap them. So on the **first** load of each Home visit, Home keeps showing the "Your bills" spinner until the first settle read lands, or until `FIRST_SETTLE_WAIT_MS` (1000 ms, a starting value) has passed since the list arrived. Whichever comes first ends the wait, and the timer is cleared on unmount. If the wait times out, or the first read fails, Home shows the safe fallback (GV-5): no plan means a guest bill in Waiting on you with no pill and a payer bill in Owed to you. Nothing is hidden or collapsed on a guess. Later refreshes (coming back to Home, the app returning to the front) **never wait**.

**A failed refresh keeps what you saw (A1.S5, user decision).** If a refresh's settle read fails, Home keeps the previous plans (`keepCandidates` in `app/(app)/index.tsx`), so no row moves and no error shows. The cost: a pill can be one refresh out of date. There's one exception (review R3). If the new bill list names a different payer than a kept plan does, that plan is dropped. Otherwise the old plan would win in `viewerIsPayer` and put the row in the wrong group.

**The Settled toggle is `DisclosureRow` (A1.M1, S1, S2, S6, S8).** `components/ui/DisclosureRow.tsx` is a shared primitive. Splitit-app-52's "Hidden groups" is meant to reuse it.
- *Look.* The label "Settled (3)" is styled like a section heading. On the right are a teal **Show** with a down chevron, or **Hide** with an up chevron. It never uses a right chevron, because on Home a right chevron means "opens a screen". The row is at least 44 pt tall, and a negative vertical margin (`DISCLOSURE_ROW_MARGIN`, worked out from the tokens) keeps the label on the same 24-pt grid as the other headings.
- *Screen readers.* It's a `button`, not a header, because React Native gives an element one role and the open/closed state needs the button role. It reads "Settled, 3 bills", with the hint "Shows bills everyone has paid you for" (or "Hides settled bills"). The Show/Hide word and the chevron are hidden from screen readers, because the expanded state and the hint already say it.
- *aria on web (review R1).* react-native-web 0.21 (installed: 0.21.4) doesn't turn `accessibilityState` into `aria-expanded`, and it ignores `accessibilityHint`. You can check this in its `createDOMProps`, which reads `aria-expanded` but never `accessibilityState.expanded`. So `DisclosureRow` also passes `aria-expanded={open}`. React Native supports the same prop on native too. It also passes `aria-hidden` on the Show/Hide part, since web ignores `importantForAccessibility`. The hint is still lost on web (`docs/before-production.md`).
- *Scrolling on open (A1.S2, reviews R4 and R6).* Opening Settled near the bottom of the screen would put the new rows under the sticky bar. So Home scrolls just enough to show the first settled row, and only when opening, never when closing. It waits for the opened card's `onLayout` (R4), because a browser limits `scrollTo` to the current content height, and before the card lays out it isn't counted yet. The target (`settledScrollTarget`) starts from where the Settled block's layout begins. That's the toggle's label line, not its 44-pt target, because the negative margins pull the target 13 pt past each edge. So the formula is `toggleY + TOUCH_TARGET + 2 × DISCLOSURE_ROW_MARGIN` (44 − 26 = 18 pt, one label line), then the gap and one row (review R6). The spec's first version (criterion 29a) left out the two margins and scrolled 26 pt too far.
- *Reduce Motion.* The scroll animates only when Reduce Motion is off. `AccessibilityInfo.isReduceMotionEnabled()` and its `reduceMotionChanged` event work on web too: react-native-web reads the browser's `prefers-reduced-motion` setting. Nothing else on Home animates (A1.S8). Rows change group, and Settled opens and closes, with no motion.
- *State (GV-11).* Settled starts collapsed on every Home mount. It stays open while you visit a bill and come back, and it isn't saved on the device.
- *Rows inside Settled (A1.S3)* show no visible "Settled up" pill, because the toggle already says it. Each row's screen-reader label still ends with "Settled up, everyone has settled up with you", because the toggle isn't a heading.

**When nothing is waiting or owed (GV-13).** Home shows a card, "You're all caught up.", plus "Bills you've paid don't show here." when some are hidden. Then it shows the Settled toggle if there is one. So Home never looks empty while you have bills. "Your bills" still appears only while loading, on an error and with no bills.

**Order on screen (GV-14):** notice → Venmo prompt → all-caught-up card (if shown) → Waiting on you → Owed to you → **[Groups slot]** → Settled. The Groups slot is a comment in `groupBlocks` where splitit-app-52's block will go. Its filter on the bill list goes before `homeRowView`. The blocks are one keyed list, so a block keeps its place when another one appears or goes.

*History (2026-11-26, superseded).* The mobile refresh first split Home into "Waiting on you" and "Recent". It decided the section from the pill, using a fixed set of marker kinds (`WAITING_MARKERS`, decision HR-8). It also showed the list before the settle data arrived, so a row could jump from "Recent" to "Waiting on you" on first load (HR-11). Groups v2 replaced both decisions: groups now come from the balance, and the first load waits (above).

**Screen reader label (D5, HR-12).** Each row reads in screen order, with commas as pauses: "Hana's bill, Nov 20, 3 people, total $44.80. New, you haven't opened it yet" (`homeRowA11yLabel`). A payer's Owed-to-you row says the amount as "to collect $8.00", for example "Your bill, Nov 20, 3 people, to collect $8.00. 2 people still have to pay you".

### 11. The tab bar, badges and feed colours (2026-11-28)

*From the tab bar and Activity feed ([ADR 0025](../decisions/0025-tab-bar-and-activity.md)). The feed's logic is in [activity feed and badges](activity-feed-and-badges.md).* The user approved these visuals on the web app on 2026-11-28.

**The bar.** `components/TabBar.tsx` draws our own bar for Expo Router's `Tabs` (the `tabBar` prop in `app/(app)/(tabs)/_layout.tsx`). Five slots: **Tabs · Groups · (+) · Activity · Profile**, with lucide icons `receipt`, `users-round`, `plus`, `bell` and `circle-user-round`. The buttons are in `components/TabBarButtons.tsx`; the slots and labels come from `lib/tabBar.ts` (`tabSlots`).
- The bar sits on `surface` with a `divider` hairline on top, and pads its bottom by the safe-area inset, so it clears the iPhone home indicator.
- The selected tab's icon and label are `primary`; the others are `textMuted`. The selected label is also a little heavier, so selection isn't shown by colour alone.
- **(+)** is a raised `primary` circle with a `surface`-coloured ring and `shadow.card`. It rises `space.lg` above the bar's top edge. It's a button, not a route: it pushes `/scan`.
- Below 300 px wide (`tabBarLayout`), the labels hide, a count shows as a dot, and the (+) shrinks to 44 pt. The screen-reader labels don't change.
- On Android, the bar hides while the keyboard is up, so it doesn't sit on top of Profile's Venmo field.

**Screen readers and web.** On native, each tab has role `tab` and `accessibilityState.selected`. react-native-web drops `accessibilityState` and hints, so on web each tab is a link with `aria-current="page"` when selected, and Enter and Space activate it. The badge goes **in the label** ("Activity, 3 new", "Groups, new activity"), because the hint would be lost on web.

**Badge tokens.** There's no new badge colour. A count badge is a `primary` pill with `onPrimary` digits (11 pt, tabular numbers), 18 pt tall, on the icon's top-right corner. The Groups dot is a 12 pt `primary` circle. Both have a 2 pt ring in `surface`, so they stand apart from the icon. They're hidden from screen readers, because the label already says it. `badgeText` caps a count at "9+".

**The dispute tokens.** A feed line where someone says "Ana says they didn't get your $30.00" needed its own colour. Red (`danger`) is saved for app errors, and the user asked for "a light orange". So `lib/theme.ts` has a new pair:

| Token | Light | Dark |
|---|---|---|
| `disputeSurface` (the marker's fill) | `#FFF6ED` | `#3A1D0B` |
| `dispute` (the icon) | `#C4320A` | `#FDBA8C` |

`lib/theme.test.ts` checks, in both schemes, that `dispute` is at least 3:1 on `disputeSurface` (enough for an icon) and at least 4.5:1 on `disputeSurface`, `surface` and `background` (enough for text, if text is ever drawn in it). It also checks the pair isn't the same as `danger` / `dangerSurface`.

**Feed markers: colour only while unread.** `FEED_MARKER_TONES` in `lib/feedText.ts` is the one map from a line's tone to its two tokens, and only `components/FeedMarker.tsx` reads it. Unread "needs you" is `warningSurface` / `warning`, unread money is `successSurface` / `success`, unread dispute is `disputeSurface` / `dispute`. Everything else, and **every line you've seen**, is `surfaceMuted` / `textMuted`. The icon stays, so the meaning stays. The feed has no row backgrounds, bold text or coloured text.

**Tinted `ListRow`s, and the pressed look.** The Groups list tints two kinds of row (user U10, FEED-20; this reversed GCS-7):
- a group where you need to claim: `highlight="warning"` (`warningSurface`);
- a settled group: `highlight="muted"` (`surfaceMuted`), plus a `check` icon next to "Settled up". The title stays in `text` and isn't dimmed.

Every other row (you owe, you're owed, waiting, loading) stays plain.

There was a catch. A plain `ListRow` shows "pressed" by painting `surfaceMuted` behind the row. That's exactly the settled row's fill, so a settled row would look stuck pressed, and pressing it would show no change. So a **highlighted** row keeps its fill when pressed and dims its content to `opacity.pressed` (0.7) instead. A plain row still gets the grey pressed background. `highlight={true}` still means `'warning'`, so older callers look the same as before.

```tsx
// components/ui/ListRow.tsx (simplified)
const tint = hue === null ? null : { backgroundColor: hue === 'muted' ? colors.surfaceMuted : colors.warningSurface };
style={({ pressed }) => [styles.row, tint, pressed && hue === null && { backgroundColor: colors.surfaceMuted }]}
{({ pressed }) => renderContent(pressed && hue !== null)}   // dims the content to opacity.pressed
```

## Pitfalls

- **Raw values in a screen.** `padding: 16` or `color: '#fff'` bypasses the system and breaks in dark mode. Use a token. If no token fits, add one to `lib/theme.ts` (with a reason) instead of a literal.
- **Fixing one screen.** If a `Button` looks wrong on one screen, overriding its colors there leaves every other screen different. Change the primitive or add a variant.
- **Glyphs sneaking back into copy.** A `✓` in a `lib/` string is read aloud and bypasses `ToneIcon`. Return words plus a `tone`.
- **Importing from the lucide package root.** `import { Check } from 'lucide-react-native'` risks pulling in the whole icon set. Use the per-icon path.
- **Trusting one color scheme.** A pair can pass in light mode and fail in dark. VP-6 found this: in dark mode `surface` is *darker* than `surfaceMuted`, so a "white segment on a grey track" would look like a hole. Check both, and add new text pairs to `TEXT_PAIRS`.
- **Forgetting a background layer.** A new layout or full-screen state that doesn't set `contentStyle` or use `Centered` brings back the light flash in dark mode.
- **A focus ring on every click.** Drawing the ring on any `onFocus` puts rings on mouse clicks on web. Use `useFocusRing`.
- **Icon-only controls with no label.** A screen reader can't describe a picture. `IconButton` makes `accessibilityLabel` required for this reason.
- **Interactive things inside a tappable row.** A button inside a `ListRow` that has `onPress` can't be reached by screen readers or the keyboard. Put the action in `trailing` and leave `onPress` unset.
- **Grouping on the pill, or a second grouping rule in the screen.** If the screen sorts rows by marker kind or pill text, a new pill can quietly move bills to the wrong group. And a "settled" pill would keep a bill folded away after its money changed. Groups come only from `homeGroup` (the balance). The screen reads `row.group` and never looks at `plan.people`, marks or `differenceOf` (spec criterion 38). If a pill and a group seem to disagree, fix the marker or `MARKER_GROUPS`, not the screen.
- **Hiding on a guess.** Treating "no plan yet" as "paid up" would hide a bill you still owe on. No plan means Waiting on you (guest) or Owed to you (payer) until a plan confirms a zero balance (GV-5).
- **Comparing payer ids outside `viewerIsPayer`.** A second `payerId === myId` check is one more place multi-payer bills have to find and fix, and it can disagree with the plan's newer payer.
- **Trusting `accessibilityState` on web.** react-native-web 0.21 drops it, and drops `accessibilityHint` too. For a disclosure, pass `aria-expanded` as well (`DisclosureRow` does). `components/SharesSummary.tsx` still doesn't (`docs/before-production.md`).
- **Scrolling before layout.** Calling `scrollTo` right after `setState` aims at content that isn't laid out yet, and a browser stops at the old content height. Scroll from the new content's `onLayout`.
- **A bottom bar inside the `ScrollView`.** It scrolls away with the list. A sticky bar goes after the `ScrollView`, and it pads for `insets.bottom` itself.
- **A fill that equals the pressed colour.** If a row's resting fill is the same token as the pressed background, pressing shows nothing and the row looks stuck. Give tinted rows a different pressed look (`ListRow` dims the content).
- **Reaching for red for "something's wrong with a payment".** Red means the app failed. A dispute between friends uses the light-orange `dispute` pair.
- **Putting a badge only in the icon.** Screen readers can't see the mark, and web drops hints. Say the count in the tab's label.

## Check yourself

1. The bill screen needs a new pale blue badge. What do you do before writing any color, and what has to pass afterwards?
2. `lib/settleView.ts` wants to show "⚠ Your share changed". What should it return instead, and how does the warning icon get on screen?
3. Why does `useFocusRing` check `:focus-visible` instead of just drawing a ring whenever an element gets focus?
4. A new "Not found" state shows a light grey page in dark mode, but the rest of the screen is dark. Name two places the background could be missing.
5. Why is `divider` (1.24:1) allowed to fail the 3:1 rule while `border` isn't?
6. Sam is a guest on Hana's bill. The bill is complete and Sam owes $14.80. What does his Home row show in the amount column and under which group? What does he see if the very first settle read fails, and what if a later refresh's read fails?
7. Sam has paid his $14.80, so the bill is hidden for him. Hana then edits an item and Sam's share becomes $16.20. Where does the bill appear on Sam's Home, and why didn't anyone have to "un-hide" it?
8. Hana is the payer. Dee hasn't paid her $5.00, and Hana owes Sam $1.00 back. Which group is the bill in for Hana, and what does the amount column say?
9. Why does `DisclosureRow` pass `aria-expanded` when it already sets `accessibilityState={{ expanded: open }}`?
10. A settled group row uses `surfaceMuted` as its fill. What would pressing it look like if `ListRow` used its normal pressed background, and what does it do instead?
11. "Ana says they didn't get your $30.00" is unread. What colours does its marker use? What changes once you've seen it, and what stays the same?
12. Why does the Activity tab's screen-reader label say "Activity, 3 new" instead of putting "3 new" in a hint?

## Learn more

- WCAG 2.2, Understanding 1.4.3 Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- WCAG 2.2, Understanding 1.4.11 Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- WCAG relative luminance definition: https://www.w3.org/WAI/WCAG22/#dfn-relative-luminance
- MDN, `:focus-visible`: https://developer.mozilla.org/en-US/docs/Web/CSS/:focus-visible
- React Native `Modal` (`presentationStyle`, `allowSwipeDismissal`): https://reactnative.dev/docs/modal
- Expo System UI: https://docs.expo.dev/versions/latest/sdk/system-ui/
- Expo Router, Stack (header options): https://docs.expo.dev/router/advanced/stack/
- Lucide for React Native: https://lucide.dev/guide/packages/lucide-react-native
- Expo, applying design principles in app development: https://expo.dev/blog/how-to-apply-professional-design-principles-in-ai-app-development
- [Mobile web](mobile-web.md): the web head tags, safe areas on web and 16px inputs
- `react-native-safe-area-context` (`useSafeAreaInsets`): https://appandflow.github.io/react-native-safe-area-context/
- React Native `AccessibilityInfo` (`isReduceMotionEnabled`, `reduceMotionChanged`): https://reactnative.dev/docs/accessibilityinfo
- React Native accessibility props, including the `aria-*` props: https://reactnative.dev/docs/accessibility
- MDN, `aria-expanded`: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded
- MDN, `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- Expo Router, tabs (custom tab bars): https://docs.expo.dev/router/advanced/tabs/
- MDN, `aria-current`: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-current
- In this repo: `docs/specs/2026-11-28-tab-bar-and-activity.md` (the tab bar, Contract M), `docs/specs/2026-11-26-home-groups-v2.md` (the groups, amendment A1), `docs/specs/2026-11-26-home-mobile-refresh.md` (Home on a phone), `docs/specs/2026-11-25-visual-pass.md` (the audit and plan), `.claude/skills/expo-design-system/` (token rules, native-slop list), `.claude/agents/visual-designer.md`
