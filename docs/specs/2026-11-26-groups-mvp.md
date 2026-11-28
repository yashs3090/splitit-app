# Spec: Groups MVP (G0–G4, plus assigning items to others in group bills)

Date: 2026-11-26 · Plan: `docs/plans/groups-2026-11-26.md` (read "User decisions (2026-11-26)" first) · ADR: **0022** (reserved, stub at `docs/learning/decisions/0022-groups.md`; Task 19 fills it in, amending 0015 and 0021) · Decisions: `docs/decisions-to-review.md` § "2026-11-26 · Groups" (GR-…).

Built under the user's "keep building, log decisions" rule. Nothing here stops for a question. Money decisions are built in the form that's easiest to change and marked **Money: needs your look**.

## Providers, accounts and costs

| Service / account | Used for | New? | Setup cost |
|---|---|---|---|
| Supabase (local stack; the hosted project later) | Tables, RLS, security-definer functions | No | $0 (current plan; groups add rows, not compute; assumption) |
| Venmo | Pay / Request links (`lib/paylinks.ts`), opened by the user | No | $0 |
| Google OAuth | Sign-in (everyone signs in, ADR 0004) | No | $0 |
| Push notifications / a scheduler | **Not used.** Reminders are out of the MVP (GR-M3). They'd need a server or a scheduled job, which is a backend decision for the user (ADR 0010) | — | — |

No new secrets, no new `EXPO_PUBLIC_*` values, no Edge Function, no custom backend.

## Goal

Friends on a trip can keep all of the trip's costs in one group, both receipts claimed item by item and quick "Ana paid $240 for the Airbnb" expenses, and finish with a short list of who pays whom, each payment opened in Venmo with the amount filled in. The riskiest assumption is that a whole trip will sign in and claim items (plan A1 + A2). This is the smallest version that tests it.

## User decisions this spec builds on (fixed)

From the plan's "User decisions (2026-11-26)" and the coordinator:
- **U-G1. Group-level settling only.** A bill in a group stops settling on its own. Existing "I paid" marks become group payments when the bill moves in.
- **U-G2. Everyone signs in.** No placeholder members (ADR 0004 unchanged).
- **U-G3. A group receipt counts only once it's fully claimed.** Until then it adds nothing to anyone's balance, unclaimed items never count against the payer, and the group shows e.g. "Hana's receipt: 2 items left to claim". This **replaces** the plan's rule G (proportional "settle early" counting) for group bills.
- **U-G4. Simplified payments by default**, with "Who paid what" one tap away.
- **U-G5. Privacy:** joining a group counts for People you've split with; members see each other's Venmo usernames; the group name goes in Venmo notes behind an off switch.
- **U-G6 (2026-11-26, coordinator relaying the user).** In a bill that belongs to a group, **any group member can assign an item (or a share of it) to another member**, not only claim for themselves ("on a friend trip person A will remember what person B got"). Non-group bills keep today's rule. This departs from the `CLAUDE.md` convention "users write only their own claims", for group bills only; the user approved it. People join a group by link or QR and then see all of its bills.
- **Main-session picks (GR-M1..M3, Open):** Equal and Exact splits only (no Shares); an expense's creator or payer can edit or delete it; no push reminders.

## In scope

1. **Groups:** create (name), invite by link, QR, Share… and From contacts; join by link (the invite survives sign-in); rename; a new link (rotate); Hide for me; leave (only with no history); a Groups section on Home.
2. **Simple expenses:** title, amount, paid by, split **Equally** (choose who) or by **Exact amounts**; edit and delete (soft) by the creator or the payer.
3. **Receipt bills in a group:** start a receipt from the group ("Add receipt", then Scan or Enter items), or move an existing bill in (host); remove a bill from the group (host, with limits). Every member is a participant of every group bill. Per-bill settling is off for group bills.
4. **Assigning items in group bills (U-G6):** any member can set who had an item (one or more members, with parts), through one function, logged in the bill's Activity.
5. **Balances:** computed in `lib/` from one `group_snapshot` read; fully-claimed bills only (U-G3); every balance adds up to exactly $0.
6. **Settle up:** suggested payments (greedy, deterministic, at most n−1), Venmo Pay for the person who owes and Request for the person owed, "I paid" records the amount opened, "Record a payment" for partial or cash payments, either side can undo. "Who paid what" (paid / share / payments / net per person, and each person's costs).
7. **Group Activity** (group-level events: members, expenses, bills moved in or out, payments).
8. **Docs:** ADR 0022, concept note, `docs/before-production.md` items, a proposed `CLAUDE.md` wording change.

## Out of scope (cut on purpose)

- Shares split (GR-M1), percentages, recurring expenses, categories, charts, exports, receipt photos on expenses, comments.
- Multi-currency (USD only; currency stays a parameter in code, ADR 0005).
- Placeholder (no-account) members (U-G2).
- Push reminders or any scheduled job (GR-M3).
- Adding someone to a group directly from "People you've split with" (GR-16): joining is by link only, so nobody is in a group without having opened its link.
- Removing another member (GR-17). People leave themselves, or hide the group.
- The pairwise "pay only people you owe" view and its toggle (plan v1).
- An exact fewest-payments solver (plan v2).
- Realtime on group screens (GR-21). Group screens refetch on focus and after each write; bill screens keep their existing Realtime.
- A "Balances changed since you paid" notice (GR-22). The new suggestion and Activity show the change.
- Per-group balances on Home (GR-20). Home rows show the group name and people count.
- A Home notice for "Ana added Tacos for you" (GR-A2). It shows in the bill's Activity.
- Universal Links for `/g/*` (added to `docs/before-production.md` §5; app links are off until there's a paid Apple team anyway).

## Concurrency: files other sessions own

Two other sessions are active. Groups uses **new files** wherever it can. Every existing file a task must edit is listed in that task and in this table, marked **shared — coordinate**. The main session sequences these with the owning session before starting the task.

| Existing file | Owner today | Groups task that edits it | What changes |
|---|---|---|---|
| `app/(app)/index.tsx` (Home) | splitit-app-96 (Home refresh) | T13 | One import and `<GroupsSection />` above the bill sections |
| `app/(app)/bills/[id]/index.tsx` (bill screen) | splitit-app-92 (settle early) | T17, T18 | "In <group>" line; group invite instead of the bill's invite card; footer says "Settled in <group>"; item sheet gets assign props |
| `app/(app)/bills/[id]/settle.tsx` | splitit-app-92 | T17 | Group bills show one "Settled in <group>" card linking to the group |
| `components/ItemSheet.tsx` | not claimed (used by the bill screen) | T18 | Optional `assign` prop: the "Who had this?" chips |
| `lib/activityText.ts` | not claimed | T11 | New kinds `assigned`, `unassigned`, `moved_to_group`, `removed_from_group` |
| `lib/people.ts` | not claimed | T11 | Caption for a person linked only through a group |
| `lib/pendingInvite.ts` | not claimed | T9 | A group invite (`g-` prefix) resumes to `/g/<code>` |
| `lib/scanSession.ts`, `app/(app)/bill.tsx` | not claimed | T17 | Carry "add to this group" from the group screen through Scan / Enter items |
| `lib/bills.ts` (A1, S7) | splitit-app-92 | T17 | `in_group` added to `BillError` + `BILL_ERROR_COPY`; `join_bill` maps it |
| `app/b/[code].tsx` (A1, S7) | not claimed | T17 | Shows GR-25's copy for `in_group` |
| `my_bills()` (A1, B1, S12) | Sent via Venmo (`20261126080844_sent_via_venmo.sql` re-creates it with `seen_at`); Home refresh (96) reads it | T5 | Re-created from SV's version (keeps `seen_at`), adds `where b.group_id is null`. Home needs no `BillSummary.groupId` (the coordinator tells splitit-app-96) |
| `bill_participants` mark columns (A1, B1) | Sent via Venmo adds `settled_method` and three `not_received_*` columns | T5 | `attach_bill_to_group` clears every mark column on the latest schema |
| `supabase/migrations/` (new files only) | settle-early and Sent via Venmo specs also add migrations | T2–T7 | New migrations only. **T5 adds triggers on `bill_participants` and re-creates `join_group` and `my_bills`; T7 re-creates `private.log_claim_event` and widens `bill_events_kind_known`.** The Sent via Venmo spec (`docs/specs/2026-11-26-sent-via-venmo.md`, SV-2) plans to replace `mark_paid` / `settle_difference` and may also widen `bill_events_kind_known`: whichever lands second re-reads the latest constraint list and keeps every kind |

`lib/settle.ts`, `lib/settleView.ts`, `lib/bills.ts`, `lib/homeMarkers.ts`, `components/ui/ListRow.tsx`, `SettleCard`, `SettlePeopleList` and `SettleFooter` are **imported, never edited** by this spec.

---

## Shared contracts (defined once; tasks point here)

Every rule below has one definition. "lib only" rules are deliberately one-sided: the database doesn't compute them, and that is not a gap to fix later (the K6 lesson). Each "lib + DB" rule has a boundary table that **both** sides' tests run.

### C-G1. Which bills count (rule F, "fully claimed only"; lib only)

A bill with `group_id = G` **counts** toward G's balances when all of these hold:
1. `sharesComplete(input).complete` (every row, items and claimable discounts, has at least one counted claim; rule C1), and
2. `computeShares(input).unclaimedCents === 0` (this excludes the all-$0 case, rule Z), and
3. the bill's `payer_id` is a member of G (always true under the invariants; if not, the bill doesn't count and the parser reports the snapshot as broken).

`input` is `splitInputFor(...)` from `lib/billView.ts` (imported, unchanged). A bill that counts adds `total_cents` to its payer's **paid** and each person's `computeShares` total to their **share** (a share may be $0 or negative). A bill that doesn't count adds nothing to anyone, and the group lists it as waiting:
- incomplete: `"<bill label>: " + footerIncomplete(unclaimedRows, unclaimedDiscountRows)` ("Hana's receipt: 2 items left to claim", "…: 1 discount left to claim", "…: 2 items and 1 discount left to claim"), using `footerIncomplete` from `lib/settleView.ts` (imported);
- all-$0: `"<bill label>: " + SETTLE_ALL_ZERO_GUEST_COPY(hostName)` for guests; the host sees "<bill label>: every item is $0. Fix the prices in Edit items."

Even-split and proportional bills follow the same rule (both wait until complete). The DB enforces none of this. A bill label is `"<host name>'s receipt"` (`"Your receipt"` for the viewer's own), because bills have no title column (GR-30).

### C-G2. Balance (lib only)

For each member u of the group:
```
paid(u)     = Σ total_cents of counting bills whose payer is u + Σ amount_cents of live expenses whose payer is u
share(u)    = Σ computeShares total of u over counting bills + Σ expense_shares.cents of u over live expenses
sent(u)     = Σ cents of live payments from u
received(u) = Σ cents of live payments to u
net(u)      = paid(u) − share(u) + sent(u) − received(u)
```
"Live" = `deleted_at is null`. All integers (cents); every sum is checked with `Number.isSafeInteger`, and a bad value makes `groupBalances` throw (never a wrong number). **Property:** Σ net(u) over members = 0 exactly. Positive net = owed money; negative = owes.

### C-G3. Suggested payments (lib only)

`simplify(nets)` where `nets` is a map user id → net:
1. Work on a copy. Repeat while some net > 0 and some net < 0:
   - creditor c = the user with the largest net (ties: lower user id, code-unit order as in `lib/split.ts`);
   - debtor d = the user with the smallest (most negative) net (same tie rule);
   - x = min(net(c), −net(d)); emit `{ from: d, to: c, cents: x }`; net(c) −= x; net(d) += x.
2. The full list settles every net to exactly 0 and has at most (number of non-zero nets − 1) payments.
3. **Shown** suggestions (amended by A1, S2) = the full list without the payments where `cents ≤ GROUP_IGNORE_CENTS` **and** both people's |net| ≤ `GROUP_IGNORE_CENTS` (constant in `lib/simplify.ts`, **starting value 1**). Order is the order of step 1.
4. Properties (tested in T1): input order never changes the output; every net is preserved by the full list; after applying the shown list, each person's leftover |net| ≤ `GROUP_IGNORE_CENTS`; a hidden payment always has both people within the threshold.
5. `isSettledUp(net) = |net| ≤ GROUP_IGNORE_CENTS` (exported from `lib/simplify.ts`) is the **one** predicate the status line, the Settle screen and the criteria use.

A person for whom `isSettledUp` is true reads "You're settled up", and "Who paid what" still shows the exact net (GR-3, **Money: needs your look**).

### C-G4. Equal expense allocation (lib + DB, same rule)

Equal among the chosen users U (1..50 distinct members): sort U by user id in code-unit order of the lowercase canonical uuid string (SQL: `order by user_id::text collate "C"`, which gives the same order as JS `<` on lowercase uuid strings), then `allocate(amount, [1, 1, …])` (largest remainder, leftover cents to the lowest index). `lib`: `allocate` from `lib/split.ts`. DB: new `private.allocate(p_amount bigint, p_weights integer[]) returns integer[]`, the same algorithm (floors in bigint, leftover to the largest remainder, ties to the lower index; refuses negative weights and Σweights = 0 with amount ≠ 0). Every chosen user gets an `expense_shares` row, including a $0 one (needed to reload "who's in" exactly).

| # | Amount | Users (in id order) | Expected cents |
|---|---|---|---|
| A1 | 100 | 1 user | [100] |
| A2 | 100 | 3 | [34, 33, 33] |
| A3 | 1 | 3 | [1, 0, 0] |
| A4 | 24000 | 4 (Airbnb) | [6000, 6000, 6000, 6000] |
| A5 | 1001 | 4 | [251, 250, 250, 250] |
| A6 | 99,999,999 | 20 | 19 × 5,000,000 then 4,999,999 |
| A7 | 99,999,999 | 2 | [50,000,000, 49,999,999] |
| A8 | 100 | 3 users sent in reverse order | same as A2, by user id |
| A9 | `private.allocate(3, {1,0,1})` / `allocate(3,[1,0,1])` | weights with a 0 | [2, 0, 1] |
| A10 | 5 | `{0,0}` / `[0,0]` | refused (DB 22023 `invalid_shares` via the caller; lib throws RangeError) |

### C-G5. Exact amounts (lib + DB, same rule)

Payload `p_shares` is a JSON object user id → integer cents. Valid when: at least 1 key; keys are distinct uuids of current members; every value is a JSON integer 1..99,999,999 (not `1.5`, not `"100"`, not 0); Σ values = amount **exactly** (no tolerance). The form leaves blank or $0 people out of the payload; the lib validator refuses a 0 if one is given. Stored as one `expense_shares` row per key.

| # | Amount | Payload | Lib (`validateExpense`) | DB (`add_expense` / `edit_expense`) |
|---|---|---|---|---|
| X1 | 30000 | {Ana 8572, Ben 8571, Cy 8571, Dee 4286} | ok | ok |
| X2 | 30000 | Σ 30001 (one value +1) | `off_by` +1 | 22023 `invalid_shares` |
| X3 | 30000 | Σ 29999 (one value −1) | `off_by` −1 | 22023 `invalid_shares` |
| X4 | 30000 | {Ana 30000} | ok | ok |
| X5 | 30000 | {Ana 30000, Ben 0} | `invalid` (0) | 22023 `invalid_shares` |
| X6 | 99,999,999 | {Ana 99,999,999} | ok | ok |
| X7 | 100 | {Ana 50, Ben 50.5} or {Ana "100"} | `invalid` | 22023 `invalid_shares` |
| X8 | 100 | a non-member key | n/a (form lists members only) | 22023 `not_member` |

### C-G6. Expense fields (lib + DB)

`title`: trimmed, 1..100 code points (`char_length(btrim(title))`; JS `Array.from(title.trim()).length`). `amount_cents`: integer 1..99,999,999. `split_method`: `'equal' | 'exact'` (a check constraint; `'shares'` is not accepted yet). Payer: a current member. Boundary cases on both sides: title 0 / 1 / 100 / 101 code points, a 100-emoji title is valid; amount 0 / 1 / 99,999,999 / 100,000,000 → DB 22023 `invalid_expense` for the bad ones.

### C-G7. Payment fields (lib + DB)

`cents`: integer 1..99,999,999 (rule C2, `isSettleCents` from `lib/paylinks.ts`). `from_user ≠ to_user`, both current members, and the caller is one of them. `source`: `'manual' | 'venmo' | 'bill_mark'`; clients may send only `'manual'` or `'venmo'`. The id is a client-generated uuid: a retry with the same id and the same (group, from, to, cents, source) is a no-op that returns success; the same id with any other value is 22023 `id_conflict`. Boundary cases on both sides: cents 0 / 1 / 99,999,999 / 100,000,000; from = to; a third member as caller (42501).

### C-G8. Group name (lib + DB)

Trimmed, 1..60 code points. Boundary: 0 / 1 / 60 / 61; 60 emoji valid.

### C-G9. Who may do what

| Action | Who | Refusal |
|---|---|---|
| Read the group, its snapshot, its Activity | Members | 42501 `not_allowed` (RLS: 0 rows on tables; functions raise) |
| Add an expense, record a payment involving yourself, rename, new link, move your own bill in, start a receipt in the group | Any member (payments: caller is `from` or `to`; moving a bill in: its host) | 42501 |
| Edit or delete an expense | Its `created_by` or its current `payer_id` | 42501 |
| Undo a payment | Its `from_user` or `to_user` | 42501 |
| Remove a bill from the group | The bill's host | 42501 |
| Edit a group bill's items, change its payer | The bill's host (unchanged) | 42501 (unchanged) |
| Assign items on a group bill (`assign_item`) | Any member (GR-A1) | 42501 for a non-member, a non-group bill, or a target who isn't a member |
| Leave | Yourself, only with no history and not the last member (C-G10) | 22023 `cannot_leave` |
| Hide / unhide | Yourself (owner-only row) | — |

### C-G10. Leaving (rule L3-G; DB authoritative, lib mirror only decides which button shows)

A member may leave group G only when **all** are false: they host or pay any bill in G; they have a claim on any bill in G; they are `payer_id`, `created_by` or a share user of any expense in G (deleted ones included, so history never disappears); they are `from_user`, `to_user` or `recorded_by` of any payment in G (undone ones included); they are the only member. Leaving deletes their `group_members` row and their participant rows on G's bills, and logs `member_left`. It never changes anyone's money (L3). The lib mirror `canLeaveGroup(snapshot, me)` reads only what the snapshot carries (live rows) and is advisory: the DB may still refuse (deleted expenses and undone payments count there), and the screen maps that to fixed copy.

### C-G11. `group_snapshot(p_group_id) returns jsonb` (the one read; app parses exactly this)

```
{
  "group":    { "id", "name", "join_code", "created_by", "created_at" },
  "me":       { "hidden": boolean },
  "members":  [ { "user_id", "display_name", "venmo_username", "joined_at" } ],          -- ordered by joined_at, user_id
  "bills":    [ { "id", "host_id", "payer_id", "total_cents", "extras_split", "created_at",
                  "rows":   [ { "id", "name", "total_cents", "kind", "group_position", "unit_index" } ],
                  "claims": [ { "line_item_id", "user_id", "parts" } ],
                  "participant_ids": [ uuid ] } ],                                         -- bills ordered by created_at, id
  "expenses": [ { "id", "title", "payer_id", "amount_cents", "split_method", "created_by",
                  "created_at", "edited_at", "version",
                  "shares": [ { "user_id", "cents" } ] } ],                                -- live only; by created_at, id
  "payments": [ { "id", "from_user", "to_user", "cents", "source", "recorded_by",
                  "bill_id", "created_at" } ]                                              -- live only; by created_at, id
}
```
One statement (one snapshot of the data), security definer, members only (42501 otherwise). `lib/groups.ts` parses it strictly (every id a uuid, every amount a safe integer in its range, every referenced user a member, every claim on a row of its bill); anything off returns `{ ok: false, error: 'network' }` (fail closed, never a partial balance). Size: T6 measures a 40-bill × 30-row × 6-claimer group (see criterion 61).

### C-G12. `assign_item(p_line_item_id uuid, p_parts jsonb, p_expected jsonb)` (U-G6)

Sets the **whole** claimer set of one row of a group bill. `p_parts`: object member id → parts 1..20 (same shape and rules as `set_item_split`'s), `{}` = nobody. `p_expected`: the claimer map (id → parts) the screen showed; if the row's current map differs, 22023 `claims_changed` and nothing changes. Identical `p_parts` and current map: no-op, no event. Check order: signed out → 42501; the row's bill doesn't exist, isn't in a group, or the caller isn't a member of that group → 42501 `not_allowed` (same answer for all three, so it reveals nothing); `p_parts` badly shaped → 22023 `invalid_parts`; a key that isn't a member → 42501 `not_allowed`; stale `p_expected` → 22023 `claims_changed`. Then deletes, inserts and updates claims to match. Events (bill Activity, through the claims trigger, see T7): one `claimed`/`unclaimed` per person when that person is the caller; one `assigned`/`unassigned` `{ user_id }` per other person; one `split_changed` when parts change for people who stay.

### Worked example (both T1 fixture and the plan's numbers, with U-G3)

People in user-id order **Ana < Ben < Cy < Dee**. Cents.
- **Dinner** (receipt, proportional, payer Ana; Dee wasn't there and claims nothing): items Ana 2000, Ben 1800, Cy 1200, nachos 1000 shared by Ana/Ben/Cy (334/333/333); tax 533 + tip 1200; total 7733. Shares **Ana 3008, Ben 2749, Cy 1976, Dee 0**.
- **Brunch** (receipt, even, payer Ben, all claimed): items Ana 900, Ben 1100, Cy 700, Dee 1300; extras 1001 → 251/250/250/250. Shares **1151, 1350, 950, 1550**; total 5001.
- **Airbnb** (expense, Ana paid 24000, Equally among 4): **6000 each**.
- **Rental car** (expense, Dee paid 30000, **Exact**: Ana 8572, Ben 8571, Cy 8571, Dee 4286). (The plan used Shares 2/2/2/1, which gives the same cents; Shares is out of the MVP.)

| Case | Nets (Ana, Ben, Cy, Dee) | Shown suggestions (C-G3 order) |
|---|---|---|
| W1 all four count | +13002, −13669, −17497, +18164 | Cy→Dee 17497; Ben→Ana 13002; Ben→Dee 667 |
| W2 Dinner's nachos unclaimed (Dinner doesn't count, U-G3) | +8277, −10920, −15521, +18164 | Cy→Dee 15521; Ben→Ana 8277; Ben→Dee 2643 |
| W3 W1, then Cy records 10000 to Dee (partial) | +13002, −13669, −7497, +8164 | Ben→Ana 13002; Cy→Dee 7497; Ben→Dee 667 |
| W4 W1 with all three suggestions recorded, then Ana edits Dinner's tip 1200 → 1500 (Dinner shares 3125/2856/2052/0, total 8033) | +183, −107, −76, 0 | Ben→Ana 107; Cy→Ana 76 |
| W5 Brunch was a standalone bill where Cy had marked "I paid" 950 to Ben; it moves into the group (mark → payment Cy→Ben 950, source `bill_mark`) | +13002, −14619, −16547, +18164 | Cy→Dee 16547; Ben→Ana 13002; Ben→Dee 1617 |
| W6 W1, then Ben assigns the nachos to Ana alone, Ben and Cy keep their items (assignment is a claim change; Dinner still counts) | recomputed by `computeShares`; Σ = 0 | test asserts Σ net = 0 and the suggestions equal `simplify` of the new nets |

Dee's Dinner share is exactly 0 in W1–W5 (a member who wasn't there owes $0 for it). Every row's nets sum to 0.

---

## Tasks

Agents: **implementer** for `lib/`, **supabase-engineer** for `supabase/`, **product-engineer** for screens (loads the `ui-ux-designer` skill; ADR 0020 rules: tokens from `lib/theme.ts`, primitives from `components/ui/`, `lucide-react-native` icons imported one by one, no glyph icons, one primary action per screen), **docs-writer** for docs. "Lines" is a rough size for one pass.

### T0. Staff-engineer review of this spec (Plan agent acting as staff engineer; no code)
Per the 2026-11-25 lesson, a whole-plan review runs before code for slices with screens on new DB functions. Checklist: server limits (`max_rows`, payload size), degenerate values ($0, empty, one member), lock order across T2–T7, whether the spec agrees with itself, planned breakage and dependencies. The PM folds findings into a dated Amendment A1 here. Runs alongside T1. Files: `docs/specs/2026-11-26-groups-mvp-eng.md` (new).

### T1. G0 spike: balance and simplification (implementer) — Wave 0
Files (all new): `lib/groupBalance.ts`, `lib/groupBalance.test.ts`, `lib/simplify.ts`, `lib/simplify.test.ts`, `test-utils/groupFixtures.ts` (the worked example as typed inputs, reused by T10 and T12). ~300 lines.
- `groupBalances(input)`: input = members, bills (as `{ payerId, totalCents, split: SplitInput }`), expenses (`{ payerId, amountCents, shares: {userId, cents}[] }`), payments (`{ from, to, cents }`); returns per member `{ paidCents, shareCents, sentCents, receivedCents, netCents }` plus `counting: billId[]` and `waiting: { billId, reason: 'incomplete' | 'all_zero', unclaimedRows, unclaimedDiscountRows }[]` (C-G1, C-G2). Uses `computeShares` and `sharesComplete` from `lib/split.ts` (imported).
- `simplify(nets)` and `GROUP_IGNORE_CENTS = 1` (C-G3).
- Verdict line in the T1 report: PASS (properties hold on 1,000 seeded groups) or the counterexample. T10 starts only after PASS.

### T2. DB 1: groups core (supabase-engineer) — Wave 1, after T0's amendment
Files: new migration `supabase/migrations/<timestamp>_groups.sql` (timestamp taken when the file is created), new `supabase/tests/database/groups.test.sql`. ~300 lines.
- Tables: `groups` (id, name check C-G8, currency `'USD'` check, `join_code` 20 hex DB-generated unique, `created_by` → profiles, created_at), `group_members` (group_id, user_id) PK, joined_at), `group_hidden` (group_id, user_id) PK, owner-only), `group_events` (id, `seq bigint generated always as identity` for order, group_id, actor_id, kind check, details jsonb object, created_at; append-only trigger like `bill_events`).
- RLS on every table; `revoke all … from anon, authenticated, public`; `grant select` to authenticated on `groups` (columns: all), `group_members`, `group_events` with member-only policies through `private.is_group_member(group_id)` (security definer, caller only); `group_hidden`: no client table access at all (read through `my_groups`). No client insert/update/delete anywhere.
- `private.shares_group_with(p_user_id)`; `profiles_select_own_or_co_participant` replaced by one policy allowing own row, co-participants (unchanged) **or co-members** (U-G5). Column grants on profiles unchanged (id, display_name, venmo_username).
- Functions (security definer, `search_path = ''`, `auth.uid()` checked first, execute for authenticated only): `create_group(p_name) → uuid` (caller becomes the only member; logs `group_created`), `join_group(p_code) → uuid` (idempotent; logs `member_joined` once; bill sync is added in T5), `rename_group(p_group_id, p_name)` (any member; logs `renamed` {from, to}), `rotate_group_code(p_group_id) → text` (any member; logs `link_rotated` {}), `set_group_hidden(p_group_id, p_hidden boolean)` (writes or deletes the caller's row; no event; no shared row changes), `my_groups()` → (id, name, member_count, joined_at, hidden) for the caller, ordered by joined_at desc, id.
- Migration header: lock order (group row first, then bills by ascending id, then `bill_participants`, then claims, implicit FK locks listed), columns clients can't read, error list.

### T3. DB 2: expenses (supabase-engineer) — Wave 2, after T2
Files: new `supabase/migrations/<timestamp>_group_expenses.sql`, new `supabase/tests/database/group_expenses.test.sql`. ~300 lines.
- `private.allocate` (C-G4). `expenses` (id client-generated, group_id, title, payer_id, amount_cents, split_method, created_by, created_at, edited_at, version int default 1, deleted_at, deleted_by; `(group_id, payer_id)` and `(group_id, created_by)` FKs to `group_members` **on delete restrict**), `expense_shares` (expense_id, user_id) PK, cents ≥ 0; `(group_id, user_id)` FK to `group_members` on delete restrict). RLS + grants as T2 (select for members; no client writes).
- `add_expense(p_id, p_group_id, p_title, p_payer_id, p_amount_cents, p_method, p_shares jsonb)`: equal → `p_shares` is `{uid: 1, …}` (the chosen users; any other value 22023 `invalid_shares`), cents computed by `private.allocate` (C-G4); exact → C-G5. Same id + same content → no-op; same id, different content → 22023 `id_conflict`. Logs `expense_added` {expense_id, amount_cents}.
- `edit_expense(p_id, p_expected_version, …same fields…)`: C-G9 (creator or current payer); stale version → 22023 `version_changed`; no change → no write, no event; else replaces shares, `version + 1`, `edited_at = now()`, logs `expense_edited` {expense_id, before: {title, amount_cents, payer_id, split_method}, after: {…}}.
- `delete_expense(p_id, p_expected_version)`: soft delete (`deleted_at`, `deleted_by`); repeat → no-op; logs `expense_deleted` {expense_id, amount_cents}.
- pgTAP runs the A1–A10 and X1–X8 tables and the C-G6 boundaries.

### T4. DB 3: payments (supabase-engineer) — Wave 2, after T3
Files: new `supabase/migrations/<timestamp>_group_payments.sql`, new `supabase/tests/database/group_payments.test.sql`. ~250 lines.
- `group_payments` (id client-generated, group_id, from_user, to_user, cents check 1..99,999,999, source check, recorded_by, bill_id null → bills on delete set null, created_at, deleted_at, deleted_by; check from ≠ to; `(group_id, from_user)`, `(group_id, to_user)`, `(group_id, recorded_by)` FKs to `group_members` on delete restrict). RLS + grants as T2.
- `record_payment(p_id, p_group_id, p_from, p_to, p_cents, p_source)` (C-G7; logs `payment_recorded` {payment_id, from, to, cents, source}); `undo_payment(p_id)` (from or to; soft; repeat → no-op; logs `payment_undone` {payment_id}).

### T5. DB 4: bills in groups (supabase-engineer) — Wave 2, after T4
Files: new `supabase/migrations/<timestamp>_group_bills.sql`, new `supabase/tests/database/group_bills.test.sql`. ~300 lines (may land as two migrations if larger; say so in the report).
- `bills.group_id uuid null references groups on delete restrict` (+ index). Readable through the existing table-level SELECT.
- `attach_bill_to_group(p_bill_id, p_group_id)` (host of the bill, member of the group): bill already in a group → 22023 `already_in_group`; any participant not a member → 22023 `participants_not_members`; else in one transaction: set `group_id`; insert every member who isn't a participant (`added = false`, GR-11; no per-bill events); for each marked participant insert a `group_payments` row `{ from: participant, to: bill payer, cents: settled_cents, source: 'bill_mark', bill_id, recorded_by: the participant }` and clear `settled_at` / `settled_cents` (U-G1); log `bill_added` {bill_id, converted: n} in `group_events` and `moved_to_group` {group_id, converted: n} in `bill_events`.
- `detach_bill_from_group(p_bill_id)` (host): live `bill_mark` payments from this bill remain → 22023 `has_bill_payments` (GR-9); else `group_id = null`, participants stay, log `bill_removed` / `removed_from_group`.
- Invariant triggers on `bill_participants` (GR-10), each raising 22023 `in_group`: BEFORE UPDATE that sets `settled_at` or `settled_cents` to non-null on a group bill (so `mark_paid` and `settle_difference`, today's or Sent via Venmo's replacements, can't mark a group bill); BEFORE INSERT of a user who isn't a member of the bill's group (covers `join_bill` and `add_participant` from non-members); BEFORE DELETE of a member's row on a group bill while they are still a member and their profile exists (covers `remove_participant` / `leave_bill`; `leave_group` deletes membership first; account deletion passes). Verify the trigger's error surfaces as `22023 in_group` through each existing function; reword if a function catches it.
- `join_group` re-created: also inserts the joiner into every bill of the group (bills locked in ascending id order, `added = false`, no per-bill events).
- `leave_group(p_group_id)` (C-G10), logging `member_left`.
- `my_bills()` re-created to exclude bills with `group_id is not null` (GR-19); same signature, columns and order otherwise.
- `private.my_links()` extended: co-members of any group the caller is in are linked (U-G5); `people_i_split_with()`: `shared_bills` = count of distinct shared bill ids (may be 0 for a group-only link), `last_shared_at` = the later of the last shared bill and the later of the two `joined_at` values. Ranking unchanged.

### T6. DB 5: snapshot (supabase-engineer) — Wave 2, after T5
Files: new `supabase/migrations/<timestamp>_group_snapshot.sql`, new `supabase/tests/database/group_snapshot.test.sql`, a seed script for the size check in the scratchpad (not committed). ~200 lines. `group_snapshot` exactly as C-G11.

### T7. DB 6: assigning items (supabase-engineer) — Wave 2, after T6
Files: new `supabase/migrations/<timestamp>_assign_item.sql`, new `supabase/tests/database/assign_item.test.sql`. ~250 lines.
- `assign_item` (C-G12). Lock order: bill row (`private.lock_bill_key_share`), then the line item FOR UPDATE, then its claims FOR UPDATE, then writes.
- `private.log_claim_event` re-created: actor = `coalesce(auth.uid(), claim's user_id)`; when actor ≠ the claim's user, kind `assigned` / `unassigned` with details `{ unit, split, user_id }`; otherwise unchanged (`claimed` / `unclaimed`). Cascade skips unchanged.
- `bill_events_kind_known` re-created from the **latest** list on disk plus `assigned`, `unassigned`, `moved_to_group`, `removed_from_group` (if T5 already added the last two, keep them).
- Non-group bills: `set_claim`, `set_item_split` and the claims RLS policies are unchanged.

### T8. Expense form logic (implementer) — Wave 1
Files (new): `lib/groupExpense.ts`, `lib/groupExpense.test.ts`. ~250 lines.
- `equalPreview(amountCents, userIds)` (C-G4, via `allocate`), `exactCheck(amountCents, entries)` → `{ status: 'adds_up' } | { status: 'off_by', cents }` | `{ status: 'invalid', field }` (C-G5; any invalid field never reads "adds up", lesson 2026-11-21), `validateExpense(draft)` (C-G6), `expensePayload(draft)` → the exact `p_shares` JSON T3 accepts (equal → `{uid: 1}`, exact → `{uid: cents}` with blank and $0 people left out). Copy for each state.

### T9. Data layer (implementer) — Wave 1 (contracts only; reconciled live in T12)
Files: new `lib/groups.ts`, `lib/groups.test.ts`, `lib/groupInviteLink.ts`, `lib/groupInviteLink.test.ts`; edit `lib/pendingInvite.ts` and `lib/pendingInvite.test.ts` (**shared — coordinate**: imported by `app/_layout.tsx`, which is not edited). ~300 lines.
- One wrapper per T2–T7 function; `GroupError` union (`not_allowed`, `invalid_code`, `invalid_name`, `invalid_expense`, `invalid_shares`, `not_member`, `id_conflict`, `version_changed`, `cannot_leave`, `already_in_group`, `participants_not_members`, `has_bill_payments`, `in_group`, `claims_changed`, `invalid_parts`, `invalid_amount`, `network`) with `GROUP_ERROR_COPY`; unknown codes → `network`.
- `fetchGroupSnapshot` (strict parser, C-G11), `listMyGroups`, `fetchGroupEvents(groupId)` (`.select('id, seq, actor_id, kind, details, created_at')`, ordered by created_at desc then seq desc, limit 100), `fetchBillGroup(billId)` → `{ groupId, name } | null` (`.select('group_id')` on bills, then `.select('id, name')` on groups), `assignItem`.
- `groupInviteUrl(code)` (`/g/<code>`, same origin rule as `lib/inviteLink.ts`). `lib/pendingInvite.ts`: a group invite is stored as `g-<code>`; `postSignInRoute('g-<code>')` → `/g/<code>`; bill codes unchanged.

### T10. View models (implementer) — Wave 2, after T1 PASS and T9
Files (new): `lib/groupView.ts`, `lib/groupView.test.ts`, `lib/groupSettleView.ts`, `lib/groupSettleView.test.ts`, `lib/groupActivityText.ts`, `lib/groupActivityText.test.ts`. ~300 lines (may land as two commits).
- `groupScreen(snapshot, viewerId, nameOf)`: status line ("You're owed $130.02" / "You owe $12.40" / "You're settled up"), waiting lines (C-G1), costs list (newest first; bills and expenses; each with "Ana paid $77.33" and "you $30.08" / "you $0.00" / "you —" while waiting), `canLeave` (C-G10 mirror).
- `groupSettle(snapshot, viewerId, platform, opened)`: the viewer's card, suggestions (shown list, C-G3) with roles `pay` / `request` / `other`, Venmo URLs from `venmoPayUrl` / `venmoRequestUrl` (imported; `itemNames: GROUP_VENMO_NOTE_INCLUDES_NAME ? [groupName] : []`, so the note is "SplitIt: <group name>"), the "Did you pay Dee?" step keyed on (to, cents) of the opened link, "Who paid what" rows, payment list with Undo rights, `recordPaymentCheck(cents, suggested)` → ok / invalid / `over` warning ("That's more than you owe Dee ($174.97).").
- `export const GROUP_VENMO_NOTE_INCLUDES_NAME = true` (U-G5 kill switch).
- `describeGroupEvent(e, nameOf)` for every T2–T5 kind, tested with the viewer as actor and target and with counts of 1.

### T11. Small lib edits (implementer) — Wave 1
Files: edit `lib/activityText.ts`, `lib/activity.test.ts` or the existing activityText tests (**shared — coordinate**), edit `lib/people.ts` and its test (**shared — coordinate**), new `lib/itemAssign.ts`, `lib/itemAssign.test.ts`. ~200 lines.
- Activity sentences: "Ana assigned Tacos to Ben", "Ana assigned Tacos to you", "You assigned Tacos to Ben", "Ana removed Ben from Tacos", "Ana removed you from Tacos", "You removed Ben from Tacos", "Ana moved this bill into Tahoe trip" (group name passed in; "a group" if unknown), "Ana took this bill out of Tahoe trip", plus the converted-marks clause ("2 "I paid" marks became group payments" / "1 … became a group payment").
- `personCaption` for `shared_bills = 0`: "In a group together".
- `toggleAssignee(current, userId)` → the new parts map (adding gives parts 1 and keeps everyone else's parts; removing drops the key) and `assignChips(members, current, viewerId, nameOf)` (viewer first, then by name).

### T12. Live reconciliation (main session, `live-db-smoke` skill) — after T2–T7 and T9
No new committed files (script in the scratchpad). Runs `lib/groups.ts` against the local stack as 4 throwaway users and checks the shared boundary tables give the same answer in lib and DB (C-G4, C-G5, C-G6, C-G7, C-G8), plus W1–W5 end to end through the real functions.

### T13. Home section, new group, join route, invite panel (product-engineer) — Wave 3, after T2 and T9
Files: new `components/GroupsSection.tsx`, `app/(app)/groups/new.tsx`, `app/g/[code].tsx`, `components/GroupInvite.tsx`, `__tests__/groupsHome.test.tsx`, `__tests__/groupJoin.test.tsx`; edit `app/(app)/index.tsx` (**shared — coordinate with splitit-app-96**: one import, one element). ~300 lines.
- Groups section above the bill sections: one `ListRow` per visible group (name; caption "4 people"); a quiet "New group" `TextLink`; with no groups, just the "Start a group" link; "Show hidden groups (2)" / "Hide" toggle when any are hidden, each with "Unhide".
- New group: one field ("Name", e.g. "Tahoe trip"), one primary "Create group", then the group screen with the invite panel open.
- `/g/<code>`: signed out → save `g-<code>` and go to sign-in; signed in → `join_group` → replace with `/groups/<id>`; bad code → fixed copy. Never echoes URL text.
- `GroupInvite`: the link, Copy link, Share… (message "Join our group on SplitIt: <link>", no group name, GR-28), Show QR code (`InviteQr`), From contacts on iOS/Android (`ContactInvite`), "Make a new link" with an inline confirm ("The old link will stop working. People already in the group stay in.").

### T14. Group screen and group Activity (product-engineer) — Wave 3, after T6, T10
Files: new `app/(app)/groups/[id]/index.tsx`, `app/(app)/groups/[id]/activity.tsx`, `components/GroupCostRow.tsx`, `__tests__/groupScreen.test.tsx`. ~300 lines.
- Top: status line (big money text), the one primary **Settle up**, waiting lines only when there are any. Costs card with an "Add" control opening two choices: "Expense" ("Airbnb, gas, tickets: one amount split between people") and "Receipt" ("Scan or type a receipt; everyone claims what they had"). An "Activity" row. A ⋯ `IconButton` (label "Group options") with Invite, Rename, Hide for me, Leave (Leave shown only when `canLeave`; inline confirm).
- Loading, error with Try again, refetch on focus and after each write; a failed refetch after a write re-enables controls and shows "Couldn't refresh. Try again." (lesson 2026-11-24/25).

### T15. Expense screen (product-engineer) — Wave 3, after T3, T8
Files: new `app/(app)/groups/[id]/expense.tsx` (add, and edit via `?expense=<id>`), `__tests__/groupExpense.test.tsx`. ~300 lines.
- Fields in order: What for, Amount, Paid by (member picker, viewer default), Split (`SegmentedControl` "Equally" / "Exact amounts"); Equally: member checkboxes with each person's preview cents; Exact: one amount field per member, the "Adds up" / "Off by $0.01" line from `exactCheck`. One primary Save. Edit adds "Delete expense" (danger, inline confirm), shown only to the creator or payer. Unsaved-input guard on every exit path the screen has (its back control, iOS swipe, Android back, browser back; lesson 2026-11-25).

### T16. Settle up, Who paid what, Record a payment (product-engineer) — Wave 3, after T4, T6, T10
Files: new `app/(app)/groups/[id]/settle.tsx`, `app/(app)/groups/[id]/balances.tsx`, `components/GroupPaymentForm.tsx`, `__tests__/groupSettle.test.tsx`. ~300 lines (may land as two commits).
- Settle: the viewer's card first ("You owe Dee $174.97" · **Pay Dee $174.97 on Venmo** · "@dee-1 · $174.97" · then "Did you pay Dee?" with **I paid** recording the opened amount; or for a creditor a list of who pays them, each with "Request $130.02" (secondary) and a quiet "Got paid another way"); then "Suggested payments" for everyone (text "Cy pays Dee $174.97", no arrow glyph); a "Who paid what" link; "Record a payment" `TextLink`. 1 s double-tap guard on links. No Venmo for the other person → "Dee hasn't added Venmo yet. Pay another way, then record it."
- Who paid what: one row per member (Paid, Share, Payments, Net), tap to expand that person's costs; "Payments" list with Undo (inline confirm when someone else recorded it).
- Record a payment: "I paid" / "I got paid" segmented, the other person, amount, Save; the `over` warning needs a second tap ("Save anyway").

### T17. Bills and groups (product-engineer) — Wave 4, after T5, T9, and splitit-app-92's merge
Files: new `app/(app)/bills/[id]/group.tsx` (host: "Add to a group", lists the host's groups, shows "Invite Sam to Tahoe trip first" when participants aren't members, confirm "Ben's "I paid" will become a Tahoe trip payment" when marks exist; and "Take out of Tahoe trip" when allowed), `components/BillGroupLine.tsx`, `__tests__/billGroup.test.tsx`; edit `app/(app)/bills/[id]/index.tsx` and `app/(app)/bills/[id]/settle.tsx` (**shared — coordinate with splitit-app-92**), edit `lib/scanSession.ts` and `app/(app)/bill.tsx` (**shared — coordinate**: "Add receipt" from a group stores the group id with the scan session; after `create_bill` succeeds the form calls `attach_bill_to_group`; if that fails the bill opens with "Couldn't add it to Tahoe trip. Try again." and a retry). ~300 lines.
- On a group bill: a line under the title "In Tahoe trip" (tap → group); the bill's invite card replaced by "Invite people to Tahoe trip" (opens `GroupInvite`); the footer and Settle screen show "Settled in Tahoe trip" with a link, and no Pay / I paid / Request / payer marks anywhere on that bill.

### T18. "Who had this?" in group bills (product-engineer) — Wave 4, after T7, T11, T17
Files: edit `components/ItemSheet.tsx` (**shared — coordinate**; new optional `assign` prop only, behaviour unchanged without it), edit `app/(app)/bills/[id]/index.tsx` (**shared — coordinate with splitit-app-92**), new `components/AssignChips.tsx`, `__tests__/assignItem.test.tsx`. ~250 lines.
- In the item sheet of a group bill, a section "Who had this?" with one chip per member (avatar + first name; `accessibilityRole="checkbox"`, checked state, label "Ben, had this" / "Ben, didn't have this"). Each tap is one `assign_item` with the map the sheet shows as `p_expected`; that chip is busy until the write and its refetch finish; `claims_changed` → refetch and "Someone changed this item. Check and try again."; a failed refetch re-enables the chips with Try again. The existing parts stepper ("Change split") is offered to any member on group bills and saves through `assign_item`.
- Non-group bills: the sheet renders exactly as today (no chips; stepper only for claimers).

### T19. Docs (docs-writer) — last, after every task it describes
Files: `docs/learning/decisions/0022-groups.md` (fill the stub: context, decision, alternatives, consequences; amends 0015 (per-bill settling off inside groups) and 0021 (early settling and differences don't apply to group bills; marks become payments); records the claims convention change U-G6, the one-sided rules C-G1–C-G3, and the triggers of GR-10), `docs/learning/decisions/README.md` (row status), `docs/learning/decisions/0015-…md` and `0021-…md` ("Amended by 0022" in their status lines only), new `docs/learning/concepts/group-balances.md` (net balance, why Σ = 0, greedy simplification and why it may route payments between people who didn't share a cost, the fully-claimed rule, the worked example), `docs/learning/concepts/people-and-membership.md` (groups and L1), `docs/learning/concepts/row-level-security.md` (co-member profile reads; assignments as a definer-only write), `docs/before-production.md` (items in Risks below), and a proposal file `docs/proposals/2026-11-26-claude-md-group-claims.md` with the wording below for the retro/user. The docs-writer reports each bullet as done or skipped.

**Proposed `CLAUDE.md` wording** (for the user to approve; not applied by any agent): in § Conventions, replace "Only participants can read a bill; only the host edits line items; users write only their own claims." with "Only participants can read a bill; only the host edits line items; users write only their own claims, except on a bill in a group, where any group member may set who had an item through `assign_item` (logged as "Ana assigned Tacos to Ben"; ADR 0022)."

*Note (2026-11-27, T19 docs-writer):* the proposal file is `docs/lessons/proposals/2026-11-27-groups-claude-md.md`, not the `docs/proposals/2026-11-26-claude-md-group-claims.md` named above (the coordinator's path; all proposals live in `docs/lessons/proposals/`).

### Waves (what can run at once)

| Wave | Tasks (parallel within a wave) | Waits for |
|---|---|---|
| 0 | T0 (review) ∥ T1 (G0 spike) | — |
| 1 | T2 ∥ T8 ∥ T9 ∥ T11 | T0's Amendment A1; T11 also waits for the owners of `lib/activityText.ts` / `lib/people.ts` to be idle (check `git status`) |
| 2 | T3 → T4 → T5 → T6 → T7 (one after another: one local DB) ∥ T10 | **Every Groups migration's timestamp is after `20261126080844_sent_via_venmo.sql` (agreed with splitit-app-92; A1, B1).** T5 also waits for that SV migration to be merged and applied locally. T10: T1 PASS (and T1's A1 follow-ups) and T9 |
| 2b | T12 | T2–T7, T9 |
| 3 | T13 ∥ T14, then T15 ∥ T16 | T13: T2, T9; T14: T6, T10; T15: T3, T8; T16: T4, T6, T10. Also splitit-app-96 done with `app/(app)/index.tsx` (T13) |
| 4 | T17, then T18 (both edit the bill screen) | splitit-app-92's merge; T5, T7, T11 |
| 5 | QA, then T19 | everything |

Planned breakage: none across tasks (new files). If T11's `ActivityEvent` kind union change breaks a fixture in another session's test, T11 updates it and reports it.

---

## Acceptance criteria

Each is checked by a test, a pgTAP assertion, a grep, a live run, or a **User check** (needs a person; QA lists those "for the user", not partial). pgTAP filters to its own fixture rows (never whole-table counts). "Unchanged" timestamp checks first backdate the value (lesson 2026-11-25).

### T1 · balance and simplification
1. `lib/groupBalance.test.ts` reproduces W1–W5 exactly (nets and the per-person paid/share/sent/received columns), and Dee's Dinner share is 0 in each.
2. W2: with one Dinner row unclaimed, `waiting` holds Dinner with `reason: 'incomplete', unclaimedRows: 1`, and no member's paid or share includes any Dinner cents (Ana's paid is 24000, not 31733).
3. A proportional bill with every row $0.00 and total 500, all claimed, is `waiting` with `reason: 'all_zero'` and adds nothing; an even-split bill that's complete counts; an even-split bill with one row unclaimed doesn't.
4. Degenerate cases each give Σ net = 0 and the expected result: one member and no costs (all nets 0, no suggestions); every member at $0; a bill with a negative share (claimed discount bigger than items); a member in no cost at all (net 0); a three-way tie of creditors and of debtors (order by user id).
5. Property test, 1,000 seeded random groups (2–10 members; 0–8 bills in both extras modes with claimable discounts, negative shares, incomplete and all-$0 bills; 0–8 expenses; 0–6 payments): Σ net = 0; `simplify`'s full list preserves every net and has ≤ (non-zero nets − 1) payments; shuffling members, bills, expenses, payments and each bill's rows/claims gives identical nets and identical suggestions; the leftover bound of C-G3 step 4 holds; no shown suggestion ≤ `GROUP_IGNORE_CENTS`. Seed printed on failure.
6. (Amended by A1, S2.) `simplify` on {Ana +1, Ben −1} shows no suggestion and the full list has one 1¢ payment; on {Ana +2, Ben −2} it shows one 2¢ payment; on {Ana +1, Ben +1, Cy −2} it shows **both** 1¢ payments (Cy's |net| is 2); on {Ana +1, Ben +1, Cy +1, Dee −3} it shows all three; `isSettledUp` is true for −1, 0, +1 and false for ±2.
7. `groupBalances` throws RangeError for a non-integer or unsafe amount anywhere in its input (never returns a number), with a test per input kind.

### T2 · groups core (pgTAP `groups.test.sql`)
8. Every new table has RLS enabled; `anon` has no privilege on any of them; `authenticated` has exactly SELECT on `groups`, `group_members`, `group_events` and nothing on `group_hidden`; a direct INSERT, UPDATE or DELETE by `authenticated` on any of them fails with 42501.
9. A non-member selecting `groups`, `group_members` or `group_events` for a group gets 0 rows; every function called by a non-member raises 42501 `not_allowed`; `anon` can't execute any of them (42501).
10. `create_group` with names of 0, 1, 60 and 61 code points (and 60 emoji): 0 and 61 → 22023 `invalid_name`; the others succeed, the caller is the only member, one `group_created` event.
11. `join_group`: a bad code → P0002 `invalid_code`; a good code adds the caller once and logs one `member_joined`; a second call adds nothing and logs nothing.
12. Profiles: a co-member who shares no bill can select another member's `display_name, venmo_username` (named columns); a non-member stranger gets 0 rows; `select *` on profiles still fails with 42501 for everyone.
13. `rename_group` and `rotate_group_code` work for any member and log one event each (`renamed` {from, to}; `link_rotated` {} without the code); the old code then fails `join_group`.
14. `set_group_hidden(true)` then `my_groups()` shows `hidden = true` for the caller only; another member's `my_groups()` shows `hidden = false`; no `group_events` row and no change to `groups` or `group_members` rows (checked against backdated values).
15. `group_events` is append-only: UPDATE, DELETE and TRUNCATE fail for every role; two events from one call come back in insertion order by `seq`.

### T3 · expenses (pgTAP `group_expenses.test.sql`)
16. `private.allocate` returns A1–A9 exactly and refuses A10; `add_expense` with method equal stores those cents for A1–A8, one row per chosen user including $0 rows (A3).
17. `add_expense` / `edit_expense` with exact payloads X1–X8 give the DB column of the C-G5 table.
18. C-G6 boundaries: title 0 / 101 code points and amount 0 / 100,000,000 → 22023 `invalid_expense`; title 1 / 100 and amount 1 / 99,999,999 succeed; a payer or share user who isn't a member → 22023 `not_member`.
19. Retry: `add_expense` twice with the same id and content → one expense, one `expense_added`; same id with a different amount → 22023 `id_conflict`.
20. `edit_expense` by a member who is neither creator nor payer → 42501; by the creator or the payer → succeeds, `version` + 1, one `expense_edited` with before/after; with a stale `p_expected_version` → 22023 `version_changed`; with identical fields → no write and no event (`edited_at` unchanged after backdating).
21. `delete_expense` soft-deletes (row kept with `deleted_at`, `deleted_by`), logs one `expense_deleted`, a repeat is a no-op; `group_snapshot` (once T6 lands) omits it.

### T4 · payments (pgTAP `group_payments.test.sql`)
22. `record_payment` C-G7 boundaries: cents 0 / 100,000,000 → 22023 `invalid_amount`; 1 / 99,999,999 succeed; from = to → 22023 `invalid_payment`; a non-member party → 22023 `not_member`; caller neither from nor to → 42501; source `'bill_mark'` from a client → 22023 `invalid_payment`.
23. Same id + same content twice → one row, one `payment_recorded`; same id, other cents → 22023 `id_conflict`.
24. `undo_payment` by from or to succeeds once (soft), logs one `payment_undone`; a third member → 42501; a repeat → no-op.

### T5 · bills in groups (pgTAP `group_bills.test.sql`)
25. `attach_bill_to_group` by a non-host → 42501; to a group the host isn't in → 42501; a bill with a participant who isn't a member → 22023 `participants_not_members`; a bill already in a group → 22023 `already_in_group`.
26. Attach W5: the brunch bill with Cy's mark of 950 to payer Ben → after the call `group_id` is set, every member is a participant (`added = false`), Cy's `settled_at` and `settled_cents` are null, one `group_payments` row {from Cy, to Ben, 950, `bill_mark`, bill_id}, one `bill_added` {converted: 1} group event, one `moved_to_group` bill event, and no `participant_added` / `joined` bill events.
27. (Amended by A1, B3.) On a group bill no call ever leaves a mark: `mark_paid`, `settle_difference` and `unmark_paid` (whatever their signatures after Sent via Venmo) each raise one of {`in_group`, `mark_changed`, `not_complete`, `all_zero`} or are a no-op, and no participant row changes (`settled_at` backdated first so a rewrite would show). `mark_paid` on a **complete** group bill raises 22023 `in_group`. A postgres-role `UPDATE` setting `settled_at` on a group bill's participant row raises 22023 `in_group` (the trigger tested directly). On a non-group bill they behave as before (the existing `settle_marks`, `settle_early`, `settle_difference` and SV pgTAP files pass unchanged).
28. On a group bill, `join_bill` by a non-member → 22023 `in_group`; `add_participant`, `remove_participant` and `leave_bill` for a member → 22023 `in_group`.
29. `join_group` on a group with 2 bills adds the joiner to both bills (`added = false`) with no bill events; the joiner can then select both bills' rows and claims.
30. `detach_bill_from_group` with a live `bill_mark` payment from that bill → 22023 `has_bill_payments`; after `undo_payment` it succeeds, `group_id` is null, participants stay, events logged on both sides.
31. `leave_group`: refused with 22023 `cannot_leave` for each history kind alone (hosts a group bill; pays a group bill; one claim on a group bill; payer, creator or share user of an expense, deleted included; from, to or recorder of a payment, undone included; the last member); allowed with none, deleting their membership and participant rows and logging one `member_left`; no other member's claims, shares or payments change.
32. `my_bills()` no longer lists a bill once it's in a group and lists it again after detach; its columns and order are otherwise unchanged (the existing `bill_markers` pgTAP passes).
33. `people_i_split_with()`: two co-members with no shared bill each see the other with `shared_bills = 0`; a stranger doesn't appear; after leaving the group (no shared bills) they no longer appear.
34. (Amended by A1, B2.) The migration headers (T2 states the rule; T3–T7 each list their paths) give the lock order for every new function and trigger, implicit FK locks included, with the `leave_group` × `edit_expense` deadlock (A1.B2a) as the worked example. The four paths are: (a) membership-changing functions (`join_group`, `leave_group`, `attach_bill_to_group`, `detach_bill_from_group`) take the group row **FOR NO KEY UPDATE** first; money writes (`add_expense`, `edit_expense`, `delete_expense`, `record_payment`, `undo_payment`) take no explicit group lock, and `leave_group` maps 23503 from its `group_members` delete to 22023 `cannot_leave`; (b) `join_group` and `attach_bill_to_group` both hold the group lock before reading members or bills; (c) `detach_bill_from_group` reads `bills.group_id` unlocked, locks the group, then the bill FOR UPDATE, then re-checks `group_id`; `attach` locks the group, then the bill FOR UPDATE; (d) `leave_group` locks the group, then **all** the group's bills FOR UPDATE in ascending id, then checks history, then deletes `group_members`, then participant rows. The pgTAP files check each function body takes its locks in that order (as `people_review_fixes.test.sql` does), and after `attach_bill_to_group` every member is a participant.

### T6 · snapshot (pgTAP `group_snapshot.test.sql` + live size check)
35. `group_snapshot` returns exactly the C-G11 keys and orders for a fixture group with 2 bills, 2 expenses (1 deleted) and 2 payments (1 undone); deleted and undone rows are absent; a non-member → 42501.
36. The snapshot never contains a non-member's id or a bill outside the group, and holds no email or other profile column.
37. Size spike (live, recorded in the T6 report): a seeded group with 40 bills × 30 rows × 6 claimers returns in one call with every row present (row count in the payload = seeded count, so `max_rows` doesn't cut it; verify; reword if PostgREST treats the function differently), with payload size and latency written down. Starting budget: under 1 MB and under 1 s locally.

### T7 · assigning items (pgTAP `assign_item.test.sql`)
38. On a group bill, member Ana calls `assign_item(tacos, {Ben: 1}, {})` → one claim for Ben, one `assigned` event with actor Ana and `details.user_id` Ben; no `claimed` event.
39. Ben then calls `assign_item(tacos, {}, {Ben: 1})` → claim gone, one `unclaimed` event with actor Ben (it was his own claim); Cy calls `assign_item(tacos, {Ana: 2, Ben: 1}, {})` on a fresh row → two `assigned` events (Ana, Ben).
40. Changing only parts for people who stay → one `split_changed`; identical maps → no write, no event.
41. Stale `p_expected` → 22023 `claims_changed` and nothing changes; `p_parts` with a value of 0, 21, 1.5 or "2", or duplicate keys → 22023 `invalid_parts`.
42. 42501 `not_allowed` for: a non-group bill (even for its host); a caller who isn't a member of the bill's group; a target key who isn't a member; `anon`. The three "can't see it" cases give the same error.
43. Non-group bills: `set_claim` still writes only the caller's claim; a direct INSERT or DELETE of another user's claim through the Data API still fails (RLS); the existing `bills_rls`, `item_split` and `claimable_discounts` pgTAP files pass unchanged.
44. `set_claim` by a member on a group bill logs `claimed` with actor = the member (unchanged wording path).

### T8 · expense form logic
45. `lib/groupExpense.test.ts` runs the A1–A10 table through `equalPreview` (and `allocate`) and the X1–X7 table through `exactCheck` / `validateExpense`, matching the lib column exactly; X5 and X7 are `invalid`, never `adds_up`.
46. `expensePayload` never emits a 0 or a blank person (property over 500 random drafts), and for every valid draft its output passes the same C-G5 / C-G6 check the DB applies (the test reimplements nothing: it asserts the payload's shape and Σ against the C-G5 table).

### T9 · data layer
47. Every wrapper maps each DB error code named in T2–T7 to its `GroupError`, and unknown codes to `network` (one test per code with the fake client).
48. `fetchGroupSnapshot` parses the C-G11 fixture and returns `network` for each of: a missing key, a non-uuid id, a non-integer or out-of-range amount, a claim on a row of another bill, a payment party who isn't a member.
49. Every client read in `lib/groups.ts` names its columns. Grep: `grep -rnE "select\(\s*\)|select\('\*'\)" lib/groups.ts` prints nothing. (Not run: the file doesn't exist yet. Today the same pattern over `lib/` matches nothing, checked with the Grep tool. The implementer first shows the pattern finds a planted `select('*')` in a scratchpad copy.)
50. `postSignInRoute('g-0123456789abcdef0123')` → `/g/0123456789abcdef0123`; bill codes still resume to `/b/<code>`; a malformed `g-` code → `/`.

### T10 · view models
51. `groupScreen` on W1 for Ana gives "You're owed $130.02"; for Dee "You're owed $181.64"; for Cy "You owe $174.97"; on W2 it lists "Your receipt: Nachos left to claim" for Ana and "Ana's receipt: Nachos left to claim" for others (A1, S9: 1–2 rows left are named); "You're settled up" exactly when `isSettledUp(net)` (A1, S2), and on W2 the Settle model carries the notice "Balances don't include Ana's receipt yet: Nachos left to claim" (A1, S1).
52. `groupSettle` on W1 gives the three suggestions of W1 in order; Cy's card is Pay Dee $174.97 with `venmoPayUrl({ username: dee's, cents: 17497, itemNames: ['Tahoe trip'] })`; Ana's card lists Ben with Request $130.02; with `GROUP_VENMO_NOTE_INCLUDES_NAME` false the note is plain "SplitIt".
53. **(Superseded by A2: see criteria 119–121.)** After Pay is opened for (Dee, 17497) and the snapshot changes so Cy owes Dee 17000, the "Did you pay Dee?" step stays and I paid records 17497 (the amount opened; contract O, ADR 0021 §6); it goes away if Dee is no longer someone Cy pays (lesson 2026-11-25: key on the facts that make it true).
54. `recordPaymentCheck`: 0 and 100,000,000 invalid; 1 ok; 17498 against a suggestion of 17497 → `over` with the copy above.
55. Every templated sentence in `lib/groupSettleView.ts` and `lib/groupActivityText.ts` is tested with a count of 1 and with the viewer as each name it takes ("You paid Dee", "Dee paid you", "You moved…", "1 person owes you").
56. Screens do no money arithmetic: `grep -rnE "Cents\s*[-+*/]|[-+*/]\s*\w*Cents\b" "app/(app)/groups" components/Group*.tsx components/AssignChips.tsx components/BillGroupLine.tsx` prints nothing. (Not run: paths don't exist yet; QA first shows it matches a planted `aCents - bCents` in a scratchpad copy.)

### T11 · small lib edits
57. Activity sentences of T11 render exactly as listed, including the viewer as actor and as target, and a deleted account as "Someone"; existing activityText tests pass unchanged.
58. `personCaption` for `shared_bills: 0` is "In a group together"; captions for 1 and 4 bills are unchanged.
59. `toggleAssignee` keeps other people's parts, adds a new person at 1, removes a person cleanly, and never returns parts outside 1..20.

### T12 · live reconciliation
60. The live run (4 throwaway local users) passes every row of C-G4, C-G5, C-G6, C-G7 and C-G8 with the same answer from `lib/` and the DB, and W1–W5 built through the real functions give the T1 nets when the snapshot is fed to `groupBalances`. Report counts (e.g. "64/64").
61. The live run includes: a non-member reading the snapshot (42501), a non-member calling `assign_item` (42501), a member assigning on a non-group bill (42501), and a co-member reading `profiles.venmo_username` with named columns.

### T13 · Home and joining
62. Home with 2 groups (1 hidden) shows one group row ("Tahoe trip", "4 people"), a "New group" link and "Show hidden groups (1)"; with no groups it shows only "Start a group"; the existing Home tests pass unchanged.
63. Creating a group with a blank or 61-character name shows the field error and sends nothing; a valid name calls `create_group` once (double tap sends once) and lands on the group screen.
64. `/g/<code>` signed out saves `g-<code>` and goes to sign-in; after sign-in the resume effect (the only navigator) lands on `/g/<code>`, which joins and replaces with `/groups/<id>`. Tested on native and web, including landing on `/` after the web OAuth redirect (lesson 2026-11-24).
65. **User check:** on web with two Google accounts (two browsers), create "Test trip" in one, open its link in the other, sign in, and see the group with 2 people. Then open the QR on the first and scan it with a phone camera (phone needs the hosted project or the Mac's LAN IP with matching OAuth redirect URLs; otherwise mark blocked).

### T14 · group screen
66. With W1 data the screen shows the status line, one primary Settle up, no waiting lines; with W2 it shows "Ana's receipt: Nachos left to claim" as a link to the bill (A1, S9); the cost rows show "Ana paid $77.33" and the viewer's share.
67. Leave appears only when `canLeave`; tapping it asks inline; a DB `cannot_leave` shows "You can't leave this group because you're part of its costs. You can hide it instead." and offers Hide.
68. After a write whose refetch fails, controls are enabled and "Couldn't refresh. Try again." shows with a working retry (test).
69. Every interactive element has an `accessibilityLabel`; the screen has exactly one header-role title; the status line's label reads the amount in words the screen shows.

### T15 · expense screen
70. Equally with 4 members and $240.00 previews $60.00 each; with $1.00 among 3 previews $0.34/$0.33/$0.33 in member id order (preview from `equalPreview`, not computed in the component).
71. Exact with one field $0.01 over shows "Off by $0.01" and Save is disabled; fixing it shows "Adds up" and Save sends exactly `expensePayload`'s JSON.
72. Edit as a member who is neither creator nor payer: fields read-only and no Delete; as creator: Delete asks inline, then `delete_expense` with the loaded version; `version_changed` → "Someone just changed this expense. Check it and try again." and a refetch.
73. Leaving with unsaved input asks first on the back control, iOS back-swipe, Android back and browser back (or the report says per path why not, with a test where possible).

### T16 · settling
74. **(Superseded by A2: see criteria 119–123.)** Cy (W1) sees "You owe Dee $174.97", **Pay Dee $174.97 on Venmo** opens the C-G3/T10 URL once per 1 s, then "Did you pay Dee?" with I paid → `record_payment` with a new uuid, from Cy, to Dee, 17497, `'venmo'`; a retry after a network error reuses the same uuid.
75. (Amended by A2.) Ana sees Ben's row with "Request $130.02"; "Got paid another way" records Ben → Ana 13002 with source `'manual'` and method `'other'` after an inline confirm.
76. Record a payment with $175.00 to Dee shows the over warning and needs "Save anyway"; with $100.00 it saves and the new suggestion (W3) shows after refetch.
77. Who paid what lists all members with Paid / Share / Payments / Net summing to $0.00 (the sum line comes from the view model); Undo on a payment someone else recorded asks inline; Undo on your own doesn't.
78. No glyph icons in the new screens: `grep -rnE "[✓✔▾▴›‹⚠→]" "app/(app)/groups" components/Group*.tsx components/AssignChips.tsx components/BillGroupLine.tsx` prints nothing, comments included. (Not run: paths don't exist yet. Today the same pattern matches comments in `components/TipOptions.tsx`, `components/ui/BackHeader.tsx` and `components/ui/ToneIcon.tsx`, which are outside these paths.)
79. **User check (needs a phone with Venmo, and the phone reaching Supabase as in 65):** in a test group, tap Pay on a $0.01 suggestion, check Venmo opens with the recipient, $0.01 and the note "SplitIt: <group name>" (a name with an emoji too), don't send; come back and record I paid.

### T17 · bills and groups
80. On a group bill: the "In Tahoe trip" line shows; the bill's own invite card, Pay, I paid, Request and payer marks are absent, and their absence is asserted in a render where the item list is present (lesson 2026-11-25); Settle shows "Settled in Tahoe trip" linking to the group. Non-group bills render as before (existing bill and settle tests pass unchanged).
81. Add to a group: a bill with a non-member participant shows "Invite Sam to Tahoe trip first" and no confirm button; a bill with marks shows the conversion confirm naming each marked person; success lands on the bill showing the group line.
82. "Add receipt" from a group → Enter items → save creates the bill and attaches it (two calls); if the attach fails, the bill opens with the error and a retry that attaches it; a stored group id is cleared on sign-out (test).
83. **User check:** host a bill with a friend, have the friend mark "I paid", move it into a group, and see the payment in the group's Settle screen and Activity.

### T18 · assigning in the item sheet
84. On a group bill the sheet shows "Who had this?" with one chip per member (viewer first); tapping Ben sends `assign_item(row, {…current, Ben: 1}, current)` once; the chip is busy until the refetch lands; on `claims_changed` it shows the fixed copy and refetches.
85. On a non-group bill the sheet has no chips (asserted with the claimers list present) and the stepper shows only for claimers, exactly as before.
86. Chips have `accessibilityRole="checkbox"`, checked state, and labels "Ben, had this" / "Ben, didn't have this".
87. **User check:** in a group bill on two devices, assign Tacos to the other person from the first device; on the second, the item shows as theirs and the bill's Activity reads "<name> assigned Tacos to you".

### T19 · docs
88. ADR 0022 is filled in (Status Accepted, amends 0015 and 0021), its README row is updated, 0015 and 0021 say "amended by 0022", and the concept note exists with the worked example; `docs/before-production.md` has every item in Risks marked "before-production"; the proposal file holds the `CLAUDE.md` wording above. The docs-writer reports every T19 bullet.

### Whole slice
89. `npm run typecheck` passes; `npm test -- --maxWorkers=4` passes (failures only in files another session is editing are reported as such); `npm run db:test` passes.
90. No secret in the web build: after `npm run export:web` (into a fresh build), `grep -rE "service_role|sb_secret_" dist/` prints nothing except the expected Tesseract CDN note (CLAUDE.md).

---

## Risks and open questions

Decisions are logged in `docs/decisions-to-review.md` § "2026-11-26 · Groups" (GR-1 … GR-30, GR-A1 … GR-A9). The ones that need the user most:

**Money: needs your look**
- **GR-3** Suggestions of 1¢ or less are hidden (`GROUP_IGNORE_CENTS`, starting value 1), so a person can be left 1–2¢ off with "You're settled up" while "Who paid what" shows the exact cents. Alternative: 0 (every cent shown as a payment). Set to 0 by changing one constant.
- **GR-4 / GR-5** Equal splits give leftover cents to the lowest user ids (not to the payer); Exact amounts must add up to the cent (no ±1¢ like the bill form).
- **GR-9** A bill can leave a group only after any payments that came from its old "I paid" marks are undone. Alternative: allow it and leave those payments in the group.
- **GR-A1** Any member can assign, reassign or remove anyone's claim on a group bill (fits "A remembers what B got"; everything is logged and the assignee can change it). Alternative: only the assigner or assignee can change an assigned claim (needs an `assigned_by` column and more rules).
- **U-G3 consequence:** one unclaimed item holds a whole receipt out of every balance. With assignments, any member can finish it.

**Privacy: needs your look**
- **GR-26** Group money rows reference members with "restrict", so deleting an account that has group history fails until an account-deletion design exists. Before-production item.
- **U-G5 / GR-14** The group name in Venmo notes can be public on Venmo's feed. Kill switch `GROUP_VENMO_NOTE_INCLUDES_NAME`; before-production item.
- Members see every group bill's items and claims, including bills from days they weren't there (same as being on a bill today).

**Departs from CLAUDE.md (approved by the user for group bills only):** U-G6, "users write only their own claims". The wording change is proposed in T19 for the user to apply.

**Coordination risks**
- Sent via Venmo (SV-2) replaces `mark_paid` / `settle_difference`. T5's trigger keeps group bills unmarkable whichever signature exists (criterion 27 runs against the current ones). Both specs widen `bill_events_kind_known`: whichever lands second re-reads the latest list.
- Lock order: T5 adds paths that lock a group and then many bills. The two deadlocks already found in this repo were implicit FK locks; T0 and the code review list each path's locks.

**Before-production items (T19 adds them):** account deletion with group history (GR-26); Venmo note with the group name (U-G5); `/g/*` in Universal Links / App Links (`lib/appLinks.ts`); group link rotation by any member (GR-23) and the join code being visible to every member; snapshot size on the hosted project's `max_rows` and payload limits (criterion 37); no Realtime on group screens (GR-21); `GROUP_IGNORE_CENTS` starting value (GR-3).

**Device checks:** every User check that needs Supabase from a phone (65, 79, 83, 87) needs the hosted project with these migrations applied, or the Mac's LAN IP with matching OAuth redirect URLs. Until one exists, those phone checks are blocked. The web parts can run against the local stack.

## Coordination note (2026-11-26, main session)
- splitit-app-92's `docs/specs/2026-11-26-sent-via-venmo.md` migration (`<ts>_sent_via_venmo.sql`) lands **before** T5 (`_group_bills`) and T7 (`_assign_item`). It re-creates `mark_paid` (new signature with `method`), `settle_difference` (`p_method`), adds `mark_not_received`, re-creates `my_bills()` (adds `seen_at`), widens `bill_events_kind_known` (`not_received`), and adds `bill_participants.settled_method`, `not_received_cents/_method/_by`. T5/T7 start from those latest definitions and the in_group refusal covers all of them. T2–T4 may land in either order.
- splitit-app-96's Home v2 (`docs/specs/2026-11-26-home-groups-v2.md`) owns `app/(app)/index.tsx` and `lib/homeSections.ts` (no "Your bills" list any more: Waiting on you / Owed to you / Settled). Group bills never reach Home's list (T5's `my_bills()` filters them in SQL; A1, S12), so T13 doesn't filter anything; it places GroupsSection after "Owed to you", before "Settled". T13 waits for 96's "done".
- Migration order: splitit-app-92 reserved `20261126080844_sent_via_venmo.sql`. **Every Groups migration (T2–T7) must have a timestamp later than 20261126080844**, so `supabase migration up` never applies an older file after a newer one.
- ~~Home filtering via `BillSummary.groupId`~~ **Superseded by Amendment A1 (S12):** T5's re-created `my_bills()` filters `where b.group_id is null` in SQL (it has `limit 20`, so group bills must not use up that budget). `my_bills()` returns the same columns as SV's version; there is no `BillSummary.groupId` and no `parseSummary` change. The coordinator tells splitit-app-96. 96 leaves a GroupsSection slot between "Owed to you" and "Settled". ADR 0023 is reserved by splitit-app-96 ("several payers").

---

## Amendment A1 (2026-11-26, from T0)

Source: `docs/specs/2026-11-26-groups-mvp-eng.md` (staff-engineer review). **Adopted:** every blocking item (B1–B4), every should-fix item (S1–S15), and nits N1, N2, N3, N4, N6, N7, N9. **Not adopted:** N5 (logged only as GR-N5); N8 (detach stays in scope). Where this amendment and the body disagree, **this amendment wins**. Criteria 6, 27, 34, 51 and 66 and C-G3 were edited in place (marked "Amended by A1"). New criteria are 91–112. Decisions are logged as GR-S1, GR-S2, GR-S11, GR-N3, GR-N5 in `docs/decisions-to-review.md`.

### A1.1 Sequencing with Sent via Venmo (B1)
- Every Groups migration (T2–T7) has a timestamp later than `20261126080844_sent_via_venmo.sql` (agreed with splitit-app-92). **T5 waits for that SV migration to be merged and applied locally.**
- `attach_bill_to_group` clears **every** mark column on the latest schema: `settled_at`, `settled_cents`, `settled_method` and the three `not_received_*` columns, so SV's check constraints hold and no stale "hasn't received" line survives the move.
- T5 re-creates `my_bills()` from **SV's version** (keeps `seen_at` and every column; drop and recreate if the returned columns require it) and adds only `where b.group_id is null` (S12).
- If SV's Task 1 grep (statements writing `settled_cents = null`) runs after T5, it must keep `attach_bill_to_group` intact; noted for splitit-app-92.

### A1.2 Lock order (B2)
Criterion 34 (rewritten) is the rule. In short: membership-changing functions (`join_group`, `leave_group`, `attach_bill_to_group`, `detach_bill_from_group`) take the group row **FOR NO KEY UPDATE** first. Money writes take no explicit group lock. Bills are locked **FOR UPDATE** in attach, detach and leave so a mark can't land between reading and clearing marks. `leave_group` locks all the group's bills in ascending id **before** deleting anything, and maps 23503 from its `group_members` delete to `22023 cannot_leave`. T2's header notes that `rotate_group_code` changes a unique column (implicit FOR UPDATE on the group row, which waits for FK inserts; no cycle). The T2 header's worked example is the `leave_group` × `edit_expense` deadlock this avoids.

### A1.3 Activity kinds (B4)
**T5** widens `bill_events_kind_known` with `moved_to_group` and `removed_from_group`. **T7** adds `assigned` and `unassigned`. Each starts from the latest list on disk (SV adds `not_received`; ADR 0023's work may add more).

### A1.4 Money (S1, S2, S9) — Money: needs your look
- **S1 (GR-S1).** (a) While any group bill is waiting, the Settle screen (and the group screen's waiting lines) shows a notice above the suggestions: "Balances don't include Hana's receipt yet: 2 items left to claim" (one line per waiting bill, from the T10 view model). (b) `attach_bill_to_group` refuses a bill that **has marks** and is incomplete or all-$0: `22023 not_complete` ("Finish claiming before moving it into the group."). It uses `private.bill_is_complete` / `private.bill_all_zero`. This is a deliberate DB check about moving bills, not a DB copy of C-G1. A bill with no marks can still move in while incomplete. (c) T1 gets W7 (below).
- **S2 (GR-S2).** C-G3 steps 3–5 (edited in place): a payment is hidden only if it's ≤ `GROUP_IGNORE_CENTS` **and** both people's |net| ≤ `GROUP_IGNORE_CENTS`; `isSettledUp(net)` is the single predicate for status line, Settle and criteria.
- **S9.** An unclaimed $0 row or discount row keeps a receipt waiting (C1 unchanged for groups, so the bill screen and the group agree). The waiting line links to the bill; with 1 or 2 rows left it names them ("Hana's receipt: Water left to claim", "Hana's receipt: Water and Happy hour left to claim"); with 3 or more it uses `footerIncomplete`'s count. Risks gains this bullet.

### A1.5 T1 follow-ups (T1 is built and passing; exactly what T1 must change)
Files: `lib/simplify.ts`, `lib/simplify.test.ts`, `lib/groupBalance.ts`, `lib/groupBalance.test.ts`, `test-utils/groupFixtures.ts`.
1. **S2:** the two-sided hide rule (C-G3 step 3) and `export function isSettledUp(netCents: number): boolean`; criterion 6 as amended; criterion 5's leftover property becomes "each leftover ≤ `GROUP_IGNORE_CENTS`".
2. **S6:** `groupBalances` checks Σ net = 0 before returning and throws `RangeError` otherwise (test with a corrupted input, e.g. an expense whose shares don't sum to its amount passed in directly).
3. **W7** fixture and test (S1c, below).
4. **S9** cases in criterion 4's degenerate list: a complete-looking Dinner with an extra unclaimed "Water" $0.00 row, and one with an unclaimed claimable discount row; both are `waiting` with `reason: 'incomplete'`.
5. **S1 notice data:** each `waiting` entry also carries `unclaimedRowIds: string[]` (in row order) so T10 can name 1–2 rows and build the notice. (Names come from the snapshot, A1.7.)

**W7** (add to the worked-example table): W1 with all three suggestions recorded (Cy→Dee 17497, Ben→Ana 13002, Ben→Dee 667), then Cy unclaims the nachos, so Dinner stops counting. Nets: **Ana −4725, Ben +2749, Cy +1976, Dee 0** (Σ 0). Shown suggestions: **Ana→Ben 2749; Ana→Cy 1976**. `waiting` = [Dinner, incomplete, unclaimedRowIds = [nachos]]. Notice for Ana: "Balances don't include your receipt yet: Nachos left to claim"; for others: "Balances don't include Ana's receipt yet: Nachos left to claim".

### A1.6 Retries and re-checks (S3, S4)
- `assign_item`: if the current map already equals `p_parts`, return success (no write, no event) **before** the stale-token check. After `private.lock_bill_key_share`, re-read `bills.group_id` and the caller's and every target's membership (42501 `not_allowed` if any changed); map 23503 to 22023 `claims_changed`.
- `edit_expense`: if the stored fields already equal the requested ones, return success before comparing versions.
- `attach_bill_to_group`: same group → no-op success; another group → `already_in_group`.
- `create_group(p_id, p_name)`: client-generated id; same id + same name → no-op returning the id; same id, different name → 22023 `id_conflict`. (T9's wrapper generates the uuid once per tap and reuses it on retry.)
- C-G7 (and add_expense): reusing the id of an undone payment or deleted expense returns success and the row **stays** undone/deleted. The client makes a new uuid for every new intent.

### A1.7 Snapshot shape and checks (S5, S6) — replaces C-G11's `rows` and `claims`
- Each bill's `rows` are `{ "id", "total_cents", "kind", "name", "claims": { "<uid>": parts } }` in `group_position, unit_index` order, where `name` is **null unless the row has no claim** (needed only for S9's naming). The bill-level `claims` array is removed. `group_position` and `unit_index` are not sent.
- `join_group` caps a group at **50 members**: 22023 `group_full`.
- T6 reports the measured payload size for the 40 × 30 × 6 fixture (expected ≈0.35–0.45 MB). T10 memoizes `groupBalances` per snapshot.
- Parser checks (fail closed with `network`), added to criterion 48: each expense's Σ `shares.cents` = `amount_cents`; each bill's `payer_id` and every claim's user is in its `participant_ids`; `participant_ids` equals the member set; every uuid is lowercase canonical.

### A1.8 Bill screen and error mapping for group bills (S7)
T17 also edits `lib/bills.ts` (`in_group` in `BillError` and `BILL_ERROR_COPY`: "This bill is in a group. Ask for the group's link."; `join_bill` maps it) and `app/b/[code].tsx` (shows that copy), both **shared — coordinate** (lib/bills.ts with splitit-app-92). On group bills T17 also hides Leave bill, Remove and Add people.

### A1.9 Schema (S8, S10)
- `group_members.user_id references profiles on delete restrict` (membership blocks account deletion until the person leaves; leaving needs no history).
- Composite FK `bills (group_id, payer_id) → group_members (group_id, user_id) on delete restrict` (MATCH SIMPLE, so non-group bills are unaffected). `set_payer` on a group bill therefore takes FOR KEY SHARE on the new payer's membership row after the bill row, consistent with A1.2.
- The T5 BEFORE DELETE trigger also passes when the bill no longer exists.
- `expense_shares` gets `group_id`; `expenses` gets `unique (id, group_id)`; FK `expense_shares (expense_id, group_id) → expenses (id, group_id)` and `(group_id, user_id) → group_members`.

### A1.10 Payment recording vs Sent via Venmo (S11; GR-S11)
The group MVP keeps contract O on purpose: Pay opens Venmo, then "Did you pay Dee?" → **I paid** records the amount opened. Groups don't auto-record on open. `source` has **one meaning in both specs**: who/how the user recorded it. `'venmo'` = the user recorded a payment they made through a Venmo link the app opened; `'manual'` = recorded through Record a payment or "Got paid another way"; `'bill_mark'` = converted from a bill mark. Nothing is written without a user's tap. Note for splitit-app-92: SV's `settled_method = 'venmo'` should keep that same meaning.

### A1.11 Other items
- **S13:** `GroupError` adds `invalid_payment`, `not_complete` and `group_full`; T9 notes that `invalid_code` is **P0002** (all other refusals are 22023 or 42501).
- **S14:** T5's header explains why the BEFORE INSERT trigger's unlocked read of `group_members` is safe (every inserting path holds a bill lock that conflicts with attach's FOR UPDATE and leave's bill locks; each plpgsql statement takes a new snapshot after waiting).
- **S15:** T14 hides "Add → Receipt" until T17 lands (T17 un-hides it and wires it); T5 waits for SV (A1.1); T7 re-runs the kind-pinning assertion (criterion 96).
- **N1:** T10's "Did you pay?" step is keyed on the recipient still being someone the viewer pays; the stored cents is what I paid records (criterion 53 unchanged).
- **N2:** `fetchGroupEvents` orders by `seq desc` only.
- **N3 (GR-N3):** C-G10's leave check ignores expense shares with `cents = 0` (a $0.01 equal split doesn't trap the two $0 people).
- **N4:** `rename_group` with the same trimmed name → no-op, no event.
- **N6:** a repeat `join_group` by a current member re-inserts any missing participant rows on the group's bills (no events).
- **N7:** after a detach, the bill shows on Home for every member who was added through the group (they stay participants). Added to GR-9's consequences.
- **N9:** the concept note (T19) explains that `set_payer` on a group bill moves money inside the group while old `bill_mark` payments stay with the old payer.

### A1.12 From T8 (built, 54 tests)
- **GR-T8-1 (confirmed):** C-G5 means: the form **leaves blank people out** of the payload, and a **typed $0** is refused with "Leave it blank if they don't owe anything" (X5). T8's behaviour is kept. **T15** shows that message under the field and never sends a 0.
- **GR-T8-6 (title trimming, C-G6 amended):** both sides trim the same characters. The DB trims with `regexp_replace(p_title, '^[[:space:]]+|[[:space:]]+$', '', 'g')` (POSIX space class: space, tab, newline, CR, VT, FF) and stores the trimmed title; the app sends `title.trim()` and its validator counts code points after the same trim. JS `trim()` also strips Unicode spaces (e.g. U+00A0, U+3000) that POSIX `[[:space:]]` may not (verify in the local Postgres; it depends on the database's locale). To make the two identical, T8 adds `normalizeTitle(s)` that trims only `[ \t\n\r\v\f]` from both ends, used by both the validator and the payload, and T3 trims the same six characters. The same rule applies to group names (C-G8, T2). New shared rows (lib and DB, C-G6/C-G8): a title of only `"\t\n"` → invalid on both sides; `"  Airbnb\t"` → stored as `"Airbnb"`; a title with a non-breaking space at the end keeps it on both sides.
- **GR-T8-2 (noted, not changed now):** `parseMoneyInput` caps typed amounts at $99,999.99 (`MAX_INPUT_CENTS`, `lib/money.ts`), while C-G6 allows up to $999,999.99. The form is stricter than the DB, which is safe (it can't send something the DB refuses). Raising the form's cap touches shared `lib/money.ts` and is a later change; added to `docs/before-production.md` by T19.

New criteria:
113. (T8 + T3, GR-T8-6) The shared rows above give the same answer in `lib/groupExpense.test.ts` and `group_expenses.test.sql` (and for group names in `groups.test.sql`); T12's live run includes them.
114. (T15, GR-T8-1) Typing $0.00 for a person in Exact shows "Leave it blank if they don't owe anything" and Save stays disabled; clearing the field removes them from the payload.

### Changed task list (A1)
| Task | Change |
|---|---|
| T1 | A1.5 follow-ups (S2 + `isSettledUp`, S6 Σ-net check, W7, S9 cases, `unclaimedRowIds`) |
| T2 | Lock rule header with B2's worked example; `create_group(p_id, p_name)` (S3); `rename_group` no-op (N4); `group_members.user_id` restrict (S8); timestamp after SV |
| T3 | `expense_shares.group_id` + composite FKs (S10); `edit_expense` equal-fields success (S3); no group lock in money writes (B2a) |
| T4 | No group lock (B2a); id reuse after undo stays undone (S3) |
| T8 | `normalizeTitle` trimming only `[ \t\n\r\v\f]` (GR-T8-6); $0 refusal kept (GR-T8-1) |
| T15 | The "Leave it blank…" message; never sends a 0 (GR-T8-1) |
| T2 / T3 (also) | Trim names and titles with the same six characters as `normalizeTitle` (GR-T8-6) |
| T5 | Waits for SV migration (B1); clears every mark column (B1); `my_bills()` from SV's version + group filter (B1, S12); lock order B2(a)–(d); `moved_to_group`/`removed_from_group` kinds + kind-pinning assertion (B4); attach refuses incomplete bills with marks (S1b); attach same-group retry (S3); payer FK and trigger "bill gone" pass (S8); member cap 50 and repeat-join repair (S5, N6); trigger race note (S14); leave ignores $0 shares (N3) |
| T6 | Snapshot shape A1.7 and size report (S5) |
| T7 | `assign_item` no-op before token, re-check under lock, 23503 → `claims_changed` (S3, S4); adds only `assigned`/`unassigned`; re-runs the kind assertion (B4) |
| T9 | `GroupError` + `invalid_payment`, `not_complete`, `group_full` (S13); parser checks (S6); `fetchGroupEvents` by `seq` (N2); `createGroup` uuid reuse on retry (S3) |
| T10 | Waiting notice + named rows (S1, S9); `isSettledUp` everywhere (S2); prompt keying wording (N1); memoized balances (S5) |
| T14 | "Add → Receipt" hidden until T17 (S15); waiting lines link to the bill (S9) |
| T17 | `lib/bills.ts` `in_group` + `app/b/[code].tsx` (shared); hide Leave/Remove/Add people on group bills (S7); un-hide "Add → Receipt" (S15); attach errors `not_complete` copy (S1b) |
| T19 | N7 in GR-9 consequences; N9 in the concept note; S9 risk; Sent via Venmo `source` meaning (S11) |

### New acceptance criteria (A1)
91. (T5, B1) Attaching a bill whose participant has an SV mark (`settled_method` set) and a `not_received_*` value clears all six mark columns and passes SV's check constraints; `my_bills()` still returns `seen_at` and every SV column, and excludes group bills.
92. (T5, S1b) `attach_bill_to_group` on a bill with a mark that is incomplete (or all-$0) → 22023 `not_complete`, nothing changes; the same bill without marks attaches.
93. (T5, S3) `attach_bill_to_group` twice to the same group → second is a no-op success with no new events or payments; to another group → 22023 `already_in_group`.
94. (T5, B2/N6) After `attach_bill_to_group`, every member is a participant; a repeat `join_group` by a member whose participant row on a group bill is missing (deleted as postgres in the fixture) restores it with no events.
95. (T5, N3) A member whose only history is a $0 equal share (A3) can leave; one with a $0.01 share can't.
96. (T5, re-run by T7, B4) A pgTAP assertion inserts (as postgres, inside the test) one `bill_events` row of **every** kind used anywhere in the migrations on disk (bill_created … paid_back, SV's `not_received` if present, `moved_to_group`, `removed_from_group`, and after T7 `assigned`, `unassigned`) and each succeeds.
97. (T5, S5) `join_group` on a group with 50 members → 22023 `group_full`.
98. (T5, S8) Deleting the profile of a group member fails (restrict) until they leave; `set_payer` on a group bill to a member works; the composite payer FK doesn't affect non-group bills (existing `settle_payer` pgTAP passes).
99. (T3, S10) An `expense_shares` row pointing at an expense of another group fails the composite FK (as postgres in the fixture).
100. (T3, S3) `edit_expense` retried with the old version and the already-saved fields succeeds with no new event; with the old version and different fields → `version_changed`.
101. (T4/T3, S3) `record_payment` with an undone payment's id and the same content returns success and the row stays undone; `add_expense` with a deleted expense's id likewise.
102. (T2, S3, N4) `create_group` retried with the same id and name returns the same id and creates one group; `rename_group` with the same trimmed name logs nothing.
103. (T7, S3/S4) `assign_item` retried with the same `p_parts` and an old `p_expected` succeeds with no write; after the bill is detached between calls, `assign_item` → 42501; a target removed by `leave_group` concurrently surfaces as `claims_changed`, never `network`.
104. (T6, S5) The snapshot's rows have exactly `id, total_cents, kind, name, claims`; `name` is null on every claimed row; the 40 × 30 × 6 fixture's payload size and latency are in the T6 report.
105. (T9, S6) `fetchGroupSnapshot` returns `network` for: an expense whose shares don't sum to its amount; a payer not in `participant_ids`; `participant_ids` ≠ members; an uppercase uuid.
106. (T9, S13) `invalid_payment`, `not_complete` and `group_full` map to their `GroupError`s; `P0002 invalid_code` maps to `invalid_code`.
107. (T1, S6) `groupBalances` throws `RangeError` when its input makes Σ net ≠ 0.
108. (T1, W7) W7's nets and shown suggestions are exactly as in A1.5, with Dinner in `waiting` and `unclaimedRowIds` = [the nachos row].
109. (T1, S9) Criterion 4's list includes the unclaimed $0 row and the unclaimed discount row; each keeps the bill `waiting`.
110. (T10, S1/S9) On W7 Ana's Settle model shows "Balances don't include your receipt yet: Nachos left to claim" above "Pay Ben $27.49"; with 3 rows left the line uses the count; with "Water" and "Happy hour" left it names both.
111. (T17, S7) On a group bill, Leave bill, Remove and Add people are absent (asserted in a render where the people list is present); `/b/<code>` of a group bill opened by a non-member shows "This bill is in a group. Ask for the group's link."
112. (T14, S15) Before T17, the group screen's Add choices show only "Expense"; after T17, "Receipt" appears and leads to Scan / Enter items with the group stored.

### Risks added by A1 (A2 follows below)
- **S9:** an unclaimed $0 or discount row nobody wants to claim keeps a receipt out of every balance; the named waiting line and assignments are the way out.
- **S1:** a counted receipt that becomes incomplete after payments swings every balance (W7); the notice explains it. Alternative (keep the last complete state) needs stored snapshots; not MVP.
- **GR-N5:** co-members are linked (L1), so a host can add a co-member to any non-group bill without that person opening a link.
- Who-paid (splitit-app-96, docs/specs/2026-11-26-who-paid.md, X3): group bills keep one payer (GR-M5); who-paid's later migrations refuse split-paying on group bills and port T5's mark triggers and attach's mark→payment conversion onto `bill_marks`. The Groups "Show hidden groups (N)" toggle reuses 96's `components/ui/DisclosureRow.tsx` once it lands.

---

## Amendment A2 (2026-11-26, user decision: group payments are recorded like bill payments)

**User decision (U-G7):** groups record payments the same way regular bills do under Sent via Venmo (`docs/specs/2026-11-26-sent-via-venmo.md`, splitit-app-92): opening the Venmo Pay link for a suggested payment **records the payment right away** ("Sent via Venmo"), with the same "Did you send <name> $X?" → Yes fallback (desktop web, or when the automatic record failed) and an Undo. This **replaces contract O / "Did you pay? → I paid" for groups**; **GR-S11 is superseded** by GR-P1. Where A2 and earlier text disagree, A2 wins. Criteria 53 and 74 are superseded (marked in place), 75 is amended; new criteria are 115–130.

### A2.1 Two axes on a payment (contract C-G7, amended)
- **`method`** = how the money was sent: `venmo | cash | other`. The DB check is SV's single list, `private.is_payment_method(method)`; the app uses `PAYMENT_METHODS` / `isPaymentMethod` from `lib/paymentMethods.ts` (imported, never spelled out again). splitit-app-92 confirmed `settled_method` means the same thing.
- **`source`** = how the record was made: `venmo_link` (the app opened a Venmo Pay link and recorded it, automatically or through the "Did you send…?" Yes), `manual` (Record a payment, "Got paid another way"), `bill_mark` (converted from a bill mark at move-in). Clients may send only `venmo_link` or `manual`.
- Allowed pairs: `venmo_link` → method `venmo` only; `manual` → any method; `bill_mark` → the mark's `settled_method` (SV), or `other` if a pre-SV mark has none. Any other pair → 22023 `invalid_payment`.
- `record_payment(p_id, p_group_id, p_from, p_to, p_cents, p_method, p_source)`. Everything else in C-G7 (cents range, from ≠ to, caller is one side, client uuid idempotency including both new fields, id reuse after undo) is unchanged.

### A2.2 The send flow (same as SV's contract A, applied to a group suggestion)
For the viewer's own suggested payment (from = viewer) with `venmoPayUrl(...)` non-null. The client uuid is generated **once per Pay tap** and reused by every retry and by the fallback's Yes.
- **Native (SV F2 order):** `record_payment(…, 'venmo', 'venmo_link')` with SV's 4 s limit, then open Venmo. A refusal (42501, 22023 of any kind) → don't open; show the error and refetch. Network error or timeout (outcome unknown) → open anyway and show the fallback question on return. A late success only refetches. If opening fails after a successful record → `undo_payment` (SV-7) and show "Couldn't open Venmo…" (the existing `openFailedText`).
- **Mobile web (SV §1 web):** `openPaymentLinkWeb(url)` is the **first statement** of the tap handler, before any `await` (popup blockers). Wait `WEB_OPEN_CHECK_MS`, then record only if the window is still open; otherwise ask on return. A blocked popup (null window) → no write. Uses SV's `openPaymentLinkWeb` and `detectMobileWeb` (imported).
- **Desktop web:** open first, never auto-record; show "Did you send Dee $174.97?" with **Yes, I sent it** (records with the stored uuid, `venmo`, `venmo_link`) and Not now.
- **After a record:** the viewer's card reads "You sent Dee" / "$174.97" / "Sent via Venmo" (SV copy through `methodMarkLine('venmo')`), with **"Didn't go through? Undo"** (calls `undo_payment`; no confirm, it's your own record). Then the next suggestion, if any.
- **Inline check on return (GR-P2):** the first time the viewer comes back to the group's Settle screen within `SENT_CHECK_INLINE_MAX_MINUTES` of an automatic record, the card asks "Did your $174.97 to Dee go through?" with **Yes** and **No, undo**, once per payment (keyed on the payment id, stored in memory and device storage like SV's blob; key format must match `DEVICE_KEY_RE`). **No local notification for group payments in the MVP** (GR-P2).
- **Recipient side:** a payment to the viewer shows on their card and in Who paid what as "Sent via Venmo" / "Paid in cash" / "Marked paid" (`methodRowStatus`). Their action is **"Not received"** (inline confirm "Didn't get Ben's $130.02? This clears it and lets Ben know.") which calls `undo_payment`; Activity logs it as `payment_undone` with the actor, and the sender's card then shows "Dee hasn't received your $174.97. Check Venmo before paying again." while that payment is undone and no newer payment to Dee exists (GR-P3).
- **Cash / other:** the viewer's card offers SV's method choice (`availableMethods(dee's venmo)`): Venmo, "I paid Dee $174.97 in cash" (method `cash`, source `manual`) and "Paid another way" (method `other`, source `manual`). The creditor's "Got paid another way" records method `other`, source `manual`. Record a payment adds a method field (default Cash).

### A2.3 Task changes
| Task | Change |
|---|---|
| T4 | `group_payments.method text not null check (private.is_payment_method(method))`; `source` values `venmo_link | manual | bill_mark` with the pair check of A2.1; `record_payment` takes `p_method`; idempotency compares method and source too; `payment_recorded` details add `method`. Waits for SV's migration (it defines `private.is_payment_method`), so T4 now also waits for `20261126080844_sent_via_venmo.sql` |
| T5 | Mark → payment conversion copies `settled_method` (or `other`) into `method`, source `bill_mark` |
| T3 | `edit_expense(p_id, p_expected_version, p_title, p_payer_id, p_amount_cents, p_method, p_shares)`: **no `p_group_id`** (the group comes from the expense row; GR-T9-7, matching T9's built wrapper) |
| T9 | `recordPayment({ id, groupId, from, to, cents, method, source })`; `newClientId()` used once per intent; the snapshot parser reads and checks `method` and `source` (C-G11's payment objects gain `method`) |
| T10 | `groupSettle` gets SV's states for a group suggestion: `pay` (Venmo / cash / other chooser), `sent` (+ Undo), `check` (inline Yes / No, undo), `ask_on_return` (desktop web or unknown outcome), `not_received` notice for the sender, `Not received` action for the recipient; a pure `groupSendPlan(platform, outcome)` returns the order of steps (record-then-open on native, open-then-check on mobile web, open-then-ask on desktop web) so the screen does no branching of its own. **GR-T2-9:** the group name passes through `cleanNoteName(name)` (removes `\p{Cc}` control characters, collapses whitespace, trims) before `venmoNote([name])`. It does not reuse `lib/sentCheck.ts`'s strip: that one is private and also removes `\p{Cf}`, which would break emoji ZWJ sequences in a note (lesson 2026-11-25 "control characters got through") |
| T16 | Settle UI per A2.2: no "I paid" button anywhere; the method chooser on the viewer's card; "Didn't go through? Undo"; the inline check; the desktop-web question; "Not received" for the recipient; Record a payment gains a method field. Reuses SV's components only if they take plain props (`SettleCard` is SV/92-owned and bill-shaped, so groups build `components/GroupPayCard.tsx`, new) |
| T19 | ADR 0022 records U-G7 (group payments follow Sent via Venmo; contract O is the fallback only). splitit-app-92 notes in its own ADR ("the sent-via-Venmo and payment-methods ADR") that groups reuse its method list and flow. New before-production item (GR-T9-2): client ids come from `crypto.randomUUID`, then `crypto.getRandomValues`, then `Math.random` on Hermes; the `Math.random` path isn't cryptographically random and two devices could in theory collide; ship with a proven source (e.g. `expo-crypto`) before production |

Also recorded (already built by T2, so no task change): **`leave_group` lives in T2**; T3, T4 and T5 each `create or replace` it to add their history checks (C-G10). T2 trims names with the explicit class `[ \t\n\r\v\f]` (Postgres `[[:space:]]` strips more), matching `normalizeTitle` (A1.12; T3 uses the same class for titles).

### A2.4 New acceptance criteria
115. (T4) `record_payment` with method `cash`/`venmo`/`other` and source `manual` succeeds; method `zelle` → 22023 `invalid_payment` (the check is `private.is_payment_method`); source `venmo_link` with method `cash` → `invalid_payment`; source `bill_mark` from a client → `invalid_payment`.
116. (T4) Same id + same content (method and source included) → no-op; same id with a different method → 22023 `id_conflict`.
117. (T5) Moving in a bill whose participant has an SV mark with `settled_method = 'cash'` creates a payment with method `cash`, source `bill_mark`; a mark without a method gives `other`.
118. (T3) `edit_expense` has no `p_group_id` parameter; calling it through `lib/groups.ts`'s built wrapper succeeds against the live DB (T12).
119. (T10/T16, native) Tapping Pay Dee $174.97 calls `record_payment(id, …, 17497, 'venmo', 'venmo_link')` **before** opening Venmo; the card then reads "Sent via Venmo" with "Didn't go through? Undo"; a refusal opens nothing; a timeout opens Venmo and shows "Did you send Dee $174.97?" on return, and Yes reuses the same id (one row).
120. (T10/T16, web) In the tap handler `openPaymentLinkWeb` runs before any `await` (test: the opener mock is called synchronously in the same tick as the press); mobile web records only when the window is still open after `WEB_OPEN_CHECK_MS`; desktop web never records without Yes; a blocked popup records nothing.
121. (T10/T16) The inline "Did your $174.97 to Dee go through?" shows once per payment within the time limit, on return to the Settle screen; No, undo calls `undo_payment` and the suggestion comes back after refetch; it never shows for a payment recorded through the desktop question or Record a payment.
122. (T16) Open fails after a successful native record → `undo_payment` runs and "Couldn't open Venmo…" shows; no payment remains.
123. (T16) The recipient's "Not received" asks inline, then calls `undo_payment`; the sender's card then shows "Dee hasn't received your $174.97. Check Venmo before paying again." until a newer payment to Dee is recorded.
124. (T16) No "I paid" button exists on any group screen: `grep -rn "'I paid'" "app/(app)/groups" components/Group*.tsx` prints nothing (not run: paths don't exist yet; QA first shows it matches a planted line in a scratchpad copy).
125. (T10) `cleanNoteName("Tahoe\u0000 trip\n")` → "Tahoe trip"; a ZWJ family emoji in the name survives; the Venmo URL's note is "SplitIt: Tahoe trip".
126. (T10) Every new group payment sentence is tested with a count of 1 and with the viewer as sender and as recipient ("You sent Dee", "Ben sent you", "Dee hasn't received your $174.97", "Didn't get Ben's $130.02?").
127. (T9) `newClientId()` returns a lowercase canonical uuid on every path; the test covers each of the three sources (randomUUID present, only getRandomValues, neither) by stubbing `globalThis.crypto`.
128. (T12) The live run records one payment per method and source pair allowed by A2.1 and refuses each disallowed pair.
129. **User check (phone with Venmo, Supabase reachable as in criterion 65):** in a test group, tap Pay on a $0.01 suggestion; the group shows "Sent via Venmo" before you return; in Venmo don't send; come back, answer "No, undo" and see the suggestion return.
130. **User check (desktop web):** tap Pay on a suggestion; a venmo.com tab opens; back in SplitIt, "Did you send …?" shows; Not now records nothing; Yes records one payment.
- GR-M6 (2026-11-26, main session): T4 stores `undone_reason` ('sender' | 'not_received'); T6's `group_snapshot` adds `not_received: [{id, from, to, cents, method, undone_at}]` (recipient-undone payments involving the viewer, last 30 days); T9 parses it (fail closed); T10's "Dee hasn't received your $X" notice reads it.

---

## Amendment A3 (2026-11-27, from T12 live reconciliation)

T12 ran the real `lib/groups.ts`, `lib/groupExpense.ts`, `lib/groupBalance.ts`, `lib/simplify.ts`, `lib/groupView.ts`, `lib/groupSettleView.ts` and `lib/groupActivityText.ts` against the local stack (migrations `20261126082511` … `20261127062139`) as throwaway users: **115/115 checks passed**, cleanup left 0 users, groups, profiles, bills and memberships. No lib or DB change was needed. This amendment rewrites spec text that the built code had already moved past (decision GR-T12-1). Where it and earlier text disagree, A3 wins.

### A3.1 C-G11 snapshot shape, as built (resolves GR-T6-1)
The live payload has exactly these keys (checked key by key; `lib/groups.ts` parses this and nothing else):
```
{ "group":    { "id", "name", "join_code", "created_by", "created_at" },
  "me":       { "hidden" },
  "members":  [ { "user_id", "display_name", "venmo_username", "joined_at" } ],
  "bills":    [ { "id", "host_id", "payer_id", "total_cents", "extras_split", "created_at",
                  "rows": [ { "id", "total_cents", "kind", "name", "claims": { "<uid>": parts } } ],
                  "participant_ids": [ uuid ] } ],
  "expenses": [ { "id", "title", "payer_id", "amount_cents", "split_method", "created_by",
                  "created_at", "edited_at", "version", "shares": [ { "user_id", "cents" } ] } ],
  "payments": [ { "id", "from_user", "to_user", "cents", "method", "source", "recorded_by",
                  "bill_id", "created_at" } ],
  "not_received": [ { "id", "from", "to", "cents", "method", "undone_at" } ] }
```
`rows[].name` is null on every claimed row (A1.7); `rows` are in `group_position, unit_index` order and carry neither column; `not_received` uses `from` / `to` (not `from_user` / `to_user`), holds recipient-undone payments where the viewer is the sender or the recipient, last 30 days, newest first (GR-M6, GR-T6-2); `not_received` is required (`[]` when empty). The snapshot leaves the row out for a third member; that is a filter on what the snapshot returns, not a privacy boundary: `undone_reason` on `group_payments` is readable by every member (review R8).

### A3.2 `assign_item` under the lock (resolves GR-T7-1; A1.6 and criterion 103 reconciled)
A1.6's "42501 if any changed" applies to the **caller** (no longer a member, or no longer on the bill) and to the **bill** (no longer in that group): 42501 `not_allowed`. A **target** who stops being a member while the call waits for the bill lock gives 22023 `claims_changed` (the screen refetches and the person is gone). A target who isn't a member at the first, unlocked check stays 42501. Live: a target removed while another session held the bill row → `claims_changed`, no claim written; the bill detached between calls → 42501.

### A3.3 Payments (resolves GR-T4-2; GR-T9-10, -11, -13, -15 confirmed)
- `undone_reason` follows who calls `undo_payment`: `to_user` → `not_received`, `from_user` → `sender`. A recipient who recorded "Got paid another way" and then undoes it also gives `not_received` (the sender sees "hasn't received"). A repeat undo keeps the first reason.
- All 16 pairs of method {venmo, cash, other, zelle} × source {venmo_link, manual, bill_mark, venmo} give the same answer in `recordPayment` (refused locally, no request) and in `record_payment` (22023 `invalid_payment`): only `venmo_link`/`venmo` and `manual`/{venmo, cash, other} are accepted. A mark converted at move-in keeps its method (`cash` came across as `cash`, source `bill_mark`).

### A3.4 Data-layer details confirmed live (GR-T9-4, -7, -8, GR-T12-2)
- The strict parser accepted every live snapshot read (4 groups, all states W1–W7): GR-T9-4's extra checks are not too strict.
- `edit_expense(p_id, p_expected_version, p_title, p_payer_id, p_amount_cents, p_method, p_shares)` works through `editExpense` (criterion 118).
- Error mapping: every `GroupError` except `in_group` was received live from the code the spec names (`invalid_code` is P0002; `group_full` with 50 members). `in_group` comes from the T5 triggers: live, `mark_paid` on a group bill gave 22023 `in_group`; `attach_bill_to_group` can't reach it in practice. `detach_bill_from_group`'s 40001 `bill_changed` (three lost races, GR-T5-4) maps to `network` on purpose (GR-T12-2). `create_group` / `add_expense` / `record_payment`'s 22023 `invalid_id` and `set_group_hidden`'s `invalid_hidden` can't be sent by the wrappers (local checks) and map to `network`.

### A3.5 For later tasks
- **T14 (GR-T12-3):** `describeGroupEvent` with a `nameOf` built from `snapshot.members` reads a member who left as "Someone" ("Someone left", "Someone joined"). T14 decides how the Activity screen names former members.
- `service_role` keeps write grants on `groups`, `group_members`, `group_hidden`, `expenses` and `expense_shares`, as on `bills` and `claims`. Only `group_events` and `group_payments` revoke them (GR-T12-4). The key never ships; noted for the account-deletion design (GR-26).

### A3.6 What wasn't run live, and why
A6 (20 equal users) ran as `private.allocate(99999999, 20 × 1)` against lib `allocate` (as postgres) rather than through `add_expense`, because a 20-member group wasn't built. A9 and A10 ran the same way. The deadlock and lock-order paths of criterion 34 stay with pgTAP. The phone and Venmo user checks (65, 79, 83, 87, 129, 130) need a person.
- Criterion 62 wording (2026-11-27, main session): the hidden-groups toggle reuses `components/ui/DisclosureRow.tsx`, so it reads "Hidden groups (N)" with "Show" / "Hide" (screen reader: "Hidden groups, N groups", expanded state), matching Home's "Settled (N)" — not "Show hidden groups (N)".

## Amendment A4 (2026-11-27, review fixes)

From the code review of T1–T16 (verdict APPROVE). Decisions are logged as GR-RV-1…10 in `docs/decisions-to-review.md` ("2026-11-26 · Groups").

- **A4.1 Superseded refetches (R1, GR-RV-1).** `useGroupSnapshot`'s `finished` moves only when the newest refetch ends. An older refetch's answer is ignored and doesn't count as finished, so a screen waiting for the refetch after its write is released by the newer one and never shows "Couldn't refresh" for a write that landed. The waiters' rule is unchanged: done when `version >= clearAt` (landed) or `finished >= clearAt` (failed).
- **A4.2 Time limit on group calls (R2, GR-RV-2).** Every group rpc (writes and `group_snapshot`) and `useGroupSnapshot`'s refetch give up after `GROUP_REQUEST_TIMEOUT_MS` = 15 s and read as `network`. A write retried after a timeout reuses its client id, so it is a no-op if the first one landed. The native Pay record keeps its 4 s limit (A2.2). 15 s is a starting value.
- **A4.3 Late record after a failed open (R3, GR-RV-3).** Native: if the record timed out and Venmo then fails to open, the app doesn't undo at once; it undoes the record when it lands. "Couldn't undo. Try again." shows only if that undo fails, on the payment's card.
- **A4.4 Group names in Activity (R4, GR-RV-4).** Control characters and lone surrogates are dropped; ZWJ and other format characters stay (emoji like 👨‍👩‍👧 stay whole).
- **A4.5 Contacts hints (R5, GR-RV-5).** On a group invite, "From contacts" hints say "group link"; bill invites are unchanged.
- **A4.6 `bill_mark` in Activity (R6, GR-RV-6).** A converted "I paid" mark is described by `bill_added` / `moved_to_group`; group Activity has no `payment_recorded` wording for `bill_mark`.
- **A4.7 Who paid what (R7, GR-RV-7).** A receipt isn't listed in the costs of someone whose share is $0 and who didn't pay it.
- **A4.8 A3.1 wording (R8, GR-RV-8).** The third-member `not_received` filter is the snapshot's, not a privacy rule (see A3.1).
- **A4.9 Inline check key (R9, GR-RV-9).** The key is `<group id>.<payment id>.0`; the desktop "Yes" is stored at the tap.
- **A4.10 (R10, GR-RV-10).** Activity's 1-pt sentence nudge is a named, commented constant.
