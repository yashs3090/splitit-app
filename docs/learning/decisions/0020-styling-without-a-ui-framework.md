# 0020: Style with plain React Native `StyleSheet`, our own tokens and primitives; no UI framework; lucide icons

**Status:** Accepted (2026-11-25). The user: "cleanest nicest look… don't add tamagui, it will make it heavier."

Sources: `docs/specs/2026-11-25-visual-pass.md` (§1 "Visual direction", "Icons"), `docs/specs/2026-11-25-scan-screen-redesign.md` (Layout, "Icons"), decisions SR-1 and VP-1…VP-39 in `docs/decisions-to-review.md`, `.claude/skills/expo-design-system/SOURCE.md`, and the lesson "Design research: one skill vetted and installed, two declined…" (2026-11-25) in `docs/lessons/log.md`. The concept note that explains how the system works is [Design system](../concepts/design-system.md).

> SR-1 (the icon library) is still marked Open in `docs/decisions-to-review.md`. This ADR records it as accepted because the user approved P3 (icons instead of glyphs) and chose "no heavy framework" with lucide already in use. If the user changes SR-1, write a new ADR that supersedes this one.

## Context
SplitIt has about a dozen screens. People use it one-handed at a restaurant table, often in dim light, so the screens need to be calm, readable and the same everywhere.

Before the visual pass, each screen made small style choices by hand: three column widths (480/560/640), pressed opacity `0.7` copied into nine files, text glyphs like `‹ ✓ ⚠` used as icons in about 25 places. The user asked for "the cleanest nicest look" and for "a good app design ui/ux skill and framework". So we had to decide two things:

1. **How do we style screens?** Plain React Native, or a UI framework (a library that brings its own way to write styles and its own components)?
2. **Where do icons come from?**

We also needed a **checklist** that reviewers (people and agents) use to judge the look.

Words used below:
- **Design token:** a named value for a visual choice, like `space.lg` (16) or `colors.light.primary`. Screens use the name, never the number.
- **Primitive:** a small shared component built only from tokens, like `Button` or `ListRow`.
- **Styling system:** the one way an app writes styles. Two systems in one app means two places to change the same color.

## Decision

### 1. Plain `StyleSheet` + our own tokens + our own primitives
- **Tokens** live in one file, `lib/theme.ts`: `colors` (a light and a dark `Palette`), `space`, `radius`, `type`, `layout`, `iconSize`, `ICON_STROKE`, `opacity`, `focusRing`, `shadow`, `TOUCH_TARGET`, `ROW_MIN_HEIGHT`. Components read the current colors with `useTheme`.
- **Primitives** live in `components/ui/`: `Button`, `Card`, `ListRow`, `SectionHeader`, `StatusLine`, `ToneIcon`, `SegmentedControl`, `IconButton`, `TextLink`, `BackHeader`, `Icon`, `useFocusRing`, `Banner`, `MoneyText`, `TextField`.
- **Styles** are written with React Native's own `StyleSheet.create` and inline style objects, using token values. No class names, no styled-component wrappers, no theme provider from a library.
- **One source of truth.** No second styling system is ever added next to this one. A screen may change a primitive's layout (margins, `flex`) through its `style` prop, but not its colors: if it needs a new look, the primitive gets a new variant.

Example: Home's list of bills is a `SectionHeader` over a `Card flush` full of `ListRow`s (`app/(app)/index.tsx`). It has no raw numbers or colors.

### 2. No UI framework
We looked at the main options on 2026-11-25 (research on npm and GitHub that day; the facts below come from that research and are not re-checked here):

| Option | What it is | Why not (for us, now) |
|---|---|---|
| **Tamagui** | Components + a styling compiler | **The user rejected it** as too heavy |
| **NativeWind** | Tailwind CSS class names in React Native | v4 is stable but is being replaced; v5 has only release candidates, marked "not for production". Class names would be a second styling system next to `lib/theme.ts` |
| **Unistyles 3** | Closest to `StyleSheet`, with themes | Needs `react-native-nitro-modules` and a development build; not confirmed to work on Expo SDK 57 ([0009](0009-expo-sdk-57-node-20.md)) |
| **Uniwind** | Tailwind 4 for React Native | Which Expo SDK it supports wasn't stated |
| **react-native-reusables** | Copy-in components | Needs NativeWind |
| **gluestack v5** | Component library | Built on the NativeWind v5 release candidate; last published in June |
| **HeroUI Native** | Component library | Heavy, and its docs say web is "not recommended" (we ship web, [0001](0001-expo-cross-platform.md)) |
| **Restyle** (Shopify) | Typed theme + styled primitives | Would duplicate what `lib/theme.ts` already does |
| **Plain `StyleSheet` + `lib/theme.ts` + `components/ui/`** (chosen) | What we already had, made consistent | No new dependency, nothing to keep in step with the Expo SDK, one place to change a value |

The main reason is size and fit. About 15 small primitives cover every screen we have. A framework would add a dependency that must keep up with each Expo SDK, plus a second way to write styles. The `expo-design-system` skill's own rule is "never introduce a second system beside an existing one", and the `visual-designer` agent repeats it: "Never add a second styling system or a UI framework."

### 3. Icons: `lucide-react-native`, one import per icon (SR-1)
- `lucide-react-native`, pinned exactly at `1.80.0` in `package.json`. It draws icons with `react-native-svg` (already installed), so there are no icon fonts to load.
- Every icon is imported from its own file, so only that icon is bundled:

  ```tsx
  import Check from 'lucide-react-native/icons/check';   // yes
  // import { Check } from 'lucide-react-native';        // no: risks pulling in the whole set
  ```

  On 2026-11-25 the app imports **18** different icons (counted in `app/` and `components/`) out of a set of about 4,800 (the 4,800 figure is unverified).
- All icons go through the `Icon` primitive (`components/ui/Icon.tsx`), which applies `iconSize`, `ICON_STROKE` and the color, and hides the icon from screen readers.
- **Jest needs a path map.** Jest can't load the per-icon paths on its own, so `package.json` (`jest.moduleNameMapper`) maps `lucide-react-native/icons/<name>` to `node_modules/lucide-react-native/dist/cjs/icons/<name>.js`. That hard-codes lucide's internal folder layout. **Re-check it whenever lucide is upgraded**; if lucide moves its files, every test that renders an icon fails to import.

Options considered:

| Option | For | Against |
|---|---|---|
| **`lucide-react-native`** (chosen) | One light line style on iOS, Android and web; small per-icon imports; no font loading | One new dependency |
| `@expo/vector-icons` | Already installed | Icon fonts; Ionicons/Material look; fonts must load before icons show |
| `expo-symbols` | Real SF Symbols on iOS | iOS only, so Android and web need a second icon set; its web fallback is unverified |

### 4. Review checklist: Expo's `expo-design-system` skill
- Installed in `.claude/skills/expo-design-system/`, copied from `github.com/expo/skills` at a fixed commit, MIT license, no scripts. `SOURCE.md` records the origin and says our `lib/theme.ts` + `components/ui/` stay the source of truth, and that our own `ui-ux-designer` skill wins where they differ.
- Its "native slop" list (`references/native-slop.md`, 20 common mistakes in generated React Native apps) is the `visual-designer` agent's review checklist. Its audit greps (raw hex colors, raw `fontSize`, glyph icons, raw radii) gave QA before/after counts for the visual pass.
- **Declined:** `expo-native-ui`, because it tells agents to run `npx @expo/agent-cli@latest` (code downloaded from the internet at run time) and conflicts with our theme; `ui-ux-pro-max`, because it runs Python scripts and exists in many forks with no clear original.

## Consequences
- **Good:** no styling dependency to upgrade with each Expo SDK. A color, gap or radius changes in one place. New screens are built from primitives, so they look like the rest of the app.
- **Cost:** we write and maintain our own primitives (variants, focus ring, dark mode, accessibility). Things a framework gives for free, like a ready-made date picker or animated sheet, we build or pick one by one.
- **Discipline needed:** the system only holds if nobody adds raw values. Rule: if a value appears twice, it becomes a token; if an element appears on two screens, it becomes a primitive. The audit greps catch drift.
- **lucide upgrades** need the Jest path map re-checked (section 3).
- **Revisit trigger:** if we ever need a second styling system (for example, a library we must adopt that only styles one way), re-check **Unistyles 3** on our Expo SDK first, since it is the closest to `StyleSheet`. That would be a new ADR superseding this one.

## Code
- Tokens: `lib/theme.ts` (`colors`, `Palette`, `space`, `radius`, `type`, `layout`, `iconSize`, `ICON_STROKE`, `opacity`, `focusRing`, `shadow`, `TOUCH_TARGET`, `useTheme`)
- Contrast test for the tokens: `lib/theme.test.ts` (`TEXT_PAIRS`)
- Primitives: `components/ui/` (`Button`, `Card`, `ListRow`, `Icon`, `ToneIcon`, and the rest listed above)
- Icon path map for Jest: `package.json`, `jest.moduleNameMapper`
- Review checklist: `.claude/skills/expo-design-system/` (`SOURCE.md`, `references/native-slop.md`), used by `.claude/agents/visual-designer.md`

## Learn more
- React Native, `StyleSheet`: https://reactnative.dev/docs/stylesheet
- React Native, Style: https://reactnative.dev/docs/style
- Lucide for React Native: https://lucide.dev/guide/packages/lucide-react-native
- Jest, `moduleNameMapper`: https://jestjs.io/docs/configuration#modulenamemapper-objectstring-string--arraystring
- Expo skills repository: https://github.com/expo/skills
- Unistyles (for the revisit trigger): https://www.unistyl.es
- In this repo: [Design system](../concepts/design-system.md) concept note
