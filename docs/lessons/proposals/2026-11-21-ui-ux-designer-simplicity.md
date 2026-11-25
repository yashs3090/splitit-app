# Proposal: ui-ux-designer skill puts "simple and uncluttered" first and requires VoiceOver hints

**Status:** applied 2026-11-21
**Target file:** `.claude/skills/ui-ux-designer/SKILL.md` § Principles
**Promotion rule used:** user preference stated in M1a ("simple, uncluttered UI"), plus the full M1a review finding missing VoiceOver hints. The skill already says "Clarity over decoration" but doesn't make simplicity the deciding rule, and doesn't mention `accessibilityHint`.

## Exact change

### Change 1: principle 1

Old:
```
1. **Clarity over decoration.** One primary action per screen, visually obvious. Secondary actions are quieter (outline or text buttons). Destructive actions are clearly marked and never the default.
```

New:
```
1. **Simple and uncluttered (the user's explicit preference).** When in doubt, remove. Show only what the person needs for this step; fold rare options behind a quiet control. One primary action per screen, visually obvious. Secondary actions are quieter (outline or text buttons). Destructive actions are clearly marked and never the default. No decorative elements that don't help the task.
```

### Change 2: principle 8

Old:
```
8. **Accessible by default:** text contrast ≥ 4.5:1 (3:1 for large text and UI borders), support Dynamic Type (no fixed heights on text containers; `allowFontScaling` stays on), `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on interactive elements, logical focus order.
```

New:
```
8. **Accessible by default:** text contrast ≥ 4.5:1 (3:1 for large text and UI borders), support Dynamic Type (no fixed heights on text containers; `allowFontScaling` stays on), `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on interactive elements, an `accessibilityHint` wherever the result of an action isn't obvious from its label (e.g. "Opens the camera", "Removes this item"), logical focus order.
```

## Evidence (docs/lessons/log.md)
- "2026-11-21: Screens get a design pass; the user wants simple, uncluttered UI [area: expo]"
