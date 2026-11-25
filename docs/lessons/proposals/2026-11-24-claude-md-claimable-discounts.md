# Proposal: CLAUDE.md money convention mentions claimable discounts

**Status: pending**

**Target:** `CLAUDE.md` § Conventions, the "Money is integer cents" bullet

**Why:** ADR 0017 (claimable discounts) adds a second way a bill-level discount can be split. The money convention, which every agent reads first, still says that discounts are always split proportionally or evenly. Agents reading only `CLAUDE.md` would get claimable discounts wrong. The docs-writer suggested the wording, and the spec repeated it (docs/specs/2026-11-24-claimable-discounts.md, Risks).

## Evidence
- Docs-writer report and spec § Risks, docs/specs/2026-11-24-claimable-discounts.md.
- Precedent: `2026-11-21-claude-md-extras-split.md` (applied 2026-11-22) added the extras split mode to this same bullet when ADR 0014 landed.

## Change

Old:
```
chosen per bill by the host (ADR 0014). Both use largest-remainder rounding,
```

New:
```
chosen per bill by the host (ADR 0014). A bill-level discount the host marks "Claim like an item" is a negative bill row that people claim like an item instead (ADR 0017). Both use largest-remainder rounding,
```

## Before applying
CD-6 (a claimed discount can make someone's share negative) is still waiting on your look. This wording doesn't decide CD-6 either way. If you later cap shares at zero, this sentence can stay as it is.

## What this changes for you
Every agent will know that a discount can be either split across the bill or claimed like an item, without having to find ADR 0017 first.
