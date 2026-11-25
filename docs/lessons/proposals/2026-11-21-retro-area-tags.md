# Proposal: retro area tag `ai-parsing` becomes `receipt-parsing`

**Status:** applied 2026-11-21 (no `ai-parsing` entries existed in `docs/lessons/log.md`, so nothing was retagged)
**Target file:** `.claude/skills/retro/SKILL.md` §1 (log format)
**Promotion rule used:** "A rule that caused a wrong result gets a proposal to reword it." The retro skill tags parser lessons `ai-parsing`, but the `receipt-eval` skill tells agents to log parser findings as `[area: receipt-parsing]`, and there's no AI parsing since ADR 0010. With two names for one area, the "seen twice in the same area" count would miss repeats. This retro logged its parser lesson as `receipt-parsing`.

## Exact change

Old:
```
## YYYY-MM-DD: <short title>  [area: money-math | rls | expo | edge-fn | ai-parsing | testing | process]
```

New:
```
## YYYY-MM-DD: <short title>  [area: money-math | rls | expo | edge-fn | receipt-parsing | testing | process]
```

## Evidence
- `.claude/skills/receipt-eval/SKILL.md`, last paragraph: "`[area: receipt-parsing]`".
- `docs/lessons/log.md`: "2026-11-21: Parser fixtures were cleaner than real OCR output [area: receipt-parsing]".
