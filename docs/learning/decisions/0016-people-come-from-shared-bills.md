# 0016: People come from shared bills; the host adds only linked people

**Status:** Accepted (2026-11-24, spec `docs/specs/2026-11-24-people-and-invites.md`; user decisions 1–7 of 2026-11-24; PM decisions PI-1 to PI-19 and the later PI-N, PI-R entries in `docs/decisions-to-review.md`).

## Context
Hana splits dinner with the same three friends every Friday. Until now, each week she had to send a new link, and each friend had to open it. The user wanted two things:
1. A list of "people you've split with", so Hana can put Sam straight onto tonight's bill in two taps.
2. A way to text the bill link to a friend who isn't on SplitIt yet, picked from the phone's contacts.

That raises questions that are hard to change once real people rely on the answers:
- **Where does the list come from?** A friends table with requests, or something worked out from bills?
- **Who counts as "someone you've split with"?** If being added to a bill counted, the list would grow without the person ever choosing anything.
- **Who can Hana add?** Anyone with an account, or only people she already knows through SplitIt?
- **Can someone be taken off a bill, or leave it,** without changing what anyone else owes?
- **What happens to the phone's contacts?**

The user fixed the big answers on 2026-11-24 (spec "User decisions"). The PM decided the details under the "don't block" rule, and the review added two fixes (R1, R6).

## Options
| Question | Options considered | Chosen |
|---|---|---|
| Where the list comes from | A friends table with friend requests; **worked out from past bills** | From past bills. No friend requests (user decision 1, 7) |
| Which bills count (rule L1) | (A) any bill you're both on; (B) the added person taps "Accept"; **(C) a bill counts once both people took part** | (C). Hosting, joining with the link, or claiming something counts. Being added alone doesn't (PI-1) |
| Who the host can add | Anyone with an account; **only people linked to the host by L1** | Linked people only, checked in the database (user decision 4) |
| Taking someone off a bill (rule L3) | Remove anyone, dropping their claims; no remove at all; **remove only someone whose removal changes no money** | Only when they have no claims, no "I paid" mark and aren't the payer (PI-4, PI-5) |
| Contacts | Upload or sync contacts to find friends; **pick one contact on the phone, nothing leaves it** | On the device only (user decision 5) |

## Decision

### 1. The list is worked out from bills, not stored
There is no friends table. `people_i_split_with()` works out your list each time from the rows that already exist: `bill_participants` and `claims`. So there's nothing to keep in sync, nothing to delete when someone leaves a bill, and no friend request to send or accept.

### 2. Rule L1: being added doesn't link you; joining or claiming does
A participant row is **active** when:
- `added = false` (you're the host, or you joined with the link), **or**
- you have at least one claim on that bill.

Two people are **linked through a bill** when both have an active row on it. Their "bills together" count is the number of such bills.

Why being added isn't enough: Hana adds Sam to her bill. Cy is also on that bill. If Sam's row counted straight away, Cy could now add Sam to *Cy's* bills, though Sam never chose to split anything with Cy. Once Sam claims an item on Hana's bill, he has taken part, and the bill counts.

**R6 (review, decision PI-R-1):** if Sam was added and later opens the bill's link anyway, that counts as joining. `join_bill` flips his row to `added = false` and logs a `joined` event. So "added" can change once, from true to false, and only through `join_bill`.

The rule lives in exactly one SQL function, `private.my_links()`. The app never re-implements it; `lib/people.ts` only reads the result. Because it's computed from current rows, unclaiming everything or leaving a bill can unlink people again (spec P6, P9).

### 3. No friend requests
Joining a bill or claiming on it is already a clear "I was there". A request-and-accept step would be a second, weaker version of the same signal, with its own screens and its own way to spam people. Real friend requests are deferred (user decision 7).

### 4. The host can add only linked people, and `not_linked` hides whether a user exists
`add_participant(bill, user)` checks, in order:
1. You're signed in and you host this bill. Otherwise `42501 not_allowed`.
2. The person is already on the bill: nothing happens, no error.
3. You and the person aren't linked (L1): `22023 not_linked`.

The same `not_linked` comes back for a real user you aren't linked with **and** for a random id that isn't a user at all. So the function can't be used to test "does this account exist?". The [row level security](../concepts/row-level-security.md#not_linked-a-privacy-story-2026-11-24) note tells this as a privacy story.

### 5. Rule L3: remove and leave never change anyone's money
`removable(bill, person)` is true only when the person:
- is on the bill,
- isn't the host,
- isn't the payer,
- has no claims on the bill,
- has no "I paid" mark.

The host's `remove_participant` and the person's own `leave_bill` both require it. Since nobody with a claim, a mark or the payer role can disappear, no share is ever recalculated by a remove or a leave. Someone who has claimed can unclaim first and then leave. The rule lives once in SQL (`private.is_removable`) and is mirrored in `lib/membership.ts` only to decide which buttons to show.

A claim made at the very moment of a remove is handled by locks: either the remove sees the claim and refuses, or the claim fails cleanly. See [database functions](../concepts/database-functions.md#one-lock-order-for-every-bill-the-people-review-fix-r1-2026-11-24).

### 6. Contacts stay on the device
"From contacts" opens the phone's own contact picker. SplitIt reads only the picked contact's phone numbers and their labels, keeps them in the screen's memory while you choose how to send, and drops them on send, cancel, leaving the screen or sign-out. Nothing about contacts is stored, logged, sent to Supabase or put in the message. The message is the same text as Share…: "Claim what you had on SplitIt: <link>".

**Permission (decision PI-N-1, changes PI-19).** The plan was to ask for no permission at all. Reading the installed `expo-contacts` 57.0.9 showed that isn't possible: `Contact.presentPicker()` needs no permission, but it returns only the contact's id, and reading the numbers goes back to the contacts store, which does need access. So:
- The app asks for contacts access **when "From contacts" is tapped**, never at launch.
- **Read only.** On Android, `WRITE_CONTACTS` is blocked in `app.json` (`android.blockedPermissions`), so the app asks only for `READ_CONTACTS`.
- On iOS, the purpose string shown in the prompt is set in `app.json`: "SplitIt opens your contacts only when you pick someone to text a bill link to. Your contacts stay on your phone."

### 7. Native contact and SMS code never reaches the web bundle
Browsers have no contacts picker we'd use, so web has no "From contacts". `lib/contactPicker.native.ts` is the only file that imports `expo-contacts` and `expo-sms`. `lib/contactPicker.ts` is the web (and default) version, with no such import and `contactsSupported = false`. The bundler picks the right file per platform. See [platform-specific files](../concepts/platform-specific-files.md).

## Consequences
- **Good:** no friends table, no requests, nothing to keep in sync. The list can't go stale, because it's always worked out from current rows.
- **Good:** nobody ends up on strangers' lists just because someone added them to a bill.
- **Good:** remove and leave are safe to offer without a confirm about money, because they never change a share.
- **Cost:** a stranger who joins with a leaked link becomes linked to the host, and can then add the host to their own bills. Today's defence is leaving those bills. A real block ("don't let this person add me") is deferred and tracked in `docs/before-production.md` §6.
- **Cost:** being added sends no notice (there are no push notifications yet). The added person finds the bill next time Home loads.
  - *Note (2026-11-24):* softened by the bill markers slice (`docs/specs/2026-11-24-bill-markers-and-notices.md`): an added person now sees a dismissible "added you to a bill" card and a "New" pill on Home. Still no push notifications, and nothing arrives live while Home is open (see [in-app notices](../concepts/in-app-notices.md)).
- **Cost:** Activity says "Hana removed someone" and "Someone left", because once a person is off the bill the app can't read their name (PI-17). Keeping names would mean storing a name snapshot in events, which goes against the audit log's "ids only" rule.
- **Cost:** contacts permission is a bigger ask than "pick one contact". The store privacy forms must say contacts are accessed on the device (`docs/before-production.md` §6).
- **Dependency:** texted links are `splitit://b/<code>` on native today. A friend without the app can't open one. Invite from contacts becomes useful to real friends once links are https (the friend-test deploy, `docs/before-production.md` §5).

Code:
- `added` column, L1, `people_i_split_with`, `add_participant`: `supabase/migrations/20261124091041_people.sql` (`my_links` `:71-101`, `people_i_split_with` `:111-142`, `add_participant` `:159-205`). Tests: `supabase/tests/database/people.test.sql` (same `not_linked` for a real and a made-up id at `:341-344`).
- L3, `remove_participant`, `leave_bill`, delete broadcast: `supabase/migrations/20261124091042_membership.sql` (`is_removable` `:43-63`, `remove_participant` `:74-116`, broadcast trigger `:177-181`). Tests: `supabase/tests/database/membership.test.sql`.
- Review fixes (lock order, R6 flip, `leave_bill` checks before locking): `supabase/migrations/20261124094656_people_review_fixes.sql` (`join_bill` flip `:343-349`, `leave_bill` `:372-420`). Tests: `supabase/tests/database/people_review_fixes.test.sql`.
- App: `listPeople` (`lib/people.ts:143`), `addParticipant` / `removeParticipant` / `leaveBill` (`lib/bills.ts:474-498`), `canRemove` / `canLeave` (`lib/membership.ts:22`, `:27`).
- Contacts: `lib/contactPicker.native.ts`, `lib/contactPicker.ts`, `components/ContactInvite.tsx`, shown only when `contactsSupported` (`components/SharePanel.tsx:108`). Permission settings: `app.json:23-25` and `:56-61`.

Concept notes: [database functions](../concepts/database-functions.md), [row level security](../concepts/row-level-security.md), [realtime](../concepts/realtime.md), [platform-specific files](../concepts/platform-specific-files.md).
