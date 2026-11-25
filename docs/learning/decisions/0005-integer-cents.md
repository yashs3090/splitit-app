# 0005: Money as integer cents with largest-remainder rounding

**Status:** Accepted (2026-11-19). Amended by [0014](0014-extras-split-proportional-or-equal.md) (2026-11-21).

> **Note (2026-11-22):** [0014](0014-extras-split-proportional-or-equal.md) changes the second bullet of the Decision. Extras (tax, tip, fees and bill-level discounts) are now split by the bill's `extras_split` setting: in proportion to each person's items (the default, as below) or equally among people who claimed something. Integer cents and largest-remainder rounding are unchanged. The text below is left as it was decided.

## Context
In JavaScript, `0.1 + 0.2 === 0.30000000000000004`. Floating-point numbers can't represent most decimal fractions exactly. Splitting tax and tip between people also creates fractions of a cent that have to go *somewhere*. If shares don't add up exactly to the receipt total, users notice and stop trusting the app.

## Decision
- Store and compute every amount as an **integer number of cents** (`integer` / `bigint` in Postgres, `number` holding a whole number in TypeScript). Convert to dollars only for display.
- Allocate tax, tip and fees **in proportion to each person's item subtotal**, using the **largest-remainder method** so the parts always sum to the exact total. Ties are broken in a deterministic order (e.g. by user id), so everyone's phone shows the same numbers.
- All of this lives in one pure, heavily tested module (`lib/split.ts`).

## Consequences
- Never use floats for stored money, and never round per person independently: that's how you get a total off by one cent.
- Currencies without cents (JPY) or with three decimals (KWD) would need a "minor units" factor per currency. That's out of scope for v1 (USD only) but the code should take the currency as a parameter.

Details and a worked example: [money-and-rounding](../concepts/money-and-rounding.md).
