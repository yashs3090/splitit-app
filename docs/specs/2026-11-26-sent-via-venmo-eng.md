# Engineering design review: Sent via Venmo and payment methods

Date: 2026-11-26. Staff-engineer review (read-only) of `2026-11-26-sent-via-venmo.md` (spec), `-ux.md` (brief), `-notifications-check.md`, checked against the code on branch `feat/qr-invite-settle-visual-pass`. Saved by the main session from the reviewer's report; condensed where it only restated the spec.

## 0. Findings that change the plan

| # | Finding | Where | Change |
|---|---|---|---|
| F1 | Storage keys with `:` throw on iOS/Android: `lib/storage.native.ts` is SecureStore, keys must match `^[\w.-]+$`, and it can't list keys | `expo-secure-store/build/SecureStore.js:146-151` | One JSON blob per user: `splitit.sentcheck.v1.<userId>` = `{ "<billId>.<markAtMs>": { a: 'yes'\|'undo'\|'shown', t: ms } }`, pruned inside the blob. Method: `splitit.payMethod.v1.<userId>`. Test every key builder against `/^[\w.-]+$/` |
| F2 | Schedule before `openURL` (JS may be suspended once Venmo is in front) | spec D2 | Native order: **record → schedule → open** |
| F3 | A stale-screen Pay can open Venmo twice: `mark_paid` returns ok when already marked | `20261125090050_settle_early.sql:200-210` | `mark_paid` returns `table (settled_at timestamptz, created boolean)`; open Venmo only when `created` |
| F4 | The undo rule never matches for "more" sends (`settle_difference` keeps the first `settled_at`) | spec D3 | **No check-in for "more" sends** |
| F5 | "Not received" can clear a newer re-send of the same amount (ABA) | spec D4 | `mark_not_received` also takes `p_expected_at` (the mark's `settled_at`) |
| F6 | A second "No, undo" shows a false "changed" | spec D3 | Order: stored `'undo'` → noop; fresh mark null → store `'undo'`, silent; mark matches → unmark; else → changed |
| F7 | Marking seen on blur races Home's focus refresh | `app/(app)/index.tsx:162` | `markBillSeen` on each new data version while focused (debounced ~2 s) plus once on blur, on the bill and Settle screens |
| F8 | SV-UX-15 needs no `my_bills` change: the viewer's own `not_received_*` comes through `fetchSettleData` | `lib/bills.ts:142` | `my_bills()` gains `seen_at` only; derive `not_received` from the plan entry |
| F9 | A required `seenAt` breaks splitit-app-96's test builder, and a clock-based `sent` makes their fixtures flaky | `lib/homeSections.test.ts:36` | Drop the 72 h age-off; ask them to add `seenAt: null` to their `summary()` builder; unseen = `seenAt` null **and** `seen` false, or mark newer than `seenAt` |
| F10 | The notification handler must not navigate before the sign-in resume effect finishes | `app/_layout.tsx:29-50` | New `lib/resumeGate.ts`; `ResumeAfterSignIn` calls `settleResume(kind)` (3-line edit in another session's file); the responder awaits it and drops cold-start responses when kind is `'signed_in'`. Fallback if declined: handle only live listener responses |
| F11 | "Plan payer is mark's payer" is empty (marks store no payer; `set_payer` clears marks) | spec D3 | Drop it; guard with notification `data.payerId` vs the current plan |
| F12 | Pay logic is duplicated in `settle.tsx:210-231` and `bills/[id]/index.tsx:210-243` | both screens | One hook, `lib/useVenmoSend.ts`, used by both |

## 1. Send order

**Native (`lib/useVenmoSend.ts`), per tap:**
0. Repeat-tap guard (`writing` ref + `PAY_REPEAT_MS`).
1. Permission only if undetermined and the device flag `splitit.notifAsked.v1` is unset (Android: create the channel first). Never blocks.
2. `markPaid(bill, payer, cents, 'venmo')` → `{ markAt, created }`, raced against `MARK_BEFORE_OPEN_TIMEOUT_MS = 4000` (don't abort).
3. If permission granted: `scheduleSentCheck` (category registered first, memoized), `SCHEDULE_TIMEOUT_MS = 1000`; failure → no notification, inline check covers it.
4. `openPaymentLink(url)`; if it fails → `unmarkPaid(me)` + cancel + open-failed line.
5. Refetch (existing `clearAt` / `finished`).

| Step 2 outcome | Venmo | Screen |
|---|---|---|
| ok, `created` | open | sent card ready behind Venmo |
| ok, `created = false` | **don't open** | refetch + Banner `You've already marked this. Check below.` |
| `payer_changed` / `not_complete` / `invalid_bill` / `not_allowed` | don't open | `actionError` + refetch |
| `network` or timeout | open anyway | contract O; no schedule; a late result only refetches |

On return, the `AppState 'active'` refetch decides: mark present → "Sent via Venmo" + inline check (key from the fetched `mark.at`); mark absent + `openedVenmo` → contract O; never render from data older than that refetch.

**"More" sends:** keep open-first (SV-8); no check-in (F4).

**Web:** `openPaymentLinkWeb(url)` synchronously first, via `window.open(url, '_blank')` (not RN Linking, which passes `noopener`), then `w.opener = null`. Mobile web: wait ~300 ms, auto-mark only if `!w.closed`. **Desktop web: always ask on return** (contract O), since a venmo.com tab may not be able to pay. Blocked (`null`) → no write, open-failed line. Verify per browser (U3). This changes SV-9.

## 2. "Once per send"

Key `<billId>.<markAtMs>` (`Date.parse(settled_at)`, compared as numbers). Notification id `sentcheck.<userId>.<billId>.<markAtMs>`. Two devices: each asks once (harmless). Undo then resend: new key, asks again. Payer change: mark cleared, no inline check. Sign-out cancels all check-ins and keeps the blob (keyed by user). "Shown" is stored on navigation blur, not app background.

## 3. Database (one migration)

**Columns:** `settled_method text`, `not_received_cents integer`, `not_received_method text`, `not_received_by uuid` (no FK, on purpose: no profiles lock, no cascade; say so in the column comment). Backfill `settled_method = 'other'` where marked. Checks: method known (via `private.is_payment_method(text)`, `language sql immutable`, the one list), `(settled_at is null) = (settled_method is null)`, not-received all-or-none, cents 1..99,999,999.

**Every statement that clears a mark must null `settled_method` in the same UPDATE:** `private.bill_participants_reset_payer` (`20261124081411_settle_payer.sql:114-118`), `set_payer` (`:229-233`), `unmark_paid` (`20261124081412_settle_marks.sql:155-157`), `settle_difference` to 0. **`set_payer` and the reset trigger also clear `not_received_*`** (reverses SV-25, avoids a stale warning after A → B → A).

**`mark_paid(p_bill_id, p_payer_id, p_cents, p_method) returns table (settled_at, created)`:** 0021 D3 order plus `22023 invalid_method` after `invalid_amount`; sets the method and nulls `not_received_*`; event details gain `method`; on no-op return `(settled_at, false)` (null if a racing unmark won).

**`settle_difference(…, p_method)`:** "more" keeps the method if equal, else `'other'`; "back" ignores the method (test it); to 0 nulls it.

**`mark_not_received(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at) returns void`** (signature per §11), definer, `search_path = ''`:
0 signed out → 42501; 1 not a participant (no lock) → 42501; 2 `bills` FOR SHARE + re-check → 42501; 3 caller not the current payer, or target null/payer → 42501; 4 bad cents or null at → 22023 invalid_amount; 5 target FOR NO KEY UPDATE, no row → 22023 mark_changed; 6 idempotent retry (unmarked, flag by caller with same cents) → return, no write/event/broadcast; 7 unmarked or cents/at differ → 22023 mark_changed; 8 clear the mark, set the flag from the old values, log `not_received {user_id, cents, method}`.

**`my_bills()`:** drop/create appending `seen_at` (old web build still parses: `parseSummary` ignores unknown fields). `bill_events_kind_known` gains `not_received` (re-check for newer definitions at build time).

**Old signatures:** drop `mark_paid(uuid,uuid,integer)` and `settle_difference(uuid,uuid,uuid,integer,integer)`, recreate, restate revoke/grant; `notify pgrst, 'reload schema';`. **Deploy: DB push, then web deploy, in the same sitting.**

**Lock order:** unchanged shape (participation read, `bills` FOR SHARE, row lock, event FK locks incl. the caller's/payer's `profiles` row). No new cycle.

**Direct callers:** may set any method on their own mark (honor system); the payer may mark anyone's current mark not received (no stronger than `unmark_paid`, logged); old `mark_not_received` replays closed by `p_expected_at`; R8 stays open for `settle_difference`.

**Parity:** `lib/paymentMethods.ts` `PAYMENT_METHODS`, with a drift test reading `private.is_payment_method`'s list from the newest migration.

## 4. Notifications

- `lib/checkInNotifications.native.ts` (imports expo-notifications), `lib/checkInNotifications.ts` (web no-op), shared type in `.types.ts` with `satisfies`. Rejecting mock in `test-utils/jestSetup.ts`.
- `plugins/withoutPushEntitlement.js` listed **before** `expo-notifications` in `app.json`; `__tests__/appConfig.test.ts` checks no `aps-environment` on both the plain and `withAppLinks` paths.
- `components/SentCheckResponder.tsx` in `app/(app)/_layout.tsx`: dedupe by `identifier|action`, `clearLastNotificationResponse()`, allow-list `data` (UUIDs, integer cents, number markAtMs, `userId === session`), route only `/bills/${billId}/settle` via `router.push`, never for "Yes"; awaits the resume gate (F10).
- Permission: read `ios.status` (0 undetermined… 3 provisional); ask once; denied = silence. Cancel-on-return reacts only to background → active.
- "Yes" stores `'yes'` + cancels/dismisses. "No, undo" uses a pure `undoDecision(stored, fresh, data)` (F6). Cancel = `cancelScheduledNotificationAsync` + `dismissNotificationAsync` for presented ones; also on sign-out and in-app undo.
- Content: no sound, `previewPlaceholder: 'Check your SplitIt payment'` (verify option names), no badge, no foreground handler.

## 5. Home

- `sent` from plan entries' `mark.at`/`method` vs `summary.seenAt` (strict `>`), payer only, others' marks only.
- **Drop the 72 h age-off** (keeps `billMarker` pure; see §10).
- `not_received` for the ower when the entry is unmarked and `notReceived.by === plan.payerId`; ranks after new/unclaimed, before owes. `lib/settle.ts` entries gain `notReceived: { cents, method, by } | null`.
- Remove the HM-4 payer-incomplete skip from `settleCandidateIds` (needed so `sent` can show on early bills); update the criterion-63 tests.
- `homeRowView` signature unchanged; splitit-app-96 adds `seenAt: null` to their test builder.

## 6. Races (all handled)

Payer change mid-send (write-first refuses or `set_payer`'s token catches it); Not received vs Sam's undo (serialize on Sam's row); Not received vs same-amount re-send (F5); host edit after send (mark stays, inline check still valid); double tap and two devices (`created = false`, F3); offline (contract O, no notification); notification after undo ("No, undo" silent); notification and inline undo together (F6); late `mark_paid` after timeout (refetch only).

## 7. Tests

pgTAP `sent_via_venmo.test.sql`: M1–M18, N1–N16 (incl. `created`, the `returns table` shape, "back" ignoring method, `set_payer`/trigger clearing the flag, stale `p_expected_at`, retry after the permission check); update old-signature call sites (`settle_marks` 41, `settle_early` 29, `settle_difference` 41, `membership` 1, `claimable_discounts` 1). Jest: method drift test, `[N#]` tags in `settleCaseIds`, key-builder regex. Router tests on web and native for every entry path, including notification warm/cold, another user's response, and the native call order (spy). Live: old 3-arg call → PGRST202, `created` false on a second device, stale `p_expected_at`, flag cleared by `set_payer`, `seen_at` advancing, no `select=*`. Device: U1–U4 as in the spec, plus Android unverified.

## 8. Simpler options taken

`useVenmoSend` hook instead of `payPlan` steps-as-data; no check-in for "more"; no 72 h age-off; seen per version instead of on blur; desktop web always asks; settle data instead of `my_bills` for not-received. Kept: the `created` flag, `p_expected_at`, dropping old signatures.

## 9. Task order

```
T1 native spike (done: GO)  ‖  T2 migration       ‖  T3 lib/bills + paymentMethods + web opener
T4 activityText ‖ T5 sentCheck (keys, undoDecision) ‖ T7 homeMarkers
T10 live reconciliation (after T2, T3)  -> gate for T9
T8 notifications module (after T5) + plugin + appConfig test
T6 settleView (after T3, T5)
T9a useVenmoSend + Settle screen (after T6, T8, T10)
T9b bill footer + responder + seen-per-version (after T9a; needs the resume gate)
T11 docs
```
Coordination: the `app/_layout.tsx` owner for the resume gate; splitit-app-96 for `WAITING_MARKERS`, the group rules and `seenAt: null`; `package.json`/`app.json` for T8; DB push and web deploy together; `lib/bills.ts` has another session's `fetchPeopleCounts`/`isCutOff`.

## 10. Home groups v2

The reviewer recommended that a payer's bill with an unseen `sent` marker sit in **Owed to you** until seen. **The user objected** (2026-11-26: "why would it show for me if I'm not owed?"). The main session proposed instead: the bill sits in **Settled**, but a settled bill with an unseen update is shown above the collapsed list (or the header reads "Settled · 1 update") until seen. Pending the user's answer; the build follows it. Everything else in §10 stands: `not_received` in Waiting on you, `seenAt: null` in splitit-app-96's builder, no payer H-marker before completion, and the 72 h age-off dropped.

## 11. Ready for "Who paid" (multiple payers) without building it

Goal: every mark, flag and key already reads as one transfer from someone to someone, so splitit-app-96's later move to something like `bill_transfers(bill_id, from_user, to_user, cents, method, settled_at, not_received_*)` is a column copy plus argument renames, with no logic change.

- **Columns:** only transfer fields on `bill_participants`: mark `settled_cents`, `settled_at`, `settled_method`; flag `not_received_cents`, `not_received_method`, `not_received_by`. Document `not_received_by` as "the person the money was owed to" (the `to_user`). Each row maps to `bill_transfers(from = user_id, to = bills.payer_id)`. No other per-participant mark state.
- **Functions name both sides:** keep `p_payer_id` on `mark_paid` and `settle_difference`. **`mark_not_received(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at)`**: `p_payer_id` not the current payer → `22023 payer_changed`; caller not `p_payer_id` → `42501 not_allowed`. Event details always carry both sides: add `payer_id` to `not_received` and `paid_back` (next to `user_id`). `unmark_paid` unchanged; before-production note that it will need a `to_user`. Lock order unchanged.
- **lib types:** `SettleMark` gains `toUserId` (from `bills.payer_id` when parsed); `notReceived` = `{ cents, method, toUserId }`. Predicates use transfer fields, not roles: `sentFacts` = marks with `toUserId === viewer`; `not_received` = the viewer's flag with `toUserId === plan.payerId` and no current mark to them; the Not received control shows when `mark.toUserId === viewer`.
- **Keys:** `<billId>.<payerId>.<markAtMs>`; notification id `sentcheck.<userId>.<billId>.<payerId>.<markAtMs>`; the undo rule also checks `mark.toUserId === data.payerId`; remembered method stays per user.
- **Not built now:** a transfers table, per-pair maps, fewest-transfers maths, several Pay buttons, per-pair Home copy.
