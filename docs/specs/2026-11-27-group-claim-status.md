# Group claim status: "Claim your items", money state on Home, "I wasn't part of this"

Date: 2026-11-27 · Author: product-manager · Status: ready to build
Related: [ADR 0022](../learning/decisions/0022-groups.md), [group balances](../learning/concepts/group-balances.md), `docs/specs/2026-11-26-groups-mvp.md`, `docs/specs/2026-11-26-home-groups-v2.md`. Decisions: `docs/decisions-to-review.md` § "2026-11-27 · Group claim status" (GCS-1 … GCS-14).

## User request (2026-11-27, verbatim)
> "in groups if there are bills where youve not claimed any items it should indicat eon the home page http://localhost:8082/ here next to groups and where it says settled for example - should have state, you have some bills with unclaimed items, you need to pay money, you need to request money and in the group the ones where you have unclaimed items in yellow (a button next to that item or when you click into it saying not part of this if you didnt get any items on that bill/item) make this look user friendly though"

Follow-up (relayed by the coordinator, 2026-11-27, verbatim): "you have unclaimed items in yellow - maybe a slight yellow hue on that line item?"

How this spec reads it (relayed; listed in the build summary for the user to confirm, lesson 2026-11-27 "User decisions arrived relayed"):
- Each Home group row gets **one** state, highest priority first: claim your items → you owe → you're owed ("request money") → settled up.
- "Yellow" is a **slight yellow tint on the row background** (the existing `warningSurface` token), not a badge or border. It goes on each group bill that still needs me (group screen) and on each still-unclaimed line item inside a group bill (bill screen).
- "Not part of this" is **bill-level** only (GCS-2). The per-item version is logged as a decision.

## Goal
In a group, I can see at a glance, on Home and in the group, which receipts are waiting on me to claim, and what I owe or am owed. When I had nothing on a receipt, I can say so with one tap, and it stops reminding me.

## Providers, accounts and costs
| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already running) | One new table and function, and `group_snapshot` gains one field | None |
| Hosted Supabase (friend-test project, if it's in use) | The same migration, applied **before** a web build that has the new parser ships (Risk R1) | None |
| Anything else | Nothing | None |

No new service, no new secret, no Edge Function. Still the app plus Supabase (ADR 0010).

## In scope
1. Home's Groups rows (`components/GroupsSection.tsx`, which also renders the `/groups` list): one state per row, with its own color (contract C2).
2. Group screen (`app/(app)/groups/[id]/index.tsx`): receipts that need me get a slight yellow tint and the actions "Open" (the row) and "I wasn't part of this". A receipt I've opted out of shows "Undo" (contract C1, C5).
3. Bill screen of a **group** bill: a slight yellow tint on each unclaimed row while I haven't opted out, plus the same "I wasn't part of this" / "Undo" line under the items (C5).
4. Storage for "not part of this": one owner-only table, one writer function, and the caller's own ids in `group_snapshot` (C3, C4).

## Out of scope (cut)
- Push or local notifications.
- Bills that aren't in a group. Home's bill sections belong to splitit-app-92.
- A per-item "not mine" (GCS-2).
- Showing other people that I said "not part of this", and an Activity line for it (GCS-3).
- Any change to money. Shares come only from claims. A receipt still counts only once every row is claimed (U-G3). "Not part of this" adds or removes nothing from any balance.
- Copy changes to the Settle screens and to the waiting-line text itself ("Ana's receipt: Nachos left to claim" stays as it is).

## File ownership (other sessions are active)
| Do not edit | Owner |
|---|---|
| `app/(app)/index.tsx`, `lib/homeSections.ts` | splitit-app-92 |
| `lib/homeMarkers.ts`, `lib/activityText.ts`, `bill_payments` / who-paid migrations and their lib | splitit-app-96 |
| `app/(app)/bills/[id]/index.tsx`: the header block (`styles.header`, `BillGroupLine`, `PayerLine`), the sticky footer (`SharesSummary`, `SettledInGroup`, `GroupCheckLine`, SettleFooter) | other sessions |

In `app/(app)/bills/[id]/index.tsx` this spec may change **only** `renderRow` (passing the tint prop to `ClaimItemRow`), the `blocks` array (adding one keyed `notPart` block), and the props and hook wiring those two need. If T6 needs anything else in that file, stop and report.

---

## Shared contracts (defined once; tasks point here)

### C1. When a group bill "needs me"
A bill in a group **needs viewer V** when all three hold:
- (a) at least one of its rows (items **and** discount rows) has no claimer;
- (b) V has no claim on any of its rows;
- (c) V hasn't said "I wasn't part of this" for it (no `bill_not_part` row for (bill, V)).

**Claims win.** If V has a claim, the bill doesn't need V, whatever (c) says. The database also deletes the opt-out row when V gets a claim (C3), so the two agree.

It's implemented **once**, as `billNeedsViewer` in a new `lib/groupClaimStatus.ts`:

```ts
export type ClaimRowLike = { claimerIds: readonly string[] };
export function billNeedsViewer(rows: readonly ClaimRowLike[], viewerId: string, notPart: boolean): boolean;
```

Both the snapshot side (Home, group screen) and the bill-screen side (`BillData`) call it through small adapters (`rowsOfSnapshotBill`, `rowsOfBillData`) in the same file. The all-$0 bill (rule Z) follows the same rule: unclaimed rows mean it needs someone. A bill with zero rows doesn't need anyone: (a) is false.

Boundary cases both adapters must pass (criterion 13):
| # | Rows (claimers) | V's opt-out | needs V? |
|---|---|---|---|
| B1 | [Ana], [] | no | yes |
| B2 | [Ana], [] | yes | no |
| B3 | [V], [] | no | no (V claimed) |
| B4 | [V], [] | yes (stale row) | no (claims win) |
| B5 | [Ana], [Ben] (fully claimed) | no | no |
| B6 | [] only discount row unclaimed, items [Ana] | no | yes |
| B7 | no rows | no | no |
| B8 | [Ana, V] split row, [] | no | no |

### C2. Home row state (one per group, first match wins)
`groupHomeStatus(snapshot, viewerId)` in `lib/groupHomeView.ts`. Each rule names its source.

| Order | Kind | When | Text (exact) | Tone |
|---|---|---|---|---|
| 1 | `claim` | n ≥ 1 bills in the snapshot need the viewer (C1) | n = 1: `Claim your items on 1 bill`; n ≥ 2: `Claim your items on ${n} bills` | `warning` |
| 2 | `owe` | not `isSettledUp(net)` and net < 0 (`viewerNet`) | `GROUP_COPY.owe(-net)`, i.e. `You owe $12.50` | `text` |
| 3 | `owed` | not `isSettledUp(net)` and net > 0 | `GROUP_COPY.owed(net)`, i.e. `You're owed $8.00` ("request money") | `success` |
| 4 | `waiting` | any bill in `balances.waiting` with reason `incomplete` (others' items) | today's `footerIncomplete(rows, discountRows)`, e.g. `2 items left to claim` | `muted` |
| 5 | `settled` | none of the above, nothing in `balances.waiting` at all, and the group has ≥ 1 bill or expense | `Settled up` | `muted` |
| — | null | otherwise (no costs yet, only all-$0 receipts waiting, or snapshot missing or broken) | the people count, as today (`4 people` / `Just you`) | `muted` |

Notes:
- `net` is the viewer's group net in integer cents. It comes only from `viewerNet` / `groupMath` (it counts only fully claimed receipts). Components do no arithmetic.
- Rule 5 is now about **me** (my net within 1¢), not "every member settled" (GCS-6).
- Rules 2–3 can show while an unrelated receipt is waiting on others. The amount then excludes that receipt, the same as the group screen's status block.
- GR-20 ("no balances on Home's group rows") is overridden by the user's request (GCS-5).
- Groups past `GROUPS_HOME_DETAIL_LIMIT` (10), and groups whose snapshot read failed, show the people count (unchanged).
- Money boundaries (criterion 16): net = −1 and +1 → `Settled up`; net = −2 → `You owe $0.02`; net = +2 → `You're owed $0.02`; net = 0 with one receipt needing me → the claim text.

The model returns `{ kind, text, tone }`. `GroupHomeRow.status` carries it, and `caption` / `a11yLabel` are as today (`name, people, status text`).

### C3. Storage: `public.bill_not_part`
Migration `supabase/migrations/<slot>_bill_not_part.sql`. The main session reserves the timestamp with the other sessions; it must sort after `20261127140002_who_paid.sql`. The draft lives in the scratchpad until it's applied (lesson 2026-11-27).

- Table `public.bill_not_part (bill_id uuid, user_id uuid, created_at timestamptz not null default now())`, primary key `(bill_id, user_id)`, foreign key `(bill_id, user_id) → bill_participants (bill_id, user_id) on delete cascade` (as `bill_seen`). So leaving, being removed, bill deletion and account deletion all remove it. No new restrict FK, so account deletion is unaffected (lesson 2026-11-27).
- RLS enabled. `revoke all on public.bill_not_part from anon, authenticated, public`. `grant select (bill_id, user_id, created_at) to authenticated`. One SELECT policy: `user_id = (select auth.uid())`. No INSERT, UPDATE or DELETE grant: direct writes fail with `42501`.
- No Realtime broadcast trigger, no `bill_events` or `group_events` row (GCS-3).
- `public.set_not_part(p_bill_id uuid, p_not_part boolean) returns void`, `security definer`, `search_path = ''`, EXECUTE to `authenticated` only:
  - `42501 not_allowed`: signed out; `p_bill_id` or `p_not_part` null; no such bill; the caller isn't a participant.
  - `p_not_part = true`:
    - `22023 not_in_group` if the bill's `group_id` is null;
    - `22023 has_claims` if the caller has any `claims` row on the bill;
    - else insert `on conflict do nothing` (a repeat is a no-op success).
  - `p_not_part = false`: delete the caller's row if any. Always a success for a participant, group or not, so a stale opt-out can always be cleared.
  - Lock order (starting design; the supabase-engineer may change it with reasoning in the migration header, following the rule in `20261126082511_groups.sql`): `private.lock_bill_key_share(p_bill_id)`, then `select … for update` on the caller's own `bill_participants` row, then the claims check, then the write. A claim insert takes `FOR KEY SHARE` on that same participant row through its FK check, which `FOR UPDATE` conflicts with. So "check no claims, then insert" can't interleave with a claim insert for the same person.
- Trigger `claims_clear_not_part` `AFTER INSERT ON public.claims FOR EACH ROW`: deletes `bill_not_part` where `(bill_id, user_id) = (new.bill_id, new.user_id)`. Function `private.claims_clear_not_part()`, `security definer`, owner `postgres`. It covers `set_claim`, `set_item_split`, `assign_item` (someone assigning me) and any direct insert (GCS-4). Whether a trigger function needs EXECUTE for the inserting role: verify on the installed Postgres. The pgTAP test (criterion 8) proves inserts by `authenticated` and by `service_role` both still work.

### C4. Snapshot field
`group_snapshot`'s `me` becomes `{ "hidden": boolean, "not_part_bill_ids": [uuid] }`: the caller's own `bill_not_part.bill_id`s for bills with `group_id = G`, ordered by `bill_id`, `[]` when none. The key is always present. Only the caller's rows, never anyone else's.

The migration redefines `group_snapshot` with `create or replace`, starting from the **newest** definition in `supabase/migrations/` at build time. Today the only one is `20261127061004_group_snapshot.sql`. Check again before writing, since another session could have replaced it. Every other key stays byte-for-byte the same.

`lib/groups.ts`: `GroupSnapshot.me` becomes `{ hidden: boolean; notPartBillIds: string[] }`. The parser requires the key, requires each id to be a lowercase uuid that is one of the snapshot's `bills[].id`, and requires no repeats. Anything else is `network` (fail closed, as today).

### C5. The tint (and its non-color cue)
- Token: the existing `colors.warningSurface` (light `#FFFAEB`, dark `#33260B`). No new token unless criterion 30 fails. Text on it, as the PM worked out (verify with a checker; reword if different): `text` 17:1 light / 14:1 dark, `textMuted` ≈ 7.2:1 light / ≈ 6.8:1 dark, `warning` `#93370D` on white ≈ 7.5:1. All are ≥ 4.5:1.
- The light tint is deliberately faint against white. It's never the only cue: each tinted place also has words (C6). Whether it's visible enough on a real screen is a User check (criterion 33).
- Where it goes:
  - the group screen's waiting row for each bill that needs me;
  - that bill's row in the group's Costs list;
  - on the bill screen of a group bill, each row with no claimer (as displayed, so it clears the moment I tap Claim), unless I've opted out of that bill (GCS-8).
- Pressed state: a tinted `ListRow` still shows its pressed background (`surfaceMuted`) while pressed. The tint must not override it.

### C6. Copy (exact strings; one definition each)
`lib/groupClaimStatus.ts` exports `GROUP_CLAIM_COPY`, and the Home texts live in `GROUPS_HOME_COPY`. Every screen imports them; no string is typed twice.

| Key | String |
|---|---|
| `homeClaim(n)` | `Claim your items on 1 bill` / `Claim your items on ${n} bills` |
| `homeSettled` (replaces `GROUPS_HOME_COPY.settled`) | `Settled up` |
| `needsYou` (caption, waiting row) | `You haven't claimed anything here yet` |
| `costNeedsYou` (appended to a cost row's caption) | `Claim your items` → caption reads `Ana paid $77.33 · Claim your items` |
| `notPart` (link) | `I wasn't part of this` |
| `notPartHint` | `Stops reminding you about this receipt. It doesn't change anyone's share.` |
| `notPartDone` (caption, group screen) | `You weren't part of this` |
| `notPartDoneBill` (line, bill screen) | `You said you weren't part of this.` |
| `notPartPrompt` (line, bill screen, before the link) | `Nothing here was yours?` |
| `undo` (link) | `Undo` |
| `undoA11y` | `Undo, I was part of this` |
| `undoHint` | `Reminds you to claim your items on this receipt again` |
| `hasClaims` (error) | `You've claimed something on this receipt, so you're part of it.` |
| `notInGroup` (error) | `This receipt isn't in a group anymore.` |
| other errors | `GROUP_ERROR_COPY.network` / `.not_allowed` (existing) |

No "!" and no "failed" (lesson 2026-11-27, Sent via Venmo UX).

---

## Tasks

### T1. Database: `bill_not_part`, `set_not_part`, the clearing trigger, the snapshot field (agent: supabase-engineer)
Repo: this one. Files:
- new `supabase/migrations/<slot>_bill_not_part.sql` (C3, C4)
- new `supabase/tests/database/bill_not_part.test.sql`
- edit `supabase/tests/database/group_snapshot.test.sql`: lines 229 (the top-level key list stays the same) and 238–239 (the `me` objects gain `"not_part_bill_ids": []`), plus new cases.

Before `migration up`, list `supabase/migrations/` and report any file you didn't write. Don't apply other sessions' drafts. Before blaming this task for a db:test failure, check for other sessions' unapplied migrations (lessons 2026-11-27). Criteria 1–11.

### T2. Data layer and the C1 rule (agent: implementer)
Files:
- new `lib/groupClaimStatus.ts` + `lib/groupClaimStatus.test.ts` (C1 `billNeedsViewer` + adapters, C6 copy). Tests first, with the expected values worked out by hand from the C1 table.
- `lib/groups.ts`:
  - parser for `me.not_part_bill_ids` (C4);
  - `setNotPart(billId, notPart)` → `GroupResult`, which maps `has_claims` and `not_in_group` and adds `'set_not_part'` to `DbFunction` / `MESSAGES_22023`, with new `GroupError` members and `GROUP_ERROR_COPY` entries that point at the C6 strings;
  - `fetchNotPart(billId)` → `GroupResult<{ notPart: boolean }>`, reading `supabase.from('bill_not_part').select('bill_id').eq('bill_id', billId)`: 0 rows is false, 1 row is true, anything else is `network`.
- `lib/groups.test.ts`
- `test-utils/groupSnapshotFixtures.ts` (`me.notPartBillIds: []` and a helper to set it)

Criteria 12–15. `tsc` will list every place that builds a `GroupSnapshot`. Fix only fixtures in files this spec names. Report any other file to the main session.

### T3. View models (agent: implementer, after T2)
Files:
- `lib/groupHomeView.ts` + `lib/groupHomeView.test.ts`: C2. The signature becomes `groupHomeStatus(snapshot, viewerId)`. `GroupHomeStatus` becomes `{ kind: 'claim' | 'owe' | 'owed' | 'waiting' | 'settled'; text; tone: 'warning' | 'text' | 'success' | 'muted' } | null`. Rewrite the header comment's three cases.
- `lib/groupView.ts` + `lib/groupView.test.ts`:
  - `WaitingLine` gains `needsMe: boolean` and `notPart: boolean` (C1, using `snapshot.me.notPartBillIds`);
  - `CostRow` gains `needsMe: boolean`;
  - `GroupScreenModel.waiting` is ordered needs-me first, then the rest, each keeping snapshot order (GCS-9).

  Existing text fields are unchanged.
- `lib/groupScreenText.ts` (+ test) only if a caption or label helper belongs there: the waiting row's a11y label for needs-me and opted-out rows, and `costRowA11yLabel` with ", Claim your items".

No money arithmetic outside `groupMath` / `viewerNet`. Criteria 16–20.

### T4. Home Groups rows (agent: product-engineer, after T3)
Files:
- `components/GroupsSection.tsx`: the caption is a `Text` colored by `status.tone` (`warning` → `colors.warning`, `success` → `colors.success`, `text` → `colors.text`, `muted` or none → `colors.textMuted`). The row is not tinted (GCS-7). No other change to loading, error, hidden-groups or navigation behavior.
- `__tests__/groupsHome.test.tsx`, `__tests__/groupsList.test.tsx`: update the "Settled" and "left to claim" cases to C2, and add the C2 cases.
- `app/(app)/groups/index.tsx`: only its header comment, if it quotes the old states.

Not `app/(app)/index.tsx`. Criteria 21–24.

### T5. Group screen (agent: product-engineer, after T3)
Files:
- new `components/GroupWaitingRow.tsx`
- `app/(app)/groups/[id]/index.tsx` (the waiting section and the `WriteKind` / busy wiring)
- `components/GroupCostRow.tsx` (tint + caption suffix when `row.needsMe`)
- `__tests__/groupScreen.test.tsx`, `__tests__/groupAriaWeb.test.tsx` (web ARIA for the new links)

Layout of a waiting row:
- **Needs me:** a tinted block. On top, the tappable row: the existing title `w.text`, caption `needsYou`, a chevron, and it opens `/bills/<id>`. Under it, inside the tint, the quiet `TextLink` `notPart` with `notPartHint`. They're two separate targets, not a button inside a button.
- **Opted out** (and the bill is still waiting): not tinted. The row has caption `notPartDone`, and the `TextLink` `Undo` has `undoA11y` and `undoHint`.
- **Otherwise:** today's row.

A not-part write goes through the screen's existing `runWrite`: one write at a time through the `writing` ref, busy until the refetch after it, and the refresh-failed line as today. Busy and error are tracked **per bill id**: only the tapped link shows busy, and its error shows under that row. Criteria 25–29.

### T6. Bill screen of a group bill (agent: product-engineer, after T2; may run alongside T4/T5)
Files:
- new `lib/useNotPart.ts` (+ `__tests__/notPart.test.tsx`). It reads `fetchNotPart` on focus only when the bill is a group bill, and has `set(notPart)` with a ref guard that rereads after a write. It resets to `false` as soon as the server claims include me, mirroring C3's trigger.
- new `components/NotPartLine.tsx`
- `components/ClaimItemRow.tsx` (new optional `highlight?: boolean` → `warningSurface` background, with an inset and radius the designer picks; touch targets and layout unchanged)
- `app/(app)/bills/[id]/index.tsx`, within the File ownership limits: `renderRow` passes `highlight`, and a keyed `notPart` block goes right after `discountsBlock` in both `blocks` orders.
- `__tests__/groupBillScreen.test.tsx`

Visibility rules:
- **Line:** shown when the bill is a group bill, the not-part read is ready, the **server** data has ≥ 1 unclaimed row, and I have no **server** claim. It shows `notPartPrompt` + link `notPart`, or, when opted out, `notPartDoneBill` + link `Undo`.
- **Tint:** while the not-part read is loading, no tint (no flash). If the read failed, tint the rows and hide the line (fail toward reminding, GCS-10).

Criteria 30–36.

### T7. Docs (agent: docs-writer, after T6; hand it this spec path, "T7", and the file list below)
- `docs/learning/concepts/group-balances.md`: a short section, "Needs you" and "I wasn't part of this", saying C1 and that it never changes money.
- `docs/learning/concepts/row-level-security.md`: `bill_not_part` as the second owner-only per-person table (after `bill_seen`). Unlike `bill_seen`, it has a SELECT grant with an own-rows policy.
- ADR 0022: an "Amended by" line pointing to this spec and GCS-1…14. Not a new ADR (no hard-to-reverse decision beyond a table).
- `docs/before-production.md`: R1 (deploy order), and the faint light-mode tint (criterion 33) until the user has looked.
- Report every bullet. Criterion 37.

---

## Acceptance criteria

### Database (T1), run by `npm run db:test`
1. `bill_not_part` has RLS enabled. `anon`, `authenticated` and `public` have no INSERT, UPDATE, DELETE or TRUNCATE on it. `authenticated` has SELECT only on `bill_id, user_id, created_at`. A direct `insert`, `update` or `delete` as `authenticated` fails with `42501`, and `select` as `anon` fails with `42501`.
2. As Ben, `select bill_id, user_id, created_at from bill_not_part` returns only Ben's rows. Ana's row on the same bill isn't returned.
3. `set_not_part(bill, true)` by a group member with no claims on that bill inserts one row (Ben, bill). A repeat returns success and leaves one row.
4. `set_not_part(bill, true)` when the caller has ≥ 1 claim on the bill (including a split row) fails `22023` with message `has_claims`, and no row is written.
5. `set_not_part(bill, true)` on a bill with `group_id is null` fails `22023 not_in_group`. `set_not_part(bill, false)` on that bill by a participant succeeds and removes a row that was inserted directly as superuser for the test.
6. `set_not_part` fails `42501` when signed out, for a non-participant, for a nonexistent bill id, and for null arguments. `anon` has no EXECUTE.
7. `set_not_part(bill, false)` deletes only the caller's row. Ana's row on the same bill stays.
8. After Ben's row exists, Ben getting a claim on that bill deletes his row. Tested three ways: Ben's own `set_claim`, Ana's `assign_item` assigning Ben, and a direct `insert into claims` run as `service_role`. All three inserts succeed. Ana's opt-out on the same bill is untouched.
9. `set_not_part`, either way, changes no row in `bills`, `line_items`, `claims`, `bill_participants`, `bill_events`, `group_events`, `group_payments` or `expenses`. Counts and the newest `seq` are compared before and after.
10. `group_snapshot` as Ben, after Ben opted out of bill X, has `me = {"hidden": false, "not_part_bill_ids": ["<X>"]}`. As Ana (no opt-outs), `me.not_part_bill_ids = []`. Ana's snapshot never contains Ben's ids. An opt-out on a bill of another group doesn't appear. The top-level key list is unchanged (`bills, expenses, group, me, members, not_received, payments`).
11. Deleting Ben's participant row, or the bill, deletes his `bill_not_part` row (cascade). The migration adds no FK to `profiles` or `auth.users`.

### Data layer and rule (T2), `npx jest lib/groupClaimStatus.test.ts lib/groups.test.ts`
12. `parseSnapshot` accepts `me.not_part_bill_ids: []` and a list of bill ids from the snapshot. It returns `network` when the key is missing, when an id isn't one of `bills[].id`, for an uppercase uuid, for a repeat, and when the value isn't an array.
13. `billNeedsViewer` returns the C1 table's answer for B1–B8, through **both** adapters: a `SnapshotBill` fixture and a `BillData` fixture built from the same rows.
14. `setNotPart` sends `rpc('set_not_part', { p_bill_id, p_not_part })`. It maps `22023 has_claims` → `has_claims`, `22023 not_in_group` → `not_in_group`, `42501` → `not_allowed`, and any other message or a timeout → `network`. A non-uuid bill id sends nothing.
15. `fetchNotPart` calls `.from('bill_not_part').select('bill_id').eq('bill_id', id)`. A test asserts the exact select string. 0 rows → `{ ok: true, notPart: false }`, 1 matching row → true, 2 rows or a wrong id → `network`. `grep -rnE "from\('bill_not_part'\)\.select\(\)|select\('\*'\)" lib` prints nothing. The PM ran `\.select\(\)|select\('\*'\)|bill_not_part` over `lib/` today and it matched nothing.

### View models (T3), `npx jest lib/groupHomeView.test.ts lib/groupView.test.ts`
16. `groupHomeStatus` gives every C2 row and money boundary, with integer-cent fixtures:
   - one bill needing me + net −5000 → `{ kind: 'claim', text: 'Claim your items on 1 bill', tone: 'warning' }`;
   - two such bills → `Claim your items on 2 bills`;
   - none, net −1250 → `You owe $12.50` / `text`;
   - net +800 → `You're owed $8.00` / `success`;
   - net ±1 → `Settled up` / `muted`;
   - net −2 → `You owe $0.02`; net +2 → `You're owed $0.02`;
   - net 0, others' receipt waiting → `1 item left to claim` / `muted`;
   - no costs → null;
   - only an all-$0 receipt waiting (and claimed) → null;
   - me opted out of the only waiting bill, net 0 → `1 item left to claim`.
17. The same snapshot with `me.notPartBillIds` naming the bill drops it from the claim count. The same bill where I hold a claim plus a stale opt-out (B4) is not counted.
18. `groupHomeRow(...).a11yLabel` is `Tahoe trip, 4 people, Claim your items on 1 bill` for the claim case. A null or other-group snapshot gives the people count and no status (unchanged).
19. `groupScreen`:
   - `waiting[i].needsMe` and `.notPart` follow C1;
   - needs-me lines come first, in snapshot order, then the rest;
   - `costs[j].needsMe` is true only for bill rows that need me, never for expenses;
   - every existing `text` / `notice` string in `lib/groupView.test.ts` passes without edits.
20. No component computes money: `grep -rnE "netCents|totalCents *[-+*/]|/ *100\b" components/GroupsSection.tsx components/GroupWaitingRow.tsx components/NotPartLine.tsx components/GroupCostRow.tsx` prints nothing. The PM ran the same pattern over `components/GroupsSection.tsx` and `components/GroupCostRow.tsx` today and it matched nothing. The two new files don't exist yet: not run.

### Home (T4), `npx jest __tests__/groupsHome.test.tsx __tests__/groupsList.test.tsx`
21. With three groups (one needing me, one where I owe $12.50, one where I'm settled), the rows read in order: `Claim your items on 1 bill`, `You owe $12.50`, `Settled up`. Their link names are `<name>, <people>, <status>`. The caption colors are `colors.warning`, `colors.text` and `colors.textMuted`. A fourth group where I'm owed $8.00 shows `You're owed $8.00` in `colors.success`.
22. **One snapshot failing:** with two groups where the second's `group_snapshot` fails, the first shows its state and the second shows `4 people` with no status. Nothing shows an alert, and the list doesn't show an error.
23. **Loading:** before the snapshots land, every row shows the people count. Home renders nothing for the block until `my_groups` lands (unchanged). **List error:** a failed first `my_groups` shows `Couldn't load your groups.` with `Try again` (unchanged).
24. The same rows on `/groups` (`variant="page"`) show the same states. `git diff --stat` for the task touches neither `app/(app)/index.tsx` nor `lib/homeSections.ts`.

### Group screen (T5), `npx jest __tests__/groupScreen.test.tsx __tests__/groupAriaWeb.test.tsx`
25. A waiting bill that needs me renders:
   - the title `Ana's receipt: Nachos left to claim` and caption `You haven't claimed anything here yet` on a container whose background is `colors.warningSurface`;
   - the row is a link that pushes `/bills/<id>`;
   - a separate button `I wasn't part of this` (hint as C6).

   Its cost row has background `warningSurface` and its caption contains `· Claim your items`. A waiting bill I've claimed on has neither the tint nor the button. An expense row is never tinted.
26. Tapping `I wasn't part of this` sends one `set_not_part { p_bill_id, p_not_part: true }`, even on a double tap. The link is busy until the refetch after it ends, and no other not-part link starts a write meanwhile. After the refetch (opt-out in `me`), the row is untinted, with caption `You weren't part of this` and a button named `Undo, I was part of this`. Tapping it sends `p_not_part: false`, and after the refetch the row is tinted again.
27. A refused write shows its C6 copy under **that** row (`has_claims` → `You've claimed something on this receipt, so you're part of it.`), then refetches. A `network` failure shows `GROUP_ERROR_COPY.network` and re-enables the link. A write that lands but whose refetch fails shows the screen's existing `Couldn't refresh. Try again.` line and re-enables the link.
28. Screen states are unchanged and still tested: loading spinner, `not_allowed` screen, load error with `Try again`. The balances in the status block are the same with and without an opt-out: same `statusLine` text for the same fixture with `notPartBillIds` set or empty.
29. On web (react-native-web static markup, through the shared helper if one exists), `I wasn't part of this` and `Undo` render as `role="button"` with their accessible names. Anything a hint carries is also in the label or the visible caption (lesson 2026-11-27).

### Bill screen (T6), `npx jest __tests__/groupBillScreen.test.tsx __tests__/notPart.test.tsx`
30. On a group bill where I haven't opted out, each row with no claimer has background `colors.warningSurface`, and rows with a claimer don't. On a bill not in a group, no row is tinted and no `bill_not_part` read is made. Contrast: `text` and `textMuted` on `warningSurface` are ≥ 4.5:1 in light and dark, computed from the theme hex values in a test or listed with a checker's output in the report. If either fails, stop and report it; don't add a token without saying so.
31. Tapping `Claim` on a tinted row removes its tint before the save lands, because it uses the displayed claimers.
32. **Line states:**
   - a group bill with an unclaimed row and no claim of mine shows `Nothing here was yours?` and a button `I wasn't part of this`;
   - once a server claim of mine exists, the line is gone;
   - when opted out, it reads `You said you weren't part of this.` with `Undo`, and no row is tinted;
   - a fully claimed bill with no opt-out shows no line.
33. **User check** (light and dark, a phone or the simulator plus a desktop browser at the dev server):
   - open a group with a receipt you haven't claimed;
   - the Home row says `Claim your items on 1 bill` in amber;
   - the group's waiting and cost rows have a slight yellow tint, readable in both modes;
   - in the bill, the unclaimed items are tinted;
   - tap `I wasn't part of this`: the tints go, and Home stops saying "Claim your items" for it;
   - tap `Undo`: they come back.

   Say whether the light tint is visible enough. The agent part is criteria 21, 25, 30 and 32. On a phone, the device reaches the local Supabase only through the Mac's LAN IP with matching redirect URLs, or a hosted project; otherwise run this check in the browser and mark the phone part blocked.
34. **Not-part read states:** while `fetchNotPart` is loading, no tint and no line. If it fails, the rows are tinted and the line is hidden, with no alert. On focus, it's read again.
35. **Write states:** one call per tap, and the link is busy until the reread after it. `has_claims` shows its copy as a caption-size error under the line and rereads. `network` shows `GROUP_ERROR_COPY.network`. Signing out or leaving the screen mid-write sets no state after unmount.
36. Scope of the edit: `git diff app/(app)/bills/[id]/index.tsx` changes only `renderRow`, the `blocks` lines, and the hook and prop wiring for them. The header and the sticky footer lines are unchanged. The reviewer checks this.

### Live and docs
37. **Live reconciliation** (qa-tester, `live-db-smoke` with the esbuild bundle of `lib/groups.ts` and `lib/groupClaimStatus.ts`, throwaway users, cleanup counts all 0):
   - Ben, with no claims: `setNotPart(true)` → his snapshot has the id, `groupHomeStatus` for Ben drops the claim, and Ana's snapshot doesn't have it;
   - `assignItem` gives Ben an item → his `fetchNotPart` is false;
   - `setNotPart(true)` after that → `has_claims`;
   - balances for every member are identical before and after each not-part write.
38. The docs-writer reports each T7 bullet as done, with its file.

---

## Risks / open questions
- **R1. Deploy order.** The new parser requires `me.not_part_bill_ids`. A web build with T2 against a database without T1 fails every group screen (`network`), and Home falls back to people counts. Apply the migration first. If a hosted friend-test project is live, that's the user's step; T7 records it in `docs/before-production.md`.
- **R2. `group_snapshot` is redefined in full.** If another session replaces it at the same time, one version loses. The main session checks with splitit-app-96 before T1 applies.
- **R3. A stale opt-out after detach and reattach.** Rows survive a detach, because the bill keeps its participants. If the bill is reattached, the old "not part" applies again. That's rare and harmless (it only hides a reminder). Logged as GCS-11.
- **R4. Shared test files.** T4 and T5 edit `__tests__/groupsHome.test.tsx` and `groupScreen.test.tsx`, written by the Groups session. They're in this feature's area, so no other session is expected to be in them. If one is, sequence by message.
- **R5. Faint light tint** (`#FFFAEB` on white, about 1.04:1). That's by design ("slight"), and there's always text next to it. The user decides after criterion 33 whether to deepen it. That would be a token change, which is the user's call.
- **Decisions made without asking** (per "build without blocking"): GCS-1 … GCS-14 in `docs/decisions-to-review.md`. The ones that most need the user's look:
  - GCS-2 (bill-level only);
  - GCS-3 (private, no Activity line);
  - GCS-5 (amounts on Home, which reverses GR-20);
  - GCS-6 ("Settled up" means *me*).

---

## Amendments

### A1 (2026-11-27, supabase-engineer, T1 as built)
None of these changes the contract (C3, C4) or any app-facing behavior.
- **Migration slot:** `supabase/migrations/20261127150000_bill_not_part.sql`, set by hand because `migration new` would have used the current clock time (12:15 UTC), which sorts before `20261127140002_who_paid.sql`.
- **Where criterion 10's cases live:** the opt-out snapshot cases are in `supabase/tests/database/bill_not_part.test.sql`, not as new cases in `group_snapshot.test.sql`. In `group_snapshot.test.sql` only the two `me` assertions changed (now `{"hidden": …, "not_part_bill_ids": []}`). The new file's fixture has the opt-outs the cases need.
- **Who plays "Ana's row" in criteria 7 and 8:** in the fixture, Ana (the host) has a claim on the bill, so she can't opt out. Cy (criterion 7) and Dee (criterion 8) hold the "other person's row" that must survive.
- **Additions not named in C3:**
  - an index `bill_not_part_user_idx (user_id, bill_id)` for the own-rows policy and the snapshot lookup;
  - EXECUTE on `private.claims_clear_not_part()` is revoked from `service_role` too. On the installed Postgres 17, a trigger function's EXECUTE is checked only at CREATE TRIGGER (the existing `private.claims_lock_bill_first()` already works that way), and criterion 8's `service_role` insert passes.
- **Lock order:** as C3's starting design, unchanged. The migration header lists each path's locks, implicit ones included.

## Amendment A2 (2026-11-27, review and QA)
- **Bill-screen tests location:** criteria 30–32's tests live in `__tests__/billNotPart.test.tsx`, not `__tests__/groupBillScreen.test.tsx`. Another session was editing the shared bill-screen test files at the time; `groupBillScreen.test.tsx` is unchanged and passes.
- **Review fixes (verdict APPROVE):**
  - R1: a not-part error clears once the line state, or the group snapshot version, it was raised under changes. The one exception: after `has_claims`, the message stays to explain why nothing happened.
  - R2: `waitingLines` keeps snapshot order. Only `groupScreen` sorts needs-me first (`needsMeFirst`), so group Settle notices are unchanged.
  - R4: the group screen keeps its row order after an opt-out until the next focus refetch (`keepOrder`).
  - R6: `useNotPart` scope includes `billId`, and the reset settles in-flight reads.
- **QA:** Overall PASS. Criterion 33 (the user's visual check in light and dark mode) is still open.
