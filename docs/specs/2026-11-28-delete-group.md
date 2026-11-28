# Delete group

Spec date: 2026-11-28. Product-manager. Builds on ADR 0022 (groups) and ADR 0023 (several payers). The ADR for this work is "the group-deletion ADR". The next free number is 0027, but the main session hasn't reserved it yet, so it isn't cited by number.

## The user's decisions (binding, from chat, 2026-11-28)
1. **Any member** can delete a group, **but only once everyone is settled up**.
2. Deleting removes the group **for everyone**.
3. Tapping Delete opens a **popup to confirm**. This is an explicit exception to the group screen's "inline confirms, no modal" rule, at the user's request. It's a small in-app dialog, not `Alert.alert`, so it works on web too (DG-1).

## Design already shown to the user (kept)
- The row is the last one in the group's options card, in red.
- When the group isn't settled, the row is disabled and shows the reason.
- Popup: title `Delete "<name>" for everyone?`, a body listing what goes, and buttons [Delete group] (danger) and [Cancel]. The body was reworded for soft delete (copy table, C3).
- After deleting: go Home with a brief notice.
- Other members who have the group open see "This group was deleted" and a Home button.
- The group leaves everyone's Home and Groups lists.

## Open decision built on a default: soft delete (Q1)
The user hasn't chosen soft or hard delete. This spec builds the recommended default, **soft delete**:
- `groups.deleted_at` (and `deleted_by`) are set. Nothing else is written, moved or removed.
- The group is hidden everywhere, for everyone: lists, the group screens, table reads, invite links, and its receipts.
- Writes to a deleted group or to its receipts are refused.
- It can be restored for 30 days, by clearing `deleted_at` by hand in SQL. There is no restore screen. The purge after 30 days is a before-production item, not built here (Q2).

**Why soft.** Group balances are computed only in `lib/` (ADR 0022 §4: receipt shares need the split math, and there is deliberately no SQL copy). So the database **can't fully verify "settled up"**. A modified client, or a bug, could delete a group that still owes money. With soft delete, a mistaken or malicious delete can be undone, and the cost is one column plus filters. A hard delete would also need: a narrow exception to `group_events`' append-only trigger, the FK delete order (`expense_shares → expenses → group_payments → group_hidden → group_events → group_members → groups`), and a choice between detaching and deleting the receipts (`bills.group_id` is `on delete restrict`, and detach is refused while `bill_mark` payments are live, GR-9). Soft delete puts all of that off until the purge.

## Providers, accounts and costs
| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (existing local stack and hosted project) | the migration, pgTAP, the live check | None new |
| `pg_cron` (a Supabase extension) | **only if the user wants the 30-day purge built (Q2)**. Not used by this spec | Free extension on Supabase (verify it's offered on the user's hosted plan and on the local CLI image before speccing the purge) |

No new secrets, no Edge Function, no backend service (ADR 0010).

## Goal
A member can delete a finished trip so it stops cluttering everyone's Home and Groups lists. They can do it only once everyone's balance is settled and every receipt is fully claimed, and a mistaken delete stays recoverable.

## In scope
- DB: `groups.deleted_at` / `deleted_by`; `delete_group(p_group_id, p_fingerprint)`; the money fingerprint (contract F); the waiting-receipt rule in SQL (contract W); hiding deleted groups from `my_groups`, `group_snapshot`, `join_group` and RLS reads; refusing writes to deleted groups and to their receipts.
- lib: the `deleteGroup` wrapper, error mapping, the snapshot's `money_fingerprint`, `canDeleteGroup` (contract S), the popup copy, the `deleted` load state, and the one-shot Home notice store.
- Screens: the Delete row, the confirm dialog (`components/ConfirmDialog.tsx`), the deleted state on the group screen and its sub-screens (Settle, Balances, Expense, Activity), and the Home notice.
- `docs/before-production.md`: the purge item, the deploy-order line, and the GR-26 account item updated.

## Out of scope (cut)
- Restore UI, "Recently deleted", undo. Restore is a manual SQL step (before-production item).
- The 30-day purge job (Q2).
- An Activity or feed line for "group deleted" (the user turned down a similar "you were removed" line). No `group_events` kind is added.
- Showing the deleted group's receipts anywhere, including as standalone bills on Home.
- Changing "People you've split with" or profile visibility (DG-9: links made through the group stay).
- Bill-screen copy for a deleted group's receipt. It shows the bill screen's existing no-access state (DG-11).
- A per-member "everyone settled" display, and any change to Home's group-row status (C2 rule 5 stays "me").
- Push or other notifications to the other members.

## Files owned by other sessions
- **splitit-app-96:** `app/(app)/(tabs)/index.tsx` (Home). **T6 needs a minimal edit there: one import and one `<GroupDeletedNotice />` line.** Announce it to 96 first (file, change, why, user-requested), and list the tests that assert Home's layout (lesson 2026-11-27 "A peer session edited…"). `lib/bills.ts` is **not** edited. Bill writes refused with `22023 group_deleted` map to its existing `network` path (DG-11).
- **splitit-app-52:** tab layouts are not touched. The coordinator says this session now owns `lib/groups.ts`, `lib/groupView.ts` and `app/(app)/groups/[id]/index.tsx`. **The main session confirms with 52 before T4 and T6** that the same holds for `lib/useGroupSnapshot.ts`, `lib/groupScreenText.ts` and `app/(app)/groups/[id]/{settle,balances,expense,activity}.tsx`. Not touched: `lib/useActivityFeed.ts`, `lib/tabBadges.ts`, `lib/activityFeed.ts`, `lib/feedView.ts`, `lib/feedText.ts` (52 is fixing them). `lib/feedSeen` prunes deleted groups on its own (coordinator).
- The group screen already has `markFeedSeen(myId,'group',id)` and `backToTabs` (52's Task 9). Re-read it before editing. Edit with exact strings and never reformat (CLAUDE.md, lesson 2026-11-28).
- Adding `GroupError` members (T4) can break an exhaustive `switch`/`Record<GroupError,…>` in another session's file. T4 greps `GroupError` across `app/ lib/ components/` first and sends any needed change in 52's or 96's files to that session. It doesn't make the change itself.

---

## Shared contracts (defined once; tasks point here)

### Contract F: the money fingerprint
`private.group_money_fingerprint(p_group_id uuid) returns text`. It is `stable`, `security definer`, `set search_path = ''`, and nobody but the owner can execute it. It returns `md5(<jsonb>::text)`, 32 lowercase hex characters, where `<jsonb>` is:
```
{ "members":  [user_id …]                                  -- group_members, ordered by user_id
, "bills":    [{ "id", "payer_id", "total_cents", "extras_split",
                 "rows": [{ "id", "total_cents", "kind",
                            "claims": { "<user_id>": parts … } }]   -- line_items by id; {} if none
              } …]                                          -- bills with group_id = G, ordered by id
, "expenses": [{ "id", "version" } …]                       -- deleted_at is null, ordered by id
, "payments": [ id … ]                                      -- undone_at is null, ordered by id
}
```
- It covers every input `groupBalances` reads (members, each bill's payer, total, extras mode, rows and claims; expense amounts and shares through `version`; live payments). So any change that can move a balance or a waiting state changes it. Rename, a new link, hide and "not part of this" don't.
- `group_snapshot` returns it as the top-level key `"money_fingerprint"`, computed in the same statement (the same snapshot) as the rest of the payload. *Verify:* a `stable` function called inside the snapshot's single `SELECT` sees that statement's snapshot. If it doesn't, compute it inline with the same expression.
- The app never computes it. It sends back exactly the string from the snapshot on screen. `delete_group` recomputes it under its locks and compares.
- It is a staleness check, not a security boundary. A forged value only lets a modified client skip the "something changed" refusal, and soft delete covers that.

### Contract W: "a receipt is waiting" (one rule, both sides)
A group bill is **waiting** when it isn't fully claimed (rule C1) **or** it is all-$0 (rule Z). This is C-G1, and lib is the reference.
- lib: the bill is in `groupBalances(balanceInputOf(snapshot)).waiting`.
- SQL: `private.group_bill_waiting(p_bill_id) = not private.bill_is_complete(p_bill_id) or private.bill_all_zero(p_bill_id)`.
- Attach's S1b comment says its SQL check is "not a copy of C-G1". So T1 first runs table W against the existing helpers. If any case disagrees with lib, T1 writes `group_bill_waiting` to match lib and reports the difference. It doesn't change `bill_is_complete`, which other functions use.

| Case | Bill | Waiting? |
|---|---|---|
| W1 | every priced row claimed | no |
| W2 | one item row unclaimed | yes |
| W3 | one discount row unclaimed, items claimed | yes |
| W4 | every row claimed, every row $0 (all-$0) | yes |
| W5 | priced rows claimed, one $0 row unclaimed (S9) | yes |
| W6 | one split row with two claimers (parts 1 + 2), everything else claimed | no |
| W7 | a bill with no rows | recorded from lib; SQL must give the same answer |

### Contract S: "everyone is settled up" (lib only)
`canDeleteGroup(snapshot)` in `lib/groupView.ts` returns `{ ok: true } | { ok: false; reason: 'receipts_waiting' | 'not_settled' }`:
1. Any bill is waiting (contract W) → `receipts_waiting`. This is checked first: a waiting receipt counts as $0, so balances can look settled while it waits.
2. Else, any member's net fails `isSettledUp` (`lib/simplify.ts`, `|net| ≤ GROUP_IGNORE_CENTS` = 1¢) → `not_settled`.
3. Else ok.

Nets come from `groupMath(snapshot)` (`lib/groupBalance.ts` `netsOf`). There's no new arithmetic and no SQL copy (ADR 0022 §4). It differs from Home's "Settled up" (C2 rule 5), which is about **me**. This one is about **every member**. The 1¢ forgiveness is GR-3's rule, applied to deletion (Q3).

| Case | Nets (cents) | Waiting | Result |
|---|---|---|---|
| S1 | no costs at all, 1 member | none | ok |
| S2 | all 0 | none | ok |
| S3 | +1, −1 (exactly at tolerance) | none | ok |
| S4 | +2, −2 (1¢ over) | none | not_settled |
| S5 | +1, +1, −2 (two at tolerance, one 1¢ over) | none | not_settled |
| S6 | all 0 | one W2 bill | receipts_waiting |
| S7 | +500, −500 | one W4 bill | receipts_waiting (waiting wins) |
| S8 | all 0, a hidden group (`me.hidden = true`) | none | ok |

### Contract D: `delete_group(p_group_id uuid, p_fingerprint text) returns void`
`security definer`, `set search_path = ''`, owner `postgres`, EXECUTE for `authenticated` only (revoked from `public, anon`; and from `service_role` unless the engineer records why not, lesson 2026-11-28 R3). Checks run in this order:

| # | Condition | Result |
|---|---|---|
| 0 | signed out; `p_group_id` null | `42501 not_allowed` |
| 1 | caller isn't in `group_members` for the group (or there's no such group). Plain read, **no lock** (who may act comes before any lock) | `42501 not_allowed` |
| 2 | lock: `groups` row `FOR UPDATE` | |
| 3 | lock: every bill with `group_id = G`, `FOR UPDATE`, ascending id | |
| 4 | membership re-read under the locks; gone | `42501 not_allowed` |
| 5 | `deleted_at` is set and `deleted_by = caller` | **success, no write** (a retry after a lost answer) |
| 6 | `deleted_at` is set, someone else deleted it | `22023 group_deleted` |
| 7 | `p_fingerprint` is null, malformed (`!~ '^[0-9a-f]{32}$'`), or ≠ contract F now | `22023 group_changed` |
| 8 | any bill of the group is waiting (contract W) | `22023 receipts_waiting` |
| 9 | `update groups set deleted_at = now(), deleted_by = caller` | success |

- No event is logged, no other row is written, and nothing broadcasts.
- `deleted_by uuid null references profiles(id) on delete set null`. A deleter's account deletion keeps the group deleted, with no "by" (lesson 2026-11-27: every new profiles FK says what account deletion does).
- **What the DB checks and why (DG-4).** It checks: membership; already deleted; the fingerprint (the screen judged "settled" on exactly this money state); no waiting receipts (contract W, cheap, the same rule as lib). It doesn't check balances, which would be a second copy of C-G2 (ADR 0022 §4). It doesn't check "Not received" either: in groups, Not received *undoes* the payment (`group_payments.undone_reason`), so it already shows in the nets, and a recent flag is only a notice.

### Contract L: lock order (rule from `20261126082511_groups.sql`: group row, then bills ascending, then bill_participants, then claims)
- `delete_group` takes the group row **FOR UPDATE**, not FOR NO KEY UPDATE like leave_group's rule (a), on purpose. FOR UPDATE conflicts with FOR KEY SHARE, which every in-flight `group_events` / `group_members` insert holds on the group row through its FK. So step 2 waits for those writes to commit, and the fingerprint read in step 7 sees them. `rotate_group_code` already takes FOR UPDATE with the same argument: while waiting, it holds nothing those writers wait for. Then the bills are taken FOR UPDATE, as in leave_group step (d)2. This waits for claim, assign, edit and payer writes, which hold bill locks and never lock the group row.
- The B2a deadlock in the groups header doesn't apply. leave_group deletes a `group_members` row while holding the group, but delete_group deletes nothing.
- **The writer side (T2): `private.group_events_live_group()`**, a BEFORE INSERT trigger on `group_events`. It reads `groups.deleted_at` with `FOR KEY SHARE`, the mode the event's FK takes anyway, so there's no new lock mode. A locking read in READ COMMITTED returns the newest committed row after a wait. If set, it raises `22023 group_deleted`. A money write that passed its own checks before the delete committed is therefore refused when it logs its event, and rolls back whole.
- **The writer side (T3): bill-level.** `private.refuse_deleted_group_bill(bill_id)` takes the bill `FOR KEY SHARE` (the claims path's own first lock), then reads the group's `deleted_at` without a lock. delete_group holds that bill FOR UPDATE until it commits, so the read after the wait sees `deleted_at`.
- **The walk the engineer writes into the migration header (lesson 2026-11-27 R5):** every existing function and trigger that locks a group row or a bill of a group, including account-deletion cascades and the payer-reset trigger, with its lock sequence, checked against "delete_group holds the group FOR UPDATE and waits for bills". A cycle needs a path that holds a group bill lock and then waits for the group row. If the walk finds one, T1 stops and reports. It doesn't pick another lock mode on its own.

### Contract H: what a deleted group looks like to each read and write
| Path | Deleted group, caller was a member | Caller not a member |
|---|---|---|
| `my_groups()` | not listed | not listed |
| `group_snapshot(G)` | `22023 group_deleted` | `42501 not_allowed` (unchanged) |
| `join_group(code)` | `P0002 invalid_code` (same as a rotated or unknown code; DG-10) | same |
| table reads of `groups`, `group_members`, `group_events`, `expenses`, `expense_shares`, `group_payments` | no rows (`private.is_group_member` gains `and the group isn't deleted`) | no rows |
| every group write that logs a group event (rename, rotate, add/edit/delete expense, record/undo payment, leave, attach, detach) | `22023 group_deleted` (the T2 trigger; the membership check still comes first) | `42501` |
| `set_group_hidden` | `22023 group_deleted` (re-created with an explicit check) | `42501` |
| `my_bills()` | the group's receipts not listed (unchanged: `b.group_id is null`; they keep their `group_id`) | — |
| reads of a group receipt's `bills`, `line_items`, `claims`, `bill_participants`, `bill_events`, Realtime | no rows / no access (`private.is_bill_participant` gains "the bill's group isn't deleted"; T3 lists every caller) | unchanged |
| writes to a group receipt (`claims`, `line_items`, `bills` UPDATE incl. detach/attach, `bill_not_part` insert) | `22023 group_deleted` (T3 triggers), or `42501` where `is_bill_participant` refuses first | unchanged |
| `people_i_split_with`, profiles visibility | unchanged (DG-9) | — |

---

## Copy (every state; lib owns strings, screens build none)
| ID | Where | Text |
|---|---|---|
| C1 | options card row | `Delete group` (danger colour, last row) |
| C1a | row hint (enabled) | `Asks first` (same as Leave) |
| C2a | row caption when disabled, waiting | `Every receipt has to be fully claimed before you can delete this group.` |
| C2b | row caption when disabled, not settled | `Everyone has to be settled up before you can delete this group.` |
| C2c | disabled row accessibility label | `Delete group, unavailable. ` + C2a or C2b |
| C3 | dialog title | `Delete "<name>" for everyone?` |
| C3b | dialog body | `It will disappear for <who><with>. You can't undo this in the app.` See the template below |
| C4 | dialog buttons | `Delete group` (danger), `Cancel` (ghost) |
| C5 | dialog error, network or timeout (dialog stays open) | `Couldn't delete the group. Check your connection and try again.` |
| C6 | error line under the options card after `group_changed` (dialog closes) | `Something in this group just changed. Check it and try again.` |
| C7 | the same after `receipts_waiting` | C2a |
| C8 | group screen and sub-screens, deleted state | heading `This group was deleted`, button `Go home` |
| C9 | Home notice after your own delete | `"<name>" was deleted.` with a `Dismiss` link (hint `Hides this message`) |
| C10 | `GROUP_ERROR_COPY.group_deleted` (generic, any other write) | `This group was deleted.` |
| C11 | `GROUP_ERROR_COPY.group_changed` | C6 |
| C12 | `GROUP_ERROR_COPY.receipts_waiting` | C2a |

**C3b template** (`deleteConfirmText(snapshot, viewerId)` in `lib/groupScreenText.ts`, tested on every row):
- `<who>`: 1 member → `you`; 2 → `both members`; n ≥ 3 → `all n members`.
- `<with>`: the non-empty parts, in this order: `n expenses` / `1 expense` (live expenses), `n receipts` / `1 receipt` (bills), and `payment history` (when any live payment exists). They're joined `A`, `A and B`, `A, B and C`, after `, with its `. If no part is non-empty, `<with>` is empty.
- Examples: 4 members, 3 expenses, 2 receipts, payments → `It will disappear for all 4 members, with its 3 expenses, 2 receipts and payment history. You can't undo this in the app.` 1 member, nothing → `It will disappear for you. You can't undo this in the app.` 2 members, 1 expense → `It will disappear for both members, with its 1 expense. You can't undo this in the app.`
- The name is member-set group data from the snapshot, never URL text (lesson 2026-11-19).

---

## Tasks (ordered; each about one pass, under 300 lines changed)

**Shared DB rules for T1–T3:** each is its own migration. The timestamp is taken when the file goes into `supabase/migrations/`, after any migration another session applied (lesson 2026-11-28). Wrap each file in `begin;` … `commit;`. Announce before `npx supabase migration up`, never run `db reset`, and run pgTAP one file at a time. Re-create a function from the **newest** definition on disk, checked with `pg_get_functiondef` against the live database. Every new function gets a `revoke execute … from public, anon, authenticated` and a grant to `authenticated` only where a client calls it.

### T1 · supabase-engineer · `delete_group`, fingerprint, waiting rule, snapshot key
- `supabase/migrations/<ts>_group_delete.sql` (new): `groups.deleted_at timestamptz null`, `groups.deleted_by uuid null → profiles on delete set null` (+ index), and a check that both are null or both set except `deleted_by` after set null (`deleted_at is not null or deleted_by is null`). Also `private.group_money_fingerprint` (F), `private.group_bill_waiting` (W), `public.delete_group` (D), and `group_snapshot` re-created from `20261127150000_bill_not_part.sql` (the newest on disk; verify live) with `"money_fingerprint"` added and `22023 group_deleted` for a member of a deleted group, still checked after membership. The header has the contract L walk, the D check order, the error list and "columns clients can't read" (none new hidden; `groups` keeps table-level SELECT).
- `supabase/tests/database/delete_group.test.sql` (new): criteria 1–14.
- `docs/before-production.md`: the items in criterion 15 (in this task, lesson 2026-11-27 "Risks the spec already named…").
- First: run table W against `bill_is_complete` / `bill_all_zero` and report any difference (contract W).

### T2 · supabase-engineer · hide deleted groups, refuse group-level writes
- `supabase/migrations/<ts>_group_delete_hide.sql` (new): `private.is_group_member` re-created with the deleted filter. `my_groups` re-created with `g.deleted_at is null`. `join_group` re-created from `20261127060131_group_bills.sql` (verify newest), adding `and g.deleted_at is null` in the locked code lookup. `set_group_hidden` re-created with a `group_deleted` check after membership. The `group_events_live_group` BEFORE INSERT trigger (contract L). In the header: every function that logs a group event, listed by name, as covered by the trigger.
- `supabase/tests/database/delete_group_hide.test.sql` (new): criteria 16–24.

### T3 · supabase-engineer · hide and freeze a deleted group's receipts
- `supabase/migrations/<ts>_group_delete_bills.sql` (new): `private.is_bill_participant` re-created with "the bill isn't in a deleted group". The header lists every caller: grep found 16 uses in 6 migrations (`bills_claims`, `bill_edit_realtime`, `bill_events`, `settle_early`, `bill_payments`, `who_paid`), and each is checked to be fine with the filter. Also `private.refuse_deleted_group_bill(bill_id)` (contract L) and BEFORE row triggers: `claims` INSERT/UPDATE/DELETE, `line_items` INSERT/UPDATE/DELETE, `bills` UPDATE (checks both OLD.group_id and NEW.group_id) and `bill_not_part` INSERT. Each passes when the bill no longer exists (cascades from a bill delete), and the header notes that a future purge needs the same exception.
- `supabase/tests/database/delete_group_bills.test.sql` (new): criteria 25–30.

### T4 · implementer · lib (after T1 is applied locally; T2/T3 not needed)
- `lib/groups.ts`: `GroupError` gains `group_deleted`, `group_changed`, `receipts_waiting`; copy C10–C12; `DbFunction` gains `delete_group`. `MESSAGES_22023`: `delete_group: ['group_deleted','group_changed','receipts_waiting']`, `group_snapshot: ['group_deleted']`, and `group_deleted` added to every group write function's list (including `set_group_hidden`, `set_not_part`, `assign_item`). New `deleteGroup(groupId, fingerprint)`. The snapshot parser requires `money_fingerprint` (`/^[0-9a-f]{32}$/`) as `GroupSnapshot.moneyFingerprint`.
- `lib/groupView.ts`: `canDeleteGroup` (contract S); `GroupScreenModel` gains `canDelete`.
- `lib/groupScreenText.ts`: copy C1–C9 and `deleteConfirmText`.
- `lib/useGroupSnapshot.ts`: `group_deleted` → a new load state `{ status: 'deleted' }`, which also replaces a `ready` state (a member who has the group open).
- `lib/groupDeletedNotice.ts` (new): a one-shot, in-memory store: `setGroupDeletedNotice({ name, userId })`, `takeGroupDeletedNotice(userId)`. It's keyed to the account, so a sign-out or a different account never sees it.
- Tests: `lib/groups.test.ts` (wrapper and mapping rows), `lib/groupView.test.ts` (S1–S8, W1–W7 through `canDeleteGroup`), `lib/groupScreenText.test.ts` (C3b template), `lib/groupDeletedNotice.test.ts`. Also fix the snapshot fixtures in `test-utils/` for the new required key.

### T5 · product-engineer · dialog, Delete row, deleted state on the group screen
- `components/ConfirmDialog.tsx` (new, generic): props `visible, title, body, confirmLabel, confirmVariant, cancelLabel, onConfirm, onCancel, busy, error`. A centred card over a scrim on every platform (RN `Modal`, `transparent`, `animationType="fade"`). The title is a header and gets focus on show (native). Android back, web Escape and a scrim tap cancel, except while `busy`. Focus goes back to the opener on close (as `QrSheet`). It works at 200% zoom (scrolls) and in light and dark.
- `components/DeleteGroupRow.tsx` (new): a ListRow-styled pressable with danger text, disabled with caption C2a/C2b. `components/ui/ListRow.tsx` isn't edited.
- `app/(app)/groups/[id]/index.tsx`: the row last in the options card; `WriteKind` gains `'delete'`; a `dialog` state (not a `Panel`); `runWrite('delete', …)` with the ref guard. On ok: `setGroupDeletedNotice` then `router.replace('/')`, once. The refusal handling follows criteria 41–45. A `load.status === 'deleted'` branch renders C8.
- `__tests__/deleteGroup.test.tsx` (new). Existing group screen tests aren't edited unless a new required prop forces it.
- `docs/decisions-to-review.md`: product-engineer decisions under the "2026-11-28 · Delete group" heading.

### T6 · product-engineer · sub-screens and Home notice
- `components/GroupDeletedState.tsx` (new): C8 plus `Go home` (`router.replace('/')`).
- `app/(app)/groups/[id]/settle.tsx`, `balances.tsx`, `expense.tsx`: one `load.status === 'deleted'` branch each. `activity.tsx`: map a `group_deleted` snapshot error to the same state.
- `components/GroupDeletedNotice.tsx` (new): takes the notice once on mount for the signed-in user and renders C9 with Dismiss (a `StatusLine`-style line, polite live region; announced on iOS). It's gone after Dismiss or when Home loses focus, with no timer (DG-7).
- `app/(app)/(tabs)/index.tsx` (**96's file**): one import plus `<GroupDeletedNotice />` at the top of the content. Announce first.
- `__tests__/groupDeletedScreens.test.tsx` (new).

### T7 · docs-writer · after T1–T6
The group-deletion ADR is written into the number the main session reserves (0027 if still free), with its title and the stub made by the main session. Concept notes: `group-balances.md` ("deleting needs everyone settled", contract S), `stale-state-checks.md` (the fingerprint), `row-level-security.md` and `database-functions.md` (the soft-delete filters, the group_events trigger, the FOR UPDATE choice), `people-and-membership.md` (deleted groups keep links, DG-9). Hand over the spec path, "T7", and every file T1–T6 touched (lesson 2026-11-27 docs handoff).

### T8 · qa-tester (with the live-smoke harness: esbuild bundle of `lib/groups.ts`, `lib/groupView.ts`)
Criteria 31–52 as written, then 53–57 against the local stack, with throwaway users and the restrict-safe cleanup (lesson 2026-11-27). Then hand over the User checks.

---

## Acceptance criteria

### Database: `delete_group` (T1, pgTAP unless noted)
1. `groups` has `deleted_at` and `deleted_by`. A fresh group has both null. RLS and grants on `groups` are unchanged apart from the new columns. `authenticated` still can't INSERT/UPDATE/DELETE `groups` (42501).
2. A member of a settled group (no bills, or every bill W1) who passes the fingerprint from `group_snapshot` gets success. Afterwards `deleted_at` is set, `deleted_by` = the caller, and the counts of `group_members`, `group_events`, `expenses`, `expense_shares`, `group_payments`, `group_hidden`, and of `bills` with that `group_id`, are exactly the same as before.
3. A non-member, a signed-out caller, an unknown group id and a null id each get `42501`. `anon` gets `42501` executing it.
4. The same caller calling it again on its own deleted group gets success with no change (`deleted_at` keeps its first value). A different member gets `22023 group_deleted`.
5. A fingerprint that is null, `''`, 31 hex characters, uppercase, or one character changed gets `22023 group_changed`. The group is not deleted.
6. Fingerprint sensitivity, each from a fresh snapshot fingerprint: these each change it, and `delete_group` with the old value gets `group_changed`: claim, unclaim, `assign_item`, an item price edit, an extras-split change, a payer change on a group bill, add/edit/delete expense, record/undo payment, a member joining, a bill attached, a bill detached. These leave it unchanged: rename, rotate the link, hide/unhide, `set_not_part`.
7. Contract W both sides: W1–W7 give the same waiting answer from `private.group_bill_waiting` here and from `groupBalances` in criterion 33. W2–W5 make `delete_group` (with a fresh fingerprint) refuse with `22023 receipts_waiting`. W1 and W6 succeed.
8. Check order: on a group with a waiting receipt **and** a stale fingerprint the answer is `group_changed`. On a group deleted by someone else and called with a stale fingerprint, it's `group_deleted`. For a non-member of a deleted group, it's `42501`.
9. Lock order, checked on the function body (pgTAP can't run two sessions): the membership read comes before any lock; `FOR UPDATE` on `groups` comes before the bills' `FOR UPDATE … ORDER BY id`; the checks of rows 4–8 come after both. The migration header has the contract L walk, naming every path it checked.
10. `delete_group` writes no `group_events` or `bill_events` row (counts unchanged) and doesn't change `bills.group_id`.
11. `group_snapshot` returns `money_fingerprint` matching `^[0-9a-f]{32}$`, equal to `private.group_money_fingerprint(G)` in the same transaction. Every other key is unchanged (compare the key sets with the old definition).
12. `group_snapshot` on a deleted group: a member gets `22023 group_deleted` and a non-member `42501 not_allowed`.
13. `private.group_money_fingerprint` and `private.group_bill_waiting` aren't executable by `public`, `anon` or `authenticated` (`has_function_privilege` false).
14. `delete_group` is executable by `authenticated` and not by `anon` or `public`. `service_role` is revoked, or the header says why not.
15. `docs/before-production.md`, edited in T1:
    (a) The GR-26 item ("Group members can't delete their account") gains a dated note. Deleting a group is now possible, but it is a soft delete, so the `group_members` rows (restrict FK) stay and **still block account deletion until a purge removes them**. The account-deletion design must include deleted groups.
    (b) A new item, "Purge soft-deleted groups after 30 days". Not built. It needs a scheduled job (`pg_cron` on Supabase, to verify) or a manual SQL run. The FK order is `expense_shares → expenses → group_payments → group_hidden → group_events → group_members → groups`. It needs a narrow, named exception in `group_events_append_only` (like the existing "parent is gone" cascade rule), never a broad trigger disable. It also needs a decision for the receipts (delete them, or detach them, which GR-9 refuses while `bill_mark` payments are live) and the same exception in T3's triggers. Restoring is `update groups set deleted_at = null, deleted_by = null where id = …` by the operator.
    (c) A deploy-order line next to the group claim status one: the app's snapshot parser requires `money_fingerprint`, so the T1 migration ships before the app build.
    (d) "The DB can't verify settled-up on delete" (DG-4): a modified client can delete an unsettled group. It's recoverable for as long as there's no purge.

### Database: hiding and group-level refusals (T2)
16. After a delete, `my_groups()` doesn't list the group for any member, hidden or not. The other groups are unchanged.
17. After a delete, a member's `select('id, name')` on `groups`, `select('group_id, user_id')` on `group_members`, `select('id, kind')` on `group_events`, `select('id')` on `expenses` and `group_payments`, and `select('expense_id, user_id')` on `expense_shares` each return 0 rows for that group, and still return rows for another live group of theirs.
18. `join_group` with the deleted group's current code gets `P0002 invalid_code`, for a member and a non-member alike. No `group_members` or `bill_participants` row is added.
19. Each of `rename_group`, `rotate_group_code`, `add_expense`, `edit_expense`, `delete_expense`, `record_payment`, `undo_payment`, `leave_group`, `attach_bill_to_group` and `detach_bill_from_group`, called by a member on a deleted group (with otherwise valid arguments), gets `22023 group_deleted`, and no row in any group table changes. Called by a non-member, each gets `42501`.
20. `set_group_hidden(G, true)` and `(G, false)` on a deleted group get `22023 group_deleted`.
21. The trigger fires for every role: a direct `insert into group_events` as `postgres` for a deleted group raises `22023 group_deleted`. Inserting for a live group works (as `create_group` does).
22. The trigger's body reads `groups` with `FOR KEY SHARE` (checked on the body text).
23. Restore round trip: clearing `deleted_at` and `deleted_by` as `postgres` makes the group show again in `my_groups`, `group_snapshot` and table reads, with the same balances input (the fingerprint equals the one from before the delete).
24. Live groups: the existing pgTAP files for groups, group expenses, payments, group bills, snapshot, assign_item and bill_not_part still pass, one file at a time. Any failure caused by another session's unapplied migration is reported as such (lesson 2026-11-27).

### Database: the deleted group's receipts (T3)
25. After a delete, `my_bills()` for every member doesn't include the group's bills (the same count as before the delete). The bills still have `group_id = G`.
26. A member's `select('id, total_cents')` on `bills`, `select('id')` on `line_items`, `select('line_item_id, user_id')` on `claims` and `select('user_id')` on `bill_participants` return 0 rows for those bills, and still return rows for a non-group bill they're on.
27. `set_claim`, `set_item_split`, `assign_item`, `update_bill`, `set_payer`, `set_not_part(true)` and `detach_bill_from_group` on one of those bills are each refused (`22023 group_deleted`, or `42501` where participation is checked first; the test records which), and no row changes.
28. A direct `insert into claims` as `postgres` for a row on such a bill raises `22023 group_deleted`. A `bills` UPDATE that sets `group_id` to a deleted group also raises it.
29. Deleting a non-group bill, or any bill whose group is live, still cascades its `claims` and `line_items` (the triggers pass when the bill is gone or its group is live).
30. The T3 header lists every caller of `is_bill_participant` and the result of checking each. The order "bill `FOR KEY SHARE` before reading `groups`" in `refuse_deleted_group_bill` is checked on the body.

### lib (T4, Jest)
31. `deleteGroup(groupId, fingerprint)` calls `supabase.rpc('delete_group', { p_group_id, p_fingerprint })` with exactly those keys. A non-uuid group id returns `not_allowed`, and a fingerprint failing `/^[0-9a-f]{32}$/` returns `group_changed`, both without a request. It gives up after `GROUP_REQUEST_TIMEOUT_MS` as `network`.
32. Error mapping table: for `delete_group`, `42501` → `not_allowed`; `22023` with each of `group_deleted`, `group_changed`, `receipts_waiting` → that error; `22023` with any other message → `network`; no code → `network`. For `group_snapshot`, `22023 group_deleted` → `group_deleted`. For each group write wrapper, `22023 group_deleted` → `group_deleted`. No server text appears in any returned value.
33. `canDeleteGroup` returns exactly the results of S1–S8, and `groupBalances(...).waiting` gives W1–W7's answers (the same table as criterion 7, built from shared fixture rows in `test-utils/`).
34. `canDeleteGroup` makes no money arithmetic of its own. The test checks that it reads `groupMath` (a spy or a memo hit), and the reviewer checks the code for `+`/`-` on cents.
35. The snapshot parser requires `money_fingerprint`: missing, `null`, uppercase or 31 characters → `fetchGroupSnapshot` returns `network`. A valid one is in `snapshot.moneyFingerprint`.
36. `deleteConfirmText` gives the three examples in C3b word for word, plus: 3 members, 0 expenses, 1 receipt, no payments → `It will disappear for all 3 members, with its 1 receipt. You can't undo this in the app.` And 2 members, 2 expenses, 0 receipts, payments → `It will disappear for both members, with its 2 expenses and payment history. You can't undo this in the app.`
37. `useGroupSnapshot`: a `group_deleted` answer gives `{ status: 'deleted' }`, both from loading and from a `ready` state (a later refetch). A `network` answer from `ready` keeps `ready`, as now.
38. `groupDeletedNotice`: `take` returns the notice once, then null. A `take` for another user id returns null and doesn't consume it. A second `set` replaces the first.
39. `npm run typecheck` passes with the new `GroupError` members. The T4 report lists every file that uses `GroupError` (from grep) and what each needed.

### Screens (T5, T6, Jest router tests in new files; web and native paths, lesson 2026-11-19)
40. With the options card open, `Delete group` is the last row, in the danger colour. When `canDelete` is ok, it's enabled with hint `Asks first`. When it's not, it's disabled and shows the matching caption C2a/C2b as visible text, with label C2c. Pressing it does nothing. On web, the rendered element has `aria-disabled="true"` or `disabled`, *verify which react-native-web 0.86's output gives; reword if it differs* (lesson 2026-11-27: RN-web drops `accessibilityState`).
41. Tapping the enabled row opens `ConfirmDialog` with C3 (the snapshot's name), C3b and the C4 buttons. Cancel, Android back, web Escape and a scrim tap close it with no call. While the call is in flight, they don't, and Cancel is disabled.
42. Two taps on `Delete group` in the dialog in the same tick send **one** `delete_group` call. On success the screen calls `setGroupDeletedNotice` with the group's name and the viewer's id, then `router.replace('/')` exactly once.
43. The fingerprint sent is the `moneyFingerprint` of the snapshot on screen at the moment of the tap. Test: a refetch lands while the dialog is open with a new fingerprint, and the call carries the new one.
44. **Race: someone adds an expense while the dialog is open.** (a) If a refetch lands that makes `canDelete` not ok, the dialog closes by itself and the row shows disabled with its caption. (b) If no refetch landed and the DB answers `group_changed`, the dialog closes, C6 shows under the options card, and a refetch starts. `receipts_waiting` does the same with C7. (c) Neither path deletes or navigates.
45. `network` or a timeout: the dialog stays open, shows C5, and re-enables `Delete group`. Retrying sends the same group id and the current fingerprint. A retry after a delete that did go through is a success in the DB (criterion 4), so the test fakes that answer and expects navigation once. `group_deleted` from `delete_group` closes the dialog and switches the screen to the deleted state. `not_allowed` closes the dialog, shows `GROUP_ERROR_COPY.not_allowed` and refetches.
46. A `{ status: 'deleted' }` load on the group screen, and on Settle, Balances, Expense and Activity, shows heading C8 and `Go home`, which calls `router.replace('/')`. No group data (name, amounts, members) is shown in that state.
47. A write that returns `group_deleted` on the group screen (for example Rename) shows C10 and refetches, and the refetch then gives the deleted state.
48. Home renders `GroupDeletedNotice`: after `setGroupDeletedNotice({ name: 'Tahoe trip', userId: me })`, Home shows `"Tahoe trip" was deleted.` once. Dismiss hides it. It doesn't come back after Home loses and regains focus, and a different signed-in user never sees it.
49. Grep: `grep -rn "Alert\.alert(" "app/(app)/groups" components lib` prints nothing (the Grep tool found no files on 2026-11-28 before this work).
50. Grep: `grep -rnE "\.select\(\s*\)|\.select\(\s*['\"]\*['\"]\s*\)" lib/groups.ts` prints nothing (no matches on 2026-11-28).
51. Grep positive control: `grep -rn "'This group was deleted'" lib/groupScreenText.ts` prints exactly one line, and `grep -rn "This group was deleted" app components` prints nothing (screens build no strings). The Grep tool found no file with `'This group was deleted'` on 2026-11-28, so the first grep must go from 0 to 1.
52. The reviewer checks from `git diff` that `app/(app)/(tabs)/index.tsx` changed only by the import and the one `<GroupDeletedNotice />` line, and that none of the 52-owned feed files listed above changed.

### Live check (T8, two throwaway users A and B, local stack, esbuild harness)
53. A and B in a group with one expense and the matching payment, so both nets are 0. B's `canDeleteGroup` is ok. B deletes with the snapshot's fingerprint, and A's next `listMyGroups` lacks the group. A's `fetchGroupSnapshot` returns `group_deleted`, and A's `fetchBills`-equivalent Home read (`my_bills`) lacks the group's receipt.
54. Race: B reads a snapshot. A adds an expense. B's `deleteGroup` with the old fingerprint returns `group_changed` and the group is still live.
55. Race, in-flight: in two connections, A starts `add_expense` inside a transaction held open (psql `begin; select add_expense(...)`, not committed), and B calls `delete_group` in the other. Either B waits and then gets `group_changed` after A commits, or A's statement waits and then fails with `22023 group_deleted`. The group never ends up deleted with A's expense committed. Record which happened.
56. A's `addExpense`, `recordPayment` and `assignItem` on the deleted group return `group_deleted` (or `not_allowed` where criterion 27 recorded `42501`).
57. Cleanup leaves 0 rows of the run in every table (lesson 2026-11-27 restrict-safe cleanup).

### User checks (for the user; QA reports them as "for the user")
58. **User check, web:** at http://localhost:8081 (the one dev server, local stack), sign in as a member of a settled test group, open it → `…` → `Delete group`. Check the dialog: title, body, red `Delete group`, `Cancel`, Escape closes it, Tab stays inside it, light and dark. Confirm: you land on Home with `"<name>" was deleted.`, and the group is gone from Home and the Groups tab.
59. **User check, web, second browser profile:** with a second account in the same group, have the group open. After the first account deletes it, switch back to that window (focus refetch): it shows `This group was deleted` and `Go home`.
60. **User check, phone (blocked until the phone can reach Supabase):** on a development build, the device reaches the backend through the Mac's LAN IP (with matching OAuth redirect URLs in `supabase/config.toml`) or the hosted project. `127.0.0.1` is the phone itself. Then repeat 58 on iOS: VoiceOver lands on the dialog title, the dialog fits at the largest text size, and the disabled row reads its reason.

---

## Decisions (logged in `docs/decisions-to-review.md` § "2026-11-28 · Delete group")
| ID | Decision | Picked | Alternatives | Status |
|---|---|---|---|---|
| DG-1 | Confirm style | A centred in-app dialog (`ConfirmDialog`), an exception to the screen's inline-confirm rule | inline card (as Leave); `Alert.alert` | User's decision; exception logged |
| DG-2 | Soft or hard delete | Soft (`deleted_at`), restorable by SQL for 30 days, no restore UI | hard delete now | **Open (Q1)** |
| DG-3 | Purge job | Not built; a before-production item | `pg_cron` job now | **Open (Q2)** |
| DG-4 | What the DB checks | Member, not already deleted, fingerprint matches, no waiting receipt. No balance check | a SQL copy of the balance math | Open |
| DG-5 | Waiting receipts block deletion | Yes (C2a) | allow when nets are settled | **Open (Q4)** |
| DG-6 | "Settled" tolerance | Every member within 1¢ (`isSettledUp`, GR-3) | exactly 0 | **Open (Q3)** |
| DG-7 | Home notice lifetime | Until Dismiss or Home loses focus; no timer | auto-hide after a few seconds | Open (Q6) |
| DG-8 | Popup wording about undo | "You can't undo this in the app." (true for the user; restore needs the operator) | "This can't be undone."; mention 30-day restore | Open (Q7) |
| DG-9 | People links and profile visibility after delete | Unchanged: people who shared the group stay in "People you've split with" | drop links made only through that group | Open (Q5) |
| DG-10 | Invite link of a deleted group | The existing "This link doesn't work anymore" (`invalid_code`) | "This group was deleted" | Open |
| DG-11 | A deleted group's receipt opened by URL | The bill screen's existing no-access state; `lib/bills.ts` untouched | new "its group was deleted" copy | Open |
| DG-12 | Own retry after a lost answer | Success if `deleted_by` is the caller | always `group_deleted` | Open |
| DG-13 | Lock mode on the group row | `FOR UPDATE` (waits for in-flight group writes so the fingerprint sees them) | `FOR NO KEY UPDATE` as leave_group | Open (engineering) |
| DG-14 | Event or feed line | None | a `group_deleted` event | Open (follows the user's earlier "removed" answer) |

## Risks
- **R1 · Deploy order.** The snapshot parser requires `money_fingerprint`. If the app build reaches a database without T1, every group screen fails closed. It goes in before-production (15c).
- **R2 · A modified client can delete an unsettled group** (DG-4). It's recoverable only until a purge exists. If the user picks hard delete (Q1), this becomes unrecoverable, and the DB would need either a full SQL balance check (a second copy of C-G2, against ADR 0022) or to accept the risk.
- **R3 · `is_bill_participant` is widely used** (16 references). Adding a join to `groups` costs a little on every bill RLS check. T3's header records each caller. Watch the bill-screen read time in the live check.
- **R4 · Account deletion stays blocked** for members of deleted groups until a purge (15a).
- **R5 · Contract W might differ** between `bill_is_complete`/`bill_all_zero` and lib's C-G1 (attach's S1b comment). T1 checks this first.
- **R6 · Another session's exhaustive use of `GroupError`** may break typecheck (criterion 39).

## Open questions (only the user can decide)
- **Q1. Soft or hard delete?** The spec builds soft. Soft is recoverable and simpler, but rows stay forever unless purged. Hard frees the data and the account-deletion block straight away, but it's unrecoverable, needs the purge-order work now, and makes R2 permanent. *Recommend soft.*
- **Q2. Build the 30-day purge now?** (a) Later, as a before-production item (recommended; nothing is lost by waiting). (b) Now, with `pg_cron` (a free Supabase extension, to verify on your plan), plus the receipts decision (delete or detach).
- **Q3. 1¢ forgiveness.** A group can be deleted while two people are each 1¢ off, the same rule as "You're settled up" (GR-3). OK, or require exactly $0?
- **Q4. Waiting receipts block deletion?** The coordinator recommends yes ("Every receipt has to be fully claimed first"). The alternative is to allow it when balances are settled, but a waiting receipt counts as $0, so someone could be owed money for it. *Recommend yes.*
- **Q5. Does a deleted group still link its members** in "People you've split with" (and keep their Venmo usernames visible to each other)? *Recommend yes, keep (smallest change).* The alternative drops links that came only from that group.
- **Q6. Home notice:** stay until dismissed or you leave Home (recommended; better for screen readers), or fade after ~4 s?
- **Q7. Popup wording:** "You can't undo this in the app." (recommended, accurate under soft delete), "This can't be undone." (your original; not strictly true), or mention a 30-day restore through support (it would need a support path).

## Amendment A1 (2026-11-28, review by splitit-app-52, approved)
- **A1.1 (criterion, T6):** On an Activity screen that already loaded lines for a group, after that group is deleted, tapping one of those lines opens the group's deleted state (C8), not an error or a blank screen. The feed, its badge and the Groups dot need no code change: the RLS filters return no rows and `lib/feedSeen` prunes stale keys.
- **A1.2 (criterion, T4):** A write to a deleted group's receipt (`set_claim`, `mark_paid`, `assign_item`, `set_not_part`, `update_bill`, …) that the database refuses with 42501 reaches the screen as the existing "not allowed / bill unavailable" copy from `lib/bills.ts`, never as `network`. Verify the existing mapping; if `lib/bills.ts` needs a change, it is splitit-app-96's file, so send the change to that session rather than editing it.
- **A1.3 (confirmed, no change):** Contract F already covers a "Not received" undo between snapshot and delete: `payments` lists only rows with `undone_at is null`, so an undo changes the fingerprint.
- **A1.4 (T1–T3, requested by splitit-app-96):** If `private.is_bill_participant` is redefined, keep its signature, `security definer` and `search_path = ''`. The new write-refusing triggers must not fire for bills with no group. After `migration up`, the full `db:test` must pass, `bill_payments.test.sql` and `who_paid.test.sql` included.

## Amendment A2 (2026-11-28, user decision: hard delete). Wins over the body and A1 where they differ
User: "no soft delete … just hard delete since we show confirm popup". Q1 is closed as **hard delete**. Q2 (purge job) is gone.

- **A2.1 What `delete_group` does.** Same checks and order as contract D (member → locks → fingerprint, contract F → no waiting receipts, contract W). Then, in one transaction, it removes the group and everything in it, in an explicit FK-safe order (`expense_shares` and `group_payments` reference `group_members` with `on delete restrict`, and Postgres checks RESTRICT immediately, so the cascade order can't be relied on):
  `expense_shares → expenses → group_payments → the group's receipt bills (bills.group_id = the group; their children cascade: line_items, claims, bill_participants, bill_events, bill_payers, bill_payments, bill_payment_flags…) → group_hidden → groups` (the `groups` delete cascades `group_members` and `group_events`).
  T1 must list every FK into these tables (grep the migrations) and confirm the order, with a pgTAP test that a fully loaded group (expenses, shares, payments including `bill_mark`, a settled receipt with claims and payments, hidden rows, events) deletes cleanly and leaves 0 rows behind in every table.
- **A2.2 Receipts are deleted with the group**, not detached. They belong to the group (their money lives in `group_payments`), and detaching them would bring them back to Home as standalone bills with their payments gone.
- **A2.3 Append-only guards.** `group_events_append_only` already allows a DELETE once the group row is gone (the cascade). The same must hold for `bill_events` and any other append-only guard on a receipt's children. Use the existing "parent is gone" rule; add a narrow, named exception only if a guard blocks the order above. **Never disable triggers or set `session_replication_role`.**
- **A2.4 Dropped from the body:** `groups.deleted_at` / `deleted_by`, every "hide a deleted group" filter (`is_group_member`, `is_bill_participant`, `my_groups`, `group_snapshot`, `join_group`), and the triggers that freeze a deleted group's receipts (T2/T3 as written). After a hard delete the rows are gone, so the existing RLS and functions already return nothing (`not_found` / 0 rows / `invalid_code`). T2 and T3 are replaced by A2.1's pgTAP plus a check that these reads return the existing "not found" answers after a delete. `private.is_bill_participant` is not redefined.
- **A2.5 Concurrent writes.** A write that commits before the delete takes the group lock changes the fingerprint (refused, `group_changed`). A write that waits on the lock and runs after the delete finds no group and fails with its existing not-found / 42501 answer. T1's lock walk (contract L) covers `add_expense`, `record_payment`, `undo_payment`, `edit_expense`, `delete_expense`, `attach_bill_to_group`, `join_group`, `leave_group`, `set_claim`, `mark_paid` on a group bill.
- **A2.6 Account deletion (GR-26).** After a group is deleted its members no longer block deleting their accounts through that group. Update the before-production item.
- **A2.7 Risk, accepted by the user.** The database still can't verify "settled up" (ADR 0022 §4), and a hard delete can't be undone. The app gate (`canDeleteGroup`), the fingerprint and the confirm popup are the protection. Say so in before-production.
- **A2.8 Copy.** The popup body is the original: "Delete "<name>" for everyone? Its N expenses, N receipts and payment history will be removed for all N members. This can't be undone." Q7 is closed. The screen's C8 deleted state stays (shown when the group is gone mid-view: `group_snapshot` answers not-found).
- **A2.9 Error words.** An already-deleted group can no longer be told apart from "not a member": both read as `not_found` (C8 / "This group was deleted" on the group screen). `group_deleted` is dropped.
- **A2.10 Contract W: the SQL rule gains lib's even-split case (T1 finding, coordinator-approved).** `not bill_is_complete or bill_all_zero` disagreed with lib in one case. `bill_all_zero` covers proportional mode only (item rows add up to $0, extras ≠ 0). lib also waits on an **even-split** bill where nobody has a claim on an item row (on a complete bill: it has no item rows) and the extras (total − every row) aren't 0, because nobody is left to carry them. That covers W7 (no rows, total > $0) and a bill with only claimed discount rows. So `private.group_bill_waiting` = `not bill_is_complete(b) or bill_all_zero(b) or (extras_split = 'equal' and total − Σ rows ≠ 0 and no claim on an item row)`. `bill_is_complete` and `bill_all_zero` are unchanged. lib's answers, recorded from `groupBalances` on 2026-11-28, for both modes:
  - W1 and W6: not waiting.
  - W2, W3 and W5: waiting.
  - W4 (every row $0 and claimed, total > $0): waiting when proportional, **not waiting when even** (the claimers carry the extras). With a $0 total it's not waiting in either mode.
  - W7 with total > $0: waiting in both modes. With a $0 total: not waiting.
  - Discount rows only, claimed, with total − rows ≠ 0: waiting in both modes.

  pgTAP asserts all 22 against `group_bill_waiting`. T4's `lib/groupView.test.ts` should use the same rows, including the even-split W4, W7 and discount-only cases.
- **A2.11 Retry after a lost answer (replaces criterion 4 and the retry part of criterion 45).** A `delete_group` retry finds no group and gets `42501`, the same answer as for a non-member (A2.9). There is no "deleted by me, success" path any more (contract D rows 5–6 and DG-12 are dropped).
  - Criterion 4 becomes: "Calling it again after a successful delete, by the same member or anyone else, gets `42501` (the group is gone)."
  - Criterion 45's retry sentence becomes: "A retry after a delete that did go through gets `not_allowed` / not found. The screen treats that as done: the dialog closes and it shows C8 (`This group was deleted` + `Go home`), with no error line. The test fakes that answer and expects C8, and no second call."
  - `not_allowed` from `delete_group` therefore closes the dialog and shows C8, not `GROUP_ERROR_COPY.not_allowed`. A real non-member can't reach the dialog, because the snapshot would already have refused them.
- **A2.12 Locking and `23503` (T1, option A, coordinator-approved).** A hard delete removes `group_members` rows while holding the group row, so B2a (`20261126082511_groups.sql`) applies. Before this change, the five money writes (`add_expense`, `edit_expense`, `delete_expense`, `record_payment`, `undo_payment`) wrote their own rows first (KEY SHARE on member rows, or a row lock on the expense or payment) and reached the group row only at their event insert. Against `delete_group` that is a `40P01` cycle.
  - T1 re-creates the five with **FOR KEY SHARE on the group row as their first lock**, then "the group still exists" (else `42501`). Nothing else changes. A write already holding the lock makes `delete_group` wait, and the fingerprint then refuses (`group_changed`). A write that comes after waits, then finds no group (`42501`). KEY SHARE doesn't conflict with the FOR NO KEY UPDATE that `leave_group`, `join_group` and `attach` take, so their order is unchanged. Two existing body-text assertions ("money writes take no explicit group lock", in `group_expenses.test.sql` and `group_payments.test.sql`) are updated to "exactly one group lock, FOR KEY SHARE".
  - RESTRICT is checked at each row delete (shown in pgTAP: without the explicit `expense_shares`/`expenses` deletes, the loaded delete fails). That is why the deletes run child-first. Correction to the order's reasoning: `group_payments.bill_id` is `ON DELETE SET NULL` in the live schema, not "no action". `group_payments` still goes before the bills, so a `bill_mark` payment is never left behind without its bill.
  - A `23503` during the deletes would mean a writer slipped past contract L. It is mapped to `22023 group_changed` (unreachable while every writer locks the group first).
  - The account-deletion cascade (payer-reset trigger, then `groups.created_by` set null) can still deadlock with `delete_group` and with `leave_group`. That is accepted for now: it's admin-only, fails anyway on `group_members`' restrict, and is listed in `docs/before-production.md`.

## Amendment A3 (2026-11-28, user: a clash must read as "please retry", never a crash)
User: "expose this error to the user in a nice way for eg - action failed-please retry - app shouldnt crash or anything".

- **A3.1 New error word `busy`** in `GroupError` (T4, `lib/groups.ts`): SQLSTATE `40P01` (deadlock detected), `40001` (serialization failure) and `55P03` (lock not available) map to `busy` for **every** group function, reads included, before the per-function maps. Today they fall through to `network`, whose copy wrongly blames the connection.
- **A3.2 Copy:** `GROUP_ERROR_COPY.busy` = `That didn't go through. Please try again.` Shown where that write's error already shows (inline, alert), with the control released so the person can tap again. No automatic retry (a write carries its client id, so a manual retry is safe; `delete_group` re-checks everything).
- **A3.3 Never a crash:** every group write and read wrapper resolves to `{ error }` for a thrown or rejected rpc, a timeout, a non-JSON body or an unknown code (already true for `network`; T4 adds tests for `busy` and for a thrown error object with a `code` of `40P01`). Screen tests (T5/T6) show one `busy` refusal per write kind on the group screen and the dialog: the message appears, the button is enabled again, nothing navigates, no unhandled rejection (`jest` fails on one).
- **A3.4 Bills too (other session):** the same three codes on bill writes in `lib/bills.ts` (splitit-app-96's file) should read the same way. Sent to that session as a request; not edited here.
