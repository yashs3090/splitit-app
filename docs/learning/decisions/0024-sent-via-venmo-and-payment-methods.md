# 0024: Opening Venmo counts as sent; how you paid; "Not received"; a local check-in

**Status:** Accepted (2026-11-27, spec `docs/specs/2026-11-26-sent-via-venmo.md` and its Amendment A1; built, reviewed and QA'd on web 2026-11-27). Amends [0015](0015-settling-one-payer-self-reported-marks.md) §2 ("opening the Venmo link never marks anything") and [0021](0021-settling-early-and-paying-differences.md) §6 (the "Did you pay?" prompt is now only the fallback). Several decisions are still waiting for the user's look in `docs/decisions-to-review.md` (SV-2, SV-10, SV-27, SV-ENG-13, SV-ENG-23, SV-ENG-28, SV-R-1). Device checks U1–U4 haven't been run (`docs/before-production.md` §7).

*Numbering note:* the spec says the main session would reserve a number with a stub in this folder. No stub was there when the docs task ran (2026-11-27): 0022 (Groups) and 0023 (several payers) were reserved by other specs. So this is 0024, the next free number in this folder and in `README.md`. A note in the spec records it.

## Context
Under 0015 and 0021, paying went like this. Sam taps **Pay Hana $15.10 on Venmo**. Venmo opens. He pays there, comes back to SplitIt, and the card asks "Did you pay Hana?". He taps **I paid**. Only then does Hana see "Paid".

The user found two problems with that:
- **People forget the last step.** Sam pays in Venmo and never comes back to tap "I paid". Hana keeps seeing "Not yet" for money she already has.
- **Cash and other apps had one vague button.** "I already paid" didn't say how.

The user's decisions (2026-11-26): opening Venmo should count as sent; a check-in a minute later asks whether it went through; the payer can say "Not received"; the person picks how they paid (Venmo, Cash, or Paid another way). The app must still never say something untrue about money.

## Options
| Question | Options considered | Chosen |
|---|---|---|
| When is a Venmo payment recorded? | Only on "I paid" (0015); **when the Pay tap opens Venmo**; when Venmo confirms (impossible: no API) | When Pay opens Venmo, on phones and mobile web. Desktop web asks on return |
| What does the record say? | "Paid"; "Confirmed"; **"Sent via Venmo"** | "Sent via Venmo". The app only knows Venmo opened |
| How to catch a payment that didn't go through | Nothing; a push from a server; **a local notification on Sam's phone plus an inline question** | Local notification after 60 s, cancelled if Sam comes back first; the same question inline |
| How the payer says "I didn't get it" | Undo (silent); **"Not received"**, which tells Sam | "Not received" replaces the payer's Undo (SV-10) |
| How you paid | Free text; **a fixed list** (`venmo`, `cash`, `other`) | Fixed list, one copy in SQL and one in `lib/`, checked against each other by a test |
| Where the remembered choice lives | A `profiles` column; **on the device** | On the device. A column would be readable by everyone on your bills |

## Decision

### 1. Opening Venmo counts as sent (amends 0015 §2)
On a phone, one Pay tap does three things, in this order (spec D2, `useVenmoSend` in `lib/useVenmoSend.ts`):
1. **Record** the mark: `mark_paid(bill, payer, 1510, 'venmo')`, with a 4-second limit (`MARK_BEFORE_OPEN_TIMEOUT_MS`).
2. **Schedule** the check-in notification (1-second limit), only if this call created the mark and notifications are allowed.
3. **Open** Venmo.

Why this order: once Venmo is in front, iOS can pause SplitIt's JavaScript within seconds. Anything left for after the open may never run (SV-ENG-2).

**Venmo opens only if this tap created the mark.** `mark_paid` now returns `(settled_at, created)`. If `created` is false, the person was already marked (a stale screen, a second phone, a double tap). Then Venmo doesn't open, and the card says "You've already marked this. Check below." Without this, a stale screen could open Venmo for a second payment (SV-ENG-3).

What can go wrong, and what happens:

| The record step | Venmo | Sam sees |
|---|---|---|
| Created | opens | "Sent via Venmo" is already on the card behind Venmo |
| Already marked (`created = false`) | doesn't open | "You've already marked this. Check below." |
| Refused (payer changed, bill not ready…) | doesn't open | the matching error, and a refetch |
| Network error or timeout (outcome unknown) | opens anyway | "Did you send Hana $15.10?" on return (contract O, below) |
| Venmo fails to open after a created mark | — | the mark is undone, and "Couldn't open Venmo…" |

**On the web it depends on the device** (SV-ENG-13):
- The Venmo tab is opened first, synchronously, inside the tap (`openPaymentLinkWeb` in `lib/paylinks.ts`), because browsers block popups opened after an `await`. A blocked popup records nothing.
- **Mobile web:** wait 300 ms (`WEB_OPEN_CHECK_MS`), then record only if the tab is still open. If Venmo's app took over and the tab closed, ask on return instead.
- **Desktop web:** never record by itself. A venmo.com tab on a computer may not be able to pay, so "Sent" would often be untrue. It asks "Did you send Hana $15.10?" on return.

**After Venmo has opened, a refusal must stop a second payment** (review R1, the blocking finding). On web, and for every "more" send, Venmo opens before the write. If the write is then refused, or finds the person already marked, Venmo is still open and pre-filled. So the app closes the tab it opened (web), and shows a line that starts "Venmo opened, but …" and says "Don't send it", for example: "Venmo opened, but this was already marked. Don't send it. Check Venmo before you pay again." (`afterOpenRefusal` in `lib/settleView.ts`, SV-R-1, SV-R-2).

**Words.** The app says "Sent", never "Paid" or "Confirmed", for a Venmo mark. It still counts toward "Settled up", because the user decided so (decision 1). The payer's finish reads "Everyone's settled up. Nice." (SV-ENG-28, waiting for the user's look).

### 2. The "Did you send…?" prompt is now the fallback (amends 0021 §6)
0021 §6's prompt ("Did you pay Hana?", now worded "Did you send Hana $15.10?" with **Yes, I sent it**) stays, with the same rule: it follows the payer and the mark, not the amount. But it now shows only when the app can't know: the write's outcome is unknown, the browser is a desktop one, or a mobile tab closed. "Yes, I sent it" records with method `venmo` and counts as answering the check-in, so the check-in never follows it.

### 3. How you paid: Venmo, Cash, or Paid another way
Each mark now stores a method, `bill_participants.settled_method`: `venmo`, `cash` or `other`. Existing marks became `other`.

| Method | Sam taps | Card and row say |
|---|---|---|
| `venmo` | Pay Hana $15.10 on Venmo | Sent via Venmo |
| `cash` | I paid Hana $15.10 in cash (nothing opens) | Paid in cash |
| `other` | Paid another way | Marked paid / Paid |

- **One list, written twice and checked.** In SQL, `private.is_payment_method(text)` is the only place the list is spelled out; both check constraints and both functions call it. In the app it's `PAYMENT_METHODS` in `lib/paymentMethods.ts`. `lib/paymentMethods.test.ts` reads the newest migration that defines the SQL function and fails if the lists differ. Adding Zelle later is one migration plus one line in `lib/`.
- **The choice is remembered on the device**, per user (`splitit.payMethod.v1.<userId>`), Venmo or Cash only. Default: the remembered one, else Venmo if the payer has a username, else Cash.
- **Mixed history:** paying more with the same method keeps it; a different method makes it `other` (SV-4). A pay-back leaves it unchanged.
- **Methods are self-reported**, like the mark itself. A direct API caller may set any known method on their own mark.

### 4. "Not received" (replaces the payer's Undo)
Hana, the payer, sees **Not received** on each marked row instead of Undo (SV-10). After an inline confirm ("Didn't get Sam's $15.10? This clears it and lets Sam know."), it:
- clears Sam's mark and stores a flag: `not_received_cents`, `not_received_method`, `not_received_by` (all three or none);
- shows Sam a warning on his card ("Hana hasn't received your $15.10. Check Venmo before paying again."), a warning footer, and a Home pill `Not received · $15.10` in Waiting on you;
- logs `not_received` in Activity.

The database function is `mark_not_received(bill, user, payer, expected_cents, expected_at)`. The two "expected" values are a stale-state token: the exact mark the payer's screen showed. Passing the time as well as the amount means an old tap can't clear a newer send of the same amount (SV-ENG-5; [stale-state checks](../concepts/stale-state-checks.md)). Sam marking again clears the flag. So does changing the payer (SV-ENG-14).

Other people's Undo is unchanged: Sam's own, and a host who isn't the payer.

### 5. A local check-in, no push
One minute after Venmo opens for a share, Sam's phone shows "Did your $15.10 to Hana go through?" with **Yes** and **No, undo**. If he comes back to SplitIt first, it's cancelled and the same question shows inline on his card, once, for up to 30 minutes. "No, undo" re-reads the bill and clears the mark only if it's still exactly that send (one undo rule, `undoDecision` in `lib/sentCheck.ts`, used by the card, the footer and the notification). "More" sends get no check-in (SV-ENG-4).

It's a **local** notification: the phone schedules it for itself. No server, no push service, no paid Apple account. Hana gets no notification; her Home row shows "Sam sent you $15.10" while someone still owes her (in-app only). Details: [local notifications](../concepts/local-notifications.md).

**The plugin-order rule** (`app.json` can't hold comments, so it's recorded here). `expo-notifications` always adds the iOS push entitlement (`aps-environment`), and the free Personal Team can't sign it. `plugins/withoutPushEntitlement.js` deletes it. In `app.json`'s `plugins` array it **must be listed before `"expo-notifications"`**, because Expo runs the mods of later plugins first, so the plugin listed earlier runs last and removes the key after it was added. `__tests__/appConfig.test.ts` fails if the order is reversed or the key is back. If remote push is ever added, delete the plugin.

## How this relates to 0015 and 0021
| Earlier ADR said | 0024 says |
|---|---|
| 0015 §2: opening the Venmo link never marks anything; only "I paid" does | On phones and mobile web, the Pay tap that opens Venmo records "Sent via Venmo". Desktop web still asks |
| 0015 §2: a mark is `settled_at` + `settled_cents` | A mark also stores `settled_method` (`venmo` / `cash` / `other`) |
| 0015 §2 / Q4: the payer can undo anyone's mark | In the app, the payer gets "Not received" instead, which tells the person. The database still lets the payer call `unmark_paid` directly (SV-26) |
| 0015 §2: marking again is a silent no-op | Still a no-op, but `mark_paid` now says so (`created = false`), and the app won't open Venmo |
| 0021 §6: after Pay, the card asks "Did you pay Hana?" | That prompt is the fallback when the app can't know (unknown outcome, desktop web, closed mobile tab) |
| (none) | A local check-in notification and an inline question one minute later |

So 0015 and 0021 are amended, not superseded: one payer, self-reported marks, net amounts and differences all stand.

## Consequences
- **The honor system got wider.** "Sent via Venmo" counts toward Settled up without anyone tapping anything. The check-in and Not received are the safety net. A Venmo the person closed without paying stays "Sent" until someone says otherwise.
- **Old function signatures are gone.** `mark_paid(uuid, uuid, integer)` and the 5-argument `settle_difference` were dropped. An older web build can't mark against the new database, so `npx supabase db push` and the web deploy must happen in the same sitting (SV-2, SV-ENG-23).
- **No client role can write `bill_participants`, even `service_role`.** The new check constraints call `private.is_payment_method`, which only the owner may execute (review R7; [database functions](../concepts/database-functions.md)).
- **A new native module means a new development build** (`npx expo run:ios --device`). Whether the free team signs it with the entitlement removed is only proven on a device (U1).
- **Ready for several payers** ([0023](0023-several-payers.md)): every mark, flag and device key names both sides (`toUserId`, `p_payer_id`, `payer_id` in event details).
- Timing values are starting values (`docs/before-production.md` §7).
- **Reused by Groups (2026-11-27).** Group payments use the same `private.is_payment_method` check and the same send flow, minus the local check-in (decision GR-P2). See [0022 Groups](0022-groups.md).

## Amendment, 2026-11-27: the Who paid ledger
The decisions above still stand. What changed is where marks live and some function signatures. Who paid ([0023](0023-several-payers.md); spec `docs/specs/2026-11-26-who-paid.md`, Amendments A1 and A2) moved marks off `bill_participants`:
- Each mark is now a `bill_payments` entry, and "Not received" is a `bill_payment_flags` row. The `settled_*` and `not_received_*` columns were dropped (migrations `20261127140000`–`140002`). Entries are never updated, only added or deleted.
- New signatures:
  - `mark_paid` and `settle_difference` take an optional `p_plan_key` (old calls without it still work);
  - `unmark_paid(bill, user, to_user)` now takes 3 arguments;
  - `set_payer(bill, payer)` takes 2.
- The R7 point now covers the new tables: no client role, including `service_role`, may insert, update or delete payment entries.
- The method check (`private.is_payment_method`) and the send flow are unchanged.
- Hosted push order: Sent via Venmo, then Groups, then Who paid, each in the same sitting as its app deploy (`docs/before-production.md`).

The Code list below describes the code as it was when this ADR was written.

## Code (by name, since line numbers move)
- Database: `supabase/migrations/20261126080844_sent_via_venmo.sql` (`private.is_payment_method`, the new columns and checks, `mark_paid`, `settle_difference`, `mark_not_received`, `my_bills` with `seen_at`). Tests: `supabase/tests/database/sent_via_venmo.test.sql` (M1–M18, N1–N16), `participants_check_execute.test.sql` (R7).
- Methods: `PAYMENT_METHODS`, `availableMethods`, `isRememberedMethod` in `lib/paymentMethods.ts` (drift test in `lib/paymentMethods.test.ts`).
- Data layer: `markPaid`, `settleDifference`, `markNotReceived` in `lib/bills.ts`.
- The send: `useVenmoSend` in `lib/useVenmoSend.ts`; `openPaymentLinkWeb`, `webOpenOutcome`, `closeOpenedTab` in `lib/paylinks.ts`; `isMobileWeb` in `lib/webEnv.ts`.
- Check-in rules: `sentCheckInline`, `undoDecision`, `sentCheckNotification`, `parseSentCheckData` in `lib/sentCheck.ts`; `runSentCheckUndo` in `lib/sentCheckUndo.ts`; `lib/resumeGate.ts`.
- Notifications: `lib/checkInNotifications.native.ts` (the only file that imports `expo-notifications`), `lib/checkInNotifications.ts` (web, does nothing), `components/SentCheckResponder.tsx`, `plugins/withoutPushEntitlement.js`.
- Screens' logic: `afterOpenRefusal` and the card, row and footer builders in `lib/settleView.ts`; Home pills `sent`, `not_received`, `waiting_on_others` in `lib/homeMarkers.ts`; Activity sentences in `lib/activityText.ts`.

Concept notes: [local notifications](../concepts/local-notifications.md), [stale-state checks](../concepts/stale-state-checks.md), [database functions](../concepts/database-functions.md), [in-app notices](../concepts/in-app-notices.md), [row level security](../concepts/row-level-security.md).
