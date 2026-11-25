# People you've split with + Invite from contacts

Date: 2026-11-24. Milestones: "People you've split with (M)" and "Invite from contacts (S)" in `docs/plans/bill-splitting-app-2026-11-19.md` (user decisions of 2026-11-24; F-1 to F-3 in `docs/decisions-to-review.md`).
Repo: `splitit-app` only (ADR 0011). Database changes go in `supabase/migrations/` and `supabase/tests/database/`. **The main session assigns migration timestamps and any ADR number** (lessons log, parallel-work rule).
Depends on M3 (`supabase/migrations/20261124081411_settle_payer.sql`, `20261124081412_settle_marks.sql`, `lib/settle.ts`). Both are on disk.

The user asked that building continue without stopping. Every product and UX choice below was made by the PM and is logged as **PI-1 to PI-19** under "Added while building" in `docs/decisions-to-review.md`. Nothing in this spec waits on the user.

## Providers, accounts and costs

| Service / account | Needed for | Setup cost |
|---|---|---|
| Supabase (local stack, already set up) | 1 column, 3 functions + 1 reader, 1 broadcast trigger, 3 event kinds | $0 |
| Google sign-in + a second and third test account (2 exist from M2 step U1; a third is needed for the "not linked through someone else's bill" check, U2) | multi-account checks on web | $0. Add the third Google account as a test user in Google Cloud Console (same as M2 U1) |
| `expo-contacts` and `expo-sms` (Expo SDK packages) | picking a contact; opening the Messages composer | $0. **Both are native modules, so the dev build has to be rebuilt** (`npx expo run:ios`) |
| Xcode 26.4+ and the iOS simulator (already used) | contact picker check (the simulator ships sample contacts) | $0 |
| iPhone with Messages and WhatsApp | User check U5 only. **Blocked** until the phone can reach a backend (see "Device checks") | $0 |
| WhatsApp | no account or API. We only open WhatsApp's public click-to-chat link | $0 |
| Paid Apple Developer / hosted Supabase / a domain | **Not needed for this slice.** Needed before a friend can actually open a texted link (Risk 1) | $0 now |

Nothing new to sign up for, except adding one more Google test user.

## Goal
1. A host who splits with the same friends every week adds them to tonight's bill in two taps (Add people → Add), without sending a link. The bill shows up in each friend's "Your bills", and they claim as usual.
2. A host whose friend isn't in the app yet picks them from the phone's contacts and sends the bill link by text or WhatsApp, without SplitIt ever seeing or keeping the contact.

## User decisions (2026-11-24, fixed)
1. The list of people comes from past bills. No friend requests.
2. Searchable, with the people you've split the most bills with at the top.
3. The host can add someone from the list straight onto a bill, even if they never opened its link. The bill then appears in that person's "Your bills" and they claim as usual.
4. You can only add someone you've already shared a bill with. The database enforces it.
5. Invite from contacts happens on the device only: pick a contact, then a text or WhatsApp message opens with the bill link filled in. Nothing about contacts is uploaded or synced.
6. The list shows on Profile, and as "Add people" on a bill (host).
7. Deferred: placeholder people added by name, and real friend requests.

## In scope
- DB: `bill_participants.added`; the "linked" rule (L1) defined once in SQL; `people_i_split_with()`; `add_participant`, `remove_participant`, `leave_bill` (security definer, ADR 0013); a broadcast when a participant row is deleted; 3 Activity kinds. pgTAP tests.
- `lib/people.ts` (parse, search, labels, who can still be added), `lib/membership.ts` (who can be removed or leave), wrappers in `lib/bills.ts`, Activity sentences.
- Profile: a "People you've split with" card.
- Bill: "Add people" (host) opening a new screen `/bills/[id]/people`; "Leave this bill" (guests, only when allowed).
- Invite card: "From contacts" on iOS and Android (any participant), with Messages and WhatsApp.
- Docs: a concept note, before-production items, the decisions log.

## Out of scope (cut)
- Placeholder people (by name, not on the app) and friend requests (user decision 7).
- Push notifications, e-mail or any other message telling someone they were added (no push yet; plan v1).
- Blocking someone, or hiding someone from your list ("don't let Hana add me"). Listed under Risks and in `docs/before-production.md`.
- Removing a participant who has claimed something or marked "I paid" (PI-4). Host tools for leftover items stay cut (M3 Q1).
- Adding several people in one call, or adding someone to a bill you don't host.
- Contact sync, contact upload, matching contacts to SplitIt users, reading the address book in the background.
- Contacts on web (browsers have no contacts API we'd use). The SMS `sms:` link on mobile web.
- A "New" badge for bills you were added to (PI-6).
- https invite links / universal links. `inviteUrl()` is used as it is today (Risk 1).

## Design

### D1. Data model (Task 1)

| Field | Shape | Meaning | Client access |
|---|---|---|---|
| `bill_participants.added` | `boolean not null default false` | `true` when the row was created by `add_participant`. Rows from `create_bill` (the host) and `join_bill` (the link) keep `false`. Never changes after insert | SELECT through the existing table-level grant (every participant can read it). No INSERT/UPDATE/DELETE for any client role |

- Restate the grants on `bill_participants` in the migration: `revoke all ... from anon, authenticated, public; grant select ... to authenticated`. No column of `bill_participants` is hidden from clients, so `select *` still works on it, but every client read in this slice names its columns anyway (lessons log, 2026-11-24).
- Existing rows get `false` (they all came from `create_bill` or `join_bill`).
- The app doesn't read `added` in this slice. It exists only for rule L1.

### D2. Shared contracts (defined once; DB and lib tasks point here)

**L1. "Linked": the people who count as "people you've split with".**
A participant row is **active** when `added = false` (the host, or someone who joined with the link), **or** that person has at least one `claims` row on that bill.
Two different users A and B are **linked through bill X** when both have an active row on X.
- `shared_bills(A, B)` = the number of bills A and B are linked through.
- `last_shared_at(A, B)` = the latest `bills.created_at` among those bills.
- A and B are **linked** when `shared_bills ≥ 1`.

Why: being added is not a choice the added person made. If being added counted, everyone on the bill could add that person to their own bills, although the person never chose to split with them. Once the person claims something, they have taken part, and the bill counts (PI-1). This is stricter than `private.shares_bill_with`, which still decides whose name and Venmo username you can read on a bill you share.

- In the DB: one SQL function holds the formula (suggested `private.my_links()` returning `(user_id, bill_id, bill_created_at)` for the caller). Both `people_i_split_with()` and `add_participant` use it, so the rule exists in exactly one function body. The supabase-engineer picks the exact shape and names it in the migration header.
- In the app: **not re-implemented.** `lib/` only reads `people_i_split_with()`. The app never decides who is linked.

Boundary cases (all in `supabase/tests/database/people.test.sql`). A, B, C and D are throwaway users. Y and X are bills hosted by A.

| # | Setup | Expected |
|---|---|---|
| P1 | B joins Y with the link | A sees B with `shared_bills 1`; B sees A with `shared_bills 1` |
| P2 | P1, then A adds B to X; B has no claims on X | A's row for B still says `shared_bills 1` (X doesn't count yet) |
| P3 | P2, then B claims one row on X | `shared_bills 2`; `last_shared_at` = X's `created_at` |
| P4 | C joins X with the link; B was added to X and has no claims there | C's list has no B, B's list has no C; C's `add_participant(<C's bill>, B)` fails `22023 not_linked` |
| P5 | P4, then B claims a row on X | C's list has B (`shared_bills 1`); C's `add_participant(<C's bill>, B)` succeeds |
| P6 | P5, then B unclaims everything on X | C's list loses B again (the rule is computed from current rows) |
| P7 | any | your own id is never in your list |
| P8 | D has no bills | D's list is empty (0 rows, no error) |
| P9 | P1, then B leaves Y (`leave_bill`) | A's list has no B (assuming no other bill) |

**L2. Ranking** (DB only; `lib/` must keep the order it receives and never re-sort):
`order by shared_bills desc, last_shared_at desc, lower(display_name) asc nulls last, user_id asc`, then `limit 200` (**starting value**; the engineer may change it with evidence, and records it in the migration header).

| # | Case | Expected order |
|---|---|---|
| R1 | Sam 3 bills, Ali 1 bill | Sam, Ali |
| R2 | both 2 bills; Ali's latest shared bill is newer | Ali, Sam |
| R3 | both 2 bills, same latest bill; names "sam" and "Ali" | Ali, sam (case-insensitive) |
| R4 | same as R3; one name null | the named one first, the null last |
| R5 | everything equal, including the name | lower `user_id` first |

**L3. Who can be removed, and who can leave** (enforced in the DB, mirrored in `lib/membership.ts` to decide which buttons show).
`removable(bill, T)` is true when **all** hold:
- T is a participant of the bill,
- T is not the host,
- T is not the payer (`bills.payer_id`),
- T has 0 `claims` rows on the bill,
- T has no "I paid" mark (`settled_at is null`).

- `remove_participant` (the host removes T) requires `removable(bill, T)`.
- `leave_bill` (T removes themself) requires `removable(bill, T)`.
- So neither ever changes anyone's money: nobody with a claim, a mark or the payer role disappears from a bill.

Boundary cases. `supabase/tests/database/membership.test.sql` and `lib/membership.test.ts` both test each one.

| # | Target | Remove (by host) | Leave (by target) |
|---|---|---|---|
| M1 | the host | `22023 cannot_remove`; lib `false` | `22023 cannot_leave`; lib `false` |
| M2 | the payer (not the host), 0 claims | `22023 cannot_remove`; lib `false` | `22023 cannot_leave`; lib `false` |
| M3 | added, 0 claims, no mark, not payer | removed; lib `true` | left; lib `true` |
| M4 | joined by link, 0 claims, no mark, not payer | removed; lib `true` | left; lib `true` |
| M5 | 1 claim (a one-unit item) | `cannot_remove`; lib `false` | `cannot_leave`; lib `false` |
| M6 | 1 claim on unit 2 of "Beer ×2" | `cannot_remove`; lib `false` | `cannot_leave`; lib `false` |
| M7 | 0 claims but a mark (*amended 2026-11-24, Task 5:* the app's DB accepts this through `mark_paid` once every item is claimed; only the screen hides the button. See decision PI-M-1) | `cannot_remove`; lib `false` | `cannot_leave`; lib `false` |
| M8 | not a participant | no-op, no event; lib `false` | `42501 not_allowed`; lib `false` |

**L4. Search** (lib only; `lib/people.ts`, `matchesQuery(name, query)`):
- Trim the query and cut it to 50 characters. An empty query matches everyone.
- Fold both sides: lower case, then Unicode NFD with combining marks removed (`José` ≡ `jose`).
- Split the query on whitespace. **Every** query word must be a prefix of **some** word in the name.
- A person with no display name matches only the empty query.
- Results keep the L2 order.

| # | Name | Query | Match? |
|---|---|---|---|
| S1 | Sam Lee | `sa` | yes |
| S2 | Sam Lee | `lee` | yes |
| S3 | Sam Lee | `am` | no (not a word start) |
| S4 | Sam Lee | `  SAM  ` | yes |
| S5 | José Ruiz | `jose` | yes |
| S6 | Jose Ruiz | `josé` | yes |
| S7 | Sam Lee | `sam l` | yes |
| S8 | Sam Lee | `sam x` | no |
| S9 | (null) | `a` | no |
| S10 | (null) | `` | yes |

**L5. Contact invite message and links** (lib only; `lib/contactInvite.ts`):
- Text: `INVITE_MESSAGE_PREFIX + url`, where `INVITE_MESSAGE_PREFIX = 'Claim what you had on SplitIt: '`. It moves here from `components/SharePanel.tsx:14` (`SHARE_MESSAGE_PREFIX`), and SharePanel imports it, so Share… and contacts send the same words. `__tests__/shareAndJoin.test.tsx:125` keeps passing unchanged.
- The message never contains the contact's name or number, the bill's items or amounts.
- **Messages:** `SMS.sendSMSAsync([number], message)` from `expo-sms` with the number exactly as the contact has it.
- **WhatsApp:** `https://wa.me/<digits>?text=<encodeURIComponent(message)>` when the number is international (after trimming it starts with `+`, or with `00`, which is dropped). `<digits>` is the number with everything except `0-9` removed. Otherwise it's `https://wa.me/?text=<encoded>`, and the person picks the chat inside WhatsApp. Format source: WhatsApp's click-to-chat FAQ (https://whatsapp.com/faq/en/general/26000030). The direct-to-chat and message-only forms are documented there; **how they behave on each phone is unverified** (U5).

| # | Number | `whatsAppUrl` |
|---|---|---|
| W1 | `+1 (415) 555-0100` | `https://wa.me/14155550100?text=…` |
| W2 | `0044 20 7946 0000` | `https://wa.me/442079460000?text=…` |
| W3 | `(415) 555-0100` | `https://wa.me/?text=…` |
| W4 | `  +44 7700 900123 ` | `https://wa.me/447700900123?text=…` |
| W5 | `+` or empty | `https://wa.me/?text=…` |

- `phoneChoices(phones)`: drop entries with no digits, de-duplicate by digits (first one wins), keep the order. Use the `label` if it has one (`mobile`, `home`), else no label.

### D3. Database functions (Tasks 1 and 2)
All are `security definer set search_path = ''` with schema-qualified names. Each checks `auth.uid()` first. Execute is revoked from `public, anon, authenticated` and granted to `authenticated` only. Errors are a fixed SQLSTATE plus a fixed message (ADR 0013). A function that changes nothing logs nothing and broadcasts nothing.

| Function | Who may call | Behaviour | Errors |
|---|---|---|---|
| `public.people_i_split_with() returns table (user_id uuid, display_name text, venmo_username text, shared_bills integer, last_shared_at timestamptz)` | any signed-in user | The caller's linked people (L1), ranked and capped (L2). It takes no arguments, so it can only ever answer about the caller. `display_name` and `venmo_username` come from `profiles`. **Every row is a person the caller can already read through `profiles_select_own_or_co_participant`**, so the function reveals no profile the caller couldn't already select | signed out: `42501 not_allowed` |
| `public.add_participant(p_bill_id uuid, p_user_id uuid) returns void` | the host | Locks the bill row (`for share` or stronger). If `p_user_id` is already a participant (this includes the host's own id): no-op, checked first. If the caller and `p_user_id` aren't linked (L1), including an id that isn't a user: refuse. Otherwise it inserts `(bill_id, user_id, added = true)` and logs one `participant_added` | signed out, not the host, or no such bill: `42501 not_allowed`. Not linked: `22023 not_linked` (the same error whether the id exists or not) |
| `public.remove_participant(p_bill_id uuid, p_user_id uuid) returns void` | the host | Locks the bill row and the target's participant row (`for update`). If the target isn't a participant: no-op. If `removable` (L3) is false: refuse. Otherwise it deletes the row and logs one `participant_removed`. **A claim the target makes at the same moment must either make the removal refuse or fail cleanly itself (`23503`, which `set_claim` already maps to `not_found`). It is never silently deleted by the cascade.** The engineer says in the migration header which lock gives this (for example, `for update` on the participant row conflicts with the claim FK's `for key share`; *verify*) | signed out, not the host, or no such bill: `42501 not_allowed`. L3 false: `22023 cannot_remove` |
| `public.leave_bill(p_bill_id uuid) returns void` | a participant | The same locks as `remove_participant`, for the caller's own row. Refuses if `removable(bill, caller)` is false. Otherwise it deletes the row and logs one `left` | signed out, no such bill, or not a participant: `42501 not_allowed`. L3 false (including the host): `22023 cannot_leave` |

- Because L3 refuses the payer, the existing `private.bill_participants_reset_payer` trigger never fires from these functions. Its "an account was deleted" event stays specific to account deletion.
- Realtime: `add_participant` is covered by the existing `bill_participants_broadcast_insert`. Task 2 adds `bill_participants_broadcast_delete` (statement level, `referencing old table as old_rows`, the existing `private.broadcast_bill_change()`), so everyone else's bill screen refetches when someone leaves or is removed.

**Activity events** (only through `private.log_event`; `bill_events_kind_known` gains three kinds; ids only, no names):

| Kind | Actor | `details` | Sentence (`lib/activityText.ts`) |
|---|---|---|---|
| `participant_added` | the host | `{ user_id: uid }` | "Hana added Sam"; "Hana added you"; "You added Sam" |
| `participant_removed` | the host | `{ user_id: uid }` | "Hana removed Sam". Once Sam is off the bill, the app can't read Sam's name, so it reads "Hana removed someone" (PI-17) |
| `left` | the person | `{}` | "Sam left"; usually "Someone left", for the same reason |

Use the existing `objectName` / name helpers in `lib/activityText.ts` for "you" and "someone" in the middle of a sentence. Malformed details return `null`, like the other kinds.

### D4. Privacy

**What a stranger could learn.**
- *From the list:* only people they're linked with (L1). The function takes no input, and each row is a profile they could already read through RLS (criterion 9). It can't be used to look up arbitrary users or to learn who else someone splits with.
- *From `add_participant` errors:* a host calling it with a random or guessed id gets `not_linked` whether the id exists or not (criterion 13). Ids are random UUIDs that only show up on shared bills anyway.
- *By being added:* the added person sees the bill (items, amounts, everyone's names and Venmo usernames, Activity), and the people on the bill see the added person's name and Venmo username. That is exactly what sharing the link would have given. The host already has that choice.
- *Through someone else's bill:* being added to Hana's bill does **not** put you in the list of the other people on that bill until you claim something (L1, P4). They can't add you to their bills because Hana added you to hers.
- *A stranger with a leaked link* who joins a bill becomes linked with its host and its active participants, and can then add them to the stranger's own bills. Defences in this slice: the host can remove a stranger who hasn't claimed anything (L3), and anyone added to an unwanted bill can leave it. A real block ("don't let this person add me") is deferred and goes in `docs/before-production.md` §6 (Task 11).
- *Contacts:* the picked contact's name and numbers live only in the component's state while the person chooses how to send. They are cleared on send, cancel, unmount and sign-out. They are never stored, logged, sent to Supabase or put in the message. The number goes to Messages or WhatsApp only because the person chose to text it.

**Removal.**
- Someone added by mistake (wrong "Alex") is removed by the host with one tap on "Remove" in "On this bill", as long as they haven't claimed anything or marked paid (L3). There's no confirm, because nothing is lost: the host can add them again (PI-4).
- Anyone except the host can **leave** a bill they were added to (or joined), under the same L3 conditions. "Leave this bill" shows on the bill screen only when L3 allows it, with an inline confirm. After leaving, the bill disappears from "Your bills", and the person can't read it any more (RLS). They can rejoin with the link, and a host they're linked with can add them again (PI-5).
- Someone who has claimed items can unclaim them first and then leave. The app shows no "Leave" button while they hold claims, so it never silently changes anyone's share.

**Notification.** None. There are no push notifications. The added person finds the bill in "Your bills" the next time Home loads (it refetches on focus). The host can still send the link or use "From contacts" to tell them. Activity on the bill records "Hana added Sam" (PI-6).

### D5. How settling treats an added person who never claims
Nothing in M3 changes.
- An added participant with no claims has items subtotal 0. In proportional mode their share of tax, tip and fees is 0. In even mode extras are split only among people who claimed something (ADR 0014). Either way `lib/settle.ts` gives them role `'nothing'`. They are never asked to pay, and they don't block anyone else.
- Settling is blocked only by **unclaimed items** (M3 Q1, rule C1). If the added person ate something but never opens the app, their items stay unclaimed and "Settle up" stays blocked ("N items left to claim") until someone else claims them (Q1: no host tool). The "On this bill" list on the Add people screen shows "No items yet" next to such a person, so the host can see who hasn't claimed.
- The host can make an added person the payer (M3 D1 already allows any participant). L3 then keeps them from being removed or leaving until the host changes the payer back.

Boundary cases, tested in `lib/settle.test.ts` (Task 3) with the M3 worked example plus an added Cy who claims nothing:
- **SP1**, proportional, everything claimed by Hana and Sam: Cy gets role `'nothing'` with `owedCents 0`. Sam still owes 1510 to Hana, and the invariant `Σ owed + payer share = total` holds.
- **SP2**, even mode, same bill: Cy `'nothing'`; Sam owes 1550 (extras split between the 2 claimers only).
- **SP3**, the Salad row unclaimed: status `'blocked'` with `unclaimedRows 1`, whatever Cy does.

### D6. Screens (content; the product-engineer's design pass decides layout)

**Profile** (`app/(app)/profile.tsx`): a card "People you've split with" between the Venmo card and Sign out (it replaces the "BILL HISTORY" comment's position, which stays as a comment below it).
- Loading: a spinner labelled "Loading people". Error: "Couldn't load people." + "Try again". Empty: "People you split bills with will show up here."
- A search field ("Search people") only when the list has **more than 5** people (**starting value**, PI-9).
- Rows are display only, not buttons: initials, name (or "A friend"), and a caption: "1 bill · Nov 20" or "4 bills · last Nov 20". When two people in the list have the same cleaned name (case-insensitive), each of their captions adds " · @handle" if they have a Venmo username (PI-10).
- No results: `No one matches "<query>".`
- Screen-reader label per row: "Sam Lee, 4 bills together, last on Nov 20" (plus ", Venmo @sam-lee" when the handle is shown).

**Bill screen** (`app/(app)/bills/[id]/index.tsx`, `components/SharePanel.tsx`):
- Host: an **"Add people"** button (secondary) at the top of the "Invite friends" card, hint "Add someone you've split a bill with". It opens `/bills/[id]/people`. Guests don't see it.
- Everyone, iOS and Android only: **"From contacts"** next to "Copy link" and "Share…", hint "Pick a contact and text them the link" (see the contacts flow below). Never on web.
- Guests, only when `canLeave` (L3) is true: a quiet ghost **"Leave this bill"** at the end of the scroll content. The tap shows an inline confirm: "Leave this bill? You'll stop seeing it. You can rejoin with the link." with "Leave" (danger) and "Cancel". Success goes `router.replace('/')`. `cannot_leave` shows `BILL_ERROR_COPY.cannot_leave` and refetches.

**Add people** (new route `app/(app)/bills/[id]/people.tsx`, host only):
- Top bar: "‹ Back". Header "Add people".
- Search field when there are more than 5 people who can still be added (same rule as Profile).
- **People you've split with, not on this bill yet** (`addablePeople`, L2 order): the same row as Profile plus an "Add" button (label "Add Sam Lee"). The tap disables that button with a spinner and calls `addParticipant`. On success the screen refetches, the person moves to "On this bill", and an announcement says "Sam Lee added". `not_linked` shows `BILL_ERROR_COPY.not_linked` and reloads the list. There's no confirm (PI-3).
- **On this bill** (from `useBill`, live): "You" first, then by `joined_at`. Each row shows the name and "No items yet" when that person has no claims. For rows where `canRemove` (L3) is true, a ghost "Remove" (label "Remove Sam Lee from this bill"). `cannot_remove` shows its copy and refetches.
- Empty states: no people at all: "People you split bills with will show up here. To invite someone new, go back and share the link." Everyone already on the bill: "Everyone you've split with is on this bill."
- A non-host who opens the URL sees "Only <host> can add people." and "Back to the bill". A bill they can't read shows `BILL_ERROR_COPY.not_found`.

**Contacts flow** (inside the Invite card; no modal, single-flight):
1. "From contacts" → the system contact picker. While it's open, more taps do nothing. Cancel → back to idle, nothing shown.
2. A contact with no phone number → "That contact has no phone number." (polite live region), back to idle.
3. More than one number (after `phoneChoices`) → a short inline list "Text which number?" with each number and its label.
4. "Send with:" **Messages** (only when `SMS.isAvailableAsync()` is true) and **WhatsApp**, plus "Cancel".
5. Messages opens the composer with the number and the L5 text filled in. WhatsApp opens the L5 link with `Linking.openURL`. Either way, or on cancel, the flow returns to idle and the contact data is dropped.
6. The picker or the composer throws → "Couldn't open your contacts. Use Share… instead." If the installed picker needs a permission and it's denied (Task 8 finds out) → "SplitIt can't open your contacts. You can allow it in Settings." Both go back to idle.

**Web:** no "From contacts" (the module isn't in the web bundle). Profile's list, Add people, Remove and Leave work the same on web.

### D7. Data layer (Task 4)
- `lib/people.ts`: `listPeople(): Promise<{ ok: true; people: Person[] } | { ok: false; error: 'not_allowed' | 'network' }>`, using `supabase.rpc('people_i_split_with')`. `Person = { userId, displayName: string | null, venmoUsername: string | null, sharedBills: number, lastSharedAt: string }`. Every field is validated: UUID, `Number.isInteger(sharedBills) && sharedBills >= 1`, a parseable timestamp, `VENMO_USERNAME_PATTERN` or null. Anything malformed is `'network'`. The order is kept.
- `lib/bills.ts`: `addParticipant(billId, userId)`, `removeParticipant(billId, userId)`, `leaveBill(billId)`. The `DbFunction` union and both error maps gain these functions. `BillError` gains `not_linked`, `cannot_remove`, `cannot_leave`, mapped from `22023` by exact message (`not_linked`, `cannot_remove`, `cannot_leave`); any other text is `'network'`. A non-UUID id fails locally (`not_found` for the bill, `invalid_bill` for the user) with no network call.
- `BILL_ERROR_COPY` additions (they must not contain "payer", per `lib/bills.test.ts:603`):
  - `not_linked`: "You can only add people you've split a bill with."
  - `cannot_remove`: "Couldn't remove them. They may have just claimed an item."
  - `cannot_leave`: "You can't leave right now. Unclaim your items first."
- `fetchBill` is unchanged (it doesn't need `added`).

## Tasks
Order: **1 → 2** (DB) ‖ **3** (pure lib) ‖ **8** (native packages) ‖ **9** (pure contact helpers) → **4** (data layer, against D3/D7) → **5** (live reconciliation, after 2 and 4) → **6** (Profile) ‖ **7** (Add people + bill entry) → **10** (contacts UI, after 8 and 9; touches `SharePanel.tsx` after 7 has landed) → **11** (docs, after everything it describes has landed).

Before any task that needs the local DB, the main session runs `npm run db:status` and asks the user to start Docker if it's down (lessons log). No `db:reset` without asking; use `npx supabase migration up`.

### Task 1: `added`, rule L1, `people_i_split_with`, `add_participant`, event kinds (agent: supabase-engineer)
- New migration (timestamp from the main session): `supabase/migrations/<ts>_people.sql`. D1 column; the L1 helper; `people_i_split_with()`; `add_participant`; `bill_events_kind_known` with `participant_added`, `participant_removed`, `left` (all three now, so Task 2 needs no constraint change); restated grants. The header lists which columns clients can't read (none on `bill_participants`) and the L2 limit.
- New test: `supabase/tests/database/people.test.sql` (P1–P9, R1–R5, criteria 1–14). Assertions filter to the fixture rows (lessons log: never whole-table counts).

### Task 2: `remove_participant`, `leave_bill`, delete broadcast (agent: supabase-engineer)
- New migration `supabase/migrations/<ts>_membership.sql`: both functions (L3, D3), `bill_participants_broadcast_delete`. The header names the lock that gives D3's "a claim at the same moment is never silently deleted".
- New test: `supabase/tests/database/membership.test.sql` (M1–M8, criteria 15–22).

### Task 3: pure people and membership logic (agent: implementer)
- New `lib/people.ts` (pure parts only: `Person` type, `matchesQuery` (L4), `filterPeople(people, query)`, `addablePeople(people, participantIds)`, `personCaption(person, all, formatDate)` (D6, PI-10), `personA11yLabel`), and `lib/people.test.ts`.
- New `lib/membership.ts`: `canRemove(data: BillData, viewerId, targetId)` (true only when the viewer is the host and L3 holds) and `canLeave(data: BillData, viewerId)` (L3 for the viewer), plus `lib/membership.test.ts` (M1–M8).
- `lib/settle.test.ts`: add SP1–SP3 (tests only; `lib/settle.ts` doesn't change).

### Task 4: data layer and Activity sentences (agent: implementer)
- `lib/people.ts`: `listPeople` (D7). `lib/people.test.ts`: its tests with a fake rpc.
- `lib/bills.ts`: the three wrappers and error codes (D7). `lib/bills.test.ts`: wrapper tests. **The test at `lib/bills.test.ts:584-594` that lists every `BillError` gets the 3 new codes** (it asserts the exact key set, so it fails otherwise).
- `lib/activityText.ts` + `lib/activityText.test.ts`: the three sentences (D3 table).

### Task 5: live reconciliation (agent: implementer, using the `live-db-smoke` skill)
- Script in the scratchpad or `scripts/` as the skill says; throwaway local users A, B, C; keys loaded with `set -a; eval "$(npx supabase status -o env)"; set +a` in the same command. It runs `listPeople`, `addParticipant`, `removeParticipant`, `leaveBill` and `listMyBills` from `lib/` against the live DB and checks criteria 34–37.

### Task 6: People card on Profile (agent: product-engineer, loading `ui-ux-designer`)
- New `components/PeopleList.tsx` (search field, rows, an optional per-row action slot, empty and no-results states), used by Tasks 6 and 7.
- `app/(app)/profile.tsx`: the card (D6).
- New `__tests__/people.test.tsx` (Profile parts).

### Task 7: Add people screen, "Add people" and "Leave this bill" on the bill (agent: product-engineer, loading `ui-ux-designer`)
- New route `app/(app)/bills/[id]/people.tsx` (D6).
- `components/SharePanel.tsx`: an `onAddPeople?: () => void` prop; the button shows when it's set (host only).
- `app/(app)/bills/[id]/index.tsx`: pass `onAddPeople` for the host; "Leave this bill" plus the inline confirm for guests when `canLeave`.
- New `__tests__/addPeople.test.tsx`; additions to `__tests__/billScreen.test.tsx`.
- May land as two commits (screen, then bill-screen entry) to stay under ~300 lines each.

### Task 8: native packages and the picker wrapper (agent: native-mobile)
- `npx expo install expo-contacts expo-sms` (SDK-matched `~57.x`; confirm `package.json` shows the SDK ranges).
- `app.json`:
  - the `expo-contacts` plugin with `contactsPermission`: "SplitIt opens your contacts only when you pick someone to text a bill link to. Your contacts stay on your phone." (option name from the SDK 57 docs, https://docs.expo.dev/versions/v57.0.0/sdk/contacts/; *verify against the installed plugin*).
  - `android.blockedPermissions` including `android.permission.WRITE_CONTACTS`. The SDK 57 docs say the library adds both `READ_CONTACTS` and `WRITE_CONTACTS`, and we never write. *Verify the key name against the installed Expo config schema.*
- **Read the installed sources first** (`node_modules/expo-contacts/ios/**`, `android/**`, `build/**`) and record in the task report, with file:line:
  - (a) whether `Contact.presentPicker()` (the SDK 57 non-deprecated picker; `presentContactPickerAsync` is deprecated and throws unless imported from `expo-contacts/legacy`) asks for contacts permission on iOS and on Android;
  - (b) the shape of the phone fields it returns (`number`, `digits`, `label`, `countryCode` per the docs' PhoneNumber table; *verify*);
  - (c) whether `READ_CONTACTS` can be blocked too. If the picker works without it, block it and request nothing.
  - If (a) says a permission is needed, request it only at the moment "From contacts" is tapped, never at launch, and record it as an amendment.
- New `lib/contactPicker.native.ts`: `pickContactPhones(): Promise<{ status: 'picked'; phones: { number: string; label: string | null }[] } | { status: 'cancelled' } | { status: 'denied' } | { status: 'error' }>`, `smsAvailable(): Promise<boolean>`, `sendSms(number, message): Promise<'done' | 'error'>`. It never throws. It returns only phone numbers and labels: no names, ids or other fields leave this module.
- New `lib/contactPicker.ts` (web and default): `pickContactPhones` resolves `{ status: 'error' }`, `smsAvailable` resolves `false`, and `contactsSupported = false` (`true` in the native file). It has no import of `expo-contacts` or `expo-sms`.
- Tests: `lib/contactPicker.native.test.ts` with the module mocked (picked, cancelled, no phones, thrown error, denied).
- Rebuild the dev build for the simulator (`npx expo run:ios`) and do criterion 50.

### Task 9: pure contact-invite helpers (agent: implementer)
- New `lib/contactInvite.ts`: `INVITE_MESSAGE_PREFIX`, `inviteMessage(url)`, `whatsAppUrl(number, message)` (W1–W5), `phoneChoices(phones)` (L5). `lib/contactInvite.test.ts`.
- `components/SharePanel.tsx`: replace the local `SHARE_MESSAGE_PREFIX` with an import of `INVITE_MESSAGE_PREFIX` (one-line change; `__tests__/shareAndJoin.test.tsx:125` must pass unchanged).

### Task 10: "From contacts" in the Invite card (agent: product-engineer, loading `ui-ux-designer`)
- New `components/ContactInvite.tsx` (the D6 contacts flow), rendered by `components/SharePanel.tsx` only when `contactsSupported` is true.
- New `__tests__/contactInvite.test.tsx`, with `lib/contactPicker` mocked, run with `Platform.OS` set to `'ios'` and to `'web'` (lessons log: a test per platform branch).

### Task 11: docs (agent: docs-writer; after Tasks 1–10 land)
- New concept note `docs/learning/concepts/people-and-membership.md`: rule L1 and why being added doesn't count, a derived relationship vs a friends table, L3, and why contacts stay on the device. Link it from `docs/learning/README.md`. If the main session assigns an ADR number, ADR "People come from shared bills; add only linked people" (F-1, PI-1).
- `docs/before-production.md`: the items listed under "Before-production items" below.
- `docs/decisions-to-review.md`: mark each PI decision the build changed, with the amendment.

## Acceptance criteria

### Database: Task 1 (`supabase/tests/database/people.test.sql`)
1. `bill_participants.added` exists, is `boolean not null default false`, and every row that existed before the migration is `false`. A host row from `create_bill` and a row from `join_bill` are `false`.
2. `authenticated` has SELECT on `bill_participants` and no INSERT, UPDATE or DELETE. A direct `insert into public.bill_participants (bill_id, user_id) ...` and `update public.bill_participants set added = false ...` as `authenticated` fail with `42501`. `anon` has no privileges on it.
3. `anon` calling `people_i_split_with()`, `add_participant(...)`, `remove_participant(...)` or `leave_bill(...)` fails with `42501` (permission denied for the function). `public` has no EXECUTE on any of them, and neither does `anon`.
4. P1–P9 hold exactly as in L1 (one assertion per row of the table).
5. R1–R5 hold exactly as in L2 (the function's row order).
6. The function returns at most the L2 limit of rows: with limit + 1 linked fixture users, it returns exactly `limit` rows, and the one dropped is the lowest-ranked.
7. Every row's `shared_bills ≥ 1`, and `last_shared_at` equals the latest `created_at` of the bills counted (checked on P3).
8. A signed-out call (`auth.uid()` null, role `authenticated`) to `people_i_split_with()` fails with `42501 not_allowed`.
9. Privacy: for each fixture user U, every `user_id` that `people_i_split_with()` returns as U is also returned by `select id from public.profiles` as U (`profiles` RLS), and U's own id is never returned.
10. `add_participant` by the host for a linked user who isn't on the bill: inserts exactly one row with `added = true` and logs exactly one `participant_added` event with `actor_id` = host and `details = {"user_id": "<id>"}`.
11. `add_participant` for someone already on the bill (added or joined): no new row, no event, no error. Calling it twice in a row for a new person gives one row and one event.
12. `add_participant` by a non-host participant, by a non-participant, for a bill id that doesn't exist, or while signed out: `42501 not_allowed`, nothing inserted, no event.
13. `add_participant` for an unlinked real user, for a random UUID that isn't a user, and for the host's own id (already a participant, so no-op): the first two raise `22023` with message `not_linked`, the same SQLSTATE and message for both; the third is a no-op. Nothing is inserted or logged in any case.
14. The `bill_events_kind_known` constraint accepts `participant_added`, `participant_removed` and `left` plus every existing kind; `'paid'` is still rejected (`23514`). `supabase/tests/database/settle_payer.test.sql` criterion 12 still passes unchanged.

### Database: Task 2 (`supabase/tests/database/membership.test.sql`)
15. M1–M8 hold exactly as in L3, for both `remove_participant` (as the host) and `leave_bill` (as the target).
16. A successful remove deletes exactly that participant row and logs exactly one `participant_removed` (`actor_id` = host, `details = {"user_id": "<id>"}`). A successful leave deletes the caller's row and logs exactly one `left` (`actor_id` = caller, `details = {}`). Neither logs `unclaimed` or `payer_changed`.
17. `remove_participant` by a non-host participant, by a non-participant, for a missing bill, or signed out: `42501 not_allowed`, nothing changes. `leave_bill` by a non-participant or signed out: `42501 not_allowed`.
18. A refused remove or leave (`cannot_remove` / `cannot_leave`) changes nothing: the row, the target's claims, every mark and `bills.payer_id` are as before, and no event is logged.
19. After B leaves bill X, B (as `authenticated`) selects 0 rows from `bills`, `line_items`, `bill_participants`, `claims` and `bill_events` for X; `join_bill(<X's code>)` puts B back in (one `joined` event).
20. A `delete` on `bill_participants` sends one broadcast per bill per statement on `bill:<id>` (assert the trigger exists, is `after delete ... for each statement`, and runs `private.broadcast_bill_change`). The existing insert and update broadcast triggers are still there.
21. The migration header names the lock that keeps a simultaneous claim from being silently cascaded away (D3). The reviewer confirms it against Postgres's row-lock conflict table. pgTAP can't run two sessions, so this is a review check, not a test.
22. `npm run db:test` passes in full: every existing pgTAP file plus the two new ones.

### Pure lib: Task 3
23. `lib/people.test.ts`: `matchesQuery` gives S1–S10 exactly. A 60-character query is matched using its first 50 characters.
24. `filterPeople` keeps the input (L2) order for any query: a list ordered [Sam, Ali, Sasha] filtered by `sa` gives [Sam, Sasha]. `addablePeople` drops exactly the ids in `participantIds` and keeps the order.
25. `personCaption`: `sharedBills 1` → "1 bill · Nov 20"; `4` → "4 bills · last Nov 20" (date through the injected formatter). When two people's cleaned names are equal ignoring case ("alex kim", "Alex Kim"), each caption ends " · @<handle>" when that person has a handle and has no suffix when not. A unique name never gets the suffix. `personA11yLabel` includes the name, "N bill(s) together", the date and, when shown, "Venmo @handle".
26. `lib/membership.test.ts`: `canRemove` and `canLeave` give M1–M8 exactly. `canRemove` is `false` for every target when the viewer isn't the host.
27. `lib/settle.test.ts`: SP1–SP3 pass, including the `Σ owed + payer share = total` invariant on SP1 and SP2.

### Data layer: Task 4
28. `listPeople` calls `rpc('people_i_split_with')` with no arguments and returns the rows in order. A row with a non-UUID id, `shared_bills` of `0`, `1.5` or `"2"`, a bad timestamp, or a handle failing `VENMO_USERNAME_PATTERN` makes the whole result `{ ok: false, error: 'network' }`. `42501` → `not_allowed`; a thrown error → `network`.
29. `addParticipant`, `removeParticipant`, `leaveBill` call `add_participant` / `remove_participant` / `leave_bill` with exactly `{ p_bill_id, p_user_id }` / `{ p_bill_id, p_user_id }` / `{ p_bill_id }`. A non-UUID bill id → `not_found`, a non-UUID user id → `invalid_bill`, with no rpc call in both cases.
30. Error mapping: `22023` + `not_linked` → `not_linked`; `22023` + `cannot_remove` → `cannot_remove`; `22023` + `cannot_leave` → `cannot_leave`; `22023` + any other message → `network`; `42501` → `not_allowed`. Server text never appears in a result.
31. `BILL_ERROR_COPY` has the three new entries with the D7 text. `lib/bills.test.ts:584-594` lists all 12 codes and passes. No copy contains "payer".
32. `lib/activityText.test.ts`: `participant_added` from Hana about Sam → "Hana added Sam"; about the viewer → "Hana added you"; by the viewer → "You added Sam"; about someone not on the bill → "Hana added someone". `participant_removed` → "Hana removed Sam" / "Hana removed someone". `left` by Sam → "Sam left"; by an ex-participant → "Someone left". Missing or non-UUID `user_id` → `null`.
33. `grep -rnE "\.select\(\)|select\('\*'\)" lib app components` prints nothing. (Run with the Grep tool on 2026-11-24 over the same paths: no matches today.)

### Live reconciliation: Task 5 (live local DB, throwaway users)
34. A and B share bill Y (B joined with the link). As A, `listPeople()` returns B with `sharedBills 1`; as B it returns A.
35. A creates X and calls `addParticipant(X, B)`. As B, `listMyBills()` includes X without B ever calling `joinBill`, and `fetchBill(X)` returns `ok`. As C, who joined X with the link, `listPeople()` doesn't include B until B claims a row on X, and then does.
36. As A, `removeParticipant(X, B)` while B holds a claim returns `cannot_remove`. After B unclaims, it returns `ok`, and B's `fetchBill(X)` returns `not_found`.
37. As B (added again to X, no claims), `leaveBill(X)` returns `ok`. As A (host), `leaveBill(X)` returns `cannot_leave`. Every call's result matches the D3 table (no `network` results).

### Profile: Task 6 (`__tests__/people.test.tsx`)
38. With 3 people from a mocked `listPeople`, Profile shows the card "People you've split with" between the Venmo card and "Sign out", rows in the given order, each with its caption, and no search field. With 6 people the search field ("Search people") shows. Typing `sa` leaves only the matching rows in the same order; a query with no match shows `No one matches "zzz".`
39. Loading shows "Loading people". An error shows "Couldn't load people." with "Try again", which calls `listPeople` again and then shows the list. An empty list shows "People you split bills with will show up here."
40. Profile rows are display only: no row element has `accessibilityRole` `button` or `link`, and no row has an `onPress`.
41. Each row's accessibility label is `personA11yLabel`'s output. A late `listPeople` response after leaving the screen sets no state (no `act()` warnings in the run).

### Add people and bill entry: Task 7 (`__tests__/addPeople.test.tsx`, `__tests__/billScreen.test.tsx`)
42. On the bill screen the host sees "Add people" in the Invite card, and it navigates to `/bills/<id>/people`. A guest doesn't see it.
43. The Add people screen lists `addablePeople` (people already on the bill aren't in it) in order, with "Add" buttons labelled "Add <name>". Tapping one calls `addParticipant(billId, userId)` once (a double tap calls it once), disables that button while it runs, then refetches the bill. The person then shows under "On this bill" and not in the addable list, and "<name> added" is announced.
44. `not_linked` shows "You can only add people you've split a bill with." and reloads `listPeople`. `network` shows "Something went wrong. Check your connection and try again." and the button is enabled again.
45. "On this bill" shows "You" first, then the others by join order, with "No items yet" for anyone without claims. "Remove" shows exactly on rows where `canRemove` is true (checked on fixtures for M2, M3 and M5). Tapping it calls `removeParticipant` once and refetches. `cannot_remove` shows its copy and refetches.
46. Empty states: no people at all shows the D6 "show up here" copy; everyone already on the bill shows "Everyone you've split with is on this bill."
47. A guest opening `/bills/<id>/people` sees "Only <host name> can add people." and "Back to the bill", with no "Add" or "Remove" buttons and no `listPeople` call.
48. A guest with no claims, no mark and not the payer sees "Leave this bill". A guest with a claim, the payer, and the host don't. Tapping it shows the inline confirm. "Leave" calls `leaveBill` once and then `router.replace('/')`. "Cancel" hides the confirm with no call. `cannot_leave` shows "You can't leave right now. Unclaim your items first." and refetches.
49. Every new button has an `accessibilityLabel`, and a hint where the result isn't obvious ("Add people", "Remove", "Leave this bill").

### Native packages: Task 8
50. `package.json` lists `expo-contacts` and `expo-sms` at the SDK 57 ranges `npx expo install` chose. `npx expo-doctor` reports no new problems. **Simulator (an agent can build it; a person taps):** see U4.
51. The Task 8 report answers (a), (b) and (c) with file:line citations from `node_modules/expo-contacts`. `app.json` sets `contactsPermission` to the Task 8 text and blocks `WRITE_CONTACTS`, plus `READ_CONTACTS` if (c) allows. After `npx expo prebuild --clean` in a throwaway copy or the gitignored `ios/`/`android/` folders, the generated `Info.plist` contains that `NSContactsUsageDescription`, and the merged Android manifest has no `WRITE_CONTACTS` (*verify how the installed prebuild reports the merged manifest; reword if the tool differs*).
52. `lib/contactPicker.native.test.ts`: a picked contact with two numbers returns `{ status: 'picked', phones: [...] }` with only `number` and `label` per phone (no name or id keys). A cancel returns `cancelled`, a thrown picker error returns `error`, a denied permission returns `denied`. `sendSms` passes `[number]` and the message to `SMS.sendSMSAsync` unchanged, and returns `error` when it throws.
53. `grep -rnE "from 'expo-(contacts|sms)'" app lib components` matches only `lib/contactPicker.native.ts`. (Run with the Grep tool on 2026-11-24 for `expo-contacts|expo-sms` over `app`, `lib`, `components`, `__tests__`, `test-utils`: no matches today. Test files that mock the modules use `jest.mock('expo-contacts'` and aren't matched by this pattern.)
54. No web JS bundle contains the `expo-contacts` or `expo-sms` module: after `npm run export:web`, no file under `dist/_expo/static/js/web/` contains the string `presentPicker` or `sendSMSAsync` (*verify these strings appear in the native bundle from `npx expo export -p ios` first, so the check can find something; reword if the tool differs*).

### Contact helpers: Task 9
55. `lib/contactInvite.test.ts`: `inviteMessage('splitit://b/abc')` is `'Claim what you had on SplitIt: splitit://b/abc'`. `whatsAppUrl` gives W1–W5 exactly, with `text=` being `encodeURIComponent` of the message. `phoneChoices` drops a digit-less entry, de-duplicates `+1 415 555 0100` and `+14155550100` to the first one, and keeps the order and labels.
56. `components/SharePanel.tsx` has no local message-prefix string. `grep -rn "'Claim what you had on SplitIt: '" app components lib` matches only `lib/contactInvite.ts`. (Run with the Grep tool on 2026-11-24 for `Claim what you had` over `app`, `lib`, `components`, `__tests__`: today it matches `components/SharePanel.tsx:14` and the test `__tests__/shareAndJoin.test.tsx:125`, which uses a template literal and isn't matched by the quoted pattern.) `__tests__/shareAndJoin.test.tsx` passes unchanged.

### Contacts UI: Task 10 (`__tests__/contactInvite.test.tsx`)
57. With `Platform.OS = 'web'` (and `contactsSupported` false) the Invite card has no "From contacts". With `'ios'` it does, with the hint "Pick a contact and text them the link", for the host and for guests.
58. Picked, one number, SMS available: "Send with:" shows "Messages", "WhatsApp" and "Cancel". "Messages" calls `sendSms(<number>, inviteMessage(url))` once. "WhatsApp" calls `Linking.openURL(whatsAppUrl(<number>, inviteMessage(url)))` once. Afterwards the card is back to idle and no number is on screen.
59. SMS unavailable: only "WhatsApp" and "Cancel". Two numbers: "Text which number?" lists both (with labels), and choosing one goes to "Send with:".
60. No phone number: "That contact has no phone number." Cancelled picker: nothing new on screen. `error`: "Couldn't open your contacts. Use Share… instead." `denied`: "SplitIt can't open your contacts. You can allow it in Settings." Each returns to idle with "From contacts" enabled.
61. A second tap on "From contacts" while the picker is open doesn't call `pickContactPhones` again. Unmounting the card mid-flow (for example on sign-out) leaves no pending state updates (no `act()` warnings), and remounting starts idle.
62. Privacy: no function in `lib/contactInvite.ts`, `lib/contactPicker*.ts` or `components/ContactInvite.tsx` takes or returns a contact name. `grep -rnE "supabase|AsyncStorage|SecureStore|console\.(log|info|warn)" lib/contactInvite.ts lib/contactPicker.ts lib/contactPicker.native.ts components/ContactInvite.tsx` prints nothing. (Not run: the files don't exist yet; the implementer runs it on a file with a known match first.)

### Whole slice
63. `npm test -- --maxWorkers=4` and `npm run typecheck` pass. A failure only in files this slice didn't touch is reported as outside the task (lessons log).
64. `npm run export:web` succeeds, and `grep -rE "service_role|sb_secret_" dist/` prints nothing except the documented Tesseract CDN match (CLAUDE.md).
65. Docs (Task 11): the concept note exists and is linked from `docs/learning/README.md`; `docs/before-production.md` has every item from the list below; each PI decision in `docs/decisions-to-review.md` is still accurate or marked changed.

### User checks (need a person; QA lists them "for the user")
- **U1. Add on web (two Google accounts, local Supabase).** Do this after QA has verified criteria 34–37 live with throwaway users.
  1. As A: create a bill and share its link; B joins in a second browser profile.
  2. As A: create a second bill, then Add people → "Add" next to B.
  3. As B: go to Home (or refresh). The second bill is in "Your bills". Open it and claim an item.
  4. As A: Activity shows "You added <B>".
  5. Record whether finding the bill without any notice felt OK.
- **U2. Not linked through someone else's bill (three accounts).** C joins A's second bill with the link before B claims anything. As C: Profile doesn't list B. After B claims, reload Profile: B is listed.
- **U3. Leave and remove on web.** As B on a bill where B has claimed nothing: "Leave this bill" → "Leave" → home, and the bill is gone. As A: add B again, then "Remove" on B. Activity shows "You removed someone".
- **U4. iOS simulator (it reaches the Mac's `127.0.0.1:54321`).** Rebuild with `npx expo run:ios`.
  1. Open a bill → "From contacts". The system picker shows the simulator's sample contacts.
  2. Pick one with two numbers. "Text which number?" appears.
  3. Pick a number. "Messages" is absent (the simulator has no SMS; `expo-sms` docs).
  4. "WhatsApp" opens Safari at `wa.me`.
  5. Record whether any permission prompt appeared and its wording.
- **U5. Physical iPhone: blocked.** The bill screen needs Supabase, and on the phone `127.0.0.1` is the phone itself. Unblock it either with the friend-test deploy (hosted Supabase, `docs/before-production.md` §5) or with the Mac's LAN IP as `EXPO_PUBLIC_SUPABASE_URL` plus matching Supabase/Google redirect URLs. Once unblocked:
  - "From contacts" → a contact → "Messages" opens the composer with the number and "Claim what you had on SplitIt: splitit://b/…" filled in. Don't send it.
  - "WhatsApp" opens WhatsApp in the chat (a `+` number) or at the chat picker (a local number), with the text filled in.
  - Record whether Messages makes the `splitit://` link tappable (Risk 1).
- **U6. VoiceOver** on the Add people screen: each row reads its name, bill count and date; "Add Sam Lee" is announced as a button; "Sam Lee added" is announced after adding.

## Device checks: how the device reaches the backend
- Web and the iOS simulator use the Mac's `http://127.0.0.1:54321` directly.
- A physical phone can't, so U5 is blocked until one of the two routes in U5 exists. Nothing in this slice sets either up.

## Before-production items (Task 11 adds them to `docs/before-production.md`)
- §6 Privacy: "People you've split with" shows the names (and, for same-name people, the Venmo usernames) of people linked by rule L1. Add it to the privacy policy and store forms ("people you've split bills with, from shared bills").
- §6 Privacy / abuse: there's no block. A linked host can keep adding someone to bills; the only defence is leaving each one. Decide before public links whether to add "Don't let <name> add me" (a per-user block list checked in `add_participant`).
- §6 Privacy: the App Store purpose string for contacts (`NSContactsUsageDescription`) must match what the app does. Re-check it, and the Play data-safety form ("contacts: not collected"), before submission.
- §4 Abuse: `add_participant` has no rate limit or participants-per-bill cap (extends the existing abuse item).
- §5 Deep links: texted invites carry `inviteUrl()`, which is `splitit://b/<code>` on native today. A friend without the app can't open it, and SMS apps may not make it tappable *(unverified)*. Invite from contacts is only useful to real friends once invite links are https (friend-test deploy or domain).
- §4: push the two new migrations to the hosted project and run the new pgTAP files there.
- §4: the people list is capped at 200 (starting value); search covers only those. Revisit if anyone gets near it.

## Risks
1. **Texted links don't open on a friend's phone yet.** This is the dependency to watch, not a question. The feature is built correctly against `inviteUrl()`. It becomes useful to real friends the moment the friend-test deploy makes the link https. Recommended: run the friend-test deploy slice next.
2. **Silent adds can go unnoticed** without notifications. The added person sees the bill only when they next open Home, and Settle up stays blocked if their items stay unclaimed (D5). The "No items yet" caption helps the host chase them in person.
3. **The `expo-contacts` picker's permission behaviour is unverified** (Task 8 a–c). If it needs `READ_CONTACTS` on Android, the app asks for it at the moment of the tap. That's a bigger ask than "pick one contact", and the Play data-safety form must then say contacts are accessed (not collected).
4. **Concurrency in remove and leave** (D3, criterion 21) can only be reviewed, not tested in pgTAP.
5. **Activity reads "someone"** for people who left or were removed (PI-17). If the user wants names kept, events would need a name snapshot, which reverses the "ids only" rule of the audit log. That is a privacy decision.
6. **Ranking uses current rows**, so a person's position can drop when they unclaim or leave (P6). That's intended and documented.

## Truly blocking questions
None. Nothing here needs a backend service (it's the app plus Supabase only, ADR 0010), money, or a hard-to-reverse step. Every new table field, function and event kind can be changed or dropped later with a migration. Adding `expo-contacts` means rebuilding the dev build, which is routine.
