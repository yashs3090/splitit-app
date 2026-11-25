# Proposal: parser changes compare old vs new readings, and reviewers probe both side by side

**Status: pending**

**Targets:** `.claude/agents/code-reviewer.md`, `.claude/agents/implementer.md`, `.claude/agents/product-manager.md`

## Evidence (docs/lessons/log.md)
- 2026-11-21 "Parser fixtures were cleaner than real OCR output" [receipt-parsing]: a reviewer probed about 60 messy receipts and found 10 should-fixes. The rule "reviewers of parser changes probe with generated messy inputs" was logged but never added to an agent file.
- 2026-11-24 "A parser rule that reinterprets lines must compare against today's reading and fall back" [receipt-parsing]: second occurrence (review R5 named the 2026-11-21 lesson). The guard took three rounds. The reviewer's old-vs-new probe harness found every counterexample.
- 2026-11-24 "A review fix covered the listed receipts, not their class" [testing]: round 2's blocking finding was the same class as round 1, combined with a lost item.
- 2026-11-24 "User's rules for Total lines and parser priorities" [receipt-parsing]: total, tip and tax must never get worse; leave the subtotal null when unsure.
- 2026-11-24 "The eval couldn't show the change, because the motivating receipt's read lacked the lines" [receipt-parsing]: first occurrence. It's included because it costs one check and prevents a surprise "neutral" result. Reject that sentence on its own if you'd rather wait.
- 2026-11-24 "A spec said an existing test would 'pass without edits'…" [process]: the fifth unverified "nothing else is affected" claim (the earlier four were grep criteria, already in the PM rules). This extends that rule to behavior changes.

## Change 1: `.claude/agents/code-reviewer.md`, item 4 (Tests)

Old:
```
4. **Tests:** acceptance criteria with no test; tests that don't actually assert the behavior. For navigation and auth flows, check there's a test per platform (web and native) and per entry route (deep link, `/` after the web OAuth redirect, cold start), including any screen that mounts on the way.
```

New:
```
4. **Tests:** acceptance criteria with no test; tests that don't actually assert the behavior. For navigation and auth flows, check there's a test per platform (web and native) and per entry route (deep link, `/` after the web OAuth redirect, cold start), including any screen that mounts on the way. For changes to `lib/receiptText.ts`, don't stop at the spec's receipts. Run the pre-change parser and the new one side by side on generated messy receipts and report every receipt where total, tip or tax got worse. Include: rows tilted a few degrees; labels that start with "Total" but aren't the total; fees, tip or tax printed above the total; tax shown after a tax-inclusive total (VAT 20%, Net/VAT); repeated totals; discount and "Savings" lines; OCR-damaged labels; and an item lost to OCR combined with each of these. Put the receipts that broke it in the finding so they become tests.
```

## Change 2: `.claude/agents/implementer.md`, new bullet after "Tests first for pure logic…"

Old:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
```

New:
```
- Tests first for pure logic (`lib/*.ts`): write the failing test, then make it pass.
- For parser changes (`lib/receiptText.ts`), test noisy cases as well as the clean ones the spec lists: rows tilted a few degrees, labels starting with "Total" that aren't the total, qty × unit = line-total columns, units in names (oz, lb), trailing tax-code letters, discounts under items, OCR-damaged labels. A rule that reads lines differently from today also computes today's reading and falls back to it when the new reading reconciles worse (`totalsGaps`), so total, tip and tax are never worse than today. When a review finding lists example inputs, name the class they belong to, fix the class, and add a test that combines it with another common fault (a lost item, a misread amount).
```

## Change 3: `.claude/agents/product-manager.md`, two new bullets in Rules, after "Shared contracts are defined once."

Old:
```
- **Ask, don't default.**
```
(Insert the two bullets directly before this line; the line itself stays unchanged.)

New (inserted):
```
- **Parser changes say what they must never make worse.** For `lib/receiptText.ts`: total, tip and tax must never get worse than today, and when the parser is unsure it leaves the subtotal null (user, 2026-11-24). A rule that reads lines differently from today first lists everything that could already be inside the amount it reinterprets (tax, fees, tip, discounts, included tax or VAT, printed above or below it). It has a criterion that falls back to today's reading when the new reading reconciles worse. If a real receipt motivated the change, check that its saved read (`eval/receipts/<name>.ocr.json`) contains the lines the rule depends on. If it doesn't, say up front that the eval can't show the effect.
- **"Existing tests pass unchanged" is checked.** When a task changes behavior (a status, a reason code, a piece of copy), Grep the tests for the old expected value. List in the criterion each test that must change, and write "passes without edits" only after that search.
```

## What this changes for you
Parser reviews will routinely compare the old and new parser on made-up messy receipts, and parser rules will come with a "fall back to today's reading if the new one fits worse" safety net from the start. That should turn three review rounds into one. Specs will also stop promising that existing tests pass unchanged without checking.
