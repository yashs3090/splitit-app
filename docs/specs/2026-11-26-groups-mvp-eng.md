# Groups MVP: staff-engineer review (T0)

Date: 2026-11-26 · Reviews `docs/specs/2026-11-26-groups-mvp.md` against the plan (incl. "User decisions (2026-11-26)"), GR-1…GR-30 / GR-A1…A9, CLAUDE.md, the lessons (money-math, rls, process), `lib/split.ts`, `lib/settle.ts`, `lib/billView.ts`, `lib/bills.ts`, and every migration through `20261125090051_settle_difference.sql`; checks against the in-flight Sent via Venmo spec (`2026-11-26-sent-via-venmo.md`, D8), `2026-11-26-home-groups-v2.md` and reserved ADR 0023 (several payers). Saved by the main session (the review agent was read-only).

Ranking: **B** = blocking (fix before T2 starts), **S** = should-fix (fold into Amendment A1), **N** = nit.

Summary: 4 blocking, 15 should-fix, 9 nits. Blocking: migration order vs Sent via Venmo is undecided; three lock-order gaps (one deadlock, one broken invariant); T5 writes a bill Activity kind it doesn't add; criteria 27–28 can't pass as written. Money: W1–W5 recomputed by hand and correct. Real money gaps: a receipt that stops being fully claimed after payments swings every balance; hiding every 1¢ suggestion can leave one person several cents short while told "settled up"; retries after a lost response get false conflicts from `assign_item`/`edit_expense` and an error from `attach_bill_to_group`; account deletion can still quietly change group balances despite GR-26.

## What holds up
- **Worked example verified by hand.** Dinner shares (3008/2749/1976 via proportional allocation of 1733 over 2334/2133/1533), Brunch (1001 → 251/250/250/250), W1–W5 nets and greedy suggestions in order, W4's tip change (3125/2856/2052). Every row sums to 0.
- **C-G1's two reasons cover every case.** `validate_bill_rows` requires an item row, so a complete bill with `unclaimedCents ≠ 0` is exactly the all-$0 case (rule Z). No third waiting reason.
- **Balances sum to $0** if every counted bill's shares sum to its total (true when `unclaimedCents = 0`), every expense's shares sum to its amount, and payments are two-sided. See S6 for the parser check this needs.
- `auth.uid()` as actor in `log_claim_event` still works inside a security-definer `assign_item` (it reads the request JWT, not `current_user`).
- No existing claim-writing path wrongly logs `assigned` under the new rule: `update_bill` (cascaded claim deletes hit "line item not found"), `remove_participant`/`leave_bill` (participant row already gone), account deletion (null `auth.uid()`).
- `group_snapshot` returns one scalar `jsonb`; PostgREST `max_rows` doesn't apply to a scalar function result, so criterion 37's truncation worry is moot. Keep the check.
- Triggers on `bill_participants` (GR-10) are right: they don't depend on which `mark_paid`/`settle_difference` signature exists.

## Blocking

### B1. Order against Sent via Venmo's migration
SV D8 adds `bill_participants.settled_method` and three `not_received_*` columns with a check tying method to the mark, re-creates `my_bills()` with `seen_at`, and SV Task 1 greps every migration for `settled_cents = null` and re-creates each statement it finds.
- SV first + T5 clearing only `settled_at`/`settled_cents` → `attach_bill_to_group` fails 23514 on any marked bill.
- T5 first → SV's grep finds `attach_bill_to_group` and SV must re-create a Groups function.
- Both re-create `my_bills()`; whoever lands second without re-reading drops the `group_id is null` filter or `seen_at` (`create or replace` can't change returned columns, so it's drop + recreate).
- A stale `not_received_*` on a moved bill would show "Hana hasn't received your $15.10" on a bill that can't settle on its own.

**Fix:** SV lands first (already agreed with splitit-app-92: `20261126080844_sent_via_venmo.sql`; every Groups migration after it). Add "SV migration merged" to T5's Waits for. `attach` clears every mark column on the latest schema (`settled_at`, `settled_cents`, `settled_method`, the three `not_received_*`). T5 re-creates `my_bills()` from SV's version, keeping `seen_at` and adding the group filter. Add `my_bills` and the mark columns to the shared-files table.

### B2. Lock order: three gaps
The T2 header rule (group row first, then bills ascending, then participants, then claims) is right but ignores implicit FK locks on `group_members` and `groups`.

**(a) Deadlock: `leave_group` vs `edit_expense`/`add_expense`/`record_payment`.** `edit_expense` inserts `expense_shares` (FK → FOR KEY SHARE on member X's `group_members` row), then inserts `group_events` (FK → FOR KEY SHARE on the group row). Meanwhile `leave_group` (by X) holds the group row FOR UPDATE, its history check can't see the uncommitted share, and it tries to DELETE X's `group_members` row. Each waits for the other → 40P01. Same with `record_payment` (FKs on from/to/recorded_by).
**Fix:** membership-changing functions (`join_group`, `leave_group`, `attach_bill_to_group`, `detach_bill_from_group`) take the group row **FOR NO KEY UPDATE** (conflicts with itself, not with FOR KEY SHARE). Money writes take no explicit group lock. `leave_group` catches 23503 from its `group_members` delete and re-raises `22023 cannot_leave`. Note in the header: `rotate_group_code` changes a unique column, so it implicitly locks the group row FOR UPDATE and waits for FK inserts (no cycle).

**(b) Broken invariant: `join_group` vs `attach_bill_to_group`.** attach reads members (new member not there yet) → join_group commits, adding the member to the bills it can see (not the attaching one) → attach commits. The member is in the group but not on that bill. **Fix:** both lock the group row (NO KEY UPDATE) before reading members or bills; add a pgTAP check that after attach every member is a participant.

**(c) Functions called with a bill id.** `attach(p_bill_id, p_group_id)` / `detach(p_bill_id)` would naturally lock bill-first, while join/leave go group-first → deadlock. **Fix:** `detach` reads `bills.group_id` unlocked, locks the group, locks the bill FOR UPDATE, re-checks `group_id`. `attach` locks group then bill. Bills are locked **FOR UPDATE** so `mark_paid`/`settle_difference` (FOR SHARE) can't land a mark between reading and clearing marks.

**(d) `leave_group` order.** Take the group lock, then lock **all G's bills FOR UPDATE ascending**, then check history, delete `group_members`, delete participant rows. Deleting participant rows before locking bills reverses `bill_participants_reset_payer`'s order (it takes the bill FOR UPDATE after the row delete) — the R9 shape. With S8's optional FK `bills(group_id, payer_id) → group_members`, `set_payer` (bill FOR UPDATE then FOR KEY SHARE on `group_members`) would deadlock against a `leave_group` that deleted membership before locking bills.

Criterion 34 lists all four paths and uses (a) as the worked example in the header.

### B3. Criteria 27–28 can't pass as written
On a group bill: `settle_difference` raises `22023 mark_changed` (step 10) for `p_new_cents ≥ 1` and returns success as a no-op for 0 (step 9) — attach cleared every mark, so the trigger is never reached. `mark_paid` raises `not_complete`/`all_zero` before its UPDATE on an incomplete bill; it reaches the trigger only on a complete bill. `unmark_paid` is a no-op.
**Fix:** reword criterion 27: no call ever leaves a mark on a group bill; each raises one of {`in_group`, `mark_changed`, `not_complete`, `all_zero`} or is a no-op with no participant row changed (backdate `settled_at` first). `mark_paid` on a *complete* group bill raises `in_group`. Also test the trigger directly with a postgres-role UPDATE.

### B4. T5 writes a bill Activity kind that T7 adds
T5's attach/detach log `moved_to_group`/`removed_from_group`, but T7 widens `bill_events_kind_known` → T5's criterion 26 fails 23514.
**Fix:** T5 widens with `moved_to_group`, `removed_from_group`; T7 adds `assigned`, `unassigned`. Three sessions widen this list (Groups, SV `not_received`, ADR 0023 several payers). Add a pgTAP assertion (in `group_bills.test.sql`, re-run by T7) that inserts a row of **every** kind used anywhere (bill_created … paid_back, `not_received` if present, the four new ones), so the list is pinned by a test.

## Should-fix

### S1. A receipt that stops being fully claimed after payments; moving in a bill with marks
Unclaiming, `assign_item(row, {}, …)` or the host adding an item makes a counted receipt incomplete; it drops out of every balance at once. In W1 with all suggestions recorded, Cy unclaiming the nachos removes Ana's 7733 paid and every Dinner share; new suggestions tell people who paid to get money back. Balances still sum to 0, so nothing flags it. Same at move-in: moving in an incomplete bill with marks turns marks into payments while the bill doesn't count.
**Fix:** (a) while anything is waiting, Settle shows a notice above the suggestions ("Balances don't include Hana's receipt yet: 2 items left to claim"), from the view model. (b) `attach_bill_to_group` refuses a bill that has marks and isn't complete or is all-$0 (`22023 not_complete`, "Finish claiming before moving it in"), using `private.bill_is_complete` / `private.bill_all_zero` — a deliberate DB check, not C-G1. (c) Add W7 to T1: W1 with all suggestions recorded, then Dinner becomes incomplete; assert nets (Σ = 0), the `waiting` entry and the notice. Log under GR-1 as **Money: needs your look** (alternative: keep counting a bill's last complete state — needs stored snapshots; not MVP).

### S2. `GROUP_IGNORE_CENTS` can leave more than 1¢; status line disagrees with Settle
Greedy can pair one debtor with several +1¢ creditors (Ben −3 vs three +1 → three hidden 1¢ payments; Ben told "settled up" owing 3¢; up to n−1 cents). Status line uses the net, Settle uses shown suggestions, criterion 51 a third rule.
**Fix:** hide a payment only if it is ≤ threshold **and** both people's |net| ≤ `GROUP_IGNORE_CENTS`; C-G3's leftover bound becomes "each person's leftover ≤ `GROUP_IGNORE_CENTS`". One predicate `isSettledUp(net) = |net| ≤ GROUP_IGNORE_CENTS` used by status line, Settle and criterion 51. Update criterion 6: in {Ana +1, Ben +1, Cy −2}, Cy's |net| is 2, so both 1¢ payments show.

### S3. Retries that look like conflicts
- `assign_item`: retry after a lost response with the same `p_parts` and old `p_expected` fails `claims_changed`. Check "current == p_parts → no-op success" before the stale-token check.
- `edit_expense`: retry fails `version_changed`. If stored fields equal requested fields, succeed before comparing versions.
- `attach_bill_to_group`: retry to the same group fails `already_in_group`. Same group → no-op success; different group → `already_in_group`.
- `create_group`: retry creates a second group. Use a client-generated `p_id` like `add_expense`/`record_payment`.
- Id reuse after undo: `record_payment`/`add_expense` with an undone/deleted row's id returns success while the row stays undone. State it in C-G7; the client generates a new uuid per intent.

### S4. `assign_item` must re-check after taking its lock
C-G12 checks group and membership before the T7 lock order (bill KEY SHARE → line item → claims). `detach` can commit in between (assignment on a non-group bill); `leave_group` can remove the target (insert fails 23503 → `network`).
**Fix:** after `lock_bill_key_share`, re-read `bills.group_id`, the caller's and every target's membership; raise `42501 not_allowed`. Map 23503 to `claims_changed` so the app refetches.

### S5. Snapshot size
The spec's fixture (40 bills × 30 rows × 6 claimers) is ≈0.85 MB in the C-G11 shape — at the 1 MB budget, fetched on every focus and after every write. Bills can have up to 500 rows.
**Fix:** drop `name`, `group_position`, `unit_index` from snapshot rows; nest claims per row as `"claims": {"<uid>": parts}` (≈0.35–0.45 MB). Cap groups at 50 members in `join_group` (`22023 group_full`), matching C-G4. Report the measured size in T6. Memoize `groupBalances` per snapshot.

### S6. Snapshot parser and `groupBalances` checks
Add to C-G11 (each fails closed with `network`): each expense's Σ `shares.cents` = `amount_cents`; each bill's `payer_id` and every claim's `user_id` are in its `participant_ids`; `participant_ids` = the member set; every uuid is lowercase canonical (C-G4's sort assumes it). `groupBalances` checks Σ net = 0 before returning and throws `RangeError` otherwise (tested with corrupted input).

### S7. Group bills: bill-screen controls and `lib/bills.ts` error mapping
`join_bill`, `add_participant`, `remove_participant`, `leave_bill` now raise `22023 in_group`; `lib/bills.ts` maps unknown codes to `network`, so GR-25's copy never shows on `/b/<code>`. T17 hides Pay/I paid/Request/marks but not Leave bill, Remove, Add people.
**Fix:** add `lib/bills.ts` (`in_group` `BillError` + copy, `join_bill` mapping) and `app/b/[code].tsx` as **shared — coordinate** in T17; hide Leave, Remove and Add people on group bills, asserting absence where the participant list is present.

### S8. Account deletion can still change group money
`bills.host_id` cascades (deleting a host without expenses/payments deletes their group bill; `group_payments.bill_id` → null, orphaning `bill_mark` payments). `bill_participants.user_id` cascades and takes claims (the BEFORE DELETE trigger allows "profile gone"), so a counted receipt quietly becomes incomplete.
**Fix:** `group_members.user_id references profiles on delete restrict` (membership blocks deletion until the person leaves; leaving needs no history). Optional composite FK `bills (group_id, payer_id) → group_members (group_id, user_id) on delete restrict` (MATCH SIMPLE skips null `group_id`; see B2(d)). The T5 BEFORE DELETE trigger also passes when the bill no longer exists.

### S9. An unclaimed $0 or discount row holds a receipt out forever
A "Water $0.00" or "Happy hour −$5" row nobody claims keeps the receipt out of the group.
**Fix:** add the case to T1's degenerate list (criterion 4); make the waiting line a link to the bill; when 1–2 rows are left, name them ("Hana's receipt: Water left to claim"); add a Risks bullet. Don't change C1 for groups (the bill screen and group would disagree).

### S10. `expense_shares` needs `group_id`
T3's `(group_id, user_id)` FK to `group_members` needs a `group_id` column; also a composite FK `(expense_id, group_id) → expenses (id, group_id)` (with `unique (id, group_id)` on `expenses`) so a share can't point at another group.

### S11. Settling groups vs SV's "opening Venmo counts as sent"
After SV, bills record "Sent via Venmo" automatically when Venmo opens; groups still ask "Did you pay Dee?" → I paid. `source = 'venmo'` would mean different things in the two specs.
**Fix:** state that the group MVP keeps contract O on purpose (or adopts SV's write-first rule via `record_payment(…, 'venmo')`); give `source` one meaning in both specs; log as a GR decision for the user.

### S12. Home: where group bills are filtered
Session 96 planned a client filter (`groupId` on `BillSummary`); GR-19/T5 filters in `my_bills()`. The SQL filter is better: `my_bills` has `limit 20` and group bills would use up that budget. Tell 96 no `groupId` is needed; record it in the shared-files table.

### S13. `GroupError` is missing `invalid_payment`
Criterion 22 expects `22023 invalid_payment`; T9's union lacks it (→ `network`). Note in T9 that `invalid_code` is **P0002**, not 22023.

### S14. The join trigger needs a race note
The BEFORE INSERT trigger reads `group_members` unlocked; safe only because every inserting path (`join_bill`, `add_participant`) takes a bill lock that conflicts with attach's FOR UPDATE and leave_group's bill locks, and each plpgsql statement takes a new snapshot after waiting. Write this in T5's header.

### S15. Task dependencies
T14's "Add → Receipt" has nowhere to go until T17 wires `scanSession` to attach — hide it until T17 or move that part into T14's dependencies. T5 also waits for SV's migration (B1). T7 re-runs B4's kind assertion.

## Nits
- **N1.** T10's "keyed on (to, cents) of the opened link" reads as if cents must match the current suggestion; criterion 53 keeps the prompt when the amount changes. Reword: "keyed on the recipient being someone the viewer still pays; the stored cents is what I paid records".
- **N2.** `fetchGroupEvents`: order by `seq desc` alone (`created_at` is transaction start).
- **N3.** Equal splits store $0 share rows (A3: $0.01 among 3); under C-G10 those people can't leave because of a $0 share (2026-11-25 "$0 trap"). Exclude `cents = 0` shares from the leave check, or accept and log.
- **N4.** `rename_group` with the same trimmed name → no-op, no event.
- **N5.** U-G5 consequence for GR-12: co-members are linked (L1), so a host can `add_participant` a co-member to any non-group bill without that person opening a link.
- **N6.** A repeat `join_group` by a current member could re-insert missing participant rows (cheap self-repair of B2(b)'s invariant).
- **N7.** After a detach, the bill appears on Home for every trip member added through the group; add to GR-9's consequences.
- **N8.** Scope: `detach_bill_from_group` (GR-9, two events, T17's "Take out of", criterion 30) is the most cuttable piece if the slice runs long.
- **N9.** `set_payer` on a group bill moves money in the group; old `bill_mark` payments stay with the old payer (correct; note it in the concept note).

## Proposed Amendment A1 checklist
1. Sequencing with SV: B1.
2. Lock rule in T2's header: B2 (a)–(d), with the `leave_group` × `edit_expense` deadlock as the worked example; criterion 34 extended.
3. T5 owns `moved_to_group`/`removed_from_group`; pgTAP covers every Activity kind (B4).
4. Criterion 27 reworded (B3).
5. Money: S1, S2, S9.
6. Retries: S3. Re-checks under lock: S4.
7. Snapshot shape: S5. Parser checks: S6.
8. Shared files: `lib/bills.ts`, `app/b/[code].tsx` (S7); `my_bills` and mark columns (B1).
9. Schema: S8, S10, member cap 50 (S5).
10. Decisions to log for the user: S1, S2, S11, N3, N5.

## Critical files
- `docs/specs/2026-11-26-groups-mvp.md`
- `supabase/migrations/20261125090050_settle_early.sql` (`mark_paid` lock and check order)
- `supabase/migrations/20261124094656_people_review_fixes.sql` (lock-order rule, `lock_bill_key_share`)
- `supabase/migrations/20261124081411_settle_payer.sql` (`bill_participants_reset_payer`, mark columns)
- `docs/specs/2026-11-26-sent-via-venmo.md` (D8)
- `lib/split.ts`, `lib/bills.ts` (S7)
