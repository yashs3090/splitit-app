# Design system: tokens, primitives and the "native slop" checklist

Built on 2026-11-25 by the scan-screen redesign (`docs/specs/2026-11-25-scan-screen-redesign.md`, decisions SR-1…SR-5) and the app-wide visual pass (`docs/specs/2026-11-25-visual-pass.md`, decisions VP-1…VP-41; VP-39 replaced VP-6). Both sets of decisions are in `docs/decisions-to-review.md`, and most are still **Open** (waiting for the user's review). This note describes the code as it is on disk today.

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
| `ListRow` | One row in a grouped list: leading slot, title, caption, trailing slot, inset hairline, full-width pressed background |
| `SectionHeader` | The small muted label above a group ("Discounts", "Just now"), with the `header` role |
| `StatusLine` + `ToneIcon` | A short result or error ("Saved", "Couldn't save your claim"): icon plus words, announced to screen readers |
| `SegmentedControl` | Two or three exclusive options on a muted track ("% / $") |
| `IconButton` | A 44×44 icon-only control. `accessibilityLabel` is required |
| `TextLink` | A quiet text action with a 44-pt target ("Add note", "Make a new link") |
| `BackHeader` | Turns on the native stack header and puts our back control in it |
| `Icon`, `useFocusRing` | Helpers the others use (below) |

Also in the folder: `Banner`, `MoneyText` (money with tabular numbers), `TextField`.

A list like Home's "Your bills", built only from primitives (simplified from `app/(app)/index.tsx`):

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

## Check yourself

1. The bill screen needs a new pale blue badge. What do you do before writing any color, and what has to pass afterwards?
2. `lib/settleView.ts` wants to show "⚠ Your share changed". What should it return instead, and how does the warning icon get on screen?
3. Why does `useFocusRing` check `:focus-visible` instead of just drawing a ring whenever an element gets focus?
4. A new "Not found" state shows a light grey page in dark mode, but the rest of the screen is dark. Name two places the background could be missing.
5. Why is `divider` (1.24:1) allowed to fail the 3:1 rule while `border` isn't?

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
- In this repo: `docs/specs/2026-11-25-visual-pass.md` (the audit and plan), `.claude/skills/expo-design-system/` (token rules, native-slop list), `.claude/agents/visual-designer.md`
