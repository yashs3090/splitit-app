# Bill markers and in-app notices

Date: 2026-11-24. User request of 2026-11-24: "People get no notification when they're added to a bill." Follows `docs/specs/2026-11-24-people-and-invites.md` (it revisits PI-6, "Telling someone they were added: nothing") and ADR 0016.
Repo: `splitit-app` only (ADR 0011). **The main session assigns the migration timestamp** (lessons log, parallel-work rule). No ADR is needed: nothing here is hard to reverse (one table, two functions, pure lib code).

The user asked that building continue without stopping. Every product and UX choice below was made by the PM and is logged as **BM-1 to BM-18** under "Added while building" in `docs/decisions-to-review.md`. Nothing in this spec waits on the user.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already set up) | 1 table, 2 functions | $0 |
| Two Google test accounts (exist since M2 U1) | User check U1 on web | $0 |
| Xcode + iOS simulator (already used) | User check U3 (foreground refresh) | $0 |
| Push notifications (APNs / FCM / Expo push), a paid Apple Developer account, a hosted backend | **Not needed.** The notice is in-app only, as the user asked | $0 |

Nothing new to sign up for.

## Goal
When Hana adds Sam to tonight's bill, Sam notices it the next time he looks at SplitIt: a small card on Home says "Hana added you to a bill" with "Open", and the bill's row in "Your bills" says "New". Once he has looked, the row says "Nothing claimed yet" until he claims something or the bill no longer needs him to.

## In scope
- DB: an owner-only `bill_seen` table; `mark_bill_seen(bill)`; `my_bills()` returning each bill's summary plus the four facts the markers need. pgTAP tests.
- `lib/homeMarkers.ts` (pure: which marker a row gets, the notice, copy, labels); `lib/bills.ts` (`listMyBills` reads `my_bills()`; new `markBillSeen`).
- Home: one notice card, one marker per bill row, refetch when the app comes back to the foreground.
- Bill screen: marks the bill seen once per visit.
- Live reconciliation; docs.

## Out of scope (cut)
- Push notifications, e-mail, badges on the app icon (user: in-app only).
- Live delivery while Home is on screen (a per-user Realtime channel). Home refreshes on focus and on returning to the app (BM-11).
- "Updated since you last looked" (new claims, edits or Activity since your last visit). v1 "New" means only "added and not opened yet" (BM-1).
- A "You owe $X" or "N items left" marker on Home rows. It would need the split math per bill on Home (BM-5 explains why the two markers here can't contradict settling).
- Blocking someone, or a "Leave" button on the notice (BM-14). "Leave this bill" stays on the bill screen.
- Notices for anything other than being added (claims, payer changes, edits).
- Showing anyone else's seen state. Nobody, including the host, ever learns whether you opened a bill.

## Design

### D1. Seen state: data model (Task 1)

| Object | Shape | Meaning | Client access |
|---|---|---|---|
| `public.bill_seen` | `bill_id uuid`, `user_id uuid`, `seen_at timestamptz not null default now()`; primary key `(bill_id, user_id)`; foreign key `(bill_id, user_id) → bill_participants (bill_id, user_id) on delete cascade` | A row means "this person has opened this bill, or dismissed its notice". `seen_at` is the latest time | **None.** `revoke all ... from anon, authenticated, public`; RLS enabled with no policies. Only the two security definer functions below touch it |

Why a separate table and not a column on `bill_participants` (BM-2):
1. `authenticated` has table-level SELECT on `bill_participants` (`supabase/migrations/20261124091041_people.sql:50-51`), and every co-participant can read every row. A `last_seen_at` there would be a read receipt the host could query directly. A column grant can't say "only on your own row" (`docs/learning/concepts/row-level-security.md`, "A column grant applies to every row RLS shows you").
2. Any UPDATE on `bill_participants` fires `bill_participants_broadcast_update` (`20261124081411_settle_payer.sql:160-161`). Every open bill screen would refetch whenever anyone opened the bill, which is noise and also a timing signal ("Sam just opened it").
3. The foreign key's cascade removes the row when the person leaves, is removed, or deletes their account. Being added again starts unseen, which is correct.

No backfill (BM-15): existing rows have no seen state, so bills you were added to before this ships show "New" until opened. Only bills you were *added* to can be "New" (rule K1), and local dev data is the only data that exists.

### D2. Shared contract: `my_bills()` result ↔ `BillSummary` (Tasks 1 and 3 both point here)

`public.my_bills() returns table (...)`, security definer, `set search_path = ''`, no arguments, so it only ever answers about the caller. It returns the caller's bills, **at most 20** (this is the only place the limit lives; `lib/` doesn't slice), ordered by `joined_at desc, created_at desc, bill_id asc` (BM-12).

| SQL column | Type | Source (for the caller's row on each bill) | `BillSummary` field | lib validation (anything else → whole result `'network'`) |
|---|---|---|---|---|
| `bill_id` | uuid | `bills.id` | `id` | UUID; no duplicate ids in the result |
| `host_id` | uuid | `bills.host_id` | `hostId` | UUID |
| `host_name` | text, null | `profiles.display_name` of the host | `hostName` | string or null |
| `payer_id` | uuid | `bills.payer_id` | `payerId` | UUID |
| `total_cents` | integer | `bills.total_cents` | `totalCents` | `Number.isInteger` |
| `created_at` | timestamptz | `bills.created_at` | `createdAt` | parseable timestamp |
| `joined_at` | timestamptz | caller's `bill_participants.joined_at` | `joinedAt` | parseable timestamp |
| `added` | boolean | caller's `bill_participants.added` | `added` | `typeof === 'boolean'` |
| `seen` | boolean | a `bill_seen` row exists for (bill, caller) | `seen` | `typeof === 'boolean'` |
| `claimed_any` | boolean | the caller has ≥ 1 `claims` row on the bill (any row kind, items or claimable discounts) | `claimedAny` | `typeof === 'boolean'` |
| `complete` | boolean | `private.bill_is_complete(bill_id)`: every `line_items` row, items and discounts alike, has ≥ 1 claim (`20261124081412_settle_marks.sql:24-36`) | `complete` | `typeof === 'boolean'` |

Also: more than 20 rows → `'network'`. Signed out → `42501 not_allowed` → `not_allowed`.

- "Complete" is **not** re-implemented in `lib/` for Home: the marker reads the DB's `complete`. The rule lives once, in `private.bill_is_complete`, the same function `mark_paid` uses. That's why an unclaimed claimable discount counts as "not complete" here, as it does for settling (CD-9, BM-6).
- `my_bills()` returns only the caller's own `seen`. No column says anything about anyone else's seen state.
- `host_name` is a co-participant's name, which `profiles` RLS already lets the caller read (`profiles_select_own_or_co_participant`). The function reveals no profile the caller couldn't already select (criterion 10).

### D3. `mark_bill_seen` (Task 1)

`public.mark_bill_seen(p_bill_id uuid) returns void`, security definer, `set search_path = ''`. Execute revoked from `public, anon, authenticated`, granted to `authenticated`.

| Case | Result |
|---|---|
| signed out | `42501 not_allowed` |
| no such bill, or the caller isn't a participant | `42501 not_allowed` (the same SQLSTATE and message for both; BM-16) |
| participant (host included) | upsert `(p_bill_id, auth.uid(), now())`; a repeat call keeps one row and moves `seen_at` to `now()` |

- Check who may act **before** taking any lock (lessons log 2026-11-24, R4).
- Then lock order: the bills row first (call `private.lock_bill_key_share(p_bill_id)`, `20261124094656_people_review_fixes.sql:91-108`), then the upsert. The header lists every lock in order, implicit ones included (the foreign key's `FOR KEY SHARE` on the participant row on insert; the upsert's row lock on an existing `bill_seen` row), and the extra cascade delete on `bill_seen` that `remove_participant`, `leave_bill` and account deletion now do.
- Logs **no** `bill_events` row. Sends **no** broadcast. Changes no `bill_participants` row. There is no trigger on `bill_seen`. (Read state is private: BM-18.)

### D4. Shared contract: markers and the notice (lib only; `lib/homeMarkers.ts`)

**K1. The one marker a Home row gets** (`billMarker(summary, myId)`; checked in this order, first match wins; BM-7):

| Order | Marker | When | Pill text | Appended to the row's screen-reader label |
|---|---|---|---|---|
| 1 | `'new'` | `hostId !== myId` **and** `added` **and** `!seen` | `New` | `New, you haven't opened it yet` |
| 2 | `'unclaimed'` | `hostId !== myId` **and** `payerId !== myId` **and** `!claimedAny` **and** `!complete` | `Nothing claimed yet` | `You haven't claimed anything yet` |
| – | `null` | otherwise | (none) | (nothing) |

Row label (`billRowA11yLabel`): `billListLabel(summary, myId)` alone when the marker is `null`, else `` `${billListLabel(...)}. ${appended}` ``. Example: "Hana's bill · Nov 20 · $44.80. New, you haven't opened it yet".

Why this doesn't contradict settling (M3): "Nothing claimed yet" needs `!complete`, and settle's "You owe" / "nothing to pay" states exist only once the bill is complete. So a row never says "Nothing claimed yet" for a bill where the settle screen says you owe or owe nothing. The host and the payer are never nudged (BM-5). `'new'` can show on a complete bill: being told you were added is still useful.

"Host and added" can't happen in the DB: `create_bill` inserts the host's row with `added = false`, and `add_participant` is a no-op for anyone already on the bill (`20261124091041_people.sql`, criterion 11 of the people spec). `billMarker` still checks `hostId` first, and H11 tests it.

Boundary cases (`lib/homeMarkers.test.ts`, Task 2). Viewer `me`; host `h`; "guest" = neither host nor payer.

| # | Viewer | added | seen | claimedAny | complete | Expected |
|---|---|---|---|---|---|---|
| H1 | host (also payer) | false | false | false | false | `null` |
| H2 | guest | true | false | false | false | `'new'` |
| H3 | guest | true | true | false | false | `'unclaimed'` |
| H4 | guest | true | true | true | false | `null` |
| H5 | guest, joined with the link | false | false | false | false | `'unclaimed'` (link joiners are never "new") |
| H6 | guest | true | true | false | true | `null` |
| H7 | guest | true | false | false | true | `'new'` |
| H8 | payer, not host | false | true | false | false | `null` |
| H9 | payer, not host | true | false | false | false | `'new'` |
| H10 | guest | true | false | true | false | `'new'` (priority) |
| H11 | host (fixture only; the DB can't produce it) | true | false | false | false | `null` |

**K2. The notice** (`addedNotice(bills, myId)`): the bills whose `billMarker` is `'new'`, in list order. So the notice and the "New" pills always cover exactly the same bills.

| Count | Title | Detail line | Buttons |
|---|---|---|---|
| 0 | no card | | |
| 1 | `<Host> added you to a bill` (`<Host>` = trimmed `hostName`, or `A friend` when null/blank) | `<date> · <total>` from `formatShortDate(createdAt)` and `formatCents(totalCents)`; just `<total>` when the date is `''` | **Open** (label `Open <Host>'s bill`, hint `Opens the bill so you can claim what you had`) and **Dismiss** (label `Dismiss`, hint `Hides this and removes New from the bill`) |
| n ≥ 2 | `You were added to <n> bills` | `They're marked New below.` | **Dismiss** only (label `Dismiss`, hint `Hides this and removes New from these bills`) |

No money arithmetic: the detail line formats `totalCents` as is.

### D5. Home behaviour (Task 5)
- **Card position:** first in the column, between the header and "Split a bill" (BM-10). It's a `Card`, never a modal, and it never navigates on its own. Only the "Open" tap navigates, so it never touches the sign-in resume path (lessons log 2026-11-24, "nudges are dismissible cards").
- **Open:** `router.push('/bills/<id>')`. The bill screen marks it seen (D6), and Home's focus refetch removes the card and the pill on return.
- **Dismiss** (BM-4): the card hides at once. Those bill ids are remembered for as long as Home is mounted, so a refetch that lands before the writes commit can't bring the card back for them. `markBillSeen` is called once per id, then the list is reloaded once after every call has settled. A failed call shows nothing. That row keeps "New" until a later success (opening the bill fixes it). A bill added later still gets a card.
- **Rows:** each row shows its pill (if any) as visible text in the row, plus `billRowA11yLabel` as its label. Colour can't be the only signal: the pill always has its words.
- **Refresh** (BM-11): on focus (as today) **and** when the app returns to the foreground while Home is focused (`AppState` → `'active'`; listener added on focus, removed on blur). On web, react-native-web's `AppState` emits `'change'` from `visibilitychange` (checked in the installed `node_modules/react-native-web/dist/exports/AppState/index.js:20-58`), so switching back to the tab refreshes. What it gives up: if you're looking at Home with the app open when Hana adds you, nothing changes until you open something and come back, or switch away and back. Realtime per user is the upgrade if that's a problem (risk 1).
- The existing "newest response wins" and "a failed refresh keeps the list" behaviour of `loadBills` stays.

### D6. Bill screen (Task 6)
- `app/(app)/bills/[id]/index.tsx` calls `markBillSeen(id)` **once per mount**, after the first load that comes back `ready`. Never for `not_found` or `error`. Later refetches (live hints, focus, foreground) don't call it again.
- Fire and forget: no spinner, no error copy, never blocks or changes the screen (BM-17). A late answer after unmount sets no state.
- The settle, Activity and Add people screens don't call it. You reach them from the bill screen.

### D7. Every state against every action
The person is "S"; Hana hosts. "Row" = what Home's row shows for S.

| S's state → action | Not on the bill | Added, not opened | Added, opened or dismissed | Joined with the link |
|---|---|---|---|---|
| Hana adds S | added; notice + "New" | no-op | no-op | no-op |
| S opens the bill screen | (can't read it) | seen → "Nothing claimed yet"¹ | seen_at moves; same row | seen; row unchanged¹ |
| S taps Dismiss on the notice | n/a | seen → "Nothing claimed yet"¹ | n/a (no card) | n/a (never "new") |
| S opens the bill's link (`join_bill`) | joins; app opens the bill → seen | `added` → false (PI-R-1); "New" gone | `added` → false | no-op |
| S claims a row | n/a | "New" stays until opened² | marker gone | marker gone |
| S unclaims everything | n/a | — | "Nothing claimed yet" again¹ | same¹ |
| Others claim every row | n/a | "New" stays | marker gone (complete) | marker gone |
| Host edits; a row is unclaimed again | n/a | "New" stays | "Nothing claimed yet" again¹ | same¹ |
| Hana makes S the payer | n/a | "New" stays (K1 order 1) | marker gone | marker gone |
| S leaves / Hana removes S | n/a | bill and seen row gone | bill and seen row gone | bill and seen row gone |
| Hana adds S again after that | added; notice + "New" again | — | — | — |
| S deletes their account | cascade removes the participant and seen rows | same | same | same |

¹ Only while S isn't the payer and the bill isn't complete (K1 order 2). ² Claiming happens on the bill screen, which marks it seen; "new with claims" only happens if that call failed (H10).

Nothing in this table logs an event or broadcasts, except the actions that already did (add, join, claim, leave, remove).

### D8. Privacy
- **Only you can read or write your own seen state.** No client role has any privilege on `bill_seen` (`42501` for select, insert, update, delete). The only read is `my_bills()` (the caller's own rows); the only write is `mark_bill_seen` (the caller's own row, on a bill they're on).
- **No read receipts by side channel:** opening a bill writes no event, changes no `bill_participants` row and sends no broadcast, so the host's open screen doesn't even refetch (criteria 6 and 29).
- **The notice reveals nothing new:** it shows the host's name, the date and the total of a bill S can already read.
- **The block gap (BM-14):** a linked person can still add S to bills, and each add now puts a card on S's Home. S's defences are unchanged: open the bill and "Leave this bill" (shown when S has no claims, no mark and isn't the payer), or Dismiss. A real block stays deferred (`docs/before-production.md` §6); Task 7 updates that item to say notices make repeated unwanted adds more visible.

## Tasks
Order: **1** (DB) ‖ **2** (pure lib) ‖ **3** (data layer, written against D2/D3) → **4** (live reconciliation, after 1 and 3) → **5** (Home, after 2 and 3) → **6** (bill screen, after 5; they share `__tests__/billScreen.test.tsx`) → **7** (docs, after everything it describes has landed).

Before Tasks 1 and 4 the main session runs `npm run db:status` and asks the user to start Docker if it's down. No `db:reset` without asking; use `npx supabase migration up`. If the build uses the staff-engineer review for slices with screens on new DB functions, it runs before Task 5.

### Task 1: `bill_seen`, `mark_bill_seen`, `my_bills` (agent: supabase-engineer)
- New migration `supabase/migrations/20261124144925_bill_seen.sql` (timestamp from the main session): D1 table, RLS, grants; D3 function; D2 function. The header lists: columns clients can't read (all of `bill_seen`), the lock order per D3, the 20-row limit, and that nothing here logs or broadcasts.
- New test `supabase/tests/database/bill_markers.test.sql` (criteria 1–16). Assertions filter to fixture rows (lessons log: no whole-table counts).

### Task 2: pure marker logic (agent: implementer)
- New `lib/homeMarkers.ts`: `BillMarker` type, `billMarker` (K1), `BILL_MARKER_COPY` (pill text and appended label per marker), `billRowA11yLabel`, `addedNotice` (K2: returns `null`, `{ kind: 'one', bill, title, detail }` or `{ kind: 'many', billIds, title, detail }`), and the notice's button labels and hints as exported constants.
- New `lib/homeMarkers.test.ts`.
- Uses the `BillSummary` type from D2. If Task 3 hasn't landed, declare the D2 fields in a local test fixture type and switch to the import when it lands. Don't edit `lib/bills.ts` (Task 3 owns it).

### Task 3: data layer (agent: implementer)
- `lib/bills.ts`: `BillSummary` gains the D2 fields; `listMyBills()` calls `my_bills` through `callRpc` and parses per D2 (replacing the `bills` select and `SUMMARY_COLUMNS`); new `markBillSeen(billId)`. `DbFunction` and `ERRORS_BY_FUNCTION` gain `my_bills` and `mark_bill_seen` (both: only `42501` → `not_allowed`, anything else `'network'`).
- `lib/bills.test.ts`: the `listMyBills` tests at `:610-647` assert the old `from('bills')` select, `order('created_at')` and `limit(20)` and **must be rewritten** for the rpc. New tests for `markBillSeen`.
- `lib/billView.test.ts:370-378` builds a `BillSummary` literal for `billListLabel`. It must gain the new fields (or be typed as `Pick<...>`) so `npm run typecheck` passes. `billListLabel`'s output doesn't change.

### Task 4: live reconciliation (agent: implementer, using the `live-db-smoke` skill)
- Script in the scratchpad, throwaway local users A, B, C; keys loaded with `set -a; eval "$(npx supabase status -o env)"; set +a; node <script>.mjs` in one command. Runs `listMyBills`, `markBillSeen`, `addParticipant`, `leaveBill`, `setClaim`, `joinBill` and `billMarker` / `addedNotice` against the live DB. Criteria 26–30.

### Task 5: Home notice and row markers (agent: product-engineer, loading `ui-ux-designer`)
- New `components/AddedNotice.tsx` (the K2 card, D5 behaviour).
- `app/(app)/index.tsx`: render the notice first; pill and `billRowA11yLabel` per row; foreground refresh while focused; dismiss flow.
- New `__tests__/homeMarkers.test.tsx`.
- Existing Home tests read the old `bills` select: `__tests__/shareAndJoin.test.tsx:240-268` (criterion 98 of M2) and `__tests__/billScreen.test.tsx:653-656` must now feed Home through `__setRpc` (`my_bills`). Any other test that renders Home and now gets `null` from the default rpc fake answers `my_bills` with `[]` (as PI-E-14 did for Profile). Assertions keep what they check; the report lists each changed line.

### Task 6: bill screen marks the bill seen (agent: product-engineer)
- `app/(app)/bills/[id]/index.tsx` (D6). The once-per-mount logic may live in a small hook `lib/useMarkSeen.ts` if that's cleaner.
- Existing tests that count **every** rpc call will now also see `mark_bill_seen`. Grep on 2026-11-24 found these whole-rpc assertions in files that render the bill screen: `__tests__/billScreen.test.tsx:183,194,396,403`, `__tests__/extrasSplit.test.tsx:168,216`, `__tests__/itemSheet.test.tsx:138,141,161,253`, `__tests__/shareAndJoin.test.tsx:152,229,235`, `__tests__/contactInvite.test.tsx:337-342`. Narrow the ones that fail **because of `mark_bill_seen`** to the function they meant (a filter by name, like `settle.test.tsx:176` already does). Never delete an assertion. List each changed line in the report.
- New tests in `__tests__/billScreen.test.tsx` for criteria 41–44.

### Task 7: docs (agent: docs-writer; after Tasks 1–6 land)
- `docs/learning/concepts/row-level-security.md`: a short section "Read state is owner-only: `bill_seen`", covering why not a column on `bill_participants` (table-level SELECT, broadcast trigger), and the "no side channel" rule. Add a check-yourself question.
- New concept note `docs/learning/concepts/in-app-notices.md`: push vs in-app notices; refresh on focus and foreground vs per-user Realtime vs polling, and what each gives up; the K1 marker order. Link it from `docs/learning/README.md`.
- `docs/learning/decisions/0016-people-come-from-shared-bills.md`, Consequences: the "being added sends no notice" cost now points to this spec.
- `docs/before-production.md`: the items under "Before-production items" below.
- `docs/decisions-to-review.md`: mark PI-6 "Changed: see BM-1 to BM-18"; update any BM row the build changed.

## Acceptance criteria

### Database: Task 1 (`supabase/tests/database/bill_markers.test.sql`)
1. `public.bill_seen` exists with the D1 columns, primary key `(bill_id, user_id)`, and the foreign key `(bill_id, user_id) → bill_participants (bill_id, user_id) on delete cascade`. RLS is enabled. It has no triggers.
2. `anon`, `authenticated` and `public` hold no privilege on `bill_seen`. As `authenticated`, `select bill_id from public.bill_seen`, an `insert`, an `update set seen_at = now()` and a `delete` each fail with `42501`, including on the caller's own row.
3. `anon` calling `mark_bill_seen(...)` or `my_bills()` fails with `42501` (permission denied for function). Neither `public` nor `anon` has EXECUTE on either; `authenticated` has it.
4. As a participant (guest, and separately the host), `mark_bill_seen(bill)` creates exactly one row for (bill, caller). A second call leaves exactly one row, with `seen_at` ≥ the first value.
5. `mark_bill_seen` signed out, on a bill the caller isn't on, and on a random UUID: each raises `42501` with the same message (`not_allowed`). No row is written.
6. Privacy, no side channel: around a `mark_bill_seen` call, the count of the fixture bill's `bill_events` rows is unchanged, and the caller's `bill_participants` row is equal before and after (all columns). `pg_trigger` lists no non-internal trigger on `bill_seen`.
7. The migration header lists `mark_bill_seen`'s locks in order (the participation check without a lock; `lock_bill_key_share` on the bills row; the foreign-key `FOR KEY SHARE` on the participant row; the `bill_seen` row), and the new cascade delete under `remove_participant` / `leave_bill` / account deletion. The reviewer writes the lock sequence from the code and confirms the bills row comes first. pgTAP can't run two sessions, so this is a review check; the test asserts the function body calls the lock helper before the upsert, as `people_review_fixes.test.sql` does.
8. `my_bills()` as B returns exactly the fixture bills B has a participant row on, in D2 order. As an outsider O it returns none of the fixture bills. Signed out → `42501 not_allowed`.
9. For a fixture bill, every D2 column equals its source: `host_name` is the host's `display_name` (and null when that is null), `payer_id`, `total_cents`, `created_at`, and B's own `joined_at` and `added`.
10. Privacy: for each fixture user U, every non-null `host_name` that `my_bills()` returns as U belongs to a `host_id` that `select id from public.profiles` returns as U (profiles RLS). No row describes another user's `seen`, `claimed_any` or `added`.
11. `seen`: false for B before any call; true after B's `mark_bill_seen`. A's call on the same bill doesn't change B's `seen`, and B's call doesn't change A's.
12. `claimed_any`: false with no claims; true with a claim on unit 2 of a two-unit item; true with a claim only on a claimable discount row (`kind = 'discount'`); false again after that claim is removed.
13. `complete` equals `private.bill_is_complete(bill)` on three fixtures: every row claimed (true); one unit of a two-unit item unclaimed (false); every item claimed but one claimable discount row unclaimed (false).
14. Membership: B (added, seen) leaves with `leave_bill` → B's `bill_seen` row is gone and `my_bills()` as B no longer lists the bill. A adds B again → `my_bills()` as B lists it with `added = true, seen = false`. B then calls `join_bill(<code>)` → `added = false`.
15. Order and limit: X created before Y; B joins Y, then A adds B to X → X comes before Y. Two bills with equal `joined_at` come in `created_at desc`, then `bill_id asc`. With 21 fixture bills for one user, exactly 20 are returned and the earliest-joined one is dropped.
16. `npm run db:test` passes in full: every existing pgTAP file plus the new one.

### Pure lib: Task 2 (`lib/homeMarkers.test.ts`)
17. `billMarker` gives H1–H11 exactly.
18. `BILL_MARKER_COPY` and `billRowA11yLabel` give the K1 strings exactly: with H2's summary (host "Hana", Nov 20, 4480) → "Hana's bill · Nov 20 · $44.80. New, you haven't opened it yet"; H3's → "Hana's bill · Nov 20 · $44.80. You haven't claimed anything yet"; H4's → "Hana's bill · Nov 20 · $44.80" (date through an injected formatter, as `lib/billView.test.ts` does).
19. `addedNotice`: no new bills → `null`. One → `kind 'one'`, title "Hana added you to a bill", detail "Nov 20 · $44.80"; host name null or "  " → "A friend added you to a bill"; a date formatter returning `''` → detail "$44.80". Three → `kind 'many'`, title "You were added to 3 bills", detail "They're marked New below.", `billIds` in list order. A bill the viewer hosts never counts, even with `added: true` (H11). The set always equals the bills whose `billMarker` is `'new'` (checked over every H fixture).
20. The notice's button labels and hints equal the K2 table. `grep -rn "'Nothing claimed yet'" app components lib` matches only `lib/homeMarkers.ts` (run with the Grep tool on 2026-11-24 over `lib`, `app`, `components`: no matches today, because the file doesn't exist yet).

### Data layer: Task 3 (`lib/bills.test.ts`)
21. `listMyBills()` calls `rpc('my_bills', {})` once and makes no `from('bills')` query. It returns the rows as `BillSummary`s in the order received, with every D2 field.
22. The whole result is `{ ok: false, error: 'network' }` for: a non-UUID `bill_id`, `host_id` or `payer_id`; `total_cents` `1.5` or `"4480"`; `added`, `seen`, `claimed_any` or `complete` as `"true"`, `1` or `null`; an unparseable `created_at` or `joined_at`; two rows with the same `bill_id`; 21 rows. `42501` → `not_allowed`; a thrown rpc → `network`. Server text never appears in a result.
23. `markBillSeen('x')` → `not_found` with no rpc call. `markBillSeen(BILL)` calls `rpc('mark_bill_seen', { p_bill_id: BILL })` and returns `{ ok: true }`; `42501` → `not_allowed`; any other code → `network`.
24. `npm run typecheck` passes with the new `BillSummary` (including the updated literals in `lib/billView.test.ts`), and `billListLabel`'s existing tests pass unchanged in what they assert.
25. The app never reads the table directly: `grep -rnE "from\('bill_seen'\)" lib app components` prints nothing, and `grep -rnE "\.select\(\)|select\('\*'\)" lib app components` prints nothing. (Both run with the Grep tool on 2026-11-24 over the same paths: no matches today.)

### Live reconciliation: Task 4 (live local DB, throwaway users)
26. A creates X, then Y. B joins Y with the link. A calls `addParticipant(X, B)`. As B, `listMyBills()` lists X first, then Y. X has `added: true, seen: false, claimedAny: false, complete: false`, and `billMarker` gives `'new'`. Y gives `'unclaimed'`. `addedNotice` gives `kind 'one'` for X with A's display name.
27. As B, `markBillSeen(X)` → `ok`. `listMyBills()` now shows X with `seen: true` and marker `'unclaimed'`, and `addedNotice` is `null`. After B's `setClaim(<row of X>, true)`, X's marker is `null`.
28. As C (not on X), `markBillSeen(X)` → `not_allowed`, and C's `listMyBills()` has no X. As A, `supabase.from('bill_seen').select('bill_id')` fails with `42501`.
29. No side channel: A subscribes to X with `subscribeToBill` and waits for its first `SUBSCRIBED` refetch. B then calls `markBillSeen(X)`. A's `onChange` isn't called again within 3 s (starting value; the debounce is 300 ms). As a control, B's `setClaim` on X does call A's `onChange` within 3 s.
30. B unclaims and `leaveBill(X)` → `ok`; X is gone from B's list. A adds B to X again: X is back with `seen: false` and marker `'new'`. Every call's result matches D2 and D3 (no `network` results).

### Home: Task 5 (`__tests__/homeMarkers.test.tsx`)
31. With `my_bills` returning one bill matching H2, Home shows the card first in the column (above "Split a bill") with "Hana added you to a bill", "Nov 20 · $44.80" (formatted from the fixture), "Open" and "Dismiss". The bill's row shows the text "New", and its label is criterion 18's string.
32. "Open" pushes `/bills/<id>` once. With two new bills the card says "You were added to 2 bills" and "They're marked New below.", and shows no "Open".
33. "Dismiss" hides the card at once, calls `mark_bill_seen` once per notice bill with exactly `{ p_bill_id }`, then calls `my_bills` again once after those calls settle. A refetch answered before the writes commit (still `seen: false`) doesn't bring the card back. When a `mark_bill_seen` call fails, no error is shown and the card stays hidden. A bill that turns up as new later still shows a card.
34. Rows: an H3 bill shows "Nothing claimed yet"; H1, H4, H6 and H8 bills show no pill. Each row's `accessibilityLabel` is `billRowA11yLabel`'s output, and each pill is rendered as text (not colour alone).
35. Foreground: with Home focused, an `AppState` change to `'active'` calls `my_bills` again. After navigating away from Home (blurred), an `'active'` change doesn't. Unmounting Home leaves no `AppState` listener behind and sets no state (no `act()` warnings).
36. No interruption: with a saved invite pending and the app opening on `/` (the web OAuth landing path), Home mounting with a new bill in `my_bills` doesn't navigate; the resume effect's navigation is the only `router.replace`. Tested with `Platform.OS` `'ios'` and `'web'` (lessons log 2026-11-24, "home mounting while the invite resumes").
37. `my_bills` failing on first load still shows "Couldn't load your bills." with "Try again", and no card. A failed refresh keeps the list and card on screen (existing behaviour).
38. `__tests__/shareAndJoin.test.tsx` criterion 98 tests and `__tests__/billScreen.test.tsx:653-656` pass, fed through `my_bills`, with the same expectations ("Your bills", row opens its bill, "No bills yet.").
39. Every new button has an `accessibilityLabel` and the K2 hint. Copy, labels and the pill text come from `lib/homeMarkers.ts`, not from literals in `app/` or `components/`.
40. Components do no money arithmetic: no `+` or `-` on cents in `components/AddedNotice.tsx` or the Home changes (reviewer check).

### Bill screen: Task 6 (`__tests__/billScreen.test.tsx`)
41. Opening a bill that loads `ready` calls `mark_bill_seen` exactly once with `{ p_bill_id: <id> }`. A live-hint refetch, a focus refetch and an `AppState` `'active'` refetch after that don't call it again. Remounting the screen calls it once more.
42. A bill that loads `not_found` or `error` never calls `mark_bill_seen`.
43. `mark_bill_seen` failing (`42501`, a network error, or a promise that never resolves) changes nothing on screen: no error text, no spinner, claims still work. An answer after unmount sets no state (no `act()` warnings).
44. The existing whole-rpc assertions listed in Task 6 still check the same writes, narrowed by function name where `mark_bill_seen` made them fail. No assertion was deleted (the report lists the changed lines).

### Whole slice
45. `npm test -- --maxWorkers=4` and `npm run typecheck` pass. A failure only in files this slice didn't touch is reported as outside the task (lessons log).
46. `npm run export:web` succeeds, and `grep -rE "service_role|sb_secret_" dist/` prints nothing except the documented Tesseract CDN match (CLAUDE.md). Build into the scratchpad in the same run if QA checks bundle contents (lessons log 2026-11-24).
47. Docs (Task 7): the RLS section and the new concept note exist and are linked from `docs/learning/README.md`; `docs/before-production.md` has every item listed below; PI-6 is marked changed in `docs/decisions-to-review.md`.

### User checks (need a person; QA lists them "for the user")
- **U1. Notice and markers on web (two Google accounts, local Supabase).** Do this after QA has verified criteria 26–30 live.
  1. As A: create bill X; share its link; B joins in a second browser profile and claims nothing.
  2. Leave B's tab on Home. As A: create bill Z, then Add people → "Add" next to B.
  3. As B: switch to another tab, then back to SplitIt's tab. The card "A added you to a bill" appears and Z's row says "New". (If it doesn't, reload, and note that the foreground refresh didn't fire.)
  4. Tap "Open", then go back: the card is gone and Z's row says "Nothing claimed yet". X's row also says "Nothing claimed yet".
  5. Claim an item on Z and go back: Z's row has no pill.
  6. As A: add B to two more bills. As B: the card says "You were added to 2 bills". Tap "Dismiss": the card goes, and both rows say "Nothing claimed yet".
  7. Record whether the card felt noticeable but not pushy, and whether "Nothing claimed yet" on X felt helpful or naggy.
- **U2. Screen reader.** VoiceOver (iOS simulator) or a browser screen reader: a "New" row reads "…, New, you haven't opened it yet"; the card's buttons read "Open A's bill" and "Dismiss" with their hints.
- **U3. iOS simulator foreground refresh (reaches the Mac's `127.0.0.1:54321`).** With B signed in on the simulator on Home, have A add B on web. Press Home on the simulator (Cmd-Shift-H), reopen SplitIt: the card appears.
- **U4. Light and dark mode** on Home with the card and both pills: the pills are readable, and not by colour alone.
- **Physical iPhone: blocked.** On the phone `127.0.0.1` is the phone itself. It waits for the friend-test deploy (hosted Supabase, `docs/before-production.md` §5) or the Mac's LAN IP as `EXPO_PUBLIC_SUPABASE_URL` plus matching Supabase/Google redirect URLs.

## Device checks: how the device reaches the backend
- Web and the iOS simulator use the Mac's `http://127.0.0.1:54321` directly.
- A physical phone can't. Nothing in this slice sets up a route, so phone checks stay blocked.

## Before-production items (Task 7 adds them to `docs/before-production.md`)
- §6 Privacy: SplitIt now stores when each person last opened each bill (`bill_seen`). It's visible to nobody but that person, but it's usage data. Mention it in the privacy policy and the store data-safety forms ("app activity: bills you've opened, not shared").
- §6 Privacy / abuse (extends the existing "no block" item): each add now puts a card on the added person's Home, so repeated unwanted adds are more intrusive. Decide on "Don't let <name> add me" before public links.
- §4: push the new migration to the hosted project and run `bill_markers.test.sql` there.
- §4: `my_bills()` returns 20 bills (starting value, the existing Home limit). An added bill is ordered by when you were added, so it shows; older bills beyond 20 still can't be reached from Home (existing gap: no "show more").
- §8 / product: there's no live delivery. A notice appears on focus or on returning to the app. Revisit with per-user Realtime or push before launch if testers miss adds.

## Risks
1. **No live delivery on an open Home** (BM-11). Someone staring at Home won't see the card until they navigate or switch apps. Upgrade path: a private `user:<id>` Realtime topic plus a broadcast from `add_participant` (new `realtime.messages` policy, new trigger). Not built because focus and foreground cover the common case with no new moving parts.
2. **Dismiss marks bills seen** (BM-4). If the user wants "New" to stay on rows after dismissing the card, that needs a separate per-user dismissed timestamp. Cheap to add later.
3. **"Nothing claimed yet" hides for the payer and host** (BM-5). A host who ate but forgot to claim gets no nudge. Settle up already blocks with "N items left to claim" on the bill screen.
4. **Test churn** from the new rpc calls (Tasks 5 and 6). Listed up front, but whole-rpc counts in other files may surface during the run.
5. **The bill screen marks seen after its first load.** A user who backs out within a moment of opening can return to Home before the write lands and still see "New" until the next refresh. Rare; harmless.

## Truly blocking questions
None. No new provider, no money rule (the markers read `private.bill_is_complete`; nothing computes shares), and nothing hard to reverse: one table and two functions that a migration can drop. The only privacy-relevant choice, storing per-user "opened" state, is owner-only and listed as "needs your look" in BM-2.
