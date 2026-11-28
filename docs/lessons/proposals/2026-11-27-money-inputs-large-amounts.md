# Proposal: money inputs and unit switches are tested at large amounts, with a round-trip property test

**Status: pending**

**Targets:** `.claude/agents/product-engineer.md` (§ Build); `.claude/agents/implementer.md` (§ How to work); `.claude/agents/qa-tester.md` (step 4)

**Promotion rule used:** same lesson twice or more in the log (money-math area). Money tests picked small, readable amounts and missed the case where rounding matters: the 2026-11-24 property test found a split case the tables missed, and now QA's only failure in Who paid was a $/% switch that's exact on a $31 bill and wrong on a $10,000 bill. R10 in the same task is the second "invalid money input counted as $0".

## Evidence (docs/lessons/log.md)
- 2026-11-27 "The $/% switch changed typed cents on bills over $100, and the only test used a $31 bill" [money-math]: QA A-50(c), docs/specs/2026-11-26-who-paid.md. $3,333.33 → % → $ came back as $3,333.00 and Save stayed enabled. The fix kept the typed cents and added a property test up to $999,999.99. Review R10: a % row rounding to 0¢ was dropped silently.
- 2026-11-24 "A seeded property test found a money case the spec's boundary tables missed" [money-math]: random bills found what hand-picked cases didn't.
- 2026-11-21 "Invalid money input must never count as $0 or as 'adds up'" [money-math]: the first "bad input became $0".

## Change 1: `.claude/agents/product-engineer.md`, § Build, new bullet directly after "Components never do money arithmetic; …"

Old:
```
- Components never do money arithmetic; `lib/` returns any derived amount. Money is integer cents, formatted only through `lib/money.ts`.
```

New:
```
- Components never do money arithmetic; `lib/` returns any derived amount. Money is integer cents, formatted only through `lib/money.ts`.
- Money inputs and unit switches ($ ↔ %, amount ↔ share) are tested at a large amount where the coarser unit is worth more than 1¢ (at least $10,000, and the input's maximum), not only at a readable one. A seeded property test switches there and back with no edits and expects the exact typed cents and Save still disabled. A row that rounds to 0¢, or any value that can't be represented, is refused with a message on that row, never dropped or counted as $0.
```

## Change 2: `.claude/agents/implementer.md`, § How to work, appended to the end of the "Tests first for pure logic" bullet

Old:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
```

New:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass. For money conversions and rounding, include a large amount where the rounding step is worth more than 1¢ (at least $10,000 and the field's maximum) and a seeded round-trip property test; small examples alone can't fail.
```

## Change 3: `.claude/agents/qa-tester.md`, step 4

Old:
```
4. Try at least two edge cases the spec didn't mention (e.g. an empty receipt, a single participant, a $0 tip, a unicode item name).
```

New:
```
4. Try at least two edge cases the spec didn't mention (e.g. an empty receipt, a single participant, a $0 tip, a unicode item name). When the task touches a money input or conversion, one of them is a large amount (at least $10,000, or the field's maximum): type exact cents, switch units or reopen, and check the cents didn't change.
```

## Compatibility
- The pending `2026-11-24-money-rule-exceptions-and-degenerate-cases.md` adds degenerate split inputs to the PM's rules. This proposal covers input forms and conversions in the builders and QA; they don't overlap and can be applied in either order.

## What this changes for you
On a large bill, switching between dollars and percent on the Who paid page (or any future money field) can't quietly change what you typed, because the tests now use amounts where it would show.
