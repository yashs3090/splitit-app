# Settle early, pay the difference, and settle status on Home

## Amendment A1 (2026-11-25)

The user approved the build ("okay start implementing") and said not to stop for questions. A1 folds in three documents:
- the staff engineer's review, `docs/specs/2026-11-25-settle-early-and-differences-eng.md` (F1–F7 and §1–§8), every recommendation adopted;
- the UX brief's spec-changing rows SE-UX-2, 4, 9, 14 and 17 (`docs/specs/2026-11-25-settle-early-and-differences-ux.md` §9);
- the visual design's model changes (§8 of `docs/specs/2026-11-25-settle-early-and-differences-visual.md`).

**How to read this spec now.** The design sections, tasks and criteria below have been edited in place, and every edited spot is tagged **(A1)**. Implementers work from this file. For copy, the brief's §10 copy reference also applies (copy-only rows SE-UX-1, 3, 5–8, 10–13 and 15). Where this spec quotes copy, that copy is current, and it wins over §10 where they differ. §10's `paidBackLine`, `rowPaidBack` and the "mark 0" variant of `diffLine` are **dropped** (A1.1). For layout and tones, the visual design doc applies, and its SE-VIS-1 tones replace the brief's SE-UX-10 tones.

**Glyph rule (A1.22; the visual pass's V11/P3, already on disk in `lib/settleView.ts:131`).** No string returned by `lib/settleView.ts` or `lib/homeMarkers.ts` contains `✓` or `⚠`. Each status string carries a `tone` instead (`CardLine.tone: 'muted' | 'success' | 'warning'`; rows' `status`/`subLine` tones likewise). The UI draws the icon from the tone (lucide `Check` for success, `TriangleAlert` for warning, through `components/ui/StatusLine` or `Banner`), and screen readers get words only. The brief and visual doc still show `✓`/`⚠` inside strings. Read those as "this text, with this tone": `✓` → `success`, `⚠` → `warning`. Every string quoted in this spec is already glyph-free. Home pills keep SE-VIS-1's two tones (`accent | muted`); whether a pill shows a check icon is open question Q-GLYPH.

**Who builds what (A1.23).** The visual-pass session (splitit-app-52) is editing `components/ui/Button.tsx` (including our label-wrap fix, SE-VIS-10), `components/Avatars.tsx` (our ring fix, SE-VIS-9), `components/SettleCard.tsx`, `components/SettleFooter.tsx`, `components/SettlePeopleList.tsx`, `components/PayerPicker.tsx`, `app/(app)/bills/[id]/settle.tsx`, `app/(app)/bills/[id]/index.tsx` and the copy in `lib/settleView.ts`. So: **Tasks 1–5 and 7 can start now. Tasks 6, 8 and 9 start only after that session reports V6–V13 done**, and they re-read every one of those files first. The Button and Avatar changes are **not** in our tasks.

Each change is logged as SE-ENG-* in `docs/decisions-to-review.md` ("Settle early and differences, engineering review"):

| A1 | Change | Decision | Where in this spec |
|---|---|---|---|
| A1.1 | **Paying back to exactly $0 clears the mark** (`settled_at` and `settled_cents` both null). The `1..99,999,999` constraint stays, so $0 is never stored. Dropped: the `paid_back` card state, the `Paid back` row status, 0-cent `unmarked_paid`, the D7 "0 → 500" case. Fixed by this: a paid-back person can leave or be removed (L3), and `set_payer` counts are unchanged | SE-ENG-1 (F2) | D4, D6, D8, D9, Tasks 2/4/5, criteria 8, 9, 23, 25, 29, 30, 56 |
| A1.2 | If the mark is cleared by someone else and the viewer's new share is ≤ $0, the "Your 'I paid' was undone" notice is **not shown**. (The alternative, "Hana paid you back.", could be false when the payer used Undo instead.) | SE-ENG-2 | D6 "Notices", criterion 60 |
| A1.3 | **Idempotent retry**: under the row lock, if the stored state already equals the request, `settle_difference` returns success with no write and no event, before the token compare | SE-ENG-3 | D4, criteria 7, 10, 13, 53 |
| A1.4 | The participant row is locked **`FOR NO KEY UPDATE`**, not `FOR UPDATE`. D10 corrected: `mark_paid`'s implicit lock is also `FOR NO KEY UPDATE`, and the `bill_events` foreign keys are listed | SE-ENG-4 | D4, D10, criterion 14 |
| A1.5 | **`pending` merged into `difference`**: one field, computed the same way in `ready` and `early` plans. The view decides whether it can be acted on (only in `ready`). Its copy says which way and how much (SE-UX-2) | SE-ENG-5, SE-UX-2 | D4, D6, criteria 19, 27 |
| A1.6 | **Contract O**: the "Did you pay?" prompt stays while the **payer and mark** match, not while the amount matches. Recording uses the opened amount | SE-ENG-6 (F3) | D6, criteria 28, 39, 59 |
| A1.7 | **Statuses with and without `allowEarly`** pinned | SE-ENG-7 (F4) | D2, Task 3, criteria 17b, 18 |
| A1.8 | **Pay-backs owed come before "nobody owes you"**, on the payer card and on Home | SE-ENG-8 (F5) | D6, D7, criteria 31, 35 |
| A1.9 | **Home batch read**: `.range(0, 999)` on each request, where a full 1,000 rows counts as a failure. Only bills that can show a settle pill are read. Each bill is parsed on its own. Claims are compared as sets | SE-ENG-9 (F1) | D7, Tasks 4/7/9, criteria 24, 44, 63 |
| A1.10 | The **host passes through `billMarker`** to the settle markers (it skips only `new`/`unclaimed`) | SE-ENG-10 | D7, criterion 36 |
| A1.11 | **E16–E20** added to both boundary tables. **Criterion 17c widened** to random sequences run to completion. `settle_state` is a single `language sql` statement with bigint sums | SE-ENG-11, SE-ENG-17 | D2, D10, criteria 1, 14, 16, 17 |
| A1.12 | **Shared case-id drift test**: one Jest test checks the `[E#]`/`[D#]` tags match across pgTAP and Jest | SE-ENG-12 | Task 10a, criterion 62 |
| A1.13 | **Undo kept for the host-payer** on difference rows, on its own line below the difference controls. A payer who isn't the host loses Undo while a difference is open (SE-UX-4) | SE-ENG-13, SE-UX-4 | D6 rows, criterion 30 |
| A1.14 | **Task 10 split into 10a and 10b**. New order (F7) | SE-ENG-14 | Tasks |
| A1.15 | **Planned breakage** listed per task (F6) | SE-ENG-15 | Tasks |
| A1.16 | Activity keeps the code's **single quotes** (`'I paid'`). Settle screen copy keeps its double quotes (`"I paid"`), as today | SE-ENG-16 | D8, criterion 25 |
| A1.17 | `pickerDecision` callers pass `complete: ready || early` | SE-ENG-18 | D6, criterion 61 |
| A1.18 | **Footer captions** for early-marked and for differences (SE-UX-9). Still no Pay in the footer | SE-UX-9 | D6 footer, criteria 34, 43 |
| A1.19 | **Home keeps the previous settle pills** during a refresh, and drops them if the read fails (SE-UX-14) | SE-UX-14 | D7, Task 9, criterion 44 |
| A1.20 | **"Add your Venmo"** also shows on an early plan once anyone can settle (SE-UX-17) | SE-UX-17 | D6, criterion 26 |
| A1.21 | Visual model changes: pill `tone: 'accent' \| 'muted'`; `SettlePeopleModel.wideStatus`; card block button `variant: 'secondary'` (outlined Request). The `Button` label wrap (SE-VIS-10) and Avatar ring (SE-VIS-9) are built by the visual pass, not here (A1.23) | SE-VIS-1, 3, 6, 9, 10 | D6, D7, Tasks 6–8, criteria 29, 30, 35, 64, U5 |
| A1.22 | **Glyph rule**: strings carry no `✓`/`⚠`, only a `tone`. The UI draws the icon | SE-ENG-19 (visual pass V11) | everywhere copy is quoted; criteria 30, 44, 66 |
| A1.23 | **Who builds what**: Tasks 6, 8 and 9 wait for the visual pass (V6–V13) and re-read its files. Tasks 1–5 and 7 start now. Button and Avatar changes are dropped from our tasks | SE-ENG-20 | Tasks, criterion 65 (removed) |
| A1.24 | **Task 7 depends only on Task 3**: Home markers read the plan (`lib/settle.ts`), not Task 6's card models. **Task 3 adds the early status through `settlePlan` overloads**, so it doesn't touch `lib/settleView.ts` (replaces the stub-case plan) | SE-ENG-21 | D7, Tasks 3/6/7, planned breakage, criteria 36, 37, 67 |

---

Date: 2026-11-25. Follow-up to M3 (`docs/specs/2026-11-24-m3-settle-venmo.md`, UX brief `docs/specs/2026-11-24-m3-settle-ux.md`, ADR 0015). Builds on the built Venmo note spec (`2026-11-25-venmo-note-item-names.md`), the built Request buttons spec (`2026-11-25-venmo-request-buttons.md`) and the built bill-markers slice (`2026-11-24-bill-markers-and-notices.md`). Companion documents: UX brief `2026-11-25-settle-early-and-differences-ux.md`, visual design `2026-11-25-settle-early-and-differences-visual.md`, engineering review `2026-11-25-settle-early-and-differences-eng.md`.
Repo: `splitit-app` only (ADR 0011). **The main session assigns migration timestamps** (and an ADR number, if it wants one for this; otherwise ADR 0015 gets a dated note).

User requests (2026-11-25):
1. "If tip and tax are split proportionally, I can settle up once I claim my items, right?" Today: no (M3 Q1 / C1 blocks Pay and "I paid" until every row is claimed, in both modes).
2. "If the amount changes afterwards … allow re-request / re-pay of the difference, with a button." If the share went up, the person pays the difference. If it went down, the payer pays it back, or the person requests it.
3. Home's "Your bills": "Paid" on bills I owe on and have paid; on bills I'm owed money on, "Settled up" when everyone has paid, or "2 people left to pay".

The user said not to stop for questions. Every decision is logged with a Why column in `docs/decisions-to-review.md` under "2026-11-25 · Settle early and differences" (SE-*), "… Home settle markers" (HM-*), the UX brief (SE-UX-*), the visual design (SE-VIS-*) and the engineering review (SE-ENG-*). **Money: needs your look** items are listed at the end.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already running) | 2 migrations: settle rules, the `mark_paid` change, `settle_difference`, 2 event kinds | $0, already set up |
| Two Google test accounts (already set up) | User checks U2–U5 on web | $0 |
| Venmo app + the user's own Venmo account on the iPhone | User check U1 (difference links fill in the right amount). Nobody presses Pay or Request | $0, already used |
| Android phone with Venmo (optional) | U1 on Android | $0; not run if there isn't one |
| Venmo API, hosted Supabase, paid Apple Developer | **Not needed** | $0 |

Nothing new to sign up for.

## Goal
- In a proportional bill, you can pay your share as soon as you've claimed your items, without waiting for everyone else. The screen tells you the amount may still change.
- If your share changes after you marked "I paid", the app shows a button for the exact difference: "Pay Hana $1.10 more on Venmo". The other way round, Hana gets "Pay $1.10 back" and you get "Request $1.10 from Hana". Recording the difference makes both sides show settled again.
- Home tells you at a glance where each bill stands: "You owe $15.10", "Paid $15.10", "2 people left to pay", "Settled up".

## In scope
- DB: one shared "may this person settle" rule (E) used by `mark_paid`; `mark_paid` early in proportional mode; the all-$0 rule (Z) enforced in SQL, closing K6; a new `settle_difference` function with a stale-state token and an idempotent retry; two new Activity kinds. **(A1)** Paying back to exactly $0 clears the mark. The `settled_cents` constraint is unchanged.
- `lib/settle.ts`: rules E and Z, an `early` plan status, a `difference` per marked person (ready and early).
- `lib/bills.ts`: the `settleDifference` wrapper, new error codes, a batched read for Home with a truncation guard.
- `lib/activityText.ts`: two sentences.
- `lib/settleView.ts`: early cards, difference cards and rows, footer captions, contract O, `noticeSnapshot`, `wideStatus`, the outlined block-button variant.
- `lib/homeMarkers.ts`: settle markers, pill tones, which bills to read.
- Settle screen, bill-screen footer, Home rows. **(A1)** `components/ui/Button.tsx` (long labels wrap) and `components/Avatars.tsx` (1-pt ring), from the visual design.
- Docs.

## Out of scope (cut)
- **Early settling in even mode.** Totals are hidden until complete (ADR 0014), and every new claimer changes everyone's even share. It stays blocked.
- **Paying from the bill screen's footer while the bill is incomplete.** Early paying happens on Settle up, where there's room for the "may change" line. The footer only changes its button and caption (SE-9, SE-UX-9).
- **Paying a difference before the bill is complete** (SE-6). The screen shows the new share and says which way the difference goes and how much. It's settled once everything is claimed.
- **Request buttons for the payer before the bill is complete** (SE-8).
- Negative remainders: a share below $0 is still "settle that outside the app" (M3 Q6). Pay-back goes down to $0, not below (SE-12), and reaching $0 clears the mark (A1.1).
- The payer or host marking someone else as paid; reminders; a live Home list (Home refreshes the way it does today).
- Any change to `set_payer`, `unmark_paid`, `set_extras_split`, `leave_bill`, `remove_participant`, `my_bills`, table grants or **(A1)** the `bill_participants` constraints.
- **(A1)** A one-snapshot Home read (option (d), a definer RPC returning raw rows). It's the upgrade path, recorded in before-production.

## Design

### D1. Why your share can still change after you pay early (proportional mode)
In proportional mode, `computeShares` (`lib/split.ts`) spreads tax, tip, fees and bill-level discounts over weights `[each person's items, unclaimed items]`. The sum of those weights is the sum of every item row, and it doesn't change when other people claim. So **someone else claiming an unclaimed item does not change your share** (except by one cent; see below). That's what makes early paying safe in proportional mode and not in even mode.

Your share can still change after you've paid, because of:

| # | Cause | Example | Size |
|---|---|---|---|
| W1 | Someone joins an item you claimed | Dee joins your Fries, so your half becomes a third | your piece of that row, plus its tax/tip |
| W2 | A custom split on a shared item | Sam sets Fries to 2 parts for you, 1 for Dee | same |
| W3 | You claim or unclaim something yourself | you add a dessert after paying | that row plus its tax/tip |
| W4 | Host edits | price, tax, tip, total, a new row, removing your row | anything |
| W5 | Host switches to "Split evenly" | the bill is blocked until complete (even mode); your mark stays | then anything |
| W6 | Claimable discounts | you, or someone sharing it with you, claims a discount row (ADR 0017) | that discount's piece |
| W7 | Largest-remainder rounding | the spare cent of tax/tip moves when the unclaimed bucket shrinks | at most 1¢ **in total** from your mark to completion, over any sequence of other people's actions on rows you didn't claim (A1, engineering review §1; criterion 17c) |
| W8 | Someone leaves or is removed while sharing your item | their claim goes, your piece grows | your piece of that row |
| W9 | Payer change | clears every mark (unchanged, M3-2) | the mark is gone |

How the screen sets that expectation: an unmarked early card says **"Your share may change until everything is claimed (3 left)."** A card marked early with no change says **"If your share changes, you'll settle the difference here once everything is claimed."** (SE-UX-1). **(A1)** A marked person whose share moved before completion sees the new share, which way the difference goes and how much (SE-UX-2, D6). W7 is absorbed by the difference tolerance (D4, SE-11), so nobody is asked to send 1¢.

### D2. Shared contract E: "may this person mark paid" (defined once; Task 1 and Task 3 both implement it)

Definitions, for bill B and user U:
- **complete(B)**: rule C1, unchanged: every `line_items` row of B (items and discount rows) has at least one claim.
- **itemSum(B)** = Σ `total_cents` of B's rows with `kind = 'item'`. **rowSum(B)** = Σ `total_cents` of all B's rows (discount rows are negative). **extras(B)** = `bills.total_cents − rowSum(B)`. **(A1)** In SQL all three are `bigint`, and none is cast back to `integer` (500 rows × 9,999,999 overflows int4).
- **allZero(B)** (rule Z) = `extras_split = 'proportional'` AND itemSum(B) = 0 AND extras(B) ≠ 0. ("Every item is $0 but the bill isn't": there's nothing to spread tax and tip over.) This is the "total/claims mismatch" case from the request.
- **hasItemClaim(B, U)** = U has a claim (parts ≥ 1) on a row of B with `kind = 'item'` (any price, $0 included). A claim on a discount row alone doesn't count.

**Rule E.** `maySettle(B, U)` is:
- `'all_zero'` if allZero(B);
- else `'final'` if complete(B);
- else `'early'` if `extras_split = 'proportional'` and hasItemClaim(B, U);
- else `'not_complete'`.

`mark_paid` accepts only `'final'` or `'early'`. `settle_difference` accepts only `'final'` (SE-6).

In the DB: `private.bill_all_zero(p_bill_id) returns boolean` and `private.settle_state(p_bill_id, p_user_id) returns text` (the four values above). Neither is client-executable. **(A1)** `private.settle_state` is **one `language sql` statement** (CTEs), so all its reads see one snapshot. Under READ COMMITTED each `select` in plpgsql takes a new snapshot, and a claim committing between two of them could give an answer that matches no real state. `mark_paid` and `settle_difference` call it once each. In the app: `allZero(input: SplitInput): boolean` and `maySettle(input: SplitInput, userId: string): 'final' | 'early' | 'not_complete' | 'all_zero'` in `lib/settle.ts`, built on `sharesComplete` and the same row/claim data `normalize` keeps.

Why these are the same rule: DB claims always have parts ≥ 1 (`claims_parts_range`) and belong to a participant (`claims_participant_fkey`), so `normalize` drops nothing the DB stores. `kind` is the same column, and `extras_split` and `total_cents` are read as they are. Rule Z on a complete bill is exactly the case where `computeShares(...).unclaimedCents ≠ 0` today (`settlePlan`'s `blocked_all_zero`). Task 3's property test checks that equivalence.

**Plan statuses with and without `allowEarly` (A1, F4; Task 3 implements, Task 6 relies on it):**

| Bill | without `allowEarly` (today) | with `allowEarly` |
|---|---|---|
| payer isn't a participant | `blocked_bad_payer` | `blocked_bad_payer` |
| complete, allZero | `blocked_all_zero` | `blocked_all_zero` |
| complete, not allZero | `ready` | `ready` |
| incomplete, allZero (proportional only) | `blocked` | `blocked_all_zero` |
| incomplete, proportional, not allZero | `blocked` | `early` (per-person `canSettle`) |
| incomplete, even | `blocked` | `blocked` |

Boundary cases. **Both** `supabase/tests/database/settle_early.test.sql` and `lib/settle.test.ts` test every row and set it up the same way (in the DB through `create_bill`, `join_bill`, `set_claim`, `set_item_split`, `set_extras_split`, `update_bill`). **(A1)** Each test's description starts with its tag, e.g. `[E7]`, in both files (criterion 62 checks that the tag sets match):

| # | Bill state (U = Sam, payer = Hana) | maySettle(Sam) | `mark_paid` as Sam |
|---|---|---|---|
| E1 | proportional, 3 rows, Sam claimed 1, 1 row unclaimed | early | accepted |
| E2 | proportional, incomplete, Sam claimed nothing | not_complete | `22023 not_complete` |
| E3 | proportional, incomplete, Sam claimed only a discount row | not_complete | `22023 not_complete` |
| E4 | proportional, incomplete, Sam claimed only a $0.00 item (other items > 0) | early | accepted. **UI hides the button** (Sam's share is ≤ $0, role `nothing`); the DB allows it, same as PI-M-1 |
| E5 | even, incomplete, Sam claimed 1 item | not_complete | `22023 not_complete` |
| E6 | proportional, complete, Sam claimed nothing (another person claimed all) | final | accepted (PI-M-1, unchanged) |
| E7 | proportional, incomplete, Sam's only claim is 1 part of a shared row | early | accepted |
| E8 | proportional, every row $0.00 and claimed, total 500 (today's K6) | all_zero | `22023 all_zero` (**was accepted; K6 closed**, SE-3) |
| E9 | proportional, every item $0.00, incomplete, Sam claimed one, total 500 | all_zero | `22023 all_zero` |
| E10 | proportional, every item $0.00, total 0, no discounts, incomplete, Sam claimed one | early (extras 0, not allZero) | accepted |
| E11 | even, complete (K1) | final | accepted |
| E12 | even, every item $0.00, complete, total 500 | final (Z is proportional only; even splits extras among claimers) | accepted |
| E13 | E1, then Hana (host) switches to even | not_complete | `22023 not_complete`; Sam's existing mark is kept |
| E14 | E1 as Hana (the payer) | early | `22023 is_payer` (checked before E) |
| E15 | proportional, items 1000 + discount −1000 (claimable, unclaimed), total 0, Sam claimed the item | early (itemSum 1000) | accepted |
| E16 **(A1)** | proportional; every item claimed, only a claimable discount row unclaimed; Sam has an item claim | early (incomplete only because of the discount; the card says "1 discount left") | accepted |
| E17 **(A1)** | proportional, complete, every item $0.00, total 0, no discounts | final (complete twin of E10; pins 17a) | accepted with `p_cents` 1 (UI hides the button: share $0) |
| E18 **(A1)** | proportional; every item $0.00; one claimable discount of −1 (unclaimed); total 0; Sam claimed an item | all_zero (extras = +1 comes only from the discount; catches SQL that sums only `kind = 'item'` for extras) | `22023 all_zero` |
| E19 **(A1)** | proportional; items 600 + 400; total 999 (extras −1); 400 unclaimed; Sam claimed 600 | early (negative-extras path) | accepted |
| E20 **(A1)** | E1, then the host deletes Sam's only item row (`update_bill`) | not_complete (hasItemClaim goes false through an edit) | `22023 not_complete` |

Rows K1–K5 of M3 C1 stay as they are for `private.bill_is_complete` (unchanged function).

### D3. `mark_paid`, changed (Task 1)
Same signature, same grants, `create or replace`. New check order (the app's error mapping relies on it):

| Step | Check | Error |
|---|---|---|
| 0 | signed out | `42501 not_allowed` |
| 1 | caller not a participant of an existing bill (plain read, **no lock**; R4 rule from `20261124094656_people_review_fixes.sql`) | `42501 not_allowed` |
| 2 | lock the bills row `FOR SHARE` (as today), then re-check participation | `42501 not_allowed` |
| 3 | `p_cents` null or outside 1..99,999,999 (C2, unchanged) | `22023 invalid_amount` |
| 4 | `p_payer_id` isn't the current payer | `22023 payer_changed` |
| 5 | caller is the payer | `22023 is_payer` |
| 6 | settle_state (one call) = `all_zero` | `22023 all_zero` |
| 7 | settle_state = `not_complete` | `22023 not_complete` |
| 8 | already marked: no-op, no event (unchanged: the first mark wins; differences go through `settle_difference`) | — |
| 9 | set `settled_at = now()`, `settled_cents = p_cents`; log one `marked_paid` (unchanged details). **(A1)** The conditional `update` takes `FOR NO KEY UPDATE` on the participant row implicitly | — |

### D4. Shared contract D: the difference (defined once; Task 2, Task 3 and Task 6 point here)

**Stored meaning of a mark (A1, SE-ENG-1):** `settled_cents` is the **net amount settled** between this person and the payer: what they marked paid, plus differences they paid, minus what the payer paid back. The range is unchanged, **1..99,999,999**, and the constraints are unchanged. **When a pay-back brings the net to exactly $0, the mark is cleared** (`settled_at = null`, `settled_cents = null`), so $0 is never stored. `mark_paid` accepts `p_cents` 1..99,999,999. `settle_difference` accepts `p_expected_cents` 1..99,999,999 (the current mark) and `p_new_cents` 0..99,999,999 (0 = "paid back in full", which clears).

**The difference, in `lib/settle.ts`** (A1, SE-ENG-5: one field, no `pending`). For each marked non-payer in a **`'ready'` or `'early'`** plan, `difference: SettleDifference | null`:
- `target = max(owedCents, 0)` (a share below $0 isn't paid back past $0; Q6 still handles the rest, SE-12).
- `delta = target − mark.cents`.
- If `|delta| ≤ SETTLE_DIFF_IGNORE_CENTS` → `null` (starting value **1**, SE-11; set 0 to show every cent).
- Else if `delta > 0` → `{ kind: 'more', cents: delta, fromCents: mark.cents, toCents: target }`: the person owes the payer `delta` more.
- Else → `{ kind: 'back', cents: −delta, fromCents: mark.cents, toCents: target }`: the payer owes the person `−delta` back. `cents` is never more than the mark. `toCents = 0` means recording it clears the mark.
- Unmarked people, the payer, and every plan other than `ready`/`early` → `null`.
- **Who may act on it is the view's decision:** in `ready` the view shows buttons (D6). In `early` it shows an info line only (SE-6).
- `markDiffCents` / `markDiffers` keep today's meaning (M3 41a, tests unchanged). The view stops reading them and reads `difference` instead.

**The DB function** (Task 2): `public.settle_difference(p_bill_id uuid, p_user_id uuid, p_payer_id uuid, p_expected_cents integer, p_new_cents integer) returns void`, security definer, `search_path = ''`, execute for `authenticated` only.
- `p_user_id` is the person whose mark changes (the one who owes or is owed back). `p_expected_cents` is the **stale-state token**: the `settled_cents` the screen showed. `p_new_cents` is `toCents`.
- **Who may call, by direction:** if `p_new_cents > p_expected_cents` (paying more), only `p_user_id` themself. If `p_new_cents < p_expected_cents` (paying back), only the current payer. Nobody else, the host included (the person who owes the money records it, as with "I paid"; SE-5).

Check order:

| Step | Check | Error |
|---|---|---|
| 0 | signed out | `42501 not_allowed` |
| 1 | caller not a participant (plain read, no lock) | `42501 not_allowed` |
| 2 | lock bills row `FOR SHARE`, re-check participation | `42501 not_allowed` |
| 3 | **(A1)** `p_expected_cents` null or outside 1..99,999,999; `p_new_cents` null or outside 0..99,999,999; or the two are equal | `22023 invalid_amount` |
| 4 | `p_payer_id` isn't the current payer | `22023 payer_changed` |
| 5 | wrong caller for the direction (above), or `p_user_id` is the payer | `42501 not_allowed` |
| 6 | settle_state(bill, p_user_id) (one call) = `all_zero` | `22023 all_zero` |
| 7 | settle_state ≠ `final` | `22023 not_complete` |
| 8 | **(A1)** lock `p_user_id`'s participant row **`FOR NO KEY UPDATE`**; no such row | `22023 mark_changed` |
| 9 | **(A1) Idempotent retry:** the row already holds the requested state (`p_new_cents ≥ 1` and `settled_cents = p_new_cents`, or `p_new_cents = 0` and the row has no mark). Return success with no write, no event and no broadcast | — |
| 10 | the row isn't marked, or `settled_cents is distinct from p_expected_cents` | `22023 mark_changed` |
| 11 | **(A1)** `p_new_cents ≥ 1`: set `settled_cents = p_new_cents` (`settled_at` unchanged: it's when they first marked). `p_new_cents = 0`: set `settled_at = null, settled_cents = null`. Log one event: `paid_difference { payer_id, from, to }` with actor = caller (more), or `paid_back { user_id, from, to }` with actor = caller (back, `to` may be 0) | — |

Why the token: two devices, a double tap, or a pay-back that lands while the person is in Venmo would otherwise record the wrong total. With the token, a conflicting second write fails with `mark_changed` and the screen re-reads. The token can't detect the **share** changing again between screen load and tap (the DB can't compute shares). That's fine: the record says what was actually paid (`from → to`), and the screen shows any new difference after the refetch.

Why idempotent (A1.3): a retry after a lost response would otherwise hit `mark_changed` and show alarming copy for a write that worked. What it gives up: two devices raising the same mark to the same value record once. The person paid once, so that's usually right, but a real duplicate payment from two devices isn't flagged (before-production §4). Idempotency never skips steps 0–7 (D20).

Boundary cases. **Both** `settle_difference.test.sql` and `lib/settle.test.ts` (+ `lib/bills.test.ts` for the local refusals) test them, each tagged `[D#]`. Rows D1–D7 have a lib `difference` value and appear in both; D8–D20 are DB-only (criterion 62):

| # | Mark | Share now | lib `difference` | Call | DB result |
|---|---|---|---|---|---|
| D1 | 1510 | 1620 | more 110, 1510→1620 | Sam `(…, 1510, 1620)` | stored 1620, `paid_difference {from 1510, to 1620}` |
| D2 | 1510 | 1400 | back 110, 1510→1400 | Hana `(…, Sam, …, 1510, 1400)` | stored 1400, `paid_back` |
| D3 **(A1)** | 1510 | 0 | back 1510, →0 | Hana `(…, 1510, 0)` | **mark cleared** (`settled_at` and `settled_cents` null), `paid_back {from 1510, to 0}` |
| D4 **(A1)** | 1510 | −100 | back 1510, →0 (not 1610) | Hana `(…, 1510, 0)` | mark cleared; Sam's card is the Q6 negative card |
| D5 | 1510 | 1511 | null (tolerance) | Sam `(…, 1510, 1511)` sent anyway by a direct caller | accepted (the DB has no tolerance; SE-11) |
| D6 | 1510 | 1512 | more 2 | Sam `(…, 1510, 1512)` | stored 1512 |
| D7 **(A1)** | none | 500 | null (unmarked: Sam uses Pay / "I paid") | Sam `(…, 0, 500)` | `22023 invalid_amount` (the token must be ≥ 1) |
| D8 | 1510 | 1620 | — | Sam `(…, 1400, 1620)` (stale) | `22023 mark_changed`, nothing changes |
| D9 **(A1)** | none | 1620 | null | Sam `(…, 1510, 1620)` | `22023 mark_changed` |
| D10 | 1510 | — | — | Sam `(…, 1510, 1510)` | `22023 invalid_amount` |
| D11 | 1510 | — | — | `p_new_cents` 100000000, −1, null; `p_expected_cents` 0, null | `22023 invalid_amount` |
| D12 | 1510 | 1400 | — | **Sam** `(…, 1510, 1400)` (lowering his own) | `42501 not_allowed` |
| D13 | 1510 | 1620 | — | **Hana** `(…, Sam, …, 1510, 1620)` | `42501 not_allowed` |
| D14 | 1510 | 1400 | — | Dee (host, not payer) either direction | `42501 not_allowed` |
| D15 | 1510 | 1620 | — | bill incomplete (E1 state) | `22023 not_complete` |
| D16 | 1510 | — | — | stale `p_payer_id` | `22023 payer_changed` |
| D17 | 1510 | — | — | outsider, anon, unknown bill | `42501` |
| D18 **(A1)** | 1620 (after D1) | 1620 | null | Sam `(…, 1510, 1620)` again (retry) | success; no write, no event, no broadcast; stored 1620 |
| D19 **(A1)** | none (after D3) | 0 | null | Hana `(…, 1510, 0)` again (retry) | success; no event; still no mark |
| D20 **(A1)** | 1620 (after D1) | — | — | Dee `(…, 1510, 1620)` | `42501 not_allowed` (idempotency doesn't skip step 5) |

### D5. Paying back (decision SE-4)
- **The payer pays back, and marks it.** The payer's row for Sam shows "Pay $1.10 back" (a Venmo **pay** link to Sam's username from the same builder, `venmoPayUrl({ username: Sam's, cents: 110, itemNames: Sam's items })`) and "I paid it back" (calls `settle_difference` to lower Sam's mark; lowering it to $0 clears the mark, A1.1). This mirrors the rest of the app: **whoever owes the money pays and marks it.**
- **The person may nudge with a Request.** Sam's card shows "Request $1.10 from Hana on Venmo" (`venmoRequestUrl({ username: Hana's, cents: 110, itemNames: Sam's items })`) as an **outlined** block button (SE-VIS-3). Like the payer's Request buttons, it never writes anything (VR-6, VR-10).
- The "more" direction mirrors this: Sam pays ("Pay Hana $1.10 more") and records "I paid the difference", and the payer's row shows "Request $1.10" (this reverses VR-5).
- All four links use the same `venmoNote` rule (the items of the person whose share it is). No new note text.

### D6. Cards, rows, footer, notices (Task 6; all copy in `lib/settleView.ts`)

**Early plan** (`settlePlan(..., { allowEarly: true })` returns `{ status: 'early', payerId, unclaimedRows, unclaimedDiscountRows, people }`; people as in `'ready'`, each non-payer with `canSettle: boolean` from `maySettle` and `difference` per D4):

| Viewer | Card |
|---|---|
| owes, can settle, unmarked | the existing 3.1 / 3.2 / 3.5 cards (same buttons, same Pay URL), plus a muted line **`Your share may change until everything is claimed (<n> left).`** as the last line of the head group (`<n> left` uses `leftToClaim`, so "1 item left", "2 items and 1 discount left") |
| cannot settle (no item claim) | label `Not ready yet`, body **`Claim what you had on the bill, then come back to pay.`**, primary `Back to the bill` |
| nothing / negative, can settle | existing 3.6 / 3.7 cards plus the "may change" line |
| marked, `difference` null | existing 3.3 card (`You paid Hana / $15.10 / Marked paid` (success), Undo) plus muted **`If your share changes, you'll settle the difference here once everything is claimed.`** (SE-UX-1) |
| **(A1)** marked, `difference.kind = 'more'` | 3.3 card plus muted, no glyph: **`Your share is now $16.20. You'll pay the $1.10 difference once everything is claimed.`** (SE-UX-2) |
| **(A1)** marked, `difference.kind = 'back'` | 3.3 card plus muted: **`Your share is now $14.00. Hana will owe you $1.10 back once everything is claimed.`** The amount is `difference.cents` (capped at the mark), so a share of −$1.00 on a $15.10 mark reads `Your share is now -$1.00. Hana will owe you $15.10 back once everything is claimed.` |
| payer | label **`Waiting for everyone to claim`**, no amount; muted lines `<n> left to claim` and, when anyone is marked, `<p> paid so far` (live, polite; hidden at 0). No Request buttons (SE-8) |

**(A1, SE-UX-17) "Add your Venmo"**: `addVenmoPrompt` also returns the prompt on an `early` plan when the viewer is the payer, `payerVenmo` is null, and any non-payer entry has `canSettle: true`. On `ready` it's unchanged. Otherwise null.

Everyone list in early mode: rows for people with an item claim or a mark (existing row content; a marked row with a `difference` uses today's sub-line `Marked $15.10 · share now $16.20` with tone `warning`), aside `null`, no Request, pay-back or "I paid it back" controls. Undo follows Q4 as today.

**Ready plan, differences (card):**

| Card state | When | Label / amount | Lines | Buttons |
|---|---|---|---|---|
| `more_due` | viewer marked, `difference.kind = 'more'` | `You owe <Payer> more` / `$1.10` | muted: `Your share is now $16.20. You've marked $15.10 paid.` | primary `Pay <Payer> $1.10 more on Venmo` (a11y `Pay Hana $1.10 more on Venmo, to @hana-1`, hint `Opens Venmo`); notes `@hana-1 · $1.10` (+ web line `On a computer? Send it from the Venmo app on your phone.`); ghost `I paid the difference` (hint `Marks the $1.10 difference as paid`); ghost `Undo "I paid"` (a11y `Undo your I paid`, hint `Clears your whole I paid of $15.10`; SE-UX-3) |
| `more_opened` | contract O holds for an opened `kind: 'more'` | `Did you pay <Payer> $1.10?` / `$1.10` (**the opened `cents`**) | — | primary `I paid the difference` (records `opened.fromCents → opened.fromCents + opened.cents`); notes; ghost `Open Venmo again` |
| `more_due`, payer has no Venmo | | same | + `<Payer> hasn't added Venmo yet. Ask them, or pay another way.` | primary `I paid the difference`; ghost `Undo "I paid"` |
| `back_due` | viewer marked, `difference.kind = 'back'` | `<Payer> owes you` / `$1.10` | muted: `Your share is now $14.00. You've marked $15.10 paid.`; when the share is below $0, also `<Payer> also owes you $1.00 for your share. Settle that outside the app.` (SE-UX-7) | **(A1, SE-VIS-3)** block button `Request $1.10 from <Payer> on Venmo` with **`variant: 'secondary'`** (outlined; the card has no primary). a11y `Request $1.10 from Hana on Venmo, @hana-1`, hint `Opens Venmo`; **never writes**; notes `@hana-1 · $1.10` (+ web `On a computer? Send requests from the Venmo app on your phone.`); ghost `Undo "I paid"` |
| `back_due`, payer has no Venmo | | same | `… You've marked $15.10 paid.` + `Ask <Payer> to pay you back.` | ghost `Undo "I paid"` |

- **(A1)** There is no `paid_back` state. After a pay-back to $0 the mark is gone, and the viewer sees 3.6 (`You're all set`) or 3.7 (negative), the same as anyone unmarked who owes nothing.
- **(A1, SE-VIS-3)** `SettleButton` gains `variant?: 'secondary'`. It's used only on the card's block-button slot. Absent means today's filled primary.
- `I paid the difference` calls `settleDifference(bill, me, payerId, fromCents, toCents)` with the values from the **shown or opened model**, never recomputed in the component.
- Errors use `actionError`, extended: `mark_changed` → `Your "I paid" just changed. Check the amount and try again.` (refetch); `not_complete` → `Something on the bill just changed. Check your share and try again.` (refetch; SE-UX-13; `BILL_ERROR_COPY` untouched); `all_zero` reaches the view as `invalid_bill` (Task 4) → `SETTLE_COPY.invalidBill` (refetch, unchanged).
- The 3.4 `marked_changed` state and `shareChangedLine` are removed (replaced by `more_due` / `back_due`; a difference within tolerance shows the plain 3.3 card).

**Contract O: the "Did you pay?" prompt (A1, F3; defined once, used by the Settle card and the bill footer).**
`OpenedVenmo = { kind?: 'share' | 'more'; payerId: string; cents: number; fromCents?: number }`. An absent `kind` means `'share'`, and `fromCents` is required when `kind` is `'more'`. `openedStillMatches(plan, viewerId, opened)` keeps the prompt while:
- `'share'`: the plan is `ready`, or `early` with the viewer's `canSettle` true; `plan.payerId === opened.payerId`; and the viewer has **no mark**. The viewer's current share and role don't matter.
- `'more'`: the plan is `ready`; `plan.payerId === opened.payerId`; and the viewer's mark exists with `mark.cents === opened.fromCents`.

While it holds, the card is `owes_opened` / `more_opened` whatever the share is now, its amount is `opened.cents`, and recording uses the opened values: `'share'` → `mark` with `cents: opened.cents`; `'more'` → `mark_difference` with `fromCents: opened.fromCents`, `toCents: opened.fromCents + opened.cents`. Why: the person already sent that amount in Venmo, and the record must say what was sent. Any gap left after the write shows as a normal difference on the next refetch.

**Notices (A1.2, SE-ENG-2).** `NoticeSnapshot` gains `myShareCents: number | null` (the viewer's `owedCents` in a `ready`/`early` plan, else null), built by a new `noticeSnapshot(input: SettleViewInput): NoticeSnapshot` so the screen does no money reads. `noticeFor` doesn't return `markUndoneBanner` when `next.myShareCents !== null && next.myShareCents <= 0`. Everything else in `noticeFor` is unchanged.

**`pickerDecision` (A1.17).** Unchanged signature. Its caller (`app/(app)/bills/[id]/settle.tsx:304`, Task 8) passes `complete: status === 'ready' || status === 'early'`, so "People may already be paying …" shows while people can pay early.

**Rows (payer's view, ready plan):**

| Row | Status (tone) | Sub-line | Controls |
|---|---|---|---|
| more due | `Owes $1.10 more` (muted) | `Marked $15.10 · share now $16.20` (tone **muted** on ready rows, not warning; SE-UX-5) | request link: label `Request $1.10`, a11y `Request $1.10 more from Sam on Venmo, @sam-1`, hint `Opens Venmo`, caption `@sam-1`; or caption `Hasn't added Venmo` |
| back due | `You owe $1.10 back` (**warning**; SE-UX-5) | same sub-line form | ghost `Pay $1.10 back` (a11y `Pay Sam $1.10 back on Venmo, to @sam-1`, hint `Opens Venmo`) when Sam's username is valid, else caption `Hasn't added Venmo`, or over the link cap `Pay it back in the Venmo app`; ghost `I paid it back` on its own line (a11y `Mark that you paid Sam $1.10 back`, hint `Changes Sam's I paid to $14.00`, or `Clears Sam's I paid` when `toCents` is 0) |

- `SettleRowModel.status.tone` gains `'warning'`.
- **(A1, SE-VIS-6)** `SettlePeopleModel` gains `wideStatus: boolean`. It's true when any row's status is a difference status (more due / back due in any wording), otherwise false.
- **(A1, SE-UX-11)** The list's web line: when any row has a `pay_back` link, it's `On a computer? Open Venmo on your phone to pay or request.`. With only Request links, it's the existing request line.
- **Undo on difference rows (A1, SE-UX-4 + SE-ENG-13):** while a row has an open difference, the **payer's** Undo is hidden **unless the payer is also the host**. In that case Undo stays, on its own line below the difference controls (existing inline confirm). The host who isn't the payer keeps Undo on every marked row and has no difference controls. Once the difference is settled, the payer's Undo comes back. Q4 is otherwise unchanged. The viewer's own Undo stays on their card.

Other viewers see statuses and no controls (except the host's Undo per Q4): `Owes $1.10 more`, `<Payer> owes $1.10 back` (muted). On the **viewer's own row** (SE-UX-6): `You owe $1.10 more`, `<Payer> owes you $1.10 back`.

Row a11y labels include everything shown, in reading order: payer viewing `Sam, marked paid $15.10, share is now $16.20, owes $1.10 more` and `Ana, marked paid $15.10, share is now $14.00, you owe Ana $1.10 back`; others viewing `Ana, marked paid $15.10, share is now $14.00, Hana owes Ana $1.10 back`; own row `You, marked paid $15.10, share is now $16.20, you owe $1.10 more` and `You, marked paid $15.10, share is now $14.00, Hana owes you $1.10 back`; early row `Sam, marked paid $15.10, share is now $16.20` (unchanged).

**Payer's card, ready plan (A1, F5).** `d` = the number of entries with a non-null `difference`. The first match wins:
1. `d > 0` and `owingCount === 0` → state `payer_differences`, label `You owe money back`, no amount, line `1 difference to settle` / `<d> differences to settle` (tone warning, live). This happens when every share fell to ≤ $0 after marks. It can only be back differences, because a "more" difference means the person still owes.
2. `owingCount === 0` → `payer_nobody` (unchanged).
3. `plan.allPaid && d === 0` → `payer_all_paid` (unchanged copy). `lib/settle.ts`'s `allPaid` is unchanged; the view adds `d === 0`.
4. Otherwise → `payer`, with today's paid-of line, plus `<d> difference(s) to settle` (tone warning, live) when `d > 0` and every ower is marked.

**Bill-screen footer (Task 6 lib, Task 8 screen; A1, SE-UX-9).** `SettleFooterAction`'s `settle` variant gains `early?: 'pay' | 'marked'`. All captions are muted regular text with no tone and no icon (SE-VIS-8; today's F-e caption is already plain `Marked paid`). Only exactly `Marked paid` is a live region:

| Server plan, viewer's card | Footer | Caption | a11y hint |
|---|---|---|---|
| early, unmarked owes (`owes` / `owes_opened` / `owes_no_venmo`) | primary "Settle up", `early: 'pay'` | `You can pay now · <n> left to claim` | `You can pay your share now. <n> left to claim` |
| early, viewer marked | secondary "Settle up", `early: 'marked'` | `Marked paid · <n> left to claim` (not live) | today's secondary hint |
| early, anything else (no item claim, nothing/negative, payer); even mode not complete | secondary | `<n> left to claim` (today's) | unchanged |
| ready, `more_due` / `more_opened` | primary "Settle up" | `You owe <Payer> $1.10 more` | `See the difference and settle it` |
| ready, `back_due` | primary "Settle up" | `<Payer> owes you $1.10 back` | `See the difference and settle it` |
| ready, payer with `d > 0` | primary "Settle up" | `1 difference to settle` / `<d> differences to settle` | `See the difference and settle it` |
| everything else | as today | | |

`billFooterAction` keeps `early` footers and rebuilds their `<n>` from the screen's optimistic counts. If those counts reach 0 while the server is still `early`, it shows today's primary "Settle up" with no caption until the refetch. Still no Pay in the footer in early mode, and no difference buttons in the footer (SE-9).

### D7. Home settle markers (contract H; Tasks 4, 7, 9)

**Data (HM-1, option c; A1, F1):** after `listMyBills()` succeeds, Home computes `settleCandidateIds(bills, myId)` (Task 7) and calls `fetchSettleData(ids)` (new, `lib/bills.ts`).
- **Which bills (A1):** only bills that can show a settle pill. Skip bills whose marker without settle data is `new` or `unclaimed`, and bills where the viewer is the payer and `summary.complete` is false (HM-4). At most 20 ids.
- **Four requests** with `.in(...)` over those ids. They reuse the exact column constants `fetchBill` uses (`BILL_COLUMNS`, `ROW_COLUMNS`, `PARTICIPANT_COLUMNS`, `CLAIM_COLUMNS`) and the same parsers, and return `Map<billId, BillData>`.
- **Truncation guard (A1):** PostgREST silently cuts a response at `max_rows` (1000 locally, `supabase/config.toml:19`, checked 2026-11-25; the hosted project has its own setting, so verify it there). Each request ends in `.range(0, 999)`. If any request returns 1,000 rows or more, the whole call fails (`network`), because a cut list would give a wrong "You owe $X".
- **Failures (A1):** if any request fails, the call fails and Home shows no settle pills. Each bill is parsed on its own (try/catch): a bill that doesn't parse is left out of the map and the others keep theirs. The function never throws.
- **(A1.24)** Home builds each bill's plan with `settleViewInputFor(data, myId, Platform.OS, null).plan`, which includes `early` once Task 6 turns on `allowEarly`. `billMarker` reads **that plan's entries** (`lib/settle.ts`: role, mark, `canSettle`, `difference`, `owingCount`, `allPaid`). That's the same plan the Settle screen's cards are built from, so there's **no second rule and no app/DB parity question**. Task 7 doesn't read Task 6's card models, so it depends only on Task 3. Criterion 67 checks in Task 6 that the H rows and the card states agree. A bill missing from the map gets no settle marker (the existing markers still work), never a guessed one.
- **Snapshot (A1):** the four requests are four transactions. A host edit landing between them can mislabel a bill until the next focus. This is accepted and recorded in before-production with upgrade path (d).

Why not (a) a DB count in `my_bills`: "who owes" needs `computeShares` (zero and negative shares from claimable discounts, $0 items, even mode), which would be a second implementation of the split math in SQL. Why not (b) `fetchBill` × 20: up to 80 requests per Home load.

Privacy (HM-6): no new exposure. RLS already lets a participant read every one of these rows (the bill screen reads the same), and Q5 already shows everyone who has paid. Nothing new is written, logged or broadcast.

**Refresh (A1, SE-UX-14; Task 9).** The list shows as soon as `listMyBills` lands. On a later refresh (focus, foreground, pull), each row **keeps its previous settle pill** (the previous map, filtered to the ids still listed) until the new settle data lands. The new map is applied only if its request is still the latest (chained on the existing `latest` token in `app/(app)/index.tsx`). If the new settle read fails, every settle pill is removed (HM-5). `new` and `unclaimed` always follow the latest `my_bills`, and they come first in priority.

**Priority, one marker per row, first match wins** (`billMarker`, HM-3; A1.10):
1. `new` (unchanged; never for the host).
2. `unclaimed` (unchanged: not host, not payer, no claims, not complete).
3. A settle marker, when settle data for the bill is loaded. **The host reaches this step**: `billMarker` no longer returns null for the host before checking settle data. It only skips steps 1–2 for the host. Without settle data, the host still gets null, as today.

`me` = the viewer's entry in the plan. The matching Settle card state is shown for reference only (criterion 67).

| # | Viewer | Condition (A1.24: from the plan) | Card state it matches | Pill | a11y addition | Tone (A1, SE-VIS-1) | `icon` (Q-GLYPH) |
|---|---|---|---|---|---|---|---|
| H1 | owes | plan `ready`, or `early` with `me.canSettle`; `me.role = 'owes'`; no mark | `owes` / `owes_opened` / `owes_no_venmo` | `You owe $15.10` | `You owe $15.10` | accent | null |
| H2 | owes | marked, and plan `early` (any `difference`) or plan `ready` with `difference` null | `marked` | `Paid $15.10` (mark cents) | `Paid $15.10` | muted | `'check'` |
| H3 | owes | plan `ready`, `me.difference.kind = 'more'` | `more_due` / `more_opened` | `Paid · $1.10 more to pay` | `Paid, you owe $1.10 more` | accent | null |
| H4 | owes | plan `ready`, `me.difference.kind = 'back'` | `back_due` | `Paid · $1.10 back to you` | `Paid, Hana owes you $1.10 back` | muted | null |
| H5 | payer | plan `ready`, `owingCount > 0`, someone owing is unmarked | payer card `payer` | `1 person left to pay` / `2 people left to pay` | `1 person still has to pay you` / `2 people still have to pay you` | muted | null |
| H6 | payer | plan `ready`, every ower marked (**including when `owingCount = 0`**, A1.8), `d > 0` | `payer` with the differences line, or `payer_differences` | `1 difference to settle` / `2 differences to settle` | same | accent | null |
| H7 | payer | plan `ready`, `allPaid`, `d = 0`, `owingCount > 0` | `payer_all_paid` | `Settled up` | `Settled up, everyone has paid you` | muted | `'check'` |
| — | anyone | `nothing`, `negative` (unmarked), blocked, `blocked_all_zero`, bad payer, payer in `early`, payer with `owingCount = 0` **and `d = 0`**, an ower in `early` without `canSettle` | | none | — | — | — |

`d` = the number of entries in the plan with a non-null `difference` (the same count the payer card uses, D6).

- `billMarkerView(marker, ctx: { plan, viewerId, nameOf })` returns `{ pill, a11y, tone: 'accent' | 'muted', icon: 'check' | null }`. `new` is accent and `unclaimed` muted, as today (icon null). `MarkerPill` maps `accent` → `primarySurface`/`primary` and `muted` → `surfaceMuted`/`textMuted`. There are no success or warning pills on Home (SE-VIS-1).
- **(A1.22)** Pill text has no glyph. `icon: 'check'` says the pill is a "done" pill. Whether `MarkerPill` draws a lucide `Check` for it, or nothing, is open question **Q-GLYPH**. Until it's answered, Task 9 draws nothing. That's the easiest to reverse: one line in `MarkerPill`, with no lib change.
- The payer gets no marker before the bill is complete, even in early mode (HM-4).
- Colour is never the only signal: every pill has words. If an icon is drawn, it's decorative (`accessible={false}`), and the a11y text is words only.
- Copy plurals are tested at 1 and 2. "You" never appears inside a pill except H1 (the viewer is always the subject).

### D8. Activity (Task 5; C4 additions)

| Kind | Actor | `details` | Sentence (actor not viewer / actor = viewer / other party = viewer) |
|---|---|---|---|
| `paid_difference` | the person | `{ payer_id: uid, from: int ≥ 1, to: int ≥ 2 }`, `to > from` **(A1)** | `Sam paid Hana $1.10 more` / `You paid Hana $1.10 more` / `Sam paid you $1.10 more` |
| `paid_back` | the payer | `{ user_id: uid, from: int ≥ 1, to: int ≥ 0 }`, `to < from` (`to = 0` is the pay-back that cleared the mark) | `Hana paid Sam back $1.10` / `You paid Sam back $1.10` / `Hana paid you back $1.10` |

The amount is `|to − from|`, computed in `lib/activityText.ts` (lib, so allowed). Malformed details (missing ids, non-integers, negatives, `from < 1`, wrong direction, `to = from`) return null.

**(A1)** `unmarked_paid` is unchanged: no 0-cent case exists. **Quote style (A1.16):** Activity sentences keep the code's single quotes (`'I paid'`, `lib/activityText.ts:312,326,328`). The two new sentences contain no quotes. Settle screen copy keeps its double quotes (`Your "I paid" just changed …`), as `SETTLE_COPY` does today.

### D9. Payer changes, honor system, direct API callers
- **Payer change** (`set_payer`) clears every mark. Differences disappear with the marks. The code is unchanged, and the confirm counts are already "every mark". **(A1)** No $0 marks exist, so nothing new is counted.
- **Honor system.** Marks and differences are self-reported (ADR 0015). `settle_difference` records what someone says they paid; it can't check Venmo or the share. A direct API caller can only (a) raise their **own** mark to any value up to 99,999,999 (an accepted caller-only risk, the same as "marks of any amount" today), or (b) as the payer, lower **others'** marks, down to clearing them. That's the payer saying "I paid you back", a self-report about money the payer sent. It's **strictly weaker than `unmark_paid`**, which the payer already has. It's logged in Activity with the actor, and the person sees it on their card. Recorded in `docs/before-production.md` §4 and `docs/learning/catches.md`.
- **Removing / leaving** (rule L3: "has a claim or a mark") is unchanged. **(A1)** A pay-back to $0 clears the mark, so it no longer blocks leaving or removal (SE-13 and SE-UX-16 are moot).

### D10. Privacy, grants, 42501, locks (A1: corrected)
- **No table grant changes and no constraint changes.** `bills` and `bill_participants` keep SELECT only for `authenticated`, and nothing for `anon`. A direct `update bill_participants set settled_cents = …` still fails with `42501`.
- New functions: `private.bill_all_zero` and `private.settle_state` (not executable by `public, anon, authenticated`; `settle_state` is `language sql`, one statement, bigint sums); `public.settle_difference` (execute revoked from `public, anon`, granted to `authenticated`). All are `security definer` with `set search_path = ''` and schema-qualified names.
- **Lock order** for `mark_paid` and `settle_difference` (bills row first; implicit locks listed; checked against `20261121080352_bill_events.sql:31,33` for the FKs):

| # | Lock | Row | Notes |
|---|---|---|---|
| 0 | none | participation read | R4 rule; new for `mark_paid` too (today it takes `FOR SHARE` first; SE-14) |
| 1 | `FOR SHARE` | `bills` | serializes with `set_payer`, `update_bill`, `set_extras_split`, remove/leave (they take `FOR UPDATE` on bills) |
| 2 | none | `line_items`, `claims` (rule E, one `settle_state` call) | `set_claim` takes `FOR KEY SHARE` via `lock_bill_key_share`, which doesn't conflict with `FOR SHARE`, so rule E can be one claim out of date. That's harmless, the same as "Sam unclaimed after paying" (W3) |
| 3 | **`FOR NO KEY UPDATE`** | target `bill_participants` row | explicit in `settle_difference`, implicit in `mark_paid`'s conditional `update` (settled columns aren't key columns). Not `FOR UPDATE`: that conflicts with the `FOR KEY SHARE` every claim takes, so it would queue behind the person's own claim taps. `NO KEY UPDATE` still serializes with `unmark_paid` and `mark_paid` |
| 4 | none extra | the UPDATE of `settled_at` / `settled_cents` | no FK columns change |
| 5 | `FOR KEY SHARE` | `bills` (already held, compatible) via `bill_events.bill_id`; the **caller's `profiles` row** via `bill_events.actor_id` | the profiles lock conflicts only with account deletion (the existing M3 R9 gap, already in `docs/before-production.md`) |
| 6 | none | statement-level broadcast trigger on `bill_participants` → one broadcast | not fired by the idempotent no-op (no UPDATE runs) |

There are no cycles with any existing function. Interactions with `set_payer`, `unmark_paid`, remove/leave and edits are all serialized at `bills` or at the participant row.
- No new side channel: `settle_difference` writes one row others can already read, one event and one broadcast, exactly like `mark_paid` (marks are visible to everyone on the bill, Q5).

## Tasks

**Order (A1, F7, A1.23, A1.24):**
```
START NOW (no visual-pass files touched):
  1 → 2                       (DB, supabase-engineer)
  3 ‖ 4 ‖ 5                   (lib; start together, alongside 1 → 2)
  7 after 3                   (lib/homeMarkers.ts; reads lib/settle.ts plans only)
  10a after 1, 2, 3, 4        (live parity + case-id drift test); gate for 8 and 9
GATE V: the visual-pass session (splitit-app-52) reports V6–V13 done
  6 after 3, 4, 7 + gate V    (two passes: 6a, 6b; re-read lib/settleView.ts first)
  8 after 6, 10a + gate V  ‖  9 after 4, 6, 7, 10a + gate V   (re-read every A1.23 file first)
  10b after 2, 5, 6, 7        (view, markers, Activity, live)
  11 last (after everything)
```
Task 7 was checked for a dependency on Task 6 (A1.24). As first written it read Task 6's card states, so it would have had to wait. It now reads only the plan entries Task 3 produces, so it runs before Task 6. Task 6 then adds criterion 67 (markers and cards agree), which is why 6 comes after 7.
If criterion 17c (Task 3) finds a move > 1¢ from other people's actions, it goes to the user before Task 6 builds on D1.

**Planned breakage (A1, F6; lessons 2026-11-24):**
- **Task 3 (A1.24)** doesn't add `'early'` to the existing `SettlePlan` union. It adds `SettleEarly` and `SettlePlanWithEarly = SettlePlan | SettleEarly`, plus `settlePlan` overloads: without options (or `allowEarly` false) the return type is `SettlePlan`; with `{ allowEarly: true }` it's `SettlePlanWithEarly`. `lib/settleView.ts` calls it without options until Task 6, so its exhaustive switch (`case 'blocked_all_zero'` at `lib/settleView.ts:328` is the only one in `app components lib`; Grep tool 2026-11-25) still compiles, and **Task 3 doesn't touch `lib/settleView.ts`**, which the visual pass is editing. Task 6 switches the view to `SettlePlanWithEarly` and handles `'early'`.
- **Task 2** doesn't touch `supabase/tests/database/settle_payer.test.sql`. Its `settled_cents = 0 fails with 23514` check (lines 85–88) keeps passing, because the constraint is unchanged (A1.1).
- **Task 4** doesn't flip `lib/bills.test.ts:552`, and **Task 5** doesn't flip `lib/activityText.test.ts:681`: marks stay ≥ 1.
- **Task 6** makes `settleViewInputFor` pass `allowEarly`, so incomplete proportional fixtures in `__tests__/settle.test.tsx` and `__tests__/billScreen.test.tsx` (and any other router test that renders Settle or the bill footer) become early plans. Task 6 runs those files and updates assertions that change only through copy or plan state, listing each one in its report. Assertions that need new handlers stay for Task 8. `__tests__/settle.test.tsx:835-861` (the share-changed card) needs the new handlers, so it's rewritten by Task 8 and fails until then ("expected until Task 8").
- **Task 1** edits only the K6 block of `settle_marks.test.sql`.

Files another session may be editing (re-check with the main session before starting): `lib/receiptText.ts`, `lib/scanPipeline/**`, `app/(app)/scan.tsx`, and **the visual pass's files (A1.23)**: `components/ui/**` (including `Button.tsx`), `components/Avatars.tsx`, `components/SettleCard.tsx`, `components/SettleFooter.tsx`, `components/SettlePeopleList.tsx`, `components/PayerPicker.tsx`, `app/(app)/bills/[id]/settle.tsx`, `app/(app)/bills/[id]/index.tsx` and `lib/settleView.ts`. None of Tasks 1–5, 7 or 10a touches them.

### Task 1: rules E and Z, `mark_paid` early (agent: supabase-engineer)
Files: `supabase/migrations/<assigned>_settle_early.sql` (new), `supabase/tests/database/settle_early.test.sql` (new), `supabase/tests/database/settle_marks.test.sql` (edit the K6 block at lines 463–474 only).
- `private.bill_all_zero(uuid)` and `private.settle_state(uuid, uuid)` per D2. **(A1)** `settle_state` is one `language sql` statement with bigint sums. `create or replace function public.mark_paid(...)` per D3, calling `settle_state` once.
- Tests E1–E20, each description starting with its `[E#]` tag.
- Header comment: the lock order per D10 with each implicit lock, which columns clients can't read (none changed), and the K6 closure.
- K6 test: the `ok(bill_is_complete…)` stays; the `lives_ok(mark_paid…)` becomes `throws_ok(…, '22023', 'all_zero', …)`, and the "mark is stored" assertion becomes "no mark stored".
- Apply with `npx supabase migration up` (never `db reset` without asking). About 120 lines of SQL and 230 of pgTAP.

### Task 2: `settle_difference`, event kinds (agent: supabase-engineer)
Files: `supabase/migrations/<assigned>_settle_difference.sql` (new), `supabase/tests/database/settle_difference.test.sql` (new).
- **(A1)** No change to `bill_participants_settled_cents_range` or `bill_participants_mark_complete`.
- Replace `bill_events_kind_known` with **the most recent list on disk** (read every migration that redefines it; at least `20261124091041_people.sql`) plus `paid_difference` and `paid_back`.
- `public.settle_difference` per D4: **(A1)** `FOR NO KEY UPDATE`, the idempotent step 9, clearing at 0. Header: lock order (D10), event details.
- Tests D1–D20, each tagged `[D#]`.
- About 140 lines of SQL and 280 of pgTAP.

### Task 3: rules E/Z, early plan, differences (agent: implementer)
Files: `lib/settle.ts`, `lib/settle.test.ts` (A1.24: not `lib/settleView.ts`).
- Export `allZero`, `maySettle` (D2), `SETTLE_DIFF_IGNORE_CENTS = 1` (starting value), `SettleDifference`, `SettleEarly`, `SettlePlanWithEarly`, and `settlePlan(input, payerId, marks, opts?: { allowEarly?: boolean })` with the overloads under planned breakage. Statuses follow **D2's with/without table (A1, F4)**. Without `allowEarly` (the default), behaviour is today's: every existing `lib/settle.test.ts` assertion passes unchanged.
- With `allowEarly`: entries carry `canSettle`.
- `difference` per D4, on marked non-payers in `ready` **and** `early` plans (A1.5). No `pending` field. `markDiffers`/`markDiffCents` unchanged.
- Test titles for E and D rows start with `[E#]` / `[D#]` (E1–E20, D1–D7).
- About 260 lines with tests.

### Task 4: data layer (agent: implementer)
Files: `lib/bills.ts`, `lib/bills.test.ts`, `test-utils/fakes.ts` (only if needed).
- **(A1)** Mark parsing is unchanged (marks stay 1..99,999,999). Don't loosen `isSettleCents`.
- `settleDifference(billId, userId, payerId, expectedCents, newCents)` → `rpc('settle_difference', { p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_new_cents })`. **(A1)** Local refusal (no rpc, `invalid_bill`) when `expectedCents` isn't an integer in 1..99,999,999, `newCents` isn't an integer in 0..99,999,999, or they're equal.
- `BillError` gains `'mark_changed'` (copy in `BILL_ERROR_COPY`: `Your "I paid" just changed. Check the amount and try again.`). For `22023` messages, `mark_changed` → `mark_changed` and `all_zero` → `invalid_bill`; others are unchanged.
- `fetchSettleData(billIds: readonly string[])` per D7, **(A1)** with `.range(0, 999)` on each request, a request returning 1,000 or more rows treated as failure (`network`), and per-bill parsing. Empty list → no request. More than 20 ids → refuses (`invalid_bill`), no request. Every read names its columns through the existing constants.
- About 230 lines with tests.

### Task 5: Activity sentences (agent: implementer)
Files: `lib/activityText.ts`, `lib/activityText.test.ts`. D8, with the quote style unchanged. About 70 lines.

### Task 6: settle view models (agent: implementer; two passes, sequential, same files; **starts after gate V**, A1.23)
Files: `lib/settleView.ts`, `lib/settleView.test.ts`, plus the copy/state-only screen assertions listed under planned breakage (`__tests__/settle.test.tsx`, `__tests__/billScreen.test.tsx`).
- First, re-read `lib/settleView.ts` and its tests as the visual pass left them. Keep its copy and the glyph rule: every new string is glyph-free and carries a tone (A1.22).
- Switch the view to `SettlePlanWithEarly` (A1.24) and add the `'early'` branches.
- Add criterion 67's consistency test (imports `billMarker` from Task 7).
- **6a, cards, footer, prompt, notices** (about 280 lines): `settleViewInputFor` passes `{ allowEarly: true }`. Early cards, difference cards (D6), `variant: 'secondary'` on the back-due Request, `actionError` additions, **contract O** (`OpenedVenmo` with `kind`/`fromCents`, `openedStillMatches`, recording from opened values), `noticeSnapshot` and the `noticeFor` rule, `addVenmoPrompt` on early plans, footer captions and `early: 'pay' | 'marked'` (D6 footer), `billFooterAction`. New `SettleAction` kinds: `{ kind: 'pay_difference'; url; payerId; cents; fromCents; toCents }`, `{ kind: 'mark_difference'; userId; payerId; fromCents; toCents }`, `{ kind: 'request'; url }` (opens, never writes), `{ kind: 'pay_back'; url }` (opens, never writes). Rewrite the share-changed expectations at `lib/settleView.test.ts:187-205`, `:401`, `:409`, `:666-669`, `:974` (listed by grep) to the D6 states; the `withoutGlyph` test at `:569` is unchanged.
- **6b, rows and payer card** (about 220 lines): early and ready rows, status tones incl. `warning`, sub-line tone `muted` on ready rows (`warning` on early rows), `wideStatus`, the list web line, Undo rule with the host-payer exception, row a11y labels, the payer card's order (F5), `d` counts.

### Task 7: Home settle markers (agent: implementer; after Task 3 only, A1.24)
Files: `lib/homeMarkers.ts`, `lib/homeMarkers.test.ts`.
- `billMarker(summary, myId, plan?: SettlePlanWithEarly | null)`: D7 priority and the D7 plan conditions, with **(A1)** the host passing through to step 3. It doesn't import `settleCard` or any Task 6 model. Tests build plans with `settlePlan(..., { allowEarly: true })`. `BillMarker` gains `'owes' | 'paid' | 'paid_more' | 'paid_back_due' | 'left_to_pay' | 'differences' | 'settled'`. A new `billMarkerView(marker, ctx: { plan, viewerId, nameOf })` returns `{ pill, a11y, tone: 'accent' | 'muted', icon: 'check' | null }` (amounts and counts filled here through `formatCents`; strings glyph-free). The existing `BILL_MARKER_COPY` for `new` / `unclaimed` is unchanged. `addedNotice` / `stillDismissed` keep calling `billMarker` without settle data, so they behave as today.
- **(A1)** `settleCandidateIds(bills: readonly BillSummary[], myId: string): string[]` per D7.
- `billRowA11yLabel` gains the optional plan argument (and `nameOf`).
- About 220 lines with tests.

### Task 8: Settle screen and bill footer (agent: product-engineer, loading `ui-ux-designer`; one design pass; **starts after gate V**, A1.23)
Files: `app/(app)/bills/[id]/settle.tsx`, `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `components/SettleFooter.tsx`, `app/(app)/bills/[id]/index.tsx` (only if `SettleFooter` needs a prop), `__tests__/settle.test.tsx`, `__tests__/billScreen.test.tsx`.
- First, re-read every one of those files as the visual pass left them. Draw status icons from `tone` through the visual pass's components (`StatusLine` / `Banner`), never from a glyph in a string (A1.22). Don't edit `components/ui/**`, `components/Avatars.tsx` or `components/PayerPicker.tsx`.
- Render the D6 models. Handlers: `pay_difference`, `request` and `pay_back` call `openPaymentLink(url)` first, with no `await` before it, behind a 1 s repeat-tap guard (one guard for card links, one for list links). `mark_difference` calls `settleDifference` with the action's values. It stays loading until the refetch that includes it has finished, landed or failed (the existing `finished` rule). Record buttons ignore taps while in flight (one rpc).
- **(A1)** `SettleCard` renders the block button as `Button variant="secondary"` when `variant: 'secondary'`. `SettlePeopleList`: status `warning` tone; `wideStatus` → status column `width: 120` (a local constant with a comment), else `minWidth: 64`; status and control buttons `marginLeft: 'auto'`; `I paid it back` and the host-payer's Undo each on their own line, `alignSelf: 'flex-end'`; a polite caption slot for `Marked paid back` (SE-UX-12); the list web line.
- **(A1)** Build the notice snapshot with `noticeSnapshot(input)`. `pickerDecision`'s `complete` is `ready || early`. iOS announcements `Difference marked paid` / `Marked paid back`.
- Update `__tests__/settle.test.tsx:835-861` to D6.
- About 300 lines.

### Task 9: Home rows (agent: product-engineer, loading `ui-ux-designer`; **starts after gate V**, A1.23)
Files: `app/(app)/index.tsx`, `__tests__/homeMarkers.test.tsx`. **(A1.23)** Not `components/ui/Button.tsx` or `components/Avatars.tsx`: the visual pass builds SE-VIS-10 and SE-VIS-9.
- First, re-read `app/(app)/index.tsx` and any pill/row component the visual pass changed.
- After `listMyBills` succeeds, call `fetchSettleData(settleCandidateIds(bills, myId))` on the same triggers (load, focus, pull-to-refresh as today). For each bill, build the plan with `settleViewInputFor(data, myId, Platform.OS, null).plan`. Rows render `billMarkerView`. **(A1, SE-UX-14)** Keep the previous settle map (filtered to listed ids) until the new one lands. Apply it only if it's still the `latest` request. On failure, clear the settle map, with no error banner (the list itself loaded).
- **(A1, SE-VIS-1)** `MarkerPill` takes a `tone` and maps `accent` / `muted` to the D7 colours. **Q-GLYPH:** draw nothing for `icon` until the user answers (A1.22).
- About 150 lines.

### Task 10a: live parity and case-id drift (agent: implementer, `live-db-smoke` skill; after 1, 2, 3, 4; gate for 8 and 9)
One repo file: `lib/settleCaseIds.test.ts` (new; criterion 62). Everything else is throwaway: local users A (host/payer), B, D, and C as the outsider. Keys stay in the process environment only (`set -a; eval "$(npx supabase status -o env)"; set +a; node …`). Runs criteria 50–56 and 62.

### Task 10b: live view, markers, Activity (agent: implementer, `live-db-smoke` skill; after 2, 5, 6, 7)
No repo files. Same throwaway setup. Runs criteria 57–58.

### Task 11: docs (agent: docs-writer; after Tasks 1–10b; works through every bullet and reports each done/skipped)
- `docs/learning/decisions/0015-settling-one-payer-self-reported-marks.md`: dated note (early settling in proportional mode; `settled_cents` is the net amount and a pay-back to $0 clears the mark; `settle_difference` with the token and idempotent retry; K6 closed). Or a new ADR "Settling early and paying differences" if the main session reserves a number on disk.
- `docs/learning/concepts/money-and-rounding.md`: why proportional early shares are stable (D1, W1–W9; the cumulative 1¢ bound), the 1¢ tolerance.
- `docs/learning/concepts/database-functions.md`: the stale-state token `p_expected_cents`, what it can't detect, idempotent retries, `FOR NO KEY UPDATE` vs `FOR UPDATE`, and why `settle_state` is one SQL statement (snapshots under READ COMMITTED).
- `docs/learning/concepts/row-level-security.md` ("The app is not the only client"): remove K6 from the caller-only list; add D9's two direct-caller cases.
- `docs/learning/catches.md` §1 and §3: same.
- `docs/learning/concepts/in-app-notices.md`: Home settle markers, their data source (HM-1), the truncation guard and the keep-previous-pills refresh.
- `docs/before-production.md`: items below.
- `docs/decisions-to-review.md`: mark M3-UX-7, VR-5, M3-6/M3-R-1 (K6) as superseded by SE-*; update SE/HM/SE-UX/SE-ENG statuses if anything changed during the build.
- `docs/specs/2026-11-24-m3-settle-venmo.md`: one dated line under "Recorded earlier: settling is never allowed while any item is unclaimed" and under C1's K6 row: "Changed 2026-11-25 by docs/specs/2026-11-25-settle-early-and-differences.md". No other edits.

## Acceptance criteria
DB checks: `npm run db:test`. Jest: `npm test -- --maxWorkers=4` or `npx jest <file>`. Types: `npm run typecheck`. Criteria tagged **(A1)** were changed or added by Amendment A1. Numbers are stable: removed criteria say so, and new ones are appended (59+).

### Database, Task 1 (`settle_early.test.sql`, `settle_marks.test.sql`)
1. **(A1)** Each row E1–E20 gives the listed `private.settle_state` value and the listed `mark_paid` result, each set up through the real functions and tagged `[E#]`. Accepted rows store `settled_cents` exactly and write one `marked_paid` event; refused rows write nothing.
2. E13: after the switch to even, Sam's earlier mark is still stored (same `settled_at`, cents), and a second `mark_paid` raises `22023 not_complete`.
3. Check order (pins the app mapping): a caller who is the payer **and** sends `p_cents = 0` gets `invalid_amount`; a non-payer on an all-$0 incomplete bill (E9) gets `all_zero`, not `not_complete`; a non-participant gets `42501` before any amount check.
4. `private.bill_all_zero` and `private.settle_state` are not executable by `public`, `anon` or `authenticated` (calling as `authenticated` fails with `42501`). `mark_paid` is still `security definer`, `search_path=""`, executable by `authenticated` only.
5. K6 is closed: the updated K6 block in `settle_marks.test.sql` expects `22023 all_zero` and no stored mark. Every other existing test in `settle_marks.test.sql` passes unchanged.
6. A non-participant calling `mark_paid` takes no lock on the bill: the test checks statically that the function body runs the participation read before `for share` (same method as `people_review_fixes.test.sql`).

### Database, Task 2 (`settle_difference.test.sql`)
7. **(A1)** Each row D1–D20 gives the listed result, tagged `[D#]`. Successful writing rows write exactly one event of the listed kind with `{from, to}` and the listed ids, actor = caller. The idempotent rows D18/D19 write no event and change nothing. Failed rows change nothing and write nothing.
8. **(A1)** `settled_at` is unchanged by a raise or by a partial pay-back. A pay-back to 0 sets `settled_at` and `settled_cents` both to null. The `bill_participants` constraints are unchanged: the existing `settle_payer.test.sql:85-88` check (`settled_cents = 0` fails with `23514`) passes unchanged, and `mark_paid(…, 0)` still raises `22023 invalid_amount`.
9. **(A1)** After D3, Sam's row has no mark, so `set_payer` on that bill with one other mark needs `p_expected_cleared = 1` and succeeds. After D3, `unmark_paid` on Sam behaves as it does today for an unmarked person (test asserts today's result, whatever it is, read from `settle_marks.test.sql`).
10. **(A1)** Check order pins: a wrong-direction caller with an invalid amount gets `invalid_amount`; a wrong-direction caller with valid amounts on an incomplete bill gets `42501` (step 5 before 6–7); a stale token on an incomplete bill gets `not_complete` (7 before 10); the idempotent check runs after steps 0–7 (D20) and before the token compare (D18).
11. The kind constraint accepts `paid_difference`, `paid_back` and every kind accepted before this migration (the test lists them from the latest earlier definition), and rejects `'paid_more'`.
12. Grants: `settle_difference` is `security definer`, `proconfig = {search_path=""}`, executable by `authenticated` only. As B, `update public.bill_participants set settled_cents = 1 where user_id = B` still fails with `42501`. `table_privs_are` for `bills` and `bill_participants` / `authenticated` are still `['SELECT']`, and empty for `anon`.
13. **(A1)** One writing `settle_difference` sends exactly one broadcast on `bill:<id>` (the method of `bill_edit_realtime.test.sql`); the idempotent retry (D18) sends none.
14. **(A1)** Lock order is stated in the migration header with each implicit lock (D10 table). The test checks statically that the participation read precedes `for share`, which precedes `for no key update` on the participant row, and that the body contains no `for update` that isn't `for no key update`. `private.settle_state` has `prolang` = `sql`. A bill whose item rows sum above 2,147,483,647 (rows inserted as superuser) gives `settle_state` without an overflow error (verify that the table constraints allow such a bill; if they don't, the test asserts statically that the sums are `bigint` and that there's no `::integer`/`::int` cast in the body, and says so).
15. Every pgTAP file passes, old and new (`npm run db:test`). Assertions are scoped to fixture bills (no whole-table counts).

### `lib/settle.ts` (Task 3)
16. **(A1)** `maySettle` returns the E1–E20 column exactly (same fixtures as criterion 1, expressed as `SplitInput`s and tagged `[E#]`; E13/E14 as the state after the switch / as the payer, where `is_payer` is the view's concern and `maySettle` returns `early`).
17. **(A1)** Property test, seeded, 500 random bills in both modes, complete and incomplete, with discounts and $0 items:
   (a) on complete bills `allZero(input) === (computeShares(input).unclaimedCents !== 0)`;
   (b) `settlePlan` without options: `status` is never `'early'`; it's `blocked` exactly when `!sharesComplete` (all-zero incomplete bills included), and on complete bills `blocked_all_zero` exactly when `allZero`;
   (c) with `allowEarly`, for every early plan and every participant P with `canSettle`: run a seeded random sequence (up to 12 steps) of **other** participants' actions on rows P didn't claim (claim or unclaim an item row, `set_item_split` on a shared row, a new participant joining and claiming) until the bill is complete. P's `owedCents` at the end differs from P's `owedCents` at the start by **at most 1¢ in total**, and by exactly 0 when P's item subtotal is 0.
18. **(A1)** `settlePlan(..., { allowEarly: true })`: proportional K2 with the viewer holding a claim → `early` with `unclaimedRows: 1`; even K2 → `blocked`; E8 (complete) → `blocked_all_zero` with and without options; E9 (incomplete) → `blocked_all_zero` with `allowEarly` and `blocked` without; K1 → `ready` (identical to without options).
19. **(A1)** `difference` per D1–D6 exactly (`kind`, `cents`, `fromCents`, `toCents`; D3/D4 `toCents` 0, D4 `cents` 1510); within tolerance (`±1`) → null; unmarked (D7, D9) → null; the payer → null. In an **early** plan the same marks give the same `difference` (e.g. mark 1510, share 1620 → `more 110`). There's no `pending` field.
20. With `SETTLE_DIFF_IGNORE_CENTS` treated as 0 through a test seam, D5 (1510 vs 1511) gives `more 1`. (Shows the tolerance is the only reason it's hidden.)

### Data layer (Task 4)
21. **(A1)** `settleDifference('<bill>', B, A, 1510, 1620)` calls `rpc('settle_difference', { p_bill_id, p_user_id: B, p_payer_id: A, p_expected_cents: 1510, p_new_cents: 1620 })`. Amount refusals (no rpc, `invalid_bill`): `(…, 1510, 1510)`, `(…, 0, 500)`, `(…, -1, 5)`, `(…, 5, 100000000)`, `(…, 100000000, 5)`, `(…, 1.5, 5)`, `(…, 5, -1)`. `(…, 1510, 0)` and `(…, 1510, 1620)` are sent.
22. Error mapping, one test each: `22023 mark_changed` → `mark_changed`; `22023 all_zero` → `invalid_bill`; existing mappings unchanged. No server text returned.
23. **(A1)** Mark parsing is unchanged: a participant row with `settled_cents = 0` and a non-null `settled_at` still gives `network` (the DB never stores it), as do `-1` and `settled_cents` without `settled_at`. `lib/bills.test.ts:552` passes unchanged.
24. **(A1)** `fetchSettleData([a, b])` makes exactly four Supabase reads. Each uses `.in('id' | 'bill_id', [a, b])` with the `fetchBill` column constants (the test asserts the select strings equal `fetchBill`'s) and `.range(0, 999)`. It returns the same `BillData` per bill as `fetchBill` on the same fake rows, comparing claims as sets. `[]` makes no request; 21 ids return `invalid_bill` with no request. A read returning 1,000 rows → `{ ok: false, error: 'network' }`. Any read failing → `ok: false`. A bill whose participant row fails to parse is missing from the map while the other bill is present. Nothing throws (a test feeds a malformed row that would make the parser throw).

### Activity (Task 5)
25. **(A1)** Each D8 sentence, for each of the three viewpoints (the actor is another person; actor = viewer → "You …"; other party = viewer → "… you …"), with exact strings. `paid_back` with `from 1510, to 0` reads `Hana paid Sam back $15.10`. Malformed details (missing id, `to = from`, `paid_difference` with `to < from` or `from < 1`, `paid_back` with `to > from` or `from < 1`, non-integers, negatives) return null. The existing `unmarked_paid` sentences and their single quotes are unchanged (`lib/activityText.test.ts` passes without edits to existing assertions).

### Settle view (Task 6, `lib/settleView.test.ts`)
26. **(A1)** Early cards (D6 table) on the worked example (Hana pays; Burger A, Salad B, Fries shared; plus one unclaimed Dessert, proportional): Sam unmarked sees `You owe Hana` and the amount **(the exact early amount is whatever `computeShares` gives on that fixture; the test computes it once with `settlePlan` and asserts the strings built from it)**, the Pay button with the same URL the ready card would build for that amount, and `Your share may change until everything is claimed (1 item left).` Sam with no claims: `Claim what you had on the bill, then come back to pay.` Payer: `Waiting for everyone to claim`, `1 item left to claim`, and `1 paid so far` when Sam is marked (no `paid so far` line at 0). Marked early with no difference: `If your share changes, you'll settle the difference here once everything is claimed.` `addVenmoPrompt`: early, payer without Venmo, Sam can settle → the prompt; early with nobody able to settle → null; ready → unchanged.
27. **(A1)** Early marked with a difference: more → `Your share is now $16.20. You'll pay the $1.10 difference once everything is claimed.`; back → `Your share is now $14.00. Hana will owe you $1.10 back once everything is claimed.`; share −100 on a 1510 mark → `Your share is now -$1.00. Hana will owe you $15.10 back once everything is claimed.` Each line has tone `muted`. No `pay_difference`, `mark_difference`, `request` or `pay_back` action anywhere in early models (card, rows, footer).
28. **(A1)** Ready `more_due`: label `You owe Hana more`, amount 110, line `Your share is now $16.20. You've marked $15.10 paid.`, primary label `Pay Hana $1.10 more on Venmo` with `url === venmoPayUrl({ username: 'hana-1', cents: 110, itemNames: viewerItemNames })`, notes `@hana-1 · $1.10`, secondaries `I paid the difference` (action `mark_difference`, `fromCents 1510`, `toCents 1620`) and `Undo "I paid"` (a11y `Undo your I paid`, hint `Clears your whole I paid of $15.10`). `more_opened` after `openedVenmo = { kind: 'more', payerId: A, cents: 110, fromCents: 1510 }`. A refetch where the share moved to 1700 but the mark is still 1510 → still `more_opened` at `$1.10`, recording `1510 → 1620` (contract O). A refetch where the mark is now 1620, or the payer changed, or the plan is no longer `ready` → not `more_opened`.
29. **(A1)** Ready `back_due`: label `Hana owes you`, amount 110, block button `Request $1.10 from Hana on Venmo` with `variant: 'secondary'`, `url === venmoRequestUrl({ username: 'hana-1', cents: 110, itemNames: viewerItemNames })` and a11y `Request $1.10 from Hana on Venmo, @hana-1`; no `mark_difference` action on Sam's card; secondary `Undo "I paid"`. Payer without Venmo: the line includes `Ask Hana to pay you back.` and there's no request action. Share −100: extra line `Hana also owes you $1.00 for your share. Settle that outside the app.` After D3/D4 (mark cleared): Sam's card is 3.6 `You're all set` (share 0) or the 3.7 negative card (share −100), with no Undo and no paid-back line.
30. **(A1)** Rows, payer (not host) viewing: more due → status `Owes $1.10 more` (muted), sub-line `Marked $15.10 · share now $16.20` (tone `muted`), request link label `Request $1.10`, a11y `Request $1.10 more from Sam on Venmo, @sam-1`, url `venmoRequestUrl({ username: 'sam-1', cents: 110, itemNames: itemNamesOf(B) })`, no Undo. Back due → status `You owe $1.10 back` (tone `warning`), `Pay $1.10 back` with url `venmoPayUrl({ username: 'sam-1', cents: 110, itemNames: itemNamesOf(B) })`, `I paid it back` (action `mark_difference`, userId B, `fromCents 1510`, `toCents 1400`), no Undo. The D3 row gives `toCents 0` and the hint `Clears Sam's I paid`. **Host-payer** viewing the same rows: the same controls **plus** Undo. Host-not-payer: statuses (`Hana owes $1.10 back` for back due), Undo, and **no** difference actions. Other owers: statuses, no actions. Own row: `You owe $1.10 more` / `Hana owes you $1.10 back`. Every row's `a11yLabel` per D6. `wideStatus` is true with any difference row and false without. The list web line is the pay-or-request line when a `pay_back` link exists. No row status reads `Paid back` (there's no such state).
31. **(A1)** Payer card: all owers marked, one with a difference → `payer` with line `1 difference to settle` (tone `warning`), not `payer_all_paid`; two → `2 differences to settle`; differences within tolerance → `payer_all_paid`. Every share ≤ 0 with one back difference (`owingCount` 0) → `payer_differences`, label `You owe money back`, line `1 difference to settle` (warning), never `payer_nobody`. `owingCount` 0 and no differences → `payer_nobody`.
32. Copy edge cases: each sentence above tested with the payer as "You" where it can occur (host-as-payer viewing a row: no "You owes"; a non-payer viewing a row where the payer is the viewer can't happen and isn't modelled), and counts 1 and 2.
33. **(A1)** `actionError('mark_changed')` → `{ text: 'Your "I paid" just changed. Check the amount and try again.', refetch: true }`; `actionError('not_complete')` → `{ text: 'Something on the bill just changed. Check your share and try again.', refetch: true }`.
34. **(A1)** Footer, each D6 footer row: early + Sam unmarked owes → `{ kind: 'settle', variant: 'primary', caption: 'You can pay now · 1 item left to claim', early: 'pay' }`; early + Sam marked → secondary, `Marked paid · 1 item left to claim`, `early: 'marked'`; `billFooterAction` with on-screen `unclaimedRows: 2` keeps each early footer's variant and kind with `2 items left to claim`, and with on-screen 0 gives primary "Settle up" with no caption; early + Sam with no claims → today's secondary footer; ready `more_due` → primary, `You owe Hana $1.10 more`; `back_due` → primary, `Hana owes you $1.10 back`; payer with 1 and 2 differences → `1 difference to settle` / `2 differences to settle`. Ready footers without differences are unchanged (every existing `settleFooterAction`/`billFooterAction` test passes).

### Home markers (Task 7, `lib/homeMarkers.test.ts`)
35. **(A1)** H1–H7 each on a fixture built with `settlePlan(..., { allowEarly: true })`, with exact `pill`, `a11y`, `tone` (H1 accent, H2 muted, H3 accent, H4 muted, H5 muted, H6 accent, H7 muted) and `icon` (`'check'` on H2 and H7 only); H5 and H6 at counts 1 and 2. No `pill` or `a11y` contains `✓` or `⚠`. "Settled up" never appears while any ower is unmarked or any difference remains. A payer with `owingCount` 0 and one back difference → H6, accent.
36. **(A1)** Priority: a bill that is `new` and where the viewer owes shows `new`; `unclaimed` beats settle markers; the **host who is the payer** gets H5–H7 (with settle data) and null without settle data; the host who owes gets H1–H4; the host never gets `new`/`unclaimed`; no plan (`undefined`/`null`) → today's result exactly (every existing `lib/homeMarkers.test.ts` assertion passes unchanged). `lib/homeMarkers.ts` imports nothing from `lib/settleView.ts` except existing helpers that Task 6 doesn't change (A1.24; checked by reading the import list).
37. **(A1)** Early: an ower who paid early → H2 `Paid $15.10`, including when their `difference` isn't null; an ower in early who hasn't paid and can settle → H1; an ower in early with only a discount claim → none; the payer in early → no marker; a blocked even-mode bill → no settle marker; `blocked_all_zero` → none; `nothing`/`negative` → none.

### Screens (Tasks 8 and 9; router tests, native and `Platform.OS = 'web'` each)
38. **(A1)** Settle screen, early (proportional, 1 item unclaimed, Sam claimed): Pay opens `openPaymentLink` synchronously with the card's URL; "I paid" calls `markPaid`; the may-change line is visible; the payer sees `Waiting for everyone to claim` and no `Request` button (`queryAllByText(/^Request/)` empty); a payer without Venmo sees the "Add your Venmo" card.
39. **(A1)** `more_due`: Pay opens synchronously with the difference URL; the card switches to `Did you pay Hana $1.10?`; `I paid the difference` makes exactly one `rpc('settle_difference', { …, p_expected_cents: 1510, p_new_cents: 1620 })`, even when tapped twice; while it's in flight the button is disabled and nothing shows as settled; after the refetch with 1620 the card is `marked` (`Marked paid` with a success tone, `$16.20`). A refetch that moves the share (mark unchanged) while the prompt is open keeps the prompt, and the rpc still sends `1510 → 1620`. `mark_changed` shows its copy, refetches and re-enables. A failed refetch re-enables.
40. **(A1)** `back_due` as Sam: the outlined Request button opens synchronously and makes **no** rpc or table write. As Hana (payer, not host): `Pay $1.10 back` opens synchronously, no write; `I paid it back` sends `p_user_id: B, p_expected_cents: 1510, p_new_cents: 1400`; after the refetch the row shows `Paid` (success tone) with Undo back and no difference controls. As Hana on a share-0 row: `p_new_cents: 0`; after the refetch Sam's row has no mark and no controls.
41. Two taps within 1 s on any open-link control open once.
42. **(A1)** A refetch where the payer changed while `more_opened` drops the prompt and shows the existing payer-changed notice; no control records a difference to the old payer. The old payer tapping `I paid it back` after a switch gets the `payer_changed` copy and a refetch.
43. **(A1)** Bill footer: early + Sam owes → primary `Settle up` with `You can pay now · 1 item left to claim`, opening `/bills/<id>/settle`; early + Sam marked → secondary with `Marked paid · 1 item left to claim`; ready `more_due` → primary with `You owe Hana $1.10 more`; every existing `__tests__/billScreen.test.tsx` footer test passes (or is listed as updated by Task 6 under planned breakage).
44. **(A1)** Home: with settle data, each row shows its D7 pill in its tone's colours (accent → `primarySurface`/`primary`, muted → `surfaceMuted`/`textMuted`). With `fetchSettleData` failing, rows show today's markers and no error. `fetchSettleData` is called with `settleCandidateIds(...)`, never with `new`/`unclaimed`/payer-incomplete bills. **Refresh:** on a focus refresh with a deferred `fetchSettleData`, rows keep their previous settle pills until it resolves, then show the new ones; if it rejects, the settle pills disappear; a response from an older request (a newer one started) is ignored. The row's single `accessibilityLabel` includes the marker's a11y text (words only), and the pill keeps its words in every tone. Until Q-GLYPH is answered, no icon is drawn in a pill (a test renders an H2 pill and finds no icon element).
45. Accessibility: every new button has `accessibilityLabel` and `accessibilityHint` per D6; errors are `Banner alert`; the design pass is recorded in the report.
46. Components do no money math: `grep -rnE "markDiffCents|owedCents|collectCents|fromCents|toCents|SETTLE_DIFF_IGNORE_CENTS" components app` prints nothing. (A1: the same pattern was run 2026-11-25 with the Grep tool over `components/` and `app/`: no matches today.) Handler code passes action objects through without reading their fields for arithmetic; field names on actions are read by lib only.
47. The difference RPC has one caller: `grep -rn "settle_difference" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/bills.ts`. (Run 2026-11-25 over `app`, `components`, `lib`: no matches today.)
48. Venmo URLs are still built in one place: `grep -rn "venmo\.com" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/paylinks.ts` (request spec criterion 5's command; Grep tool 2026-11-25: `lib/paylinks.ts`, plus the test files `lib/paylinks.test.ts` and `lib/settleView.test.ts`, which the command excludes).

### Whole slice
49. `npm run typecheck`, `npm test -- --maxWorkers=4` and `npm run db:test` pass (failures only in files this slice didn't touch are reported per the parallel-work rule). **(A1)** Typecheck is green after every task (Task 3's `settlePlan` overloads, A1.24).

### Live reconciliation (Tasks 10a and 10b; the same state checked on both sides)
Task 10a (after 1, 2, 3, 4):
50. **(A1)** Every row E1–E20 built live: `maySettle` over `fetchBill` data and `markPaid` through `lib/bills.ts` agree (early/final → ok; not_complete → `not_complete`; all_zero → `invalid_bill` from `22023 all_zero`). Plus 20 seeded random proportional bills (a mix of complete and incomplete, with discounts and $0 items) where the same two must agree for each participant.
51. Early mark, then D claims the rest: B's `settlePlan` difference is null or within 1¢ (W7), and B's card is `marked`.
52. D joins B's Fries after B paid early, then completes: B's `difference` is `back`; Hana's `settleDifference(bill, B, A, from, to)` stores `to`; B's next `fetchBill` shows the mark at `to` and `difference` null.
53. **(A1)** The host raises the tip after completion: B's `difference` is `more`; B's `settleDifference` stores the target and writes one `paid_difference` event; **a second identical call returns ok, and the bill still has exactly one such event** (idempotent retry).
54. **(A1)** Direction rules live: B lowering his own mark and D (non-payer) calling either direction return `not_allowed` (42501). Payer change, then B's `settleDifference` with the old payer id → `payer_changed`. Hana unmarks B, then B's `settleDifference` → `mark_changed`.
55. A raw `from('bill_participants').update({ settled_cents: 1 })` as A returns `42501`; a raw `rpc('settle_difference', { … p_new_cents: 100000000 })` returns `22023`.
56. **(A1)** Pay-back to 0 live (D3): afterwards `fetchBill` shows B with **no mark**, the view's card for B is 3.6/3.7, and `set_payer` needs `expectedCleared` counting only the other marks. If B then unclaims everything, `leave_bill` as B succeeds (L3 no longer blocked by the mark).
Task 10b (after 2, 5, 6, 7):
57. **(A1)** `fetchSettleData` for A's candidate bills returns, for each bill, the same `BillData` as `fetchBill` (deep equal, with claims compared as sets). `billMarker` gives H5 for A on a bill with one unpaid ower, and H7 after that ower marks. As C (outsider), `fetchSettleData([thatBill])` returns no data for it (RLS: 0 rows) and no marker. **Truncation:** a fixture whose claims for the requested ids reach 1,000 rows (e.g. a bill with 500 rows claimed by A and B; reword if the row cap differs) makes `fetchSettleData` return `ok: false`, and Home's markers would show no settle pill.
58. Activity live: after 52 and 53 (and 56), `fetchActivity` sentences read `Hana paid Sam back $X` and `Sam paid Hana $Y more` from D's viewpoint, and the You/you forms (`You paid Sam back $X`, `Sam paid you $Y more`) from A's. (*Amended 2026-11-25, Task 10b: wording fix; A is Hana, so D8 gives the You forms there. Behaviour unchanged.*)

### Added by Amendment A1
59. **(A1) Contract O, `'share'`** (Task 6): with `openedVenmo = { payerId: A, cents: 1510 }` (kind absent), a refetch where Sam's share moved to 1620 (ready) keeps `owes_opened` at `$15.10`, and its "I paid" action is `mark` with `cents: 1510`. The same holds in an early plan where Sam can settle. The prompt is dropped when the payer changes, when Sam is marked, when the plan becomes `blocked`, and in `early` when Sam's `canSettle` is false. The bill footer's `did_you_pay` follows the same rule.
60. **(A1) Notices** (Task 6): `noticeFor` with `prev.myMark` true, `next.myMark` false, not by me: `next.myShareCents` 0 → null; −100 → null; 500 → `Your "I paid" was undone. Check Activity to see who.`; null (blocked) → the undone banner (unchanged). `noticeSnapshot` returns `myShareCents` from the viewer's entry in a ready/early plan, and null otherwise.
61. **(A1) Picker** (Task 8, router test): on an early bill with no marks, the host picking another payer gets the confirm `Switch to <name>? People may already be paying you.` (or the payer's name when the host isn't the payer).
62. **(A1) Case-id drift** (Task 10a, `lib/settleCaseIds.test.ts`): reads `supabase/tests/database/settle_early.test.sql`, `supabase/tests/database/settle_difference.test.sql`, `lib/settle.test.ts` and `lib/bills.test.ts` from disk and extracts tags with `/\[(E|D)(\d+)\]/g`. It asserts: the E set is identical in `settle_early.test.sql` and `lib/settle.test.ts` (E1–E20); D1–D7 appear in both `lib/settle.test.ts` and `settle_difference.test.sql`; D1–D20 all appear in `settle_difference.test.sql`; every D tag in the lib tests exists in the SQL file. Its set comparison is unit-tested on an inline string with one id missing (the test must fail that case). The `[E#]`/`[D#]` tag pattern matches no file under `lib/` or `supabase/tests/` today (Grep tool, 2026-11-25).
63. **(A1) Candidate ids** (Task 7): `settleCandidateIds` excludes a `new` bill, an `unclaimed` bill, and a bill where the viewer is the payer and `complete` is false. It includes a complete bill where the host is the payer, an incomplete bill where the viewer owes, and keeps list order.
64. **(A1) Visual model fields** (Tasks 6 and 7): `billMarkerView`'s `tone` is only ever `'accent'` or `'muted'` (a type-level union plus a test over every marker, Task 7); `SettleButton.variant` is set only on the back-due Request; `SettlePeopleModel.wideStatus` is set as criterion 30 says (Task 6).
65. *(Removed by A1.23: the Button label wrap and Avatar ring are built and tested by the visual pass, V6–V13.)*
66. **(A1.22) Glyph rule** (Tasks 6 and 7): no string in any model returned by `lib/settleView.ts` or `lib/homeMarkers.ts` contains `✓` or `⚠`. A test walks every card, row, footer, notice and marker fixture in `lib/settleView.test.ts` / `lib/homeMarkers.test.ts` and checks each text field against `/[✓⚠]/u`. As a source check, `grep -rnE "[✓⚠]" lib/settleView.ts lib/homeMarkers.ts` prints nothing (Grep tool 2026-11-25: `lib/` non-test files have no matches today; the only match under `lib/` is `lib/settleView.test.ts`). Status lines and row statuses carry `tone` (`success` / `warning` / `muted`). In the screens (Tasks 8 and 9), icons come from tone only, and each row's or card's a11y label has words only.
67. **(A1.24) Markers agree with cards** (Task 6, `lib/settleView.test.ts`): for every card fixture of criteria 26–31 that has a non-payer viewer, `billMarker(summary, viewerId, input.plan)` is H1 exactly when `settleCard(input)` is `owes` / `owes_no_venmo` (with `openedVenmo` null), H2 when `marked`, H3 when `more_due`, H4 when `back_due`, and null for every other card state. For payer fixtures: H5 ⇔ `payer` without the differences line and with someone unmarked, H6 ⇔ the differences line or `payer_differences`, H7 ⇔ `payer_all_paid`.

### User checks (need a person)
- **U1 (iPhone, no backend).** QA prints `venmoPayUrl({ username, cents: 1, itemNames: ['Salad', 'Fries'] })` and `venmoRequestUrl` with the same input (the links a difference uses: same builder, the difference amount), using the user's own Venmo username (ask; don't read `.env*`). The user opens each from Notes and checks: Pay screen / Request screen, `$0.01`, note `SplitIt: Salad, Fries`. **Don't press Pay or Request.** The `txn=charge` form was verified on iPhone on 2026-11-25 (request spec). Venmo's own docs don't describe either form (ADR 0007), so Android and desktop stay **unverified**; repeat on Android if available.
- **U2 (web, two accounts, local Supabase): early pay.** A creates a proportional bill with 3 items; B joins and claims one. B opens Settle up and sees the amount, the "may change" line and Pay. Pay opens a new tab at the pay URL; "I paid" makes A's Settle page show B `Paid` (with its check icon) within a few seconds. B's bill footer reads `Marked paid · N left to claim`. A's Home row has no settle marker until the bill is complete (HM-4); B's Home row reads `Paid $X`. A claims the rest: A's Home shows `Settled up`, and B's Home shows `Paid $X`. Going back to Home several times, the pills don't blink off and on.
- **U3 (web, two accounts): differences.** On the complete bill, A raises the tip. B's footer reads `You owe A $X more`; B sees `You owe A more`, taps Pay (a tab opens with the difference), then `I paid the difference`; both screens and Home return to settled. A then lowers the tip: A's row shows `You owe $X back` with `Pay $X back` and `I paid it back`; B's card shows the outlined `Request $X from A`. A records it; B sees `Marked paid` with its check icon. Activity shows both sentences. Judge clutter.
- **U4 (VoiceOver, iOS simulator).** Hear the `more_due` card and a back-due row in reading order, with the button hints.
- **U5 (A1, visual; web and iOS simulator, light and dark).** At 375 pt and at the largest text size: a long `Pay <long name> $1.10 more on Venmo` label wraps inside the button (this relies on the visual pass's Button fix); with a difference row, the Everyone list's money column stays aligned and the statuses wrap inside their column; Home's pills use only teal and grey; status icons (check / warning) appear beside the words, never inside them. (The avatar ring is the visual pass's to check.)
- **Physical-phone in-app check: blocked.** On the phone `127.0.0.1` is the phone itself, so this check waits for the hosted deploy or the Mac's LAN IP plus matching Supabase/Google redirect URLs. U1 covers the Venmo side.

## Before-production items (Task 11)
- **§4 Honor system / direct callers:** `settle_difference` lets a person raise their own net mark to any amount, and lets the payer lower others' marks down to clearing them ("paid back"). Both are self-reported and logged, and the second is weaker than `unmark_paid`. Remove K6 from the caller-only list (closed).
- **§4 Idempotent retry (A1):** two devices raising the same mark to the same value record once, so a real duplicate payment isn't flagged.
- **§4 Hidden undo notice (A1):** when a payer uses Undo (instead of "I paid it back") on a mark whose share is now ≤ $0, the person sees no notice. Activity still shows `… undid …'s 'I paid'`. Revisit if people miss pay-backs.
- **§4 Rate limits:** add `settle_difference` to the existing rate-limit item (Activity/Realtime flooding).
- **§5 Venmo links:** difference links reuse the pay/request formats; Android and desktop are still unverified.
- **§6 Home data:** Home now reads the candidate bills' rows and claims on each load (4 requests, ≤ 20 bills). **(A1)** The four reads aren't one snapshot (a host edit between them can mislabel a bill until the next focus). The truncation guard relies on `max_rows`; check the hosted project's value. Upgrade path: one definer RPC returning raw rows as jsonb (one snapshot, no truncation). Revisit if Home gets slow or the 20-bill cap grows.
- **§6 Tolerance:** differences of 1¢ are never prompted (SE-11), so a payer can end up 1¢ short or over per person.

## Risks / open questions
- **Money: needs your look (built as the easiest-to-reverse option, per the delegation rule).**
  - **SE-1, the Q1 change:** proportional bills open settling per person once they've claimed an item. To reverse: `settleViewInputFor` stops passing `allowEarly`, and `mark_paid` goes back to `complete` (a one-line SQL change).
  - **SE-3, K6 closed:** the DB now refuses marks on all-$0 proportional bills, matching the app. This removes an exception you were asked to approve.
  - **SE-11, 1¢ tolerance:** one constant.
  - **SE-12, pay-back stops at $0:** a negative remainder stays "settle outside the app".
  - **SE-2 as amended by SE-ENG-1:** `settled_cents` is the net amount (1..), and a pay-back to $0 clears the mark. The result: no "Paid back" status (Activity has the history), and paid-back people can leave. Low risk while the app is pre-launch.
  - **SE-ENG-3, idempotent retry:** a retry never shows an error for a write that worked, but a true duplicate from two devices records once.
- **SE-ENG-2 (hidden undo notice when the share is ≤ $0)** is the PM's pick between the engineer's two options. The other one, "Hana paid you back." (success tone), reads nicer but is false when the payer used Undo. A neutral line such as `Your "I paid" was cleared. Check Activity to see who.` is a third option if you'd rather always show something.
- **New copy written by the PM under A1:** `You owe money back` (payer card when only pay-backs remain), the hint `Clears Sam's I paid`, `Pay it back in the Venmo app`. Easy to change.
- **Early marks can surprise people when the host switches to "Split evenly"** (W5): the bill goes back to blocked, marks stay, and "Your I paid is saved" shows. Intended.
- **More rounding cents than W7 suggests?** The widened property test (criterion 17c) is the check. If it finds a move > 1¢ from other people's actions, it goes to the user before Task 6 builds on D1.
- **Q-GLYPH (for the user; doesn't block the build): a check on the "done" Home pills?** The visual design (SE-VIS-2) put `✓` as a text glyph inside `Paid $15.10` and `Settled up`, and the glyph rule (A1.22) removes glyphs from strings. The options: **Answered 2026-11-25 by the user: no check icon on Home pills (agrees with the PM). `MarkerPill` ignores `icon`; the words carry it.**
  - **(a) Draw a lucide `Check` from `icon: 'check'`.** Keeps the "done" cue. But the visual doc found the 16-pt icon too big for a 13-pt pill, and there's no smaller size token, so this needs a new icon size or a visual-pass decision.
  - **(b) Drop it on pills (recommended).** "Paid" and "Settled up" already say done, the pills are muted (SE-VIS-1), and it adds nothing to the pill system.
  Either way the lib returns `icon`, so the answer changes one line in `MarkerPill`. Task 9 builds (b) until you answer.
- **Gate V timing:** Tasks 6, 8 and 9 wait for the visual pass to report V6–V13 done (A1.23). If that slips, the DB, lib and Home-marker work (1–5, 7, 10a) can still finish. Only the screens wait.
- Nothing blocks the build.

## Note (2026-11-25, Task 11 docs)
- **ADR:** no number had been reserved on disk, so Task 11 chose a new ADR over a dated note on 0015, because this slice changes three things 0015 decided (when settling may start, the K6 exception, what a mark stores). It took the next free number, **0021** (`docs/learning/decisions/0021-settling-early-and-paying-differences.md`, checked against the folder and `decisions/README.md` the same day). ADR 0015 carries pointer notes.
- **Before-production:** this spec's "§4 / §5 / §6" labels don't match `docs/before-production.md`'s sections (its §6 is "Privacy and legal"). The items went where they fit: honor system, idempotent retry, hidden undo notice, tolerance and rate limits in §4; Venmo links in §5; "Home data" merged into the existing `max_rows` item at the end of §6 (with review R7's note), not duplicated.
