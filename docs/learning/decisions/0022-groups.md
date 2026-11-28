# 0022: Groups — group-level balances and settling

**Status:** Accepted (2026-11-27, spec `docs/specs/2026-11-26-groups-mvp.md` and its Amendments A1–A4; staff-engineer review `docs/specs/2026-11-26-groups-mvp-eng.md`). Amends [0015](0015-settling-one-payer-self-reported-marks.md) (a bill inside a group has no per-bill settling) and [0021](0021-settling-early-and-paying-differences.md) (early settling and differences don't apply to group bills; existing marks become group payments). For group bills only, it also departs from the `CLAUDE.md` convention "users write only their own claims" (approved by the user; the wording change is proposed in `docs/lessons/proposals/2026-11-27-groups-claude-md.md`). Built as tasks T1–T18; the live reconciliation passed 115/115 checks (A3) and the code review approved (A4). Several money and privacy decisions are still waiting for the user's look in `docs/decisions-to-review.md` § "2026-11-26 · Groups" (GR-2, GR-3, GR-4, GR-5, GR-9, GR-A1, GR-14, GR-26). The phone and Venmo user checks (criteria 65, 79, 83, 87, 129, 130) haven't been run.

**Amended by:** `docs/specs/2026-11-27-group-claim-status.md` (2026-11-27; decisions GCS-1 … GCS-15). See "Amendment 2026-11-27: group claim status" at the end.

## Context
Before groups, every bill settled on its own: one payer, and everyone else paid that payer (0015, 0021). That works for one dinner. It doesn't work for a trip.

Picture a Tahoe weekend. Ana pays for dinner. Ben pays for brunch. Ana also pays $240 for the Airbnb, with no receipt to scan. Dee rents the car. Settling each bill on its own means a pile of small Venmo payments that often cancel out: Ben pays Ana for dinner while Ana pays Ben for brunch. People want one short list at the end: "Cy pays Dee $174.97, Ben pays Ana $130.02".

So a group needs three things a bill doesn't have:
- **Quick expenses** ("Ana paid $240 for the Airbnb") next to item-by-item receipts.
- **Balances across everything**, not per bill.
- **A short list of payments** that settles the whole group.

The user made the main decisions on 2026-11-26 (spec "User decisions", U-G1 … U-G7). The main session picked three more (GR-M1 … GR-M3). Everything else was decided under the user's "keep building, log decisions" rule and logged as GR-….

## Options
| Question | Options considered | Chosen |
|---|---|---|
| How does a bill inside a group settle? | Per bill as before, plus group expenses separately; both at once; **only at group level** | Only at group level (U-G1). Existing "I paid" marks become group payments when the bill moves in |
| Who can be in a group? | Placeholder members with no account ("Dee (not on SplitIt)"); **everyone signs in** | Everyone signs in (U-G2). [ADR 0004](0004-required-accounts.md) unchanged |
| When does a receipt count toward balances? | Early, like 0021's proportional rule (unclaimed items sit with the payer); **only once fully claimed** | Only once fully claimed (U-G3). Until then it adds nothing to anyone |
| What do people see on Settle up? | Every pairwise debt; "pay only people you owe"; **simplified payments**, with the detail one tap away | Simplified payments by default, with "Who paid what" one tap away (U-G4) |
| Who decides who had an item on a group bill? | Each person for themselves (today's rule); only the host; **any group member** | Any group member, through `assign_item` (U-G6, GR-A1) |
| What do members share with each other? | Only names; **names, Venmo usernames, and being linked for "People you've split with"** | All three (U-G5). The group name goes in Venmo notes, behind an off switch |
| How can an expense be split? | Equal, Exact, Shares, percentages; **Equal and Exact** | Equal and Exact for the MVP (GR-M1). Shares later |
| Who may edit or delete an expense? | Any member; **its creator or its payer** | Creator or payer (GR-M2) |
| How is a group payment recorded? | Contract O ("Did you pay? → I paid"); **the same as Sent via Venmo**: opening the Pay link records it | Same as Sent via Venmo (U-G7, Amendment A2; [ADR 0024](0024-sent-via-venmo-and-payment-methods.md)) |
| Reminders to pay? | Push reminders; **none in the MVP** | None (GR-M3). They'd need a server or a scheduled job, which is the user's backend decision ([ADR 0010](0010-on-device-ocr-no-custom-backend.md)) |
| Where are balances computed? | In SQL (a second copy of the split math); client-written share snapshots; **in `lib/`, from one snapshot read** | In `lib/` (GR-2). The database stores costs and payments, not balances |

## Decision

### 1. A group and its members
- A group has a name (1–60 characters), a join link (`/g/<code>`, 20 random hex characters made by the database), and members. Anyone can create one with `create_group`.
- **People join by link or QR only** (`join_group`). Nobody is put in a group without opening its link (GR-16). There's no "remove member" (GR-17). People leave themselves, and only when they have no history in the group (C-G10). Anyone can hide a group just for themselves.
- **Everyone signs in** (U-G2). No placeholder members.
- A group has at most 50 members (`22023 group_full`).
- Any member can rename the group or make a new link (GR-23). Both are logged in the group's Activity.

### 2. Group-level settling only (U-G1; amends 0015)
A bill can belong to a group (`bills.group_id`). The host moves a bill in with `attach_bill_to_group`, or starts a receipt from the group screen. Every group member then becomes a participant of that bill.

**A bill in a group stops settling on its own.** It has no Pay, no "I paid", no Request and no payer marks. Its footer and Settle screen say "Settled in Tahoe trip" with a link to the group. The money from that bill reaches people only through the group's balances.

The database enforces this with **triggers on `bill_participants`** (GR-10), each raising `22023 in_group`:
- a mark can't be set on a group bill's participant row (so `mark_paid` and `settle_difference` refuse, whatever their current signatures);
- a non-member can't be inserted as a participant (so `join_bill` and `add_participant` refuse non-members);
- a member's participant row can't be deleted while they're still a member (so `remove_participant` and `leave_bill` refuse).

Triggers were chosen over rewriting those six functions because the Sent via Venmo work was rewriting some of them at the same time. A trigger holds whatever the function bodies end up being, and lives in one place.

**Existing marks become group payments.** If Cy had marked "I paid $9.50" to Ben on brunch before it moved in, `attach_bill_to_group` turns that mark into a group payment from Cy to Ben for $9.50, with `source = 'bill_mark'` and the mark's payment method. Then it clears the mark. So nobody's payment is lost, and nobody is asked to pay twice.
- A bill **with marks** that isn't fully claimed (or is all-$0) can't move in: `22023 not_complete` ("Finish claiming before moving it into the group."). A bill without marks can move in while incomplete.
- **Detach is refused while those payments are live** (GR-9). `detach_bill_from_group` raises `22023 has_bill_payments` until the converted payments are undone. Otherwise the payment would count in the group, and the bill, back on its own, would ask for the same money again.
- After a detach, the bill shows on Home for every member who was added to it through the group, because they stay participants (N7).

A group bill keeps **one payer** (GR-M5). The host can still change who that is, to another member; a composite foreign key (`bills (group_id, payer_id) → group_members`) keeps the payer a member. What that does to balances is explained in the [group balances](../concepts/group-balances.md) note ("Changing the payer of a group bill").

### 3. A receipt counts only once it's fully claimed (U-G3; amends 0021 for group bills)
A group bill **counts** toward balances only when every row has a claim and nothing is left unassigned (this also excludes the all-$0 bill, rule Z). Until then it adds nothing to anyone's balance. Unclaimed items never count against the payer. The group shows a waiting line instead, for example "Hana's receipt: 2 items left to claim", and Settle up shows "Balances don't include Hana's receipt yet: …" above the suggestions.

This **replaces** 0021's early settling for group bills. 0021 let someone pay early on a proportional bill because their own share was stable. In a group there's no per-bill payment to make early, and counting half a receipt would put a guess into everyone's balance.

### 4. Balances and suggested payments (U-G4)
- Each member's **net** is what they paid, minus their share, plus what they sent, minus what they received. The nets always add up to exactly $0.
- **Settle up shows simplified payments**: a greedy list, at most one fewer payment than the number of people with a non-zero net. **"Who paid what"** (paid, share, payments and net per person, and each person's costs) is one tap away.
- Payments of 1¢ or less between two people who are both within 1¢ of settled are hidden (`GROUP_IGNORE_CENTS = 1`, GR-3, a starting value). Those people read "You're settled up", while "Who paid what" still shows their exact cents.

The math, with a worked example, is in the [group balances](../concepts/group-balances.md) concept note.

**These three rules live only in `lib/`, on purpose** (C-G1 "which bills count", C-G2 "balance", C-G3 "suggested payments"). The database never computes a balance, so there is no second copy that could drift. `CLAUDE.md` asks that a money rule enforced on both sides be the same rule on both sides. These rules are enforced on one side only, and that's not a gap to fill later (the K6 lesson in 0015 §6). Money still can't be lost: every cost and payment is stored exactly, and the database checks each one.

### 5. Expenses: Equal and Exact (GR-M1, GR-M2)
- An expense has a title, an amount, a payer (a member) and a split.
- **Equally**, among the members you pick: largest-remainder rounding, leftover cents to the lowest user ids (GR-4). The database computes the cents itself, with `private.allocate`, the same algorithm as `allocate` in `lib/split.ts`. Both sides run the same table of cases (C-G4), as `CLAUDE.md` asks. Example: $10.00 among three people gives $3.34, $3.33, $3.33.
- **Exact amounts**, typed per person: they must add up to the cent, with no ±1¢ tolerance (GR-5). Typed amounts have no rounding, so any gap is a typo. People left blank owe nothing; a typed $0 is refused with "Leave it blank if they don't owe anything".
- Shares ("2 shares for the couple") are out of the MVP.
- **Only the expense's creator or its current payer can edit or delete it** (GR-M2). Others see it read-only. Edits carry a version number, so a stale screen is refused with `version_changed` ([stale-state checks](../concepts/stale-state-checks.md)). Deleting is soft: the row stays for history but stops counting.

### 6. Group payments follow Sent via Venmo (U-G7, Amendment A2)
- For your own suggested payment, **Pay opens Venmo and records the payment** the same way a bill payment does under [ADR 0024](0024-sent-via-venmo-and-payment-methods.md): record then open on phones, open then check on mobile web, open then ask "Did you send Dee $174.97?" on desktop web. "Didn't go through? Undo" undoes your own record.
- A payment has a **method** (how the money went: `venmo`, `cash`, `other`, the same list as 0024) and a **source** (how the record was made: `venmo_link`, `manual`, or `bill_mark` from a converted mark). Clients can't send `bill_mark`.
- The person owed can tap **"Not received"**, which undoes the payment and tells the sender "Dee hasn't received your $174.97. Check Venmo before paying again." (GR-P3).
- "Record a payment" covers partial payments and cash. Either side can undo.
- **No local check-in notification** for group payments in the MVP, only the inline "Did your $174.97 to Dee go through?" when you come back (GR-P2).
- So contract O ("Did you pay? → I paid", 0021 §6) is only the fallback here too, as in 0024.
- **The Venmo note is "SplitIt: <group name>"** (U-G5, GR-14), because Venmo notes can be public. One switch, `GROUP_VENMO_NOTE_INCLUDES_NAME` in `lib/groupSettleView.ts`, turns it back into plain "SplitIt". Control characters are stripped from the name first (`cleanNoteName`).

### 7. Any member can assign items on a group bill (U-G6, GR-A1)
On a friend trip, Ana often remembers what Ben ate better than Ben does. So on a bill in a group, **any member can set who had an item**, not only claim it for themselves. The item sheet shows "Who had this?" with one chip per member.
- It's one database function, `assign_item`. It sets the whole list of claimers for one row and takes the list the screen showed (`p_expected`). If someone changed the row in the meantime, it refuses with `claims_changed` ([stale-state checks](../concepts/stale-state-checks.md)).
- Every change is in the bill's Activity: "Ana assigned Tacos to Ben", "Ana removed you from Tacos".
- Any member can reassign or remove anyone's claim (GR-A1). The alternative (only the assigner or the assignee may change an assigned claim) needs an `assigned_by` column and more rules.
- **Bills outside a group keep today's rule**: you write only your own claims. `set_claim`, `set_item_split` and the claims RLS policies are unchanged.

This is the one place groups depart from a `CLAUDE.md` convention. It's a definer-only write (no new table grant), described in [row level security](../concepts/row-level-security.md) and [database functions](../concepts/database-functions.md).

### 8. Privacy (U-G5)
- **Joining a group counts for "People you've split with"** (rule L1, [ADR 0016](0016-people-come-from-shared-bills.md)). Two co-members with no shared bill each see the other, with the caption "In a group together".
- **Members see each other's Venmo usernames** (and names), even with no shared bill. Profiles' row policy now allows co-members as well as co-participants. Column grants on `profiles` didn't change.
- Members see every group bill's items and claims, including bills from days they weren't there.
- The group name goes in Venmo notes, behind the off switch (§6).

### 9. Not in the MVP
No push reminders (GR-M3). No Realtime on group screens (GR-21): they refetch when they come into view and after each write, while bill screens keep their Realtime. No placeholder members, no Shares split, no multi-currency (USD only), no fewest-payments solver, no "pay only people you owe" view.

## How this relates to 0015 and 0021
Both stay in force for bills that aren't in a group. For a bill in a group:

| 0015 / 0021 said | 0022 says, for group bills |
|---|---|
| Everyone except the payer pays the payer for this bill (0015 §1) | Nobody pays for this bill on its own. It adds to group balances, and people pay the group's suggested payments |
| People mark "I paid" themselves (0015 §2) | No marks. Triggers refuse them with `in_group`. Marks that existed when the bill moved in became group payments (`bill_mark`) |
| Changing the payer clears every mark (0015 §3) | No marks to clear. The bill's total moves to the new payer's "paid"; old `bill_mark` payments stay with the person who received them |
| You can pay early on a proportional bill once you've claimed an item (0021 §1) | The bill counts only once it's fully claimed, and there's no early payment |
| Differences have their own buttons (`settle_difference`, 0021 §3) | Not used. A change after people paid just changes balances, and the next suggestion covers it |
| "Did you pay?" follows the payer and the mark (0021 §6; already the fallback under 0024) | Group payments follow 0024's flow, with the group's own payments table |
| You write only your own claims (`CLAUDE.md`) | Any member may set who had an item, through `assign_item` |

So 0015 and 0021 are amended, not superseded.

## Consequences
- **One unclaimed item holds a whole receipt out of every balance** (U-G3). An unclaimed $0.00 water or a discount nobody wants keeps it waiting too (S9). With assignments, any member can finish it, and the waiting line names the missing rows.
- **A receipt that stops being complete swings everyone's balance** (S1). If Cy unclaims the nachos after people paid, dinner stops counting and the suggestions change (worked example W7 in the spec). The notice on Settle up explains it. Keeping the last complete state would need stored snapshots.
- **Greedy suggestions can route money between people who never shared a cost.** That's correct (balances are group-wide) but can surprise people. See the concept note.
- **Account deletion is blocked for anyone in a group** (GR-26). Group members and money rows reference people with `on delete restrict`, and someone with history can't leave. Account deletion needs a design for group history before it ships (`docs/before-production.md` §6).
- **Group links travel.** Every member can see the join code and make a new link (GR-23). Anyone the link reaches can join and read the group's bills, names and Venmo usernames.
- **Co-members are linked** (GR-N5), so a host can add a co-member to any bill outside the group without that person opening a link.
- **One read per group screen.** `group_snapshot` returns everything in one statement (one consistent view of the data), and `lib/groups.ts` parses it strictly: anything off fails closed as a network error, never a partial balance. For a 40-bill × 30-row × 6-claimer group the spec expected a payload of about 0.35–0.45 MB (A1.7; the measured figure from T6 wasn't in the files this ADR was written from). Its size against the hosted project's limits is a before-production check.
- **Still no custom backend.** Everything is SQL functions in Supabase plus pure code in `lib/` ([ADR 0013](0013-writes-through-database-functions.md)). No new secrets, no Edge Function.
- **Payments stay an honor system**, as in 0015: "Sent via Venmo" means the app opened Venmo, not that money arrived.

## Code (by name, since line numbers move)
- Balances and suggestions: `groupBalances`, `netsOf` in `lib/groupBalance.ts`; `simplify`, `isSettledUp`, `GROUP_IGNORE_CENTS` in `lib/simplify.ts`. Tests: `lib/groupBalance.test.ts`, `lib/simplify.test.ts`, fixtures in `test-utils/groupFixtures.ts` (W1–W7).
- Expense form rules: `equalPreview`, `exactCheck`, `validateExpense`, `expensePayload`, `normalizeTitle` in `lib/groupExpense.ts`.
- Data layer and snapshot parser: `fetchGroupSnapshot`, `balanceInputOf`, `recordPayment`, `assignItem`, `attachBillToGroup`, `newClientId` and the other wrappers in `lib/groups.ts`.
- Screen models: `groupScreen`, `waitingLines`, `canLeaveGroup` in `lib/groupView.ts`; `groupSettle`, `whoPaidWhat`, `groupSendPlan`, `cleanNoteName`, `GROUP_VENMO_NOTE_INCLUDES_NAME` in `lib/groupSettleView.ts`; `describeGroupEvent` in `lib/groupActivityText.ts`; `toggleAssignee`, `assignChips` in `lib/itemAssign.ts`.
- Database: `supabase/migrations/20261126082511_groups.sql` (groups, members, events, `create_group`, `join_group`, `leave_group`), `20261126085945_group_expenses.sql` (`private.allocate`, expenses), `20261126090704_group_payments.sql` (`record_payment`, `undo_payment`), `20261127060131_group_bills.sql` (attach, detach, the `in_group` triggers, `my_bills()` without group bills), `20261127061004_group_snapshot.sql` (`group_snapshot`), `20261127062139_assign_item.sql` (`assign_item`, the `assigned` / `unassigned` events). Tests: the matching files in `supabase/tests/database/`.
- Screens: `app/(app)/groups/`, `app/g/[code].tsx`, `app/(app)/bills/[id]/group.tsx`, `components/AssignChips.tsx`, `components/GroupPayCard.tsx`, `components/BillGroupLine.tsx`.

Concept notes: [group balances](../concepts/group-balances.md), [money and rounding](../concepts/money-and-rounding.md), [stale-state checks](../concepts/stale-state-checks.md), [database functions](../concepts/database-functions.md), [row level security](../concepts/row-level-security.md), [people and membership](../concepts/people-and-membership.md).

## Amendment 2026-11-27: group claim status
*Added by the docs task (T7) of `docs/specs/2026-11-27-group-claim-status.md`. The decisions above are unchanged; this adds to them. Every choice here was made without asking (the "build without blocking" rule) and is logged as GCS-1 … GCS-15 in `docs/decisions-to-review.md` § "2026-11-27 · Group claim status", waiting for the user's look.*

**What was added.**
- **"Needs you."** A group bill needs Ben when some row has no claimer, Ben has no claim on any row, and Ben hasn't said "I wasn't part of this" (spec C1, GCS-1). Claims always win over an old opt-out.
- **"I wasn't part of this"**, per bill, not per item (GCS-2). Ben taps it on the group screen or on the bill screen, and the reminders stop. "Undo" brings them back.
- **Home's group rows now say one thing about *me***, first match wins: "Claim your items on 1 bill", "You owe $12.50", "You're owed $8.00", "2 items left to claim", "Settled up" (spec C2). This **reverses GR-20** ("no balances on Home's group rows") at the user's request (GCS-5). "Settled up" now means *I'm* within 1¢ and nothing is waiting, not "every member is settled" (GCS-6).
- **A slight yellow tint** (the existing `warningSurface` token) on the group screen's rows for bills that need me, and on each unclaimed item inside a group bill (GCS-7, GCS-8, GCS-14). Words always go with the tint.

**What didn't change: money.** Saying "I wasn't part of this" changes no share, no balance and no suggested payment. A receipt still counts only once every row is claimed (§3, U-G3). If Ben opts out of the dinner and nobody claims the nachos, the dinner still waits, for everyone.

**Storage.** One owner-only table, `public.bill_not_part (bill_id, user_id, created_at)`, in `supabase/migrations/20261127150000_bill_not_part.sql`:
- each person can read only their own rows, and nobody can write it directly (`42501`);
- the only writer is the definer function `set_not_part(bill, not_part)`; it refuses with `has_claims` if you've claimed something, and with `not_in_group` on a bill outside a group;
- a trigger on `claims`, `claims_clear_not_part`, deletes your row as soon as you get a claim, including when someone else assigns you an item (GCS-4);
- no Activity line, no Realtime message, and nobody else sees it (GCS-3).

The same migration re-creates `group_snapshot` (replacing the definition in `20261127061004_group_snapshot.sql`): its `me` gains `not_part_bill_ids`, the caller's own opt-outs. Details are in [row level security](../concepts/row-level-security.md) and [group balances](../concepts/group-balances.md).

**Consequences.**
- **Deploy order** (spec R1). The app's snapshot parser now requires `me.not_part_bill_ids`, so the migration must reach a database before an app build that has the new parser. Otherwise every group screen fails and Home shows only people counts. Tracked in `docs/before-production.md` §4.
- **An opt-out survives a detach** (GCS-11). If a bill leaves the group and comes back, an old "not part" applies again. Rare, and it only hides a reminder.
- **One more lock path for account deletion.** `set_not_part` holds the bill (`FOR KEY SHARE`) while it waits for the caller's participant row. That's the opposite order from the payer-deletion trigger, so it joins the R9 item in `docs/before-production.md` §6.

**Code (by name):** `billNeedsViewer`, `rowsOfSnapshotBill`, `rowsOfBillData`, `snapshotBillNeedsViewer`, `GROUP_CLAIM_COPY` in `lib/groupClaimStatus.ts`; `groupHomeStatus` in `lib/groupHomeView.ts`; `setNotPart`, `fetchNotPart` and the `me.notPartBillIds` parser in `lib/groups.ts`; `useNotPart` in `lib/useNotPart.ts`; `components/GroupWaitingRow.tsx`, `components/NotPartLine.tsx`, the `highlight` prop of `components/ClaimItemRow.tsx`. Tests: `lib/groupClaimStatus.test.ts`, `supabase/tests/database/bill_not_part.test.sql`.
