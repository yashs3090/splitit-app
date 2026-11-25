# Proposal: specs write out existing copy for a new kind of row, and delegated copy decisions favor clarity

**Status: pending**

**Target:** `.claude/agents/product-manager.md` (Rules)

**Promotion rule used:** the second copy-at-the-edges lesson in the log. M3's lesson went to `product-engineer` (pending proposal `2026-11-24-product-engineer-refetch-and-copy.md`), but this one began in the spec's own decision (CD-10), before any screen was built. So it belongs with the PM.

## Evidence (docs/lessons/log.md)
- 2026-11-24 "Sentence templates broke at a count of 1 and when the name was 'You'" [expo]: M3, four copy bugs from a copy table that assumed the plural and another person.
- 2026-11-24 "A delegated copy decision picked fewer strings over clarity, and review found it confusing" [process]: CD-10 counted unclaimed discounts as "items". Review R1 then showed "1 item left to claim" when only a discount was left. The spec itself had said "slightly imprecise". Fixed in Amendment A1.
- User direction (2026-11-24): "don't make stuff confusing for end user".

## Not a duplicate
- `2026-11-24-product-engineer-refetch-and-copy.md` tests names and counts (count of 1, "You") while screens are built. This one covers the spec: which existing strings a new concept leaks into.
- `2026-11-24-delegated-decisions.md` covers how decisions are logged and raised, not how copy decisions are made.

## Change: `.claude/agents/product-manager.md`, new bullet in Rules, directly before "Write grep-based criteria with plain `grep -rn`…"

Old:
```
- Write grep-based criteria with plain `grep -rn` unless the files are committed
```
(Insert the bullet directly before this line; the line itself stays unchanged. No other pending proposal inserts at this spot.)

New (inserted):
```
- **New kinds of rows or states get their copy written out.** When a spec adds something that existing copy will count or name (a discount row counted by "N items left", a new status in a summary line), list each existing string it reaches: summary lines, blockers, hidden-total text, screen-reader labels. In the copy table, write out what each one reads with only the new kind present and with both kinds. Read each line as the person at the table would. If a choice trades their clarity for fewer strings or less code, pick clarity, delegated or not.
```

## What this changes for you
When a feature adds a new kind of thing to a bill, the spec will spell out how every existing message reads with it. A line like "1 item left to claim" when the only thing left is a discount gets caught in the spec instead of in review.
