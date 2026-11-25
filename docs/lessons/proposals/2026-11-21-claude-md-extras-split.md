# Proposal: CLAUDE.md money convention covers the extras split mode

**Status:** applied 2026-11-22 (approved by the user; worded with the user's chosen terms "proportionally" / "evenly")
**Target file:** `CLAUDE.md` § Conventions, the "Money is integer cents" bullet
**Why:** The user chose (spec `docs/specs/2026-11-20-m1b-m2-share-and-claim.md`, Amendments A1.7 and A2) to let a bill split tax, tip, fees and bill-level discounts either proportionally or equally. That's recorded in [ADR 0014](../../learning/decisions/0014-extras-split-proportional-or-equal.md), which amends ADR 0005. `CLAUDE.md` still says extras are always proportional, so an agent reading it would think "equal" mode is a bug. The wording below is the spec's Task 14 text, with "bill-level" kept so item-level discounts (folded into item prices) aren't confused with it.

Independent of other pending CLAUDE.md proposals; it touches only this one bullet.

## Change: § Conventions, "Money is integer cents" bullet

Old:
```
- **Money is integer cents** (`number` of cents). Never floats for money. Tax, tip and fees are allocated in proportion to each person's subtotal with largest-remainder rounding, so the shares always add up to the bill total exactly.
```

New:
```
- **Money is integer cents** (`number` of cents). Never floats for money. Tax, tip, fees and bill-level discounts are allocated by the bill's `extras_split` setting: in proportion to each person's item subtotal (default) or equally among people who claimed something. Always largest-remainder rounding, so the shares add up to the bill total exactly.
```

## Optional addition (the user decides)
A2.2's rule could also go in the same bullet, so agents don't show totals too early:
```
  Under "equal", nobody's total is shown until every item is claimed (`displayShares` in `lib/split.ts` decides).
```
Not included in "New" above because the spec didn't ask for it.

## Evidence
- ADR 0014, and ADR 0005 marked "Amended by 0014".
- Spec A1.7 (point 7, "`CLAUDE.md` § Conventions and ADR 0005 say 'proportional'. Task 14 … proposes the CLAUDE.md wording") and Task 14's "Extras split" bullet.
- Code: `lib/split.ts:167-191`, `supabase/migrations/20261121130144_extras_split.sql`.
