# 0027: Deleting a group

**Status:** Accepted (2026-11-28, spec `docs/specs/2026-11-28-delete-group.md`, as changed by Amendments A2 and A3). Migration `supabase/migrations/20261128100232_group_delete.sql`, with 98 pgTAP tests in `supabase/tests/database/delete_group.test.sql`. The full pgTAP suite passed afterwards (33 files, 2305 tests, run after the later username lock migration too). The delete-group Jest files pass (for example `__tests__/deleteGroup.test.tsx` 60, `__tests__/groupDeletedScreens.test.tsx` 24, `lib/groups.test.ts` 570). The full Jest suite is being run separately and isn't claimed here. Code review approved; QA passed overall. Still open: one weak pgTAP assertion (QA #42, "stale wins over waiting" has no real waiting receipt; the case was checked live, and the test fix is pending), and user checks 58–60 (dark mode, 200% zoom, a real phone) haven't been run.

*Numbering note:* 0027 was reserved with a stub on 2026-11-28 by this spec. This file fills that stub in place.

## Context
A finished trip stays in everyone's Home and Groups lists forever. The user asked for a way to delete it, with three rules (spec, "The user's decisions"):
1. **Any member** can delete a group, but **only once everyone is settled up**.
2. It's deleted **for everyone**.
3. Tapping Delete opens a **popup** to confirm.

The hard part is rule 1. Group balances are worked out only in `lib/`, never in SQL ([ADR 0022](0022-groups.md) §4). Receipt shares need the split math, and a second copy in SQL could drift. So the database **can't check "everyone is settled up"** itself.

## Options
- **Soft delete** (set `groups.deleted_at`, hide the group everywhere, restore by SQL for 30 days). The spec's first default: a mistaken delete could be undone. It needed a hiding filter in every read, triggers to freeze the group's receipts, and a purge job later.
- **Hard delete** (remove the rows). Nothing to restore. No filters, no purge job. It frees the members' accounts at once (group membership blocks account deletion, GR-26).

## Decision

### 1. Hard delete, receipts included (DG-17, A2.1, A2.2)
The user chose **hard delete**: "just hard delete since we show confirm popup". The confirm popup is the safeguard. One `delete_group` call removes the group and everything in it in one transaction: expenses, shares, payments, hidden flags, members, events, and **the group's receipts** with all their rows.

Receipts are deleted, not detached. Their money lives in the group's payments. A detached receipt would come back to Home as a standalone bill with its payments gone, asking people for money they already paid.

### 2. Three checks, because the database can't check balances (DG-4, A2.7)
Who protects "only when settled":
- **The app gate.** `canDeleteGroup` in `lib/groupView.ts` (contract S). If any receipt is waiting, the answer is `receipts_waiting`. That's checked first, because a waiting receipt counts as $0, so the balances can look settled while it waits. If any member's net is more than 1¢ off (`isSettledUp`), the answer is `not_settled`. Otherwise ok. When it isn't ok, the Delete row is disabled and shows the reason.
- **The money fingerprint (contract F).** `group_snapshot` returns `money_fingerprint`: an md5 of everything the balances read (members, each receipt's payer, total, split mode, rows and claims, live expenses and their versions, live payments). The app sends back exactly the string from the snapshot on screen. `delete_group` recomputes it under its locks. If they differ, it refuses with `22023 group_changed`. So the database knows the screen judged "settled" on **this exact money state**. It's a staleness check, not security ([stale-state checks](../concepts/stale-state-checks.md)).
- **No waiting receipts (contract W).** `delete_group` refuses with `22023 receipts_waiting` if any receipt is waiting. This is the same rule in `lib/` and SQL (`private.group_bill_waiting`), tested on the same 22 cases on both sides. Building it found one difference: lib also waits on an **even-split** bill where nobody claimed an item but the extras aren't $0 (nobody is left to carry them). The SQL helper was written to match lib (A2.10).

**Accepted risk.** A modified app could still delete an unsettled group, and a hard delete can't be undone. The user accepted this; it's listed in `docs/before-production.md`.

### 3. A delete order that respects the foreign keys (A2.1)
Several tables point at `group_members` with `ON DELETE RESTRICT`. Postgres checks RESTRICT at once, at each row delete, so we can't let one cascade sort it out. `delete_group` deletes child-first:

`expense_shares → expenses → group_payments → the group's bills (their rows cascade) → group_hidden → groups` (which cascades `group_members` and `group_events`).

`group_payments` goes before the bills, so a payment that came from a receipt's "I paid" is never left without its bill. The append-only guards on `group_events` and `bill_events` already allow a delete once the parent is gone, so no trigger was disabled or given a new exception (A2.3).

### 4. The money writes lock the group first (A2.5, A2.12)
Before this, the five money writes (`add_expense`, `edit_expense`, `delete_expense`, `record_payment`, `undo_payment`) wrote their own rows first and reached the group row last. `delete_group` takes the group row first and then deletes those rows. Opposite orders cause a **deadlock** (`40P01`): each waits for the other.

So the five writes now take **`FOR KEY SHARE` on the group row as their first lock**. Then:
- a write that got there first makes `delete_group` wait. The fingerprint then sees it and refuses (`group_changed`);
- a write that comes second waits, then finds no group and gets its normal `42501`.

`FOR KEY SHARE` doesn't clash with the `FOR NO KEY UPDATE` that `leave_group`, `join_group` and attach take, so nothing else waits more than before. See [database functions](../concepts/database-functions.md), "Deleting a group".

**Accepted cycle.** Deleting an auth account can still deadlock with `delete_group` (and already could with `leave_group`), if the person created the group and pays one of its bills. Account deletion isn't built yet, and it's admin-only. It's in `docs/before-production.md`: that feature must take group locks first, or retry.

### 5. A clash reads as "try again" (A3, DG-18)
Deadlocks and lock timeouts (`40P01`, `40001`, `55P03`) map to a new error, `busy`, for every group call. The copy is **"That didn't go through. Please try again."**, with the button released. Before, they read as `network` ("Check your connection"), which blamed the wrong thing. There's no automatic retry. Every wrapper resolves to `{ error }`, never a throw.

### 6. A popup, as an exception to inline confirms (DG-1, review R1)
The group screen's rule is "inline confirms, no modal". The user asked for a popup here, so `components/ConfirmDialog.tsx` is the one exception. It's an in-app React Native `Modal`, not `Alert.alert`, so it works on web too. When it opens, focus lands on the **title**, not on the red button. On web, react-native-web would otherwise focus the first button, `Delete group`, and a stray Enter would delete (review R1). Cancel, a tap outside, Android back and Escape close it, except while the delete is running.

### 7. "This group was deleted" and `?from=feed` (A2.9, DG-T4-2, DG-T6-1)
After a hard delete, the database can't tell "this group was deleted" from "you're not a member": both answer `42501`. So the app shows **"This group was deleted"** only when it knows you were a member:
- the screen already showed the group and a refetch is refused; or
- you opened it from an Activity line (`/groups/<id>?from=feed`), since the feed only showed you lines of groups you were in.

A first load from anywhere else shows the normal not-a-member words. **Limit:** someone who left the group on another device and taps an old Activity line also sees "This group was deleted". A retry of your own delete after a lost answer also gets `42501`, and the screen treats that as done (A2.11).

## Consequences
- Deleting is quick and final. There's no restore and no purge job.
- Links made only through that group disappear from "People you've split with", because the member rows and shared receipts are gone. This changes DG-9's "unchanged" answer, which assumed soft delete ([people and membership](../concepts/people-and-membership.md)).
- Members of a deleted group no longer have rows that block their account deletion (A2.6).
- The snapshot parser requires `money_fingerprint`, so the migration must ship before the app build (`docs/before-production.md`).
- No event or feed line is written for a delete (DG-14).

## Code (by name, since line numbers move)
- `supabase/migrations/20261128100232_group_delete.sql`: `public.delete_group`, `private.group_money_fingerprint`, `private.group_bill_waiting`, `public.group_snapshot` (adds `money_fingerprint`), and the five money writes re-created with the group lock. The header has the full lock walk and FK list.
- `lib/groups.ts`: `deleteGroup`, `GROUP_ERROR_COPY.busy`. The busy codes and copy are shared with bills: `BUSY_SQLSTATES`, `BUSY_COPY`, `isBusyError` in `lib/bills.ts`.
- `lib/groupView.ts`: `canDeleteGroup`.
- `lib/groupScreenText.ts`: `deleteConfirmText`, `deleteRefusal`.
- `lib/useGroupSnapshot.ts`: the `deleted` load state. `lib/groupDeletedNotice.ts`: the one-time Home notice.
- `components/ConfirmDialog.tsx`, `components/DeleteGroupRow.tsx`, `components/GroupDeletedState.tsx`, `components/GroupDeletedNotice.tsx`.
- `app/(app)/groups/[id]/index.tsx` (`fromFeed`), `app/(app)/(tabs)/activity.tsx` (opens group lines with `?from=feed`).
- Tests: `supabase/tests/database/delete_group.test.sql`, `__tests__/deleteGroup.test.tsx`, `__tests__/groupDeletedScreens.test.tsx`, `__tests__/confirmDialogWeb.test.tsx`, `lib/groups.test.ts`, `lib/groupView.test.ts`, `lib/groupScreenText.test.ts`.
