# Testing strategy

## The idea
The **testing pyramid**: many fast **unit tests** on pure logic, fewer **integration tests** across real components (the database + its RLS policies), and a handful of **end-to-end** checks of the whole flow. Put the most tests where bugs are most costly and code is easiest to test.

## What we test, and how
| Layer | What | Tool | Examples |
|---|---|---|---|
| Unit | `lib/split.ts`, `lib/paylinks.ts`, `lib/receiptText.ts` (parser + totals check) | Jest (`jest-expo`) | Shares add up to the total; ties are deterministic; $0 tip; one person; unclaimed items; URL encoding |
| Database | RLS policies, `join_bill`, constraints | pgTAP tests in `supabase/tests/database/`, run with `npx supabase test db` from the repo root (Docker running) | User B can't read user A's bill; you can't claim for someone else; an invalid join code fails |
| Parser and scan quality | Accuracy on real receipts | `npm run ocr:harness` (the app's own web scan pipeline in headless Chromium, writing saved reads), then `npm run eval` against hand-checked answer files (`npm run answers:draft` / `answers:check`). Free, no model calls | Line-item accuracy (target ≥ 85%), % of totals reconciled, and `decide` / `decideCore` verdicts for each pipeline step |
| End to end | The full flow with 2 users | Manual / QA agent on Expo web | Create → share → claim → settle |

### Measuring a change on real receipts: tuning and held-out (2026-11-25)
Unit tests say "the code does what we meant". They can't say "this makes reading receipts better". For that we score saved reads of real photos against answers a person checked ([the scan pipeline](scan-pipeline.md#measuring-harness-answer-files-eval); [receipt answers](../../setup/receipt-answers.md)).

The receipts are split once, by a hash of each name, into **tuning** (look at these while choosing) and **held-out** (look once, to confirm). A step ships only if it gains on tuning by more than a noise margin and doesn't lose on held-out (`decide`, `lib/receiptEval.ts:335`). Why both: anything you choose while looking at receipt A tends to work on receipt A. Only receipts you didn't look at can tell you whether it works in general. That's the same reason exam questions aren't handed out with the homework.

Every threshold also gets a unit test on **made-up input**, not copied from a real receipt's read (spec criterion 70). If the only test of a rule is the photo that inspired it, the test can't tell a general rule from a special case.

## Habits
- **Test-first for money math:** write the case ("3 people, 100¢ tax → 34/33/33") before the code.
- **Property-style checks:** for random inputs, the allocation always sums to the amount and no share is negative.
- **Test as the attacker:** every RLS test has a "should be denied" case.
- **Don't mock what you own** in integration tests. Use the real local database.

## Check yourself
1. Why is the split math tested far more heavily than the UI?
2. What's one property that must hold for every allocation?
3. Unit tests for the parser and the receipt eval both run `lib/receiptText.ts`. What does each one tell you that the other doesn't?
4. You try a new setting, it helps on tuning, and held-out shows one receipt losing 2 items. You adjust the setting and run held-out again; now it passes. What went wrong?

## Learn more
- https://supabase.com/docs/guides/database/testing
- https://martinfowler.com/articles/practical-test-pyramid.html
- Playwright (the headless browser the OCR harness uses): https://playwright.dev/docs/intro
