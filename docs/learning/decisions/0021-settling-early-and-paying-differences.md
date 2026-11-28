# 0021: Settling early (proportional bills) and paying differences

**Status:** Accepted (2026-11-25, spec `docs/specs/2026-11-25-settle-early-and-differences.md` and its Amendment A1). Amends [0015](0015-settling-one-payer-self-reported-marks.md). §6 amended by [0024](0024-sent-via-venmo-and-payment-methods.md) (2026-11-27; dated note in §6). **Amended by [0022](0022-groups.md) (2026-11-27):** early settling and differences don't apply to bills in a group; a group bill counts only once fully claimed, and its existing marks became group payments (`bill_mark`). Bills outside groups are unchanged. **Amended by [0023](0023-several-payers.md) (2026-11-27):** contract D (differences, ±1¢ ignored) now applies to each pair of people (a route's target vs what was paid on it), and a bill whose paying is split between several people can't settle early (rule E′). One-person bills are unchanged. The money decisions (SE-1, SE-3, SE-11, SE-12, SE-ENG-1, SE-ENG-3) are still waiting for the user's review in `docs/decisions-to-review.md`. The user answered three questions on 2026-11-25: no check icon on Home pills (Q-GLYPH), hide the "undone" notice after a pay-back to $0 (SE-ENG-2, option A), and keep "Did you pay?" in the bill footer when a bill turns early (SE-R-5). QA of the slice: pending QA when this was written.

*Numbering note:* the spec let the main session choose between a dated note on 0015 and a new ADR. This is a new ADR because it changes three things 0015 decided: when settling may start, the K6 exception, and what a stored mark means. 0021 was the next free number on 2026-11-25 (checked in this folder and in `README.md`).

## Context
[ADR 0015](0015-settling-one-payer-self-reported-marks.md) set up settling: one payer per bill, and each person marks "I paid" themselves. Two of its rules caused trouble once people used it:
- **You could only pay once every item on the bill was claimed** (M3 Q1). The user asked: "If tip and tax are split proportionally, I can settle up once I claim my items, right?" Under 0015 the answer was no.
- **If your share changed after you paid, the app only told you.** Sam marks "I paid $15.10", then Dee joins his Fries and his share drops to $14.00. 0015 showed a line ("Hana owes you $1.10 back") and nothing to press. The user asked for buttons: "allow re-request / re-pay of the difference".

The user also asked for Home to say where each bill stands ("Paid $15.10", "2 people left to pay", "Settled up"). That part is described in [in-app notices](../concepts/in-app-notices.md).

## Options
| Question | Options considered | Chosen |
|---|---|---|
| When can you pay early? | Never (0015); anyone on a proportional bill; **proportional bills, once you've claimed at least one item** | Proportional only, per person, once you have an item claim (SE-1) |
| Even-mode ("split evenly") bills | Allow early too; **keep them blocked until complete** | Blocked. Every new claimer changes everyone's even share |
| The all-$0 bill (K6) | Keep the app/database difference; **make the database refuse it too** | Refused on both sides (SE-3). K6 is closed |
| What a mark stores after a difference | Separate "paid more" and "paid back" columns; store $0 for "paid back in full"; **one net amount, and $0 clears the mark** | Net amount; a pay-back to exactly $0 clears the mark (SE-2 as changed by SE-ENG-1) |
| Who records a difference | Either side, both ways; the host too; **whoever sent the money** | The person records paying more; the payer records paying back (SE-4, SE-5) |
| Differences before the bill is complete | Allow buttons; **show the new amount as information only** | Info only; buttons once complete (SE-6) |
| Protecting against stale screens and retries | No check; a version-counter column; **the mark amount the screen showed, plus an idempotent retry** | `p_expected_cents` token + idempotent retry (SE-7, SE-ENG-3) |
| 1¢ differences from rounding | Ask for every cent; **ignore ±1¢** | Ignore ±1¢ in the app (SE-11) |

## Decision

### 1. Who may pay before the bill is complete (rule E)
One rule, written twice and tested on the same 20 cases (E1–E20) on both sides: `maySettle` in `lib/settle.ts` and `private.settle_state` in the database. For bill B and person U it answers one of four words:
- `all_zero`: rule Z (below) is true. Nobody may settle.
- `final`: every row is claimed. Anyone but the payer may settle (as in 0015).
- `early`: not complete, the bill is in proportional mode, and U has a claim on at least one **item** row (a $0.00 item counts; a claim on a discount row alone doesn't).
- `not_complete`: anything else.

`mark_paid` now accepts `final` or `early`. `settle_difference` (below) accepts only `final`.

Example: Hana paid. Burger (Hana), Salad (Sam), a Dessert nobody has claimed yet. Sam opens Settle up and sees `You owe Hana`, his amount, the Pay button, and "Your share may change until everything is claimed (1 item left)." Dee, who has claimed nothing, sees "Not ready yet. Claim what you had on the bill, then come back to pay."

**Why proportional only.** In proportional mode, tax and tip follow each person's items, and the not-yet-claimed items hold their own slot. So someone else claiming the Dessert doesn't change Sam's share, except by at most 1¢ of rounding. In even mode, every new claimer changes everyone's share, so an early amount would be a guess. The full reasoning, with numbers, is in [money and rounding](../concepts/money-and-rounding.md), "Paying early: why proportional shares stay put".

**Rule Z closes K6.** Z = proportional mode, every item row is $0.00, and the bill's total isn't the sum of its rows (there's tax or tip with nothing to spread it over). Under 0015 the app blocked such a bill but the database accepted a mark on it: the "K6" exception that 0015 §6 recorded on purpose. Now the database refuses with `22023 all_zero` too, so the app and database follow the same rule again, as CLAUDE.md asks. A property test checks that Z matches the app's old test ("complete, but `computeShares` leaves cents unclaimed") on 500 random complete bills.

### 2. A mark is the net amount; paying back to $0 clears it
`bill_participants.settled_cents` now means **the net amount settled between this person and the payer**: what they marked, plus differences they paid, minus what the payer paid back. The allowed range is still 1 to 99,999,999 cents, and no constraint changed.

When a pay-back brings the net to exactly $0, the mark is **cleared** (`settled_at` and `settled_cents` both become null). So $0 is never stored. Why (SE-ENG-1): a stored $0 would have needed its own card ("You paid Hana $0.00"), had no Undo anywhere, and would have stopped the person leaving the bill (rule L3 blocks anyone with a mark). Clearing keeps the schema, the payer-change counts and L3 exactly as they were. Activity still records the pay-back, so the history isn't lost.

### 3. Paying a difference: `settle_difference`
`settle_difference(bill, person, payer, p_expected_cents, p_new_cents)` changes one person's mark from the amount the screen showed to the new amount.
- **Who may call it depends on the direction** (SE-5). Raising a mark (paying more): only that person. Lowering it (paying back): only the current payer. Nobody else, not even the host. The rule is the same as the rest of the app: whoever sent the money records it.
- **Only once the bill is complete** (SE-6). Before that, the screen shows the new share and which way the difference goes, with no buttons.
- **It logs one Activity event**: `paid_difference` ("Sam paid Hana $1.10 more") or `paid_back` ("Hana paid Sam back $1.10").

What each person sees, with Sam marked at $15.10 and Hana the payer:

| Sam's share now | Sam's card | Hana's row for Sam |
|---|---|---|
| $16.20 | `You owe Hana more` / `$1.10`, **Pay Hana $1.10 more on Venmo**, **I paid the difference** | `Owes $1.10 more` and a **Request $1.10** link |
| $14.00 | `Hana owes you` / `$1.10`, a secondary (tonal, not filled) **Request $1.10 from Hana on Venmo** button that never writes anything | `You owe $1.10 back`, **Pay $1.10 back** and **I paid it back** |
| $15.11 | the normal "Marked paid" card (within the 1¢ tolerance) | `Paid` |

**The stale-state token.** `p_expected_cents` is the mark the screen showed. If the stored mark is different now (a double tap, a second phone, a pay-back that landed while Sam was in Venmo), the function refuses with `22023 mark_changed` and the screen re-reads. See [stale-state checks](../concepts/stale-state-checks.md).

**Idempotent retry** (SE-ENG-3). If the response to a successful call is lost and the app tries again, the database finds the mark **already at the requested amount** and returns success with no write, no event and no broadcast. Without this, the retry would hit `mark_changed` and tell the person their "I paid" had changed, for a write that worked. The cost: two phones raising the same mark to the same amount record it once, so a real double payment isn't flagged.

**What the token can't catch** (accepted, `docs/before-production.md` §4):
- The **share** changing again between screen load and tap. The database can't compute shares, so it can't know. The record still says what was actually paid (`from → to`), and any new gap shows after the next refetch.
- A mark that goes **away and back to the same amount** (review R8). The token compares amounts, not versions, so a replayed old call can match again. Only a direct API caller (or a very unlikely sequence) can do this; the app rebuilds each request from fresh data. The full fix is a per-row version counter.

### 4. Ignore ±1¢ (SE-11)
`SETTLE_DIFF_IGNORE_CENTS = 1` in `lib/settle.ts`: a difference of 1¢ either way isn't shown. Rounding alone can move an early share by 1¢ (§1), and asking someone to send $0.01 is noise. The database has no tolerance; it doesn't compare marks with shares at all. Cost: a payer can end up 1¢ short or over per person.

### 5. A pay-back stops at $0 (SE-12)
If Sam's share falls below $0 (a claimed coupon bigger than his items), Hana pays back his whole mark, and the rest stays "Hana also owes you $1.00 for your share. Settle that outside the app." (0015's existing answer for negative shares).

### 6. The "Did you pay?" prompt follows the payer and the mark, not the amount (contract O)
After Pay opens Venmo, the card asks "Did you pay Hana?". That prompt now stays while **the payer and the person's mark** are unchanged, even if the share moves, and "I paid" records **the amount that was opened**, because that's what was sent in Venmo. Any gap shows as a normal difference afterwards. The bill screen's footer follows the same rule. That includes a bill that turns early while the person is in Venmo (the host adds a row): the footer keeps "Did you pay Hana?" (SE-R-5, the user's choice).

> *Note 2026-11-27 ([ADR 0024](0024-sent-via-venmo-and-payment-methods.md)): this prompt is now the fallback, not the normal path. On phones and mobile web the Pay tap records "Sent via Venmo" itself. The prompt (now "Did you send Hana $15.10?" with "Yes, I sent it") shows only when the app can't know: the write's outcome is unknown (network error or timeout), the browser is a desktop one, or the mobile tab closed. The rule above (it follows the payer and the mark, and records the amount that was opened) is unchanged. "Pay Hana $1.10 more" also records automatically now (open first, then `settle_difference(…, 'venmo')`), with no check-in.*

### 7. No "undone" notice after a pay-back to $0 (SE-ENG-2, option A, the user's choice)
When someone else clears your mark, the Settle screen normally says "Your 'I paid' was undone." After a pay-back to $0 that would be alarming and wrong. The alternative, "Hana paid you back", would be false if Hana had actually used Undo. So when your new share is $0 or less, no notice shows. Activity has the real story. The rule: never say something untrue about money.

### 8. Honor system, unchanged
Differences are self-reported, like marks. A direct API caller can only (a) raise their **own** mark to any amount up to 99,999,999¢, or (b) as the payer, lower **other people's** marks down to clearing them. (b) is the payer saying "I paid you back", and it's strictly weaker than `unmark_paid`, which the payer already has. Both are logged in Activity with who did it. See [row level security](../concepts/row-level-security.md), "The app is not the only client".

## How this relates to 0015
0015's core stands: one payer picked by the host, self-reported marks, Venmo links built in one module. This ADR **amends** these details:

| 0015 said | 0021 says |
|---|---|
| Settling waits until every item is claimed (M3 Q1) | On proportional bills, you can pay once you've claimed an item. Even mode still waits |
| K6: the database accepts a mark on an all-$0 bill, on purpose | Closed: the database refuses (`22023 all_zero`) |
| A mark keeps the amount the screen showed; a later change is shown as text (`markDiffCents`) | A mark is the net amount settled; differences have Pay / Request / "I paid the difference" / "I paid it back" buttons |
| (no case) | A pay-back to exactly $0 clears the mark |
| Request buttons only for unmarked people (VR-5) | The payer also gets "Request $1.10" for a difference |

## Consequences
- The database gained three functions and changed one (`private.settle_state`, `private.bill_all_zero`, `public.settle_difference`; `mark_paid` rewritten) and two Activity kinds. No table grants or constraints changed.
- Early marks can surprise people when the host switches to "Split evenly": the bill goes back to blocked and the mark stays ("Your I paid is saved").
- Home reads more data on each load, to show settle pills (4 requests for at most 20 bills; `docs/before-production.md` §6).
- Rate limits: `settle_difference` joins the list of calls a script could repeat (`docs/before-production.md` §4).
- The Venmo links for differences reuse the pay and request formats, so they're verified on iPhone only (`docs/before-production.md` §5).

## Code (by name, since line numbers move)
- Rule E and Z in SQL, and `mark_paid`: `supabase/migrations/20261125090050_settle_early.sql` (`private.settle_state`, `private.bill_all_zero`, `public.mark_paid`). Tests: `supabase/tests/database/settle_early.test.sql` (E1–E20), the K6 block of `settle_marks.test.sql`.
- `settle_difference` and the event kinds: `supabase/migrations/20261125090051_settle_difference.sql`. Tests: `supabase/tests/database/settle_difference.test.sql` (D1–D20).
- App rules: `maySettle`, `allZero`, `settlePlan` (with `{ allowEarly: true }`), `differenceFor`, `differenceOf`, `SETTLE_DIFF_IGNORE_CENTS` in `lib/settle.ts`. Tests: `lib/settle.test.ts`.
- The E/D case lists stay in step: `lib/settleCaseIds.test.ts` reads both `.sql` files and the Jest files and fails if a `[E#]`/`[D#]` tag is missing on one side.
- Data layer: `settleDifference`, `fetchSettleData` in `lib/bills.ts`.
- Screens' logic: `openedStillMatches`, `noticeSnapshot`, `noticeFor`, `openedFor`, `differenceArgs` and the card/row/footer builders in `lib/settleView.ts`; Home pills in `lib/homeMarkers.ts` (`billMarker`, `billMarkerView`, `settleCandidateIds`).
- Activity sentences: `lib/activityText.ts`.

Concept notes: [money and rounding](../concepts/money-and-rounding.md), [stale-state checks](../concepts/stale-state-checks.md), [database functions](../concepts/database-functions.md), [in-app notices](../concepts/in-app-notices.md), [row level security](../concepts/row-level-security.md).
