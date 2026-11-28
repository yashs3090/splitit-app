# Sent via Venmo, and choosing how you paid

Date: 2026-11-26. Repo: `splitit-app` only (ADR 0011). **Status: approved to build straight through (user, 2026-11-26), as amended by A1 below.** This file is the one source for implementers. The companion docs (`-ux`, `-visual`, `-eng`, `-notifications-check`) explain the reasoning; where they disagree with this file, this file wins.

Builds on ADR 0015 (self-reported marks), ADR 0021 (settle early, differences, contract O), `docs/specs/2026-11-25-settle-early-and-differences*.md`, `docs/specs/2026-11-24-bill-markers-and-notices.md` (`bill_seen`) and splitit-app-96's Home work (`docs/specs/2026-11-26-home-mobile-refresh.md`, then Home groups v2, `lib/homeSections.ts`).

The main session assigns migration timestamps. A new ADR is referred to by title, **"the sent-via-Venmo and payment-methods ADR"**, until the main session reserves a number with a stub in `docs/learning/decisions/` (0022 is Groups; nothing is reserved for this slice yet).

> **Note (2026-11-27, Task 11 docs):** no stub had been reserved for this slice when the docs task ran. 0022 (Groups) and 0023 (several payers) were taken by other specs, so the sent-via-Venmo and payment-methods ADR is **[0024](../learning/decisions/0024-sent-via-venmo-and-payment-methods.md)**, the next free number in the folder and in `decisions/README.md`. The new concept note that Task 11 calls `local-notifications.md` was written under that name.

Decisions are logged as **SV-1 … SV-30** (plan), **SV-UX-1 … 22** (brief), **SV-VIS-1 … 14** (visual) and **SV-ENG-1 … 30** (this amendment), each with a Why column, in `docs/decisions-to-review.md`.

---

## Amendment A1 (2026-11-26): what changed, and where it's edited in place

Inputs: the UX brief (spec-changing items SV-UX-6, 10, 11, 12, 15), the visual design §10, the engineering review (F1–F12, §§1–9, §11), and the user's decisions of 2026-11-26. Every change below is already written into the D sections, tasks and criteria further down; this list is the index.

**User decisions applied (2026-11-26):**
- U-A1.1 No notification for the payer (unchanged).
- U-A1.2 Check-in delay is **1 minute** (`SENT_CHECK_DELAY_SECONDS = 60`, user value, not tunable without asking).
- U-A1.3 **"Recent" is gone.** Home is splitit-app-96's groups v2: **Waiting on you / Owed to you / Settled / Hidden**.
- U-A1.4 `not_received` sits in **Waiting on you**. splitit-app-96 owns `lib/homeSections.ts` (`docs/specs/2026-11-26-home-groups-v2.md`). **Groups come only from the viewer's balance in the settle plan, never from markers.** `WAITING_MARKERS` is replaced by `MARKER_GROUPS: Readonly<Record<HomeMarker, readonly HomeGroup[]>>` (`HomeGroup = 'waiting' | 'owed' | 'settled' | 'hidden'`), a consistency check on which groups each pill may appear in. Their slice already has `sent: ['owed']` and `not_received: ['waiting']` with fixtures. This slice makes **no** `lib/homeSections.ts` edits for `sent` / `not_received` (the old Task 7 fixture exception is withdrawn).
- U-A1.4b **Fully paid bills:** a payer's bill goes straight to **Settled**; a guest who has sent their whole share has the bill **hidden** from Home (groups v2 rule 4). Sam's own `Sent $15.10` pill shows only if his bill comes back for another reason (more due). The UX brief §7.1–7.2 mock-ups with "Recent" are superseded by D7.
- U-A1.4c **New marker this slice builds (groups v2 D-1):** `waiting_on_others`, muted, for a guest who has claimed something while the plan is `blocked` / `blocked_all_zero` (D7). Pre-approved one-line edits in their files: `waiting_on_others: ['waiting']` in `MARKER_GROUPS` (`lib/homeSections.ts`) and one B-state fixture in `GROUP_FIXTURES` (`lib/homeSections.test.ts`).
- U-A1.5 **No 72 h age-off.** `SENT_MARKER_MAX_AGE_HOURS` is removed.
- U-A1.6 **Groups go by what's owed (user, 2026-11-26, replaces the pending "Settled · 1 update" idea and eng §10's "sent keeps the bill in Owed to you").** Once everyone has paid, the payer's bill moves straight to **Settled**, with no pinned row and no header badge, whatever the seen state. The user: "after sam pays it should move out, since she isn't owed for the bill anymore, and it will show up in her activity (sam paid) and in her past completed bills". So the `sent` marker shows **only while someone still owes**; once nobody owes, the row's marker is `settled`. History is in the bill's Activity and the Settled list (SV-ENG-17).
- U-A1.7 The payment method choice: **Venmo / Cash / Paid another way**.
- U-A1.8 Payer finish wording **"Everyone's settled up. Nice."** (SV-UX-14). It departs from the user's example "Everyone's paid. Nice." It's logged for the user under Needs your look.

**Engineering changes (eng review F1–F12, §§1–9, §11):**

| A1 item | Change | Edited in |
|---|---|---|
| F1 | Device storage keys must match `^[\w.-]+$` (SecureStore). One JSON blob per user for check-in answers; method key uses `.` | D3, D5, Task 5, criterion 51 |
| F2 | Native order is **record → schedule → open** | D2, criterion 37 |
| F3 | `mark_paid` returns `table (settled_at, created)`; Venmo opens only when `created` | D2, D8, criteria 1, 7, 37 |
| F4 | **No check-in for "more" sends** (no notification, no inline question) | D2, D3, criterion 25 |
| F5 | `mark_not_received` takes `p_expected_at` (ABA closed) | D4, D8, criterion 10 |
| F6 | `undoDecision` order: stored `'undo'` → noop; fresh mark gone → store `'undo'`, silent; match → unmark; else → changed | D3, criterion 27 |
| F7 | `markBillSeen` on each new data version while focused (debounced, starting value 2 s) plus once on blur, bill and Settle screens | D7, criterion 43 |
| F8 | `my_bills()` gains `seen_at` only; the viewer's own `not_received_*` comes through `fetchSettleData` (SV-UX-15's `my_bills` part is dropped) | D7, D8 |
| F9 | Unseen = (`seenAt` null **and** `seen` false) or mark newer than `seenAt`. `seenAt: null` goes into groups v2's test builders, added by whichever slice lands second | D7, criterion 29 |
| F10 | New `lib/resumeGate.ts`; `ResumeAfterSignIn` in `app/_layout.tsx` calls `settleResume(kind)` (3-line edit in the scan-pipeline session's file, **requested, not assumed**). Fallback if they decline: handle only live listener responses, never the cold-start one | D3, Task 9b, criterion 41 |
| F11 | Drop "the plan's payer is the mark's payer" (marks store no payer; `set_payer` clears marks). Guard with the notification's `data.payerId` vs the current plan | D3, criterion 25 |
| F12 | One hook, `lib/useVenmoSend.ts`, used by both screens (replaces `payPlan` steps-as-data) | D2, Task 9a |
| §1 web | Mobile web: open synchronously, wait ~300 ms (starting value), auto-mark only if `!w.closed`. **Desktop web always asks on return** (contract O). Blocked → no write. Replaces SV-9 | D2, criteria 24, 38 |
| §3 | `private.is_payment_method(text)` is the one DB list. `set_payer` and the payer-reset trigger also clear `not_received_*` (reverses SV-25). `notify pgrst, 'reload schema'` | D1, D4, D8 |
| §4 | Notification: no sound, no badge, iOS hidden-preview placeholder `Check your SplitIt payment` (verify option name), no foreground handler. `plugins/withoutPushEntitlement.js` before `expo-notifications` in `app.json` | D3, Task 8, criteria 26, 53 |
| §11 | Ready for several payers: every mark/flag/key names both sides. `mark_not_received(p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at)`; `payer_id` in `not_received` and `paid_back` details; `SettleMark.toUserId`; `notReceived.toUserId`; keys include `payerId` | D3, D4, D6, D7, D8 |

**UX and visual changes adopted (SV-UX-6, 10, 11, 12, 15; visual §10):**
- SV-UX-6: notification has no sound and a hidden-preview placeholder (D3).
- SV-UX-10: the footer offers the card's primary for every method (cash footer) on ready plans (D5).
- SV-UX-11: after Not received, the footer is primary `Settle up` + warning caption, never the Pay footer (D5).
- SV-UX-12: footer captions by method, early-marked captions, payer-all-settled caption (D5).
- SV-UX-15: Sam's Home pill `Not received · $15.10`, accent, Waiting on you; data from settle data (F8); the group comes from Sam's balance in groups v2 (D7).
- Visual §10: `SegmentedControl` `disabled` + opt-in radio semantics; `Button` flush `'start' | 'end'`; `TextLink` `minWidth`, `disabled`, `loading`; card `chooser` and `check` slots; row `notReceived` separate from `undo`; `wideStatus` for method statuses; footer `cash` / `sent_check` kinds and a `warning` tone; `sent` muted / `not_received` accent (D5, D7, Task 12).
- The chooser **hugs** its labels (SV-VIS-1), replacing the brief's full-width suggestion.
- All other SV-UX copy (brief §12) is the copy reference for Tasks 6, 7 and 9. One exception: the more-send undo confirm (SV-UX-18's `Undo all $16.20? …`) is no longer reachable, because "more" sends have no check-in (F4). `Undo all $X` on difference cards stays.

**Dependencies recorded:**
- **`app/_layout.tsx` resume gate (F10):** a request to the scan-pipeline session. If they decline, Task 9b uses the fallback (live listener responses only; a cold-start tap just opens the app).
- **`package.json` / `app.json`:** edits allowed. **Merge** with the other session's uncommitted `pre*` hooks (`prestart`, `preweb`, `preexport:web` now run `write-well-known.ts`, the Tesseract and OpenCV copies and the CV worker build). Don't overwrite them: `npx expo install expo-notifications` only touches `dependencies`; check the `scripts` block is byte-identical before and after. The plugin goes in **`app.json`**, not `app.config.ts`. `__tests__/appConfig.test.ts` must keep passing (it asserts `config.plugins` equals `appJson.plugins`).
- **`lib/bills.ts`** holds splitit-app-96's uncommitted `fetchPeopleCounts` / `isCutOff`. Leave them alone: Task 3 edits only `PARTICIPANT_COLUMNS`, the participant parser, `markPaid`, `settleDifference`, the new `markNotReceived` and `parseSummary`.
- **splitit-app-96 (groups v2):** owns `lib/homeSections.ts`, `lib/homeSections.test.ts`, `app/(app)/index.tsx`, `__tests__/homeLayout.test.tsx`. Their `MARKER_GROUPS` already covers `sent` / `not_received`; their grouping reads the balance (U-A1.6 holds by construction). They reserved `'sent'` and `'not_received'` in `HomeMarker` (type-only, `lib/homeMarkers.ts` lines 26-31). **`seenAt: null` (their D-0b):** whichever of us lands second adds it to the `summary()` builder in `lib/homeSections.test.ts` and to any hand-built `BillSummary` in `__tests__/homeLayout.test.tsx` (pre-approved for us). If theirs has landed first, Task 3 does it (it adds `seenAt` to `BillSummary`).
- **Groups session** (GR-10): its `bill_participants` triggers refuse marks on group bills. They must allow the new columns. The main session orders the two migrations' timestamps.
- **Deploy:** `npx supabase db push`, then the web deploy, in the same sitting (old signatures are dropped; SV-2, SV-ENG-23).

---

## What this changes in M3 (read first)

| # | Today (ADR 0015 / 0021) | After this slice |
|---|---|---|
| M3-Δ1 | Sam taps **Pay**, Venmo opens, and on return he answers **"Did you pay Hana?" → I paid**. Opening Venmo never marks anything (0015 §2). | **Opening Venmo counts as sent** on phones and mobile web. The tap records "Sent via Venmo · $15.10" by itself. Nobody taps "I paid". The words are "Sent", never "Paid" or "Confirmed". It counts toward "Settled up". On **desktop web** the app asks on return instead (contract O), because a venmo.com tab may not be able to pay (A1). |
| M3-Δ2 | "I already paid" (cash, other apps) sits as a ghost button on the owes card. | **The person chooses how they paid: Venmo or Cash** (a two-option choice on the owes card, extensible to Zelle, PayPal and Cash App). "I paid Hana $15.10 in cash" is the Cash primary. **"I already paid" stays, renamed "Paid another way"** (method `other`). |
| M3-Δ3 | The payer's only way to clear someone's mark is **Undo** (Q4), silent apart from an Activity line. | The payer gets **"Not received"** instead of Undo on each marked row. It clears the mark, tells Sam in-app ("Hana hasn't received your $15.10. Check Venmo before paying again."), shows `Not received · $15.10` on his Home row (Waiting on you), and logs `not_received`. Sam's own Undo and the non-payer host's Undo stay (SV-10). |
| M3-Δ4 | "Pay Hana $1.10 more" opens Venmo and then asks "Did you pay Hana $1.10?" | **Differences follow the same automatic rule**, open first, and get **no check-in** (A1, F4). The more-due card gets the same Venmo / Cash choice; "I paid the difference" is the "another way" option. Paying **back** is unchanged and manual (SV-12). |
| M3-Δ5 | No notifications. | **Sam gets one local check-in notification** one minute after Venmo opens for a share ("Did your $15.10 to Hana go through?" Yes / No, undo). If he comes back to SplitIt first, it's cancelled and the same question shows inline on his card. Hana gets **no** notification. Her Home row in **Owed to you** shows "Sam sent you $15.10" until she sees the bill, and only while someone still owes. |
| M3-Δ6 | A mark stores amount and time. | A mark also stores **how**: `settled_method` ∈ `venmo`, `cash`, `other`. Existing marks become `other`. |
| M3-Δ7 | No Pay button after marking (card). | Still true, and now also in the footer, for every method (decision 5). |

---

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already running) | 1 migration (method column, not-received columns, `mark_paid` / `settle_difference` changes, `mark_not_received`, `my_bills.seen_at`, 1 event kind) | $0, already set up |
| `expo-notifications` (Expo SDK package, `~57.0.25`, resolves to 57.0.26) | Sam's local check-in notification | $0. **Verified by source reading** in `docs/specs/2026-11-26-sent-via-venmo-notifications-check.md` (Task 1, GO with one condition). Not installed yet |
| A **new iOS development build** | Any native module needs one (`npx expo run:ios --device`) | $0 with the free Personal Team, **if** stripping `aps-environment` with `plugins/withoutPushEntitlement.js` lets the free team sign. Source reading says yes; **unverified on a device**. Task 8's first device step checks it (R1) |
| iPhone with Venmo + your Venmo account | User checks U1, U2 | $0, already used. Nobody completes a payment |
| A way for the phone to reach Supabase | U1, U2 | $0. Either the hosted project with this slice's migration pushed (`npx supabase db push` plus the web deploy in the same sitting, your call, deploy session), or the Mac's LAN IP plus matching OAuth redirect URLs. **Blocked until one exists** |
| Two Google test accounts (exist) | U3, U4 on web | $0 |
| Apple Push Notification service, push server, Expo push tokens, paid Apple Developer | **Not needed.** Local notifications only. Never call `getDevicePushTokenAsync` / `getExpoPushTokenAsync` | $0 |
| Android phone | Optional | Not run if there isn't one (R4) |

Nothing new to sign up for, unless the Personal Team still refuses to sign (R1). That comes back to you before any further build.

## Goal
Sam pays his share in one tap and never has to come back to tap "I paid". The app says only what it knows ("Sent via Venmo", or "Paid in cash" when he says so). A minute later it asks whether the payment went through. Hana sees "Sam sent you $15.10" on Home while she's still owed, without being notified, and if the money never arrived she taps "Not received" and Sam is told.

## In scope
- DB: `bill_participants.settled_method`; three `not_received_*` columns; `private.is_payment_method`; `mark_paid` takes a method and returns `(settled_at, created)`; `settle_difference` takes a method; new `mark_not_received`; `my_bills()` returns `seen_at`; event kind `not_received`; method and both sides in event details.
- lib: payment methods (contract M), the send hook (contract A), check-in rules (contract C), not-received (contract N), Home `sent` / `not_received` markers (contract S), Activity sentences (contract V), web opener, resume gate.
- Native: `expo-notifications` install, `app.json` plugin plus `plugins/withoutPushEntitlement.js`, a local-notification module (web no-op), permission request, schedule/cancel, response handling, a Jest stand-in, rebuild note.
- UI primitives: `SegmentedControl`, `Button`, `TextLink` options (Task 12).
- Screens: Settle card (method choice, sent/cash states, inline check), Settle rows (Not received), bill footer, mark-seen per version and on blur, notification tap → Settle.
- Live check, docs.

## Out of scope (cut)
- **Zelle, PayPal, Cash App options.** The list is extensible (D1); none is built.
- **A "Confirmed" badge for Hana** (decision 4: may come later).
- **Notifications for Hana**, or any push or remote notification.
- **Automatic pay-back** (SV-12). **A check-in for "more" sends** (F4).
- **Home updates for differences** ("Sam sent you $1.10 more"): Activity only (SV-22).
- **Any age-off** for the `sent` marker (U-A1.5). **Any special Settled handling** for unseen updates (U-A1.6).
- A notification settings screen. Denied → never asked again (SV-17).
- Changing `unmark_paid`'s permission rule, `leave_bill`, `remove_participant` or any table grant. (`set_payer` and the reset trigger get body edits that null the new columns; D1, D8.)
- **Editing `lib/homeSections.ts`, `lib/homeSections.test.ts`, `__tests__/homeLayout.test.tsx` or `app/(app)/index.tsx`** (splitit-app-96's), except the pre-approved lines: `waiting_on_others: ['waiting']` in `MARKER_GROUPS` plus one `GROUP_FIXTURES` fixture (Task 7), and `seenAt: null` in their builders if theirs lands first (Task 3).
- **Editing `app/_layout.tsx`** (scan-pipeline session's). The resume-gate lines are theirs to add, on request (F10).
- `fetchPeopleCounts` / `isCutOff` in `lib/bills.ts`.

---

## User decisions (fixed)
1. Opening Venmo counts as sent. "Sent", never "Paid/Confirmed". Counts toward Settled up. (A1: desktop web asks on return instead; that's the "never say anything untrue" rule.)
2. Check-in notification **1 minute** after Venmo opens: "Did your $15.10 to Hana go through?" Yes / No, undo. Cancelled if Sam returns first. Ignoring it is fine. Local scheduling, permission asked when first needed. Web: no notification.
3. No notification for Hana. Her Home row shows the newest unseen update, which clears when she sees the bill. No Dismiss. History in Activity.
4. "Not received" on Sam's row for the payer: clears, tells Sam in-app, logs to Activity. No confirm required from Hana for received payments.
5. No double payment: no Pay button once Sam has sent.
6. **(A1)** Home groups v2: Waiting on you / Owed to you / Settled / Hidden. "Sam sent you $15.10" shows on the payer's row in **Owed to you**; once nobody owes, the bill is in Settled and the row says `Settled up`. No Dismiss, no age-off. Tapping opens the bill.
7. Inline check on return: if Sam is back before the notification fires, cancel it and show the question inline on his card, once per send, on web too. Yes keeps "Sent via Venmo"; No, undo clears the mark.
8. Choose how you paid: Venmo / Cash / Paid another way. Venmo is the default when the payer has a Venmo username, Cash otherwise. The last Venmo/Cash choice is remembered on the device. One primary. Cash: no link, no notification.

---

## Design

### D1. Shared contract M: payment methods (defined once; Tasks 2, 3, 6, 7 point here)

**The list:** `venmo`, `cash`, `other`, in that order.
- lib: `PAYMENT_METHODS = ['venmo', 'cash', 'other'] as const`, `type PaymentMethod`, `isPaymentMethod(v: unknown)`, `availableMethods(payerVenmo)`, in new `lib/paymentMethods.ts`. Nothing else in `lib/`, `app/` or `components/` spells the list out.
- DB **(A1):** one function, `private.is_payment_method(p text) returns boolean language sql immutable` (`select p in ('venmo','cash','other')`). The check `bill_participants_settled_method_known check (settled_method is null or private.is_payment_method(settled_method))`, the not-received check, `mark_paid` and `settle_difference` (raising `22023 invalid_method`) all call it. No other SQL spells the list.
- Drift test (`lib/paymentMethods.test.ts`) reads the newest migration that defines `private.is_payment_method` and fails if its list differs from `PAYMENT_METHODS` (precedent: `lib/settleCaseIds.test.ts`).
- **Adding Zelle later** = add `'zelle'` in one migration (`create or replace` the function) plus one lib line. The drift test forces both.

**Stored meaning.** `bill_participants.settled_method text null`:
- `(settled_at is null) = (settled_method is null)` (check `bill_participants_method_with_mark`, next to `bill_participants_mark_complete`).
- The migration backfills every existing mark to `'other'` before adding the constraints.
- `mark_paid` sets it from `p_method`.
- `settle_difference` **more**: `settled_method = case when settled_method = p_method then settled_method else 'other' end` (SV-4). **Back**: unchanged, whatever `p_method` says (tested). To 0: null.
- **Every statement that clears a mark nulls `settled_method` in the same UPDATE**, or the check fails `23514`: `private.bill_participants_reset_payer` (`20261124081411_settle_payer.sql:114-118`), `set_payer` (`:229-233`), `unmark_paid` (`20261124081412_settle_marks.sql:155-157`), `settle_difference` to 0. Line numbers are from the eng review; re-check at build time. **(A1)** `set_payer` and the reset trigger also null the three `not_received_*` columns (SV-ENG-14).

**Copy by method (`lib/paymentMethods.ts`):**

| Method | Chooser label | Mark line (card) | Row status (payer view) | Sam's own Home pill | Why |
|---|---|---|---|---|---|
| `venmo` | `Venmo` | `Sent via Venmo` | `Sent via Venmo` | `Sent $15.10` | The app only knows Venmo opened |
| `cash` | `Cash` | `Paid in cash` | `Paid in cash` | `Paid $15.10 in cash` | A deliberate self-report |
| `other` | (the `Paid another way` link) | `Marked paid` | `Paid` | `Paid $15.10` | Today's copy |

**Zelle later (not built).** Zelle has no public pay link that pre-fills recipient and amount (verify when that slice is specced). Likely shape: payer adds a Zelle email/phone on Profile (a column-granted `profiles` field), the card shows "Send $15.10 to … in your bank's Zelle", the primary is "I paid via Zelle" (method `zelle`, a manual self-report). `availableMethods` would read that field. Nothing here blocks it.

### D2. Shared contract A: the send (Tasks 3, 5, 9a)

**What "sent" records:** `mark_paid(bill, payer, cents, 'venmo')` for a share, or `settle_difference(bill, me, payer, from, from + cents, 'venmo')` for "more". `cents` is the amount in the Venmo link. `venmo` is written only by this path and by contract O's "Yes, I sent it", so **method `venmo` means "recorded around opening Venmo"** (SV-3).

**When it fires:** only from a primary "Pay … on Venmo": the owes card, the more-due card, or the bill footer's Pay. Never from Request, Pay back, "Open Venmo again" or a notification.

**One hook (A1, F12): `lib/useVenmoSend.ts`**, used by `settle.tsx` and `bills/[id]/index.tsx` (today the logic is duplicated at `settle.tsx:210-231` and `bills/[id]/index.tsx:210-243`). Platform branches live in the hook, not the screens.

**Native, a share (A1, F2 + F3):**

| Step | Action |
|---|---|
| 0 | Repeat-tap guard (`writing` ref + existing `PAY_REPEAT_MS`) |
| 1 | Permission, only if `ios.status` is undetermined (0) and device flag `splitit.notifAsked.v1` is unset. Android: create the `sent_check` channel first. Never blocks the flow: any answer continues |
| 2 | `markPaid(bill, payer, cents, 'venmo')` → `{ markAt, created }`, raced against `MARK_BEFORE_OPEN_TIMEOUT_MS = 4000` (starting value; the call isn't aborted) |
| 3 | If ok **and** `created` **and** permission granted: `scheduleSentCheck(…)` (category registered first, memoized), raced against `SCHEDULE_TIMEOUT_MS = 1000` (starting value). A failure means no notification; the inline check covers it |
| 4 | `openPaymentLink(url)`. If it fails → `unmarkPaid(me)` + cancel the check-in + the open-failed line (SV-7) |
| 5 | Refetch (existing `clearAt` / `finished` rule) |

| Step 2 outcome | Venmo | Screen |
|---|---|---|
| ok, `created` | schedule, then open | the sent card is ready behind Venmo |
| ok, `created = false` (already marked: stale screen, second device, double tap) | **don't open**, no schedule | refetch + error-slot Banner `You've already marked this. Check below.` |
| `payer_changed` / `not_complete` / `all_zero` / `is_payer` / `invalid_*` / `not_allowed` / `mark_changed` | don't open | `actionError` + refetch |
| `network` or timeout (outcome unknown) | open anyway, no schedule | contract O on return; a late result only refetches |

On return, the `AppState` background → active refetch decides: mark present → "Sent via Venmo" + inline check (key from the fetched `mark.at`); mark absent + `openedVenmo` → contract O. Never render from data older than that refetch.

**Native, "more":** open first, then `settleDifference(…, 'venmo')` (SV-8). **No check-in** (F4: `settle_difference` keeps the first `settled_at`, so a key would never match).

**Web (A1, eng §1; replaces SV-9):**
- `openPaymentLinkWeb(url)` runs **synchronously first** in the tap handler: `const w = window.open(url, '_blank')` (not RN `Linking`, which passes `noopener` and always returns null), then `if (w) w.opener = null`. Returns the window or null.
- Which web: `detectMobileWeb` from `lib/appBanner.ts` (AB-6). Don't write a second phone test.
- **Blocked** (`null`) → no write; the open-failed line.
- **Mobile web:** wait `WEB_OPEN_CHECK_MS = 300` (starting value), then auto-mark (`markPaid` / `settleDifference` with `'venmo'`) only if `!w.closed`. If `w.closed` (Venmo's universal link took over and closed the tab, or the browser closed it) → contract O on return. Tool fact, **verify in U3 on iOS Safari and Android Chrome; reword if the browser differs**.
- **Desktop web:** never auto-mark. Open, then show contract O ("Did you send Hana $15.10?").
- Write errors after an open: `network` → contract O; others → `actionError` + refetch, with copy saying to check Venmo.
- No notification on web.

**Contract O, kept as the fallback.** `OpenedVenmo` / `openedStillMatches` unchanged. `openedVenmo` is set only when the write's outcome is unknown, on desktop web, or on mobile web when `w.closed`. Copy: label `Did you send <Payer> $15.10?`, primary `Yes, I sent it` (records with `'venmo'`), ghost `Open Venmo again` (opens only); the footer variant adds `Not yet`. "Yes, I sent it" stores `'yes'` for the new mark's key at once (he has just answered), so the inline check never follows it. A repeat after a write that landed returns `created = false` and is treated as success here.

### D3. Shared contract C: the check-in (notification on phones, inline question everywhere)

**Constants (`lib/sentCheck.ts`):** `SENT_CHECK_DELAY_SECONDS = 60` (user value) and `SENT_CHECK_INLINE_MAX_MINUTES = 30` (starting value).

**Keys (A1, F1 + §11). All device keys match `^[\w.-]+$`** (SecureStore rejects `:`; `lib/storage.native.ts` can't list keys):
- Answers blob: storage key `splitit.sentcheck.v1.<userId>`, value JSON `{ "<billId>.<payerId>.<markAtMs>": { "a": "yes" | "undo" | "shown", "t": <ms> } }`. Entries older than 2 days are pruned inside the blob on every write. A malformed blob reads as empty.
- `markAtMs = Date.parse(settled_at)`, compared as numbers.
- Notification identifier: `sentcheck.<userId>.<billId>.<payerId>.<markAtMs>`.
- Remembered method: `splitit.payMethod.v1.<userId>` (`venmo` / `cash` only).
- Permission asked: `splitit.notifAsked.v1`.
- Every builder is tested against `/^[\w.-]+$/` with real UUIDs.

**Notification (native only; Task 8):**
- Scheduled at D2 step 3 for shares only: `TIME_INTERVAL` trigger, `seconds: SENT_CHECK_DELAY_SECONDS`, `repeats: false`, category `sent_check`, identifier as above.
- Content from `sentCheckNotification({ payerName, cents })` (pure): title `SplitIt`, body `Did your $15.10 to Hana go through?` (blank name: `Did your $15.10 go through?`). **No sound, no badge (SV-UX-6).** Data `{ billId, userId, payerId, cents, markAtMs }`: UUIDs, integers and a number only. Never item names, the bill name, handles or Sam's name.
- Category: `yes` (`Yes`, `opensAppToForeground: false`) and `undo` (`No, undo`, `opensAppToForeground: true`, `isDestructive: true`). Always pass `opensAppToForeground` explicitly (the iOS default differs from the docs). iOS hidden-preview placeholder `Check your SplitIt payment` via the category option (**verify the name, likely `previewPlaceholder`; reword if the package differs**).
- No `setNotificationHandler` (nothing shows while SplitIt is in front, which is what we want).
- **Cancelled** (`cancelScheduledNotificationAsync` **and** `dismissNotificationAsync`) when the app goes background → active (all pending `sent_check` for the signed-in user, filtered on `content.data.userId`), on sign-out, and on any in-app undo of that mark.
- **Yes:** writes nothing to the server. If JS runs, store `'yes'` and dismiss. A lost or late Yes is harmless (the inline question may show once).
- **No, undo:** opens the app, routes to `/bills/<billId>/settle`, runs the undo rule.
- **Body tap:** routes to `/bills/<billId>/settle`, no other effect.

**Responder (A1, F10): `components/SentCheckResponder.tsx`, mounted in `app/(app)/_layout.tsx`.** Listens with `addNotificationResponseReceivedListener`, and handles the cold-start response from `getLastNotificationResponse()` (the hook `useLastNotificationResponse`; `getLastNotificationResponseAsync` is deprecated). Rules:
- Dedupe by `identifier|actionIdentifier`; `clearLastNotificationResponse()` after handling.
- Allow-list `data`: UUID `billId`, `userId`, `payerId`; integer `cents`; number `markAtMs`; `userId === session user`. Anything else, or signed out → ignored, no error.
- Route only `router.push('/bills/' + billId + '/settle')`, never for `yes`.
- **Resume gate:** `lib/resumeGate.ts` exports `settleResume(kind: 'none' | 'signed_in')` and `resumeSettled(): Promise<kind>`. The responder awaits it, and **drops the cold-start response when the kind is `'signed_in'`** (the sign-in resume owns navigation; lesson 2026-11-19). `ResumeAfterSignIn` in `app/_layout.tsx` calls `settleResume` (requested from the scan-pipeline session). **Fallback if declined:** the responder handles only live listener responses and ignores the cold-start one; a "No, undo" from a killed app then just opens SplitIt, and the inline question covers it on the Settle screen.

**Inline question (all platforms; Tasks 5, 6, 9).** `sentCheckInline(input, store, now)` returns the model or null. Shows on Sam's card (and as the footer's `sent_check` variant) when **all** hold:
1. the viewer's mark exists, its method is `venmo`, and `mark.toUserId === plan.payerId` (A1, F11 + §11; always true today, kept for several payers);
2. the key `<billId>.<payerId>.<markAtMs>` has no stored answer;
3. `now − markAt ≤ SENT_CHECK_INLINE_MAX_MINUTES` (exactly 30 min shows; 30 min + 1 ms doesn't).

Card copy `Did it go through?` (SV-UX-5); footer copy `Did your $15.10 to Hana go through?`; actions `Yes` · `No, undo`. While it shows, the card's own Undo and the completion line are hidden. **Shown once:** when the screen that displayed it loses focus (navigation, not app background; R3), store `'shown'`. Yes → store `'yes'`. Answering in the card or the footer answers both.

**The undo rule (A1, F6; notification and inline).** Pure `undoDecision(stored, fresh, data)`, after re-reading the bill (`fetchBill`):

| # | Condition (first match) | Result |
|---|---|---|
| 1 | stored answer is `'undo'` | `noop` (nothing shown) |
| 2 | fresh mark is null | store `'undo'`, cancel, nothing shown |
| 3 | fresh mark has method `venmo`, `cents = data.cents`, `markAtMs = data.markAtMs`, `toUserId = data.payerId` | `unmark`: `unmarkPaid(me)`, then store `'undo'`, cancel, announce `Undone. Not marked as sent.` |
| 4 | otherwise | `changed`: store `'undo'`, Banner `Your payment to Hana changed since then, so nothing was undone. Check below.` |

`unmarkPaid` failing on network → Banner `Couldn't undo. Try again.`, nothing stored, the question stays.

**Permission (native; SV-16, SV-17, A1):**
- Asked at the first Venmo Pay tap on the device (card or footer), before Venmo opens. Request full authorization: `requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true } })`, not provisional, no badge. Read `ios.status` (0 undetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral); root `granted` misreports provisional.
- While undetermined, the Venmo-selected card and the Pay footer show the muted note `We'll check back in a minute to make sure it went through.` (SV-UX-7). Native only.
- Denied: no notification, no note, no re-ask. The inline question still works.
- Android 13+: channel before the request (**Unverified (device)**, R4).

### D4. Shared contract N: "Not received" (Tasks 2, 3, 6, 9)

**Stored:** three nullable columns on `bill_participants`, all set or all null (check `bill_participants_not_received_complete`, with cents 1..99,999,999 and `private.is_payment_method(not_received_method)`):
- `not_received_cents integer`, `not_received_method text`, `not_received_by uuid`. **`not_received_by` is the person the money was owed to** (the `to_user`; today always the payer who said so). No foreign key on purpose (no `profiles` lock, no cascade); the column comment says so.
- Readable by every participant through the existing table `select` grant. No new exposure (the same fact is in Activity).
- **Set** by `mark_not_received`. **Cleared** by `mark_paid` (same UPDATE as the mark), **and (A1) by `set_payer` and the payer-reset trigger** (SV-ENG-14, reverses SV-25: no stale warning after payer A → B → A).

**Function (A1, F5 + §11):** `public.mark_not_received(p_bill_id uuid, p_user_id uuid, p_payer_id uuid, p_expected_cents integer, p_expected_at timestamptz) returns void`, security definer, `search_path = ''`. Execute revoked from `public, anon, authenticated`, granted to `authenticated`.

| Step | Check | Error |
|---|---|---|
| 0 | signed out | `42501 not_allowed` |
| 1 | caller not a participant (plain read, no lock) | `42501 not_allowed` |
| 2 | lock `bills` `FOR SHARE`, re-check participation | `42501 not_allowed` |
| 3a | caller ≠ `p_payer_id` | `42501 not_allowed` |
| 3b | `p_payer_id` ≠ the bill's current payer | `22023 payer_changed` |
| 3c | `p_user_id` null or = the payer | `42501 not_allowed` |
| 4 | `p_expected_cents` null or outside 1..99,999,999, or `p_expected_at` null | `22023 invalid_amount` |
| 5 | lock `p_user_id`'s row `FOR NO KEY UPDATE`; no row | `22023 mark_changed` |
| 6 | **idempotent retry:** row unmarked, `not_received_cents = p_expected_cents`, `not_received_by = caller` → success; no write, no event, no broadcast | — |
| 7 | row unmarked, or `settled_cents ≠ p_expected_cents`, or `settled_at ≠ p_expected_at` | `22023 mark_changed` |
| 8 | clear `settled_at`, `settled_cents`, `settled_method`; set `not_received_cents/method` from the old values, `not_received_by = caller`; log one `not_received { user_id, payer_id, cents, method }`, actor = caller | — |

`p_expected_at` closes the ABA case (a mark cleared and re-sent at the same amount). R8 stays open for `settle_difference` only.

**What each side sees:**
- **Sam's card** (unmarked, owes, `notReceived.toUserId === plan.payerId`): the first status line under the amount, warning tone: venmo `Hana hasn't received your $15.10. Check Venmo before paying again.`; cash `Hana hasn't received your $15.10 in cash.`; other `Hana hasn't received your $15.10.` (SV-UX-2). Then the normal owes card. Gone once he marks again.
- **Sam's footer (A1, SV-UX-11):** primary `Settle up` + caption `Hana hasn't received your $15.10` with the warning triangle. Never the Pay or cash footer in this state.
- **Sam's Home row (A1, SV-UX-15):** marker `not_received`, accent pill `Not received · $15.10` (a11y `Hana hasn't received your $15.10`), group **Waiting on you**. The group comes from his balance (unmarked, role `owes`), not the marker; `MARKER_GROUPS.not_received = ['waiting']` is already in groups v2. Data comes from settle data (F8). If the bill was hidden (he'd paid in full), Not received makes him owe again, so it comes back.
- **Hana's row for Sam:** `Not yet` plus muted sub-line `Not received · $15.10` until Sam marks again.
- **Activity:** D6.

**Compared with Undo (Q4):**

| Control | Who | Effect | Event | Sam is told |
|---|---|---|---|---|
| Undo (own card) | Sam | clears his mark | `unmarked_paid` | n/a |
| Undo (row) | host who isn't the payer | clears | `unmarked_paid` | existing live notice only |
| **Not received** (row) | the payer (host or not) | clears + stores the flag | `not_received` | warning line, footer caption, Home pill |

For the payer, the row shows Not received and **no Undo** (SV-10). The DB still lets the payer call `unmark_paid` directly (silent clear, SV-26; before-production §4 notes it will need a `to_user` once there are several payers).

**Confirm (SV-UX-13):** inline warning Banner in the row: `Didn't get Sam's $15.10? This clears it and lets Sam know.` with `Not received` (danger, tonal) / `Cancel` (ghost). After: iOS announces `Marked not received. Sam will see it.`; Android/web use the Everyone card's polite caption slot.

### D5. Cards, rows and footer (Task 6 builds the models in `lib/settleView.ts`; Task 12 the primitives; Task 9a/9b draws them)

**Model shapes (A1, visual §10):**
- `SettleCardModel.chooser: { options: { value: PaymentMethod; label: string }[]; value: PaymentMethod; a11yLabel: "How you're paying" } | null`. Null with fewer than 2 methods. Rendered between the head lines and the primary.
- `SettleCardModel.check: { question: string; yes: SettleButton; undo: SettleButton } | null`. While non-null, `secondary` holds no Undo and the completion line is absent.
- `SettleRowModel.notReceived: { a11yLabel; a11yHint; confirmText } | null`, **separate from `undo`** (rendered as a `TextLink`). A row never has both.
- `SettlePeopleModel.wideStatus`: also true when any row shows a method status.
- `SettleFooterAction`: new `cash` kind (same shape as `pay`), new `sent_check` kind (`text`, `yes`, `undo`, `details`); `settle.tone` gains `'warning'`.
- `NoticeSnapshot` gains `notReceived: boolean`; `noticeFor` shows no "undone" banner when it's true (SV-19).

**Method choice (owes and more-due cards):**
- `availableMethods(payerVenmo)`: `['venmo', 'cash']` when the payer's username is valid, else `['cash']`.
- Chooser: the existing `SegmentedControl` in **hug mode**, left-aligned (SV-VIS-1), radio semantics (`radiogroup` `How you're paying`, `radio` segments with `checked`), `disabled` while any write from the card is in flight. 16 pt above it, 12 pt to the primary.
- **Default:** remembered method if available, else `venmo` if available, else `cash` (SV-18). Tapping a segment stores it. "Paid another way" is never remembered. A remembered `venmo` is ignored (and kept) on a cash-only card.

| Selection | Primary | Notes | Ghost |
|---|---|---|---|
| Venmo | `Pay Hana $15.10 on Venmo` (a11y `Pay Hana $15.10 on Venmo, to @hana-1`, hint `Opens Venmo and records it as sent`) | `@hana-1 · $15.10`; web line (`On a computer? Send it from the Venmo app on your phone.`); permission note (native, undetermined) | `Paid another way` (hint `Records that you paid Hana outside SplitIt`) |
| Cash | `I paid Hana $15.10 in cash` (hint `Records that you paid in cash. Nothing opens.`) | — | `Paid another way` |
| Cash only | `I paid Hana $15.10 in cash`, head line `Hana hasn't added Venmo yet.`, no chooser (SV-29) | — | `Paid another way` |

More-due card: same chooser; head `You owe Hana more` / `$1.10` / `Your share is now $16.20. You've sent $15.10.` (venmo) or `You've paid $15.10.` (cash/other) (SV-UX-22); primaries `Pay Hana $1.10 more on Venmo` / `I paid the $1.10 in cash`; ghosts `I paid the difference` (method `other`) and `Undo all $15.10` (SV-UX-18).

**Marked card (Sam):**

| Method | Label / amount | Lines | Inline check | Ghost |
|---|---|---|---|---|
| `venmo` | `You sent Hana` / `$15.10` | `Sent via Venmo` (success, live); then `You're all set. Hana can see it.` (muted) when ready, no difference, check gone | D3 while it applies | `Didn't go through? Undo` (hidden while the check shows) |
| `cash` | `You paid Hana` / `$15.10` | `Paid in cash` (success, live); completion line as above | never | `Undo` |
| `other` | `You paid Hana` / `$15.10` | `Marked paid` (success); completion line as above | never | `Undo` |

Early marked cards keep the settle-early line instead of the completion line. Difference cards never show it and use `Undo all $X`. No Pay button on any marked card or marked footer (decision 5).

**Payer card (Hana) (SV-UX-14):** open: `3 people owe you` / `$45.20` / muted `1 of 3 settled up` (early: `1 settled up so far`). All settled, no differences: label `Everyone's settled up. Nice.`, success method line `2 sent via Venmo · 1 paid in cash · 1 marked paid` (parts that apply, that order); one ower: `Sam sent it via Venmo` / `Sam paid in cash` / `Sam marked it paid`. Everyone aside: `All settled up`. Counts only, no money arithmetic in the model beyond today's.

**Rows (Everyone list):**

| Viewer | Sam's row status | Controls |
|---|---|---|
| payer | `Sent via Venmo` / `Paid in cash` / `Paid` (success; difference statuses win as today) | `notReceived` (TextLink `Not received`, own line, flush right; a11y `Not received, Sam's $15.10`, hint `Asks first, then clears it and lets Sam know`), inline confirm. Replaces the payer's Undo everywhere, including difference rows |
| host, not payer | same | `undo` (today) |
| anyone else | same | none |

Row a11y labels: `Sam, $15.10, sent via Venmo` / `Dee, $20.00, paid in cash` / `Raj, $10.10, marked paid`; after Not received `Sam, $15.10, not paid yet, not received $15.10`; own row `You, $15.10, sent via Venmo`.

**Footer (bill screen) (A1, SV-UX-10/11/12):**

| State | Footer | Caption |
|---|---|---|
| Ready, owes, Venmo selected and available | `pay`: `Pay Hana $15.10 on Venmo` + notes + Details; runs `useVenmoSend` | |
| Ready, owes, Cash selected or payer has no Venmo | **`cash`**: `I paid Hana $15.10 in cash` + Details | |
| Ready, owes, U! | primary `Settle up` | `Hana hasn't received your $15.10`, **tone `warning`** (triangle in `warning`, text muted; SV-VIS-13) |
| Inline check applies | **`sent_check`**: `Did your $15.10 to Hana go through?` · `Yes` · `No, undo` · Details (no primary) | |
| Contract O | `did_you_pay`: `Did you send Hana $15.10?` · `Yes, I sent it` · `Not yet` · Details | |
| Ready, marked, no difference | secondary `Settle up` | `Sent to Hana · $15.10` / `Paid Hana in cash · $15.10` / `Marked paid · $15.10` (success, live) |
| Early, marked | secondary `Settle up` | `Sent via Venmo · 1 item left to claim` / `Paid in cash · …` / `Marked paid · …` (success, not live) |
| Early, can pay, unmarked | primary `Settle up` | `You can pay now · 1 item left to claim` (unchanged; no Pay/cash footer before completion) |
| Ready, more/back due | primary `Settle up` | unchanged |
| Payer, all settled, no differences | secondary `Settle up` | `Everyone's settled up` (success) |
| Payer, differences | primary `Settle up` | `1 difference to settle` (unchanged) |

The footer reads the same remembered selection as the card and derives from `settleCard`, so they can't disagree.

**Motion (SV-VIS-7, optional):** native-only `LinearTransition.duration(200).reduceMotion(ReduceMotion.System)` around the Settle card stack. Drop it if unreliable on Reanimated 4.5.1.

### D6. Contract V: Activity (Task 4)

| Kind | Details | Actor someone else / actor You / other party You |
|---|---|---|
| `marked_paid`, `venmo` | `{ payer_id, cents, method }` | `Sam sent Hana $15.10 via Venmo` / `You sent Hana $15.10 via Venmo` / `Sam sent you $15.10 via Venmo` |
| `marked_paid`, `cash` | same | `Sam paid Hana $15.10 in cash` / `You paid Hana $15.10 in cash` / `Sam paid you $15.10 in cash` |
| `marked_paid`, `other` or no method (old events) | same | unchanged |
| `paid_difference`, `venmo` | `{ payer_id, from, to, method }` | `Sam sent Hana $1.10 more via Venmo` / `You sent Hana $1.10 more via Venmo` / `Sam sent you $1.10 more via Venmo` |
| `paid_difference`, `cash` | same | `Sam paid Hana $1.10 more in cash` / `You paid …` / `Sam paid you $1.10 more in cash` |
| `paid_difference`, `other` / none | same | unchanged |
| `paid_back` | **(A1)** gains `method` and `payer_id` (next to `user_id`) | unchanged sentences |
| `not_received` (new) | **(A1)** `{ user_id, payer_id, cents, method }`, actor = payer | `Hana hasn't received Sam's $15.10` / `You marked Sam's $15.10 as not received` / `Hana hasn't received your $15.10` |

The event's `method` is the method of the mark that was cleared. Unknown method, bad ids or non-integer cents → null (malformed). Every row tested at $0.01 and $15.10, with the viewer as actor and as the other party.

### D7. Contract S: Home markers, the data contract with splitit-app-96 (Task 7)

**Facts:**
- `my_bills()` gains `seen_at timestamptz` (caller's own `bill_seen.seen_at`, null if no row). `BillSummary.seenAt: string | null`; `seen` stays. Nothing else is added to `my_bills` (F8).
- `PARTICIPANT_COLUMNS` gains `settled_method, not_received_cents, not_received_method, not_received_by`. `SettleMark` gains `method: PaymentMethod` and `toUserId` (from `bills.payer_id` at parse time). Plan entries gain `notReceived: { cents, method, toUserId } | null` (`lib/settle.ts`).
- `settleCandidateIds` drops the HM-4 payer-incomplete skip, so `sent` can show on early payer bills. Request count unchanged.

**`sent` (payer view):**
```ts
export type SentUpdate = { userId: string; name: string; cents: number; method: PaymentMethod; at: string };
export type SentFacts = { billId: string; senders: SentUpdate[]; newestAt: string }; // newest first
export function sentFacts(summary: Pick<BillSummary, 'id' | 'seenAt' | 'seen'>, plan: SettlePlanWithEarly, myId: string, nameOf: NameOf): SentFacts | null;
```
A sender counts when **all** hold: the entry isn't the viewer; it has a mark with `mark.toUserId === myId`; and it's **unseen**: (`seenAt` null **and** `seen` false) **or** `Date.parse(mark.at) > Date.parse(seenAt)` (strict). No clock, no age-off (F9, U-A1.5). A cleared mark isn't a sender.

**When `sent` applies (A1, U-A1.6, SV-ENG-17): only while someone still owes the viewer.** Concretely, `sent` can replace only:
- `left_to_pay` (H5: ready, `paidCount < owingCount`), or
- the payer's early plan (today `null`, HM-4) when at least one other entry with a positive share has no mark (**verify** the early plan exposes `paidCount`/`owingCount` or an equivalent; if not, compute "some ower unmarked" from the entries in `lib/homeMarkers.ts`, no money math).

It **never** replaces `settled` (H7), `differences` (H6) or `new`. Once nobody owes, the marker is `settled` whatever the seen state, and groups v2 puts the row in **Settled** from the balance (their rule 7). If we returned `sent` on a zero balance, the group would still be Settled but their consistency check (`MARKER_GROUPS.sent = ['owed']`, their criterion 21) would flag it, so criterion 29 tests this side. Priority for the payer: `new` > `differences` > `sent` (only in the cases above) > `left_to_pay` / `settled` / null. (H6 is today below H5 in code; keep today's H5-vs-H6 order and insert `sent` only where the result would be `left_to_pay` or the early null.)

**Copy (muted, `icon: null`; SV-UX-16):**

| Senders | Pill | a11y |
|---|---|---|
| 1, `venmo` | `Sam sent you $15.10` | `Sam sent you $15.10 on Venmo` |
| 1, `cash` | `Sam paid you $15.10 in cash` | same |
| 1, `other` | `Sam paid you $15.10` | `Sam says they paid you $15.10` |
| ≥ 2 | `2 people sent you money` | `2 people sent you money: Sam $15.10, Dee $12.00` (newest first) |
| blank name | `Someone sent you $15.10` | same pattern |

**`not_received` (ower view, A1):** the viewer's entry is unmarked, role `owes`, and `notReceived.toUserId === plan.payerId`. Ranks after `new` / `unclaimed`, before `owes`. Accent pill `Not received · $15.10`, a11y `Hana hasn't received your $15.10`. Group Waiting on you (from the balance).

**`waiting_on_others` (guest view, A1, groups v2 D-1):** in the `SettleMarker` union. In `billMarker`, only when the settle step returns null, and **all** hold: a plan is given; `plan.status` is `blocked` or `blocked_all_zero`; `summary.payerId !== myId`; `summary.claimedAny`. `billMarkerView`: pill `Claimed · waiting on others`, a11y `You've claimed. You can pay once the bill is ready`, tone `muted`, icon `null`. Differs from `unclaimed` ("Nothing claimed yet": claiming is your move); here there's nothing to do. Both muted, both Waiting on you. The same change adds `waiting_on_others: ['waiting']` to `MARKER_GROUPS` and a B-state fixture to `GROUP_FIXTURES` (pre-approved; typecheck fails without the record line, as intended). Until it lands, those rows show in Waiting on you with no pill.

**Sam's own pills by method:** `Sent $15.10`, `Paid $15.10 in cash`, `Paid $15.10`; `Sent · $1.10 more to pay` for a venmo mark with more due. A guest paid in full is hidden from Home (groups v2 rule 4), so these show only when the bill is back for another reason (e.g. `paid_more`, early `paid` with a difference).

**Signatures:** `billMarker(summary, myId, plan)` and `homeRowView` unchanged; `MarkerFacts` gains `seenAt`. `billMarkerView('sent' | 'not_received' | 'waiting_on_others', ctx)` needs no clock.

**What groups v2 relies on from us (their "92's marker contract"):** `sent` only while at least one person owes the payer, `settled` otherwise; `not_received` only with the viewer unmarked and role `owes`. Both are criteria here (29, 58).

**Clearing (A1, F7; replaces SV-20):** on the bill screen and the Settle screen, call `markBillSeen` on each new data version while focused, debounced `SEEN_DEBOUNCE_MS = 2000` (starting value), plus once on blur. This keeps Home's focus refresh from reading a stale `seen_at` (`app/(app)/index.tsx:162`). `mark_bill_seen` writes no event and no broadcast.

### D8. Database: schema, functions, grants, locks, direct callers (Task 2)

**One migration** (timestamp from the main session; coordinate order with the Groups migration):
1. Columns, backfill `settled_method = 'other' where settled_at is not null`, `private.is_payment_method`, checks (D1, D4).
2. `create or replace` the clearing bodies: `set_payer`, `private.bill_participants_reset_payer` (both also null `not_received_*`), `unmark_paid`. Signatures unchanged. Task 2 greps every migration for `settled_cents = null` and lists each statement changed.
3. `mark_paid`: drop `(uuid, uuid, integer)`, create `(p_bill_id uuid, p_payer_id uuid, p_cents integer, p_method text) returns table (settled_at timestamptz, created boolean)`. 0021 D3 check order plus `22023 invalid_method` right after `invalid_amount`. Sets the method and nulls `not_received_*`. Event details gain `method`. On the no-op ("already marked"), return `(existing settled_at, false)`; `settled_at` null if a racing unmark won.
4. `settle_difference`: drop the 5-arg, create the 6-arg ending `p_method text`. 0021 D4 checks plus `invalid_method`. More: D1 rule. Back: method unchanged. To 0: null. Event details gain `method` (and `payer_id` on `paid_back`). Idempotent retry unchanged.
5. `mark_not_received` per D4.
6. `my_bills()` drop + create with `seen_at` appended (an old web build still parses: `parseSummary` ignores unknown fields).
7. `bill_events_kind_known`: the latest list on disk (`20261125090051_settle_difference.sql`; re-check for newer definitions, including the Groups slice's) plus `not_received`.
8. `notify pgrst, 'reload schema';`

**Grants:** no table grant changes. `bill_participants` stays SELECT-only for `authenticated`; a direct UPDATE of any new column fails `42501`. Each new or recreated function: `revoke execute … from public, anon, authenticated; grant execute … to authenticated`. Every client read names its columns.

**Lock order (bills row first; implicit locks listed):**

| Path | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| `mark_paid` | participation read, no lock | `bills` FOR SHARE | rule E reads | UPDATE of own row (implicit FOR NO KEY UPDATE) | event insert: FOR KEY SHARE on `bills` and the caller's `profiles` row; broadcast trigger |
| `settle_difference` | same | same | same | explicit FOR NO KEY UPDATE on the target row | same, plus the payer's `profiles` row via `payer_id` in details (no FK, no lock) |
| `mark_not_received` | same | same | — | explicit FOR NO KEY UPDATE on the target row (`not_received_by` has no FK) | same |
| `my_bills` | no locks | | | | |

No new cycles. The account-deletion cascade gap (M3 R9) is unchanged.

**Direct API callers:** may set any method on their own mark (honor system). The payer may mark anyone's current mark not received with the right cents and time (no stronger than `unmark_paid`, logged; old replays closed by `p_expected_at`). The payer's silent `unmark_paid` stays (SV-26). Nobody sets `settled_method` or `not_received_*` on another row except through these functions. `my_bills.seen_at` is the caller's own.

### D9. State × action table (Sam on Hana's bill)

States: **U** unmarked · **U!** unmarked with a flag whose `toUserId` is the current payer · **V** marked `venmo` · **C** `cash` · **O** `other`.

| Action | From U / U! | From V | From C | From O |
|---|---|---|---|---|
| Pay on Venmo (share, phone / mobile web) | → V, flag cleared, `marked_paid{venmo}`, check-in scheduled (phone) | no button | no button | no button |
| Pay on Venmo (desktop web) | opens; contract O → "Yes, I sent it" → V, key stored `'yes'` | — | — | — |
| Pay on Venmo, stale screen (`created = false`) | Venmo not opened; Banner; refetch | — | — | — |
| I paid in cash | → C, flag cleared, `marked_paid{cash}` | no button | no button | no button |
| Paid another way | → O, flag cleared, `marked_paid{other}` | no button | no button | no button |
| Sam's Undo / inline No / notification No | — | → U, `unmarked_paid`, notification cancelled | → U | → U |
| Inline Yes / notification Yes | — | stays V, nothing written, key `'yes'` | — | — |
| Payer: Not received | — | → U!, `not_received{venmo}` | → U!, `{cash}` | → U!, `{other}` |
| Host (not payer): Undo | — | → U | same | same |
| Pay more on Venmo | — | stays V, `paid_difference{venmo}`, no check-in | → O (mixed) | → O |
| I paid the difference in cash | — | → O (mixed) | stays C | stays O |
| Payer pays back to $0 | — | → U (no flag), `paid_back` | same | same |
| Payer changes (`set_payer`) | U! → U (flag cleared, A1) | → U, marks cleared | same | same |
| Leave / be removed | allowed (a flag isn't a mark) | blocked by L3 | same | same |
| Ignore everything | — | stays V; check-in fires once; inline question stops after 30 min | — | — |
| A $0 or negative share | no Pay, no cash button | — | — | — |

---

## Decisions (SV-)

Statuses after A1. Full rows, including SV-UX, SV-VIS and SV-ENG, are in `docs/decisions-to-review.md`.

| ID | Decision | Picked | Why | Status |
|---|---|---|---|---|
| SV-1 | How the auto-send is recorded | `mark_paid` / `settle_difference` with a method argument | One write path with tested tokens | Open; **amended by SV-ENG-3** (returns `created`) |
| SV-2 | Old signatures | Dropped and replaced | One function per rule; nothing released | Open, needs your look; deploy rule SV-ENG-23 |
| SV-3 | Auto vs manual flag | None; `venmo` only from the send path (and contract O's Yes) | The wording needs only the method | Open |
| SV-4 | Method after mixed history | Same kept, different → `other` | Never claims the net went one way | Open |
| SV-5 | Native order | Write first (4 s limit), then open | iOS suspends JS once Venmo is in front | **Amended by SV-ENG-2** (record → schedule → open) |
| SV-6 | Write fails before open | Refusals: don't open; network/timeout: open + contract O | No money to a stale payer | Open; **amended by SV-ENG-3** (`created = false` → don't open) |
| SV-7 | Open fails after write | Undo the mark | Don't say "Sent" when nothing opened | Open |
| SV-8 | "More" on native | Open first, then write | Sam can't lower his own mark | Open |
| SV-9 | Web | Auto-mark only when detected opened | Never untrue about money | **Replaced by SV-ENG-13** |
| SV-10 | Payer's Undo vs Not received | Merged | One control; Sam is told | Open, changes Q4 |
| SV-11 | Confirm on Not received | Inline confirm | Destructive to someone else's record | Open (copy SV-UX-13) |
| SV-12 | Pay-back automatic | No | User named "Pay more" only | Open |
| SV-13 | Undo after an auto "more" | Whole mark, with a confirm | SE-5 | **Moot after SV-ENG-4** (no check-in for more); `Undo all $X` (SV-UX-18) stays |
| SV-14 | "I already paid" | "Paid another way" (`other`) | Truthful option for Zelle etc. | Open (user confirmed the three-way choice) |
| SV-15 | Delays | 60 s (user); inline up to 30 min | Avoid asking about old payments | 60 s **user-confirmed 2026-11-26**; 30 min open |
| SV-16 | Permission timing | First Venmo Pay tap | "When first needed" | Open; **amended by SV-ENG-20** |
| SV-17 | Permission denied | No re-ask, no nag | Inline covers it | Open |
| SV-18 | Remembered method | Device-local per user | Co-participants could read a column | Open; key format SV-ENG-1 |
| SV-19 | "Undone" notice after Not received | Not shown | One message per event | Open |
| SV-20 | When Hana's update clears | On open and on blur | She may watch it arrive | **Replaced by SV-ENG-7** |
| SV-21 | Marker priority | new > unclaimed > differences > sent > H5/H7 | Owed pay-back is an action | **Amended by SV-ENG-17** (sent never replaces settled) |
| SV-22 | Differences on Home | Activity only | Rare; needs a column | Open |
| SV-23 | Age-off | 72 h | "A few days" | **Dropped** (user, SV-ENG-9) |
| SV-24 | Count ≥ 2 copy | "2 people sent you money" | User's wording | Open |
| SV-25 | Not-received line after payer change | Shown only while `by` is current payer | Avoid `set_payer` change | **Reversed by SV-ENG-14** |
| SV-26 | Payer's direct `unmark_paid` | Kept, recorded | Q4 change beyond the slice | Open |
| SV-27 | Lock-screen text | Payer name + amount | User's wording | Open, privacy: needs your look; **amended by SV-UX-6** (hidden-preview placeholder) |
| SV-28 | Notification taps signed out / other user | Ignored; one handler, never during resume | Shared devices | Open; **amended by SV-ENG-10** (resume gate) |
| SV-29 | Chooser when payer has no Venmo | Hidden; Cash only | Fewer elements | Open |
| SV-30 | Not-received storage | 3 columns | Store what the UI reloads | Open; `not_received_by` = the `to_user` (SV-ENG-16) |

---

## Tasks

**Ownership and coordination (read before starting):**
- Allowed shared edits: `package.json` / `package-lock.json` (Task 8, via `npx expo install` only; the `scripts` block, including the other session's uncommitted `pre*` hooks, must be byte-identical before and after), `app.json` (Task 8, plugins array only), `lib/bills.ts` (Task 3; never touch `fetchPeopleCounts` / `isCutOff`).
- **Don't edit** `lib/homeSections.ts` / `lib/homeSections.test.ts` (except the pre-approved `waiting_on_others` lines in Task 7 and `seenAt: null` in Task 3), `__tests__/homeLayout.test.tsx` (except `seenAt: null`), `app/(app)/index.tsx`, `app/_layout.tsx`, `app.config.ts`, `__tests__/uiPrimitives.test.tsx` (another session's uncommitted edits), `components/ui/TextField.tsx`.
- `supabase/`: Task 2 needs a timestamp from the main session, ordered against the Groups migration.
- `git branch --show-current` and `git status` at start and before the summary.
- One Jest run at a time across sessions; `npm test -- --maxWorkers=4`; web builds in a scratchpad copy.

**Final order (eng §9, A1). `‖` = may run in parallel (no shared files):**
```
Wave 1:  T2 migration  ‖  T3 lib/bills + paymentMethods + settle.ts + web opener  ‖  T4 activityText  ‖  T5 sentCheck  ‖  T12 primitives
         (T1 native spike: done, GO; docs/specs/2026-11-26-sent-via-venmo-notifications-check.md)
Wave 2:  T7 homeMarkers (after T3's types)  ‖  T6 settleView (after T3, T5)  ‖  T8 notifications module + plugin (after T5)  ‖  T10 live (after T2, T3)
Wave 3:  T9a useVenmoSend + Settle screen (after T6, T8, T10, T12)
Wave 4:  T9b bill footer + responder + seen-per-version (after T9a; resume gate per F10, or fallback)
Last:    T11 docs
```
T10 is the gate for T9a. T6 and T7 don't share files (T6: `lib/settleView*`; T7: `lib/homeMarkers*`, `__tests__/homeMarkers.test.tsx`). T3 and T12 both avoid `test-utils/jestSetup.ts` (T8's).

**Planned breakage (say "expected until Task N" in reports):**
- T3 adds required `method` and `toUserId` to `SettleMark` and `notReceived` to entries, with defaults in `test-utils/fakes.ts` (`'other'`, the plan payer, null). Hand-built fixtures fail to type-check until they pass them. T3 fixes `lib/`; router tests are T9's.
- T3 gives `markPaid` / `settleDifference` an **optional** `method` (default `'other'`) so `app/` keeps compiling until T9a. `markPaid`'s result changes to `{ markAt, created }`; call sites that ignore it keep compiling.
- T6 changes `did_you_pay` copy, the owes ghost (`I already paid` → `Paid another way`), marked cards, payer copy (`Everyone's paid` → `Everyone's settled up. Nice.`, `All paid` → `All settled up`) and the payer's row controls. Grep tool, 2026-11-26, pattern `Did you pay|I already paid|Undo "I paid"|Everyone's paid|All paid` over `app components lib __tests__`: 116 matches: `__tests__/settle.test.tsx` 49, `lib/settleView.test.ts` 24, `__tests__/billScreen.test.tsx` 22, `lib/settleView.ts` 15, `app/(app)/bills/[id]/settle.tsx` 3, `app/(app)/bills/[id]/index.tsx` 1, `components/SettleCard.tsx` 1, `components/SettleFooter.tsx` 1. T6 updates `lib/settleView.test.ts`; the router test files are T9a/T9b's.
- T7 removes the HM-4 skip from `settleCandidateIds`: `lib/homeMarkers.test.ts` (criterion-63 block) and `__tests__/homeMarkers.test.tsx` fixture S4 ("B pays, not complete") change; T7 lists each.
- `BillSummary.seenAt` (T3): the `summary()` builder in `lib/homeSections.test.ts` and hand-built summaries in `__tests__/homeLayout.test.tsx` fail to type-check until they get `seenAt: null`. If groups v2 has landed when T3 runs, T3 adds those lines (pre-approved); otherwise groups v2 adds them when it lands. T3's report says which.
- `waiting_on_others` (T7) grows `HomeMarker`, so `MARKER_GROUPS` fails typecheck until T7 adds its line (same change).

### Task 1: native spike (done)
GO with one condition: strip `aps-environment` with a local config plugin listed before `expo-notifications`. Personal Team signing is unverified on a device; Task 8 checks it first. See the notifications-check doc.

### Task 2: migration (agent: supabase-engineer; wave 1)
Files: `supabase/migrations/<assigned>_sent_via_venmo.sql` (new), `supabase/tests/database/sent_via_venmo.test.sql` (new), and the existing pgTAP files calling the old signatures (eng §7 count: `settle_marks` 41, `settle_early` 29, `settle_difference` 41, `membership` 1, `claimable_discounts` 1; re-grep `mark_paid(` and `settle_difference(` and list each change).
- D1 schema, backfill, `private.is_payment_method`, checks; D8 items 1–8; D4 function.
- Header: lock-order table, "no client can write any of these columns", direct-caller notes.
- Tests M1–M18, N1–N16 (criteria 1–21, 49–50), each description starting with its tag. Apply with `npx supabase migration up` (never `db reset` without asking). About 220 lines SQL + 350 pgTAP; over that, split into two migrations in the same order.

### Task 3: data layer, methods, web opener (agent: implementer; wave 1)
Files: `lib/paymentMethods.ts` (new), `lib/paymentMethods.test.ts` (new, drift test), `lib/bills.ts`, `lib/bills.test.ts`, `lib/settle.ts`, `lib/settle.test.ts`, `lib/paylinks.ts`, `lib/paylinks.test.ts`, `test-utils/fakes.ts`, and (only if groups v2 has landed) the pre-approved `seenAt: null` in `lib/homeSections.test.ts`'s `summary()` builder and hand-built summaries in `__tests__/homeLayout.test.tsx`.
- D1 list, copy table, `availableMethods`.
- `markPaid(billId, payerId, cents, method = 'other')` → `rpc('mark_paid', { p_bill_id, p_payer_id, p_cents, p_method })` → `{ markAt, created }`. `settleDifference(…, method = 'other')`. `markNotReceived(billId, userId, payerId, expectedCents, expectedAt)`. Local refusals for a bad method, amount or time. `BillError` gains `invalid_method`.
- Parse `settled_method`, the not-received triple (all or none) into `notReceived` with `toUserId = not_received_by`, `toUserId` on marks, and `seen_at`. `PARTICIPANT_COLUMNS` per D7.
- `openPaymentLinkWeb(url): Window | null` (synchronous) and `webOpenStillOpen(w)` per D2.
- About 290 lines with tests. Don't touch `fetchPeopleCounts` / `isCutOff`.

### Task 4: Activity (agent: implementer; wave 1)
Files: `lib/activityText.ts`, `lib/activityText.test.ts`. D6. About 130 lines.

### Task 5: check-in rules (agent: implementer; wave 1)
Files: `lib/sentCheck.ts` (new), `lib/sentCheck.test.ts` (new), `lib/resumeGate.ts` (new), `lib/resumeGate.test.ts` (new).
- Constants, key builders (D3), answers-blob read/write/prune, `sentCheckNotification`, `sentCheckInline`, `undoDecision(stored, fresh, data)`, `parseSentCheckData(unknown)` (allow-list). Pure, no `expo-notifications` import. Resume gate per D3.
- About 220 lines with tests.

### Task 6: settle view models (agent: implementer; two passes, same files; wave 2)
Files: `lib/settleView.ts`, `lib/settleView.test.ts`.
- 6a: D5 card models (chooser, default, owes/more per method, marked per method, completion line, `check` slot, not-received line, payer card copy), footer kinds (`cash`, `sent_check`, U! warning, captions), `NoticeSnapshot.notReceived`, actions `{ kind: 'pay'; method: 'venmo' }`, `{ kind: 'mark'; method }`, `{ kind: 'not_received'; userId; payerId; expectedCents; expectedAt }`, `{ kind: 'sent_check_yes' | 'sent_check_undo'; key }`.
- 6b: rows (status by method, `notReceived` vs `undo`, sub-line, a11y labels, `wideStatus`).
- About 300 lines per pass. Copy from the brief §12.

### Task 7: Home markers (agent: implementer; wave 2, after T3's types)
Files: `lib/homeMarkers.ts`, `lib/homeMarkers.test.ts`, `__tests__/homeMarkers.test.tsx` (only the S4 / candidate assertions; the Home-section assertions there are groups v2's), and the pre-approved lines for `waiting_on_others`: one entry in `MARKER_GROUPS` (`lib/homeSections.ts`) and one B-state fixture in `GROUP_FIXTURES` (`lib/homeSections.test.ts`).
- D7: `sentFacts`, `sent` and `not_received` markers with the "only while someone owes" rule, priority, copy, tones, `MarkerFacts.seenAt`, `settleCandidateIds`, Sam's own pills by method, and `waiting_on_others`.
- **If groups v2's `MARKER_GROUPS` isn't on disk yet** (their Task 1 hasn't landed): build the marker in `lib/homeMarkers.ts` only, and put the two lines for `lib/homeSections*` in the report for whichever lands second. Don't create `MARKER_GROUPS` yourself.
- No other `lib/homeSections*` edits for `sent` / `not_received` (groups v2 has them).
- About 250 lines with tests.

### Task 8: notifications module (agent: native-mobile; wave 2, after T5)
Files: `package.json` / `package-lock.json` (`npx expo install expo-notifications` only), `app.json` (plugins: `"./plugins/withoutPushEntitlement"` **before** `"expo-notifications"`), `plugins/withoutPushEntitlement.js` (new, ~10 lines, header comment), `lib/checkInNotifications.native.ts` (new), `lib/checkInNotifications.ts` (new, web no-op, never imports the package), `lib/checkInNotifications.types.ts` (new; both files `satisfies` it), `lib/checkInNotifications.native.test.ts` (new), `test-utils/jestSetup.ts` (a stand-in that rejects with "expo-notifications not mocked in this test"), `__tests__/appConfig.test.ts` (new cases only; existing ones keep passing).
- Exports: `notificationPermission()`, `askNotificationPermissionOnce()`, `ensureSentCheckCategory()`, `ensureAndroidChannel()`, `scheduleSentCheck(content, id)`, `cancelSentChecks(userId)`, `cancelSentCheck(id)`, `useSentCheckResponses(handler)` (listener + cold-start, dedupe, `clearLastNotificationResponse`). Each await has a time limit.
- Verify against the installed package and record: `previewPlaceholder` option name, `sound` off, `opensAppToForeground` explicit.
- First device step: `npx expo run:ios --device` with the Personal Team. If Xcode refuses to sign, stop and report to the user (R1).
- Report: **"new development build needed: `npx expo run:ios --device`"**.
- About 240 lines with tests.

### Task 12: UI primitives (agent: product-engineer, `ui-ux-designer`; wave 1)
Files: `components/ui/SegmentedControl.tsx`, `components/ui/Button.tsx`, `components/ui/TextLink.tsx`, `__tests__/sentViaPrimitives.test.tsx` (new; not `uiPrimitives.test.tsx`, which another session is editing).
- `SegmentedControl`: `disabled` (0.5, not pressable, `accessibilityState.disabled`); opt-in `semantics: 'radio'` + `groupLabel` (track `radiogroup`, segments `radio` with `checked`). Default stays `button` + `selected`, so BillForm and TipOptions are unchanged (SV-ENG-24).
- `Button`: `flush: boolean | 'start' | 'end'` (`true` = today's centred). Box stays ≥ 44 × 44.
- `TextLink`: `minWidth: TOUCH_TARGET`, `disabled`, `loading` (small `ActivityIndicator` in `primary`).
- About 150 lines with tests. Existing users see no change (tests assert defaults).

### Task 9a: send hook and Settle screen (agent: product-engineer, `ui-ux-designer`; wave 3)
Files: `lib/useVenmoSend.ts` (new), `app/(app)/bills/[id]/settle.tsx`, `components/SettleCard.tsx`, `components/SettlePeopleList.tsx`, `__tests__/settle.test.tsx`, `__tests__/useVenmoSend.test.tsx` (new).
- D2 in the hook (native and web branches, every outcome), cancel-on-active (background → active only), the chooser, one primary, inline check (store `'shown'` on blur), Not received with its confirm, `markBillSeen` per version + blur on Settle, optional motion.
- Every exit and async ending: write ok / created false / refused / network / timeout; schedule ok / failed / timed out; open ok / failed; refetch failed (`finished` rule); sign-out mid-flow.
- About 300 lines.

### Task 9b: bill footer, responder, seen (agent: product-engineer; wave 4)
Files: `app/(app)/bills/[id]/index.tsx`, `components/SettleFooter.tsx`, `components/SentCheckResponder.tsx` (new), `app/(app)/_layout.tsx` (one mount line), `__tests__/billScreen.test.tsx`, `__tests__/sentCheck.test.tsx` (new).
- Footer kinds from D5 via `useVenmoSend`; `markBillSeen` per version + blur on the bill screen; the responder per D3, with the resume gate if the scan-pipeline session added `settleResume`, else the fallback (say which in the report).
- About 250 lines.

### Task 10: live reconciliation (agent: implementer, `live-db-smoke` skill; wave 2, after T2, T3; gate for T9a)
No repo files. Throwaway local users A (host/payer), B, D, outsider C. Keys stay in the process environment (`set -a; eval "$(npx supabase status -o env)"; set +a; node …`); never print them. Runs criteria 30–36 and 57.

### Task 11: docs (agent: docs-writer; last; gets this spec, the four companion docs, the review findings and the QA report in full; reports every bullet done/skipped)
- The sent-via-Venmo and payment-methods ADR (number reserved on disk by the main session), amending 0015 §2 and 0021 §6; dated notes on 0015 and 0021. Include the plugin-order rule (app.json can't hold comments).
- `docs/learning/concepts/in-app-notices.md`: `sent` / `not_received` markers, `seen_at`, seen per version, "groups tell the truth".
- New `docs/learning/concepts/local-notifications.md`: local vs push, the stripped entitlement, permission timing and `ios.status`, categories and actions, cancel + dismiss on return, cold start and the resume gate, why no server.
- `docs/learning/concepts/row-level-security.md`: `mark_not_received` with `p_expected_at`, the payer's direct `unmark_paid`, methods self-reported, `created`.
- `docs/learning/catches.md`: auto-send wording, `noopener` returns null, desktop vs mobile web, SecureStore key characters, mod order runs in reverse, dev build after adding `expo-notifications`.
- `docs/before-production.md`: delay and texts (provisional), web detection per browser, desktop web asks, the payer's silent `unmark_paid` (needs `to_user` later), a write lost on iOS suspension, DB push + web deploy together, push entitlement stripped (remove if remote push arrives), Android unverified.
- `docs/decisions-to-review.md`: SV / SV-UX / SV-VIS / SV-ENG rows current.

---

## Acceptance criteria

Numbers 1–48 are the plan's, edited in place by A1; 49+ are new in A1.

### Database (Task 2; pgTAP unless stated; each tagged)
1. **[M1–M3]** `mark_paid(b, payer, 1510, m)` as Sam, for `m` in `venmo`, `cash`, `other`: stores `settled_method = m`, returns one row `(settled_at, created)` with `created = true` and `settled_at` equal to the stored value, and logs exactly one `marked_paid` with details `{payer_id, cents: 1510, method: m}`.
2. **[M4–M6]** `p_method` `'zelle'`, `null`, `'Venmo'` → `22023 invalid_method`; nothing stored, no event.
3. **[M7]** As `authenticated`, `update public.bill_participants set settled_method = 'cash'` → `42501`; the same for each `not_received_*` column.
4. **[M8]** As the owner: `settled_at` set with `settled_method` null → `23514`; `settled_method` with no mark → `23514`; two of three `not_received_*` → `23514`; `not_received_method = 'zelle'` → `23514`.
5. **[M9]** Every pre-existing marked fixture row has `settled_method = 'other'`; unmarked rows null (fixture rows only, no whole-table counts).
6. **[M10–M12]** `settle_difference` more with `venmo` on a `venmo` mark keeps `venmo`; with `venmo` on a `cash` mark → `other`; a pay-back passing `'cash'` leaves the method unchanged; a pay-back to 0 nulls it. Each event carries `method`; `paid_back` also carries `payer_id`.
7. **[M13]** `mark_paid` on an already-marked row with a different method: method unchanged, no event, returns `(existing settled_at, false)` (backdated in the fixture first, so a rewrite would show).
8. **[M14]** `mark_paid` nulls all three `not_received_*` in the same call.
9. **[N1–N2]** `mark_not_received(b, sam, payer, 1510, sam_settled_at)` as the payer on a `venmo` (then `cash`) mark: settled columns null, `not_received_cents = 1510`, `_method` = old method, `_by` = payer; exactly one `not_received {user_id, payer_id, cents, method}` with actor = payer.
10. **[N3–N4]** Stale `p_expected_cents` (1400) → `22023 mark_changed`, nothing changes. **(A1)** Same cents but a stale `p_expected_at` (mark cleared and re-made, backdated) → `mark_changed`. Unmarked target → `mark_changed`.
11. **[N5]** A retry right after N1 → success, no second event, no change.
12. **[N6–N9]** `42501` for: Sam on himself; the non-payer host passing the real payer id; an outsider; `anon`; an unknown bill; `p_user_id` = payer. **(A1)** The caller passing a `p_payer_id` that isn't the current payer while being that id (a former payer after `set_payer`) → `22023 payer_changed`.
13. **[N10]** `p_expected_cents` 0, null, 100000000, or `p_expected_at` null → `22023 invalid_amount`.
14. **[N11]** After N1, Sam's `mark_paid` clears the flag.
15. **[N13]** `mark_not_received` fires exactly one `bill_participants` broadcast; the idempotent retry fires none.
16. **[N14]** Static lock-order check: participation read, then the bills lock, then the participant-row lock, in that order.
17. `my_bills()` returns `seen_at` equal to the caller's `bill_seen.seen_at` (null with no row) and still returns `seen`. As B, never A's `seen_at`.
18. `bill_events_kind_known` accepts `not_received` and every earlier kind (one insert per kind as owner).
19. Every new or recreated function: `anon` → `42501`; `has_function_privilege('public', …)` false. **(A1)** `mark_paid(uuid,uuid,integer)` and the 5-arg `settle_difference` no longer exist (`to_regprocedure` is null).
20. `set_payer`, the reset trigger and `unmark_paid` still clear marks (existing tests pass), with `settled_method` null. **(A1, N15)** `set_payer` and the reset trigger also null all three `not_received_*`.
21. `npm run db:test` passes, with only the call-signature updates Task 2 lists.
49. **(A1) [M15]** `private.is_payment_method` is the only list: the check constraints' definitions (`pg_get_constraintdef`) and the bodies of `mark_paid` / `settle_difference` (`pg_get_functiondef`) call it and don't contain `'cash'`.
50. **(A1) [M16–M18]** `mark_paid` returns `setof`/`table` with exactly columns `settled_at timestamptz, created boolean` (catalog check); a no-op after a racing unmark returns `created = false` without error; `notify pgrst` is in the migration (static).

### lib (Jest)
22. `PAYMENT_METHODS` equals the list in the newest migration defining `private.is_payment_method` (drift test). `grep -rn "'venmo', 'cash'" app components lib --exclude='*.test.ts' --exclude='*.test.tsx'` matches only `lib/paymentMethods.ts` (Grep tool 2026-11-26 over `app components lib`: no files match today).
23. `lib/bills.ts`: `markPaid` sends `{ p_bill_id, p_payer_id, p_cents, p_method }` and returns `{ markAt, created }`; `markNotReceived` sends `{ p_bill_id, p_user_id, p_payer_id, p_expected_cents, p_expected_at }`. Bad method/amount/time refused locally with no rpc. `invalid_method` maps to a copy key. A marked row with no method, an unknown method, or a partial triple → malformed bill. `PARTICIPANT_COLUMNS` names `settled_method, not_received_cents, not_received_method, not_received_by` (no `*`). `git diff lib/bills.ts` shows no change inside `fetchPeopleCounts` or `isCutOff`.
24. `openPaymentLinkWeb` calls `window.open(url, '_blank')` as its first statement with no `await` before it (the test fails if a microtask runs first), returns null when `window.open` does, and sets `opener = null` on a returned window. The hook's web branch: desktop → contract O, no write; mobile with `!w.closed` after `WEB_OPEN_CHECK_MS` → write; mobile with `w.closed` → contract O; null → open-failed line, no write.
25. **[C1–C7]** `sentCheckInline`: shows for an unanswered `venmo` mark within 30 min; not after `'yes'`, `'undo'` or `'shown'`; never for `cash` / `other`; shows again for a new `markAt`; exactly 30 min shows, 30 min + 1 ms doesn't; **(A1)** not when `mark.toUserId ≠ plan.payerId`; not for a mark whose key was stored `'yes'` by contract O's "Yes, I sent it".
26. `sentCheckNotification({ payerName: 'Hana', cents: 1510 })` → title `SplitIt`, body `Did your $15.10 to Hana go through?`, actions `Yes` (`opensAppToForeground: false`) and `No, undo` (`true`, destructive), **(A1)** no sound, no badge, data keys exactly `billId, userId, payerId, cents, markAtMs`. Blank name → `Did your $15.10 go through?`. `SENT_CHECK_DELAY_SECONDS === 60`.
27. **(A1)** `undoDecision`: one test per D3 row: stored `'undo'` → noop; fresh null → store-undo silent; full match → unmark; changed when exactly one of method, cents, `markAtMs`, `toUserId` differs (four tests).
28. **Settle view (6a/6b):** for each D5 table row, a test of label, amount, lines, chooser, primary and ghosts. Default method: remembered `cash` + payer with Venmo → Cash; remembered `venmo` + no payer Venmo → Cash, chooser null; nothing remembered → Venmo. Every model has at most one primary. No marked card or marked footer has a `pay` or `cash` action. While `check` is non-null, `secondary` has no undo and the completion line is absent. Payer rows have `notReceived` and no `undo`; non-payer host rows have `undo` and no `notReceived`. `wideStatus` true when any row has a method status. Footer kinds per D5, including `cash` on ready + Cash, U! → `Settle up` with tone `warning`, `sent_check`. Payer card `Everyone's settled up. Nice.` with the method line, and one-ower wording. `noticeFor` gives no "undone" banner when `notReceived`. Copy at $0.01 and with "You".
29. **[S1–S16] Home markers (A1):** unseen (`seenAt` null and `seen` false); seen; `seenAt` null but `seen` true → not a sender; mark exactly at `seenAt` → not; 1 ms after → sender; two senders newest first; cash; other; viewer not the payer → no `sent`; `differences` wins; `new` wins; early payer bill with an unmarked ower → `sent`; **the last ower's unseen mark makes nobody owe → `settled`, not `sent`**; cleared mark not counted; blank name; `not_received` for the ower when the flag's `toUserId` is the current payer and he's unmarked, and not when he has re-marked or the flag names a former payer. No clock is read (the test passes with `Date.now` mocked to throw). Sam's own pills by method.
51. **(A1)** Every key builder (`sentcheck` blob key, entry key, notification id, `payMethod`, `notifAsked`) matches `/^[\w.-]+$/` with real UUIDs; a malformed blob reads as empty; pruning drops entries older than 2 days.
58. **(A1, groups v2 D-1)** `waiting_on_others`: returned for a guest with `claimedAny` on a `blocked` plan and on a `blocked_all_zero` plan; not when `claimedAny` is false (→ `unclaimed` or null as today), not for the payer, not with no plan, not on `ready` / `early`. `billMarkerView('waiting_on_others')` → `Claimed · waiting on others`, a11y `You've claimed. You can pay once the bill is ready`, tone `muted`, icon null. If `MARKER_GROUPS` is on disk: it has `waiting_on_others: ['waiting']`, the new `GROUP_FIXTURES` row passes groups v2's criterion 21, and `npm run typecheck` passes. For every `sent` fixture in criterion 29 the plan has someone owing the payer (`owed` balance), and for every `not_received` fixture the viewer is unmarked with role `owes`.
52. **(A1)** `parseSentCheckData` rejects a non-UUID id, non-integer cents, a string `markAtMs`, extra keys carrying URLs, and a `userId` other than the session's.

### Live (Task 10, real local functions through `lib/bills.ts`)
30. B `markPaid(…, 'venmo')` → A's `fetchSettleData` row shows `method: 'venmo'`; `markAt` equals the stored `settled_at`; `created` true.
31. A `markNotReceived(B, A, cents, at)` → B's `fetchBill` shows no mark and `notReceived`; C → `not_allowed`; D (not payer) → `not_allowed`.
32. B marks again with `cash` → `notReceived` gone.
33. A's `listMyBills` returns `seenAt`. After B marks, `sentFacts` for A lists B; after A's `markBillSeen`, it doesn't.
34. A method outside the list is refused locally **and** by the DB when sent raw via `rpc` (`invalid_method`).
35. `settleDifference(…, 'venmo')` on a cash mark leaves `other`.
36. No request URL in the run contains `select=*`.
57. **(A1)** A raw 3-arg `mark_paid` rpc → `PGRST202`; a second client's `markPaid` on the same mark → `created: false`; `markNotReceived` with a stale `expectedAt` → `mark_changed`; after `set_payer` (A → D → A), B's `notReceived` is null; `seenAt` advances after `markBillSeen`.

### Screens and native (Tasks 8, 9a, 9b, 12; router tests on web **and** native)
37. Native Pay (Venmo): call order (spied) `markPaid('venmo')` → `scheduleSentCheck` (60 s, D3 content) → `openPaymentLink`. `created = false` → no schedule, no open, Banner `You've already marked this. Check below.` `payer_changed` → no open, error shown. Timeout → open, no schedule, card `Did you send Hana $15.10?`. Open failure → `unmarkPaid` + cancel + open-failed line. "More" → open before `settleDifference`, never schedules.
38. Web Pay: `openPaymentLinkWeb` is the first call in the handler. Mobile + open → `markPaid('venmo')`; desktop → contract O and no write until "Yes, I sent it"; null → no write and `Couldn't open Venmo. Send $15.10 to @hana-1 in the Venmo app, then tap Paid another way.`
39. Cash: `I paid Hana $15.10 in cash` calls `markPaid('cash')`, opens and schedules nothing; card reads `You paid Hana / $15.10 / Paid in cash` + `You're all set. Hana can see it.` + `Undo`. **(A1)** The bill footer with Cash remembered shows the `cash` footer on a ready plan and does the same; on an early plan it shows `Settle up`.
40. After a venmo send: `You sent Hana / $15.10 / Sent via Venmo` + `Did it go through?`. Yes hides it, writes nothing, shows the completion line. No, undo re-reads and calls `unmarkPaid` once. Navigating away stores `'shown'`; returning doesn't show it. Background → active cancels and dismisses pending check-ins and keeps the question. Answering in the footer hides the card's question too.
41. A response for another user, malformed data, or while signed out does nothing. "No, undo" for the signed-in user pushes `/bills/<id>/settle` and applies the undo rule; "Yes" never navigates. Warm start: handled. Cold start: handled when the gate says `'none'`, dropped when `'signed_in'` (or, under the fallback, always dropped; the report says which). The same response twice is handled once.
42. Payer's row: `Not received` (TextLink) → inline confirm → `markNotReceived(userId, payerId, cents, at)` from the row; no `Undo` on payer rows. Sam's card then shows `Hana hasn't received your $15.10. Check Venmo before paying again.` **(A1)** and his bill footer shows primary `Settle up` with the warning caption, never Pay.
43. **(A1)** On the bill and Settle screens, `markBillSeen` runs after each new data version while focused (debounced; fake timers) and once on blur, on web and native, for every route in (Home, deep link, invite resume, notification).
44. Permission: the first Venmo Pay with `ios.status` 0 requests (alert + sound) before the write; a second Pay doesn't ask; denied → no schedule, inline still shown. The note shows only while undetermined, native only.
45. `grep -rln "from 'expo-notifications'" app components lib` matches only `lib/checkInNotifications.native.ts` (Grep tool 2026-11-26: no files match today). The `test-utils/jestSetup.ts` stand-in rejects when a test forgets its mock.
46. **No web bundle contains `expo-notifications` code:** fresh `npm run export:web` into the scratchpad, searched with a positive-control marker string first counted in the real package file (verify the marker; reword if the package differs).
47. `npm run typecheck` and `npm test -- --maxWorkers=4` pass (failures only in other sessions' files reported as such, including splitit-app-96's builder until they add `seenAt`).
53. **(A1)** `__tests__/appConfig.test.ts`: the iOS entitlements from introspection have no `aps-environment`, on the plain config and with `APPLE_TEAM_ID` set (still has `associated-domains`); `app.json` lists `./plugins/withoutPushEntitlement` before `expo-notifications`; existing cases pass unchanged. In a scratch copy, `npx expo prebuild --platform ios --no-install` leaves no `aps-environment` in the entitlements file.
54. **(A1)** Primitives: `SegmentedControl` default semantics unchanged (`button` + `selected`); with `semantics: 'radio'` the track is a `radiogroup` with the label and segments are `radio` with `checked`; `disabled` blocks presses and sets `accessibilityState.disabled`. `Button flush` `true` unchanged, `'start'`/`'end'` align and keep a 44 × 44 box. `TextLink` `disabled` blocks presses, `loading` shows the indicator, width ≥ 44.
55. **(A1)** `package.json`'s `scripts` block is byte-identical before and after Task 8 (compare to the copy taken at Task 8's start); only `dependencies` gains `expo-notifications`.
56. **(A1)** `grep -rn "getDevicePushTokenAsync\|getExpoPushTokenAsync" app components lib` matches nothing (Grep tool 2026-11-26: matches nothing today).

### Docs (Task 11)
48. Every bullet of Task 11 is done or reported skipped with a reason. The SV / SV-UX / SV-VIS / SV-ENG rows match this spec.

### User checks (for the user; QA verifies everything around them)
- **U1 Real iPhone notification** *(blocked until the phone can reach a Supabase with this migration: hosted after DB push + web deploy, or the Mac's LAN IP plus matching OAuth redirect URLs)*. On a new dev build signed with the Personal Team: (a) the build installs (R1). (b) Sign in as Sam on a bill Hana pays, Venmo selected, tap Pay; iOS asks for notifications: Allow. (c) Venmo opens with $15.10; **don't send**. (d) Stay in Venmo over a minute: "Did your $15.10 to Hana go through?" appears, with no sound. Long-press: Yes and "No, undo". (e) Tap "No, undo": SplitIt opens on Settle up and the mark is gone. (f) Repeat, return within 30 s: no notification later; the card shows "Did it go through?". (g) With Show Previews "When Unlocked", the locked screen shows "Check your SplitIt payment". (h) Fresh install, Deny: no notification ever; the inline question still shows. (i) Kill SplitIt, wait for the notification, tap "No, undo": SplitIt opens (record whether it reaches Settle up, which depends on the resume gate).
- **U2 Venmo app:** Cash selected → nothing opens. Venmo selected → Venmo opens to Hana with the right amount and note, and "Sent via Venmo" is already there when you switch back. Bill screen with Cash remembered: the footer button is "I paid Hana $15.10 in cash".
- **U3 Web, two Google accounts** (local stack): desktop Chrome as Sam → a Venmo tab opens and the card asks "Did you send Hana $15.10?". Popup blocker on → no mark, the "Couldn't open Venmo…" line. iPhone Safari and (if available) Android Chrome on the Mac's LAN IP → record whether the card shows "Sent via Venmo" or asks (`w.closed` behaviour). As Hana with two owers, after one pays: Home shows "Sam sent you $15.10" under **Owed to you**. Open the bill and go back: it's gone. After the last ower pays: the bill is under **Settled** with "Settled up" (and Activity says "Sam sent you $15.10 via Venmo"). As Sam after paying in full: the bill isn't on his Home (hidden). Not received → confirm → Sam's card and footer warn him, and the bill comes back on his Home under Waiting on you with "Not received · $15.10". As a guest who claimed on an even-split bill still being claimed: "Claimed · waiting on others".
- **U4 VoiceOver:** chooser (radio group "How you're paying"), the inline question, the Not received link and confirm.

---

## Risks / open questions

**Needs your look** (none blocks the build; each has a recommendation):
1. **R1 Personal Team and push.** Stripping `aps-environment` should let the free team sign (source reading), but only a device build proves it. If it fails: (b) paid Apple Developer, $99/yr, your call; or (c) ship inline-only. Recommended: try (a) first in Task 8.
2. **SV-UX-14 wording departure.** The payer finish reads "Everyone's settled up. Nice." instead of your "Everyone's paid. Nice.", because Venmo sends are "sent", not known to be paid. Alternative: your wording as given.
3. **SV-ENG-13 web.** Desktop web always asks on return; mobile web auto-marks only if the tab is still open after ~300 ms. Alternative: always ask on web (simplest, never wrong) or always auto-mark (can say "Sent" when nothing could pay).
4. **SV-10 changes Q4.** The payer's Undo becomes Not received.
5. **SV-27 lock-screen text** shows the payer's name and amount; hidden-preview users get "Check your SplitIt payment" (SV-UX-6).
6. **SV-2 / SV-ENG-23** old signatures dropped: DB push and web deploy together.
7. **Money: honor system, wider.** "Sent via Venmo" counts toward Settled up without anyone tapping. The check-in and Not received are the safety net (your decision 1).
8. **Resume gate (F10)** depends on the scan-pipeline session. Without it, a "No, undo" from a killed app only opens SplitIt.

**Other risks:**
- R2: iOS may suspend the app during the ~0.5 s write if Sam switches away by hand. Contract O covers it on return.
- R3: `useFocusEffect` cleanup is assumed not to run on app background (verify in T9a). If it does, store `'shown'` only for "rendered while active, then blurred".
- R4: Android unverified (channel, runtime permission, inexact alarm drift, action buttons).
- R5: Focus / Do Not Disturb is the OS's; ignoring is fine.
- R6: A killed-app "Yes" may arrive later as the last response; it's non-navigating and idempotent.
- R7: groups v2 and this slice both touch `lib/homeSections*` (their files; our pre-approved lines). The main session sequences Task 3's `seenAt` line and Task 7's `waiting_on_others` lines against their Task 1, one session in those files at a time.
- R8: The Groups slice's `bill_participants` triggers and this migration touch the same table; the main session orders them and both pgTAP suites run together.
