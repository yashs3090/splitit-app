# Spec: read the first of two different "Total" lines as the subtotal (2026-11-24)

Feature approved by the user on 2026-11-24, including the guard. Area: receipt-parsing.

## Providers, accounts and costs

| Service / account | Needed? | Setup cost |
|---|---|---|
| None | No new service. Pure `lib/` change, run offline. | $0 |

## Goal

Some receipts have no "Subtotal" line. They print "Total" for the subtotal, then a service charge or tip, then a second "Total". The parser should read these correctly, so the host doesn't get a "missing subtotal" warning, and the tax, tip and fees between the two totals end up in the split.

## The rule (single source of truth; the task and every criterion refer here)

Definitions, all over the classified rows of one receipt:
- A **Total row** is a row with `kind: 'totals'` and `which: 'total'`. That covers any label `totalKind` returns `'total'` for (Total, Grand Total, Amount Due, Balance Due, Total incl. tax, a repaired "Tota)").
- `firstTotal` / `lastTotal` are the indexes of the first and last Total rows.

**The rule fires only when all of the following are true:**
- R1. There are at least 2 Total rows, and the amount on the first Total row differs from the amount on the last one.
- R2. No row anywhere on the receipt has `which: 'subtotal'`.
- R3. No row with `which: 'tax'` or `which: 'taxSum'` comes before `firstTotal`.

**When it fires:**
- F1. `subtotalCents` = the first Total row's amount. `totalCents` = the last Total row's amount (this is already how the last total wins).
- F2. Rows strictly between `firstTotal` and `lastTotal` with `which` of `tax` or `taxSum` count toward `taxCents`, using today's tax / taxSum logic (`seenTaxSum` included). Tip and fees rows count as they do today.
- F3. Rows after `lastTotal` are handled as today: only tip, fees and total rows count.
- F4. The item cutoff doesn't change. Items still end at `firstTotal`, because there is no subtotal row.
- F5. Discount rows after `firstTotal` are still ignored, as today (see open question Q2).

**When it doesn't fire:** the output is identical to today's for every receipt. The last Total wins, `subtotalCents` comes only from a printed subtotal row (or stays `null`), and after the first Total only tip, fees and total rows count.

**Totals check:** no change to `totalsGaps` / `checkTotals` / `TOLERANCE_CENTS` (1 cent). Once the rule sets `subtotalCents`, the existing with-subtotal checks run:
`items_vs_subtotal = items − subtotal discounts − subtotalCents` and
`subtotal_vs_total = subtotalCents + tax + fees + tip − total discounts − totalCents`.
Each is flagged when |gap| > 1. `missing_subtotal` is no longer reported for a receipt where the rule fired.

Reading of "different amounts": R1 compares only the first and last Total rows. A middle Total row with a third amount is ignored (see Q1).

## Why this is a general rule, and the held-out caveat

The motivating receipt is `receipts/answers/less-contrast.txt` ("Total 57.30" that is really the subtotal, "Service charge 12.5% 7.16", "Total 64.46"). It is in the **held-out** set. Because a held-out receipt motivated this change, its eval result no longer counts as a clean held-out signal **for this change**. The eval report and the QA report must say this, and must not cite less-contrast's improvement as evidence the rule generalizes.

What justifies the rule is the receipt structure, not that one receipt. Two different Total amounts with no subtotal and no tax before the first one can only mean "pre-extras amount, then extras, then the final amount". The guard (R3) excludes the common opposite case: Tax, then "Total 50.00", then a card slip with "Tip 10.00 / Total 60.00". There the first Total already includes tax. The unit tests below use invented receipts only, and no code may refer to less-contrast's labels or amounts (criterion 11).

## In scope
- `lib/receiptText.ts`: the rule above in `parseReceipt` (a pre-scan of `rows` before the loop to decide whether the rule fires, plus the changes to the loop's totals handling).
- `lib/receiptText.test.ts`: the new tests.
- A short entry in `docs/lessons/log.md` `[area: receipt-parsing]` only if the eval or review turns up something worth recording.

## Out of scope
- Any change to `totalKind`, the regexes, `totalsGaps`, `checkTotals`, `chooseTip` or the tolerance.
- Discounts after the first Total (Q2).
- VAT-inclusive receipts that print the VAT after the total (risk below). No special handling in this task.
- UI, database, eval scripts.

## Task 1 (agent: implementer)

**Step 0, before editing anything: capture the eval baseline.** `lib/receiptText.ts` is untracked, so `git stash` can't restore it. `git stash -u` would also stash other sessions' untracked work, so it is forbidden here. From the repo root, run:

```
npm run eval -- --confirm > eval/receipts/baseline-2026-11-24-first-total-subtotal.txt 2>&1
```

(`eval/receipts/` is gitignored, because the output names real receipts' items.) Then copy the unmodified parser to `eval/receipts/receiptText.pre-2026-11-24.ts` for reference. Report both files' modification times. Variant: the default (`web-current`). The flags were checked against the header of `scripts/eval-receipts.ts` (`--variant`, `--only`, `--confirm`). Verify them; reword if the script differs.

**Then:**
- Files: `lib/receiptText.ts` and `lib/receiptText.test.ts` (this repo). Roughly 30 lines of code plus about 120 lines of tests.
- Implement "The rule" exactly as written. Decide whether it fires in a pre-scan over `rows`, before the `rows.forEach` loop. Add a comment by the pre-scan that states R1–R3 and why R3 exists (the card-slip case).
- Add the tests in criteria 1–8 with invented receipts built with the file's existing `linesOf(...)` helper.
- After the change, run `npm run eval -- --confirm > eval/receipts/after-2026-11-24-first-total-subtotal.txt 2>&1` and report both files' Tuning and Held-out summary lines side by side.

## Acceptance criteria

The unit tests go in `lib/receiptText.test.ts`, in one `describe('first of two different totals is the subtotal', ...)` block. Every receipt in them is invented: different item names and amounts from less-contrast.

1. **The rule fires (service charge).** `Pasta 40.00 / Salad 10.00 / Total 50.00 / Service charge 10% 5.00 / Total 55.00` gives `subtotalCents 5000, feesCents 500, totalCents 5500, taxCents null`, items Pasta and Salad only, `reasons []`, `needsReview false`.
2. **The rule fires (tip).** `Burger 20.00 / Total 20.00 / Tip 4.00 / Total 24.00` gives `subtotalCents 2000, tipCents 400, totalCents 2400, reasons []`.
3. **Tax between the totals counts.** `Burger 20.00 / Total 20.00 / Tax 1.60 / Tip 3.00 / Total 24.60` gives `subtotalCents 2000, taxCents 160, tipCents 300, totalCents 2460, reasons []`. A second case with `Tax Total 1.60` (taxSum) between the totals also gives `taxCents 160`.
4. **Printed Subtotal present, rule off.** `Burger 20.00 / Subtotal 20.00 / Total 20.00 / Tax 1.60 / Total 21.60` gives `subtotalCents 2000, taxCents null, totalCents 2160`: tax after the first Total is still ignored, as today. (This receipt is deliberately odd. It only shows that the subtotal guard switches the rule off.)
5. **Tax before the first Total, rule off (card slip).** `Burger 46.30 / Tax 3.70 / Total 50.00 / Tip 10.00 / Total 60.00` gives `subtotalCents null, taxCents 370, tipCents 1000, totalCents 6000`, and `reasons` equal to `['missing_subtotal']` (the items-plus-extras check reconciles: 4630 + 370 + 1000 = 6000). The same with `Total Tax 3.70` (taxSum) before the first Total also leaves the rule off.
6. **Equal repeated totals, rule off.** `Burger 20.00 / Total 20.00 / Total 20.00` gives `subtotalCents null, totalCents 2000, reasons ['missing_subtotal']`. Likewise `Burger 20.00 / Total 20.00 / Tip 0.00 / Total 20.00` doesn't fire, and items aren't duplicated.
7. **Single Total, unchanged.** `Burger 20.00 / Service charge 2.00 / Total 22.00` gives `subtotalCents null, feesCents 200, totalCents 2200, reasons ['missing_subtotal']`.
8. **The totals check in the firing case, at its boundaries** (TOLERANCE_CENTS = 1, unchanged). On criterion 1's receipt:
   a. As printed: `checkTotals` gives `[]`.
   b. Last Total `55.01` (1 cent over): `[]`.
   c. Last Total `55.02` (2 cents over): `['subtotal_vs_total']`.
   d. Items `39.98 + 10.00` with first Total `50.00` (items 2 cents short), last Total `55.00`: `['items_vs_subtotal']` only.
   e. Both off by 1 cent (items `39.99 + 10.00`, last Total `55.01`): `[]`.
   Assert on `parseReceipt(...).reasons` and on `checkTotals(parsed)` directly, and the two must be equal.
9. **No regression in existing tests.** Every test that existed before this task passes unchanged, in particular "the last total wins…" (`lib/receiptText.test.ts:212`), "ignores tax and items printed after the total" (`:221`) and the tip-line tests (around `:1031`). `npx jest lib/receiptText.test.ts` passes, `npm test -- --maxWorkers=4` passes, and `npm run typecheck` passes. If a full run fails only in files this task didn't touch, follow the 2026-11-24 lesson on other sessions' in-progress edits: re-run once, then report the failing files as outside this task.
10. **Eval: no regression.** Compare `eval/receipts/after-2026-11-24-first-total-subtotal.txt` with the baseline from Step 0 (same variant, both with `--confirm`). In both the Tuning and the Held-out summary lines, none of these goes down: line items matched, exact, reconciled %, total correct %. `extra` doesn't go up. QA checks that the baseline file's modification time is earlier than `lib/receiptText.ts`'s first edit for this task. If it isn't, or the file is missing, criterion 10 is **blocked**, not passed. QA reports the Held-out numbers with the caveat from "the held-out caveat" section above, naming less-contrast.
11. **General, not patched.** No code in `lib/receiptText.ts` refers to the motivating receipt. `grep -rnE "57\.30|64\.46|5730|6446|7\.16|\b716\b|12\.5%" lib/receiptText.ts` prints nothing. PM ran the same pattern with the Grep tool on `lib/receiptText.ts` (2026-11-24, before the change): no matches. The implementer re-runs the exact shell command before editing and confirms it still matches nothing. The rule is one pre-scan using only R1–R3. It has no label text beyond the existing `which` kinds, and no amount thresholds.
12. **Money stays integer cents.** The new code only assigns existing integer `cents` values from rows. There is no division, no float and no `Math.round` in the change. A reviewer confirms this on the diff.

## Risks / open questions (for the user)

- **Q1. Three or more Total rows with different amounts** (e.g. Total 50.00 / Total 52.00 / Total 55.00). The spec compares only the first and last (R1): subtotal 50.00, total 55.00, and the middle one is ignored. Options: (a) as specified, first vs last; (b) don't fire when there are more than 2 distinct amounts, since that's an unusual layout and keeping today's behavior is safer. Recommendation: (a). It is simpler, and the totals check flags it if it's wrong. Task 1 is written for (a). If you pick (b), add one guard line and one test.
- **Q2. A discount between the two totals** (e.g. Total 50.00 / Coupon -5.00 / Total 45.00). Today discounts after the first Total are ignored, so this receipt would get `subtotal_vs_total` flagged. Options: (a) keep ignoring it (as specified; the host fixes it in the form); (b) count it as a total-level discount when the rule fires. Recommendation: (a) for this task, and (b) as a follow-up if a real receipt shows it. This is your call, because it changes which money the split sees.
- **Risk: VAT-inclusive receipts that print the VAT after the total.** For example: items 54.00, "Total 54.00", "VAT included 4.00", card slip "Tip 10.00 / Total 64.00". There is no tax before the first Total, so the rule fires and counts the 4.00 VAT a second time. That gives a false `subtotal_vs_total` flag where today there is none. The eval doesn't contain such a receipt. Mitigation, not in scope: don't count tax rows whose label matches "incl" toward tax. Tell us if your receipts look like this.
- **Visible change:** receipts where the rule fires no longer show the "missing subtotal" review reason, and the bill form shows the first Total as the subtotal. This is intended.
- **Eval size:** 8 receipts with saved reads. "No regression" there is a weak signal. The invented unit tests are the main evidence.

## Amendment A1 (2026-11-24, user decisions on Q1, Q2 and the VAT risk)

These override the rule, F5, R1's reading, "Out of scope" and Task 1 wherever they conflict.

- **Q1 → (b).** R1 becomes: at least 2 Total rows, **exactly 2 distinct amounts** among them, and first ≠ last. With 3 or more distinct Total amounts the rule does not fire (today's behavior). Repeats of one of the two amounts are fine (e.g. 50 / 55 / 55 fires). Add a test for 50 / 52 / 55 (no fire).
- **Q2 → (b).** When the rule fires, a discount row strictly between the first and last Total counts as a discount with `appliesTo: 'total'`. Test: items 50.00, Total 50.00, Coupon -5.00, Total 45.00 → subtotal 50.00, discount 5.00 on total, total 45.00, no `subtotal_vs_total` flag. Outside the firing case, discounts after the first Total stay ignored as today.
- **VAT incl → fix in this task.** When the rule fires, a tax row between the two Totals whose label marks it as included (the existing `INCLUDES_RE`, e.g. "VAT included 4.00", "incl. tax") is **not** added to tax: it's already inside the first Total. Test: items 54.00, Total 54.00, VAT included 4.00, Tip 10.00, Total 64.00 → subtotal 54.00, tax null (or unchanged), tip 10.00, total 64.00, no flags. Also check how `totalKind` classifies such a label today ("Total incl. tax" is already a total) and keep that unchanged; only tax rows are affected.

## Amendment A2 (2026-11-24, user priority)

Total, tip and tax matter most; subtotal is the lowest priority. When the parser is unsure what the subtotal is, it leaves `subtotalCents` null rather than guessing (working it out from the items is an acceptable fallback, a possible follow-up). The rule must never make total, tip or tax worse than today; if a guard is ambiguous, don't fire.

## Amendment A3 (2026-11-24, the host's view of a missing subtotal)

User direction: "make best user experience - don't over engineer but also don't lose features that could be nice - don't make stuff confusing for end user". The PM decided this without asking, as instructed. The decisions are logged in `docs/decisions-to-review.md`. Task 1 is unchanged.

### What the host sees today when the subtotal is blank
On the bill form (`components/BillForm.tsx`, with the rules in `lib/billDraft.ts`):
- The Subtotal field shows "Not on receipt".
- An info note says "Enter the subtotal from the receipt to check the items." (`REASON_COPY.missing_subtotal`).
- The footer pill says "… Not checked yet" (status `incomplete`). That happens even though the items-plus-extras-vs-total check (A2.1 in `totalsGaps`) already ran and passed.

So on every receipt without a printed subtotal, the host is asked to do something they can't do, and is told the bill wasn't checked when it was. If that check fails, the red banner says "The subtotal, tax, fees and tip don't add up to the total.", but the host never entered a subtotal.

### Decision: leave the field blank; don't auto-fill it
- **Picked (B):** leave Subtotal blank. The checks already use the items in its place: the totals check, and the tip-% base in `tipBaseCents`. Stop asking for a subtotal, and word the mismatch in terms of the items. The Totals card already shows "Items add up to $X", so the host still sees the number.
- **Rejected (A):** fill the Subtotal field from the items (less before-subtotal discounts). The filled value goes stale as soon as the host edits an item, which raises a false "items don't add up to the subtotal". It would also save an amount as if the receipt had printed it, and the items-vs-subtotal check would become meaningless.

### Other cases looked at, with no work needed
- **Several Totals:** the form has one Total field. After Task 1, Subtotal shows the first Total and Total shows the last, which are both numbers printed on the receipt. Nothing confusing.
- **Discount between the Totals (A1 Q2):** it appears in Discounts with "After subtotal" selected, which is correct.
- **"VAT included" (A1):** Tax stays blank while the receipt prints a VAT amount. If the host types it in, they get "Off by $X". This is rare and the banner explains it, so no work for now (logged as FT-A3-3).

### Task 2 (agent: implementer; it runs after or alongside Task 1 and touches none of Task 1's files)
The work is mostly `lib/` logic plus one copy swap in the screen, with no layout change, so it goes to the implementer and not the product-engineer.

Files:
- `lib/billDraft.ts`
- `lib/billDraft.test.ts`
- `components/BillForm.tsx` (one line: which copy the mismatch banner renders)
- `__tests__/billForm.test.tsx`

About 60 lines plus tests. **Don't touch `lib/receiptText.ts`.** The shared rule (`checkTotals` / `totalsGaps`, 1-cent tolerance) stays as it is. This task only changes how the form presents its result.

1. In `evaluateDraft`, `missing` (and so `status`) never contains `missing_subtotal`. `receipt.reasons` / `receipt.needsReview` stay exactly what `checkTotals` returns, plus `qty_price_mismatch` as today, so the shared rule is untouched.
2. Add the copy `"The items, tax, fees and tip don't add up to the total."` and expose it from `lib/billDraft.ts` (e.g. `NO_SUBTOTAL_MISMATCH_COPY`, plus a pure `reasonCopy(ev, reason)` helper, or a field on `DraftEvaluation`; implementer's choice). It is used for `subtotal_vs_total` when the receipt's `subtotalCents` is null. `BillForm` renders that instead of `REASON_COPY[r]`. Components still do no money math.
3. Leave `REASON_COPY.missing_subtotal` in place: `ReviewReason` needs a copy entry, and the scan pipeline still uses the reason.

### Acceptance criteria (A3)
These run in `lib/billDraft.test.ts` unless noted. "Items" means valid item rows.

A3-1. Items Burger 20.00, Subtotal blank, Tax 1.60, Total 21.60 gives `status 'adds_up'`, `missing []`, `mismatches []`.

A3-2. Boundaries, on A3-1's draft:
- a. Total 21.61 (1 cent off) gives `adds_up`.
- b. Total 21.62 gives `status 'mismatch'`, `mismatches ['subtotal_vs_total']`, `gaps.subtotal_vs_total === -2`, and the copy from step 2 is the no-subtotal copy.
- c. Subtotal 20.00 entered and Total 21.62 gives the existing `REASON_COPY.subtotal_vs_total` copy.

A3-3. Items present, Subtotal and Total blank gives `missing ['missing_total']`, `status 'incomplete'`.

A3-4. Empty draft gives `missing` equal to `['no_items', 'missing_total']` (order as `checkTotals` emits). In `__tests__/billForm.test.tsx` test 28, line 76's expectation becomes "`REASON_COPY.missing_subtotal` is **not** shown". The other lines of the test stay. (This changes M1a criterion 28's expected copy. It is recorded here and in decisions-to-review, under the user's 2026-11-24 direction.)

A3-5. Subtotal entered and wrong (items 20.00, Subtotal 19.00, Total 19.00) still gives `mismatches` containing `items_vs_subtotal` with today's copy. The subtotal check is not lost when a subtotal is printed.

A3-6. Subtotal `abc` still gives `errors['totals.subtotal'] === 'invalid_money'` and `status 'has_errors'`.

A3-7. For each draft in A3-1 to A3-5, `evaluateDraft(d).receipt.reasons` equals `checkTotals(evaluateDraft(d).receipt)` plus `qty_price_mismatch` if flagged. So it still includes `missing_subtotal` when the subtotal is blank.

A3-8. Router test (`__tests__/billForm.test.tsx`): a draft with a blank subtotal and a total off by 2 cents shows the red banner with the no-subtotal copy and "Off by $0.02". The same draft with Total corrected shows the pill "✓ Adds up", and neither the info note nor `REASON_COPY.missing_subtotal` appears.

A3-9. Saving is unchanged: a bill saved with a blank subtotal still sends `p_subtotal_cents: null`. The existing `lib/billPayload.test.ts` passes without edits.

A3-10. `git diff --stat` / modification times show `lib/receiptText.ts` was not changed by Task 2. `npm test -- --maxWorkers=4` and `npm run typecheck` pass (same out-of-task-failure rule as criterion 9).

## Amendment A4 (2026-11-24, main session decisions on the implementer's open points, reason A2)

- **R4 (new guard).** The rule fires only if the first Total is less than the last, or greater than the last with at least one discount row strictly between them. Otherwise it doesn't fire (today's behavior). Tests: 55.00 / 50.00 with nothing between → no fire; 50.00 / Coupon -5.00 / 45.00 → still fires.
- **Tip choice unchanged.** When the rule fires, `chooseTip` runs on the receipt as it would be without the rule: `subtotalCents` null, tax and discounts as they stood at the first Total (none of the rule's additions). The rule's subtotal, tax and discounts are applied to the result after that. Test: Burger 20.00 / Total 20.00 / Tax 2.00 / Tip 4.00 / Tip 2.00 / Total 26.00 → tip 6.00, the same as the old parser picks (checked against the pre-change copy).
- **Included-tax row before the first Total:** left as is (counted as tax; it turns the rule off via R3).

## Amendment A5 (2026-11-24, main session)

A3-9 wording: `lib/billPayload.test.ts` passes with one intended edit, at the criterion 68 line: a draft that is complete except for a blank subtotal now evaluates as `adds_up`, not `incomplete` (that is A3-1's behavior). Saving is unchanged: a blank subtotal still saves as `p_subtotal_cents: null`.

## Amendment A6 (2026-11-24, main session decisions on code review round 1, reason A2)

- **R3 widened (review R1).** The rule doesn't fire if any tax, tax-sum, tip or fees row comes before the first Total: a fee or tip printed above it is already inside it. Tests: Service charge 2.00 / Total 22.00 / Tip 4.00 / Total 26.00 and Gratuity 3.60 / Total 23.60 / Tip 2.00 / Total 25.60 give the old parser's output.
- **Reconciliation guard (review R2, new R5).** When the rule fires, the parser builds both readings: the rule's, and the one without it (no subtotal; tax and discounts as they stood at the first Total; the same tip, chosen as without the rule per A4). If the rule's reading has a totals mismatch (`items_vs_subtotal` or `subtotal_vs_total`) and the reading without it has none, the receipt is read entirely as without the rule. If both have a mismatch, the rule's reading is kept, so criteria 8c and 8d stand. No label text. Tests: the four review receipts (VAT 20% after a VAT-inclusive Total, Net / VAT breakdown, tax already inside the first Total, tax between repeated last Totals) and the review R4 "Savings 5.00" receipt. Each gives the old parser's output, checked against the pre-change copy.
- **Included tax-sum (review R3).** `included` is also set on tax-sum rows, and an included tax-sum row between the Totals is skipped too. Test: Tax total (incl.) 4.00.
- **More tests (review R5):** an OCR-damaged, timed first Total ("09:19PM Tota) 50.00") fires; tax and discount rows after the last Total are ignored while the rule fires; included tax before the first Total turns the rule off.
- **A4's tip test** now uses a firing receipt where the rule's reading is kept (Gratuity 4.00 / Tip 4.00). The earlier Tax 2.00 / Tip 4.00 / Tip 2.00 receipt falls back under R5, with the old parser's tip of 6.00. Under R5, a kept reading can't have a different tip choice than the old one in practice: whenever the two would pick differently, the old reading reconciles and the rule's doesn't.

## Amendment A7 (2026-11-24, main session decision on code review round 2, reason A2)

- **Second fallback condition.** When the rule fires, the receipt is also read entirely as without the rule if the rule's `subtotal_vs_total` gap (from `totalsGaps`) is over the 1-cent tolerance **and** the rule changed `taxCents` or the discounts compared with the reading without it. This sits alongside A6's condition (the rule adds a mismatch the old reading doesn't have). Tests: Fish 54.00 / Total 59.00 / VAT 20% 9.83 / Gratuity 5.00 / Total 64.00; Pasta 20.00 / Total 21.60 / Tax 1.60 / Tip 3.00 / Total 24.60; Pasta 45.00 / Total 50.00 / Savings 5.00 / Tip 10.00 / Total 60.00. Each gives the old parser's output exactly (checked against the pre-change copy). Burger 18.00 / Total 20.00 / Tax 1.60 / Tip 3.00 / Total 24.60 keeps the rule: subtotal 20.00, tax 1.60, reasons `['items_vs_subtotal']`. Criteria 8c and 8d are unchanged, because the rule adds no tax or discount there.
