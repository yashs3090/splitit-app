# Proposal: complete screen-reader labels on rows; optional inputs are opt-in

**Status:** applied 2026-11-22
**Target file:** `.claude/skills/ui-ux-designer/SKILL.md` § Principles
**Promotion rules used:**
- Second accessibility finding in review (M1a: missing `accessibilityHint`s; M1b+M2: an item row's label hid its price and claim status).
- Second instance of the user's "simple, uncluttered" preference turning into a concrete pattern (M1a explicit preference; M1b+M2 "+ Add note" instead of a default note box).

## Exact change

### Change 1: principle 1, append one sentence

Old:
```
1. **Simple and uncluttered (the user's explicit preference).** When in doubt, remove. Show only what the person needs for this step; fold rare options behind a quiet control. One primary action per screen, visually obvious. Secondary actions are quieter (outline or text buttons). Destructive actions are clearly marked and never the default. No decorative elements that don't help the task.
```

New:
```
1. **Simple and uncluttered (the user's explicit preference).** When in doubt, remove. Show only what the person needs for this step; fold rare options behind a quiet control. One primary action per screen, visually obvious. Secondary actions are quieter (outline or text buttons). Destructive actions are clearly marked and never the default. No decorative elements that don't help the task. Optional inputs are opt-in: a quiet "+ Add note"-style control that reveals the field, not an empty box shown by default.
```

### Change 2: principle 8, append one sentence

Old:
```
8. **Accessible by default:** text contrast ≥ 4.5:1 (3:1 for large text and UI borders), support Dynamic Type (no fixed heights on text containers; `allowFontScaling` stays on), `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on interactive elements, an `accessibilityHint` wherever the result of an action isn't obvious from its label (e.g. "Opens the camera", "Removes this item"), logical focus order.
```

New:
```
8. **Accessible by default:** text contrast ≥ 4.5:1 (3:1 for large text and UI borders), support Dynamic Type (no fixed heights on text containers; `allowFontScaling` stays on), `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on interactive elements, an `accessibilityHint` wherever the result of an action isn't obvious from its label (e.g. "Opens the camera", "Removes this item"), logical focus order. A custom `accessibilityLabel` on a row or card replaces everything inside it for screen readers, so it must say everything the row shows that matters, in reading order (e.g. "Tacos, $12.50, claimed by you and Sam").
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: Screens get a design pass; the user wants simple, uncluttered UI [area: expo]"
- "2026-11-22: A row's screen-reader label hid its price and status [area: expo]"
- "2026-11-22: User UI preferences from M1b+M2 [area: expo]"
