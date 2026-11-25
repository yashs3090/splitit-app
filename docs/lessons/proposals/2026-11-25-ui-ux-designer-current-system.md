# Proposal: bring the `ui-ux-designer` skill up to date with the design system the visual pass built

**Status: pending**

**Target:** `.claude/skills/ui-ux-designer/SKILL.md` (Principle 6; the "Design system" section)

**Promotion rule used:** a rule that would now give a wrong result gets reworded. After the visual pass, three lines in the skill contradict what the user approved and what the code is: it recommends `@expo/vector-icons` (the app now uses `lucide-react-native`, which the user approved), it uses "⚠" as its example status icon (P3 replaced text glyphs with icons), and its "create once" design-system list describes primitives and a type scale that have since grown (`headline`, `micro`, `IconButton`, `ListRow`, `useFocusRing`…). The `product-engineer` and `visual-designer` agents both load this skill first, so a stale line here can bring glyphs or a second icon set back. Same kind of fix as the applied `2026-11-21-native-mobile-stale-rules.md`.

## Evidence (docs/lessons/log.md)
- 2026-11-25 "User's choices for the look of the app" [expo]: P3 approved (icons instead of glyphs), no UI framework, lucide as the icon family.
- 2026-11-25 "A 'no glyphs' test passed because the part it checked was collapsed" [testing]: glyphs survived the pass once already.
- 2026-11-25 "On web, the focus ring showed on mouse clicks and taps" [expo]: the shared `useFocusRing` is the fix; new primitives should reuse it.
- 2026-11-25 "Design research: one skill vetted and installed, two declined…" [process]: `lib/theme.ts` + `components/ui/` is the single source of truth.

## Change 1: Principle 6

Old:
```
6. **Status is never color-only.** Pair color with an icon or text (e.g. ⚠ + "Doesn't add up by $0.02"). Show *how far off* when possible; it helps users fix it.
```

New:
```
6. **Status is never color-only.** Pair color with an icon and text (e.g. a warning icon from `ToneIcon` + "Doesn't add up by $0.02"). Icons are real icons, never text glyphs or emoji (⚠ ✓ ▴ ▾ ‹). Show *how far off* when possible; it helps users fix it.
```

## Change 2: the "Design system" section (whole section, from its heading to the line before "## Process")

Old:
```
## Design system (create once, reuse everywhere)
- `lib/theme.ts`: tokens only, no components.
  - `colors.light` / `colors.dark` with semantic names: `background`, `surface`, `surfaceMuted`, `text`, `textMuted`, `border`, `primary`, `onPrimary`, `danger`, `dangerSurface`, `success`, `successSurface`, `warning`, `warningSurface`, `focus`.
  - `space` on a 4-pt scale (4, 8, 12, 16, 24, 32), `radius` (8, 12, 16, pill), `type` scale (caption 13, body 16, label 15 semibold, title 22 bold, display 32 bold).
  - A `useTheme()` hook returning the right palette.
- `components/ui/`: small primitives: `Button` (primary / secondary / ghost / danger, loading + disabled), `TextField` (label, hint, error, prefix like `$`), `Card`, `Banner` (info / warning / error / success with icon + text), `MoneyText`. Keep each small and typed; no `any`.
- Don't add a UI library or icon pack without the user's OK. Prefer what Expo already ships (`@expo/vector-icons` is part of the `expo` package; check it's installed before using it).
```

New:
```
## Design system (built; extend it, never fork it)
- `lib/theme.ts` is the single source of truth: tokens only, no components. Read it before styling. It holds `colors.light` / `colors.dark` (semantic names: `background`, `surface`, `surfaceMuted`, `text`, `textMuted`, `border`, `divider`, `primary`, `onPrimary`, `primarySurface`, `danger`, `success`, `warning` and their `*Surface`s, `focus`, `scrim`), `space` (4-pt steps), `radius`, `type` (caption, body, label, headline, title, display, micro), `iconSize`, `ICON_STROKE`, `TOUCH_TARGET`, `ROW_MIN_HEIGHT`, `layout`, `opacity`, `focusRing`, `tabularNums`, and `useTheme()`. A value used twice becomes a token here, not a literal in a screen.
- `components/ui/` holds the primitives: `Button`, `IconButton`, `TextLink`, `TextField`, `Card`, `ListRow`, `SectionHeader`, `SegmentedControl`, `Banner`, `StatusLine`, `MoneyText`, `Icon`, `ToneIcon`, `BackHeader`, and the `useFocusRing` hook. Use one before writing a new one; keep each small and typed; no `any`.
- Icons: `lucide-react-native` through `components/ui/Icon`, outline style, sizes from `iconSize`, stroke `ICON_STROKE`. Icon-only controls have an `accessibilityLabel`; decorative icons are hidden from screen readers.
- Web keyboard focus: tappable primitives use `useFocusRing`, which shows the ring only for keyboard focus (react-native-web fires `onFocus` for clicks and taps too).
- Don't add a UI framework, a second styling system or another icon set without the user's OK. The user chose to stay with this theme over frameworks like Tamagui.
```

## What this changes for you
The skill every screen-building agent reads first will describe the app as it is now, so new screens use the same icons and tokens as the rest instead of bringing back "⚠"-style glyphs or a second icon library.
