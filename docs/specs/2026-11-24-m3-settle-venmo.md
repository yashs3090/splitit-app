# M3: Settle up with Venmo

Date: 2026-11-24. Milestone: "M3 (S)" in `docs/plans/bill-splitting-app-2026-11-19.md` (user decisions 2026-11-24).
Repo: `splitit-app` only (ADR 0011). Database changes go in `supabase/migrations/` and `supabase/tests/database/`. **The main session assigns migration timestamps and any ADR number** (lessons log, parallel-work rule).
**Amendment A1 (2026-11-24, UX brief + staff-engineer review):** the settle screens follow `docs/specs/2026-11-24-m3-settle-ux.md`. Tasks 8, 9 and 11 are replaced by a new Task 8 (pure view logic) and Task 9 (one screen task, one design pass). Task 10 follows the brief's §7. Criteria 42–54 are rewritten below. D4 is superseded by the brief where they differ. The decisions are logged as M3-UX-1 … M3-UX-15 in `docs/decisions-to-review.md`. DB, lib contracts (C1–C5, D1–D3) and Tasks 1–7 and 12 are unchanged. Exception: `lib/settle.ts` gains `markDiffers` / `markDiffCents` in the new Task 8, instead of in the old Task 11.

Depends on: `docs/specs/2026-11-24-profile-venmo.md`. Its migration `supabase/migrations/20261124072017_profile_venmo.sql` and `lib/venmo.ts` are already on disk. `profiles.venmo_username` can be read by co-participants.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already running) | 3 columns, 3 functions, 1 broadcast trigger, new event kinds | $0, already set up |
| Google sign-in + a second test account (already set up, M2 step U1) | two-account QA on web | $0 |
| Venmo app + the user's own Venmo account on a phone | **QA only**: checking that the link opens Venmo with the fields filled in. No Venmo API, no developer account, no money moves (the tester never presses Pay) | $0 |
| Android phone with Venmo (optional) | the same link check on Android | $0. If there isn't one, the Android check is marked not run |
| Apple Developer (paid) / hosted Supabase | **Not needed.** The in-app check on a physical phone is blocked (see criterion 66) | $0 |

Nothing new to sign up for.

## Goal
Once every item is claimed, each person who owes money opens the bill and taps "Pay Sam $15.10 on Venmo". Venmo opens with Sam's username, the exact amount and a note filled in. Back in the app they tap "I paid", and Sam and the host see it live. This works the same for the host and for guests, whoever paid the restaurant.

## User decisions (2026-11-24, fixed)
1. Venmo only. PayPal and Cash App come later.
2. **The host chooses who gets paid** (called "the payer" in this spec: the person who paid the restaurant). It defaults to the host. Once others have joined, the host can set any participant as the payer.
3. Everyone else pays the payer. The payer owes nothing.
4. Each person who owes taps "Pay <payer> $X on Venmo", which opens a Venmo link with the payer's username, the amount and a note filled in.
5. Each person marks "I paid" themselves. It's self-reported, because the app can't check Venmo. The host can undo a wrong mark.
6. Settling works the same when someone else created the bill.

Proposed by the coordinator; the user didn't object:
- Only the host changes the payer.
- Changing the payer clears every "I paid" mark, after a confirm that says how many marks will be cleared.
- The payer must be a current participant.
- A payer change is logged in Activity.

Recorded earlier: settling is never allowed while any item is unclaimed (M2 spec A2.2a, ADR 0014).
*Changed 2026-11-25 by docs/specs/2026-11-25-settle-early-and-differences.md: on proportional bills, a person who has claimed an item may settle early (ADR 0021); even-mode bills still wait.*

**Words in this spec:** the *payer* is the person who paid the restaurant and collects the money. *People who owe* are everyone else. A *mark* is one person's "I paid". The app never shows the word "payer"; it uses names ("Sam paid the bill", "Pay Sam").

## In scope
- DB: `bills.payer_id`; `bill_participants.settled_at` and `settled_cents` (the mark); the rule that the payer is always a participant; `set_payer`, `mark_paid` and `unmark_paid` (security definer, ADR 0013); a shared "bill is complete" helper; a broadcast when `bill_participants` rows are updated; three new Activity kinds. pgTAP tests.
- `lib/paylinks.ts`: the one Venmo URL builder (ADR 0007) and the one opener.
- `lib/settle.ts`: pure settle plan built on `computeShares` (who owes whom how much, and the marks).
- `lib/bills.ts`: read the new fields, plus wrappers for the three functions.
- `lib/activityText.ts`: sentences for the new kinds.
- A Settle screen and its entry point (the shape waits on Q2).
- Learning notes, an ADR, and `docs/before-production.md` items.

## Out of scope (cut)
- PayPal and Cash App (later; the same builder module and the same mark columns are reused).
- Checking with Venmo that a payment happened, or that a username exists (no API).
- Venmo "request" links (`txn=charge`) so the payer can request money. Not asked for. *(2026-11-25: the user asked for it; the `txn=charge` V1-style link was confirmed on iPhone. Built in a follow-up spec.)*
- Several payers per bill, running balances across bills, debt simplification (plan v2).
- A bill-level "settled" status or archiving. The screen just says "Everyone's paid".
- Reminders or notifications to people who haven't paid (plan v1).
- A host tool for leftover unclaimed items, unless the user picks it in Q1.
- The host or payer marking someone else as paid ("Sam gave me cash"). Not asked for; listed under Later.
- Physical-phone in-app checks (blocked until a hosted backend exists; criterion 66).

## Design

### D1. Data model (Task 1 and Task 2 implement it; Task 5 reads it)

| Field | Shape | Meaning | Client access |
|---|---|---|---|
| `bills.payer_id` | `uuid not null` | who gets paid. Set to `host_id` when the bill is created, and backfilled to `host_id` on existing bills | SELECT (existing table-level grant on `bills`). No UPDATE: it changes only through `set_payer` |
| `bill_participants.settled_at` | `timestamptz null` | when this person tapped "I paid"; null means not marked | SELECT (existing table-level grant). No UPDATE |
| `bill_participants.settled_cents` | `integer null`, rule C2 | the amount the screen showed them when they tapped "I paid" | same |

- Check constraint: `(settled_at is null) = (settled_cents is null)`.
- **Why store `settled_cents`:** the UI must be able to say exactly what was marked ("Marked paid $15.10"), and Q3 option A compares it with the current share. The database can't compute shares (the split math lives in `lib/split.ts`), so this is the only record of the amount.
- **Payer is always a current participant (invariant P).** At commit, `(bills.id, bills.payer_id)` must exist in `bill_participants`. The supabase-engineer picks the mechanism and says which in the migration header. One option is a composite FK `(id, payer_id) → bill_participants (bill_id, user_id)`, `deferrable initially deferred`, because `create_bill` inserts the bill before the host's participant row. A trigger is another. Either way:
  - `create_bill` keeps its signature. A `before insert` trigger on `bills` (or an equivalent) sets `payer_id = host_id`. `create_bill` is not re-created.
  - **If the payer's participant row is deleted** (account deletion cascades from `profiles`), the account deletion must still succeed. The payer becomes the host, every mark on that bill is cleared, and one `payer_changed` event is logged with `actor_id` null. If the host is the one deleted, the whole bill cascades as today.
- **Visibility (waits on Q5, recommended A):** every participant can read every participant's mark. That is what the existing table-level SELECT grant on `bill_participants` gives, so no grant changes. If the user picks Q5 B, Task 1 changes to column grants plus a reader function, and criterion 5 is rewritten.
- Nothing here assumes people joined through the link. The later "People you've split with" slice adds participant rows another way. New rows get null marks, and they appear in the payer picker like anyone else.

### D2. Shared contracts (defined once; DB tasks and lib tasks both point here)

**C1. "The bill is complete"** (settling is allowed only then).
*Formula:* every `line_items` row of the bill has at least one `claims` row.
- In the DB: `private.bill_is_complete(p_bill_id uuid) returns boolean` (Task 2), used by `mark_paid`.
- In the app: `sharesComplete` / `displayShares(...).complete` in `lib/split.ts`, unchanged. `lib/settle.ts` uses that result and nothing else.
- The two are the same rule. A claim always belongs to a participant (`claims_participant_fkey`) and has parts ≥ 1 (`claims_parts_range`), so `normalize()` never drops a claim the database stores.

Boundary cases. Both `supabase/tests/database/settle_marks.test.sql` and `lib/settle.test.ts` test each one.

| # | Bill state | Complete? |
|---|---|---|
| K1 | every row has ≥ 1 claim | yes |
| K2 | "Beer ×2" (two unit rows): unit 0 claimed, unit 1 not | no (1 row left) |
| K3 | everything claimed except one $0.00 row | no (1 row left) |
| K4 | one row shared by 2 claimers, all other rows claimed | yes |
| K5 | K1, then the host's `update_bill` adds a new row | no (1 row left) |
| K6 | proportional, all rows $0.00, total > 0, all claimed | lib `blocked_all_zero`; DB complete, mark accepted (intentional; honor-system marks, no money effect. Review R2, M3-B-12) |

*K6: Changed 2026-11-25 by docs/specs/2026-11-25-settle-early-and-differences.md: the DB now refuses the mark with `22023 all_zero` (K6 closed, ADR 0021).*

**C2. The amount of a mark** (`settled_cents`, and `p_cents` of `mark_paid`).
*Rule:* an integer from 1 to 99,999,999 inclusive (the `bills_total_cents_range` upper bound).
- Not "≤ the bill total": in even mode with a big discount, one person's share can exceed the bill total while another's is negative (for example, items 1000¢ and 0¢, total 800¢, extras −200¢ split evenly gives 900¢ and −100¢).
- In the DB: a check constraint on `settled_cents`, and `mark_paid` raises `22023 invalid_amount` first.
- In the app: `markPaid` in `lib/bills.ts` refuses locally, with no network call. `venmoPayUrl` returns null outside the range.

| # | Value | App | DB |
|---|---|---|---|
| A1 | `0` | refused locally | `22023 invalid_amount` |
| A2 | `1` | sent | accepted |
| A3 | `99999999` | sent | accepted |
| A4 | `100000000` | refused locally | `22023 invalid_amount` |
| A5 | `-5` | refused locally | `22023 invalid_amount` |
| A6 | `null` | (type error) | `22023 invalid_amount` |
| A7 | `12.5` | refused locally | n/a (integer parameter) |

**C3. Database functions.** All are `security definer set search_path = ''`, with schema-qualified names, `auth.uid()` checked first, execute revoked from `public, anon` and granted to `authenticated` only. Errors are a fixed SQLSTATE plus a fixed message (ADR 0013).

| Function | Who may call | Behaviour | Errors |
|---|---|---|---|
| `public.set_payer(p_bill_id uuid, p_payer_id uuid, p_expected_cleared integer) returns void` | the host | Locks the bill row (`for update`). If `p_payer_id` is the current payer: no-op (no update, no event, marks kept). Otherwise it counts the bill's marks; if that count ≠ `p_expected_cleared`, it raises `marks_changed` and changes nothing. Then it sets `payer_id`, clears every mark on the bill, and logs one `payer_changed` | signed out, not the host, or no such bill: `42501 not_allowed`. Payer null or not a participant: `22023 not_participant`. `p_expected_cleared` null or wrong: `22023 marks_changed` |
| `public.mark_paid(p_bill_id uuid, p_payer_id uuid, p_cents integer) returns void` | a participant who isn't the payer | Locks the bill row, in a way that runs one after the other with `set_payer` (`for update` or `for share`). Checks in this order: participant, amount (C2), payer matches `p_payer_id`, caller isn't the payer, bill complete (C1). If the caller is already marked: no-op (keeps the first time and amount, no event). Otherwise sets `settled_at = now()`, `settled_cents = p_cents`, and logs one `marked_paid` | not a participant, signed out, or no such bill: `42501 not_allowed`. C2 fails: `22023 invalid_amount`. Payer changed since the screen loaded: `22023 payer_changed`. Caller is the payer: `22023 is_payer`. Not complete: `22023 not_complete` |
| `public.unmark_paid(p_bill_id uuid, p_user_id uuid) returns void` | **waits on Q4** (recommended: the host, the person themself, and the payer) | Locks the bill row. If the target isn't a participant or isn't marked: no-op, no event. Otherwise it clears the target's mark and logs one `unmarked_paid` | anyone else, signed out, or no such bill: `42501 not_allowed` |
| `private.bill_is_complete(p_bill_id uuid) returns boolean` | not callable by any client role (execute revoked from `public, anon, authenticated`) | rule C1 | — |

Why the "expected" parameters: both destructive choices are made on what a screen showed, and that can be out of date (lessons log, "decisions that can destroy data re-check server state"). `p_expected_cleared` stops the host from wiping a mark that arrived after the confirm was shown. `p_payer_id` stops someone from marking a payment to the new payer after paying the old one.

**C4. Activity events** (written only through `private.log_event`; the `bill_events_kind_known` constraint gains three kinds):

| Kind | Actor | `details` | Starting sentence (`lib/activityText.ts`) |
|---|---|---|---|
| `payer_changed` | the host (null when caused by an account deletion) | `{ before: uid, after: uid, cleared: int ≥ 0 }` | "Hana changed who gets paid to Sam" plus, when `cleared > 0`, " and cleared 2 'I paid' marks" ("1 'I paid' mark" when it's one) |
| `marked_paid` | the person | `{ payer_id: uid, cents: int }` | "Sam marked that they paid Hana $15.10" |
| `unmarked_paid` | whoever undid it | `{ user_id: uid, cents: int }` | the actor is the person: "Sam undid their 'I paid'". Anyone else: "Hana undid Sam's 'I paid' ($15.10)" |

- Logging `marked_paid` and `unmarked_paid` waits on Q9 (recommended yes).
- Events hold user ids and cents only: no handles, no names.

**C5. Venmo link** (`lib/paylinks.ts` is the only place it is built).
- **Venmo no longer documents the format.** ADR 0007 cites `https://venmo.com/paymentlinks`. On 2026-11-24 that page shows Venmo's Business Profile marketing, and neither it nor `venmo.com/docs/payments` documents `txn`, `recipients`, `amount` or `note`. The formats below come from ADR 0007 (copied from that page on 2026-11-19) and from third-party write-ups. **Verify on a device (criterion 64). If the tool differs, reword this section.**
- **V1 (starting value):** `https://venmo.com/?txn=pay&recipients=<username>&amount=<amount>&note=<note>`
- **V2 (fallback if V1 doesn't fill in the fields on a phone):** `https://venmo.com/<username>?txn=pay&amount=<amount>&note=<note>`
- Rules for both:
  - `<username>` is the stored `venmo_username`. It must match `VENMO_USERNAME_PATTERN` (`lib/venmo.ts`); otherwise there's no link. It's passed through `encodeURIComponent` anyway, which changes nothing for allowed characters.
  - `<amount>` comes from integer cents through `formatCentsInput` (`lib/money.ts:63`): exactly two decimals, no `$`, no thousands separator (`1` → `0.01`, `123450` → `1234.50`). Only for cents in C2.
  - `<note>` is `encodeURIComponent(SETTLE_NOTE)`. `SETTLE_NOTE` is one constant whose starting copy is `SplitIt` (waits on Q7). It never contains names, item names or amounts, because Venmo notes can show on a public feed.
    - Superseded 2026-11-25 by docs/specs/2026-11-25-venmo-note-item-names.md
  - No other parameters. `audience=private` is described by third parties but unverified; add it only if the device check shows Venmo honours it, and record that as an amendment.
- **Opening the link:** `openPaymentLink(url)` calls `Linking.openURL(url)` from `react-native` on every platform.
  - Verified in the installed `react-native-web@0.21.4`: `node_modules/react-native-web/dist/exports/Linking/index.js:76-100`. On web it runs `window.open(url, '_blank', 'noopener')` and resolves even when a popup blocker stops it, so a web failure can't be detected.
  - iOS / Android: an `https` link opens the Venmo app when it's installed (universal link / app link) and the browser otherwise. Using `https` rather than `venmo://` means no `LSApplicationQueriesSchemes` entry and no undocumented scheme. *Verify on device (criterion 64).*
  - Desktop web: third-party reports say venmo.com can't start a payment in a desktop browser (unverified). See Q8.
  - Opening the link **never** marks anything as paid. Only the "I paid" tap does.

### D3. Who owes what (`lib/settle.ts`, Task 4)
- Input: the same `SplitInput` the bill screen builds (`splitInputFor` in `lib/billView.ts:117`), plus `payerId` and the marks (`settled_cents` per user).
- **Not complete (C1 is false):** the result is `{ status: 'blocked', unclaimedRows }`, with no amounts. That keeps even mode's "totals hidden until all claimed" rule.
- **Complete:** `computeShares` runs once. For each participant other than the payer, `owedCents = people[i].totalCents` exactly. The payer's own share is never collected.
  - `role`: `'owes'` if `owedCents > 0`, `'nothing'` if `= 0`, `'payer_owes_them'` if `< 0` (copy waits on Q6).
  - `mark`: `{ cents, at } | null`.
  - Also returned: `collectCents` (Σ positive `owedCents`), `paidCount` / `owingCount` (people with role `'owes'` who are marked or not), and `allPaid` (every `'owes'` person is marked).
  - **Invariant:** `Σ owedCents (non-payers) + payer's share === bill total`, because the shares from `computeShares` already add up to the total and unclaimed is 0 when the bill is complete.
- Components do no money arithmetic (lessons log). Every amount on the Settle screen comes from this result and `formatCents`.

**Worked example (both tests use it):** Hana (A) hosts, Sam (B) joined. Rows: Burger 1500¢ (A), Salad 1000¢ (B), Fries 600¢ (A and B, 1 part each). Total 3600¢, so extras are 500¢.
- Items: A 1500 + 300 = 1800; B 1000 + 300 = 1300.
- Proportional: extras weights [1800, 1300, unclaimed 0]. Floors are 290 and 209; the spare cent goes to B (remainder 2100 > 1000). So A = 2090, B = 1510.
  - Payer A: Sam sees "Pay Hana $15.10 on Venmo".
  - Payer B: Hana sees "Pay Sam $20.90 on Venmo".
- Even: extras 250 each, so A = 2050, B = 1550. Payer A: Sam owes 1550.
- Three-way tie check: with three people at $5.00/$3.00/$2.00 of items and a $10.00 tip in even mode, the tips are 334/333/333 (ADR 0014). The person with the lowest user id gets the spare cent, and their owed amount includes it.

### D4. Settle screen (content; the layout is subject to the design pass and Q2)
*Superseded by `docs/specs/2026-11-24-m3-settle-ux.md` (Amendment A1) wherever they differ. Kept for history.*
Top to bottom, and nothing else:
1. Back.
2. Header "Settle up".
3. "<Payer> paid the bill". The host sees a quiet "Change" next to it when the bill has ≥ 2 participants.
4. **Blocked:** "You can settle up once every item is claimed (3 items left)." and "Back to the bill". No amounts.
5. **You owe (role `owes`), not marked:**
   - "You owe Sam $15.10".
   - Primary button "Pay Sam $15.10 on Venmo", with "@sam-handle" under it, so a typo'd handle is visible before money moves (profile spec, Risks).
   - Secondary button "I paid".
   - If the payer has no Venmo username: no Venmo button; the text "Ask Sam to add their Venmo" instead. "I paid" stays, because they may pay another way.
6. **You owe, marked:** "You marked this paid ($15.10)", plus "Undo" if Q4 allows it.
7. **Nothing owed:** "You don't owe anything on this bill."
8. **You are the payer:**
   - With no username: "Add your Venmo so people can pay you" plus "Add Venmo" (opens `/profile`; the screen refetches on focus).
   - Then "Sam and 2 others owe you $45.20 · 1 paid".
9. **Everyone list** (visibility per Q5): one row per person who owes, with name, amount and "Paid" / "Not yet". The host (and others, per Q4) see "Undo" on paid rows. When `allPaid`: "Everyone's paid."

**Changing the payer (host):**
- "Change" opens a list of participants (the current payer is marked).
- Picking someone first **re-reads the bill**. If there are marks, the confirm says "This clears 2 'I paid' marks. Change who gets paid to Sam?" With zero marks there is no confirm (nothing is lost; PM default, see "Defaults to confirm").
- It then calls `set_payer(..., expected = the count shown)`. On `marks_changed` it refetches and asks again with the new count.

## Tasks
Order (Amendment A1): **1 → 2** (DB) ‖ **3, 4** (lib, pure) → **5** (data layer, against the C3 contract) → **6** → **7** (reconciliation, after 2 and 5) → **8** (settle view logic) → **9** (Settle screen) ‖ **10** (entry point, after 8) → **12** (docs, after everything it describes has landed). There is no Task 11; it was merged into 8 and 9.

Nothing waits on the user: Q1–Q10 are answered, and the UX choices are logged in `docs/decisions-to-review.md` (M3-UX-*).

Files other sessions are editing, which no task here touches: `lib/receiptText.ts`, `lib/scanPipeline/**`, `lib/webOcr*.ts`, `lib/prepareImage*.ts`, `app/(app)/scan.tsx`. Re-check with the main session before starting, because the profile slice is still landing.

### Task 1: payer column, marks columns, invariant, `set_payer`, broadcast, event kinds (agent: supabase-engineer)
Files: `supabase/migrations/<assigned>_settle_payer.sql` (new), `supabase/tests/database/settle_payer.test.sql` (new).
- D1 columns and constraints, the backfill `payer_id = host_id`, then `not null`. Invariant P and the account-deletion behaviour.
- `set_payer` per C3.
- Replace `bill_events_kind_known` with the old list plus `payer_changed`, `marked_paid` and `unmarked_paid`.
- `create trigger bill_participants_broadcast_update after update on public.bill_participants referencing new table as new_rows for each statement execute function private.broadcast_bill_change();`. The existing function already handles any table with a `bill_id` column (`20261121075448_bill_edit_realtime.sql:173-178`).
- Restate the grants (no new client privileges): `bills` and `bill_participants` keep SELECT only.
- Apply with `npx supabase migration up` (not `db reset`). Run `npm run db:test`.
- About 150 lines of SQL and 150 of pgTAP.

### Task 2: `bill_is_complete`, `mark_paid`, `unmark_paid` (agent: supabase-engineer)
Files: `supabase/migrations/<assigned>_settle_marks.sql` (new), `supabase/tests/database/settle_marks.test.sql` (new).
- C1, C2 and C3 for these three functions, plus C4 events. The `unmark_paid` caller set follows Q4; event logging for marks follows Q9.
- pgTAP covers K1–K5 and A1–A6 literally.

### Task 3: Venmo link builder and opener (agent: implementer)
Files: `lib/paylinks.ts` (new), `lib/paylinks.test.ts` (new).
- Export:
  - `SETTLE_NOTE`;
  - `VENMO_LINK_FORMAT: 'v1' | 'v2'` (starting `'v1'`);
  - `venmoPayUrl({ username, cents }): string | null`, which uses `SETTLE_NOTE` itself, so callers can't pass names into the note;
  - `openPaymentLink(url): Promise<{ ok: boolean }>`.
- Uses `VENMO_USERNAME_PATTERN` from `lib/venmo.ts` and `formatCentsInput` from `lib/money.ts`. It defines no pattern or money formatting of its own.

### Task 4: settle plan (agent: implementer)
Files: `lib/settle.ts` (new), `lib/settle.test.ts` (new).
- `settlePlan(input: SplitInput, payerId: string, marks: Record<string, { cents: number; at: string } | null>): SettlePlan` per D3.
- A `payerId` that isn't in `participantIds` gives `{ status: 'blocked_bad_payer' }`; the screen shows a generic error and refetches. That can't happen with invariant P, but the result is never silently wrong.

### Task 5: data layer (agent: implementer)
Files: `lib/bills.ts`, `lib/bills.test.ts`, `test-utils/fakes.ts` (only if needed).
- `BILL_COLUMNS` gains `payer_id`. `BillRecord.payer_id: string` (UUID-validated).
- `PARTICIPANT_COLUMNS` gains `settled_at, settled_cents` and `venmo_username` inside the existing `profiles!bill_participants_user_id_fkey(...)` embed.
- `BillParticipant` gains `venmoUsername: string | null` (null, or it must match `VENMO_USERNAME_PATTERN`) and `mark: { cents: number; at: string } | null`. Both fields set or both null, with cents per C2; anything else is `'network'`.
- New wrappers:
  - `setPayer(billId, payerId, expectedCleared)`;
  - `markPaid(billId, payerId, cents)`, with the local C2 refusal → `'invalid_bill'` and no rpc;
  - `unmarkPaid(billId, userId)`.
- New `BillError` codes `'marks_changed'`, `'payer_changed'`, `'not_complete'`, each with fixed copy in `BILL_ERROR_COPY`.
- `22023` is matched by exact message:
  - `marks_changed` → `marks_changed`;
  - `payer_changed` → `payer_changed`;
  - `not_complete` → `not_complete`;
  - `not_participant`, `is_payer` and `invalid_amount` → `invalid_bill`;
  - any other message → `network`.
- Server text never reaches the screen.

### Task 6: Activity sentences (agent: implementer)
Files: `lib/activityText.ts`, `lib/activityText.test.ts`.
- The C4 sentences. Malformed details (a missing or non-UUID id, non-integer cents, negative `cleared`) return null, which follows the existing pattern.

### Task 7: live reconciliation (agent: implementer, using the `live-db-smoke` skill)
No repo files. Throwaway local users: A (host), B and D (joined), C (outsider). Keys stay in the process environment.
- Runs criteria 51–56 through the real client, `lib/bills.ts` and `lib/settle.ts` against the migrated local DB.

### Task 8: settle view logic (agent: implementer). Amendment A1; UX brief §3–§6, §10, §11
Files: `lib/settle.ts`, `lib/settle.test.ts`, `lib/settleView.ts` (new), `lib/settleView.test.ts` (new). `lib/bills.ts` isn't touched: the existing `BILL_ERROR_COPY` strings are used as written (M3-8).
- `lib/settle.ts`: per marked person, `markDiffers: boolean` and `markDiffCents = current owedCents − mark.cents` (signed integer cents). This is the old Task 11's lib part. `blocked_all_zero` and `SETTLE_ALL_ZERO_COPY` already exist.
- `lib/settleView.ts`: pure functions plus every string in brief §10. Inputs: the `SettlePlan`, `nameOf`, viewer id, host id, the payer's `venmoUsername`, `openedVenmo: { payerId, cents } | null`, and `Platform.OS`. Outputs:
  - a card model: the brief §3 state, label, amount cents, status line, and the buttons with their exact call arguments;
  - row models (brief §4);
  - the picker confirm text and whether to confirm (brief §5 rule);
  - `noticeFor(prev, next, { iChangedPayer, iUndid, openedVenmo })` (brief §6).
- Components do no arithmetic or string-building with money. `settleView` is the only place, and it uses `formatCents`.
- About 250 lines.

### Task 9: Settle screen (agent: product-engineer, loading `ui-ux-designer`; one design pass at the end). Amendment A1
Files: `app/(app)/bills/[id]/settle.tsx` (new, a sibling of `activity.tsx`), `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `components/PayerPicker.tsx` (all new), `__tests__/settle.test.tsx` (new).
- Uses `useBill(id)`: live data, and it shares the bill's channel through `subscribeToBill` (`lib/billLive.ts:14-17`). `settlePlan` and the `settleView` models run inside `useMemo`. No module-level state.
- The Back button uses `router.dismissTo(`/bills/${id}`)`. (`dismissTo` is declared in the installed `node_modules/expo-router/build/global-state/router.d.ts`; checked 2026-11-24.)
- The Pay handler calls `openPaymentLink(url)` first, with no `await` before it, then sets `openedVenmo`.
- No optimistic marks, undos or payer changes: the UI changes after the refetch that includes the write.
- No `AppState` or visibility listening for the return from Venmo.
- Inline confirms only (the `SharePanel` pattern). No `Alert`.
- Larger than one 300-line pass. It may land in two commits (owes/blocked/nothing/negative, then payer/host/picker/notices), with a single design pass after the second.

### Task 10: entry point on the bill screen (agent: implementer). UX brief §7
Files: `app/(app)/bills/[id]/index.tsx` (small edit, about 25 lines: one "Settle up" button in the sticky footer under `SharesSummary`, plus the route push), `__tests__/billScreen.test.tsx`.
- Hidden with 1 participant.
- Secondary, with "N items left to claim", while the bill is incomplete.
- Primary when complete.

### Task 11: removed (Amendment A1). Merged into Tasks 8 and 9.

### Task 12: docs (agent: docs-writer; after Tasks 1–11 land)
Files: a new ADR "Settling: one payer per bill, self-reported marks" (**number from the main session**), `docs/learning/decisions/0007-payment-deep-links.md` (a dated note: the docs page is gone, which format the device check confirmed, and the https-not-scheme choice), `docs/learning/concepts/money-and-rounding.md` (who owes the payer; the negative-share case), `docs/learning/concepts/database-functions.md` (the expected-state parameters `p_expected_cleared` / `p_payer_id`), `docs/learning/concepts/realtime.md` (the new update broadcast), `docs/before-production.md` (items below). Re-read each file before editing it.

## Acceptance criteria
Run the DB checks with `npm run db:test`, Jest with `npm test -- --maxWorkers=4` or `npx jest <file>`, and the type-check with `npm run typecheck`.

### Database: Task 1 (`settle_payer.test.sql`)
1. `bills.payer_id` is `uuid not null`. `bill_participants` has `settled_at timestamptz null` and `settled_cents integer null`. Writing `settled_at` without `settled_cents` (as superuser) fails with `23514`. So do `settled_cents = 0` and `settled_cents = 100000000`.
2. A bill made through `create_bill` has `payer_id = host_id`. On the user's existing local data, after `npx supabase migration up`, `select count(*) from bills where payer_id is distinct from host_id` is 0 (QA runs this by hand; pgTAP starts from an empty DB).
3. Invariant P: as superuser, setting `payer_id` to a user who isn't a participant fails at or before commit. The test names the error the chosen mechanism raises.
4. Account deletion: with B as payer and B and D marked, deleting B's `auth.users` row succeeds. The bill still exists, `payer_id = host_id`, every mark on it is null, and exactly one new `payer_changed` event exists with `actor_id` null and `cleared` = the number of marks that were removed. (B's own participant row is gone by cascade.)
5. Grants: `table_privs_are('public','bills','authenticated', ['SELECT'])` and the same for `bill_participants`. Both are empty for `anon`. As B (participant): `update bills set payer_id = B` fails with `42501`, and `update bill_participants set settled_at = now(), settled_cents = 1 where user_id = B` fails with `42501`. (Under Q5 B this criterion is rewritten.)
6. As A (host), with B a participant and no marks: `set_payer(bill, B, 0)` makes `payer_id = B` and writes exactly one event `payer_changed {before: A, after: B, cleared: 0}`, actor A.
7. `set_payer` raises `42501` when called as B (non-host participant), as C (outsider), as anon, and as A with an unknown bill id. Nothing changes and no event is written.
8. `set_payer(bill, C, 0)` (C not a participant) and `set_payer(bill, null, 0)` raise `22023` with message `not_participant`.
9. `set_payer(bill, <current payer>, 5)` is a no-op even though 5 is wrong: no error, no event, marks unchanged.
10. With B and D marked (2 marks) and payer A: `set_payer(bill, D, 1)` and `set_payer(bill, D, null)` raise `22023 marks_changed`, and the payer and marks are unchanged. `set_payer(bill, D, 2)` sets payer D, clears both marks, and logs `cleared: 2`.
11. One `bill_participants` update statement that touches N rows of one bill sends exactly one broadcast on `bill:<id>` (same method as the existing broadcast tests in `bill_edit_realtime.test.sql`).
12. The kind constraint accepts the three new kinds and every existing kind, and rejects `'paid'`.
13. `set_payer` is `security definer` with `proconfig = {search_path=""}`. Execute is granted to `authenticated` only (not `anon`, not `public`).

### Database: Task 2 (`settle_marks.test.sql`)
14. `private.bill_is_complete` returns the "Complete?" column for K1–K5, each set up through the real `create_bill`, `join_bill`, `set_claim` and `update_bill`. Clients can't execute it: as `authenticated`, calling it fails with `42501`.
15. Complete bill, payer A, as B: `mark_paid(bill, A, 1510)` stores `settled_cents = 1510` and a non-null `settled_at` on B's row only, and writes one `marked_paid {payer_id: A, cents: 1510}` event, actor B (event per Q9).
16. Calling it again as B with `1600` is a no-op: still 1510, the same `settled_at`, no second event.
17. K2, K3 and K5 states: `mark_paid` raises `22023 not_complete` and writes nothing.
18. As A (the payer): `22023 is_payer`. As B with `p_payer_id = D` while the payer is A: `22023 payer_changed`.
19. C2: A1, A4, A5 and A6 raise `22023 invalid_amount`. A2 (`1`) and A3 (`99999999`) are stored exactly.
20. As C (outsider), as anon, and with an unknown bill: `42501`.
21. `unmark_paid`, with B marked:
    - called by each allowed caller per Q4 (recommended: A as host, B as self, the payer), it clears B's mark and logs one `unmarked_paid {user_id: B, cents: 1510}` with that caller as actor;
    - D (a non-host, non-payer participant) on B raises `42501`, and the mark is kept;
    - on an unmarked or non-participant target: no-op, no event.
22. The error checks run in the C3 order: as C2-invalid *and* the payer, the error is `invalid_amount`. (One test pins the order so the app's mapping is deterministic.)
23. Both functions are `security definer` with an empty search path, executable by `authenticated` only.
24. Every pgTAP file passes, old and new (`npm run db:test`).

### `lib/paylinks.ts` (Task 3)
25. With the V1 format, `venmoPayUrl({ username: 'Jane-Doe_99', cents: 1510 })` returns exactly `https://venmo.com/?txn=pay&recipients=Jane-Doe_99&amount=15.10&note=SplitIt`. With `VENMO_LINK_FORMAT = 'v2'`, it returns `https://venmo.com/Jane-Doe_99?txn=pay&amount=15.10&note=SplitIt`. Both formats are tested. (If Q7 changes the note, only the encoded note in these strings changes.)
26. Amount text: `1` → `0.01`, `5` → `0.05`, `100` → `1.00`, `123450` → `1234.50` (no comma), `99999999` → `999999.99`.
27. It returns `null` for cents `0`, `-1`, `12.5`, `NaN` and `100000000`, and for usernames `null`, `''`, `'abcd'`, `'@abcde'`, `'abc de'` and `'josé1'`.
28. The note is passed through `encodeURIComponent`. A test sets a temporary note of `Dinner & drinks #1` through the module's test seam (or a pure helper) and gets `Dinner%20%26%20drinks%20%231`. `venmoPayUrl` has no note parameter.
29. Venmo URLs are built in one place: `grep -rn "venmo\.com" app components lib` matches only `lib/paylinks.ts` and `lib/paylinks.test.ts`. (Run 2026-11-24: no matches today.)
30. `openPaymentLink(url)` calls `Linking.openURL` exactly once with `url`, under `Platform.OS = 'ios'`, `'android'` and `'web'` (one test per branch, lessons log). If it rejects, the result is `{ ok: false }`, and it never throws.

### `lib/settle.ts` (Task 4)
31. K1–K5 as `SplitInput`s give: K1 and K4 not blocked; K2, K3 and K5 `{ status: 'blocked', unclaimedRows: 1 }`. That agrees with `sharesComplete` on each.
32. D3 worked example, proportional: payer A → B `owes` 1510. Payer B → A `owes` 2090. Even: payer A → B `owes` 1550. The payer's own entry is role `'payer'` with no amount.
33. Property test, seeded, 500 random complete bills in both modes, with a random payer: `Σ owedCents (non-payers) + payer's computeShares total === totalCents`, all integers, and for every non-payer `owedCents === computeShares(...).people[i].totalCents`.
34. Roles: owed > 0 → `owes`; 0 (a participant with no claims, or only $0.00 rows in proportional mode) → `nothing`; < 0 (even mode, items 1000/0, total 800) → `payer_owes_them` with cents `-100`.
35. Marks: `paidCount`, `owingCount`, `collectCents` and `allPaid` are correct with 0, some and all marked. A mark on someone whose role is `nothing` doesn't count toward `paidCount`.
36. Bad payer id → `blocked_bad_payer`. The function never throws on valid `SplitInput`.

### Data layer (Task 5)
37. `fetchBill` reads `payer_id` and, per participant, `settled_at`, `settled_cents` and `venmo_username`. Malformed values give `'network'`: a non-UUID payer, one of the mark fields null without the other, cents outside C2, a non-string `settled_at`, or a handle that fails `VENMO_USERNAME_PATTERN`.
38. `setPayer('<bill>', '<user>', 2)` calls `rpc('set_payer', { p_bill_id, p_payer_id, p_expected_cleared: 2 })`. `markPaid` calls `rpc('mark_paid', { p_bill_id, p_payer_id, p_cents })`. `unmarkPaid` calls `rpc('unmark_paid', { p_bill_id, p_user_id })`.
39. `markPaid` with A1, A4, A5 and A7 makes no rpc call and returns `invalid_bill`. A2 and A3 are sent.
40. Error mapping per Task 5, one test each: `42501` gives `not_allowed`; each `22023` message gives its code; an unknown `22023` message gives `network`. No server text is ever returned.

### Activity (Task 6)
41. Each C4 kind gives its sentence with names from `nameOf`. `payer_changed` with `cleared` 0 has no "cleared" clause; with 1 it reads "1 'I paid' mark"; with 2, "2 'I paid' marks". `actor_id` null reads "Someone…". Malformed details return null, and the screen skips them.

### Settle view logic (Task 8, `lib/settleView.test.ts` and `lib/settle.test.ts`). Amendment A1
41a. `markDiffCents` is `owedCents − mark.cents`, exactly, for marked people (1620 vs 1510 → 110; 1400 → −110; 0 → −1510; −100 → −1610), and `markDiffers` is `markDiffCents !== 0`. Unmarked people have neither field set.
41b. `settleView` returns the brief §10 strings exactly for: the worked example (owes 1510 to Hana, handle `hana-1`) in states 3.1, 3.2, 3.3 and 3.5; the four share-changed rows of brief §3.4; nothing; negative (−100); payer with 0, some and all marked; blocked K2; all-zero as host and as guest; bad payer. Plurals: "1 person owes you" / "2 people owe you"; "1 item left" / "3 items left"; `1 "I paid" mark` / `2 "I paid" marks`.
41c. Picker confirm rule (brief §5):
- marks 2 → the clear text with both names;
- marks 0 and complete → "Switch to Sam? People may already be paying Hana.";
- marks 0 and incomplete → no confirm.
41d. `noticeFor`:
- payer A → D, not changed by me → "Dee is now collecting for this bill."; with my mark cleared, or `openedVenmo.payerId = A`, it adds " If you already paid Hana, sort it out with them.";
- payer changed by me → no notice;
- my mark gone, payer the same, `iUndid` false → the undone notice;
- `iUndid` true → none.
41e. Components get money only as cents and strings from `settleView`: `grep -rnE "markDiffCents|owedCents|collectCents" components "app/(app)/bills/[id]/settle.tsx"` prints nothing. (Not run: the screen and components don't exist yet; the implementer runs it first.)

### Settle screen (Task 9, router tests in `__tests__/settle.test.tsx`). Amendment A1; copy per the UX brief §10
42. Signed out, `/bills/<id>/settle` redirects to `/sign-in`. A non-participant gets the existing not-found state. "‹ Bill" calls `router.dismissTo('/bills/<id>')`.
43. Blocked (K2):
- it shows "You can settle up once every item is claimed (1 item left)." and "Back to the bill";
- no money amount is rendered (`queryByText(/\$[\d,]+\.\d\d/)` is null);
- there's no Pay button, no "I already paid" and no "I paid", and no Everyone list.
- If the viewer is marked, it shows "Your "I paid" is saved." (with no amount).
43a. All-zero (Q10): the host sees `SETTLE_ALL_ZERO_COPY` and "Edit items"; a guest sees "Every item is $0. Ask Hana to fix the prices." There's no amount matching `/\$[\d,]+\.\d\d/`.
43b. Bad payer: it shows "Something went wrong loading this bill." and "Try again". `fetchBill` isn't called again until "Try again" is pressed.
44. As Sam (B), payer Hana (A) with handle `hana-1`, worked example:
- it shows "You owe Hana", "$15.10", the button "Pay Hana $15.10 on Venmo", "@hana-1 · $15.10" and "I already paid".
- Pressing Pay calls `openPaymentLink` once, with exactly `venmoPayUrl({ username: 'hana-1', cents: 1510 })`, synchronously: the mock has been called when `fireEvent.press` returns, before any awaited tick.
- It makes **no** `mark_paid` call.
- The card then shows "Did you pay Hana?", the button "I paid", "Open Venmo again" and still "@hana-1 · $15.10".
44a. Under `Platform.OS = 'web'`, states 3.1 and 3.2 also show "On a computer? Send it from the Venmo app on your phone." Under `'ios'` that line isn't shown.
45. Marking:
- "I already paid" (3.1) and "I paid" (3.2) each call `markPaid(bill, A, 1510)`.
- While the call is in flight the button is disabled, and "Marked paid" isn't shown (nothing is optimistic).
- After the refetch that contains the mark, it shows "You paid Hana", "$15.10" and "Marked paid".
- Each error code shows its brief §3.12 copy and re-enables the button. `payer_changed`, `not_complete` and `invalid_bill` also refetch.
- `openPaymentLink` → `{ ok: false }` shows "Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app." and still switches to 3.2.
45a. After Pay, a refetch with payer D:
- shows the notice "Dee is now collecting for this bill. If you already paid Hana, sort it out with them.";
- the card shows D's default state;
- no button anywhere calls `markPaid` with payer A.
46. The payer has no handle:
- Sam sees "Hana hasn't added Venmo yet. Ask them, or pay another way." and no Pay button. "I paid" calls `markPaid`.
- Hana (the payer) sees "Add your Venmo so people can pay you" with "Add Venmo", which opens `/profile`. Returning to the screen refetches (`useFocusEffect`).
47. A participant with no claims sees "You're all set" and "You don't owe anything on this bill.", with no buttons. With −100 (even mode, items 1000/0, total 800), the viewer sees "Hana owes you", "$1.00" and "Settle that outside the app.", with no buttons.
48. As the payer (A), with B marked and D not: "2 people owe you", the `collectCents` amount, "1 of 2 paid", B "Paid" and D "Not yet". The payer has no row. Once all are marked: "Everyone's paid". Each test feeds known cents and asserts exact strings.
49. Payer change as host:
- "Change" appears only for the host, and only with ≥ 2 participants.
- Picking D with 2 marks: it refetches first; it shows a confirm containing `2 "I paid" marks` and both names; confirming calls `setPayer(bill, D, 2)`.
- 0 marks and the bill complete: it shows the confirm "People may already be paying Hana.", then calls with `expectedCleared` 0.
- 0 marks and the bill incomplete: no confirm.
- On `marks_changed`: it refetches and the confirm shows the new count.
- Cancel makes no call.
- Tapping the current payer makes no call.
50. Undo:
- B's own Undo calls `unmarkPaid(bill, B)` at once.
- The host's or the payer's Undo on B's row shows "Undo Sam's "I paid"?". Only confirming calls `unmarkPaid(bill, B)`; Cancel makes no call.
- D sees no Undo on B's row.
- When B's mark disappears in a refetch that B didn't cause, B sees "Your "I paid" was undone. Check Activity to see who." as an alert banner.
50a. Share changed (Q3 A): B marked 1510, and the share is now 1620. B sees "You paid Hana", "$15.10" and "⚠ Your share is now $16.20. Sort out the $1.10 with Hana." The payer's and host's rows show "Marked $15.10 · share now $16.20". The other three §3.4 cases render their copy (one test each).
51. Live: a fake broadcast after B's mark lands in the data makes A's screen show B "Paid" without a manual refresh. A payer change by the host updates B's screen to the new name and amount and shows the §6 notice.
52. Accessibility:
- Each button has an `accessibilityLabel`. Pay's label is "Pay Hana $15.10 on Venmo, to @hana-1", with the hint "Opens Venmo".
- Each person row's single label includes the name, amount and status (and both amounts when the share changed).
- Picker rows have `accessibilityRole="radio"` and `checked` state.
- Errors and notices are `Banner alert`. "Marked paid" is announced: `announceForAccessibility` on iOS and a live region elsewhere.
- No status is shown by colour alone: "Paid", "Not yet" and the ⚠ lines are text.
- The design pass is recorded in the implementer's report.
53. No mark or money field is read straight in screens: `grep -rnE "settled_(at|cents)|payer_id" app components` prints nothing. (Run 2026-11-24 with the Grep tool on `app/` and `components/`: no matches today.)
53a. No return detection and no native dialogs: `grep -rnE "AppState|Alert\.alert\(" app components` prints nothing. (Run 2026-11-24 on `app/` and `components/`: no matches today. `AppState` is used in `lib/useBill.ts`, `lib/useActivity.ts` and `lib/supabase.ts`, which this grep doesn't cover and which are allowed.)

### Entry point (Task 10). Amendment A1; UX brief §7
54. The bill screen's footer:
- With 1 participant there is no "Settle up".
- With ≥ 2 participants and the bill incomplete: "Settle up" (secondary) and "N items left to claim" (exact plural).
- With ≥ 2 participants and the bill complete: "Settle up" (primary).
- `accessibilityLabel` is "Settle up". It opens `/bills/<id>/settle` for host and guest alike.
- Every existing `__tests__/billScreen.test.tsx` test still passes.

### Live reconciliation (Task 7, live local DB, throwaway users)
55. The same bill state checked on both sides: for K2 and K1, `settlePlan` says blocked / not blocked, and `markPaid` through `lib/bills.ts` gets `not_complete` / ok to match.
56. C2 on both sides: `markPaid(…, 0)` is refused locally, and the raw `rpc('mark_paid', { … p_cents: 0 })` returns `22023`. `99999999` is accepted through `lib` and is read back exactly by `fetchBill`.
57. As B, `fetchBill` returns A's `venmoUsername` and everyone's marks. As C, `fetchBill` is `not_found`, and a raw `from('bill_participants').select('settled_cents').eq('bill_id', …)` returns 0 rows.
58. Race: B loads payer A, the host switches to D, and then B's `markPaid(bill, A, …)` returns `payer_changed`. The host loads 1 mark, B marks too (2), and then `setPayer(bill, X, 1)` returns `marks_changed`.
59. The worked example built live: B's `owedCents` from `settlePlan` over `fetchBill` data is 1510 (proportional), and `mark_paid` stores it exactly.
60. As B, a raw `from('bills').update({ payer_id: B })` and a raw `from('bill_participants').update({ settled_cents: 1 })` both return error `42501`.

### Whole-slice gates
61. `npm run typecheck`, `npm test -- --maxWorkers=4` and `npm run db:test` all pass.
62. Web, two accounts (one normal window and one private window, both Google test users), `npm run web`:
    - A creates the D3 bill, B joins, they claim per the example, and B opens Settle up.
    - The Venmo button opens a new tab whose address is exactly the C5 URL.
    - "I paid" makes A's screen show B "Paid" within a few seconds.
    - A undoes the mark (after the inline confirm), then changes the payer to B. On this complete bill, a confirm appears either way: with the mark count while a mark exists, otherwise "People may already be paying…" (Amendment A1, M3-UX-4).
    - Activity shows each change.
63. iOS simulator (it reaches the Mac's `127.0.0.1:54321`): the same flow as B. Tapping the Venmo button opens Safari (the simulator has no Venmo app) at the C5 URL, and returning to the app leaves nothing marked.
64. **Venmo link check on a real phone (no backend needed; verify, and reword C5 if Venmo differs):**
    - QA prints `venmoPayUrl({ username: <the user's own Venmo username, given by the user>, cents: 1 })` with `npx jest` or a scratchpad script.
    - The user opens that link on their iPhone (from Notes or Messages) with Venmo installed: Venmo's Pay screen should open with the recipient, `$0.01` and the note filled in. **Don't press Pay.** Record what the screen shows.
    - Do the same with the V2 form. Whichever fills every field becomes `VENMO_LINK_FORMAT`. If neither does, stop and ask the user (criteria-change rule).
    - Repeat on Android if a device is available; otherwise mark it not run.
    - Also open the link in a desktop browser and record what venmo.com does (input to Q8).
    - **Result (2026-11-25, user):** V1 works on iPhone. `VENMO_LINK_FORMAT` stays `'v1'`. Android and desktop not run yet.
65. The leak check: after `npm run export:web`, `grep -rE "service_role|sb_secret_" dist/` prints nothing.
66. **Physical-phone in-app check is blocked.** On the phone, `127.0.0.1` is the phone itself. It waits for the friend-test deploy (hosted Supabase) or for the Mac's LAN IP plus matching Supabase/Google redirect URLs. Criterion 64 covers the Venmo side without the backend.

## Before-production items (Task 12 adds them to `docs/before-production.md`)
- **§5/§6 Venmo link format is undocumented.** Venmo's own page no longer describes the link parameters (checked 2026-11-24). Re-run criterion 64 before launch and after any Venmo app update that breaks it. Consider a periodic manual check.
- **§6 Privacy: Venmo notes can be public.** Our note is a fixed string without names or items (C5). Re-check if the note copy changes. List "payment username shared with bill participants" (already planned in the profile spec).
- **§6 Honor system.** "I paid" is self-reported and `settled_cents` comes from the client (the DB checks only C2). Say so in the app's help or FAQ if friends rely on it.
- **§6 Account deletion.** A deleted payer hands collection back to the host and clears marks (D1). Decide whether that's right once account deletion is built.
- **§4 Rate limits.** `mark_paid`/`unmark_paid` loops can flood Activity and Realtime. Add them to the existing rate-limit item.
- **§6 App Review.** The existing payment-deep-links item now applies.

## Risks
- **The link format can break without notice** (C5). Mitigation: one builder, a format switch, and the device check.
- **Wrong handle, wrong person paid.** The handle is shown under the button (D4) before Venmo opens. We still can't check that it exists.
- **Amounts can change after a mark** (a host edit, someone unclaiming). Q3 decides what the app does. Until Task 11 lands, a mark keeps its original `settled_cents` and the screen shows the current share.
- **Settling can become blocked again after it started:** an unclaim or a host-added row makes the bill incomplete. Existing marks stay, and the Pay buttons hide until it's complete again. That's intended, but it may surprise people.
- **Negative shares** only happen in even mode with large bill-level discounts (Q6).
- **The invariant P mechanism** interacts with account-deletion cascades (criterion 4). If the deferred FK and the cascade order don't work together, the supabase-engineer reports back rather than weakening the rule.

## User answers (2026-11-24)
The user accepted every recommended option:
- **Q1:** no new tool. Settling stays blocked until someone claims every item.
- **Q2:** a separate "Settle up" screen, opened from a button on the bill screen.
- **Q3:** option A. Keep the mark and show "Marked paid $X · share is now $Y".
- **Q4:** the host, the person themself and the payer can each undo a mark.
- **Q5:** everyone on the bill sees who has paid.
- **Q6:** a negative share shows as "<name> owes you $X, settle that outside the app".
- **Q7:** the Venmo note is the fixed text "SplitIt".
  - Superseded 2026-11-25 by docs/specs/2026-11-25-venmo-note-item-names.md
- **Q8:** on desktop web, the same button plus "@handle · $X".
- **Q9:** "I paid" and undo are also logged in Activity.
- **Q10** (added from the Task 4 property test): a proportional bill whose rows are all $0.00 but whose total is above zero has `unassignedCents > 0`. Settling is blocked with "Every item is $0. Fix the prices, or switch to Split evenly."

The three defaults to confirm stand as written.

## Open questions (the user decides)

**Q1. Unclaimed items (M2 A1.5, still open).** Settling is blocked until every item is claimed (A2.2a). Nothing yet decides what happens when nobody claims something, such as a dish nobody will own up to, or a shared appetizer people forget.
- A. **No new tool (recommended).** Anyone, usually the host or payer, claims the leftover; "Split differently" can then share it. The blocked state says how many items are left. It costs nothing. The fuller options would save a few taps at the table.
- B. The host gets "Split the rest among everyone": it adds a claim for every participant on each unclaimed row. That means the database writes claims **for other people**, which goes against the CLAUDE.md rule "users write only their own claims". You'd have to approve that exception.
- C. The host assigns a leftover row to one person. Same exception as B.

**Q2. Where settling lives.**
- A. **A separate "Settle up" screen from a button in the bill screen's footer (recommended).** The bill screen stays as it is, and settling gets a calm screen of its own. It costs one tap.
- B. A section at the bottom of the bill screen. No extra tap, but it adds to the busiest screen.

**Q3. Amounts change after someone marked "I paid"** (the host edits, or someone claims or unclaims).
- A. **Keep the mark, and show "Marked paid $15.10 · share is now $16.20" to that person, the payer and the host (recommended).** It catches every cause, and nobody loses a record. Task 11.
- B. The host's edit clears all marks (with a confirm). It misses claim changes, and `update_bill` grows again.
- C. Lock claiming and editing once anyone has marked paid, with a host "reopen". The strictest option, and the most UI.

**Q4. Who can undo a mark?** You decided the host can. Should **the person themself** (a mis-tap) and **the payer** (when the payer isn't the host, they're the one who knows whether the money arrived) also be able to? **Recommended: yes to both.**

**Q5. Who sees who has paid?**
- A. **Everyone on the bill (recommended).** It's the same as claims, which everyone sees, and it needs no grant changes.
- B. Only the payer, the host and the person. More private, but it needs column grants and a reader function.

**Q6. A negative share** (even mode with a big bill-level discount: someone ordered only a $0 item and the discount pushes their share below zero).
- A. **Show "Sam owes you $1.00. Settle that outside the app." with no link (recommended).**
- B. Show them as owing nothing. Simpler, but the payer is quietly $1.00 ahead.

**Q7. The Venmo note.** Venmo payments and their notes can show on a public feed.
- **Recommended: a fixed "SplitIt"**, with no names, items or restaurant.
- Alternatives: add the date ("SplitIt Nov 24"), or let the host type a title (a new field).

**Q8. Desktop web.** Third-party reports (unverified, criterion 64 checks) say venmo.com can't start a payment in a desktop browser.
- A. **The same button, plus the line "@hana-1 · $15.10" so they can pay from their phone (recommended).** No new package.
- B. On desktop, show a QR code of the link to scan with the phone. Nicer, but it needs a QR package.

**Q9. Activity for "I paid" and undo.** You asked for payer changes in Activity. Should marking paid and undoing also be logged? **Recommended: yes.** It's cheap, and it answers "who said they paid, and who undid it".

### Defaults to confirm (the spec proceeds with these unless you object)
- "I paid" stays available when the payer has no Venmo username (they may pay by cash or another app).
- Changing the payer when no marks exist skips the confirm, since nothing is lost.
- The payer picker shows only once the bill has 2 or more participants, and it can be used before everything is claimed.

## Later (not this slice)
- PayPal and Cash App (the same `lib/paylinks.ts`, one column each on `profiles`).
- The payer or host marking someone else as paid.
- Venmo "request" links from the payer.
- Reminders to people who haven't paid, and a settled state in "Your bills".
- "People you've split with" (nothing here depends on how people joined a bill).
