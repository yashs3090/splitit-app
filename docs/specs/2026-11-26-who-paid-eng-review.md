# Engineering review: Who paid (Task 0)

Date: 2026-11-26. Read-only staff-engineer review of `docs/specs/2026-11-26-who-paid.md`, written by the Plan agent and saved by the main session (the reviewer had no write access). Checked against `CLAUDE.md`, WP-1…WP-25, `lib/settle.ts`, `lib/settleView.ts`, `lib/bills.ts`, `lib/membership.ts`, all settle migrations, 92's `20261126080844_sent_via_venmo.sql`, Groups `20261126082511_groups.sql`, `docs/specs/2026-11-26-sent-via-venmo-eng.md`, `docs/specs/2026-11-26-groups-mvp.md`.

> **Note (main session, 2026-11-26):** after this review was written, the user changed the money model to a **payments ledger** (recorded payments are kept as real money movements, never cleared; remaining transfers are the fewest payments from each person's position; routes only change when the bill changes). Items about which marks a payer change *clears* (B2, contract K, S10) and about one-payer-per-person stickiness (S3, S4, T12/T13) must be re-read against that model when the spec is amended.

**Bottom line.** The design is sound (payer_id as lead, `bill_payers` only when split, per-pair marks, capacity greedy) and all ten worked examples are correct in amounts. Seven blocking items must be folded in before Task 4a.

## Blocking

**B1. D3/D9 are stale against 92's migration on disk.** `20261126080844_sent_via_venmo.sql` adds `settled_method`, `not_received_cents`, `not_received_method`, `not_received_by` (no `not_received_at`). `mark_paid` returns `table (settled_at timestamptz, created boolean)`. `mark_not_received` is `(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at)`. `unmark_paid` is still `(p_bill_id, p_user_id)`.
*Change:* use the real signatures; in `bill_marks` replace `not_received_at` with `not_received_method text` plus 92's `private.is_payment_method` check; D9 `MARK_COLUMNS = 'from_user, to_user, settled_at, settled_cents, settled_method, not_received_cents, not_received_method'`; 4a drops `unmark_paid(uuid, uuid)` and creates `unmark_paid(uuid, uuid, uuid)` with the same grants, then `notify pgrst, 'reload schema'`. Remove "pending 92's final contract"; close R1.

**B2. Contract K contradicts 92 on not-received flags.** 92's `set_payer` and reset trigger clear every flag (SV-ENG-14, reverses SV-25); K says flag-only rows stay, which would fail 92's pgTAP and criterion 5.
*Change (D2):* "Deleted = every `bill_marks` row with `to_user ∉ S′`. Cleared (counted) = those with `settled_at is not null`. Flag-only rows to a still-payer are kept." K7 accordingly; D8 item 7 follows the same rule. *(Re-check under the ledger model.)*

**B3. Account deletion trigger order.** Postgres fires AFTER ROW triggers in name order; FK cascade triggers (`RI_ConstraintTrigger_a_<oid>`) sort before `bill_participants_reset_payer`, so the `bill_marks` cascade runs first and the AFTER trigger can't count them.
*Change (D8 item 7, WP-16, R3):* make `private.bill_participants_reset_payer` a **BEFORE DELETE** row trigger returning `old`. Early-return if the bill is gone, `old.user_id` is the host, or not a payer. Otherwise: lock `bills` FOR UPDATE; count settled `bill_marks` on the bill where `to_user <> host or from_user = old.user_id`; delete those rows (marks and flags) and rows from `old.user_id`; delete all `bill_payers` for the bill; set `payer_id = host`; log `payers_changed` / `payer_changed` with `actor_id` null. pgTAP: two-payer bill, delete co-payer B as owner, count equals the hand count including B's own outgoing mark. Drop the "Verify" bullet.

**B4. `bill_payers` blocks host account deletion.** Only FK is `(bill_id, user_id) → bill_participants` NO ACTION deferred; the bill cascade leaves `bill_payers` rows and the deferred check fails with 23503.
*Change (D1):* add `bill_id uuid not null references public.bills (id) on delete cascade`. New criterion 18b: deleting a host who owns a split bill succeeds and leaves no `bill_payers`/`bill_marks` rows.

**B5. Groups ordering is already decided** (Groups spec line 661: group bills keep one payer, GR-M5; who-paid refuses split paying on group bills and ports T5's mark triggers and attach's mark→payment conversion onto `bill_marks`). GR-10's trigger fires on `bill_participants.settled_at/settled_cents`; dropping those columns breaks it.
*Change:* X3/R2 → "Decided: ours after Groups T5 and T7." 4a: (a) drop GR-10's BEFORE UPDATE trigger before dropping columns; (b) re-create it as BEFORE INSERT OR UPDATE on `bill_marks` (`settled_at is not null` on a group bill → `22023 in_group`); (c) re-create `attach_bill_to_group` converting settled `bill_marks` rows to `group_payments` (`'bill_mark'` source) and deleting the bill's pair rows; (d) edit Groups' `group_bills.test.sql` (criteria 26, 27, 91). 4b: (e) `set_payers` refuses group bills (`22023 in_group`, step 1b after the bill lock); (f) `attach_bill_to_group` refuses bills with `bill_payers` (`22023 split_paying`); (g) the event-kind list starts from the latest on disk (incl. T5 `moved_to_group`, `removed_from_group`, T7 `assigned`, `unassigned`).

**B6. Criterion 1 (the data move) can't be pgTAP** (`db reset` applies all migrations before tests).
*Change:* the migration self-checks (raise if a flag's `not_received_by` isn't a participant, or a mark has `user_id = payer_id`; insert mark rows and flag rows, merging on shared pairs; raise unless inserted = marked + flagged). Plus a scratch migration test: `supabase db reset --version <ts before 4a>` (confirm the flag exists in the installed CLI), seed, `npx supabase migration up`, assert. Report before/after counts on local data. Resetting wipes local data, so ask the user first.

**B7. Lib mirror of the leave rule (L3) is missing.** `lib/membership.ts` `removable()` reads `participant.mark` and `bill.payer_id`; it won't type-check after Task 5, and a naive patch would show Remove/Leave for a co-payer the database refuses.
*Change:* add `lib/membership.ts`, `lib/membership.test.ts` (and `lib/peopleView.ts` if needed) to Task 5, with shared boundary table L used by pgTAP (criterion 17) and Jest: L1 co-payer; L2 non-payer with an outgoing mark; L3 non-payer with only a flag (can leave); L4 lead after `set_payer` to someone else, no claims/marks; L5 host.

## Should

- **S1. Regression fixture too weak.** Own step right after X1-lib merges and before Task 5, record the git SHA; commit inputs and outputs; capture `settlePlan`, `settleCard`, `settlePeople`, `settleFooterAction`, `billMarker`; one adapter `legacyMarksToPairs`; coverage counts (≥30 each of blocked, blocked_all_zero, early, payer_owes_them, difference.more, difference.back, within-tolerance, flag present); compare with `toStrictEqual`. DB side: criterion 2 edits setup/readback lines only, never expected values; 4a lists each edited line.
- **S2. Contract O's baseline doesn't exist** (`viewerBalance` only in 96's spec). Criterion 25: on one-person fixtures `balanceFor` equals what today's `rowAmount`/`billMarker` show, or 96's `viewerBalance` if landed by Task 6.
- **S3. Stickiness should cover payer→payer marks and flags** (step 2a: "a mark, or failing that a flag"; new step 5a for marked payer pairs). *(Re-check under the ledger model.)*
- **S4.** "A non-payer has at most one transfer" is false; use "at most one transfer with `cents > 0`" plus "every marked pair appears exactly once". *(Ledger model allows paying two people.)*
- **S5. Worked examples:** amounts correct, but T1, T4, T6, T7 not in output order (`pay` before `outside`, then `fromId`, then `toId`); fixtures compare ordered arrays. Add T11 (all payers, negative payer share: total 1000, paid A 600 B 400, shares A 1100 B −100 → A→B 500), T12 (sticky person whose share went negative), T13 (payer-pair mark, direction reverses).
- **S6. `bill_marks` lifecycle:** `check (settled_at is not null or not_received_cents is not null)` and `check (settled_at is null or not_received_cents is null)`; per-function upsert/delete rules (mark_paid `on conflict … do update … where settled_at is null returning`; unmark/settle back to 0 delete; mark_not_received converts mark→flag).
- **S7. Index** `bill_marks_bill_to_idx on public.bill_marks (bill_id, to_user)`.
- **S8. Same stale rule both sides:** criterion 12 adds ±1¢ edits; `settlePlan` checks `blocked_payers` before `blocked_all_zero` (DB order); total under 2¢ opens Fix on One person.
- **S9. Table W:** W8 must fit `bills_total_cents_range` (0..99,999,999) → "A 99999998, B 1 on a 99,999,999 bill → ok"; add W14 (DB only) `paid_cents` `6000.0`/`6e3` → `invalid_amount` via `private.jsonb_int_between`; close R6.
- **S10. K token is a count only (ABA risk).** Use a sorted jsonb array of `(from_user, to_user, settled_at)` or record as an accepted risk. *(Re-check under the ledger model.)*
- **S11.** Dropping the columns breaks other sessions' shared local DB: Task 5 green against fakes before 4a is applied; apply 4a and merge Task 5 in one sitting, announced to 92, Groups and 96 first.
- **S12. 4a is undersized** (~600+ lines): split into 4a-1 (table, checks, index, RLS/grants, realtime, copy + self-check) and 4a-2 (function re-creates, Groups ports, column drop), one `migration up`. 4b copies from 4a's bodies.
- **S13. Rollback notes** in each migration header (4a reversible; 4b lossy: collapse split bills to lead). Before-production: snapshot the hosted DB before the push.
- **S14. Audit `payer_id` readers** (`lib/membership.ts`, `activityText.ts`, `bills.ts`, `homeMarkers.ts`, `settle.ts`, `settleView.ts`, `sentCheck.ts`, `groups*.ts`, `app/(app)/bills/[id]/index.tsx`, `settle.tsx`): Task 5 lists each as unchanged / split branch / refused on group bills; add 92's `lib/useVenmoSend.ts` `unmarkPaid` call to Task 10.
- **S15.** X5/WP-25 resolved: 92's `my_bills()` adds only `seen_at`; this slice never touches `my_bills()`.
- **S16. `unmark_paid` in split mode:** allowed for the host, `p_user_id`, or `p_payer_id` when `p_payer_id ∈ bill_payer_ids`; no pair row → no-op.
- **S17. Deadlock class grows** (account deletion locks participant then bill; `set_payers`/`mark_paid` lock bill then key-share participants): note it in the lock-order note and link the before-production item.

## Nits

N1 header says WP-1…WP-24 but the table runs to WP-25. N2 ADR 0023 stub exists; drop "no stub yet". N3 clarify session names (96 owns both Home v2 and who-paid). N4 `payerLine` already exists in `lib/settleView.ts:869`; rename the new one `paidByLine` or delete the old one in Task 7. N5 there's no Task 3; renumber or note it was dropped. N6 policies use `for select to authenticated using (private.is_bill_participant(bill_id))`; add `notify pgrst, 'reload schema'` to 4a and 4b. N7 sticky tie-break compares `settled_at` as the microsecond string, not `Date.parse`, then `to_user`. N8 `settlePlan` runs stale/complete checks before contract T so its `RangeError` is unreachable from screens. N9 D11's stale bill-line cell quotes D6 exactly. N10 `set_payers` step 2 catches a bad uuid cast as `invalid_payers` and finds duplicates after the cast. N11 T9's title is misleading.

## Worked examples, recomputed

| # | Result | Matches spec? |
|---|---|---|
| T1 | C→A 3340; A→B 681 | amounts yes, order no |
| T2 | C→A (tie to A), D→B | yes |
| T3 | B→A 1510; outside A→C 100 | yes |
| T4 | C→A 4100; A→B 1000; outside A→D 100 | amounts yes, order no |
| T5 | A→B 2000, A→E 1000 | yes |
| T6 | D sticky → B; C→A; B→A 100; D difference more 100 | amounts yes, order no |
| T7 | D→A (tie), C→B, A→B 100 | amounts yes (PM's fix correct), order no |
| T8 | lead A (tie); C→A 5000 | yes |
| T9 | C sticky → B; D → A | yes |
| T10 | C→A 1; all 0 | yes |

Also confirmed: Σ r = 0 (shares add up to the total); integer ranges safe; at most n−1 transfers; one payer reduces exactly to today's plan; a 2¢ split bill works.

## Lib/database parity

| Rule | Both sides tested? |
|---|---|
| W (paid amounts add up) | yes, except W8/W14 (S9) |
| K (which marks a change clears) | yes once B2 is fixed *(re-check under ledger model)* |
| E′ (no early settling when split) | yes |
| Stale | DB only at +300 (S8) |
| L3 (leave rule) | DB only (B7) |
| Lead tie | yes |

## Cross-session order (recommended)

1. 92, `20261126080844` (as is).
2. Groups T2–T7 (own `my_bills()` with `group_id is null`, `attach_bill_to_group`, GR-10 triggers, the kind list).
3. Ours: 4a-1, 4a-2 (port GR-10 and attach onto `bill_marks`), then 4b (`in_group` and `split_paying` refusals).

Timestamps are assigned when each migration is applied, in apply order; `supabase migration up` won't apply an older file without `--include-all`. Fallback: if Groups T5 isn't written when 4a is ready, 4a goes first and Groups T5 targets `bill_marks` directly (needs a dated Groups spec amendment).

## Task graph (corrected)

```
1 ‖ 2                                  (day one)
X1-lib merged → 6.0 fixture capture (S1), before 5
Groups T5/T7 applied → 4a-1 + 4a-2 → 4b         (B5, S12)
5 (+ membership, L table; ready before 4a is applied, S11) → 6 → 7 ‖ 8
4a data-migration test script (B6), rollback notes in headers (S13)
11 after 5;  9 → 10 after X1-ui + 7 + 11;  12 last
```
